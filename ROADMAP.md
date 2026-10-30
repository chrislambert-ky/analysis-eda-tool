# EDA Tool — Development Roadmap

This document describes a staged path from the current GitHub Pages tool to a more complete, installable browser app. Keep the app useful and deployable at every stage; do not introduce a backend or desktop wrapper unless a concrete requirement justifies it.

---

## Current State (October 2026)

- Static, no-build app hosted on GitHub Pages; no backend, and user data stays in the browser.
- `index.html` is now the page shell; styles and browser logic are split across `css/app.css` and native ES modules in `js/`.
- Modules extracted so far: chart engine, dataset loader, shared IndexedDB store, share-link helpers, and DuckDB-WASM SQL workbench. `js/app.js` remains the large UI coordinator; further feature-boundary extraction is still needed.
- The app has a full-height dataset tree with Preview / Analyze / Refresh, a 10-row preview and separate schema view, chart and SQL surfaces, a chart view, a paged data table, and the existing Leaflet map/options.
- Chart aggregation uses DuckDB-WASM when available with a tested JavaScript fallback. Managed CSV partitions and imported user sources are cached in the shared IndexedDB database.
- The left catalog drives dataset selection; the header indicates the active dataset. Chart controls sit beside the chart; table-column controls sit beside the table.
- **Not yet implemented:** multiple independent canvas tabs, persisted workspace/canvas state, OPFS-backed DuckDB database, service worker/offline app shell, PWA manifest/install flow, file conversion, and desktop packaging.
- Current test suite covers ETL, chart engine, dataset loader, IndexedDB initialization, and share-link helpers.

---

## Phase 1 — DuckDB as the Single Query Engine

**Goal:** Replace JS-side aggregation with SQL. ECharts receives query results only, never raw rows.

### 1.1 Eager DuckDB initialization ✅
- ✅ DuckDB init moved from "on SQL tab click" to `DOMContentLoaded`
- ✅ Live status dot in page header (pulsing blue while loading, green when ready, red on error)
- ✅ All managed datasets registered as views on startup
- ⚠️ `window._eda*` bridge consolidation attempted and rolled back — execution-order timing issues caused data not to load. Two-script architecture retained. Revisit in Phase 1.7 (file refactor) when the module boundary is cleaner.

### 1.2 SQL-driven chart aggregation ✅
- ✅ `buildChartFromSQL()` query builder implemented — dimension, metric, aggregation type, split-by, and order all map to SQL clauses
- ✅ `buildSqlAggExpr()` handles `COUNT(*)`, `COUNT(DISTINCT col)`, `SUM`, `AVG`, `MIN`, `MAX`
- ✅ Split-by uses a grouped narrow result reshaped in JS (no full PIVOT needed)
- ✅ Charts rendered from JS aggregation on first load are automatically re-rendered via DuckDB once the `eda:duckdb-ready` event fires
- ✅ `prepareSeries()` / `sortSeries()` retained as a genuine error fallback only
- ✅ App versioned at `v1.2.0` displayed in the About modal

### 1.3 SQL-driven Tabulator (paged) ✅
- ✅ `renderTable()` uses DuckDB `ajaxRequestFunc` when DuckDB is ready and `state.allRows` is empty — falls back to local Tabulator pagination when rows are already in memory (the current normal case)
- ✅ `filterMode: 'remote'` + `sortMode: 'remote'` — header filters become SQL `ILIKE` clauses; sort becomes `ORDER BY` when in DuckDB mode
- ✅ `buildWhereSQL()` / `buildOrderSQL()` helpers translate Tabulator filter/sort params to safe SQL fragments
- ✅ `applyChartFilter()` uses a serializable `{field, type: '=', value}` object in DuckDB mode; `'Unknown'` maps to `IS NULL OR TRIM(...) = ''` in SQL
- ✅ "Download Full" queries DuckDB for all rows when in DuckDB table mode
- ✅ "Download Filtered" queries DuckDB with the current filter + sort state in DuckDB mode
- ✅ All `_edaQuery` calls serialized through a single promise chain — prevents concurrent-query collisions on the single DuckDB-WASM connection
- ✅ DuckDB remote-paging activates automatically on dataset switches once `state.allRows` is no longer pre-loaded (Phase 1.6 prerequisite)
- ✅ App versioned at `v1.4.0`

