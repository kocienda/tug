# Skeleton Token Fix

*Move skeleton tokens out of tug-dialog.css, give them proper `--tug7-*` names, and define them in both themes.*

---

## Problems

### 1. Skeleton tokens defined in tug-dialog.css

`tug-dialog.css` is a grab-bag file defining `--tugx-*` aliases for dialogs, sheets, toasts, alerts, badges, progress, skeleton, empty states, and keyboard shortcuts. The skeleton tokens (`--tugx-skeleton-base`, `--tugx-skeleton-highlight`) are defined there as raw `--tug-color()` values — not resolving to `--tug7-*` base tokens in one hop. They're the only tokens in this file that use raw color definitions instead of `var(--tug7-*)` references.

### 2. No `--tug7-*` base tokens exist for skeleton

The skeleton component uses `--tugx-skeleton-base` and `--tugx-skeleton-highlight` directly. Per [L17] and token-naming.md, `--tugx-*` aliases must resolve to `--tug7-*` tokens in one hop. But there are no `--tug7-surface-skeleton-*` tokens in either theme file. The raw colors are baked directly into the `--tugx-*` definitions.

### 3. Harmony theme has no skeleton tokens

The brio-oriented values (`t: 20`, `t: 28`) in tug-dialog.css produce dark skeleton bars that look correct on brio's dark background but are far too dark on harmony's light background. Harmony needs its own light-appropriate values.

---

## Fix

### Step 1: Add `--tug7-*` skeleton tokens to both theme files

Seven-slot names following the naming convention:

```
--tug7-surface-skeleton-primary-normal-default-rest    ← base color
--tug7-surface-skeleton-primary-normal-default-active   ← pulse highlight color
```

Using `active` state for the pulse highlight — the animation "activates" the brighter phase.

**brio.css** (dark theme — move existing values):
```css
--tug7-surface-skeleton-primary-normal-default-rest: --tug-color(violet, i: 5, t: 20);
--tug7-surface-skeleton-primary-normal-default-active: --tug-color(indigo, i: 7, t: 28);
```

**harmony.css** (light theme — new light-appropriate values):
```css
--tug7-surface-skeleton-primary-normal-default-rest: --tug-color(indigo, i: 3, t: 82);
--tug7-surface-skeleton-primary-normal-default-active: --tug-color(indigo, i: 2, t: 88);
```

### Step 2: Move `--tugx-*` aliases to tug-skeleton.css

Add a `body {}` block at the top of `tug-skeleton.css` (after `@tug-pairings`, before base styles) that resolves to the `--tug7-*` tokens in one hop:

```css
body {
  --tugx-skeleton-base: var(--tug7-surface-skeleton-primary-normal-default-rest);
  --tugx-skeleton-highlight: var(--tug7-surface-skeleton-primary-normal-default-active);
}
```

### Step 3: Remove skeleton tokens from tug-dialog.css

Delete lines 43-44 from `tug-dialog.css`:
```css
  --tugx-skeleton-base: --tug-color(violet, i: 5, t: 20);
  --tugx-skeleton-highlight: --tug-color(indigo, i: 7, t: 28);
```

### Step 4: Verify

- `bun run build` passes
- Brio skeletons look the same (no visual change)
- Harmony skeletons are light gray instead of dark

---

## Files touched

| File | Change |
|------|--------|
| `tugdeck/styles/themes/brio.css` | Add 2 `--tug7-surface-skeleton-*` tokens |
| `tugdeck/styles/themes/harmony.css` | Add 2 `--tug7-surface-skeleton-*` tokens |
| `tugdeck/src/components/tugways/tug-skeleton.css` | Add `body {}` block with `--tugx-*` aliases |
| `tugdeck/src/components/tugways/tug-dialog.css` | Remove 2 skeleton lines |
