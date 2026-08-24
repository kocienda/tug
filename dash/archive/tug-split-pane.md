# tug-split-pane

*A flexible split-pane layout primitive that divides a region into two or more resizable children, separated by draggable sashes that can snap closed and reopen.*

Motivation: in T3.4 we will place `tug-prompt-entry` at the bottom of the Tide card and `tug-markdown-view` above it. We need a reusable, meticulously-crafted split surface before that work — not a one-off layout in the Tide card. `tug-split-pane` becomes a general tugways layout primitive that any card composition can use.

---

## Goals

- **Horizontal or vertical splits.** A split is named by the orientation of its *dividing line*: `horizontal` = a horizontal sash dividing top/bottom panes, `vertical` = a vertical sash dividing left/right panes. This matches macOS / VS Code terminology and the user's mental model ("horizontally-split card with a markdown view on top").
- **N-way panes.** Two is the common case but the API supports arbitrary `n ≥ 2`. Nested split panes yield arbitrary 2D layouts.
- **Resizable sashes.** Drag to resize. Keyboard accessible (arrow keys when sash is focused). ARIA `separator` role.
- **Per-pane size constraints.** Each pane declares `minSize` and optional `maxSize`, in pixels or percentage. The group enforces them during drag and on container resize.
- **Snap-to-close.** When a pane is dragged below a snap threshold, it collapses to `collapsedSize` (usually 0). Reopening is via drag or imperative API.
- **Stylable sash.** The sash is a tokened element that accepts a width (thickness), color, and optional icon (grip indicator). Hover / active / focus states are CSS tokens.
- **Persistent layouts.** Optional `storageKey` saves the split ratio across reloads.
- **Panels are invisible slots.** Each `TugSplitPanel` is a sized rectangular region with zero visual chrome of its own — no border, no background fill, no padding, no label, no header. Whatever content the caller puts inside a panel sits directly on the surface behind it, and *that content is what identifies the panel* (a markdown view looks like a markdown view; a prompt entry looks like a prompt entry). Do not wrap panel content in a TugBox "for framing" — the TugBox's legend-in-border chrome looks terrible in split panes and adds visual noise that competes with the content. A panel may of course *contain* a TugBox when the consumer specifically wants fieldset grouping, but that's the consumer's decision, never the default. The typical shape is `<TugSplitPanel><YourContentComponent /></TugSplitPanel>` — nothing between them.
- **Host-agnostic.** `TugSplitPane` has zero knowledge of any particular mount site — not the Component Gallery, not the Tide card, not a settings sheet, not any other host. Its contract is the standard flexbox one: *my parent must have a concrete height (or width, for a vertical split); I fill it.* Any host-specific layout plumbing (padding overrides, scroll containers, grid cell chrome) lives at the mount site, never inside the component. This is the principle that keeps the component reusable: the day a new consumer shows up, nothing in `tug-split-pane.tsx` needs to change.

Non-goals: animation choreography during snap (we use plain CSS transitions), multi-touch, drag-to-reorder panes. **Also a non-goal: the Component Gallery as a design constraint.** The gallery is a test harness for iterating on the component visually under HMR. It is not a target environment. If the gallery's default card chrome (`.cg-content` padding, gap, scroll) needs to be overridden to host a fullsize demo, those overrides are a property of the demo card file (`cards/gallery-split-pane.tsx`), not a property of `TugSplitPane`. The component must never import gallery class names, never branch on whether a gallery host is present, never carry a "if this is the gallery, do X" path. When the gallery goes away — and eventually it will, the Tide/Tugdeck product surfaces do not include a component gallery — nothing in the component should need to change.

---

## Research

**Radix UI — not applicable.** Radix has no split-pane or resizable primitive. Their focus is controls and dialogs, not layout. Confirmed against the Radix Primitives catalogue (`@radix-ui/react-accordion`, `-slider`, `-popover`, etc.; no `-split-pane`, `-panels`, or `-resizable`).

**Candidate 1 — `react-resizable-panels`** (Brian Vaughn / bvaughn). License: MIT. Active, ~5.2k stars, 160+ releases.
- Horizontal + vertical, nestable, keyboard-accessible separator (WAI-ARIA).
- Collapsible panels with `collapsible`, `collapsedSize`, and `onCollapse` callbacks — our "snap to close" requirement maps directly.
- Min / max / default sizes as percentages.
- Persistent layout via `autoSaveId` + local storage.
- Styling: class names and `data-*` attributes on the separator; the consumer supplies all visuals. A minor caveat — the library enforces `flex-grow`/`flex-shrink` on panels; thickness of the sash is free but panel size during drag is driven via inline style on flex items.
- Used by shadcn/ui's "Resizable" component, which is the closest analog in the React ecosystem to how tugways wraps Radix. Pattern-compatible: renderless-ish primitives + consumer styling.

