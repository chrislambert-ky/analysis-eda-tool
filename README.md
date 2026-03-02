# Exploratory Data Analysis Tool

A single-page, fully in-browser exploratory data analysis tool built with vanilla HTML/CSS/JS and CDN libraries. Datasets are pre-partitioned by district so the UI loads data incrementally and caches it in IndexedDB. No server, no build step, no data ever leaves your browser.

**Live app:** https://chrislambert-ky.github.io/analysis-eda-tool/  
**Repository:** https://github.com/chrislambert-ky/analysis-eda-tool

---

## Features

### Visualisation & Table
- **Chart types:** Horizontal Bar, Vertical Bar, Pie, and interactive Map (Leaflet + MarkerCluster).
- **Controls:** Dimension, Metric, Aggregation, Split By, Order By, and Order Direction selectors update the chart instantly.
- **Data Table:** Tabulator-powered table with per-column header filters, horizontal scroll, and consistent column widths.
- **Download:** Export the full dataset or the currently filtered rows to CSV.
- **Chart filter:** Clicking a chart series/segment filters the table to matching rows; a badge shows the active filter with a one-click clear.
- **Map options:** Clustering (on by default), district/county filter, and color-by-field controls appear automatically when a dataset has map configuration. Selecting a specific district or county temporarily disables clustering.

### SQL Workbench
- **In-browser SQL** powered by [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview.html) — no backend required.
- Write and run arbitrary SQL against any combination of managed and user-added datasets.
- Editor with line numbers, resizable panes, and `Ctrl+Enter` to run.
- Results render in a scrollable table with row count and execution time.
- Export query results to CSV with the **downarrow CSV** button.
- DuckDB is initialised lazily — the WASM bundle is only downloaded when the SQL tab is first opened.

### Adding Your Own Data (SQL tab only)
The **+ Add** button in the SQL Data Sources panel (visible only on the SQL tab) lets you bring in your own data:

| Option | How it works |
|---|---|
| **From URL** | Point to a publicly accessible `.csv` or `.parquet` file. The file must allow CORS. |
| **Local File** | Upload a `.csv` or `.parquet` file directly from your computer. |

- Give the source a short **table alias** (letters, numbers, underscores) — this becomes the SQL table name.
- The file is parsed in-browser and stored in **IndexedDB**, so it persists across page refreshes.
- Local file sources are reloaded from the browser cache on refresh; URL sources are re-fetched from the network.
- Remove a source by clicking the **x** next to it in the SQL sidebar.

### Preloaded Datasets
Four managed datasets are partitioned by district and cached in IndexedDB:

| Dataset | Description |
|---|---|
| Bridge Condition & Owner Area | Asset condition ratings by owner and area |
| Construction Procurement | Active and planned construction contracts |
| Current Enacted Plan | Current program-year enacted plan data |
| Program Management Authorized | Detailed authorized program management data |

Use the **Refresh Cache** button to pull the latest version of any managed dataset from the server.

---

## Project Layout

```
analysis-eda-tool/
├── index.html                          # Entire UI — all JS/CSS inline, CDN assets only
├── etl.js                              # Node ETL: downloads CSVs, partitions by district
├── data/
│   ├── raw/                            # Latest raw CSV downloads (overwritten each ETL run)
│   └── report/
│       └── <dataset>/
│           ├── <dataset>-bi-settings.json   # Chart/map configuration for the dataset
│           ├── <dataset>.index.json         # District index consumed by the UI
│           └── <dataset>-District-XX.csv    # Per-district partitioned data
├── .github/workflows/nightly-etl.yml  # Nightly automation: runs ETL and commits results
├── ai-instructions.md                 # Architecture notes for contributors and AI assistants
├── README.md                          # You are here
├── package.json                       # ETL dependencies only (not used by the browser app)
└── node_modules/                      # Local install (ignored when deploying static site)
```

---

## Local Development

### Running the ETL
```bash
npm install          # Install ETL dependencies (csv-parse, csv-stringify, node-fetch, etc.)
node etl.js          # Download source CSVs, partition by district, write data/report/
```

The ETL:
1. Downloads fresh source CSVs into `data/raw/`.
2. Filters and partitions rows into `data/report/<dataset>/`.
3. Writes `<dataset>.index.json` and `<dataset>-bi-settings.json` (including map metadata where applicable).

### Serving the App
Open `index.html` directly in a browser, or serve the repo root with any static server:

```bash
npx serve .
# or
python -m http.server 8080
```

No build step is required. The browser app has no Node.js dependencies — all libraries are loaded from CDN.

---

## Adding / Removing Managed Datasets

1. Add a new entry to the `DATASETS` array in `index.html`, matching the folder name under `data/report/`.
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

| Library | Purpose |
|---|---|
| Bootstrap 5.3 | Layout and UI components |
| Bootstrap Icons 1.11 | Icon font |
| Apache ECharts 5 | Bar and Pie charts |
| Tabulator 5.5 | Data table with filters and sorting |
| Leaflet 1.9 + MarkerCluster 1.5 | Interactive map and clustering |
| DuckDB-WASM 1.29 | In-browser SQL engine |
| IBM Plex Mono | Monospace font for code/SQL areas |

---

## Contributing

- Update `ai-instructions.md` with any technical decisions that future contributors or AI assistants should know.
- Keep ETL output under version control so GitHub Pages stays in sync.
- Open issues or PRs for new dataset integrations, UI improvements, or automation tweaks.
