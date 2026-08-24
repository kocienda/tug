# HVV → TugColor Rename: Complete Migration Checklist

## Overview

Retire the HVV (HueVibVal) naming throughout the project and replace it with **TugColor**
(Color · Intensity · Tone · Alpha). This is a pure rename of the conceptual model and its
surface-level identifiers. The underlying math (piecewise OKLCH lightness mapping, chroma
scaling) is unchanged.

### Terminology mapping

| Old term       | New term       | Scope                                    |
|----------------|----------------|------------------------------------------|
| HVV            | TugColor           | Model name everywhere                    |
| HueVibVal      | TugColor           | Long-form model name                     |
| Hue            | Color          | First axis (named hue families)          |
| Vibrancy / vib | Intensity / i  | Second axis (chroma scaling, 0–100)      |
| Value / val    | Tone / t       | Third axis (lightness mapping, 0–100)    |
| *(implicit)*   | Alpha / a      | Fourth axis (opacity, 0–100, default 100)|
| `--hvv()`      | `--tug-color()`     | PostCSS build-time notation              |
| `hvvColor()`   | `tugColor()`  | JS runtime function                      |
| `oklchToHVV()` | `oklchToTugColor()`| JS reverse mapper                        |
| `hvvPretty()`  | `tugColorPretty()` | JS human-readable formatter              |
| `HVV_PRESETS`  | `TUG_COLOR_PRESETS` | JS preset table                          |

### What does NOT change

- The 24 named hue families and their OKLCH angles
- Per-hue canonical lightness values
- Per-hue peak chroma values
- Global lightness anchors (L_DARK, L_LIGHT)
- The piecewise clamp() formula math
- The five convenience presets (canonical, light, dark, intense, muted)
- Three-layer token architecture (palette → base → component)
- Semantic token names (`--tug-base-accent-default` etc.)
- P3 gamut media query overrides

### Key syntax change: `--hvv()` → `--tug-color()`

The old `--hvv()` notation used positional-only arguments:
```css
--hvv(cobalt, 3, 8)        /* hue, vibrancy, value */
--hvv(237, 5, 13)           /* raw angle, vibrancy, value */
--hvv(blue, 5, 13, 0.5)    /* with alpha 0–1 */
```

The new `--tug-color()` notation uses a proper parser with labeled or positional arguments:
```css
--tug-color(cobalt, i: 3, t: 8)              /* labeled intensity and tone */
--tug-color(cobalt, 3, 8)                    /* positional: color, intensity, tone */
--tug-color(c: cobalt, i: 3, t: 8, a: 100)  /* fully labeled */
--tug-color(green)                            /* defaults: i=50, t=50, a=100 */
--tug-color(red+5, i: 30, t: 70)            /* hue offset in degrees */
```

Alpha is now 0–100 (not 0–1). Raw numeric hue angles are no longer supported — always
use a named color, optionally with a +/- degree offset.

---

## Phase 1: Data files and canonical source of truth

- [ ] **1.1** Rename `dash/tug-hvv-canonical.json` → `dash/tug-color-canonical.json`
  - Update internal field names if any reference "hvv" (currently they don't — fields
    are `canonical_l`, `l_dark`, `l_light`, so the content is fine as-is)
- [ ] **1.2** Audit `dash/tug-palette-anchors.json` — this is legacy anchor data; confirm
  it is no longer consumed by any code path and can be left as-is or archived

## Phase 2: Palette engine (TypeScript runtime)

**File:** `tugdeck/src/components/tugways/palette-engine.ts`

- [ ] **2.1** Rename exported function `hvvColor()` → `tugColor()`
- [ ] **2.2** Rename exported function `oklchToHVV()` → `oklchToTugColor()`
- [ ] **2.3** Rename exported function `hvvPretty()` → `tugColorPretty()` (if it exists)
- [ ] **2.4** Rename exported constant `HVV_PRESETS` → `TUG_COLOR_PRESETS`
- [ ] **2.5** Update parameter names in function signatures: `vib` → `intensity`, `val` → `tone`
- [ ] **2.6** Update the module doc comment: replace all HVV/HueVibVal references with TugColor
  terminology, describe the four axes (Color, Intensity, Tone, Alpha)
