# Theme Switching Pipeline

*Replace the broken runtime CSS injection with a file-based override that goes through Vite's CSS pipeline. One mechanism for all theme switching — shipped themes, Swift menu, generator card auto-save, dev and production.*

**Verified:** CSS `@import` HMR works. Writing to `tug-theme-override.css` triggers Vite HMR, PostCSS expands `--tug-color()` → `oklch()`, and the browser applies the new theme atomically. Tested both directions (Brio → Harmony → Brio).

---

## Problem

Runtime theme switching is completely broken for non-Brio themes. The current approach:

1. Fetches theme CSS from a Vite middleware endpoint
2. Stuffs the CSS text into a `<style id="tug-theme-override">` element
3. The CSS contains `--tug-color()` notation — a custom syntax that only `postcss-tug-color` understands
4. The browser cannot parse `--tug-color()`, silently ignores every chromatic token declaration
5. All chromatic tokens fall back to Brio's base values through the cascade
6. Result: switching to Harmony shows Brio's dark surfaces, wrong text colors, broken grid, unstyled cards

The theme generator preview works because it bypasses this entire system — it uses `themeOutput.resolved` (pre-calculated `oklch()` values) as inline CSS custom properties via React's `style` prop.

---

## Root Cause

There are two parallel representations of every chromatic token:

| Representation | Format | Where it lives |
|---|---|---|
| `themeOutput.tokens` | `--tug-color(indigo-violet, i: 2, t: 95)` | Written to CSS files on disk |
| `themeOutput.resolved` | `{ L: 0.93, C: 0.012, h: 275, alpha: 1 }` | In-memory, used for contrast checks and preview |

The PostCSS plugin `postcss-tug-color` converts `--tug-color()` → `oklch()` during Vite's build pipeline. But PostCSS only runs on CSS files that are in Vite's module graph (imported via the JS import chain). The runtime-injected `<style>` element bypasses the entire pipeline.

---

## Design

### Principle

All theme CSS goes through Vite's CSS pipeline as a real file on disk. No `<style>` injection. No middleware CSS fetching. No runtime PostCSS bypass. The browser never sees `--tug-color()`. No flash — ever.

### Mechanism

A single override file at `styles/tug-theme-override.css`:

