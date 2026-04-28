// ============================================================================
// munitionSpec — required-fields contract for missile data.
//
// Same problem as planeSpec: silent fallbacks let a JDAM with a
// missing `seeker.maxG` quietly turn at 9 G (a hardcoded coordPN
// default), and a Missile constructed without `data` silently fell
// back to DEFAULT_AIM9_DATA. validateMunitionSpec throws on any
// missing required field, naming both the field and the munition id.
//
// Required fields are split by what's universal (any munition) vs
// per-seekerType (IR seekers don't need activeRangeM; coord seekers
// don't need flareResistance).
// ============================================================================

// Universal required fields — every munition JSON, regardless of
// seekerType. flight + warhead are always required. seeker varies
// per type below.
const UNIVERSAL_FLIGHT_FIELDS = [
	'flight.launchSpeedOffset',
	'flight.boostDurationS',
	'flight.boostAccel',
	'flight.peakSpeed',
	'flight.minSpeed',
	'flight.maxLifeS',
	'flight.maxTurnDegPerSec',
	'flight.pnGain',
	'flight.dragRef',
	'flight.dragRefSpeed',
	'flight.dragRefAltitude',
	'flight.vManeuverRef',
	'flight.gAvailFloor',
];

const UNIVERSAL_WARHEAD_FIELDS = [
	'warhead.killRadiusM',
	'warhead.fuzeSenseRadiusM',
];

// Per-seekerType required `seeker.*` fields. The whole point of this
// table is that adding a new seeker type forces the author to think
// about which seeker fields are mandatory, instead of leaning on
// hardcoded fallbacks scattered across hot-path guidance code.
const SEEKER_FIELDS_BY_TYPE = {
	'ir': [
		'seeker.coneHalfAngleDeg',
		'seeker.maxG',
		'seeker.flareResistance',
		'seeker.trackRangeM',
	],
	'iir': [
		'seeker.coneHalfAngleDeg',
		'seeker.maxG',
		'seeker.flareResistance',
		'seeker.trackRangeM',
	],
	'active_radar': [
		'seeker.activeRangeM',
		'seeker.fovHalfAngleDeg',
		'seeker.nominalDetectRangeM',
		'seeker.referenceRcs',
		'seeker.notchThresholdAcquire',
		'seeker.notchThresholdTrack',
		'seeker.lockDropTimeoutS',
		'seeker.reacquireIntervalS',
		'seeker.reacquireBackoffMul',
		'seeker.reacquireMaxIntervalS',
		'seeker.reacquireMaxAttempts',
	],
	'anti_radiation': [
		'seeker.fovHalfAngleDeg',
		'seeker.emissionLossMemoryS',
		'seeker.maxG',
	],
	'laser': [
		'seeker.fovHalfAngleDeg',
		'seeker.losBreakTimeoutS',
		'seeker.maxG',
	],
	'gps': [
		'seeker.maxG',
	],
	'cruise': [
		'seeker.maxG',
		// cruise-specific flight fields. Living under flight.* (not
		// seeker.*) because they're profile-shape parameters, not
		// terminal seeker behaviour.
		'flight.cruiseAltM',
		'flight.cruiseTurnG',
		'flight.climbAngleDeg',
		'flight.terminalRangeM',
		'flight.popUpAltAGL',
		'flight.diveAngleDeg',
	],
	'null': [], // dumb projectile; no seeker fields
};

function _readPath(obj, path) {
	const parts = path.split('.');
	let cur = obj;
	for (const p of parts) {
		if (cur == null) return undefined;
		cur = cur[p];
	}
	return cur;
}

function _checkFields(munitionId, data, fields, missing) {
	for (const f of fields) {
		const v = _readPath(data, f);
		if (typeof v !== 'number' || !Number.isFinite(v)) {
			missing.push(f);
		}
	}
}

export function validateMunitionSpec(munitionId, data) {
	if (!data || typeof data !== 'object') {
		throw new Error(`[munitionSpec] munition "${munitionId}" has no data object`);
	}
	const seekerType = data.seekerType;
	if (typeof seekerType !== 'string') {
		throw new Error(`[munitionSpec] munition "${munitionId}" missing seekerType`);
	}
	// 'null' seeker is for non-projectile carry items (drop tanks).
	// They never get instantiated as a flying missile so flight /
	// warhead can be null. Skip the rest of the validation.
	if (seekerType === 'null') return;

	const seekerFields = SEEKER_FIELDS_BY_TYPE[seekerType];
	if (!seekerFields) {
		throw new Error(
			`[munitionSpec] munition "${munitionId}" has unknown seekerType "${seekerType}". ` +
			`Add it to SEEKER_FIELDS_BY_TYPE in munitionSpec.js with the required seeker fields.`,
		);
	}

	const missing = [];
	_checkFields(munitionId, data, UNIVERSAL_FLIGHT_FIELDS,   missing);
	_checkFields(munitionId, data, UNIVERSAL_WARHEAD_FIELDS,  missing);
	_checkFields(munitionId, data, seekerFields,              missing);
	if (missing.length) {
		throw new Error(
			`[munitionSpec] munition "${munitionId}" (seekerType=${seekerType}) is ` +
			`missing required numeric fields: ${missing.join(', ')}`,
		);
	}

	// Cruise has one string-valued required field (cruiseAltMode)
	// the numeric validator can't catch. Check separately.
	if (seekerType === 'cruise') {
		const m = data.flight && data.flight.cruiseAltMode;
		if (m !== 'agl' && m !== 'msl') {
			throw new Error(
				`[munitionSpec] cruise munition "${munitionId}" must declare ` +
				`flight.cruiseAltMode as 'agl' or 'msl' (got ${JSON.stringify(m)})`,
			);
		}
	}
}

export {
	UNIVERSAL_FLIGHT_FIELDS,
	UNIVERSAL_WARHEAD_FIELDS,
	SEEKER_FIELDS_BY_TYPE,
};
