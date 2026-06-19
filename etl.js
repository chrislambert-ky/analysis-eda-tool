// ETL Script for analysis-eda-tool: downloads raw CSVs, rebuilds district partitions,
// and writes BI settings JSON for the hosted app.
// Usage: node etl.js

const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

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

const EXPECTED_DISTRICTS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', 'Various'];

function normalizeDistrict(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'Various';

  const lower = raw.toLowerCase();
  if (lower === 'various' || lower === 'district various' || lower === 'district var') {
    return 'Various';
  }

  const districtMatch = raw.match(/district\s*0?(\d{1,2})/i) || raw.match(/^(\d{1,2})$/);
  if (districtMatch) {
    return String(Number.parseInt(districtMatch[1], 10)).padStart(2, '0');
  }

  return raw.replace(/\s+/g, ' ');
}

async function writePartitionFiles(datasetName, records, outDir) {
  await fs.ensureDir(outDir);

  const existingPartitionFiles = (await fs.readdir(outDir))
    .filter(name => name.startsWith(`${datasetName}-District-`) && name.endsWith('.csv'));
  for (const fileName of existingPartitionFiles) {
    await fs.remove(path.join(outDir, fileName));
  }

  const headers = records.length ? Object.keys(records[0]) : [];
  const partitions = new Map();

  for (const record of records) {
    const district = normalizeDistrict(record.DISTRICT ?? record.district ?? '');
    if (!partitions.has(district)) {
      partitions.set(district, []);
    }
    partitions.get(district).push(record);
  }

  const index = { totalRecords: records.length };

  for (const district of EXPECTED_DISTRICTS) {
    const rows = partitions.get(district) || [];
    const fileName = `${datasetName}-District-${district}.csv`;
    const csvText = stringify(rows, {
      header: true,
      columns: headers,
      quoted: true,
      quoted_empty: true,
    });
    await fs.writeFile(path.join(outDir, fileName), csvText);
    index[fileName] = { records: rows.length };
  }

  await fs.writeJson(path.join(outDir, `${datasetName}.index.json`), index, { spaces: 2 });
  return index;
}

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

  // Rebuild district partitions and write BI settings JSON
  for (const ds of DATASETS) {
    const rawPath = path.join(rawDir, `${ds.name}.csv`);
    const outDir = path.join(__dirname, 'data', 'report', ds.name);
    await fs.ensureDir(outDir);

    const csvText = await fs.readFile(rawPath, 'utf8');
    const records = parse(csvText, { columns: true });
    const sample = records[0] || {};
    const totalRecords = records.length;

    await writePartitionFiles(ds.name, records, outDir);

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
    console.log(`[ETL INFO] ${ds.name}: wrote partitions and BI settings (${totalRecords} records).`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { main, normalizeDistrict, writePartitionFiles };

