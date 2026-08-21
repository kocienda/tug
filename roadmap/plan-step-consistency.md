<!-- devise-skeleton v5 -->

## Plan/Step Count Consistency — the fraction is the run's {#plan-step-consistency}

**Purpose:** Every glanceable dash-progress surface — the session masthead cluster, the Lens session row, the Lens Dashes row, the Changes shade's dash row — shows progress through the **declared run** (`steps 1–3` → `1/3`), not through the plan document (`1/10`), so the counter, the WORK task panel, and the invocation's own words finally agree. Roomy surfaces additionally say where the run sits in the plan.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via dash worktree) |
| Last updated | 2026-08-21 |

---

### Review Record {#review-record}

*No review rounds yet.*

---

### Phase Overview {#phase-overview}

#### Context {#context}

A dash-implement invocation of `Steps 1–3` against a ten-step plan produces a masthead reading `1/10` while the WORK panel shows `0/3 tasks` and the session description says "steps 1–3". Both numbers are honest readings of two different recorded facts that nothing composes: `tugutil dash step start 1 --through 3` writes a `run-through  3` dash-log line (the declared run, [D147]'s [P01]) *and* a `step-start  1/10` line whose `10` is `doc.ledger_rows.len()` — the plan's whole ledger — stamped in `step_in` (`tugrust/crates/tugdash-core/src/ops.rs`). The feed forwards only `step_current`/`step_total` to the client, so every fraction render site shows plan-document progress; `run_through` exists on `DashDetail` but never reaches the wire.

The declared run is the unit the user asked for, the unit dash-implement's tasks mirror, and — since the join-endgame work — the unit the join arc arms from (`run_complete` is literally `done >= run_through`). A glanceable counter should answer *"how far through what was asked?"*, and every surface showing a bare fraction should give the same answer.

#### Strategy {#strategy}

- Derive the run's span (first step, length, position) **once, in tugdash-core**, from facts the dash-log already records — no new log grammar, no client arithmetic ([P02]). This is the same shape as `join_ready` in [D147]: the server derives, displays read.
- Carry the derived pair over the existing wire path: `DashDetail` → `DashChangesetEntry` → `changeset-types.ts` → `dash-session-index.ts` → the components.
- One client-side preference rule, in one function beside `dashWalkComplete` (`tugdeck/src/components/tugways/dash-meta-line.tsx`), so the masthead, the Lens rows, and the shade cannot disagree about which pair to render.
- Glanceable surfaces show the run fraction; roomy surfaces add the plan sentence ([P01], [P04]). Legacy generations with no declared run keep today's plan fraction as the explicit degraded case ([P05]).
- Existing app-test pins mostly use single-step plans where run == plan (`--through 1`), so their numbers do not move; new pins cover a multi-step plan with a partial declared run.

#### Success Criteria (Measurable) {#success-criteria}

- A dash driving a 10-row plan with `step start 1 --through 3` renders `1/3` in the session masthead cluster, the Lens session row, the Lens Dashes row, and the shade's dash row (app-test pin, Step 5).
- The Lens Dashes row's roomy line also names the plan position (`step 1 of 10 in the plan`) (app-test pin, Step 5).
- A run of steps 5–7 with step 6 open renders `2/3` — run-relative position, never `6/7` (Rust unit table, Step 1).
- A completed run holds its full fraction (`3/3`, ring in the success tone) while the dash reads `ready`; the next `step start` under a new `run-through` declaration resets it ([P03]; Rust unit + app-test).
- A generation whose log has step declarations but no `run-through` line renders the plan fraction exactly as today ([P05]; Rust unit + unchanged pins in at0405/at0406).
- `cargo nextest run`, `bunx tsc --noEmit`, `bunx vite build`, `bun test`, and the named app-tests all green.

#### Scope {#scope}

1. `tugdash-core`: run-span derivation in the declarations fold and a pure fraction function.
2. Stamping the pair on `DashDetail` and `DashStatus`; forwarding on the `DashChangesetEntry` wire type.
3. tugdeck: wire mirror, session index, preference helper, and the four render surfaces.
4. App-test pins for the multi-step declared run; doc sync.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No new dash-log grammar — the derivation reads only lines the verbs already write.
- No change to `tugutil dash step`'s recorded `i/N` note (plan-total `N` stays in the log; it is the plan fact and roomy surfaces still want it).
- No change to the WORK task panel — it already shows the run.
- Spike files (`tugdeck/src/spikes/spike-dash-progress.tsx` etc.) that happen to read `step_total` are untouched.
- No redesign of the cluster/ring visual treatment — geometry and components stay; only the numbers feeding them change.

#### Dependencies / Prerequisites {#dependencies}

- The declared-run machinery from the join-endgame work ([D147]): `run-through` log lines, `DashDeclarations::run_through`/`run_complete`, `DashDetail::run_through`/`run_complete` — all landed on main.

#### Constraints {#constraints}

- Warnings are errors (`-D warnings` via `tugrust/.cargo/config.toml`).
- Wire fields must be additive and optional — old clients and recorded fixtures must keep validating (`isDashChangesetEntry` in `tugdeck/src/lib/changeset-types.ts`).
- Dash-logs are append-only and never rewritten; every derivation must read legacy logs (no `run-through` line) gracefully.

#### Assumptions {#assumptions}

- A run's `run-through` line always precedes its first `step-start` in the log: `step_in` (`ops.rs`) appends `run_through` via `append_run_through` *before* `append_step_declaration`, and only when the declared value changes. Spec S01 leans on this ordering.
- One session drives one run at a time per dash; concurrent interleaved runs on one dash are not a supported shape.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. The completed-run face was the one genuine judgment call; it was asked and decided 2026-08-21 — hold the full fraction ([P03]).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Same-`--through` re-declaration keeps the old run's first step | low | low | documented semantics in Spec S01; benign display (`3/3` for a resumed final step) | a real run renders a nonsense fraction |
| Old recorded feed fixtures lack the new fields | med | med | fields optional + validator accepts absence; [P05] fallback renders | fixture validation failures in `bun test` |
| Pin churn in dash app-tests | med | med | single-step fixtures keep run == plan so existing numbers hold; only deliberately extended fixtures re-pin | red pins outside Step 5's list |

**Risk R01: Fold-order fragility** {#r01-fold-order}

- **Risk:** The `run_first` derivation depends on `run-through` preceding its run's first `step-start` in the log.
- **Mitigation:** The writer guarantees the order today (Spec S01 cites it); a fold unit test pins a log written in the real order and a test pins the degenerate reversed order (reads as [P05] fallback, never a panic).
- **Residual risk:** A hand-edited dash-log can still produce an odd span; it degrades to a wrong-but-bounded fraction, never a crash.

---

### Design Decisions {#design-decisions}

#### [P01] The fraction is the run's (DECIDED) {#p01-fraction-is-the-run}

**Decision:** Every glanceable step fraction and ring renders progress through the declared run — position within the selection over the selection's length — whenever a run is declared.

**Rationale:**
- The declared run is the unit of the ask: dash-implement's tasks mirror it, the invocation names it, and the join arc arms from its completion ([D147]).
- The masthead's `1/10` against the WORK panel's `0/3` is two surfaces answering different questions with the same typography — a resting inconsistency.

**Implications:**
- The ring's segment count becomes the run length (3 segments, not 10) on glanceable surfaces.
- For a mid-plan run (steps 5–7, step 6 open) the fraction is run-relative: `2/3`. The plan-absolute number still reaches the reader through the step *title* ("Step 6: …") wherever titles render, and through the roomy sentence ([P04]).

#### [P02] The run span is derived once, server-side (DECIDED) {#p02-derived-once}

**Decision:** tugdash-core derives `run_position`/`run_length` from the dash-log fold and stamps them on `DashDetail` and `DashStatus`; the feed forwards them; no client computes them.

**Rationale:**
- Follows [D147]'s pattern for `join_ready`: one derivation, every surface reads the same answer.
- The four-copies-of-one-gate bug class (the `built` gate that [D147] repaired) is exactly what per-surface arithmetic reintroduces.

**Implications:**
- New optional fields on three structs and the wire type; a client preference helper picks between the run pair and the plan pair but never computes either.

#### [P03] A completed run holds its full fraction (DECIDED) {#p03-completed-run-holds}

**Decision:** When `run_complete` is true, glanceable surfaces keep showing `length/length` with the ring in the success tone while the dash reads `ready`; the counter resets only when a new run's first step opens.

**Rationale:**
- User-decided 2026-08-21: `3/3 ready` is the fact that invites `/join`; a bare stage word drops the "what finished" context from the glance.

**Implications:**
- `run_position` is clamped to `run_length` when `run_complete` (a `done(m)` leaves `step_current == m`, so the arithmetic already lands there; the clamp is belt for odd logs).
- `dashWalkComplete` (`dash-meta-line.tsx`) is fed the run pair, so the success reading fires at run completion, not plan completion.

#### [P04] Roomy surfaces speak both numbers (DECIDED) {#p04-roomy-both}

**Decision:** Surfaces with a reading line — the Lens Dashes row (`dash-facts.tsx`) and the Changes shade's dash row (`DashMetaLine` at `size="sm"`) — append the plan position after the run fraction: `step 1 of 10 in the plan`.

**Rationale:**
- "There is a bigger document behind this run" is real information; it belongs where there is room to say it, not compressed into the glance.

**Implications:**
- The plan pair (`step_current`/`step_total`) stays on the wire untouched — it *is* the roomy sentence's source.
- When no run is declared, the roomy sentence would duplicate the fraction, so it renders only when the run pair is present and differs from the plan pair.

#### [P05] No declared run falls back to the plan fraction (DECIDED) {#p05-fallback}

**Decision:** A generation with step declarations but no `run-through` line (legacy logs, hand-driven runs) renders today's plan fraction; the current behavior becomes the explicit degraded case.

**Rationale:**
- Dash-logs are append-only history; every log written before `--through` existed must keep rendering.

**Implications:**
- The preference helper's rule is a two-liner: run pair when present, else plan pair; both absent, no counter.

---

### Specification {#specification}

**Spec S01: Run-span derivation semantics** {#s01-run-span}

The fold in `read_declarations` (`tugrust/crates/tugdash-core/src/dash.rs`) gains one tracked value:

- `DashDeclarations` gains `run_first: Option<u32>` — the step number of the first step declaration of the current run.
- Fold rules, in log order: a `run-through` line sets `run_through` **and clears `run_first`**; a `step-start`/`step-done` line whose fields parse sets `run_first = Some(current)` if it is `None`; a terminal line resets everything (already the case — the whole struct defaults).
- Writer ordering makes this correct: `step_in` appends `run-through` before the run's first `step-start`, and re-declaring an unchanged `--through` appends nothing — so within one run `run_first` latches on the run's opening step. A later run declares a different `--through`, which clears and re-latches. Known benign edge: a new run re-declaring the *same* through value (e.g. re-running the final step of a finished selection) does not clear `run_first`; the fraction reads `length/length`, which is the truthful [P03] face anyway.
- A pure function beside the fold:

  ```rust
  /// The declared run's (position, length), both 1-based, or `None` when no
  /// run is declared or the log's shape defeats the arithmetic ([P05]).
  pub fn run_fraction(declarations: &DashDeclarations) -> Option<(u32, u32)>
  ```

  Semantics: requires `run_through: Some(through)`, `run_first: Some(first)`, a current step from `declarations.step`, and `through >= first` (else `None`, never a panic). `length = through - first + 1`; `position = (current - first + 1).clamp(1, length)`; when `run_complete`, `position = length` ([P03]).

**Spec S02: Wire contract** {#s02-wire}

Additive, optional, snake_case, absent-when-`None`:

- `DashDetail` (`tugrust/crates/tugdash-core/src/ops.rs`) gains `run_position: Option<u32>`, `run_length: Option<u32>`, stamped from `run_fraction` where `run_through`/`run_complete` are already stamped.
- `DashStatus` (same file; the CLI `dash status` struct that carries `step_current: Option<i64>`) gains the same pair as `Option<i64>`, stamped in `status_in`.
- `DashChangesetEntry` (`tugrust/crates/tugcast-core/src/types.rs`, beside `step_current`) gains the pair with the same `#[serde(skip_serializing_if = "Option::is_none")]` treatment its neighbors use; the existing absent-when-none serialization test extends to the new fields.
- The changeset feed (`tugrust/crates/tugcast/src/feeds/changeset.rs`, where `step_current: detail.step_current` is forwarded) forwards both.
- Client mirror (`tugdeck/src/lib/changeset-types.ts`): `run_position?: number; run_length?: number;` beside `step_current`, with the same `undefined-or-number` clauses in `isDashChangesetEntry`.

**Spec S03: Display grammar** {#s03-display-grammar}

**Table T01: What each surface shows** {#t01-surfaces}

| Surface | Component | Glance | Roomy addition |
|---------|-----------|--------|----------------|
| Session masthead cluster | `session-identity-row.tsx` (both `TugStepFraction`/`SessionStepRing` render sites) | run fraction + ring | — |
| Lens session row | `session-identity-row.tsx` (same file, second render site) | run fraction + ring | — |
| Lens Dashes row | `dash-facts.tsx` | run fraction | `step {step_current} of {step_total} in the plan` when a run is declared and the pairs differ ([P04]) |
| Changes shade dash row | `DashMetaLine` (`dash-meta-line.tsx`, `size="sm"`) | run fraction + ring | same plan sentence as the Lens Dashes row |

The preference rule lives in one exported function beside `dashWalkComplete` in `dash-meta-line.tsx`, taking bare values like its neighbor (two spellings arrive: wire `run_position` and index `runPosition`):

```ts
/** The pair a glanceable counter renders: the declared run's when present,
 *  else the plan's ([P01], [P05]). Null when neither is declared. */
export function dashGlanceFraction(
  runPosition: number | null | undefined,
  runLength: number | null | undefined,
  stepCurrent: number | null | undefined,
  stepTotal: number | null | undefined,
): { current: number; total: number } | null
```

`aria-label`s and ring labels follow the pair they render: `step 1 of 3 in this run` when the run pair is chosen, today's `step 1 of 10` spelling when the plan pair is the fallback. `TugStepRing` itself is untouched — callers hand it the chosen pair; `TUG_STEP_RING_SEGMENT_MAX` (16) is comfortably above any real run length.

`dashWalkComplete`/`dashStepsComplete` callers feed the *chosen* pair, so the success tone fires at `3/3 ready` ([P03]) — and still at plan completion for run-less generations.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `run_position`/`run_length` on the wire entry | external store data | existing `CHANGESET_ALL` aggregate via `useChangesetAll` / `useDashForSession` (`useSyncExternalStore`) | [L02] |
| chosen fraction / ring segments | appearance | props into `TugStepRing`/`TugStepFraction`; `data-step-*` attributes CSS paints from | [L06] |

No new stores, no new subscriptions, no structural state.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `DashDeclarations::run_first` | field | `tugrust/crates/tugdash-core/src/dash.rs` | latched in the `read_declarations` fold (Spec S01) |
| `run_fraction` | fn | `tugrust/crates/tugdash-core/src/dash.rs` | pure; the only place the arithmetic lives ([P02]) |
| `DashDetail::{run_position, run_length}` | fields | `tugrust/crates/tugdash-core/src/ops.rs` | stamped beside `run_through`/`run_complete` |
| `DashStatus::{run_position, run_length}` | fields | `tugrust/crates/tugdash-core/src/ops.rs` | `Option<i64>`, stamped in `status_in` |
| `DashChangesetEntry::{run_position, run_length}` | fields | `tugrust/crates/tugcast-core/src/types.rs` | optional, absent-when-none (Spec S02) |
| feed forwarding | edit | `tugrust/crates/tugcast/src/feeds/changeset.rs` | beside the `step_current` forward |
| `DashChangesetEntry.run_position?/run_length?` | fields | `tugdeck/src/lib/changeset-types.ts` | + validator clauses |
| `DashSessionFact::{runPosition, runLength}` | fields | `tugdeck/src/lib/dash-session-index.ts` | projected in `buildDashSessionIndex` |
| `dashGlanceFraction` | fn | `tugdeck/src/components/tugways/dash-meta-line.tsx` | Spec S03; beside `dashWalkComplete` |
| masthead + Lens row adoption | edit | `tugdeck/src/components/tugways/session-identity-row.tsx` | both render sites feed the chosen pair |
| Dashes row adoption + plan sentence | edit | `tugdeck/src/components/lens/sections/dash-facts.tsx` | `data-step-*` attrs carry the chosen pair; new plan-sentence span |
| shade row adoption + plan sentence | edit | `tugdeck/src/components/tugways/dash-meta-line.tsx` | `DashMetaLine` render |
| `recordStampedPlan` rows option | edit | `tests/app-test/dash-fixture.ts` | today writes a 1-row plan and passes `--through 1`; gains a row count + through so a fixture can declare a partial run |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md`: one new global decision recording "the fraction is the run's" display policy and the [P03] hold, amending the display half of [D147]'s world (Step 6 states the exact framing; the number is whatever is next when the step lands).
- [ ] Doc comments on the new fields say which question each pair answers (run vs plan), so the next reader of the wire type does not re-conflate them.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | fold + arithmetic table tests over hand-written dash-logs | Spec S01 edge cases: legacy log, mid-plan run, completed run, reversed-order degenerate, terminal reset, same-through edge |
| **Unit (Rust, serialization)** | wire absence/presence | Spec S02's absent-when-none clauses |
| **Unit (TS)** | validator, index projection, `dashGlanceFraction` table | Spec S03 preference rule |
| **App-test** | the pins: real dash, real plan, real surfaces | Step 5; selective per `@covers` |

#### What stays out of tests {#test-non-goals}

- No render-DOM unit tests of the components — banned shape; the app-test pins cover the painted result.
- No app-test sweep — the named files only, per the selective-run doctrine.
- The ring's SVG geometry — unchanged code, already pinned by existing tests.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The run span: fold + `run_fraction` in tugdash-core | pending | — |
| #step-2 | The pair reaches the wire: DashDetail, DashStatus, feed | pending | — |
| #step-3 | Client truth: wire mirror, session index, `dashGlanceFraction` | pending | — |
| #step-4 | The surfaces adopt the run fraction | pending | — |
| #step-5 | App-test pins: the multi-step declared run | pending | — |
| #step-6 | Doc sync + integration checkpoint | pending | — |

#### Step 1: The run span: fold + `run_fraction` in tugdash-core {#step-1}

**Commit:** `tugdash(run-span): the fold latches the run's first step; run_fraction derives position/length`

**References:** [P01] The fraction is the run's, [P02] Derived once, [P03] Completed run holds, [P05] Fallback, Spec S01, Risk R01, (#s01-run-span)

**Artifacts:**
- `DashDeclarations::run_first`; `run_fraction` with doc comments stating the [P03] clamp and the [P05] `None`.

**Tasks:**
- [ ] Add `run_first: Option<u32>` to `DashDeclarations` (`dash.rs`) with a doc comment naming the writer-ordering assumption (Spec S01).
- [ ] Latch it in the `read_declarations` fold: cleared on `run-through`, set on the first parsing `step-start`/`step-done` after, reset with everything else on terminal lines.
- [ ] Write `run_fraction` per Spec S01: `None` without a declared run or when `through < first`; `position` clamped to `[1, length]`; `run_complete` pins position to length.

**Tests:**
- [ ] Fold tests in `dash.rs`'s existing `log_line`-fixture style: a 1–3 run on a 10-row plan reads `run_first == Some(1)`; a follow-on 4–6 run re-latches to 4; a terminal line clears; a legacy log (steps, no `run-through`) leaves `run_first` meaningless and `run_fraction` `None`.
- [ ] `run_fraction` table: (5–7 run, step 6 open) → `(2, 3)`; completed 1–3 run → `(3, 3)`; reversed-order degenerate → `None`; `through < first` → `None`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 2: The pair reaches the wire: DashDetail, DashStatus, feed {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(run-span): DashDetail and DashStatus carry run_position/run_length; the feed forwards them`

**References:** [P02] Derived once, Spec S02, (#s02-wire)

**Artifacts:**
- New optional fields on `DashDetail`, `DashStatus`, `DashChangesetEntry`; feed forwarding.

**Tasks:**
- [ ] Stamp `run_position`/`run_length` from `run_fraction` on `DashDetail` where `run_through`/`run_complete` are stamped (`ops.rs`), and on `DashStatus` in `status_in`.
- [ ] Add the pair to `DashChangesetEntry` (`tugcast-core/src/types.rs`) with the neighbors' `skip_serializing_if` treatment; forward in `changeset.rs` beside `step_current`.

**Tests:**
- [ ] ops-level test: a stepped fixture with a declared partial run reports the pair on `DashDetail` and `DashStatus`; an undeclared one reports `None`.
- [ ] Extend the existing absent-when-none serialization test in `tugcast-core/src/types.rs` to the new fields.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugcast-core -p tugcast`

---

#### Step 3: Client truth: wire mirror, session index, `dashGlanceFraction` {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(run-span): the wire mirror and session index carry the run pair; one glance-fraction rule`

**References:** [P01], [P05], Spec S02, Spec S03, (#s03-display-grammar, #state-zone-mapping)

**Artifacts:**
- `run_position?`/`run_length?` on the TS wire type + validator; `runPosition`/`runLength` on `DashSessionFact`; `dashGlanceFraction`.

**Tasks:**
- [ ] Mirror the fields in `changeset-types.ts` and extend `isDashChangesetEntry`'s clauses.
- [ ] Project them in `buildDashSessionIndex` (`dash-session-index.ts`) onto `DashSessionFact`.
- [ ] Write `dashGlanceFraction` beside `dashWalkComplete` in `dash-meta-line.tsx`, per Spec S03's signature and rule.

**Tests:**
- [ ] `bun test` unit tables: validator accepts absence/presence and rejects non-numbers; index projection carries the pair; `dashGlanceFraction` — run pair wins, plan pair falls back, both absent → null.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test`

---

#### Step 4: The surfaces adopt the run fraction {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(run-span): masthead, Lens rows, and the shade glance the run; roomy lines add the plan sentence`

**References:** [P01], [P03], [P04], Spec S03, Table T01, (#t01-surfaces)

**Artifacts:**
- All four surfaces render the chosen pair; the two roomy surfaces gain the plan sentence.

**Tasks:**
- [ ] `session-identity-row.tsx`: both render sites (masthead cluster and Lens session row) choose via `dashGlanceFraction` over `DashSessionFact`'s pairs; `dashWalkComplete` receives the chosen pair so the success tone fires at run completion ([P03]).
- [ ] `dash-meta-line.tsx` (`DashMetaLine`): the ring/fraction render the chosen pair; at `size="sm"` append the plan sentence when a run is declared and the pairs differ ([P04]).
- [ ] `dash-facts.tsx` (Lens Dashes row): `data-step-current`/`data-step-total` and the CSS custom properties carry the *chosen* pair; the `aria-label` follows Spec S03's spelling; add the plan-sentence span with its own `data-slot`.

**Tests:**
- [ ] None new at this layer (no render-DOM unit tests); the pins land in Step 5.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 5: App-test pins: the multi-step declared run {#step-5}

**Depends on:** #step-4

**Commit:** `tests(run-span): a 1–2 run on a 3-row plan pins the run fraction and the plan sentence`

**References:** [P01], [P03], [P04], [P05], Spec S03, Table T01, (#success-criteria)

**Artifacts:**
- `recordStampedPlan` (`tests/app-test/dash-fixture.ts`) gains a ledger-row count and a `--through` value; re-aimed pins.

**Tasks:**
- [ ] Extend `recordStampedPlan` so a fixture can write an N-row plan and open step 1 with `--through m < N` (today: one row, `--through 1`).
- [ ] Extend `at0424-lens-dash-line.test.ts` (the session row's ring and fraction — `@covers` already spans `session-identity-row.tsx`): a 3-row plan run `--through 2` pins fraction `1/2`, ring label `step 1 of 2 in this run`, and 2 ring segments; after `step done 2`, the cluster holds `2/2` with the success reading ([P03]).
- [ ] Extend `at0407-lens-dashes-section.test.ts` (the Dashes row): same fixture pins the row fraction `1/2` and the plan sentence naming `of 3` ([P04]).
- [ ] Confirm the untouched single-step pins (at0405, at0406) still read the same numbers — run == plan there, by construction.

**Tests:**
- [ ] The extended at0424 and at0407 assertions above.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0424-lens-dash-line.test.ts tests/app-test/at0407-lens-dashes-section.test.ts tests/app-test/at0405-changes-dash-lane.test.ts tests/app-test/at0406-masthead-dash-run.test.ts`
- [ ] `just app-test-covers-check`

---

#### Step 6: Doc sync + integration checkpoint {#step-6}

**Depends on:** #step-5

**Commit:** `tuglaws(run-span): the fraction is the run's — recorded as a global design decision`

**References:** [P01], [P02], [P03], [P04], [P05], (#documentation-plan, #success-criteria)

**Tasks:**
- [ ] Append the global design decision to `tuglaws/design-decisions.md` in the file's established voice: glanceable fractions render the declared run; the completed run holds its face; the plan pair survives for roomy sentences and run-less fallback; the derivation is server-side, citing [D147].
- [ ] Verify all success criteria in (#success-criteria).

**Tests:**
- [ ] `cd tugrust && cargo nextest run` (full workspace)
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`

**Checkpoint:**
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Every dash-progress fraction in the app answers "how far through what was asked" — the declared run — with the plan's larger shape spoken only where there is room for it, derived once server-side and pinned by app-tests.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] A `Steps 1–3` invocation against a 10-step plan shows `1/3` on the masthead and every Lens/shade counter (at0424/at0407 pins).
- [ ] A finished run holds `3/3` in the success tone while `ready` ([P03] pin).
- [ ] Run-less generations render exactly as before ([P05]; at0405/at0406 unchanged).
- [ ] Full workspace `cargo nextest run`, tugdeck `tsc`/`vite build`/`bun test`, and the Step 5 app-test selection all green.

**Acceptance tests:**
- [ ] `just app-test tests/app-test/at0424-lens-dash-line.test.ts tests/app-test/at0407-lens-dashes-section.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] A richer graphical treatment for the numbered step list (the masthead/Lens height-neutral progress exploration) — separate design conversation.
- [ ] Surfacing the run's *step titles* (not just the count) on a roomy surface, e.g. the shade's expanded dash fold.

| Checkpoint | Verification |
|------------|--------------|
| run span derived and forwarded | `cargo nextest run -p tugdash-core -p tugcast-core -p tugcast` |
| surfaces agree | Step 5 app-test selection |
| doctrine recorded | design-decisions.md entry cites [D147] |
