# Theme System Authoring Refactor

## Concepts

Three distinct things, clearly separated:

1. **Recipe** — a formula function (`darkRecipe` / `lightRecipe`) that takes color choices and expands them into ~200 derivation formula fields. Recipes are code. They define offsets, constants, hue slot routing — the mechanics of how a dark or light theme works. The `RECIPE_REGISTRY` maps recipe names to functions and is extensible for future recipes.

2. **Theme** — a JSON file containing color choices (hues, tones, intensities, role colors) plus a reference to which recipe to use. Brio is a theme. Harmony is a theme. Anything authored in the generator card is a theme. Themes are data, not code. They live on disk as `.json` files.

3. **Theme output** — what `deriveTheme()` produces: 373 CSS tokens. This is the result of applying a recipe's formula to a theme's color choices. Theme outputs are generated artifacts (CSS files), not source files.

## Problem

The current system conflates these concepts:

- **Themes are hardcoded in TypeScript** as `EXAMPLE_RECIPES` in `theme-engine.ts`. This makes them look like sample code rather than the shipped product themes, and means editing a theme requires editing TypeScript source, running a build script, and reloading.
- **No live editing path for shipped themes.** The generator card previews into a scoped container but cannot push changes to the running app's actual theme. Edits don't stick.
- **Default values are duplicated in three places:** `EXAMPLE_RECIPES`, Dark/Light button click handlers with hardcoded literals, and `DEFAULT_RECIPE` in the generator card.
- **Recipe functions are in a separate file** (`theme-recipes.ts`) from the engine that consumes them, for no reason.
- **The module header** says "Theme Derivation Engine — Tugways Theme Generator" — old naming.
- **`loadPreset`** is a vestige of an obsolete design.
- **Bluenote** is obsolete and must be removed.
- **The `formulas` escape hatch** on `ThemeRecipe` is an anti-pattern that bypasses the recipe system entirely. Remove it.

## Architecture

### The base theme

The app's baseline CSS tokens come from **Brio**, the shipped default dark theme. Its tokens live in `styles/tug-base-generated.css`, imported by `tug-base.css`. Every other theme works by injecting a `<style>` override that sits on top of Brio in the cascade. Switching *to* Brio means *removing* the override stylesheet — there is no CSS to inject, because the baseline is already active.

Brio is defined by `tugdeck/themes/brio.json`.

### Theme storage — two directories, unique names

Themes live in two locations with a clear separation:

```
tugdeck/themes/              ← shipped themes (checked into the repo)
  brio.json                    the base/default dark theme
  harmony.json                 shipped light theme

~/.tugtool/themes/           ← user-authored themes (user data, not in repo)
  nightfall.json               user-created theme
  warm-dark.json               user-created theme based on brio
```

**Theme names are unique across both directories.** You cannot create an authored theme with the same name as a shipped theme. The `POST /__themes/save` endpoint rejects names that already exist in `tugdeck/themes/`. Shipped themes are read-only — they can only be modified by editing the JSON in the repo and committing.

To modify a shipped theme, use the Prototype pattern: New → pick the shipped theme as the base → give it a new name → edit the copy → when satisfied, manually copy the JSON back to `tugdeck/themes/`, replacing the original, and commit.

Each theme file contains a serialized theme (the `ThemeRecipe` interface, minus the removed `formulas` escape hatch):

```json
{
  "name": "brio",
  "description": "Deep, immersive dark theme with industrial warmth.",
  "recipe": "dark",
  "surface": {
    "canvas": { "hue": "indigo-violet", "tone": 5, "intensity": 5 },
    "grid": { "hue": "indigo-violet", "tone": 12, "intensity": 4 },
    "frame": { "hue": "indigo-violet", "tone": 16, "intensity": 12 },
    "card": { "hue": "indigo-violet", "tone": 12, "intensity": 5 }
  },
  "text": { "hue": "cobalt", "intensity": 3 },
  "display": { "hue": "indigo", "intensity": 3 },
  "role": {
    "tone": 50, "intensity": 50,
    "accent": "orange", "action": "blue", "agent": "violet",
    "data": "teal", "success": "green", "caution": "yellow", "danger": "red"
  }
}
```

Optional fields (`display`, `border`) are included in the JSON when present.

### Generated CSS

Two generation paths:

**Build-time** — `bun run generate:tokens` reads only from `tugdeck/themes/` (shipped themes) and produces:
- `styles/tug-base-generated.css` — Brio tokens. Imported by `tug-base.css`.
- `styles/themes/<name>.css` — override files for other shipped themes (e.g., `harmony.css`).

**Authoring-time** — the generator card runs `deriveTheme()` in the browser and sends the generated CSS string to the Vite dev middleware, which writes it to `~/.tugtool/themes/<name>.css` alongside the JSON.

