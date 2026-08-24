# Token Edit Tool

*A structured query-and-edit tool for flat theme tokens. The generalization lives in the tool, not in the tokens.*

**Status: Deferred until after Phase 2 component audit.** The tool is ~200 lines and can be built in under an hour. Better to finish auditing all 12 components first — the remaining 10 will surface real editing pain points and cross-component inconsistencies that should inform the tool's design. Building from 2 components' experience risks solving the wrong problems.

---

## Problem

Theme files contain hundreds of flat `--tug-color()` declarations. Changing a design concept that spans many tokens (e.g., "make all control off-state borders use slate instead of indigo-violet") requires manually finding and editing dozens of lines. The tokens should stay flat and dumb — no indirection, no aliases, no cascading. But editing them should be smart.

## Approach

A single script, `tugdeck/scripts/token-edit.ts`, registered as `bun run token-edit`. It combines two existing pieces:

1. **Seven-slot name parsing** — split `--tug7-surface-toggle-track-normal-accent-rest` into `{ plane: "surface", component: "toggle", constituent: "track", emphasis: "normal", role: "accent", state: "rest" }`. New code, but trivial — split on `-` after the prefix.

2. **`--tug-color()` value parsing** — the existing `tug-color-parser.ts` already returns `{ color, intensity, tone, alpha }` with full error spans. Reuse directly.

The tool reads a theme CSS file, parses every declaration into structured name + value, applies a filter, then either lists matches or applies edits in place.

---

## Interface

```
bun run token-edit <command> --theme <name> [--where <filter>] [options]
```

### Commands

**`list`** — Show matching tokens. No edits. The audit mode.

```bash
# All toggle tokens in brio
bun run token-edit list --theme brio --where "component=toggle"

# All off-state tokens across both themes
bun run token-edit list --theme brio --where "state=off"
bun run token-edit list --theme harmony --where "state=off"

# All text tokens with tone below 50
bun run token-edit list --theme harmony --where "constituent=text" --value "t<50"
```

Output: one line per match, showing the full declaration.

```
surface-toggle-track-normal-off-rest: --tug-color(indigo-violet, i: 6, t: 60)
surface-toggle-track-normal-off-hover: --tug-color(indigo-violet, i: 10, t: 60)
surface-toggle-primary-normal-off-rest: --tug-color(indigo-violet, i: 8, t: 50)
surface-toggle-primary-normal-off-hover: --tug-color(indigo-violet, i: 12, t: 45)
```

**`set`** — Set a `--tug-color()` parameter to an absolute value on all matches.

```bash
# Change all control off-state borders to slate
bun run token-edit set --theme brio --where "component=toggle,role=off" --param hue --to slate

# Set all danger-role tokens to red hue
bun run token-edit set --theme harmony --where "role=danger" --param hue --to red
```

**`adjust`** — Shift a numeric parameter by a relative amount on all matches.

```bash
# Bump tone of all text tokens by 5
bun run token-edit adjust --theme harmony --where "constituent=text" --param t --by +5

# Reduce intensity of all disabled tokens by 10
bun run token-edit adjust --theme brio --where "state=disabled" --param i --by -10
```

**`diff`** — Compare the same token across two themes.

```bash
# Show side-by-side for all toggle tokens
bun run token-edit diff --themes brio,harmony --where "component=toggle"
```

Output:
```
surface-toggle-track-normal-accent-rest
  brio:    --tug-color(orange, i: 55, t: 42)
  harmony: --tug-color(orange, i: 80, t: 45)
```

---

## Filter Syntax (`--where`)

Comma-separated `slot=value` pairs. All conditions must match (AND logic).

| Slot | Matches | Examples |
|------|---------|---------|
| `plane` | Slot 1 | `plane=surface`, `plane=element` |
| `component` | Slot 2 | `component=toggle`, `component=global` |
| `constituent` | Slot 3 | `constituent=text`, `constituent=track` |
| `emphasis` | Slot 4 | `emphasis=normal`, `emphasis=filled` |
| `role` | Slot 5 | `role=accent`, `role=off` |
| `state` | Slot 6 | `state=rest`, `state=disabled` |

