# Theme Direct Load

*Load the active theme directly. No base layer, no override, no cascade.*

---

## Problem

The current theme system loads brio as a permanent base layer, then cascades a second CSS file on top as an "override." This creates fragility:

- `bun run build` empties the override file, causing brio to flash in a running dev server
- Any stale or missing override reveals brio underneath
- New tokens added to one theme must be manually synced to the override copy
- The override mechanism is conceptually wrong: harmony is not "brio with changes" — it's a complete, standalone theme with 591 token declarations, the same count as brio

Both themes are complete. Neither depends on the other. The layering is unnecessary complexity.

## Solution

Replace the two-file cascade with direct single-file loading. The active theme's CSS file is copied into a single import target. No base layer, no override.

### What changes

**`tug-base.css`** — Replace two imports with one:

```css
/* Before */
@import './tug-base-generated.css';
@import './tug-theme-override.css';

/* After */
@import './tug-active-theme.css';
```

**`tug-active-theme.css`** — A single file that contains the active theme's tokens. Written by the Vite plugin at startup and on theme switch. For brio, this is a copy of `tug-base-generated.css`. For harmony, a copy of `themes/harmony.css`. Always complete, never empty.

**`themeOverridePlugin()`** → **`themeLoaderPlugin()`** — Simplified:
- Dev startup: read active theme from tugbank, copy that theme's CSS into `tug-active-theme.css`
- Build: read active theme from tugbank, copy that theme's CSS into `tug-active-theme.css` (same logic — no special empty-override path)
- Theme switch endpoint: copy the new theme's CSS into `tug-active-theme.css`

**`controlTokenHotReload()`** — Same as today but watches for changes to any theme CSS file and re-copies the active one.

**`handleThemesActivate()`** — Same as today but copies the full theme file instead of writing an "override."

**Production** — Same as today: base CSS bundle includes the active theme's tokens. Theme switching via `<link>` element swaps the entire file.

### What goes away

- `tug-theme-override.css` — deleted
- `tug-base-generated.css` is no longer imported directly by `tug-base.css` — it's the source file that gets copied into `tug-active-theme.css` when brio is active
- The concept of "base + override" — every theme is a peer, loaded directly
- The build-mode special case that empties the override — builds just use whatever theme is active
- D03 ("Brio is the base theme... switching to Brio removes the override") — replaced by: switching to any theme copies that theme's file

### What stays the same

- Theme CSS files stay where they are: `tug-base-generated.css` (brio), `themes/harmony.css`
- `--tug-color()` PostCSS expansion — unchanged
- Token names and values — unchanged
- Production theme switching via `<link>` element — unchanged
- tugbank stores the active theme name — unchanged
- `POST /__themes/activate` endpoint — unchanged API, just copies differently

### Files to change

| File | Change |
|------|--------|
| `styles/tug-base.css` | Replace two `@import` lines with one: `@import './tug-active-theme.css'` |
| `vite.config.ts` | Rename plugin, remove build special case, write active theme (not empty override) |
| `.gitignore` | `tug-theme-override.css` → `tug-active-theme.css` |
| `tuglaws/theme-engine.md` | Update activation model to describe direct load |
| `tuglaws/design-decisions.md` | Update D03 |

### Verification

- Switch to harmony, `bun run build` — no flash, harmony stays
- Switch to brio, `bun run build` — no flash, brio stays
- Switch themes via app menu — works as before
- Dev server HMR on theme file edit — theme updates live
- Production build output — correct theme in `dist/`
