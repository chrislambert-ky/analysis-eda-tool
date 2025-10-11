# AI & Developer Instructions for trak_eda

## 1. Project Overview
- Browser-based EDA tool for partitioned, large-scale datasets (transportation, infrastructure, etc.)
- Uses IndexedDB for local, per-district caching and incremental loading
- Visualizes data with Apache ECharts, Tabulator, and Leaflet

## 2. Coding Standards
- Use modern JavaScript (ES6+)
- Prefer async/await for all async operations
- Write clear, concise comments for complex logic
- Use modular, maintainable code (split ETL, UI, and data logic)

## 3. ETL & Partitioning
- Download raw CSVs from public sources (see below)
- Partition each dataset by DISTRICT (13 partitions: 01-12, Various)
- Store partitioned files as `{dataset}-District-XX.csv` in `public/etl/{dataset}/`
- Generate `{dataset}.index.json` (record counts per partition) and `{dataset}.settings.json` (BI config)

### Data Sources
- https://storage.googleapis.com/kytc-trak/data_hub_csv/eda_assets_bridge_condition_owner_area.csv
- https://storage.googleapis.com/kytc-trak/data_hub_csv/eda_construction_procurement.csv
- https://storage.googleapis.com/kytc-trak/data_hub_csv/eda_current_enact_plan_data_set.csv
- https://storage.googleapis.com/kytc-trak/data_hub_csv/eda_programmanagement_authorized_detailed.csv

## 4. Data Model & Settings
- Each dataset folder contains:
  - Partitioned CSVs by district
  - `{dataset}.index.json` (partition record counts, file paths)
  - `{dataset}.settings.json` (dimensions, metrics, aggregation, map config)
- Settings file defines:
  - Dimensions (fields for grouping)
  - Metrics (fields for aggregation)
  - Aggregation types (count, sum, min, avg)
  - Order by options
  - Map config (if applicable)

## 5. Incremental Loading & Caching (IndexedDB)
- On load, compare per-district record counts in index vs. IndexedDB
- Only fetch and store missing or outdated partitions
- Data is loaded incrementally, per district, into IndexedDB object stores/keys
- Table/chart should only render from IndexedDB
- UI should show progress as each partition loads
- User can interact with the app while background loading continues

## 6. User Interface & Visualization
- Use Apache ECharts for all charts (bar, pie, etc.)
- Use Tabulator for table views (with filtering, download)
- Use Leaflet for map visualizations (if enabled in settings)
- UI: Plain HTML/CSS/JS + Bootstrap (no frameworks)
- All controls are populated dynamically from settings

### Screen Layout Diagram

```
Title
Subtitle
---------------------------------------------------------------
| Dataset dropdown | Chart Selection buttons: [Bar][Pie][Map] |
---------------------------------------------------------------
|                  | User selection dropdowns:                |
|   75% of area    |  - Dimension                             |
|                  |  - Metric                                |
|  Apache ECHART   |  - Aggregation Type                      |
|  (Default:       |  - Split by                              |
|  Horizontal Bar) |  - Order By                              |
|                  |                25% of area               |
---------------------------------------------------------------
| Table view of the data with filters on the top              |
---------------------------------------------------------------
| Download options: Full Dataset | Filtered Dataset            |
---------------------------------------------------------------
```

- The chart area uses Apache ECharts (and Leaflet for map-enabled datasets).
- The table view supports filtering and download options.
- All controls are populated dynamically based on the selected dataset's settings file.

## 7. Testing & Validation
- Validate ETL output: partition counts, index, and settings
- Validate IndexedDB cache matches index counts
- Test UI: filtering, charting, map, and download features
- Test incremental loading and progress UI


## 8. TODOs for Development Plan
- [ ] Write/validate ETL script for partitioning and index/settings generation
- [ ] Implement robust IndexedDB per-district caching and validation logic
- [ ] Build UI: dataset selection, chart/table/map, progress indicator
- [ ] Implement incremental loading with UI progress and background updates
- [ ] Add download/export options for full/filtered datasets
- [ ] Write tests for ETL, data loading, and UI features
- [ ] Document all code and update this file as features are added

## 9. Design Decisions
- **ETL Script:** Must be written as a separate JavaScript file (e.g., `src/etl/etl.js`).
- **Web UI:** All CSS and JavaScript for the browser-based app must be embedded directly in the HTML file (e.g., `public/index.html`).
  - No external `.js` or `.css` files for the UI—everything should be self-contained within the HTML.
  - This is a deliberate choice for portability and ease of distribution, even though it is contrary to common best practices.

- Document this decision in all onboarding and planning materials.
