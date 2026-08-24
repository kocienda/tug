# Token Naming Refinement

*Audit and proposed improvements to the seven-slot naming convention before scaling to more components.*

---

## Problem

The seven-slot token convention uses `-` as the slot delimiter. CSS custom properties also use `-` as the word separator. When a slot value is conceptually two words, there is no way to express it without either breaking the parser (extra hyphen → 8 segments) or resorting to camelCase. This has produced **16 unique camelCase values across ~39 tokens** — each one a small inconsistency that will multiply as the system grows.

Before adding more components, we should eliminate every camelCase value that exists because the concept was placed in the wrong slot, and explicitly sanction camelCase for the few cases where it is genuinely the right answer.

---

## Changes by Category

### 1. Compound Component Names → Decompose into Component + Constituent

`tabClose` and `cardTitle` are compound component names that should split across the component and constituent slots. `close` and `title` are structural sub-parts — exactly what the constituent slot is for.

| Current | Proposed |
|---------|----------|
| `tug-element-tabClose-text-normal-plain-hover` | `tug-element-tab-close-normal-plain-hover` |
| `tug-surface-tabClose-primary-normal-plain-hover` | `tug-surface-tab-close-normal-plain-hover` |
| `tug-element-cardTitle-text-normal-plain-rest` | `tug-element-card-title-normal-plain-rest` |

Add `close` and `title` to the element constituent vocabulary.

**Tokens affected:** 3

### 2. titlebarOn/Off → Selector Context + Role Distinction

`titlebarOn` and `titlebarOff` encode focused/unfocused card state inside the role slot. The card already carries a data attribute for its active/inactive state. The selector should express context; the token name should express visual intent.

| Current | Proposed | Meaning |
|---------|----------|---------|
| `tug-element-card-control-normal-titlebarOn-rest` | `tug-element-card-control-normal-plain-rest` | Focused card control |
| `tug-element-card-control-normal-titlebarOn-hover` | `tug-element-card-control-normal-plain-hover` | Focused card control, hovered |
| `tug-element-card-control-normal-titlebarOn-active` | `tug-element-card-control-normal-plain-active` | Focused card control, pressed |
| `tug-element-card-control-normal-titlebarOff-rest` | `tug-element-card-control-normal-muted-rest` | Unfocused card control |
| `tug-element-card-control-normal-titlebarOff-hover` | `tug-element-card-control-normal-muted-hover` | Unfocused card control, hovered |
| `tug-element-card-control-normal-titlebarOff-active` | `tug-element-card-control-normal-muted-active` | Unfocused card control, pressed |

Same pattern for `surface-card-control` and `element-card-border` tokens (3 planes × 6 states = 18 tokens total).

CSS uses selector context for the focused/unfocused distinction:

```css
.tug-card-control { color: var(--tug-element-card-control-normal-plain-rest); }
.tug-card[data-inactive] .tug-card-control { color: var(--tug-element-card-control-normal-muted-rest); }
```

`plain` vs `muted` captures the visual difference. The card's focus state belongs in the selector, not the token name.

**Tokens affected:** 18

### 3. Highlight Compound Roles → Shorten

`dropTarget`, `inspectorTarget`, and `snapGuide` are highlight surface purpose roles. The component slot already says `highlight`, so the suffix is redundant.

| Current | Proposed |
|---------|----------|
| `tug-surface-highlight-primary-normal-dropTarget-rest` | `tug-surface-highlight-primary-normal-drop-rest` |
| `tug-surface-highlight-primary-normal-inspectorTarget-rest` | `tug-surface-highlight-primary-normal-inspector-rest` |
| `tug-surface-highlight-primary-normal-snapGuide-rest` | `tug-surface-highlight-primary-normal-snap-rest` |

**Tokens affected:** 3

### 4. readOnly → readonly

`readOnly` is a single concept. Lowercase it to match `disabled`, `hover`, `active`, etc.

| Current | Proposed |
|---------|----------|
| `tug-element-field-border-normal-plain-readOnly` | `tug-element-field-border-normal-plain-readonly` |
| `tug-element-field-text-normal-plain-readOnly` | `tug-element-field-text-normal-plain-readonly` |
| `tug-surface-field-primary-normal-plain-readOnly` | `tug-surface-field-primary-normal-plain-readonly` |

**Tokens affected:** 3

### 5. Card Overlay Effect Parameters → New `effect` Plane

The contentDim tokens carry non-color values (a color, an amount, a blend mode) for the inactive card overlay. They are currently shoehorned into the `surface` plane. These are visual effect parameters, not surfaces.

**Introduce the `effect` plane.** The plane slot already answers "what kind of value is this?" — `element` = foreground color, `surface` = background color. Adding `effect` = visual effect parameter is a natural extension.

| Current | Proposed |
|---------|----------|
| `tug-surface-card-primary-normal-contentDimDesat-color` | `tug-effect-card-desat-normal-dim-inactive` |
| `tug-surface-card-primary-normal-contentDimDesat-amount` | `tug-effect-card-desat-normal-amount-inactive` |
| `tug-surface-card-primary-normal-contentDimWash-color` | `tug-effect-card-wash-normal-dim-inactive` |
| `tug-surface-card-primary-normal-contentDimWash-blend` | `tug-effect-card-wash-normal-blend-inactive` |

