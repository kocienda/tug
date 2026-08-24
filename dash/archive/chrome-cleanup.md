# Chrome Layer Cleanup

*Clean up card-frame.tsx and chrome.css — remove plan archaeology, fix raw colors, note structural debt.*

---

## Dash: Comment Cleanup + Raw Color Fix

### 1. card-frame.tsx docstring rewrite

Replace lines 1-27. Remove `Spec S04`, `Risk R02`, "Authoritative references". Keep the Responsibilities section (genuinely useful). Keep `[D03]` and `[D06]` decision refs.

New docstring:
```
/**
 * CardFrame — absolutely-positioned frame with drag, resize, z-index, and
 * min-size clamping.
 *
 * Responsibilities:
 * - Render an absolutely-positioned div at position/size from cardState
 * - Inject onDragStart and onMinSizeChange into Tugcard via renderContent
 * - Drag: RAF appearance-zone mutation during, onCardMoved structure-zone commit on end
 * - Resize: 8 edge/corner handles, clamped to min-size, onCardMoved on end
 * - Bring to front via onCardFocused on any pointer-down in the frame
 *
 * [D03] CardFrame/Tugcard separation, [D06] appearance-zone drag
 *
 * @module components/chrome/card-frame
 */
```

### 2. Purge Spec/Rule/Fix refs from card-frame.tsx body

Search and clean all occurrences of:
- `[Spec S##]` or `Spec S##` — remove
- `[S03]` — remove (shorthand for Spec S03)
- `Rule 13` — remove
- `[Fix 3]` — remove (refers to a bug fix iteration, not a decision)
- `(Spec S04)` in type comments — remove

Keep all `[D##]` decision references — those are legitimate.

Rephrase comments that are only spec refs. For example:
- `// Module-level counter for unique SVG flash filter IDs [Spec S03]` → `// Module-level counter for unique SVG flash filter IDs`
- `// Shadow extension constant [Spec S02]` → `// Shadow extension constant`
- `// Types (Spec S04)` → `// Types`

Also clean up `CardFrameInjectedProps` and `CardFrameProps` JSDoc — remove "Authoritative reference: Spec S04" lines.

### 3. chrome.css comment cleanup

- Line 6: Remove "Replaces cards-chrome.css (404 lines, now deleted)" — history
- Line 93: Remove "Renamed from .set-flash-overlay" — history
- Line 94: Remove `Rule 13`
- Line 113: Remove `Spec S03` from `[D01, D02, Spec S03]`

### 4. chrome.css raw `--tug-color()` values → tokens

Two places use raw `--tug-color()` in chrome.css instead of tokens:

**Virtual sash hover (line 73):**
```css
.virtual-sash:hover { background: --tug-color(cobalt, i: 3, t: 94, a: 8); }
```
This is a very subtle hover tint. Add a token to both theme files:
```
--tug7-surface-highlight-primary-normal-snap-hover
```
Brio: `--tug-color(cobalt, i: 3, t: 15, a: 8)` (subtle on dark)
Harmony: `--tug-color(cobalt, i: 3, t: 94, a: 8)` (subtle on light — current value)

Then chrome.css becomes:
```css
.virtual-sash:hover { background: var(--tug7-surface-highlight-primary-normal-snap-hover); }
```

**Flash overlay glow (lines 103-104):**
```css
box-shadow:
  0 0 5px --tug-color(orange, i: 50, t: 50, a: 60),
  inset 0 0 16px --tug-color(orange, i: 50, t: 50, a: 20);
```
These are accent-colored glow effects for the card break-out flash. Add tokens to both theme files:
```
--tug7-element-global-shadow-normal-flash-rest     (outer glow)
--tug7-element-global-shadow-normal-flashInset-rest (inner glow)
```
Brio: current orange values work on dark
Harmony: may need tuning — orange glow on light background

Then chrome.css becomes:
```css
box-shadow:
  0 0 5px var(--tug7-element-global-shadow-normal-flash-rest),
  inset 0 0 16px var(--tug7-element-global-shadow-normal-flashInset-rest);
```

---

## Noted Structural Debt (Not This Dash)

These are real issues but not urgent enough for this cleanup pass:

### handleDragStart is a 430-line useCallback
Lines 339-768. Contains `applyDragFrame`, `onPointerMove`, and `onPointerUp` as nested closures. Functional and correct — the nesting is necessary because they close over drag-start state. But extremely dense. A future refactor could extract the drag state machine into a custom hook (`useDragGesture`) that returns the `handleDragStart` callback.

### Duplicated canvas-rect snapshot logic
The pattern of querying `.card-frame[data-card-id]` elements and converting to canvas-relative coords appears three times: drag-start (lines 370-385), resize-start (lines 808-822), and resize-start set membership (lines 826-841). Could be extracted to a `snapshotCardRects(excludeId, canvasBounds)` helper.

### `indexOf` in a loop
Line 441: `dragSetOrigins.current.indexOf(origin)` inside a for-of loop — O(n^2). Should use index-based iteration. Unlikely to matter with typical card counts (<20), but it's sloppy.

### Shadow rules split across files
`.tugcard` shadow is set in chrome.css (lines 39-45), while all other `.tugcard` styling is in tug-card.css. Architecturally defensible (shadow is a chrome concern), but could confuse maintainers.

---

## Files Touched

| File | Change |
|------|--------|
| `card-frame.tsx` | Docstring rewrite, Spec/Rule/Fix purge from comments and JSDoc |
| `chrome.css` | History comment removal, raw `--tug-color()` → tokens |
| `brio.css` | Add 3 new tokens (sash hover, flash glow, flash inset glow) |
| `harmony.css` | Add same 3 tokens with light-appropriate values |
