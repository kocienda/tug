<!-- devise-skeleton v4 -->

## Focus Foundation — One Interpreter, One Truth {#focus-foundation}

**Purpose:** Rebuild the keyboard/focus/first-responder model's two structural seams — distributed gesture classification and the dual ontology of truth — so that every pointer gesture is classified exactly once by one interpreter, and engine state is the single truth that `document.activeElement` and the focus DOM marks merely project. The parts of the web stack we don't control (WebKit's mousedown default, drag-consumed pointer streams, peer focus enforcers) stay isolated behind named, single-location touch points.

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

The focus-engine round ("Keyboard as engine state", `6db87810a`) and the focus-activation round (`71fc04e8d`) fixed real failures, but every fix required custom hacking at a different layer, and the model has not landed in the simple, hard-to-get-wrong place it aimed for. The standalone brief at [dash/focus-foundation-brief.md](focus-foundation-brief.md) captures the full diagnosis; this plan implements its three proposed foundational moves, pressure-tested against the code as it exists on `main` today.

The core diagnosis, verified in the current source: the **write** side of focus is unified (one primitive, `FocusManager.place` in `tugdeck/src/components/tugways/focus-manager.ts`), but the **read** side is plural. Four independent capture-phase classifiers read the same pointerdown — `usePaneFocusController`'s `onPointerDown` (activation/deselect/deferred-drag, `tugdeck/src/components/chrome/pane-focus-controller.ts`), the provider's `promoteOnPointerDown` (chain promotion + `placeFromPointer`, `tugdeck/src/components/tugways/responder-chain-provider.tsx`), its `preventFocusOnMouseDown` (browser-default suppression), and `TugListView`'s per-cell `pointerDownCb` (selection commit + keyboard place, `tugdeck/src/components/tugways/tug-list-view.tsx`) — and correctness depends on all of them reaching the same conclusion in the right registration order. Separately, two ontologies of truth coexist: the engine's ("FocusManager state is authoritative; `activeElement` is a register the engine parks or grants") and the older one still live in the theft gate (`tugdeck/src/focus-theft-gate.ts`, whose branch 5b is literally a treaty clause between the two models), in the watchdog's carve-outs, and in an unswept residue of app-tests that assert `el.contains(document.activeElement)` to mean "the keyboard is here."

A concrete, currently-unfixed defect motivates the projection move (brief §5 seam 1): `FocusContext.syncKeyViewDomAttribute` clears `[data-key-view]` with a document-wide `querySelectorAll` before restamping, and only the key card's context projects. Projection is **transition-driven** — it runs when `setKeyCard` fires — so a transient `setKeyCard(A → null)` activates the empty default context, whose projection wipes A's marks globally, and nothing restamps them until something calls `setKeyCard(A)` again. Engine says "beta is the key view"; the DOM says nothing is.

#### Strategy {#strategy}

- **Make the harness trustworthy first.** Sweep the app-test corpus for the three defect patterns triage identified (activeElement-as-truth assertions, mechanism-pinning assertions, rename-fragile selectors), restore the deleted [P21] invariant test (at0224 — the one this rework is most likely to disturb), and understand the at0120 order-sensitivity before trusting batches. The rework churns exactly the observables these tests encode; sweeping first prevents weeks of false regressions.
- **One truth before one interpreter.** Land the state-driven projection (move 3) and the watchdog-as-reconciler before the gesture interpreter: a projection that reprojects from state makes a transient null key card harmless, which removes the sharpest hazard from every later change to activation/deselect classification.
- **Fold the theft gate into the engine** (move 2) once projection is state-driven: `canProgrammaticallyFocus`'s nine branches reverse-engineer from `document.activeElement` what the engine already knows because it placed it. Theft protection becomes a property of the engine consulted by the activation channel, and branch 5b evaporates.
- **Then one gesture interpreter** (move 1): a single capture-phase controller owns the raw pointer/mouse stream (it already owns the post-drag resync shim), classifies each gesture exactly once into a typed record, and every current classifier becomes a consumer. This kills the "layers must agree" failure class structurally rather than case-by-case.
- **Finish with the engine-shaped default-focus walk** (brief seam 4) and the doctrine rewrite, so `tuglaws/focus-language.md` describes the system that actually exists.
- **Incremental, green at every commit.** Each step keeps `bunx tsc --noEmit`, unit tests, `bunx vite build`, and the step's selected app-tests green. No big-bang switchover; old paths are deleted in the same step that lands their replacement, never left as dead parallel code.

#### Success Criteria (Measurable) {#success-criteria}

- A transient key-card round trip (`setKeyCard(A)` → `setKeyCard(null)` → `setKeyCard(A)`, and equally a deselect-then-reactivate through the store) leaves A's `data-key-view` / `data-key-view-kbd` / `data-key-within` / `data-focus-mode` marks projected identically to before the round trip. (Verify: pure `computeProjection()` record test in bun:test + the DOM-mark assertions in the new projection app-test — see #step-4; the seam-1 live repro from the brief no longer reproduces.)
- Exactly one module classifies raw pointer gestures: `grep -rn 'closest("\[data-pane-id\]")\|closest(FOCUS_REFUSE\|tug-pane-scrim' tugdeck/src` shows classification logic only in the gesture interpreter module (consumers read the classified record; they do not re-derive it from the event). (Verify: grep + review.)
- `focus-theft-gate.ts` is deleted (or reduced to a thin re-export shim with no decision tree); no branch enumerates "configurations where DOM focus is really the engine." The activation channel's permission question is answered by an engine query. (Verify: file diff; grep for `canProgrammaticallyFocus` call sites.)
- The watchdog's special cases (`beginDeferredGesture`/`endDeferredGesture`, the `ownStop` quiet branch, `REASSERT_BUDGET`, failed-correction ledger keys) either collapse into the reconciler or survive as named contracts documented in `focus-language.md` — none survives as an undocumented carve-out. (Verify: review of `checkFocusInvariant` against the doctrine section.)
- The verified-green baseline from the brief §4 stays green: at0112–at0115, at0120–at0122, at0140 (4/4), at0150, at0157, at0159, at0179, at0223, at0246–at0248, at0250, at0251, at0267, at0003, at0201 (3/3) — plus the restored at0224. (Verify: `just app-test <files>` on that selection at the integration checkpoint.)
- `getFocusInvariantReport()` shows `violations === 0` and a flat steal ledger across at0250/at0251, unchanged budgets. (Verify: those tests' own assertions.)
- `bunx tsc --noEmit` clean, unit tests pass, `bunx vite build` green, `just app-test-covers-check` clean at every step. (Verify: step checkpoints.)

#### Scope {#scope}

1. App-test corpus sweep (three defect patterns) + shared selector constants; restore at0224; diagnose at0120 order-sensitivity.
2. State-driven projection: one `reproject()` pass computing every engine DOM mark + the legal `activeElement` from engine state; transient key-card churn becomes harmless.
3. Watchdog rewritten as the projection reconciler over that same computation; carve-outs collapsed or named.
4. Theft gate folded into the engine; `focus-theft-gate.ts` retired.
5. One gesture interpreter owning the pointer/mouse stream; pane-focus-controller, provider promotion/placement/mousedown-suppression, and `TugListView` become consumers; deselect becomes a deliberate classification.
6. Default-focus resolution asks the engine's focusable registry first; the DOM selector chain survives only as the engine-less fallback.
7. Doctrine: `tuglaws/focus-language.md` rewritten for the new shape; `tuglaws/responder-chain.md` cross-references updated.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Leaf act contracts** (brief seam 5). `deliverToEngineLeaf` (the synthetic-keydown + `.click()` bridge in `responder-chain-provider.tsx`) stays. Replacing it with per-focusable act contracts (act/toggle/value-step invoked directly by the engine) churns every leaf component for no user-visible gain while the bridge works; see [Q01].
- **The keyboard (keydown) pipeline.** The six-listener keydown stack in the provider (walk → arrows → bindings → act → delegate → scroll) is not restructured; the interpreter owns the *pointer* stream only. See [Q02].
- **Accessibility-mode mirror redesign.** `mirrorKeyViewFocus` and the `accessibility` legal-set rules move into the projection computation unchanged in behavior.
- **Lens redesign v2 scenario rewrites** for the deleted at0240/at0243 — pending the Lens grammar discussion; their tags stay reserved in `tuglaws/app-test-inventory.md`.
- **Responder-chain (first-responder register) redesign.** The chain stays the single global register with its `parentId` walk; only its *pointer-driven promotion inputs* change (they consume the interpreter).

#### Dependencies / Prerequisites {#dependencies}

- The joined focus-activation round on `main` (`fb87256fb`, `1fc2a2e7f`) — this plan builds directly on `deliverToEngineLeaf`, the refuse-skip in `default-focus.ts`, and the widened refuse semantics.
- Deleted test recovery: `git show fb87256fb^:tests/app-test/<file>` restores any of at0050/at0086/at0221/at0224/at0240/at0243 for scenario reference.
- The brief itself: [dash/focus-foundation-brief.md](focus-foundation-brief.md) — findings, seams, and the triage record this plan cites throughout.

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings` is Rust-side, but tugdeck holds the same bar: `bunx tsc --noEmit` and lint clean at every commit).
- **`bunx vite build` before declaring any tugdeck step done** — the debug app loads the production rollup bundle; a dev-esbuild-only import hangs the app at the splash screen.
- **App-tests are selective, never a sweep**: `just app-test-changed` / explicit file lists; every new or moved test carries `@covers`; `just app-test-covers-check` must pass.
- **Tuglaws**: one `root.render()` [L01]; external state via `useSyncExternalStore` only [L02]; `useLayoutEffect` for event-dependent registrations [L03]; appearance via CSS/DOM, never React state [L06]; zone boundaries [L22]/[L24]; user-visible state preserved [L23].
- **No localStorage/sessionStorage/IndexedDB**; persistent state goes through tugbank defaults.
- HMR must never reload data/transcript; nothing in this plan may hook module reload to focus state.

#### Assumptions {#assumptions}

- The three load-bearing WebKit behaviors named in the brief §2c are permanent co-authors: re-`focus()` of a focused contenteditable blurs to body; mousedown's default focuses the nearest tabindex'd ancestor (or clears to body); a native drag consumes the pointer stream's release (first post-drag click has no `pointerdown`). Each stays handled in exactly one place; this plan relocates but never duplicates those handlers.
- Radix-trapped surfaces keep their jail semantics (in-jail sinks, `onCloseAutoFocus` teardown writers); the reconciler must coexist with Radix's FocusScope, bounded by the reassert budget.
- Prediction fails in this subsystem; instrumentation doesn't (brief §4: all six root causes were initially mispredicted). Every step that touches gesture or projection behavior verifies with instrumented app-tests or the dev-log/`window.__tug` surface, not by reading code.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Leaf act contracts — replace the `deliverToEngineLeaf` bridge? (DEFERRED) {#q01-leaf-act-contracts}

**Question:** Should the engine know each focusable's act contract (act / toggle / value-step) and invoke it directly, instead of synthesizing a keydown + completing Space/Enter as `.click()` on the key-view element?

**Why it matters:** The bridge encodes "leaves are operated natively" as a permanent assumption and rides event re-entrancy with a load-bearing latch (`deliveringToLeaf` in `responder-chain-provider.tsx`) — the forwarded event must bubble to reach React's root-attached handlers, so it re-enters the same document listeners.

**Resolution:** DEFERRED. The bridge works (at0112–at0115, at0120 green), the latch is documented, and the contract migration would churn every leaf component (button, checkbox, switch, slider, accordion) in the same phase that already churns classification and projection. Revisit after this phase lands, as its own plan; the `KeyViewBehavior` interface (which already carries `onSelect`/`onAct`/`onDescend`/`onKey`) is the natural home for the contract fields when it happens.

#### [Q02] Should the gesture interpreter also own the keydown stream? (DECIDED — no) {#q02-keydown-stream}

**Question:** The provider registers six capture-phase keydown listeners in a load-bearing order (`focusWalkListener` → `arrowNavListener` → `captureListener` → `actDispatchListener` → `keyViewDelegateListener` → `engineScrollKeyListener`). Should the "one interpreter" move unify those too?

**Why it matters:** Scope control. The keydown stack's ordering is explicit, single-file, and already the "one place" the mandate asks for — its stages are precedence tiers of one pipeline, not independent classifiers that can disagree.

**Resolution:** DECIDED (see [P01]): the interpreter owns the *pointer/mouse* stream only, where four genuinely independent classifiers exist today. The keydown pipeline is out of scope (#non-goals).

#### [Q03] at0120 order-sensitivity — test-state leakage or app residue? (OPEN → resolved by #step-3) {#q03-at0120-order}

**Question:** at0120 (accordion) passes 2/2 in isolation but failed once inside a 21-file batch. Per-test state leakage in the harness, or an app-side residue?

**Why it matters:** The rework relies on batch runs of the focus selection; an order-sensitive test poisons every batch signal.

**Plan to resolve:** Step 3 reproduces the failing batch order, bisects the preceding-file set, and instruments with `window.__tug.getFocusInvariantReport()` + dev-log reads at failure time. Outcome is either a fix or a written cause in `tuglaws/app-test-inventory.md` with a quarantine note.

**Resolution:** DECIDED (#step-3). Neither harness state leakage nor app residue: a **load-dependent race inside the test**. at0120 clicked the panel title, waited for `document.hasFocus()`, then slept a fixed 150ms before its first `Tab`. The click's activation transfer had not necessarily settled the keyboard into the card by then, so on a loaded machine the `Tab` raced the transfer and the cursor assertion timed out. The sleep is now a `waitForCondition` on the engine fact (`keyboardIsInCard("A")` from the step-1 selectors module). The 21-file baseline batch ran green four times (including one forced cold-build run) before and after the fix, so the original failure was not reproducible on demand — the fix removes the mechanism rather than a proven repro. Batch signals from the focus selection are trustworthy; a fixed delay before the first native key of a gesture chain is the general shape to watch for.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Rework disturbs the [P21] active-card keyboard invariant | high | med | Restore at0224 first (#step-2); run it at every later step | at0224 red |
| Reconciler fights a peer focus enforcer (Radix FocusScope, browser defaults) | high | med | Keep `REASSERT_BUDGET` + stand-down semantics; macrotask scheduling unchanged | budget-exhausted errors in dev log |
| Interpreter ordering vs React root delegation / third-party capture listeners | med | low | Interpreter registers first (the resync shim already holds that slot); classification is synchronous in capture phase | missed-first-click class bugs |
| Test churn misread as regressions | med | high | Corpus sweep first (#step-1); engine-fact assertions; baseline pinned before behavior changes | any baseline test flips red on a non-behavior step |
| Theft-gate fold regresses an activation edge (sheet portals, cross-pane clicks) | high | med | The gate's *behavioral* outcomes are enumerated as engine-query rules (Spec S03) and each mapped branch keeps its pinned test (at0100-class, at0003, at0201) | any activation app-test red at #step-6 |

**Risk R01: The invariant test gap** {#r01-invariant-gap}

- **Risk:** at0224 was deleted while 3/6 red for unresolved reasons; restoring it may surface pre-existing engine defects unrelated to this plan.
- **Mitigation:** Step 2 rewrites its assertions against engine facts (`getFocusedCardId()`, `[data-first-responder]`, `[data-key-view]`) and fixes any genuine engine defect it exposes *before* the rework steps; the brief's inventory ⚠️ reservation says this test wants coverage again before foundational work lands.
- **Residual risk:** A defect too deep to fix in step 2 gets a documented deferral in the test file and inventory, and the affected sub-scenario is skipped with a named reason — never silently.

**Risk R02: Projection pass cost** {#r02-projection-cost}

- **Risk:** A full `reproject()` on every engine mutation (instead of per-mark syncs) adds document-wide `querySelectorAll` work on hot paths (arrow roving, list cursor moves).
- **Mitigation:** The reconciler diffs before writing (current per-mark syncs already do clear-all-then-stamp, which is *more* DOM work than a diff); `refreshKeyViewProjection`'s roving fast path is preserved; the 2026-07 perf investigation's sticky-layer findings say DOM attribute churn, not queries, was the cost driver.
- **Residual risk:** If profiling shows regression, mark-level dirty flags are the escape hatch — still one computation, lazily applied.

**Risk R03: Build-time watch items (from the pre-implementation vet)** {#r03-watch-items}

- **Gate branch-4 drift:** today, `activeElement` inside the target card permits unconditionally; the engine can be blind to a real in-card focus it doesn't model (an uncontracted contenteditable — `promoteOnFocusIn` only places `state-key` and contract-responder claims). If #step-6 tests show refusals where today permits, widen the *derivation* (e.g. "no dom-granted grant outstanding anywhere else → permit"), never reintroduce DOM taxonomy.
- **Partially-registered registry at activation ([P06]):** `settleFirstResponderForActivation` runs synchronously inside `setKeyCard`; on addCard/cold-boot flows, focusables can register after activation. `walkOrder()`'s authored-order + rendered filter degrades gracefully, but #step-9 must test the addCard path, not just tab-switch.
- **Gesture-record lifetime (Spec S01):** the record must survive from pointerdown through the paired mousedown (`preventMousedownDefault` is read there) and through pointerup for deferred commits — including the resync-healed sequence where the mousedown arrives first and the shim synthesizes the pointerdown synchronously. #step-7 tests this sequence explicitly.

---

### Design Decisions {#design-decisions}

#### [P01] One gesture interpreter owns the raw pointer/mouse stream (DECIDED) {#p01-gesture-interpreter}

**Decision:** A single framework-local module, `tugdeck/src/gesture-interpreter.ts`, owns every document-level pointer-stream listener (pointerdown/mousedown/pointerup/pointercancel/dragstart/dragend, plus the post-drag resync shim) and classifies each gesture exactly once into a `GestureClassification` record (Spec S01). All current classifiers become consumers of that record.

**Rationale:**
- Every recent gesture bug was a disagreement between independent classifiers (brief §2a): activation `preventDefault` killed native drags; the theft gate refused the engine's own sink; every layer rode an event WebKit deleted.
- The resync shim already proves the pattern: heal/classify the stream in one place, ban per-component fallbacks (focus-language.md § Drag and the keyboard).
- Consumers reading one record cannot disagree by construction; registration order stops being a correctness input.

**Implications:**
- `usePaneFocusController` keeps only the `data-focused` attribute authority and becomes a consumer for activation/deselect/deferred-drag intents.
- The provider's `promoteOnPointerDown` / `preventFocusOnMouseDown` / the pointer-placement suppression latch (`suppressPointerPlacementOnce` / `consumePointerPlacementSuppression` on `FocusManager`) are replaced by facets of the classification.
- `TugListView`'s `pointerDownCb` keeps its cell-local concerns (`cellIsPickable`, `cellHasOpenEditor`, `defaultPrevented` grip-drag yield) but reads gesture-level facts (activation? deferred?) from the interpreter instead of inferring them.
- The interpreter is installed from `usePaneFocusController`'s `useLayoutEffect` (it owns the deck-root ref and the [L03] registration slot the resync shim already occupies).
- **Ordering guarantee (load-bearing):** consumers read `currentGesture()` inside their own capture-phase listeners, so the interpreter's listeners must fire first. That is guaranteed because `usePaneFocusController` is called in `deck-canvas.tsx` — a *child* of `ResponderChainProvider` — and child `useLayoutEffect`s run before the parent's, so the interpreter's document listeners register (and therefore fire, per registration order within the capture phase) before the provider's consumers. This is the same mechanism that makes today's resync shim fire first. The install site must therefore stay in the controller (or any descendant of the provider) — moving it into the provider's own effect would silently invert the order.

#### [P02] Engine state is the single truth; the DOM is a write-through projection (DECIDED) {#p02-one-truth}

**Decision:** All focus DOM marks (`data-key-view`, `data-key-view-kbd`, `data-key-within`, `data-focus-mode`, `data-default-ring`) **and** the legal `document.activeElement` are computed by one pure function of engine state (Spec S02) and applied by one `reproject()` pass. Projection is **state-driven**, not transition-driven: any caller may run `reproject()` at any time and the DOM converges to the model.

**Rationale:**
- The seam-1 defect exists precisely because projection runs only on the transitions each sync method happens to see; a state-driven pass makes a transient null key card harmless by construction.
- The watchdog already computes "the one legal activeElement" separately (`legalKeyboardElement`); unifying it with the mark projection removes the second, drifting copy of the same derivation.
- This is [L06]/[L24] taken to its conclusion: appearance is a projection of structure, owned by the engine.

**Implications:**
- `projectAll`, `syncKeyViewDomAttribute`, `syncKeyWithinDomAttribute`, `syncFocusModeDomAttribute`, `syncDefaultRingDomAttribute`, and `legalKeyboardElement` all become callers of (or are absorbed into) the shared computation.
- A background context still never projects (the active-context gate stays); what changes is that the *active* context's projection is recomputable from state alone.
- The clear-all-then-stamp global sweep survives as the reconciler's repair action, not as every sync's unconditional first move.

#### [P03] The watchdog is the projection reconciler (DECIDED) {#p03-watchdog-reconciler}

**Decision:** `checkFocusInvariant` becomes "compute desired projection from engine state; diff against the DOM; reproject the difference" — for marks and for `activeElement` alike. The steal ledger, offender attribution, quiet-vs-warn classification, `REASSERT_BUDGET`, and the failed-correction ledger survive unchanged in semantics.

**Rationale:**
- Reconciling one computation is structurally simpler than enforcing a hand-maintained legal set beside a separately-synced mark set.
- The brief's mandate: surviving special cases must be named contracts, not carve-outs. The reconciler forces each carve-out to either fall out of the computation (the engine's own stop taking browser focus: ring and router agree, only the register is off — a quiet reproject) or be named (the deferred-gesture browser-default window: a declared "browser churn is expected until the gesture resolves" contract).

**Implications:**
- `enforceKeyboardRoute` / `scheduleFocusInvariantCheck` keep their macrotask coalescing and budget (the two-enforcers-can-never-lock-the-app guarantee is preserved verbatim).
- App-tests keep asserting `violations === 0` and steal budgets; the report shape (`focusInvariantReport()`) is unchanged.
- The grant-lost incoherence path (`noteGrantLost`, route fallback to engine-routed) stays — it is model repair, not projection repair, and remains loud.

#### [P04] Theft protection is an engine query; the gate module retires (DECIDED) {#p04-gate-fold}

**Decision:** `canProgrammaticallyFocus`'s decision tree is replaced by `FocusManager.mayClaimActivationFocus(targetCardId)` (Spec S03), which answers from engine + deck state — never by classifying `document.activeElement` against a taxonomy of element kinds. `focus-theft-gate.ts` is deleted; its callers (`transferFocusForActivation`, `transferFocusAfterMove`, `reactivateCurrentFocusDestination` in `tugdeck/src/focus-transfer.ts`) call the engine query.

**Rationale:**
- Branches 3/5/5b/6/6b of the gate reverse-engineer engine facts from the DOM: "body has focus" ≈ no grant outstanding; "sink is focused" ≈ engine-routed park; "focus is in another card" ≈ that card holds a dom-granted target. The engine knows each of these directly (`keyboardRoute()`, per-card `target()`, `keyCard()`).
- The one live protection the gate could not host — a permitted dispatch must not displace a live ring — already had to relocate to `resolveBagFocus` (the brief's seam 3: found by breaking at0248 three ways). Folding the gate ends the layering ambiguity that forced that hunt.

**Implications:**
- Branch 1 (app backgrounded, `state.hasFocus`) and branch 2 (stale focus destination, `isFocusDestination`) survive as the query's deck-state inputs — they were never DOM classification.
- The chrome allowlist (`data-tug-chrome="non-focus-capturing"`, branch 5) survives as the query's one DOM input for genuinely un-modeled chrome, explicitly named in Spec S03; if the interpreter later models those gestures, it shrinks further.
- Behavior-pinning tests for the old branches (cross-card navigation at0003/at0201, sheet-portal at0100-class) must stay green across the swap.

#### [P05] Deselect is a deliberate classification; transient key-card churn is harmless (DECIDED) {#p05-deliberate-deselect}

**Decision:** The interpreter classifies `deselect` only when the pointerdown's *target element itself* is the deck canvas background surface — not whenever a click merely fails to land inside a pane (`paneEl === null` today). Any gesture that misses every pane but strikes portal gaps, overlay seams, or below-the-fold geometry classifies as `chrome` (no activation change). Independently, [P02] makes any remaining transient `setKeyCard(null)` unable to wipe a live context's marks.

**Rationale:**
- Brief seam 2: `deselectActiveCard` is reachable by accident today, with the seam-1 projection wipe cascading behind it (at0112's fixture-geometry failure was exactly this: a click on empty canvas → deselect → key card null → wipe).
- Defense in depth: classify deliberately *and* make the accident harmless.

**Implications:**
- `DeckCanvas`'s background element gains an explicit marker the interpreter tests against (target identity, not ancestor containment).
- The existing overlay short-circuit (`[data-slot="tug-canvas-overlay-root"]`) folds into the same classification instead of being a pre-branch special case.
- at0003's deselect scenario must still pass (a genuine canvas click still deselects).

#### [P06] Default focus resolves from the engine registry first (DECIDED) {#p06-engine-default-focus}

**Decision:** "What gets focus when a card activates with no saved target" is answered by the card's `FocusContext`: the first record of `walkOrder()` (authored group order, already filtered for rendered/interactive/refuse-free stops), placed via `place()`. The DOM selector chain in `tugdeck/src/default-focus.ts` (`DEFAULT_FOCUS_SELECTORS`) survives only for engine-less bootstraps (gallery previews, headless) and as the fallback when the card's context has no registered focusables.

**Rationale:**
- Brief seam 4: the selector chain is DOM-shaped, walks raw selectors, and had to learn the refuse exclusion as a bolt-on (`refusesFocus` checking `closest('[data-tug-focus="refuse"]')` per candidate). The engine's walk already encodes rendered-ness, interactivity, refuse policy, and authored order — the same question with one source of truth.
- `resolveDefaultFocusTarget` is also read by `settleFirstResponderForActivation` (focus-manager.ts) — routing both through the registry removes a second DOM-vs-engine disagreement point.

**Implications:**
- Cards whose focusables register via `useFocusable` get registry-resolved defaults; cards with only raw DOM focusables (native inputs with `data-tug-state-key`, untagged content) still fall through to the selector chain.
- The priority contract is preserved: an author-tagged `data-tug-focus-key="primary"` maps to the registry's authored order (rung 1–2 ≈ named-group stops); rung 3–4 remain DOM fallback.

**Build-time amendment (#step-9), NARROWED to the first-responder settle.** Registry-first resolution shipped for `settleFirstResponderForActivation` only. Routing the default focus CLAIM through it as well is a user-visible behavior change, not a refactor: the registry head of a button-class card is a nameable stop, so `placeViaEngine` places it and the card acquires a key view merely for coming forward — and the first Tab then advances PAST the card's first authored stop instead of landing on it. at0112/at0113/at0114 encode the current contract ("Tab → key view lands on the first accept stop") and went red on exactly that; they are also on the baseline this plan promises to keep green (#success-criteria). Two premises of the decision were also wrong in the code: `walkOrder()` does **not** filter refuse — refusal governs what a POINTER gesture may move, while registration is an explicit authoring act, so a refusing button authored into a focus group is a legitimate stop — and the walk's rendered/interactive filters make a background card's registry answer empty exactly when the DOM chain's `isElementHidden` does. The claim half wants its own decision about whether activation should seed a key view; it is not foundation work. `FocusManager.defaultFocusableIdForCard` / `defaultFocusableForCard` are the shipped resolution, and `default-focus.ts`'s chain still owns the claim.

#### [P07] Test assertions state invariants, not mechanisms (DECIDED) {#p07-invariant-assertions}

**Decision:** App-tests assert engine facts — `window.__tug.getFocusedCardId()`, `getFirstResponderId()`, `getFocusInvariantReport()`, `[data-key-view]` / `[data-first-responder]` containment — with DOM-focus checks (`el.contains(document.activeElement)`) allowed only as the explicit dom-granted alternative in an either/or assertion. Mechanism spellings (`tabindex="-1"` attributes) are never asserted; the invariant ("not a Tab stop", "keyboard is here") is. Selectors that mirror product strings/ids come from a shared constants module, `tests/app-test/_harness/selectors.ts`.

**Rationale:**
- Brief §4 causes 4 and 5: three tests asserted the opposite of their own stated contract because the sink parks outside every card; one renamed `aria-label` silently broke seven files. Nothing tied selectors to the source they mirror.
- The engine route makes activeElement-as-truth false *by construction*; the corpus must encode the new ontology or every projection change reads as a regression.

**Implications:**
- Step 1's sweep converts existing offenders; new tests import from the constants module; `just app-test-covers-check` continues to gate `@covers`.
- The constants module is harness infrastructure (`tests/app-test/_harness/`), so changing it advises a sweep — which is correct, since a selector rename affects every consumer.

---

### Deep Dives {#deep-dives}

#### The four classifiers and their facets today {#classifier-inventory}

**Table T01: Current pointer-gesture classifiers and the decisions they duplicate** {#t01-classifier-inventory}

| Concern | Current owner | Current predicate(s) |
|---------|---------------|----------------------|
| Primary-button filter | all four | `event.button !== 0` (list: `e.button !== 0`) |
| Deck containment / portal exemption | pane-focus-controller | `root.contains(startEl)`, `closest('[data-slot="tug-canvas-overlay-root"]')` |
| Activation vs deselect | pane-focus-controller `onPointerDown` | `closest("[data-pane-id]")` + synthetic-pane climb, `metaKey`, `[data-no-activate]`, scrim check |
| Deferred drag-activation | pane-focus-controller + provider (duplicated) | `closest('[draggable="true"]')` + non-key-card (`isDeferredDragActivation` mirrors the controller "so the two halves agree by construction" — i.e., by hand) |
| Browser-default suppression | pane-focus-controller `onMouseDown` + provider `preventFocusOnMouseDown` | activation flag, `[data-card-host]`, `[data-slot="tug-sheet"]`, refuse, fr-preserve, scrim redirect |
| Chain promotion | provider `promoteOnPointerDown` | refuse, fr-preserve, modal-scrim redirect (`modalScrimRedirectTarget`), deferred-drag |
| Engine placement | provider `placeFromPointer` | key-card gate, refuse, marker walk (`data-tug-state-key` / `data-tug-focusable` / `data-responder-id`), dom-granted `none` place |
| Placement suppression handoff | FocusManager one-shot latch | `suppressPointerPlacementOnce` armed by controller, consumed by provider — cross-module state for one gesture |
| List selection + keyboard place | TugListView `pointerDownCb` | `defaultPrevented`, `cellIsPickable`, `cellHasOpenEditor`, then `place(..., keyboard)` |
| Post-drag stream heal | pane-focus-controller resync shim | trusted mousedown with no preceding pointerdown → synthesize pointerdown |

The interpreter absorbs every row's *gesture-level* predicate; cell-local rows (pickability, open editor, grip-drag `defaultPrevented`) stay with the list, which is content policy, not gesture classification.

#### Why projection must be state-driven — the seam-1 trace {#seam1-trace}

Current flow: `setKeyCard(A)` → `activeContext().projectAll()` → each sync runs "clear all globally, then stamp." `setKeyCard(null)` (a deselect, or any transient) → the **default context** becomes active → its `projectAll` clears A's marks globally and stamps nothing (its key view is null). Returning to A restamps **only if** `setKeyCard(A)` fires again — the store subscription in the provider (`syncKeyCard`) only fires on an actual change of `getFirstResponderCardId()`, so sequences that end where they began can leave the wipe standing. Additionally `focusKeyView`, `popFocusMode`, and `refreshKeyViewProjection` each re-derive parts of the projection on their own schedules. Under [P02], all of these become "mutate state; call `reproject()`" — and the reconciler can also run `reproject()` on a watchdog pass, healing any missed transition.

#### The gate's branches, mapped to engine queries {#gate-branch-map}

**Table T02: `canProgrammaticallyFocus` branch → Spec S03 disposition** {#t02-gate-branch-map}

| Branch | Today | Under [P04] |
|--------|-------|-------------|
| 1 app backgrounded | `!state.hasFocus` → refuse | kept: deck-state input |
| 2 stale destination | `!isFocusDestination(target)` → refuse | kept: deck-state input |
| 3 body focused | permit | derived: no dom-granted target holds a grant → permit |
| 4 focus already in target card | permit | derived: engine target for this card is realized → permit (idempotent claim) |
| 5 non-focus-capturing chrome | permit | kept (named DOM input): un-modeled chrome allowlist |
| 5b sink parked | permit (treaty clause) | evaporates: engine-routed is the engine's own state; nothing to classify |
| 6 focus in another deck card | permit | derived: another card holds the grant → cross-card activation is deliberate navigation → permit |
| 6b pane-modal sheet | permit | derived: the sheet's controls register into its trap mode on a deck card's context → same as 6 (least-evidenced derivation; pinned by at0100) |
| 7 otherwise refuse | refuse | kept: default refuse (a real dom-granted surface outside the target holds the keyboard and the dispatch is not a navigation) |

The live-ring protection stays where seam 3's triage put it — `resolveBagFocus` returns `none` when the engine already holds the target card's key view — and gets a comment naming it as the [P04] downstream protection, not a leftover.

---

### Specification {#specification}

**Spec S01: `GestureClassification`** {#s01-gesture-classification}

One record per pointer gesture, computed synchronously at capture-phase pointerdown (or at the resync-healed synthetic pointerdown) and retired at gesture end (pointerup / pointercancel / dragend). Consumers read it; none re-derive.

```ts
interface GestureClassification {
  /** Monotonic gesture id, for consumers that must pair pointerdown with a later phase. */
  gestureId: number;
  button: number;
  /** Where the gesture landed, resolved once. */
  site: "pane" | "canvas-background" | "overlay" | "outside-deck";
  paneId: string | null;          // real store pane after the synthetic-pane climb
  cardId: string | null;          // closest [data-card-id]
  /** The activation decision. */
  activation: "activate" | "deferred" | "none" | "deselect";
  /** Chain-promotion decision. */
  promotion: { kind: "target" } | { kind: "redirect"; to: Element } | { kind: "skip" };
  /** Engine pointer-placement decision. */
  placement: "place" | "suppressed" | "skip";
  /** Whether the paired mousedown's browser focus default is prevented. */
  preventMousedownDefault: boolean;
  /** Named reasons, for the dev log and tests (refuse, fr-preserve, modal-scrim, no-activate, meta, draggable-background, …). */
  reasons: string[];
}
```

- The module exposes `currentGesture(): GestureClassification | null` plus registration hooks for the phase consumers (activation commit on pointerup for `deferred`, drag cancel on dragstart) — the same resolution listeners `pane-focus-controller.ts` owns today, relocated.
- The `placement: "suppressed"` facet replaces the `FocusManager` one-shot latch pair (`suppressPointerPlacementOnce` / `consumePointerPlacementSuppression`), which is deleted.
- The deferred-gesture browser-default window (`beginDeferredGesture` / `endDeferredGesture` on `FocusManager`) is driven by the interpreter at classification/resolution time — same engine API, one caller.
- The resync shim moves in verbatim: it is the interpreter's stream-healing front end, registered before all other pointer listeners.

**Spec S02: `FocusProjection`** {#s02-focus-projection}

A pure derivation from `(FocusManager deck-globals, active FocusContext)`:

```ts
interface FocusProjection {
  keyViewId: string | null;        // → data-key-view on the resolved element
  keyViewKbd: boolean;             // → data-key-view-kbd (keyboard modality or ring-follows-pointer)
  keyWithinId: string | null;      // → data-key-within (top non-trapped scope's restoreKeyView)
  focusMode: string | null;        // → data-focus-mode on documentElement (null at base)
  defaultRingEl: HTMLElement | null; // → data-default-ring (top of stack iff key view is not a button)
  /** The legal activeElement, unified with the watchdog's legalKeyboardElement:
      engine-routed → innermost sink; dom-granted → granted surface by containment;
      accessibility+engine-routed → the key-view element; plus the standing
      legality classes (any sink park, bare native control, body/null tolerated). */
  legalActive: { el: HTMLElement | null; route: KeyboardRoute };
}
```

- `computeProjection()` is side-effect-free; `reproject()` applies it (diff-then-write per mark, global clear as the repair action), gated on the active context exactly as today.
- `scheduleFocusInvariantCheck` retains its macrotask coalescing; the check body becomes: recompute, diff marks *and* register, attribute + reproject differences per the existing quiet/warn/budget rules.

**Spec S03: `FocusManager.mayClaimActivationFocus(targetCardId, state)`** {#s03-activation-permission}

Replaces `canProgrammaticallyFocus`. Inputs: deck snapshot (`hasFocus`, `isFocusDestination`), engine state (`keyCard()`, per-card `target()` + `keyboardRoute()`), and the one named DOM input (the `data-tug-chrome="non-focus-capturing"` allowlist). Dispositions per Table T02. Refusal remains the default; the function logs its reason to the dev log at `debug` so a refused activation is diagnosable without a triage scratch test.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `GestureClassification` record | structure (transient, per-gesture) | module singleton in `gesture-interpreter.ts`; no React state; installed via `useLayoutEffect` | [L03], [L22] |
| `FocusProjection` marks | appearance | CSS/DOM attributes written by `reproject()` only | [L06], [L24] |
| Legal `activeElement` | structure → peripheral register | engine enforcement via reconciler; never derived from | [L22] |
| Engine truth (key card, contexts, targets) | structure | `FocusManager` / `FocusContext`, `useSyncExternalStore` for React readers | [L02], [L22] |
| Deck `data-focused` pane attribute | appearance | unchanged: `usePaneFocusController` `useLayoutEffect` DOM writes | [L06] |
| Test selector constants | n/a (test infra) | `tests/app-test/_harness/selectors.ts` | — |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/gesture-interpreter.ts` | The one pointer-stream owner: listeners, resync shim, `GestureClassification`, consumer hooks (Spec S01) |
| `tests/app-test/_harness/selectors.ts` | Shared selector constants mirroring product strings/ids ([P07]) |
| `tests/app-test/at02xx-focus-projection.test.ts` (number assigned from the inventory) | DOM-mark projection round trip + reconciler mark-heal (#step-4, #step-5); `@covers` `tugdeck/src/components/tugways/focus-manager.ts` |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `GestureClassification`, `currentGesture`, `installGestureInterpreter` | interface/fns | `gesture-interpreter.ts` | Spec S01 |
| `computeProjection`, `reproject` | methods | `focus-manager.ts` (`FocusContext`/`FocusManager`) | Spec S02; absorb `projectAll` + the four `sync*DomAttribute` methods + `legalKeyboardElement` |
| `checkFocusInvariant` | method (rewrite) | `focus-manager.ts` | reconciler over Spec S02; ledger/budget semantics preserved |
| `mayClaimActivationFocus` | method | `focus-manager.ts` | Spec S03 |
| `suppressPointerPlacementOnce` / `consumePointerPlacementSuppression` | delete | `focus-manager.ts` | replaced by `placement: "suppressed"` facet |
| `canProgrammaticallyFocus`, `isNonFocusCapturingChrome` | delete/relocate | `focus-theft-gate.ts` → deleted; chrome predicate moves beside Spec S03 | [P04] |
| `onPointerDown`/`onMouseDown`/resync/drag listeners | relocate | `pane-focus-controller.ts` → `gesture-interpreter.ts` | controller keeps `data-focused` authority + becomes consumer |
| `promoteOnPointerDown`, `preventFocusOnMouseDown`, `isDeferredDragActivation`, `modalScrimRedirectTarget`, `isFocusRefusing`, `isFrPreserving` | rewrite as consumers / relocate predicates into interpreter | `responder-chain-provider.tsx` | classification predicates move; promotion/placement bodies stay, driven by the record |
| `resolveDefaultFocusTarget` | extend | `default-focus.ts` + `focus-manager.ts` | registry-first resolution ([P06]); DOM chain fallback |
| `pointerDownCb` | modify | `tug-list-view.tsx` | reads `currentGesture()` for gesture-level facts |
| Deck canvas background marker | attribute | `DeckCanvas` (tugdeck chrome) | deliberate-deselect target identity ([P05]) |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/focus-language.md`: rewrite "One writer" into "One writer, one interpreter, one truth"; document the projection/reconciler model, the named surviving contracts (deferred-gesture window, reassert budget, chrome allowlist), and the gate's retirement; keep § Drag and the keyboard pointing at the interpreter as the stream owner.
- [ ] `tuglaws/responder-chain.md`: update the promotion section to name the interpreter as the pointer input.
- [ ] `tuglaws/app-test-inventory.md`: at0224 restored entry; [Q03] outcome for at0120.
- [ ] `tests/app-test/README.md`: note the selector-constants module.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (pure-logic engine)** | Drive `FocusManager`/`FocusContext` against bare managers (the existing focus-walk suite pattern) | projection computation, transient-key-card round trips, permission query dispositions |
| **App-test (real Tug.app)** | Real WebKit, real gestures via CGEvent | activation/deselect/drag classification, watchdog budgets, the [P21] invariant |
| **Grep/structural checks** | Enforce single-classifier and no-raw-classification claims | step checkpoints |

#### What stays out of tests {#test-non-goals}

- jsdom render tests, mock-store assertions, synthetic fixtures — banned; engine logic is tested against the real manager classes, gesture behavior against the real app.
- Mechanism spellings (tabindex attributes, specific listener registration order) — assert invariants, per [P07].
- Timing-sensitive watchdog internals (macrotask scheduling) — covered indirectly by the budget assertions in at0250/at0251; direct timer tests would be brittle for no coverage gain.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Corpus sweep + selector constants | done | `54f5d1643` |
| #step-2 | Restore at0224 against engine facts | done | `f2c261335` |
| #step-3 | at0120 order-sensitivity diagnosis | done | `332b69e62` |
| #step-4 | State-driven projection | done | `fe7c467df` |
| #step-5 | Watchdog as reconciler | done | `37232a479` |
| #step-6 | Fold the theft gate | done | `9715fa561` |
| #step-7 | Gesture interpreter + activation/deselect | done | `db3d984ca` |
| #step-8 | Provider + list consume the classification | done | `ca301a565` |
| #step-9 | Engine-registry default focus | done (narrowed — see [P06] amendment) | `61340e068` |
| #step-10 | Doctrine rewrite | done | `e0cb05182` |
| #step-11 | Integration checkpoint | done | verification only |

#### Step 1: Corpus sweep + selector constants {#step-1}

**Commit:** `app-test(focus): sweep activeElement-as-truth and mechanism pins, add shared selector constants`

**References:** [P07] Invariant assertions, (#context, #strategy), brief §4 causes 4–5, §5 seam 7

**Artifacts:**
- `tests/app-test/_harness/selectors.ts` with the rename-prone selectors (the Route button's `aria-label="Route this input"`, route-menu item ids, dialog island selectors `.session-question-dialog` / `.session-permission-dialog`, sink/key-view/first-responder attribute selectors).
- Corpus-wide fixes converting activeElement-as-truth assertions to engine facts and tabindex-spelling assertions to invariant assertions.

**Tasks:**
- [ ] Grep the corpus: `contains(document.activeElement)`, `document.activeElement`, `tabindex`, `tabIndex`, `aria-label="Route`, glyph route ids (`$`, `❯`). Triage each hit: engine-fact rewrite (with the DOM check kept only as an explicit dom-granted alternative), invariant rewrite, or legitimate dom-granted assertion left alone with a comment.
- [ ] Create the selectors module; migrate the seven Route-selector files (at0140/at0157/at0159/at0179/at0223 and peers) plus any sweep-touched files to import from it.
- [ ] Record the sweep's per-file disposition in the commit message body (files changed, pattern each carried).

**Tests:**
- [ ] Every rewritten test runs green individually (`just app-test <file>` for each touched file, batched sensibly).

**Checkpoint:**
- [ ] `just app-test-covers-check` clean.
- [ ] `grep -rn "contains(document.activeElement)" tests/app-test --include="*.test.ts"` returns only explicitly-commented dom-granted alternatives.
- [ ] `bunx tsc --noEmit` clean.

---

#### Step 2: Restore at0224 against engine facts {#step-2}

**Depends on:** #step-1

**Commit:** `app-test(focus): restore at0224 active-card keyboard invariant on engine facts`

**References:** [P07], Risk R01, (#r01-invariant-gap), brief §4 "Deleted while red"

**Artifacts:**
- `tests/app-test/at0224-*.test.ts` restored from `git show fb87256fb^:tests/app-test/<file>`, assertions rewritten per [P07], `@covers` updated, inventory ⚠️ reservation cleared.

**Tasks:**
- [ ] Restore the file; keep its four scenarios (title-bar click, deactivated-card reactivation, openFileInCard ⌘F, cycle-to-never-focused).
- [ ] Rewrite assertions to `getFocusedCardId()` / `getFirstResponderId()` / `[data-key-view]` containment / `getFocusInvariantReport()`.
- [ ] For each still-red sub-scenario, instrument (dev-log reads, `window.__tug` snapshots at failure) and fix the engine defect it exposes; a defect deferred rather than fixed gets a named skip with the cause in the test file and inventory.

**Tests:**
- [ ] at0224 green (or partially green with named, documented skips — never silent).

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0224-*.test.ts` passes.
- [ ] `just app-test-covers-check` clean.

---

#### Step 3: at0120 order-sensitivity diagnosis {#step-3}

**Depends on:** #step-1

**Commit:** `app-test(harness): resolve at0120 batch order-sensitivity` (or an inventory-note commit if quarantined)

**References:** [Q03], (#q03-at0120-order), brief §4 flake note

**Artifacts:**
- Either a fix (harness or app side) or a written cause + quarantine note in `tuglaws/app-test-inventory.md`.

**Tasks:**
- [ ] Reproduce the 21-file batch that failed; bisect the preceding-file set to a minimal order.
- [ ] Instrument at failure: `getFocusInvariantReport()`, the dev-log snapshot, machine-gate state; classify as harness state leakage vs app residue.
- [ ] Fix, or quarantine with the cause named.

**Tests:**
- [ ] at0120 green 3× in the previously-failing order (if fixed).

**Checkpoint:**
- [ ] [Q03]'s Resolution line in this plan updated (OPEN → DECIDED/DEFERRED with the finding).

---

#### Step 4: State-driven projection {#step-4}

**Depends on:** #step-2

**Commit:** `tugways(focus): state-driven projection — reproject() derives every mark from engine state`

**References:** [P02] One truth, [P05] (harmless-transient half), Spec S02, (#seam1-trace, #p02-one-truth)

**Artifacts:**
- `computeProjection()` / `reproject()` on the engine; `projectAll` + `syncKeyViewDomAttribute` + `syncKeyWithinDomAttribute` + `syncFocusModeDomAttribute` + `syncDefaultRingDomAttribute` absorbed; every former call site (`setKeyView`, `refreshKeyViewProjection`, `pushFocusMode`, `popFocusMode`, `relinquishFocusMode`, `setKeyCard`, `registerDefaultRing`/`unregisterDefaultRing`) becomes mutate-then-`reproject()`.

**Tasks:**
- [ ] Implement Spec S02's computation as a pure derivation; keep the active-context gate and the accessibility-mode mirror hook exactly where the current syncs invoke them.
- [ ] Make `reproject()` diff-then-write per mark, with the global clear-all as the repair action for marks found on wrong elements.
- [ ] Preserve the roving fast path (`refreshKeyViewProjection`) as a thin wrapper over `reproject()`.
- [ ] Test the seam-1 scenario at the right tiers. **tugdeck's bun:test has no DOM** (the focus-walk / focus-route suites state this doctrine: pure-logic in bun:test, the park/grant DOM side in app-tests — never happy-dom/jsdom). So the coverage splits:
  - **bun:test (pure record):** `computeProjection()` returns an identical record after the transient round trip (place a keyboard target on card A's context; `setKeyCard(null)`; `setKeyCard(A)`; compare records); a background context mutating its stack never changes the active projection record; record-level no-op stability (two consecutive computations are equal).
  - **App-test (DOM marks):** a new `tests/app-test/` file with `@covers` on `tugdeck/src/components/tugways/focus-manager.ts`, driving the real app: place a keyboard target, deselect via canvas click, reactivate, and assert via `window.__tug` + attribute queries that `data-key-view` / `data-key-view-kbd` / `data-key-within` / `data-focus-mode` are restamped identically — the seam-1 live repro, pinned.

**Tests:**
- [ ] Existing focus-walk / focus-manager unit suites pass unchanged.
- [ ] New pure-record bun:test cases (transient round trip, background-context isolation, no-op stability) — record-level only, no DOM reads.
- [ ] New projection app-test (DOM-mark round trip) green.

**Checkpoint:**
- [ ] `bun test` (tugdeck unit) green; `bunx tsc --noEmit` clean; `bunx vite build` green.
- [ ] `just app-test-changed` selection green (must include the new projection app-test, at0246–at0248, at0112, at0224).
- [ ] `just app-test-covers-check` clean (new app-test `@covers`-mapped).

---

#### Step 5: Watchdog as reconciler {#step-5}

**Depends on:** #step-4

**Commit:** `tugways(focus): watchdog becomes the projection reconciler`

**References:** [P03], Spec S02 (`legalActive`), (#p03-watchdog-reconciler), brief §5 seam 6

**Artifacts:**
- `checkFocusInvariant` rewritten: recompute Spec S02, diff marks + register, reproject differences under the existing quiet/warn/budget/ledger rules; `legalKeyboardElement` absorbed into `computeProjection`.
- Each surviving special case named in code comments as a contract: the deferred-gesture window, the own-stop quiet class, bare-native-control legality, body-tolerance, the reassert budget, the grant-lost fallback.

**Tasks:**
- [ ] Rewrite the check body; delete any carve-out that the unified computation makes unreachable (verify by test, not assumption — pure-record cases in bun:test where DOM-free, app-test otherwise).
- [ ] Keep `focusInvariantReport()`'s shape and the macrotask scheduling byte-for-byte in semantics.
- [ ] Confirm the reconciler heals a mark wipe — an **app-test** scenario (bun:test has no DOM): in the step-4 projection app-test file, externally strip `data-key-view` (page-side `removeAttribute` via the harness), trigger a focus event, and assert the next reconciler pass restamps it (the capability transition-driven syncs never had). Assert `getFocusInvariantReport()` classifies it per the quiet/warn rules.

**Tests:**
- [ ] Watchdog pure-logic unit tests (report shape, budget-counter semantics) pass; DOM-dependent watchdog behavior (steal attribution, grant-lost, mark-heal) rides the projection app-test + at0250/at0251.
- [ ] New mark-heal app-test scenario green.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0250-*.test.ts tests/app-test/at0251-*.test.ts tests/app-test/at0246-*.test.ts tests/app-test/at0224-*.test.ts` green (steal budgets flat).
- [ ] `bunx vite build` green.

---

#### Step 6: Fold the theft gate {#step-6}

**Depends on:** #step-5

**Commit:** `tugways(focus): fold the theft gate into the engine — mayClaimActivationFocus`

**References:** [P04], Spec S03, Table T02, (#gate-branch-map), brief §3.2 + §5 seam 3

**Artifacts:**
- `FocusManager.mayClaimActivationFocus` per Spec S03; `focus-transfer.ts` call sites switched; `focus-theft-gate.ts` deleted; the chrome allowlist predicate relocated beside the query; the `resolveBagFocus` live-ring guard commented as the downstream protection.

**Tasks:**
- [ ] Implement the query with per-disposition dev-log `debug` reasons.
- [ ] Migrate `transferFocusForActivation`, `transferFocusAfterMove`, `reactivateCurrentFocusDestination`; delete the gate module and its unit tests' DOM-taxonomy cases (rewrite the behavioral ones against the query).
- [ ] Verify each Table T02 row's pinned behavior with its existing app-test rather than by inspection.

**Tests:**
- [ ] Unit tests for the query's dispositions (backgrounded refuse, stale-destination refuse, cross-card permit, dom-granted-elsewhere refuse, chrome permit).

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0003-*.test.ts tests/app-test/at0201-*.test.ts tests/app-test/at0100-*.test.ts tests/app-test/at0148-*.test.ts tests/app-test/at0203-*.test.ts tests/app-test/at0224-*.test.ts` green (activation taxonomy: pane click, activation clicks, sheet pane-modal focus — the only pin on branch 6b's derivation, window blur→focus, modal click-away/back).
- [ ] `grep -rn "canProgrammaticallyFocus" tugdeck/src` returns nothing.

---

#### Step 7: Gesture interpreter + activation/deselect {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(gesture): one gesture interpreter owns the pointer stream; deliberate deselect`

**References:** [P01], [P05], Spec S01, Table T01, (#classifier-inventory, #p05-deliberate-deselect), brief §3.1 + §5 seam 2

**Artifacts:**
- `tugdeck/src/gesture-interpreter.ts` with Spec S01; `pane-focus-controller.ts` reduced to the `data-focused` authority + an activation/deselect consumer; the resync shim, deferred-drag latch, activation-click mousedown suppression, and drag-resolution listeners relocated into the interpreter; the deck-canvas background marker for target-identity deselect.

**Tasks:**
- [ ] Implement the interpreter: listener installation (registered from `usePaneFocusController`'s `useLayoutEffect`, resync pair first), classification per Table T01's gesture-level rows, gesture lifecycle (pointerup commit / dragstart cancel / pointercancel-dragend abandon), `beginDeferredGesture`/`endDeferredGesture` driving.
- [ ] Deliberate deselect: classify `deselect` only when `event.target` is the marked canvas background element; portal gaps and overlay seams classify `chrome` with a named reason.
- [ ] Rewrite `pane-focus-controller` as consumer; delete its duplicated predicates.
- [ ] Keep `transferFocusForActivation` invocation semantics identical (synchronous for `activate`, on pointerup for `deferred`).

**Tests:**
- [ ] Classification is DOM-dependent, so no fake-DOM unit tests (per #test-non-goals): cover the classification via the app-tests below, plus pure-logic unit tests only for the DOM-free parts (record lifecycle, gesture-id pairing, reason accumulation).
- [ ] App-tests: at0003 (activation + genuine deselect), at0267 (drag activation deferral), at0201 (activation click 3/3), a post-drag first-click scenario (resync shim relocation — reuse/extend at0267).

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0003-*.test.ts tests/app-test/at0267-*.test.ts tests/app-test/at0201-*.test.ts tests/app-test/at0112-*.test.ts tests/app-test/at0224-*.test.ts` green.
- [ ] `bunx vite build` green; `just app-test-covers-check` clean (new file `@covers`-mapped).

---

#### Step 8: Provider + list consume the classification {#step-8}

**Depends on:** #step-7

**Commit:** `tugways(focus): chain promotion, pointer placement, and list selection consume the classified gesture`

**References:** [P01], Spec S01, Table T01, (#classifier-inventory), brief §2a

**Artifacts:**
- `promoteOnPointerDown` / `preventFocusOnMouseDown` rewritten to read `currentGesture()` (promotion facet incl. modal-scrim redirect; `preventMousedownDefault` facet); `isFocusRefusing` / `isFrPreserving` / `modalScrimRedirectTarget` / `isDeferredDragActivation` relocated into the interpreter's classification; the `FocusManager` suppression latch pair deleted in favor of the `placement` facet; `TugListView.pointerDownCb` reads gesture facts, keeps cell-local policy.

**Tasks:**
- [ ] Rewire the provider's two pointer listeners; the placement body (`placeFromPointer`'s marker walk and dom-granted `none` place) stays but runs only when `placement === "place"`.
- [ ] Delete `suppressPointerPlacementOnce` / `consumePointerPlacementSuppression` and their call sites.
- [ ] Update `tug-list-view.tsx`: `pointerDownCb` consults `currentGesture()` for activation/deferral facts instead of relying implicitly on `place()`'s key-card gate; cell-local guards unchanged.
- [ ] Structural check: no classification predicate (`FOCUS_REFUSE_SELECTOR` walks for gesture purposes, scrim/pane classification) remains outside the interpreter.

**Tests:**
- [ ] App-tests: at0121/at0122 (list view), at0150 (sheet spatial), at0157/at0159 (Escape/alert — scrim redirect), at0203-class modal click-away, at0248 (Lens cursor keys), at0224.

**Checkpoint:**
- [ ] The #success-criteria single-classifier grep passes.
- [ ] Listed app-tests green; `bunx tsc --noEmit`; `bunx vite build`.

---

#### Step 9: Engine-registry default focus {#step-9}

**Depends on:** #step-8

**Commit:** `tugdeck(focus): default focus resolves from the engine registry first`

**References:** [P06], (#p06-engine-default-focus), brief §5 seam 4, §4 cause 1

**Artifacts:**
- Registry-first resolution: activation-with-no-saved-target asks the card's `FocusContext.walkOrder()` head and places it via `place()`; `resolveDefaultFocusTarget`'s DOM chain demoted to fallback; `settleFirstResponderForActivation`'s default-target read routed the same way.

**Tasks:**
- [ ] Implement the registry-first branch in the `default-focus` resolution path used by `applyBagFocus` / `traceApplyDefaultFocus`; the DOM chain (with its `refusesFocus` guard) remains for engine-less bootstraps and registry-empty cards.
- [ ] Route `settleFirstResponderForActivation`'s never-focused-card branch through the same resolution.
- [ ] Unit-test: a context with authored groups resolves its first rendered, interactive, refuse-free stop; an empty registry falls through to the DOM chain (pure-logic, bare manager — no DOM reads).
- [ ] Cover the addCard/cold-boot path, not just tab-switch (Risk R03: focusables can register *after* `setKeyCard` runs the activation settle) — an app-test scenario that adds a fresh card and asserts the default target lands once its focusables register.

**Tests:**
- [ ] App-tests: at0112–at0115 (default-focus walk landed correctly on leaf-control cards), at0140 (cycle 4/4), at0247 (relaunch Lens), plus the addCard-path scenario.

**Checkpoint:**
- [ ] Listed app-tests green; unit tests green; `bunx vite build`.

---

#### Step 10: Doctrine rewrite {#step-10}

**Depends on:** #step-7, #step-8, #step-9

**Commit:** `tuglaws(focus-language): one interpreter, one truth, gate folded`

**References:** [P01]–[P06], (#documentation-plan)

**Artifacts:**
- `tuglaws/focus-language.md` and `tuglaws/responder-chain.md` updated per the Documentation Plan; every named surviving contract documented where its code lives is cross-referenced.

**Tasks:**
- [ ] Rewrite "One writer" → "One writer, one interpreter, one truth"; document Spec S01/S02/S03 at doctrine altitude; retire the gate's section; update § Drag and the keyboard's owner references.
- [ ] Sweep both docs for now-stale symbol names (`canProgrammaticallyFocus`, `pane-focus-controller` classification references).

**Tests:** none (docs).

**Checkpoint:**
- [ ] `grep -rn "canProgrammaticallyFocus\|focus-theft-gate" tuglaws/` returns only historical/design-decision references, not living contract text.

---

#### Step 11: Integration checkpoint {#step-11}

**Depends on:** #step-4, #step-5, #step-6, #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Run the full baseline selection and confirm every #success-criteria bullet.

**Tests:**
- [ ] `just app-test` (core tier) plus the explicit focus selection: at0003 at0100 at0112 at0113 at0114 at0115 at0120 at0121 at0122 at0140 at0148 at0150 at0157 at0159 at0179 at0201 at0203 at0223 at0224 at0246 at0247 at0248 at0250 at0251 at0267, plus the step-4 projection app-test.

**Checkpoint:**
- [x] All listed tests green in one batch (at0120's [Q03] resolution honored) — 29 files, 43 tests, in two batches plus the core tier.
- [x] `bunx tsc --noEmit`, tugdeck unit tests (4726), `bunx vite build`, `just app-test-covers-check` (234 files) all clean.
- [x] The single-classifier and gate-deletion greps from #success-criteria pass.

**Outcome: one pre-existing failure surfaced and repaired.** The core tier's `at0109-focus-ring` was red — red at `main` (`54feb467f`) and at every commit of this branch, verified by running it against a `main` checkout of `tugdeck/src`. Two things were wrong, neither an engine defect. A **fixture gap**: its click target, the gallery's keybinding-demo panel, carried `tabIndex={0}` and `data-responder-id` but was not a registered focusable and declared no focus contract, so the engine's pointer placement had nothing nameable to place. The panel is a focus destination, so it now declares itself one (`useFocusable` with `policy: "skip"` — pointer-addressable without joining the neighbouring FocusWalkDemo's deliberately-two-stop Tab cycle) and drops its `tabindex`, since an engine-routed stop never holds DOM focus. And a **mechanism assertion** ([P07]): the test required `activeElement` to be the key sink, but a bare `<body>` left by the browser's own mousedown default is equally legal (a standing legality class) and is what settles here — it now asserts that the keyboard is not on the control, with a clean tripwire. Core tier is 20/20.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A focus system with one pointer-gesture interpreter, one state-driven projection reconciled by the watchdog, and no DOM-vs-engine treaty code — the theft gate folded into an engine query, transient key-card churn harmless, and a test corpus that asserts engine invariants.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every #success-criteria bullet verified at #step-11.
- [ ] at0224 restored and green (or its named skips documented in inventory).
- [ ] `focus-theft-gate.ts` gone; `gesture-interpreter.ts` the only pointer classifier.
- [ ] Seam-1 unit test (transient key-card round trip) green.
- [ ] Doctrine describes the shipped system.

**Acceptance tests:**
- [ ] The #step-11 batch.
- [ ] `getFocusInvariantReport().violations === 0` across the batch; steal budgets flat.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Leaf act contracts replacing `deliverToEngineLeaf` ([Q01] — its own plan).
- [ ] at0240/at0243 scenario rewrites once Lens redesign v2 settles the grammar.
- [ ] Shrinking the chrome allowlist as the interpreter models more chrome gestures (Spec S03's one DOM input).
- [ ] A `@covers`-like discipline generalizing the selector-constants module (brief §4 cause 5's "worth considering").

| Checkpoint | Verification |
|------------|--------------|
| Harness trustworthy | Steps 1–3 checkpoints |
| One truth | Steps 4–5 checkpoints + seam-1 unit test |
| Gate folded | Step 6 checkpoint + grep |
| One interpreter | Steps 7–8 checkpoints + grep |
| Phase close | Step 11 batch + exit criteria |
