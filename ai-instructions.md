# AI & Developer Instructions for the EDA Tool

This document is the source of truth for maintainers (human or AI). It captures the current architecture, data flow, conventions, and exact steps required to recreate the application from scratch.

---

## TARGET ARCHITECTURE (DuckDB-first)

The app is being migrated to a three-pillar architecture:

```
Data Sources                  DuckDB-WASM (shared)       UI Layer
──────────────────            ────────────────────       ─────────────────
Remote CSV / Parquet ─────→   Views / Physical Tables →  Apache ECharts
Local file upload ────────→   SQL aggregation engine  →  Leaflet map
IDB / OPFS cache ─────────→   Single query interface  →  Tabulator (paged)
```

**Core principles:**
- **DuckDB-WASM is the single query engine** for charts, catalog, SQL panel, schema, and table pagination. It is initialized eagerly at page load, not lazily on SQL tab click.
- **Apache ECharts** receives only pre-aggregated query results (a few rows), never the full dataset.
- **IndexedDB / OPFS** is used for persistent storage of imported datasets and cached remote data. The goal is DuckDB's OPFS VFS as a persistent browser database.
- **No JS-side aggregation** — `prepareSeries()` and the `state.allRows` full-materialization pattern are replaced by SQL queries built from chart control state.
- **Parquet is the preferred format** for large datasets — DuckDB uses HTTP range requests against remote Parquet files for efficient big-data querying.

**Migration phases:**
1. **Phase 1 (in progress):** Shared DuckDB instance, SQL-driven chart aggregation, eager init.
2. **Phase 2:** OPFS persistence replaces IDB partition cache. Datasets imported as Arrow/Parquet.
3. **Phase 3:** DuckDB-paged Tabulator, File System Access API for huge local files, cross-dataset JOINs.

---

## Architecture Decisions

### ADR-001 — Why DuckDB-WASM replaces JS aggregation and IDB partition caching

**Decision:** Replace the partition-CSV + IndexedDB + `state.allRows` pipeline with DuckDB-WASM as the single query engine. Charts, table pagination, schema inspection, and SQL workbench all route through DuckDB SQL.

**Context:** The original architecture cached pre-filtered per-district CSV partitions in IndexedDB so that chart aggregations (JavaScript loops over `state.allRows`) could run instantly on repeat visits. It worked but had a fundamental cost: every interaction required materializing the full dataset as an array of JS objects in the browser's heap.

**Performance — why DuckDB is as fast or faster than IDB row retrieval:**

IDB is fast at *retrieving* rows, but the data still had to be deserialized into the JS heap and then looped over by the aggregation code. For a `COUNT(*) GROUP BY DISTRICT` query on 50,000 rows, the JS engine touched every row object to produce 13 numbers.

DuckDB-WASM is a columnar database compiled to WebAssembly. The same aggregation:
- reads only the `DISTRICT` column from its compressed columnar store (not every field in every row)
- executes the GROUP BY in native compiled WASM, not interpreted JavaScript
- returns 13 rows to JS — that is all the JS heap ever sees

The result is that for typical chart interactions (aggregations, filters, splits) DuckDB returns far less data to JS than the IDB path ever did, and does so without the deserialization overhead.

**Memory — why DuckDB-WASM avoids the pandas problem:**

A common pattern in Python data analysis is to load a dataset into a pandas DataFrame. Because pandas is row-oriented and stores each value as a Python object, a 50 MB CSV can expand to 200–400 MB in RAM. This is essentially the same problem as `state.allRows` in JavaScript — an array of 50,000 JS objects carries per-value boxing overhead and no compression.

DuckDB is columnar. Internally a column of 50,000 rows looks like:

```
DISTRICT:  [01, 01, 02, 01, 03, ...]   ← packed integers, run-length compressed
AMOUNT:    [120000, 85000, 210000, ...]  ← packed doubles
```

There are no row objects, no per-value boxing, and low-cardinality columns (like DISTRICT with 13 unique values) compress extremely well. DuckDB typically uses 3–5× less memory than a row-oriented in-memory store for the same data. For datasets that exceed available WASM heap, DuckDB can spill to the virtual filesystem — it does not crash.

