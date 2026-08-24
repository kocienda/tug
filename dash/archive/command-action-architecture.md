<!-- devise-skeleton v4 -->

## The Two-Funnel Command / Keymap Architecture {#two-funnel-architecture}

**Purpose:** Give Tug one front door for every user-invocable command (`dispatchCommand`) and one front door for every keyboard chord (the keymap registry that feeds it), so validity, state, chords, titles, and discoverability all derive from a single table — and put a user-facing keymap editor on top of it.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-04 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The [command-action audit brief](command-action-audit-brief.md) surveyed every way a command enters Tug and found the mechanism sound but the entry points scattered. A command can arrive as a Swift `sendControl` wire, a `TUG_ACTIONS` chain dispatch from a keybinding, a `TugButton` click, a `run-card-command` slash bridge, a raw `dispatchAction({action: "assign-slot", …})` string, or a direct store-method call. A chord can be declared in a Swift `keyEquivalent` literal, the static `KEYBINDINGS` array, a CM6 keymap, a scoped `useKeybindings` registration, or a raw capture listener that no audit surface can see. Validity is defined once per surface rather than once per command: `AppDelegate.validateMenuItem(_:)` has five hand-rolled tiers, `buildTextEditingMenuItems` computes its own `hasSelection`/`canEdit`, and `TugButton` aliases "validated" to "can handle". The brief's §F ledger lists twelve concrete defects that all trace back to that scattering — a permanently-dead Edit ▸ Delete, a ⌘R that beeps, context-menu labels advertising chords that do something else, Settings reachable by two independent code paths.

The end state the audit argues for is Cocoa's own shape: `NSApp.sendAction` is the command funnel, `NSApp.sendEvent` is the keyboard funnel, and the responder chain is the routing both feed. Tug already has three unformalized near-funnels — `dispatchAction` in `action-dispatch.ts`, stage 1 of the key pipeline in `responder-chain-provider.tsx`, and `useControlDispatch` — plus the decisive structural fact that **Swift claims no keys outside `NSMenuItem` key equivalents**, so the entire native key surface is derivable from one table. This plan formalizes those choke points, closes the leaks around them, and then spends the resulting leverage: validation and state become registry fields consumed by every surface, chord-only commands become one-line menu additions, and the keymap becomes editable because it is finally data.

#### Strategy {#strategy}

- **Repair the floor before building on it.** The brief's defects 1–7 are cheap, independent, and each one would otherwise be inherited as "expected behavior" by the registry that replaces it. They land first, with no architecture.
- **Introduce the command registry behavior-neutrally.** The registry's first job is to describe what already happens — same routing mechanisms, same wire names, same handlers — with `dispatchCommand` as the one call every emitter makes. Nothing user-visible changes in that milestone; the checkpoint is that the app-test corpus is unmoved.
- **Then make the registry load-bearing, one field at a time.** `validate` first (it retires the hand-rolled Swift tiers), then `state`, then `bindings`. Each field lands with its consumers converged onto it in the same step, so there is never a window where two definitions of the same fact coexist unaudited.
- **Keep Swift thin and structural.** Per the brief's locked decision, Swift keeps hand-building menu *structure* keyed by the existing `NSUserInterfaceItemIdentifier`s, and consumes validity, state, titles, and chords as pushed data. No menu-structure manifest, no Swift-side registry.
- **Multi-chord from the first line of code.** The binding shape is a list end to end — entry, wire, tugbank override, capture UI, Swift sweep. A single-chord model is never written down anywhere, not even as an intermediate.
- **Shadowing is a feature, not a resolution detail.** `resolveChord` lands with the keymap registry, not after it: a chord silently going dead is the failure mode the whole funnel exists to prevent.
- **The stack-chord loop is the template for persistence.** ⌘R's Cycle/Reveal preference already runs the full round trip — Settings control → tugbank → menuState push → `applyStackChordKeyEquivalent`. The user keymap is that loop generalized, not a new mechanism.

#### Success Criteria (Measurable) {#success-criteria}

