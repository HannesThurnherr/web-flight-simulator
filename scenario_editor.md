# Scenario Editor — Design Doc

Long-form planning doc for Phase 10. The goal: let the player author
scenarios without touching code, produce them as standalone JSONs that
the existing scenario runner can consume, and cover the realistic span
from "five fighters in a valley" to "32-unit SEAD package against a
layered IADS with random loadouts."

This doc is the source of truth for the **scenario JSON schema** and
the **editor UX**. The schema lands first (Phase 10a) so authoring can
proceed by hand-edit until the visual editor (10b–10c) catches up;
both kinds of authoring produce the same JSON, and old hand-authored
scenarios stay readable.

Roadmap reference: `COMBAT_ROADMAP.md` Phase 10a–10h. This doc
expands those entries into concrete schema + editor specs.

---

## 0. Philosophy

1. **JSON first, editor second.** The schema is what scenarios are.
   The editor is one way to produce JSON; hand-edit + import-from-
   external-tool are equally valid. Same JSON either way.
2. **Anchored vs relative.** Two coordinate modes: world-absolute
   (lon/lat) or player-relative (bearing+range from the player's
   spawn). Mixable per spawn — a strike package can be world-anchored
   in a specific valley while the player's CAP is anchored relative to
   the convoy.
3. **Randomization is per-field.** Anything that can be a literal can
   also be a random spec. Scenarios get re-rolled at start so each
   playthrough varies, but seed is recordable so a scary fight can be
   replayed.
4. **Backwards-compatible with existing scenarios.** Today's
   sead-intro / awacs-bvr / bvr3way / jamming-test JSONs already use
   `spawns: [{ type, platformId, team, origin, ... }]`. The new
   schema is a strict superset — every existing scenario parses
   unchanged, just gains optional fields.
5. **Mission semantics layered on top.** Phase 1 is *placement*
   (where, what, how loaded). Phase 2 is *behavior* (waypoint patrols,
   strike missions, escort orders). Place units first; teach them
   missions later.

---

## 1. Top-level scenario JSON

```jsonc
{
  "schemaVersion": 2,                         // bump when shape changes
  "id": "north-valley-sead",                  // url-safe, unique in the registry
  "name": "North Valley SEAD",                // shown in scenario picker
  "description": "...",                       // one paragraph of briefing prose

  // ----- Anchoring + player setup -------------------------------------
  "anchor": {
    "mode": "world",                           // "world" | "player-relative"
    "worldLon": 8.123,                         // required when mode="world"
    "worldLat": 47.456,
    "playerSpawn": {
      "mode": "fixed",                         // "fixed" | "user-pick" | "random"
      "lon": 8.142, "lat": 47.412, "alt": 6000,
      "heading": 270, "speed": 250,
      // For "user-pick": the existing spawn-picker UI lets the player
      // place themselves before the world spawns. Useful for "set up
      // your own ingress."
      // For "random": pick one of `playerSpawnOptions[]` at start.
      "playerSpawnOptions": [                  // optional, used by mode="random"
        { "lon": 8.10, "lat": 47.40, "alt": 6000, "heading": 90 },
        { "lon": 8.18, "lat": 47.43, "alt": 8000, "heading": 270 }
      ]
    }
  },

  // ----- Theater-wide systems ----------------------------------------
  "satellite": {                               // existing field, unchanged
    "intervalS": 180, "memoryS": 600, "firstAtS": 5,
    "team": "friendly", "classes": ["ground"]
  },
  "weather": {                                 // optional, future Phase 9
    "preset": "clear" | "broken-stratus-3000" | "imc-low",
    "windEN": [12, -3]
  },
  "timeOfDay": "noon",                         // "dawn" | "noon" | "dusk" | "night"

  // ----- Spawns ------------------------------------------------------
  "spawns": [ /* see §2 */ ],

  // ----- Mission objectives (Phase 2) -------------------------------
  "objectives": [ /* see §6 */ ],
  "triggers":   [ /* see §6 */ ],

  // ----- Auth/seed ---------------------------------------------------
  "randomSeed": 42,                            // optional; deterministic re-roll
  "author": "hannes",
  "createdAt": "2026-05-01T12:00:00Z",
  "modifiedAt": "2026-05-02T08:30:00Z",
  "tags": ["sead", "low-altitude", "ew-light"]
}
```

