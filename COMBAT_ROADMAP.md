# Combat Sim Roadmap — North Star

Long-term target: support complex combat scenarios — BVR, SEAD/DEAD, deep-strike
bomber escort — playable as fighter / bomber / attack aircraft, **or** watchable
as a map-only observer.

This document is the running plan. Update it as phases land, but keep the
overall structure: it is the north star for what "done" looks like.

---

## Current state (audit, snapshot)

| System | Status |
|---|---|
| **Seekers actually guiding** | IR-labeled PN (`src/weapon/missile.js`) and active radar (`src/weapon/aim120.js`). |
| **Stub seekers** | `GPSSeeker`, `LaserSeeker`, `AntiRadiationSeeker`, `NullSeeker` all set `lostLock = true` in ctor and go ballistic. |
| **A/G munitions** | HARM, GBU-12, GBU-31 JSONs exist as hardpoint metadata only. No release path, no guidance. |
| **Flares** | `Flare` class renders. **No missile reads it.** IR seeker has no temperature / decoy logic. |
| **Chaff** | `CountermeasureSubsystem.chaffCount` exists. Nothing sets `cmd.fireChaff`. No seeker looks for chaff. |
| **Radar** | Unified `detectRadar()` in `sensorSystem.js:230` — FOV + aspect-RCS + 4th-root range + terrain LOS via `globe.pick` + Doppler notch (single LOS-velocity check, `:264-269`). Mode field exists; only AIM-120 ever sets `'track'`. No TWS / STT / RWS distinction. |
| **Terrain LOS quality** | Imperfect. `globe.pick` ray sometimes "sees through" terrain — low-altitude masking is unreliable (see Phase 3a). |
| **IFF** | `team === team` string compare. No misID, no interrogation, no degraded ID. |
| **Datalink** | `teamDatalink.js` fuses radar only (not IR / visual, `:57-58`). 4 s memory. |
| **NPC AI** | Subsumption: `MissileEvasion → TerrainAvoid → Engage → Cruise`. Engage does lead/lag pursuit. `EngageBehavior:258-263`: explicit "NOT yet modeled: crank, notch, turn-cold, WEZ modulation". |
| **Terrain avoid** | `behaviors.js:102-105` + `npcUpdate.js:110-115` use a single point-below-aircraft AGL sample. No forward-look. |
| **Ground units** | One static platform: `nasams-sam.json`. Only `sam_site` ground signature. No tanks, AAA, SHORAD, EWR, command posts, depots, ships. |
| **Flight model** | 6DOF quaternion, FBW G-limiter. **No thrust vectoring** — F-22 fakes it with `controlCoef.pitch: 11.5` vs F-15's 8.0. **No post-stall / high-alpha / Cobra / Herbst.** Zero thrust-based moment at low V. |
| **AMRAAM lethality** | Likely too high in flat terrain. Suspect: `notchThresholdTrack = 15 m/s` (very tight) + reacquire every 0.25 s + `lockDropTimeoutS = 1.5 s`. Short beam blinks don't exceed timeout. Maddog reacquire loop (`aim120.js:589-635`) gives many retries. |

---

## Phase 1 — Make the fight survivable (BVR sanity pass)  ⚠ partially implemented

> **Status:** 1.3 + 1.4 landed. Chaff (1.1, 1.2, 1.5) was tried and
> reverted — it didn't feel right and the per-missile chaff scan
> introduced a real perf cost (`detectRadar()` → `globe.pick()` per
> chaff cloud per missile). The remaining sub-phases that *did* land:
>
> - **1.3 — Loosened reacquire.** AIM-120D + SL-AMRAAM JSONs now have
>   `lockDropTimeoutS: 2.5`, `notchThresholdTrack: 25`, exponential
>   reacquire back-off (`0.25 → 4.0 s`, capped at 5 attempts) — a
>   target that holds beam through the back-off window is genuinely
>   lost.
> - **1.4 — Speed-dependent maneuverability.** Both `Missile` (AIM-9X
>   path) and `AIM120` use `G_avail = maxG · clamp((V/V_ref)², gFloor,
>   1)` with `flight.vManeuverRef` (AMRAAM = 600 m/s, NASAMS = 550 m/s,
>   AIM-9X = 450 m/s). Bled-out missiles in their terminal coast
>   simply can't turn fast enough to close the geometry; warhead
>   radius unchanged.
>
> Phase 1.1 / 1.2 / 1.5 (chaff) shelved. Notching alone, combined with
> the corrected maneuverability and back-off, may be sufficient to
> restore survivability without the chaff complexity. Re-evaluate after
> playtest.


Goal: restore notching as a real defensive option; stop the AMRAAM from
being an auto-kill in flat terrain. The fix is *not* "chaff defeats
AMRAAMs"; it's a realistic combination of notch + chaff + the missile
running out of energy.

### 1.1 — Chaff entity + dispenser plumbing

New `src/weapon/chaff.js` mirroring `Flare`. RCS-bloom cloud (~20 m²
peak, exponential decay over ~1.5 s). Visual: small puff of metallic
glints. Wire `cmd.fireChaff` through `CountermeasureSubsystem` parallel
to `cmd.fireFlare`. Player keybind for manual release. No seeker
behavior change yet — this step is just the entity + dispense path.

### 1.2 — Realistic chaff effect on the active-radar seeker

**Modern AESA missiles (AIM-120D-class) are largely chaff-resistant in
normal use.** They hold the target's range *and* Doppler gate; chaff
dropped behind a target flying nose-on falls out of the gate within a
fraction of a second and is filtered as clutter. Chaff alone, without
notch, should do almost nothing against a CCM-modernized seeker.

**Chaff is meaningfully effective only in combination with notching:**
when the target goes beam, the target's own Doppler return drops to
zero — which is *also* where the chaff bloom sits. The radar sees
chaff in the range cell at zero Doppler with no real-target return to
discriminate against. That's the realistic defeat mode and the only
one we model with high probability.

Implementation in `aim120.js` target-pick:
1. **Doppler/range gate filter on chaff.** Each active chaff cloud is
   considered as a pseudo-target *only* if it lies inside the seeker's
   current range gate AND has Doppler near zero relative to the
   seeker's gate centre. Chaff outside the gate is invisible to the
   seeker (filtered) — the standard CCM behavior.
2. **Effect requires beam aspect on the real target.** When the real
   target is *not* notching, the seeker's gate is centred on the
   target's Doppler — chaff at zero Doppler is outside that gate and
   has no effect, regardless of how much chaff is dumped. When the
   target *is* notching, the seeker's gate slides toward zero Doppler
   (or loses lock and tries to re-establish it on the strongest
   zero-Doppler return) and the chaff bloom outshines the now-filtered
   target. Seeker follows chaff → miss.
3. **Per-missile `chaffResistance: 0–1`.** AIM-120D ≈ 0.85
   (mostly rides through even chaff+notch, occasional decoy success);
   generic legacy SARH ≈ 0.3 (much more vulnerable). Modulates the
   probability of the seeker actually transferring track to the chaff
   bloom in the chaff+notch case.
4. **Pre-launch chaff (nice-to-have).** When the launching radar is
   in STT but missile not yet fired, dropping chaff has a chance to
   break the lock. Slot in once 1.2 is solid.

### 1.3 — Loosen the AMRAAM reacquire state machine

The current values are too aggressive in both directions: drop fast,
reacquire fast, never let the target stay un-tracked. Tune:
- `lockDropTimeoutS`: 1.5 → ~2.5 s.
- `notchThresholdTrack`: 15 → ~25 m/s (track notch wider than the
  30 m/s acquisition notch — once a target is in the notch the seeker
  loses them, but a fresh acquisition still needs a real return).
