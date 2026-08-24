## Consolidate Close-Focus Restoration into the Engine {#phase-slug}

**Purpose:** Make the focus engine's mode stack the single authority for the focus state restored when an engine-trapped surface closes — collapsing the **three overlapping close-focus writers on the popover path** (engine `popFocusMode`, `useServicePopupBinding`, and the `restoreFocusComplete` override) into one logical-state restore (`popFocusMode`) plus one surface-teardown DOM writer, retiring `restoreFocusComplete`, and aligning the already-engine-based sheet and inline-dialog surfaces with the same split so no surface double-writes DOM focus.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-09 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Three commits (`21f49971`, `cbeabd6b`, `ea9c5280`) built correct focus + first-responder restoration for confirm-popovers and sheets. They work and are tested, but they left close-focus restoration on the **popover path** split across three writers that each capture-at-open and restore-at-close, selected by runtime branches:

1. **The engine mode stack** (`FocusContext.popFocusMode`) — restores the key-view state (id + ring) always, and the first responder (gated on `restoreFocus`). Runs in `useFocusTrap`'s cleanup.
2. **`useServicePopupBinding`** (`onCloseAutoFocus`) — restores DOM focus + first responder via `focusResponder(captured)`, *unless* it decided the engine owns close-focus at open (`keyViewIsKeyboard()`), *plus* the one genuinely unique concern: an **external-pointerdown predicate** ("the user clicked outside any popup → don't restore, let the clicked surface keep focus").
3. **The `restoreFocusComplete` override** in `tug-popover.tsx` — bypasses writer #2 entirely and calls `focusKeyView()` at Radix teardown.

