const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

describe('share link helpers', () => {
  let share;
  const datasets = [
    { id: 'eda_construction_procurement' },
    { id: 'eda_current_enact_plan_data_set' }
  ];
  const presetDatasetSlugs = {
    eda_construction_procurement: 'construction_procurement',
    eda_current_enact_plan_data_set: 'current_enacted_plan'
  };

  before(async () => {
    share = await import('../js/share.mjs');
  });

  it('normalizes tokens and resolves preset dataset aliases', () => {
    assert.equal(share.normalizeShareToken(' Current Enacted-Plan! '), 'current_enacted_plan');
    assert.equal(
      share.decodeDatasetShareValue('Current-Enacted-Plan', datasets, presetDatasetSlugs),
      'eda_current_enact_plan_data_set'
    );
    assert.equal(
      share.decodeDatasetShareValue('EDA Construction Procurement', datasets, presetDatasetSlugs),
      'eda_construction_procurement'
    );
    assert.equal(share.decodeDatasetShareValue('unknown', datasets, presetDatasetSlugs), null);
  });

  it('parses a share URL into dashboard state and ignores unrelated or invalid URLs', () => {
    const shared = share.parseSharedState(
      '?data=construction_procurement&graph=hbar&dimension=District&metrics=Amount&order=descending',
      datasets,
      presetDatasetSlugs
    );
    assert.deepEqual(shared, {
      datasetId: 'eda_construction_procurement',
      chartType: 'bar-horizontal',
      dimension: 'District',
      metric: 'Amount',
      aggregation: '',
      splitBy: '',
      orderBy: '',
      order: 'descending'
    });
    assert.equal(share.parseSharedState('?campaign=summer', datasets, presetDatasetSlugs), null);
    assert.equal(share.parseSharedState('?data=unknown', datasets, presetDatasetSlugs), null);
  });

  it('serializes dashboard state using the existing share URL format', () => {
    const url = share.buildShareUrl({
      datasetId: 'eda_construction_procurement',
      chartType: 'bar-horizontal',
      dimension: 'District Name',
      metric: 'Contract Amount',
      aggregation: 'SUM',
      splitBy: '',
      orderBy: 'Contract Amount',
      order: 'desc'
    }, {
      baseUrl: 'https://example.test/analysis/',
      datasets,
      presetDatasetSlugs
    });

    assert.equal(
      url,
      'https://example.test/analysis/?data=construction_procurement&graph=hbar&dimension=district_name&metrics=contract_amount&aggregation=sum&splitby=&orderby=contract_amount&order=descending'
    );
    assert.equal(share.buildShareUrl({
      datasetId: 'user_source',
      chartType: 'pie'
    }, {
      baseUrl: 'https://example.test/',
      datasets,
      presetDatasetSlugs
    }), null);
  });
});