- Reacquire after lock loss: linear retry every 0.25 s → exponential
  back-off (0.25, 0.5, 1.0, 2.0, give up). A target who notches and
  holds beam through 4 s of back-off is genuinely lost, not
  re-snatched on the next tick.

### 1.4 — Speed-dependent maneuverability (replaces "miss-distance scaling")

**Bug today:** `missile.js:454` computes `ω_max = (maxG·g) / max(50, V)`.
This is the kinematic constraint at *fixed* lateral acceleration — but
it has no model of *available* G falling at low V. A bled-out missile
at 250 m/s still pulls the same 40 G as one at peak, which is non-
physical. Lateral force is `½·ρ·V²·S·CN_max`, so available G scales
with `V²`.

Fix:
```
G_available = maxG · clamp((V / V_ref)², 0.05, 1.0)
ω_max       = G_available · g / max(V, 50)
```
with `V_ref ≈ 600 m/s`. Falls out as:

| V (m/s) | G avail | ω (°/s) |
|---|---|---|
| 800 | 40 | 28 |
| 600 | 40 | 37 |
| 400 | 18 | 25 |
| 300 | 10 | 19 |
| 200 |  4.4 | 12 |
| 150 |  2.5 | 9.5 |

A 200 m/s missile pulls 12°/s — a fighter pulling 25°/s out-turns it
trivially and the missile goes ballistic past the target. **Warhead
proximity/lethal-radius is unchanged.** The realistic "bled-out missile
passes harmlessly" effect emerges from the missile being *unable to
turn fast enough to close the geometry*, not from a degraded warhead.

Per-missile tuning hooks: `flight.vManeuverRef` (default 600 m/s),
`flight.gAvailFloor` (default 0.05) — sidewinder-class missiles can
have lower V_ref because their motors burn hotter and shorter.

### 1.5 — AI doctrine: notch + chaff together (not chaff spam)

`MissileEvasionBehavior` already has beam logic. Extend:
- When entering beam against an inbound active-radar missile, fire a
  *combined chaff + flare* sustained-defensive program (Phase 2a).
  Chaff outside of beam aspect is wasted — the AI doesn't dump chaff
  unless it's also doing the notch.
- When notching, hold beam through the missile's entire reacquire
  back-off (Phase 1.3) — typically ~4 s.
- Optional: pre-launch chaff burst when RWR detects STT lock.

**Files:** `src/weapon/aim120.js` (gate filter, reacquire back-off,
maneuver formula), `src/weapon/missile.js` (maneuver formula, vRef hook),
`src/systems/sensorSystem.js` (chaff exposure to radar gate logic),
`src/systems/ai/behaviors.js` (chaff doctrine in MissileEvasion),
new `src/weapon/chaff.js`, munition JSONs (`chaffResistance`,
`vManeuverRef`).

---

## Phase 2 — Flare vs IR, real seeker types  ✅ implemented

> **Status:** Landed. Two distinct IR missiles now coexist:
>
> - **AIM-9M** — `seekerType: "ir"`, reticle/rosette point-source seeker,
>   30° cone, ~30 G turn cap, `flareResistance: 0.10`. Routinely defeated
>   by a hot flare burst in the cone (~61% break-lock per second).
> - **AIM-9X** — `seekerType: "iir"`, imaging IR + thrust-vectoring
>   tail control. ±90° HOBS cone, ~50 G turn cap, V_ref 600 m/s,
>   `flareResistance: 0.92`. Discriminates aircraft silhouette from
>   flare bloom — near-immune (~8% break-lock per second of flare burn).
>
> Per-frame seeker re-evaluation (`Missile._irRecheck`) scores target
> + all live flares in cone+range using `irEmission · aspectFactor /
> range²`, applies the CCM dice roll, and transfers lock if the flare
> wins. Aspect-IR coupling honours the existing `irAspectFactor`
> (tail = 1.0, head-on = 0.1). Module-level flare registry
> (`getActiveFlares()`) keeps the per-frame cost cheap. Player keys:
> 1 gun / 2 AIM-9M / 3 AIM-9X / 4 AIM-120D / 5 METEOR.
>
> Phase 2a — flare burst program — landed alongside: NPCs fire 4-round
> CMDS bursts per trigger via the new `consumeFlareBurst(now, count)`
> helper on `CountermeasureSubsystem`. Player flares already burst (6
> visible per cartridge).


1. **Split `Missile` into IR-specific seeker** that maintains a target IR
   signature vector. During flare release windows, pick the hottest emitter
   in gimbal cone (flare ≫ tailpipe for ~2 s, decaying).
2. **Aspect-IR coupling.** Tailpipe signature ×4 from rear hemisphere, reduced
   from head-on. Mirror existing aspect-RCS code.
3. **Counter-countermeasures knob.** Per-missile `flareResistance: 0–1`. Tune
   AIM-9X (good CCM) vs older MANPADS (poor).

### 2a. Flare programs (modern CMDS dispense pattern)

The current "one flare every X seconds" loop is unrealistic. Real fighters
under threat fire **programmed bursts** — multiple flares over a short
window, often combined with maneuver, then a cooldown. The dispenser is
loaded with one of several pre-set programs and the pilot picks the one
that matches the threat (IR missile vs gun pass vs unknown).

Plan:

1. **Program-driven dispenser.** Replace the periodic interval with a
   program object: `{ count: N, intervalS: 0.15, salvos: K, salvoGapS: 1.0 }`.
   On trigger, dispense `count` flares spaced `intervalS` apart, repeat `salvos`
   times with `salvoGapS` between salvos. Typical numbers — single-burst:
   `{count:4, intervalS:0.1, salvos:1}`; sustained-defensive: `{count:2,
   intervalS:0.15, salvos:6, salvoGapS:0.4}`; pre-emptive in MANPADS box:
   slow drip of singles every 2 s.
2. **Pilot trigger logic.** AI fires the right program for the situation:
   - Active IR missile inbound (in `MissileEvasion`): sustained-defensive
     program until missile is gone or out of fuel.
   - RWR painting + missile launch detected: dual chaff + flare program.
   - Pre-emptive in known threat zone (MANPADS / IR-SAM box): slow drip.
   - Player-fired flares: configurable program via a key (default = single
     burst, hold-key = sustained).
3. **Magazine + reload.** `CountermeasureSubsystem.flareCount` already
   tracks a magazine; respect it in the program runner so a sustained
   program eats it fast and platforms run dry.
4. **Per-platform loadout.** Modern fighters carry 60–240 flares (F-15
   ALE-45 ≈ 60; F-22 has more). Expose in the airframe JSON
   (`countermeasures.flares.capacity`, `countermeasures.flares.programs`).
5. **Visual + audio.** Each flare is already an entity; just spawning more
   of them per second is enough to make a salvo *look* right. Add a
   short "thunk-thunk-thunk" CMDS dispense sound on each flare.

**Files:** `src/weapon/missile.js` (split seeker path), `src/weapon/flare.js`,
`src/systems/countermeasureSubsystem.js` (program runner), `src/systems/ai/behaviors.js`
(MissileEvasion picks programs), `src/systems/signatures.js`, munition JSONs,
plane JSONs (`countermeasures.flares` block).

---

## Phase 3 — Smarter NPCs (terrain + BVR doctrine)

Goal: NPCs don't fly into mountains; they crank/notch like a human would.

### 3a. Forward-look terrain avoid  ✅ implemented

> **Status:** Landed. New `ForwardTerrainAvoidBehavior` slotted at top
> priority in the fighter-pilot stack (above MissileEvasion). Throttled
> to 5 Hz, calls `sensorSystem.forwardLookTerrain(unit, lookAheadM, 6,
> 50)` where `lookAheadM = max(2500, speed · 8)` — i.e. always ≥ 8 s
> of flight time. Re-uses the same multi-sample + curvature-corrected
> chord walker as Phase 3d. Fires when TTI < 7 s; pull-up severity
> ramps from 18° at the warning threshold to 45° at the panic
> threshold (TTI < 2.5 s). Heading is held so the override doesn't
> abandon a beaming evasion mid-maneuver. Once the chord clears (after
> 1-2 s of climb), `isActive` flips off and the next behaviour in the
> priority list takes back over. Static units (parked SAMs etc.) are
> filtered out.


