export const CANVAS_TYPES = ['all-in-one', 'graph-only', 'table-only', 'map-all-in-one', 'map-only', 'sql'];

export function createCanvas(type, number, { id, datasetId = null } = {}) {
	if (!CANVAS_TYPES.includes(type)) throw new TypeError(`Unsupported canvas type: ${type}`);
	const labels = {
		'all-in-one': 'All in One',
		'graph-only': 'Graph',
		'table-only': 'Table',
		'map-all-in-one': 'Map + Table',
		'map-only': 'Map Only',
		sql: 'SQL'
	};
	return {
		id: id || `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		type,
		name: `${labels[type]}${number > 1 ? ` ${number}` : ''}`,
		datasetId,
		chartType: type === 'sql' ? 'sql' : type.startsWith('map-') ? 'map' : 'bar-horizontal',
		controls: {},
		hiddenColumns: [],
		sql: ''
	};
}

export function normalizeCanvas(record) {
	if (!record || typeof record.id !== 'string' || !CANVAS_TYPES.includes(record.type)) return null;
	const type = record.chartType === 'map' && record.type === 'all-in-one'
		? 'map-all-in-one'
		: record.chartType === 'map' && record.type === 'graph-only'
			? 'map-only'
			: record.chartType === 'sql' && ['all-in-one', 'graph-only'].includes(record.type)
				? 'sql'
				: record.type;
	const chartType = type === 'sql'
		? 'sql'
		: type.startsWith('map-')
			? 'map'
			: ['bar-horizontal', 'bar-vertical', 'pie'].includes(record.chartType)
				? record.chartType
				: 'bar-horizontal';
	return {
		...createCanvas(type, 1, { id: record.id }),
		...record,
		type,
		name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'Canvas',
		datasetId: typeof record.datasetId === 'string' ? record.datasetId : null,
		chartType,
		controls: record.controls && typeof record.controls === 'object' && !Array.isArray(record.controls)
			? record.controls
			: {},
		hiddenColumns: Array.isArray(record.hiddenColumns)
			? record.hiddenColumns.filter(column => typeof column === 'string')
			: [],
		sql: typeof record.sql === 'string' ? record.sql : ''
	};
}
