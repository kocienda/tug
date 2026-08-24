# Tugways Semantic Token Proposal

**Date:** 2026-03-12
**Status:** Draft
**Scope:** Define the complete semantic vocabulary for `tug-base.css` — the foundation that component CSS files build on.

---

## Problem

The current `tug-base.css` mixes genuine semantic primitives (surfaces, foreground, spacing) with component-specific tokens that were shoved into base because everything lived in one file. The recent CSS reorganization split component tokens into per-component files, but the dash agent duplicated raw `--tug-color()` values instead of referencing base tokens. Before fixing that, we need a complete inventory of what base should provide so components never need to invent their own colors.

The goal: **a component should be able to express any visual state by composing base tokens.** Component files should only define tokens that are genuinely bespoke — unique to that component's specific visual identity, not derivable from base primitives.

---

## Control States

Controls support these interaction states:

| State | Meaning | User can interact? |
|-------|---------|-------------------|
| **rest** | Default appearance | Yes |
| **hover** | Pointer is over the control | Yes |
| **active** | Control is being pressed/clicked | Yes |
| **focused** | Keyboard/assistive focus | Yes |
| **selected** | Chosen item (active tab, checked checkbox) | Yes |
| **highlighted** | Visually called out (search match, current item) | Depends on context |
| **disabled** | Non-interactive due to app state | No |

### Compound States

CSS cannot "OR" state tokens together at the value level. You cannot write `var(--bg-disabled OR --bg-selected)`. Instead, compound states are handled through **selector chaining** on data attributes:

```css
/* Single states */
.control[data-state="selected"] { ... }
.control[data-disabled] { ... }

/* Compound: disabled AND selected */
.control[data-disabled][data-state="selected"] { ... }
```

Not every combination is meaningful. Here are the compounds that matter:

| Compound | Example | Needs tokens? |
|----------|---------|---------------|
| selected + hover | Hovering over active tab | Yes — slightly brighter selected bg |
| selected + active | Pressing active tab | Rare — use selected bg |
| selected + disabled | Selected tab in disabled group | Yes — muted selected bg |
| selected + focused | Keyboard on active tab | Yes — selected bg + focus ring |
| hover + focused | Mouse and keyboard both present | No — hover wins visually, focus ring shows |
| highlighted + hover | Hovering over search match | No — highlighted bg is enough |
| highlighted + selected | Current + selected | Yes — selected wins |
| disabled + focused | Screen reader on disabled control | No — disabled suppresses focus |

**Practical rule:** Define tokens for the 7 single states. For compounds, define only `selected+hover`, `selected+disabled`, and `selected+focused`. Everything else composes naturally (e.g., focus ring overlays any state, disabled overrides everything).

---

## Control Kinds

Three kinds of controls, distinguished by intent:

| Kind | Role | Default key? | Visual weight |
|------|------|-------------|---------------|
| **primary** | The default action — what Enter/Return triggers | Yes | Accent fill, high contrast |
| **secondary** | Alternative action — clickable but not default | No | Subtle fill, standard contrast |
| **destructive** | Data loss risk — requires care | No | Danger fill, warning color |

Additionally, **ghost** exists as a visual variant of secondary (transparent rest state, surface fill on hover). Ghost is not a separate "kind" — it's a styling modifier on secondary.

---

## Base Token Inventory

> *This section originally used legacy `fg-` / `bg-` naming. Updated to Phase 3.5A six-slot finalized names: `<plane>-<component>-<constituent>-<emphasis>-<role>-<state>`.*

### A. Surfaces

Background colors at different elevation levels. These are the canvas on which everything sits.

```
--tug-base-surface-global-primary-normal-app-rest      App chrome background
--tug-base-surface-global-primary-normal-canvas-rest   Canvas/workspace background
--tug-base-surface-global-primary-normal-sunken-rest   Recessed areas (tab bar, field bg)
--tug-base-surface-global-primary-normal-default-rest  Standard panel/card body
--tug-base-surface-global-primary-normal-raised-rest   Slightly elevated (active tab, kbd)
--tug-base-surface-global-primary-normal-overlay-rest  Floating panels (menus, popovers, dialogs)
--tug-base-surface-global-primary-normal-inset-rest    Deeply recessed (code blocks, inputs)
--tug-base-surface-global-primary-normal-content-rest  Content reading area
--tug-base-surface-global-primary-normal-screen-rest   High-contrast screen (terminal)
```

