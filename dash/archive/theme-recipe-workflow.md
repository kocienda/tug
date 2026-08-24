# Theme Recipe Workflow

*Cross-references: `[L##]` → [laws-of-tug.md](../tuglaws/laws-of-tug.md). `[D##]` → [design-decisions.md](../tuglaws/design-decisions.md). Color palette → [color-palette.md](../tuglaws/color-palette.md). Token naming → [token-naming.md](../tuglaws/token-naming.md). Theme engine → [theme-engine.md](../tuglaws/theme-engine.md).*

---

## The goal

A two-part workflow for creating themes:

**Part 1 — Author a theme recipe.** Define how a family of themes should look: the relationships between surfaces, elements, controls, and roles. A recipe contains actual formulas — rules that express "card frame tone = canvas tone - 7" or "content text tone = find a tone that passes contrast 75 against the canvas." A recipe author makes a handful of meaningful design decisions. The engine expands those decisions into ~200 formula fields. We need only a few recipes (dark, light, dark/stark, light/stark) to unlock dozens of themes.

**Part 2 — Create a theme from a recipe.** Pick a recipe. Pick 15 hues. Preview the result. Tune a few values if needed. Name it. Save it. Set it as the active theme. Done.

---

## What we have

**Solid:**
- 48 chromatic hues, named grays, hyphenated adjacency — the color palette
- Six-slot CSS token naming
- 15 hue picks on the Theme Generator card
- Hand-tuned brio dark constants that produce a good-looking theme
- The engine pipeline: hue resolution → rule evaluation → token emission
- `enforceContrastFloor()` — binary-search tone clamping, already in `evaluateRules()`
- `audit:tokens` tooling for lint, verify, pairings

**Broken:**
- "Formulas" that are just bags of constants — no actual formulas expressing relationships
- Light theme defined relative to dark instead of standing on its own
- No recipe concept — just two piles of ~200 numbers
- Sliders that interpolate between two piles of numbers rather than controlling anything meaningful
- Contrast enforcement that catches most but not all pairings
- Terminology confusion: "derivation engine," "mode," "formulas" that aren't formulas

---

## Terminology

| Old | New | Meaning |
|-----|-----|---------|
| derivation engine | theme engine | The pipeline that turns a recipe + colors into tokens |
| mode (field on ThemeRecipe) | recipe (field naming which recipe rules to use) | "dark" and "light" are recipe names, not modes. `ThemeRecipe.recipe` replaces `ThemeRecipe.mode`. |
| DARK_FORMULAS / LIGHT_FORMULAS | dark recipe constants / light recipe constants | Until we have real formulas, call them what they are |
| formulas (bag of ~200 numbers) | recipe constants | The current fixed values |
| recipe formula | a rule | An actual expression: `canvasTone - 7` or `contrastSearch(surface, 75)` |
| parameters (7 sliders) | (removed) | Replaced by recipe + direct controls |

---

## Key decisions

Resolved upfront to avoid ambiguity during planning and implementation.

**File structure:**
- New file `recipe-functions.ts` in `tugdeck/src/components/tugways/` — recipe functions, default controls, built-in registry, tone-space `contrastSearch`
- Rename `theme-derivation-engine.ts` → `theme-engine.ts` — retire the confusing "derivation" name
- Leave `recipe-parameters.ts` and `formula-constants.ts` alone until cleanup step deletes them
- The test file `theme-derivation-engine.test.ts` is an anti-pattern (slow, brittle, exact-value checks) — do not replicate its approach in new tests

**New `contrastSearch` function:**
- Lives in `recipe-functions.ts` (or a small utility it imports)
- Works with tone values (0-100), not OKLab L values
- Clean new implementation — not a wrapper around `enforceContrastFloor`
- `enforceContrastFloor` inside `evaluateRules` stays as a safety net until cleanup

**Pipeline simplification:**
- Delete `computeTones` and `MoodKnobs` entirely — the recipe function produces surface tones directly
- Pipeline becomes: recipe function → `resolveHueSlots` → `evaluateRules` → tokens
- No passthroughs, no legacy shims