### Live editing — Prototype pattern, Mac-style document model

New themes are always created by copying an existing theme (the Prototype pattern). There is no "blank" theme. The new theme inherits the prototype's recipe (`"dark"` or `"light"`), and the recipe is locked — it cannot be changed after creation. The generator card displays which recipe the theme uses (read-only label), but there is no Dark/Light toggle. Want a dark theme? Base it on Brio or another dark theme. Want a light theme? Base it on Harmony or another light theme.

The generator card follows Mac document conventions:

- **Initial state** — on open, the generator card loads the currently active app theme. If the app is running Harmony, the generator shows Harmony's values. Shipped themes are opened read-only — edits require creating a copy first (New/Prototype).
- **New** — prompts for a theme name (must be unique across both directories), then asks which existing theme to base it on (lists all available themes — shipped + authored). Copies that theme's values (including recipe) into `~/.tugtool/themes/<name>.json` and opens it for editing.
- **Open** — lists available themes (shipped + authored) and loads the selected theme's JSON into the generator card. Shipped themes open read-only. Authored themes open for editing.
- **Auto-save** — debounced at 500ms after the last change. Writes theme JSON and regenerated CSS to `~/.tugtool/themes/` via the Vite dev middleware. The preview updates immediately (in-browser `deriveTheme()`); the disk write is debounced. No explicit "Save" button. Only active for authored themes (shipped themes are read-only).
- **Apply** — injects the regenerated CSS into the running app via stylesheet injection. Happens automatically after each auto-save. The app-wide theme updates live.

The **preview section** is the only part of the generator card that updates on color changes. The authoring controls (hue pickers, tone/intensity strips, role selectors) are the stable surface. [L06]

### Theme loading

All theme loading goes through the Vite dev middleware:

1. Check `~/.tugtool/themes/<name>.json` (authored).
2. Check `tugdeck/themes/<name>.json` (shipped).
3. If neither exists, the theme is not available.

Since names are unique across both directories, there is no ambiguity — a theme exists in exactly one location.

CSS loading follows the same path through the middleware. The theme provider does not need to know whether a theme is shipped or authored — it always fetches via `/__themes/<name>.css`, and the middleware serves the right file.

**Listing all themes:** concatenate both directories. No deduplication needed since names are unique. Each entry includes `source` (`"shipped"` or `"authored"`) and `recipe` (`"dark"` or `"light"`) so consumers can sort and group without hardcoding knowledge of which names are shipped.

### App menu theme switching

The Tug > Theme menu lists available themes. The menu is populated dynamically using AppKit's `NSMenuDelegate.menuNeedsUpdate(_:)` pattern. Swift caches the theme list, updated whenever themes change (on save, on delete, on app launch). The web view pushes the updated theme list to Swift proactively via a **new** `window.webkit.messageHandlers` bridge endpoint (e.g., `themeListUpdated`) — this is a new bridge message, not an existing one. Swift does not query on demand.

- **Brio** is always the first item.
- **Other shipped themes** (harmony) follow.
- **Authored themes** from `~/.tugtool/themes/` appear after shipped themes.
- **Bluenote** is removed.
- The current active theme gets a checkmark.

The `set-theme` action takes a theme name string. For Brio, it removes the override stylesheet. For all other themes, it fetches CSS via `/__themes/<name>.css` and injects it.

### Recipe registry

Recipes are code. The registry maps recipe names to functions:

```ts
export const RECIPE_REGISTRY: Record<string, {
  fn: (recipe: ThemeRecipe) => DerivationFormulas;
}> = {
  dark:  { fn: darkRecipe },
  light: { fn: lightRecipe },
};
```

No `defaults` field — the default color choices for each recipe are not a code concept. They're whatever's in `brio.json` and `harmony.json`.

### Production scope

The theme generator is a dev-only tool. In production, only shipped themes (whose CSS is bundled) are available. The `~/.tugtool/themes/` directory and Vite dev middleware have no production equivalent. To make an authored theme available in production, copy it from `~/.tugtool/themes/` to `tugdeck/themes/` and commit. A production persistence story is deferred to a later phase.

## Changes

### 1. Create theme JSON files

Extract the `ThemeRecipe` data from `EXAMPLE_RECIPES.brio` and `EXAMPLE_RECIPES.harmony` into:
- `tugdeck/themes/brio.json`
- `tugdeck/themes/harmony.json`

Include all fields: `surface`, `text`, `display` (when present), `border` (when present), `role`.

### 2. Merge `theme-recipes.ts` into `theme-engine.ts`

Move `contrastSearch()`, `darkRecipe()`, and `lightRecipe()` into `theme-engine.ts`. Delete `theme-recipes.ts`.

### 3. Delete `EXAMPLE_RECIPES`

Replace with theme-loading functions that read from the two theme directories via middleware. For tests, import shipped JSON files directly via Bun's JSON import support (synchronous, no async test setup needed).