In `behaviors.js:TerrainAvoid`, cast 3 rays (nose, +15° L, +15° R) out to
`V × look_ahead_s` (≈ 8 s at current speed); sample ~5 points along each ray
via `globe.getHeight`. Trigger climb / turn on the ray with least clearance.

### 3b. BVR doctrine behaviors  ⚠ partially implemented

> **Status:** Crank + WEZ landed.
>
> - **CrankBehavior** — slotted between MissileEvasion and Engage in
>   the priority stack. Active when *this unit* has any in-flight
>   active-radar missile (AIM-120 / METEOR / SL-AMRAAM) plus a valid
>   target. Steers 40° off-axis from the bandit, side-locked at the
>   moment of activation, and alternated between successive shooters
>   (so a four-ship doesn't crank into the same airspace). Holds 380
>   m/s, 95% throttle — energy preserved for the post-shot defence.
>   Deactivates when all supporting missiles have gone inactive (hit /
>   missed / out of fuel).
> - **WEZ gate in EngageBehavior** — radar-AAM fire suppressed when
>   `range > maxRange · wezScale` with `wezScale = 0.3 + 0.7 · max(0,
>   (1 + aspectCos)/2)`. Closing target ⇒ 1.0; beaming ⇒ 0.65; cold ⇒
>   0.3. Stops the AI from auto-shooting at 70 km against a beaming
>   bandit who'll just notch the missile out — those shots never
>   landed anyway after Phase 1.4.
>
> Still pending:
> - `NotchBehavior` — already partially live in `MissileEvasionBehavior`
>   (beam logic), but doesn't *hold* the notch through the seeker's
>   full reacquire backoff (Phase 1.3). Deferred — the existing
>   evasion already wins most of these encounters.
> - `ExtendBehavior` — turn-cold when out of weapons / out of energy.
>   Useful tactical-realism polish, not gating.
> - F-pole tuning — implicit in the WEZ gate. Could be more sophisticated
>   (track time-of-flight to impact and the bandit's turn-to-defeat
>   geometry), but the simple aspect scale captures most of the win.

### 3c. Radar modes that matter  ✅ implemented

> **Status:** Landed.
>
> - **NPC behaviour.** Radars sit in `mode: 'search'` (= TWS) by
>   default. `EngageBehavior` records a `_sttCommitAt` timestamp on
>   the pilot when all firing gates pass for a radar AAM, then waits
>   1.5 s before actually setting `cmd.fireWeapon`. During the wait,
>   `npcUpdate` flips the radar to `'track'` (= STT). Post-launch the
>   live-missile check keeps the radar in track for datalink support;
>   when the missile resolves it drops back to TWS. Net effect: the
>   bandit's RWR is silent in TWS scan, then spikes for ~1.5 s before
>   the missile leaves the rail.
> - **Player auto-mode.** `state.sensors.radar.mode` flips to
>   `'track'` whenever the AESA has any `LOCKED` track in
>   `weaponSystem.locks`; otherwise `'search'`. Permissive: fire
>   from TWS (no lock yet) is allowed — Engage's WEZ gate is the
>   real launch authority.
> - **Manual STT override.** New input flag `forceStt` bound to the
>   `T` key. While held, the radar is forced into STT regardless
>   of lock state — useful for spiking a bandit deliberately to
>   trigger their break-turn before you actually shoot.
> - **Distinct player RWR audio.** Two new sound entries
>   `rwr-spike` (looping continuous tone, plays while any RWR
>   contact has `lockType: 'track'`) and `rwr-spike-ping`
>   (one-shot edge-trigger when a new STT spike fires). Both
>   re-use the existing `rwr-tws.mp3` / `rwr-lock.mp3` assets so
>   no new files needed; the separate sound IDs let them play
>   alongside the player's own lock-progress audio without
>   stepping on each other. TWS scan stays silent on the player's
>   end — the visual-only chevron on the RWR scope is enough
>   ambient cue.
> - **HUD already differentiated.** `updateRwrScope` was already
>   colouring `lockType === 'track'` red with an "STT" label; that
>   pre-existing feature now lights up correctly because NPCs
>   actually flip to track mode.

### 3d. Sensor terrain-masking quality (radar, IR, visual)  ✅ implemented

> **Status:** Landed. `sensorSystem.isTerrainBlocked()` rewritten to a
> 6-sample chord walk: at each fraction t ∈ {1/6 … 5/6} along the
> observer-to-target chord, sample `globe.getHeight()` at the
> interpolated lon/lat and compare to the LOS altitude
> `h0 + t·(h1−h0) − t·(1−t)·L²/(2·R_eff)` with `R_eff = 4/3·R_earth`
> for radar refraction. 30 m clearance margin biases toward "masked"
> at the edge. `globe.getHeight` is materially cheaper than `globe.pick`,
> so the new check is faster *and* more reliable. Function exported
> for reuse by Phase 3a forward-look raycast and any future AI
> doctrine like `GoLowBehavior`. Per-platform `lookDownPenaltyDb` and
> `GoLowBehavior` itself are deferred — the LOS-quality fix alone
> already restores meaningful terrain masking for both NPCs and
> player-shot AMRAAMs.


Symptom today: flying low gives almost no advantage because sensors
sometimes see through terrain. The single `scene.globe.pick` ray in
`sensorSystem.js:89-102` is unreliable on slanted line-of-sight at long
ranges — picks miss tile boundaries, return false-clear when the actual
ridge is occluding.

Important: the same `isTerrainBlocked()` function gates **all three
channels** — `scanRadar` (`sensorSystem.js:253`), `scanIR` (`:366`)
and `scanVisual` (`:406`). So the multi-sample upgrade fixes radar,
IR, and visual terrain-masking simultaneously. There is *no* separate
work for IR or visual occlusion — once the shared check is solid, an
F-22 nap-of-earth at 200 ft is hidden from every passive channel
(IRST, DAS, eyeball) along with radar.

Plan:
1. **Multi-sample LOS.** Replace the one-ray check with N samples (5–8) along
   the LOS, each calling `globe.getHeight(samplePointCartographic)` and
   comparing to the LOS altitude at that arc parameter. Any sample where
   terrain > LOS-alt → masked.
2. **Earth curvature term.** Subtract `s² / (2·R_eff)` (with R_eff ≈ 4/3·R_earth
   for refraction) from LOS alt at each sample so long-range geometry is
   right.
3. **Margin policy.** Require ≥ 30 m clearance, not 0 — terrain meshes are
   coarser than reality and we want to bias toward "masked" near the edge.
4. **Per-platform tuning.** Look-down/shoot-down good radars (AWACS) should
   keep more tracks against low movers; legacy SAM acquisition radars should
   lose them sooner. Expose `radar.lookDownPenaltyDb`.
5. **NPC exploitation.** Once masking is reliable, give the AI a `GoLowBehavior`
   when threatened by long-range AMRAAM and terrain ahead is suitable.

**Files:** `src/systems/sensorSystem.js`, `src/systems/ai/behaviors.js`,
new `src/systems/ai/doctrine/{crank,notch,wez,goLow}.js`, platform radar
JSON parameters.

---

## Phase 4 — Populate the ground (SEAD prerequisites)  ⚠ partially implemented

> **Status:** First wave landed. Three new platforms (EWR + SA-15 Tor
> + command post), two new pilot factories (`ewr`, `static-target`),
> emcon support added to the existing `static-sam` pilot, and a
> `sead-intro` scenario showing it off.
>
> The key new behaviour is **emissions discipline**: SAM radars are
> OFF by default and only power up when the team datalink shows a
> hostile air contact within `cueRangeM`. Once cued they engage
> through the existing salvo / cooldown machinery, hold radar on for
> a few seconds after the cue drops (`emconHoldS`), then go silent
> again. This is what enables the "force them to radiate, then HARM
> them" tactic the user wanted — Phase 5's HARM seeker will see the
> emitter only while it's actually radiating.
>
> **New signatures (`signatures.js`):** `ewr`, `shorad`,
> `command_post`. Cue-set in `makeStaticSamPilot` is the explicit
> air-target whitelist (fighter / stealth_fighter / awacs / cargo /
> cruise_missile) so SAMs ignore each other and ignore ground units.
>
> Still pending in Phase 4:
> - **ZSU-23 Shilka, supply depot, runway segment** — three more
>   platform JSONs the original spec listed. Easy follow-up; same
>   pilot factories cover them.
> - **`patrolPilot` for moving ground units** — convoy waypoint
>   following. Not gating; will be added when a scenario actually
>   wants moving ground.
> - **More scenarios** (`deep-strike-escort.json` etc.) — need
>   strike munitions (Phase 5) before they're fully playable.

### Model search terms (placeholders use existing GLBs)

The first-pass platforms reuse `mim-104-patriot.glb` / `phalanx-ciws.glb`
as visual placeholders. Sketchfab / similar search terms for proper
GLBs:

- **EWR** — "early warning radar", "P-14 Tall King radar", "AN/FPS-117 radar",
  "EL/M-2080 Green Pine radar", "rotating radar antenna 3D model"
- **SA-15 Tor** — "SA-15 Tor", "9K330 Tor SAM", "Tor M1 launcher",
  "tracked vertical launch SAM"
- **Command post** — "field command post", "military command tent",
  "HQ bunker 3D model", "command vehicle truck"
- **ZSU-23 Shilka (future)** — "ZSU-23-4 Shilka", "ZSU-23 anti-aircraft",
  "tracked AAA radar gun"
- **Supply depot (future)** — "fuel depot", "ammunition dump",
  "military supply yard 3D model"

Drop the GLB into `public/assets/models/`, update the platform JSON's
`model` path, tune `modelScale` + `modelRotation`, and the platform
shows up correctly without code changes.

---

## Phase 5 — Strike munitions + SEAD + ISR

Goal: kill ground targets, then the radars that protect them. Each
seeker class should *feel* different in the cockpit — that's the
whole point of carrying a mixed loadout. Bulk-target UX so the player
isn't stuck individually clicking 15 bombs.

### 5a. HARM (AGM-88) — anti-radiation

Smallest first commit; exercises the Phase 3c emcon hooks immediately.
Replace `seekers/antiRadiationSeeker.js` stub:
- Fly toward any hostile unit whose `sensors.radar.active === true &&
  mode !== 'off'` lies in launch-FOV cone at launch time.
- Memorize last-known lat/lon when the emitter shuts down. Continue
  to that point ballistic; if the emitter comes back inside seeker
  FOV, re-acquire.
- Per-missile `seekerFovHalfDeg`, `lastKnownTimeoutS` knobs.
- Reactive-emcon SAM doctrine: when a SAM's RWR detects a missile
  with `seekerType: 'anti_radiation'` inbound (it's emitting itself,
  the AGM-88 has its own targeting radar), drop radar to mode='off'
  for ~N seconds. Already half-wired via the existing emcon flag —
  just needs the RWR threat-class check.

UX rhythm: almost free. Same Tab-cycle as AAMs, restricted to
radiating contacts. Player presses fire; missile guides itself.

**Munition GLB:** `agm-88.glb` (✓ in `new_models/new_munition_models/`).

### 5b. Targeting Pod (TGP) and laser-designator UI

Foundational UX that Laser and any future EO/IR-guided weapons
depend on. A real-world TGP (LITENING, Sniper, AN/AAQ-33) is a
gimballed sensor pod giving the pilot a stabilized telescopic view
of the ground, plus a laser designator/spot tracker.

**Layout:** small inset window in the bottom-right of the HUD
(toggleable F1/F2). Roughly the size of the existing minimap.
Contains:
- TGP-eye view rendered from the pod's own camera (separate
  Three.js camera tied to the gimbal). Telescopic FOV (10° / 4° / 1°
  modes).
