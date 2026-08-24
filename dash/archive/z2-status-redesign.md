<!-- devise-skeleton v4 -->

## Z2 Status Redesign — Configurable Row + Shelf {#z2-status-redesign}

**Purpose:** Productionize the `gallery-z2-workshop` design spike: the Z2 status row
becomes a user-configurable instrument row (macOS-toolbar grammar), a height-stable
pinned **shelf** of TASKS / JOBS / PULSE lanes opens beneath it, and PULSE surfaces
exactly once across its three possible homes — all persisted through tugbank.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | in progress |
| Target branch | main |
| Last updated | 2026-06-27 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Z2 status row ships today as a fixed six-cell instrument row (STATE, TIME,
TOKENS, CONTEXT, TASKS, JOBS — `DevTelemetryStatusRow` over `TugStatusCell`),
CycleScope'd inside `dev-card.tsx`'s status-bar block with no trailing chrome (the
Z2 maximize toggle, its `maximized` state, and `data-maximized` were removed Jun 23
in `1bdae0b79`). The
`gallery-z2-workshop` spike settled, over four review rounds, a richer design: the
row's items become configurable (drag to add/remove/reorder, with SPACE / FLEX SPACE
spacers and a flexible PULSE item); a chevron at the row's end opens a pinned shelf
of up to three lanes (TASKS, JOBS, PULSE) that steals fixed height from the
transcript; a gear opens an in-place configurator (Finder "Customize Toolbar…"
translated — the live surface IS the editor, with palettes directly beneath each
section); and chrome is introduced (gear inboard right, chevron at the very end,
with a balancing lead spacer to keep the cells centered — maximize is **not**
resurrected by this plan).

This plan carries that design into the production dev card. It follows the PULSE
plan (`dash/archive/pulse.md`, since shipped — its data path subsequently
rebuilt by `dash/archive/pulse-2.md`, "Watch the Wire"), which ships the
`pulse-store`, the `dev-pulse-strip` component, and the `pulse/enabled` toggle
this plan's PULSE row item, PULSE lane, and strip-suppression rule all consume —
and which explicitly deferred Shelf/Rack productionization here (its [Q03] and
non-goals). PULSE 2 left the store/hook surface this plan reads (`usePulse`,
`PulseSnapshot`) unchanged.

#### Strategy {#strategy}

- **Config first, then consumers.** One validated, tugbank-persisted config object
  (row order, lane arrangement, shelf disposition) lands first as a pure-logic
  module; every surface reads it through the established `useTugbankValue` path.
- **Refactor the row in place, prove zero drift.** `DevTelemetryStatusRow` keeps its
  name, cells, popovers, and focus contract; it changes from a hardcoded six-cell
  JSX block to a registry rendered in configured order. The default config must
  render the row pixel-identical before anything new ships.
- **Extract the status area as one component.** The row chrome, the PULSE strip slot,
  the shelf, and the configurator compose into `DevCardStatusArea`, replacing the
  status-bar block inline in `dev-card.tsx`. The card body keeps no extracted state —
  the bar today is a bare CycleScope'd Z2 slot (the maximize toggle that once lived
  here is gone), so the swap is a clean lift.
- **Spike code is the reference implementation.** The drag grammar (ghost, caret,
  dim), shelf geometry, lane focus affordance, and single-surface rule port from
  `gallery-z2-workshop.tsx/.css` with production data swapped in; the card itself
  stays untouched as the design record.
- **Height stability is a contract, not a vibe.** The open shelf never changes
  height with data; every configurator surface is fixed-height; the suppressed strip
  keeps its slot while customizing.

#### Success Criteria (Measurable) {#success-criteria}

- With no stored config, the Z2 row renders the same six cells, widths, popovers,
  and focus cycle as before this plan — verified by visual walk + the existing cell
  popovers + Tab cycle. (Live walk; `bunx tsc --noEmit`; `bun test`.)
- Dragging an item out of / into / within the row updates the live row immediately
  and survives a hard reload (config re-read from tugbank DEFAULTS push). (Live walk.)
- The chevron opens a shelf whose height never changes while open — 5 data rows per
  lane + legend + footer — regardless of task/job/pulse counts; lane focus
  expand/contract works with ≥2 lanes. (Live walk; CSS fixed-height inspection.)
- PULSE renders in exactly one place at any moment: row item, else open-shelf lane,
  else the strip; disabling `pulse/enabled` blanks all three to their off states.
  (Live walk through all three homes; pure-logic test on the resolver.)
- Overflow counts in the shelf footer open the corresponding TASKS / JOBS popover
  with full controls; the PULSE count is inert. (Live walk.)
- Restore Defaults returns row + lanes + shelf to the shipped defaults and persists
  that. (Live walk + reload.)
- `bunx tsc --noEmit`, `bun test`, and the app-test sweep green at every step
  boundary.

#### Scope {#scope}

1. `status-area-config` module: schema, defaults, validation, tugbank persistence
   (domain `dev.tugtool.deck.status-area`), read hook + write helper.
2. `DevTelemetryStatusRow` refactor: cell registry, config-ordered rendering,
   SPACE / FLEX SPACE spacer cells, the PULSE row cell (flexible width, live
   `pulse-store` line, dimmed-off when disabled), config-derived focus orders.
3. `DevCardStatusArea`: extracted Z2 composite — chrome (lead spacer balancing gear
   inboard right + chevron at end), strip slot with the single-surface
   suppression rule, shelf + configurator mounts; `dev-card.tsx` swap.
4. `DevCardStatusShelf`: height-stable lanes (TASKS / JOBS / PULSE), lane focus
   affordance, sixth footer row with clickable overflow counts.
5. The in-place configurator: customize mode, per-section palettes, drag visuals
   (ghost / caret / source-dim), lane editing in the shelf, config footer.
6. `tuglaws/design-decisions.md` entry.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Any change to the PULSE pipeline itself (daemon, facts, ledger, store) — this plan
  is purely a consumer of what `dash/archive/pulse.md` (+ `pulse-2.md`) ships.
- Per-card scope filtering of the PULSE lane/strip — carried from pulse [Q03],
  deferred again here with rationale ([Q02]).
