import { getDatabase } from './data-store.mjs';

// ── Dataset sources (raw CSV files, not partitioned report data) ───────────
const SQL_DATASETS = [
	{ alias: 'eda_assets_bridge_condition_owner_area',    title: 'Bridge Condition & Owner Area',                url: 'data/raw/eda_assets_bridge_condition_owner_area.csv' },
	{ alias: 'eda_construction_procurement',              title: 'Construction Procurement',                     url: 'data/raw/eda_construction_procurement.csv' },
	{ alias: 'eda_current_enact_plan_data_set',           title: 'Current Enacted Plan',                         url: 'data/raw/eda_current_enact_plan_data_set.csv' },
	{ alias: 'eda_programmanagement_authorized_detailed', title: 'Program Management Authorized (Detailed)',     url: 'data/raw/eda_programmanagement_authorized_detailed.csv' }
];

// ── IndexedDB for user-added sources (unified with main partition-cache IDB) ─
const USER_STORE       = 'sources';
const USER_DATA_STORE  = 'user_source_data';
const USER_BYTES_STORE = 'user_source_bytes';
let   userIdb          = null;

function idbUserGetAll() {
	return new Promise((resolve, reject) => {
		const req = userIdb.transaction(USER_STORE, 'readonly').objectStore(USER_STORE).getAll();
		req.onsuccess = e => resolve(e.target.result || []);
		req.onerror   = e => reject(e.target.error);
	});
}
function idbUserPut(record) {
	return new Promise((resolve, reject) => {
		const req = userIdb.transaction(USER_STORE, 'readwrite').objectStore(USER_STORE).put(record);
		req.onsuccess = () => resolve();
		req.onerror   = e => reject(e.target.error);
	});
}
function idbUserDelete(alias) {
	return new Promise((resolve, reject) => {
		const req = userIdb.transaction(USER_STORE, 'readwrite').objectStore(USER_STORE).delete(alias);
		req.onsuccess = () => resolve();
		req.onerror   = e => reject(e.target.error);
	});
}
function idbUserDataPut(alias, rows) {
	return new Promise((resolve, reject) => {
		const req = userIdb.transaction(USER_DATA_STORE, 'readwrite')
			.objectStore(USER_DATA_STORE).put({ alias, rows, savedAt: Date.now() });
		req.onsuccess = () => resolve();
		req.onerror   = e => reject(e.target.error);
	});
}
function idbUserDataGet(alias) {
	return new Promise((resolve, reject) => {
		const req = userIdb.transaction(USER_DATA_STORE, 'readonly')
			.objectStore(USER_DATA_STORE).get(alias);
		req.onsuccess = e => resolve(e.target.result?.rows || null);
		req.onerror   = e => reject(e.target.error);
	});
}
function idbUserDataDelete(alias) {
	return new Promise((resolve, reject) => {
		const req = userIdb.transaction(USER_DATA_STORE, 'readwrite')
			.objectStore(USER_DATA_STORE).delete(alias);
		req.onsuccess = () => resolve();
		req.onerror   = e => reject(e.target.error);
	});
}
function idbBytesPut(alias, bytes) {
	return new Promise((resolve, reject) => {
		const req = userIdb.transaction(USER_BYTES_STORE, 'readwrite')
			.objectStore(USER_BYTES_STORE).put({ alias, bytes, savedAt: Date.now() });
		req.onsuccess = () => resolve();
		req.onerror   = e => reject(e.target.error);
	});
}
function idbBytesGet(alias) {
	return new Promise((resolve, reject) => {
		const req = userIdb.transaction(USER_BYTES_STORE, 'readonly')
			.objectStore(USER_BYTES_STORE).get(alias);
		req.onsuccess = e => resolve(e.target.result?.bytes || null);
		req.onerror   = e => reject(e.target.error);
	});
}
function idbBytesDelete(alias) {
	return new Promise((resolve, reject) => {
		const req = userIdb.transaction(USER_BYTES_STORE, 'readwrite')
			.objectStore(USER_BYTES_STORE).delete(alias);
		req.onsuccess = () => resolve();
		req.onerror   = e => reject(e.target.error);
	});
}

// ── State ──────────────────────────────────────────────────────────────────
let duck_db       = null;
let conn          = null;
let initialized   = false;
let initializing  = false;
let tableColumns     = new Map();   // alias → [{name, type}]
window._edaTableColumns = tableColumns; // expose to catalog schema resolver
window._edaRemoveUserSource = removeUserSource;
let sqlSettingsCache = new Map();   // alias → BI settings object (or null)
let lastResult    = null;        // { cols, rows } for CSV export
let sqlTabulator  = null;        // current Tabulator instance in the results pane
let userSources   = [];          // persisted user-added sources [{alias, title, url, addedAt}]
const SQL_ROW_LIMIT = 2000;      // max rows rendered in the preview table

// ── DOM helpers ────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelector(sel);

// ── Status indicator ───────────────────────────────────────────────────────
function setStatus(st, msg) {
	const dot  = $('sqlStatusDot');
	const text = $('sqlStatusText');
	if (dot)  dot.className  = 'sql-status-dot ' + st;
	if (text) text.textContent = msg;
	// Mirror state to the page-level header indicator
	const hdot = $('duckdbStatusDot');
	if (hdot) hdot.className = 'sql-status-dot ' + st;
}

