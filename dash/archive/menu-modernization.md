<!-- devise-skeleton v4 -->

## Menu Modernization — a full macOS menu bar for Tug.app {#menu-modernization}

**Purpose:** Replace Tug.app's afterthought menu bar with a complete, validated, card-sensitive macOS menu structure — including a new Session menu that surfaces the dev card's command surfaces, a Maker rename for the app-maker tooling, and per-item validation built on the `menuSnapshot` / `menuItemState` introspection machinery.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-10 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Swift-side menu bar (`tugapp/Sources/AppDelegate.swift`, `buildMenuBar()`) has lagged the app. The dev card now carries 19 locally-handled slash commands with graphical surfaces (`tugdeck/src/lib/slash-commands.ts`), a permission-mode system, live turn state, and a rich keyboard vocabulary (`keybinding-map.ts`) — none of it discoverable or reachable from the menu bar. Several existing items are dead (Edit ▸ Find uses `NSTextView.performFindPanelAction`, which never reaches WKWebView content) or misplaced (Theme in the app menu, Cascade/Tile and the pane list in View).

The close-validation work that landed in commit `9ff9cb4d` built the foundation this plan stands on: `validateMenuItem(_:)` gating driven by a frontend-pushed state payload, stable `NSUserInterfaceItemIdentifier`s, and the harness verbs `menuSnapshot` / `menuItemState` that report *validated* enabled state. This plan generalizes that pattern from two File items to the whole bar.

#### Strategy {#strategy}

- Generalize the `cardList` host push into a `menuState` push that carries deck structure **plus** the active card's type and the dev card's live session state (bound, can-interrupt, permission mode, transcript facts).
- Add one generic control frame, `run-card-command`, that re-enters the dev card's existing `RUN_SLASH_COMMAND` surface map via `sendToKeyCard` — one frame covers all 19 command surfaces with zero per-command JS.
- Restructure the bar to **Tug · File · Edit · Session · View · Window · Maker · Help**, with every item carrying a namespaced identifier.
- Validate everything in `validateMenuItem(_:)` from the cached `MenuState` — four tiers: always-on, deck-state, card-type, session-state.
- Rename Developer → **Maker** end to end (menu, Swift identifiers, tugbank key — clean rename, no legacy fallback; every client updated — Settings toggle), leaving the tugcast `dev_mode` wire verbs untouched.
- Land in slices that keep every commit green: wire channel first, JS adapters second, Swift menus third, tests per tier.

#### Success Criteria (Measurable) {#success-criteria}

- `menuSnapshot` over the running app reports the exact bar structure in **Table T01** — titles, identifiers, key equivalents (app-test asserts this).
- With a git card frontmost, every Session-menu item reports `enabled: false` via `menuItemState`; with a bound dev card frontmost, the tier-4 items report `enabled: true` (app-test).
- `session.stop` reports `enabled: true` only while the dev card's `canInterrupt` snapshot is true (app-test using the dev-session harness pattern).
- The Permission Mode submenu shows a single `.on` checkmark matching the live mode, and selecting a different mode item changes the session's mode (app-test).
- A tugbank DB seeded with `maker-mode-enabled=true` launches with the Maker menu visible; `false` hides it (app-test with seeded `TUGBANK_PATH`). The legacy `dev-mode-enabled` key is dead — no fallback, no migration (user directive during implementation).
- Edit ▸ Find / Find Next / Find Previous route to the chain's `find` / `find-next` / `find-previous` actions; the dead `NSTextView` find-panel items are gone (snapshot assert + existing find behavior unchanged in browser dev).
- `cd tugdeck && bun run check && bun test` and `just build-app` pass at every step boundary; `cargo nextest run` is unaffected (no Rust changes).

#### Scope {#scope}

