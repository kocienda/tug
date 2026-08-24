<!-- devise-skeleton v4 -->

> **SUPERSEDED.** This plan shipped the one-target/one-primitive model, but its keyboard story — DOM focus as the router, a DOM-focus-derived ring projection, and "every ringable stop must be DOM-focusable" — was inverted by [keyboard-as-engine-state.md](keyboard-as-engine-state.md): the engine's `FocusTarget` now routes keys directly, `document.activeElement` parks on a key sink for every non-text target (text surfaces alone are dom-granted), the settled-focus derivation was deleted in favor of a reasserting watchdog with an attributed steal ledger, and engine-routed stops render no `tabindex`. The durable contract lives in `tuglaws/focus-language.md` § One writer. This document is kept as the historical record of the by-construction phase.

## Focus by Construction {#focus-by-construction}

**Purpose:** Collapse tugdeck's seven hand-reconciled focus registers into one authoritative per-card focus target with a single write primitive, so the focus ring and the keyboard event flow are the same projection of the same value — making "the ring paints on the Lens but keystrokes go to the prompt" structurally unrepresentable.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via dash worktree) |
| Last updated | 2026-07-19 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

`dash/focus-system-state.md` is the current-state audit this plan redesigns against. Summary: "where is the keyboard" is answered by seven registers across three systems — (1) the responder chain's first responder (`ResponderChainManager.firstResponderId`, action routing), (2) the browser's `document.activeElement` (the only register the OS honors), (3) the visual key view / ring (`FocusContext.keyViewId` + `keyViewKeyboard`, projected as `data-key-view` / `data-key-view-kbd`), (4) the key card (`FocusManager.keyCardId`), (5) the per-card scope/mode stack, (6) the item-group cursor (`TugListView` `cursorIndexRef` → `data-key-cursor`), (7) the persisted focus bag (`bag.focus` in tugbank). They are kept consistent by seven-plus hand-written reconciliation calls (`reconcileFirstResponder`, `applyBagFocus`, `armKeyboardRestore`, `seedKeyViewFromChain`, engine hooks, pointer/focusin promotion, cursor seeding), each a missable step.