// ── DuckDB initialization (lazy — called on first SQL mode activation) ─────
async function initDuckDB() {
	if (initialized || initializing) return;
	initializing = true;
	try {
		setStatus('loading', 'loading wasm\u2026');
		const duckdb = await import('https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm');
		const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
		const workerUrl = URL.createObjectURL(
			new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
		);
		const worker = new Worker(workerUrl);
		duck_db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
		await duck_db.instantiate(bundle.mainModule, bundle.pthreadWorker);
		URL.revokeObjectURL(workerUrl);
		conn = await duck_db.connect();
		await conn.query(`SET enable_progress_bar=false;`);

		setStatus('loading', 'registering sources\u2026');
		userIdb     = await getDatabase();
		userSources = await idbUserGetAll();
		renderSidebar();
		for (const src of SQL_DATASETS) {
			await registerSource(src);
		}
		for (const src of userSources) {
			await registerSource(src);
		}
		// Restore cached row data into EDA for user sources (so ECharts works on reload)
		for (const src of userSources) {
			const cached = await idbUserDataGet(src.alias);
			if (cached && cached.length) injectUserDatasetIntoEDA(src, cached);
		}
		await filterSchemaExplorer();
		initialized  = true;
		initializing = false;
		setStatus('ready', 'ready');
		// Expose query interface so the IIFE can use DuckDB for chart aggregation.
		// All calls are serialized through a single promise chain so concurrent
		// callers (chart render + table page request) never collide on the one connection.
		let _queryChain = Promise.resolve();
		window._edaQuery = (sql) => {
			const result = _queryChain.then(() => conn.query(sql));
			// Reset the chain on error so a failed query doesn't block all future ones.
			_queryChain = result.catch(() => {});
			return result;
		};
		window._edaDuckDBReady = () => initialized;
		// Notify the IIFE so any chart rendered during loading upgrades to SQL
		document.dispatchEvent(new CustomEvent('eda:duckdb-ready'));
		const runBtn = $('sqlRunBtn');
		if (runBtn) runBtn.disabled = false;
		const catalogAddBtn = $('catalogAddSourceBtn');
		if (catalogAddBtn) catalogAddBtn.disabled = false;
	} catch (e) {
		initializing = false;
		setStatus('error', 'init failed');
		console.error('DuckDB init error:', e);
	}
}

// ── Detect file type from URL ─────────────────────────────────────────────
function guessFileType(url) {
	const lower = url.toLowerCase().split('?')[0];
	if (lower.endsWith('.parquet')) return 'parquet';
	if (lower.endsWith('.geojson')) return 'geojson';
	return 'csv';
}

// ── Register a source as a DuckDB view ─────────────────────────────────────
async function registerSource(src) {
	// Local file sources are re-registered from cached IDB rows, not by URL
	if (src.sourceType === 'file') {
		const parquetBytes = await idbBytesGet(src.alias);
		if (parquetBytes) {
			await registerSourceFromParquet(src.alias, parquetBytes);
		} else {
			const cached = await idbUserDataGet(src.alias);
			if (cached && cached.length) await registerSourceFromRows(src.alias, cached);
		}
		return;
	}
	updateBadge(src.alias, 'loading');
	try {
		// Resolve to absolute URL — DuckDB Web Worker has no page-relative directory
		const absUrl = new URL(src.url, location.href).href;
		const ft     = guessFileType(absUrl);
		const expr   = ft === 'parquet'
			? `read_parquet('${absUrl}')`
			: ft === 'geojson'
			? `read_json_auto('${absUrl}')`
			: `read_csv_auto('${absUrl}', header=true)`;
		await conn.query(`CREATE OR REPLACE VIEW "${src.alias}" AS SELECT * FROM ${expr};`);
		updateBadge(src.alias, 'loaded');
		await fetchColumns(src.alias);
	} catch (e) {
		console.warn(`Failed to register ${src.alias}:`, e.message);
		updateBadge(src.alias, 'error');
	}
}

// ── Sidebar rendering ──────────────────────────────────────────────────────
function makeTableItem(src) {
	const wrapper = document.createElement('div');
	wrapper.className = 'sql-table-item-wrapper';
	wrapper.id = `sql-tiw-${src.alias}`;
	wrapper.dataset.sqlAlias = src.alias;

	const item = document.createElement('div');
	item.className = 'sql-table-item';
	item.id = `sql-ti-${src.alias}`;

	const ft   = guessFileType(src.url);
	const icon = ft === 'parquet' ? '&#x25c8;' : '&#x229e;';

	item.innerHTML = `
		<button class="sql-expand-btn" id="sql-exp-${escHtml(src.alias)}" disabled title="Expand columns">&#x25BA;</button>
		<span style="font-size:10px;opacity:0.4;flex-shrink:0">${icon}</span>
		<span class="sql-table-name" title="SQL alias: ${escHtml(src.alias)}">${escHtml(src.title || src.alias)}</span>
		<span class="badge bg-secondary bg-opacity-25 text-secondary ms-auto" id="sql-badge-${escHtml(src.alias)}" style="font-size:10px">&#x2026;</span>
	`;

	item.querySelector('.sql-expand-btn').addEventListener('click', e => { e.stopPropagation(); toggleExpand(src.alias); });
	item.addEventListener('click', e => {
		if (!e.target.closest('.sql-expand-btn')) insertTableRef(src.alias);
	});

	const fieldList = document.createElement('div');
	fieldList.className = 'sql-field-list';
	fieldList.id = `sql-tf-${src.alias}`;
	fieldList.style.display = 'none';

	wrapper.appendChild(item);
	wrapper.appendChild(fieldList);
	return wrapper;
}

function renderSidebar() {
	const list = $('sqlTableList');
	if (!list) return;
	list.innerHTML = '';

	const managedLabel = document.createElement('div');
	managedLabel.className = 'sql-source-label';
	managedLabel.textContent = 'Managed';
	list.appendChild(managedLabel);
	SQL_DATASETS.forEach(src => list.appendChild(makeTableItem(src)));

	if (userSources.length) {
		const userLabel = document.createElement('div');
		userLabel.className = 'sql-source-label';
		userLabel.textContent = 'My Sources';
		list.appendChild(userLabel);
		userSources.forEach(src => list.appendChild(makeTableItem(src)));
	}
	filterSchemaExplorer().catch(error => {
		console.error('Could not refresh schema explorer:', error);
	});
}