- [ ] **2.7** Update inline comments throughout the file
- [ ] **2.8** The JSON import path changes: `tug-hvv-canonical.json` → `tug-color-canonical.json`
- [ ] **2.9** Verify all other exports are unchanged: `HUE_FAMILIES`, `DEFAULT_CANONICAL_L`,
  `MAX_CHROMA_FOR_HUE`, `MAX_P3_CHROMA_FOR_HUE`, `PEAK_C_SCALE`, `L_DARK`, `L_LIGHT`,
  `findMaxChroma()` — these stay as-is (they describe OKLCH mechanics, not HVV naming)

## Phase 3: PostCSS plugin

- [ ] **3.1** Rename `tugdeck/postcss-hvv.ts` → `tugdeck/postcss-tug-color.ts`
- [ ] **3.2** Rewrite the plugin to use the new `tug-color-parser.ts` tokenizer+parser instead
  of the regex pattern
  - Import `parseTugColor`, `findTugColorCalls` from `./tug-color-parser`
  - The expansion math (L formula, C formula) stays the same
  - Remove the `HVV_PATTERN` regex entirely
  - Handle the new syntax features: labeled args, defaults, hue offsets, alpha 0–100
- [ ] **3.3** Update the PostCSS plugin name string: `"postcss-hvv"` → `"postcss-tug-color"`
- [ ] **3.4** Update the plugin factory export name: `postcssHvv()` → `postcssTugColor()`
- [ ] **3.5** Remove support for raw numeric hue angles and `hue-NNN` format — the new
  parser requires named colors (with optional offset)
- [ ] **3.6** Convert alpha handling: old system used 0–1 range, new system uses 0–100
  (divide by 100 when emitting the oklch `/ alpha` suffix)
- [ ] **3.7** Add error reporting: when `parseTugColor()` returns errors, emit PostCSS warnings
  with file/line context so build output shows exactly where the problem is
- [ ] **3.8** Delete `tugdeck/postcss-hvv.ts` after the new plugin is confirmed working

## Phase 4: Vite build configuration

**File:** `tugdeck/vite.config.ts`

- [ ] **4.1** Update import: `postcssHvv` → `postcssTugColor` from `"./postcss-tug-color"`
- [ ] **4.2** Update plugin usage in the PostCSS plugins array
- [ ] **4.3** Update any comments referencing `--hvv()`

## Phase 5: CSS theme files (562 `--hvv()` calls)

This is the largest mechanical change. Every `--hvv()` call becomes `--tug-color()` with the
new syntax. A conversion script should handle this.

- [ ] **5.1** Write a migration script `tugdeck/scripts/convert-hvv-to-tug-color.ts` that:
  - Finds all `--hvv(hue, vib, val[, alpha])` calls in CSS files
  - Converts each to `--tug-color(hue, i: vib, t: val[, a: alpha*100])` (labeled form)
  - Handles the `hue-NNN` raw angle format by finding the nearest named hue + offset
  - Validates each converted call parses correctly with `parseTugColor()`
  - Reports any calls that can't be automatically converted

- [ ] **5.2** Run the script on `tugdeck/styles/tug-tokens.css` (~251 calls)
- [ ] **5.3** Run the script on `tugdeck/styles/harmony.css` (~247 calls)
- [ ] **5.4** Run the script on `tugdeck/styles/bluenote.css` (~64 calls)
- [ ] **5.5** Manually review converted output for each file — spot-check 10+ declarations
  per file to confirm correctness
- [ ] **5.6** Verify no `--hvv(` strings remain in any CSS file under `tugdeck/styles/`
- [ ] **5.7** Build tugdeck and confirm zero PostCSS errors/warnings

## Phase 6: Canvas color module

**File:** `tugdeck/src/canvas-color.ts`

- [ ] **6.1** Update the `CANVAS_HVV` mapping (rename to `CANVAS_COLORS` or similar)
  - `--hvv(hue-264, 2, 5)` → nearest hue with smallest offset: `violet-6`
    at i:2, t:5 (violet=270, offset=-6)
  - `--hvv(hue-239, 5, 13)` → `blue+9` at i:5, t:13 (blue=230, offset=+9)
  - `--hvv(yellow, 7, 39)` → `yellow` i:7 t:39
- [ ] **6.2** Update the computation to use `tugColor()` instead of `hvvColor()`
- [ ] **6.3** Update any HVV references in comments

## Phase 7: Gallery palette editor

**File:** `tugdeck/src/components/tugways/cards/gallery-palette-content.tsx`

