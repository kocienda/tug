# Theme System Simplification

Strip the theme system down to its essentials. Remove the entire `ThemeSpec` / recipe / formula / JSON / generation pipeline. Keep the color palette, token naming, pairing audit, and hand-editable CSS files.

This document is the implementation plan for the refactor. It resolves the open questions about Swift canvas color, PostCSS, production theme loading, the minimum viable accessibility card, and the thin test surface.

## Goal

After this refactor, the theme system should have exactly four moving parts:

1. `styles/tug-base-generated.css` — the base token file for the default `brio` theme. Keep the filename in this pass to avoid churn, but it is no longer generated.
2. `styles/themes/*.css` — optional override themes. In this pass, keep only `harmony.css`.
3. `styles/tug-theme-override.css` — dev-only copied override file. Empty when the active theme is `brio`.
4. `postcss-tug-color` + `palette-engine.ts` — the browser-side expansion of `--tug-color(...)` into normal CSS during Vite dev/build.

Everything else is deleted or rewritten around those files.

## Locked Decisions

### 1. CSS Files Are The Source Of Truth

The runtime theme system is file-based and CSS-first.

- `brio` lives in `styles/tug-base-generated.css`
- `harmony` lives in `styles/themes/harmony.css`
- `bluenote` is deleted in this pass
- `themes/*.json` are deleted in this pass
- `ThemeSpec`, `deriveTheme()`, formulas, recipes, and theme CSS generation are removed from the app runtime and build pipeline

There is no JSON theme source anymore. The CSS files are the source.

### 2. PostCSS Stays, But Only As CSS Processing

PostCSS is not the theme system. It is only the browser CSS processor.

- Keep `postcss-tug-color` configured in `vite.config.ts`
- Keep authoring `--tug-color(...)` in the checked-in CSS files
- Let Vite/PostCSS expand those values in dev and production build
- Do not introduce a new theme-generation pipeline
- Do not introduce a separate flattening step in this refactor

This means the browser still gets normal CSS through Vite, but there is no theme derivation step before that.

### 3. Swift Canvas Color Comes From CSS Metadata, Not Derivation

The existing `deriveTheme()` -> `deriveCanvasParams()` -> `THEME_CANVAS_PARAMS` path is removed completely.

Replace it with one explicit CSS metadata property:

```css
body {
  --tug-host-canvas-color: #0d0f16;
}
```

Contract:

- `styles/tug-base-generated.css` must define `--tug-host-canvas-color`
- every override theme file in `styles/themes/*.css` must also define `--tug-host-canvas-color`
- the value is a literal 6-digit hex string
- for non-base themes, the override file stores the final host-window canvas color for that theme

Why this is the right simplification:

- Swift can read the active theme name from `tugbank`
- Swift can read the active theme CSS file from a well-known path on disk
- Swift only needs one plain hex color, not `hue/tone/intensity`
- Swift no longer needs PostCSS, `ThemeSpec`, or palette math
- the browser no longer needs `THEME_CANVAS_PARAMS`, `BASE_THEME_SPEC`, or `canvasColorHex()`

This is intentional duplication of exactly one value per theme in exchange for deleting the entire derivation path.

### 4. Dev Theme Activation Is Just CSS File Copy

`POST /__themes/activate` becomes a file-copy endpoint:

- `brio` -> write an empty `styles/tug-theme-override.css`
- `harmony` -> copy `styles/themes/harmony.css` to `styles/tug-theme-override.css`
- parse `--tug-host-canvas-color` from the source CSS file and return it in the response

Response shape:

```json
{ "theme": "harmony", "hostCanvasColor": "#f2f3fa" }
```

No subprocess. No `generate-theme-override.ts`. No JSON theme lookup. No formula cache. No `require()` of `theme-engine`.

### 5. Production Theme Activation Is Just Link Swap

Production keeps the current basic model:

- base theme is the CSS already imported by the app
- non-base theme is a `<link id="tug-theme-override">` to `/assets/themes/<name>.css`

Changes in this refactor:

- the production theme file is the built form of `styles/themes/<name>.css`
- after the link loads, read `--tug-host-canvas-color` from the applied CSS, normalize it to a literal `#rrggbb` string, and send that to Swift
- if switching back to `brio`, remove the override link, read `--tug-host-canvas-color` from the base CSS, normalize it to `#rrggbb`, and send that to Swift

Important startup requirement:

- in production, if the saved initial theme is not `brio`, the initial override theme must be applied before first visible paint (not merely after interactive mount) so the app does not flash `brio` and then restyle
- startup mechanism (single rule): in `main.tsx`, before mounting React, synchronously insert/update `<link id="tug-theme-override">` for non-`brio` and await its `load` event before first render; for `brio`, ensure the override link is absent

The current startup path does not reliably do this without `THEME_CANVAS_PARAMS`. This refactor must fix it.

### 6. The Accessibility Card Becomes Live CSS Inspection

The card is renamed functionally to **Theme Accessibility**. The file path can stay as-is in this pass if that reduces churn, but the UI and docs should describe it as Theme Accessibility, not Theme Generator.

The card no longer loads theme JSON and no longer runs `deriveTheme()`.

It inspects the live theme already applied to the app.

Minimum viable support:

- keep the token list viewer
- keep the contrast dashboard
- keep the CVD preview
- keep a diagnostics section, but redefine it as live accessibility findings, not derivation findings

What is removed:

- color pickers
- recipe/model display
- ThemeSpec validation/migration logic
- generated CSS export logic
- `floor-applied` and `structurally-fixed` diagnostics from `ThemeOutput.diagnostics`

### 7. Tests Stay Thin

Keep the test surface thin, but not so thin that the new enumeration path is untested.

Required automated tests after this refactor:

1. a thin dev test for `POST /__themes/activate`
2. a thin production test for the link-swap behavior
3. a small extractor test for the `TUG_TOKEN_NAMES` build-time scan
4. a small snapshot-helper test covering runtime value capture and probe-based color resolution

Delete formula/recipe/theme-engine/theme-generator UI tests that are coupled to the system being removed.

## Runtime Contract After Simplification

| Concern | Dev | Production |
|---|---|---|
| Base theme | `styles/tug-base-generated.css` imported normally | built app CSS |
| Active override | `styles/tug-theme-override.css` copied from `styles/themes/<name>.css` | `<link id="tug-theme-override" href="/assets/themes/<name>.css">` |
| Theme activation | `POST /__themes/activate` copies CSS file | `activateProductionTheme()` swaps/removes link |
| Host canvas color | parsed from source CSS and returned by endpoint as `#rrggbb` | read from applied CSS after link load, normalized to `#rrggbb` before sending to Swift |
| Theme source | repo CSS files | built CSS assets derived from repo CSS files |
| PostCSS role | expand `--tug-color(...)` during Vite CSS HMR | expand `--tug-color(...)` during `vite build` |

## Minimum Viable Accessibility Card

### `--tug-*` enumeration (Phase 3 contract)

Browsers do not expose a complete list of declared custom-property names via `getComputedStyle` or a cheap DOM API. **Do not** use `document.styleSheets` / rule walking as the primary enumerator (CORS, dev/prod differences, fragility).

**Chosen approach: build-time name list from repo CSS, runtime values from the cascade.**

1. **Sources scanned at build time (or via Vite virtual module):**
   - `styles/tug-base-generated.css`
   - every file matching `styles/themes/*.css` (union so override-only tokens are included)

2. **Extraction algorithm:**
   - read files as UTF-8 text
   - strip block comments `/* … */` so commented declarations do not pollute the list
   - match **declaration names only**: names starting with `--tug-` on the left-hand side of a declaration (only whitespace before `:`); e.g. regex `--tug-[a-z0-9-]+(?=\s*:)` (lookahead before the colon)
   - union, dedupe, sort lexicographically for stable UI order