### 1.4 Unify the IDB stores ✅
- ✅ `analysis_eda_tool_db` bumped to version 2; `onupgradeneeded` adds `sources`, `user_source_data`, `user_source_bytes` stores alongside the existing `partitions` store
- ✅ `eda_sql_user_sources` database eliminated; dashboard and SQL workbench share `analysis_eda_tool_db` v2
- ✅ Shared `getDatabase()` connection/schema initialization extracted to `js/data-store.mjs`
- ✅ Dashboard and SQL workbench use the same opener and preserve all four existing stores
- ✅ App versioned at `v1.5.0`

### 1.5 Catalog schema via DuckDB only (Deferred)
- Current preview uses DuckDB schema when available, with sampled CSV and BI-settings fallback paths.
- Consolidate schema lookup on `DESCRIBE` after the catalog and SQL data-source lifecycles have a stable interface.

### 1.6 ETL simplification
- Remove partition CSV generation from `etl.js` — only write `data/raw/*.csv` and BI settings JSON
- DuckDB's `read_csv_auto()` replaces all partition loading
- `data/report/<dataset>/*.csv` partition files can be deleted from the repo once Phase 1 is validated

**Milestone:** App purely routes all data access through DuckDB. `state.allRows` only exists for the map (lat/lon per point still needs row-level data).

---

## Phase 1.6c — Extended File Format Support

**Goal:** Support every tabular file format that DuckDB-WASM can read natively in the "Add Source" flow. Currently only CSV and Parquet are handled.

DuckDB-WASM supports the following formats out of the box — all are candidates:

| Format | DuckDB reader | Notes |
|---|---|---|
| CSV / TSV | `read_csv_auto()` | ✅ Already supported |
| Parquet | `read_parquet()` | ✅ Already supported |
| JSON (newline-delimited) | `read_json_auto()` | NDJSON / JSON Lines — one object per line |
| JSON (array) | `read_json_auto()` | Standard `[{...}, {...}]` array files |
| Arrow IPC (`*.arrow`) | `read_ipc_stream()` | Columnar, zero-copy — fastest for large datasets |
| Excel (`*.xlsx`, `*.xls`) | `read_xlsx()` via `spatial` extension | Requires loading the `spatial` extension at runtime |

### Implementation tasks
- Extend `guessFileType(url)` to detect `.json`, `.ndjson`, `.jsonl`, `.arrow`, `.xlsx`, `.xls` by extension
- Map each type to its DuckDB reader expression in `registerSource()` and `registerSourceFromRows()`
- Update the Add Source UI: file picker `accept` attribute to include the new extensions; URL input hint text updated
- For JSON: `read_json_auto()` works for both array and NDJSON — no branch needed
- For Excel: load the `spatial` extension on demand (`await conn.query("LOAD spatial;")`) before the first `.xlsx` registration; cache a flag so it only loads once
- For Arrow: register as a local file via `registerSourceFromRows` path using Arrow IPC deserialization
- Update the About modal "Adding Your Own Data" section to list all supported formats

### Out of scope for this phase
- Fixed-width / positional text files (no DuckDB reader)
- XML (no native DuckDB reader without extension)
- Database files (`.sqlite`, `.db`, `.duckdb`) — see Phase 1.6d

---

## Phase 1.6d — Database File Import & Tree Browser

**Goal:** Allow users to import a local database file (SQLite, DuckDB `.db`) and browse its contents — databases → tables → columns with data types — using the same tree-style schema panel already used for individual datasets.

DuckDB-WASM can attach and query SQLite and DuckDB database files directly, making this a natural extension of the existing "Add Source" flow.

### Supported database formats

| Format | DuckDB reader | Notes |
|---|---|---|
| SQLite (`.sqlite`, `.db`) | `ATTACH '...' (TYPE sqlite)` | Requires the `sqlite` extension; auto-loaded by DuckDB |
| DuckDB (`.duckdb`, `.db`) | `ATTACH '...'` | Native format — zero conversion |

