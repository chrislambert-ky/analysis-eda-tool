# Exploratory Data Analysis Tool

A single-page, browser-based exploratory data analysis experience built with vanilla HTML/CSS/JS plus CDN libraries (Bootstrap, Apache ECharts, Tabulator, Leaflet, Leaflet MarkerCluster). Datasets are pre-partitioned by district so the UI can load data incrementally and cache it in IndexedDB.

## Current Features
- Inline web app (`index.html`) served from the repository root (ideal for GitHub Pages).
- Node.js ETL script (`etl.js`) that downloads the latest source CSVs, filters row values to valid districts, and writes per-district partitions under `data/report/` along with index + BI settings.
- IndexedDB caching, progress feedback, chart/table/map toggles, and download helpers for full or filtered rows.
- Map-specific controls (clustering, district/county filter, color by field) that activate automatically when a dataset supports map output.
- GitHub Actions workflow (`.github/workflows/nightly-etl.yml`) that re-runs the ETL nightly and pushes refreshed data back to the repo.

## Project Layout
```
analysis-eda-tool/
├── index.html                 # Entire UI (inline JS/CSS via CDN assets)
├── etl.js                     # Node ETL that regenerates data/report outputs
├── data/
│   ├── raw/                   # Latest raw CSV downloads (overwritten each ETL run)
│   └── report/                # Partitioned CSVs + index/settings JSON consumed by the UI
├── .github/workflows/nightly-etl.yml  # Nightly automation that runs ETL + commits results
├── ai-instructions.md         # Working doc describing architecture and expectations
├── README.md                  # You are here
├── package.json / lock        # ETL dependencies (csv-parse, csv-stringify, node-fetch, etc.)
├── node_modules/              # Local dependency install (ignored when deploying static site)
└── ...                        # Misc (css/, js/, settings.json, etc. not required for the app)
```

## Local Setup
1. `npm install` (installs ETL dependencies only).
2. `node etl.js`
	- Downloads fresh source CSVs into `data/raw/`.
	- Filters/partitions rows written to `data/report/<dataset>/`.
	- Generates `<dataset>.index.json` and `<dataset>-bi-settings.json`, including map metadata where applicable.
3. Open `index.html` directly in the browser (or serve via a simple static server) to work offline.

## UI Notes
- The dataset dropdown seeds from `DATASETS` defined in `index.html`. Add or remove entries there, matching folder names under `data/report/`.
- Cached partitions are stored by key `dataset|district` in IndexedDB. Use the “Refresh Cache” button to clear the current dataset when the underlying files change.
- Chart legend auto-hides when a split produces more than 13 series to keep the layout readable.
- Map view is only enabled when the dataset’s BI settings include map configuration. Selecting “Map” hides the general chart controls and shows the map options panel (clustering, district, county, color).
- Map clustering defaults to on. Choosing a specific district or county temporarily disables clustering; returning to “All Districts” re-enables it.
- Table view uses Tabulator with horizontal scroll and maintains consistent column widths. Downloads respect filters by reading the active rows.

## Deployment (GitHub Pages or Any Static Host)
- Commit `index.html` and the generated `data/report/` directory alongside this README.
- For GitHub Pages, set the Pages source to the repository root on the desired branch. No build step is required because the app is fully static.
- The nightly workflow pushes updated `data/` content each day shortly after 12:10 AM US Eastern (05:15 UTC). Ensure Actions have permission to push to your branch.

## Nightly Automation
- Workflow file: `.github/workflows/nightly-etl.yml`.
- Actions job checks out the repo, installs Node, runs `node etl.js`, and commits any changes inside `data/`.
- You can trigger it manually via the “Run workflow” button in GitHub UI if you need a mid-day refresh.

## Contributing
- Update `ai-instructions.md` with any technical decisions that future contributors or AI assistants should know.
- Keep ETL output under version control so GitHub Pages stays in sync.
- Open issues or PRs for new dataset integrations, UI improvements, or automation tweaks.

For detailed build guidance and design decisions, see `ai-instructions.md`.