### 4. Remove the `formulas` escape hatch

Delete the `formulas?: DerivationFormulas` field from the `ThemeRecipe` interface. Remove all code paths that check for or use `recipe.formulas`. The recipe function is the only path — no bypass.

### 5. Fix the module header

Replace "Theme Derivation Engine — Tugways Theme Generator" with "Theme Engine".

### 6. Update `generate-tug-tokens.ts`

Read theme JSON files from `tugdeck/themes/` only (shipped themes). `brio` produces `tug-base-generated.css`. All others produce override CSS files in `styles/themes/`. The Vite auto-regeneration plugin should also watch `tugdeck/themes/*.json` so that manually editing a shipped theme JSON triggers token regeneration automatically.

### 7. Extend Vite dev middleware

Expand the existing theme middleware in `vite.config.ts`:

- `GET /__themes/list` — concatenate shipped (`tugdeck/themes/`) and user (`~/.tugtool/themes/`) directories. No deduplication needed (names are unique). Each entry includes a `source` field (`"shipped"` or `"authored"`) so consumers can sort and group correctly (Brio first, then other shipped themes, then authored). Response format: `{ themes: [{ name: "brio", recipe: "dark", source: "shipped" }, ...] }`.
- `GET /__themes/<name>.json` — load theme JSON. Check authored dir first, then shipped.
- `GET /__themes/<name>.css` — serve theme CSS. For shipped themes, serve from `styles/themes/`. For authored themes, serve from `~/.tugtool/themes/`.
- `POST /__themes/save` — write theme JSON and generated CSS to `~/.tugtool/themes/`. Rejects saves if the name already exists in `tugdeck/themes/` (shipped themes are read-only). Creates `~/.tugtool/themes/` directory on first save if it doesn't exist.

### 8. Update generator card

- **Delete `loadPreset`**, `DEFAULT_RECIPE`, `handleSelectBuiltIn`, and the old `ExportImportPanel`.
- **Initial state** — load the currently active app theme on open. Shipped themes open read-only; authored themes open for editing.
- **New** — prompt for name (reject if name exists in either directory), select prototype theme, copy to `~/.tugtool/themes/`, open for editing.
- **Open** — list available themes via `GET /__themes/list`, load selected theme via `GET /__themes/<name>.json`. Shipped themes open read-only.
- **Auto-save** — debounced 500ms, writes JSON + CSS to `~/.tugtool/themes/` via `POST /__themes/save`. Preview updates immediately in-browser. Only for authored themes.
- **Apply** — inject CSS app-wide via stylesheet injection after each auto-save.
- **Preview section** is the only content that updates on color changes. [L06]
- Remove all `formulas` state, `setFormulasAndRef`, and related escape-hatch code.
- After save, push updated theme list to Swift for menu cache refresh.

### 9. Remove Bluenote

- `tugapp/Sources/AppDelegate.swift`: Delete `setThemeBluenote` method and "Bluenote" menu item.
- `tugdeck/src/action-dispatch.ts`: Remove "bluenote" from valid theme names. Validate against available themes dynamically instead of a hardcoded array.
- `tugdeck/src/contexts/theme-provider.tsx`: Remove from `ThemeName` type and `themeCSSMap` if present.
- `tugdeck/styles/themes/bluenote.css`: Delete if exists.

### 10. Update theme provider

- `ThemeName` type should no longer be a hardcoded union. It should accept any string that corresponds to an available theme.
- `themeCSSMap` should be populated dynamically from available themes, not hardcoded.
- The pre-fetch in `main.tsx` should fetch available non-default themes dynamically, not just harmony.
- Switching to Brio removes the override stylesheet (no injection needed).
- All CSS fetching goes through `/__themes/<name>.css` — the middleware serves the right file.

### 11. Update Swift app menu

- Implement `NSMenuDelegate.menuNeedsUpdate(_:)` on the Theme submenu.
- Cache the theme list in Swift. Update the cache when the web view pushes a new list (on save, app launch) via the new `themeListUpdated` bridge message.
- Build menu items dynamically from the cache: Brio first, then other shipped themes, then authored themes.
- Add a checkmark to the active theme.
- Remove all hardcoded Brio/Bluenote/Harmony menu items and their `@objc` handler methods. Replace with a single dynamic handler that sends `set-theme` with the selected name.

### 12. Update tests

All test files: `EXAMPLE_RECIPES.brio` → `import brio from "../../themes/brio.json"` (synchronous Bun JSON import). Same for harmony. Remove preset-related test cases tied to `loadPreset`. Remove any `formulas` escape-hatch test cases.

### 13. Update all tuglaws documents

