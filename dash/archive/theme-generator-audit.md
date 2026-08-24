# Theme Generator — Current State Audit

*2026-03-15*

Audit of the theme generation system covering mood sliders, auto-fix, import/export, light mode, and the overall recipe model. Goal: identify what works, what's missing, and what needs to happen before we can practically create and use custom themes.

---

## 1. Mood Sliders

All three mood sliders are fully implemented and wired to the UI.

### Surface Contrast (0–100, default 50)

Controls vertical spread of surface tone tiers. Each surface tier has a preset anchor value; the slider pushes tones apart (higher contrast) or compresses them (lower contrast). Scaling ranges vary by tier:

| Tier | Range (tone units) | Effect |
|------|-------------------|--------|
| bgApp | ±8 | Background gets darker/lighter |
| surfaceSunken | ±5 | Inset areas |
| surfaceDefault | ±3 | Most conservative — main content surface |
| surfaceRaised/Overlay | ±5 | Elevated surfaces |
| surfaceInset | ±7 | Deeply recessed areas |
| surfaceScreen | ±13 | Largest effect — full-bleed backgrounds |

Formula: `preset.value + ((surfaceContrast - 50) / 50) * range`

**Assessment:** Well-implemented. The per-tier ranges feel reasonable. The name "Surface Contrast" accurately describes what it does.

### Signal Intensity (currently "signalVividity" in code)

Controls chroma/saturation of all 7 semantic role colors (accent, active, agent, data, success, caution, danger). Direct linear mapping:

- `signalI = Math.round(signalVividity)` → passed as the intensity parameter
- At 0: all role colors are achromatic (gray)
- At 50: canonical saturation
- At 100: maximum saturation

**Assessment:** Simple and effective. The name "Signal Vividity" is misleading — "Signal Intensity" is better since it maps directly to the TugColor intensity parameter. The rename should happen in the recipe type (`signalVividity` → `signalIntensity`) and all references.

### Warmth (0–100, default 50)

Shifts hue angles for near-neutral hues only (blues, violets, purples — the hues that form the "chassis" of most themes). Does not affect vivid semantic hues.

- Formula: `warmthBias = ((warmth - 50) / 50) * 12` → ±12° maximum
- Affected hues: violet, cobalt, blue, indigo, purple, sky, sapphire, iris, cerulean
- Applied to: atmosphere surfaces, text foregrounds, and certain structural tokens
- Warm (>50): shifts toward amber/yellow
- Cool (<50): shifts toward deeper blue

**Assessment:** Subtle but meaningful. The ±12° range is conservative — enough to give a warm or cool cast without making blues look green or violets look red. Well-targeted to the structural hues that define a theme's character.

---

## 2. Auto-Fix Feature

Fully implemented with cascade-aware iteration and oscillation detection.

### What it does

1. Takes the current token map, resolved OKLCH values, and list of contrast failures
2. Groups failures by element token (foreground)
3. For each element, finds the most restrictive surface pairing
4. Bumps tone by ±5 units in the direction that improves contrast
5. Re-validates ALL pairs after each adjustment (cascade-aware)
6. Detects oscillation (token alternating direction 3+ times) and freezes those tokens
7. Safety cap: 20 iterations maximum

### UI integration

- Auto-fix button in the gallery card: "Auto-fix (N failures)"
- Disabled when no failures exist
- On click: runs `autoAdjustContrast()`, merges results back into theme output
- Displays summary: "M tokens adjusted, K unfixable"
- Shows CVD hue-shift suggestions from the accessibility analysis

### What's missing

- **No undo.** Once auto-fix runs, the only way back is to re-derive from the recipe. Should offer a "Revert auto-fix" action.
- **No preview.** Auto-fix modifies the theme in-place. Would be useful to show a before/after diff of what changed.
- **No granularity.** It's all-or-nothing. Can't auto-fix just one failing pair.
- **The fix modifies tone values, not the recipe.** Auto-fix patches the derived tokens, but the changes aren't reflected back into the recipe. If you re-derive (change a slider), the fixes are lost. This is the biggest gap — auto-fix should ideally suggest recipe-level adjustments.

---

## 3. Import/Export

### CSS Export

Generates a complete theme CSS file:
- Header comment with `@theme-name`, `@theme-description`, date, recipe hash
- `body { }` block with all `--tug-base-*` tokens as `--tug-color()` values
- Matches `tug-base.css` override structure
- Only chromatic/structural tokens; invariant tokens (spacing, radius, fonts) excluded

### JSON Recipe Export

Serializes the full `ThemeRecipe` object with pretty-printing. All fields included:
- name, mode, atmosphere.hue, text.hue
- All 7 role hues
- All 3 mood values
- Filename sanitized from recipe name

### JSON Recipe Import

- File picker for `.json` files
- Schema validation with descriptive error messages
- On success, applies all fields to UI state and re-derives

### What's missing

