const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

describe('share link helpers', () => {
  let share;
  const datasets = [
    { id: 'eda_construction_procurement' },
    { id: 'eda_current_enact_plan_data_set' },
    { id: 'kytc-trak-construction-change-orders-dataview' }
  ];
  const presetDatasetSlugs = {
    eda_construction_procurement: 'construction_procurement',
    eda_current_enact_plan_data_set: 'current_enacted_plan'
  };
  const legacyDatasetIds = {
    eda_awarded_projects: 'eda_construction_procurement',
    'export-bi-agency-construction-change-orders-dataview': 'kytc-trak-construction-change-orders-dataview'
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
      presetDatasetSlugs,
      legacyDatasetIds
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
    assert.equal(
      share.parseSharedState(
        '?data=export_bi_agency_construction_change_orders_dataview&graph=hbar',
        datasets,
        presetDatasetSlugs,
        legacyDatasetIds
      ).datasetId,
      'kytc-trak-construction-change-orders-dataview'
    );
    assert.equal(
      share.parseSharedState('?data=awarded_projects', datasets, presetDatasetSlugs, legacyDatasetIds).datasetId,
      'eda_construction_procurement'
    );
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
