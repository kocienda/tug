# Semantic Formula Architecture

A theme recipe is a design intent expressed as a set of formula choices. This document
lays out how to collapse the derivation rule system to one definition per distinct
formula, add a semantic layer that maps design intent to formula parameters, and
demonstrate the result by creating a light theme recipe from a prompt.

---

## Context

The theme derivation engine takes 17 inputs (7 structural hues, 7 role hues, 3 mood
knobs) and produces 373 CSS tokens through 158 chromatic rules. Analysis shows those
158 rules reduce to ~22 distinct mathematical formulas — the rest are role-multiplied
copies that differ only by which hue slot they reference.

The current code expresses these formulas by inlining the same expression in every
rule entry. This makes it hard to see what a recipe actually *decides* versus what it
merely *repeats*. A recipe should be a small set of semantic choices — "dark
background, light foreground, prominent filled controls, subtle borders" — not 198
individual formula field values.

The iOS word game demonstrates this: BLUE/DARK and BLUE/LIGHT share the same color
input but differ in design intent. The description "Colors based on BLUE with more
filled-in shapes on a dark background" fully captures what makes BLUE/DARK different
from BLUE/LIGHT. The formula set is the concrete realization of that description.

---

## Part 1: Named Formula Builders + Recipe Rename

### Rename: Brio → Dark at the recipe level

`BRIO_DARK_FORMULAS` is renamed to `DARK_FORMULAS`. The name "Brio" describes a
specific theme (dark recipe + cobalt/violet/indigo color palette), not the recipe
itself. The recipe is simply "Dark" — any color palette fed through the Dark recipe
produces a dark theme. A red/amber palette using the same Dark recipe would be a
different theme, not "Brio."

| Old name | New name | Rationale |
|----------|----------|-----------|
| `BRIO_DARK_FORMULAS` | `DARK_FORMULAS` | Recipe identity, not theme identity |
| `BRIO_DARK_OVERRIDES` | `DARK_OVERRIDES` | Same |
| `EXAMPLE_RECIPES.brio` | `EXAMPLE_RECIPES.brio` (keeps name, references `DARK_FORMULAS`) | "Brio" is the theme name — the combination of the Dark recipe + specific hues |

`BASE_FORMULAS` stays as-is — it holds the defaults that both Dark and Light recipes
extend from. `EXAMPLE_RECIPES.brio` keeps the "brio" key because that's the name of
the specific theme instance, but its `formulas` field becomes
`{ ...BASE_FORMULAS, ...DARK_OVERRIDES }` using the renamed constants.

This rename is mechanical and happens alongside the formula builder refactor.

### Problem

The `derivation-rules.ts` file inlines formula expressions in every rule entry. The
same expression appears in multiple places:

```typescript
// 6 copies of the same formula in filledRoleRules
[`${base}-fg-rest`]:   { type: "chromatic", hueSlot: "txt", intensityExpr: filledFgI, toneExpr: lit(100) },
[`${base}-fg-hover`]:  { type: "chromatic", hueSlot: "txt", intensityExpr: filledFgI, toneExpr: lit(100) },
[`${base}-fg-active`]: { type: "chromatic", hueSlot: "txt", intensityExpr: filledFgI, toneExpr: lit(100) },
[`${base}-icon-rest`]:   { type: "chromatic", hueSlot: "txt", intensityExpr: filledFgI, toneExpr: lit(100) },
[`${base}-icon-hover`]:  { type: "chromatic", hueSlot: "txt", intensityExpr: filledFgI, toneExpr: lit(100) },
[`${base}-icon-active`]: { type: "chromatic", hueSlot: "txt", intensityExpr: filledFgI, toneExpr: lit(100) },
```

When you need to change how control foreground intensity works, you change it in 6
places within the factory, and the factory is called 7 times. That's 42 rule entries
for one formula.

### Solution

Define each distinct formula as a named builder function. The builder returns a
`ChromaticRule` object. Rule entries reference the builder instead of inlining the
expression.

The ~22 distinct formulas collapse to named builders organized by their semantic role:

