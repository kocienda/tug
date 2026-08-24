# Sidebar Split — user-controlled vertical division of shared sidebar rails

This brief is the decided design for reintroducing vertical splitting of same-side sidebar cards. It is written to be sufficient on its own for a `/devise` plan in a fresh session. File and symbol references were confirmed against the tree as of 2026-08-11 (line numbers are approximate anchors, not contracts).

## Why this exists — two lived verdicts

An automatic vertical split was tried during the sidebar generalization and rejected: `layout-imposer.ts:1064` records "A shared rail is a stack, not a split... Dividing the run between them instead was tried first and was a worse Lens." The stack shipped instead: same-side sidebar cards get byte-identical frames, stand front-to-back in z, and the hidden ones are reached through the title-bar stack badge picker.

The user has now lived on the stack and found *it* wanting too. The synthesis: the first attempt failed because splitting was **automatic and mandatory** — opening Jots forcibly halved the Lens. The stack fails because **occlusion hides content the user wants visible at once**. What both verdicts point at is a split the *user chooses*, per side, with the stack remaining the default. That is this feature.

## Summary

1. A shared rail (2+ sidebar cards on one side) can be in one of two per-side modes: **stack** (today's behavior, unchanged, still the default) or **split** (the rail's vertical run divided among all members, every member visible).
2. New per-side state on the imposition record: mode, top-to-bottom member order, and per-member height shares. All additive to the v4 blob; mode survives a side dropping to one card and re-applies when a second returns.
3. Three control surfaces: the **stack badge menu** gains Split/Stack verbs; the **Layout section** gains a per-shared-side Stack | Split control with miniature previews; a **draggable seam** between split members adjusts heights, double-click equalizes.
4. **Corridor drag**: a title-bar drag on a split member reorders it within the rail (live FLIP shuffle) while the pointer stays in the rail's corridor; leaving the corridor converts to the existing free drag and unpins. First-class from the start — this gesture is the feature's soul.
5. Splits generalize to N members (three sidebar cards exist today; a fourth registers for free).

## Part A — Model

### A1. The imposition record

`DeckImposition` (`tugdeck/src/lib/layout-imposer.ts:152`) grows one additive field:

```ts
interface DeckImposition {
  kind?: ImpositionKind;
  contentWidth?: ContentWidth;
  sidebars: Record<string, SidebarEntry>;   // unchanged
  rails?: {
    left?: RailArrangement;
    right?: RailArrangement;
  };
}

interface RailArrangement {
  mode?: "stack" | "split";                 // absent = stack
  order?: string[];                          // componentIds, top-to-bottom; absent = registration order
  shares?: Record<string, number>;           // height weight per componentId; absent member = 1
}
```

Decisions baked into this shape:

- **Split is a property of the side, not of a card.** No pairwise sub-groups, no mixed stack-within-split. A side is a stack or a split; all visible members participate.
- **`shares` is a per-componentId weight record, not a fractions array.** Membership churns (cards hide, unpin, change sides); weights keyed by componentId renormalize over whoever is present with no index misalignment. Default weight 1 → equal division.
- **Everything survives churn.** Close Jots and the Lens takes the full run; reopen it and mode/order/shares re-apply. This mirrors how `sidebars` entries already persist for hidden cards. A side at one visible member renders identically in both modes.
- **Membership itself is untouched.** `sidebars[componentId].side`, the Left/Right controls, `set-sidebar-side`, drag-to-unpin, the one-width-per-side rule, and the width allocator (`allocateSidebarWidths`, `layout-imposer.ts:872`) all carry over verbatim. Split adds a vertical dimension to a rail that already exists; it never touches width.

### A2. Order becomes real state

`sidebarStackOrder()` (`layout-imposer.ts:233`) currently returns registration order and its docstring says there is deliberately no vertical order to record. That statement becomes false: on a split rail, top-to-bottom order is user-owned state (`rails[side].order`). Stack mode continues to need no stored order (front/back remains deck z-order). The function generalizes to resolve the effective order — `order` filtered to present members, absentees appended in registration order — and the docstring is rewritten.

## Part B — Geometry

### B1. Vertical terms in the imposed style

`imposeSidebarStyle(side, paneWidth)` (`layout-imposer.ts:1074`) today emits a full-run pin: `top: 5px`, `bottom: 32px` (the run = canvas minus `IMPOSITION_GAP_PX` at the top and the 32px dev-stamp clearance at the bottom). For a split member it emits vertical calc terms over per-side seam custom properties, so the load-bearing invariant holds: **live window resize runs no JS** — member heights are fractions of the run and re-resolve in the browser's reflow, exactly like the horizontal insets.

