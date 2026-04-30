# Jamming Design — Phase 6e

Self-contained design doc covering the full Phase 6e implementation
(`COMBAT_ROADMAP.md` references this as the source of truth).
Authored after multiple rounds of design correction; reflects the
realistic model agreed with the user.

---

## 1. Philosophy

Jamming is **not a fire-and-forget consumable** like flares. It's a
**continuously-running emitter** with realistic costs:

- **No artificial cooldowns, no charge counters, no heat bars.**
  Real EW pods sustain emissions for the entire mission. Power
  comes from the engine.
- The actual costs are **HARM-attraction** and **bearing-only
  revelation** (you tell the world someone is roughly in your
  direction, but not your exact position).
- Jamming makes you **harder** to track on the victim's radar
  (the whole point of jamming) but **easier** to attack via
  anti-radiation weapons (HARM, Vympel-class).

The gameplay loop this creates: a strike package using EW
absorbs HARM attention while stealth-equipped strikers stay quiet
behind. The jammers' counter to incoming HARMs is mixing bearings,
breaking line-of-sight on terrain, or having decoys absorb the
HARM seeker.

---

## 2. Engagement models — both available

### 2.1 OFFENSIVE — targeted (weapon-style)

Player picks a specific emitter and beams jam energy at it
sustained.

- **Selection:** Q cycles to the jammer slot in the weapon list,
  same pattern as gun / AAMs / HARM.
- **Designation:** Tab cycles through valid targets — the union
  of (a) currently active RWR strobes (bandits painting you) and
  (b) AESA radar contacts (whoever your radar is tracking). Same
  cycle pattern as HARM emitter selection.
- **Engagement:** F/Enter held = sustained beam. Release = stop.
  Toggle-mode (one press = on, second press = off) is a UX
  variant to consider once we test.
- **No cooldown.** Runs as long as engaged.
- **Visualization on scope:** narrow cone with **animated
  diagonal stipple moving outward** from own-ship-center toward
  the designated victim's bearing. Color-coded by class:
  red-orange = radar jam, magenta = comms jam.
- **Effect on victim:**
  - Their radar's effective range against you (and against
    anything in the same cone segment from their POV) drops by
    ~60% while engaged.
  - Their inbound active-radar missiles get midcourse-update
    rate cut — translates to wider terminal acquisition baskets,
    lower Pk.
  - Comms-jam variant: hostile DL reception in cone is degraded.

### 2.2 DEFENSIVE — protective bubble (toggle)

Player runs a wide-area protective broadcast around their own jet.

- **Toggle key:** `J` (TBD per KEYBINDS.md — confirm not taken).
  Press = on, press again = off. While on, jammer pod is
  broadcasting omnidirectional protection.
- **No charges, no cooldown.** Runs as long as toggled.
- **Effect:** Each active-radar missile inbound rolls a
  per-second break-lock probability proportional to jammer
  power vs missile seeker generation:
  - AMRAAM (AIM-120D class) — ~10% per second break-lock chance
  - Older Sparrow-class — ~30% per second
  - Modern AIM-260 / Meteor — ~5% per second (stiffer seeker)
  - IR missiles (AIM-9 / R-73 class) entirely unaffected