- Every user-invocable command has exactly one registry entry, and `grep`ping for `sendControl(` in `AppDelegate.swift` finds no wire that is absent from the table (verified by a Swift-side test asserting every `sendControl` wire resolves in the pushed `commands` block, plus a TS unit test asserting the table has no duplicate ids).
- `dispatchAction` contains no command-specific routing: every non-data-frame branch resolves through `dispatchCommand` (verified by reading the file — it should be the tugcast data-frame handlers plus one fork).
- Menu enablement for every statically-built, non-parameterized menu item comes from `menuState.commands[<identifier>].enabled`; `validateMenuItem`'s hand-rolled `switch` retains only parameterized families (theme, panes, recents) and the native-undo special case (verified by `menuItemState` app-tests over the at0167–at0174 identifiers, all still green).
- Edit ▸ Delete is enabled whenever a text-editing surface with a selection is focused, and disabled otherwise (app-test asserting `menuItemState("edit.delete").enabled` flips with focus).
- ⌘R at stack depth ≤ 1 is attached to no menu item, so the chord falls through instead of beeping (app-test asserting `keyEquivalent == ""` on both `window.cycleStack` and `window.revealStack` at depth 1).
- Every chord displayed anywhere in the UI (context-menu shortcut hints, keymap pane, help sheet) is rendered from the keymap registry, so no displayed chord can disagree with its binding (verified by a unit test that renders `buildTextEditingMenuItems` shortcut strings from the registry and compares against `formatChord` of the live binding).
- `resolveChord(chord)` answers, for any chord, the ordered resolution stack — native layer included ([P15]) — with `active`/`shadowedBy` per entry; `bindingsFor(commandId)` answers whether each of a command's bindings is live (unit tests over a constructed multi-layer registry, including the case where a menu item preempts a scoped binding and the case where a disabled item eats the chord entirely).
- No `menuEligible` binding shares a chord with any scoped binding (the collision lint from [P15], run as a unit test over the whole table).
- A user rebinds a command in Settings ▸ Keyboard, and both the JS layer and the native menu bar honor the new chord without a restart (app-test: write a keymap override through the store, assert `menuItemState(<identifier>).keyEquivalent` changed, then assert the old chord no longer dispatches).
- Deleting a `dev.tugtool.keymap` override restores the registry default (app-test round trip).
- `tuglaws/menus.md` names every top-level `menuState` key the Swift decoder parses, and its control-frame catalog matches the registry table (verified by a unit test that regenerates the catalog section's rows from the registry and diffs against the checked-in doc).

#### Scope {#scope}

1. Floor repair for the brief's §F defects 1–7 (`AppDelegate.swift`, `tug-button.tsx`, `text-editing-menu.ts`).
2. The command registry (`command-registry.ts`) and `dispatchCommand`, with `dispatchAction` folded into it and the "Both" re-dispatch loops converted to table rows.
3. `validate` / `state` as registry fields, a `queryActionState` sibling hook on the responder chain, and the generalized `commands` mirror block in the menuState push consumed by a new first tier in `validateMenuItem`.
4. Consumer convergence: `TugButton`, the text-editing context menus, the Swift validation tiers, and the theme submenu's per-open tugbank read.
5. Door-gap closure: menu items for the chord-only commands in the brief's §A.3, chain identities for the control-frame-only commands that deserve them.
6. The keymap registry (`keymap-registry.ts`), `resolveChord` with shadowing, chord formatting/conversion shared by both sides, the Swift key-equivalent sweep driven from the push, and migration of the raw capture listeners.
7. The user keymap feature: tugbank `dev.tugtool.keymap` overrides, boot seeding, live re-apply, and a Settings ▸ Keyboard pane with chord capture, shadowing display, locked rows, and per-row reset.
8. `tuglaws/menus.md` refresh, plus the `action-naming.md` and `responder-chain.md` cross-references the new hooks require.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Replacing the responder chain or [L11].** The funnel is a front door; the walk still decides which responder handles `close`. No routing semantics change.
- **Generating menu *structure* from a shared manifest.** Locked by the brief's §G.5.1: Swift keeps hand-building the menu tree keyed by identifiers. A structure manifest remains a possible later step.
- **Substrate editing bindings.** ⌃U / ⌃W / ⌥F / ⌥B, Enter/submit, and the CM6 keymaps stay substrate-local text-editing currency; they are formally classified as outside the funnel, not migrated into it.
- **Form-control value actions.** `set-value`, `toggle`, `select-value`, `set-color`, `activate-color-well`, `set-property` are chain currency between controls and responders, not user-invocable commands. They keep their `TUG_ACTIONS` entries and never get registry rows.
- **tugcast data frames.** `spawn_session_ok`, `list_sessions_ok`, `session_updated`, and the ~20 siblings are protocol, not commands. They keep the raw `registerAction` handler path.
- **A command palette.** The registry makes one cheap; building one is a follow-on.
- **Localization.** `title` is a single-source display string, structured so a future localization pass has one place to work, but no localization infrastructure lands here.
- **Rebinding the native five.** `cut`/`copy`/`paste`/`delete`/`select-all` get registry entries with `routing: "native"` and appear in `NATIVE_LOCKED`; the mechanism could rebind them, the policy says no.

#### Dependencies / Prerequisites {#dependencies}

- The audit brief's inventory ([dash/command-action-audit-brief.md](command-action-audit-brief.md)) is the assignment sheet for which commands exist and where their handlers live. This plan does not re-derive it.
- tugbank defaults over `/api/defaults/<domain>/<key>` and the boot-time `TugbankClient` snapshot read in `main.tsx` — the persistence substrate for keymap overrides.
- The `menuState` WKScriptMessage channel (`lib/host-menu-state.ts` ⇄ `AppDelegate.updateMenuState(_:)`) — the only Swift↔JS state path, and the carrier for the new `commands` block.
- The app-test harness's `menuSnapshot` / `menuItemState` verbs (`TestHarnessConnection.swift`) — the regression surface for every menu assertion in this plan.

#### Constraints {#constraints}

- **No synchronous Swift→JS query at menu-open time, and there cannot be one.** `callAsyncJavaScript` is async-completion-only, and `validateMenuItem` runs inside AppKit's closed-menu key-equivalent scan. Validation and state must ride the push as data.
- **Key-equivalent mutation is banned inside `validateMenuItem`.** Chords are applied from `updateMenuState(_:)` — the site `applyStackChordKeyEquivalent` and the dynamic ⇧⌘S already use.
- **`autoenablesItems` is on everywhere.** Imperative `isEnabled` writes are silently overridden by the validator's `default: return true`. Every gate must be a validator branch.
- **An `NSMenuItem` carries exactly one key equivalent.** With multi-chord commands, the Swift sweep applies the first menu-eligible binding and leaves the rest to the JS funnel. That is a display constraint of the menu, never a constraint of the model.
- **A chord on a disabled menu item is eaten at the menu bar with a beep** — it does not fall through to the web view. Any command whose menu item can validate disabled while its chord should still work must have the chord detached, not just the item dimmed.
- **AppKit resolves a menu key equivalent before the web view sees a `keydown`.** Any chord on a menu item is therefore outside the JS funnel's reach entirely — it is not "first in the JS order", it is a layer above it ([P15]). This is what makes menu promotion a chord decision and not only a discoverability one.
- **`menuNeedsUpdate` rebuilds discard swept chords.** The View, Window pane-list, theme, and Open Recent menus `removeAllItems()` and reconstruct from construction-time literals, and the push only fires on a changed projection — so the chord sweep must run at the tail of each rebuild as well as from `updateMenuState`.
- **A hidden menu's chords fall through** unless `allowsKeyEquivalentWhenHidden` is set. The Maker menu is hidden when maker mode is off, so ⌘L / ⌥⌘L / ⇧⌘R / ⌘T / ⌥⌘C reach the JS layer in that state. The keymap's conflict view has to model this.
- **Warnings are errors** in the Rust workspace; `bunx tsc --noEmit` and `bunx vite build` must both pass for tugdeck (the debug app loads the production rollup bundle).
- **`evalJS` wedges above roughly 8KB of payload**, so any harness-facing registry snapshot must be filterable rather than dumping the whole table.
- **No `localStorage`.** Keymap overrides live in tugbank.

#### Assumptions {#assumptions}

- The wire names in `TUG_ACTIONS` and the control-frame registry are already canonical and stable; the registry adopts them as command ids rather than minting a parallel namespace.
- The existing `NSUserInterfaceItemIdentifier` values (`session.stop`, `edit.delete`, `window.cycleStack`, …) are stable and are the correct join key between the registry and the native menu; at0167–at0174 depend on them.
- The `menuState` payload can absorb a `commands` block of roughly 60–80 small objects without a meaningful cost, because the publisher only posts when the serialized projection changes and menu-relevant change is rare relative to store churn.
- Every menu-exposed command's validity is expressible as a pure read of state the frontend already has (this is what the brief's push-mirror finding asserts, and what `computeEditCapabilities` demonstrates for thirteen capabilities).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Chord display strings on non-US layouts (DEFERRED) {#q01-layout-display}

**Question:** `KeyboardEvent.code` identifies a physical key, so `"Slash"` prints `/` on a US layout and something else elsewhere. The registry matches on `code` (see [P09]) and stores the `event.key` observed at capture time as a display label, but built-in defaults have no capture event to observe — their labels are authored from the US layout.

**Why it matters:** On a non-US layout, a built-in chord's displayed label can name a character that is not on the key the user must press. This is a cosmetic lie, not a functional break, but it is exactly the class of lie [P11] exists to eliminate.

**Options (if known):**
- Ship US-authored labels for defaults and accurate captured labels for user bindings; accept the asymmetry.
- Probe the layout at boot by synthesizing key events — not possible; `KeyboardEvent` cannot be constructed with a trustworthy layout-derived `key`.
- Use the Keyboard Map API (`navigator.keyboard.getLayoutMap()`) — Chromium-only, absent in WebKit, so unavailable to Tug.
- Read the layout natively (`TISGetInputSourceProperty` / `UCKeyTranslate`) in the Swift host and push a code→character map alongside the chord data.

**Plan to resolve:** The native `UCKeyTranslate` route is the only accurate one and is a self-contained addition to the existing push. Defer it until after the keymap pane ships and a real non-US layout is in hand to test against; the pane's per-row display is the one consumer, and it degrades to a US-authored label until then.

**Resolution:** DEFERRED — revisit as a follow-on once Settings ▸ Keyboard is in use. Tracked in [#roadmap].

#### [Q02] Which commands earn menu placement in the door-gap milestone (OPEN) {#q02-menu-placement}

**Question:** The brief's §A.3 lists ten chord-only commands and five control-frame-only commands as promotion candidates. Menu real estate is a design judgment, not a mechanical one — turn navigation and the command picker are obviously Session-menu material; whether `set-imposition` deserves a View-menu group or stays a Lens-only affordance is a taste call.

**Why it matters:** Promoting the wrong things bloats the menu bar, which is the discoverability surface the whole exercise is meant to improve.

**Options (if known):**
- Promote everything the brief names.
- Promote only the commands that already have a chord (the "working but undiscoverable" set, which is the actual menus.md violation).
- Promote the chord-holders plus the Window-menu slot items, and leave the Lens-internal verbs (`set-imposition`, `set-imposition-lens`, `assign-slot`) as registry entries with no `menuItemId` — visible to the keymap UI and the palette, absent from the menu bar.

**Plan to resolve:** The third option is the working assumption for [#step-16] and [#step-17]; the step lists the concrete items and the user can strike rows at implementation time without touching any other step. Registry membership is decided here (everything gets an entry); menu placement stays a per-row judgment.

**Resolution:** OPEN — resolved per-row during [#step-16]; the plan commits only to "every chord-holding command gets a menu item".

#### [Q03] Whether scoped bindings can be user-rebound in the first cut (DEFERRED) {#q03-scoped-rebinding}

**Question:** `useKeybindings` registrations (the PDF card's page keys, the gallery's ⇧⌘Y) are activation-scoped to a responder or a focus mode. The keymap registry makes them *visible* to `resolveChord` and the keymap UI. Whether the UI also lets the user *rebind* them is a separate question: a scoped binding's default lives in a component's render, not in the command table, so an override has to be reconciled at registration time.

**Why it matters:** Guessing yes builds reconciliation machinery that may go unused; guessing no and later reversing means changing the override format, which is persisted user data.

**Plan to resolve:** The override format is already keyed by command id and carries an explicit `scope` per binding ([Spec S04](#s04-override-format)), so it can express a scoped override without a format change. Ship the pane read-only for scoped rows (shown, with their scope named, marked "not rebindable here") and add the reconciliation later if it is wanted.

**Resolution:** DEFERRED — the format admits it; the UI defers it. Revisit after the pane ships.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Registry migration silently changes routing for some command | high | med | Behavior-neutral milestone with the app-test corpus as the checkpoint; per-command routing is transcribed from the existing call site, never inferred | Any at0167–at0179 regression |
| `commands` mirror block inflates the menuState payload / post rate | med | low | Only menu-exposed, non-parameterized commands ride it; the publisher's serialized diff already suppresses no-op posts | A measurable rise in `menuState` post frequency |
| The mirror's **recompute** cost, not its payload: ~60–80 predicates replace `computeEditCapabilities`'s 13, on the same triggers | med | med | Measure before and after in [#step-13] rather than assuming; keep the per-keystroke refresher path narrow if the measurement says to (see R04) | Any q99 regression in the typing probes |
| Swift chord sweep fights AppKit's key-equivalent scan | high | low | Sweep runs only in `updateMenuState`, the site the two shipped dynamic chords already use | Any beep-instead-of-fire report |
| Keymap override lets the user strand a chord (or themselves) | med | med | `NATIVE_LOCKED` policy list, per-row and global reset, shadowing rendered inline before the binding is committed | A support report of an unrecoverable keymap |
| Menu identifier drift between registry `menuItemId` and Swift construction | med | med | Harness assertion that every `menuItemId` in the table resolves to a real item, run in the menu-structure app-test | Any `found: false` from `menuItemState` |
| Scope creep across seven milestones | med | high | Each milestone's steps carry independent commits and falsifiable checkpoints; the plan is walkable in pieces and stoppable at any milestone boundary | — |

**Risk R01: Behavior drift during the behavior-neutral migration** {#r01-migration-drift}

- **Risk:** Converting ~50 wires and 32 "Both" identity entries into table rows is mechanical but voluminous, and one mis-transcribed `routing` turns a working command into a silent no-op that no type checker catches.
- **Mitigation:**
  - Transcribe routing from the existing call site verbatim; the conversion step's task list is "read `action-dispatch.ts` top to bottom, one row per `registerAction`".
  - Add a TS unit test that asserts the registry's routing for each converted id equals the mechanism the old code used, encoded as an explicit expectation table checked in with the step.
  - Run the at0167–at0179 menu/keybinding app-tests as the step's checkpoint, not at the end of the milestone.
- **Residual risk:** Commands with no test coverage and no menu item (the Lens-internal verbs) can still drift unnoticed until used by hand.

**Risk R02: The mirror and the predicate disagree** {#r02-mirror-divergence}

- **Risk:** The `commands` block is a projection of the registry's `validate`. If a predicate reads state the mirror's recompute trigger does not observe, the menu shows a stale answer — the exact failure `registerEditCapsRefresher` was added to patch for undo depth.
- **Mitigation:**
  - Keep the existing two-trigger model: `validationVersion` bumps plus the explicit refresher escape hatch, generalized from edit caps to the whole block.
  - Require every registry predicate to read live state at call time (refs and store snapshots, never captured closures) per [L07].
  - Where a predicate depends on a store the chain cannot see, the store's publisher subscribes the refresher — the same wiring `lib/host-menu-state.ts` already does for `cardSessionBindingStore` and `cardTitleStore`.
- **Residual risk:** A newly-added predicate can still read an unsubscribed store; the reviewer's checklist item is "what makes this recompute?".

**Risk R04: The generalized mirror recompute lands on a hot path** {#r04-recompute-cost}

- **Risk:** `publishEditCaps` in `responder-chain-provider.tsx` computes 13 capabilities today. [#step-13] generalizes it to every non-parameterized entry with a `menuItemId` — 60–80 predicates, each a chain walk plus store reads — on the *same* three triggers: every `validationVersion` bump (focus / register / unregister), a microtask on every `focusin`/`focusout`, and `requestEditMenuStateRefresh` from `tug-text-editor/undo-menu-state-plugin.ts`, which runs inside a CM6 `update`. This repo has an open typing-lag program; a 5–6× multiplier on a closure reachable from a CM6 update is not something to assume away.
- **Mitigation:**
  - The undo plugin already gates: it republishes only when undo/redo *availability or label* changes, so a continued typing run requests nothing. Preserve that gate exactly — do not widen the refresher's trigger while widening its work.
  - Measure in [#step-13]'s checkpoint with the synthetic typist and the deck probes, before the predicates are populated in [#step-14] and while the delta is still attributable.
  - If the measurement says the whole block is too much for the keystroke-reachable path, split the recompute: the edit family (which is what the refresher actually cares about) recomputes on the refresher, the rest on `validationVersion` only. The wire shape does not change, so this is a local decision made on data.
- **Residual risk:** A predicate added later that is individually expensive (a filesystem-shaped or serialize-shaped read) reintroduces the cost with no signal. The reviewer's checklist item from R02 — "what makes this recompute?" — gains a sibling: "what does it cost each time?".

**Risk R03: Chord conversion loses fidelity between `code` and `keyEquivalent`** {#r03-chord-conversion}

- **Risk:** `KeyboardEvent.code` and `NSMenuItem.keyEquivalent` are different alphabets — `"ArrowUp"` is `NSUpArrowFunctionKey`, `"Escape"` is `\u{1b}`, and shifted punctuation (⌘+ vs ⌘=) is genuinely ambiguous in AppKit. A bad conversion produces a chord that renders wrong or fires never.
- **Mitigation:**
  - One conversion function (`codeToKeyEquivalent`) with an explicit table for every code the registry actually uses, plus a unit test that round-trips every binding in the table.
  - Shifted punctuation resolves to the shifted *character* with `shift` suppressed from the mask, per the table in [#chord-conversion] — the conversion returns the pair `(keyEquivalent, mask)`, never a character and a mask computed independently.
  - Keep ⌘+ and ⌘= as two separate bindings on the same command, which is what the current hidden-alias item already models.
  - The menu-structure app-test asserts the resulting `keyEquivalent` and `modifierMask` for a spot-check set, so a conversion regression fails a test rather than a user's finger.
- **Residual risk:** A future binding on an untabled code fails at runtime; the conversion function throws in dev rather than returning an empty string, so it surfaces immediately.

---

### Design Decisions {#design-decisions}

#### [P01] The registry is a TypeScript table beside the action vocabulary (DECIDED) {#p01-registry-home}

**Decision:** The canonical command table lives at `tugdeck/src/components/tugways/command-registry.ts`, next to `action-vocabulary.ts`; Swift consumes it as pushed data and never holds a copy.

**Rationale:**
- Locked by the audit brief's §G.5.1: the canonical names already live in TypeScript, and every predicate the entries carry needs frontend state that only the frontend has.
- Swift's job stays structural — build the menu tree, stamp identifiers, send wires — which is what makes the mirror coherent rather than a second opinion.
- A pure-data module with no imports beyond `action-vocabulary.ts` and the chord types can be imported by anything, including the keymap registry and the Settings pane, without an import cycle.

**Implications:**
- `dispatchCommand` lives in a separate module (`tugdeck/src/command-dispatch.ts`) that may import the chain manager and the control-frame handler map; the table itself stays dependency-light.
- Any Swift-side knowledge of a command is limited to the item identifier it stamps at build time.

#### [P02] The join key between registry and native menu is the item identifier (DECIDED) {#p02-identifier-join}

**Decision:** A registry entry names the `NSUserInterfaceItemIdentifier` of the menu item it drives (`menuItemId`), and the pushed `commands` block is keyed by that identifier — not by command id.

**Rationale:**
- Swift then needs no identifier→command map of its own: `validateMenuItem` looks up `menuState.commands[id]` directly with the id it already switches on.
- The existing identifiers (`session.stop`, `edit.delete`, …) are load-bearing for `menuSnapshot` / `menuItemState` and for at0167–at0174; renaming them to match command ids would break the whole regression surface for no gain.
- The join is maintained in exactly one place (the TypeScript table), which is the only way a hand-maintained join stays honest.

**Implications:**
- One command with two menu items (if it ever happens) needs two rows or a list-valued `menuItemId`; the type is a single optional string until that case appears.
- A `menuItemId` naming an item that does not exist is detectable from the harness (`menuItemState` returns `found: false`), and [#step-13] adds that assertion.

#### [P03] The registry covers user-invocable commands only; data frames keep the raw path (DECIDED) {#p03-command-vs-data}

**Decision:** `dispatchAction` forks: an incoming control frame whose action names a registry entry goes through `dispatchCommand`; anything else (the tugcast data frames) resolves through the existing `registerAction` handler map unchanged.

**Rationale:**
- Roughly twenty of the ~45 registered wires are protocol acks and pushes (`spawn_session_ok`, `list_sessions_progress`, `session_updated`, `app-lifecycle`, `voiceover-changed`, `eval`, `ask`). They have no title, no validity, no chord, and no business in a keymap UI.
- The command/data boundary the registry draws is exactly the brief's "user-invocable intent vs internal currency" line, and drawing it explicitly is what keeps the table meaningful.
- The fork is behavior-preserving: today every one of these already goes through the same `handlers` map.

**Implications:**
- `dispatchAction` keeps its handler map and its unknown-action warning for the data path.
- A wire that is neither a registry command nor a registered data handler warns exactly as it does today.

#### [P04] Routing is a data field, not a call-site choice (DECIDED) {#p04-routing-as-data}

**Decision:** Each entry declares `routing: "first-responder" | "key-card" | "target" | "registry" | "native"`, and `dispatchCommand` picks the mechanism from it. The five values map to `sendToFirstResponderForContinuation`, `sendToKeyCard`, `sendToTarget`, the registered control-frame handler, and "represented but never routed through JS".

**Rationale:**
- These are already the only five mechanisms in use; making them data is what collapses 32 near-identical re-dispatch closures in `action-dispatch.ts` into table rows.
- `first-responder` uses the continuation-aware dispatch and invokes the continuation immediately, because that is what the existing menu-command adapters do and why they do it (a native menu round-trip arrives after AppKit already played its blink).
- Native entries exist so the keymap UI can show Hide, Quit, Minimize, Full Screen and the `NSText` five, which otherwise would be invisible commands the user cannot find.

**Implications:**
- `dispatchCommand("hide-application")` is a no-op with a dev warning; native commands are display and policy rows, not dispatchable ones.
- Adding a sixth mechanism means adding a routing value, which is a deliberate, reviewable act.

#### [P05] Payload-parameterized commands get one entry per value, except for dynamic families (DECIDED) {#p05-parameterization}

**Decision:** A command whose payload comes from a fixed, known set gets one registry entry per value (`move-to-slot:1` … `move-to-slot:9`, `set-permission-mode:plan`, `select-composer-route:changes`, `set-page-mode:two`, and one entry per `run-card-command` slash bridge). A command whose payload set is discovered at runtime (`set-theme`, `focus-pane`, `open-recent-document`, `assign-slot`) stays a single entry marked `parameterized: true`.

**Rationale:**
- Individually-addressable entries are what make a command menu-placeable, rebindable, and enumerable — ⌘1…⌘9 are nine distinct user-facing commands, and the keymap UI must show them as nine rows.
- Dynamic families cannot be enumerated at table-authoring time; their menu items are rebuilt in `menuNeedsUpdate` and their state marks are written there, so they are structurally outside the static mirror already.
- The line is drawn where the code already draws it: static `buildMenuBar` items versus `menuNeedsUpdate` rebuilds.

**Implications:**
- Entry shape carries `action` (the chain action to dispatch, defaulting to `id` when the id is itself a `TUG_ACTIONS` value) and `payload` (the static `ActionEvent.value`).
- `parameterized` entries are excluded from the `commands` mirror, from the keymap UI's rebindable rows, and from the "every entry has a menu item or a chord" lint.
- The twenty `run-card-command` bridges become twenty entries all dispatching `run-slash-command` with different `{name, args}` payloads — which is also what gives each one an individually gateable validity.

#### [P06] Chain commands validate through the chain; registry commands carry predicates (DECIDED) {#p06-validation-split}

**Decision:** An entry with chain routing (`first-responder` / `key-card` / `target`) validates by default through `manager.validateAction(action)` — walked from the first responder or from the key card's content responder to match its own routing. An entry may override with an explicit `validate` predicate; `registry`-routed entries must supply one if they are gateable, and default to always-enabled if not.

**Rationale:**
- This preserves the Cocoa idiom the brief names: validity is asked of the object that would perform, at the moment of asking. The chain already implements it; the registry should defer to it rather than duplicate it.
- Coverage, not mechanism, is the gap — so the work is adding `validateAction` branches on responders, which this decision routes toward instead of away from.
- Control-frame commands have no responder to ask, so a collocated predicate on the entry is the only home available.

**Implications:**
- `manager.validateAction` needs a key-card-scoped variant so a `key-card`-routed command validates from the same node it would dispatch to (today `computeEditCapabilities` only ever asks from the first responder).
- A chain command whose responder registers no `validateAction` answers `true` when handled and `false` when unhandled — today's semantics, unchanged.

#### [P07] State is a sibling hook, mirrored as a boolean per menu item (DECIDED) {#p07-state-hook}

**Decision:** Responder nodes gain an optional `queryActionState?(action): boolean | string | undefined`, walked exactly like `validateAction` (first node that handles terminates). Registry entries gain the same-shaped optional `state`. The `commands` mirror publishes the narrowed boolean per menu item, because a per-value entry ([P05]) turns "current value is X" into "this item is checked".

**Rationale:**
- Symmetry with `validateAction` means one walk semantic to learn and one subscription (`validationVersion`) to drive both.
- The string form is still needed off-menu — the keymap pane and any future palette want "the current permission mode", not nine booleans — so the hook keeps the wider return type and the wire narrows.
- The permission-mode pattern (one shared resolver, chip and menu as two faces) is the proven shape; this generalizes it rather than inventing one.

**Implications:**
- `MenuCommandGate.state` is `boolean?` on the wire; Swift writes `.on`/`.off` and never has to interpret a value.
- Title flips (Show/Hide Changes, Undo *noun*) ride the same gate as `title?: string`, retiring the title mutation currently done inside the Swift validation sweep.

#### [P08] Dispatch routing and activation scope are orthogonal fields (DECIDED) {#p08-routing-vs-scope}

**Decision:** `routing` (how a command dispatches) lives on the command entry. `scope` (where a binding is live) lives on the binding: `"global"`, `{ responder: id }`, or `{ mode: id }`. The **JS** resolution order is focus mode, then the first-responder walk innermost-first, then global. The full in-app order puts a fourth layer *above* all three — see [P15].

**Rationale:**
- Today's `KeyBinding.scope` field conflates the two — it names dispatch routing (`"first-responder"` | `"key-card"`) while `useKeybindings` separately encodes activation context by *where* it registers. Under one table those must be distinct fields or "innermost scope wins" is meaningless.
- The stated JS order is exactly what stage 1 in `responder-chain-provider.tsx` already does (`manager.resolveKeybinding(event, [mode])` then `matchKeybinding(event)`), so formalizing it changes no behavior.
- Cocoa's analogue is the same split: `performKeyEquivalent:` walks the view hierarchy for activation, and the resolved action then routes through `sendAction`.

**Implications:**
- The `KeyBinding.scope` field is renamed to `routing` where it survives, and the migration must touch every entry in `KEYBINDINGS` and every `useKeybindings` call site.
- Scoped bindings register through `manager.registerKeybinding` as today for *resolution*, and are additionally readable by `resolveChord` for *visibility* — one source of truth, two readers.

#### [P15] The native menu is the outermost resolution layer, and `resolveChord` must model it (DECIDED) {#p15-native-layer}

**Decision:** `resolveChord` returns a four-layer stack — `native`, then mode, then the responder walk innermost-first, then global. The `native` layer is present for a chord when some menu item carries it as a key equivalent, and it is *active* (and therefore shadows every JS layer beneath it) when that item validates enabled and its enclosing menu is either visible or carries `allowsKeyEquivalentWhenHidden`.

**Rationale:**
- In the shipped app AppKit's key-equivalent scan runs before the web view sees a `keydown` at all, so a menu-eligible chord preempts every scoped binding regardless of focus. This inverts [P08]'s innermost-first order in exactly the case the keymap UI exists to explain.
- The codebase already knows this and reasons about it by hand: `pdf-view.tsx` declines to bind ⌘1–⌘3 ("a viewer is not the place to redefine a deck-wide navigation command") and declines the zoom chords outright ("they belong to the host's View menu and never reach the web view at all"). That comment is a hand-maintained shadowing analysis; it is exactly what `resolveChord` should be answering.
- A three-layer answer would report a scoped binding `active` when the user's finger reaches a menu item instead — a lie in the one surface whose entire job is to be believed, and the same class of lie [P11] retires.
- Every input is already in hand: `menuChords()` knows which chords are menu-eligible, the `commands` mirror knows each item's `enabled`, and the Maker menu's hidden state is the one hiddenness case (its ⌘L / ⌥⌘L / ⇧⌘R / ⌘T / ⌥⌘C fall through when maker mode is off).

**Implications:**
- `ChordResolution` carries a `layer` discriminator; the native entry names the `menuItemId` rather than a `BindingScope`.
- A disabled menu item's chord is *not* a fallthrough — per [#constraints] it is eaten with a beep — so the native layer at `enabled: false` renders as "eaten, reaches nothing", a third state the pane must show and neither `active` nor `shadowedBy` expresses.
- The door-coverage lint gains a sibling: a **collision lint** failing when a `menuEligible` binding shares a chord with any scoped binding. Today's only clean answer is to not create the collision; the lint is what keeps [#step-16] from creating one silently.

#### [P09] Chords match on `code`; the display label is separate data (DECIDED) {#p09-chord-identity}

**Decision:** A chord is identified by `KeyboardEvent.code` plus the exact state of the four modifier flags — today's `keyBindingMatchesEvent` rule, unchanged. The human-readable label is a separate, non-identifying field, captured from `event.key` when the user records a chord and authored from the US layout for built-in defaults.

**Rationale:**
- `code` is layout-independent, which is why the existing map uses it; switching to `key` would change the meaning of all forty shipped bindings and require a migration with no offsetting benefit.
- Separating display from identity is what lets [P11] hold: a label can be improved (or corrected per layout) without touching what the chord matches.
- The accurate-label problem is real but narrow and solvable later without a format change ([Q01]).

**Implications:**
- `Chord` carries `{ key: string /* code */, ctrl?, meta?, shift?, alt?, label?: string }`.
- `formatChord` renders from the modifier flags plus the label (falling back to a code→glyph table), and is the single renderer for every displayed chord.

#### [P10] Chords reach Swift only through the menuState push (DECIDED) {#p10-chords-via-push}

**Decision:** The Swift host never reads keymap overrides from tugbank. Key equivalents are construction-time defaults until the first `menuState` push, after which `updateMenuState` sweeps them from `commands[<identifier>].chord`.

**Rationale:**
- The shipped precedent is exactly this: the stack-chord preference — a chord preference — rides the push, seeded into `stackChordStore` at boot and applied by `applyStackChordKeyEquivalent` from `updateMenuState`. Reading it a second way would be a second source.
- A Swift-side read would mean duplicating the override format parser *and* the `code → keyEquivalent` conversion in Swift, which is precisely the drift vector this plan exists to remove.
- The audit brief's alternative (read overrides in `loadPreferences`) buys correctness only in the window before the first push, which the frontend closes within its own boot.

**Implications:**
- Between app launch and the first push, the menu bar shows *default* chords. A user who has rebound a chord and presses it in that window gets the default behavior, not nothing — an acceptable and self-correcting state, and strictly better than showing a stale override.
- The `chord` field is nullable: `null` means "detach the key equivalent", which is how a rebound-away or unbound command clears itself, and how ⌘R detaches at stack depth ≤ 1.

#### [P11] Every displayed chord renders from the registry (DECIDED) {#p11-displayed-chords}

**Decision:** No chord string is ever authored inline in UI code. Context-menu shortcut hints, the help sheet, the keymap pane, and any future palette all call `formatChord(bindingsFor(commandId)[0])`.

**Rationale:**
- Defect 6 in the brief — `text-editing-menu.ts` advertising ⇧⌘C for Copy as Plain Text when the real chord is ⌥⇧⌘C and ⇧⌘C is Session ▸ Show Changes — is the concrete cost of authored strings, and it is unfixable-in-principle as long as they are authored.
- Once chords are user-editable, an authored string is guaranteed wrong for anyone who rebinds.

**Implications:**
- `TextEditingMenuEntry.shortcut` stops being a literal and becomes derived; the same for any other surface found carrying one.
- A command with no binding renders no shortcut, and with several renders the first — the same rule the Swift sweep uses.

#### [P12] Locking is a policy list, not an entry field (DECIDED) {#p12-native-locked}

**Decision:** `NATIVE_LOCKED` is a curated array of command ids living beside the registry. Lockedness is a predicate both the keymap UI and the override validator read from it; no entry carries a `locked` flag.

**Rationale:**
- Locked by the brief's §G.5.4. The mechanism has no hard limitation — every entry is mechanically rebindable — so encoding policy as data keeps the two separable and makes changing the policy an edit to one list.
- A per-entry flag invites the policy to sprawl across the table and to be reasoned about per-command instead of as a whole.

**Implications:**
- The override validator rejects a write against a locked id (and the UI never offers one), so a hand-written tugbank value cannot unbind ⌘Q.
- The initial list is Hide / Hide Others / Show All / Quit / Services, the `NSText` five (`cut`/`copy`/`paste`/`delete`/`select-all`), Minimize, Zoom, and Enter Full Screen.

#### [P13] The mirror block is keyed by menu item and carries enablement, state, title, and chord together (DECIDED) {#p13-mirror-shape}

**Decision:** `MenuStatePayload` gains `commands: Record<string, MenuCommandGate>` where `MenuCommandGate = { enabled: boolean; state?: boolean; title?: string; chord?: ChordSpec | null }`, keyed by `menuItemId` ([P02]).

**Rationale:**
- All four facts change together and are consumed by the same two Swift sites (`validateMenuItem` for the first three, `updateMenuState` for the chord), so splitting them into four blocks would multiply the wire and the decoder for nothing.
- Bundling them makes the Swift first tier a four-line block and lets the existing hand-rolled tiers be deleted item by item rather than all at once.

**Implications:**
- `MenuStateEditBlock` is subsumed by `commands` for the twelve edit items; `nativeUndoToken` stays a top-level field because it gates a Swift-side behavior (clearing the web view's undo stack), not a menu item's appearance.
- The Swift decoder gains one dictionary parse; every existing block stays for the tiers not yet migrated and is removed as each is retired.

#### [P14] Keymap overrides are per-command binding lists in tugbank (DECIDED) {#p14-override-storage}

**Decision:** Overrides live in tugbank domain `dev.tugtool.keymap`, one key per command id, whose value is a JSON-encoded binding list. An absent key means "use the registry default"; an empty list means "explicitly unbound".

**Rationale:**
- Per-command keys make reset-to-default a deletion and keep a single command's rewrite from racing another's, which a single blob value would not.
- The list form is mandated by the brief's §G.5.2 — never a scalar that would have to grow.
- The distinction between absent and empty is what makes "I deliberately have no chord for this" expressible and durable.

**Implications:**
- Boot reads the whole domain from the `TugbankClient` snapshot in `main.tsx` before `initHostMenuState`, exactly as `stackChordStore.initialize` does today.
- The DEFAULTS push applies remote writes with `persist: false` to avoid an echo loop, matching `keyboardAccessStore` and `stackChordStore`.

---

### Deep Dives {#deep-dives}

#### How a command enters Tug today {#current-entry-points}

Six distinct paths, all landing on the same three mechanisms:

1. **Swift menu item → `sendControl(wire)` → CONTROL frame → `dispatchAction` → registered handler.** Roughly fifty distinct wires from `AppDelegate.swift`'s selectors. For thirty-two of them the handler is a one-line re-dispatch back onto the chain (the "Both" identity entries), grouped in `action-dispatch.ts` into four loops — a `sendToFirstResponder` save-verb loop, a `sendToFirstResponder` zoom loop, a `sendToFirstResponderForContinuation` loop whose continuation is invoked immediately, and a `sendToKeyCard` loop — plus a handful of standalone adapters of the same shape (`close`, `close-all`, `add-card-to-active-pane`, `show-component-gallery`).
2. **Keybinding → stage 1 capture listener → chain dispatch.** `responder-chain-provider.tsx`'s `captureListener` resolves `manager.resolveKeybinding(event, [focusMode])` first, then falls back to the static `matchKeybinding(event)`, then dispatches by `binding.scope` (`key-card` vs first-responder), copying `binding.value` onto the event.
3. **`TugButton` with an `action` prop → `sendToTarget` or `useControlDispatch`.** Validation is `nodeCanHandle` against the dispatch target.
4. **`run-card-command` slash bridges.** Twenty menu items carrying a slash-command name in `representedObject`; one handler re-dispatches `RUN_SLASH_COMMAND` key-card-scoped with `{name, args}`.
5. **Raw-string `dispatchAction` from UI code.** `set-imposition`, `set-imposition-lens`, `assign-slot`, `focus-session-card`, `open-diff` — registered, dispatched by string, no constant, no chord, no menu.
6. **Direct store-method calls.** `codeSessionStore.interrupt()` from the submit button in parallel with the `INTERRUPT_SESSION` chain path; `deckManager.centerPane` / `pinLens` / `showLensPane` / `movePane` with no action names at all; `CommitModeController`'s `exit`/`land`.

Path 6 is the one the funnel cannot mechanically capture — a direct method call is invisible to any table. Those are converted by giving the verb a command id and routing the caller through `dispatchCommand`, which is a per-site edit and is why [#step-10] exists as its own step.

#### The two funnels, concretely {#funnel-shape}

**Funnel #1** is `dispatchCommand(id, payload?)` in `tugdeck/src/command-dispatch.ts`:

```
dispatchCommand(id, payload?)
  ├─ entry = COMMANDS_BY_ID.get(id)          → miss: dev-warn, return unhandled
  ├─ if !validateCommand(entry)              → return unhandled (no beep path in JS)
  ├─ switch entry.routing
  │    first-responder → manager.sendToFirstResponderForContinuation({action, value})
  │                       then continuation?.()
  │    key-card        → manager.sendToKeyCard({action, value})
  │    target          → manager.sendToTarget(payload.targetId, {action, value})
  │    registry        → registeredHandler(entry.id)(payload)
  │    native          → dev-warn "native command is not JS-routable", return unhandled
  └─ notifyCommandObservers(id, handled)
```

**As shipped:** the `if !validateCommand(entry)` line was deliberately dropped — `dispatchCommand` does not gate dispatch on validation. Validation gates doors, not dispatch: `validateCommand`'s consumers are the surfaces that *show* a command (the menu mirror, buttons, context menus), while dispatch just sends — the responder that would perform the command is the thing that decides, and a command nobody handles is already a silent no-op at the end of the chain walk. This is Cocoa's split between `validateUserInterfaceItem:` and `sendAction:`; the argument lives in the `tugdeck/src/command-dispatch.ts` header.

`dispatchAction` (the CONTROL-frame entry point) becomes: parse the frame, and if `COMMANDS_BY_ID.has(action)` call `dispatchCommand(action, payload)`, else fall through to the data-frame handler map ([P03]). Stage 1 of the key pipeline becomes: resolve a chord to a `commandId` through the keymap registry, then call `dispatchCommand`. `TugButton` keeps `sendToTarget` for its targeted-dispatch semantics but reads validity from `validateCommand` when its action names a registry command.

**Funnel #2** is `keymap-registry.ts`. It holds `Map<commandId, KeymapBinding[]>` seeded from the table's defaults and overlaid with tugbank overrides, is subscribable ([L02]), and exposes:

- `matchChord(event): { commandId, binding } | null` — the global layer, replacing the static `KEYBINDING_INDEX` lookup.
- `resolveChord(chord, scope?): ChordResolution[]` — the full stack, native layer first and then innermost-first ([P15]), each entry marked `active` or `shadowedBy`.
- `bindingsFor(commandId): (KeymapBinding & { active, shadowedBy? })[]`.
- `menuChords(): Record<menuItemId, ChordSpec | null>` — what the mirror publishes.

Scoped bindings are not stored in the keymap registry; `resolveChord` reads them from `manager.activeKeybindings()` so there is one home for a scoped binding (the component that declares it) and one place that can *see* all of them.

#### Why the Swift key surface is fully derivable {#swift-key-surface}

The audit's most load-bearing finding: `tugapp/Sources` contains **no** `performKeyEquivalent` override, **no** `NSEvent` local monitor, and **no** `keyDown` override. Every native key claim is an `NSMenuItem.keyEquivalent`. Therefore sweeping `NSApp.mainMenu` and applying chords from the push is not a partial measure — it is complete coverage of the native side, and nothing can hide from the keymap UI's conflict view.

Two shipped precedents prove the sweep is safe at that site: `applyStackChordKeyEquivalent()` moves ⌘R between two Window items, and the dynamic ⇧⌘S attaches Save As only while a Text card is frontmost. Both mutate key equivalents from `updateMenuState(_:)` and both carry the comment explaining why never from `validateMenuItem` — AppKit's closed-menu key-equivalent scan runs the validator, and mutating a key equivalent inside that scan is undefined.

The sweep is a recursive walk of `NSApp.mainMenu` (~120 items) applying `commands[item.identifier].chord`. No index of items is maintained, so dynamic rebuilds (View, Window, Theme, Open Recent) cannot leave a stale reference behind.

It cannot run *only* from `updateMenuState`, though, and this is the one place the "push is the single source" story needs a second call site. `rebuildViewMenu`, `rebuildOpenRecentMenu`, the Window pane slice, and the theme submenu each `removeAllItems()` and reconstruct their items from construction-time `keyEquivalent` literals — and `updateMenuState` fires only when the serialized projection changes, because `HostMenuStatePublisher` diffs before posting. So a rebuild that happens after a rebind restores the *literal*, and nothing republishes to correct it: open the View menu once after rebinding ⌘+ and the old chord is back until some unrelated state change happens by. The sweep therefore runs from two sites — `updateMenuState(_:)` for the whole tree, and the tail of each `menuNeedsUpdate` rebuild for the menu it just rebuilt. Both are outside `validateMenuItem`, which is the constraint that actually matters.

#### The code → keyEquivalent conversion {#chord-conversion}

`chord-format.ts` owns both directions and is the only place either alphabet is spelled:

| `KeyboardEvent.code` | `keyEquivalent` | Note |
|---|---|---|
| `KeyA`…`KeyZ` | lowercase letter | AppKit renders ⇧ from the modifier mask, not from case |
| `Digit0`…`Digit9` | the digit | |
| `Comma` `Period` `Slash` `Semicolon` `Quote` `Backslash` `BracketLeft` `BracketRight` `Backquote` `Minus` `Equal` | the US-layout **unshifted** punctuation character | when the binding carries `shift`, see the row below |
| the same codes **with `shift`** | the US-layout **shifted** character (`Equal`→`+`, `Slash`→`?`, `Minus`→`_`, `Digit1`→`!`, …), and **`shift` is dropped from the modifier mask** | This is R03's ambiguity, resolved: the shipped Zoom In item is `NSMenuItem(keyEquivalent: "+")` with a bare `.command` mask, so a naive `"="` + ⇧⌘ conversion would still *match* at runtime but would render the menu as ⇧⌘= instead of ⌘+. The character carries the shift; the mask must not carry it twice. ⌘= stays a second binding on unshifted `Equal`, matching today's hidden alias item |
| `ArrowUp` `ArrowDown` `ArrowLeft` `ArrowRight` | `NSUpArrowFunctionKey` … | `\u{F700}`–`\u{F703}` |
| `Escape` | `\u{1b}` | |
| `Tab` | `\t` | |
| `Enter` / `NumpadEnter` | `\r` / `\u{3}` | |
| `Delete` / `Backspace` | `\u{F728}` / `\u{8}` | |
| `Home` `End` `PageUp` `PageDown` | `NSHomeFunctionKey` … | |
| `F1`…`F12` | `NSF1FunctionKey` … | |

The conversion is authored in TypeScript and the *result* is pushed (`{ keyEquivalent, command, shift, option, control }`), so Swift performs no conversion at all and builds the modifier mask from four booleans. An unknown code throws in dev and publishes `null` in production, so a bad binding detaches a chord rather than silently mis-assigning one.

#### What the mirror retires on the Swift side {#swift-tier-retirement}

`validateMenuItem` gains a first tier that returns `menuState.commands[id]` when present. What that lets go, in the order the steps remove it:

- The whole `session.` prefix block except the permission-mode radio's `representedObject` read (which becomes a `state` gate) — twelve items.
- The `file.save` / `saveAs` / `saveACopy` / `revertToSaved` / `reloadFromDisk` / `openQuickly` cases — `computeFileMenuGates` moves from a Swift mirror into the entries' `validate` predicates, and stays unit-tested where it is.
- `file.closeCard` / `file.closeAllCardTabs` / `maker.newCardInPane` / the four navigation cases / the two stack cases.
- All twelve `edit.` cases except `edit.undo` / `edit.redo`'s native-token branch, which stays because it reads the web view's live `NSUndoManager` rather than pushed state.
- `file.exportTranscript` / `help.shortcuts` / `edit.copyLastResponse`.

What stays hand-rolled and why: the native-undo branch (live AppKit state, not pushed), and the parameterized families rebuilt in `menuNeedsUpdate` (themes, pane list, recent documents), whose enablement and state marks are written at rebuild time by construction.

#### The defect ledger, mapped to steps {#defect-mapping}

| Brief defect | Fixed in |
|---|---|
| 1 — dead About/Settings pre-ready gating | [#step-1] |
| 2 — View zoom enablement defeated by auto-enable | [#step-1] |
| 3 — ⌘R beeps at stack depth ≤ 1 | [#step-2] |
| 4 — Edit ▸ Delete permanently disabled | [#step-3] |
| 5 — `TugButton` ignores `validateAction` | [#step-4] |
| 6 — context-menu chord labels lie | [#step-5], structurally closed by [#step-21] |
| 7 — Open Recent parent never disabled | [#step-1] |
| 8 — `insert-slash-command` dead-ended, `set-maker-mode` unreachable, seven orphan constants | [#step-9], [#step-16] |
| 9 — Settings has two command paths | [#step-8] |
| 10 — context-menu dimming bypasses the chain | [#step-15] |
| 11 — `tuglaws/menus.md` drift (twelve points) | [#step-23] |
| 12 — theme submenu blocks menu open on a tugbank read | [#step-15] |

---

### Specification {#specification}

**Spec S01: The command registry entry** {#s01-entry-shape}

```ts
/** How a command reaches its implementation. */
export type CommandRouting =
  | "first-responder"   // manager.sendToFirstResponderForContinuation + immediate continuation
  | "key-card"          // manager.sendToKeyCard
  | "target"            // manager.sendToTarget(payload.targetId, …)
  | "registry"          // the handler registered via registerAction
  | "native";           // represented for display/policy only; never routed through JS

export interface CommandEntry {
  /** Canonical wire name: a TUG_ACTIONS value, a control-frame wire, or a
   *  parameterized id of the form `<action>:<value>` ([P05]). */
  readonly id: string;
  /** Display name — menus, keymap UI, palette. The single source for labels. */
  readonly title: string;
  readonly routing: CommandRouting;
  /** The chain action to dispatch. Defaults to `id` when `id` is itself a
   *  TUG_ACTIONS value; required for parameterized ids. */
  readonly action?: TugAction;
  /** Static ActionEvent.value carried by every dispatch of this command. */
  readonly payload?: unknown;
  /** The NSMenuItem identifier this command drives ([P02]). Absent for
   *  chord-only / palette-only commands. */
  readonly menuItemId?: string;
  /** Publish this item's gate in the menuState `commands` block ([P13]).
   *  Per item because the migration is per item: an entry is mirrored in
   *  the same change that deletes its hand-rolled Swift tier, so exactly
   *  one definition of its enablement is ever live. An entry with no
   *  answer of its own must not be mirrored — a default-true gate would
   *  silently light an item its tier was gating. */
  readonly mirrored?: boolean;
  /** Default bindings. A LIST from day one ([P08], brief §G.5.2). */
  readonly bindings?: readonly CommandBinding[];
  /** Validity override. Chain-routed entries default to the chain walk ([P06]). */
  readonly validate?: (chain: CommandValidationSource) => boolean;
  /** Checkmark / radio / toggle projection ([P07]). */
  readonly state?: (chain: CommandValidationSource) => boolean | string | undefined;
  /** Dynamic menu title (Show/Hide Changes, Undo <noun>). */
  readonly dynamicTitle?: (chain: CommandValidationSource) => string | undefined;
  /** Payload set discovered at runtime — excluded from the mirror, the keymap
   *  UI's rebindable rows, and the door-coverage lint ([P05]). */
  readonly parameterized?: boolean;
  /** No door by design: the entry exists so the command is named and visible,
   *  but it has neither a `menuItemId` nor `bindings` and is exempt from the
   *  door-coverage lint. Carries a comment naming what blocks the door. */
  readonly internal?: boolean;
}

export interface CommandValidationSource {
  validateAction(action: string): boolean;
  validateActionInKeyCard(action: string): boolean;
  queryActionState(action: string): boolean | string | undefined;
  queryActionStateInKeyCard(action: string): boolean | string | undefined;
}
```

**Spec S02: Chords and bindings** {#s02-chord-shape}

```ts
/** A chord's identity is code + exact modifier state ([P09]); `label` is display only. */
export interface Chord {
  readonly key: string;      // KeyboardEvent.code
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly label?: string;   // observed event.key at capture; US-authored for defaults
}

/** Where a binding is live ([P08]) — orthogonal to the command's routing. */
export type BindingScope =
  | { readonly kind: "global" }
  | { readonly kind: "responder"; readonly responderId: string }
  | { readonly kind: "mode"; readonly modeId: string };

export interface CommandBinding {
  readonly chord: Chord;
  readonly scope: BindingScope;
  readonly source: "default" | "user";
  /** Suppress the browser default when this chord matches (today's
   *  preventDefaultOnMatch, carried per binding). */
  readonly preventDefault?: boolean;
  /** Eligible to carry the native menu key equivalent. The Swift sweep applies
   *  the first eligible binding; the rest live in the JS funnel only. */
  readonly menuEligible?: boolean;
}

/** What resolveChord answers for one chord ([#step-18], [P15]). */
export type ResolutionLayer =
  /** An NSMenuItem carries this chord — AppKit resolves it before the web
   *  view sees a keydown, so this layer sits above all three JS layers. */
  | { readonly kind: "native"; readonly menuItemId: string;
      /** false → the item validates disabled: the chord is eaten with a
       *  beep and reaches nothing at all ([#constraints]). */
      readonly enabled: boolean;
      /** false → the enclosing menu is hidden without
       *  allowsKeyEquivalentWhenHidden, so the chord falls through to JS. */
      readonly claims: boolean }
  | { readonly kind: "js"; readonly scope: BindingScope };

export interface ChordResolution {
  readonly commandId: string;
  readonly layer: ResolutionLayer;
  readonly active: boolean;
  readonly shadowedBy?: { readonly commandId: string; readonly layer: ResolutionLayer };
}
```

`resolveChord` orders the stack native-first. A native entry with `claims: true` is `active` when `enabled` and shadows every JS entry below it; with `claims: true, enabled: false` it is not `active` and nothing below it is either — the chord is dead in the app, which is the state the pane must name rather than silently attributing to the first JS binding. With `claims: false` it is skipped and the JS layers resolve as [P08] states.

**Spec S03: The `commands` mirror block** {#s03-mirror-block}

```ts
export interface ChordSpec {
  /** Result of codeToKeyEquivalent — Swift applies it verbatim. */
  readonly keyEquivalent: string;
  readonly command?: boolean;
  readonly shift?: boolean;
  readonly option?: boolean;
  readonly control?: boolean;
}

export interface MenuCommandGate {
  readonly enabled: boolean;
  /** Checkmark ([P07]); absent means "no check column participation". */
  readonly state?: boolean;
  /** Dynamic title; absent means "keep the constructed title". */
  readonly title?: string;
  /** `null` detaches the key equivalent; absent means "leave it alone". */
  readonly chord?: ChordSpec | null;
}

// MenuStatePayload gains:
//   commands: Record<string /* NSMenuItem identifier */, MenuCommandGate>
```

**As shipped:** `enabled` is optional (`enabled?: boolean`), not required as declared above. The two halves of a gate move independently — an item's *chord* can be the registry's while its *enablement* is not. View ▸ Zoom In is the case: its predicate reads `window.currentPageZoom`, host state the frontend cannot see, and publishing `enabled: true` for it would light an item its own host tier was gating. So a chord-only gate says nothing about enablement, and an absent `enabled` leaves the item to the tier below (`lib/host-menu-state.ts`, `MenuCommandGate`).

The `chord` field is **three-state**, and all three states are load-bearing: *absent* means "leave the constructed key equivalent alone", *`null`* means "detach it" (how ⌘R clears at stack depth ≤ 1 and how a rebound-away command releases its chord), and *present* means "apply this". Swift's `Codable` collapses absent and null by default, so the decoder must distinguish them explicitly:

```swift
struct CommandGate: Decodable {
    let enabled: Bool
    let state: Bool?
    let title: String?
    /// .absent → leave the item's key equivalent alone
    /// .detach → clear it
    /// .apply  → set it
    enum ChordField { case absent, detach, apply(ChordSpec) }
    let chord: ChordField

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        state = try c.decodeIfPresent(Bool.self, forKey: .state)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        if !c.contains(.chord) {
            chord = .absent
        } else if try c.decodeNil(forKey: .chord) {
            chord = .detach
        } else {
            chord = .apply(try c.decode(ChordSpec.self, forKey: .chord))
        }
    }
}
```

`ChordSpec` carries the four modifier booleans, not a mask; the mask is assembled Swift-side from them so the wire stays readable and no `NSEvent.ModifierFlags` raw value crosses the boundary. Swift consumes the block at two sites:

```swift
// validateMenuItem — the new FIRST tier, ahead of every hand-rolled case.
if let gate = menuState.commands[id] {
    if let title = gate.title { menuItem.title = title }
    if let on = gate.state { menuItem.state = on ? .on : .off }
    return gate.enabled
}

// updateMenuState, and the tail of every menuNeedsUpdate rebuild
// (#swift-key-surface). Never from validateMenuItem.
private func applyCommandChords(in menu: NSMenu? = nil) {
    guard let root = menu ?? NSApp.mainMenu else { return }
    for item in root.items {
        if let id = item.identifier?.rawValue,
           let gate = menuState.commands[id] {
            switch gate.chord {
            case .absent:
                break
            case .detach:
                item.keyEquivalent = ""
                item.keyEquivalentModifierMask = []
            case .apply(let spec):
                item.keyEquivalent = spec.keyEquivalent
                item.keyEquivalentModifierMask = spec.modifierMask
            }
        }
        if let sub = item.submenu { applyCommandChords(in: sub) }
    }
}
```

**Spec S04: The tugbank override format** {#s04-override-format}

- Domain: `dev.tugtool.keymap`. Key: the command id. Value kind: `string`, holding JSON.
- Value: a JSON array of `{ chord: Chord, scope: BindingScope, preventDefault?, menuEligible? }`. `source` is not persisted — a persisted binding is by definition `"user"`.
- Absent key → registry defaults. Empty array → explicitly unbound ([P14]).
- A write naming a command in `NATIVE_LOCKED` is rejected by the store with a dev warning and no persistence ([P12]).
- A malformed value reads as absent, so a corrupt entry degrades to the default rather than stranding a command.

**Spec S05: The `NATIVE_LOCKED` policy list** {#s05-native-locked}

```ts
export const NATIVE_LOCKED: readonly string[] = [
  "hide-application", "hide-others", "show-all", "quit-application", "services",
  "cut", "copy", "paste", "delete", "select-all",
  "minimize", "zoom-window", "toggle-full-screen",
];
```

Read by the keymap UI (renders the row locked, no capture affordance) and by the override store's validator (rejects the write). Changing the policy is an edit to this array and nothing else.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| The command table (`COMMANDS`) | structure — immutable module data | frozen `const` array + derived `Map`; no subscription | [L24] |
| Keymap bindings (defaults + overrides merged) | structure | `keymapRegistry` singleton store + `useSyncExternalStore` for React readers; non-React readers (menu-state publisher, stage 1) call `getSnapshot` directly | [L02], [L24] |
| Keymap overrides in flight (tugbank read/write) | structure | `keymapOverrideStore`, seeded at boot from the `TugbankClient` snapshot, updated by DEFAULTS push with `persist: false` | [L02] |
| `commands` mirror block | outward mirror — no React consumer | `HostMenuStatePublisher` field + microtask-coalesced diffed post; never render state | [L02] (deliberately not a store) |
| Per-responder `queryActionState` answers | local-data, read live at call time | responder node hook reading refs, never closures | [L07] |
| Keymap pane's selected row / search text | local-data | `useState` in the pane | [L02] |
| Chord-capture armed state | local-data + appearance | `useState` for armed/not; the "press a chord" affordance styling is CSS on a data attribute | [L02], [L06] |
| Chord-capture focus containment | structure | `useFocusTrap` pushing a focus mode so the capture surface owns every chord while armed | [L03] |
| Native menu key equivalents | outward mirror with a **second writer** | swept from the push, and re-swept at the tail of every `menuNeedsUpdate` rebuild — the rebuild is the second writer, and the reason the sweep is not single-site ([P15], #swift-key-surface) | [L02] (deliberately not a store) |
| Shadowing display per row | derived — no stored state | computed from `resolveChord` at render, native layer included ([P15]) | — |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/command-registry.ts` | The `COMMANDS` table, `CommandEntry`/`CommandBinding`/`Chord` types, `COMMANDS_BY_ID`, `NATIVE_LOCKED`, lookup helpers ([P01], Spec S01) |
| `tugdeck/src/command-dispatch.ts` | `dispatchCommand`, `validateCommand`, `queryCommandState`, command observers ([P04]) |
| `tugdeck/src/components/tugways/chord-format.ts` | `codeToKeyEquivalent`, `formatChord`, `chordFromEvent`, `chordKey` — the only place either key alphabet is spelled ([P09], #chord-conversion) |
| `tugdeck/src/components/tugways/keymap-registry.ts` | `keymapRegistry` singleton: `matchChord`, `resolveChord` (native layer first), `bindingsFor`, `menuChords`, the collision lint ([P08], [P15], Spec S02) |
| `tugdeck/src/keymap-override-store.ts` | tugbank-backed override store, boot seed, DEFAULTS-push application ([P14], Spec S04) |
| `tugdeck/src/components/tugways/cards/settings-keymap-body.tsx` | Settings ▸ Keyboard pane |
| `tugdeck/src/components/tugways/cards/settings-keymap-body.css` | Its layout |
| `tests/app-test/at0180-command-registry-gates.test.ts` | Menu enablement/state/title driven by the mirror |
| `tests/app-test/at0181-keymap-chord-sweep.test.ts` | Native key equivalents derived from the registry |
| `tests/app-test/at0182-keymap-override.test.ts` | User override round trip, live re-apply, reset |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `queryActionState` | optional node hook | `responder-chain.ts` (`ResponderNode`) | Sibling of `validateAction`; same first-handler-terminates walk ([P07]) |
| `ResponderChainManager.queryActionState` | method | `responder-chain.ts` | Walk from first responder |
| `ResponderChainManager.validateActionInKeyCard` | method | `responder-chain.ts` | Walk from the key card's `card-content` node, matching key-card routing ([P06]) |
| `ResponderChainManager.queryActionStateInKeyCard` | method | `responder-chain.ts` | Same, for state |
| `ResponderChainManager.activeKeybindings` | method (modified) | `responder-chain.ts` | Return `{ scopeId, binding }` pairs so `resolveChord` can attribute scope |
| `computeCommandCapabilities` | function | `lib/host-menu-state.ts` | Generalizes `computeEditCapabilities`; produces the `commands` block (Spec S03) |
| `MenuStatePayload.commands` | field | `lib/host-menu-state.ts` | The mirror block ([P13]) |
| `MenuState.commands` / `MenuState.CommandGate` | struct + field | `AppDelegate.swift` | Decoder for the block |
| `AppDelegate.applyCommandChords()` | method | `AppDelegate.swift` | Recursive chord sweep, called from `updateMenuState` ([P10]) |
| `AppDelegate.validateMenuItem(_:)` | method (modified) | `AppDelegate.swift` | New first tier; hand-rolled tiers deleted as they migrate |
| `registerAction` | function (modified) | `action-dispatch.ts` | Keeps its signature; the handler map becomes the `registry` routing target |
| `dispatchAction` | function (modified) | `action-dispatch.ts` | Forks to `dispatchCommand` for registry commands ([P03]) |
| `KEYBINDINGS` / `matchKeybinding` | removed | `keybinding-map.ts` | Bindings move into command entries; `matchKeybinding` becomes `keymapRegistry.matchChord` |
| `KeyBinding.scope` | renamed | `keybinding-map.ts` | → `routing`, and the activation-context meaning moves to `CommandBinding.scope` ([P08]) |
| `buildTextEditingMenuItems` | function (modified) | `text-editing-menu.ts` | Shortcuts derived ([P11]); disabled state from the chain ([#step-15]) |
| `TugButton` chain validation | modified | `internal/tug-button.tsx` | `chainValidated` consults `validateAction` for real |
| `SettingsTabId` / `TABS` | modified | `cards/settings-card.tsx` | Adds the `keyboard` tab |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/menus.md` — full refresh: correct the `dev`→`session` wire block name, add the six undocumented top-level `menuState` keys plus `commands`, replace the five-tier validation table with the mirror-first model, regenerate the control-frame catalog from the registry, add the chord table, drop `maker.sessionPanel` and `show-dev-panel-toggle`, state the theme-scan source.
- [ ] `tuglaws/action-naming.md` — add the command-registry layer above the three-way classification: a name's classification becomes a consequence of its entry's `routing`.
- [ ] `tuglaws/menus.md` — state the four-layer chord resolution order ([P15]) as doctrine: the native menu resolves before the web view sees a keydown, so menu placement is a chord decision. This is the fact `pdf-view.tsx` currently carries as a local comment.
- [ ] `tuglaws/responder-chain.md` — document `queryActionState` alongside `canHandle` / `validateAction`, and the key-card-scoped validation variants.
- [ ] `tuglaws/focus-language.md` — note the chord-capture focus mode as a sanctioned trap.
- [ ] `tests/app-test/README.md` — the new at0180–at0182 entries and what each pins.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun, tugdeck)** | Pure functions over real data: registry lookups, `resolveChord` shadowing, `codeToKeyEquivalent` round trips, `computeCommandCapabilities` against a real `ResponderChainManager` with real registrations | Every table/resolution/conversion behavior |
| **App-test (real Tug.app)** | The native half — menu enablement, state marks, titles, key equivalents — read through `menuSnapshot` / `menuItemState`, and the override round trip through the real tugbank | Anything crossing the WKScriptMessage boundary |
| **Drift prevention** | A checked-in expectation table asserting each migrated command's routing matches the mechanism the pre-migration code used; a doc-generation test comparing `menus.md`'s catalog against the registry | The behavior-neutral migration, and the docs |

Unit tests construct a **real** `ResponderChainManager` and register real responder nodes, then assert against `validateAction` / `queryActionState` / the computed mirror block. No mock chain, no fake store, no jsdom render assertions — the chain manager is plain TypeScript and runs in bun directly.

#### Pre-existing red, baselined {#known-red}

Two app-test cases fail on `main` with none of this plan's changes applied, verified by running them on the base checkout. They are **not** regressions from any step here, and neither should be read as a checkpoint failure:

- `at0174-edit-menu-validation.test.ts` → *"native input: Undo rides the web view's NSUndoManager, cleared on blur"*. The synthesized ⌘Z does not revert the typed text. The test's own comment already notes that the harness's synthetic chords don't reach AppKit's menu matching the way a real keyboard's do (it says so explicitly for the redo half), so this is most likely the same delivery gap now biting the undo half under background-window key posting. It matters for [#step-14], which uses at0174 as the proof that a retired Swift tier still behaves — that step should expect 3/4 here, or fix the delivery first.
- `at0046-tug-text-editor-first-responder-after-button-click.test.ts` → the *baseline* ⌘A assertion, before the button click the test is actually about.

Both smell like one cause — a synthesized command-modified chord not landing — rather than two. Worth a dedicated look before [#step-19] rewrites the key pipeline, since a broken chord-delivery baseline would make that step's checkpoints unreadable.

#### What stays out of tests {#test-non-goals}

- **The Settings ▸ Keyboard pane's rendering** — covered by the app-test override round trip end to end (write an override, see the native chord move) rather than by DOM-render assertions, which the project bans.
- **Every one of the ~70 migrated commands individually** — the registry's shape is unit-tested once, the routing table is drift-tested wholesale, and the app-tests cover the load-bearing menu families. Enumerating one test per command would be brittle theater.
- **The `code → keyEquivalent` table's unused rows** — the round-trip test covers exactly the codes the registry binds; adding rows for unbound codes tests the table against itself.
- **tugcast data frames** — unchanged by this plan, already covered where they are covered.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Move imperative enablement into the validator | done | `020fab587` |
| #step-2 | Detach ⌘R at stack depth ≤ 1 | done | `e4ab2eb3e` |
| #step-3 | Give Edit ▸ Delete a real handler | done | `12f2804e8` |
| #step-4 | TugButton consults validateAction | done | `56533625b` |
| #step-5 | Correct the lying chord labels | done | `181321d84` |
| #step-6 | The registry table and dispatchCommand | done | `eac1a6375` |
| #step-7 | Convert the Both loops and menu wires | done | `c217a2d77` |
| #step-8 | Converge the Settings dual path; native entries and NATIVE_LOCKED | done | `069b76ddc` |
| #step-9 | Give ids to the store verbs and raw-string dispatches | done | `be37da9b8` |
| #step-10 | Route the direct-call emitters through the funnel | done | `f463d85e5` |
| #step-11 | Integration checkpoint — funnel #1 is behavior-neutral | done | `3c520c817` |
| #step-12 | queryActionState and key-card-scoped validation | done | `783e206f7` |
| #step-13 | The commands mirror block, end to end | done | `648c83117` |
| #step-14 | Populate validate and state; retire the Swift tiers | done | `4849d4e3a` |
| #step-15 | Converge TugButton, the context menus, and the theme push | done | `bbbe29b0f` |
| #step-16 | Promote the chord-only commands to menu items | done | `0abe0d9ee` |
| #step-17 | Give the control-frame-only commands chain identities | done | `1d08545d3` |
| #step-18 | The keymap registry, chord format, and resolveChord | done | `1e682614e` |
| #step-19 | Stage 1 and the static map read the registry | done | `9e8e81e1e` |
| #step-20 | The Swift chord sweep | done | `077a8bcb2` |
| #step-21 | Migrate or classify the raw capture listeners; derive displayed chords | done | `8f638a74b` |
| #step-22 | Keymap overrides in tugbank | done | `351fb59f8` |
| #step-23 | The Settings ▸ Keyboard pane | done | `fdd7a6e15` |
| #step-24 | Refresh tuglaws/menus.md and the cross-references | done | `9f4f95319` |
| #step-25 | Integration checkpoint — the whole arc | done | `1c4c705e7` |

---

#### Step 1: Move imperative enablement into the validator {#step-1}

**Commit:** `tugapp(command-funnel): move About/Settings/zoom/Open Recent gating into validateMenuItem`

**References:** [P13] mirror shape (the tier these become), Risk R01, (#defect-mapping, #constraints)

**Artifacts:**
- `tugapp/Sources/AppDelegate.swift` — new `validateMenuItem` cases; deleted imperative `isEnabled` writes.

**Tasks:**
- [ ] Delete `aboutItem.isEnabled = false` and `settingsItem.isEnabled = false` in `buildMenuBar()`, and the `bridgeFrontendReady` flip that pairs with them. They are no-ops: `autoenablesItems` defaults on, so `validateMenuItem`'s `default: return true` overrides any stored `isEnabled`.
- [ ] Add a `frontendReady` stored property on `AppDelegate`, set true by the existing `bridgeFrontendReady` path, and add `case "app.about", "app.settings": return frontendReady` to `validateMenuItem`.
- [ ] Delete the four `isEnabled` computations in `rebuildViewMenu(_:)` (`view.actualSize`, `view.zoomIn`, `view.zoomInAlias`, `view.zoomOut`) and move the same predicates — `menuState.document != nil || <pageZoom bound check>` — into `validateMenuItem` cases. The `epsilon` tolerance and the `documentZooms` escape hatch move verbatim; `window.currentPageZoom` is a synchronous property read, so it is safe inside the validator.
- [ ] Add `case "file.openRecent": return !menuState.recentDocuments.isEmpty`, delivering what the builder comment already claims.
- [ ] Remove the now-false comment at the top of `rebuildViewMenu` describing zoom enablement as "the pull-validation exception".

**Tests:**
- [ ] `at0168-menu-structure.test.ts` — extend to assert `menuItemState("view.zoomIn").enabled` is true at default page zoom and that `view.actualSize` is disabled there (it is already at 100%).
- [ ] `at0168` — assert `menuItemState("file.openRecent").enabled` is false on a deck with no recents.

**Checkpoint:**
- [ ] `just build-app`
- [ ] `just app-test at0167-file-menu-close-validation.test.ts at0168-menu-structure.test.ts at0169-menu-deck-validation.test.ts`

---

#### Step 2: Detach ⌘R at stack depth ≤ 1 {#step-2}

**Depends on:** #step-1

**Commit:** `tugapp(command-funnel): detach the stack chord when the stack has nowhere to go`

**References:** [P10] chords via push (this is its precedent), (#swift-key-surface, #constraints)

**Artifacts:**
- `tugapp/Sources/AppDelegate.swift` — `applyStackChordKeyEquivalent()` gains the depth gate.

**Tasks:**
- [ ] In `applyStackChordKeyEquivalent()`, return early with both items' `keyEquivalent` cleared when `menuState.stackDepth <= 1`. Both `window.cycleStack` and `window.revealStack` already validate disabled at that depth, and a chord on a disabled item is eaten at the menu bar with a beep rather than falling through — so the item must lose the chord, not just the enablement.
- [ ] Confirm the call site remains `updateMenuState(_:)` only; the depth gate must not migrate into `validateMenuItem`, where key-equivalent mutation is banned.
- [ ] Update the method's doc comment to state both conditions it now encodes (which item owns the chord, and whether anyone does).

**Tests:**
- [ ] New assertions in `at0169-menu-deck-validation.test.ts`: at a single-pane deck, `menuItemState("window.cycleStack").keyEquivalent === ""` and the same for `window.revealStack`; after creating a second pane in the same slot, the preference-owning item carries `"r"`.

**Checkpoint:**
- [ ] `just build-app`
- [ ] `just app-test at0169-menu-deck-validation.test.ts`

---

#### Step 3: Give Edit ▸ Delete a real handler {#step-3}

**Depends on:** #step-1

**Commit:** `tugways(command-funnel): register a delete handler so Edit ▸ Delete stops being permanently dark`

**References:** [P06] validation split, (#defect-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-text-editor.tsx` and `tug-text-card-editor.tsx` — `TUG_ACTIONS.DELETE` handlers and `validateAction` branches.
- The native-text-input responder (`use-text-input-responder`) — the same.

**Tasks:**
- [ ] Register `TUG_ACTIONS.DELETE` on the editing surfaces that already register `CUT`: delete the current selection, no-op on a collapsed selection. Route through the substrate each surface already uses for cut — `document.execCommand("delete")` for native controls so the WKWebView's `NSUndoManager` records it, CM6's own transaction for the editor.
- [ ] Add `DELETE` to each surface's `validateAction` branch, answering `hasSelection && !readOnly`.
- [ ] Confirm `computeEditCapabilities`'s existing `delete: chain.validateAction(TUG_ACTIONS.DELETE)` now returns true with a selection — the mirror field already exists and has simply never had a handler to find.
- [ ] Remove the "no responder currently registers a handler" note from the `SELECT_NONE` neighborhood in `action-vocabulary.ts` only if it names `DELETE`; leave `SELECT_NONE`'s own note alone.

**Tests:**
- [ ] Unit (`tugdeck`): build a real `ResponderChainManager`, register a node with the new `DELETE` handler and `validateAction`, assert `computeEditCapabilities(manager).delete` follows the selection predicate.
- [ ] `at0174-edit-menu-validation.test.ts` — assert `menuItemState("edit.delete").enabled` is false with a collapsed caret and true with a selection in the prompt editor.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test at0174-edit-menu-validation.test.ts`

---

#### Step 4: TugButton consults validateAction {#step-4}

**Depends on:** #step-3

**Commit:** `tugways(command-funnel): TugButton validates against the chain instead of aliasing can-handle`

**References:** [P06] validation split, (#defect-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/internal/tug-button.tsx` — real `chainValidated`.

**Tasks:**
- [ ] Add `ResponderChainManager.validateActionAtNode(nodeId, action)` — the per-node analogue of `nodeCanHandle`, calling the node's `validateAction` when it handles the action and returning `false` when it does not. The button validates against its dispatch target, not the first responder, so the existing first-responder `validateAction` walk is the wrong query.
- [ ] Replace `const chainValidated = chainCanHandle` with a call to it, keyed on `effectiveValidationTarget`.
- [ ] Sweep for buttons that would newly dim: any `TugButton` whose target registers a `validateAction` covering its action. Because only three responders supply `validateAction` today, the blast radius is small and knowable — check the two text editors and `DeckCanvas`.
- [ ] Leave the doc comment at the top of the validation block; it already describes the now-true behavior.

**Tests:**
- [ ] Unit: real manager, a node registering an action with `validateAction: () => false`, a `TugButton`-shaped query asserting `validateActionAtNode` returns false while `nodeCanHandle` returns true.
- [ ] `at0179-dynamic-keybinding.test.ts` and the gallery chain-actions coverage — confirm no button silently went dark.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 5: Correct the lying chord labels {#step-5}

**Depends on:** #step-4

**Commit:** `tugways(command-funnel): fix the context-menu shortcut hints that named the wrong chords`

**References:** [P11] displayed chords, (#defect-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/text-editing-menu.ts` — corrected shortcut strings.

**Tasks:**
- [ ] Change Copy as Plain Text's hint from `⇧⌘C` to `⌥⇧⌘C` (the real chord; `⇧⌘C` is Session ▸ Show Changes) and Paste as Plain Text's from `⇧⌘V` to `⌥⇧⌘V`, matching the Swift Edit menu's `[.command, .shift, .option]` masks and the `KEYBINDINGS` entries.
- [ ] Add a comment at the top of `buildTextEditingMenuItems` noting these strings are authored and will be derived from the keymap registry, citing this plan's [#step-21]. (The comment states the fact, not a narrative.)
- [ ] Delete the stale comment in `AppDelegate.swift` claiming that clearing ⇧⌘S "lets it fall through to the web view's Shell-route chord" — no such JS binding exists.

**Tests:**
- [ ] Unit: assert the built entries' `shortcut` values against a checked-in expectation, so the next drift fails a test rather than a user.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just build-app`

---

#### Step 6: The registry table and dispatchCommand {#step-6}

**Depends on:** #step-5

**Commit:** `tugways(command-funnel): introduce the command registry and dispatchCommand`

**References:** [P01] registry home, [P03] command vs data, [P04] routing as data, [P05] parameterization, Spec S01, (#funnel-shape)

**Artifacts:**
- `tugdeck/src/components/tugways/command-registry.ts` (new) — types, an initially small `COMMANDS` array, `COMMANDS_BY_ID`, helpers.
- `tugdeck/src/command-dispatch.ts` (new) — `dispatchCommand`, `validateCommand`, `queryCommandState`, observers.
- `tugdeck/src/action-dispatch.ts` — `dispatchAction` forks; `getRegistryHandler` exported.

**Tasks:**
- [ ] Write `command-registry.ts` per Spec S01 with the full type surface and a starter table holding a handful of representative entries (one per routing value) so the types are exercised: `close` (first-responder), `interrupt-session` (key-card), `close-pane` (target), `open-quickly` (registry), `quit-application` (native).
- [ ] Add `COMMANDS_BY_ID`, `commandsByMenuItemId`, and a module-load assertion that ids are unique and that every non-parameterized entry either names a `menuItemId` or declares `bindings` (the door-coverage lint; entries that legitimately have neither declare `internal: true`).
- [ ] Write `command-dispatch.ts` per [#funnel-shape]. `first-responder` uses `sendToFirstResponderForContinuation` and invokes the continuation immediately — the semantics the existing menu-command adapter loop documents and depends on. `native` dev-warns and returns unhandled.
- [ ] Export `getRegistryHandler(id)` from `action-dispatch.ts` so `dispatchCommand` can reach the `registry` routing target without importing the whole init function.
- [ ] Fork `dispatchAction`: registry commands go to `dispatchCommand`; everything else keeps the existing handler-map path and the existing unknown-action warning ([P03]).

**Tests:**
- [ ] Unit: table invariants (unique ids, `action` resolvable for every parameterized id, `menuItemId` uniqueness).
- [ ] Unit: `dispatchCommand` against a real `ResponderChainManager` with real registered nodes — one assertion per routing value, including that a `first-responder` command's continuation runs.
- [ ] Unit: `dispatchAction` with a data-frame payload still reaches its `registerAction` handler.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 7: Convert the Both loops and menu wires {#step-7}

**Depends on:** #step-6

**Commit:** `tugways(command-funnel): convert the Both re-dispatch loops and menu wires to registry entries`

**References:** [P04] routing as data, [P05] parameterization, Risk R01, (#current-entry-points)

**Artifacts:**
- `command-registry.ts` — the bulk of the table.
- `action-dispatch.ts` — the three re-dispatch loops deleted.

**Tasks:**
- [ ] Walk `action-dispatch.ts` top to bottom and write one entry per command-shaped `registerAction`, transcribing routing from the call site verbatim — not inferring it. The four loops map directly: the save-verb, zoom, and continuation groups all become `routing: "first-responder"`; the `sendToKeyCard` group becomes `routing: "key-card"`.
- [ ] Delete the four loops and the individual trivial adapters they replace (`show-component-gallery`, `focus-lens`, `reveal-stack`, `cycle-stack`, `close`, `close-all`, `add-card-to-active-pane`, the save family, the zoom family).
- [ ] Keep as `routing: "registry"` the wires with real bodies: `new-text-card`, `open-quickly`, `open-file`, `open-diff`, `clear-recent-documents`, `next-theme`, `set-theme`, `show-card`, `arrange-cards`, `focus-pane`, `setup`, `logout`, `source-tree`, `toggle-lens`, `set-imposition`, `set-imposition-lens`, `assign-slot`, `focus-session-card`, `reload`.
- [ ] Expand the twenty `run-card-command` bridges into twenty entries per [P05], each `routing: "key-card"`, `action: TUG_ACTIONS.RUN_SLASH_COMMAND`, `payload: { name, args }`, and each naming its existing menu identifier (`session.rewind`, `session.compact`, `edit.copyLastResponse`, …). The `run-card-command` wire itself stays registered for the Swift selector, and its handler resolves the incoming `name` to the entry.
- [ ] Expand `set-permission-mode` into four entries and `move-to-slot` into nine, per [P05].
- [ ] Mark `set-theme`, `focus-pane`, and `assign-slot` `parameterized: true`.
- [ ] Write the drift-prevention expectation table: for every converted id, the mechanism the pre-migration code used. Check it in with the step.

**Tests:**
- [ ] Unit: the drift table — every entry's `routing` matches its recorded pre-migration mechanism.
- [ ] Unit: every wire named in `AppDelegate.swift`'s `sendControl(` calls resolves to a registry entry or a data-frame handler. (The wire list is checked in as a fixture derived from the Swift source; the test asserts the registry covers it.)

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test at0167-file-menu-close-validation.test.ts at0168-menu-structure.test.ts at0169-menu-deck-validation.test.ts at0171-session-menu-card-type.test.ts at0172-session-menu-live-state.test.ts at0173-settings-shortcut.test.ts at0174-edit-menu-validation.test.ts`

---

#### Step 8: Converge the Settings dual path; native entries and NATIVE_LOCKED {#step-8}

**Depends on:** #step-7

**Commit:** `tugways(command-funnel): one Settings command, plus native entries and the locked-policy list`

**References:** [P04] routing as data, [P12] native locked, Spec S05, (#defect-mapping)

**Artifacts:**
- `command-registry.ts` — the native rows and `NATIVE_LOCKED`.
- `AppDelegate.swift` — `showSettings(_:)` sends the chain wire.

**Tasks:**
- [ ] Collapse the Settings dual path: today the Swift item sends `show-card {component: "settings"}` while the chain has its own `show-settings`. Make the Swift selector send `show-settings`, register it as one `routing: "first-responder"` entry whose handler is DeckCanvas's existing `SHOW_SETTINGS` responder, and confirm that handler opens the singleton card the same way `showSingletonCard("settings")` does. `show-card` stays for `about` and `dev`.
- [ ] Add `routing: "native"` entries for Hide, Hide Others, Show All, Quit, Services, Minimize, Zoom, Enter Full Screen, and the five `NSText` re-dispatch verbs, each with its menu identifier and its chord as a default binding — represented so the keymap UI can show them, never routed through JS.
- [ ] Add `NATIVE_LOCKED` per Spec S05 with a comment stating it is policy, not mechanism.
- [ ] Add `isCommandLocked(id)` reading the list.

**Tests:**
- [ ] `at0173-settings-shortcut.test.ts` — still green, now through the single path; add an assertion that only one Settings card exists after two ⌘, presses.
- [ ] Unit: `isCommandLocked` over the list; every id in `NATIVE_LOCKED` resolves to a real entry.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just build-app && just app-test at0173-settings-shortcut.test.ts at0168-menu-structure.test.ts`

---

#### Step 9: Give ids to the store verbs and raw-string dispatches {#step-9}

**Depends on:** #step-8

**Commit:** `tugways(command-funnel): name the commands that had no name`

**References:** [P05] parameterization, (#current-entry-points, #defect-mapping)

**Artifacts:**
- `action-vocabulary.ts` — new constants for the promoted verbs.
- `command-registry.ts` — their entries.

**Tasks:**
- [ ] Add `TUG_ACTIONS` constants and entries for the deck-manager verbs the audit found with no action name: `center-pane` (`DeckManager.centerPane`), `pin-lens` (`pinLens`), `show-lens-pane` / `hide-lens-pane` (the explicit forms behind today's toggle-only exposure), and `move-pane` (drag-only today).
- [ ] Add entries for the commit-mode verbs `exit-commit-mode` and `land-commit` from `lib/commit-mode-controller.ts`; only `enter` has doors today (the ⇧⌘P route select and `/commit`).
- [ ] Add entries for the PDF document verbs that have handlers and context-menu doors but no menu items: `zoom-to-fit` (two entries per [P05] — width and page) and `set-page-mode` (three entries — continuous, single, two).
- [ ] Resolve the orphan constants: `RESET_LAYOUT` gets an entry routed to `DeckManager.arrangeCards`; `MINIMIZE` / `MAXIMIZE` become `routing: "native"` aliases of the Window items; `SELECT_NONE` gets an Edit ▸ Deselect All entry with a handler on the editing surfaces; `FOCUS_NEXT` / `FOCUS_PREVIOUS` and `REOPEN_TAB` get entries marked `internal: true` with a comment naming what blocks them (the provider's focus-walk owns ⇥/⇧⇥; closed-tab history does not exist).
- [ ] Delete `set-maker-mode`'s registration — it is a door with no sender anywhere, and the maker gate actually flows through the reverse `setMakerMode` WebKit bridge.
- [ ] Resolve `INSERT_SLASH_COMMAND`: it has a handler in `session-card.tsx` and a doc comment claiming ⌃⌘ chords dispatch it, but no keybinding, no menu item, and no registration. Either give it an entry with real bindings or delete the handler and the claim. Decide at implementation time; the plan requires only that the dead end is closed.

**Tests:**
- [ ] Unit: the door-coverage lint from [#step-6] now passes over the whole table — every non-parameterized, non-internal entry has a `menuItemId` or `bindings`.
- [ ] Unit: no `TUG_ACTIONS` value lacks either a registry entry or an explicit exclusion (the form-control currency listed in [#non-goals], encoded as a checked-in exclusion set).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 10: Route the direct-call emitters through the funnel {#step-10}

**Depends on:** #step-9

**Commit:** `tugways(command-funnel): route the direct store-method callers through dispatchCommand`

**References:** [P04] routing as data, (#current-entry-points)

**Artifacts:**
- `session-card.tsx`, the setup wizard, the Lens sections, the changeset pop-out — call sites converted.

**Tasks:**
- [ ] Convert the session-interrupt duality: the submit button and the setup wizard call `codeSessionStore.interrupt()` directly, in parallel with the `INTERRUPT_SESSION` chain path. Route both through `dispatchCommand("interrupt-session")` so one semantic has one call path.
- [ ] Convert the raw-string `dispatchAction` sites (`set-imposition`, `set-imposition-lens`, `assign-slot`, `focus-session-card`, `open-diff`) to `dispatchCommand` with the same payloads.
- [ ] Convert the deck-manager verb call sites promoted in [#step-9] where a user gesture drives them; leave internal programmatic calls on the store methods (a command is a user intent, not an internal mutation).
- [ ] Add a dev-only `dispatchAction` warning when a caller passes an action that has a registry entry — the remaining raw-string callers surface themselves.

**Tests:**
- [ ] Unit: `dispatchCommand("interrupt-session")` reaches the session card's registered handler on a real chain with a real registration.
- [ ] Existing session app-tests covering interrupt (`at0172-session-menu-live-state.test.ts` and the Stop coverage) stay green.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 11: Integration checkpoint — funnel #1 is behavior-neutral {#step-11}

**Depends on:** #step-6, #step-7, #step-8, #step-9, #step-10

**Commit:** `N/A (verification only)`

**References:** Risk R01, (#success-criteria, #funnel-shape)

**Tasks:**
- [ ] Read `action-dispatch.ts` end to end and confirm it contains the tugcast data-frame handlers, the `registry`-routed command bodies, and exactly one fork — no command-specific routing.
- [ ] Confirm every `sendControl(` wire in `AppDelegate.swift` resolves in the registry or the data map.
- [ ] Confirm no user-visible behavior changed in this milestone: same routing, same handlers, one front door.

**Tests:**
- [ ] The full at0167–at0179 menu and keybinding family.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just build-app`
- [ ] `just app-test at0167-file-menu-close-validation.test.ts at0168-menu-structure.test.ts at0169-menu-deck-validation.test.ts at0170-maker-mode-gate.test.ts at0171-session-menu-card-type.test.ts at0172-session-menu-live-state.test.ts at0173-settings-shortcut.test.ts at0174-edit-menu-validation.test.ts at0177-permission-cycle-keys.test.ts at0179-dynamic-keybinding.test.ts`

---

#### Step 12: queryActionState and key-card-scoped validation {#step-12}

**Depends on:** #step-11

**Commit:** `tugways(command-funnel): add queryActionState and key-card-scoped validation to the chain`

**References:** [P06] validation split, [P07] state hook, (#state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/responder-chain.ts` — the new hook and methods.
- `tuglaws/responder-chain.md` — documented.

**Tasks:**
- [ ] Add `queryActionState?: (action: TugAction) => boolean | string | undefined` to `ResponderNode`, and `ResponderChainManager.queryActionState(action)` walking exactly like `validateAction`: the first node that handles terminates the walk and answers `node.queryActionState?.(action)`; no handler anywhere answers `undefined`.
- [ ] Add `validateActionInKeyCard(action)` and `queryActionStateInKeyCard(action)`, walking from `findKeyCardContentId()` instead of the first responder so a `key-card`-routed command validates from the node it would dispatch to. Answer `false` / `undefined` when there is no key card.
- [ ] Add `validateActionAtNode(nodeId, action)` if [#step-4] did not already.
- [ ] Confirm all four are covered by the existing `validationVersion` bump — they read the same node registry, so `manager.subscribe` already fires on focus / register / unregister.
- [ ] Document the hook in `tuglaws/responder-chain.md` next to `canHandle` and `validateAction`, stating that state is display data and validity is enablement, and that neither is consulted during dispatch.

**Tests:**
- [ ] Unit: real manager, a node registering `queryActionState` — first-handler-terminates, `undefined` for unhandled, string and boolean returns both survive.
- [ ] Unit: key-card variants against a real card-content registration; `false`/`undefined` with no key card.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`

---

#### Step 13: The commands mirror block, end to end {#step-13}

**Depends on:** #step-12

**Commit:** `tugways(command-funnel): publish a per-command menu gate block and read it in the Swift validator`

**References:** [P02] identifier join, [P07] state hook, [P13] mirror shape, Spec S03, Risk R02, Risk R04, (#swift-tier-retirement)

**Artifacts:**
- `lib/host-menu-state.ts` — `computeCommandCapabilities`, `MenuStatePayload.commands`, publisher field.
- `responder-chain-provider.tsx` — publishes the block alongside the edit caps.
- `AppDelegate.swift` — `MenuState.commands` decode, the new first tier in `validateMenuItem`.

**Tasks:**
- [ ] Write `computeCommandCapabilities(chain)`: for every non-parameterized entry with a `menuItemId`, compute `enabled` ([P06]: `validate` if present, else the routing-matched chain walk), `state` (from `state` or `queryActionState`, narrowed to boolean), and `title` (from `dynamicTitle`). Return the `Record<menuItemId, MenuCommandGate>`.
- [ ] Add `commands` to `MenuStatePayload` and a `setCommandCapabilities` setter on `HostMenuStatePublisher`, joining the existing microtask-coalesced diffed flush.
- [ ] In `responder-chain-provider.tsx`, publish the block from the same `publishEditCaps` closure (rename it to reflect both) so both mirrors share one recompute, one `manager.subscribe`, and the existing `registerEditCapsRefresher` escape hatch. Generalize the refresher's name to match ([P07], Risk R02). Keep the undo plugin's availability/label gate exactly as it is — the closure's work is what grows here, not its trigger set (Risk R04).
- [x] Measure the recompute before and after, with the block empty and with it populated, using the synthetic typist (`AT9996_TYPIST=1`) and the deck probes. Record the numbers in the step; if the keystroke-reachable path regresses, split the recompute per Risk R04 before [#step-14] populates 60–80 predicates on top of it. **Measured on the dash:** 0.21 µs/call before, 0.40 µs/call with the block empty; 0.20 µs/call edit-only, 5.20 µs/call with all 54 predicates populated — against a ~9 ms q50 keystroke budget, so the Risk R04 split fallback was not needed.
- [ ] Add `MenuState.CommandGate` and `MenuState.commands` to the Swift decoder, defensively per the struct's existing discipline: a missing block reads as empty, so items fall through to the hand-rolled tiers unchanged.
- [ ] Add the first tier to `validateMenuItem` per Spec S03, ahead of the `session.` prefix block. With the block empty (cold start) every item still reaches its existing tier, which is what makes this step non-breaking on its own.
- [ ] Add a harness-facing assertion path: every `menuItemId` in the table resolves to a real menu item (`menuItemState(id).found`), so [P02]'s hand-maintained join is machine-checked.

**Tests:**
- [ ] Unit: `computeCommandCapabilities` over a real chain with real registrations — an entry with a chain-routed action reflects `validateAction`; a `key-card` entry reflects the key-card walk; a `validate`-carrying registry entry reflects its predicate.
- [ ] New `tests/app-test/at0180-command-registry-gates.test.ts` (`@covers` the registry, `lib/host-menu-state.ts`, `AppDelegate.swift`): assert every `menuItemId` in the pushed block is `found` in `menuSnapshot`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just build-app && just app-test at0180-command-registry-gates.test.ts at0168-menu-structure.test.ts`
- [x] The Risk R04 measurement, recorded in the step: recompute cost with the block empty vs. populated, and the typist q50/q99 either side. Recorded in the measurement task above: 0.21 → 0.40 µs/call empty, 0.20 µs/call edit-only vs 5.20 µs/call with all 54 predicates, well inside the ~9 ms q50 keystroke budget.

---

#### Step 14: Populate validate and state; retire the Swift tiers {#step-14}

**Depends on:** #step-13

**Commit:** `tugways(command-funnel): move menu enablement into registry predicates and delete the hand-rolled tiers`

**References:** [P06] validation split, [P07] state hook, [P13] mirror shape, Risk R02, (#swift-tier-retirement)

**Artifacts:**
- Responder `validateAction` branches on `session-card.tsx`, `tug-pane.tsx`, `deck-canvas.tsx`.
- `command-registry.ts` — predicates for the registry-routed entries.
- `AppDelegate.swift` — the deleted tiers.

**Tasks:**
- [ ] Add `validateAction` branches per the audit's handler map: `session-card.tsx`'s card-content responder answers for `interrupt-session` (`canInterrupt`), the turn-navigation four (`hasTurns` plus position), and the two `toggle-*-view` (bound session); `tug-pane.tsx` answers for `close-tab` and tab-navigation arity; `deck-canvas.tsx` extends its existing allowlist for the slot and lens commands. Every predicate reads refs at call time, never captured closures ([L07]).
- [ ] Add `queryActionState` branches for the stateful commands: the four `set-permission-mode:*` entries (current mode), the two `select-composer-route:*` entries (current route), `toggle-changes-view` / `toggle-history-view` (visible?), `toggle-lens` (rail visible?).
- [ ] Add `dynamicTitle` for the Show/Hide Changes and Show/Hide History items, and for Undo/Redo's noun labels, sourced from the existing `editUndoLabelsWithin` registry.
- [ ] Add `validate` predicates to the registry-routed entries: the File save family (move `computeFileMenuGates` into them — it stays a pure exported function and keeps its unit tests), `open-quickly`, `next-theme` / `set-theme` (themes present), `clear-recent-documents` (recents non-empty). **Struck as shipped:** the `next-theme` / `set-theme` "themes present" predicate and the `clear-recent-documents` "recents non-empty" predicate were not implemented — the shipped theme list is always present, so that predicate is vacuous, and the Open Recent parent already dims over an empty recents list (step 1), so the child predicate adds nothing.
- [ ] Delete the Swift tiers listed in [#swift-tier-retirement], one family per commit-sized chunk if convenient, verifying the corresponding app-test after each. Keep the native-undo branch and the parameterized families.
- [ ] Where a predicate reads a store the chain cannot see, subscribe the mirror's refresher to that store — the same wiring `initHostMenuState` already does for `cardSessionBindingStore` and `cardTitleStore` (Risk R02).

**Tests:**
- [ ] Unit: `computeFileMenuGates` tests move with it, unchanged.
- [ ] Unit: the mirror block's `enabled` for each migrated identifier against a real chain in each relevant state.
- [ ] `at0171`, `at0172`, `at0174`, `at0167`, `at0169` — the existing per-tier app-tests are the retirement's proof; every one must stay green with the Swift tier deleted.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just build-app`
- [ ] `just app-test at0167-file-menu-close-validation.test.ts at0169-menu-deck-validation.test.ts at0171-session-menu-card-type.test.ts at0172-session-menu-live-state.test.ts at0174-edit-menu-validation.test.ts at0180-command-registry-gates.test.ts`

---

#### Step 15: Converge TugButton, the context menus, and the theme push {#step-15}

**Depends on:** #step-14

**Commit:** `tugways(command-funnel): one validity definition for menus, buttons, and context menus`

**References:** [P06] validation split, [P07] state hook, (#defect-mapping)

**Artifacts:**
- `text-editing-menu.ts` — dimming from the chain.
- `internal/tug-button.tsx` — registry-aware validation.
- The theme store / `lib/host-menu-state.ts` / `AppDelegate.swift` — theme name pushed.

**Tasks:**
- [ ] Rewrite `buildTextEditingMenuItems` to take a validity source rather than `{hasSelection, canEdit}`: each entry's `disabled` becomes `!validateCommand(entry)`. The two independent sources for the same six items collapse to one (defect 10). Keep the caller's ability to pass an explicit source so the sampled-at-menu-open-time semantics of the annotation copies are preserved.
- [ ] Make `TugButton` consult `validateCommand` when its `action` names a registry entry, falling back to `validateActionAtNode` otherwise — so a button and a menu item for the same command can never disagree.
- [ ] Push the current theme name: add it to the menuState payload (from the theme store the `next-theme` handler already reads through `themeGetterRef`), and change the Swift theme submenu's `menuNeedsUpdate` to read `menuState` instead of calling `ProcessManager.readTugbank` on every open. That retires the per-open tugbank read and its subprocess fallback, which can block the menu open (defect 12).
- [ ] Keep the filesystem theme scan — the submenu's *membership* is discovered from disk and is genuinely dynamic; only the *checkmark* moves to the push.

**Tests:**
- [ ] Unit: the context-menu entries' `disabled` values track a real chain's validity across a focus change.
- [ ] `at0174-edit-menu-validation.test.ts` — extend to assert the native Edit menu and the web context menu agree on Cut/Copy/Paste enablement in the same state.
- [ ] App-test: switching theme from the web side updates the Theme submenu's checkmark without a tugbank read (assert via `menuSnapshot` state values after a `next-theme` dispatch).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just build-app && just app-test at0174-edit-menu-validation.test.ts at0168-menu-structure.test.ts`

---

#### Step 16: Promote the chord-only commands to menu items {#step-16}

**Depends on:** #step-15

**Commit:** `tugapp(command-funnel): give the chord-only commands menu doors`

**References:** [Q02] menu placement, [P02] identifier join, [P15] native layer, (#defect-mapping)

**Artifacts:**
- `AppDelegate.swift` — new menu items with identifiers.
- `command-registry.ts` — `menuItemId` filled in on the promoted entries.

**Promotion is not free, and this step is where the cost is paid.** Giving a chord-only command a menu item moves its chord out of the JS funnel and into AppKit's key-equivalent scan, which runs before the web view sees a `keydown` at all ([P15]). Three consequences follow for every row promoted:

1. The chord stops being scoped. ⌘1–⌘9 is a stage-1 binding today, shadowable by any responder that wants those digits; as Window-menu items it is claimed globally and unconditionally, including inside every text surface. `pdf-view.tsx` already declines ⌘1–⌘3 by hand for exactly this reason, and that hand-reasoning becomes wrong in the other direction once the item exists.
2. A promoted command with no validity predicate is *always* enabled, so its chord is always eaten. Every promoted row must carry a `validate`.
3. A promoted command that validates disabled **beeps** — it does not fall through ([#constraints]). So every promoted row whose chord should still reach JS when the command is inapplicable must publish a `null` chord in that state, not merely a disabled item.

So each row below is a judgment about the chord, not just about menu real estate, and [Q02]'s per-row strike list is where a row that fails these three is struck.

**Tasks:**
- [ ] Add Session-menu items for the transcript navigation group (`previous-turn`, `next-turn`, `first-turn`, `last-turn`), the command picker (`open-command-picker`), the composer route select (`select-composer-route:prompt`, `select-composer-route:changes` — Changes already has an item via the toggle, so decide between converging or keeping both), and `cycle-focus-mode`.
- [ ] Add a Maker-menu (or Help-menu) item for `show-devtools` (⌥⌘/).
- [ ] Add Window-menu slot items for `move-to-slot:1` … `move-to-slot:9`. This is the row the promotion cost bites hardest: nine digit chords leave the JS funnel at once. Either carry a `validate` that is false (and a `null` chord) whenever the focused surface wants its digits, or strike the row and leave the nine as chord-only entries the keymap UI can still show.
- [ ] Stamp each with a namespaced identifier following the existing convention, and fill in the matching `menuItemId` in the registry so the mirror gates them for free.
- [ ] Give every promoted row a `validate` predicate and decide its disabled-state chord: `null` (falls through to JS) or attached (beeps). Record the choice per row — an attached chord on a disabled item is a deliberate "nothing else may have this", not a default.
- [ ] Run the [P15] collision lint after each promotion; a promoted chord that collides with a scoped binding is struck or rescoped, never landed.
- [ ] Strike any row from this list per [Q02] without touching another step.

**Tests:**
- [ ] `at0168-menu-structure.test.ts` — assert the new items exist with their identifiers and chords.
- [ ] `at0180` — assert each new item's enablement follows its registry predicate (e.g. turn navigation disabled with no turns).
- [ ] `at0181` — for each promoted row whose disabled state should fall through, assert `keyEquivalent === ""` in that state (the [#step-2] ⌘R assertion generalized).

**Checkpoint:**
- [ ] `just build-app`
- [ ] `just app-test at0168-menu-structure.test.ts at0180-command-registry-gates.test.ts at0172-session-menu-live-state.test.ts`

---

#### Step 17: Give the control-frame-only commands chain identities {#step-17}

**Depends on:** #step-16

**Commit:** `tugways(command-funnel): make the menu-only commands reachable in browser dev and visible to validation`

**References:** [P04] routing as data, [P06] validation split, (#current-entry-points)

**Artifacts:**
- `command-registry.ts` — routing changes.
- DeckCanvas or the relevant responder — new chain handlers.

**Tasks:**
- [ ] For each control-frame-only command that has a natural chain owner, move the body onto a responder and change the entry's routing to `first-responder`: `new-text-card`, `open-quickly`, `open-file`, `clear-recent-documents`, `arrange-cards`, `focus-pane`, `source-tree`. Each becomes reachable in `bunx vite` dev and visible to the chain's validation machinery, for free.
- [ ] Leave as `registry` the ones with no chain owner: `setup`, `logout`, `reload`, `set-theme`, `next-theme`, `show-card` — app-level singletons with no responder to ask.
- [ ] Add browser-dev bindings where the audit found a menu-only chord with no JS twin (⌘N, ⌥⌘N, ⌘O, ⇧⌘O, ⇧⌘S, ⌘0/+/−, ⌥⌘T, ⌃⌥C, ⌃⌥T, ⌘R, ⇧⌘R, ⌥⌘G, ⌥⇧⌘N). Under [#step-19] these become automatic — the JS twin is a consequence of the shared table — so this task is a verification that each promoted command's bindings are present, not a hand-authored parallel map.

**Tests:**
- [ ] Unit: each moved command dispatches to its new responder on a real chain.
- [ ] `at0168` / `at0169` — unchanged native behavior for the moved commands.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 18: The keymap registry, chord format, and resolveChord {#step-18}

**Depends on:** #step-17

**Commit:** `tugways(command-funnel): the keymap registry with full shadowing resolution`

**References:** [P08] routing vs scope, [P09] chord identity, Spec S02, Risk R03, (#funnel-shape, #chord-conversion)

**Artifacts:**
- `chord-format.ts` (new), `keymap-registry.ts` (new).
- `responder-chain.ts` — `activeKeybindings` returns scope-attributed pairs.

**Tasks:**
- [ ] Write `chord-format.ts`: `chordKey` (the O(1) lookup identity, moved from `keybinding-map.ts`), `chordMatchesEvent` (the existing exact-modifier rule, moved), `chordFromEvent`, `codeToKeyEquivalent` per [#chord-conversion] (throwing in dev on an untabled code), and `formatChord` producing the display string from modifiers plus label.
- [ ] Write `keymap-registry.ts`: a subscribable singleton holding the merged default+override binding lists, a precompiled chord index for the global layer, and the four public reads (`matchChord`, `resolveChord`, `bindingsFor`, `menuChords`).
- [ ] Implement `resolveChord(chord, scope?)` per Spec S02 and [P15]: collect every binding on that chord across layers — the native menu layer first, then focus mode, then the responder walk innermost-first (read from `manager.activeKeybindings()`), then global — order them, mark the first `active` and every later one `shadowedBy` the winner. The three JS layers' order must be identical to stage 1's actual resolution order, and the test asserts that by driving both.
- [ ] Build the native layer from data the plan already has: `menuChords()` for which chords are menu-eligible, the `commands` mirror's `enabled` for whether the item validates live, and the Maker menu's hidden state for the one `allowsKeyEquivalentWhenHidden` fallthrough case. A `claims: true, enabled: false` entry means the chord is eaten with a beep and nothing below it is reachable — model that state explicitly rather than falling through to the first JS binding.
- [ ] Add the collision lint ([P15]): fail when a `menuEligible` binding shares a chord with any scoped binding. It is what keeps [#step-16] from silently stealing a scoped chord.
- [ ] Change `ResponderChainManager.activeKeybindings` to return `{ scopeId, binding }` pairs so `resolveChord` can attribute a scope to each hit. Update its one existing caller (`warnDuplicateChords`).
- [ ] Implement `menuChords()` returning `Record<menuItemId, ChordSpec | null>` — the first `menuEligible` binding's converted form, or `null` when a command has none.

**Tests:**
- [ ] Unit: `codeToKeyEquivalent` round-trips every code the table binds; an untabled code throws in dev; a shifted-punctuation binding returns the shifted character with `shift` absent from the mask, so ⌘+ converts to `("+", [.command])` and matches the shipped item byte for byte.
- [ ] Unit: `formatChord` for the modifier permutations, including the ⌥⇧⌘C / ⌥⇧⌘V pair that [#step-5] hand-fixed.
- [ ] Unit: `resolveChord` over a constructed multi-layer registry — a mode binding shadows a responder binding shadows a global binding; the shadowed entries name their shadower; an unbound chord answers an empty stack.
- [ ] Unit: the native layer — an enabled menu item shadows a scoped binding on the same chord ([P15]); a disabled one leaves the whole stack unreachable; a hidden-menu item with `allowsKeyEquivalentWhenHidden` false lets the JS layers resolve. The ⌘1–⌘9 / PDF-card case is the concrete fixture, since `pdf-view.tsx` reasons about it by hand today.
- [ ] Unit: the collision lint over the real table — no `menuEligible` binding shares a chord with a scoped binding.
- [ ] Unit: `bindingsFor` marks a command's shadowed binding as inactive and names the winner.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`

---

#### Step 19: Stage 1 and the static map read the registry {#step-19}

**Depends on:** #step-18

**Commit:** `tugways(command-funnel): resolve every chord through the keymap registry`

**References:** [P08] routing vs scope, [P11] displayed chords, Spec S02, (#funnel-shape)

**Artifacts:**
- `keybinding-map.ts` — `KEYBINDINGS` and `matchKeybinding` removed; the file becomes the `KeyBinding` type's home or is deleted.
- `responder-chain-provider.tsx` — stage 1 resolves to a command id.
- `use-keybindings.tsx` — bindings carry activation scope explicitly.

**Tasks:**
- [ ] Move all forty `KEYBINDINGS` entries into their commands' `bindings` defaults, carrying `preventDefault` per binding and marking the menu-eligible ones. The `scope: "key-card"` field on each entry becomes the command's `routing`, per [P08] — read each entry's current `scope` and set the entry's routing to match.
- [ ] Rewrite stage 1's `captureListener` to resolve `keymapRegistry.matchChord(event)` (which internally consults the mode and responder layers via the manager, preserving the current innermost-first order) into a `{ commandId, binding }`, then call `dispatchCommand(commandId, binding.payload)`. The Escape-yields-to-the-ladder guard and the synthetic-Escape guard are unchanged and stay ahead of the resolution.
- [ ] Update `useKeybindings` to take `{ chord, commandId }` pairs rather than `KeyBinding` objects with an `action`, and to register with an explicit `BindingScope` derived from whether `{mode: true}` was passed. Its two call sites (`pdf-view.tsx`, `gallery-chain-actions.tsx`) convert with it.
- [ ] Delete `KEYBINDINGS`, `KEYBINDING_INDEX`, and `matchKeybinding`; keep `keyBindingMatchesEvent`'s rule as `chordMatchesEvent` in `chord-format.ts` (already moved in [#step-18]).
- [ ] Verify `text-editing-keybindings.ts` still compiles — it references the match rule in comments and mirrors its semantics; update the references, do not migrate the substrate bindings ([#non-goals]).

**Tests:**
- [ ] Unit: `keybinding-map.test.ts` rewrites against the registry — every chord it currently pins must resolve to the same command, including the ⇧⌘P / ⌃⌘P distinction, the ⌘1–⌘9 payloads, and the exact-modifier negatives.
- [ ] Unit: `keybinding-registry.test.ts` (the scoped-registry suite) still passes through the new resolution path.
- [ ] `at0177-permission-cycle-keys.test.ts`, `at0179-dynamic-keybinding.test.ts` — the two app-tests that exercise the key pipeline end to end.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test at0177-permission-cycle-keys.test.ts at0179-dynamic-keybinding.test.ts at0176-tab-accepts-completion.test.ts`

---

#### Step 20: The Swift chord sweep {#step-20}

**Depends on:** #step-19

**Commit:** `tugapp(command-funnel): derive every native key equivalent from the pushed keymap`

**References:** [P10] chords via push, [P13] mirror shape, Spec S03, Risk R03, (#swift-key-surface)

**Artifacts:**
- `lib/host-menu-state.ts` — `chord` filled into each gate from `menuChords()`.
- `AppDelegate.swift` — `applyCommandChords()`; construction-time literals reduced to defaults.

**Tasks:**
- [ ] Fill `MenuCommandGate.chord` in `computeCommandCapabilities` from `keymapRegistry.menuChords()`, and subscribe the mirror's recompute to the keymap registry so a binding change republishes.
- [ ] Add `applyCommandChords(in menu: NSMenu? = nil)` to `AppDelegate` per Spec S03 — a recursive sweep applying each identified item's chord, defaulting to `NSApp.mainMenu` — and call it from `updateMenuState(_:)`.
- [ ] Call the scoped form at the tail of every `menuNeedsUpdate` rebuild that reconstructs items: `rebuildViewMenu`, `rebuildOpenRecentMenu`, the Window pane-list refresh, and the theme submenu's delegate. Without this a rebuilt item silently reverts to its construction-time literal and stays there until the next unrelated push (#swift-key-surface).
- [ ] Retire `applyStackChordKeyEquivalent()` and the dynamic ⇧⌘S block: both become ordinary registry outputs. The stack chord becomes two bindings whose `menuEligible` flag follows `stackChordStore`, and the depth-≤1 detach from [#step-2] becomes a `null` chord. Save As's chord becomes `null` when no Text card is frontmost.
- [ ] Keep the construction-time `keyEquivalent` literals as the pre-push defaults ([P10]); add a comment at `buildMenuBar` stating they are defaults the sweep replaces.
- [ ] Confirm `allowsKeyEquivalentWhenHidden` on `view.zoomInAlias` survives the sweep (the sweep writes `keyEquivalent` and the mask only).

**Tests:**
- [ ] New `tests/app-test/at0181-keymap-chord-sweep.test.ts` (`@covers` `keymap-registry.ts`, `lib/host-menu-state.ts`, `AppDelegate.swift`): assert a spot-check set of identifiers carries the expected `keyEquivalent` and `modifierMask` after the first push — including an arrow-key chord, a punctuation chord, and a four-modifier chord.
- [ ] `at0181` — the rebuild case: read a View-menu item's `keyEquivalent`, force the rebuild (`menuSnapshot` walks the tree and the delegate rebuilds on open), and assert the swept chord survived rather than reverting to the construction literal.
- [ ] `at0169` — the stack-chord assertions from [#step-2] now exercise the sweep instead of the retired method.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just build-app && just app-test at0181-keymap-chord-sweep.test.ts at0169-menu-deck-validation.test.ts at0168-menu-structure.test.ts`

---

#### Step 21: Migrate or classify the raw capture listeners; derive displayed chords {#step-21}

**Depends on:** #step-20

**Commit:** `tugways(command-funnel): nothing claims a chord the table cannot see`

**References:** [P08] routing vs scope, [P11] displayed chords, (#defect-mapping)

**Artifacts:**
- `tug-prompt-entry.tsx` — the ⇧⌘M and ⌘. / Escape capture listener.
- `text-editing-menu.ts` and any other surface carrying an authored chord string.

**Tasks:**
- [ ] Migrate the commit-mode ⇧⌘M listener in `tug-prompt-entry.tsx` to a `useKeybindings` registration scoped to the commit-mode focus scope, dispatching a `commit-auto-message` command. It is a raw, unregistered capture listener today — invisible to every audit surface and to conflict detection.
- [ ] Classify the ⌘. / Escape branches in the same listener: they are commit-mode's cancel/exit and duplicate the chain's `cancel-dialog` priority ladder. Either route them through scoped bindings on `exit-commit-mode` / `cancel-commit-draft` commands, or formally mark them substrate-local with a comment naming why. Prefer the former — they are commands, not text-editing currency.
- [ ] Sweep the remaining raw `addEventListener("keydown", …, true)` sites and give each the same treatment — migrate, or mark substrate-local with a comment naming why. This is not a one-file task: beyond `tug-prompt-entry.tsx` the capture-phase listeners are `block-reorder.ts`, `snippets-section.tsx`, `tug-editor-context-menu.tsx`, `tug-placard.tsx`, `card-drag-coordinator.ts`, `dev-error-overlay.ts`, and `tug-text-card-editor/anchor-links.ts`. Most are Escape or modifier-hold and will classify rather than migrate, but each needs the judgment written down — an unclassified listener is exactly the invisible chord claim this step exists to end.
- [ ] Replace every authored chord string in UI code with `formatChord(bindingsFor(commandId)[0]?.chord)` ([P11]). `buildTextEditingMenuItems`'s six entries are the ones [#step-5] patched by hand, and this structurally closes defect 6 — but they are not the only site: `pdf-view.tsx`'s context menu authors `⌘+` / `⌘−` / `⌘0` too, and the sweep is for `TugContextMenuEntry.shortcut` wherever it is spelled, not for one file.

**Tests:**
- [ ] Unit: the context-menu entries' shortcut strings equal `formatChord` of the live bindings — the test that makes an authored-string regression impossible.
- [ ] Unit: `resolveChord` over ⇧⌘M reports the commit-mode binding, proving it is now visible.
- [ ] App-test: commit-mode ⇧⌘M still invokes auto-message (extend the commit-mode coverage, or add the assertion to at0181).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 22: Keymap overrides in tugbank {#step-22}

**Depends on:** #step-21

**Commit:** `tugways(command-funnel): persist user keymap overrides through tugbank`

**References:** [P12] native locked, [P14] override storage, Spec S04, Spec S05, (#state-zone-mapping)

**Artifacts:**
- `tugdeck/src/keymap-override-store.ts` (new).
- `tugdeck/src/settings-api.ts` — `putKeymapOverride` / `deleteKeymapOverride`.
- `tugdeck/src/main.tsx` — boot seed and DEFAULTS-push application.

**Tasks:**
- [ ] Write `keymapOverrideStore` per Spec S04: a subscribable store holding `Map<commandId, CommandBinding[]>`, with `set(commandId, bindings)`, `reset(commandId)`, `resetAll()`, and `initialize(entries)` for the boot seed. Writes persist through `putKeymapOverride` unless `persist: false`.
- [ ] Reject writes against `NATIVE_LOCKED` ids with a dev warning and no persistence ([P12]).
- [ ] Parse defensively: a malformed value reads as absent, so a corrupt entry degrades to the registry default rather than stranding the command.
- [ ] Wire the keymap registry to the override store: the merged binding list is `override ?? default` per command, recomputed on override change, with a notify so the mirror republishes and stage 1 sees the new chord immediately.
- [ ] Seed at boot in `main.tsx` from the `TugbankClient` domain snapshot, before `initHostMenuState` — exactly where `stackChordStore.initialize` sits and for the same reason (the host reads chords off the first push).
- [ ] Apply remote DEFAULTS pushes with `persist: false`, alongside the existing `keyboardAccess` / `stackChord` / `focusRingModality` branches.
- [ ] Ensure the `dev.tugtool.keymap` domain is included in the boot domain fetch list.

**Tests:**
- [ ] Unit: set → registry reflects the new binding; reset → back to the default; empty list → the command has no chord; locked id → rejected.
- [ ] Unit: a malformed persisted value falls back to the default.
- [ ] New `tests/app-test/at0182-keymap-override.test.ts` (`@covers` `keymap-override-store.ts`, `keymap-registry.ts`, `AppDelegate.swift`): write an override through the store, assert `menuItemState(<identifier>).keyEquivalent` changed without a restart; reset and assert it returned.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just build-app && just app-test at0182-keymap-override.test.ts`

---

#### Step 23: The Settings ▸ Keyboard pane {#step-23}

**Depends on:** #step-22

**Commit:** `tugdeck(command-funnel): a keyboard pane that shows, captures, and resets every binding`

**References:** [P11] displayed chords, [P12] native locked, [Q01] layout display, [Q03] scoped rebinding, (#state-zone-mapping)

**Artifacts:**
- `cards/settings-keymap-body.tsx` + `.css` (new).
- `cards/settings-card.tsx` — the new tab.

**Tasks:**
- [ ] Add a `keyboard` tab to `SettingsTabId` / `TABS` (a `Keyboard` lucide icon), between General and Session Card.
- [ ] Build the pane on `TugListView` — never a hand-rolled list; the row set is the registry's non-parameterized entries, searchable by title and by chord, grouped by the menu they live in (or "No menu" for chord-only commands).
- [ ] Each row renders: title, scope, its bindings via `formatChord`, and — per binding — whether it is live or shadowed and by what, read from `bindingsFor` ([Q03]: scoped rows render read-only with their scope named).
- [ ] Chord capture: an armed state that pushes a focus mode via `useFocusTrap` so the capture surface owns every chord while armed, `preventDefault`s at capture phase, builds a `Chord` with `chordFromEvent` (carrying the observed `event.key` as the display label per [P09]), and shows the conflict inline — `resolveChord` on the pending chord, before commit — with the free-chord pools from the audit's §D.2 as the suggestion surface.
- [ ] Add per-binding remove, per-row reset, and a global reset. Locked rows ([P12]) render without a capture affordance and say so.
- [ ] Compose the existing Tug components throughout (`TugListView`, `TugButton`, `TugBox`, `TugAlert` for the destructive global reset) — no hand-rolled list focus, selection, or dialog.

**Tests:**
- [ ] `at0182-keymap-override.test.ts` — extend: drive the pane to rebind a command and assert the native menu item's key equivalent follows, then reset from the pane and assert it returns. The pane's *rendering* is not asserted; the end-to-end effect is ([#test-non-goals]).
- [ ] Unit: the pane's row model (a pure function from the registry + override store to row descriptors) over a real registry.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just build-app && just app-test at0182-keymap-override.test.ts at0173-settings-shortcut.test.ts`

---

#### Step 24: Refresh tuglaws/menus.md and the cross-references {#step-24}

**Depends on:** #step-23

**Commit:** `tuglaws(command-funnel): refresh the menus doctrine against the two funnels`

**References:** [P01] registry home, [P02] identifier join, [P13] mirror shape, (#documentation-plan, #defect-mapping)

**Artifacts:**
- `tuglaws/menus.md`, `tuglaws/action-naming.md`, `tuglaws/responder-chain.md`, `tuglaws/focus-language.md`, `tests/app-test/README.md`.

**Tasks:**
- [ ] Rewrite `menus.md`'s wire contract section: the block is `session`, not `dev`; add the six top-level keys the decoder parses but the doc omits (`file`, `document`, `recentDocuments`, `openQuickly`, `selectionActive`, `stackDepth`/`stackChord`) plus the new `commands` block.
- [ ] Replace the five-tier validation table with the mirror-first model: one tier reading `commands`, plus the two documented survivors (the native-undo branch and the parameterized families).
- [ ] Regenerate the control-frame catalog from the registry; drop `show-dev-panel-toggle` (stale everywhere) and `set-maker-mode` (deleted in [#step-9]); drop `maker.sessionPanel` (does not exist).
- [ ] Add the chord table, generated from the keymap registry, replacing the audit brief's temporary copy.
- [ ] State the theme submenu's source: filesystem scan of `tugdeck/styles/themes`, therefore empty without a source tree; and that its checkmark now rides the push.
- [ ] Correct the "one exception to pull-validation" claim — it was four sites, none of which worked, and all four are now validator tiers ([#step-1]).
- [ ] Update `action-naming.md` with the registry layer, `responder-chain.md` with `queryActionState` and the key-card variants, `focus-language.md` with the chord-capture mode, and the app-test README with at0180–at0182.
- [ ] Add the doc-generation test: regenerate the catalog rows from the registry and diff against the checked-in section, so the catalog cannot drift again.

**Tests:**
- [ ] Unit: the catalog-generation diff test.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] Read `menus.md` against the twelve drift points in the audit brief's §E.2 and confirm each is addressed.

---

#### Step 25: Integration checkpoint — the whole arc {#step-25}

**Depends on:** #step-11, #step-14, #step-15, #step-17, #step-20, #step-21, #step-23, #step-24

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every criterion in [#success-criteria] and record how it was verified.
- [ ] Confirm the audit brief's §F ledger is closed: twelve defects, each traced to a landed step per [#defect-mapping].
- [ ] Confirm no surface in the codebase authors a chord string, defines a second validity for a command, or claims a chord the keymap registry cannot see.
- [ ] Confirm `pdf-view.tsx`'s hand-written shadowing comment (why the viewer declines ⌘1–⌘3 and the zoom chords) is now an observation `resolveChord` makes, not a fact a reader has to know — and rewrite or delete it accordingly.

**Tests:**
- [ ] The full menu/keybinding app-test family plus the three new files.

**Checkpoint:**
- [x] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build` — clean; 5965 tests pass across 412 files.
- [x] `cd tugrust && cargo nextest run` — 1998 pass, 5 skipped.
- [x] `just build-app`
- [x] The full menu/keybinding family — **13/13 files, 29/29 tests.**
- [x] `just app-test` (core tier) — **20/20 files, 39/39 tests.**

##### How each success criterion was verified {#step-25-verification}

| Criterion | Verification |
|---|---|
| One registry entry per command; no `sendControl` wire absent from the table | `command-routing-drift.test.ts` checks the wire fixture against the table; `command-registry.test.ts` checks id uniqueness |
| `dispatchAction` holds no command-specific routing | Read end to end: the data-frame handlers, the `registry`-routed bodies, and one `isCommandId` fork at line 272 |
| Menu enablement from `menuState.commands[...]` | at0180 + at0167/at0169/at0171/at0172/at0174, all green with the hand-rolled tiers deleted |
| Edit ▸ Delete follows the selection | at0174 |
| ⌘R detached at stack depth ≤ 1 | at0169, now through the sweep rather than the retired method |
| Every displayed chord rendered from the registry | `text-editing-menu-shortcuts.test.ts` — including a rebind that moves the hint, which an authored string would sail through |
| `resolveChord` answers the ordered stack, native layer included | `keymap-registry.test.ts` over a constructed four-layer world |
| No `menuEligible` binding shares a chord with a scoped binding | `lintChordCollisions` over the real table, in `command-registry.test.ts` |
| A rebind moves both the JS layer and the menu bar without a restart | at0182, driven both remotely and through the pane |
| Deleting an override restores the default | at0182 |
| `menus.md` names every top-level key and its catalog matches the registry | `menus-doc.test.ts` regenerates both derived regions and diffs |

##### Two notes on the plan's own expectations {#step-25-notes}

- **The baselined red is green.** [#known-red] expected at0174 at 3/4 — the synthesized ⌘Z not reverting typed text. It is 4/4. The chord now arrives through the swept key equivalent rather than a construction literal, which is the plausible cause; either way the step's proof needed no allowance.
- **at0191 flaked once in the core tier** (a turn address read 5 where 1 was expected) and passed alone on this branch, alone on `main`, and in a second full core-tier run. It covers `code-session-store/`, the transcript data source, and `tugcode/` — none of which this plan touches. Recorded as a flake, not a regression.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Every user-invocable command in Tug enters through `dispatchCommand` and is described by exactly one registry entry carrying its title, routing, validity, state, menu placement, and binding list; every chord — native and web — is derived from that table; and a Settings ▸ Keyboard pane lets the user read, rebind, and reset it.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `action-dispatch.ts` contains tugcast data-frame handlers, `registry`-routed bodies, and one fork — no command-specific routing (read the file).
- [ ] Every `sendControl(` wire in `AppDelegate.swift` resolves in the registry or the data map (unit test over the checked-in wire fixture).
- [ ] `validateMenuItem`'s hand-rolled cases are the native-undo branch and the parameterized families; every other statically-built item is gated by `menuState.commands` (read the file; at0167–at0174 green).
- [ ] `KEYBINDINGS` and `matchKeybinding` no longer exist; stage 1 resolves through the keymap registry (grep).
- [ ] `applyStackChordKeyEquivalent` and the dynamic ⇧⌘S block no longer exist; both are registry outputs applied by `applyCommandChords` (grep).
- [ ] `resolveChord` answers the full resolution stack with shadowing for any chord — native layer first ([P15]) — and `bindingsFor` marks each of a command's bindings live or shadowed (unit tests).
- [ ] The collision lint passes: no `menuEligible` binding shares a chord with a scoped binding (unit test over the real table).
- [ ] A chord swept onto a dynamically-rebuilt menu survives the rebuild (at0181).
- [ ] A rebind in Settings ▸ Keyboard moves both the web binding and the native key equivalent without a restart; a reset restores the default (at0182).
- [ ] `NATIVE_LOCKED` is the only place lockedness is decided, and a write against a locked id is rejected (unit test).
- [ ] No UI surface authors a chord string (unit test comparing rendered shortcuts to `formatChord` of the live bindings).
- [ ] `tuglaws/menus.md`'s twelve drift points are closed, and its catalog is generated-and-diffed against the registry.

**Acceptance tests:**
- [ ] `at0180-command-registry-gates.test.ts` — mirror-driven enablement, state, and titles across the menu families.
- [ ] `at0181-keymap-chord-sweep.test.ts` — native key equivalents derived from the registry, including arrow, punctuation, and four-modifier chords.
- [ ] `at0182-keymap-override.test.ts` — override round trip through the pane and through the store, with reset.
- [ ] The at0167–at0179 menu and keybinding family, unmoved.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] A command palette over the registry — the table already carries titles, scopes, validity, and chords.
- [ ] Native layout-accurate chord labels via `UCKeyTranslate` pushed from the host ([Q01]).
- [ ] Rebinding scoped bindings from the keymap pane ([Q03]).
- [ ] Generating menu *structure* from a shared manifest (deliberately deferred by the brief's §G.5.1).
- [ ] Import / export of a keymap as a file, and named keymap presets.
- [ ] Extending the funnel to the `/` slash-command namespace so typed commands and registry commands enumerate together.

| Checkpoint | Verification |
|------------|--------------|
| Floor repaired | `just app-test at0167… at0174…` with the defect-specific assertions added in steps 1–5 |
| Funnel #1 behavior-neutral | [#step-11]'s full menu/keybinding family, green with no assertion changes |
| Validation and state converged | [#step-14] + [#step-15]; Swift tiers deleted with their app-tests still green |
| Funnel #2 derived on both sides | at0181, plus `grep` finding no `KEYBINDINGS` and no `applyStackChordKeyEquivalent` |
| User keymap live | at0182 end to end through the pane |
| Docs true | The catalog-generation diff test, plus a read of `menus.md` against the brief's §E.2 |
