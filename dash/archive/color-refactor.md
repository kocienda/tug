<!-- devise-skeleton v4 -->

## Key + Accent: a tunable per-theme selection/accent color duet {#key-accent-duet}

**Purpose:** Replace the hardcoded-blue selection color and the never-paired `accent` with a designed, per-theme **Key** (selection / primary action) + **Accent** (affordances: focus ring, keyboard caret, drag-drop, activity) duet, plumbed through a single per-theme **seed** so any theme's whole interactive identity tunes from a handful of numbers — locked first in a live gallery workshop.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-20 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The theme engine (theme-engine.md, "Tinted-Neutral Authoring Doctrine" point 3) deliberately fixes the selection/interactive color to **blue in every theme** and varies only the neutral tint plus an `accent` hue. Each theme hardcodes `--tug-color(blue, …)` ~108×, scattered with no single source. The `accent` hue was chosen merely to *avoid* signal hues, never *designed to partner* with selection — so it's an unrelated orange/amber/magenta used on drag-drop strokes, find-match, badges, and gauges. The keyboard caret bar (shipped in the list-state work) borrows `--tugx-focus-ring`, which resolves to the action/blue axis, so the caret is the same blue as the selection fill it sits on.

Two problems follow: blue selection clashes with the non-blue tints (bravura plum, aria rose, vivace teal), and there is no harmonious second color to give the caret (or any affordance) its own identity. This plan introduces two named, *paired* color roles per theme and — critically — makes them tune from a single per-theme **seed** so we can workshop the hues live and re-tune forever without touching ~100 call sites.

#### Strategy {#strategy}

- **Name the duet Key + Accent**, with a clean semantic split: **Key** = the chosen/committed thing + primary CTA; **Accent** = the affordances around choosing (focus ring, keyboard caret, drag-drop, find-match, activity). ([P01])
- **One tuning point per theme.** A small **seed block** (hue + chroma knobs) drives Key/Accent *ramps* authored in raw `oklch()` with the hue as a `var()` — so a theme's whole interactive identity changes from a couple of numbers. ([P02])
- **Re-value, don't rename.** Point the existing base `--tug7-*` selection/active/toggle families at the Key ramp and the accent/drop families at the Accent ramp; the ~100 `--tugx-*` component aliases ride through untouched. ([P03])
- **Workshop first.** A gallery card with live OKLCH sliders across a representative component board, switchable per theme, is step 1 — we lock the six duets there before any rollout. ([P06])
- **Conservative values, aggressive tunability.** Ship cool themes near today's blue; the seed makes a later swing one number. Red-adjacent themes (bravura, aria) ship pale/pink, macOS-restrained, never a saturated red. ([P05])
- **Prove on one theme, then replicate.** Establish the seed+ramp scaffolding on brio, verify the one-knob behavior and contrast, then roll the locked values to the other five.
- **Audit every step.** `bun run audit:theme-contrast` gates each theme; no theme exceeds the brio budget.

#### Success Criteria (Measurable) {#success-criteria}

