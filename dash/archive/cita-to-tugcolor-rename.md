# CITA → TugColor Rename

Retire the CITA acronym everywhere. Replace with **TugColor** (CamelCase in code) and
**`--tug-color()`** (CSS custom function syntax). The goal: anyone reading the code
immediately understands "this is the tug's color system" without needing to decode a
four-letter acronym.

---

## Naming conventions

| Context | Old | New |
|---------|-----|-----|
| CSS custom function | `--cita(...)` | `--tug-color(...)` |
| TypeScript function | `citaColor()` | `tugColor()` |
| TypeScript reverse | `oklchToCITA()` | `oklchToTugColor()` |
| TypeScript pretty | `citaPretty()` | `tugColorPretty()` |
| TypeScript presets | `CITA_PRESETS` | `TUG_COLOR_PRESETS` |
| TypeScript type | `CITAColor` | `TugColorValue` |
| TypeScript type | `CITAParsed` | `TugColorParsed` |
| TypeScript type | `CITAError` | `TugColorError` |
| TypeScript type | `CITACallSpan` | `TugColorCallSpan` |
| Parser function | `parseCITA()` | `parseTugColor()` |
| Parser scanner | `findCITACalls()` | `findTugColorCalls()` |
| PostCSS plugin | `postcss-cita` / `postcssCita()` | `postcss-tug-color` / `postcssTugColor()` |
| Rust CLI command | `tugcode cita` | `tugcode color` |
| Rust struct | `CitaResult` | `TugColorResult` |
| Rust function | `oklch_to_cita()` | `oklch_to_tug_color()` |
| Rust function | `run_cita()` | `run_color()` |
| Rust build fn | `generate_cita_palette_data()` | `generate_color_palette_data()` |
| Generated Rust file | `cita_palette_data.rs` | `color_palette_data.rs` |
| JSON data file | `tug-cita-canonical.json` | `tug-color-canonical.json` |
| Canvas mapping | `CANVAS_CITA` | `CANVAS_COLORS` |
| Module comment | "CITA (Color · Intensity · Tone · Alpha)" | "TugColor (Hue · Intensity · Tone · Alpha)" |

---

## Checklist

### 1. Data file

- [ ] Rename `dash/tug-cita-canonical.json` → `dash/tug-color-canonical.json`
- [ ] Update the Rust build script path that reads this file

### 2. Rust CLI (`tugcode/`)

**`crates/tugcode/src/commands/cita.rs` → `commands/color.rs`**
- [ ] Rename file
- [ ] `CitaResult` → `TugColorResult`
- [ ] `oklch_to_cita()` → `oklch_to_tug_color()`
- [ ] `run_cita()` → `run_color()`
- [ ] Update all internal comments from CITA to TugColor
- [ ] Update CLI help text / description strings
- [ ] Update all test function names and assertions

**`crates/tugcode/src/commands/mod.rs`**
- [ ] `pub mod cita;` → `pub mod color;`
- [ ] `pub use cita::run_cita;` → `pub use color::run_color;`

**`crates/tugcode/src/cli.rs`**
- [ ] `Commands::Cita` → `Commands::Color`
- [ ] Update command doc comments

**`crates/tugcode/src/main.rs`**
- [ ] `Commands::Cita { color } => commands::run_cita(...)` →
      `Commands::Color { color } => commands::run_color(...)`

**`crates/tugcode/build.rs`**
- [ ] `generate_cita_palette_data()` → `generate_color_palette_data()`
- [ ] `write_empty_cita_data()` → `write_empty_color_data()`
- [ ] Update path to `tug-color-canonical.json`
- [ ] Generated file `cita_palette_data.rs` → `color_palette_data.rs`
- [ ] Update all comments

**After changes:**
- [ ] `cd tugcode && cargo fmt --all`
- [ ] `cd tugcode && cargo nextest run` — all tests pass

### 3. TypeScript parser (`tugdeck/cita-parser.ts` → `tug-color-parser.ts`)

- [ ] Rename file
- [ ] `CITAColor` → `TugColorValue`
- [ ] `CITAParsed` → `TugColorParsed`
- [ ] `CITAError` → `TugColorError`
- [ ] `CITACallSpan` → `TugColorCallSpan`
- [ ] `parseCITA()` → `parseTugColor()`
- [ ] `findCITACalls()` → `findTugColorCalls()`
- [ ] Marker string `"--cita("` → `"--tug-color("`
- [ ] Update all comments and JSDoc

### 4. PostCSS plugin (`tugdeck/postcss-cita.ts` → `postcss-tug-color.ts`)

