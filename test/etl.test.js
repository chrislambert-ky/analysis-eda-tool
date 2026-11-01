const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');
const {
  downloadDataSources,
  parseDataSources,
  readCsvMetadata,
  removeLegacyDistrictPartitions,
  validateParquetFile,
  writeParquetFile
} = require('../etl');

describe('parseDataSources', () => {
  it('reads source URLs while ignoring unrelated manifest columns', () => {
    assert.deepEqual(parseDataSources([
      'name,label,description,csv_public_url,parquet_public_url,dashboard_location,data',
      'source-one,Source One,"Description, with comma",https://example.com/source-one.csv,https://example.com/source-one.parquet,https://example.com/report,ignored'
    ].join('\n')), [{
      name: 'source-one',
      label: 'Source One',
      description: 'Description, with comma',
      csvUrl: 'https://example.com/source-one.csv',
      parquetUrl: 'https://example.com/source-one.parquet',
      dashboardLocation: 'https://example.com/report'
    }]);
  });

  it('accepts existing underscore names and missing published Parquet URLs', () => {
    assert.deepEqual(parseDataSources([
      'name,label,description,csv_public_url,parquet_public_url',
      'eda_assets_bridge_condition_owner_area,Bridge Inventory,Bridge data,https://example.com/bridges.csv,'
    ].join('\n')), [{
      name: 'eda_assets_bridge_condition_owner_area',
      label: 'Bridge Inventory',
      description: 'Bridge data',
      csvUrl: 'https://example.com/bridges.csv',
      parquetUrl: null,
      dashboardLocation: null
    }]);
  });

  it('rejects duplicate names and missing required columns', () => {
    const row = 'source-one,Source One,Description,https://example.com/one.csv,https://example.com/one.parquet';
    const header = 'name,label,description,csv_public_url,parquet_public_url';
    assert.throws(() => parseDataSources(`${header}\n${row}\n${row}`), /Duplicate data source name/);
    assert.throws(() => parseDataSources('name,label,description\nsource-one,Source One,Description'), /missing columns/);
  });
});

describe('downloadDataSources', () => {
  it('downloads each CSV and published Parquet under the supplied source name', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eda-source-download-test-'));
    const bodies = new Map([
      ['/source-one.csv', Buffer.from('id,value\n1,example\n')],
      ['/source-one.parquet', Buffer.from('parquet test bytes')]
    ]);
    const server = http.createServer((request, response) => {
      const body = bodies.get(request.url);
      response.statusCode = body ? 200 : 404;
      response.end(body || 'not found');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      await downloadDataSources([{
        name: 'source-one',
        label: 'Source One',
        description: 'Description',
        csvUrl: `http://127.0.0.1:${port}/source-one.csv`,
        parquetUrl: `http://127.0.0.1:${port}/source-one.parquet`
      }], path.join(tempDir, 'raw'), path.join(tempDir, 'parquet'));
      assert.deepEqual(
        fs.readFileSync(path.join(tempDir, 'raw', 'source-one.csv')),
        bodies.get('/source-one.csv')
      );
      assert.deepEqual(
        fs.readFileSync(path.join(tempDir, 'parquet', 'source-one.parquet')),
        bodies.get('/source-one.parquet')
      );
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('downloads CSV-only sources without expecting a published Parquet file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eda-csv-only-test-'));
    const server = http.createServer((request, response) => {
      response.end('id,value\n1,example\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      await downloadDataSources([{
        name: 'source-one',
        csvUrl: `http://127.0.0.1:${port}/source-one.csv`,
        parquetUrl: null
      }], path.join(tempDir, 'raw'), path.join(tempDir, 'parquet'));
      assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'source-one.csv')), true);
      assert.equal(fs.existsSync(path.join(tempDir, 'parquet', 'source-one.parquet')), false);
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('readCsvMetadata', () => {
  it('counts CSV records without retaining the whole file in memory', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eda-csv-metadata-test-'));
    const csvPath = path.join(tempDir, 'sample.csv');
    fs.writeFileSync(csvPath, 'CODE,VALUE\n0012,12.5\nAB03,20\n');
    try {
      assert.deepEqual(await readCsvMetadata(csvPath), {
        headers: ['CODE', 'VALUE'],
        totalRecords: 2
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('removeLegacyDistrictPartitions', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eda-etl-test-'));
  after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it('removes old district CSVs without touching other report files', async () => {
    const datasetName = 'sample_dataset';
    const legacy = path.join(tempDir, `${datasetName}-District-01.csv`);
    const unrelated = path.join(tempDir, 'notes.csv');
    fs.writeFileSync(legacy, 'legacy');
    fs.writeFileSync(unrelated, 'keep');

    assert.equal(await removeLegacyDistrictPartitions(datasetName, tempDir), 1);
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  });
});

describe('writeParquetFile', () => {
  it('converts CSV to Parquet while preserving inferred values', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eda-parquet-test-'));
    const csvPath = path.join(tempDir, 'sample.csv');
    const parquetPath = path.join(tempDir, 'sample.parquet');
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();

    try {
      fs.writeFileSync(csvPath, 'CODE,VALUE\n0012,12.5\nAB03,20\n');
      const parquetBytes = await writeParquetFile(connection, csvPath, parquetPath);
      assert.ok(parquetBytes > 0);
      await validateParquetFile(connection, parquetPath, 2, ['CODE', 'VALUE']);
      await assert.rejects(
        validateParquetFile(connection, parquetPath, 3, ['CODE', 'VALUE']),
        /row count mismatch/
      );

      const parquetSqlPath = path.resolve(parquetPath).replace(/\\/g, '/').replace(/'/g, "''");
      const reader = await connection.runAndReadAll(
        `SELECT CODE, VALUE FROM read_parquet('${parquetSqlPath}') ORDER BY CODE`
      );
      try {
        assert.deepEqual(reader.getRows(), [['0012', 12.5], ['AB03', 20]]);
      } finally {
        reader.closeSync();
      }
    } finally {
      connection.closeSync();
      instance.closeSync();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
