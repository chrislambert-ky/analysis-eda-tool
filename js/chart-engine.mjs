export function normalizeGroupValue(value) {
	if (value === undefined || value === null || value === '') return 'Unknown';
	return String(value);
}

export function buildSqlAggExpr(metric, agg) {
	const isCountRecords = !metric || metric === 'Record Count';
	if (isCountRecords) return 'COUNT(*)';
	const col = `"${String(metric).replace(/"/g, '""')}"`;
	switch ((agg || 'Count').toLowerCase()) {
		case 'distinct count': return `COUNT(DISTINCT ${col})`;
		case 'sum':     return `SUM(TRY_CAST(${col} AS DOUBLE))`;
		case 'average': return `ROUND(AVG(TRY_CAST(${col} AS DOUBLE)), 2)`;
		case 'min':     return `MIN(TRY_CAST(${col} AS DOUBLE))`;
		case 'max':     return `MAX(TRY_CAST(${col} AS DOUBLE))`;
		default:        return `COUNT(${col})`;
	}
}

export function prepareSeries(rows, dimensionField, splitValue, metricField, aggregationType, chartType) {
	const useSplit        = splitValue && splitValue !== 'None';
	const splitField      = useSplit ? splitValue : null;
	const isCountRecords  = !metricField || metricField === 'Record Count';
	const agg             = (aggregationType || 'Count').toLowerCase();
	const emptyAccumulator = () => ({
		count: 0,
		sum: 0,
		min: Infinity,
		max: -Infinity,
		distinctVals: agg === 'distinct count' ? new Set() : null
	});

	const grouped = new Map();
	rows.forEach(row => {
		const dimensionKey = normalizeGroupValue(row[dimensionField]);
		if (!grouped.has(dimensionKey)) grouped.set(dimensionKey, new Map());
		const dimensionBucket = grouped.get(dimensionKey);

		const bucketKey = useSplit ? normalizeGroupValue(row[splitValue]) : '__value';
		if (!dimensionBucket.has(bucketKey)) dimensionBucket.set(bucketKey, emptyAccumulator());
		const accumulator = dimensionBucket.get(bucketKey);

		if (isCountRecords) {
			accumulator.count += 1;
		} else if (agg === 'distinct count') {
			accumulator.distinctVals.add(String(row[metricField]));
		} else {
			const number = parseFloat(row[metricField]);
			if (Number.isFinite(number)) {
				accumulator.count += 1;
				accumulator.sum += number;
				if (number < accumulator.min) accumulator.min = number;
				if (number > accumulator.max) accumulator.max = number;
			}
		}
	});

	function resolve(accumulator) {
		if (isCountRecords) return accumulator.count;
		switch (agg) {
			case 'distinct count': return accumulator.distinctVals ? accumulator.distinctVals.size : 0;
			case 'sum': return accumulator.sum;
			case 'average': return accumulator.count ? Math.round((accumulator.sum / accumulator.count) * 100) / 100 : 0;
			case 'min': return accumulator.min === Infinity ? 0 : accumulator.min;
			case 'max': return accumulator.max === -Infinity ? 0 : accumulator.max;
			default: return accumulator.count;
		}
	}

	const seriesLabel = isCountRecords ? 'Count' : `${aggregationType} of ${metricField}`;
	const categories = Array.from(grouped.keys());
	const fallbackAccumulator = emptyAccumulator();

	if (!useSplit) {
		return {
			categories,
			seriesLabel,
			dimensionField,
			splitField: null,
			legend: [],
			series: [{
				name: seriesLabel,
				type: chartType === 'pie' ? 'pie' : 'bar',
				data: categories.map(category => resolve(grouped.get(category).get('__value') || fallbackAccumulator))
			}]
		};
	}

	const splitKeySet = new Set();
	grouped.forEach(dimensionBucket => dimensionBucket.forEach((_, key) => splitKeySet.add(key)));
	const legend = Array.from(splitKeySet);
	const series = legend.map(splitKey => ({
		name: splitKey,
		type: 'bar',
		stack: 'total',
		data: categories.map(category => resolve(grouped.get(category).get(splitKey) || fallbackAccumulator))
	}));
	return { categories, seriesLabel, dimensionField, splitField, legend, series };
}