3. **Delivery into the app (pick one):**
   - **Preferred:** a Vite plugin exposing a virtual module (e.g. `virtual:tug-token-names`) that exports `TUG_TOKEN_NAMES: readonly string[]`, regenerated when those CSS files change
   - **Acceptable:** a small script (e.g. `bun run extract:tug-token-names`) that emits a thin `src/generated/tug-token-names.ts` from the same scan — this is **token inventory only**, not `ThemeSpec` / canvas metadata

4. **Runtime snapshot helper** (e.g. `src/components/tugways/theme-live-snapshot.ts`):
   - iterate **`TUG_TOKEN_NAMES`**, not an open-ended DOM enumeration
   - for each name, read the **authoring/cascade string** with `getComputedStyle(referenceElement).getPropertyValue(...)` (use the same element the theme applies to — today tokens live on `body` in base CSS; keep that consistent or document `documentElement` vs `body` if both appear)
   - use a hidden probe element with `color`, `background-color`, or `border-color` set to `var(--token)` only where resolved colors are needed (contrast, CVD, swatches); non-color tokens can show raw values only

5. **Non-goals for this pass:** parsing minified bundles for names; treating `var(--tug-foo)` on the value side as new top-level names unless `foo` is declared in the scanned files.

### Data Source

Add a small runtime helper, for example `src/components/tugways/theme-live-snapshot.ts`, with this job:

1. Walk the build-derived **`TUG_TOKEN_NAMES`** list and read live values from the active cascade
2. Keep the raw custom-property strings for the token list viewer
3. Resolve color-valued tokens to actual browser colors using a hidden probe element where needed
4. Convert the resolved browser color to OKLCH for contrast/CVD calculations

Implementation detail:

- **enumeration:** build-time scan of repo CSS → `TUG_TOKEN_NAMES` (see contract above); not `getComputedStyle` for discovery of names
- **values:** `getComputedStyle(...).getPropertyValue(name)` per known name
- use a hidden probe element with `color`, `background-color`, or `border-color` set to `var(--token)` to force browser resolution of color-valued tokens
- convert the resolved browser color to OKLCH using a small shared runtime helper
- the required math already exists in parts of `theme-accessibility.ts`, `palette-engine.ts`, and `scripts/convert-hex-to-tug-color.ts`
- if necessary, move the color-conversion helpers into a shared runtime module instead of depending on the old theme engine

### What Stays

- `theme-pairings.ts`
- `validateThemeContrast(...)`
- `checkCVDDistinguishability(...)`
- `CVD_SEMANTIC_PAIRS`
- the token audit scripts and `@tug-pairings` conventions

These should become independent of `theme-engine.ts` types.

### What Diagnostics Means After This Refactor

The diagnostics section becomes:

- failing pair list
- marginal pair list
- unresolved token references, if any
- CVD warnings and suggestions

It no longer means:

- floor applied
- structurally fixed
- any derivation-time clamping report

That information disappears with the derivation engine, and that is acceptable in this pass.

## Scope Boundaries

This refactor simplifies the theme system. It does **not** do a full component token-contract rewrite.

Explicitly out of scope for this pass:

- rebuilding all component alias layers
- eliminating checkbox/switch role injection
- building a new theme authoring UI
- inventing a new token derivation tool
- renaming every theme file and symbol for aesthetics

What stays as-is:

- palette engine
- seven-slot token naming
- `@tug-pairings` and the audit scripts
- component CSS that already consumes `--tug-*` tokens

What changes later in a separate pass:

- stricter token-to-component contract
- component-local alias standardization
- cleanup of remaining ad-hoc exceptions

## Ordered Implementation Plan

Do **not** delete `theme-engine.ts` first. Replace the runtime contract first, then delete the old pipeline.

