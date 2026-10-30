const STORAGE_KEY = 'analysis_eda_workspace_preferences_v1';

export function readWorkspacePreferences(storage = globalThis.localStorage) {
	const serialized = storage.getItem(STORAGE_KEY);
	if (!serialized) return null;

	const value = JSON.parse(serialized);
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	if (typeof value.datasetId !== 'string' || !value.datasetId) return null;

	return {
		datasetId: value.datasetId,
		chartType: typeof value.chartType === 'string' ? value.chartType : 'bar-horizontal',
		controls: value.controls && typeof value.controls === 'object' && !Array.isArray(value.controls)
			? value.controls
			: {}
	};
}

export function writeWorkspacePreferences(preferences, storage = globalThis.localStorage) {
	if (!preferences || typeof preferences.datasetId !== 'string' || !preferences.datasetId) {
		throw new TypeError('Workspace preferences require a dataset ID.');
	}
	storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}
