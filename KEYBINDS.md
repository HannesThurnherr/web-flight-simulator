# Keybinds — single source of truth

Everywhere a key is bound goes here first. **Before adding a new bind,
search this file** to make sure you're not stomping an existing one.

Cockpit-mode bindings live in `src/plane/planeController.js` (held-down
flight inputs) and `src/ui/menus.js → setupGlobalKeybinds` (one-shot
toggles). Mode-overlay bindings live with their owning module
(`commanderView.js`, `strikePlanner.js`).

Lowercase ASCII unless otherwise noted. Keys with explicit
modifiers list them inline (e.g. `Shift+Tab`).

---

## Cockpit (FLYING state)

| Key | Action | File |
|---|---|---|
| `W` / `S` | Throttle up / down | planeController.js |
| `Space` | Afterburner / boost | planeController.js |
| `A` / `D` | Yaw left / right (rudder) | planeController.js |
| `←` / `→` | Roll left / right | planeController.js |
| `↑` / `↓` | Pitch down / up | planeController.js |
| `Q` | Cycle weapon | planeController.js |
| `1` … `6` | Direct weapon select (gun, AIM-9M, AIM-9X, AIM-120, METEOR, HARM) | planeController.js |
| `F` / `Enter` | Fire selected weapon | planeController.js |
| `V` | Release flares | planeController.js |
| `T` | Cycle radar mode (RWS → TWS → STT) | menus.js |
| `Tab` | Cycle designated AESA target forward | planeController.js |
| `Shift+Tab` | Cycle designated AESA target backward | planeController.js |
| `R` | Toggle own radar emitter (emcon / silent running) | menus.js |
| `'` (apostrophe) | Toggle radar scope map background (Cesium terrain on/off) | menus.js |
| `;` (semicolon) | Toggle radar scope size (compact ↔ expanded) | menus.js |
| `Z` | Skip dialogue | menus.js |
| `B` | Open / close strike planner | strikePlanner.js |
| `M` | Open / close commander god-eye view | commanderView.js |
| `Esc` / `P` | Pause menu (also closes open modals) | menus.js |

## Strike planner (B-active)

| Key | Action |
|---|---|
| `A` | Auto-assign hostile targets to queue |
| `C` | Clear designation queue |
| `L` | Toggle queue cycle mode |
| `R` | Toggle flight RTB / CAP break behavior |
| `Esc` | Close planner |

Mouse:
- Left-click on empty terrain — add target at terrain
- Left-drag on target dot — move target's lat/lon
- Left-drag a target dot onto another target dot — reorder queue
- Right-click on target dot — delete target
- Left-click on enemy unit marker — designate that unit
- Shift+left-drag on empty space — area-select rectangle (queues every
  visible hostile inside as designations)
- Wheel — zoom

## Commander view (M-active)

| Key | Action |
|---|---|
| `T` | Toggle telemetry overlay |
| `R` | Toggle radar-cone debug overlay |
| `D` | Toggle datalink-edges overlay |
| `Space` | Pause / resume world |
| `Esc` | Close commander view |

## Spawn-pick state

| Key | Action |
|---|---|
| `Esc` | Cancel spawn (back to main menu) |

## Pause menu (PAUSED state)

| Key | Action |
|---|---|
| `Esc` / `P` | Resume |

---

## Reserved (do not bind)

These are conventionally avoided so the UX stays predictable:
- Browser-native: `Ctrl+R`, `Ctrl+W`, `Ctrl+Q`, `F5`, `F11`, `Ctrl+F`, etc.
- Mouse buttons in cockpit: left = mouse-aim helper, right = mouse-look,
  wheel = camera FOV.

## Free keys (cockpit, currently unbound)

`G`, `H`, `I`, `J`, `K`, `N`, `O`, `U`, `X`, `Y`,
`,`, `.`, `/`, `\`, `[`, `]`, `=`, `-`, `0`, `7`, `8`, `9`,
function keys `F1`–`F12`, `Insert`, `Delete`, `Home`, `End`,
`PgUp`, `PgDn`.

## Swiss keyboard notes

- The `` ` `` (backtick) key requires AltGr on Swiss layouts and is
  awkward to use in flight. Prefer `'` (apostrophe) or another
  ASCII letter for new binds.
- `Shift+\` produces `?` on Swiss; avoid `\` as a standalone bind.
- `[` and `]` are unshifted on Swiss but next to `Enter` — fine for
  occasional toggles, not for repeated input.
