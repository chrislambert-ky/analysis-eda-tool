# EDA Tool — Development Roadmap

This document maps out the full evolution of the app from its current state through a DuckDB-first progressive web app and, eventually, an Electron desktop application. Pick up any phase independently; each builds on the previous but the app remains fully functional between phases.

---

## Current State (Baseline)

- Single `index.html`, no build step, deployed to GitHub Pages
- **Two separate engines** in one file:
  - IIFE script: fetches partition CSVs → JS parse → materializes all rows into `state.allRows` → JS aggregation (`prepareSeries`) → ECharts
  - ES module: DuckDB-WASM, only active when the SQL tab is clicked
- IndexedDB: two separate stores (`analysis_eda_tool_db` partitions + `eda_sql_user_sources`)
- Charts, map, and table all depend on `state.allRows` being fully loaded in memory
- No offline support, no installability, no desktop packaging

---

## Phase 1 — DuckDB as the Single Query Engine

**Goal:** Replace JS-side aggregation with SQL. ECharts receives query results only, never raw rows.

### 1.1 Eager DuckDB initialization
- Move DuckDB init from "on SQL tab click" to `DOMContentLoaded`
- Show a lightweight global status indicator (e.g. top-of-page spinner) while WASM loads
- Register all managed datasets as views immediately on startup
- Remove the `window._eda*` global bridge — both the IIFE and the module share one DuckDB `conn` instance (consolidate into a single `<script type="module">`)

### 1.2 SQL-driven chart aggregation
Replace `prepareSeries()` + `sortSeries()` with a query builder:

```sql
-- Example of what a chart control selection becomes:
SELECT DISTRICT, COUNT(*) AS value
FROM eda_construction_procurement
GROUP BY DISTRICT
ORDER BY value DESC
LIMIT 50;
```

- Chart control state (dimension, metric, aggregation type, split-by, order) maps 1:1 to SQL clauses
- DuckDB returns ≤50 rows; ECharts renders them — no full dataset in memory for charts
- Split-by becomes a `PIVOT`-style query or a grouped result reshaped in JS from a narrow result set

### 1.3 SQL-driven Tabulator (paged)
- Replace full `state.allRows` table load with `SELECT * FROM t LIMIT 500 OFFSET 0`
- Tabulator uses `ajaxRequestFunc` (or a custom data loader) calling DuckDB on each page turn
- Column filters become SQL `WHERE` clauses; sort becomes `ORDER BY`
- "Download CSV" becomes `COPY (SELECT ...) TO 'result.csv'` via DuckDB's file export

### 1.4 Unify the IDB stores
- One IDB (or OPFS, see Phase 2) for all cached data — managed datasets and user-added sources
- Remove the `eda_sql_user_sources` second database
- User-imported data goes through the same DuckDB registration path as managed datasets

### 1.5 Catalog schema via DuckDB only
- `DESCRIBE <table>` is the single schema source — no raw CSV header parse, no BI-settings fallback
- Catalog always shows accurate DuckDB-native types (`BIGINT`, `DATE`, `VARCHAR`, etc.)
- Remove `fetchRawCsvSample()`, `inferColumnType()`, and `catalogSchemaCache` partial-schema logic

### 1.6 ETL simplification
- Remove partition CSV generation from `etl.js` — only write `data/raw/*.csv` and BI settings JSON
- DuckDB's `read_csv_auto()` replaces all partition loading
- `data/report/<dataset>/*.csv` partition files can be deleted from the repo once Phase 1 is validated

**Milestone:** App purely routes all data access through DuckDB. `state.allRows` only exists for the map (lat/lon per point still needs row-level data).

---

## Phase 1.7 — File Structure Refactor (Recommended alongside Phase 1)

**Goal:** Split `index.html` into focused, single-purpose files without introducing a build step. No bundler, no npm scripts — just plain `<script type="module" src="...">` references.

**Why this matters:**
- A single file growing past ~4,000 lines degrades AI-assisted editing reliability. The AI may only see part of the file in context at once and produce changes that are locally correct but break something elsewhere.
- Named, focused files give AI editors (and humans) unambiguous targets: *"fix the chart aggregation"* → `js/charts.js`, *"update the table pager"* → `js/table.js`.
- Browser caching becomes granular: a CSS tweak no longer forces a full HTML re-download.

### Proposed structure