**Structural/routing fields:**
- Hue slot dispatch, sentinel dispatch, hue name expressions, computed tone overrides — all go into the recipe function as constants in the return object
- No separate template objects — each recipe function is self-contained

**ThemeRecipe interface:**
- `mode` → `recipe: "dark" | "light"` (selects which recipe function to call)
- `parameters` → `controls?: Partial<RecipeControls>` (overrides on recipe defaults)
- `formulas` → deleted
- Hue fields (`surface`, `element`, `role`), `name`, `description` — unchanged

**Polarity is in the recipe, not a flag:**
- `darkRecipe()` knows it's dark — contrastSearch searches upward, surface tones are low
- `lightRecipe()` knows it's light — contrastSearch searches downward, surface tones are high
- No external "mode" flag needed by the pipeline

**Every field traces to a source:**
- A hue choice from the 15 colors the human picked
- A formula/rule derived from `RecipeControls` inputs (offsets, contrastSearch)
- As a last resort, a constant in the recipe function
- No orphan values with unexplained provenance

**Verification is threshold-based, not value-based:**
- No exact-value parity tests against old constants
- Verification: every element-on-surface pairing passes its contrast role threshold (content 75, control 60, display 60, informational 60, decorative 15)
- "Is it legible?" not "does it match the old number?"

**Default controls:**
- Exported from `recipe-functions.ts` alongside the recipe functions
- `defaultDarkControls`, `defaultLightControls` — each a complete `RecipeControls` object

**Recipe registry:**
- Built-in registry in `recipe-functions.ts` — an exported map with "dark" and "light" entries
- Each entry points to its recipe function and default controls
- Designed so custom recipes can be added later

---

## What a recipe actually is

A recipe is a small set of **rules** that express design relationships. Not ~200 constants — a handful of decisions that the engine expands.

### The decisions a recipe makes

**1. Surface character** (3-5 rules)
- Canvas tone: how light or dark is the base background?
- Surface layering: how do sunken, default, raised, overlay relate to canvas? (offsets, not absolute values)
- Surface intensity: how chromatic are the surfaces?

**2. Text character** (2-3 rules)
- Content text: what tone passes contrast against the canvas? (computed, not chosen)
- Text hierarchy: how much spread between content, muted, subtle, disabled? (a ratio or set of offsets from content text tone)

**3. Card frame** (2 rules)
- Frame tone and intensity relative to canvas
- Active vs inactive distinction (offset from base frame)

**4. Control character** (3-4 rules)
- Filled controls: how do button surfaces relate to the canvas? (tone offset + intensity)
- Outlined controls: text/border tone relative to content text
- Ghost controls: text tone relative to content text, with lighter emphasis

**5. Role presentation** (2 rules)
- Role tone: how light/dark are role-colored fills? (relative to canvas, like filled controls)
- Role intensity: how vivid are role colors?

**6. Structural** (constants, not rules)
- Shadow alphas per size tier (mode-specific constants)
- Border/divider tones (offsets from surface tones)
- Hue routing (which hue slot each token group uses)

### What's a rule vs what's a constant

A **rule** expresses a relationship: `contentTextTone = contrastSearch(canvasTone, 75)`. Change the canvas tone, and the text tone adjusts to maintain legibility.

A **constant** is a fixed value: `shadowMediumAlpha = 12`. It doesn't depend on other values. Every recipe needs some constants, but the *character* of a recipe lives in its rules.

The current system has ~200 constants and zero rules. The new system should have ~20-30 rules and ~50 constants, with the remaining ~120 fields derived by the engine from those rules.

### Implementation: a recipe is a function

No DSL, no rule interpreter, no declarative rule objects. A recipe is a TypeScript function that takes a few control inputs and returns the full `DerivationFormulas`. The rules *are* the code.

#### RecipeControls interface

