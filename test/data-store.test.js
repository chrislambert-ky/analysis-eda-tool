const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

describe('shared IndexedDB database', () => {
  let dataStore;
  let previousIndexedDB;
  let openCalls;
  let database;
  let stores;
  let records;

  before(async () => {
    previousIndexedDB = global.indexedDB;
    openCalls = [];
    stores = new Map();
    records = new Map();
    database = {
      objectStoreNames: {
        contains: name => stores.has(name)
      },
      createObjectStore(name, options) {
        stores.set(name, options);
        records.set(name, new Map());
        return {};
      },
      transaction(name) {
        const tx = {};
        let completionQueued = false;
        const queueCompletion = () => {
          if (completionQueued) return;
          completionQueued = true;
          queueMicrotask(() => tx.oncomplete?.());
        };
        return Object.assign(tx, {
          objectStore() {
            return {
              getAll() {
                const request = {};
                queueMicrotask(() => {
                  request.result = [...records.get(name).values()];
                  request.onsuccess();
                });
                return request;
              },
              put(value) {
                const request = {};
                records.get(name).set(value.id, value);
                queueCompletion();
                queueMicrotask(() => request.onsuccess?.());
                return request;
              },
              clear() {
                records.get(name).clear();
                queueCompletion();
              },
              delete(id) {
                const request = {};
                records.get(name).delete(id);
                queueMicrotask(() => request.onsuccess());
                return request;
              }
            };
          }
        });
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

  it('creates all version-5 stores once and shares the database connection', async () => {
    const first = await dataStore.getDatabase();
    const second = await dataStore.getDatabase();

    assert.equal(first, database);
    assert.equal(second, database);
    assert.deepEqual(openCalls, [{ name: 'analysis_eda_tool_db', version: 5 }]);
    assert.deepEqual([...stores.entries()], [
      ['partitions', { keyPath: 'key' }],
      ['sources', { keyPath: 'alias' }],
      ['user_source_data', { keyPath: 'alias' }],
      ['user_source_bytes', { keyPath: 'alias' }],
      ['saved_queries', { keyPath: 'id' }],
      ['workspace_canvases', { keyPath: 'id' }]
    ]);
  });

  it('saves, lists, and deletes SQL snippets in IndexedDB', async () => {
    await dataStore.saveSavedQuery({ id: 'q1', title: 'Recent projects', sql: 'SELECT 1' });
    await dataStore.saveSavedQuery({ id: 'q2', title: 'District totals', sql: 'SELECT 2' });
    assert.deepEqual((await dataStore.readSavedQueries()).map(query => query.id), ['q2', 'q1']);

    await dataStore.deleteSavedQuery('q2');
    const remaining = await dataStore.readSavedQueries();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, 'q1');
    assert.equal(remaining[0].title, 'Recent projects');
    assert.equal(remaining[0].sql, 'SELECT 1');
    assert.equal(typeof remaining[0].updatedAt, 'number');
  });

  it('rejects saved queries without a title or SQL text', async () => {
    await assert.rejects(dataStore.saveSavedQuery({ id: 'bad', title: ' ', sql: 'SELECT 1' }), TypeError);
    await assert.rejects(dataStore.saveSavedQuery({ id: 'bad', title: 'Missing SQL', sql: ' ' }), TypeError);
  });

  it('persists canvases and the active canvas across reloads', async () => {
    const workspace = [
      { id: 'all-in-one-1', type: 'all-in-one', name: 'Dashboard', datasetId: 'bridges' },
      { id: 'table-1', type: 'table-only', name: 'Contracts', datasetId: 'contracts' }
    ];
    await dataStore.writeWorkspaceCanvases(workspace, 'table-1');
    assert.deepEqual(await dataStore.readWorkspaceCanvases(), {
      canvases: workspace,
      activeCanvasId: 'table-1'
    });
    await assert.rejects(dataStore.writeWorkspaceCanvases(workspace, 'missing'), TypeError);
  });
});