- Crosshair at the boresight.
- Mini-symbology bar: range to lased point, ground speed, designator
  status (`SLEW` / `TRACK` / `LASE`), time-on-target.
- Loss indicators: `LOS-MASKED` if terrain breaks the chord;
  `CLOUDS` if Phase 9's cloudAttenuation drops below threshold.

**State machine:**
- `SLEW` — pilot drives the pod with mouse-drag (or numpad
  arrows). World-space cross-hair traces the ground; no spot yet.
- `TRACK` — pilot snaps the cross-hair to a 3D point or unit
  (single-tap a key). Pod automatically slews to keep that
  world-frame point in centre. Pilot can change zoom but doesn't
  need to slew.
- `LASE` — laser is firing on the tracked point. Required state to
  drop a GBU-12 against this designation. (Real TGPs require the
  pilot to actively lase during bomb terminal phase.)

**Bomb in-flight view:** the TGP feed continues to show the lased
spot; the bomb's seeker is drawing on this spot. Watching the bomb
arc into the spot is the satisfying part of laser delivery, and
it's also the diagnostic when something fails (spot drift, LOS
break, late lase).

**Implementation notes:** the TGP camera is a second `THREE.Camera`
attached to the player aircraft. Render-to-texture into a small
canvas. Cesium globe layer rendered via the same compositing path
the main HUD already uses (no second Cesium viewer instance — too
expensive). Reuse `chordTerrainHit` for the LOS check from pod →
ground point.

### 5c. GBU-12 Paveway II — laser-guided

`LaserSeeker` homes to the spot designated by a friendly TGP
(self-designation by the dropping aircraft, or buddy-designation by
another platform on the same team). Each tick of guidance:
1. Read the active designation's lat/lon/alt.
2. Run two LOS checks via `chordTerrainHit`:
   - designator → target (from the pod's host aircraft to the
     designated point)
   - bomb → target (from the bomb's current position to the
     designated point)
3. If either LOS is broken (terrain, or — Phase 9 — cloud
   attenuation > threshold), the bomb loses the spot and goes
   ballistic until the spot returns.
4. Otherwise, PN guidance toward the lased point.

**JSON params:** `seekerFovHalfDeg`, `losBreakTimeoutS`, standard
flight model.

**Munition GLB:** packaged inside
`missile__bomb_collection_-_fighter_jets_-_free.glb` (confirmed).
Loader needs to extract the GBU-12 mesh from the collection's scene
graph by node name and instance it as a separate template. New
`missileModels.js` helper to load multi-mesh GLBs and expose
per-name templates.

### 5d. JDAM (GBU-31, GBU-38) — GPS/INS

`GPSSeeker` flies to a fixed lat/lon/alt. Drop-and-forget — no
guidance updates needed once released. Not affected by clouds,
laser-LOS breaks, or chaff/flares (no terminal sensor at all,
just inertial). Defeated by GPS-jamming (Phase 6) but otherwise
weather-immune.

**UX rhythm:** slow and deliberate, pre-mission style. See sub-
phase 5g for the bulk-target / map-pick UI that fronts JDAM and
ALCM. Player picks one or many ground points, queues the bombs,
fires.

**Munition GLB:** packaged inside
`missile__bomb_collection_-_fighter_jets_-_free.glb` (confirmed).
Same per-name extraction as 5c.

### 5e. Cruise missiles — JASSM-class + ALCM

Two munitions sharing a common cruise profile:

