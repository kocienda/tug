# tug-separator

*Horizontal or vertical divider with ornamental heritage. From the simplest hairline to fleurons, dinkuses, and wood ornaments.*

---

## Design Intent

TugSeparator is a visual divider that draws from centuries of typographic tradition. At its simplest, it's a hairline rule between content sections. At its richest, it's a centered ornament — a fleuron, an asterism, a dingbat flourish, or a custom SVG reminiscent of the wood ornaments that letterpress printers used to compose elaborate page decorations.

The component handles cases that `<hr>` and tug-box's separator variant don't cover:

1. **Vertical dividers** — between toolbar items, sidebar sections, or inline elements
2. **Labeled dividers** — text centered on the line ("— OR —", "— Settings —")
3. **Ornamental dividers** — a centered glyph or SVG breaking the line
4. **Capped lines** — perpendicular end strokes like those on vintage computer consoles

---

## Typographic Heritage

The names and concepts behind separator ornaments:

| Term | Meaning |
|------|---------|
| **Dinkus** | The generic term for a section-break marker. Most commonly three spaced asterisks (`* * *`). |
| **Asterism** | The three-asterisk triangle glyph (⁂ U+2042). The canonical section break. |
| **Fleuron** | A typographic ornament shaped like a stylized flower or leaf. From Old French *floron*. |
| **Hedera** | Latin for "ivy." The ivy-leaf ornament (❦ U+2766), also called the *aldus leaf* after Renaissance printer Aldus Manutius. |
| **Printer's flower** | General term for any decorative typographic glyph used in page composition. |
| **Wood ornament** | Cast metal or carved wood blocks used in letterpress to compose elaborate decorative borders and dividers. |

---

## Comparison with tug-box separator

| Trait | tug-box (separator variant) | tug-separator |
|-------|---------------------------|---------------|
| Orientation | Horizontal only | Horizontal or vertical |
| Label / ornament | None | Text, Unicode glyph, or SVG |
| End caps | None | Optional perpendicular strokes |
| Semantics | Part of a fieldset grouping | Standalone `role="separator"` |
| Use case | Dividing sections within a TugBox | General layout divider |

They coexist — different tools for different contexts.

---

## Radix or Native?

**Decision: Original component (native).** `@radix-ui/react-separator` adds a dependency for ~10 lines of value. We set `role="separator"` and `aria-orientation` ourselves.

---

## Props

```typescript
export type TugSeparatorOrientation = "horizontal" | "vertical";

export interface TugSeparatorProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "role" | "children"> {
  /**
   * Divider direction.
   * @selector .tug-separator-horizontal | .tug-separator-vertical
   * @default "horizontal"
   */
  orientation?: TugSeparatorOrientation;

  /**
   * Label text centered on the divider line.
   * The line breaks around the label with a gap.
   * Horizontal only. Mutually exclusive with ornament.
   * @selector .tug-separator-labeled
   */
  label?: string;

  /**
   * Centered ornament — a Unicode character, short string, or ReactNode (for SVG).
   * The line breaks around the ornament, just like a label.
   * Horizontal only. Mutually exclusive with label.
   *
   * Common values:
   * - Single glyph: "◆", "✦", "❦", "⁂", "§"
   * - Dinkus pattern: "* * *", "· · ·", "✦ ✦ ✦"
   * - ReactNode: an inline SVG for wood-ornament-style richness
   *
   * @selector .tug-separator-ornamented
   */
  ornament?: React.ReactNode;

  /**
   * Perpendicular end caps on the line terminations.
   * Inspired by vintage computer console labeling where lines
   * end with short perpendicular strokes: ├──── LABEL ────┤
   * Horizontal only.
   * @selector .tug-separator-capped
   * @default false
   */
  capped?: boolean;

  /**
   * Decorative separators (the common case) are hidden from the
   * accessibility tree. Set to false when the separator conveys
   * meaningful structure (e.g., between form sections).
   * @default true
   */
  decorative?: boolean;
}
```

### Mutual exclusivity

`label` and `ornament` are mutually exclusive — you can't have both centered on the same line. If both are provided, `label` wins (it's the more semantic choice). In practice, callers use one or the other:

- `<TugSeparator label="OR" />` — labeled divider
- `<TugSeparator ornament="❦" />` — ornamental divider
- `<TugSeparator ornament={<MyFleuronSVG />} />` — SVG ornament
- `<TugSeparator capped label="INSTRUCTION" />` — console-style capped label

### Props NOT included (and why)

- **`size`**: Thickness is always 1px. Consistent with the rest of the token system.
- **`color` / `variant`**: One divider color from the token system. Thematic variants can be added later if needed.

---

## Curated Ornament Characters

A reference for callers choosing ornaments. Grouped by aesthetic:

### Minimal / Modern
| Char | Code | Name | Notes |
|------|------|------|-------|
| `·` | U+00B7 | Middle dot | Most minimal possible ornament |
| `•` | U+2022 | Bullet | Classic. Three spaced (`• • •`) = a dinkus |
| `▪` | U+25AA | Black small square | Compact, understated |
| `✦` | U+2726 | Black four pointed star | Elegant, minimal star |

### Geometric
| Char | Code | Name | Notes |
|------|------|------|-------|
| `◆` | U+25C6 | Black diamond | Bold, authoritative |
| `●` | U+25CF | Black circle | Strong presence |
| `◎` | U+25CE | Bullseye | Circle-within-circle |
| `⊙` | U+2299 | Circled dot | Solar symbol |

