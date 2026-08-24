# Theme Name Decoupling

## Problem Statement

The theme names "brio" and "harmony" are hardcoded in 250+ places across the
codebase. Adding a third shipped theme would require touching ~15 files. Theme
names should appear in exactly three places:

1. The theme JSON files themselves (`brio.json`, `harmony.json`)
2. One constant defining the base theme name
3. Generated output files (driven by the JSON data)

Everything else should be data-driven.

## Design Principle: One Base Theme, No Complications

There is one base theme. Its tokens are the CSS foundation. If no preference is
stored, the base theme is what loads. There is no distinction between "base
theme" and "default theme" — they are the same thing, always. One constant names
it. That constant is the single source of truth.

Do not paint anything until the correct data is in hand. No race conditions, no
timing hacks, no "optimistic first paint with the wrong theme then swap." The
startup path must have the theme data ready before rendering begins. The
existing file-watcher system handles keeping generated files in sync — nothing
is stale, nothing requires manual regeneration at questionable times. Build
explicitly, or watch files on disk.

## Current State: 254+ Occurrences

### Production code (~95 occurrences)

| File | Count | What's hardcoded |
|------|-------|------------------|
| `gallery-theme-generator-content.tsx` | 31 | Prototype lists, special brio/harmony code paths, static imports |
| `vite.config.ts` | 23 | Default fallbacks, brio-first sorting, empty-override assumption, comments |
| `main.tsx` | 8 | Static brio JSON import, `BRIO_RECIPE` constant, default fallback logic |
| `theme-provider.tsx` | 6 | `BUILT_IN_THEME_NAMES` set, `"brio"` default, conditional brio check |
| `generate-tug-tokens.ts` | 4 | `recipe.name === "brio"` branching for base vs overlay token generation |
| `theme-canvas-params.ts` | 2 | Generated file — canvas params keyed by name (data-driven, acceptable) |
| `AppDelegate.swift` (Swift menu) | 2 | Brio-first sort comparator |
| `deck-manager.ts` | 1 | `initialTheme ?? "brio"` fallback |
| `gallery-popup-button-content.tsx` | 1 | UI preset `{ id: "brio", label: "Brio" }` |
| `theme-css-generator.ts` | 1 | Comment |
| `settings-api.ts` | 1 | Comment example |
| `tug-theme-override.css` | 1 | `/* empty - brio default */` |

### Test code (~178 occurrences)

| File | Count |
|------|-------|
| `gallery-theme-generator-content.test.tsx` | 27 |
| `theme-middleware.test.ts` | 27 |
| `theme-export-import.test.tsx` | 26 |
| `theme-engine.test.ts` | 23 |
| `canvas-color.test.ts` | 19 |
| `theme-accessibility.test.ts` | 15 |
| `vite-config-activate.test.ts` | 10 |
| `action-dispatch.test.ts` | 8 |
| `contrast-dashboard.test.tsx` | 8 |
| Other test files | ~15 |

### Backend code (6 occurrences)

| File | Count | What's hardcoded |
|------|-------|------------------|
| `tugcast/integration_tests.rs` | 2 | Test data with `"theme":"brio"` |
| `tugcast/migration.rs` | 2 | Migration test data |
| `AppDelegate.swift` | 2 | Brio-first sorting (counted above in production) |

## Hardcoding Patterns and Fixes

### Pattern 1: Scattered default fallbacks (~20 places)

`?? "brio"` appears in `main.tsx`, `deck-manager.ts`, `theme-provider.tsx`,
`vite.config.ts`, and `gallery-theme-generator-content.tsx`. There is no single
constant. Every callsite independently knows the default theme is "brio".

**Fix:** One exported constant (`BASE_THEME_NAME = "brio"`) in a new file
`tugdeck/src/theme-constants.ts` with zero dependencies. This file must be
importable from every context: browser runtime, Vite/Node config
(`vite.config.ts` uses lazy `require()` for theme-engine imports and cannot
import it directly), and the build-time token generator
(`generate-tug-tokens.ts` runs under Bun). A standalone file with no imports
solves all three. Every fallback references this constant. Change this one
string to change the base theme everywhere.

### Pattern 2: Hardcoded shipped theme set (~10 places)

```typescript
BUILT_IN_THEME_NAMES = new Set(["brio", "harmony"])   // theme-provider.tsx
SHIPPED_NAMES = new Set(["brio", "harmony"])           // gallery component
```

These are redundant. The middleware's `handleThemesList` already scans the
`tugdeck/themes/` directory and tags each theme with `source: "shipped"`. The
client receives this in the `/__themes/list` response.

