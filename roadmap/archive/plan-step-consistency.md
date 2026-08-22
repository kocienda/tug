<!-- devise-skeleton v5 -->

## Plan/Step Count Consistency — the fraction is the run's {#plan-step-consistency}

**Purpose:** Every glanceable dash-progress surface — the session masthead cluster, the Lens session row, the Lens Dashes row, the Changes shade's dash row — shows progress through the **declared run** (`steps 1–3` → `1/3`), not through the plan document (`1/10`), so the counter, the WORK task panel, and the invocation's own words finally agree. Where the run sits inside the larger plan is said graphically, by lighting the run's steps as a band on a ring drawn over the whole plan — no surface gains a word or a pixel of height.

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

**Round 1 — 2026-08-21, opus.** Reviewed `plan:b2551fce643f9011`. Lint: 0 errors, 0 warnings.
Oriented on: the whole document — a first round.
Verified the premise against the live record before judging the design: the real `dash-log.md` for the `flow-legibility` dash shows `run-through  3` written at 15:25:29.911 and `step-start  1/10` at 15:25:29.913, so both numbers the plan reconciles are on disk exactly as described, and the writer ordering Spec S01 leans on is real. Also confirmed `step_in` appends `run-through` only when the declared value *changes*, which is what makes the `run_first` latch work and what makes the same-`--through` edge benign rather than wrong.
Applied: **surface inventory — the plan named a component nothing mounts.** Table T01 sent Step 4 to `dash-facts.tsx` for the Lens Dashes row; that row is `DashMetaLine` (`dashes-section.tsx`), and `DashFactsRun`'s only mount in the entire tree is `spikes/spike-dash-progress.tsx` — which `at0407`'s own `@covers` corroborates. Rewrote T01 around the two components that actually ship, added the two mounts the plan had missed (the Lens Cards sub-row and the **session picker**, both `SessionIdentityRow`), corrected "both render sites in `session-identity-row.tsx`" to what it is — one component, one fraction and one ring — and moved the dash-facts question to #roadmap as a delete-or-graduate follow-on.
**The display spec contradicted itself on labels.** It asked for `step 1 of 3 in this run` while promising `TugStepRing` stayed untouched; both `TugStepRing` and `TugStepFraction` build their own `aria-label` internally, so the spelling change was neither free nor scoped, and it would have broken the live `"step 1 of 1"` assertions in `at0407` and `at0424`. Resolved in the new scope-band spec, where today's spelling is kept whenever the run spans the whole plan, which is exactly the shape those one-step fixtures produce, so the pins stay green *and* prove the rule.
**The roomy-sentence decision was rewritten from the user's answer.** The original decision hung a sentence — `step 1 of 10 in the plan` — on the two roomiest rows. Asked where it should sit; the user rejected all three placements on the grounds that these surfaces exist to be concise and asked for the wordless answer. It is the ring: draw one segment per *plan* step and light the declared run as a band, with a fourth `outside` segment state for everything beyond it. The notation was already latent in a shipping component that paints per-segment `data-state`; it costs one state, no words, and no height, and it answers something no sentence did — *where* in the document a run sits. Added a scope-band spec covering the band, its degradation past `TUG_STEP_RING_SEGMENT_MAX`, and the label rule; rewrote Steps 4 and 5 around it, including the segment census that is the only assertion proving the band painted at all.
Recorded two findings the plan should not have to rediscover: `DashChangesetEntry` is an enum *variant*, not a struct (the `serde` attributes are per-field there), and **no dash on this machine has ever recorded two `run-through` lines** — the entire multi-run path is unproven in the field, which is why Step 1's table is load-bearing and now says so in #assumptions. Also filled [P02]'s missing rationale: writing the span into the log instead of deriving it was considered and rejected, because main's log already carries bare `run-through` notes and both readers would have to exist forever.
Laws cross-checked: [L02] honored — the new fields ride the existing `CHANGESET_ALL` aggregate through `useChangesetAll`/`useDashForSession`, no new store and no new subscription; [L06] honored, and *more* so after the rewrite — the band is a `data-state` attribute CSS paints, not a style object or React state; [L13] the breathing segment stays a CSS animation; [L15] the `outside` tone must be a token, stated in Step 4; [L19]/[L20] the `.tsx`/`.css` pair and `data-slot` discipline hold and both ring components are composed rather than re-implemented. State Zone Mapping expanded to name the derived fraction and the segment state explicitly.
Deferred: nothing. The one judgment call was asked and answered inside this round.