`anchor` replaces today's implicit "everything is player-relative."
Existing scenarios omit `anchor` and the loader treats them as
`{ mode: "player-relative" }` — back-compat for free.

---

## 2. Spawn entry — the workhorse

Every entry in `spawns[]` describes one OR a randomized batch of
units. The shape is uniform; the random extensions live alongside the
literal fields, so a single schema covers both.

```jsonc
{
  // ----- Identity ----------------------------------------------------
  "type": "fighter" | "platform",              // matches existing dispatch
  "platformId": "ea-18g-growler",              // for platforms
  "fighterModel": "su-35",                     // for fighters (plane.id)
  "team": "hostile-red",                       // standard team tag
  "name": "Bandit-1",                          // optional override; otherwise auto

  // ----- How many --------------------------------------------------
  "count": 1,                                  // literal
  // OR  "count": { "min": 2, "max": 5 },     // random

  // ----- Where -----------------------------------------------------
  "origin": { /* see §3 */ },

  // ----- Pose ------------------------------------------------------
  "headingDeg": 90,                            // literal
  // OR  "headingDeg": { "any": true },        // 0..360 random
  // OR  "headingDeg": { "from": 60, "to": 120 },
  "speedMps": 250,                             // air units; literal OR random spec
  "altitudeM": 8000,                           // optional override on origin.alt
  // OR  "altitudeM": { "from": 6000, "to": 12000 },

  // ----- Loadout (air units) ---------------------------------------
  "loadout": { /* see §4 */ },

  // ----- Magazine / ammo (ground units) ----------------------------
  "magazine": { /* see §5 */ },

  // ----- Pilot config ----------------------------------------------
  "pilot": {
    "type": "fighter" | "orbit" | "static-sam" | "patrol" | "strike" | "escort",
    "skill": "rookie" | "regular" | "veteran" | "ace",     // affects gainAggression / engagement range
    "params": { /* per-pilot-type, see §7 */ }
  },

  // ----- Intel knowledge --------------------------------------------
  "intel": { "level": "known" | "suspected" | "hidden", "uncertaintyM": 4000 },

  // ----- Mission tag (for objectives / triggers) -------------------
  "tag": "ewr-1"                               // optional; lets objectives reference it
}
```

### Random batches

Setting `count` to a random spec produces N independent units, each
re-rolling its other random fields. For a tight formation use
`count: 1` and repeat the spawn entry; for a loose "5 fighters
somewhere over here" use `count: { min: 3, max: 6 }` with random
origin.

---

## 3. Origin — the coordinate system

```jsonc
"origin": {
  // ANY of these forms:

  // World-absolute literal
  "lon": 8.142, "lat": 47.412, "alt": 5000,

  // Player-relative literal
  "relTo": "player",
  "bearingDeg": 90, "rangeM": 25000, "altOffsetM": -1000,
  "altM": 8000,                                // alternative to altOffsetM

  // Anchor-relative literal (uses scenario.anchor.world{Lon,Lat})
  "relTo": "anchor",
  "offsetEastM": 3000, "offsetNorthM": -1500, "altM": 1500,

  // Random within a circle
  "random": {
    "centerRelTo": "anchor" | "player",
    "centerLon": 8.14, "centerLat": 47.41,     // or bearingDeg+rangeM
    "radiusM": 5000,
    "minRadiusM": 1000,                        // donut, optional
    "altMode": "fixed" | "fromAGL" | "fromBand",
    "altM": 8000,
    "altMin": 6000, "altMax": 12000
  },

  // Random along a route polyline (good for patrol seed positions)
  "randomOnRoute": {
    "route": [                                  // ECEF polyline
      { "lon": 8.10, "lat": 47.40 },
      { "lon": 8.20, "lat": 47.45 }
    ],
    "altMin": 6000, "altMax": 10000
  }
}
```