- **Visualization:** persistent faint shimmer pattern on the
  RWR/scope (we're emitting), plus a small `EW: DEFENSIVE` badge
  on the HUD alongside the radar mode badge.

### 2.3 Modes are platform-dependent

Whether DEFENSIVE and OFFENSIVE can run simultaneously depends on
the platform's jammer pod:

- **Fighter pod (ALQ-184 etc.)** — `beamCount: 1`. One mode at a
  time. Picking OFFENSIVE turns DEFENSIVE off automatically and
  vice-versa.
- **EA-18G Growler** — `beamCount: 3+`. Multiple ALQ-99 pods,
  defensive bubble + 2-3 simultaneously targeted offensive beams.
- **F-35 LO mode** — `beamCount: 1` but with LPI waveforms (lower
  HARM attraction). Modeled later in NFAC if needed.

The `beamCount` parameter on `JammerSubsystem` is the single
control: each engaged target consumes one beam slot, defensive
mode consumes one. Physics handles the rest.

---

## 3. Realistic cost model — what jamming actually does

### 3.1 What jamming reveals (bearing-only, not position)

When you engage a jammer:
- Hostile RWRs see a strong emission strobe **from your bearing**.
- They **cannot resolve range, altitude, or specific aircraft**.
  Two F-35s jamming on similar bearings look like one big strobe.
- They cannot get a track-quality target solution from the
  jamming alone — that's the whole point of jamming.

### 3.2 What it does NOT do

- **Does NOT increase your detect-range to enemy radars.** That
  was an early design mistake. Jamming defeats return-based
  tracking, not enables it.
- **Does NOT reveal your range** (only bearing).
- **Does NOT have ammo / cooldown / heat in any realistic
  modeling**. Power comes from the engine.

### 3.3 What it DOES cost

- **HARM-attraction.** Every hostile unit with
  `seekerType === 'anti_radiation'` (HARM, Vympel-class
  anti-radar AAMs) sees you on RWR and ranks you priority target.
  Their `pickTarget` logic gets an "active EW emitter" multiplier.
  This is the dominant threat while jamming.
- **Loss of stealth posture.** If you were silent (radar OFF),
  you've broken cover — you've gone from "not detectable at all"
  to "jamming detectable along bearing X."
- **Triangulation risk** — if hostiles have multiple radar/RWR
  receivers along different bearings cooperating via their own
  DL, they can resolve your rough position over time. Worth
  modeling later as a per-coalition "multi-bearing fix" capability.
  Out of scope for 6e.1.
- **Friendly DL collateral** (comms-jam variant only) — your
  own LINK-16 reception goes if the cone overlaps friendlies.
  Don't shotgun blast.

---

## 4. Architecture

### 4.1 `src/systems/ew/jammerSubsystem.js` (new)

Per-platform config attached to the unit at spawn time:

```js
{
  type: 'radar' | 'comms' | 'both',
  power: number,                    // effective radiated power
  beamCount: number,                // simultaneous victims (1 fighter, 3+ Growler)
  coneHalfDeg: number,              // ±cone half-angle
  burnThroughRangeM: number,        // attacker close enough overcomes jam
  // Runtime state, mutated by engagement:
  defensiveOn: boolean,
  offensiveTargets: Set<unit>,      // up to beamCount entries
}
```

Public API:

```js
accumulateJamAttenuation(observer, target)  // returns 0..1 multiplier
                                            // for detection range
isLinkDegradedFor(receiver, source)         // true if comms-jam in path
isHarmBaitingFor(observer)                  // bearing strobe for HARM
                                            // pickTarget bonus
```

### 4.2 `src/systems/sensorSystem.js` (extend)

In `detectRadar`, after computing nominal `rangeLimit`:

```js
const jamAtt = accumulateJamAttenuation(observer, target);
const effectiveRange = rangeLimit * jamAtt;
if (los.losLenMeters > effectiveRange) return null;
```

Burn-through is automatic — when the attacker closes enough that
the geometric range falls under the jammer's effective floor, the
attenuation factor approaches 1 (jam ineffective at close range).

### 4.3 `src/systems/teamDatalink.js` (extend in 6e.4)

`publishContacts` checks `isLinkDegradedFor(observer, sourceUnit)`
before fusing. Degraded-link contacts age out instead of refreshing,
which auto-engages 6d's realistic IFF for them.

### 4.4 New platforms

- **`src/data/platforms/ea-18g-growler.json`** (friendly): orbits
  high, `jammer: { type: 'both', power: ..., beamCount: 3 }`.
- **Hostile EW platform** (TBD — Su-24MR or similar). Same shape,
  hostile coalition. Used in scenarios to test receive-side viz.

### 4.5 Player jammer integration

- New weapon-system slot type `jammer` in `weaponSystem.weapons`.
  Selectable via Q like other weapons.
- Player platform JSON gets a `jammer` block analogous to
  platforms (probably gated to F-35 / F-15EX classes; F-22 has no
  pod historically).
- Defensive toggle = key handler in `setupGlobalKeybinds`, flips
  `state.jammer.defensiveOn`.
- Offensive engagement = `weaponSystem.fire()` path when jammer
  weapon selected: stamps `state.jammer.offensiveTargets` with
  the currently designated emitter.

### 4.6 `src/ui/hud.js` (extend)

- **Receive-side jam strobe** on the scope: hatched pattern at
  jammer bearing, distinct from RWR strobes.
- **Range-degradation readout**: `RNG: 80 → 32 km · JAM 045°` in
  the scope status row.
- **Jam-acquired toast**: `JAM ACQUIRED → 045°` on first detection.
- **Burn-through toast**: `BURNTHROUGH @ 12 km` when range <
  `burnThroughRangeM`.
- **EW state badge** next to the radar mode badge:
  `EW: DEFENSIVE` or `EW: OFFENSIVE 045°` (with target bearing).
- **Offensive cone visualization**: animated diagonal stipple
  cone from own-ship-center toward designated emitter.
- **Defensive shimmer**: persistent faint pattern overlay when
  defensive mode on.

---

## 5. Sub-phase breakdown

### 6e.1 — Core JammerSubsystem + receive-side viz (foundational)

**Effort:** ~1 day. Ships first.

**What lands:**
- `src/systems/ew/jammerSubsystem.js` with the data model and
  `accumulateJamAttenuation` helper.
- Sensor pipeline integration in `sensorSystem.detectRadar`.
- New EA-18G Growler platform JSON (friendly, jammer always on,
  not yet targeted at anyone).
- New hostile EW platform (Su-24MR-class) for scenarios.
- Receive-side scope visualization: jam strobes, range readout,
  toasts.
- Integration into sead-intro scenario so the player feels
  "I am being jammed" before they can reciprocate.

**No player engagement yet** — that's 6e.2.

### 6e.2 — Player offensive jamming (weapon-style)

**Effort:** ~1 day.

**What lands:**
- `jammer` weapon-system slot, selectable via Q.
- Tab cycles RWR + AESA contacts as designation.
- F/Enter held = sustained beam.
- Animated stipple cone visualization on scope.
- Effect propagates through JammerSubsystem to victim radars.
- HARM-attraction bonus on hostile pickTarget logic.

### 6e.3 — Player defensive jamming (toggle)

**Effort:** ~½ day.

**What lands:**
- `J` key toggle for defensive mode.
- Per-second break-lock probability rolls on inbound active-radar
  missiles.
- HUD `EW: DEFENSIVE` badge.
- Scope shimmer overlay.
- HARM-attraction same as offensive.

### 6e.4 — Comms jamming → DL degradation → IFF auto-engage

**Effort:** ~½ day.

**What lands:**
- Comms-type jammers degrade `teamDatalink.publishContacts` in cone.
- `gameSettings.iff.omniscient` check now ALSO honors per-contact
  DL freshness — stale-DL contacts auto-engage realistic IFF.
- Scope shows datalink contacts that are jam-stale as fading or
  hatched.
- Toast: `LINK-16 DEGRADED — DATALINK SPOTTY`.

This closes the loop back to the dormant 6d code and is what
makes IFF realism actually meaningful in mission.

---

## 6. UX specifications

### 6.1 Scope visualizations (cumulative across sub-phases)

**Receive-side (6e.1):**
- **Jam strobe**: 2-3 px wide hatched line from own-ship-center
  outward in jammer bearing, length proportional to relative
  power (longer = stronger). Hatching pattern animates inward
  ("jam coming in"). Color: deep red/orange.
- **Range degradation indicator**: text in scope status row,
  format `RNG: 80 → 32 km`. Green if no degradation, amber if
  degraded.

**Offensive engagement (6e.2):**
- **Outgoing cone**: narrow wedge from own-ship-center toward
  victim bearing, fan ±5° wide. Filled with diagonal stipple
  pattern moving outward at ~30 fps. Color-coded by class.
- **Designation cycle**: same Tab-cycling visual cue as HARM
  emitter selection — selected emitter pulses on RWR.

**Defensive (6e.3):**
- **Persistent shimmer**: subtle 1-2 px noise overlay across the
  whole scope while defensive mode on. Indicates "we're emitting
  ambient noise."
- **HUD badge**: `EW: DEFENSIVE` next to radar mode. Same color
  family as STT (red-orange) since both are "you're committed."

### 6.2 HUD elements

- **Radar mode badge** stays as 6c left it: `RDR: TWS / STT / RWS / SILENT`.
- **EW badge** new: `EW: STANDBY / DEFENSIVE / OFFENSIVE 045°`.
- **CMDS counter** unchanged for flares/chaff. Jamming doesn't
  consume charges so it doesn't appear here.
- **Jam-acquired toast** — yellow-orange, 2 s, format
  `JAM ACQUIRED → 045°`. Bearing rounds to nearest 5°.
- **Burn-through toast** — green, 2 s, format
  `BURNTHROUGH @ 12 km`. Fires once when range crosses threshold.

### 6.3 Audio (defer to follow-up)

Real fighter cockpits have a distinctive jam tone (warbling
white noise). Could add later as a per-channel hum that volumes
up with jam strength.

---

## 7. Open design questions (defer to playtest)

1. **Toggle vs hold for offensive engagement.** Hold-to-engage
   matches "weapon-style" intuition, but for sustained jamming
   you'd be holding the trigger for minutes. Toggle (press once
   on, press again off) might play better. Test both.
