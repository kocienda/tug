# Step 4: Interactive Component Build Guide

## Approach

Build each form control / display component **one at a time**, interactively. For each component:

1. **Build** — `.tsx` + `.css` using `--tug-base-control-*` stateful tokens
2. **Gallery** — Add a section to the Component Gallery with all variants and states
3. **Tune** — Adjust token values in dev tools / `tug.css` until the look is right across all themes
4. **Test** — Write unit tests for rendering, keyboard nav, accessibility
5. **Commit** — Lock it in, move to the next component

No batch implementation. Each component gets full attention before moving on.

## Build Order

Priority is downstream need (Settings card needs inputs, checkboxes, switches, selects, sliders) and increasing complexity.

| # | Component | Kind | Radix Package | Key Design Notes |
|---|-----------|------|---------------|------------------|
| 1 | **TugInput** | Wrapper (native) | — | Field tokens (`--tug-base-field-*`), validation states, focus ring |
| 2 | **TugLabel** | Wrapper | `@radix-ui/react-label` | Pairs with TugInput, required indicator, helper text |
| 3 | **TugCheckbox** | Wrapper | `@radix-ui/react-checkbox` | Control state tokens for check target, mixed state |
| 4 | **TugSwitch** | Wrapper | `@radix-ui/react-switch` | Track + thumb, both use control state tokens |
| 5 | **TugSelect** | Wrapper | (already installed) | Trigger uses control tokens, popover uses surface tokens |
| 6 | **TugSlider** | Wrapper | `@radix-ui/react-slider` | Track/thumb, value display, action phases |
| 7 | **TugRadioGroup** | Wrapper | (already installed) | Group label, layout options |
| 8 | **TugTextarea** | Wrapper (native) | — | Auto-resize, char count, field tokens |
| 9 | **TugToggle** | Wrapper | `@radix-ui/react-toggle` | Pressed/unpressed control state colors |
| 10 | **TugSeparator** | Wrapper | `@radix-ui/react-separator` | Simple; horizontal/vertical |
| 11 | **TugBadge** | Original | — | Tone variants, pill shape, count mode |
| 12 | **TugSpinner** | Original | — | Size variants, replaces loading visuals |
| 13 | **TugProgress** | Wrapper | `@radix-ui/react-progress` | Bar, percentage, indeterminate |
| 14 | **TugSkeleton** | Enhance | — | Already exists, update to `--tug-skeleton-*` tokens |
| 15 | **TugKeyboard** | Original | — | Keycap chip appearance |
| 16 | **TugAvatar** | Wrapper | `@radix-ui/react-avatar` | Image + fallback initials |
| 17 | **TugStatusIndicator** | Original | — | Tone-colored dot + text |

## Token Pattern Per Component

Interactive controls (1-9) use `--tug-base-control-{variant}-{property}-{state}` tokens from `styles/themes/brio.css`. The pattern established by TugButton:

```
bg:     rest / hover / active / disabled
fg:     rest / hover / active
border: rest / hover / active
icon:   rest / hover / active
```

Form fields (TugInput, TugTextarea) use `--tug-base-field-*` tokens (bg-rest, bg-hover, bg-focus, border-rest, border-hover, border-focus, etc.) — these already exist.

Display components (11-17) may not need interactive states. They use semantic tokens like `--tug-base-element-global-*`, `--tug-base-surface-global-*`, `--tug-base-element-tone-*`.

## Gallery Section Per Component

Each component's gallery section shows:
- All variants (where applicable)
- All sizes (where applicable)
- All states: rest, hover (labeled), active (labeled), disabled
- Interactive controls for toggling props
- Renders in current theme (theme switch tests all three)

## What "Done" Looks Like Per Component

- `.tsx` file in `components/tugways/`
- `.css` file in `components/tugways/`
- Gallery section added
- Looks correct across Brio, Bluenote, Harmony
- Token changes in `styles/themes/brio.css` visibly affect the component
- Unit tests pass
- `bun run build` exits 0
- `bun test` exits 0

## First Component: TugInput

Start here. TugInput is the most-needed form control and uses the field token system (which already exists but hasn't been visually tuned for the retronow aesthetic).

What to build:
- Native `<input>` wrapper
- Variant: default (uses field tokens), error (red border/accent)
- Sizes: sm, md, lg
- States: rest, hover, focus, disabled, readOnly
- Props: `value`, `onChange`, `placeholder`, `disabled`, `readOnly`, `error`, `size`
- Accessibility: proper labeling when used with TugLabel, `aria-invalid` for error state
