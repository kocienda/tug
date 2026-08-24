# Component Quality Roadmap

*Bring every tugways component to world-class quality before scaling to new components.*

---

## Current State

### Audit Results (against component-authoring.md checklist)

| # | Component | Score | Module Doc | Props @selector | forwardRef+data-slot | @tug-pairings | @tug-renders-on | Token Colors | State Order |
|---|-----------|:-----:|:----------:|:---------------:|:-------------------:|:-------------:|:---------------:|:------------:|:-----------:|
| 1A | tug-checkbox | 7/7 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 1B | tug-switch | 7/7 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 1C | tug-input | 5/7 | ✅ | ⚠️ | ❌ | ✅ | ✅ | ✅ | ✅ |
| 2A | tug-button | 6/7 | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| 2B | tug-badge | 4/7 | ✅ | ⚠️ | ❌ | ✅ | ❌ | ✅ | N/A |
| 3A | tug-label | 5/7 | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ |
| 3B | tug-skeleton | 3/7 | ✅ | ⚠️ | ❌ | ⚠️ | ❌ | ✅ | N/A |
| 3C | tug-marquee | 4/7 | ✅ | ⚠️ | ✅ | ✅ | ❌ | ✅ | N/A |
| 4A | tug-card | 6/7 | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| 4B | tug-tab-bar | 6/7 | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| 4C | tug-popup-button | — | ✅ | ✅ | N/A | N/A | N/A | N/A | N/A |
| 4D | tug-popup-menu | 5/7 | ✅ | ✅ | ⚠️ | ? | ? | ✅ | ✅ |

### Key Findings

**Reference implementations:** tug-checkbox and tug-switch score 7/7. Every checklist item satisfied. These are the gold standard for what compliance looks like.

**Common gaps across components:**
- **`@tug-renders-on` annotations** missing from badge, skeleton, marquee
- **`@selector` annotations** incomplete on most components outside checkbox/switch/button
- **`data-slot`** missing or inconsistent, especially on Radix-wrapped roots
- **`forwardRef`** not applied to badge, skeleton, input

**Compositional pattern undocumented:** tug-popup-button has no CSS — it composes TugButton and TugPopupMenu. The authoring guide doesn't address this delegation pattern.

---

## Phase 1: Token-to-Component Contract

*Formalize the rules that checkbox and switch already follow, so every component has the same yardstick.*

### Goal

Update `tuglaws/component-authoring.md` to codify the token-to-component contract. No code changes — pure documentation.

### What to Add

Six additions to the authoring guide, each drawn from patterns that already exist in the reference implementations (tug-checkbox, tug-switch) but aren't yet documented as requirements.

---

### 1. Dual-Format @tug-pairings (Mandatory)

**What exists today:** The authoring guide shows only the compact machine-readable format. Checkbox and switch CSS files actually have *two* formats — a compact block for `audit-tokens lint` and an expanded table for human/agent readability.

**What to add:** Document that both formats are required, and specify the expanded table format with its four columns.

Compact block (machine-readable, what audit-tokens parses):

```css
/* @tug-pairings {
  --tug-element-checkmark-icon-normal-plain-rest  | --tug-surface-toggle-track-normal-on-rest  | control
  --tug-element-field-text-normal-label-rest      | --tug-surface-global-primary-normal-default-rest | content
} */
```

Expanded table (human/agent-readable, documents the CSS context):

```css
/**
 * @tug-pairings
 * | Element                              | Surface                              | Role    | Context                          |
 * |--------------------------------------|--------------------------------------|---------|----------------------------------|
 * | --tug-element-checkmark-icon-...rest  | --tug-surface-toggle-track-...rest   | control | .tug-checkbox-indicator (color)  |
 * | --tug-element-field-text-...rest      | --tug-surface-global-primary-...rest | content | .tug-checkbox-label (color)      |
 */
```

The Context column is the key addition — it tells a coding agent exactly which CSS rule creates the pairing. This is what makes the table actionable: an agent reading the pairings table can navigate directly to the rule that needs attention.

**Components with no contrast pairings** (e.g., skeleton) still open with the annotation:

```css
/* @tug-pairings: none — decorative/animation only, no foreground-on-background contrast */
```

---

### 2. Component-Tier Alias Rules

**What exists today:** tug-card.css defines `--tug-card-*` aliases in `body {}` that resolve to base-tier `--tug-*` tokens. Checkbox and switch use base tokens directly. L17 says "one hop" but doesn't say when to use aliases vs direct tokens.

**What to add:** A decision rule for when to use component-tier aliases:

- **Use base tokens directly** when the component is simple (< 5 token references) and the seven-slot names are clear in context. Checkbox, switch, input, label, badge, skeleton, marquee all use this pattern.
- **Use component-tier aliases** when the component is complex (many sub-parts, many tokens, tokens referenced from multiple CSS rules) and a shorter alias improves readability. Card and tab-bar use this pattern.
- Component aliases are defined in `body {}` at the top of the CSS file, after @tug-pairings and before base styles.
- Every alias must resolve to a base-tier `--tug-*` token in one hop. [L17]

```css
body {
  /* Card aliases — resolve to base tier in one hop [L17] */
  --tug-card-border: var(--tug-element-global-border-normal-default-rest);
  --tug-card-bg: var(--tug-surface-global-primary-normal-overlay-rest);
}
```

---

### 3. @selector Annotations (Strengthened Requirement)

**What exists today:** The authoring guide mentions `@selector` but doesn't mandate it. Checkbox and switch have comprehensive `@selector` annotations on every prop that affects CSS. Badge, label, skeleton, marquee are missing them.

**What to add:** Make the requirement explicit and show the exact patterns from the reference implementations.

**Rule:** Every prop that produces a CSS-targetable state change MUST have a `@selector` annotation. This is the bridge between the TSX API and the CSS — it tells a coding agent exactly which CSS selector to use when styling a prop's visual effect.

Patterns from the reference implementations:

```typescript
/** @selector [data-state="checked"] | [data-state="unchecked"] | [data-state="indeterminate"] */
checked?: TugCheckedState;

/** @selector .tug-checkbox-size-sm | .tug-checkbox-size-md | .tug-checkbox-size-lg
 *  @default "md" */
size?: TugCheckboxSize;

/** @selector :disabled | [data-disabled]
 *  @default false */
disabled?: boolean;

/** @selector [data-role="<role>"]
 *  @default "option" */
role?: TugCheckboxRole;
```

Props that do NOT need `@selector`: callback props (`onCheckedChange`), string data props (`name`, `value`, `aria-label`), and `className` (always passed through to `cn()`).

---

### 4. Compositional Components

**What exists today:** tug-popup-button has no CSS file. It composes TugButton and TugPopupMenu. The authoring guide doesn't address this pattern.

**What to add:** A new "Compositional Components" section in the Component Patterns area.

A compositional component:
- Produces only a `.tsx` file — no `.css` file needed.
- Documents delegation in its module docstring: which child components it renders and which styling responsibilities are delegated.
- Does not need `@tug-pairings` — its children own the pairings.
- Still needs: exported props interface with JSDoc, `data-slot` on the root element, law citations.

```typescript
/**
 * TugPopupButton — Convenience popup button composing TugPopupMenu + TugButton.
 *
 * Styling delegated to TugButton (trigger appearance) and TugPopupMenu (dropdown).
 * No component CSS — this is a pure composition.
 *
 * Laws: [L11] controls emit actions, [L19] authoring guide
 */
```

---

### 5. Effect Plane Token Declaration

**What exists today:** Card overlay tokens use `--tug-effect-card-*` (after the token naming refinement). These carry non-color values (amounts, blend modes) and don't participate in contrast pairing. The authoring guide only covers element/surface pairings.

**What to add:** An `@tug-effects` section in the CSS file header for components that use effect-plane tokens. These are declared separately from @tug-pairings because they don't have element/surface pairing semantics.

```css
/* @tug-effects {
  --tug-effect-card-desat-normal-dim-inactive     | desaturation overlay color
  --tug-effect-card-desat-normal-amount-inactive   | desaturation intensity (0-1)
  --tug-effect-card-wash-normal-dim-inactive       | wash overlay color
  --tug-effect-card-wash-normal-blend-inactive     | wash blend mode
} */
```