### UX: tree browser

When a database file is imported, the sidebar entry expands into a **three-level tree** rather than a flat field list:

```
▼ my_database.sqlite            ← database node (alias)
   ▼ roads                      ← table name
      id          INTEGER
      name        VARCHAR
      geom        GEOMETRY
   ▶ bridges                    ← collapsed table
   ▶ counties
```

- Clicking a **table node** populates the SQL editor with `SELECT * FROM my_database.roads LIMIT 100` and makes the table available as a chart/EDA source
- Clicking a **field name** copies the fully-qualified column reference (`my_database.roads.name`) to the clipboard
- The tree state (expanded/collapsed) is preserved in `sessionStorage`

### Implementation tasks
- Add `.sqlite`, `.db`, `.duckdb` to `setLocalFile()` allowed extensions
- New `registerSourceFromDatabase(alias, bytes)` function:
  1. Write bytes to a DuckDB virtual filesystem buffer
  2. `ATTACH '__vfs_alias.sqlite' AS alias (TYPE sqlite, READ_ONLY)` (or native ATTACH for `.duckdb`)
  3. `SHOW ALL TABLES` to enumerate tables in the attached database
  4. `DESCRIBE alias.tablename` for each table to collect schema
- Extend the sidebar tree renderer to support the three-level database → table → field hierarchy
- Each table in the attached database is individually selectable as a chart/EDA source — registered as a view `alias__tablename` for flat compatibility with existing chart and SQL code
- Remove / detach cleans up all derived views and drops the ATTACH
- Update the About modal to document database import

### Out of scope for this phase
- Live database connections (server-side PostgreSQL, MySQL) — local file only
- Schema modification (INSERT, UPDATE, CREATE TABLE) — read-only import
- `.sql` dump files (text SQL scripts, not binary database files)

---

## Phase 1.6b — Chart & UX Polish ✅

### Completed
- ✅ Aggregation defaults: default dimension = DISTRICT, default metric = DISTRICT, default aggregation = COUNT
- ✅ String-vs-string detection: when both dimension and metric are string fields, aggregation list collapses to COUNT / DISTINCT COUNT only
- ✅ Distinct Count added as an aggregation type (SQL: `COUNT(DISTINCT col)`, JS fallback: Set-based)
- ✅ Chart titles on all bar chart types (`{seriesLabel} by {dimensionVal}` heading)
- ✅ Axis name removed from bar charts — title alone carries the label, no clipping
- ✅ Split By legend no longer overlaps chart title — legend pinned below title, `grid.top` adjusted dynamically

---

## Phase 1.7 — File Structure Refactor (In Progress)

**Goal:** Keep the GitHub Pages app build-free while moving browser behavior into focused, single-purpose native ES modules.

**Why this matters:**
- Smaller modules give contributors and AI editors clear ownership boundaries.
- Native modules work directly from the static GitHub Pages deployment; no bundler or browser build step is required.
- Browser caching remains granular, and isolated logic can be tested in Node.

### Current module structure

```
analysis-eda-tool/
├── index.html
├── css/app.css
└── js/
    ├── app.js                 (page startup, UI state, event wiring; still oversized)
    ├── chart-engine.mjs       (aggregation, sorting, ECharts options)
    ├── data-store.mjs         (shared IndexedDB schema and partition API)
    ├── dataset-loader.mjs     (CSV parsing, partition fetch/cache, previews)
    ├── share.mjs              (pure share-link parsing/serialization)
    └── duckdb.js              (DuckDB-WASM, SQL workbench, imported sources)
```

### Remaining work
1. Extract table setup, paging, column visibility, and downloads into a table module.
2. Extract dataset tree and preview behavior into a catalog module.
3. Extract map UI/rendering only after the product direction for maps is clearer; keep the current map unchanged until then.
4. Reduce `app.js` to a small entry point that composes modules and owns shared app/workspace state.
5. Replace ad hoc `window._eda*` coupling with an explicit, documented module/event interface. Do this incrementally; do not repeat the earlier risky all-at-once bridge consolidation.
6. Preserve direct GitHub Pages hosting and validate each move with targeted tests and a browser smoke test.

