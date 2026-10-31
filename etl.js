// ETL Script: downloads raw CSVs, generates Parquet copies, and rebuilds district reports.
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
    name: 'eda_awarded_projects',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/eda_awarded_projects.csv',
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
    name: 'eda_expenditures',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/eda_expenditures.csv',
  },
  {
    name: 'eda_programmanagement_authorized_detailed',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/eda_programmanagement_authorized_detailed.csv',
  },
  {
    name: 'export-bi-agency-construction-change-orders-dataview',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/export-bi-agency-construction-change-orders-dataview.csv',
  },
  {
    name: 'export-bi-agency-constructionprocurement-altdelivery-dataview',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/export-bi-agency-constructionprocurement-altdelivery-dataview.csv',
  },
  {
    name: 'export-bi-agency-constructionprocurement-dataview',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/export-bi-agency-constructionprocurement-dataview.csv',
  },
  {
    name: 'export-bi-agency-maintenance-roadwayweather-machinehours-dataview',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/export-bi-agency-maintenance-roadwayweather-machinehours-dataview.csv',
  },
  {
    name: 'export-bi-agency-toc-roadwayweather-roadwayreport-dataview',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/export-bi-agency-toc-roadwayweather-roadwayreport-dataview.csv',
  },
  {
    name: 'export-bi-analysis-planning-systemmobility-dataview',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/export-bi-analysis-planning-systemmobility-dataview.csv',
  },
  {
    name: 'export-bi-analysis-programmanagement-cost-change-dataview',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/export-bi-analysis-programmanagement-cost-change-dataview.csv',
  },
  {
    name: 'export-bi-analysis-roadwayweatherevents-expenditures-dataview',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/export-bi-analysis-roadwayweatherevents-expenditures-dataview.csv',
  },
  {
    name: 'export-bi-economic-fueltyperegistration-dataview',
    url: 'https://storage.googleapis.com/kytc-trak/data_hub_csv/export-bi-economic-fueltyperegistration-dataview.csv',
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
    const districtNumber = Number.parseInt(districtMatch[1], 10);
    return districtNumber >= 1 && districtNumber <= 12
      ? String(districtNumber).padStart(2, '0')
      : 'Various';
  }

  return 'Various';
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

function sqlString(value) {
  const duckDBPath = path.resolve(value).replace(/\\/g, '/');
  return `'${duckDBPath.replace(/'/g, "''")}'`;
}

async function writeParquetFile(connection, csvPath, parquetPath) {
  await fs.ensureDir(path.dirname(parquetPath));
  await fs.remove(parquetPath);

  const result = await connection.run(
    `COPY (SELECT * FROM read_csv_auto(${sqlString(csvPath)}, header=true)) `
    + `TO ${sqlString(parquetPath)} (FORMAT PARQUET, COMPRESSION ZSTD);`
  );
  result.closeSync();

  const { size } = await fs.stat(parquetPath);
  if (!size) throw new Error(`DuckDB wrote an empty Parquet file: ${parquetPath}`);
  return size;
}

async function main() {
  const rawDir = path.join(__dirname, 'data', 'raw');
  const parquetDir = path.join(__dirname, 'data', 'parquet');
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

  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  let connection;
  try {
    connection = await instance.connect();

    // Generate Parquet copies and rebuild district reports.
    for (const ds of DATASETS) {
      const rawPath = path.join(rawDir, `${ds.name}.csv`);
      const parquetPath = path.join(parquetDir, `${ds.name}.parquet`);
      const outDir = path.join(__dirname, 'data', 'report', ds.name);
      await fs.ensureDir(outDir);

      const csvText = await fs.readFile(rawPath, 'utf8');
      const records = parse(csvText, { columns: true });
      const sample = records[0] || {};
      const totalRecords = records.length;

      await writePartitionFiles(ds.name, records, outDir);
      const parquetBytes = await writeParquetFile(connection, rawPath, parquetPath);

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
      console.log(`[ETL INFO] ${ds.name}: wrote partitions and BI settings (${totalRecords} records); Parquet ${parquetBytes} bytes.`);
    }
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { main, normalizeDistrict, writePartitionFiles, writeParquetFile };