**What IDB still provides (Phase 1 → Phase 2 transition):**
- IDB continues to cache the raw CSV bytes for managed datasets (one entry per dataset, not 13 partition files) so repeat visits avoid a network round-trip — same offline benefit, simpler storage.
- User-uploaded files are persisted in IDB and re-registered with DuckDB on each page load (DuckDB views are not persistent across reloads until Phase 2 OPFS).
- Phase 2 replaces IDB entirely with DuckDB's Origin Private File System (OPFS) VFS — a persistent `.duckdb` file in the browser's private storage that survives reloads natively.

**Consequences:**
- `state.allRows` materialisation is eliminated for charts and table (map lat/lon rows remain until Phase 3).
- Partition CSV files under `data/report/` become redundant and will be deleted after Phase 1 validation.
- ETL simplifies to: download raw CSV → write BI settings JSON (no partition splitting).
- Offline capability is temporarily reduced between Phase 1.6 (partition removal) and Phase 2 (OPFS), unless the intermediate IDB raw-bytes cache is implemented.

---

## 1. Current Architecture Snapshot (transitional)

**Front-end**
- Single `index.html` at repository root; contains the entire UI (Bootstrap layout, inline scripts) and references CDN-hosted assets:
  - Bootstrap 5.3
  - Apache ECharts 5.5
  - Tabulator 5.5
  - Leaflet 1.9 + Leaflet MarkerCluster 1.5
  - DuckDB-WASM 1.29.0 (CDN, lazy-loaded in SQL `<script type="module">`)
- IndexedDB (`analysis_eda_tool_db` store `partitions`) caches dataset partitions keyed by `dataset|district`. **Will be replaced by OPFS in Phase 2.**
- A second IDB (`eda_sql_user_sources`) stores user-added source metadata and row data. **Will be merged into OPFS in Phase 2.**
- UI supports charts (horizontal/vertical bar, pie), map mode, Tabulator grid, SQL workbench, and Data Catalog.

**Current data layer (Phase 1.6 — DuckDB-first)**
- Raw CSVs live in `data/raw/` — the authoritative source for DuckDB views.
- BI settings live in `data/report/<dataset>/<dataset>-bi-settings.json` — contains `totalRecords`, `dimensions`, `metrics`, and optional `map` config. No partition CSVs or `index.json`.
- `state.allRows` is **empty** for managed datasets until the map tab is activated; charts and table use DuckDB SQL exclusively.
- Map rows are fetched lazily via `loadMapRowsFromDuckDB()` when `chartType === 'map'` and `state.allRows` is empty.
- Dimension/metric selector lists are expanded from DuckDB native column types by `expandControlsFromDuckDB()` once `eda:duckdb-ready` fires.
- IDB `partitions` store is no longer written to; will be dropped in Phase 2 (OPFS).

**ETL (Phase 1.6)**
- `etl.js` (Node 20-compatible) downloads remote CSVs to `data/raw/` and writes `bi-settings.json` per dataset using `csv-parse`.
- No partition splitting, no `index.json`. `totalRecords` is counted from the raw CSV and embedded in `bi-settings.json`.
- Map configuration for the bridge dataset is hardcoded in `etl.js` (clustering defaults, color-field options).

**Automation**
- `.github/workflows/nightly-etl.yml` runs nightly (05:15 UTC) to refresh data, commit, and push.

## 2. Recreating the Project

1. **Start a repo** (or clean folder) with the root files:
   - `index.html` (copy from this repo if unavailable; see Section 4 for structure notes).
   - `etl.js`, `package.json`, `package-lock.json`, `.gitignore`, `.github/workflows/nightly-etl.yml`.
2. **Install dependencies**
   ```bash
   npm install
   ```
   Packages used: `csv-parse`, `csv-stringify`, `fs-extra`, `node-fetch`.
3. **Run ETL**
   ```bash
   node etl.js
   ```
   Outputs:
   - `data/raw/*.csv` (raw downloads)
   - `data/report/<dataset>/*.csv` partitions
   - `data/report/<dataset>/<dataset>.index.json`
   - `data/report/<dataset>/<dataset>-bi-settings.json`
4. **Open the UI**
   - Either double-click `index.html` or serve via a static server (`npx serve .`).
5. **Configure GitHub Pages** (if desired)
   - Set Pages source to the repo root.
   - Ensure nightly workflow has push permission (default `contents: write`).

