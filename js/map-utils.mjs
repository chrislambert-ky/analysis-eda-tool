function findCoordinateColumn(columns, fullName, abbreviations) {
	const normalizedColumns = columns.map(name => ({
		name,
		normalized: String(name).toLowerCase().replace(/[^a-z0-9]/g, '')
	}));
	const exactMatch = normalizedColumns.find(column =>
		column.normalized === fullName || abbreviations.includes(column.normalized)
	);
	return exactMatch?.name
		|| normalizedColumns.find(column => column.normalized.startsWith(fullName))?.name
		|| null;
}

export function detectCoordinateFields(columns) {
	return {
		latitude: findCoordinateColumn(columns, 'latitude', ['lat']),
		longitude: findCoordinateColumn(columns, 'longitude', ['lon', 'lng'])
	};
}