### B. Element — Text

Text colors at different emphasis levels.

```
--tug-base-element-global-text-normal-default-rest     Primary text
--tug-base-element-global-text-normal-muted-rest       Secondary text, labels
--tug-base-element-global-text-normal-subtle-rest      Tertiary text, metadata
--tug-base-element-global-text-normal-plain-disabled   Disabled text
--tug-base-element-global-text-normal-inverse-rest     Text on accent/filled backgrounds
--tug-base-element-global-text-normal-placeholder-rest Input placeholder text
--tug-base-element-global-text-normal-link-rest        Hyperlink text
--tug-base-element-global-text-normal-link-hover       Hyperlink hover
--tug-base-element-global-text-normal-onAccent-rest    Text on accent surface
--tug-base-element-global-text-normal-onDanger-rest    Text on danger surface
--tug-base-element-global-text-normal-onSuccess-rest   Text on success surface
```

### C. Icons

Icon colors parallel the foreground scale but tuned for smaller shapes.

```
--tug-base-icon-default              Standard icon
--tug-base-icon-muted                Secondary icon
--tug-base-icon-disabled             Disabled icon
--tug-base-icon-active               Accent-colored active icon
--tug-base-icon-onAccent             Icon on accent bg
```

### D. Borders / Dividers / Focus

```
--tug-base-border-default            Standard border
--tug-base-border-muted              Subtle border
--tug-base-border-strong             Emphasis border
--tug-base-border-inverse            Border on dark-on-light inversion
--tug-base-border-accent             Accent-colored border
--tug-base-border-danger             Danger-colored border
--tug-base-divider-default           Section divider
--tug-base-divider-muted             Subtle divider
--tug-base-focus-ring-default        Focus ring color
--tug-base-focus-ring-danger         Danger focus ring
--tug-base-focus-ring-offset         Focus ring offset background
```

### E. Shadows / Overlays

Generic shadow scale (not component-specific).

```
--tug-base-shadow-xs                 Minimal shadow
--tug-base-shadow-sm                 Small shadow
--tug-base-shadow-md                 Medium shadow
--tug-base-shadow-lg                 Large shadow
--tug-base-shadow-xl                 Extra large shadow
--tug-base-shadow-overlay            Floating panel shadow (compound)
--tug-base-overlay-dim               Dim overlay for unfocused areas
--tug-base-overlay-scrim             Modal backdrop
--tug-base-overlay-highlight         Subtle white highlight
```

### F. Typography

```
--tug-base-font-family-sans          UI text font stack
--tug-base-font-family-mono          Code/mono font stack
--tug-base-font-size-2xs             11px
--tug-base-font-size-xs              12px
--tug-base-font-size-sm              13px
--tug-base-font-size-md              14px
--tug-base-font-size-lg              16px
--tug-base-font-size-xl              20px
--tug-base-font-size-2xl             24px
--tug-base-line-height-2xs … 2xl     Matching line heights
--tug-base-line-height-tight         1.2
--tug-base-line-height-normal        1.45
```

### G. Spacing

```
--tug-base-space-2xs                 2px
--tug-base-space-xs                  4px
--tug-base-space-sm                  6px
--tug-base-space-md                  8px
--tug-base-space-lg                  12px
--tug-base-space-xl                  16px
--tug-base-space-2xl                 24px
```

### H. Radius

```
--tug-base-radius-2xs                1px
--tug-base-radius-xs                 2px
--tug-base-radius-sm                 4px
--tug-base-radius-md                 6px
--tug-base-radius-lg                 8px
--tug-base-radius-xl                 12px
--tug-base-radius-2xl                16px
```

### I. Stroke

```
--tug-base-stroke-hairline           0.5px
--tug-base-stroke-thin               1px
--tug-base-stroke-medium             1.5px
--tug-base-stroke-thick              2px
```

### J. Chrome / Icon Size

```
--tug-base-chrome-height             36px (card header & tab bar height)
--tug-base-icon-size-2xs             10px
--tug-base-icon-size-xs              12px
--tug-base-icon-size-sm              13px
--tug-base-icon-size-md              15px
--tug-base-icon-size-lg              20px
--tug-base-icon-size-xl              24px
```