- New custom properties, written by the same `deck-canvas.tsx` layout effect that writes `--tug-sidebar-width-left/right` (`deck-canvas.tsx:1132-1147`): per side, one cumulative-fraction property per seam, e.g. `--tug-rail-right-seam-0`, `--tug-rail-right-seam-1` (registered `<number>` 0..1, like `--tugx-lens-rail`). Member *i* of *N* pins `top` at seam *i−1* (or the run top) and `bottom` at seam *i* (or the run bottom), each `calc()` over `100%` of the canvas with the run insets.
- Vertical gap between members: `IMPOSITION_GAP_PX` (5px), split evenly across a seam (member above ends 2.5px above the seam line, member below starts 2.5px under it).
- The signature stays `(side, paneWidth)` plus a new placement argument carrying `{ index, count, seams }` (exact shape at implementation); stack mode passes the full-run placement and emits today's style byte-for-byte.

### B2. Minimums and squeeze

Seam drags clamp in JS at gesture time to each adjacent member's `sizePolicy.min.height` (Lens min is 240). Window shrink is CSS-only, so fractions squeeze all members proportionally — a member may render below its minimum on a genuinely short window rather than clipping a sibling. No refusal states, no modes: a split is always allowed, and pathological windows degrade proportionally.

### B3. Z-order and reachability

Split members do not occlude, so z-order among them stops mattering (it remains harmless). `activateCard` still raises and transfers focus; on a split rail, activation reads as focus rather than reveal. The `Window ▸ Next/Previous Card in Stack` pair (⌥⌘] / ⌥⌘[) keeps working with zero code change — cycling activates the next member, which on a split rail moves focus instead of flipping visibility.

## Part C — Controls

### C1. The stack badge is the gateway

The badge (`tug-pane.tsx:670-730`, `slotStack.length > 1`, `TugPopupMenu` trigger with the lucide `Layers` glyph + count) is already the one place a shared rail announces itself. Changes:

- **Stack mode**: the member rows stay as they are (picker, topmost check-marked, select → reveal). One new item below them: **"Split Vertically"** (lucide `Rows2`/`Rows3` per count) → `set-rail-mode { side, mode: "split" }`.
- **Split mode**: the badge glyph swaps `Layers` → `Rows2` (count stays; the badge now announces "this rail is divided N ways"). Menu: member rows select → activate (focus) that member; **"Stack"** to collapse back; **"Equalize Heights"** resets shares to equal.
- The stack data source (`slotStackByPaneId`, `deck-canvas.tsx:410-466`, keyed `rail:${side}`) already gives every rail member the same stack; it only needs the rail's mode threaded through so the badge renders the right glyph and menu. `SlotStackEntry` (`deck-store-selectors.ts:153`) is the type to extend.
- Cmd-click on the title bar and ⌘R (`revealStack()`) keep opening the same menu in both modes.

### C2. The Layout section states the arrangement

`layouts-section.tsx` gains, below the existing per-sidebar Left/Right rows, **one row per shared side**, rendered only when 2+ visible sidebar cards share that side: caption `LEFT RAIL` / `RIGHT RAIL`, a `TugChoiceGroup` with `Stack | Split` → `set-rail-mode`. Same responder/dispatch idiom as the existing controls (`SIDE_SENDER_PREFIX` pattern, `layouts-section.tsx:294-321`).

