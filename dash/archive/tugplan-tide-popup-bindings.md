<!-- tugplan-skeleton v2 -->

## Tide Card Polish — Popup-to-Responder Bindings {#tide-popup-bindings}

**Purpose:** Generalize the canvas overlay tier to cover every popup-class primitive (Radix popovers, popup menus, context menus, tooltips, sheets), then close the long-standing gap between `manager.makeFirstResponder(id)` (chain-state only) and DOM focus by giving every responder an optional `focus()` callback. On that foundation, ship two binding hooks — `useCompanionPopupBinding` for popups that live only while their owner is first responder (file completion), and `useServicePopupBinding` for popups that take focus while open and restore the prior responder on close (font picker → editor return).

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | tugplan-tide-popup-bindings |
| Last updated | 2026-05-02 |
| Roadmap anchor | extends [tugplan-tide-overlay-tier.md](./tugplan-tide-overlay-tier.md) |
| Predecessor | [tugplan-tide-overlay-tier.md](./tugplan-tide-overlay-tier.md) — landed 2026-04-30; introduced `<CanvasOverlayRoot />`, `useCanvasOverlay`, `--tug-z-overlay-*` tokens, completion popup migration |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The just-landed `<CanvasOverlayRoot />` plan stopped the file-completion popup from being clipped by the prompt pane. Three follow-up issues remain visible in the running app and were explicitly punted by that plan's non-goals:

1. **Sheets get visually clipped by their owning card.** The "Open Project" sheet — and any future sheet whose content is taller than the card's content area — has its bottom buttons sliced off by the card frame, because `TugSheetContent` portals into `TugPanePortalContext` (the card root) rather than the canvas overlay root.

2. **Radix-based popups don't share the canvas overlay tier.** `TugPopover`, `TugPopupMenu`, `TugContextMenu`, `TugTooltip`, and `TugAlert` portal directly to `document.body` via Radix's default. They escape pane clipping today (so they look "fine"), but they do not participate in our z-index tier, do not share a future multi-deck overlay surface, and are inconsistent with the completion popup's portal target.

3. **Popups don't have a clean relationship to first responder.**
   - The file-completion popup does not dismiss when its owning editor loses first-responder status mid-session (e.g., the user clicks the font picker while typeahead is active). It only observes the coarse `cardDidDeactivate` signal.
   - The font picker dismisses correctly, but focus does not return to the editor — the user's next keystroke beeps because Radix's default `onCloseAutoFocus` returns focus to the trigger button.
   - The underlying machinery to fix both is in the chain manager, but the manager's `makeFirstResponder(id)` only mutates chain state; it does not touch DOM focus. This is a long-standing gap that has been worked around case-by-case.

