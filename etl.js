// ETL Script: downloads raw CSVs, generates Parquet copies, and rebuilds district reports.
// Usage: node etl.js

const fetch = require('node-fetch');
const fs = require('fs-extra');
const fsNative = require('node:fs');
const path = require('path');
const { pipeline } = require('node:stream/promises');
const { parse: parseSync } = require('csv-parse/sync');
const { parse: parseStream } = require('csv-parse');

function parseDataSources(csvText) {
  let headers = [];
  const rows = parseSync(csvText, {
    columns: header => {
      headers = header;
      return header;
    },
    skip_empty_lines: true,
    bom: true,
    trim: true
  });
  const requiredColumns = ['name', 'label', 'description', 'csv_public_url'];
  const missingColumns = requiredColumns.filter(column => !headers.includes(column));
  if (missingColumns.length) {
    throw new Error(`Data source manifest is missing columns: ${missingColumns.join(', ')}`);
  }
  if (!rows.length) throw new Error('Data source manifest contains no sources.');

  const names = new Set();
  return rows.map((row, index) => {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(row.name)) {
      throw new Error(`Invalid data source name on row ${index + 2}: ${row.name}`);
    }
    if (names.has(row.name)) throw new Error(`Duplicate data source name: ${row.name}`);
    names.add(row.name);

    const urls = {};
    for (const [column, extension] of [
      ['csv_public_url', '.csv'],
      ['parquet_public_url', '.parquet']
    ]) {
      if (column === 'parquet_public_url' && !String(row[column] ?? '').trim()) continue;
      let url;
      try {
        url = new URL(row[column]);
      } catch {
        throw new Error(`Invalid ${column} on row ${index + 2}: ${row[column]}`);
      }
      if (url.protocol !== 'https:' || !url.pathname.endsWith(extension)) {
        throw new Error(`Expected an HTTPS ${extension} URL for ${row.name}: ${row[column]}`);
      }
      urls[column] = row[column];
    }
    let dashboardLocation = null;
    if (String(row.dashboard_location ?? '').trim()) {
      try {
        dashboardLocation = new URL(row.dashboard_location).href;
      } catch {
        throw new Error(`Invalid dashboard_location on row ${index + 2}: ${row.dashboard_location}`);
      }
      if (!dashboardLocation.startsWith('https://')) {
        throw new Error(`Expected an HTTPS dashboard URL for ${row.name}: ${row.dashboard_location}`);
      }
    }
    if (!String(row.label ?? '').trim()) {
      throw new Error(`Missing label on row ${index + 2} for ${row.name}`);
    }
    if (!String(row.description ?? '').trim()) {
      throw new Error(`Missing description on row ${index + 2} for ${row.name}`);
    }
    return {
      name: row.name,
      label: row.label.trim(),
      description: row.description.trim(),
      csvUrl: urls.csv_public_url,
      parquetUrl: urls.parquet_public_url || null,
      dashboardLocation
    };
  });
}

async function downloadFile(url, outputPath) {
  const temporaryPath = `${outputPath}.download`;
  await fs.ensureDir(path.dirname(outputPath));
  await fs.remove(temporaryPath);
  try {
    const response = await fetch(url, { timeout: 120_000 });
    if (!response.ok) throw new Error(`Failed to download ${url} (${response.status})`);
    await pipeline(response.body, fsNative.createWriteStream(temporaryPath));
    const { size } = await fs.stat(temporaryPath);
    if (!size) throw new Error(`Downloaded an empty file from ${url}`);
    await fs.move(temporaryPath, outputPath, { overwrite: true });
    return size;
  } catch (error) {
    await fs.remove(temporaryPath);
    throw error;
  }
}

async function downloadDataSources(sources, rawDir, parquetDir) {
  for (const source of sources) {
    const csvPath = path.join(rawDir, `${source.name}.csv`);
    const parquetPath = path.join(parquetDir, `${source.name}.parquet`);
    const csvBytes = await downloadFile(source.csvUrl, csvPath);
    const parquetBytes = source.parquetUrl
      ? await downloadFile(source.parquetUrl, parquetPath)
      : null;
    const parquetInfo = parquetBytes === null ? 'no published Parquet URL' : `Parquet ${parquetBytes} bytes`;
    console.log(`[SOURCE INFO] ${source.name}: downloaded CSV ${csvBytes} bytes; ${parquetInfo}.`);
  }
}

async function readCsvMetadata(csvPath) {
  let headers = [];
  let totalRecords = 0;
  const parser = fsNative.createReadStream(csvPath).pipe(parseStream({
    columns: rowHeaders => {
      headers = rowHeaders;
      return rowHeaders;
    },
    skip_empty_lines: true,
    bom: true
  }));
  for await (const record of parser) {
    totalRecords += 1;
  }
  if (!headers.length) throw new Error(`CSV has no header row: ${csvPath}`);
  return { headers, totalRecords };
}