### K. Motion

```
--tug-base-motion-duration-instant   0ms (scaled)
--tug-base-motion-duration-fast      100ms (scaled)
--tug-base-motion-duration-moderate  200ms (scaled)
--tug-base-motion-duration-slow      350ms (scaled)
--tug-base-motion-duration-glacial   500ms (scaled)
--tug-base-motion-easing-standard    cubic-bezier(0.2, 0, 0, 1)
--tug-base-motion-easing-enter       cubic-bezier(0, 0, 0, 1)
--tug-base-motion-easing-exit        cubic-bezier(0.2, 0, 1, 1)
--tug-base-motion-pattern-*          Shorthand transition patterns
```

---

## NEW: Control Surface Tokens

This is the key addition. These tokens define how interactive controls look across kinds and states. Components reference these instead of inventing ad-hoc colors.

### Control Backgrounds

For each kind (primary, secondary, destructive), provide bg for each meaningful state:

```
Primary:
--tug-base-control-primary-bg-rest
--tug-base-control-primary-bg-hover
--tug-base-control-primary-bg-active
--tug-base-control-primary-bg-disabled

Secondary:
--tug-base-control-secondary-bg-rest
--tug-base-control-secondary-bg-hover
--tug-base-control-secondary-bg-active
--tug-base-control-secondary-bg-disabled

Destructive:
--tug-base-control-destructive-bg-rest
--tug-base-control-destructive-bg-hover
--tug-base-control-destructive-bg-active
--tug-base-control-destructive-bg-disabled

Ghost (modifier on secondary):
--tug-base-control-ghost-bg-rest          transparent
--tug-base-control-ghost-bg-hover         subtle surface
--tug-base-control-ghost-bg-active        default surface
```

### Control Foregrounds

```
--tug-base-control-primary-fg             Inverse (white on accent)
--tug-base-control-secondary-fg           Default text
--tug-base-control-destructive-fg         Inverse (white on danger)
--tug-base-control-ghost-fg               Muted text
--tug-base-control-disabled-fg            Disabled text (shared across kinds)
```

### Control Borders

```
--tug-base-control-primary-border         transparent (filled bg is enough)
--tug-base-control-secondary-border       Default border
--tug-base-control-destructive-border     transparent (filled bg is enough)
--tug-base-control-ghost-border           transparent
--tug-base-control-disabled-border        Muted border
```

### Control Icons

```
--tug-base-control-primary-icon           Inverse icon
--tug-base-control-secondary-icon         Default icon
--tug-base-control-destructive-icon       Inverse icon
--tug-base-control-ghost-icon             Muted icon
--tug-base-control-disabled-icon          Disabled icon
```

### Control Opacity

```
--tug-base-control-disabled-opacity       0.5
```

### Selected State Overlay

Rather than tripling every kind×state, selected state is expressed as an **overlay modification** on the existing kind tokens:

```
--tug-base-control-selected-bg            Accent-tinted background
--tug-base-control-selected-bg-hover      Slightly brighter accent tint
--tug-base-control-selected-fg            Default text (or accent text)
--tug-base-control-selected-border        Accent border
--tug-base-control-selected-disabled-bg   Muted accent tint
```

This works because "selected" cuts across kinds — a selected tab, a checked checkbox, an active menu item all share the same semantic: "this one is chosen."

### Highlighted State

```
--tug-base-control-highlighted-bg         Subtle accent background
--tug-base-control-highlighted-fg         Default text
--tug-base-control-highlighted-border     Accent border (subtle)
```

---

## Accent / Semantic Color System

### Core Accents

```
--tug-base-accent-default                 Brand accent (orange)
--tug-base-accent-strong                  Intense accent
--tug-base-accent-muted                   Reduced accent
--tug-base-accent-subtle                  Very light accent tint
--tug-base-accent-cool-default            Cool accent (cobalt)
```

### Semantic Tones

Four semantic tones, each with a consistent set of tokens:

```
For each tone (positive, warning, danger, info):

--tug-base-tone-<tone>                    Full-strength color
--tug-base-tone-<tone>-bg                 Subtle tinted background
--tug-base-tone-<tone>-fg                 Text color for the tone
--tug-base-tone-<tone>-border             Border color for the tone
--tug-base-tone-<tone>-icon               Icon color for the tone
```

