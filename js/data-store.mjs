const DB_NAME = 'analysis_eda_tool_db';
const DB_VERSION = 6;
const LEGACY_PARTITION_STORE = 'partitions';
const USER_STORES = ['sources', 'user_source_data', 'user_source_bytes'];
const SAVED_QUERY_STORE = 'saved_queries';
const WORKSPACE_CANVAS_STORE = 'workspace_canvases';
const WORKSPACE_META_ID = '__workspace_meta__';

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
				if (db.objectStoreNames.contains(LEGACY_PARTITION_STORE)) {
					db.deleteObjectStore(LEGACY_PARTITION_STORE);
				}
				for (const storeName of USER_STORES) {
					if (!db.objectStoreNames.contains(storeName)) {
						db.createObjectStore(storeName, { keyPath: 'alias' });
					}
				}
				if (!db.objectStoreNames.contains(SAVED_QUERY_STORE)) {
					db.createObjectStore(SAVED_QUERY_STORE, { keyPath: 'id' });
				}
				if (!db.objectStoreNames.contains(WORKSPACE_CANVAS_STORE)) {
					db.createObjectStore(WORKSPACE_CANVAS_STORE, { keyPath: 'id' });
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

export async function readWorkspaceCanvases() {
	const db = await getDatabase();
	return new Promise((resolve, reject) => {
		const request = db.transaction(WORKSPACE_CANVAS_STORE, 'readonly')
			.objectStore(WORKSPACE_CANVAS_STORE).getAll();
		request.onsuccess = () => {
			const records = request.result || [];
			const metadata = records.find(record => record.id === WORKSPACE_META_ID);
			resolve({
				canvases: records.filter(record => record.id !== WORKSPACE_META_ID),
				activeCanvasId: metadata?.activeCanvasId || null
			});
		};
		request.onerror = () => reject(request.error);
	});
}

export async function writeWorkspaceCanvases(canvases, activeCanvasId) {
	if (!Array.isArray(canvases) || !canvases.length) {
		throw new TypeError('Workspace must contain at least one canvas.');
	}
	if (!canvases.some(canvas => canvas.id === activeCanvasId)) {
		throw new TypeError('Active canvas must exist in the workspace.');
	}
	const db = await getDatabase();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(WORKSPACE_CANVAS_STORE, 'readwrite');
		const store = tx.objectStore(WORKSPACE_CANVAS_STORE);
		store.clear();
		canvases.forEach(canvas => store.put(canvas));
		store.put({ id: WORKSPACE_META_ID, activeCanvasId });
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error || new Error('Workspace save was aborted.'));
	});
}