## 3. Dataset Configuration

### Data sources
- `eda_assets_bridge_condition_owner_area`
- `eda_construction_procurement`
- `eda_current_enact_plan_data_set`
- `eda_programmanagement_authorized_detailed`

Each dataset definition exists in `DATASETS` array at the top of `index.html`. The value of `id` must match the folder name under `data/report/`.

### BI settings format (Phase 1.6+)
Each `data/report/<dataset>/<dataset>-bi-settings.json` contains:
```json
{
  "datasetName": "<dataset>",
  "totalRecords": 12345,
  "dimensions": ["DISTRICT", "COUNTY"],
  "metrics": ["Record Count"],
  "aggregationTypes": ["Count"],
  "orderBy": ["Dimension", "Metric Agg Result"],
  "order": ["Ascending", "Descending"],
  "map": { ... }   // optional, present when lat/lon fields exist
}
```
- `totalRecords` replaces the old `index.json` as the record count source.
- There are no partition CSV files or `index.json` files.

### Map metadata
- Bridge dataset (`eda_assets_bridge_condition_owner_area`) includes:
  - `clusterDefault: true`
  - `districtField: DISTRICT`
  - `countyField: COUNTY`
  - `defaultColorField: GFP`
  - `colorFieldOptions`: `[GFP, OWNERSHIP, OWNER, LOAD_RATING_AGENCY, NHS]`
- UI logic:
  - Map controls replace the general chart controls when chart type is `map` and dataset has map config.
  - Selecting “All Districts” re-enables clustering.
  - Selecting a specific district or county auto-disables clustering (toggle remains available for manual override).

## 4. UI Behaviour Cheatsheet

- **Dataset load**: fetch settings/index JSON, populate controls, then sequentially load partitions (respecting cache).
- **Progress**: text hints (`progressMessage`) update during partition load and map rendering.
- **Chart legends**: hidden automatically when split-by produces >13 series.
- **Table downloads**: “Filtered” uses `getRows('active')` to honor filters; “Full” uses `state.allRows`.
- **Map toggles**:
  - Clustering toggle always displayed; auto-set based on district/county selection rules above.
  - District dropdown cascades into county dropdown (county list filters to selected district).
  - Color dropdown recolors markers deterministically (`stringToColor`).

## 5. Coding Conventions
- Use `async/await`; avoid `.then` for new logic.
- Apply concise comments when behaviour is non-obvious (e.g., map clustering rules).
- Stick to ASCII unless copying data that already includes Unicode.
- Keep inline script modular by grouping related functionality (load/setup/render/helpers).
- For ETL, prefer pure functions where possible and log informative status lines (`[ETL DEBUG]`, `[ETL INFO]`).

## 6. Git & Deployment Notes
- `data/` contents are intentionally tracked. Do not add them to `.gitignore`.
- Nightly workflow commits with message `chore: nightly ETL refresh` when data changes.
- If you add new datasets, ensure the workflow still completes in a reasonable time (<15 minutes) to avoid CI timeouts.
- For manual ETL refresh, run `node etl.js` locally and commit the resulting `data/` changes.

## 7. Extending the App
- **New dataset**: update `DATASETS` array, verify ETL includes the source, run ETL, and adjust map settings if needed.
- **New visualizations**: extend `prepareSeries` / `buildChartOption`. Maintain legend auto-hide logic.
- **Additional filters**: adjust `mapOptions` or add new control sections. If controls only matter in certain chart modes, mimic the map behaviour (toggle sections on/off).
- **Testing**: no automated tests yet; rely on manual smoke tests: load each dataset, flip through chart types, apply filters, download CSVs.

## 8. Troubleshooting
- **Map not available**: ensure BI settings JSON includes `map` block and that dataset entry is in `DATASETS`.
- **Weird legend values**: confirm ETL filtered out invalid district labels; rerun `node etl.js` if necessary.
- **Filtered download includes extra rows**: check Tabulator filters (should rely on `getRows('active')`).
- **Cluster toggle stuck**: confirm district/county dropdowns are returning `MAP_ALL_OPTION` when reset.

Keep this document synchronized whenever architectural choices change so future contributors (or AI assistants) can reproduce the environment with minimal guesswork.