async function filterSchemaExplorer() {
	const search = $('sqlSchemaSearch');
	const list = $('sqlTableList');
	const empty = $('sqlSchemaEmpty');
	if (!search || !list) return;
	const query = search.value.trim().toLocaleLowerCase();
	let visibleCount = 0;
	const wrappers = [...list.querySelectorAll('.sql-table-item-wrapper')];

	for (const wrapper of wrappers) {
		const alias = wrapper.dataset.sqlAlias;
		const title = wrapper.querySelector('.sql-table-name')?.textContent || alias;
		const nameMatch = !query || `${title} ${alias}`.toLocaleLowerCase().includes(query);
		const columns = tableColumns.get(alias) || [];
		const matchingColumns = query
			? columns.filter(column => `${column.name} ${column.type}`.toLocaleLowerCase().includes(query))
			: columns;
		const matches = !query || nameMatch || matchingColumns.length > 0;
		wrapper.hidden = !matches;
		if (!matches) continue;
		visibleCount += 1;

		const fieldList = wrapper.querySelector('.sql-field-list');
		const expandButton = wrapper.querySelector('.sql-expand-btn');
		if (query && !nameMatch && matchingColumns.length && fieldList && !fieldList.children.length) {
			await renderFields(alias, fieldList);
		}
		if (query && !nameMatch && matchingColumns.length && fieldList) {
			if (fieldList.style.display === 'none') {
				fieldList.style.display = 'block';
				fieldList.dataset.searchExpanded = 'true';
				expandButton?.classList.add('expanded');
			}
			const matchNames = new Set(matchingColumns.map(column => column.name));
			fieldList.querySelectorAll('.sql-field-item').forEach(row => {
				row.hidden = !matchNames.has(row.dataset.columnName);
			});
		} else if (!query && fieldList) {
			if (fieldList.dataset.searchExpanded === 'true') {
				fieldList.style.display = 'none';
				delete fieldList.dataset.searchExpanded;
				expandButton?.classList.remove('expanded');
			}
			fieldList.querySelectorAll('.sql-field-item').forEach(row => { row.hidden = false; });
		} else if (query && nameMatch && fieldList) {
			fieldList.querySelectorAll('.sql-field-item').forEach(row => { row.hidden = false; });
		}
	}

	if (empty) empty.hidden = !query || visibleCount > 0;
}

function updateBadge(alias, st) {
	const badge = $(`sql-badge-${alias}`);
	if (!badge) return;
	if (st === 'loading') {
		badge.textContent = '\u2026';
		badge.className   = 'badge bg-secondary bg-opacity-25 text-secondary ms-auto';
	} else if (st === 'loaded') {
		badge.textContent = 'ready';
		badge.className   = 'badge bg-success bg-opacity-25 text-success ms-auto';
		const btn = $(`sql-exp-${alias}`);
		if (btn) btn.disabled = false;
	} else {
		badge.textContent = 'error';
		badge.className   = 'badge bg-warning bg-opacity-25 text-warning ms-auto';
	}
}

// ── Copy a source's rows into IndexedDB and inject into EDA ─────────────
async function copySourceToEDA(record) {
	try {
		const absUrl = new URL(record.url, location.href).href;
		const ft     = guessFileType(absUrl);
		let rows     = [];

		if (ft === 'parquet') {
			// Materialise via DuckDB (already registered as a VIEW)
			const res  = await conn.query(`SELECT * FROM "${record.alias}";`);
			const cols = res.schema.fields.map(f => f.name);
			rows = res.toArray().map(r => {
				const obj = {};
				cols.forEach(c => {
					const v = r[c];
					obj[c] = (v === null || v === undefined) ? null
						: typeof v === 'bigint' ? Number(v) : v;
				});
				return obj;
			});
		} else {
			// CSV — prefer the IIFE's full parser if available
			const resp = await fetch(absUrl);
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const text = await resp.text();
			rows = parseCSV(text);
		}

		if (!rows.length) return null;
		await idbUserDataPut(record.alias, rows);
		return rows;
	} catch (e) {
		console.warn(`copySourceToEDA failed for "${record.alias}":`, e.message);
		return null;
	}
}

// Minimal RFC-4180 CSV parser (fallback if IIFE parser unavailable)
function parseCsvSimple(text) {
	if (!text) return [];
	const lines = text.split(/\r?\n/).filter(l => l.trim());
	if (lines.length < 2) return [];
	const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
	return lines.slice(1).map(line => {
		const vals = line.split(',');
		const obj  = {};
		headers.forEach((h, i) => { obj[h] = (vals[i] ?? '').replace(/^"|"$/g, ''); });
		return obj;
	});
}

// Inject rows into the shared dataset registry used by the app and catalog.
function injectUserDatasetIntoEDA(record, rows) {
	if (!window._edaUserDatasets) window._edaUserDatasets = new Map();
	window._edaUserDatasets.set(record.alias, {
		id:    record.alias,
		title: record.title || record.alias,
		rows
	});
}

// Remove the shared dataset registry entry when a source is deleted.
function removeUserDatasetFromEDA(alias) {
	if (window._edaUserDatasets) window._edaUserDatasets.delete(alias);
}

// ── Add / Remove user sources ─────────────────────────────────────────────

// Holds the File object selected by the user in the Local File pane
let _pendingLocalFile = null;

function switchAddSrcTab(paneId) {
	document.querySelectorAll('.add-src-tab').forEach(t =>
		t.classList.toggle('active', t.dataset.pane === paneId));
	document.querySelectorAll('.add-src-pane').forEach(p =>
		p.classList.toggle('active', p.id === paneId));
}

function clearLocalFilePicker() {
	_pendingLocalFile = null;
	const fi = $('sqlLocalFile');
	if (fi) fi.value = '';
	const dz  = $('sqlDropZone');
	const lbl = $('sqlDropLabel');
	if (dz)  dz.classList.remove('has-file');
	if (lbl) lbl.innerHTML = 'Click to browse or drag &amp; drop a file here';
}

function setLocalFile(file) {
	if (!file) return;
	const ext = '.' + file.name.split('.').pop().toLowerCase();
	const allowed = ['.csv', '.parquet', '.geojson', '.json'];
	if (!allowed.includes(ext)) {
		alert(`Unsupported file type: ${ext}\nPlease choose a .csv, .parquet, or .geojson file.`);
		return;
	}
	_pendingLocalFile = file;
	const dz  = $('sqlDropZone');
	const lbl = $('sqlDropLabel');
	if (dz)  dz.classList.add('has-file');
	if (lbl) lbl.textContent = `\u2714 ${file.name}  (${(file.size / 1024).toFixed(1)} KB)`;
	// Auto-fill alias from filename if blank
	const aliasEl = $('sqlNewAlias');
	if (aliasEl && !aliasEl.value.trim()) {
		const base = file.name
			.replace(/\.[^.]+$/, '')
			.replace(/[^a-zA-Z0-9_]/g, '_')
			.replace(/^_+|_+$/g, '');
		aliasEl.value = base;
	}
}

