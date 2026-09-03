# Commands

*Every user-invocable command is one row in `command-registry.ts`, and every emitter reaches it through the two funnels: `dispatchCommand(id)` for invocation, `keymapRegistry` for chords. A command that a call site dispatches by hand, or a chord that a component matches on its own, is invisible to the menu bar, to the keymap pane, and to the conflict analysis that tells the user why their key does nothing — which is the whole reason the table exists.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` → [tuglaws.md](tuglaws.md). Naming: [action-naming.md](action-naming.md). Menu projection: [menus.md](menus.md). Chain mechanics: [responder-chain.md](responder-chain.md).*

---

## Why

Before the table, a command entered Tug through five unrelated doors: a Swift menu item's control frame resolved through a hand-written `registerAction` closure, a chord matched against a static keybinding map, a button called `sendToTarget` directly, a slash bridge called a store method, and the menu's enablement was a hand-rolled Swift `switch`. Nothing joined them. The costs were not hypothetical — a context menu advertised ⇧⌘C for Copy as Plain Text while the real chord was ⌥⇧⌘C, a viewer carried a prose comment explaining by hand which chords the host's View menu ate before the web view ever saw them, and roughly thirty one-line closures existed only to re-dispatch a control frame into the chain under the same name.

One table fixes the class rather than the instances. A command's title, how it dispatches, which menu item it drives, whether it is applicable right now, whether it shows a check mark, and which chords are bound to it are all facts about the same thing, so they are written once in one place and every surface reads them from there: the native menu's enablement mirror, the key pipeline, the Settings ▸ Keyboard pane, context-menu shortcut hints, the help sheet.

This document is the authoring contract for that table. [L30] is the law; this is how to satisfy it.

---

## The two funnels

```
menu item ─┐
chord ─────┤
button ────┼──▶ dispatchCommand(id, payload?) ──▶ routing ──▶ chain walk | registry handler
slash ─────┘         (command-dispatch.ts)
                                                       ▲
COMMANDS ──────────────────────────────────────────────┘
(command-registry.ts)
     │
     └──▶ keymapRegistry ──▶ matchChord / resolveChord / menuChords / commandShortcut
              (keymap-registry.ts, overlaid with tugbank overrides)