The HTML contains real page markup and does not need an arbitrary line-count target. The completion criterion is clear ownership and testable module boundaries, not a 200-line `index.html`.

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

**Milestone:** Where supported, managed and imported data can persist in OPFS and be queried after reload/offline. Retain a clear fallback for browsers without the required storage support. Remote Parquet range queries are a separately verified optimization, not a requirement for the initial app migration.

---

## Phase 3 — Big Data & Advanced Features

**Goal:** Unlock genuine front-end big data analysis.

### 3.1 File System Access API (local huge files)
- "Add Source" supports the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) — user picks a local CSV or Parquet file
- DuckDB reads it in-place via a File object URL — the file never needs to be fully copied into the browser
- Multi-GB local files are queryable with zero upload

### 3.1b Unified geometry field picker (map configuration UX)

**Goal:** Replace the separate Latitude / Longitude dropdowns with a single, geometry-aware field picker that works across coordinate formats.

**Problem with the current UI:**
- Forces users to know which columns are lat/lon and pick them separately
- Breaks entirely for datasets that store geometry as a single WKT column (`POINT(lon lat)`), a GeoJSON `geometry` field, or a PostGIS-style `GEOMETRY` type
- Provides no guidance when a dataset has no obvious coordinate columns

**Proposed approach:**
- On map tab activation, inspect the registered dataset's columns via `DESCRIBE`
- Auto-classify columns into geometry "roles":
  - **WKT / GEOMETRY**: single column matching type `GEOMETRY` or containing values like `POINT(`, `LINESTRING(`, `POLYGON(`
  - **Lat/Lon pair**: two numeric columns whose names match common patterns (`lat`, `latitude`, `y`, `lon`, `longitude`, `x`, etc.)
  - **GeoJSON geometry**: a text/JSON column containing `{"type":"Point"` or similar
- Present a single **Geometry Source** dropdown with options like:
  - `Lat + Lon columns → pick two fields`
  - `WKT column → pick one field` (use `ST_X()` / `ST_Y()` via the `spatial` extension to extract coords)
  - `GeoJSON geometry column → pick one field`
- When WKT or GeoJSON geometry is selected, use DuckDB `spatial` extension to extract point coordinates server-side before passing rows to Leaflet
- Fall back gracefully to the current lat/lon picker UI if `spatial` extension is unavailable

**Why this matters:**
- Datasets imported from GIS tools (ArcGIS, QGIS, PostGIS exports) often use WKT or GeoJSON geometry columns rather than separate lat/lon fields
- Reduces friction for the most common case (lat/lon pair) while unlocking support for richer geospatial formats added in Phase 1.6c

**Dependencies:** `spatial` extension (DuckDB-WASM) for WKT/GeoJSON extraction. Lat/Lon pair mode has no new dependencies.

---

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
  "start_url": "./",
  "scope": "./",
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
- Pre-cache the same-origin app shell and modules with an explicit cache version
- Use network-first or stale-while-revalidate for managed dataset files; preserve HTTP Range behavior if remote Parquet is later used
- DuckDB WASM bundle is large (~8 MB) — cache it permanently, update only on version bump
- Do not assume third-party CDN assets can be safely or reliably pre-cached; decide fallback/update behavior for each dependency