```ts
interface RecipeControls {
  canvasTone: number;       // how light/dark the background is
  canvasIntensity: number;  // how chromatic the surfaces are
  frameTone: number;        // card title bar lightness
  frameIntensity: number;   // card title bar color saturation
  roleTone: number;         // role-colored fill lightness
  roleIntensity: number;    // role color vividness
}
```

#### Example: dark recipe function

```ts
function darkRecipe(controls: RecipeControls): DerivationFormulas {
  const c = controls;

  // Text: find tones that pass contrast against the canvas
  const contentTone = contrastSearch(c.canvasTone, 75);
  const mutedTone = contentTone - 6;
  const subtleTone = contentTone - 14;
  const disabledTone = contentTone - 22;

  return {
    // ===== Surface character =====
    surfaceAppTone: c.canvasTone,
    surfaceCanvasTone: c.canvasTone,
    surfaceSunkenTone: c.canvasTone - 2,
    surfaceDefaultTone: c.canvasTone + 7,
    surfaceRaisedTone: c.canvasTone + 6,
    surfaceOverlayTone: c.canvasTone + 9,
    surfaceInsetTone: c.canvasTone + 1,
    surfaceContentTone: c.canvasTone + 1,
    surfaceScreenTone: c.canvasTone + 11,
    atmosphereIntensity: c.canvasIntensity,
    surfaceAppIntensity: c.canvasIntensity,
    surfaceCanvasIntensity: c.canvasIntensity,
    // ... remaining surface intensities as offsets from canvasIntensity

    // ===== Text character =====
    contentTextTone: contentTone,
    mutedTextTone: mutedTone,
    subtleTextTone: subtleTone,
    disabledTextTone: disabledTone,
    placeholderTextTone: contentTone - 20,
    contentTextIntensity: 4,                // constant: near-neutral text
    // ... remaining text intensities

    // ===== Card frame =====
    cardFrameActiveTone: c.frameTone,
    cardFrameActiveIntensity: c.frameIntensity,
    cardFrameInactiveTone: c.frameTone - 1,
    cardFrameInactiveIntensity: c.frameIntensity - 8,

    // ===== Controls =====
    filledSurfaceRestTone: c.canvasTone + 10,
    filledSurfaceHoverTone: c.canvasTone + 12,
    filledSurfaceActiveTone: c.canvasTone + 14,
    outlinedTextRestTone: contentTone,
    ghostTextRestTone: contentTone - 5,
    // ... remaining control fields

    // ===== Role presentation =====
    signalIntensityValue: c.roleIntensity,
    // ... role tone fields as offsets from c.roleTone

    // ===== Constants (don't depend on controls) =====
    shadowMediumAlpha: 12,
    shadowLargeAlpha: 18,
    // ... remaining shadow, hue routing, structural fields
  };
}
```

Every line is a rule or a constant. `contentTone - 6` is the rule for muted text. `canvasTone + 7` is the rule for the default surface. `contrastSearch(canvasTone, 75)` is the rule for content text. You read the function, you see every relationship.

#### How overrides work

```ts
// Default dark theme
const formulas = darkRecipe(defaultDarkControls);

// User nudges canvas tone darker via slider
const formulas = darkRecipe({ ...defaultDarkControls, canvasTone: 3 });
// → text tones recalculate via contrastSearch, surfaces shift, all relationships hold
```

#### How to build it

1. **Write a one-off script** that reads current `DARK_FORMULAS` and reverse-engineers the offsets: "surfaceSunkenTone (11) = surfaceAppTone (5) + 6, so the offset is +6." This generates the initial function body mechanically.
2. **Hand-review** the generated function: group related fields, identify which values should become `contrastSearch` calls vs offsets vs constants.
3. **Verify:** call `darkRecipe(defaultDarkControls)`, feed into `deriveTheme`, and verify all element-on-surface contrast pairings pass their role thresholds.

This is ~25 values. The engine expands them to ~200 fields. Dark and light are separate recipe functions with their own rules — you don't get a light theme by changing inputs to the dark recipe. You call `lightRecipe()`.

