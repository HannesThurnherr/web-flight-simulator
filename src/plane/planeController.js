export class PlaneController {
	constructor() {
		this.keys = {};
		this.prevKeys = {};
		window.addEventListener('keydown', (e) => {
			this.keys[e.key.toLowerCase()] = true;
			// Tab is the browser's default focus-cycle key. Swallow it so
			// pressing Tab to cycle the designated target doesn't ALSO
			// move DOM focus to whatever button is next in the page.
			if (e.key === 'Tab') e.preventDefault();
		});
		window.addEventListener('keyup', (e) => this.keys[e.key.toLowerCase()] = false);

		this.mouseDragging = false;
		this.mouseDeltaX = 0;
		this.mouseDeltaY = 0;
		this.lastMouseX = 0;
		this.lastMouseY = 0;

		// Absolute cursor position — tracked always (even without drag) so
		// mouse-steering can read it, and so the HUD can draw the cursor
		// line from screen center.
		this.cursorX = window.innerWidth  / 2;
		this.cursorY = window.innerHeight / 2;

		// Mouse steering: when enabled, cursor position relative to screen
		// center drives roll & pitch commands directly. Toggled with M.
		this.mouseSteering = false;

		window.addEventListener('mousedown', (e) => {
			const commanderActive = !!(this.commanderView && this.commanderView.active);

			// Middle mouse button: toggle mouse steering on/off. Clicking
			// once engages, clicking again disengages — no need to hold.
			// Only works in cockpit view (commander disables pilot control
			// anyway). preventDefault swallows browser autoscroll on MMB.
			if (e.button === 1) {
				e.preventDefault();
				if (!commanderActive) {
					this.mouseSteering = !this.mouseSteering;
					if (this.mouseSteering) this.mouseDragging = false;
				}
				return;
			}

			// Left mouse: FIRE — but only while mouse-steering is
			// engaged. Otherwise the cursor is freed for clicking HUD
			// elements (TGP buttons, minimap +/-, etc.) and we don't
			// want every UI click to trip the trigger. Mouse-steering
			// is the explicit "I am flying with the cursor" mode, so
			// gating the left-button trigger on it keeps the two
			// roles cleanly separated. Keyboard fire (F / Enter) is
			// always live regardless. Commander view lets the
			// built-in left-click-pan through unchanged.
			if (e.button === 0 && !commanderActive && this.mouseSteering) {
				this.mouseFireHeld = true;
			}
			// Right mouse: orbit-camera drag. Was left-drag previously;
			// moving to right frees up the left button for trigger /
			// weapon release, which is the conventional flight-sim
			// binding.
			if (e.button === 2 && !commanderActive) {
				this.mouseDragging = true;
				this.lastMouseX = e.clientX;
				this.lastMouseY = e.clientY;
			}
		});

		// Scroll wheel: adjust chase-camera distance. Integrates a scalar
		// zoom factor that main.js reads every frame to scale the plane's
		// visual offset in camera space. Preserves the feel of a real
		// chase camera — pull back to see more context, push in to fill
		// the screen with the airframe.
		window.addEventListener('wheel', (e) => {
			if (this.commanderView && this.commanderView.active) return;
			// Normalise across trackpad / mouse wheel deltas.
			const step = Math.sign(e.deltaY) * 0.08;
			this.cameraZoom = Math.max(0.4, Math.min(2.5, (this.cameraZoom || 1) + step));
			// Don't preventDefault — let Cesium's zoom still work in
			// menu/spawn-picker modes. Flight-time Cesium is slaved to
			// the plane anyway, so the wheel event has no other effect.
		}, { passive: true });

		window.addEventListener('mousemove', (e) => {
			this.cursorX = e.clientX;
			this.cursorY = e.clientY;
			if (this.mouseDragging) {
				this.mouseDeltaX += e.clientX - this.lastMouseX;
				this.mouseDeltaY += e.clientY - this.lastMouseY;
				this.lastMouseX = e.clientX;
				this.lastMouseY = e.clientY;
			}
		});

		window.addEventListener('mouseup', (e) => {
			if (e.button === 0) this.mouseFireHeld = false;
			if (e.button === 2) this.mouseDragging = false;
			// MMB release does nothing — steering is a click-to-toggle.
		});

		this.input = {
			throttle: 0,
			pitch: 0,
			roll: 0,
			yaw: 0,
			boost: false,
			cameraYaw: 0,
			cameraPitch: 0,
			isDragging: false,
			fire: false,
			fireFlare: false,
			weaponIndex: -1,
			toggleWeapon: false,
			// One-shot pulses (true only on the frame the key was pressed,
			// false otherwise). Tab cycles the designated missile target
			// through the set of AESA-locked contacts; Shift+Tab reverses.
			cycleTargetFwd:  false,
			cycleTargetBack: false,
			// Mouse steering UI state — read by the HUD for the cursor line.
			mouseSteering: false,
			cursorX: this.cursorX,
			cursorY: this.cursorY,
		};

		this.sensitivity = 0.2;
	}

	setSensitivity(value) {
		this.sensitivity = value;
	}

	update() {
		this.input.boost = !!this.keys[' '];
		this.input.isDragging = this.mouseDragging;

		this.input.fire = !!this.keys['enter'] || !!this.keys['f'] || !!this.mouseFireHeld;
		this.input.fireFlare = !!this.keys['v'];
		// 6b — T was previously "hold to force STT". Replaced by the
		// explicit player-chosen radar mode (rws/tws/stt) cycled via T
		// in setupGlobalKeybinds (one-shot, edge-triggered). The
		// held-T-force-STT semantics are subsumed by "cycle to STT
		// mode" and stay there until cycled away.

		this.input.toggleWeapon = (!!this.keys['q'] && !this.prevKeys['q']);

		// Target cycle: Tab steps forward through the locked contacts,
		// Shift+Tab steps back. Fire these as single-frame pulses so a
		// held key doesn't chew through the lock list in a blur.
		const tabDown  = !!this.keys['tab']   && !this.prevKeys['tab'];
		const shiftMod = !!this.keys['shift'];
		this.input.cycleTargetFwd  = tabDown && !shiftMod;
		this.input.cycleTargetBack = tabDown &&  shiftMod;

		// Number keys map to the Nth *carried* weapon (see
		// weaponSystem.selectWeapon). The comments are the *typical*
		// position when the loadout includes one of each; with a
		// stripped or expanded loadout the indices auto-shift.
		this.input.weaponIndex = -1;
		if (this.keys['1']) this.input.weaponIndex = 0; // gun
		if (this.keys['2']) this.input.weaponIndex = 1; // AIM-9M
		if (this.keys['3']) this.input.weaponIndex = 2; // AIM-9X
		if (this.keys['4']) this.input.weaponIndex = 3; // AIM-120D
		if (this.keys['5']) this.input.weaponIndex = 4; // METEOR
		if (this.keys['6']) this.input.weaponIndex = 5; // AGM-88 HARM

		// Mouse steering is now middle-mouse-hold (see mousedown/mouseup
		// handlers). M now belongs to the commander view. We still publish
		// the live state to the HUD here.
		this.input.mouseSteering = this.mouseSteering;
		this.input.cursorX = this.cursorX;
		this.input.cursorY = this.cursorY;

		const accelRate = 0.5;
		if (this.keys['w']) {
			this.input.throttle = Math.min(1, this.input.throttle + accelRate * 0.016);
		} else if (this.keys['s']) {
			this.input.throttle = Math.max(0, this.input.throttle - accelRate * 0.016);
		}

		if (this.mouseSteering && !this.mouseDragging) {
			// Cursor relative to screen center → roll, pitch. Full deflection
			// at ~half-screen from center (sensitivity = 2 × distance-to-edge).
			// Feels like a real short-throw stick rather than the full desk
			// swipe you'd need to get full deflection at edge = 1.
			// Frozen while LMB is held — the user is panning the camera,
			// not flying the plane.
			const cx = window.innerWidth  / 2;
			const cy = window.innerHeight / 2;
			const nx = Math.max(-1, Math.min(1, (this.cursorX - cx) / (cx * 0.5)));
			const ny = Math.max(-1, Math.min(1, (this.cursorY - cy) / (cy * 0.5)));
			// Mouse below center (ny > 0) → pitch up; mouse above → pitch down.
			// Sign matches pitch convention already used elsewhere.
			this.input.pitch = this.lerp(this.input.pitch, ny, 0.2);
			this.input.roll  = this.lerp(this.input.roll,  nx, 0.2);
		} else if (this.mouseSteering && this.mouseDragging) {
			// Hold steering inputs at zero while camera-dragging, so the
			// plane flies straight on trim while you look around.
			this.input.pitch = this.lerp(this.input.pitch, 0, 0.3);
			this.input.roll  = this.lerp(this.input.roll,  0, 0.3);
		} else {
			const pitchTarget = (this.keys['arrowup'] ? -1 : (this.keys['arrowdown'] ? 1 : 0));
			this.input.pitch = this.lerp(this.input.pitch, pitchTarget, 0.1);

			const rollTarget = (this.keys['arrowleft'] ? -1 : (this.keys['arrowright'] ? 1 : 0));
			this.input.roll = this.lerp(this.input.roll, rollTarget, 0.1);
		}

		const yawTarget = (this.keys['a'] ? -1 : (this.keys['d'] ? 1 : 0));
		this.input.yaw = this.lerp(this.input.yaw, yawTarget, 0.1);

		if (this.mouseDragging) {
			this.input.cameraYaw += this.mouseDeltaX * this.sensitivity;
			this.input.cameraPitch -= this.mouseDeltaY * this.sensitivity;

			this.input.cameraPitch = Math.max(-85, Math.min(85, this.input.cameraPitch));

			this.mouseDeltaX = 0;
			this.mouseDeltaY = 0;
		} else if (!this.holdCameraOrbit) {
			// Pilot-cam recenters the orbit when the player releases
			// RMB so the chase-cam snaps back to "behind the plane."
			// Spectator-cam wants the opposite: stay where the user
			// last placed it. simLoop sets `holdCameraOrbit` while
			// spectating to suppress the decay.
			this.input.cameraYaw = this.lerp(this.input.cameraYaw, 0, 0.1);
			this.input.cameraPitch = this.lerp(this.input.cameraPitch, 0, 0.1);
		}

		this.prevKeys = { ...this.keys };

		// Publish the live chase-zoom so main.js can scale the plane
		// model's visual offset. Default 1.0 (neutral) until the user
		// scrolls.
		this.input.cameraZoom = this.cameraZoom || 1.0;

		return this.input;
	}

	reset() {
		this.input.cameraYaw = 0;
		this.input.cameraPitch = 0;
		this.mouseDragging = false;
		this.mouseDeltaX = 0;
		this.mouseDeltaY = 0;
		// Spawn throttle at 75% instead of zero. The player starts in the
		// air at cruise altitude — throttle at 0 would mean decelerating
		// from the first frame, which doesn't match the "already flying"
		// premise and led to stalls during the spawn animation.
		this.input.throttle = 0.75;
		this.input.pitch = 0;
		this.input.roll = 0;
		this.input.yaw = 0;
	}

	lerp(start, end, amt) {
		return (1 - amt) * start + amt * end;
	}
}
