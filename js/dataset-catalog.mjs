import { parseCSV } from './dataset-loader.mjs';

let datasetCatalogPromise;

function readUrl(value, field, datasetName, required = false) {
	const trimmed = String(value ?? '').trim();
	if (!trimmed) {
		if (required) throw new Error(`Dataset "${datasetName}" is missing ${field}.`);
		return null;
	}

	let url;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`Dataset "${datasetName}" has an invalid ${field} URL.`);
	}
	if (url.protocol !== 'https:') {
		throw new Error(`Dataset "${datasetName}" ${field} URL must use HTTPS.`);
	}
	return url.href;
}

export function parseDatasetCatalog(csvText) {
	const text = String(csvText ?? '').replace(/^\uFEFF/, '');
	const records = parseCSV(text);
	const requiredFields = ['name', 'label', 'description', 'csv_public_url'];
	if (!records.length) throw new Error('Dataset catalog contains no datasets.');
	const missingFields = requiredFields.filter(field => !(field in records[0]));
	if (missingFields.length) {
		throw new Error(`Dataset catalog is missing columns: ${missingFields.join(', ')}.`);
	}

	const names = new Set();
	return records.map((record, index) => {
		const id = String(record.name ?? '').trim();
		const title = String(record.label ?? '').trim();
		const description = String(record.description ?? '').trim();
		if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
			throw new Error(`Dataset catalog row ${index + 2} has an invalid name.`);
		}
		if (names.has(id)) throw new Error(`Dataset catalog contains duplicate name "${id}".`);
		names.add(id);
		if (!title) throw new Error(`Dataset "${id}" is missing a label.`);
		if (!description) throw new Error(`Dataset "${id}" is missing a description.`);

		const csvUrl = readUrl(record.csv_public_url, 'CSV', id, true);
		if (!new URL(csvUrl).pathname.toLowerCase().endsWith('.csv')) {
			throw new Error(`Dataset "${id}" CSV URL must end in .csv.`);
		}
		const parquetUrl = readUrl(record.parquet_public_url, 'Parquet', id);
		if (parquetUrl && !new URL(parquetUrl).pathname.toLowerCase().endsWith('.parquet')) {
			throw new Error(`Dataset "${id}" Parquet URL must end in .parquet.`);
		}
		const dashboardLocation = readUrl(record.dashboard_location, 'dashboard', id);

		return { id, title, description, csvUrl, parquetUrl, dashboardLocation };
	});
}

export function getDatasetCatalog() {
	if (!datasetCatalogPromise) {
		const catalogUrl = new URL('../data-links.csv', import.meta.url);
		datasetCatalogPromise = fetch(catalogUrl, { cache: 'no-cache' })
			.then(response => {
				if (!response.ok) {
					throw new Error(`Failed to load dataset catalog (${response.status}).`);
				}
				return response.text();
			})
			.then(parseDatasetCatalog)
			.catch(error => {
				datasetCatalogPromise = null;
				throw error;
			});
	}
	return datasetCatalogPromise;
}