2. **Beam-count exclusion semantics.** When `beamCount === 1`
   and player tries to engage offensively while defensive is on,
   what happens? Auto-disable defensive with a toast? Refuse the
   offensive engagement? Force-pick? Probably: toast saying
   "DEFENSIVE → STANDBY" and switch to offensive.
3. **Anti-radiation seeker bonus weight.** How much priority
   bump does an active jammer get on a HARM's pickTarget? If too
   high, jamming becomes suicide. If too low, no real cost.
   Initial guess: 3× current target-score multiplier.
4. **Self-jamming friendly DL.** If the player accidentally
   sweeps comms-jam across their own wingmen, do we hide the
   collateral or clearly toast it? Probably toast — teaches the
   player not to do it.
5. **Should triangulation by ground RWR be a thing in 6e.1, or
   wait?** Real-world this is a ~1-2 minute process requiring
   coordination. Probably out of scope; document as 6e.5
   follow-up if scenarios need it.

---

## 8. Implementation order

```
1. 6e.1  JammerSubsystem + sensorSystem + receive-side viz
         + EA-18G + hostile EW platform + sead-intro update
2. 6e.2  Player offensive jamming (weapon-style)
3. 6e.3  Player defensive jamming (toggle)
4. 6e.4  Comms jam → DL degradation → IFF auto-engage
5. (defer)  Triangulation by ground EW receivers, NCTR refinements
```

