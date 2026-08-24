# The Group Family: radio-group, choice-group, option-group

*Three siblings that each present a collection of buttons with different selection semantics and visual treatments.*

---

## Overview

The group family consists of three components that share a common structure — a labeled collection of interactive items — but differ in selection semantics and display.

| Component | Selection | Display | Status |
|-----------|-----------|---------|--------|
| tug-radio-group | Single, mutually exclusive | Vertical/horizontal list of radio items with circle indicators | Exists |
| tug-choice-group | Single, mutually exclusive | Connected segment strip with sliding indicator pill | Rename from tug-segmented-choice + icon extension |
| tug-option-group | Multiple, independent toggles | Connected row of toggle buttons (like B\|I\|U in a text editor) | New build |

---

## Naming

| Old Name | New Name | Reason |
|----------|----------|--------|
| tug-segmented-choice | **tug-choice-group** | Aligns with the *-group family naming. "Choice" captures single-select semantics. |
| tug-button-group | **tug-option-group** | "Option" captures multi-toggle semantics. Avoids confusion with the internal TugButton. |

The family shares a naming pattern: `tug-{noun}-group`, where the noun describes what each item represents — a radio, a choice, or an option.

---

## Selection Semantics

| Component | ARIA Pattern | Value Type | Constraint |
|-----------|-------------|------------|------------|
| tug-radio-group | `role="radiogroup"` / `role="radio"` | `string` (single value) | Exactly one selected at all times |
| tug-choice-group | `role="radiogroup"` / `role="radio"` | `string` (single value) | Exactly one selected at all times |
| tug-option-group | `role="toolbar"` / `role="checkbox"` or `aria-pressed` | `string[]` (set of values) | Zero or more selected independently |

tug-radio-group and tug-choice-group have identical selection semantics (single, mutually exclusive). They differ only in visual treatment. tug-option-group is fundamentally different: each item toggles independently.

---

## Item Model

All three components define items with a consistent shape, extended for icon support where appropriate.

### tug-radio-group (unchanged)

Items are child `<TugRadioItem>` components with `value` and `children` (label text). No icon support — radio items have the circle indicator in the icon slot.

### tug-choice-group (extended from tug-segmented-choice)

```typescript
export interface TugChoiceItem {
  value: string;
  label?: string;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right" | "both";
  disabled?: boolean;
}
```

- `label` becomes optional (icon-only items are valid)
- `icon` — Lucide icon node
- `iconPosition` — where to place the icon relative to the label
  - `"left"` (default when both icon and label present): icon before label
  - `"right"`: icon after label
  - `"both"`: icon on both sides of label (rare but supported)
- When `icon` is set and `label` is omitted: icon-only segment (must have `aria-label` on the item)

### tug-option-group (new)

```typescript
export interface TugOptionItem {
  value: string;
  label?: string;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right" | "both";
  disabled?: boolean;
  "aria-label"?: string;
}
```

Same item shape as TugChoiceItem. The difference is in how the group manages selection (multi-toggle vs. single-select).

---

## Props Comparison

| Prop | radio-group | choice-group | option-group |
|------|-------------|--------------|--------------|
| `value` | `string` | `string` | `string[]` |
| `defaultValue` | `string` | — (controlled only) | `string[]` |
| `onValueChange` | `(v: string) => void` | `(v: string) => void` | `(v: string[]) => void` |
| `items` | — (children) | `TugChoiceItem[]` | `TugOptionItem[]` |
| `size` | sm / md / lg | sm / md / lg | sm / md / lg |
| `role` | color role | color role | color role |
| `orientation` | horizontal / vertical | — (always horizontal) | — (always horizontal) |
| `disabled` | boolean | boolean | boolean |
| `label` | string (group label) | — | — |
| `animated` | — | boolean (default false) | — |
| `aria-label` | string | string | string |

---

## Display Details

### tug-choice-group (visual changes from tug-segmented-choice)