- [ ] **7.1** Update imports: `HVV_PRESETS` → `TUG_COLOR_PRESETS`, `hvvColor` → `tugColor`
- [ ] **7.2** Update all internal references to vibrancy/vib → intensity, value/val → tone
- [ ] **7.3** Update any UI label strings shown to the user (e.g. "Vibrancy" → "Intensity",
  "Value" → "Tone")
- [ ] **7.4** Update CSS class names or data attributes if any reference hvv

## Phase 8: Style inspector overlay

**File:** `tugdeck/src/components/tugways/style-inspector-overlay.ts`

- [ ] **8.1** Update import: `oklchToHVV` → `oklchToTugColor`
- [ ] **8.2** Update display formatting to show TugColor notation instead of HVV
- [ ] **8.3** Update variable names and comments

## Phase 9: Theme provider

**File:** `tugdeck/src/contexts/theme-provider.tsx`

- [ ] **9.1** Update any comments referencing HVV or `tug-palette.css` naming
- [ ] **9.2** Verify no runtime HVV function calls remain (the provider should reference
  CSS variables, not call `hvvColor()` directly)

## Phase 10: Conversion script

**File:** `tugdeck/scripts/convert-hex-to-hvv.ts`

- [ ] **10.1** Rename to `tugdeck/scripts/convert-hex-to-tug-color.ts`
- [ ] **10.2** Update all internal function names and references
- [ ] **10.3** Update output format to emit `--tug-color()` notation with labeled args
- [ ] **10.4** Update the `oklchToHVV()` call to `oklchToTugColor()`
- [ ] **10.5** Consider whether this script is still needed (it was a one-time migration
  tool) — if not, mark it as archived or delete it

## Phase 11: Palette generation script

**File:** `tugdeck/scripts/generate-tug-palette.ts` (if it references HVV)

- [ ] **11.1** Verify this script exists and check for HVV references
- [ ] **11.2** Update any HVV function calls, imports, or comments

## Phase 12: Rust CLI — `tugcode hvv` command

### Command rename

**File:** `tugcode/crates/tugcode/src/cli.rs`

- [ ] **12.1** Rename the `Hvv` variant in the `Commands` enum to `Color`
- [ ] **12.2** Update the command name from `hvv` to `tug-color` in the clap attribute
- [ ] **12.3** Update the help text: replace HVV/vibrancy/value terminology with
  TugColor/intensity/tone

**File:** `tugcode/crates/tugcode/src/main.rs`

- [ ] **12.4** Update the match arm: `Commands::Hvv` → `Commands::Color`
- [ ] **12.5** Update the function call: `run_hvv()` → `run_color()`

**File:** `tugcode/crates/tugcode/src/commands/mod.rs`

- [ ] **12.6** Rename the module: `pub mod hvv;` → `pub mod tug-color;`
- [ ] **12.7** Update the re-export: `run_hvv` → `run_color`

### Implementation rename

**File:** `tugcode/crates/tugcode/src/commands/hvv.rs` → `tug-color.rs`

- [ ] **12.8** Rename the file from `hvv.rs` to `tug-color.rs`
- [ ] **12.9** Rename `HvvResult` struct to `TugColorResult`
- [ ] **12.10** Rename struct fields: `vib` → `intensity`, `val` → `tone`
- [ ] **12.11** Rename function `oklch_to_hvv()` → `oklch_to_tug_color()`
- [ ] **12.12** Rename function `run_hvv()` → `run_color()`
- [ ] **12.13** Update the `include!()` for generated palette data (if the generated file
  name changes)
- [ ] **12.14** Update all doc comments and inline comments
- [ ] **12.15** Update JSON output field names: `"hvv"` → `"tug-color"`, `"vib"` → `"intensity"`,
  `"val"` → `"tone"`
- [ ] **12.16** Update text output format strings
- [ ] **12.17** Update all test function names and assertions
- [ ] **12.18** Run `cargo fmt --all` and `cargo nextest run` — zero warnings, zero failures

### Build script

**File:** `tugcode/crates/tugcode/build.rs`

