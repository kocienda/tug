## Engine-Owned Escape: the Mode Stack as Single Authority {#phase-slug}

**Purpose:** The focus engine's mode stack becomes the single authority for Escape across every dismissable surface. Radix's per-surface Escape is suppressed everywhere; every dismissable surface pushes an engine focus mode and registers a dismiss callback on it; the cycle-vs-surface decision is pure mode-stack ordering with zero DOM heuristics. `aDismissableSurfaceIsOpen()` and both its call sites are deleted, and `useServicePopupBinding` is retired entirely (menus join the engine trap).

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

Escape handling is currently a **two-system handshake decided by accident of event ordering**. When Escape fires over an open surface, the engine's keybinding stage consults a DOM probe (`aDismissableSurfaceIsOpen()` — a document-global `querySelector('[data-slot="tug-popover"]')`) to decide whether to yield; if it dispatches `CANCEL_DIALOG` and nothing handles it, Radix's `DismissableLayer` *happens* to catch the same keydown and close the surface. The decision of "what does this Escape do?" is split across the engine's guard, the chain walk's incidental reach, and Radix's per-surface listeners — and the probe that glues it together is pane-blind (a popover open in a peer pane suppresses a cycle's Escape-exit in the pane the user is in) and un-scopeable by DOM subtree (popovers `Popover.Portal` into one global `tug-canvas-overlay-root`; that global portal is load-bearing — it is what lets a popover exceed its card's bounds — and must not change).

The close-focus consolidation (commit `050bd54f`) already made every `TugPopover` push an engine trap mode onto its card's context, so the mode stack *already* knows "a popover is open over this cycle" for the popover family — the probe is likely vestigial for the case it was written for ([Q01]). What remains is to make the stack's knowledge **complete** (the alert, both Radix menus, and the hand-rolled editor context menu push no mode today) and the arbitration **explicit** (the engine decides; Radix never does).

The complete job: every dismissable surface pushes a mode and registers a dismiss callback at push; the engine's Escape handler walks one ladder — component-captured? top mode dismissable? descend scope? cycle? base cancel ladder — and Radix's Escape is suppressed at every surface. The probe dies, `useServicePopupBinding` dies (its close-focus capture/restore and external-click predicate are subsumed by the trap work already landed), and the implicit handshake becomes one arbiter.

#### Strategy {#strategy}

- **Everyone into the stack first, flip the arbiter once.** Pushing a trap is additive (no Escape behavior change while Radix still owns dismissal), so the alert, the Radix menus, and the editor context menu join the mode stack *before* the arbitration changes. The arbiter then flips in one step against a complete stack — no transitional "callback-or-yield" fork is ever the intended end state (a dev-warn guard remains as a tripwire, not a policy).
- **The decision is engine-owned everywhere; the close mechanism is per-surface.** Each surface registers `onEscapeDismiss` at `pushFocusMode`; the engine calls it and consumes the event. What the callback *does* is the surface's business: a controlled Radix flip (popover, alert, popup-menu), the existing `sendToTarget(CANCEL_DIALOG)` path (sheet, dialogs), or the synthesized-Escape trick with a re-entrancy flag (the uncontrolled Radix context menu).
- **Suppress Radix Escape at every surface** (`onEscapeKeyDown={e => e.preventDefault()}` on Radix contents; delete the sheet's and editor-context-menu's local Escape branches) so ordering between the engine's listener and Radix's can never matter again.
- **Menus join the trap exactly as the popover did** — push mode + `deferDomFocusToTeardown` + the trap's `onCloseAutoFocus` wired to the Radix menu `Content` — which subsumes everything `useServicePopupBinding` does and lets it be deleted. Radix keeps menu arrow-nav/typeahead untouched: menu items register no engine focusables, so the engine Tab walk no-ops in the menu's mode and falls through (the same coexistence the popover had pre-migration).
- **Pin behavior before touching mechanism.** The two-pane cycle/popover Escape test and a menu Escape-close-restore test land first, green against *current* behavior, and gate every later step alongside the full focus suite.
- **The portal is untouchable.** Nothing in this plan moves where any surface renders; popovers keep exceeding card bounds via the global overlay portal. Only *decision routing* changes.

#### Success Criteria (Measurable) {#success-criteria}

- `aDismissableSurfaceIsOpen` does not appear anywhere under `tugdeck/src` (`grep` zero hits) — the probe and both call sites are gone. (verify: `grep`)
- `use-service-popup-binding.ts` is deleted and `useServicePopupBinding` appears nowhere under `tugdeck/src` except historical docs. (verify: `grep` + `ls`)
- Every dismissable surface pushes an engine mode with a registered `onEscapeDismiss`: popover/confirm, sheet, alert, question/permission dialogs, popup-menu (and thereby popup-button), context-menu, editor-context-menu. (verify: code read against [T01])
- Radix Escape is suppressed on every Radix-backed surface (`onEscapeKeyDown` preventDefault on Popover/AlertDialog/DropdownMenu/ContextMenu contents, with the flagged-synthetic passthrough on the context menu) and the sheet's / editor-context-menu's local Escape branches are deleted. (verify: code read + `grep`)
- One Escape with a popover open over a cycle closes only the popover; the next Escape exits the cycle — in the same pane (at0140) AND with a popover open in a peer pane (new two-pane test). (verify: `just app-test`)
- The full focus/Escape app-test suite stays green at every step: at0020, at0037, at0039, at0040, at0041, at0055, at0056, at0058, at0100, at0105, at0106, at0140, at0147, at0151, at0152, plus the new tests from this plan. (verify: `just app-test`)
- Menu close-focus restoration (selection-close at0055, outside-click at0056, Escape-close new) is behaviorally unchanged after the binding's deletion. (verify: `just app-test`)

#### Scope {#scope}

1. Behavioral pins: two-pane cycle/popover Escape app-test; menu Escape-close focus-restore app-test.
2. Spike: confirm the probe is vestigial post-consolidation; characterize the live Escape flow per surface; record in [T01].
3. Engine arbitration: `onEscapeDismiss` on `FocusModeEntry`/`pushFocusMode`/`useFocusTrap`; one Escape ladder in the act dispatch; the keybinding stage's Escape guard simplified to "non-base mode → yield to the ladder".
4. Surface migration — dismiss callbacks + Radix suppression: popover/confirm (with the `DISMISS_POPOVER` re-emission moved into a shared close helper), sheet (Escape branch deleted; Cmd-. branch kept), question/permission dialogs, alert (joins the trap).
5. Menus into the trap: popup-menu (covers popup-button), context-menu (synthesized-Escape dismiss + re-entrancy flag), editor-context-menu (hand-rolled; local Escape branch deleted); `useServicePopupBinding` deleted.
6. Deletion: the probe, both call sites, and the `escapeExits`-guard special cases it served.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Moving any surface's portal or render location.** The global overlay portal — and popovers exceeding their card's bounds — is preserved exactly. This plan changes decision routing only.
- **Changing menu keyboard interior behavior.** Arrow-nav, typeahead, submenu navigation stay Radix-owned (or hand-rolled, for the editor context menu's item walk). Only Escape ownership and close-focus restoration change.
- **Changing Cmd-. semantics.** The force-dismiss chord stays chain-routed (`CANCEL_DIALOG` via the keybinding map and the surfaces' chain handlers); only Escape moves to the mode-stack ladder.
- **Replacing the sheet's or dialogs' close-focus writers.** The teardown-writer topology from the close-focus consolidation is unchanged; this plan only re-routes who *initiates* the close on Escape.
- **`tug-tooltip` / non-dismissable transients** — nothing with no Escape semantic.

#### Dependencies / Prerequisites {#dependencies}

- The close-focus consolidation is landed (`050bd54f`): popovers push traps, `deferDomFocusToTeardown` + the trap's `onCloseAutoFocus` exist, `external-dismiss-observer` is extracted.
- The focus app-test suite is green on `main` at phase start.

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** — zero new lint/type findings per step.
- tugdeck HMR is live; app-tests via `just app-test` only.
- The engine's document Escape listener must consume (preventDefault + stopImmediatePropagation) any Escape it arbitrates, so suppressed-Radix surfaces can never see a competing event; the context menu's synthesized Escape carries a marker field that both the engine listener and the suppressor recognize ([P03]).
- Callback identity must not churn the push/pop effect: `useFocusTrap` holds `onEscapeDismiss` in a ref and registers a stable wrapper, the same pattern `closeDisposition` uses ([L07]).

#### Assumptions {#assumptions}

- Every `data-slot="tug-popover"` producer is `TugPopover` (verified: no raw-Radix popover/menu imports outside the tugways wrappers), so "every popover pushes a trap" already holds.
- `tug-popup-menu` is controlled (`DropdownMenuPrimitive.Root open={open}`); `tug-alert` is controlled (`AlertDialog.Root open={open}`); `tug-context-menu` is uncontrolled by Radix design (no `open` prop) — its only close levers are Radix-internal (Escape/outside-click), hence the synthesized-Escape mechanism it already uses for `observeDispatch` dismissal ([P03]).
- Radix `DropdownMenu.Content`, `ContextMenu.Content`, and `AlertDialog.Content` all expose `onCloseAutoFocus` and `onEscapeKeyDown` (same DismissableLayer/FocusScope composition as `Popover.Content`).
- Menu items register no engine focusables, so a pushed menu trap leaves the engine Tab walk empty for that mode and native/Radix Tab behavior falls through unchanged (verified mechanism: `walkOrder()` over registered focusables only).
- The editor's own Escape captures (e.g. CodeMirror completion popup) ride `keyViewCaptures` and remain the ladder's first check — component-captured Escape never reaches the mode arbitration.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `References:` lines. Plan-local decisions are `[P01]`+; global laws are cited as `[L##]`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Is the probe already vestigial post-consolidation? (DECIDED) {#q01-probe-vestigial}

**Question:** The probe was added when the Z2 popover Escape collapsed the cycle beneath it — at a time when the cycle could be top-of-stack with a popover open. Since `050bd54f`, every popover pushes a trap onto the same card context as the cycle, so the cycle should never be top-of-stack while a popover is open. Does removing the probe today (before any other change) leave at0140 and the new two-pane test green?

**Why it matters:** If yes, the probe's deletion carries no behavior weight and the deletion step is pure cleanup gated by tests that already pass. If no, there is a residual ordering path the spike must characterize before the arbiter flips — the plan must not delete a guard whose protected case is still live.

**Plan to resolve:** Step 2 spike — temporarily remove the probe locally, run at0140 + the new two-pane test, restore, record the result in [T01]'s notes.

**Resolution:** DECIDED — **the probe is NOT vestigial today; it is load-bearing.** Neutralizing it (`aDismissableSurfaceIsOpen() → false`) makes at0140 (popover-over-cycle) and at0157 (same-pane) fail: the first Escape over a cycle-stop popover *exits the cycle* instead of only closing the popover. **Mechanism (measured by instrumenting both arbitration sites):** within ONE Escape keydown, the capture-phase Stage-1 guard sees the popover trap on top (`trapped, escapeExits:false`) and dispatches `CANCEL_DIALOG`, which closes the popover and **pops its trap synchronously**; the act-dispatch listener then runs *on the same event* and now sees the **cycle** on top (`escapeExits:true`). The probe (popover DOM still present) is the only thing stopping the act-dispatch from exiting the cycle on that same Escape. **Implication for the refactor:** the probe compensates for today's *two-listener* split + synchronous mid-event popover close. The single consuming ladder ([P02]) reads the top mode ONCE (popover trap → its `onEscapeDismiss`), acts, and `stopImmediatePropagation`s — so no second listener processes the same Escape and the cycle is never re-exposed mid-event. The probe is therefore safe to delete **only after** the single ladder lands and consumes (exactly the plan's Step 7 sequencing). The ladder's consume on branches 2/4/5 is load-bearing for this — not optional.

#### [Q02] What is the editor context menu's current close-focus mechanism? (DECIDED) {#q02-editor-menu-restore}

**Question:** `tug-editor-context-menu` is hand-rolled (no Radix, no `useServicePopupBinding` import) with its own Escape keydown branch. How does it restore focus to the editor on close today, and does it need the trap's teardown writer or is the editor's own focus reclamation sufficient when its trap pops `moveDomFocus: true`?

**Why it matters:** Determines whether its migration row is "host-less, engine restores in `popFocusMode`" (like the inline dialogs) or needs explicit wiring.

**Plan to resolve:** Step 2 spike — read its close path and the editor's reclaim; record the disposition in [T01].

**Resolution:** DECIDED — **the editor never loses focus, so there is nothing to restore.** `tug-editor-context-menu` is hand-rolled and uses **mousedown-preventDefault on its items so DOM focus stays on the editor for the entire menu lifecycle** (the chain action even targets the responder that *opened* the menu, captured at open). Its keyboard contract (Escape / ⌘. → close) rides a `window`-level capture-phase `keydown` listener; close is its `onClose` prop. **Migration disposition:** join the trap for **stack presence + Escape arbitration only** — push a trapped mode while open, register `onEscapeDismiss` = its existing `onClose`, delete the local Escape `keydown` branch (keep ⌘.). It needs **no** `deferDomFocusToTeardown` / teardown DOM writer (unlike popover/sheet): since the editor retains focus, the trap-pop key-view restore (which *is* the editor) is a harmless idempotent no-op. Closest to the host-less inline-dialog row, not the popover row.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Confirm-popover promise/callback resolution breaks when the engine initiates the close | high | med | [P05] shared close-and-emit helper; at0151/at0152/at0040 gate the popover step | controlled confirm popover hangs on Escape |
| Context-menu synthetic Escape loops or is swallowed by its own suppressor | med | med | [P03] marker field + engine re-entrancy guard; dedicated context-menu Escape app-test | menu fails to close or closes twice |
| Menu trap breaks Radix arrow-nav/typeahead | high | low | Trap registers zero focusables in menu mode (engine Tab no-ops); at0055/at0056 + new Escape test gate | any menu keyboard interaction changes |
| Alert (app-modal) regression from joining the trap | med | low | Alert is controlled; trap is additive before arbitration flips; alert Escape app-test added | alert Escape/cancel misbehaves |
| Arbiter flip breaks an unmigrated surface mid-plan | med | low | Migration order: all surfaces into the stack (Steps 3–6) before deletion (Step 7); the trapped-no-callback dev-warn branch yields to the surface until its callback lands | dev-warn fires in the console during steps |

**Risk R01: Confirm-popover resolution rides Radix's dismissal re-emission** {#r01-reemission}

- **Risk:** Today `handleOpenChange(false)` (Radix-initiated) re-emits `DISMISS_POPOVER`, which the confirm popover's `observeDispatch` uses to resolve its promise / fire `onCancel`. An engine-initiated close that flips state directly bypasses `handleOpenChange` — no re-emission, hung promise / stuck `pending*` state.
- **Mitigation:** [P05] — extract one close-and-emit helper used by both `handleOpenChange` and the engine dismiss callback; emission carries the popover's `senderId` so self-filters keep working. at0151/at0152 plus the at0040 multi-tab cases gate it.
- **Residual risk:** A double-emission if Radix ever starts firing `onOpenChange` on controlled flips (the documented Radix assumption in tug-popover) — handlers are idempotent once resolved; noisy, not wrong.

**Risk R02: Synthesized-Escape re-entrancy on the context menu** {#r02-synthetic-escape}

- **Risk:** The engine consumes the user's Escape, then the context menu's dismiss callback synthesizes a new Escape for Radix. The engine's own listener (and the suppressor) must not treat the synthetic event as a fresh user Escape, or it loops / gets preventDefault'd before Radix sees it.
- **Mitigation:** [P03] — the synthetic event carries a marker field; the engine's document listener returns early on it; the context menu's `onEscapeKeyDown` suppressor lets marked events through (and only those).
- **Residual risk:** None structural — the marker is set and read within one synchronous dispatch.

---

### Design Decisions {#design-decisions}

#### [P01] Dismiss callbacks live on the mode entry; the engine calls them (DECIDED) {#p01-dismiss-on-entry}

**Decision:** `FocusModeEntry` gains `onEscapeDismiss?: () => void`, supplied through `pushFocusMode` opts and threaded by `useFocusTrap` (new option, held in a ref with a stable wrapper so callback identity never re-runs the push/pop effect — the `closeDisposition` pattern). A surface that pushes a trapped mode and is user-dismissable registers one; the engine invokes it when the ladder selects "dismiss the top surface."

**Rationale:**
- The mode stack already knows *which* surface is on top; the callback gives it the *how* without the engine knowing any surface's close plumbing ([L10] one responsibility per layer).
- Per-surface mechanisms genuinely differ (controlled flip / chain dispatch / synthesized event) — a callback is the only shape that doesn't force a uniform close API onto seven surfaces.

**Implications:**
- `pushFocusMode` opts: `{ trapped, commitDisposition?, escapeExits?, onEscapeDismiss? }`.
- A trapped mode *without* a callback triggers a dev-warn and yields the Escape (lets Radix/native handle) — the transitional behavior during migration and a permanent tripwire for future surfaces that forget to register.

#### [P02] One Escape ladder, in the act dispatch (DECIDED) {#p02-one-ladder}

**Decision:** The act dispatch's Escape branch becomes the single arbiter, walking in order: (1) `keyViewCaptures(Escape)` → the component keeps it (editor completion popup); (2) top mode has `onEscapeDismiss` → call it, consume the event; (3) top mode trapped without callback → dev-warn, yield; (4) top mode non-trapped (descend scope) → `ascend()`; (5) top mode `escapeExits` (cycle) → `escapeCurrentMode()`; (6) base mode → fall through to the cancel ladder (the global Escape→`CANCEL_DIALOG` binding, unchanged).

The keybinding stage's Escape guard changes in **two stages**. **Transitional (lands with the ladder):** yield iff the ladder will act — top mode has a callback, OR is non-trapped, OR is (`escapeExits` AND no dismissable surface open). **The probe term is KEPT in the transitional guard AND on the ladder's `escapeExits` branch — corrected from the original plan text by the [#step-2] spike.** The spike measured ([Q01]) that the probe is load-bearing precisely *because* of the two-listener split: when a popover is open over a cycle, Stage-1 sees the popover trap (trapped, no callback yet) and dispatches `CANCEL_DIALOG`, which closes the popover and pops its trap **synchronously**, so the act-dispatch then runs *on the same Escape* with the cycle (`escapeExits`) on top. Until the popover carries an `onEscapeDismiss` ([#step-4]) — which makes the ladder take branch (2) and `stopImmediatePropagation` *before* the cycle is ever reached — dropping the probe would exit the cycle on the popover's Escape and regress at0140/at0157. So branches (2) handle surfaces with callbacks, while branch (5)'s probe guard protects the cycle from the still-callback-less popover during Steps 3–6. A trapped mode *without* a callback keeps today's path: Stage-1 dispatches `CANCEL_DIALOG`, and Radix's fallthrough closes Radix surfaces — **this is load-bearing, not optional: the host-less dialogs' Escape IS that dispatch** (they have no Radix layer and no local handler), so yielding for trapped-no-callback before they register callbacks would break their Escape mid-plan. **Final (lands with the probe deletion, [#step-7]):** once every trapped surface has a callback, every open surface is handled by branch (2)+consume before branch (5), so the cycle's `escapeExits` branch is only ever reached with no surface open — the probe is then provably always-false and is deleted from both the guard and branch (5); the guard collapses to "any non-base mode → yield to the ladder."

**Rationale:**
- Today the decision is smeared across the keybinding guard, the chain walk's incidental reach, and Radix; one ladder in one place is the entire point of the feature.
- Branch (5) sits *below* (2): with every surface in the stack, an open surface's mode is above the cycle's, so "dismiss the surface first, exit the cycle on the next Escape" is pure stack ordering — the probe's job, done structurally.

**Implications:**
- Both probe call sites collapse into this ladder; `aDismissableSurfaceIsOpen` becomes dead code deleted in the final step.
- The ladder consumes (preventDefault + stopImmediatePropagation) on branches 2/4/5 so no suppressed-Radix surface ever races it.

#### [P03] Radix Escape suppressed everywhere; the context menu's dismiss synthesizes a marked Escape (DECIDED) {#p03-suppress-radix}

**Decision:** Every Radix-backed surface passes `onEscapeKeyDown={e => e.preventDefault()}` (popover, alert, popup-menu, context-menu); the sheet's `handleKeyDown` Escape branch and the editor context menu's local Escape branch are deleted (their Cmd-. handling stays). The uncontrolled Radix context menu's `onEscapeDismiss` reuses its existing `synthesizeEscapeDismiss()` with a marker field on the synthetic event; the engine's listener returns early on marked events, and the context menu's suppressor lets marked events through to Radix.

**Rationale:**
- Suppression makes listener ordering permanently irrelevant — the engine cannot be raced by a system that never acts.
- Radix `ContextMenu` has no controlled `open`; the synthesized keydown is its only programmatic close lever and is already this codebase's precedent (its `observeDispatch` close does exactly this). The *decision* is still the engine's; only the close *mechanism* delegates through the event.

**Implications:**
- The marker is a transient field on one synthetic `KeyboardEvent` — structure-zone, no state.
- The feature statement's "suppressed everywhere" holds for user-originated Escapes on every surface; the one synthetic event is engine-originated by definition.

#### [P04] Menus join the engine trap; `useServicePopupBinding` is deleted (DECIDED) {#p04-menus-into-trap}

**Decision:** `tug-popup-menu` (and thereby `TugPopupButton`), `tug-context-menu`, and `tug-editor-context-menu` push trapped modes while open, with `deferDomFocusToTeardown: true` and the trap's `onCloseAutoFocus` wired to their Radix `Content` where one exists (DropdownMenu/ContextMenu); the editor context menu takes the disposition [Q02] resolves. All register `onEscapeDismiss`. `use-service-popup-binding.ts` is then deleted — its first-responder capture/restore is subsumed by the trap's push-time capture (landed in `ea9c5280`), its external-pointerdown predicate by `external-dismiss-observer` (landed in the consolidation), and its `onCloseAutoFocus` by the trap's.

**Rationale:**
- The binding is the last parallel close-focus system; the trap now does everything it did, with the engine's captured state instead of a separately-captured copy.
- Menu interiors stay Radix-owned: no menu item registers an engine focusable, so the trap's Tab walk is empty for the mode and falls through — the trap contributes only stack presence, Escape routing, and close-focus restore.

**Implications:**
- at0055/at0056 (the binding's behavioral contract) must stay green unchanged through the swap — they become the menu migration's gate.
- The mouse-opened-menu restore relies on the same key-view ≡ first-responder seeding equivalence the popover migration used; the keyboard-opened case restores the ringed stop, matching the binding's engine-owns branch.

#### [P05] Engine-initiated closes route through one close-and-emit helper (DECIDED) {#p05-close-and-emit}

**Decision:** `tug-popover` extracts a single helper that flips/requests the close AND re-emits `DISMISS_POPOVER` (with the popover's `senderId`); both `handleOpenChange(false)` (Radix/user-initiated, until suppression makes it engine-only) and the registered `onEscapeDismiss` call it. The alert and popup-menu apply the same pattern to their `onOpenChange`-coupled chain dispatches.

**Rationale:**
- Inner composites (the confirm popover's promise/callback resolution, `observeDispatch` consumers) listen to the chain, not to Radix — the emission must be close-path-invariant or engine closes hang them ([R01]).

**Implications:**
- Emission idempotence: the existing sender-filter + resolved-once guards already make double-delivery harmless.

#### [P06] The alert joins the trap (DECIDED) {#p06-alert-trap}

**Decision:** `tug-alert` pushes a trapped mode while open (`deferDomFocusToTeardown: true`, trap `onCloseAutoFocus` on `AlertDialog.Content`), registers `onEscapeDismiss` (its existing cancel path), and suppresses Radix Escape.

**Rationale:**
- It is the one dismissable surface entirely outside the engine model; "single authority" is false while it remains so. It is controlled, so the dismiss callback is its `handleOpenChange(false)` path — the cheapest migration in the set.

**Implications:**
- An alert-Escape app-test is added (none exists); app-modal semantics (blocks everything until resolved) are unchanged — only who routes the Escape.

---

### Deep Dives — Implementation Notes for a Fresh Context {#deep-dives}

> Session-derived facts the plan's steps rely on but a cold read of the code won't surface quickly. Symbols, not line numbers — find them by name.

#### Current Escape flow — symbol map {#current-escape-flow}

Both arbitration sites live in `responder-chain-provider.tsx`:

1. **Stage-1** (the keybinding capture listener): matches the Escape→`CANCEL_DIALOG` binding, then the guard — `currentFocusMode() !== BASE_FOCUS_MODE && (!currentFocusModeTrapped() || (currentFocusModeEscapeExits() && !aDismissableSurfaceIsOpen()))` — yields (returns without dispatching). **The guard is keyed on `event.key === "Escape"`**; Cmd-. shares the `CANCEL_DIALOG` action but never enters the guard. Non-yield → `sendToFirstResponderForContinuation(CANCEL_DIALOG)`; handled → `preventDefault` + `stopImmediatePropagation` (Radix never sees the key); unhandled → nothing consumed → Radix's `DismissableLayer` (a document listener registered when the surface opened; the provider's listener, registered at mount, runs first by registration order) closes the surface on the *same* keydown. That unhandled-fallthrough **is the handshake this plan deletes**.
2. **The act dispatch** (the focus-act resolution listener): its CANCEL branch holds the three-way — non-trapped → `ascend()`; `escapeExits && !aDismissableSurfaceIsOpen()` → `escapeCurrentMode()`. This branch becomes the ladder.

**Two live popover-close paths exist today — both must survive every step:**
- *Plain popover:* first responder is usually the editor; the chain walk (editor → card → canvas) never reaches the portaled `TugPopoverContentShell` responder (its `parentId` hangs off the card, not the walk path), so the dispatch goes unhandled → **Radix closes it** → `handleOpenChange(false)` re-emits `DISMISS_POPOVER`.
- *Confirm popover:* it **claims first responder on open** (`handleContentFocus → makeFirstResponder`), so the walk starts at its own responder → its `CANCEL_DIALOG` handler resolves + closes, and Stage-1 consumes the key — Radix never acts. It *also* resolves via `observeDispatch` of `DISMISS_POPOVER` (the click-outside path), which is why the Step 3 transitional window (where its Escape briefly routes via Radix dismissal instead of the chain) still resolves correctly — verify with at0151/at0152 anyway.
- *Sheet:* its own React `onKeyDown` (`handleKeyDown`, Escape + Cmd-. → `sendToTarget(responderId, CANCEL_DIALOG)`) — not Radix. *Dialogs:* no Radix, no local handler — Stage-1's dispatch IS their Escape (the [P02] staging exists because of this). *Menus:* Radix-internal Escape + `useServicePopupBinding` restore.

#### Mechanism hints {#mechanism-hints}

- **Synthetic-Escape marker:** `KeyboardEvent` constructors don't take custom fields — assign after construction (`const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true }); (ev as any).__tugEngineSyntheticEscape = true;`). The *same Event instance* reaches every listener, including Radix's `onEscapeKeyDown(event)` — so both the engine's early-return and the context menu's suppressor passthrough read the marker off the event they're handed. `tug-context-menu` already has `synthesizeEscapeDismiss()`; extend it, don't duplicate it. Its `blinkingRef` self-dispatch guard must not eat the engine-initiated close.
- **Consuming branches:** the ladder consumes via `preventDefault` + `stopImmediatePropagation` (suppression is the belt; consumption is the braces — Radix's later-registered document listener never fires).
- **`useFocusTrap` ref-held callback:** mirror the `closeDisposition` pattern exactly — hold `onEscapeDismiss` in a ref, register a stable wrapper with `pushFocusMode`, never put the raw prop in the push/pop effect deps (effect churn re-pushes the mode and re-captures the key view mid-open).
- **Menu restore equivalence:** the trap's teardown writer (`onCloseAutoFocus` → `focusKeyView`) reproduces the binding's `focusResponder(captured)` because a ringless key view is seeded *equal* to the first responder (`seedKeyViewFromChain` writes `keyView = firstResponder`) — the same argument that carried the popover migration. Keyboard-opened menus restore the ringed stop (the binding's engine-owns branch, now structural).
- **Submenus:** `tug-popup-menu` has submenus (`openSubKey`). Radix's native semantics: Escape closes the *whole* menu; ArrowLeft closes the submenu. The engine dismiss callback closes the root — same outcome — but verify by-eye in the menu step that ArrowLeft submenu-close still works (it's Radix-internal and untouched).

#### Fixture and harness notes {#fixture-notes}

- **at0157's cross-pane case is hard to construct for a real reason:** a default popover dismisses on any cross-pane chain activity (`observeDispatch`) and on outside `pointerdown` (Radix). To get "popover open in pane B while interacting with pane A," use a **`dismissOnChainActivity={false}`** popover in pane B (the form-content gallery popover is the realistic instance) and activate pane A by keyboard. If even that can't realistically survive, *that finding itself* resolves the cross-pane case — document it in the test and pin the same-pane case hard.
- **Two-pane seeding:** copy at0100's `deckShape` (two panes, `acceptsFamilies`, `focusCardId`); gallery cards by `componentId`.
- **Keystroke routes:** synthetic document keydown (at0141's `pressKey` helper) travels the same capture pipeline as hardware — right for arbitration tests; `nativeKey` (modifier name is `"cmd"`, never `"meta"`) for full-OS paths (at0140 style). Native clicks throw `CoordinateOutOfBoundsError` on off-screen targets — synthetic `el.click()` is legitimate for focus-refusing controls (precedent in at0152).
- **Fresh dash worktree setup:** `cargo build --bin tugbank` in `tugrust/` first — tugbank-seeding app-tests (at0055 et al.) fail at *setup* with ENOENT otherwise, masquerading as regressions. `tugutil` may be off PATH; use `tugrust/target/debug/tugutil` for dash commits. Prefix **both** `just build-app` and `just app-test` with `TUG_FORCE_BUNDLE_ID=dev.tugtool.app.apptest` (the AX-granted bundle). tsc is `./node_modules/.bin/tsc --noEmit` from `tugdeck/` (not bunx).
- **Inconsistent batch results** (tests failing in a sweep but passing standalone) usually mean a concurrent app-test session or a stale build — re-run standalone and/or do a clean `TUG_FORCE_BUNDLE_ID=… just build-app` before believing a regression.

---

### Specification {#specification}

#### The Escape ladder {#escape-ladder}

```
document keydown: Escape (engine capture listener)
  ├─ event carries the synthetic marker            → return (engine-originated; Radix's)
  ├─ keyViewCaptures(Escape)                       → return (component owns it — editor popup)
  ├─ top mode has onEscapeDismiss                  → callback(); consume        [surface closes]
  ├─ top mode trapped, no callback                 → dev-warn; yield            [tripwire]
  ├─ top mode non-trapped (descend scope)          → ascend(); consume
  ├─ top mode escapeExits (cycle)                  → escapeCurrentMode(); consume
  └─ base mode                                     → fall through to the global
                                                     Escape→CANCEL_DIALOG binding (unchanged)
```

Cycle-with-surface-open is now: stack `[…, cycle, surfaceTrap]` → first Escape hits the surface's callback (branch 3), the trap pops, the cycle is top again → second Escape exits the cycle (branch 6). No DOM consulted at any point.

**Table T01: Dismissable-surface inventory** {#t01-surface-inventory}

| Surface | Primitive | Open model | Trap today | Escape owner today | `onEscapeDismiss` mechanism | Suppression |
|---|---|---|---|---|---|---|
| `tug-popover` / `tug-confirm-popover` | Radix Popover | controlled + uncontrolled (internal) | ✓ | Radix DismissableLayer | close-and-emit helper ([P05]) | `onEscapeKeyDown` preventDefault |
| `tug-sheet` | standalone FocusScope (portal) | `useTugSheet` | ✓ | own `handleKeyDown` Escape branch | existing `sendToTarget(CANCEL_DIALOG)` path | delete the Escape branch (keep Cmd-.) |
| `dev-question-dialog` / `dev-permission-dialog` | none (host-less) | inline | ✓ | chain CANCEL_DIALOG fallthrough | their cancel handlers | n/a (no Radix, no local branch) |
| `tug-alert` | Radix AlertDialog | controlled | ✗ → joins ([P06]) | Radix DismissableLayer | `handleOpenChange(false)` path | `onEscapeKeyDown` preventDefault |
| `tug-popup-menu` (+ `TugPopupButton`) | Radix DropdownMenu | **controlled** | ✗ → joins ([P04]) | Radix | `setOpen(false)` via `handleOpenChange` | `onEscapeKeyDown` preventDefault |
| `tug-context-menu` | Radix ContextMenu | **uncontrolled** (no `open` prop) | ✗ → joins ([P04]) | Radix | `synthesizeEscapeDismiss()` + marker ([P03]) | preventDefault, marked events pass |
| `tug-editor-context-menu` | hand-rolled (no Radix) | controlled by editor | ✗ → joins ([P04]) | own keydown Escape branch | its `onClose` callback | delete the local Escape branch |

> **Spike notes ([#step-2], DECIDED):**
> - **[Q01] probe is load-bearing, not vestigial** — neutralizing it fails at0140 + at0157; the cause is the two-listener split (Stage-1 closes the popover + pops its trap synchronously, then the act-dispatch sees the cycle on the *same* Escape). The single consuming ladder replaces it; delete only in [#step-7]. Full mechanism in [Q01]'s resolution.
> - **[Q02] editor context menu retains editor focus the whole lifecycle** (item mousedown-preventDefault) → no teardown writer needed; push trapped mode + `onEscapeDismiss` = `onClose` + delete its local Escape branch. Full disposition in [Q02]'s resolution.
> - **Radix `Content` props confirmed present** on the installed versions (no typecheck error; already in use): `internal/tug-popup-menu.tsx` passes `DropdownMenuPrimitive.Content onCloseAutoFocus` (today sourced from `useServicePopupBinding` — [#step-6] swaps to the trap's); `tug-context-menu.tsx` passes `ContextMenuPrimitive.Content onCloseAutoFocus`, already has `synthesizeEscapeDismiss()` ([P03]) and the `blinkingRef` self-dispatch guard ([R02]); `tug-alert.tsx` is controlled via `AlertDialog.Root open/onOpenChange` with a `handleOpenChange` close path ([P06]). `onEscapeKeyDown` is already used on `Popover.Content` / `ContextMenu.Content`, so the suppression prop is available on all four.
> - **Per-surface Escape today (verified):** popover/confirm → Stage-1 `CANCEL_DIALOG` dispatch closes via the chain handler (confirm, which claims first responder) or Radix `DismissableLayer` (plain); the dismiss re-emits `DISMISS_POPOVER`. Menus → Radix-internal Escape + `useServicePopupBinding` restore. Editor context menu → window-capture `keydown` Escape branch → `onClose`. Sheet/dialogs unchanged from the plan's [#current-escape-flow].

#### Public API Surface (within tugways) {#api-surface}

- `FocusModeEntry.onEscapeDismiss?: () => void`; `pushFocusMode(scopeId, { trapped, commitDisposition?, escapeExits?, onEscapeDismiss? })`; `FocusManager` delegate matched.
- `UseFocusTrapOptions.onEscapeDismiss?: () => void` (ref-held, stable wrapper registered).
- `aDismissableSurfaceIsOpen`: **deleted**. `use-service-popup-binding.ts`: **deleted**.
- Engine act-dispatch Escape branch: the ladder ([#escape-ladder]); keybinding-stage Escape guard: "non-base mode → yield".

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `onEscapeDismiss` on the mode entry | structure | in-memory stack field, registered at push (layout effect), ref-held in the trap | [L03], [L07], [L24] |
| Synthetic-Escape marker | structure | transient field on one synthetic `KeyboardEvent`, set+read in one dispatch | [L24] |
| Radix suppression handlers | structure | props on Radix contents; no state | [L24] |
| Menu trap modes (push/pop) | structure | `useFocusTrap` layout effect, as every existing surface | [L03], [L24] |
| Menu close-focus restore | appearance (DOM write) / structure (capture) | trap teardown writer (`onCloseAutoFocus` → `focusKeyView`), mode-entry capture | [L06], [L23], [L24] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Pure-logic (`bun:test`)** | The ladder's mode-stack decisions data-in/data-out (dismiss callback invoked for top trapped mode; descend ascends; cycle exits; pointer-exit gates unchanged) against the real `FocusManager` | the engine step |
| **Real-app (`just app-test`)** | Escape behavior per surface end-to-end (real Radix, real portals, real event order); close-focus restoration unchanged; the two-pane cycle case | every step's checkpoint |
| **Drift prevention** | The existing focus suite green unchanged is the refactor's contract | all steps |

#### What stays out of tests {#test-non-goals}

- **Fake-DOM / RTL render tests, mock-store assertion tests** — banned; ladder logic is pure-logic against the real engine, everything event-ordered goes to app-test.
- **Radix-internal behavior** (menu typeahead, arrow roving) — not ours; covered indirectly by existing menu tests staying green.
- **Re-pinning behaviors the suite already pins** — at0140/at0151/at0152/at0055/at0056/at0100/at0106 et al. are the regression oracle; new tests cover only the genuinely new axes (two-pane Escape, menu Escape-close restore, alert Escape, context-menu Escape).

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. tugdeck checkpoints run `./node_modules/.bin/tsc --noEmit` (from `tugdeck/`), `bun test src/components/tugways/__tests__/`, and the named `just app-test` files.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Behavioral pins: two-pane cycle Escape + menu Escape-close tests | done | 2f9f12a4 |
| #step-2 | Spike: probe vestigiality + per-surface Escape characterization | done | 930f0aee |
| #step-3 | Engine: `onEscapeDismiss` + the Escape ladder | done | 4a125427 |
| #step-4 | Popover/confirm + sheet + dialogs: callbacks, suppression, close-and-emit | done | 13e3e5ed |
| #step-5 | Alert joins the trap | done | 42f6bfdf |
| #step-6 | Menus into the trap; delete `useServicePopupBinding` | done | fa7c3625 |
| #step-7 | Delete the probe and its call sites | done | 79cfeaf6 |
| #step-8 | Integration checkpoint | done | (verification only) |

#### Step 1: Behavioral pins {#step-1}

**Commit:** `Pin cross-pane cycle Escape and menu Escape-close behavior`

**References:** (#success-criteria), Table T01 (#t01-surface-inventory), [P04] (#p04-menus-into-trap)

**Artifacts:**
- `tests/app-test/at0157-cycle-escape-two-pane.test.ts`: two panes; cycle active in pane A; popover open in pane B (opened via its trigger, left open); Escape in pane A — **pin the *intended* behavior: the cycle exits** (this is the cross-pane fix; if it fails against current `main`, mark the case `test.todo`-style as the target and pin the same-pane case (cycle + own-pane popover: first Escape closes only the popover) which must already pass). Pane B's popover must be a `dismissOnChainActivity={false}` instance and pane A activated by keyboard, or it self-dismisses before Escape — see (#fixture-notes).
- `tests/app-test/at0158-menu-escape-close-focus.test.ts`: open the editor-toolbar popup menu (the at0055 fixture), press Escape, assert the menu closes and editor focus/typing is restored — green against current behavior (the binding's restore).

**Tasks:**
- [ ] Author both tests against current `main` behavior; document inside at0157 which case is the pinned-current vs the pinned-target.

**Tests:**
- [ ] The two new tests themselves.

**Checkpoint:**
- [ ] `./node_modules/.bin/tsc --noEmit` clean
- [ ] `just app-test at0140-cycle-devcard at0157-cycle-escape-two-pane at0158-menu-escape-close-focus` → VERDICT: PASS (modulo the documented pinned-target case)

---

#### Step 2: Spike — probe vestigiality + Escape characterization {#step-2}

**Depends on:** #step-1

**Commit:** `Record Escape-flow spike results in the mode-stack refactor plan`

**References:** [Q01] (#q01-probe-vestigial), [Q02] (#q02-editor-menu-restore), Table T01 (#t01-surface-inventory)

**Artifacts:**
- [T01] spike-notes filled: probe-removal result against at0140 + at0157; the editor context menu's close-focus disposition; any surprise in per-surface Escape flow (who actually closes what today).

**Tasks:**
- [ ] Temporarily delete the probe locally; run at0140 + at0157; restore; record ([Q01] → DECIDED).
- [ ] Read `tug-editor-context-menu`'s close/restore path; record its migration disposition ([Q02] → DECIDED).
- [ ] Confirm the Radix `Content` props (`onEscapeKeyDown`, `onCloseAutoFocus`) exist on the installed versions of DropdownMenu/ContextMenu/AlertDialog (typecheck a scratch usage).

**Tests:**
- [ ] None new — the spike runs existing + Step 1 tests.

**Checkpoint:**
- [ ] Plan updated with both resolutions; `just app-test at0140-cycle-devcard` → VERDICT: PASS (tree restored to pre-spike state)

---

#### Step 3: Engine — `onEscapeDismiss` + the ladder {#step-3}

**Depends on:** #step-2

**Commit:** `Add mode-entry dismiss callbacks and the single Escape ladder`

**References:** [P01] (#p01-dismiss-on-entry), [P02] (#p02-one-ladder), [P03] (#p03-suppress-radix), Spec (#escape-ladder), (#api-surface)

**Artifacts:**
- `FocusModeEntry.onEscapeDismiss` + `pushFocusMode` opts + `FocusManager` delegate; `useFocusTrap` option (ref-held, stable wrapper).
- The act-dispatch Escape ladder per [#escape-ladder], including the synthetic-marker early-return and the trapped-no-callback dev-warn+yield branch.
- Keybinding-stage Escape guard moved to its **transitional** form per [P02]: yield iff top mode has a callback / is non-trapped / is (`escapeExits` AND no dismissable surface open — **probe term KEPT**, per the [#step-2] spike correction); trapped-no-callback keeps today's `CANCEL_DIALOG` dispatch + Radix fallthrough. The ladder's `escapeExits` branch (5) ALSO keeps its `!aDismissableSurfaceIsOpen()` guard this step. Dropping the probe before the popover has a callback ([#step-4]) would regress at0140/at0157 — the spike proved the popover trap pops mid-Escape, exposing the cycle to the act-dispatch on the same event. The guard's *final* "non-base → yield" form and the probe deletion both land in #step-7.
- Pure-logic tests for the ladder's stack decisions.

**Tasks:**
- [ ] Engine fields + threading; ladder; transitional guard.
- [ ] No surface registers a callback yet — behavior must hold byte-identical: trapped-no-callback surfaces keep the Stage-1 dispatch path (dialogs close via their chain handlers; plain popovers via Radix fallthrough; the FR-claiming confirm popover via its own `CANCEL_DIALOG` handler), and descend/cycle flows route through the ladder exactly as the old act-dispatch branches did.
- [ ] Preserve the guard's `event.key === "Escape"` condition — Cmd-. shares the `CANCEL_DIALOG` action but must NEVER be yielded to the ladder (it stays chain-routed for all surfaces, per #non-goals).

**Tests:**
- [ ] Pure-logic: top trapped mode with callback → callback invoked once, cycle untouched; without → yield; descend → ascend; cycle top → exit; pointer-exit pop options unchanged.

**Checkpoint:**
- [ ] `./node_modules/.bin/tsc --noEmit` clean; `bun test src/components/tugways/__tests__/` → all pass
- [ ] `just app-test at0140-cycle-devcard at0151-confirm-popover-editor-restore at0152-confirm-popover-firstresponder-restore at0106-sheet-focus-trap at0147-question-nav-focus at0105-permission-cycle-keys at0157-cycle-escape-two-pane` → VERDICT: PASS (behavior unchanged — the dialog tests prove the transitional guard kept the dispatch path; dev-warn may log)

---

#### Step 4: Popover/confirm + sheet + dialogs {#step-4}

**Depends on:** #step-3

**Commit:** `Engine-owned Escape for popover, sheet, and inline dialogs`

**References:** [P01], [P03] (#p03-suppress-radix), [P05] (#p05-close-and-emit), Risk R01 (#r01-reemission), Table T01

**Artifacts:**
- `tug-popover`: close-and-emit helper ([P05]); `onEscapeDismiss` registered via the trap; `onEscapeKeyDown` preventDefault on `Popover.Content`. Confirm popover inherits (resolution via the re-emitted `DISMISS_POPOVER`).
- `tug-sheet`: `onEscapeDismiss` = its existing `sendToTarget(CANCEL_DIALOG)` cancel path; the `handleKeyDown` Escape clause deleted (Cmd-. clause kept).
- `dev-question-dialog` / `dev-permission-dialog`: `onEscapeDismiss` = their cancel handlers.

**Tasks:**
- [ ] Wire all four; verify the confirm popover's controlled-mode promise/callback resolution on an engine-initiated Escape.

**Tests:**
- [ ] No new tests — the suite is the contract.

**Checkpoint:**
- [ ] `./node_modules/.bin/tsc --noEmit` clean; `bun test src/components/tugways/__tests__/` → all pass
- [ ] `just app-test at0140-cycle-devcard at0151-confirm-popover-editor-restore at0152-confirm-popover-firstresponder-restore at0040-multi-tab-close-confirm at0041-gallery-close-reopen at0100-sheet-pane-modal-focus at0106-sheet-focus-trap at0147-question-nav-focus at0105-permission-cycle-keys at0157-cycle-escape-two-pane` → VERDICT: PASS
- [ ] No dev-warn from these four surfaces in the app-test logs

---

#### Step 5: Alert joins the trap {#step-5}

**Depends on:** #step-3

**Commit:** `Bring tug-alert into the engine focus trap with engine-owned Escape`

**References:** [P06] (#p06-alert-trap), [P01], [P03], Table T01

**Artifacts:**
- `tug-alert`: `useFocusTrap` (trapped, `deferDomFocusToTeardown: true`, `onEscapeDismiss` = its cancel/close path); trap `onCloseAutoFocus` on `AlertDialog.Content`; `onEscapeKeyDown` preventDefault.
- New `tests/app-test/at0159-alert-escape.test.ts`: open an alert, Escape cancels it, focus returns to the opener context.

**Tasks:**
- [ ] Wire the trap + callback + suppression; confirm app-modal blocking semantics unchanged.

**Tests:**
- [ ] at0159 (new).

**Checkpoint:**
- [ ] `./node_modules/.bin/tsc --noEmit` clean
- [ ] `just app-test at0159-alert-escape at0020-overlay-focus-return at0037-deck-wide-restore-consistency` → VERDICT: PASS

---

#### Step 6: Menus into the trap; delete the binding {#step-6}

**Depends on:** #step-3

**Commit:** `Migrate menus to the engine trap; retire useServicePopupBinding`

**References:** [P04] (#p04-menus-into-trap), [P03] (#p03-suppress-radix), Risk R02 (#r02-synthetic-escape), Risk row 3 (#risks), [Q02], Table T01

**Artifacts:**
- `tug-popup-menu`: trap (`deferDomFocusToTeardown: true`), trap `onCloseAutoFocus` on `DropdownMenu.Content` (replacing the binding's), `onEscapeDismiss` = controlled close, `onEscapeKeyDown` preventDefault. `TugPopupButton` inherits.
- `tug-context-menu`: trap + trap `onCloseAutoFocus`; `onEscapeDismiss` = `synthesizeEscapeDismiss()` with the marker; suppressor passes marked events; engine listener's marker early-return exercised.
- `tug-editor-context-menu`: trap per its [Q02] disposition; `onEscapeDismiss` = its `onClose`; local Escape keydown branch deleted.
- `use-service-popup-binding.ts` **deleted**, all imports gone.
- New `tests/app-test/at0160-context-menu-escape.test.ts`: open the context menu, Escape closes it (once), focus restored.

**Tasks:**
- [ ] Migrate the three menus; delete the binding; verify menu arrow-nav/typeahead by-eye on the HMR build.
- [ ] Verify submenu semantics by-eye: ArrowLeft still closes only the submenu (Radix-internal, untouched); Escape closes the whole menu via the engine callback — see (#mechanism-hints).
- [ ] Confirm the context menu's `blinkingRef` self-dispatch guard does not swallow the engine-initiated close.

**Tests:**
- [ ] at0160 (new); at0158 (from #step-1) now exercises the trap-owned restore.

**Checkpoint:**
- [ ] `./node_modules/.bin/tsc --noEmit` clean; `bun test src/components/tugways/__tests__/` → all pass
- [ ] `grep -rn "useServicePopupBinding" tugdeck/src` → no hits; `ls tugdeck/src/components/tugways/use-service-popup-binding.ts` → absent
- [ ] `just app-test at0055-popup-close-restores-editor-focus at0056-popup-outside-click-skips-restore at0158-menu-escape-close-focus at0160-context-menu-escape` → VERDICT: PASS

---

#### Step 7: Delete the probe {#step-7}

**Depends on:** #step-4, #step-5, #step-6

**Commit:** `Delete the dismissable-surface DOM probe; Escape is pure mode-stack ordering`

**References:** [P02] (#p02-one-ladder), [Q01], (#success-criteria)

**Artifacts:**
- `aDismissableSurfaceIsOpen()` and any residual references deleted from `responder-chain-provider.tsx`; the at0157 pinned-target case (cross-pane) flipped to a hard assertion if it was deferred in #step-1.
- The keybinding-stage Escape guard collapsed to its **final** form per [P02]: "any non-base mode → yield to the ladder" — every trapped surface now has a callback, so the transitional trapped-no-callback dispatch path is dead and removed.

**Tasks:**
- [ ] Delete the probe; collapse the guard to its final form; flip at0157's target case live; confirm zero `aDismissableSurfaceIsOpen` references.

**Tests:**
- [ ] at0157 fully asserting (both cases hard).

**Checkpoint:**
- [ ] `grep -rn "aDismissableSurfaceIsOpen" tugdeck/src` → no hits
- [ ] `just app-test at0140-cycle-devcard at0157-cycle-escape-two-pane` → VERDICT: PASS

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), Table T01

**Tasks:**
- [ ] All success-criteria greps; code-read every [T01] row against its final state.
- [ ] By-eye smoke on the HMR build: each surface's Escape (popover over cycle ×2 Escapes, confirm cancel, sheet, alert, each menu, editor context menu, dialogs), plus popovers still exceeding card bounds.

**Tests:**
- [ ] Full sweep.

**Checkpoint:**
- [ ] `./node_modules/.bin/tsc --noEmit` clean; `bun test src/components/tugways/__tests__/` → all pass
- [ ] `just app-test at0020-overlay-focus-return at0037-deck-wide-restore-consistency at0039-title-bar-return-focus-restore at0040-multi-tab-close-confirm at0041-gallery-close-reopen at0055-popup-close-restores-editor-focus at0056-popup-outside-click-skips-restore at0058-popup-in-sheet-close-focus at0100-sheet-pane-modal-focus at0105-permission-cycle-keys at0106-sheet-focus-trap at0140-cycle-devcard at0147-question-nav-focus at0151-confirm-popover-editor-restore at0152-confirm-popover-firstresponder-restore at0157-cycle-escape-two-pane at0158-menu-escape-close-focus at0159-alert-escape at0160-context-menu-escape` → VERDICT: PASS

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Escape is decided in exactly one place — the engine's mode-stack ladder — for every dismissable surface; Radix never arbitrates; the DOM probe and `useServicePopupBinding` are deleted; cycle-vs-surface is pure stack ordering; popovers still exceed card bounds via the untouched global portal.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `aDismissableSurfaceIsOpen` — zero references (grep)
- [ ] `use-service-popup-binding.ts` — deleted; zero imports (grep + ls)
- [ ] Every [T01] surface pushes a mode with `onEscapeDismiss`; Radix Escape suppressed per [T01]'s suppression column (code read)
- [ ] The ladder is the only Escape arbitration site; the keybinding guard is the simple non-base yield (code read)
- [ ] Full sweep green including the four new tests (at0157–at0160)

**Acceptance tests:**
- [ ] at0157 both cases hard-asserting (same-pane: popover first, cycle second; cross-pane: peer popover cannot suppress the cycle's exit)
- [ ] at0158/at0160 menu Escape-close restore; at0159 alert Escape; at0055/at0056 unchanged through the binding's deletion

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Mouse-opened-sheet → trigger-restore app-test (carried from the close-focus plan; still a coverage gap, unaffected here).
- [ ] Consider folding the sheet's remaining Cmd-. local branch into a chain-only route once a force-dismiss audit happens.
- [ ] Evaluate retiring Radix `FocusScope` per surface (the trap as sole DOM trap) — the original "taming" end-state; this plan completes Escape, not Tab/DOM-trap ownership.

| Checkpoint | Verification |
|------------|--------------|
| Engine is sole Escape arbiter | greps + code read of the ladder + [T01] |
| No behavior regression | the unchanged at00xx suite green at every step |
| Cross-pane fix delivered | at0157 hard assertions |
| Binding retired without menu regression | at0055/at0056/at0158/at0160 |