Today's scenarios already use the `relTo: "player"` form; that path
is unchanged. `world` (absolute) and `anchor` (anchor-relative) are
new. Random forms each carry their own bbox-style bounds.

The loader's responsibility is to resolve any origin spec into a
concrete `{ lon, lat, alt }` at scenario start. Random rolls happen
once (per the scenario seed); from that point on positions are
deterministic for the run.

---

## 4. Loadout schema (air units)

Either a **literal hardpoint map** (same shape the loadout editor
saves to localStorage today) or a **template / random** spec.

```jsonc
"loadout": {
  // Literal — every hardpoint listed is filled with that munition id
  "hardpoints": {
    "fuselage-L": "aim120",
    "fuselage-R": "aim120",
    "wing-1-L":   "aim9x",
    "wing-1-R":   "aim9x",
    "wing-3-L":   "tank",                       // drop tanks
    "wing-3-R":   "tank"
  }
}
```

```jsonc
"loadout": {
  // Template — pull a named loadout from a registry
  "template": "su-35-bvr-heavy"                 // see §4.1
}
```

```jsonc
"loadout": {
  // Random — pick one from a list
  "oneOf": [
    { "template": "su-35-bvr-heavy" },
    { "template": "su-35-multirole" },
    { "template": "su-35-strike" }
  ]
}
```

```jsonc
"loadout": {
  // Bag-of-munitions — fill compatible slots with random picks from
  // a permitted set, respecting hardpoint accept lists. Useful for
  // "5 random fighters with random AAM mix" without enumerating
  // every combination.
  "fillFromBag": {
    "AAM":   ["aim120", "aim9x", "aim120-c5"],
    "AAM-LR":["meteor"],                        // some hardpoints accept tags
    "AGM":   ["agm88", "storm-shadow"]
  },
  "weights": { "aim120": 4, "aim9x": 2 },       // optional, default uniform
  "minLoadFraction": 0.6                        // require at least 60% of HPs filled
}
```

### 4.1 Loadout templates

Authoring "su-35-bvr-heavy" by hand is annoying; templates are a
named reusable spec stored in `src/data/loadouts/<id>.json`:

```jsonc
{
  "id": "su-35-bvr-heavy",
  "fighterModel": "su-35",                      // template is per-airframe
  "name": "Su-35 — BVR Heavy",
  "description": "4× R-77, 2× R-37M, 2× R-73 wingtip",
  "hardpoints": { /* literal map, same as inline */ }
}
```

Templates show up in the editor's loadout dropdown and can be
selected when authoring a spawn. They're also user-editable through
the existing loadout editor UI — picking "save as template" stores
to the registry.

---

## 5. Magazine / ammo schema (ground units)

SAMs and AAA carry finite missiles / rounds. Today every NASAMS site
spawns with a single magic missile inventory baked into the platform
JSON; the editor needs to override per-spawn.

```jsonc
"magazine": {
  "missile":  4,                                // SAM rounds total
  "rounds": 1200,                                // AAA / autocannon shells
  "reloadS": 600,                                // optional, seconds between reload (or omit = no reload)
  // Or random:
  "missileRange": [2, 6]                         // [min, max] inclusive
}
```

Phase 4 already added `magazine.missile` to NASAMS / SA-15 platforms;
the editor entry simply surfaces these fields and lets per-spawn
overrides win over the platform default.

---

## 6. Objectives + triggers (Phase 2 — mission semantics)

