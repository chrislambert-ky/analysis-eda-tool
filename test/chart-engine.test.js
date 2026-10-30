const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

describe('chart engine', () => {
  let chart;

  before(async () => {
    chart = await import('../js/chart-engine.mjs');
  });

  it('aggregates numeric metrics by dimension and splits', () => {
    const prepared = chart.prepareSeries([
      { district: '01', owner: 'A', amount: '2' },
      { district: '01', owner: 'B', amount: '3' },
      { district: '02', owner: 'A', amount: '5' },
      { district: '02', owner: 'B', amount: '' },
      { district: '', owner: 'B', amount: '4' }
    ], 'district', 'owner', 'amount', 'Sum', 'bar-vertical');

    assert.deepEqual(prepared.categories, ['01', '02', 'Unknown']);
    assert.deepEqual(prepared.legend, ['A', 'B']);
    assert.deepEqual(prepared.series.map(series => series.data), [
      [2, 5, 0],
      [3, 0, 4]
    ]);
  });

  it('supports count, distinct count, average, min, and max aggregations', () => {
    const rows = [
      { group: 'A', value: '2' },
      { group: 'A', value: '2' },
      { group: 'A', value: '6' },
      { group: 'B', value: '' }
    ];
    const aggregate = aggregation =>
      chart.prepareSeries(rows, 'group', 'None', 'value', aggregation, 'bar-horizontal').series[0].data;

    assert.deepEqual(
      chart.prepareSeries(rows, 'group', 'None', 'Record Count', 'Count', 'bar-horizontal').series[0].data,
      [3, 1]
    );
    assert.deepEqual(aggregate('Distinct Count'), [2, 1]);
    assert.deepEqual(aggregate('Average'), [3.33, 0]);
    assert.deepEqual(aggregate('Min'), [2, 0]);
    assert.deepEqual(aggregate('Max'), [6, 0]);
  });

  it('sorts categories and keeps all series data aligned', () => {
    const prepared = {
      categories: ['10', '2', '1'],
      series: [
        { name: 'A', data: [4, 8, 1] },
        { name: 'B', data: [0, 2, 1] }
      ]
    };

    chart.sortSeries(prepared, 'dimension', 'asc');
    assert.deepEqual(prepared.categories, ['1', '2', '10']);
    assert.deepEqual(prepared.series.map(series => series.data), [
      [1, 8, 4],
      [1, 2, 0]
    ]);

    chart.sortSeries(prepared, 'metric', 'desc');
    assert.deepEqual(prepared.categories, ['2', '10', '1']);
    assert.deepEqual(prepared.series.map(series => series.data), [
      [8, 4, 1],
      [2, 0, 1]
    ]);
  });

  it('builds safe SQL aggregate expressions', () => {
    assert.equal(chart.buildSqlAggExpr('', 'Count'), 'COUNT(*)');
    assert.equal(chart.buildSqlAggExpr('amount', 'Sum'), 'SUM(TRY_CAST("amount" AS DOUBLE))');
    assert.equal(chart.buildSqlAggExpr('a"b', 'Distinct Count'), 'COUNT(DISTINCT "a""b")');
  });

  it('builds pie and horizontal bar options, including large-category zoom', () => {
    const pie = chart.buildChartOption({
      seriesLabel: 'Count',
      dimensionField: 'District',
      categories: ['01'],
      series: [{ data: [5] }]
    }, 'pie', 'District');
    assert.equal(pie.series[0].type, 'pie');
    assert.deepEqual(pie.series[0].data, [{ name: '01', value: 5 }]);

    const categories = Array.from({ length: 13 }, (_, index) => String(index));
    const bar = chart.buildChartOption({
      seriesLabel: 'Count',
      dimensionField: 'District',
      categories,
      legend: [],
      series: [{ name: 'Count', data: categories.map(() => 1) }]
    }, 'bar-horizontal', 'District');
    assert.equal(bar.yAxis.inverse, true);
    assert.equal(bar.dataZoom[0].endValue, 11);
    assert.equal(bar.grid.right, '40px');
  });

  it('formats split-series tooltips with the selected field names', () => {
    const option = chart.buildChartOption({
      seriesLabel: 'Sum of Amount',
      dimensionField: 'District',
      splitField: 'Owner',
      categories: ['01'],
      legend: ['A'],
      series: [{ name: 'A', data: [3] }]
    }, 'bar-vertical', 'District');

    const tooltip = option.tooltip.formatter({
      color: '#000',
      name: '01',
      seriesName: 'A',
      value: 3
    });
    assert.match(tooltip, /District/);
    assert.match(tooltip, /Owner/);
    assert.match(tooltip, /Sum of Amount/);
  });
});
