# Command-Action Audit Brief

*A full audit of the way Tug issues commands-as-actions through the Swift menu system, the keyboard shortcut system, and the internal action-like surfaces that could reasonably be exposed there. Covers the five legs: (A) the commands-as-actions inventory, (B) validation code, (C) state-query functions, (D) the allocated-shortcut audit, and (E) the menu survey. Grounded in [tuglaws/action-naming.md](../tuglaws/action-naming.md), [tuglaws/responder-chain.md](../tuglaws/responder-chain.md), [tuglaws/lifecycle-delegates.md](../tuglaws/lifecycle-delegates.md), and [tuglaws/menus.md](../tuglaws/menus.md).*

---

## 0. The architecture as it stands

Every command in Tug flows through one of three shapes, per [action-naming.md](../tuglaws/action-naming.md)'s three-way classification:

- **Chain actions** — `TUG_ACTIONS.*` constants in `tugdeck/src/components/tugways/action-vocabulary.ts`, dispatched by the responder-chain walk (`sendToFirstResponder` / `sendToTarget`), handled by responders via `useResponder`.
- **Control-frame-only actions** — wire names registered in `tugdeck/src/action-dispatch.ts` via `registerAction`, reached by Swift `sendControl(...)` (or tugcast), never walking the chain.
- **Both (identity) entries** — same wire string on both sides; the control-frame handler is a one-liner that re-dispatches the chain action. The menu bar is the main producer of these, because AppKit swallows a menu chord before the WKWebView sees the keydown.

State flows the other way through exactly one channel: `tugdeck/src/lib/host-menu-state.ts` assembles a `MenuStatePayload` (microtask-coalesced, JSON-diffed, `host-menu-state.ts:556-604`) and posts it to `webkit.messageHandlers.menuState`; `AppDelegate.updateMenuState(_:)` (`AppDelegate.swift:1731`) replaces a cached `MenuState` struct wholesale. All menu enablement is then a synchronous pull against that cache in the app's single `NSMenuItemValidation` implementation, `AppDelegate.validateMenuItem(_:)` (`AppDelegate.swift:1795-1959`). Cold start is `MenuState.empty`, so every state-gated item begins disabled.

Two structural facts the rest of this brief leans on:

1. **There is no synchronous Swift→JS query path at menu-open time, and there cannot be one.** The only response-carrying Swift→JS primitive is `callAsyncJavaScript` (`MainWindow.swift:636`), async-completion-only, with a single production caller (the quit path, `AppDelegate.swift:480`). `validateMenuItem` also runs inside AppKit's closed-menu key-equivalent scan, so it must stay fast and synchronous. **Validation and state queries must therefore ride the push, as data — the push-mirror model is not a compromise, it is the design.**
2. **The push-mirror already has one fully-worked precedent: the Edit menu.** `computeEditCapabilities(chain)` (`host-menu-state.ts:131-152`) evaluates `chain.validateAction(...)` for 13 edit capabilities on every `validationVersion` bump (plus a `registerEditCapsRefresher` escape hatch for intra-responder flips like undo depth, `responder-chain-provider.tsx:206-278`), and the Swift edit tier (`AppDelegate.swift:1908-1957`) reads the mirrored flags. Legs B and C below are, at heart, "generalize this precedent to every menu-exposed action."

---

## A. The commands-as-actions inventory

### A.1 Counts and shape

| Category | Count | Source of truth |
|---|---|---|
| Chain actions (`TUG_ACTIONS`) | ~95 constants | `action-vocabulary.ts` |
| Gallery-only actions | 4 | `TUG_GALLERY_ACTIONS` |
| Control-frame-only wires | ~45 registered (≈20 of them tugcast data frames, not commands) | `action-dispatch.ts` |
| "Both" identity entries | 32 | `action-dispatch.ts` re-dispatch loops (`:752-996`) |
| Swift menu `sendControl` sites | ~50 distinct wires | `AppDelegate.swift:1247-1628` |
| `run-card-command` slash bridges | 20 menu items | `AppDelegate.swift:1069-1127`, `:964`, `:1028`, `:1233` |
| JS `KEYBINDINGS` entries | 40 | `keybinding-map.ts:114-318` |

The "Both" population divides by re-dispatch mechanism: plain `sendToFirstResponder` (card/deck scope: `close`, `close-all`, `save` family, `zoom-*`, `add-card-to-active-pane`, `show-component-gallery`, `focus-lens`, `reveal-stack`, `cycle-stack`), `sendToFirstResponderForContinuation` with immediate continuation (edit/find/tab family), and `sendToKeyCard` (session scope: `focus-prompt`, `interrupt-session`, `cycle-permission-mode`, `set-permission-mode`, `toggle-changes-view`, `toggle-history-view`). The native-re-dispatch five (`cut`/`copy`/`paste`/`delete`/`select-all` via `NSApp.sendAction(NSText.<sel>)`, `AppDelegate.swift:1553-1577`) never cross the bridge at all.

### A.2 Orphan constants — declared, zero handlers