Omitted slots match everything. Wildcards not needed — just omit the slot.

### Value filter (`--value`)

Optional filter on the `--tug-color()` parameters:

- `hue=orange` — exact hue match
- `i>50` — intensity greater than 50
- `t<30` — tone less than 30
- `a<100` — has alpha (not fully opaque)

---

## `--theme` Resolution

- `--theme brio` → `tugdeck/styles/themes/brio.css`
- `--theme harmony` → `tugdeck/styles/themes/harmony.css`
- Any other name → `tugdeck/styles/themes/<name>.css`

---

## Implementation

### What exists and can be reused

| Piece | Location | Reuse |
|-------|----------|-------|
| `--tug-color()` parser | `tugdeck/tug-color-parser.ts` | Direct import. `parseTugColor()` returns `{ color, intensity, tone, alpha }` with full error recovery. |
| Token extraction regex | `tugdeck/scripts/audit-tokens.ts` | Pattern: `/^\s*(--(?:tug7\|tugc\|tugx\|tug)-[\w-]+)\s*:\s*(.+?)\s*;/gm` |
| Hue families + constants | `tugdeck/src/components/tugways/palette-engine.ts` | `HUE_FAMILIES`, `ADJACENCY_RING`, `ACHROMATIC_SEQUENCE`, `NAMED_GRAYS` for validation |
| Token prefix classifier | `tugdeck/scripts/token-classify.ts` | `classifyTokenShortName()` — tells us if a token is tug7/tugc/tugx/tug |

### What needs to be built

| Piece | Complexity | Description |
|-------|-----------|-------------|
| Seven-slot parser | Small | Split a `tug7` token name after the prefix into 6 slots. ~20 lines. |
| Filter matcher | Small | Parse `--where` string into slot=value pairs, match against parsed name. ~30 lines. |
| Value filter | Small | Parse `--value` string, compare against parsed `--tug-color()` result. ~20 lines. |
| CSS rewriter | Medium | Read file, find matching declarations, rewrite the `--tug-color()` value in place, write back. Preserve all formatting, comments, non-matching lines. ~60 lines. |
| CLI harness | Small | Parse argv, route to list/set/adjust/diff. ~40 lines. |
| Diff formatter | Small | Read two files, match tokens by name, format side-by-side. ~30 lines. |

**Total estimate:** ~200 lines of new code, plus imports from existing modules.

### File structure

One file: `tugdeck/scripts/token-edit.ts`. No new dependencies.

### package.json script

```json
"token-edit": "bun run scripts/token-edit.ts"
```

---

## What this does NOT do

- **No runtime indirection.** The theme files stay flat. The tool edits them, then you're done.
- **No token generation.** `generate-tug-tokens.ts` remains the source-of-truth generator for brio. This tool edits the *output* of that generator (or hand-authored theme files like harmony).
- **No CSS variable references.** Only operates on `--tug-color()` values. Tokens with `var()` references, literal hex values, or `transparent` are listed but not editable.
- **No validation of contrast.** Use `bun run audit:tokens` for that. This tool is for finding and changing values.

---

## Examples: Real tasks this tool handles

**"Change the base control hue from indigo-violet to slate"**
```bash
bun run token-edit list --theme brio --where "component=toggle,role=off"
# Review matches
bun run token-edit set --theme brio --where "component=toggle,role=off" --param hue --to slate
bun run token-edit set --theme harmony --where "component=toggle,role=off" --param hue --to slate
```

**"Make all disabled tokens dimmer"**
```bash
bun run token-edit adjust --theme brio --where "state=disabled" --param i --by -5
bun run token-edit adjust --theme harmony --where "state=disabled" --param i --by -5
```

**"Audit: which tokens use the orange hue?"**
```bash
bun run token-edit list --theme brio --value "hue=orange"
```

**"Compare accent tokens between themes"**
```bash
bun run token-edit diff --themes brio,harmony --where "role=accent"
```