- **AGM-158 JASSM** (substituted by **Storm Shadow / SCALP-EG** for
  visual since no JASSM GLB available; gameplay-equivalent):
  low-observable subsonic, GPS/INS, ~370 km nominal, fighter-launched.
- **AGM-86 ALCM**: subsonic, GPS/INS, ~2500 km, terrain-following
  at 50-100 m AGL. Bomber-launched in real life; we'll allow on
  fighters with conformal pylons (F-15EX class) for gameplay.

Shares JDAM's GPS guidance core, plus a **cruise profile**:
1. **Boost** — short, gets the missile clear of the launcher.
2. **Climb** — to cruise altitude (ALCM low ~100 m, JASSM/Storm
   Shadow medium ~3-5 km).
3. **Cruise** — terrain-following via `forwardLookTerrain` (Phase
   3a) to maintain ~100 m AGL for ALCM, plus waypoints if the
   route was authored. JASSM stays at fixed cruise altitude
   straight-line.
4. **Pop-up + dive** — terminal climb followed by top-down attack
   on the GPS coord.

**Munition GLBs:** `agm-86.glb` (ALCM), `storm_shadow_ukraine.glb`
(JASSM substitute) — both ✓ in `new_models/new_munition_models/`.

### 5f. Hardpoint → weapon release wiring

`loadout.js` already counts munitions per simType; the unfinished
half is the weaponSystem release path that knows which physical
hardpoint released the round (matters for visual offset, ejection
direction, residue state). Today we cycle a single `lastMissileSide`
boolean for left/right alternation. Replace with: the loadout
tracks per-hardpoint state, fire() picks the next loaded hardpoint
matching the current weapon's simType, and the launch position
comes from the hardpoint's mount offset.

### 5g. Bulk-target / mass-assign UI

The actual UX challenge of this phase. Click-each-bomb is
unacceptable for any platform with > ~4 strike weapons.

**Important separation from commander view:** the existing commander
view (M key) is *god-eye omniscient* — it shows every unit in the
world regardless of player knowledge — and it stays that way. It's
the debug / replay / future-RTS overlay. The strike planner is a
*different* surface that only shows what the player's team actually
knows: own-sensor contacts + fused team datalink (incl. ISR).

**Strike-planner view (entered via dedicated key, e.g. `B`):**
- True 2D top-down map. Use Cesium's `SceneMode.SCENE2D` if
  feasible, falling back to a flat-tile canvas projection if 2D
  mode behaves badly with the rest of the rendering stack. Either
  way: orthographic top-down, no perspective, no 3D camera.
  Player knowledge only — *not* the god-eye picture.
- Contact source: union of `state.contacts` (own sensors),
  `state.rwr` (emitters painting us), and the friendly team
  datalink. Phase 5j ISR makes this dense at long range; without
  ISR, the planner shows only what's been physically observed.
- All hostile ground contacts the player's team has seen show as
  icons; unknowns appear amber, identified hostiles red, friendlies
  cyan (consistent with the RWR/HUD palette).
- **Memory + staleness.** Once a contact has been observed, it
  stays on the planner indefinitely (or until proven destroyed).
  A unit not currently illuminated by any team sensor is rendered
  as **STALE** with the last-observation timestamp in MM:SS
  ("LAST 02:14") in the contact's tooltip. Stale contacts get
  desaturated colors + a dashed icon outline so they're visually
  distinct from "live" contacts. This matches real strike planning
  — a SAM site bombed yesterday at known coords stays on the
  target list even if no ISR has refreshed the picture today.
  Dead-reckoning of moving stale contacts is borrowed from
  `TargetManagerSubsystem` (already implemented for AI memory).
- Toolbar:
  - **Pick** — click a single contact to assign one munition.
  - **Rectangle** — click-drag to draw a box; everything inside is
    queued.
  - **Lasso** — freehand polygon select for irregular target groups.
  - **Auto-prioritize** toggle — when ON, queue order is automatic
    (SAMs first, command structures second, supply third, by
    range). When OFF, queue follows pick order.
- Right panel: target list. Each row shows `unit-name | weapon |
  remove-button`. Drag rows to reorder; click weapon to swap.
- Default assignment policy: **1 munition per target**, weapon
  type chosen by best-fit (HARM for active emitters, GBU-12 for
  visible/lased units, JDAM for fixed structures, JASSM/ALCM for
  long range).
- Confirm → queue is locked; on FIRE the next queued munition
  releases against the next queued target.
- Cancel → queue cleared; loadout untouched.

**In-flight HUD strip:** small list at bottom showing the next
3-4 queued targets and which munition is wired to each. Scrubs
forward as bombs release.

### 5h. Platform-class targeting capabilities

Different platforms behave differently — the heavy bomber doesn't
fight like a strike fighter. Per-platform JSON flags (in the plane
JSONs):

```json
"strikeCapability": {
  "tgp": true,          // has a targeting pod for laser/EO designation
  "ata": false,         // automated target allocation
                         //   (true = bomber-style: drop a list, auto-distribute)
  "maxQueueDepth": 6    // how many targets the FCS can queue at once
}
```

- **F-15EX, F-16, F-35 (strike fighters)** — TGP true, ATA false,
  queue 6-12. Pilot manually slews and assigns; bulk UI helps but
  active engagement is hands-on.
- **F-22 (air dominance)** — TGP false (no integrated pod by
  default). Can carry JDAM/SDB but designation is via datalink
  cue from another platform.
- **B-2, B-1, B-52 (future bombers)** — TGP false (or limited),
  ATA true, queue 40+. Drop a flight plan with N coordinates;
  bombs auto-distribute.
- **MQ-9 Reaper (future)** — TGP true with extended dwell, ATA
  false. Slew leisurely, designate, drop a Hellfire.

ATA platforms get a richer auto-assignment heuristic (threat
clustering, weapon-target matching) and skip the per-target
manual designation step.

### 5i. AAM ground-targeting gating

Paired with strike munitions landing. AIM-9M / AIM-9X / AIM-120 /
METEOR seekers all gain a `target.signature.unitClass` whitelist
(air-only). WeaponSystem lock-envelope refuses to acquire ground
contacts. Five-line change in `aim120._scanForLock`,
`missile._irScore`, and `weaponSystem.findTargetsInEnvelope`.

### 5j. ISR — finding ground units beyond visual

Today's discovery channels for ground units:
- **Radar:** filtered out by the pulse-Doppler notch (ground
  speed = 0 → notched). This is realistic for air-to-air radar
  modes; no SAR/GMTI mode exists yet.
- **IR:** marginal — `sam_site` irEmission 50, picked up by IRST
  inside maybe 8-12 km in cone.
- **Visual:** clear, but limited to ~12 km in cone.
- **Datalink:** whatever a friendly sees.

So today the player blunders into the SAM engagement zone before
finding it. That's punishingly realistic for a single fighter
without ISR; with ISR support it's manageable.

**5j.1 — ISR drone.** New platform `rq-4-global-hawk` or similar:
- Orbiting at 18 km altitude.
- Sensor: ground-mapping radar with `notchThreshold: 0` (sees
  stationary ground) and a wide ground-FOV (180° wedge under the
  aircraft, range 100-200 km).
- Contacts feed the team datalink; player and other friendlies see
  the picture.
- Becomes a high-value target itself — escort scenarios where the
  Reaper needs cover from CAP.

**5j.2 — Satellite ISR.** Periodic team-wide drop:
- Every `satIntervalS` (default 180), a "satellite pass" event
  fires. Every hostile ground unit gets a snapshot inserted into
  the friendly team datalink, valid for `satMemoryS` (default 600).
- Realistic-ish modeling of NRO / commercial-grade space-based
  imagery.
- No platform spawn needed — it's a scheduled event in the
  scenario's update tick.