### Stars and Asterisms
| Char | Code | Name | Notes |
|------|------|------|-------|
| `⁂` | U+2042 | Asterism | The canonical section break |
| `✳` | U+2733 | Eight spoked asterisk | Clean, geometric |
| `✴` | U+2734 | Eight pointed black star | Compact filled star |
| `★` | U+2605 | Black star | Universal recognition |
| `✠` | U+2720 | Maltese cross | Printer's ornament heritage |

### Fleurons and Florals
| Char | Code | Name | Notes |
|------|------|------|-------|
| `❦` | U+2766 | Floral heart (hedera) | THE classic printer's fleuron |
| `❧` | U+2767 | Rotated floral heart | Aldus leaf variant |
| `✿` | U+273F | Black florette | Solid flower |
| `❁` | U+2741 | Eight petalled florette | More detailed |
| `§` | U+00A7 | Section sign | Deep typographic heritage |

### Dinkus Patterns (pass as string)
| Pattern | Style |
|---------|-------|
| `* * *` | The classic dinkus |
| `· · ·` | Minimal dinkus |
| `✦ ✦ ✦` | Star dinkus |
| `— — —` | Dash dinkus |
| `~ ~ ~` | Tilde dinkus |

---

## Rendering

### Plain horizontal (default)

```html
<div role="separator" aria-orientation="horizontal"
     class="tug-separator tug-separator-horizontal" />
```

CSS `border-top: 1px solid` is the visual.

### Labeled

```html
<div role="separator" aria-orientation="horizontal"
     class="tug-separator tug-separator-horizontal tug-separator-labeled">
  <span class="tug-separator-label" aria-hidden="true">OR</span>
</div>
```

Flexbox: `::before` (line) + label + `::after` (line). Lines are `flex: 1; height: 1px; background: divider-token`.

### Ornamented

```html
<div role="separator" aria-orientation="horizontal"
     class="tug-separator tug-separator-horizontal tug-separator-ornamented">
  <span class="tug-separator-ornament" aria-hidden="true">❦</span>
</div>
```

Same flexbox layout as labeled, but ornament span gets no font-weight override (inherits natural glyph weight) and slightly larger font-size for visual presence.

### Capped

```html
<div role="separator" aria-orientation="horizontal"
     class="tug-separator tug-separator-horizontal tug-separator-capped" />
```

The `::before` and `::after` pseudo-elements get short perpendicular strokes at their outer ends. Implemented via `border-left`/`border-right` on the pseudo-elements (1px perpendicular stroke at each end of the line). Combined with label or ornament for the console aesthetic: `├── LABEL ──┤`.

### Capped + labeled (console style)

```html
<div role="separator" aria-orientation="horizontal"
     class="tug-separator tug-separator-horizontal tug-separator-labeled tug-separator-capped">
  <span class="tug-separator-label" aria-hidden="true">INSTRUCTION</span>
</div>
```

The full vintage console treatment: perpendicular end caps + centered label.

### Vertical

```html
<div role="separator" aria-orientation="vertical"
     class="tug-separator tug-separator-vertical" />
```

CSS `border-left: 1px solid`, `align-self: stretch`. Vertical separators do not support label, ornament, or capped — those are horizontal-only features.

---

## Tokens

Reuses existing global divider tokens — no new tokens needed:

| Usage | Token |
|-------|-------|
| Line color | `--tug7-element-global-divider-normal-separator-rest` |
| End cap color | Same as line (single token) |
| Label text | `--tug7-element-field-text-normal-label-rest` |
| Ornament color | Same as line (inherits divider color) |
| Renders on | `--tug7-surface-global-primary-normal-default-rest` |

---

## CSS Structure

```
tug-separator.css
├── @tug-pairings (divider line on global default surface; label text on same)
├── Base (.tug-separator) — reset
├── Horizontal (.tug-separator-horizontal)
│   ├── border-top: 1px solid divider token
│   ├── width: 100%, height: 0
│   └── margin: var(--tug-space-md) 0
├── Vertical (.tug-separator-vertical)
│   ├── border-left: 1px solid divider token
│   ├── width: 0, align-self: stretch
│   └── margin: 0 var(--tug-space-md)
├── Labeled (.tug-separator-labeled)
│   ├── display: flex, align-items: center
│   ├── border-top: none (lines are pseudo-elements)
│   ├── ::before, ::after — flex: 1, height: 1px, background: divider token
│   └── .tug-separator-label — font-size, font-weight: 500, color: label token, padding: 0 space-md
├── Ornamented (.tug-separator-ornamented)
│   ├── Same flexbox layout as labeled
│   ├── ::before, ::after — same lines
│   └── .tug-separator-ornament — font-size: 1.25em, color: divider token, padding: 0 space-md
├── Capped (.tug-separator-capped)
│   ├── ::before — border-left: 1px solid (perpendicular start cap)
│   ├── ::after — border-right: 1px solid (perpendicular end cap)
│   └── Cap height: ~6px (enough to be visible, not overwhelming)
```

---

## Implementation Plan

Single dash:

### Dash 1: Component + CSS + Gallery card
- `tug-separator.tsx` — component with all props
- `tug-separator.css` — all variants
- `cards/gallery-separator.tsx` — demo sections:
  - Plain horizontal
  - Labeled ("OR", "Settings")
  - Ornamental (single glyphs: ◆, ✦, ❦, ⁂)
  - Dinkus patterns ("* * *", "· · ·")
  - Capped (plain, with label — console style)
  - Vertical (between inline items)
  - SVG ornament (a simple decorative SVG to prove the ReactNode path works)
- Gallery registration

---

## Laws Compliance

| Law | How |
|-----|-----|
| L06 | All appearance via CSS — no React state for visuals |
| L16 | Pairings declared, @tug-renders-on on foreground rules |
| L19 | Follows component authoring guide |