### Phase 1 — Cut The Runtime Over To CSS Files

1. Add `--tug-host-canvas-color` to:
   - `styles/tug-base-generated.css`
   - `styles/themes/harmony.css`
   - `styles/themes/bluenote.css` temporarily, only so the runtime still works until `bluenote` is deleted
2. Add a tiny CSS parser helper for `--tug-host-canvas-color`
3. Rewrite `vite.config.ts`:
   - `themeOverridePlugin` copies CSS files instead of generating from JSON
   - `activateThemeOverride()` copies CSS files instead of running a subprocess
   - `handleThemesActivate()` returns `hostCanvasColor`
   - `controlTokenHotReload()` watches `styles/themes/*.css` and re-copies the active override
   - remove generation triggers tied to `theme-engine.ts`, `recipes/*.ts`, and `themes/*.json`
4. Keep `css-imports.ts` as the CSS HMR boundary

Exit criteria:

- dev server starts with the tugbank-selected theme using only CSS-file copy
- switching themes in dev updates the app without `ThemeSpec` or JSON
- editing `harmony.css` while harmony is active hot-reloads correctly

### Phase 2 — Simplify Theme Provider And Startup

1. Rewrite `theme-provider.tsx`:
   - remove `deriveTheme`, `ThemeSpec`, `THEME_CANVAS_PARAMS`, and `deriveCanvasParams`
   - `setTheme()` in dev uses `hostCanvasColor` from the activate endpoint response
   - `setTheme()` in production swaps the link and sends the host color after the CSS loads
2. Rewrite `main.tsx`:
   - remove `BASE_THEME_SPEC`
   - remove the initial JSON fetch for `/__themes/<name>.json`
   - remove `registerInitialCanvasParams(...)`
   - stop deriving canvas params before React mounts
   - ensure the saved non-`brio` theme is applied before first visible paint, not after a later provider effect
3. Remove the old canvas derivation path:
   - `canvas-color.ts` can be deleted if nothing else needs it
   - `sendCanvasColor()` becomes a simple "post this normalized `#rrggbb` string to Swift" helper

Exit criteria:

- initial theme is applied correctly in production
- switching themes in production loads the right built CSS file
- Swift host color sync works in dev and production without derivation
- production startup does not visibly flash `brio` before an override theme is applied

### Phase 3 — Rebuild The Accessibility Card Around Live CSS

1. Implement **`TUG_TOKEN_NAMES`** delivery (Vite virtual module preferred, or thin codegen script) per the enumeration contract in *Minimum Viable Accessibility Card*
2. Gut `gallery-theme-generator-content.tsx`
3. Remove:
   - ThemeSpec loading
   - recipe state
   - JSON validation/migration
   - export/generation helpers
   - ThemeOutput dependency
4. Add the live snapshot helper (iterates `TUG_TOKEN_NAMES`, `getComputedStyle` per name, probes for color resolution) and feed:
   - token list viewer from raw token values
   - contrast dashboard from resolved colors + `theme-pairings.ts`
   - CVD preview from resolved colors + semantic token list
   - diagnostics from current failures/warnings only
5. Rename the card in the UI to Theme Accessibility

Exit criteria:

- the card works with only live CSS applied to the page
- the card has no import from `theme-engine.ts`
- any still-needed shared types/helpers used by `theme-accessibility.ts` are extracted or redefined before `theme-engine.ts` is deleted; this is not just a mechanical import cleanup
- the card still shows token inventory, contrast results, and CVD preview
- token inventory rows are driven by the build-derived name list plus live cascade values, not stylesheet walking

### Phase 4 — Delete The Old Theme Pipeline

Delete these files:

- `src/components/tugways/theme-engine.ts`
- `src/components/tugways/recipes/dark.ts`
- `src/components/tugways/recipes/light.ts`
- `src/theme-css-generator.ts`
- `scripts/generate-theme-override.ts`
- `scripts/generate-tug-tokens.ts`
- `themes/brio.json`
- `themes/harmony.json`
- `themes/bluenote.json`
- generated files that only existed for theme derivation:
  - `src/generated/base-theme.ts`
  - `src/generated/theme-canvas-params.ts`

Also delete:

- `styles/themes/bluenote.css`

Then update any remaining imports and dead code paths.

Exit criteria:

- no runtime or build code imports `ThemeSpec` or `deriveTheme`
- no theme JSON files remain
- only `brio` and `harmony` exist

### Phase 5 — Trim Tests And Rewrite Docs

Keep only:

- one thin test for `POST /__themes/activate`
- one thin test for production link swap
- one small extractor test for the `TUG_TOKEN_NAMES` build-time scan
- one small snapshot-helper test for runtime value capture / color probing

Delete or gut:

- theme engine tests
- formula/recipe tests
- theme middleware tests that assume JSON/spec generation
- Theme Generator UI tests tied to recipe state

Rewrite docs:

- `tuglaws/theme-engine.md` — rewrite as "theme system" doc for CSS-first runtime
- `tuglaws/component-authoring.md` — state clearly that this pass does not rewrite every component contract, but no new ad-hoc theme logic should be introduced
- `tuglaws/color-palette.md` and `tuglaws/token-naming.md` should need only small or no changes

## File-By-File Worklist

### Rewrite

- `tugdeck/vite.config.ts`
- `tugdeck/src/contexts/theme-provider.tsx`
- `tugdeck/src/main.tsx`
- `tugdeck/src/components/tugways/cards/gallery-theme-generator-content.tsx`
- `tugdeck/src/components/tugways/theme-accessibility.ts` (extract or redefine any remaining shared types/helpers needed after `theme-engine.ts` deletion)
- `tugdeck/styles/tug-base-generated.css`
- `tugdeck/styles/themes/harmony.css`

### Add

- a tiny shared CSS metadata parser/helper
- **`TUG_TOKEN_NAMES`** delivery (Vite virtual module or `extract:tug-token-names` + generated inventory module)
- a live theme snapshot helper for the accessibility card
- thin tests for activate endpoint and production link swap
- one small extractor test for the `TUG_TOKEN_NAMES` scan rules
- one small snapshot-helper test for runtime value capture / color probing

### Delete

- all derivation/generation files listed in Phase 4
- `tugdeck/styles/themes/bluenote.css`
- obsolete theme tests

## Acceptance Criteria

This refactor is complete when all of the following are true:

1. The app runs without any `ThemeSpec`, recipe, formula, or theme JSON dependency.
2. `brio` is the base CSS and `harmony` is the only override theme.
3. Editing `styles/tug-base-generated.css` hot-reloads the app.
4. Editing the active theme file in `styles/themes/` hot-reloads the app.
5. Switching themes in dev is a simple CSS-file copy and returns a host canvas hex.
6. Switching themes in production is a simple CSS link swap.
7. Swift host color sync works from the explicit `--tug-host-canvas-color` property.
8. The Theme Accessibility card works from live CSS only.
9. The remaining theme-specific tests are the two thin theme-switching tests plus one small extractor test and one small snapshot-helper test for the accessibility card path.
10. No generated TS theme metadata files remain (`ThemeSpec`, canvas params, base-theme TS). A read-only **`TUG_TOKEN_NAMES`** list extracted from source CSS for the accessibility card is allowed — it is inventory only, not derivation — and a virtual module is preferred over a committed generated file.

## Notes

- Keep the filename `tug-base-generated.css` in this pass even though it is no longer generated. Renaming it is unnecessary churn.
- The style inspector's formula display can be removed with the theme engine. Its token-chain display may stay if useful.
- This plan intentionally chooses explicitness over cleverness. One literal host-color hex per theme is cheaper than maintaining the derivation system.
