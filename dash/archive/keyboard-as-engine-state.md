<!-- devise-skeleton v4 -->

## Keyboard as Engine State {#keyboard-as-engine-state}

**Purpose:** Make the keyboard route through the focus engine's own `FocusTarget` instead of `document.activeElement`, so the focus ring and key routing are one variable — structurally incapable of disagreeing — and the relaunch-with-Lens-focus bug class (#57/#51) becomes impossible by construction, without backdoors.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-19 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The `focus-by-construction` rework (merged as `5ded6b537`, plan `dash/focus-by-construction.md`) gave the engine one write primitive (`FocusManager.place()`), a ring projection derived from settled DOM focus (`reflectSettledFocus`), key-card authority, and a runtime tripwire. It still failed the most basic case: relaunch the app with an empty session card and saved keyboard focus on the Lens — the ring paints on the Lens snippets list, arrow keys do nothing. The root cause is not any one of the residual holes (see [#holes-in-the-shipped-design]); it is the design's load-bearing assumption that `document.activeElement` routes the keyboard and can be governed. It cannot: it is a single global register with **no interception point**. Roughly eighty raw `view.focus()` / `el.focus()` calls in substrate code (CM6, `tug-text-editor`), Radix internals, and WebKit's own defaults (mousedown focus, teardown blurs, display-flip refusals) can write it at any moment. Any architecture that derives keyboard truth from that register is condemned to heuristics (foreign-universe skip, trapped-member acceptance, settle-clear, placement-in-flight marks) — and every heuristic is a hole.

This plan inverts the relationship. The engine's per-card `FocusTarget` — which `place()` already owns, records, and persists — becomes the **actual keyboard router**. All key handling dispatches from the engine's document-level capture listeners (where the Tab walk, spatial arrow nav, and act dispatch already live in `responder-chain-provider.tsx`) by reading the target. The ring paints from the target. Keys route from the target. `document.activeElement` is demoted to a peripheral device used only for what it is irreplaceable for: native text editing (caret, IME, composition, selection). The Cocoa analogy: NSWindow owns `firstResponder`; hardware focus is the window server's business. Tug's responder chain already did this for actions — this completes it for keys.

#### Strategy {#strategy}

- **Reproduce first.** Author the true quit-and-relaunch pin (real session card, Lens keyboard focus, arrows must move the cursor) before touching the engine, and record that it fails against current main — the wrong-channel lesson of at0246 must not repeat ([P11]).
- **One new element, one new axis.** Add the engine-owned key sink and the derived `engine-routed` / `dom-granted` route classification. No third state, no per-component opt-ins.
- **Route keys, then delete heuristics.** Convert key dispatch to read engine state, migrate the element-attached keydown handlers that structurally die (TugListView's, SmartScroll's list-nav), and only then delete `reflectSettledFocus` and its exception ladder — replaced by a watchdog with exactly one legal answer per mode.
- **Make placement transactional.** `realizeTarget` resolves before it commits; an unrealizable target paints nothing and routes nothing ([P06]).
- **Keep everything that already earned its place.** `place()`, `FocusTarget`, the `bag.focus` mapping, per-card `FocusContext`s, the mode stack, spatial orders / cursor handles, chain first-responder settlement, and the walk logic all survive unchanged in shape ([P12]).
- **Trap steals as a first-class ledger.** Every watchdog reassertion is attributed (which element stole, from which route), counted, surfaced in the dev panel and the test surface, and budget-asserted in app-tests — so a steal introduced next month announces itself instead of being silently absorbed ([P04], Spec S03).
- **Land accessibility as a designed part, not an afterthought:** real DOM focus mirroring on the existing `KeyboardAccessMode` accessibility axis as the primary screen-reader mechanism, switched by host-side VoiceOver detection ([P10]).
- **No lint gates, ever** ([P09]). Enforcement is the runtime watchdog, the pinned app-tests, and review against the rewritten tuglaws.

#### Success Criteria (Measurable) {#success-criteria}

- The true relaunch pin passes: quit-and-relaunch (at0014 `persistInTestMode` pattern) with a real session card open and keyboard focus saved on the Lens snippets list → after relaunch, the ring is on the snippets list, `getFocusInvariantReport()` shows zero violations, and a native ArrowDown moves `data-key-cursor` — with no clicks or synthetic state seeding after relaunch. (Run via `just app-test`, VERDICT last line.)
- Grep-verifiable structure: no call site outside the engine pairs a ring write with a focus write; `reflectSettledFocus`, `elementInActiveUniverse`, `placementInFlight`/`beginPlacement`/`endPlacement`, and the trapped-member / foreign-skip / settle-clear branches are gone from `focus-manager.ts`.
- In engine-routed mode, `document.activeElement` is the key sink at every settled moment (asserted by the watchdog and by app-test probes); in dom-granted mode it is the granted text surface. Any other value is corrected within one watchdog pass, and the correction is observable in the invariant report as an attributed steal-ledger entry (`steals` / `reasserted`), not a violation.
- Steal budgets hold: app-tests that tour dialogs, sheets, and the Lens assert the steal ledger stays flat across interactions where no raw focus write should occur.
- The existing focus suite stays green: at0148, at0201, at0202, at0203, at0204, at0240–at0246 (`just app-test` full sweep).
- `node_modules/.bin/tsc --noEmit` clean; `bunx vite build` succeeds.

#### Scope {#scope}