This replaces the current explosion of `--tug-toast-success-bg`, `--tug-badge-success-bg`, `--tug-banner-info-bg`, etc. Components reference the tone tokens directly:

```css
/* Before (in tug-dialog.css): */
--tug-toast-success-bg: --tug-color(green, i: 50, t: 50, a: 15);
--tug-badge-success-bg: --tug-color(green, i: 50, t: 50, a: 20);

/* After (component references base): */
.toast-success { background-color: var(--tug-base-tone-positive-bg); }
.badge-success { background-color: var(--tug-base-tone-positive-bg); }
```

If a component needs a slightly different opacity, it defines a bespoke token. But the common case is covered by base.

The full tone set:

```
--tug-base-tone-positive                  green (success)
--tug-base-tone-positive-bg               green @ 15% alpha
--tug-base-tone-positive-fg               green (or dark variant for light themes)
--tug-base-tone-positive-border           green
--tug-base-tone-positive-icon             green

--tug-base-tone-warning                   yellow
--tug-base-tone-warning-bg                yellow @ 12% alpha
--tug-base-tone-warning-fg                yellow (or dark variant for light themes)
--tug-base-tone-warning-border            yellow
--tug-base-tone-warning-icon              yellow

--tug-base-tone-danger                    red
--tug-base-tone-danger-bg                 red @ 15% alpha
--tug-base-tone-danger-fg                 red
--tug-base-tone-danger-border             red
--tug-base-tone-danger-icon               red

--tug-base-tone-info                      cyan
--tug-base-tone-info-bg                   cyan @ 12% alpha
--tug-base-tone-info-fg                   cyan
--tug-base-tone-info-border               cyan
--tug-base-tone-info-icon                 cyan
```

### Accent-Derived Interaction Tokens

```
--tug-base-accent-bg-subtle              Accent @ low alpha (selection tint)
--tug-base-accent-bg-emphasis            Accent @ medium alpha
--tug-base-accent-border                 Accent border
--tug-base-accent-border-hover           Intense accent border
--tug-base-accent-underline-active       Active underline (tabs)
--tug-base-accent-guide                  Guide line color (snap)
--tug-base-accent-flash                  Flash effect color
```

---

## Selection / Highlight

```
--tug-base-selection-bg                  Active selection background
--tug-base-selection-bg-inactive         Inactive (dimmed) selection
--tug-base-selection-fg                  Selection text color
--tug-base-highlight-hover               Hover highlight overlay
--tug-base-highlight-dropTarget          Drop target highlight
--tug-base-highlight-preview             Preview highlight
--tug-base-highlight-flash               Flash highlight
```

---

## Field Tokens

Form fields are generic controls (inputs, textareas, selects) with their own state model. These stay in base because they're shared across all field components.

```
Background:
--tug-base-field-bg-rest
--tug-base-field-bg-hover
--tug-base-field-bg-focus
--tug-base-field-bg-disabled
--tug-base-field-bg-readonly

Foreground:
--tug-base-field-fg
--tug-base-field-fg-disabled
--tug-base-field-fg-readonly
--tug-base-field-placeholder

Border (per-state):
--tug-base-field-border-rest
--tug-base-field-border-hover
--tug-base-field-border-focus
--tug-base-field-border-invalid
--tug-base-field-border-valid
--tug-base-field-border-disabled
--tug-base-field-border-readonly

Validation:
--tug-base-field-error                   red
--tug-base-field-warning                 yellow
--tug-base-field-success                 green
--tug-base-field-dirty                   yellow indicator

Meta:
--tug-base-field-label
--tug-base-field-helper
--tug-base-field-required                red asterisk
--tug-base-field-meta
--tug-base-field-counter
--tug-base-field-limit                   red counter at limit
```

---

## Toggle / Range / Checkbox / Radio

These stay in base as generic control primitives.

```
Toggle:
--tug-base-toggle-track-off
--tug-base-toggle-track-on
--tug-base-toggle-track-disabled
--tug-base-toggle-track-mixed
--tug-base-toggle-thumb
--tug-base-toggle-thumb-disabled

Check/Radio:
--tug-base-checkmark
--tug-base-checkmark-mixed
--tug-base-radio-dot

Range:
--tug-base-range-track
--tug-base-range-fill
--tug-base-range-thumb
--tug-base-range-thumb-disabled
--tug-base-range-tick
--tug-base-range-scrub-active
--tug-base-range-label
--tug-base-range-value
```

