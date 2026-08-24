<!-- devise-skeleton v4 -->

## Focus, Activation, and Drag-and-Drop Improvements {#focus-activation-improvements}

**Purpose:** Make card activation, keyboard focus, and native HTML5 drag-and-drop compose the way macOS composes them: a drag never activates or focuses anything on either end, list selection commits on pointerdown, focus grants are idempotent, and the focus watchdog never fails silently. Ships as code fixes plus the tuglaws doctrine that keeps the fixes durable.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-24 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Commit `c571f85f2` swapped the Lens snippet drag from a pointer-ghost drag to native HTML5 DnD. Real-world use (Session card active → drag a snippet from the inactive Lens → drop into the Session prompt entry) exposed five failures, labeled A–E in this plan and traced in full in the [failure-mode trace](#failure-trace): the first drag attempt neither selects the row nor drags (A); the second drags but still never selects (B); the drop grants the CM6 editor raw DOM focus in a card that was never activated, leaving a blinking caret and live typing in an inactive card (C); the next click on the prompt entry fails to activate the card and *removes* the caret (D); and it takes three clicks total to land a caret (E).

The root causes are structural, not one-off bugs: the activation layer is blind to the drag gesture class (everything hangs off `pointerdown`, which HTML5 drops never fire); list selection is gated on `click`, which a drag suppresses by definition; the sanctioned engine focus path re-`focus()`es an already-focused contenteditable, tripping WebKit's blur-to-body hazard the codebase already documents; and the focus watchdog's correction path no-ops silently when it cannot find a key sink. Platform research (verified against Apple's HIG and the WHATWG DnD spec, see [platform conventions](#platform-conventions)) settled the doctrine: **a drag is a content gesture, not a focus gesture, on both ends** — macOS neither activates the source window on drag-start nor the destination window on drop, and the HTML spec defers drop semantics to platform convention.

#### Strategy {#strategy}

- **Laws first.** Write the tuglaws doctrine (drag-never-activates, pointerdown selection, idempotent grants, watchdog honesty) before touching code, so every code step cites a law rather than a conversation.
- **Fix the engine hazard before the gesture layer.** The idempotent-grant guard ([P03]) removes the WebKit blur-to-body landmine that Issues D/E ride; with it in place, the gesture-layer changes cannot re-trip it.
- **Remove focus claims from the drop path** rather than adding activation to it ([P01]) — the platform convention is insert-without-focus, and it makes the whole C/D/E cascade unreachable.
- **Defer activation for draggable content** at the pane-focus-controller ([P05]): arm on pointerdown, cancel on dragstart, commit on pointerup. Plain clicks keep first-click-activates unchanged.
- **Move list selection to pointerdown** in `TugListView` ([P02]) so drags carry the row they land on, AppKit-style.
- **Loud watchdog** ([P04]): every correction that cannot run is ledgered at warn level; no silent no-ops.
- **Pin with app-tests** driving the real app ([real-not-fake]): synthetic pointer sequences for activation/selection, synthetic `DragEvent`+`DataTransfer` for the drop path.

#### Success Criteria (Measurable) {#success-criteria}

- A single mousedown+drag on a snippet row in an inactive Lens card starts the native drag on the **first** gesture and moves the list selection to that row before the drag begins (fixes A, B; verified by app-test pin and manual repro).
- A snippet drop into any card's prompt entry inserts the text but changes neither `document.activeElement`, the key card, nor the deck first responder (fixes C; app-test asserts all three unchanged across a synthetic drop).
- Starting from the (now unreachable via drop, but still constructible) state "editor holds DOM focus in a non-key card," one click on the prompt entry activates the card **and** lands a blinking caret (fixes D, E; app-test pin).
- Dragging from an inactive card does not activate it; a plain click (no drag) on the same row still activates the card (verified by app-test: pointerdown → dragstart → no activation; pointerdown → pointerup → activation).
- `getFocusInvariantReport()` shows a warn-level ledger entry whenever `parkKeySink` cannot find a sink; zero such entries during the app-test suite's steal-budget assertions.
- A gesture on draggable content in a background card keeps the browser's mousedown focus default (a prevented mousedown never starts a native drag), so the resulting focus move is classified as browser churn and corrected quietly rather than ledgered as a steal — otherwise every snippet drag would warn about a write no author could fix.
- `bunx vite build` passes; `just app-test` passes.

#### Scope {#scope}

1. Tuglaws updates: new "Drag and the keyboard" doctrine in `tuglaws/focus-language.md`; activation-click carve-out note in `tuglaws/responder-chain.md`.
2. Idempotency guard on the engine focus grant path (`paintMirrorAsActive`).
3. Focus-claim removal from both snippet-drop insertion paths (`drop-extension.ts` capture handler, `tug-prompt-entry.tsx` pending-insert effect).
4. Deferred activation for gestures on draggable content in `pane-focus-controller.ts`.
5. Pointerdown selection commit in `TugListView`.
6. Watchdog honesty: warn-level ledger entries for failed corrections.
7. App-test pins for all of the above.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Multi-select list semantics (deselect-on-mouseup for already-selected rows in a multi-selection, AppKit's `NSTableView` nuance) — every current `TugListView` consumer is single-select.
- Changing the watchdog's `<body>`-is-uncorrectable carve-out (see [Q02](#q02-body-correction)).
- Reworking the snippet reorder grip (`useBlockReorder`) — it is pointer-capture based and unaffected.
- Spring-loaded drop targets, drag-hover activation, or any drag affordance beyond the current accept-ring + drop-caret.
- The Lens redesign v2 list changes — this plan fixes the current `TugListView`; the redesign inherits the fixed semantics.

#### Dependencies / Prerequisites {#dependencies}

- Commit `c571f85f2` (native HTML5 snippet drag) is on `main` — this plan builds on it, not around it.
- The focus engine (`FocusManager.place`, key sink, watchdog, steal ledger) as shipped in the keyboard-engine rework (`6db87810a`).
- App-test harness (`just app-test`) driving the real Tug.app.

#### Constraints {#constraints}

- tugdeck: bun only, HMR always live, `bunx vite build` must pass before a change is done (production rollup differs from dev esbuild).
- Tuglaws conformance: [L02] external state via `useSyncExternalStore`, [L03] `useLayoutEffect` registrations, [L06] appearance via CSS/DOM, [L22] engine state never mirrored into React state.
- No mocks / jsdom render tests — app-tests drive the real app; synthetic gestures need settle delays (see [test concepts](#test-plan-concepts)).
- App-test harness cannot perform a real OS-level drag (AppKit drag image, Escape-cancel); event-layer logic is covered with constructed `DragEvent`s.

#### Assumptions {#assumptions}

- `new DataTransfer()` and constructed `DragEvent`s are dispatchable in the Tug.app WebKit view for in-page test synthesis (verify early in Step 7; if unavailable, fall back to invoking the drop handlers' underlying store path `codeSessionStore.insertSnippet` plus a separate assertion that no code path calls `focus` — see [R03](#r03-drag-synthesis)).
- CM6's `view.hasFocus` is a reliable idempotency predicate for the grant guard (it reflects `contentDOM` focus containment).
- Single-selection semantics for all current `TugListView` consumers.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v4 conventions: explicit `{#anchor}` headings, `[P##]` plan-local decisions, `[Q##]` open questions, `R##` risks, `**Depends on:**` lines citing `#step-N` anchors, and `**References:**` lines citing plan artifacts — never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Activation commit point for deferred activation (DECIDED) {#q01-activation-commit-point}

**Question:** When a gesture starts on draggable content in an inactive card, at what moment does the card activate if the gesture turns out to be a plain click?

**Why it matters:** Activation currently happens synchronously inside the capture-phase `pointerdown` so every later handler in the same gesture sees the new key card. Deferring it changes that ordering for clicks on draggable rows.

**Options:**
- Commit on `click` — fragile: `click` does not fire if the mouse moved a few pixels without crossing the drag threshold.
- Commit on `pointerup` (capture), cancel on `dragstart` (capture) — once a native drag starts, `pointerup` never fires (the browser ends the gesture with `dragend`), so the two signals are naturally mutually exclusive.

**Resolution:** DECIDED (see [P05]) — commit on `pointerup`, cancel on `dragstart`.

#### [Q02] Should the watchdog correct focus stranded on `<body>`? (DEFERRED) {#q02-body-correction}

**Question:** `checkFocusInvariant` deliberately does not correct `document.activeElement === document.body`. After a failed grant this leaves the keyboard nowhere.

**Why it matters:** Issue D's "caret vanished and nothing reclaimed it" rode this carve-out.

**Resolution:** DEFERRED. With [P03] (idempotent grants) the blur-to-body transition that produced the stranded state no longer occurs on any known path, and the carve-out exists deliberately (a body-focused state is also the legitimate result of some dismissal flows). Revisit if the steal ledger (made loud by [P04]) shows body-stranding recurring in practice. The warn-level ledger entries from Step 6 are precisely the instrument for detecting that.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Deferred activation changes click ordering on draggable rows | med | med | Defer only for gestures starting inside `[draggable="true"]`; commit on pointerup runs the same `transferFocusForActivation` path | any app-test regression in activation pins (at0201/at0203 class) |
| Pointerdown selection changes behavior for every `TugListView` consumer | med | med | Keep all existing guards (`cellIsPickable`, `cellHasOpenEditor`); keyboard paths untouched; sweep consumers in Step 5 | a consumer that relied on click-only selection |
| Synthetic DnD not constructible in the WebKit harness | low | med | Verify first in Step 7; fallback documented in [R03] | `new DataTransfer()` throwing in the app-test page context |

**Risk R01: Activation-ordering regressions** {#r01-activation-ordering}

- **Risk:** Handlers that ran after synchronous pointerdown activation (engine placement, responder promotion) now run against the old key card for deferred gestures.
- **Mitigation:** The deferral applies only to draggable-content gestures; `FocusManager.place` is already record-only for background cards ([P05] in `focus-manager.ts` terms — a recorded target realizes on activation), so a pointerdown selection in a still-inactive card records and realizes when the pointerup commit activates. Pin both orders in app-tests.
- **Residual risk:** Third-party-style handlers (future code) that assume pointerdown == activated card; the new tuglaws section names the deferral so authors know.

**Risk R02: CM6 selection dispatch without focus** {#r02-selection-without-focus}

- **Risk:** The pending-insert effect dispatches `selection: { anchor: ... }` after insertion; without the `editor.focus()` call the DOM Selection is not synced until the editor is next focused.
- **Mitigation:** This is the desired macOS behavior — the insertion point is recorded in `view.state.selection` (CM6 draws no caret while unfocused) and becomes the visible caret when the card is next activated and the grant lands. Assert exactly this in the Step 7 drop pin.
- **Residual risk:** None known; CM6's focus-sync writes the global Selection from `view.state.selection` on focus (documented in `state-preservation.ts`).

**Risk R03: Drag synthesis fallback** {#r03-drag-synthesis}

- **Risk:** If constructed `DragEvent`s cannot carry a `DataTransfer` in the harness, the drop path cannot be exercised end-to-end headlessly.
- **Mitigation:** Split the pin: (a) drive `codeSessionStore.insertSnippet` directly and assert insertion + no focus change (the store path is the real path both drop handlers use); (b) grep-level test is banned — instead assert via `window.tugDevLog` / focus-invariant report that no steal is ledgered during the flow. Cover the full OS drag manually per the app-test transient-workspace precedent (long real-drag UI flows are covered at the store/round-trip layer).
- **Residual risk:** The capture-phase `onDropCapture` wiring itself is only exercised by real drops; keep the manual repro in the exit criteria.

---

### Design Decisions {#design-decisions}

#### [P01] A drag never activates and never focuses — either end (DECIDED) {#p01-drag-never-activates}

**Decision:** Neither drag-start nor drop activates a card, moves the key card, moves the deck first responder, or claims DOM focus. A drag from an inactive card leaves it inactive; a drop into an inactive card inserts content with no caret; a drop into the key card inserts at the drop point and the caret follows only because focus was already legitimately there.

**Rationale:**
- macOS convention, user-verified natively: dropping from active window A into window B leaves focus and activation on A. Apple HIG: drag from inactive windows "without necessarily bringing those windows to the front."
- WHATWG HTML DnD spec specifies no focus semantics anywhere in the drag model; the drop default action for editable elements is "insert … in a manner consistent with platform-specific conventions" — it defers to the platform, and our platform is macOS.
- Our handlers `preventDefault()` and perform insertion themselves, so browser default focus behavior (which varies) is moot — we own the outcome.

**Implications:**
- `onDropCapture` in `tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts` loses its `view.focus()` call.
- The `pendingSnippetInsert` effect in `tugdeck/src/components/tugways/tug-prompt-entry.tsx` loses its `editor.focus()` call.
- The drop path performs no `activateCard`, `setKeyCard`, or `place()` — deliberately. Issue C becomes unreachable.

#### [P02] List selection commits on pointerdown (DECIDED) {#p02-pointerdown-selection}

**Decision:** `TugListView` moves the picker selection (`data-selected` fill, `delegate.onSelect`, `onSelectionChange`) on **pointerdown**, not on `click`. The keyboard cursor/key-view move already in the pointerdown path stays.

**Rationale:**
- AppKit is the gold standard (user-ratified): mousedown on an unselected `NSTableView` row selects it immediately, and a drag carries the row it selected. Click-gated selection makes selection *unreachable* from any gesture that becomes a drag, and from any first-click-activates gesture (the activation `mousedown` suppression eats the `click`).
- This is the direct fix for Issues A (selection half) and B.

**Implications:**
- `pointerDownCb` in `tugdeck/src/components/tugways/tug-list-view.tsx` becomes the primary selection commit, behind the same `cellIsPickable()` / `cellHasOpenEditor()` guards; `clickCb` **retains** an idempotent commit as the fallback for click-without-pointerdown paths (a Space-activated button inside a cell fires a synthetic click that bubbles to the wrapper with no pointerdown — a path the `keyDownCb` double-fire guard's comment documents consumers relying on).
- Selecting a row in a background card composes with the engine's record-only placement: the selection fill updates (React state, card renders regardless of key status) and the recorded key-view target realizes on activation.
- Double-click activation (`activateOnDoubleClick`) and all keyboard selection paths are untouched.

#### [P03] Focus grants are idempotent (DECIDED) {#p03-idempotent-grants}

**Decision:** No engine-realized focus grant may call `.focus()` on a surface that already contains `document.activeElement`. Concretely: `paintMirrorAsActive` in `tugdeck/src/components/tugways/tug-text-editor/state-preservation.ts` guards its `view.focus()` with `if (!view.hasFocus)`; the selection re-assert and scroll restore that follow remain unconditional.

**Rationale:**
- WebKit drops focus to `<body>` on a redundant re-`focus()` of an already-focused contenteditable — a hazard the codebase documents in `focus-transfer.ts` and guards in the framework and state-key branches of `applyBagFocus`/`place`, but not in the engine-hook branch. Issue D is this landmine firing.
- The guard belongs in the substrate (`paintMirrorAsActive`) rather than the engine branch of `FocusManager.place`, because the substrate owns the `view` and every engine-hook consumer benefits without per-card code.

**Implications:**
- The engine `place({kind:"engine"})` branch may keep invoking the hook unconditionally; the hook is now safe to re-run.
- Promote the hazard from scattered comments to a law line in `focus-language.md` § One writer (Step 1).

#### [P04] Watchdog corrections never fail silently (DECIDED) {#p04-watchdog-honesty}

**Decision:** Every watchdog correction path that cannot execute records a warn-level entry in the steal ledger naming what it wanted to do and why it couldn't. First target: `FocusManager.parkKeySink` returning `false` because no `[data-tug-key-sink]` element was findable.

**Rationale:**
- In Issue C the watchdog correctly classified the illegal editor focus as a steal, then `parkKeySink` no-op'd (no sink for the route) and the illegal caret survived with nothing surfaced. Silent failure converted a caught bug into an uncaught one.
- The ledger already exists (`getFocusInvariantReport().steals`, dev-panel surfaced, budget-asserted in app-tests) — failed corrections belong in it at warn level, which app-test steal budgets then catch for free.

**Implications:**
- `parkKeySink` (or its watchdog call sites in `checkFocusInvariant`) gains a ledger write on the no-sink path.
- App-test steal-budget assertions now also police correction failures; a new warn class appearing is a test failure, not noise.

#### [P05] Deferred activation for draggable content: arm on pointerdown, cancel on dragstart, commit on pointerup (DECIDED) {#p05-deferred-activation}

**Decision:** In `pane-focus-controller.ts`, when an activation-classified `pointerdown` lands inside a `[draggable="true"]` element (via `target.closest`), the controller does not activate synchronously. It arms a pending activation (pane + card), installs nothing new per-gesture beyond what it already tracks, and resolves via two capture-phase document listeners: `dragstart` cancels the pending activation (the gesture is a drag; macOS background-drag semantics — the source card stays inactive); `pointerup` commits it by running the same `transferFocusForActivation` path the synchronous branch runs today. The paired activation `mousedown` `preventDefault()` is **skipped** for these gestures so the browser may begin the native drag; for non-draggable targets the existing synchronous behavior is unchanged.

**Rationale:**
- The `preventDefault()` on the activation `mousedown` is what killed the first drag (Issue A): mousedown `preventDefault` cancels native HTML5 drag initiation.
- `dragstart` and `pointerup` are mutually exclusive gesture endings — once a native drag begins, the browser ends the gesture with `dragend`, never `pointerup` — so the two-listener resolution has no race.
- macOS resolves the same ambiguity the same way: click activates, drag-from-background doesn't; the decision is only knowable after mousedown.

**Implications:**
- The caret-suppression rationale of the activation `preventDefault` (an activation click "activates, doesn't also place a caret") is preserved for non-draggable targets; for draggable rows, the browser's mousedown default on a `draggable` element does not place a caret anyway (it prepares a drag), so nothing is lost.
- `suppressPointerPlacementOnce()` arming moves with the commit: armed only when activation actually commits (pointerup), never for a canceled (drag) gesture — a drag gesture performs no engine placement at all. (Do NOT arm it at pointerup-commit time either: the latch is consumed by `promoteOnPointerDown` at the *next* `pointerdown`, so a pointerup arm would poison the following unrelated gesture.)
- **Chain promotion defers with activation.** The responder-chain provider's `promoteOnPointerDown` (`responder-chain-provider.tsx`) independently promotes the chain first responder on every pointerdown. For a pointerdown inside `[draggable="true"]` whose card is **not** the key card, it must skip chain promotion: if the gesture resolves as a click, the pointerup activation commit runs `transferFocusForActivation → applyBagFocus → settleFirstResponderForActivation`, which settles the chain first responder at the activation moment ([P21]'s framework half — its designed job); if it resolves as a drag, nothing was touched and the outgoing card's registers are undisturbed. Without this skip, a drag-from-inactive gesture strands the chain first responder on the drag source while the deck first responder stays on the key card — a split register that mis-routes the next accelerator (Cmd-W walks from the wrong card).
- With [P02], the row still selects on pointerdown while the card is inactive; the recorded placement realizes if and when the pointerup commit activates the card.
- Perceivable behavior change, intended: a plain click on a draggable row in a background card raises the pane on pointer**up**, not pointerdown — matching Finder's handling of a click on an icon in a background window.

#### [P06] The doctrine lives in tuglaws before the code changes land (DECIDED) {#p06-laws-first}

**Decision:** Step 1 writes a "Drag and the keyboard" section into `tuglaws/focus-language.md` covering [P01], [P02], [P03], [P04], and the [P05] deferral, plus a cross-reference note in `tuglaws/responder-chain.md`'s activation/pointer-promotion discussion. Code steps cite the laws.

**Rationale:**
- The five issues exist because the laws had gaps (no drag doctrine, no selection-timing doctrine, hazard-as-comment instead of hazard-as-law). Closing the gap in doctrine is the durable half of the fix; per-project convention, tugdeck work is verified against tuglaws before implementation.

**Implications:**
- Commit message convention: subsequent steps name the laws touched (per the tuglaws cross-check convention).

---

### Deep Dives {#deep-dives}

#### The five failure modes, traced {#failure-trace}

Repro: open a Session card and a Lens card; click into the Session card (Session becomes key card and deck first responder); mousedown+drag a snippet row in the Lens.

**A — first click+drag: no selection, no drag.** `pane-focus-controller.ts` installs document capture-phase `pointerdown` + `mousedown` listeners. `onPointerDown` classifies the gesture as an activation click (`activationClick = outgoingCardId !== pane.activeCardId`, true here), arms `suppressPointerPlacementOnce()`, and synchronously runs `transferFocusForActivation` (committing `store.activateCard`). The paired `onMouseDown` then sees `activationClick === true` and calls `event.preventDefault()` — the Mac "first click activates, doesn't act" convention — **before** its `[data-card-host]` card-content exemption. `preventDefault` on mousedown is the browser's signal not to begin a native drag, so `dragstart` never fires. Selection also cannot move: in `tug-list-view.tsx`, `setSelectedIndex` is reachable from pointer input only via `clickCb`, and a drag gesture never produces a `click`; the synchronous activation re-render mid-gesture additionally orphans the row's bubble-phase `pointerDownCb`, so even the keyboard cursor fails to land.

**B — second drag works, selection still doesn't.** Lens is now active, `activationClick` is false, no `preventDefault`, native drag proceeds via the row incipit's `draggable` + `onDragStart={snippetDragStart}` (`snippets-section.tsx`, `lib/snippet-drag.ts`). But a *successful* drag suppresses `click` even more thoroughly, and `clickCb` remains the only pointer path to `setSelectedIndex` — structurally, no drag can ever select under click-gated selection.

**C — caret in an inactive card.** The snippet drop is claimed capture-phase by `onDropCapture` in `drop-extension.ts` (registered `surface.addEventListener("drop", onDropCapture, true)`), which inserts via `insertMixedAt` and ends with a raw `view.focus()`. An HTML5 drop fires no `pointerdown`, so pane activation never runs. The resulting `focusin` reaches `promoteOnFocusIn` in `responder-chain-provider.tsx`, which promotes the **chain** first responder to the editor but refuses to legalize the focus into the engine because `focusManager.keyCard() !== cardId` (the drag's own start-pointerdown had activated the Lens). Split-brain: real DOM focus + caret + chain-FR on the Session editor; deck FR / key card / title-bar highlight still Lens. The watchdog (`checkFocusInvariant`, macrotask via `scheduleFocusInvariantCheck`, budget-limited by `spendReassertBudget`) correctly classifies the non-key-card contenteditable as a steal (contenteditable is deliberately not exempt from `isBareNativeControl`), but its correction — `parkKeySink()` — returns `false` when no `[data-tug-key-sink]` is findable and does nothing else. The steal is ledgered; the illegal caret survives.

**D — click fails to activate, caret vanishes.** The click is again an activation click, so (a) the activation `mousedown` `preventDefault` cancels WebKit's native caret placement, and (b) activation focus restore runs `applyBagFocus → place({kind:"engine"}) → invokeEnginePaintMirrorAsActive → paintMirrorAsActive → view.focus()` — unguarded. The editor *already* holds DOM focus (from C's illegal grant), and a redundant re-`focus()` of a focused contenteditable drops focus to `<body>` in WebKit (hazard documented in `focus-transfer.ts`). The watchdog explicitly declines to correct `<body>`. Net: caret gone, activation half-settled.

**E — three clicks to a caret.** Click 1 (above) flips deck FR/key card to Session but strands DOM focus on `<body>`. Click 2 is a same-card click (no suppression, `placeFromPointer` passes its `cardId === keyCard()` gate) but can re-trip the redundant-focus race; it mainly re-settles engine state. Click 3 starts from `<body>`, making `view.focus()` a non-redundant transition — the caret finally lands.

Fix mapping: [P05] fixes A's drag half and D's suppression half; [P02] fixes A's and B's selection half; [P01] makes C unreachable; [P03] fixes D/E's blur-to-body; [P04] makes the C-class steal loud if any future path recreates it.

#### Platform conventions (research record) {#platform-conventions}

- **macOS / AppKit:** Apple HIG (Drag and Drop): content should be draggable from inactive windows "without necessarily bringing those windows to the front"; auto-scroll is an active-window behavior. Native testing (user-verified): drop from active window A into window B leaves activation and focus on A. `NSTableView`: mousedown selects the row it lands on; the drag carries it.
- **HTML5 / WHATWG:** the drag-and-drop model specifies no focus or activation semantics at any point; the `drop` default action for text controls/editing hosts is "insert the … 'text/plain' data … in a manner consistent with platform-specific conventions." Since both Tug drop handlers `preventDefault()` and insert manually, per-browser default focus behavior never runs.
- **Conclusion:** the specs do not conflict; the web defers to the platform, and the platform says a drag touches neither activation nor focus. This is [P01]/[P02]/[P05] doctrine, recorded in Step 1's tuglaws section.

#### Deferred-activation gesture timeline {#gesture-timeline}

For a pointerdown on draggable content in an inactive card, under [P05]:

```
pointerdown (capture, pane-focus-controller)
  ├─ classify: activation + target.closest('[draggable="true"]') → DEFER
  ├─ arm pendingActivation = { paneId, cardId }
  └─ do NOT: transferFocusForActivation, suppressPointerPlacementOnce
mousedown (capture)
  └─ pendingActivation armed → do NOT preventDefault (native drag may begin)
── gesture forks ──
dragstart (capture, document)          pointerup (capture, document)
  └─ cancel pendingActivation            └─ commit: transferFocusForActivation
     (drag: source card stays               + suppressPointerPlacementOnce()
      inactive, macOS background drag)      (same path as today's sync branch)
```

`dragstart` and `pointerup` are mutually exclusive endings (a native drag ends in `dragend`). The pending latch is cleared on whichever fires, and also on `pointercancel`/`dragend` as belt-and-suspenders. Meanwhile the list's bubble-phase `pointerDownCb` runs normally: selection commits ([P02]), and any `place()` against the still-inactive card records without DOM effects, realizing on the pointerup commit.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `pendingActivation` latch (pane/card of a deferred activation gesture) | structure (gesture-transient, engine-adjacent) | closure variable inside the `pane-focus-controller` effect, exactly like the existing `activationClick` latch; never React state | [L22] |
| List selection index (moves to pointerdown) | local-data (existing) | existing `setSelectedIndex` React state; only the *trigger* moves from `clickCb` to `pointerDownCb` | [L02] unchanged |
| Watchdog failed-correction entries | structure (existing steal ledger) | `FocusManager` ledger, surfaced via `getFocusInvariantReport()` | [L22] |
| Drop insertion caret position | structure (CM6 `view.state.selection`) | CM6 dispatch `selection:` on insert; no DOM focus write | [L22], [P01] |

No new React state is introduced anywhere in this plan.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| (none — one new app-test file per harness convention, named at Step 7) | app-test pins |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `paintMirrorAsActive` | fn | `tugdeck/src/components/tugways/tug-text-editor/state-preservation.ts` | guard `view.focus()` with `!view.hasFocus`; selection/scroll re-assert stays unconditional |
| `onDropCapture` | fn (closure) | `tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts` | delete the trailing `view.focus()` |
| `pendingSnippetInsert` effect | effect | `tugdeck/src/components/tugways/tug-prompt-entry.tsx` | delete the trailing `editor.focus()`; keep the `selection:` anchor in the dispatch |
| `onPointerDown` / `onMouseDown` | fns (closures) | `tugdeck/src/components/chrome/pane-focus-controller.ts` | draggable-target deferral per [P05]; new `dragstart`/`pointerup`/`pointercancel`/`dragend` capture listeners resolving the latch |
| `promoteOnPointerDown` | fn (closure) | `tugdeck/src/components/tugways/responder-chain-provider.tsx` | skip chain promotion for `[draggable="true"]` targets in a non-key card ([P05] chain-promotion implication); still consume the placement-suppression latch first |
| `pointerDownCb` / `clickCb` | fns (closures) | `tugdeck/src/components/tugways/tug-list-view.tsx` | add `delegateRef.current?.onSelect` + `setSelectedIndex` to `pointerDownCb` behind the existing guards; `clickCb` retains an idempotent commit as the synthetic-click fallback (see #step-5) |
| `parkKeySink` (and/or its `checkFocusInvariant` call sites) | method | `tugdeck/src/components/tugways/focus-manager.ts` | warn-level ledger entry on the no-sink `false` path per [P04] |
| `tuglaws/focus-language.md` | doc | — | new "Drag and the keyboard" section; idempotent-grant law line in § One writer |
| `tuglaws/responder-chain.md` | doc | — | activation-click deferral note in the pointer-promotion/first-responder section |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/focus-language.md` — "Drag and the keyboard" section ([P01], [P02], [P05]) and the idempotent-grant rule ([P03]) in § One writer; watchdog-honesty line ([P04]) in the watchdog paragraph.
- [ ] `tuglaws/responder-chain.md` — deferral note where the activation-click `preventDefault` behavior is described (first-responder / focus-acceptance sections).
- [ ] Docstring updates at the touched sites (`drop-extension.ts` capture-handler comment currently justifies the focus call; `snippets-section.tsx` module docstring; `pane-focus-controller.ts` mousedown rationale comment).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test (real app)** | Drive the real Tug.app through pointer/drag event sequences; assert DOM attributes, `document.activeElement`, focus-invariant report | all behavioral pins in this plan |
| **Store round-trip** | Exercise `codeSessionStore.insertSnippet` → pending-insert effect directly | fallback if `DragEvent` synthesis is unavailable ([R03]) |

Harness conventions that bind here: space synthetic gestures with settle delays; the focus steal-budget assertions run against `getFocusInvariantReport()`; reveal/scroll assertions must clear sticky headers; use `window.tugDevLog.getSnapshot()` for focus traces when an assertion needs the engine's view of events.

#### What stays out of tests {#test-non-goals}

- Real OS-level drags (AppKit drag image, Escape-cancels-drag animation) — not synthesizable headlessly; covered by the manual repro in the exit criteria, per the established precedent that long real-drag UI flows are covered at the store layer.
- jsdom / mock-store render tests — banned project-wide.
- Multi-select list semantics — out of scope ([non-goals](#non-goals)).

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Tuglaws: drag-and-keyboard doctrine | done | (dash) |
| #step-2 | Idempotent engine focus grant | done | (dash) |
| #step-3 | Drop inserts without focus | done | (dash) |
| #step-4 | Deferred activation for draggable content | done | (dash) |
| #step-5 | TugListView selection on pointerdown | done | (dash) |
| #step-6 | Watchdog honesty: loud failed corrections | done | (dash) |
| #step-7 | App-test pins | done | (dash) |
| #step-8 | Integration checkpoint | done (automated); manual walk pending the user's vet | (dash) |

#### Step 1: Tuglaws: drag-and-keyboard doctrine {#step-1}

**Commit:** `tuglaws(focus-language): drag never activates or focuses; pointerdown selection; idempotent grants; loud watchdog`

**References:** [P01], [P02], [P03], [P04], [P05], [P06], (#platform-conventions, #gesture-timeline)

**Artifacts:**
- New section "Drag and the keyboard" in `tuglaws/focus-language.md` stating: a drag is a content gesture on both ends — drag-start does not activate the source card, drop does not activate or focus the destination ([P01]); pointer selection commits on pointerdown, AppKit-style ([P02]); activation for gestures on draggable content is deferred — armed on pointerdown, canceled by dragstart, committed on pointerup ([P05]), with the [gesture timeline](#gesture-timeline) reproduced. State the perceivable consequence as intended behavior: a plain click on a draggable row in a background card raises the pane on pointerup, not pointerdown (Finder-consistent). State the chain-promotion half of the deferral too: pointerdown chain promotion is skipped for draggable content in a non-key card, and the activation-moment settlement ([P21]) owns the chain register instead.
- In § One writer: the idempotent-grant rule ([P03]) — no engine-realized grant re-`focus()`es a surface already containing `document.activeElement`; name the WebKit blur-to-body hazard as the reason.
- In the watchdog paragraph: corrections never fail silently ([P04]) — a correction that cannot run is a warn-level ledger entry.
- Cross-reference note in `tuglaws/responder-chain.md` where the activation-click mousedown `preventDefault` is described, pointing at the focus-language drag section for the draggable-content carve-out.
- Cite the research: Apple HIG drag-and-drop, WHATWG DnD spec's platform-convention deferral (as prose, not URLs-only).

**Tasks:**
- [ ] Write the focus-language.md section (no hard-wrapped prose; one logical line per paragraph).
- [ ] Add the responder-chain.md cross-reference note.

**Tests:**
- [ ] N/A (doc-only).

**Checkpoint:**
- [ ] Both docs read coherently against the existing sections they amend; the new section names every law/decision the later steps will cite.

---

#### Step 2: Idempotent engine focus grant {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(focus-engine): guard paintMirrorAsActive against redundant re-focus [P03]`

**References:** [P03], Risk R01, (#failure-trace, #symbols)

**Artifacts:**
- `paintMirrorAsActive` in `tugdeck/src/components/tugways/tug-text-editor/state-preservation.ts`: wrap the `view.focus()` call in `if (!view.hasFocus)`. The subsequent saved-selection dispatch and `applyScrollAxes` restore remain unconditional (they are idempotent already). Update the function's ordering comment: the focus-first rationale still holds when focus is actually granted; the guard covers the already-focused case where re-focus would blur to body in WebKit.

**Tasks:**
- [ ] Add the `view.hasFocus` guard.
- [ ] Update the docstring/comment to state the guard and the hazard.

**Tests:**
- [ ] Covered by the Step 7 D/E pin (one click activates and lands the caret from the editor-already-focused state); no isolated unit test (banned jsdom pattern).

**Checkpoint:**
- [ ] `bunx vite build` passes.
- [ ] Manual: with a Session card active and its editor focused, cmd-tab away and back — caret and selection restore intact (the guarded path's happy case; regression check on activation restore).

---

#### Step 3: Drop inserts without focus {#step-3}

**Depends on:** #step-1

**Commit:** `tugways(snippet-drag): drop inserts without claiming focus [P01]`

**References:** [P01], Risk R02, (#failure-trace, #platform-conventions, #symbols)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts`: delete the `view.focus()` at the end of `onDropCapture`; update the handler comment (it should now state the [P01] rule, not justify a focus claim).
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx`: delete the `editor.focus()` at the end of the `pendingSnippetInsert` `useLayoutEffect`; keep the `view.dispatch({ changes, selection, scrollIntoView })` intact — the insertion point is recorded in `view.state.selection` and becomes the visible caret only when the editor is next legitimately granted focus.
- Audit the other `editor.focus()` calls in `tug-prompt-entry.tsx` for drop-path reachability: only the pending-insert effect is on the drop path (the others are submit/route/history flows on already-key cards); leave them, but note the audit in the commit body.

**Tasks:**
- [ ] Remove both focus calls; update comments.
- [ ] Verify the double-click-a-snippet path (same `pendingSnippetInsert` slot): double-clicking a snippet in the Lens must still insert; with [P01] it no longer steals focus to the Session editor either — confirm this reads correctly in the Lens flow (the Lens stays key; the insertion lands in the Session entry unfocused).

**Tests:**
- [ ] Step 7 drop pin (insertion lands; `document.activeElement`, key card, deck FR all unchanged).

**Checkpoint:**
- [ ] `bunx vite build` passes.
- [ ] Manual repro: drag a snippet from the Lens into the Session prompt entry — text inserts at the drop caret, **no** blinking caret appears in the inactive Session card, typing still goes to whatever was focused before the drop.

---

#### Step 4: Deferred activation for draggable content {#step-4}

**Depends on:** #step-1, #step-2

**Commit:** `tugways(pane-focus): defer activation for draggable-content gestures — arm/cancel/commit [P05]`

**References:** [P05], [Q01], Risk R01, (#gesture-timeline, #failure-trace, #symbols)

**Artifacts:**
- `tugdeck/src/components/chrome/pane-focus-controller.ts`:
  - In `onPointerDown`'s activation branch: when `event.target` is an `Element` and `target.closest('[draggable="true"]')` is non-null, do not run `transferFocusForActivation` or `suppressPointerPlacementOnce`; instead set a `pendingActivation` closure latch carrying the pane's active card id and whatever the synchronous branch captures today (outgoing card id, store reference).
  - In `onMouseDown`: when `pendingActivation` is armed, skip the activation `preventDefault()` (clear nothing — the latch resolves on the gesture end), preserving the existing behavior for all other activation clicks.
  - New document capture-phase listeners registered alongside the existing pair and cleaned up with them: `dragstart` → clear the latch (no activation — the gesture is a drag); `pointerup` → if the latch is armed, run the same commit the synchronous branch runs (`suppressPointerPlacementOnce()` is NOT armed here — the latch is consumed at the *next* pointerdown by `promoteOnPointerDown`, so arming at pointerup would poison the following gesture; there is also no engine placement left in this gesture to suppress); `pointercancel` and `dragend` → clear the latch.
  - Update the block comment that currently explains the mousedown `preventDefault` to describe the carve-out and cite the focus-language drag section.
- `tugdeck/src/components/tugways/responder-chain-provider.tsx`: in `promoteOnPointerDown`, skip chain promotion (and the trailing `placeFromPointer`, which already self-gates on the key card) when the pointerdown target is inside `[draggable="true"]` **and** the target's `[data-card-id]` card is not `focusManager.keyCard()` — per the [P05] chain-promotion implication. The skip must still consume the pointer-placement suppression latch first (the function's existing consume-before-any-early-return rule). If the gesture resolves as a click, the pointerup activation commit settles the chain first responder via `settleFirstResponderForActivation`; if it resolves as a drag, the outgoing card's chain register is untouched — verify post-drag Cmd-W routes to the still-key card.

**Tasks:**
- [ ] Implement the latch and the four resolution listeners per the [gesture timeline](#gesture-timeline).
- [ ] Sweep for other `preventDefault`/activation interactions with `[draggable]` content (the pane title bar's `data-tug-fr-preserve` path must be unaffected — title bars are not draggable-content).

**Tests:**
- [ ] Step 7 pins: drag-from-inactive-card does not activate; plain click on the same row does activate.

**Checkpoint:**
- [ ] `bunx vite build` passes.
- [ ] Manual: first-gesture drag from an inactive Lens starts the native drag (fixes A's drag half); a plain click on a snippet row in an inactive Lens activates the Lens.

---

#### Step 5: TugListView selection on pointerdown {#step-5}

**Depends on:** #step-1, #step-4

**Commit:** `tugways(list-view): commit pointer selection on pointerdown, AppKit-style [P02]`

**References:** [P02], Risk R01, (#failure-trace, #symbols, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-list-view.tsx`: add the selection commit — `delegateRef.current?.onSelect?.(index)` and the `setSelectedIndex(index)` call with its `selectionRequiredRef.current || focusEngineActiveRef.current` condition — to `pointerDownCb`, after the existing `cellIsPickable()` / `cellHasOpenEditor(e)` guards and alongside the existing cursor/`place()` logic. Note: `pointerDownCb` currently early-returns when `!focusEngineActiveRef.current`; restructure so the selection commit runs regardless of engine activity while the cursor/`place()` half keeps its engine gate (selection is list state, the cursor is engine state — [L22] separation).
- `clickCb`: **keep** its selection commit as an idempotent fallback (same-index `setSelectedIndex` is a no-op) — it is the only path for synthetic clicks with no preceding pointerdown (Space-activating a focusable child inside a cell bubbles a synthetic click to the wrapper; the `keyDownCb` guard comment documents this). Update its comment to name pointerdown as the primary commit and itself as the synthetic-click fallback. Consumers seeing `onSelect` twice for one pointer gesture (pointerdown + click) is acceptable only if it is truly idempotent — if a delegate sweep (below) finds an `onSelect` with side effects, dedupe by index in the list (skip the click-path fire when the pointerdown path already selected that index this gesture).
- Sweep every `TugListView` consumer (`grep -rl "TugListView" tugdeck/src`) for delegate assumptions that `onSelect` implies a completed click (e.g. popover dismissal on selection); adjust any that break under selection-during-drag.

**Tasks:**
- [ ] Move the selection commit; restructure the engine-activity gating.
- [ ] Consumer sweep with notes in the commit body.

**Tests:**
- [ ] Step 7 pin: pointerdown on a snippet row (inactive card) moves `data-selected` to that row before any drag; drag carries the selected row.

**Checkpoint:**
- [ ] `bunx vite build` passes.
- [ ] Manual: clicking rows in the Lens (Sessions, Snippets, Text Files) selects on mousedown; keyboard selection and double-click-to-edit unchanged.

---

#### Step 6: Watchdog honesty: loud failed corrections {#step-6}

**Depends on:** #step-1

**Commit:** `tugways(focus-engine): ledger failed watchdog corrections at warn [P04]`

**References:** [P04], [Q02], (#failure-trace, #symbols)

**Artifacts:**
- `tugdeck/src/components/tugways/focus-manager.ts`: on the `checkFocusInvariant` correction path, when the chosen correction is `parkKeySink()` and it returns `false` (no `[data-tug-key-sink]` findable), record a warn-level steal-ledger entry attributing the failure (offender element description + "park failed: no sink"). Audit the other correction call sites of `parkKeySink` (the grant-lost park in the scheduled check, the coordinator paths) and apply the same ledgering where a `false` return currently vanishes.
- Surface check: confirm the dev panel's focus-invariant report view renders the new entry class without changes (it reads the same ledger).

**Tasks:**
- [ ] Add the ledger writes on `false`-return paths.
- [ ] Audit and note each call site's handling in the commit body.

**Tests:**
- [ ] Step 7 asserts zero warn-level entries across the suite (the steal-budget assertions inherit the new class automatically).

**Checkpoint:**
- [ ] `bunx vite build` passes.
- [ ] `just app-test` — existing steal-budget pins stay green (proves the new warn class doesn't fire during healthy flows).

---

#### Step 7: App-test pins {#step-7}

**Depends on:** #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** `app-test: pin drag/activation/selection/drop-focus behaviors`

**References:** [P01], [P02], [P03], [P05], Risks R01–R03, (#success-criteria, #test-plan-concepts)

**Artifacts:** one new app-test (next free at-number per harness convention) covering, with settle delays between synthetic gestures:
- **Selection-on-pointerdown:** synthesize `pointerdown` on a snippet row of an inactive Lens → `data-selected` moves to that row; card not yet activated.
- **Drag cancels activation:** follow the pointerdown with a synthesized `dragstart` on the row incipit → Lens never activates (deck FR unchanged); latch cleared (a subsequent plain click behaves normally).
- **Click commits activation:** pointerdown + `pointerup` on a row (no dragstart) → Lens activates; selection already on the row.
- **Drop without focus:** construct `DragEvent("drop")` with a `DataTransfer` carrying `application/x-tug-snippet` and dispatch on the Session prompt-entry editor host → text inserted at the resolved position; `document.activeElement` unchanged; key card unchanged; focus-invariant report shows no new warn entries. If `DataTransfer` construction is unavailable in the harness page, fall back per [R03]: drive `codeSessionStore.insertSnippet` and assert the same invariants.
- **One-click caret from the illegal-focus state:** construct the pre-fix D state (programmatically `view.focus()` the Session editor while another card is key — the test may do the illegal thing the product no longer does), then synthesize one click in the prompt entry → card activates AND the editor holds focus with a collapsed selection (caret) in one click.

**Ledger assertions are scenario-scoped.** The illegal-focus pin above *intentionally* triggers the warn class Step 6 introduces (the watchdog will ledger the constructed steal, and possibly a failed-park warn). Assertions against `getFocusInvariantReport()` must snapshot before/after each scenario and assert deltas — the drop pin asserts a zero delta; the illegal-focus pin asserts its expected entries and excludes them from any suite-wide budget. A blanket "zero warns across the suite" assertion would be defeated by the pin's own setup.

**Tasks:**
- [ ] Verify `DataTransfer` constructibility first; choose the pin shape accordingly.
- [ ] Write the pins with the harness's settle-delay and sticky-header-reveal conventions, snapshotting the focus-invariant report around each scenario per the scoping note above.

**Tests:**
- [ ] The pins above are the tests.

**Checkpoint:**
- [ ] `just app-test` passes including the new pins.

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-3, #step-4, #step-5, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #failure-trace), [P01]–[P05]

**Tasks:**
- [ ] Full manual walk of the original five-issue repro: Session active → mousedown+drag a Lens snippet on the FIRST gesture → row selects, drag starts, Lens stays inactive → drop into the Session prompt entry → text inserts, Session (still key from before the drag) shows the caret at the insertion point legitimately, typing works immediately, zero extra clicks.
- [ ] Confirm the steal ledger is clean after the walk (`getFocusInvariantReport()` via the dev panel).

**Tests:**
- [ ] `just app-test` (aggregate).

**Checkpoint:**
- [ ] `bunx vite build && just app-test` both pass.
- [ ] Manual repro walk shows none of Issues A–E.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Drag-and-drop, activation, and focus compose per macOS convention — drags never activate or focus, selection rides pointerdown, focus grants are idempotent, watchdog failures are loud — with the doctrine recorded in tuglaws and the behaviors pinned by app-tests.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All five issues (A–E) unreproducible in the manual walk (#step-8 checkpoint).
- [ ] `tuglaws/focus-language.md` contains the "Drag and the keyboard" section; `responder-chain.md` cross-references it (#step-1).
- [ ] `just app-test` green including the new pins; `bunx vite build` green.
- [ ] Steal ledger clean across the suite, with failed corrections now visible when they occur.

**Acceptance tests:**
- [ ] Step 7 pin suite.
- [ ] Existing at0201/at0203-class activation pins unchanged.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Revisit the watchdog's `<body>` carve-out if the new warn ledger shows body-stranding in practice ([Q02]).
- [x] ~~A raw focus write on a background card poisons that card's next activation.~~ RESOLVED during iteration: the "poison" was never the raw write — any activation click that found `document.activeElement` parked on the engine's key sink fell through the focus-theft gate's decision tree to the "user has focus somewhere real, don't steal" refusal, so `applyBagFocus` never ran and the card came forward with settled registers but no caret (the user's canvas-deselect → drag → click flow reached the same state with no illegal write at all). Fixed with gate branch 5b: a parked sink is the engine holding the keyboard, counted as nothing-to-steal. Pinned as at0267 scenario 6; the sink rule is recorded in focus-language.md § One writer.
- [ ] Multi-select `TugListView` semantics (AppKit deselect-on-mouseup nuance) if a multi-select consumer arrives.
- [ ] Text-file / session rows in the Lens as drag sources under the same doctrine (Lens redesign v2 inherits [P01]/[P02]/[P05]).
- [ ] The **file**-drop path in `drop-extension.ts` (`processAttachmentFiles`) still calls `view.focus()` after inserting image atoms — the same [P01] violation as the snippet path, but its focus call carries a documented widget-paint rationale (an empty, never-focused editor may mint the atom widget without painting it). Left in place by this plan: removing it needs its own investigation of whether `view.requestMeasure` alone flushes the paint, which is not covered by any current test.

| Checkpoint | Verification |
|------------|--------------|
| Doctrine recorded | Step 1 docs merged |
| No illegal focus from drops | Step 7 drop pin + manual repro |
| One-click activation with caret | Step 7 caret pin |
| First-gesture drag with selection | Step 7 selection/drag pins + manual walk |
