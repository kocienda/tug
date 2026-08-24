# Split TugButton into internal/ and extract TugPushButton

*The directory structure should tell developers which components to use and which are infrastructure.*

---

## Why

`TugButton` and `TugPushButton` are both defined in `tug-button.tsx`. From the file listing, there's no hint TugPushButton exists — yet it's the component app code should actually use for standalone action buttons. Meanwhile, TugButton is infrastructure: composed internally by TugPopupButton, TugTabBar, and gallery cards, but not something a developer should reach for directly.

The `tugways/` directory currently gives no signal about what's public API vs internal building block.

## What

1. Create `tugdeck/src/components/tugways/internal/` directory
2. Move `tug-button.tsx` and `tug-button.css` into `internal/`
3. Extract `TugPushButton` into its own file at the top level: `tugways/tug-push-button.tsx`
4. Update all imports

After the change, the directory communicates intent:

```
tugways/
  tug-checkbox.tsx       ← public: devs use this
  tug-switch.tsx         ← public: devs use this
  tug-input.tsx          ← public: devs use this
  tug-push-button.tsx    ← public: devs use this (standalone action buttons)
  tug-popup-button.tsx   ← public: devs use this (dropdown triggers)
  tug-badge.tsx          ← public: devs use this
  tug-label.tsx          ← public: devs use this
  ...
  internal/
    tug-button.tsx       ← infrastructure: composed by other tugways components
    tug-button.css       ← infrastructure: button styling
```

## Files to move

| From | To |
|------|-----|
| `tugways/tug-button.tsx` | `tugways/internal/tug-button.tsx` |
| `tugways/tug-button.css` | `tugways/internal/tug-button.css` |

## New file

`tugways/tug-push-button.tsx` — extracted from the bottom of `tug-button.tsx`. Contains:
- `TugPushButtonProps` interface
- `TugPushButton` component (thin wrapper around TugButton with `.tug-push-button` class)
- Its own module docstring explaining this is THE button for app code
- Imports TugButton from `./internal/tug-button`

## Imports to update

### Internal tugways consumers (import from `./internal/tug-button`)

| File | Current import |
|------|---------------|
| `tug-popup-button.tsx` | `import { TugButton } from "./tug-button"` |
| `tug-tab-bar.tsx` | `import { TugButton } from "./tug-button"` |
| `tug-push-button.tsx` (new) | `import { TugButton } from "./internal/tug-button"` |

### App code importing TugPushButton (import from `tug-push-button`)

| File | Change |
|------|--------|
| `cards/gallery-cascade-inspector-content.tsx` | `from "@/components/tugways/tug-button"` → `from "@/components/tugways/tug-push-button"` |
| `cards/gallery-badge-mockup-content.tsx` | same |
| `cards/gallery-animator-content.tsx` | same |
| `cards/gallery-scale-timing-content.tsx` | split: TugButton from `internal/tug-button`, TugPushButton from `tug-push-button` |
| `cards/gallery-card.tsx` | split: TugButton from `internal/tug-button`, TugPushButton from `tug-push-button` |

### Gallery/test code importing TugButton directly (import from `internal/tug-button`)

| File | Change |
|------|--------|
| `cards/gallery-theme-generator-content.tsx` | `from "@/components/tugways/internal/tug-button"` |
| `cards/gallery-palette-content.tsx` | same |
| `cards/gallery-popup-button-content.tsx` | same |
| `cards/gallery-scale-timing-content.tsx` | same (for TugButton import) |
| `cards/gallery-card.tsx` | same (for TugButton + types) |
| `__tests__/e2e-responder-chain.test.tsx` | same |
| `__tests__/scaffold.test.tsx` | same |
| `__tests__/chain-action-button.test.tsx` | same |

### Type re-exports

`tug-push-button.tsx` should re-export the types that app code needs:
- `TugButtonEmphasis`, `TugButtonRole`, `TugButtonSize` — these are part of TugPushButton's API

This way, app code that uses TugPushButton can import everything from one place:
```typescript
import { TugPushButton } from "@/components/tugways/tug-push-button";
import type { TugButtonEmphasis, TugButtonRole, TugButtonSize } from "@/components/tugways/tug-push-button";
```

## Docstring updates

**`internal/tug-button.tsx`** — reframe opening:
> TugButton — internal button infrastructure for tugways.
>
> Building block composed by TugPushButton, TugPopupButton, and TugTabBar.
> App code should use TugPushButton for standalone action buttons.

**`tug-push-button.tsx`** — new module docstring:
> TugPushButton — standalone action button for app code.
>
> Uppercase, letter-spaced styling for clear call-to-action buttons
> ("Save", "Cancel", "Delete"). Wraps TugButton with the `.tug-push-button` CSS class.

## What does NOT change

- `tug-button.css` content — just moves to `internal/`
- TugButton's implementation — identical, just relocated
- TugPushButton's implementation — identical, just in its own file
- The CSS class name `.tug-push-button` — unchanged
