const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

describe('workspace preferences', () => {
  it('round-trips the active dataset, chart type, and control choices', async () => {
    const { readWorkspacePreferences, writeWorkspacePreferences } =
      await import('../js/workspace-preferences.mjs');
    const values = new Map();
    const storage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    };
    const preferences = {
      datasetId: 'eda_construction_procurement',
      chartType: 'pie',
      controls: { dimensionSelect: 'DISTRICT', metricSelect: 'AMOUNT' }
    };

    writeWorkspacePreferences(preferences, storage);
    assert.deepEqual(readWorkspacePreferences(storage), preferences);
  });

  it('ignores malformed or incomplete preference records', async () => {
    const { readWorkspacePreferences } = await import('../js/workspace-preferences.mjs');
    assert.equal(readWorkspacePreferences({ getItem: () => null }), null);
    assert.equal(readWorkspacePreferences({ getItem: () => '{"chartType":"pie"}' }), null);
    assert.throws(
      () => readWorkspacePreferences({ getItem: () => '{bad json' }),
      SyntaxError
    );
  });
});