`LayoutMiniature` (`layout-miniature.tsx`) learns to draw a horizontally-divided rail (its `Rail` member already draws stacked "paper" offsets for a stack; a split draws stacked segments within the rail's box instead). The section's preview-layer system (`layers` array, `layouts-section.tsx:387-420`) gains `rail:<side>:<mode>` layers, so hover/keyboard preview shows the split before committing — the existing machinery, one new layer id family.

### C3. The seam

A thin grab strip in the gap between adjacent split members, rendered by `deck-canvas` in the canvas overlay tier, positioned by the same seam custom properties as the frames (so it cannot drift from them). One seam element per gap per split rail.

- **Drag** rewrites the seam's custom property per frame and commits shares on release — the rail-edge-drag pattern (`handleSidebarResizeStart`) verbatim: live property writes, one reflow per frame, JS clamping to member minimums, state commit at the end.
- **Double-click** equalizes the two adjacent members (menu "Equalize Heights" equalizes all).
- Visual: hairline/invisible at rest with a hover affordance; hit slop wider than the 5px visual gap (~9-11px). Cursor `row-resize`. Borrow `TugSplitPane`'s interaction contract (hit slop, cursor, keyboard nudge if cheap) but not the component — it assumes a shared flex parent; pane frames are independent absolutely-positioned siblings.

### C4. Corridor drag — reorder within the rail

On a split member, a title-bar drag enters the **rail corridor**:

- While the pointer stays within the rail's horizontal band (rail rect ± a tolerance on the order of 80px — tune at implementation), the gesture is a **reorder**: the dragged frame follows the pointer vertically (transform translate, no re-render), siblings FLIP-shuffle live to open the drop position, release commits `order` (and the frames settle via the standard mechanism).
- The moment the pointer leaves the corridor, the gesture **converts one-way** to the existing free drag: `releaseImposedFrame` (`tug-pane.tsx:1058`), unpin, today's semantics exactly. No gesture is lost — drag-away-to-unpin still works from a split rail; drag-within-to-reorder is the new meaning of the vertical axis.
- Builds on parts that exist: the three-phase drag machine (`handleDragStart`, `tug-pane.tsx:1959`, threshold `DRAG_MOVE_THRESHOLD_PX`, rAF frame application, pointer capture), FLIP tween math (`lib/pane-flip.ts`), and the live-shuffle idiom of `useBlockReorder` (`lens/block-reorder.ts:181` — the idiom, not the hook; it drives DOM lists, not absolutely-positioned pane frames).
- Cmd-drag (move without raising) and the no-travel Cmd-click (stack picker) keep their meanings.
- On a **stack-mode** rail nothing changes: title-bar drag unpins immediately past the threshold, as today.

This gesture is first-class scope, not a follow-on. Getting it right is the feature.

## Part D — Actions, manager surface, animation

- New actions (registry routing with payloads, the `set-sidebar-side` shape): `set-rail-mode { side, mode }`, `equalize-rail { side }`. Reorder and seam commits go through DeckManager methods rather than public actions (they are gesture commits): `setRailMode(side, mode)`, `setRailOrder(side, order)`, `setRailShares(side, shares)` — each funneling through `_reimpose`/`_commitImposition` (`deck-manager.ts`) so notify + debounced save ride the existing choreography. No default chords ([L30]-clean).
- **Settle animation**: rail mode and order join `arrangementSignature` (`deck-canvas.tsx:196-235`), so mode flips and menu-driven reorders animate through the existing FLIP settle (`pane-flip.ts`, `IMPOSITION_SETTLE_MS`, compositor-friendly transform-only keyframes) with no new animation code. Shares also join the signature; a seam-drag commit then arms a settle whose First and Last rects are identical (the DOM already sits at the final geometry from the live property writes) — a zero-delta no-op, the same way rail-width edge drags already coexist with the signature.

## Part E — Persistence

- `rails` serializes inside the imposition record in the v4 blob (`serialization.ts:142-152` write, `:355-400` read) — additive-optional, no version bump (the `slot?`/`widthPreset?`/`contentWidth?` precedent). Old blobs parse to stacks everywhere.
- Defensive reads: unknown `mode` → drop the arrangement; `order` filtered to registered sidebar componentIds; non-finite or non-positive `shares` values dropped per-key; an empty surviving record → absent.
- Mode/order/shares persist through membership churn by construction (keyed per side / per componentId, tolerant of absentees).

## Part F — Doctrine (tuglaws)

- **pane-model.md**: the pinned-mode row ("cards sharing a side stack front-to-back and the stack badge picker is the only way to reach the covered one") is amended: a shared rail is a **stack by default; the user may split it**. The split's geometry (per-side seam properties, run division) joins the three-modes table's pinned row. The Files table adds the seam element's home.
- **[D121]** amended with the rail-arrangement state; **[D123]/[D129]** (stack badge / depth ring) amended for the split-mode badge behavior.
- New design decision recording the two lived verdicts (auto-split rejected as "a worse Lens"; occlusion stack rejected after living on it) and the synthesis: splitting must be chosen, never imposed.
- The `layout-imposer.ts:1064` doc comment is rewritten to the new truth — it currently states the stack is the design's endpoint, and this feature makes that false.

## Part G — Test impact

- **Unit**: `layout-imposer.test.ts:564-592` pins "two members on one side are geometrically identical / the style carries no vertical term" — scope those describes to stack mode and add the split twins (division sums to the run, gap split across seams, shares renormalize over present members, min-clamp math). Serialization round-trip + defensive-read cases for `rails`.
- **App-tests** (selective, `@covers`, next free `at` numbers): a new sidebar-split test — seed Lens+Jots on the right, split via the badge menu, assert non-overlapping member rects that tile the run; drag the seam and assert the property + persisted shares; corridor-drag reorder and assert the order flip; drag out of the corridor and assert unpin; re-stack and assert today's identical-frames behavior returns. Existing rail suite re-verified: `at0230-pinned-lens-geometry`, `at0276-lens-side-persists`, `at0299-lens-edge-drag`, `at0231-lens-toggle-focus`.
- Corridor-drag pointer choreography that the harness cannot express (mid-drag corridor exit) gets covered at whatever layer can drive it honestly — decide in the plan, never fake it.

## Decisions log (all final)

- Stack remains the default on a second same-side card; auto-split is out. Revisit only as follow-on work if the shipped feature earns it.
- Corridor drag ships first-class in the initial implementation — it is the feature's soul, not a follow-on.
- Splits generalize to N members; no cap at 2.
- Mode/order/shares survive a side dropping to one visible member and re-apply on return.
- Split is per-side; no pairwise sub-groups, no stack-within-split, no horizontal sub-splits, no splitting of content-card slot stacks.
- Shares are per-componentId weights (default 1), never index-positional fractions.
- The imposer still never touches width; one rail width per side; the allocator is untouched.
- Seam drags are live CSS-property writes with JS min-clamping and a commit on release; window resize stays JS-free.