| Constant | Wire | Status |
|---|---|---|
| `RESET_LAYOUT` | `reset-layout` | Zero references anywhere. `DeckManager.arrangeCards` (`deck-manager.ts:1768`) is the natural mechanism; Window ▸ Reset Layout the natural door. |
| `MINIMIZE` / `MAXIMIZE` | `minimize` / `maximize` | Zero handlers; Window ▸ Minimize/Zoom are native-window-only today. |
| `SELECT_NONE` | `select-none` | Documented no-op (`action-vocabulary.ts:118-121`). Edit ▸ Deselect All candidate. |
| `FOCUS_NEXT` / `FOCUS_PREVIOUS` | `focus-next` / `focus-previous` | Deferred; ⇥/⇧⇥ owned by the provider's focus-walk stage. |
| `REOPEN_TAB` | `reopen-tab` | Deferred pending closed-tab history. Classic ⇧⌘T (free, see leg D). |
| `DELETE` | `delete` | **Live defect**: no responder registers it, so `chain.validateAction(DELETE)` is always false, so `menuState.edit.delete` is always false, so Edit ▸ Delete (`AppDelegate.swift:1021`) is permanently disabled — even though its selector would work via the native `NSText.delete:` re-dispatch. |
| `DUPLICATE` | `duplicate` | Gallery context menu only; no production handler. |

### A.3 One-sided doors