async function readLocalFileRows(file) {
	const text = await file.text();
	return window._edaParseCsv ? window._edaParseCsv(text) : parseCsvSimple(text);
}

// ── GeoJSON helpers ───────────────────────────────────────────────────────
// Peek at a .json file to see if it looks like GeoJSON (type: FeatureCollection)
async function _peekIsGeoJson(file) {
	try {
		const slice = await file.slice(0, 512).text();
		return /"type"\s*:\s*"FeatureCollection"/.test(slice);
	} catch (_) { return false; }
}

// Flatten GeoJSON FeatureCollection.features[].properties into plain row objects.
// Also injects _lat / _lon columns when point geometry is present.
async function readGeoJsonRows(file) {
	const text = await file.text();
	const gj   = JSON.parse(text);
	const features = (gj.type === 'FeatureCollection' ? gj.features : null)
		|| (Array.isArray(gj) ? gj : null);
	if (!features) return [];
	return features
		.filter(f => f && f.properties)
		.map(f => {
			const row = Object.assign({}, f.properties);
			// Inject centroid coords for point features so map tab can use them
			if (f.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates)) {
				row._lon = f.geometry.coordinates[0] ?? null;
				row._lat = f.geometry.coordinates[1] ?? null;
			}
			return row;
		});
}