**Fix:** Remove the hardcoded sets. Use the middleware's `source` field to
distinguish shipped from authored themes. The theme list must be fetched before
rendering begins — no painting until the data is in hand.

### Pattern 3: Static JSON imports (~5 places)

```typescript
import brioJson from "../../themes/brio.json"
import harmonyJson from "../../../../themes/harmony.json"
```

Multiple files import specific theme JSON by name.

**Fix:** Remove all static theme JSON imports except one: the base theme recipe
is needed at startup to derive canvas params for the Swift bridge before React
mounts. The token generator already emits `THEME_CANVAS_PARAMS` with this data.
Expand the generator to also emit the base theme recipe as a TypeScript constant
(e.g., `BASE_THEME_RECIPE`). Then no runtime code imports theme JSON files
directly — everything comes from generated constants or the middleware.

### Pattern 4: Base-theme-first sorting (3 places)

```typescript
if (a.name.lowercased() == "brio") { return true }   // Swift
if (a.name.lowercased() == "brio") return -1          // TypeScript
```

**Fix:** Sort by "is this the base theme?" using the `BASE_THEME_NAME` constant.
Not the string "brio".

### Pattern 5: Base theme = empty override (~5 places)

`vite.config.ts` treats brio specially: activating brio writes an empty CSS
override file because brio's tokens ARE the base CSS. This is architecturally
correct — the base theme doesn't need an override. But the check should be
"is this the base theme?" not "is this brio?".

**Fix:** Compare against `BASE_THEME_NAME`.

### Pattern 6: Gallery component prototype system (31 occurrences)

`gallery-theme-generator-content.tsx` has dedicated code paths for brio and
harmony as "prototypes" — the starting points for creating new themes. It
statically imports both JSON files, builds prototype objects keyed by name, and
has conditional logic throughout.

The gallery already fetches theme JSON from the middleware
(`/__themes/<name>.json`) when opening a theme. The static imports and
`SHIPPED_NAMES` set are used for (a) the prototype picker and (b) "is this
shipped?" checks. Both can be replaced by the middleware's theme list response,
which already has `source: "shipped"`.

**Fix:** Remove all static imports of theme JSON. Fetch the shipped theme list
from the middleware. Use the `source` field for "is this shipped?" checks.
Present all shipped themes as prototypes — no theme-specific code paths.
Simplify aggressively.

## What Should Remain

After decoupling, theme names should appear only in:

- `tugdeck/themes/brio.json` — the theme data file
- `tugdeck/themes/harmony.json` — the theme data file
- `BASE_THEME_NAME = "brio"` — one constant, one place, changeable at will
- Generated files (`theme-canvas-params.ts`, base theme recipe, CSS files) —
  output driven by the JSON data via `bun run generate:tokens`
- Test fixtures that load from the JSON files (acceptable to reference by name
  in test setup, but tests should not hardcode theme-specific behavior)

Generated files stay in sync via the file-watcher system during development
and via explicit `bun run generate:tokens` during builds. Adding a new shipped
theme means: drop a JSON file in `tugdeck/themes/`, run the generator (or let
the watcher pick it up). No code changes required.

## Scope Assessment

### Must change (production code)

| Area | Files | Effort |
|------|-------|--------|
| `BASE_THEME_NAME` constant | New export in `theme-engine.ts` | Small |
| Default fallbacks | main.tsx, deck-manager.ts, theme-provider.tsx, vite.config.ts, gallery component | Small (mechanical find-and-replace once constant exists) |
| Shipped theme set | theme-provider.tsx, gallery component | Small (delete hardcoded sets, use middleware `source` field) |
| Static JSON imports | main.tsx, gallery component | Small (remove imports, use generated constants and middleware) |
| Base-theme-first sorting | vite.config.ts, AppDelegate.swift | Small |
| Empty override logic | vite.config.ts | Small |
| Token generator | generate-tug-tokens.ts | Small (replace `=== "brio"` with `=== BASE_THEME_NAME`, emit base recipe constant) |
| Gallery prototype system | gallery-theme-generator-content.tsx | Medium (remove static imports, fetch from middleware, delete theme-specific code paths) |

### Should change (test code)

Tests that use "brio" as concrete test data (e.g., loading a recipe fixture to
test derivation) are fine — they're testing with real data, not hardcoding
behavior. Tests that assert behavior tied to a theme name (e.g., "brio sorts
first") must use `BASE_THEME_NAME` instead. The behavior being tested is "the
base theme sorts first," not "the theme called brio sorts first." Any test
whose correctness depends on knowing the base theme is called "brio" is testing
the wrong thing.

### No change needed

- Theme JSON data files
- Generated output files (they are the correct place for theme names)
- Rust backend test fixtures (2 files, 4 occurrences — low priority)
