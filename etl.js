// ETL Script for analysis-eda-tool: downloads raw CSVs and writes BI settings JSON.
// Partition CSV generation removed (Phase 1.6) — DuckDB reads raw CSVs directly.
// Usage: node etl.js

const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { parse } = require('csv-parse/sync');

const DATASETS = [
  {
    name: 'eda_assets_bridge_condition_owner_area',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/eda_assets_bridge_condition_owner_area.csv',
  },
  {
    name: 'eda_construction_procurement',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/eda_construction_procurement.csv',
  },
  {
    name: 'eda_current_enact_plan_data_set',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/eda_current_enact_plan_data_set.csv',
  },
  {
    name: 'eda_programmanagement_authorized_detailed',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/eda_programmanagement_authorized_detailed.csv',
  },
];

async function main() {
  const rawDir = path.join(__dirname, 'data', 'raw');
  await fs.ensureDir(rawDir);

  // Download raw CSVs
  for (const ds of DATASETS) {
    const rawPath = path.join(rawDir, `${ds.name}.csv`);
    console.log(`Downloading ${ds.url} ...`);
    const res = await fetch(ds.url);
    if (!res.ok) throw new Error(`Failed to download: ${ds.url}`);
    const text = await res.text();
    await fs.writeFile(rawPath, text);
    console.log(`Saved to ${rawPath}`);
  }

  // Write BI settings JSON — one file per dataset, no partition splitting
  for (const ds of DATASETS) {
    const rawPath = path.join(rawDir, `${ds.name}.csv`);
    const outDir = path.join(__dirname, 'data', 'report', ds.name);
    await fs.ensureDir(outDir);

    const csvText = await fs.readFile(rawPath, 'utf8');
    const records = parse(csvText, { columns: true });
    const sample = records[0] || {};
    const totalRecords = records.length;

    const settings = {
      datasetName: ds.name,
      totalRecords,
      dimensions: Object.keys(sample).filter(k => k.toUpperCase() === 'DISTRICT' || k.toUpperCase() === 'COUNTY'),
      metrics: ['Record Count'],
      aggregationTypes: ['Count'],
      orderBy: ['Dimension', 'Metric Agg Result'],
      order: ['Ascending', 'Descending'],
    };

    if ('LATITUDE' in sample && 'LONGITUDE' in sample) {
      settings.map = { latitudeField: 'LATITUDE', longitudeField: 'LONGITUDE' };
      if (ds.name === 'eda_assets_bridge_condition_owner_area') {
        settings.map.clusterDefault = true;
        settings.map.districtField = 'DISTRICT';
        settings.map.countyField = 'COUNTY';
        settings.map.defaultColorField = 'GFP';
        settings.map.colorFieldOptions = [
          'GFP',
          'OWNERSHIP',
          'OWNER',
          'LOAD_RATING_AGENCY',
          'NHS'
        ];
      }
    }

    await fs.writeJson(path.join(outDir, `${ds.name}-bi-settings.json`), settings, { spaces: 2 });
    console.log(`[ETL INFO] ${ds.name}: wrote BI settings (${totalRecords} records).`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