```
analysis-eda-tool/
├── index.html              (~150 lines — HTML skeleton, <script> wiring only)
├── etl.js                  (unchanged — Node.js ETL, not loaded by browser)
├── css/
│   └── app.css             (all styles, currently inline or in <style> blocks)
├── js/
│   ├── engine.js           (DuckDB init, query runner, IDB/OPFS cache layer)
│   ├── charts.js           (ECharts rendering, chart control state, query builder)
│   ├── table.js            (Tabulator setup, paging, column filters, CSV export)
│   ├── map.js              (Leaflet init, point layer, future choropleth layer)
│   ├── catalog.js          (dataset listing, schema display, user source import)
│   └── sql-editor.js       (CodeMirror setup, SQL tab, result grid)
├── data/
│   └── ...
└── ...
```

### Migration approach (no big-bang rewrite)
1. Create each `js/*.js` file as an ES module (`export`/`import`)
2. Move one logical section at a time from `index.html` into its module — test after each move
3. Replace the moved `<script>` block in `index.html` with `<script type="module" src="js/engine.js">` (the top-level entry point that imports the others)
4. No code logic changes required during the move — only file boundaries change

### File responsibility rules (prevents "lost track" problem)
| File | Owns | Never touches |
|---|---|---|
| `engine.js` | DuckDB conn, query execution, cache | DOM, ECharts, Leaflet |
| `charts.js` | ECharts instances, chart controls | DuckDB directly (calls engine) |
| `table.js` | Tabulator instance, paging | ECharts, Leaflet |
| `map.js` | Leaflet map, layers | ECharts, Tabulator |
| `catalog.js` | Dataset management UI | Chart/map rendering |
| `sql-editor.js` | SQL tab UI, CodeMirror | Chart/map state |

**Milestone:** `index.html` is under 200 lines of HTML. All JS logic lives in named modules. No build tooling required.

---

## Phase 2 — OPFS Persistence (True Browser Database)

**Goal:** Datasets are stored locally in a real embedded database, not as disconnected IDB blobs.

### 2.1 DuckDB OPFS VFS
- Use DuckDB's Origin Private File System (OPFS) virtual filesystem
- On first load, `IMPORT DATABASE` copies managed datasets into a persistent OPFS `.duckdb` file
- Subsequent loads open the existing file — no network fetch, near-instant startup
- The OPFS file is invisible to users (private browser storage), but survives page reloads and browser restarts

### 2.2 Parquet-first data layer
- ETL writes `data/raw/<dataset>.parquet` alongside (eventually replacing) CSVs
- DuckDB registers Parquet via `read_parquet(url)` — column-level HTTP range requests mean only referenced columns are fetched
- For remote big-data sources: register directly as `read_parquet('https://...')`, no local copy needed

### 2.3 Incremental refresh
- ETL embeds a `generatedAt` timestamp into each Parquet file's metadata
- On "Refresh Cache", DuckDB compares the remote timestamp against the locally stored one
- Only re-imports if the remote file is newer — avoids re-downloading unchanged datasets

### 2.4 User dataset persistence
- Imported CSVs and Parquets are stored as OPFS tables inside the same DuckDB file
- Users can browse, rename, and delete imported datasets from the Catalog page
- Datasets survive browser restarts without requiring the SQL tab or a re-import

**Milestone:** App works entirely offline after first load. Storage is a single OPFS DuckDB file. Remote Parquet queries work against multi-GB files without full download.

---

## Phase 3 — Big Data & Advanced Features

**Goal:** Unlock genuine front-end big data analysis.

### 3.1 File System Access API (local huge files)
- "Add Source" supports the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) — user picks a local CSV or Parquet file
- DuckDB reads it in-place via a File object URL — the file never needs to be fully copied into the browser
- Multi-GB local files are queryable with zero upload

### 3.2 Cross-dataset SQL (joins in charts)
- Chart dimension/metric controls gain an optional "join" picker
- The query builder emits `JOIN` clauses across registered tables
- SQL panel already supports this; the chart UI surfaces it visually

### 3.3 Advanced visualizations
- ECharts `scatter` / `heatmap` / `candlestick` chart types added to the chart type buttons
- Time-series chart type: DuckDB `DATE_TRUNC` used for X-axis bucketing
- Geographic aggregation: districts or counties aggregated in SQL, result rendered in Leaflet as choropleth