async function registerSourceFromRows(alias, rows) {
	updateBadge(alias, 'loading');
	if (!rows || !rows.length) { updateBadge(alias, 'error'); return; }
	try {
		// Serialize rows back to CSV and use read_csv_auto so DuckDB correctly
		// expands columns (read_json_auto was producing a single "json" column)
		const headers = Object.keys(rows[0]);
		const escCsv  = v => {
			const s = (v === null || v === undefined) ? '' : String(v);
			return (s.includes(',') || s.includes('"') || s.includes('\n'))
				? '"' + s.replace(/"/g, '""') + '"' : s;
		};
		const csvText = [
			headers.map(escCsv).join(','),
			...rows.map(r => headers.map(h => escCsv(r[h])).join(','))
		].join('\n');
		const buf     = new TextEncoder().encode(csvText);
		const tmpName = `__mem_${alias}.csv`;
		await duck_db.registerFileBuffer(tmpName, buf);
		await conn.query(`CREATE OR REPLACE VIEW "${alias}" AS SELECT * FROM read_csv_auto('${tmpName}', header=true);`);
		updateBadge(alias, 'loaded');
		await fetchColumns(alias);
	} catch (e) {
		console.warn(`registerSourceFromRows failed for "${alias}":`, e.message);
		updateBadge(alias, 'error');
	}
}

// ── Parquet: register file buffer directly as a DuckDB view ──────────────
async function registerSourceFromParquet(alias, bytes) {
	updateBadge(alias, 'loading');
	const tmpName = `__pq_${alias}.parquet`;
	try {
		await duck_db.registerFileBuffer(tmpName, bytes);
		await conn.query(`CREATE OR REPLACE VIEW "${alias}" AS SELECT * FROM read_parquet('${tmpName}');`);
		updateBadge(alias, 'loaded');
		await fetchColumns(alias);
	} catch (e) {
		console.warn(`registerSourceFromParquet failed for "${alias}":`, e.message);
		updateBadge(alias, 'error');
		throw e;
	}
}

// ── Query up to 50 000 rows from a registered DuckDB view ────────────────
async function queryViewRows(alias) {
	try {
		const res  = await conn.query(`SELECT * FROM "${alias}" LIMIT 50000`);
		const cols = res.schema.fields.map(f => f.name);
		return res.toArray().map(r => {
			const obj = {};
			cols.forEach(c => {
				const v = r[c];
				obj[c] = (v === null || v === undefined) ? null
					: typeof v === 'bigint' ? Number(v)
					: ArrayBuffer.isView(v) || Array.isArray(v) ? JSON.stringify(v)
					: v;
			});
			return obj;
		});
	} catch (_) {
		return [];
	}
}

function openAddModal() {
	$('sqlNewAlias').value = '';
	$('sqlNewUrl').value   = '';
	switchAddSrcTab('paneUrl');
	clearLocalFilePicker();
	$('sqlAddModal').classList.add('open');
	setTimeout(() => $('sqlNewAlias').focus(), 80);
}
function closeAddModal() {
	$('sqlAddModal').classList.remove('open');
	clearLocalFilePicker();
}

async function saveNewSource() {
	const rawAlias   = ($('sqlNewAlias').value || '').trim();
	const alias      = rawAlias.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || rawAlias;
	const activePane = document.querySelector('.add-src-pane.active')?.id;
	const isFile     = activePane === 'paneFile';
	const url        = isFile ? '' : ($('sqlNewUrl').value || '').trim();

	if (!alias)                          { alert('Please provide a table alias.'); return; }
	if (!isFile && !url)                 { alert('Please provide a file URL.');    return; }
	if (isFile && !_pendingLocalFile)    { alert('Please select a local file.');  return; }

	const allAliases = [...SQL_DATASETS.map(s => s.alias), ...userSources.map(s => s.alias)];
	if (allAliases.includes(alias)) {
		alert(`Alias "${alias}" already exists. Please choose a different name.`);
		return;
	}

	const saveBtn  = $('sqlAddModalSave');
	const origHTML = saveBtn.innerHTML;
	saveBtn.disabled  = true;
	saveBtn.innerHTML = '<span class="sql-spinner"></span> Loading…';

	try {
		if (isFile) {
			saveBtn.innerHTML = '<span class="sql-spinner"></span> Reading file…';
			const ext = _pendingLocalFile.name.split('.').pop().toLowerCase();

			const record = {
				alias,
				title:      alias,
				url:        '',
				fileName:   _pendingLocalFile.name,
				sourceType: 'file',
				addedAt:    Date.now()
			};

			if (ext === 'parquet') {
				saveBtn.innerHTML = '<span class="sql-spinner"></span> Registering parquet…';
				const buffer = await _pendingLocalFile.arrayBuffer();
				const bytes  = new Uint8Array(buffer);
				await idbUserPut(record);
				await idbBytesPut(alias, bytes);
				await registerSourceFromParquet(alias, bytes);
				// Cache a row sample for JS-side chart fallback; best-effort
				const edaRows = await queryViewRows(alias);
				if (edaRows.length) await idbUserDataPut(alias, edaRows);
				injectUserDatasetIntoEDA(record, edaRows);
			} else if (ext === 'geojson' || (ext === 'json' && await _peekIsGeoJson(_pendingLocalFile))) {
				saveBtn.innerHTML = '<span class="sql-spinner"></span> Parsing GeoJSON…';
				const rows = await readGeoJsonRows(_pendingLocalFile);
				if (!rows.length) throw new Error('GeoJSON file has no features with properties, or could not be parsed.');
				await idbUserPut(record);
				await idbUserDataPut(alias, rows);
				await registerSourceFromRows(alias, rows);
				injectUserDatasetIntoEDA(record, rows);
			} else {
				const rows = await readLocalFileRows(_pendingLocalFile);
				if (!rows.length) throw new Error('File appears to be empty or could not be parsed.');
				await idbUserPut(record);
				await idbUserDataPut(alias, rows);
				await registerSourceFromRows(alias, rows);
				injectUserDatasetIntoEDA(record, rows);
			}

			userSources = await idbUserGetAll();
			userSources.sort((a, b) => a.addedAt - b.addedAt);
			closeAddModal();
			renderSidebar();
			[...SQL_DATASETS, ...userSources.filter(s => s.alias !== alias)]
				.forEach(s => updateBadge(s.alias, tableColumns.has(s.alias) ? 'loaded' : 'error'));
			updateBadge(alias, 'loaded');
		} else {
			const record = { alias, title: alias, url, sourceType: 'url', addedAt: Date.now() };
			await idbUserPut(record);
			userSources = await idbUserGetAll();
			userSources.sort((a, b) => a.addedAt - b.addedAt);

			closeAddModal();
			renderSidebar();
			[...SQL_DATASETS, ...userSources.filter(s => s.alias !== alias)]
				.forEach(s => updateBadge(s.alias, tableColumns.has(s.alias) ? 'loaded' : 'error'));

			await registerSource(record);

			saveBtn.innerHTML = '<span class="sql-spinner"></span> Copying to EDA…';
			const rows = await copySourceToEDA(record);
			if (rows && rows.length) injectUserDatasetIntoEDA(record, rows);
		}
		window._edaRenderCatalog?.();
	} catch (e) {
		alert(`Could not add source:\n${e.message}`);
	} finally {
		saveBtn.disabled  = false;
		saveBtn.innerHTML = origHTML;
	}
}

async function removeUserSource(alias) {
	if (!confirm(`Remove "${alias}" from your sources?\nThis only affects your browser.`)) return false;
	if (!userIdb) {
		userIdb = await getDatabase();
		userSources = await idbUserGetAll();
	}
	await idbUserDelete(alias);
	await idbUserDataDelete(alias);
	await idbBytesDelete(alias);
	if (conn) {
		try {
			await conn.query(`DROP VIEW IF EXISTS "${alias}";`);
		} catch (error) {
			console.warn(`Could not drop DuckDB view for "${alias}":`, error);
		}
	}
	tableColumns.delete(alias);
	userSources = userSources.filter(s => s.alias !== alias);
	removeUserDatasetFromEDA(alias);
	window._edaRenderCatalog?.();
	renderSidebar();
	SQL_DATASETS.forEach(s => updateBadge(s.alias, tableColumns.has(s.alias) ? 'loaded' : 'error'));
	userSources.forEach(s  => updateBadge(s.alias,  tableColumns.has(s.alias)  ? 'loaded' : 'error'));
	return true;
}

// ── Column fetching & field browser ───────────────────────────────────────
async function fetchColumns(alias) {
	try {
		const res  = await conn.query(`DESCRIBE "${alias}";`);
		const rows = res.toArray();
		tableColumns.set(alias, rows.map(r => ({
			name: String(r.column_name),
			type: String(r.column_type)
		})));
	} catch (e) {
		console.warn(`Could not describe ${alias}:`, e.message);
	}
}

async function toggleExpand(alias) {
	const fieldList = $(`sql-tf-${alias}`);
	const expBtn    = $(`sql-exp-${alias}`);
	if (!fieldList) return;
	const isOpen = fieldList.style.display !== 'none';
	if (isOpen) {
		fieldList.style.display = 'none';
		expBtn?.classList.remove('expanded');
	} else {
		if (!fieldList.children.length) await renderFields(alias, fieldList);
		fieldList.style.display = 'block';
		expBtn?.classList.add('expanded');
	}
}

async function renderFields(alias, container) {
	const cols = tableColumns.get(alias);
	if (!cols || !cols.length) {
		container.innerHTML = '<div class="sql-field-item" style="cursor:default;font-style:italic;color:#aaa">no columns</div>';
		return;
	}

	// Fetch BI settings for managed datasets to classify columns as dimension/metric
	const isManaged = SQL_DATASETS.some(s => s.alias === alias);
	if (isManaged && !sqlSettingsCache.has(alias)) {
		try {
			const resp = await fetch(`data/report/${alias}/${alias}-bi-settings.json`, { cache: 'no-cache' }).catch(() => null);
			sqlSettingsCache.set(alias, resp?.ok ? await resp.json() : null);
		} catch (_) {
			sqlSettingsCache.set(alias, null);
		}
	}
	const settings = isManaged ? sqlSettingsCache.get(alias) : null;

	const kindIcon  = k => k === 'dimension' ? '&#9783;' : (k === 'metric' ? '#' : '&ndash;');
	const kindLabel = k => k === 'dimension' ? 'dim' : (k === 'metric' ? 'num' : '');

	container.innerHTML = '';
	cols.forEach(c => {
		const kind = (settings?.dimensions || []).includes(c.name) ? 'dimension'
		           : (settings?.metrics    || []).includes(c.name) ? 'metric'
		           : 'column';
		const row = document.createElement('div');
		row.className = 'catalog-field-row';
		row.classList.add('sql-field-item');
		row.dataset.columnName = c.name;
		row.dataset.columnType = c.type;
		row.style.cssText = 'cursor:pointer';
		row.title = `Insert "${alias}"."${c.name}"`;
		row.innerHTML = `<span class="catalog-field-icon">${kindIcon(kind)}</span>`
			+ `<span class="catalog-field-name" title="${escHtml(c.name)}">${escHtml(c.name)}</span>`
			+ `<span class="catalog-field-type">${escHtml(c.type.split('(')[0])}</span>`
			+ (kindLabel(kind) ? `<span class="catalog-field-kind">${kindLabel(kind)}</span>` : '');
		row.addEventListener('click', e => { e.stopPropagation(); insertFieldRef(alias, c.name); });
		container.appendChild(row);
	});
}

// ── Editor insertion helpers ──────────────────────────────────────────────
function insertTableRef(alias) {
	const ta  = $('sqlEditorTA');
	if (!ta) return;
	const val = ta.value.trim();
	if (!val) {
		ta.value = `SELECT *\nFROM "${alias}"\nLIMIT 100;`;
	} else {
		const pos = ta.selectionStart;
		ta.value = ta.value.slice(0, pos) + `"${alias}"` + ta.value.slice(pos);
	}
	ta.focus();
	updateLineNums();
	document.querySelectorAll('.sql-table-item').forEach(el => el.classList.remove('active'));
	$(`sql-ti-${alias}`)?.classList.add('active');
}

function insertFieldRef(alias, field) {
	const ta  = $('sqlEditorTA');
	if (!ta) return;
	const quoted = `"${alias}"."${field}"`;
	const pos = ta.selectionStart;
	ta.value = ta.value.slice(0, pos) + quoted + ta.value.slice(pos);
	ta.selectionStart = ta.selectionEnd = pos + quoted.length;
	ta.focus();
	updateLineNums();
}

// ── Query execution ────────────────────────────────────────────────────────
async function runQuery() {
	if (!conn) return;
	const sql = $('sqlEditorTA')?.value.trim();
	if (!sql) return;

	const runBtn = $('sqlRunBtn');
	if (runBtn) { runBtn.disabled = true; runBtn.innerHTML = '<span class="sql-spinner"></span> Running'; }
	setStatus('loading', 'executing\u2026');
	const rowCountEl = $('sqlRowCount');
	const execTimeEl = $('sqlExecTime');
	const exportBtn  = $('sqlExportBtn');
	if (rowCountEl) rowCountEl.textContent = '';
	if (execTimeEl) execTimeEl.textContent = '';
	$('sqlResultsContainer').innerHTML =
		'<div class="sql-state-msg"><span class="sql-spinner" style="width:20px;height:20px;border-width:3px"></span></div>';

	const t0 = performance.now();
	try {
		const result  = await conn.query(sql);
		const elapsed = ((performance.now() - t0) / 1000).toFixed(3);
		renderResults(result, elapsed);
		setStatus('ready', 'ready');
	} catch (e) {
		const elapsed = ((performance.now() - t0) / 1000).toFixed(3);
		$('sqlResultsContainer').innerHTML =
			`<div class="sql-state-msg"><span style="font-size:20px">\u26A0</span><span style="color:#dc3545;max-width:90%;text-align:center;line-height:1.6">${escHtml(e.message)}</span></div>`;
		if (execTimeEl) execTimeEl.textContent = `${elapsed}s`;
		setStatus('error', 'query error');
	} finally {
		if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '\u25BA Run'; }
	}
}