| Document | Updates needed |
|----------|---------------|
| `tuglaws/theme-engine.md` | Rewrite to reflect themes-as-JSON-files architecture. Document recipe vs theme vs theme output. Document two-directory storage with unique names. Document Brio as the base theme. Remove `EXAMPLE_RECIPES`, `formulas` escape hatch, "derivation" language, Bluenote. |
| `tuglaws/design-decisions.md` | Update `[D##]` entries referencing old naming or architecture. |
| `tuglaws/laws-of-tug.md` | Verify — no changes expected. |
| `tuglaws/token-naming.md` | Verify and update if needed. |
| `tuglaws/color-palette.md` | Verify and update if needed. |

All changes must adhere to the Laws of Tug:
- **L06**: Appearance changes through CSS and DOM, never React state.
- **L15**: Interactive controls use token-driven control states.
- **L16**: Every color-setting rule declares its rendering surface.

## Files Touched

| File | Change |
|------|--------|
| `tugdeck/themes/brio.json` | **Create** — shipped default dark theme |
| `tugdeck/themes/harmony.json` | **Create** — shipped light theme |
| `tugdeck/src/components/tugways/theme-engine.ts` | Merge in recipe functions; delete `EXAMPLE_RECIPES`; remove `formulas` from `ThemeRecipe`; add theme-loading utilities; fix module header |
| `tugdeck/src/components/tugways/theme-recipes.ts` | **Delete** |
| `tugdeck/src/components/tugways/cards/gallery-theme-generator-content.tsx` | Delete `loadPreset`, `DEFAULT_RECIPE`, `handleSelectBuiltIn`, `ExportImportPanel`, formulas escape hatch; implement New/Open/auto-save/Apply with Prototype pattern; load themes via middleware; shipped themes read-only |
| `tugdeck/scripts/generate-tug-tokens.ts` | Read from `tugdeck/themes/*.json`; `brio` → `tug-base-generated.css`; watch JSON for auto-regeneration |
| `tugdeck/vite.config.ts` | Extend theme middleware: two-directory listing, JSON/CSS serve via `/__themes/`, save to `~/.tugtool/themes/` with unique name enforcement, auto-create user themes dir |
| `tugdeck/src/action-dispatch.ts` | Remove Bluenote; validate themes dynamically; Brio = remove override |
| `tugdeck/src/contexts/theme-provider.tsx` | Remove hardcoded `ThemeName` union and `themeCSSMap`; populate dynamically; Brio = remove override; all CSS via middleware |
| `tugdeck/src/main.tsx` | Fetch available themes dynamically instead of hardcoded harmony pre-fetch |
| `tugapp/Sources/AppDelegate.swift` | Remove Bluenote; implement `NSMenuDelegate.menuNeedsUpdate(_:)` with cached theme list; add `themeListUpdated` bridge handler; remove hardcoded menu items and per-theme `@objc` handlers |
| `tugdeck/src/__tests__/theme-engine.test.ts` | Import shipped JSON directly |
| `tugdeck/src/__tests__/theme-accessibility.test.ts` | Import shipped JSON directly |
| `tugdeck/src/__tests__/theme-export-import.test.tsx` | Rewrite for New/Open/auto-save model |
| `tugdeck/src/__tests__/contrast-dashboard.test.tsx` | Import shipped JSON directly |
| `tugdeck/src/__tests__/gallery-theme-generator-content.test.tsx` | Rewrite for New/Open/auto-save; remove preset and formulas tests |
| `tugdeck/src/__tests__/cvd-preview-auto-fix.test.tsx` | Import shipped JSON directly |
| `tugdeck/src/__tests__/tug-color-strip.test.tsx` | Import shipped JSON directly |
| `tugdeck/src/__tests__/action-dispatch.test.ts` | Remove Bluenote test cases |
| `tugdeck/styles/themes/bluenote.css` | **Delete** if exists |
| `tuglaws/theme-engine.md` | Rewrite for new architecture |
| `tuglaws/design-decisions.md` | Update relevant entries |
| `tuglaws/laws-of-tug.md` | Verify |
| `tuglaws/token-naming.md` | Verify and update if needed |
| `tuglaws/color-palette.md` | Verify and update if needed |

## Scope Assessment

This is an architectural change that makes themes data instead of code, with a two-directory storage model (shipped in repo, authored in user home) with unique names enforced across both, the Prototype pattern for creating new themes (always copy from an existing theme), a Mac-style document model (New/Open/auto-save with 500ms debounce), and dynamic app menu population via a cached theme list pushed from the web view. The theme engine behavior doesn't change (same recipe functions, same derivation pipeline, same CSS output). What changes is where theme definitions live, how they're loaded (all through middleware), how the generator card interacts with them (auto-save + live apply, shipped themes read-only), and how the app menu discovers available themes.

The theme generator is a dev-only tool. Production persistence is deferred to a later phase.

This is plan-sized work, not a dash.