**Surface formulas:**

```typescript
/** Surface at atmosphere hue, formula intensity, computed tone. */
function surface(iField: keyof F, toneKey: keyof ComputedTones): ChromaticRule {
  return { type: "chromatic", hueSlot: "atm",
    intensityExpr: (f) => f[iField] as number,
    toneExpr: (_, __, c) => c[toneKey] as number };
}
```

**Control foreground formulas:**

```typescript
/** Control fg/icon: text hue, read I and tone from formula fields. */
function controlFg(iField: keyof F, toneField: keyof F): ChromaticRule {
  return { type: "chromatic", hueSlot: "txt",
    intensityExpr: (f) => f[iField] as number,
    toneExpr: (f) => f[toneField] as number };
}
```

**Border intensity ramp:**

```typescript
/** Border at role hue, signalI + offset, tone 50. */
function borderRamp(offset: number): (hueSlot: string) => ChromaticRule {
  return (hueSlot) => ({ type: "chromatic", hueSlot,
    intensityExpr: (_, __, c) => Math.min(90, c.signalI + offset),
    toneExpr: lit(50) });
}

const borderRest  = borderRamp(5);
const borderHover = borderRamp(15);
const borderActive = borderRamp(25);
```

**Filled background formulas:**

```typescript
/** Filled bg at role hue, fixed intensity, formula tone. */
function filledBg(intensity: number, toneField: keyof F): (hueSlot: string) => ChromaticRule {
  return (hueSlot) => ({ type: "chromatic", hueSlot,
    intensityExpr: lit(intensity),
    toneExpr: (f) => f[toneField] as number });
}

const filledBgRest   = filledBg(50, "filledBgDarkTone");
const filledBgHover  = filledBg(55, "filledBgHoverTone");
const filledBgActive = filledBg(90, "filledBgActiveTone");
```

**Semantic tone formula:**

```typescript
/** Semantic signal at role hue, signalI, tone 50, optional alpha. */
function semanticTone(alpha?: number): (hueSlot: string) => ChromaticRule {
  const rule: ChromaticRule = { type: "chromatic", hueSlot: "",
    intensityExpr: (_, __, c) => c.signalI,
    toneExpr: lit(50) };
  if (alpha !== undefined) rule.alphaExpr = lit(alpha);
  return (hueSlot) => ({ ...rule, hueSlot });
}
```

**Badge tinted formula:**

```typescript
/** Badge at role hue, read I/tone/alpha from badge formula fields. */
function badgeTinted(
  iField: keyof F, toneField: keyof F, alphaField?: keyof F,
): (hueSlot: string) => ChromaticRule { ... }
```

### Factory simplification

With named builders, the factory functions become pure token-name generators:

```typescript
function filledRoleRules(role: string, hueSlot: string): Record<string, DerivationRule> {
  const base = `--tug-base-control-filled-${role}`;
  const fg = controlFg("filledFgI", "filledFgTone");
  return {
    [`${base}-bg-rest`]:     filledBgRest(hueSlot),
    [`${base}-bg-hover`]:    filledBgHover(hueSlot),
    [`${base}-bg-active`]:   filledBgActive(hueSlot),
    [`${base}-fg-rest`]:     fg,
    [`${base}-fg-hover`]:    fg,
    [`${base}-fg-active`]:   fg,
    [`${base}-icon-rest`]:   fg,
    [`${base}-icon-hover`]:  fg,
    [`${base}-icon-active`]: fg,
    [`${base}-border-rest`]:   borderRest(hueSlot),
    [`${base}-border-hover`]:  borderHover(hueSlot),
    [`${base}-border-active`]: borderActive(hueSlot),
  };
}
```

The formula is defined once (`controlFg`, `filledBgRest`, `borderRest`). The factory
just wires it to token names. When you change how control foreground works, you change
it in one place.

### Deliverable

`derivation-rules.ts` uses named formula builders. Each of the ~22 distinct formulas
is defined exactly once. Token output is identical before and after.

---

## Part 2: Semantic Layer

