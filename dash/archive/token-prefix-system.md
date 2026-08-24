# Token Prefix System

*Eliminate namespace ambiguity by giving every CSS custom property a prefix that declares its kind.*

---

## Problem

Today, all design-system CSS custom properties start with `--tug-`. A coding agent seeing `--tug-control-disabled-opacity` cannot tell whether it's a seven-slot semantic token, a palette color, a scale value, or a component alias — without tracing the code. This ambiguity will compound as the component library grows.

---

## The Four Prefixes

| Prefix | Kind | Parse Rule | Examples |
|--------|------|-----------|---------|
| `--tug7-` | Seven-slot semantic token | Always 7 segments after prefix. Machine-parseable. | `--tug7-element-global-text-normal-plain-rest` |
| `--tugc-` | Color palette | Hue constants, named grays, global anchors. | `--tugc-red-h`, `--tugc-gray-ink`, `--tugc-l-dark` |
| `--tugx-` | Extension | Component aliases, shared utilities. Locally defined. | `--tugx-card-border`, `--tugx-control-disabled-opacity` |
| `--tug-` | Scale / dimension | Spacing, radius, motion, font, icon sizes. Simple global values. | `--tug-space-md`, `--tug-radius-lg`, `--tug-motion-duration-fast` |

### Recognition Rule

An agent seeing a CSS custom property classifies it instantly by prefix:

- **`--tug7-`** → Seven-slot token. Split on `-`, read the 7 slots. Look up in token-naming.md.
- **`--tugc-`** → Palette color. Defined in tug-palette.css. Never component-scoped.
- **`--tugx-`** → Extension. Trace to its definition — component CSS `body {}` block or shared utility file.
- **`--tug-`** → Scale. Global dimensional value. Never ambiguous with the above.

No counting hyphens. No tracing. No guessing.

---

## Classification of Existing Tokens

### `--tug-` → `--tug7-` (Seven-slot tokens)

All tokens currently following the seven-slot convention. These are the bulk of the rename — approximately 130+ tokens in the generated CSS.

```
--tug-element-global-text-normal-plain-rest   →  --tug7-element-global-text-normal-plain-rest
--tug-surface-control-primary-filled-accent-hover  →  --tug7-surface-control-primary-filled-accent-hover
--tug-effect-card-desat-normal-dim-inactive   →  --tug7-effect-card-desat-normal-dim-inactive
```

### `--tug-` → `--tugc-` (Palette tokens)

Per-hue constants (3 per hue × 48 hues = 144), named grays, global anchors.

```
--tug-red-h             →  --tugc-red-h
--tug-red-canonical-l   →  --tugc-red-canonical-l
--tug-red-peak-c        →  --tugc-red-peak-c
--tug-gray-ink          →  --tugc-gray-ink
--tug-l-dark            →  --tugc-l-dark
--tug-black             →  --tugc-black
--tug-white             →  --tugc-white
```

### `--tug-` → `--tugx-` (Extensions)

Component-tier aliases and shared utilities.

```
--tug-card-border       →  --tugx-card-border
--tug-card-bg           →  --tugx-card-bg
--tug-card-shadow-active  →  --tugx-card-shadow-active
--tug-control-disabled-opacity  →  --tugx-control-disabled-opacity
--tug-toggle-on-color   →  --tugx-toggle-on-color
```

### `--tug-` stays `--tug-` (Scale tokens)

These keep the plain prefix. They're already unambiguous — short, global, dimensional.

```
--tug-space-md          (no change)
--tug-radius-lg         (no change)
--tug-motion-duration-fast  (no change)
--tug-font-size-md      (no change)
--tug-icon-size-lg      (no change)
--tug-chrome-height     (no change)
```

---

## Implementation Strategy

### Tooling: Extend `audit-tokens rename`

The existing `audit-tokens rename` command handles bulk renames with a JSON map, auto-discovers files, supports dry-run and `--verify`. It currently hardcodes `--tug-` as both the input and output prefix.

**Modification needed:** Allow the rename map to specify full output property names (including prefix), rather than assuming `--tug-` on both sides. This is a small change to the replacement logic in the rename subcommand.

### Execution Plan

**Step 1: Build the rename maps**

Create three JSON map files, one per prefix migration:

- `rename-tug7.json` — seven-slot tokens: `"element-global-text-normal-plain-rest"` → `"tug7-element-global-text-normal-plain-rest"`
- `rename-tugc.json` — palette tokens: `"red-h"` → `"tugc-red-h"`
- `rename-tugx.json` — extensions: `"card-border"` → `"tugx-card-border"`

These should be generated programmatically by a new `generate-rename-maps.ts` script that scans all `.css` files under `tugdeck/styles/` for `--tug-*` declarations and classifies each token using a shared `token-classify.ts` module. The classifier implements the classification rules from the table above, importing `HUE_FAMILIES` and `NAMED_GRAYS` from `palette-engine.ts` for palette detection. Both `generate-rename-maps.ts` and `verify-pairings.ts` import from `token-classify.ts` — no duplicated classification logic.

**Step 2: Extend the rename script**

Modify `audit-tokens rename` to support a `--full-names` flag (or detect from the map format) that treats the output side as a complete property name rather than appending `--tug-`.

**Step 3: Dry-run all three maps**

```bash
bun run audit:tokens rename --map rename-tug7.json --stats
bun run audit:tokens rename --map rename-tugc.json --stats
bun run audit:tokens rename --map rename-tugx.json --stats
```

Review blast radius before applying.

**Step 4: Apply in order**

Run the renames in a specific order to avoid conflicts:

1. `--tugx-` first (smallest set, component aliases)
2. `--tugc-` second (palette tokens)
3. `--tug7-` last (seven-slot tokens — largest set, references the palette)

