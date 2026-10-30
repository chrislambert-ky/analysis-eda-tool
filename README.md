# Exploratory Data Analysis Tool

A single-page, fully in-browser exploratory data analysis tool built with vanilla HTML/CSS/JS and CDN libraries. Datasets are pre-partitioned by district so the UI loads data incrementally and caches it in IndexedDB. No server, no build step, no data ever leaves your browser.

> This application was built entirely with AI. The project is a deliberate demonstration that a complete, working app can be developed 100% through AI-driven implementation, with the human role limited to direction, prompting, testing, and evaluation rather than hand-editing code. No line of code in this application was manually written by the project owner.

**Hosted version:** https://chrislambert-ky.github.io/analysis-eda-tool/ — open this URL to use the app without any local setup.  
**Repository:** https://github.com/chrislambert-ky/analysis-eda-tool  
**Data source:** https://trak.kytc.ky.gov/

---

## Features

### Visualisation & Table
- **Views:** Horizontal Bar, Vertical Bar, Pie, interactive Map (Leaflet + MarkerCluster), and SQL Workbench. A docked dataset tree provides browsing, preview, load, and refresh actions.
- **Controls:** Dimension, Metric, Aggregation, Split By, Order By, and Order Direction selectors update the chart instantly.
- **Share state:** The **Share** button copies a URL containing the current dashboard selections for preloaded datasets. Opening that link restores the same state, while normal use of the app continues on the clean base URL.
- **Data Table:** Tabulator-powered table with per-column header filters, horizontal scroll, and consistent column widths.
- **Contextual controls:** Chart settings sit beside the graph, while table-column visibility controls sit beside the data table.
- **Download:** Export the full dataset or the currently filtered rows to CSV.
- **Chart filter:** Clicking a chart series/segment filters the table to matching rows; a badge shows the active filter with a one-click clear.
- **Map options:** Clustering (on by default), district/county filter, and color-by-field controls appear automatically when a dataset has map configuration. Selecting a specific district or county temporarily disables clustering.

### Dataset Catalog
The docked **Datasets** pane provides a tree of preloaded and imported datasets:

- Preloaded and user-imported datasets are grouped in the tree with descriptions and browser-cache status.
- Selecting a dataset opens a preview dialog. The Data view shows the first 10 rows with type icons beside column names; the Schema view is separate.
- **Analyze** makes that dataset active in the visualization and table.
- **Refresh** updates that dataset's cached partitions. If it is active, the app reloads it; otherwise, the active dataset is unchanged and the left pane remains available.
- The schema includes inferred SQL-style column types (`VARCHAR`, `INTEGER`, `DOUBLE`, `DATE`) and dimension/metric classifications.

### SQL Workbench
- **In-browser SQL** powered by [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview.html) — no backend required.
- Write and run arbitrary SQL against any combination of managed and user-added datasets.
- Editor with line numbers, resizable panes, and `Ctrl+Enter` to run.
- Results render in a scrollable table with row count and execution time.
- The SQL-side panel is a schema explorer for datasets managed in the left pane; expand a source to inspect its columns or select its name to insert a table reference into the editor.
- Export query results to CSV with the **↓ CSV** button.
- DuckDB is initialised automatically when the page loads, so SQL, chart aggregation, and schema inspection are ready as soon as the engine finishes loading.

### Adding Your Own Data
The **+ Add Source** button in the docked dataset pane lets you bring in your own data:

| Option | How it works |
|---|---|
| **From URL** | Point to a publicly accessible `.csv`, `.parquet`, `.geojson`, or `.json` file. The file must allow CORS. |
| **Local File** | Upload a `.csv`, `.parquet`, `.geojson`, or `.json` file directly from your computer. |

- Give the source a short **table alias** (letters, numbers, underscores) — this becomes the SQL table name.
- The file is parsed in-browser and stored in **IndexedDB**, so it persists across page refreshes.
- Local file sources are reloaded from the browser cache on refresh; URL sources are re-fetched from the network.
- Remove an imported source from its entry in the docked dataset tree.
- User-added datasets appear immediately in the docked tree and SQL schema explorer.

