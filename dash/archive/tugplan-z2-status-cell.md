# Tugplan — Z2 status cell as a proper component {#z2-status-cell}

## Purpose {#purpose}

The dev card's **Z2 telemetry status row** (STATE / TIME / TOKENS / CONTEXT /
TASKS) is the card's one bespoke holdout. Every cell is hand-assembled inline in
`dev-card-telemetry-renderers.tsx` as a `<span className="dev-telemetry-status-cell">`
wrapped in a `TugPopoverTrigger`, with ad-hoc CSS in
`dev-card-telemetry-renderers.css`. A `<span>` trigger is not keyboard-activatable
and carries no focus model, so retrofitting the focus language onto it (ring,
arrow-rove, popover-on-Space) is the "invasive" part of giving the row a keyboard
cycle.

This plan **componentizes the cell** into a real, button-rooted component
(`TugStatusCell`) so that authoring the row into the dev-card focus cycle
(`tugplan-focus-language.md` → `#step-z2-cycle`) becomes the same trivial "join the
cycle" the Z4B chips already enjoy. It is a faithful extraction: zero behavior or
appearance change in this plan — the focus/keyboard wiring lands in the
follow-on step.

## Plan Metadata {#metadata}

- **Slug:** `tugplan-z2-status-cell`
- **Area:** tugdeck / tugways (dev card)
- **Parent:** [`tugplan-focus-language.md` → Step 2.7 `#step-z2-components`](./tugplan-focus-language.md#step-z2-components)
- **Unblocks:** [`tugplan-focus-language.md` → Step 2.8 `#step-z2-cycle`](./tugplan-focus-language.md#step-z2-cycle)
- **Commit family:** `feat(devcard): …` (no plan-step numbers in code/commits)

## Phase Overview {#overview}

### Context {#context}

The row is rendered by `DevTelemetryStatusRow` (a `forwardRef` exposing
`openContextPopover()` for the `/context` slash command). Each of the five cells is:

```
<TugPopover [ref?]>
  <TugPopoverTrigger>
    <span className="dev-telemetry-status-cell dev-telemetry-status-anchor" data-priority="…">
      <DevTelemetryEndcapRuleLabel label="…" ticksDirection="down" />
      <span className="dev-telemetry-status-value-wrap"> …value… </span>
    </span>
  </TugPopoverTrigger>
  <TugPopoverContent side="top" align="center" sideOffset={8} arrow>{popover}</TugPopoverContent>
</TugPopover>
```

The five cells differ only in: `data-priority` (which sets a per-cell static
`--tugx-dev-status-cell-width`), the endcap `label`, the **value** content, and the
**popover** content. The CONTEXT cell additionally carries the imperative
`contextPopoverRef` so `/context` can open it. The value content varies:

- **STATE** — phase title flanked by two `TugProgressIndicator` pulsing-dot glyphs.
- **TIME / TOKENS** — a single live `dev-telemetry-status-value`.
- **CONTEXT** — a colored numerator + muted denominator keyed on `data-context-threshold`.
- **TASKS** — a `TugProgressIndicator` with an `N/M` label; `data-empty` when no tasks.

`TugPopoverTrigger` defaults to `asChild` and composes its toggle + the
trigger-element capture onto the child — so composing it onto a real `<button>`
(rather than a `<span>`) is the normal, supported case and needs no popover changes.

**Selectors under test.** `at0084-dev-lifecycle-coordination.test.ts` queries
`[data-slot="dev-telemetry-status-row"]` and
`[data-priority="state"] .dev-telemetry-status-value`. These DOM contracts MUST
survive the extraction byte-for-byte.

### Strategy {#strategy}

Lift the repeated trigger shape into a single **button-rooted** `TugStatusCell`
component that owns: the `data-priority` cell box, the endcap-rule label apparatus,
the value slot (`children`), and the full `TugPopover` wiring (content via prop,
optional imperative `popoverRef`). `DevTelemetryStatusRow` collapses to a thin map of
five `<TugStatusCell>` instances — each supplying its `priority`, `label`, value
children, and `popover`. The cell's scoped CSS moves with it; the row keeps only its
flex-layout rules.

The cell's `<button>` is **`tabIndex={-1}` and focus-refusing** in this plan, so the
extraction adds no native Tab stops and changes no focus behavior. The follow-on
`#step-z2-cycle` turns the row into an item-group cycle stop — at which point the
already-`<button>` cells are rove targets (`useItemGroupKeyboard` projects
`data-key-cursor`; Space/Enter → the group's `onSelect` clicks the cell button, which
toggles its popover). That step needs no further surgery on the cell.

### Success Criteria {#success-criteria}

1. `TugStatusCell` exists as a button-rooted component with co-located scoped CSS,
   composing `TugPopover`/`TugPopoverTrigger`/`TugPopoverContent`.
2. `DevTelemetryStatusRow` renders five `TugStatusCell`s; no bespoke
   `dev-telemetry-status-cell` `<span>` markup remains in the renderers file.
3. The row renders **pixel-identically** by-eye in both themes (brio + harmony).
4. All DOM selectors `at0084` depends on still resolve; `at0084` is green.
5. `/context` still opens the CONTEXT popover (imperative ref preserved).
6. `bunx tsc --noEmit` clean; warnings-are-errors satisfied.

### Scope {#scope}

- New: `tug-status-cell.tsx` + `tug-status-cell.css` (component tier, `tugways/`).
- Edit: `dev-card-telemetry-renderers.tsx` (migrate the row), `dev-card-telemetry-renderers.css` (remove the lifted cell rules; keep row layout).

### Non-goals {#non-goals}

- **No focus/keyboard wiring.** No `focusGroup`, no `useItemGroupKeyboard`, no
  `CycleScope`, no ring CSS — all of that is `#step-z2-cycle`.
- **No visual redesign.** Not a restyle; appearance is preserved exactly.
- **No popover-content changes.** The `*PopoverContent` factories are untouched.
- **No data/derivation changes.** The store reads, `computeRichContextBreakdown`,
  `deriveTimeCellMs`, task counting, the live tick — all unchanged.

### Dependencies {#dependencies}

None blocking. `TugPopover` already supports `asChild` triggers and an imperative
handle; no primitive changes are required.

### Constraints {#constraints}

- Tuglaws: [L02] store reads via `useSyncExternalStore` (unchanged — they stay in the
  row, not the cell), [L06] appearance via CSS/DOM not React state, [L19]
  component-authoring file pair (`.tsx` + `.css`, `data-slot`), [L20] token
  sovereignty (cell owns its width/anchor/endcap/value scope; row keeps layout),
  [L16] every color rule sets both `color` + `background-color` or carries
  `@tug-renders-on`.
- No plan-step numbers in code/comments/commits.
- HMR is live for tugdeck; no manual builds for the component edits. `at0084` is a
  real-app test → `just app-test` (needs the built app).

### Assumptions {#assumptions}

- `at0084` is the only app-test asserting on Z2 cell markup (confirmed by grep:
  `data-priority` / `dev-telemetry-status-row` / `dev-telemetry-status-value` appear
  only there under `tests/app-test/`).
- The placement-experiment harness (`dev-card-placement-experiment.tsx`) consumes
  `DevTelemetryStatusRow` as a whole and threads `onScrollToRow` + `statusRowRef`; it
  does not reach inside individual cells, so it needs no change.

## Open Questions {#open-questions}

- **[Q01] — Does the endcap-rule label apparatus become its own export, or stay
  private to the cell?** *Resolved:* keep it **private to `tug-status-cell.tsx`**
  (renamed `TugStatusCellLabel`). It is meaningless outside the cell, has no other
  consumer, and exporting it would invite drift. If a second consumer ever appears,
  promote it then.

- **[Q02] — Should the cell own the `<TugPopover>` root, or should the row keep the
  popover and pass only the trigger button down?** *Resolved:* the **cell owns the
  full popover** (root + trigger + content), accepting the content as a `popover`
  node prop and an optional `popoverRef` for imperative open. This is what makes the
  row a thin map and keeps the cell self-describing. The row already builds each
  popover's content element; it just hands the node to the cell.

## Risks {#risks}

- **[R01] — Width-stability regression.** The per-cell static width
  (`--tugx-dev-status-cell-width`, keyed on `data-priority`) is what keeps live
  values from jittering the row. If the token slot or the `data-priority` value is
  dropped in the move, cells will resize as values tick. *Mitigation:* the cell sets
  `data-priority` on its root and the width rules move verbatim into
  `tug-status-cell.css`; by-eye check during a live turn.

- **[R02] — Lost DOM contract breaks `at0084`.** The button root must still carry
  `dev-telemetry-status-cell` + `data-priority`, the value must keep
  `dev-telemetry-status-value`, and the row keep `data-slot="dev-telemetry-status-row"`.
  *Mitigation:* preserve all four class/attribute hooks; run `at0084` at the
  checkpoint.

- **[R03] — A `<button>` introduces a native Tab stop / focus steal.** *Mitigation:*
  render `tabIndex={-1}` + `data-tug-focus="refuse"` on the cell button so it is not
  a native Tab stop and does not steal the responder chain on click — identical to
  how `TugButton` handles the no-steal axis. The popover still opens on pointer click.

- **[R04] — `:hover` affordance / button reset.** The cell was a `<span>` with a
  hand-rolled hover tint (`.dev-telemetry-status-anchor:hover`). A `<button>` carries
  UA defaults (background, border, font inheritance). *Mitigation:* the cell CSS
  resets the button to `appearance:none; background:transparent; border:0;
  font:inherit; color:inherit` and re-applies the existing anchor hover rule.

## Design Decisions {#design-decisions}

### [P01] Primitive: a dedicated `TugStatusCell`, not a `TugPushButton` variant {#p01}

The cell is "a focusable control that opens a surface on activate" — superficially the
Z4B-chip interaction. But `TugPushButton`/`TugButton` is the **wrong** primitive here,
for three grounded reasons:

1. **Structure.** `TugButton`'s two-line `label-top` layout renders `label` inside
   `.tug-button-label` with its own uppercase letterspaced typography and renders
   `children` inside `.tug-button-content`. The cell's "label" is the
   `DevTelemetryEndcapRuleLabel` *apparatus* (hairline rule + endcap ticks +
   letterspaced label), and its value row carries bespoke sub-layouts (flanking
   pulsing-dot indicators for STATE; threshold-split numerator/denominator for
   CONTEXT; a `TugProgressIndicator` for TASKS). Forcing these through the button's
   label/content slots fights the button's CSS rather than reusing it.

2. **Focus model (the whole point).** `#step-z2-cycle` makes the row an **item-group**
   stop (one Tab stop; arrows rove a `data-key-cursor`; a single **blue/default**
   ring on the roved cell). `TugButton` registers as a **leaf** focusable with a
   **role-colored** ring. The mechanisms are different — an item-group is
   `useItemGroupKeyboard` over child items, not five leaf buttons — so even the focus
   axis argues against the chip primitive.

3. **Width model.** The chips stabilize width via `TugButton`'s `widthStabilize`
   overlay; the cells stabilize via the `--tugx-dev-status-cell-width` token keyed on
   `data-priority`. Keeping the existing token mechanism is faithful and avoids a
   second width system in the row.

`TugStatusCell` is a thin, button-rooted component that composes `TugPopover` and
co-locates the endcap apparatus + value slot. It is **button-rooted** (not a span) so
keyboard activation and the ring come for free in `#step-z2-cycle`.

### [P02] The cell owns the full popover; the row supplies the content node {#p02}

`TugStatusCell` renders `<TugPopover><TugPopoverTrigger><button…/></TugPopoverTrigger>
<TugPopoverContent side="top" align="center" sideOffset={8} arrow>{popover}
</TugPopoverContent></TugPopover>`. It accepts the popover content as a `popover` prop
and forwards an optional `popoverRef` to the `TugPopover` root (CONTEXT's `/context`
open). Resolves [Q02].

### [P03] Button is `tabIndex={-1}` + focus-refusing in this plan {#p03}

So the extraction introduces **no** native Tab stop and **no** behavior change.
`#step-z2-cycle` owns all focus wiring; the cells are rove targets there, reached via
the item-group cursor (key-view, not DOM focus). Mitigates [R03].

### [P04] Preserve every DOM contract `at0084` reads {#p04}

Root keeps `class="dev-telemetry-status-cell dev-telemetry-status-anchor"` +
`data-priority`; the value keeps `dev-telemetry-status-value` (and CONTEXT's
`data-context-threshold`, TASKS' `data-empty`); the row keeps
`data-slot="dev-telemetry-status-row"`. Mitigates [R02].

### [P05] Token sovereignty: cell CSS moves, row CSS stays layout-only {#p05}

The `.dev-telemetry-status-cell*`, `.dev-telemetry-status-anchor*`,
`.dev-telemetry-status-value*`, and `.dev-telemetry-endcap-*` rules move into
`tug-status-cell.css` (including the `data-priority` width overrides and the
`@container dev-status` collapse rules that hide whole cells). `dev-card-telemetry-renderers.css`
keeps only `.dev-telemetry-status-row` (the flex row) and the unrelated
`.dev-telemetry-window-utilization` block. [L20].

## State Zone Mapping {#state-zones}

| State | Where it lives now | Zone | After |
|-------|--------------------|------|-------|
| Cell hover affordance | `.dev-telemetry-status-anchor:hover` (CSS) | appearance ([L06]) | unchanged — moves to `tug-status-cell.css` |
| Cell static width | `--tugx-dev-status-cell-width` per `data-priority` (CSS) | appearance ([L06]/[L20]) | unchanged — moves with the cell |
| Container-collapse | `@container dev-status` (CSS) | appearance ([L06]) | unchanged — moves with the cell |
| Popover open/closed | `TugPopover` internal state | local data (component-owned) | unchanged — now owned per-cell |
| `/context` imperative open | `contextPopoverRef` → `TugPopoverHandle` | local data (ref) | unchanged — threaded through the cell's `popoverRef` |
| All telemetry values | `useSyncExternalStore` in `DevTelemetryStatusRow` | structure/data ([L02]) | unchanged — stay in the row, passed as children |
| Focus / cursor / ring | — (none today) | — | **out of scope** — added in `#step-z2-cycle` |

No new React state is introduced. The cell is appearance + a composed popover; it
holds no store subscription of its own.

## Test Plan Concepts {#test-plan}

- **Real-app (`just app-test`):** `at0084-dev-lifecycle-coordination.test.ts` is the
  regression guard — it asserts the row's `data-slot` and the STATE cell's
  `data-priority` + `dev-telemetry-status-value`. Keep it green; do not rewrite it.
- **By-eye, both themes:** the row must read identically (widths, hover tint, endcap
  apparatus, STATE flanking dots, CONTEXT threshold color, TASKS indicator) in brio
  and harmony, including during a live turn (width stability).
- **No new fake-DOM / RTL / mock-store tests.** A component-render unit test is
  banned in this codebase; the by-eye + `at0084` path is the contract. (If a pure
  formatting helper were extracted it could carry a `bun:test` — none is in scope.)
- `bunx tsc --noEmit` clean.

## Execution Steps {#execution-steps}

### Step Status Ledger {#ledger}

| Step | Title | Status | Commit |
|------|-------|--------|--------|
| #step-extract-cell | Author `TugStatusCell` + co-located CSS | done | dash ea02a783 → squashed to main |
| #step-migrate-row | Migrate `DevTelemetryStatusRow`; relocate CSS | done | dash 603be61b → squashed to main |

---

### Step: Author `TugStatusCell` {#step-extract-cell}

**Commit:** `feat(devcard): add TugStatusCell status-row primitive`

**References:** [P01], [P02], [P03], [P04], [P05], [R03], [R04]

**Depends on:** —

**Tasks:**
- Create `tugdeck/src/components/tugways/tug-status-cell.tsx`:
  - Props: `priority: string` (→ `data-priority`), `label: string`,
    `ticksDirection?: "down" | "up"` (default `"down"`), `popover: React.ReactNode`,
    `popoverRef?: React.Ref<TugPopoverHandle>`, `children` (the value content),
    plus pass-through `data-*`/`aria-label`/`title`.
  - Render `<TugPopover ref={popoverRef}><TugPopoverTrigger><button type="button"
    tabIndex={-1} data-tug-focus="refuse"
    className="dev-telemetry-status-cell dev-telemetry-status-anchor"
    data-priority={priority}> <TugStatusCellLabel label={label}
    ticksDirection={…}/> <span className="dev-telemetry-status-value-wrap">{children}
    </span> </button></TugPopoverTrigger><TugPopoverContent side="top" align="center"
    sideOffset={8} arrow>{popover}</TugPopoverContent></TugPopover>`.
  - Move `DevTelemetryEndcapRuleLabel` in as the private `TugStatusCellLabel`
    ([Q01]); keep its markup + `aria-hidden` exactly.
- Create `tugdeck/src/components/tugways/tug-status-cell.css`:
  - Lift, verbatim, the `.dev-telemetry-status-cell*` (incl. `data-priority` width
    overrides), `.dev-telemetry-status-value*`, `.dev-telemetry-status-anchor*`,
    `.dev-telemetry-endcap-*`, and the `@container dev-status` collapse rules from
    `dev-card-telemetry-renderers.css`.
  - Add the `<button>` reset on `.dev-telemetry-status-cell` (`appearance:none;
    background:transparent; border:0; margin:0; font:inherit; color:inherit;
    text-align:inherit`) so the element reads exactly as the old `<span>` ([R04]).
  - Keep the `value-wrap` / endcap shared-width relationship via
    `--tugx-dev-status-cell-width` ([R01]/[P05]).
- File-pair conformance ([L19]): `data-slot` on the cell root; `.tsx` imports its
  `.css`; honor [L16] on every color rule moved.

**Checkpoint:** `bunx tsc --noEmit` clean; `tug-status-cell.tsx` exports
`TugStatusCell`; the lifted CSS compiles (HMR repaints with no console error). The
component is not yet consumed — `#step-migrate-row` proves it in place.

---

### Step: Migrate `DevTelemetryStatusRow` to `TugStatusCell` {#step-migrate-row}

**Commit:** `feat(devcard): render Z2 status row via TugStatusCell`

**References:** [P02], [P04], [P05], [R01], [R02]

**Depends on:** #step-extract-cell

**Tasks:**
- In `dev-card-telemetry-renderers.tsx`, replace each of the five bespoke
  `<TugPopover>…<span class="dev-telemetry-status-cell">…</span>…</TugPopover>` blocks
  with a `<TugStatusCell priority=… label=… popover={…}>…value…</TugStatusCell>`:
  - **STATE** — children: the two flanking `TugProgressIndicator`s + the phase title
    span (unchanged markup); `popover={statePopover}`.
  - **TIME / TOKENS** — children: the `dev-telemetry-status-value` span;
    `popover={timePopover}` / `{tokensPopover}`.
  - **CONTEXT** — children: the threshold-split numerator/denominator (keep
    `data-context-threshold`); `popover={contextPopover}`,
    `popoverRef={contextPopoverRef}` ([P02]).
  - **TASKS** — children: the `TugProgressIndicator` + `data-empty` wrap;
    `popover={tasksPopover}`.
- Remove the now-private `DevTelemetryEndcapRuleLabel` from the renderers file (it
  moved to the cell) and drop the now-unused `TugPopover*` imports if no longer
  referenced.
- Keep the row wrapper `<div className="dev-telemetry-status-row"
  data-slot="dev-telemetry-status-row">` unchanged ([P04]).
- In `dev-card-telemetry-renderers.css`, delete the rules lifted in
  `#step-extract-cell`; keep `.dev-telemetry-status-row` and
  `.dev-telemetry-window-utilization`. Fix any rule the move orphans ([L20]).
- The `forwardRef` `openContextPopover()` still drives `contextPopoverRef` (now passed
  to the cell) — verify `/context` opens the CONTEXT popover.

**Tests:**
- `just app-test at0084-dev-lifecycle-coordination` → green (selectors preserved).
- By-eye, brio + harmony: row identical; live-turn width stability; hover tint;
  endcap apparatus; STATE dots; CONTEXT threshold color; TASKS indicator.

**Checkpoint:** `bunx tsc --noEmit` clean; `at0084` green
(`tail -n 1` → `VERDICT: PASS`); no `dev-telemetry-status-cell` `<span>` remains in
the renderers file; `/context` opens the CONTEXT popover; by-eye row unchanged in both
themes.

## Deliverables {#deliverables}

- `tugdeck/src/components/tugways/tug-status-cell.tsx` — new button-rooted cell
  component (+ private `TugStatusCellLabel`).
- `tugdeck/src/components/tugways/tug-status-cell.css` — the cell's scoped styling
  (lifted + button reset).
- `dev-card-telemetry-renderers.tsx` — row rebuilt as five `TugStatusCell`s.
- `dev-card-telemetry-renderers.css` — cell rules removed; row layout retained.
- A green `at0084`, a clean `tsc`, and a row that reads identically — leaving
  `#step-z2-cycle` a trivial "author the row into the cycle."