// Make runQuery accessible to inline onclick (though we use addEventListener below)
window._sqlWBRunQuery = runQuery;

function renderResults(result, elapsed) {
	const schema = result.schema;
	const rows   = result.toArray();
	const execTimeEl = $('sqlExecTime');
	const rowCountEl = $('sqlRowCount');
	const exportBtn  = $('sqlExportBtn');

	if (execTimeEl) execTimeEl.textContent = `${elapsed}s`;

	lastResult = null;
	if (exportBtn) exportBtn.style.display = 'none';

	// Destroy any previous Tabulator before touching the container DOM
	if (sqlTabulator) {
		try { sqlTabulator.destroy(); } catch (_) {}
		sqlTabulator = null;
	}

	if (!rows.length) {
		if (rowCountEl) rowCountEl.textContent = '0 rows';
		$('sqlResultsContainer').innerHTML =
			'<div class="sql-state-msg"><span style="font-size:20px">\u2205</span><span>Query returned 0 rows</span></div>';
		return;
	}

	// Arrow type IDs: Date_=8, Timestamp=10, Time=11, Interval=12
	const cols = schema.fields.map(f => {
		const typeId = f.type?.typeId ?? -1;
		// Timestamp unit: 0=s, 1=ms, 2=µs (DuckDB default), 3=ns
		const tsUnit = (typeId === 10) ? (f.type?.unit ?? 2) : null;
		// Date unit: 0=day, 1=ms
		const dateUnit = (typeId === 8) ? (f.type?.unit ?? 0) : null;
		return { name: f.name, type: f.type?.toString() || '', typeId, tsUnit, dateUnit };
	});
	const truncated = rows.length > SQL_ROW_LIMIT;
	const preview   = truncated ? rows.slice(0, SQL_ROW_LIMIT) : rows;

	if (rowCountEl) {
		rowCountEl.textContent = truncated
			? `${SQL_ROW_LIMIT.toLocaleString()} of ${rows.length.toLocaleString()} rows (preview capped — use LIMIT in your query for full control)`
			: `${rows.length.toLocaleString()} row${rows.length !== 1 ? 's' : ''}`;
		rowCountEl.style.color = truncated ? '#dc6c00' : '';
	}

	// Convert a raw Arrow timestamp/date BigInt to a readable local string
	function arrowTemporalToStr(raw, col) {
		try {
			let ms;
			if (col.typeId === 10) {
				// Timestamp
				const n = typeof raw === 'bigint' ? raw : BigInt(raw);
				if      (col.tsUnit === 0) ms = Number(n) * 1000;        // seconds
				else if (col.tsUnit === 1) ms = Number(n);               // milliseconds
				else if (col.tsUnit === 2) ms = Number(n) / 1000;        // microseconds
				else                       ms = Number(n) / 1_000_000;   // nanoseconds
			} else {
				// Date_
				const n = typeof raw === 'bigint' ? Number(raw) : raw;
				ms = col.dateUnit === 0 ? n * 86400000 : n;              // days or ms
			}
			const d = new Date(ms);
			if (isNaN(d.getTime())) return String(raw);
			// Show date-only for Date_ columns, full datetime for Timestamp
			if (col.typeId === 8) return d.toLocaleDateString();
			// Omit seconds+ms when they're zero for a cleaner display
			return d.toLocaleString(undefined, {
				year:'numeric', month:'2-digit', day:'2-digit',
				hour:'2-digit', minute:'2-digit',
				hour12: false
			});
		} catch (_) { return String(raw); }
	}

	// Convert Arrow rows to plain JS objects for Tabulator
	const tabulatorData = preview.map(row => {
		const obj = {};
		cols.forEach(c => {
			const raw = row[c.name];
			if (raw === null || raw === undefined) {
				obj[c.name] = null;
			} else if (c.typeId === 10 || c.typeId === 8) {
				obj[c.name] = arrowTemporalToStr(raw, c);
			} else if (typeof raw === 'bigint') {
				obj[c.name] = Number(raw);
			} else {
				obj[c.name] = raw;
			}
		});
		return obj;
	});

	lastResult = { cols, rows: tabulatorData };
	if (exportBtn) exportBtn.style.display = '';

	// Clear container and mount Tabulator — same config as the main EDA data table
	$('sqlResultsContainer').innerHTML = '';
	sqlTabulator = new Tabulator($('sqlResultsContainer'), {
		data: tabulatorData,
		layout: 'fitDataStretch',
		height: '350px',
		pagination: 'local',
		paginationSize: 15,
		paginationSizeSelector: [15, 25, 50, 100],
		resizableColumns: true,
		autoColumns: false,
		placeholder: 'No rows to display.',
		columns: cols.map(c => ({
			title: c.name,
			field: c.name,
			headerFilter: 'input',
			headerFilterPlaceholder: 'Filter…',
			headerSort: true,
			minWidth: 120,
			formatter: cell => {
				const v = cell.getValue();
				if (v === null || v === undefined)
					return '<span style="color:#adb5bd;font-style:italic">null</span>';
				return escHtml(String(v));
			}
		}))
	});
}