Objectives are **player-facing goals** with success / failure
conditions. Triggers are **scenario-side reactions** (spawn waves,
flip an enemy's posture, end mission). Both reference units by
`tag`.

```jsonc
"objectives": [
  {
    "id": "kill-ewr",
    "tag": "ewr-1",
    "kind": "destroy",
    "label": "Destroy the Krasukha-4 EW node",
    "required": true
  },
  {
    "id": "rtb",
    "kind": "reach-zone",
    "zone": { "lon": 8.10, "lat": 47.40, "radiusM": 3000 },
    "afterObjective": "kill-ewr",
    "label": "RTB to homeplate",
    "required": true
  },
  {
    "id": "save-awacs",
    "tag": "awacs-1",
    "kind": "protect",
    "label": "AWACS must survive",
    "required": true
  }
]
```

Trigger kinds:

```jsonc
"triggers": [
  {
    "when": "player-enters-zone",
    "zone": { "lon": 8.10, "lat": 47.40, "radiusM": 15000 },
    "do": "spawn",
    "spawn": { /* same shape as a spawn entry */ }
  },
  {
    "when": "objective-completed",
    "objective": "kill-ewr",
    "do": "set-radar-active",
    "tag": "sa-15-1",
    "active": true
  },
  {
    "when": "elapsed",
    "atS": 600,
    "do": "spawn",
    "spawn": { /* reinforcement wave */ }
  }
]
```

This is the minimum surface the existing dialogue + scenario hooks
already partially support; expand as missions need.

---

## 7. Pilot types — what the unit *does*

```jsonc
"pilot": { "type": "fighter", "skill": "veteran" }
// → existing FighterPilot. Engages anything hostile that comes into sensor range.
```

```jsonc
"pilot": {
  "type": "patrol",
  "params": {
    "waypoints": [
      { "lon": 8.10, "lat": 47.40, "altM": 8000, "speedMps": 220 },
      { "lon": 8.20, "lat": 47.45, "altM": 8000 }
    ],
    "loop": true,
    "engageOnSight": true                       // become FighterPilot when anyone enters sensor cone
  }
}
```

```jsonc
"pilot": {
  "type": "strike",
  "params": {
    "ingressWaypoints": [ /* low-level ingress route */ ],
    "target": { "tag": "ewr-1" },              // or { "lon": ..., "lat": ... }
    "weaponType": "STORM-SHADOW",
    "egressWaypoints": [ /* RTB route */ ],
    "abortOnRwrSpike": false                    // press the attack vs. break off
  }
}
```

```jsonc
"pilot": {
  "type": "escort",
  "params": {
    "escortTag": "awacs-1",                     // stay near this unit, intercept threats
    "engageRangeM": 30000
  }
}
```

```jsonc
"pilot": {
  "type": "orbit",                              // existing AWACS / tanker pilot
  "params": { "altitudeM": 11000, "radiusM": 40000, "targetSpeed": 220 }
}
```

```jsonc
"pilot": {
  "type": "static-sam",                         // existing
  "params": { /* SAM-specific cuing rules */ }
}
```

Phase 1 of the editor lands `fighter` / `orbit` / `static-sam` (all
exist today) plus `patrol` (new — implement on top of existing
`FighterPilot` with a waypoint-following behavior inserted between
Cruise and Engage). Phase 2 adds `strike` and `escort`.

### Skill levels

`skill` is a single dial that maps to a bundle of behavior knobs:

| Skill    | Engagement range | Notch discipline | Flare cadence | AB usage | Lead-pursuit accuracy |
|----------|------------------|------------------|---------------|----------|-----------------------|
| rookie   | 0.6×             | poor             | spam          | constant | reduced               |
| regular  | 1.0×             | normal           | normal        | normal   | normal                |
| veteran  | 1.2×             | tight            | conservative  | tactical | improved              |
| ace      | 1.4×             | optimal          | precise       | tactical | optimal               |

These ride on existing FighterPilot subsystems — no new behavior
classes needed, just parametrization.

---

## 8. Random spec — uniform shape

Anywhere a number / enum appears, the random forms are:

```jsonc
{ "from": 100, "to": 500 }              // uniform real
{ "min": 2, "max": 5 }                  // uniform integer
{ "any": true }                          // 0..360 for headings
{ "oneOf": ["a", "b", "c"] }             // enum
{ "weighted": [["a", 3], ["b", 1]] }     // weighted enum
```

Strings/arrays use `oneOf`. Numbers use `from/to` (continuous) or
`min/max` (integer). The loader normalizes both into a single
`rng.sample(spec)` call.

Random rolls use the scenario's `randomSeed` so the same scenario
+ seed = identical spawns. A new seed each game gives variety; a
fixed seed gives reproducibility for sharing scary fights.

---

## 9. Editor UI (Phase 10b–10c)

### Entry point — the scenario picker

The editor is reached from the **existing scenario picker** (the
modal that opens at boot / after a respawn-elsewhere). Two ways in:

- **"+ NEW SCENARIO" card** at the top of the picker grid → opens
  the editor with an empty scenario (anchor defaulting to whatever
  lon/lat the picker camera is currently centred on, or the user's
  last edited location).
- **"EDIT" button on any existing user-authored scenario card**
  (one stored in localStorage, not the bundled ones) → opens the
  editor populated with that scenario's contents.

Bundled scenarios from `src/data/scenarios/*.json` are read-only in
the editor — the picker shows them with a small "BUNDLED" badge and
no EDIT button. The user can still **DUPLICATE** a bundled scenario
to a new editable user copy, which is the recommended flow for "I
liked sead-intro but want to add a fighter CAP."

The picker stays at its current spawn-flow position in the boot
sequence — the editor is just an alternate path out of it. Saving
a scenario in the editor returns to the picker (the new / edited
scenario is now selectable like any other). "Test fly" shortcuts
this and goes straight to flight with the in-progress scenario,
returning to the editor on respawn (Phase 10f).

### Editor architecture — a mode of CommanderView

**The editor is a mode of the existing CommanderView.** That 3D map
already gives us pan / tilt / zoom, marker rendering with team
colors, click-to-inspect tooltips, trail sampling, and the legend +
controls panel. Building a separate editor would mean re-creating
all of that. Instead the editor enters CommanderView with an extra
"EDITOR MODE" UI layer, the same way debug overlays already plug in
(R / D / J keybinds for radar / datalink / jammer overlays).

### 10b — Map placement (CommanderView editor mode)

A new `M` modifier on CommanderView (or a "MODE: EDITOR" button on
its existing controls panel) flips the view into editor mode. While
in editor mode:

- **Left-click on terrain** drops a unit at the picked lon/lat at the
  default altitude for the currently-armed unit kind. The unit kind
  is selected from a palette in the top-left (groups: fighters,
  ground SAMs, AAA, EWR, jammers, AWACS, ships, command posts).
  The palette uses the same icons / unit-kind colors as the live
  commander markers, so what you place in the editor reads exactly
  the same way once you fly the scenario.
- **Selected unit** shows in-world manipulators reusing the
  marker-rendering machinery:
  - A heading rose drawn as a thin polyline ring 60 m around the
    unit (Cesium polyline entity, same primitive as the FOV cone
    in radar debug). Drag the tick to set heading.
  - An altitude slider in the right-side selection panel (ground
    units locked to terrain + groundOffsetM).
  - A speed slider for air units.
  - Drag the unit's marker itself to reposition. Snap-to-route /
    snap-to-grid optional.
- **Tooltip morphs into edit form.** Today's commander tooltip is
  read-only (name / ALT / SPD / HDG / ...). In editor mode the same
  tooltip swaps to editable inputs for the same fields, plus the
  full editor sidebar's worth of controls (team / pilot type /
  skill / tag / intel / loadout / magazine). The user already
  knows how to click VIEW or other buttons on commander tooltips;
  the edit form is one more sibling.
