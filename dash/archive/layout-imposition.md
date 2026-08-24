<!-- devise-skeleton v4 -->

## Layout Imposition {#layout-imposition}

**Purpose:** Ship the layout imposer — a user-driven N-up positioning scheme for panes on the deck canvas, chosen and operated from a new `Layouts` section in the Lens, so that many full-height cards can stack at numbered horizontal positions and be switched, filtered, and rearranged from the Lens instead of from tab strips.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | complete |
| Target branch | main |
| Last updated | 2026-07-25 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tabs-in-windows are a horizontal scrolling model: per-item claims on horizontal space limit how many items fit, per-tab metadata is thin, there is no filtering or assistance at scale, and only one tab is visible per window. The Lens already beats tabs on metadata and filtering (Sessions and Text Files are vertically scrolling, filterable `TugListView` lists), and the deck already supports side-by-side panes. What is missing is a *structure*: a way to say "this card goes at position 2 of a three-up arrangement" with one click, and have that assignment survive window resizes.

The imposer adds exactly that. The name is deliberate: in printing, **imposition** is the arrangement of pages onto the press sheet so each lands at its correct position — this feature imposes cards onto the deck canvas. An *imposition* (two-up / three-up / four-up) defines numbered *slots*; the user assigns a card to a slot by clicking a numbered button on its Lens row. A slot is a **position anchor, not a rect**: it pins the pane horizontally and stretches it to full canvas height, and never touches the pane's width. Any number of panes may share a slot (a vertical stack, top one visible — the tab replacement); overlap between adjacent slots is ordinary geometry when card widths exceed the available span, not a failure mode. Assignment is *definitively not automatic* — the imposer only ever moves a pane the user explicitly assigned.

#### Strategy {#strategy}

- Build the geometry as a pure library first (`tugdeck/src/lib/layout-imposer.ts`), fully unit-tested, with no DOM or store imports — the same discipline as `tugdeck/src/snap.ts`.
- Derive slotted geometry through CSS pinning, not a resize listener, following the existing anchored-rail precedent in `tug-pane.tsx` (the Lens rail is already a pane whose geometry derives from an anchor at render). The browser reflows slotted panes on window resize for free; no `ResizeObserver` on `#deck-container` is needed. See [P03].
- Extend the data model additively (`DeckState.imposition`, `TugPaneState.slot`) with no serialization version bump, following the documented `anchor?` precedent in `layout-tree.ts`.
- Reuse the existing stacking machinery: z-order is pane-array order and `focusCard`/`activateCard` already implement bring-to-front, so "many panes per slot, click to raise" needs no new z code.
- Land in dependency order: library → model/wire → DeckManager API → TugPane rendering → Lens section → row slot buttons → docs → integration.
- Verify at the real-geometry layer: unit tests for the pure math, one app-test driving the real Tug.app asserting live pane rects, `bunx vite build` before declaring done.

#### Success Criteria (Measurable) {#success-criteria}

- With three-up active and three single-card panes assigned to slots 1–3, live `getBoundingClientRect()` measurements in the running app satisfy: slot-1 pane's left edge == span left edge, slot-3 pane's right edge == span right edge, slot-2 pane's horizontal center == span center (±1px), and every slotted pane's top == canvas top and bottom == canvas bottom. (App-test assertion.)
- Assigning a slot never changes the pane's width; the width before and after `assign-slot` is identical. (App-test assertion.)
- Two panes assigned to the same slot render at the same rect with the most-recently-assigned on top (`activePaneId` == its pane, higher z). (App-test assertion.)
- Slotted geometry is CSS-derived: `grep -rn "ResizeObserver" tugdeck/src/deck-manager.ts tugdeck/src/deck-canvas.tsx` stays empty. (Checkpoint command.)
- The imposition kind and per-pane slots survive serialize → deserialize round-trip, and a pre-imposition v4 blob loads unchanged. (Unit tests.)
- `cd tugdeck && bun test` and `bunx vite build` pass at every step boundary.

#### Scope {#scope}

1. `layout-imposer` pure-geometry library with unit tests.
2. Data model + wire format: `DeckState.imposition`, `TugPaneState.slot`, serialization, invariant validation.
3. DeckManager API: `setImposition`, `assignCardToSlot`, drag-evict, span inset CSS custom properties.
4. TugPane imposed-geometry rendering, drag conversion, edge-filtered resize.
5. Lens `Layouts` section (kind picker) and `SlotPicker` numbered buttons on Sessions and Text Files rows.
6. tuglaws amendment recording the third pane-geometry mode.
7. App-test coverage with `@covers` declarations.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Vertical or grid impositions (rows, 2×2). The model is horizontal N-up only for now.
- Any width management: no per-slot widths, no min-width constants, no overlap "handling". Widths are user-owned; overlap is ordinary geometry.
- Automatic assignment of any kind (no auto-slotting new cards, no auto-rebalancing).
- Drag-a-pane-into-a-slot drop targets on the canvas. Assignment happens in the Lens only.
- Slot buttons on Snippets rows (snippets are not panes).
- Changes to `arrangeCards` cascade/tile.
- Keyboard-driven slot assignment from the Lens cursor (deferred, [Q01]).

#### Dependencies / Prerequisites {#dependencies}

- The Lens section registry (`tugdeck/src/components/lens/lens-section-registry.ts`) and section-content contract (`lens-section-content.ts`) as shipped on main.
- The anchored-rail pane mode in `tugdeck/src/components/chrome/tug-pane.tsx` (the CSS-pinning precedent).
- `TugRadioGroup` (`tugdeck/src/components/tugways/tug-radio-group.tsx`) and `TugListRow` (`tugdeck/src/components/tugways/tug-list-row.tsx`, `trailing` slot).

#### Constraints {#constraints}

- tugdeck HMR is live during development; `bunx vite build` must pass before any step is declared done (the debug app loads the production rollup bundle).
- No `localStorage`/`sessionStorage`/IndexedDB — all persistence rides the existing tugbank layout blob (`dev.tugtool.deck.layout`).
- App-tests are selective: the new test carries `@covers` lines and runs via `just app-test <file>` / `just app-test-changed`; never the full corpus.
- Tuglaws conformance: [L02] external state via `useSyncExternalStore`, [L03] `useLayoutEffect` for registrations events depend on, [L06] appearance via CSS/DOM (never React state), [L09] panes own geometry (cards never do). Commits name the laws touched.
- Never hand-roll UI that exists as a Tug* component: the kind picker composes `TugRadioGroup`; slot buttons compose `TugButton`; rows stay `TugListRow`.

#### Assumptions {#assumptions}

