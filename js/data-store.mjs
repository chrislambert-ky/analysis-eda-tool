const DB_NAME = 'analysis_eda_tool_db';
const DB_VERSION = 3;
const PARTITION_STORE = 'partitions';
const USER_STORES = ['sources', 'user_source_data', 'user_source_bytes'];
const SAVED_QUERY_STORE = 'saved_queries';

let dbPromise;

export function getDatabase() {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			let settled = false;
			const fail = error => {
				if (settled) return;
				settled = true;
				dbPromise = null;
				reject(error);
			};
			request.onupgradeneeded = event => {
				const db = event.target.result;
				if (!db.objectStoreNames.contains(PARTITION_STORE)) {
					db.createObjectStore(PARTITION_STORE, { keyPath: 'key' });
				}
				for (const storeName of USER_STORES) {
					if (!db.objectStoreNames.contains(storeName)) {
						db.createObjectStore(storeName, { keyPath: 'alias' });
					}
				}
				if (!db.objectStoreNames.contains(SAVED_QUERY_STORE)) {
					db.createObjectStore(SAVED_QUERY_STORE, { keyPath: 'id' });
				}
			};
			request.onsuccess = () => {
				if (settled) {
					request.result.close();
					return;
				}
				settled = true;
				request.result.onversionchange = () => {
					request.result.close();
					dbPromise = null;
				};
				resolve(request.result);
			};
			request.onerror = () => fail(request.error);
			request.onblocked = () => fail(new Error('IndexedDB upgrade is blocked by another open app tab. Close older tabs and retry.'));
		});
	}
	return dbPromise;
}

export async function readSavedQueries() {
	const db = await getDatabase();
	return new Promise((resolve, reject) => {
		const request = db.transaction(SAVED_QUERY_STORE, 'readonly')
			.objectStore(SAVED_QUERY_STORE).getAll();
		request.onsuccess = () => resolve((request.result || []).sort((a, b) =>
			(b.updatedAt || 0) - (a.updatedAt || 0) || b.id.localeCompare(a.id)
		));
		request.onerror = () => reject(request.error);
	});
}

export async function saveSavedQuery(query) {
	if (!query?.id || !query?.title?.trim() || !query?.sql?.trim()) {
		throw new TypeError('A saved query requires an ID, title, and SQL statement.');
	}
	const db = await getDatabase();
	return new Promise((resolve, reject) => {
		const request = db.transaction(SAVED_QUERY_STORE, 'readwrite')
			.objectStore(SAVED_QUERY_STORE)
			.put({ ...query, title: query.title.trim(), sql: query.sql.trim(), updatedAt: Date.now() });
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
	});
}

export async function deleteSavedQuery(queryId) {
	const db = await getDatabase();
	return new Promise((resolve, reject) => {
		const request = db.transaction(SAVED_QUERY_STORE, 'readwrite')
			.objectStore(SAVED_QUERY_STORE).delete(queryId);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
	});
}

export async function readPartitionFromCache(datasetId, district) {
	const db = await getDatabase();
	return new Promise(resolve => {
		const tx = db.transaction(PARTITION_STORE, 'readonly');
		const request = tx.objectStore(PARTITION_STORE).get(`${datasetId}|${district}`);
		request.onsuccess = () => resolve(request.result || null);
		request.onerror = () => resolve(null);
	});
}

export async function writePartitionToCache(datasetId, district, data) {
	const db = await getDatabase();
	return new Promise(resolve => {
		const tx = db.transaction(PARTITION_STORE, 'readwrite');
		tx.objectStore(PARTITION_STORE).put({
			key: `${datasetId}|${district}`,
			datasetId,
			district,
			recordCount: data.length,
			cachedAt: Date.now(),
			data
		});
		tx.oncomplete = () => resolve();
		tx.onerror = () => resolve();
	});
}

export async function readDatasetCachedAt(datasetId) {
	const db = await getDatabase();
	return new Promise(resolve => {
		const tx = db.transaction(PARTITION_STORE, 'readonly');
		const request = tx.objectStore(PARTITION_STORE).openCursor();
		request.onsuccess = event => {
			const cursor = event.target.result;
			if (cursor) {
				if (cursor.value.datasetId === datasetId && cursor.value.cachedAt) {
					resolve(cursor.value.cachedAt);
				} else {
					cursor.continue();
				}
			} else {
				resolve(null);
			}
		};
		request.onerror = () => resolve(null);
	});
}

export async function readCachedColumns(datasetId) {
	const db = await getDatabase();
	return new Promise(resolve => {
		const tx = db.transaction(PARTITION_STORE, 'readonly');
		const request = tx.objectStore(PARTITION_STORE).openCursor();
		request.onsuccess = event => {
			const cursor = event.target.result;
			if (cursor) {
				const value = cursor.value;
				if (value.datasetId === datasetId && Array.isArray(value.data) && value.data.length > 0) {
					resolve(Object.keys(value.data[0]));
				} else {
					cursor.continue();
				}
			} else {
				resolve(null);
			}
		};
		request.onerror = () => resolve(null);
	});
}

export async function readCachedSample(datasetId, limit = 200) {
	const db = await getDatabase();
	return new Promise(resolve => {
		const tx = db.transaction(PARTITION_STORE, 'readonly');
		const request = tx.objectStore(PARTITION_STORE).openCursor();
		request.onsuccess = event => {
			const cursor = event.target.result;
			if (cursor) {
				const value = cursor.value;
				if (value.datasetId === datasetId && Array.isArray(value.data) && value.data.length > 0) {
					resolve(value.data.slice(0, limit));
				} else {
					cursor.continue();
				}
			} else {
				resolve(null);
			}
		};
		request.onerror = () => resolve(null);
	});
}

export async function readCachedRecordCount(datasetId) {
	const db = await getDatabase();
	return new Promise(resolve => {
		const tx = db.transaction(PARTITION_STORE, 'readonly');
		let total = 0;
		let found = false;
		const request = tx.objectStore(PARTITION_STORE).openCursor();
		request.onsuccess = event => {
			const cursor = event.target.result;
			if (cursor) {
				if (cursor.value.datasetId === datasetId) {
					total += cursor.value.recordCount || 0;
					found = true;
				}
				cursor.continue();
			} else {
				resolve(found ? total : null);
			}
		};
		request.onerror = () => resolve(null);
	});
}

export async function estimatePartitionStorageBytes() {
	const db = await getDatabase();
	return new Promise(resolve => {
		const tx = db.transaction(PARTITION_STORE, 'readonly');
		let bytes = 0;
		const request = tx.objectStore(PARTITION_STORE).openCursor();
		request.onsuccess = event => {
			const cursor = event.target.result;
			if (cursor) {
				const value = cursor.value;
				if (Array.isArray(value.data) && value.data.length) {
					const sampleBytes = JSON.stringify(value.data[0]).length;
					bytes += sampleBytes * (value.recordCount || value.data.length);
				}
				cursor.continue();
			} else {
				resolve(bytes);
			}
		};
		request.onerror = () => resolve(0);
	});
}

export async function deleteDatasetFromCache(datasetId) {
	const db = await getDatabase();
	return new Promise(resolve => {
		const tx = db.transaction(PARTITION_STORE, 'readwrite');
		const request = tx.objectStore(PARTITION_STORE).openCursor();
		request.onsuccess = event => {
			const cursor = event.target.result;
			if (cursor) {
				if (cursor.value.datasetId === datasetId) {
					cursor.delete();
				}
				cursor.continue();
			} else {
				resolve();
			}
		};
		request.onerror = () => resolve();
	});
}
