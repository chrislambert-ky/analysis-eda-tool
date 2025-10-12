# AI & Developer Instructions for the EDA Tool

This document is the source of truth for maintainers (human or AI). It captures the current architecture, data flow, conventions, and exact steps required to recreate the application from scratch.

## 1. Architecture Snapshot

**Front-end**
- Single `index.html` at repository root; contains the entire UI (Bootstrap layout, inline scripts) and references CDN-hosted assets:
  - Bootstrap 5.3
  - Apache ECharts 5.5
  - Tabulator 5.5
  - Leaflet 1.9 + Leaflet MarkerCluster 1.5
- IndexedDB (`analysis_eda_tool_db` store `partitions`) caches dataset partitions keyed by `dataset|district`.
- UI supports charts (horizontal/vertical bar, pie), map mode, and a Tabulator grid with filterable columns and CSV export.

**Data layer**
- Partitioned data and configuration live in `data/report/<dataset>/` as:
  - Partition CSVs: `<dataset>-District-XX.csv`
  - Index file: `<dataset>.index.json` (record counts per partition)
  - BI settings: `<dataset>-bi-settings.json` (dimensions, metrics, aggregation options, map metadata)
- Raw source CSV downloads stored in `data/raw/` and overwritten each ETL run.

**ETL**
- `etl.js` (Node 20-compatible) downloads remote CSVs, filters rows to valid districts (`District ##` or `Various`), and writes partitioned outputs + settings using `csv-parse` and `csv-stringify`.
- Map configuration for the bridge dataset includes clustering defaults and color-field options.

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

### Partitioning rules
- Recognize districts of the form `District ##` (case/spacing tolerant) or `Various`.
- Skip all other values; log skip counts in ETL output.
- Rewrite the `DISTRICT` column in partitions to a normalized `District 0X` or `Various` label.

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