async function validateParquetFile(connection, parquetPath, expectedRecords, expectedColumns) {
  const schemaResult = await connection.runAndReadAll(
    `DESCRIBE SELECT * FROM read_parquet(${sqlString(parquetPath)})`
  );
  let columns;
  try {
    columns = schemaResult.getRows().map(row => String(row[0]));
  } finally {
    schemaResult.closeSync();
  }
  if (columns.length !== expectedColumns.length
    || expectedColumns.some(column => !columns.includes(column))) {
    throw new Error(`Parquet schema does not match its CSV: ${parquetPath}`);
  }

  const countResult = await connection.runAndReadAll(
    `SELECT COUNT(*) FROM read_parquet(${sqlString(parquetPath)})`
  );
  let actualRecords;
  try {
    actualRecords = Number(countResult.getRows()[0][0]);
  } finally {
    countResult.closeSync();
  }
  if (actualRecords !== expectedRecords) {
    throw new Error(`Parquet row count mismatch for ${parquetPath}: expected ${expectedRecords}, got ${actualRecords}`);
  }
}

async function removeLegacyDistrictPartitions(datasetName, reportDir) {
  const partitionFiles = (await fs.readdir(reportDir))
    .filter(name => name.startsWith(`${datasetName}-District-`) && name.endsWith('.csv'));
  for (const fileName of partitionFiles) {
    await fs.remove(path.join(reportDir, fileName));
  }
  return partitionFiles.length;
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
  await fs.ensureDir(parquetDir);
  const sourceManifest = await fs.readFile(path.join(__dirname, 'data-links.csv'), 'utf8');
  const dataSources = parseDataSources(sourceManifest);
  await downloadDataSources(dataSources, rawDir, parquetDir);

  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  let connection;
  try {
    connection = await instance.connect();

    for (const ds of dataSources) {
      const rawPath = path.join(rawDir, `${ds.name}.csv`);
      const parquetPath = path.join(parquetDir, `${ds.name}.parquet`);
      const outDir = path.join(__dirname, 'data', 'report', ds.name);
      await fs.ensureDir(outDir);

      const { headers, totalRecords } = await readCsvMetadata(rawPath);

      const removedPartitions = await removeLegacyDistrictPartitions(ds.name, outDir);
      let parquetBytes;
      if (ds.parquetUrl) {
        await validateParquetFile(connection, parquetPath, totalRecords, headers);
        parquetBytes = (await fs.stat(parquetPath)).size;
      } else {
        parquetBytes = await writeParquetFile(connection, rawPath, parquetPath);
      }
      const index = { totalRecords };
      await fs.writeJson(path.join(outDir, `${ds.name}.index.json`), index, { spaces: 2 });

      const normalizeColumn = column => column.toLowerCase().replace(/[^a-z0-9]/g, '');
      const findColumn = candidates => {
        const normalizedHeaders = headers.map(name => ({ name, normalized: normalizeColumn(name) }));
        for (const candidate of candidates) {
          const match = normalizedHeaders.find(column => column.normalized === candidate);
          if (match) return match.name;
        }
        return null;
      };
      const settings = {
        datasetName: ds.name,
        datasetLabel: ds.label,
        description: ds.description,
        dashboardLocation: ds.dashboardLocation,
        totalRecords,
        dimensions: headers.filter(column => ['district', 'county'].includes(normalizeColumn(column))),
        metrics: ['Record Count'],
        aggregationTypes: ['Count'],
        orderBy: ['Dimension', 'Metric Agg Result'],
        order: ['Ascending', 'Descending'],
      };

      const latitudeField = findColumn(['latitude', 'lat']);
      const longitudeField = findColumn(['longitude', 'lon', 'lng']);
      if (latitudeField && longitudeField) {
        settings.map = { latitudeField, longitudeField };
        if (ds.name === 'eda_assets_bridge_condition_owner_area') {
          settings.map.clusterDefault = true;
          settings.map.districtField = findColumn(['district']);
          settings.map.countyField = findColumn(['county']);
          settings.map.defaultColorField = findColumn(['gfp']);
          settings.map.colorFieldOptions = ['GFP', 'OWNERSHIP', 'OWNER', 'LOAD_RATING_AGENCY', 'NHS']
            .filter(field => headers.some(column => normalizeColumn(column) === normalizeColumn(field)));
        }
      }

      await fs.writeJson(path.join(outDir, `${ds.name}-bi-settings.json`), settings, { spaces: 2 });
      console.log(`[ETL INFO] ${ds.name}: wrote index and BI settings (${totalRecords} records); Parquet ${parquetBytes} bytes; removed ${removedPartitions} legacy partitions.`);
    }
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = {
  main,
  parseDataSources,
  downloadDataSources,
  readCsvMetadata,
  validateParquetFile,
  removeLegacyDistrictPartitions,
  writeParquetFile
};