- Trades against player skill: heavy ISR makes scenarios easier;
  scenarios author can tune via interval.

### Files

`src/weapon/seekers/AntiRadiationSeeker.js` (real implementation),
`src/weapon/seekers/LaserSeeker.js` (real implementation),
`src/weapon/seekers/GPSSeeker.js` (real implementation),
new `src/weapon/seekers/CruiseGuidance.js` (cruise+pop-up profile),
new `src/ui/tgp/` (targeting-pod camera + state machine),
new `src/ui/strikePlanner/` (map-mode bulk-assign),
new `src/systems/designation.js` (shared designation registry —
single point where a "designated point" exists, queryable by
seekers),
extend `src/data/planes/*.json` with `strikeCapability`,
extend `src/plane/loadout.js` per-hardpoint release state,
extend `src/systems/teamDatalink.js` for ISR contacts,
new platform JSONs `src/data/platforms/rq-4-global-hawk.json`,
new munition JSONs in `src/data/munitions/`.

### Sequencing

| # | Sub-phase | Why this order |
|---|---|---|
| 5a | HARM | Smallest seeker, exercises Phase 3c hooks, no UI work |
| 5b | TGP / laser designator UI | Foundational for 5c and any future EO weapons |
| 5c | GBU-12 | First payoff of the TGP — see the bomb track the spot |
| 5d | JDAM | Same release path as 5e but simpler — get GPS guidance solid |
| 5e | JASSM/Storm Shadow + ALCM | Cruise profile on top of GPS core |
| 5f | Hardpoint release wiring | Cleanup that 5a-5e can use immediately |
| 5g | Bulk-target UI | After release wiring is clean — UI binds to it |
| 5h | Platform-class capability flags | Ties into 5g — some platforms skip the UI |
| 5i | AAM ground gating | Paired commit with 5d/5e arrival so player doesn't lose ranged ground attack |
| 5j | ISR (drone + satellite) | After everything else — extends rather than gates |

---

## Phase 6 — EW, IFF, sensor realism

Goal: the "too perfect" feel disappears.

1. **Jamming.** `JammerSubsystem` on AWACS + dedicated EA platforms. Produces
   a `jammingStrobe` contact (bearing-only, no range). Drops victim's
   `detectRadar()` range ~40 % in ±10° cone toward jammer. Burn-through when
   range < `burnThroughRangeM`.
2. **IFF.** Replace `team === team` with `identifyContact(observer, target)`
   returning `'friendly' | 'hostile' | 'unknown'`. Driven by IFF interrogation
   success + visual-ID range + NCTR. Unknowns appear amber on RWR / HUD;
   shooting an unknown carries kill-friendly risk.
3. **Radar modes complete.** `RWS | TWS | STT`. TWS tracks N (≈ 6) while
   displaying all; STT locks one with higher update rate. Only STT enables
   AMRAAM midcourse update — TWS profile = maddog.
4. **Datalink fusion upgrade.** Publish IR + visual contacts too, not just
   radar. Fuse by spatial proximity so one bandit doesn't show as three
   tracks.

**Files:** new `src/systems/ew/jammerSubsystem.js`, new
`src/systems/iff.js`, `src/systems/sensorSystem.js`,
`src/systems/teamDatalink.js`.

---

## Phase 7 — Thrust vectoring & low-speed / high-alpha flight dynamics  ✅ implemented

> **Status:** Initial implementation landed. `aeroModel.liftCoefficient()`
> now takes per-airframe params (`alphaStallRad`, `clMaxStall`,
> `postStallPlateau`, `stallBlendRad`) and blends a linear attached-flow
> regime into a `sin(2α)` flat-plate post-stall regime via a tanh window.
> `PlanePhysics` carries `tv`, `controlAuthorityFloor`,
> `departureSusceptibility`, all wired in `_integrate()`. Plane JSONs
> tuned: F-22 has `tv: { axes: "pitchYaw", authority: 2.2, vMax: 220 }`,
> low departure (0.15), high post-stall plateau (1.35), `clMaxStall 1.85`,
> α_stall 22°, controlCoef.pitch fudge dropped from 11.5 → 8.5. F-15 has
> high departure (0.85), narrow stall window. F-35 sits in between.
> Tuning numbers will need flight-test passes.


Goal: F-22 feels different from F-15. Cobras, Pugachev's, post-stall
maneuvering, and slow-speed knife-fight handling become possible.

### 7a. Thrust vectoring (small, standalone)

`src/plane/planePhysics.js:447-455` is the aero-moment block. Add a
thrust-moment term:

```
M_tv = thrust × tv_authority × pitch_stick   // 2D (pitch only) or 3D (pitch+yaw)
```

Gate on `V < V_tv_max` (≈ 250 m/s) — TV authority fades as aero authority
takes over. Per-plane `tv.authority` and `tv.axes` in JSON. Remove F-22's
`controlCoef.pitch: 11.5` fudge once this lands.

### 7b. High-alpha aero model

Today, at low V the controls and stability go to zero — the plane just
falls. Realistic high-alpha behavior is missing.

1. **Non-linear lift curve.** Replace small-angle `Cl ≈ Cl_α · α` with a
   curve that peaks around α ≈ 18–22°, drops post-stall, plateaus into the
   60–90° regime (flat plate). Different curves per planform — a thrust-
   vectoring fighter recovers stability deep into post-stall, an F-15
   doesn't.
2. **Departure characteristics.** Above critical α with no TV authority,
   inject a small random yaw moment (departure / wing-rock). Makes losing
   energy in a turning fight punishing on non-TV jets.
3. **Pitch-rate capability at low V.** Today rate damping ∝ ρV vanishes at
   low V — fine. Stability moments also vanish — *not* fine, since real
   aircraft still have pitch authority through control surfaces in the
   propwash / jet wash. Add a small `controlAuthorityFloor` so elevator
   does *something* at 80 kts.
4. **Cobra-able airframes.** Combined with TV (7a), a tagged `tv: { axes: 'pitch', authority: X }`
   plane should be able to: pull through to ~110° α, hold briefly with TV +
   plate-lift drag, recover when energy decays. Sets up genuine WVR
   advantages for Su-37 / F-22 class jets.
5. **Per-plane tuning JSONs.** Expose: `alphaStallDeg`, `clMaxStall`,
   `clPostStall60Deg`, `departureSusceptibility`, `controlAuthorityFloor`,
   `tv.authority`, `tv.axes`.

**Files:** `src/plane/aeroModel.js`, `src/plane/planePhysics.js`,
plane JSONs (`f-15.json`, `f-22.json`, `f-35.json`, plus future Su-class).

---

## Phase 8 — Contrails & visual ID cues

Goal: high-altitude bandits are spottable by the naked eye well before
radar acquisition, the way they are in real BVR. Adds a visual-ID
channel that interacts with IFF (Phase 6) and gives the map view real
texture.

1. **Contrail emission.** Particle / ribbon trail behind each engine,
   spawned only when ambient conditions favor condensation:
   `altitude > ~7,500 m` AND `temperature < ~ -40 °C` (use altitude as a
   proxy via standard atmosphere). Per-plane `contrailEnabled` toggle so
   stealth jets at low power can suppress (future tuning).
2. **Lifetime + dispersion.** ~30–60 s lifetime, slow lateral spread,
   alpha fade. Long enough to mark a track on the map view, short enough
   not to clutter.
3. **Visual sensor coupling.** The visual channel in `sensorSystem.js`
   should treat a fresh contrail as a detection booster — extends visual
   range against high-altitude targets, even when the airframe itself is
   below visual-acuity threshold.
4. **Missile smoke trails.** Already partially modelled; unify with the
   contrail system so a missile motor burn produces a thicker, shorter-
   lived trail with the same renderer path.
5. **Map view rendering.** Commander view shows contrails as fading
   polylines so a watcher can spot inbound strikes by trail signature
   alone.

