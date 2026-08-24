# Theme System Overhaul

The theme system must produce legible, contrast-compliant themes across any
combination of recipe (dark, light, dark/stark, light/stark) and color palette
(any hue family). The current system fails this requirement. This document
identifies what is broken and lays out the work to fix it.

---

## What we learned

The iOS word game's theme picker demonstrates the target architecture: COLOR/RECIPE.
PURPLE/LIGHT, BLUE/DARK, YELLOW/DARK/STARK. The color (purple, blue, yellow) is one
axis. The recipe (light, dark, light/stark, dark/stark) is the other. Every
combination works. Every one is legible. The recipe describes a *design approach*,
not a pile of formula overrides.

The current Tug theme system fails to deliver this. The Harmony light theme has
illegible card titles, unreadable badge text, and muddy role colors. The contrast
engine reports zero failures while the UI shows obvious problems. Three structural
flaws explain why.

---

## Problem 1: Recipes are not independent

`LIGHT_FORMULAS` is defined as `{ ...BASE_FORMULAS, ...LIGHT_OVERRIDES }` where
`BASE_FORMULAS === DARK_FORMULAS`. Light is structurally "dark, but change these
things." This is wrong. Each recipe must be a complete, self-contained definition
of how to render a theme — 198 values chosen for that recipe's design intent, not
198 values inherited from dark with some patched.

The iOS game defines 4 independent recipes. Each specifies all 22 color roles from
scratch. None inherits from another. When the dark recipe says PrimaryFill has
`gray:0.33, targetLightness:29`, and the light recipe says `gray:0.8,
targetLightness:77`, these are independent design decisions — not inversions.

**What must change:** Each recipe (dark, light, dark/stark, light/stark) must be a
complete `DerivationFormulas` object with all fields explicitly set and annotated
with design rationale. No spreading from a "base." The base/override pattern served
as scaffolding but it has become the ceiling.

---

## Problem 2: The contrast engine does not check what matters

The element-surface pairing map is a hand-curated list of 239 token pairs. It was
written by reasoning about what *should* need checking, not by looking at what *does*
need checking. The result: obvious failures slip through.

The card title bar renders `fg-default` on `tab-bg-active`. This pairing is not in
the map. The contrast engine never checks it. The UI shows illegible text. The tests
pass.

### The token naming problem

The pairings can't be reliably extracted from CSS because the token naming is
inconsistent:

| Token pattern | Role | Count | Examples |
|---------------|------|------:|---------|
| `fg-*` | Text/foreground color | 12 | fg-default, fg-muted, fg-link |
| `bg-*` | App-level background | 2 | bg-app, bg-canvas |
| `surface-*` | Component background | 8 | surface-default, surface-raised, surface-overlay |
| `control-*-bg-*` | Control background | ~50 | control-filled-accent-bg-rest |
| `control-*-fg-*` | Control text | ~50 | control-filled-accent-fg-rest |
| `field-bg-*` | Field background | 5 | field-bg-rest, field-bg-hover |
| `field-fg` / `field-placeholder` | Field text | 3 | field-fg, field-placeholder |
| `tab-bg-*` / `tab-fg-*` | Tab colors | 9 | tab-bg-active, tab-fg-active |
| `badge-tinted-*-bg/fg` | Badge colors | 21 | badge-tinted-accent-bg |
| `tone-*` | Semantic signals | 35 | tone-accent, tone-danger-fg |
| `toggle-*` | Switch/checkbox | 11 | toggle-track-on, toggle-thumb |
| `icon-*` | Icon colors | 11 | icon-active, icon-muted |
| `border-*` | Borders | 6 | border-default, border-strong |
| `shadow-*` | Shadows | 5 | shadow-md, shadow-lg |
| `divider-*` | Dividers | 2 | divider-default, divider-muted |
| `highlight-*` | Selection/drag | 6 | highlight-hover, highlight-flash |

The problem: "surface" tokens are backgrounds but don't use the `bg-` prefix.
`tab-bg-active` is a background. `control-filled-accent-bg-rest` is a background.
`field-bg-rest` is a background. These are all backgrounds but use 4 different
naming conventions. A tool trying to extract "which tokens are backgrounds" has to
understand all 4 patterns.

Similarly, foreground tokens use `fg-`, `control-*-fg-*`, `field-fg`, `tab-fg-*`,
`badge-tinted-*-fg`, `tone-*-fg`, and `icon-*` — 7 different patterns for "this
color goes on top of something."

**What must change:**

1. **Audit and regularize token naming.** Every token must be unambiguously
   classifiable as "element" (goes on top of a surface) or "surface" (things go on
   top of it). The naming convention must make this classification mechanical, not
   interpretive.

2. **Derive pairings from components.** Every `var(--tug-base-*)` used as `color`,
   `fill`, or `border-color` in component CSS, paired with the `var(--tug-base-*)`
   used as `background-color` in the same rendering context, is a contrast-required
   pairing. This must be extractable — either by a build-time tool that parses CSS,
   or by a disciplined component annotation system.

3. **Audit all existing components.** Verify every component uses tokens correctly
   and consistently. The audit produces the authoritative pairing list.

4. **Establish rules for future components.** New components must declare their
   foreground/background pairings. The contrast engine validates them automatically.

---

## Problem 3: Recipe formulas are opaque

The current `DerivationFormulas` interface has 198 numeric fields organized by 23
semantic decision groups. Even with `@semantic` tags and design rationale comments,
the interface is a wall of numbers. You can't look at it and understand what a recipe
*does* or how one recipe differs from another.

The iOS game's recipe is 22 color roles, each with 4 parameters. The description
says it plainly: "Colors based on PURPLE with more filled-in shapes on a light
background." The recipe's design intent is visible in its structure.

The Tug system needs a similar level of clarity. A recipe author (human or LLM)
should be able to:
- See the small number of meaningful design decisions a recipe makes
- Understand how each decision maps to visual outcomes
- Compare two recipes and see what differs
- Create a new recipe by making those decisions, not by filling in 198 fields

**What must change:**

1. **Reduce the effective parameter count.** Many of the 198 fields are
   mechanically derived from a smaller set of design decisions. The semantic groups
   from Part 2 identified ~13 core decisions. The interface should expose those
   decisions, not their expansion into per-state, per-role, per-property fields.
   (Part 3 of the contrast-engine-overhaul roadmap already identified this — the
   formula de-duplication that collapsed 74 per-role fields into 18 emphasis-level
   fields. This work was partially done but needs completion.)

2. **Make the Theme Generator expose recipe parameters meaningfully.** The current
   3 mood sliders (Surface Contrast, Signal Intensity, Warmth) don't provide useful
   control. The generator should expose the design decisions that actually matter:
   canvas brightness, text hierarchy spread, control prominence, border visibility,
   shadow depth. These are the knobs the iOS game's recipe system controls.

3. **Document what makes each recipe different.** A comparison table showing dark vs
   light vs dark/stark vs light/stark across each design decision — not 198 numbers,
   but the 13 decisions that distinguish them.

---

## Problem 4: Contrast enforcement has structural gaps

The contrast floor enforcement in the derivation engine (Part 4 of the
contrast-engine-overhaul roadmap) has three gaps:

1. **Missing pairings are not enforced.** If a pairing isn't in the map,
   `enforceContrastFloor` never runs for it. The card title bar is the most visible
   example.

2. **Composited surfaces are skipped.** Pairs with `parentSurface` (badges,
   highlights) are excluded from floor enforcement at line 2440:
   `if (pairing.parentSurface) continue;`. These tokens are validated post-derivation
   but never corrected.

3. **Tests only validate dark mode.** The core T3.5 accessibility test runs
   `deriveTheme(EXAMPLE_RECIPES.brio)` only. Harmony is never checked by the
   authoritative accessibility test.

**What must change:**

1. **Complete pairing coverage.** Every pairing from the component audit (Problem 2)
   must be in the map. No exceptions for "assumed valid."

2. **Handle composited surfaces.** The engine must either enforce contrast floors
   for composited surfaces (computing the composite inline) or mark them as requiring
   special treatment with a documented strategy.

3. **Validate every recipe.** The test suite must run contrast validation on every
   `EXAMPLE_RECIPES` entry, not just brio. Adding a recipe must automatically add it
   to contrast validation.

---

## Execution approach

These four problems are interconnected. The token naming audit (Problem 2) produces
the authoritative pairing list. The pairing list feeds the contrast engine
(Problem 4). Independent recipes (Problem 1) need the working contrast engine to
validate them. Recipe clarity (Problem 3) depends on the recipes being correct.

### Tooling: `audit-tokens.ts`

`tugdeck/scripts/audit-tokens.ts` (`bun run audit:tokens`) is the authoritative tool
for all token and pairing work. It runs in <100ms and replaces manual grep/bash
exploration. Every phase must use this tool — hours-long LLM-driven line-by-line
investigation of CSS files is an anti-pattern.

| Subcommand | What it does | When to use |
|------------|-------------|-------------|
| `tokens` | Extract and classify all 373 `--tug-base-*` tokens | Verify classification after any token rename |
| `pairings` | Parse all 23 CSS files, resolve aliases, extract foreground-on-background pairings | Verify pairing completeness; diagnose unresolved pairings |
| `rename [--apply]` | Bulk-rename tokens across all files (dry run by default) | Any token rename operation |
| `inject [--apply]` | Generate `@tug-pairings` comment blocks from CSS analysis | Regenerate CSS documentation after pairing map changes |
| `verify` | Cross-check `@tug-pairings` blocks against `element-surface-pairing-map.ts` | Confirm CSS blocks and pairing map are in sync |
| `lint` | Hard-fail (exit 1) on missing annotations, multi-hop aliases, missing blocks, unresolved pairings | CI gate; run after every step that touches CSS or tokens |

**Rules of Tugways enforcement (D81):**
- **Rule 16:** Every CSS rule that sets `color`/`fill`/`border-color` without
  `background-color` must include a `/* @tug-renders-on: --tug-base-{surface} */`
  annotation. `audit-tokens lint` enforces this.
- **Rule 17:** Component alias tokens resolve to `--tug-base-*` in one hop. No
  alias-to-alias chains (compat layers exempt via allowlist). `audit-tokens lint`
  flags violations.

**Implementation workflow for any step that modifies CSS or tokens:**
1. Make the change
2. Run `bun run audit:tokens lint` — immediate feedback
3. Run `bun run audit:tokens pairings` — verify zero unresolved
4. Run `bun run audit:tokens inject --apply` — regenerate `@tug-pairings` blocks
5. Run `bun run audit:tokens verify` — confirm map ↔ CSS consistency
6. Run `bun test` — confirm no test regressions

### Phase 1: Token audit and pairing extraction ✅ COMPLETE