### 3.5 Census TIGERweb choropleth maps
Integrate the [Census Bureau TIGERweb REST API](https://tigerweb.geo.census.gov) to render county and state polygon boundaries as choropleth layers in Leaflet — no GeoJSON file needs to be bundled in the repo.

**How it works:**
- Fetch county polygons on demand from the TIGERweb MapServer (returns GeoJSON directly)
- Join the `GEOID` (5-digit FIPS code) from the API response to a DuckDB aggregation query keyed on a matching FIPS column in the dataset
- Color each county polygon by the aggregated metric value (e.g. total award amount, bridge count, average condition rating)
- Leaflet renders the `L.geoJSON` layer; tooltips show the county name + metric value

**Key API parameters:**
```
where=STATE='21'          -- filter to Kentucky (FIPS 21); avoids fetching all 3,143 US counties
outFields=NAME,GEOID,STATE
outSR=4326                -- WGS84 (standard GPS coordinates)
f=geojson
geometryPrecision=4       -- reduces payload size for BI performance
```

**Reference implementation:**
```javascript
const TIGERWEB_COUNTY_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query';

async function fetchCountyPolygons(stateFips = '21') {
  const params = new URLSearchParams({
    where:             `STATE='${stateFips}'`,
    outFields:         'NAME,GEOID,STATE',
    outSR:             '4326',
    f:                 'geojson',
    geometryPrecision: 4
  });
  const resp = await fetch(`${TIGERWEB_COUNTY_URL}?${params}`);
  if (!resp.ok) throw new Error(`TIGERweb HTTP ${resp.status}`);
  return resp.json(); // GeoJSON FeatureCollection
}
```

**Performance notes:**
- All 3,000+ US counties with full geometry = ~5–10 MB; always filter by `STATE` unless a national view is required
- Cache the fetched GeoJSON in IDB (keyed by state FIPS + a date stamp) so subsequent loads skip the network call
- The Cartographic Boundary Service (`census.gov/geo/maps-data/data/tiger-cart-boundary.html`) offers pre-simplified geometries as a static alternative if API latency is a concern

**DuckDB join pattern:**
```sql
-- After fetching GeoJSON, extract FIPs codes and join to aggregated dataset:
SELECT county_fips, SUM(AWARD_AMOUNT) AS total_awards
FROM eda_construction_procurement
GROUP BY county_fips
-- GEOID from TIGERweb is matched client-side when coloring the Leaflet layer
```

**Dependencies:** None beyond Leaflet (already loaded). The TIGERweb API is public, CORS-enabled, and requires no API key.

### 3.4 Saved queries / dashboards
- SQL query snippets saved to OPFS alongside the database
- Dashboard layout: multiple ECharts panels on one screen, each driven by its own saved query
- Export dashboard as a self-contained HTML snapshot

---

## Phase 4 — Progressive Web App (PWA)

**Goal:** Installable from the browser, works offline, no browser chrome required.

### 4.1 Web App Manifest (`manifest.json`)
Minimal manifest to enable "Add to Home Screen" / "Install App" in Chrome and Edge:

```json
{
  "name": "EDA Tool",
  "short_name": "EDA",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#f5f6f8",
  "theme_color": "#0d6efd",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- Add `<link rel="manifest" href="manifest.json">` and `<meta name="theme-color">` to `index.html`
- Create `icons/` folder with 192×192 and 512×512 PNG icons
- `display: "standalone"` removes the browser address bar and tab UI — the app feels native

### 4.2 Service Worker (`sw.js`)
- Pre-cache all static assets (HTML, CSS, JS bundles, CDN scripts) at install time
- Cache-first strategy for app shell; network-first for data files
- DuckDB WASM bundle is large (~8 MB) — cache it permanently, update only on version bump
- Managed dataset Parquets cached after first fetch; stale-while-revalidate on ETL refresh

```
sw.js responsibilities:
  install  → cache app shell + DuckDB WASM bundle
  fetch    → serve app shell from cache; fetch data with network fallback
  activate → clean up old cache versions
```

### 4.3 Offline experience
- If offline: OPFS-cached datasets are fully queryable via DuckDB
- If a requested dataset was never cached: friendly "not available offline" message in Catalog
- Background sync (optional): queue a dataset refresh when the connection returns

### 4.4 Install prompt
- Listen for `beforeinstallprompt` event; show an unobtrusive "Install App" button in the header
- On install, the app opens in its own window with `display: standalone` — no browser borders

**Files to create:**
- `manifest.json` (root)
- `sw.js` (root)
- `icons/icon-192.png`
- `icons/icon-512.png`

**Note:** OPFS (Phase 2) is the critical dependency for a useful offline PWA. The app shell can be cached without OPFS, but data won't be available offline until datasets are stored there.

---

## Phase 5 — Electron Desktop App

**Goal:** A native desktop application with local filesystem access, no browser required.

### 5.1 Why Electron (and when to consider alternatives)
- **Electron** bundles Chromium + Node.js — the app runs identically to the browser version with zero code changes in the renderer (HTML/JS) layer
- Node.js access layer (`main.js`) unlocks: native file dialogs, direct filesystem reads, background jobs, system tray, auto-update
- **Alternative:** [Tauri](https://tauri.app/) — Rust + system WebView instead of Chromium. Much smaller binary (~5 MB vs ~120 MB) but requires Rust toolchain and has a smaller DuckDB-WASM compatibility surface. Evaluate at implementation time.

### 5.2 Project structure (Electron)

```
analysis-eda-tool/
├── index.html          (unchanged — rendered in Electron BrowserWindow)
├── manifest.json       (PWA manifest, ignored by Electron but harmless)
├── sw.js               (ignored by Electron — no service workers needed)
├── electron/
│   ├── main.js         (Electron main process — window, menus, IPC)
│   ├── preload.js      (secure context bridge — exposes Node APIs to renderer)
│   └── package.json    (Electron-specific deps: electron, electron-builder)
├── data/
└── ...
```

### 5.3 Main process (`electron/main.js`)
Key capabilities unlocked over the PWA:

```javascript
// Native file open dialog — no File System Access API needed
ipcMain.handle('open-file-dialog', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'Data files', extensions: ['csv', 'parquet', 'json'] }],
    properties: ['openFile', 'multiSelections']
  });
  return filePaths;
});