```
sw.js responsibilities:
  install  → cache same-origin app shell and versioned modules
  fetch    → serve shell with network fallback; preserve data refresh and range requests
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

**Note:** The app shell can be installable before all datasets are offline-ready. Offline data availability depends on the selected storage strategy and which datasets the user has loaded; communicate that explicitly instead of promising all data is available offline.

---

## Phase 5 — Optional Local Desktop App (Far Future)

**Goal:** Revisit whether a local desktop app is worthwhile if GitHub Pages and browser storage eventually limit real user workflows. This is explicitly a far-future option, not part of the current delivery plan.

### 5.0 Evaluate the need and implementation options
- First identify a measured limitation that the GitHub Pages/PWA version cannot address (for example, very large local files, storage quotas, or native filesystem access).
- Compare a Rust-backed local app (for example, Tauri with a Rust command layer and a web UI) against a mostly-Rust UI and Electron. Do not select a framework based only on expected speed; benchmark actual data-loading, query, packaging, and maintenance needs.
- Reuse the current browser app and DuckDB-WASM where it remains sufficient. Consider a Rust core or native DuckDB integration only if it solves a demonstrated problem.
- Keep any future local app able to open the existing CSV/Parquet inputs and preserve documented workspace/data formats where practical.

### 5.1 Why Electron (and when to consider alternatives)
- Electron is one possible implementation, not the default or a commitment. It bundles Chromium + Node.js and can reuse the browser renderer.
- Node.js access layer (`main.js`) unlocks: native file dialogs, direct filesystem reads, background jobs, system tray, auto-update
- **Alternative:** [Tauri](https://tauri.app/) uses Rust with a system WebView; a Rust-native UI is another option. Evaluate toolchain, DuckDB integration, platform support, binary size, and maintenance at implementation time.

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

## Phase 6 — Workspace UX Redesign (Data Formulator / PondPilot / Kepler-inspired)

**Goal:** Evolve from a fixed dashboard into a workspace: load data once, then switch between surfaces and open multiple canvases. Remains a no-build static site hosted on GitHub Pages; all processing stays in-browser on DuckDB-WASM.

**Inspiration and what we take from each**

| Source | Ideas adopted |
|---|---|
| [Data Formulator](https://data-formulator.ai/) | Collapsible sidebar listing datasets; hover tooltip with dataset description; "Browse Data Sources" catalog dialog (tree of tables + data preview on the right before loading) |
| [KY Explorer – Overture Maps](https://chrislambert-ky.github.io/ky-explorer-overturemaps/) | Top surface bar: Results · SQL Editor · Map Preview · Export & Convert · Schema; export/convert options |
| [PondPilot](https://app.pondpilot.io/) | Instructional empty state; sidebar of datasets + saved queries; preview table on load; "+" tab opening a blank canvas that becomes a query view or a chart; chart toolbar (x, y, type, group-by, aggregation, sort, title/labels) |
| [GeoLibre](https://web.geolibre.app/), [Kepler.gl](https://kepler.gl/), [GeoForger](https://mapryx.geoforger.com/map) | Map canvas with layer panel, styling, filters, and spatial-SQL-driven layers |

### 6.0 Prerequisite — modular app foundation
The initial split is done: HTML and CSS are externalized; chart logic, dataset loading, shared storage, and share-link logic are native modules with tests. Finish the remaining Phase 1.7 work—especially table/catalog boundaries and a documented app-state interface—before adding multi-canvas persistence. Keep the no-build GitHub Pages deployment working throughout.

### 6.1 App shell: sidebar + empty state
- Full-height, docked left pane with a dataset tree grouped into **Preloaded** and **Imported** sources; future sections may include **Queries** and **Settings/Options**
- Dataset rows show a hover tooltip (description, row count, source, last refresh) sourced from catalog metadata (extend `etl.js` output / dataset JSON with a `description` field; user-loaded files get an editable description)
- Link to the KYTC Data Hub from the dataset pane; blank-state landing page has short instructions for adding files and opening the SQL editor
- Queries list: save, rename, delete; persisted in IndexedDB (reuse the existing user-sources store)

### 6.2 Browse Data Sources catalog
- Docked tree remains visible beside the workspace; selecting a dataset opens a preview dialog
- Preview shows the first 10 rows with type icons in column headers; schema and data are separate preview modes, never shown together
- Per-dataset **Analyze** activates the dataset in the visualization and table; **Refresh** updates its cache and only reloads the active dataset
- Reuses Phase 1.6d tree browser work; preview queries must be cheap (`LIMIT`, no full scan)

### 6.3 Surface bar (per-dataset views)
- Horizontal top bar: **Results · SQL Editor · Map Preview · Export & Convert · Schema**
- Each surface operates on the active dataset/tab; switching surfaces never reloads data
- Map Preview is shown only when a geometry/lat-lon column is detected
- Schema surface: columns, types, null counts, distinct counts, basic profile (all via DuckDB `SUMMARIZE`/`DESCRIBE`)

### 6.4 Workspace tabs and canvases
- "+" opens a new tab. A blank canvas lets the user choose **Query/Table**, **Chart**, or **Map**.
- Model each canvas as serializable state, for example `{id, kind, title, datasetRef, query, view, config}`. Keep the SQL editor/query text in query canvases, not above chart output.
- A canvas owns its own selected dataset/query, view type, and control configuration. Switching canvases must not silently overwrite another canvas's state.
- First ship in-memory tab state; persist and restore canvases only after the state model and migration/versioning behavior are tested.
- **Chart canvas toolbar:** x-axis, y-axis (multi), chart type (bar, horizontal bar, stacked bar, line, area, pie), group-by/series, aggregation (sum, avg, count, min, max, count distinct), sort (field + direction), title and axis labels. Config → SQL builder → ECharts option; the builder is a pure function and unit tested.

### 6.5 Export & Convert
- Export current result or whole dataset to CSV, JSON, NDJSON, Parquet, Excel (if feasible), GeoJSON, and GeoParquet via DuckDB `COPY ... TO` into the WASM filesystem then download
- **Converter mode:** drop any supported file (e.g. one received by email), pick a target format, download, with no dataset registration required
- Options: column selection, row filter, compression, CRS for spatial outputs
- Large files: warn above a configurable size; stream where possible

### 6.6 Map canvas (spatial)
- Library decision deferred (Leaflet + spatial-SQL layers vs. MapLibre GL + deck.gl). Evaluate when 6.1–6.5 ship, against: WebGL performance with >100k features, vector tiles, and licensing/CDN needs for GitHub Pages
- Layer panel (add/remove/reorder), each layer backed by a SQL query returning a geometry (as GeoJSON via `ST_AsGeoJSON` or WKB)
- Styling: fill/stroke, color by column (categorical/quantile), size, opacity, tooltips, legend
- Filters: attribute and spatial (bbox, within, buffer) exposed as UI controls that generate SQL
- Expose DuckDB spatial functions through a "Spatial tools" menu: buffer, intersection, union/dissolve, centroid, simplify, area/length, spatial join, distance, reproject (`ST_Transform`), H3 if the extension is available in WASM
- **Open verification item:** confirm which `spatial` extension functions and file readers (`ST_Read` formats) are actually available in the DuckDB-WASM build we ship; document the supported list in the UI

### Suggested order
1. 6.0 file split + tests
2. 6.1 sidebar/empty state → 6.2 catalog
3. 6.3 surface bar → 6.5 export/convert (high value, low risk)
4. 6.4 canvases and chart toolbar
5. 6.6 map canvas

### Risks
- Regressing the current working app during refactor: keep each step shippable, move code without behavior changes, and verify in-browser after each move
- The previous `window._eda*` bridge consolidation failed on execution order; make initialization order explicit and replace globals incrementally
- Canvas persistence can entangle SQL, dataset, chart, and map state if introduced before a clear per-canvas state model exists
- Browser memory limits for large file conversion
- DuckDB-WASM spatial extension availability and size

---

## App Migration Strategy — GitHub Pages First

**Product constraint:** Maximize the functionality of the GitHub Pages-hosted browser app. Do not require paid hosting, a backend, or a new deployment environment for the planned work. A future move to another platform is a distant possibility to revisit only if funding and concrete requirements justify it; it is not a current milestone.

**Product direction:** Make the browser app feel like a capable desktop workspace while preserving static GitHub Pages hosting and in-browser data processing. An installable PWA is an enhancement to that same hosted app, not a migration away from Pages. Electron/Tauri is explicitly out of the near-term plan.

### Milestone A — Finish module boundaries
- Extract the table and catalog UI from `app.js`; keep data access in `data-store.mjs` / `dataset-loader.mjs` and rendering in feature modules.
- Define one explicit app/workspace state contract and lifecycle for DuckDB readiness, dataset selection, and view changes.
- Keep browser UI, dataset/query behavior, and storage integration separated so a future local Rust app can reuse documented data/workspace concepts without requiring a rewrite today.
- Keep each change behavior-preserving and covered by focused tests.
- **Exit:** changing a dataset or surface does not depend on script load order or undocumented globals.

### Milestone B — Make it a workspace
- Introduce canvas tabs and a blank-canvas state. Begin with in-memory canvases so each canvas can independently own a dataset, query, visualization type, and settings.
- Provide focused **Table**, **Chart**, and **SQL/Query** experiences; keep SQL text/results inside the query experience.
- Add chart configuration controls to chart canvases and preserve the existing table/chart/map behaviors during migration.
- **Exit:** users can open and switch between two canvases without one canvas changing the other's controls or result.

### Milestone C — Persist workspace and data safely
- Version and migrate persisted workspace state; restore tab/canvas selection and configuration after reload.
- Evaluate DuckDB-WASM OPFS for managed/imported data, with IndexedDB/CSV fallback where OPFS or browser support is unavailable.
- Keep the current hosted CSV partitions as the source of truth initially. Treat hosted Parquet/range querying as a later opt-in optimization after real files, CORS, HTTP range behavior, and DuckDB-WASM compatibility are verified.
- **Exit:** a reload restores workspace state and previously imported data without silently corrupting existing IndexedDB data.

### Milestone D — Installable GitHub Pages app
- Add a manifest, app icons, install guidance, and a service worker only after the shell and storage behavior are stable.
- Resolve all asset, start, scope, and service-worker URLs relative to the GitHub Pages project path (the site is not hosted at the domain root).
- Cache only assets with a deliberate update policy; do not make releases depend on an opaque cache of third-party CDN files.
- **Exit:** install, update, reload, and offline-unavailable states are understandable and tested on the hosted Pages URL.

### Milestone E — Advanced browser features
- Add file conversion/export as a distinct workflow, then revisit the map last after deciding whether the existing Leaflet map remains the default or an advanced GIS canvas is added.
- Keep desktop packaging and a hosting migration out of scope unless a concrete browser limitation and funding make them worthwhile; if that point arrives, evaluate Rust/Tauri alongside Electron rather than assuming either.

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
Now          Finish Phase 1.7           — complete feature modules and explicit app state
             ↓
Next         Phase 6.3–6.4               — surface navigation, independent in-memory canvases
             ↓
Then         Phase 2                     — versioned OPFS persistence with browser fallback
             ↓
Then         Phase 4                     — installable PWA; GitHub Pages subpath-aware caching
             ↓
Later        Phase 6.5 + Phase 3         — conversion/export and advanced analysis
Last         Phase 6.6                   — choose/evolve GIS canvas after map requirements settle
Far future   Phase 5                     — evaluate a local Rust/Tauri, Rust-native, or Electron app only if justified
```

Phase 6.1 and 6.2 (the docked dataset browser, preview, Analyze/Refresh flow) are implemented. Phase 1 DuckDB chart aggregation, shared IndexedDB, modular CSS, and several tested ES modules are also in place. The immediate work is to finish the app-state/module boundary, then build canvases in memory before deciding persistence details. This order reduces the risk of persisting an unstable state model.

---

## Files to Create / Modify Per Phase

| Phase | New Files | Modified Files | Deleted Files |
|---|---|---|---|
| 1 | — | `index.html` (consolidate scripts), `etl.js` | `data/report/<dataset>/*.csv` partitions |
| 2 | — | `index.html` (OPFS VFS), `etl.js` (Parquet output) | `data/raw/*.csv` (replaced by `.parquet`) |
| 3 | — | `index.html` | — |
| 4 | `manifest.json`, `sw.js`, `icons/*.png` | `index.html` (manifest link) | — |
| 5 | `electron/main.js`, `electron/preload.js`, `electron/package.json` | `package.json` (build config) | — |