**Files:** new `src/fx/contrail.js`, hook into `src/plane/loadPlayerPlane.js`
+ `src/systems/npcSystem.js` per-NPC mesh setup, extend `src/systems/sensorSystem.js`
visual channel, render in `src/systems/commanderView.js`.

---

## Phase 9 — Clouds & weather

Goal: real tactical use of weather. Fly through and along clouds with
proper perspective and parallax, hide behind cloud banks for visual /
IR / laser concealment, choose weather presets per scenario.

Rendering tech is secondary — the gameplay (sensor coupling, weather
authoring, fly-through experience) is the point. Avoid full Nubis-grade
volumetric raymarching: at 30–60 % of frame budget it would crowd out
NPC AI, sensor scans, contrails, and ground unit work.

### 9a. Cloud volumes as gameplay objects (no rendering yet)

`CloudField` system holds a list of volumes (boxes / spheres / layered
slabs) tagged with density. Pure data, ~zero perf cost. Sensors query:

- `isInsideCloud(point)` — for inside-the-cloud effects.
- `cloudAttenuation(observerPoint, targetPoint)` — integrates density
  along the LOS, returns 0–1 attenuation.

Sensor channel coupling — *realistic*, not "clouds defeat everything":

| Channel | Effect |
|---|---|
| Visual | Strong attenuation; inside thick cloud → near-zero range |
| IR | Significant attenuation, scaled by density |
| Laser (designators / LGB) | Heavy degradation — LGBs lose track when target obscured |
| Radar | **Unaffected** by typical clouds (only heavy precip attenuates, defer that) |

Tactical surface this opens up: hide from Sidewinders in cloud, ruin a
JDAM/LGB strike with weather over the target, sneak up visually using a
cloud layer between you and a bandit. AMRAAM and SAM radars are
*not* defeated by cloud — you still need notching or terrain. This is
realistic and gameplay-good.

### 9b. Weather presets

Per-scenario JSON:

```json
"weather": {
  "preset": "clear" | "scattered" | "broken" | "overcast" | "stormy",
  "cloudBaseM": 2000,
  "cloudTopM": 4500,
  "coverageFraction": 0.6
}
```