- New row datums beyond the spike vocabulary (cost, TTFT, etc.) — the registry makes
  them cheap later; none ship now.
- Reworking the `tugDevPlacement` dev harness — it keeps working; `statusRow`
  remains the default Z2 datum and now resolves to the configurable row.
- Maintaining `gallery-z2-workshop` in lockstep — the card remains as the design
  record; no changes to it are required by this plan.
- Touch/pointer-event drag fallbacks — HTML5 dnd only, as spiked (it runs in the
  app's WKWebView today).

#### Dependencies / Prerequisites {#dependencies}

- **PULSE shipped** (`dash/archive/pulse.md` + `pulse-2.md`) — `pulse-store.ts`
  (`PulseSnapshot { enabled, status, lines, latest, cleared }`, read via the
  `usePulse()` `useSyncExternalStore` hook; the snapshot's `latest` field is the
  newest line directly, and `latestLineForScope(lines, scope, clearedKeys?)`
  resolves the newest line for a scope honoring the per-scope `cleared` map; cap
  `PULSE_LINES_CAP`), `dev-pulse-strip.tsx/.css`, and the `pulse/enabled` tugbank
  default (`PULSE_ENABLED_DOMAIN`/`KEY`). The PULSE row cell, PULSE lane, and strip
  suppression all read these; the row cell / lane key their off-state on `enabled`
  (the `status`/`cleared` fields are additive and need no special handling in v1).
- The jobs ledger + monitors work (shipped on main): `useJobsState`, `countJobs`,
  `jobsCellPose`, the JOBS popover.
- The task list machinery: `useTaskListState`, `countTasks`, the TASKS popover.
- Tugbank deck plumbing: `useTugbankValue`, `getTugbankClient().setLocalValue` + PUT
  (the placement-experiment write pattern in `dev-card-placement-experiment.tsx`).
- The spike: `gallery-z2-workshop.tsx/.css` (reference implementation for drag
  grammar, shelf geometry, configurator layout).

#### Constraints {#constraints}

- bun only; tugdeck is HMR (no manual builds). No localStorage-family storage —
  config lives in tugbank ([P01]).
- Tuglaws: [L02] external state via `useSyncExternalStore`; [L06] appearance via
  CSS/DOM; [L16] color-rule pairing; [L19] `.tsx`/`.css` pairs with `data-slot`;
  [L20] token sovereignty; [L26] mount identity. No fake-DOM / mock-store tests.
- Labels stay on — there is no "value only" display mode (user-decided in the
  spike rounds; the configurator hint states it).
- Buttons with state-dependent content reserve the wider state's width; icons beside
  multi-line text align with the top text row.

#### Assumptions {#assumptions}

- HTML5 drag-and-drop (setDragImage ghost, dragover/drop) behaves in the Tug.app
  WKWebView as it did during the spike rounds (the workshop card already exercises
  the identical code paths in-app).
- The existing per-priority `@container` collapse rungs remain acceptable for
  non-default row configurations in v1 ([P10]).
- One app-global config is the right scope — all dev cards share the same Z2
  arrangement, like a macOS app's toolbar config ([P01]).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] PULSE history surface (DEFERRED) {#q01-pulse-history}

**Question:** Should clicking the PULSE lane's overflow count (or the strip/cell)
open a pulse-history popover, the way TASKS/JOBS counts open theirs?

**Why it matters:** Symmetry in the footer; but pulse lines are ambient commentary,
not actionable items, and no popover content component exists for them.

**Resolution:** DEFERRED — the PULSE overflow count renders as inert text in v1
([P07]). If history-on-demand earns its keep, it's a small follow-on (a popover over
the pulse-store tail) requiring no architecture change.

#### [Q02] Per-card scope filtering of PULSE surfaces (DEFERRED) {#q02-scope-filtering}

**Question:** Should a card's PULSE lane/strip filter to the card's own session
scope? (Carried from `dash/archive/pulse.md` [Q03], which deferred it to this
plan; PULSE 2 added the scope-union plumbing that makes this a pure display knob.)

**Why it matters:** With multiple live cards, an app-wide feed narrates other cards'
work into every card's shelf.

**Resolution:** DEFERRED again, deliberately — v1 shows the app-wide feed in all
three homes, consistent with the pulse plan's strip. Every pulse line already
carries `scope`, so filtering is a pure display knob; building it before real
multi-card usage shows the need would be speculative. Revisit when multi-card
sessions are routine.

#### [Q03] Shelf open/close animation (DECIDED — none in v1) {#q03-shelf-animation}

**Question:** Does the shelf animate open/closed?

**Resolution:** DECIDED — no animation in v1; the shelf mounts/unmounts at its fixed
height on chevron toggle ([P05]). A height transition is a CSS-only refinement that
can land later without structural change.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Row refactor regresses cell popovers / focus cycle | med | low | Registry preserves each cell's JSX verbatim; default-config render proven identical before new items ship (#step-2 checkpoint) | Any popover/focus diff in the live walk |
| Config-driven rows fight the static collapse rungs | low | med | Keep rungs as-is ([P10]); flexible PULSE cell ellipsizes; configurator hint nudges restraint | A configured row that clips at common widths |
| HTML5 dnd quirks in WKWebView | med | low | The spike card already runs the identical dnd code in-app; verify the production surfaces in Tug.app at #step-5's checkpoint | Ghost/caret misbehavior in the app build |
| New chrome breaks cell centering | low | med | Spec S02 pins the balance rule (left flank = lead spacer; right flank = gear + chevron, matched widths) | Visible off-center drift |

