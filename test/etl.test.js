const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');
const { removeLegacyDistrictPartitions, writeParquetFile } = require('../etl');

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