// ── CSV export ─────────────────────────────────────────────────────────────
function exportCSV() {
	if (!lastResult) return;
	const { cols, rows } = lastResult;
	const esc = v => {
		if (v === null || v === undefined) return '';
		const s = typeof v === 'bigint' ? String(v) : String(v);
		return (s.includes(',') || s.includes('"') || s.includes('\n'))
			? `"${s.replace(/"/g, '""')}"`
			: s;
	};
	const lines = [
		cols.map(c => esc(c.name)).join(','),
		...rows.map(row => cols.map(c => esc(row[c.name])).join(','))
	];
	const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
	const a = Object.assign(document.createElement('a'), {
		href: URL.createObjectURL(blob),
		download: `eda_sql_${Date.now()}.csv`
	});
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(a.href);
}

// ── Cell styling helpers ───────────────────────────────────────────────────
function cellClass(val, type) {
	if (val === null || val === undefined) return 'td-null';
	const t = (type || '').toLowerCase();
	if (t.includes('int') || t.includes('float') || t.includes('double') || t.includes('decimal')) return 'td-num';
	if (t.includes('bool')) return 'td-bool';
	if (typeof val === 'number') return 'td-num';
	if (typeof val === 'boolean') return 'td-bool';
	return '';
}

function formatCell(val) {
	if (val === null || val === undefined)
		return '<span class="text-secondary fst-italic">null</span>';
	if (typeof val === 'bigint') return String(val);
	return escHtml(String(val));
}

function typeShort(t) {
	const s = (t || '').toLowerCase();
	if (s.includes('int'))                                   return 'int';
	if (s.includes('float') || s.includes('double'))        return 'float';
	if (s.includes('varchar') || s.includes('utf8') || s.includes('string')) return 'str';
	if (s.includes('bool'))                                  return 'bool';
	if (s.includes('date'))                                  return 'date';
	if (s.includes('timestamp'))                             return 'ts';
	return '';
}