- Changing a single theme's `--tug-keycolor-h` seed value visibly re-hues **all** of that theme's selection surfaces (list/row selection, radio/checkbox/choice "on", text selection, tabs, links, the Submit CTA) with no other edits. (Verify: edit one number in a theme file; observe the gallery board + app.)
- Changing `--tug-accent-h` re-hues the keyboard caret bar, focus ring, drag-drop border, and activity marks together. (Verify: same, one number.)
- The keyboard caret bar renders in **Accent**, visibly distinct from the **Key** selection fill it overlays. (Verify: gallery board + a selected+cursor list row.)
- No theme exceeds the `brio` accessibility budget after re-hue. (Verify: `bun run audit:theme-contrast`.)
- The six locked duets are recorded as seed values in each theme file; the gallery workshop card reproduces them. (Verify: read the seed blocks; load the workshop.)
- bravura and aria Key colors read as pink/rose-violet, not as the danger-red swatch. (Verify: side-by-side with a danger button in the gallery.)
- Selected on-fill text stays a high-contrast neutral (near-white in dark / near-black in light) and never takes the Key hue, in every theme. (Verify: a selected row's text stays legible on its re-hued Key fill; computed text color is near-neutral.)

#### Scope {#scope}

1. A gallery **workshop** card with live OKLCH Key/Accent sliders over a representative board, per theme.
2. A per-theme **seed block** + Key/Accent **ramp tokens** (raw `oklch()` off the seed).
3. Repoint base `--tug7-*` selection/active/toggle → Key ramp; accent/accentCool/drop → Accent ramp; classify incidental blues.
4. A dedicated **Accent caret token** for the list-view cursor bar (off the focus/action token); focus ring → Accent.
5. Roll the locked seed values across all six themes (dark + light ramp variants).
6. Doctrine update (theme-engine.md point 3 + the stale accent table).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing the neutral **tint** of any theme, or the **signal** hues (danger/success/caution/data/agent). ([P03])
- Re-hueing incidental literal-blue usages that are *not* interactive selection — syntax highlighting (e.g. JSON number color), the info icon — these stay their own color, not Key. ([P03], [R03])
- Adding new themes or changing `SHIPPED_THEME_NAMES`.
- Replacing the `--tug-color()` engine anywhere except the Key/Accent ramps (the neutral tint, signals, everything else keep `--tug-color()`).
- Persisting workshop slider values as user settings (the spike is a dev tool; locked values are authored into theme files).

#### Dependencies / Prerequisites {#dependencies}

- `postcss-tug-color.ts` rewrites only `--tug-color(...)` calls; raw `oklch()` with a `var()` hue passes through to the built CSS untouched (verified) — the basis for the one-knob seed.
- The list-state work has shipped (the caret bar exists, using `--tugx-focus-ring`).
- `palette-engine.ts` provides OKLCH color math if the spike wants a numeric live preview readout.

#### Constraints {#constraints}

- **Tuglaws** — [L06] appearance via CSS/DOM, never React state; [L15] token-driven state visuals; [L16] foreground rules name their surface; [L17] one-hop `--tugx-*` → base; [L20] component-token sovereignty. Name the laws touched in each commit.
- **Theme contrast budget** — no theme may exceed brio's WCAG-failure count (`bun run audit:theme-contrast`).
- **No localStorage / IndexedDB**, **no fake-DOM tests**, **no time budgets**.
- OKLCH chroma must stay inside the sRGB/P3 gamut for the Key/Accent hue ranges chosen (raw `oklch()` ramps lose the per-hue gamut caps `--tug-color()` provides). ([R01])

#### Assumptions {#assumptions}

- Authoring the Key/Accent ramps as `oklch(<L> calc(var(--tug-keycolor-c) * <frac>) var(--tug-keycolor-h))` reproduces today's selection ramp closely enough at conservative chroma; fine-tuning happens in the workshop.
- Dark and light themes need different lightness (L) anchors in the ramp, so the ramp formula has a per-mode variant (or per-theme L knobs), not a single universal L set.
- The ~100 component aliases already funnel through base `--tug7-*` tokens, so repointing the base tokens is sufficient — no component CSS edits for the re-hue itself (only the caret token is new).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Explicit kebab-case anchors; plan-local decisions `[P01]`; steps cite decisions/specs/anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] The exact per-theme Key/Accent seed values (OPEN → resolved by the spike) {#q01-seed-values}

**Question:** What hue/chroma/lightness seed values does each of the six themes get?

**Why it matters:** These are the actual colors users see; getting them wrong is the whole point of failure. They need eyes-on tuning against real components, not guessed in the abstract.

**Options (starting points, to tune in the workshop):**
- brio (dark, indigo-violet tint): Key cobalt-blue ~250°, Accent orange ~55°.
- harmony (light, indigo): Key cobalt-blue, Accent orange (deeper for light).
- nocturne (dark, cobalt): Key sapphire ~240° (deeper than tint), Accent aqua/cyan ~197° (cool duet; amber fallback).
- bravura (dark, plum): Key magenta-cerise ~342° **pale**, Accent cyan ~197°.
- aria (light, rose): Key cerise ~340° **pale**, Accent azure/sky ~210°.
- vivace (light, teal): Key cerulean/sky ~218°, Accent coral/tangerine ~45°.

**Plan to resolve:** The workshop spike (#step-1). Lock values there; record them in the seed blocks.

**Resolution:** OPEN — DECIDED per theme at the end of #step-1; the remaining steps consume the locked values.

#### [Q02] Ramp authoring: raw `oklch()` seed vs `--tug-color()` (DECIDED) {#q02-ramp-authoring}

**Question:** Do the Key/Accent ramps keep `--tug-color()` (gamut-safe, but hue is baked at build) or use raw `oklch()` with a `var()` hue (one-knob tunable)?

**Resolution:** DECIDED — raw `oklch()` with the hue as a `var()` for the Key/Accent ramps only. This is what makes the hue a single tunable number ([P02]); the gamut-cap tradeoff is mitigated by conservative chroma + the audit ([R01]). Everything else keeps `--tug-color()`.

#### [Q03] Does the navigational `link` color follow Key? (DECIDED, revisit in workshop) {#q03-link-follows-key}

**Question:** Should `--tug7-element-global-text-normal-link-*` (markdown/nav links) re-hue to Key, or stay blue?

**Resolution:** DECIDED — navigational links **follow Key** (links are an interactive affordance). But incidental consumers of the *link token* that are not links — JSON syntax number color, the inline-dialog info icon — are reclassified off the link token to a fixed blue/own signal during the classification pass ([P03], [R03]). Validate the link-as-Key look in the workshop; if a magenta link reads wrong in bravura, links fall back to a fixed blue (one-line change).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Raw `oklch()` ramps clip the gamut (no per-hue cap) | med | med | Conservative chroma; verify on sRGB + P3; audit gate | A swatch looks muddy/clipped in the workshop |
| Re-hue regresses WCAG contrast | high | med | `audit:theme-contrast` every step; tune L in the ramp | Any theme exceeds the brio budget |
| Re-hueing the "blue family" recolors incidental non-selection blues | med | high | Explicit Key-membership classification pass; exclude syntax/info ([P03]) | A JSON number or info icon turns magenta |
| bravura/aria Key reads as danger-red | med | med | Pale, pink/rose-violet Key; gallery side-by-side with danger | Confusion in the danger comparison |
| Caret Accent vs Key fill low contrast on a selected+cursor row | low | low | Workshop the pair on that exact composite; tune Accent L/C | Bar invisible over the fill |

**Risk R01: Gamut clipping on raw-oklch ramps** {#r01-gamut}

- **Risk:** `--tug-color()` binary-searches a gamut-safe peak chroma per hue; a hand-rolled `oklch(L C h)` can exceed it and clip (especially on sRGB).
- **Mitigation:** Keep chroma in a conservative band; the workshop slider has a chroma knob to find the safe ceiling per hue; verify on both gamuts.
- **Residual risk:** Slightly less saturated peaks than `--tug-color()` could achieve — acceptable for restrained, macOS-like colors.

**Risk R03: Incidental blue recolor** {#r03-incidental-blue}

- **Risk:** Tokens like `--tugx-json-number-color` and `--tugx-idialog-icon-info-color` consume the *link* blue; if link → Key, they re-hue too.
- **Mitigation:** A classification pass (in #step-3) repoints non-interactive blues to a fixed blue / own signal *before* link → Key, so only true affordances move.
- **Residual risk:** A missed incidental consumer surfaces as an off-color glyph; caught in the integration walk.

---

### Design Decisions {#design-decisions}

#### [P01] Two named roles — Key (primary) + Accent (secondary) — split by meaning (DECIDED) {#p01-key-accent}

**Decision:** Adopt **Key** = "the chosen / committed thing + primary action" and **Accent** = "the affordances around choosing." Key carries: text/code selection, list/row/menu selection fills, radio·checkbox·switch·choice·option "on", tab/card active, links, the Submit/primary CTA. Accent carries: keyboard caret bar, focus ring, drag-&-drop target border/stroke, find-match outline/flash, progress·spinner·gauges·activity, badges & insert-indicators.

**Rationale:**
- A single teachable line — *Key = the chosen thing; Accent = the affordances* — and it makes the caret naturally Accent, distinct from the Key fill it overlays.
- Maps onto today's axes (Key ≈ `selection`/`active`/`toggle`/`link`; Accent ≈ `accent`/`accentCool`/`drop`), so it's a re-value, not a re-architecture.

**Implications:**
- Keyboard (`data-key-*`, DOM attributes) and color (`--tug-keycolor-*`, CSS vars) share the word "key" — kept apart by layer + the fuller `keycolor` token name. Docs say "Key color" vs "keyboard cursor."
- The caret moves from the focus/action token to a dedicated Accent token ([P04]).

#### [P02] One seed per theme; ramps authored in raw `oklch()` off the seed (DECIDED) {#p02-seed}

**Decision:** Each theme declares a small **seed block** — `--tug-keycolor-h`, `--tug-keycolor-c`, `--tug-accent-h`, `--tug-accent-c` (plus per-mode lightness anchors as needed) — and the Key/Accent **ramp tokens** are authored as `oklch(<L> calc(var(--tug-keycolor-c) * <frac>) var(--tug-keycolor-h) / <alpha>)`. The seed is the single tuning point.

**Rationale:**
- Hue is one OKLCH axis; making it a `var()` collapses ~108 scattered `blue` calls into one knob per role.
- `postcss-tug-color` leaves raw `oklch()` untouched (verified), so the `var()` hue survives to runtime — enabling the live workshop sliders *and* one-line re-tuning forever.

**Implications:**
- The Key/Accent ramps stop using `--tug-color()` (lose per-hue gamut caps → conservative chroma, [R01]).
- Dark vs light themes get different L anchors in the ramp (per-mode variant or per-theme L knobs).
- The ramp must reproduce every rung the current selection/accent tokens provide (rest/hover/quiet/selected/plain/demoted/toggle-on/tone-active/link) — see Spec S01.

#### [P03] Re-value base tokens to the ramps; classify Key membership precisely (DECIDED) {#p03-revalue}

**Decision:** Re-point base `--tug7-*` tokens through the Key/Accent ramps **by role bucket**, never by a blanket "selection family → Key" swap. The selection/active/toggle/link families are not one color; per Spec S01 they split three ways: (1) **Key-hued fills** → Key ramp; (2) **on-fill contrast text** stays a near-white/near-black neutral (NOT Key — Key-hued text on a Key fill would vanish); (3) **role-hued / achromatic exceptions** (`plain-inactive`, `demoted-{danger,data,agent}`) are left untouched, while `demoted-action` → Key and `demoted-accent` → Accent. The `accent` / `accentCool` / `drop` families → Accent ramp. Component aliases are untouched. A classification pass also excludes non-interactive incidental blues (JSON syntax number, info icon) from Key (List L01).

**Rationale:**
- "selection" bundles four different things: the Key-hued fill, the high-contrast text drawn *on* that fill, an achromatic "inactive" wash, and role-hued demoted variants. Only the fills (+ toggle-on, tone-active, links) are Key.
- The ~100 aliases already funnel through base tokens, so the re-hue happens at the base tier with no component edits.
- "Blue" today also doubles as an incidental literal (syntax/info); only the interactive semantics belong to Key.

**Implications:**
- The repoint is surgical per base token, per Spec S01's buckets — never a blanket `blue`→Key swap.
- On-fill text stays neutral; its contrast against the *new* Key fill is exactly what the contrast audit gates.
- Signals, neutral tint, achromatic/role washes, and incidental blues are preserved ([#non-goals]).

#### [P04] The keyboard caret bar uses a dedicated Accent token (DECIDED) {#p04-caret-accent}

**Decision:** Add `--tugx-list-view-cursor-bar-color` resolving to the **Accent** ramp, and repoint the cursor `::before` bar off `--tugx-focus-ring`. The focus ring itself also resolves to Accent (the affordance family).

**Rationale:** The caret and the selection fill must read as different colors; Accent is that second color. Unifying focus ring + caret + drag-drop under Accent makes "affordance" one coherent hue.

**Implications:** One new component token; the cursor-bar rule (from the list-state work) changes its `background` source. Focus-ring repoint is part of the Accent rollout.

#### [P05] Conservative initial values, macOS-restrained, red-safe (DECIDED) {#p05-conservative}

**Decision:** Ship cool themes near today's blue; the seed makes future swings trivial. All Key colors sit in a **restrained, macOS-like chroma band** (friendly, not neon). bravura and aria Key lean **pale pink / rose-violet**, never a saturated red, so they never read as the danger swatch.

**Rationale:** De-risks the rollout (cool themes barely move) while delivering the machinery; matches the macOS accent reference; keeps danger legible in red-adjacent themes.

**Implications:** The workshop's job is to find the restrained values; the audit confirms contrast.

#### [P06] Workshop spike first; lock values before rollout (DECIDED) {#p06-spike-first}

**Decision:** Build the live-slider gallery board first (#step-1) and lock the six duets there. No theme values are authored until the spike locks them.

**Rationale:** Color is a see-it-to-believe-it decision; the spike turns [Q01] from a guess into a tuned result, across the exact composites that matter (selected row + caret, Submit, radio/choice, text selection, drag-drop).

**Implications:** #step-1 produces the locked seed values that every later step consumes.

---

### Deep Dives {#deep-dives}

#### Implementation handoff — field notes (read first) {#field-notes}

> Written pre-compaction so the implementer doesn't re-derive what's already been
> verified. Everything here was checked against the real code on 2026-06-20.

**Repo / branch state.**
- The list-state work (the keyboard caret bar) is already merged to `main`. The caret
  exists in `tugdeck/src/components/tugways/tug-list-view.css`: a `::before` on
  `.tug-list-view-cell[data-key-cursor]`, width token `--tugx-list-view-cursor-bar-width: 3px`,
  and **`background: var(--tugx-focus-ring)`** today (Step 4 repoints this to a new
  `--tugx-list-view-cursor-bar-color` → Accent).
- This plan file (`dash/color-refactor.md`) is **uncommitted** at devise/vet time —
  commit it before/with the implement run (the implement skill works on a `tugutil dash`
  worktree; the plan rides along once committed).

**The build-the-ramps bootstrap tactic (the cleanest path to Spec S01).** Don't invent
ramp L/C from scratch. For each Key/Accent token, take today's `--tug-color(blue, i:X, t:Y)`
value, expand it to its concrete `oklch(L C h)` (via `tugColor()` in
`tugdeck/src/components/tugways/palette-engine.ts`, or read the `postcss-tug-color`
expansion — `--tug-color(blue, i:5, t:13)` → `oklch(0.3115 0.0143 230)`), then author the
ramp rung as `oklch(<that L> <that C> var(--tug-keycolor-h))`. With the seed hue = 230
(blue) the result is **byte-for-byte today's color**; changing the seed re-hues from one
knob. Start chroma literal (exact match), then optionally migrate C to
`calc(var(--tug-keycolor-c) * <frac>)` once values are locked. This makes "reproduce every
rung" mechanical, not artistic, and keeps the conservative-rollout promise ([P05]).

**Verified facts (don't re-check).**
- `tugdeck/postcss-tug-color.ts` rewrites **only** `--tug-color(...)` substrings; raw
  `oklch()` (incl. `var()` in any slot) passes through untouched ("Values without
  --tug-color() are passed through unchanged"). This is what makes the runtime seed work.
- `--tug-color()` tone (`t:`) maps through each hue's **piecewise canonical lightness**, so
  you cannot port `t:` numbers across hues — that's exactly why the ramps use **explicit L**
  (Spec S01) and the bootstrap tactic above (expand-then-swap-hue) instead.
- `--tugx-focus-ring` is defined in **two** places: `tugdeck/styles/focus-ring.css`
  (`body { … var(--tug7-element-control-border-outlined-action-rest) }`, blue) and
  `tugdeck/src/components/tugways/internal/tug-button.css` (`--tug7-element-control-border-filled-accent-rest`).
  Step 4 must reconcile both. Confirm cascade winner before editing.
- Gallery cards register via `registerCard` / `componentId` in
  `tugdeck/src/components/tugways/cards/gallery-registrations.tsx` (see `GALLERY_DEFAULT_CARDS`);
  follow an existing `gallery-*.tsx` (e.g. `gallery-palette.tsx`) for the shape.
- `palette-engine.ts` exposes the OKLCH math (`tugColor()`) for a numeric live readout in
  the spike if wanted.

**brio selection taxonomy (the canonical reference for Table T01 buckets).** Verbatim from
`tugdeck/styles/themes/brio.css`:
- Key-hued fills: `selection-primary-normal-plain-rest` = `blue i:50 t:50 a:40`;
  `selected-rest` = `blue i:84 t:44`; `selected-hover` = `blue i:90 t:53`;
  `quiet-rest` = `blue i:38 t:30`; `quiet-hover` = `blue i:38 t:35`;
  `quiet-strong` = `blue i:54 t:38`; `demoted-action` = `blue i:22 t:28`;
  `toggle on-rest` = `blue i:84 t:44`, `on-hover` = `blue i:90 t:53`, `on-disabled` = `blue i:20 t:44`;
  `tone-*-active` ≈ `blue t:47`; `link-rest` = `blue t:86`, `link-hover` = `blue-light`.
- **NOT Key (leave alone):** `element-selection-text-normal-plain-rest` = `indigo i:3 t:94`
  and `selected-rest` = `indigo i:2 t:100` — these are the **near-white text drawn on the
  fill**; re-hueing them = invisible text. `plain-inactive` = `yellow i:0 t:30 a:25`
  (achromatic, i:0). `demoted-{danger,data,agent}` = red/teal/violet (role-hued).
- Accent today (per theme, the warm/second hue to replace with the designed Accent):
  brio `orange`, nocturne `amber`, bravura `magenta`, harmony/aria/vivace `orange`. The
  theme-engine.md Tint/Accent **table is stale** (it lists cyan/amber/cyan) — Step 6 fixes it.

**Hue angles for [Q01] starting points** (from `tuglaws/color-palette.md`): blue 230,
cobalt 250, sapphire 240, indigo 260, cerulean 222.5, sky 215, azure 207.5, cyan 200,
aqua 187.5; orange 55, amber 65, tangerine 50, coral 20; magenta 345, cerise 340, rose 335.
**Signals to stay ≥~30° away from:** danger red 25, success green 140, caution gold 75,
data teal 175, agent violet 270. OKLCH tone endpoints: `L_DARK 0.15` (t0), `L_LIGHT 0.96`
(t100), canonical L at t50.

**Spike wiring (Step 1), exact chain.** slider `onInput` → `style.setProperty('--tug-keycolor-h', …)`
on the **board container** → board-scoped CSS `:where(.gallery-color-duet-board){ --tug7-selection-…: oklch(… var(--tug-keycolor-h)); … }`
(the Table-T01 repoints, scoped) → real components inside read `--tug7-*` and repaint. The
seed lives on the board scope so it doesn't leak to the rest of the gallery. Keep the slider
value in `useState` only for the controlled input / numeric readout (local-data); the paint
is the `setProperty` (appearance) — never drive the color through a React re-render ([L06]).

**Audit.** `bun run audit:theme-contrast [name]`. Comparative budget: `brio` is the
reference (~132 WCAG failures as of the list-state work); no theme may ship with *more*.
Re-run per theme after every re-hue step.

**Suggested dash name:** `color-refactor` (or `color-duet`). The implement run stops after
Step 1 for the visual tuning loop — surface the locked seed values to the user, then continue.

---

### Specification {#specification}

#### Seed + ramp token vocabulary {#seed-vocab}

**Spec S01: Seed block, ramp authoring, and token buckets** {#s01-seed}

Per-theme seed (the only hand-tuned numbers):

```css
body {
  --tug-keycolor-h: <deg>;    /* Key hue angle    */
  --tug-keycolor-c: <chroma>; /* Key chroma base  */
  --tug-accent-h:   <deg>;    /* Accent hue angle */
  --tug-accent-c:   <chroma>; /* Accent chroma    */
  /* + per-mode lightness anchors; light themes need a different L set than dark */
}
```

**Ramp authoring.** Each rung is `oklch(<L> calc(var(--tug-keycolor-c) * <frac>) var(--tug-keycolor-h) / <alpha>)`. The `<L>` is an **explicit, hand-picked per-rung lightness — NOT derived from a `t:`→L curve.** The `--tug-color()` engine maps `t:` through each hue's *piecewise canonical lightness*; a raw-`oklch()` ramp cannot replicate that and must not try — the workshop tunes L per rung directly, and the chroma fraction per rung is picked to stay in gamut ([R01]).

**Token buckets (the repoint contract).** The selection/active/toggle/link families are NOT monochromatic; route by bucket:

**Table T01: Selection-family buckets** {#t01-buckets}

| Bucket | Tokens | Treatment |
|---|---|---|
| **Key-hued fills** | `selection-primary-normal-{plain-rest, selected-rest, selected-hover, quiet-rest, quiet-hover, quiet-strong}`, `selection-primary-demoted-action`, `surface-toggle-primary-normal-on-{rest,hover,disabled}`, `element-tone-{border,fill,icon,text}-normal-active`, `surface-tone-primary-normal-active`, `element-global-text-normal-link-{rest,hover}` | → **Key ramp** |
| **On-fill contrast text** | `element-selection-text-normal-{plain-rest, selected-rest}` | **stays a near-white (dark) / near-black (light) neutral** — never Key-hued (Key text on a Key fill vanishes); its contrast vs the new Key fill is gated by `audit:theme-contrast` |
| **Untouched exceptions** | `selection-primary-normal-plain-inactive` (achromatic inactive wash), `selection-primary-demoted-{danger,data,agent}` (role-hued) | **left as-is** |

The **Accent ramp** covers: `element-global-border-normal-accent`, `element-tone-{border,fill,icon,text}-normal-accent`, `surface-tone-primary-normal-accent`, `surface-control-primary-filled-accent-{rest,hover,active}`, `selection-primary-demoted-accent`, `element-highlight-stroke-normal-drop`, `element-global-fill-normal-{accent,accentCool,accentSubtle}`, plus the focus-ring + caret. Note `accentCool` (today a distinct indigo second-accent) **collapses into Accent** — an intentional simplification; its few consumers (e.g. the cue icon) become the one Accent hue.

#### Key membership classification {#key-membership}

**List L01: Incidental blues that stay blue / not Key** {#l01-not-key}

These consume a blue/link token today but are NOT interactive selection, so they keep a fixed blue (or their own signal) rather than following Key:

- JSON syntax number color (`--tugx-json-number-color`) — syntax highlighting, fixed blue.
- Inline-dialog info icon (`--tugx-idialog-icon-info-color`) — info signal, fixed blue.
- Any other consumer of the link token that is not a navigational link (audited in #step-3).

(Distinct from the *within-family* non-Key buckets — on-fill contrast text and the achromatic/role washes — which are handled in Table T01, not here.)

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Workshop slider values | local-data | `useState` in the gallery card | [L24] |
| Slider → live preview | appearance | `style.setProperty('--tug-keycolor-h', …)` on a container (no React-state-driven paint) | [L06] |
| Seed + ramps + re-valued tokens | appearance | authored CSS custom properties | [L06], [L15], [L17] |
| Caret bar color | appearance | CSS token → Accent ramp | [L06] |

No persistent or store-backed state; the spike is dev-only and values are authored into theme files.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/cards/gallery-color-duet.tsx` | Workshop card: live OKLCH Key/Accent sliders + representative board |
| `tugdeck/src/components/tugways/cards/gallery-color-duet.css` | Board layout + sample composites |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `--tug-keycolor-h/-c`, `--tug-accent-h/-c` | CSS seed tokens | each `styles/themes/*.css` | the per-theme tuning knobs ([P02]) |
| Key/Accent ramp tokens | CSS | each `styles/themes/*.css` | raw `oklch()` off the seed; cover Spec S01 |
| `selection`/`active`/`toggle`/`link` base tokens | CSS re-value | each `styles/themes/*.css` | → Key ramp ([P03]) |
| `accent`/`accentCool`/`drop` base tokens | CSS re-value | each `styles/themes/*.css` | → Accent ramp ([P03]) |
| `--tugx-list-view-cursor-bar-color` | CSS token | `tug-list-view.css` | → Accent; repoint cursor `::before` ([P04]) |
| `--tugx-focus-ring` | CSS re-value | `focus-ring.css` / `internal/tug-button.css` | → Accent ([P04]) |
| gallery registration | TS | `cards/gallery-registrations.tsx` | register `gallery-color-duet` |
| theme-engine.md doctrine | docs | `tuglaws/theme-engine.md` | rewrite point 3 + accent table |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When |
|----------|---------|------|
| **Workshop (manual)** | Tune + lock the six duets on real composites | #step-1 |
| **Contrast audit** | WCAG budget per theme | every theme step |
| **Build/tsc** | type + warning gate | every step |
| **App-test (targeted)** | the caret + selection still render (behavior unchanged) | caret step |

#### What stays out of tests {#test-non-goals}

- Pixel-color snapshot tests — colors are tuned visually + gated by the contrast audit, not asserted as RGB literals.
- Fake-DOM render tests of the gallery card — banned; the workshop is verified by loading it in the real app.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Each step names the tuglaws it touches in its commit body. The workshop (#step-1) produces the locked seed values every later step consumes.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Workshop spike — live Key/Accent gallery board | done — six duets locked by the user | a13c6d151, e8e0629bf |
| #step-2 | Brio re-valued to the duet via --tug-color() (audit-resolvable, on-model) | done (folded with #step-3) | 3d5274c82 |
| #step-3 | Repoint base tokens → Key/Accent on brio; classify incidental blues | done — incidental json/info left on link pending user call | 3d5274c82 |
| #step-4 | Caret + focus ring → Accent | done | 3d5274c82 |
| #step-5 | Roll locked seed values to the other five themes | done — full audit green (all six under brio budget) | f96614950 |
| #step-6 | Doctrine update + integration checkpoint | done — theme-engine.md updated; at0127 PASS | 56eb775cc |

---

#### Step 1: Workshop spike — live Key/Accent gallery board {#step-1}

**Commit:** `tugdash(color-duet): live Key/Accent workshop gallery board [L06]`

**References:** [P06] spike-first, [P01] Key/Accent split, [P02] seed, [Q01] seed values, Spec S01, (#seed-vocab, #success-criteria)

**Artifacts:**
- `gallery-color-duet.tsx` / `.css`: four range sliders (`--tug-keycolor-h/-c`, `--tug-accent-h/-c`) writing CSS vars onto a board container; the board renders the representative composites — a selected list row **with the keyboard caret**, the Submit/primary CTA, a radio group + checkbox + choice group, a text-selection sample, and a drag-drop target border — plus a **danger button** for the red-safety comparison. A theme switcher (or instructions to switch theme) so all six can be tuned.
- A **board-scoped ramp + base-token override** in `.css`: the Key/Accent ramps (Spec S01) and the Table-T01 base-token repoints, scoped to the board container (e.g. `.gallery-color-duet-board { --tug7-…: <ramp>; }`), so that **real components inside the board are driven by the seed sliders.** Real components read `--tug7-*`, not the seed directly — without this scoped override the sliders would move nothing. This scoped override is the working prototype that Steps 2–3 promote to the theme files.
- Registered in `gallery-registrations.tsx`.

**Tasks:**
- [ ] Author the board-scoped Key/Accent ramps + Table-T01 base-token repoints so the real components below pick up seed-driven colors (this de-risks Steps 2–3 by proving the mapping in a sandbox first).
- [ ] Build the board using real components (TugListView row + caret, TugPushButton primary, TugRadioGroup, TugCheckbox, TugChoiceGroup, a selectable text block, a drag-drop target) — confirm each reflects the sliders.
- [ ] Wire sliders to `style.setProperty` on the board container ([L06]); show the numeric values for transcription.
- [ ] Tune each of the six themes to restrained, macOS-like values; bravura/aria Key pale pink/rose-violet, red-safe ([P05]); record the locked seed values in the plan ([Q01] resolution) or a constants comment.

**Tests:**
- [ ] Load the workshop in the real app; moving each slider re-hues all sample composites live, in a dark and a light theme.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; gallery card renders; sliders drive all samples; six duets locked and written down.

---

#### Step 2: Seed + ramp scaffolding on brio (architecture proof) {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(color-duet): seed block + Key/Accent ramps on brio [L15][L17]`

**References:** [P02] seed, Spec S01, [Q02] ramp authoring, Risk R01, (#seed-vocab)

**Artifacts:**
- brio: the seed block + the full Key/Accent ramp token set authored as raw `oklch()` off the seed, reproducing every rung in Spec S01 (not yet wired to base selection tokens — defined alongside for comparison).

**Tasks:**
- [ ] Author the ramp formula (dark-mode L anchors) and the brio seed from the locked values.
- [ ] Verify chroma stays in gamut on sRGB + P3 ([R01]); adjust the chroma base if any rung clips.
- [ ] Confirm `postcss` leaves the raw `oklch(var())` untouched in the built CSS.

**Tests:**
- [ ] Temporarily point one visible token (e.g. the list selection fill) at the Key ramp; confirm editing `--tug-keycolor-h` alone re-hues it live.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; `bun run audit:theme-contrast brio` no worse than baseline; one-knob hue change demonstrably works.

---

#### Step 3: Repoint base tokens → Key/Accent on brio; classify incidental blues {#step-3}

**Depends on:** #step-2

**Commit:** `tugdash(color-duet): route brio selection/accent base tokens through the duet [L15][L17][L20]`

**References:** [P03] re-value, Spec S01, Table T01, [Q03] link-follows-key, List L01, Risk R03, (#key-membership)

**Artifacts:**
- brio base tokens repointed **per Table T01**: Key-hued fills → Key ramp; `accent`/`accentCool`/`drop` (+ `demoted-accent`) → Accent ramp. **On-fill contrast text (`element-selection-text-normal-*`) stays a near-white neutral — NOT re-hued.** Achromatic/role exceptions (`plain-inactive`, `demoted-{danger,data,agent}`) left as-is. Incidental non-interactive blues (JSON number, info icon) repointed to a fixed blue per List L01.

**Tasks:**
- [ ] Repoint each base token by its Table-T01 bucket — never a blanket family swap; explicitly leave on-fill text, achromatic/role washes, signals, and tint alone.
- [ ] Run the classification pass: find every consumer of the link/blue tokens and confirm each is a true affordance (else add to List L01).
- [ ] Spot-check the gallery — selection/toggles/links/CTA take Key; **on-fill selected text stays legible (neutral, not Key-hued)**; JSON numbers + info icon unchanged.

**Tests:**
- [ ] Gallery walk on brio: selection/toggle/CTA/links read as Key; JSON numbers + info icon unchanged.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; `bun run audit:theme-contrast brio` under budget; no incidental-blue regressions.

---

#### Step 4: Caret + focus ring → Accent {#step-4}

**Depends on:** #step-3

**Commit:** `tugdash(color-duet): caret bar + focus ring resolve to Accent [L06][L16]`

**References:** [P04] caret-accent, [P01], (#symbols)

**Artifacts:**
- `tug-list-view.css`: `--tugx-list-view-cursor-bar-color` → Accent; cursor `::before` `background` repointed off `--tugx-focus-ring`.
- `focus-ring.css` / `internal/tug-button.css`: `--tugx-focus-ring` → Accent ramp; `@tug-renders-on` / pairings refreshed ([L16]).

**Tasks:**
- [ ] Add the caret Accent token and repoint the bar.
- [ ] Repoint the focus ring to Accent at **both** definition sites (`focus-ring.css` → `outlined-action`/blue today, and `internal/tug-button.css` → `filled-accent`); confirm which one wins by cascade and that the result is a single coherent Accent ring (no half-applied split).
- [ ] Verify ring + selection fill now differ in hue.
- [ ] Confirm caret legibility over a Key selection fill on a selected+cursor row (brio).

**Tests:**
- [ ] `just app-test at0127-list-view-cursor` (cursor still projects/renders).
- [ ] Gallery: selected+cursor row shows Key fill + Accent bar, distinct.

**Checkpoint:**
- [ ] `just app-test at0127-list-view-cursor` PASS; `bunx tsc --noEmit` clean; visual: caret is Accent.

---

#### Step 5: Roll locked seed values to the other five themes {#step-5}

**Depends on:** #step-4

**Commit:** `tugdash(color-duet): apply Key/Accent duet to nocturne/bravura/harmony/aria/vivace`

**References:** [P02] seed, [P03] re-value, [P05] conservative/red-safe, [Q01] locked values, Risk R01/R03, (#success-criteria)

**Artifacts:**
- nocturne, bravura, harmony, aria, vivace: seed block + ramps (light-mode L variant for harmony/aria/vivace) + base-token repoint + incidental-blue classification, mirroring brio with each theme's locked seed.

**Tasks:**
- [ ] Apply the locked seed values per theme; add the light-mode ramp L anchors for the three light themes.
- [ ] Verify bravura/aria Key reads pale/pink, not danger-red (gallery danger comparison).
- [ ] Confirm the one-knob behavior holds per theme.

**Tests:**
- [ ] Gallery walk per theme: selection/caret/CTA/affordances read as the locked duet.

**Checkpoint:**
- [ ] `bun run audit:theme-contrast` (all six) — no theme exceeds the brio budget; `bunx tsc --noEmit` clean.

---

#### Step 6: Doctrine update + integration checkpoint {#step-6}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [P01]–[P06], Spec S01, List L01, (#success-criteria)

**Artifacts:**
- `tuglaws/theme-engine.md`: rewrite doctrine point 3 (selection is no longer "fixed blue"; document the Key/Accent duet + the seed-based tuning) and refresh the stale Tint/Accent table to the locked values.

**Tasks:**
- [ ] Update the doctrine + table.
- [ ] Walk all six themes in the app: selection (Key), caret/focus/drag-drop (Accent), Submit CTA, text selection — all coherent; incidental blues intact.
- [ ] Confirm a one-number seed edit re-hues a theme end-to-end (the deliverable demo).

**Tests:**
- [ ] Full `bun run audit:theme-contrast` green; `just app-test at0127-list-view-cursor` PASS.

**Checkpoint:**
- [ ] All six themes pass the audit; doctrine current; one-knob re-hue demonstrated.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A per-theme Key + Accent color duet, tunable from a single seed block, applied across selection, toggles, links, the Submit CTA, the keyboard caret, focus ring, and drag-drop — with the six duets locked in a live gallery workshop and every theme under the contrast budget.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Editing one theme's `--tug-keycolor-h` re-hues all its selection surfaces; `--tug-accent-h` re-hues all affordances. (one-knob demo)
- [ ] The caret bar is Accent, distinct from the Key selection fill. (gallery + app)
- [ ] bravura/aria Key reads pale pink/rose-violet, not danger-red. (gallery comparison)
- [ ] Incidental blues (JSON number, info icon) unchanged; selected on-fill text stays a neutral, not Key-hued. (gallery)
- [ ] `bun run audit:theme-contrast` green for all six; no tsc/lint warnings.
- [ ] theme-engine.md doctrine + table updated.

**Acceptance tests:**
- [ ] `bun run audit:theme-contrast`
- [ ] `just app-test at0127-list-view-cursor`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Aggressive per-theme hue swings now that the seed makes them one-line.
- [ ] Consider a user-facing accent picker (macOS-style) leveraging the seed.
- [ ] Revisit whether `link` should be its own role distinct from Key.

| Checkpoint | Verification |
|------------|--------------|
| One-knob re-hue | edit one seed value; observe end-to-end |
| Caret is Accent | gallery selected+cursor row |
| Red-safety | gallery Key vs danger button (bravura/aria) |
| Contrast | `bun run audit:theme-contrast` (all six) |
| Incidental blues intact | JSON number + info icon unchanged |