**Candidate 2 — `allotment`** (John Walley). License: MIT. Active, derived from VS Code's split-view.
- Horizontal + vertical, nestable, keyboard accessible.
- Built-in "snap to zero" threshold + double-click sash to reset to preferred sizes.
- Ref-based imperative API (`.reset()`, `.resize()`).
- CSS variables for theming sash color / focus ring.
- Closer to the VS Code "industry standard" look. More opinionated about visual chrome, which is both a pro (great defaults) and con (harder to re-skin into tugways tokens).

**Candidate 3 — `react-split-pane` / `react-split` / `@devbookhq/splitter`.** Older, less maintained, or wrap non-React libraries. Not recommended.

**Candidate 4 — hand-rolled.** The resize math is not hard: constrained 1D layout with min/max clamping and optional snapping. What *is* hard, and what these libraries already solve, is the long tail:
- WAI-ARIA `separator` semantics and keyboard navigation
- Pointer capture across the viewport (drags that leave the target)
- Touch + mouse + pen unification
- `ResizeObserver` integration for container-size changes
- Persistent layouts + responsive reflow
- Edge cases around zero-size panels and conditional visibility

Rolling our own means re-solving these. Given we are already comfortable wrapping Radix primitives with tugways chrome, the same pattern applies here.

**Recommendation: wrap `react-resizable-panels`.** It is MIT, actively maintained, pattern-compatible with our Radix-wrapping conventions, and exposes primitives that map cleanly onto the props we want. Allotment is a reasonable fallback if its VS Code ergonomics (double-click reset, built-in snap threshold) turn out to matter more than class-based styling freedom — but our experience wrapping Radix slider, tooltip, popover, etc. with fully-tokened CSS strongly favors the Vaughn library.

### L06 note

