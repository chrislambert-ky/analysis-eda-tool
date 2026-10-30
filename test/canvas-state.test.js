const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

describe('canvas state', () => {
  it('creates named canvas defaults for each interface', async () => {
    const { createCanvas } = await import('../js/canvas-state.mjs');
    assert.equal(createCanvas('all-in-one', 1, { id: 'a' }).name, 'All in One');
    assert.equal(createCanvas('graph-only', 2, { id: 'b' }).name, 'Graph 2');
    assert.equal(createCanvas('table-only', 1, { id: 'c' }).name, 'Table');
    assert.equal(createCanvas('map-all-in-one', 1, { id: 'map-all' }).chartType, 'map');
    assert.equal(createCanvas('map-only', 1, { id: 'map-only' }).chartType, 'map');
    assert.equal(createCanvas('sql', 1, { id: 'd' }).chartType, 'sql');
  });

  it('normalizes saved canvas state and rejects unknown interface types', async () => {
    const { normalizeCanvas } = await import('../js/canvas-state.mjs');
    assert.deepEqual(normalizeCanvas({
      id: 'canvas-a',
      type: 'graph-only',
      name: ' Spent by year ',
      datasetId: 'projects',
      hiddenColumns: ['A', 1],
      controls: { metricSelect: 'COST' },
      sql: 42
    }), {
      id: 'canvas-a',
      type: 'graph-only',
      name: 'Spent by year',
      datasetId: 'projects',
      chartType: 'bar-horizontal',
      controls: { metricSelect: 'COST' },
      hiddenColumns: ['A'],
      sql: ''
    });
    assert.equal(normalizeCanvas({
      id: 'legacy-map',
      type: 'all-in-one',
      chartType: 'map'
    }).type, 'map-all-in-one');
    assert.equal(normalizeCanvas({
      id: 'legacy-sql',
      type: 'all-in-one',
      chartType: 'sql'
    }).type, 'sql');
    assert.equal(normalizeCanvas({ id: 'bad', type: 'map' }), null);
  });
});