**Control-frame commands with a menu item but no browser-dev door and no chain participation** (dead in `bunx vite` dev, invisible to the chain's validation machinery): `new-text-card`, `open-quickly`, `open-file`, `clear-recent-documents`, `next-theme`, `set-theme`, `show-card` (about/hello/session/settings variants), `arrange-cards` (cascade/tile), `focus-pane`, `setup`, `logout`, `source-tree`.

**Chain actions with a chord but no menu item** (working but undiscoverable — the reverse gap, and a violation risk against menus.md's promoted-chord rule):

| Action | Chord | Natural home |
|---|---|---|
| `SHOW_DEVTOOLS` | ⌥⌘/ | Maker (or Help) menu |
| `MOVE_TO_SLOT` 1–9 | ⌘1…⌘9 | Window menu slot items |
| `SELECT_COMPOSER_ROUTE` (prompt) | ⇧⌘P | Session menu (Changes/History already have items) |
| `CYCLE_FOCUS_MODE` | ⌥⇥ | Session menu |
| `PREVIOUS_TURN` / `NEXT_TURN` / `FIRST_TURN` / `LAST_TURN` | ⌥⌘↑↓ / ⌥⇧⌘↑↓ | Session ▸ transcript navigation group |
| `OPEN_COMMAND_PICKER` | ⌘/ | Session menu |
| `SHOW_SETTINGS` | ⌘, (JS twin) | Already has a Swift item — but via a **different code path** (`show-card {component:settings}` vs the chain's `show-settings`); converge to one Both entry. |

**Registered actions with no door at all** (UI-internal, raw-string dispatch): `set-imposition`, `set-imposition-lens` (Lens Layouts), `assign-slot` (Lens slot picker), `focus-session-card` (Cards section), `open-diff` (changeset pop-out). All are candidates for constants + menu/chord exposure; `set-maker-mode` (`action-dispatch.ts:444`) is a dead door with no sender anywhere — the maker gate actually flows through the reverse `setMakerMode` WebKit bridge.

**Handler with no dispatcher**: `INSERT_SLASH_COMMAND` (`session-card.tsx:3871`) — `action-vocabulary.ts:365-368` claims ⌃⌘ chords dispatch it; no keybinding, no menu item, no `registerAction` exists.

### A.4 Action-like features below the action system

Candidates surfaced by the sweep, in rough order of promotion value:

- **Commit-mode enter/exit/land** (`lib/commit-mode-controller.ts`) — only `enter` has doors (⇧⌘P route select, `/commit`); `exit`/`land` have no action names.
- **Deck-manager verbs with no action**: `centerPane` (`deck-manager.ts:1090`), `pinLens` (`:1181`), explicit `showLensPane`/`hideLensPane` (`:1118`/`:1133`, only the toggle is exposed), `movePane` (`:1664`, drag-only).
- **Slash commands** (`lib/slash-commands.ts`) — the typed-command namespace (`/btw`, `/rewind`, `/model`, …). Twenty already have menu doors via `run-card-command`; the rest are picker/typed-only. **The `!` bang-command notion is extinct** (retired in `2d28be623`; no such commands exist anymore). What remains of the routing idea is exactly two *route* commands — **Prompt** and **Changes** — the composer's Z4A route tabs, carried by `SELECT_COMPOSER_ROUTE` with value `"prompt"` | `"changes"` and applied through `CommitModeController` (`session-card.tsx:3814-3820`): Prompt exits commit mode, Changes enters it.
- **PDF document verbs**: `ZOOM_TO_FIT`, `SET_PAGE_MODE` (fit-width/fit-page/spread) have handlers and context-menu doors but no View-menu items, despite `menuState.document` already existing to gate them.
- **Session interrupt duality**: `codeSessionStore.interrupt()` is called directly by the submit button (`session-card.tsx:3558`) and the setup wizard, parallel to the `INTERRUPT_SESSION` chain path — two call paths to one semantic.
- **Theme selection from the web side** — the web layer mutates theme without any action or host notification, which is why the Theme submenu re-reads tugbank on every open (see leg C).

---

## B. Validation — what exists, what the model should be

### B.1 Existing validation, web side

The chain already defines the two advisory hooks ([responder-chain.md § canHandle and validateAction](../tuglaws/responder-chain.md)):

- `manager.validateAction(action)` (`responder-chain.ts:913-929`) — walks from the first responder; the first node that *handles* terminates the walk and answers `node.validateAction?.(action) ?? true`; no handler anywhere → `false`.
- `manager.canHandle(action)` (`:894-906`) and `manager.nodeCanHandle(nodeId, action)` (`:1128-1136`) — capability, not validity; dispatch never consults either.
- Change notification: the `validationVersion` counter + `manager.subscribe` is the `useSyncExternalStore` surface controls already use.

**Coverage is the gap, not the mechanism.** Exactly three responders supply `validateAction` today: `DeckCanvas` (`deck-canvas.tsx:420`, a narrow allowlist made necessary by its `canHandle: () => true` last-resort role), `TugTextEditor` (`tug-text-editor.tsx:2400-2409`, undo/redo depth), and `TugTextCardEditor` (`tug-text-card-editor.tsx:1296-1319`, depth + read-only gates). Every other responder answers the default `true` for anything it handles. Two consumers are degenerate: `TugButton` aliases `chainValidated = chainCanHandle` (`tug-button.tsx:597`) despite its doc comment claiming both gates, and the text-surface context menus (`text-editing-menu.ts:93-137`) compute their own `hasSelection`/`canEdit` dimming without consulting the chain at all — the Swift Edit menu and the web context menu derive the same six items' enabled state from two independent sources.

### B.2 Existing validation, Swift side

One validator, five tiers (`AppDelegate.swift:1795-1959`): session prefix (card-type gate then per-item predicates), file/save verbs, deck-state, navigation/stack, and the edit-caps mirror. Identity rides `NSUserInterfaceItemIdentifier` stamped by `NSMenuItem.identified(_:)` (`:2447`), never the title. `autoenablesItems` is never set anywhere, so **every menu auto-enables and every nil-target item flows through the validator** — which is also why the four imperative `isEnabled` writes are defeated (defect ledger, §F).

### B.3 The macOS exemplars

The delegate callbacks worth modeling, and what each teaches:

- **`NSMenuItemValidation.validateMenuItem(_:)`** — per-item, pull-based, synchronous, called at menu open *and* during the closed-menu key-equivalent scan. The lesson Tug has already internalized: validation must be a cheap read of local state; the key-equivalent scan makes it a hot path (and is why key-equivalent mutation is banned inside it, `AppDelegate.swift:1633`).
- **`NSUserInterfaceValidations` / `validateUserInterfaceItem(_:)`** — the generalization AppKit added when toolbars and touch bars needed the same answers as menus: one validation protocol, many control surfaces, keyed by action + item identity. This is the exemplar for leg B's deliverable: Tug's per-action validity predicate should have **one definition** consumed by the Swift menu tier, `TugButton`, context menus, and any future toolbar — not one per surface.
- **Automatic enablement via the responder chain** — AppKit's nil-target resolution (`NSApp.target(forAction:)`) walking the responder chain to find who answers, already faithfully reimplemented by the test harness (`TestHarnessConnection.swift:498-515`). Tug's web chain mirrors this with `validateAction`'s first-handler-terminates walk; the two chains agree in shape, which is what makes the mirror coherent.
- **The Cocoa idiom validate-then-perform** — validity is asked *of the same object that would perform*, at the moment of asking, never cached inside the item. Tug's equivalent invariant: the predicate lives on the responder (or collocated with `registerAction`), and the menuState mirror is a projection of it, not a second opinion.

### B.4 Leg-B deliverable shape

For each inventory item, the requisite validation code, placed by category:

1. **Chain actions**: a `validateAction` branch on the owning responder. The audit's per-action handler map (§A) is the assignment sheet — e.g. `session-card.tsx`'s responder gains branches for `interrupt-session` (`canInterrupt`), turn navigation (`hasTurns` + position), `toggle-*-view`; `tug-pane.tsx` for `close-tab`/tab-navigation arity; `deck-canvas.tsx` extends its allowlist for slots/lens. Predicates read refs, not closures ([L07]).
2. **Control-frame-only actions**: `registerAction` today takes only a handler. Extend the registry entry to `{ handler, validate? }` so control-frame commands get collocated predicates (e.g. `open-quickly` → source-tree/panel availability; `next-theme` → themes present).
3. **The mirror**: generalize `computeEditCapabilities` into per-tier capability blocks in `MenuStatePayload` — the session block already carries hand-rolled examples (`canInterrupt`, `canChangeSettings`, `hasTurns`); the systematic version computes each menu-exposed action's flag from the single predicate in (1)/(2) and publishes on `validationVersion` bumps plus the existing refresher escape hatch.
4. **Consumers converge**: `TugButton` consults `validateAction` for real (fix `:597`); `buildTextEditingMenuItems` derives from the chain instead of parallel `hasSelection`/`canEdit` plumbing; Swift tiers read mirrored flags only.
5. **Turn-lifecycle interlock**: [L28] settings-decline-while-turn-live already flows as `canChangeSettings = snap.canSubmit` (`use-menu-state-publication.ts:75`); the generalized mirror keeps that pattern — lifecycle projections are inputs to predicates, never a parallel gate.

---

## C. State queries — what exists, what the model should be

### C.1 Existing checkmark/state precedents

Three native `.state = .on` sites, three different freshness strategies:

| What | Where written | Where the value comes from |
|---|---|---|
| Permission-mode radio | inside `validateMenuItem` (`AppDelegate.swift:1810`) — documented as "the single mechanism" | `menuState.session.permissionMode`, pushed; resolved web-side by the same `resolvePermissionMode` helper the chip uses (`permission-mode-chip.tsx:117-139`, `use-menu-state-publication.ts:69-77`) — one helper, two faces, no drift |
| Theme radio | `menuNeedsUpdate` rebuild (`:2312`) | tugbank re-read on every open (`:2263`) because the web layer changes theme without telling the host |
| Window pane focus mark | `menuNeedsUpdate` rebuild (`:2437`) | `menuState.panes[n].focused`, pushed |

Title-flipping is the fourth state-projection idiom (Show/Hide Changes & History from `session.changesVisible`/`historyVisible`, Undo/Redo labels from `edit.undoLabel`/`redoLabel` — all mutated inside the validation sweep). Web-side, the one real checkmark primitive is `TugPopupMenuItem.selected?: boolean` (`tug-popup-menu.tsx:115-121`, tri-state: `undefined` = no check column), supplied today by the pane slot-stack picker and title-bar menus.

### C.2 The macOS exemplars

- **`menuItem.state = .on / .off / .mixed`** — state is *display data on the item*, distinct from enablement, written wherever the item is refreshed (validation sweep for static items, `menuNeedsUpdate` for rebuilt ones). Tug already exercises both placements correctly.
- **`NSMenuDelegate.menuNeedsUpdate(_:)`** — per-menu, open-time-only, the sanctioned place for dynamic content + its state marks. Tug's View/Window/Theme/Open-Recent rebuilds are textbook.
- **The KVO/bindings lesson in push form** — AppKit apps mark state from model observation, not by interrogating the view. Tug's equivalent: the *current value* rides the menuState push as typed data (`permissionMode`, `changesVisible`, `stackDepth`, `panes[].focused`), and the menu projects it. The theme submenu is the documented exception (tugbank pull at open) and should be understood as compensation for a missing push — see defect ledger.

### C.3 Leg-C deliverable shape

For each inventory item with an "active" face (toggles, radios, current-value groups), a query function beside its validity predicate:

1. **Chain side**: add the optional sibling hook — `queryActionState?: (action) => boolean | string | undefined` on the responder node, walked exactly like `validateAction` (first handler terminates). Toggles answer booleans (`toggle-changes-view` → visible?), radios answer the current value (`set-permission-mode` → mode; `select-composer-route` → route), non-stateful actions answer `undefined`. Same `validationVersion` subscription drives refresh.
2. **Control-frame side**: the extended registry entry gains `state?` (e.g. `set-theme` → current theme name; `toggle-lens` → lens visible; `set-imposition` → current kind).
3. **The mirror**: state values join the same menuState blocks the validity flags ride; the permission-mode pattern (shared resolver helper, one value, chip + menu) is the template for every dual-faced state.
4. **Theme specifically**: give theme changes a push (publish current theme name in menuState) so the per-open tugbank read — including its subprocess fallback that blocks the menu open (`ProcessManager.swift:255-269`) — can be retired.

---

## D. Allocated-shortcut audit

### D.1 Layer model

All Swift key claims are `NSMenuItem` key equivalents — there are **no** `performKeyEquivalent` overrides, `NSEvent` local monitors, or `keyDown` overrides anywhere in `tugapp/Sources`. JS claims live in four strata: the static `KEYBINDINGS` map (stage-1 capture), CM6 keymaps (focused editors), scoped `useKeybindings` registrations (PDF card, gallery), and a handful of raw capture listeners (⌘. dismissals, commit-mode ⇧⌘M / ⌘., Escape aborts).

**Resolution rule**: AppKit resolves menu key equivalents before the WKWebView sees the keydown, so a Swift menu claim always wins in Tug.app; the JS twin exists for browser-only dev. ~27 chords are deliberately double-claimed this way. The exception: a *hidden* menu's chords fall through — when maker mode is off, the Maker menu is hidden and ⌘L / ⌥⌘L / ⇧⌘R / ⌘T / ⌥⌘C reach the JS layer (only `view.zoomInAlias` sets `allowsKeyEquivalentWhenHidden`).

### D.2 The full claim table

The master table (every chord, owner layer, file:line) is large; the durable copy belongs in tuglaws/menus.md when the doc is refreshed (drift item §E.2). Summary of ownership by band:

- **⌘ letters claimed**: A C F G H K L M N O Q R S T V W X Z, plus `,` `.` `/` `0-9` `+` `=` `-`. **Free: ⌘B ⌘D ⌘E ⌘I ⌘J ⌘P ⌘U ⌘Y** (⌘P notable — no Print; ⌘B/I/U are the conventional style trio, unclaimed).
- **⇧⌘ claimed**: C G H O P R Z `[` `]`, plus conditional S (Text card frontmost), M (commit mode only), Y (gallery only). **Free: A B D E F I J K L N Q T U V W X and all digits.**
- **⌥⌘ claimed**: C G H L N T V W `/` ↑ ↓. **Free: A B D E F I J K M O P Q R S U X Y Z and all digits.**
- **⌃⌘ claimed**: F P only. **⌃⌥ claimed**: C T only. **⌥⇧⌘ claimed**: C N V ↑ ↓ only.
- Dynamic assignments: ⌘R switches between Cycle Stack and Reveal Stack by preference (`applyStackChordKeyEquivalent`, `AppDelegate.swift:1635-1641`); ⇧⌘S attaches to Save As only while a Text card is frontmost (`:1754-1762`). Both are correctly mutated from `updateMenuState`, never from the validator.
- Non-menu substrate chords (⌃U ⌃W ⌥F ⌥B word/line editing, ⌘↩ forced submit, ⌥↑↓ history) are CM6/substrate-local and off the allocation board.

### D.3 Collision and label findings

- `text-editing-menu.ts:111` advertises **⇧⌘C** for Copy as Plain Text — the real chord is ⌥⇧⌘C, and ⇧⌘C is actually Session ▸ Show Changes. `:129` likewise advertises **⇧⌘V** for Paste as Plain Text (real: ⌥⇧⌘V). Stale labels pointing at chords that do something else.
- `AppDelegate.swift:1753-1755` comment claims clearing ⇧⌘S lets it "fall through to the web view's Shell-route chord" — no such JS binding exists; the comment is stale.
- ⌘. and Escape both dispatch `cancel-dialog` plus six local capture handlers; window-capture handlers pre-empt the chain listener by design (documented `tug-editor-context-menu.tsx:410-430`) — coherent, but the local ⇧⌘M commit-mode listener is a raw unregistered capture listener invisible to any audit surface.
- Menu-bar-only chords with no JS twin (dead in browser dev): ⌘N, ⌥⌘N, ⌘O, ⇧⌘O, ⇧⌘S, ⌘0/+/−, ⌥⌘T, ⌃⌥C, ⌃⌥T, ⌘R, ⇧⌘R, ⌥⌘G, ⌥⇧⌘N.

---

## E. Menu survey

### E.1 Shape

Eight top-level menus, all built statically in `buildMenuBar()` (`AppDelegate.swift:804-1242`). Dynamic content via `NSMenuDelegate.menuNeedsUpdate` on View (full rebuild), Theme (filesystem scan + tugbank read), Window (sectioned in-place pane list), Open Recent (existence-filtered, capped 10). Item-by-item detail lives in the leg-E survey; the shape per menu:

| Menu | Items | Web/native split | Validation posture |
|---|---|---|---|
| **Tug** | About, Updates, Setup, Log Out, Settings, Services, Hide/Quit group | About/Setup/Logout/Settings → web; rest native | Setup/Logout always enabled; About/Settings gating is dead code (defect 1) |
| **File** | New Session ⌘N, New Text File ⌥⌘N, Open ⌘O, Open Quickly ⇧⌘O, Open Recent ▸, Save family, Close ⌘W / Close All ⌥⌘W, Export Session | all web (Open panels native-first) | save family fully gated on `menuState.file`; New/Open always enabled |
| **Edit** | Undo/Redo (two-path native-token vs web), clipboard six + plain-text/quote variants, Delete, Select All, Copy Last Response, Find ▸ | native re-dispatch for the classic five; web frames for variants/find | edit-caps mirror; Delete permanently dead (defect 6) |
| **Session** | Focus Prompt ⌘K, Stop, 17 `run-card-command` bridges, Permission Mode ▸ (radios + Cycle ⌃⌘P), Show/Hide Changes ⇧⌘C / History ⇧⌘H | all web | card-type gate then `sessionBound`; checkmarks + title flips in validate sweep |
| **View** | Theme ▸ (dynamic), Actual Size ⌘0, Zoom In/Out | hybrid (document-gated web zoom vs native page zoom) | zoom enablement computed at rebuild but defeated by auto-enable (defect 2) |
| **Window** | Minimize/Zoom native, Cascade ⌃⌥C / Tile ⌃⌥T, card/pane navigation, Cycle/Reveal Stack (⌘R switch), dynamic pane list, Full Screen | mixed | navigation gated; pane items and cascade/tile ungated |
| **Maker** | Reload ⇧⌘R, JS Console ⌥⌘C, Focus/Show Lens ⌘L/⌥⌘L, gallery/hello/new-card (debug-only), Source Tree | mixed; two gates (runtime hide + compile-time debug) | ungated except New Card in Pane |
| **Help** | Shortcuts & Commands, Project Home, GitHub | first web, rest native | Shortcuts gated on session frontmost |

### E.2 Doc drift — tuglaws/menus.md

Twelve drift points found; the doc needs a refresh pass. Headlines: the wire block is documented as `dev` but code says `session` (`AppDelegate.swift:2636`, `host-menu-state.ts:569`); the JSON contract omits six top-level keys the decoder parses (`file`, `document`, `recentDocuments`, `openQuickly`, `selectionActive`, `stackDepth`/`stackChord`); the five-tier validation table omits the whole File/Text-card tier and the stack tier; the control-frame catalog lists two frames that don't exist as menu senders (`show-dev-panel-toggle` — stale everywhere; `set-maker-mode` — JS-registered but sender-less) and omits ~20 frames menus actually send; `maker.sessionPanel` doesn't exist; the theme-scan source (filesystem, so empty without a source tree) is unstated; the doc's "one exception" to pull-validation is actually four sites, none of which work (defect 2).

---

## F. Defect ledger

Concrete defects found by the audit, ordered by user-visible impact:

1. **Dead pre-ready gating on About/Settings** — `isEnabled = false` (`AppDelegate.swift:814`, `:849`) and the `bridgeFrontendReady` flip (`:2164-2165`) are no-ops: with `autoenablesItems` defaulting on, `validateMenuItem`'s `default: return true` (`:1963`) overrides imperative `isEnabled`.
2. **View zoom enablement defeated** — the rebuild-time `isEnabled` computation (`:2362-2378`) is overridden the same way; the documented "pull-validation exception" (`:2332`) does not survive auto-enabling. Fix: move both into `validateMenuItem` tiers (or set `autoenablesItems = false` on those menus — not recommended; one mechanism is better).
3. **⌘R beeps at stack depth ≤ 1** — the chord stays attached while both stack items validate disabled (`:1898`), so the key equivalent resolves, fails validation, and beeps instead of falling through.
4. **Edit ▸ Delete permanently disabled** — no responder registers `TUG_ACTIONS.DELETE`, so the mirrored `edit.delete` flag is always false (§A.2).
5. **`TugButton` ignores `validateAction`** — `tug-button.tsx:597` aliases validated to can-handle; the doc comment (`:215-220`) describes the intended behavior.
6. **Context-menu chord labels lie** — `text-editing-menu.ts:111`, `:129` (§D.3).
7. **Open Recent parent never disabled** despite the builder comment claiming it (`AppDelegate.swift:908`).
8. **`insert-slash-command` dead-ended**; **`set-maker-mode` unreachable**; **seven orphan constants** (§A.2, §A.3).
9. **Settings has two independent command paths** (Swift `show-card` vs chain `show-settings`) — converge to a Both entry.
10. **Context-menu dimming bypasses the chain** — two sources of truth for the six edit items (§B.1).
11. **tuglaws/menus.md drift** — twelve points (§E.2).
12. **Theme submenu blocks menu open on a tugbank read** with a subprocess fallback (`ProcessManager.swift:255-269`) to compensate for a missing state push (§C.3).

---

## G. The consolidation: command funnel, keyboard funnel, and the user keymap

The end-state this audit should serve: every command in Tug plumbs through a **single funnel point** where it is received, validated, and issued; every keyboard chord plumbs through a **second funnel point** that maps and controls access to the first; and on top of the two, an app-wide **keyboard-command configuration map** lets the user review, control, and customize their key mappings.

### G.1 What "one funnel" means here — and what it doesn't replace

The funnel is a *front door*, not a new routing system. [L11] and the responder chain stay exactly what they are: ownership and routing — the walk still decides *which responder* handles `close`. What consolidates is everything upstream of the walk: the many places a command can *enter* (menu wire, keybinding, button, slash bridge, raw `dispatchAction` string, direct store-method call) become one place. This is the Cocoa shape precisely: `NSApp.sendEvent` is the keyboard funnel, `NSApp.sendAction` is the command funnel, and the responder chain is the routing both feed. Tug already has three unformalized near-funnels — `dispatchAction` in `action-dispatch.ts` (every control frame), stage 1 of the keyboard pipeline (`responder-chain-provider.tsx`, every mapped chord), and `useControlDispatch` (every control) — plus the audit's finding that **Swift has zero key interception outside menu key equivalents**. Consolidation is mostly formalizing choke points that already exist, then closing the leaks around them.

### G.2 Funnel #1 — the command registry

One canonical table, one entry per user-invocable command, and one dispatch call — `dispatchCommand(id, payload?)` — that every emitter goes through. The entry is the natural container for everything legs A–C produced:

```
{ id,                      // TUG_ACTIONS constant or control-frame wire — the existing canonical names
  title,                   // menu/palette/keymap-UI display name (localizable, single source for labels)
  routing,                 // "first-responder" | "key-card" | "target" | "registry" | "native"
  validate?,               // leg B predicate — the one definition every surface consults
  state?,                  // leg C query — checkmark / radio-value projection
  bindings?,               // LIST of { chord, scope, source } — many chords per command by design (§G.5.2)
  menuPlacement?,          // menu + position, or none (palette/chord-only commands)
  scope }                  // "global" | "key-card" | card-component-scoped
                           // lockedness is NOT an entry field — it is policy, read from the
                           // maintained NATIVE_LOCKED list (§G.5.4)
```

`dispatchCommand` validates first, dispatches via the entry's routing (the existing four mechanisms — `sendToFirstResponder`, `sendToKeyCard`, `sendToTarget`, registry handler — become data instead of hand-picked call sites), and notifies observers. Swift stays exactly as thin as it is today: menu selectors keep sending `sendControl` wires, but every wire lands in `dispatchCommand` (which is what `dispatchAction` already almost is). Native-only commands (Hide, Quit, Minimize, Full Screen, the `NSText` re-dispatch five) get ordinary registry entries with `routing: "native"` — represented so the keymap UI can show them, never routed through JS — and are locked only insofar as the `NATIVE_LOCKED` policy list names them (§G.5.4).

What deliberately stays **outside** the funnel: substrate editing bindings (⌃U/⌃W/⌥F/⌥B, Enter/submit — text-editing currency, not commands), form-control value actions (`set-value`, `toggle`, `select-value` — chain currency between controls and responders), and tugcast data frames (`spawn_session_ok` et al. — protocol, not commands). The command/action distinction the registry draws is exactly "user-invocable intent" vs "internal currency," and the §A inventory is the sorting sheet.

The registry retro-pays most of the defect ledger: one entry per command kills the Settings dual-path (defect 9), makes orphan constants visible as registry rows with no handler, makes `set-maker-mode`-style dead doors impossible (a registered command with no emitter is a lint error against the table), and gives the ⌘/ command picker, the Help sheet, and a future command palette one source to enumerate.

### G.3 Funnel #2 — the keymap registry

One table of bindings — each `{ chord, scope } → commandId`, many bindings per command and potentially several commands per chord across scopes (§G.5.2/3) — resolved at one point on each side of the process boundary, with `resolveChord` exposing the full resolution stack including shadowing. The load-bearing move is inverting chord ownership: today chords are *declared* in five places (Swift `keyEquivalent` literals, `KEYBINDINGS`, CM6 keymaps, scoped `useKeybindings`, raw capture listeners); under the funnel, chords are *derived* from the keymap registry:

- **Swift side**: `keyEquivalent`s become applied state, not construction literals. The precedent already ships — `applyStackChordKeyEquivalent` (`AppDelegate.swift:1635`) and the dynamic ⇧⌘S both mutate key equivalents from `updateMenuState`, the sanctioned site. The generalization is a `keymap` block in the menuState push (or a launch-time tugbank read — see G.4) that `updateMenuState` sweeps across all identified items. Because the audit found no Swift key claims outside menus, **the entire native key surface is derivable from the registry** — nothing hides.
- **JS side**: `KEYBINDINGS` becomes the runtime resolution of the same table (stage 1 already consults a single `matchKeybinding`; it just reads the registry instead of a static array). Scoped bindings (`useKeybindings`) keep their mechanism but register through the same table so they are *visible* to conflict detection.
- **Migration debt**: the raw capture listeners that claim chords invisibly (commit-mode ⇧⌘M at `tug-prompt-entry.tsx:1626`, the local ⌘. handlers) either register through the funnel or are formally classified substrate-local. Nothing may claim a chord the table can't see.

This structurally closes three whole classes from leg D: Swift/JS double-claim drift (one table generates both sides), menu-only chords dead in browser dev (the JS twin is automatic), and lying labels (defect 6 — displayed chords render from the registry, so a label cannot disagree with the binding).

### G.4 The user keymap feature

With both funnels in place, user customization is a thin layer, and the codebase already contains its working miniature: the **stack-chord preference** — Settings radio → tugbank → `menuState.stackChord` → `applyStackChordKeyEquivalent` re-binding ⌘R (`settings-general-body.tsx:132`, `stack-chord-store.ts`, `AppDelegate.swift:1635`). The feature generalizes exactly that loop:

- **Storage**: a tugbank domain (`keymap/<command-id>` → the command's *binding list*, or `[]` to unbind), per the no-localStorage law. Defaults live in the registry; tugbank holds only overrides, so reset-to-default is deletion. The override value is a list from day one (§G.5.2) — never a scalar that would have to grow later.
- **Launch**: Swift reads overrides in `loadPreferences` (`AppDelegate.swift:727` — the established launch-time tugbank pattern) so menus carry user chords from first paint; live changes re-apply through the `updateMenuState` sweep.
- **UI**: a Settings-card keymap pane enumerating the registry — searchable command list (title, scope, current bindings, defaults), chord-capture for adding/removing bindings (lists, not a single slot — §G.5.2), shadowing rendered inline per binding (who wins and in what scope, from `resolveChord` — §G.5.3), locked rows driven by the `NATIVE_LOCKED` policy list (§G.5.4), and per-row reset. The §D.2 free-chord pools become the suggestion surface for conflicts.
- **Regression surface**: the harness's `menuSnapshot`/`menuItemState` generalizes to a registry snapshot verb, and at0167–at0174 grow keymap-override cases.

### G.5 Design decisions (locked 2026-08-04)

The four open questions from the first draft, resolved:

1. **Where the canonical registry lives — DECIDED: TypeScript.** Beside `action-vocabulary.ts` (where the names already live), with Swift continuing to hand-build menu *structure* keyed by the existing identifiers and consuming chords/validity/state as data. Generating menu structure from a shared manifest remains a later, optional step; identifiers already decouple structure from behavior.
2. **Chord arity — DECIDED: many chords per command from the start.** A single-chord-per-command model is impractical for real systems and must not be designed in as a corner. The registry's binding shape is a *list* end to end: `bindings: [{ chord, scope, source }]` per command, everywhere — entry shape, keymap table, conflict detection, tugbank override format, capture UI, and the Swift `keyEquivalent` sweep (which applies the first menu-eligible binding and leaves the rest to the JS funnel, since an `NSMenuItem` carries only one key equivalent — a display constraint of the menu, never a constraint of the model). Existing multi-chord realities (⌘+/⌘=, ⌘./Escape both cancelling, the ⌘R preference pair) become ordinary registry data on day one. Non-US keyboard layouts still need a `key`-vs-code matching decision before the capture UI ships.
3. **Scope conflict semantics — DECIDED: innermost scope wins, with first-class shadowing feedback.** The rule mirrors the chain walk. But shadowing must be *excellent, queryable, and surfaced* — not silently resolved: the registry API answers, for any chord, the full resolution stack (`resolveChord(chord, scope) → [{ commandId, scope, active | shadowedBy }]`), and for any command, whether each of its bindings is currently live or shadowed and by what. The keymap UI renders shadowing inline (shadowed rows say who wins and where); the observability surface (registry snapshot verb, dev panel) exposes the same answers. A chord or command silently going dead is the failure mode this decision exists to prevent.
4. **What natives are rebindable — DECIDED: locking is policy, carried by a maintained native-locked list.** A single curated list (`NATIVE_LOCKED`, living with the registry) names the commands whose bindings are locked — Hide/Quit/Services, the `NSText` five, and whatever else policy says. The *system* has no hard-coded limitation: every entry is mechanically rebindable, and lockedness is a data-driven predicate the UI and the override validator both read from the list. Changing the policy is editing the list, never touching the mechanism.

---

## H. Recommended staging

1. **M1 — Fix the broken validation floor.** Defects 1–7: move imperative enablement into validator tiers, register a `DELETE` handler (or drop the menu item), detach ⌘R when depth ≤ 1 (from `updateMenuState`, where key-equivalent mutation is sanctioned), fix `TugButton:597`, fix the two chord labels, gate Open Recent. No architecture, just floor repair — everything later builds on a truthful baseline.
2. **M2 — The command registry (funnel #1, structure).** Introduce the §G.2 registry and `dispatchCommand`; fold `dispatchAction` into it; convert the existing "Both" loops and menu wires to registry entries; give ids to the §A.4 store-verb and raw-string dispatch candidates; represent native items as locked entries. Behavior-neutral by design — same routing, one front door.
3. **M3 — Validation and state as registry fields (legs B + C).** Populate `validate` per the §A handler map (chain `validateAction` branches + registry predicates for control-frame commands); add `queryActionState`/`state`; generalize `computeEditCapabilities` into the per-tier mirror driven by the registry; converge `TugButton`, the context menus, and the Swift tiers onto the one definition; retire the theme submenu's tugbank pull by pushing current theme.
4. **M4 — Close the door gaps (leg A).** Now one-line registry edits: promote the §A.3 chord-only commands to menu items (turn navigation, command picker, devtools, slots, composer route) and give control-frame-only commands chain identities where they belong, making them browser-dev-reachable and validation-visible for free. New chords draw from the §D.2 free pools.
5. **M5 — The keymap registry (funnel #2).** Invert chord ownership per §G.3: bindings become derived data on both sides (`updateMenuState` sweep on Swift, registry-resolved `matchKeybinding` on JS), multi-chord from the start (§G.5.2); migrate or formally classify the raw capture listeners; land `resolveChord` with full shadowing answers (§G.5.3) and the `NATIVE_LOCKED` policy list (§G.5.4).
6. **M6 — The user keymap feature.** tugbank `keymap/` overrides, launch-time read in `loadPreferences`, live re-apply, and the Settings keymap pane per §G.4 — the stack-chord loop generalized to every rebindable command.
7. **M7 — Refresh tuglaws/menus.md** — now largely *generated* from the registry: wire-block rename, full frame catalog, the chord table (from funnel #2's one table), the tier table including File/stack tiers, and the corrected exception list. The at0167–at0174 harness coverage (`menuSnapshot` / `menuItemState`, `TestHarnessConnection.swift:432-515`) grows with each milestone; M5+ adds a registry-snapshot verb.

---

*Audit sources: `tugapp/Sources/AppDelegate.swift` (menu construction :804-1242, selectors :1246-1628, validation :1795-1966, MenuState :2465-2695, delegates :2243-2437), `tugdeck/src/action-dispatch.ts`, `tugdeck/src/components/tugways/action-vocabulary.ts`, `keybinding-map.ts`, `responder-chain.ts`, `tug-button.tsx`, `text-editing-menu.ts`, `tugdeck/src/lib/host-menu-state.ts`, `use-menu-state-publication.ts`, `MainWindow.swift` (bridge handlers :1312-1628), `ProcessManager.swift`, `TestHarnessConnection.swift`.*