- The Lens remains a singleton anchored pane; when it is closed there is no anchored pane in `deckState.panes` and the span insets are 0.
- Sessions rows and Text Files rows both expose the card id of the deck card they represent (`row.cardId` in `sessions-data-source.ts` / `text-files-data-source.ts`), which is how a Lens row reaches its host pane.
- Cards adapt to pane size via their own content-level `ResizeObserver`s (the anchored rail already proves full-height CSS-derived panes work with live card content).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v4 conventions: explicit `{#anchor}` on every cited heading, kebab-case anchors without phase numbers, stable two-digit labels (`[P01]`, `[Q01]`, `S01`, `T01`, `R01`), `**Depends on:**` lines citing `#step-N` anchors, and `**References:**` lines citing plan artifacts — never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Keyboard slot assignment from the Lens cursor (DEFERRED) {#q01-keyboard-slot-assignment}

**Question:** Should the Lens keyboard cursor be able to assign slots (e.g. typing 1–4 on a focused Sessions/Text Files row) in addition to clicking the numbered buttons?

**Why it matters:** The Lens is keyboard-first (Cmd-L lands the cursor on a navigable item; `tuglaws/focus-language.md`). A pointer-only affordance is a gap in that language.

**Plan to resolve:** Ship pointer-first; design the key binding after the interaction proves itself, grounded in `focus-language.md` (digit keys on a focused row are plausible but must not collide with type-ahead filtering plans).

**Resolution:** DEFERRED — pointer assignment is the model being validated; the keyboard verb is additive later and touches the focus-language law surface, which deserves its own pass.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Drag machine vs CSS-pinned frames ([R01]) | med | med | convert to free px styles at drag start, before the first drag frame | any visual jump when dragging a slotted pane |
| Stale state rects for slotted panes ([R02]) | low | low | snap candidates already read live DOM rects (`snapshotCardRects`); gesture starts re-seed from the DOM | Option-snap guides misaligned near slotted panes |
| `transform` centering side-effects ([R03]) | low | low | transform only on middle slots; pane frame already carries inline z-index (own stacking context) | popover/overlay misanchoring inside a middle-slot pane |

**Risk R01: Drag machine interplay with CSS-pinned frames** {#r01-drag-vs-pinned}

- **Risk:** `TugPane`'s three-phase drag machine writes per-frame appearance-zone styles against a frame positioned by `left`/`top` px; a slotted frame is positioned by `left: calc(...)` + `top:0/bottom:0` (+ `transform` for middle slots), so naive drag frames would fight the pins.
- **Mitigation:** at `handleDragStart` on a slotted pane, snapshot `getBoundingClientRect()` relative to the canvas, write free px inline styles (`left`, `top`, `width`, `height`), clear the pin styles and transform, **and seed the drag machine's start position (`dragStartPosition.current`) from that snapshot** — the machine otherwise seeds it from React-state `position`, which is stale for slotted panes, and the first `applyDragFrame` would teleport the pane to the stale coordinates; then run the standard free drag; the commit clears `slot` ([P07]) so React re-renders in free mode consistent with the DOM.
- **Residual risk:** one-frame style transitions at drag start; acceptable and testable by eye.

**Risk R02: Snap and detach math read state rects that are stale for slotted panes** {#r02-stale-state-rects}

- **Risk:** code that reads `pane.position`/`pane.size` from state sees last-known values for slotted panes, not the live CSS-derived rect (same class of staleness the anchored rail already has for its derived edge).
- **Mitigation:** snap candidates are already live — `snapshotCardRects` in `tug-pane.tsx` reads `getBoundingClientRect()` off every `.tug-pane[data-pane-id]` element (its comment notes the rail "needs no special case"), so slotted panes are correct snap candidates with zero new code; the implementation step *verifies* this rather than building it. Detach from a slotted pane is not slot-preserving (the detached card mints a free pane, unchanged behavior). Gesture handlers that seed from state (`handleDragStart`, resize) are handled explicitly ([R01], and the dedicated imposed-resize path in #step-4).
- **Residual risk:** state rects for slotted panes lag until evict/assign/freeze refreshes them; serialization skips the fit clamp for them ([P04]) so nothing downstream misbehaves.

**Risk R03: `translateX(-50%)` on middle-slot frames** {#r03-transform-centering}

- **Risk:** a transform makes the frame a containing block for `position: fixed` descendants and interacts with stacking.
- **Mitigation:** the pane frame already carries an inline `z-index` (it is its own stacking context per `tuglaws/pane-model.md`); pane-modal surfaces portal into the frame and move with it; anchor-relative overlays portal into the canvas overlay and measure via `getBoundingClientRect()`, which accounts for transforms.
- **Residual risk:** an undiscovered fixed-position descendant inside card content; the app-test plus normal use of a session card in a middle slot smokes this out.

---

### Design Decisions {#design-decisions}

#### [P01] Printing vocabulary: imposition / impose / slot (DECIDED) {#p01-vocabulary}

**Decision:** The feature's code vocabulary is `imposition` (the active N-up rule, `ImpositionKind = "two-up" | "three-up" | "four-up"`), `impose` (the geometry verb), and `slot` (a numbered position, 0-based in code, rendered 1-based). User-facing copy in the Lens says "Layouts" and shows bare numbers.

**Rationale:**
- "layout" is unusable in code: `DeckState` *is* the layout tree and the tugbank domain is `dev.tugtool.deck.layout`.
- "position" is unusable in code: `pane.position` is the `{x, y}` rect origin.
- Imposition is the printing-industry term of art for arranging pages at positions on a sheet — an exact conceptual match, chosen deliberately.

**Implications:** library `layout-imposer.ts`; deck field `imposition`; pane field `slot`; actions `set-imposition` / `assign-slot`; Lens section kind `layouts`, title "Layouts".

#### [P02] A slot is a position anchor, not a rect (DECIDED) {#p02-slot-is-anchor}

**Decision:** Assigning a pane to a slot changes exactly two things — its horizontal anchor and its height (full canvas height, top and bottom pinned). Width is never touched by the imposer, in any code path.

**Rationale:**
- The user owns card widths; the imposer owns arrangement. Mixing the two reintroduces the tab-strip problem of the system fighting the user for space.
- With widths untouched, overlap needs no special casing: when card widths exceed the span, first/last anchoring plus distributed middles produce horizontal overlap naturally.

**Implications:** no min-width constants, no overlap detection, no width fields anywhere in the imposer API; `imposeRect`/`imposeStyle` take the pane's own width as an input.

#### [P03] Slotted geometry is CSS-derived — no ResizeObserver (DECIDED) {#p03-css-derived}

**Decision:** A slotted pane's frame is positioned by CSS pinning computed at render (`imposeStyle`), exactly as the anchored Lens rail derives its geometry from `anchor` at render. No `ResizeObserver` or `resize` listener is added to the deck; the browser reflows slotted panes when the window or Lens changes.

**Rationale:**
- The anchored rail (`stackState.anchor` in `tug-pane.tsx`) is an existing, shipped precedent: "the pane still owns geometry per [L09]; it merely computes it from `anchor` rather than `position`." A slot is the third member of that family.
- [L06]: appearance changes go through CSS and DOM, never React state. A JS reflow loop (observe → recompute → commit → re-render) on every resize frame is the anti-pattern this law exists to prevent.
- It makes "a slotted pane moves with the canvas" true by construction rather than by event plumbing.

**Implications:** the span insets reach CSS as two custom properties on the pane frames' own containing block (`DeckCanvas`'s `containerRef` wrapper — the `position: absolute; inset: 0` div inside `#deck-container` that every pane frame is a child of, so the `100%` in an imposed frame's calc resolves against the same box) ([P12]); `pane.position`/`pane.size` for slotted panes hold last-known values refreshed at assign/evict (see [R02]); serialization skips the canvas-fit clamp for slotted panes exactly as it does for anchored ones.

#### [P04] Additive wire format — no version bump (DECIDED) {#p04-additive-wire}

**Decision:** `imposition` (deck-level) and `slot` (pane-level) are additive-optional fields in the existing v4 layout blob. No v5.

**Rationale:**
- `TugPaneState.anchor?` set the precedent, documented in `layout-tree.ts`: "Additive-optional like `collapsed?` — no serialization version bump."
- Absent fields mean "feature off / pane free", which is exactly the pre-imposition semantics, so old blobs parse correctly with zero migration code.

**Implications:** `serialize()` in `serialization.ts` emits the fields when present; `parseV4` reads them defensively (unknown kind → drop imposition; non-integer/negative slot → drop slot; slot present without a valid imposition → drop slot).

#### [P05] Slots are stacks; assign always raises (DECIDED) {#p05-slots-are-stacks}

**Decision:** Any number of panes may hold the same slot. Clicking a slot number always assigns *and* raises (bring-to-front + first-responder promotion); it is never a no-op and never a toggle-off. Clicking the Lens row itself raises, as today.

**Rationale:**
- This is the tab replacement: a slot is a vertical stack with only the top pane visible; the Lens list — filterable, metadata-rich, vertically scrolling — is the switching surface.
- Z-order already is pane-array order with `focusCard`/`activateCard` implementing bring-to-front (`_commitStandardFirstResponderFlip` in `deck-manager.ts`); coincident rects need no new machinery.

**Implications:** un-assignment happens only by dragging the pane ([P07]) or by turning the imposition off ([P08]); no toggle semantics on the numbered buttons.

#### [P06] Assigning a card from a multi-card pane detaches it first (DECIDED) {#p06-detach-on-assign}

**Decision:** When the clicked row's card lives in a pane with other cards (a tab group), `assignCardToSlot` first detaches the card into its own pane (`_detachCard`), then slots the new pane. A card already alone in its pane slots its host pane directly.

**Rationale:**
- The feature exists to replace tab strips; it must pull cards *out* of them, not slot whole tab groups.
- `_detachCard(paneId, cardId, position)` already exists with the full lifecycle choreography (fresh-bag flush, single-commit FR flip via `flushSync`, focus transfer) — reusing it preserves [L23] state preservation for free.

**Implications:** `_detachCard`'s last-card guard (returns `null` for a single-card pane) is exactly the branch condition: `null`-guard result means "slot the existing host pane".

#### [P07] Dragging a slotted pane evicts it (DECIDED) {#p07-drag-evicts}

**Decision:** A title-bar drag on a slotted pane converts it back to a free pane: the drag-commit path clears `slot` and writes the dropped rect into `position`/`size`. Resize does *not* evict (width is user-owned even while slotted). Eviction rides an explicit option on the commit (`movePane(paneId, position, size, { evictSlot: true })` from the drag path only), never a heuristic inside `movePane`.

**Rationale:**
- The explicit gesture wins, macOS-style; a drag-locked pane fights the user.
- A west-edge resize also changes `position.x`, so "position changed ⇒ evict" inside `movePane` would wrongly evict on resize; the option keeps the rule precise.

**Implications:** `TugPane`'s drag commit passes the option; the resize commit does not; `movePane` clears `slot` (and refreshes `position`/`size`) only when the option is set.

#### [P08] Kind shrink clamps; imposition-off freezes in place (DECIDED) {#p08-shrink-and-off}

**Decision:** `setImposition` to a smaller kind clamps out-of-range slots to the new last slot (`clampSlot`). `setImposition(null)` freezes every slotted pane at its current on-screen rect (live DOM rect written into `position`/`size`) and clears all `slot` fields — except that a **collapsed** slotted pane keeps its stored `size.height` (only `position` and `size.width` come from the live rect), mirroring the drag-commit convention in `tug-pane.tsx` (`committedHeight = collapsed ? size.height : frame.offsetHeight`) so the window-shade stub height is never committed and the card stays restorable.

**Rationale:**
- Clamping means nothing silently falls out of the arrangement on a kind change.
- Freezing on "off" honors what the user sees: turning the structure off must not scatter panes back to stale pre-imposition positions.

**Implications:** persisted blobs never carry `slot` without `imposition`; `setImposition(null)` needs live rects, so the DeckCanvas/TugPane layer must expose per-pane frame rects to DeckManager (the frame carries `data-pane-id`, so `container.querySelector('[data-pane-id="…"]').getBoundingClientRect()` suffices); the freeze consults each pane's `collapsed` flag before writing `size.height`.

#### [P09] Assign uncollapses; a later collapse keeps the slot (DECIDED) {#p09-collapse}

**Decision:** `assignCardToSlot` clears `collapsed` (slots are full-height by definition). Collapsing an already-slotted pane afterward keeps the slot and the horizontal pin; only the bottom pin releases while collapsed (the collapsed bar sits at the canvas top, at its slot's x).

**Rationale:**
- Slotting a collapsed pane must produce a visible full-height card, or the gesture reads as broken.
- Retaining the slot through collapse preserves user intent — expanding returns the pane to its position, no re-assignment needed.

**Implications:** the imposed style branch in `TugPane` composes with the existing collapsed rendering: horizontal pin always, `top: 0` always, `bottom: 0` only when not collapsed.

#### [P10] Slot eligibility: Sessions and Text Files rows; never the Lens rail (DECIDED) {#p10-eligibility}

**Decision:** The `SlotPicker` appears on Lens Sessions rows and Text Files rows only. `anchor` and `slot` are mutually exclusive on a pane — `validateDeckState` rejects a pane carrying both, and `assignCardToSlot` refuses cards hosted in an anchored pane.

**Rationale:**
- Sessions and Text Files are the surfaces the user named; snippets are not panes.
- The rail's geometry is already derived from `anchor`; a second deriver on the same pane is incoherent.

**Implications:** one new invariant in `validateDeckState` (`layout-tree.ts`); the assignment surface is UI-scoped, but the model is generic — future sections can adopt `SlotPicker` without model changes.

#### [P11] Middle slots are center-anchored on evenly distributed fractions (DECIDED) {#p11-center-anchored-middles}

**Decision:** For kind with N slots, slot k anchors at fraction `f = k / (N - 1)` across the span: slot 0 pins its **left edge** to the span's left edge, slot N−1 pins its **right edge** to the span's right edge, and each middle slot pins its **horizontal center** to `spanLeft + spanWidth · f`.

**Rationale:**
- With widths user-owned, a middle position needs a reference point on the card; center-anchoring makes a middle card grow symmetrically when widened, which reads as stable.
- The fractions reproduce the user's spec exactly: three-up middle at the span center; four-up middles at 1/3 and 2/3.

**Implications:** middle slots render with `left: calc(<anchor>)` + `transform: translateX(-50%)` so live width changes recenter without re-baking the calc (see [R03]); first/last slots use plain edge pins with no transform.

#### [P12] Span insets are CSS custom properties on the deck container (DECIDED) {#p12-span-css-properties}

**Decision:** The layout span (canvas minus the Lens rail on its docked side) reaches CSS as two custom properties on the pane frames' own containing block (`DeckCanvas`'s `containerRef` wrapper — the `position: absolute; inset: 0` div inside `#deck-container` that every pane frame is a child of, so the `100%` in an imposed frame's calc resolves against the same box): `--tug-imposer-inset-left` and `--tug-imposer-inset-right` (px values; both `0px` when the Lens is closed). `DeckCanvas` maintains them in a `useLayoutEffect` from the deck snapshot's anchored pane (side + width).

**Rationale:**
- Slotted positions are *never* under the Lens (the span excludes the rail), while free panes may still be dragged under it — the asymmetry the user confirmed.
- Custom properties let `imposeStyle`'s calc expressions track live rail resizes and side flips with zero JS reflow ([P03]); a rail width drag updates the property on commit and every slotted pane follows.
- [L03]/[L06]: a `useLayoutEffect` DOM write in the component that already subscribes to deck state, in the appearance zone.

**Implications:** `imposeStyle` emits calc expressions in terms of these two variables; anything that changes rail presence/side/width flows through the existing `movePane` mirror and `setLensAnchorSide`, both of which already notify the deck store, so the effect re-runs without new subscriptions.

---

### Deep Dives {#deep-dives}

#### Investigation findings a cold reader needs {#investigation-findings}

**The anchored-rail precedent.** `TugPaneState.anchor?: "left" | "right"` (`tugdeck/src/layout-tree.ts`) marks a pane whose geometry derives from a viewport edge at render. In `tugdeck/src/components/chrome/tug-pane.tsx`, `anchorSide`/`anchored` are computed from `stackState.anchor`; an anchored frame renders `left: 0` or `right: 0` with `top: 0` / `bottom: 0` and its stored width, is non-draggable, exposes only its deck-facing resize edge (`handleAnchoredResizeStart`, width-only), and is excluded from merge. `deserialize`/`parseV4` (`tugdeck/src/serialization.ts`) skips `fitPaneGeometry` for anchored panes because their geometry derives at render. Slotted panes follow this pattern member-for-member: skip the fit clamp, derive at render, restrict the gesture surface.

**No resize reactivity exists today.** There is no `ResizeObserver` and no `window resize` listener anywhere on the deck geometry path (`deck-manager.ts` listens only to window `focus`/`blur` and `beforeunload`). Free panes are refit once at load (`fitPaneGeometry`) and otherwise inert — the imposer must not change that for free panes, and per [P03] achieves resize-tracking for slotted panes without adding a listener.

**Geometry mutation flows through one funnel.** `DeckManager.movePane(paneId, position, size)` (`tugdeck/src/deck-manager.ts`) is the drag/resize commit: fires `notifyCardWillMove`/`WillResize` on the pane's active card, commits, fires the did-events, mirrors an anchored pane's width to `lensStore.setWidth`, then `scheduleSave()` (500ms debounce → `saveLayout` → tugbank `dev.tugtool.deck.layout`). `TugPane` reaches it through the `onCardMoved` prop, bound via `handlePaneMoved` in `deck-manager-store.ts`.

**Bring-to-front is pane-array order.** `deck-canvas.tsx` renders panes in stable id-sorted DOM order and assigns z from the store-array index (`CARD_ZINDEX_BASE + i`); anchored panes get the flat `ANCHORED_PANE_ZINDEX` (8999), above all free/slotted panes. `focusCard(cardId)` and `activateCard(cardId)` splice the host pane to the array end and set `activePaneId`; `_commitStandardFirstResponderFlip` is the standard commit body. Slot stacking reuses all of this untouched.

**Detach machinery.** `_detachCard(paneId, cardId, position)` returns the new pane id, or `null` when the card is alone in its pane (last-card guard) or the ids don't resolve. It flushes the card's state bag pre-move, mints the pane at the clamped position with the card's preferred size policy, and runs the FR flip inside `flushSync` so the portal re-parent commits synchronously. `assignCardToSlot` composes with it per [P06].

**Lens section anatomy.** Sections register via `registerLensSection(def)` (`lens-section-registry.ts`): `kind`, `title`, `glyph`, required `collapsedSummary`, `body(host)`, optional `headerActions`, optional `filterable`. Bodies are host-agnostic (only `LensSectionHost = { lensCardId, focusGroup }` comes in) and publish `setSectionContent(host.focusGroup, { navigable, populated })` (`lens-section-content.ts`) from a `useLayoutEffect` so the Cmd-L seed / Tab walk skips empty sections. Registration happens once at boot from `main.tsx` (see `registerTextFilesSection` / `registerSessionsSection` imports there). New sections append to the render order via `resolveSectionRenderOrder`; the user can drag-reorder, persisted in `lensStore.sectionOrder`.

**Row anatomy.** Sessions rows (`sessions-section.tsx`) render `TugListRow` with `leading` (phase dot), title/subtitle, and `trailing` (sparkline); activation dispatches `dispatchAction({ action: "focus-session-card", cardId: row.cardId })`. Text Files rows (`text-files-section.tsx`, `FileRow`) use title/subtitle only. `TugListRow` (`tug-list-row.tsx`) takes `trailing?: React.ReactNode` with optional `trailingReveal`; the Snippets rows show the convention for interactive trailing content: handlers call `stopPropagation()` so button clicks don't read as row activation. Row → pane resolution: `row.cardId` → find the pane whose `cardIds` includes it in the deck snapshot (`getDeckStore()` from `lib/deck-store-registry`, read via `useSyncExternalStore`).

**Actions.** `action-dispatch.ts` registers handlers with `registerAction(name, (payload) => …)`; `focus-session-card` is the model to copy (payload validation + `console.warn` on bad input). New actions: `set-imposition` and `assign-slot`.

**Lens store vs deck blob.** The Lens rail's live geometry (anchored-pane presence + width) lives in the deck layout blob; `dev.tugtool.lens` holds only arrangement preferences (`widthPx` reopen width, `sectionOrder`, `sessionOrder`, `collapsedSections`, `anchorSide`). `imposition` is live deck structure, so it belongs in the deck blob, not the lens store.

#### End-to-end flow: user clicks "2" on a session row {#flow-assign}

1. `SlotPicker` button dispatches `dispatchAction({ action: "assign-slot", cardId, slot: 1 })` (0-based in code).
2. The action handler calls `deckManager.assignCardToSlot(cardId, 1)`.
3. `assignCardToSlot`: resolve host pane; refuse if `pane.anchor` is set ([P10]); if `pane.cardIds.length > 1`, `_detachCard` into a fresh pane ([P06]); on the target pane set `slot: 1`, clear `collapsed` ([P09]); commit + `notify()` + `scheduleSave()`; then `activateCard(cardId)` raises the pane and promotes first responder ([P05]).
4. React re-renders the pane's `TugPane` with a `slot` in `stackState`; the imposed style branch applies `imposeStyle(kind, 1, paneWidth)` — for a middle slot, `left: calc(var(--tug-imposer-inset-left) + (100% - var(--tug-imposer-inset-left) - var(--tug-imposer-inset-right)) * 0.5)`, `transform: translateX(-50%)`, `top: 0`, `bottom: 0`, `width: <paneWidth>px`, `height: auto`.
5. The window later resizes → the browser recomputes the calc; no JS runs ([P03]).

---

### Specification {#specification}

#### Terminology and Naming {#terminology}

**Table T01: Vocabulary** {#t01-vocabulary}

| Term | Code | User-facing |
|------|------|-------------|
| The feature | layout imposition / the imposer | "Layouts" |
| The active rule | `imposition: ImpositionKind \| null` on `DeckState` | Two Up / Three Up / Four Up / Off |
| A numbered position | `slot?: number` on `TugPaneState` (0-based) | 1…N buttons |
| The usable band | span (`--tug-imposer-inset-left/right`) | — |
| Pane geometry modes | free / anchored / imposed | — |

#### Spec S01: Slot geometry semantics {#s01-slot-geometry}

Let N = slot count of the kind (two-up = 2, three-up = 3, four-up = 4), k the 0-based slot, W the pane's own width in px, and the span = canvas minus the Lens rail inset on its docked side.

- Fraction: `f(k) = k / (N - 1)`.
- Slot 0: left edge at span left. CSS: `left: var(--tug-imposer-inset-left)`.
- Slot N−1: right edge at span right. CSS: `right: var(--tug-imposer-inset-right)`.
- Middle slot k: horizontal center at `spanLeft + spanWidth · f(k)`. CSS: `left: calc(var(--tug-imposer-inset-left) + (100% - var(--tug-imposer-inset-left) - var(--tug-imposer-inset-right)) * f); transform: translateX(-50%)`.
- Vertical: `top: 0`; `bottom: 0` when not collapsed ([P09]); `height: auto`.
- Width: `width: <W>px` — always the pane's own stored width, never computed ([P02]).
- Numeric twin (for tests and snap): `imposeRect(kind, k, W, span)` returns `{ position: { x, y: 0 }, size: { width: W, height: span.height } }` with `x = spanX` for k=0, `x = spanX + spanW − W` for k=N−1, `x = spanX + spanW·f − W/2` for middles. No clamping, no minimums — overlap and overhang are permitted outcomes.

#### Spec S02: Wire format additions (v4, additive) {#s02-wire-format}

```jsonc
{
  "version": 4,
  "imposition": "three-up",          // optional; absent = feature off
  "cards": [ /* unchanged */ ],
  "panes": [
    {
      "id": "pane-xyz",
      "position": { "x": 100, "y": 0 },   // last-known; not authoritative while slotted
      "size": { "width": 640, "height": 900 },
      "slot": 1,                          // optional; only valid while imposition is set
      "cardIds": ["card-abc"], "activeCardId": "card-abc",
      "title": "", "acceptsFamilies": ["standard"]
    }
  ]
}
```

Read rules (`parseV4`): `imposition` must be one of the three kind strings, else dropped; `slot` must be a non-negative integer, is `clampSlot`ed to the kind, and is dropped entirely when the blob carries no valid `imposition`; a pane with both `anchor` and `slot` drops `slot`. Panes with a surviving `slot` skip `fitPaneGeometry` (geometry derives at render, [P03]/[P04]).

#### Spec S03: `layout-imposer` public API {#s03-imposer-api}

```ts
// tugdeck/src/lib/layout-imposer.ts — pure; no DOM, store, or React imports.
export type ImpositionKind = "two-up" | "three-up" | "four-up";
export const IMPOSITION_KINDS: readonly ImpositionKind[];
export function isImpositionKind(value: unknown): value is ImpositionKind;
export function slotCount(kind: ImpositionKind): number;            // 2 | 3 | 4
export function clampSlot(kind: ImpositionKind, slot: number): number;
export function slotFraction(kind: ImpositionKind, slot: number): number; // k / (N-1)

export interface ImposerSpan { x: number; width: number; height: number }
export function resolveSpan(
  canvas: { width: number; height: number },
  rail: { side: "left" | "right"; width: number } | null,
): ImposerSpan;

export interface ImposedRect { position: { x: number; y: number }; size: { width: number; height: number } }
export function imposeRect(kind: ImpositionKind, slot: number, paneWidth: number, span: ImposerSpan): ImposedRect;

// CSS twin of imposeRect, in terms of the --tug-imposer-inset-* custom properties.
// `collapsed` releases the bottom pin ([P09]).
export function imposeStyle(kind: ImpositionKind, slot: number, paneWidth: number, collapsed: boolean): React.CSSProperties;
```

(`React.CSSProperties` is a type-only import; it does not violate the no-React rule for runtime code.)

#### Spec S04: Actions and DeckManager surface {#s04-actions}

| Action | Payload | Handler |
|--------|---------|---------|
| `set-imposition` | `{ kind: "two-up" \| "three-up" \| "four-up" \| null }` | `deckManager.setImposition(kind)` |
| `assign-slot` | `{ cardId: string, slot: number }` (0-based) | `deckManager.assignCardToSlot(cardId, slot)` |

DeckManager additions:

- `setImposition(kind: ImpositionKind | null): void` — kind change: set `deckState.imposition`, `clampSlot` every slotted pane ([P08]), notify + save. Null: for each slotted pane read the live frame rect via `[data-pane-id]` lookup, write it into `position`/`size` — except a collapsed pane keeps its stored `size.height` (write `position` + `size.width` only, per the `committedHeight` convention; [P08]) — delete `slot`; then clear `imposition`, notify + save.
- `assignCardToSlot(cardId: string, slot: number): void` — per the flow in (#flow-assign). Refuses (warn + return) when `imposition` is null, the card has no host pane, or the host is anchored.
- `movePane(paneId, position, size, opts?: { evictSlot?: boolean })` — existing signature extended; when `opts.evictSlot` and the pane is slotted, delete `slot` in the same commit ([P07]).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `DeckState.imposition` | structure | DeckManager store, React reads via `useSyncExternalStore` | [L02] |
| `TugPaneState.slot` | structure | DeckManager store (same subscription) | [L02] |
| Slotted frame pinning (left/right/top/bottom/transform) | appearance | inline CSS from `imposeStyle` at render; per-frame browser reflow, zero React state | [L06], [L09] |
| `--tug-imposer-inset-left/right` on the frames' containing block | appearance | `useLayoutEffect` DOM write in `DeckCanvas` from the deck snapshot | [L03], [L06] |
| `SlotPicker` filled/active state | derived render | computed from the deck snapshot (host pane's `slot`) | [L02] |
| Layouts section selection | derived render | `TugRadioGroup` controlled by `deckState.imposition` | [L02], [L11] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/layout-imposer.ts` | Pure imposition geometry (Spec S03) |
| `tugdeck/src/lib/__tests__/layout-imposer.test.ts` | Unit suite for the library |
| `tugdeck/src/components/lens/sections/layouts-section.tsx` | The Lens `Layouts` section |
| `tugdeck/src/components/lens/sections/layouts-section.css` | Section styles (kind diagrams) |
| `tugdeck/src/components/lens/slot-picker.tsx` | Numbered slot-button cluster for list rows |
| `tugdeck/src/components/lens/slot-picker.css` | SlotPicker styles |
| `tests/app-test/at0275-layout-imposition.test.ts` | App-test |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ImpositionKind`, `slotCount`, `clampSlot`, `slotFraction`, `resolveSpan`, `imposeRect`, `imposeStyle`, `ImposerSpan`, `ImposedRect`, `IMPOSITION_KINDS`, `isImpositionKind` | types/fns | `lib/layout-imposer.ts` | Spec S03 |
| `DeckState.imposition?` | field | `layout-tree.ts` | [P04] |
| `TugPaneState.slot?` | field | `layout-tree.ts` | [P04]; doc-comment mirrors the `anchor?` comment |
| `validateDeckState` | fn (modify) | `layout-tree.ts` | new invariant: never both `anchor` and `slot` ([P10]) |
| `serialize`, `parseV4` | fns (modify) | `serialization.ts` | Spec S02 |
| `setImposition`, `assignCardToSlot` | methods | `deck-manager.ts` | Spec S04 |
| `movePane` | method (modify) | `deck-manager.ts` | `opts.evictSlot` ([P07]) |
| `handlePaneMoved` | binding (modify) | `deck-manager-store.ts` | pass-through of the options arg |
| inset-property effect | `useLayoutEffect` | `deck-canvas.tsx` | [P12] |
| imposed style branch, drag-start conversion (DOM-seeded), dedicated imposed-resize path | logic | `components/chrome/tug-pane.tsx` | [P03], [P07], [R01]; resize is width-only à la `handleAnchoredResizeStart`, never the generic handler; slot 0 → `e` handle only, last slot → `w` only, middles → `e`+`w` |
| `registerLayoutsSection` | fn | `sections/layouts-section.tsx` | registered from `main.tsx` |
| `SlotPicker` | component | `lens/slot-picker.tsx` | props: `{ cardId: string }`; reads deck store itself |
| `set-imposition`, `assign-slot` | actions | `action-dispatch.ts` | Spec S04 |

---

### Documentation Plan {#documentation-plan}

- [x] Amend `tuglaws/pane-model.md`: the three pane geometry modes (free / anchored / imposed), `slot` in the wire-contract example, `layout-imposer.ts` in the Files table.
- [x] Add a global design decision to `tuglaws/design-decisions.md`: `[D121]` records the imposition model and cross-links this plan.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | `layout-imposer` math and serialization round-trips, via `bun test` | every geometry edge (all kinds × all slots, span with left/right/absent rail, clamping, negative inputs) |
| **Integration (app-test)** | real Tug.app: assign via real Lens clicks, assert live `getBoundingClientRect()` | the end-to-end flow in (#flow-assign), stacking, drag-evict |
| **Golden / Contract** | v4 blob with and without imposition fields parses per Spec S02 | serialization unit tests |

#### What stays out of tests {#test-non-goals}

- jsdom render tests of `TugPane`/`SlotPicker` — banned pattern; the app-test drives the real DOM.
- Mock-store assertions of DeckManager mutations — covered by the unit-tested pure library plus the real-app integration test.
- Window-resize automation — if the harness cannot resize the real macOS window, resize tracking is proven structurally (CSS-derived geometry, [P03]) plus a manual check; do not fake it.
- Full app-test sweeps — the new test runs by name / via `just app-test-changed` (`@covers` resolution).

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Only the user commits on main (CLAUDE.md git policy); under explicitly authorized autonomous execution, commit per sub-step reporting hash + message. Commit messages name the tuglaws touched.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | layout-imposer library + unit tests | done | `1dba17f99` |
| #step-2 | Model + wire format | done | `11f1a0a75` |
| #step-3 | DeckManager imposition API | done | `a6368222e` |
| #step-4 | TugPane imposed rendering | done | `36bd6cec0` |
| #step-5 | Lens Layouts section | done | `b6b93831d` |
| #step-6 | SlotPicker on Sessions + Text Files rows | done | `bf7ebcfe0` |
| #step-7 | tuglaws amendment | done | `b3b61d2b0` |
| #step-8 | Integration checkpoint | done | `efce133d9` |

#### Step 1: layout-imposer library + unit tests {#step-1}

**Commit:** `tugways(imposition-lib): add layout-imposer pure geometry library`

**References:** [P01] vocabulary, [P02] slot is anchor, [P11] center-anchored middles, Spec S01, Spec S03, (#investigation-findings)

**Artifacts:**
- `tugdeck/src/lib/layout-imposer.ts` implementing Spec S03 exactly.
- `tugdeck/src/lib/__tests__/layout-imposer.test.ts`.

**Tasks:**
- [ ] Implement every Spec S03 symbol; module docstring states the printing-imposition vocabulary and the pure-no-DOM discipline (cite `snap.ts` as the sibling).
- [ ] `imposeStyle` emits the exact calc expressions of Spec S01, including the `collapsed` bottom-pin release and the middle-slot `transform`.

**Tests:**
- [ ] `imposeRect` for all kinds × all slots against hand-computed values, with left-docked, right-docked, and absent rail spans.
- [ ] Two-up has no middle slots; three-up middle centers at span center; four-up middles at 1/3 and 2/3.
- [ ] Width never appears in output except as pass-through (`size.width === paneWidth` for every input).
- [ ] `clampSlot` clamps 3 → 1 for two-up; `slotFraction` endpoints are 0 and 1; overlap inputs (ΣW > span) produce overlapping rects without error.
- [ ] `imposeStyle` string-snapshot for each anchor class (edge-left, edge-right, middle, collapsed-middle).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/layout-imposer.test.ts`

---

#### Step 2: Model + wire format {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(imposition-model): add imposition + slot to deck state and v4 blob [L02][L09]`

**References:** [P04] additive wire, [P10] eligibility invariant, Spec S02, (#s02-wire-format, #investigation-findings)

**Artifacts:**
- `DeckState.imposition?`, `TugPaneState.slot?` in `tugdeck/src/layout-tree.ts` with doc-comments mirroring the `anchor?` additive-optional comment.
- Serialization + parse per Spec S02 in `tugdeck/src/serialization.ts`.
- New `validateDeckState` invariant: a pane never carries both `anchor` and `slot`.

**Tasks:**
- [ ] `serialize()` emits `imposition` (top-level) and `slot` (per-pane) only when present, matching the existing conditional-spread style.
- [ ] `parseV4` applies the Spec S02 read rules, using `isImpositionKind` and `clampSlot` from the library; slotted panes skip `fitPaneGeometry` exactly as anchored panes do (extend the existing skip condition and its comment).
- [ ] `validateDeckState` throws `DeckStateInvariantError` naming the offending pane id for anchor+slot.

**Tests:**
- [ ] Round-trip: serialize a state with `imposition: "three-up"` and slots 0/1/2 → deserialize → fields intact, geometry unclamped for slotted panes.
- [ ] Pre-imposition v4 blob (no new fields) parses to `imposition === undefined`, no pane slots.
- [ ] Defensive reads: bogus kind dropped; `slot` without `imposition` dropped; `slot: 7` under two-up clamps to 1; anchor+slot in a blob drops slot; `validateDeckState` rejects a hand-built anchor+slot pane.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`

---

#### Step 3: DeckManager imposition API {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(imposition-manager): setImposition, assignCardToSlot, drag-evict, span insets [L02][L03][L06]`

**References:** [P05] slots are stacks, [P06] detach-on-assign, [P07] drag-evicts, [P08] shrink/off, [P09] collapse, [P12] span CSS properties, Spec S04, (#flow-assign, #s04-actions)

**Artifacts:**
- `setImposition` / `assignCardToSlot` on `DeckManager` (`tugdeck/src/deck-manager.ts`) per Spec S04.
- `movePane` options arg (`{ evictSlot?: boolean }`) threaded through `handlePaneMoved` in `tugdeck/src/deck-manager-store.ts`.
- The inset-property `useLayoutEffect` in `tugdeck/src/deck-canvas.tsx` writing `--tug-imposer-inset-left/right` on the `containerRef` wrapper (the frames' containing block) from the anchored pane's side + width (both `0px` when no anchored pane exists).

**Tasks:**
- [ ] `assignCardToSlot` implements the (#flow-assign) sequence, including the `_detachCard` branch (its `null` return for a single-card pane means "slot the existing host"), the anchored-pane refusal, the `collapsed` clear, and the trailing `activateCard` raise.
- [ ] `setImposition(kind)` clamps existing slots via `clampSlot`; `setImposition(null)` freezes each slotted pane at its live frame rect (`container.querySelector('[data-pane-id="…"]')?.getBoundingClientRect()`, translated to canvas coordinates) before deleting `slot`, then clears `imposition`. A collapsed slotted pane keeps its stored `size.height` in the freeze — never the window-shade stub height ([P08]).
- [ ] `movePane` deletes `slot` in the same commit when `opts.evictSlot` is set and the pane is slotted; resize commits never pass the option.
- [ ] Both mutations run the standard `notify()` + `scheduleSave()` choreography and fire the will/did move-resize lifecycle events on affected active cards (follow the `arrangeCards` pattern for the multi-pane clamp case).

**Tests:**
- [x] **Not unit-testable at this layer, by design.** A store-level test would have to construct a real `DeckManager`, whose constructor calls `createRoot(container)` and writes `container.style` — it needs a live DOM. tugdeck has no in-process DOM substrate (happy-dom is deleted; `jsdom` is a dependency only for DOMPurify's sanitizer parity, never a test environment), and a fake-DOM render test is a banned pattern (#test-non-goals). The mutation semantics — detach-then-slot, slot-in-place, assign-raises, anchored refusal, kind clamp, imposition-off freeze — are therefore covered by the real-app test in #step-8, which is where they can be asserted against real geometry anyway. The pure parts (`clampSlot`, the rect math) are already unit-tested in #step-1.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `grep -rn "ResizeObserver" tugdeck/src/deck-manager.ts tugdeck/src/deck-canvas.tsx` → no matches

---

#### Step 4: TugPane imposed rendering {#step-4}

**Depends on:** #step-3

**Commit:** `tugways(imposition-pane): imposed geometry mode on TugPane [L06][L09]`

**References:** [P03] CSS-derived, [P07] drag-evicts, [P09] collapse, [P11] middles, Spec S01, Risk R01, Risk R02, Risk R03, (#investigation-findings)

**Artifacts:**
- The imposed style branch in `tugdeck/src/components/chrome/tug-pane.tsx`: when `stackState.slot !== undefined` and the deck's imposition is set, frame style comes from `imposeStyle(kind, slot, size.width, collapsed)` instead of free `left/top/width/height` (and instead of the anchored branch — the three modes are mutually exclusive; the pane needs the current kind, so thread `imposition` to `TugPane` alongside the existing per-pane props from `deck-canvas.tsx`).
- Drag-start conversion per Risk R01 (free px styles + drag machine re-seeded from the DOM snapshot); drag commit calls `onCardMoved` with `{ evictSlot: true }`.
- A dedicated imposed-resize path modeled on `handleAnchoredResizeStart` — **width-only, seeded from the live DOM rect, never the generic handler** (the generic `handleResizeStart` seeds `startLeft`/`startW` from React state, stale for slotted panes, and writes `left`/`top` per frame on `w`-edges, fighting the CSS pin — the exact failure the rail's dedicated handler exists to avoid, per its own comment). Permitted handles: slot 0 → `e` only (grows right, left edge pinned); last slot → `w` only (grows left, right edge pinned); middles → `e` and `w` (either edge changes width; the `translateX(-50%)` pin recenters). No corners, no `n`/`s`. Resize commit does not evict.
- Snap: verify (not build) that slotted panes participate as candidates — `snapshotCardRects` already reads live DOM rects per Risk R02; a slotted pane is never itself snap-dragged (drag converts it to free first, at which point normal snap applies).
- `data-imposed` attribute on the frame (sibling of the existing `data-anchored`) for tests and CSS hooks.

**Tasks:**
- [ ] Implement the style branch; verify the collapsed composition (horizontal pin + `top: 0`, bottom released).
- [ ] Implement drag-start conversion: snapshot canvas-relative rect, write free px inline styles, clear pin styles and transform, seed `dragStartPosition.current` (and the clamp inputs) from the snapshot rect — not from state `position` — then proceed with the standard free-drag machine (Risk R01).
- [ ] Implement the dedicated imposed-resize path (width-only, DOM-seeded, per-anchor-class grow direction as specified in Artifacts); render only the permitted handles for imposed frames.
- [ ] Verify slotted panes appear correctly as snap candidates via the existing `snapshotCardRects` DOM read (Risk R02).

**Tests:**
- [ ] (Deferred to the app-test in #step-8 — real-geometry assertions; no jsdom render tests per #test-non-goals.)

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] Manual smoke in the debug app: assign via console dispatch (`window` action dispatch or dev panel), drag a slotted pane out, resize its permitted edges, collapse/expand it. **Deferred to the interactive phase** — the gestures need a human at the pointer; the assign / stack / width-preservation / evict path is asserted mechanically by the #step-8 app-test.

---

#### Step 5: Lens Layouts section {#step-5}

**Depends on:** #step-3

**Commit:** `tugways(imposition-lens): Layouts section with kind picker [L02][L11]`

**References:** [P01] vocabulary, [P08] shrink/off, Spec S04, Table T01, (#investigation-findings, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/lens/sections/layouts-section.tsx` + `.css`, registered from `main.tsx` beside the existing `register*Section` calls.
- `set-imposition` action in `tugdeck/src/action-dispatch.ts` per Spec S04.

**Tasks:**
- [ ] Section definition: `kind: "layouts"`, `title: "Layouts"`, a suitable lucide glyph, not `filterable`; `collapsedSummary` reads the deck store and renders the active kind's label ("Two Up" / "Three Up" / "Four Up" / "Off").
- [ ] Body composes `TugRadioGroup` (never hand-rolled radios) with four options — Off, Two Up, Three Up, Four Up — each option labeled with a small graphical N-up diagram (inline SVG in the option label; no image assets); controlled by `deckState.imposition` via `useSyncExternalStore` on `getDeckStore()`; change dispatches `set-imposition`.
- [ ] Publish `setSectionContent(host.focusGroup, { navigable: true, populated: true })` from a `useLayoutEffect` (the radio group is always present and focusable), with the cleanup mirror the other sections use.

**Tests:**
- [ ] (UI verified in the #step-8 app-test; the action handler's payload validation gets a unit test beside the existing `action-dispatch.test.ts` patterns.)

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 6: SlotPicker on Sessions + Text Files rows {#step-6}

**Depends on:** #step-3, #step-5

**Commit:** `tugways(imposition-slots): SlotPicker cluster on Sessions and Text Files rows [L02][L11]`

**References:** [P05] slots are stacks, [P06] detach-on-assign, [P10] eligibility, Spec S04, (#flow-assign, #investigation-findings)

**Artifacts:**
- `tugdeck/src/components/lens/slot-picker.tsx` + `.css`.
- `assign-slot` action in `action-dispatch.ts` per Spec S04.
- Integration into `sessions-section.tsx` (row `trailing`, joining the existing sparkline) and `text-files-section.tsx` (`FileRow` gains `trailing`).

**Tasks:**
- [ ] `SlotPicker({ cardId })`: reads the deck store (imposition kind + the host pane's `slot`) via `useSyncExternalStore`; renders nothing when `imposition` is null; otherwise renders N `TugButton`s (`subtype="icon"`, `size="xs"`) labeled 1…N, the host pane's current slot shown filled/active; click dispatches `assign-slot` with the 0-based index and calls `stopPropagation()` so the click never reads as row activation (the Snippets trailing-buttons convention).
- [ ] Rows in an anchored pane (not applicable today — Lens rows never represent the rail — but guard anyway) render the picker disabled.
- [ ] Verify row height is unchanged with the cluster present (the trailing span is inline in `TugListRow`; keep buttons `xs`).

**Tests:**
- [ ] `assign-slot` payload validation unit test (bad cardId / out-of-range slot warn and no-op).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 7: tuglaws amendment {#step-7}

**Depends on:** #step-4

**Commit:** `tuglaws(pane-model): record the imposed pane geometry mode`

**References:** [P01]–[P12] (the decisions this durable record captures), (#documentation-plan)

**Artifacts:**
- `tuglaws/pane-model.md`: free / anchored / imposed as the three geometry modes; `slot` + `imposition` in the wire-contract example; `lib/layout-imposer.ts` in the Files table.
- `tuglaws/design-decisions.md`: one new `[D##]` (next free number) stating the imposition model and citing this plan.

**Tasks:**
- [ ] Write both amendments in the documents' existing voice; keep the pane-model "The Rule" statement accurate (position/size/z remain Pane responsibilities; imposed mode only changes where a pane's geometry *derives from*).

**Tests:**
- [ ] N/A (documentation).

**Checkpoint:**
- [ ] Amended sections read coherently against the shipped code from #step-4 (review pass).

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-4, #step-5, #step-6

**Commit:** `tests(imposition): app-test for assign, stack, evict` (the app-test file; otherwise verification)

**References:** [P02], [P05], [P07], Spec S01, (#success-criteria, #test-non-goals)

**Artifacts:**
- `tests/app-test/at0275-layout-imposition.test.ts`, with `@covers` lines for `tugdeck/src/lib/layout-imposer.ts`, `tugdeck/src/deck-manager.ts`, `tugdeck/src/components/chrome/tug-pane.tsx`, `tugdeck/src/components/lens/sections/layouts-section.tsx`, `tugdeck/src/components/lens/slot-picker.tsx`.

**Tasks:**
- [ ] Test flow against the real app: open the Lens; select Three Up in the Layouts section (real click); open/replay session + text-file cards; click slot numbers on their rows; assert the (#success-criteria) rect invariants from live `getBoundingClientRect()` (span edges from the rail's live rect); assert width-preservation across assignment; assign two cards to one slot and assert coincident rects with the later assignment on top; drag the top pane off and assert it is free (rect no longer slot-derived, `data-imposed` absent) while the pane beneath remains.
- [ ] `just app-test-covers-check` passes for the new file.

**Tests:**
- [ ] The app-test above is the test.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0275-layout-imposition.test.ts`
- [x] `just app-test-changed --allow-large <dash diff>` — the derived selection over the whole change is 60 files (above the default 20-file budget, hence the explicit opt-in); 60/60 green, 124/124 tests, 6m31s. `main.tsx` also trips the SWEEP ADVISED advisory, since a section registration sits under every Lens test — those Lens tests are in the 60 and all pass; a full `app-test-all` is the user's call.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The layout imposer — Layouts section in the Lens, N-up slot assignment from Sessions and Text Files rows, CSS-derived resize-tracking slotted geometry, persisted in the v4 layout blob — shipped on main with unit, contract, and app-test coverage plus the tuglaws record.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every (#success-criteria) item verified by its named mechanism.
- [ ] All eight steps' checkpoints green; ledger fully `done` with commit hashes.
- [ ] `tuglaws/pane-model.md` and `design-decisions.md` amendments landed.

**Acceptance tests:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0275-layout-imposition.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Keyboard slot assignment from the Lens cursor ([Q01]).
- [ ] SlotPicker on future Lens sections (the model is already generic).
- [ ] Vertical / grid impositions if the horizontal model proves out.

| Checkpoint | Verification |
|------------|--------------|
| Geometry math correct | `bun test src/lib/__tests__/layout-imposer.test.ts` |
| Wire contract stable | serialization round-trip + defensive-read unit tests |
| Real-app behavior | `just app-test tests/app-test/at0275-layout-imposition.test.ts` |
| Production bundle intact | `cd tugdeck && bunx vite build` |