Each sub-phase commit-able independently. 6e.2 and 6e.3 are
order-independent — pick whichever is more interesting to
playtest first.

---

## 9. Files affected

**New:**
- `src/systems/ew/jammerSubsystem.js`
- `src/data/platforms/ea-18g-growler.json`
- `src/data/platforms/su-24mr.json` (or similar hostile EW)
- (`/public/assets/models/ea-18g-growler.glb` and equivalent —
  may use placeholder existing models initially)

**Extended:**
- `src/systems/sensorSystem.js` — `detectRadar` consumes
  attenuation
- `src/systems/teamDatalink.js` — `publishContacts` honors
  comms-jam (6e.4 only)
- `src/systems/weaponSystem.js` — `jammer` weapon-system slot,
  fire path
- `src/plane/planeController.js` — `J` key for defensive toggle
- `src/ui/menus.js` — global keybind for defensive toggle
- `src/ui/hud.js` — scope viz, status row, toasts, EW badge,
  cone rendering, shimmer overlay
- `src/data/scenarios/sead-intro.json` — add hostile EW platform
- `src/data/planes/*.json` — `jammer` block on F-35/F-15EX
- `KEYBINDS.md` — `J` for defensive toggle, jammer weapon slot

**Roadmap entries** (see `COMBAT_ROADMAP.md`):
- 6e.1 / 6e.2 / 6e.3 / 6e.4 sub-phases already documented.

---

## 10. Acceptance for 6e.1 (the first ship)

When 6e.1 lands, the player experience is:
- Spawn into sead-intro scenario.
- Pre-mission briefing shows a hostile EW platform somewhere.
- During flight, when within range of the hostile EW orbit, the
  scope shows:
  - A red-orange hatched strobe at the jammer's bearing
  - Range readout `RNG: 80 → 32 km · JAM 045°`
  - Toast: `JAM ACQUIRED → 045°`
- When closing on the IADS, the radar's effective range to
  detect SAMs is reduced — bandits reach detection later, more
  geometry pressure on the player.
- When close enough to the jammer, toast: `BURNTHROUGH @ 12 km`,
  scope strobe collapses, full range restored.
- Player can't yet jam back — that's 6e.2.

This is the "it works from the receive side" milestone. Player
engagement is 6e.2.
