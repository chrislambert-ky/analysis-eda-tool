const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

describe('map utilities', () => {
	let mapUtils;

	before(async () => {
		mapUtils = await import('../js/map-utils.mjs');
	});

	it('detects lowercase latitude and longitude fields', () => {
		assert.deepEqual(mapUtils.detectCoordinateFields(['EventID', 'latitude', 'longitude']), {
			latitude: 'latitude',
			longitude: 'longitude'
		});
	});

	it('ignores unrelated fields that begin with an abbreviated coordinate name', () => {
		assert.deepEqual(mapUtils.detectCoordinateFields(['lateral_offset', 'long road name']), {
			latitude: null,
			longitude: null
		});
	});

	it('detects common coordinate aliases without changing original field names', () => {
		assert.deepEqual(mapUtils.detectCoordinateFields(['LAT', 'Lng']), {
			latitude: 'LAT',
			longitude: 'Lng'
		});
	});

	it('returns null when either coordinate field is missing', () => {
		assert.deepEqual(mapUtils.detectCoordinateFields(['Latitude', 'County']), {
			latitude: 'Latitude',
			longitude: null
		});
	});
});
