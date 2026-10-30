const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

describe('dataset loader', () => {
  let loader;

  before(async () => {
    loader = await import('../js/dataset-loader.mjs');
  });

  it('parses quoted CSV fields, escaped quotes, multiline values, and missing cells', () => {
    const rows = loader.parseCSV(
      'id,name,note\r\n' +
      '1,"Bridge, A","says ""hello"""\r\n' +
      '2,plain,\r\n' +
      '3,"multi\nline",ok\r\n'
    );

    assert.deepEqual(rows, [
      { id: '1', name: 'Bridge, A', note: 'says "hello"' },
      { id: '2', name: 'plain', note: '' },
      { id: '3', name: 'multi\nline', note: 'ok' }
    ]);
    assert.deepEqual(loader.parseCSV(''), []);
  });

  it('returns a cached partition when its record count matches the index', async () => {
    let fetched = false;
    let written = false;
    const cachedRows = [{ id: '1' }];
    const rows = await loader.loadPartition('sample', '01', 1, {
      readCache: async (datasetId, district) => {
        assert.deepEqual([datasetId, district], ['sample', '01']);
        return { recordCount: 1, data: cachedRows };
      },
      writeCache: async () => { written = true; },
      getText: async () => { fetched = true; return ''; }
    });

    assert.equal(rows, cachedRows);
    assert.equal(fetched, false);
    assert.equal(written, false);
  });

  it('fetches, parses, and caches a partition when the cached count is stale', async () => {
    let writeArgs;
    let fetchedPath;
    const rows = await loader.loadPartition('sample', '02', 2, {
      readCache: async () => ({ recordCount: 1, data: [{ id: 'stale' }] }),
      writeCache: async (...args) => { writeArgs = args; },
      getText: async path => {
        fetchedPath = path;
        return 'id,value\n1,"A, B"\n2,C\n';
      }
    });

    assert.deepEqual(rows, [
      { id: '1', value: 'A, B' },
      { id: '2', value: 'C' }
    ]);
    assert.equal(fetchedPath, 'data/report/sample/sample-District-02.csv');
    assert.deepEqual(writeArgs, ['sample', '02', rows]);
  });
});