1. `menuState` host-push channel replacing `cardList` (tugdeck module + Swift ingestion).
2. Dev-card session state published into the channel (bound / canInterrupt / permissionMode / transcript facts).
3. `run-card-command` and `set-permission-mode` control frames; Both-category adapters for `find`, `find-next`, `find-previous`, `next-tab`, `previous-tab`, `cycle-card`, `focus-prompt`, `cycle-permission-mode`.
4. Full menu-bar restructure per **Table T01**, identifiers on every item.
5. New Session menu with four-tier validation and a native Permission Mode radio submenu.
6. Developer → Maker rename: menu title, Swift symbol names, tugbank key (clean rename, all clients updated), user-facing strings, Settings toggle.
7. App-test coverage per validation tier on the at0167 pattern.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Renaming the tugcast wire verbs (`dev_mode` control frame, `sendDevMode`, Vite/watcher plumbing) — see [P05].
- A native Model submenu listing models from the `session_capabilities` handshake — Model… opens the existing sheet; native submenu is a follow-on (#roadmap).
- Window-menu ⌘1–9 per-card sublist (Safari-style) — follow-on; the ⌘1–9 web-side keybindings keep working because no menu item claims those chords.
- A menu item for ⌥⇥ Cycle Keyboard Focus — a modified-Tab key equivalent is un-idiomatic in AppKit menus; it stays keyboard-only, documented in the `/help` sheet.
- `REOPEN_TAB` (⇧⌘T) — still has no handler (no closed-tab history in deck-manager); not added to the menu.
- Touching `MINIMIZE` / `MAXIMIZE` chain actions — not wired to menu items in this phase.

#### Dependencies / Prerequisites {#dependencies}

- Commit `9ff9cb4d` — `validateMenuItem` gating, `file.closeCard` / `file.closeAllCards` identifiers, harness `menuSnapshot` / `menuItemState` verbs (surface 1.6.0).
- `ResponderChainManager.sendToKeyCard` (`tugdeck/src/components/tugways/responder-chain.ts`) for key-card-scoped dispatch from `action-dispatch.ts`.
- Dev-session app-test patterns (at0099 resume-command, at0107 compact-command, at0105 permission-cycle-keys) for driving a bound dev card in tests.

#### Constraints {#constraints}

- WARNINGS ARE ERRORS in the Rust workspace (untouched here) and effectively in Swift/TS builds — every step boundary must build clean.
- Tugdeck work must conform to tuglaws ([L01]/[L02]/[L03]/[L06]); see #state-zone-mapping.
- No localStorage/sessionStorage — persistent state stays in tugbank.
- App-tests run with `TUGAPP_APP_TEST=1`, which forces maker mode off for serving; Maker-menu-visible tests must seed the tugbank key and account for this (see #r05-app-test-maker).
- A Swift menu item with a key equivalent swallows that chord before the WKWebView sees it — every shortcut promoted to a menu item MUST have a working control-frame round-trip ([P03], Risk R02).

#### Assumptions {#assumptions}

- The dev card remains the only card type with a `card-content` responder handling `RUN_SLASH_COMMAND`; `sendToKeyCard` dispatch on a non-dev card is a silent no-op (current behavior, relied on for graceful degradation).
- `CodeSessionStore` snapshot fields (`canInterrupt`, `transcript`) and `sessionMetadataStore.permissionMode` are sufficient to compute the session-state tier; no new tugcode/tugcast wire data is needed.
- The browser-only keybinding map entries stay as-is for browser dev; in-app, menu key equivalents take over the promoted chords.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] How deep does the Maker rename go? (DECIDED) {#q01-maker-rename-depth}

**Question:** Does the rename cover the tugcast wire protocol (`dev_mode` control frame, `sendDevMode`, Vite plumbing)?

**Why it matters:** Renaming the wire verb ripples into tugcast Rust and the reconnect paths for zero user-visible gain.

**Resolution:** DECIDED (see [P05]) — user-facing surfaces, Swift/JS identifiers, and the tugbank key rename; tugcast wire verbs stay.

#### [Q02] Where does the Maker Mode toggle live in Settings? (DECIDED) {#q02-settings-toggle-home}

**Question:** The Settings card today has a single "Dev Card" tab (`settings-card.tsx` `TABS`) and **no** dev-mode toggle — mode is currently flipped via `tugcode tell set-dev-mode` or the webkit `setDevMode` bridge. Where does the user-facing toggle go?

**Why it matters:** The Maker menu's gate must be reachable from the app's own settings UI, per the phase goal.

**Resolution:** DECIDED (see [P09]) — a new "App" tab in the Settings card hosting the Maker Mode toggle, wired to the existing `setDevMode` / `getSettings` WKScriptMessage bridge.

#### [Q03] Native Model submenu now or later? (DEFERRED) {#q03-model-submenu}

**Question:** Should Session ▸ Model be a native submenu of model names (from the `session_capabilities` initialize handshake) instead of a sheet-opener?

**Why it matters:** A native submenu needs the model list and active model pushed into `menuState`, plus a `set-model` frame — real new machinery.

**Resolution:** DEFERRED — Model… opens the existing model-picker sheet via `run-card-command`. Revisit in a follow-on (#roadmap) once `menuState` is proven; the handshake (not post-turn `system_metadata`) is the data source when it lands.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Promoted menu chords break web shortcuts | high | med | Both-category round-trip per chord, app-test per chord | any chord dead in-app |
| menuState push churn | low | med | diff + microtask coalescing in the aggregator | main-thread jank while streaming |
| Stale Stop enablement | low | low | push on every CodeSessionStore phase change; AppKit re-validates on menu open | Stop enabled with no turn running |
| Maker key rename loses prefs | low | low | clean rename per user directive — old key ignored; build-profile default covers fresh DBs | fresh launch loses maker mode |
| at0166/at0167 coupled to cardList payload | med | high | step 1 keeps validation semantics identical; update harness types in same commit | either test red after step 1 |

**Risk R01: menuState push frequency** {#r01-menu-state-churn}

- **Risk:** `notify()` fires on every deck mutation and `CodeSessionStore` emits on every streaming token; naive forwarding posts a WKScriptMessage flood.
- **Mitigation:** the aggregator coalesces on a microtask and posts only when the *serialized menu-relevant projection* changes (canInterrupt is a boolean derived from phase — it flips rarely even though snapshots churn constantly).
- **Residual risk:** a pathological flip-flopping phase still posts per flip; acceptable, it is two booleans.

**Risk R02: menu key equivalents swallow chords** {#r02-chord-swallow}

- **Risk:** Adding ⌘F/⌘G/⇧⌘G/⇧⌘[/⇧⌘]/⌃`/⌘K/⇧⌘P as menu key equivalents means AppKit consumes them at the menu bar; if the control-frame round-trip is missing or the item is wrongly disabled, the shortcut goes dead in-app while still working in browser dev — an invisible regression.
- **Mitigation:** Step 3 lands every Both-category adapter *before* Step 4 attaches the key equivalents; app-tests fire each promoted chord through the menu and assert the observable effect.
- **Residual risk:** validation predicates that are too strict can inert a chord; predicates for find/tab-nav are deliberately loose (Table T02).

**Risk R05: app-test harness forces maker mode off** {#r05-app-test-maker}

- **Risk:** `TUGAPP_APP_TEST=1` forces `makerModeEnabled = false` in `loadPreferences()` (to serve prebuilt dist), so Maker-menu tests can't see the menu.
- **Mitigation:** the force applies to the *serving* decision today as one flag; Step 6 splits the concerns — the app-test force keeps production serving but no longer overrides the menu-visibility preference read from tugbank, so a seeded `maker-mode-enabled=true` shows the menu under test.
- **Residual risk:** none significant; manual launches unaffected.

---

### Design Decisions {#design-decisions}

#### [P01] Menu bar structure: Tug · File · Edit · Session · View · Window · Maker · Help (DECIDED) {#p01-menu-bar-structure}

**Decision:** The bar is restructured per **Table T01**: File owns creation/closing/export, Edit gains Copy Last Response and a rewired Find, Session is new and dev-card-sensitive, View keeps appearance (Theme moves in) and page zoom, Window absorbs arrangement + card navigation + the pane list, Maker replaces Developer, Help gains a shortcuts entry.

**Rationale:**
- Theme is appearance → View (macOS convention); Cascade/Tile and the pane list are window management → Window (Safari/Terminal convention).
- The dev card's command surfaces deserve a first-class menu; "Session" names what the items operate on.
- The New submenu flattens — two production card types don't need a submenu; debug-only creators move to Maker.

**Implications:**
- `buildMenuBar()` is substantially rewritten; the `themeMenu` / `viewMenu` `NSMenuDelegate` logic moves with its menus.
- Every item gets a namespaced identifier ([P07]).

#### [P02] Session menu is disabled, not hidden, without a dev card (DECIDED) {#p02-session-disabled-not-hidden}

**Decision:** The Session menu stays in the bar at all times; its items validate to disabled when no dev card is frontmost.

**Rationale:**
- HIG: stable menu bars with disabled items preserve discoverability; vanishing menus hide capability.
- The Maker menu's hide-on-gate is a different case (a *mode*, not a focus state).

**Implications:**
- Every Session item participates in `validateMenuItem(_:)`; none are statically disabled.

#### [P03] One `run-card-command` control frame re-enters the slash-command surface map (DECIDED) {#p03-run-card-command}

**Decision:** Swift menu items send `sendControl("run-card-command", params: ["name": <LocalCommandName>, "args": <optional>])`; the JS handler dispatches `TUG_ACTIONS.RUN_SLASH_COMMAND` with that payload via `responderChainManagerRef.sendToKeyCard(...)`.

**Rationale:**
- Byte-identical to typing the command: the dev card's `slashCommandSurfaces` map (`dev-card.tsx` card-content responder) handles it with zero per-command JS.
- On a non-dev key card the dispatch is a silent no-op — defense in depth under the validation gate.

**Implications:**
- `action-dispatch.ts` gains one registration; the payload narrows `name` to a string and passes `args` through (default `""`).
- Menu items carry the command name on `representedObject`; one Swift `@objc` selector serves all of them.

#### [P04] `menuState` push replaces the `cardList` push (DECIDED) {#p04-menu-state-push}

**Decision:** A new tugdeck module `lib/host-menu-state.ts` aggregates deck structure (from a `DeckManager` subscription) and per-card dev session state (published by the dev card), diffs, coalesces, and posts **Spec S01** to a `menuState` WKScriptMessage handler. `pushCardListToHost` and the `cardList` handler are removed in the same commit.

**Rationale:**
- `canInterrupt` / `permissionMode` change without deck mutations, so the deck `notify()` hook alone can never carry them — a second publisher is needed regardless; one aggregating module with one wire channel beats two channels.
- Diffing in JS keeps the WKScriptMessage traffic proportional to menu-relevant change, not store churn (Risk R01).

**Implications:**
- `MainWindow` registers `menuState` (and drops `cardList`); `AppDelegate` parses into a `MenuState` struct cached for `validateMenuItem`.
- at0166/at0167 harness payload types update in the same commit; validation semantics for the two close items are unchanged.

#### [P05] Maker rename stops at the tugcast wire (DECIDED) {#p05-maker-rename-boundary}

**Decision:** Rename the menu (Developer → Maker), Swift symbols (`devModeEnabled` → `makerModeEnabled`, `developerMenu` → `makerMenu`, `updateDeveloperMenuVisibility` → `updateMakerMenuVisibility`, bridge names `bridgeSetDevMode` → `bridgeSetMakerMode`, WKScriptMessage `setDevMode` → `setMakerMode`), user-facing strings, and the tugbank key (`dev-mode-enabled` → `maker-mode-enabled`, clean rename — NO legacy fallback; every client updated, per user directive). The tugcast wire verbs (`dev_mode` control frame, `sendDevMode(enabled:sourceTree:vitePort:)`) and Vite/watcher plumbing keep their names.

**Rationale:**
- The wire layer genuinely is about dev-*serving* (Vite, HMR, origin allowlists); renaming it ripples into tugcast Rust and reconnect paths for zero user-visible gain.
- "Maker" frees "dev" to mean the Dev card's domain — development done *with* Tug — while Maker names tooling for makers *of* Tug.

**Implications:**
- `loadPreferences()`: read `maker-mode-enabled` only (absent → build-profile default; deterministically false under the app-test harness). `savePreferences()` writes the new key.
- The JS action registry registers `set-maker-mode` only — no `set-dev-mode` alias; external callers (tugcode tell examples) updated.
- One comment at the Swift/JS → tugcast boundary notes that maker mode is the user-facing name for the dev-serving switch.

#### [P06] Permission Mode is a native radio submenu (DECIDED) {#p06-permission-mode-submenu}

**Decision:** Session ▸ Permission Mode is a native submenu listing `PERMISSION_MODE_MENU` (`lib/permission-mode.ts`: default, acceptEdits, plan, auto — `bypassPermissions` excluded, matching the chip), with `.on` state on the live mode and a trailing "Cycle Permission Mode ⇧⌘P" item. Selecting a mode sends `set-permission-mode {mode}`, which dispatches a new chain action `SET_PERMISSION_MODE` key-card-scoped; the dev card's handler commits the mode through the same path the permission-mode chip uses.

**Rationale:**
- Picking from four radio states is exactly what native submenus are for; a sheet round-trip would be worse than the chip it duplicates.
- Reusing the chip's commit path keeps optimistic metadata + per-card tugbank persistence in one place.

**Implications:**
- `TUG_ACTIONS` gains `SET_PERMISSION_MODE` (payload `value: string`, one of the menu modes); the dev card registers a handler beside `CYCLE_PERMISSION_MODE`.
- `menuState`'s dev block carries `permissionMode` (Spec S01); the submenu rebuilds checkmarks in `menuNeedsUpdate`.
- Display labels come from `formatPermissionMode` parity — Swift hardcodes the four titles (Default / Accept Edits / Plan / Auto) with the mode string on `representedObject`.

#### [P07] Every menu item carries a namespaced identifier (DECIDED) {#p07-identifiers-everywhere}

**Decision:** Every `NSMenuItem` (including dynamically rebuilt ones) gets a stable `NSUserInterfaceItemIdentifier` namespaced by menu: `file.newDevCard`, `edit.findNext`, `session.stop`, `session.permissionMode.plan`, `window.nextCard`, `maker.reload`, `help.shortcuts`, etc. Existing `file.closeCard` / `file.closeAllCards` are kept verbatim.

**Rationale:**
- `menuItemState` / `menuSnapshot` address items by identifier; titles flip (Close Card ↔ Close Pane) and localize.
- Dynamic items (theme list, pane list, permission modes) need identifiers minted at build time in `menuNeedsUpdate` (`view.theme.<name>`, `window.pane.<n>` by position, `session.permissionMode.<mode>`).

**Implications:**
- App-tests assert structure by identifier, never by title.

#### [P08] Edit ▸ Find rewires to chain actions (DECIDED) {#p08-find-rewire}

**Decision:** Find ⌘F / Find Next ⌘G / Find Previous ⇧⌘G become `sendControl("find" / "find-next" / "find-previous")` round-trips (Both-category, same pattern as `close`); "Use Selection for Find" is removed.

**Rationale:**
- The current `NSTextView.performFindPanelAction` items never reach WKWebView content — they are dead UI.
- The chain already owns these semantics (`FIND` / `FIND_NEXT` / `FIND_PREVIOUS`, handled by `FileBlock`'s find session).

**Implications:**
- Three new Both-category registrations in `action-dispatch.ts` dispatching `sendToFirstResponder`.
- Enablement is loose (always enabled; an unhandled dispatch is a no-op) — matching the web-side behavior where ⌘F on a card without find UI does nothing.

#### [P09] Maker Mode toggle lives in a new Settings "App" tab (DECIDED) {#p09-settings-app-tab}

**Decision:** The Settings card (`settings-card.tsx`) gains an "App" tab containing a Maker Mode switch. It reads initial state via the existing `getSettings` bridge and commits via the (renamed) `setMakerMode` WKScriptMessage bridge — the same path `bridgeSetMakerMode` already implements, including the Vite teardown/spawn and page reload.

**Rationale:**
- Today there is no in-app toggle at all (mode flips only via `tugcode tell`); the Maker gate must be settable from Settings per the phase goal.
- Maker mode is app-level, not Dev-card-level — it doesn't belong in the existing "Dev Card" tab.

**Implications:**
- The toggle's commit triggers a page reload (inherent to the serving switch); the switch row's copy says so.
- Toggle state is `useState` seeded from the bridge read — session-local UI state, not tugbank-watched (#state-zone-mapping).

#### [P10] Stop has no key equivalent (DECIDED) {#p10-stop-no-key}

**Decision:** Session ▸ Stop carries no shortcut; it is the discoverable face of Escape's interrupt path.

**Rationale:**
- Escape already routes `CANCEL_DIALOG` → interrupt fallback through the chain with correct priority (popover dismiss > drag cancel > interrupt); a menu chord would fight that ordering.
- ⌘. is taken by cancel-dialog semantics.

**Implications:**
- Stop's action sends `run-card-command {name: "stop"}`? No — Stop is not a slash command. It sends a dedicated `sendControl("interrupt-session")` handled in `action-dispatch.ts` by dispatching key-card-scoped to a new dev-card handler that calls `codeSessionStore.interrupt()` — see Spec S02.

#### [P11] Validation is pull-based from one cached MenuState (DECIDED) {#p11-pull-validation}

**Decision:** All enablement flows through `validateMenuItem(_:)` reading the cached `MenuState` (Table T02); no imperative `isEnabled` writes outside the dynamic `menuNeedsUpdate` builders (zoom items keep their existing build-time enablement).

**Rationale:**
- AppKit re-validates on menu open and key-equivalent dispatch — the cache plus pull beats scattered pushes, and it is exactly what `menuItemState` reports.

**Implications:**
- `validateMenuItem` switches on selector + `representedObject`/identifier; predicates live as small computed properties over `MenuState` (the `focusedPaneCardCount` pattern from `9ff9cb4d`).

#### [P12] The Window menu's dynamic section is managed in place — never `removeAllItems()` (DECIDED) {#p12-window-menu-sectioned}

**Decision:** `NSApp.windowsMenu` stays assigned to the Window menu (as today). The dynamic pane-list section is managed as a delimited slice: the builder tracks its own items (by identifier prefix `window.pane.`), removes exactly those on each `menuNeedsUpdate`, and re-inserts at a tracked index between its bounding separators. The `rebuildViewMenu` `removeAllItems()` pattern is explicitly forbidden here.

**Rationale:**
- AppKit auto-manages window entries in whatever menu is assigned to `NSApp.windowsMenu`; a wholesale rebuild deletes AppKit's auto-added items on every open and invites duplicates or losses.
- Keeping the `windowsMenu` assignment preserves the HIG-standard auto window list for free.

**Implications:**
- The Window menu's static items (Minimize, Zoom, Cascade, Tile, card-nav, Cycle Panes, Full Screen, Bring All to Front) are built once in `buildMenuBar` and never touched by the delegate; only the `window.pane.*` slice churns.
- App-test structure assertions must tolerate AppKit's auto-added window item(s) at the menu tail.

---

### Deep Dives (Optional) {#deep-dives}

#### Implementation Landmarks {#implementation-landmarks}

Code geography a fresh session needs, verified against the tree at plan time. Cite symbols, not line numbers — these are the load-bearing sites.

**Table T03: landmark symbols** {#t03-landmarks}

| Where | Symbol | Role in this plan |
|---|---|---|
| `tugapp/Sources/AppDelegate.swift` | `buildMenuBar()` | the rewrite target; also `closeMenuItem` / `closeAllMenuItem`, `validateMenuItem(_:)`, `updateCardList(_:)`, `menuNeedsUpdate(_:)` (View + Theme delegates), `NSMenuItem` convenience init with `modifierMask` (file bottom) |
| `tugapp/Sources/MainWindow.swift` | `contentController.add(self, name: …)` registrations + the `userContentController(_:didReceive:)` case switch | add `menuState`, drop `cardList`, rename `setDevMode` → `setMakerMode`; the `getSettings` / `setDevMode` cases respond via `evaluateJavaScript("window.__tugBridge?…")` — these emit strings are what Step 6 renames and Step 7's receiver matches |
| `tugapp/Sources/TestHarness/TestHarnessConnection.swift` | `dispatchMenuSnapshot` / `dispatchMenuItemState` / `findByIdentifier` | harness surface 1.6.0; reports *validated* enabled state — no new verbs needed for this plan |
| `tugdeck/src/deck-manager.ts` | `pushCardListToHost()` called from `notify()` | the body Step 1 extracts into the aggregator; the projection logic (focused = last pane in z-order, title fallback chain, `.reverse()`) must move verbatim |
| `tugdeck/src/action-dispatch.ts` | `registerAction`, `responderChainManagerRef`, `_resetForTest` | Both-category registrations follow the `TUG_ACTIONS.CLOSE` pattern (constant at register + dispatch site) |
| `tugdeck/src/components/tugways/responder-chain.ts` | `sendToKeyCard` / `sendToKeyCardForContinuation` | key-card scope resolves to the active card's `card-content` responder even when focus sits on chrome |
| `tugdeck/src/components/tugways/cards/dev-card.tsx` | `slashCommandSurfaces` (a `Record<LocalCommandName, …>` near the card-content `useResponder`) | exhaustively keyed — every `run-card-command` name Swift sends MUST be a `LOCAL_SLASH_COMMANDS` member or it's a silent no-op; the card-content responder is where `SET_PERMISSION_MODE` / `INTERRUPT_SESSION` handlers land |
| `tugdeck/src/components/tugways/cards/permission-mode-chip.tsx` | mode fallback (`live ?? persisted ?? "default"`), `usePermissionSheet`, `onSelectMode` → `usePermissionMode().setMode` | `setMode` sends the `permission_mode` frame, optimistically reflects, persists per card — the single commit path [P06] reuses; factor the fallback into a shared helper for Step 2 |
| `tugdeck/src/lib/permission-mode.ts` | `PERMISSION_MODE_MENU`, `formatPermissionMode` | the menu mode set (no `bypassPermissions`) and display labels |
| `tugdeck/src/lib/code-session-store.ts` | snapshot `canInterrupt` (phase disjunction incl. `waking`), `interrupt()` | Stop's predicate and action |
| `tugapp/Sources/TugConfig.swift` | `keyMakerModeEnabled = "maker-mode-enabled"`, `domain` | the renamed key (no legacy fallback); read/write via `ProcessManager.readTugbank` / `writeTugbank` |

#### Behavioral nuances to preserve {#behavioral-nuances}

- **Close Card ↔ Close Pane title flip**: `updateCardList` retitles `closeMenuItem` from the focused pane's `cardCount` (Safari/Finder convention, initial title "Close Pane"). This must survive the Step 1 `MenuState` refactor byte-for-byte — at0167 asserts validated state around it.
- **Identifier stability**: `file.closeCard` keeps its identifier through the title flip — identity never rides the title. Same rule for every new dynamic item ([P07]).
- **`autoenablesItems` + nil-target routing**: validation only reaches `validateMenuItem` for items whose action resolves to the AppDelegate up the responder chain. New items follow the existing pattern (no explicit target); native-selector items (`NSText.cut` etc.) validate against the field editor as today.
- **Before the first `menuState` push** (app boot, pre-frontendReady): the cached `MenuState` is empty → tier-2/3/4 predicates all read false → close items and the whole Session menu start disabled. This matches today's pre-cardList behavior and is correct, not a bug to "fix".
- **Zoom items keep build-time enablement** in `menuNeedsUpdate` with the epsilon comparison and the hidden ⌘= alias (`allowsKeyEquivalentWhenHidden`) — the [P11] exception. The ⌘= alias pattern is also the reference if any future alias chord is needed.
- **Theme submenu reads themes from disk** (`sourceTreePath` + `tugdeck/styles/themes/*.css`) and re-reads the active theme from tugbank on every open. Relocation to View moves this logic unchanged.
- **`run-card-command` arg semantics**: `rename` and `compact` are the only `takesArgs` commands; menu items send no args (bare `rename` opens the seeded one-field sheet — exactly the wanted menu behavior).
- **Stop ≠ cancel-dialog**: Escape's chain walk gives popover-dismiss priority over interrupt. The menu's `interrupt-session` frame bypasses that walk deliberately — it always means interrupt ([P10]); enablement (`canInterrupt`) is the only gate.
- **App-test harness binds a real tugcode** (the at0099/at0105/at0107 suites drive real sessions); never hand-roll session stubs for Step 9 — reuse those suites' setup helpers.

---

### Specification {#specification}

**Spec S01: `menuState` wire payload** {#s01-menu-state-payload}

Posted by `lib/host-menu-state.ts` to `webkit.messageHandlers.menuState`. Wire contract with `AppDelegate`'s `MenuState` parser — keep both sides in sync.

```jsonc
{
  "panes": [                       // z-order, topmost last reversed to first (as today)
    { "id": "...", "title": "...", "focused": true,
      "cardCount": 2, "closable": true }
  ],
  "activeCard": {                  // focused pane's active card; null when no panes
    "component": "dev",            // componentId from the card registry
    "closable": true
  },
  "dev": {                         // null unless activeCard.component == "dev"
    "cardId": "...",
    "sessionBound": true,          // cardSessionBindingStore has a binding
    "canInterrupt": false,         // CodeSessionStore snapshot.canInterrupt
    "permissionMode": "default",   // sessionMetadataStore (live) ?? persisted ?? "default"
    "hasAssistantMessage": false,  // transcript contains >=1 assistant entry
    "hasTurns": false              // transcript contains >=1 completed turn (rewind gate)
  }
}
```

**Spec S02: new control frames (Swift → JS)** {#s02-control-frames}

| Action | Params | JS handling |
|---|---|---|
| `run-card-command` | `name: string` (LocalCommandName), `args?: string` | dispatch `RUN_SLASH_COMMAND {value:{name,args}}` via `sendToKeyCard` |
| `set-permission-mode` | `mode: string` | dispatch `SET_PERMISSION_MODE {value: mode}` via `sendToKeyCard` |
| `interrupt-session` | — | dispatch `INTERRUPT_SESSION` via `sendToKeyCard`; dev-card handler calls `codeSessionStore.interrupt()` |
| `find` / `find-next` / `find-previous` | — | Both-category: dispatch same-named chain action via `sendToFirstResponder` |
| `next-tab` / `previous-tab` | — | Both-category: dispatch via `sendToFirstResponder` (lands on `TugPane`'s wrap handlers) |
| `cycle-card` | — | Both-category: dispatch via `sendToFirstResponder` |
| `focus-prompt` | — | dispatch `FOCUS_PROMPT` via `sendToKeyCard` |
| `cycle-permission-mode` | — | dispatch `CYCLE_PERMISSION_MODE` via `sendToKeyCard` |
| `set-maker-mode` | `enabled: bool` | renamed `set-dev-mode` handler (no alias — clean rename) |

New `TUG_ACTIONS` entries: `SET_PERMISSION_MODE` (`"set-permission-mode"`, payload `value: string`) and `INTERRUPT_SESSION` (`"interrupt-session"`, no payload), both handled by the dev card's card-content responder.

**Table T01: target menu structure** {#t01-menu-structure}

Identifiers in parentheses; `▸` marks submenus. Existing-and-unchanged items marked “(as today)”.

| Menu | Item | Key | Identifier | Action path |
|---|---|---|---|---|
| Tug | About Tug | — | `app.about` | `show-card about` (as today) |
| Tug | Settings… | ⌘, | `app.settings` | `show-card settings` (as today) |
| Tug | Services / Hide / Hide Others / Show All / Quit | std | `app.*` | native (as today) |
| File | New Dev Card | ⌘N | `file.newDevCard` | `show-card dev` |
| File | New Git Card | ⇧⌘N | `file.newGitCard` | `show-card git` |
| File | New Card in Active Pane | ⌘T | `file.newCardInPane` | `add-card-to-active-pane` (existing frame) |
| File | Close Card / Close Pane | ⌘W | `file.closeCard` | `close` (as today) |
| File | Close All Cards | ⌥⌘W | `file.closeAllCards` | `close-all` (as today) |
| File | Export Transcript… | — | `file.exportTranscript` | `run-card-command export` |
| Edit | Undo / Redo / Cut / Copy / Paste / Delete / Select All | std | `edit.*` | native selectors (as today) |
| Edit | Copy Last Response | — | `edit.copyLastResponse` | `run-card-command copy` |
| Edit | Find ▸ Find | ⌘F | `edit.find` | `find` frame |
| Edit | Find ▸ Find Next | ⌘G | `edit.findNext` | `find-next` frame |
| Edit | Find ▸ Find Previous | ⇧⌘G | `edit.findPrevious` | `find-previous` frame |
| Session | Focus Prompt | ⌘K | `session.focusPrompt` | `focus-prompt` frame |
| Session | Stop | — | `session.stop` | `interrupt-session` frame |
| Session | New Session | — | `session.new` | `run-card-command clear` |
| Session | Resume Session… | — | `session.resume` | `run-card-command resume` |
| Session | Rename Session… | — | `session.rename` | `run-card-command rename` |
| Session | Model… | — | `session.model` | `run-card-command model` |
| Session | Reasoning Effort… | — | `session.effort` | `run-card-command effort` |
| Session | Permission Mode ▸ Default/Accept Edits/Plan/Auto | — | `session.permissionMode.<mode>` | `set-permission-mode <mode>` |
| Session | Permission Mode ▸ Cycle Permission Mode | ⇧⌘P | `session.permissionMode.cycle` | `cycle-permission-mode` frame |
| Session | Permission Rules… | — | `session.permissionRules` | `run-card-command permissions` |
| Session | Rewind… | — | `session.rewind` | `run-card-command rewind` |
| Session | Compact Conversation | — | `session.compact` | `run-card-command compact` |
| Session | Add Working Directory… | — | `session.addDir` | `run-card-command add-dir` |
| Session | Show Changes | — | `session.diff` | `run-card-command diff` |
| Session | Show Context | — | `session.context` | `run-card-command context` |
| Session | Skills / Agents / Hooks / Memory | — | `session.skills` etc. | `run-card-command <name>` |
| View | Theme ▸ (dynamic) + Next Theme ⌥⌘T | — | `view.theme.<name>`, `view.nextTheme` | as today, relocated |
| View | Actual Size / Zoom In / Zoom Out | ⌘0 ⌘+ ⌘− | `view.actualSize` etc. | as today (incl. hidden ⌘= alias) |
| Window | Minimize / Zoom | ⌘M / — | `window.*` | native (as today) |
| Window | Cascade / Tile | ⌃⌥C / ⌃⌥T | `window.cascade`, `window.tile` | `arrange-cards` (as today, relocated) |
| Window | Previous Card / Next Card | ⇧⌘[ / ⇧⌘] | `window.previousCard`, `window.nextCard` | `previous-tab` / `next-tab` frames |
| Window | Cycle Panes | ⌃` | `window.cyclePanes` | `cycle-card` frame |
| Window | (dynamic pane list, checkmark on focused) | — | `window.pane.<n>` | `focus-pane` (as today, relocated) |
| Window | Enter Full Screen / Bring All to Front | ⌃⌘F / — | `window.*` | native (as today) |
| Maker | Reload | ⌘R | `maker.reload` | `reload` (as today) |
| Maker | Show JavaScript Console | ⌥⌘C | `maker.jsConsole` | as today |
| Maker | Show Dev Panel | ⌥⌘/ | `maker.devPanel` | as today |
| Maker | New Component Gallery Card | ⌥⌘N | `maker.galleryCard` | relocated from File ▸ New (debug-gated) |
| Maker | New Hello World Card | ⇧⌥⌘N | `maker.helloCard` | relocated from File ▸ New (debug-gated) |
| Maker | Source Tree… | — | `maker.sourceTree` | as today |
| Help | Keyboard Shortcuts & Commands | — | `help.shortcuts` | `run-card-command help` |
| Help | Project Home / GitHub | — | `help.*` | as today |

Removed outright: Edit ▸ Use Selection for Find (dead), Developer ▸ Add Card to Active Pane (superseded by `file.newCardInPane`), the File ▸ New submenu shell.

**Table T02: validation tiers** {#t02-validation-tiers}

| Tier | Predicate source | Items |
|---|---|---|
| 1 — always | — | Tug menu, File new items*, Edit natives, Find trio, View, Window natives/arrange, Maker, Help links |
| 2 — deck state | `panes` | `file.newCardInPane` (≥1 pane), `file.closeCard` (closable, as today), `file.closeAllCards` (cardCount > 1, as today), `window.previousCard`/`window.nextCard` (focused cardCount > 1), `window.cyclePanes` (≥2 panes) |
| 3 — card type | `activeCard.component == "dev"` | every Session item, `edit.copyLastResponse`, `file.exportTranscript`, `help.shortcuts` |
| 4 — session state | `dev` block | `session.stop` (`canInterrupt`), `session.rewind` (`sessionBound && hasTurns`), `edit.copyLastResponse` (`hasAssistantMessage`), all other Session items below Focus Prompt (`sessionBound`); permission-mode checkmark from `permissionMode` |

\* Tier-3/4 predicates imply tier 3 ⊃ tier 4: an item listed in both tiers requires both.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| host menu state aggregate (`lib/host-menu-state.ts`) | structure mirror, **no React consumer** (Swift consumes it) | plain module store: `DeckManager` subscription + explicit `publishDevMenuState(cardId, …)` calls; diff + microtask coalesce + `postMessage` | [L02] n/a (no React read); module mirrors stores, never drives render |
| dev card → menu-state publication | n/a (side effect, not render-driving) | direct store observation per [L22]: an effect subscribes to `CodeSessionStore` / `sessionMetadataStore` / binding-store and calls the module on change — NOT derived from render-bound hook values re-published per render | [L22], [L07] |
| Settings App-tab Maker toggle | local-data | `useState` seeded from `getSettings` bridge read; commit via `setMakerMode` postMessage | [L02] not external-store state (bridge RPC, session-local) |
| permission-mode submenu checkmarks | n/a (AppKit) | `menuNeedsUpdate` rebuild from cached `MenuState` | — |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun, pure logic)** | aggregator projection/diff correctness | `host-menu-state` payload building from synthetic snapshots |
| **Integration (app-test)** | real app, real menus, real validation | structure snapshot, per-tier enablement, chord round-trips, mode checkmarks, maker gate |
| **Golden / Contract** | menu structure as a contract | `menuSnapshot` identifier/key-equivalent assertions (Table T01) |

#### What stays out of tests {#test-non-goals}

- Mock-store call-count tests and hand-rolled core-interface mocks — banned project-wide.
- Fake-DOM render tests — banned; menu behavior is asserted through the real app via the harness.
- Re-testing each slash-command *surface* (sheets already covered by at0088/at0090/at0097/at0099/at0104/at0107) — this plan tests that the menu *reaches* the surfaces, not the surfaces themselves.
- Vite/dev-serving behavior of the maker toggle — serving plumbing is unchanged; only the gate naming and the toggle UI are new.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | menuState channel replaces cardList | done | f1b3a103 |
| #step-2 | Dev-card session state in menuState | done | 2aaf6e37 |
| #step-3 | Control-frame adapters in tugdeck | done | 8e132244 |
| #step-4 | Menu restructure: File/Edit/View/Window/Help | done | a037ff8e |
| #step-5 | Session menu + four-tier validation | done | 9e89744b |
| #step-6 | Maker rename + tugbank key migration | done | 524f02e2 |
| #step-7 | Settings App tab: Maker Mode toggle | done | c7272161 |
| #step-8 | App-tests: structure + deck-tier validation | done | d97c7566 |
| #step-9 | App-tests: session-tier validation | done | 7ea24392 |
| #step-10 | Docs: tuglaws menu reference | done | 971dc89f |
| #step-11 | Integration checkpoint | done | n/a (verification only) |

#### Step 1: menuState channel replaces cardList {#step-1}

**Commit:** `menuState host push: aggregator module replaces cardList channel`

**References:** [P04] menuState push, [P11] pull validation, Spec S01, Table T03, Risk R01, (#s01-menu-state-payload, #r01-menu-state-churn, #behavioral-nuances)

**Artifacts:**
- New `tugdeck/src/lib/host-menu-state.ts` — aggregator: deck projection (panes + activeCard), diff, microtask coalesce, `postMessage` to `menuState`.
- `deck-manager.ts`: `pushCardListToHost` removed; `notify()` feeds the aggregator instead (module init takes the DeckManager subscription).
- Swift: `MainWindow` registers `menuState` handler (drops `cardList`); `AppDelegate` gains a `MenuState` struct + parser replacing `cachedCardList` / `updateCardList`; the existing close-item and View-pane-list logic reads from it with identical semantics.
- Stale `cardList` references swept: the harness types name no cardList payload (verified), so this is a comment/doc sweep — at0166/at0167 test comments and `tuglaws/responder-chain.md` (touched by `9ff9cb4d`, names the payload) update to say `menuState`.

**Tasks:**
- [ ] Implement the aggregator with a pure projection function (deck snapshot → Spec S01 sans `dev` block) exported for unit tests.
- [ ] Diff serialized projections; post only on change, coalesced on a microtask.
- [ ] Swift `MenuState` decoding with defensive defaults (absent `dev` → nil; absent fields → false).
- [ ] Re-point `focusedPaneEntry` / `focusedPaneCardCount` / `focusedPaneActiveCardClosable` and the View-menu pane-list builder at `MenuState`.

**Tests:**
- [ ] bun unit: projection from synthetic deck snapshots (focused pane, counts, closable, activeCard component, empty deck → `activeCard: null`).
- [ ] bun unit: diff suppresses identical consecutive payloads.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check && bun test`
- [ ] `just build-app`
- [ ] `just app-test tests/app-test/at0166-close-confirm-multitab-and-close-all.test.ts` → `VERDICT: PASS`
- [ ] `just app-test tests/app-test/at0167-file-menu-close-validation.test.ts` → `VERDICT: PASS`

---

#### Step 2: Dev-card session state in menuState {#step-2}

**Depends on:** #step-1

**Commit:** `menuState: dev card publishes session block (bound, interrupt, mode, transcript facts)`

**References:** [P04] menuState push, Spec S01, Table T02, (#s01-menu-state-payload, #t02-validation-tiers, #state-zone-mapping)

**Artifacts:**
- `host-menu-state.ts` gains `publishDevMenuState(cardId, devBlock)` / `clearDevMenuState(cardId)`; the aggregator attaches the block for the focused pane's active dev card.
- Dev card body: an effect that *directly subscribes* to `CodeSessionStore`, `sessionMetadataStore`, and `cardSessionBindingStore` (per [L22] — publication is a side effect, not render-driving; do not derive from render-bound hook values) computes the dev block (`sessionBound`, `canInterrupt`, `permissionMode` with the chip's live ?? persisted ?? "default" fallback, `hasAssistantMessage`, `hasTurns`) and publishes on change; cleanup clears.
- Swift `MenuState.dev` parsing.

**Tasks:**
- [ ] Derive `permissionMode` exactly as `permission-mode-chip.tsx` does (live metadata ?? persisted per-card ?? `"default"`), factored so both read one helper.
- [ ] Derive `hasAssistantMessage` / `hasTurns` from the transcript snapshot reference (cheap checks on `Object.is`-stable references).
- [ ] The dev card publishes its own state unconditionally; the aggregator (not the card) decides whether the block rides the payload, by checking which card is the focused pane's active card.

**Tests:**
- [ ] bun unit: aggregator attaches/clears the dev block keyed to the focused pane's active card; non-dev active card → `dev: null`.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check && bun test`
- [ ] `just build-app`

---

#### Step 3: Control-frame adapters in tugdeck {#step-3}

**Commit:** `Control frames for menu commands: run-card-command, set-permission-mode, interrupt-session, chain adapters`

**References:** [P03] run-card-command, [P06] permission-mode submenu, [P08] find rewire, [P10] stop, Spec S02, Risk R02, (#s02-control-frames, #r02-chord-swallow)

**Artifacts:**
- `action-dispatch.ts` registrations per Spec S02 (`run-card-command`, `set-permission-mode`, `interrupt-session`, `find`, `find-next`, `find-previous`, `next-tab`, `previous-tab`, `cycle-card`, `focus-prompt`, `cycle-permission-mode`).
- `action-vocabulary.ts`: `SET_PERMISSION_MODE`, `INTERRUPT_SESSION` with payload docs.
- `dev-card.tsx` card-content responder: `SET_PERMISSION_MODE` handler committing through the chip's mode-set path; `INTERRUPT_SESSION` handler calling `codeSessionStore.interrupt()`.

**Tasks:**
- [ ] Both-category registrations use the `TUG_ACTIONS.*` constant at both the register and dispatch site per `tuglaws/action-naming.md`.
- [ ] `run-card-command` narrows `name` to string, passes `args ?? ""`; unregistered names rely on the dev card's defensive surface-map lookup (silent no-op).
- [ ] `set-permission-mode` validates the mode against the menu mode set before dispatch.

**Tests:**
- [ ] bun unit (pure logic): payload narrowing for `run-card-command` / `set-permission-mode` handlers (registry exercised via `dispatchAction` with `_resetForTest`).

**Checkpoint:**
- [ ] `cd tugdeck && bun run check && bun test`

---

#### Step 4: Menu restructure — File/Edit/View/Window/Help {#step-4}

**Depends on:** #step-1, #step-3

**Commit:** `Menu restructure: flatten New, rewire Find, Theme to View, arrangement and pane list to Window, identifiers everywhere`

**References:** [P01] bar structure, [P07] identifiers, [P08] find rewire, [P11] pull validation, [P12] window-menu sectioned rebuild, Table T01, Table T02, Risk R02, (#t01-menu-structure, #t02-validation-tiers, #p12-window-menu-sectioned)

**Artifacts:**
- `buildMenuBar()` rewritten for File / Edit / View / Window / Help per Table T01 (Session menu placeholder added in #step-5; Developer menu untouched until #step-6).
- Identifiers on every item incl. dynamic theme/pane items minted in `menuNeedsUpdate` ([P07]).
- `validateMenuItem` extended with tier-2 predicates (`file.newCardInPane`, `window.previousCard`/`nextCard`, `window.cyclePanes`) and tier-3/4 for `edit.copyLastResponse` / `file.exportTranscript`.
- Removed: New submenu shell, NSTextView find items, Use Selection for Find; View loses theme/cascade/tile/pane list to their new homes.

**Tasks:**
- [ ] Move the `themeMenu` NSMenuDelegate machinery under View unchanged.
- [ ] Pane list moves to the Window menu per [P12]: a delimited `window.pane.*` slice managed in place in `menuNeedsUpdate` — remove only items with the `window.pane.` identifier prefix, re-insert at the tracked section index. **Never** `removeAllItems()` on the menu assigned to `NSApp.windowsMenu`.
- [ ] Keep the zoom epsilon enablement logic as-is (build-time, [P11] exception).
- [ ] Wire Edit ▸ Copy Last Response and File ▸ Export Transcript through `run-card-command` (`copy`, `export`).
- [ ] Window ▸ Previous/Next Card and Cycle Panes send their Spec S02 frames; verify ⇧⌘[/⇧⌘]/⌃` still work end-to-end in-app (chord now swallowed by the menu).

**Tests:**
- [ ] (deferred to #step-8 app-tests; this step's checkpoint is build + existing suites)

**Checkpoint:**
- [ ] `just build-app`
- [ ] `just app-test tests/app-test/at0167-file-menu-close-validation.test.ts` → `VERDICT: PASS`
- [ ] Manual smoke: ⌘F/⌘G/⇧⌘[/⇧⌘]/⌃` reach their chain handlers in the running app

---

#### Step 5: Session menu + four-tier validation {#step-5}

**Depends on:** #step-2, #step-3, #step-4

**Commit:** `Session menu: dev-card command surfaces, live Stop, permission-mode radio submenu`

**References:** [P02] disabled-not-hidden, [P03] run-card-command, [P06] permission-mode submenu, [P10] stop, Spec S02, Tables T01-T03, (#p02-session-disabled-not-hidden, #p06-permission-mode-submenu, #behavioral-nuances)

**Artifacts:**
- Session menu built per Table T01 between Edit and View; one `runCardCommand(_:)` selector with `representedObject` command names; `interrupt-session` for Stop; `focus-prompt` for Focus Prompt ⌘K; permission-mode submenu with `menuNeedsUpdate` checkmarks + Cycle item ⇧⌘P.
- `validateMenuItem` tier-3/4 predicates over `MenuState.dev` per Table T02.
- Help ▸ Keyboard Shortcuts & Commands (`run-card-command help`, tier 3).

**Tasks:**
- [ ] Permission-mode submenu: four static items (Default / Accept Edits / Plan / Auto) with mode strings on `representedObject`, `.on` from `MenuState.dev.permissionMode`, rebuilt in `menuNeedsUpdate`.
- [ ] All Session items validate disabled when `activeCard.component != "dev"` ([P02]); sub-predicates per Table T02.
- [ ] ⌘K / ⇧⌘P now swallowed by menu — confirm round-trips land (key-card scope) with a dev card and are inert beeps-suppressed otherwise (disabled item).

**Tests:**
- [ ] (app-test coverage lands in #step-9)

**Checkpoint:**
- [ ] `just build-app`
- [ ] Manual smoke: with a bound dev card, Session ▸ Model… opens the model sheet; Permission Mode shows the live checkmark; Stop enables only mid-turn

---

#### Step 6: Maker rename + tugbank key migration {#step-6}

**Depends on:** #step-4

**Commit:** `Developer menu becomes Maker; maker-mode-enabled tugbank key with legacy fallback`

**References:** [P05] rename boundary, [Q01] resolved, Risk R05, Table T01, (#p05-maker-rename-boundary, #r05-app-test-maker)

**Artifacts:**
- Swift: `makerMenu` titled "Maker"; `makerModeEnabled`, `updateMakerMenuVisibility`, `bridgeSetMakerMode`; `MainWindow` message handler renamed `setMakerMode`; alert strings ("Go to Maker > Source Tree…"); gallery/hello creators moved in (⌥⌘N / ⇧⌥⌘N, debug-gated); "Add Card to Active Pane" removed.
- `TugConfig`: `keyMakerModeEnabled = "maker-mode-enabled"`; `loadPreferences` reads new key, falls back to `dev-mode-enabled` with write-through; `savePreferences` writes the new key only.
- `TUGAPP_APP_TEST` force narrowed to the serving decision; the menu-visibility preference reads tugbank normally (Risk R05).
- tugdeck: `set-maker-mode` action registered (no alias); webkit postMessage call sites renamed.
- Bridge callback identifiers renamed in lockstep (safe — no live JS defines `window.__tugBridge` today, so there is no consumer to break): `MainWindow`'s `setMakerMode` response calls `window.__tugBridge?.onMakerModeChanged?.(…)`, and `getSettings`'s `onSettingsLoaded` payload field becomes `makerMode` (was `devMode`). Step 7 defines the receiver to match.

**Tasks:**
- [ ] One boundary comment where `makerModeEnabled` feeds `sendDevMode(...)` noting the user-facing vs wire naming ([P05]).
- [ ] Split the `TUGAPP_APP_TEST=1` force (today one boolean override in `loadPreferences` gates both serving and menu visibility): introduce a serving-only flag so the harness still loads prebuilt `dist/` from tugcast, while `makerModeEnabled` (and the Maker menu gate) reads tugbank normally — this is what lets #step-8's maker-gate test see the menu (Risk R05).
- [ ] Grep both trees for remaining user-facing "Developer"/"dev mode" strings in this surface (dev-info overlay content stays).

**Tests:**
- [ ] (maker-gate app-test lands in #step-8)

**Checkpoint:**
- [ ] `cd tugdeck && bun run check && bun test`
- [ ] `just build-app`

---

#### Step 7: Settings App tab — Maker Mode toggle {#step-7}

**Depends on:** #step-6

**Commit:** `Settings: App tab with Maker Mode toggle over the setMakerMode bridge`

**References:** [P09] settings app tab, [Q02] resolved, (#p09-settings-app-tab, #state-zone-mapping)

**Artifacts:**
- `settings-card.tsx`: `TABS` gains `{ id: "app", label: "App" }`; new `settings-app-body.tsx` with a Maker Mode switch row (copy notes the reload).
- New `tugdeck/src/lib/maker-mode-bridge.ts` — the JS receiver side of the settings bridge, which today has **no live definition** (the archived settings UI owned it): defines `window.__tugBridge` with `onSettingsLoaded` / `onMakerModeChanged` receivers and exports promise-wrapped `getSettings()` / `setMakerMode(enabled)` over the WKScriptMessage handlers. Callback names match Step 6's renamed Swift emit strings.
- Initial state via the bridge module's `getSettings()`; commit via its `setMakerMode(enabled)`.

**Tasks:**
- [ ] Use existing Tug components (TugSwitch row pattern from the gallery / settings general body) — no hand-rolled controls.
- [ ] Graceful degradation in browser dev (bridge absent → row disabled with a hint), matching `pickPath`'s availability pattern.

**Tests:**
- [ ] (app-test: toggling under the harness is destructive to the run — assert presence/identifier only in #step-8's structure test; behavior verified manually)

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `just build-app`
- [ ] Manual smoke: toggle flips the Maker menu visibility (with reload)

---

#### Step 8: App-tests — structure + deck-tier validation + maker gate {#step-8}

**Depends on:** #step-4, #step-6, #step-7

**Commit:** `app-tests: menu structure contract, deck-tier validation, maker-mode gate`

**References:** [P01] bar structure, [P07] identifiers, Tables T01-T02, Risk R05, (#t01-menu-structure, #success-criteria)

**Artifacts:**
- `at01xx-menu-structure.test.ts`: `menuSnapshot` asserts menus, identifiers, key equivalents per Table T01 (incl. removed items absent; Session present; Maker hidden under default app-test prefs).
- `at01xx-menu-deck-validation.test.ts`: `menuItemState` for tier-2 items across single-pane / multi-pane / multi-card decks (`file.newCardInPane`, `window.nextCard`, `window.cyclePanes`).
- `at01xx-maker-mode-gate.test.ts`: seeded `TUGBANK_PATH` with `maker-mode-enabled=true` → Maker menu visible in `menuSnapshot`; `false` → hidden.

**Tasks:**
- [ ] Assert by identifier only ([P07]); never by title.
- [ ] Each test ends with the greppable `VERDICT: PASS|FAIL` line per the app-test recipe.

**Tests:**
- [ ] The three test files above.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at01xx-menu-structure.test.ts` → `VERDICT: PASS`
- [ ] `just app-test tests/app-test/at01xx-menu-deck-validation.test.ts` → `VERDICT: PASS`
- [ ] `just app-test tests/app-test/at01xx-maker-mode-gate.test.ts` → `VERDICT: PASS`

---

#### Step 9: App-tests — session-tier validation {#step-9}

**Depends on:** #step-5, #step-8

**Commit:** `app-tests: Session menu card-type and session-state validation`

**References:** [P02] disabled-not-hidden, [P06] permission-mode submenu, Spec S01, Table T02, (#t02-validation-tiers, #success-criteria)

**Artifacts:**
- `at01xx-session-menu-card-type.test.ts`: git card frontmost → all `session.*` items disabled; bound dev card frontmost (at0099-pattern session) → tier-3 enabled, `session.stop` disabled while idle.
- `at01xx-session-menu-live-state.test.ts`: permission-mode checkmark follows the chip's mode (at0105 pattern to change mode, then `menuItemState` on `session.permissionMode.<mode>`); selecting a mode item via the menu changes the chip; `edit.copyLastResponse` flips enabled once a transcript carries an assistant message.

**Tasks:**
- [ ] Reuse the dev-session harness patterns from at0099/at0105/at0107 to bind a session and drive state — no hand-rolled session mocks.
- [ ] If driving `canInterrupt=true` deterministically proves flaky under the harness, assert the disabled-at-idle half plus the `menuState`-payload unit coverage from #step-2, and note the gap in the test header.

**Tests:**
- [ ] The two test files above.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at01xx-session-menu-card-type.test.ts` → `VERDICT: PASS`
- [ ] `just app-test tests/app-test/at01xx-session-menu-live-state.test.ts` → `VERDICT: PASS`

---

#### Step 10: Docs — tuglaws menu reference {#step-10}

**Depends on:** #step-5, #step-6

**Commit:** `tuglaws: menu architecture reference (menuState channel, validation tiers, identifier namespace)`

**References:** [P03] run-card-command, [P04] menuState push, [P07] identifiers, [P11] pull validation, Specs S01-S02, Tables T01-T02

**Artifacts:**
- `tuglaws/menus.md`: the menuState wire contract, the control-frame catalog, the four validation tiers, the identifier namespace, and the rule that a promoted menu chord requires a Both-category round-trip.

**Tasks:**
- [ ] Cross-link from `tuglaws/action-naming.md`'s Both-category discussion.

**Tests:**
- [ ] n/a (docs)

**Checkpoint:**
- [ ] Doc exists, links resolve, tables match the shipped structure

---

#### Step 11: Integration Checkpoint {#step-11}

**Depends on:** #step-8, #step-9, #step-10

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every Success Criteria bullet against the running app and the test suite output.

**Tests:**
- [ ] Full app-test sweep of the new at01xx files plus at0166/at0167.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check && bun test`
- [ ] `just build-app`
- [ ] All menu app-tests `VERDICT: PASS`; `cd tugrust && cargo nextest run` unaffected

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A complete, validated, card-sensitive macOS menu bar — Tug · File · Edit · Session · View · Window · Maker · Help — where every item is identifier-addressable, every enablement flows from one MenuState cache, and the dev card's full command surface is reachable natively.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `menuSnapshot` matches Table T01 (structure app-test green).
- [ ] All four validation tiers behave per Table T02 (deck/session app-tests green).
- [ ] Maker rename complete through the [P05] boundary; clean key rename with every client updated (maker-gate app-test green).
- [ ] Settings ▸ App hosts a working Maker Mode toggle.
- [ ] No dead menu items remain (find trio rewired; Use Selection for Find gone).
- [ ] Every promoted chord works in-app via its round-trip (manual smoke + chord assertions).

**Acceptance tests:**
- [ ] at01xx menu structure / deck validation / maker gate / session card-type / session live-state, plus at0166–at0167 regression.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Native Model submenu from the `session_capabilities` handshake ([Q03]).
- [ ] Window-menu ⌘1–9 per-card sublist for the focused pane (Safari-style).
- [ ] `REOPEN_TAB` (⇧⌘T) once deck-manager grows closed-tab history.
- [ ] Route-selector menu items (⇧⌘C / ⇧⌘S prompt routes) if menu discoverability is wanted there.

| Checkpoint | Verification |
|------------|--------------|
| Structure contract | `at01xx-menu-structure` `VERDICT: PASS` |
| Validation tiers | deck + session app-tests `VERDICT: PASS` |
| Maker gate | seeded-DB app-test `VERDICT: PASS` |
| Builds green | `just build-app`, `bun run check`, `bun test`, `cargo nextest run` |
