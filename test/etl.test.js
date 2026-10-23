const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');
const { parse } = require('csv-parse/sync');
const { normalizeDistrict, writePartitionFiles } = require('../etl');

describe('normalizeDistrict', () => {
  it('normalizes district numbers and known non-district labels', () => {
    assert.equal(normalizeDistrict(' District 1 '), '01');
    assert.equal(normalizeDistrict('12'), '12');
    assert.equal(normalizeDistrict('District Various'), 'Various');
    assert.equal(normalizeDistrict(''), 'Various');
  });
});

describe('writePartitionFiles', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eda-etl-test-'));
  after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it('writes indexed partitions for recognized district values', async () => {
    const datasetName = 'sample_dataset';
    const staleFile = path.join(tempDir, `${datasetName}-District-99.csv`);
    fs.writeFileSync(staleFile, 'stale');

    const records = [
      { DISTRICT: 'District 01', PROJECT: 'Project A' },
      { DISTRICT: 'Various', PROJECT: 'Project B' },
      { DISTRICT: '', PROJECT: 'Project C' }
    ];

    const index = await writePartitionFiles(datasetName, records, tempDir);

    assert.equal(index.totalRecords, records.length);
    assert.equal(index[`${datasetName}-District-01.csv`].records, 1);
    assert.equal(index[`${datasetName}-District-Various.csv`].records, 2);
    assert.equal(fs.existsSync(staleFile), false);
    assert.equal(Object.keys(index).filter(key => key.endsWith('.csv')).length, 13);

    const partitionCount = Object.keys(index)
      .filter(key => key.endsWith('.csv'))
      .reduce((total, fileName) => {
        const rows = parse(fs.readFileSync(path.join(tempDir, fileName), 'utf8'), { columns: true });
        assert.equal(rows.length, index[fileName].records);
        return total + rows.length;
      }, 0);
    assert.equal(partitionCount, records.length);
  });
});