### Problem

The `DerivationFormulas` interface is a flat bag of ~198 fields with no organizing
principle. Looking at `filledBgDarkTone: 50` tells you nothing about *why* the
filled button background is at tone 50 in the Dark recipe. A recipe author (human or
LLM) faces 198 unlabeled knobs with no guidance about which ones matter for a given
design intent.

### Solution

Group the formula fields by the semantic decisions they control. Each group represents
one design choice a recipe makes.

**The semantic decisions a dark recipe makes:**

| Decision | What it controls | Dark recipe choice | Formula fields |
|----------|-----------------|-----------------|----------------|
| **Canvas darkness** | How dark the app background is | Very dark (tone 5) | bgAppTone, bgCanvasTone |
| **Surface layering** | How surfaces stack visually | Subtle steps (6-16) | surfaceSunkenTone, surfaceDefaultTone, surfaceRaisedTone, surfaceOverlayTone, surfaceInsetTone, surfaceContentTone, surfaceScreenTone |
| **Text brightness** | How bright primary text is | Near-white (tone 94) | fgDefaultTone |
| **Text hierarchy spread** | How much secondary/tertiary text dims | Wide spread (94/66/37/23) | fgMutedTone, fgSubtleTone, fgDisabledTone, fgPlaceholderTone |
| **Text coloring** | How much chroma text carries | Very low (I=2-7) | txtI, txtISubtle, fgMutedI |
| **Surface coloring** | How much chroma surfaces carry | Very low (I=2-5) | atmI, bgAppI, bgCanvasI, surfaceDefaultI, surfaceRaisedI |
| **Filled control prominence** | How bold filled buttons are | Mid-tone bg, white fg | filledBgDarkTone, filledBgHoverTone, filledBgActiveTone, filledFgI, filledFgTone |
| **Outlined control style** | How outlined buttons present | Transparent bg, white fg, colored border | outlinedFgI, outlinedFgRestTone, outlinedFgHoverTone, outlinedFgActiveTone, outlinedBgHoverI, outlinedBgActiveI |
| **Ghost control style** | How ghost buttons present | Invisible bg, white fg, subtle border | ghostFgI, ghostFgRestTone, ghostBorderI, ghostBorderTone |
| **Border visibility** | How visible borders and dividers are | Subtle (I=6-7) | borderIBase, borderIStrong, borderMutedI, borderMutedTone, borderStrongTone |
| **Signal intensity** | How vivid semantic colors are | Moderate (knob-driven) | (controlled by signalIntensity knob) |
| **Shadow depth** | How pronounced shadows are | Moderate (20-80% alpha) | shadowXsAlpha through shadowXlAlpha |
| **Badge style** | How badges present | Tinted bg, colored text | badgeTintedFgI, badgeTintedFgTone, badgeTintedBgI, badgeTintedBgTone, badgeTintedBgAlpha |

These ~13 semantic decisions map to the ~22 formula patterns and the ~198 formula
fields. A recipe is a set of positions on these ~13 decisions.

### Annotation format

Each formula field in `DerivationFormulas` gets a `@semantic` JSDoc tag linking it to
its decision group:

```typescript
/** @semantic canvas-darkness — How dark the app background is */
bgAppTone: number;

/** @semantic text-hierarchy — How much secondary text dims from primary */
fgMutedTone: number;
```

### Recipe description format

A recipe carries a human-readable description alongside its formulas:

```typescript
export interface ThemeRecipe {
  name: string;
  mode: "dark" | "light";
  /** Human-readable description of the design intent. */
  description: string;
  // ... hue inputs, mood knobs, formulas
}
```

The Brio theme (which uses the Dark recipe with cobalt/violet/indigo hues):

```typescript
{
  name: "brio",
  mode: "dark",
  description: "Deep, immersive dark theme. Very dark surfaces with subtle layering. "
    + "Near-white text with wide hierarchy spread. Filled controls are prominent "
    + "with vivid accent backgrounds and white text. Borders are subtle. "
    + "Shadows are moderate. Industrial warmth with muted chassis and vivid signals.",
  formulas: { ...BASE_FORMULAS, ...DARK_OVERRIDES },
  // ... hue inputs (cobalt, violet, indigo, etc.)
}
```

