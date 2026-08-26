# Component Authoring Guide

*How to build a tugways component. Every component follows this guide exactly — no exceptions, no shortcuts. Consistency is the product.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` → [tuglaws.md](tuglaws.md). `[P##]` → [color-palette.md](color-palette.md). `[T##]` → [token-naming.md](token-naming.md). Chain mechanics: [responder-chain.md](responder-chain.md). Action vocabulary: [action-naming.md](action-naming.md).*

---

## Scope Boundary (This Pass)

The current theme simplification pass does **not** rewrite every existing component token contract.

- Keep existing component contracts stable unless a component-level change is explicitly required.
- Do not introduce new ad-hoc theme logic in TSX/JS (no local recipe objects, no derivation helpers, no one-off color math).
- New theme behavior must come from `--tug-*` tokens and CSS cascade only.

---

## Files

Every component produces exactly two files in `components/tugways/`:

```
tug-{name}.tsx    — component implementation
tug-{name}.css    — all styles
```

One component per file pair. No barrel exports, no index files. The file name is the component name in kebab-case with the `tug-` prefix.

### Public vs Internal

Components at the top level of `components/tugways/` are the **public API** — what app code imports directly. Components in `components/tugways/internal/` are **building blocks** — infrastructure composed by other tugways components, not intended for direct use by app code.

```
tugways/
  tug-push-button.tsx    ← public: app code uses this for standalone action buttons
  tug-popup-button.tsx   ← public: app code uses this for dropdown triggers
  tug-checkbox.tsx        ← public: app code uses this
  tug-switch.tsx          ← public: app code uses this
  tug-input.tsx           ← public: app code uses this
  ...
  internal/
    tug-button.tsx        ← building block: composed by TugPushButton, TugPopupButton, TugTabBar
    tug-button.css        ← building block: button styling
```

The directory structure is the signal. A developer scanning `tugways/` sees the components they should use. The `internal/` folder tells them "these are not for you."

**Rules for internal components:**

- Follow all the same authoring rules as public components (docstring, `data-slot`, `@tug-pairings`, `forwardRef`, etc.)
- Module docstring opens with a clear statement: "Internal building block — app code should use [public component] instead."
- Internal components are imported by relative path (`./internal/tug-button`), never from a barrel export
- Public components that wrap an internal component should re-export the types app code needs (e.g., `TugButtonEmphasis`, `TugButtonRole`, `TugButtonSize`)

**When to make a component internal:**

- It provides infrastructure that multiple public components compose (TugButton → TugPushButton, TugPopupButton, TugTabBar)
- App code should never import it directly — there's always a more appropriate public component
- Moving it to `internal/` reduces confusion about which component to choose

Most components are public. Internal components are the exception, not the rule.

---

## TSX Structure

Every `.tsx` file follows this structure in this order:

```
1. Module docstring
2. CSS import
3. Library imports
4. Internal imports
5. Constants
6. Props interface (exported)
7. Component (exported)
8. Sub-components (if any, banner-delimited)
```

### Module Docstring

Opens every file. States what the component does, not how it evolved.

```typescript
/**
 * TugSwitch — Toggle switch with track and thumb.
 *
 * Wraps @radix-ui/react-switch. Supports size variants, inline label,
 * disabled state, and role-based color injection.
 *
 * Laws: [L06] appearance via CSS, [L15] token-driven states, [L16] pairings declared,
 *       [L19] component authoring guide
 * Decisions: [D05] component token naming
 */
```

Rules:
- First line: component name and one-sentence purpose
- Second paragraph: implementation details (what it wraps, what it supports)
- Laws and Decisions: cite every law and decision the component obeys
- No history, no "Phase N", no "replaces X", no spec references from plans

**Standardized citation set:** Every component docstring must cite the minimum set of governing laws:

| Citation | Meaning | Required For |
|----------|---------|-------------|
| [L06] | Appearance changes via CSS/DOM, never React state | All components |
| [L11] | Controls emit actions; responders own state that actions mutate | Any component that dispatches or handles an action |
| [L15] | Token-driven states; color transitions only | Interactive controls |
| [L16] | Every foreground rule declares its rendering surface | Components with CSS |
| [L19] | Component authoring guide | All components |
| [L20] | Token sovereignty — composed children keep own tokens | Compound composition |

Interactive components effectively always cite [L11] because any interactive component either emits an action, handles one, or both. Decorative or layout-only components that do not participate in the chain omit it. Add component-specific laws on top of this minimum (e.g., [L09] for card composition, [L03] when registration timing matters).

**Plan spec references are prohibited.** Docstrings must cite tuglaws (`[L##]`) and design decisions (`[D##]`) only. References like `Spec S04` or `Spec S##` are implementation history from plan artifacts — they are not governing law and must not appear in module docstrings.

### Props Interface

Exported. Extends native HTML element props when wrapping a native element. JSDoc on every non-obvious prop. Use `@selector` to document the CSS selector for stateful props.

```typescript
export interface TugSwitchProps {
  /** Whether the switch is on. @selector [data-state="checked"] */
  checked?: boolean;
  /** Callback when toggled. */
  onCheckedChange?: (checked: boolean) => void;
  /** Inline label text. */
  label?: string;
  /** Visual size. @default "md" */
  size?: "sm" | "md" | "lg";
  /** Semantic role for color injection. No role = accent. @selector [data-role="<role>"] */
  role?: "action" | "agent" | "data" | "success" | "caution" | "danger" | "option";
  /** @selector [aria-disabled="true"] */
  disabled?: boolean;
}
```

Rules:
- Extend `React.ComponentPropsWithoutRef<'element'>` for native wrappers
- Omit and redefine props whose semantics change (e.g., `role`, `size`)
- `@selector` annotations map props to CSS selectors — this is how styling agents find the right hook
- `@default` annotations document defaults

**`@selector` is mandatory for every CSS-targetable prop.** A prop is CSS-targetable if its value affects which CSS selector applies — data attributes, class variants, pseudo-classes. The `@selector` annotation is the bridge between the TSX API and the CSS: it tells a coding agent exactly which selector to write when styling a prop's visual effect.

Patterns from the reference implementations (tug-checkbox.tsx):

```typescript
/**
 * Controlled checked state. Supports true, false, or "indeterminate".
 * @selector [data-state="checked"] | [data-state="unchecked"] | [data-state="indeterminate"]
 */
checked?: TugCheckedState;

/**
 * Visual size variant.
 * @selector .tug-checkbox-size-sm | .tug-checkbox-size-md | .tug-checkbox-size-lg
 * @default "md"
 */
size?: TugCheckboxSize;

/**
 * Disables the checkbox.
 * @selector :disabled | [data-disabled]
 * @default false
 */
disabled?: boolean;

/**
 * Semantic role for the on-state color. Omit for the theme's accent color.
 * @selector [data-role="<role>"]
 */
role?: TugCheckboxRole;
```

Props that do **not** need `@selector`:
- Callback props (`onCheckedChange`, `onClick`, `onChange`)
- String data props (`name`, `value`, `aria-label`)
- `className` — always passed through to `cn()`, no selector needed

### Component

Use `React.forwardRef` for any component that wraps a DOM element or Radix primitive. Name the function explicitly (provides displayName for DevTools).

```typescript
export const TugSwitch = React.forwardRef<HTMLButtonElement, TugSwitchProps>(
  function TugSwitch({ checked, onCheckedChange, label, size = "md", role, disabled, ...rest }, ref) {
    // ...
    return (
      <Switch.Root
        ref={ref}
        data-slot="tug-switch"
        className={cn("tug-switch", `tug-switch-${size}`)}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        {...rest}
      >
        <Switch.Thumb className="tug-switch-thumb" />
      </Switch.Root>
    );
  }
);
```

Rules:
- `data-slot="tug-{name}"` on the root element — always. This is the stable semantic anchor for CSS and tooling.
- `className` via `cn()` (from `lib/utils.ts`) — composes base class, size variant, and caller's className
- Spread `...rest` last to allow prop overrides
- No React state for appearance [L06]. All visual changes via CSS custom properties, classes, or data attributes. **This includes text content in input fields** — see "Input Value Management" below.
- Functional components (no refs needed) skip `forwardRef` but still get `data-slot`

### Code Quality — Common Bugs to Avoid

Components must be high-quality, carefully reviewed code. The following bugs have been found in past audits and must not recur:

**Every caller prop must reach the DOM.** If a prop is destructured, it must be used. A `className` prop that is silently dropped in one code path (e.g., when an optional wrapper is absent) is a bug. Test both branches: with and without optional wrappers like `label`.

**`...rest` must be spread onto the root DOM element.** Without it, callers cannot pass `data-*` attributes, `aria-*` attributes, event handlers, or any other standard HTML attributes. This is not optional — it is required for composability.

**Props interfaces must extend native element attributes.** Use `React.ComponentPropsWithoutRef<'element'>` (or Radix's equivalent) and `Omit` props whose semantics change. Do not manually redeclare props that the base interface already provides (`className`, `id`, `style`, etc.). A closed props interface that lists every prop by hand will always be incomplete.

**Conditional rendering must not create asymmetric behavior.** When a component has two rendering paths (e.g., with-label vs without-label), both paths must handle `className`, `...rest`, and `ref` consistently. If `className` goes on a wrapper in one path, it must go on the root element in the other — never silently dropped.

**Inline `style` must be merged, not replaced.** If a component sets inline styles (width, height, gap), destructure `style` from rest and spread the caller's style into the component's: `style={{ width, height, ...style }}`. Without this, a caller passing `style={{ margin: '10px' }}` silently replaces the component's critical layout styles.

**No dead code, no history comments.** Unused variables, pointless aliases (`const x = y;` where `y` could be used directly), and comments about what was removed ("sub-component removed", "Phase N") are noise. Delete them.

### Input Value Management [L06]

**The text displayed in an input field is appearance.** Switching between a formatted display value ("75%") and a raw edit value ("0.75"), selecting text, and restoring display format after editing — all of this is appearance-zone work. It must go through DOM, not React state.

**Never use React state to manage an input's display/edit cycle.** The standard React controlled-input pattern (`useState` + `value` prop + `onChange`) forces a re-render on every keystroke and on every mode transition. These re-renders kill text selection, can drop keystrokes, and create unnecessary render cycles for what is purely a DOM operation.

**The correct approach:** Use `defaultValue` (not `value`) so React sets the input once at mount, then manage all subsequent value changes imperatively through a ref. Track editing state in a ref, not React state. Sync the display value via `useLayoutEffect` when the external value changes and the input is not being edited. Read the DOM value directly on blur/Enter for validation and commit.

This applies to any component with an editable display that toggles between formatted and raw representations: sliders with value inputs, editable stat cards, inline-editable labels, etc.

**Reference implementation:** `tug-slider.tsx` — the value input demonstrates this pattern.

### Sub-Components

When a component has distinct structural parts (e.g., a group wrapper), define them in the same file, separated by banner comments:

```typescript
/* ---------------------------------------------------------------------------
 * TugRadioItem
 * ---------------------------------------------------------------------------*/

export interface TugRadioItemProps { /* ... */ }

export const TugRadioItem = React.forwardRef<HTMLButtonElement, TugRadioItemProps>(
  function TugRadioItem(props, ref) { /* ... */ }
);
```

---

## CSS Structure

Every `.css` file follows this structure in this order:

```
1. @tug-pairings table
2. Base styles (.tug-{name})
3. Sub-element styles (.tug-{name}-{part})
4. Size variants (.tug-{name}-sm, -md, -lg)
5. State selectors (rest → hover → active → focus → disabled)
6. Variant styles (emphasis × role, validation states, etc.)
```

**Keyboard focus and selection follow the focus language.** A focusable control's focus/selection appearance is not freehand — style it by selecting on the engine attributes (`data-key-view-kbd`, `data-key-cursor`, `data-selected`, `data-default-ring`, `data-key-within`), author the control into a `focusGroup` with a `focusOrder`, and follow the motion/commit rules. See [focus-language.md](focus-language.md) for the full contract.

### @tug-pairings Table

Opens every CSS file. Declares every foreground-on-background relationship the component creates. Machine-readable by `audit-tokens lint`. [L16]

**Both formats are required** — the compact block for tooling, the expanded table for human and agent readability.

**Compact block** (machine-readable — what `audit-tokens lint` parses):

```css
/* @tug-pairings {
  --tug7-element-checkmark-icon-normal-plain-rest  | --tug7-surface-toggle-track-normal-on-rest  | control
  --tug7-element-field-text-normal-label-rest      | --tug7-surface-global-primary-normal-default-rest | content
} */
```

Format: `element-token | surface-token | contrast-role`

**Expanded table** (human/agent-readable — documents the CSS context):

```css
/**
 * @tug-pairings
 * | Element                              | Surface                              | Role    | Context                          |
 * |--------------------------------------|--------------------------------------|---------|----------------------------------|
 * | --tug7-element-checkmark-icon-...rest  | --tug7-surface-toggle-track-...rest   | control | .tug-checkbox-indicator (color)  |
 * | --tug7-element-field-text-...rest      | --tug7-surface-global-primary-...rest | content | .tug-checkbox-label (color)      |
 */
```

The **Context column** is the key addition in the expanded table. It specifies exactly which CSS rule creates the pairing (`selector (property)`). A coding agent reading the pairings table can navigate directly to the rule that needs attention.

**Components with no contrast pairings** (decorative or animation-only components) still open with the annotation so tooling knows the absence is intentional:

```css
/* @tug-pairings: none — decorative/animation only, no foreground-on-background contrast */
```

### @tug-renders-on Annotations

Every CSS rule that sets `color`, `fill`, `stroke`, or `border-color` without setting `background-color` in the same rule must include this annotation: [L16]

```css
/* @tug-renders-on: --tug7-surface-global-primary-normal-default-rest */
.tug-label {
  color: var(--tug7-element-field-text-normal-label-rest);
}
```

### @tug-effects Declaration

Components that use effect-plane tokens (`--tug7-effect-*`) declare them in a separate `@tug-effects` block in the CSS file header, after `@tug-pairings`. Effect tokens carry non-color values — amounts, blend modes, opacity levels — and do not participate in contrast pairing.

```css
/* @tug-effects {
  --tug7-effect-card-desat-normal-dim-inactive     | desaturation overlay color
  --tug7-effect-card-desat-normal-amount-inactive   | desaturation intensity (0-1)
  --tug7-effect-card-wash-normal-dim-inactive       | wash overlay color
  --tug7-effect-card-wash-normal-blend-inactive     | wash blend mode
} */
```

Format: `token | description`. No contrast role — effect tokens define rendering parameters, not rendered colors.

Most components will not have effect tokens. Include this section only when the component uses the `effect` plane.

### Token Usage

All colors come from `--tug-*` tokens. Never hardcode colors. [L15, T##]

```css
/* Correct */
.tug-input { background-color: var(--tug7-surface-field-primary-normal-plain-rest); }

/* Wrong */
.tug-input { background-color: oklch(0.15 0.01 260); }
```

**Tokens must match what they're applied to.** The seven-slot naming system encodes what a token is *for* — the plane (`element` vs `surface`), the constituent (`text` vs `fill` vs `border`), and the component (`control` vs `field` vs `toggle`). A token applied to a CSS property must make semantic sense:

- A control fill or background → use a `surface` token, not an `element` token
- A border → use a `border` token, not a `fill` token
- A checkbox on-state → use a `toggle-primary` surface token, not a `text-muted` element token
- Role-variant fills → use `surface-toggle-primary-normal-{role}-rest`, not `element-tone-fill-*`

**The plane must match the usage.** `element` tokens are foreground marks (text, icons, borders). `surface` tokens are backgrounds. A checkbox fill is a background — it must be a `surface` token. Using an `element-tone-fill` token to color a checkbox background is a plane-level category error, even if the color value happens to look right.

**The component must match the context.** A generic `tone-fill` token is not a toggle control. If the token is being used as a checkbox fill, it should be scoped to `toggle` (the component) with `primary` (the constituent for filled control surfaces). Tokens scoped to the right component can be tuned per-theme without affecting unrelated elements.

If a token's seven-slot name doesn't describe what it's actually styling, the pairing is wrong — even if the color happens to look right. The naming system makes mismatches visible: read the name aloud. "Element tone fill for a checkbox background" sounds wrong because it *is* wrong.

### Component-Tier Alias Rules

Some components define short `--tugx-{component}-*` aliases that resolve to base-tier `--tug7-*` tokens. The decision rule:

- **Use base tokens directly** when the component is simple (fewer than 5 token references) and the seven-slot names are clear in context. Checkbox, switch, input, label, badge, skeleton, and marquee all use this pattern.
- **Use component-tier aliases** when the component is complex — many sub-parts, many tokens, or tokens referenced from multiple CSS rules — and shorter aliases improve readability. Card and tab-bar use this pattern.

When aliases are used, define them in `body {}` at the top of the CSS file, after `@tug-pairings` and before base styles. Every alias must resolve to a base-tier `--tug7-*` token in **one hop**. [L17]

```css
body {
  /* Pane frame aliases (TugPane) — resolve to base tier in one hop [L17] */
  --tugx-pane-border: var(--tug7-element-global-border-normal-default-rest);
  --tugx-pane-bg: var(--tug7-surface-global-primary-normal-content-rest);
}
```

Never chain aliases (`--tugx-pane-bg: var(--tugx-pane-other-alias)`) — that is a second hop and violates [L17].

#### Shared utility: `--tugx-block-*` for block-surface components

For body-kinds (FileBlock, DiffBlock, TerminalBlock, SessionThinkingBlock, the TugMarkdownView code panels) and chrome wrappers (BlockChrome), the shared "block surface" pattern lives at `tugdeck/styles/tugx-block.css` as `--tugx-block-*`. It captures the canonical scaffold once: inset card frame, optional raised chrome variant, code-typography defaults (mono font + sm size + 1.55 line-height), header / footer strip chrome, body row hover overlay, and tone-tinted feedback bands (add / remove / caution / active).

When authoring a body-kind or chrome wrapper, **consume `--tugx-block-*` directly in CSS rules** for the parts that match the shared pattern. Keep `--tugx-{component}-*` slots only for parts that are genuinely component-specific (gutter widths, match-highlight overlays, ANSI palettes, heading scales, etc.).

`--tugx-block-*` is also the substrate for the **block-variant contract** (`BlockVariant` = `tool | receipt | note | data`). A block surface stamps `data-variant` on its root; variant-specific appearance is `--tugx-block-*` overrides scoped under `[data-variant="…"]`, never a render fork (per [L06]/[L20]). `BlockChrome` is the React implementation of the `tool` (default) and `receipt` variants; `SessionThinkingBlock` (`note`) and the markdown-table frame (`data`, an imperative-DOM substrate) adopt the same `--tugx-block-*` + `[data-variant]` contract from their own roots rather than rendering through it. A genuinely distinct variant keeps its own `--tugx-{variant}-*` sub-family for tones the shared slots don't cover (e.g. `note` keeps `--tugx-thinking-*` for its label / preview / italic body / collapse animation).

```css
/* file-block.css — consume the shared block-surface scaffold directly */
.tugx-file {
  background:    var(--tugx-block-bg);
  border:        1px solid var(--tugx-block-border);
  border-radius: var(--tugx-block-radius);
  margin:        var(--tugx-block-margin);
  font-family:   var(--tugx-block-code-font);
  font-size:     var(--tugx-block-code-font-size);
  line-height:   var(--tugx-block-code-line-height);
  color:         var(--tugx-block-text-color);
}
.tugx-file-header {
  padding:    var(--tugx-block-strip-padding);
  gap:        var(--tugx-block-strip-gap);
  background: var(--tugx-block-strip-bg);
  border-bottom: 1px solid var(--tugx-block-strip-border);
  color:      var(--tugx-block-strip-color);
  font-size:  var(--tugx-block-strip-size);
  font-family: var(--tugx-block-strip-font);
}

/* file-block.css body{} — only file-specific slots */
body {
  --tugx-file-gutter-width:   3.5em;
  --tugx-file-mark-bg:        var(--tug7-surface-card-primary-normal-findmatch-rest);
  --tugx-file-mark-active-bg: var(--tug7-surface-card-primary-normal-findmatch-active);
  /* ...other file-specific slots... */
}
```

This is a *shared utility* per `tuglaws/token-naming.md` (`--tugx-` covers "Component aliases, shared utilities. Locally defined."). The shared family lives once in `styles/tugx-block.css` and is imported globally at app root, after the palette + base layers and before any component CSS.

The chrome wrapper variant uses `--tugx-block-chrome-bg` (raised) instead of `--tugx-block-bg` (sunken) since chrome sits *above* the body it wraps:

```css
.tool-block-chrome {
  background:    var(--tugx-block-chrome-bg);  /* raised, not sunken */
  border:        1px solid var(--tugx-block-border);
  border-radius: var(--tugx-block-radius);
  margin:        var(--tugx-block-margin);
}
```

### Enter/Exit Animations [L13, L14]

Components that animate on mount/unmount must choose the correct regime based on **who owns the DOM lifecycle**:

**Library-managed lifecycle → CSS keyframes [L14].** When Radix, Sonner, or another library controls when elements mount and unmount, use CSS `@keyframes` on `[data-state]` or equivalent attributes. The library listens for `animationend` to time its unmount — WAAPI does not fire `animationend`, so TugAnimator would break the library's lifecycle.

- Radix wrappers (tug-alert, tug-popover, tug-accordion, tug-tooltip): CSS keyframes + `[data-state]`
- Sonner wrappers (tug-bulletin): CSS styling of Sonner's DOM

**Self-managed lifecycle → TugAnimator [L13].** When the component owns its own mount/unmount (original components, portal-based components), use `animate()` from TugAnimator. The `.finished` promise sequences post-animation work (unmount portals, remove `inert`, restore focus). Named `key` slots handle rapid open-close-open sequences cleanly.

- Original modals (tug-sheet, tug-banner): TugAnimator with `.finished` for unmount sequencing
- Group coordination: `group()` when multiple elements animate together (overlay fade + content slide)

**Never mix.** Do not use CSS keyframes with manual `animationend` listeners in self-managed components — that's hand-rolling what TugAnimator already provides. Do not use TugAnimator for library-managed lifecycle — that breaks the library's unmount timing.

**CSS still owns static properties.** Even when TugAnimator drives motion, CSS owns position, sizing, z-index, background-color, border-radius — everything that doesn't animate. Only the motion properties (transform, opacity) move to WAAPI.

### State Selectors

States progress in a consistent order. Interactive controls lighten progressively: rest (darkest) → hover → active (lightest). [L15]

```css
.tug-button { /* rest */ }
.tug-button:hover { /* hover */ }
.tug-button:active { /* active */ }
.tug-button:focus-visible { /* focus ring */ }
.tug-button:disabled,
.tug-button[aria-disabled="true"] { /* disabled */ }
```

Radix components use `[data-state="checked"]`, `[data-state="open"]`, etc. Combine with interaction states:

```css
.tug-switch[data-state="checked"]:hover { /* checked + hovered */ }
```

### Naming Convention

- Block: `.tug-{name}` — root element
- Part: `.tug-{name}-{part}` — sub-elements (thumb, indicator, track, label)
- Size: `.tug-{name}-{size}` — sm, md, lg
- Variant: `.tug-{name}-{emphasis}-{role}` — for emphasis × role components

---

## Chain Integration

Every interactive component participates in the responder chain. The chain is the single mechanism by which user gestures reach the code that owns the state they affect — keyboard shortcuts, button clicks, context menu items, Swift-menu RPCs, and gallery-inspector dispatches all funnel through the same dispatch/walk/handle cycle.

This section is the component-author's how-to. It tells you which hooks to call, which props to add (and which to refuse to add), and which attributes to write on your root element. It does not explain the chain's mechanics — the walk, the first-responder promotion, the two-phase continuation protocol, the observer pattern — those live in [responder-chain.md](responder-chain.md). Read that document once before writing a chain-participant component for the first time, then use this section as the recurring reference.

### Is your component a control, a responder, or both?

Ask one question: **does this component own the state that the action is going to mutate?** [L11]

- **No** — the state lives elsewhere (parent, store, separate component). Your component is a *control*. It dispatches an action and lets the chain find the responder. Buttons, sliders, toggles, selects, tab bars, accordions, and popup menus are controls. Most components are.

- **Yes** — the state lives inside your component and nowhere else. Your component is a *responder* for that action. It registers a handler that mutates its own state. Text editors, cards, canvases, dialog surfaces, and property stores are responders.

- **Both** — the action's state lives inside your component, AND your component also emits the action from its own internal UI. A text editor with a built-in context menu is the classic both-shape: the "Cut" menu item dispatches `cut`, the chain walks back to the editor (because it's the first responder), and the editor's registered `cut` handler runs on its own selection. Both shapes are not unusual — they are the norm for self-contained widgets with their own action surfaces.

The three shapes use different hooks: `useControlDispatch` for emitting (controls), `useResponder` / `useOptionalResponder` for registering (responders). Components that are only controls skip the registration; components that are only responders skip the dispatch; "both" components do both in the same file.

### Emitting an action (controls)

Controls use `useControlDispatch` — targeted dispatch to the parent responder.

```tsx
import { useControlDispatch } from "@/components/tugways/use-control-dispatch";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";

export function TugCloseButton({ ariaLabel }: TugCloseButtonProps) {
  const controlDispatch = useControlDispatch(); // null-safe — no-op outside a provider

  const handleClick = () => {
    controlDispatch({
      action: TUG_ACTIONS.CLOSE,
      phase: "discrete",
    });
  };

  return <button type="button" aria-label={ariaLabel} onClick={handleClick}>×</button>;
}
```

The hook reads the parent responder ID from context and calls `sendToTarget(parentId, event)`. The action goes directly to the parent handler regardless of the first responder. Outside a provider the dispatch is a no-op (returns `false`).

**Why targeted dispatch?** Controls have a specific receiver — their parent responder. The nil-targeted `sendToFirstResponder()` walks from the first responder, which may be a sibling or descendant of the parent. Targeted dispatch bypasses the first responder entirely and always reaches the handler. See [responder-chain.md § Dispatching from a control](responder-chain.md#dispatching-from-a-control) for the full rationale.

Rules:

- **Controls never call `manager.sendToFirstResponder()`.** Always use `useControlDispatch()`. The nil-targeted `sendToFirstResponder()` is reserved for keyboard shortcuts and menu items.

- **Callback props for user interactions are prohibited.** [L11] A `TugCloseButton` must NOT expose an `onClose: () => void` prop. The close action routes through the chain; a callback prop lets the consumer bypass the chain and breaks keyboard shortcuts, first-responder semantics, and observer notification. Non-user-interaction callbacks (state mirror callbacks like `onOpenChange` for Radix integration, lifecycle observers) are fine.

- **Sender id for multi-control forms.** Controls that might coexist with siblings dispatching the same action supply a stable opaque sender id so handlers can tell them apart. Default is `useId()`; expose an optional `senderId?: string` prop so tests can override.

- **Always the constant, never the raw string.** `action: TUG_ACTIONS.CLOSE`, not `action: "close"`. See [action-naming.md](action-naming.md).

**Form-shaped shortcut.** Components built on form patterns (inputs, toggles, radios, choice groups, tab bars, accordions, popup buttons) should use `useResponderForm` instead of hand-rolling `useResponder` with narrowing. The form hook exposes typed slot callbacks (`toggle`, `setValueNumber`, `selectValue`, `selectTab`, etc.) that narrow `event.value` at the slot boundary and call your setter with the already-typed value. This is the dominant pattern; reach for it whenever the component fits one of the existing slot shapes. See `use-responder-form.tsx` for the slot catalog.

### Handling actions (responders)

Register with `useResponder` (strict) or `useOptionalResponder` (tolerant). Both return a stable `ResponderScope` wrapper and a stable `responderRef` callback. Wrap your subtree in the scope, attach the ref to your root DOM element, and supply a typed `actions` map.

```tsx
import { useResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";

export function TugCard({ cardId, ... }: TugCardProps) {
  // Handlers read state through refs, not stale closures. [L07]
  const handleClose = useCallback(() => { /* ... */ }, [/* ... */]);
  const handleSelectAll = useCallback(() => { /* ... */ }, [/* ... */]);

  const { ResponderScope, responderRef } = useResponder({
    id: cardId,
    actions: {
      [TUG_ACTIONS.CLOSE]:      (_e: ActionEvent) => handleClose(),
      [TUG_ACTIONS.SELECT_ALL]: (_e: ActionEvent) => handleSelectAll(),
      [TUG_ACTIONS.CLOSE_TAB]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;   // narrow defensively
        handleCloseTab(event.value);
      },
    },
  });

  return (
    <ResponderScope>
      <div
        data-slot="tug-card"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        {/* card content */}
      </div>
    </ResponderScope>
  );
}
```

Rules:

- **`id` must be stable across renders.** Re-registering the responder on every render churns the chain's node map and breaks first-responder tracking. The id typically comes from the component's domain identity (`cardId` from the layout store), from `useId()` for a standalone leaf, or from an explicit prop for test harnesses.

- **`responderRef` attaches to the root DOM element.** The hook writes `data-responder-id="<id>"` on the element; the chain's pointerdown/focusin DOM walk reads that attribute to resolve "the innermost responder under this event target." Without the ref, the manager logs a console warning — `first responder "<id>" has no matching [data-responder-id] element`. Fix the warning by wiring the ref; do not silence it.

- **`<ResponderScope>` wraps the subtree** whose descendants should treat this node as their parent responder. Descendants calling `useResponder` see the scope's id through `ResponderParentContext` and register with that id as their `parentId`. Without the wrapper, descendant `parentId`s skip over this node and the walk order collapses.

- **Handlers read current state through refs.** [L07] `useResponder` registers once at mount and uses a live proxy to pick up handler *identity* changes on re-render, so forgetting to `useCallback`-wrap your handlers is fine. But if the handler *body* closes over a stale state snapshot (`const [tabs] = useState(...)`, handler reads `tabs`), you will see stale values. Use a ref (`tabsRef.current`) for any state the handler reads at dispatch time. This is the most common chain bug in PRs.

- **Narrow `event.value` defensively.** The `value` field is typed `unknown` because the same action name may carry different payload shapes across control instances. Use `typeof`, `Array.isArray`, or a structural field check at the top of the handler and early-return on mismatch so an out-of-shape dispatch is a silent no-op, not a runtime crash.

### `useResponder` vs `useOptionalResponder`

Both hooks have the same signature and return shape. The difference is what they do when no `ResponderChainProvider` is in scope.

- **`useResponder` throws** if the manager context is null. Use it when chain participation is load-bearing — `TugCard`, `DeckCanvas`, `TugPromptInput`, anything whose actions must be routable for the app to function. A missing provider is a programming error; the throw catches it at mount instead of letting the component silently no-op.

- **`useOptionalResponder` silently no-ops** when the manager is null. The hook still runs (returns a stable `ResponderScope` and `responderRef`), but the layout effect skips register/unregister, the ref skips writing `data-responder-id`, and the component falls through to its standalone behavior. Use it for leaf controls that must render in both contexts: inside the app (chain-connected) and standalone in previews, unit tests, or Storybook-style mounts.

**Decision rule:** if rendering without a provider is a programming error, use `useResponder`. If it's a supported configuration (tests, previews, pre-provider mounts), use `useOptionalResponder`. Never mix them in the same component. The tolerant hook exists specifically because the old "split into `TugXxxPlain` and `TugXxxWithResponder`" pattern flipped React's component identity on provider transitions and destroyed caret position, focus, and uncontrolled input state — see the long commentary in `use-responder.tsx` for the scenario it was added to fix.

### Chain-reactive dismissal (`observeDispatch`)

Transient UIs — context menus, popup menus, tooltips, non-modal popovers, confirm popovers — dismiss themselves whenever unrelated chain traffic flows past. Subscribe to `manager.observeDispatch` while open, close in the observer callback, and guard self-dispatches with a `blinkingRef`.

```tsx
const blinkingRef = useRef(false);
const [open, setOpen] = useState(false);
const manager = useResponderChain();

useLayoutEffect(() => {
  if (!open || !manager) return;
  return manager.observeDispatch(() => {
    if (blinkingRef.current) return;  // skip self-dispatches
    setOpen(false);
  });
}, [open, manager]);
```

- **Subscribe only while open.** The effect is gated on the open flag so the observer is installed exactly when the UI is visible.
- **Guard self-dispatches.** A menu that dispatches its own item activation triggers the chain walk, which fires every observer — including its own. Set `blinkingRef.current = true` before the activation dispatch and check it at the top of the observer callback. Without the guard, the menu dismisses itself mid-animation.
- **Modal surfaces opt out.** `TugAlert` and `TugSheet` do NOT install `observeDispatch` observers — they are app-modal and card-modal respectively, and closing on any chain activity would surprise users. `internal/floating-surface-notes.ts` is the canonical invariants table for the four A2.8 floating surfaces; consult it before adding or removing an observer on a floating surface.

See [responder-chain.md § observeDispatch patterns](responder-chain.md#observedispatch-patterns) for the full precedent.

### No `makeFirstResponder` in component code

First responder is managed by the chain. The document-level pointerdown and focusin listeners installed by `ResponderChainProvider` promote the innermost registered responder under the event target automatically — components do not need to call `manager.makeFirstResponder(id)` to become first responder on click or focus.

The only sanctioned programmatic promotion is `DeckCanvas` promoting a freshly-opened card, where no pointer or focus event has fired yet. If you think your component needs `makeFirstResponder`, stop and ask — you are almost certainly fighting the chain for control of first-responder state and papering over a layering bug. The correct answer is almost always "wire `responderRef` correctly and let the chain's promotion listeners do their job."

### Bringing DOM focus along: `focusResponder` and the substrate `focus` callback

`manager.focusResponder(id)` is distinct from `makeFirstResponder` — it both promotes `id` to first responder AND restores DOM focus to the responder's element. Use it (sparingly, and only outside the standard pointerdown/focusin promotion paths) when you genuinely need both. Canonical consumers: a popup-class primitive's close handler restoring focus to the responder that owned it before the popup opened (the service-popup binding does this internally); a chain-driven workflow that needs the keyboard caret to land on a newly-promoted responder.

If your component owns a non-trivial focus surface (a CodeMirror editor, a contentEditable host, a shadow-DOM-rooted custom widget), supply a `focus?: () => void` option at responder registration so `focusResponder(id)` lands DOM focus on the right element. Generic responders (text inputs, buttons, generic containers) omit the callback and the chain's DOM-walk fallback finds the first tabbable descendant correctly. The callback is structural — captured at registration like `kind` / `canHandle` — not a live-proxy.

```tsx
const viewRef = useRef<EditorView | null>(null);

const { responderRef, ResponderScope } = useOptionalResponder({
  id: editorId,
  actions: { /* ... */ },
  // Substrate knows how to focus itself correctly: view.focus() lands on
  // view.contentDOM, which is what generic el.focus() wouldn't necessarily find.
  focus: () => viewRef.current?.focus(),
});
```

Reading `.current` from inside the callback (rather than closing over a value directly) makes the callback robust to Fast Refresh re-mount and StrictMode double-mount where the substrate identity may have been swapped between registration and invocation.

See [responder-chain.md § Bringing DOM focus in sync with chain state](responder-chain.md#bringing-dom-focus-in-sync-with-chain-state--focusresponderid) for the full mechanism.

### Migration pattern — callback prop → chain dispatch

When retrofitting an existing component that uses a callback prop to emit a user action, the mechanical pattern is:

**Before** — callback prop (L11 violation):
```tsx
export interface TugCloseButtonProps {
  onClose: () => void;  // ❌ callback for a user interaction
  ariaLabel: string;
}

export function TugCloseButton({ onClose, ariaLabel }: TugCloseButtonProps) {
  return <button onClick={onClose} aria-label={ariaLabel}>×</button>;
}

// Consumer:
<TugCloseButton onClose={() => deleteCard(cardId)} ariaLabel="Close" />
```

**After** — chain dispatch + responder handler:
```tsx
// Control: dispatches through the chain, no callback prop.
export interface TugCloseButtonProps {
  ariaLabel: string;  // ← onClose is GONE
}

export function TugCloseButton({ ariaLabel }: TugCloseButtonProps) {
  const manager = useResponderChain();
  return (
    <button
      onClick={() => manager?.dispatch({ action: TUG_ACTIONS.CLOSE, phase: "discrete" })}
      aria-label={ariaLabel}
    >×</button>
  );
}

// Responder (the card): registers a handler for close.
export function TugCard({ cardId }: TugCardProps) {
  const handleClose = useCallback(() => deleteCard(cardId), [cardId]);
  const { ResponderScope, responderRef } = useResponder({
    id: cardId,
    actions: {
      [TUG_ACTIONS.CLOSE]: (_e: ActionEvent) => handleClose(),
    },
  });
  return (
    <ResponderScope>
      <div data-slot="tug-card" ref={responderRef as (el: HTMLDivElement | null) => void}>
        <TugCloseButton ariaLabel="Close card" />  {/* no callback prop */}
        {/* card content */}
      </div>
    </ResponderScope>
  );
}

// Consumer: just renders the card. The close logic lives inside the card.
<TugCard cardId="card-1" />
```

Three things change:

1. The button's `onClose` prop is deleted. The button dispatches the action directly.
2. The state owner (the card) registers a handler for the action. The handler runs the logic that used to be inside the consumer's callback.
3. The consumer stops passing a callback. It just renders the card; the card owns its close behavior.

The migration is a one-way door. Once `close` is a chain action, no part of the codebase should try to route it through a callback prop again — the responder is the single owner of "what does close mean for this card."

This is the pattern the A2 phases followed for every interactive control in the library (A2.1 through A2.8). Real worked examples in the commit history: see `git log --grep='A2\.' tugdeck/` for the per-control migrations and their test files.

---

## Text content

**CodeMirror 6 is the canonical engine for any file-based text content.** Two React shells expose it to the rest of the codebase, and one of them is what you compose:

- **`TugTextEditor`** — the editing surface. Owns document mutation, caret, selection, atom decorations, history, clipboard filters, drop handling, completion providers, the editing-action responder vocabulary. Compose this when the user types or pastes into the surface.
- **`TugCodeView`** — the read-only sibling. Owns nothing mutable — `value` flows host → view, never back. Compose this when the user reads source bytes the host hands it: file viewers (`FileBlock`), code fences in rendered markdown, diff context lines, fixture panels in galleries.

Both share the same CM6 substrate: line wrapping (`EditorView.lineWrapping`), the line-numbers gutter, the search panel (`@codemirror/search`), the `Compartment`-based reconfiguration pattern, and the shared theme contract (the inline `EditorView.theme(...)` extension that reads from `--tugx-block-*` for code typography). Future surface-level concerns — syntax highlighting, language extensions, bracket matching, code folding — land on the substrate once and both shells inherit.

**Do not roll a bespoke text-display renderer.** Per-line `<div>` trees with `overflow-x: auto`, `<pre>` blocks with manual scrolling, hand-rolled Cmd-F search overlays, imperative match-highlight DOM mutation — all of these reimplement features the substrate already provides, and they reimplement them with the per-line scrollbars, the stale-overlay alignment bugs, and the keyboard-shortcut drift that motivated this rule. The cost of CM6 is paid once (it ships with the editor); every additional consumer pays nothing.

Concretely, when composing:

```tsx
// File viewer — read-only.
<TugCodeView
  value={file.content}
  language={detectLanguage(file.filePath)}
  wrap
  lineNumbers
/>

// Editing surface — full editor.
<TugTextEditor
  // ... the editor's prop set ...
/>
```

When the substrate needs something it doesn't yet provide (e.g. a particular language grammar, a custom decoration extension), the work lands as a CM6 extension shared between both shells — not as a parallel renderer.

---

## Pin-stack composition — `--tugx-pin-stack-top`

When the Dev transcript scrolls, a tower of sticky chrome can pin simultaneously: the entry header (Claude / model / timestamp), the wrapper-chrome header (Read / Edit / Bash identity), a body kind's identity header (file path / diff stats / terminal label), and inside a diff the per-hunk header bands. These bars must **stack**, not overlap — each one pins flush below the bar above it.

The composition rule is a single CSS variable propagated through the cascade.

**`--tugx-pin-stack-top`** — written by `TugTranscriptEntry` onto the entry root via a `useLayoutEffect` + `ResizeObserver` on its `__pin` element (the single sticky wrapper carrying the icon and attribution header — one sticky per entry, so each row contributes one compositing-overlap candidate, not two). The value is the live measured height of that pinned block. Descendant sticky chrome consumes it as the top offset:

```css
.tugx-file-header,
.tugx-diff-header,
.tugx-term-header,
.tugx-md-fenced-code-header,
.tool-block-chrome-header {
  position: sticky;
  top: var(--tugx-pin-stack-top, 0);
  z-index: 1;
}
```

When no transcript entry is present (gallery cards, ad-hoc consumers, the `RenderInput`-routed Markdown surface), the variable is unset and the `calc()` fallback to `0` takes effect — the bar simply pins to the top of its own scrollport.

Deeper-tier bars compose the same way through additional component-owned variables:

- **`--tugx-block-header-height`** — written by `BlockChrome` on its root from a ResizeObserver on `.tool-block-chrome-header`. Sticky descendants inside the chrome (a diff's hunk header) read it so they pin BELOW the chrome header.
- **`--tugx-diff-header-height`** — written by `DiffBlock` on its root from a ResizeObserver on the standalone-mode identity header (unset when embedded mode suppresses the header). Sticky descendants inside the body kind (`DiffBlock`'s hunk headers) read all three pin-stack variables in a single calc:

```css
.tugx-diff-hunk-header {
  position: sticky;
  top: calc(
    var(--tugx-pin-stack-top, 0px)
    + var(--tugx-block-header-height, 0px)
    + var(--tugx-diff-header-height, 0px)
  );
  z-index: 0;
}
```

The `0px` fallback in each `var()` is load-bearing — without it the entire calc resolves to nothing when ONE variable is unset, and the bar mispins. Always use `var(--name, 0px)`, never `var(--name, 0)`.

### Token categories — three kinds, three different sovereignty rules

The seven-slot system (`surface`, `element`, etc.) covers **appearance tokens**: the values that drive theming and contrast pairings. [L20] guards them — A's CSS doesn't reach into B's slot family. But two other token categories exist alongside, and they intentionally cross slot boundaries:

1. **Appearance tokens** (`--tug7-*`, `--tugx-{component}-*`, `--tug-color-*`, etc.). Owned by one component or theme tier. Tuned per theme. Subject to [L20]: only the owner declares + consumes. Cross-slot reads forbidden.

2. **Position-coordination tokens** (`--tugx-pin-stack-top`, `--tugx-block-header-height`, `--tugx-diff-header-height`, etc.). The pin-stack is the canonical example. Not appearance — they don't drive color, typography, or contrast pairings. They describe **the geometry of a parent that descendants need to know** so they can compute their own sticky `top` offset. The chrome writes its measured header height; the body kind reads it. Single writer, many readers, no overrides.

3. **Component-metric tokens** (`--tug-button-{2xs,xs,sm,md,lg}-{height,padding-inline,font-size,icon-size}`, etc.). A component publishes its own per-variant geometry constants so sibling components that need to match — without composing the component themselves — can. The canonical example is `enhanceFencedCode`'s imperative Copy button, which can't mount a React `TugPushButton` but must read as one visually. The metric tokens keep its sizing in lockstep with `TugButton size="2xs"` so a future button-geometry change propagates automatically instead of drifting behind a comment.

The distinguishing tests:

- *Does a theme tune this value to change how the component looks?* If yes, it is an appearance token and [L20] applies — keep it inside the owning component's slot family.
- *Is the value the live measured geometry of a parent that descendants need to know to place themselves?* If yes, it is a position-coordination token. Single writer (the parent's React effect), many readers, no overrides.
- *Is the value a static per-variant geometry constant another component might need to match?* If yes, it is a component-metric token. Single writer (the component's own CSS), many readers, no overrides — the same single-writer invariant as position-coordination tokens, but published statically in CSS rather than written dynamically from a `ResizeObserver`.

Categories 2 and 3 are NOT subject to [L20]'s "A's CSS references only A-scoped tokens" rule. They are explicit publish/subscribe contracts that cross component boundaries by design. A body kind never declares `--tugx-block-header-height: 32px` in its own CSS, and a fenced-code renderer never declares `--tug-button-2xs-height: 1rem` — they only consume the values the owners publish. That is the actual [L20] invariant for these categories: **single writer, many readers, no overrides**.

### Body-kind affordance hosting

Resting affordances (Copy, fold cue, view-mode toggle) do **not** get their own sticky strip. They live as a `flex: 0 0 auto` cluster (`.tugx-{kind}-actions-cluster` carrying `data-slot="{kind}-actions"`) at the trailing edge of the identity header (`.tugx-{kind}-header`) in standalone composition, or portal into `BlockChrome`'s actions slot (`.tool-block-chrome-actions[data-slot="tool-block-actions"]`) in embedded composition.

The portal mechanism is React-side, not DOM-side: `BlockChrome` renders a `<div ref={setActionsTarget}>` inside its header, publishes the DOM node via `ChromeActionsTargetContext`, and a body kind composed under it reads the context via `useChromeActionsTarget()`. When `embedded={true}` and the context returns a non-null target, the body kind `createPortal`s its affordance cluster into the chrome's slot. This keeps affordance state (fold collapsed-set, view-mode toggle) entirely inside the body kind while placing the rendered affordance node in the chrome subtree where it belongs for layout and sticky-pin coverage.

Content blocks render no text-entry UI of their own — no per-block Find row. A card has at most one text-entry surface (see [Focus in content-owning cards](#focus-in-content-owning-cards)); for a session card that is the engine's `tug-prompt-entry`.

**Authoring rules:**

1. **Writers** — components that produce pin offsets — own a token in their slot family (`--tugx-{component}-header-height`) and write to it from `useLayoutEffect` + `ResizeObserver`. Per [L03] the registration runs before paint; per [L06] the write is to DOM via `element.style.setProperty`, never to React state. Do **not** write `--tugx-{component}-actions-height` tokens — the dedicated actions row pattern was retired in Step 10.9 Phase D in favor of a one-row trailing-cluster shape.
2. **Readers** — sticky descendants — consume the chain via `calc(var(...) + var(...) + ...)`. Each reader knows which writers it composes underneath. Adding a new level means adding a writer + a token, and extending the calc on every descendant that pins under it.
3. **Background** — every sticky element needs an opaque background or body content bleeds through. Bind to a theme-aware token (typically `--tugx-block-strip-bg` for block-level chrome or a component-local `--tugx-{component}-header-bg` for primitives) rather than transparent or near-transparent values.
4. **Container** — sticky binds to the nearest scroll-container ancestor. `overflow: hidden` on an ancestor traps sticky inside that ancestor (which doesn't scroll); use `overflow: clip` when you only need rounded-corner clipping without forming a scroll container.
5. **Scroll container padding** — `padding-block` on the scroll container shifts the sticky pin reference inward by that amount (CSS Position 3 §6.5.1 — sticky `top: 0` pins to the content-box edge). Restore breathing room with `::before` / `::after` pseudo-element children or with margin on the first/last cell, never with container `padding-block`.
6. **Affordance components are Tug primitives.** Resting affordances inside an actions cluster MUST be `TugIconButton`, `TugPushButton`, `TugCheckbox`, etc. — never raw `<button>` elements with bespoke CSS. The `tugx-{kind}-{name}` legacy class names may be forwarded onto the Tug components as `className` for scoping and stable test selectors, but appearance flows through the Tug components' own `--tug-button-*` (etc.) slots, not through component-local rules that re-implement button chrome. Imperative-DOM rendering paths (e.g. `enhanceFencedCode`, which can't easily mount React) may use raw `<button>` markup, but the visual treatment must match the Tug primitive equivalent (ghost emphasis at xs/sm size, icon-text shape) so the cluster reads consistently across mount strategies.
7. **Button shapes are invariant across states.** A button that toggles between `subtype="icon"` and `subtype="icon-text"` between states moves the click target out from under the user's pointer. Always pick one shape and keep it. When state needs to flow into the rendered chrome (chevron direction, label verb), the icon and the label STRING swap but the subtype does not. Use `TugButton`'s `confirmation` prop for post-click flashes (e.g. Copy → Copied) rather than a class-swap that hides one structure and reveals another.
8. **Affordances stay visible across body-state changes.** When a body kind has a fold state (collapsed / expanded), don't add or remove affordance buttons between states. Render them all in both states; `disabled` the ones whose target isn't present (e.g. Copy on a collapsed file — the substrate isn't mounted, so there's nothing to copy, but the button stays in place so the trailing-cluster geometry doesn't grow or shrink). The cluster width and the header height stay invariant; only individual buttons enable/disable.

---

## Component Patterns

### List rows — compose `TugListRow`

Any component that renders a `TugListView` (a picker, a listing sheet, a
tool-output block) follows the [list-view-usage.md](list-view-usage.md) house
rules: cell renderers compose `TugListRow` (never hand-rolled row `<div>`s),
consumers never reimplement the selection / hover / disabled ramp in their own
CSS, single-select lists use `selectedGlyph`, and read-only listings pass
`interactive={false}`. That doc carries the consumer inventory, the
selection-ownership matrix, and the list of sanctioned custom-cell exceptions.

### Controlled feedback states (e.g. async confirmation)

For UI feedback whose validity depends on an asynchronous outcome — Copy showing "Copied" only after the clipboard actually accepted the write, Save flashing "Saved" only after the server returned 2xx, Delete confirming only after the row is gone. The component exposes a controlled prop that the parent flips after the operation resolves. False-positive feedback is the bug this pattern exists to prevent: a button that flashes "Copied" on every click — even when permission was denied — silently lies about state, and the user trusts the lie.

**When to use:** Buttons or surfaces with a confirmation/feedback state whose truthfulness depends on async success. Synchronous feedback (hover, focus, press) is appearance-zone CSS and doesn't need this pattern.

**Implementation:**
- The component supports BOTH an uncontrolled timer-based mode (default — for cases where every click is treated as success) and a controlled mode (opt-in via a boolean prop like `isConfirming`).
- Uncontrolled: a `confirmation` prop carries the icon/label/duration; clicking enters the confirmed state for `duration` ms via an internal timer; the DOM mutation lives in the primitive ([L06] appearance-zone, driven via `data-tug-confirming` and CSS visibility rules, not React state).
- Controlled: the parent provides `isConfirming` as a boolean prop. `true` enters the confirmed state, `false` exits it. The internal timer is bypassed; the parent owns the entire lifecycle. Use this when the parent has async information the component can't see — clipboard `.then()`, fetch resolution, store-write confirmation.
- A `useLayoutEffect` keyed on the controlled prop writes `data-tug-confirming` directly into the DOM ([L03] before paint; [L06] CSS-driven swap rather than React state churn).
- The two modes are mutually exclusive: providing both `confirmation.duration` and `isConfirming` is a programming error. Dev-mode `console.warn` flags the conflict so the author catches it at mount.

**Confirming is NOT a disabled state (Phase E.3).** Do not set `aria-disabled="true"` while the confirming attribute is on. Two reasons:

1. Project rest-state hover/active CSS rules use `:not([aria-disabled="true"])` exclusions to suppress interactive styles for chain-disabled buttons. Setting `aria-disabled` during confirming would trigger those same exclusions and suppress the button's hover background while the user holds the cursor over it through the "Copied" flash — exactly the regression Phase E.3 fixed.
2. The cascade then fights itself: a sibling `[aria-disabled="true"][data-tug-confirming="true"]` override has to cancel the disabled dimming and cursor, which works for paint but leaves `:hover` matching broken because attribute-based exclusions don't re-evaluate without pointer motion.

**Click suppression during confirming uses the JS `confirmingRef` guard, not DOM attributes.** The click handler returns early when `confirmingRef.current === true`. No `aria-disabled`, no `pointer-events: none` — `:hover` continues to match because the geometric hit-test is unchanged.

**Hover companion rules are required.** Every emphasis-role that paints a confirming background must also declare a `[data-tug-confirming="true"]:hover` companion rule at equal-or-greater specificity than the rest-hover rule. The rest-hover rule uses 4-class specificity (e.g. `.tug-button-ghost-action:hover:not(:disabled):not([aria-disabled="true"])`), so the companion uses an equal 4-class specificity (`.tug-button-ghost-action[data-tug-confirming="true"]:hover:not(:disabled)`) and appears AFTER the rest-hover rule in source order. The composite background blends the confirming surface with a small fraction of the hover overlay via `color-mix` so the user reads "still confirming, still hovering."

**The revert edge needs a selector-flush nudge.** WebKit caches `:hover` selector matching against pointer events, not against arbitrary DOM mutations. When `data-tug-confirming` clears and the resting `:hover` rule starts matching again, paint may lag until the user moves their mouse. Force re-evaluation by toggling a no-op `data-tug-flush` attribute on the same element inside the same layout effect that clears `data-tug-confirming` (set, then immediately delete — the mutation invalidates the style cache without any styling effect of its own). Both the controlled-mode layout effect and the uncontrolled-mode timer callback must do this.

**Reference implementations:**
- `tug-button.tsx` — primitive that supports both modes. The internal timer path is the default; `isConfirming` opts into controlled mode. Neither path sets `aria-disabled`. Both paths toggle `data-tug-flush` on revert.
- `terminal-block.tsx` — `Copy` button consumer. Sets `isConfirming` to `true` inside the clipboard `.then()` callback only after a successful write resolves; a denied write leaves the flag at `false` and the button stays at rest. Local `setTimeout` clears the flag after a fixed flash window. The "Copied" feedback is now honest.

**Why not just rely on the uncontrolled timer:** in the uncontrolled path the flash fires on every click regardless of whether the underlying operation succeeded. For Copy this means: clipboard denied → user sees "Copied" → believes the clipboard has the new content → pastes the OLD content → confused. The controlled mode pushes the success signal into a chokepoint (the `.then()` callback) that runs only on success.

### Position-preserving interactions (Phase E.3)

For action-row buttons whose click triggers a state change that re-flows the layout around them (a fold cue that collapses or expands a body, a view-mode toggle that swaps grid templates). The browser preserves *scrollTop* across the layout change, NOT the *visual* position of the click target. When the target sits inside a sticky-pinned header and the body shrinks far enough to un-pin the header, the click target's screen position drops by hundreds of pixels — the user's cursor is no longer over the button they just pressed.

**When to use:** Action-row buttons whose click triggers a state mutation that changes the height of content above or around the button. Buttons whose click triggers no layout change (or whose layout change is purely *below* the button and outside any sticky frame) don't need this — adding it would be defensive overhead.

**Implementation: `usePositionStableClick`.**

- The hook lives at `tugdeck/src/components/tugways/internal/use-position-stable-click.ts`. It accepts `targetRef` (the button DOM ref) and `scrollportRef` (a ref to the outer scrollport — typically `useOuterScrollport()`'s return value wrapped in a ref).
- The hook returns `stableClick(mutator)` — a wrapper the caller invokes from its onClick handler instead of running the mutator directly. The wrapper performs the full snapshot → flush → measure → adjust sequence **synchronously on the click handler's call-stack**:
  1. Read `target.getBoundingClientRect()` and stash the snapshot in a local const.
  2. Run the mutator inside `flushSync` so React commits all the mutator's state updates synchronously. By the time `flushSync` returns, the DOM reflects the post-mutation layout — no React batching delay, no useLayoutEffect needed.
  3. Re-measure. If the target's viewport Y shifted, write `scrollportRef.current.scrollTop += delta`. (Pass 1.)
  4. Re-measure once more. If still off, the target sits inside a `position: sticky` ancestor whose pin regime is decoupled from scrollTop — the simple delta couldn't move it. Walk up to the sticky ancestor and compute the exact scrollTop that places it at the desired viewport Y via the sticky positioning formula. (Pass 2.)

- **No React state inside the hook.** No generation counter, no flag state, no `useState`. The compensation is purely imperative DOM work, running on the click event's call-stack between user click and next paint. An earlier draft used a `useState` generation counter to force a re-render whose `useLayoutEffect` did the measurement; that pattern routed appearance compensation through React's render cycle and crossed L06 in spirit even though the counter was never rendered.

**Sticky-aware Pass 2 formula:**

When the target sits inside a sticky ancestor and the ancestor's pin regime flips across pre/post (collapse → expand un-pins the chrome from clamped to fully-pinned, or expand → collapse re-clamps it), the simple delta can't move it: in the pinned regime, sticky positions itself independently of scrollTop. Pass 2 computes the exact scrollTop that places the sticky ancestor back at its pre-click viewport Y:

- Find the nearest `position: sticky` ancestor of the target (inclusive of target itself).
- The target's offset within the sticky ancestor is invariant across scrollTop changes (the target is a child of sticky), so the desired sticky viewport Y is `oldTop - targetOffsetWithinSticky`.
- Read the sticky's CSS `top` offset (e.g. `36px`).
- **Natural regime** (`desiredStickyY > stickyTopOffset`): sticky scrolls with its container, hasn't engaged the pin yet. `scrollTop = sticky.docY − desiredStickyY`.
- **Clamped regime** (`desiredStickyY < stickyTopOffset`): sticky has run out of container room and sits at `parent.bottom_viewport − sticky.height`. `scrollTop = stickyParent.docBottom − desiredStickyY − stickyHeight`.
- Clamp the result to the scrollport's valid `[0, scrollHeight − clientHeight]` range so we don't try to set a negative or beyond-end scrollTop.

**Guards.**
- Skip the entire compensation when `targetRef.current` is null (no measurable target).
- Skip Pass 1/Pass 2 when `scrollportRef.current` is null (standalone composition: gallery, unit tests, anywhere with no outer scrollport above). The mutator still runs inside flushSync.
- Skip when delta is below `POSITION_TOLERANCE_PX` (0.5px). Subpixel rounding shouldn't trigger an adjustment.

**No off-screen guard.** An earlier version skipped the adjustment when the post-mutation rect fell outside the viewport on the theory that "the button is now off-screen, snap-scrolling something else into view would be surprising." That theory was wrong: the button was on-screen at click time (the user clicked it), so any post-state position that takes it off-screen is exactly the case the hook exists to fix. The user's contract is unconditional — clicking a button must not move the button on screen, regardless of where the layout change puts it.

**Tuglaws conformance — read these before reaching for an alternative.**
- **[L04]** No parent-triggered child setState crossed by a measurement. The hook lives in the same component that owns the state being mutated; the synchronous `flushSync` boundary guarantees the DOM is at its post-mutation layout before the measurement runs. No "stale child DOM" timing hazard.
- **[L05]** No `requestAnimationFrame` anywhere. The compensation runs synchronously on the click handler's call-stack, before paint. rAF timing relative to React commits is a browser implementation detail; relying on it would couple the visual-fidelity contract to a non-contract.
- **[L06]** Appearance compensation flows through DOM, not React. The snapshot is a local const inside the click handler. The scrollTop adjustment is a direct DOM write. There is NO React state inside this hook — no generation counter, no flag state, no `useState`. If you find yourself reaching for `useState` to "trigger an effect" that doesn't otherwise render anything, you are probably about to violate L06 in spirit.
- **[L07]** Live ref reads inside the click handler — no closures over stale state.
- **[L23]** Preserves a stronger user-visible invariant ("click point stays under cursor") at the cost of a weaker one ("numeric scrollTop is preserved by the browser"). The user-visible thing is what the user sees and where they are pointing; numeric scroll offset is an implementation detail that serves that surface.
- **[L24]** Local const for the snapshot. Direct DOM writes for the scrollTop adjustments. No structural state. Zone boundaries respected.

**Why `flushSync`.** React batches state updates inside event handlers and commits asynchronously after the handler returns. Without `flushSync`, the measurement immediately after the mutator would still see pre-mutation layout. `flushSync` forces a synchronous commit: by the time it returns, the mutator's setStates have all been applied and the DOM is at the post-mutation layout. We can then measure and adjust on the same call-stack. The alternative — bumping a state counter to force a re-render and doing the work in `useLayoutEffect` — works mechanically but routes appearance compensation through React's render cycle and is therefore a code smell.

**Companion: action-row buttons refuse focus-on-click.** The browser's default click → focus path can trigger an implicit scroll-into-view if the focused element is near a viewport edge. Focus-driven scroll happens *before* React's commit, so the position-stable hook can't compensate for it. Every action-row button must carry `data-tug-focus="refuse"` so its pointerdown handler `preventDefault()`s the default focus action. `TugButton` sets this on every instance — going through `TugPushButton` / `TugIconButton` / `TugPopupButton` is enough. The cost of bypassing the Tug primitive and using a raw `<button>` is exactly this regression.

**Companion: width-stable buttons.** A button whose label *flips* between two values inside the same control causes a layout change every flip — and since the button is itself a click target, the *next* click can land on a different button than the user aimed at. The `widthStabilize` prop on `TugPushButton` renders both labels inside a single CSS Grid cell (`grid-template-areas: "label"`) with both children at `grid-area: label`. The active label paints; the alternate keeps `visibility: hidden` (NOT `position: absolute` — that would remove it from layout and defeat the entire mechanism) but contributes to layout sizing. The button's intrinsic width becomes the max-content of both labels and is stable across flips.

**Scoping (Phase E.4 refinement).** `widthStabilize` is correct for controls that *flip their own label* — confirming flows where a button reads "Copy" at rest and "Copied" during the post-success flash, or any single control that signals state changes through label substitution. It is **not** the right primitive for *segment-style 2-way pickers* — when both options should be visible at all times so the user can read the alternative without toggling. For those, use `TugChoiceGroup`: both labels render as separate segments with a sliding indicator pill identifying the active selection. The DiffBlock view-toggle migrated from label-flipping `widthStabilize` to a `TugChoiceGroup` in Phase E.4 for exactly this reason — users had no visual signal that "SIDE BY SIDE" was a *toggle* until they clicked it and saw the layout change.

**Reference implementations:**
- `use-position-stable-click.ts` — the hook.
- `outer-scrollport-context.tsx` — the context that publishes the scrollport node to descendants. `TugListView` publishes its scroll container automatically.
- `body-kinds/affordances/` — **the block affordance library**. `BlockCopyButton` and `BlockFoldCue` encapsulate the action-row contract (position-stable click via the outer scrollport context, ghost typography, 2xs scale, focus-refuse, width-stabilize for Copy→Copied, disengage-follow-bottom event for fold) so block kinds compose them rather than re-implementing. Block-specific concerns (which clipboard text to compose, when the button is disabled, what aria-label to use) pass as props.
- `file-block.tsx`, `diff-block.tsx`, `terminal-block.tsx` — composed from the affordance library. Copy / Fold-cue come from `body-kinds/affordances/`; the view-toggle on DiffBlock is a `TugChoiceGroup` (both segments visible via the ghost emphasis bracket frame). Adding a new body kind that needs Copy / a fold cue: import from `./affordances`, supply the block-specific bits, done.

### Document-shrink-clamp — retired experiment (Phase E.3 → Step 20.3.5)

There is no current fix for the document-shrink-clamp case. When a click *shrinks* the document — typically a fold cue collapsing a long body kind — the scrollport's `scrollHeight` drops; if the user's `scrollTop` was higher than the new `maxScrollTop`, the browser clamps `scrollTop` down. The click target lands at the new bottom of the document. This is the natural browser behavior and the accepted outcome. `usePositionStableClick` deliberately does NOT compensate for this case (see its docstring).

**Why this is documented as a tuglaw section despite there being no current mechanism.** Phase E.3 (commit `d8da960a`, May 2026) shipped a `TugListView.tailSpacer` prop + matching `SmartScroll.trailingInertOffset` plumbing whose purpose was exactly to absorb this clamp. Step 20.3.5 (May 2026) retired it. Recording both the attempted fix and the reasoning behind the retirement is more useful than letting future readers re-derive the same path and re-make the same trade.

**What the spacer was.** `TugListView.tailSpacer` accepted a CSS length and rendered an inert `aria-hidden` div at the bottom of the scrollable area with that height. The spacer extended `scrollHeight` by its own height; `maxScrollTop` rose accordingly. With the spacer set to `80cqh`, a collapse-shrink of up to 80% of the scrollport didn't force the browser to clamp `scrollTop` — the document still had scroll range left.

**An earlier draft locked each body kind's outer height with `min-height` at the moment of collapse.** That approach made the cell lie about its layout — a "collapsed" block sitting above a giant empty rectangle, with no visible reason for the empty space. UX failure. The tail spacer was the second iteration: empty space at a *semantically reasonable* location (after the last cell) rather than under each collapsed cell.

**Why the spacer was retired.** The spacer's cost was constant — ~80% of the viewport of always-visible empty space at the bottom of every transcript, on every interaction. The spacer's benefit was conditional — a specific shape of click (fold-cue collapse on a tall body kind while scrolled past the new `maxScrollTop`) didn't yank the user's reading position. Constant cost for a rare benefit. The natural browser clamp is honest (the document genuinely got shorter; the user can re-scroll if they care) and matches every other web app's behavior; reserving permanent empty space to hide it inverted the trade.

**What still works after retirement.** `usePositionStableClick` continues to keep the click target stable for layout changes that don't shrink the document — Copy buttons, view-toggle swaps, Find row mounts, icon swaps. The hook's scope is unchanged; only the spacer-backed "even collapsing fold cues work" guarantee is gone.

**Reference: the retirement.** The spike that retired it identified "document-shrink-clamp protection" as the original cause by git archaeology on `d8da960a`, re-evaluated the cost against the benefit, and retired it.

### Emphasis × Role

For components with multiple visual emphases (filled, outlined, ghost) crossed with semantic roles (accent, action, danger, etc.). Each combination maps to a compound CSS class that selects the right tokens.

**When to use:** Buttons, badges — components where the same structural element renders in visually distinct emphasis levels with semantic color meaning.

**Implementation:**
- Props: `emphasis` and `role` (or combined into a variant prop)
- CSS class: `.tug-{name}-{emphasis}-{role}`
- Tokens: `--tug7-surface-control-primary-{emphasis}-{role}-{state}` for backgrounds, `--tug7-element-control-{constituent}-{emphasis}-{role}-{state}` for foregrounds

### Two-line label / content layout (TugBadge)

A chip that packs a letter-spaced caption above (or below) its value, borrowing the session-card status-bar legend discipline so ambient chrome reads with one visual vocabulary. `TugBadge` exposes it via `layout` + `label`:

- **`single`** (default) — the one-row pill. Use for transient or single-fact chips, counts, and status pills. Existing call sites pass only `children`; nothing changes for them.
- **`label-top`** — the caption sits above the value. **This is the default for chrome that mirrors the status bar** (the Z4B permission-mode / model / rate-limit / session indicators). The caption is uppercase, weight 600, `0.08em` tracking — the same legend signature as `tug-box.css`'s `.tug-box-legend`.
- **`content-top`** — the value sits above the caption. Reserve for the rare case where the value reads first and the label is a small caption beneath it (e.g. a numeric readout with a unit caption under it).

**DOM order is stable; the stacking is CSS-driven.** Both two-line layouts render the caption first in the DOM and the content second. `content-top` only reverses the *visual* order via `flex-direction: column-reverse` — never by reordering children — so the reading order and any copy/selection behavior stay fixed.

**Width is the wider of the two rows, intrinsically.** An inline-flex column sizes its cross axis to its widest child, so the chip is exactly as wide as its widest line with no fixed width. A consumer that must hold width across *content* changes (a rate-limit chip cycling "5h 23m" ↔ "rate-limited") reserves the slot itself — overlay the active and a hidden alternate in one grid cell, per [R01] — the chip primitive does not.

**Height comes from the button scale, not the single-line scale.** A two-line chip stands as tall as a button: its per-size height mirrors the `TugPushButton` heights by value (`--tugx-badge-twoline-height-*`: 20 / 24 / 28 / 32 / 36 px for `2xs`→`lg`, extending to 40 / 44 px for `xl` / `2xl`). The `lg` face equals the session-card submit button (`TugPushButton size="lg"`), which is the size the Z4B chips use so the chrome band reads as one row of equal-height controls. The two rows centre vertically inside that fixed box. These tokens live in the badge's own slot — the height is *derived from* the button scale, not borrowed from TugButton's tokens, so [L20] holds.

**Caption tokens stay in the badge's own slot [L20].** The caption's size (`--tugx-badge-label-text-size`, em-relative so one slot tracks every size variant) and tracking (`--tugx-badge-label-tracking`) live under TugBadge's namespace — it never reaches into TugBox's legend tokens. Only the *colour* is shared: the caption uses the seven-slot `--tug7-element-field-text-normal-label-rest` field-label token [L18], the same token the status-bar legend paints, which is what makes the two surfaces read as one family.

### Role Color Injection

For selection controls where a single structural design takes on different role colors via CSS custom property injection, without re-rendering.

**When to use:** Checkboxes, switches, radio buttons — controls where the visual structure is identical across roles but the active/on color changes.

**The default is accent.** When no `role` prop is specified, controls use the theme's accent color. The `role` prop exists for when you need something *other than* the default: a semantic signal (danger, success), a functional indicator (action, data, agent), or a deliberately subdued appearance (option).

**Role semantics:**

| Role | Purpose | Example |
|------|---------|---------|
| *(none/accent)* | Brand color. The default. "This is on." | Any checkbox, switch, radio |
| `action` | Primary action indicator. The return-key button. | Dialog confirm, chat send |
| `danger` | Destructive/irreversible operation. | Delete, disconnect, remove |
| `data` | Operation with a cost (tokens, API calls, data transfer). | "Enable AI suggestions" |
| `agent` | AI/autonomous operation involved. | "Let agent handle this" |
| `caution` | Proceed with care. Less severe than danger. | Override warning |
| `success` | Positive confirmation or good state. | Completion indicator |
| `option` | Deliberately subdued. Calm, neutral. | Dense settings panel |

**Implementation:**
- Prop: `role` (optional). Omitting it gives accent. `"accent"` is not in the type union — it's the implicit default.
- JS injection: every path (including default) injects `--tugx-toggle-on-color`, `--tugx-toggle-on-hover-color`, and `--tugx-toggle-disabled-color` as inline styles pointing to the appropriate `--tug7-surface-toggle-{constituent}-normal-{role}-{state}` tokens.
- Single path, zero branches: `const tokenSuffix = role ? (ROLE_TOKEN_MAP[role] ?? role) : "accent";`
- `data-role` attribute: set only when an explicit role prop is provided. Default (accent) emits no `data-role`.
- This is pure appearance-zone work [L06] — no React state, no re-render

### Compositional Components

For components that produce no visual output of their own, but compose two or more tugways components into a unified API. This is the simpler of the two composition patterns — see "Compound Composition" below for the richer case.

**When to use:** When a common composition pattern (e.g., TugPopupMenu + TugButton) warrants a dedicated component to reduce caller boilerplate, but the visual identity is fully owned by the child components.

**Implementation:**
- Produces only a `.tsx` file — no `.css` file.
- Documents delegation in its module docstring: which child components it renders and which styling responsibilities are delegated to them.
- Does not need `@tug-pairings` — its children own the pairings.
- Still needs: exported props interface with JSDoc, `data-slot` on the root element, and law citations.
- Use a plain function (not `forwardRef`) unless a ref to the DOM root is needed.

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

**Reference implementation:** `tug-popup-button.tsx`

### Compound Composition

For components that have their own visual identity AND compose other tugways components. This is the most common pattern for complex controls — a slider that owns its track and thumb but composes TugValueInput for editing, a radio group that owns its circle indicator but composes TugButton for click targets, a search bar that owns its layout but composes TugInput and TugButton.

**When to use:** The component has visual elements it must style directly (track, indicator, icon slots, layout chrome) and also renders one or more existing tugways components as children.

**Token sovereignty [L20].** Each component owns tokens scoped to its own `component` slot in the seven-slot system. The parent's CSS uses parent-scoped tokens; composed children use their own. Neither reaches into the other's namespace. TugSlider uses `slider` tokens for its track and thumb. TugRadioGroup uses `radio` tokens for its indicator. TugValueInput and TugButton keep their own tokens, tunable independently per theme. This is not optional — the seven-slot `component` slot is the ownership boundary.

**Pairings cover only what you own.** The parent's `@tug-pairings` block declares contrast pairings for the visual elements the parent renders directly. Composed children declare their own pairings in their own CSS files. A slider's pairings cover its label-on-track and thumb-on-range relationships, not TugValueInput's text-on-background. No duplication, no contradiction.

**No descendant restyling.** The parent never uses CSS descendant selectors to override a child component's styles (e.g., `.tug-slider .tug-value-input { ... }` is wrong). If the parent needs to position or size a child within its layout, it styles a wrapper element or uses its own layout properties (gap, grid areas, flex sizing). The child's visual internals are the child's business.

**Prop forwarding.** The parent passes relevant props to composed children — most commonly `size`, `disabled`, and `role`. The module docstring documents which props are forwarded and to which children. When children are provided via the `children` prop rather than rendered directly (e.g., radio items), use React context to propagate group-level props so each child doesn't need to repeat them.

**`asChild` for Radix merging.** When a Radix primitive renders an interactive element (button, input) and the tugways component it composes also renders one, use Radix's `asChild` prop to merge them into a single DOM element. This avoids nested buttons or nested inputs (invalid HTML). The Radix primitive contributes its ARIA attributes, keyboard handlers, and data-state; the tugways component contributes its visual rendering. One element in the DOM gets both.

**Implementation:**
- Produces both `.tsx` and `.css` files — the parent has its own visual identity.
- The parent's CSS defines tokens, aliases, and pairings only for elements it renders directly.
- Module docstring lists which children are composed and what each is responsible for.
- The parent's law citations include [L20] in addition to the standard minimum set.

```typescript
/**
 * TugSlider — Horizontal range slider with optional editable value input.
 *
 * Wraps @radix-ui/react-slider. Composes TugValueInput for the editable
 * numeric display — value input appearance is owned by TugValueInput [L20].
 *
 * Laws: [L06] appearance via CSS, [L15] token-driven states, [L16] pairings declared,
 *       [L19] component authoring guide, [L20] token sovereignty
 * Decisions: [D05] component token naming
 */
```

**Reference implementations:** `tug-slider.tsx` (composes TugValueInput), `tug-radio-group.tsx` (composes TugButton via `asChild`).

### Field Controls

For form inputs that follow the field token family.

**When to use:** Text inputs, textareas, selects — form fields with rest/hover/focus/disabled/readOnly states and optional validation.

**Implementation:**
- Tokens: `--tug7-surface-field-primary-*` for backgrounds, `--tug7-element-field-{text,border}-*` for foregrounds
- States: rest → hover → focus → disabled → readOnly
- Validation: `[aria-invalid="true"]` overrides border color (but not focus state)
- Size variants via class

**Namespace boundary for editing fields:** Components that call `document.execCommand` (text engines, contentEditable wrappers) must use the browser's camelCase command names (`"selectAll"`, `"insertText"`, `"delete"`, `"undo"`, etc.) — never the chain's kebab-case action names. These are separate vocabularies. See [action-naming.md § Action Names vs. Browser Command Names](action-naming.md#action-names-vs-browser-command-names).

---

### Cell Renderers (TugListView)

Cell renderers in `TugListView` are pure render functions. The contract is enforced by convention; downstream of the convention is a class of "second click does nothing" bugs that virtualization recycle, data updates, and Radix portal teardown produce when cells carry their own state.

**The rule:** A `TugListViewCellRenderer<...>` must be a pure function — no `useState`, no `useRef`, no `useEffect` / `useLayoutEffect`, no `useImperativeHandle`. Cells receive `(index, dataSource, kind, id)` plus React context, and return JSX. Selection state, popover state, transient confirmation flows — all of that lives above the list, in the responder that wraps it (typically the form / card).

**Why:** Cells operate inside a windowed list. Their lifecycle is tied to viewport position and data identity, both of which the consumer doesn't control. State stored in a cell can be lost on virtualization recycle, on data-source update, or on cell unmount — producing subtle, hard-to-reproduce bugs that look like "the second click does nothing." [L02] also implies state belongs in stores, not in renderers; cells *are* renderers in the strictest sense.

**What goes where:**

| Concern | Lives in |
|---|---|
| Per-row visual state derived from data | Read from the data source row |
| Selection state | The responder above the list (`useState` + a context `Provider` or a payload on `dataSource`) |
| Confirmation popovers / inline edits / transient floating UI | The responder, with a single instance addressed via a `data-id` anchor lookup — not per-cell |
| Trailing icon actions (trash, more, info) | Dispatch a chain action via `TugIconButton` (`dispatch={...}`); the responder handles the action |
| Cell DOM ref (e.g. for `IntersectionObserver`) | The list view itself owns the ref; cells render markup only |

**Anti-patterns:** raw `<button>` for trailing actions (use `TugIconButton`), per-cell `TugConfirmPopover` instances (hoist to the form, address by data id), `useState` for popover-open visual styling (drive `data-*` attributes from upstream state). The session picker's session-forget flow is the case study and reference implementation.

---

### Trailing Actions in Lists

For trash / more / info / dismiss icon buttons that sit at the trailing edge of a list row.

**When to use:** Any in-list affordance that's "click the icon to do something to this row." Reach for `TugIconButton` (`tugdeck/src/components/tugways/tug-icon-button.tsx`); never drop a raw `<button>`.

**Why not raw `<button>`:** A raw button accepts browser focus on click in Chrome, promotes the chain via the document-level pointerdown walk, and triggers any wrapping Radix interaction (e.g. a popover trigger). Three behaviors fight on one click. The compose pattern from [responder-chain.md §Focus acceptance](responder-chain.md#focus-acceptance) is the answer; `TugIconButton` bakes it in: `data-tug-focus="refuse"`, `useControlDispatch()` plumbing, ghost-emphasis token treatment, hit target sizing. The result is one consistent, conformant primitive.

**Two click modes:**

- **Chain-action** (preferred): `dispatch={{ action, value, phase: "discrete" }}` carries a full `ActionEvent` (with payload) to the parent responder via `useControlDispatch`. The responder owns the resulting state change. This is the L11 shape.
- **Direct-action** (fallback): `onClick={callback}` for one-off side effects that don't fit the chain vocabulary. Mutually exclusive with `dispatch`; setting both dev-warns.

**Sender id:** `senderId` defaults to `useId()`. Pass an explicit value only for tests that need deterministic chain logging — the payload usually carries the discriminator (e.g. a sessionId).

---

## Restoring saved state at mount

A stateful component that opts into the [A9] Component State Preservation Protocol has two halves to wire up: **capture** and **restore-at-mount**. Capture lands the current value into `bag.components` at save time. Restore-at-mount reads the saved value at render time and uses it as the initial state, so the component's very first paint after a restore (cold boot, cross-pane move, tab reopen, HMR remount) already reflects what the user last saved.

The contract is one sentence: **user-visible state at first paint after restore equals user-visible state at last save before destruction.** No intermediate frame painted with the `useState` default. No jump from a 0 scrollTop to the saved scrollTop. If your component ever needs a post-mount `setState` to "apply" a saved value, you are violating the contract — that mechanism produced the wild-scrolling regression Phase E.8 eliminates.

### The canonical pattern — `useSavedComponentState` in a `useState` initializer

For a component whose state lives in React (fold flags, popover open state, toggle values), pair `useSavedComponentState<T>(componentStatePreservationKey)` with a `useState` initializer:

```tsx
function TerminalBlock({ componentStatePreservationKey, ... }: Props) {
  const overThreshold = lineCount > collapseThreshold;
  const savedComponentState = useSavedComponentState<{ collapsed: boolean }>(
    componentStatePreservationKey,
  );
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    typeof savedComponentState?.collapsed === "boolean"
      ? savedComponentState.collapsed
      : overThreshold,
  );

  useComponentStatePreservation<{ collapsed: boolean }>({
    componentStatePreservationKey,
    captureState: () => ({ collapsed }),
  });
  // ...
}
```

Three things this pattern guarantees:

- The read happens in render, before `useState` runs its initializer. The saved value flows straight into the initial state — no effect, no re-render.
- The initializer narrows defensively (`typeof saved?.collapsed === "boolean"`) so a code change that evolves the payload shape can never crash a card on cold boot. An unrecognized payload falls back to the default.
- The `captureState` closure is stored in a ref synced on every render, so it always sees the latest local state at harvest time [L07].

### The scroll-axis variant — `useSavedRegionScroll` plus imperative `initialScrollTop`

For imperative renderers that own an inner scrollport (TerminalBlock's virtualized scroller, FileBlock's CM6 mount), the same primitive carries through to scroll position:

```tsx
const scrollKey = `${componentStatePreservationKey}/term-scroll`;
const savedRegionScroll = useSavedRegionScroll(scrollKey);
const initialScrollTopRef = useRef<number | undefined>(savedRegionScroll?.y);
const firstRenderConsumedRef = useRef(false);
const consumeInitialScrollTop = useCallback((): number | undefined => {
  if (firstRenderConsumedRef.current) return undefined;
  firstRenderConsumedRef.current = true;
  return initialScrollTopRef.current;
}, []);

useLayoutEffect(() => {
  const handle = renderTerminal(
    outer, body, data, getOuter, collapsed, "top", scrollKey,
    consumeInitialScrollTop(),
  );
  return () => handle.cleanup();
}, [collapsed, /* ... */, consumeInitialScrollTop]);
```

The renderer assigns `scroller.scrollTop = initialScrollTop` immediately after `body.appendChild(scroller)`, inside the same `useLayoutEffect` call — before paint. The scroller's first observable `scrollTop` already matches the bag. The `consumeInitialScrollTop` one-shot ensures only the FIRST creation of the inner scroller consumes the saved value; subsequent rebuilds (collapse-toggle, streaming re-render) pass `undefined` and rely on the anchor-based default. The element-identity-gated `MutationObserver` pass in `card-host.tsx` covers any later scroller-rebuild path by re-applying the bag value to the new element.

### Custom geometry meta — when raw `{x, y}` isn't enough

Some scrollers can't restore correctly from raw pixel `scrollTop` alone:

- **Variable-height virtualized lists** (`TugListView` driving session-card's transcript). Cell heights drift as async sub-content settles; the saved pixel `y` no longer maps to the saved *content* by the time the bag is replayed.
- **Code editors with wrapping** (CM6 in `FileBlock`). Font-load reflow shifts the pixel position of every line on first paint; a raw pixel restore lands at the wrong line.

For these, the substrate writes a richer payload onto `data-tug-scroll-state`:

```ts
// TugListView writer (every commit):
const meta = {
  anchor: { index: anchorIndex, offset: anchorOffset },
  cellHeights: heightIndexRef.current.snapshot(),
  scrollHeight: el.scrollHeight,
};
el.setAttribute("data-tug-scroll-state", JSON.stringify(meta));
```

And on the read side, hydrates its internal layout state before first paint:

```ts
// TugListView mount-time hydration:
const savedRegionScroll = useSavedRegionScroll(scrollKey);
React.useLayoutEffect(() => {
  if (savedRegionScroll === undefined) return;
  const meta = savedRegionScroll.meta;
  if (meta === null || typeof meta !== "object") return;

  const cellHeights = (meta as { cellHeights?: unknown }).cellHeights;
  if (Array.isArray(cellHeights)) {
    heightIndexRef.current.hydrate(cellHeights);
  }
  const anchor = (meta as { anchor?: unknown }).anchor;
  if (anchor !== null && typeof anchor === "object" && "index" in anchor && "offset" in anchor) {
    // ...stash for the apply effect...
  }
}, []);
```

The substrate also applies per-cell `min-height` from hydrated `cellHeights` so async sub-content fills its destined slot without shifting siblings — the anchor cell stays at the saved viewport position from the very first paint.

The meta schema and the conventions for the three families (`anchor`, `cellHeights`, `line`, `scrollHeight`) are documented in [state-preservation.md](state-preservation.md#saving-geometry-for-first-paint-accuracy) and in `RegionScrollSnapshot`'s prose docstring. New substrates that need richer meta extend the same channel.

### Anti-patterns

- **Do not** add a `restoreState` callback to `useComponentStatePreservation`. The capability is gone for a reason — a post-mount apply re-renders the component with the saved value, which the user sees as a flicker.
- **Do not** read `useSavedComponentState` outside a `useState` initializer and then `setState` from a `useEffect`. That is the same post-mount apply path in a different shape.
- **Do not** read `useSavedRegionScroll` and write `el.scrollTop = saved.y` from a `useEffect` after the scroller mounts. That produces the visible 0 → saved jump. Pass the value into the imperative renderer at creation time instead.
- **Do not** use a timer to wait for content to settle before applying scroll position. Timers are unreliable for async content delivery; the right answer is to save the layout geometry at save time and hydrate it before first paint, so the restore math is exact, not estimated.

See [state-preservation.md](state-preservation.md) for the full protocol, capture/restore moments, and the relationship to `[L23]`.

---

## Selection and Focus

Every component participates in the selection model. See [card-state-model.md](card-state-model.md) for the full design.

### Selection categories

Determine your component's category and apply the corresponding pattern:

**Selectable** (user can directly select text via click-drag or ⌘A):
- Set `user-select: text` in the component's CSS
- Handle `selectAll` in the responder registration
- Handle `copy` (and `cut`/`paste` if editable)
- Examples: `TugInput`, `TugTextarea`, `TugValueInput`, `TugPromptInput`, `TugMarkdownView`

**Copyable** (informational text the user might want to copy, but not directly select):
- Do NOT set `user-select: text` — inherit `user-select: none`
- Use the `useCopyableText` hook — it handles responder registration, context menu, and clipboard write
- Set `data-tug-select="copy"` on the root element
- Example: `TugLabel` with `copyable` prop

**Chrome** (UI controls with no copyable text content):
- Do NOT set `user-select: text` — inherit `user-select: none`
- No selection handlers needed
- Right-click shows the app-wide "No Actions" fallback menu automatically
- Examples: buttons, toolbars, section headers, decorative elements

### Focus refusal for controls

Controls that dispatch actions but don't need keyboard input should refuse focus on click. This prevents the control from stealing focus from an active editor.

Add `data-tug-focus="refuse"` to the control's root element. That's all — the `ResponderChainProvider` handles both browser focus prevention and first-responder promotion skipping centrally.

```tsx
// Example: a control that refuses focus
<button data-tug-focus="refuse" onClick={handleClick}>
  Action
</button>
```

Controls that accept focus (text inputs, textareas, contentEditable) do NOT add this attribute.

**One concept, two layers.** The attribute names a single user goal — *"clicking this control must not steal focus from where the user is typing."* The `ResponderChainProvider` realizes that goal at two layers in one bundle: (1) the chain-promotion-skip on `pointerdown` (so the chain's first responder stays where it was), and (2) the `mousedown.preventDefault()` browser-focus-prevention (so the DOM `activeElement` stays where it was). Authors set the attribute and get both behaviors atomically; an author cannot opt out of one without the other, by design — a button that takes browser focus but not chain promotion (or vice versa) is incoherent. This bundle is what makes service-popup close-focus restoration work correctly: the trigger click does NOT capture first responder, so the service binding's `captureOnOpen` snapshots the *editor's* responder id (not the trigger's), and `onCloseAutoFocus` restores focus to the editor on menu close.

The attribute is button-class-only. Structural markers like `data-slot="tug-canvas-overlay-root"` (which pane-focus-controller reads to skip pane activation on overlay-tier clicks) are deliberately separate — see "Canvas overlay tier" above.

### Focus in content-owning cards

**A card has at most one text-entry / input surface.** For a content-owning + engine card (a session card, anything whose factory writes `bag.content`) that surface is the engine's editor — `tug-prompt-entry` for a session card. Content blocks inside the card (`FileBlock`, `DiffBlock`, `TerminalBlock`) render no text-entry UI of their own. So a session card's activation focus has exactly one destination: the engine. There is no "where does focus go when this card is activated" decision — it goes to the prompt entry, on every activation source (cold-boot, app-switch, card-switch, cross-pane drag, reload).

The engine is a **callable**: it registers `paintMirrorAsActive` / `paintMirrorAsInactive` hooks via `store.registerEngineHooks`, and the framework's `applyBagFocus` dispatcher invokes them through the `engine` resolution. A session card carries no `data-tug-focus-key` / `data-tug-state-key` element of its own, so `captureFocus` only ever returns `engine` or `none` for it; either way the assembler leaves `bag.focus` absent and `resolveBagFocus` routes the card to the engine from its registry tag.

**Focusable-but-not-entry content classifies as `none`.** A read-only `TugCodeView` (FileBlock's CM6 viewer) is still *focusable* — CM6 read-only views accept focus for selection / copy. But its `.cm-content` lives under `data-slot="tug-code-view"`, which is not an engine-owned selector and carries no `data-tug-*-key`. So when the user clicks into a FileBlock viewer inside a session card, `captureFocus` returns `none`, and on the next activation `resolveBagFocus` routes the card to its engine — focus lands on the prompt entry, not back in the viewer. This is intended: a viewer is not a text-entry surface, and transient selection-to-copy focus is not preserved across activation.

**Do not add per-block transient focus targets to a content-owning card.** No per-block find rows, no inline parameter editors stamped with `data-tug-focus-key`, no second text input. The notion of Find is being redesigned and will not return as a per-block widget. If a future feature needs in-card text entry, it belongs in (or replaces) the engine's one text-entry surface — not as a sibling framework-axis target.

The general framework focus axis (`data-tug-focus-key` / `data-tug-state-key`, the `dom` / `form-control` `FocusSnapshot` kinds) is untouched and still serves **non-engine** cards — form-control cards, settings cards, anything whose authoritative focus mechanism is a keyed DOM element. That axis is not this section's concern; this section is specifically about content-owning + engine cards, where the engine is the single focus destination.

**What NOT to stamp.**

- The engine's contenteditable (`.cm-content` inside `[data-slot="tug-text-editor"]`). The engine registers its own hooks via `store.registerEngineHooks`; the framework invokes them through the engine resolution path, not through a framework `.focus()` call. Layering a framework `.focus()` would bypass the inactive-paint → global-Selection transfer and leave focus on a view with no caret.
- Any content block's focusable element (a `TugCodeView` viewport, a block button). These are not text-entry surfaces; leaving them unstamped means `captureFocus` classifies them `none` and activation focus correctly returns to the engine.
- An overlay-tier popup's input. Overlays close on activation by design (see [Canvas overlay tier (popup-class)](#canvas-overlay-tier-popup-class)); their focus state is owned by the popup-binding's `captureOnOpen` / `onCloseAutoFocus`, not by `bag.focus`.

### Context menus

The browser's native context menu is suppressed app-wide. Every right-click produces one of:
- A component-specific `TugEditorContextMenu` (selectable or copyable components)
- The "No Actions" fallback menu (chrome)

Never let the native browser context menu appear — it reveals the web implementation.

### Cursors

The cursor tells the user what will happen if they click. The baseline is `cursor: default` (arrow) on `body` and `.tug-pane-chrome-content`. Components override explicitly — never leave `cursor: auto` on any element (it shows an I-beam over text, implying selectability).

| Cursor | When to use | Set by |
|--------|-------------|--------|
| `default` (arrow) | Chrome: labels, headers, toolbars, backgrounds, empty space | Inherited from `.tug-pane-chrome-content` — no action needed |
| `text` (I-beam) | Selectable content: text inputs, textareas, contentEditable, markdown view | Component CSS (`cursor: text` alongside `user-select: text`) |
| `pointer` (hand) | Interactive controls: buttons, checkboxes, switches, links | Component CSS (`cursor: pointer`) |
| `not-allowed` | Disabled controls | Component CSS on disabled/aria-disabled state |
| `grab` / `grabbing` | Draggable surfaces (card title bar) | Component CSS |
| `crosshair` | Precision pick (color pickers) | Component CSS |
| `ew-resize` / `ns-resize` / `nwse-resize` | Resize handles | Component CSS |

**Rule: pair `cursor: text` with `user-select: text`.** Every selectable component sets both. If text shows an I-beam, the user expects to be able to select it. If text is non-selectable, it must show the arrow.

**Rule: chrome inherits the arrow.** Chrome components do not need to set `cursor: default` — they inherit it from `.tug-pane-chrome-content`. Only set it explicitly if overriding a more specific rule (e.g., `cursor: default` on a readOnly input that would otherwise show I-beam).

---

## Portaling and Overlays

Components that paint above the pane stack — typeahead popups, popovers, dropdown menus, tooltips — must escape every pane's clip rect. Two portal targets exist; pick the one that matches the overlay's lifetime. (Note: `.tug-pane-chrome` and `.tug-pane-body` use `overflow: clip` rather than `hidden` — same painting clip, no scroll-container formation, no sticky-pin trap for descendants. Either form still requires a portal for overlays that need to paint above the pane.)

### Canvas overlay tier (popup-class)

**Popup-class primitives portal to the canvas overlay root, not their host pane.** A single `<CanvasOverlayRoot />` is mounted inside `DeckCanvas` as a sibling of the pane container; popup-class CSS lands above it via the `--tug-z-overlay-*` tier tokens defined in `chrome.css`.

Use `useCanvasOverlay` from `lib/use-canvas-overlay.ts` for the portal target. The hook lives under `lib/` (not `chrome/`) so substrates can import it without inverting the chrome-imports-substrate layering ([D09] of the *overlay tier* work). The hook returns the registered root, or `document.body` as a fallback when no root is mounted (test mounts, gallery cards).

```tsx
import { createPortal } from "react-dom";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";

function MyOverlay({ children }: { children: React.ReactNode }): React.ReactElement {
  const overlayRoot = useCanvasOverlay();
  return createPortal(
    <div
      style={{ position: "fixed", pointerEvents: "auto" }}
      className="my-overlay"
    >
      {children}
    </div>,
    overlayRoot,
  );
}
```

Pair with the right tier token in CSS:

| Class                     | Token                              | Examples                                                |
|---------------------------|------------------------------------|---------------------------------------------------------|
| Tooltip                   | `--tug-z-overlay-tooltip`          | `TugTooltip`                                            |
| Popup                     | `--tug-z-overlay-popup`            | `TugPopover`, `tug-completion-menu`                     |
| Menu                      | `--tug-z-overlay-menu`             | `TugContextMenu`, `TugPopupMenu`, `TugMenu`             |
| Dialog                    | `--tug-z-overlay-dialog`           | `TugSheet`                                              |
| Popup-in-dialog (elevated)| `--tug-z-overlay-popup-in-dialog`  | `TugPopover` opened from a control inside a sheet       |
| Menu-in-dialog  (elevated)| `--tug-z-overlay-menu-in-dialog`   | `TugPopupMenu` / `TugContextMenu` inside a sheet        |

**Pane focus controller skips clicks inside the canvas overlay tier.** The pane-focus-controller's document-level pointerdown listener checks `closest('[data-slot="tug-canvas-overlay-root"]')` and short-circuits when the click target lives inside the overlay tier — preventing pane-activation gestures from firing on popup-internal clicks. The canvas overlay root itself is identified by `data-slot="tug-canvas-overlay-root"`; it does NOT carry `data-tug-focus="refuse"`. The two attributes are deliberately distinct: `data-slot="tug-canvas-overlay-root"` is a structural marker (pane-focus-controller's "am I inside the overlay tier?" check), while `data-tug-focus="refuse"` is a button-class focus discipline (chain-promotion-skip + browser-focus-prevention bundled — see "Focus refusal for controls" above). Popups' own pointer interactions are owned by the popup primitives themselves; the overlay-tier short-circuit only governs the surrounding pane-activation behavior.

### Picking a popup role

Every popup-class primitive plays one of four **roles** in the user's focus relationship with the surrounding workspace. Pick the role at component-design time by asking: **while this popup is open, where does the user expect their typing to go?**

| Role                | Examples                                       | Open behavior                                | Close behavior                                  | Hook                          |
|---------------------|------------------------------------------------|----------------------------------------------|-------------------------------------------------|-------------------------------|
| **Companion**       | `CompletionOverlay` (file completion)          | Owner keeps DOM focus; popup never steals it | Owner keeps DOM focus                           | `useCompanionPopupBinding`    |
| **Service**         | `TugPopupMenu`, `TugPopover`, `TugContextMenu` | Popup grabs focus via Radix `FocusScope`     | Restore prior first-responder via `focusResponder` | `useServicePopupBinding`   |
| **Modal-with-trap** | `TugSheet`, `TugAlert`                         | Trap focus inside; owning card body becomes `inert` | Restore focus to trigger; chain-native `cancelDialog`   | (existing `FocusScope` + chain-native dispatch) |
| **Hover hint**      | `TugTooltip`                                   | n/a — tooltips don't take focus              | n/a                                             | n/a                           |

Author guidance: the question above narrows to a role.

- "The popup itself" → **service**. The user is now choosing an item in the menu / interacting with the popover. Use `useServicePopupBinding`. `TugPopupMenu`, `TugPopover`, `TugConfirmPopover`, `TugContextMenu`, and (by composition) `TugPopupButton` all carry this internally — consumers don't pass `onCloseAutoFocus` overrides. Custom close behavior calls `manager.focusResponder(targetId)` from the menu-item handler before close (Risk R02 in `tugplan-tide-popup-bindings.md`).
- "The same place as before" → **companion**. The user is still typing into the editor and the popup is a side-channel. Use `useCompanionPopupBinding({ ownerEl, onShouldDismiss })` at the consumer site. The hook fires `onShouldDismiss` exactly when DOM focus transitions out of the owner element's subtree (microtask-deferred to ride past in-subtree sibling transitions). See [D05] in `tugplan-tide-popup-bindings.md`.
- "Nowhere — the rest of the workspace is blocked" → **modal-with-trap**. A sheet is not "a service popup with a focus trap"; it is a workspace-blocking interaction the user explicitly entered. Sheets use Radix's `FocusScope` trap and the existing chain-native `cancelDialog` close path. Do NOT consume `useServicePopupBinding` from a modal-with-trap primitive — its restore-prior semantics are wrong here (a sheet's "Cancel" button should restore focus to the trigger, not to whatever was first responder before).
- "No input — just a hint that goes away on hover-out" → **hover hint**. Tooltips share the canvas overlay tier for tier consistency only; they do not consume any binding.

Per [L19], every popup-class component documents its role in its module docstring and consumes the corresponding binding (or none, for modal-with-trap and hover hint). Reviewers verify the docstring matches the binding.

### Popup-in-sheet stacking via TugSheetStackingContext

A popup opened from a control inside a sheet must visually stack ABOVE the sheet, not behind it. Both sheets (`--tug-z-overlay-dialog: 9400`) and popups (`--tug-z-overlay-popup: 9200` / `--tug-z-overlay-menu: 9300`) portal to the same canvas overlay root, so default tokens would put the popup behind. Per [D09] in `tugplan-tide-popup-bindings.md`, the elevation is signaled through React context.

**Authoring contract.** Any popup-class primitive that portals to the canvas overlay root MUST consume `TugSheetStackingContext` and apply the corresponding `*-in-dialog` class on its portaled content element when the value is `true`:

```tsx
import { useContext } from "react";
import { cn } from "@/lib/utils";
import { TugSheetStackingContext } from "@/components/tugways/tug-sheet-stacking-context";

function MyMenuContent({ children }: { children: React.ReactNode }): React.ReactElement {
  const inDialog = useContext(TugSheetStackingContext);
  return (
    <DropdownMenuPrimitive.Content
      className={cn("tug-menu-content", inDialog && "tug-menu-in-dialog")}
      // …
    >
      {children}
    </DropdownMenuPrimitive.Content>
  );
}
```

Pair with one CSS rule that swaps to the elevated z-tier token:

```css
.tug-menu-content.tug-menu-in-dialog {
  z-index: var(--tug-z-overlay-menu-in-dialog);
}
```

Use `tug-popup-in-dialog` for popovers (z-tier 9500) and `tug-menu-in-dialog` for menus / context menus / popup menus (z-tier 9600). The `menu > popup` ordering is preserved inside dialogs so a popover that opens a menu inside a sheet keeps the same relative stacking it has outside a sheet.

`TugTooltip` does not consume the context — tooltips are hover-only and never opened from buttons inside a sheet in a way that requires elevation. `tug-completion-menu.css` does not need the elevation rule by default (a completion overlay opening inside a sheet is unusual; the editor inside a sheet is rare).

### Pane-scoped overlays

**Pane-scoped overlays (pane banners, in-pane bulletins) use `TugPanePortalContext`.** These overlays must die with the pane — when the pane closes, the portal target unmounts, taking the overlay with it. Sheets used to live here too, but moved to the canvas overlay tier in `tugplan-tide-popup-bindings.md` Step 2 (the user-visible bug was "the sheet is clipped by the card"; the card-modal behavior — `inert` on `.tug-pane-body`, focus trap, restore-to-trigger — stays card-scoped via `cardEl`, while only the rendering target moved to the canvas tier).

| Surface                                | Portal target                | Lifetime          |
|----------------------------------------|------------------------------|-------------------|
| `TugSheet`                             | `<CanvasOverlayRoot />`      | Canvas-lifetime; `inert`/`focus`-trap stay card-scoped |
| `TugPaneBanner`                        | `TugPanePortalContext`       | Owning pane       |
| `TugBanner`, `TugAlert`, `TugBulletin` | App root                     | App-lifetime      |

App-banner-class primitives keep their existing literal z-indexes (99000+) — those deliberately outrank the canvas overlay tier so a connection-loss banner overlays a completion menu.

---

## Accessibility

Every component must be accessible. This is not optional.

### Keyboard Navigation

- All interactive elements reachable via Tab
- Enter/Space activate buttons and toggles
- Arrow keys navigate within groups (radio, select, tabs)
- Escape closes overlays
- Focus ring visible on `:focus-visible` only (not on click)

### ARIA

- Radix wrappers inherit ARIA from the primitive — don't duplicate
- Native wrappers: add `aria-invalid`, `aria-disabled`, `aria-required` as appropriate
- Every interactive element must have an accessible name (`aria-label`, associated label, or visible text)
- `aria-disabled="true"` (not HTML `disabled`) for chain-action controls that must remain in the tab order [D06]

### Data Attributes

Components emit data attributes for external styling and tooling:

| Attribute | Purpose | Example |
|-----------|---------|---------|
| `data-slot` | Stable semantic identifier | `data-slot="tug-button"` |
| `data-state` | Radix state | `data-state="checked"` |
| `data-role` | Semantic role variant | `data-role="danger"` |
| `data-size` | Size variant | `data-size="sm"` |

---

## Testing

Tests verify behavior, not values. [See test trimming principles.]

### What to Test

- Component renders without throwing
- Keyboard interaction works (Tab, Enter, Space, Escape)
- Prop changes produce correct DOM state (disabled → `aria-disabled`, checked → `data-state`)
- Callbacks fire on interaction
- Role injection produces correct inline style

### What NOT to Test

- Exact token values or CSS output
- Exact class names
- Snapshot tests
- Pixel-level rendering
- Internal implementation details

### Test File Location

```
src/__tests__/tug-{name}.test.tsx
```

Import `./setup-rtl` first, then `bun:test`, then `@testing-library/react`.

---

## Checklist

Before a component is done:

- [ ] `.tsx` follows the TSX structure (docstring, props, forwardRef, data-slot)
- [ ] `.css` follows the CSS structure (@tug-pairings, @tug-renders-on, base → states → variants)
- [ ] All colors via `--tug-*` tokens, zero hardcoded colors
- [ ] Every token matches what it styles: surface tokens for fills/backgrounds, border tokens for borders, text tokens for text — no semantic mismatches
- [ ] No ad-hoc theme logic in component TSX/JS
- [ ] `data-slot="tug-{name}"` on root element
- [ ] Module docstring cites minimum law set ([L06], [L11] if interactive, [L15] if interactive, [L16] if CSS, [L19]) plus any component-specific laws; no `Spec S##` references
- [ ] Props interface exported with JSDoc; every CSS-targetable prop has `@selector` annotation
- [ ] `@tug-pairings` present in both compact and expanded-table formats; components with no pairings use `@tug-pairings: none`
- [ ] Component-tier aliases (if used) defined in `body {}` and resolve to base tokens in one hop [L17]
- [ ] `@tug-effects` block present if the component uses `--tug7-effect-*` tokens
- [ ] Compositional components (no CSS): delegation documented in module docstring; no `@tug-pairings` needed
- [ ] Compound composition: own tokens scoped to own component slot; no descendant restyling of children; pairings cover only own elements; composed children documented in docstring [L20]
- [ ] Internal components: lives in `internal/`, docstring says "Internal building block — use [public component] instead", public wrapper re-exports needed types
- [ ] **Controls emit actions via targeted dispatch.** [L11] Every interactive component that responds to user input dispatches a typed action via `useControlDispatch()`. No `manager.sendToFirstResponder()` calls from controls. No callback props for user interactions.
- [ ] **Responders register via `useResponder` / `useOptionalResponder`.** Every component that handles actions calls one of the two hooks with a typed `actions` map; the strict form for load-bearing chain participants, the tolerant form for standalone-capable leaves.
- [ ] **`data-slot` + `data-responder-id` on the root element.** `data-slot` via the literal attribute, `data-responder-id` via attaching `responderRef` from the hook to the root DOM element.
- [ ] **No `makeFirstResponder` calls from component code.** First responder is managed by the chain's pointerdown / focusin promotion path. The only sanctioned exception is `DeckCanvas` promoting a freshly-opened card, and it is documented inline where it occurs.
- [ ] **Transient UIs subscribe to `observeDispatch` while open** with a `blinkingRef` self-dispatch guard, unless the surface is intentionally modal (alert, sheet) per `internal/floating-surface-notes.ts`.
- [ ] Handlers read current state through refs, not stale closures [L07]
- [ ] Keyboard accessible (Tab, Enter/Space, Escape)
- [ ] `bun run build` exits 0
- [ ] `bun run test` exits 0
- [ ] `bun run audit:tokens lint` exits 0
- [ ] Renders correctly in Component Gallery across themes

A **gallery** card is an exemplary demo of an established `Tug*` component: proper usage, the range of the API, meant to be browsed as documentation. That is the only thing the gallery holds. Exploratory work — trying a layout, comparing two treatments, designing a surface that is not yet a component — is a **spike**, and belongs in `tugdeck/src/spikes/` (see its README, or run `/tugplug:spike-card`). A card whose only consumer is the app-test harness is a **fixture**, and belongs in `tugdeck/src/fixtures/`. Registering any of the three in the wrong place fails `card-taxonomy.test.ts`.

---

## Stores That Observe CONTROL Push Frames

Some external stores aren't backed by tugbank; they're projections of
server-side state that the supervisor pushes over the CONTROL feed.
`SessionLedgerStore` is the second consumer of this pattern — the
first was the live-sessions broadcast handling that landed alongside
T3.4.c §step-4-5-5.

The shape:

1. **Action-dispatch as the wire-side decoder.** `action-dispatch.ts`
   registers handlers for the response/push frame names (e.g.,
   `session_updated`, `list_sessions_ok`, `forget_session_ok`). Each
   handler validates the payload shape and forwards a typed event
   through a small pub/sub bus.
2. **A pub/sub bus per store.** The ledger uses
   `lib/session-ledger-events.ts` — a process-global module that
   exports `subscribe*` / `publish*` functions per event kind. The bus
   is the single decoupling point between the wire decoder and the
   store consumer.
3. **The store subscribes on construction.** The store calls each
   `subscribeTo*` once in its constructor, holding the unsubscribe
   functions in a `disposers: Array<() => void>` so a future
   `dispose()` can clean up. The store then mutates its in-memory
   cache and emits a listener tick — exactly like a tugbank-backed
   store under [L02].
4. **`useSyncExternalStore` is still the React boundary.** The hook
   that exposes the store to React (`useSessionLedger(projectDir)`)
   wraps the store with `useSyncExternalStore` so [L02] holds: external
   state never enters React state, even one tick removed via the bus.
5. **Imperative actions roundtrip through the bus.** A method like
   `forgetSession(sessionId)` sends a CONTROL frame and returns a
   promise. The promise's resolver lives in a pending-map on the
   store; the matching `forget_session_ok` / `_err` ack arrives via
   the bus and resolves the promise. Tests publish the ack frame
   directly to drive the store without a real wire.
6. **Reconnect re-fetches.** The store hooks
   `connectionDidReconnect` (from `connection-lifecycle`) and calls
   `invalidateAll()` on every reconnect after the first — covering the
   gap where push frames may have landed during a wire bounce. [L23]
   compliance: the server-side ledger persists; the client-side cache
   is the rebuildable projection.

When to use this pattern: the projected state is server-owned, has
many keys (per-workspace, per-session), and updates frequently enough
that tugbank's `domain-changed` cadence isn't a fit. When the data is
small (a single config blob, a recents list with 5 entries),
`useTugbankValue` is still the right shape.

---

## Reference: Token Naming

Tokens follow the seven-slot convention from [token-naming.md](token-naming.md):

```
--<namespace>-<plane>-<component>-<constituent>-<emphasis>-<role>-<state>
```

| Slot | Purpose |
|------|---------|
| namespace | Always `tug7`. Identifies the design system and seven-slot convention. |
| plane | `element` (visible marks) or `surface` (backgrounds) |
| component | `global`, `control`, `field`, `toggle`, `badge`, etc. |
| constituent | `text`, `icon`, `border`, `shadow`, `primary`, `track`, etc. |
| emphasis | `normal`, `filled`, `outlined`, `ghost`, `tinted` |
| role | `default`, `accent`, `action`, `danger`, `success`, etc. |
| state | `rest`, `hover`, `active`, `focus`, `disabled` |

## Reference: Laws That Govern Components

| Law | Summary | Applies To |
|-----|---------|------------|
| [L01] | One `root.render()`, ever | All components |
| [L02] | External state via `useSyncExternalStore` only | Components reading stores |
| [L03] | `useLayoutEffect` for registrations events depend on | Responder participants |
| [L06] | Appearance changes via CSS/DOM, never React state | All components |
| [L07] | Handlers read current state through refs, not stale closures | Action handlers on responders |
| [L11] | Controls emit actions; responders own state that actions mutate | Any component that dispatches or handles an action |
| [L15] | Token-driven control states; color transitions only | Interactive controls |
| [L16] | Every foreground rule declares its rendering surface | All CSS files |
| [L17] | Component aliases (`--tugx-*`) resolve to `--tug7-*` in one hop | Component-tier tokens |
| [L18] | Element/surface vocabulary | All token usage |
| [L19] | Component authoring guide | All components |
| [L20] | Token sovereignty — composed children keep their own tokens | Compound composition |

For the chain mechanics ([L11], [L03], [L07]) in depth — the dispatch walk, first-responder promotion, the four dispatch shapes, `observeDispatch`, the keyboard pipeline — see [responder-chain.md](responder-chain.md).