1. Key sink element + route classification + park/grant primitives in `focus-manager.ts` / `responder-chain-provider.tsx`.
2. Engine-routed key dispatch: provider listeners read the route; a key-view delegation channel (`KeyViewBehavior.onKey`) replaces element-attached keydown handlers that depended on focused-descendant event delivery (TugListView, SmartScroll list-nav, and any others the inventory sweep finds).
3. Transactional `realizeTarget` (resolve-then-commit; no paint on failure).
4. Watchdog replacing `reflectSettledFocus` + tripwire-as-enforcement (remove the `document.hasFocus()` mute for state checks).
5. Sweep: `tabIndex` removal from engine-routed stops, `data-tug-focus="refuse"` focus-prevention collapse, `bubbleListener` Enter default-button path reading engine state, Radix trap audit.
6. Accessibility: the `KeyboardAccessMode` focus-follows mirror as the primary screen-reader mechanism, with host-side VoiceOver detection named as the switching architecture.
7. The true relaunch pin app-test + tuglaws rewrite (`focus-language.md` One-writer section, `responder-chain.md` cross-references).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing what any surface *does* with its keys — behaviors, act resolution (`resolveFocusAct`), the Escape ladder, spatial orders, and the walk order are untouched in semantics.
- Changing the persisted `bag.focus` schema or tugbank contents (the `FocusSnapshot` → `FocusTarget` mapping in `focus-transfer.ts#focusSnapshotToTarget` is already 1:1 and stays).
- A full VoiceOver/screen-reader certification pass — the aria plumbing lands here; an SR audit is a follow-on ([#roadmap]).
- Touching the responder chain's action routing, the edit-menu capability mirror, or `SelectionGuard`.
- The #65 open-editor-height design spike.

#### Dependencies / Prerequisites {#dependencies}

- Main at or after `5ded6b537` (the focus-by-construction merge) — this plan edits that code, not pre-rework code.
- The app-test harness's `launchTugApp({ persistInTestMode: true })` quit-and-relaunch pattern (`tests/app-test/at0014-cold-boot-scroll.test.ts`) and real-session spawning (replay-session workspace).
- `window.__tug.getFocusInvariantReport()` test surface (exists; extended in Step 5).

#### Constraints {#constraints}

- **No lint gates.** Linters can never block correct code; enforcement is runtime + tests + review ([P09]).
- **Real tests only.** Browser-behavior coverage lives in `tests/app-test/` via `just app-test`; no fake-DOM/RTL, no mock-store assertion tests. Pure logic in plain `bun:test`.
- Typecheck with `node_modules/.bin/tsc --noEmit` (never `bunx tsc`); verify bundling with `bunx vite build` before declaring tugdeck work done.
- Warnings are errors; fix pre-existing issues in touched files.
- Runs via `/tugplug:implement` on a dash worktree; commits name the tuglaws touched.

#### Assumptions {#assumptions}

- `keydown` events reach document-level **capture** listeners regardless of which element holds DOM focus, as long as the document has focus — so routing from engine state at the document level loses no keys. (Already true today; the current listeners are all document-capture.)
- Calling `.focus({ preventScroll: true })` on a visually-hidden `tabindex="-1"` element works in WebKit (the app's only engine) and does not clear an existing document text selection.
- The browser's native ⌘C copy uses the document selection independent of `activeElement`, and the chain's CUT/COPY/PASTE responder actions route via the first-responder register, not DOM focus — so parking focus on the sink does not break copy of transcript selections. (Verified in Step 2's checkpoint before anything is built on it.)

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Do Radix focus traps fight the sink? (DECIDED — see [P13]) {#q01-radix-traps}

**Question:** Radix `FocusScope` (under tugways sheets/popovers via `useFocusTrap`) can refocus into the surface on focusout when its `trapped` behavior is active. With engine-routed buttons inside a sheet, the engine parks `activeElement` on the sink (outside the sheet) — does Radix yank it back, creating a focus ping-pong with the watchdog?

**Why it matters:** A reassertion loop between Radix and the watchdog would be an infinite microtask fight.

**Resolution:** DECIDED (see [P13]): the engine's mode stack already contains the Tab walk to the surface's focusables, so Radix's DOM-level trapping is redundant under this model. Step 6 audits every `useFocusTrap` / Radix surface and disables Radix's own focus containment (`trapFocus={false}` / `onOpenAutoFocus` + `onCloseAutoFocus` `preventDefault`, per surface) where the engine owns the walk. A surface whose fields are text inputs still enters dom-granted mode normally. The audit's checkpoint proves no ping-pong via the invariant report's reassertion counter staying flat while a sheet is open.

#### [Q02] Does Space still scroll where it should? (DECIDED — resolved in Step 3) {#q02-space-scroll}

**Question:** Today, page-scroll keys sometimes work because DOM focus sits inside a scroll container and element-attached handlers (SmartScroll's `handleNavKey` on the scroll element, `tug-list-view.tsx` around the `pageByEntry` handler) see the keydown. With focus parked on the sink, keydown never passes through those containers.

**Why it matters:** Silent loss of PageUp/PageDown/Space scrolling in transcripts and lists.

**Resolution:** DECIDED: this is exactly the "element-attached handlers structurally die" class. Step 3's inventory sweep (grep `addEventListener("keydown"` under `tugdeck/src`) routes each such handler through the key-view delegation channel ([P05]) or an explicit document-level check, and the step's tests exercise list Page keys and transcript scroll keys in the real app.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Radix trap vs sink ping-pong | high | med | [P13] disable Radix containment where engine owns the walk; reassertion counter checkpoint | reassertion counter climbing while a sheet is open |
| Element-attached keydown handlers silently dead | high | high | Step 3 inventory sweep + per-surface tests | any key that works on main and not on the dash |
| Screen-reader regression (focus no longer on real controls) | med | med | [P10] aria-activedescendant + access-mode mirroring; SR audit follow-on | accessibility-mode app-test failing |
| Broad blast radius across the focus suite | med | high | convert dispatch before deleting derivation; run the full at01xx/at02xx sweep at every step checkpoint | any suite regression |
| WebKit refuses to focus the hidden sink | high | low | Spec S01 sink recipe (fixed-position, 1px, opacity 0, `tabindex="-1"`, never `display:none`/`visibility:hidden`); Step 2 checkpoint probes it in the real app | `document.activeElement` never equals the sink in the probe |

**Risk R01: Reassertion fights a legitimate in-flight transition** {#r01-reassert-race}

- **Risk:** The watchdog re-parks focus during the same tick a legitimate grant (editor click, descend-into-editor) is landing, stealing the caret.
- **Mitigation:** The watchdog never guesses — it computes the single legal element from current engine state at check time. A click on an editor runs the promotion path's `place()` (pointerdown, before mousedown focus), so by the time `focusin` fires the mode is already dom-granted and the editor is legal. The check itself stays microtask-coalesced (the existing `scheduleFocusInvariantCheck` machinery), so it always sees settled state.
- **Residual risk:** A substrate that calls a raw `view.focus()` *without* a placement (outside its granted window) gets corrected — which is the designed behavior, but any such site that was load-bearing must be converted to a placement; Step 6's sweep hunts these via the reassertion log.

**Risk R02: The pin test is flaky at the harness level** {#r02-pin-flaky}

- **Risk:** Quit-and-relaunch tests are the slowest, most timing-sensitive app-tests (at0148's resign/become-active flake history).
- **Mitigation:** Follow at0014's phase structure exactly (graceful quit, same tugbank temp file, settle delays before assertions); assert on engine state via the test surface (report + `data-key-cursor`) rather than screenshots.
- **Residual risk:** First-file-in-long-sweep timing sensitivity; acceptable, since the assertion is the whole point of the plan.

---

### Design Decisions {#design-decisions}

#### [P01] The FocusTarget is the keyboard router (DECIDED) {#p01-target-routes-keys}

**Decision:** All keyboard dispatch for engine-managed surfaces resolves against the active `FocusContext`'s recorded target / key view, read by the document-level capture listeners in `responder-chain-provider.tsx`. `document.activeElement` is never consulted to decide *where a key goes* for engine-routed components.

**Rationale:**
- The listeners already live at document capture (Tab walk, `arrowNavListener`, `captureListener`, `actDispatchListener`) and already read `focusManager.keyView*()` — the inversion completes an existing pattern rather than inventing one.
- Ring and routing become the same variable: `setKeyView` projection paints `data-key-view-kbd` from the target, and dispatch reads the same target. Divergence is not "prevented"; it is inexpressible.
- `activeElement` has no interception point; the target has exactly one writer (`place()` and the engine's own walk/spatial/mode-stack ops).

**Implications:**
- Any component logic that relied on receiving keydown via a focused descendant must move to the delegation channel ([P05]).
- The `bubbleListener` Enter default-button path and the arrow-yield checks re-key from engine route + target instead of `document.activeElement` shape tests.

#### [P02] Two keyboard routes, derived structurally from the target (DECIDED) {#p02-two-routes}

**Decision:** Every placement classifies into exactly one of two routes, derived from the `FocusTarget` kind plus the responder registry — never a per-call flag: **`dom-granted`** for text surfaces (`engine` kind; `state-key` kind, i.e. native input/textarea/select form controls; `responder` kind whose responder registered a `focus` contract — the CM6 substrates) and **`engine-routed`** for everything else (`focusable`, `focus-key`, `responder` without a focus contract, `none`).

**Rationale:**
- Text surfaces genuinely need the platform register (caret, IME, composition, native selection); nothing else does.
- Deriving the route from the target kind + an existing declaration (the responder focus contract, [D03] in `responder-chain.md`) means no new authoring surface and no way to author a contradiction.

**Implications:**
- `FocusManager` gains `keyboardRoute(): "engine-routed" | "dom-granted"` (Spec S02) — the mode every listener and the watchdog read.
- Descend-into-editor (the snippets CM6 row) and ascend are route transitions expressed as ordinary placements; the microtask-deferred focus claim after `descendIntoRow` becomes the grant half of the placement.

#### [P03] One engine-owned key sink (DECIDED) {#p03-key-sink}

**Decision:** The provider renders a single always-mounted, visually-hidden, focusable key-sink element at the canvas root; in engine-routed mode the engine parks `document.activeElement` there (Spec S01).

**Rationale:**
- A deterministic, checkable identity for "the keyboard is engine-owned" — the watchdog's rule needs one legal answer, and `<body>` cannot carry `aria-activedescendant` or a role.
- The VS Code hidden-input pattern is a decade-proven precedent for exactly this inversion.

**Implications:**
- Engine-routed stops no longer need `tabIndex` or DOM focusability; the focus-language rule "every ringable stop must be DOM-focusable" is repealed.
- The sink is invisible to the accessibility tree by design; the screen-reader story is [P10]'s focus-follows mirror, under which the sink is never focused.

#### [P04] One legal location per route; the watchdog corrects on sight (DECIDED) {#p04-watchdog}

**Decision:** In engine-routed mode the only legal `activeElement` is the sink; in dom-granted mode, the granted surface (or a descendant of it). The `focusin`/`focusout`-driven pass reasserts the legal location whenever reality differs — it never *adopts* what it finds. `reflectSettledFocus` and its exception ladder (same-owner settle no-op, trapped-member acceptance, foreign-universe skip, settled-blur ring-clear) are deleted; `placementInFlight` / `beginPlacement` / `endPlacement` are deleted (a legitimate grant is legal by definition, so there is nothing to shield).

**Rationale:**
- The shipped derivation had to guess intent from DOM shape; every guess needed an exception, and every exception was a hole (the foreign-skip is hole #2 of [#holes-in-the-shipped-design]). With one legal answer per mode, correction requires no judgment.
- A steal cannot steal the keyboard (keys never routed through the stolen register), so reassertion is cleanup, not conflict resolution.

**Implications:**
- The tripwire becomes enforcement: same scheduling machinery (`scheduleFocusInvariantCheck`, microtask-coalesced), but it re-parks/re-grants and counts `reasserted` separately from `violations` (a violation is now only "engine state itself is incoherent"). The `document.hasFocus()` early-return is removed for the state check; only the *report* of ring-vs-key agreement may note OS-focus state.
- Boot needs no focus event to become correct: the target is placed from the bag, the ring paints from it, keys route from it — landing `activeElement` is a hygiene action the watchdog performs whenever it can, not a precondition.

#### [P05] Key delivery to components goes through the engine's delegation channel (DECIDED) {#p05-onkey-channel}

**Decision:** `KeyViewBehavior` gains `onKey?: (e: KeyboardEvent) => boolean` (held by reference, read live like the other behavior fields). A new provider document-capture listener, registered after `actDispatchListener`, invokes the current key view's `onKey` (via a new `FocusManager.dispatchKeyToKeyView`) — occupying the same precedence slot element-capture handlers had (document capture runs before element capture on the way down). Element-attached keydown handlers on engine-routed components are removed.

**Rationale:**
- In engine-routed mode, keydown targets the sink; element listeners on the component subtree are structurally unreachable. Moving them into the behavior contract is the honest form of what `SpatialCursorHandle` delegation already does for in-group arrows.
- One delivery path means one precedence story: walk → spatial → bindings → act → key-view delegate → bubble stages.

**Implications:**
- `tug-list-view.tsx`'s scroll-container capture handler (ArrowLeft-ascend, ArrowRight-descend, Home/End/Page keys, the `data-key-view-kbd`-gated cursor movement) becomes the list's `onKey`; the attribute gate becomes "am I the key view", answered by the engine at dispatch.
- SmartScroll's element `handleNavKey` and any other handler the Step 3 inventory finds get the same treatment or an explicit document-level route.

#### [P06] Placement is transactional: resolve, then commit (DECIDED) {#p06-transactional-place}

**Decision:** `realizeTarget` resolves the target to a live, rendered registration/element **first**; only on success does it write the key view, project the ring, and park/grant. Failure returns `"unrealized"` with no paint and no route change (the previous target stands; `pendingRealizeKey` late-mount realization still arms for keyboard placements).

**Rationale:**
- Hole #1 of the shipped design: `realizeTarget` painted via `setKeyView` before `focusKeyView()`, discarded the return value, and answered `"placed"` unconditionally — an atomic write that wasn't a transaction.
- Under the inversion the failure surface shrinks (engine-routed placement cannot "fail to land" — there is no landing), but dom-granted placements still can, and a failed grant must not claim editor mode.

**Implications:**
- `focusKeyView` is demoted to the grant half (`grantTextSurface`) and is called only for dom-granted targets; engine-routed realization never touches DOM focus except to park the sink.
- A failed grant leaves the route engine-routed with the sink parked — keys keep working on the previous/enclosing target instead of going dead.

#### [P07] Mousedown focus prevention stays narrow; correction is the watchdog's job (DECIDED) {#p07-narrow-mousedown}

**Decision:** Do **not** blanket-`preventDefault` mousedown to stop browser focus moves — that would kill drag-selection of text. The existing narrow `preventFocusOnMouseDown` cases (refuse controls, fr-preserve chrome, modal scrims) stay; everywhere else the browser may transiently move `activeElement`, and the watchdog re-parks it.

**Rationale:**
- Selection dragging over transcript ink is a core interaction; `preventDefault` on mousedown suppresses it.
- Transient wrongness is now harmless: keys route from engine state, so a stray focused element for one microtask routes nothing.

**Implications:**
- Pointer clicks drive route transitions through the promotion path's `place()` (pointerdown capture, ahead of mousedown), so the settled state after any click is already legal or one watchdog pass from it.

#### [P08] `data-tug-focus="refuse"`'s focus-prevention semantic is subsumed; promotion-skip survives (DECIDED) {#p08-refuse-collapse}

**Decision:** Refusing DOM focus becomes the *default* for every engine-routed component (they no longer hold `tabIndex`), so the attribute's browser-focus-prevention half is only needed where a native control would otherwise take mousedown focus and must not (its current narrow use). Its chain-promotion-skip semantic is untouched.

**Rationale:** One rule ("text surfaces accept DOM focus; nothing else does") replaces a per-control opt-out; the attribute stops being the mechanism and becomes an annotation for the residual native-control cases.

**Implications:** The `bubbleListener` `activeIsRefusingButton` Enter path generalizes: the ringed control in engine-routed mode is *always* activated through the engine (`.click()` on the key-view element / behavior `onAct`), because no button holds native focus anymore. The refusing-button special case becomes the universal case.

#### [P09] No lint gates, ever (DECIDED) {#p09-no-lint}

**Decision:** No lint rule may gate any of this. Enforcement is the runtime watchdog + report, the pinned app-tests, and reviewer judgment against the rewritten `tuglaws/focus-language.md`.

**Rationale:** Standing user doctrine, carried verbatim from `dash/focus-by-construction.md` [P09]: linters are stupid mechanical checkers and must never block the code from doing what is right.

**Implications:** Steps ship no eslint config changes; the tuglaws rewrite states the conventions the reviewer holds.

#### [P10] Accessibility: focus-follows is the primary mechanism, switched by host VoiceOver detection (DECIDED) {#p10-accessibility}

**Decision:** The primary screen-reader mechanism is the existing `KeyboardAccessMode` accessibility axis (`keyboardAccessStore`, tugbank-backed, boot-applied) gaining **focus-follows** behavior: in `accessibility` mode the engine grants real DOM focus to every key view (elements regain `tabindex="-1"` at grant time), so assistive tech tracks focus natively — real focus on real widgets is the one pattern every AT handles. The switching architecture is **host-driven**: the Swift host (`tugapp/`) detects VoiceOver via `NSWorkspace.shared.isVoiceOverEnabled` and flows the signal to tugdeck so the mode flips (or prompts) automatically; SR users never need to find a setting. The sink does **not** carry a load-bearing `aria-activedescendant` — `aria-activedescendant` is only honored when the referenced element is a DOM descendant of (or `aria-owns`'d by) the attribute carrier, and the sink is a hidden sibling of the entire canvas, so that pattern is invalid ARIA here. Per-widget ARIA roles/states stay on the real elements the mirrored focus lands on.

**Rationale:**
- Screen readers follow DOM focus; mirroring the target into real focus in accessibility mode gives native tracking with zero AT-specific heuristics, at the cost of steal-immunity only for users who opted into (or were detected into) that mode.
- A sibling-sink `activedescendant` would ship plumbing that VoiceOver ignores; `aria-owns`-ing the app subtree into the sink would wreck the accessibility tree.

**Implications:**
- Step 7 wires the mirror and the tugdeck side of the host signal, and includes a VoiceOver smoke check in its checkpoint; the Swift `isVoiceOverEnabled` plumbing is named here as the architecture and may land as a small companion change or an explicitly-tracked follow-on ([#roadmap]).
- In accessibility mode the watchdog's legal set is the key-view element itself (Spec S03 reads the mode).
- A full VoiceOver audit remains a follow-on ([#roadmap]).

#### [P11] The pin is a true relaunch with a real session card (DECIDED) {#p11-true-pin}

**Decision:** The headline acceptance test is a real quit-and-relaunch app-test (Spec S05) — the at0014 `persistInTestMode` two-phase pattern with a real session card and Lens keyboard focus — not the `seedDeckState`→`activateCard` channel at0246 uses.

**Rationale:** at0246 passed while reality failed because it exercises the activation channel with a `gallery-prompt-entry` stand-in; the real relaunch path (constructor deck restore, CardHost cold-boot `applyBagFocus` under the `isActiveCardOfActivePane` gate, tugcast connect, late snippets-list mount, session editor binding on `feedsReady`) was never driven.

**Implications:** Step 1 authors it and records the reproduction; Step 9 flips it live. at0246 stays as the activation-channel pin.

#### [P12] What survives from focus-by-construction (DECIDED) {#p12-survivors}

**Decision:** Unchanged in shape: `place()` as the one write primitive and its `PlaceResult`; the `FocusTarget` union and `focusSnapshotToTarget` bag mapping; per-card `FocusContext`s and key-card authority (`setKeyCard`/`adoptKeyCard`, `settleFirstResponderForActivation`); the mode stack, walk, spatial orders, cursor handles, default-ring, and `pendingRealizeKey` late-mount realization; the single-channel dispatcher (`resolveBagFocus`/`applyBagFocus`) and [P20]-pushed-destination gating; the input-source latch for ring modality.

**Rationale:** Those parts are target-side state and were never the problem; the problem was deriving keyboard truth from `activeElement`. Keeping them minimizes blast radius and preserves the passing suite's semantics.

**Implications:** Diffs concentrate in `realizeTarget`/`focusKeyView`/`reflectSettledFocus`/tripwire (`focus-manager.ts`), the provider listener stack, TugListView's key handling, and the sink.

#### [P13] Radix focus containment is disabled where the engine owns the walk (DECIDED) {#p13-radix-containment}

**Decision:** Surfaces whose focusables register into an engine focus mode (via `useFocusTrap` / `FocusModeContext`) disable Radix's own DOM focus containment and auto-focus (per-surface `trapFocus`/`onOpenAutoFocus`/`onCloseAutoFocus` preventDefault), because the engine's mode stack already contains the Tab walk and Escape ladder.

**Rationale:** Two focus jailers fight ([Q01]); the engine's containment is registry-based and already authoritative for Tab/Escape, so Radix's DOM-level loop is redundant and, under the sink, hostile.

**Implications:** Step 6 audits every Radix-backed tugways surface; each change is verified against its existing pinned test (at0202/at0203 class) plus the reassertion counter.

---

### Deep Dives {#deep-dives}

#### The three holes in the shipped design {#holes-in-the-shipped-design}

Receipts against main @ `5ded6b537`, all in `tugdeck/src/components/tugways/focus-manager.ts`:

1. **Paint-before-land, result discarded.** `FocusContext.realizeTarget`, `focus-key` case: `setKeyView(record.id, …)` (ring stamped) runs before `this.focusKeyView()` whose boolean is discarded, then returns `"placed"` unconditionally. A relaunch where the CM6 session editor's late bind (or anything else) holds/steals DOM focus leaves a lit ring with no keyboard behind it. Closed by [P06] — and made moot for engine-routed targets by [P01].
2. **Event-only healing plus deliberate skips.** `reflectSettledFocus` runs only from `focusin`/`focusout`. A boot where focus never lands in the key card fires no healing event; `elementInActiveUniverse` deliberately *skips* foreign-card focus (to protect [P20] sheet restores) rather than correcting it. Closed by [P04]: the watchdog has one legal answer and reasserts; no skip branches exist.
3. **Tripwire muted exactly when it mattered.** `checkFocusInvariant` early-returns on `!document.hasFocus()` — the relaunch-restore window. Closed by [P04]: state coherence is checked regardless of OS focus; only the park action is retried when focus returns.

Plus the test lesson: at0246 seeds via `app.seedDeckState` with a `gallery-prompt-entry` stand-in — the activation channel — while the real failure lives on the cold-boot restore channel. Closed by [P11].

#### The failing scenario, walked under the new model {#scenario-walkthrough}

Relaunch with an empty session card and saved Lens focus (`bag.focus = { kind: "dom", focusKey: "lens-section-snippets:0", keyboard: true }`):

1. CardHost's cold-boot RESTORE effect dispatches `applyBagFocus` → `place(lensCardId, { kind: "focus-key", focusKey: "lens-section-snippets:0" }, { modality: "keyboard" })`. If the snippets list hasn't mounted (feed not yet in), the placement is `"unrealized"`, nothing paints, `pendingRealizeKey` arms — and the *route* stays engine-routed with the sink parked, so the keyboard is never dead, merely aimed at nothing yet.
2. The snippets feed lands, `TugListView`'s `useFocusable` registers `lens-section-snippets:0`, `registerFocusable`'s late-mount hook re-runs the placement. [P06] resolves first (registered + rendered), then commits: key view set, ring projected (`data-key-view-kbd`), route classified engine-routed, sink parked (or park deferred to the watchdog if the OS hasn't focused the window yet — routing does not wait).
3. The session editor binds on `feedsReady` and its substrate calls `view.focus()` raw. Under the old model this was the steal; now: keys never routed through `activeElement`, so nothing is stolen; the watchdog sees engine-routed mode with `activeElement` = editor, re-parks the sink, increments `reasserted`.
4. User presses ArrowDown. `arrowNavListener` (document capture) reads the engine: key view = snippets list, cursor handle registered → `moveKeyViewSpatial` → `handle.moveCursor(1)` → `data-key-cursor` moves. Home/End/Page keys reach the list via `dispatchKeyToKeyView` → the list's `onKey`. The ring told the truth because the ring and the router are one variable.

#### Key dispatch precedence (end state) {#dispatch-precedence}

Document capture, in registration order in `responder-chain-provider.tsx`: input-source latches → `focusWalkListener` (Tab; yields to `TAB_CONSUME_ATTRIBUTE`/`keyViewConsumesTab`) → `arrowNavListener` (bare arrows; in dom-granted mode yields to the granted surface exactly as it yields to editable actives today, honoring `data-tug-arrow-release`) → `captureListener` (keybindings — works in both routes; global chords must fire over editors) → `actDispatchListener` (Space/Enter/Escape vs declared behavior) → **`keyViewDelegateListener` (new: `dispatchKeyToKeyView` → behavior `onKey`)** → bubble `bubbleListener` (Enter default-button, now reading engine route/target instead of `activeElement` shape; Stage-3/4 passthrough). In dom-granted mode, keys the surface captures (`keyViewCaptures`, made structural by the route) never reach act/delegate stages — the surface's own DOM handlers have them, since it really holds DOM focus.

---

### Specification {#specification}

**Spec S01: The key sink** {#s01-key-sink}

- One element, rendered by `ResponderChainProvider` alongside its children (inside the provider so it exists exactly as long as the engine does): `<div data-tug-key-sink tabindex="-1">`. The sink is a parking register, not an ARIA composite — no `aria-activedescendant` (invalid from a sibling, per [P10]); the screen-reader story is [P10]'s focus-follows mirror, under which the sink is never focused. Give it a quiet accessible name (`aria-label`) rather than `aria-hidden` (a focusable element must not be aria-hidden); final attributes settle in Step 7's VoiceOver smoke check.
- Visually hidden but focusable: fixed position, 1×1px, `opacity: 0`, `pointer-events: none`, no `display:none` / `visibility:hidden` (both make an element unfocusable). A dedicated class in a tugways CSS file, not inline styles beyond what positioning requires.
- Parked via `sink.focus({ preventScroll: true })`; idempotent (skip when already active). Parking is hygiene, not a routing precondition — see [P04].
- Excluded from the responder walk and the focusable registry; `isFocusRefusing` need not match it (it never receives pointer events).

**Spec S02: Route classification** {#s02-route-classification}

`FocusManager.keyboardRoute()` returns the route of the **active context's current target**:

| Target kind | Route | Grant mechanism |
|---|---|---|
| `engine` | dom-granted | `invokeEnginePaintMirrorAsActive` (the card's engine hook; its own `view.focus()`) |
| `state-key` | dom-granted | `el.focus()` on the keyed native control |
| `responder` with a registered `focus` contract | dom-granted | `chain.focusResponder(id)` (the [D03] contract) |
| `responder` without a focus contract | engine-routed | park sink |
| `focusable` / `focus-key` | engine-routed | park sink |
| `none` | engine-routed | park sink |

The classification is computed inside `realizeTarget` at commit time and cached as the context's route; `keyboardRoute()` reads the active context's cache. Descend/ascend and every walk/spatial move re-derive it through the same path (they all land in `setKeyView` + realize/park).

**Spec S03: The watchdog** {#s03-watchdog}

- Trigger: the existing provider `focusin`/`focusout` capture listeners (which currently call `reflectSettledFocus`) call `focusManager.enforceKeyboardRoute()` instead, still focusout-microtask-deferred and coalesced through `scheduleFocusInvariantCheck`'s queue.
- Algorithm: compute `legal` from the route — engine-routed → the sink; dom-granted → the granted element (containment: `legal === active || legal.contains(active)`); in `accessibility` mode ([P10]) → the key-view element itself. If `document.activeElement` is legal (or the document is mid-teardown), done. Otherwise reassert: park or re-grant.
- **The steal ledger — the trap for present and future raw-focus writes.** Every reassertion records an attributed entry: the offender (`describeElementForInvariant` of the element focus landed on), the legal element, the route, and the trigger reason. Entries are signature-deduped and counted per offender. Log level is the trap's teeth: `warn` for any offender that is not the currently granted surface (a genuine steal — new code that writes `activeElement` outside a granted window announces itself in the dev panel), `debug` only for known-benign browser churn (teardown blur to body). Silent absorption is forbidden: a corrected steal must still be visible.
- `violations` is reserved for genuine incoherence the watchdog cannot fix (e.g. dom-granted with the granted element gone — which instead triggers a fallback placement to the enclosing target and logs at `warn`).
- `getFocusInvariantReport()` extends to `{ violations, reasserted, steals, last }` where `steals` is the per-offender ledger (offender descriptor → count); existing consumers (at0246) keep working since `violations` keeps its meaning "the engine lied". App-tests assert **steal budgets**: interactions where no raw focus write should occur assert the ledger stays flat (#success-criteria).
- No `document.hasFocus()` gate on the state computation; the park `.focus()` call is attempted regardless (it sets `activeElement` even in an unfocused document) and the window-focus reactivation path (`reactivateCurrentFocusDestination`) re-runs enforcement after ⌘-tab return.

**Spec S04: KeyViewBehavior.onKey** {#s04-onkey}

- Signature: `onKey?: (event: KeyboardEvent) => boolean` on `KeyViewBehavior` (`focus-manager.ts`), read live via the behavior thunk like every other field. Return `true` = handled (the listener `preventDefault` + `stopImmediatePropagation`s), `false` = fall through.
- Delivered by `FocusManager.dispatchKeyToKeyView(event)` from the provider's `keyViewDelegateListener` (document capture, registered after `actDispatchListener`). Never invoked in dom-granted mode (the surface owns its keys) and never for keys with ⌘/⌃ (those belong to bindings).
- TugListView's `onKey` carries over its current handler body: ArrowLeft-ascend for descended row scopes, ArrowRight descend, Home/End/PageUp/PageDown, cursor arrows fallback (the spatial navigator still owns bare in-group arrows first via the cursor handle, exactly as today). The `scrollEl.hasAttribute("data-key-view-kbd")` gates become "the engine dispatched to me", which is true by construction at delivery.

**Spec S05: The true relaunch pin (at0247)** {#s05-relaunch-pin}

`tests/app-test/at0247-relaunch-lens-keyboard.test.ts`, structured on at0014's two-phase pattern:

- Phase A: `launchTugApp({ persistInTestMode: true })` with a temp tugbank; open a **real** session card through the real path (spawn/replay session, as the session app-tests do — not `seedDeckState`); move keyboard focus to the Lens snippets list by the real gesture (⌘L / Tab walk — whatever the product path is, driven via `app.nativeKey`); assert the ring is on the list; quit gracefully (bag persists `{ kind: "dom", focusKey: "lens-section-snippets:0", keyboard: true }`).
- Phase B: relaunch against the same tugbank. **No seeding, no clicks.** After settle: (1) `data-key-view-kbd` present on the snippets list container; (2) `window.__tug.getFocusInvariantReport().violations === 0`; (3) `app.nativeKey("ArrowDown")` moves `data-key-cursor` to the next row; (4) optionally, `document.activeElement` matches `[data-tug-key-sink]` (engine-routed settled state).
- Committed in Step 1 with the Phase B assertions under a skip marker plus a recorded reproduction receipt; unskipped in Step 9.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| keyboard route (engine-routed / dom-granted) | structure | derived cache on `FocusContext`, recomputed inside `realizeTarget`; read by listeners + watchdog | [L22] |
| key sink element | appearance/structure | one provider-rendered DOM node + CSS class; parked via direct DOM `.focus()` | [L06], [L03] |
| reasserted/violations counters + steal ledger | structure (diagnostic) | plain fields on `FocusManager`, exposed via test surface + dev panel | [L22] |
| `KeyViewBehavior.onKey` | structure | behavior thunk read live at dispatch ([L07] pattern already used by `captures`) | [L03], [L07] |
| access-mode focus mirroring | structure | `keyboardAccessStore` (existing tugbank-backed store) read by the engine | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at0247-relaunch-lens-keyboard.test.ts` | The true relaunch pin (Spec S05) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `KeySink` (element render + `data-tug-key-sink`) | jsx + CSS | `responder-chain-provider.tsx` (+ a tugways css file) | Spec S01 |
| `FocusManager.keyboardRoute()` | method | `focus-manager.ts` | Spec S02 |
| `FocusManager.parkKeySink()` | method | `focus-manager.ts` | idempotent, preventScroll |
| `FocusContext.grantTextSurface(...)` | method (from `focusKeyView`) | `focus-manager.ts` | the demoted grant half; contract-first, DOM-walk fallback |
| `FocusManager.enforceKeyboardRoute()` | method (replaces `reflectSettledFocus`) | `focus-manager.ts` | Spec S03 |
| `FocusManager.dispatchKeyToKeyView(event)` | method | `focus-manager.ts` | Spec S04 |
| `KeyViewBehavior.onKey` | interface field | `focus-manager.ts` | Spec S04 |
| `keyViewDelegateListener` | document listener | `responder-chain-provider.tsx` | after `actDispatchListener` |
| `realizeTarget` | rework | `focus-manager.ts` | resolve-then-commit ([P06]); route classification |
| `reflectSettledFocus`, `elementInActiveUniverse`, `placementInFlight`, `beginPlacement`, `endPlacement` | **delete** | `focus-manager.ts` | [P04] |
| `checkFocusInvariant` → enforcement + `reasserted` counter | rework | `focus-manager.ts` | Spec S03; drop `hasFocus` gate |
| TugListView scroll-container keydown handler → `onKey` | move | `tug-list-view.tsx` | [P05]; cells drop `tabIndex={0}` |
| `bubbleListener` Enter path | rework | `responder-chain-provider.tsx` | engine-target activation replaces `activeElement` shape tests |
| Radix surface audit (`useFocusTrap` consumers) | edits | tugways surfaces | [P13] |
| `getFocusInvariantReport` | extend | `focus-manager.ts` + `test-surface.ts` | add `reasserted` + the `steals` offender ledger |

---

### Documentation Plan {#documentation-plan}

- [ ] Rewrite `tuglaws/focus-language.md` § "One writer — who may place focus": the router is the target; the sink; the two routes; repeal "every ringable stop must be DOM-focusable"; raw `.focus()` legal only inside a granted window; watchdog-as-enforcement with the attributed steal ledger (any `warn`-level steal is a bug in the writing code, never noise); the accessibility focus-follows doctrine; no-lint stance restated.
- [ ] `tuglaws/responder-chain.md`: note the key-delivery inversion beside [P21]/[D03] (the focus contract is now the dom-granted declaration).
- [ ] `dash/focus-by-construction.md`: SUPERSEDED banner pointing here (same treatment `focus-system-state.md` received).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Real-app (app-test)** | Boot, relaunch, key routing, ring truth, reassertion | the pin (S05); per-step regression via the existing at01xx/at02xx focus suite |
| **Pure-logic (`bun:test`)** | walk/spatial/mode-stack semantics; route classification table; transactional realize results | the existing focus-mode/focus-walk suites, extended for `keyboardRoute()` and `PlaceResult` |
| **Drift prevention** | invariant report assertions inside existing app-tests | zero `violations` stays asserted everywhere at0246 asserts it |

#### What stays out of tests {#test-non-goals}

- Fake-DOM/RTL and mock-store tests — banned in this codebase; anything needing `document` goes to `tests/app-test/`.
- Screenshot-based ring assertions — attribute/state assertions are strictly stronger and avoid the highlight-wash WebKit gotcha.
- Per-mutator pin tests against the engine — only behavior-level coverage in response to real bugs.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Every checkpoint includes `node_modules/.bin/tsc --noEmit`; tugdeck-touching steps also run `bunx vite build`. App-tests run via `just app-test` (check the `VERDICT` last line). Commits name the tuglaws touched.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The true relaunch pin (reproduction) | done | df3e1de8e |
| #step-2 | Key sink + route classification | done | b3b466c56 |
| #step-3 | Engine-routed key dispatch + handler inventory | done | 35fcb9d18 |
| #step-4 | Transactional realizeTarget | done | 2310322bb |
| #step-5 | Watchdog replaces derivation | done | b9482cb4f |
| #step-6 | Sweep: tabindex, refuse, Enter path, Radix audit | done | 28b2350d8 |
| #step-7 | Accessibility: focus-follows mirror + host VoiceOver signal | done | 092e7a0d0 |
| #step-8 | Tuglaws rewrite | done | 970dcf269 |
| #step-9 | Integration checkpoint: unskip the pin, full sweep | done | 07ab9503d |

#### Step 1: The true relaunch pin (reproduction) {#step-1}

**Commit:** `test(app): true quit-relaunch Lens keyboard pin (skipped; reproduces #57)`

**References:** [P11] true pin, Spec S05, (#holes-in-the-shipped-design, #scenario-walkthrough)

**Artifacts:**
- `tests/app-test/at0247-relaunch-lens-keyboard.test.ts` with Phase B assertions skip-marked.

**Tasks:**
- [ ] Author at0247 on the at0014 two-phase `persistInTestMode` pattern (Spec S05): real session card via the real spawn path, real ⌘L/Tab gesture to the snippets list, graceful quit, relaunch, assert ring + zero violations + ArrowDown moves `data-key-cursor`.
- [ ] Run it once with Phase B live against the unmodified engine and record the failure output in the test file's header comment (the reproduction receipt for #57); then skip-mark Phase B's assertions so the sweep stays green.

**Tests:**
- [ ] Phase A (pre-quit ring lands on the list) passes live; Phase B recorded failing, then skipped.

**Checkpoint:**
- [x] `just app-test at0247-relaunch-lens-keyboard.test.ts` → VERDICT: PASS (with Phase B skipped)
- [x] The header comment contains the observed pre-fix failure (which assertion, what the report said).

**Outcome (df3e1de8e):** The reproduction did NOT reproduce. Driven on the true cold-boot channel (new `restoreInTestMode` harness flag → constructor deck restore; restore-mode `feedsReady` gating so the session editor mounts late; late `bindSession` as the thief), Phase B passes against pre-rework main: ring restored, `violations: 0`, ArrowDown moves the cursor, and the late-bound editor never takes `activeElement` (the bind-path focus claim is card-activation-gated). Receipt in the test header. at0247 therefore lands LIVE from Step 1 as the cold-boot regression pin; #step-9's unskip task becomes verification-only.

---

#### Step 2: Key sink + route classification {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(focus): key sink element + engine/dom keyboard route classification`

**References:** [P02] two routes, [P03] key sink, Spec S01, Spec S02, (#state-zone-mapping)

**Artifacts:**
- Sink element rendered by `ResponderChainProvider`; `FocusManager.keyboardRoute()`, `parkKeySink()` (primitive only — not yet called from placements); route cache on `FocusContext` computed in `realizeTarget`.

**Tasks:**
- [ ] Render the sink per Spec S01 (element + CSS class).
- [ ] Implement the Spec S02 classification inside `realizeTarget` (all six target kinds), caching the route on the context; add `keyboardRoute()` reading the active context.
- [ ] Add `parkKeySink()` as a primitive but do **not** wire it into placements yet: the settled-focus derivation (`reflectSettledFocus`) is still live until #step-5, and a sink `focusin` would resolve to a null owner and clear the keyboard ring (`refreshKeyViewProjection(false)`). Parking-on-placement lands atomically with the derivation's deletion in #step-5. This step changes no runtime focus behavior.
- [ ] Probe the assumptions in a throwaway app-test or the dev panel (calling `parkKeySink()` directly): the hidden sink is focusable in WebKit; parking preserves an existing transcript text selection; ⌘C of that selection still copies.

**Tests:**
- [ ] Pure-logic: route classification table (all six kinds × contract presence) in the focus-manager `bun:test` suite.

**Checkpoint:**
- [ ] `just app-test` short focus set (at0201, at0203, at0246) → VERDICT: PASS (no behavior change by construction — the sink exists but nothing parks on it during normal flow).
- [ ] Recorded probe results for the three Spec S01/copy assumptions.

---

#### Step 3: Engine-routed key dispatch + handler inventory {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(focus): route keys from the FocusTarget; onKey delegation replaces element keydown handlers`

**References:** [P01] target routes keys, [P05] onKey channel, [Q02] space-scroll, Spec S04, (#dispatch-precedence)

**Artifacts:**
- `KeyViewBehavior.onKey`, `dispatchKeyToKeyView`, `keyViewDelegateListener`; TugListView's handler moved; the element-keydown inventory with each site's disposition.

**Tasks:**
- [ ] Add `onKey` to `KeyViewBehavior` and `dispatchKeyToKeyView`; register `keyViewDelegateListener` after `actDispatchListener` per (#dispatch-precedence), yielding in dom-granted mode and for ⌘/⌃ chords.
- [ ] Move `tug-list-view.tsx`'s scroll-container capture keydown body into the list's behavior `onKey` (Spec S04); delete the element listener; keep the cursor-handle spatial delegation untouched.
- [ ] Convert the provider's dom-shape checks to route checks: `arrowNavListener`'s editable-active yield and `actDispatchListener`'s guards read `keyboardRoute()` (keeping `data-tug-arrow-release` and `TAB_CONSUME_ATTRIBUTE` semantics for granted surfaces).
- [ ] Inventory every `addEventListener("keydown"` under `tugdeck/src`; classify each as (a) granted-surface-internal (fine — it really holds focus), (b) engine-routed-dead → move to `onKey` or a document-level route (SmartScroll's `handleNavKey`, list `pageByEntry`), or (c) genuinely global. Record the inventory + dispositions in the dash commit body.

**Tests:**
- [ ] App-test: list navigation intact — arrows, Home/End, PageUp/PageDown, ArrowRight descend, ArrowLeft/Escape ascend on the Lens lists (extend an existing Lens list app-test or add one focused file).
- [ ] App-test: transcript scroll keys still work (the [Q02] surface).

**Checkpoint:**
- [ ] `just app-test` full sweep → VERDICT: PASS.
- [ ] Inventory shows zero unclassified element keydown sites.

---

#### Step 4: Transactional realizeTarget {#step-4}

**Depends on:** #step-2

**Commit:** `tugways(focus): realizeTarget resolves before it commits; no ring without a routed keyboard`

**References:** [P06] transactional place, [P12] survivors, (#holes-in-the-shipped-design)

**Artifacts:**
- Reordered `realizeTarget` for all six kinds (resolve-then-commit); `PlaceResult` semantics documented at the type. `focusKeyView` still moves DOM focus for **all** kinds this step — the engine-routed park/grant split is #step-5's atomic flip, so ring, keys, and DOM focus stay mutually consistent throughout the migration.

**Tasks:**
- [ ] For each kind: resolve (registration present + `isRecordRendered` / element connected / hook registered) → on failure return `"unrealized"` with no state change beyond `pendingRealizeKey` arming; on success commit key view + projection + route + the existing focus move as one pass.
- [ ] A failed resolution never paints: no `setKeyView` write, no ring, previous target stands.

**Tests:**
- [ ] Pure-logic: `PlaceResult` matrix — unmounted focus-key → `"unrealized"` + no key-view write; registered → `"placed"` + route set; background card → `"recorded"` cache-only (existing tests extended).

**Checkpoint:**
- [ ] `just app-test` focus set (at0201–at0204, at0240–at0246) → VERDICT: PASS.

---

#### Step 5: Watchdog replaces derivation {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `tugways(focus): one legal activeElement per route — sink parks, watchdog reasserts, derivation deleted`

**References:** [P04] watchdog, [P06] transactional place, Spec S03, Risk R01, (#holes-in-the-shipped-design)

**Artifacts:**
- The atomic behavior flip, in one commit: engine-routed realizations park the sink (the parking #step-2 and #step-4 deferred); `focusKeyView` demoted to `grantTextSurface`, called only for dom-granted kinds (contract-first, DOM-walk fallback, preventScroll, idempotency guards preserved); ascend/pop-restore/adoptKeyCard park or grant per the restored target's route.
- `enforceKeyboardRoute()`; deletions: `reflectSettledFocus`, `elementInActiveUniverse`, `placementInFlight`/`beginPlacement`/`endPlacement`; provider `reflectOnFocusIn/Out` wired to enforcement; report gains `reasserted` + the `steals` ledger; `hasFocus` gate removed from the state check.
- Pointer-promotion placement: `promoteOnPointerDown` (and `promoteOnFocusIn` for granted surfaces) drive `place()` with pointer modality so click transitions are engine-first (Risk R01's mitigation).

**Tasks:**
- [ ] Wire parking into every engine-routed realization and route transition; demote `focusKeyView` to `grantTextSurface`; a failed grant falls back per Spec S03's incoherence rule (enclosing target + warn), never a lit ring over nothing.
- [ ] Implement Spec S03 including the attributed steal ledger; delete the derivation and its ladder; delete the placement-in-flight machinery.
- [ ] Wire the click path: a pointerdown resolving to an engine-routed focusable places it (pointer modality — ring per `ringFollowsPointer` policy); one resolving to a text surface places the granted target so the browser's own mousedown focus lands already-legal.
- [ ] Extend `getFocusInvariantReport` + `test-surface.ts` with `reasserted` and `steals`; surface the ledger in the TugDevPanel log stream.
- [ ] Update at0246 for the new report shape (assertions on `violations === 0` unchanged).

**Tests:**
- [ ] App-test: a raw steal is trapped and corrected — drive a scenario where the session editor binds late while the Lens holds the target (the at0247 Phase B shape, but reachable pre-unskip via the activation channel) and assert `violations === 0`, the `steals` ledger names the editor as the offender, and arrows still move the cursor.
- [ ] App-test: a steal budget — a pure Lens keyboard tour (no editors involved) asserts the ledger stays flat.

**Checkpoint:**
- [ ] `just app-test` full sweep → VERDICT: PASS.
- [ ] `grep -n "reflectSettledFocus\|placementInFlight\|elementInActiveUniverse" tugdeck/src` returns nothing.

---

#### Step 6: Sweep — tabindex, refuse, Enter path, Radix audit {#step-6}

**Depends on:** #step-5

**Commit:** `tugways(focus): engine-routed stops drop tabindex; Enter activates via the engine; Radix containment audit`

**References:** [P07] narrow mousedown, [P08] refuse collapse, [P13] Radix containment, [Q01], Risk R01

**Artifacts:**
- `tabIndex` removed from engine-routed stops (TugListView cells' `tabIndex={0}` first); `bubbleListener` Enter path reworked; per-surface Radix containment changes; reassertion-log-driven raw-`.focus()` conversions.

**Tasks:**
- [ ] Remove `tabIndex` from engine-routed components (they are unreachable by native Tab anyway once the walk owns Tab; keep native focusability only on real text controls). Update `focus-language`'s DOM expectations as encountered.
- [ ] Rework `bubbleListener`'s Enter stage: in engine-routed mode the ringed key view is activated through the engine (behavior `onAct`/`.click()` on the projected element, then default-button fallback) — the `activeIsRefusingButton` special case becomes the general case; in dom-granted mode native semantics stand.
- [ ] Audit every `useFocusTrap`/Radix surface per [P13]; disable Radix DOM containment where the engine owns the walk; verify each against its pinned test.
- [ ] **Static raw-focus inventory** (the existing-code half of the steal trap): grep `.focus(` under `tugdeck/src` (~75 sites outside the engine at plan time) and classify every site — (a) granted-window-legal substrate call (CM6 `view.focus()` inside its contract, a component focusing its own field during its own granted interaction), (b) must-convert to `place()`, or (c) dead/unreachable. Record the inventory + dispositions in the dash commit body; convert the (b) class.
- [ ] Run the app with the dev panel open and chase every `steals` ledger entry to its source; any offender not in the inventory's (a) class is a conversion miss.

**Tests:**
- [ ] App-test: dialog flows (at0202 wizard, at0203 modal restores) and sheet open/close with a steal budget — the ledger stays flat across the interactions.

**Checkpoint:**
- [ ] `just app-test` full sweep → VERDICT: PASS.
- [ ] Manual `just app-debug` session: click/keyboard tour of Lens, session card, a sheet, a confirm popover — dev panel shows no climbing reassertion loop.

---

#### Step 7: Accessibility — focus-follows mirror + host VoiceOver signal {#step-7}

**Depends on:** #step-6

**Commit:** `tugways(focus): accessibility mode mirrors the FocusTarget into real DOM focus; host VoiceOver signal seam`

**References:** [P10] accessibility, Spec S01, Spec S03, (#state-zone-mapping)

**Artifacts:**
- `accessibility` access mode granting real DOM focus to every key view (the primary SR mechanism); the tugdeck seam for the host's VoiceOver signal; sink attributes finalized per Spec S01.

**Tasks:**
- [ ] In `KeyboardAccessMode === "accessibility"`, the engine grants DOM focus to engine-routed key views (elements regain a `tabindex="-1"` at grant time, per-widget ARIA roles/states on the real elements); the watchdog's legal set in that mode is the key-view element (Spec S03).
- [ ] Wire the tugdeck seam for host-driven mode switching: a host message flips (or prompts for) `keyboardAccessStore` when the Swift side reports `NSWorkspace.shared.isVoiceOverEnabled`. Land the Swift detection itself here if small; otherwise stub the seam and track the host half as the ([#roadmap]) follow-on — the architecture is decided either way ([P10]).
- [ ] Finalize the sink's attributes (quiet `aria-label`, no `activedescendant`, never `aria-hidden`) against the smoke check below.

**Tests:**
- [ ] App-test: toggle accessibility mode (through the real store path), Tab/arrow the Lens, assert `document.activeElement` tracks the key view and the report stays clean.

**Checkpoint:**
- [ ] `just app-test` full sweep → VERDICT: PASS.
- [ ] VoiceOver smoke check (manual, `just app-debug`): with VoiceOver on and accessibility mode active, the VO cursor tracks arrow navigation through the Lens lists; result recorded in the dash commit body.

---

#### Step 8: Tuglaws rewrite {#step-8}

**Depends on:** #step-5

**Commit:** `tuglaws(focus): the keyboard is engine state — rewrite the one-writer doctrine`

**References:** [P01], [P04], [P09] no lint, (#documentation-plan)

**Artifacts:**
- Rewritten `tuglaws/focus-language.md` One-writer section; `responder-chain.md` cross-note; SUPERSEDED banner on `dash/focus-by-construction.md`.

**Tasks:**
- [ ] Execute the (#documentation-plan) items; state the two routes, the sink, the repealed DOM-focusability rule, the granted-window rule for raw `.focus()`, watchdog-as-enforcement, and the no-lint stance.

**Tests:**
- [ ] None (docs).

**Checkpoint:**
- [ ] Docs contain no references to the deleted symbols (`reflectSettledFocus`, ringable-stops-must-be-DOM-focusable).

---

#### Step 9: Integration checkpoint — unskip the pin, full sweep {#step-9}

**Depends on:** #step-1, #step-5, #step-6, #step-7

**Commit:** `test(app): relaunch Lens keyboard pin live`

**References:** [P11] true pin, Spec S05, (#success-criteria)

**Tasks:**
- [ ] Remove the skip marker from at0247 Phase B; delete the reproduction receipt's "currently failing" framing (keep the history note).
- [ ] Verify every (#success-criteria) item, including the grep criteria and `bunx vite build`.

**Tests:**
- [ ] at0247 fully live.

**Checkpoint:**
- [ ] `just app-test at0247-relaunch-lens-keyboard.test.ts` → VERDICT: PASS.
- [ ] `just app-test` full sweep → VERDICT: PASS; `node_modules/.bin/tsc --noEmit` clean; `bunx vite build` succeeds.
- [ ] Manual: `just app-debug`, quit, relaunch with Lens focus — arrows move the cursor immediately.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The keyboard routes through the engine's `FocusTarget`; `document.activeElement` is a granted peripheral for text surfaces only; the relaunch-with-Lens-focus case is pinned by a true quit-and-relaunch app-test and passes.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] at0247 passes live (real relaunch, real session card, arrows move the Lens cursor with zero violations).
- [ ] The derivation ladder and placement-in-flight machinery are deleted; the watchdog reasserts with one legal answer per route.
- [ ] Full focus suite green; tsc clean; vite build clean.
- [ ] Tuglaws rewritten to the new doctrine; no lint rules added.

**Acceptance tests:**
- [ ] at0247-relaunch-lens-keyboard (the headline pin).
- [ ] at0148, at0201–at0204, at0240–at0246 (regression).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Full VoiceOver audit of the accessibility focus-follows mode (beyond Step 7's smoke check).
- [ ] Swift host `NSWorkspace.isVoiceOverEnabled` plumbing, if Step 7 landed only the tugdeck seam.
- [ ] Retire at0246's seedDeckState channel in favor of a second real-boot variant, once the harness cost is acceptable.
- [ ] IME edge review for granted-surface handoffs (composition mid-flight across a route transition).

| Checkpoint | Verification |
|------------|--------------|
| Ring and routing are one variable | grep criteria in (#success-criteria); watchdog report |
| Relaunch case dead | at0247 live |
| No regressions | full `just app-test` sweep VERDICT: PASS |