The description belongs to the *theme* (Brio), not the *recipe* (Dark). Another theme
using the same Dark recipe with red/amber hues would have a different description but
the same formulas.

### Deliverable

`DerivationFormulas` fields are annotated with `@semantic` tags. `ThemeRecipe` has a
`description` field. The Brio theme's description is written. The semantic decision
table is documented in the module JSDoc.

---

## Part 3: Restructure DerivationFormulas

### Problem

The formula fields are organized by token category (surface tones, foreground tones,
control emphasis parameters, badge parameters, etc.). This mirrors the token output
structure but obscures the semantic decisions. A recipe author looking at 198 fields
doesn't know which ones to change for "make this a light theme."

### Solution

Restructure the interface so fields are grouped by the ~13 semantic decisions from
Part 2. Each group is a section in the interface with a JSDoc block describing the
decision.

```typescript
export interface DerivationFormulas {
  // ===== Canvas Darkness =====
  // How dark (or light) the app background and canvas are.
  // Dark recipe: tones 5-10. Light recipe: tones 90-95.
  bgAppTone: number;
  bgCanvasTone: number;

  // ===== Surface Layering =====
  // How surfaces stack visually above the canvas.
  // Controls the tone steps between sunken, default, raised, overlay.
  surfaceSunkenTone: number;
  surfaceDefaultTone: number;
  // ...

  // ===== Text Brightness =====
  // Primary text tone. Dark: near 100 (white). Light: near 0 (black).
  fgDefaultTone: number;

  // ===== Text Hierarchy =====
  // Secondary, tertiary, disabled text tones.
  // Wide spread = clear visual layers. Narrow = more uniform.
  fgMutedTone: number;
  fgSubtleTone: number;
  fgDisabledTone: number;
  fgPlaceholderTone: number;

  // ===== Filled Control Prominence =====
  // How bold filled buttons are — their bg tone, fg brightness, intensity.
  filledBgDarkTone: number;
  filledBgHoverTone: number;
  filledBgActiveTone: number;
  filledFgI: number;
  filledFgTone: number;

  // ... etc, organized by semantic decision
}
```

### Deliverable

`DerivationFormulas` fields reordered by semantic group. No fields added or removed —
only reordered within the interface. Comments describe each group's purpose and the
dark-vs-light polarity of its values.

---

## Part 4: Annotate the Dark Recipe

### Problem

The Dark recipe's formula values in `DARK_FORMULAS` are bare numbers with no
explanation of why each value was chosen. `bgAppTone: 5` — why 5? What design intent
does it serve? Without rationale, there is no basis for an LLM (or a human) to make
informed choices for a different recipe.

### Solution

Annotate every formula field in `DARK_FORMULAS` with a brief inline comment
explaining the design rationale:

```typescript
export const DARK_FORMULAS: DerivationFormulas = {
  // === Canvas Darkness ===
  bgAppTone: 5,           // near-black: deep, immersive feel
  bgCanvasTone: 5,        // matches app bg for seamless canvas

  // === Surface Layering ===
  surfaceSunkenTone: 11,  // slightly above canvas: recessed areas visible but subtle
  surfaceDefaultTone: 12, // just above sunken: the primary content surface
  surfaceRaisedTone: 11,  // same as sunken: raised panels don't pop in the dark recipe
  surfaceOverlayTone: 14, // highest surface: modals and popovers stand out
  surfaceScreenTone: 16,  // screen overlay: notification shade

  // === Text Brightness ===
  fgDefaultTone: 94,      // near-white: maximum readability on dark surfaces

  // === Text Hierarchy ===
  fgMutedTone: 66,        // secondary text: clearly readable but subordinate
  fgSubtleTone: 37,       // tertiary text: metadata, timestamps — recedes
  fgDisabledTone: 23,     // disabled: barely visible, signals non-interactive
  fgPlaceholderTone: 30,  // placeholder: between subtle and disabled

  // === Filled Control Prominence ===
  filledBgDarkTone: 50,   // mid-tone: vivid accent color at canonical lightness
  filledBgHoverTone: 55,  // slightly brighter on hover: feedback without flash
  filledBgActiveTone: 90, // near-white on press: strong tactile feedback
  // ...
};
```