- Imported by `tug-base.css` via `@import` **after** `tug-base-generated.css`
- Part of Vite's module graph → PostCSS processes it → HMR delivers changes
- Contains the active theme's token overrides (or is empty for Brio)
- Generated, never checked in (`.gitignore`'d)
- Created automatically if missing (by Vite plugin at startup, or by `generate-tug-tokens.ts`)

### Cascade

```
tug-base.css
  @import './tug-base-generated.css';    /* Brio tokens — always present */
  @import './tug-theme-override.css';    /* Active theme override — empty for Brio */
  /* ...font declarations, :root multipliers, scrollbar... */
```

When Harmony is active, `tug-theme-override.css` contains Harmony's `body {}` block with all token overrides. PostCSS expands `--tug-color()` → `oklch()`. The cascade naturally overrides Brio's values.

When Brio is active, the file is empty. Brio's tokens from `tug-base-generated.css` are the only values.

---

## Active Theme Persistence

The active theme name is persisted in `.tugtool/active-theme` (a plain text file containing just the theme name, e.g., `harmony`). Written by the activate endpoint on every switch. Read by the Vite plugin at startup and by `controlTokenHotReload` after engine changes.

This is the server-side source of truth. The browser also stores the name in `localStorage` for fast reads, but the file is authoritative.

---

## Startup — Zero Flash

The override file must contain the correct theme CSS **before Vite serves any page**.

A Vite plugin (`themeOverridePlugin`) runs during `configResolved`:

1. Read `.tugtool/active-theme` to get the persisted theme name (default: `"brio"`)
2. If `command === "build"`: always write an empty override (production ships with Brio default)
3. If Brio: ensure `styles/tug-theme-override.css` exists and is empty
4. If non-Brio: read the theme JSON, run `deriveTheme()`, write CSS to `styles/tug-theme-override.css`

The file is correct on disk before Vite processes any CSS. On initial page load, `tug-base.css` `@import`s the override file. Vite processes it through PostCSS. The browser receives fully resolved `oklch()` values. The correct theme is applied from the first paint. No race condition, no flash.

Fresh clone with no `.tugtool/active-theme`: the plugin creates an empty override file → Brio.

### Canvas Color on Startup

`main.tsx` reads the active theme name from `localStorage` (which mirrors `.tugtool/active-theme`). It fetches the theme JSON via `GET /__themes/<name>.json`, runs `deriveCanvasParams()`, and calls `sendCanvasColor()`. This is unchanged from the current startup flow — the CSS is already correct from the plugin, this step only handles the Swift bridge canvas color.

---

## Theme Activation (Dev)

A new middleware endpoint: `POST /__themes/activate`

Request body: `{ "theme": "<name>" }`

The endpoint:

1. Find the theme JSON (shipped in `tugdeck/themes/`, authored in `~/.tugtool/themes/`)
2. Run `deriveTheme()` on the recipe
3. If `name` is `"brio"`: write an empty file to `styles/tug-theme-override.css`
4. Otherwise: format as CSS via `generateThemeCSS()`, write to `styles/tug-theme-override.css`
5. Write `name` to `.tugtool/active-theme`
6. Vite detects the file change → PostCSS runs → HMR delivers the update
7. Respond with `{ theme, canvasParams }` — canvas color params derived in step 2, so `setTheme` needs only one fetch

A mutex serializes writes to the override file. If the Swift menu sends `set-theme` while the generator card is mid-auto-save, the second write waits for the first to complete.

CSS HMR replaces the stylesheet atomically — old theme → new theme in one paint. No intermediate state. The switch may have slight latency (file write + PostCSS + HMR delivery), but no flash.

This is the **only** way themes get switched. Every path converges here:

| Trigger | Path |
|---|---|
| Swift Theme menu | bridge → `set-theme` → action-dispatch → `POST /__themes/activate` |
| Generator card Open | `POST /__themes/activate` |
| Generator card auto-save | `POST /__themes/save` (writes JSON + triggers activate) |
| App startup | `themeOverridePlugin` writes override file before Vite serves — no endpoint call needed |
| Dev hot reload (theme JSON edit) | `controlTokenHotReload` re-generates base + re-activates current theme |

---

## Theme Activation (Production)

In production (macOS app, no Vite dev server), all shipped themes are pre-built static assets with PostCSS already applied.

Authored themes are a dev-only feature (requires dev-mode). In production, only shipped themes are available. Fallback is always Brio.

### Build Step

During `bun run build`:

1. `themeOverridePlugin` writes an empty override file (Brio default)
2. `generate-tug-tokens.ts` writes `tug-base-generated.css` (Brio) and per-theme CSS in `styles/themes/`
3. `generate-tug-tokens.ts` also emits a pre-computed canvas params map for all shipped themes (derived at build time, bundled as a static constant)
4. Vite's build pipeline processes all CSS through PostCSS — `--tug-color()` → `oklch()`
5. Each theme's CSS is included in the build output as a static asset

### Canvas Params Map

Pre-computed at build time by `generate-tug-tokens.ts`. Eliminates any runtime derivation or fetching for canvas color in production.

```typescript
// Generated — do not edit
export const THEME_CANVAS_PARAMS: Record<string, CanvasColorParams> = {
  brio: { hue: "indigo-violet", tone: 5, intensity: 2 },
  harmony: { hue: "indigo-violet", tone: 95, intensity: 3 },
};
```

Synchronous lookup. No derivation, no fetch, no async. Always right the first time.

### Runtime

Theme switching in production swaps a `<link>` element pointing to the pre-built theme CSS asset:

| Action | Mechanism |
|---|---|
| Switch to shipped theme | Set `<link id="tug-theme-override" href="/assets/themes/<name>.css">` |
| Switch to Brio | Remove the `<link>` element — Brio base tokens take over |

The `<link>` loads a real, pre-built, PostCSS-expanded CSS file. The cascade works the same as in dev — override after base.

```typescript
async function setTheme(themeName: string): Promise<void> {
  if (import.meta.env.DEV) {
    // Dev: activate on server — rewrites override file, Vite HMR delivers it
    const res = await fetch("/__themes/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: themeName }),
    });
    const { canvasParams } = await res.json();
    sendCanvasColor(canvasParams);
  } else {
    // Production: swap <link> to pre-built theme CSS, send canvas color from static map
    activateProductionTheme(themeName);
    sendCanvasColor(THEME_CANVAS_PARAMS[themeName]);
  }

  setThemeState(themeName);
  localStorage.setItem("td-theme", themeName);
}
```

---

## Authored Themes (Dev Only)

Authored theme JSON lives in `~/.tugtool/themes/`. It is never copied into the repo. The activation endpoint reads the JSON from the user directory, derives the CSS, and writes it to the same `styles/tug-theme-override.css`. The browser and Vite never know or care whether the source was shipped or authored.

The `POST /__themes/save` endpoint (for auto-save from the generator card):

1. Writes `<name>.json` to `~/.tugtool/themes/`
2. Calls the activate logic to rewrite `tug-theme-override.css` with the updated theme
3. Vite HMR delivers the CSS update

No separate CSS file is written to `~/.tugtool/themes/`. The only override CSS file is `styles/tug-theme-override.css`.

---

## Hot Reload

All hot reload flows converge on file writes that Vite watches:

| What changed | What gets written | Vite response |
|---|---|---|
| `theme-engine.ts` or `theme-rules.ts` | `tug-base-generated.css` + `tug-theme-override.css` (re-derived) | HMR both files |
| Shipped theme JSON (`tugdeck/themes/*.json`) | `tug-base-generated.css` + `tug-theme-override.css` (if that theme is active) | HMR |
| Generator card slider change | `tug-theme-override.css` (via auto-save → activate) | HMR |

The existing `controlTokenHotReload` plugin needs a small extension: after regenerating `tug-base-generated.css`, read `.tugtool/active-theme` and re-derive + rewrite `tug-theme-override.css` for the currently active theme (if non-Brio). This ensures that engine changes are reflected in the active override too.

---

## Generator Card Preview

The `liveTokenStyle` inline preview mechanism is unchanged. It provides instant visual feedback as the user moves sliders, before the debounced auto-save triggers a server-side activate.

The auto-save flow:

1. User adjusts a control
2. `liveTokenStyle` updates instantly (inline `oklch()` values from `themeOutput.resolved`)
3. After 500ms debounce, `POST /__themes/save` fires
4. Server writes JSON to `~/.tugtool/themes/`, then activates (rewrites override CSS)
5. Vite HMR delivers the CSS update to the browser
6. The app-wide theme now matches the preview

The latency between step 2 and step 6 is the file write + PostCSS + HMR delivery time. During this window, the generator preview shows the new colors (via `liveTokenStyle`) while the rest of the app still shows the previous save's colors. The next HMR delivery catches everything up. CSS HMR replaces the stylesheet atomically — no intermediate state, no flash.

---

## Ensuring Override File Exists

The override file is `.gitignore`'d and won't exist in fresh clones or CI. Multiple points ensure it exists before anything needs it:

1. **Vite startup** (`themeOverridePlugin` in `configResolved`): creates the file if missing — handles `bun run dev` and `bun run build`
2. **`generate-tug-tokens.ts`**: creates the file if missing before writing — handles standalone token generation
3. **`POST /__themes/activate`**: always writes the file — handles runtime activation

Any codepath that reads `tug-theme-override.css` is preceded by a codepath that creates it.

---

## Changes

### Files to modify

| File | Change |
|---|---|
| `styles/tug-base.css` | Add `@import './tug-theme-override.css'` after `tug-base-generated.css` |
| `src/contexts/theme-provider.tsx` | Replace `injectThemeCSS`/`removeThemeCSS` with `POST /__themes/activate` in dev, `<link>` swap in production. Remove `themeCSSMap`, `registerThemeCSS`. Simplify `setTheme` to one fetch returning canvas params. |
| `src/main.tsx` | Remove startup theme CSS fetching and registration. Override file is already correct from plugin. Keep canvas color derivation for Swift bridge. |
| `src/action-dispatch.ts` | No change — already calls `setTheme()` |
| `vite.config.ts` | Add `themeOverridePlugin` (writes override at startup). Add `POST /__themes/activate` endpoint with mutex. Update `controlTokenHotReload` to re-derive active override using `.tugtool/active-theme`. Remove `GET /__themes/<name>.css` endpoint. Update `handleThemesSave` to trigger activate after save. |
| `src/theme-css-generator.ts` | No change |
| `postcss-tug-color.ts` | No change |
| `scripts/generate-tug-tokens.ts` | Ensure `tug-theme-override.css` exists (create empty if missing). Continue writing `tug-base-generated.css` and per-theme CSS in `styles/themes/`. |
| `.gitignore` | Add `tugdeck/styles/tug-theme-override.css` |
| `src/components/tugways/cards/gallery-theme-generator-content.tsx` | Update auto-save to use `POST /__themes/save` (which triggers activate). Remove direct `injectThemeCSS` calls. `liveTokenStyle` preview unchanged. |

### Files to create

| File | Contents |
|---|---|
| `styles/tug-theme-override.css` | Empty; generated at dev startup and on activation; `.gitignore`'d |
| `.tugtool/active-theme` | Plain text file with the active theme name; written by activate endpoint |

---

## What This Eliminates

- `injectThemeCSS()` / `removeThemeCSS()` — no more `<style>` element manipulation
- `themeCSSMap` — no more CSS text caching in JS
- `registerThemeCSS()` — no more pre-registration
- `GET /__themes/<name>.css` — no more CSS fetching from middleware
- The entire "fetch CSS text → inject as `<style>`" pattern
- Startup theme CSS fetching in `main.tsx`
- Two-fetch `setTheme` (activate + JSON fetch)

---

## What This Preserves

- `--tug-color()` notation and `postcss-tug-color` — unchanged
- `generate-tug-tokens.ts` — continues to write `tug-base-generated.css` for Brio and per-theme CSS
- `generateThemeCSS()` — unchanged
- `deriveTheme()` — unchanged
- `liveTokenStyle` preview in the generator card — unchanged
- Hot reload of `theme-engine.ts` and theme JSON files — same trigger, extended to also update the override
- Two-directory theme storage (shipped in repo, authored in home dir) — unchanged
- `GET /__themes/list` and `GET /__themes/<name>.json` — unchanged
- `POST /__themes/save` — extended to trigger activate
- Swift bridge `set-theme` → `themeListUpdated` — unchanged