`react-resizable-panels` drives panel sizes via inline `flex-grow`/`flex-shrink` on the panel elements and tracks layout in React state. During a drag, this causes React re-renders at pointer-event cadence. This is the same tradeoff as `@radix-ui/react-slider` (which we already wrap) — the intermediate values are technically appearance-only, but the upstream library routes them through React. We accept this tradeoff because:
1. The re-renders are narrow (the panel group and direct children only, not the content subtrees — children are memoized via `React.memo` where appropriate).
2. The committed layout *is* data (it persists, it's queryable, it drives which pane is collapsed), so having it in React is correct per L06's test.
3. The during-drag preview is visually indistinguishable from a pure CSS approach at 60fps on our hardware targets.

If profiling reveals drag-time jank inside heavy panes (a very large `tug-markdown-view`, for instance), the mitigation is to put the content in its own memoized boundary — not to rip out the library.

---

## Terminology

We deliberately name orientation by the *dividing line*, not the arrangement of panes. Both terms are used in the wild and each is someone's "wrong", so we pick one and stick to it:

| Prop value    | Dividing line | Pane arrangement |
|---------------|---------------|------------------|
| `horizontal`  | Horizontal    | Stacked (top / bottom) |
| `vertical`    | Vertical      | Side by side (left / right) |

This matches NSSplitView's semantics (`NSSplitViewDividerStyle` + `isVertical`: a vertical divider yields side-by-side panes) and VS Code's split terminology. The JSDoc on the `orientation` prop spells this out explicitly with a diagram so there is no confusion.

---

## Use case: Tide card

```
┌─────────────────────────────────────────┐
│  Tide                              [x]  │  ← card title bar
├─────────────────────────────────────────┤
│                                         │
│  tug-markdown-view                      │  ← pane 1
│  (scrolled content, history, etc.)      │
│                                         │
├──────── ═════ ─────────────────────────┤  ← horizontal sash (grip)
│                                         │
│  tug-prompt-entry                       │  ← pane 2
│                                         │
└─────────────────────────────────────────┘
```

Behavior:
- Default split: 70/30 (top is larger).
- Minimum for the prompt-entry pane: enough to show one line of input + route indicator + submit button (≈ 80px depending on size).
- Maximum for the prompt-entry pane: ~50% (user can still see recent history).
- Minimum for the markdown-view pane: enough to show ~3 lines of content.
- No snap-to-close in this specific layout — both panes are always needed. Snap-to-close is available for other cards that want it (e.g., an inspector that collapses).

---

## Props

```typescript
export type TugSplitPaneOrientation = "horizontal" | "vertical";

/** Size specification: a number is pixels; a string ending in "%" is percent. */
export type TugSplitSize = number | `${number}%`;

/**
 * Per-pane configuration. One element per child <TugSplitPanel>.
 */
export interface TugSplitPanelProps extends React.ComponentPropsWithoutRef<"div"> {
  /** Stable id. Required when using storageKey or imperative API. */
  id?: string;
  /** Initial size. Default: equal division. */
  defaultSize?: TugSplitSize;
  /** Controlled size. Use with onSizeChange. */
  size?: TugSplitSize;
  /** Callback after the user finishes dragging. Not called mid-drag. */
  onSizeCommit?: (size: number) => void;
  /** Minimum size. Enforced during drag and on container resize. */
  minSize?: TugSplitSize;
  /** Maximum size. Optional. */
  maxSize?: TugSplitSize;
  /** Panel can be collapsed by dragging past the snap threshold. Default: false. */
  collapsible?: boolean;
  /** Size when collapsed. Default: 0. */
  collapsedSize?: TugSplitSize;
  /** Drag distance past minSize before snap-to-collapse fires, in px. Default: 20. */
  snapThreshold?: number;
  /** Fires when collapsed state toggles. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Disables drag-to-resize for this panel's leading sash. */
  resizable?: boolean;
  children?: React.ReactNode;
}

/**
 * The sash (divider) between two adjoining panes.
 * In the DOM, exactly one sash lives between every pair of adjoining panels.
 * Authors do not mount these directly — they are rendered by TugSplitPane.
 * Authors customize via the sash prop on TugSplitPane.
 */
export interface TugSplitSashConfig {
  /**
   * Thickness in px. Applied to the sash's cross-axis dimension.
   * @default 6
   */
  thickness?: number;
  /**
   * Whether to render a grip icon in the sash. The icon is a tugways icon name
   * or a React node. When omitted, no icon is rendered (plain color bar).
   */
  icon?: React.ReactNode | TugIconName;
  /**
   * Size of the interactive hit area along the drag axis, in px.
   * Can be larger than the visible thickness (common pattern: a 1-2px visible
   * line with an 8-10px invisible hit area).
   * @default max(thickness, 8)
   */
  hitArea?: number;
}

export interface TugSplitPaneProps extends React.ComponentPropsWithoutRef<"div"> {
  /**
   * Orientation of the dividing line(s).
   * - "horizontal": horizontal sash(es), panels stacked top to bottom.
   * - "vertical":   vertical sash(es),   panels side by side.
   * @selector .tug-split-pane-horizontal | .tug-split-pane-vertical
   * @default "horizontal"
   */
  orientation?: TugSplitPaneOrientation;
  /**
   * Sash visual configuration. A single config applies to every sash in this group.
   * For per-sash customization, compose nested TugSplitPanes.
   */
  sash?: TugSplitSashConfig;
  /**
   * Persist the layout under this key in localStorage. Optional.
   * When present, every TugSplitPanel should have a stable id.
   */
  storageKey?: string;
  /**
   * Size variant — controls default sash thickness and grip icon size.
   * @selector .tug-split-pane-sm | .tug-split-pane-md | .tug-split-pane-lg
   * @default "md"
   */
  size?: "sm" | "md" | "lg";
  /** Children must be TugSplitPanel elements. */
  children: React.ReactNode;
}
```

### Why two components (`TugSplitPane` + `TugSplitPanel`)

Because size constraints are *per pane*. Putting them on the parent would require parallel-array props (`minSizes={[100, 50]}`), which is brittle. The `react-resizable-panels` API uses the same pattern (Group + Panel + Separator), and it is the clearest way to express "this specific child has these constraints." The sash is not a separate JSX element that authors mount — `TugSplitPane` renders one between each adjacent pair of panels automatically. Authors customize sash appearance once via the `sash` prop.

### Why the sash config is on the parent, not the panel

A sash lives *between* two panels, so it does not belong to either of them. Putting sash configuration on a panel would make it ambiguous ("leading? trailing?") and would force authors to duplicate styling on every panel. The parent-level `sash` config is the natural place for this.

---

## Snap behavior

1. User drags the sash toward a panel that is `collapsible: true`.
2. As the panel's size approaches its `minSize`, drag continues to shrink it normally.
3. Once the pointer has traveled `snapThreshold` pixels past `minSize`, the panel snaps to `collapsedSize` (typically 0) and `onCollapsedChange(true)` fires.
4. On the return drag, the panel reopens from `collapsedSize` directly to `minSize` once the pointer has traveled `snapThreshold` pixels *back* from the collapsed edge. This matches macOS / VS Code split behavior.
5. Programmatic expand/collapse is available via ref (`.collapsePanel(id)`, `.expandPanel(id)`).

Collapsed panels remain mounted (`display: none` is *not* used) so that their internal state is preserved. We toggle a `data-collapsed` attribute and drive the visual collapse with CSS: `.tug-split-panel[data-collapsed="true"] { flex: 0 0 0 !important; overflow: hidden; }`.

---

## Sash design

```
Horizontal sash (panes stacked top/bottom):
 ────────────────────────────────────
              ╺━━━╸               ← optional grip icon, centered
 ────────────────────────────────────

Vertical sash (panes side by side):
 │   │
 │ ╻ │
 │ ┃ │  ← optional grip icon, centered
 │ ╹ │
 │   │
```

- **Visible thickness** is token-driven (`--tug7-split-sash-thickness`) with sensible defaults per size variant.
- **Hit area** is wider than the visible thickness using negative margin / `::before` absolute positioning. Pattern: a 2px visible bar with a 10px hit area feels premium.
- **Grip icon** is optional. Defaults to `grip-horizontal` / `grip-vertical` from Lucide when `sash.icon` is not passed. Color and size inherit from tokens.
- **States** (CSS only, no React state): rest, hover, active (dragging), focus-visible (keyboard).
- **Cursor**: `ns-resize` for horizontal sashes, `ew-resize` for vertical sashes. Applied during hover and forced on `<body>` during drag (the underlying library handles the body-cursor escalation).
- **ARIA**: `role="separator"`, `aria-orientation`, `aria-valuenow`, `aria-valuemin`, `aria-valuemax` (provided by the underlying library). Focusable with Tab; Arrow keys move it by a fixed step (default 10px), Home/End move to min/max, Enter toggles collapse on collapsible panels.

---

## Files

```
tugdeck/src/components/tugways/tug-split-pane.tsx
tugdeck/src/components/tugways/tug-split-pane.css
tugdeck/src/components/tugways/cards/gallery-split-pane.tsx
```

Plus the dependency: `bun add react-resizable-panels`.

---

## TSX structure

- CSS import first
- `forwardRef` on `TugSplitPane` root; returned ref exposes imperative methods (`collapsePanel`, `expandPanel`, `getLayout`, `setLayout`) by forwarding to the underlying `PanelGroup` ref
- `data-slot="tug-split-pane"` on the root, `data-slot="tug-split-panel"` on each panel, `data-slot="tug-split-sash"` on each sash
- `cn()` for class composition
- Spread `...rest` on the root
- Wraps `react-resizable-panels`' `PanelGroup`, `Panel`, `PanelResizeHandle`
- `TugSplitPanel` is a thin wrapper around `Panel` that also carries the tugways `TugSplitPanelProps` interface and forwards the size/constraint props
- Sash is rendered internally by `TugSplitPane` by interleaving `<PanelResizeHandle>` elements between consecutive `<TugSplitPanel>` children, reading the `sash` prop for styling. Children are validated at dev time (must all be `TugSplitPanel`, no arbitrary elements).

### Renderless sash? No — single-node sash with CSS

The sash is rendered by `TugSplitPane`, not the consumer. Consumers customize via the `sash` prop, which flows into CSS variables on the group. This keeps the API small: one prop tree, one set of tokens, no need to drill `sash={…}` into every panel.

---

## CSS structure

- `@tug-pairings` block (compact + expanded)
- Body-scoped aliases: `--tugx-split-pane-*` resolving to `--tug7-*` in one hop
- `.tug-split-pane` — root flex container; flex-direction driven by `data-orientation`
- `.tug-split-pane-horizontal` / `.tug-split-pane-vertical` — orientation modifiers
- `.tug-split-panel` — each pane; `flex: <size>` driven by inline style from the library
- `.tug-split-panel[data-collapsed="true"]` — collapsed state
- `.tug-split-sash` — draggable divider; cross-axis size = thickness, main-axis size = 100%
- `.tug-split-sash-grip` — optional centered icon
- `.tug-split-sash[data-state="hover"]`, `[data-state="active"]`, `[data-focus-visible]` — states (library provides data attrs where possible)
- Size variants: `.tug-split-pane-sm`, `.tug-split-pane-md`, `.tug-split-pane-lg`

---

## Token design

Seven-slot `--tug7-split-*` tokens following the token naming convention. Initial set:

| Token                                    | Purpose |
|------------------------------------------|---------|
| `--tug7-split-sash-bg-normal-rest`       | sash fill, resting |
| `--tug7-split-sash-bg-normal-hover`      | sash fill, hover |
| `--tug7-split-sash-bg-normal-active`     | sash fill, dragging |
| `--tug7-split-sash-fg-normal-rest`       | grip icon color, resting |
| `--tug7-split-sash-fg-normal-hover`      | grip icon color, hover |
| `--tug7-split-sash-ring-focus`           | keyboard focus ring |
| `--tug7-split-sash-thickness-sm/md/lg`   | visible sash thickness per size |
| `--tug7-split-sash-hit-area-sm/md/lg`    | interactive hit area per size |
| `--tug7-split-sash-grip-size-sm/md/lg`   | grip icon size per size |
| `--tug7-split-pane-gap`                  | optional gap inside the hit area for a "snap gap" look |

Pair with both `brio.css` and `harmony.css`. Document the pairings in the module docstring and CSS header.

Per [L20] token sovereignty, `tug-split-pane` does not restyle its children. Panes are opaque regions — whatever lives inside (typically a TugBox) owns its own tokens.

---

## Gallery demo card

`cards/gallery-split-pane.tsx` is an interactive demo we use to iterate on the component visually under HMR. It is a **test harness**, not a target environment: none of the behavior it exercises is gallery-specific, and any layout plumbing the demo card needs to integrate with the gallery's `.cg-content` wrapper (padding/gap/scroll overrides) lives in this file only — `tug-split-pane.tsx` itself never references `.cg-content`, never imports gallery styles, never knows the gallery exists. See the Host-agnostic goal above.

The demo shows:

- Horizontal split (the Tide use case): markdown above, prompt below
- Vertical split: a 2-pane side-by-side layout
- 3-pane split with a collapsible center pane (click a button to collapse/expand)
- Nested split: vertical outer with a horizontal inner pane on the right
- Sash variants: thin + no icon, thick + grip icon, color overrides via inline tokens
- Size variants: sm / md / lg
- Snap-to-close demo: drag the prompt pane below its minimum, watch it collapse; drag back to reopen
- Persistent layout demo: reload the page, layout is restored
- Disabled pane (non-resizable sash)
- Live readout of current layout ratio (demonstrates `onSizeCommit` callback)

Each sub-demo has a short caption explaining what it shows.

The Tide card integration for T3.4 does **not** look at this gallery file as a reference. When T3.4 mounts `TugSplitPane` in the Tide card, the API is the same, the props are the same, and any layout plumbing the Tide card needs is the Tide card's own business — it won't resemble the gallery's plumbing and it shouldn't have to. The gallery demo is for us, during development; the Tide card is for the product.

---

## Checkpoints

- `bun add react-resizable-panels` and verify MIT license in the resolved package
- `bun run build` exits 0
- `bun run test` exits 0
- `bun run audit:tokens lint` exits 0
- Drag resize works in both orientations
- Keyboard: Tab to sash, arrow keys resize, Enter toggles collapse on collapsible panels
- Min/max sizes enforced during drag and on container resize
- Snap-to-close fires after `snapThreshold` px past min; reopens symmetrically
- Collapsed pane preserves internal state (test: type into an input in the collapsed pane, expand, still there)
- Persistent layout: set a layout, reload, layout is restored when `storageKey` is set
- Imperative ref API: `.collapsePanel()`, `.expandPanel()`, `.getLayout()`, `.setLayout()` all work
- `onSizeCommit` fires on pointer-up, not during drag
- `onCollapsedChange` fires when snap toggles
- ARIA: `role="separator"` + `aria-orientation` + `aria-valuenow` present on every sash
- Nested split panes render and resize independently
- Sash `icon`, `thickness`, `hitArea` props all visibly affect the result
- Conforms to the component authoring guide checklist ([L19])
- All tokens follow the seven-slot `--tug7-split-*` convention ([L20])
- Pairings declared in both `brio.css` and `harmony.css` ([L16])

---

## Implementation plan

We are deliberately *not* using the `tugplug:plan` workflow for this component. That workflow has been producing too much boilerplate, too much ceremony, and too little introspection on the work in between — which is exactly wrong for a user interface component where every step should be something you can look at and touch.

Instead: small visible chunks under HMR. After each chunk we stop, look at it in the browser, discuss what's off, and move on. No sub-agents, no committer-agent, no big nugget of work at the end. The user commits when satisfied with a chunk (or a cluster of chunks).

**The discipline:** never write a chunk that can't be verified until the next chunk lands. If a step produces nothing visible, it is too big or it is in the wrong order.

### Steps

1. **Dependency + smoke test.** `bun add react-resizable-panels`, verify MIT license in the resolved package, verify the React 19.2 peer range, mount a raw `PanelGroup` in a throwaway gallery card to prove it renders at all.
2. **Minimal `TugSplitPane` + `TugSplitPanel`.** Unstyled, horizontal only, two-pane only, no sash chrome beyond a 1px line. Works in HMR.
3. **Gallery demo card scaffold** with a horizontal 2-pane demo showing plain placeholder content (muted labels naming the eventual Tide slots: "markdown view (T1)" on top, "prompt entry (T3.4)" on bottom). **No TugBox wrappers, no visual chrome** — panels are invisible slots per the Panels are invisible slots goal, and the demo reflects the actual Tide target shape. This is our HMR test harness for the rest of the steps, explicitly *not* a component design target. Any gallery-specific layout plumbing (`.cg-content` overrides, padding resets, etc.) lives in `cards/gallery-split-pane.tsx` only; `tug-split-pane.tsx` itself stays host-agnostic.
4. **Tokens + pairings** in `brio.css` and `harmony.css`. Sash uses tokens for thickness and color. Theme switching should update it live.
5. **Sash states** — rest / hover / active / focus-visible — driven by CSS and data attributes.
6. **Grip icon + hit area.** Optional Lucide grip icon, hit area wider than visible thickness.
7. **Vertical orientation.** Add the `orientation` prop and demo variant.
8. **Size constraints** (`minSize`, `maxSize`), enforced on drag and on container resize.
9. **Snap-to-close.** `collapsible`, `collapsedSize`, `snapThreshold`, `onCollapsedChange`. Demo: drag below min, watch collapse, drag back, watch reopen.
10. **Persistence.** `storageKey`. Reload the page, layout restored.
11. **Size variants** (sm / md / lg) and the 3-pane + nested gallery demos.
12. **Keyboard + ARIA verification.** Tab, arrow keys, Home/End, Enter to toggle collapsible panels.
13. **Audit pass.** `bun run audit:tokens lint`, component authoring checklist, `bun run build`, `bun run test`.
14. **Link from tide.md T3.4** as a prerequisite.
15. *(Optional polish — only if a caller materializes)* **Imperative ref API** — `collapsePanel`, `expandPanel`, `getLayout`, `setLayout`.

Steps 1–3 are the first useful pause. After step 3 you can resize two panes on screen; everything after that is refinement.

Once `tug-split-pane` is in place, T3.4 picks up cleanly: the Tide card's content area becomes a `<TugSplitPane orientation="horizontal">` with `tug-markdown-view` on top and `tug-prompt-entry` on the bottom, and the rest of T3.4 is about the prompt-entry composition itself.

---

## Prep findings

Pass completed before step 1. Reads: `tuglaws/component-authoring.md`, `tug-slider.tsx` + `tug-slider.css`, `tug-accordion.tsx` (section headers), `gallery-registrations.tsx`, `gallery-slider.tsx`, `styles/themes/brio.css` (header + slider tokens), live fetch of `react-resizable-panels@4.10.0` manifest from the npm registry.

### 1. `react-resizable-panels` is green for our use

- **Latest version:** `4.10.0`
- **License:** MIT ✓
- **Author:** Brian Vaughn (@bvaughn), same maintainer over 160+ releases
- **Peer deps:** `"react": "^18.0.0 || ^19.0.0"`, `"react-dom": "^18.0.0 || ^19.0.0"` — React 19 explicitly supported
- **Actively tested against React 19:** the library's own `devDependencies` pin `react@^19.2.3`, i.e. the same minor we're on (`^19.2.4`)
- **Not currently installed** in `tugdeck/node_modules`

No blockers. Step 1's `bun add react-resizable-panels` should land cleanly.

### 2. File layout (no surprises)

`tugdeck/src/components/tugways/` is the public API. Top-level = what app code imports. `internal/` = building blocks. `tug-split-pane` is public, top-level — two files only:

```
tugdeck/src/components/tugways/tug-split-pane.tsx
tugdeck/src/components/tugways/tug-split-pane.css
```

Both `TugSplitPane` and `TugSplitPanel` live in the same `.tsx` file, banner-delimited, per the compound component convention (same as `tug-accordion.tsx` with its `TugAccordion` + `TugAccordionItem`).

Gallery demo lives in `tugdeck/src/components/tugways/cards/gallery-split-pane.tsx`. No barrel exports anywhere.

### 3. TSX structure to follow (verbatim from authoring guide)

1. Module docstring (name + purpose, then details, then law citations — no plan/spec references)
2. CSS import (`import "./tug-split-pane.css";`) — first, before React
3. Library imports (React, `react-resizable-panels`)
4. Internal imports (`cn`, `useTugBoxDisabled` if we cascade disabled, `TugIconName` if we type the grip icon)
5. Types
6. Exported props interfaces
7. `TugSplitPane` (forwardRef with named function for DevTools)
8. Banner: `/* --- TugSplitPanel --- */`
9. `TugSplitPanel` (forwardRef with named function)

Required boilerplate on the root of every forwarded component:
- `data-slot="tug-split-pane"` / `data-slot="tug-split-panel"` / `data-slot="tug-split-sash"`
- `className` via `cn("tug-split-pane", ...variantClasses, className)`
- `...rest` spread last
- Inline `style` merged, not replaced (`style={{ ...internal, ...style }}`)

### 4. Required law citations in the module docstring

Minimum set we must cite:
- **[L06]** appearance via CSS, never React state
- **[L15]** token-driven states (sash rest/hover/active/focus)
- **[L16]** every foreground rule declares its rendering surface
- **[L19]** component authoring guide
- **[L20]** token sovereignty — composed children (pane contents) keep their own tokens

Plus a scoped comment on why **we do not cite [L11]**: see §6 below — split-pane resize is not a chain-dispatched action, it is a state-mirror callback pattern, which the authoring guide explicitly permits.

### 5. CSS file structure to follow

```
/* @tug-pairings { ... } */          ← compact block (machine-parsed by audit-tokens lint)
/**
 * @tug-pairings                      ← expanded table (human/agent readable)
 * | Element | Surface | Role | Context |
 * ...
 */
body {                                ← optional component-tier aliases, one hop only [L17]
  --tugx-split-sash-bg: var(--tug7-surface-split-primary-normal-sash-rest);
  ...
}
.tug-split-pane { ... }                ← root
.tug-split-pane-horizontal { ... }     ← orientation variants
.tug-split-pane-vertical { ... }
.tug-split-panel { ... }
.tug-split-panel[data-collapsed="true"] { ... }
.tug-split-sash { ... }                ← sash base
.tug-split-sash-grip { ... }           ← grip icon
.tug-split-sash:hover { ... }          ← rest → hover → active → focus → disabled, in that order
.tug-split-sash[data-resize-handle-active] { ... }
.tug-split-sash:focus-visible { ... }
.tug-split-pane-sm { ... }             ← size variants
.tug-split-pane-md { ... }
.tug-split-pane-lg { ... }
```

Every rule that sets `color`, `fill`, `stroke`, or `border-color` without also setting `background-color` must have a `/* @tug-renders-on: <surface-token> */` annotation above it. This is non-negotiable — `audit-tokens lint` will fail the build otherwise.

Use component-tier `--tugx-split-*` aliases because the component has enough tokens to benefit. Resolve in one hop to `--tug7-*` per [L17].

### 6. [L11] and the state-mirror callback question

This is the one real design subtlety in the guide we need to resolve before writing any code.

**The rule:** controls that own user interactions emit actions through the chain (`useControlDispatch`), and callback props for user interactions are explicitly prohibited. A `TugCloseButton` must not expose `onClose`. `TugSlider` dispatches `SET_VALUE` via the chain.

**Why split-pane is different:** the authoring guide carves out an explicit exception for *state mirror callbacks*:

> Callback props for user interactions are prohibited. […] Non-user-interaction callbacks (state mirror callbacks like `onOpenChange` for Radix integration, lifecycle observers) are fine.

A split pane's layout state lives *inside the split pane* (specifically, inside `react-resizable-panels`' own state + optional `localStorage`). There is no external responder that owns layout. A consumer who wants to react to layout changes (e.g. "the inspector pane just collapsed — hide its toolbar") is asking for a state mirror, not dispatching a user action to some other component's responder.

