# 7-Role Color System with Emphasis×Role Matrix

## Status

Proposal — validated by visual proof-of-concept (POC cards in Tug.app, March 2026).

## Background

The current tug theme system defines 6 chromatic roles (ACCENT, PRIMARY, POSITIVE, WARNING, DANGER, INFO) that evolved organically. A study of 8 major design systems (Radix, shadcn, daisyUI, Material Design 3, Carbon, Primer, Apple HIG, Ant Design) plus hands-on prototyping with mock IDE cards revealed two fundamental gaps:

1. **No functional domain colors.** Today's IDEs (VS Code, Xcode) are mostly monochromatic gray-blue. Everything looks the same — a token counter, a filename, a button label. You have to *read* to understand. You can't *scan*. An AI coding IDE needs distinct visual zones so developers navigate by color before reading labels — the same principle behind the color-coded buttons on vintage NASA/IBM mainframe panels.

2. **Emphasis and role are conflated.** The current control variants (primary/secondary/ghost/destructive) mix "how loud" with "what kind." A primary button and a destructive button differ in both emphasis and purpose simultaneously, making the system rigid and inexpressive.

## The 7 Roles

### Signal roles — high saturation, used sparingly as interrupts

| Role | Default Hue | Meaning |
|---|---|---|
| **SUCCESS** | green (140°) | Positive outcome — build passed, step complete, file added |
| **CAUTION** | yellow (90°) | Attention needed — threshold, pending, lint warning |
| **DANGER** | red (25°) | Error/destructive — build failed, delete action, critical |

### Domain roles — moderate saturation, used as zone/category identifiers

| Role | Default Hue | Meaning |
|---|---|---|
| **ACCENT** | orange (55°) | Brand identity, primary CTA, the "go" color |
| **ACTIVE** | blue (230°) | Interactive controls, focus rings, selection, links |
| **AGENT** | violet (280°) | AI actively working — thinking spinners, live agent badges |
| **DATA** | teal (170°) | Measurements — token counts, cost, latency, sparklines |

### Hue spacing

The 7 hues are well-distributed around the wheel with no near-collisions:

```
red(25°) → orange(55°) → yellow(90°) → green(140°) → teal(170°) → blue(230°) → violet(280°)
```

Minimum gap is 30° (orange→yellow, green→teal). All easily distinguishable, including under common color vision deficiencies.

### AGENT usage rule

