# Exploratory Data Analysis Tool (trak_eda)

This project is a browser-based EDA (Exploratory Data Analysis) tool for partitioned, large-scale datasets. It is designed for easy deployment on GitHub Pages and for contributors to quickly understand and navigate the repo.

## Project Structure

```
trak_eda/
├── data/                # (Optional, not published) Raw data, ETL cache, or scripts
│   └── raw/             # Raw downloaded CSVs (not needed for GitHub Pages)
├── public/              # All static assets for the website (this is the root for GitHub Pages)
│   ├── etl/             # Partitioned CSVs, index, and settings files (used by the web app)
│   ├── main.js          # (If not inlined in HTML) Main JS for the app
│   ├── style.css        # (If not inlined in HTML) Main CSS for the app
│   └── index.html       # Main entry point for the web app
├── etl.js               # Node.js ETL script (not published to GitHub Pages)
├── README.md            # Project overview and instructions
├── ai-instructions.md   # AI and developer instructions
└── ...                  # Other docs, configs, or examples
```

### What gets published to GitHub Pages?
- **Only the contents of the `public/` folder** are published and served by GitHub Pages.
- All web assets (HTML, JS, CSS, partitioned data, settings, index files) must be in `public/`.
- The ETL script, raw data, and developer docs are for contributors and are not published.

## Contributor Navigation
- **`public/`**: Everything the web app needs to run on GitHub Pages. Edit here for UI, data, and settings changes.
- **`etl.js`**: Run this Node.js script locally to download, partition, and index datasets. It writes output to `public/etl/`.
- **`data/raw/`**: Used for local ETL caching; not needed for the deployed site.
- **`README.md` and `ai-instructions.md`**: Start here for project overview, setup, and development/contribution guidelines.

## Getting Started
1. Clone the repo.
2. Run `npm install` to install dependencies (for ETL only).
3. Run `node etl.js` to download and partition datasets (writes to `public/etl/`).
4. Edit `public/index.html` and other files in `public/` as needed.
5. Push changes to GitHub. GitHub Pages will serve from the `public/` folder.

## Deployment
- Configure GitHub Pages to serve from the `public/` folder (or move its contents to the root if preferred).
- All static assets and partitioned data must be in `public/` for the web app to work.

## Notes
- Do not put sensitive or large raw data in the repo; only partitioned, public-ready data goes in `public/etl/`.
- Keep the folder structure clear and descriptive for new contributors.

---

For more details on development, see `ai-instructions.md`.