- **Multi-select (lasso)** is already half-implemented — the strike
  planner's lasso lives in `src/systems/strikePlanner.js` and
  produces a Set of selected NPCs. Reuse that selection primitive
  in CommanderView editor mode for bulk-edit (team / pilot / loadout
  template applied to all selected).
- **Random-spec spawns are first-class markers.** When a `count: {
  min: 3, max: 6 }` entry exists, CommanderView shows a single "spec
  marker" at the spec's center / origin, with a dashed circle for
  the random radius and a pill label "3–6× Su-35 (random loadout)".
  Editing the spec marker edits the spec; clicking "preview" rolls a
  sample so the user can see one realization before committing. The
  editor never bakes random specs into literal entries — they stay
  as random in the saved JSON, and the runtime re-rolls each play.
- **Anchor mode toggle**. A button in the controls panel switches
  between "world-anchored" and "player-relative." World-anchored
  shows a world-anchor marker at scenario.anchor.{worldLon, worldLat}
  draggable on the map. Player-relative mode shows the player-spawn
  marker draggable; everything else is internally stored as
  `{ relTo: "player", bearingDeg, rangeM }` and re-rendered relative
  to the spawn marker.

### 10c — Per-unit panels

Each unit kind (fighter, AWACS, SAM, EWR, jammer, MALD-launcher
strike package, command-post, ship) gets a tailored sub-panel inside
CommanderView's existing right-side selection sidebar. Same widget
discipline as the controls panel — collapsible sections, only the
relevant fields for the unit's kind, sane defaults pulled from the
platform JSON.