- [ ] Rename file
- [ ] `postcssCita()` → `postcssTugColor()`
- [ ] Plugin name `"postcss-cita"` → `"postcss-tug-color"`
- [ ] `expandCita()` → `expandTugColor()`
- [ ] Update import of `CITA_PRESETS` → `TUG_COLOR_PRESETS`
- [ ] Update import path from parser
- [ ] Update all comments

### 5. Palette engine (`tugdeck/src/components/tugways/palette-engine.ts`)

- [ ] `CITA_PRESETS` → `TUG_COLOR_PRESETS`
- [ ] `citaColor()` → `tugColor()`
- [ ] `oklchToCITA()` → `oklchToTugColor()`
- [ ] `citaPretty()` → `tugColorPretty()`
- [ ] Update import path for `tug-color-canonical.json`
- [ ] Update module header comment and all internal comments

### 6. Vite config (`tugdeck/vite.config.ts`)

- [ ] Update import: `postcssCita` → `postcssTugColor`
- [ ] Update import path: `./postcss-cita` → `./postcss-tug-color`
- [ ] Update comment

### 7. CSS files — replace `--cita(` with `--tug-color(`

**`tugdeck/styles/tug-tokens.css`** (~415 occurrences across ~60 declarations)
- [ ] Replace all `--cita(` → `--tug-color(`
- [ ] Update header comment

**`tugdeck/styles/harmony.css`** (~248 occurrences across ~70 declarations)
- [ ] Replace all `--cita(` → `--tug-color(`
- [ ] Update header comment

**`tugdeck/styles/bluenote.css`** (~65 occurrences across ~70 declarations)
- [ ] Replace all `--cita(` → `--tug-color(`
- [ ] Update header comment

**`tugdeck/styles/chrome.css`** (3 occurrences)
- [ ] Replace all `--cita(` → `--tug-color(`

**`tugdeck/styles/tug-palette.css`** (comments only)
- [ ] Update any CITA references in comments

### 8. Component TypeScript files

**`tugdeck/src/components/tugways/cards/gallery-palette-content.tsx`**
- [ ] Update imports: `citaColor` → `tugColor`, `CITA_PRESETS` → `TUG_COLOR_PRESETS`
- [ ] Update all call sites

**`tugdeck/src/components/tugways/cards/gallery-cascade-inspector-content.tsx`**
- [ ] Update any CITA references

**`tugdeck/src/components/tugways/style-inspector-overlay.ts`**
- [ ] Update import: `oklchToCITA` → `oklchToTugColor`
- [ ] Update call sites

**`tugdeck/src/components/tugways/style-inspector-overlay.css`**
- [ ] Update any CITA references in comments

**`tugdeck/src/components/tugways/cards/gallery-palette-content.css`**
- [ ] Update any CITA references in comments

**`tugdeck/src/canvas-color.ts`**
- [ ] `CANVAS_CITA` → `CANVAS_COLORS`
- [ ] Update `citaColor` import → `tugColor`
- [ ] Update comments

**`tugdeck/src/contexts/theme-provider.tsx`**
- [ ] Update comment referencing CITA

### 9. Scripts

**`tugdeck/scripts/convert-hvv-to-cita.ts` → `convert-hvv-to-tug-color.ts`**
- [ ] Rename file
- [ ] Replace `--cita(` output format → `--tug-color(`
- [ ] Update all comments and function names

**`tugdeck/scripts/convert-hex-to-cita.ts` → `convert-hex-to-tug-color.ts`**
- [ ] Rename file
- [ ] `rgbaToCita()` → `rgbaToTugColor()`
- [ ] `convertHexInValue()` — update internal CITA references
- [ ] `convertHexFile()` — update internal CITA references
- [ ] Update imports from parser/engine

**`tugdeck/scripts/generate-tug-palette.ts`**
- [ ] Update `CITA_PRESETS` import → `TUG_COLOR_PRESETS`
- [ ] Update comments

### 10. Test files

**`tugdeck/src/__tests__/cita-parser.test.ts` → `tug-color-parser.test.ts`**
- [ ] Rename file
- [ ] Update all imports to new names
- [ ] Update test descriptions from "CITA" → "TugColor"
- [ ] Update all `--cita(` test strings → `--tug-color(`
- [ ] Update type references

**`tugdeck/src/__tests__/postcss-cita.test.ts` → `postcss-tug-color.test.ts`**
- [ ] Rename file
- [ ] Update imports
- [ ] Update all `--cita(` test strings → `--tug-color(`
- [ ] Update test descriptions

**`tugdeck/src/__tests__/postcss-cita-vite-integration.test.ts` → `postcss-tug-color-vite-integration.test.ts`**
- [ ] Rename file
- [ ] Update imports and test strings

**`tugdeck/src/__tests__/convert-hex-to-cita.test.ts` → `convert-hex-to-tug-color.test.ts`**
- [ ] Rename file
- [ ] Update imports and test strings