This annotation serves two purposes:
1. A human reading the recipe understands the intent behind each value.
2. An LLM generating a new recipe has the rationale as context for making analogous
   choices. If the prompt says "bright, airy light theme," the LLM can see that
   the Dark recipe's `bgAppTone: 5` was chosen for "deep, immersive feel" and
   know to pick `bgAppTone: 92` for "bright, open canvas."

### Deliverable

`DARK_FORMULAS` fully annotated with design rationale comments, organized by
semantic decision groups.

---

## Part 5: Create the Harmony Light Theme

### Goal

Demonstrate the semantic formula architecture by creating a complete light theme that
is a peer of Brio — not a replacement, not a bolt-on, but a first-class theme that
lives alongside Brio and can be hot-swapped by the user from Tug.app.

**Key distinction: recipe vs. theme.** `LIGHT_FORMULAS` / `LIGHT_OVERRIDES` are the
*recipe* — the set of formula choices that define how a light theme behaves. "Harmony"
is the *theme* — the specific combination of the Light recipe with the same
cobalt/violet/indigo hue palette that Brio uses. This proves the architecture: same
palette, different recipe, completely different visual result.

### The Harmony theme

> "Bright, open canvas with crisp surfaces. Dark text for maximum readability with
> clear hierarchy. Filled controls use vivid accent backgrounds with white text.
> Borders are crisp and visible. Shadows are light. Industrial warmth with muted
> chassis and vivid signals — the same palette as Brio, seen in daylight."

### Recipe construction

1. Start from `BASE_FORMULAS` (which holds Dark recipe defaults).
2. For each of the ~23 semantic decisions, determine what the light theme description
   implies. The annotated `DARK_FORMULAS` from Part 4 serves as the reference — read
   each field's design rationale and make the analogous inverted choice:

| Decision | Dark recipe (Brio) | Light recipe (Harmony) |
|----------|-------------------|----------------------|
| Canvas darkness | tone 5 (near-black) | tone 95 (near-white) |
| Surface layering | 6-16 (dark steps) | 85-95 (light steps, inverted order) |
| Text brightness | tone 94 (near-white) | tone 8 (near-black) |
| Text hierarchy | 94/66/37/23 | 8/30/55/70 (inverted spread) |
| Text coloring | I=2-7 (very low on dark) | I=3-8 (slightly more on light) |
| Surface coloring | I=2-5 | I=3-6 |
| Filled control prominence | mid-tone bg, white fg | vivid bg, white fg (same — filled controls stay prominent) |
| Outlined control style | transparent bg, white fg | transparent bg, dark fg |
| Ghost control style | invisible bg, white fg | invisible bg, dark fg |
| Border visibility | subtle (I=6-7) | crisp (I=8-10, slightly higher on light bg) |
| Shadow depth | moderate (20-80% alpha) | lighter (10-40% alpha) |
| Badge style | tinted bg, colored text | same pattern, adjusted for light bg |
| Hue slot dispatch | (same — routing is palette-dependent, not mode-dependent) |
| Sentinel dispatch | (same — sentinel routing is mode-independent) |
| Computed tone overrides | dark-calibrated | light-calibrated where derivation formula needs it |

3. Produce `LIGHT_OVERRIDES: Partial<DerivationFormulas>` containing only fields that
   differ from `BASE_FORMULAS`.
4. Produce `LIGHT_FORMULAS = { ...BASE_FORMULAS, ...LIGHT_OVERRIDES }`.

### Theme integration

Harmony is a peer of Brio. It must be fully integrated into the existing theme
infrastructure:

**`EXAMPLE_RECIPES.harmony`** — the theme instance, structured identically to
`EXAMPLE_RECIPES.brio`:

```typescript
harmony: {
  name: "harmony",
  mode: "light",
  description: "Bright, open canvas with crisp surfaces. Dark text for maximum "
    + "readability with clear hierarchy. ...",
  formulas: { ...BASE_FORMULAS, ...LIGHT_OVERRIDES },
  // same hue inputs as brio — cobalt, violet, indigo, cyan, etc.
}
```

**Theme Generator card** — the preset button row in `gallery-theme-generator-content.tsx`
already renders from `Object.keys(EXAMPLE_RECIPES)`, so adding `harmony` to
`EXAMPLE_RECIPES` automatically creates a "harmony" preset button. The `loadPreset()`
callback extracts mode, hues, and mood knobs from the recipe and re-derives. No
special-casing needed — the architecture handles it.

**Theme provider** — `ThemeName` in `theme-provider.tsx` must be widened from
`"brio"` to `"brio" | "harmony"`, and `themeCSSMap` must include the harmony entry.
The CSS injection and hot-swap mechanism already supports multiple themes via the
dynamic theme system (`setDynamicTheme` / `removeThemeCSS`).

**Token generation** — `generate-tug-tokens.ts` currently hard-codes
`EXAMPLE_RECIPES.brio`. It must be updated to generate tokens for all example
recipes (or at minimum, both brio and harmony). Each recipe gets its own output file
(e.g., `tug-base-brio.css`, `tug-base-harmony.css`), or the script generates a
combined file with recipe-scoped selectors.

### Contrast requirements

All 373 tokens produced by `deriveTheme(EXAMPLE_RECIPES.harmony)` must pass contrast
validation with zero exceptions. The existing `KNOWN_PAIR_EXCEPTIONS` in the test
suite document failures from the old approach of toggling `mode: "light"` without
light-specific formulas. The whole point of `LIGHT_OVERRIDES` is to eliminate those
failures — every semantic decision is calibrated for light surfaces.

### The prompt-to-recipe flow

Once this works for a manually-created light recipe, the path to LLM-generated
recipes is clear:

1. User provides a design intent description (natural language).
2. The LLM receives the semantic decision table, the annotated Dark recipe formulas
   as an example, and the description.
3. The LLM produces a `Partial<DerivationFormulas>` override — only the fields
   that differ from `BASE_FORMULAS`.
4. The system composes `{ ...BASE_FORMULAS, ...overrides }`, derives the theme,
   validates contrast, and presents the result.

The semantic layer makes this feasible because the LLM doesn't need to know about
373 tokens or 158 rule entries. It makes ~23 semantic decisions, each with clear
documentation of what the values mean and how dark/light polarity affects them.

### Deliverable

A working Harmony theme (`EXAMPLE_RECIPES.harmony`) that is a full peer of Brio:
- `LIGHT_FORMULAS` / `LIGHT_OVERRIDES` defined with annotated design rationale
- 373 tokens produced, all contrast pairings pass with zero exceptions
- Appears as a preset in the Theme Generator card
- Hot-swappable from the theme menu in Tug.app
- Token generation updated to produce harmony tokens alongside brio
- The proof that the semantic formula architecture works — that a design intent
  description can be translated into formula overrides that produce a complete,
  contrast-compliant, fully integrated theme

---

## Execution order

1. **Part 1** (named formula builders) — mechanical refactor, no behavioral change,
   token output must be identical ✅
2. **Part 2** (semantic layer) — annotation and documentation, no code changes beyond
   JSDoc and the `description` field on `ThemeRecipe` ✅
3. **Part 3** (restructure interface) — reorder fields within `DerivationFormulas`,
   no fields added or removed ✅
4. **Part 4** (annotate Dark recipe) — add comments to `DARK_FORMULAS` ✅
5. **Part 5** (Harmony light theme) — the payoff: create a fully integrated light
   theme that is a peer of Brio, with its own recipe, token generation, contrast
   validation, and theme generator integration

Parts 1-4 are preparation. Part 5 is the proof.
