// ============================================================================
// coordPN — Proportional-Navigation steering toward a fixed ground coord.
//
// Shared by LaserSeeker (laser spot, read live each frame) and GPSSeeker
// (frozen lat/lon/alt captured at launch). The math is identical; only
// the source of the target point differs. Lead-pursuit isn't meaningful
// for a stationary ground point — both seekers just steer at it
// directly with a turn-rate cap that scales with dynamic pressure.
//
// Mutates the missile in place (heading + pitch). Returns range so the
// caller can populate its debug block; everything else lives on
// `missile.data` (flight + seeker config).
// ============================================================================

// Compute desired heading + pitch toward a {lon, lat, alt} target,
// then advance missile.heading/pitch by a PN-rate-capped step. The
// turn-rate cap is a function of speed (low-energy missiles can't
// pull as many G) and the per-munition `seeker.maxG`.
//
// Returns { range, headingError, pitchError } for debug logging.
export function steerTowardCoord(missile, targetLLH, dt) {
	const cosLat = Math.cos(missile.lat * Math.PI / 180);
	const dE = (targetLLH.lon - missile.lon) * 111320 * cosLat;
	const dN = (targetLLH.lat - missile.lat) * 111320;
	const dU = (targetLLH.alt - missile.alt);
	const range = Math.sqrt(dE * dE + dN * dN + dU * dU);
	if (range < 1) {
		return { range, headingError: 0, pitchError: 0 };
	}
	const horizRange = Math.sqrt(dE * dE + dN * dN);
	const desiredHeading = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
	const desiredPitch   = Math.atan2(dU, Math.max(1, horizRange)) * 180 / Math.PI;

	let dH = desiredHeading - missile.heading;
	while (dH < -180) dH += 360;
	while (dH >  180) dH -= 360;
	const dP = desiredPitch - missile.pitch;

	// Speed-dependent G availability: at low speed there's not enough
	// dynamic pressure for the fins to bite. Same shape used by
	// HARM/AAM/LGB so flying-too-slow consistently means flying-dumb.
	const f = (missile.data && missile.data.flight) || {};
	const maxG   = (missile.data.seeker && missile.data.seeker.maxG) || 9;
	const vRef   = f.vManeuverRef ?? 250;
	const gFloor = f.gAvailFloor   ?? 0.05;
	const qFactor = Math.min(1, Math.max(gFloor, (missile.speed * missile.speed) / (vRef * vRef)));
	const gAvail  = maxG * qFactor;
	const maxTurnRad = (gAvail * 9.81) / Math.max(50, missile.speed);
	const capDeg     = (maxTurnRad * 180 / Math.PI) * dt;

	const pn = f.pnGain ?? 4.0;
	missile.heading += Math.max(-capDeg, Math.min(capDeg, dH * pn * dt));
	missile.pitch   += Math.max(-capDeg, Math.min(capDeg, dP * pn * dt));
	missile.pitch   = Math.max(-89, Math.min(89, missile.pitch));

	return { range, headingError: dH, pitchError: dP };
}