---

## What the Theme Generator card becomes

### Part 1 panel: Recipe authoring (for recipe authors)

Not shown by default. Accessed via a "Recipe" tab or panel toggle. Shows:
- The recipe's rules in an editable form
- A live preview of the expanded constants
- The ability to save/load/name recipes

This is the power-user tool. Most theme creators never touch it.

### Part 2 panel: Theme creation (the default view)

This is what you see when you open the Theme Generator:

1. **Recipe picker** — pick dark, light, dark/stark, light/stark (or a custom recipe)
2. **15 hue picks** — the existing hue pickers, unchanged
3. **A few direct controls:**
   - Canvas tone (how light/dark is the background — recipe provides the default, user can shift it)
   - Canvas intensity (how chromatic — same)
   - Role intensity (how vivid are accent/action/success/etc.)
   - Maybe 1-2 more if needed — but keep it under 6
4. **Live preview** — the card preview, as now
5. **Name and save** — name the theme, save it, set as active

The controls in Part 2 are *overrides* on the recipe defaults. The recipe says canvas tone = 5 for dark. The user can nudge it to 8. The rules still apply — text tone recalculates, contrast is maintained.

---

## What changes in the engine

### New pipeline

```
ThemeRecipe (hues + recipe name + control overrides)
    │
    ▼
recipe function (darkRecipe / lightRecipe)
    applies controls, contrastSearch, offsets
    │
    ▼
DerivationFormulas (~200 fields)
    │
    ▼
resolveHueSlots → evaluateRules → tokens
```

The recipe function is where the rules execute. It takes `RecipeControls` (with user overrides merged onto recipe defaults), runs `contrastSearch` for text tones, applies offsets for surfaces, and returns the complete `DerivationFormulas`. No `computeTones`, no `MoodKnobs` — the recipe function handles everything those did.

### Make contrast enforcement complete

`enforceContrastFloor` already works inside `evaluateRules`. Ensure every element-on-surface pairing in `ELEMENT_SURFACE_PAIRING_MAP` is covered. After this, illegible text is structurally impossible for any recipe + color combination.

### Kill the old parameter system

- Delete `RecipeParameters` (7 abstract sliders)
- Delete `compileRecipe()` (endpoint interpolation)
- Delete `formula-constants.ts` (DARK_FORMULAS/LIGHT_FORMULAS as standalone files)
- Delete `FormulaExpansionPanel`, `RecipeDiffView`
- The recipe constants that brio uses today become the *output* of `darkRecipe(defaultDarkControls)`, not hand-maintained input

---

## Tooling and efficiency

### Use `audit:tokens` — not manual grep

Every step that touches tokens, CSS, or pairings must verify with `bun run audit:tokens` subcommands — not manual grep/inspection. The tool runs in <100ms and is authoritative:

| Subcommand | When to use |
|------------|-------------|
| `lint` | After any CSS or token change — checks annotations, aliases, pairings |
| `verify` | After any pairing map change — cross-checks CSS `@tug-pairings` against the map |
| `pairings` | To discover actual element-on-surface relationships in component CSS |
| `rename --apply` | For bulk token renames across all files |

### Write whole files, don't line-edit

The formula files (`formula-constants.ts`, `recipe-parameters.ts`) are 600-1600 lines of structured key-value data. When making bulk changes (replacing constants with rule expressions, rewriting `compileRecipe`, building `expandRules`):

- **Use the Write tool to replace the entire file** after reading and transforming it. Do not make 100 individual Edit calls — that's slow, error-prone, and burns tokens.
- **Write one-off scripts for mechanical transforms.** For example, a script that reads the current DARK_FORMULAS constants and generates the initial dark recipe rules file, computing offsets from the canvas tone. Run it once, verify the output, commit.
- **Use `bun test` and `bun run generate:tokens` as the verification loop** — not line-by-line inspection.

The goal: a coder-agent working on these files should spend its time on *design decisions* (which values become rules, which stay constants), not on *text editing mechanics*.