- Fighter: `fighterModel`, loadout (template / literal / random),
  pilot type + skill, patrol waypoints (route editor as another
  CommanderView interaction — left-click adds waypoints, right-
  click closes the polyline).
- SAM: `magazine.missile` + `magazine.reloadS`, cuing tag, posture
  (always-on / ambush / cued).
- AWACS / orbit: orbit center (a marker draggable on the map),
  orbit radius (a circle ring you scale by dragging the rim),
  cruise altitude / speed.
- EWR: just position + RCS-as-emitter — minimal panel.
- Jammer: jammer block knobs (power / coneHalfDeg / burnThroughRangeM
  / attFloor) with sane defaults, defensive on/off.
- Strike package: ingress route polyline + target tag + weapon
  type + egress route. The route editor is the same as the patrol
  waypoint tool, just with a tagged target endpoint.
- Command post / building: position + intel level only.
- Ship: position + heading + speed + transit waypoints.

Reusing CommanderView's marker rendering means the editor and the
in-game commander view show units with the **exact same icons**.
Authors place a marker, fly the scenario, and the same shape /
color shows up on their HUD scope and god-eye map.

---

## 10. Save / load / export (Phase 10e)

- **localStorage** — autosave every change so the editor doesn't
  lose work on a refresh. Slot keyed on scenario id.
- **JSON download / upload** — one-click export to a .json file the
  user can share. Drag-drop a .json onto the editor to import.
- **In-place test** (Phase 10f) — "play" button switches from
  editor to flight, loads the in-progress scenario without going
  through the picker. ESC returns to the editor with positions
  preserved.
- **Add to scenario picker** — "publish" button stores the scenario
  in `localStorage["scenarios"]` and the picker merges these with
  the bundled `src/data/scenarios/*.json`. Phase NFAC.8-style
  scenario hooks would later let the campaign mode pull from this
  pool.

---

## 11. Sequencing