```

**Funnel #1 — `dispatchCommand(id, payload?)`** in `tugdeck/src/command-dispatch.ts`. It looks the id up in `COMMANDS_BY_ID`, reads `routing` off the entry, and picks the mechanism from it: `first-responder` → `sendToFirstResponderForContinuation` (continuation invoked immediately, because a native menu round-trip arrives after AppKit already played its blink), `key-card` → `sendToKeyCard`, `target` → `sendToTarget`, `registry` → the handler `registerAction` registered, `native` → a dev warning, because AppKit performs it and JS never does. Every dispatch notifies `observeCommands`. An unknown id warns and returns unhandled.

**Funnel #2 — `keymapRegistry`** in `tugdeck/src/components/tugways/keymap-registry.ts`. It holds the table's default bindings overlaid with the user's tugbank overrides, is subscribable ([L02]), and answers four questions: `matchChord(event)` is the global layer the key pipeline runs on every keydown; `resolveChord(chord)` returns the full four-layer claim stack with a winner and a shadower per loser; `menuChords()` is what the menuState push carries; `commandShortcut(id)` is the display string every UI surface renders instead of authoring one.

`dispatchAction` — the control-frame entry point — forks: a frame whose action names a registry entry goes to `dispatchCommand`, everything else falls through to the tugcast data-frame handler map. That fork is the only place the two worlds meet.

---

## The entry is the command

One `CommandEntry` per user-invocable command, in `COMMANDS`. The fields that decide behavior:

| Field | What it settles |
|---|---|
| `id` | The canonical wire name — a `TUG_ACTIONS` value, a control-frame wire, or a parameterized `<action>:<value>` id |
| `title` | The display name. Menus, keymap pane, palette all read it; nothing authors a second one |
| `routing` | Which of the five mechanisms carries it. A data field, never a call-site choice |
| `action` / `payload` | The chain action to dispatch and the static `ActionEvent.value` it carries. `action` defaults to `id` when the id is itself a `TUG_ACTIONS` value |
| `menuItemId` | The `NSUserInterfaceItemIdentifier` this command drives — the join key between the table and the native menu |
| `mirrored` | Publish this item's gate (enablement, check state, dynamic title) in the menuState `commands` block. Per item on purpose: an item is mirrored in the same change that deletes the host's hand-rolled tier for it |
| `bindings` | Default chords. A list from day one, each with a `scope` and optional `menuEligible` / `preventDefault` |
| `validate` / `state` / `dynamicTitle` | Applicability, check mark, and dynamic title. Chain-routed entries default to the chain walk; `registry`-routed entries supply their own |
| `disabledChord` / `chordActive` | What becomes of the key equivalent when the command is not applicable |
| `parameterized` / `internal` / `paneMenu` | The three sanctioned answers to the door-coverage lint: a runtime-discovered family, no door at all, or a door the lint cannot see |

**Routing and scope are orthogonal.** `routing` says *how a command dispatches* and lives on the entry. `scope` says *where a binding is live* — `global`, `{ responder: id }`, or `{ mode: id }` — and lives on the binding. Conflating them is what made "innermost scope wins" meaningless in the old keybinding map.

**One entry per value, except for dynamic families.** A payload drawn from a fixed known set gets one row per value — `move-to-slot:1` … `move-to-slot:9` are nine user-facing commands and the keymap pane must show nine rows. A payload set discovered at runtime (`set-theme`, `focus-pane`, `open-recent-document`) stays one row marked `parameterized: true`, which excludes it from the mirror, from the rebindable rows, and from the door-coverage lint. The line is where the code already draws it: statically-built menu items versus `menuNeedsUpdate` rebuilds.

---

## Adding a command

1. **Name it and pick its tier.** The name follows [action-naming.md](action-naming.md) — `<verb>-<object>[-<modifier>]`, kebab-case, a `TUG_ACTIONS` constant if it is a chain action. No synonyms, no raw string literals at call sites. If it is getting a chord, derive the chord from [chord-tiers.md](chord-tiers.md) in the same breath: universal verb or Tug machinery, and which operator (if any) it composes with — a chord picked before its tier is a chord picked by availability.
2. **Add the row to `COMMANDS`** with `id`, `title`, and `routing`. The classification a name used to carry by hand is now a consequence of this field.
3. **Give it a door.** A `menuItemId`, or `bindings`, or both. A command with neither is invocable by nobody; the lint fails unless the entry declares which case it is. `internal: true` means *nothing opens this yet*, and carries a comment naming what blocks the door. `paneMenu: true` means *a card's pane `…` menu opens it* — a real door, dispatched through funnel #1 like any other, that the lint cannot count because the lint counts native menu items and key equivalents. The two are opposites and never appear together: an `internal` command is hidden from the keymap pane because a chord for it would record dead keystrokes, while a `paneMenu` command is listed there unbound, because a reader who just used it may fairly ask what it is bound to.
4. **Register the implementation.** A responder's `useResponder` actions map for chain routing; a `registerAction` handler for `registry` routing.
5. **Answer applicability.** Chain-routed commands answer through the responder's `validateAction`; add that branch on the responder rather than a predicate on the entry. `registry`-routed commands that are gateable carry a `validate` predicate. A check mark or a dynamic title rides `state` / `dynamicTitle`.
6. **Mirror it** (`mirrored: true`) in the same change that deletes any host-side tier gating the item, so exactly one definition of its enablement is ever live.
7. **Dispatch it through the funnel.** Every emitter calls `dispatchCommand(id)`. A button, a context-menu item, a slash bridge, and a menu item are four doors on one row — none of them reaches past the funnel into a store method or a bare `sendToFirstResponder`.
8. **Render its chord from the registry** — `commandShortcut(id)`, never an authored string.
9. **Test through the funnel**: dispatch the id, assert through `validateCommand` / `queryCommandState`, and reference the constant, never the raw string.

---

## Chords

**Which chord a command gets is derived, not chosen.** Two base tiers — ⌘ universal, ⌃⌘ Tug machinery — and two operators — ⇧ counterpart, ⌥ variant — generate every modifier set in use, and a proposed chord is checked by deriving its shape before it is checked for collisions. The algebra, its six rules, the plain-⌘ free pool, the macOS never-bind list, and the known anomalies are in [chord-tiers.md](chord-tiers.md).

**Identity is `KeyboardEvent.code` plus the four modifier flags.** The `label` is display data, captured from `event.key` at recording time and US-authored for built-in defaults. It never participates in matching, which is what lets a label be corrected for a layout without changing what the chord matches.

**Four layers resolve a chord, and the outermost is not in JavaScript.** In the shipped app AppKit scans menu-item key equivalents *before the web view sees a keydown at all*. So the order is: native menu, then focus mode, then the responder walk innermost-first, then global. A menu-eligible chord preempts every scoped binding regardless of focus — which means **menu placement is a chord decision**, not just a discoverability one. A disabled item's chord is a third state: it is eaten at the menu bar with a beep and reaches nothing, rather than falling through. `resolveChord` models all four layers and both failure shapes; it is the answer to "why does my key do nothing", and nothing may reason about shadowing by hand next to it.

**Deciding the disabled behavior is part of adding the chord.** `disabledChord: "keep"` (the default) means the command owns the chord outright and the beep is honest feedback. `"detach"` means the gate publishes a `null` chord while inapplicable, releasing the key equivalent so the chord reaches the JS funnel — the right answer for a command promoted from a scoped binding to a menu item, because it is what keeps the chord shadowable after the promotion.

**Chords reach Swift only through the menuState push.** The host never reads keymap overrides from tugbank; key equivalents are construction-time defaults until the first push, after which the sweep applies `commands[<identifier>].chord`. A second Swift-side reader would mean duplicating the override parser and the code→keyEquivalent conversion in Swift, which is the drift this architecture exists to remove.

**Overrides are per-command binding lists** in tugbank domain `dev.tugapp.keymap`: absent means "registry default", an empty list means "explicitly unbound". `NATIVE_LOCKED` is a curated policy list of ids that may not be rebound — policy as data, never a per-entry flag.

---

## What is not a command

The table covers user-invocable intents. Three kinds of traffic are deliberately outside it, and each is declared rather than merely absent:

- **tugcast data frames** (`spawn_session_ok`, `session_updated`, and their ~20 siblings) — protocol, not commands. No title, no validity, no chord. They keep the raw `registerAction` path.
- **Form-control currency** (`set-value`, `toggle`, `select-value`, `set-property`, …) — what a control says to its responder, not what a user invokes.
- **Substrate text-editing bindings** (⌃U / ⌃W / ⌥F / ⌥B, the CM6 keymaps) and **context-menu verbs over a sampled target** (`copy-command`, `reveal-in-finder`, …) — movement and deletion that only ever target the focused input, and verbs meaning "the thing the right-click landed on", which a chord or a menu item has no way to name.

Every one of these is enumerated in `ACTIONS_OUTSIDE_THE_TABLE`, and `lintActionCoverage` holds every `TUG_ACTIONS` value to one side of the line or the other. "Absent from the table" is never a silent omission.

---

## Validation gates doors, not dispatch

`validateCommand` answers whether a command is applicable right now, and its consumers are the surfaces that *show* a command: the menu's enablement mirror, buttons, context menus. `dispatchCommand` does **not** consult it. The responder that would perform the command is the thing that decides what happens, and a command nobody handles is already a silent no-op at the end of the chain walk. This is Cocoa's split — `validateUserInterfaceItem:` dims the door, `sendAction:` just sends.

Chain-routed commands validate through `manager.validateAction` walked from the same node they would dispatch to (`validateActionInKeyCard` for `key-card` routing). The Cocoa idiom is preserved: validity is asked of the object that would perform, at the moment of asking. When a chain command's validity is wrong, the fix is a `validateAction` branch on the responder — not a predicate on the entry that would become a second opinion.

---

## Enforcement

The table lints itself. `lintCommandTable` reports duplicate ids, two commands claiming one menu item, chain routing with no resolvable action, and the load-bearing one — **door coverage**: a command with neither a menu item nor a binding, and no `parameterized` / `internal` / `paneMenu` declaration. `lintActionCoverage` requires every action name to be a command wire or explicitly excluded. `lintNativeLocked` requires every locked id to name a live command. All three run at import time in DEV and throw, and again in `command-registry.test.ts`.

Beyond the lints it is review: a raw `sendToFirstResponder` at a call site whose action names a registry command, an authored chord string, a component matching a chord itself, or a hand-rolled shadowing comment are all the same defect wearing different clothes. `at0180-command-registry-gates`, `at0181-keymap-chord-sweep`, and `at0182-keymap-override` pin the menu gate, the chord sweep, and the override round-trip end to end.

---

## Cross-References

- [L30] — the law this document is the contract for
- [chord-tiers.md](chord-tiers.md) — the modifier algebra that decides *which* chord a command gets
- [L11] — controls emit actions; responders own the state actions operate on
- [action-naming.md](action-naming.md) — the name's shape and the `TUG_ACTIONS` constants
- [menus.md](menus.md) — the menuState wire contract and the mirror-first validation model
- [responder-chain.md](responder-chain.md) — `validateAction`, `queryActionState`, and the dispatch walk
- `tugdeck/src/components/tugways/command-registry.ts` — the table, its lints, and `ACTIONS_OUTSIDE_THE_TABLE`
- `tugdeck/src/command-dispatch.ts` — funnel #1
- `tugdeck/src/components/tugways/keymap-registry.ts` — funnel #2
- `tugdeck/src/keymap-override-store.ts` — the tugbank-backed override layer
