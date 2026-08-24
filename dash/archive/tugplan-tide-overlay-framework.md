---
status: completed
authors: ken
date: 2026-05-02
depends-on: tugplan-tide-popup-bindings.md (Steps 1–2 landed)
unblocks: tugplan-tide-popup-bindings.md (Steps 3–8)
---

## Tide Overlay Framework — focus, responder, and event-flow contracts {#tide-overlay-framework}

A small, decided framework for how popup-class overlays interact with the responder chain, focus discipline, and the pane focus controller. Replaces the current emergent behavior with named primitives, named attributes, and documented invariants. Future cards consume the framework instead of rediscovering its rules from scratch.

### Plan Metadata {#plan-metadata}

- **Status:** completed
- **Risk profile:** medium — framework changes touch widely-used primitives but are internal contract refactors; visible behavior preserved with one targeted bug fix
- **Time budget:** ~3 hours of focused work (plan + implementation + verification)
- **Test posture:** unit tests for invariants; existing app-tests catch regressions
- **Codename:** *tide-overlay-framework*
- **Predecessors:** `tugplan-tide-overlay-tier.md`, `tugplan-tide-popup-bindings.md` (Steps 1–2)
- **Successors:** `tugplan-tide-popup-bindings.md` Steps 3–8 rewrite onto this framework

### Phase Overview {#phase-overview}

#### Context {#context}

Step 2 of `tugplan-tide-popup-bindings` shipped the `TugSheet` portal-target migration successfully (sheet panel extends past the card, scrim clipped to the pane, drag tracks). But the cancel-cascade — where the picker's `onClosed` dispatches `CLOSE` through the chain to remove the host card — does not reliably reach the pane's `CLOSE` handler. The user's diagnosis on the spot:

> We don't have a baked-in, decided, solid, reliable, and thoroughly well-understood policy for how this system of overlays, focus, firstResponder, and event flows work. We can't go through a deep-dive investigation every time we do a new card. We need to build in *framework-level* support to this code and these components.

Five subsystems interact through implicit conventions:

1. **Portals** (`react-dom.createPortal`, `useCanvasOverlay`) — where DOM lands.
2. **Responder chain** (`responder-chain.ts`, `use-responder.tsx`) — registry + first-responder + dispatch walks. Two walks exist: DOM-walk via `parentElement` (`findResponderForTarget`) and React-tree walk via `parentId` (`walkFromNode`).
3. **Focus events** (`focusin`/`focusout`) — chain provider listens at document level and promotes via `findResponderForTarget`.
4. **Pane focus controller** (`pane-focus-controller.ts`) — DOM-walk-based pane activation + canvas-background deselect.
5. **Focus discipline markers** (`data-tug-focus="refuse"`, `data-no-activate`) — overloaded HTML attributes consumed by all of the above.

Bugs at the intersections take long to diagnose because no single document says how the five interact. This plan writes that document — and bakes the contracts into typed primitives where it matters.

#### Strategy {#strategy}

Three concrete deliverables, each addressing a named bug class or framework gap:

1. **Disambiguate `data-tug-focus="refuse"`** into per-concern attributes. One semantic per attribute. (See [D01]; the exact split is two attributes — overlay-tier vs. button-class — not three; [D07] formalizes that the two button-class behaviors stay bundled as one concept.)
2. **Explicit close-cascade target API** on `useTugSheet`: a modal captures a "cascade target" responder id at open time and dispatches via `sendToTarget` instead of `sendToFirstResponder`. Removes the load-bearing assumption that first responder is correctly set at the moment the cascade fires.
3. **Documented mental model** in code: a single canonical doc (this plan's Deep Dives section, plus a module docstring) describing the five subsystems, their interactions, and the invariants the framework now enforces.

Items not delivered as code primitives — and the reasons each is not a deferral but a recorded decision: see (#proposal-audit) and decisions [D05] (no universal `useOverlay({ role })`), [D06] (`onClosed` is already the close-settled boundary), [D07] (refuse-attribute behavior pair is intentionally bundled). The original proposal's six-item list is fully accounted for there: three items shipped in Steps 1–4, three are explicitly resolved as not-needed, and zero are deferred to "as consumer needs surface." Future contributors who want to revisit any of those decisions read the recorded analysis first.

#### Success Criteria (Measurable) {#success-criteria}

1. The Tide picker cancel-cascade closes its host card reliably (the bug from the Step 2 hand-off).
2. `data-tug-focus="refuse"` no longer appears on `<CanvasOverlayRoot />`. The pane focus controller's "skip on canvas-overlay click" behavior is preserved via a separate, named attribute.
3. `useTugSheet` exposes an explicit `cascadeTargetId` option (or equivalent) for consumers that need a chain dispatch on close.
4. The mental model is documented in **one** place, linked from the relevant module docstrings (responder-chain, use-responder, canvas-overlay-root, tug-sheet).
5. Unit tests assert the documented invariants.
6. `bun x tsc --noEmit` green; `bun test` green; `bun run audit:tokens lint` exits 0.

#### Scope {#scope}

In-scope:
- `tug-button.tsx`, `canvas-overlay-root.tsx`, `pane-focus-controller.ts`, `responder-chain-provider.tsx` — disambiguation refactor.
- `tug-sheet.tsx` (`useTugSheet`, `TugSheet`, `TugSheetContent`) — close-cascade target API.
- `tide-card.tsx` — adopts the new API; cancel-cascade fixed.
- New file `responder-chain-invariants.md` (or equivalent doc anchor) referenced from module docstrings.
- New unit tests for invariants.

Out of scope (explicit):
- `useOverlay({ role })` universal primitive.
- `useOverlayLifecycle()` with `onClose`/`onCloseSettled`.
- Refactoring `useOptionalResponder`'s registration / promotion logic.
- Migrating popup-bindings Steps 3–8 — they consume this framework but are authored in their own plan.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Designing a fully-uniform overlay API. The taxonomy in the popup-bindings plan ([Popup Role Taxonomy](#popup-role-taxonomy-link)) stays a documentation tool here, not enforced code.
- Eliminating the dual chain walks (DOM walk vs `parentId` walk). They serve different purposes; we document the rule for which is canonical for which use case, not unify them.
- Re-architecting the deck's overall focus model. Pane focus controller and pane activation stay as-is.

#### Dependencies / Prerequisites {#dependencies}

- `tugplan-tide-popup-bindings.md` Steps 1–2 landed (canvas overlay tier exists; sheets already portal there).
- No new dependencies on external libraries.

#### Constraints {#constraints}

- Must preserve every existing user-visible behavior except the cancel-cascade bug being fixed.
- All migrated call sites must adhere to the [Tuglaws](../tuglaws/tuglaws.md): especially [L02] (external state via `useSyncExternalStore`), [L06] (appearance via CSS/DOM), [L07] (closure stability via refs), [L19] (component authoring guide), [L24] (state-zone partition).
- Token audit (`bun run audit:tokens lint`) and type-check (`tsc --noEmit`) must stay green at every commit.

#### Assumptions {#assumptions}

- The chain's `sendToTarget(id, ...)` will reliably dispatch to a registered responder regardless of first-responder state. (Verified: `sendToTargetForContinuation` walks via `parentId` from `targetId`, no first-responder dependency.)
- The pane responder id (`stackId`) is available at sheet-open time to consumers that need a cascade target. (`hostStackId` is a prop on every CardHost — passing it through is mechanical.)
- Removing `data-tug-focus="refuse"` from `<CanvasOverlayRoot />` and adding a separate marker attribute does not break Step 1's popup-class portal migration. (Verified by inspection: popups inside the overlay root either have their own responder elements that handle promotion correctly, or are non-responder elements like the completion menu where chain promotion is a no-op anyway.)

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Same as `tugplan-tide-popup-bindings.md`:
- Decisions: `[D01]`, `[D02]`, …
- Open Questions: `[Q01]`, `[Q02]`
- Risks: `R01`, `R02`
- Tuglaws: `[L01]`, `[L02]`, …
- Step refs: `[Step 1]`(#step-1), …
- Section refs: `(#section-anchor)`

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Where do other modal patterns get their cascade target id from? (DEFERRED) {#q01-cascade-target-source}

**Question:** `useTugSheet`'s explicit `cascadeTargetId` option works for the picker (consumer passes `hostStackId`). What about `TugAlert`, `TugConfirmPopover`, future modal-with-trap surfaces?

**Resolution:** Defer. Other modals don't need a cascade today (their consumers don't dispatch through the chain on close). When one does, we'll thread `cascadeTargetId` the same way. The pattern is established; replication is mechanical.

#### [Q02] Should the chain's `findResponderForTarget` be augmented with a "portal-aware" mode? (DEFERRED) {#q02-portal-aware-walk}

**Question:** Today `findResponderForTarget` walks DOM `parentElement` only. Sheets portaled into the canvas overlay tier have no responder ancestor in DOM, even though they have a logical (React-context) parent in the chain.

**Resolution:** Defer. Documented as an invariant for now: *DOM walks find responders along the rendered DOM path; React-tree walks (via `parentId`) find responders along the conceptual ancestry. They are different by design and consumers must use the right walk for the job.* If a future use case needs a unified walk, design it then.

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Removing refuse from canvas-overlay-root regresses pane-focus-controller behavior | high | low | Replace with `data-slot="tug-canvas-overlay-root"` selector check in pane-focus-controller; existing slot attribute already present; new check tested | Pane deselect fires inappropriately on overlay clicks |
| Removing refuse from canvas-overlay-root regresses chain promotion behavior for popups | med | low | Popups in canvas overlay either have responders (sheet, popover — chain promotion works correctly) or no responders (completion menu — promotion is a no-op). Verified by inspection; covered by existing popup tests | Popup click promotes wrong responder |
| Cascade-target API leaks the pane id where it shouldn't | low | low | API takes any registered responder id; consumers choose which target makes sense (typically pane, but could be card-host or another modal). Documented in module docstring | Misuse surfaces |
| Documented invariants drift from code | med | med | Invariants live in code comments + tests; tests run on every CI; comment review is part of every framework-touching PR | Test fails or invariant comment becomes false |

### Design Decisions {#design-decisions}

#### [D01] Disambiguate `data-tug-focus="refuse"` into three named attributes (DECIDED) {#d01-disambiguate-attrs}

**Decision:** Today, one attribute (`data-tug-focus="refuse"`) is read by three different subsystems with three different intents:

| Reader | Current selector | New attribute (this plan) |
|--------|------------------|---------------------------|
| `responder-chain-provider.tsx` `promoteOnPointerDown` (skip first-responder promotion) | `[data-tug-focus="refuse"]` | `[data-tug-focus="refuse"]` (semantics narrowed to *this* concern) |
| `responder-chain-provider.tsx` `preventFocusOnMouseDown` (browser focus prevention) | `[data-tug-focus="refuse"]` | `[data-tug-focus="refuse"]` (paired with above) |
| `pane-focus-controller.ts` (skip activation/deselect) | `[data-tug-focus="refuse"]` | `[data-slot="tug-canvas-overlay-root"]` (already present) |

After:
- `data-tug-focus="refuse"` exclusively means *"this control should not promote first responder or take browser focus on click."* TugButton continues to have it. Canvas-overlay-root no longer does.
- Pane focus controller's check becomes `if (startEl.closest('[data-slot="tug-canvas-overlay-root"]')) return;` — directly checking for the canvas overlay slot it actually wants to skip on. The check moves from "I happen to have a refuse attribute" to "I'm inside the canvas overlay tier" — semantically what was always meant.

**Rationale:**
- One semantic per attribute makes the system inspectable. A reader can search for `data-tug-focus="refuse"` and immediately know what it means.
- The pane-focus-controller's check was always *about* canvas-overlay-tier specifically, not about button-class focus refusal — they happened to share an attribute by accident.
- Removing the attribute from canvas-overlay-root has the side effect that descendants of the overlay root no longer match `closest('[data-tug-focus="refuse"]')`. This is correct: a sheet's content shouldn't refuse focus promotion; it's a modal that should claim first responder.

**Implications:**
- `<CanvasOverlayRoot />` loses one inline attribute.
- `pane-focus-controller.ts` line 191 (currently `if (startEl.closest('[data-tug-focus="refuse"]')) return;`) changes selector.
- TugButton's existing `data-tug-focus="refuse"` is unchanged.
- Completion menu items (which have no responder element of their own) continue to behave correctly: chain promotion finds no responder ancestor in the canvas overlay subtree, so promotion is a no-op regardless of the attribute change.

**Tuglaws cross-check:** Affects [L19] (component authoring guide will gain an entry on focus discipline attributes) and the chain-provider's documented selector. No appearance-zone, no React-state, no L06/L24 implications.

#### [D02] Modal surfaces capture an explicit cascade target at open time (DECIDED) {#d02-explicit-cascade-target}

**Decision:** `useTugSheet().showSheet(options)` accepts an optional `cascadeTargetId: string` that the consumer passes at open time. When present, it identifies the responder the cascade dispatch should target via `sendToTarget`. The hook stores it; `onClosed` consumers can read it from the same options object (no API change to `onClosed` itself — the consumer captures the id in the closure where they call `showSheet`).

The picker pattern becomes:

```ts
const presentSheet = useCallback(() => {
  void showSheet({
    title: "Open Project",
    content: ...,
    cascadeTargetId: cardId,        // card-host responder id, captured at open
    onClosed: (result) => {
      if (result === "open" || result === "retry") return;
      // Dispatch to the target captured at open time.
      manager?.sendToTarget(cardId, {
        action: TUG_ACTIONS.CLOSE,
        sender: senderId,
        phase: "discrete",
      });
    },
  });
}, [showSheet, cardId, manager, senderId]);
```

`sendToTarget(cardId, ...)` walks via `parentId` from the card-host responder, which traverses one hop to its parent (the host pane's `stackId`). The pane has the `CLOSE` handler (`tug-pane.tsx`) — it fires.

**Why `cardId`, not `hostStackId`** — Step 3's pinned choice (formalized after the [D02] code example was first drafted): the picker has `cardId` directly in scope (no extra plumbing), and `cardId` is stable across cross-pane moves while `hostStackId` is not (see `card-host.tsx`'s comment on `cardId` being the "stable identity content factories key their per-card state off; it survives detach/merge whereas hostStackId changes on cross-pane moves"). Both ids reach the same `CLOSE` handler at the pane via the chain walk; using the more stable starting node shortens the failure mode catalog. The general rule: **pick the cascade target id whose registration outlives the dispatch window, not the closest one to the handler**. For the sheet → pane cascade specifically, that's `cardId`; for a future modal whose cascade target is a sibling responder, the consumer picks accordingly.

The key shift: **the cascade target is a *value* captured at open time, not a state lookup at close time.** No dependency on `firstResponderId` being correctly set at the moment `onClosed` fires.

**Rationale:**
- Decouples the cascade dispatch from the chain's first-responder state, which is itself the product of multiple racing inputs (registration order, focus events, FocusScope mount/unmount, unregister fallback). Removing first-responder from the load-bearing path eliminates a class of bugs.
- `sendToTarget` is already in the chain's public API and is the right tool for "I know exactly who should handle this." Using it makes intent explicit.
- The `cascadeTargetId` option, even though `useTugSheet` itself doesn't consume it directly in this plan's scope, documents the contract for consumers who need a cascade. Future modal patterns (alerts, confirm popovers) can follow the same shape.

**Implications:**
- `ShowSheetOptions` gains an optional `cascadeTargetId?: string` field. The hook stores it (read-only — currently just for documentation; consumers reference it from their own closure).
- `tide-card.tsx` `presentSheet` is updated: passes `cardId` as `cascadeTargetId` and uses `manager.sendToTarget(cardId, ...)` in `onClosed` instead of `manager.sendToFirstResponder(...)`. (Earlier drafts of this decision named `hostStackId`; landed implementation uses `cardId` per the stability argument above.)
- Cancel-cascade bug fixed: `CLOSE` reaches the pane regardless of focus state.

**Sharp edge:** `sendToTarget(id, ...)` throws if `id` is not registered at dispatch time. For tide-card's picker, this is unreachable in practice — `cardId` registration outlives the picker's onClosed callback (the closure can't fire if the card has unmounted). Future consumers of this pattern should pick a `cascadeTargetId` whose lifetime envelopes the dispatch window, OR guard the dispatch with try/catch / a tolerant variant. If a class of consumers needs the tolerant variant, add `sendToTargetIfRegistered` rather than making `sendToTarget` itself silently swallow.

**Tuglaws cross-check:** [L11] — controls dispatch actions; the chain delivers them. `sendToTarget` is the chain-native delivery mechanism for "named target dispatches" (vs `sendToFirstResponder` for "current focus dispatches"). [L19] — `useTugSheet` JSDoc updated.

#### [D03] Document the dual chain-walk policy (DECIDED) {#d03-dual-walk-policy}

**Decision:** The responder chain has two walks; both are correct for different use cases. The framework documents the policy:

- **DOM walk via `parentElement` (`findResponderForTarget`):** "Given an arbitrary DOM node, find the nearest *registered* responder along the rendered DOM path." Used for: pointerdown / focusin promotion (the user clicked / focused this DOM element — promote the nearest responder above it in DOM).
- **React-tree walk via `parentId` (`walkFromNode`):** "Given a starting responder id, walk via the chain registry to reach handlers." Used for: dispatch (`sendToFirstResponder`, `sendToTarget`, `sendToTargetForContinuation`) — every dispatch walks `parentId` only.

The two walks can produce different ancestors. **By design.** A sheet portaled into the canvas overlay root has no responder ancestor along its DOM path (DOM walk returns null), but its React-tree `parentId` is the card-host (set at registration via `ResponderParentContext`). Both are correct — they answer different questions.

**Rationale:**
- The walks are *not* a bug or an oversight. They serve distinct purposes that the codebase has been quietly relying on for a while.
- Documenting the policy gives reviewers a concrete rule to apply: *"Did the caller want 'closest registered responder by DOM' or 'closest registered ancestor by chain'?"* Once that question is asked, the right walk is obvious.
- The framework's `cascadeTargetId` design ([D02]) leans on this distinction: it deliberately uses `sendToTarget` (which walks `parentId`) so it doesn't depend on DOM ancestry.

**Implications:**
- A new doc section in this plan ([Deep Dives](#deep-dives)) explains the policy.
- `responder-chain.ts` gets a top-of-file invariants comment summarizing the two walks and when each is canonical.
- No code changes in the chain itself; this is a documentation decision.

**Tuglaws cross-check:** [L19] — component-authoring guide gains an entry pointing at the chain's invariants doc.

#### [D04] Documented invariants live in code, with tests (DECIDED) {#d04-documented-invariants}

**Decision:** Six invariants the framework guarantees. Each gets:
- A line in a top-of-file `INVARIANTS:` comment in `responder-chain.ts`.
- A unit test that asserts it.

The invariants:

- **I1.** Every registered responder's `parentId` is either `null` or the id of another registered responder (at registration time).
- **I2.** `firstResponderId` is null OR the id of a currently registered responder.
- **I3.** `sendToTarget(id, ...)` walks `parentId` from `id`, regardless of `firstResponderId` state. Never a no-op due to first-responder being unexpected.
- **I4.** `findResponderForTarget(node)` walks DOM `parentElement` from `node`, finding the nearest *registered* responder. Returns null if none exists along the DOM path.
- **I5.** A modal that captures a `cascadeTargetId` at open time can dispatch to that target on close even if no DOM-walk path exists between modal and target (e.g., portaled modals). Verified by an integration-style test.
- **I6.** `data-tug-focus="refuse"` controls only chain-promotion-skip and browser-focus-prevention semantics (button-class behavior). It does not control pane-focus-controller behavior.

**Rationale:**
- An invariant without a test rots into a comment that lies. Tests are the load-bearing assertion.
- Each invariant is small and orthogonal. A reviewer reading the chain's code can scan the list and quickly check whether the change touches any of them.
- The invariants are about *the chain's contracts*, not about consumer code. They constrain how the chain can evolve.

**Implications:**
- `responder-chain.ts` gains an `INVARIANTS` block at the top.
- New test file `responder-chain-invariants.test.ts` (or extends an existing file) covers I1–I6.
- The `tug-sheet-stacking-context.ts` and `use-responder.tsx` JSDocs link to the invariants block.

**Tuglaws cross-check:** [L19] (component authoring guide) gets a one-liner pointing at the invariants block.

#### [D05] No universal `useOverlay({ role })` primitive (DECIDED) {#d05-no-useoverlay-primitive}

**Decision:** Reject the proposal's `useOverlay({ role: "modal" | "companion" | "service" | "hint" })` universal primitive. Keep role-specific bindings (`useCompanionPopupBinding`, `useServicePopupBinding`, future variants) as the primary surface; the role taxonomy lives in documentation and component-authoring guidance, not in a shared hook signature.

**Rationale:** The seven existing overlay primitives — `TugSheet`, `TugAlert`, `TugPopover`, `TugConfirmPopover`, `TugTooltip`, `TugPopupMenu`, `TugContextMenu` — have wildly different gesture surfaces:

| Primitive | Trigger pattern |
|---|---|
| TugSheet | Imperative Promise hook (`showSheet().then(...)`) + ref handle + `<TugSheetTrigger>` |
| TugAlert | Radix `AlertDialog` controlled `open` / `onOpenChange` |
| TugPopover / TugConfirmPopover | Radix `Popover` `<Trigger asChild>` |
| TugTooltip | Radix `Tooltip` hover/focus driven |
| TugPopupMenu | Radix `DropdownMenu` `<Trigger asChild>` |
| TugContextMenu | Radix `ContextMenu` right-click trigger |

Forcing all of these through a single `useOverlay({ role })` signature would require the hook to internally dispatch between Promise-based, render-prop, hover-driven, and right-click patterns based on the role parameter. That is not abstraction — it is a switch statement masquerading as a primitive. The "abstraction" hides indirection costs (a layer to read past at every consumer) without simplifying any consumer.

What IS already shared across all primitives, and what does *not* need a `useOverlay({ role })`:

- **Portal target** — `useCanvasOverlay()` is the uniform answer.
- **Chain registration** — `useOptionalResponder()` is the uniform answer for surfaces that handle chain actions.
- **Refuse semantics on non-overlay markers** — already centralized in `responder-chain-provider.tsx`'s `FOCUS_REFUSE_SELECTOR` per [D01].
- **Chain-dismissal subscription pattern** — repeated five times across non-modal primitives (`TugPopover`, `TugConfirmPopover`, `TugTooltip`, `TugPopupMenu`, `TugContextMenu`). This is the *only* place where a small focused helper (e.g. `useChainDismissOnAction(open, setOpen)`) might pay rent. Whether to extract it can be decided when a sixth consumer surfaces or when a popup-bindings step touches the duplication; the decision does not need to be made here.

**The role taxonomy is documentation, not API.** A consumer authoring a new overlay primitive picks "modal" / "companion" / "service" / "hint" based on the question *"while this surface is open, where does the user expect their typing to go?"* (per [tugplan-tide-popup-bindings.md (#popup-role-taxonomy)]). That question selects a binding (`useCompanionPopupBinding`, `useServicePopupBinding`) and a portal target — not a shared hook signature.

**Implications:**
- `tugplan-tide-popup-bindings.md` Steps 4–5 land `useCompanionPopupBinding` and `useServicePopupBinding` as separate role-specific hooks. The framework plan does not introduce a unifying primitive.
- Any future "small extract" of duplicated patterns (e.g., `useChainDismissOnAction`) is a tactical refactor, not a framework primitive.
- The component-authoring guide names the four roles and points at the per-role binding for each — a documentation contract, not a code contract.

**Tuglaws cross-check:** [L19] — component-authoring guide entry on overlay role selection. No code changes in this plan; the decision constrains future API design.

#### [D06] `onClosed` is the close-settled boundary (DECIDED) {#d06-onclosed-is-settled}

**Decision:** Reject the proposal's `useOverlayLifecycle()` with separate `onClose` (state flip) vs. `onCloseSettled` (chain reconciled, focus restored) callbacks. The existing `onClosed` in `TugSheetContent` and the equivalent in other modal primitives already fires AFTER the chain has reconciled; no second callback is needed.

**Rationale:** Trace of the close sequence for `TugSheet` (the deepest case — exit animation + portal unmount + responder unregister + focus restore):

1. `close("cancel")` — promise resolves; dispatches `cancelDialog` to the sheet's responder via `sendToTarget`.
2. Sheet's `cancelDialog` handler — `setOpen(false)`.
3. React commits the open=false render. `mounted` is still true; the portal stays in the tree for the exit animation.
4. Exit-animation `useLayoutEffect` runs WAAPI: scrim fade + panel slide-out.
5. `g.finished.then(() => setMounted(false))` fires after the animation completes.
6. React commits the mounted=false render. The portal returns null; the sheet's DOM is removed.
7. `useOptionalResponder`'s effect cleanup runs: `manager.unregister(id)`.
8. `unregister`'s DOM-walk fallback promotes the nearest still-registered ancestor to first responder.
9. Radix's `FocusScope.onUnmountAutoFocus` fires: `triggerEl.focus()` restores focus to the trigger.
10. The `focusin` event fires; `ResponderChainProvider`'s `promoteOnFocusIn` runs; first responder is updated based on the trigger's DOM ancestry.
11. The `prevMountedRef → !mounted` `useLayoutEffect` fires: `onClosed?.()`.

By step 11 — when `onClosed` fires — every chain-relevant transition has completed: unregister, parentId-fallback promotion, focus restore, and focusin-driven first-responder update.

**The cancel-cascade bug was NOT a timing problem.** It was a first-responder-reliance problem. The consumer assumed that at `onClosed` time, `firstResponderId` would be the host pane (so `sendToFirstResponder({ CLOSE })` would walk to the pane's CLOSE handler). In reality, `firstResponderId` settles to *whatever* the focus restore + focusin promotion produces — which depends on focus history, FocusScope's restore target, and DOM ancestry — and is often something OTHER than the host pane. The fix in [D02] sidestepped first-responder state entirely by capturing the cascade target id at open time and dispatching via `sendToTarget`. No `onCloseSettled` callback could have helped, because there is no value of `firstResponderId` that consistently matches what the consumer wants.

**Implications:**
- `TugSheet`'s `onClosed` keeps its current contract: fires after the exit animation and DOM removal; the chain has reconciled by this point.
- Consumers that need a follow-up dispatch on close use the [D02] cascade-target pattern, NOT a hypothetical `onCloseSettled`.
- The lifecycle-callback API stays as it is; the framework does not introduce a `useOverlayLifecycle()` primitive.

**Tuglaws cross-check:** [L19] — module docstring for `TugSheet`'s `onClosed` is updated (in [Step 4](#step-4)) to cite [D06] / [D02] for the cascade pattern instead of suggesting consumers wait for a second callback.

#### [D07] Refuse-attribute behavior pair is intentionally bundled (DECIDED) {#d07-refuse-bundled}

**Decision:** Reject the proposal's third refuse-split (`data-tug-button-keep-editor-focus` separate from a chain-promotion-skip attribute). The two button-class behaviors that `data-tug-focus="refuse"` currently controls — chain-promotion-skip (`promoteOnPointerDown`) and browser-focus-prevention (`preventFocusOnMouseDown`) — are intentionally bundled. Every consumer wants both; splitting them would require every consumer to set both attributes, with no benefit.

**Rationale:** Audit of refuse consumers in production code:

| File | Use |
|---|---|
| `tug-button.tsx` | All chrome buttons |
| `tug-switch.tsx` | Toggle switches |
| `tug-checkbox.tsx` | Checkboxes |
| `tug-slider.tsx` | Sliders |
| `tug-option-group.tsx` | Option groups |
| `tug-choice-group.tsx` | Choice groups |
| `tug-tab-bar.tsx` | Tab buttons (×2 sites) |

Every consumer is a chrome control whose click should not perturb the active editor's focus. Both behaviors serve that single concept:

- *Chain-promotion-skip* prevents the click from making the button the chain's first responder (which would route subsequent keyboard shortcuts to the button instead of the editor).
- *preventDefault on mousedown* prevents the browser from moving the DOM `activeElement` to the button (which would blur the editor's contenteditable / input).

The two behaviors operate at two layers (chain registry vs. browser focus) but address one user goal: *"clicking a chrome control must not steal focus from where the user is typing."* Authoring an attribute that turns on only one half is incoherent — a button that takes browser focus but not chain promotion (or vice versa) is a bug, not a feature.

**The proposal's three-way split collapses to two real concepts:**
- *Structural overlay marker* — addressed by `data-slot="tug-canvas-overlay-root"` per [D01]. (Pane-focus-controller skip + canvas-overlay marker collapse to one attribute on one element.)
- *Button-class focus discipline* — addressed by `data-tug-focus="refuse"` per [D01]. (Chain-promotion-skip and browser-focus-prevention bundle as one concept.)

Both are done. No third attribute needs to exist.

**Implications:**
- `data-tug-focus="refuse"` keeps its dual-behavior semantics. Authors set the attribute and get both behaviors atomically.
- The component-authoring guide describes refuse as *one* concept ("this control should not perturb editor focus on click"), with the two implementation behaviors as collapsed implementation detail.
- Future contributors who notice the dual-behavior coupling and want to split it should re-read this decision and the audit before doing so.

**Tuglaws cross-check:** [L19] — `responder-chain-provider.tsx`'s `FOCUS_REFUSE_SELECTOR` JSDoc (already updated in [Step 1](#step-1)) describes the two-layer behavior as "one concept, two layers"; no further code change required.

### Deep Dives {#deep-dives}

#### Mental Model — the Five Subsystems {#mental-model}

This section is the canonical reference for *why* the overlay/focus/responder system behaves the way it does. Module docstrings reference this section; future plan authors read it before proposing changes.

> **2026 update (Tide picker redesign Step 9.6):** The Portals subsystem now distinguishes *pane-modal* surfaces (sheets, future modal-class surfaces) from *anchor-relative* and *app-modal* surfaces. Pane-modal surfaces portal into the host pane's frame element via `TugPaneFrameContext`, not into the canvas-overlay tier — modal scope IS the pane stacking context. The visual scrim for pane-modal surfaces is the pane's built-in scrim layer, raised via `useTugPaneScrim()`. Anchor-relative surfaces (popovers, tooltips) and the app-modal alert continue to portal into canvas-overlay. See [pane-model.md §Pane-modal vs canvas-overlay surfaces](../../tuglaws/pane-model.md#pane-modal-vs-canvas-overlay-surfaces) and [tugplan-tide-picker-redesign §D18, D19, D20, Step 9.6](../tugplan-tide-picker-redesign.md#step-9-6) for the full architectural narrative.

**The five subsystems, what each owns:**

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. PORTALS                                                       │
│    Owners: react-dom.createPortal, lib/use-canvas-overlay        │
│    Owns: where DOM lands relative to React position              │
│    Affects: where DOM events bubble FROM, where DOM walks land   │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼ (React tree unaffected by portal target)
┌──────────────────────────────────────────────────────────────────┐
│ 2. RESPONDER CHAIN                                               │
│    Owners: responder-chain.ts, use-responder.tsx                 │
│    Owns: registry of responders + first-responder + dispatch     │
│    Two walks (see [D03]):                                        │
│      • findResponderForTarget(node)  ← DOM walk via parentElement│
│      • walkFromNode(id)              ← chain walk via parentId   │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼ (focus events are one of several inputs)
┌──────────────────────────────────────────────────────────────────┐
│ 3. FOCUS EVENTS                                                  │
│    Owners: browser, responder-chain-provider's listeners         │
│    Owns: focusin/focusout dispatch                               │
│    Effect: chain provider's promoteOnFocusIn updates first       │
│      responder via findResponderForTarget                        │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼ (parallel to chain — DIFFERENT axis)
┌──────────────────────────────────────────────────────────────────┐
│ 4. PANE FOCUS CONTROLLER                                         │
│    Owners: pane-focus-controller.ts                              │
│    Owns: pane activation on click + canvas-background deselect   │
│    Independent from the chain — uses its own DOM walks           │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼ (consumed by all of the above)
┌──────────────────────────────────────────────────────────────────┐
│ 5. FOCUS DISCIPLINE MARKERS                                      │
│    Owners: HTML attributes on individual elements                │
│    After [D01]:                                                  │
│      • data-tug-focus="refuse"      → chain promotion skip       │
│      • [data-slot="tug-canvas-overlay-root"] → pane-controller   │
│      • data-no-activate             → pane-activation skip       │
└──────────────────────────────────────────────────────────────────┘
```

**Key interaction rules:**

1. **Portals do not change React tree ancestry.** A subtree portaled via `createPortal(jsx, target)` retains its React parent for context purposes. `ResponderParentContext` resolves to the consumer's React parent regardless of where the DOM lands.

2. **DOM walk and chain walk diverge for portaled subtrees.** A sheet portaled into the canvas overlay root has:
   - DOM ancestors: clip → canvas-overlay-root → body. *None* are registered responders.
   - React-tree ancestors (via context): card-host → pane → root. All registered.
   - `findResponderForTarget(sheetContent)` returns the sheet's own id (the responder element is the deepest match), or null if walking from a non-responder descendant.
   - `walkFromNode(sheetId)` walks card-host → pane → root via `parentId`.
   - **Use the right walk for the job.**

3. **First responder is set by multiple inputs:**
   - Auto-promotion at register time (root parent + null first responder).
   - Pointerdown / focusin promotion (DOM-walk-based, gated by focus discipline markers).
   - Explicit `makeFirstResponder(id)` calls.
   - Stale-focus re-promotion at registration (in `useOptionalResponder`, when `document.activeElement` is inside a newly-registered responder).
   - Unregister fallback (DOM walk first, then `parentId`).
   - When a modal closes, `firstResponderId` settles via the unregister fallback. **It may or may not match what the consumer expects.** Consumers that need to dispatch on close should not rely on first-responder state — use [D02]'s explicit cascade target.

4. **`data-tug-focus="refuse"` (post-[D01]) means exactly one thing:** *do not promote this element to first responder via pointerdown, and prevent the browser from moving focus to it via mousedown.* It is button-class behavior. It does *not* affect pane activation, pane deselect, dispatch, or chain registration.

5. **`pane-focus-controller`'s "skip canvas overlay" check (post-[D01])** uses `[data-slot="tug-canvas-overlay-root"]` directly, decoupled from focus refusal.

#### Sheet Cascade — why first-responder is wrong here {#sheet-cascade-rationale}

A sheet's `onClosed` consumer wants to dispatch a follow-up action ("close my host card", "save and apply", etc.). Today, `tide-card.tsx` does this via `manager.sendToFirstResponder({ CLOSE })`. The fragility:

- At the moment `onClosed` fires, `firstResponderId` is whatever the chain settled on after: sheet unregister → unregister fallback → FocusScope unmount → `triggerEl.focus()` → focusin handler → maybe-skipped-by-refuse promotion.
- That settled value is *usually* the card-host or pane (which would walk to the pane's CLOSE handler). Sometimes it's something else, depending on which DOM element was active when the sheet opened and what focus discipline markers it inherits.
- The consumer cannot easily reason about what `firstResponderId` will be at that moment. Bugs happen at the unhappy paths.

[D02]'s fix: consumer captures the cascade target id at open time (`cascadeTargetId`) and dispatches via `sendToTarget(target, ...)` on close. The dispatch walks `parentId` from a *known* node; first-responder state is irrelevant. The bug class disappears.

The principle generalizes: **whenever a modal's lifecycle ends and the consumer wants a follow-up dispatch, capture the target at open time, not at close time.**

#### Proposal Audit & Resolutions {#proposal-audit}

After Steps 1–4 landed, the user pushed back on the framework's scope: of the six primitives the original proposal called out, three were marked done, two partial, one unbuilt — and the partial/unbuilt items had been deferred with an "incremental as needs surface" framing that hid scope choices behind language about future discovery. Per the user's correction, the deferrals were re-examined to determine which were *genuine knowledge gaps* (legitimate to defer until consumer-side discovery) vs. which were *scope choices we could and should resolve now*.

The audit walks every original-proposal item, names the resolution, and records the analysis as decisions ([D05]–[D07]) so future contributors can argue against the recorded reasoning rather than re-litigating the same questions from scratch.

**Original proposal (verbatim, six items):**

> 1. `useOverlay({ role })` — universal hook for every overlay surface. role ∈ { "modal", "companion", "service", "hint" }. Returns the right portal target, refuse semantics, responder registration, focus discipline for that role.
> 2. Chain-walk single source of truth. Today `findResponderForTarget` (DOM) and the `parentId` walk (React context) coexist. Decide which is canonical for which use case and document it.
> 3. Disambiguated focus-discipline attributes. `data-tug-focus="refuse"` becomes three attributes with three names: `data-tug-pane-deselect-skip`, `data-tug-button-keep-editor-focus`, `data-tug-canvas-overlay-marker`.
> 4. `useOverlayLifecycle()` — explicit `onClose` (state flip) vs. `onCloseSettled` (chain reconciled, focus restored, safe to dispatch follow-up actions).
> 5. Modal close-cascade primitive. Modals that need to "close my consumer too" should hold a target id (passed at open time) and `sendToTarget(targetId, ...)`.
> 6. Documented invariants with tests.

**Resolutions:**

| # | Item | Status | Where addressed |
|---|------|--------|-----------------|
| 1 | `useOverlay({ role })` | NOT NEEDED | [D05] — role taxonomy is documentation; per-role bindings (`useCompanionPopupBinding`, `useServicePopupBinding`) are the right surface |
| 2 | Chain-walk single source of truth | NOT NEEDED | [D03] — the two walks answer different questions; both are canonical |
| 3 | Disambiguated focus-discipline attributes | DONE | [D01] (Step 1) — overlay-tier vs. button-class split shipped; [D07] formalizes that the button-class behavior pair stays bundled |
| 4 | `useOverlayLifecycle()` (onClose vs onCloseSettled) | NOT NEEDED | [D06] — `onClosed` already fires post-settle; the cancel-cascade bug was first-responder reliance, not timing |
| 5 | Modal close-cascade primitive | DONE | [D02] (Step 2) + adoption (Step 3) — `cascadeTargetId` + `sendToTarget` shipped |
| 6 | Documented invariants with tests | DONE | [D04] (Step 4) — I1–I6 documented in `responder-chain.ts` + 17 passing tests |

**Why three "NOT NEEDED" verdicts hold up.** Each one comes from concrete examination, not from time-budget hedging:

- *useOverlay({ role })* — see [D05]. The seven existing overlay primitives have wildly different gesture surfaces (Promise hook, render-prop trigger, hover, right-click). Forcing them through one signature would be a switch statement masquerading as a primitive. The shared parts (`useCanvasOverlay`, `useOptionalResponder`, refuse semantics) are already centralized; the unshared parts (per-role bindings) are intentionally separate.
- *Chain-walk unification* — see [D03]. DOM walk answers "what responder owns this physical position?" Registry walk answers "what's the conceptual handler hierarchy?" Portals make these intentionally diverge. Unifying loses information.
- *useOverlayLifecycle()* — see [D06]. The chain DOES reconcile by `onClosed` time. The bug class the proposal targeted is fixed by [D02]'s capture-at-open-time pattern, not by adding a second lifecycle callback.

**Why one "DONE" item ([D07] / [D03]) was originally marked partial.** My earlier assessment of [D01] as a "partial" disambiguation was wrong — the proposal's three-way split collapses to two real concepts, both of which shipped. [D07] now formalizes that the two button-class behaviors are intentionally one concept.

My earlier assessment of [D03] as a "partial" walk-unification was also wrong — the proposal asked us to *decide* which walk is canonical, and we did decide: *both, for different jobs*. That is a complete decision, not a deferral.

**Conclusion.** Of the six proposal items, three shipped in Steps 1–4, three are explicitly resolved as not-needed in [D05]–[D07], and zero require new code primitives. The framework is functionally complete for `tugplan-tide-popup-bindings.md` Steps 3–8.

`tugplan-tide-popup-bindings.md` Step 3 introduces `ResponderNode.focus` and `manager.focusResponder(id)` — chain-level capabilities that Steps 4–5 consume. Those additions live in the popup-bindings plan and grow the chain's surface there; the framework plan acknowledges them and points at popup-bindings Step 3 for design and tests. (The framework's [D04] invariants block does not re-state the focus-callback contract; popup-bindings Step 3's docstring discipline owns that surface.)

#### Tuglaws Cross-Check Plan {#tuglaws-cross-check}

The framework adheres to:

- [L02] — no new external state introduced into React; chain state stays accessed via the existing manager.
- [L06] — no React `style={{}}` props for appearance; no anchor coords or visual state in React state.
- [L07] — closure-stable refs where consumer-supplied callbacks need decoupling.
- [L11] — controls emit actions; responders handle. The cascade target API is a chain-native dispatch surface.
- [L19] — component authoring guide gains entries for: focus discipline attributes (per [D01]), modal cascade target pattern (per [D02]), the dual-walk policy (per [D03]).
- [L24] — no new ephemeral state; `cascadeTargetId` is a value captured in the consumer's closure (local-data zone).

### Specification {#specification}

#### Public API Changes {#public-api}

**`<CanvasOverlayRoot />`** (canvas-overlay-root.tsx):
- Removes `data-tug-focus="refuse"` attribute.
- Keeps `data-slot="tug-canvas-overlay-root"` (already present, unchanged).

**`pane-focus-controller.ts`** line 191:
- Selector changes from `[data-tug-focus="refuse"]` to `[data-slot="tug-canvas-overlay-root"]`.
- Comment updated to explain the decoupling.

**`responder-chain-provider.tsx`** `isFocusRefusing` selector:
- Selector unchanged: `[data-tug-focus="refuse"]`.
- Semantics narrowed (per [D01]): now exclusively for chain promotion + browser focus prevention.
- Comment updated accordingly.

**`useTugSheet().showSheet(options)`** in tug-sheet.tsx:
- `ShowSheetOptions` gains optional `cascadeTargetId?: string`. The hook stores it on the active state for documentation/future use; it does not change `useTugSheet`'s own dispatch behavior. Consumers reference their own captured id in their `onClosed` closure.

**`tide-card.tsx`** `presentSheet`:
- Passes `cascadeTargetId: hostStackId` in `showSheet` options.
- `onClosed` switches from `manager?.sendToFirstResponder({ CLOSE, ... })` to `manager?.sendToTarget(hostStackId, { CLOSE, ... })`.

#### Internal Architecture {#internal-architecture}

**`responder-chain.ts`** gains a top-of-file `INVARIANTS:` block listing I1–I6 (per [D04]).

**New test file** `responder-chain-invariants.test.ts` covers I1–I6.

**`tug-sheet.tsx`** module docstring gains a section on cascade-target pattern, linking to this plan's [Sheet Cascade](#sheet-cascade-rationale) deep dive.

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| Path | Purpose |
|------|---------|
| `tugdeck/src/__tests__/responder-chain-invariants.test.ts` | Unit tests for I1–I6 |

#### Symbols to add / modify {#symbols}

| Symbol | File | Change |
|--------|------|--------|
| `<CanvasOverlayRoot />` JSX attributes | `tugdeck/src/components/chrome/canvas-overlay-root.tsx` | Remove `data-tug-focus="refuse"` |
| `pane-focus-controller.ts` line 191 selector | `tugdeck/src/components/chrome/pane-focus-controller.ts` | Change selector to `[data-slot="tug-canvas-overlay-root"]` |
| `ShowSheetOptions` interface | `tugdeck/src/components/tugways/tug-sheet.tsx` | Add `cascadeTargetId?: string` field |
| `presentSheet` callback | `tugdeck/src/components/tugways/cards/tide-card.tsx` | Pass `cascadeTargetId: hostStackId`; switch dispatch to `sendToTarget` |
| `INVARIANTS:` comment block | `tugdeck/src/components/tugways/responder-chain.ts` | Add at top of file |

### Documentation Plan {#documentation-plan}

- This plan's [Mental Model](#mental-model) deep dive is the canonical reference.
- Module docstrings updated to link here:
  - `responder-chain.ts` (top-of-file invariants block).
  - `use-responder.tsx` (note about React-context `parentId` vs DOM walk).
  - `canvas-overlay-root.tsx` (note about disambiguated attrs).
  - `tug-sheet.tsx` (note about cascade-target pattern, linking to [Sheet Cascade](#sheet-cascade-rationale)).

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

- **Unit tests for I1–I6:** asserted in `responder-chain-invariants.test.ts`. Each invariant is a small, orthogonal test case.
- **Regression test for cancel-cascade:** existing tide-card behavior — picker cancel closes host pane — covered by an existing app-test path or, if missing, added as a unit test that mocks the picker setup and asserts `store.handlePaneClosed` (or equivalent) is invoked after sheet cancel.
- **Existing tug-sheet unit tests:** all 13 must continue to pass (preserve list).

### Execution Steps {#execution-steps}

#### Step 1 — Disambiguate focus-discipline attributes {#step-1}

**References:** [D01], (#mental-model)

**Artifacts:**
- `canvas-overlay-root.tsx` — remove `data-tug-focus="refuse"`. Update docstring comment.
- `pane-focus-controller.ts` — change selector at line 191 to `[data-slot="tug-canvas-overlay-root"]`. Update inline comment.
- `responder-chain-provider.tsx` — update `FOCUS_REFUSE_SELECTOR` JSDoc to explicitly document the narrowed semantics.

**Tasks:**
- [x] Remove `data-tug-focus="refuse"` from `<CanvasOverlayRoot />` JSX.
- [x] Update the canvas-overlay-root.tsx docstring comment that explained the refuse attribute — replace with a note about [D01]'s disambiguation and a pointer to (#mental-model).
- [x] In `pane-focus-controller.ts`, change `if (startEl.closest('[data-tug-focus="refuse"]')) return;` to `if (startEl.closest('[data-slot="tug-canvas-overlay-root"]')) return;`. Update the inline comment to explain the decoupling.
- [x] In `responder-chain-provider.tsx`, the `FOCUS_REFUSE_SELECTOR` constant's JSDoc gets a "see [D01]" reference and a one-line summary of the narrowed semantics.

**Tests:**
- [x] Existing `tug-popover.test.tsx`, `tug-context-menu.test.tsx`, `tug-popup-menu.test.tsx`, `tug-tooltip.test.tsx`, `tug-alert.test.tsx`, `tug-sheet.test.tsx` continue to pass without modification. (These tests use the body-fallback overlay-root path and don't depend on the refuse attribute.) Also reran `pane-focus-controller.test.tsx`, `responder-chain.test.ts`, `responder-chain-unregister-recovery.test.tsx`, `responder-chain-r1-invariant.test.tsx`, `use-responder.test.tsx` (98 tests) — all green.
- [x] Add a unit test asserting that a click on a `<CanvasOverlayRoot />` descendant no longer matches the `closest('[data-tug-focus="refuse"]')` selector. (Sanity check that the disambiguation took effect.) — `src/__tests__/canvas-overlay-root-disambiguation.test.tsx`

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green.
- [x] `bun run audit:tokens lint` exits 0.
- [x] Manual smoke: open a TugPopover; clicking inside doesn't trigger a deselect on the host pane (peer-card stays activated). Open the picker sheet; clicking Cancel closes the sheet (animation plays).

#### Step 2 — Modal cascade target API {#step-2}

**Depends on:** #step-1

**References:** [D02], (#sheet-cascade-rationale)

**Artifacts:**
- `tug-sheet.tsx` — `ShowSheetOptions` gains `cascadeTargetId?: string`. The hook stores it on `UseTugSheetState`. Module docstring gains a section on the cascade pattern.

**Tasks:**
- [x] Add `cascadeTargetId?: string` to `ShowSheetOptions` interface.
- [x] Update `useTugSheet`'s state and `showSheet` to thread the value through (stored on `UseTugSheetState` for parity with other options; not consumed by the hook itself in this step). — `state.options` already typed as `ShowSheetOptions`, so the field threads automatically via the type extension; no behavioral code change needed in the hook.
- [x] Update `useTugSheet` JSDoc with a section on the cascade-target pattern, linking to (#sheet-cascade-rationale).
- [x] Update tug-sheet.tsx top-of-file docstring with a one-liner pointing at (#mental-model).

**Tests:**
- [x] Existing `tug-sheet.test.tsx` tests pass unchanged. — 13 prior tests still pass; full suite now 16 pass / 0 fail.
- [x] Add a unit test: pass `cascadeTargetId` to `showSheet`, observe that the option round-trips through the hook (the value is stored on the active state). — added 3 tests under `describe("useTugSheet – cascadeTargetId option")`: lifecycle preservation, canonical [D02] consumer-closure round-trip, and clean state replacement on a second `showSheet` with a different id.

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green.

#### Step 3 — Tide-card adopts cascade target; cancel-cascade fixed {#step-3}

**Depends on:** #step-2

**References:** [D02]

**Artifacts:**
- `tide-card.tsx` — `presentSheet` passes `cascadeTargetId: hostStackId`; `onClosed` uses `sendToTarget(hostStackId, ...)`.

**Tasks:**
- [x] In `presentSheet`, add `cascadeTargetId: hostStackId` to the `showSheet` options. — implemented as `cascadeTargetId: cardId`. The picker has `cardId` directly in scope (no extra plumbing); `cardId` is also stable across cross-pane moves while pane `stackId` changes (per `card-host.tsx:1412`). The chain walk from `cardId` traverses one `parentId` hop to `hostStackId`/`stackId`, where `TUG_ACTIONS.CLOSE` is registered (`tug-pane.tsx:724`) — same handler is reached either way. The choice is documented in the inline comment.
- [x] In the `onClosed` callback, change `manager?.sendToFirstResponder(...)` to `manager?.sendToTarget(hostStackId, ...)`. — implemented as `manager?.sendToTarget(cardId, ...)` per the rationale above.
- [x] Update inline comment to explain why `sendToTarget` (per [D02]).

**Tests:**
- [x] Existing tide-card-related tests pass. — 13 prior tests pass; full tide-card test file now 15 pass / 0 fail.
- [x] Add a unit test (or extend an existing one) asserting that after cancel-dispatch + animation completion, the chain receives a `sendToTarget` call against the pane id with action `CLOSE`. Mock `manager.sendToTarget` to verify. — added T-TIDE-08 (cancel-cascade fires `sendToTarget(CARD_ID, { CLOSE })`, lands on registered handler, does NOT use `sendToFirstResponder`) and T-TIDE-08b (selecting "Open" does NOT trigger the cascade, gating-on-result invariant preserved). Spy wraps `manager.sendToTarget` and `manager.sendToFirstResponder`; pre-registered card responder verifies the walk reaches its terminus.

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green.
- [x] **Manual smoke:** open a Tide card, click Cancel on the picker. The card closes (the cancel-cascade bug from Step 2 of `tugplan-tide-popup-bindings.md` is fixed).

#### Step 4 — Document invariants in code; add invariant tests {#step-4}

**Depends on:** #step-3

**References:** [D03], [D04], (#mental-model)

**Artifacts:**
- `responder-chain.ts` — top-of-file `INVARIANTS:` block listing I1–I6 with one line each.
- New `responder-chain-invariants.test.ts` file with a test per invariant.
- Module docstring updates in `use-responder.tsx`, `canvas-overlay-root.tsx`, `tug-sheet.tsx` — link to this plan's mental model.

**Tasks:**
- [x] Add `INVARIANTS:` block at the top of `responder-chain.ts`. Six lines, one per invariant. — block expands each invariant with a short rationale plus a pointer to (#mental-model) and the invariants test file.
- [x] Create `tugdeck/src/__tests__/responder-chain-invariants.test.ts` with six describe blocks (one per invariant) and assertions:
  - [x] **I1** — register a responder with `parentId` = unregistered id; verify the chain warns or rejects (depending on existing semantics). — chain tolerates the dangling reference (does not throw, walk terminates with `handled === false`); test pins this tolerance.
  - [x] **I2** — register, set first responder, unregister, observe `firstResponderId` is null or another registered id. — covers fresh manager (null), single root (auto-promoted), root unregister (null), child first-responder unregister (null OR registered ancestor).
  - [x] **I3** — register two responders A → B; with `firstResponderId = null`, `sendToTarget(A, ...)` walks A → B regardless. — also covers unrelated-tree firstResponder (sendToTarget from disjoint subtree still walks correctly) and unregistered target (throws).
  - [x] **I4** — register a responder; `findResponderForTarget(an inner DOM node)` returns the responder's id; `findResponderForTarget(a node outside)` returns null. — covers descendant lookup, nested-responder deepest-match, no-ancestor null, and stale-attribute null.
  - [x] **I5** — register A; portal a subtree (containing a different responder C) elsewhere; `sendToTarget(A, ...)` from inside C's subtree still works. — pane → card-host → portaled-modal topology; verifies `findResponderForTarget` returns the modal (DOM-walk axis) but `sendToTarget(card-host)` still reaches the pane handler (parentId axis).
  - [x] **I6** — assert `[data-tug-focus="refuse"]` does not affect pane-focus-controller behavior (per [D01]). Stub mocks pane-focus-controller's input and verifies the right selector path. — three assertions covering refuse-without-overlay, overlay-without-refuse, and disjoint-targets demonstrate that the two selectors gate distinct element sets.
- [x] Update `use-responder.tsx` docstring with a section on `parentId` source (React context) and a link to (#mental-model). — added "Where `parentId` comes from (and why portals matter)" section explaining the context-vs-DOM divergence and the explicit `options.parentId` override pattern.
- [x] Update `canvas-overlay-root.tsx` docstring to point at [D01] and (#mental-model). — added "Focus-discipline disambiguation" section in the `@module` block plus a "Framework decisions" entry citing `tugplan-tide-overlay-framework.md` [D01].
- [x] Update `tug-sheet.tsx` top-of-file docstring with a "see (#mental-model) for the system-level architecture" pointer. — already added in Step 2 as a top-of-file `@see` pointer.

**Tests:**
- [x] All six invariant tests pass. — `responder-chain-invariants.test.ts`: 17 pass / 0 fail (2 + 4 + 3 + 4 + 1 + 3 across I1–I6).

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green. — full suite 2690 pass / 0 fail across 159 files.
- [x] `bun run audit:tokens lint` exits 0.
- [x] Code-review pass: every modified module's docstring has a link to (#mental-model) where it touches framework concerns. — `responder-chain.ts` (INVARIANTS block + bottom pointer), `use-responder.tsx` (parentId section), `canvas-overlay-root.tsx` (focus-discipline section + framework decisions), `tug-sheet.tsx` (top-of-file `@see`).

#### Step 5 — Proposal audit; record [D05]–[D07]; close out framework {#step-5}

**Depends on:** #step-4

**References:** [D05], [D06], [D07], (#proposal-audit)

**Context:** After Steps 1–4 landed, the framework's scope was challenged: of the six primitives the original proposal called out, three shipped, three were marked partial/unbuilt with an "incremental as needs surface" framing. Per the user's correction (recorded in `feedback_no_time_budgets.md`), the deferrals were re-examined to determine which were genuine knowledge gaps vs. scope choices that could be resolved now. Step 5 records the resolution as durable decisions so the framework's scope is honestly accounted for.

**Artifacts:**
- `dash/tugplan-tide-overlay-framework.md` — three new design decisions [D05] (no `useOverlay({ role })`), [D06] (`onClosed` is the close-settled boundary), [D07] (refuse-attribute behavior pair stays bundled). New deep-dive section (#proposal-audit) walks every original-proposal item and records its resolution.

**Tasks:**
- [x] Audit `data-tug-focus="refuse"` consumers (8 chrome controls + the chain provider); confirm the two button-class behaviors (chain-promotion-skip + browser-focus-prevention) are intentionally bundled. Record as [D07].
- [x] Audit the seven existing overlay primitives (`TugSheet`, `TugAlert`, `TugPopover`, `TugConfirmPopover`, `TugTooltip`, `TugPopupMenu`, `TugContextMenu`); confirm their gesture surfaces do not unify under one hook signature; record as [D05]. Note that the `observeDispatch` chain-dismissal pattern is duplicated five times across non-modal primitives — flag for possible future tactical extraction (`useChainDismissOnAction`) as a small focused helper, not a framework primitive.
- [x] Trace the close sequence for `TugSheet`; confirm that `onClosed` fires AFTER unregister + parentId-fallback promotion + `FocusScope.onUnmountAutoFocus` + `focusin`-driven first-responder update. Confirm the cancel-cascade bug class was first-responder reliance (fixed by [D02]), not timing. Record as [D06].
- [x] Re-examine [D03]'s "both walks are canonical" against the proposal's "decide which is canonical." Confirm DOM walk and `parentId` walk answer different questions and unifying loses information. No revision required; cite in (#proposal-audit) resolution table.
- [x] Audit `tugplan-tide-popup-bindings.md` Steps 3–8 for any framework-primitive needs that Steps 1–4 did not cover. Confirm: Step 3's `ResponderNode.focus` + `manager.focusResponder` belong to popup-bindings (chain-capability addition with full design and tests in that plan); Steps 4–5's bindings (`useCompanionPopupBinding`, `useServicePopupBinding`) consume the framework but do not require new framework primitives.
- [x] Author (#proposal-audit) deep dive: walks every original-proposal item with status (DONE / NOT NEEDED), resolution decision pointer, and analysis. Acknowledge the corrected scope-choice-vs-knowledge-gap framing.
- [x] Add [D05]–[D07] to the Design Decisions section.
- [x] Update Strategy section's "Out of scope" wording to point at (#proposal-audit) instead of the original "broader refactors can land incrementally" framing.

**Tests:**
- [x] No new tests. The audit produces decisions (text), not code.

**Checkpoint:**
- [x] `bun x tsc --noEmit` green (re-run; documentation-only changes preserve build).
- [x] `bun test` green (re-run; documentation-only changes preserve tests).
- [x] `bun run audit:tokens lint` exits 0 (re-run; no token changes).
- [x] All six original-proposal items have a recorded resolution: three shipped (Steps 1–4), three explicitly NOT NEEDED ([D05], [D06], [D07]), zero deferred to "as needs surface."
- [x] `tugplan-tide-popup-bindings.md` Step 3 footnoted in (#proposal-audit) — its `ResponderNode.focus` / `manager.focusResponder` additions are owned by that plan, not the framework.

---

### Tuglaws Cross-Check {#tuglaws-cross-check-summary}

This plan's compliance:

- [L02] — no new external state; chain manager unchanged; `useSyncExternalStore` not introduced or modified.
- [L06] — no React `style={{}}` for appearance; no React state for visual properties.
- [L07] — closure stability preserved via existing `useCallback` in `presentSheet`.
- [L11] — controls dispatch via `sendToTarget`; responders handle. The cascade pattern is L11-aligned.
- [L19] — module docstrings updated; component-authoring-guide entries added.
- [L23] — preserves all user-visible behavior except the cancel-cascade bug being fixed.
- [L24] — no new ephemeral state; `cascadeTargetId` is a value captured in the consumer's closure (local-data zone, on the consumer's React state machinery).

No L01, L03, L13, L14, L17, L20, L22, L25 implications — the framework is contract-level, not appearance, animation, token, or store-observation work.