**`tugdeck/src/__tests__/palette-engine.test.ts`**
- [ ] Update imports: `citaColor` → `tugColor`, `CITA_PRESETS` → `TUG_COLOR_PRESETS`,
      `oklchToCITA` → `oklchToTugColor`, `citaPretty` → `tugColorPretty`
- [ ] Update test descriptions

**`tugdeck/src/__tests__/gallery-palette-content.test.tsx`**
- [ ] Update any CITA references

**`tugdeck/src/__tests__/step8-roundtrip-integration.test.ts`**
- [ ] Update any CITA references / test strings

**`tugdeck/src/__tests__/style-inspector-overlay.test.ts`**
- [ ] Update any CITA references

**After changes:**
- [ ] `cd tugdeck && bun test` — all tests pass

### 11. Swift (`tugapp/`)

**`tugapp/Sources/MainWindow.swift`**
- [ ] Update comment: `--cita(violet-6, ...)` → `--tug-color(violet-6, ...)`

### 12. Documentation — roadmap files

**`dash/palette-refinements.md`**
- [ ] Replace all CITA/cita references with TugColor/tug-color
- [ ] Update `--cita()` examples → `--tug-color()`
- [ ] Update `citaColor()` → `tugColor()` etc.
- [ ] Rename section "Build-time `--cita()` expansion" appropriately

**`dash/design-system-concepts.md`**
- [ ] [D70] "CITA OKLCH palette" → "TugColor OKLCH palette"
- [ ] [D80] "Build-time `--cita()` expansion" → "Build-time `--tug-color()` expansion"
- [ ] Update all CITA references in the ~700 lines of palette documentation
- [ ] Update table entries, code examples, cross-references

**`dash/tugways-implementation-strategy.md`**
- [ ] Replace all ~56 CITA references with TugColor equivalents
- [ ] Update phase names, code examples, implementation notes

**`dash/hvv-to-cita-rename.md`** → rename to `hvv-to-tug-color-rename.md`
- [ ] Rename file
- [ ] Update content to reflect final naming (CITA was intermediate step)

**`dash/theme-overhaul-proposal.md`**
- [ ] Update any CITA references

### 13. Tugplan archive (`.tugtool/`)

These are historical plan files. Update for accuracy:

- [ ] `tugplan-tugways-phase-5g-palette-refinements.md` (41 refs)
- [ ] `tugplan-tugways-phase-5g2-hvv-postcss.md` (136 refs)
- [ ] `tugplan-tugways-phase-5d5e-palette-engine-integration.md` (57 refs)
- [ ] `tugplan-tugways-phase-5d5f-cascade-inspector.md` (27 refs)
- [ ] `tugplan-tugways-phase-5d5c-token-architecture.md` (19 refs)
- [ ] `tugplan-implementation-log.md` (17 refs)
- [ ] `tugplan-hvv-runtime.md` (110 refs)
- [ ] Remaining tugplan files with scattered references (5 files, 1-3 refs each)

### 14. Build verification

- [ ] `cd tugcode && cargo fmt --all && cargo build && cargo nextest run`
- [ ] `cd tugdeck && bun install && bun test`
- [ ] `cd tugdeck && bun run build` (verify PostCSS plugin works with new name)
- [ ] Visual spot-check: load app, verify colors render correctly
- [ ] Grep sweep: `rg -i 'cita' --glob '!*.md' --glob '!.tugtool/*'` returns zero matches
- [ ] Grep sweep for docs: `rg -i '\bcita\b' dash/` returns zero matches
      (excluding `citation` which is a different word)

---

## Implementation order

The recommended order minimizes broken-state windows:

1. **Data file rename** (step 1) — no code depends on filename at runtime
2. **Rust CLI** (step 2) — self-contained, `cargo test` validates
3. **Parser + PostCSS plugin** (steps 3-4) — the foundation other TS depends on
4. **Palette engine** (step 5) — exports consumed by components
5. **CSS files** (step 7) — bulk find-replace of `--cita(` → `--tug-color(`
6. **Vite config** (step 6) — wire up renamed plugin
7. **Components + scripts** (steps 8-9) — update consumers
8. **Tests** (step 10) — rename and update in parallel with their source files
9. **Swift** (step 11) — one comment
10. **Documentation** (steps 12-13) — can be done last, no build impact
11. **Build verification** (step 14) — final sweep

---

## Scope notes

- The word "citation" in `validator.rs` is unrelated — do not touch
- Semantic token names like `--tug-base-accent-default` are unrelated — do not touch
- The `tug-palette.css` file uses `var()` formulas, not `--cita()` — only comments change
- All 200+ `--cita()` declarations in CSS become `--tug-color()` — this is a mechanical
  find-replace since the parser handles the new prefix
