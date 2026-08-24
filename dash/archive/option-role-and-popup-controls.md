# Option Role + Popup Menu Controls

## Problem

The current emphasis × role matrix covers CTA-oriented controls well:

| Emphasis | Role | Purpose |
|----------|------|---------|
| `filled` | `accent`, `action`, `danger` | Primary CTA |
| `outlined` | `action` | Secondary CTA |
| `ghost` | `action`, `danger` | Tertiary/inline |

But there's no good fit for **configuration controls** — popup menus, checkboxes,
switches, segmented controls. These are the instrument panel, not the warning lights.
Using `outlined-action` is too loud (strong blue border competing for attention).
Using `ghost` loses the border entirely, making it unclear the control is interactive.

## Proposal: `option` Role

Add a new role value `option` to the emphasis × role matrix. The `option` role is for
controls that present choices or settings — visually present and readable, but not
competing for attention with CTA buttons.

### Applicable matrix slots

- **`outlined-option`** — bordered control with subtle/muted border and neutral text.
  Primary style for popup menus, form controls.
- **`ghost-option`** — borderless but with subtle hover feedback. For inline settings.

(`filled-option` is intentionally excluded — a filled option control contradicts the
"calm" visual intent.)

### Visual characteristics

| Property | `outlined-action` (current) | `outlined-option` (proposed) |
|----------|----------------------------|------------------------------|
| Border | Strong action-blue | Subtle, muted (e.g., `fg-muted` opacity) |
| Text/fg | Action-blue | `fg-default` — readable but not colored |
| Background | Transparent | Transparent or very subtle surface tint |
| Hover | Strong action-blue fill | Gentle highlight, restrained |
| Active/open | Full action-blue | Slightly more emphasis than hover, still calm |

### Applicability across components

- **TugPopupButton** — squared-off popup menu triggers (gallery controls, settings panels)
- **TugCheckbox** — option toggles
- **TugSwitch** — on/off settings
- **Future**: segmented controls, radio groups, stepper controls

## Component Architecture: Separating Menu Behavior from Trigger Presentation

### Problem with current TugDropdown

TugDropdown currently *owns its trigger button internally*. This couples menu behavior
to trigger presentation, creating problems:

1. **Tab bar `+` button**: Doesn't want a chevron, doesn't want squared borders, doesn't
   want "lit up" open-state highlighting — but TugDropdown forces all of these. The tab
   bar then fights back with CSS overrides (`display: none` on trailing icons, etc.).
2. **Gallery preview controls**: Want squared borders, subtle `option` styling, aligned
   text — but TugDropdown only knows about pill-shaped TugButton with CTA emphasis.
3. **`+` with chevron looks ridiculous**: When the trigger is a single character in a
   tab bar, appending a chevron makes it visually noisy and unbalanced.
4. **Open-state highlighting fails**: The `+` button doesn't stay "lit" while its menu
   is shown because the CSS rules target TugButton emphasis classes, not the tab bar's
   custom trigger styling.

### Proposed decomposition

Invert the ownership: the *trigger* owns the menu, not the other way around.

#### TugPopupMenu (headless behavioral layer)

The Radix dropdown state machine, item rendering, portal, alignment, and blink
animation — with **no opinions about what the trigger looks like**. It takes a
`trigger` prop (or uses Radix's `asChild` pattern) and attaches menu behavior to
whatever element it receives.

Responsibilities:
- Radix DropdownMenu root + portal + content rendering
- Item list rendering with icons, labels, disabled state
- Selection blink animation (TugAnimator double-blink)
- Menu close sequencing (Escape dispatch after blink)
- Side offset calculation
- `data-state="open"` propagation to trigger (via Radix)

Not responsible for:
- Trigger appearance (shape, color, border-radius, chevron)
- Open-state highlighting (that's the trigger's CSS concern)
- Whether or how a chevron indicator is shown

#### TugPopupButton (convenience component for standalone popup menus)

Composes TugPopupMenu + TugButton for the common "squared-off button with chevron
that pops a menu" pattern. This is the macOS-style popup button.

Characteristics:
- Uses `role="option"` for calm, non-CTA styling
- Squared border-radius (`rounded="none"`) on both trigger and content
- ChevronDown trailing icon
- Open-state highlighting via `data-state="open"` + `outlined-option` CSS
- Text alignment: menu item text aligns with trigger label text

#### Tab bar usage

The tab bar's `+` button uses TugPopupMenu directly with its own custom trigger
element. No chevron, no squared borders, no forced button styling. The tab bar
controls all presentation decisions for its trigger.

### Migration path

1. Extract TugPopupMenu from the current TugDropdown internals
2. Build TugPopupButton composing TugPopupMenu + TugButton
3. Migrate all TugDropdown call sites:
   - Gallery preview controls → TugPopupButton
   - Tab bar `+` and overflow → TugPopupMenu with custom triggers
   - Other standalone dropdowns → TugPopupButton or TugPopupMenu as appropriate
4. Delete TugDropdown entirely — no aliases, no backward-compat shims, no legacy uses

## Implementation Steps

1. **Theme derivation engine**: Generate `option` role control tokens —
   `--tug-base-control-{outlined,ghost}-option-{bg,fg,border,icon}-{rest,hover,active}`
2. **Run `bun run generate:control-tokens`** to propagate tokens
3. **TugButton types**: Add `"option"` to `TugButtonRole`
4. **TugButton CSS**: Add `.tug-button-outlined-option` and `.tug-button-ghost-option`
   variant rules consuming the new tokens
5. **TugPopupMenu**: Extract headless menu behavior from TugDropdown
6. **TugPopupButton**: Compose TugPopupMenu + TugButton with `option` role,
   squared border-radius, chevron, open-state highlighting, text alignment
7. **Open-state CSS**: Add `outlined-option` and `ghost-option` `data-state="open"`
   rules in tug-menu.css
8. **Gallery preview controls**: Migrate to TugPopupButton
9. **Tab bar**: Migrate `+` and overflow to TugPopupMenu with custom triggers;
   remove blanket trailing-icon hiding CSS
10. **TugCheckbox / TugSwitch**: Evaluate adopting `role="option"` for calmer styling