- [ ] **12.19** Update the generated file name: `hvv_palette_data.rs` → `color_palette_data.rs`
- [ ] **12.20** Update the generated module name: `palette_data` (can stay, or rename)
- [ ] **12.21** Update the source JSON path: `tug-hvv-canonical.json` → `tug-color-canonical.json`
- [ ] **12.22** Update function name: `generate_hvv_palette_data()` → `generate_color_palette_data()`
- [ ] **12.23** Update fallback function: `write_empty_hvv_data()` → `write_empty_color_data()`
- [ ] **12.24** Update all comments in the build script
- [ ] **12.25** Verify the build works end-to-end: `cd tugcode && cargo build`

## Phase 13: Swift app

**File:** `tugapp/Sources/MainWindow.swift`

- [ ] **13.1** Update the comment at line ~95 that references `--hvv(hue-264, 2, 5)` to use
  TugColor notation
- [ ] **13.2** Search all `.swift` files for any other HVV references

## Phase 14: Test files

All in `tugdeck/src/__tests__/`:

- [ ] **14.1** Rename `postcss-hvv.test.ts` → `postcss-tug-color.test.ts`
  - Rewrite all test cases to use `--tug-color()` syntax with labeled args
  - Test the new features: defaults, sparse labeled, hue offsets, alpha 0–100
  - Update imports from postcss-tug-color and palette-engine
  - Update the `processDecl` helper to use the new plugin

- [ ] **14.2** Rename `postcss-hvv-vite-integration.test.ts` → `postcss-tug-color-vite-integration.test.ts`
  - Update all `--hvv()` references in test CSS strings
  - Update imports

- [ ] **14.3** Update `convert-hex-to-hvv.test.ts` → `convert-hex-to-tug-color.test.ts`
  - Update function references: `oklchToHVV` → `oklchToTugColor`
  - Update expected output format

- [ ] **14.4** Update `palette-engine.test.ts`
  - Replace `HVV_PRESETS` → `TUG_COLOR_PRESETS`
  - Replace `hvvColor` → `tugColor` in all test calls
  - Update any assertions on output format

- [ ] **14.5** Update `step8-roundtrip-integration.test.ts`
  - Update any HVV references in round-trip validation

- [ ] **14.6** Update `gallery-palette-content.test.tsx`
  - Replace `HVV_PRESETS` → `TUG_COLOR_PRESETS`
  - Update any HVV references

- [ ] **14.7** Update `style-inspector-overlay.test.ts`
  - Replace `oklchToHVV` → `oklchToTugColor`

- [ ] **14.8** Keep the existing `tug-color-parser.test.ts` — already written and passing

- [ ] **14.9** Run full test suite: `cd tugdeck && bun test` — zero failures

## Phase 15: Documentation

### Design system concepts

**File:** `dash/design-system-concepts.md`

- [ ] **15.1** Update concept [D70]: rename from "HueVibVal (HVV)" to "TugColor (Color ·
  Intensity · Tone · Alpha)"
- [ ] **15.2** Update the axis descriptions: Hue→Color, Vibrancy→Intensity, Value→Tone,
  add Alpha
- [ ] **15.3** Update all code examples showing `--hvv()` to `--tug-color()` with new syntax
- [ ] **15.4** Update `hvvColor()` references to `tugColor()`
- [ ] **15.5** Update concept [D80]: rename from "--hvv() Expansion" to "--tug-color() Expansion"
- [ ] **15.6** Update any cross-references to HVV in other concepts (D71, D74, D75, etc.)

### Implementation strategy

**File:** `dash/tugways-implementation-strategy.md`

- [ ] **15.7** Update Phase 5d5a section: "HVV Runtime" → "TugColor Runtime"
- [ ] **15.8** Update all function name references throughout the discussion log
- [ ] **15.9** Update file path references (postcss-hvv.ts → postcss-tug-color.ts, etc.)

### Palette refinements

**File:** `dash/palette-refinements.md`

- [ ] **15.10** This document describes the HVV system in depth — update the entire document
  to use TugColor terminology
- [ ] **15.11** Update section 13 (Build-time expansion) to describe `--tug-color()` syntax
- [ ] **15.12** Update the `hvvColor()` → `tugColor()` and `oklchToHVV()` → `oklchToTugColor()`
  references
- [ ] **15.13** Update the "when to use" table for `--tug-color()` vs inline formula vs JS

### Theme overhaul proposal

**File:** `dash/theme-overhaul-proposal.md`

- [ ] **15.14** Update Section 4: "HueVibVal (HVV) Computed Color Palette" → TugColor
- [ ] **15.15** Update axis names and function names throughout

