export const CHART_TYPE_TO_SHARE = {
	'bar-horizontal': 'hbar',
	'bar-vertical': 'vbar',
	pie: 'pie',
	map: 'map',
	sql: 'sql',
	catalog: 'catalog'
};

const SHARE_TO_CHART_TYPE = {
	hbar: 'bar-horizontal',
	vbar: 'bar-vertical',
	pie: 'pie',
	map: 'map',
	sql: 'sql',
	catalog: 'catalog'
};

const SHARE_PARAM_KEYS = ['data','graph','dimension','metrics','aggregation','splitby','orderby','order'];

export function normalizeShareToken(value) {
	return String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_')
		.replace(/[^a-z0-9_]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
}

export function isPresetDatasetId(datasetId, datasets) {
	return datasets.some(ds => ds.id === datasetId);
}

export function encodeDatasetShareValue(datasetId, presetDatasetSlugs) {
	return presetDatasetSlugs[datasetId] || normalizeShareToken(datasetId).replace(/^eda_/, '');
}

export function decodeDatasetShareValue(rawValue, datasets, presetDatasetSlugs) {
	if (!rawValue) return null;
	const token = normalizeShareToken(rawValue);
	const mapped = Object.entries(presetDatasetSlugs)
		.find(([, slug]) => normalizeShareToken(slug) === token)?.[0];
	if (mapped) return mapped;
	const byId = datasets.find(ds => normalizeShareToken(ds.id) === token);
	return byId?.id || null;
}

export function parseSharedState(search, datasets, presetDatasetSlugs) {
	const params = new URLSearchParams(search);
	if (!SHARE_PARAM_KEYS.some(key => params.has(key))) return null;

	const datasetId = decodeDatasetShareValue(params.get('data'), datasets, presetDatasetSlugs);
	if (!datasetId || !isPresetDatasetId(datasetId, datasets)) return null;

	const chartToken = normalizeShareToken(params.get('graph'));
	const chartType = SHARE_TO_CHART_TYPE[chartToken] || null;

	return {
		datasetId,
		chartType,
		dimension: params.get('dimension') || '',
		metric: params.get('metrics') || '',
		aggregation: params.get('aggregation') || '',
		splitBy: params.get('splitby') || '',
		orderBy: params.get('orderby') || '',
		order: params.get('order') || ''
	};
}

export function buildShareUrl({
	datasetId,
	chartType,
	dimension,
	metric,
	aggregation,
	splitBy,
	orderBy,
	order
}, { baseUrl, datasets, presetDatasetSlugs }) {
	if (!isPresetDatasetId(datasetId, datasets)) return null;

	const params = new URLSearchParams();
	params.set('data', encodeDatasetShareValue(datasetId, presetDatasetSlugs));
	params.set('graph', CHART_TYPE_TO_SHARE[chartType] || 'hbar');
	params.set('dimension', normalizeShareToken(dimension));
	params.set('metrics', normalizeShareToken(metric));
	params.set('aggregation', normalizeShareToken(aggregation));
	params.set('splitby', normalizeShareToken(splitBy));
	params.set('orderby', normalizeShareToken(orderBy));
	params.set('order', order === 'desc' ? 'descending' : 'ascending');

	return `${baseUrl}?${params.toString()}`;
}
