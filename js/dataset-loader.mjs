export const DATA_ROOT = 'data/report';

export async function fetchJSON(url) {
	const response = await fetch(url, { cache: 'no-cache' });
	if (!response.ok) {
		throw new Error(`Failed to fetch JSON: ${url} (${response.status})`);
	}
	return response.json();
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