Format: `token | description`. No contrast role — effect tokens define parameters, not rendered colors.

Most components will not have effect tokens. This section is only needed when a component uses the `effect` plane.

---

### 6. Module Docstring Law Citations (Updated)

**What exists today:** The authoring guide says to cite laws and decisions. Checkbox and switch cite [L06], [L15], [L16], [L19]. Some older components cite spec references ("Spec S06") that are plan artifacts, not tuglaws.

**What to add:** Standardize the citations. Module docstrings must cite tuglaws (`[L##]`) and design decisions (`[D##]`) only. Plan spec references (`Spec S##`) must be removed — they are implementation history, not governing law. The minimum set for any component:

- [L06] appearance via CSS (all components)
- [L15] token-driven states (interactive controls)
- [L16] pairings declared (components with CSS)
- [L19] component authoring guide (all components)

Plus any component-specific laws (e.g., [L11] for controls that emit actions, [L09] for card composition).

---

### Deliverable

Updated `tuglaws/component-authoring.md` with these six additions. The checklist at the bottom of the guide updated to reference the new requirements. No code changes.

---

## Phase 2: Component-by-Component Audit

*Interactive, one at a time. Edit each component to full compliance with the updated authoring guide.*

### Approach

Step through each component in batch order. For each one:

1. Review against the authoring guide checklist
2. Edit the `.tsx` and `.css` to close all gaps
3. Verify: `bun run build`, `bun run audit:tokens lint`
4. Confirm visually in the Component Gallery
5. Move to the next component

### Work Items

#### Batch 1: Selection/Field Controls

| # | Component | Score | Primary Gaps |
|---|-----------|:-----:|-------------|
| 1A | tug-checkbox | 7/7 | None — validate as reference, move on fast |
| 1B | tug-switch | 7/7 | None — validate as reference, move on fast |
| 1C | tug-input | 5/7 | Missing `data-slot`, incomplete `@selector` annotations |

#### Batch 2: Emphasis x Role Pattern

| # | Component | Score | Primary Gaps |
|---|-----------|:-----:|-------------|
| 2A | tug-button | 6/7 | `data-slot` on Radix Slot-wrapped root |
| 2B | tug-badge | 4/7 | No `forwardRef`, missing `@tug-renders-on`, incomplete `@selector` |

#### Batch 3: Simpler Display Components

| # | Component | Score | Primary Gaps |
|---|-----------|:-----:|-------------|
| 3A | tug-label | 5/7 | Incomplete `@selector`, missing `data-slot`, limited state coverage |
| 3B | tug-skeleton | 3/7 | No `forwardRef`, no formal pairings table, no `@tug-renders-on`, incomplete `@selector` |
| 3C | tug-marquee | 4/7 | Missing `@tug-renders-on`, incomplete `@selector` |

#### Batch 4: Structural/Composition Components

| # | Component | Score | Primary Gaps |
|---|-----------|:-----:|-------------|
| 4A | tug-card | 6/7 | `forwardRef` on main component |
| 4B | tug-tab-bar | 6/7 | `forwardRef` on main component |
| 4C | tug-popup-button | — | Compositional; needs delegation documentation |
| 4D | tug-popup-menu | 5/7 | `forwardRef`, CSS audit needed |

### Deferred

- **tug-hue-strip, tug-color-strip** — theme generator internals, will be redone in a later phase
- **Step 4 interactive build guide components** — new components built after the existing ones are at full quality
- **Phase 8 Radix redesign** — broader architectural work that depends on the component library being solid

---

## Phase 3: Follow-on Planning

*Take stock after the audit is complete, then plan the next wave.*

Deferred until Phase 2 is done. At that point we will know:

- Which patterns emerged during the audit that should feed back into the authoring guide
- Whether the step-4 interactive build guide needs revision given lessons learned
- What the phase-8 Radix redesign scope looks like now that the foundation is solid
- Whether any new laws or design decisions are needed for patterns we discovered