export function sortSeries(prepared, orderBy, orderMode) {
	const { categories, series } = prepared;
	if (!categories.length) return;
	const totals = categories.map((category, index) =>
		series.reduce((sum, serie) => sum + (serie.data[index] || 0), 0)
	);
	const indices = categories.map((_, index) => index);
	const ascendingMultiplier = orderMode === 'asc' ? 1 : -1;
	indices.sort((a, b) => {
		if (orderBy === 'dimension') {
			return String(categories[a]).localeCompare(
				String(categories[b]),
				undefined,
				{ numeric: true, sensitivity: 'base' }
			) * ascendingMultiplier;
		}
		if (totals[a] === totals[b]) {
			return String(categories[a]).localeCompare(
				String(categories[b]),
				undefined,
				{ numeric: true, sensitivity: 'base' }
			) * ascendingMultiplier;
		}
		return (totals[a] - totals[b]) * ascendingMultiplier;
	});
	prepared.categories = indices.map(index => categories[index]);
	prepared.series.forEach(serie => {
		serie.data = indices.map(index => serie.data[index]);
	});
}

export function buildChartOption(prepared, chartType, selectedDimension) {
	const isPie = chartType === 'pie';
	const seriesLabel = prepared.seriesLabel || 'Count';
	const dimension = prepared.dimensionField || selectedDimension;
	const splitField = prepared.splitField;
	if (isPie) {
		const pieData = prepared.categories.map((category, index) => ({
			name: category,
			value: prepared.series[0].data[index]
		}));
		return {
			title: { text: `${seriesLabel} by ${dimension}`, left: 'center' },
			tooltip: { trigger: 'item' },
			legend: { orient: 'vertical', left: 'left' },
			series: [{
				name: seriesLabel,
				type: 'pie',
				radius: '65%',
				selectedMode: 'single',
				data: pieData,
				label: { formatter: '{b}: {c} ({d}%)' }
			}]
		};
	}

	const isHorizontal = chartType === 'bar-horizontal';
	const legendItems = Array.isArray(prepared.legend) ? prepared.legend : [];
	const legendVisible = legendItems.length > 0 && legendItems.length <= 13;
	let legendConfig;
	if (legendItems.length > 0) {
		legendConfig = legendItems.length > 13 ? { show: false } : { data: legendItems, top: 28 };
	}
	const tooltipConfig = splitField
		? {
			trigger: 'item',
			formatter: params => {
				const marker = `<span style="display:inline-block;margin-right:4px;border-radius:50%;width:10px;height:10px;background-color:${params.color};"></span>`;
				return `<div style="font-size:13px;">`
					+ `<strong>${dimension}:</strong> ${params.name}<br>`
					+ `${marker}<strong>${splitField}:</strong> ${params.seriesName}<br>`
					+ `<strong>${seriesLabel}:</strong> ${Number.isFinite(params.value) ? params.value.toLocaleString() : params.value}`
					+ `</div>`;
			}
		}
		: { trigger: 'axis' };
	const option = {
		title: { text: `${seriesLabel} by ${dimension}`, left: 'center', top: 0 },
		tooltip: tooltipConfig,
		legend: legendConfig,
		grid: { left: '3%', right: '4%', bottom: '5%', top: legendVisible ? '70px' : '40px', containLabel: true },
		xAxis: isHorizontal ? { type: 'value' } : { type: 'category', data: prepared.categories },
		yAxis: isHorizontal ? { type: 'category', data: prepared.categories, inverse: true } : { type: 'value' },
		series: prepared.series.map(serie => ({
			...serie,
			type: 'bar',
			selectedMode: 'single',
			label: { show: true, position: isHorizontal ? 'right' : 'top' }
		}))
	};
	if (isHorizontal && prepared.categories.length > 12) {
		option.dataZoom = [
			{
				type: 'inside',
				yAxisIndex: 0,
				startValue: 0,
				endValue: 11,
				zoomOnMouseWheel: false,
				moveOnMouseWheel: true,
				moveOnMouseMove: false
			},
			{
				type: 'slider',
				yAxisIndex: 0,
				startValue: 0,
				endValue: 11,
				width: 18,
				right: 6,
				brushSelect: false,
				showDetail: false,
				showDataShadow: false
			}
		];
		option.grid.right = '40px';
	}
	return option;
}
