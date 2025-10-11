// ETL Script for trak_eda: downloads CSVs, partitions by district, writes output to public/etl/{dataset}/
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

const DISTRICTS = [
  '01','02','03','04','05','06','07','08','09','10','11','12','Various'
];

async function main() {
  const rawDir = path.join(__dirname, 'data', 'raw');
  await fs.ensureDir(rawDir);

  for (const ds of DATASETS) {
    const rawPath = path.join(rawDir, `${ds.name}.csv`);
    console.log(`Downloading ${ds.url} ...`);
    const res = await fetch(ds.url);
    if (!res.ok) throw new Error(`Failed to download: ${ds.url}`);
    const text = await res.text();
    await fs.writeFile(rawPath, text);
    console.log(`Saved to ${rawPath}`);
  }

  // Partition, index, and BI settings generation
  for (const ds of DATASETS) {
    const rawPath = path.join(rawDir, `${ds.name}.csv`);
    const outDir = path.join(__dirname, 'data', 'report', ds.name);
  await fs.ensureDir(outDir);
  await fs.emptyDir(outDir);
    const csvText = await fs.readFile(rawPath, 'utf8');
    const records = parse(csvText, { columns: true });
  const headers = records.length ? Object.keys(records[0]) : [];

    // Partition by district
    const byDistrict = {};
    for (const d of DISTRICTS) byDistrict[d] = [];

  let processedCount = 0;
  let skippedCount = 0;
  const skippedSamples = [];
    let sampleRow = null;

    records.forEach((row, idx) => {
      const rawDistrict = (row.DISTRICT || '').trim();
      let districtKey = null;
      let districtLabel = null;

      const match = rawDistrict.match(/^district\s*(\d{1,2})$/i);
      if (match) {
        const padded = match[1].padStart(2, '0');
        districtKey = padded;
        districtLabel = `District ${padded}`;
      } else if (/^Various$/i.test(rawDistrict)) {
        districtKey = 'Various';
        districtLabel = 'Various';
      }

      const isValid = districtKey && DISTRICTS.includes(districtKey);

      if (!isValid) {
        skippedCount += 1;
        if (skippedSamples.length < 5) {
          skippedSamples.push(rawDistrict || '(empty)');
        }
        return;
      }

      row.DISTRICT = districtLabel;
      byDistrict[districtKey].push(row);
      processedCount += 1;
      if (!sampleRow) sampleRow = row;
      if (idx < 10) {
        console.log(`[ETL DEBUG] Row ${idx}: DISTRICT raw='${rawDistrict}' normalized='${districtLabel}'`);
      }
    });

    // Write partitioned CSVs
    for (const d of DISTRICTS) {
      const partPath = path.join(outDir, `${ds.name}-District-${d}.csv`);
      const partitionRecords = byDistrict[d];
      // Ensure CSV values with commas/newlines are quoted correctly.
      const csvContent = stringify(partitionRecords, {
        columns: headers,
        header: true,
      });
      await fs.writeFile(partPath, csvContent);
      // Debug: print partition counts
      console.log(`[ETL DEBUG] Partition ${d}: ${byDistrict[d].length} records`);
    }


    // Write index.json
    const index = { totalRecords: processedCount };
    for (const d of DISTRICTS) {
      index[`${ds.name}-District-${d}.csv`] = { records: byDistrict[d].length };
    }
    await fs.writeJson(path.join(outDir, `${ds.name}.index.json`), index, { spaces: 2 });

    // Write BI settings file
    const sample = sampleRow || records[0] || {};
    const settings = {
      datasetName: ds.name,
      indexFile: `${ds.name}.index.json`,
      dimensions: Object.keys(sample).filter(k => k.toUpperCase() === 'DISTRICT' || k.toUpperCase() === 'COUNTY'),
      metrics: ['Dataset Records'],
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
    console.log(`Wrote partitions, index, and BI settings for ${ds.name}`);
    if (skippedCount > 0) {
      console.log(`[ETL INFO] ${ds.name}: processed ${processedCount} records, skipped ${skippedCount} invalid district values (examples: ${skippedSamples.join(', ')})`);
    } else {
      console.log(`[ETL INFO] ${ds.name}: processed ${processedCount} records, skipped 0 invalid district values`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });

