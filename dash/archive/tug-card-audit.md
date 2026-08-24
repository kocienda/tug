# Tug-Card Audit Fix

*Two dashes to bring tug-card to compliance: mechanical cleanup first, then the raw-button refactor.*

---

## Dash 1: Mechanical Cleanup

Standard audit fixes — docstring, pairings, annotations, CSS import order.

### 1.1 Module docstring rewrite

The current docstring is 57 lines of plan archaeology: `Spec S01`, `Spec S07`, `Phase 5b`, `Step 7`, "Authoritative references". Rewrite to ~15 lines:

- What the component does (composition root: title bar + tabs + content)
- The visual stack diagram (keep — it's genuinely useful)
- Law citations: [L06], [L09] (card composition), [L19]
- Decision citations: [D01] Tugcard composition, [D03] CardFrame/Tugcard separation, [D07] Tugcard responder node

Delete: all `Spec S##`, `Phase ##`, `Step ##`, "Authoritative references" sections, the "Close button pointer-capture note (Step 7)" section.

### 1.2 Purge Spec/Phase/Step references from code body

Pervasive throughout the file. Every comment referencing `Spec S##`, `Phase ##`, `Step ##` must be cleaned up. Keep the `[D##]` decision references — those are legitimate. Remove or rephrase comments that are history ("Phase 5f: access the DeckManager store") into present-tense descriptions ("Access the DeckManager store for tab state").

Also clean up `CardTitleBarProps`, `TugcardMeta`, and `TugcardProps` JSDoc — remove `Spec S01`, `Spec S02`, "Authoritative reference" lines.

### 1.3 CSS import order

Move `import "./tug-card.css";` from line 78 (last import) to line 2 (first import, after module docstring).

### 1.4 Add data-slot

- Root div of Tugcard (line 966): add `data-slot="tug-card"`
- CardTitleBar root div (line 254): add `data-slot="tug-card-title-bar"`

### 1.5 CSS pairings fix

- Add compact `/* @tug-pairings { ... } */` block before the expanded table
- Remove parenthetical short-names from expanded table (e.g., remove `(card-border)`, `(card-title-fg-active)`)

### 1.6 Add @tug-effects block

The CSS uses `--tug7-effect-*` tokens (lines 70-73) but doesn't declare them. Add per component-authoring.md:

```css
/* @tug-effects {
 *   --tug7-effect-card-desat-normal-dim-inactive     | desaturation overlay color
 *   --tug7-effect-card-desat-normal-amount-inactive   | desaturation intensity (0-1)
 *   --tug7-effect-card-wash-normal-dim-inactive       | wash overlay color
 *   --tug7-effect-card-wash-normal-blend-inactive     | wash blend mode
 * } */
```

### 1.7 Add @selector/@default on CSS-targetable props

Only a few props map to CSS:
- `TugcardProps.collapsed`: `@selector .tugcard--collapsed` `@default false`
- `CardTitleBarProps.closable`: `@default true`
- `CardTitleBarProps.collapsed`: `@selector [aria-expanded]`

---

## Dash 2: Raw-Button Refactor

CardTitleBar renders three `<button>` elements with hardcoded TugButton CSS classes:

```tsx
<button className="tug-button tug-button-ghost-action tug-button-icon-sm" ...>
```

This bypasses TugButton's infrastructure: `forwardRef`, `data-slot`, `...rest` spread, emphasis/role token injection, loading state, disabled state. It's fragile — if TugButton's class names change, these break silently.

### The fix

Replace the three raw `<button>` elements with `TugButton` (from `internal/tug-button`):

```tsx
import { TugButton } from "./internal/tug-button";
```

Each button becomes:

```tsx
<TugButton
  subtype="icon"
  emphasis="ghost"
  role="action"
  size="sm"
  icon={<X />}
  aria-label="Close card"
  onPointerDown={handleClosePointerDown}
  onPointerUp={handleClosePointerUp}
  onClick={handleCloseClick}
/>
```

### Complications to verify

1. **Pointer capture pattern on close button.** The close button uses `setPointerCapture` on `pointerdown` + custom `pointerup` hit-testing. TugButton handles `onClick` via its own responder chain integration. Need to verify that passing `onPointerDown`/`onPointerUp`/`onClick` directly works with TugButton's `...rest` spread, and that the pointer capture pattern doesn't conflict with TugButton's internal click handling.

2. **`data-no-activate` attribute on close button.** Currently set on the raw button (line 303). With TugButton, this should pass through via `...rest`.

3. **`stopPropagation` on pointerDown for menu and collapse buttons.** These use inline `onPointerDown={(e) => e.stopPropagation()}` to prevent drag start. This needs to work through TugButton's rest spread.

4. **CSS overrides in tug-card.css.** Lines 252-294 override `.tug-button` styles within `.card-title-bar-controls` for focused/unfocused card states. These selectors target `.tug-button` directly — they should still work since TugButton renders with that class. But verify the specificity still wins.

5. **Icon rendering.** Currently uses `React.createElement(icons["X"])`. TugButton expects `icon={<X />}`. The dynamic icon lookup from the `icons` object needs to be compatible with TugButton's `icon` prop.

### Testing

- Close button: pointer capture → pointer up inside → fires close. Pointer up outside → no close.
- Collapse button: click toggles collapsed state. Double-click on title bar surface also toggles.
- Menu button: renders, stopPropagation prevents drag.
- Keyboard: Enter/Space on each button fires the appropriate action.
- Visual: focused card controls use plain role tokens. Unfocused card controls use muted role tokens. Hover/active states work.

---

## Files touched

### Dash 1 (mechanical)
| File | Change |
|------|--------|
| `tug-card.tsx` | Docstring rewrite, Spec/Phase purge, CSS import order, data-slot, @selector/@default |
| `tug-card.css` | Compact pairings, remove parentheticals, add @tug-effects |

### Dash 2 (raw-button refactor)
| File | Change |
|------|--------|
| `tug-card.tsx` | Replace 3 raw buttons with TugButton, add import, update icon rendering |
| `tug-card.css` | Verify control button CSS overrides still work (may need minor selector adjustments) |