**Decision:** `onSizeCommit` and `onCollapsedChange` are state mirror callbacks, not user-action callbacks. They do not need to go through the chain. `TugSplitPane` is a **layout primitive**, not a control in the [L11] sense. We cite [L06, L15, L16, L19, L20] in the module docstring and **do not cite [L11]**, with a short comment explaining why so a future auditor doesn't assume it was an oversight.

If we later decide we want chain-dispatched split-pane actions (e.g. `SPLIT_COLLAPSE_PANE` so a menu item can collapse the inspector), we add that on top — a menu item dispatches through the chain normally, the split pane registers via `useOptionalResponder` for those specific actions, and the state-mirror callbacks keep doing what they do.

### 7. Token naming — component slot is `split`

Seven-slot: `--tug7-<plane>-<component>-<constituent>-<emphasis>-<role>-<state>`

Component slot value: **`split`** (singular, no hyphen — matches `slider`, `toggle`, `field`, etc.).

Initial token sketch, refined from the roadmap spec using the seven-slot shape correctly:

| Token                                                  | Plane   | Purpose |
|--------------------------------------------------------|---------|---------|
| `--tug7-surface-split-primary-normal-sash-rest`        | surface | sash fill, resting |
| `--tug7-surface-split-primary-normal-sash-hover`       | surface | sash fill, hover |
| `--tug7-surface-split-primary-normal-sash-active`      | surface | sash fill, dragging |
| `--tug7-element-split-icon-normal-grip-rest`           | element | grip icon color, resting |
| `--tug7-element-split-icon-normal-grip-hover`          | element | grip icon color, hover |
| `--tug7-element-split-border-normal-focus-rest`        | element | keyboard focus ring |

