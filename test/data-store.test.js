const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

describe('shared IndexedDB database', () => {
  let dataStore;
  let previousIndexedDB;
  let openCalls;
  let database;
  let stores;

  before(async () => {
    previousIndexedDB = global.indexedDB;
    openCalls = [];
    stores = new Map();
    database = {
      objectStoreNames: {
        contains: name => stores.has(name)
      },
      createObjectStore(name, options) {
        stores.set(name, options);
        return {};
      }
    };
    global.indexedDB = {
      open(name, version) {
        openCalls.push({ name, version });
        const request = {};
        queueMicrotask(() => {
          request.onupgradeneeded({ target: { result: database } });
          request.result = database;
          request.onsuccess();
        });
        return request;
      }
    };
    dataStore = await import('../js/data-store.mjs');
  });

  after(() => {
    if (previousIndexedDB === undefined) {
      delete global.indexedDB;
    } else {
      global.indexedDB = previousIndexedDB;
    }
  });

  it('creates all version-2 stores once and shares the database connection', async () => {
    const first = await dataStore.getDatabase();
    const second = await dataStore.getDatabase();

    assert.equal(first, database);
    assert.equal(second, database);
    assert.deepEqual(openCalls, [{ name: 'analysis_eda_tool_db', version: 2 }]);
    assert.deepEqual([...stores.entries()], [
      ['partitions', { keyPath: 'key' }],
      ['sources', { keyPath: 'alias' }],
      ['user_source_data', { keyPath: 'alias' }],
      ['user_source_bytes', { keyPath: 'alias' }]
    ]);
  });
});
