import {
	buildShareUrl,
	CHART_TYPE_TO_SHARE,
	isPresetDatasetId,
	normalizeShareToken,
	parseSharedState
} from './share.mjs';
import {
	getDatabase,
	deleteSavedQuery,
	readSavedQueries,
	saveSavedQuery,
	readWorkspaceCanvases,
	writeWorkspaceCanvases
} from './data-store.mjs';
import {
	DATA_ROOT,
	fetchJSON,
	parseCSV
} from './dataset-loader.mjs';
import {
	buildChartOption,
	buildSqlAggExpr,
	prepareSeries,
	sortSeries
} from './chart-engine.mjs';
import {
	readWorkspacePreferences,
	writeWorkspacePreferences
} from './workspace-preferences.mjs';
import { CANVAS_TYPES, createCanvas, normalizeCanvas } from './canvas-state.mjs';
import { detectCoordinateFields } from './map-utils.mjs';

(function () {
	'use strict';

	const MAP_ALL_OPTION = '__all__';
	// ECharts 5 default palette — used for both charts and map markers so colors stay consistent
	const CHART_PALETTE = ['#5470c6','#91cc75','#fac858','#ee6666','#73c0de','#3ba272','#fc8452','#9a60b4','#ea7ccc'];
	const DATASETS = [
		{ id: 'eda_assets_bridge_condition_owner_area', title: 'Assets Bridge Conditions', description: 'The most up-to-date inventory of Kentucky bridges, including attributes and classifications used for management and maintenance. Data supplied by Kentucky Transportation Cabinet. Browse datasets at https://trak.kytc.ky.gov/data-hub' },
		{ id: 'eda_awarded_projects', title: 'Awarded Projects', description: 'Transportation improvement projects awarded to construction, including all awarded contracts from the past six years and Alternative Delivery. Data supplied by Kentucky Transportation Cabinet. Browse datasets at https://trak.kytc.ky.gov/data-hub' },
		{ id: 'eda_construction_procurement', title: 'Construction Procurement', description: 'Awarded contracts from the past six years, including Alternative Delivery. Data supplied by Kentucky Transportation Cabinet. Browse datasets at https://trak.kytc.ky.gov/data-hub' },
		{ id: 'eda_current_enact_plan_data_set', title: 'Current Enact Plan Data Set', description: 'The most recent Highway Enacted Plan. Data supplied by Kentucky Transportation Cabinet. Browse datasets at https://trak.kytc.ky.gov/data-hub' },
		{ id: 'eda_expenditures', title: 'Expenditures', description: 'Expenditures over the last six years. Data supplied by Kentucky Transportation Cabinet. Browse datasets at https://trak.kytc.ky.gov/data-hub' },
		{ id: 'eda_programmanagement_authorized_detailed', title: 'Authorized Dollars', description: 'Approved authorizations from Program Management over the past six years. Data supplied by Kentucky Transportation Cabinet. Browse datasets at https://trak.kytc.ky.gov/data-hub' },
		{ id: 'export-bi-agency-construction-change-orders-dataview', title: 'Agency Construction Change Orders', description: 'Matches the Change Orders dashboard Data View. Data supplied by Kentucky Transportation Cabinet. Dashboard: https://trak.kytc.ky.gov/ProjectDelivery_ChangeOrders' },
		{ id: 'export-bi-agency-constructionprocurement-altdelivery-dataview', title: 'Agency Construction Procurement Alt Delivery', description: 'Matches the Awarded Projects Alternative Delivery dashboard Data View. Data supplied by Kentucky Transportation Cabinet. Dashboard: https://trak.kytc.ky.gov/Awarded_Projects' },
		{ id: 'export-bi-agency-constructionprocurement-dataview', title: 'Agency Construction Procurement', description: 'Matches the Awarded Projects dashboard Data View. Data supplied by Kentucky Transportation Cabinet. Dashboard: https://trak.kytc.ky.gov/Awarded_Projects' },
		{ id: 'export-bi-agency-maintenance-roadwayweather-machinehours-dataview', title: 'Agency Maintenance Roadway Weather Machine Hours', description: 'Matches the Snow and Ice dashboard Data View. Data supplied by Kentucky Transportation Cabinet. Dashboard: https://trak.kytc.ky.gov/Maintenance_SNIC' },
		{ id: 'export-bi-agency-toc-roadwayweather-roadwayreport-dataview', title: 'Agency TOC Roadway Weather Roadway Report', description: 'Matches the Road Closures dashboard Data View. VPN required. Data supplied by Kentucky Transportation Cabinet. Dashboard: https://trak.kytc.ky.gov/Internal_RoadClosures' },
		{ id: 'export-bi-analysis-planning-systemmobility-dataview', title: 'Analysis Planning System Mobility', description: 'Matches the Travel Flow dashboard Data View. Data supplied by Kentucky Transportation Cabinet. Dashboard: https://trak.kytc.ky.gov/Travel_Flow' },
		{ id: 'export-bi-analysis-programmanagement-cost-change-dataview', title: 'Analysis Program Management Cost Change', description: 'Program Management cost change data view. Data supplied by Kentucky Transportation Cabinet. Browse datasets at https://trak.kytc.ky.gov/data-hub' },
		{ id: 'export-bi-analysis-roadwayweatherevents-expenditures-dataview', title: 'Analysis Roadway Weather Events Expenditures', description: 'Matches the Emergency Response dashboard Data View. Data supplied by Kentucky Transportation Cabinet. Dashboard: https://trak.kytc.ky.gov/Maintenance_EmergencyResponse' },
		{ id: 'export-bi-economic-fueltyperegistration-dataview', title: 'Economic Fuel Type Registration', description: 'Matches the Vehicle Registrations dashboard Data View. Data supplied by Kentucky Transportation Cabinet. Dashboard: https://trak.kytc.ky.gov/VehicleRegistrations' }
	];
	const DUCKDB_DATASET_IDS = new Set(DATASETS.map(dataset => dataset.id));
	const APP_VERSION = '1.5.0';
	const PRESET_DATASET_SLUGS = {
		eda_assets_bridge_condition_owner_area: 'assets_bridge_condition_owner_area',
		eda_construction_procurement: 'construction_procurement',
		eda_current_enact_plan_data_set: 'current_enacted_plan',
		eda_programmanagement_authorized_detailed: 'programmanagement_authorized_detailed'
	};
	const state = {
		datasetId: null,
		settings: null,
		index: null,
		allRows: [],
		chartType: 'bar-horizontal',
		chartInstance: null,
		mapInstance: null,
		mapLayer: null,
		tabulator: null,
		lastLoadedAt: null,
		chartFilter: null,   // { field, value, seriesIndex, dataIndex } | null
		_renderSeq: 0,       // incremented on each renderVisual() call; guards async chart renders
		tableDuckDB: false,  // true when Tabulator is in DuckDB remote-paging mode
		hiddenColumns: new Set(),   // columns toggled off in the table view
		mapConfig: {
			saved: false,
			latField: null,
			lonField: null,
			filterFields: [null, null, null],
			colorField: null
		},
		mapOptions: {
			cluster: true,
			filterValues: [MAP_ALL_OPTION, MAP_ALL_OPTION, MAP_ALL_OPTION],
			popupHidden: new Set(),
			tableHidden: new Set()
		}
	};

	function isDuckDBDataset(datasetId = state.datasetId) {
		return DUCKDB_DATASET_IDS.has(datasetId);
	}

	function getDatasetColumns(datasetId = state.datasetId) {
		if (datasetId === state.datasetId && state.allRows.length) {
			return Object.keys(state.allRows[0]);
		}
		return (window._edaTableColumns?.get(datasetId) || []).map(column => column.name);
	}

	function hasMapData(datasetId = state.datasetId) {
		const columns = getDatasetColumns(datasetId);
		const coordinates = detectCoordinateFields(columns);
		return Boolean(coordinates.latitude && coordinates.longitude);
	}

	let startupShareState = null;
	let startupWorkspacePreferences = null;
	let savedQueries = [];
	let canvases = [];
	let activeCanvasId = null;
	let canvasSaveChain = Promise.resolve();
	let workspaceSaveTimer = null;
	let canvasActivationSequence = 0;
	let datasetLoadSequence = 0;
	let datasetLoadPending = false;
	let chartResizeObserver = null;
	let tableControlsResizeObserver = null;

	document.addEventListener('DOMContentLoaded', init);

	async function init() {
		const verEl = document.getElementById('appVersion');
		if (verEl) verEl.textContent = `v${APP_VERSION}`;
		startupShareState = parseSharedState(window.location.search, DATASETS, PRESET_DATASET_SLUGS);
		try {
			startupWorkspacePreferences = readWorkspacePreferences();
		} catch (error) {
			console.warn('Could not restore workspace preferences:', error);
		}
		bindUIEvents();
		initializeChartSizing();
		initializeTableControlsSizing();
		// Restore any user-added datasets from IndexedDB before the first
		// dataset selection so they appear in the docked tree immediately.
		await loadPersistedUserDatasets();
		await loadSavedQueries();
		renderCatalog();
		const restoredWorkspace = await loadWorkspace();
		if (canvases.length) {
			const availableDatasetIds = new Set([
				...DATASETS.map(dataset => dataset.id),
				...(window._edaUserDatasets?.keys() || [])
			]);
			const canvas = activeCanvas();
			if (startupShareState?.datasetId && availableDatasetIds.has(startupShareState.datasetId)) {
				canvas.datasetId = startupShareState.datasetId;
				if (startupShareState.chartType === 'map') canvas.type = 'map-all-in-one';
				if (startupShareState.chartType === 'sql') canvas.type = 'sql';
			} else if (canvas.datasetId && !availableDatasetIds.has(canvas.datasetId)) {
				canvas.datasetId = null;
			} else if (!restoredWorkspace && !canvas.datasetId) {
				canvas.datasetId = [
					startupWorkspacePreferences?.datasetId,
					DATASETS[0]?.id
				].find(datasetId => datasetId && availableDatasetIds.has(datasetId)) || null;
			}
			renderCanvasTabs();
			updateCanvasContextToolbar();
			updateCanvasLayout();
			await activateCanvas(canvas.id, { initial: true });
			if (startupShareState) {
				applySharedStateToDashboard(startupShareState);
				window.history.replaceState(null, '', `${window.location.origin}${window.location.pathname}`);
				startupShareState = null;
			}
			await persistWorkspace();
		}
	}

	async function loadWorkspace() {
		let saved;
		try {
			saved = await readWorkspaceCanvases();
		} catch (error) {
			console.error('Could not restore canvas workspace:', error);
			updateProgress(`Could not restore saved canvases: ${error.message}`);
		}
		canvases = (saved?.canvases || []).map(normalizeCanvas).filter(Boolean);
		if (!canvases.length) {
			const initial = createCanvas('all-in-one', 1, {
				datasetId: startupShareState?.datasetId
					|| startupWorkspacePreferences?.datasetId
					|| DATASETS[0]?.id
					|| null
			});
			if (startupWorkspacePreferences) {
				initial.chartType = startupWorkspacePreferences.chartType;
				initial.controls = { ...startupWorkspacePreferences.controls };
			}
			canvases = [initial];
		}
		activeCanvasId = canvases.some(canvas => canvas.id === saved?.activeCanvasId)
			? saved.activeCanvasId
			: canvases[0].id;
		return Boolean(saved?.canvases?.length);
	}

	function activeCanvas() {
		return canvases.find(canvas => canvas.id === activeCanvasId) || null;
	}

	function canvasTypeLabel(type) {
		return {
			'all-in-one': 'All in One',
			'graph-only': 'Graph Only',
			'table-only': 'Table Only',
			'map-all-in-one': 'Map + Table',
			'map-only': 'Map Only',
			sql: 'SQL'
		}[type] || 'Canvas';
	}

	function captureActiveCanvas() {
		const canvas = activeCanvas();
		if (!canvas || datasetLoadPending) return;
		canvas.datasetId = state.datasetId;
		canvas.chartType = state.chartType;
		canvas.controls = {};
		['dimensionSelect', 'metricSelect', 'aggregationSelect', 'splitSelect', 'orderBySelect', 'orderDirectionSelect']
			.forEach(id => {
				const value = document.getElementById(id)?.value;
				if (value) canvas.controls[id] = value;
			});
		canvas.hiddenColumns = [...state.hiddenColumns];
		canvas.sql = document.getElementById('sqlEditorTA')?.value || '';
		canvas.mapConfig = {
			...state.mapConfig,
			filterFields: [...state.mapConfig.filterFields]
		};
		canvas.mapOptions = {
			...state.mapOptions,
			filterValues: [...state.mapOptions.filterValues],
			popupHidden: [...state.mapOptions.popupHidden],
			tableHidden: [...state.mapOptions.tableHidden]
		};
	}

	function persistWorkspace() {
		if (!canvases.length || !activeCanvasId) return Promise.resolve();
		captureActiveCanvas();
		const snapshot = canvases.map(canvas => ({
			...canvas,
			controls: { ...canvas.controls },
			hiddenColumns: [...canvas.hiddenColumns],
			mapConfig: canvas.mapConfig
				? { ...canvas.mapConfig, filterFields: [...canvas.mapConfig.filterFields] }
				: null,
			mapOptions: canvas.mapOptions
				? {
					...canvas.mapOptions,
					filterValues: [...canvas.mapOptions.filterValues],
					popupHidden: [...canvas.mapOptions.popupHidden],
					tableHidden: [...canvas.mapOptions.tableHidden]
				}
				: null
		}));
		const activeId = activeCanvasId;
		canvasSaveChain = canvasSaveChain
			.catch(() => {})
			.then(() => writeWorkspaceCanvases(snapshot, activeId))
			.catch(error => {
				console.error('Could not save canvas workspace:', error);
				updateProgress(`Could not save workspace: ${error.message}`);
			});
		return canvasSaveChain;
	}

	function scheduleWorkspaceSave() {
		window.clearTimeout(workspaceSaveTimer);
		workspaceSaveTimer = window.setTimeout(() => { void persistWorkspace(); }, 500);
	}

	function renderCanvasTabs() {
		const list = document.getElementById('canvasTabs');
		if (!list) return;
		list.replaceChildren();
		canvases.forEach(canvas => {
			const item = document.createElement('div');
			item.className = `canvas-tab-item${canvas.id === activeCanvasId ? ' active' : ''}`;
			const tab = document.createElement('button');
			tab.type = 'button';
			tab.className = `canvas-tab${canvas.id === activeCanvasId ? ' active' : ''}`;
			tab.dataset.canvasActivate = canvas.id;
			tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', String(canvas.id === activeCanvasId));
			const icon = document.createElement('i');
			icon.className = `canvas-tab-icon bi ${canvas.type === 'sql' ? 'bi-code-slash' : canvas.type === 'table-only' ? 'bi-table' : canvas.type === 'graph-only' ? 'bi-bar-chart' : canvas.type.startsWith('map-') ? 'bi-geo-alt' : 'bi-columns-gap'}`;
			icon.setAttribute('aria-hidden', 'true');
			const title = document.createElement('span');
			title.className = 'canvas-tab-title';
			title.textContent = canvas.name;
			tab.append(icon, title);
			item.appendChild(tab);

			const rename = document.createElement('button');
			rename.type = 'button';
			rename.className = 'canvas-tab-rename';
			rename.dataset.canvasRename = canvas.id;
			rename.setAttribute('aria-label', `Rename ${canvas.name}`);
			rename.title = 'Rename canvas';
			rename.innerHTML = '<i class="bi bi-pencil" aria-hidden="true"></i>';
			item.appendChild(rename);

			const close = document.createElement('button');
			close.type = 'button';
			close.className = 'canvas-tab-close';
			close.dataset.canvasClose = canvas.id;
			close.disabled = canvases.length === 1;
			close.setAttribute('aria-label', `Close ${canvas.name}`);
			close.title = close.disabled ? 'At least one canvas must remain open' : 'Close canvas';
			close.textContent = '×';
			item.appendChild(close);
			list.appendChild(item);
		});
		updateCanvasContextToolbar();
	}

	function updateCanvasContextToolbar() {
		const canvas = activeCanvas();
		if (!canvas) return;
		document.getElementById('canvasContextTitle').textContent = canvasTypeLabel(canvas.type);
		const dataset = buildCatalogItems().find(item => item.id === state.datasetId);
		document.getElementById('canvasContextDataset').textContent =
			dataset?.title || 'No dataset loaded';
		document.getElementById('canvasViewButtons').hidden =
			canvas.type !== 'all-in-one' && canvas.type !== 'graph-only';
	}

	function updateCanvasLayout() {
		const canvas = activeCanvas();
		if (!canvas) return;
		const chartRow = document.getElementById('chartWorkspaceRow');
		const tableRow = document.getElementById('tableWorkspaceRow');
		const chartColumn = document.getElementById('chartControlsColumn');
		const tableColumn = document.getElementById('tableControlsColumn');
		const controlsCard = document.getElementById('controlsCard');
		const tableControlsCard = document.getElementById('tableControlsCard');
		const sqlActive = state.chartType === 'sql' || canvas.type === 'sql';
		const tableOnly = canvas.type === 'table-only' && !sqlActive;
		const showTable = !sqlActive && ['all-in-one', 'table-only', 'map-all-in-one'].includes(canvas.type);
		const showChart = !tableOnly;

		chartRow.style.display = showChart ? '' : 'none';
		tableRow.style.display = showTable ? '' : 'none';
		chartColumn.appendChild(controlsCard);
		tableColumn.appendChild(tableControlsCard);
		tableControlsCard.style.display =
			['all-in-one', 'table-only', 'map-all-in-one'].includes(canvas.type) && !sqlActive ? '' : 'none';
		updateControlVisibility();
		updateCanvasContextToolbar();
	}

	function restoreCanvasSettings(canvas) {
		const validChartTypes = ['bar-horizontal', 'bar-vertical', 'pie', 'map', 'sql'];
		state.chartType = canvas.type === 'sql'
			? 'sql'
			: canvas.type.startsWith('map-')
				? 'map'
				: validChartTypes.includes(canvas.chartType) ? canvas.chartType : 'bar-horizontal';
		Object.entries(canvas.controls || {}).forEach(([id, value]) => {
			const select = document.getElementById(id);
			if (select && [...select.options].some(option => option.value === value)) select.value = value;
		});
		state.hiddenColumns = new Set((canvas.hiddenColumns || []).filter(column =>
			getDatasetColumns().includes(column)
		));
		if (canvas.mapConfig) {
			state.mapConfig = {
				...canvas.mapConfig,
				filterFields: [...(canvas.mapConfig.filterFields || [null, null, null])]
			};
		}
		if (canvas.mapOptions) {
			state.mapOptions = {
				...canvas.mapOptions,
				filterValues: [...(canvas.mapOptions.filterValues || [MAP_ALL_OPTION, MAP_ALL_OPTION, MAP_ALL_OPTION])],
				popupHidden: new Set(canvas.mapOptions.popupHidden || []),
				tableHidden: new Set(canvas.mapOptions.tableHidden || [])
			};
		}
		const columns = getDatasetColumns();
		if (columns.length) {
			const clusterToggle = document.getElementById('mapClusterToggle');
			if (clusterToggle) clusterToggle.checked = state.mapOptions.cluster;
			populateMapConfigForm(columns);
			if (state.mapConfig.saved) {
				renderMapConfigSummary();
				populateMapOptionsSection();
				document.getElementById('mapConfigForm').style.display = 'none';
				document.getElementById('mapConfigSummary').style.display = '';
				document.getElementById('mapOptionsSection').style.display = '';
			} else {
				document.getElementById('mapConfigForm').style.display = '';
				document.getElementById('mapConfigSummary').style.display = 'none';
				document.getElementById('mapOptionsSection').style.display = 'none';
			}
		}
		const editor = document.getElementById('sqlEditorTA');
		if (editor) {
			editor.value = canvas.sql || '';
			editor.dispatchEvent(new Event('input', { bubbles: true }));
		}
		updateChartButtons();
		updateCanvasLayout();
		if (state.chartType === 'sql') {
			window._sqlWBClearResults?.();
			document.dispatchEvent(new CustomEvent('eda:sql-activate'));
		} else {
			renderVisual();
		}
		renderTable();
		updateActiveDatasetIndicator(state.datasetId);
		saveCurrentWorkspacePreferences();
	}

	async function activateCanvas(canvasId, { initial = false } = {}) {
		const canvas = canvases.find(item => item.id === canvasId);
		if (!canvas) return false;
		if (canvasId === activeCanvasId && !initial) return true;
		const activationSequence = ++canvasActivationSequence;
		const previousCanvasId = activeCanvasId;
		if (!initial && previousCanvasId !== canvasId) void persistWorkspace();
		datasetLoadSequence += 1;
		datasetLoadPending = false;
		activeCanvasId = canvasId;
		state.chartType = canvas.type === 'sql' ? 'sql' : canvas.chartType || 'bar-horizontal';
		renderCanvasTabs();
		updateCanvasLayout();

		if (canvas.datasetId) {
			const loaded = await selectDataset(canvas.datasetId, { activationSequence });
			if (activationSequence !== canvasActivationSequence || loaded === null) return false;
			if (!loaded) {
				if (canvases.some(item => item.id === previousCanvasId)) {
					activeCanvasId = previousCanvasId;
					renderCanvasTabs();
					updateCanvasLayout();
				} else {
					canvas.datasetId = null;
					activeCanvasId = canvas.id;
					clearCanvasDataset(canvas);
					renderCanvasTabs();
					await persistWorkspace();
				}
				return false;
			}
		} else {
			clearCanvasDataset(canvas);
		}
		restoreCanvasSettings(canvas);
		await persistWorkspace();
		return true;
	}

	function clearCanvasDataset(canvas) {
		state.datasetId = null;
		state.settings = null;
		state.index = null;
		state.allRows = [];
		state.hiddenColumns.clear();
		state.chartFilter = null;
		state.tableDuckDB = false;
		state.chartType = canvas.type === 'sql' ? 'sql' : canvas.type.startsWith('map-') ? 'map' : 'bar-horizontal';
		state.mapConfig = {
			saved: false,
			latField: null,
			lonField: null,
			filterFields: [null, null, null],
			colorField: null
		};
		state.mapOptions = {
			cluster: true,
			filterValues: [MAP_ALL_OPTION, MAP_ALL_OPTION, MAP_ALL_OPTION],
			popupHidden: new Set(),
			tableHidden: new Set()
		};
		['dimensionSelect', 'metricSelect', 'aggregationSelect', 'splitSelect', 'orderBySelect', 'orderDirectionSelect']
			.forEach(id => fillSelect(id, []));
		const editor = document.getElementById('sqlEditorTA');
		if (editor) {
			editor.value = canvas.sql || '';
			editor.dispatchEvent(new Event('input', { bubbles: true }));
		}
		updateDatasetInfo();
		updateChartButtons();
		updateCanvasLayout();
		updateCatalogTreeState();
		updateActiveDatasetIndicator(null);
		renderSummary();
		renderVisual();
		renderTable();
		updateProgress('Choose a dataset from the left pane and select Analyze to load it into this canvas.');
		if (canvas.type === 'sql') {
			window._sqlWBClearResults?.();
			document.dispatchEvent(new CustomEvent('eda:sql-activate'));
		}
	}

	async function createCanvasTab(type) {
		if (!CANVAS_TYPES.includes(type)) return;
		const number = canvases.filter(canvas => canvas.type === type).length + 1;
		const canvas = createCanvas(type, number);
		canvases.push(canvas);
		document.getElementById('canvasTypeMenu').hidden = true;
		document.getElementById('addCanvasBtn').setAttribute('aria-expanded', 'false');
		await activateCanvas(canvas.id);
	}

	function beginCanvasRename(canvasId, tab) {
		const canvas = canvases.find(item => item.id === canvasId);
		const title = tab?.querySelector('.canvas-tab-title');
		if (!canvas || !title) return;
		const input = document.createElement('input');
		input.className = 'canvas-tab-name-input';
		input.value = canvas.name;
		title.replaceWith(input);
		input.focus();
		input.select();
		let finished = false;
		const finish = save => {
			if (finished) return;
			finished = true;
			const name = input.value.trim();
			if (save && name) canvas.name = name;
			renderCanvasTabs();
			void persistWorkspace();
		};
		input.addEventListener('blur', () => finish(true));
		input.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				input.blur();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				finish(false);
			}
		});
	}

	async function closeCanvasTab(canvasId) {
		if (canvases.length <= 1) return;
		captureActiveCanvas();
		const closedIndex = canvases.findIndex(canvas => canvas.id === canvasId);
		canvases = canvases.filter(canvas => canvas.id !== canvasId);
		if (activeCanvasId === canvasId) {
			const nextCanvasId = canvases[Math.min(closedIndex, canvases.length - 1)].id;
			renderCanvasTabs();
			await activateCanvas(nextCanvasId, { initial: true });
		} else {
			renderCanvasTabs();
			await persistWorkspace();
		}
	}

	function setSelectValueFromShareToken(selectId, token) {
		if (!token) return;
		const select = document.getElementById(selectId);
		if (!select) return;
		const normalized = normalizeShareToken(token);
		const option = [...select.options].find(opt =>
			normalizeShareToken(opt.value) === normalized
			|| normalizeShareToken(opt.textContent) === normalized
		);
		if (option) select.value = option.value;
	}

	function applySharedStateToDashboard(sharedState) {
		if (!sharedState) return;
		if (sharedState.chartType && CHART_TYPE_TO_SHARE[sharedState.chartType]) {
			state.chartType = sharedState.chartType;
		}
		setSelectValueFromShareToken('dimensionSelect', sharedState.dimension);
		setSelectValueFromShareToken('metricSelect', sharedState.metric);
		setSelectValueFromShareToken('aggregationSelect', sharedState.aggregation);
		setSelectValueFromShareToken('splitSelect', sharedState.splitBy);
		setSelectValueFromShareToken('orderBySelect', sharedState.orderBy);

		const orderToken = normalizeShareToken(sharedState.order);
		const orderSelect = document.getElementById('orderDirectionSelect');
		if (orderSelect) {
			if (orderToken === 'ascending' || orderToken === 'asc') orderSelect.value = 'asc';
			if (orderToken === 'descending' || orderToken === 'desc') orderSelect.value = 'desc';
		}

		updateChartButtons();
		renderVisual();
		if (state.chartType !== 'sql' && state.chartType !== 'catalog') {
			renderTable();
		}
		saveCurrentWorkspacePreferences();
	}

	function buildShareUrlFromCurrentState() {
		const getVal = (id) => document.getElementById(id)?.value || '';
		return buildShareUrl({
			datasetId: state.datasetId,
			chartType: state.chartType,
			dimension: getVal('dimensionSelect'),
			metric: getVal('metricSelect'),
			aggregation: getVal('aggregationSelect'),
			splitBy: getVal('splitSelect'),
			orderBy: getVal('orderBySelect'),
			order: getVal('orderDirectionSelect')
		}, {
			baseUrl: `${window.location.origin}${window.location.pathname}`,
			datasets: DATASETS,
			presetDatasetSlugs: PRESET_DATASET_SLUGS
		});
	}

	function updateShareButtonState() {
		const btn = document.getElementById('shareStateBtn');
		if (!btn) return;
		const enabled = isPresetDatasetId(state.datasetId, DATASETS);
		btn.disabled = !enabled;
		btn.title = enabled
			? 'Copy link with current dashboard state'
			: 'Share links are available only for preloaded datasets';
	}

	async function handleShareStateClick() {
		const shareUrl = buildShareUrlFromCurrentState();
		if (!shareUrl) {
			updateProgress('Share links are available only for preloaded datasets.');
			return;
		}

		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(shareUrl);
				updateProgress('Share URL copied to clipboard.');
			} else {
				window.prompt('Copy this share URL:', shareUrl);
				updateProgress('Share URL ready to copy.');
			}
		} catch (error) {
			window.prompt('Copy this share URL:', shareUrl);
			updateProgress('Clipboard access blocked. Share URL shown for manual copy.');
		}
	}

	/**
	 * Reads user-added sources and their cached row data from the SQL
	 * module's IndexedDB and injects them into the shared dataset registry.
	 * Runs at page load so imported sources appear in the docked dataset tree.
	 */
	async function loadPersistedUserDatasets() {
		try {
			// Use the shared unified IDB for persisted user-source metadata and rows.
			const db = await getDatabase();

			const sources = await new Promise((resolve, reject) => {
				const req = db.transaction('sources', 'readonly')
					.objectStore('sources').getAll();
				req.onsuccess = e => resolve(e.target.result || []);
				req.onerror   = e => reject(e.target.error);
			});

			sources.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));

			for (const src of sources) {
				const cached = await new Promise((resolve, reject) => {
					const req = db.transaction('user_source_data', 'readonly')
						.objectStore('user_source_data').get(src.alias);
					req.onsuccess = e => resolve(e.target.result?.rows || null);
					req.onerror   = e => reject(e.target.error);
				});
				if (!cached || !cached.length) continue;
				// Populate the shared user dataset registry (same as SQL module does)
				if (!window._edaUserDatasets) window._edaUserDatasets = new Map();
				window._edaUserDatasets.set(src.alias, {
					id:    src.alias,
					title: src.title || src.alias,
					rows:  cached
				});
			}
		} catch (e) {
			// Preloaded datasets remain available if imported-source storage cannot be read.
			console.warn('loadPersistedUserDatasets:', e);
		}
	}

	async function loadSavedQueries() {
		try {
			savedQueries = await readSavedQueries();
		} catch (error) {
			console.error('Could not load saved queries:', error);
			updateProgress(`Could not load saved queries: ${error.message}`);
			savedQueries = [];
		}
		renderSavedQueries();
	}

	function renderSavedQueries() {
		const list = document.getElementById('savedQueryList');
		if (!list) return;
		list.replaceChildren();
		if (!savedQueries.length) {
			const empty = document.createElement('div');
			empty.className = 'saved-query-empty';
			empty.textContent = 'No saved queries yet.';
			list.appendChild(empty);
			return;
		}
		savedQueries.forEach(query => {
			const item = document.createElement('div');
			item.className = 'saved-query-item';
			const open = document.createElement('button');
			open.type = 'button';
			open.className = 'saved-query-open';
			open.dataset.savedQueryOpen = query.id;
			open.textContent = query.title;
			open.title = query.title;
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'saved-query-delete';
			remove.dataset.savedQueryDelete = query.id;
			remove.setAttribute('aria-label', `Delete saved query ${query.title}`);
			remove.title = 'Delete saved query';
			remove.textContent = '×';
			item.append(open, remove);
			list.appendChild(item);
		});
	}

	function openSaveQueryForm() {
		const form = document.getElementById('saveQueryForm');
		const titleInput = document.getElementById('savedQueryTitle');
		const sql = document.getElementById('sqlEditorTA')?.value.trim();
		if (!sql) {
			document.getElementById('btnSQL')?.click();
			updateProgress('Write a SQL query before saving it.');
			return;
		}
		form.hidden = false;
		titleInput.focus();
	}

	function closeSaveQueryForm() {
		const form = document.getElementById('saveQueryForm');
		form.hidden = true;
		document.getElementById('savedQueryTitle').value = '';
	}

	async function saveCurrentQuery(event) {
		event?.preventDefault();
		const sql = document.getElementById('sqlEditorTA')?.value.trim();
		if (!sql) {
			updateProgress('Enter a SQL query before saving it.');
			return;
		}
		const title = document.getElementById('savedQueryTitle').value.trim();
		if (!title) {
			updateProgress('Enter a name for this saved query.');
			document.getElementById('savedQueryTitle').focus();
			return;
		}
		const id = globalThis.crypto?.randomUUID?.()
			|| `query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		try {
			await saveSavedQuery({ id, title, sql });
			savedQueries = await readSavedQueries();
			renderSavedQueries();
			closeSaveQueryForm();
			updateProgress(`Saved query "${title.trim()}".`);
		} catch (error) {
			console.error('Could not save query:', error);
			updateProgress(`Could not save query: ${error.message}`);
		}
	}

	async function handleSavedQueryAction(event) {
		const deleteButton = event.target.closest('[data-saved-query-delete]');
		if (deleteButton) {
			const query = savedQueries.find(item => item.id === deleteButton.dataset.savedQueryDelete);
			if (!query) return;
			try {
				await deleteSavedQuery(query.id);
				savedQueries = await readSavedQueries();
				renderSavedQueries();
				updateProgress(`Deleted saved query "${query.title}".`);
			} catch (error) {
				console.error(`Could not delete saved query "${query.title}":`, error);
				updateProgress(`Could not delete saved query: ${error.message}`);
			}
			return;
		}
		const openButton = event.target.closest('[data-saved-query-open]');
		if (!openButton) return;
		const query = savedQueries.find(item => item.id === openButton.dataset.savedQueryOpen);
		if (!query) return;
		if (activeCanvas()?.type !== 'sql') {
			await createCanvasTab('sql');
		}
		const editor = document.getElementById('sqlEditorTA');
		if (!editor) return;
		editor.value = query.sql;
		editor.dispatchEvent(new Event('input', { bubbles: true }));
		editor.focus();
		await persistWorkspace();
		updateProgress(`Opened saved query "${query.title}".`);
	}

	function bindUIEvents() {
		document.getElementById('canvasTabs').addEventListener('click', event => {
			const close = event.target.closest('[data-canvas-close]');
			if (close) {
				void closeCanvasTab(close.dataset.canvasClose);
				return;
			}
			const rename = event.target.closest('[data-canvas-rename]');
			if (rename) {
				beginCanvasRename(rename.dataset.canvasRename, rename.closest('.canvas-tab-item').querySelector('[data-canvas-activate]'));
				return;
			}
			const tab = event.target.closest('[data-canvas-activate]');
			if (tab) void activateCanvas(tab.dataset.canvasActivate);
		});
		document.getElementById('addCanvasBtn').addEventListener('click', () => {
			const menu = document.getElementById('canvasTypeMenu');
			menu.hidden = !menu.hidden;
			document.getElementById('addCanvasBtn').setAttribute('aria-expanded', String(!menu.hidden));
		});
		document.getElementById('canvasTypeMenu').addEventListener('click', event => {
			const option = event.target.closest('[data-canvas-type]');
			if (option) void createCanvasTab(option.dataset.canvasType);
		});
		document.addEventListener('click', event => {
			if (event.target.closest('.canvas-add-menu')) return;
			document.getElementById('canvasTypeMenu').hidden = true;
			document.getElementById('addCanvasBtn').setAttribute('aria-expanded', 'false');
		});
		document.getElementById('catalogDatasetList').addEventListener('click', async event => {
			const groupToggle = event.target.closest('[data-catalog-group-toggle]');
			if (groupToggle) {
				const children = groupToggle.nextElementSibling;
				const expanded = groupToggle.getAttribute('aria-expanded') === 'true';
				groupToggle.setAttribute('aria-expanded', String(!expanded));
				children.hidden = expanded;
				return;
			}
			if (event.target.closest('[data-catalog-action]')) {
				await handleCatalogAction(event);
			}
		});
		document.getElementById('saveCurrentQueryBtn').addEventListener('click', openSaveQueryForm);
		document.getElementById('saveQueryForm').addEventListener('submit', saveCurrentQuery);
		document.getElementById('cancelSaveQueryBtn').addEventListener('click', closeSaveQueryForm);
		document.getElementById('savedQueryTitle').addEventListener('keydown', event => {
			if (event.key === 'Escape') closeSaveQueryForm();
		});
		document.getElementById('sqlEditorTA').addEventListener('input', () => {
			const canvas = activeCanvas();
			if (canvas) {
				canvas.sql = document.getElementById('sqlEditorTA').value;
				scheduleWorkspaceSave();
			}
		});
		document.getElementById('savedQueryList').addEventListener('click', handleSavedQueryAction);
		document.getElementById('datasetPreviewModal').addEventListener('click', event => {
			const previewTab = event.target.closest('[data-preview-tab]');
			if (previewTab) {
				setCatalogPreviewMode(previewTab.dataset.previewTab);
				return;
			}
			handleCatalogAction(event);
		});

		document.getElementById('shareStateBtn')?.addEventListener('click', () => {
			handleShareStateClick();
		});

		document.querySelectorAll('.btn-chart').forEach(button => {
			button.addEventListener('click', () => {
				const chartType = button.getAttribute('data-chart');
				if (chartType === 'map' && !state.allRows.length && !hasMapData()) return;
				state.chartType = chartType;
				updateChartButtons();
				updateCanvasLayout();
				saveCurrentWorkspacePreferences();
				void persistWorkspace();
				if (chartType === 'sql') {
					// Signal the SQL workbench module to initialize (lazy)
					document.dispatchEvent(new CustomEvent('eda:sql-activate'));
				} else {
					renderVisual();
				}
			});
		});

		['dimensionSelect','metricSelect','aggregationSelect','splitSelect','orderBySelect','orderDirectionSelect']
			.forEach(id => {
				document.getElementById(id).addEventListener('change', () => {
					renderVisual();
					saveCurrentWorkspacePreferences();
					void persistWorkspace();
				});
			});

		document.getElementById('downloadFullButton').addEventListener('click', async () => {
			if (state.tableDuckDB && state.datasetId) {
				try {
					const result = await window._edaQuery(`SELECT * FROM "${state.datasetId}"`);
					downloadAsCSV(arrowToPlainRows(result), `${state.datasetId}-full.csv`);
				} catch (e) { console.error('Download failed:', e); }
				return;
			}
			if (!state.allRows.length) return;
			downloadAsCSV(state.allRows, `${state.datasetId}-full.csv`);
		});

		document.getElementById('colPickerShowAll').addEventListener('click', () => {
			state.hiddenColumns.clear();
			renderTable();
			void persistWorkspace();
		});

		document.getElementById('colPickerClearAll').addEventListener('click', () => {
			const columns = getDatasetColumns();
			if (!columns.length) return;
			const locked = getLockedColumns();
			columns.forEach(col => {
				if (!locked.has(col)) state.hiddenColumns.add(col);
			});
			renderTable();
			void persistWorkspace();
		});

		document.getElementById('chartFilterClear').addEventListener('click', () => {
			if (state.chartInstance && state.chartFilter) {
				state.chartInstance.dispatchAction({
					type: 'unselect',
					seriesIndex: state.chartFilter.seriesIndex,
					dataIndex: state.chartFilter.dataIndex
				});
			}
			state.chartFilter = null;
			applyChartFilter();
		});

		document.getElementById('downloadFilteredButton').addEventListener('click', async () => {
			if (!state.tabulator) return;
			if (state.tableDuckDB && state.datasetId) {
				// In DuckDB mode getRows('active') only returns the current page;
				// re-query DuckDB with the current filter/sort state for all matching rows.
				try {
					const filters = state.tabulator.getFilters(true);
					const sorts   = state.tabulator.getSorters();
					const sql = `SELECT * FROM "${state.datasetId}" ${buildWhereSQL(filters)} ${buildOrderSQL(sorts)}`;
					const result = await window._edaQuery(sql);
					const rows = arrowToPlainRows(result);
					if (rows.length) downloadAsCSV(rows, `${state.datasetId}-filtered.csv`);
				} catch (e) { console.error('Filtered download failed:', e); }
				return;
			}
			const filteredRows = state.tabulator.getRows('active').map(row => row.getData());
			if (!filteredRows.length) return;
			downloadAsCSV(filteredRows, `${state.datasetId}-filtered.csv`);
		});

		const clusterToggle = document.getElementById('mapClusterToggle');
		if (clusterToggle) {
			clusterToggle.addEventListener('change', (event) => {
				state.mapOptions.cluster = event.target.checked;
				if (state.chartType === 'map') renderVisual();
				void persistWorkspace();
			});
		}

document.getElementById('mapPopupShowAll').addEventListener('click', () => {
		const cols = getDatasetColumns();
		if (!cols.length) return;
		state.mapOptions.popupHidden.clear();
				buildFieldChecklist(document.getElementById('mapPopupFieldList'), state.mapOptions.popupHidden, cols);
				void persistWorkspace();
			});

			document.getElementById('mapPopupClearAll').addEventListener('click', () => {
		const cols = getDatasetColumns();
		if (!cols.length) return;
				cols.forEach(col => state.mapOptions.popupHidden.add(col));
				buildFieldChecklist(document.getElementById('mapPopupFieldList'), state.mapOptions.popupHidden, cols);
				void persistWorkspace();
			});

			document.getElementById('mapPopupRefresh').addEventListener('click', () => {
				if (state.chartType === 'map') renderVisual();
			});

			document.getElementById('mapSaveConfigBtn').addEventListener('click', () => {
				saveMapConfig();
				void persistWorkspace();
			});
		document.getElementById('mapEditConfigBtn').addEventListener('click', () => {
			editMapConfig();
			void persistWorkspace();
		});

		// Delegate filter-value changes inside #mapOptFiltersSection
		document.getElementById('mapOptFiltersSection').addEventListener('change', e => {
			if (!e.target.matches('[data-filter-idx]')) return;
			const idx = parseInt(e.target.dataset.filterIdx, 10);
			state.mapOptions.filterValues[idx] = e.target.value;
			// Cascade: refresh downstream dropdowns to only show values
			// present in rows matched by the upstream selections
			refreshCascadeFilters(idx + 1);
			if (state.chartType === 'map') {
				renderVisual();
				applyMapTableFilters();
			}
			void persistWorkspace();
		});

	}

	function initializeTableControlsSizing() {
		const tableCard = document.querySelector('.table-card');
		const controlsCard = document.getElementById('tableControlsCard');
		if (!tableCard || !controlsCard) return;

		const syncHeight = () => {
			if (!window.matchMedia('(min-width: 992px)').matches) {
				controlsCard.style.height = '';
				return;
			}
			const tableHeight = tableCard.getBoundingClientRect().height;
			if (tableHeight > 0) controlsCard.style.height = `${Math.round(tableHeight)}px`;
		};

		syncHeight();
		if (typeof ResizeObserver !== 'undefined') {
			tableControlsResizeObserver = new ResizeObserver(syncHeight);
			tableControlsResizeObserver.observe(tableCard);
		}
		window.addEventListener('resize', syncHeight);
	}

	function initializeChartSizing() {
		const chartArea = document.getElementById('chartArea');
		if (!chartArea || typeof ResizeObserver === 'undefined') return;
		chartResizeObserver = new ResizeObserver(() => state.chartInstance?.resize());
		chartResizeObserver.observe(chartArea);
	}

	async function selectDataset(datasetId, { activationSequence = null } = {}) {
		if (!datasetId) return;
		if (activationSequence === null) canvasActivationSequence += 1;
		const loadSequence = ++datasetLoadSequence;
		datasetLoadPending = false;
		// Check if this is a user-added source injected by the SQL module
		const userDs = window._edaUserDatasets?.get(datasetId);
		if (userDs) {
			selectedCatalogDatasetId = datasetId;
			state.datasetId = datasetId;
			updateCatalogTreeState();
			state.allRows   = userDs.rows;
			const cols    = Object.keys(userDs.rows[0] || {});
			const numCols = cols.filter(c => userDs.rows.slice(0, 50)
				.some(r => { const v = parseFloat(r[c]); return Number.isFinite(v) && String(r[c]).trim() !== ''; }));
			// All columns are available as dimensions — numeric fields (e.g. district IDs) are valid grouping keys too
			state.settings = enrichSettings({
				dimensions:       cols,
				metrics:          ['Record Count', ...numCols],
				aggregationTypes: ['Count', 'Distinct Count', 'Sum', 'Average', 'Min', 'Max']
			});
			state.index = { totalRecords: userDs.rows.length };
			state.hiddenColumns = new Set();
			populateControls();
			updateDatasetInfo();
			updateChartButtons();
			initializeMapControls();
			state.lastLoadedAt = new Date();
			renderSummary();
			renderVisual();
			renderTable();
			updateProgress(`User source "${userDs.title}" loaded: ${userDs.rows.length.toLocaleString()} rows.`);
			updateActiveDatasetIndicator(datasetId, userDs.title);
			saveCurrentWorkspacePreferences();
			if (activeCanvas()) activeCanvas().datasetId = datasetId;
			return true;
		}
		datasetLoadPending = true;
		const previous = {
			datasetId: state.datasetId,
			settings: state.settings,
			index: state.index,
			allRows: state.allRows,
			hiddenColumns: state.hiddenColumns,
			lastLoadedAt: state.lastLoadedAt,
			chartType: state.chartType,
			mapConfig: state.mapConfig,
			mapOptions: state.mapOptions
		};
		selectedCatalogDatasetId = datasetId;
		state.datasetId = datasetId;
		updateCatalogTreeState();
		state.hiddenColumns = new Set();
		const loaded = await loadDataset(datasetId, loadSequence);
		if (loadSequence !== datasetLoadSequence) return null;
		datasetLoadPending = false;
		if (loaded) {
			if (activeCanvas()) activeCanvas().datasetId = datasetId;
			return true;
		}

		Object.assign(state, previous);
		selectedCatalogDatasetId = previous.datasetId;
		if (state.settings) {
			populateControls();
		} else {
			['dimensionSelect', 'metricSelect', 'aggregationSelect', 'splitSelect', 'orderBySelect', 'orderDirectionSelect']
				.forEach(id => fillSelect(id, []));
		}
		updateDatasetInfo();
		updateCatalogTreeState();
		updateChartButtons();
		renderSummary();
		renderVisual();
		renderTable();
		updateActiveDatasetIndicator(state.datasetId);
		return false;
	}

	async function loadDataset(datasetId, loadSequence) {
		try {
			updateProgress('Loading dataset configuration…');
			const settingsPath = `${DATA_ROOT}/${datasetId}/${datasetId}-bi-settings.json`;
			const indexPath = `${DATA_ROOT}/${datasetId}/${datasetId}.index.json`;
			const [settings, indexData] = await Promise.all([
				fetchJSON(settingsPath),
				fetchJSON(indexPath)
			]);
			if (loadSequence !== datasetLoadSequence) return null;
			const datasetSettings = enrichSettings(settings);
			updateProgress('Loading dataset into DuckDB…');
			if (typeof window._edaPrepareDataset !== 'function') {
				throw new Error('DuckDB is not available for this dataset.');
			}
			const duckDBColumns = await window._edaPrepareDataset(datasetId);
			if (!Array.isArray(duckDBColumns) || !duckDBColumns.length) {
				throw new Error('DuckDB returned no columns for this dataset.');
			}
			if (loadSequence !== datasetLoadSequence) return null;
			state.settings = datasetSettings;
			state.index = indexData;
			state.allRows = [];
			populateControls();
			updateDatasetInfo();
			updateChartButtons();
			const allCols = duckDBColumns.map(column => column.name);
			if (allCols.length) {
				const existingDims = new Set(state.settings.dimensions);
				const extraDims = allCols.filter(column => !existingDims.has(column));
				if (extraDims.length) {
					state.settings.dimensions = [...state.settings.dimensions, ...extraDims];
				}

				const existingMetrics = new Set(state.settings.metrics);
				const numericColumns = duckDBColumns
					.filter(column => /^(?:U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)(?:\b|\()/i.test(column.type))
					.map(column => column.name);
				const numCols = numericColumns.filter(column => !existingMetrics.has(column));
				if (numCols.length) {
					state.settings.metrics = [...state.settings.metrics, ...numCols];
				}

				if (extraDims.length || numCols.length) {
					populateControls();
				}
			}
			initializeMapControls();
			state.lastLoadedAt = new Date();
			renderSummary();
			renderVisual();
			renderTable();
			updateActiveDatasetIndicator(datasetId);
			updateProgress('Dataset loaded into DuckDB.');
			saveCurrentWorkspacePreferences();
			const catalogItems = buildCatalogItems();
			updateCatalogCacheStatuses(catalogItems);
			updateCatalogSummary(catalogItems);
			return true;
		} catch (error) {
			if (loadSequence !== datasetLoadSequence) return null;
			console.error(error);
			updateProgress(`Failed to load "${DATASETS.find(dataset => dataset.id === datasetId)?.title || datasetId}": ${error.message}`);
			return false;
		}
	}

	function updateActiveDatasetIndicator(datasetId, title) {
		const indicator = document.getElementById('activeDatasetIndicator');
		if (!indicator) return;
		const dataset = DATASETS.find(item => item.id === datasetId);
		const userSource = window._edaUserDatasets?.get(datasetId);
		indicator.textContent = `Now working with: ${title || userSource?.title || dataset?.title || datasetId || 'No dataset loaded'}`;
	}

	function saveCurrentWorkspacePreferences() {
		if (!state.datasetId) return;
		const controls = {};
		['dimensionSelect', 'metricSelect', 'aggregationSelect', 'splitSelect', 'orderBySelect', 'orderDirectionSelect']
			.forEach(id => {
				const value = document.getElementById(id)?.value;
				if (value) controls[id] = value;
			});
		const chartTypes = ['bar-horizontal', 'bar-vertical', 'pie'];
		try {
			writeWorkspacePreferences({
				datasetId: state.datasetId,
				chartType: chartTypes.includes(state.chartType) ? state.chartType : 'bar-horizontal',
				controls
			});
		} catch (error) {
			console.warn('Could not save workspace preferences:', error);
		}
	}

	function enrichSettings(settings) {
		const clone = { ...settings };
		if (!Array.isArray(clone.dimensions) || !clone.dimensions.length) {
			clone.dimensions = ['DISTRICT'];
		}
		if (!Array.isArray(clone.metrics) || !clone.metrics.length) {
			clone.metrics = ['Record Count'];
		}
		// Always offer the full set of aggregations — Count-only is useless once
		// numeric metrics are available, and Count still works for all metrics.
		const ALL_AGGS = ['Count', 'Distinct Count', 'Sum', 'Average', 'Min', 'Max'];
		if (!Array.isArray(clone.aggregationTypes) || !clone.aggregationTypes.length) {
			clone.aggregationTypes = ALL_AGGS;
		} else {
			// Merge any existing entries then append missing standard ones
			const set = new Set([...clone.aggregationTypes]);
			ALL_AGGS.forEach(a => set.add(a));
			clone.aggregationTypes = Array.from(set);
		}
		if (!Array.isArray(clone.orderBy) || !clone.orderBy.length) {
			clone.orderBy = ['Dimension', 'Metric Agg Result'];
		}
		return clone;
	}

	function populateControls() {
		const { dimensions, metrics, aggregationTypes, orderBy } = state.settings;
		fillSelect('dimensionSelect', dimensions);
		fillSelect('metricSelect', metrics);
		fillSelect('aggregationSelect', aggregationTypes);
		const splitOptions = ['None', ...dimensions];
		fillSelect('splitSelect', splitOptions);
		const orderValues = orderBy.map(option => ({
			label: option,
			value: option.toLowerCase().includes('dimension') ? 'dimension' : 'metric'
		}));
		fillSelect('orderBySelect', orderValues, true);
		const orderDirectionSelect = document.getElementById('orderDirectionSelect');
		const previousOrderDirection = orderDirectionSelect.value;
		fillSelect('orderDirectionSelect', [
			{ label: 'Ascending', value: 'asc' },
			{ label: 'Descending', value: 'desc' }
		], true);
		orderDirectionSelect.value = previousOrderDirection || 'asc';
	}

	function fillSelect(selectId, values, isObjectList = false) {
		const select = document.getElementById(selectId);
		select.innerHTML = '';
		values.forEach(value => {
			const option = document.createElement('option');
			if (isObjectList && typeof value === 'object') {
				option.value = value.value;
				option.textContent = value.label;
			} else {
				option.value = value;
				option.textContent = value;
			}
			select.appendChild(option);
		});
	}

	function updateDatasetInfo() {
		const info = document.getElementById('datasetInfo');
		if (!state.settings || !state.index) {
			info.textContent = 'Select a dataset to load details.';
			return;
		}
		const datasetMeta = DATASETS.find(item => item.id === state.datasetId);
		const totalRecords = state.index?.totalRecords ?? 0;
		info.innerHTML = `
			<div><strong>Name:</strong> ${datasetMeta ? datasetMeta.title : state.datasetId}</div>
			<div><strong>ID:</strong> ${state.datasetId}</div>
			<div><strong>Total Records:</strong> ${formatNumber(totalRecords)}</div>
		`;
	}

	function initializeMapControls() {
		const container = document.getElementById('mapOptions');
		if (!container) return;
		const cols = getDatasetColumns();
		if (!cols.length) {
			container.classList.add('d-none');
			return;
		}
		const mapCfg  = state.settings?.map;
		const coordinates = detectCoordinateFields(cols);

		// Reset to edit (unconfigured) state on dataset change
		state.mapConfig = {
			saved:        false,
			latField:     (mapCfg?.latitudeField  && cols.includes(mapCfg.latitudeField))  ? mapCfg.latitudeField  : coordinates.latitude,
			lonField:     (mapCfg?.longitudeField && cols.includes(mapCfg.longitudeField)) ? mapCfg.longitudeField : coordinates.longitude,
			filterFields: [null, null, null],
			colorField:   (mapCfg?.defaultColorField && cols.includes(mapCfg.defaultColorField)) ? mapCfg.defaultColorField : null
		};
		state.mapOptions = {
			cluster:      mapCfg?.clusterDefault !== false,
			filterValues: [MAP_ALL_OPTION, MAP_ALL_OPTION, MAP_ALL_OPTION],
			popupHidden:  new Set(),
			tableHidden:  new Set()
		};

		// Pre-fill defaults for Bridge Condition & Owner Area so new users
		// can see how configuration works on that dataset.
		if (state.datasetId === 'eda_assets_bridge_condition_owner_area') {
			const bd = { lat: 'LATITUDE', lon: 'LONGITUDE', f1: 'DISTRICT', f2: 'COUNTY', color: 'GFP' };
			if (cols.includes(bd.lat))   state.mapConfig.latField        = bd.lat;
			if (cols.includes(bd.lon))   state.mapConfig.lonField        = bd.lon;
			if (cols.includes(bd.f1))    state.mapConfig.filterFields[0] = bd.f1;
			if (cols.includes(bd.f2))    state.mapConfig.filterFields[1] = bd.f2;
			if (cols.includes(bd.color)) state.mapConfig.colorField      = bd.color;
			// Default popup fields to show only the 5 mapped columns
			const keepInPopup = new Set([bd.lat, bd.lon, bd.f1, bd.f2, bd.color, 'BRIDGE_ID']);
			cols.forEach(col => { if (!keepInPopup.has(col)) state.mapOptions.popupHidden.add(col); });
		}

		const clusterToggle = document.getElementById('mapClusterToggle');
		if (clusterToggle) clusterToggle.checked = state.mapOptions.cluster;

		populateMapConfigForm(cols);
		// Show form, hide summary + options
		document.getElementById('mapConfigForm').style.display    = '';
		document.getElementById('mapConfigSummary').style.display = 'none';
		document.getElementById('mapOptionsSection').style.display = 'none';

		updateChartButtons();
	}

	function populateMapConfigForm(cols) {
		const noOpt   = [{ label: '\u2014 select \u2014', value: '' }];
		const noFilt  = [{ label: '\u2014 none \u2014',   value: '' }];
		const colOpts = cols.map(c => ({ label: c, value: c }));
		fillSelect('mapCfgLat',     [...noOpt,  ...colOpts], true);
		fillSelect('mapCfgLon',     [...noOpt,  ...colOpts], true);
		fillSelect('mapCfgFilter1', [...noFilt, ...colOpts], true);
		fillSelect('mapCfgFilter2', [...noFilt, ...colOpts], true);
		fillSelect('mapCfgFilter3', [...noFilt, ...colOpts], true);
		fillSelect('mapCfgColor',   [...noFilt, ...colOpts], true);
		// Pre-fill from mapConfig state
		document.getElementById('mapCfgLat').value     = state.mapConfig.latField    || '';
		document.getElementById('mapCfgLon').value     = state.mapConfig.lonField    || '';
		document.getElementById('mapCfgFilter1').value = state.mapConfig.filterFields[0] || '';
		document.getElementById('mapCfgFilter2').value = state.mapConfig.filterFields[1] || '';
		document.getElementById('mapCfgFilter3').value = state.mapConfig.filterFields[2] || '';
		document.getElementById('mapCfgColor').value   = state.mapConfig.colorField   || '';
	}

	function saveMapConfig() {
		state.mapConfig.latField     = document.getElementById('mapCfgLat').value     || null;
		state.mapConfig.lonField     = document.getElementById('mapCfgLon').value     || null;
		state.mapConfig.filterFields[0] = document.getElementById('mapCfgFilter1').value || null;
		state.mapConfig.filterFields[1] = document.getElementById('mapCfgFilter2').value || null;
		state.mapConfig.filterFields[2] = document.getElementById('mapCfgFilter3').value || null;
		state.mapConfig.colorField   = document.getElementById('mapCfgColor').value   || null;
		state.mapConfig.saved        = true;
		// Reset filter values whenever config changes
		state.mapOptions.filterValues = [MAP_ALL_OPTION, MAP_ALL_OPTION, MAP_ALL_OPTION];

		renderMapConfigSummary();
		document.getElementById('mapConfigForm').style.display     = 'none';
		document.getElementById('mapConfigSummary').style.display  = '';
		populateMapOptionsSection();
		document.getElementById('mapOptionsSection').style.display = '';
		if (state.chartType === 'map') renderVisual();
		renderTable(); // refresh table with new tableHidden if any
	}

	function editMapConfig() {
		state.mapConfig.saved = false;
		const cols = getDatasetColumns();
		populateMapConfigForm(cols);
		document.getElementById('mapConfigForm').style.display     = '';
		document.getElementById('mapConfigSummary').style.display  = 'none';
		document.getElementById('mapOptionsSection').style.display = 'none';
	}

	function renderMapConfigSummary() {
		const c   = state.mapConfig;
		const el  = document.getElementById('mapConfigSummaryContent');
		const row = (lbl, val) => {
			const hasVal = val && val !== '';
			return `<div class="map-cfg-row">`
				+ `<span class="map-cfg-lbl">${lbl}</span>`
				+ `<span class="map-cfg-val${hasVal ? '' : ' none'}">${hasVal ? val : 'none'}</span>`
				+ `</div>`;
		};
		el.innerHTML =
			row('Lat',   c.latField)
			+ row('Lon',   c.lonField)
			+ row('Flt 1', c.filterFields[0])
			+ row('Flt 2', c.filterFields[1])
			+ row('Flt 3', c.filterFields[2])
			+ row('Color', c.colorField);
	}

	function populateMapOptionsSection() {
		const cols = getDatasetColumns();
		// Rebuild filter value dropdowns
		const filtersEl = document.getElementById('mapOptFiltersSection');
		filtersEl.innerHTML = '';
		state.mapConfig.filterFields.forEach((field, idx) => {
			if (!field) return;
			const vals = getUniqueValues(state.allRows, field);
			const wrap = document.createElement('div');
			wrap.className = 'mb-2';
			wrap.innerHTML = `<div class="map-opt-filter-lbl mb-1">${field}</div>`;
			const sel = document.createElement('select');
			sel.className = 'form-select form-select-sm';
			sel.dataset.filterIdx = idx;
			const allOpt = document.createElement('option');
			allOpt.value = MAP_ALL_OPTION;
			allOpt.textContent = '\u2014 all \u2014';
			sel.appendChild(allOpt);
			vals.forEach(v => {
				const o = document.createElement('option');
				o.value = v; o.textContent = v;
				sel.appendChild(o);
			});
			sel.value = state.mapOptions.filterValues[idx];
			wrap.appendChild(sel);
			filtersEl.appendChild(wrap);
		});
		// Checklist helpers
		buildFieldChecklist(
			document.getElementById('mapPopupFieldList'),
			state.mapOptions.popupHidden, cols, () => { void persistWorkspace(); }
		);
	}

	function buildFieldChecklist(listEl, hiddenSet, cols, onChange) {
		if (!listEl) return;
		listEl.innerHTML = '';
		cols.forEach(col => {
			const isHidden = hiddenSet.has(col);
			const item = document.createElement('div');
			item.className = 'col-picker-item' + (isHidden ? ' col-picker-hidden' : '');
			const cb = document.createElement('input');
			cb.type = 'checkbox'; cb.className = 'col-picker-cb form-check-input mt-0'; cb.checked = !isHidden;
			const lbl = document.createElement('label');
			lbl.className = 'col-picker-name'; lbl.textContent = col; lbl.title = col;
			item.appendChild(cb); item.appendChild(lbl);
			cb.addEventListener('change', () => {
				if (cb.checked) hiddenSet.delete(col); else hiddenSet.add(col);
				item.classList.toggle('col-picker-hidden', !cb.checked);
				if (onChange) onChange();
			});
			listEl.appendChild(item);
		});
	}

	function getMapFilteredRows() {
		return state.allRows.filter(row => {
			for (let i = 0; i < 3; i++) {
				const field = state.mapConfig.filterFields[i];
				const val   = state.mapOptions.filterValues[i];
				if (field && val !== MAP_ALL_OPTION) {
					if (String(row[field] ?? '') !== val) return false;
				}
			}
			return true;
		});
	}

	/**
	 * Rebuilds filter-value <select> options for indexes fromIdx..2,
	 * restricting each dropdown to values that exist in rows already
	 * matched by all upstream (lower-index) filter selections.
	 */
	function refreshCascadeFilters(fromIdx) {
		for (let i = fromIdx; i < 3; i++) {
			const field = state.mapConfig.filterFields[i];
			if (!field) continue;
			// Rows that pass all filters before index i
			const upstream = state.allRows.filter(row => {
				for (let j = 0; j < i; j++) {
					const f = state.mapConfig.filterFields[j];
					const v = state.mapOptions.filterValues[j];
					if (f && v !== MAP_ALL_OPTION && String(row[f] ?? '') !== v) return false;
				}
				return true;
			});
			const vals = getUniqueValues(upstream, field);
			const sel = document.querySelector(`#mapOptFiltersSection [data-filter-idx="${i}"]`);
			if (!sel) continue;
			const currentVal = state.mapOptions.filterValues[i];
			sel.innerHTML = '';
			const allOpt = document.createElement('option');
			allOpt.value = MAP_ALL_OPTION; allOpt.textContent = '\u2014 all \u2014';
			sel.appendChild(allOpt);
			vals.forEach(v => {
				const o = document.createElement('option');
				o.value = v; o.textContent = v;
				sel.appendChild(o);
			});
			// If the previously selected value no longer exists, reset to "all"
			if (currentVal !== MAP_ALL_OPTION && !vals.includes(currentVal)) {
				state.mapOptions.filterValues[i] = MAP_ALL_OPTION;
			}
			sel.value = state.mapOptions.filterValues[i];
		}
	}

	/**
	 * Applies the current map filter selections as Tabulator row filters
	 * so the data table reflects the same rows shown on the map.
	 */
	function applyMapTableFilters() {
		if (!state.tabulator) return;
		const filters = [];
		for (let i = 0; i < 3; i++) {
			const field = state.mapConfig.filterFields[i];
			const val   = state.mapOptions.filterValues[i];
			if (field && val !== MAP_ALL_OPTION) {
				filters.push({ field, type: '=', value: val });
			}
		}
		if (filters.length) {
			state.tabulator.setFilter(filters);
		} else {
			state.tabulator.clearFilter();
		}
	}

	function renderSummary() {
		const summary = document.getElementById('dataSummary');
		if (!state.index) {
			summary.textContent = '';
			return;
		}
		const totalRecords = state.index.totalRecords ?? state.allRows.length;
		const timestamp = state.lastLoadedAt ? formatTimestamp(state.lastLoadedAt) : '—';
		summary.textContent = isDuckDBDataset()
			? `Records in DuckDB: ${formatNumber(totalRecords)} · Last refreshed: ${timestamp}`
			: `Records loaded: ${formatNumber(state.allRows.length)} · Index total: ${formatNumber(totalRecords)} · Last refreshed: ${timestamp}`;
	}

	function renderVisual() {
		// SQL mode has its own rendering — DuckDB queries CSV files directly
		if (state.chartType === 'sql') return;
		if (state.chartType === 'catalog') {
			state.chartType = 'bar-horizontal';
			updateChartButtons();
		}
		// Clear any active chart-click filter when the chart is refreshed
		if (state.chartFilter !== null) {
			state.chartFilter = null;
			applyChartFilter();
		}
		destroyVisuals();
		// Increment sequence so a pending async renderChart() knows it is stale
		state._renderSeq += 1;
		const seq = state._renderSeq;
		const canQueryDuckDB = isDuckDBDataset() && typeof window._edaQuery === 'function';
		if (!state.allRows.length && !canQueryDuckDB) {
			renderCanvasEmptyState(document.getElementById('chartArea'));
			return;
		}
		if (state.chartType === 'map') {
			if (!state.allRows.length) {
				if (canQueryDuckDB && hasMapData()) {
					void loadDuckDBMapRows(state.datasetId, seq);
				} else {
					renderCanvasEmptyState(document.getElementById('chartArea'));
				}
			} else {
				renderMap();
			}
		} else {
			renderChart(seq);
		}
		// Refresh lock indicators whenever BI selects change
		populateColumnPicker();
	}

	async function loadDuckDBMapRows(datasetId, renderSequence) {
		updateProgress('Loading map features from DuckDB…');
		try {
			const result = await window._edaQuery(`SELECT * FROM "${datasetId}"`);
			if (renderSequence !== state._renderSeq || datasetId !== state.datasetId) return;
			state.allRows = arrowToPlainRows(result);
			updateChartButtons();
			updateControlVisibility();
			if (state.mapConfig.saved) populateMapOptionsSection();
			renderMap();
		} catch (error) {
			if (renderSequence !== state._renderSeq || datasetId !== state.datasetId) return;
			console.error(`Could not load map features for "${datasetId}" from DuckDB:`, error);
			const chartArea = document.getElementById('chartArea');
			if (chartArea) chartArea.textContent = `Could not load map features: ${error.message}`;
			updateProgress(`Could not load map features: ${error.message}`);
		}
	}

	function renderCanvasEmptyState(container) {
		if (!container) return;
		const canvas = activeCanvas();
		const mapCanvas = canvas?.type.startsWith('map-') || state.chartType === 'map';
		const title = mapCanvas ? 'Prepare a map'
			: canvas?.type === 'graph-only' ? 'Prepare a graph'
				: canvas?.type === 'table-only' ? 'Prepare a table'
					: 'Your canvas is ready';
		const steps = mapCanvas
			? [
				'Choose a dataset with spatial coordinate fields (latitude and longitude) in the Datasets pane and select Analyze.',
				'Choose the latitude and longitude fields in Map Configuration.',
				'Save the map configuration to display the map.'
			]
			: canvas?.type === 'graph-only'
				? [
					'Choose a dataset from the Datasets pane and select Analyze.',
					'Choose Horizontal Bar, Vertical Bar, or Pie in the canvas toolbar.',
					'Use the controls on the right to choose dimensions, metrics, and sorting.'
				]
				: canvas?.type === 'table-only'
					? [
						'Choose a dataset from the Datasets pane and select Analyze.',
						'The table will appear here; use the controls on the right to configure the view.'
					]
					: [
						'Choose a dataset from the Datasets pane and select Analyze.',
						'Choose a graph type and configure it with the controls on the right.',
						'The matching data table appears below.'
					];
		const message = document.createElement('div');
		message.className = 'canvas-empty-state';
		const icon = document.createElement('i');
		icon.className = `bi ${mapCanvas ? 'bi-geo-alt' : canvas?.type === 'table-only' ? 'bi-table' : 'bi-bar-chart'}`;
		icon.setAttribute('aria-hidden', 'true');
		const heading = document.createElement('h2');
		heading.textContent = title;
		const list = document.createElement('ol');
		steps.forEach(step => {
			const item = document.createElement('li');
			item.textContent = step;
			list.appendChild(item);
		});
		message.append(icon, heading, list);
		container.replaceChildren(message);
	}

	function destroyVisuals() {
		const chartArea = document.getElementById('chartArea');
		chartArea.innerHTML = '';
		if (state.chartInstance) {
			state.chartInstance.dispose();
			state.chartInstance = null;
		}
		if (state.mapInstance) {
			state.mapInstance.remove();
			state.mapInstance = null;
		}
		state.mapLayer = null;
	}

	// ── DuckDB SQL chart helpers ────────────────────────────────────────────

	/**
	 * Build a SQL WHERE clause from a Tabulator filter array.
	 * Supports types: '=' (with 'Unknown' mapped to IS NULL/blank), '!=', 'like', '<', '<=', '>', '>='.
	 */
	function buildWhereSQL(filters) {
		if (!filters || !filters.length) return '';
		const clauses = filters.map(f => {
			const col = `"${String(f.field).replace(/"/g, '""')}"`;
			const val = String(f.value ?? '').replace(/'/g, "''");
			switch (f.type) {
				case '=':
					// Chart filter: 'Unknown' represents blank/null values normalized in JS
					if (f.value === 'Unknown') {
						return `(${col} IS NULL OR TRIM(CAST(${col} AS VARCHAR)) = '')`;
					}
					return `CAST(${col} AS VARCHAR) = '${val}'`;
				case '!=':
					return `CAST(${col} AS VARCHAR) != '${val}'`;
				case 'like':
					return val ? `CAST(${col} AS VARCHAR) ILIKE '%${val}%'` : '1=1';
				case '<':
					return `TRY_CAST(${col} AS DOUBLE) < ${parseFloat(f.value) || 0}`;
				case '<=':
					return `TRY_CAST(${col} AS DOUBLE) <= ${parseFloat(f.value) || 0}`;
				case '>':
					return `TRY_CAST(${col} AS DOUBLE) > ${parseFloat(f.value) || 0}`;
				case '>=':
					return `TRY_CAST(${col} AS DOUBLE) >= ${parseFloat(f.value) || 0}`;
				default:
					return `CAST(${col} AS VARCHAR) = '${val}'`;
			}
		});
		return `WHERE ${clauses.join(' AND ')}`;
	}

	/**
	 * Build a SQL ORDER BY clause from a Tabulator sorter array.
	 * Handles both ajaxRequestFunc params ({column, dir}) and getSorters() output ({field, dir}).
	 */
	function buildOrderSQL(sorts) {
		if (!sorts || !sorts.length) return '';
		const parts = sorts.map(s => {
			const col = s.column || s.field;
			return `"${String(col).replace(/"/g, '""')}" ${s.dir === 'desc' ? 'DESC' : 'ASC'}`;
		});
		return `ORDER BY ${parts.join(', ')}`;
	}

	/** Convert an Apache Arrow result set to plain JS objects (handles BigInt). */
	function arrowToPlainRows(result) {
		const cols = result.schema.fields.map(f => f.name);
		return result.toArray().map(r => {
			const obj = {};
			cols.forEach(c => {
				const v = r[c];
				obj[c] = (v === null || v === undefined) ? null
					: typeof v === 'bigint' ? Number(v) : v;
			});
			return obj;
		});
	}

	/** Return the SQL aggregation expression for a metric + aggregation type. */
	/**
	 * Build and run a DuckDB aggregation query for the chart, returning the same
	 * prepared-series structure that buildChartOption() expects.
	 * Never materialises allRows — all aggregation happens inside DuckDB.
	 */
	async function buildChartFromSQL(datasetId, dim, split, metric, agg, orderBy, orderDir) {
		const useSplit       = split && split !== 'None';
		const isCountRecords = !metric || metric === 'Record Count';
		const aggExpr        = buildSqlAggExpr(metric, agg);
		const seriesLabel    = isCountRecords ? 'Count' : `${agg} of ${metric}`;
		const safeDs         = String(datasetId).replace(/"/g, '""');
		const safeDim        = String(dim).replace(/"/g, '""');
		const dimExpr        = `COALESCE(CAST("${safeDim}" AS VARCHAR), 'Unknown')`;
		const sqlDir         = orderDir === 'asc' ? 'ASC' : 'DESC';

		if (useSplit) {
			const safeSplit = String(split).replace(/"/g, '""');
			const splitExpr = `COALESCE(CAST("${safeSplit}" AS VARCHAR), 'Unknown')`;
			const sql = `SELECT ${dimExpr} AS dim_val, ${splitExpr} AS split_val, ${aggExpr} AS metric_val `
				+ `FROM "${safeDs}" GROUP BY dim_val, split_val ORDER BY dim_val, metric_val DESC LIMIT 5000`;
			const rows = arrowToPlainRows(await window._edaQuery(sql));
			// Collect ordered dim and split values
			const dimOrder = [], dimSet = new Set(), splitSet = new Set();
			rows.forEach(r => {
				if (!dimSet.has(r.dim_val)) { dimSet.add(r.dim_val); dimOrder.push(r.dim_val); }
				splitSet.add(r.split_val);
			});
			const splitKeys = Array.from(splitSet);
			// Build dim → split → value lookup
			const lookup = new Map();
			rows.forEach(r => {
				if (!lookup.has(r.dim_val)) lookup.set(r.dim_val, new Map());
				lookup.get(r.dim_val).set(r.split_val, r.metric_val ?? 0);
			});
			const series = splitKeys.map(sk => ({
				name: sk, type: 'bar', stack: 'total',
				data: dimOrder.map(dk => {
					const v = lookup.get(dk)?.get(sk) ?? 0;
					return typeof v === 'bigint' ? Number(v) : (v ?? 0);
				})
			}));
			// Apply user-requested sort
			const totals  = dimOrder.map((_, i) => series.reduce((s, sr) => s + (sr.data[i] || 0), 0));
			const indices = dimOrder.map((_, i) => i);
			const mult    = orderDir === 'asc' ? 1 : -1;
			indices.sort((a, b) => orderBy === 'dimension'
				? String(dimOrder[a]).localeCompare(String(dimOrder[b]), undefined, { numeric: true }) * mult
				: (totals[a] - totals[b]) * mult);
			const cats = indices.map(i => dimOrder[i]);
			series.forEach(s => { s.data = indices.map(i => s.data[i]); });
			return { categories: cats, seriesLabel, dimensionField: dim, splitField: split, legend: splitKeys, series };
		} else {
			const orderCol = orderBy === 'dimension' ? 'dim_val' : 'metric_val';
			const sql = `SELECT ${dimExpr} AS dim_val, ${aggExpr} AS metric_val `
				+ `FROM "${safeDs}" GROUP BY dim_val ORDER BY ${orderCol} ${sqlDir} LIMIT 200`;
			const rows = arrowToPlainRows(await window._edaQuery(sql));
			const type = state.chartType === 'pie' ? 'pie' : 'bar';
			return {
				categories: rows.map(r => r.dim_val ?? 'Unknown'),
				seriesLabel,
				dimensionField: dim,
				splitField: null,
				legend: [],
				series: [{
					name: seriesLabel,
					type,
					data: rows.map(r => {
						const v = r.metric_val;
						return typeof v === 'bigint' ? Number(v) : (v ?? 0);
					})
				}]
			};
		}
	}

	async function renderChart(seq) {
		const dimensionField  = document.getElementById('dimensionSelect').value;
		const metricField     = document.getElementById('metricSelect').value;
		const aggregationType = document.getElementById('aggregationSelect').value;
		const splitValue      = document.getElementById('splitSelect').value;
		const orderMode       = document.getElementById('orderDirectionSelect').value;
		const orderBy         = document.getElementById('orderBySelect').value;

		let prepared;
		// Managed datasets use DuckDB; imported in-memory sources retain the JS fallback.
		const canUseDuckDB = typeof window._edaQuery === 'function' && state.datasetId;
		if (canUseDuckDB) {
			try {
				prepared = await buildChartFromSQL(
					state.datasetId, dimensionField, splitValue,
					metricField, aggregationType, orderBy, orderMode
				);
			} catch (e) {
				if (isDuckDBDataset()) {
					console.error('DuckDB chart query failed:', e);
					const chartArea = document.getElementById('chartArea');
					if (chartArea) chartArea.textContent = `DuckDB chart query failed: ${e.message}`;
					updateProgress(`DuckDB chart query failed: ${e.message}`);
					return;
				}
				console.warn('DuckDB chart query failed, falling back to JS aggregation:', e);
				prepared = prepareSeries(state.allRows, dimensionField, splitValue, metricField, aggregationType, state.chartType);
				sortSeries(prepared, orderBy, orderMode);
			}
		} else {
			prepared = prepareSeries(state.allRows, dimensionField, splitValue, metricField, aggregationType, state.chartType);
			sortSeries(prepared, orderBy, orderMode);
		}

		// Bail out if another renderVisual() was called while we awaited DuckDB
		if (state._renderSeq !== seq) return;

		const chartArea = document.getElementById('chartArea');
		const chartInstance = echarts.init(chartArea);
		const option = buildChartOption(prepared, state.chartType, dimensionField);
		chartInstance.setOption(option);
		state.chartInstance = chartInstance;

		// ── Chart-click → filter the data table ─────────────────────────────
		chartInstance.on('click', function (params) {
			const clickedValue = params.name;
			if (state.chartFilter && state.chartFilter.value === clickedValue) {
				// Same element clicked again → toggle the filter off
				chartInstance.dispatchAction({
					type: 'unselect',
					seriesIndex: params.seriesIndex,
					dataIndex: params.dataIndex
				});
				state.chartFilter = null;
			} else {
				state.chartFilter = {
					field: dimensionField,
					value: clickedValue,
					seriesIndex: params.seriesIndex,
					dataIndex: params.dataIndex
				};
			}
			applyChartFilter();
		});
	}

	/**
	 * Apply (or clear) a Tabulator row-filter based on state.chartFilter.
	 * Also shows/hides the #chartFilterBadge indicator in the table header.
	 */
	function applyChartFilter() {
		const badge    = document.getElementById('chartFilterBadge');
		const badgeText = document.getElementById('chartFilterText');

		if (!state.tabulator) return;

		if (!state.chartFilter) {
			state.tabulator.clearFilter();
			if (badge) badge.style.display = 'none';
			return;
		}

		const { field, value } = state.chartFilter;

		if (state.tableDuckDB) {
			// Remote mode: use a serializable filter object; buildWhereSQL handles 'Unknown' → IS NULL
			state.tabulator.setFilter([{ field, type: '=', value }]);
		} else {
			// Local mode: use a function filter to apply the same normalizeGroupValue logic
			state.tabulator.setFilter(function (rowData) {
				const raw = rowData[field];
				const normalized = (raw === undefined || raw === null || String(raw).trim() === '') ? 'Unknown' : String(raw);
				return normalized === value;
			});
		}

		if (badge) badge.style.display = '';
		if (badgeText) {
			badgeText.textContent = `${field} = "${value === 'Unknown' ? '(blank)' : value}"`;
		}
	}

	function renderMap() {
		if (!state.mapConfig.saved) {
			document.getElementById('chartArea').innerHTML =
				'<div class="text-muted p-3">Configure and save map settings in the Map Configuration panel on the right.</div>';
			return;
		}
		const latField   = state.mapConfig.latField;
		const lonField   = state.mapConfig.lonField;
		const colorField = state.mapConfig.colorField || null;
		if (!latField || !lonField) {
			document.getElementById('chartArea').innerHTML =
				'<div class="text-muted p-3">Please select Latitude and Longitude fields in the Map Configuration panel.</div>';
			return;
		}
		const filteredRows  = getMapFilteredRows();
		const colorValues   = colorField ? getColorValues(filteredRows, colorField) : [];
		const colorMap      = new Map(colorValues.map((v, i) => [v, CHART_PALETTE[i % CHART_PALETTE.length]]));
		const allCols       = getDatasetColumns();
		const chartArea     = document.getElementById('chartArea');
		const mapDiv        = document.createElement('div');
		mapDiv.style.height    = '100%';
		mapDiv.style.minHeight = '360px';
		chartArea.appendChild(mapDiv);
		const map = L.map(mapDiv).setView([37.8, -85.7], 6);
		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
			maxZoom: 18,
			attribution: '© OpenStreetMap contributors'
		}).addTo(map);
		const layerGroup = state.mapOptions.cluster ? L.markerClusterGroup() : L.featureGroup();
		let markerCount = 0;
		filteredRows.forEach(row => {
			const lat = parseFloat(row[latField]);
			const lon = parseFloat(row[lonField]);
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
			const colorKey           = colorField ? (row[colorField] ?? 'Unknown') : 'Feature';
			const normalizedColorKey = colorKey === '' ? 'Unknown' : String(colorKey);
			const strokeColor        = colorMap.get(normalizedColorKey) || CHART_PALETTE[0];
			const marker = L.circleMarker([lat, lon], {
				radius: 5, weight: 1,
				color: strokeColor, fillColor: strokeColor, fillOpacity: 0.75
			});
			const popupLines = [];
			allCols.forEach(col => {
				if (state.mapOptions.popupHidden.has(col)) return;
				const val = row[col];
				if (val === undefined || val === null || String(val).trim() === '') return;
				popupLines.push(`<b>${col}:</b> ${val}`);
			});
			if (popupLines.length) marker.bindPopup(popupLines.join('<br>'));
			layerGroup.addLayer(marker);
			markerCount += 1;
		});
		layerGroup.addTo(map);
		if (markerCount) {
			const bounds = layerGroup.getBounds();
			if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
			updateProgress(`${formatNumber(markerCount)} features on map.`);
		} else {
			updateProgress('No features match the current map filters.');
		}
		state.mapInstance = map;
		state.mapLayer    = layerGroup;
	}

	function renderTable() {
		const container = document.getElementById('tableContainer');
		if (state.tabulator) {
			state.tabulator.destroy();
			state.tabulator = null;
		}
		container.innerHTML = '';
		state.tableDuckDB = false;

		const canUseDuckDB = (isDuckDBDataset() || !state.allRows.length)
			&& typeof window._edaQuery === 'function'
			&& state.datasetId
			&& window._edaTableColumns?.has(state.datasetId);

		if (!canUseDuckDB && !state.allRows.length) {
			container.innerHTML = '<div class="canvas-table-empty">Analyze a dataset from the left pane to load its rows into this table.</div>';
			populateColumnPicker();
			return;
		}

		// Remove from hidden set any columns that are now locked (dimension/metric/split)
		getLockedColumns().forEach(c => state.hiddenColumns.delete(c));

		const allColKeys = isDuckDBDataset()
			? getDatasetColumns()
			: state.allRows.length
				? Object.keys(state.allRows[0])
				: getDatasetColumns();

		if (!allColKeys.length) {
			container.innerHTML = '<div class="text-muted">No data available for this dataset.</div>';
			populateColumnPicker();
			return;
		}

		// When map is active, also respect the map-specific tableHidden set
		const mapTableHid = (state.chartType === 'map') ? state.mapOptions.tableHidden : null;
		const columns = allColKeys
			.filter(key => !state.hiddenColumns.has(key) && !(mapTableHid && mapTableHid.has(key)))
			.map(key => ({
				title: key,
				field: key,
				headerFilter: 'input',
				headerFilterPlaceholder: 'Filter…',
				headerSort: true,
				minWidth: 160
			}));

		if (canUseDuckDB) {
			state.tableDuckDB = true;
			const alias = state.datasetId;
			state.tabulator = new Tabulator(container, {
				ajaxURL: 'duckdb',
				ajaxRequestFunc: async (_url, _cfg, params) => {
					const { page = 1, size = 25, filter = [], sort = [] } = params;
					const offset   = (page - 1) * size;
					const whereSql = buildWhereSQL(filter);
					const orderSql = buildOrderSQL(sort);
					// DuckDB-WASM uses a single connection — queries must be sequential.
					const countResult = await window._edaQuery(`SELECT COUNT(*) AS n FROM "${alias}" ${whereSql}`);
					const total       = Number(arrowToPlainRows(countResult)[0]?.n ?? 0);
					const dataResult  = await window._edaQuery(`SELECT * FROM "${alias}" ${whereSql} ${orderSql} LIMIT ${size} OFFSET ${offset}`);
					const rows        = arrowToPlainRows(dataResult);
					return { data: rows, last_page: Math.ceil(total / size) || 1 };
				},
				filterMode: 'remote',
				sortMode: 'remote',
				layout: 'fitDataStretch',
				height: '420px',
				pagination: true,
				paginationMode: 'remote',
				paginationSize: 25,
				paginationSizeSelector: [25, 50, 100, 200],
				columns,
				placeholder: 'No rows to display.',
				resizableColumns: true,
				autoColumns: false
			});
		} else {
			state.tabulator = new Tabulator(container, {
				data: state.allRows,
				layout: 'fitDataStretch',
				height: '420px',
				pagination: 'local',
				paginationSize: 15,
				paginationSizeSelector: [15, 25, 50, 100],
				columns,
				placeholder: 'No rows to display.',
				resizableColumns: true,
				autoColumns: false
			});
		}

		// Re-apply any active chart filter after rebuilding the table
		if (state.chartFilter) applyChartFilter();
		// Re-apply map filter selections as row filters when map is active
		if (state.chartType === 'map') applyMapTableFilters();
		populateColumnPicker();
	}

	/** Returns the set of column names that must always stay visible. */
	function getLockedColumns() {
		const locked = new Set();
		const dim    = document.getElementById('dimensionSelect')?.value;
		const metric = document.getElementById('metricSelect')?.value;
		const split  = document.getElementById('splitSelect')?.value;
		if (dim)                               locked.add(dim);
		if (metric && metric !== 'Record Count') locked.add(metric);
		if (split  && split  !== 'None')        locked.add(split);
		return locked;
	}

	/** Rebuild the column picker list, reflecting current hidden/locked state. */
	function populateColumnPicker() {
		const list  = document.getElementById('colPickerList');
		const badge = document.getElementById('colPickerBadge');
		const visibleCount = document.getElementById('colPickerVisibleCount');
		if (!list) return;
		const allCols = getDatasetColumns();
		if (!allCols.length) {
			list.innerHTML = '<div class="col-picker-empty">No dataset loaded.</div>';
			if (badge) badge.style.display = 'none';
			if (visibleCount) visibleCount.textContent = '';
			return;
		}
		const locked    = getLockedColumns();
		// Ensure locked columns are never left in the hidden set
		locked.forEach(c => state.hiddenColumns.delete(c));

		list.innerHTML = '';
		allCols.forEach(col => {
			const isLocked = locked.has(col);
			const isHidden = state.hiddenColumns.has(col);

			const item = document.createElement('div');
			item.className = 'col-picker-item'
				+ (isLocked ? ' col-picker-locked' : '')
				+ (isHidden ? ' col-picker-hidden' : '');

			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.className = 'col-picker-cb form-check-input mt-0';
			cb.checked  = !isHidden;
			cb.disabled = isLocked;
			cb.title = isLocked ? 'Required by current chart selection' : (isHidden ? 'Click to show' : 'Click to hide');

			const lbl = document.createElement('label');
			lbl.className = 'col-picker-name';
			lbl.textContent = col;
			lbl.title = col;

			item.appendChild(cb);
			item.appendChild(lbl);

			if (isLocked) {
				const lock = document.createElement('i');
				lock.className = 'bi bi-lock-fill col-picker-lock';
				lock.title = 'Required by current chart selection';
				item.appendChild(lock);
			}

			if (!isLocked) {
				cb.addEventListener('change', () => {
					if (cb.checked) {
						state.hiddenColumns.delete(col);
					} else {
						state.hiddenColumns.add(col);
					}
					renderTable();
				});
				// Also allow clicking the label to toggle
				item.addEventListener('click', (e) => {
					if (e.target === cb || e.target === lbl) return; // let native events fire
					cb.checked = !cb.checked;
					cb.dispatchEvent(new Event('change'));
				});
			}

			list.appendChild(item);
		});

		const hiddenCount = state.hiddenColumns.size;
		if (visibleCount) visibleCount.textContent = `${allCols.length - hiddenCount} / ${allCols.length} visible`;
		if (badge) {
			badge.style.display = hiddenCount > 0 ? '' : 'none';
			badge.textContent   = hiddenCount > 0 ? `${hiddenCount} hidden` : '';
		}
	}

	function updateChartButtons() {
		document.querySelectorAll('.btn-chart').forEach(button => {
			const chartType = button.getAttribute('data-chart');
			button.classList.toggle('active', chartType === state.chartType);
			if (chartType === 'map') {
				const enabled = state.allRows.length > 0 || hasMapData();
				button.disabled = !enabled;
				button.setAttribute('title', enabled ? 'Show Leaflet map view' : 'Map not available \u2014 load a dataset first');
			}
		});
		updateShareButtonState();
		updateControlVisibility();
	}

	function updateControlVisibility() {
		const controlsCard    = document.getElementById('controlsCard');
		const mapContainer    = document.getElementById('mapOptions');
		const generalControls = document.getElementById('generalControls');
		const sqlSidebar      = document.getElementById('sqlSidebarPanel');
		const chartArea       = document.getElementById('chartArea');
		const progressMsg     = document.getElementById('progressMessage');
		const dataSummary     = document.getElementById('dataSummary');
		const sqlWorkbench    = document.getElementById('sqlWorkbenchPanel');
		const tableCard       = document.querySelector('.table-card');
		const tableControlsCard = document.getElementById('tableControlsCard');
		const hasMap       = state.allRows.length > 0 || hasMapData();
		const mapCanvas    = activeCanvas()?.type.startsWith('map-');
		const mapActive    = state.chartType === 'map' && (hasMap || mapCanvas);
		const sqlActive    = state.chartType === 'sql';

		if (controlsCard) {
			controlsCard.classList.toggle('map-active', mapActive && !sqlActive);
			controlsCard.classList.toggle('sql-active',     sqlActive);
		}

		if (mapContainer) {
			mapContainer.classList.toggle('d-none', !mapActive || sqlActive);
		}

		if (generalControls) {
			if (mapActive || sqlActive) {
				generalControls.setAttribute('aria-hidden', 'true');
			} else {
				generalControls.removeAttribute('aria-hidden');
			}
		}

		if (sqlSidebar) sqlSidebar.style.display = sqlActive ? 'flex' : 'none';

		if (chartArea)    chartArea.style.display    = sqlActive ? 'none' : '';
		if (progressMsg)  progressMsg.style.display  = sqlActive ? 'none' : '';
		if (dataSummary)  dataSummary.style.display  = sqlActive ? 'none' : '';
		if (sqlWorkbench) sqlWorkbench.style.display = sqlActive    ? 'flex' : 'none';

		if (tableCard) tableCard.style.display = sqlActive ? 'none' : '';
		if (tableControlsCard) {
			const canvasType = activeCanvas()?.type;
			const supportsTableControls = ['all-in-one', 'table-only', 'map-all-in-one'].includes(canvasType);
			tableControlsCard.style.display = sqlActive || !supportsTableControls ? 'none' : '';
		}
	}

	function updateProgress(message) {
		document.getElementById('progressMessage').textContent = message || '';
	}

	function getUniqueValues(rows, field) {
		const set = new Set();
		rows.forEach(row => {
			const raw = row[field];
			if (raw === undefined || raw === null) return;
			const value = String(raw).trim();
			if (value) set.add(value);
		});
		return Array.from(set).sort((a, b) => a.localeCompare(b));
	}

	function getColorValues(rows, field) {
		const set = new Set();
		rows.forEach(row => {
			let raw = row[field];
			if (raw === undefined || raw === null || raw === '') {
				raw = 'Unknown';
			}
			set.add(String(raw));
		});
		return Array.from(set).sort((a, b) => a.localeCompare(b));
	}

	function stringToColor(value) {
		const hash = Math.abs(hashCode(value));
		const hue = hash % 360;
		return hslToHex(hue, 65, 50);
	}

	function hashCode(value) {
		let hash = 0;
		for (let i = 0; i < value.length; i += 1) {
			hash = ((hash << 5) - hash) + value.charCodeAt(i);
			hash |= 0;
		}
		return hash;
	}

	function hslToHex(h, s, l) {
		s /= 100;
		l /= 100;
		const k = (n) => (n + h / 30) % 12;
		const a = s * Math.min(l, 1 - l);
		const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
		const toHex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
		return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
	}

	function formatNumber(value) {
		return Number.isFinite(value) ? value.toLocaleString() : '0';
	}

	function formatTimestamp(date) {
		const pad = (num) => String(num).padStart(2, '0');
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	}

	function downloadAsCSV(rows, filename) {
		if (!rows.length) return;
		const headers = Object.keys(rows[0]);
		const csvLines = [headers.join(',')];
		rows.forEach(row => {
			const line = headers.map(header => {
				const value = row[header] ?? '';
				const escaped = String(value).replace(/"/g, '""');
				if (escaped.search(/("|,|\n)/) >= 0) {
					return `"${escaped}"`;
				}
				return escaped;
			});
			csvLines.push(line.join(','));
		});
		const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = filename;
		anchor.click();
		URL.revokeObjectURL(url);
	}

	/** Infer a SQL-like column type from sampled row values. */
	function inferColumnType(name, rows) {
		const samples = [];
		for (let i = 0; i < rows.length && samples.length < 200; i++) {
			const v = rows[i][name];
			if (v !== null && v !== undefined && String(v).trim() !== '') samples.push(String(v).trim());
		}
		if (!samples.length) return 'VARCHAR';
		if (samples.every(v => /^-?\d+$/.test(v))) return 'INTEGER';
		if (samples.every(v => !Number.isNaN(Number(v)))) return 'DOUBLE';
		if (samples.every(v => /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]*)?$/.test(v))) return 'DATE';
		return 'VARCHAR';
	}

	// Expose CSV parser for the SQL module to use when copying sources into EDA
	window._edaParseCsv = parseCSV;
	window._edaRenderCatalog = () => renderCatalog();

	// ── Data Catalog ────────────────────────────────────────────────────────
	const catalogSchemaCache = new Map();
	let selectedCatalogDatasetId = null;
	let catalogPreviewSequence = 0;

	function linkifyDesc(text) {
		return escHtml(text).replace(
			/https?:\/\/[^\s&]+/g,
			url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
		);
	}

	function escHtml(str) {
		return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
	}

	function buildCatalogItems() {
		const items = DATASETS.map(ds => ({
			id:          ds.id,
			title:       ds.title,
			description: ds.description || '',
			sourceType:  'preloaded',
			settingsUrl: `${DATA_ROOT}/${ds.id}/${ds.id}-bi-settings.json`,
			indexUrl:    `${DATA_ROOT}/${ds.id}/${ds.id}.index.json`
		}));
		if (window._edaUserDatasets) {
			window._edaUserDatasets.forEach((ds, alias) => {
				items.push({
					id:          alias,
					title:       ds.title || alias,
					description: '',
					sourceType:  'user',
					rows:        ds.rows,
					addedAt:     ds.addedAt  || null,
					fileName:    ds.fileName || null,
					url:         ds.url      || null
				});
			});
		}
		return items;
	}

	function renderCatalog() {
		const list = document.getElementById('catalogDatasetList');
		if (!list) return;
		const items = buildCatalogItems();
		if (!items.length) {
			list.innerHTML = '<div class="catalog-empty-preview">No datasets are available.</div>';
			return;
		}
		const groups = [
			{ id: 'preloaded', label: 'Preloaded datasets', items: items.filter(item => item.sourceType === 'preloaded') },
			{ id: 'imported', label: 'Imported datasets', items: items.filter(item => item.sourceType === 'user') }
		].filter(group => group.items.length);
		list.innerHTML = groups.map(group =>
			`<section class="dataset-tree-group" role="group">`
				+ `<button type="button" class="dataset-tree-branch" data-catalog-group-toggle aria-expanded="true" aria-controls="dataset-tree-${group.id}">`
				+ `<span class="dataset-tree-caret" aria-hidden="true">▾</span>${group.label}<span class="dataset-tree-count">${group.items.length}</span>`
				+ `</button>`
				+ `<div class="dataset-tree-children" id="dataset-tree-${group.id}" role="group">`
				+ group.items.map(item => {
					const description = item.description || item.fileName || item.url || 'Imported in this browser';
					const canRefresh = item.sourceType === 'preloaded'
						|| typeof window._edaRefreshUserSource === 'function';
					const canRemove = item.sourceType === 'user'
						&& typeof window._edaRemoveUserSource === 'function';
					return `<div class="dataset-tree-entry" role="treeitem" data-catalog-dataset="${escHtml(item.id)}">`
						+ `<div class="dataset-tree-node" title="${escHtml(description)}">`
						+ `<i class="bi bi-table" aria-hidden="true"></i><span>${escHtml(item.title)}</span><span class="dataset-tree-loaded" hidden>Loaded</span>`
						+ `</div>`
						+ `<div class="dataset-tree-status" data-cache-status="${escHtml(item.id)}">Checking cache…</div>`
						+ `<div class="dataset-tree-actions">`
						+ `<button type="button" class="btn btn-outline-primary btn-sm" data-catalog-action="preview" data-dataset-id="${escHtml(item.id)}" title="Preview data and schema"><i class="bi bi-eye" aria-hidden="true"></i> Preview</button>`
						+ `<button type="button" class="btn btn-primary btn-sm" data-catalog-action="analyze" data-dataset-id="${escHtml(item.id)}" title="Load this dataset into the visualization and table">Analyze</button>`
						+ (canRefresh ? `<button type="button" class="btn btn-outline-secondary btn-sm" data-catalog-action="refresh" data-dataset-id="${escHtml(item.id)}" title="Reload the dataset from Parquet into DuckDB">Refresh</button>` : '')
						+ (canRemove ? `<button type="button" class="btn btn-outline-danger btn-sm" data-catalog-action="remove" data-dataset-id="${escHtml(item.id)}" title="Remove this imported data source">Remove</button>` : '')
						+ `</div></div>`;
				}).join('')
				+ `</div></section>`
		).join('');
		if (!items.some(item => item.id === selectedCatalogDatasetId)) {
			selectedCatalogDatasetId = items.find(item => item.id === state.datasetId)?.id || items[0].id;
		}
		updateCatalogTreeState();
		updateCatalogSummary(items);
		updateCatalogCacheStatuses(items);
	}

	async function updateCatalogSummary(items) {
		const summary = document.getElementById('catalogSummary');
		if (!summary) return;
		const preloadedCount = items.filter(item => item.sourceType === 'preloaded').length;
		const imported = items.filter(item => item.sourceType === 'user');
		const importedRows = imported.reduce((total, item) => total + (item.rows?.length || 0), 0);
		summary.textContent = `${preloadedCount} Parquet · ${imported.length} imported · ${formatNumber(importedRows)} imported rows`;
	}

	function updateCatalogTreeState() {
		document.querySelectorAll('#catalogDatasetList .dataset-tree-entry').forEach(entry => {
			const isSelected = entry.dataset.catalogDataset === selectedCatalogDatasetId;
			const isLoaded = entry.dataset.catalogDataset === state.datasetId;
			entry.classList.toggle('selected', isSelected);
			entry.classList.toggle('loaded', isLoaded);
			entry.setAttribute('aria-current', isLoaded ? 'true' : 'false');
			entry.querySelector('.dataset-tree-loaded').hidden = !isLoaded;
			const analyzeButton = entry.querySelector('[data-catalog-action="analyze"]');
			analyzeButton.disabled = isLoaded;
			analyzeButton.textContent = isLoaded ? 'Active' : 'Analyze';
			analyzeButton.classList.toggle('btn-success', isLoaded);
			analyzeButton.classList.toggle('btn-primary', !isLoaded);
		});
	}

	function selectCatalogDataset(datasetId) {
		const dataset = buildCatalogItems().find(item => item.id === datasetId);
		if (!dataset) return;
		selectedCatalogDatasetId = dataset.id;
		updateCatalogTreeState();
		renderCatalogDatasetDetails(dataset);
		bootstrap.Modal.getOrCreateInstance(document.getElementById('datasetPreviewModal')).show();
	}

	function renderCatalogDatasetDetails(dataset) {
		const pane = document.getElementById('catalogDetailPane');
		const description = dataset.description
			? linkifyDesc(dataset.description)
			: escHtml(dataset.fileName || dataset.url || 'Imported in this browser');
		document.getElementById('datasetPreviewTitle').textContent = `Preview: ${dataset.title}`;
		const analyzeButton = document.getElementById('datasetPreviewAnalyzeBtn');
		analyzeButton.dataset.datasetId = dataset.id;
		analyzeButton.disabled = state.datasetId === dataset.id;
		analyzeButton.textContent = analyzeButton.disabled ? 'Already Active' : 'Analyze Dataset';
		pane.innerHTML = `
			<div class="catalog-detail-header">
				<div>
					<h4 class="catalog-detail-title">${escHtml(dataset.title)}</h4>
					<div class="catalog-detail-description">${description}</div>
					<div class="catalog-detail-id">${escHtml(dataset.id)}</div>
				</div>
			</div>
			<div class="catalog-preview-tabs" role="tablist" aria-label="Dataset preview mode">
				<button type="button" class="active" role="tab" aria-selected="true" data-preview-tab="data">Data</button>
				<button type="button" role="tab" aria-selected="false" data-preview-tab="schema">Schema</button>
			</div>
			<div id="catalogDataPreview" role="tabpanel">
				<div class="catalog-preview-heading">
					<h6>First 10 rows</h6>
				</div>
				<div id="catalogPreviewStatus" class="catalog-preview-message">Loading preview…</div>
				<div id="catalogPreviewTable"></div>
			</div>
			<div id="catalogSchemaPreview" class="catalog-schema-preview" role="tabpanel" hidden></div>
		`;

		const sequence = ++catalogPreviewSequence;
		void loadCatalogPreview(dataset, sequence);
	}

	function setCatalogPreviewMode(mode) {
		const showSchema = mode === 'schema';
		document.querySelectorAll('#catalogDetailPane [data-preview-tab]').forEach(button => {
			const selected = button.dataset.previewTab === mode;
			button.classList.toggle('active', selected);
			button.setAttribute('aria-selected', String(selected));
		});
		document.getElementById('catalogDataPreview').hidden = showSchema;
		const schemaPane = document.getElementById('catalogSchemaPreview');
		schemaPane.hidden = !showSchema;
		if (!showSchema) return;
		const dataset = buildCatalogItems().find(item => item.id === selectedCatalogDatasetId);
		if (dataset) loadAndRenderCatalogSchema(dataset, schemaPane);
	}

	async function loadCatalogPreview(dataset, sequence) {
		const status = document.getElementById('catalogPreviewStatus');
		try {
			let rows;
			if (dataset.sourceType === 'user') {
				rows = dataset.rows.slice(0, 10);
			} else {
				if (typeof window._edaQuery !== 'function') {
					await window._edaDescribeTable?.(dataset.id);
				}
				if (typeof window._edaQuery !== 'function') {
					throw new Error('DuckDB is not available for the Parquet preview.');
				}
				const result = await window._edaQuery(`SELECT * FROM "${dataset.id}" LIMIT 10`);
				rows = arrowToPlainRows(result);
			}
			if (sequence !== catalogPreviewSequence) return;
			if (!rows?.length) {
				status.textContent = 'Preview unavailable. Try refreshing the dataset or check your connection.';
				return;
			}
			status.textContent = `Showing ${formatNumber(rows.length)} preview rows.`;
			document.getElementById('catalogPreviewTable').innerHTML = renderCatalogPreviewTable(rows);
		} catch (error) {
			if (sequence !== catalogPreviewSequence) return;
			console.error(`Preview failed for "${dataset.id}":`, error);
			status.textContent = `Preview failed: ${error.message}`;
		}
	}

	function renderCatalogPreviewTable(rows) {
		const columns = Object.keys(rows[0]);
		const headers = columns.map(column => {
			const type = inferColumnType(column, rows);
			const icon = type === 'DATE'
				? '<i class="bi bi-calendar3" aria-hidden="true"></i>'
				: type === 'INTEGER' || type === 'DOUBLE'
					? '<span aria-hidden="true">123</span>'
					: '<span aria-hidden="true">Aa</span>';
			return `<th scope="col"><span class="catalog-column-type" title="${type}" aria-label="${type}">${icon}</span><span>${escHtml(column)}</span></th>`;
		}).join('');
		const body = rows.map(row => `<tr>${columns.map(column => {
			const value = row[column] === null || row[column] === undefined ? '' : String(row[column]);
			return `<td title="${escHtml(value)}">${escHtml(value)}</td>`;
		}).join('')}</tr>`).join('');
		return `<div class="catalog-preview-table-wrap"><table class="table table-sm table-striped catalog-preview-table"><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table></div>`;
	}

	async function updateCatalogCacheStatuses(items) {
		const statusElements = [...document.querySelectorAll('#catalogDatasetList [data-cache-status]')];
		await Promise.all(items.map(async item => {
			const status = statusElements.find(element => element.dataset.cacheStatus === item.id);
			if (!status) return;
			if (item.sourceType === 'user') {
				status.textContent = `${formatNumber(item.rows.length)} rows available in browser`;
				return;
			}
			status.textContent = item.id === state.datasetId
				? 'Loaded into DuckDB'
				: 'Parquet ready · loads on Analyze';
		}));
	}

	async function handleCatalogAction(event) {
		const button = event.target.closest('[data-catalog-action]');
		if (!button) return;
		const dataset = buildCatalogItems().find(item => item.id === button.dataset.datasetId);
		if (!dataset) return;
		if (button.dataset.catalogAction === 'preview') {
			selectCatalogDataset(dataset.id);
			return;
		}
		if (button.dataset.catalogAction === 'analyze') {
			const modal = document.getElementById('datasetPreviewModal');
			if (modal.classList.contains('show')) {
				bootstrap.Modal.getOrCreateInstance(modal).hide();
			}
			const entry = button.closest('.dataset-tree-entry');
			const status = entry?.querySelector('[data-cache-status]');
			const analyzeButton = entry?.querySelector('[data-catalog-action="analyze"]');
			if (status) status.textContent = 'Loading dataset…';
			if (analyzeButton) {
				analyzeButton.disabled = true;
				analyzeButton.textContent = 'Loading…';
			}
			const loaded = await selectDataset(dataset.id);
			if (loaded === null) {
				updateCatalogTreeState();
				if (status) status.textContent = 'Load canceled; another selection took precedence.';
				return;
			}
			if (!loaded) {
				if (status) status.textContent = 'Load failed. Check the connection and try again.';
				updateCatalogTreeState();
				return;
			}
			updateCatalogTreeState();
			updateCanvasContextToolbar();
			await persistWorkspace();
			await updateCatalogCacheStatuses(buildCatalogItems());
			return;
		}
		if (button.dataset.catalogAction === 'refresh') {
			await refreshCatalogDataset(dataset);
			return;
		}
		if (button.dataset.catalogAction === 'remove' && window._edaRemoveUserSource) {
			try {
				const removed = await window._edaRemoveUserSource(dataset.id);
				if (!removed) return;
				canvases.forEach(canvas => {
					if (canvas.datasetId === dataset.id) {
						canvas.datasetId = null;
						canvas.controls = {};
						canvas.hiddenColumns = [];
						canvas.mapConfig = null;
						canvas.mapOptions = null;
					}
				});
				if (state.datasetId === dataset.id && DATASETS.length) {
					await selectDataset(DATASETS[0].id);
				}
				renderCatalog();
				updateCanvasContextToolbar();
				await persistWorkspace();
			} catch (error) {
				console.error(`Could not remove dataset "${dataset.id}":`, error);
				updateProgress(`Could not remove "${dataset.title}": ${error.message}`);
			}
		}
	}

	async function refreshCatalogDataset(dataset) {
		const entry = [...document.querySelectorAll('#catalogDatasetList .dataset-tree-entry')]
			.find(item => item.dataset.catalogDataset === dataset.id);
		const status = entry?.querySelector('[data-cache-status]');
		const buttons = entry?.querySelectorAll('[data-catalog-action]');
		if (!entry || !status || !buttons) return;
		buttons.forEach(button => { button.disabled = true; });
		status.textContent = 'Refreshing dataset…';
		try {
			if (dataset.sourceType === 'user') {
				const rows = await window._edaRefreshUserSource(dataset.id);
				if (!rows) throw new Error('The imported source could not be refreshed.');
			} else {
				if (typeof window._edaPrepareDataset !== 'function') {
					throw new Error('DuckDB is not available to refresh this dataset.');
				}
				status.textContent = 'Reloading Parquet into DuckDB…';
				await window._edaPrepareDataset(dataset.id, { refresh: true });
			}

			catalogSchemaCache.delete(dataset.id);
			if (state.datasetId === dataset.id) {
				const loaded = await selectDataset(dataset.id);
				if (loaded === null) {
					status.textContent = 'Refresh complete; reload was superseded.';
					buttons.forEach(button => { button.disabled = false; });
					updateCatalogTreeState();
					return;
				}
				if (!loaded) {
					status.textContent = 'Refresh completed, but reloading failed. Use Analyze to retry.';
					buttons.forEach(button => { button.disabled = false; });
					updateCatalogTreeState();
					return;
				}
				updateCatalogTreeState();
				updateCanvasContextToolbar();
				await persistWorkspace();
				await updateCatalogCacheStatuses(buildCatalogItems());
				return;
			}

			renderCatalog();
		} catch (error) {
			console.error(`Refresh failed for "${dataset.id}":`, error);
			status.textContent = `Refresh failed: ${error.message}`;
			buttons.forEach(button => { button.disabled = false; });
		}
	}

	async function loadAndRenderCatalogSchema(ds, schemaEl) {
		// Only serve from cache when the schema is complete (not partial)
		if (catalogSchemaCache.has(ds.id) && !catalogSchemaCache.get(ds.id).partial) {
			renderCatalogSchemaView(schemaEl, catalogSchemaCache.get(ds.id));
			return;
		}
		// Clear any stale partial entry so we always try to get the full schema
		catalogSchemaCache.delete(ds.id);

		schemaEl.innerHTML = `<div style="color:#adb5bd;font-family:'IBM Plex Mono',monospace;font-size:11px;padding:6px 0">Loading schema&hellip;</div>`;

		if (ds.sourceType === 'user') {
			const sample = ds.rows.slice(0, 200);
			const cols   = sample.length ? Object.keys(sample[0]) : [];
			const columns = cols.map(name => ({ name, kind: 'column', type: inferColumnType(name, sample) }));
			const schema = { columns, recordCount: ds.rows.length, partial: false };
			catalogSchemaCache.set(ds.id, schema);
			renderCatalogSchemaView(schemaEl, schema);
			return;
		}

		try {
			const [settingsResp, indexResp] = await Promise.all([
				fetch(ds.settingsUrl, { cache: 'no-cache' }).catch(() => null),
				fetch(ds.indexUrl,    { cache: 'no-cache' }).catch(() => null)
			]);
			const settings  = settingsResp?.ok ? await settingsResp.json() : null;
			const indexData = indexResp?.ok    ? await indexResp.json()    : null;

			/** Classify a column name using BI settings */
			const classify = name =>
				(settings?.dimensions || []).includes(name) ? 'dimension'
				: (settings?.metrics  || []).includes(name) ? 'metric'
				: 'column';

			if (typeof window._edaDescribeTable !== 'function') {
				throw new Error('DuckDB is not available for the Parquet schema.');
			}
			const duckColumns = await window._edaDescribeTable(ds.id);
			if (!duckColumns?.length) throw new Error(`No schema found for "${ds.id}".`);
			const columns = duckColumns.map(column => ({
				name: column.name,
				kind: classify(column.name),
				type: column.type
			}));
			const recordCount = indexData?.totalRecords ?? settings?.totalRecords ?? null;
			const rcEl = document.getElementById(`catalog-rc-${ds.id}`);
			if (rcEl && recordCount !== null) rcEl.textContent = `${formatNumber(recordCount)}\u00a0records`;

			const schema = { columns, recordCount, partial: false };
			catalogSchemaCache.set(ds.id, schema);
			renderCatalogSchemaView(schemaEl, schema);
		} catch (e) {
			console.error(`Schema preview failed for "${ds.id}":`, e);
			schemaEl.textContent = `Failed to load schema: ${e.message}`;
		}
	}

	function renderCatalogSchemaView(schemaEl, schema) {
		const { columns, recordCount, partial } = schema;
		if (!columns || !columns.length) {
			schemaEl.innerHTML = `<div style="color:#adb5bd;font-family:'IBM Plex Mono',monospace;font-size:11px;padding:6px 0">No field information available.</div>`;
			return;
		}
		const kindIcon  = k => k === 'dimension' ? '&#9783;' : (k === 'metric' ? '#' : '&ndash;');
		const kindLabel = k => k === 'dimension' ? 'dim' : (k === 'metric' ? 'num' : '');
		let subtitle = `${columns.length} field${columns.length !== 1 ? 's' : ''}`;
		if (recordCount != null) subtitle = `${formatNumber(recordCount)}\u00a0records &middot; ${subtitle}`;
		if (partial) subtitle += ' <span style="color:#f0a500;font-size:9px">(BI-configured fields only &mdash; load dataset for full schema)</span>';
		const rows = columns.map(col => {
			const name  = typeof col === 'string' ? col : col.name;
			const kind  = typeof col === 'object' ? (col.kind || 'column') : 'column';
			const type  = typeof col === 'object' ? (col.type || '') : '';
			return `<div class="catalog-field-row">`
				+ `<span class="catalog-field-icon">${kindIcon(kind)}</span>`
				+ `<span class="catalog-field-name" title="${escHtml(name)}">${escHtml(name)}</span>`
				+ (type ? `<span class="catalog-field-type">${escHtml(type)}</span>` : '')
				+ (kindLabel(kind) ? `<span class="catalog-field-kind">${kindLabel(kind)}</span>` : '')
				+ `</div>`;
		}).join('');
		schemaEl.innerHTML =
			`<div class="catalog-schema-body"><div class="catalog-schema-subtitle">${subtitle}</div>${rows}</div>`;
	}

})();