*Completed via `tugplan-token-audit-pairing` (PR #138, merged).*

1. ✅ Audited all 23 component CSS files. Extracted every foreground-on-background
   token pairing. Produced the authoritative pairing list (275 CSS-declared pairings,
   339 map entries).
2. ✅ Regularized token naming: renamed 7 unclassifiable tokens so every `--tug-base-*`
   color token is mechanically classifiable as element, surface, or chromatic.
3. ✅ Compared extracted pairings against the pairing map. Identified and closed all
   gaps including the critical `fg-default` on `tab-bg-active` card title bar gap.
4. ✅ Established `@tug-pairings` CSS comment convention in all 23 component files.
5. ✅ Created `verify-pairings.ts` cross-check script.

### Phase 1.5: Make token pairings machine-auditable ✅ COMPLETE

*Completed via `tugplan-token-audit-enforce` (PR #139, merged).*

1. ✅ Added 145 `@tug-renders-on` annotations across 16 component CSS files — every
   color-setting rule now declares its rendering surface deterministically.
2. ✅ Flattened alias chains to 1 hop (tug-tab.css cross-component chains).
3. ✅ Built `audit-tokens.ts` with 6 subcommands: `tokens`, `pairings`, `rename`,
   `inject`, `verify`, `lint`.
4. ✅ Replaced heuristic surface resolution (4 strategies) with deterministic
   annotation-based parsing (2 strategies: same-rule match + annotation lookup).
5. ✅ Added Rules 16, 17, and D81 to the Rules of Tugways.
6. ✅ Exit criteria met: `lint` zero violations, `pairings` zero unresolved,
   `verify` zero gaps, all tests pass.

### Phase 2: Fix the contrast engine ✅ COMPLETE

*Completed via `tugplan-contrast-engine-fix` (PR #140, merged).*

1. ✅ Removed the `parentSurface` skip from `enforceContrastFloor`. Implemented
   two-pass composited enforcement: pass 1 handles opaque pairings, pass 2 defers
   semi-transparent pairings, composites via `compositeOverSurface` + `hexToOkLabL`,
   then enforces contrast against the composite.
2. ✅ Expanded test coverage: parameterized recipe loop validates every
   `EXAMPLE_RECIPES` entry automatically. Adding a recipe adds it to contrast
   validation.
3. ✅ Ran expanded validation on Harmony, captured all failures. Documented each
   failure with contrast value, threshold, role, and CSS rendering context.
   Cross-referenced via `bun run audit:tokens pairings`.
4. ✅ Cleaned up exception lists. Consolidated into shared module
   (`contrast-exceptions.ts`). Every entry tagged `[design-choice]` or
   `[phase-3-bug]` with inline rationale.
5. ✅ All tooling gates pass: `audit:tokens lint`, `audit:tokens verify`, `bun test`.

### Phase 3: Build independent recipes ✅ COMPLETE

*Completed via `tugplan-independent-recipes` (PR #141, merged).*

1. ✅ Verified `DARK_FORMULAS` annotations complete (200 fields, all with
   `@semantic` tags and design-rationale comments).
2. ✅ Built `LIGHT_FORMULAS` as a complete, independent 202-field literal object —
   every field explicitly set with light-mode design rationale. No spread from
   `BASE_FORMULAS`.
3. ✅ Calibrated both recipes using the Phase 2 contrast engine. Resolved all
   `[phase-3-bug]` entries: B03 (cardFrameActiveTone), B04 (new accentSubtleTone
   field), B05 (new cautionBgTone field), B02 (via LIGHT_FORMULAS values).
   B01/B06/B08 deferred as `[phase-4-engine]` (gamut ceiling, mode-aware tokens).
   B07 documented as `[design-choice]` (fg-inverse polarity).
4. ✅ Removed `BASE_FORMULAS`, `DARK_OVERRIDES`, `LIGHT_OVERRIDES`, and
   `LIGHT_FORMULAS_LEGACY`. Updated `EXAMPLE_RECIPES` to reference `DARK_FORMULAS`
   and `LIGHT_FORMULAS` directly.
5. ✅ Updated all test file imports. Regenerated CSS documentation via
   `audit:tokens inject --apply`. All tooling gates pass.
6. ✅ Fixed light-mode test formulas: T4.2, T4.4, T4.7 now use `LIGHT_FORMULAS`
   when mode is light, eliminating the root cause of B09-B14 surface contrast bugs.
   Removed `LIGHT_MODE_PAIR_EXCEPTIONS` and `LIGHT_MODE_BODY_TEXT_PAIR_EXCEPTIONS`
   entirely.

### Phase 3.5-tooling: Enhance audit-tokens for bulk rename

*Upgrades the `audit-tokens` rename infrastructure to handle the Phase 3.5A rename
(320+ tokens across 40+ files) safely and mechanically.*

#### The problem

The current `audit-tokens rename` subcommand has a hardcoded 7-entry rename map
from Phase 1. Phase 3.5A requires renaming every structured token in the system
(~320+ tokens) across every file that references them (~40+ files). The current
tooling cannot:

- Generate the rename map programmatically from the naming convention rules
- Load a rename map from an external file
- Handle component alias tokens (`--tug-card-*`, `--tug-tab-*`)
- Handle `@tug-renders-on` annotations
- Scan all files that reference tokens (missing ~15 files)
- Verify that no old names remain after rename

#### What must change

1. **`audit-tokens rename-map` subcommand (new).** Generates the complete old→new
   rename map by:
   - Reading the current token inventory from `audit-tokens tokens`
   - Parsing each token name to extract component, constituent, emphasis, role, state
   - Applying the Phase 3.5A six-slot naming convention to produce the new name
   - Outputting a JSON file (`token-rename-map.json`) with `{ "old-short": "new-short" }` entries
   - Validating: no collisions, all tokens covered, all new names well-formed

   The map generator encodes the naming rules as code, so the naming convention
   can be iterated — regenerate, preview, adjust — before touching any source files.

2. **`audit-tokens rename` enhancements:**

   a. **Load map from JSON.** Instead of only using the hardcoded `RENAME_MAP`,
      accept `--map token-rename-map.json` to load an external map. The hardcoded
      map becomes the fallback when no `--map` is specified.

   b. **Expanded file targets.** Add all files that reference tokens:
      - `src/__tests__/contrast-exceptions.ts`
      - `src/__tests__/theme-accessibility.test.ts`
      - `src/__tests__/debug-contrast.test.ts`
      - `src/__tests__/tug-checkbox-role.test.tsx`
      - `src/__tests__/tug-switch-role.test.tsx`
      - `src/__tests__/theme-export-import.test.tsx`
      - `src/components/tugways/theme-accessibility.ts`
      - `src/canvas-color.ts`
      - `src/globals.css`
      - `styles/tug-base.css`
      - `src/components/tugways/tug-checkbox.tsx`
      - `src/components/tugways/tug-switch.tsx`
      - `src/components/tugways/style-inspector-overlay.ts`
      - `scripts/audit-tokens.ts` (the script itself references token names)
      - Any other `.ts`, `.tsx`, or `.css` file under `tugdeck/src/` and
        `tugdeck/styles/` that contains `--tug-base-`
      Auto-discover target files by scanning for `--tug-base-` references rather
      than maintaining a hardcoded list.

   c. **Component alias handling.** Detect `var(--tug-base-*)` references inside
      component alias definitions (`--tug-card-*`, `--tug-tab-*`, etc. defined in
      `tug-card.css`, `tug-tab.css`, etc.) and update them when the base token
      they reference is renamed.

   d. **`@tug-renders-on` annotation handling.** These annotations reference token
      names as `/* @tug-renders-on: --tug-base-{name} */`. Update them when the
      referenced token is renamed.

3. **`audit-tokens rename --verify` mode (new).** After a rename is applied, scan
   all files for any remaining references to old token names. Reports every stale
   reference with file, line number, and the old name found. Exit code 1 if any
   remain. This is the safety net — run it after `--apply` to confirm nothing was
   missed.

4. **`audit-tokens rename --stats` mode (new).** Before applying, show a summary:
   total tokens to rename, files to modify, estimated replacements per file. Helps
   gauge the blast radius before committing.

#### Verification

- `bun run audit:tokens rename-map` produces a valid JSON map with no collisions
- `bun run audit:tokens rename --map token-rename-map.json` (dry run) shows all
  expected replacements
- `bun run audit:tokens rename --map token-rename-map.json --apply` applies cleanly
- `bun run audit:tokens rename --verify --map token-rename-map.json` reports zero
  stale references
- `bun run audit:tokens lint` — zero violations after rename
- `bun test` — all tests pass after rename

### Phase 3.5A: Standardize element/surface terminology and token naming convention

*Addresses the terminology fragmentation and inconsistent token naming across the
codebase. This is a comprehensive rename — no old names remain. Uses the tooling
from Phase 3.5-tooling for mechanical execution.*

#### The problem

The system uses three overlapping term pairs for the same design concept — the
figure/ground relationship where one color sits on top of another:

| Term pair | Where it appears |
|-----------|-----------------|
| foreground/background | CSS properties (`color`, `background-color`), some doc language |
| fg/bg | Token names (`fg-default`, `bg-app`), formula field prefixes (`fgDefaultTone`, `bgAppTone`) |
| element/surface | Pairing map (`element-surface-pairing-map.ts`), audit-tokens classification, `@tug-pairings` blocks |

Token names are also inconsistently structured. `fg-default` puts the role first.
`control-filled-accent-fg-rest` puts it in the middle. `tone-accent-fg` puts it at
the end. There is no rule to follow when adding a new token.

#### The solution: unified naming convention

**Plane** is the top-level distinction: `element` (the thing you need to see) or
`surface` (the thing it sits on). This aligns with WCAG's contrast model where every
check is between a visual mark and its adjacent color context.

Every structured token follows a six-slot naming convention:

```
<plane>-<component>-<constituent>-<emphasis>-<role>-<state>
```

| Slot | What it answers | Values |
|------|----------------|--------|
| **plane** | Which side of the contrast pair? | `element`, `surface` |
| **component** | What UI piece? | `global`, `control`, `field`, `tab`, `tone`, `badge`, `selection`, `toggle`, `checkmark`, `radio`, `overlay`, `highlight`, ... |
| **constituent** | What part of the component? | Element: `text`, `icon`, `border`, `shadow`, `divider`, `fill`, `thumb`, `dot`. Surface: `primary`, `track` |
| **emphasis** | How visually prominent? | `normal`, `filled`, `outlined`, `ghost`, `tinted` |
| **role** | What does it signify? | `default`, `muted`, `subtle`, `accent`, `action`, `danger`, `success`, `caution`, `agent`, `data`, `active`, `plain`, `selected`, `highlighted`, `on`, `off`, ... |
| **state** | What interaction state? | `rest`, `hover`, `active`, `focus`, `disabled`, `readOnly`, `mixed`, ... |

**Rules:**
- All six slots are always present. No shortcuts, no omissions, no exceptions.
- `rest` is the state for non-interactive tokens and for interactive tokens in
  their default state. Every token has a state.
- `normal` is the default emphasis (no special visual weight).
- `plain` is the default role (no semantic signal).
- `primary` is the default surface constituent.
- CamelCase within a slot is allowed when a slot value is compound
  (e.g., `onAccent` as a role, `dropTarget` as a state).
- `selected`, `highlighted`, `on`, `off`, and `mixed` are roles (persistent
  visual treatments), not states. This allows clean combination with interaction
  states: `surface-control-primary-normal-selected-hover`,
  `surface-toggle-track-normal-on-hover`.
- `disabled` is a state. Disabled tokens use role=`plain` because disabled
  appearance is uniform regardless of the token's semantic role.
- `fill` is an element constituent for solid-color visual marks (indicator dots,
  progress fills, accent swatches) that are not text, icons, borders, shadows,
  or dividers.
- `track`, `thumb`, `dot` are constituent values for toggle/radio sub-parts.
  Tracks are surfaces (things sit on them); thumbs and dots are elements.

#### Token rename map

**Global element tokens — text:**

| Current | Proposed |
|---------|----------|
| `fg-default` | `element-global-text-normal-default-rest` |
| `fg-muted` | `element-global-text-normal-muted-rest` |
| `fg-subtle` | `element-global-text-normal-subtle-rest` |
| `fg-disabled` | `element-global-text-normal-plain-disabled` |
| `fg-inverse` | `element-global-text-normal-inverse-rest` |
| `fg-placeholder` | `element-global-text-normal-placeholder-rest` |
| `fg-link` | `element-global-text-normal-link-rest` |
| `fg-link-hover` | `element-global-text-normal-link-hover` |
| `fg-onAccent` | `element-global-text-normal-onAccent-rest` |
| `fg-onDanger` | `element-global-text-normal-onDanger-rest` |
| `fg-onSuccess` | `element-global-text-normal-onSuccess-rest` |
| `fg-onCaution` | `element-global-text-normal-onCaution-rest` |

**Global element tokens — icon:**

| Current | Proposed |
|---------|----------|
| `icon-active` | `element-global-icon-normal-active-rest` |
| `icon-default` | `element-global-icon-normal-default-rest` |
| `icon-disabled` | `element-global-icon-normal-plain-disabled` |
| `icon-muted` | `element-global-icon-normal-muted-rest` |
| `icon-onAccent` | `element-global-icon-normal-onAccent-rest` |

**Global element tokens — border:**

| Current | Proposed |
|---------|----------|
| `border-default` | `element-global-border-normal-default-rest` |
| `border-muted` | `element-global-border-normal-muted-rest` |
| `border-strong` | `element-global-border-normal-strong-rest` |
| `border-inverse` | `element-global-border-normal-inverse-rest` |
| `border-accent` | `element-global-border-normal-accent-rest` |
| `border-danger` | `element-global-border-normal-danger-rest` |

**Global element tokens — divider:**

| Current | Proposed |
|---------|----------|
| `divider-default` | `element-global-divider-normal-default-rest` |
| `divider-muted` | `element-global-divider-normal-muted-rest` |
| `divider-separator` | `element-global-divider-normal-separator-rest` |

**Global element tokens — shadow:**

| Current | Proposed |
|---------|----------|
| `shadow-xs` | `element-global-shadow-normal-xs-rest` |
| `shadow-md` | `element-global-shadow-normal-md-rest` |
| `shadow-lg` | `element-global-shadow-normal-lg-rest` |
| `shadow-xl` | `element-global-shadow-normal-xl-rest` |
| `shadow-overlay` | `element-global-shadow-normal-overlay-rest` |

**Global surface tokens:**

| Current | Proposed |
|---------|----------|
| `bg-app` | `surface-global-primary-normal-app-rest` |
| `bg-canvas` | `surface-global-primary-normal-canvas-rest` |
| `surface-default` | `surface-global-primary-normal-default-rest` |
| `surface-raised` | `surface-global-primary-normal-raised-rest` |
| `surface-overlay` | `surface-global-primary-normal-overlay-rest` |
| `surface-sunken` | `surface-global-primary-normal-sunken-rest` |
| `surface-inset` | `surface-global-primary-normal-inset-rest` |
| `surface-content` | `surface-global-primary-normal-content-rest` |
| `surface-screen` | `surface-global-primary-normal-screen-rest` |
| `surface-control` | `surface-global-primary-normal-control-rest` |

**Control tokens — filled emphasis (accent example):**

| Current | Proposed |
|---------|----------|
| `control-filled-accent-fg-rest` | `element-control-text-filled-accent-rest` |
| `control-filled-accent-bg-rest` | `surface-control-primary-filled-accent-rest` |
| `control-filled-accent-icon-rest` | `element-control-icon-filled-accent-rest` |
| `control-filled-accent-border-rest` | `element-control-border-filled-accent-rest` |
| `control-filled-accent-fg-hover` | `element-control-text-filled-accent-hover` |
| `control-filled-accent-bg-hover` | `surface-control-primary-filled-accent-hover` |
| `control-filled-accent-icon-hover` | `element-control-icon-filled-accent-hover` |
| `control-filled-accent-border-hover` | `element-control-border-filled-accent-hover` |
| `control-filled-accent-fg-active` | `element-control-text-filled-accent-active` |
| `control-filled-accent-bg-active` | `surface-control-primary-filled-accent-active` |
| `control-filled-accent-icon-active` | `element-control-icon-filled-accent-active` |
| `control-filled-accent-border-active` | `element-control-border-filled-accent-active` |

(Same pattern repeats for action, danger, agent, data, success, caution roles
across filled/outlined/ghost emphasis levels — ~120 control tokens total.)

**Control tokens — disabled, highlighted, selected:**

Disabled tokens use role=`plain` and state=`disabled` because disabled appearance
is uniform regardless of the token's original semantic role. Selected and
highlighted are roles (persistent visual treatments), allowing clean combination
with interaction states.

| Current | Proposed |
|---------|----------|
| `control-disabled-fg` | `element-control-text-normal-plain-disabled` |
| `control-disabled-bg` | `surface-control-primary-normal-plain-disabled` |
| `control-disabled-icon` | `element-control-icon-normal-plain-disabled` |
| `control-disabled-border` | `element-control-border-normal-plain-disabled` |
| `control-disabled-shadow` | `element-control-shadow-normal-plain-disabled` |
| `control-highlighted-fg` | `element-control-text-normal-highlighted-rest` |
| `control-highlighted-bg` | `surface-control-primary-normal-highlighted-rest` |
| `control-highlighted-border` | `element-control-border-normal-highlighted-rest` |
| `control-selected-fg` | `element-control-text-normal-selected-rest` |
| `control-selected-bg` | `surface-control-primary-normal-selected-rest` |
| `control-selected-bg-hover` | `surface-control-primary-normal-selected-hover` |
| `control-selected-border` | `element-control-border-normal-selected-rest` |
| `control-selected-disabled-bg` | `surface-control-primary-normal-selected-disabled` |

**Tab tokens:**

| Current | Proposed |
|---------|----------|
| `tab-fg-rest` | `element-tab-text-normal-plain-rest` |
| `tab-fg-hover` | `element-tab-text-normal-plain-hover` |
| `tab-fg-active` | `element-tab-text-normal-plain-active` |
| `tab-bg-active` | `surface-tab-primary-normal-plain-active` |
| `tab-bg-hover` | `surface-tab-primary-normal-plain-hover` |
| `tab-bg-inactive` | `surface-tab-primary-normal-plain-inactive` |
| `tab-bg-collapsed` | `surface-tab-primary-normal-plain-collapsed` |
| `tab-close-fg-hover` | `element-tabClose-text-normal-plain-hover` |
| `tab-close-bg-hover` | `surface-tabClose-primary-normal-plain-hover` |

**Tone tokens (semantic signals):**

| Current | Proposed |
|---------|----------|
| `tone-accent-fg` | `element-tone-text-normal-accent-rest` |
| `tone-accent-bg` | `surface-tone-primary-normal-accent-rest` |
| `tone-accent-icon` | `element-tone-icon-normal-accent-rest` |
| `tone-accent-border` | `element-tone-border-normal-accent-rest` |
| `tone-accent` | `element-tone-fill-normal-accent-rest` |

(Same pattern for active, agent, caution, danger, data, success.)

**Field tokens — text:**

`label`, `placeholder`, and `required` are roles (what kind of text within the
field), not states. `disabled` and `readOnly` are states.

| Current | Proposed |
|---------|----------|
| `field-fg-default` | `element-field-text-normal-plain-rest` |
| `field-fg-disabled` | `element-field-text-normal-plain-disabled` |
| `field-fg-label` | `element-field-text-normal-label-rest` |
| `field-fg-placeholder` | `element-field-text-normal-placeholder-rest` |
| `field-fg-readOnly` | `element-field-text-normal-plain-readOnly` |
| `field-fg-required` | `element-field-text-normal-required-rest` |

**Field tokens — surface:**

| Current | Proposed |
|---------|----------|
| `field-bg-rest` | `surface-field-primary-normal-plain-rest` |
| `field-bg-hover` | `surface-field-primary-normal-plain-hover` |
| `field-bg-focus` | `surface-field-primary-normal-plain-focus` |
| `field-bg-disabled` | `surface-field-primary-normal-plain-disabled` |
| `field-bg-readOnly` | `surface-field-primary-normal-plain-readOnly` |

**Field tokens — border:**

| Current | Proposed |
|---------|----------|
| `field-border-rest` | `element-field-border-normal-plain-rest` |
| `field-border-hover` | `element-field-border-normal-plain-hover` |
| `field-border-active` | `element-field-border-normal-plain-active` |
| `field-border-disabled` | `element-field-border-normal-plain-disabled` |
| `field-border-readOnly` | `element-field-border-normal-plain-readOnly` |
| `field-border-danger` | `element-field-border-normal-danger-rest` |
| `field-border-success` | `element-field-border-normal-success-rest` |

**Field tokens — fill (validation indicator colors):**

| Current | Proposed |
|---------|----------|
| `field-tone-caution` | `element-field-fill-normal-caution-rest` |
| `field-tone-danger` | `element-field-fill-normal-danger-rest` |
| `field-tone-success` | `element-field-fill-normal-success-rest` |

**Badge tokens:**

| Current | Proposed |
|---------|----------|
| `badge-tinted-accent-fg` | `element-badge-text-tinted-accent-rest` |
| `badge-tinted-accent-bg` | `surface-badge-primary-tinted-accent-rest` |
| `badge-tinted-accent-border` | `element-badge-border-tinted-accent-rest` |

(Same pattern for action, agent, caution, danger, data, success.)

**Selection tokens:**

| Current | Proposed |
|---------|----------|
| `selection-fg` | `element-selection-text-normal-plain-rest` |
| `selection-bg` | `surface-selection-primary-normal-plain-rest` |
| `selection-bg-inactive` | `surface-selection-primary-normal-plain-inactive` |

**Checkmark/toggle tokens:**

| Current | Proposed |
|---------|----------|
| `checkmark-fg` | `element-checkmark-text-normal-plain-rest` |
| `checkmark-fg-mixed` | `element-checkmark-text-normal-plain-mixed` |
| `toggle-icon-disabled` | `element-toggle-icon-normal-plain-disabled` |
| `toggle-icon-mixed` | `element-toggle-icon-normal-plain-mixed` |

**Toggle track tokens (surfaces — things sit on them):**

Toggle value states (`on`, `off`, `mixed`) are roles (persistent visual
treatments). `hover` and `disabled` are interaction states. This cleanly
decomposes the compounds without needing camelCase state values.

| Current | Proposed |
|---------|----------|
| `toggle-track-off` | `surface-toggle-track-normal-off-rest` |
| `toggle-track-off-hover` | `surface-toggle-track-normal-off-hover` |
| `toggle-track-on` | `surface-toggle-track-normal-on-rest` |
| `toggle-track-on-hover` | `surface-toggle-track-normal-on-hover` |
| `toggle-track-disabled` | `surface-toggle-track-normal-plain-disabled` |
| `toggle-track-mixed` | `surface-toggle-track-normal-mixed-rest` |
| `toggle-track-mixed-hover` | `surface-toggle-track-normal-mixed-hover` |

**Toggle thumb / radio dot tokens (elements — visible marks on surfaces):**

| Current | Proposed |
|---------|----------|
| `toggle-thumb` | `element-toggle-thumb-normal-plain-rest` |
| `toggle-thumb-disabled` | `element-toggle-thumb-normal-plain-disabled` |
| `radio-dot` | `element-radio-dot-normal-plain-rest` |

**Overlay tokens (surfaces — content sits on top of them):**

| Current | Proposed |
|---------|----------|
| `overlay-dim` | `surface-overlay-primary-normal-dim-rest` |
| `overlay-scrim` | `surface-overlay-primary-normal-scrim-rest` |
| `overlay-highlight` | `surface-overlay-primary-normal-highlight-rest` |

**Highlight tokens (surfaces — colored feedback regions behind content):**

The role describes the purpose of the highlight (`hover`, `dropTarget`, etc.).
These are not interaction states — `hover` here means "the highlight that
signifies hover," not "a highlight in a hover state."

| Current | Proposed |
|---------|----------|
| `highlight-hover` | `surface-highlight-primary-normal-hover-rest` |
| `highlight-dropTarget` | `surface-highlight-primary-normal-dropTarget-rest` |
| `highlight-preview` | `surface-highlight-primary-normal-preview-rest` |
| `highlight-inspectorTarget` | `surface-highlight-primary-normal-inspectorTarget-rest` |
| `highlight-snapGuide` | `surface-highlight-primary-normal-snapGuide-rest` |
| `highlight-flash` | `surface-highlight-primary-normal-flash-rest` |

**Tone fill tokens (elements — solid-color visual marks):**

Pure chromatic values for semantic signals — indicator dots, progress fills,
colored accents. The `fill` constituent covers solid-color visual marks that
are not text, icons, borders, shadows, or dividers.

| Current | Proposed |
|---------|----------|
| `tone-accent` | `element-tone-fill-normal-accent-rest` |
| `tone-active` | `element-tone-fill-normal-active-rest` |
| `tone-agent` | `element-tone-fill-normal-agent-rest` |
| `tone-data` | `element-tone-fill-normal-data-rest` |
| `tone-success` | `element-tone-fill-normal-success-rest` |
| `tone-caution` | `element-tone-fill-normal-caution-rest` |
| `tone-danger` | `element-tone-fill-normal-danger-rest` |

**Accent fill tokens (elements — global accent chromatic values):**

| Current | Proposed |
|---------|----------|
| `accent-default` | `element-global-fill-normal-accent-rest` |
| `accent-cool-default` | `element-global-fill-normal-accentCool-rest` |
| `accent-subtle` | `element-global-fill-normal-accentSubtle-rest` |

**Field tone tokens (elements — validation indicator fills):**

| Current | Proposed |
|---------|----------|
| `field-tone-danger` | `element-field-fill-normal-danger-rest` |
| `field-tone-caution` | `element-field-fill-normal-caution-rest` |
| `field-tone-success` | `element-field-fill-normal-success-rest` |

#### Execution strategy

This is a complete rename. No old names remain. The Phase 3.5-tooling upgrades
make this mechanical rather than manual.

**Step 0: Update the seed rename map to match the finalized convention.**

The Phase 3.5-tooling was built before the naming convention was finalized.
The seed rename map (`tugdeck/scripts/seed-rename-map.ts`) uses the draft
convention (constituent in slot 5, state omitted for stateless tokens). It
must be updated to match the finalized convention before the rename can proceed.

Changes required to `seed-rename-map.ts`:

1. **Header comment:** Update the slot order from
   `<plane>-<component>-<emphasis>-<role>-<channel>-<state>` to
   `<plane>-<component>-<constituent>-<emphasis>-<role>-<state>`.
   Rename `channel` to `constituent`. Remove "(omitted for stateless)" from
   the state line; state is always present.

2. **Slot reorder (all ~340 non-identity entries):** Move the constituent
   from slot 5 to slot 3. Examples:
   - `element-global-normal-default-text` → `element-global-text-normal-default-rest`
   - `surface-control-filled-accent-primary-rest` → `surface-control-primary-filled-accent-rest`
   - `element-control-filled-accent-text-rest` → `element-control-text-filled-accent-rest`

3. **Add `-rest` to all stateless tokens (~90 entries):** Every five-slot name
   gets `-rest` appended. Examples:
   - `element-global-normal-default-text` → `element-global-text-normal-default-rest`
   - `surface-global-normal-app-primary` → `surface-global-primary-normal-app-rest`
   - `element-tone-normal-accent-text` → `element-tone-text-normal-accent-rest`

4. **Semantic fixes:**
   - `fg-link-hover`: `linkHover` compound decomposes into role=`link`,
     state=`hover` → `element-global-text-normal-link-hover`
   - `fg-disabled`, `icon-disabled`: `disabled` is a state, not a role.
     Role becomes `plain` → `element-global-text-normal-plain-disabled`,
     `element-global-icon-normal-plain-disabled`
   - `control-disabled-*`: same — role=`plain`, state=`disabled` →
     `element-control-text-normal-plain-disabled`, etc.
   - `control-highlighted-*`: `highlighted` stays as role, add state=`rest` →
     `element-control-text-normal-highlighted-rest`, etc.
   - `control-selected-*`: `selected` stays as role, add state=`rest` →
     `element-control-text-normal-selected-rest`
   - `control-selected-bg-hover`: `selected` is role, `hover` is state →
     `surface-control-primary-normal-selected-hover`
   - `control-selected-disabled-bg`: `selected` is role, `disabled` is state →
     `surface-control-primary-normal-selected-disabled` (no compound needed)
   - Field text: `label`, `placeholder`, `required` are roles; `disabled`,
     `readOnly` are states. `field-fg-default` → `element-field-text-normal-plain-rest`
   - `checkmark-fg-mixed`, `toggle-icon-mixed`: `mixed` is a state →
     `element-checkmark-text-normal-plain-mixed`,
     `element-toggle-icon-normal-plain-mixed`

5. **Convert all 32 formerly-chromatic tokens to six-slot names.** Replace
   the three-slot entries in the seed map (previously using an escape-hatch
   convention) with proper six-slot names. Toggle tracks → surfaces with
   `on`/`off`/`mixed` as roles. Toggle thumbs/radio dots → elements. Overlays
   and highlights → surfaces. Tone/accent/field-tone fills → elements with
   `fill` constituent. See the token rename tables above for the complete mapping.

Verification after Step 0:
```bash
bun run audit:tokens rename-map        # exits 0, zero validation errors
bun run audit:tokens rename-map --json > /tmp/verify-map.json
bun run audit:tokens lint              # exits 0
bun test                               # all tests pass
```

**Step 1: Generate the rename map.**

```bash
bun run audit:tokens rename-map --json > token-rename-map.json
```

Review the generated map. Verify every new name follows the finalized
six-slot convention. Iterate if any names look wrong — the naming convention
is encoded in `seed-rename-map.ts`, so changes are mechanical.

**Step 2: Preview the rename.**

```bash
bun run audit:tokens rename --map token-rename-map.json --stats
bun run audit:tokens rename --map token-rename-map.json
```

The stats mode shows the blast radius. The dry run shows every replacement that
will be made. Review for surprises.

**Step 3: Apply the rename.**

```bash
bun run audit:tokens rename --map token-rename-map.json --apply
```

This is the single mechanical step that renames all token references across all
files — CSS custom properties, `var()` references, `@tug-renders-on` annotations,
component alias definitions, TypeScript string keys, test assertions, contrast
exception strings, gallery/preview components.

**Step 4: Regenerate derived files.**

```bash
bun run audit:tokens inject --apply    # regenerate @tug-pairings blocks
bun run generate:tokens                # regenerate tug-base-generated.css + harmony.css
```

**Step 5: Verify nothing was missed.**

```bash
bun run audit:tokens rename --verify --map token-rename-map.json
```

Exit code 0 means zero stale references to old names remain anywhere in the
project.

**Step 6: Full verification gates.**

```bash
bun run audit:tokens lint       # zero violations
bun run audit:tokens pairings   # zero unresolved
bun run audit:tokens verify     # map ↔ CSS consistency
bun test                        # all tests pass
```

**Step 7: Update documentation.** All references to old token names in docs,
roadmaps, and design-system-concepts.md updated to new names. All
"foreground/background" language in design docs updated to "element/surface."
Add a rule to the Rules of Tugways establishing element/surface as the canonical
vocabulary for contrast and pairing discussions.

#### Scope of changes

Every file that references a `--tug-base-*` token is updated by the rename tool.
The auto-discovery in Phase 3.5-tooling ensures no files are missed. The major
categories:

1. **CSS custom property names** — all 373 `--tug-base-*` tokens renamed
2. **Component CSS files** (23 files) — `var()` references, `@tug-renders-on`
   annotations, component alias definitions
3. **Component alias tokens** (`--tug-card-*`, `--tug-tab-*`, etc.) — updated
   to reference new `--tug-base-*` names
4. **TypeScript source** — derivation rules, pairing map, theme engine, theme
   accessibility, canvas color, gallery/preview components
5. **Test files** — assertions, exception sets, descriptions
6. **Generated CSS** — regenerated via `generate:tokens`
7. **Documentation** — roadmaps, design docs, code comments
8. **audit-tokens.ts** — internal token references updated

### Phase 3.5B: Design vocabulary — semantic text types, contrast roles, recipe inputs

*Establishes the design vocabulary for the element plane, updates contrast roles,
and restructures recipe color inputs to match the naming convention from Phase 3.5A.*

#### Semantic text types

The current system treats all text as a single category. The same global text token
is used for card titles, body prose, button labels, and status text. But these serve
different design purposes. Phase 3.5A's naming convention already separates text
tokens by component (control, tab, badge, field). This phase completes the picture
by defining the semantic text types that drive element plane hue selection and
contrast role assignment.

| Type | Purpose | Examples |
|------|---------|---------|
| **content** | Prose, body text, descriptions | Card body, paragraphs, list items |
| **control** | Interactive element labels | Button text, menu items, tab labels |
| **display** | Titles, headers, emphasis | Card titles, section headers, hero text |
| **informational** | Status, metadata, secondary | Badges, timestamps, placeholders, muted text |

These types inform two things: (1) which element plane hue a token uses, and
(2) which contrast role the pairing map assigns to it.

#### Contrast roles

The current contrast role vocabulary is ad-hoc (`body-text`, `ui-component`,
`subdued-text`). Replace with four roles that map to the semantic text types:

| Current role | New role | Threshold |
|-------------|----------|-----------|
| `body-text` | `content` | 75 |
| `ui-component` | `control` | 60 |
| *(new)* | `display` | 45 |
| `subdued-text` | `informational` | 30 |

The `decorative` role (threshold 15) is retained for non-text ornamental elements
where contrast is not a legibility concern.

#### Card title token

The card title currently uses the global default text token. It needs its own token
(`element-cardTitle-text-normal-plain-rest` per the Phase 3.5A convention) with its own
derivation rule and formula fields. This gives the card title independent control
over hue, tone, and intensity — and allows the pairing map to assign it the
`display` contrast role instead of `content`.

#### Recipe color inputs

The current `ThemeRecipe` interface specifies 13 hue inputs split into "structural"
and "role." This split mixes planes — `canvas` and `cardBg` are surfaces, `text`
and `borderTint` are elements, and `cardFrame` should be derived rather than
specified directly. The recipe inputs are reorganized into three groups that map
directly to the naming convention from Phase 3.5A:

**Surface plane (2 hues)** — what the backgrounds look like:

| Input | Controls | Current equivalent |
|-------|----------|-------------------|
| `canvas` | App background, canvas surface | `canvas` |
| `card` | Card/panel surfaces, overlays, insets | `cardBg` |

**Element plane (6 hues)** — what the foreground marks look like. The four textual
hues map to the semantic text types. The two graphical hues (`border`, `decorative`)
cover non-text visual marks:

| Input | Controls | Current equivalent |
|-------|----------|-------------------|
| `content` | Body prose text, primary icons | `text` |
| `control` | Interactive element labels, control icons | *(derived from `text` via intensity)* |
| `display` | Card titles, section headers | *(no equivalent — used global text token)* |
| `informational` | Muted/subtle text, metadata, placeholders | *(derived from `text` via intensity)* |
| `border` | Borders, dividers; formula basis for frame color | `borderTint` |
| `decorative` | Canvas grid, ornamental marks | *(missing — was `grid` in early designs)* |

**Semantic roles (7 hues)** — signal colors used across both planes:

| Input | Controls | Current equivalent |
|-------|----------|-------------------|
| `accent` | Accent signals (highlights, selection) | `accent` |
| `action` | Action signals (buttons, links, interactive cues) | `active` |
| `agent` | Agent/AI signals | `agent` |
| `data` | Data visualization signals | `data` |
| `success` | Success signals | `success` |
| `caution` | Warning signals | `caution` |
| `danger` | Error/destructive signals | `destructive` |

Total: 2 + 6 + 7 = 15 hue inputs.

**Derived values (not recipe inputs):**

| Value | Derived from | Rationale |
|-------|-------------|-----------|
| Frame color | `element.border` hue + formula | The card frame is visually an extension of the border system — same hue family, different tone/intensity. Deriving it from the border input ensures visual coherence without requiring a separate color choice. |
| Link color | `element.content` hue + `role.action` | Links are content text that signal action. The hue comes from the element plane; the semantic signal comes from the action role. |

#### Proposed ThemeRecipe interface

```typescript
export interface ThemeRecipe {
  name: string;
  description: string;
  mode: "dark" | "light";

  /** Surface plane — hues for backgrounds. */
  surface: {
    canvas: string;         // app background, canvas
    card: string;           // card/panel surfaces, overlays, insets
  };

  /** Element plane — hues for foreground marks. */
  element: {
    content: string;        // body prose, primary icons
    control: string;        // interactive labels, control icons
    display: string;        // card titles, section headers
    informational: string;  // muted/subtle text, metadata
    border: string;         // borders, dividers; formula basis for frame
    decorative: string;     // canvas grid, ornamental marks
  };

  /** Semantic roles — signal hues used across both planes. */
  role: {
    accent: string;         // highlights, selection
    action: string;         // buttons, links, interactive cues
    agent: string;          // agent/AI signals
    data: string;           // data visualization
    success: string;        // success signals
    caution: string;        // warning signals
    danger: string;         // error/destructive signals
  };

  /** Mood knobs (Phase 4 will expand these). */
  surfaceContrast?: number;   // 0-100, default 50
  signalIntensity?: number;   // 0-100, default 50
  warmth?: number;            // 0-100, default 50

  /** Formula constants for this recipe. */
  formulas?: DerivationFormulas;
}
```

#### What must change

1. **Define the four semantic text types** (`content`, `control`, `display`,
   `informational`) in design-system-concepts.md with purpose and examples.

2. **Update contrast roles.** Replace the current three-role system (`body-text`,
   `ui-component`, `subdued-text`) with the four-role system (`content`, `control`,
   `display`, `informational`) in the contrast engine's `CONTRAST_THRESHOLDS` map.

3. **Add a card title text token.** Create `element-cardTitle-text-normal-plain-rest`
   with its own derivation rule and formula fields. Update `tug-card.css` to use
   this token for `.tugcard-title`. The token uses the `display` element hue.

4. **Update `ThemeRecipe` interface.** Replace the flat hue fields with the nested
   `surface`, `element`, `role` structure. Remove `cardFrame` (derived), `link`
   (derived), `borderTint` (renamed to `element.border`). Add `element.control`,
   `element.display`, `element.informational`, `element.decorative`. Rename
   `text` to `element.content`, `destructive` to `role.danger`.

5. **Update `EXAMPLE_RECIPES`.** Rewrite `brio` and `harmony` recipe objects to use
   the new structure. Choose appropriate hues for `control`, `display`,
   `informational`, and `decorative` — these are new design decisions.

6. **Update `resolveHueSlots()`.** Update Layer 1 hue resolution to read from the
   nested structure and to derive `frame` from `element.border` and `link` from
   `element.content` + `role.action`.

7. **Add derivation rules for the new element hues.** The element plane currently
   uses a single `text` hue slot for all text tokens. Add hue slots for `control`,
   `display`, `informational`, and `decorative`. Update derivation rules so each
   text token uses the hue slot matching its semantic text type.

8. **Update the pairing map roles.** Reassign every pairing in
   `element-surface-pairing-map.ts` to use the four-role vocabulary:
   - Global text tokens (default) → `content`
   - Control text tokens → `control`
   - Card title token → `display`
   - Badge text, placeholder, muted → `informational`
   - Icon, border, divider → `control`

9. **Update the Theme Generator UI.** Replace "Structural" / "Roles" column headers
   with "Surface" / "Element" / "Roles" groupings. Add hue pickers for the new
   element inputs.

10. **Update `@tug-pairings` blocks** via `bun run audit:tokens inject --apply`.

11. **Update contrast exception sets.** Some exceptions may be resolved by the
    threshold changes. Review and remove resolved entries.

12. **Verify:** `bun run audit:tokens lint`, `bun run audit:tokens pairings`,
    `bun run audit:tokens inject --apply`, `bun run audit:tokens verify`,
    `bun test` after all changes.

#### Note on emphasis

Emphasis (filled/outlined/ghost) is not a recipe color input. It controls how a role
color is *rendered* — filled renders the hue as a solid surface, outlined renders it
as a border, ghost renders it as transparent. The hue comes from the role; the
rendering strategy comes from the emphasis. Emphasis may become a recipe-level
*strategy parameter* in Phase 4 (e.g., "this recipe's default control emphasis is
outlined"), but it is not a color specification concern.

### Phase 3.5C: Spell out formula field abbreviations

*Addresses the readability tax of cryptic formula field names.*

The `DerivationFormulas` interface uses terse abbreviations that obscure meaning:
`txtI`, `atmI`, `txtISubtle`, `bgAppI`, `fgDefaultTone`. These names require
memorization or constant cross-referencing with JSDoc comments. Every person (or LLM)
reading the code pays this tax.

**Rename policy:** All formula field names in the `DerivationFormulas` interface,
`DARK_FORMULAS`, `LIGHT_FORMULAS`, and `derivation-rules.ts` are renamed to
self-documenting spelled-out names. The new names should align with the vocabulary
established in Phases 3.5A and 3.5B — using `element`, `surface`, `content`,
`control`, `display`, `informational` where applicable.

**Examples:**

| Current | Renamed |
|---------|---------|
| `txtI` | `contentTextIntensity` |
| `atmI` | `atmosphereIntensity` |
| `txtISubtle` | `informationalTextIntensity` |
| `bgAppTone` | `surfaceAppTone` |
| `bgAppI` | `surfaceAppIntensity` |
| `fgDefaultTone` | `contentTextTone` |
| `surfaceDefaultI` | `surfaceDefaultIntensity` |
| `cardFrameActiveI` | `cardFrameActiveIntensity` |

**What must change:**

1. **Rename all formula fields** in the `DerivationFormulas` interface (202 fields).
   Use a TypeScript-aware refactoring tool to ensure all references are updated
   atomically.

2. **Update `DARK_FORMULAS` and `LIGHT_FORMULAS`** — every field assignment gets
   the new name.

3. **Update `derivation-rules.ts`** — all `formulas.txtI` references become
   `formulas.contentTextIntensity`, etc.

4. **Update test assertions** that reference formula field names by string.

5. **Verify:** TypeScript compilation (zero errors), `bun run audit:tokens lint`,
   `bun test`. No behavioral changes — this is a pure rename.

**Naming conventions:**
- Tone fields: `<context>Tone` (e.g., `contentTextTone`, `surfaceRaisedTone`)
- Intensity fields: `<context>Intensity` (e.g., `contentTextIntensity`, `cardFrameActiveIntensity`)
- Alpha fields: `<context>Alpha` (e.g., `shadowExtraSmallAlpha`)
- Hue dispatch fields: `<context>HueSlot` (e.g., `contentHueSlot`, `cardFrameHueSlot`)
- String expression fields: `<context>HueExpression` (e.g., `mutedHueExpression`)

### Phase 4: Recipe authoring system

*Addresses Problem 3. Makes the 200-field `DerivationFormulas` wall approachable by
introducing a high-level design parameter language that compiles down to formula
values.*

#### The recipe/theme distinction

A **recipe** is a rendering strategy. It answers: "Given colors, how should they
appear?" A recipe is the complete set of design decisions about brightness, contrast,
hierarchy, weight, and depth. It is mode-specific (dark vs light) because those are
fundamentally different rendering strategies. A recipe has no color identity — it is
a lens, not a picture.

A **theme** is a recipe + a palette. It answers: "What does this app look like?" Brio
is a theme: indigo surfaces, orange accents, rendered through the dark recipe's
strategy. Swap the hues to teal/red and you get a different theme from the same
recipe. Swap the recipe to light and you get a different theme from the same palette.

Currently: `ThemeRecipe` contains `formulas` (strategy) and `surface`/`element`/`role`
hues (palette). But the strategy part — the 200 formula fields — is opaque. The
three mood sliders (`surfaceContrast`, `signalIntensity`, `warmth`) were supposed to
be the readable strategy layer, but three vague knobs controlling a fraction of the
fields don't cut it.

#### Design parameters: a high-level language for recipes

Seven design parameters replace the three mood sliders. Each parameter controls a
coherent visual dimension of the recipe strategy. Each maps to 8-30+ formula fields.
Together they cover the full formula space (excluding hue-slot-dispatch and
hue-name-dispatch fields, which are structural routing decisions, not visual tuning).

All parameters use a 0-100 scale with 50 as the default (matching current
`DARK_FORMULAS` / `LIGHT_FORMULAS` values). Moving a slider from 50 interpolates
linearly toward curated endpoint values.

##### P1: Surface Depth

*How much tonal separation between surface layers?*

- 0 → flat, all surfaces near the same brightness, minimal spatial hierarchy
- 100 → strong steps between app/canvas/default/raised/overlay, pronounced depth

**Formula fields controlled** (canvas-darkness + surface-layering + surface-coloring):

| Field | Group | What it controls |
|-------|-------|-----------------|
| `surfaceAppTone` | canvas-darkness | App background lightness anchor |
| `surfaceCanvasTone` | canvas-darkness | Canvas background lightness anchor |
| `surfaceSunkenTone` | surface-layering | Sunken surface lightness |
| `surfaceDefaultTone` | surface-layering | Default surface lightness |
| `surfaceRaisedTone` | surface-layering | Raised surface lightness |
| `surfaceOverlayTone` | surface-layering | Overlay surface lightness |
| `surfaceInsetTone` | surface-layering | Inset surface lightness |
| `surfaceContentTone` | surface-layering | Content surface lightness |
| `surfaceScreenTone` | surface-layering | Screen surface lightness |
| `surfaceDefaultIntensity` | surface-coloring | Default surface chroma |
| `surfaceRaisedIntensity` | surface-coloring | Raised surface chroma |
| `surfaceOverlayIntensity` | surface-coloring | Overlay surface chroma |
| `surfaceScreenIntensity` | surface-coloring | Screen surface chroma |
| `surfaceInsetIntensity` | surface-coloring | Inset surface chroma |
| `surfaceContentIntensity` | surface-coloring | Content surface chroma |
| `surfaceAppBaseIntensity` | surface-coloring | App surface base chroma |
| `surfaceCanvasToneBase` | computed-tone-override | Canvas tone computation base |
| `surfaceCanvasToneCenter` | computed-tone-override | Canvas tone center point |
| `surfaceCanvasToneScale` | computed-tone-override | Canvas tone scale factor |

*19 fields. The key relationship is the spread between the darkest surface
(app/canvas) and the lightest (overlay/raised in dark mode, or the inverse in
light mode).*

##### P2: Text Hierarchy

*How much spread between text levels?*

- 0 → all text similar brightness, democratic, everything equally readable
- 100 → big gap between default and muted/subtle, strong reading order

**Formula fields controlled** (text-brightness + text-hierarchy + text-coloring):

| Field | Group | What it controls |
|-------|-------|-----------------|
| `contentTextTone` | text-brightness | Primary text lightness |
| `inverseTextTone` | text-brightness | Inverse text lightness |
| `mutedTextTone` | text-hierarchy | Muted text lightness |
| `subtleTextTone` | text-hierarchy | Subtle text lightness |
| `disabledTextTone` | text-hierarchy | Disabled text lightness |
| `placeholderTextTone` | text-hierarchy | Placeholder text lightness |
| `contentTextIntensity` | text-coloring | Primary text chroma |
| `subtleTextIntensity` | text-coloring | Subtle text chroma |
| `mutedTextIntensity` | text-coloring | Muted text chroma |
| `inverseTextIntensity` | text-coloring | Inverse text chroma |
| `disabledTextToneComputed` | computed-tone-override | Disabled text computed tone |

*11 fields. The key relationship is the tonal spread between `contentTextTone`
(the brightest, most readable) and `subtleTextTone`/`disabledTextTone` (the
dimmest). Intensity fields track the tonal hierarchy — dimmer text also gets
lower chroma.*

##### P3: Control Weight

*How visually heavy are interactive elements?*

- 0 → light, airy, minimal presence
- 100 → bold, solid, high-contrast interactive surfaces

**Formula fields controlled** (filled-control-prominence + outlined-control-style +
ghost-control-style):

| Field | Group | What it controls |
|-------|-------|-----------------|
| `filledSurfaceRestTone` | filled-control-prominence | Filled button rest tone |
| `filledSurfaceHoverTone` | filled-control-prominence | Filled button hover tone |
| `filledSurfaceActiveTone` | filled-control-prominence | Filled button active tone |
| `outlinedTextRestTone` | outlined-control-style | Outlined text rest tone |
| `outlinedTextHoverTone` | outlined-control-style | Outlined text hover tone |
| `outlinedTextActiveTone` | outlined-control-style | Outlined text active tone |
| `outlinedTextIntensity` | outlined-control-style | Outlined text chroma |
| `outlinedIconIntensity` | outlined-control-style | Outlined icon chroma |
| `outlinedSurfaceHoverIntensity` | outlined-control-style | Outlined hover surface chroma |
| `outlinedSurfaceHoverAlpha` | outlined-control-style | Outlined hover surface opacity |
| `outlinedSurfaceActiveIntensity` | outlined-control-style | Outlined active surface chroma |
| `outlinedSurfaceActiveAlpha` | outlined-control-style | Outlined active surface opacity |
| `outlinedOptionBorderRestTone` | outlined-control-style | Option border rest tone |
| `outlinedOptionBorderHoverTone` | outlined-control-style | Option border hover tone |
| `outlinedOptionBorderActiveTone` | outlined-control-style | Option border active tone |
| `ghostTextRestIntensity` | ghost-control-style | Ghost text rest chroma |
| `ghostTextHoverIntensity` | ghost-control-style | Ghost text hover chroma |
| `ghostTextActiveIntensity` | ghost-control-style | Ghost text active chroma |
| `ghostIconRestIntensity` | ghost-control-style | Ghost icon rest chroma |
| `ghostIconHoverIntensity` | ghost-control-style | Ghost icon hover chroma |
| `ghostIconActiveIntensity` | ghost-control-style | Ghost icon active chroma |
| `ghostBorderIntensity` | ghost-control-style | Ghost border chroma |
| `ghostBorderTone` | ghost-control-style | Ghost border tone |
| `outlinedTextRestToneLight` | outlined-control-style | Outlined text rest (light mode) |
| `outlinedTextHoverToneLight` | outlined-control-style | Outlined text hover (light mode) |
| `outlinedTextActiveToneLight` | outlined-control-style | Outlined text active (light mode) |
| `ghostTextRestToneLight` | ghost-control-style | Ghost text rest (light mode) |
| `ghostTextHoverToneLight` | ghost-control-style | Ghost text hover (light mode) |
| `ghostTextActiveToneLight` | ghost-control-style | Ghost text active (light mode) |
| `ghostTextRestIntensityLight` | ghost-control-style | Ghost text rest chroma (light) |
| `ghostTextHoverIntensityLight` | ghost-control-style | Ghost text hover chroma (light) |
| `ghostTextActiveIntensityLight` | ghost-control-style | Ghost text active chroma (light) |
| `ghostIconActiveIntensityLight` | ghost-control-style | Ghost icon active chroma (light) |

*33 fields. This is the largest parameter because it spans three emphasis levels
(filled, outlined, ghost), each with rest/hover/active states. The knob doesn't
change which emphasis a button uses — it changes how much visual weight each
emphasis level carries.*

##### P4: Border Definition

*How visible are structural boundaries?*

- 0 → nearly invisible borders, clean minimal look
- 100 → strong borders, structured, architecturally defined

**Formula fields controlled** (border-visibility + card-frame-style):

| Field | Group | What it controls |
|-------|-------|-----------------|
| `borderBaseIntensity` | border-visibility | Default border chroma |
| `borderStrongIntensity` | border-visibility | Strong border chroma |
| `borderMutedIntensity` | border-visibility | Muted border chroma |
| `borderMutedTone` | border-visibility | Muted border lightness |
| `borderStrongTone` | border-visibility | Strong border lightness |
| `dividerDefaultIntensity` | border-visibility | Default divider chroma |
| `dividerMutedIntensity` | border-visibility | Muted divider chroma |
| `cardFrameActiveIntensity` | card-frame-style | Active card frame chroma |
| `cardFrameActiveTone` | card-frame-style | Active card frame lightness |
| `cardFrameInactiveIntensity` | card-frame-style | Inactive card frame chroma |
| `cardFrameInactiveTone` | card-frame-style | Inactive card frame lightness |
| `borderStrongToneComputed` | computed-tone-override | Strong border computed tone |
| `dividerDefaultToneOverride` | computed-tone-override | Default divider computed tone |
| `dividerMutedToneOverride` | computed-tone-override | Muted divider computed tone |
| `disabledBorderIntensity` | field-style | Disabled border chroma |
| `disabledBorderToneOverride` | computed-tone-override | Disabled border computed tone |

*16 fields. Controls how much structural definition borders, dividers, and card
frames provide. Low values produce a clean, borderless aesthetic; high values
produce a structured, grid-like feel.*

##### P5: Shadow Depth

*How pronounced is elevation?*

- 0 → flat, paper-like, no depth cues from shadows
- 100 → deep shadows, strong z-axis, clear elevation hierarchy

**Formula fields controlled** (shadow-depth):

| Field | Group | What it controls |
|-------|-------|-----------------|
| `shadowXsAlpha` | shadow-depth | Extra-small shadow opacity |
| `shadowMdAlpha` | shadow-depth | Medium shadow opacity |
| `shadowLgAlpha` | shadow-depth | Large shadow opacity |
| `shadowXlAlpha` | shadow-depth | Extra-large shadow opacity |
| `shadowOverlayAlpha` | shadow-depth | Overlay shadow opacity |
| `overlayDimAlpha` | shadow-depth | Dim overlay opacity |
| `overlayScrimAlpha` | shadow-depth | Scrim overlay opacity |
| `overlayHighlightAlpha` | shadow-depth | Highlight overlay opacity |

*8 fields. The cleanest mapping — pure alpha modulation across shadow sizes and
overlay types. The interpolation curve should be non-linear: most of the
perceptual change happens in the 0-50 range.*

##### P6: Signal Strength

*How vivid are semantic colors?*

- 0 → muted, pastel signals, calm and understated
- 100 → saturated, vivid, signals that demand attention

**Formula fields controlled** (text-coloring + badge-style + icon-style + tab-style +
toggle-style + sentinel-alpha + selection-mode):

| Field | Group | What it controls |
|-------|-------|-----------------|
| `onCautionTextIntensity` | text-coloring | Caution on-signal text chroma |
| `onSuccessTextIntensity` | text-coloring | Success on-signal text chroma |
| `badgeTintedTextIntensity` | badge-style | Badge text chroma |
| `badgeTintedTextTone` | badge-style | Badge text lightness |
| `badgeTintedSurfaceIntensity` | badge-style | Badge surface chroma |
| `badgeTintedSurfaceTone` | badge-style | Badge surface lightness |
| `badgeTintedSurfaceAlpha` | badge-style | Badge surface opacity |
| `badgeTintedBorderIntensity` | badge-style | Badge border chroma |
| `badgeTintedBorderTone` | badge-style | Badge border lightness |
| `badgeTintedBorderAlpha` | badge-style | Badge border opacity |
| `iconActiveTone` | icon-style | Active icon lightness |
| `iconMutedIntensity` | icon-style | Muted icon chroma |
| `iconMutedTone` | icon-style | Muted icon lightness |
| `tabTextActiveTone` | tab-style | Active tab text lightness |
| `toggleTrackOnHoverTone` | toggle-style | Toggle track on-hover lightness |
| `toggleThumbDisabledTone` | toggle-style | Toggle thumb disabled lightness |
| `toggleTrackDisabledIntensity` | toggle-style | Toggle track disabled chroma |
| `ghostActionSurfaceHoverAlpha` | sentinel-alpha | Ghost action hover opacity |
| `ghostActionSurfaceActiveAlpha` | sentinel-alpha | Ghost action active opacity |
| `ghostOptionSurfaceHoverAlpha` | sentinel-alpha | Ghost option hover opacity |
| `ghostOptionSurfaceActiveAlpha` | sentinel-alpha | Ghost option active opacity |
| `ghostDangerSurfaceHoverAlpha` | sentinel-alpha | Ghost danger hover opacity |
| `ghostDangerSurfaceActiveAlpha` | sentinel-alpha | Ghost danger active opacity |
| `tabSurfaceHoverAlpha` | sentinel-alpha | Tab hover surface opacity |
| `tabCloseSurfaceHoverAlpha` | sentinel-alpha | Tab close hover opacity |
| `highlightHoverAlpha` | sentinel-alpha | Highlight hover opacity |
| `selectionSurfaceInactiveIntensity` | selection-mode | Inactive selection chroma |
| `selectionSurfaceInactiveTone` | selection-mode | Inactive selection lightness |
| `selectionSurfaceInactiveAlpha` | selection-mode | Inactive selection opacity |

*29 fields. Controls how vivid all semantic signal tokens are — badges, icons,
toggles, tabs, ghost button hover states, selection highlights. This replaces and
expands the existing `signalIntensity` mood knob.*

##### P7: Atmosphere

*How much chromatic character do neutral surfaces and text carry?*

- 0 → achromatic, clinical, surfaces and text are pure gray
- 100 → strongly tinted, surfaces take on the palette's hue, text picks up color

**Formula fields controlled** (surface-coloring + text-coloring + field-style):

| Field | Group | What it controls |
|-------|-------|-----------------|
| `atmosphereIntensity` | surface-coloring | Global atmosphere chroma |
| `surfaceAppIntensity` | surface-coloring | App surface chroma |
| `surfaceCanvasIntensity` | surface-coloring | Canvas surface chroma |
| `atmosphereBorderIntensity` | text-coloring | Atmosphere border chroma |
| `fieldSurfaceRestTone` | field-style | Field rest surface lightness |
| `fieldSurfaceHoverTone` | field-style | Field hover surface lightness |
| `fieldSurfaceFocusTone` | field-style | Field focus surface lightness |
| `fieldSurfaceDisabledTone` | field-style | Field disabled surface lightness |
| `fieldSurfaceReadOnlyTone` | field-style | Field read-only surface lightness |
| `fieldSurfaceRestIntensity` | field-style | Field rest surface chroma |
| `disabledSurfaceIntensity` | field-style | Disabled surface chroma |
| `disabledSurfaceToneBase` | computed-tone-override | Disabled surface tone base |
| `disabledSurfaceToneScale` | computed-tone-override | Disabled surface tone scale |

*13 fields. Controls how much chromatic influence the palette has on neutral
surfaces. At 0, surfaces are pure gray regardless of the chosen hues. At 100,
surfaces and fields take on visible tint from the surface hue slots. This
replaces the existing `warmth` mood knob with a more honest description of what
it controls — chroma on neutral surfaces, not hue rotation.*

##### Coverage summary

| Parameter | Fields | Semantic groups covered |
|-----------|--------|------------------------|
| P1: Surface Depth | 19 | canvas-darkness, surface-layering, surface-coloring, computed-tone-override |
| P2: Text Hierarchy | 11 | text-brightness, text-hierarchy, text-coloring, computed-tone-override |
| P3: Control Weight | 33 | filled-control-prominence, outlined-control-style, ghost-control-style |
| P4: Border Definition | 16 | border-visibility, card-frame-style, field-style, computed-tone-override |
| P5: Shadow Depth | 8 | shadow-depth |
| P6: Signal Strength | 29 | text-coloring, badge-style, icon-style, tab-style, toggle-style, sentinel-alpha, selection-mode |
| P7: Atmosphere | 13 | surface-coloring, text-coloring, field-style, computed-tone-override |
| **Total slider-controlled** | **129** | |
| **Structural (hue routing)** | **~71** | hue-slot-dispatch, sentinel-hue-dispatch, hue-name-dispatch, selection-mode flag, computed-tone-override (remaining) |
| **Grand total** | **200** | |

The ~71 structural fields (hue-slot-dispatch, sentinel-hue-dispatch,
hue-name-dispatch, `selectionInactiveSemanticMode`, and remaining
computed-tone-override fields) are routing decisions that determine *which hue*
a token uses, not *how bright or saturated* it appears. These are part of the
recipe template and are not slider-controlled. An expert author can still edit
them directly in the formula object.

#### Slider-to-formula compilation

Each design parameter at value `V` (0-100) produces formula field values by linear
interpolation between two curated endpoint bundles:

```
fieldValue = lowEndpoint[field] + (V / 100) * (highEndpoint[field] - lowEndpoint[field])
```

Where:
- `lowEndpoint` is the curated field values for parameter = 0 (e.g., "maximally
  flat surfaces" for Surface Depth)
- `highEndpoint` is the curated field values for parameter = 100 (e.g., "maximally
  stepped surfaces" for Surface Depth)
- `V = 50` reproduces the current `DARK_FORMULAS` / `LIGHT_FORMULAS` values exactly

Each mode (dark, light) has its own pair of endpoint bundles per parameter. The
endpoints are themselves authored design artifacts — they represent the extreme
positions of each design dimension for that mode.

The compilation function:

```
RecipeParameters { 7 design sliders }
    → compileRecipe(mode, parameters)
    → DerivationFormulas (200 fields)
```

The `compileRecipe()` function:
1. Starts with the structural fields (hue routing) from the mode's template
2. For each of the 7 parameters, interpolates the controlled fields between
   endpoints
3. Returns a complete `DerivationFormulas` object

If a formula field is controlled by more than one parameter (some
`computed-tone-override` and `surface-coloring` fields appear in multiple
parameter tables), the last parameter in P1-P7 order wins. In practice, shared
fields should be assigned to whichever parameter has the strongest conceptual
claim, and removed from the other. The field-to-parameter mapping tables above
are the authoritative assignment.

#### Recipe authoring UI

The Theme Generator evolves from a preview tool to a recipe authoring tool. It
gains two distinct workspaces:

**Recipe workspace** (new):
- Seven labeled sliders (P1-P7), each with low/high endpoint descriptions
- A "formula expansion" panel below each slider showing which fields it controls
  and their current computed values
- Preview uses a reference palette (the current theme's hues or a neutral set)
  so the author sees strategy changes, not color changes
- A "recipe diff" panel that compares the current parameter state against a
  baseline (the saved recipe, or another recipe selected for comparison)
- Export: saves as a named recipe with parameter values and the compiled formulas

**Theme workspace** (existing, refined):
- Pick a recipe (dark, light, or a custom authored recipe)
- Choose 15 hue inputs via the existing color pickers
- See the concrete theme rendered with the recipe's strategy
- The 7 design parameters carry through from the recipe — the author can tweak
  them per-theme for slight variations without creating a whole new recipe
- The existing contrast dashboard, CVD preview, and token grid remain

**Recipe diff view** (new):
- Side-by-side comparison of two recipes
- Top level: 7 design parameters shown as paired value bars
- Expandable: per-semantic-group field-level differences
- Purpose: makes it possible to see "dark/stark differs from dark mainly in
  Surface Depth (higher) and Text Hierarchy (wider spread)" instead of comparing
  200 raw numbers

#### What must change

1. **Define `RecipeParameters` interface.** Seven numeric fields (0-100), one per
   design parameter. Stored alongside or within `ThemeRecipe`.

2. **Define endpoint bundles.** For each mode (dark, light) × each parameter (7),
   create low (0) and high (100) field value sets. These are design artifacts
   that must be calibrated by rendering and evaluating themes at the extremes.
   The midpoint (50) must reproduce the current `DARK_FORMULAS` /
   `LIGHT_FORMULAS` values exactly — this is the backward-compatibility
   constraint.

3. **Implement `compileRecipe()`.** Function that takes mode + 7 parameter values
   and returns a complete `DerivationFormulas` object. Lives in
   `theme-derivation-engine.ts` alongside the existing derivation pipeline.

4. **Update `ThemeRecipe` interface.** Replace the three mood knobs
   (`surfaceContrast`, `signalIntensity`, `warmth`) with `parameters?:
   RecipeParameters`. The `formulas` field remains as an optional override —
   if provided, it takes precedence over compiled parameters (expert escape
   hatch). If neither `parameters` nor `formulas` is provided, mode defaults
   apply (parameters all at 50).

5. **Update `deriveTheme()` entry point.** If `recipe.parameters` is provided
   and `recipe.formulas` is not, call `compileRecipe()` to produce formulas
   before entering the existing derivation pipeline. The pipeline itself does
   not change.

6. **Build recipe workspace UI.** Seven `ParameterSlider` components in the
   Theme Generator, each with label, low/high descriptions, and numeric value.
   Wire slider changes through `compileRecipe()` → `deriveTheme()` → preview
   update.

7. **Build formula expansion panel.** Collapsible panel per parameter showing
   the field names and their current interpolated values. Read-only in the
   default view; an "advanced" toggle enables per-field overrides that feed
   into the `formulas` escape hatch.

8. **Build recipe diff view.** Component that accepts two `RecipeParameters`
   objects and renders the comparison. Parameter-level summary (7 bars) +
   expandable field-level detail per semantic group.

9. **Calibrate endpoint bundles.** The most labor-intensive step. For each
   parameter × each mode, determine what "0" and "100" look like by rendering
   test themes and evaluating the visual result. The endpoints must:
   - Produce visually meaningful extremes (not just min/max numeric values)
   - Maintain contrast compliance at all positions (the contrast engine
     validates after compilation)
   - Interpolate smoothly — no visual discontinuities at intermediate values

10. **Update `EXAMPLE_RECIPES`.** Replace `formulas: DARK_FORMULAS` with
    `parameters: { surfaceDepth: 50, textHierarchy: 50, ... }` so the example
    recipes demonstrate the parameter system. Keep the compiled formulas
    available as a test fixture for backward-compatibility verification.

11. **Migrate existing mood knob references.** Update any code that reads
    `recipe.surfaceContrast`, `recipe.signalIntensity`, or `recipe.warmth` to
    read from the new parameter system. The existing `computeTones()` function
    and `resolveHueSlots()` warmth bias logic may need to be folded into
    `compileRecipe()` or preserved as a separate derivation-time step.

12. **Verify:** `bun run check`, `bun test`, `bun run audit:tokens lint`. No
    behavioral changes to existing themes when parameters are all at 50.

#### Endpoint calibration strategy

The endpoints are the design heart of this system. They must be authored, not
computed. Guidelines:

- **Start from the current formulas.** `DARK_FORMULAS` and `LIGHT_FORMULAS`
  define the midpoint (parameter = 50). For each parameter, pull out the
  controlled fields and determine what reasonable extremes look like.

- **Low endpoint (0):** The minimum useful value for this dimension. For
  Surface Depth, this means all surfaces at nearly the same tone — but not
  literally identical (that would break the UI). For Text Hierarchy, this
  means muted text is only slightly dimmer than default — but still
  distinguishable.

- **High endpoint (100):** The maximum useful value. For Shadow Depth, this
  means dramatic shadows — but not comically dark. For Signal Strength, this
  means vivid semantic colors — but not neon.

- **Contrast compliance:** Every point on every slider must produce a theme
  that passes the contrast engine. If an extreme violates contrast, pull the
  endpoint back until it passes. The contrast engine is the hard constraint;
  the endpoint is the negotiable value.

- **Cross-parameter independence:** Moving one slider should not require
  compensating adjustments to another. If Surface Depth and Text Hierarchy
  interact (deeper surfaces require brighter text to maintain contrast), the
  endpoints should be calibrated to account for this at the extremes, with
  the contrast engine as the safety net at intermediate values.

#### Future: stark recipes and beyond

Once the parameter system is in place, creating new recipe variants becomes
straightforward:

- **Dark/stark:** Same hue routing template as dark, but with different
  parameter defaults — higher Surface Depth, wider Text Hierarchy, stronger
  Border Definition. The parameter values *are* the recipe definition.

- **Light/stark:** Same pattern for light mode.

- **Custom recipes:** Any combination of the 7 parameters, saved with a name
  and description. The Theme Generator becomes a recipe authoring tool that
  anyone can use to create new recipes without touching formula fields.

The parameter system also enables recipe interpolation: smoothly blending
between two recipes by interpolating their parameter values. This could power
transitions (dark → light crossfade) or exploration (what's halfway between
the current recipe and stark?).

#### Invariants

- **Maintain audit-tokens invariants:** Any changes to token structure, CSS
  files, or the pairing map must pass `bun run audit:tokens lint` and
  `bun run audit:tokens verify`. These are non-negotiable gates per D81.
- **Backward compatibility:** `compileRecipe(mode, {all: 50})` must produce
  field values identical to the current `DARK_FORMULAS` / `LIGHT_FORMULAS`.
  Existing themes must render identically.

#### Execution strategy

Phase 4 is implemented in two plans that follow the dependency chain:

**Plan 1: Recipe parameter engine** — pure TypeScript, no UI changes.

Delivers the compilation pipeline and migrates the existing system to use it.
When this plan merges, the system works exactly as before (all parameters
default to 50), but the new pipeline exists and is exercised by tests.

Scope:
1. Define `RecipeParameters` interface (7 numeric fields, 0-100)
2. Define initial endpoint bundles for dark and light modes — mechanically
   derived from current formula values ± reasonable offsets, calibrated enough
   to compile and test (visual refinement happens in Plan 2)
3. Implement `compileRecipe(mode, parameters)` → `DerivationFormulas`
4. Update `ThemeRecipe` — replace `surfaceContrast`, `signalIntensity`,
   `warmth` with `parameters?: RecipeParameters`
5. Update `deriveTheme()` to call `compileRecipe()` when parameters are present
6. Migrate mood knob references in `computeTones()` / `resolveHueSlots()` into
   the compilation pipeline
7. Update `EXAMPLE_RECIPES` to use the parameter form
8. Tests: `compileRecipe("dark", {all: 50})` === `DARK_FORMULAS` field values;
   same for light mode; existing theme snapshots unchanged

Exit criteria: `bun run check`, `bun test`, `bun run audit:tokens lint` all
pass. Existing themes render identically. The compilation function is the only
new code path.

**Plan 2: Recipe authoring UI** — React components, depends on Plan 1.

Delivers the authoring experience and enables iterative endpoint calibration.

Scope:
1. Build 7 `ParameterSlider` components replacing the 3 mood sliders in the
   Theme Generator
2. Wire sliders through `compileRecipe()` → `deriveTheme()` → live preview
3. Build formula expansion panel — collapsible per-parameter field list showing
   current interpolated values, with optional per-field override
4. Build recipe diff view — parameter-level bars + expandable field-level
   detail for comparing two recipes
5. Refine endpoint bundles — use the new UI to visually evaluate parameter
   extremes and tune the initial endpoints from Plan 1
6. Verify contrast compliance across the full 0-100 range for each parameter

Exit criteria: the Theme Generator functions as a recipe authoring tool.
Authors can create, compare, and export recipes using the 7 design parameters.
All existing verification gates pass.

Endpoint calibration is not split into a separate plan — it is design work done
using Plan 2's tools, not a distinct engineering deliverable.

---

## Relationship to existing roadmaps

This document supersedes the relevant parts of:

- **semantic-formula-architecture.md** Parts 1-4 (completed and merged). Part 5
  (Harmony light theme) is superseded by Phase 3 of this document — the override
  approach was rebuilt as independent recipes.

- **contrast-engine-overhaul.md** Parts 1-2 (completed). Part 3 (formula
  de-duplication) is incorporated into Phase 4. Part 4 (contrast-aware derivation)
  was completed in Phase 2 of this document.

- **tugplan-token-audit-pairing** (Phase 1, PR #138, merged). Audited all 23
  component CSS files, regularized 7 token names, closed all pairing gaps, added
  `@tug-pairings` blocks and `verify-pairings.ts`.

- **tugplan-token-audit-enforce** (Phase 1.5, PR #139, merged). Built
  `audit-tokens.ts` with 6 subcommands, added 145 `@tug-renders-on` annotations,
  flattened alias chains, replaced heuristic resolution with deterministic parsing,
  added Rules 16/17 and D81 to the Rules of Tugways.

- **tugplan-contrast-engine-fix** (Phase 2, PR #140, merged). Two-pass composited
  enforcement, parameterized recipe test loop, shared exception module with
  categorized `[design-choice]` and `[phase-3-bug]` tags.

- **tugplan-independent-recipes** (Phase 3, PR #141, merged). Built standalone
  `LIGHT_FORMULAS` (202 fields), resolved all `[phase-3-bug]` entries, removed
  `BASE_FORMULAS`/`DARK_OVERRIDES`/`LIGHT_OVERRIDES`, updated all test imports,
  switched light-mode tests to use `LIGHT_FORMULAS`.

- **tugplan-design-vocabulary** (Phase 3.5B, PR #144, merged). Established semantic
  text types (content, control, display, informational), replaced contrast roles
  (body-text/ui-component/subdued-text → content/control/display/informational),
  restructured ThemeRecipe to nested surface/element/role groups, added card title
  token with display role.

- **tugplan-formula-field-rename** (Phase 3.5C, PR #145, merged). Renamed ~95
  DerivationFormulas fields and 8 ComputedTones fields from cryptic abbreviations
  to four-slot spelled-out names (e.g., `txtI` → `contentTextIntensity`,
  `bgAppTone` → `surfaceAppTone`). Pure rename, no behavioral changes.

The work done in Parts 1-4 of the semantic-formula-architecture roadmap (named
builders, @semantic annotations, interface restructuring, design rationale comments)
remains valuable — it provides the vocabulary and organization that the independent
recipes use. The problem was not the annotation work but the assumption that light
could be built as an override of dark.