The core visual treatment stays the same: connected segment strip with indicator pill. The extensions are icon support within each segment and control over indicator animation.

**Indicator animation (`animated` prop):**

The sliding pill transition (160ms transform + width) is currently always on. This should be opt-in:

- `animated?: boolean` — defaults to `false`
- When `false`: the indicator snaps instantly to the selected segment (no transition). The pill is still present and positioned imperatively via ref — it just doesn't animate between positions.
- When `true`: the indicator slides smoothly between segments (current behavior).

Implementation: a CSS class `.tug-choice-group-animated` adds the `transition` rules. Without it, the indicator has `transition: none`. The component applies the class based on the prop.

**Icon layout within a segment:**

```
[icon-left] [label] [icon-right]
     ↑                    ↑
  iconPosition="left"  iconPosition="right"
```

- Icons inherit the segment's text color (same transition on selection)
- Icon size follows the size variant: sm=14px, md=16px, lg=18px
- Icon-only segments get square aspect ratio (like TugButton's icon subtype)
- Segment padding adjusts: icon-only segments get equal horizontal padding; icon+text segments keep label padding with icon gap

**No structural changes** to the sliding indicator, keyboard navigation, or role color injection. Those stay as-is.

### tug-option-group (new visual treatment)

Visually similar to tug-choice-group but with key differences:

- **Connected row**: items share a common border/background frame (like segmented choice)
- **Toggle state**: each item independently shows on/off. On-state uses role color fill (same toggle-primary tokens). Off-state is transparent/ghost.
- **No sliding indicator**: since multiple items can be on, there's no single indicator pill. Instead, each item has its own on-state background.
- **Dividers**: thin vertical dividers between items (suppressed between adjacent on-state items)

**Icon layout** is identical to tug-choice-group.

---

## Shared Patterns — Deep Analysis

Looking at the actual code in tug-radio-group and tug-segmented-choice, there is significant duplication that should be extracted into shared infrastructure. Here's what's duplicated today and what the plan should be.

### 1. ROLE_TOKEN_MAP (identical, duplicated verbatim)

Both components define the exact same map:

```typescript
const ROLE_TOKEN_MAP: Record<string, string> = {
  option: "option", action: "active", agent: "agent",
  data: "data", success: "success", caution: "caution", danger: "danger",
};
```

And both use it identically to build role injection CSS variables:

```typescript
const tokenSuffix = role ? (ROLE_TOKEN_MAP[role] ?? role) : "accent";
```

**Extract to:** `internal/tug-group-utils.ts` — a shared `ROLE_TOKEN_MAP` constant and a `getRoleTokenSuffix(role?: string): string` helper.

### 2. Role type union (identical, duplicated verbatim)

Both components define the same role type:

```typescript
export type TugSegmentedChoiceRole = "option" | "action" | "agent" | "data" | "success" | "caution" | "danger";
export type TugRadioRole = "option" | "action" | "agent" | "data" | "success" | "caution" | "danger";
```

**Extract to:** `internal/tug-group-utils.ts` — a shared `TugGroupRole` type that all three components re-export under their own name (or use directly).

### 3. Role injection style object (same pattern, different variable names)

tug-radio-group builds:
```typescript
{ "--tugx-radio-on-color": `var(--tug7-surface-toggle-primary-normal-${tokenSuffix}-rest)`,
  "--tugx-radio-on-hover-color": ..., "--tugx-radio-disabled-color": ... }
```

tug-segmented-choice builds:
```typescript
{ "--tugx-segment-on-color": `var(--tug7-surface-toggle-primary-normal-${tokenSuffix}-rest)`,
  "--tugx-segment-on-hover-color": ..., "--tugx-segment-disabled-color": ... }
```

The token structure is identical — only the CSS variable prefix differs (`--tugx-radio-*` vs `--tugx-segment-*`).

**Extract to:** `internal/tug-group-utils.ts` — a `buildRoleStyle(prefix: string, role?: string): React.CSSProperties` function. Each component calls `buildRoleStyle("radio", role)` or `buildRoleStyle("segment", role)`.

### 4. TugBox disabled cascade (identical pattern)

All three use:
```typescript
const boxDisabled = useTugBoxDisabled();
const effectiveDisabled = disabled || boxDisabled;
```

This is a two-liner and probably not worth extracting further — the pattern is clear and the import is already shared. Keep as-is.

### 5. Keyboard navigation (same logic, different item types)

Both tug-segmented-choice and tug-option-group (planned) need arrow-key navigation with wrapping. tug-radio-group gets this from Radix for free. The keyboard handler in tug-segmented-choice is ~40 lines of boilerplate:

- Filter to enabled items
- Find current index
- ArrowLeft/ArrowUp → previous (wrap to end)
- ArrowRight/ArrowDown → next (wrap to start)
- Home → first, End → last
- Focus the new item

**Extract to:** `internal/tug-group-utils.ts` — a `useGroupKeyboardNav` hook:

```typescript
function useGroupKeyboardNav(opts: {
  items: { value: string; disabled?: boolean }[];
  value: string | string[];
  onNavigate: (value: string, index: number) => void;
  disabled: boolean;
  itemRefs: React.MutableRefObject<(HTMLElement | null)[]>;
}): (e: React.KeyboardEvent) => void;
```

Returns a `handleKeyDown` callback. tug-choice-group and tug-option-group both use it. tug-radio-group doesn't need it (Radix handles keyboard).

### 6. Item icon rendering (new shared pattern for choice-group and option-group)

Both tug-choice-group and tug-option-group will render items with the same icon layout:

```
[icon-left?] [label?] [icon-right?]
```

This is structurally similar to TugButton's `icon-text` subtype, which renders `icon + children + trailingIcon`. But the group items are not TugButtons — they're plain `<button>` elements (segmented choice) or toggle buttons. The icon layout is simpler than TugButton's full infrastructure.

**Two options:**

**Option A: Compose TugButton** — Each item in choice-group and option-group becomes a TugButton (like radio-group already does). This gets icon rendering for free via TugButton's `icon`, `trailingIcon`, and `subtype` props.

**Option B: Shared render helper** — A `renderGroupItemContent(item)` function that lays out icon + label + trailing icon into spans. Lighter than TugButton but duplicates icon layout logic.

**Recommendation: Option A for option-group, Option B for choice-group.**

Why? tug-choice-group has a sliding indicator pill that positions behind the segments. The segments need to be transparent lightweight buttons — adding TugButton's full emphasis/role/border-radius machinery would fight the indicator's visual design. A simple render helper is cleaner.

tug-option-group items are individual toggle buttons with their own on/off background — exactly what TugButton's ghost emphasis + toggled state provides. Each option item can be a TugButton with `emphasis="ghost"`, matching how TugRadioItem already works.

### 7. Connected container CSS (shared between choice-group and option-group)

Both components render a connected horizontal strip with:
- Shared border/background frame
- Inner padding (2px)
- Size-variant border-radius
- `isolation: isolate` for z-index stacking

The CSS structure is nearly identical. The container rules could share a common `.tug-group-strip` base class, but CSS class sharing across components violates L20 (token sovereignty). Better to keep CSS separate but document the pattern so the two components stay visually aligned.

### Summary: What to Extract

| Artifact | Location | Used By |
|----------|----------|---------|
| `TugGroupRole` type | `internal/tug-group-utils.ts` | radio, choice, option |
| `ROLE_TOKEN_MAP` constant | `internal/tug-group-utils.ts` | radio, choice, option |
| `getRoleTokenSuffix(role?)` | `internal/tug-group-utils.ts` | radio, choice, option |
| `buildRoleStyle(prefix, role?)` | `internal/tug-group-utils.ts` | radio, choice, option |
| `useGroupKeyboardNav(opts)` hook | `internal/tug-group-utils.ts` | choice, option |
| `renderGroupItemContent(item)` | `internal/tug-group-utils.ts` | choice, option |

This consolidation means the three components share one utility file for their common infrastructure, while each component owns its own visual identity (CSS, tokens, data-slot).

---

## Implementation Plan

### Phase 1: Extract shared infrastructure

Create `internal/tug-group-utils.ts` with:

- `TugGroupRole` type
- `ROLE_TOKEN_MAP` constant
- `getRoleTokenSuffix(role?: string): string`
- `buildRoleStyle(prefix: string, role?: TugGroupRole): React.CSSProperties`
- `useGroupKeyboardNav(opts)` hook
- `renderGroupItemContent(item)` helper for icon + label layout

Then refactor tug-radio-group to import from the shared utils:
- Replace inline `ROLE_TOKEN_MAP` and `TugRadioRole` with shared imports
- Replace inline role style construction with `buildRoleStyle("radio", role)`
- Keep everything else (Radix wrapper, radio indicator, context) — those are radio-specific

### Phase 2: Rename tug-segmented-choice to tug-choice-group

Mechanical rename + refactor to shared utils:

- Rename files: `tug-segmented-choice.tsx/.css` → `tug-choice-group.tsx/.css`
- Rename component, types, CSS classes, data-slot, item type
- Replace inline `ROLE_TOKEN_MAP` with shared imports
- Replace inline role style construction with `buildRoleStyle("segment", role)`
- Replace inline keyboard handler with `useGroupKeyboardNav`
- Update gallery card: `gallery-segmented-choice.tsx` → `gallery-choice-group.tsx`
- Update gallery registration and all imports

### Phase 3: Add icon support to tug-choice-group

Extend the renamed component:

- Add `icon`, `iconPosition`, `aria-label` to `TugChoiceItem`
- Make `label` optional (icon-only items valid when `aria-label` present)
- Use `renderGroupItemContent(item)` for icon + label layout in each segment button
- Add CSS for icon sizing (sm=14px, md=16px, lg=18px), gap, icon-only square segments
- Update gallery card with icon examples

### Phase 4: Build tug-option-group

New component using shared infrastructure + TugButton composition:

- `tug-option-group.tsx`:
  - Each item is a TugButton (`emphasis="ghost"`, toggled via `aria-pressed`)
  - `value: string[]` / `onValueChange: (v: string[]) => void`
  - Uses `buildRoleStyle("option", role)` from shared utils
  - Uses `useGroupKeyboardNav` for arrow-key navigation
  - ARIA: `role="toolbar"` on container, `aria-pressed` on each button
- `tug-option-group.css`:
  - Connected row container (same strip pattern as choice-group)
  - Per-item on-state background via role color injection
  - Thin vertical dividers between items (suppressed between adjacent on-state)
- Gallery card: icon-only (B/I/U), icon+text, mixed, sizes, roles

### Phase 5: Update roadmap

- Move tug-segmented-choice to completed (as tug-choice-group)
- Add tug-option-group to completed
- Remove tug-button-group from planned (replaced by tug-option-group)

---

## Dashes

| # | Scope | Description |
|---|-------|-------------|
| 1 | Shared infra | Create `internal/tug-group-utils.ts`, refactor tug-radio-group to use it |
| 2 | Rename | tug-segmented-choice → tug-choice-group (files, types, CSS, imports, gallery) + refactor to shared utils |
| 3 | Icons | Add icon support to tug-choice-group items using `renderGroupItemContent` |
| 4 | Gallery | Update gallery-choice-group with icon examples |
| 5 | Build | tug-option-group component + CSS (composes TugButton, uses shared utils) |
| 6 | Gallery | gallery-option-group card |
| 7 | Refactor | Generalize `useGroupKeyboardNav` to support both single-focus and multi-toggle; refactor option-group to use it |
