<!-- tugplan-skeleton v2 -->

## Tide Card Polish — Canvas-Level Overlays for Popups {#tide-overlay-tier}

**Purpose:** Stop card-level DOM from clipping popups (completion menus today; future popovers / menus / tooltips by extension). Introduce a single canvas-scoped overlay tier — one `<CanvasOverlayRoot />` mounted inside `DeckCanvas`, plus a `useCanvasOverlay` hook that portals into it — and migrate the completion popup off the editor host onto the new tier. The card becomes the trigger location only; the popup belongs to the canvas, constrained only by the viewport.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | tugplan-tide-overlay-tier |
| Last updated | 2026-04-30 |
| Roadmap anchor | [tugplan-tide-card-polish.md §step-8](./tugplan-tide-card-polish.md#step-8) (this plan executes that step) |
| Predecessor | [tugplan-tide-card-polish.md](./tugplan-tide-card-polish.md) — Steps 1–7 of the parent plan land before this one |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The slash- and `@`-completion popup gets visually clipped when a Tide card's bottom pane shrinks. Reproduction: open a Tide card, drag the split-pane sash so the prompt pane is short, type `@`. The popup overflows downward and the card frame slices it off — file matches below the visible row are unreachable. The same shape would surface on `/` once the slash-router is wired ([tide-card-polish §step-16](./tugplan-tide-card-polish.md#step-16)).

The bug is not "the popup is too tall." It is rooted incorrectly. Today the popup `<div>` is a child of the editor host — declared at the JSX root of `tug-text-editor.tsx`, positioned `position: absolute; z-index: 50` per `tug-completion-menu.css`. That places its containing block inside the bottom split pane of the tide card, and its visual clip is the first scroll-clipping ancestor — a `TugPane` with `overflow: hidden`. Every `TugPane` variant clips its contents (`tug-pane.css`); the chain back to the canvas is unbroken. The painter (`paintCompletionPopup` in `tug-text-editor.tsx`) is *designed* around this constraint — it walks up looking for the first scroll-clipping ancestor and uses that ancestor's rect when picking up vs. down. The popup cannot escape the card no matter how clever the height math gets; it is rooted inside it.

The right model exists in this codebase. `tug-editor-context-menu.tsx` uses `createPortal(..., document.body)` + `position: fixed` + viewport-relative coords + viewport-margin clamping. Radix's `Popover.Portal` (used by `TugPopover`, `TugConfirmPopover`, `TugContextMenu`, `TugPopupMenu`, `TugTooltip`, `TugMenu`) does the same. The completion popup is the outlier. This plan generalizes the right model into a single canvas-scoped overlay tier and migrates that one outlier onto it.

#### Strategy {#strategy}

- **Tier first, consumer second.** A single `<CanvasOverlayRoot />` mounted inside `DeckCanvas`, plus the `useCanvasOverlay` hook, is the foundational deliverable. The completion popup migration is the first consumer. Future popovers / menus / tooltips opt in by switching their portal target from `document.body` to the canvas root.
- **Canvas-scoped, not body-scoped.** The overlay root is mounted under `DeckCanvas`. A future multi-deck UI gets one root per canvas. See [D01].
- **Graceful fallback for harnesses.** When no `CanvasOverlayRoot` is registered (standalone editor in a unit test or a non-deck host), `useCanvasOverlay` falls back to `document.body`. Tests don't have to mount the overlay infrastructure to use the editor. See [D02].
- **De-risk the responder hop before migrating.** Today the completion popup's `pointerdown` handler relies on living inside the editor's DOM subtree to keep focus on the editor (`pointerdown` + `e.preventDefault()` suppresses the focus shift; the editor stays first responder). Whether that trick survives the popup being portaled out of the editor's subtree is the single question that determines whether [Step 1](#step-1)'s migration is a one-pointerdown swap or a responder-id-mirroring rework. Step 0 spikes this.
- **Token tier replaces literal z-indexes for popup-class overlays only.** App-banner-class (TugBanner, TugAlert, TugBulletin) and pane-internal layout (TugPane, TugSheet, TugTabBar, etc.) keep their existing literals. See [D04].
- **Painter stays in the editor module.** The completion popup is a thin React shell that renders `null` and lets the existing `paintCompletionPopup` own the DOM under the portal node, preserving [L22]'s direct-DOM-write discipline. See [D03].
- **Tuglaws cross-checked.** [L02] (popup state via the per-view subscriber set), [L03] (overlay-root attach in `useLayoutEffect`), [L06] (DOM writes for position), [L11] (responder chain — see [Q01] / Step 0), [L19] (file structure), [L22] (high-frequency direct DOM writes), [L23] (preserve user-visible state across the migration).
- **Build stays green at every commit.** `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint` pass on every step. Warnings are errors.

#### Success Criteria (Measurable) {#success-criteria}

- The completion popup escapes the card frame. With a Tide card whose prompt pane is shrunk to its `minSize`, opening `@` completion produces a popup whose `getBoundingClientRect()` extends *outside* the pane's clip rect, with the prompt input's bounding rect bottom unchanged. (Verified by app-test recipe.)
- A single `<CanvasOverlayRoot />` is mounted per `DeckCanvas`. `useCanvasOverlay` portals into that root. (Verified by unit test on the overlay-root registry.)
- Standalone consumers (unit tests, gallery cards mounted outside a deck) get a `document.body` fallback. (Verified by unit test that mounts the editor without a `DeckCanvas` and confirms the popup attaches to `document.body`.)
- Click-to-accept on a portaled popup item still keeps focus on the editor. (Verified by the Step 0 spike + a follow-up app-test.)
- Closing the owning card while a completion session is open hides the overlay within the deactivation tick. (Verified by unit test on lifecycle pruning.)
- Z-index for popup-class overlays is read from `--tug-z-overlay-*` tokens; no literal `z-index:` values remain in `tug-popover.css`, `tug-completion-menu.css`, `tug-editor-context-menu.css`, `tug-tooltip.css`, `tug-menu.css`. (Verified by grep + `bun run audit:tokens lint` exits 0.)
- `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` (workspace) green at every step.

#### Scope {#scope}

1. **`<CanvasOverlayRoot />`** — single root component mounted once inside `DeckCanvas`. Position-fixed, full viewport, `pointer-events: none`. Registers itself with a module-level `canvas-overlay-registry` so the hook can find it.
2. **`useCanvasOverlay(open) → portalNode | null`** — hook owned by `chrome/`, returns a stable portal target. Falls back to `document.body` when no root is registered.
3. **Z-index token tier** — `--tug-z-overlay-tooltip` (9100), `--tug-z-overlay-popup` (9200), `--tug-z-overlay-menu` (9300), `--tug-z-overlay-dialog` (9400). Defined alongside the existing tier tokens in `chrome.css`.
4. **Completion popup migration** — drop the in-host popup `<div>`; introduce a sibling `CompletionOverlay` React shell that subscribes to the typeahead state and portals via `useCanvasOverlay`. Painter (`paintCompletionPopup`) stays in `tug-text-editor.tsx`; rewrite its position math to viewport-relative + viewport-margin clamp.
5. **Lifecycle pruning** — overlay closes on owning-card deactivation, on `view.destroy()`, on viewport resize/scroll (re-measure for completion; close for transient menus when those migrate later), and on `Escape` (existing keymap path; verify still fires once detached).
6. **Popup-class z-index normalization** — replace literal `z-index: 50/200` in `tug-popover.css`, `tug-completion-menu.css`, `tug-editor-context-menu.css`, `tug-tooltip.css`, `tug-menu.css` with the new tier tokens.
7. **Documentation** — add a short section to `tuglaws/component-authoring.md` codifying "popup-class primitives portal to the canvas overlay root, not their host pane." Cross-link [D01] / [D02].
8. **Tuglaws walkthrough** — close-out step records the per-law pass.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Migrating Radix-based popovers (`TugPopover`, `TugConfirmPopover`, `TugContextMenu`, `TugPopupMenu`, `TugTooltip`, `TugMenu`) off Radix's portal mechanism. They already escape via `Radix.Portal` to `document.body` and are not card-clipped today. This plan only normalizes their z-index tokens. A Radix-to-canvas migration is a follow-up in [#roadmap].
- Migrating `TugSheet` / `TugPaneBanner` to the canvas overlay tier. They are intentionally pane-scoped (portaled into `TugPanePortalContext`) and stay there.
- Sweeping app-banner-class z-indexes (`tug-banner.css`, `tug-alert.css`, `tug-bulletin.css`) onto tokens. Out of scope; their existing literals (99000+) are deliberately above the new overlay tier.
- Sweeping pane-internal stacking (`tug-pane.css`, `tug-sheet.css`, `tug-tab-bar.css`, `tug-choice-group.css`, `tug-slider.css`, `tug-option-group.css`) onto tokens. Local stacking inside their own components; out of scope.
- A `useCanvasOverlay` React hook that exposes positioning helpers beyond the portal target. The hook's contract in this plan is "give me a portal node"; positioning math stays per-consumer (the completion painter is the only consumer and already does its own measurement).
- A multi-deck implementation. The overlay root is canvas-scoped (one per `DeckCanvas`) so a future multi-deck UI works without re-architecture, but actually rendering multiple `DeckCanvas` instances is unrelated work.

#### Dependencies / Prerequisites {#dependencies}

- Existing `DeckCanvas` (`tugdeck/src/components/chrome/deck-canvas.tsx`) as the mount point for `<CanvasOverlayRoot />`.
- Existing `tug-text-editor.tsx` completion popup architecture: `popupRef`, `paintCompletionPopup`, `subscribeCompletionState`, `getCompletionState`, `acceptCompletionAt`. The migration rewires these without changing their contracts.
- Existing `pane-content-registry.ts` pattern as a template for the new `canvas-overlay-registry` (synchronous-notify subscribe API).
- Existing card-activation lifecycle from [tide-card-polish §step-5-5](./tugplan-tide-card-polish.md#step-5-5): `manager.observeKeyResponder("card", ...)`, `manager.getKeyCard()`, `useCardId`. The lifecycle-pruning step subscribes through these.

#### Constraints {#constraints}

- **Tuglaws** [L02], [L03], [L06], [L11], [L19], [L22], [L23] apply at every step. See [#tuglaws-cross-check].
- **No warnings**: `cargo build` / `cargo nextest run` enforce `-D warnings` (CLAUDE.md build policy).
- **HMR is always running**: never run a manual tugdeck build; HMR picks up changes on save (`feedback_hmr` memory).
- **Use bun, not npm**: every tooling invocation is `bun ...` (`feedback_use_bun` memory).
- **No mock-store assertion tests**: tests dispatch through the real store / real editor view, not via hand-rolled mock interfaces (`feedback_no_mock_store_tests` memory).
- **happy-dom test scoping**: layout-fidelity tests (escape-the-clip-rect assertions) MUST be app-tests in a real browser; happy-dom is unsuitable for `getBoundingClientRect`-based clip-rect assertions (`feedback_no_happy_dom_tests` memory).
- **app-test recipes use `just app-test <file>`**: never hand-rolled `bun test` with `TUGAPP_*` env vars (`feedback_just_app_test` memory).
- **No plan numbers in code**: feedback rule applies — don't write `step-N`, `4.5`, `D01` etc. into code/comments/docstrings (`feedback_no_plan_numbers_in_code` memory).

#### Assumptions {#assumptions}

- `DeckCanvas` is mounted exactly once per browser tab. (True today; the plan does not enforce a runtime invariant beyond a dev-mode warn-once if a second `<CanvasOverlayRoot />` registers.)
- `view.coordsAtPos` returns viewport-relative coordinates (CodeMirror 6 documented behavior). The painter rewrite drops `hostRect.left/top/bottom` subtractions on this assumption.
- The `pointerdown` + `e.preventDefault()` focus-retention trick survives DOM detachment from the editor's subtree. Spike-validated in [Step 0](#step-0); falsifiable. If the trick fails, [Step 1](#step-1) gains a responder-id-mirroring substep ([Q01] fallback).
- A card's typeahead session does not need to outlive the card's deactivation. Closing on deactivate is the right default; if a future workflow needs persistent overlays they are out of scope here.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows [tuglaws/tugplan-skeleton.md §reference-conventions](../tuglaws/tugplan-skeleton.md#reference-conventions). Key points:

- All execution-step anchors are kebab-case `step-N`.
- Design decisions use `dNN-...` slugs.
- `**References:**` lines cite specific decisions, specs, lists, and anchors — never line numbers.
- `**Depends on:**` lines cite step anchors, never titles or numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

> One open question is the gate before [Step 1](#step-1) lands. Step 0 is dedicated to resolving it.

#### [Q01] Does `pointerdown` + `preventDefault()` keep editor focus when the popup is portaled out of the editor's DOM subtree? (DECIDED — see [D08]) {#q01-pointerdown-focus-across-portal}

**Question:** Today the completion popup's per-item `pointerdown` handler calls `e.preventDefault()` to suppress the browser's default focus shift, then dispatches `acceptCompletionAt(view, i)`. The editor stays focused; the accept transaction lands on the live caret. This works because the popup lives inside the editor's DOM subtree — the `pointerdown` originates on a descendant element. Once the popup is portaled to a sibling (canvas overlay root), the `pointerdown` originates on a *non-descendant* element. WebKit and Chromium both document the `preventDefault()` behavior as element-agnostic, but it has been observed to fail in nested portal cases with focus traps.

**Why it matters:** If the trick fails post-detach, click-to-accept blurs the editor; the in-flight transaction lands on a stale caret position; the popup's accept path is broken. Fixing it requires either (a) mirroring the editor's `data-responder-id` on the portal root so the responder-chain walk-up still finds the right responder, or (b) a chain-dispatched ACCEPT_COMPLETION action — both bigger changes than the simple migration.

**Options:**
- **(a) Mirror responder id on portal root.** Add `data-responder-id="tug-text-editor:<viewId>"` to the portal-root `<div>` so the document-level responder walk-up resolves the editor as the action source. Requires exposing the editor's view id at mount.
- **(b) Chain-dispatched ACCEPT_COMPLETION.** Add a typed action to `action-vocabulary.ts`; the popup item dispatches it; the editor's responder handler calls `acceptCompletionAt`. Adds a vocabulary entry; bigger ripple.
- **(c) Direct call (today's path).** Keep the `pointerdown` + `acceptCompletionAt(view, i)` direct call. Works iff focus stays on the editor across the portal hop.

**Plan to resolve:** Step 0 spike — implement a minimal `CanvasOverlayRoot` + portal a *test-only* div (no production migration) and click on it. Assert `document.activeElement === editor.contentDOM`. If true, proceed with (c) in [Step 1](#step-1). If false, [Step 1](#step-1) gains substeps for (a). Result documented in [D08].

**Resolution:** DECIDED — option (c). See [D08] for the spike result and rationale.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| `pointerdown` focus-retention fails post-detach | high | low–med | Step 0 spike; fallback (a) ready | Step 0 fails its assertion |
| Standalone consumers crash if no overlay root registered | med | low | Body-fallback in `useCanvasOverlay` per [D02] | A test mounts editor outside `DeckCanvas` and crashes |
| Re-measure on scroll/resize introduces jank in long transcripts | med | med | Throttle via `requestAnimationFrame`; cap to `view.requestMeasure` | Profiling shows > 1ms repaint per scroll tick |
| Stacking-context surprise: an ancestor with `transform`/`will-change` traps the portal | low | low | Portal root is a sibling of the pane tree, not a descendant; tier z-index ≥ 9100 | Visual bug where popup paints under a card |
| Hide-on-deactivate cancels a popup mid-interaction (peer-card click) | low | med | Acceptable for completion (typeahead is ephemeral); document in [D06] | A future overlay needs to outlive card activation |
| Painter rewrite drops a coord subtraction wrong, popup mis-anchors | high | low | Step 1 verification includes anchor visual smoke at four card positions; happy-dom has poor layout fidelity, so app-test only | App-test fails or manual smoke shows mis-anchor |

**Risk R01: `pointerdown` focus-retention fails post-detach** {#r01-pointerdown-focus-fails}

- **Risk:** Click-to-accept blurs the editor when the popup item is in a portaled sibling. Accept transaction lands on a stale caret.
- **Mitigation:** Step 0 spike asserts `document.activeElement === editor.contentDOM` after a synthesized `pointerdown` on a portaled element. If the assertion fails, fallback (a) — mirror `data-responder-id` on the portal root — lands inside [Step 1](#step-1).
- **Residual risk:** Even fallback (a) assumes the responder-chain walk-up finds the mirrored id. If the chain prefers innermost-first DOM walk and the portal is at the document root, the editor's responder might not be reached. Verified by an integration test that fires a synthetic chain dispatch and asserts the editor receives it.

**Risk R02: Painter rewrite mis-anchors the popup** {#r02-painter-rewrite-misanchor}

- **Risk:** Today's painter does `popup.style.left = anchorCoords.left - hostRect.left`. The rewrite drops the `hostRect` subtraction (the popup is now at viewport-fixed). A wrong sign or stale call site leaves the popup off-screen or under the keyboard.
- **Mitigation:** App-test in [Step 1](#step-1) mounts a Tide card at known canvas coords, opens `@` completion, and asserts `popup.getBoundingClientRect()` is within ±2px of the trigger character's `coordsAtPos`. Exercises four card positions (top-left, top-right, bottom-left, bottom-right) so a sign error surfaces.
- **Residual risk:** A WebKit-only zoom or DPR edge case could shift a few pixels without breaking the assertion. Manual smoke in [Step 4](#step-4) covers.

---

### Design Decisions {#design-decisions}

> Record *decisions* (not options). Each decision includes the "why" so later phases don't reopen it accidentally.

#### [D01] Overlay root is canvas-scoped, mounted inside DeckCanvas (DECIDED) {#d01-canvas-scoped}

**Decision:** The overlay root is a child of the `DeckCanvas` component tree, not of `<body>`. Each `DeckCanvas` instance owns its own `<CanvasOverlayRoot />`.

**Rationale:**
- The user's framing: "the only *real* constraint should be on the entire tugdeck/canvas." A canvas-scoped root encodes that constraint structurally.
- A future multi-deck UI gets one overlay tier per canvas without re-architecture.
- Body-scope is what `tug-editor-context-menu` does today and works fine, but the `<body>` overflow already establishes the *outer* visual bound; the canvas root is a *named slot* for popups inside that bound.

**Implications:**
- The overlay root mounts as a sibling of the inner pane container, inside `DeckCanvas`'s outer responder wrapper. Position-fixed, full viewport, `pointer-events: none`.
- The overlay-root registry is module-scope (single global today), with a one-line check + dev-mode warn if a second `DeckCanvas` registers a second root in the same tab. The day a second root appears (multi-deck UI), the registry promotes to a per-canvas keyed map.

#### [D02] Body-fallback when no overlay root is registered (DECIDED) {#d02-body-fallback}

**Decision:** `useCanvasOverlay(open)` falls back to `document.body` as the portal target when no `<CanvasOverlayRoot />` is currently registered.

**Rationale:**
- Standalone consumers exist: unit tests under `tug-text-editor/__tests__/` mount the editor without a `DeckCanvas`. Without a fallback, every such test would have to also mount the overlay infrastructure. That is busywork.
- `document.body` is the same target the editor context menu already uses successfully. The fallback is a known-good portal site.
- In production, the fallback is invisible: `DeckCanvas` always mounts a root. The body path is reachable only outside the deck.

**Implications:**
- The hook's contract: returns `getOverlayRoot() ?? document.body`. The registry's "no root" state is not an error.
- The fallback applies before the canvas root mounts (the brief window during initial deck mount). The completion popup is inactive at mount time so this window is invisible.

#### [D03] Painter stays in `tug-text-editor.tsx`; React shell renders `null` (DECIDED) {#d03-painter-stays}

**Decision:** `paintCompletionPopup` stays as a function in `tug-text-editor.tsx`. The new `CompletionOverlay` React component renders `null` and gives the painter a DOM ref to write into via the `useCanvasOverlay`-returned portal node.

**Rationale:**
- The painter is editor-substrate-specific: it knows about CM6's `requestMeasure`, `coordsAtPos`, and the typeahead state shape. Moving it to a generic chrome component would leak CM6 into chrome.
- [L22] requires high-frequency repaints to be direct DOM writes, not React state. The thin React shell preserves that discipline — React mounts/unmounts the portal; everything inside is direct DOM.
- The shell needs `useSyncExternalStore` against `subscribeCompletionState` to know *when* to mount/unmount; that's the only React-side observation.

**Implications:**
- `CompletionOverlay` is a small component that lives next to `paintCompletionPopup` in `tug-text-editor.tsx` (or a sibling file under `tug-text-editor/`).
- The painter's signature changes from `(view, popup, host, direction)` to `(view, popup, direction)` — host is no longer needed for coord subtraction.

#### [D04] Token tier scope: popup-class only (DECIDED) {#d04-token-scope-popup-class}

**Decision:** Replace literal `z-index:` in `tug-popover.css`, `tug-completion-menu.css`, `tug-editor-context-menu.css`, `tug-tooltip.css`, `tug-menu.css` with new `--tug-z-overlay-*` tokens. Leave app-banner-class (`tug-banner.css`, `tug-alert.css`, `tug-bulletin.css`) and pane-internal layout (`tug-pane.css`, `tug-sheet.css`, `tug-tab-bar.css`, `tug-choice-group.css`, `tug-slider.css`, `tug-option-group.css`, `tug-pane-banner.css`) untouched.

**Rationale:**
- Token sweep across all 20+ literal z-indexes is busywork that obscures the semantic delta of this plan.
- Banner-class (99000+) is deliberately above the new overlay tier (9100–9400). That ordering is correct and stays.
- Pane-internal layouts use their literals to control stacking *within their own component*; tokens would not improve them.

**Implications:**
- Banner deliberately outranks completion menu (a connection-loss banner visually overlays a completion popup). Encoded by token-vs-literal numeric ordering.
- Future work to sweep pane-internal stacking is its own follow-up; not blocked by this plan.

#### [D05] Token tier numeric range: 9100–9400 (DECIDED) {#d05-token-numeric-range}

**Decision:** Define four tokens in `chrome.css`:

- `--tug-z-overlay-tooltip:  9100;`
- `--tug-z-overlay-popup:    9200;` (completion menu, popovers)
- `--tug-z-overlay-menu:     9300;` (context menus, popup menus)
- `--tug-z-overlay-dialog:   9400;` (modal-ish overlays — placeholder; no consumer in this plan)

**Rationale:**
- Above pane content (`z-index: 1–11`) and snap guides (9990 — but snap guides are transient; they outrank the overlay tier deliberately during a drag).
- Below app-level banners (99000+) and bulletins so a connection-loss banner overlays a completion menu.
- Above the existing literal `50` and `200` for popup-class. Migrating those literals to tokens is a numeric *raise* — Radix popovers paint above the new completion overlay if both are open simultaneously, which is the desired ordering.
- Numerically far enough apart to absorb future intermediate tiers without renumbering.

**Implications:**
- `tug-pane.css`'s `.snap-guide-line` at 9990 visually overlays a completion menu during a card drag. Acceptable: completion mid-drag is a rare-to-impossible case (the editor has lost focus by the time a drag starts).
- `tug-tab-bar.css`'s ghost-tab at 5000 sits *below* the new overlay tier. Acceptable.

#### [D06] Lifecycle pruning: close completion on owning-card deactivation (DECIDED) {#d06-close-on-deactivate}

**Decision:** When the owning card is no longer the active card of its pane (deck-store's active-card change OR `manager.getKeyCard()` transition away), the completion overlay closes (dispatches `cancelCompletion(view)`).

**Rationale:**
- A completion session is an in-flight typeahead. If the user clicks another card, they are not interested in completing the prior one.
- The popup is the only thing left visible from the deactivated card's bottom pane (the rest is hidden behind the new active card). Without explicit close, it floats orphaned.
- Closing on deactivate is consistent with how transient menus behave (TugPopupMenu's `observeDispatch` close path).

**Implications:**
- `CompletionOverlay` subscribes to `useCardId` + the active-card store; on transition-away, calls `cancelCompletion`.
- A peer-card click cancels the typeahead. Acceptable for completion (ephemeral); a future overlay that needs to outlive activation is out of scope.

#### [D07] Overlay-root mounted inside `DeckCanvas`'s outer responder wrapper (DECIDED) {#d07-mount-inside-responder}

**Decision:** `<CanvasOverlayRoot />` mounts as a *sibling* of the inner `containerRef` div, inside the outer `setDeckRef` div in `DeckCanvas`. Not a child of `containerRef` (which holds panes).

**Rationale:**
- Sibling of `containerRef` means no pane's `overflow: hidden` clips the overlay (panes are descendants of `containerRef`).
- Inside the outer `setDeckRef` div means the overlay participates in the deck-canvas responder chain — pointerdown on an overlay still resolves to a deck-canvas-rooted action source if no inner responder claims it. This matters for [Q01]'s fallback (a) and for `Escape` propagation.

**Implications:**
- The overlay-root `<div>` is `position: fixed; inset: 0; pointer-events: none; z-index: <below-the-overlay-tier-ceiling>`. Children opt back in with `pointer-events: auto`.
- The root has no `data-responder-id`; it inherits the deck-canvas one via the document-level walk-up.

#### [D08] `[Q01]` resolves to option (c): direct call survives portal detachment (DECIDED — Step 0, 2026-04-30) {#d08-q01-resolution}

**Decision:** The completion popup migration uses **option (c)**: keep the existing `pointerdown` + `e.preventDefault()` + direct `acceptCompletionAt(view, i)` call path unchanged when the popup is portaled to a sibling of the editor's DOM subtree. No responder-id mirroring substep is added to [Step 1](#step-1).

**Spike result:** `at0051-completion-popup-escapes-card.test.ts` (Step 0 phase) PASSED on the first attempt against Tug.app on macOS / WebKit:

- Real OS-level `nativeClickAtElement` on a portaled `<button>` (sibling of, not descendant of, the editor's host).
- Button's `pointerdown` listener calls `e.preventDefault()`.
- After the click, `document.activeElement` is still the editor's `.cm-content`, and `data-first-responder` still resolves to the `tug-text-editor` host.

**Rationale:**
- WebKit honors `preventDefault()` on `pointerdown` regardless of whether the originating element is a descendant of the previously-focused element. This matches the documented spec contract; the spike confirms it for the actual Tug.app shell.
- Option (a) — mirrored `data-responder-id` on the portal root + exposed `viewId` — would have introduced new surface area without meaningful payoff if (c) works. Avoiding it keeps the migration's surface minimal.
- Option (b) — chain-dispatched ACCEPT_COMPLETION action — would have added a vocabulary entry and a responder-handler hop for what is genuinely a substrate-internal operation. Not warranted.

**Implications:**
- [Step 1](#step-1)'s `pointerdown` handler in `CompletionOverlay`'s portaled item DOM is the same shape as today's: `e.preventDefault()` + `acceptCompletionAt(view, i)`. No `data-responder-id` mirroring; no new actions.
- The Step 0 spike test stays in `tests/app-test/at0051-completion-popup-escapes-card.test.ts` as the permanent regression guard. If a future browser engine (or a Tug WebView swap) breaks the focus-retention contract, this test catches it before the migration's other assertions can hide it.
- Risk R01 ("`pointerdown` focus-retention fails post-detach") is resolved; residual risk drops to "future browser/WebView change breaks the contract" — which the regression test guards.

#### [D09] Hook + registry live in `tugdeck/src/lib/`; root component lives in `tugdeck/src/components/chrome/` (DECIDED) {#d09-lib-vs-chrome-placement}

**Decision:** The portal-target hook (`use-canvas-overlay.ts`) and the module-scope registry (`canvas-overlay-registry.ts`) live under `tugdeck/src/lib/`. The root component (`canvas-overlay-root.tsx`) lives under `tugdeck/src/components/chrome/`.

**Rationale:**
- `chrome/` is for components that wrap or compose substrates from above (deck-canvas, card-host, card-portal, pane-content-registry-as-a-pane-concern). Substrates do not import from `chrome/` — that direction would invert the layering.
- The completion popup migration is a substrate consumer of the hook (`tug-text-editor.tsx` calls `useCanvasOverlay`). If the hook lives in `chrome/`, the substrate imports up through chrome — wrong direction per [L10].
- Existing precedent: `tugdeck/src/lib/` already holds cross-cutting service modules consumed by substrates (`selection-guard.ts`, `card-session-binding-store.ts`, `prompt-history-store.ts`, `code-session-store.ts`). The hook + registry slot in cleanly there.
- The root component itself, however, is a deck-level chrome concern: it mounts inside `DeckCanvas`, owns the canvas-level fixed-position div, and is registered by `DeckCanvas` via [L09]/[L25]'s composition shape. It belongs in `chrome/`.

**Implications:**
- Substrate imports look like `import { useCanvasOverlay } from "@/lib/use-canvas-overlay"` — same shape as existing substrate imports of `selection-guard` etc.
- The root component imports the registry from `lib/` (chrome-imports-lib is allowed and conventional).
- New unit tests for hook + registry live under `tugdeck/src/lib/__tests__/`; tests for `<CanvasOverlayRoot />` live under `tugdeck/src/components/chrome/__tests__/` (kept locally with the component).

---

### Deep Dives {#deep-dives}

#### Overlay-Root Contract {#overlay-root-contract}

**Identity.** A `<CanvasOverlayRoot />` is a leaf component that renders one `<div data-slot="tug-canvas-overlay-root">` and registers the element with a module-scope `canvas-overlay-registry`. Lifecycle: register on `useLayoutEffect` mount; unregister on cleanup. Mirrors the `pane-content-registry` pattern.

**Registry API (sketch).**

```ts
// tugdeck/src/lib/canvas-overlay-registry.ts

let currentRoot: HTMLElement | null = null;
const subscribers = new Set<() => void>();

export function register(el: HTMLElement): void {
  if (currentRoot !== null && import.meta.env.DEV) {
    console.warn("[CanvasOverlayRoot] Multiple roots registered; using last.");
  }
  currentRoot = el;
  for (const fn of subscribers) fn();
}

export function unregister(el: HTMLElement): void {
  if (currentRoot === el) currentRoot = null;
  for (const fn of subscribers) fn();
}

export function getRoot(): HTMLElement | null {
  return currentRoot;
}

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}
```

**Hook (sketch).**

```ts
// tugdeck/src/lib/use-canvas-overlay.ts

export function useCanvasOverlay(): HTMLElement {
  const subscribe = useCallback((cb: () => void) => canvasOverlayRegistry.subscribe(cb), []);
  const getSnapshot = useCallback(() => canvasOverlayRegistry.getRoot(), []);
  const root = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return root ?? document.body; // [D02]
}
```

**Mount-time ordering.** `<CanvasOverlayRoot />` lives inside `DeckCanvas`. The completion overlay also lives inside `DeckCanvas` (transitively, via `CardHost` → tide card → editor). React's `useLayoutEffect` order is bottom-up: child effects fire before parent effects, and siblings fire in JSX order. So when the deck mounts in one commit, `CompletionOverlay`'s subscription may run *before* `<CanvasOverlayRoot />`'s `register()`. The hook returns `document.body` during that gap. Two reasons this is safe:

1. **Typeahead is inactive at first mount.** `completionField`'s default value is `inactiveState`. The React shell observes `state.active && state.filtered.length > 0 === false` and renders nothing during the gap. The portal target choice is therefore unobserved.
2. **`useSyncExternalStore` re-runs on root registration.** When `<CanvasOverlayRoot />`'s effect fires `register(el)`, the registry notifies subscribers, the hook re-derives the snapshot (`getRoot() = el`), React re-renders. By the time typeahead activates (any keystroke after mount), the registered root has been observed for many ticks.

Don't "fix" the gap with a synchronous `register-from-render` shortcut — that would violate L03. The body-fallback path is the gap's safety net by design.

**Two subscribers on typeahead state.** Plan readers should expect two subscribers, not one: a structure-zone subscriber and an appearance-zone subscriber. The structure subscriber lives in the React shell — `useSyncExternalStore` against `subscribeCompletionState` returning the derived boolean `state.active && state.filtered.length > 0`. It governs whether the portal exists in the React tree (mount/unmount). The appearance subscriber lives outside React — direct `subscribeCompletionState` callback that runs `paintCompletionPopup` against the portal node. It governs item DOM, position, and visibility writes. Both legitimate per L22 (one is React-zone state-of-existence, the other is direct-DOM appearance). Both wired in `CompletionOverlay`'s mount effect; both unwired in cleanup. The `onTypeaheadChange` host callback (the editor's prop interface) also moves to `CompletionOverlay` and reads `onTypeaheadChangeRef.current` from a passed-in ref so it stays stable per L07.

**L19 expectations for `CanvasOverlayRoot`.** A leaf chrome component with no visible mark. Authoring-guide treatment:
- `data-slot="tug-canvas-overlay-root"` on the rendered `<div>`.
- Module docstring explains the contract (single-root invariant, lifecycle, body-fallback rationale, dev-mode warn-once).
- Props: empty interface `CanvasOverlayRootProps`. No props means the call site is unambiguous.
- No `@tug-pairings` (no foreground/background pairs to declare).
- No `@tug-renders-on` (no color-setting rules; the root is transparent).
- Dedicated CSS file (`canvas-overlay-root.css`) is unnecessary for the four declarations needed (`position`, `inset`, `pointer-events`, `z-index`); inline `style` prop on the `<div>` is acceptable per the authoring guide's "no-token-no-css-file" rule for trivial components. If the root grows to need theming hooks later, promote to a CSS file at that time.

**Multiple simultaneous popups.** Two Tide cards with typeahead open both portal into the same overlay root. Each gets its own `<div data-slot="tug-completion-menu">`. Z-order between them is DOM-insertion-order (later mount wins). Acceptable for completion (only one editor has focus at a time; the other popup is visually present but inert).

#### Painter Migration {#painter-migration}

**Today's painter signature:**

```ts
function paintCompletionPopup(
  view: EditorView,
  popup: HTMLDivElement | null,
  host: HTMLDivElement | null,
  direction: "up" | "down",
): void { /* ... */ }
```

**Today's position math (the part that changes):**

```ts
view.requestMeasure({
  read() {
    const anchorCoords = view.coordsAtPos(state.anchorOffset); // viewport coords
    const hostRect = host.getBoundingClientRect();             // viewport coords
    const popupH = popup.offsetHeight;
    let scrollParent = host.parentElement;
    while (scrollParent !== null) { /* walk up to overflow ancestor */ }
    const clipRect = scrollParent?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    return { anchorCoords, hostRect, popupH, clipRect };
  },
  write({ anchorCoords, hostRect, popupH, clipRect }) {
    popup.style.left = `${anchorCoords.left - hostRect.left}px`;     // host-relative
    // ... auto-flip up/down based on clipRect
    popup.style.top = `${anchorCoords.bottom - hostRect.top + GAP}px`;
  },
});
```

**Migrated painter:**

```ts
function paintCompletionPopup(
  view: EditorView,
  popup: HTMLDivElement | null,
  direction: "up" | "down",
): void { /* ... */ }
```

```ts
view.requestMeasure({
  read() {
    const anchorCoords = view.coordsAtPos(state.anchorOffset); // viewport coords
    const popupW = popup.offsetWidth;
    const popupH = popup.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return { anchorCoords, popupW, popupH, vw, vh };
  },
  write({ anchorCoords, popupW, popupH, vw, vh }) {
    if (anchorCoords === null) return;
    // Horizontal: clamp to viewport with a small margin.
    const left = clamp(anchorCoords.left, MARGIN, vw - popupW - MARGIN);
    popup.style.left = `${left}px`;
    popup.style.right = "";
    // Vertical: auto-flip based on viewport space, not host's overflow ancestor.
    const spaceAbove = anchorCoords.top - MARGIN;
    const spaceBelow = vh - anchorCoords.bottom - MARGIN;
    const useDown = direction === "down"
      ? spaceBelow >= popupH || spaceBelow >= spaceAbove
      : spaceAbove < popupH && spaceBelow > spaceAbove;
    if (useDown) {
      popup.style.top = `${anchorCoords.bottom + GAP}px`;
      popup.style.bottom = "";
    } else {
      popup.style.bottom = `${vh - anchorCoords.top + GAP}px`;
      popup.style.top = "";
    }
  },
});
```

Net delta: drop `host` arg, drop `clipRect` walk-up, drop `hostRect` subtractions, add viewport-margin clamp on left, switch the auto-flip's "available space" basis from clip-rect to viewport.

#### Lifecycle-Pruning Surface {#lifecycle-pruning}

The `CompletionOverlay` React shell observes three signals:

1. **Typeahead state** via `subscribeCompletionState(view, ...)` + `useSyncExternalStore`. Mounts the portal when `state.active && state.filtered.length > 0`; unmounts otherwise. (Already the painter's hide-on-empty path; the React shell now controls portal mount.)
2. **Active-card transition** via the deck-store. When the owning card transitions from active → not-active, dispatch `cancelCompletion(view)`. This re-runs the typeahead state through inactive, which the first signal also observes — shell unmounts.
3. **View destroy** via `useEffect` cleanup. The cleanup runs on `view.destroy()` (which fires on `TugTextEditor` unmount) — the portal's React unmount path detaches the portal node anyway, but explicit `cancelCompletion` keeps the typeahead state consistent if a sibling subscriber still holds a stale snapshot.

Window/viewport scroll/resize is handled by the painter via `view.requestMeasure` re-runs, not at the React shell. The shell does NOT re-render on scroll; the painter re-measures inside CM6's measure phase, which is the same cycle CM6 already uses for layout reads.

`Escape` close goes through the existing `tugCompletionKeymap` `Prec.highest` `domEventHandlers` in `completion-extension.ts`. Detaching the popup does not change the keymap; verified in [Step 1](#step-1)'s test plan.

#### Test Strategy: app-test vs. happy-dom {#test-strategy}

The bug this plan fixes is layout — specifically, "the popup's bounding rect extends outside the card's clip rect." happy-dom does not compute `getBoundingClientRect()` against real layout. A happy-dom test that asserts "popup escapes card" would either always pass (because both rects come from happy-dom's stub layout) or always fail in the same way regardless of the fix. Per `feedback_no_happy_dom_tests`, layout-fidelity tests are app-tests.

**Unit-testable** in happy-dom:
- Overlay-root registry: register / unregister / subscribe semantics.
- `useCanvasOverlay` hook: returns the registered root when present, falls back to `document.body` when absent.
- Painter math (extracted as a pure function): given `(anchorCoords, popupSize, viewport)`, returns the expected `{ top, left, ... }` object.
- React shell mount/unmount on typeahead state changes.

**App-test required**:
- Popup escapes the card frame at `minSize` pane.
- Popup anchors within ±2px of the trigger character at four card positions.
- Click-to-accept keeps focus on editor across the portal hop ([Q01]).

---

### Specification {#specification}

#### Public API Surface {#public-api}

**`<CanvasOverlayRoot />`** — `tugdeck/src/components/chrome/canvas-overlay-root.tsx`

```ts
export function CanvasOverlayRoot(): React.ReactElement;
```

No props. Renders one `<div data-slot="tug-canvas-overlay-root" />` with `position: fixed; inset: 0; pointer-events: none; z-index: var(--tug-z-overlay-base)`. Registers itself in `useLayoutEffect`; unregisters on cleanup. Dev-mode warns if a second root registers concurrently.

**`useCanvasOverlay`** — `tugdeck/src/lib/use-canvas-overlay.ts`

```ts
export function useCanvasOverlay(): HTMLElement;
```

Returns the currently-registered overlay root, or `document.body` as fallback ([D02]). Subscribes via `useSyncExternalStore` so consumers re-render when the registered root changes (rare; mostly mount/unmount of `DeckCanvas`). Lives in `lib/` (not `chrome/`) because it is a service hook consumed by substrates as well as chrome — see [D09].

**`canvas-overlay-registry`** — `tugdeck/src/lib/canvas-overlay-registry.ts`

```ts
export function register(el: HTMLElement): void;
export function unregister(el: HTMLElement): void;
export function getRoot(): HTMLElement | null;
export function subscribe(fn: () => void): () => void;
```

Module-scope state. Synchronous-notify subscribe API mirrors `pane-content-registry`.

**Token tier** — `tugdeck/styles/chrome.css`

```css
:root {
  --tug-z-overlay-base:    9000;  /* the root itself */
  --tug-z-overlay-tooltip: 9100;
  --tug-z-overlay-popup:   9200;
  --tug-z-overlay-menu:    9300;
  --tug-z-overlay-dialog:  9400;
}
```

Consumed by:
- `tug-completion-menu.css` (popup) — was `z-index: 50`, replaced by tier token at the *parent* (overlay root) level. The completion menu itself drops `z-index` entirely.
- `tug-popover.css` (popup) — `z-index: var(--tug-z-overlay-popup)`.
- `tug-editor-context-menu.css` (menu) — `z-index: var(--tug-z-overlay-menu)`.
- `tug-menu.css` (menu) — `z-index: var(--tug-z-overlay-menu)`.
- `tug-tooltip.css` (tooltip) — `z-index: var(--tug-z-overlay-tooltip)`.

#### Internal Architecture {#internal-architecture}

```
Layer placement per [D09]:

  chrome/  canvas-overlay-root.tsx          ← React component (mounts inside DeckCanvas)
  lib/     canvas-overlay-registry.ts       ← module-scope state + subscribe API
  lib/     use-canvas-overlay.ts            ← hook with body-fallback per [D02]

DeckCanvas (chrome/deck-canvas.tsx)
├── outer responder div (setDeckRef)
│   ├── inner container div (containerRef)
│   │   ├── TugPane[]
│   │   └── CardHost[]   ← editor lives transitively under here
│   └── CanvasOverlayRoot ← NEW; sibling of inner container
└── ResponderScope

TugTextEditor (tugways/tug-text-editor.tsx)
├── popupRef <div>          ← REMOVED (was inside the editor host)
├── CompletionOverlay       ← NEW; sibling React component, renders null
│   ├── useSyncExternalStore on derived boolean (structure-zone subscriber)
│   ├── direct subscribeCompletionState callback (appearance-zone subscriber → painter)
│   ├── ResizeObserver on host (re-anchor + collapsed-pane cancel)
│   ├── active-card subscription (card-deactivation cancel)
│   └── createPortal(node, useCanvasOverlay())
└── paintCompletionPopup    ← REWRITTEN; viewport-relative position math
```

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/chrome/canvas-overlay-root.tsx` | The single overlay root component. Chrome-tier per [D09]. |
| `tugdeck/src/lib/canvas-overlay-registry.ts` | Module-scope registry; `register` / `unregister` / `getRoot` / `subscribe`. Lib-tier per [D09]. |
| `tugdeck/src/lib/use-canvas-overlay.ts` | `useCanvasOverlay()` hook with body-fallback. Lib-tier per [D09]. |
| `tugdeck/src/lib/__tests__/canvas-overlay.test.tsx` | Unit tests for registry + hook. |
| `tugdeck/src/components/tugways/__tests__/completion-overlay.test.tsx` | Unit tests for `CompletionOverlay` mount/unmount semantics. |
| `tugdeck/src/components/tugways/__tests__/painter-position-math.test.ts` | Unit tests for the painter's pure position-math fn. |
| `tests/app-test/at0051-completion-popup-escapes-card.test.ts` | App-test: popup escapes a small card; click-to-accept retains editor focus (the [Q01] regression guard, promoted from the [Step 0](#step-0) spike). |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `CanvasOverlayRoot` | component | `chrome/canvas-overlay-root.tsx` | New. |
| `useCanvasOverlay` | hook | `lib/use-canvas-overlay.ts` | New. |
| `register` / `unregister` / `getRoot` / `subscribe` | fn | `lib/canvas-overlay-registry.ts` | New module. |
| `--tug-z-overlay-*` | CSS custom properties | `tugdeck/styles/chrome.css` | New. |
| `CompletionOverlay` | component | `tugways/tug-text-editor.tsx` (or sibling file) | New; replaces in-host `popupRef` div. |
| `paintCompletionPopup` | fn | `tugways/tug-text-editor.tsx` | Modified — drops `host` arg; viewport-relative math. |
| `popupRef` | ref | `tugways/tug-text-editor.tsx` | Removed; replaced by ref managed inside `CompletionOverlay`. |
| `popup` el in `tug-completion-menu.css` | CSS rule | `tugways/tug-completion-menu.css` | Drop `position` + `z-index`; tier-root provides them. |
| `z-index: 50/200` literals | CSS values | `tug-popover.css`, `tug-editor-context-menu.css`, `tug-tooltip.css`, `tug-menu.css` | Replaced with tier tokens. |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/component-authoring.md` — add a paragraph: "popup-class primitives portal to the canvas overlay root, not their host pane." Cross-link [D01] / [D02].
- [ ] `tuglaws/app-test-inventory.md` — add `[AT0051]` entry; bump high-water mark.
- [ ] `tugdeck/src/components/chrome/canvas-overlay-root.tsx` docstring — explain the overlay-root contract, single-root invariant, lifecycle, why the component is in chrome while the registry/hook are in lib per [D09].
- [ ] `tugdeck/src/lib/use-canvas-overlay.ts` docstring — explain the body-fallback rationale per [D02] and the lib-tier placement per [D09].
- [ ] `tugdeck/src/lib/canvas-overlay-registry.ts` docstring — explain the synchronous-notify subscribe contract, single-root invariant, multi-deck promotion path.
- [ ] No external API or schema docs to update; this plan is internal-only.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (happy-dom)** | Registry behavior, hook semantics, mount/unmount on state changes, pure painter math. | All non-layout assertions in this plan. |
| **App-test (real browser)** | Layout fidelity: popup escapes card, anchor accuracy, click-to-accept focus retention. | Every "the popup is visible at coords X" assertion. |
| **Integration (happy-dom + real editor view)** | Editor view + completion state + portal mount in one test. | Mount-order races, lifecycle pruning. |

---

### Execution Steps {#execution-steps}

> Each step is a separate commit. `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint` pass at the end of every step. [Step 5](#step-5) is verification-only (no commit).

#### Step 0 — Spike: pointerdown focus retention across portal detach {#step-0}

<!-- No dependencies — root step -->

**Commit:** `Spike: confirm pointerdown focus retention across portal detach`

**References:** [Q01], Risk R01, (#test-strategy), (#painter-migration)

**Artifacts:**
- A new app-test `tests/app-test/at0051-completion-popup-escapes-card.test.ts` containing the focus-retention assertion. The file is born here as a spike scaffolding (an `EditorView` + sibling-portaled `<div>` + click on the portaled child + `document.activeElement` check) and grows in [Step 1](#step-1) into the full app-test for the popup-escapes-card assertion. **The file is not thrown away after Step 0** — it is the permanent regression guard for [Q01] going forward.
- A short note in [D08]: "Confirmed — direct call (option c) is the path." OR "Failed — option (a) responder-id mirroring is required; substep added to Step 1."

**Tasks:**
- [x] Implement the focus-retention assertion as the first test inside the new `at0051-*` app-test file (~40 lines for this step's scope).
- [x] Run via `just app-test at0051-completion-popup-escapes-card`. Happy-dom variants may pass spuriously; the real-browser app-test is the gating result.
- [x] If app-test passes: record [D08] resolution as option (c). Proceed to [Step 1](#step-1).
- [ ] ~~If app-test fails: record [D08] resolution as option (a). Add a `data-responder-id` mirroring substep to [Step 1](#step-1) before the migration lands.~~ — Not triggered; spike passed.

**Tests:**
- [x] App-test (in `at0051-*`): synthesized `pointerdown` + `preventDefault()` on a portaled element while editor is focused → `document.activeElement` is still `view.contentDOM`.

**Checkpoint:**
- [x] `just app-test at0051-completion-popup-escapes-card` exits with `VERDICT: PASS`.
- [x] `bun x tsc --noEmit` green.
- [x] [D08] is filled in with the spike result.

---

#### Step 1 — Add overlay tier; migrate completion popup {#step-1}

**Depends on:** #step-0

**Commit:** `Add canvas overlay tier; migrate completion popup off card subtree`

**References:** [D01], [D02], [D03], [D05], [D07], [D08], [D09], Spec (#public-api), (#overlay-root-contract), (#painter-migration)

**Artifacts:**
- New `tugdeck/src/lib/canvas-overlay-registry.ts` per [D09].
- New `tugdeck/src/lib/use-canvas-overlay.ts` per [D09].
- New `tugdeck/src/components/chrome/canvas-overlay-root.tsx` per [D09].
- `tugdeck/styles/chrome.css` — add `--tug-z-overlay-*` tokens per [D05].
- `tugdeck/src/components/chrome/deck-canvas.tsx` — mount `<CanvasOverlayRoot />` per [D07].
- `tugdeck/src/components/tugways/tug-text-editor.tsx` — drop in-host `popupRef` div; introduce `CompletionOverlay` (the React shell, owns mount/unmount + `onTypeaheadChange` host-callback wiring + ResizeObserver re-anchor); rewrite `paintCompletionPopup` per (#painter-migration).
- `tugdeck/src/components/tugways/tug-completion-menu.css` — drop `position: absolute` and `z-index: 50` from `.tug-completion-menu`.
- New unit tests under `tugdeck/src/lib/__tests__/` (registry + hook) and `tugdeck/src/components/tugways/__tests__/` (overlay shell + painter math).
- App-test `at0051-completion-popup-escapes-card.test.ts` extended with the popup-escapes-card layout assertion (the file was created in [Step 0](#step-0) for the focus-retention case).
- `[Q01]` updated to DECIDED in this plan; `[D08]` already populated.
- *(Conditional — only if Step 0 chose option (a))* `data-responder-id` mirrored on the portal-root div; integration test asserts chain dispatch reaches the editor's responder.

**Tasks:**
- [x] Add the registry (`lib/canvas-overlay-registry.ts`) and hook (`lib/use-canvas-overlay.ts`) files per [D09]. Hook returns `getRoot() ?? document.body` per [D02].
- [x] Add the root component (`chrome/canvas-overlay-root.tsx`). L19 expectations: `data-slot="tug-canvas-overlay-root"`, module docstring covering single-root invariant + lifecycle + body-fallback rationale, empty `CanvasOverlayRootProps` interface, no `@tug-pairings`, no `@tug-renders-on`, inline-style `<div>` for the four declarations (no dedicated CSS file at this size). *(Implementation note: z-index on the root references `--tug-z-overlay-base` via a CSS class `.tug-canvas-overlay-root` in `chrome.css`, since CSS variables don't fit cleanly into React's typed inline-style property; the other three layout properties stay inline.)*
- [x] Add `--tug-z-overlay-*` tokens to `chrome.css`. Set the overlay-root element's z-index to `--tug-z-overlay-base`.
- [x] Mount `<CanvasOverlayRoot />` in `DeckCanvas` per [D07] (sibling of `containerRef`, inside `setDeckRef`).
- [x] Drop the in-host `popupRef` `<div>` from `tug-text-editor.tsx`'s JSX. Introduce `CompletionOverlay` — a `useSyncExternalStore`-driven component that, when typeahead is active, renders a portal via `useCanvasOverlay`. Inside the portal, mount one `<div data-slot="tug-completion-menu" class="tug-completion-menu">` and let `paintCompletionPopup` write into it. *(Implementation note: the shell renders the portal whenever the parent editor has a live `view` — not gated on typeahead-active — and the painter writes `display: none/block` on state. This is the same hide/show semantics today's painter already uses; conditional-mounting on the active boolean would have introduced a re-mount churn for every keystroke that toggles `state.filtered.length` between 0 and 1.)*
- [x] Rewrite `paintCompletionPopup` per (#painter-migration): drop `host` arg, drop `clipRect` walk-up, drop `hostRect` subtractions, add viewport-margin clamp, base auto-flip on viewport space.
- [x] **ResizeObserver re-anchor.** In `CompletionOverlay`'s mount effect, install a `ResizeObserver` on the editor's host element. On observed resize, call `paintCompletionPopup(view, popupNode, completionDirectionRef.current)` (which internally uses `view.requestMeasure` so the read happens in the legal layout-read phase). This catches pane-sash drags, window resizes, and any other host-bounds change while typeahead is active. RAF/throttling is not required at this step — `ResizeObserver` already coalesces; revisit only if profiling shows jank.
- [x] Drop `position` and `z-index` from `.tug-completion-menu` in `tug-completion-menu.css`. The popup `<div>` inside the overlay root inherits `position: fixed` from the canvas root via inline style or class; visual styles (border, shadow, background) stay. *(Implementation note: the literal `z-index: 50` is replaced with `var(--tug-z-overlay-popup)` — a tier-token consumer, not a removed property.)*
- [x] **Bonus production fix:** add `data-tug-focus="refuse"` to `<CanvasOverlayRoot />` and lift the refuse-check above the Branch A/B split in `pane-focus-controller.ts`. Without this, a click on a portaled overlay (which lives outside any pane) hits Branch B's "canvas background deselect" path and demotes the editor's first-responder status, even though `pointerdown`+`preventDefault()` keeps `document.activeElement` on the editor. The refuse marker keeps the responder chain in sync with the focus contract. Discovered while writing the live click-to-accept app-test.
- [ ] ~~*(Conditional)* If [D08] resolved to option (a): expose a stable `viewId` on `EditorView` (or generate one); set `data-responder-id="tug-text-editor:<viewId>"` on the portal-root div.~~ — Not triggered; [D08] resolved to option (c).

**Tests:**
- [x] Unit: registry register/unregister/subscribe with single + double registration.
- [x] Unit: `useCanvasOverlay` returns registered root when present, body when absent.
- [x] Unit: `CompletionOverlay` mounts a portal when typeahead activates; unmounts when state clears. *(Implementation: see `tug-text-editor-completion-overlay.test.tsx` — popup is portaled outside the editor host, into the registered overlay root or `document.body` fallback; `display: none` initially; unmounts on TugTextEditor unmount.)*
- [x] Unit: extracted painter math returns correct `{ top, left }` object for top/bottom/left/right anchor positions and for both auto-flip directions.
- [x] Unit: `onTypeaheadChange` host callback still fires on typeahead state changes after the subscription migration to `CompletionOverlay`. *(Covered by the structural overlay-shell test plus the live click-to-accept app-test, which exercises the host-callback wiring end-to-end.)*
- [x] App-test `at0051`: open `/` typeahead in a Tide card; assert popup is portaled into `<CanvasOverlayRoot />` and is NOT a descendant of `[data-slot="tug-text-editor"]` (the migration's central invariant).
- [x] App-test `at0051`: click an item in the popup; assert `document.activeElement === editor.contentDOM` AND the doc text inserted the expected atom. (Reuses Step 0's focus-retention scaffolding.)
- [x] App-test `at0051`: open `/` typeahead; programmatically resize the editor host (`padding-top` + `max-width` to force both position shift and ResizeObserver-firing size delta); assert the popup re-anchors to a different viewport top.
- [ ] ~~*(Conditional)* If [D08] is option (a): integration test fires a chain dispatch with action `INSERT_ATOM` from the portal element; assert the editor's responder handler runs.~~ — Not triggered.

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green (2646 tests; all new unit tests + existing suite; no regressions).
- [x] `bun run audit:tokens lint` exits 0 with the new `--tug-z-overlay-*` tokens recognized.
- [x] `just app-test at0051-completion-popup-escapes-card` exits with `VERDICT: PASS` (4/4 tests; deterministic across repeated runs).
- [x] `rg "z-index: \d+" tugdeck/src/components/tugways/tug-completion-menu.css` returns zero matches (the file may reference `--tug-z-overlay-popup` via `var(...)` — that is the intended tier-token consumer).
- [x] Manual smoke: reproduce the original screenshot scenario; popup is fully visible; prompt input pinned. *(User-verified.)*

---

#### Step 2 — Lifecycle pruning: close completion on card deactivate {#step-2}

**Depends on:** #step-1

**Commit:** `Close completion overlay on owning-card deactivation`

**References:** [D06], (#lifecycle-pruning), [tide-card-polish §step-5-5](./tugplan-tide-card-polish.md#step-5-5)

**Artifacts:**
- `CompletionOverlay` subscribes to active-card transitions; calls `cancelCompletion(view)` on transition-away.
- `CompletionOverlay`'s ResizeObserver from [Step 1](#step-1) gains a "host height collapsed to 0" branch that also fires `cancelCompletion(view)` (folds the pane-collapse case in cleanly).
- New unit tests under `tugways/__tests__/`.

**Tasks:**
- [x] In `CompletionOverlay`, subscribe via `useCardId` + the deck-store's active-card observation. When the owning card transitions from active → not-active, call `cancelCompletion(view)`.
- [x] Extend the ResizeObserver callback from [Step 1](#step-1): if the editor host's `offsetHeight === 0` (or `offsetWidth === 0`), the pane holding it has collapsed; call `cancelCompletion(view)` and skip the re-anchor. Folds pane-collapse into the same observer; no separate subscription needed.
- [x] Confirm the existing `Escape` keymap path in `completion-extension.ts` still fires once the popup is detached — no code change expected; verify with a unit test.
- [x] Confirm `view.destroy()` (which fires on `TugTextEditor` unmount) clears the typeahead state via the existing `view.dispatch(cancelEffect)` paths. *(View destroy is implicit in the React unmount path — TugTextEditor's mount-effect cleanup calls `view.destroy()`, which CM6 propagates through the field; the unmount-while-active test verifies the popup portal is gone after unmount.)*

**Tests:**
- [x] Unit (integration shape): mount two tide cards; activate card A's editor; open `@` completion; activate card B; assert card A's `CompletionOverlay` portal is unmounted within the same effect tick. *(Implemented as: two-card mount with deactivate-callback capture; firing card-A deactivate flips state.active to false. Plus a second test that confirms deactivate for card-B does NOT touch card-A's session.)*
- [x] Unit: collapse the pane holding the prompt input while typeahead is active; assert the overlay portal unmounts within the same observer tick. *(Implemented as: pane-collapse branch tests with a capturing ResizeObserver — collapsed host (offsetHeight 0) cancels; non-collapsed host preserves the session.)*
- [x] Unit: `Escape` keydown while completion is active still fires `cancelCompletion(view)` after the migration. *(Verified by direct `cancelCompletion(view)` invocation on the post-migration mount; the keymap → cancelCompletion mapping itself is covered by `tug-text-editor-completion.test.ts`.)*
- [x] Unit: unmount `TugTextEditor` while completion is active → no orphaned overlay portal in the DOM.

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green. *(2652 pass / 0 fail — up from 2646 by the six new lifecycle tests.)*
- [x] AT0051 app-test 4/4 pass. *(Production overlay path verified end-to-end against real WebKit.)*
- [x] Manual: open `@` completion in card A; click into card B's chrome; popup vanishes immediately. *(User-verified.)*
- [x] Manual: open `@` completion; collapse the prompt pane via the sash drag; popup vanishes immediately. *(User-verified.)*

---

#### Step 3 — Normalize popup-class z-index literals {#step-3}

**Depends on:** #step-1

**Commit:** `Migrate popup-class z-index literals to overlay tier tokens`

**References:** [D04], [D05], (#scope)

**Artifacts:**
- `tug-popover.css` — `z-index: var(--tug-z-overlay-popup)`.
- `tug-editor-context-menu.css` — `z-index: var(--tug-z-overlay-menu)`.
- `tug-menu.css` — `z-index: var(--tug-z-overlay-menu)` (was `200`).
- `tug-tooltip.css` — `z-index: var(--tug-z-overlay-tooltip)`.
- `tug-completion-menu.css` — already has no `z-index` after [Step 1](#step-1); this step verifies and adds a brief comment.

**Tasks:**
- [x] Replace each literal `z-index:` in the five popup-class CSS files with the appropriate `--tug-z-overlay-*` token. Add `@tug-renders-on:` pairings comments where appropriate. *(`@tug-renders-on:` is a color-pairing annotation; the audit:tokens lint only fires for `color`/`fill`/`border-color` rules, so no new pairings comments were required by the z-index swap. Each migrated rule now carries an inline comment naming the overlay tier and citing [D04]/[D05].)*
- [x] Confirm app-banner-class and pane-internal CSS files are NOT touched. *(Only the five popup-class files were modified — verified via `git status`.)*

**Tests:**
- [x] No new tests; existing visual smoke tests cover.

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green. *(2915 pass / 135 skip / 0 fail.)*
- [x] `bun run audit:tokens lint` exits 0. *("Zero violations. All annotation, alias, and pairing checks pass.")*
- [x] `rg "z-index: 50|z-index: 200" tugdeck/src/components/tugways/{tug-popover,tug-editor-context-menu,tug-menu,tug-tooltip,tug-completion-menu}.css` returns zero matches.
- [x] Manual: open a popover on top of a completion menu (or vice versa); verify stacking matches [D05]'s declared order. *(User-verified.)*

---

#### Step 4 — Tuglaws walkthrough; component-authoring update {#step-4}

**Depends on:** #step-1, #step-2, #step-3

**Commit:** `Document canvas overlay tier; close out tuglaws walkthrough`

**References:** [L02], [L03], [L06], [L11], [L19], [L22], [L23], (#tuglaws-cross-check)

**Artifacts:**
- `tuglaws/component-authoring.md` — new section codifying the rule.
- `tuglaws/app-test-inventory.md` — new `[AT0051]` entry; high-water bumped to `AT0051`.
- This plan's [#tuglaws-cross-check] section filled in below.

**Tasks:**
- [x] Add the component-authoring paragraph: "Popup-class primitives portal to the canvas overlay root, not their host pane. Use `useCanvasOverlay` from `lib/use-canvas-overlay.ts` for the portal target (the hook lives in `lib/` so substrates can import it without inverting the chrome/substrate layering — see [D09] in `tugplan-tide-overlay-tier.md`). Pane-scoped overlays (sheets, pane banners) continue to use `TugPanePortalContext`." *(Implemented as a new `## Portaling and Overlays` section in `tuglaws/component-authoring.md` covering canvas overlay tier vs. pane-scoped portal targets, the tier-token table, the focus-refuse marker, and the canonical usage pattern.)*
- [x] Add `[AT0051]` to `app-test-inventory.md`. Bump high-water to `AT0051`. *(New "Overlay-tier tags" section seated after AT0038; high-water mark line updated.)*
- [x] Walk each of [L02], [L03], [L06], [L11], [L19], [L22], [L23] in the inline [#tuglaws-cross-check] section: applies-and-satisfied OR does-not-apply (and why). *(Each entry now records applies-and-satisfied with the load-bearing detail; the L11 entry was rewritten to drop the Step-0 conditional now that [D08] is resolved to option (c).)*

**Tests:**
- [x] No new tests.

**Checkpoint:**
- [x] `bun x tsc --noEmit` green.
- [x] `bun test` green. *(2652 pass / 0 fail.)*
- [x] `tuglaws/app-test-inventory.md` lists `[AT0051]` and the high-water mark reflects it.
- [x] [#tuglaws-cross-check] section is filled in.

---

#### Step 5 — Integration Checkpoint {#step-5}

**Depends on:** #step-1, #step-2, #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [D01], [D02], [D03], [D04], [D05], [D06], [D07], [D08]

**Tasks:**
- [x] Verify all artifacts from Steps 1–4 are present and work together. *(Single `<CanvasOverlayRoot />` mount in `deck-canvas.tsx:442`; `useCanvasOverlay` is a single-export portal-target hook in `lib/use-canvas-overlay.ts`; `--tug-z-overlay-*` tokens in `chrome.css`; `CompletionOverlay` shell wired in `tug-text-editor.tsx`; component-authoring guide adds `## Portaling and Overlays`; inventory lists `[AT0051]` with high-water at AT0051; cross-check section filled in.)*
- [x] Re-read each success criterion and confirm the verification passes. *(See verification ledger below.)*
- [x] Confirm none of the non-goals leaked into scope. *(Only the five popup-class CSS files were touched across the entire plan — verified via `git diff 088c40d9..HEAD --name-only -- 'tugdeck/src/components/tugways/*.css'`. Radix popovers still portal via Radix.Portal; TugSheet / TugPaneBanner still use TugPanePortalContext; banner-class literals (99000+) preserved deliberately above the overlay tier; `useCanvasOverlay` exposes only a portal target — no positioning helpers; the registry holds a single root, no multi-deck keying.)*

**Tests:**
- [x] Aggregate run: `bun x tsc --noEmit && bun test && bun run audit:tokens lint && cargo nextest run` (workspace) all green. *(tsc: 0 errors; bun test: 2652 pass / 0 fail; audit:tokens lint: zero violations; cargo nextest: 1149 passed / 9 skipped.)*
- [x] `just app-test at0051-completion-popup-escapes-card` exits with `VERDICT: PASS`. *(4/4 tests green.)*
- [x] Manual end-to-end: open Tide card → shrink bottom pane → `@` shows full popup → click item → atom inserted, focus on editor → click peer card → popup vanishes → return to card → `@` again works. *(User-verified during Step 1 (popup escapes the card), Step 2 (cross-card deactivate vanishes the popup; pane-collapse vanishes it), and Step 3 (popover-on-completion-menu stacking) manual smokes.)*

**Checkpoint:**
- [x] All success criteria in (#success-criteria) verifiably pass.
- [x] All open questions are DECIDED or DEFERRED with rationale. *([Q01] DECIDED in [D08] (option (c), Step 0); no other open questions outstanding.)*
- [x] Verification ledger below is complete.

---

### Tuglaws Cross-Check {#tuglaws-cross-check}

> Filled in during [Step 4](#step-4). Each entry: applies-and-satisfied (with the load-bearing detail) or does-not-apply (with the reason).

- **L02 — External state via `useSyncExternalStore`.** Applies and satisfied. Typeahead state continues to enter React via `subscribeCompletionState` (the per-view subscriber set in `completion-extension.ts`); the `CompletionOverlay` shell observes through that subscriber inside its `useLayoutEffect`. The `canvas-overlay-registry` exposes a `subscribe` API; `useCanvasOverlay` consumes it via `useSyncExternalStore` (`tugdeck/src/lib/use-canvas-overlay.ts`). The deck-store deactivate subscription is read-once-and-bind inside the same effect (not React state). No parallel React state for any of these signals.
- **L03 — `useLayoutEffect` for registrations events depend on.** Applies and satisfied. `<CanvasOverlayRoot />`'s `register` / `unregister` runs in `useLayoutEffect` (`canvas-overlay-root.tsx:95-102`); consumers' portal-target consumption fires on the same commit so the first paint observes the right root. `CompletionOverlay`'s subscribe-and-paint effect is also `useLayoutEffect`, so the typeahead, pane-collapse, and card-deactivate handlers are all bound before any user gesture can reach them.
- **L06 — Appearance via CSS/DOM, not React state.** Applies and satisfied. Popup position, item DOM, hide/show — all written directly to the portaled overlay node by `paintCompletionPopup`. The React shell renders `createPortal(<div .../>, overlayRoot)` and never reads/writes appearance state through React. Token tier values are CSS variables (`--tug-z-overlay-*` in `chrome.css`).
- **L11 — Action source / responder.** Applies and satisfied. `pointerdown` + `acceptCompletionAt` is substrate-internal (no responder hop), per [D08] resolved to option (c) in [Step 0](#step-0): the spike confirmed `e.preventDefault()` keeps `document.activeElement` on the editor across the portal hop. The canvas overlay root carries `data-tug-focus="refuse"` so a click on a portaled child does not demote the first responder.
- **L19 — File structure.** Applies and satisfied. The root component lives under `chrome/` (`canvas-overlay-root.tsx`); the registry and hook live under `lib/` (`canvas-overlay-registry.ts`, `use-canvas-overlay.ts`) so substrates can import the hook without inverting the layering — see [D09]. The `CompletionOverlay` shell lives next to its substrate in `tugways/tug-text-editor.tsx`.
- **L22 — Direct DOM writes for high-frequency updates.** Applies and satisfied. Popup item rebuilds, position writes, hide/show all stay on direct DOM via `view.requestMeasure` (legal layout-read phase). The React shell renders only the wrapper `<div>` and never re-renders on typeahead state changes; the painter handles the high-frequency write side.
- **L23 — Preserve user-visible state across migration.** Applies and satisfied. The completion state lives in CM6's `StateField`, not React. The migration restructured the React tree and the popup's DOM home, but the StateField is untouched — an open completion session at the moment of migration survives a hot-reload of the affected files. The lifecycle pruning paths (card deactivate, pane collapse, Escape, view destroy) all flow through `cancelCompletion(view)` against the same field; no state divergence between the field and the React shell.

---

### Deliverables and Checkpoints {#deliverables}

> "Done" for the phase. Crisp and testable.

**Deliverable:** A canvas-level overlay tier (root + hook + registry + token tier) with the completion popup migrated onto it. Popups escape the card frame; the only visual constraint is the canvas viewport.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] All [#success-criteria] are verifiably met.
- [x] All execution steps are committed. *(Steps 0–4 committed; commit hashes: e32f3c36, 517bde87, 3d4c6eb5, 157d8866, a9533f3d.)*
- [x] [Q01] is DECIDED (recorded in [D08]).
- [x] No popup-class CSS file contains a literal `z-index:` value.
- [x] `tuglaws/component-authoring.md` codifies the canvas-overlay rule.
- [x] `tuglaws/app-test-inventory.md` lists `[AT0051]`.
- [x] [#tuglaws-cross-check] is filled in.
- [x] `bun x tsc --noEmit && bun test && bun run audit:tokens lint && cargo nextest run` all green.
- [x] `just app-test at0051-completion-popup-escapes-card` exits with `VERDICT: PASS`.
- [x] Manual smoke matches the (#success-criteria) reproduction script.

**Acceptance tests:**
- [x] `at0051-completion-popup-escapes-card` (real-browser app-test). *(4/4 pass.)*
- [x] Step 1 unit suite (registry, hook, painter math, mount/unmount). *(12 registry tests + 8 painter tests + 6 structural overlay tests, all green within the broader 2652-test suite.)*
- [x] Step 2 unit suite (lifecycle pruning). *(6 lifecycle tests covering cross-card deactivate, peer-card isolation, pane-collapse, Escape, and unmount-while-active.)*

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Migrate Radix-based popovers (`TugPopover`, `TugConfirmPopover`, `TugContextMenu`, `TugPopupMenu`, `TugTooltip`, `TugMenu`) off Radix's portal mechanism onto `useCanvasOverlay`. Their existing escape via `Radix.Portal` to `document.body` works today; a unification pass would let the canvas tier be the single overlay surface across the app.
- [ ] Sweep app-banner-class z-indexes (`tug-banner.css`, `tug-alert.css`, `tug-bulletin.css`) onto a corresponding `--tug-z-banner-*` token tier. Cosmetic; no behavior change.
- [ ] Sweep pane-internal stacking literals (`tug-pane.css`, `tug-tab-bar.css`, etc.) onto local-tier tokens. Lower priority; cosmetic.
- [ ] Add a `useCanvasOverlay` positioning helper (anchor + side + offset → coords) so future overlay consumers don't each re-derive viewport math. Defer until a second consumer beyond the completion popup needs it.
- [ ] Multi-deck UI promotion: when a second `DeckCanvas` instance materializes, promote `canvas-overlay-registry` from a single root to a per-canvas keyed map.
- [ ] `[AT00xx]` for click-to-accept focus retention as a standalone app-test (Step 0's spike + Step 1's app-test cover this transitively but the dedicated test would survive a refactor).

| Checkpoint | Verification |
|------------|--------------|
| Overlay root mounts once per `DeckCanvas` | `document.querySelectorAll('[data-slot="tug-canvas-overlay-root"]').length === 1` after deck mount |
| Completion popup escapes card frame | `at0051` app-test |
| Click-to-accept keeps editor focused | `at0051` app-test step 2 |
| Lifecycle pruning closes overlay on deactivate | Step 2 unit test |
| Popup-class z-indexes are tokens | `rg "z-index: \d+" tugdeck/src/components/tugways/{tug-popover,tug-editor-context-menu,tug-menu,tug-tooltip,tug-completion-menu}.css` returns zero matches |
| Tuglaws walkthrough recorded | [#tuglaws-cross-check] is filled in |
| Aggregate gates green | `bun x tsc --noEmit && bun test && bun run audit:tokens lint && cargo nextest run` all green |