---

## Scrollbar / Separator / Avatar

```
--tug-base-scrollbar-track               transparent
--tug-base-scrollbar-thumb               border-default color
--tug-base-scrollbar-thumb-hover         border-muted color
--tug-base-separator                     divider color
--tug-base-avatar-bg
--tug-base-avatar-fg
--tug-base-avatar-ring
```

---

## What Components Define (Bespoke Only)

After this proposal, component CSS files should only define tokens that are **genuinely unique to that component** — not derivable from base. Examples:

### tug-card.css

Bespoke: card header active/inactive backgrounds (theme-specific tints), card shadows (compound values), findbar match colors, dim overlay opacity.

References base for: text (→ `--tug-base-element-global-text-normal-default-rest`), button text (→ `--tug-base-element-global-text-normal-muted-rest`), borders (→ `--tug-base-element-global-border-normal-default-rest`), dividers (→ `--tug-base-element-global-divider-normal-default-rest`), hover highlights (→ `--tug-base-surface-highlight-primary-normal-hover-rest`).

### tug-tab.css

Bespoke: tab active bg (specific tint), ghost tab bg/border, drop target colors.

References base for: rest text (→ `--tug-base-element-global-text-normal-subtle-rest`), active text (→ `--tug-base-element-global-text-normal-default-rest`), underline (→ `--tug-base-element-tab-border-normal-active-rest`), badge surface (→ `--tug-base-surface-badge-primary-normal-accent-rest`), badge text (→ `--tug-base-element-global-text-normal-inverse-rest`).

### tug-dialog.css

With the tone system, most dialog/toast/badge/banner tokens collapse to base references:

```css
/* Toast success: just reference the tone */
.toast-success {
  background-color: var(--tug-base-tone-positive-bg);
  color: var(--tug-base-tone-positive-fg);
}
```

Bespoke: skeleton shimmer colors, toast layout structure.

### tug-code.css

100% bespoke — syntax highlighting, terminal ANSI palette, chat message types, file status colors. These are domain-specific and cannot be derived from generic control tokens.

### tug-data.css

Mostly bespoke — chart series palette (8 colors), gauge components. Table/list tokens reference base (row hover → `--tug-base-highlight-hover`, header bg → `--tug-base-surface-sunken`).

---

## Token Count Summary

| Category | Token Count | Change from Current |
|----------|------------|-------------------|
| A. Surfaces | 9 | Same |
| B. Foreground | 12 | Same |
| C. Icons | 5 | Same |
| D. Borders/Dividers/Focus | 11 | Same |
| E. Shadows/Overlays | 9 | Same |
| F. Typography | ~20 | Same |
| G. Spacing | 7 | Same |
| H. Radius | 7 | Same |
| I. Stroke | 4 | Same |
| J. Chrome/Icon Size | 7 | Same |
| K. Motion | ~15 | Same |
| **NEW: Control Surfaces** | ~30 | **Replaces scattered action-* tokens** |
| **NEW: Tone System** | 20 | **Replaces ~40 tone duplicates** |
| Accent System | ~15 | Streamlined |
| Selection/Highlight | ~7 | Same |
| Fields | ~22 | Same |
| Toggle/Range/Check/Radio | ~15 | Same |
| Scrollbar/Sep/Avatar | 7 | Same |
| **TOTAL** | ~222 | Was ~393 in body {} (down ~44%) |

The reduction comes from:
1. Moving component-specific tokens out (card, tab, dock, etc.)
2. Replacing duplicated tone variants with a systematic tone set
3. Consolidating scattered action-* tokens into the control surface system

---

## Implementation Plan

1. **Define the tone system** in tug-base.css (20 new tokens, replace ~40 scattered duplicates)
2. **Define control surface tokens** in tug-base.css (30 new tokens, replace/rename current action-* tokens)
3. **Clean up component files** — replace raw `--tug-color()` values with `var(--tug-base-*)` references where a base token exists
4. **Remove dead component tokens** that are now covered by base
5. **Update theme files** to override the new tone and control surface tokens
6. **Verify** all tests pass, TypeScript clean, visual regression check across themes