// Read a file directly from disk — DuckDB can then open it by absolute path
ipcMain.handle('read-file-path', (event, filePath) => filePath); // pass path to DuckDB
```

### 5.4 DuckDB in Electron
- In the renderer (HTML page), DuckDB-WASM works exactly as in the browser — no changes needed
- Alternatively, use the Node.js DuckDB binding (`@duckdb/node-bindings`) in the main process for even faster queries, with results sent to the renderer via IPC
- OPFS is not available in Electron's renderer, but Node.js `fs` fills the same role — DuckDB opens `.duckdb` files directly from the filesystem

### 5.5 Auto-update
- Use `electron-updater` (part of `electron-builder`) — checks a GitHub Releases endpoint for new versions
- ETL can continue to run in CI; the desktop app detects that the bundled data is stale and offers to re-run ETL or download a fresh data package

### 5.6 Packaging
```bash
# Install build tooling
npm install --save-dev electron electron-builder

# Development
npx electron electron/main.js

# Build distributable
npx electron-builder --win    # .exe installer
npx electron-builder --mac    # .dmg
npx electron-builder --linux  # .AppImage
```

`electron-builder` configuration in `package.json`:
```json
"build": {
  "appId": "gov.ky.eda-tool",
  "productName": "EDA Tool",
  "files": ["index.html", "css/**", "js/**", "data/**", "electron/**"],
  "win": { "target": "nsis" },
  "mac": { "target": "dmg" },
  "linux": { "target": "AppImage" }
}
```

---

## Dependency & Compatibility Notes

| Feature | Browser Requirement | Notes |
|---|---|---|
| DuckDB-WASM | Chrome 89+, Firefox 90+, Safari 15.2+ | SharedArrayBuffer required; needs `COOP`/`COEP` headers for multi-threaded mode |
| OPFS | Chrome 102+, Firefox 111+, Safari 16.4+ | Not available in Electron renderer (use Node.js `fs` instead) |
| File System Access API | Chrome 86+, Edge 86+ | Not supported in Firefox/Safari — graceful fallback to `<input type="file">` |
| Service Workers | All modern browsers | Must be served over HTTPS or localhost |
| PWA Install prompt | Chrome/Edge only | Firefox and Safari use their own install flows |
| `SharedArrayBuffer` | Requires `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` headers | GitHub Pages supports these; configure in `_headers` file (Netlify/Cloudflare) or `vercel.json` |

---

## Recommended Implementation Order

```
Now          Phase 1 (DuckDB engine)     — highest leverage, unblocks everything
             ↓
Q2 2026      Phase 2 (OPFS persistence)  — enables offline + big data
             ↓
Q3 2026      Phase 3 (big data features) — value-add on solid foundation
             ↓
Q3 2026      Phase 4 (PWA)               — parallel with Phase 3, low effort
             ↓
Q4 2026      Phase 5 (Electron)          — after PWA validates the offline UX
```

Phases 3 and 4 can run in parallel — PWA manifest and service worker are largely independent of the data layer work.

---

## Files to Create / Modify Per Phase

| Phase | New Files | Modified Files | Deleted Files |
|---|---|---|---|
| 1 | — | `index.html` (consolidate scripts), `etl.js` | `data/report/<dataset>/*.csv` partitions |
| 2 | — | `index.html` (OPFS VFS), `etl.js` (Parquet output) | `data/raw/*.csv` (replaced by `.parquet`) |
| 3 | — | `index.html` | — |
| 4 | `manifest.json`, `sw.js`, `icons/*.png` | `index.html` (manifest link) | — |
| 5 | `electron/main.js`, `electron/preload.js`, `electron/package.json` | `package.json` (build config) | — |