### Preloaded Datasets
Four managed datasets are sourced from the [Kentucky Transportation Cabinet TRAK system](https://trak.kytc.ky.gov/), partitioned by district, and cached in IndexedDB:

| Dataset | Description |
|---|---|
| Bridge Condition & Owner Area | Bridge inventory and condition ratings by owner and geographic area |
| Construction Procurement | Awarded construction contracts by district |
| Current Enacted Plan | Current enacted highway plan including funding allocations |
| Program Management Authorized (Detailed) | Detailed authorized dollars including project phases, costs, and schedule |

---

## Project Layout

```
analysis-eda-tool/
├── index.html                          # HTML shell and static/CDN asset wiring
├── css/
│   └── app.css                         # Application styles
├── js/
│   ├── app.js                          # Dashboard UI and application logic
│   ├── chart-engine.mjs                # Chart aggregation, sorting, and ECharts options
│   ├── data-store.mjs                  # Shared IndexedDB database and partition-cache API
│   ├── dataset-loader.mjs              # CSV parsing, partition fetching, and cache coordination
│   ├── share.mjs                       # Pure share-link parsing and serialization
│   └── duckdb.js                       # DuckDB-WASM SQL workbench
├── etl.js                              # Node ETL: downloads CSVs, partitions by district
├── data/
│   ├── raw/                            # Latest raw CSV downloads (overwritten each ETL run)
│   └── report/
│       └── <dataset>/
│           ├── <dataset>-bi-settings.json   # Chart/map configuration for the dataset
│           ├── <dataset>.index.json         # District index (includes generatedAt timestamp)
│           └── <dataset>-District-XX.csv    # Per-district partitioned data
├── .github/workflows/nightly-etl.yml  # Nightly automation: runs ETL and commits results
├── ai-instructions.md                 # Architecture notes for contributors and AI assistants
├── querylake-manifest.json            # Source URLs for external ETL tooling
├── README.md                          # You are here
├── package.json                       # ETL dependencies only (not used by the browser app)
└── node_modules/                      # Local install (ignored when deploying static site)
```

---

## Local Development

### Running the ETL
```bash
npm install          # Install ETL dependencies
npm run etl          # Download source CSVs, partitions, and refresh BI settings
npm test             # Run ETL unit tests
```

The ETL:
1. Downloads fresh source CSVs into `data/raw/`.
2. Reads each raw CSV and partitions records by district.
3. Writes district partition CSVs, the dataset index, and `<dataset>-bi-settings.json` files (including map metadata where applicable) into `data/report/<dataset>/`.

### Serving the App
Serve the repository root with a static server; opening `index.html` as a `file://` URL does not support the app's data fetches:

```bash
npx serve .
# or
python -m http.server 8080
```

No build step is required. The browser app's libraries are loaded from CDN; Node.js dependencies are used by the ETL and its tests.

---

## Adding / Removing Managed Datasets

1. Add a new entry to the `DATASETS` array in `js/app.js` (id, title, description), matching the folder name under `data/report/`.
2. Add the corresponding ETL configuration in `etl.js`.
3. Run `node etl.js` to generate the partitioned data files.

---

## Deployment

### GitHub Pages
- Set the Pages source to the repository root on the desired branch.
- Commit `index.html` and the generated `data/report/` directory — no build step needed.
- The nightly workflow keeps `data/` up to date automatically.

### Any Static Host
Drop the repository root onto any static file host (Netlify, S3, Azure Static Web Apps, etc.). No server-side processing is required.

---

## Nightly Automation

- **Workflow:** `.github/workflows/nightly-etl.yml`
- Runs daily at ~05:15 UTC (12:10 AM US Eastern).
- Checks out the repo, installs Node, runs `node etl.js`, and commits any changes inside `data/`.
- Trigger manually via the **Run workflow** button in the GitHub Actions UI for an immediate refresh.

---

## CDN Libraries Used

| Library | Version | Purpose |
|---|---|---|
| Bootstrap | 5.3.8 | Layout and UI components |
| Bootstrap Icons | 1.13.2 | Icon font |
| Apache ECharts | 6.1.0 | Bar and pie charts |
| Tabulator | 6.7.1 | Data table with filters and sorting |
| Leaflet | 1.9.4 | Interactive map |
| Leaflet.MarkerCluster | 1.5.3 | Map marker clustering |
| DuckDB-WASM | 1.32.0 | In-browser SQL engine |
| IBM Plex Mono | — | Monospace font for code/SQL areas |

---

## Contributing

- Update `ai-instructions.md` with any technical decisions that future contributors or AI assistants should know.
- Keep ETL output under version control so GitHub Pages stays in sync.
- Open issues or PRs for new dataset integrations, UI improvements, or automation tweaks.

---

## Estimated Manual Development Effort

The estimates below are meant to answer a practical question: how long would this same application likely take to build without AI doing the implementation work?

These estimates were developed by AI as a reasoned approximation based on the application's current feature set and integration complexity.

At the time of writing, this project has involved approximately 10 hours of human effort spent prompting, directing, testing, and reviewing AI-generated implementation. This figure is expected to be updated as development continues.

These ranges assume a single developer is building the current feature set from scratch, including UI work, library integration, debugging, state management, browser storage, and deployment setup.

### Estimated Total Hours

| Developer level | Estimated hours |
|---|---:|
| Beginner | 180-320 |
| Intermediate | 70-140 |
| Senior | 35-80 |

### Feature-by-Feature Estimate

| Feature area | Beginner | Intermediate | Senior |
|---|---:|---:|---:|
| Base single-page app shell, layout, and control wiring | 20-35 | 8-16 | 4-8 |
| Charting with multiple modes and aggregation logic | 28-45 | 12-22 | 6-12 |
| Data table integration, filtering, paging, and CSV export | 16-28 | 7-14 | 4-8 |
| Map view, clustering, popup configuration, and filters | 22-38 | 10-18 | 5-10 |
| DuckDB-WASM SQL workbench and query result rendering | 30-55 | 14-28 | 8-16 |
| IndexedDB caching and persistence for managed and user datasets | 20-36 | 8-18 | 5-10 |
| User data import flow for URL and local files | 16-30 | 8-16 | 4-8 |
| Dataset catalog and schema inspection | 14-24 | 6-12 | 3-6 |
| URL share-state support and live URL syncing | 8-16 | 3-6 | 2-4 |
| ETL scripting, dataset metadata, and deployment automation | 14-24 | 6-12 | 3-6 |
| Integration debugging, browser edge cases, and final polish | 24-45 | 10-22 | 6-12 |

### Interpreting the Estimate

- The app is small in footprint but not small in integration complexity.
- The real effort is not HTML or JavaScript syntax; it is making ECharts, Leaflet, Tabulator, DuckDB-WASM, IndexedDB, CSV parsing, and state synchronization work together cleanly.
- The senior estimate is much lower because most of the time savings come from architectural judgment and faster debugging, not from typing speed.
- The ranges are intentionally broad because a large share of the effort depends on how much time is lost to integration bugs, async timing issues, and browser-specific behavior.