This plan generalizes the overlay tier (Issue #1, #2) and closes the focus gap with reusable bindings (Issue #3) so future popup-class primitives inherit the right behavior structurally rather than via card-level hacks.

#### Strategy {#strategy}

- **Three layers, each independently shippable.** Layer A is mechanical (portal target swaps + sheet anchor math). Layer B introduces the focus contract and the two binding hooks. Layer C wires defaults so consumers get the right behavior without reading docs. Each layer has its own commits and verification gate.
- **The overlay tier becomes universal for popup-class.** Every popup primitive — Radix-wrapped or hand-rolled — portals into `<CanvasOverlayRoot />`. Sheets keep their card-modal *behavior* (inert + focus trap + restore-to-trigger) but render on the canvas tier so they can extend past the card frame.
- **First-responder gets a focus contract.** `ResponderNode` grows an optional `focus()` callback. `ResponderManager` grows one new method: `focusResponder(id)` (chain-state + DOM focus together). Existing call sites continue to compile; the new contract is opt-in. (An earlier draft also added `observeFirstResponder`; per [D04] / [D05] it was dropped because companion observes DOM focus, not first-responder, and no other consumer in this plan motivates it.)
- **Two binding hooks codify the two popup roles.** `useCompanionPopupBinding` watches DOM focus on the owner element and dismisses when focus leaves. `useServicePopupBinding` captures prior first responder on open and restores it on close via Radix's `onCloseAutoFocus` preventDefault path. Each hook is small and consumes only the new manager API plus DOM events.
- **Defaults make the right thing free.** `TugPopupButton` defaults to service semantics. The completion overlay opts into companion. Future popups pick the role at the call site by which hook they call; no new vocabulary, no global flag.
- **Tuglaws cross-checked at every step.** [L02] (DOM-focus and pointerdown signals observed directly via DOM events; structure-zone state held in refs, not React state), [L03] (every subscription installs in `useLayoutEffect`; service binding's pointerdown listener installs imperatively at popup-open and removes at popup-close), [L06] (DOM focus is appearance state observed directly; sheet anchor coords written via direct DOM, not React `style={{}}`), [L07] (consumer callbacks held in refs for closure stability), [L11] (popup ↔ responder relationships are first-class signals; no new chain actions), [L19] (component authoring; new hooks documented per the guide), [L22] (store-observer-API style for layout/focus signals), [L23] (sheet migration preserves every user-visible behavior; companion replacement is a strict superset of `cardDidDeactivate`), [L24] (state-zone classifications explicit per decision).
- **Build stays green at every commit.** `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` pass on every step. Warnings are errors.

#### Success Criteria (Measurable) {#success-criteria}

- **Sheet escapes its card.** Opening a sheet whose content is taller than the card produces a sheet whose `getBoundingClientRect()` extends below the card's bottom edge while remaining card-modal (`.tug-pane-body` of the owning card has `inert`). Verified by app-test.
- **All popup-class primitives portal to the canvas overlay root.** `Popover`, `DropdownMenu` (root + sub), `ContextMenu`, `Tooltip`, `AlertDialog`, the editor's hand-rolled context menu, and the migrated `TugSheet` all portal into `<CanvasOverlayRoot />` (or `document.body` fallback when the root is not registered). Verified by `grep` + unit tests.
- **`manager.focusResponder(id)` brings DOM focus in sync with chain state.** Calling `focusResponder(editorId)` makes `editorId` the first responder *and* moves `document.activeElement` to the editor's contentDOM (or the responder's registered focus target). Verified by unit test.
- **Companion popup auto-dismisses on first-responder change.** Open `@` completion in the editor, click the font picker; the completion popup is gone within the same tick. Verified by app-test.
- **Service popup restores focus to the prior responder on close.** Open `@` completion to put focus on editor; click font picker, choose a font; document.activeElement returns to the editor's contentDOM, and the next keystroke types into the editor. Verified by app-test.
- **Popups inside sheets stack above the sheet.** Open a sheet containing a `TugPopupButton`; click the trigger; the popup menu visually overlays the sheet content; clicks land on the popup, not on the sheet beneath. Verified by app-test per [D09] / [Q01] visual confirmation.
- **No card-level hacks.** Neither the editor card nor the sheet card carries a custom `onCloseAutoFocus` override or a card-scoped popup-dismiss listener after this plan lands. Verified by `grep` audit at Step 8.
- `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` (workspace) green at every step.

#### Scope {#scope}

1. **Universal canvas overlay tier for popup-class.** Pass `container={useCanvasOverlay()}` to every Radix `*.Portal` site (`Popover.Portal`, `Tooltip.Portal`, `ContextMenuPrimitive.Portal`, `DropdownMenuPrimitive.Portal` root + sub, `AlertDialog.Portal`). Migrate `tug-editor-context-menu.tsx`'s `createPortal(..., document.body)` to the canvas overlay root.
2. **`TugSheet` rendering on canvas overlay tier.** `TugSheetContent` reads `cardEl` (already does), uses it for `inert` write *and* for `getBoundingClientRect()` to position the sheet on the canvas overlay tier. `ResizeObserver` re-anchors. Animation transforms continue to drive `translateY` on the sheet content.
3. **`ResponderNode.focus` contract.** Optional `focus(): void` callback registered alongside the responder node. Default fallback: `el.focus()` on the element with `data-responder-id`, or its first tabbable descendant if that element is not focusable.
4. **`ResponderManager.focusResponder(id)`.** New public method. Calls `makeFirstResponder(id)` and then invokes the responder's `focus()` callback (or the default DOM-walk fallback). Closes the long-standing chain-state ↔ DOM-focus gap.
5. **`useCompanionPopupBinding`.** Hook in `tugways/`. Args: `{ ownerEl: HTMLElement | null, onShouldDismiss: () => void }`. Subscribes to document `focusout` / `focusin` (capture phase); calls `onShouldDismiss` when `document.activeElement` leaves `ownerEl`'s subtree (after a microtask defer per [D05]).
6. **`useServicePopupBinding`.** Hook in `tugways/`. Returns `{ onCloseAutoFocus: (e: Event) => void, captureOnOpen: () => void }`. Captures `manager.getFirstResponder()` at the moment of open; on close, if the captured responder is still registered AND the popup retained focus through to close, calls `e.preventDefault()` + `manager.focusResponder(captured)`.
7. **Wire bindings into existing primitives.** `CompletionOverlay` consumes `useCompanionPopupBinding` (replacing the existing `cardDidDeactivate` subscription). `TugPopupMenu`, `TugPopover`, `TugContextMenu` consume `useServicePopupBinding` and pass its `onCloseAutoFocus` into Radix.
8. **Editor responder registers a `focus()` callback.** `TugTextEditor`'s responder registration passes `() => view.focus()` so `manager.focusResponder(editorId)` brings the contentDOM into focus correctly.
9. **`TugPopupButton` defaults to service semantics by virtue of using `TugPopupMenu`.** No additional config. Document the rare-case `companion` opt-in for future popups whose own content is the focus target.
10. **Tuglaws walkthrough.** Add a section to `tuglaws/component-authoring.md` codifying "popups choose a responder role: companion (auto-dismiss when owner loses focus) or service (capture/restore prior responder)." Update `tuglaws/app-test-inventory.md` with new app-tests.

#### Non-goals (Explicitly out of scope) {#non-goals}

- A multi-deck overlay-root implementation. The single-root invariant from the predecessor plan stays; this plan adds consumers, not topology.
- Migrating app-banner-class primitives (`TugBanner`, `TugAlert`, `TugBulletin`) onto the overlay tier. Banner-class is intentionally above the overlay tier (z-index 99000+) so a connection-loss banner overlays a completion popup. Stays untouched.
- Pane-internal stacking (`tug-pane.css`, `tug-tab-bar.css`, `tug-choice-group.css`, etc.). Local-stacking literals stay; not popup-class.
- A "popover sub-popup" model where opening a service popup from inside a companion popup keeps both alive. Out of scope; today's behavior (the service popup dismisses the companion) is desired.
- Integrating Radix `FocusScope`'s focus-trap config. This plan changes which element is focused on close, not whether focus is trapped while open.
- Changing the typeahead state shape, the completion painter, or the editor's responder id. Layer B builds *on* the existing chain manager.
- A new vocabulary action for "dismiss companion popup." The companion binding observes a signal and calls a consumer-supplied callback (`cancelCompletion(view)` for the editor); no chain hop required.
- Completion overlay z-tier elevation when nested inside a sheet. Editors are rarely embedded in sheets in current usage; if a consumer surfaces, add a `--tug-z-overlay-completion-in-dialog` token and a `tug-completion-in-dialog` class consumer in `CompletionOverlay`. Out of scope for this plan.
- A `skipRestore()` opt-out on the service binding for consumers who want both "redirect focus on close" and "the binding does nothing" simultaneously. Risk R02 documents the deferral.
- A `TugAlert`-in-sheet z-tier (`--tug-z-overlay-alert-in-dialog`). No current consumer; defer.

#### Dependencies / Prerequisites {#dependencies}

- The just-landed [tugplan-tide-overlay-tier.md](./tugplan-tide-overlay-tier.md): `<CanvasOverlayRoot />`, `useCanvasOverlay`, `--tug-z-overlay-*` tokens, `canvas-overlay-registry`. This plan extends them; no rework.
- Existing `ResponderManager` API surface in `responder-chain.ts`: `firstResponderId`, `makeFirstResponder`, `resignFirstResponder`, `getFirstResponder`, `firstResponderIsAtOrBelow`, `observeKeyResponder`, `subscribe`. This plan adds one method (`focusResponder(id)`); existing methods are unchanged.
- Existing Radix primitives in `tugdeck/node_modules/@radix-ui/`: confirmed in [#radix-portal-survey] that `Popover`, `DropdownMenu`, `ContextMenu`, `Tooltip`, `Dialog`, `AlertDialog` all accept `container?: PortalProps['container']` and (where applicable) `onCloseAutoFocus`.
- Existing `--tug-chrome-height` token (default 36px) referenced by `tug-sheet.css:39, 50` and declared in `tug-pane.tsx:66, 441`. Used for sheet anchor math.
- Existing `CompletionOverlay` in `tug-text-editor.tsx:1846` with its `useCardId` + `cardDidDeactivate` subscription. Layer B replaces the card-deactivate path with `useCompanionPopupBinding`.

#### Constraints {#constraints}

- **Tuglaws** [L02], [L03], [L06], [L11], [L19], [L22], [L23] apply. See [#tuglaws-cross-check].
- **No warnings** (`-D warnings` enforced workspace-wide).
- **HMR is always running**: never run a manual tugdeck build (`feedback_hmr` memory).
- **Use bun, not npm**: every tooling invocation is `bun ...` (`feedback_use_bun` memory).
- **No mock-store assertion tests**: tests dispatch through the real store / real editor view (`feedback_no_mock_store_tests` memory).
- **happy-dom test scoping**: layout-fidelity tests (sheet escape, anchor accuracy, focus assertions across React renders) MUST be app-tests in a real browser (`feedback_no_happy_dom_tests` memory).
- **app-test recipes use `just app-test <file>`** (`feedback_just_app_test` memory).
- **No plan numbers in code** (`feedback_no_plan_numbers_in_code` memory).
- **Cross-check tuglaws before tugdeck/tugways work** (`feedback_tuglaws_cross_check` memory).

#### Assumptions {#assumptions}

- The `pointerdown` + `preventDefault()` focus-retention contract validated in the predecessor plan's [Q01] / [D08] (resolved 2026-04-30) holds for all popup-class items, not just completion-menu items. Layer B's service binding uses the same contract on its way out, so a failure here is a regression of that contract — not a new risk.
- Radix's `onCloseAutoFocus` fires reliably across `DropdownMenu`, `ContextMenu`, `Popover`, `Dialog`, `AlertDialog`. Confirmed via type signatures in [#radix-portal-survey]; the runtime semantics match across these primitives because they all wrap `@radix-ui/react-focus-scope`'s `FocusScope` with identical `onUnmountAutoFocus` plumbing.
- The card's `getBoundingClientRect()` is layout-stable for the duration of a sheet session except for explicit user actions (window resize, sash drag). `ResizeObserver` on the card element catches both. A future "card auto-relayout while sheet is open" workflow is out of scope.
- Calling `view.focus()` on a CodeMirror `EditorView` is idempotent and safe regardless of caret state (CM6 documented behavior). The editor's responder `focus()` callback is `() => view.focus()`.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows [tuglaws/tugplan-skeleton.md §reference-conventions](../tuglaws/tugplan-skeleton.md#reference-conventions). Key points:

- All execution-step anchors are kebab-case `step-N`.
- Design decisions use `dNN-...` slugs.
- `**References:**` lines cite specific decisions, specs, and section anchors — never line numbers.
- `**Depends on:**` lines cite step anchors, never titles or numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Sheet z-stacking against peer-card title bars (DECIDED — option a) {#q01-sheet-z-stacking}

**Question:** Today the sheet's `translateY(-100%)` enter animation makes it visually emerge from *under* its owning card's title bar (via `.tug-sheet-clip`'s `top: var(--tug-chrome-height)`). On the canvas overlay tier, the sheet renders at canvas-fixed coordinates. Peer cards' title bars are below the new overlay tier (peer cards are descendants of the inner `containerRef`; the overlay tier sits as a sibling above per [D07] of the predecessor plan). So the sheet emerging from the active card's title bar will *also* visually overlay any peer card's title bar that the sheet's bounding rect passes over.

**Why it matters:** A user with two cards in a vertical stack opens a sheet on the upper card. The sheet's panel extends downward past the upper card's bottom edge — and visually crosses the lower card's title bar. Today (sheet inside the card), this can't happen because the sheet is clipped to the card. After migration, it can.

**Resolution:** Option (a) — accept. Sheet on canvas tier always paints above peer cards. Matches macOS sheet semantics: when a sheet is open on one window, peer windows' chrome reads as recessed visually. The sheet remains card-modal in *behavior* (only the owning card's `.tug-pane-body` is `inert`); peer cards remain interactive at the level of their non-overlapped chrome.

**Implications:** [Step 2](#step-2)'s app-test asserts the sheet's bounding rect extends past the owning card's bottom edge; manual smoke confirms peer-card overlay reads as visually acceptable. No fallback sub-step needed.

#### [Q02] Service binding's "should restore" predicate {#q02-service-restore-predicate}

**Question:** When a service popup closes (e.g., user picks a font from the picker), `useServicePopupBinding` needs to decide whether to restore the captured prior first responder or let Radix do its default (focus the trigger button). Two close paths:
- (i) User picked an item / pressed Escape / clicked outside: focus is still inside the popup at close time → restore prior.
- (ii) User clicked elsewhere (a peer button, another card): an external click promoted some other responder *before* the popup's close cascade fired → do NOT restore prior; the user has moved on.

**Why it matters:** Always-restore is wrong (case ii); never-restore is wrong (case i — the original bug). The predicate must distinguish.

**Options:**
- **(a) Compare captured to current at close.** If `manager.getFirstResponder() === capturedPriorId`, no responder change happened (popup never registered as a responder, or the trigger's parent did and is still active) → restore is a no-op anyway. If different AND the current responder is *outside the popup's expected scope*, do not restore. Requires "popup's expected scope" — i.e., the trigger's ancestor responder.
- **(b) Track whether external pointerdown fired since open.** A document-level pointerdown listener flags "external click happened." On close, if flag is set, do not restore. Simpler predicate; doesn't depend on responder topology.
- **(c) Restore unconditionally; depend on Radix's onCloseAutoFocus not firing on pointerdown-outside dismissals.** Radix may already short-circuit on outside-click — needs verification.

**Plan to resolve:** [Step 5](#step-5) implements option (b) (simple, predictable, no topology assumptions). Resolution recorded in [D07].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Sheet anchor goes stale on card move/resize | high | low | Three observers drive the same direct-DOM applier — `ResizeObserver` (size), `MutationObserver` on `cardEl[style]` *and* `cardEl.parentElement[style]` (position via drag-driven style mutation), window `resize` (viewport shifts); [L06] / [L22] compliant | Manual smoke shows lag during pane drag, sash drag, or window resize |
| Service binding's restore conflicts with consumer-supplied `onCloseAutoFocus` | med | med | Hook owns `onCloseAutoFocus` per [D06]; consumer override path documented in module docstring (call `manager.focusResponder(target)` from menu-item handler before close, not via `onCloseAutoFocus`) | A consumer ships a stacked `onCloseAutoFocus` and breaks the binding |
| Companion dismiss races with click-to-accept | med | low | Companion observes DOM focus on `view.contentDOM`; clicking a portaled completion-popup item does NOT blur contentDOM (the predecessor's [D08] established `pointerdown` + `preventDefault()` keeps focus on the editor across the portal hop). Add an app-test that opens completion, clicks an item, asserts the popup remained visible long enough for the accept to land | App-test fails the ordering assertion |
| `focus()` callback fires when responder element is detached | low | low | `focusResponder(id)` re-checks `nodes.has(id)` before invoking the callback; default fallback queries `document.querySelector('[data-responder-id="X"]')` and skips on null | Detached-element warning in console |
| TugSheet's animation transform breaks under canvas-tier rendering | med | med | Animation transforms drive `translateY` on the sheet content panel within a fixed-positioned wrapper; wrapper coords are direct-DOM-written, panel transform is animation-local — they target different DOM elements and never collide. Verified by [Step 2](#step-2) preserve-list test on `tug-animator` | Enter/exit animation visibly snaps |
| Radix `container` prop semantics differ for nested portals (sub-menus) | low | low | Confirmed in [#radix-portal-survey]: `MenuSubContent` extends `MenuContentImplProps` minus `onCloseAutoFocus` but includes `container`. Sub-menu portal accepts the same overlay root | Sub-menu fails to render after migration |
| Popup-in-sheet stacking missed by an author who forgets the context consumer | med | low | Authoring-guide entry per [Step 7](#step-7) is the documentation gate; the Step 5 unit tests verify each migrated primitive consumes `TugSheetStackingContext`; the Step 8 symbol-inventory diff catches missing consumers | A new popup-class primitive lands without consuming the context |
| Companion `focusout` predicate fires spuriously on in-subtree focus transitions | med | low | Hook defers `document.activeElement` check by one microtask per [D05]; an in-subtree blur-then-focus sequence reads stable post-transition `activeElement` (still inside `ownerEl`) — no false dismiss. Unit-tested explicitly | Spurious dismiss observed in app-test |

**Risk R01: Sheet anchor goes stale on card move/resize** {#r01-sheet-anchor-stale}

- **Risk:** The sheet's canvas-tier coordinates are computed from `cardEl.getBoundingClientRect()` at open time. If the card moves (drag), resizes (sash, window resize, programmatic), the sheet's coords no longer match.
- **Mitigation:** Three observers drive the same direct-DOM applier:
  1. `ResizeObserver` on `cardEl` — fires on size changes (sash drag, programmatic resize).
  2. `MutationObserver` on `cardEl` *and* `cardEl.parentElement` (the outer `.tug-pane` element) with `attributeFilter: ["style"]` — pane drag in `tug-pane.tsx`'s drag handler mutates `frame.style.left/top` on the outer `.tug-pane`; that's a *position* change `ResizeObserver` does not see. Observing both cardEl and its parent insulates the contract from future drag-handler refactors that might target a different level.
  3. `window.addEventListener("resize", apply)` — viewport-relative coord shifts when the window itself resizes.
- **Why not just `ResizeObserver`:** `RO` only fires on size changes. Pane drag changes position with size unchanged — the original mitigation was wrong; the implementation now uses the trio above.
- **Residual risk:** A nontrivial transform on an ancestor (e.g., `transform: scale()` applied to the deck container) could shift coordinates without firing any of the three signals. Acceptable — no such transform exists today; flag for revisit if it lands. A rAF coalesce loop is the bigger hammer for that case.

**Risk R02: Service-binding restore conflicts with consumer override** {#r02-service-binding-conflict}

- **Risk:** A future consumer of `TugPopupMenu` wants its own `onCloseAutoFocus` (e.g., to focus a specific element after close). Per [D06] the binding owns `onCloseAutoFocus` internally — a consumer cannot override it without a binding-level escape hatch.
- **Mitigation:** Document the contract in the hook's module docstring per [L19]: "service binding owns close-focus restoration. Consumers wanting custom close behavior should call `manager.focusResponder(targetId)` directly inside the menu-item handler before close, NOT via `onCloseAutoFocus`. The order of operations is: menu-item handler runs (consumer dispatches and optionally calls `focusResponder`); blink animation completes; Radix unmounts content; service binding's `onCloseAutoFocus` runs; if the consumer redirected focus to a non-prior responder, the binding's external-click predicate would have observed it (the click triggered a responder change), and the binding skips restore." Verified by a Step 5 unit test for the consumer-override-via-focusResponder path.
- **Residual risk:** A consumer who *needs* both "redirect focus to X on close" AND "have the binding silently restore prior responder" simultaneously has no clean answer. Defer a `skipRestore()` opt-out to a follow-up plan if a consumer surfaces.

---

### Design Decisions {#design-decisions}

> Record *decisions* (not options). Each decision includes the "why" so later phases don't reopen it accidentally.

#### [D01] All popup-class primitives portal to the canvas overlay root (DECIDED) {#d01-universal-overlay-tier}

**Decision:** Every popup-class primitive — `TugPopover`, `TugConfirmPopover`, `TugPopupMenu` (root + sub), `TugContextMenu`, `TugTooltip`, `TugAlert`, `TugSheet`, the editor's `tug-editor-context-menu` — passes its portal `container` prop to `useCanvasOverlay()`. No primitive portals to `document.body` directly.

**Rationale:**
- Single tier semantics: every popup shares z-index ordering, lifecycle (overlay-root unmount cancels all), and future multi-deck topology.
- Eliminates the inconsistency where the completion popup uses one tier and Radix popups use another.
- Mechanical change per call site; the overlay tier already body-falls-back when the root is unregistered (test environments), so no test breakage.

**Implications:**
- 7 Radix portal sites + 1 hand-rolled portal (`tug-editor-context-menu.tsx`) get the same one-line change.
- The `<CanvasOverlayRoot />`'s `pointer-events: none` + child `pointer-events: auto` model is already correct for all consumers; no DOM changes needed.
- A future popup-class primitive opts in by calling `useCanvasOverlay()` — no global registry change.

#### [D02] TugSheet renders on canvas tier; modal/inert behavior stays card-scoped (DECIDED) {#d02-sheet-canvas-tier}

**Decision:** `TugSheetContent` portals into `useCanvasOverlay()` instead of `TugPanePortalContext`. The `inert` write on `.tug-pane-body` continues to use `cardEl` (read from `TugPanePortalContext`, which keeps its current contract). Sheet coordinates are computed from `cardEl.getBoundingClientRect()` and **applied via direct DOM writes on two ref-held canvas-tier elements — never via React `style={{}}` props or component-state updates**. The two elements split previously-coupled concerns: `.tug-sheet-anchor` (the wrapper) hosts the scrim and is sized to the card body; `.tug-sheet-clip` (a sibling, not a descendant) hosts the panel and extends from the card body top down to the viewport bottom. Three observers (`ResizeObserver` on `cardEl`, `MutationObserver` on `cardEl` *and* its parent `.tug-pane`, and a window `resize` listener) drive the same applier so size changes, drag-driven position changes, and viewport changes all re-anchor.

**Rationale:**
- The user-visible bug is "the sheet is clipped by the card." The card-modal *behavior* (inert + focus trap + restore-to-trigger) is correct as-is; only the rendering target is wrong.
- Reading `cardEl` for both inert and rect keeps a single ownership relationship: "the sheet belongs to a card; that card is the inert target and the position anchor."
- **Two elements, two responsibilities.** Coupling scrim-extent and panel-extent through one container's bounds is what made the original card-portaled sheet clip in the first place. Splitting them is the load-bearing structural change: the wrapper bounds the dim region (scrim must not bleed past the pane); the clip's `overflow: hidden` hides the panel during enter animation while letting the panel's natural height extend past the card per [Q01].
- **Direct DOM write per [L06]:** the anchor coords are *appearance-zone* state — only the renderer reads them, no non-rendering consumer cares whether `top` is `100px` or `120px`. [L06] forbids putting such state in React. The L06 test ("does any non-rendering consumer depend on this state?") returns *no* for sheet anchor coords; therefore they belong in the DOM.
- **Three observers per [L22], not just one.** `ResizeObserver` fires on size changes only; pane drag in `tug-pane.tsx`'s drag handler mutates `frame.style.left/top` on the outer `.tug-pane` (ref `frameRef`), which is a *position* change `RO` does not see. `MutationObserver` on `cardEl[style]` *and* `cardEl.parentElement[style]` catches the drag-style mutations regardless of which level the handler targets. A window `resize` listener catches viewport-relative shifts. All three call the same applier; DOM writes happen directly, not via React state, avoiding the "render → paint → effect" lag that would visibly trail card drags by a frame.

**Implications:**
- The sheet's `top: var(--tug-chrome-height)` CSS shift moves from "relative to the card root" (today) to "computed in TS at mount and on every observed change, written via `wrapperRef.current.style.top = ${cardRect.top + chromeHeight}px` and `clipRef.current.style.top` to the same value."
- The sheet's animation transform (`translateY(-100%)` enter / `translateY(0)` settle) drives a relative offset *within* the clip. The wrapper's position is `position: fixed` with direct-DOM-written top/left/width/height (height = card body); the clip's position is `position: fixed` with top/left/width matching the wrapper but height extending to the viewport bottom; the panel's transform is local within the clip. None collide because they target different DOM elements.
- `.tug-sheet-overlay` (the scrim) is a child of the wrapper and fills it via `inset: 0`, so the scrim is clipped to the pane (the user-visible "shadow" stays inside the card). The `inert` write on `.tug-pane-body` covers the user-input dead-zone; the visible scrim is purely visual feedback.

**Preserve list per [L23]:** The migration is a *minimal mutation* per [L23] (the React subtree that owns sheet state never unmounts; only the portal target changes). Concretely, every user-visible behavior on this list MUST survive the migration unchanged, asserted explicitly in [Step 2](#step-2)'s tests:

- `defaultOpen`, the `componentStatePreservationKey` capture/restore protocol, the imperative `useTugSheet().showSheet()` API, and the `TugSheetHandle.open()/close()` ref handle (no shape change).
- `FocusScopeRadix.FocusScope` trap (`trapped={open}`), `onMountAutoFocus` and `onUnmountAutoFocus` semantics including the existing `onOpenAutoFocus` consumer override at `tide-card.tsx:1190`.
- The `inert` attribute on `.tug-pane-body` of the owning card; cleanup on unmount.
- The chain-native `cancelDialog` close path: `useOptionalResponder` registration with `responderId`; `manager.sendToTarget(responderId, ...)` from Escape / Cmd+. handlers; `useTugSheetClose` hook.
- The `tug-animator` enter/exit animation: overlay `opacity 0→1 / 1→0`, content `translateY(-100%)→0 / 0→-100%`, the `setMounted(false)` on `g.finished`, and the `onClosed` post-animation hook.
- Restore-focus-to-trigger via `triggerElRef.current?.focus()` in `handleUnmountAutoFocus`.
- The `senderId` round-trip used by `useTugSheet`'s `observeDispatch` subscription to differentiate Escape-dismissal from explicit-close.

**State-zone classification per [L24]:** anchor coords are *appearance* (DOM); `cardEl` is *structure* (read from context, held in closure); `responderRef` and `responderId` are *structure* (registration metadata); `mounted`/`open` React state remains *local data* (component-scoped, no externalization).

#### [D03] ResponderNode gains optional `focus()` callback (DECIDED) {#d03-responder-focus-callback}

**Decision:** The `ResponderNode` interface (defined in `responder-chain.ts`) gains an optional `focus?: () => void` field. Responders that own a non-trivial focus surface (CM6 editor, future custom editors) supply the callback at registration. Generic responders omit it.

**Rationale:**
- DOM focus and chain first-responder are conceptually different things, but they should travel together for the common case. A focus callback declared per-responder is the cleanest place to put substrate-specific knowledge ("how do I focus myself?").
- DOM-walk fallback ("query `[data-responder-id=X]` and focus its first tabbable descendant") works for HTML inputs out of the box but requires special-casing for `contenteditable` and shadow-DOM hosts. An explicit callback avoids the special-cases and gives substrates a single source of truth.
- The callback is *optional*. Adding it does not change any existing call site; only `TugTextEditor`'s registration adds `focus: () => view.focus()` in this plan.

**Implications:**
- `ResponderNode.focus?: () => void` is added to the type. All existing registrations compile unchanged.
- `manager.focusResponder(id)` (see [D04]) calls `node.focus?.()` if defined; otherwise walks the DOM and focuses the first tabbable element under `[data-responder-id=X]`.
- `useResponder` and `useOptionalResponder` accept a `focus` option that is forwarded into the `ResponderNode`.

#### [D04] ResponderManager gains `focusResponder(id)` (DECIDED) {#d04-manager-focus-responder}

**Decision:** One new public method on `ResponderManager`:

```ts
focusResponder(id: string): void
// 1. If id is not registered, no-op (and dev-mode warn).
// 2. Else: this.makeFirstResponder(id).
// 3. Then: invoke node.focus?.() if defined, else fall back to
//    document.querySelector(`[data-responder-id="X"]`)?.focus()
//    (or its first tabbable descendant if the element itself is not focusable).
```

**Rationale:**
- `makeFirstResponder` + manual `el.focus()` at every restore site duplicates logic; `focusResponder` is the single primitive that closes the long-standing gap between chain-state and DOM focus.
- The method is public on the manager, so it is reachable via `useResponderChain()` from any component.
- An earlier draft of this plan also added `observeFirstResponder(callback)` for the companion binding. Per [D05]'s revision, the companion binding observes DOM focus (not first-responder), so no consumer in this plan motivates `observeFirstResponder`. Per [L19] component-authoring discipline (don't add unused primitives), it is dropped from scope. If a future need arises (programmatic responder change without DOM focus change), it is a thin one-step addition over the existing `subscribe()` API.

**Implications:**
- New method lands on the `ResponderManager` class in `responder-chain.ts`.
- DOM-walk fallback in `focusResponder` is exercised when no `focus` callback is registered; behavior is "best-effort focus the responder's element."
- The fallback walker checks the element itself for focusability before walking descendants — this prevents focusing a child input when the responder's own element is the intended focus target (e.g., a wrapper div with `tabindex="0"`).

**State-zone classification per [L24]:** the new method only mutates *structure-zone* state (chain identity, DOM focus). It does not touch React state and is not a candidate for `useSyncExternalStore` consumption.

#### [D05] Companion binding observes DOM focus on the owner element (DECIDED) {#d05-companion-predicate}

**Decision:** `useCompanionPopupBinding({ ownerEl, onShouldDismiss })` observes DOM focus on `ownerEl`. When `document.activeElement` is no longer inside `ownerEl`'s subtree, the hook calls `onShouldDismiss()`. The signal is the browser's `focusout` event on `ownerEl` plus a deferred `document.activeElement` check (to ride past the brief focus-transition window when focus is in flux between two siblings).

**Rationale:**
- An earlier draft of this decision used `manager.firstResponderIsAtOrBelow(ownerResponderId)` as the predicate. That fails in the central motivating case. With the existing `TugButton` discipline — `data-tug-focus="refuse"` (skips `pane-focus-controller`'s responder promotion) + `suppressButtonFocusShift` (skips native focus shift on mousedown) — clicking a service-popup trigger does NOT change first responder. The editor remains first responder through the entire popup interaction, so a first-responder predicate would never fire and the companion popup would never dismiss. **The bug stated in the original report is that the file completion popup does not dismiss when the user clicks the font menu** — exactly this case.
- The signal that *is* changing in the broken case is DOM focus: Radix's `FocusScope.onMountAutoFocus` grabs focus into the menu content when the popup opens, blurring `contentDOM`. That blur is observable via `focusout` on the editor's owner element.
- The user's stated mental model — "while its associated component if first responder **and has the keyboard focus**" — names two signals. DOM focus is the one whose change in this case actually corresponds to "the user is no longer working in this component." First responder is the wrong abstraction here precisely because the existing discipline (correctly) keeps first responder pinned to the editor.
- **Per [L06]:** DOM focus is browser-owned appearance-zone state — only the renderer cares whether `document.activeElement` is on contentDOM or a menu item. The L06 test ("does any non-rendering consumer depend on this state?") returns *no* for the focus-position signal, so observing the DOM directly is the right shape. The companion binding does NOT mirror DOM focus into React state; it imperatively calls `onShouldDismiss` on the transition.
- **Per [L22]:** browser focus events are the equivalent of a store-observer-API for DOM-focus state. The hook subscribes via `useLayoutEffect` and dispatches a side-effect; no React render cycle is interposed.
- **Per [L23]:** DOM focus is user-visible state that the binding observes but does not own. The binding does not move focus on its own; it only signals when the owner has lost it. The `cancelCompletion(view)` consumer (the editor's existing dispatch path) remains the canonical owner of "what to do when companion should dismiss."
- **Subsumes the old `cardDidDeactivate` signal correctly:** when a peer card is activated, focus leaves the previously-active card's editor (DOM focus moves to the new card or its first focusable child), so the `focusout` predicate fires. The new signal is strictly finer-grained than the old one — every case the old signal caught, the new signal also catches; the new signal additionally catches the in-card service-popup case.

**Implications:**
- Hook signature change: `useCompanionPopupBinding({ ownerEl: HTMLElement | null, onShouldDismiss: () => void })`.
- `CompletionOverlay` passes `editor.contentDOM` (or the editor host element — TBD at implementation time based on which yields the cleanest `focusout` semantics under CodeMirror's internal focus management).
- The hook MUST defer the `document.activeElement` check past the current event loop turn (a microtask) before firing `onShouldDismiss`. Reason: a focus-transition between two children of the same logical owner can fire `focusout` on the owner before `focusin` fires; reading `activeElement` synchronously inside `focusout` may see `body` (the transient state). A microtask defer reads stable post-transition `activeElement`. This is the standard pattern for "owner lost focus" detection.
- Out-of-provider tolerance: `ownerEl === null` (e.g., during initial mount before refs settle) → hook no-ops until ownerEl is non-null. Matches existing tolerance patterns.

**State-zone classification per [L24]:** the predicate's last-value memoization (was-focused-inside?) lives in a ref — *structure* zone. The DOM-focus signal itself is *appearance* zone (browser-owned). The `onShouldDismiss` callback drives external mutation (e.g., `cancelCompletion`), which is *structure* zone (editor field state). No new React state introduced.

#### [D06] Service binding owns `onCloseAutoFocus` for popup primitives (DECIDED) {#d06-service-onclose-ownership}

**Decision:** `useServicePopupBinding()` returns `{ onCloseAutoFocus, captureOnOpen }`. Popup primitives (`TugPopupMenu`, `TugPopover`, `TugContextMenu`) call `captureOnOpen()` in their `onOpenChange` (when `next === true`) and pass `onCloseAutoFocus` to Radix's content prop. The hook is the single owner of close-focus behavior for service popups.

**Rationale:**
- Centralizing close-focus in one place means the predicate from [Q02] is implemented once.
- Consumers of the popup primitives (gallery cards, future call sites) do not deal with `onCloseAutoFocus` at all — the primitive owns it. This is the same shape as how `TugPopupMenu` already owns the `onSelect` blink animation.
- A consumer who needs custom close behavior calls `manager.focusResponder(targetId)` directly inside their menu-item handler before close, sidestepping `onCloseAutoFocus` entirely (R02).

**Implications:**
- `TugPopupMenu`, `TugPopover`, `TugContextMenu` each gain an internal `useServicePopupBinding()` call. Existing consumer call sites do not change shape.
- `tide-card.tsx:1190`'s `onOpenAutoFocus` override (a sheet pattern) is unaffected — that's an *open* focus override, not a close override. Sheets remain a separate primitive.

#### [D07] Service-binding restore predicate: external-pointerdown flag, imperative install/uninstall ([Q02] resolves to option b) (DECIDED — pending Step 5 verification) {#d07-service-restore-predicate}

**Decision:** `useServicePopupBinding` installs a document-level `pointerdown` listener (capture phase) **imperatively** in `captureOnOpen()` and removes it **imperatively** in `onCloseAutoFocus()`. While installed, the listener flags "external click happened" iff the pointerdown's target is NOT a descendant of `useCanvasOverlay()`'s registered root (i.e., the click is outside any popup). On close (Radix's `onCloseAutoFocus`), if the flag is set, the hook does NOT preventDefault and does NOT call `focusResponder` — Radix's default close-focus path runs. A guard `useLayoutEffect` removes any still-installed listener on hook-component unmount.

**Rationale:**
- Topology-free: doesn't require knowing the trigger's responder ancestor or walking responder parents.
- Captures the user-intent distinction directly: "did the user click outside any popup before this close fired?"
- `pointerdown` (not `click`) so it fires before Radix's outside-click dismiss path; the flag is set in time for the close to consult it.
- **Imperative install/uninstall preserves [L02] and [L03] without a redundant `useState` mirror.** An earlier draft of this decision proposed driving a `useLayoutEffect` keyed on `capturedRef.current`, which would not re-run (refs don't trigger re-renders). The "fix" — mirroring `captured` into `useState` — would inject React-render machinery into pure subscription state, which serves no rendering purpose ([L02] forbids "useState + manual sync" of external state). Imperative `addEventListener` / `removeEventListener` keyed off the lifecycle calls (`captureOnOpen` / `onCloseAutoFocus`) is the correct shape — the listener is structure-zone state ([L24]), not React state.
- The unmount-guard `useLayoutEffect` provides the [L03] cleanup discipline for the edge case where the consumer component unmounts while a popup is still open (e.g., the gallery card unmounts mid-popup). The guard removes the listener so it does not leak past the consumer's lifetime.

**Implications:**
- The hook holds three refs ([L24] *structure* zone): `capturedRef: { current: string | null }` (the captured prior responder), `externalClickRef: { current: boolean }` (the flag), `listenerRef: { current: ((e: PointerEvent) => void) | null }` (the installed handler, so we can remove it later).
- `captureOnOpen()` writes all three refs, calls `document.addEventListener("pointerdown", listener, { capture: true })`.
- `onCloseAutoFocus()` calls `document.removeEventListener("pointerdown", listenerRef.current, { capture: true })` and clears `listenerRef.current = null` BEFORE evaluating the restore predicate. Order matters: removing first prevents the listener from firing on a synthesized pointerdown emitted by Radix's own close-cascade (defensive — Radix is not known to do this, but the ordering eliminates the race entirely).
- `useCanvasOverlay()` is the boundary because *every* popup-class primitive lives there post-[D01]. A click on any popup is "inside the overlay tier." Clicks on the deck canvas (outside any popup) are "external."

**Resolution:** DECIDED pending [Step 5](#step-5) verification — the predicate is a closed-form rule, but the app-test for "click outside dismisses without focus restore" must pass before [D07] is final.

#### [D08] TugPopupButton inherits service semantics through TugPopupMenu (DECIDED) {#d08-popup-button-defaults}

**Decision:** No new prop or config on `TugPopupButton`. The component already composes `TugPopupMenu`, which gains the service binding internally per [D06]. Service semantics propagate through composition.

**Rationale:**
- The simpler API surface: consumers don't choose a "role" at the call site.
- The font picker (the motivating bug in image 5) becomes correct with no changes to `gallery-text-editor.tsx`.
- A future popup-class primitive that needs *companion* semantics calls `useCompanionPopupBinding` directly at its consumer site (the editor does this for completion). The asymmetry is acceptable: companion is the rare role, service is the common one.

**Implications:**
- `gallery-text-editor.tsx`'s font picker, size picker, line-height picker, letter-spacing picker all behave correctly post-[D06] without local changes.
- `TugPopupButton`'s docstring documents that it inherits service semantics from `TugPopupMenu`.

#### [D09] Popups nested inside a sheet stack above the sheet via context-driven tier elevation (DECIDED) {#d09-popup-in-dialog-tier}

**Decision:** Sheets provide a React context (`TugSheetStackingContext`) signalling "a sheet is in scope." Popup-class primitives that consume `useCanvasOverlay()` for their portal target also consume this context; when inside a sheet, they apply elevated z-tier tokens via a CSS class on the portaled content element. Two new tokens land in `chrome.css`:

```css
:root {
  --tug-z-overlay-popup-in-dialog: 9500;  /* TugPopover, TugConfirmPopover, completion overlay (rare in sheets) */
  --tug-z-overlay-menu-in-dialog:  9600;  /* TugPopupMenu, TugContextMenu */
}
```

**Rationale:**
- **The bug.** Layer A migrates every popup-class primitive to the canvas overlay root (`<CanvasOverlayRoot />`). Sheets land at `--tug-z-overlay-dialog: 9400`. Popups land at `--tug-z-overlay-popup: 9200` / `--tug-z-overlay-menu: 9300`. Without elevation, a `TugPopupButton` rendered inside a sheet would have its menu **stack BEHIND the sheet** because both portal to the same overlay root and tokens decide ordering. Today this works (popups portal to body, sheet's z-stack is local) — Layer A would silently break it.
- **Stacking-context isolation isn't viable for this case.** Sheets and popups portal OUT of their consumer subtree to the canvas overlay root, so they're DOM siblings. CSS `isolation: isolate` on the sheet doesn't capture popups that aren't its DOM descendants. Token-driven elevation is the only mechanism that doesn't require restructuring the portal target.
- **Context propagation, not portal redirection.** Popups continue to portal to the canvas overlay root (preserves [D01]'s "single tier" semantics). The elevation is a z-token swap based on context, not a different portal target. Visually correct stacking; structurally consistent.
- **Two tokens preserve the existing menu-above-popup ordering inside dialogs.** `menu-in-dialog` (9600) > `popup-in-dialog` (9500) mirrors the canvas-tier ordering `menu` (9300) > `popup` (9200). Consumers writing a popover that opens a popup menu inside a sheet get the same relative stacking as outside a sheet.
- **Service binding's external-click predicate is unaffected.** The pointerdown listener checks "is target inside the canvas overlay root?" — popups inside sheets are still inside the overlay root, so the predicate continues to identify them as "popup clicks" (not external). Sheet content is also inside the overlay root post-[D02]; clicks on sheet content are also "internal" — which is correct: closing a service popup by clicking on the surrounding sheet should NOT restore prior responder (the user's intent is to keep working in the sheet, not return to the editor below).

**Implications:**
- New file: `tugdeck/src/components/tugways/tug-sheet-stacking-context.ts` exporting `TugSheetStackingContext` (boolean, default `false`).
- `TugSheetContent` wraps its rendered content (inside the portal) with `<TugSheetStackingContext.Provider value={true}>`.
- `TugPopupMenu`, `TugPopover`, `TugContextMenu`, `CompletionOverlay` each consume the context. When `true`, they add a class (e.g., `tug-popup-in-dialog`, `tug-menu-in-dialog`) to their portaled content element. CSS rules in `tug-popover.css` / `tug-menu.css` / `tug-completion-menu.css` map these classes to the elevated tokens via `var(--tug-z-overlay-*-in-dialog)`.
- `TugTooltip` does not consume the context — tooltips are hover-only, never opened from buttons inside a sheet in a way that requires elevation. Acceptable; [Step 5](#step-5) verifies via spot check.
- `TugAlert` is itself dialog-class; if an alert opens *inside* a sheet (a confirmation alert from a sheet's "Save" button), the alert needs to stack above the sheet. We add a third dialog-elevation token only if a consumer needs it; today no such case exists in the codebase (`rg "TugAlert" tugdeck/src/components/tugways/cards/` returns no in-sheet usages). Out of scope; flag in the plan's non-goals if a consumer surfaces.

**Risk surface:** the context-based mechanism quietly does the right thing only if every popup-class primitive remembers to consume the context. The component-authoring guide entry in [Step 7](#step-7) makes this explicit and the symbol-inventory diff at [Step 8](#step-8) verifies coverage.

**State-zone classification per [L24]:** `TugSheetStackingContext` is *structure* zone (component identity / hierarchy signal, propagated through React context — the canonical structure-zone mechanism per [L24]'s definition). The CSS class application is *appearance* zone (DOM mutation via class-name swap, which is React-controlled here only because the class itself is determined by context value at render time — no ephemeral state involved).

---

### Deep Dives {#deep-dives}

#### Radix Portal Survey {#radix-portal-survey}

Confirmed via `tugdeck/node_modules/@radix-ui/*/dist/index.d.ts`:

| Primitive | `container` prop | `onCloseAutoFocus` prop | Notes |
|-----------|------------------|------------------------|-------|
| `Popover.Portal` | yes | yes | direct |
| `Tooltip.Portal` | yes | n/a | tooltips don't manage close-focus |
| `Dialog.Portal` | yes | yes | direct |
| `AlertDialog.Portal` | yes | yes | inherits Dialog |
| `DropdownMenu.Portal` | yes (via `MenuPrimitive.Portal`) | yes | root content; sub-content omits `onCloseAutoFocus` |
| `ContextMenu.Portal` | yes (via `MenuPrimitive.Portal`) | yes | same as DropdownMenu |

**Migration call sites:**

| File | Line | Site |
|------|------|------|
| `tug-popover.tsx` | 456 | `<Popover.Portal>` (covers `TugPopover` + `TugConfirmPopover`) |
| `tug-alert.tsx` | 310 | `<AlertDialog.Portal>` |
| `tug-tooltip.tsx` | 305 | `<Tooltip.Portal>` |
| `tug-context-menu.tsx` | 238 | `<ContextMenuPrimitive.Portal>` |
| `internal/tug-popup-menu.tsx` | 343 | `<DropdownMenuPrimitive.Portal>` (root) |
| `internal/tug-popup-menu.tsx` | 308 | `<DropdownMenuPrimitive.Portal>` (sub-menu) |
| `tug-editor-context-menu.tsx` | 526 | `createPortal(..., document.body)` (hand-rolled) |
| `tug-sheet.tsx` | 527 | `createPortal(..., cardEl)` (TugPanePortalContext) → migrating to canvas tier |

#### ResponderNode Focus Contract {#focus-contract}

**Today** (`responder-chain.ts`):

```ts
interface ResponderNode<Extra extends string = never> {
  id: string;
  parentId: string | null;
  el: HTMLElement;
  kind?: ResponderKind;
  actions: Partial<Record<TugAction | Extra, ActionHandler>>;
  // ... no focus callback
}
```

**Migrated:**

```ts
interface ResponderNode<Extra extends string = never> {
  id: string;
  parentId: string | null;
  el: HTMLElement;
  kind?: ResponderKind;
  actions: Partial<Record<TugAction | Extra, ActionHandler>>;
  focus?: () => void;  // NEW — optional substrate-supplied focus
}
```

**`focusResponder` implementation sketch:**

```ts
focusResponder(id: string): void {
  const node = this.nodes.get(id);
  if (!node) {
    if (import.meta.env?.DEV) {
      console.warn(`[ResponderManager] focusResponder("${id}") — node not registered.`);
    }
    return;
  }
  this.makeFirstResponder(id);
  if (node.focus) {
    node.focus();
    return;
  }
  // DOM fallback: focus the responder's element (or its first tabbable descendant).
  const el = node.el;
  if (el.tabIndex >= 0 || el instanceof HTMLInputElement || el instanceof HTMLButtonElement) {
    el.focus();
    return;
  }
  const tabbable = el.querySelector<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  tabbable?.focus();
}
```

#### Companion Binding {#companion-binding}

**Signal:** DOM focus on the owner element (per [D05]).

**Why not first responder:** with the existing `TugButton` discipline (`data-tug-focus="refuse"` + `suppressButtonFocusShift`), clicking a service-popup trigger does NOT change first responder. The signal that *does* change is DOM focus — Radix's `FocusScope.onMountAutoFocus` programmatically focuses the first menu item when the popup opens, blurring the editor's `contentDOM`. The companion binding observes that blur via `focusout`.

**Hook (sketch):**

```ts
// tugdeck/src/components/tugways/use-companion-popup-binding.ts
export interface CompanionPopupBindingOptions {
  ownerEl: HTMLElement | null;
  onShouldDismiss: () => void;
}

/**
 * Observes DOM focus on `ownerEl`. When focus leaves the owner's
 * subtree (and stays out for a microtask, to ride past in-subtree
 * focus transitions), calls `onShouldDismiss` exactly once per
 * transition. Re-arms when focus returns.
 *
 * Per [L02] / [L22]: the focus signal is browser-owned appearance
 * state observed via DOM events, NOT mirrored into React state.
 * Per [L03]: subscription installed in useLayoutEffect.
 */
export function useCompanionPopupBinding({
  ownerEl,
  onShouldDismiss,
}: CompanionPopupBindingOptions): void {
  // Stable handle for the consumer-supplied callback so the effect
  // does not re-subscribe on every render. Per [L07].
  const onShouldDismissRef = useRef(onShouldDismiss);
  useLayoutEffect(() => {
    onShouldDismissRef.current = onShouldDismiss;
  });

  useLayoutEffect(() => {
    if (!ownerEl) return;
    let isFocusedInside = ownerEl.contains(document.activeElement);

    function checkFocus() {
      const nowInside = ownerEl !== null && ownerEl.contains(document.activeElement);
      if (isFocusedInside && !nowInside) {
        // Transition: was inside → now outside. Fire dismiss.
        onShouldDismissRef.current();
      }
      isFocusedInside = nowInside;
    }

    function onFocusOut(_e: FocusEvent) {
      // Defer one microtask to ride past in-subtree transitions
      // (focusout fires before focusin during sibling-to-sibling moves;
      // reading activeElement synchronously may see <body>).
      queueMicrotask(checkFocus);
    }

    function onFocusIn(_e: FocusEvent) {
      queueMicrotask(checkFocus);
    }

    // Document-level listeners (capture phase). focusout/focusin
    // bubble, but listening on document with capture sidesteps any
    // intermediate stopPropagation. Per [L22] the listener side-
    // effects directly; no React state round-trip.
    document.addEventListener("focusout", onFocusOut, { capture: true });
    document.addEventListener("focusin", onFocusIn, { capture: true });
    return () => {
      document.removeEventListener("focusout", onFocusOut, { capture: true });
      document.removeEventListener("focusin", onFocusIn, { capture: true });
    };
  }, [ownerEl]);
}
```

**Consumer in `CompletionOverlay`:**

```ts
// Replaces today's cardDidDeactivate subscription.
// `editor.contentDOM` is the contenteditable that loses focus when
// Radix's FocusScope grabs focus into a sibling popup.
useCompanionPopupBinding({
  ownerEl: view.contentDOM,
  onShouldDismiss: () => cancelCompletion(view),
});
```

**Subsumes the old `cardDidDeactivate` signal:** when a peer card activates, focus leaves the previously-active card's editor (DOM focus moves to the new card). The owner-`focusout` predicate fires and the popup dismisses. Strict superset of the previous behavior (per [L23]).

#### Service Binding {#service-binding}

**Pattern:** imperative `addEventListener` / `removeEventListener` keyed off the popup's lifecycle (`captureOnOpen` / `onCloseAutoFocus`). No React state introduced for the captured-prior-responder, the external-click flag, or the listener handle — all are *structure-zone* refs ([L24]).

**Why imperative:** an earlier sketch keyed a `useLayoutEffect` on `capturedRef.current`, which doesn't re-run because refs don't trigger re-renders. The "fix" — mirroring `captured` into `useState` purely to drive the effect dependency — would inject React-render machinery into pure subscription state, which serves no rendering purpose ([L02] forbids "useState + manual sync" for external state). Imperative install/uninstall keyed off the lifecycle calls is the correct shape ([L22] precedent: store-driven DOM mutation observes directly).

**Hook (sketch):**

```ts
// tugdeck/src/components/tugways/use-service-popup-binding.ts
export function useServicePopupBinding(): {
  captureOnOpen: () => void;
  onCloseAutoFocus: (e: Event) => void;
} {
  const manager = useResponderChain();
  const overlayRoot = useCanvasOverlay();

  // All structure-zone state per [L24]. No useState — refs only.
  const capturedRef = useRef<string | null>(null);
  const externalClickRef = useRef(false);
  const listenerRef = useRef<((e: PointerEvent) => void) | null>(null);

  // Per [L07]: capture stable references at use-time.
  const captureOnOpen = useCallback(() => {
    if (!manager) return;
    capturedRef.current = manager.getFirstResponder();
    externalClickRef.current = false;

    // Imperatively install the document-level pointerdown listener.
    // Capture phase ensures we observe the click before any popup-
    // internal handler may stopPropagation.
    const listener = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (!overlayRoot.contains(target)) {
        externalClickRef.current = true;
      }
    };
    document.addEventListener("pointerdown", listener, { capture: true });
    listenerRef.current = listener;
  }, [manager, overlayRoot]);

  const onCloseAutoFocus = useCallback((e: Event) => {
    // Remove the listener BEFORE evaluating the predicate, so any
    // synthesized pointerdown emitted by Radix's close-cascade
    // cannot flip the flag mid-evaluation. Defensive ordering.
    if (listenerRef.current !== null) {
      document.removeEventListener("pointerdown", listenerRef.current, { capture: true });
      listenerRef.current = null;
    }
    const captured = capturedRef.current;
    capturedRef.current = null;

    if (!manager) return;
    if (captured === null) return;
    if (externalClickRef.current) return;        // [D07] — user clicked away
    if (!manager.getFirstResponder()) return;    // chain torn down

    e.preventDefault();
    manager.focusResponder(captured);
  }, [manager]);

  // [L03]: guard against the consumer component unmounting while a
  // popup is still open (e.g., the gallery card unmounts mid-popup).
  // The cleanup removes any still-installed listener so it does not
  // leak past the consumer's lifetime.
  useLayoutEffect(() => {
    return () => {
      if (listenerRef.current !== null) {
        document.removeEventListener("pointerdown", listenerRef.current, { capture: true });
        listenerRef.current = null;
      }
    };
  }, []);

  return { captureOnOpen, onCloseAutoFocus };
}
```

**Consumer in `TugPopupMenu`:**

```ts
const { captureOnOpen, onCloseAutoFocus } = useServicePopupBinding();

// In existing onOpenChange:
function handleOpenChange(next: boolean) {
  if (next) captureOnOpen();
  setOpen(next);
}

// In Radix Content:
<DropdownMenuPrimitive.Content
  onCloseAutoFocus={onCloseAutoFocus}
  /* ... */
/>
```

**Trigger-click discipline:** the binding's correctness depends on `manager.getFirstResponder()` returning the *editor's* responder id at `captureOnOpen` time, not the trigger button's. This is satisfied today by the existing `TugButton` discipline:

- `data-tug-focus="refuse"` causes `pane-focus-controller` to skip responder-chain promotion when the click targets a `TugButton`.
- `suppressButtonFocusShift` (used at `tug-sheet.tsx:559` and elsewhere) calls `e.preventDefault()` on `mousedown` to skip native browser focus shift.

Together they keep first responder pinned to the editor across the trigger click; `captureOnOpen` then captures the editor. [Step 5](#step-5) verifies this with a unit test that mounts `TugPopupMenu` with a `TugButton` trigger inside an editor, dispatches a click on the trigger, and asserts `manager.getFirstResponder()` is unchanged from before the click — the central correctness invariant of [D06] / [D07].

#### Sheet Anchor Math {#sheet-anchor-math}

**Today** (`tug-sheet.css`):

```css
.tug-sheet-overlay { position: absolute; inset: 0; top: var(--tug-chrome-height, 36px); }
.tug-sheet-clip    { position: absolute; top: var(--tug-chrome-height, 36px); /* ... */ }
.tug-sheet-content { position: relative; transform: translateY(-100%); /* ... */ }
```

**Migrated — direct DOM writes per [L06] / [L22] / [L24]:**

The anchor coords (`top` / `left` / `width` / `height` of the wrapper *and* clip elements) are *appearance-zone* state ([L24]) — only the renderer reads them. Per [L06]'s test ("does any non-rendering consumer depend on this state?"), the answer is *no*. They are written to DOM directly, not via React `style={{}}` props. The applier fires on three signals so size, position, and viewport changes all re-anchor without a render cycle ([L22] — store-observer-API for layout changes drives DOM writes directly).

**Two elements, not one.** A single wrapper would couple scrim-extent (must clip to the pane) with panel-extent (must extend past the pane per [Q01]) and the slide-in clip context (`overflow: hidden` for the enter animation). Splitting into a wrapper + sibling clip dissolves that conflict.

```ts
// Inside TugSheetContent (the migrated component):

const wrapperRef = useRef<HTMLDivElement | null>(null);
const clipRef = useRef<HTMLDivElement | null>(null);

// Anchor applier: pure DOM mutation. Reads cardEl rect, writes to
// wrapperRef AND clipRef element styles. No React touch.
useLayoutEffect(() => {
  if (!cardEl || !mounted) return;
  const apply = (): void => {
    const wrapper = wrapperRef.current;
    const clip = clipRef.current;
    if (!wrapper) return;
    const r = cardEl.getBoundingClientRect();
    const chromeH = parseFloat(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--tug-chrome-height") || "36",
    );
    const top = r.top + chromeH;
    // Wrapper: card body only — scrim clipped to the pane.
    wrapper.style.top    = `${top}px`;
    wrapper.style.left   = `${r.left}px`;
    wrapper.style.width  = `${r.width}px`;
    wrapper.style.height = `${r.height - chromeH}px`;
    // Clip: same top/left/width but extends to viewport bottom so
    // the panel can grow past the card per [Q01].
    if (clip) {
      clip.style.top    = `${top}px`;
      clip.style.left   = `${r.left}px`;
      clip.style.width  = `${r.width}px`;
      clip.style.height = `${window.innerHeight - top}px`;
    }
  };
  apply();
  // Size changes (sash drag, programmatic resize).
  const ro = new ResizeObserver(apply);
  ro.observe(cardEl);
  // Position changes via style mutation (pane drag mutates
  // `frame.style.left/top` on the outer `.tug-pane` element, which is
  // cardEl's parent). Observe both cardEl AND its parent so future
  // refactors that move the style mutations don't silently break
  // tracking.
  const mo = new MutationObserver(apply);
  mo.observe(cardEl, { attributes: true, attributeFilter: ["style"] });
  const paneEl = cardEl.parentElement;
  if (paneEl) {
    mo.observe(paneEl, { attributes: true, attributeFilter: ["style"] });
  }
  // Viewport-relative shifts.
  window.addEventListener("resize", apply);
  return () => {
    ro.disconnect();
    mo.disconnect();
    window.removeEventListener("resize", apply);
  };
}, [cardEl, mounted]);

// JSX:
return createPortal(
  <TugSheetStackingContext.Provider value={true}>
    {/* Wrapper hosts the scrim — clipped to the pane. */}
    <div
      ref={wrapperRef}
      data-slot="tug-sheet-anchor"
      className="tug-sheet-anchor"
      style={{ position: "fixed", pointerEvents: "auto" }}
    >
      {/* .tug-sheet-overlay (scrim) — fills wrapper via inset: 0 */}
    </div>
    {/* Clip is a sibling — extends past the wrapper. */}
    <div
      ref={clipRef}
      className="tug-sheet-clip"
      style={{ position: "fixed", pointerEvents: "auto" }}
    >
      {/* FocusScope */}
      {/*   .tug-sheet-content (panel, animation transform target) */}
    </div>
  </TugSheetStackingContext.Provider>,
  overlayRoot,
);
```

**Why two siblings (wrapper + clip):** they decouple three concerns the original single-container design coupled together:

- **Wrapper** (`.tug-sheet-anchor`): sized to the card body. Hosts the scrim. Visible dim is clipped to the pane.
- **Clip** (`.tug-sheet-clip`): top/left/width match the wrapper but height extends to the viewport bottom. `overflow: hidden` hides the panel during the slide-in enter animation. The panel's natural height can grow past the card without affecting the scrim's extent.
- **Content panel** (`.tug-sheet-content`): inside the clip, owns the animation transform (`translateY(-100%)→0` enter, `0→-100%` exit). Its `max-height: calc(100% - space-a)` is now relative to the clip (viewport-tall), so it can extend past the card body.

Per [L06]: wrapper and clip coords are appearance-zone DOM writes; per [L13] / [L14]: the panel's animation uses `tug-animator` (WAAPI), which the existing code already does. Migration preserves both.

**Initial-paint correctness:** the `useLayoutEffect` runs synchronously after commit, before the browser paints. The wrapper and clip are rendered hidden (scrim opacity 0, panel translateY -100% from the existing entry animation) and the applier writes coords before the first paint. No first-frame flash.

#### Popup Role Taxonomy {#popup-role-taxonomy}

This plan introduces two named popup roles (companion, service) and clarifies the relationship of two existing categories (modal-with-trap, hover hint). The taxonomy is a structural extension of [L11]'s control/responder distinction: a popup is itself often a control (it dispatches actions), but its *focus relationship to the surrounding workspace* is what this taxonomy classifies. Authors picking a role at component-design time get the right behavior; reviewers reading code can verify the choice by checking which binding (if any) the primitive consumes.

| Role | Examples | Open behavior | Close behavior | Auto-dismiss signal | Hook |
|------|----------|---------------|----------------|---------------------|------|
| **Companion** | `CompletionOverlay` (file completion) | Owner keeps DOM focus; popup never steals focus | Owner keeps DOM focus | DOM `focusout` on owner element ([D05]) | `useCompanionPopupBinding` |
| **Service** | `TugPopupMenu`, `TugPopover`, `TugConfirmPopover`, `TugContextMenu` (also: `tug-editor-context-menu`) | Popup grabs focus via Radix `FocusScope` | Restore prior first-responder via `manager.focusResponder` ([D06] / [D07]) | n/a — Radix's existing close-on-outside / Escape | `useServicePopupBinding` |
| **Modal-with-trap** | `TugSheet`, `TugSheetContent` (via `useTugSheet`), `TugAlert` | Trap focus inside via `FocusScope`; owning card body becomes `inert` | Restore focus to trigger; chain-native `cancelDialog` close path | n/a — explicit user dismiss only | (existing `FocusScope` + chain-native `cancelDialog`) |
| **Hover hint** | `TugTooltip` | n/a — tooltips do not take focus | n/a | Radix hover/focus tracking | n/a |

**Three observations the taxonomy makes explicit:**

1. **Companion vs service is a focus-stewardship question, not a "what kind of widget" question.** A popup menu is a service because *opening it transfers user intent into the popup*; the user is now choosing an item. A completion overlay is a companion because *opening it does not transfer user intent*; the user is still typing into the editor and the overlay is a side-channel. The same widget shape (a list of selectable items) plays different roles depending on where focus belongs during interaction.
2. **Modal-with-trap is distinct from service.** A sheet is not "a service popup with a focus trap"; it is a workspace-blocking interaction that the user explicitly entered. Its close behavior (restore-to-trigger) is governed by Radix's `FocusScope.onUnmountAutoFocus` semantics already and does NOT use `useServicePopupBinding`. Mixing the two would over-constrain sheet behavior — a sheet's "Cancel" button explicitly should NOT restore the editor's prior responder; it should restore the trigger that opened the sheet.
3. **Hover hint is a separate axis.** Tooltips don't take focus, don't dismiss companions when shown, and don't carry a captured prior responder. They share the canvas overlay tier (per [D01]) for tier consistency only.

**Author guidance** (lands in `tuglaws/component-authoring.md` per [Step 7](#step-7)):

- Picking a role: ask "while this popup is open, where does the user expect their typing to go?" If "the popup itself" → service. If "the same place as before" → companion. If "nowhere — the rest of the workspace is blocked" → modal-with-trap. If "no input — just a hint that goes away on hover-out" → hover hint.
- Per [L19] every popup-class component documents its role in its module docstring and consumes the corresponding binding (or none, for modal-with-trap and hover hint). Reviewers verify the docstring matches the binding.

#### Tuglaws Cross-Check Plan {#tuglaws-cross-check-plan}

The detailed walkthrough lives in [#tuglaws-cross-check] (filled in at [Step 7](#step-7)). Anchors checked: [L02], [L03], [L06], [L11], [L19], [L23].

---

### Specification {#specification}

#### Public API Surface {#public-api}

**`ResponderNode.focus`** — `tugdeck/src/components/tugways/responder-chain.ts`

```ts
interface ResponderNode<Extra extends string = never> {
  // ... existing fields ...
  focus?: () => void;
}
```

**`ResponderManager.focusResponder`** — `tugdeck/src/components/tugways/responder-chain.ts`

```ts
class ResponderManager {
  focusResponder(id: string): void;
}
```

**`useCompanionPopupBinding`** — `tugdeck/src/components/tugways/use-companion-popup-binding.ts`

```ts
export interface CompanionPopupBindingOptions {
  ownerEl: HTMLElement | null;
  onShouldDismiss: () => void;
}

export function useCompanionPopupBinding(options: CompanionPopupBindingOptions): void;
```

**`useServicePopupBinding`** — `tugdeck/src/components/tugways/use-service-popup-binding.ts`

```ts
export function useServicePopupBinding(): {
  captureOnOpen: () => void;
  onCloseAutoFocus: (event: Event) => void;
};
```

**`TugSheetStackingContext`** — `tugdeck/src/components/tugways/tug-sheet-stacking-context.ts`

```ts
export const TugSheetStackingContext: React.Context<boolean>;  // default: false
```

Provided by `TugSheetContent` (value `true` while a sheet is open within the React subtree); consumed by every popup-class primitive that portals to the canvas overlay root, to apply elevated z-tier tokens per [D09].

**Token tier extensions** — `tugdeck/styles/chrome.css`

```css
:root {
  /* New per [D09] — popup-class primitives nested inside an open sheet */
  --tug-z-overlay-popup-in-dialog: 9500;  /* TugPopover, completion (rare in sheets) */
  --tug-z-overlay-menu-in-dialog:  9600;  /* TugPopupMenu, TugContextMenu */
}
```

#### Internal Architecture {#internal-architecture}

```
Layer A — universal canvas overlay tier:

  TugPopover            tug-popover.tsx              container={useCanvasOverlay()}
  TugAlert              tug-alert.tsx                container={useCanvasOverlay()}
  TugTooltip            tug-tooltip.tsx              container={useCanvasOverlay()}
  TugContextMenu        tug-context-menu.tsx         container={useCanvasOverlay()}
  TugPopupMenu (root)   internal/tug-popup-menu.tsx  container={useCanvasOverlay()}
  TugPopupMenu (sub)    internal/tug-popup-menu.tsx  container={useCanvasOverlay()}
  EditorContextMenu     tug-editor-context-menu.tsx  createPortal(_, useCanvasOverlay())
  TugSheet              tug-sheet.tsx                createPortal(_, useCanvasOverlay())
                                                     + cardEl rect anchor + ResizeObserver

Layer B — focus contract + binding hooks:

  ResponderNode             { ..., focus?: () => void }
  ResponderManager.focusResponder(id)
  useCompanionPopupBinding({ ownerEl, onShouldDismiss })   // observes DOM focus per [D05]
  useServicePopupBinding() → { captureOnOpen, onCloseAutoFocus }

Layer C — wire defaults:

  TugTextEditor      registers focus: () => view.focus()
  CompletionOverlay  consumes useCompanionPopupBinding(ownerEl: view.contentDOM)
  TugPopupMenu       consumes useServicePopupBinding internally
  TugPopover         consumes useServicePopupBinding internally
  TugContextMenu     consumes useServicePopupBinding internally
  TugPopupButton     inherits service via TugPopupMenu — no per-call config

  TugSheetContent    provides <TugSheetStackingContext value={true}>
  TugPopupMenu       consumes context → applies tug-menu-in-dialog class when nested
  TugPopover         consumes context → applies tug-popup-in-dialog class when nested
  TugContextMenu     consumes context → applies tug-menu-in-dialog class when nested
```

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/use-companion-popup-binding.ts` | Companion binding hook (DOM focus per [D05]) |
| `tugdeck/src/components/tugways/use-service-popup-binding.ts` | Service binding hook (capture/restore per [D06] / [D07]) |
| `tugdeck/src/components/tugways/tug-sheet-stacking-context.ts` | Boolean React context per [D09] |
| `tugdeck/src/components/tugways/__tests__/use-companion-popup-binding.test.tsx` | Unit tests |
| `tugdeck/src/components/tugways/__tests__/use-service-popup-binding.test.tsx` | Unit tests |
| `tugdeck/src/__tests__/responder-focus-contract.test.tsx` | Unit tests for `focus` callback + `focusResponder` |
| `tests/app-test/atNNNN-popup-bindings.test.ts` | App-tests (id assigned at [Step 7](#step-7)): companion auto-dismiss, service close-focus restore, sheet escapes card, popup-in-sheet stacks above sheet |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ResponderNode.focus` | type field | `tugways/responder-chain.ts` | Optional; new — closes the chain-state ↔ DOM-focus gap |
| `ResponderManager.focusResponder` | method | `tugways/responder-chain.ts` | New — `makeFirstResponder` + invoke `focus()` callback / DOM-walk fallback |
| `useResponder` / `useOptionalResponder` | hook | `tugways/use-responder.tsx` | Accept `focus` option, forward into ResponderNode |
| `useCompanionPopupBinding` | hook | `tugways/use-companion-popup-binding.ts` | New — observes DOM focus on `ownerEl` per [D05] |
| `useServicePopupBinding` | hook | `tugways/use-service-popup-binding.ts` | New — captures prior responder on open; restores on close per [D06] / [D07] |
| `TugSheetStackingContext` | React context | `tugways/tug-sheet-stacking-context.ts` | New — boolean signal "sheet in scope"; popup-class primitives consume per [D09] |
| `CompletionOverlay` | component | `tugways/tug-text-editor.tsx` | Replace `cardDidDeactivate` subscription with `useCompanionPopupBinding(ownerEl: view.contentDOM)` |
| `TugTextEditor` | component | `tugways/tug-text-editor.tsx` | Pass `focus: () => view.focus()` into responder registration |
| `TugPopupMenu` | component | `tugways/internal/tug-popup-menu.tsx` | Add `useServicePopupBinding`; portal to canvas overlay; consume `TugSheetStackingContext`; `onCloseAutoFocus` from binding |
| `TugPopover` / `TugConfirmPopover` | component | `tugways/tug-popover.tsx` | Add `useServicePopupBinding`; portal to canvas overlay; consume `TugSheetStackingContext` |
| `TugContextMenu` | component | `tugways/tug-context-menu.tsx` | Add `useServicePopupBinding`; portal to canvas overlay; consume `TugSheetStackingContext` |
| `TugTooltip` | component | `tugways/tug-tooltip.tsx` | Portal to canvas overlay (no service binding — tooltips don't take focus; no context consumption — tooltips inside sheets are out of scope) |
| `TugAlert` | component | `tugways/tug-alert.tsx` | Portal to canvas overlay; modal-with-trap (no service binding) |
| `TugSheet` / `TugSheetContent` | component | `tugways/tug-sheet.tsx` | Portal to canvas overlay; direct-DOM anchor write per [D02]; provide `TugSheetStackingContext` per [D09] |
| `tug-editor-context-menu` | component | `tugways/tug-editor-context-menu.tsx` | Replace `document.body` with canvas overlay root; service-role (registers as a service of the editor) |
| `--tug-z-overlay-popup-in-dialog` / `--tug-z-overlay-menu-in-dialog` | CSS tokens | `chrome.css` | New per [D09] |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/component-authoring.md` — extend the "Portaling and Overlays" section (added in the predecessor plan) with: "popups choose a responder role: **companion** (auto-dismiss when owner is no longer first responder) or **service** (capture/restore prior responder on close). Use `useCompanionPopupBinding` for the former, `useServicePopupBinding` for the latter. `TugPopupMenu` / `TugPopover` / `TugContextMenu` apply service semantics by default."
- [ ] `tuglaws/app-test-inventory.md` — add new app-test ids; bump high-water mark.
- [ ] `tugdeck/src/components/tugways/use-companion-popup-binding.ts` docstring — explain the at-or-below predicate per [D05].
- [ ] `tugdeck/src/components/tugways/use-service-popup-binding.ts` docstring — explain the external-pointerdown predicate per [D07].
- [ ] `tugdeck/src/components/tugways/responder-chain.ts` docstrings — document `focus` callback contract per [D03], `focusResponder` per [D04].
- [ ] `TugPopupButton` docstring — note that service semantics are inherited from `TugPopupMenu` per [D08].

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (happy-dom)** | Manager method semantics, hook subscribe/unsubscribe, predicate evaluation, default DOM-fallback focus path | All non-layout, non-focus-across-renders assertions |
| **App-test (real browser)** | Sheet escape clip, anchor accuracy, focus across portal hops, focus across React re-renders | Every "the popup escapes the card frame" or "document.activeElement is X after click on Y" assertion |
| **Integration (happy-dom + real chain)** | `useCompanionPopupBinding` against a live `ResponderManager` and editor view | Companion dismiss races, ordering between accept and dismiss |

---

### Execution Steps {#execution-steps}

> Each step is a separate commit. `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint` pass at the end of every step. [Step 8](#step-8) is verification-only (no commit).

#### Step 1 — Universal canvas overlay tier for popup-class {#step-1}

<!-- No dependencies — root step -->

**Commit:** `Migrate popup-class portals to canvas overlay tier`

**References:** [D01], (#radix-portal-survey)

**Artifacts:**
- `tug-popover.tsx`, `tug-alert.tsx`, `tug-tooltip.tsx`, `tug-context-menu.tsx`, `internal/tug-popup-menu.tsx`, `tug-editor-context-menu.tsx` — pass `container={overlayRoot}` (or its `createPortal` equivalent) where `overlayRoot = useCanvasOverlay()`.
- New unit tests asserting each migrated primitive renders inside `[data-slot="tug-canvas-overlay-root"]` (or `document.body` in the no-root fallback).

**Tasks:**
- [x] In each Radix-wrapping primitive, call `useCanvasOverlay()` once at the top of the component and pass the result to the Radix Portal's `container` prop.
- [x] In `tug-editor-context-menu.tsx`, replace `createPortal(content, document.body)` with `createPortal(content, useCanvasOverlay())`.
- [x] For `internal/tug-popup-menu.tsx`'s sub-menu portal (line 308), pass the same `container` to the nested `<DropdownMenuPrimitive.Portal>`.
- [x] One CSS rule added to `styles/chrome.css`: `.tug-canvas-overlay-root > * { pointer-events: auto; }`. The overlay root has `pointer-events: none` (inline) so empty area is click-through, but Radix's DismissableLayer only sets `pointer-events: auto` inline for *modal* layers (AlertDialog, DropdownMenu modal=true). Non-modal layers (Popover modal=false, Tooltip) inherit `none` from the overlay root and become un-clickable. The direct-child opt-in mirrors the completion menu's inline `pointer-events: auto` pattern. Stacking is unchanged — the existing `--tug-z-overlay-*` tokens still produce the correct order.

**Tests:**
- [x] Unit per primitive: mount with `<CanvasOverlayRoot />` present; assert content lands inside `[data-slot="tug-canvas-overlay-root"]`.
- [x] Unit per primitive: mount without `<CanvasOverlayRoot />`; assert content lands in `document.body` (the registry's fallback path).
- [x] Unit `TugPopupMenu` sub-menu: open root menu, hover sub trigger, assert sub-menu is also inside the canvas overlay root.

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green; new tests pass.
- [x] `bun run audit:tokens lint` exits 0.
- [x] `rg "createPortal\(.+document\.body\)" tugdeck/src/components/tugways` returns no popup-class hits (sheets and editor-context-menu are migrated).
- [ ] Manual smoke: open a font picker, a tooltip, a context menu — all work; visual unchanged from pre-step.

---

#### Step 2 — TugSheet rendering on canvas overlay tier {#step-2}

**Depends on:** #step-1

**Commit:** `Migrate TugSheet rendering to canvas overlay tier`

**References:** [D02], [Q01] (resolved option a), (#sheet-anchor-math), Risk R01, [L06], [L22], [L23]

**Artifacts:**
- `tug-sheet.tsx` — `TugSheetContent` portals into `useCanvasOverlay()`. `cardEl` retained from `TugPanePortalContext` for `inert` write *and* `getBoundingClientRect()` for anchor math.
- `tug-sheet.css` — `position: fixed` on the canvas-tier wrapper; animation-content positions remain relative within the wrapper.
- Direct-DOM-write applier per [L06]; `ResizeObserver` on `cardEl` invokes the applier per [L22].
- New app-test: sheet bounding rect extends below card bottom.
- New app-test: peer-card visual stacking ([Q01] visual confirmation).

**Tasks:**
- [x] In `TugSheetContent`, change the `createPortal` target from `cardEl` to `useCanvasOverlay()`.
- [x] **Implement direct-DOM-write applier per [L06]:** `wrapperRef` on a new `.tug-sheet-anchor` wrapper element; `useLayoutEffect` keyed on `[cardEl, mounted]` runs `apply()` (reads `cardEl.getBoundingClientRect()` + `--tug-chrome-height`, writes `wrapperRef.current.style.{top,left,width,height}` directly), runs once at mount, installs `ResizeObserver(apply)` on `cardEl`, disconnects in cleanup. No React state, no `style={{}}` props for the anchor coords.
- [x] Convert `.tug-sheet-overlay` and `.tug-sheet-clip` CSS rules: drop `top: var(--tug-chrome-height)` (the wrapper now starts below the card chrome, so the inner elements fill the wrapper via `inset: 0`). The `.tug-sheet-content` panel keeps its `position: relative` + `translateY` transform (animation-local).
- [x] Verify the `inert` write on `.tug-pane-body` still fires (the `cardEl` read for it is unchanged).
- [x] **Wrap rendered content in `<TugSheetStackingContext.Provider value={true}>` per [D09]** so descendant popups elevate. New file `tug-sheet-stacking-context.ts` exports the context (default `false`); provider lives inside the portaled subtree.

**Preserve list per [L23]** (each item asserted by a test in this step):

- [x] Unit: `defaultOpen={true}` mounts the sheet open; `useTugSheet().showSheet()` Promise resolves on close (existing tests pass unchanged).
- [x] Unit: `componentStatePreservationKey` capture/restore protocol round-trips an open sheet through bag serialization (existing test extended to assert via the new portal target).
- [x] Unit: `TugSheetHandle.open()` / `.close()` ref-handle calls work post-migration.
- [x] Unit: `FocusScope` `trapped={open}` traps tab navigation inside the sheet content.
- [x] Unit: `tide-card.tsx:1190`'s `onOpenAutoFocus` override (focus-the-OK-button) still runs and focus lands on the OK button at sheet open.
- [x] Unit: `inert` attribute is set on `.tug-pane-body` of the owning card on open; removed on close and on unmount.
- [x] Unit: chain-native `cancelDialog` close — Escape and Cmd+. each dispatch via `manager.sendToTarget(responderId, ...)` and the sheet's `useOptionalResponder` handler closes.
- [x] Unit: `useTugSheetClose()` hook closes via the chain; existing test passes against the migrated rendering.
- [x] Unit: `tug-animator` enter (overlay opacity 0→1, content translateY -100% → 0) and exit (reverse) fire and `g.finished` resolves on both; `setMounted(false)` flips after exit.
- [x] Unit: `onClosed` callback fires post-exit-animation, after the portal's React unmount.
- [x] Unit: `triggerElRef.current?.focus()` in `handleUnmountAutoFocus` returns focus to the trigger element on close (tested with a button trigger).
- [x] Unit: `useTugSheet`'s `senderId` round-trip via `observeDispatch` resolves the Promise with `undefined` for Escape-dismissal and the explicit `result` for `close(result)` calls.

**Layout-fidelity tests (must be app-tests per `feedback_no_happy_dom_tests`):**

- [ ] App-test: mount a card with a sheet whose content forces height greater than the card; assert sheet's bottom edge extends past the card's bottom edge in the viewport.
- [ ] App-test: mount two cards in a vertical stack; open a sheet on the upper card; assert sheet's bounding rect crosses the lower card's title-bar y-coordinate ([Q01] visual gate); manual smoke confirms acceptable stacking.
- [ ] App-test: drag the owning card while sheet is open; assert sheet's wrapper `top` / `left` track the card within one ResizeObserver tick (anchor stays in sync per Risk R01).

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green; all preserve-list tests pass (2665 / 0 fail).
- [ ] App-tests for sheet escape and drag-tracking pass with `VERDICT: PASS`.
- [ ] Manual smoke: open the "Open Project" sheet (image 2 reproducer); buttons visible below the original card frame.
- [ ] Manual smoke: drag the card while the sheet is open; sheet visually tracks the card with no perceptible lag.

---

#### Step 3 — Responder focus contract {#step-3}

**Depends on:** #step-1

**Commit:** `Add focus callback contract on ResponderNode; manager.focusResponder`

**References:** [D03], [D04], (#focus-contract), [L19], [L23]

**Artifacts:**
- `responder-chain.ts` — `ResponderNode.focus?: () => void`; `ResponderManager.focusResponder(id)`.
- `use-responder.tsx` — `useResponder` / `useOptionalResponder` accept `focus` option and forward it.
- `tug-text-editor.tsx` — pass `focus: () => view.focus()` into the editor's responder registration.
- New unit tests under `tugdeck/src/__tests__/`.

**Tasks:**
- [x] Extend `ResponderNode` interface with optional `focus`. Per [L19] update the inline docstring on the interface to explain the contract: "Optional substrate-supplied focus callback. Invoked by `manager.focusResponder(id)` after `makeFirstResponder(id)` runs. If absent, the manager walks the responder's element via `data-responder-id` and focuses the first tabbable descendant. Substrates with non-trivial focus surfaces (CodeMirror, future custom editors) provide this; generic responders omit it." — JSDoc on the interface field expands the contract and references [D03] / (#focus-contract); structural-property semantics (captured at mount, like `kind`) explicitly named.
- [x] Implement `ResponderManager.focusResponder(id)` per (#focus-contract): chain-state restore + node.focus or DOM fallback. Dev-mode warn on unregistered id. — order is `makeFirstResponder` → `node.focus?.()` → DOM-walk fallback (intrinsically-focusable element first, then `tabindex >= 0`, then first tabbable descendant via the standard tabbable selector excluding `tabindex="-1"`). DOM-free environments (`typeof document === "undefined"`) skip the DOM step gracefully — chain record still updates.
- [x] Update `useResponder` / `useOptionalResponder` signatures and registration paths to accept and forward the optional `focus` option. — `UseResponderOptions.focus?: () => void` added; mount-time capture via `focusAtMount` ref (mirrors `kindAtMount` shape per [D03]'s "structural property" semantics); option is forwarded into the `ResponderNode.focus` field at registration. Hook does NOT proxy through `optionsRef` — the substrate is responsible for capturing whatever ref it needs in the closure (per [L07]).
- [x] In `TugTextEditor`'s responder registration, pass `focus: () => view.focus()`. Verify `view` is captured in the closure correctly across re-renders ([L07] — handler reads `view` through the closure stable across the editor's lifetime; the registration happens once at mount when `view` is stable). — implemented as `focus: () => viewRef.current?.focus()`. Reading `viewRef.current` (not the `view` state) means the callback always invokes `focus()` on the live view — covers Fast Refresh re-mount and StrictMode double-mount where the EditorView identity may have been swapped between registration and invocation. The `?.` no-ops cleanly when the editor's mount effect hasn't yet committed (registration runs before that effect on the first render).
- [x] Per [L23]: existing call sites of `manager.makeFirstResponder` continue to work unchanged. The new method is additive; no migration of existing call sites in this step. — full bun test suite runs 2701 / 0 fail across 160 files; every existing makeFirstResponder call site preserved.

**Tests:**
- [x] Unit: `focusResponder(id)` on a responder *with* `focus` callback calls the callback and updates `firstResponderId`. — `focus-responder.test.tsx`: "invokes node.focus() and promotes id to first responder", "runs makeFirstResponder BEFORE node.focus (subscribers see id flip first)", "does NOT walk the DOM when a focus callback is present".
- [x] Unit: `focusResponder(id)` on a responder *without* `focus` callback walks the DOM and focuses the responder's element (or first tabbable descendant if the element itself is non-focusable). — five tests: intrinsically-focusable element direct focus, `tabindex >= 0` element direct focus (descendants skipped), first-tabbable-descendant fall-through, `tabindex="-1"` elements skipped during scan, detached element graceful no-op while still promoting in chain.
- [x] Unit: `focusResponder(id)` on an unregistered id is a no-op (and dev-mode warns). — `focus-responder.test.tsx`: "is a no-op (does not promote, does not throw, dev-mode warns)" — captures `console.warn` and asserts the message contains both `focusResponder` and the offending id.
- [x] Unit: editor's `focus` callback fires; `view.focus()` is exercised and `document.activeElement === view.contentDOM` after `focusResponder(editorId)` (this is the integration touchpoint with the editor that downstream service-binding tests will rely on). — split per project test-scoping rules. The "wiring through the hook" half is covered by `focus-responder.test.tsx` "useOptionalResponder forwards focus option onto the registered node" (renders a real `useOptionalResponder` consumer, dispatches `focusResponder` from outside React, asserts the callback fired). The "real CM6 `view.focus()` lands on `view.contentDOM`" half is happy-dom-unsafe per the project's happy-dom scoping rule (no focus/selection assertions across React renders); deferred to the [Step 5](#step-5) app-test (image 5 close path: open `@` completion → click font picker → choose font → next keystroke lands in editor) which exercises the end-to-end touchpoint with the real engine.

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green. — 2701 pass / 0 fail across 160 files (was 2690 / 159 before Step 3; added 11 tests in `focus-responder.test.tsx`).
- [x] No existing call site of `makeFirstResponder` regresses (the new method is additive). — verified by full suite green; in particular the 98 chain/responder/pane-focus tests preserve their assertions about makeFirstResponder behavior.

---

#### Step 4 — Companion binding; wire CompletionOverlay {#step-4}

**Depends on:** #step-3

**Commit:** `Add useCompanionPopupBinding (DOM focus); wire CompletionOverlay`

**References:** [D05], (#companion-binding), [L02], [L03], [L06], [L22], [L23]

**Artifacts:**
- `use-companion-popup-binding.ts` — new hook observing DOM focus per [D05].
- `tug-text-editor.tsx` — `CompletionOverlay` consumes `useCompanionPopupBinding({ ownerEl: view.contentDOM, ... })`; replaces today's `cardDidDeactivate` subscription.
- New unit tests; new app-test for companion auto-dismiss.

**Tasks:**
- [x] Implement `useCompanionPopupBinding({ ownerEl, onShouldDismiss })` per (#companion-binding):
  - [x] Document-level `focusout` and `focusin` listeners (capture phase) installed in `useLayoutEffect` ([L03]).
  - [x] Microtask-deferred `document.activeElement` read inside the handler so in-subtree focus transitions (focusout fires before focusin during sibling moves) don't spuriously fire dismiss.
  - [x] `onShouldDismiss` callback held in a ref per [L07] for closure stability.
  - [x] Last-value memoization (`isFocusedInside`) in a closure variable inside `useLayoutEffect`. *Structure-zone* per [L24].
  - [x] No useState; no React-state mirror of focus position. Per [L02] / [L06]: DOM focus is appearance state observed directly via DOM events, not mirrored into React.
- [x] In `CompletionOverlay`, remove the `cardDidDeactivate` subscription and `useContext(DeckManagerContext)` / `useCardId()` block; replace with:
  ```ts
  useCompanionPopupBinding({
    ownerEl: view.contentDOM,
    onShouldDismiss: () => cancelCompletion(view),
  });
  ```
  Imports `useContext` (no other consumer in `tug-text-editor.tsx`) and `DeckManagerContext` removed; `useCardId` import preserved (still used by the parent `TugTextEditor` component for an unrelated cardId ref).
- [x] Per [L23] strict-superset claim: keep the existing pane-collapse `cancelCompletion` branch in the ResizeObserver block (that's a different signal — a layout collapse, not a focus signal — and remains valid). The two signals coexist; both end at the same `cancelCompletion(view)` mutation. — verified: ResizeObserver block intact; only the deactivate-cancel block is removed.
- [x] Verify `view.contentDOM` is the right `ownerEl`: it's the contenteditable that loses focus when Radix's FocusScope grabs focus into a sibling popup. If a Step 4 unit test reveals an edge case where the editor's wrapper element is a better choice (e.g., subtle CM6 internal focus games), pivot to the wrapper at implementation time and document the rationale in the hook's docstring. — `contentDOM` is correct: focus assertions in `tug-text-editor-completion-overlay.test.tsx` confirm the strict-superset behavior using `view.contentDOM.focus()` as the in-subtree pre-condition.

**Tests:**
- [x] Unit: companion fires `onShouldDismiss` exactly when DOM focus transitions out of the owner element's subtree. — `use-companion-popup-binding.test.tsx`: "fires onShouldDismiss when focus moves from inside to outside the owner" and "fires once per outside transition, re-arming when focus returns".
- [x] Unit: an in-subtree focus transition (focus moves between two children of the owner) does NOT fire `onShouldDismiss`. — `use-companion-popup-binding.test.tsx`: "does NOT fire onShouldDismiss when focus moves between two siblings inside the owner".
- [x] Unit: changing `ownerEl` re-subscribes; the old element's listeners are torn down; the new element's listeners take effect. — `use-companion-popup-binding.test.tsx`: "re-subscribes when ownerEl identity changes" — covers tear-down of ownerA's effect AND verifies ownerB's effect responds correctly.
- [x] Unit: `ownerEl === null` no-ops (no listeners installed). — two tests: "installs no listeners when ownerEl is null" (spies on `document.addEventListener` to confirm no installs) and "recovers when ownerEl becomes non-null on a later render".
- [x] Integration (happy-dom + real CM6 view): mount editor + open `@` completion via `view.dispatch`; programmatically blur `view.contentDOM` (call `view.contentDOM.blur()`); assert `cancelCompletion` was called and the typeahead state went inactive. — `tug-text-editor-completion-overlay.test.tsx`: "DOM focus leaving the editor's contentDOM cancels the typeahead session ([D05] strict-superset of [D06])" + "two editors' typeahead sessions are independent (each binds to its own contentDOM)" — both use real CM6 views and `view.contentDOM.focus()` to drive transitions.
- [x] App-test (the bug-reproducer): open `@` completion in the editor; click the font picker (`TugPopupButton`); assert completion popup is gone before the font menu has fully opened. Verifies the chain: trigger click → Radix mounts content → FocusScope grabs focus from contentDOM → focusout on contentDOM → microtask defer → companion fires → `cancelCompletion` runs. — `tests/app-test/at0052-completion-cancels-on-sibling-popup.test.ts`. Uses `gallery-text-editor` (exposes the font-family `TugPopupButton`) and `/` trigger per the deterministic-fixture pattern. **Verified PASS via `just app-test`** (1/1 file green; 1/1 tests passed). AT-tag AT0052 inventory entry should flip ❓→✅.
- [x] App-test: open `@` completion; click into a peer card; assert completion popup is gone (the old `cardDidDeactivate` case, now subsumed by the focus signal). Per [L23] strict-superset. — `tests/app-test/at0053-completion-cancels-on-peer-card-click.test.ts`. Two-pane / two-card deck; native-clicks card B's `data-pane-id="p2"` chrome to drive focus out of card A. **Verified PASS via `just app-test`** (1/1 file green). AT-tag AT0053 inventory entry should flip ❓→✅.
- [x] App-test: open `@` completion; press Escape; assert popup closes (the existing keymap path is unaffected by the binding swap; this is a regression guard). — `tests/app-test/at0054-completion-escape-still-cancels.test.ts`. Activates `/` typeahead, presses Escape natively, asserts popup hidden. **Verified PASS via `just app-test`** (1/1 file green; 2/2 expect() calls). AT-tag AT0054 inventory entry should flip ❓→✅.

**Checkpoint:**
- [x] `bun x tsc --noEmit` green. — both `tugdeck` and `tests/app-test` projects type-check cleanly.
- [x] `bun test` green. — full suite 2708 pass / 0 fail across 161 files (was 2701 / 160 at end of Step 3; added 7 hook tests in `use-companion-popup-binding.test.tsx`; CompletionOverlay tests updated in place from 12 to 12).
- [x] App-tests pass. — `just app-test at0052-* at0053-* at0054-*` returns VERDICT: PASS for all three.
- [ ] Manual smoke: image 5 reproducer — open `@` completion, click font picker; completion popup vanishes; font menu opens.

---

#### Step 5 — Service binding; wire popup primitives; popup-in-sheet stacking {#step-5}

**Depends on:** #step-3, #step-2

**Commit:** `Add useServicePopupBinding; wire popup primitives; popup-in-sheet stacking`

**References:** [D06], [D07], [D09], [Q02], (#service-binding), Risk R02, [L02], [L03], [L07], [L19], [L24]

**Artifacts:**
- `use-service-popup-binding.ts` — new hook with imperative install/uninstall per [D07].
- `internal/tug-popup-menu.tsx`, `tug-popover.tsx`, `tug-context-menu.tsx` — consume the hook; pass `onCloseAutoFocus` to Radix; consume `TugSheetStackingContext`.
- `tug-popover.css`, `tug-menu.css`, `tug-completion-menu.css` — add `.tug-popup-in-dialog` / `.tug-menu-in-dialog` rules consuming the new tokens.
- New unit tests; new app-test for close-focus restoration; new app-test for popup-in-sheet stacking.

**Tasks:**
- [x] Implement `useServicePopupBinding()` per (#service-binding):
  - [x] Imperative `addEventListener` in `captureOnOpen`; imperative `removeEventListener` in `onCloseAutoFocus` (per [D07]).
  - [x] Three refs ([L24] *structure*): `capturedRef`, `externalClickRef`, `listenerRef`. No useState.
  - [x] Guard `useLayoutEffect` for unmount-while-open cleanup ([L03]).
  - [x] `useResponderChain()` tolerance: hook is a no-op when no provider. — `if (!manager) return` short-circuits `captureOnOpen`; the close path falls through to Radix's default when `manager === null`.
- [x] In `TugPopupMenu`, call `useServicePopupBinding()`; in `handleOpenChange(next)` call `captureOnOpen()` only when `next === true`; pass `onCloseAutoFocus` into `<DropdownMenuPrimitive.Content>`.
- [x] In `TugPopover` / `TugConfirmPopover`, do the same against `<Popover.Content>`. — wired in `TugPopover` directly; `TugConfirmPopover` inherits via composition (it renders `TugPopoverContent` which receives `onCloseAutoFocus` from internal context).
- [x] In `TugContextMenu`, do the same against `<ContextMenuPrimitive.Content>`.
- [x] **Per [D09], wire popup-in-sheet z-tier elevation:**
  - [x] Create `tugdeck/src/components/tugways/tug-sheet-stacking-context.ts` exporting `TugSheetStackingContext` (boolean, default `false`). Module docstring per [L19] explains the contract. — landed in [Step 2](#step-2); reused as-is here.
  - [x] In `TugSheetContent` (which migrated to canvas tier in [Step 2](#step-2)), wrap the portaled content with `<TugSheetStackingContext.Provider value={true}>`. — landed in [Step 2](#step-2).
  - [x] Add the new token definitions to `tugdeck/styles/chrome.css` alongside the existing `--tug-z-overlay-*` block.
  - [x] In `TugPopupMenu`, `TugPopover` / `TugConfirmPopover`, `TugContextMenu`: `const inDialog = useContext(TugSheetStackingContext);` at the top of each component. — applied to TugPopupMenu, TugPopoverContent, and TugContextMenu; TugConfirmPopover inherits via composition through TugPopoverContent.
  - [x] Apply class `tug-popup-in-dialog` (popovers) or `tug-menu-in-dialog` (popup-menu, context-menu) on the portaled content element when `inDialog` is true. — also applied to TugPopupMenu's sub-menu Content for consistency with the root menu's elevation.
  - [x] Add CSS rules in `tug-popover.css` and `tug-menu.css` mapping these classes to `var(--tug-z-overlay-popup-in-dialog)` / `var(--tug-z-overlay-menu-in-dialog)`. Cite [D09] in the rule comment.
  - [x] `tug-completion-menu.css` does NOT need the elevation rule by default (a completion overlay opening inside a sheet is unusual; the editor inside a sheet is rare). Out of scope for this plan; flag in (#non-goals) if a future consumer surfaces.
- [x] Audit existing call sites for any `onCloseAutoFocus` overrides — there should be none for these primitives today; document Risk R02 path for future overrides in the hook's module docstring per [L19]. — `rg "onCloseAutoFocus" tugdeck/src/` returned zero hits at the time of writing; the hook's module docstring documents the consumer-override-via-`focusResponder` path per Risk R02.

**Verification gate per [D07] / [D08] — TugButton trigger discipline:**

This is the central correctness invariant: `manager.getFirstResponder()` at `captureOnOpen` time must return the editor's responder id, NOT the trigger button's. The existing `TugButton` discipline (`data-tug-focus="refuse"` + `suppressButtonFocusShift`) achieves this. **If this discipline regresses, the entire service binding restores focus to the wrong place.** Pin it down with a unit test:

- [x] Unit: mount a `<ResponderChainProvider>` with a registered editor responder (manager.makeFirstResponder(editorId) at start). Render a `TugPopupMenu` with a `TugButton` trigger inside the same provider. Synthesize a `mousedown` then `click` on the trigger element. Assert `manager.getFirstResponder() === editorId` after the click (i.e., trigger click did NOT promote a new responder). — `popup-trigger-discipline.test.tsx`. Two tests: structural attribute pin (`data-tug-focus="refuse"` is present on the rendered trigger) + chain-promotion-guardrail test (synthesized mousedown+click do not promote a new responder, since neither TugPopupMenu nor TugButton itself contains a stray `makeFirstResponder` call). The end-to-end "with `pane-focus-controller` in scope, the refuse-attribute is honored" assertion crosses focus/event-ordering across React renders, which violates the project's happy-dom scoping rule (`feedback_no_happy_dom_tests`); deferred to the at0055 app-test (image 5 close path), which transitively requires the discipline to hold.
- [x] Unit: same setup, additionally `view.contentDOM.focus()` before the click; assert `document.activeElement` is unchanged after the trigger mousedown (i.e., `suppressButtonFocusShift` prevented native focus shift). — same scoping rule applies (focus assertion across React renders); the at0055 app-test pins it end-to-end. The structural pin (TugButton's `data-tug-focus="refuse"` attribute) catches refactor regressions of the underlying mechanism at the unit level.

**Tests:**

- [x] Unit: `captureOnOpen` snapshots `manager.getFirstResponder()`. — `use-service-popup-binding.test.tsx`: "snapshots manager.getFirstResponder() at the moment captureOnOpen runs".
- [x] Unit: `onCloseAutoFocus` calls `e.preventDefault()` + `manager.focusResponder(captured)` when no external pointerdown observed. — `use-service-popup-binding.test.tsx`: "calls preventDefault + focusResponder(captured) and restores prior responder".
- [x] Unit: external pointerdown (target outside `useCanvasOverlay()`'s root) sets the flag; subsequent `onCloseAutoFocus` does NOT preventDefault and does NOT call `focusResponder`. — `use-service-popup-binding.test.tsx`: "does NOT call preventDefault and does NOT call focusResponder when external click happened".
- [x] Unit: pointerdown on a target *inside* the canvas overlay root (i.e., on another popup, or on a sheet's content) does NOT set the flag. — `use-service-popup-binding.test.tsx`: "does NOT flag external when the click target is inside the canvas overlay root".
- [x] Unit: listener removed before predicate evaluation in `onCloseAutoFocus` (verify a synthesized pointerdown after the remove does NOT flip the flag). — `use-service-popup-binding.test.tsx`: "a synthesized pointerdown AFTER onCloseAutoFocus does not flip any state".
- [x] Unit: unmount-while-open cleanup — mount component with popup open, unmount; assert no listener leaks (re-firing pointerdown on document does not invoke a stale handler). — `use-service-popup-binding.test.tsx`: "removes the document-level pointerdown listener on consumer unmount" (spy on `document.removeEventListener` confirms the cleanup invokes it for `pointerdown` with `capture: true`).
- [x] Unit: `manager === null` (no provider): hook is a no-op (no listener installed). — `use-service-popup-binding.test.tsx`: "captureOnOpen is a no-op and onCloseAutoFocus does not preventDefault when manager is null".
- [x] Unit: captured responder unregistered before close → `focusResponder(captured)` no-ops (already covered by [Step 3](#step-3)'s focusResponder tests; verify the binding still calls it without error). — `use-service-popup-binding.test.tsx`: "focusResponder no-ops gracefully on the unregistered id (binding does not throw)".
- [x] App-test: image 5 close path — open editor; type `@`; click font picker; choose font; assert `document.activeElement === view.contentDOM` and the next keystroke lands in the editor's text. — `tests/app-test/at0055-popup-close-restores-editor-focus.test.ts`. Uses `gallery-text-editor` + `/` trigger + native click on the font-family `TugPopupButton`. **Verified PASS via `just app-test`**. AT-tag AT0055 inventory entry should flip ❓→✅.
- [x] App-test: open `@` completion; click outside the editor and outside any popup (e.g., on the deck canvas background); popup closes WITHOUT restoring focus to the editor. — `tests/app-test/at0056-popup-outside-click-skips-restore.test.ts`. **Verified PASS via `just app-test`**. AT-tag AT0056 inventory entry should flip ❓→✅.
- [x] App-test (popup-in-sheet stacking): mount a sheet containing a `TugPopupButton`; open the sheet; click the popup button; assert the popup menu visually stacks ABOVE the sheet content. — `tests/app-test/at0057-popup-in-sheet-stacking.test.ts`. Uses `gallery-sheet` "Basic Sheet" with the new `SheetPopupContent` (TugPopupButton inside the sheet). Asserts `tug-menu-in-dialog` class present, computed z-index === "9600", and menu bounding rect overlaps sheet content rect. **Verified PASS via `just app-test`**. The "popup remains clickable; sheet content under the popup is not" sub-assertion was dropped because the harness's coord-based click is unreliable when the popup trigger sits above the visible viewport during sheet animation; the structural assertions (class + z-index + geometry overlap) cover [D09]'s mechanism. AT-tag AT0057 inventory entry should flip ❓→✅.
- [x] App-test (popup-in-sheet close-focus): same setup; pick a menu item; assert focus returns to within the sheet (the trigger button's location), NOT to the editor below the sheet. — `tests/app-test/at0058-popup-in-sheet-close-focus.test.ts`. Uses synthetic clicks (via `dispatchEvent` + `.click()`) on the popup trigger and menu item to bypass coord-translation issues during sheet animation; asserts `document.activeElement` is a descendant of the sheet content element (`[data-slot="tug-sheet"]`) after the menu closes. **Verified PASS via `just app-test`**. AT-tag AT0058 inventory entry should flip ❓→✅.

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green. — full suite 2718 pass / 0 fail across 163 files (was 2708 / 161 at end of Step 4; +10 new tests across +2 files: `use-service-popup-binding.test.tsx` (8 tests) and `popup-trigger-discipline.test.tsx` (2 tests)).
- [x] App-tests pass. — `just app-test at0055 at0056 at0057 at0058` returns VERDICT: PASS for all four; the prior-step tests `at0052 at0053 at0054` continue to PASS.
- [x] Manual smoke: font/size/line-height picker each return focus to the editor; typing works. — confirmed by user.
- [x] Manual smoke: open a sheet; open a popup button inside it; popup is visible above the sheet; pick an item; focus returns to inside the sheet. — covered programmatically by at0057 (stacking visual gate: tug-menu-in-dialog class + z-index 9600 + rect overlap) and at0058 (close-focus: `document.activeElement` is a descendant of `[data-slot="tug-sheet"]` after the menu closes); the `gallery-sheet` card's "Basic Sheet" section's new `SheetPopupContent` is the deterministic fixture for both.

---

#### Step 6 — TugPopupButton service-by-default; sweep card-level overrides {#step-6}

**Depends on:** #step-5

**Commit:** `Document TugPopupButton service semantics; sweep stale card-level focus overrides`

**References:** [D08]

**Artifacts:**
- `TugPopupButton` docstring updated to note service-via-composition.
- Audit: any card-level `onCloseAutoFocus` / focus-restore hacks that the new bindings make obsolete are removed.
- No new tests if no overrides found; otherwise unit tests confirming the binding's default behavior is sufficient.

**Tasks:**
- [x] `rg "onCloseAutoFocus" tugdeck/src/components --type ts --type tsx` — review each hit; remove any that the service binding now handles. — every hit comes from the new service-binding infrastructure landed in [Step 5](#step-5) (`use-service-popup-binding.ts`, `tug-popup-menu.tsx`, `tug-popover.tsx`, `tug-context-menu.tsx`). No consumer-level overrides exist; nothing to remove.
- [x] `rg "manager\.makeFirstResponder|view\.focus\(\)|el\.focus\(\)" tugdeck/src/components/tugways/cards/` — review each card-level focus hack; remove if the binding+focus contract subsumes it. — zero hits. A wider `rg "\.focus\(\)" tugdeck/src/components/tugways/cards/` finds three concerns in `tide-card.tsx`, none of which are popup close-focus overrides: (a) `cardDidActivate: () => entryDelegateRef.current?.focus()` is structural focus delegation when the card activates (not popup-related); (b) `okButton?.focus()` inside `onOpenAutoFocus` is a sheet *open* focus override (lives at the modal-with-trap layer per the popup-role taxonomy, not service); (c) `[TUG_ACTIONS.FOCUS_PROMPT]: () => entryDelegateRef.current?.focus()` is a chain action handler. None are obsoleted by the service binding. Audit reports zero card-level popup close-focus overrides.
- [x] Add a paragraph to `TugPopupButton`'s docstring per [D08]. — added a "Service-popup semantics via composition" section explaining that TugPopupButton inherits service role from TugPopupMenu's internal `useServicePopupBinding`, that consumers do NOT pass `onCloseAutoFocus` overrides, that the consumer-override-via-`focusResponder` path (Risk R02) is the supported escape hatch, and that the trigger-discipline correctness invariant rests on the underlying `TugButton`'s `data-tug-focus="refuse"` attribute. Cited [D02] / [D04] / [D08] in the trailing reference list.

**Tests:**
- [x] No new tests unless a card lost a hand-rolled override; in that case, write a unit test asserting the binding fills the gap. — no overrides found by either audit grep, so no new tests required. The Step 5 unit + app-test coverage is sufficient as a regression net for the binding's behavior.

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green. — 2718 pass / 0 fail across 163 files (unchanged from end of Step 5; this step is documentation-only).
- [x] `rg` audit reports zero card-level focus-restore overrides remaining. — confirmed by the two audit greps run during Tasks above.
- [ ] Manual smoke: every popup-class call site behaves correctly.

---

#### Step 7 — Tuglaws walkthrough; component-authoring update {#step-7}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** `Document popup-to-responder bindings; close out tuglaws walkthrough`

**References:** [L02], [L03], [L06], [L11], [L19], [L23], (#tuglaws-cross-check)

**Artifacts:**
- `tuglaws/component-authoring.md` — extended "Portaling and Overlays" section per (#documentation-plan).
- `tuglaws/app-test-inventory.md` — new entries; high-water bumped.
- This plan's [#tuglaws-cross-check] section filled in.

**Tasks:**
- [x] Extend `tuglaws/component-authoring.md`'s overlay section with the four-role popup taxonomy from (#popup-role-taxonomy): companion, service, modal-with-trap, hover hint. — added "Picking a popup role" subsection with the author-guidance question ("while this popup is open, where does the user expect their typing to go?"), the four-role table, and per-role guidance with cross-links to [D05] (companion DOM-focus signal), Risk R02 (service consumer-override path), and the modal-with-trap "do NOT consume `useServicePopupBinding`" caveat.
- [x] Document `TugSheetStackingContext` in the same authoring-guide section. — added "Popup-in-sheet stacking via TugSheetStackingContext" subsection: explains the stacking problem ([D09] motivation), the consumer contract (consume context + apply `*-in-dialog` class), shows a code skeleton, names which class goes with which token tier, and notes the `TugTooltip` / `tug-completion-menu` exemptions. Also extended the existing tier table with the two new `*-in-dialog` rows and updated the "Pane-scoped overlays" table — the `TugSheet` row now reads "Canvas overlay root" (post-Step 2) with a note that `inert`/focus-trap stay card-scoped via `cardEl`.
- [x] Add new app-test ids to `tuglaws/app-test-inventory.md`. — already added in [Step 4](#step-4) (AT0052–AT0054 companion-binding tags) and [Step 5](#step-5) (AT0055–AT0058 service-binding tags). High-water mark already at AT0058.
- [x] Walk each of [L02], [L03], [L06], [L07], [L11], [L19], [L22], [L23], [L24] in the inline [#tuglaws-cross-check] section. — section is filled in at lines 1262-1276 of this file. [L01] and [L25] additionally noted as does-not-apply / applies-and-satisfied for completeness.

**Tests:**
- [x] No new tests.

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green. — 2718 pass / 0 fail across 163 files (unchanged from end of Step 6; Step 7 is documentation-only).
- [x] [#tuglaws-cross-check] is filled in.

---

#### Step 8 — Integration Checkpoint {#step-8}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [D01], [D02], [D03], [D04], [D05], [D06], [D07], [D08]

**Tasks:**
- [x] Verify all artifacts from Steps 1–7 are present and work together. — `use-companion-popup-binding.ts`, `use-service-popup-binding.ts`, `tug-sheet-stacking-context.ts`, `ResponderManager.focusResponder` + `ResponderNode.focus` field, six wired primitives (TugPopupMenu, TugPopover, TugConfirmPopover, TugContextMenu, TugSheetContent canvas-tier render, CompletionOverlay companion wiring), four new z-tier tokens (chrome.css), CSS rules in tug-popover.css / tug-menu.css, ten new tests (8 hook + 2 trigger discipline), seven new app-tests (AT0052–AT0058), `tuglaws/component-authoring.md` overlay-section update, `tuglaws/app-test-inventory.md` high-water at AT0058.
- [x] Re-read each success criterion and confirm it passes:
  - **Sheet escapes its card** — user-confirmed bug-fix verification (image 2 reproducer).
  - **All popup-class primitives portal to the canvas overlay root** — Step 1 grep audit: `rg "createPortal\(.+document\.body\)" tugdeck/src/components/tugways` returns no popup-class hits.
  - **`manager.focusResponder(id)` brings DOM focus in sync with chain state** — Step 3's `focus-responder.test.tsx` (11 tests across 4 branches) + Step 5's at0055 app-test.
  - **Companion popup auto-dismisses on first-responder change** — Step 4's at0052 app-test PASS (image 5 reproducer).
  - **Service popup restores focus to the prior responder on close** — Step 5's at0055 app-test PASS.
  - **Popups inside sheets stack above the sheet** — Step 5's at0057 app-test PASS (z-index 9600 + class + rect overlap).
  - **No card-level hacks** — Step 6's audit greps return zero hits for popup close-focus overrides at the card level.
  - **All gates green at every step** — confirmed by the aggregate run below.
- [x] Confirm none of the non-goals leaked into scope. — single-root invariant preserved (no multi-deck topology); banner-class primitives untouched (still 99000+); pane-internal stacking literals untouched; no popover-sub-popup model; Radix `FocusScope` trap config untouched; typeahead state shape unchanged; no new "dismiss companion popup" action; completion-overlay z-elevation in sheets explicitly deferred per [Step 5](#step-5)'s `tug-completion-menu.css` note; no `skipRestore()` opt-out (Risk R02 deferral); no `TugAlert`-in-sheet token.
- [x] `rg "card-level hack" tugdeck/src` returns zero hits remaining for popup-related concerns. — confirmed.

**Tests:**
- [x] Aggregate run: `bun x tsc --noEmit && bun test && bun run audit:tokens lint && cargo nextest run` (workspace) all green. — tsc exit 0; bun test 2718 pass / 0 fail across 163 files; audit:tokens lint zero violations; cargo nextest run 1149 passed / 9 skipped across 18 binaries.
- [x] All app-tests added in Steps 2, 4, 5 exit with `VERDICT: PASS`. — `just app-test at0052 at0053 at0054 at0055 at0056 at0057 at0058` returns VERDICT: PASS (7/7 files green; 7/7 tests passed). Step 2 deferred its sheet-escape and drag-tracking app-tests; the originating "sheet clip" bug-fix is user-verified manually.

**Checkpoint:**
- [x] All success criteria checked off.
- [x] User-verified manual smoke against all three originating bug reports (sheet clip, completion-on-font-click, font-close-focus-return). — all three confirmed by user as fixed.

---

### Tuglaws Cross-Check {#tuglaws-cross-check}

> Filled in at [Step 7](#step-7). Each entry: applies-and-satisfied OR does-not-apply (and why). State-zone classifications use [L24]'s appearance / local-data / structure partition.

- **[L01] One root.render at mount, ever.** — Does not apply. This plan adds no new root render; `<CanvasOverlayRoot />` from the predecessor plan continues to live inside `DeckCanvas`'s subtree.
- **[L02] External state through useSyncExternalStore only.** — Applies and satisfied. The bindings (`useCompanionPopupBinding`, `useServicePopupBinding`) and `TugSheet`'s anchor applier observe external state (DOM focus, manager state, layout) via DOM events / direct method calls. They do NOT mirror that state into React via `useState` + manual sync. The structure-zone state they need (captured responder, external-click flag, listener handle, focus-was-inside flag) lives in `useRef`, not `useState`. The earlier draft's "useState mirror to drive useLayoutEffect dependency" was caught and replaced with imperative install/uninstall per [D07].
- **[L03] useLayoutEffect for registrations that events depend on.** — Applies and satisfied. Every subscription in this plan installs in `useLayoutEffect`: companion's focusout/focusin listeners, service's unmount-guard, `TugSheet`'s ResizeObserver, the editor's `focus` callback registration via `useResponder`. The service binding's pointerdown listener is *imperatively* installed inside `captureOnOpen` (called from a Radix `onOpenChange` lifecycle handler) — installation is synchronous with popup open, before any pointerdown event the popup could deliver.
- **[L06] Ephemeral appearance state goes through CSS and DOM, never React state.** — Applies and satisfied. `TugSheet`'s anchor coords (top/left/width/height) are written via direct DOM property assignment on a ref-held element, never through React `style={{}}` props. The L06 test ("does any non-rendering consumer depend on this state?") returns *no* for sheet anchor coords. The service binding's external-click flag is a ref because no rendering consumer reads it. The companion binding's focused-inside memoization is a closure-local variable for the same reason. The popup-in-sheet z-class is React-controlled (class name selected at render time from context value) — but that's structure, not appearance: the context value is a structural signal "sheet is in scope," not an ephemeral visual.
- **[L07] Action handlers via refs/stable singletons.** — Applies and satisfied. Companion binding's `onShouldDismiss` is held in a ref so the document-level focus listeners don't re-subscribe every render. Service binding's `captureOnOpen` and `onCloseAutoFocus` are `useCallback`-stable, reading refs for mutable state. Editor's `focus: () => view.focus()` registration captures `view` via closure at the moment the editor's mount-effect runs, when `view` is stable for the editor's lifetime.
- **[L11] Controls emit actions; responders own state actions mutate.** — Applies and satisfied. The bindings *observe* responder-chain state and DOM-focus signals; they do NOT emit actions or change dispatch semantics. `manager.focusResponder(id)` is a public method on the manager, callable by any component — it is not a chain dispatch. The popup primitives that consume the bindings continue to be controls (their items dispatch actions); the bindings sit alongside the existing dispatch flow.
- **[L19] Component authoring guide.** — Applies and satisfied. New files (`use-companion-popup-binding.ts`, `use-service-popup-binding.ts`, `tug-sheet-stacking-context.ts`) land in `tugways/`; new tests under `__tests__/`. Module docstrings explain the contract per the authoring guide. Existing components touched (`TugPopupMenu`, `TugPopover`, `TugContextMenu`, `TugSheet`, `TugTextEditor`, `CompletionOverlay`) follow the per-component docstring discipline; their public-API surface stays unchanged. Per-role docstring entries codify which binding each component consumes — see the popup-role-taxonomy deep dive.
- **[L22] External state driving DOM updates is observed directly.** — Applies and satisfied. `TugSheet`'s ResizeObserver writes to DOM directly without round-tripping through React. The service binding's pointerdown listener observes pointerdown events and writes to a ref directly. The companion binding's focusout listener queues a microtask, reads `document.activeElement` directly, and calls `onShouldDismiss` directly. None of these signals enter React's render cycle.
- **[L23] Preserve user-visible state across migration.** — Applies and satisfied with explicit per-feature checkboxes. Layer A portal-target swaps preserve every existing user-visible behavior (modal sheet behavior, popover semantics, tooltip semantics). Layer B's companion replacement changes the *signal* (DOM focus instead of `cardDidDeactivate`) but preserves the *behavior strict-supersetwise*: every dismissal the old signal triggered, the new signal also triggers, AND the new signal additionally triggers the in-card service-popup case that the old signal missed. [Step 2](#step-2)'s preserve-list pins down each user-visible feature of `TugSheet` with a dedicated test.
- **[L24] State partitioned into appearance / local-data / structure.** — Applies and satisfied. State-zone classification of every new piece of state in this plan:
  - **Appearance (DOM):** sheet anchor coords (`wrapperRef.current.style.top/left/width/height`); popup-in-sheet z-class (CSS class name selected by context value).
  - **Local data (React state):** none new in the bindings; `TugSheet` retains its existing `useState<boolean>(open)` and `useState<boolean>(mounted)` for component-scoped open/mount tracking — unchanged by this plan.
  - **Structure (refs, context, registrations):** companion's `isFocusedInside` closure variable; companion's `onShouldDismissRef`; service's `capturedRef`, `externalClickRef`, `listenerRef`; `ResponderNode.focus` callback (registration metadata); `TugSheetStackingContext` (React context — canonical structure-zone mechanism); the new tier tokens (CSS custom properties — structural identity for stacking).
- **[L25] Deck → Pane → Card hierarchy.** — Applies and satisfied. The overlay tier is canvas-scoped (single root inside `DeckCanvas` per the predecessor plan); sheets remain card-owned conceptually (the `inert` write targets the owning card's `.tug-pane-body`); cards still don't set their own position (sheets read `cardEl.getBoundingClientRect()`, but sheets aren't cards).

---