Slot decomposition for `tug-effect-card-desat-normal-dim-inactive`:

| Slot | Value | Meaning |
|------|-------|---------|
| namespace | `tug` | Design system |
| plane | `effect` | Visual effect parameter |
| component | `card` | Belongs to card |
| constituent | `desat` | Desaturation layer |
| emphasis | `normal` | Default emphasis |
| role | `dim` / `amount` | What the value represents — the dim color, or the amount |
| state | `inactive` | Applies when card is inactive |

The `effect` plane follows the same seven-slot structure. The constituent identifies the effect layer (`desat`, `wash`). The role identifies the property within that layer (`dim` for the overlay color, `amount` for intensity, `blend` for blend mode).

**Tokens affected:** 4

#### The `effect` Plane as a Pattern

The `effect` plane is not card-specific. It provides a home for any component-scoped visual parameter that isn't a foreground color or background color. Examples of where this could extend:

**Motion** — Component-scoped animation parameters:

```
--tug-effect-card-collapse-normal-duration-rest
--tug-effect-card-collapse-normal-easing-rest
--tug-effect-overlay-fade-normal-duration-rest
```

Here `collapse` and `fade` are constituents (the effect type), `duration` and `easing` are roles (the property).

**Blur/Backdrop** — If a component ever needs a scoped backdrop-filter:

```
--tug-effect-overlay-blur-normal-radius-rest
```

**Key principle:** Global, unscoped values (spacing scales, font sizes, radius scales, global motion durations) keep their existing short-form naming (`--tug-motion-duration-fast`, `--tug-space-md`). The seven-slot `effect` plane is for values that are *component-scoped* — they belong to a specific component and vary with emphasis, role, or state.

### 6. Accept camelCase — Genuinely Multi-Word Roles

These values are legitimately multi-word concepts that cannot be decomposed into separate slots:

**On-surface roles:** `onAccent`, `onDanger`, `onSuccess`, `onCaution`

These follow a standard design-system pattern (Material, Figma, etc.): "foreground color for use on this named surface." The `on` prefix is the semantic — it says this element token is specifically designed for rendering on a colored surface. There is no slot restructuring that captures this.

**Accent variants:** `accentCool`, `accentSubtle`

These are role variants where the base role (`accent`) is modified by a quality (`cool`, `subtle`). `cool` or `subtle` alone would be ambiguous outside the accent context.

**Convention:** These 7 values are sanctioned camelCase. The rule is: camelCase is permitted in slot values *only when the concept is genuinely multi-word and cannot be expressed by placing parts in different slots*.

**Tokens affected:** 0 (no change, but now explicitly sanctioned)

---

## Updated Plane Vocabulary

| Plane | Value Type | Purpose |
|-------|-----------|---------|
| `element` | color | Visible foreground marks: text, icons, borders, fills, shadows |
| `surface` | color | Background fields: component backgrounds, tracks, overlays |
| `effect` | mixed | Visual effect parameters: filter colors, amounts, blend modes, durations, easings |

The `element`/`surface` contrast pairing system is unchanged. `effect` tokens do not participate in contrast pairing — they are parameters, not rendered colors.

---

## Updated Convention Rule

Add to token-naming.md:

> **Slot values are single lowercase words.** When a slot value is genuinely multi-word — the concept cannot be decomposed by placing parts in different slots — use **camelCase**. This is the sanctioned escape hatch: it keeps the seven-slot parser deterministic (split on `-`, get exactly 7 segments) while remaining readable.
>
> Before introducing a camelCase value, verify:
> 1. Can the concept split across component + constituent? (e.g., `tabClose` → `tab` + `close`)
> 2. Can context move to a CSS selector? (e.g., `titlebarOn` → `plain` + selector for focused card)
> 3. Can a suffix be dropped because the component slot already provides context? (e.g., `dropTarget` → `drop` when component is `highlight`)
>
> If all three answers are no, camelCase is correct.

---

## Summary

| Category | Tokens | Action | camelCase Eliminated |
|----------|--------|--------|---------------------|
| Compound component names | 3 | Decompose into component + constituent | 3 |
| titlebarOn/Off | 18 | Use plain/muted roles + CSS selectors | 18 |
| Highlight compound roles | 3 | Shorten (drop, inspector, snap) | 3 |
| readOnly | 3 | Lowercase to readonly | 3 |
| Card overlay parameters | 4 | New `effect` plane | 4 |
| On-surface roles | 5 | Accept (standard pattern) | 0 |
| Accent variants | 2 | Accept (genuinely compound) | 0 |
| **Total** | **38** | | **31 eliminated** |

After this refinement: 31 of 38 camelCase tokens are eliminated. The remaining 7 are explicitly sanctioned with a clear rule for when camelCase is and isn't appropriate. The new `effect` plane provides a structured home for non-color component parameters and a pattern that extends naturally to motion, blur, and other effect types.