- **Theme naming is informal.** The recipe has a `name` field, but the UI doesn't prominently surface it or require it. Should be a visible text field at the top of the generator.
- **No theme library/list.** There's no way to save multiple themes or switch between them. Currently export-to-file, import-from-file only.
- **No live preview of imports.** Importing a recipe re-derives everything, but there's no "try before you commit" workflow.
- **CSS export can't be dynamically loaded.** The exported CSS file is designed for static inclusion. There's no runtime mechanism to inject a theme CSS file and see it applied to the running app.
- **No export of the resolved/expanded CSS.** The CSS export uses `--tug-color()` notation which requires PostCSS expansion. A "resolved CSS" export with literal `oklch()` values would be useful for themes that need to work without the PostCSS build step.

---

## 4. Light Mode

### Implementation status

Algorithmically complete. `LIGHT_PRESET` has full numeric values for all surface, foreground, border, and control token tiers. Light-mode-specific branches (`isLight` checks) exist throughout `deriveTheme()` for:

- Inverted foreground tones (near-black text on light backgrounds)
- Higher text intensity for sufficient contrast on light surfaces
- Different selection/highlight tones
- Atmosphere-based borders (vs text-based in dark mode)
- Lower shadow/overlay alphas
- Tab chrome using atmosphere hue at high tone

### Known gaps

- **No hand-authored reference.** Light preset values were extracted from a "Harmony" theme concept but never validated against a canonical hand-tuned reference. The comment in code says: *"Formula accuracy against a hand-authored light-mode ground truth is deferred (Q01)."*
- **No light-mode Brio equivalent.** The default example recipe (`EXAMPLE_RECIPES.brio`) is dark mode. There's no companion light recipe to test against.
- **Contrast behavior may differ.** The auto-fix algorithm works the same in both modes, but light-mode contrast dynamics are different (dark text on light backgrounds has different Lc characteristics than light text on dark). Untested in practice.
- **Surface contrast slider behavior in light mode.** The same ±range values are applied in both modes. Light mode surfaces may need different scaling factors since the perceptual distance between light tones is different than between dark tones.

---

## 5. ThemeRecipe Model

```typescript
interface ThemeRecipe {
  name: string;
  mode: "dark" | "light";
  atmosphere: { hue: string };  // Surface colors
  text: { hue: string };        // Foreground text
  accent?: string;              // CTA / primary (default: orange)
  active?: string;              // Interactive state (default: blue)
  interactive?: string;         // Links, selection (defaults to active)
  destructive?: string;         // Danger (default: red)
  success?: string;             // Positive (default: green)
  caution?: string;             // Warning (default: yellow)
  agent?: string;               // AI/automation (default: violet)
  data?: string;                // Analytics (default: teal)
  surfaceContrast?: number;     // 0–100, default 50
  signalVividity?: number;      // 0–100, default 50 (should rename to signalIntensity)
  warmth?: number;              // 0–100, default 50
}
```

The recipe is compact and expressive. Two required fields (atmosphere + text hue) plus optional role overrides and mood knobs. Good design — a minimal recipe produces a complete 264-token theme.

---

## 6. Roadmap — What Needs to Happen

### Must-have for practical theme creation

1. **Rename `signalVividity` → `signalIntensity`** in the recipe type, engine, gallery card, and tests. The current name is confusing.

2. **Theme name as a first-class UI element.** Prominent text field at the top of the generator. Required for export. Persists across re-derivations.

3. **Dynamic theme loading.** The app needs a mechanism to inject a generated theme's CSS and see it applied live. This is the core "try it out" capability. Likely: a `<style>` element injected into `<head>` with the resolved `oklch()` values, toggled by a theme selector.

4. **Compact role color pickers.** Replace the 9 full-width `HueSelector` strips with a list of role rows. Each row: role name, current color chip, click to open a shared TugColor picker (48-hue ring + intensity/tone). Use the Observable Props gallery card pattern for the list layout.

5. **Auto-fix validation.** Test auto-fix on actual theme derivations (both dark and light) and verify it converges. Fix any issues found.

### Should-have for a good workflow

6. **Resolved CSS export.** Export with literal `oklch()` values (not `--tug-color()` notation) so themes work without PostCSS.

7. **Light-mode reference recipe.** Create a hand-tuned "Brio Light" recipe and use it to validate/fix light-mode derivation.

8. **Undo for auto-fix.** Store pre-fix state, offer revert.

9. **Theme preview container.** A scoped `<div>` in the gallery card where the generated theme is applied (via CSS custom properties on the container), showing sample UI components (buttons, badges, cards, text) in the generated theme — without affecting the rest of the app.

### Nice-to-have

10. **Theme library.** Save/load multiple themes from local storage or the filesystem.

11. **Recipe diff.** Show what changed between two recipes or between a recipe and its auto-fixed version.

12. **Export format options.** CSS with `--tug-color()`, CSS with `oklch()`, JSON tokens, Figma-compatible format.
