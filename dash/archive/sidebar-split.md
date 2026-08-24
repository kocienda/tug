<!-- devise-skeleton v4 -->

## Sidebar Split — user-controlled vertical division of shared sidebar rails {#sidebar-split}

**Purpose:** Ship per-side rail splitting: a shared sidebar rail (2+ sidebar cards on one side) can be switched from today's front-to-back stack to a vertical split where every member is visible, with a draggable seam between members, drag-to-reorder within the rail, and controls in the stack badge and the Lens Layout section. Stack remains the default; the imposer's width model, allocator, and horizontal geometry are untouched.

Companion brief: `dash/sidebar-split-brief.md` (the decided design this plan implements).

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-11 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Same-side sidebar cards (Lens, Jots, Gazette — the three `layoutRole: "sidebar"` registrations) today get byte-identical frames from `imposeSidebarStyle(side, paneWidth)` (`tugdeck/src/lib/layout-imposer.ts`): same pin, same shared width property, same full vertical run (`top: 5px`, `bottom: 32px`). They stand front-to-back in the sidebar z-band (`SIDEBAR_PANE_ZINDEX_BASE = 8990`, `deck-canvas.tsx`), only the topmost visible, reached through the title-bar stack badge picker.

This is the second lived verdict on this surface. An automatic vertical split was tried first and rejected ("a worse Lens" — the doc comment above `imposeSidebarStyle`, and the dropped `order` field in `serialization.ts`'s `parseSidebars` is its fossil). The occlusion stack shipped instead, the user lived on it, and it too has been found wanting: it hides content the user wants visible at once. The synthesis both verdicts point at: splitting must be a **choice the user makes, per side**, with the stack remaining the default. That is this phase.

#### Strategy {#strategy}

- Extend the model additively: a per-side `RailArrangement { mode, order, shares }` on `DeckImposition.rails`, keyed by side, with shares as per-componentId weights so membership churn can never misalign heights.
- Keep the load-bearing invariant: live window resize runs no JavaScript. Split-member vertical geometry is `calc()` over per-side seam custom properties, written by the same `deck-canvas.tsx` layout effect that writes the rail width properties.
- Reuse the gesture precedents verbatim: the seam drag follows `handleSidebarResizeStart`'s live-property-write pattern; the corridor reorder builds on the three-phase drag machine and `pane-flip.ts`.
- Land in dependency order: pure geometry → wire format → manager/actions → FLIP vertical scale → canvas threading + frame rendering → controls (badge menu, Layout section) → seam gesture → corridor drag → doctrine → app-test.
- Every mode/order change animates through the existing `arrangementSignature` FLIP settle by adding rail-arrangement terms to the signature — no new animation system. The settle carries a height change as **real geometry plus a fade** ([P12] as revised by [D135]): the front member's actual `height` tweens while buried members fade in or out at their tiles, because a mode flip halves or doubles a height and a `scaleY` of that size is a raster smear, not motion.
- Verify at the real-geometry layer: unit tests for the pure math and serialization, one app-test asserting live member rects in the running app, `bunx vite build` before any step is declared done.

#### Success Criteria (Measurable) {#success-criteria}

- With Lens + Jots pinned right and the right rail split, live `getBoundingClientRect()` in the running app shows two non-overlapping frames that tile the rail run: top member's top ≈ canvas top + 5px, bottom member's bottom ≈ canvas bottom − 32px, and the vertical gap between them ≈ `IMPOSITION_GAP_PX` (±1px). Both frames share the rail's one width. (App-test assertion.)
- In stack mode nothing changes: same-side members render byte-identical frames exactly as today. (Existing unit tests, re-scoped to stack mode, still pass; app-test asserts identical rects after re-stacking.)
- A seam drag changes only the two adjacent members' heights, persists `shares` in the layout blob, and survives relaunch. (App-test assertion; the blob is read off disk through the harness's tugbank helper, exactly as `at0276-lens-side-persists` reads `dev.tugtool.deck.layout`/`layout`.)
- Reordering members (via `setRailOrder`) flips the members' vertical positions and persists. (App-test assertion.)
- A split rail's vertical order does not move when a member is activated: clicking either member leaves both frames' rects unchanged. (App-test assertion — this is [R06]'s falsifiable form.)
- A mode flip crosses rather than cuts: the front member's real height tweens through the settle window while the buried member fades at its final tile, and neither jumps in one frame. (Manual smoke in #step-5/#step-6; the arithmetic is unit-pinned in #step-4 as revised by [D135].)
- Mode survives membership churn: split right rail → close Jots → Lens takes the full run → reopen Jots → the split (mode, order, shares) re-applies. (App-test assertion.)
- `imposition.rails` round-trips through serialize → deserialize; pre-split v4 blobs (including first-split-era blobs carrying `order` inside `SidebarEntry`) parse to stacks with no error. (Unit tests.)
- No `ResizeObserver` or resize listener is added to the geometry path; the only geometry JS during a window resize remains the existing settled-resize retune. (Checkpoint grep.)
- `cd tugdeck && bun test` and `bunx vite build` pass at every step boundary.

#### Scope {#scope}

1. `RailArrangement` model + pure geometry (seam fractions, split member styles) in `layout-imposer.ts`, unit-tested.
2. Wire format: `imposition.rails` serialization + defensive parse.
3. DeckManager API: `setRailMode`, `setRailOrder`, `setRailShares`, `equalizeRail`; actions `set-rail-mode`, `equalize-rail`.
4. `lib/pane-flip.ts`: real-geometry settle math ([D135]) — the distortion cap and `springSizeKeyframes`, so a mode flip crosses in true height instead of cutting or smearing.
5. DeckCanvas: seam custom properties, per-member placement threading, registration-ordered rail enumeration, arrangement-signature terms.
6. TugPane: split-member frame styles, split-aware stack badge (glyph + menu verbs + rail-ordered rows).
7. Lens Layout section: per-shared-side Stack | Split control with miniature + preview layers.
8. Seam splitter element with drag + double-click equalize.
9. Corridor drag: title-bar drag reorders within the rail, converts one-way to free drag on corridor exit.
10. tuglaws amendments and the app-test.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Auto-split on second card. Stack is and remains the default; revisit only as follow-on work.
- Pairwise sub-groups, stack-within-split, horizontal sub-splits, or splitting content-card slot stacks (the N-up band's own overlap behavior is untouched).
- Any width change: one rail width per side, allocator untouched, the imposer still never sizes.
- New chords. Both new actions are [L30]-clean (no default binding); ⌥⌘]/⌥⌘[ keep working unchanged.
- Per-member collapse or hide affordances inside a split (close/× already exists per card).

#### Dependencies / Prerequisites {#dependencies}

- The sidebar generalization as shipped: `DeckImposition.sidebars`, `sidebarRailsOf`/`slotStackByPaneId` in `deck-canvas.tsx`, `_sidebarRails`/`_commitImposition` in `deck-manager.ts`.
- `lib/pane-flip.ts` (FLIP tween math) and the `arrangementSignature` settle machinery in `deck-canvas.tsx`. `pane-flip.ts` is the one dependency this phase also *modifies* — see [P12] and #step-4.
- `TugPopupMenu`, `TugChoiceGroup`, `LayoutMiniature`, and the Layouts section's preview-layer system.

#### Constraints {#constraints}

- Tuglaws: [L02] external state via `useSyncExternalStore`; [L03] registrations in layout effects; [L06] appearance/geometry via CSS+DOM, never React state; [L09] panes own geometry; [L13] motion through TugAnimator; [L23] an internal operation — a card closing — must not destroy the arrangement the user chose ([P06]). Commits name the laws touched.
- Live resize must stay JS-free: split geometry is fractions of the run in `calc()`, re-resolved by the browser's reflow.
- bun, never npm; `bunx vite build` from `tugdeck/` before declaring any tugdeck step done (the debug app loads the prod rollup bundle).
- App-tests are selective (`@covers` + `just app-test <file>` / `just app-test-changed`); never the full corpus.
- Never hand-roll UI that exists as a Tug* component; the new Layout-section control composes `TugChoiceGroup`, the badge menu extends the existing `TugPopupMenu`.
- No `localStorage`; all persistence rides the v4 layout blob (`dev.tugtool.deck.layout`, `settings-api.ts`).

#### Assumptions {#assumptions}

- All three sidebar registrations carry `sizePolicy.min.height: 240` (verified: `lens-register-card.tsx`, `jots-card-registration.tsx`, `gazette-card-registration.tsx`). The seam clamp reads each member's policy, never a constant.
- `getTugZoom()` handling in gestures carries over unchanged from the sidebar-resize precedent.
- A fourth sidebar card registered later participates in splits with zero model change (order/shares tolerate absentees; the Layout section's rail rows are membership-derived).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows `tuglaws/devise-skeleton.md` v4: explicit `{#anchor}` headings, kebab-case anchors without phase numbers, two-digit labels (`[P01]`, `[Q01]`, `S01`, `T01`, `R01`), `**Depends on:**` lines citing `#step-N` anchors, `**References:**` lines citing plan artifacts — never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Corridor tolerance width (DECIDED — start at 80px, one named constant) {#q01-corridor-tolerance}

**Question:** How far outside the rail's horizontal band may the pointer stray before a reorder drag converts to a free drag?

**Why it matters:** Too tight and a slightly diagonal reorder gesture unpins the card the user meant to shuffle; too loose and a deliberate drag-out feels sticky.

**Resolution:** DECIDED — `RAIL_CORRIDOR_SLOP_PX = 80` as a named constant in `tug-pane.tsx`, beside `DRAG_MOVE_THRESHOLD_PX` (the same gesture's other pointer-travel constant — Spec S01 says why not the pure module), applied on each side of the rail's live rect. Tuned by feel during #step-8's manual smoke; the constant is the one-line change.

#### [Q02] Keyboard nudge on the seam (DEFERRED) {#q02-seam-keyboard}

**Question:** Should the seam be a focusable stop with arrow-key nudge (the `TugSplitPane` interaction contract includes one)?

**Why it matters:** The Lens is keyboard-first; a pointer-only seam is a gap in that language.

**Resolution:** DEFERRED — ship pointer-first (drag + double-click equalize + the badge menu's Equalize Heights, which is keyboard-reachable). A seam focus stop touches the focus-language surface and the tabled focus-nav subsystem; design it when that reopens. The Equalize menu item means every seam outcome except a custom ratio is keyboard-reachable at ship.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Corridor drag fights the drag machine ([R01]) | high | med | the latch's *release* becomes conditional (the bracket still opens for both); conversion is one-way and reuses the existing release path | any visual jump at latch or conversion |
| Dragged frame's inline transform fights the settle FLIP ([R02]) | med | med | dragged frame keeps `data-gesture` through the commit and gets its own FLIP; settle skips it | dragged member snaps or double-animates on drop |
| Seam properties go stale as membership shrinks ([R03]) | med | low | the inset effect writes/removes all seam properties for both sides every pass | a member pinned to a phantom seam after closing a card |
| Legacy first-split blobs mis-parse ([R04]) | low | low | `parseSidebars` already drops the old per-entry `order`; new `rails` parse is defensive and separate | any parse error on an old blob |
| Squeeze below member minimums on short windows ([R05]) | low | med | proportional squeeze is the designed behavior; seam drag clamps to minimums in JS | a member unusably short on a normal display |
| Default vertical order follows z-order ([R06]) | high | high (unmitigated) | `effectiveRailOrder`'s fallback is registration order, sorted by the caller; `setRailMode(…, "split")` materializes an explicit `order` | two split members trading places when one is clicked |

**Risk R01: Corridor drag vs the three-phase drag machine** {#r01-corridor-vs-drag-machine}

- **Risk:** `handleDragStart`'s move latch (threshold crossing) currently does exactly two things for a derived pane: `paneOcclusionGesture.begin()` and `releaseImposedFrame(...)` — i.e. every past-threshold title-bar drag on a pinned sidebar unpins it. The reorder gesture must intercept that latch without destabilizing the free-drag path every other pane depends on.
- **Mitigation:** the latch keeps `paneOcclusionGesture.begin()` unconditional — a reorder needs the reveal-and-block-hides bracket as much as a free drag does, since the dragged member passes over its siblings ([P09]) — and makes only the **release** conditional: a split-rail member enters reorder mode (no `releaseImposedFrame`, no `dragStartPosition` re-seed), everything else takes today's body byte-for-byte. Conversion out of the corridor then runs just the two lines the reorder skipped (`releaseImposedFrame` + re-seed from the released rect) and from then on the gesture *is* a free drag — one-way, no return, no new commit path, and no second `begin()` to balance. The drop branch checks which mode the gesture ended in: reorder → `onSetRailOrder`, free → the existing `onCardMoved(..., { evictSlot: true })`; `paneOcclusionGesture.end()` runs in both, exactly where it does today.
- **Residual risk:** the reorder frame path (transform-based, since the frame is pinned by calc styles and `left`/`top` writes would fight the pins) is new per-frame code; kept small and appearance-zone only.

**Risk R02: The dragged member's transform vs the settle FLIP** {#r02-transform-vs-settle}

- **Risk:** on drop, the order commit changes `arrangementSignature`, arming the settle. The settle's First pass is measured in a store subscriber (before re-render) and skips frames carrying `data-gesture`; its Last pass (layout effect) also skips them. The dragged frame still wears the reorder's inline transform at commit time; if the settle tweened it, First/Last would both include the stale transform and the delta would be wrong.
- **Mitigation:** the dragged frame keeps `data-gesture` through the commit (the settle then ignores it entirely, both passes); siblings — whose preview transforms were already cleared, or who carried none — settle normally. The drop handler then runs the dragged frame's own FLIP: measure its transformed rect (First), clear the inline transform, let the commit's layout land (Last), tween with `animate(frame, springKeyframes(...), { key: "imposer-flip", ... })` exactly as `deck-canvas.tsx`'s settle does, and remove `data-gesture` when the tween is registered. `lib/pane-flip.ts` documents the keyframe rules (transform-only, keyword easing).
- **Residual risk:** two FLIP owners (settle for siblings, drop handler for the dragged frame) in one gesture; the shared `key: "imposer-flip"` and `slotCancelMode: "snap-to-end"` keep a mid-gesture second arrangement change from stacking tweens.

**Risk R03: Stale seam custom properties** {#r03-stale-seam-properties}

- **Risk:** seam properties are per-gap (`--tug-rail-right-seam-0`, `-1`, …); a rail going 3 members → 2 leaves `-1` behind, and any expression still reading it pins a frame to a phantom seam.
- **Mitigation:** the inset layout effect in `deck-canvas.tsx` writes both sides' seam properties on every pass and explicitly `removeProperty`s indices beyond the current gap count (sweep up to `SIDEBAR_PANE_ZINDEX_MAX_RANK`, far past any real rail). Frames read only the seams their own placement names, and placements are re-derived on the same commit.
- **Residual risk:** none meaningful — the sweep is cheap and the effect already runs on exactly the right commits.

**Risk R06: The rail's member enumeration is z-order, not registration order** {#r06-order-is-z-order}

- **Risk:** `sidebarStackOrder`'s docstring says the ids arrive in "the map's own key order — which is registration order". They do not. It filters the list its caller passes, and `sidebarRailsOf` passes `findSidebarPanes(state)`'s order, which walks `state.panes` — the array `activateCard` reorders. Today that is invisible (every member draws the same rect). In split mode, with no stored `order` — the state one keystroke after "Split Vertically" — the vertical order would be z-derived: clicking the lower card raises it, the effective order changes, `arrangementSignature` changes, and the two cards visibly trade places on a click. The same defect already makes the signature's rail term z-sensitive, arming an empty settle window (and a session-notification hold) on every rail activation.
- **Mitigation:** two, and both are cheap. `sidebarRailsOf` sorts componentIds into `getAllRegistrations()` order before calling `effectiveRailOrder`, so the fallback means what [P03] says it means; and `setRailMode(side, "split")` writes an explicit `order`, so the fallback is only ever reached before the first split. The signature's rail term then reads the effective order, which is what finally makes it z-blind — the property its own comment already claims.
- **Residual risk:** registration order is fixed at boot and the registry is a `Map`, so insertion order is stable; a card registered later (there is no such path today) would append rather than reshuffle.

---

### Design Decisions {#design-decisions}

#### [P01] Split is a property of the side, stored as `RailArrangement` on `imposition.rails` (DECIDED) {#p01-per-side-arrangement}

**Decision:** `DeckImposition` gains an additive `rails?: { left?: RailArrangement; right?: RailArrangement }` where `RailArrangement = { mode?: "stack" | "split"; order?: string[]; shares?: Record<string, number> }`. Absent `mode` reads as `"stack"` — today's behavior, unchanged blobs unchanged.

**Rationale:**
- A side is a stack or a split; all visible members participate. No pairwise sub-groups — that is the complexity cliff, and two-or-three cards don't need it.
- Membership stays in `sidebars[componentId].side` untouched, so `setSidebarSide`, drag-to-unpin, the Left/Right controls, and the allocator all carry over verbatim.
- Follows [D121]'s additive precedent (`kind` widened twice without a version bump).

**Implications:** new accessors in `layout-imposer.ts` (Spec S01); `serialization.ts` gains a defensive `parseRails`; `_commitImposition` needs no structural change (the record rides `imposition` through the existing commit funnel).

#### [P02] Shares are per-componentId weights, never index-positional fractions (DECIDED) {#p02-shares-weights}

**Decision:** `shares` maps componentId → positive weight, default 1 per member. Effective heights renormalize over the members actually present.

**Rationale:**
- Membership churns (cards close, unpin, change sides); weights keyed by componentId can never misalign heights with members the way a positional array can.
- Default-1 gives equal division with an empty record — the absent case is the common case.

**Implications:** seam fractions are computed (`railSeamFractions`, Spec S01), never stored; a seam drag writes the two adjacent members' weights (renormalized so untouched members keep their ratios); "Equalize" deletes the side's `shares`.

#### [P03] Effective order = stored order filtered to present members, absentees appended in registration order (DECIDED) {#p03-effective-order}

**Decision:** `sidebarStackOrder()` is superseded by `effectiveRailOrder(imposition, side, componentIds)`: the side's stored `order` filtered to the ids actually standing there, then any present ids the stored order doesn't name, in the order the caller hands them — and **the caller must hand them in registration order**. Additionally, `setRailMode(side, "split")` materializes an explicit `order` at the moment of the split, so a split rail's vertical order is never derived from anything that moves.

**Rationale:**
- Order becomes real, user-owned state on a split rail — the current docstring's "there is deliberately no vertical order to record" becomes false and is rewritten.
- Tolerating absentees is what lets mode/order/shares survive membership churn ([P06]).
- **The "registration order" the current docstring claims is not what the code does.** `sidebarStackOrder` filters whatever list it is given, and `sidebarRailsOf` gives it `findSidebarPanes(state)`'s order — which walks `state.panes`, the array `activateCard` reorders. That is z-order. Harmless while every member draws the same rect; in split mode it would make the default vertical order follow z, so clicking the lower card would raise it, change the effective order, change the signature, and **visibly swap the two cards on a click** ([R06]).
- Materializing `order` on the split is the belt to that suspenders: the instant vertical order becomes visible it becomes stored state, and nothing downstream has to re-derive it.

**Implications:** the imposer stays pure (no registry import), so the sort is the caller's: `sidebarRailsOf` orders componentIds by `getAllRegistrations()`'s insertion order — registration is a boot step, so that order is fixed and stable — before calling `effectiveRailOrder`. Stack mode also reads this order (it changes nothing visible there — z-order still decides front/back — but rail member enumeration in `sidebarRailsOf` and the badge picker use one function, not two), and reading it there is what makes the rail term in `arrangementSignature` z-blind at last ([P10]).

#### [P04] Split geometry is CSS-derived seam fractions; live resize stays JS-free (DECIDED) {#p04-css-derived-seams}

**Decision:** Member vertical pins are `calc()` over per-side seam custom properties (`--tug-rail-left-seam-N` / `--tug-rail-right-seam-N`, plain numbers in [0,1]), written by the same `deck-canvas.tsx` layout effect that writes `sidebarWidthProperty(side)` and the insets. The vertical run is `100% − 5px − 32px` (the existing `IMPOSITION_GAP_PX` top / `IMPOSITION_GAP_BOTTOM_PX` bottom); the inter-member gap is `IMPOSITION_GAP_PX`, split half-and-half across each seam.

**Rationale:**
- Exactly the mechanism the horizontal insets use, for exactly the reason: the browser re-resolves fractions of the run on its own reflow, so a window resize costs zero JS ([L06]).
- Properties on the frames' containing block keep a mid-drag seam write one `setProperty` call, like the rail width drag.

**Implications:** Spec S02 gives the exact expressions; the effect-ordering constraint in `deck-canvas.tsx` (inset effect **before** the settle's Last-measure effect — declaration order is load-bearing, the existing comment says so) applies to the seam writes too, so they go in the same effect.

#### [P05] Seam drags are live property writes with JS min-clamping; window squeeze is proportional (DECIDED) {#p05-seam-clamp}

**Decision:** The seam drag clamps at gesture time to each adjacent member's `sizePolicy.min.height` (all three sidebar cards: 240). Window shrink is CSS-only, so fractions squeeze all members proportionally — a member may render below its minimum on a genuinely short window rather than clipping a sibling. No refusal states.

**Rationale:**
- A split is always allowed; pathological windows degrade proportionally and recover on their own.
- Clamping in CSS would need per-member `max()`/`min()` cascades that overflow the run when they bind; the gesture-time clamp is where the user is, and the proportional fallback is honest everywhere else.

**Implications:** the drop commit converts the clamped pixel heights back to weights; the app-test asserts the clamp by dragging a seam past a member's minimum.

#### [P06] Mode, order, and shares survive membership churn (DECIDED) {#p06-survive-churn}

**Decision:** `rails[side]` persists untouched when the side drops to one (or zero) visible members; a side at one member renders identically in both modes. When a member returns, the arrangement re-applies.

**Rationale:** user-resolved in the brief's review; matches how `sidebars` entries already persist for hidden cards.

**Implications:** no cleanup pass anywhere deletes a `RailArrangement`; only explicit "Stack" gestures write `mode: "stack"` (keeping order/shares for a later re-split — they're harmless and preserve intent).

#### [P07] The stack badge is the gateway; its glyph states the mode (DECIDED) {#p07-badge-gateway}

**Decision:** In stack mode the badge menu (Layers glyph + count) gains one item below the member rows: "Split Vertically". In split mode the glyph swaps to Rows2 (Rows3 at 3+ members), count stays, and the menu offers the member rows (select → activate/focus), "Stack", and "Equalize Heights".

**Rationale:** the badge is already the one place a shared rail announces itself; zero new chrome. In split mode nothing is occluded, so member rows become focus verbs rather than reveal verbs — `onRevealPane` → `transferFocusForActivation` + `store.activateCard` already does the right thing unchanged.

**The rows themselves change in split mode.** `slotStackByPaneId` builds entries as `[...members].reverse()` — topmost first — and stamps each with `topmost: i === 0`, which the title bar maps to the menu row's `selected`. Neither fact survives a split: there is no topmost when every member is visible, so the check column would land on whichever card was raised last, which is a claim about z-order dressed up as a claim about what you are looking at. In split mode the rows list in **effective rail order** (top to bottom, the order the eye reads them in) and the check marks the **focused** member — `deckState.activePaneId`, the pane the deck would act on — with **no row checked** when focus rests outside the rail. This is `slotStackByPaneId`'s job, not the title bar's: entries already arrive display-resolved, and the title bar renders from props alone.

**`SlotStackEntry.topmost` is renamed `selected` in the same step.** The field would otherwise carry two different meanings by mode under a name that states one of them — the same species of stale docstring [P03] exists to correct three files away, and cheaper to fix now than to read wrong later. The rename is mechanical: one producer (`slotStackByPaneId`), one consumer (`tug-pane.tsx`'s badge rows, which already spell the prop `selected`), and the type. Stack mode's value is unchanged (`i === 0`), so the rename moves no behavior.

**Both members of a split show a badge, and that is a change.** The badge's render condition is `slotStack.length > 1` and its comment leans explicitly on occlusion for the rest: "occlusion hides it along with everything else on a fully-covered pane, so a same-width stack shows exactly one." In a split nothing is occluded, so a two-member split shows two `Rows2 2` badges — one per member, each telling the truth about the same rail. That is the honest reading (every visible pane is entitled to say where it stands) and it needs no code change, but it falsifies that comment: the comment is rewritten in #step-6 and the behavior recorded in #step-10's pane-model amendment.

**Implications:** menu items need ids distinct from paneIds (prefix `rail:`); the badge's open-state guard (`stackMenuOpen`, force-closed when depth drops to 1) carries over. Cmd-click and ⌘R (`revealStack()`) open the same menu in both modes. The verbs dispatch rather than thread: `TugPane` already reaches the registry directly for `handleSetWidth` (`dispatchCommand(TUG_ACTIONS.SET_CARD_WIDTH, …)`), so Split/Stack/Equalize follow that path instead of adding two more props through `deck-canvas` — one hop, and the title bar keeps rendering from props with `TugPane` owning dispatch.

#### [P08] The Layout section gains one row per shared side (DECIDED) {#p08-layout-section-row}

**Decision:** Below the existing per-sidebar Left/Right rows, one `TugChoiceGroup` row per side that **`railsOf` counts 2+ sidebar cards on** — the section's existing, registration-derived count, not a live visibility read: caption "LEFT RAIL"/"RIGHT RAIL", options Stack | Split, dispatching `set-rail-mode`. `LayoutMiniature` learns to draw a horizontally-divided rail; the preview-layer system gains `railmode:<side>:<mode>` layers.

**Rationale:**
- Same idiom as everything in the panel (sender-routed `selectValue`, hover/keyboard preview before commit); membership-derived rendering means a fourth sidebar card needs no edit.
- **Gating on visible pinned members would contradict the panel's own model.** `layouts-section.tsx` reads no panes at all — `useImposition` reads the imposition record and `railsOf` counts every *registered* sidebar card per side, which is exactly what the miniature draws: three rails whether or not any of the three cards are open. A visibility-gated row would need a new pane subscription and would sit under a miniature that disagrees with it.
- It also strands the user: split the right rail, close Jots, and a visibility-gated control disappears — taking the only Lens-side way to un-split with it. Splitting a side that currently shows one card is a harmless pre-arm, which is precisely what [P06] already says the record does.

**Implications:** new sender prefix `RAIL_SENDER_PREFIX = "lens-layouts-rail:"`; rail rows take focus orders after the sidebar groups; `MiniatureRails` grows a per-side mode (or a sibling prop — implementer's choice, keep `LayoutMiniature` purely presentational).

#### [P09] Corridor drag: reorder inside the rail, one-way conversion to free drag outside it (DECIDED) {#p09-corridor-drag}

**Decision:** On a split member, the drag machine's move latch enters *reorder mode*: the frame follows the pointer vertically by inline transform, siblings preview-shuffle, drop commits `order`. The moment the pointer leaves the rail's horizontal band ± `RAIL_CORRIDOR_SLOP_PX`, the gesture converts one-way to the existing free drag (`releaseImposedFrame` + today's unpin-on-drop). On a stack-mode rail nothing changes.

**The occlusion bracket runs in BOTH modes.** The latch opens `paneOcclusionGesture.begin()` before either branch, exactly as today; only `releaseImposedFrame` and the `dragStartPosition` re-seed are conditional. The bracket is not about the rail's footprint — it is about frames covering each other, which is precisely what a reorder does transiently: the dragged member translates over its sibling. With `gestureDepth` left at 0 the occlusion controller's reactive pass (its layout effect on the deck snapshot) can arm the hide timer, and `verifyHides` defers only *while a frame is animating* — a paused pointer mid-reorder with no tween running is exactly the quiescent state it waits for, so a fully covered sibling would be stamped `data-occluded` under the user's hand. `begin()` reveals and blocks hides, which is what a reorder wants and costs nothing. It also keeps the drop path's unconditional `paneOcclusionGesture.end()` paired: an `end()` with no `begin()` survives today only on the `Math.max(0, …)` clamp in the depth counter, and leaving that unpaired is a lie in a counter other gestures read.

**Rationale:** user-resolved: this gesture is the feature's soul and ships first-class. No gesture is lost — drag-away-to-unpin still works from a split rail; the vertical axis gains the reorder meaning only where a reorder is visible.

**Implications:** Risk R01/R02 carry the mechanism; Cmd-drag (move without raising) and no-travel Cmd-click (stack picker) keep their meanings; the latch's edit is *the release becoming conditional*, not a second latch body, which is a strictly smaller change to the path every other pane depends on.

#### [P10] Rail arrangement terms join the settle signature; commits ride the existing funnel (DECIDED) {#p10-signature-terms}

**Decision:** `arrangementSignature` gains the per-side mode, effective order, and seam fractions (rounded to 3 decimals). All rail-arrangement mutations commit through `_commitImposition` (via `_reimpose`), inheriting notify + `scheduleSave()` + the lifecycle ledger.

**Rationale:** mode flips and menu/section-driven reorders then animate through the existing FLIP settle — the same machinery, extended once by [P12] rather than duplicated. A seam-drag commit arms a settle whose First and Last rects are identical (the DOM already sits at final geometry from the live property writes) — a zero-delta no-op, the same coexistence rail-width edge drags already have (the signature's own comment documents that pattern).

**Implications:** the signature's rail terms must be made z-blind, which today they are **not** — `sidebarRailsOf` enumerates members through `findSidebarPanes`, which walks `state.panes` (z-order), so the rail term already changes when a rail member is activated and already arms an empty settle window on a click. [P03]'s registration-order fix repairs the existing defect and is a precondition for the order term ([R06]). Seam fractions are rounded so sub-pixel share arithmetic can't arm spurious settles.

#### [P11] New actions are `set-rail-mode` and `equalize-rail`; reorder and shares commit through manager methods (DECIDED) {#p11-actions}

**Decision:** Registry actions (validated payloads, no chords): `set-rail-mode { side, mode }` and `equalize-rail { side }`. `setRailOrder` / `setRailShares` are DeckManager methods reached through props/gesture commits, not public actions.

**Rationale:** the two actions are user-nameable verbs (menu rows, Layout section); a reorder or a seam ratio is a gesture's commit payload, which nothing else should synthesize.

**Implications:** three registration sites per action, following `set-sidebar-side` exactly: `action-vocabulary.ts` (`SET_RAIL_MODE`, `EQUALIZE_RAIL`), `action-dispatch.ts` handler, `command-registry.ts` entry.

#### [P12] The settle learns height as real geometry under a distortion cap; a mode flip is the first arrangement gesture that changes height (REVISED by [D135]) {#p12-flip-sy}

**Problem (stands):** without a height term [P10] does not deliver what it claims. `flipDelta` returns `{ dx, dy, sx }` and the Last pass skips any frame with no move and no width change — so on a stack→split flip the **top** member, whose left/top/width are all unchanged, gets no tween at all and simply cuts to half the run. Split→stack cuts the same way, and so does every membership churn (close Jots and the Lens regrows the run with no other term moving).

**First mechanism (shipped `add443bba`, rejected on sight):** `sy`/`scaleY` in the transform tween. Its rationale claimed the vertical distortion "is the trade `scaleX` already makes horizontally" — a magnitude error: the adjacent width step deforms the raster 18.5%, a mode flip ~100%, and at that size the compositor's texture stretch reads as a smear of the frame densest with small type and thin rules. Lived verdict: terrible.

**Revised mechanism ([D135]):** `sy` is removed; `FlipDelta` stays `{ dx, dy, sx }`. A scale may ride the transform tween only within `MAX_FLIP_SCALE_DISTORTION` (0.2, `max(s, 1/s) − 1`); height never smears at all. The settle reads the rects' heights directly and drives `springSizeKeyframes` — the frame's real `height` on the same damped spring, through TugAnimator ([L13]), main-thread layout for that frame bounded to the settle window. A rail mode flip choreographs concurrently: the front member's height tweens while buried members fade in at their final tiles (split) or fade out while their geometry tweens carry them home behind the front member (stack). Over-cap width jumps (Comfy↔Wide, Slim↔Wide) cross by a real `width` tween by the same rule; the adjacent step keeps its under-cap `scaleX`. TugAnimator's completion commit is handed back per settle (`inlineRestorer`), so a member's `height: auto` / `width` calc survives its own animation.

**Implications:** `pane-flip.ts` stays pure and unit-pinned — the cap's verdict on every preset pair is itself a test. Everyday arrangement gestures keep byte-identical keyframes: no scale term, no size tween, no fade.

---

### Deep Dives {#deep-dives}

#### Investigation findings a cold reader needs {#investigation-findings}

All paths relative to `tugdeck/src/` unless noted. Line numbers below are approximate anchors verified 2026-08-11, not contracts.

**The imposer module.** `lib/layout-imposer.ts` (~1094 lines) is pure (no DOM/store/React runtime imports). Relevant symbols: `DeckImposition` (~:152), `SidebarEntry { side, pinned? }` (~:126), `sidebarSide()` (~:183), `isSidebarPinned()` (~:192), `withSidebarSide()` (~:200), `withSidebarPinned()` (~:212), `sidebarStackOrder()` (~:233 — it filters whatever id list the caller passes, and its docstring claims that list is registration order; the one caller passes z-order, see below. Both the docstring and the caller are rewritten by this plan — [P03], [R06]), `IMPOSITION_GAP_PX = 5` (~:277), `IMPOSITION_GAP_BOTTOM_PX = 32` (~:291), `IMPOSITION_SETTLE_MS = 300`, `RESIZE_RETUNE_QUIET_MS = 200`, `sidebarWidthProperty(side)` (~:403 — `--tug-sidebar-width-left/right`, deliberately unregistered so `var()` fallbacks work), `LENS_RAIL_PROPERTY = "--tugx-lens-rail"` (registered `<number>`, 0 = left, 1 = right), and `imposeSidebarStyle(side, paneWidth, options?)` (~:1074) which emits `{ width: var(widthProperty, paneWidthpx), height: "auto", top: 5px, bottom: 32px, [LENS_RAIL_PROPERTY]: 0|1, left: calc(mix of both anchors by the rail number) }`. The long doc comment above it ("A shared rail is a stack, not a split…") is the text this plan supersedes. The allocator (`allocateSidebarWidths` ~:872, `solveSidebarWidths` ~:925) is **untouched** — one width per side is preserved.

**DeckCanvas** (`components/chrome/deck-canvas.tsx`). `SIDEBAR_PANE_ZINDEX_BASE = 8990` / `SIDEBAR_PANE_ZINDEX_MAX_RANK = 9` (~:117), with the canvas-overlay base at 9000 — the band between them is fully allocated, which is why the seam needs a stated z (Spec S01). `sidebarRailsOf(state)` (~:163) builds per-side `{ side, width, members }` from `findSidebarPanes` + `isSidebarPinned` + `sidebarStackOrder`, width = widest member's render width (`paneRenderWidthOf` raises stored width to the stack size floor). **Its member order is z-order, not registration order**: `findSidebarPanes` (`deck-store-selectors.ts:91`) walks `state.panes`, the array `activateCard` reorders, and `sidebarStackOrder` only filters it. This is [R06], and it is a live defect before this plan touches anything — the signature's rail term inherits the z-sensitivity. `arrangementSignature(state)` (~:237) = kind | bullseye | rails (side:width:memberIds) | sorted pane `id:slot:width` terms — deliberately blind to z-order; its comment documents why rail-width terms arm zero-delta settles after live drags. `stackByPaneId` (~:356) maps sidebar paneId → `{ side, count }` and is handed to `TugPane` as `sidebarStack`; `slotStackByPaneId` (~:410) keys stacks by `place` = `rail:${side}` or `slot:${n}` and builds display-resolved `SlotStackEntry[]` (topmost first) for the badge picker; `handleRevealPane` (~:1524) routes selection through `transferFocusForActivation` + `store.activateCard`. The **inset layout effect** (~:1132) writes `sidebarWidthProperty(side)` and `--tug-imposer-inset-left/right` on the frames' containing block (`containerRef`), keyed on a `railWidths` summary string. The **settled-resize observer** (~:1172) debounces `store.retuneSidebarAllocation()` by `RESIZE_RETUNE_QUIET_MS`. The **settle** (~:1237–1457): a store subscriber measures First rects for every `.tug-pane[data-pane-id]` frame *not* carrying `data-gesture`, holds session notifications, stamps `data-imposer-settling`; a layout effect (declared **after** the inset effect — declaration order is load-bearing, its comment says why) measures Last and runs `animate(frame, springKeyframes(dx, dy, sx), { duration, easing: "linear", fill: "none", composite: "replace", key: "imposer-flip", slotCancelMode: "snap-to-end" })`; `clearFlip` removes the inline `transform`/`transform-origin` residue. The Last pass **skips any frame with `dx === 0 && dy === 0 && sx === 1`** — which on a stack→split flip is the top member exactly, since only its height changed.

**pane-flip** (`lib/pane-flip.ts`, pure, unit-pinned). `FlipDelta` is `{ dx, dy, sx }` — `sx = first.width / last.width` — and `springKeyframes(dx, dy, sx = 1, samples = 32)` emits `translate(...)` plus a `scaleX(...)` term only when `sx !== 1`. **There is no vertical scale**, and `flipDelta`'s docstring says why: "the gestures that resize a frame move its vertical edges not at all… A height change that happens to land in the same window snaps, which is honest." A rail mode flip is exactly the gesture that sentence says does not exist, which is why [P12]/#step-4 exist. Three assertions in `lib/__tests__/pane-flip.test.ts` pin `FlipDelta`'s exact object shape via `toEqual`, and two call `springKeyframes(10, 0, 1, 4)` with `samples` positional — both move when the signature grows.

**TugPane** (`components/chrome/tug-pane.tsx`). `sidebarStack` prop → `sidebarSide` (~:1316), `pinned` (~:1335), `derivedRef` (~:1345, pinned || imposed || bullseye). The frame's `modeStyle` (~:2746) picks bullseye → sidebar (`imposeSidebarStyle(sidebarSide, renderWidth)`) → imposed → free; the frame carries `data-lens={side}` for sidebar panes (~:2826) and `data-pane-id`. The **stack badge** (~:683): rendered when `slotStack.length > 1`, a `TugPopupMenu` whose trigger is a ghost `TugButton subtype="icon-text"` with `<Layers />` + the count, `className="tug-pane-title-bar-stack-badge"`, testids `tug-pane-title-bar-stack-badge` / `tug-pane-title-bar-stack-menu`; rows are member miniatures with `selected: entry.topmost`; selection calls `onRevealPane(entry)`; open state `stackMenuOpen` is local `useState`, force-closed when depth drops to 1 (~:424); `CardTitleBarHandle.revealStack()` (~:586) opens it (⌘R and the no-travel Cmd-click path both call it, ~:2176). The **drag machine** (~:1956–2254): three phases; `DRAG_MOVE_THRESHOLD_PX = 3`; the move latch (~:2049–2067) is where `paneOcclusionGesture.begin()` and — for derived panes — `releaseImposedFrame(frame, bounds)` + `dragStartPosition` re-seed happen; per-frame writes are `frame.style.left/top`; drop commits `onCardMoved(id, pos, size, derivedRef.current ? { evictSlot: true } : undefined)`; `data-gesture` is set at start and removed at the top of `onPointerUp` (before the commit). The **sidebar width drag** (`handleSidebarResizeStart`, ~:2505–2649) is the seam drag's template: snapshot, rAF apply writing ONE custom property (`container.style.setProperty(widthProperty, px)`), move-threshold latch, occlusion bracket, commit on pointer-up with the property left as the gesture set it so no frame reads a stale value.

**DeckManager** (`deck-manager.ts`). `setSidebarSide` (~:1319) → `_reimpose(withSidebarSide(...))`; `pinLens` (~:1335); `_sidebarRails(panes, imposition)` (~:1351) folds per-side `RailPolicy` (max preferred, max min) + `panesBySide`; `_sidebarPreferredWidth` (~:1396) reads durable stores (lensStore / sidebarWidthStore), never live panes; `_allocatedRailWidths` (~:1417); `_commitImposition(imposition, panes)` (~:1475) runs the allocator, writes rail widths straight into `pane.size.width` (deliberately not through `movePane`), brackets moved/resized cards with the lifecycle ledger, `notify()`, `scheduleSave()`; `retuneSidebarAllocation` (~:1551) is the settled-resize moment; `_reimpose` (~:1574) = `_commitImposition(imposition, this.deckState.panes)`; `_unpinSidebar` (~:1592) is the drag-out path.

**Serialization** (`serialization.ts`). `serialize()` (~:142) emits `imposition` verbatim (so `rails` rides along once the type carries it — but the read side must still be defensive). `parseV4` (~:311) parses three historical imposition shapes; `parseSidebars` (~:280) builds entries **field by field, never by spread**, with a comment recording that "the split build wrote an `order` here (a member's position in a rail that divided vertically)" — the first split attempt's per-entry `order` is dropped on read and must stay dropped. The new `rails` record is a sibling of `sidebars`, parsed by a new defensive `parseRails`.

**Layouts section** (`components/lens/sections/layouts-section.tsx`, ~589 lines). Sender-routed: one `useResponder` (`id: "lens-layouts-section"`) handles `SELECT_VALUE` and routes by `event.sender` (`KIND_SENDER_ID`, `WIDTH_SENDER_ID`, `SIDE_SENDER_PREFIX + componentId`) to `dispatchCommand(...)`. `sidebarEntries()` (~:153) walks `getAllRegistrations()` for `layoutRole === "sidebar"`, and `railsOf()` (~:167) counts those **registered** cards per side into `MiniatureRails`. The section reads no panes at all — `useImposition` reads the imposition record and nothing else — so its whole model of "what stands on a side" is registration-derived, open or closed. That is what [P08]'s gating follows. Preview: `PlanLayer[]` (~:387) with `previewId` families `kind:`, `width:`, `side:componentId:side`; visibility is DOM attributes toggled by `setPreview` (~:344) from pointer (`previewIdOf`, ~:269) and a `MutationObserver` on `data-key-cursor`/`data-key-view-kbd` (~:362). Focus orders: kind 0, width 1, sidebars from 2 (`LAYOUTS_FIRST_SIDEBAR_FOCUS_ORDER`); rail rows take the orders after the sidebar groups. `LayoutMiniature` (`components/lens/layout-miniature.tsx`) is purely presentational: `{ kind, rails: MiniatureRails, cards?, width?, selected? }`, `Rail` member draws stacked "paper" offsets (`RAIL_DEPTH_PCT = 3`), `RAIL_NOMINAL_PX = 420`.

**Actions plumbing.** `TUG_ACTIONS.SET_SIDEBAR_SIDE` in `components/tugways/action-vocabulary.ts` (~:817) + handler in `action-dispatch.ts` (~:580, payload-validated, `console.warn` on bad input) + entry in `components/tugways/command-registry.ts` (~:1319) is the three-site pattern the new actions copy.

**Persistence.** Blob: tugbank domain `dev.tugtool.deck.layout`, key `layout` (`settings-api.ts`); `DeckManager.saveLayout()` behind debounced `scheduleSave()`.

#### End-to-end flow: user splits the right rail from the badge {#flow-split}

1. Lens + Jots pinned right (a `rail:right` stack of 2). The Jots title bar's badge menu shows two member rows + "Split Vertically".
2. Selecting it dispatches `set-rail-mode { side: "right", mode: "split" }` → `action-dispatch.ts` handler → `deckManager.setRailMode("right", "split")` → `_reimpose` over `withRailMode` **and** `withRailOrder`: the split materializes `order: ["lens", "jots"]` in the same imposition ([P03]), so the vertical order is stored state from the first frame rather than a fallback that a later click could move ([R06]).
3. `_commitImposition` commits; `notify()` re-renders. `deck-canvas` derives the right rail's member placements (effective order: the stored [lens, jots]; shares absent → seam fraction 0.5), writes `--tug-rail-right-seam-0: 0.5` in the inset effect.
4. Each member's `TugPane` renders the split style: Lens `top: calc(5px + 0 * run)`, `bottom: calc(32px + (1 − 0.5) * run + 2.5px)`; Jots `top: calc(5px + 0.5 * run + 2.5px)`, `bottom: 32px` — where `run = (100% − 5px − 32px)`.
5. `arrangementSignature` changed (mode + order + seam terms), so the settle carries both frames from full-run overlap to their halves — the front member by a real `height` tween (its left, top and width are all unchanged, which is precisely why the height term is load-bearing: without it this frame gets no motion at all), the buried member by a fade in at its final tile ([D135]). The seam element appears in the gap at its final position.
6. Window resize: fractions re-resolve in reflow; no JS runs.

---

### Specification {#specification}

**Spec S01: Model and pure API additions (`lib/layout-imposer.ts`)** {#s01-model-api}

```ts
export type RailMode = "stack" | "split";

export interface RailArrangement {
  /** Absent reads as "stack" — today's behavior. */
  mode?: RailMode;
  /** componentIds, top-to-bottom. Absent = registration order. */
  order?: string[];
  /** Height weight per componentId; absent member = 1. Positive finite only. */
  shares?: Record<string, number>;
}

export interface DeckImposition {
  kind?: ImpositionKind;
  contentWidth?: ContentWidth;
  sidebars: Record<string, SidebarEntry>;
  rails?: { left?: RailArrangement; right?: RailArrangement };   // NEW
}

export function railModeOf(imposition: DeckImposition, side: SidebarSide): RailMode;
export function isRailMode(value: unknown): value is RailMode;
export function withRailMode(imposition: DeckImposition, side: SidebarSide, mode: RailMode): DeckImposition;
export function withRailOrder(imposition: DeckImposition, side: SidebarSide, order: readonly string[]): DeckImposition;
export function withRailShares(imposition: DeckImposition, side: SidebarSide, shares: Record<string, number>): DeckImposition;
/**
 * Stored order filtered to present ids, then any present ids the stored order
 * does not name, in the order given. Supersedes sidebarStackOrder — see [P03].
 *
 * CALLER CONTRACT: `componentIds` must arrive in REGISTRATION order. This
 * module is pure and cannot reach the registry, and the list the current
 * caller happens to have — `findSidebarPanes`, which walks `state.panes` — is
 * Z-ORDER. Handing that in makes a split rail's default vertical order follow
 * the last raise ([R06]).
 */
export function effectiveRailOrder(
  imposition: DeckImposition, side: SidebarSide, componentIds: readonly string[],
): readonly string[];
/** Cumulative seam fractions for an ordered member list: N members → N−1
 *  strictly increasing values in (0, 1). Weights renormalized over present
 *  members; non-finite or non-positive weights read as 1. */
export function railSeamFractions(
  order: readonly string[], shares: Readonly<Record<string, number>> | undefined,
): readonly number[];
/**
 * The inverse of {@link railSeamFractions}: the weights a set of seam fractions
 * means, normalized so the members the drag did not touch keep their ratios to
 * one another. A seam drag's commit runs through here ([P05]) — this is the one
 * piece of new arithmetic on the persistence path, so it is a named pure
 * function with its own tests rather than inline gesture code.
 */
export function railSharesFromFractions(
  order: readonly string[], fractions: readonly number[],
): Record<string, number>;
/** The seam property name: --tug-rail-<side>-seam-<index>. */
export function railSeamProperty(side: SidebarSide, index: number): string;
/** One split member's place: its index, the member count, and the side. */
export interface RailMemberPlacement { side: SidebarSide; index: number; count: number }
```

**Two constants live outside the pure module, each beside what it has to reach.** `RAIL_CORRIDOR_SLOP_PX = 80` ([Q01]) goes in `tug-pane.tsx` beside `DRAG_MOVE_THRESHOLD_PX`, the other pointer-travel constant of the same gesture: it tunes a drag, the imposer has no geometry that reads it, and putting it in the pure module would only mean the drag machine imports the imposer to learn about its own threshold.

The seam element's z-index is the other, and it belongs in `deck-canvas.tsx` beside the band it has to thread rather than in the pure module: the rails occupy `SIDEBAR_PANE_ZINDEX_BASE`..`+ SIDEBAR_PANE_ZINDEX_MAX_RANK` (8990–8999) and the canvas-overlay base is 9000, so that band is fully spoken for by design. `RAIL_SEAM_ZINDEX = SIDEBAR_PANE_ZINDEX_BASE + SIDEBAR_PANE_ZINDEX_MAX_RANK` puts the seam level with the frontmost rail rank a deck can reach and still strictly below every popup — which is what it needs, because the hit strip is wider than the 5px gap and therefore overlaps each neighbour by ~2.5px. Declared with the reasoning the base's own comment models.

`imposeSidebarStyle` gains an optional third-ish parameter (folded into `options`): `member?: RailMemberPlacement`. With `member` absent or `count === 1`, output is byte-identical to today. With a member of N > 1:

**Spec S02: Split member geometry** {#s02-split-geometry}

Let `run = (100% − ${IMPOSITION_GAP_PX}px − ${IMPOSITION_GAP_BOTTOM_PX}px)` (a calc subexpression over the containing block height), `half = IMPOSITION_GAP_PX / 2` (2.5px), and `seam(j) = var(--tug-rail-<side>-seam-<j>, <fallback>)` where the fallback is the equal-division fraction `(j+1)/count` so a frame rendering before the property lands gets sane geometry (the same unregistered-property discipline as `sidebarWidthProperty`). For member `i` of `count`:

- `top`: `i === 0` → `${IMPOSITION_GAP_PX}px`; else → `calc(${IMPOSITION_GAP_PX}px + ${seam(i−1)} * ${run} + ${half}px)`
- `bottom`: `i === count−1` → `${IMPOSITION_GAP_BOTTOM_PX}px`; else → `calc(${IMPOSITION_GAP_BOTTOM_PX}px + (1 − ${seam(i)}) * ${run} + ${half}px)`
- `width`, `left`, `height: "auto"`, and the `LENS_RAIL_PROPERTY` term: unchanged from today's sidebar style.

**The hit strip costs the lower member ~2.5px of title bar, and that is the trade.** The strip is ~10px around a 5px gap and carries `RAIL_SEAM_ZINDEX` (8999), above every rank a rail can reach, so a press in the lower member's top ~2.5px starts a seam drag rather than a title-bar drag. That is the right way round — the seam is the smaller, more precise target and the title bar has the rest of its height — but it is a real cost and it is accepted deliberately: a strip narrowed to the gap itself would be a 5px target for a drag, which is under every pointing-comfort floor the deck holds elsewhere. #step-7's smoke presses just below the seam and confirms the title-bar drag still starts. (The strip also crosses the member's own width-resize handle for those few pixels; the handle runs the frame's full height, so the loss is invisible.)

The seam **element**'s vertical center for gap `j` sits at `calc(${IMPOSITION_GAP_PX}px + ${seam(j)} * ${run})` in the same coordinate space — positioned from the same properties as the frames, so it cannot drift from them. It carries `RAIL_SEAM_ZINDEX` (Spec S01) and it does **not** participate in the settle: the settle walks `.tug-pane[data-pane-id]` and the seam is not one, so on a mode flip or a reorder it appears at its final position while the frames tween to meet it. That is the accepted read — a seam is a boundary, not a card, and a boundary that slides is a fourth moving thing to track. Fade it in with a CSS opacity transition on the split attribute if the cut reads badly in #step-7's smoke.

**Spec S03: Seam custom properties (DeckCanvas)** {#s03-seam-properties}

Written in the existing inset layout effect (`deck-canvas.tsx` ~:1132), which already runs on every rail-affecting commit and — critically — is declared before the settle's Last-measure effect. Per side: for a split rail of N members compute `railSeamFractions(effectiveOrder, shares)` and write `railSeamProperty(side, j)` for j in 0..N−2 as plain number strings; then sweep-remove properties for j in N−1..`SIDEBAR_PANE_ZINDEX_MAX_RANK` and, for stack-mode or absent rails, all indices ([R03]). The effect's dependency summary string grows the per-side mode + fraction list.

**Spec S04: Actions and DeckManager surface** {#s04-actions-manager}

| Action | Payload | Handler |
|--------|---------|---------|
| `set-rail-mode` | `{ side: "left"\|"right", mode: "stack"\|"split" }` | `deckManager.setRailMode(side, mode)` |
| `equalize-rail` | `{ side: "left"\|"right" }` | `deckManager.equalizeRail(side)` |

DeckManager additions (all funneling through `_reimpose`, inheriting notify + save + ledger):

- `setRailMode(side, mode): void` — no-op when unchanged; `_reimpose(withRailMode(...))`. Switching **to** `"split"` also materializes the side's `order` in the same imposition, from `effectiveRailOrder` over the registration-ordered present members ([P03], [R06]): the vertical order becomes stored state at the instant it becomes visible.
- `setRailOrder(side, order): void` — filters `order` to sidebar componentIds; `_reimpose(withRailOrder(...))`. Gesture commit only ([P11]).
- `setRailShares(side, shares): void` — validates positive finite weights; `_reimpose(withRailShares(...))`. Gesture commit only.
- `equalizeRail(side): void` — `_reimpose` with the side's `shares` removed (order and mode kept).

**Spec S05: Wire format** {#s05-wire-format}

```jsonc
"imposition": {
  "kind": "three-up",
  "contentWidth": "comfy",
  "sidebars": { "lens": { "side": "right" }, "jots": { "side": "right" } },
  "rails": {                                  // additive-optional
    "right": { "mode": "split", "order": ["jots", "lens"], "shares": { "jots": 1.4, "lens": 1 } }
  }
}
```

Read rules (`parseRails` in `serialization.ts`, built field-by-field like `parseSidebars` — never by spread): unknown `mode` → drop the side's arrangement; `order` filtered to string entries (unknown componentIds are *kept* — the registry isn't loaded at parse time and `effectiveRailOrder` filters at use); `shares` entries dropped per-key unless positive finite numbers; an empty surviving record → the side is absent. `order` entries and `shares` keys run through `migrateComponentId` on the way in, the same rewrite the card table gets — these are componentIds and the kind-rename history is a real path (`"dev"` → `"session"`); free insurance against the next rename. The legacy per-`SidebarEntry` `order` field from the first split build stays dropped by `parseSidebars` exactly as today ([R04]). `serialize()` needs no change (it emits `deckState.imposition` whole).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `imposition.rails` (mode/order/shares) | structure | DeckManager store; React reads via `useSyncExternalStore` | [L02] |
| Seam custom properties on the frames' container | appearance | `useLayoutEffect` DOM write in `DeckCanvas` (existing inset effect) | [L03], [L06] |
| Split member frame pins (`top`/`bottom` calcs) | appearance | inline CSS from `imposeSidebarStyle` at render; browser reflow | [L06], [L09] |
| Seam drag live position | appearance | rAF `setProperty` writes during gesture, commit on release | [L06] |
| Corridor-drag transforms (dragged frame, sibling previews) | appearance | inline transforms + TugAnimator tweens, cleared at gesture end | [L06], [L13] |
| Badge menu open state | local-data | existing `useState stackMenuOpen` | [L24] |
| Layout-section rail rows' selection | derived render | computed from the deck snapshot | [L02] |
| Settle FLIP for mode/order changes | appearance | existing `arrangementSignature` machinery + new terms | [L06], [L13] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at0401-sidebar-split.test.ts` | App-test (Spec-level geometry, persistence, churn survival) |

(No other new files: the seam element lives in `deck-canvas.tsx` + `deck-canvas.css` or `tug-pane.css` beside the existing canvas-overlay pieces; the model lives in `layout-imposer.ts`.)

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `RailMode`, `RailArrangement`, `railModeOf`, `isRailMode`, `withRailMode`, `withRailOrder`, `withRailShares`, `effectiveRailOrder`, `railSeamFractions`, `railSharesFromFractions`, `railSeamProperty`, `RailMemberPlacement` | types/fns | `lib/layout-imposer.ts` | Spec S01 |
| `RAIL_CORRIDOR_SLOP_PX` | const | `components/chrome/tug-pane.tsx` | [Q01], Spec S01: beside `DRAG_MOVE_THRESHOLD_PX`, not in the pure module |
| `DeckImposition.rails?` | field | `lib/layout-imposer.ts` | [P01] |
| `imposeSidebarStyle` | fn (modify) | `lib/layout-imposer.ts` | `options.member?: RailMemberPlacement`, Spec S02; rewrite the "stack, not a split" doc comment |
| `sidebarStackOrder` | fn (retire/absorb) | `lib/layout-imposer.ts` | superseded by `effectiveRailOrder` ([P03]); rewrite docstring |
| `parseRails` | fn | `serialization.ts` | Spec S05; `order`/`shares` keys through `migrateComponentId` |
| `setRailMode`, `setRailOrder`, `setRailShares`, `equalizeRail` | methods | `deck-manager.ts` | Spec S04; `setRailMode(…, "split")` materializes `order` ([P03]) |
| `MAX_FLIP_SCALE_DISTORTION`, `scaleDistortion`, `springSizeKeyframes` | const/fns | `lib/pane-flip.ts` | [P12] as revised by [D135]: the smear cap, and real-geometry keyframes for over-cap axes |
| `RAIL_SEAM_ZINDEX` | const | `components/chrome/deck-canvas.tsx` | Spec S01: beside `SIDEBAR_PANE_ZINDEX_BASE`, below the 9000 overlay base |
| `sidebarRailsOf` | fn (modify) | `components/chrome/deck-canvas.tsx` | [P03]/[R06]: sort componentIds into `getAllRegistrations()` order before `effectiveRailOrder`; `SidebarRail` grows `mode` |
| `slotStackByPaneId` | memo (modify) | `components/chrome/deck-canvas.tsx` | [P07]: split-mode rows in rail order, the check = focused member (`activePaneId`), plus the rail's mode |
| `SlotStackEntry.topmost` → `selected` | field (rename) | the type + `deck-canvas.tsx` producer + `tug-pane.tsx` consumer | [P07]: one meaning per name; stack mode's value unchanged |
| `SET_RAIL_MODE`, `EQUALIZE_RAIL` | consts | `components/tugways/action-vocabulary.ts` | [P11] |
| `set-rail-mode`, `equalize-rail` | actions | `action-dispatch.ts`, `components/tugways/command-registry.ts` | copy the `set-sidebar-side` pattern |
| seam property writes + sweep | effect (modify) | `components/chrome/deck-canvas.tsx` | Spec S03, [R03] |
| `arrangementSignature` | fn (modify) | `components/chrome/deck-canvas.tsx` | [P10]: per-side mode/order/rounded fractions; rail terms become z-blind ([R06]) |
| `sidebarStack` prop shape | type (modify) | `components/chrome/deck-canvas.tsx` → `tug-pane.tsx` | grows `mode`, `memberIndex` (count already present) |
| seam elements + drag + dblclick | element/handlers | `components/chrome/deck-canvas.tsx` (+ CSS) | Spec S02 position, `handleSidebarResizeStart` gesture pattern, [P05] |
| split style branch, `data-rail-split` attr | logic | `components/chrome/tug-pane.tsx` | modeStyle branch passes `member` to `imposeSidebarStyle` |
| stack badge split mode | JSX (modify) | `components/chrome/tug-pane.tsx` | [P07]: Rows2/Rows3 glyph, `rail:`-prefixed menu verbs dispatched through `dispatchCommand` as `handleSetWidth` already does — no new props |
| corridor drag branch | logic | `components/chrome/tug-pane.tsx` | [P09], Risks R01/R02; new `onSetRailOrder` commit prop |
| rail rows + `RAIL_SENDER_PREFIX` + `railmode:` preview layers | JSX (modify) | `components/lens/sections/layouts-section.tsx` | [P08] |
| divided-rail drawing | props/JSX (modify) | `components/lens/layout-miniature.tsx` | keep purely presentational |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/pane-model.md`: the pinned-mode row amended — a shared rail is a stack **by default; the user may split it**; split geometry (seam properties, run division) joins the geometry-modes table; badge/picker spec ([D123]/[D129] text) gains the split-mode behavior — **rows in rail order, the check on the focused member, and a badge on every member** (in a split nothing is occluded, so the "exactly one badge" sentence the current text and the code comment both carry is true of stacks only); Files table entries for the seam.
- [ ] `tuglaws/design-decisions.md`: amend [D121] (rail arrangement state) and add a new [D##] recording the two lived verdicts and the chosen-never-imposed synthesis. [P06]'s "no cleanup pass ever deletes a `RailArrangement`" is an [L23] statement — a card closing is an internal operation, and it must not destroy the arrangement the user chose — and the amendment says so in those terms.
- [ ] Rewrite the `imposeSidebarStyle` doc comment and the `sidebarStackOrder`/`effectiveRailOrder` docstring to the new truth (done inside #step-1, recorded here for the reviewer), `flipDelta`'s "height is not read" paragraph (inside #step-4), and the stack badge's render-condition comment, whose last sentence rests on occlusion showing "exactly one" badge (inside #step-6). Four doc comments in this plan assert something the code will no longer do; each is rewritten in the step that falsifies it, not later.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | `railSeamFractions` math, `effectiveRailOrder` churn tolerance, `imposeSidebarStyle` split branch string-snapshots, `flipDelta`/`springKeyframes` vertical scale, `parseRails` defensive reads, round-trips | every pure edge, via `cd tugdeck && bun test` |
| **Integration (app-test)** | real Tug.app: split via real badge-menu click, live rect tiling, seam persistence, churn survival, re-stack | `at0401`, run by name / `just app-test-changed` |
| **Golden / Contract** | v4 blob with/without `rails` (and a first-split-era blob with per-entry `order`) parses per Spec S05 | serialization unit tests |

#### What stays out of tests {#test-non-goals}

- jsdom render tests of `TugPane`/seam/badge — banned pattern; the app-test drives the real DOM.
- Mock-store assertions of DeckManager mutations — the mutations are asserted against real geometry in `at0401` (the imposition-plan precedent: DeckManager's constructor needs a live DOM, and tugdeck has no test DOM substrate by design).
- Mid-drag corridor-exit pointer choreography — the harness's background pointer path cannot honestly express a mid-gesture trajectory exit today. The conversion branch is exercised manually in #step-8's smoke; the *commit surfaces* it lands on (`setRailOrder`, `onCardMoved` + `evictSlot`) are both app-test-asserted through their other callers. Do not fake it with synthetic PointerEvents.
- Asserting computed `flex`/property values that restate the stylesheet — assertions are on resulting rects.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Only the user commits on main (CLAUDE.md git policy); under explicitly authorized autonomous execution, commit per step reporting hash + message. Commit messages name the tuglaws touched.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Model + pure geometry in layout-imposer | done | `75b4ccff5` |
| #step-2 | Wire format: rails serialization | done | `5a81f42cc` |
| #step-3 | DeckManager rail API + actions | done | `120f04d40` |
| #step-4 | FLIP vertical scale in pane-flip | done, then superseded by #step-12 | `add443bba` |
| #step-5 | DeckCanvas seam properties, threading, signature | done | `3bfb88c00` |
| #step-6 | TugPane split rendering + split-aware badge | done | `2c02cb44c` |
| #step-7 | Seam element: drag + equalize | done | `276c6f1f7` |
| #step-8 | Corridor drag reorder | done | `f81e4b7b8` |
| #step-9 | Layout section rail rows + miniature | done | `0725f30eb` |
| #step-10 | tuglaws amendments | done | `7b837b246` |
| #step-11 | App-test + integration checkpoint | done | `c624281ce` |
| #step-12 | Distortion cap + real-geometry settle ([D135]) | done | `1e3290a9f` |

#### Step 1: Model + pure geometry in layout-imposer {#step-1}

**Commit:** `tugways(sidebar-split-model): RailArrangement, seam fractions, split member geometry [L06][L09]`

**References:** [P01] per-side arrangement, [P02] shares weights, [P03] effective order, [P04] CSS-derived seams, Risk R06, Spec S01, Spec S02, (#investigation-findings)

**Artifacts:**
- Every Spec S01 symbol in `tugdeck/src/lib/layout-imposer.ts`; `DeckImposition.rails?`; `imposeSidebarStyle` split branch per Spec S02.
- `effectiveRailOrder` replacing `sidebarStackOrder` at both call sites (`deck-canvas.tsx` `sidebarRailsOf`, and any other `sidebarStackOrder` importer — grep before deleting; keep the old name as a thin alias only if a third caller makes the rename noisy, otherwise delete it). Its docstring carries the caller contract from Spec S01 in full: **the ids must arrive in registration order**, and the reason (the module is pure, and the obvious list to reach for is z-order).
- The "A shared rail is a stack, not a split" doc comment rewritten: stack by default, user may split, citing the two lived verdicts in one sentence each.
- Unit tests in `tugdeck/src/lib/__tests__/layout-imposer.test.ts`: the existing "two members on one side are geometrically identical / no vertical term" describes re-scoped to stack mode; new describes for `railSeamFractions` (equal default, weights, renormalization over absentees, degenerate weights → 1, strict monotonicity), `railSharesFromFractions` (round-trips against `railSeamFractions` for 2 and 3 members; a one-seam change leaves every untouched member's ratio to its untouched neighbours exactly as it was — the [P02] property, and the reason this is a function and not a line of gesture code), `effectiveRailOrder` (stored order wins, absentees appended in the given order, unknown ids filtered, and — the [R06] twin — a stored order is *not* perturbed by the caller's list changing order), `railSeamProperty` naming, and `imposeSidebarStyle` split string-snapshots (first/middle/last member of 2 and of 3, var fallbacks = equal division, gap split 2.5/2.5, endpoints at 5px/32px).

**Tasks:**
- [ ] Implement Spec S01 exactly; keep the module pure (no DOM/store/React runtime imports).
- [ ] Split style emits Spec S02's expressions; `member` absent or `count === 1` → byte-identical output to today (assert with a snapshot equality test against the un-membered call).
- [ ] Rewrite the two doc comments named above. The `sidebarStackOrder` rewrite must correct the false claim, not just extend it: today's "the map's own key order — which is registration order" describes something the code does not do.

**Tests:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/layout-imposer.test.ts`

**Checkpoint:**
- [ ] `cd tugdeck && bun test` (whole suite — the re-scoped describes must not orphan other tests)
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 2: Wire format: rails serialization {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(sidebar-split-wire): parse imposition.rails defensively, additive v4 [L02]`

**References:** [P01], [P06] survive churn, Spec S05, Risk R04, (#investigation-findings)

**Artifacts:**
- `parseRails` in `tugdeck/src/serialization.ts`, called from `parseV4` beside `parseSidebars`; the parsed record joins the `DeckImposition` literal built there. Field-by-field construction, never spread (the `parseSidebars` discipline and its comment are the model).
- Unit tests beside the existing serialization suite: round-trip with a split right rail (mode+order+shares intact); pre-split blob → `rails` absent; defensive cases (bogus mode drops the side; non-finite/negative shares dropped per-key; non-string order entries dropped; empty record → absent side); a **first-split-era blob** with `order` inside a `SidebarEntry` still parses with that field dropped and no `rails` invented.

**Tasks:**
- [ ] Implement `parseRails` per Spec S05; confirm `serialize()` needs no change (it emits the record whole) and pin the emitted key set in the existing serialize key-set test.
- [ ] Run `order` entries and `shares` keys through `migrateComponentId`, and cover it: a blob naming a renamed componentId in either place comes back naming the current one.

**Tests:**
- [ ] The cases above in `serialization`'s test file.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 3: DeckManager rail API + actions {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `tugways(sidebar-split-manager): setRailMode/Order/Shares/equalizeRail + registry actions [L02]`

**References:** [P10] signature/funnel, [P11] actions, Spec S04, (#investigation-findings)

**Artifacts:**
- The four methods on `DeckManager` (`tugdeck/src/deck-manager.ts`), each validating input and funneling through `_reimpose` — which already runs the allocator, ledger, notify, and save; no change to `_commitImposition` itself.
- `SET_RAIL_MODE` / `EQUALIZE_RAIL` in `action-vocabulary.ts` with payload doc comments; handlers in `action-dispatch.ts` (validate `isSidebarSide` + `isRailMode`, warn + no-op on bad payloads — copy `set-sidebar-side`'s shape); command entries in `command-registry.ts` beside `SET_SIDEBAR_SIDE`. No chords ([L30]).

**Tasks:**
- [ ] `setRailOrder` filters to registered sidebar componentIds via the registry; `setRailShares` validates positive finite; `equalizeRail` removes the side's `shares` only.
- [ ] `setRailMode(side, "split")` materializes the side's `order` in the same imposition ([P03], [R06]) — one `_reimpose` carrying both fields, never two commits, so the split arms exactly one settle.
- [ ] Payload-validation unit tests beside the existing action-dispatch test patterns.

**Tests:**
- [ ] Action payload validation (bad side / bad mode / missing fields warn and no-op).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 4: FLIP vertical scale in pane-flip {#step-4}

> **Superseded by [D135]** after landing as `add443bba`: the `scaleY` mechanism specified below shipped, was judged a raster smear at mode-flip magnitudes, and was replaced by the distortion cap + real-geometry tween + fade choreography recorded in [P12] (revised). The body below is the historical spec of what `add443bba` built.

**Depends on:** #step-1

**Commit:** `tugways(pane-flip-sy): the settle FLIP carries a vertical scale [L06][L13]`

**References:** [P12] the settle must interpolate height, Risk R06, (#investigation-findings)

**Artifacts:**
- `FlipDelta` in `tugdeck/src/lib/pane-flip.ts` gains `sy` (`last.height > 0 ? first.height / last.height : 1`), read exactly as `sx` reads width; `flipDelta`'s docstring loses the "Height is not read" paragraph and states the new truth — a rail mode flip is an arrangement gesture that moves a frame's vertical edges, which is what the old paragraph said no gesture did.
- `springKeyframes(dx, dy, sx = 1, sy = 1, samples = SPRING_KEYFRAME_SAMPLES)` — `sy` inserted **before** `samples`, so the existing positional `springKeyframes(10, 0, 1, 4)` calls in `pane-flip.test.ts` move to `(10, 0, 1, 1, 4)`. The transform composes as `translate(...) scaleX(...) scaleY(...)`, each scale term emitted only when it is not 1, so a frame that only moves is tweened by byte-identical keyframes to today's.
- `deck-canvas.tsx`'s Last pass destructures `sy` and passes it through; its skip test becomes `dx === 0 && dy === 0 && sx === 1 && sy === 1`.
- `transform-origin` stays `0 0`, which is already correct for both axes: `dx` is measured between left edges and `dy` between tops, so the anchor `sx` already needed is the anchor `sy` needs.

**Tasks:**
- [ ] Update the three `flipDelta(...)` `toEqual({ dx, dy, sx })` assertions in `pane-flip.test.ts` — they pin the exact object shape and will fail on the new key. That failure is the point: the shape is a contract and this step changes it.
- [ ] Add the twins: `sy` from a pure height change, `sy === 1` on a zero or absent final height, and keyframe strings for scale-Y-only, scale-both, and move-only (the last asserting today's exact string).

**Tests:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/pane-flip.test.ts`

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] Manual: with no rail split anywhere, an N-up swap and a Lens side flip look exactly as they do today (the `sy === 1` path is the everyday path and must be untouched).

---

#### Step 5: DeckCanvas seam properties, threading, signature {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `tugways(sidebar-split-canvas): seam custom properties, member threading, settle terms [L02][L03][L06]`

**References:** [P04], [P10], Spec S03, Risk R03, (#investigation-findings, #flow-split)

**Artifacts:**
- Seam property writes + stale-index sweep in the **existing** inset layout effect (`deck-canvas.tsx` ~the `railWidths` effect) — not a new effect, preserving the declaration-order constraint against the settle's Last-measure effect. The effect's dependency summary string grows per-side `mode` + fraction terms.
- `sidebarRailsOf` uses `effectiveRailOrder` (done mechanically in #step-1) and — the [R06] fix — sorts the componentIds it passes into `getAllRegistrations()` order first, so the fallback order is registration order in fact and not only in the docstring. `SidebarRail` gains the side's `mode` and per-member index, so `stackByPaneId` (the `sidebarStack` prop source) grows `{ side, count, mode, memberIndex }`.
- `arrangementSignature` gains per-side `mode:order:fractions(3dp)` terms, and its **existing** rail term switches to the effective order for the same reason: sourced from the imposition record and a fixed registration order, never the panes array. This makes the function's documented z-blindness true of the rail term for the first time — today a rail activation changes it and arms an empty settle window. Extend the function's comment to say so.
- `slotStackByPaneId` threads the rail's mode into the entries (or a parallel prop) so the badge can render mode-appropriately in #step-6, and — [P07] — in split mode builds its rows in **effective rail order** rather than `[...members].reverse()`, with the check marking the focused member (`deckState.activePaneId`, nothing checked when focus is outside the rail). Stack mode keeps today's topmost-first rows and check exactly.
- `SlotStackEntry.topmost` is renamed `selected` here ([P07]) — producer, type, and the one consumer in `tug-pane.tsx`, which already spells the menu prop `selected`. Mechanical, and it must land with the split-mode branch rather than after it: the field is what carries two meanings by mode, and shipping the second meaning under the first name is the exact defect [P03] spends a paragraph correcting elsewhere.

**Tasks:**
- [ ] Implement Spec S03 including the removeProperty sweep ([R03]).
- [ ] Confirm the [R06] fix at the signature: with a split right rail, clicking each member in turn must leave `arrangementSignature` unchanged. Read it in the debug app before and after the click.
- [ ] Verify by hand in the debug app (HMR): with two sidebars right and `mode: "split"` set via console dispatch of `set-rail-mode`, the container carries `--tug-rail-right-seam-0: 0.5` and both member frames tile the run (frames still render full-run until #step-6 — assert the *properties* here, the frames next step).

**Tests:**
- [ ] (Geometry asserted in #step-11's app-test; signature growth is exercised by every later manual smoke — a mode flip must visibly settle, not cut.)

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `grep -c "ResizeObserver" tugdeck/src/components/chrome/deck-canvas.tsx` → the same count as before the step (the settled-resize observer and nothing else). Grepping the pure imposer instead would prove nothing — it never had one.

---

#### Step 6: TugPane split rendering + split-aware badge {#step-6}

**Depends on:** #step-5

**Commit:** `tugways(sidebar-split-pane): split member frames, Rows badge, Split/Stack/Equalize verbs [L06][L09]`

**References:** [P07] badge gateway, Spec S02, (#investigation-findings)

**Artifacts:**
- `modeStyle`'s sidebar branch passes `{ member: { side, index, count } }` to `imposeSidebarStyle` when the rail's mode is split and count > 1; the frame gains `data-rail-split` (sibling of `data-lens`) for tests and CSS.
- Stack badge: glyph `Layers` (stack) vs `Rows2`/`Rows3` (split, by count); menu items appended after the member rows — stack mode: `rail:split` → "Split Vertically"; split mode: `rail:stack` → "Stack", `rail:equalize` → "Equalize Heights". Selection routes `rail:`-prefixed ids straight to `dispatchCommand(TUG_ACTIONS.SET_RAIL_MODE | EQUALIZE_RAIL, …)`, the path `handleSetWidth` already takes for `SET_CARD_WIDTH` — no new props through `deck-canvas`, and the title bar keeps rendering from props alone with `TugPane` owning dispatch. Member-row selection stays `onRevealPane` unchanged.
- The badge's aria-label reflects the mode ("Stack of N cards" / "Split of N cards").
- The badge's own render-condition comment is rewritten ([P07]): it currently ends "occlusion hides it along with everything else on a fully-covered pane, so a same-width stack shows exactly one", and in a split nothing is occluded, so every member shows its badge. The condition itself does not change — the sentence about what the user sees does.

**Tasks:**
- [ ] Keep the `slotStack.length > 1` render condition and the open-state force-close guard exactly as they are.
- [ ] Manual smoke in the debug app: split via the badge, both members visible and tiling; **both** members now carry a badge and the pair reads as one fact about the rail rather than as noise ([P07] — if it does read as noise, that is a finding for #step-10's doctrine, not a silent code change here); the rows read top-to-bottom in rail order with the check on the focused member, not on whichever was raised last ([P07]), and no row checked when focus is outside the rail; member row click focuses (no reveal needed); clicking a member does **not** move either frame ([R06]); Stack returns to today's overlap with a settle, not a cut, and both frames change height *under a tween* rather than in one frame ([P12]); Equalize resets a hand-set ratio (ratio-setting arrives in #step-7 — for now assert it no-ops cleanly on default shares).

**Tests:**
- [ ] (Real-geometry assertions land in #step-11; no jsdom render tests per #test-non-goals.)

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 7: Seam element: drag + equalize {#step-7}

**Depends on:** #step-6

**Commit:** `tugways(sidebar-split-seam): draggable seam between split members [L06][L13]`

**References:** [P05] seam clamp, Spec S02 (seam position), Spec S04, (#investigation-findings — the `handleSidebarResizeStart` template)

**Artifacts:**
- One seam element per gap per split rail, rendered by `DeckCanvas` into the frames' container: absolutely positioned, horizontal span = the rail's width expression, vertical center = the Spec S02 seam expression, `z-index: RAIL_SEAM_ZINDEX` (Spec S01 — the hit strip overlaps each neighbour, so this is not optional); `cursor: row-resize`; visual hairline within a ~10px hit area (CSS in `deck-canvas.css` or beside the pane chrome — implementer's file call, named in the commit).
- Drag handler following `handleSidebarResizeStart` member-for-member: pointer capture, `DRAG_MOVE_THRESHOLD_PX` latch, rAF apply writing ONE property (`railSeamProperty(side, j)`), zoom-corrected deltas, **no occlusion bracket** — and here, unlike the corridor drag ([P09]), that is genuinely right: a seam drag resizes two members that stay tiled, so no frame ever passes over another and there is nothing for the bracket to keep visible. The reorder needs one for exactly the reason this does not. Note the divergence from the template, and the reason, in a comment. JS clamp so both adjacent members hold ≥ their minimum height — read through `getStackSizePolicy` over the pane's cardIds, the same source `paneRenderWidthOf` and `TugPane`'s own `sizePolicy` use, never a per-componentId lookup that a multi-card rail pane could disagree with — commit on pointer-up: convert the final fractions back to weights through `railSharesFromFractions` (Spec S01 — the named pure function, unit-pinned in #step-1, not arithmetic inlined in the handler) → `store.setRailShares(side, shares)`; the property stays as the gesture left it so no frame reads a stale value.
- Double-click on a seam → `equalizeRail(side)` (dispatch the registered action).

**Tasks:**
- [ ] Zero-delta settle: confirm the shares commit arms a settle whose tweens are no-ops (the [P10] mechanism) — watch for any visible twitch on release; if one appears, the fractions' 3-decimal rounding in the signature vs the property write is the first suspect.
- [ ] Manual smoke: drag clamps at member minimums; window-shrink squeeze is proportional and recovers; relaunch restores the ratio.
- [ ] Manual smoke, the hit-strip trade (Spec S02): press just below the seam, on the lower member's title bar, and confirm a title-bar drag still starts — the strip takes ~2.5px of it and must take no more.

**Tests:**
- [ ] `railSharesFromFractions` is already pinned in #step-1; this step adds no new arithmetic of its own — if it turns out to want some, that arithmetic goes in the imposer beside its twin rather than in the handler.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 8: Corridor drag reorder {#step-8}

**Depends on:** #step-6

**Commit:** `tugways(sidebar-split-corridor): title-bar drag reorders within a split rail, converts to free drag outside it [L06][L13]`

**References:** [P09] corridor drag, [Q01] tolerance, Risk R01, Risk R02, (#investigation-findings — the drag machine)

**Artifacts:**
- The move-latch branch in `handleDragStart` (`tug-pane.tsx`): `paneOcclusionGesture.begin()` stays **unconditional** — a reorder passes one member's frame over another's, and the bracket is what keeps the covered one from being stamped `data-occluded` under the user's hand ([P09]) — and only the release becomes conditional: when the pane is a split-rail member, latch into **reorder mode**, skipping `releaseImposedFrame` and the `dragStartPosition` re-seed. Snapshot at latch: the rail's live horizontal band (own frame's rect ± `RAIL_CORRIDOR_SLOP_PX`), each sibling member's rect and paneId (query `[data-rail-split]` frames sharing the side), and the member order.
- Reorder frame path (rAF, appearance-zone): dragged frame follows the pointer's vertical delta via inline `transform: translateY(...)`; crossing a sibling's midpoint shuffles the preview — siblings take short TugAnimator translate tweens to their would-be positions (`key` distinct from `imposer-flip`), the working order updates. **The translate is the raw pointer delta, unclamped** — see the conversion below for why a clamp here would cost a jump there.
- Corridor exit check per frame: pointer x outside the band → run the two lines the reorder latch skipped (`releaseImposedFrame`, `dragStartPosition` re-seed) and set the gesture's mode to free — one-way, and with no second `paneOcclusionGesture.begin()`, which the latch already opened; the remainder of the gesture is byte-for-byte today's free drag, including the `{ evictSlot: true }` drop. **Order is load-bearing and the sequence is: clear the reorder transform and sibling tweens FIRST, then `releaseImposedFrame`, then re-seed.** `releaseImposedFrame` measures `getBoundingClientRect()` — transform-inclusive — and does not clear `transform` itself, so releasing with the translate still on the frame banks the drag offset into `left`/`top` *and* leaves the transform on top of it: the frame doubles its own travel at the conversion. Cleared first, the released rect is the frame's true pin, `clampedPosition` re-adds the full pointer delta from `dragStartPointer`, and the frame lands exactly where the eye last saw it — which holds only while the reorder translate was the unclamped delta. Clamp the translate to the rail run and the conversion jumps by the clamp.
- Drop in reorder mode: per Risk R02 — `data-gesture` must survive the commit, which means **moving its removal out of the top of `onPointerUp`** for this branch (today it comes off before anything else runs); the free-drag branch keeps today's placement exactly. **The choice is made on the mode the gesture ENDS in, never on the branch it latched through** — a gesture that latched as a reorder and converted out of the corridor is a free drag by the time the pointer comes up, and it must drop its `data-gesture` where today's free drag does, or the settle will skip a frame that has no FLIP of its own coming. `paneOcclusionGesture.end()` is likewise unconditional, exactly where it sits today. Then: measure the dragged frame's transformed rect (First), clear sibling preview transforms, call `onSetRailOrder(side, order)` (new prop → `store.setRailOrder`), then FLIP the dragged frame from First to its committed rect via `animate(..., { key: "imposer-flip", slotCancelMode: "snap-to-end", easing: "linear", fill: "none" })` with `springKeyframes` from `lib/pane-flip.ts`, clearing transform + `data-gesture` on finish (both promise arms). No-travel release: unchanged (click / Cmd-click picker).
- Cmd-drag in a split rail: keeps its move-without-raising meaning in free mode; in reorder mode Cmd changes nothing (reorder never raises).

**Tasks:**
- [ ] Manual smoke, thorough — this is the feature's soul: reorder 2- and 3-member rails; diagonal drags stay reorders inside the corridor; deliberate drag-out unpins exactly as today, **with no jump at the moment of conversion** (that jump is the transform-ordering bug above, and it is the one defect this gesture will actually ship with if nobody watches for it); drop mid-shuffle lands the previewed order; a second arrangement change mid-settle doesn't stack tweens; tune `RAIL_CORRIDOR_SLOP_PX` by feel and record the final value in [Q01] if it moves; and pause mid-reorder with the dragged member fully covering a sibling for longer than the occlusion hide delay — the sibling must stay visible, which is the bracket doing its job ([P09]).
- [ ] Reorder members whose `shares` differ and confirm the heights stay with their cards: weights are keyed by componentId ([P02]), so a reorder is a pure translate and the `sy` term stays 1. A height change here would mean the shares moved with the position, which is the positional-fractions bug [P02] exists to prevent.

**Tests:**
- [ ] (Gesture choreography is manual + #step-11's `setRailOrder` geometry assertion per #test-non-goals; keyframe math is already unit-tested in `pane-flip`.)

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 9: Layout section rail rows + miniature {#step-9}

**Depends on:** #step-3

**Commit:** `tugways(sidebar-split-lens): per-shared-side Stack|Split rows with split previews [L02][L06]`

**References:** [P08] layout-section row, Spec S04, (#investigation-findings — the section's sender/preview anatomy)

**Artifacts:**
- In `layouts-section.tsx`: `RAIL_SENDER_PREFIX = "lens-layouts-rail:"` + caption-id prefix; one row per side the section's existing `railsOf(imposition, sidebars)` counts 2+ cards on ([P08]) — **no new store read**: the section reads the imposition and the registry and nothing else, and the row must agree with the miniature drawn directly above it, which counts the same way; caption `LEFT RAIL` / `RIGHT RAIL`; `TugChoiceGroup` Stack | Split routed in the section's one `SELECT_VALUE` handler to `dispatchCommand(TUG_ACTIONS.SET_RAIL_MODE, { side, mode })`; focus orders after the sidebar groups (extend the `LAYOUTS_FIRST_SIDEBAR_FOCUS_ORDER` arithmetic).
- Preview layers `railmode:<side>:<mode>` added to the `layers` array with `data-preview-axis` stamped on the new rows, so hover/keyboard preview works through the existing `setPreview`/`previewIdOf`/MutationObserver machinery unchanged.
- `LayoutMiniature`: a per-side mode input (extend `MiniatureRails` values or add a `railModes` prop — keep the component presentational, no store reads); a split rail draws its box divided into `count` stacked segments with hairline seams instead of the stacked-paper offset.

**Tasks:**
- [ ] Verify the collapsed summary stays kind-only (the band has room for one fact — unchanged).
- [ ] Manual smoke: a rail row appears for each side two or more sidebar cards are assigned to, open or not — the same population the miniature draws; hover previews the divided rail before committing; keyboard cursor previews the same way; committing settles the real deck. Split a side, close a member, and confirm the row is still there to un-split with.

**Tests:**
- [ ] (Covered by #step-11's real-click flow; action validation already tested in #step-3.)

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 10: tuglaws amendments {#step-10}

**Depends on:** #step-6, #step-8

**Commit:** `tuglaws(pane-model): a shared rail is a stack by default; the user may split it`

**References:** [P01]–[P11] (the decisions this durable record captures), (#documentation-plan)

**Artifacts:**
- `tuglaws/pane-model.md` and `tuglaws/design-decisions.md` amendments per the Documentation Plan, written in the documents' existing voice; the geometry-modes table's pinned row states both rail arrangements and where each lives ([P01]'s record, Spec S02's properties).

**Tasks:**
- [ ] Read the amended sections against the shipped code from #step-6/#step-8 before committing (review pass; the Files-table sync is part of pane-model.md's own contract).

**Tests:**
- [ ] N/A (documentation).

**Checkpoint:**
- [ ] Amended sections cite real symbols that exist in the tree (spot-grep each named symbol).

---

#### Step 11: App-test + integration checkpoint {#step-11}

**Depends on:** #step-7, #step-8, #step-9, #step-10

**Commit:** `tests(sidebar-split): app-test for split geometry, seam persistence, churn survival`

**References:** [P04]–[P07], [P10], Spec S02, Spec S05, (#success-criteria, #test-non-goals)

**Artifacts:**
- `tests/app-test/at0401-sidebar-split.test.ts` with `@covers` for `tugdeck/src/lib/layout-imposer.ts`, `tugdeck/src/deck-manager.ts`, `tugdeck/src/components/chrome/deck-canvas.tsx`, `tugdeck/src/components/chrome/tug-pane.tsx`, `tugdeck/src/components/lens/sections/layouts-section.tsx`. Not `lib/pane-flip.ts` — #step-4's change is pure math, unit-pinned there, and its visible effect is a tween this test deliberately settles past. Model fixture/settle discipline on the existing rail suite (`at0230-pinned-lens-geometry`, `at0276-lens-side-persists`).

**Tasks:**
- [ ] Flow: seed Lens + Jots pinned right; open the Jots badge menu (real click on `tug-pane-title-bar-stack-badge`) and select Split Vertically; settle; assert the Success Criteria tiling invariants from live `getBoundingClientRect()` (tops/bottoms/gap/shared width, ±1px); assert `data-rail-split` on both frames.
- [ ] Seam: drive `setRailShares` via a dispatched gesture-equivalent (or the seam's pointer path if the harness's background pointer can express a short vertical drag — try it first; fall back to the store method through `evalJS` action dispatch, which still exercises `_reimpose` → properties → frames in the real app); assert the two members' heights changed and the third-party member (3-member variant) held its ratio; read the persisted blob off disk with the harness's tugbank default reader — `dev.tugtool.deck.layout` / `layout`, exactly as `at0276-lens-side-persists` does at its Phase A disk assertion — and assert `rails.right.shares`.
- [ ] Reorder: `setRailOrder(["jots","lens"] → flipped)` and assert the members' vertical positions swapped.
- [ ] Order stability ([R06]): with the rail split, click each member's title bar in turn and assert both frames' rects are unchanged after the settle window. This is the regression that would otherwise ship silently — it looks like a feature until you notice the cards moved.
- [ ] Churn: close Jots → Lens holds the full run (top ≈ 5px, bottom ≈ canvas − 32px); reopen Jots → split re-applies with prior order/shares.
- [ ] Re-stack: badge menu → Stack; assert both members' rects are identical again (today's behavior restored).
- [ ] Seam-clamp: drag/set shares past a member minimum and assert the member holds ≥ its `sizePolicy.min.height`.
- [ ] `just app-test-covers-check` passes for the new file (bump `ACCEPTED_FANOUT` with a rationale comment only if it trips).
- [ ] Re-run the existing rail suite: `just app-test at0230-pinned-lens-geometry.test.ts at0276-lens-side-persists.test.ts at0299-lens-edge-drag.test.ts at0231-lens-toggle-focus.test.ts`.

**Tests:**
- [ ] The app-test above is the test.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0401-sidebar-split.test.ts`
- [ ] `just app-test-changed` over the working diff (the derived selection; use `--allow-large` only if the derived count exceeds the budget, reporting the count)

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** User-controlled vertical splitting of shared sidebar rails — per-side Stack | Split with persistent order and heights, a draggable seam, corridor-drag reorder, badge and Layout-section controls — shipped on main with unit, contract, and app-test coverage plus the tuglaws record, with stack mode byte-identical to today's behavior.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every (#success-criteria) item verified by its named mechanism.
- [ ] All eleven steps' checkpoints green; ledger fully `done` with commit hashes.
- [ ] tuglaws amendments landed ([D121] + pane-model.md + the new decision).
- [ ] Live window resize still runs zero geometry JS (structural: split pins are `calc()` over properties; the only observer remains the settled-resize retune).

**Acceptance tests:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0401-sidebar-split.test.ts`

#### Step 12: Distortion cap + real-geometry settle {#step-12}

**Depends on:** #step-11 (this revises what #step-4 shipped, after the whole feature was standing to look at)

**Commit:** `tugways(settle-real-geometry): a scale smears only under a cap; height crosses for real [D135][L06][L13]`

**References:** [P12] as revised, [D135]

**Why it exists:** #step-4's `scaleY` shipped and was judged on sight. The compositor animates a rasterized texture, so a scale is a screenshot smear — tolerable at the adjacent width step's 18.5%, deformation at a mode flip's ~100%.

**Artifacts:**
- `lib/pane-flip.ts`: `sy` removed; `MAX_FLIP_SCALE_DISTORTION` (0.2), `scaleDistortion` (symmetric in grow and shrink), `springSizeKeyframes` (real `width`/`height` on the same damped spring).
- `deck-canvas.tsx`: the Last pass runs up to three effects per frame under separate keys — translate transform, size, fade — because one non-transform property in the transform effect would revoke its acceleration whole. Rail mode flips fade every member but the z-frontmost, planned against the previous rail modes when the settle arms. `inlineRestorer` hands back what TugAnimator's completion commit displaced.
- `at0294`: over-cap width asserts translate-only transform + a real `width` tween with pinned endpoints.
- `at0278`: the Tab walk budget spans the Layouts section's new rail rows (a #step-9 regression this step's run surfaced).
- Doctrine: [D135] in `design-decisions.md`; the mode-flip motion paragraph in `pane-model.md`; [P12] rewritten as REVISED with #step-4 marked superseded.

**Verified:** `bun test` 6411 pass · `tsc --noEmit` clean · `bunx vite build` green · `just app-test-changed` 18/18 files, 38/38 tests.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Auto-split or split-by-default experiments (only if the shipped feature earns them — the brief's decisions log).
- [ ] Seam keyboard nudge / focus stop ([Q02], when the focus-nav subsystem reopens).
- [ ] A fourth sidebar card exercising the N-member generality for real.

| Checkpoint | Verification |
|------------|--------------|
| Pure math correct | `bun test src/lib/__tests__/layout-imposer.test.ts src/lib/__tests__/pane-flip.test.ts` |
| Settle carries height | a mode flip tweens the front member's REAL height and fades the rest; no scale term rides over the cap; everyday gestures keep byte-identical keyframes ([P12] as revised by [D135]) |
| Wire contract stable | serialization round-trip + defensive-read + legacy-blob unit tests |
| Real-app behavior | `just app-test tests/app-test/at0401-sidebar-split.test.ts` |
| Nothing regressed on the rails | `at0230`, `at0276`, `at0299`, `at0231` green |
| Production bundle intact | `cd tugdeck && bunx vite build` |