```bash
bun run audit:tokens rename --map rename-tugx.json --apply --verify
bun run audit:tokens rename --map rename-tugc.json --apply --verify
bun run audit:tokens rename --map rename-tug7.json --apply --verify
```

**Step 5: Update dynamic template-literal references**

The bulk rename catches literal token strings but misses dynamically constructed names. These files need manual updates:

| File | What to update |
|------|---------------|
| `cards/gallery-palette-content.tsx` | Template literals: `` `--tug-${hueName}-canonical-l` `` → `` `--tugc-${hueName}-canonical-l` `` (and `-h`, `-peak-c`) |
| `style-inspector-overlay.ts` | `PALETTE_VAR_REGEX` from `/^--tug-/` to `/^--tugc-/`; dynamic `getPropertyValue` calls; `startsWith("--tug-")` checks at lines ~486-492 |
| `verify-pairings.ts` | `resolveToken()` prefix logic — import from `token-classify.ts` instead of hardcoding `--tug-` |
| `vite.config.ts` | Regex matching `--tug-host-canvas-color` → `--tugx-host-canvas-color` |
| `theme-provider.tsx` | `getPropertyValue("--tug-host-canvas-color")` → `--tugx-host-canvas-color` (lines ~60, 63) |

After updates, verify: `grep -r '--tug-\${' tugdeck/src/` should return zero results.

**Step 6: Update generators and tooling**

| File | What to update |
|------|---------------|
| `generate-tug-palette.ts` | Emit `--tugc-{hue}-*` instead of `--tug-{hue}-*` |
| `extract-tug-token-names.ts` | Scan for all four prefixes |
| `audit-tokens.ts` | All `--tug-` regex patterns, `.replace("--tug-", "")` calls, `startsWith("--tug-")` checks — use a shared `stripTugPrefix()` helper |
| `seed-rename-map.ts` | Update short names to reflect new prefixes |

Note: `postcss-tug-color.ts` does NOT need changes — it expands `--tug-color()` to inline `oklch()` values and never emits `var()` references.

**Step 7: Update test assertions**

| File | What to update |
|------|---------------|
| `palette-engine.test.ts` | ~10 assertions checking `--tug-{hue}-h:` → `--tugc-` |
| `style-inspector-overlay.test.ts` | ~108 `PALETTE_VAR_REGEX` test assertions → `--tugc-` |
| `gallery-palette-content.test.tsx` | Assertion `toContain("var(--tug-garnet-")` → `--tugc-garnet-` |
| `theme-activate-endpoint.test.ts` | Verify bulk rename handled `--tug-host-canvas-color` → `--tugx-` |
| `theme-production-link-swap.test.tsx` | Verify bulk rename handled `--tug-host-canvas-color` → `--tugx-` |

Also verify: `theme-pairings.ts` (~835 literal token references) was correctly handled by the bulk rename.

**Step 8: Regenerate and verify**

```bash
cd tugdeck && bun run generate:palette
cd tugdeck && bun run extract:tug-token-names
cd tugdeck && bun run build
cd tugdeck && bun run audit:tokens lint
```

---

## Documentation Updates

All tuglaws documents need updating to reflect the new prefix system:

### tuglaws/token-naming.md

- Add a "Prefix System" section at the top, before the seven-slot convention
- Update all examples to use `--tug7-` prefix
- Update the slot table to show `tug7` as namespace
- Note that the namespace slot value changes from `tug` to `tug7` for seven-slot tokens

### tuglaws/color-palette.md

- Update CSS Variables section: `--tug-{hue}-h` → `--tugc-{hue}-h`
- Update Named Gray Variables: `--tug-gray-*` → `--tugc-gray-*`
- Update Global Anchors: `--tug-l-dark` → `--tugc-l-dark`
- Update `--tug-color()` notation if the notation name changes

### tuglaws/component-authoring.md

- Update all token examples to use `--tug7-` prefix
- Update component-tier alias examples to use `--tugx-` prefix
- Update the Reference: Token Naming table
- Add prefix classification to the Token Usage section

### tuglaws/theme-engine.md

- Update `--tug-host-canvas-color` reference (this is a special case — decide which prefix)
- Update file path references if generated CSS naming changes

### tuglaws/laws-of-tug.md

- Update L15, L16, L17, L18 examples to use new prefixes
- L17 specifically: "Component aliases (`--tugx-*`) resolve to `--tug7-*` in one hop"

### tuglaws/design-decisions.md

- Update D71, D80, D81 token references to use new prefixes

---

## Special Cases

### `--tug-host-canvas-color`

This token is a contract with the Swift bridge — it must be a literal hex value, read by native code. It's not a seven-slot token, not a palette color, not a scale. It's a bridge interface value. Classify as `--tugx-host-canvas-color`.

### `--tug-color()` notation

The PostCSS notation `--tug-color(red, i: 70, t: 30)` is a build-time macro, not a CSS custom property. It doesn't need a prefix change — it's an authoring syntax that expands to `oklch()`. Keep as `--tug-color()`.

### `--tug-timing` and `--tug-motion`

These are global multipliers on `:root`. They're scale-adjacent (they control timing/motion globally). Keep as `--tug-timing` and `--tug-motion` under the plain `--tug-` prefix.

---

## Summary

| Category | Prefix | Approx Count | Change |
|----------|--------|:------------:|--------|
| Seven-slot tokens | `--tug7-` | ~130 | Rename from `--tug-` |
| Palette colors | `--tugc-` | ~160 | Rename from `--tug-` |
| Extensions | `--tugx-` | ~15 | Rename from `--tug-` |
| Scales | `--tug-` | ~30 | No change |
| **Total** | | **~335** | **~305 renamed** |

After this change: every CSS custom property's kind is visible from its prefix. An agent never has to guess.