```
10a  Schema v2 + loader (back-compat with existing scenarios)
     New origin modes (world, anchor) + random specs.
     Loadout templates.
     Magazine field on ground units.
     ----- ALL HAND-AUTHORED SCENARIOS WORK FROM HERE -----

10b  Picker entry points + CommanderView editor mode boot.
     "+ NEW SCENARIO" + "EDIT" + "DUPLICATE" buttons in the
     picker; clicking enters CommanderView in editor mode.
     Map placement (click to drop, drag to move).
     Selection panel, save to localStorage.

10c  Per-unit config panels (ground units' magazine UI, AWACS orbit
     UI, strike-package ingress route UI, etc.).

10d  Trigger + objective system (placement panel + runtime evaluator).

10e  Save / load / export. Drag-drop import. localStorage publish.

10f  In-place test mode (play from editor without leaving).

10g  Briefing screen — render scenario.description in the existing
     dialogue panel + show map preview before flight starts.

10h  Campaign mode (stretch) — chained scenarios, persistent
     pilot, mission selection screen.
```

Phase 1 lock = 10a + 10b + 10e. With those alone the player can
hand-author or click-place scenarios and share JSONs. 10c is polish.
10d is where mission semantics come alive.

Phase 2 (post-shipping 10a-c) adds the **patrol / strike / escort
pilot types** described in §7. Without them, NPCs only do
"engage-on-sight" — fine for BVR fights, less interesting for
deep-strike scenarios.

---

## 12. Files

**New:**
- `src/data/loadouts/*.json`                         — loadout template registry
- `src/systems/scenarios/scenarioSchema.js`          — schema + validator
- `src/systems/scenarios/scenarioRandom.js`          — RNG-driven spec resolution
- `src/systems/commanderViewEditor.js`               — editor-mode plug-in for
                                                       CommanderView (palette,
                                                       interaction handlers,
                                                       tooltip → edit-form swap,
                                                       random-spec marker rendering)

**Extended:**
- `src/systems/commanderView.js`                     — adds editor-mode toggle,
                                                       editable tooltip variant,
                                                       interaction routing for
                                                       click-to-place / drag-to-
                                                       move / lasso-select
- `src/systems/scenarios/scenarioRunner.js`          — consume schema v2
- `src/ui/scenarioPicker.js`                         — merge bundled + localStorage scenarios
- `src/systems/ai/index.js`                          — `patrol` / `strike` / `escort` pilot types
- `src/systems/ai/behaviors.js`                      — `WaypointFollowBehavior`,
                                                       `StrikeIngressBehavior`,
                                                       `EscortStationBehavior`
- `src/data/platforms/*.json`                        — magazine field defaults

**No new top-level UI surface.** The editor lives entirely inside
the existing CommanderView, so the player flips into editor mode
the same way they flip on the radar-debug overlay (a hotkey or
controls-panel button). Saves on UX onboarding — anyone who can
operate the commander map can edit a scenario with no extra
learning.

**Roadmap:**
- `COMBAT_ROADMAP.md` — sub-phase status updates as work lands.

---

## 13. Open questions (defer to playtest)

1. **How public is the loadout-template registry?** Phase 1 lives in
   src/data/loadouts/ (versioned with the repo). User-defined
   templates from the loadout editor go to localStorage. Future
   multiplayer needs a sync mechanism.
2. **Multi-player scenarios.** Phase 11 (multiplayer) will want
   per-team spawn slots and multi-player-spawn support. Schema-wise
   this is a small extension — `playerSpawn` becomes
   `playerSpawns: [{ team, mode, ... }]` and host election picks
   one slot per connected player. Defer the full design until 11
   is on the table.
3. **Procedural terrain awareness.** "Place this convoy in a valley"
   is hard without sampling terrain. For 10b, MVP is "the user
   picks the lon/lat manually"; auto-place-in-valley needs slope /
   ridge analysis we don't have. Slot in once Phase 9 (clouds /
   weather / terrain query) gives us the primitives.
4. **Campaign persistence.** Carrying ammo / damage between
   missions is mission-creep for Phase 10. Reasonable defer to
   campaign mode (10h) or a separate phase.