Violet means one narrow thing: **intelligence is actively working right now.** It is an indicator light, not a paint job. Attribution (model name), completed agent work, and AI-generated content use outlined or ghost emphasis, or other roles entirely. The chat card is ACCENT (user's home base), not AGENT.

## The Emphasis Axis

Emphasis is orthogonal to role. It controls how loud an element is — structural, not chromatic. The POC validated three levels on badges in the agent activity feed:

### Filled — high emphasis

Solid opaque color background. Text is white on dark-bg roles (accent, active, agent, danger) or dark on light-bg roles (data, success, caution).

**Use for:** Primary CTAs, active/live indicators, status badges that demand immediate attention.

**Example:** The one currently-active agent in a feed gets a solid violet `CODER` badge with white text. It pops.

### Outlined — medium emphasis

Colored border, transparent background, normal neutral readable text. The border says "categorized as X" while the content remains maximally readable.

**Use for:** Secondary actions, historical/completed items, category labels that inform without demanding.

**Example:** Past agents in a feed get violet-bordered badges with normal text. You can see they're agent-related without them competing for attention.

### Ghost — low emphasis

Role-colored text only, no border or background. Quietest.

**Use for:** Metadata, attribution, tertiary actions, inline annotations.

**Example:** A model name, a timestamp, a token count — information that should be available but never demands attention.

## The Emphasis×Role Matrix

Every chromatic element is the product of two independent axes:

```
              ACCENT   ACTIVE   AGENT    DATA    SUCCESS  CAUTION  DANGER
             (orange)  (blue)  (violet)  (teal)  (green)  (yellow)  (red)
  ┌─────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┐
  │ Filled  │ solid  │ solid  │ solid  │ solid  │ solid  │ solid  │ solid  │
  │         │ bg +   │ bg +   │ bg +   │ bg +   │ bg +   │ bg +   │ bg +   │
  │         │ white  │ white  │ white  │ dark   │ dark   │ dark   │ white  │
  ├─────────┼────────┼────────┼────────┼────────┼────────┼────────┼────────┤
  │ Outlined│ orange │ blue   │ violet │ teal   │ green  │ yellow │ red    │
  │         │ border │ border │ border │ border │ border │ border │ border │
  │         │ + norm │ + norm │ + norm │ + norm │ + norm │ + norm │ + norm │
  ├─────────┼────────┼────────┼────────┼────────┼────────┼────────┼────────┤
  │ Ghost   │ orange │ blue   │ violet │ teal   │ green  │ yellow │ red    │
  │         │ text   │ text   │ text   │ text   │ text   │ text   │ text   │
  │         │ only   │ only   │ only   │ only   │ only   │ only   │ only   │
  └─────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┘
```

## Control Categories

Not all controls need the full emphasis×role matrix. Controls fall into five categories with different relationships to the two axes.

### Category 1: Action Controls (buttons, menu items)

**Full emphasis×role matrix.** This is the direct replacement for the current primary/secondary/ghost/destructive system.

Current system → new system:

| Current Variant | → Emphasis | → Role | What changed |
|---|---|---|---|
| `primary` | **filled** | **accent** | Explicitly orange brand CTA |
| `secondary` | **outlined** | **active** | Blue border, neutral text — clearly "interactive but not primary" |
| `ghost` | **ghost** | **active** | Blue text only — minimal affordance |
| `destructive` | **filled** | **danger** | Same visual, now with outlined+danger and ghost+danger also available |

New combinations the current system cannot express:

- `filled + agent` — "AI will do something" (e.g., "Regenerate", "Ask Claude")
- `outlined + agent` — "AI-related secondary action" (e.g., "Edit prompt")
- `filled + data` — "Data operation" (e.g., "Export CSV", "Refresh metrics")
- `outlined + danger` — "Destructive but not screaming" (e.g., "Remove filter")
- `ghost + danger` — "Subtle destructive" (e.g., inline "dismiss" link)

The developer picks emphasis based on **how important** the action is. They pick role based on **what domain** the action belongs to. Two independent decisions.

### Category 2: Form Controls (inputs, textareas, selects)

**No emphasis axis. No role axis for the control itself.** Always neutral at rest. A text input is a text input — it shouldn't be orange or violet.

Role color appears only as a **state signal**:

| State | Role | Visual |
|---|---|---|
| Focus | **active** (blue) | Focus ring and border |
| Invalid | **danger** (red) | Error border |
| Warning | **caution** (yellow) | Warning border |
| Valid | **success** (green) | Valid border |

Maps to the existing `--tug-base-field-*` token family. Changes are limited to renaming validation tokens to reference the new role names.

### Category 3: Selection Controls (checkboxes, switches, radios, toggles)

**No emphasis axis.** Binary or tri-state value (on/off/mixed). The "on" state gets a role color.

Default "on" color is **accent** (orange) — toggling something on is an affirmative action. Selection controls optionally accept a `role` prop for specialized contexts:

| Context | On-state role | Example |
|---|---|---|
| Default | **accent** (orange) | Standard toggle |
| Feature enable | **success** (green) | "Enable notifications" where on=good |
| Risky enable | **danger** (red) | "Enable destructive mode" where on=risky |
| AI feature | **agent** (violet) | "Enable AI assist" toggle |

### Category 4: Display Controls (badges, status indicators, progress bars, sparklines)

**Badges get the full emphasis×role matrix** (validated in POC). Other display elements use role color directly:

- **Progress bars**: fill color = role (success for complete, caution for threshold, danger for over-budget)
- **Sparklines**: line color = role (data for metrics)
- **Status dots**: color = role (any of the 7)
- **Metric readouts**: text color = role (data for numbers)

### Category 5: Navigation Controls (tabs, menus, breadcrumbs)

**No emphasis axis.** Active tab uses **accent** for the underline indicator. Menu items are neutral except destructive items which use **danger**. Emphasis is expressed by active vs. inactive state, not by filled/outlined/ghost.

### Summary: what needs the matrix vs. what doesn't

| Control Type | Emphasis Axis? | Role Axis? | Notes |
|---|---|---|---|
| **Buttons** | Yes (filled/outlined/ghost) | Yes (accent/active/agent/data/danger) | Full matrix, ~8 common combos |
| **Menu items** | No | Partial (neutral + danger) | Normal and destructive only |
| **Form inputs** | No | State-only (focus=active, validation=signal roles) | Neutral at rest |
| **Selection controls** | No | Default accent, optional role prop | On-state color |
| **Badges** | Yes (filled/outlined/ghost) | Yes (all 7 roles) | Proven in POC |
| **Progress/gauges** | No | Yes (success/caution/danger) | Fill color |
| **Status indicators** | No | Yes (all 7 roles) | Dot/icon color |
| **Tabs** | No | Accent for active underline | Already correct |

## Token Structure

### Tone families

Every role produces a uniform 5-token tone family:

```
--tug-base-tone-{role}          (canonical full color)
--tug-base-tone-{role}-bg       (semi-transparent background)
--tug-base-tone-{role}-fg       (foreground text)
--tug-base-tone-{role}-border   (border)
--tug-base-tone-{role}-icon     (icon)
```

7 roles × 5 tokens = **35 tone tokens**.

The emphasis axis is structural CSS (which properties are set), not additional tokens. A filled badge uses `tone-{role}` as its background. An outlined badge uses `tone-{role}-border`. A ghost element uses `tone-{role}` as its text color. No new tokens needed for emphasis — it's a rendering concern, not a token concern.

### Button control tokens (the big change)

The current control token structure:

```
--tug-base-control-{variant}-{property}-{state}
  variants: primary, secondary, ghost, destructive
  properties: bg, fg, border, icon
  states: rest, hover, active
```

Becomes:

```
--tug-base-control-{emphasis}-{role}-{property}-{state}
  emphasis: filled, outlined, ghost
  roles: accent, active, agent, data, danger
  properties: bg, fg, border, icon
  states: rest, hover, active
```

Not every combination needs tokens. Common combinations:

- `filled-accent` — primary CTA ("Send", "Commit", "Deploy")
- `filled-active` — standard interactive button
- `filled-danger` — destructive button ("Delete", "Remove")
- `filled-agent` — AI action button
- `outlined-active` — secondary button
- `outlined-agent` — AI-related secondary action
- `ghost-active` — link-like action
- `ghost-danger` — subtle destructive action

~8 common combinations × 4 properties × 3 states = **96 control tokens** (vs ~48 today).

### Form field tokens (rename only)

```
--tug-base-field-border-focus   → derived from tone-active
--tug-base-field-border-invalid → derived from tone-danger
--tug-base-field-border-valid   → derived from tone-success
--tug-base-field-warning        → derived from tone-caution
```

### Toggle tokens (minimal change)

```
--tug-base-toggle-track-on       → derived from tone-accent (default)
--tug-base-toggle-track-on-hover → derived from tone-accent
```

### Tab tokens (no change)

```
--tug-tab-underline-active → already uses accent
```

### Dialog/alert button mapping (refined)

The current alert system maps button semantic roles to variants. In the new system it maps them to emphasis×role pairs:

| Button Semantic Role | Current | New |
|---|---|---|
| Default/affirmative | `variant="primary"` | `filled + accent` |
| Cancel (with destructive present) | `variant="primary"` | `outlined + active` |
| Cancel (standalone) | `variant="secondary"` | `outlined + active` |
| Destructive | `variant="destructive"` | `filled + danger` |

## Mapping: current system → new system

| Current | New |
|---|---|
| ACCENT (orange, 12 ad-hoc tokens) | ACCENT (orange, uniform 5-token tone family + existing structural aliases) |
| PRIMARY (blue, control tokens only) | ACTIVE (blue, tone family + control tokens) |
| INFO (cyan, 5-token tone family) | Merged into ACTIVE |
| POSITIVE (green, 5-token tone family) | SUCCESS (green, renamed) |
| WARNING (yellow, 5-token tone family) | CAUTION (yellow, renamed) |
| DANGER (red, 5-token tone family) | DANGER (red, unchanged) |
| — | AGENT (violet, new) |
| — | DATA (teal, new) |
| primary/secondary/ghost/destructive variants | emphasis×role matrix (filled/outlined/ghost × role) |

## How Phase 8 planned components map

| Planned Component | Category | Emphasis×Role behavior |
|---|---|---|
| TugButton (update) | Action | Full matrix — emphasis + role props |
| TugInput | Form | Neutral + state signals (focus=active, validation=signal roles) |
| TugTextarea | Form | Neutral + state signals |
| TugSelect | Form + Action | Trigger button = full matrix, dropdown panel = neutral |
| TugCheckbox | Selection | Default accent on-state, optional role prop |
| TugRadioGroup | Selection | Default accent on-state, optional role prop |
| TugSwitch | Selection | Default accent on-state, optional role prop |
| TugSlider | Selection | Default accent on-state, optional role prop |
| TugToggle | Selection | Default accent on-state, optional role prop |
| TugToggleGroup | Selection | Default accent on-state, optional role prop |
| TugBadge | Display | Full emphasis×role matrix |
| TugStatusIndicator | Display | Role only (dot/icon color) |
| TugProgress | Display | Role only (fill color) |
| TugSpinner | Display | Role only (agent for AI, neutral default) |
| TugDialog | Container | Buttons inside use the matrix |
| TugAlert | Container | Semantic role → emphasis×role mapping (see dialog table above) |
| TugTooltip | Navigation | Neutral |
| TugDropdown | Navigation + Action | Items = neutral + danger, trigger = button matrix |
| TugTabBar | Navigation | Accent for active underline (already correct) |

## Token audit findings

An audit of `tug-base.css` against actual usage across the codebase (March 2026) revealed significant over-definition: of 251 tokens defined, 93 (37%) are completely unused and 73 (29%) are used in only one place. The cleanup is rolled into Plan 1 below.

### Guiding principle: define tokens when you need them

Speculative tokens — defined in anticipation of future components — create maintenance burden and obscure what's actually in use. Many of the unused tokens in `tug-base.css` correspond to Phase 8 components not yet built (TugAvatar, TugSlider, TugScrollArea, TugProgress, dialogs, etc.). Rather than keeping these tokens around, **Plan 1 removes all unused tokens.** Each Phase 8 component adds the tokens it needs when it's built. This puts a small incremental cost on each component (define tokens, update the theme generator) but keeps the token sheet honest — every token earns its place by having a consumer.

### Specific audit findings

**Entire subsystems unused (remove in Plan 1):**

| Token group | Count | Phase 8 component that will re-add |
|---|---|---|
| Avatar tokens (`avatar-bg`, `avatar-fg`, `avatar-ring`) | 3 | TugAvatar (8d) |
| Range/scroll tokens (`range-*`, `scrollbar-*`) | 15 | TugSlider (8d), TugScrollArea (8e) |
| Focus ring tokens (`focus-ring-*`) | 3 | Focus management work across all components |
| Selected/highlighted control states | 8 | TugToggle (8d), TugToggleGroup (8e) |
| Motion pattern tokens (`motion-pattern-*`) | 9 | TugDialog (8e), TugAlert (8g), TugToast (8g) |
| Stroke width tokens (`stroke-*`) | 4 | TugSeparator (8d) if needed |

**Accent system over-defined (9 of 12 tokens unused):**

Keep: `accent-default` (48 uses — the workhorse), `accent-cool-default` (14 uses), `accent-subtle` (2 uses). Remove: `accent-strong`, `accent-muted`, `accent-bg-subtle`, `accent-bg-emphasis`, `accent-border`, `accent-border-hover`, `accent-underline-active`, `accent-guide`, `accent-flash`. These 9 tokens have zero references. The new tone-accent family replaces the accent system's role; `accent-default` and `accent-cool-default` remain as structural aliases (brand color, cool accent) distinct from the tone family.

**tone-info nearly dead (merge into ACTIVE):**

Only 2 references total (`tug-code.css`: file-status-renamed, feed-handoff). All 4 variant tokens (bg/fg/border/icon) are zero-use. Redirect the 2 consumers to `tone-active`, delete all 5 info tokens.

**Undefined token referenced:**

`--tug-base-accent-fg` is used 3 times in `gallery-theme-generator-content.css` but never defined. All 3 uses mean "text color on an accent background" — that's `--tug-base-element-global-text-normal-onAccent-rest` which already exists. Fix by replacing the 3 references, not by adding a new token.

**Field tokens partially unused (8 of 27):**

`field-helper`, `field-meta`, `field-counter`, `field-limit`, `field-dirty`, `field-readOnly`, `field-bg-readOnly`, `field-border-readOnly` — all zero-use. Remove; TugInput/TugTextarea re-add what they need.

**Typography and spacing: components should use the tokens.**

The full font-size scale (2xs through 2xl), line-height tokens, and spacing scale are correctly defined but many are unused because components hardcode pixel values. This is a bug in the components, not over-definition. Plan 1 keeps the full typographic and spacing scales and audits component CSS files to replace hardcoded values with token references.

### Token count after cleanup

| Category | Current | After Plan 1 |
|---|---|---|
| Tone families | 20 (4 roles × 5) | 35 (7 roles × 5) |
| Accent structural aliases | 12 | 3 |
| Control surface (button variants) | 48 + 13 unused | Restructured in Plan 2 |
| Field tokens | 27 | 19 (remove 8 unused) |
| Toggle/range/scroll | 23 | 11 (toggle only; range/scroll removed) |
| Focus/selection/highlight | 14 | 0 (removed; re-added per component) |
| Avatar | 3 | 0 (removed; re-added in 8d) |
| Motion patterns | 9 | 0 (removed; re-added in 8e/8g) |
| Surfaces, fg, borders, shadows, typography, spacing, radius, icon-size, motion-base, chrome | ~82 | ~82 (retained, actively used) |
| **Total** | **~251** | **~150** |

Net: ~100 tokens removed, 15 new tone tokens added. The token sheet shrinks by roughly 40%.

## POC card validation summary

| Card | Domain | Key color behaviors validated |
|---|---|---|
| **AI Chat** | ACCENT (orange strip) | Orange Send button (filled+accent), outlined+agent model badge, violet thinking spinner, teal token counter |
| **Agent Feed** | neutral (no strip) | Filled+agent on active item ONLY, outlined+agent on historical items, green/red status signals, teal timing |
| **Telemetry** | DATA (teal strip) | Teal sparklines and numbers throughout, caution threshold lines |
| **Git Status** | ACTIVE (blue strip) | Filled status badges per signal role, blue branch name, accent Commit button |
| **Phase Progress** | mixed (no strip) | Filled+success completed markers, filled+agent in-progress, ghost pending, teal token counts |

## Implementation path

Three sequential plans, each building on the previous:

### Plan 1: Tone families, token cleanup, and derivation engine

This plan combines the 7-role tone family work with a comprehensive cleanup of `tug-base.css`, treating the two as a single operation (touching every file twice would be wasteful).

**New tone families:**
- Add the 7 uniform tone families to `deriveTheme()`: accent, active, agent, data, success, caution, danger
- Rename existing tokens (positive→success, warning→caution)
- Merge INFO into ACTIVE (redirect 2 consumers in `tug-code.css`, delete 5 info tokens)
- Add ACCENT, AGENT, and DATA tone families

**Token cleanup (audit-driven):**
- Remove 9 unused accent interaction tokens (keep `accent-default`, `accent-cool-default`, `accent-subtle`)
- Remove all unused subsystem tokens: avatar (3), range/scroll (15), focus ring (3), selected/highlighted (8), motion patterns (9), stroke widths (4)
- Remove 8 unused field tokens (helper, meta, counter, limit, dirty, readOnly variants)
- Fix `--tug-base-accent-fg` → replace 3 references with `--tug-base-element-global-text-normal-onAccent-rest`
- Audit component CSS for hardcoded pixel values; replace with typography/spacing token references where appropriate

**Infrastructure updates:**
- Update `fg-bg-pairing-map.ts` with new token names
- Update all consuming CSS files
- Update theme overrides in `bluenote.css` and `harmony.css`
- Update all tests

### Plan 2: Button emphasis×role and TugBadge

- Replace the 4-variant button system with emphasis×role on TugButton
- Update TugDropdown triggers and dialog/alert button mappings
- Build TugBadge with the same emphasis×role system (proven in POC)
- Generate the ~8 common emphasis×role control token combinations in the derivation engine

### Plan 3: Form and selection control alignment

- Wire form field validation tokens to tone families (rename only)
- Add optional `role` prop to selection controls (checkbox, switch, radio, toggle)
- Default on-state to accent; role prop overrides to any of the 7 roles
- Update theme generator UI to expose 7 role hue pickers and emphasis×role preview

## POC artifacts

The proof-of-concept implementation lives in:

- `tugdeck/styles/poc-seven-role.css` — POC color tokens and component styles
- `tugdeck/src/components/tugways/cards/poc-seven-role-cards.tsx` — 5 mock card content components
- Developer menu → "Show 7-Role POC" creates all 5 cards on the canvas

These are intentionally separate from the production `--tug-base-*` token system and should be removed once Plan 1 is implemented.