---

### Phase Overview {#phase-overview}

#### Context {#context}

A dash-implement invocation of `Steps 1–3` against a ten-step plan produces a masthead reading `1/10` while the WORK panel shows `0/3 tasks` and the session description says "steps 1–3". Both numbers are honest readings of two different recorded facts that nothing composes: `tugutil dash step start 1 --through 3` writes a `run-through  3` dash-log line (the declared run, [D147]'s [P01]) *and* a `step-start  1/10` line whose `10` is `doc.ledger_rows.len()` — the plan's whole ledger — stamped in `step_in` (`tugrust/crates/tugdash-core/src/ops.rs`). The feed forwards only `step_current`/`step_total` to the client, so every fraction render site shows plan-document progress; `run_through` exists on `DashDetail` but never reaches the wire.

The declared run is the unit the user asked for, the unit dash-implement's tasks mirror, and — since the join-endgame work — the unit the join arc arms from (`run_complete` is literally `done >= run_through`). A glanceable counter should answer *"how far through what was asked?"*, and every surface showing a bare fraction should give the same answer.

#### Strategy {#strategy}

- Derive the run's span (first step, length, position) **once, in tugdash-core**, from facts the dash-log already records — no new log grammar, no client arithmetic ([P02]). This is the same shape as `join_ready` in [D147]: the server derives, displays read.
- Carry the derived pair over the existing wire path: `DashDetail` → `DashChangesetEntry` → `changeset-types.ts` → `dash-session-index.ts` → the components.
- One client-side preference rule, in one function beside `dashWalkComplete` (`tugdeck/src/components/tugways/dash-meta-line.tsx`), so the masthead, the Lens rows, and the shade cannot disagree about which pair to render.
- The numerals say the run; the **ring** says the plan, drawing one segment per plan step with the run's steps lit as a band and the rest a whisper ([P04]) — three facts in one glyph, no added words and no added height. Legacy generations with no declared run keep today's fraction and today's ring as the explicit degraded case ([P05]).
- Existing app-test pins mostly use single-step plans where run == plan (`--through 1`), so their numbers do not move; new pins cover a multi-step plan with a partial declared run.

#### Success Criteria (Measurable) {#success-criteria}

- A dash driving a 10-row plan with `step start 1 --through 3` renders `1/3` in the session masthead cluster, the Lens session row, the Lens Dashes row, and the shade's dash row (app-test pin, Step 5).
- That same dash's ring draws **ten** segments with steps 1–3 in the run's band and 4–10 in the out-of-run state — the plan's shape and the run's slice in one glyph, with no words added to any row (app-test pin counting segments by `data-state`, Step 5).
- A run of steps 5–7 with step 6 open renders `2/3` — run-relative position, never `6/7` (Rust unit table, Step 1).
- A completed run holds its full fraction (`3/3`, ring in the success tone) while the dash reads `ready`; the next `step start` under a new `run-through` declaration resets it ([P03]; Rust unit + app-test).
- A generation whose log has step declarations but no `run-through` line renders the plan fraction exactly as today ([P05]; Rust unit + unchanged pins in at0405/at0406).
- `cargo nextest run`, `bunx tsc --noEmit`, `bunx vite build`, `bun test`, and the named app-tests all green.

#### Scope {#scope}

1. `tugdash-core`: run-span derivation in the declarations fold and a pure fraction function.
2. Stamping the pair on `DashDetail` and `DashStatus`; forwarding on the `DashChangesetEntry` wire type.
3. tugdeck: wire mirror, session index, the fraction/ring split, and `TugStepRing`'s scope band.
4. App-test pins for the multi-step declared run; doc sync.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No new dash-log grammar — the derivation reads only lines the verbs already write.
- No change to `tugutil dash step`'s recorded `i/N` note — plan-total `N` stays in the log, and it is what the ring's segment count is drawn from ([P04]).
- No change to the WORK task panel — it already shows the run.
- Spike files (`tugdeck/src/spikes/spike-dash-progress.tsx` etc.) that happen to read `step_total` are untouched — and so is `DashFactsRun` (`tugdeck/src/components/lens/sections/dash-facts.tsx`), which **only** that spike mounts (see Table T01, #t01-surfaces).
- **No words are added to any row.** The plan's shape is carried graphically or not at all ([P04]); prose is confined to `aria-label`s, where it costs no pixels.
- No height change and no new geometry: the ring keeps its box, its stroke, and its two mount forms. It gains one segment *state*, painted in CSS.

#### Dependencies / Prerequisites {#dependencies}

- The declared-run machinery from the join-endgame work ([D147]): `run-through` log lines, `DashDeclarations::run_through`/`run_complete`, `DashDetail::run_through`/`run_complete` — all landed on main.

#### Constraints {#constraints}

- Warnings are errors (`-D warnings` via `tugrust/.cargo/config.toml`).
- Wire fields must be additive and optional — old clients and recorded fixtures must keep validating (`isDashChangesetEntry` in `tugdeck/src/lib/changeset-types.ts`).
- Dash-logs are append-only and never rewritten; every derivation must read legacy logs (no `run-through` line) gracefully.

#### Assumptions {#assumptions}

- A run's `run-through` line always precedes its first `step-start` in the log: `step_in` (`ops.rs`) appends `run_through` via `append_run_through` *before* `append_step_declaration`, and only when the declared value changes. Spec S01 leans on this ordering.
- One session drives one run at a time per dash; concurrent interleaved runs on one dash are not a supported shape.
- **The multi-run path has never run in the wild.** No dash in this machine's `dash-log.md` has ever recorded two `run-through` lines (checked across the whole log, 2026-08-21) — every dash so far declared one selection and stopped. Every multi-run behavior in Spec S01 is therefore proven by unit test, not by field evidence, which is why Step 1's table is the load-bearing test of this plan.

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

**Alternative rejected:** writing the span into the log instead of deriving it — `append_run_through` is called from `step_in`, where the current step is already known, so the note could read `1..3` rather than `3`. Rejected because it would not remove the derived path: dash-logs are append-only and main's own log already carries bare `run-through  3` lines from the join-endgame work, so both readers would have to exist forever. One derivation that handles old and new logs uniformly beats a writer change plus a compatibility clause.

#### [P03] A completed run holds its full fraction (DECIDED) {#p03-completed-run-holds}

**Decision:** When `run_complete` is true, glanceable surfaces keep showing `length/length` with the ring in the success tone while the dash reads `ready`; the counter resets only when a new run's first step opens.

**Rationale:**
- User-decided 2026-08-21: `3/3 ready` is the fact that invites `/join`; a bare stage word drops the "what finished" context from the glance.

**Implications:**
- `run_position` is clamped to `run_length` when `run_complete` (a `done(m)` leaves `step_current == m`, so the arithmetic already lands there; the clamp is belt for odd logs).
- `dashWalkComplete` (`dash-meta-line.tsx`) is fed the run pair, so the success reading fires at run completion, not plan completion.

#### [P04] The ring carries the plan; the numerals carry the run (DECIDED) {#p04-ring-carries-plan}

**Decision:** No surface gains a word. `TugStepRing` draws one segment per **plan** step and lights the declared run's steps as a band — the run's landed steps filled, its current step breathing, its remaining steps in the ring's tone, and every step outside the run in a fourth, whisper-quiet state. `TugStepFraction` shows the **run** pair (`1/3`). Together, one glyph and six characters say how big the plan is, which slice was asked for, and how far into that slice the work has got.

**Rationale:**
- The first draft of this plan answered the "where does this run sit in the plan?" question with a sentence (`step 1 of 10 in the plan`) on the two roomiest rows. That was wrong on its own terms: these rows exist to be concise, and a row already carrying ring, stage, fraction, note, and age does not want a sixth clause. The user rejected all three placements and asked for the wordless answer.
- The ring already draws one segment per step and already paints per-segment state from `data-state` — the notation for "which steps are in scope" was sitting unused in a component that ships. Using it costs one state and no pixels.
- It also answers the harder question the sentence could not: a run of steps 5–7 shows its band sitting two-thirds of the way around the plan's circle. No fraction and no sentence conveys *where* in the document a run sits; the band does it at a glance.

**Implications:**
- `TugStepRing` gains an optional `scope` prop and a fourth segment state; its box, stroke, and both mount forms are unchanged, so no surface changes height ([L06] — the state is a `data-*` attribute CSS paints from).
- The two components take **different pairs**: the ring takes plan `current`/`total` plus the run's span; the fraction takes the run's position/length. This is not an inconsistency — it is the division of labor the decision names.
- Words move to `aria-label`, where they are free (Spec S04).
- With no declared run, `scope` is absent and the ring renders exactly as it does today ([P05]).

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

**Spec S03: Display grammar and the real surface inventory** {#s03-display-grammar}

There are exactly **two** components that render a dash's step progress in shipping UI, and each is mounted by more than one surface. Getting this inventory right matters because a first reading of the tree suggests four independent render sites; there are two, and one of the obvious candidates is dead.

**Table T01: The surface inventory** {#t01-surfaces}

| Component | Mounted by | Renders | Gets |
|---|---|---|---|
| `SessionIdentityRow` (`session-identity-row.tsx`) | the session masthead (`session-masthead.tsx`), the Lens **Cards** session row (`cards-session-cell.tsx`), and the **session picker** (`session-picker-cells.tsx`) | `TugStepFraction` in the title cluster + `SessionStepRing` as the row indicator | `DashSessionFact` (camelCase) from `dash-session-index.ts` |
| `DashMetaLine` (`dash-meta-line.tsx`) | the Lens **Dashes** row (`dashes-section.tsx`, `size` default `2xs`) and the Changes shade's dash row (`session-changes-dash-lane.tsx`, `size="sm"`) | `TugStepRing`/`SessionStepRing` + `TugStepFraction` | `DashChangesetEntry` (snake_case) from the wire |

**`DashFactsRun` (`dash-facts.tsx`) is not in this inventory and must not be edited.** It reads `stepCurrent`/`stepTotal` and looks like the Lens Dashes row, but the only thing that mounts it is `spikes/spike-dash-progress.tsx`. The Lens Dashes row is `DashMetaLine`, which is also what `at0407`'s `@covers` names. Editing `dash-facts.tsx` would change nothing a user can see. (Whether it should be deleted is a follow-on, #roadmap.)

Because `SessionIdentityRow` is one component behind three mounts, the masthead, the Lens Cards row, and the picker all change together and cannot disagree — which is the whole complaint that opened this plan. Nothing needs to be done three times.

**The pair each component takes** ([P04]): the **fraction** takes the run's `(position, length)`; the **ring** takes the plan's `(current, total)` plus the run's span as `scope`. The chooser lives in one exported function beside `dashWalkComplete` in `dash-meta-line.tsx`, taking bare values like its neighbor does, because two spellings arrive (wire `run_position`, index `runPosition`):

```ts
/** The pair the numerals render: the declared run's when present, else the
 *  plan's ([P01], [P05]). Null when neither is declared. */
export function dashGlanceFraction(
  runPosition: number | null | undefined,
  runLength: number | null | undefined,
  stepCurrent: number | null | undefined,
  stepTotal: number | null | undefined,
): { current: number; total: number } | null
```

`dashWalkComplete` is fed the **chosen fraction pair**, so the success reading fires at `3/3 ready` ([P03]) and still at plan completion for run-less generations. Its rule is unchanged and its existing test (`tugdeck/src/components/tugways/__tests__/dash-walk-complete.test.ts`) stays valid.

**Spec S04: The ring's scope band** {#s04-scope-band}

`TugStepRing` gains one optional prop and one segment state. Nothing else about it moves.

```ts
/** The declared run's span within the plan, both 1-based and inclusive.
 *  Absent when no run is declared — the ring then renders as it always has. */
scope?: { from: number; through: number };
```

Segment state, per step `s` in `1..=total`, replacing today's three-way `done | current | todo`:

| Condition | `data-state` | Paint |
|---|---|---|
| `scope` present and `s < scope.from` or `s > scope.through` | `outside` | the whisper — the faintest tone on the ring, well below `todo` |
| `s < shown` | `done` | filled, ring's tone |
| `s === shown` | `current` | filled, breathing ([L13] — CSS animation) |
| otherwise | `todo` | the existing toned-back unfilled state |

`shown` keeps its present meaning (`complete ? total + 1 : current`), so a complete run fills its whole band. The `complete` prop still forces the success tone.

Two consequences worth stating because they are easy to get wrong:

- **`total` becomes the plan total on a scoped ring**, so a 10-step plan draws ten segments where today it draws the run's. `TUG_STEP_RING_SEGMENT_MAX` (16) governs whether per-step gaps are drawn at all; past it the ring is one continuous arc and the scope band still paints as an arc, which is the correct degradation for a 24-step plan.
- **The `aria-label` is where the words go**, since they cost nothing there. When `scope` is absent or covers the whole plan, the label keeps today's exact spelling — `step {current} of {total}` — which preserves the existing `"step 1 of 1"` assertions in `at0407` and `at0424` unchanged, because those fixtures run a one-step plan `--through 1`. When `scope` is a proper subset, the label reads `step {runPos} of {runLen} in this run, steps {from}–{through} of {total}`. `TugStepFraction`'s own label follows the same rule against the pair it was handed.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `run_position`/`run_length` on the wire entry | external store data | existing `CHANGESET_ALL` aggregate via `useChangesetAll` / `useDashForSession` (`useSyncExternalStore`) | [L02] |
| chosen fraction pair | local-data (derived at render) | pure `dashGlanceFraction` over props; no state held | [L02] |
| ring segment state, `outside` included | appearance | `data-state` on each `<path>`, painted by `tug-step-ring.css` — never a style object, never React state | [L06] |
| the current segment's breathing | appearance | CSS animation already in `tug-step-ring.css` | [L13] |

No new stores, no new subscriptions, no structural state. `TugStepRing`/`TugStepFraction` are composed, never re-implemented ([L20]); the `.tsx`/`.css` pair and `data-slot` discipline are unchanged ([L19]).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `DashDeclarations::run_first` | field | `tugrust/crates/tugdash-core/src/dash.rs` | latched in the `read_declarations` fold (Spec S01) |
| `run_fraction` | fn | `tugrust/crates/tugdash-core/src/dash.rs` | pure; the only place the arithmetic lives ([P02]) |
| `DashDetail::{run_position, run_length}` | fields | `tugrust/crates/tugdash-core/src/ops.rs` | stamped beside `run_through`/`run_complete` |
| `DashStatus::{run_position, run_length}` | fields | `tugrust/crates/tugdash-core/src/ops.rs` | `Option<i64>`, stamped in `status_in` |
| `DashChangesetEntry::{run_position, run_length}` | enum-variant fields | `tugrust/crates/tugcast-core/src/types.rs` | `DashChangesetEntry` is a **variant**, not a struct; copy the neighbors' `#[serde(default, skip_serializing_if = "Option::is_none")]` (Spec S02) |
| feed forwarding | edit | `tugrust/crates/tugcast/src/feeds/changeset.rs` | beside the `step_current` forward |
| `DashChangesetEntry.run_position?/run_length?` | fields | `tugdeck/src/lib/changeset-types.ts` | + validator clauses |
| `DashSessionFact::{runPosition, runLength}` | fields | `tugdeck/src/lib/dash-session-index.ts` | projected in `buildDashSessionIndex` |
| `dashGlanceFraction` | fn | `tugdeck/src/components/tugways/dash-meta-line.tsx` | Spec S03; beside `dashWalkComplete` |
| `TugStepRingProps.scope` + `outside` state | prop + render | `tugdeck/src/components/tugways/tug-step-ring.tsx` | Spec S04; the segment `data-state` ternary becomes a four-way |
| `.tug-step-ring-seg[data-state="outside"]` | CSS rule | `tugdeck/src/components/tugways/tug-step-ring.css` | the whisper tone, below `todo` ([L06]) |
| `SessionStepRing` scope pass-through | edit | `tugdeck/src/components/tugways/session-step-ring.tsx` | forwards `scope` to the `TugStepRing` it wraps |
| `SessionIdentityRow` adoption | edit | `tugdeck/src/components/tugways/session-identity-row.tsx` | one component, three mounts (Table T01): fraction takes the run pair, `SessionStepRing` takes plan pair + scope |
| `DashMetaLine` adoption | edit | `tugdeck/src/components/tugways/dash-meta-line.tsx` | same split, at both `2xs` and `sm` |
| `recordStampedPlan` rows option | edit | `tests/app-test/dash-fixture.ts` | today writes a 1-row plan and passes `--through 1`; gains a row count + through so a fixture can declare a partial run |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md`: one new global decision recording the whole display policy — the numerals count the run, the ring draws the plan with the run as a lit band, the completed run holds its face ([P03]), and no row gains a word — amending the display half of [D147]'s world (Step 6 states the exact framing; the number is whatever is next when the step lands).
- [ ] Doc comments on the new fields say which question each pair answers (run vs plan), so the next reader of the wire type does not re-conflate them.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | fold + arithmetic table tests over hand-written dash-logs | Spec S01 edge cases: legacy log, mid-plan run, completed run, reversed-order degenerate, terminal reset, same-through edge |
| **Unit (Rust, serialization)** | wire absence/presence | Spec S02's absent-when-none clauses |
| **Unit (TS)** | validator, index projection, `dashGlanceFraction` table | Spec S03 preference rule |
| **App-test** | the pins: real dash, real plan, real surfaces, real painted segments | Step 5; selective per `@covers` |

#### What stays out of tests {#test-non-goals}

- No render-DOM unit tests of the components — banned shape; the app-test pins cover the painted result.
- No app-test sweep — the named files only, per the selective-run doctrine.
- The ring's arc geometry — `arcPath` and the box/stroke maths are untouched by this plan; only the per-segment `data-state` changes, and that is what Step 5 counts.
- The `outside` state's exact tone — a token choice, judged by eye against the six themes, not asserted. What *is* asserted is that the right number of segments carry the state.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The run span: fold + `run_fraction` in tugdash-core | done | `4e2d82c9f` |
| #step-2 | The pair reaches the wire: DashDetail, DashStatus, feed | done | `9055cb5c2` |
| #step-3 | Client truth: wire mirror, session index, `dashGlanceFraction` | done | `b944f4c3c` |
| #step-4 | The ring takes the plan's shape; the numerals take the run | done | `bb22dd25a` |
| #step-5 | App-test pins: the multi-step declared run | done | `f1b706d4f` |
| #step-6 | Doc sync + integration checkpoint | done | `ea4c49ca2` |

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
- [ ] `bun test` unit tables: validator accepts absence/presence and rejects non-numbers (`tugdeck/src/__tests__/changeset-types.test.ts`); index projection carries the pair (`tugdeck/src/components/lens/sections/__tests__/cards-data-source.test.ts` is the existing home for index-shaped assertions); `dashGlanceFraction` — run pair wins, plan pair falls back, both absent → null — in a new table beside `tugdeck/src/components/tugways/__tests__/dash-walk-complete.test.ts`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test`

---

#### Step 4: The ring takes the plan's shape; the numerals take the run {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(run-span): the ring lights the run's band across the plan; the numerals count the run`

**References:** [P01], [P03], [P04], [P05], Spec S03, Spec S04, Table T01, (#t01-surfaces, #s04-scope-band)

**Artifacts:**
- `TugStepRing`'s `scope` prop and `outside` segment state + its CSS rule; the two shipping components handing each mark its own pair.

**Tasks:**
- [ ] `tug-step-ring.tsx`: add the optional `scope` prop; replace the three-way segment `data-state` ternary with Spec S04's four-way; extend the `aria-label` rule (whole-plan scope or none keeps today's exact spelling, so existing pins hold).
- [ ] `tug-step-ring.css`: paint `[data-state="outside"]` as the whisper, below `todo` ([L06]) — tokens only, no hex ([L15]).
- [ ] `session-step-ring.tsx`: forward `scope` through to the wrapped `TugStepRing`.
- [ ] `session-identity-row.tsx` (one component, three mounts — Table T01): `TugStepFraction` gets `dashGlanceFraction`'s pair; `SessionStepRing` gets the plan pair plus `scope`; `dashWalkComplete` gets the chosen fraction pair so the success tone fires at run completion ([P03]).
- [ ] `dash-meta-line.tsx` (`DashMetaLine`, both `2xs` and `sm`): the same split, for both the bound (`SessionStepRing`) and unbound (`TugStepRing`) branches.
- [ ] Leave `dash-facts.tsx` alone — spike-only (Table T01).

**Tests:**
- [ ] None new at this layer — no render-DOM unit tests (banned shape); the painted result is pinned in Step 5.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`

---

#### Step 5: App-test pins: the multi-step declared run {#step-5}

**Depends on:** #step-4

**Commit:** `tests(run-span): a 1–2 run on a 3-row plan pins the run's numerals and the ring's band`

**References:** [P01], [P03], [P04], [P05], Spec S03, Spec S04, Table T01, (#success-criteria, #s04-scope-band)

**Artifacts:**
- `recordStampedPlan` (`tests/app-test/dash-fixture.ts`) gains a ledger-row count and a `--through` value; extended pins in at0424 and at0407.

**Tasks:**
- [ ] Extend `recordStampedPlan` so a fixture can write an N-row plan and open step 1 with `--through m < N`. Today it writes the one-step `FIXTURE_PLAN` and passes `--through 1`; keep that the default so every existing caller is unaffected.
- [ ] Extend `at0424-lens-dash-line.test.ts` (`@covers` already spans `session-identity-row.tsx`, `session-step-ring.tsx`, and `tug-step-ring.tsx`): a 3-row plan run `--through 2` pins fraction text `1/2`, **3** ring segments, and segment `data-state` counts of one `current`, one `todo`, one `outside`. After `step done 2`, the cluster holds `2/2` with the success reading ([P03]).
- [ ] Extend `at0407-lens-dashes-section.test.ts` (`@covers` already names `dash-meta-line.tsx` and `tug-step-ring.tsx` — this is the Lens **Dashes** row, which is `DashMetaLine`, not `dash-facts.tsx`): the same fixture pins row fraction `1/2` and the same three-way segment census.
- [ ] Leave the existing `ringLabel === "step 1 of 1"` assertions in both files untouched and green — their fixtures run a one-step plan `--through 1`, where scope covers the whole plan and Spec S04 keeps today's spelling. If either goes red, the label rule was implemented wrong, not the pin.
- [ ] Confirm the untouched single-step pins (at0405, at0406) still read the same numbers — run == plan there, by construction.

**Tests:**
- [ ] The extended at0424 and at0407 assertions above, including the `outside`-segment census that is the only proof [P04] painted anything.

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

**Deliverable:** Every dash-progress counter in the app answers "how far through what was asked" — the declared run — while the ring beside it draws the whole plan with the run's steps lit as a band, so the larger shape is legible without a single added word or pixel of height. Derived once server-side, pinned by app-tests.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] A `Steps 1–3` invocation against a 10-step plan shows `1/3` on the masthead and every Lens/shade counter (at0424/at0407 pins).
- [ ] The same dash's ring shows ten segments, three of them the run's band and seven `outside` ([P04]/Spec S04 pin).
- [ ] No row anywhere gained a word or grew in height ([P04]).
- [ ] A finished run holds `3/3` in the success tone while `ready` ([P03] pin).
- [ ] Run-less generations render exactly as before ([P05]; at0405/at0406 unchanged).
- [ ] Full workspace `cargo nextest run`, tugdeck `tsc`/`vite build`/`bun test`, and the Step 5 app-test selection all green.

**Acceptance tests:**
- [ ] `just app-test tests/app-test/at0424-lens-dash-line.test.ts tests/app-test/at0407-lens-dashes-section.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Delete `DashFactsRun` and `dash-facts.tsx`, or graduate them — the component ships in the tree but only `spike-dash-progress.tsx` mounts it, which this plan discovered and deliberately left alone (Table T01).
- [ ] Further graphical treatment for the step list beyond the scope band — the wider height-neutral progress exploration this plan pulls one piece of forward.
- [ ] Surfacing the run's *step titles* (not just the count) on a roomy surface, e.g. the shade's expanded dash fold.

| Checkpoint | Verification |
|------------|--------------|
| run span derived and forwarded | `cargo nextest run -p tugdash-core -p tugcast-core -p tugcast` |
| surfaces agree | Step 5 app-test selection |
| doctrine recorded | design-decisions.md entry cites [D147] |