function escHtml(str) {
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// ── Line-number counter ────────────────────────────────────────────────────
function updateLineNums() {
	const ta   = $('sqlEditorTA');
	const nums = $('sqlLineNums');
	if (!ta || !nums) return;
	const lines = (ta.value.match(/\n/g) || []).length + 1;
	nums.innerHTML = Array.from({ length: lines }, (_, i) => i + 1).join('<br>');
}

// ── Resizable editor ───────────────────────────────────────────────────────
function initResizer() {
	const resizer    = $('sqlResizer');
	const editorWrap = $$('.sql-editor-container');
	if (!resizer || !editorWrap) return;
	let isResizing = false;
	resizer.addEventListener('mousedown', () => {
		isResizing = true;
		document.body.style.cursor = 'ns-resize';
	});
	document.addEventListener('mousemove', e => {
		if (!isResizing) return;
		const top  = editorWrap.getBoundingClientRect().top;
		const newH = Math.max(80, Math.min(520, e.clientY - top));
		const ta   = $('sqlEditorTA');
		const nums = $('sqlLineNums');
		if (ta)   ta.style.height   = newH + 'px';
		if (nums) nums.style.height = newH + 'px';
	});
	document.addEventListener('mouseup', () => {
		isResizing = false;
		document.body.style.cursor = '';
	});
}

// ── Wire up all DOM events after page load ─────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
	$('sqlRunBtn')?.addEventListener('click', runQuery);
	$('sqlSchemaSearch')?.addEventListener('input', () => {
		filterSchemaExplorer().catch(error => {
			console.error('Schema search failed:', error);
			const empty = $('sqlSchemaEmpty');
			if (empty) {
				empty.hidden = false;
				empty.textContent = `Schema search failed: ${error.message}`;
			}
		});
	});

	$('sqlClearBtn')?.addEventListener('click', () => {
		const ta = $('sqlEditorTA');
		if (ta) { ta.value = ''; updateLineNums(); ta.focus(); }
	});

	$('sqlExampleBtn')?.addEventListener('click', () => {
		const ta = $('sqlEditorTA');
		if (ta) {
			ta.value = `SELECT *\nFROM "eda_construction_procurement"\nLIMIT 100;`;
			updateLineNums();
			ta.focus();
		}
	});

	$('sqlExportBtn')?.addEventListener('click', exportCSV);

	$('catalogAddSourceBtn')?.addEventListener('click', openAddModal);
	$('sqlAddModalClose')?.addEventListener('click',  closeAddModal);
	$('sqlAddModalCancel')?.addEventListener('click', closeAddModal);
	$('sqlAddModalSave')?.addEventListener('click',   saveNewSource);
	$('sqlAddModal')?.addEventListener('click', e => { if (e.target === $('sqlAddModal')) closeAddModal(); });

	// About modal
	const openAbout  = () => $('aboutModal')?.classList.add('open');
	const closeAbout = () => $('aboutModal')?.classList.remove('open');
	$('aboutBtn')?.addEventListener('click', openAbout);
	$('aboutModalClose')?.addEventListener('click', closeAbout);
	$('aboutModalOk')?.addEventListener('click',    closeAbout);
	$('aboutModal')?.addEventListener('click', e => { if (e.target === $('aboutModal')) closeAbout(); });
	$('sqlNewUrl')?.addEventListener('keydown',   e => { if (e.key === 'Enter') saveNewSource(); });
	$('sqlNewAlias')?.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			const activePane = document.querySelector('.add-src-pane.active')?.id;
			if (activePane === 'paneUrl') $('sqlNewUrl')?.focus();
			else saveNewSource();
		}
	});
	// Add Source modal — tab switching
	$('addSrcTabs')?.addEventListener('click', e => {
		const tab = e.target.closest('.add-src-tab');
		if (tab) switchAddSrcTab(tab.dataset.pane);
	});
	// Drop zone — click to open file browser
	$('sqlDropZone')?.addEventListener('click', () => $('sqlLocalFile')?.click());
	// File input change
	$('sqlLocalFile')?.addEventListener('change', e => {
		const file = e.target.files?.[0];
		if (file) setLocalFile(file);
	});
	// Drag and drop onto the drop zone
	$('sqlDropZone')?.addEventListener('dragover', e => {
		e.preventDefault();
		$('sqlDropZone').classList.add('drag-over');
	});
	$('sqlDropZone')?.addEventListener('dragleave', e => {
		if (!$('sqlDropZone').contains(e.relatedTarget))
			$('sqlDropZone').classList.remove('drag-over');
	});
	$('sqlDropZone')?.addEventListener('drop', e => {
		e.preventDefault();
		$('sqlDropZone').classList.remove('drag-over');
		const file = e.dataTransfer?.files?.[0];
		if (file) setLocalFile(file);
	});

	const ta = $('sqlEditorTA');
	if (ta) {
		ta.addEventListener('input', updateLineNums);
		ta.addEventListener('scroll', () => {
			const n = $('sqlLineNums');
			if (n) n.scrollTop = ta.scrollTop;
		});
		ta.addEventListener('keydown', e => {
			if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
				e.preventDefault();
				if (!$('sqlRunBtn')?.disabled) runQuery();
			}
			if (e.key === 'Tab') {
				e.preventDefault();
				const s = ta.selectionStart;
				ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
				ta.selectionStart = ta.selectionEnd = s + 2;
				updateLineNums();
			}
		});
	}

	initResizer();
	updateLineNums();
});

// ── Exposed for the main module's Refresh button ──────────────────────────────────────
// Re-fetches a user-added source from its original URL, updates IDB, and
// refreshes window._edaUserDatasets so the calling code can reload the table.
window._edaRefreshUserSource = async function(alias) {
	try {
		if (!userIdb) userIdb = await getDatabase();
		const sources = await idbUserGetAll();
		const record  = sources.find(s => s.alias === alias);
		if (!record) return null;
		// Local file sources have no URL — reload rows directly from IDB cache
		if (record.sourceType === 'file') {
			const cached = await idbUserDataGet(alias);
			if (cached && cached.length) {
				injectUserDatasetIntoEDA(record, cached);
				return cached;
			}
			return null;
		}
		// For Parquet sources DuckDB must be initialized (it's the fetcher).
		if (guessFileType(record.url) === 'parquet' && !initialized) {
			await initDuckDB();
		}
		const rows = await copySourceToEDA(record);
		if (rows && rows.length) injectUserDatasetIntoEDA(record, rows);
		return rows;
	} catch (e) {
		console.warn('_edaRefreshUserSource error:', e);
		return null;
	}
};

window._edaGetUserRecord = async function(alias) {
	if (!userIdb) userIdb = await getDatabase();
	const sources = await idbUserGetAll();
	return sources.find(s => s.alias === alias) ?? null;
};

/**
 * Describe a table/view via DuckDB DESCRIBE — used by the Catalog schema panel.
 * Initializes DuckDB lazily so the WASM bundle is only downloaded on first call.
 * Returns [{name, type}] on success, or null if the source is unknown.
 */
window._edaDescribeTable = async function(alias) {
	if (!initialized) await initDuckDB();
	// Already described during SQL init
	if (tableColumns.has(alias)) return tableColumns.get(alias);
	// Source may not be registered yet (e.g. catalog opened before SQL tab)
	const src = SQL_DATASETS.find(s => s.alias === alias);
	if (src) {
		await registerSource(src);
		if (tableColumns.has(alias)) return tableColumns.get(alias);
	}
	return null;
};

// ── Fired by the main EDA script when user clicks the SQL button ─────────────────
// DuckDB is initialized lazily so the WASM bundle is only downloaded on demand.
document.addEventListener('eda:sql-activate', async () => {
	if (!initialized && !initializing) {
		await initDuckDB();
	}
});
// Eager init — DuckDB starts loading immediately at page load instead of
// waiting for the first SQL tab click. Charts and the Data Catalog schema
// use SQL-driven aggregation as soon as the WASM bundle is available.
document.addEventListener('DOMContentLoaded', () => { initDuckDB(); });
