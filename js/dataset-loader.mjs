import {
	readPartitionFromCache,
	writePartitionToCache
} from './data-store.mjs';

export const DATA_ROOT = 'data/report';
export const DISTRICTS = ['01','02','03','04','05','06','07','08','09','10','11','12','Various'];

export async function fetchJSON(url) {
	const response = await fetch(url, { cache: 'no-cache' });
	if (!response.ok) {
		throw new Error(`Failed to fetch JSON: ${url} (${response.status})`);
	}
	return response.json();
}

async function fetchText(url) {
	const response = await fetch(url, { cache: 'no-cache' });
	if (!response.ok) {
		throw new Error(`Failed to fetch CSV: ${url} (${response.status})`);
	}
	return response.text();
}

export function parseCSV(text) {
	if (!text) return [];
	const rows = [];
	let headers = null;
	let current = '';
	let fields = [];
	let inQuotes = false;
	const flushLine = () => {
		fields.push(current);
		current = '';
		const hasContent = fields.some(value => value.length);
		if (!headers) {
			if (!hasContent) {
				fields = [];
				return;
			}
			headers = fields;
		} else if (hasContent) {
			const record = {};
			headers.forEach((header, index) => {
				record[header] = fields[index] !== undefined ? fields[index] : '';
			});
			rows.push(record);
		}
		fields = [];
	};
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (char === '"') {
			if (inQuotes && text[i + 1] === '"') {
				current += '"';
				i += 1;
			} else {
				inQuotes = !inQuotes;
			}
		} else if (char === ',' && !inQuotes) {
			fields.push(current);
			current = '';
		} else if ((char === '\n' || char === '\r') && !inQuotes) {
			if (char === '\r' && text[i + 1] === '\n') {
				i += 1;
			}
			flushLine();
		} else {
			current += char;
		}
	}
	if (current.length || fields.length) {
		flushLine();
	}
	return rows;
}

export async function loadPartition(datasetId, district, expectedCount, {
	readCache = readPartitionFromCache,
	writeCache = writePartitionToCache,
	getText = fetchText
} = {}) {
	const cacheEntry = await readCache(datasetId, district);
	if (cacheEntry && cacheEntry.recordCount === expectedCount) {
		return cacheEntry.data;
	}
	const partitionPath = `${DATA_ROOT}/${datasetId}/${datasetId}-District-${district}.csv`;
	const rows = parseCSV(await getText(partitionPath));
	await writeCache(datasetId, district, rows);
	return rows;
}

export async function refreshPartitionCache(datasetId, onProgress) {
	const indexPath = `${DATA_ROOT}/${datasetId}/${datasetId}.index.json`;
	await fetchJSON(indexPath);
	for (let i = 0; i < DISTRICTS.length; i += 1) {
		const district = DISTRICTS[i];
		const partitionPath = `${DATA_ROOT}/${datasetId}/${datasetId}-District-${district}.csv`;
		const rows = parseCSV(await fetchText(partitionPath));
		await writePartitionToCache(datasetId, district, rows);
		if (onProgress) onProgress(i + 1, DISTRICTS.length);
	}
}

export async function fetchRawCsvSample(datasetId) {
	const url = `data/raw/${datasetId}.csv`;
	const response = await fetch(url, {
		headers: { Range: 'bytes=0-16383' },
		cache: 'no-cache'
	}).catch(() => null);
	if (!response || (!response.ok && response.status !== 206)) return null;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	let bytesRead = 0;
	const MAX_BYTES = 16384;
	while (bytesRead < MAX_BYTES) {
		const { value, done } = await reader.read();
		if (done) break;
		bytesRead += value.length;
		text += decoder.decode(value, { stream: true });
	}
	reader.cancel().catch(() => {});

	const rows = parseCSV(text);
	return rows.length > 1 ? rows.slice(0, -1) : rows;
}
