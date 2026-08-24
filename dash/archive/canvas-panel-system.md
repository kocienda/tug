# Canvas Panel System

## Overview

Replace the current tiling/docking layout system with a free-form canvas where
panels float independently. Panels are resizable, repositionable, and layered
with a focus model. A future phase adds snap/set/guide behavior so panels can
join together into groups with shared-edge resizing.

## Core Principle: User-Controlled Sizing

Resizing is always under the control of the user. Panels never resize
automatically or as a side effect of another panel's movement. A panel
changes size only when the user explicitly drags one of its edges or
corners. This is a hard rule that applies everywhere:

- Opening a panel: appears at a default or saved size. Other panels don't move.
- Closing a panel: it disappears, leaving a gap. Other panels don't backfill.
- Moving a panel: other panels stay exactly where they are.
- Snapping: adjusts position to align edges, but never changes size.
- Shared-edge resize: the two panels sharing the edge resize together, but
  only because the user is dragging that specific shared edge.

The current tiling model violates this principle constantly — closing one
panel causes its neighbors to expand, sash drags redistribute space across
the whole tree, and tree normalization can rearrange weights unpredictably.
The canvas model eliminates all of that.

## Change A: Canvas Foundation

### Data Model

Replace `DockState` (tree + floating array) with a flat `CanvasState`:

```
CanvasState {
  panels: PanelState[]   // ordered by z-index (last = frontmost)
}

PanelState {
  id: string
  position: { x, y }
  size: { width, height }
  node: TabNode          // reuse TabNode for card identity
}
```

No `SplitNode`, no weights, no tree normalization. Z-order is implicit in array
position — last element renders on top.

No migration from old `DockState`. Clean slate. On startup, if localStorage
contains an old layout, discard it and build the default canvas layout.

### Default Layout

`buildDefaultLayout()` computes absolute positions from viewport size with
~12px gaps between panels:

```
+----------------------------------------------------------+
|  canvas background                                        |
|  +------------------------+  +------------+               |
|  |                        |  |  Terminal   |               |
|  |                        |  +------------+               |
|  |                        |               gap              |
|  |     Conversation       |  +------------+               |
|  |                        |  |    Git      |               |
|  |                        |  +------------+               |
|  |                        |               gap              |
|  |                        |  +------------+               |
|  |                        |  |   Files     |               |
|  |                        |  +------------+               |
|  |                        |               gap              |
|  |                        |  +------------+               |
|  |                        |  |   Stats     |               |
|  +------------------------+  +------------+               |
|                                                            |
+----------------------------------------------------------+
```

Each panel has its own border, shadow, and header bar. The canvas background
(`var(--background)`) is visible in the gaps and around the edges.

### Focus Model

- Clicking anywhere in a panel brings it to front (moves to end of `panels`
  array, assigns highest z-index).
- Focused panel gets a visual indicator: brighter border or accent color,
  slightly stronger shadow.
- All other panels use default border/shadow.

### Rendering

`PanelManager.render()` iterates `panels` and creates one `FloatingPanel` per
entry. The existing `FloatingPanel` class handles positioning, resize handles,
header bar, card mounting, and move drag.

Adjustments to `FloatingPanel`:
- Header drag moves the panel freely on the canvas (no "drag out to re-dock").
- Edge/corner resize works as it does now.
- Focus-on-click wired to the PanelManager focus model.

### What Gets Deleted

- `SplitNode` type and all tree rendering (`renderSplit`, `renderNode`,
  `renderTabNode`, `enforceGeometricMinimums`)
- `sash.ts` — no sash dividers in the canvas model
- `dock-target.ts` (`computeDropZone`, `DockOverlay`) — replaced by
  snap/guide logic in Change B
- `normalizeTree`, `insertNode`, `removeTab` tree mutations — replaced by
  simple array push/splice
- `TabBar` — not needed initially (each panel has one card)
- V2-to-V3 migration code in serialization

### What Gets Kept/Reused