Preset expands deterministically into cloud volume positions at scenario
start (seeded RNG so volumes don't shimmer or vary between sessions).
Author 4–5 presets covering clear, scattered cumulus, broken layer,
overcast deck, and a low-vis ground-attack scenario.

### 9c. Particle-cluster cloud rendering

Each `CloudField` volume is rendered as a **cluster of 30–100 small soft
sprites** scattered through its bounding volume (not a single billboard).
Varying X/Y/Z offsets, varying sizes, varying alphas. Each sprite still
faces camera, but because the sprites occupy *real 3D positions*, the
result delivers:

- **Parallax** — fly past, near sprites slide faster than far ones. The
  cloud has shape from every angle.
- **Fly-through** — pass between/through the sprites. Front sprites pass
  behind the camera, back ones grow larger. Feels like flying into a cloud.
- **Perspective** — distant clouds compress, nearby ones tower over you.
- **Variable density** — fewer sprites = wispy cumulus, denser packing =
  thick cumulonimbus.

This is the technique used by Falcon 4 / BMS, MSFS pre-2020, DCS legacy
clouds. Cost is well under 1 ms on any GPU for thousands of sprites
across the visible sky. Cesium's depth buffer handles occlusion via the
shared depth-texture path.

What we explicitly skip: god rays, precise self-shadowing, perfectly soft
edges from every angle. Each sprite gets a baked light gradient — that's
enough at flight-sim ranges. Soft-particle blending hides depth-boundary
artifacts.

Determinism: sprite positions seeded per-volume so the cloud shape is
identical across sessions / replays / spectator views.

### 9d. Inside-cloud fog

When the camera enters a `CloudField` volume, the scene fog colour ramps
to cloud-grey and visibility falls. World geometry fades. This is what
*sells* "I'm in a cloud" more than the sprite renderer does — the
player's brain fills in the rest.

Implement via Cesium's fog parameters and a matching Three.js fog colour
ramp so cockpit + world stay consistent. Audio cue (optional): muffled
ambient when inside.

### 9e. (Far later, optional) Volumetric upgrade

If frame budget ever has slack and the visual quality of 9c starts to
feel limiting, the cluster renderer can be replaced with localized
quarter-resolution volumetric raymarching (something like the
`@takram/three-clouds` Low preset). The 9a–9d gameplay layer is
unchanged — sensors, weather, sim logic all keep working. Don't do this
until everything else in the roadmap ships and frame-time profiling
shows real headroom.

**Files:** new `src/systems/weather/cloudField.js`, new
`src/fx/cloudCluster.js` (sprite renderer), extend
`src/systems/sensorSystem.js` (visual / IR / laser attenuation),
extend `src/systems/scenarios/scenarioRunner.js` (weather block parsing),
fog tuning in `src/world/cesiumWorld.js` and Three.js scene.

---

## Phase 10 — Scenario editor

Goal: a graphical, in-engine scenario editor so you can build complex
combat scenarios (BVR sweeps, SEAD strikes, deep penetration escorts,
SAR rescues, multi-stage campaigns) without hand-editing JSON. The same
data model that `scenarioRunner.buildScenarioFromJson()` already
consumes is the editor's *output* — a saved scenario from the editor
is byte-for-byte interchangeable with the hand-authored JSONs in
`src/data/scenarios/`.

This is the largest tooling workstream on the roadmap; it underwrites
all the gameplay phases above by making them *playable in interesting
configurations* without programmer involvement.

### 10a. Scenario JSON schema (formalisation)

Today's JSONs (`bvr3way.json`, `awacs-bvr.json`, `sam-intro.json`)
share an implicit schema known only by inspection. Phase 10a writes
it down: a JSON-schema document plus inline JSDoc on every field so
both the editor UI and human authors have one source of truth.

Fields we know we'll need (some already in scenarioRunner, some new):

```jsonc
{
  "id": "kebab-case-id",
  "name": "Display name",
  "description": "Briefing text shown on the picker card",

  // Triangle / arena geometry — where the player + spawns sit.
  "triangleSideM": 180000,
  "autoSpawn": true,           // background reinforcement loop
  "maxNpcs": 8,                // population cap (new)
  "weather": { /* Phase 9b */ },

  "spawns": [
    {
      "type": "fighter" | "platform",
      "platformId": "f-15-fighter",       // for type=platform
      "team": "friendly|hostile-red|hostile-blue",
      "origin": { /* placement spec */ },
      "loadout": { /* per-hardpoint munition ids — new */ },
      "pilotOverrides": { /* pilot-specific tuning */ },
      "behaviorOverrides": { /* tweak isActive cadence etc. */ },
      "count": 1,
      "label": "Bandit-1"                 // shown in HUD / log
    }
  ],

  "objectives": [                // new — Phase 10d
    { "kind": "destroy",  "tag": "bandit-flight",  "count": "all" },
    { "kind": "protect",  "tag": "AWACS",          "minRemainingS": 600 },
    { "kind": "no-fly",   "polygon": [...],        "team": "player" },
    { "kind": "escort",   "tag": "bomber",         "toLatLon": [...] }
  ],

  "triggers": [                  // new — Phase 10d
    {
      "when": { "kind": "kill", "targetTag": "AWACS" },
      "do":   [ { "action": "broadcast", "text": "AWACS DOWN" },
                { "action": "spawn", "ref": "reinforcement-1" } ]
    },
    {
      "when": { "kind": "timer", "atSec": 120 },
      "do":   [ { "action": "spawn", "ref": "second-wave" } ]
    }
  ],

  "tags": {                      // named units the triggers reference
    "AWACS":          { "spawnIndex": 0 },
    "bandit-flight":  { "spawnIndices": [1, 2, 3] }
  }
}
```

Deliverable: `src/data/scenarios/schema.json` + `docs/scenario-schema.md`.
The schema lives in source so editor + runner load the same definition.

### 10b. Map-based placement UI

A new top-level mode entered from the main menu ("Edit Scenario").
Reuses the commander-view camera + minimap stack — top-down or
isometric Cesium globe; click on map to drop a spawn marker; drag to
move, right-click for context menu (delete, duplicate, change type).

Tools across the bottom of the screen: pan, place-fighter,
place-platform, place-objective-zone (polygon), measure-range,
preview-line-of-sight (uses the multi-sample LOS from Phase 3d).

Live numeric readout while placing: range from player, range from
nearest other spawn, altitude — so the author knows whether they're
setting up a 30 km IR knife-fight or a 150 km BVR sweep.

### 10c. Per-unit config panels

Click a placed unit → side panel opens with:

- **Type & team** — fighter / bomber / SAM / AWACS / cargo / ground
- **Platform** — dropdown of platform JSONs (`platforms/*.json`)
- **Pose** — heading / altitude / initial speed (with sensible
  defaults based on platform — cruise alt for AWACS, 200 ft for an
  ingressing strike package, etc.)
- **Loadout** — full hardpoint editor pulled in from the existing
  `planeLoadoutView.js`, scoped to the platform's hardpoint list
- **AI behavior preset** — "patrol racetrack" / "BVR sweep" /
  "ground attack" / "static SAM" / "kamikaze ramming" / "scripted
  waypoints"
- **Behavior overrides** — knobs the preset exposes (e.g. patrol
  radius, BVR commit range, SAM range envelope multiplier)
- **Tag** — name handle for triggers / objectives to reference

### 10d. Trigger + objective system

Runtime side: `scenarioRunner.update()` evaluates objective state
each tick (kill counts, region presence, timers) and walks the
trigger list firing matching actions. State is observable via a
tiny event bus the rest of the sim can listen on (HUD shows
"OBJECTIVE COMPLETE" toasts; engagement log tags scripted spawns
as such).

Trigger events: `kill`, `region-enter`, `region-exit`, `timer`,
`objective-complete`, `engagement-start`, `engagement-end`,
`scenario-start`.

Trigger actions: `spawn` (with full unit spec or a named template),
`despawn`, `broadcast` (radio-style HUD message), `set-objective`,
`end-scenario`, `play-sound`, `set-weather` (Phase 9), `move-camera`
(commander view), `unlock-area` (allow further spawns in a region).

Authoring UI: a dedicated "Triggers" tab in the editor with a node-
graph-lite — left column lists trigger conditions, drag to add
actions, save. No full visual programming language; just enough to
hand-assemble a 10-trigger mission without touching JSON.

### 10e. Save / load / export

- **localStorage** — auto-save every change (with diffable history
  so an undo stack is feasible) so a half-built scenario survives a
  reload.
- **Named slots** — save under a slot name; load from the same.
- **Export JSON** — download a `.json` the user can commit into
  `src/data/scenarios/` for distribution.
- **Import JSON** — drag-and-drop or file-picker to load any
  existing scenario into the editor (the hand-authored ones too —
  edit `bvr3way.json` graphically).

### 10f. In-place test mode

A "Test" button on the editor toolbar runs the current scenario
without leaving the editor: switches to FLYING state, lets the player
fly the mission. ESC returns to the editor with the layout intact.
Lets the author iterate quickly without round-tripping through the
main-menu picker.

### 10g. Briefing screen

The pre-launch view of a scenario — map overview, objectives,
expected threats, ROE notes, weather. Authored as part of the
scenario JSON (`briefing` block: text + map markup). Shown on the
main-menu picker when the scenario is selected, and again on spawn
in case the player wants a refresher.

### 10h. Campaign mode (stretch)

Chain scenarios into a sequence with state carried forward —
remaining ammo / damage / kill score from one mission rolls into
the next, available aircraft narrows based on losses, etc. JSON-
configured: `campaign.json` referencing scenario IDs in order with
inter-mission transition text.

**Files:** new `src/ui/scenarioEditor/`, new `src/systems/scenarios/triggers.js`,
extend `src/systems/scenarios/scenarioRunner.js` (objectives + trigger eval),
new `src/data/scenarios/schema.json`, integrate with existing
`src/ui/planeLoadoutView.js` for per-unit loadout editing, hook
events into `src/systems/eventLog.js` so triggers can pattern-match
on kills, possibly extract `src/systems/scenarios/buildScenarioFromJson.js`
out from `scenarioRunner.js` once the field surface grows.

**Risks / scope notes:**
- Whole sub-system; expect 8-15× the LOC of any single gameplay phase.
- Tempting to spec every trigger action up front — resist. Ship 10a
  + 10b + 10c first; that alone unlocks ~80% of useful scenarios.
  Triggers (10d) are best added once you know which actions the
  scenarios you actually want to run need.
- The trigger graph UI is the highest-effort sub-phase. Start with a
  flat trigger list editor (form fields, no graph) — graph is polish.

---

## Suggested sequencing

| Block | Focus |
|---|---|
| 1 | Phase 1.1–1.5 (chaff + AMRAAM balance + notch-doctrine AI) — survivability fast. Phase 1.4 (speed-dependent G) lands with this block, not deferred. |
| 2 | Phase 2 (IR seeker + flares + flare programs 2a) |
| 3 | Phase 3a (forward-look terrain) + 3d (radar masking) — both NPC and player feel low-altitude flight differently |
| 4 | Phase 7a + 7b (TV + high-alpha) — small surface area, high payoff |
| 5–6 | Phase 3b + 3c (BVR doctrine + radar modes) |
| 7–8 | Phase 4 (ground units + scenarios) |
| 9–11 | Phase 5 (strike munitions) |
| 12+ | Phase 6 (EW / IFF / sensor realism) |
| any | Phase 8 (contrails) — small, mostly cosmetic + visual-sensor tweak; slot in whenever the renderer has bandwidth |
| early | Phase 9a + 9b (cloud volumes + weather presets, no rendering) — gameplay-only, can land alongside Phase 1; sensor coupling immediately useful |
| mid | Phase 9c + 9d (particle-cluster rendering + inside-cloud fog) — once some volumes exist to render |
| defer | Phase 9e (volumetric upgrade) — only if frame budget shows slack after everything else ships |
| 13–15 | Phase 10a + 10b + 10c (scenario editor — schema + map placement + per-unit panels) — slot **after** Phase 4 ground units exist so the editor has interesting unit types to place, but **before** Phase 5 strike munitions so SEAD scenarios can be authored as soon as the munitions land |
| 16–17 | Phase 10d + 10e (triggers + save/load) — once the basic editor is in shape and you know which actions you actually need |
| late  | Phase 10f + 10g + 10h (test mode + briefing + campaign) — polish layer; ship after the editor is feature-complete for one-off missions |

Phases are decoupled enough that the sequence can shift based on what's
fun-broken vs fun-missing in playtest.

---

## Architectural notes

- The `ctx` / subsystem / seeker-factory patterns established in the
  recent main.js refactor absorb all of the above without further
  structural changes.
- Adding HARM, jammers, ground patrol pilots, or post-stall aero all
  fit cleanly into existing module boundaries.
- Outstanding refactor debt unrelated to this roadmap:
  - `src/ui/hud.js` (2,482 lines) — Phase F.15, deferred.
  - `src/systems/commanderView.js` (1,564 lines) — Phase F.16, deferred.
  - `src/systems/npcSystem.js` (534 lines) — slightly over the 500 target,
    acceptable.

Both deferred HUD/commander splits should be tackled before Phase 5,
because new strike-munition designation UI and new ground-unit map
markers will both touch those files heavily.
