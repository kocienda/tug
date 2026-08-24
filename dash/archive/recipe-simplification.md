# Roadmap: Recipe Simplification

## Problem

The current 7-parameter slider system (Surface Depth, Text Hierarchy, Control Weight, Border Definition, Shadow Depth, Signal Strength, Atmosphere) is vague, opaque, and largely useless for design iteration. Each slider secretly controls dozens of formula fields through interpolation. The names don't match what the sliders do. The user can't reach the specific values they care about.

Meanwhile, contrast enforcement is incomplete. The engine has `enforceContrastFloor()` machinery inside `evaluateRules()`, but it doesn't cover all element-on-surface pairings. Illegible combinations like light-on-light badges still ship.

## Goal

A theme recipe you can describe in words:

> "Colors based on BLUE with more filled-in shapes than outlined shapes on a light background."

Concretely, a recipe is:

1. **15 hue choices** (already working)
2. **Dark or light mode** (already working)
3. **Canvas character** — how the background looks (tone + intensity)
4. **Card frame character** — how the title bar looks (tone + intensity)
5. **Accent character** — how accent/role colors relate to content (tone + intensity)
6. **Contrast floor** — algorithmic guarantee, not a slider. Illegible combinations can't happen.

Six direct sliders replacing seven vague ones. Each slider moves one visible thing on screen. No hidden side effects.

## What stays

- **ThemeRecipe** interface — hue structure (surface, element, role) is correct
- **deriveTheme() pipeline** — resolveHueSlots, computeTones, evaluateRules architecture is sound
- **enforceContrastFloor()** — the binary-search tone clamping function works; it just needs wider application
- **RULES table** — the token derivation rules are correct
- **Hue pickers** in the Theme Generator UI
- **Mode toggle** and tugbank persistence

## What changes

### Phase 1: Enforce contrast everywhere

The engine already has `enforceContrastFloor()` doing binary-search in tone space. Currently it only runs on a subset of tokens during `evaluateRules()`.

**Change:** Every element-on-surface pairing in `ELEMENT_SURFACE_PAIRING_MAP` must be contrast-checked during derivation. If a pairing fails its role threshold (content: 75, control: 60, display: 60, informational: 60, decorative: 15), the element tone gets clamped before the token is emitted.

After this phase, illegible text/badge combinations are structurally impossible. The contrast tests become a verification of the guarantee, not a discovery tool.

### Phase 2: Replace parameters with direct controls

Replace the 7 abstract `RecipeParameters` fields with direct, concrete controls:

| New field | What it controls | Range |
|-----------|-----------------|-------|
| `canvasTone` | Background lightness | 0-100 |
| `canvasIntensity` | Background color saturation | 0-100 |
| `frameTone` | Card title bar lightness | 0-100 |
| `frameIntensity` | Card title bar color saturation | 0-100 |
| `accentTone` | Accent/role color lightness | 0-100 |
| `accentIntensity` | Accent/role color saturation | 0-100 |

Each field maps to a small, obvious set of formula values:

- `canvasTone` → `surfaceAppTone`, `surfaceCanvasTone`, and the surface layering tones derived relative to it
- `canvasIntensity` → `surfaceAppIntensity`, `surfaceCanvasIntensity`, etc.
- `frameTone` → `cardFrameActiveTone`, `cardFrameInactiveTone`
- `frameIntensity` → `cardFrameActiveIntensity`, `cardFrameInactiveIntensity`
- `accentTone` → filled control tones, badge tones, role signal tones
- `accentIntensity` → filled control intensities, badge intensities, signal intensity

The key difference from the current system: the engine derives all other formula values *algorithmically* from these 6 inputs + the mode + the contrast floor. Text tones, border tones, shadow alphas, etc. are all computed to satisfy contrast against the surfaces they render on. They're not independent knobs.

### Phase 3: Simplify compileRecipe

`compileRecipe()` currently interpolates 150+ formula fields between endpoint bundles. Replace with:

```
compileRecipe(mode, controls) → DerivationFormulas
```

Where `controls` is the 6 direct fields above. The function:

1. Sets canvas surface tones from `canvasTone` (with small offsets for layering: sunken, default, raised, overlay)
2. Sets canvas intensities from `canvasIntensity`
3. Sets frame tones/intensities from `frameTone`/`frameIntensity`
4. Sets accent tones/intensities from `accentTone`/`accentIntensity`
5. Derives text tones algorithmically to satisfy contrast against the surfaces
6. Derives border/divider tones from surface tones (fixed offset, contrast-checked)
7. Derives shadow alphas from mode (dark = heavier, light = lighter) — no slider needed

The endpoint IIFE system, the 14 endpoint bundles, and the linear interpolation machinery all go away.

### Phase 4: Update the UI

- Replace `PARAMETER_METADATA` with 6 entries matching the new fields
- Replace `ParameterSlider` instances (same component, new metadata)
- Remove `FormulaExpansionPanel` (no longer needed — controls map directly to visible things)
- Keep or simplify `RecipeDiffView`
- Update export/import to use new field names

### Phase 5: Clean up

- Delete `recipe-parameters.ts` endpoint IIFEs and interpolation code
- Delete `formula-constants.ts` (DARK_FORMULAS/LIGHT_FORMULAS become computed outputs, not hand-tuned inputs)
- Delete `endpoint-contrast.test.ts` (contrast is enforced algorithmically, not tested after the fact)
- Update `EXAMPLE_RECIPES` to use new control fields
- Remove dead code, dead tests, dead comments

## Migration

Existing saved recipes with the old `parameters` field should still load. `compileRecipe` can detect the old format and map it to reasonable defaults for the new controls.

## Non-goals

- Changing the RULES table or token naming
- Changing the hue picker UI
- Adding new token types
- Changing the contrast threshold values themselves

## Success criteria

1. You can describe a theme in words: "indigo on light, vivid accents, subtle frame"
2. Every slider moves exactly one visible thing
3. Illegible text is impossible — the engine prevents it
4. Editing formula values in code and reloading shows the change immediately
5. The recipe model is small enough to serialize as a one-line prompt
