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

});