- `FloatingPanel` — becomes the only panel renderer
- `CardHeader` — already used by FloatingPanel
- `TabNode`, `TabItem` types — kept for card identity
- Card registry, fan-out dispatch (D10), ResizeObserver plumbing
- Serialization (simplified for flat `CanvasState`)
- `TugCard` interface — cards are untouched; they don't know how they're
  positioned

### Serialization

New v4 format:

```
{
  version: 4,
  panels: [
    {
      id: string,
      position: { x, y },
      size: { width, height },
      tabs: [{ id, componentId, title }],
      activeTabId: string
    },
    ...
  ]
}
```

On load, if version is not 4, discard and build default. No migration.

### Implementation Steps (Change A)

1. New `CanvasState` / `PanelState` data model in `layout-tree.ts`
2. New `buildDefaultLayout()` returning `CanvasState` with computed positions
3. New `render()` loop — all panels as FloatingPanel instances
4. Focus model: z-ordering, visual indicator, click-to-front
5. Serialization: v4 format, load/save, discard-on-unknown-version
6. Remove dead code: split tree, sash, dock targeting, tab bar, normalization

---

## Change B: Snap, Sets, and Shared-Edge Resize

### Snap

During move or resize, detect when a panel edge is within a threshold (e.g.
8px) of another panel's edge. Snap the moving edge to align.

Snap types:
- **Edge-to-edge**: panel's right edge snaps to another panel's left edge
  (forming a shared boundary).
- **Edge-to-edge (aligned)**: panel's top edge aligns with another panel's
  top edge (co-linear alignment without touching).

Visual feedback: draw a guide line at the snap position while dragging.

### Sets (Shared-Edge Groups)

When two panels snap together with zero gap, they form a **set** — a runtime
grouping. The shared boundary is a virtual sash.

Key behavior: **dragging the shared edge resizes both panels**. If panel A's
right edge is snapped to panel B's left edge, dragging that boundary moves
A's right edge and B's left edge together, growing one and shrinking the
other. This is the same interaction as the current sash system, but it
emerges from proximity rather than tree structure.

Implementation approach:
- Detect shared edges: two panels share an edge when one panel's right
  equals another's left (or top/bottom), and there is vertical (or
  horizontal) overlap.
- On pointerdown over a shared edge, enter shared-edge resize mode:
  move both edges in tandem, enforce minimum sizes on both panels.
- Sets are runtime-only, not persisted. They're recomputed from panel
  positions after any move/resize.

### Guides

While dragging a panel, draw dashed lines at edges of other panels that
the moving panel could align to. These lines appear when the moving edge
is within the snap threshold.

### Set Dragging and Breaking

Whether a header drag moves the whole set or breaks the panel out depends
on which panel the user grabs:

- **Dragging the top-most panel** in a set moves the entire set as a unit.
  All member panels translate together, maintaining their relative positions.
- **Dragging any other panel** breaks it out of the set. That panel lifts
  free and moves independently. The remaining panels stay in place; the set
  is recomputed from the remaining panels' proximity.

"Top-most" means highest z-index (the focused panel). This is intuitive:
click a set's top panel and drag to reposition the group; click a lower
panel and drag to pull it out.

### Closing Panels in Sets

Closing a panel in a set leaves a gap — the hole where the panel was. No
other panels move or resize to fill it (per the core sizing principle).
After the close, sets are recomputed from the remaining panels' proximity.
If the gap splits what was one set into two disconnected groups, those
become two separate sets. If the closed panel was the only connection
between two parts of a set, those parts become independent.

### Implementation Steps (Change B)

1. Shared-edge detection: given panel positions, find all pairs that share
   a boundary with overlap
2. Shared-edge resize interaction: pointerdown on shared boundary starts
   dual-panel resize
3. Snap-during-move: detect proximity to other panel edges, snap position
4. Snap-during-resize: detect proximity during edge/corner resize
5. Guide lines: visual feedback during drag showing potential snap targets
6. Set dragging: top-most panel drag moves entire set; other panel drag
   breaks out
7. Set recomputation on close: recompute sets from proximity after any
   panel close