**Risk R01: Stored config drifts from the vocabulary** {#r01-config-drift}

- **Risk:** A stored config references an item/lane a future build renames or
  removes, or holds malformed JSON.
- **Mitigation:** `parseStatusAreaConfig` drops unknown ids, dedupes non-repeatable
  items, caps lanes at 3, and falls back field-wise to defaults; a `version` field
  reserves room for future migration. Pure-logic tests pin every salvage path.
- **Residual risk:** A renamed id silently reverts that item to "not configured" —
  acceptable; Restore Defaults always recovers.

---

### Design Decisions {#design-decisions}

#### [P01] One app-global config object, tugbank-persisted (DECIDED) {#p01-config-object}

**Decision:** The entire status-area arrangement persists as one `kind:"json"`
tugbank value — domain `dev.tugtool.deck.status-area`, key `config` — holding
`{ version, row, lanes, shelfOpen }` (Spec S01). It is app-global: every dev card
shares the one arrangement.

**Rationale:**
- The placement experiment already proved the exact mechanism: `useTugbankValue`
  read (reference-stable parse cache, [L02]) + `setLocalValue` optimistic write +
  PUT to `/api/defaults/<domain>/<key>`. No new plumbing.
- macOS toolbar configuration is per-app, not per-window — the spike's stated model.
- One object keeps row/lanes/shelf mutually consistent (a single Restore Defaults,
  a single parse).

**Implications:**
- New `status-area-config.ts` module owns the schema, defaults, validation, hook,
  and write helper; everything else imports from it.
- `shelfOpen` is persisted disposition — pinning the shelf survives reload. And it
  is app-global like the rest of the object: toggling the chevron on one card opens
  the shelf on every dev card (macOS-toolbar conduct) — intended behavior, not a
  bug to file later.
- Writes are live-per-mutation (each drop/removal persists immediately, like the
  placement experiment); Done only exits customize mode.

#### [P02] The row stays `DevTelemetryStatusRow`, rendered from a cell registry (DECIDED) {#p02-cell-registry}

**Decision:** `DevTelemetryStatusRow` is refactored, not replaced: a module-level
registry maps each `StatusRowItemId` to its cell renderer, and the component maps
the configured `row` array over it. The item vocabulary is the spike's: `state`,
`time`, `tokens`, `context`, `tasks`, `jobs`, `pulse`, `space`, `flex` — spacers
repeatable, everything else one-shot, `pulse` and `flex` flexible-width.

**Rationale:**
- The six existing cells (data wiring, popovers, widths, `data-priority`) are
  proven; the refactor moves JSX into registry entries verbatim instead of
  rewriting it.
- A registry makes future datums additive (one entry), honoring the placement
  experiment's "renderers are placement-agnostic" doctrine.

**Implications:**
- Default config renders byte-identical DOM to today's row — the #step-2 gate.
- The PULSE cell is new: flexible width (`flex: 1 1 auto`, min-width, ellipsis —
  the one deviation from fixed-width cell grammar), value = the pulse-store
  snapshot's `latest` line, no popover in v1 ([Q01]); when `pulse/enabled` is false it renders
  a dimmed "off" placeholder rather than vanishing (config stays WYSIWYG).
- SPACE renders a fixed-gap cell, FLEX SPACE a flexing one; both render a quiet
  glyph only while customizing (invisible spacers otherwise).
- Focus orders derive from the configured order (`focusOrderBase + index over
  non-spacer items`); spacer cells are never focus stops. The `/context` imperative
  handle no-ops when no `context` cell is configured (null ref — already the
  handle's contract).

#### [P03] Extract `DevCardStatusArea` as the one Z2 composite (DECIDED) {#p03-status-area-component}

**Decision:** A new `dev-card-status-area.tsx/.css` owns the whole Z2 area: the
status-bar row (a balancing lead spacer at the LEFT end, the Z2 content in a
`CycleScope`, the configure gear inboard right, the shelf chevron at the very
end — Spec S02), the
PULSE strip slot with the single-surface rule ([P04]), the shelf ([P05]), and the
customize mode ([P08]). `dev-card.tsx` replaces its inline status-bar block (today a
bare `CycleScope`'d main, no maximize) with this component, passing
the resolved Z2 content node, the stores, and the cycle scope.

**Rationale:**
- `dev-card.tsx` is already ~3550 lines; the status area is a coherent [L19]
  component with its own CSS scope.
- The shelf must be a flex sibling *below* the bar inside `dev-card-top-column`
  (`dev-card-top-column` is `flex: 1 1 0` and the transcript host inside it is
  `flex: 1 1 auto`, so a content-sized shelf steals height from the transcript for
  free — the exact mechanism the spike documents, with `--dev-transcript-min` the
  floor). One component owns that sibling group.
- The pulse plan mounts `dev-pulse-strip` under the status row in `dev-card.tsx`;
  this plan relocates that mount inside the status area so the suppression rule
  ([P04]) computes next to its inputs.

**Implications:**
- The area introduces no session-only appearance state of its own (the maximize
  toggle that once justified one is gone); only the local `customizing` mode below.
- Customize state (`customizing`) lives in `DevCardStatusArea` (local structural
  mode, `useState`). It reaches the row — whose node is *created by the placement
  harness* (`useDevPlacementSlots` → `sessionNode("statusRow")`) and arrives as a
  finished `statusBarContent` ReactNode, so props cannot reach it — through the
  tolerant `StatusAreaCustomizeContext` bridge (Spec S06).
- When the dev-only placement harness puts a non-`statusRow` datum in Z2, the gear
  and chevron still render and configure the (hidden) row — an accepted dev-only
  quirk, documented in the component docstring.

#### [P04] PULSE single-surface rule (DECIDED) {#p04-single-surface}

**Decision:** PULSE renders in exactly one place, by priority: configured row item →
PULSE lane in the *open* shelf → the ambient strip. The strip is the fallback, never
a duplicate. While customizing, the strip's slot stays mounted at fixed height with
a placeholder note when suppressed ("in the status row — the strip stands down" /
"pinned on the shelf — the strip stands down"), so moving PULSE between homes never
shifts the configurator. With `pulse/enabled` false: the strip hides (pulse plan
behavior), and the row cell / lane render dimmed off-placeholders.

**Rationale:** Settled in the spike rounds — duplication reads as a bug; the
closed-shelf case must fall back to the strip so commentary is never silently lost.

**Implications:** A pure resolver — `resolvePulseSurface(config, shelfOpen,
customizing, pulseEnabled)` → `"row" | "shelf" | "strip" | "none"` — lives in
`status-area-config.ts` and is unit-tested exhaustively; the components just render
its answer.

#### [P05] Shelf geometry: fixed 5-row lanes + legend + footer (DECIDED) {#p05-shelf-geometry}

**Decision:** The open shelf is a fixed-height band: each lane shows a legend row
plus exactly `SHELF_LANE_ROWS = 5` data-row slots (uniform row height; empty slots
stay reserved), and a sixth full-width footer row carries overflow counts +
controls ([P07]). Up to 3 lanes side by side. The shelf mounts when open (chevron
or customize), unmounts when closed; no animation ([Q03]). Lane data: TASKS =
`useTaskListState` rows, JOBS = `useJobsState` rows (dot + description + kind/elapsed
meta), PULSE = the pulse-store tail's last 5 lines.

**Rationale:** Height stability was the user's first structural requirement
("must *always* be height-stable once configured"); the transcript-flex sibling
mechanism gives the height-steal for free.

**Implications:**
- Shelf height is a CSS calc over row-height constants — data volume never moves it.
- Lane focus (click a legend to expand one lane, others contract to a peek column;
  chevrons-apart / chevrons-together affordance; disabled under 2 lanes; paused
  while customizing) ports from the spike: local `useState` for the focused lane id
  driving `data-focus`, flex widths in CSS ([L06]). Focus resets when the shelf
  unmounts — acceptable.
- Overflow (rows beyond 5) is *counted* in the footer, never scrolled in the lane.

#### [P06] Drag grammar: the spike's HTML5-dnd port of the tab-bar visuals (DECIDED) {#p06-drag-grammar}

**Decision:** All four drag interactions (palette→row, row reorder, palette→shelf,
lane reorder) use the spike's *visual* grammar — a transient styled clone passed to
`setDragImage` (the tab bar's ghost, `.tug-tab-ghost` tokens), the drag source
dimmed via `data-dragging` + CSS opacity, an absolute 2px insertion caret gliding
via `transition: left` — with the *mechanism* corrected to the codebase's real
precedent: the caret is created and positioned by **direct DOM mutation** in the
dragover handler (the `updateInsertionIndicator` pattern in
`card-drag-coordinator.ts`), the drag payload rides `dataTransfer` (Spec S06), and
dragover/drop handlers are delegated on the area's containers. `startDragGhost` and
`computeInsertion` port from the spike unchanged; the spike's `useState` caret does
not — that was its one shortcut.

**Rationale:** Already designed, reviewed, and exercised in-app across the spike
rounds; visually consistent with the deck tab bar's established drag language —
whose actual implementation (`card-drag-coordinator.ts`) positions its ghost and
insertion indicator with imperative DOM writes and runs no React state in the
pointer loop. A `useState` caret would re-render the whole status area at
pointer-move frequency and strain [L06].

**Implications:** The caret element lives outside React — created on first dragover
over a container, moved by `style.left` writes, removed on dragleave / drop /
dragend; only the drop *commit* enters React, as a config write ([P01]).
`data-dragging` stays a render-driven attribute (one flip per drag start/end — the
same shape `data-focus` and other one-flip attrs use).

#### [P07] Shelf footer: clickable overflow counts, no separate buttons (DECIDED) {#p07-footer}

**Decision:** The sixth row shows per-lane overflow counts ("jobs +2") when a lane
holds more rows than its 5-slot budget. TASKS and JOBS counts are buttons — each is
its own `TugPopover` trigger reusing the existing `TasksPopoverContent` /
`JobsPopoverContent` (full list, stop/clear controls), anchored at the footer. The
PULSE count is inert text ([Q01]). No More… / Clear buttons — the popovers remain
the single control surface. The footer row is always present while the shelf is
open (height stability), rendering quiet whitespace when nothing overflows.

**Rationale:** User-decided (devise clarification). Anchoring fresh popover
instances at the footer — rather than imperatively opening the row cells' popovers
— keeps the footer working even when the corresponding cell isn't configured into
the row.

**Implications:** The popover content components get reused with a second anchor;
their props (`onStopJob`, `onClearJobs`, `onScrollToRow`) thread through the shelf.

#### [P08] In-place configurator, live writes (DECIDED) {#p08-configurator}

**Decision:** The gear toggles `customizing`. While customizing: the shelf is
forced open; row cells and shelf lanes grow grips + per-item `×` removal; each
section's palette renders as a fixed-height single-line strip directly beneath that
section (row palette under the row, lane palette under the shelf — no separate
schematic); a config footer carries the hint ("Labels stay on — bare values mostly
lose their meaning."), Restore Defaults, and Done. Every mutation persists
immediately ([P01]); Done exits the mode; Restore Defaults writes the shipped
defaults. Double-click on a palette chip appends (the spike's affordance).

**Rationale:** The "options directly under the sections they edit" structure was
the final spike round's explicit correction; live writes match both macOS toolbar
behavior and the placement-experiment precedent.

**Implications:** The zero-lane shelf state keeps the lane band's full height and
stays a drop target; the suppressed strip keeps its slot ([P04]); palettes show
"all placed" text when empty — every customize surface is height-stable. Row-side
edit affordances and removals reach the slot-rendered row through
`StatusAreaCustomizeContext`, and cross-component drops decode the `dataTransfer`
payload in the area's delegated handlers (Spec S06).

#### [P09] Focus + chrome conduct (DECIDED) {#p09-focus-chrome}

**Decision:** The configured cells join the card's focus cycle as consecutive leaf
stops from `focusOrderBase`, in configured order, spacers skipped ([P02]). The
gear and chevron buttons are chrome — `data-tug-focus`-conformant,
never cycle stops (the conduct the removed maximize button once modeled). The bar
keeps cells centered: the left flank (a button-width lead spacer) balances the right
flank (gear + chevron) per Spec S02.

**Rationale:** The existing leaf-stop cycle semantics (the "[P10] revised" cited in
the row's code comments — a *prior* plan's label, not this plan's [P10]) already
treat the cells as consecutive leaf stops; deriving orders from config is the
minimal generalization.
Chrome buttons staying off the cycle preserves the editor-first responder doctrine.

**Implications:** Reordering the row reorders Tab traversal to match left→right
visual order automatically — no per-cell order bookkeeping. Reordering also changes
each cell's `group:order` focus-restoration key (`data-tug-focus-key`) — expected
conduct, not a defect; a restore against a stale key simply falls back to the
default seed.

#### [P10] Container-collapse rungs stay static in v1 (DECIDED) {#p10-collapse-rungs}

**Decision:** The existing per-priority `@container dev-status` rungs (TIME 460px →
TOKENS 290px → TASKS 230px → JOBS 180px) are kept untouched. New cells: the PULSE
cell shrinks/ellipsizes (flexible) rather than hiding; spacers collapse naturally.
No config-aware rung computation ships.

**Rationale:** The rungs are per-cell and independent — each hides its cell at its
threshold whether or not the others are present. Config-aware thresholds would be
real complexity for a narrow-card edge the user can also solve by configuring a
shorter row.

**Implications:** A maximal custom row can crowd narrow cards; the flexible PULSE
cell absorbs most of it. Watch-item, revisit on evidence.

---

### Specification {#specification}

**Spec S01: Config schema + validation** {#s01-config-schema}

```jsonc
// tugbank: domain "dev.tugtool.deck.status-area", key "config", kind "json"
{
  "version": 1,
  "row":   ["state", "time", "tokens", "context", "tasks", "jobs"],  // default
  "lanes": ["tasks", "jobs", "pulse"],                                // default; max 3
  "shelfOpen": false                                                  // default
}
```

Types: `StatusRowItemId = "state" | "time" | "tokens" | "context" | "tasks" |
"jobs" | "pulse" | "space" | "flex"`; `ShelfLaneId = "tasks" | "jobs" | "pulse"`.
`parseStatusAreaConfig(entry: TaggedValue | undefined): StatusAreaConfig` salvages
field-wise: unknown ids dropped; non-repeatable duplicates dropped (first wins;
`space`/`flex` repeat freely); lanes deduped and capped at 3; missing/malformed
fields → that field's default; `undefined` entry → full defaults. The parse is
total — it never throws.

**Spec S02: Z2 bar chrome layout** {#s02-bar-chrome}

```
[spacerᵇ]  ····· configured cells, centered ·····  [Gear] [Chevron]
```

Left flank = a lead spacer sized to two button widths; right flank = gear +
chevron; equal flank widths keep the cell group centered. (Maximize no longer
exists — removed Jun 23 in `1bdae0b79` — so the lead spacer is the only thing
balancing the right flank now, not a maximize button.) Gear: lucide `Settings`,
`ghost` emphasis, `tinted` while customizing. Chevron: `ChevronDown` when open /
`ChevronUp` when closed, toggles `shelfOpen` (persisted). The bar retains
`data-tug-focus="refuse"`, the `CycleScope`, and the `:empty`-collapse behavior
for a null Z2 slot.

**Spec S03: Single-surface resolution** {#s03-single-surface}

```
resolvePulseSurface(config, shelfOpen, customizing, pulseEnabled):
  effectiveShelfOpen = shelfOpen || customizing
  if (!pulseEnabled)                                   → "none"
  if (config.row includes "pulse")                     → "row"
  if (effectiveShelfOpen && config.lanes has "pulse")  → "shelf"
  else                                                 → "strip"
```

The strip renders only on `"strip"`; while customizing and suppressed, the strip
slot renders the placeholder variant at identical height ([P04]). The row cell and
shelf lane always render when configured — with live text when they're the active
surface and `pulseEnabled`, dimmed-off placeholder when `!pulseEnabled`.

**Spec S04: Shelf geometry** {#s04-shelf-geometry}

Band height = `legend-row + 5 × data-row + footer-row` (CSS constants; the spike's
`calc(5 * 20px + 22px)` + 24px footer adapted to production tokens). Lanes split
the band width evenly; focused lane takes `flex: 4`, others `flex: 0 0 <peek>`.
Data rows: uniform single-line typography (dot/meta + text, ellipsized) — the
spike's `.z2ws-lane-item` grammar under production class names
(`dev-status-shelf-*`). Empty lane: centered quiet placeholder at full band height.
Zero lanes: the band keeps its height, shows the "drag some in below" note, and
remains a drop target while customizing.

**Spec S05: Drag visuals** {#s05-drag-visuals}

`startDragGhost(e, label)`: create a styled clone (`.dev-status-drag-ghost`, tab-bar
ghost tokens), `setDragImage(ghost, 14, 14)`, remove next tick.
`computeInsertion(container, itemSelector, clientX) → {index, x}`: midpoint math;
caret x = target item's left edge − 2px, or last item's right edge + 2px for
append. Caret: absolute 2px bar, accent fill token, `transition: left calc(120ms *
var(--tug-timing, 1))` — **positioned by direct DOM mutation**: the dragover handler
creates/moves the caret element imperatively and writes `style.left` (the
`updateInsertionIndicator` mechanism in `card-drag-coordinator.ts` — the tab bar's
real grammar), and removes it on dragleave / drop / dragend. No React state at
pointer frequency ([L06]). Source dim: `[data-dragging]` → opacity 0.3
(render-driven attribute — one flip per drag start/end). Identical for row items
and shelf lanes.

**Spec S06: The customize/drag bridge** {#s06-customize-bridge}

The row's node is created by the placement harness (`useDevPlacementSlots` →
`sessionNode("statusRow")`) and arrives at `DevCardStatusArea` as a finished
ReactNode — props cannot reach it. Three mechanisms bridge the boundary:

1. **`StatusAreaCustomizeContext`** (exported from `status-area-config.ts`, which
   already imports React for its hook): `{ customizing: boolean,
   removeRowItem(index: number): void } | null`, provided by `DevCardStatusArea`,
   consumed by `DevTelemetryStatusRow` for the edit affordances (grips, per-cell
   `×`, spacer glyphs, `draggable`). The `null` default means "never customizing" —
   gallery and fixture renders are unchanged.
2. **Drag payload on `dataTransfer`**: drag sources call
   `setData("application/x-tug-status-item", JSON.stringify({source, index}))`
   (`source: "row-palette" | "row" | "lane-palette" | "shelf"`). HTML5 dnd events
   traverse component boundaries natively; the payload is read with `getData` at
   drop (dragover needs only position, never the payload). No shared refs between
   palette and row.
3. **Delegated `dragover`/`drop` handlers on the area's containers** (the bar's
   cell row, the shelf's lane band): `computeInsertion` resolves positions by
   selector (`.dev-telemetry-status-cell` / the lane class), so the drop target
   never cares which component rendered the items.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| status-area config (row / lanes / shelfOpen) | external config | `useTugbankValue` + `setLocalValue`/PUT write helper (placement-experiment pattern) | [L02] |
| `customizing` | local structural mode | `useState` in `DevCardStatusArea`, bridged to the slot-rendered row via `StatusAreaCustomizeContext` (Spec S06) | — |
| ~~`maximized`~~ | — (removed Jun 23, `1bdae0b79`) | n/a — no longer part of the card | — |
| pulse line / enabled (read) | external app state | `pulse-store` via `useSyncExternalStore` (pulse plan) | [L02] |
| lane focus (which lane expanded) | local-data → appearance | `useState` lane id → `data-focus` attr; flex in CSS | [L06] |
| drag source dim | appearance | `data-dragging` attr + CSS rule | [L06] |
| insertion caret | appearance (DOM-transient) | imperative element + `style.left` writes in dragover handlers (the `card-drag-coordinator` mechanism); glide via CSS transition | [L06] |
| drag ghost | DOM-transient | imperative clone + `setDragImage`, removed next tick | [L06] |
| strip suppression / surface choice | derived | pure `resolvePulseSurface` computed in render | — |
| shelf mount | structure | conditional on `shelfOpen ∥ customizing` (user-driven) | [L26] (stable while open) |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/status-area-config.ts` (+ `__tests__`) | schema, defaults, `parseStatusAreaConfig`, `resolvePulseSurface`, `useStatusAreaConfig`, `writeStatusAreaConfig` |
| `tugdeck/src/components/tugways/cards/dev-card-status-area.tsx/.css` | the Z2 composite: bar chrome, strip slot, shelf + configurator mounts ([P03]) |
| `tugdeck/src/components/tugways/cards/dev-card-status-shelf.tsx/.css` | lanes, focus affordance, footer ([P05]/[P07]) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `StatusRowItemId`, `ShelfLaneId`, `StatusAreaConfig`, `STATUS_AREA_DEFAULTS` | types/const | `status-area-config.ts` | Spec S01 |
| `parseStatusAreaConfig`, `writeStatusAreaConfig`, `useStatusAreaConfig` | fn/hook | `status-area-config.ts` | [P01] |
| `resolvePulseSurface` | fn | `status-area-config.ts` | Spec S03 |
| cell registry + config-ordered render | edit | `dev-card-telemetry-renderers.tsx` (`DevTelemetryStatusRow`) | [P02]; PULSE/SPACE/FLEX cells new |
| PULSE / spacer cell widths + flex rules | edit | `tug-status-cell.css` | [P02]/[P10]; `data-priority="pulse"` flexible |
| `DevCardStatusArea` | component | `dev-card-status-area.tsx` | [P03]; Spec S02 |
| `DevCardStatusShelf` | component | `dev-card-status-shelf.tsx` | [P05]/[P07]; Spec S04 |
| `startDragGhost`, `computeInsertion`, imperative caret helper | fn | shared in `dev-card-status-area.tsx` (or small helper module) | Specs S05/S06; caret via direct DOM (`card-drag-coordinator` precedent) |
| `StatusAreaCustomizeContext` | React context | `status-area-config.ts` | Spec S06; tolerant `null` default |
| status-bar block swap; strip mount relocation | edit | `dev-card.tsx` | [P03]; bare CycleScope'd main today (no maximize) |
| focus-order derivation from config | edit | `dev-card-telemetry-renderers.tsx` | [P09] |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md`: new entry for the configurable Z2 status area
      (config object + single-surface rule + shelf geometry + chrome order),
      amending the Z2 zone notes ([D100]-family context).
- [ ] Docstring in `gallery-z2-workshop.tsx` gains one line noting the design
      shipped (pointer to the production components) — the card stays as the record.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (pure-logic bun:test)** | `parseStatusAreaConfig` salvage paths (unknown ids, dupes, caps, malformed JSON, undefined); `resolvePulseSurface` truth table; focus-order derivation over configs with spacers; `computeInsertion` midpoint/append math | `status-area-config.ts`, renderers helpers |
| **Real-app (`just app-test`)** | only if a focus-cycle regression demands one — the cycle behavior is otherwise covered by the existing app-test suite running green | `tests/app-test/` |
| **Live walk (not CI)** | drag interactions, shelf height stability, single-surface transitions, persistence across reload, chrome centering | every UI step's checkpoint |

#### What stays out of tests {#test-non-goals}

- Drag-and-drop event choreography — browser-behavior; verified live (a fake-DOM
  harness is banned and pointless here).
- Render-output assertions on the row/shelf — no fake-DOM/RTL; the default-config
  no-drift gate is a live visual walk plus unchanged cell code.
- Mock-store call-count tests on the write helper — banned pattern; the placement
  experiment's write path is already proven.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Config module | pending | — |
| #step-2 | Row from registry | pending | — |
| #step-3 | Status-area extraction + chrome | pending | — |
| #step-4 | The shelf | pending | — |
| #step-5 | The configurator | pending | — |
| #step-6 | Docs | pending | — |
| #step-7 | Integration checkpoint | pending | — |

#### Step 1: Config module {#step-1}

**Commit:** `Add tugbank-persisted status-area config module`

**References:** [P01] config object, [P04] single-surface, Spec S01, Spec S03,
Risk R01, (#state-zone-mapping)

**Artifacts:**
- `tugdeck/src/lib/status-area-config.ts`: `StatusRowItemId`, `ShelfLaneId`,
  `StatusAreaConfig`, `STATUS_AREA_DEFAULTS`, `STATUS_AREA_DOMAIN`/`KEY`,
  `parseStatusAreaConfig`, `writeStatusAreaConfig`, `useStatusAreaConfig`,
  `resolvePulseSurface`, plus the item-spec table (labels, `repeatable`,
  `flexible`) ported from the spike vocabulary.
- `tugdeck/src/lib/__tests__/status-area-config.test.ts`.

**Tasks:**
- [ ] Define types + defaults per Spec S01; port `RACK_ITEMS`/`LANE_LABELS`
      semantics from the spike as the production item-spec table.
- [ ] Implement `parseStatusAreaConfig` with full field-wise salvage (Risk R01).
- [ ] Implement `writeStatusAreaConfig` on the placement-experiment pattern
      (`setLocalValue` + PUT) and `useStatusAreaConfig` over `useTugbankValue`.
- [ ] Implement `resolvePulseSurface` per Spec S03.

**Tests:**
- [ ] Parse salvage: undefined entry, non-object value, unknown ids, duplicate
      one-shot items, repeated spacers kept, >3 lanes capped, missing fields.
- [ ] `resolvePulseSurface` truth table including the customizing-forces-shelf and
      disabled cases.

**Checkpoint:**
- [ ] `bun test status-area-config`
- [ ] `bunx tsc --noEmit`

---

#### Step 2: Row from registry {#step-2}

**Depends on:** #step-1

**Commit:** `Render Z2 status row from configured cell registry`

**References:** [P02] cell registry, [P09] focus orders, [P10] collapse rungs,
Spec S01, Spec S06, (#s01-config-schema, #s06-customize-bridge, #symbols)

**Artifacts:**
- `DevTelemetryStatusRow` rendering from `useStatusAreaConfig().row` over a cell
  registry; existing six cells' JSX moved verbatim into registry entries.
- New PULSE cell (pulse-store line, flexible width, dimmed-off when disabled) and
  SPACE / FLEX SPACE cells.
- `tug-status-cell.css`: `data-priority="pulse"` flexible-width rules; spacer cell
  rules.

**Tasks:**
- [ ] Build the registry (`StatusRowItemId` → cell render fn taking the row's
      already-computed snapshot/derived values) and map the config over it.
- [ ] Derive focus orders from configured order, skipping spacers ([P09]); keep
      `/context`'s `contextPopoverRef` attached iff a `context` cell renders.
- [ ] Add the PULSE cell reading the pulse-store snapshot (newest line + `enabled`);
      no popover ([Q01]).
- [ ] Add spacer cells (invisible at rest; glyph only while customizing — read from
      `StatusAreaCustomizeContext` (Spec S06), whose provider #step-3 mounts and
      #step-5 drives; the tolerant `null` default keeps gallery/fixture renders
      unchanged).

**Tests:**
- [ ] Focus-order derivation: default config → orders 0–5 over six cells; configs
      with spacers/pulse → spacers skipped, consecutive orders.
- [ ] Registry completeness: every `StatusRowItemId` resolves to an entry.

**Checkpoint:**
- [ ] `bun test` (tugdeck) + `bunx tsc --noEmit`
- [ ] Live walk: with no stored config, the row is visually identical to before
      (cells, widths, popovers, Tab cycle); `window.tugDevPlacement` untouched.

---

#### Step 3: Status-area extraction + chrome {#step-3}

**Depends on:** #step-2

**Commit:** `Extract DevCardStatusArea; rearrange Z2 chrome; gate the strip`

**References:** [P03] status-area component, [P04] single-surface, [P09] chrome
conduct, Spec S02, Spec S03, Spec S06, (#s02-bar-chrome, #s06-customize-bridge)

**Artifacts:**
- `dev-card-status-area.tsx/.css`: bar (lead spacer, CycleScope'd Z2
  content, gear, chevron), strip slot driven by `resolvePulseSurface`, shelf mount
  point (renders nothing until #step-4).
- `dev-card.tsx`: status-bar block replaced; `dev-pulse-strip` mount relocated
  into the area.

**Tasks:**
- [ ] Build the bar per Spec S02 (flank balance; gear `tinted` while customizing —
      state stubbed local until #step-5 wires the configurator; chevron toggles
      `shelfOpen` via `writeStatusAreaConfig`).
- [ ] Provide `StatusAreaCustomizeContext` from the area (constant
      `customizing: false` until #step-5) so the row's context consumption is
      exercised from the start (Spec S06).
- [ ] Compute `resolvePulseSurface` and render the strip only on `"strip"`;
      placeholder variant while customizing-and-suppressed ([P04]).
- [ ] Swap `dev-card.tsx`'s inline status-bar block for `<DevCardStatusArea …>` (the
      block is a bare CycleScope'd main today — nothing else to thread out).
- [ ] Preserve `:empty` collapse for a null Z2 slot and the cycle-scope wiring.

**Tests:**
- [ ] (covered by #step-1's resolver tests; no new pure-logic surface)

**Checkpoint:**
- [ ] `bunx tsc --noEmit`; `bun test`
- [ ] Live walk: cells stay centered against the lead spacer + gear/chevron; chevron
      flips and persists `shelfOpen` across reload (shelf itself still empty-mount);
      strip appears/disappears per the rule when toggling PULSE into the row config
      via console-written config.

---

#### Step 4: The shelf {#step-4}

**Depends on:** #step-3

**Commit:** `Add the Z2 status shelf: lanes, focus, footer`

**References:** [P05] shelf geometry, [P07] footer, [Q01], Spec S04,
(#s04-shelf-geometry)

**Artifacts:**
- `dev-card-status-shelf.tsx/.css`: lane band (TASKS / JOBS / PULSE rows from
  `useTaskListState` / `useJobsState` / pulse-store), legend focus affordance,
  fixed-height geometry, footer with clickable overflow counts.

**Tasks:**
- [ ] Build lanes per Spec S04 with production tokens; dot states reuse the
      task/job→`TugProgressIndicatorState` mappings; running-job elapsed uses the
      exported `useLiveTick` in a leaf component (popover precedent).
- [ ] Lane focus: legend button + chevrons-apart/together affordance, `data-focus`
      flex behavior, disabled under 2 lanes.
- [ ] Footer: per-lane overflow counts; TASKS/JOBS counts are `TugPopover` triggers
      reusing `TasksPopoverContent`/`JobsPopoverContent` (props threaded from the
      card: `onScrollToRow`, `onStopJob`, `onClearJobs`); PULSE count inert
      ([P07]/[Q01]); row always present while open.
- [ ] Mount in `DevCardStatusArea` on `shelfOpen ∥ customizing`; shelf lane for
      PULSE participates in the single-surface rule (already resolved in #step-3).

**Tests:**
- [ ] Pure-logic: lane overflow count math (rows beyond 5; zero floor).

**Checkpoint:**
- [ ] `bunx tsc --noEmit`; `bun test`
- [ ] Live walk: shelf opens at fixed height; task/job/pulse data populate; height
      never moves as data changes; focus expand/contract; footer counts open the
      right popovers with working stop/clear; transcript cedes exactly the shelf's
      height.
- [ ] Live walk with **shelf open on a short card**: the transcript holds its floor
      (`--dev-transcript-min`) without collapsing and the entry's max-height cap
      holds — the shelf steals height cleanly down to the floor. (The old
      maximize+shelf coexistence case is moot — maximize was removed.)

---

#### Step 5: The configurator {#step-5}

**Depends on:** #step-4

**Commit:** `Add in-place Z2 configurator with drag arrange`

**References:** [P06] drag grammar, [P08] configurator, [P01] live writes,
Spec S05, Spec S06, (#s05-drag-visuals, #s06-customize-bridge)

**Artifacts:**
- Customize mode in `DevCardStatusArea`: gear toggle, row palette + lane palette
  panels, config footer (hint / Restore Defaults / Done).
- Drag arrange on row + shelf: ghost, caret, source dim, grips, per-item `×`
  removal; `startDragGhost` / `computeInsertion` ported per Spec S05.
- Row cells show grips/`×`/spacer glyphs while customizing, driven through
  `StatusAreaCustomizeContext` (Spec S06; consumption landed in #step-2/#step-3).

**Tasks:**
- [ ] Wire `customizing` state: forces shelf open, pauses lane focus, switches lane
      legends to edit mode (grip + label + `×`).
- [ ] Implement the four drag flows (palette→row, row reorder, palette→shelf, lane
      reorder): payload on `dataTransfer`, delegated container handlers, imperative
      caret (Specs S05/S06); commit through `writeStatusAreaConfig` on drop;
      double-click append on palette chips.
- [ ] Palettes: fixed-height single-line strips directly beneath their sections;
      "all placed" text when empty; lane palette enforces the 3-lane cap.
- [ ] Config footer: hint text, Restore Defaults (writes `STATUS_AREA_DEFAULTS`),
      Done (exits mode); suppressed-strip placeholder behavior verified ([P04]).

**Tests:**
- [ ] `computeInsertion`: before-first, between-midpoints, append-after-last,
      empty container.
- [ ] Row-mutation helpers (insert with one-shot dedupe, remove, reorder
      with source-index adjustment) as pure functions.

**Checkpoint:**
- [ ] `bunx tsc --noEmit`; `bun test`
- [ ] Live walk in the app build: full customize round-trip — remove TIME, add
      PULSE to the row (strip stands down), reorder lanes, empty the shelf (band
      height holds, still a drop target), Restore Defaults, Done; hard reload
      preserves the arrangement; drag ghost/caret/dim all render in WKWebView.

---

#### Step 6: Docs {#step-6}

**Depends on:** #step-5

**Commit:** `Record configurable Z2 status area in design decisions`

**References:** [P01]–[P10], (#documentation-plan)

**Artifacts:**
- `tuglaws/design-decisions.md` entry; one-line shipped-pointer in the workshop
  card's docstring.

**Tasks:**
- [ ] Write the [D##] entry: config object + domain, single-surface rule, shelf
      geometry, chrome order, footer conduct.
- [ ] Add the workshop-card docstring pointer.

**Tests:**
- [ ] (docs only)

**Checkpoint:**
- [ ] `bunx tsc --noEmit` (docstring edit compiles); entry reads coherently against
      the shipped code.

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-2, #step-3, #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [P04] single-surface, [P05] geometry, (#success-criteria)

**Tasks:**
- [ ] Walk every success criterion end-to-end in the app build with a live session
      (real tasks, a background job, live PULSE from the pulse pipeline).
- [ ] Toggle `pulse/enabled` off and confirm all three PULSE homes go to their off
      states; back on restores.
- [ ] Narrow the card through the collapse rungs with a custom row; confirm
      acceptable degradation ([P10] watch-item).

**Tests:**
- [ ] Full `bun test` + `bunx tsc --noEmit` + `just app-test` sweep green.

**Checkpoint:**
- [ ] Every box in #success-criteria checked against the live walk.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A user-configurable Z2 status area in the dev card — drag-arranged
instrument row, persisted pinned shelf with TASKS / JOBS / PULSE lanes, in-place
configurator, and PULSE surfacing exactly once — with the untouched-default
experience identical to today's row.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Default config renders the pre-plan row exactly (live walk).
- [ ] Row + lanes + shelf disposition persist via tugbank and survive reload.
- [ ] Open shelf is height-stable under all data conditions; footer counts open the
      existing popovers.
- [ ] PULSE single-surface rule holds across all configurations including
      customize mode and `pulse/enabled` off.
- [ ] All checkpoints green: `bun test`, `bunx tsc --noEmit`, `just app-test`.

**Acceptance tests:**
- [ ] `status-area-config` suite (parse salvage, resolver truth table, insertion
      math, mutation helpers).
- [ ] The #step-7 live walk of #success-criteria.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] PULSE history popover from the strip / lane / footer count ([Q01]).
- [ ] Per-card scope filtering of PULSE surfaces ([Q02]).
- [ ] Shelf open/close height animation ([Q03]).
- [ ] Additional row datums (cost, TTFT) via the registry.
- [ ] Config-aware collapse rungs if narrow-card evidence demands ([P10]).

| Checkpoint | Verification |
|------------|--------------|
| Zero default drift | live walk vs. pre-plan row |
| Persistence | hard reload retains arrangement |
| Height stability | shelf + configurator never move with data |
| Single surface | PULSE in exactly one home in every state |