### Tugplan files

**Directory:** `.tugtool/`

- [ ] **15.16** Update `tugplan-hvv-runtime.md` — rename references, or mark as historical
- [ ] **15.17** Update `tugplan-tugways-phase-5g2-hvv-postcss.md` — rename references
- [ ] **15.18** Scan all other tugplan files for HVV references:
  - `tugplan-tugways-phase-5d5c-token-architecture.md`
  - `tugplan-tugways-phase-5d5d-consumer-migration.md`
  - `tugplan-tugways-phase-5d5b-scale-timing.md`
  - `tugplan-tugways-phase-5d5e-palette-engine-integration.md`
  - `tugplan-tugways-phase-5d5f-cascade-inspector.md`
  - `tugplan-tugways-phase-5g-palette-refinements.md`

## Phase 16: Final sweep and verification

- [ ] **16.1** Run a project-wide case-insensitive search for `hvv` — every hit must be
  either converted or explicitly documented as historical/archived
- [ ] **16.2** Run a project-wide search for `vibrancy` and `\bvib\b` in code files — all
  should be renamed to intensity
- [ ] **16.3** Run a project-wide search for `\bval\b` in palette/color contexts — all
  should be renamed to tone
- [ ] **16.4** Run a project-wide search for `HueVibVal` — zero remaining hits
- [ ] **16.5** Run the full tugdeck build: `cd tugdeck && bun run build` — clean
- [ ] **16.6** Run the full tugdeck test suite: `cd tugdeck && bun test` — zero failures
- [ ] **16.7** Run the full tugcode build: `cd tugcode && cargo build` — zero warnings
- [ ] **16.8** Run the full tugcode tests: `cd tugcode && cargo nextest run` — zero failures
- [ ] **16.9** Run `cd tugcode && cargo fmt --all` — no formatting changes needed
- [ ] **16.10** Visual smoke test: load tugdeck in browser, switch themes (brio, bluenote,
  harmony), verify colors render identically to before the rename
- [ ] **16.11** Delete `tugdeck/postcss-hvv.ts` if not already removed
- [ ] **16.12** Delete `tugdeck/scripts/convert-hex-to-hvv.ts` if archived in phase 10
- [ ] **16.13** Delete `dash/tug-hvv-canonical.json` after confirming `tug-color-canonical.json`
  is the sole source of truth

---

## Execution order and dependencies

```
Phase 1  (data files)          — no dependencies, do first
Phase 2  (palette engine)      — depends on Phase 1 (JSON path)
Phase 3  (PostCSS plugin)      — depends on Phase 2 (imports from palette-engine)
Phase 4  (vite config)         — depends on Phase 3 (plugin import)
Phase 5  (CSS files)           — depends on Phase 3 (new plugin must parse --tug-color())
Phase 6  (canvas color)        — depends on Phase 2
Phase 7  (gallery editor)      — depends on Phase 2
Phase 8  (style inspector)     — depends on Phase 2
Phase 9  (theme provider)      — depends on Phase 2
Phase 10 (conversion script)   — depends on Phase 2, can run in parallel with 5–9
Phase 11 (palette gen script)  — depends on Phase 2
Phase 12 (Rust CLI)            — depends on Phase 1, independent of TS phases
Phase 13 (Swift app)           — independent, just a comment update
Phase 14 (tests)               — depends on Phases 2–12 (tests import the renamed code)
Phase 15 (docs)                — independent, can run in parallel with code phases
Phase 16 (final sweep)         — depends on all prior phases
```

## Risk notes

- **Zero visual change.** The math is identical. If any color shifts after migration,
  it's a bug in the conversion, not intentional.
- **Alpha range change.** Old `--hvv()` alpha was 0–1. New `--tug-color()` alpha is 0–100.
  The migration script must multiply existing alpha values by 100.
- **Raw angle removal.** `--hvv(237, 5, 13)` and `--hvv(hue-264, 2, 5)` have no direct
  equivalent in `--tug-color()`. The migration script must find the **nearest** named hue and
  use the **smallest** offset (e.g., angle 264 → `violet-6` not `cobalt+14`, because
  violet=270 is closer than cobalt=250). Always prefer the anchor that minimizes the offset.
- **562 CSS declarations.** Automated conversion is essential. Manual conversion would be
  error-prone and slow.