These three are all on the **popover** (`tug-popover` is the only surface that consumes `useServicePopupBinding` *and* `useFocusTrap` *and* carries the `restoreFocusComplete` override). They agree today only because the captured values coincide and the bypasses line up. The cost: a redundant first-responder write, a latent `pointerdown`-listener leak if a `restoreFocusComplete` popover ever opens from a Radix trigger (the override skips the binding's only listener-removal path), and a double `focusKeyView` for `restoreFocusComplete` that relies on the second call overriding the first's body-yanked result.

The other engine-trap surfaces are **already engine-aligned** and are *not* part of the three-writer overlap — but they are mis-shaped in ways the same split corrects:

- **`tug-sheet`** uses the standalone `@radix-ui/react-focus-scope` (not a Radix `Content`), restoring DOM focus in its own `onUnmountAutoFocus` (`handleUnmountAutoFocus`) with a richer, surface-specific contract: relinquish stand-down, engine-owns→`focusKeyView`, and **mouse-opened→focus the trigger element**. It never used `useServicePopupBinding`. But because `useFocusTrap`'s cleanup *also* calls `focusKeyView` today, the sheet carries the same redundant double-`focusKeyView` the popover does.
- The **inline dialogs** (`dev-question-dialog`, `dev-permission-dialog`, `use-inline-dialog-scope`) render no Radix focus primitive at all — they are host-less and restore DOM focus solely through `popFocusMode`'s `focusKeyView`. They have nowhere to host a teardown hook and must keep that path.

The model the code is reaching for — "DOM focus, key view, and first responder are projections of one focus state, saved by `popFocusMode` and written to the DOM by exactly one teardown writer per surface" — is visible but unfinished. This phase finishes it: the popover gets a clean engine-owned restorer, `restoreFocusComplete` disappears, and the sheet and dialogs stop double-writing.

> **Note (dropped sub-item):** an earlier draft also pane-scoped `aDismissableSurfaceIsOpen()` (the coarse global `[data-slot="tug-popover"]` probe in `responder-chain-provider.tsx`). That was cut from this phase during implementation — popovers `Popover.Portal` into a single global `tug-canvas-overlay-root`, so the "query within the active pane subtree" approach is unworkable (a same-pane popover lives outside `.tug-pane`). The cross-pane false positive it targeted is near-unreachable (a peer-pane popover auto-dismisses on cross-pane interaction), and the correct fix needs a different mechanism. It is recorded as a traced follow-on (#roadmap).

#### Strategy {#strategy}

- **Separate logical-state restore from the DOM-focus write.** `popFocusMode` owns logical state (key-view id + ring, first responder) — timing-insensitive, runs in `useFocusTrap` cleanup. The DOM-focus write happens once, at each surface's own teardown moment (Radix `Content.onCloseAutoFocus` for the popover; `FocusScope.onUnmountAutoFocus` for the sheet; `popFocusMode.focusKeyView` for host-less dialogs), where the focus trap is gone and focus won't be yanked to `<body>`.
- **`useFocusTrap` provides the standard teardown restorer + a deferral flag.** `useFocusTrap` returns an `onCloseAutoFocus` (the **popover's** restorer) and accepts `deferDomFocusToTeardown`: when set, its cleanup pops `moveDomFocus: false` (the surface's teardown writer owns the DOM write); when unset (host-less dialogs), it pops `moveDomFocus: true` (the engine moves DOM focus in `popFocusMode`, as today).
- **Consolidate the popover; align the sheet; leave the dialogs.** The three-writer overlap is the popover's — fix it. The sheet keeps its richer surface-owned teardown writer (its contract differs from the popover's: mouse→trigger, not mouse→prior-key-view) but sets the deferral flag to kill its double-`focusKeyView`. The host-less dialogs keep `popFocusMode.focusKeyView` ([R02]).
- **Refactor before behavior change.** First make `popFocusMode`'s options express the restore shapes as a no-op refactor; then move the popover onto the unified restorer; then retire `restoreFocusComplete`; then align sheet/dialogs — the focus app-test suite the falsifiable gate at every step.
- **Scope to the engine-trap family; menus stay on the binding.** Menus push no engine focus mode and restore *only* through `useServicePopupBinding`. Bringing them into the engine trap is a separate, larger effort; this phase leaves them on the binding (which is *retained*, not deleted) and merely removes the popover as its consumer.
- **Retire `restoreFocusComplete`.**

#### Success Criteria (Measurable) {#success-criteria}

- `tug-popover.tsx` no longer imports or calls `useServicePopupBinding`, and no longer references `restoreFocusComplete` (`grep` returns zero hits in that file). (verify: `grep`)
- The identifier `restoreFocusComplete` does not appear anywhere under `src/components/tugways` (`grep` returns zero hits). (verify: `grep`)
- **One DOM-focus writer per surface, at the surface's own teardown moment:** the popover's `useFocusTrap`-owned `onCloseAutoFocus`; the sheet's `handleUnmountAutoFocus`; the host-less dialogs' `popFocusMode.focusKeyView`. No surface calls `focusKeyView` from *both* `popFocusMode` cleanup and a teardown hook (the popover and sheet pop `moveDomFocus: false`). (verify: code read + the focus app-test suite)
- The full focus app-test suite stays green across every step: at0020, at0037, at0039, at0040, at0041, at0055, at0056, at0058, at0100, at0105, at0106, at0140, at0147, at0151, at0152. (verify: `just app-test`)
- `useServicePopupBinding` remains in use by the menu surfaces only (popup-button, context-menu, popup-menu) and is unreferenced by popover/sheet/dialog. (verify: `grep`)

#### Scope {#scope}

1. `popFocusMode` restore-option redesign: replace the single `restoreFocus` boolean with `{ moveDomFocus, restoreFirstResponder }`.
2. A `useFocusTrap`-owned `onCloseAutoFocus` (the popover's three-branch restorer) and a `deferDomFocusToTeardown` option controlling whether the trap's cleanup defers the DOM write.
3. Migrate **`tug-popover`** (and thereby `tug-confirm-popover`) onto the unified restorer; drop its `useServicePopupBinding` usage and the `restoreFocusComplete` override.
4. Retire the `restoreFocusComplete` flag end-to-end.
5. Align **`tug-sheet`** with the split (set `deferDomFocusToTeardown`, keep its own `handleUnmountAutoFocus`); confirm the **inline dialogs** stay host-less on `popFocusMode.focusKeyView` ([R02]).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Bringing menus into the engine trap.** `TugPopupButton`, `TugContextMenu`, and `tug-popup-menu` push no engine focus mode and restore close-focus solely through `useServicePopupBinding`. They keep it. A follow-up phase may unify them; this phase does not.
- **Replacing the sheet's surface-owned teardown writer with the provided hook.** The sheet's close-focus contract (mouse→trigger restore, relinquish stand-down) genuinely differs from the popover's (mouse→prior key view). It stays surface-owned and engine-aligned ([P07]); only its double-`focusKeyView` is removed.
- **Deleting `useServicePopupBinding`.** It survives as the menus-only restorer. Its external-pointerdown predicate logic is *copied* into the trap, not deleted from the binding.
- **Pane-scoping `aDismissableSurfaceIsOpen()`.** Dropped from this phase (popovers portal globally; see the Context note and #roadmap).
- **Changing what gets restored** (the user-visible behavior). This is a structural consolidation; the caret/ring/first-responder/trigger outcomes must be the same as today, proven by the unchanged app-test suite.
- **`tug-alert`** — uses neither the trap nor the binding today; out of scope.

#### Dependencies / Prerequisites {#dependencies}

- The three foundation commits are landed (`21f49971`, `cbeabd6b`, `ea9c5280`).
- The focus app-test suite is green on `main` at phase start (the regression baseline).

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** — the workspace enforces `-D warnings`; every step lands zero new lint/type findings.
- tugdeck HMR is live — no manual builds; app-tests run via `just app-test` (never a hand-rolled `TUGAPP_*` pipeline).
- Radix carries exactly one teardown-autofocus handler per focus primitive (`Content.onCloseAutoFocus` / `FocusScope.onUnmountAutoFocus`) — the surface's restorer must be the sole consumer of that slot (no stacking).
- The DOM-focus write must run at the surface's focus-primitive teardown for trapped surfaces; logical state may restore earlier in `useFocusTrap` cleanup.

#### Assumptions {#assumptions}

- The per-surface teardown shape is **known and recorded** in [T01] (the vet spike already enumerated it): popover = `Popover.Content.onCloseAutoFocus`; sheet = standalone `FocusScope.onUnmountAutoFocus` + its own three-branch logic; inline dialogs = host-less (no focus primitive), restoring via `popFocusMode.focusKeyView`. No surface is assumed to have a uniform `onCloseAutoFocus`.
- For a popover, a non-keyboard key view is seeded *equal* to the first responder (`seedKeyViewFromChain` writes `keyView = firstResponder`), so the unified hook's `focusKeyView(restoredKeyView)` lands on the same element the old `focusResponder(captured)` did — the equivalence that makes the migration behavior-preserving for the popover. This does **not** hold for the sheet's mouse-opened case (it restores the *trigger*, not the prior key view), which is exactly why the sheet keeps its own teardown writer ([P07]).
- The external-pointerdown predicate (canvas-overlay-root containment) is the only close-focus concern the engine cannot derive from its own state.
- Cycles (`use-cycle-mode`) call `popFocusMode` directly and are NOT `useFocusTrap` consumers; only their `popFocusMode` option call site changes ([P03]).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `References:` lines. Plan-local decisions are `[P01]`+; global laws are cited as `[L##]` and global decisions as `[D##]`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Per-surface teardown shape — which surfaces host a teardown DOM write? (DECIDED) {#q01-radix-host}

**Question:** Which in-scope engine-trap surfaces expose a focus-primitive teardown slot for the DOM-focus write, and which are host-less and must keep `popFocusMode.focusKeyView`?

**Why it matters:** A host-less surface popped `state-only` (DOM move deferred to a hook it does not have) would silently lose its caret restore. The split must know, per surface, whether to defer the DOM write.

**Resolution:** DECIDED — enumerated during vet and recorded in [T01]:
- `tug-popover` → `Popover.Content.onCloseAutoFocus` (Radix). Defers; uses the unified hook.
- `tug-sheet` → standalone `FocusScope.onUnmountAutoFocus` + its own three-branch `handleUnmountAutoFocus`. Defers; keeps its own writer ([P07]).
- `dev-question-dialog`, `dev-permission-dialog`, `use-inline-dialog-scope` → **host-less** (no Radix focus primitive). Do NOT defer; keep `popFocusMode.focusKeyView` ([R02]).

#### [Q02] Where does the external-pointerdown predicate live? (DECIDED) {#q02-predicate-home}

**Question:** The "user clicked outside any popup" predicate needs a document `pointerdown` listener installed while the surface is open plus a canvas-overlay-root containment test. Fold it into `useFocusTrap`, or keep it as a dedicated hook?

**Resolution:** DECIDED (see [P02]) — extract a thin internal predicate helper that `useFocusTrap` composes, so the menu path can reuse it in a future phase without a rewrite. The binding keeps its own copy until menus migrate ([P05]).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Popover close-focus regression | high | med | App-tests at0151/at0152/at0055/at0056/at0058/at0040/at0041 gate Step 3 | Any go red |
| Sheet trigger-restore / relinquish regression from the deferral change | high | low | Sheet keeps its own writer; only the trap's `focusKeyView` is suppressed; at0100/at0106 gate Step 5 | at0100/at0106 differ pre/post |
| A host-less dialog popped `state-only` loses DOM focus | high | low | Dialogs do NOT set `deferDomFocusToTeardown`; they keep `moveDomFocus: true` ([R02]) | Step 5 finds a dialog set to defer |
| Menus inadvertently broken | high | low | Binding logic untouched; only the popover stops using it | by-eye menu check |

**Risk R01: Popover close-focus regression** {#r01-regression}

- **Risk:** Re-routing the popover's close-focus through the unified hook changes which element ends up focused on close.
- **Mitigation:** The hook's non-external branch is `focusKeyView`, equal to the old `focusResponder(captured)` for the popover (see [#assumptions]); the full popover app-test set gates the popover migration.
- **Residual risk:** An exotic open/close ordering not under test could differ — by-eye smoke before phase close.

**Risk R02: Host-less surface popped state-only** {#r02-no-radix-host}

- **Risk:** Deferring the DOM write on a surface with no teardown writer drops the caret restore.
- **Mitigation:** `deferDomFocusToTeardown` is **opt-in**. Only the popover and sheet set it; the host-less dialogs leave it unset and keep `moveDomFocus: true` (engine moves DOM focus in `popFocusMode`, exactly as today) — they merely gain the unified first-responder restore from the option split.
- **Residual risk:** The dialogs keep the engine's `popFocusMode.focusKeyView` path — a second engine DOM-focus path, by design and isolated, documented in [T01].

---

### Design Decisions {#design-decisions}

#### [P01] The engine owns the focus state; one DOM writer per surface teardown (DECIDED) {#p01-sole-authority}

**Decision:** `popFocusMode` is the single authority for the *logical* focus state restored on close (key-view id + ring, first responder). The *DOM-focus write* happens exactly once per surface, at that surface's own teardown moment — the unified `useFocusTrap` hook for the popover, `handleUnmountAutoFocus` for the sheet, `popFocusMode.focusKeyView` for host-less dialogs. No surface routes close-focus through `useServicePopupBinding`, and no surface writes DOM focus from both `popFocusMode` cleanup and a teardown hook.

**Rationale:**
- Upholds [L23]: focus is user data; one logical restore + one DOM writer per surface is more robust than three writers that must agree.
- Removes the redundant first-responder write, the `restoreFocusComplete` double-`focusKeyView`, and the sheet's pre-existing double-`focusKeyView`.
- The engine already captures the key view and (since `ea9c5280`) the first responder at push — the binding's separately-captured first responder is redundant with it. For the popover, `focusKeyView(restoredKeyView)` and the old `focusResponder(captured)` land the same element (see [#assumptions]).

**Implications:**
- "One DOM writer" is **per surface**, not one global path: host-less dialogs keep `popFocusMode.focusKeyView`; this is intended ([R02]), not a violation of the decision.
- `useServicePopupBinding` loses its popover consumer; it remains the menus-only restorer ([P05]).

#### [P02] `useFocusTrap` provides the popover's teardown restorer + a deferral flag (DECIDED) {#p02-trap-owns-teardown}

**Decision:** `useFocusTrap` returns an `onCloseAutoFocus(event)` callback (the **popover's** restorer) and accepts a `deferDomFocusToTeardown?: boolean` option. The restorer is three-branch, in order:
1. **relinquish stand-down** — if the trap's `closeDisposition` is `"relinquish"`, `event.preventDefault()` and return (the engine's `relinquishFocusMode`, fired by the trap's pop, is the sole authority; the hook must not race it). Defensive for the popover today (it passes no `closeDisposition`), correct if one ever does.
2. **external-pointerdown defer** — if an external pointerdown was observed during open, return without `preventDefault` (let Radix / the clicked surface keep focus).
3. **restore** — else `event.preventDefault()` + `focusManager.focusKeyView()`, re-projecting the engine's already-restored key view.

When `deferDomFocusToTeardown` is set, the trap's cleanup pops `{ moveDomFocus: false }` (the teardown writer owns the DOM write); when unset, it pops `{ moveDomFocus: true }` (host-less surfaces — the engine moves DOM focus in `popFocusMode`). The external-pointerdown observation is a thin internal predicate helper (a document capture-phase `pointerdown` listener + canvas-overlay-root containment), installed while the trap is active and torn down on unmount.

**Rationale:**
- The teardown moment is the only correct time to write DOM focus for a Radix-trapped surface — the focus scope is gone, so focus won't be yanked to `<body>` (the reason `cbeabd6b` moved the engine restore there).
- The three branches are exactly the popover's needs; the sheet's *fourth* shape (mouse→trigger) is why the sheet keeps its own writer ([P07]).
- The deferral flag is opt-in so host-less dialogs keep their working `popFocusMode.focusKeyView` ([R02]).

**Implications:**
- `useFocusTrap`'s return type gains `onCloseAutoFocus: (event: Event) => void`; its options gain `deferDomFocusToTeardown?: boolean`.
- [L22]/[L06]: the predicate listener is structure-zone (a document observer in a layout effect); the focus write is appearance-zone DOM. No React state.

#### [P03] `popFocusMode` restore options become `{ moveDomFocus, restoreFirstResponder }` (DECIDED) {#p03-pop-options}

**Decision:** Replace `popFocusMode(scopeId, { restoreFocus? })` with `popFocusMode(scopeId, { moveDomFocus?, restoreFirstResponder? })`, both defaulting `true`. The key-view *state* restore (`setKeyView`) remains unconditional when popping the top. `moveDomFocus` gates `focusKeyView()`; `restoreFirstResponder` gates the first-responder restore. `relinquishFocusMode` keeps its first-responder restore unconditionally (no DOM-move gate today).

**Rationale:**
- Three restore shapes exist and the single `restoreFocus` boolean cannot express them: ascend / Escape-exit / cycle-keyboard-exit want `{ move: true, fr: true }`; a deferring surface wants `{ move: false, fr: true }` (DOM move deferred to its teardown writer); the cycle's pointer-exit wants `{ move: false, fr: false }` (the click owns both).
- Decoupling the two gates lets a deferring surface restore the first responder while deferring the DOM move — impossible with the current single flag (where `restoreFocus: false` also suppresses the FR restore).

**Implications:**
- Call sites: `ascend`/`escapeCurrentMode` → defaults; `use-cycle-mode` pointer-exit (`restoreFocus: false`) → `{ moveDomFocus: false, restoreFirstResponder: false }`; `useFocusTrap` cleanup → `{ moveDomFocus: false }` when `deferDomFocusToTeardown`, else `{ moveDomFocus: true }`.
- A mechanical, behavior-preserving rename in isolation (Step 1), verifiable by the unchanged test suite before any surface migrates.

#### [P04] `restoreFocusComplete` is retired (DECIDED) {#p04-retire-flag}

**Decision:** Delete the `restoreFocusComplete` disposition from `FocusModeEntry`, `pushFocusMode`, `useFocusTrap`, `tug-popover`, and `tug-confirm-popover`. The popover's unified hook ([P02]) always re-projects the engine's restored key view at teardown, so the "re-project even when ringless" case is subsumed.

**Rationale:**
- The flag existed only to make `popFocusMode` re-project a ringless key view for a surface that displaced DOM focus on open. With the surface's teardown writer always re-projecting (popover hook; sheet `handleUnmountAutoFocus`; dialogs `popFocusMode.focusKeyView` via `moveDomFocus: true`), every surface gets that uniformly.
- Fewer dispositions threaded through five files.

**Implications:**
- The key-view-state restore in `popFocusMode` drops the `restoreKeyViewKeyboard || restoreFocusComplete` term: state is restored whenever popping the top; the DOM move is gated solely by `moveDomFocus`.

#### [P05] Menus stay on `useServicePopupBinding` (DECIDED) {#p05-menus-scope}

**Decision:** `TugPopupButton`, `TugContextMenu`, and `tug-popup-menu` continue to use `useServicePopupBinding` unchanged. The binding is retained, not deleted.

**Rationale:**
- Menus push no engine focus mode, so the engine has nothing to restore for them; the binding's `focusResponder(captured)` + external-click path is their correct mechanism today.
- Bringing menus into the engine trap is a real effort (menu arrow-nav, type-ahead, roving) and a separate phase.

**Implications:**
- The binding's logic is untouched; only `tug-popover` stops importing it. The external-pointerdown predicate is *copied* into the trap's helper ([P02]); the binding keeps its own copy until menus migrate.

#### [P07] The sheet keeps its surface-owned teardown writer (DECIDED) {#p07-sheet-bespoke}

**Decision:** `tug-sheet` keeps its own `handleUnmountAutoFocus` (on the standalone `FocusScope.onUnmountAutoFocus`) — relinquish stand-down, engine-owns→`focusKeyView`, mouse→trigger restore — rather than adopting the popover's unified hook. It sets `deferDomFocusToTeardown` so `useFocusTrap`'s cleanup stops also calling `focusKeyView`, removing the sheet's pre-existing double-write. The dialogs do neither (host-less, [R02]).

**Rationale:**
- The sheet's close-focus contract differs materially from the popover's: a mouse-opened sheet restores the **trigger**, a mouse-opened popover restores the **prior key view**. Folding the sheet into the popover's three-branch hook would change that behavior (a regression) or balloon the hook into a four-branch surface-aware switch — worse than leaving the sheet's clear, surface-local writer in place.
- The sheet is already engine-aligned (it calls `focusKeyView` and defers to `relinquishFocusMode`); it was never one of the three overlapping writers. The only fix it needs is to stop double-writing, which the deferral flag delivers without touching its contract.

**Implications:**
- The sheet's `handleUnmountAutoFocus` stays; `useFocusTrap` cleanup pops `moveDomFocus: false` for it.
- A future phase may extract the shared engine-owns→`focusKeyView` core from the popover hook, the sheet writer, and the menu binding — noted as a follow-on, not done here.

---

### Specification {#specification}

#### Internal Architecture — close-focus after this phase {#internal-architecture}

**Popover — before (three writers) → after (one logical restore + one DOM writer):**

```
before:
  useFocusTrap cleanup → popFocusMode
        ├─ setKeyView(restore) / restoreFirstResponder (gated restoreFocus)
        └─ focusKeyView (gated keyboard||restoreFocusComplete)   ← DOM, Radix yanks it
  tug-popover onCloseAutoFocus
        └─ restoreFocusComplete ? focusKeyView()                 ← DOM writer A
           : useServicePopupBinding.onCloseAutoFocus             ← DOM writer B (+FR +predicate)

after:
  useFocusTrap cleanup → popFocusMode({ moveDomFocus:false })    ← logical state only (key view + FR)
  useFocusTrap.onCloseAutoFocus (wired to Popover.Content)
        ├─ closeDisposition==="relinquish" ? preventDefault+return (relinquishFocusMode owns it)
        ├─ externalPointerdown ? return (defer to Radix)
        └─ else preventDefault + focusKeyView()                  ← THE single DOM writer
```

**Sheet — before → after (double-write removed, contract unchanged):**

```
before:
  useFocusTrap cleanup → popFocusMode (focusKeyView fires)       ← redundant DOM write
  FocusScope.onUnmountAutoFocus → handleUnmountAutoFocus         ← relinquish / focusKeyView / trigger
after:
  useFocusTrap cleanup → popFocusMode({ moveDomFocus:false })    ← logical state only
  FocusScope.onUnmountAutoFocus → handleUnmountAutoFocus         ← THE single DOM writer (unchanged)
```

**Inline dialogs (host-less) — unchanged:** `popFocusMode.focusKeyView` (the trap pops `moveDomFocus: true`; no teardown hook). **Menus (out of scope) — unchanged:** `useServicePopupBinding.onCloseAutoFocus`.

#### Public API Surface (within tugways) {#api-surface}

- `FocusContext.popFocusMode(scopeId, { moveDomFocus?, restoreFirstResponder? })` (was `{ restoreFocus? }`); `FocusManager.popFocusMode(...)` delegate matched.
- `useFocusTrap(...)` return type gains `onCloseAutoFocus: (event: Event) => void`; options gain `deferDomFocusToTeardown?: boolean`.
- `FocusModeEntry.restoreFocusComplete` and all `restoreFocusComplete` opts: **removed**.
- `tug-sheet`'s `handleUnmountAutoFocus`: **unchanged** in behavior.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Key-view id + ring (restored on pop) | appearance (projection) / structure (id) | DOM attrs (`data-key-view*`) written by engine; id in mode-stack registry | [L06], [L24] |
| First responder (restored on pop) | structure | chain identity via `makeFirstResponder`, suppressed-seed | [L24], [L11] |
| External-pointerdown-observed flag | structure | `useRef` + document capture-phase listener in a layout effect | [L24], [L22] |
| Teardown DOM-focus write (`focusKeyView` / trigger `.focus()`) | appearance | DOM `.focus()` at the surface's focus-primitive teardown | [L06] |
| `deferDomFocusToTeardown` option | structure | prop/option threaded to the trap; gates the `popFocusMode` `moveDomFocus` at cleanup | [L24] |
| Mode-stack entry (`restoreKeyView`, `restoreFirstResponder`) | structure | in-memory stack, `useLayoutEffect` push/pop | [L03], [L24] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Pure-logic (`bun:test`)** | Pin `popFocusMode` option semantics (move vs no-move, FR vs no-FR) against `FocusManager` + `ResponderChainManager`; the containment predicate as a pure function | Steps 1–2 |
| **Real-app (`just app-test`)** | Prove user-visible restore outcomes unchanged through each migration; the sheet's trigger-restore unchanged | Every step's checkpoint |
| **Drift prevention** | The existing focus suite is the regression oracle — green unchanged | All steps |

#### What stays out of tests {#test-non-goals}

- **Mock-store / call-count tests** — banned; pure-logic tests exercise the real `FocusManager`/`ResponderChainManager` as data-in/data-out.
- **Fake-DOM / RTL render tests** — banned; DOM-dependent behavior goes to `app-test`.
- **Menu close-focus** — out of scope ([P05]); a by-eye smoke only.
- **Re-asserting unchanged outcomes with new tests** — the existing app-tests already encode the behavior contract; keep them green rather than duplicating. The one possible addition is a mouse-opened-sheet → trigger-restore app-test, *only if* at0100/at0106 are found not to cover it (Step 5).

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. tugdeck checkpoints run `./node_modules/.bin/tsc --noEmit` (from `tugdeck/`), `bun test src/components/tugways/__tests__/`, and the named `just app-test` files.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Split `popFocusMode` options (no behavior change) | done | e90987b9 |
| #step-2 | Add the unified `onCloseAutoFocus` + deferral flag to `useFocusTrap` | done | f20b0365 |
| #step-3 | Migrate `tug-popover`/`tug-confirm-popover` onto it | done | 285bab63 |
| #step-4 | Retire `restoreFocusComplete` | done | 9f4af624 |
| #step-5 | Align `tug-sheet` + confirm dialogs host-less | done | 08f62f4b |
| #step-6 | Integration checkpoint | done | verification only |

#### Step 1: Split `popFocusMode` options (no behavior change) {#step-1}

**Commit:** `Split popFocusMode restore into moveDomFocus + restoreFirstResponder`

**References:** [P03] (#p03-pop-options), (#api-surface)

**Artifacts:**
- `popFocusMode(scopeId, { moveDomFocus?, restoreFirstResponder? })` replacing `{ restoreFocus? }`, both defaulting true; `setKeyView` state restore stays unconditional.
- All call sites updated to preserve current behavior exactly.
- Pure-logic test for the option shapes.

**Tasks:**
- [ ] Rework `FocusContext.popFocusMode` + the `FocusManager` delegate; `moveDomFocus` gates `focusKeyView`, `restoreFirstResponder` gates the FR restore.
- [ ] Map call sites: `ascend`/`escapeCurrentMode` → defaults; `use-cycle-mode` pointer-exit (`restoreFocus: false`) → `{ moveDomFocus: false, restoreFirstResponder: false }`; `useFocusTrap` cleanup → defaults for now (the deferral lands in Step 2, keeping behavior identical here).
- [ ] Confirm `relinquishFocusMode`'s FR restore is unchanged.

**Tests:**
- [ ] Extend `focus-mode-first-responder.test.ts` (or a sibling): `{ moveDomFocus:false, restoreFirstResponder:true }` restores FR + key-view state but no DOM move; `{ ...:false, restoreFirstResponder:false }` restores neither.

**Checkpoint:**
- [ ] `./node_modules/.bin/tsc --noEmit` clean; `bun test src/components/tugways/__tests__/` → all pass
- [ ] `just app-test at0140-cycle-devcard at0151-confirm-popover-editor-restore at0152-confirm-popover-firstresponder-restore` → VERDICT: PASS (behavior unchanged)

---

#### Step 2: Add the unified `onCloseAutoFocus` + deferral flag to `useFocusTrap` {#step-2}

**Depends on:** #step-1

**Commit:** `Add engine-owned close-focus hook and deferral flag to useFocusTrap`

**References:** [P01] (#p01-sole-authority), [P02] (#p02-trap-owns-teardown), [Q02] (#q02-predicate-home), (#internal-architecture)

**Artifacts:**
- A thin internal external-dismiss predicate helper (document capture-phase `pointerdown` + canvas-overlay-root containment).
- `useFocusTrap` returns `onCloseAutoFocus(event)` implementing [P02]'s three branches (relinquish stand-down / external defer / `focusKeyView`).
- `useFocusTrap` accepts `deferDomFocusToTeardown?: boolean`; its cleanup pops `{ moveDomFocus: !deferDomFocusToTeardown }`.
- No surface sets the flag or wires the hook yet (added, not consumed) — keeps the step isolated and behavior unchanged.

**Tasks:**
- [ ] Extract the predicate helper (mirroring `useServicePopupBinding`'s listener + `useCanvasOverlay` containment) so menus can reuse it later ([P05]).
- [ ] Implement `onCloseAutoFocus`: relinquish (read the trap's `closeDisposition`) → `preventDefault`+return; external pointerdown → return; else `preventDefault` + `focusManager.focusKeyView()`.
- [ ] Add `deferDomFocusToTeardown`; cleanup pops `moveDomFocus: false` when set, else `true` (default — current behavior).
- [ ] Install/teardown the predicate listener in the trap's `useLayoutEffect` ([L03]); guard-cleanup on unmount.

**Tests:**
- [ ] Pure-logic: the containment predicate flips on an out-of-overlay node and not on an in-overlay one (pure function, no DOM render).

**Checkpoint:**
- [ ] `./node_modules/.bin/tsc --noEmit` clean; `bun test src/components/tugways/__tests__/` → all pass
- [ ] Suite unaffected (nothing consumes the new surface yet): `just app-test at0151-confirm-popover-editor-restore at0055-popup-close-restores-editor-focus at0100-sheet-pane-modal-focus` → VERDICT: PASS

---

#### Step 3: Migrate `tug-popover`/`tug-confirm-popover` onto the unified hook {#step-3}

**Depends on:** #step-2

**Commit:** `Route popover close-focus through the engine trap hook`

**References:** [P01] (#p01-sole-authority), [P02] (#p02-trap-owns-teardown), [P05] (#p05-menus-scope), Risk R01 (#r01-regression)

**Artifacts:**
- `tug-popover.tsx`: wire `useFocusTrap`'s `onCloseAutoFocus` to `Popover.Content`; pass `deferDomFocusToTeardown` to `useFocusTrap`; remove the `useServicePopupBinding` import/usage and the `restoreFocusComplete ? focusKeyView : ctx?.onCloseAutoFocus` branch.
- `tug-confirm-popover.tsx`: unchanged behavior (its `restoreFocusComplete` prop becomes a no-op here, removed in Step 4).

**Tasks:**
- [ ] Replace the popover `onCloseAutoFocus` wiring with the trap-provided hook (sole consumer of Radix's slot).
- [ ] Pass `deferDomFocusToTeardown: true` to `useFocusTrap` in `TugPopoverContentShell`.
- [ ] Drop `useServicePopupBinding` from `tug-popover` (the internal-context `onCloseAutoFocus` field and its plumbing).

**Tests:**
- [ ] No new tests — the existing suite is the contract.

**Checkpoint:**
- [ ] `./node_modules/.bin/tsc --noEmit` clean
- [ ] `just app-test at0151-confirm-popover-editor-restore at0152-confirm-popover-firstresponder-restore at0055-popup-close-restores-editor-focus at0056-popup-outside-click-skips-restore at0058-popup-in-sheet-close-focus at0040-multi-tab-close-confirm at0041-gallery-close-reopen` → VERDICT: PASS
- [ ] `grep -n "useServicePopupBinding" tugdeck/src/components/tugways/tug-popover.tsx` → no hits

---

#### Step 4: Retire `restoreFocusComplete` {#step-4}

**Depends on:** #step-3

**Commit:** `Retire restoreFocusComplete disposition`

**References:** [P04] (#p04-retire-flag), (#api-surface)

**Artifacts:**
- `restoreFocusComplete` removed from `FocusModeEntry`, `pushFocusMode`/`popFocusMode` opts, `FocusManager` delegate, `useFocusTrap`, `tug-popover` props/plumbing, `tug-confirm-popover` usage.
- `popFocusMode`'s key-view-state restore predicate simplified (state restored whenever popping the top; DOM move gated solely by `moveDomFocus`).

**Tasks:**
- [ ] Delete the flag and its threading across the five files.
- [ ] Simplify the `popFocusMode` restore condition (drop the `|| restoreFocusComplete` term).

**Tests:**
- [ ] No new tests — suite is the contract.

**Checkpoint:**
- [ ] `./node_modules/.bin/tsc --noEmit` clean; `bun test src/components/tugways/__tests__/` → all pass
- [ ] `grep -rn "restoreFocusComplete" tugdeck/src/components/tugways` → no hits
- [ ] `just app-test at0151-confirm-popover-editor-restore at0152-confirm-popover-firstresponder-restore` → VERDICT: PASS

---

#### Step 5: Align `tug-sheet`; confirm dialogs host-less {#step-5}

**Depends on:** #step-4

**Commit:** `Stop the sheet double-writing close-focus; leave dialogs on the engine`

**References:** [P07] (#p07-sheet-bespoke), [P03] (#p03-pop-options), Risk R02 (#r02-no-radix-host), Table T01 (#t01-consumer-map)

**Artifacts:**
- `tug-sheet.tsx`: pass `deferDomFocusToTeardown: true` to `useFocusTrap`; `handleUnmountAutoFocus` **unchanged** (still the sole DOM writer for the sheet). The sheet's pre-existing double-`focusKeyView` is gone (the trap's cleanup no longer moves DOM focus).
- The inline dialogs (`dev-question-dialog`, `dev-permission-dialog`, `use-inline-dialog-scope`): **no change** — they do NOT set `deferDomFocusToTeardown`, keeping `moveDomFocus: true` / `popFocusMode.focusKeyView` ([R02]). Add a one-line comment at each `useFocusTrap` call noting the host-less / [R02] disposition.

**Tasks:**
- [ ] `tug-sheet`: set `deferDomFocusToTeardown: true`; verify `handleUnmountAutoFocus` is now the only path that calls `focusKeyView` / focuses the trigger on close (no `popFocusMode.focusKeyView` double-write).
- [ ] Confirm the inline dialogs are unchanged and documented as host-less.
- [ ] Confirm the sheet suite covers the mouse→trigger-restore path; if it does not, add a targeted app-test asserting a mouse-opened sheet restores its trigger on close.

**Tests:**
- [ ] (If coverage gap found) one app-test pinning mouse-opened-sheet → trigger restore.

**Checkpoint:**
- [ ] `./node_modules/.bin/tsc --noEmit` clean
- [ ] `just app-test at0100-sheet-pane-modal-focus at0106-sheet-focus-trap at0147-question-nav-focus at0105-permission-cycle-keys at0020-overlay-focus-return at0037-deck-wide-restore-consistency at0039-title-bar-return-focus-restore` → VERDICT: PASS

---

#### Step 6: Integration checkpoint {#step-6}

**Depends on:** #step-3, #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [P01] (#p01-sole-authority), (#success-criteria)

**Tasks:**
- [ ] Verify the success-criteria greps pass (no `restoreFocusComplete`; `tug-popover` free of `useServicePopupBinding`; binding used only by menus).
- [ ] Code-read confirm: popover and sheet pop `moveDomFocus: false` and each has exactly one teardown DOM writer; dialogs keep `popFocusMode.focusKeyView`.
- [ ] By-eye smoke on the live HMR build: confirm-popover cancel (editor + list-stop openers), a sheet (keyboard- and mouse-opened), an inline dialog, and a menu (the out-of-scope path) all restore focus correctly.

**Tests:**
- [ ] Full focus app-test sweep.

**Checkpoint:**
- [ ] `./node_modules/.bin/tsc --noEmit` clean; `bun test src/components/tugways/__tests__/` → all pass
- [ ] `just app-test at0020-overlay-focus-return at0037-deck-wide-restore-consistency at0039-title-bar-return-focus-restore at0040-multi-tab-close-confirm at0041-gallery-close-reopen at0055-popup-close-restores-editor-focus at0056-popup-outside-click-skips-restore at0058-popup-in-sheet-close-focus at0100-sheet-pane-modal-focus at0105-permission-cycle-keys at0106-sheet-focus-trap at0140-cycle-devcard at0147-question-nav-focus at0151-confirm-popover-editor-restore at0152-confirm-popover-firstresponder-restore` → VERDICT: PASS
- [ ] `grep -rn "restoreFocusComplete" tugdeck/src/components/tugways` → no hits; `grep -rln "useServicePopupBinding" tugdeck/src/components/tugways` → only menu surfaces + the binding file

---

### Deep Dives {#deep-dives}

**Table T01: Engine-trap surface consumer map (enumerated during vet)** {#t01-consumer-map}

| Surface | Open mode | Focus primitive | Teardown DOM writer | Disposition |
|---------|-----------|-----------------|---------------------|-------------|
| `tug-popover` / `tug-confirm-popover` | controlled + imperative | Radix `Popover.Content` | `Content.onCloseAutoFocus` | migrate to unified hook; `deferDomFocusToTeardown: true` |
| `tug-sheet` | controlled + imperative (trigger ref) | standalone `FocusScope` (`createPortal`) | `FocusScope.onUnmountAutoFocus` → `handleUnmountAutoFocus` (relinquish / engineOwns→`focusKeyView` / mouse→trigger) | keep own writer ([P07]); `deferDomFocusToTeardown: true` |
| `dev-question-dialog` | inline (`active: isPending`) | none (host-less) | `popFocusMode.focusKeyView` | unchanged; `moveDomFocus: true` ([R02]) |
| `dev-permission-dialog` | inline (`active: isPending`) | none (host-less) | `popFocusMode.focusKeyView` | unchanged; `moveDomFocus: true` ([R02]) |
| `use-inline-dialog-scope` | inline | none (host-less) | `popFocusMode.focusKeyView` | unchanged; `moveDomFocus: true` ([R02]) |

> Menus (`TugPopupButton`, `TugContextMenu`, `tug-popup-menu`) are out of scope ([P05]): they push no engine mode and restore via `useServicePopupBinding.onCloseAutoFocus`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The popover's three overlapping close-focus writers collapse to one logical restore (`popFocusMode`) + one teardown DOM writer (the `useFocusTrap` hook); `restoreFocusComplete` is gone; the sheet stops double-writing while keeping its own teardown contract; the inline dialogs stay on the engine's `popFocusMode.focusKeyView`; `useServicePopupBinding` is menus-only.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] No `restoreFocusComplete` anywhere under `src/components/tugways` (grep)
- [ ] `tug-popover.tsx` free of `useServicePopupBinding` (grep)
- [ ] `useServicePopupBinding` referenced only by menu surfaces + its own file (grep)
- [ ] Popover and sheet each have exactly one teardown DOM writer and pop `moveDomFocus: false`; dialogs keep `popFocusMode.focusKeyView` (code read)
- [ ] Full focus app-test sweep green; pure tests green; tsc clean

**Acceptance tests:**
- [ ] The Step 6 full sweep passes
- [ ] at0152 still pins the first-responder restore; at0151 still pins the editor caret; at0100/at0106 still pin the sheet

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **Pane-scope `aDismissableSurfaceIsOpen()`** so a peer-pane popover can't suppress a cycle's Escape-exit. Dropped from this phase: popovers `Popover.Portal` into a single global `tug-canvas-overlay-root`, so the DOM-subtree approach is unworkable. The likely correct mechanism is a **key-card-open-trigger** scope — a Radix popover marks its trigger `data-state="open"`, and the cycle-relevant triggers (Z2 cells, Z4B chips) live inside the key card — so "does the key card contain an open popover trigger?" distinguishes a same-pane popover from a peer-pane one. Trace the portal, verify the triggers carry `data-state`, and add a multi-pane app-test before implementing.
- [ ] Bring menus (`TugPopupButton`, `TugContextMenu`, `tug-popup-menu`) into the engine trap and retire `useServicePopupBinding` entirely, reusing the predicate helper extracted in [#step-2].
- [ ] Extract the shared engine-owns→`focusKeyView` core from the popover hook, the sheet's `handleUnmountAutoFocus`, and the menu binding into one helper, once menus migrate.
- [ ] Add a dedicated app-test for the mouse-opened-sheet → trigger-restore-on-close path (the sheet's `handleUnmountAutoFocus` mouse branch). The existing sheet suite covers the keyboard/Escape close (at0106) but not the mouse→trigger restore; the consolidation left that path unchanged by construction, so it's a coverage gap, not a regression.
- [ ] Consider whether `tug-alert` (neither trap nor binding today) should adopt the same model.

| Checkpoint | Verification |
|------------|--------------|
| Popover is engine-only for close-focus | grep (no `restoreFocusComplete`, no binding in popover) + popover app-tests |
| Sheet no longer double-writes; contract unchanged | code read + at0100/at0106 (+ trigger-restore test if added) |
| No behavior regression | the unchanged at00xx focus suite stays green at every step |