---

## Execution sequence

**Step 1: Write the dark recipe function.** Create `recipe-functions.ts`. Write `RecipeControls` interface, `contrastSearch`, `darkRecipe()`, `defaultDarkControls`, and the built-in registry. Verify that all contrast pairings pass thresholds.

**Step 2: Write the light recipe function.** Independent from dark — not derived from it. Write `lightRecipe()` and `defaultLightControls`. Verify that all contrast pairings pass thresholds. This is where the light theme finally stands on its own.

**Step 3: Complete contrast enforcement.** Audit `evaluateRules` coverage using `bun run audit:tokens pairings`. Fix any gaps. After this step, illegible combinations are impossible.

**Step 4: Wire into the Theme Generator.** Replace sliders with recipe picker + direct controls. Wire `expandRules` into the live preview pipeline.

**Step 5: Clean up.** Delete old parameter system, old constants, old components. Rename "derivation engine" to "theme engine" throughout. Verify with `bun run audit:tokens lint` and `bun run audit:tokens verify`.

---

## Laws of Tug compliance

Every change in this roadmap must adhere to the Laws of Tug. Key laws that bear on this work:

- **L06 (Appearance through CSS/DOM, never React state).** The Theme Generator's live preview uses `liveTokenStyle` inline CSS — appearance changes bypass React state. The new recipe picker and direct controls must follow the same pattern: slider drags update the preview through direct `setThemeOutput(deriveTheme(...))` calls, not through React state driving re-renders for appearance. The existing debounced handler pattern (immediate ref update for slider tracking, debounced `deriveTheme` for preview) is L06-compliant and carries forward.

- **L15 (Six-slot token convention).** The token naming system is unchanged. All `--tug-base-*` tokens continue to follow `<plane>-<component>-<constituent>-<emphasis>-<role>-<state>`. No abbreviated slot values — use full names throughout (e.g., `shadowMediumAlpha`, not `shadowMdAlpha`).

- **L16 (Every color-setting rule declares its rendering surface).** All `@tug-renders-on` annotations remain in place. New CSS added for recipe picker or controls must include annotations. `audit:tokens lint` enforces this.

- **L17 (Component alias tokens resolve in one hop).** The `COMPONENT_ALIASES` map in the Theme Generator continues to resolve component tokens to `--tug-base-*` in one hop.

- **L18 (Element/surface as canonical vocabulary).** The recipe rules system uses element and surface as its vocabulary. Rules that compute text tones are computing *element* tones against *surface* tones. Contrast enforcement pairs elements with surfaces.

### Design decisions that bear on this work

- **D70** (OKLCH color palette) — the recipe rules system operates in tone/intensity space, consistent with the palette's OKLCH foundation. [color-palette.md](../tuglaws/color-palette.md)
- **D71** (three-tier tokens) — palette → base → component tier architecture is unchanged. Recipes produce base-tier values; component aliases resolve in one hop. [token-naming.md](../tuglaws/token-naming.md)
- **D80** (`--tug-color()` notation) — build-time expansion is unchanged. Recipes produce the numeric inputs that `--tug-color()` consumes.
- **D81** (machine-auditable pairings) — strengthened: every pairing in `ELEMENT_SURFACE_PAIRING_MAP` is contrast-enforced during derivation, not just audited after the fact.
- **D82** (four semantic text types) — recipe text rules map directly to the four types: content (prose), control (interactive), display (titles), informational (metadata). Each has its own contrast role. [token-naming.md](../tuglaws/token-naming.md)
- **D83** (five contrast roles) — thresholds are unchanged: content 75, control 60, display 60, informational 60, decorative 15. Recipe rules use `contrastSearch` with these thresholds.

---

## What we're NOT doing

- Changing the color palette or hue picker
- Changing the token naming system
- Changing the RULES table in `evaluateRules`
- Changing contrast threshold values
- Building a visual recipe editor (the recipe authoring tool is for later — for now, recipes are authored in code)
- Adding new token types