The recurring bug class (the relaunch keyboard-dead bug, task #51/#57, is the canonical case) is always the same shape: register #3 (the ring) and register #2 (DOM focus) are written by different code on different schedules. Concretely: `applyBagFocus` (`tugdeck/src/focus-transfer.ts`) calls `el.focus()` and then *separately* calls `setKeyView(focusableId, true)` — two writes; the Session card's engine hook later steals DOM focus at boot, and the `responderInActiveUniverse` guard in `FocusManager.seedKeyViewFromChain` then *defends the stale ring* against the foreign `focusin` instead of noticing the theft. The ring is a promise with nothing behind it. Five speculative patches failed because each guarded one drift path while the architecture permits infinitely many.

#### Strategy {#strategy}

- **Two invariants, enforced by structure, not by convention:** (A) exactly one primitive places focus and performs all side effects atomically; (B) the ring is *derived* from `document.activeElement` + a modality latch, never stored as an independent writable register.
- **Tripwire first.** Before changing behavior, ship a dev-mode invariant checker that loudly logs any ring/DOM-focus disagreement, plus an app-test that reproduces the boot drift and pins its detectability. Every later step is validated against a live alarm, not guesswork.
- **Refactor under the tests.** The pinned focus suite (at0148, at0201, at0202, at0203, at0204, at0240–at0243, at0245) stays green after every step; each step is behavior-preserving except the two that *remove* bug classes.
- **Claims are recorded, not raced.** A focus claim from a non-key card is not dropped and not honored immediately — it is recorded as that card's context target and projected on activation. This subsumes the [P20] pushed-destination rule and kills the boot race.
- **Delete, don't guard.** The end state removes `suppressChainSeed`, `pointerPromotionActive`, `seedKeyViewFromChain`, `reconcileFirstResponder`, `armKeyboardRestore`'s pending set, and the post-focus `setKeyView` fixup — the entire hand-sync table, not new flags beside it.
- **No lint gate, ever.** Per explicit owner guidance: linters are stupid mechanical checkers and must never block correct code. Enforcement of the single-writer rule is the runtime tripwire, the app-tests, and a documented review convention — never a build-failing lint rule.

#### Success Criteria (Measurable) {#success-criteria}

- Cold-boot restore with a Session-card stand-in present and the Lens holding the saved keyboard target ends with `document.activeElement` inside the `[data-key-view-kbd]` element, and ArrowDown moves `data-key-cursor` (the new boot app-test asserts both; today this fails).
- The dev-mode invariant checker reports zero ring/DOM-focus disagreements across the full focus app-test suite (checked by the integration step).
- `FocusManager.seedKeyViewFromChain`, `suppressChainSeed`, `pointerPromotionActive`, `reconcileFirstResponder`, and `FocusContext.pendingKeyboardRestore` no longer exist in the codebase (grep returns nothing).
- The existing pinned suite — at0148, at0201, at0202, at0203, at0204, at0240, at0241, at0242, at0243, at0245 — passes (`just app-test`, `VERDICT: PASS`).
- `bunx vite build` succeeds and `node_modules/.bin/tsc --noEmit` is clean at every step boundary.

#### Scope {#scope}

1. A `FocusTarget` descriptor type and one `place()` primitive on the focus engine that atomically records the target, moves DOM focus, promotes the chain first responder, and latches modality.
2. Ring/key-view projection derived from `focusin`/`focusout` + the modality latch; `keyViewId` becomes a cache of the derivation.
3. Key-card authority: side effects only for the key card; background claims record a context target projected on activation.
4. Restore unification: `bag.focus` becomes the serialized `FocusTarget`; late-mount completion via a declarative per-context `pendingTarget`.
5. A dev-mode invariant tripwire, a boot-drift app-test, and migration of every existing writer call site.
6. Tuglaws documentation updates (`focus-language.md`, `responder-chain.md`) and supersession notes in `dash/focus-system-state.md`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Moving the item-group cursor into the target descriptor — the cursor stays a component-owned sub-axis (see [P08]).
- Changing action routing semantics — the responder chain walk, `sendToTarget`, dispatch shapes, and `ActionEvent` are untouched.
- Any lint rule, ESLint plugin, or build-failing source audit for focus calls ([P09]).
- The Lens grows-tall scroll design spike (task #65) — separate work.
- Changing which elements are focusable, tab order, spatial order, or any visual treatment of the ring/tint (CSS untouched except where an attribute name would change — none do).

#### Dependencies / Prerequisites {#dependencies}

- `dash/focus-system-state.md` — the audit; read it first.
- `tuglaws/focus-language.md` and `tuglaws/responder-chain.md` — the intended model; this plan implements it more strictly than the current code does.
- App-test harness (`tests/app-test/_harness`) with `seedDeckState`, `evalJS`, `waitForCondition`; runs via `just app-test <file>`.

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** (repo-wide build policy); zero new tsc/lint findings, but per [P09] no *new* lint gates are added.
- Typecheck with `node_modules/.bin/tsc --noEmit` (NOT `bunx tsc` — it resolves a different tsc).
- Verify bundling with `bunx vite build` before declaring tugdeck work done (dev esbuild passes things the production rollup rejects).
- Real app-tests only (`just app-test`); no fake-DOM/RTL tests, no mock-store assertion tests (banned).
- No `localStorage`/`sessionStorage`/IndexedDB; persistence rides the existing `bag.focus` tugbank path.
- Tuglaws: [L02] external state via `useSyncExternalStore` only, [L03] `useLayoutEffect` registration, [L06] appearance via CSS+DOM never React state, [L22] engine state is structure zone.

#### Assumptions {#assumptions}

- Every ringable stop is (or can be made) DOM-focusable — `TugListView` cells already render `tabIndex={0}` in focus-engine lists; Tab-walk stops are buttons/inputs or carry tabindex. Step 3 verifies and fixes any stop that is not.
- Existing persisted `bag.focus` values (shapes `{kind:"dom",focusKey,keyboard}` / `{kind:"form-control",componentStatePreservationKey}` / `{kind:"engine"}` / `{kind:"none"}`) must keep restoring — the new serialization is a strict mapping of the old shapes ([P03]), so no tugbank migration is needed.
- The modal-barrier mousedown `preventDefault` (scrim/title-bar clicks never move DOM focus) keeps holding, which is what lets the derived ring survive stray clicks without the `currentFocusModeTrapped` pointer-yield heuristic.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v4 conventions: explicit `{#anchor}` on every cited heading, `[P##]` for plan-local decisions, `[Q##]` questions, `S##` specs, `T##` tables, `R##` risks, `**Depends on:**` lines with `#step-N` anchors, and no line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Can the chain first responder be eliminated as a register? (DECIDED) {#q01-chain-fr-register}

**Question:** Should the responder chain's `firstResponderId` become a pure derivation of the focus target, eliminating register #1?

**Why it matters:** If they can be one value, the reconcile problem vanishes entirely; if not, we must define who writes it and when.

**Resolution:** DECIDED (see [P07]). The FR stays a distinct register — action routing needs responder granularity (a focusable-only list stop is not a responder; the FR must sit on the nearest registered responder, which the walk then climbs). But it loses all its independent writers: it is promoted only inside `place()` and by genuine user-driven `focusin`/`pointerdown` promotion (which under the derived model are the same event that moves the ring, so the two can no longer diverge).

#### [Q02] Does the item-group cursor join the descriptor? (DECIDED) {#q02-cursor-in-descriptor}

**Resolution:** DECIDED (see [P08]). No — the cursor stays component-owned (`TugListView` `cursorIndexRef`). The roving-focusable mechanism already ties the ring to the element that holds DOM focus (`useRovingFocusable.setRovedElement` moves `data-tug-focusable` onto the roved cell), so the derived projection lands on the roved member naturally. Migrating the cursor into the descriptor is a follow-on, not required for the invariants.

#### [Q03] What happens to `ringFollowsPointer` and accessibility mode? (DECIDED) {#q03-ring-modality-policies}

**Resolution:** DECIDED. Both are pure projection policies and survive unchanged: `ringFollowsPointer` makes the projection stamp `data-key-view-kbd` even when the latch says pointer (same logic as today's `syncKeyViewDomAttribute`); `KeyboardAccessMode` keeps gating the walk. Neither adds a writer.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Derived projection regresses a pinned focus behavior | high | med | Tripwire logs both elements on every disagreement; full focus suite runs at each step checkpoint | any pinned test fails |
| Modality latch misclassifies programmatic focus | med | med | `place()` sets modality explicitly; the latch is consulted only for native (non-`place`) focus events | ring flickers on restore |
| Authority gate starves a legitimate background claim | med | low | Claims are recorded, never dropped ([P05]); activation projects the recorded target | a dialog in a background card loses its seed |
| CM6 focus contract bypasses the projection | med | low | Substrate `view.focus()` inside a registered `focus` contract is *invoked by* `place()`; the resulting `focusin` drives the projection like any other | prompt caret lands without ring update |

**Risk R01: A stop that rings but cannot hold DOM focus** {#r01-unfocusable-stop}

- **Risk:** Some focusable registered into the walk has no tabindex and no focusable descendant; under the derived model it can never wear the ring (today it can — a lie by definition).
- **Mitigation:** The Step 3 sweep queries every registered focusable during the app-test suite and the tripwire reports any `place()` resolve that fails to move `activeElement`; fix each stop by adding `tabIndex={-1}` (programmatic-only focus) at the component.
- **Residual risk:** A stop only mounted in rare states could escape the sweep; the tripwire remains on permanently in dev builds, so it surfaces in normal use.

**Risk R02: WebKit mousedown focus default fights the latch** {#r02-webkit-mousedown}

- **Risk:** WebKit's mousedown default focuses a tabindex'd ancestor (or clears to body) *after* pointerdown-time claims — a known gotcha (see `reference_mousedown_focus_default` finding: activation clicks preventDefault it; read-only lists render no tabindex).
- **Mitigation:** Nothing changes about who calls `preventDefault`; the derived projection simply reflects wherever focus truly lands, so the failure downgrades from "ring lies" to "ring visibly moved", which the tests catch honestly.
- **Residual risk:** A surface that forgot its preventDefault shows a ring hop on click — visible, diagnosable, not a dead keyboard.

---

### Design Decisions {#design-decisions}

#### [P01] One write primitive: `FocusManager.place()` (DECIDED) {#p01-single-writer}

**Decision:** Exactly one method places focus. `place(cardId, target, opts)` records the target in the card's `FocusContext`, and — iff that card is the key card — resolves it to an element, moves DOM focus (responder `focus` contract first, DOM-walk fallback second, both `preventScroll`), promotes the chain first responder to the resolved responder, and sets the modality latch. All existing paired call sites (`setKeyView` + `focusKeyView`, `focusNext()` + `focusKeyView()`, `armKeyboardRestore`, engine-hook invocations, `applyBagFocus`'s framework branch) route through it.

**Rationale:**
- Today's bug class exists because there are two primitives (`setKeyView` paints without focusing; `.focus()` focuses without painting) and callers are trusted to pair them; a single atomic pass has no gap for drift.
- The re-entrancy flags (`suppressChainSeed`, `pointerPromotionActive`) exist solely to referee the feedback loop between the two writers; with one writer there is no loop to referee.

**Implications:**
- `FocusContext.setKeyView` and `focusKeyView` become internal to the engine (still exist as mechanisms `place()` uses, no longer public API for components).
- Component code never calls `.focus()` on engine-managed stops; substrates keep their `focus` contract callbacks (invoked *by* the engine).
- `makeFirstResponder` remains for the chain's own unregister-promotion and the documented `card-lifecycle` path, but component-level calls migrate (see #writer-inventory).

#### [P02] The ring is derived from DOM focus (DECIDED) {#p02-derived-ring}

**Decision:** `data-key-view` / `data-key-view-kbd` are projected by a single document-level capture `focusin`/`focusout` listener pair owned by the engine: on every settled focus change, resolve the innermost ancestor-or-self of `activeElement` carrying `[data-tug-focusable]` or `[data-responder-id]` (the dual-selector convention `keyViewElement()` already uses — key views can be responder ids; see Spec S03), stamp `data-key-view` there, and stamp `data-key-view-kbd` iff the modality latch says keyboard (or `ringFollowsPointer` is on). `FocusContext.keyViewId` remains as a cache of this derivation for the walk/spatial logic, but nothing can set it to an element that does not contain DOM focus.

**Rationale:**
- `document.activeElement` is the only register the OS honors; deriving the visible promise from it makes a false promise unrepresentable.
- The item-group case is already compatible: list cells hold real DOM focus (`tabIndex={0}`) and `useRovingFocusable` moves `data-tug-focusable` onto the roved cell, so the derivation lands on the right member.

**Implications:**
- `seedKeyViewFromChain`, `responderInActiveUniverse`, `keyViewIsFinerThan`, `suppressChainSeed`, and `pointerPromotionActive` are deleted — the focusin reflection *is* the projection now.
- A focus theft becomes visible (ring moves) instead of silent (ring lies) — and [P05] makes the theft itself illegal.
- Every ringable stop must be DOM-focusable (Risk R01); this physical requirement is added to `tuglaws/focus-language.md`.

#### [P03] `FocusTarget` — one serializable descriptor (DECIDED) {#p03-focus-target}

**Decision:** The unified value is:

```ts
export type FocusTarget =
  | { kind: "focusable"; focusKey: string }      // stable "group:order" of a useFocusable stop
  | { kind: "responder"; responderId: string }   // a registered responder (editors, substrates)
  | { kind: "engine" }                            // the card's engine-owned surface (em cards)
  | { kind: "none" };
```

Each `FocusContext` holds `target: FocusTarget` (plus its existing mode stack, which pushes/pops targets exactly as it pushes/pops key views today). The persisted `bag.focus` maps 1:1: old `{kind:"dom",focusKey,keyboard}` → `focusable` + modality; `{kind:"form-control",componentStatePreservationKey}` → `focusable` resolved via `data-tug-state-key`; `{kind:"engine"}` → `engine`; `{kind:"none"}` → `none`. Old persisted bags keep loading without migration.

**Rationale:**
- Restore, activation, tab-switch, cmd-tab return, and drag-restore become the identical operation: `place(cardId, deserializedTarget)`.
- The descriptor is the union of today's registers #1/#3/#7 in one shape (per [Q02], the cursor #6 stays out).

**Implications:**
- `resolveBagFocus`'s six-variant union (`focus-transfer.ts`) collapses: `framework`/`engine`/`default-focus` become resolve outcomes inside `place()`; `deferred-*` becomes the `pendingTarget` rule ([P06]).
- `captureFocus` (`card-host.tsx`) keeps producing the old `FocusSnapshot` shape on save (no persistence format change this phase); the restore side reads it into a `FocusTarget`.

#### [P04] Engine-owned modality latch (DECIDED) {#p04-modality-latch}

**Decision:** A tiny input-source latch in the focus engine: capture-phase `pointerdown` sets `lastInput = "pointer"`, capture-phase `keydown` (real keys, not modifier-only) sets `lastInput = "keyboard"`. The projection reads it for native focus changes; `place()` overrides it explicitly per call (Tab walk → keyboard, bag restore → the saved modality, pointer promotion → pointer).

**Rationale:**
- This is the mechanism behind `:focus-visible`, engine-owned because programmatic restores must be able to assert keyboard (the ring re-lights on relaunch — `:focus-visible` cannot express that, which is why the engine never used it).

**Implications:**
- `setKeyView`'s `keyboard` boolean parameter becomes the latch value at projection time; the `keyboard=false` "downgrade on chain reflection" behavior falls out (a pointer click latches pointer, the projection omits `-kbd`).

#### [P05] Authority: record always, project only for the key card (DECIDED) {#p05-authority}

**Decision:** `place(cardId, ...)` always records the target in `contextFor(cardId)`. It performs DOM/chain side effects only when `cardId` is the key card (or the call is the activation itself, which sets the key card first). A non-key-card claim is thus never dropped and never a theft: it updates that card's destination, projected when the card activates.

**Rationale:**
- This is the boot-race kill: the Session card's engine hook firing at mount while the Lens is the key card records the Session card's target and does *not* move DOM focus off the Lens.
- It generalizes [P20] (pushed key destination) — a background card's dialog seed is just a recorded target.

**Implications:**
- `invokeEnginePaintMirrorAsActive` is invoked *by* `place()`'s resolve step for `kind:"engine"` targets, never as a freestanding claim; the engine hook's internal `view.focus()` runs only on the key-card path.
- `FocusManager.reconcileFirstResponder` is deleted; its job (settle FR at activation) is the chain-promotion half of the activation `place()`.
- Dev-mode: a suppressed background side effect logs one `tugDevLogStore.debug` line (who claimed, while which card was key) — diagnosis, not enforcement.

#### [P06] `pendingTarget` replaces `armKeyboardRestore` (DECIDED) {#p06-pending-target}

**Decision:** When `place()` cannot resolve its target to a mounted element, the recorded `target` simply *stays* the context's target and the context marks it unrealized; `registerFocusable` (and responder registration) checks whether the newly-registered record satisfies the context's unrealized target and, if so, re-runs `place()` for it. `FocusContext.pendingKeyboardRestore`, `armKeyboardRestore`, and the `deferred-dom` keyboard arm in `applyBagFocus` are deleted; `useSeedKeyView` becomes `place(cardId, {kind:"focusable", focusKey}, {modality:"keyboard"})`.

**Rationale:**
- "The target names an element not yet mounted; realize it when it mounts" is one declarative rule instead of a special-case pending set with an immediate-completion workaround (the current `armKeyboardRestore` head comment documents exactly that workaround).

**Implications:**
- All eleven `armKeyboardRestore` call sites (see #writer-inventory) migrate to `place()` with a one-line change each.
- The [P12] surface default-seed semantic (seed once at mount) is preserved by `useSeedKeyView` keeping its `seededRef` once-guard.

#### [P07] The chain FR keeps its register, loses its writers (DECIDED) {#p07-chain-fr}

**Decision:** Resolves [Q01]. `firstResponderId` remains the chain's register; its writers reduce to: (a) `place()`'s atomic pass, (b) user-driven pointerdown/focusin promotion (unchanged), (c) the chain's own unregister-promotes-ancestor repair (unchanged), (d) `CardLifecycle`'s documented activation promotion (unchanged, it already runs before `place()`-equivalent claims). Component-level `makeFirstResponder` calls migrate to `place()` or `focusResponder`.

#### [P08] The cursor stays component-owned (DECIDED) {#p08-cursor-component-owned}

**Decision:** Resolves [Q02]. `TugListView`'s `cursorIndexRef` / `data-key-cursor` and its key-view-gain seed effect are untouched. The list's arrow listener keeps gating on `data-key-view-kbd` on its scroll container — which under [P02] now *implies* DOM focus is inside the list, so a painted-but-dead list is impossible, which is the entire #57 symptom.

#### [P09] No lint gate — tripwire + tests + review convention (DECIDED) {#p09-no-lint-gate}

**Decision:** There will be no ESLint rule, no build-failing source audit, and no mechanical gate on `.focus()` / `setKeyView` / `makeFirstResponder` call sites. Enforcement is: (1) the permanent dev-mode invariant tripwire ([S02]) that makes any drift loud at runtime; (2) the app-test suite; (3) a short "who may place focus" section in `tuglaws/focus-language.md` that reviewers apply with judgment.

**Rationale:**
- Owner guidance, verbatim intent: linters can never, ever block the code from doing what is right; they are low-quality mechanical checkers and must not gate correctness.
- The tripwire is strictly stronger than a lint anyway: a lint sees call sites, the tripwire sees actual drift — including drift from paths no lint could model (WebKit defaults, Radix internals, browser focus restoration).

**Implications:**
- Substrate-internal `.focus()` calls (CM6 `view.focus()` inside registered focus contracts, drag-restore internals) remain legal and unannotated; the Step 6 sweep classifies by reading, not by tooling.

---

### Deep Dives {#deep-dives}

#### The boot race, precisely {#boot-race}

Cold boot with a saved Lens keyboard target and a Session card present: (1) `CardHost`'s RESTORE effect runs `applyBagFocus(lensCardId)` → `adoptKeyCard` sets the Lens as key card → framework branch focuses the Lens list cell, then `setKeyView(focusableId, true)` paints the ring. (2) The Session card's editor binds late; its engine hook (`paintMirrorAsActive` → `view.focus()`) fires via its own mount/`feedsReady` path. (3) That `focusin` promotes the prompt's responder; `seedKeyViewFromChain` sees a responder foreign to the Lens universe and *yields* (`responderInActiveUniverse` false), leaving the ring on the Lens while `activeElement` is `cm-content`. (4) Arrow keydowns target `cm-content`; the Lens list's capture listener on its scroll container never receives them. The ring lies; the keyboard is dead. Under this plan: step (2)'s claim routes through `place(sessionCardId, {kind:"engine"})`, the Session card is not the key card, so the claim records and does not focus ([P05]); had anything still moved DOM focus, the projection would move the ring with it ([P02]) and the tripwire would name both elements ([S02]).

#### Writer inventory — every call site to migrate {#writer-inventory}

**Table T01: `setKeyView` / `focusKeyView` / `refreshKeyViewProjection` pairs (route through `place()` or become engine-internal)** {#t01-keyview-writers}

| Site | Today | Becomes |
|------|-------|---------|
| `focus-transfer.ts` `applyBagFocus` framework branch (`el.focus()` then `setKeyView(id, true)`) | the two-write bug in miniature | one `place(cardId, target, {modality: saved})` |
| `responder-chain-provider.tsx` `focusWalkListener` (`focusNext/Previous` + `focusKeyView`) | pair | walk computes next stop; `place()` lands it (modality keyboard) |
| `tug-list-view.tsx` descend/act path (`setKeyView(innerId, true)` + `focusKeyView()`) | pair | `place()` |
| `tug-accordion.tsx` (same pair) | pair | `place()` |
| `use-cycle-mode.tsx` (`focusKeyView` twice) | half-pair | `place()` on the cycle's chosen stop |
| `use-focus-trap.tsx`, `tug-sheet.tsx` (`focusKeyView` on open/close) | half-pair | `place()` on the trap's captured/restored target |
| `use-focusable.tsx` `useRovingFocusable.setRovedElement` → `refreshKeyViewProjection` | **no current consumers** (the hook is defined but unused; `TugListView` registers via plain `useFocusable` with `data-tug-focusable` on its scroll container, which is why cell clicks derive upward correctly) | keep the hook's public API; its projection chase re-derives internally — no live call sites to migrate |
| `focus-manager.ts` `ascend` / `escapeCurrentMode` / `popFocusMode` restores | internal pairs | internal calls into `place()`'s core |

**Table T02: `armKeyboardRestore` call sites (become `place()` / `useSeedKeyView` unchanged-API)** {#t02-arm-restore-sites}

`use-focusable.tsx` (`useSeedKeyView`), `tug-confirm-popover.tsx`, `tug-alert.tsx`, `use-inline-dialog-scope.ts`, `gallery-theme-editor.tsx`, `session-question-dialog.tsx` (two sites), `tug-color-picker.tsx`, `session-card.tsx` (picker seeds, two sites), `lens-section-band.tsx`, `focus-transfer.ts` (the `deferred-dom` keyboard arm). Eleven sites; each is a one-line swap because `useSeedKeyView`'s public signature does not change.

**Table T03: component-level `makeFirstResponder` calls (audit per [P07])** {#t03-make-fr-sites}

| Site | Disposition |
|------|-------------|
| `lib/card-lifecycle.ts` (three sites) | keep — documented activation promotion, runs upstream of `place()` |
| `use-responder.tsx` (unregister repair) | keep — chain-internal |
| `responder-chain-provider.tsx` (promotion path) | keep — user-driven promotion |
| `tug-confirm-popover.tsx` | migrate to `place()`/`focusResponder` (it pairs a FR claim with a key-view expectation) |
| `body-kinds/terminal-block.tsx`, `cards/tug-attachment-preview.tsx` | migrate to `focusResponder` (they want FR + DOM focus together — the primitive that already exists for exactly this) |
| `test-surface.ts` | keep — test plumbing |

**Raw `.focus()` density (Step 6 sweep universe):** `tug-text-editor.tsx` (19), `focus-transfer.ts` (14), `tug-text-card-editor.tsx` (10), `session-card.tsx` (8), `state-preservation.ts` (7), `tug-prompt-entry.tsx` (6), plus single digits elsewhere. Most are substrate-internal (CM6 view management inside registered focus contracts) and stay; the sweep reads each and migrates only freestanding *claims* (a `.focus()` whose purpose is "put the keyboard here" rather than "manage my own editor internals").

#### What gets deleted {#deletions}

`FocusManager.seedKeyViewFromChain`, `FocusManager.responderInActiveUniverse`, `FocusManager.keyViewIsFinerThan`, `suppressChainSeed` + `beginSuppressChainSeed`/`endSuppressChainSeed`, `pointerPromotionActive` + `runPointerPromotion`, `FocusManager.reconcileFirstResponder`, `FocusContext.pendingKeyboardRestore` + `armKeyboardRestore`, the `applyBagFocus` post-focus `setKeyView` fixup, and `resolveBagFocus`'s `deferred-dom`/`deferred-engine` keyboard arming. The chain `attach`/`detach` subscription survives only if the projection still wants chain-notify as a re-derivation trigger (it should not — `focusin` is the trigger); delete if unused.

---

### Specification {#specification}

**Spec S01: `place()` semantics** {#s01-place-semantics}

```ts
interface PlaceOptions {
  modality?: "keyboard" | "pointer";  // default: current latch value
  preventScroll?: boolean;            // default true (D07: focus never auto-scrolls)
  activation?: boolean;               // true only from the activation channel; sets key card first
}
place(cardId: string | null, target: FocusTarget, opts?: PlaceOptions): "placed" | "recorded" | "unrealized"
```

Ordered pass: (1) `contextFor(cardId).target = target` (always). (2) If `opts.activation`, `setKeyCard(cardId)`. (3) If `cardId` is not the key card → return `"recorded"` (dev-log). (4) Resolve target to an element: `focusable` → registry lookup by focusKey → `data-tug-focusable` element; `responder` → chain `focus` contract via `focusResponder`; `engine` → `store.invokeEnginePaintMirrorAsActive`; `none` → blur-to-nothing is NOT performed (a `none` target leaves focus where activation logic put it). (5) Unresolvable (not mounted) → return `"unrealized"`; registration re-runs the pass ([P06]). (6) Set the modality latch to `opts.modality` **first**, then move DOM focus (contract first, DOM-walk fallback with `preventScroll`), then promote the chain FR to the resolved responder (registry containment rules unchanged from today's `reconcileFirstResponder` yield logic where a finer in-card FR exists). The latch-before-focus order is load-bearing: `el.focus()` fires `focusin` *synchronously*, and the projection reads the latch from inside that event — setting the latch after would project every programmatic keyboard placement with the stale modality. (7) The `focusin` this fires drives the projection ([P02]) — `place()` itself writes no ring attributes.

**Spec S02: the invariant tripwire** {#s02-tripwire}

Dev-mode only (gated on the same debug flag as deck-trace). After every projection pass, assert: if any element carries `data-key-view-kbd`, then `document.activeElement` is that element, inside it, or inside its registered focus surface (for responder targets, the responder's element). On violation: `tugDevLogStore.error("focus-invariant", ...)` naming both elements (via `formatElement`), the key card, and the current target. Never throws, never gates ([P09]). Stays in the codebase permanently.

**Spec S03: projection algorithm** {#s03-projection}

One capture-phase `focusin`/`focusout` listener pair installed by `ResponderChainProvider` alongside the existing promotion listeners.

**On `focusin` (synchronous):** (1) resolve the owning key view: the **innermost** ancestor-or-self of `activeElement` carrying `[data-tug-focusable]` **or** `[data-responder-id]` — the same dual-selector convention `keyViewElement()` and `elementForFocusKey()` already use. Both attributes are required because today's key view is frequently a *responder* id, not a focusable id (`seedKeyViewFromChain` writes the chain's first responder id straight into `keyViewId` — a pointer-focused editor is a responder with no focusable registration); deriving via `[data-tug-focusable]` alone would null the key view on every editor focus and break walk-resume and `keyViewCaptures`. Validate a focusable match against the active context's registry. (2) Update the context's derived `keyViewId` cache. (3) Run the existing `syncKeyViewDomAttribute` clear-then-stamp pass with `keyViewKeyboard = latch === "keyboard" || ringFollowsPointer`. (4) Run `syncDefaultRingDomAttribute` / `syncKeyWithinDomAttribute` downstream as today. (5) Run the tripwire ([S02]).

**On `focusout` (microtask-deferred, never synchronous):** queue a microtask that re-reads `document.activeElement` and re-runs the derivation only if focus has truly *settled* outside the current key-view element. This defer is load-bearing and has established precedent in `use-companion-popup-binding.ts` (its module header: when DOM focus moves between two siblings, `focusout` fires before `focusin`, and a synchronous `activeElement` read sees `<body>` — the transient state, not the destination). Acting synchronously on `focusout` would flicker the ring on every intra-card focus handoff. When focus has genuinely settled on body/nothing, clear `-kbd` but retain `data-key-view` (the key view survives blur; the ring requires focus). Note this settled-blur clearing is a deliberate, small behavior change from today (nothing clears on blur now) — pin it with the existing suite, and note that OS window blur is unaffected (`focusout` does not fire on window deactivation; `activeElement` is retained, which is what keeps at0148's blur→refocus behavior intact).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `FocusContext.target: FocusTarget` | structure | FocusManager (engine) field; consumers via `useSyncExternalStore` where React needs it | [L22], [L02] |
| modality latch (`lastInput`) | structure | engine module field, written by capture listeners | [L22], [L03] |
| `data-key-view` / `data-key-view-kbd` / `data-key-cursor` / `data-key-within` / `data-default-ring` | appearance | CSS reads engine-projected DOM attributes; never React state | [L06] |
| `pendingTarget` realization flag | structure | FocusContext field; realized in `registerFocusable` (layout effect) | [L22], [L03] |
| `bag.focus` (persisted) | structure | tugbank via existing card-state bag save/restore | [L23] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at0246-focus-boot-invariant.test.ts` | Boot-drift reproduction + (later) the honesty assertion |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `FocusTarget` | type | `tugdeck/src/components/tugways/focus-manager.ts` | [P03] |
| `FocusManager.place` | method | `focus-manager.ts` | [P01], Spec S01 |
| `FocusContext.target` | field | `focus-manager.ts` | replaces independent `keyViewId` authority (keyViewId stays as derivation cache) |
| modality latch + listeners | module state | `focus-manager.ts` / provider install | [P04] |
| projection focusin/focusout listeners | listeners | `responder-chain-provider.tsx` | Spec S03; installed beside existing promotion listeners |
| tripwire assert | function | `focus-manager.ts` | Spec S02, logs via `tugDevLogStore` |
| `resolveBagFocus` / `applyBagFocus` | modify | `tugdeck/src/focus-transfer.ts` | collapse to target-mapping + `place()` |
| deletions per #deletions | remove | `focus-manager.ts`, `focus-transfer.ts` | Step 3–5 |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/focus-language.md`: add "One writer: who may place focus" section (the `place()` contract, the every-ringable-stop-is-focusable requirement, the no-lint/review-convention stance per [P09]).
- [ ] `tuglaws/responder-chain.md`: update [P21] two-halves text — the framework half's `reconcileFirstResponder` is subsumed into the activation `place()`; the content half's engine hook is invoked only via `place()`.
- [ ] `dash/focus-system-state.md`: append a supersession note pointing here (keep the audit as the historical map).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test (real app)** | Focus, rings, keydown routing against the live WebKit app | the boot invariant, every pinned behavior |
| **Pure-logic `bun:test`** | `FocusTarget` mapping from legacy `bag.focus` shapes; walk/order logic already covered by existing engine tests | serialization mapping, resolve outcomes |
| **Drift Prevention** | The pinned suite at0148/at0201/at0202/at0203/at0204/at0240–at0243/at0245 re-run per step | every step checkpoint |

#### What stays out of tests {#test-non-goals}

- No fake-DOM/RTL tests, no mock-store assertion tests — banned repo-wide; focus behavior is app-test-only.
- No unit tests for the projection listener in isolation — it is meaningless without real browser focus semantics; the app-tests cover it at the real layer.
- The `"recorded"` background-claim path is asserted through the boot app-test's end state, not via a mock of `place()`.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Typecheck is `node_modules/.bin/tsc --noEmit` from `tugdeck/`; app-tests run as `just app-test tests/app-test/<file>` and pass iff the last line is `VERDICT: PASS`. The focus regression set for checkpoints below is: at0148, at0201, at0202, at0203, at0204, at0240, at0241, at0242, at0243, at0245.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Tripwire + boot-drift app-test | done | 0525a5c5c |
| #step-2 | The `place()` primitive + modality latch | done | d05b2315f |
| #step-3 | Derive the projection from DOM focus | done | d4c9f4977 |
| #step-4 | Key-card authority for every claim | done | 003684a5c |
| #step-5 | Unify restore on `FocusTarget` | done | a8ce001bb |
| #step-6 | Sweep stragglers + tuglaws docs | done | ab434c6d3 |
| #step-7 | Integration checkpoint | done | N/A (verification only) |

#### Step 1: Tripwire + boot-drift app-test {#step-1}

**Commit:** `Add focus-invariant tripwire and boot-drift app-test`

**References:** [P09] no lint gate, Spec S02, (#boot-race, #s02-tripwire, #success-criteria)

**Artifacts:**
- Tripwire assert in `focus-manager.ts` (log-only, dev-gated), run after `syncKeyViewDomAttribute` and on a capture `focusin` observer.
- `tests/app-test/at0246-focus-boot-invariant.test.ts`: seeds a deck (`seedDeckState`) with a fixed-id Lens pane (`"lens-card"`, `focusCardId`) holding a saved keyboard `bag.focus` on the snippets list, plus a `gallery-prompt-entry` card as the focus-claiming session stand-in; on boot, reads the tripwire's dev-log entries and the DOM via `evalJS`.

**Tasks:**
- [ ] Implement the [S02] assert; expose the violation count to tests via the existing dev-log store (no new window globals beyond what `evalJS` can reach through `tugDevLogStore`).
- [ ] Write at0246 asserting, at this step, that the boot scenario produces EITHER agreement (ring element contains `activeElement`) OR at least one logged focus-invariant violation naming both elements — i.e. the drift is *detectable*, pinning the tripwire against the live bug.

**Tests:**
- [ ] `just app-test tests/app-test/at0246-focus-boot-invariant.test.ts`

**Checkpoint:**
- [ ] `node_modules/.bin/tsc --noEmit` clean
- [ ] at0246 `VERDICT: PASS`; focus regression set `VERDICT: PASS`

---

#### Step 2: The `place()` primitive + modality latch {#step-2}

**Depends on:** #step-1

**Commit:** `Add FocusManager.place as the single focus-write primitive`

**References:** [P01] single writer, [P03] FocusTarget, [P04] modality latch, Spec S01, Table T01, (#s01-place-semantics)

**Artifacts:**
- `FocusTarget` type, `FocusContext.target`, `FocusManager.place()` per Spec S01, modality latch + its capture listeners.
- Engine-internal pairs routed through `place()`: the Tab walk (`focusWalkListener`), `ascend`/`escapeCurrentMode`/`popFocusMode` restores, `TugListView` and `TugAccordion` descend pairs, `use-cycle-mode`, `use-focus-trap`, `tug-sheet` (Table T01).

**Tasks:**
- [ ] Implement `place()` (behavior-identical at this step: the authority gate short-circuit exists but every current caller runs on the key card already).
- [ ] Migrate the Table T01 pair sites; `setKeyView`/`focusKeyView` stay public temporarily (Step 3/5 callers remain) but their component-level callers are gone after this step.

**Tests:**
- [ ] Pure-logic `bun:test` for `FocusTarget` mapping from all four legacy `bag.focus` shapes ([P03]).

**Checkpoint:**
- [ ] `node_modules/.bin/tsc --noEmit` clean; `bun test` green
- [ ] Focus regression set + at0246 `VERDICT: PASS` (behavior unchanged)

---

#### Step 3: Derive the projection from DOM focus {#step-3}

**Depends on:** #step-2

**Commit:** `Derive key-view projection from DOM focus; delete chain seeding`

**References:** [P02] derived ring, [P04] latch, [Q03], Spec S03, Risk R01, Risk R02, (#s03-projection, #deletions)

**Artifacts:**
- The focusin/focusout projection listeners (Spec S03); `keyViewId` demoted to derivation cache.
- Deleted: `seedKeyViewFromChain`, `responderInActiveUniverse`, `keyViewIsFinerThan`, `suppressChainSeed` pair, `pointerPromotionActive`/`runPointerPromotion`, and the chain `attach` subscription if nothing still consumes it.

**Tasks:**
- [ ] Implement Spec S03: synchronous `focusin` projection over the dual selector, microtask-deferred `focusout` settlement (per the `use-companion-popup-binding.ts` precedent), settled-blur clears `-kbd` while `data-key-view` survives.
- [ ] Sweep for unfocusable ringable stops (Risk R01): during the focus app-test runs, tripwire-log any `place()` resolve whose focus move failed; add `tabIndex={-1}` at each offending component.
- [ ] Verify the modal-barrier behaviors (at0203) hold without the trapped-mode pointer-yield heuristic — the mousedown `preventDefault` keeps DOM focus (and therefore the derived ring) on the dialog.

**Tests:**
- [ ] at0246 still passes (drift now impossible *to display*; the honesty assertion flips in #step-4 once the claim itself is gated).

**Checkpoint:**
- [ ] `node_modules/.bin/tsc --noEmit` clean
- [ ] Full focus regression set + at0246 `VERDICT: PASS`
- [ ] `bunx vite build` succeeds

---

#### Step 4: Key-card authority for every claim {#step-4}

**Depends on:** #step-3

**Commit:** `Gate focus claims on key-card authority; retire reconcileFirstResponder`

**References:** [P05] authority, [P07] chain FR, Table T03, (#boot-race, #p05-authority)

**Artifacts:**
- Engine hooks and lifecycle reclaims route through `place()` (the `engine` target kind); `invokeEnginePaintMirrorAsActive` has no callers outside `place()`.
- `reconcileFirstResponder` deleted; activation FR promotion is `place()`'s chain half, preserving the registry-containment yield rules verbatim.
- Table T03 migrations (`tug-confirm-popover`, `terminal-block`, `tug-attachment-preview` → `place()`/`focusResponder`).
- at0246 rewritten to the honesty assertion: after boot, `activeElement` is inside the `[data-key-view-kbd]` element, ArrowDown moves `data-key-cursor`, and the tripwire logged zero violations.

**Tasks:**
- [ ] Route `applyBagFocus`'s engine branch and `CardHost`'s `subscribeEngineHooksChange` retry through `place()`.
- [ ] Find every remaining direct engine-hook / lifecycle focus claim (`rg "invokeEnginePaintMirrorAsActive|paintMirrorAsActive"`) and gate it.
- [ ] Delete `reconcileFirstResponder`; fold its target-selection ladder (key view responder → default-focus responder → card container) into `place()`'s activation path.

**Tests:**
- [ ] at0246 honesty form — the plan's headline success criterion.

**Checkpoint:**
- [ ] `node_modules/.bin/tsc --noEmit` clean
- [ ] Full focus regression set + at0246 `VERDICT: PASS`

---

#### Step 5: Unify restore on `FocusTarget` {#step-5}

**Depends on:** #step-4

**Commit:** `Restore focus through place(); retire armKeyboardRestore`

**References:** [P03] FocusTarget, [P06] pendingTarget, Table T02, (#p06-pending-target, #deletions)

**Artifacts:**
- `resolveBagFocus` reduced to a pure `bag.focus → FocusTarget` mapping; `applyBagFocus` = authority-aware `place()` call (`transferFocusForActivation`, `transferFocusAfterMove`, `reactivateCurrentFocusDestination`, and `CardHost` cold-boot all unchanged at their call sites).
- `armKeyboardRestore` + `pendingKeyboardRestore` deleted; `registerFocusable` realizes an unrealized context target ([P06]); the eleven Table T02 sites migrated (`useSeedKeyView` keeps its public signature).

**Tasks:**
- [ ] Preserve the framework-branch idempotency guard (WebKit re-`focus()` during mount commits drops focus to body — the guard moves into `place()`'s focus move).
- [ ] Preserve `preventScroll` on the cmd-tab reactivation path.

**Tests:**
- [ ] Pure-logic mapping tests extended for the `none`/absent-bag → engine-vs-default-focus resolution (the content-owning + engine card rule).

**Checkpoint:**
- [ ] `node_modules/.bin/tsc --noEmit` clean; `bun test` green
- [ ] Full focus regression set + at0246 `VERDICT: PASS`

---

#### Step 6: Sweep stragglers + tuglaws docs {#step-6}

**Depends on:** #step-5

**Commit:** `Migrate stray focus claims; document the one-writer contract`

**References:** [P09] no lint gate, Table T03, (#writer-inventory, #documentation-plan)

**Artifacts:**
- Every freestanding `.focus()` *claim* in tugdeck migrated to `place()`/`focusResponder`; substrate-internal focus management (CM6 view internals, drag restore inside `state-preservation.ts`, selection plumbing) stays as-is, classified by reading each site (the #writer-inventory density list is the sweep universe).
- Tuglaws updates per #documentation-plan; supersession note in `dash/focus-system-state.md`.

**Tasks:**
- [ ] `rg "\.focus\(" tugdeck/src -g '*.ts' -g '*.tsx'` and disposition every hit in a short table in the commit body (kept / migrated / substrate-internal) — a reading audit, NOT a lint gate ([P09]).
- [ ] Confirm the #deletions grep list returns nothing.

**Tests:**
- [ ] No new tests; this step must not change behavior.

**Checkpoint:**
- [ ] `node_modules/.bin/tsc --noEmit` clean
- [ ] Full focus regression set + at0246 `VERDICT: PASS`

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Full app-test sweep (`just app-test`, no file arg); confirm zero tripwire violations across the sweep (read the dev-log count at the end of at0246 and spot-check others via `evalJS`).
- [ ] Manual relaunch pass in the debug app (`just app-debug`): relaunch with an open session card + Lens keyboard focus; arrows must move the Lens cursor immediately.

**Tests:**
- [ ] `just app-test` full sweep `VERDICT: PASS`

**Checkpoint:**
- [ ] `bunx vite build` succeeds
- [ ] `cd tugrust && cargo nextest run` (unchanged, but the sweep gate is repo policy)

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A focus system where the ring and the keyboard cannot disagree: one `place()` primitive, a DOM-focus-derived projection, key-card-gated claims, and a permanent runtime tripwire — with the seven-register hand-sync machinery deleted.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] at0246 honesty assertion passes: boot with a session card + saved Lens keyboard focus lands `activeElement` inside the ringed element and arrows work (app-test).
- [ ] The #deletions symbols are gone (grep) and no component-level `setKeyView`/`focusKeyView`/`armKeyboardRestore` callers remain (grep).
- [ ] Full `just app-test` sweep passes; `bunx vite build` and tsc clean.
- [ ] Tuglaws updated; no lint gate added anywhere ([P09] honored).

**Acceptance tests:**
- [ ] `tests/app-test/at0246-focus-boot-invariant.test.ts`
- [ ] The pinned focus regression set (at0148, at0201, at0202, at0203, at0204, at0240–at0243, at0245)

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Move the item-group cursor into `FocusTarget` (deferred by [P08]).
- [ ] Retire `data-key-view` survival-on-blur semantics if the derived model makes it vestigial.
- [ ] Task #65 design spike (Lens open-editor growth) — unblocked but independent.

| Checkpoint | Verification |
|------------|--------------|
| Boot honesty | at0246 `VERDICT: PASS` |
| No hand-sync machinery left | `rg "seedKeyViewFromChain|suppressChainSeed|pointerPromotionActive|reconcileFirstResponder|pendingKeyboardRestore" tugdeck/src` → empty |
| Suite green | `just app-test` → `VERDICT: PASS` |
| Ships in the bundle | `bunx vite build` succeeds |