Non-contrast effect-like values (thickness, hit area size, grip icon size) are *not* pairings. Use plain CSS custom props outside the seven-slot convention, defined locally in the component CSS (e.g. `--tugx-split-sash-thickness-md: 6px;`) and scaled by size variants. This mirrors how tug-slider handles track height and thumb size — those are local values in `tug-slider.css`, not theme tokens.

Tokens must be added to **both** `tugdeck/styles/themes/brio.css` (dark) and `tugdeck/styles/themes/harmony.css` (light) with the same names. Theme files use a `--tug-color(palette, i: N, t: M)` palette-addressing syntax for values — reference pattern is `--tug7-surface-slider-primary-normal-track-rest` at brio.css:213. No generation script — hand-authored.

### 8. Gallery registration mechanics

Two files to touch when adding `gallery-split-pane`:

1. **`gallery-split-pane.tsx`** (new) — the demo card component. Follow `gallery-slider.tsx` pattern: module docstring, imports, component function, `cg-content` root className, `cg-section` blocks with `cg-section-title` labels, `TugSeparator` between sections. No `ResponderScope` needed unless we add chain-dispatched actions (we're not, per §6).

2. **`cards/gallery-registrations.tsx`** — two edits:
   - Import `GallerySplitPane` at the top with the other gallery imports
   - Add a tab template entry in `GALLERY_DEFAULT_TABS` under the "Layout & Structure" section (alongside `gallery-box`, `gallery-accordion`, `gallery-separator`)
   - Add a `registerCard({...})` call inside `registerGalleryCards()` with this exact shape (from `gallery-slider` at line 433-440):
     ```ts
     registerCard({
       componentId: "gallery-split-pane",
       contentFactory: (_cardId) => <GallerySplitPane />,
       defaultMeta: { title: "TugSplitPane", icon: "<lucide icon name>", closable: true },
       family: "developer",
       acceptsFamilies: ["developer"],
       sizePolicy: GALLERY_COMPLEX_SIZE,  // we want room for nested-split demos
     });
     ```
   - A good lucide icon candidate: `PanelLeftRight` or `Columns2` or `Rows2`. We'll pick during step 3.

### 9. TugBox disabled cascade

`tug-slider.tsx` uses `useTugBoxDisabled()` from `./internal/tug-box-context` to inherit the disabled cascade from a parent `TugBox`. Our split pane should do the same: when placed inside a disabled `TugBox`, all sashes become non-interactive. This is a one-line addition (`const boxDisabled = useTugBoxDisabled(); const effectiveDisabled = disabled || boxDisabled;`), applied to the panel group's disabled state. Worth remembering so I don't miss it in step 2.

### 10. Things the roadmap doc under-specified that I now have answers for

- **`data-orientation` attribute** on the root — the `@selector` annotation in the props doc lists class names, but the guide's convention is that a data attribute is equally acceptable. I'll use class names (`.tug-split-pane-horizontal`, `-vertical`) for consistency with `tug-slider-inline`/`-stacked`.
- **`data-slot` attributes**: root = `tug-split-pane`, panel = `tug-split-panel`, sash = `tug-split-sash`.
- **`data-collapsed="true"` on collapsed panels** drives CSS-only collapse visual. React state tracks the collapsed boolean (it's data — consumer code cares) but the visual change is pure CSS per [L06].
- **Sash focusability**: the sash *is* keyboard-focusable (we want arrow-key resize), so unlike `tug-slider` we do *not* set `data-tug-focus="refuse"` on it. `react-resizable-panels`' `PanelResizeHandle` is focusable by default.
- **State selectors for the sash**: `react-resizable-panels` emits `data-resize-handle-active` during drag. We use that for the active-state CSS rather than `:active` (which wouldn't survive pointer-capture scenarios).
- **Transition policy**: no transitions on size during drag (they'd fight the library's real-time updates). Transitions only on hover/focus state changes of the sash.

### 11. Confirmed step order is still correct

Nothing in the prep pass invalidates the step breakdown. One small amendment: **step 2 should also wire the TugBox disabled cascade** so we don't have to circle back later. That's a 3-line addition, belongs in step 2, not a new step.

### 12. Resolved: imperative ref API demoted to optional polish

**Decision:** demote `collapsePanel`, `expandPanel`, `getLayout`, `setLayout` from a blocker step to an optional polish step *after* the audit pass. YAGNI — the Tide card only needs the uncontrolled API with `storageKey`, and the forwarding is cheap enough to retrofit if a caller actually materializes.

The step list has been updated: audit pass is now step 13, tide.md link is step 14, imperative ref API is step 15 (optional, only if a caller shows up).

### 13. Principle: the Component Gallery is a test harness, not a design target

Surfaced during the step-1 smoke test. The original gallery-card section of this doc framed the gallery demo as "the reference the Tide card integration will look at when mounting T3.4 content" — that framing was wrong and has been rewritten.

The correct posture:

- `TugSplitPane` has zero knowledge of the Component Gallery. It never imports `.cg-content`, never references gallery class names, never branches on whether a gallery host is present, never carries special paths for gallery use.
- The component's contract is the standard flexbox one: *parent must have a concrete size along the split axis; I fill it.* That contract is satisfied the same way in the gallery, in the Tide card, in a settings sheet, or anywhere else the component is mounted.
- If a specific host needs layout plumbing to satisfy that contract — for example, `.cg-content` defaults to padding + gap + scroll, so the gallery demo card overrides it inline with `{ padding: 0, gap: 0, overflow: hidden, height: "100%" }` — that plumbing lives at the mount site, not in the component.
- The gallery is a short-term convenience for iterating on the component under HMR. It will not exist in the shipped Tugdeck product surface. Anything written against the gallery's conventions is throwaway.

Why this is in the prep findings and not just the Goals section: I caught myself, during step 1, phrasing the layout work as "I know what to fight" and "composing with the gallery conventions." That framing was sloppy and revealed a posture where the gallery was creeping into the component's design space. The user pushed back. This finding is the written receipt so the posture doesn't creep back in during steps 2–14. Reread this before each step.

---

**Assessment:** Ready for step 1. All open questions resolved. Going.
