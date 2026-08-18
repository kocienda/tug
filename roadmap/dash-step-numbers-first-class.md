<!-- devise-skeleton v5 -->

## Dash Step Numbers First-Class {#dash-step-numbers-first-class}

**Purpose:** A session's dash line in the Lens always shows the plan's step counters — `step i/N` and the current step's title — because the state dir they travel through is canonical per repository instead of per path spelling; the session identity line elides the callsign first (middle-truncated) so custom names and dash names survive a squeeze; and both displays become tunable in CSS alone, so the next typography round is a token edit rather than a plan.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | tugdash/step-numbers |
| Last updated | 2026-08-17 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-17, fable.** Reviewed `plan:9046b614c1fef01f`. Lint: 0 errors, 1 warning (the missing-record warning this section discharges).
Oriented on: first pass — the whole document, judged against the real code (`paths.rs`, `dash.rs`, `ops.rs`, `changeset.rs`, `changeset-types.ts`, `dash-session-index.ts`, `dash-facts.tsx`/`.css`, `dashes-section.tsx`, `cards-session-cell.tsx`, `session-identity.ts`, `tug-session-identity.tsx`/`.css`).
Applied: holes — [P02]'s merge-then-rename ordering failed open (a pre-fix binary recreating the alias dir after a taken `-premerge` name would trigger a canonical-log rewrite on every call); reworked to claim-first rename with numbered suffixes, the rename as the lock, with the crash window named as residual (R02 updated to match). Blast radius — `dashes-section.tsx` hand-renders the same `lens-dashes-*` classes with a preformatted steps string, so Step 5's wording rules are now scoped under the `data-slot` attribute only the rewritten `DashFactsRun` carries, keeping the Unbound row out of the diff. Technical accuracy — Spec S02/[P08] corrected to the literal `":"` separator text node the component actually renders (not `" : "`); [P07]/Step 6 gained the `max-inline-size` pathological cap on the dash run, since a fully incompressible run pushes its neighbors (the bug shape the atom's own authoring comment documents); Step 5's indent knob application moved onto the scoped container in `dash-facts.css`, off `cards-session-cell.tsx`. Verified against code: `plan_path?: string` exists on the deck wire type with a validator arm, so [P06]'s `hasPlan` is derivable; every `project_state_dir` caller funnels through the one gateway, so [P01] needs no reader changes. Tuglaws cross-check: [L02] honored — no new stores, facts ride the existing `useChangesetAll` subscription; [L06] honored — all new display state is data attributes + CSS custom properties, no React state; [L16] — Steps 5–6 keep `@tug-pairings`/`@tug-renders-on` headers current; [L20] — knobs are the component's own, defaults at point of use; the State Zone Mapping covers all three new state pieces.
Deferred: nothing — no open questions remain.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The step-counter display machinery already exists end-to-end: `tugutil dash step start|done` appends `step-start`/`step-done  i/N <title>` declarations to the per-project dash-log, `read_declarations` (`tugrust/crates/tugdash-core/src/dash.rs`) derives `step`, `step_title`, and the stage from them, `dash_detail_entries_in` (`tugrust/crates/tugdash-core/src/ops.rs`) carries them onto the detail struct, `dash_entries` (`tugrust/crates/tugcast/src/feeds/changeset.rs`) maps them onto the wire `ChangesetEntry::Dash`, `buildDashSessionIndex` (`tugdeck/src/lib/dash-session-index.ts`) projects them per session, and `DashFactsRun` (`tugdeck/src/components/lens/sections/dash-facts.tsx`) renders them as the fourth line of the session's row in the Lens Cards section (`cards-session-cell.tsx`).

It fails anyway, for a reason none of those layers can see: **the state dir is keyed by path spelling, not by repository.** `project_slug` (`tugrust/crates/tugutil-core/src/paths.rs`) is a bare string-replace over whatever `repo_root` spelling the caller holds. This machine has two live spellings of one repo — the app's workspace is registered as `/u/src/tugtool` while CLI calls run from `/Users/kocienda/Mounts/u/src/tugtool` — so two state dirs exist under `~/Library/Application Support/Tug/projects/` (`-u-src-tugtool` and `-Users-kocienda-Mounts-u-src-tugtool`). Every step declaration of a recent nine-step run landed in the second; the running app read the first, found zero declarations, and rendered the dash line as a bare lifecycle stage in 2xs type — state only, no counters, no title. See [#split-brain-evidence](#split-brain-evidence) for the forensic detail, including the macOS firmlink asymmetry that makes bare `canonicalize` insufficient.

Two display problems ride along. First, even when the counters arrive, `dash-facts.css` sets them at `--tug-font-size-2xs` muted — a whisper for the one fact the line exists to carry — and every wording, size, and spacing decision is baked into TypeScript (`dash-session-index.ts` preformats the string `` `step ${current}/${total}` ``), so a design pass requires a code plan. Second, the identity line's elision rule is the opposite of the intended one: `tug-session-identity.css` declares "the name elides, the callsign survives" for the line tier, and its title-box clamp makes the *dash run* pay first. The intended rule: the callsign is the first run to give way, middle-truncated, with the custom name and the dash name preserved.

#### Strategy {#strategy}

- Fix the data before the display: canonicalize the repo root at the one gateway every state-dir path goes through (`project_state_dir`), then reconcile the alias dirs already on disk so history written under a stray spelling is not orphaned.
- Un-bake the display decisions from TypeScript: the components' job becomes putting every fact into the DOM (spans with stable slots, data attributes, numeric CSS custom properties); the CSS's job becomes deciding everything visible — wording via `::before` content, sizes and gaps via knob custom properties with `var(--knob, default)` fallbacks at point of use.
- Make degradation loud: a dash with a plan but no step declaration says so explicitly instead of silently dropping to a bare stage word — silent degradation is exactly how the split-brain went unnoticed.
- Flip the line-tier elision priority in CSS, with the one piece CSS cannot do (middle truncation) supplied by a head/tail span split computed in one pure function.
- Sequence Rust-first so the deck steps can be verified against real data in the running app.

#### Success Criteria (Measurable) {#success-criteria}

- `project_state_dir` returns the identical path for `/u/src/tugtool` and `/Users/kocienda/Mounts/u/src/tugtool` (unit test with two spellings of one temp repo via symlink; live check with `tugutil state-dir` from both cwds).
- After reconciliation, the canonical dash-log contains the union of both alias logs' lines in timestamp order, and the alias dir no longer shadows it (unit test over fixture dirs).
- A session bound to a dash with an open step shows `step i/N` and the step title in the Lens Cards row, readable at default knob values (app-test asserts `data-step-current`/`data-step-total` and visible text; live read after `just build-app`).
- A dash with a `plan_path` and no step declaration renders an explicit missing-step fact, not a bare stage (app-test).
- Under a width squeeze, the identity line's callsign run ellipsizes while the name span and dash run render untruncated (app-test compares `scrollWidth`/`clientWidth` per span).
- Changing the counters' size, the line's indent, or the `step` wording requires editing only `dash-facts.css` (verified by inspection at review: no TS string concatenation of display text remains).
- `bun run audit:theme-contrast` stays within the brio budget after the typography changes.

#### Scope {#scope}

1. Canonical repo-root resolution in `tugutil-core::paths`, with firmlink normalization and alias-dir reconciliation.
2. Raw step numbers through `dash-session-index` and `DashFactsRun`; the facts-in-DOM contract (Spec S01) on the Cards-section dash line.
3. The knob sheet and new typography defaults in `dash-facts.css` (Table T01).
4. The explicit missing-step state.
5. Line-tier elision flip with callsign middle-truncation in `tug-session-identity.tsx` / `.css` and `session-identity.ts`.
6. App-test updates (at0424, at0407 selectors if touched) and new coverage (at0439).

#### Non-goals (Explicitly out of scope) {#non-goals}

- The session *phase* dot (working/paused) and its stuck-state robustness — that is `session_synopsis`/`observer` territory in tugcast, a different subsystem from the dash lifecycle stage; it deserves its own diagnosis rather than a rider step here.
- Redesigning the Unbound Dashes section row — it composes its own pieces by design (`dashes-section.tsx`); it inherits the shared `DashReviewMark` and can adopt the knob idiom later.
- The chip (atom) tier's elision rule — it already elides the callsign first and stays as-is.
- Enforcement that a plan *must* carry step numbers at authoring time — `tugutil plan lint` (PL026/PL027) and `dash step`'s strict-parse refusals already hold that line.

#### Dependencies / Prerequisites {#dependencies}

- `tugutil` rebuilt (`cargo build -p tugutil`) before any live verification — `~/.local/bin` symlinks point at main's debug build.
- App-tests require `just build-app` first for the Rust changes to be present in the harness bundle.

#### Constraints {#constraints}

- `-D warnings` across the Rust workspace; TypeScript must pass `bunx tsc --noEmit`; `bunx vite build` before declaring deck work done.
- Tuglaws: [L02] stores enter React via `useSyncExternalStore` (already satisfied — no new stores); [L06] appearance via CSS/DOM, never React state; [L16] every foreground rule declares its surface (`@tug-renders-on`); [L20] token sovereignty. Name the laws in each deck round's commit body.
- CSS knob defaults go in `var(--knob, default)` at point of use, never declared on the component's own element.
- No banned test shapes: no jsdom/happy-dom, no RTL, no mock-store assertions.

#### Assumptions {#assumptions}

- The dash-log grammar is stable: four `  `-separated fields, append-only, generation reset at terminal lines (`is_terminal`).
- `~/Library/Application Support/Tug/projects/<slug>/` holds only per-project runtime state (dash-log.md, join-journal-*.json) — plain files, not SQLite ledgers, so file-level merge is safe.
- Claude Code's own `~/.claude/projects/<slug>` scheme is mirrored in *format* only; nothing joins Tug's slug against Claude's, so canonicalizing Tug's slug cannot desynchronize an integration (verified: `external_sessions.rs` resolves Claude's root independently).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v5 conventions: explicit `{#anchor}` on every cited heading, `[P##]` for plan-local decisions, `[Q##]` open questions, `S##` specs, `T##` tables, `R##` risks, `**Depends on:**` lines with `#step-N` anchors, and `**References:**` lines citing labels and anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None. The design questions this plan raised were settled in-session with the user (elision priority, middle truncation, tunability architecture) or have conventional answers recorded as decisions ([P02] merge disposition, [P08] split point).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Canonicalization changes slugs under tempdirs (R01) | med | high | writers and readers share the one gateway | a Rust test hand-builds a state path |
| Concurrent reconciliation (R02) | med | low | line-union merge is idempotent; rename claims the alias | reconciliation test flakes |
| Filter highlight spans the head/tail split (R03) | low | med | split first, highlight each half | highlight test regression |
| Elision assertions vs page zoom (R04) | low | low | ratio-based assertions per the harness doctrine | at0439 flakes on a zoomed bundle |
| Contrast audit regression (R05) | low | med | run the audit in the CSS step's checkpoint | audit failure |

**Risk R01: Canonicalization moves slugs out from under tests** {#r01-tempdir-slugs}

- **Risk:** macOS `canonicalize` maps `/var/folders/…` tempdirs to `/private/var/folders/…`, so any test that composes a state path by hand from the raw tempdir spelling stops matching what the code writes.
- **Mitigation:** every existing test already goes through `project_state_dir` for both write and read (verified: `dash.rs`, `ops.rs`, `replay.rs`, `draft_engine.rs` test fixtures all call it); the nonexistent-path fallback keeps `slug_mirrors_claude_projects_scheme` green.
- **Residual risk:** a future test that hand-builds the path will fail immediately and loudly, which is the acceptable failure mode.

**Risk R02: Two processes reconcile the same alias at once** {#r02-concurrent-merge}

- **Risk:** the app and a CLI call could both discover the alias dir and reconcile simultaneously, or a pre-fix binary could recreate the alias after reconciliation.
- **Mitigation:** the claim-first rename ([P02]) is the lock — atomic, so exactly one caller merges each alias incarnation; a recreated alias gets a numbered claim name and its own single merge; the line-union merge makes even a hypothetical double merge converge.
- **Residual risk:** a crash between claim and merge leaves data unmerged but intact at the `-premerge` name; recoverable by hand ([P02] implications).

**Risk R03: `renderFilterHighlight` across the callsign split** {#r03-highlight-split}

- **Risk:** the callsign run is filter-highlighted (`renderFilterHighlight(title.callsign, highlight)` in `tug-session-identity.tsx`); a match that straddles the head/tail boundary must not be lost.
- **Mitigation:** split the string first ([P08]), then run `renderFilterHighlight` on each half independently — a straddling match highlights as two adjacent fragments, visually identical.
- **Residual risk:** none observable; the fragments abut with no gap.

**Risk R04: Elision measurement vs page zoom** {#r04-zoom-measurement}

- **Risk:** a stray persisted page zoom makes pixel comparisons lie in app-tests.
- **Mitigation:** assert `scrollWidth > clientWidth` (truncated) and `scrollWidth <= clientWidth` (intact) — ratios of the same element, immune to zoom.
- **Residual risk:** sub-pixel rounding at exactly-fitting widths; the fixture uses a pane width that forces a decisive squeeze.

**Risk R05: Bigger counters break a theme's contrast budget** {#r05-contrast}

- **Risk:** promoting the counters' size/weight changes the audited pairings in `dash-facts.css`.
- **Mitigation:** keep the counters on the existing audited token pairs (`--tug7-element-global-text-normal-rest` / `-muted-rest` on the primary surface); run `bun run audit:theme-contrast` in the CSS step's checkpoint.
- **Residual risk:** none if the pairings hold; a new pairing would need the `@tug-pairings` header updated.

---

### Design Decisions {#design-decisions}

#### [P01] The repo root is canonicalized at the state-dir gateway, nowhere else (DECIDED) {#p01-canonical-gateway}

**Decision:** `project_slug` resolves its input through a new `canonical_repo_root` — `std::fs::canonicalize` with fall-back to the raw path when resolution fails, then the macOS data-volume firmlink prefix `/System/Volumes/Data` stripped when present — and every caller of `project_state_dir` inherits the fix without change.

**Rationale:**
- The spelling mismatch is fixed at the key's one gateway, per the standing rule against canonicalize-both-sides tolerance shims — no reader or writer gains a compatibility branch.
- Bare `canonicalize` is not enough: `realpath(/u/src/tugtool)` yields `/System/Volumes/Data/Users/kocienda/Mounts/u/src/tugtool` while `realpath(/Users/kocienda/Mounts/u/src/tugtool)` yields `/Users/kocienda/Mounts/u/src/tugtool` — the firmlink makes two canonical spellings of one directory. `tugcore::registry::find_for_cwd` documents the same asymmetry. Stripping the firmlink prefix collapses them; on non-macOS the prefix never matches and the strip is a no-op.
- The fall-back to the raw path on `canonicalize` failure preserves behavior for not-yet-existing paths and keeps `slug_mirrors_claude_projects_scheme` true.

**Implications:**
- On this machine the canonical slug for the tugtool repo becomes `-Users-kocienda-Mounts-u-src-tugtool` (the dir already holding the full dash history); `-u-src-tugtool` becomes an alias to reconcile ([P02]).
- The `tugutil state-dir` command reports the canonical dir from any spelling.

#### [P02] Alias state dirs are reconciled by line-union merge, then renamed aside (DECIDED) {#p02-alias-reconcile}

**Decision:** when `project_state_dir` computes a canonical slug that differs from the raw spelling's slug and a directory exists under the raw slug, it reconciles that alias into the canonical dir — **claim first, then merge**: rename the alias to `<slug>-premerge` (numbered suffix `-premerge-2`, `-premerge-3`… when the name is taken), and only then merge *from the claimed dir* — dash-log lines unioned (exact-duplicate lines dropped) and sorted by their leading ISO-8601 timestamp, every other file copied only if absent from the canonical dir. The claimed dir is left in place afterwards as the verbatim record.

**Rationale:**
- The alias dirs on disk hold real history (a full nine-step run's declarations in one, a `replayed` line in the other); orphaning either silently loses the record the fix exists to protect.
- The dash-log grammar sorts correctly on its leading timestamp field, and `read_declarations` is order-driven, so a merged log reads as if one writer had written it.
- **The rename is the lock, so it must come first.** Merge-then-rename fails open: a binary built before this change (the running app until its next rebuild, the `~/.local/bin` symlinked tugutil until `cargo build`) keeps writing under the raw slug and *recreates* the alias dir after the rename — and if the rename target already exists, a merge-then-rename ordering would then merge on every single call forever, rewriting the canonical log each time and waking every file watcher on it. Claim-first bounds each alias incarnation to exactly one merge, and the numbered suffix lets a recreated alias be claimed again.
- The check costs nothing in the common case: raw slug == canonical slug short-circuits before any filesystem probe.

**Implications (failure windows):**
- A crash between the claim and the merge leaves the data unmerged but intact at the `-premerge` name — recoverable by hand, never destroyed. This window is milliseconds wide and the residual is acceptable.
- Concurrent callers race on the rename; the loser's rename fails and it stops — the winner's merge carries the data.

**Implications (placement):**
- `project_state_dir` acquires a side effect on the cold path. That is deliberate: it is the *only* choke point every reader and writer shares, and a reconciliation done anywhere else leaves a window where a reader sees the pre-merge canonical dir.
- The merge handles `dash-log.md` specially (line union) and everything else (`join-journal-*.json`) by copy-if-absent — journals are keyed per dash name and a canonical copy, if one exists, is newer by construction.
- Until the app is rebuilt and the `~/.local/bin` tugutil symlink points at a rebuilt binary, stale writers can keep minting alias dirs; each is claimed and merged on the next canonical-binary touch, so the steady state converges without coordination.

#### [P03] The wire and the index carry raw step numbers; formatting is CSS's job (DECIDED) {#p03-raw-numbers}

**Decision:** `DashSessionFact` replaces its preformatted `steps: string | null` with `stepCurrent: number | null` and `stepTotal: number | null`; `DashFactsRun` takes the numbers; the visible wording (`step `, the `/`) is produced by CSS `::before`/`::after` content on the fact spans, never by TypeScript string concatenation.

**Rationale:**
- A preformatted string is a design decision frozen in the data layer — changing "step 5/9" to "5 of 9" today means a TS edit and a replumb. With raw numbers in the DOM and wording in `content`, it is a one-line CSS edit.
- The Rust wire already carries raw `step_current`/`step_total` (`changeset-types.ts`); the preformatting happened only in `buildDashSessionIndex`, so this deletes a translation rather than adding one.

**Implications:**
- Consumers of `DashSessionFact.steps` (only `cards-session-cell.tsx` via `DashFactsRun`, plus the pure-logic tests over `buildDashSessionIndex`) update in the same step.
- Screen readers get the numbers via an `aria-label` on the counters span composed in TS — `content` text is unreliably exposed to AT, so the accessible name is set explicitly while the *visual* wording stays in CSS.

#### [P04] Every dash fact enters the DOM; CSS decides visibility, order, and wording (DECIDED) {#p04-facts-in-dom}

**Decision:** the dash line renders one span per fact with a stable `data-slot`, and its container carries machine-readable state as data attributes (`data-stage`, `data-step-current`, `data-step-total`, `data-review`, `data-step-missing`) plus numeric CSS custom properties (`--dash-step-current`, `--dash-step-total`) per Spec S01. A fact whose value is absent renders no span — except the missing-step fact, which exists precisely to make absence visible ([P06]).

**Rationale:**
- This is the tunability architecture: which facts show, in what order, at what size, with what wording — all pure CSS (`display`, flex `order`, knobs, `content`). The next design round on this row needs no plan.
- The numeric custom properties make future pure-CSS treatments possible (a progress meter is `calc(var(--dash-step-current) / var(--dash-step-total) * 100%)`).
- Data attributes are the app-test contract: assertions read attributes, not rendered text, so wording tuning never breaks a test.

**Implications:**
- The State Zone Mapping stays trivial: all of this is appearance ([L06]) over data already entering through the changeset-all store ([L02]).

#### [P05] One knob sheet, defaults at point of use (DECIDED) {#p05-knob-sheet}

**Decision:** every size, weight, gap, indent, and color in `dash-facts.css` reads a `--dash-line-*` knob through `var(--dash-line-x, <default>)` at the point of use, per Table T01; no knob is declared on the component's own element.

**Rationale:**
- Declaring defaults on the component element would make an outer override lose to specificity; the `var()` fallback idiom is the repo's standing rule for exactly this reason.
- A named knob inventory in the plan is what makes "tune it in CSS" true rather than aspirational — the reviewer can check every hard-coded value against the table.

**Implications:**
- The default *values* change too: counters move from `--tug-font-size-2xs` muted to `--tug-font-size-xs` in normal ink (`--tug7-element-global-text-normal-rest`), the step title stays muted at `xs`, and the line gains an indent knob aligning its text with the title run above.

#### [P06] A plan without a declared step is a loud state, not an empty one (DECIDED) {#p06-missing-step-loud}

**Decision:** when the entry carries a `plan_path` but no `step_current`, the dash line renders an explicit `data-slot="lens-dashes-step-missing"` span (empty element; wording via CSS `content`, default "no step declared") and the container sets `data-step-missing="true"`.

**Rationale:**
- The split-brain bug survived unnoticed because the degraded display was indistinguishable from a plan-less dash. A dash with a plan and no step is either a run that has not started or a data path that is broken — both are worth a visible word.
- Wording in `content` keeps even this tunable ([P04]).

**Implications:**
- `DashFactsRun` needs to know the plan exists: `DashSessionFact` gains `hasPlan: boolean` (from `entry.plan_path`).

#### [P07] Line-tier elision priority: callsign first, name second, dash never (DECIDED) {#p07-elision-priority}

**Decision:** on the line tier the callsign run is the first to give way, by middle truncation ([P08]); the name span yields only after the callsign is exhausted; the dash run (sigil + name) does not shrink while any other run can pay, but wears a `max-inline-size: 100%` cap with ellipsis as the pathological fallback — a run that refuses to fit at all pushes its neighbors, which the atom's own authoring comment already names as a bug shape distinct from the priority rule. The chip tier's existing rule is untouched.

**Rationale:**
- User-decided this session: the custom name and the dash name are the parts the reader must keep; the callsign is reconstructible from the tooltip, the atom, and every copy path.
- The current CSS says the opposite twice over — the title-box clamp makes the *dash* pay first, and the tier rule then elides the *name* — and the `sessionTitleParts` docblock in `session-identity.ts` already describes the new rule ("the callsign run is the one that ellipsizes and the name survives intact"), so this change also reconciles a live doc contradiction.
- The mechanism inverts the existing clamp idiom rather than inventing one: the dash run takes `flex: 0 0 auto`, the title box keeps its clamp, and *inside* the box the callsign's head span is the only shrinkable run until it is gone.

**Implications:**
- Docblocks stating the old rule must move with the code: the register comment in `tug-session-identity.css`, the component docblock in `tug-session-identity.tsx`, and the "dash gives way first" clamp comment.
- The masthead uses the line tier, so it inherits the flip — which is correct: the rule is the register's, not the mount site's.

#### [P08] Middle truncation = head/tail spans split at the callsign's first hyphen (DECIDED) {#p08-head-tail-split}

**Decision:** a pure function `callsignRunParts(callsign: string): { head: string; tail: string }` in `session-identity.ts` splits the callsign run at the first hyphen *after the last `/`* — for `tugtool/frothy-nurse-2`, head `tugtool/frothy-` and tail `nurse-2` — with the whole string as head and empty tail when no hyphen exists. The head span elides with `text-overflow: ellipsis`; the tail span is `flex: none`. The literal `":"` separator the callsign span already renders as its first text node stays where it is, ahead of the head span (Spec S02).

**Rationale:**
- CSS cannot middle-truncate; two spans — a shrinkable head and a fixed tail — are the standard technique, invisible when everything fits.
- The tail keeps the callsign's noun and any lineage suffix, the most scannable and most distinguishing part (`tugtool/fr…nurse-2`), while the project prefix and adjective absorb the squeeze.
- A pure function is unit-testable without a DOM and is the one place the split point lives.

**Implications:**
- `renderFilterHighlight` runs per half (Risk R03).
- An unnamed session's bare callsign fills the *name* span (per `sessionTitleParts`) and keeps end-truncating as today — the head/tail split applies only to the callsign run that follows a custom name.

---

### Deep Dives {#deep-dives}

#### The split-brain evidence {#split-brain-evidence}

Two state dirs exist for one repository on the author's machine:

- `~/Library/Application Support/Tug/projects/-Users-kocienda-Mounts-u-src-tugtool/dash-log.md` — holds the complete dash-vocab run: `created`, nine `step-start`/`step-done` pairs with titles, `built`, and the `joined via card` terminal. Written by `tugutil` invocations whose cwd was under `/Users/kocienda/Mounts/`.
- `~/Library/Application Support/Tug/projects/-u-src-tugtool/dash-log.md` — holds one `replayed` line for a different dash, written by the running app's base-motion engine, whose workspace is registered as `/u/src/tugtool`.

`project_slug` (`tugrust/crates/tugutil-core/src/paths.rs`) is `repo_root.to_string_lossy().replace(['/', '\\'], "-")` — no resolution of any kind. Every caller funnels through `project_state_dir` (verified: `dash.rs` append/read, `ops.rs` join journals, `replay.rs`, `base_motion.rs`, `draft_engine.rs`, `tugutil state-dir`), which is what makes the gateway fix sufficient.

The firmlink asymmetry, measured: `realpath /u/src/tugtool` → `/System/Volumes/Data/Users/kocienda/Mounts/u/src/tugtool`; `realpath /Users/kocienda/Mounts/u/src/tugtool` → `/Users/kocienda/Mounts/u/src/tugtool`. Both name one directory; `canonicalize` alone still yields two spellings. Hence the prefix strip in [P01].

Consequence chain in the app: `read_declarations` on the wrong dir returns `DashDeclarations::default()` → `dash_detail_entries_in` derives stage from git facts alone (`working`, since rounds exist) with `step_current`/`step_total`/`step_title` all `None` → the wire entry carries a bare stage → `buildDashSessionIndex` produces `steps: null` → `DashFactsRun` renders one small muted word.

#### The identity line's current anatomy {#identity-anatomy}

In `tug-session-identity.tsx` the line tier renders `.tug-session-identity-run` containing `.tug-session-identity-title` (which boxes `.tug-session-identity-name` and `.tug-session-identity-callsign`) followed by the dash run (`DashSigil` + name, slot `session-identity-dash`). `sessionTitleParts` (`session-identity.ts`) supplies the two title strings: a custom name, then ` : <project>/<callsign>`; with no custom name the callsign string *is* the name span's content and there is no callsign span.

The current squeeze order is produced by the title box's clamp (`flex: 0 0 auto; max-inline-size: 100%`): the dash run absorbs the whole deficit first, then the box is capped and the tier rule elides the *name* while `.tug-session-identity-callsign` is `flex: none`. The new order ([P07]) keeps the clamp idiom but re-aims it: dash run `flex: 0 0 auto` (never pays), callsign-head the only shrinkable span until exhausted, then the name's `max-width` cap lets it elide as the last resort.

#### Why reconciliation lives inside `project_state_dir` {#why-reconcile-in-gateway}

Alternatives considered: a one-shot `tugutil` migration command (leaves every other caller reading pre-merge state until someone runs it — the bug's window, institutionalized); reconciling in tugcast at workspace open (fixes the app but not CLI writers, so a Mounts-cwd `dash step` would recreate the alias dir before the next app launch). Only the shared gateway closes the window for every caller at once. The cost is bounded: the fast path (slugs equal, i.e. the caller already speaks canonically — true for canonical-cwd callers and all tempdir tests) is one string comparison; the slow path probes one directory that almost never exists.

---

### Specification {#specification}

**Spec S01: The dash line's DOM contract** {#s01-dash-line-dom}

Container: `<span class="lens-dashes-facts" data-slot="lens-dashes-facts">` carrying, when known: `data-stage="<stage>"`, `data-step-current="<i>"`, `data-step-total="<N>"`, `data-review="<state>"`, `data-step-missing="true"`, and inline style custom properties `--dash-step-current: <i>; --dash-step-total: <N>` (numbers, unitless). Child spans, in DOM order (visual order is CSS `order`'s to change):

| Slot | Content (TS) | Wording (CSS) |
|------|--------------|---------------|
| `lens-dashes-name` | dash display name, or omitted where the surface already names it | — |
| `lens-dashes-stage` | the stage word | — |
| `lens-dashes-step` | `<i>/<N>` text; `aria-label` "step i of N" | `::before { content: "step " }` |
| `lens-dashes-step-missing` | empty element, present only when `hasPlan` and no current step | `::before { content: "no step declared" }` |
| `lens-dashes-step-title` | the current step's title | — |
| `lens-dashes-review` | `DashReviewMark` (unchanged), paints per `dashReviewPaints` | — |

The `<i>/<N>` numerals stay TS-rendered text (not `content`) so they are selectable, searchable, and AT-visible; only the *wording around facts* is CSS.

**Spec S02: The callsign run's head/tail structure** {#s02-callsign-split}

Within `.tug-session-identity-callsign`, the existing literal `":"` text node stays first (the separator is the run's, so it disappears with the run — unchanged), followed by two child spans: `.tug-session-identity-callsign-head` (shrinkable, `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`) and `.tug-session-identity-callsign-tail` (`flex: none`). The callsign span itself becomes `display: inline-flex; align-items: baseline; min-width: 0`. Contents per [P08], each half filter-highlighted independently. When `tail` is empty the tail span is omitted and the head behaves as today's single span.

**Table T01: The dash-line knob inventory** {#t01-knobs}

| Knob | Default | Governs |
|------|---------|---------|
| `--dash-line-step-size` | `var(--tug-font-size-xs)` | counters font size |
| `--dash-line-step-weight` | `var(--tug-font-weight-semibold)` | counters weight |
| `--dash-line-step-color` | `var(--tug7-element-global-text-normal-rest)` | counters ink |
| `--dash-line-stage-size` | `var(--tug-font-size-2xs)` | stage font size |
| `--dash-line-title-size` | `var(--tug-font-size-xs)` | step-title font size |
| `--dash-line-muted-color` | `var(--tug7-element-global-text-normal-muted-rest)` | stage, title, missing ink |
| `--dash-line-gap` | `var(--tug-space-sm)` | inter-fact gap |
| `--dash-line-indent` | `0px` | line's leading indent |
| `--dash-line-name-size` | `var(--tug-font-size-sm)` | dash-name font size (roster use) |

Every rule in `dash-facts.css` that sets one of these properties reads the knob; the table is the review checklist.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| step counters, stage, missing-step visibility | appearance | data attributes + CSS custom properties on the row, styled in CSS | [L06] |
| dash facts source | external data (existing) | `useChangesetAll` → `useDashForSession` via `useSyncExternalStore` | [L02] |
| callsign head/tail split | pure render computation | pure function of props, no state | — |

No new stores, effects, or registrations.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at0439-identity-elision.test.ts` | line-tier elision priority + middle truncation, in the real app |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `canonical_repo_root` | fn | `tugrust/crates/tugutil-core/src/paths.rs` | canonicalize + firmlink strip + raw fallback ([P01]) |
| `reconcile_alias_state_dir` | fn | `tugrust/crates/tugutil-core/src/paths.rs` | line-union merge + rename-aside ([P02]) |
| `project_slug` / `project_state_dir` | fn (modify) | `tugrust/crates/tugutil-core/src/paths.rs` | route through the above |
| `DashSessionFact` | interface (modify) | `tugdeck/src/lib/dash-session-index.ts` | `stepCurrent`/`stepTotal: number \| null`, `hasPlan: boolean`; `steps` removed ([P03]) |
| `DashFactsRun` | component (modify) | `tugdeck/src/components/lens/sections/dash-facts.tsx` | Spec S01 contract ([P04], [P06]) |
| `callsignRunParts` | fn | `tugdeck/src/lib/session-identity.ts` | [P08] split, exported for tests |
| `.tug-session-identity-callsign-head` / `-tail` | CSS classes | `tugdeck/src/components/tugways/tug-session-identity.css` | Spec S02, [P07] priority flip |
| `--dash-line-*` knobs | CSS custom properties | `tugdeck/src/components/lens/sections/dash-facts.css` | Table T01 ([P05]) |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | canonicalization, firmlink strip, alias merge, idempotence | Steps 1–2 |
| **Unit (bun, pure)** | `buildDashSessionIndex` raw numbers, `callsignRunParts` split | Steps 3, 6 |
| **App-test** | the rendered dash line, the missing-step state, the elision priority | Steps 4, 6, 7 |

#### What stays out of tests {#test-non-goals}

- Fake-DOM render tests of `DashFactsRun` — banned shape; the DOM contract is asserted in the real app (at0424, at0439).
- Per-knob CSS value pins — the knobs exist to move; pinning defaults would make tuning break tests, defeating the plan's purpose. The *contract* (slots, attributes) is pinned instead.
- The live alias-dir reconciliation on the author's machine — verified once by hand at the integration checkpoint, not automated.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The canonical repo root at the state-dir gateway | done | `0eb87d8c9` |
| #step-2 | Alias state dirs reconcile into the canonical one | done | `40f29f4cf` |
| #step-3 | Raw step numbers through the session index | done | `9e544d020` |
| #step-4 | The dash line's facts-in-DOM contract | done | `daf757847` |
| #step-5 | The knob sheet and the new typography | done | `95aa5792b` |
| #step-6 | Callsign-first middle truncation on the line tier | done | `6f9b05e0e` |
| #step-7 | App-test coverage for the new contracts | done | `1a7158e54` |
| #step-8 | Integration checkpoint | done | `e2bf2c111` |

#### Step 1: The canonical repo root at the state-dir gateway {#step-1}

**Commit:** `tugutil-core(state-dir): one canonical state dir per repository, whatever the caller's path spelling`

**References:** [P01] canonical gateway, Risk R01, (#split-brain-evidence, #why-reconcile-in-gateway)

**Artifacts:**
- `canonical_repo_root` in `tugrust/crates/tugutil-core/src/paths.rs`; `project_slug` routed through it.

**Tasks:**
- [ ] Add `canonical_repo_root(repo_root: &Path) -> PathBuf`: `std::fs::canonicalize` falling back to the raw path on error; strip a leading `/System/Volumes/Data` component when present (component-wise, not string prefix, so `/System/Volumes/DataX` never matches).
- [ ] `project_slug` calls it before the replace; `project_state_dir` is otherwise unchanged.
- [ ] Update the module docs: the slug mirrors Claude's *format*, but the key is canonical per [P01].

**Tests:**
- [ ] Unit: a tempdir repo reached via a symlink produces the same slug as its real path.
- [ ] Unit: a nonexistent path falls back to its raw spelling (keeps `slug_mirrors_claude_projects_scheme` semantics).
- [ ] Unit: `/System/Volumes/Data/Users/x` and `/Users/x` produce one slug (pure prefix-strip test on the helper, no fs needed — expose the strip as a testable inner fn).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil-core`

---

#### Step 2: Alias state dirs reconcile into the canonical one {#step-2}

**Depends on:** #step-1

**Commit:** `tugutil-core(state-dir): an alias spelling's state dir merges into the canonical one, once`

**References:** [P02] alias reconcile, Risk R02, (#why-reconcile-in-gateway)

**Artifacts:**
- `reconcile_alias_state_dir` in `paths.rs`, invoked from `project_state_dir` when raw slug ≠ canonical slug.

**Tasks:**
- [ ] Implement claim-first per [P02]: rename the alias dir to `<slug>-premerge` (numbered suffix when taken; on rename failure — the concurrent-loser case — stop silently), then merge from the claimed dir: `dash-log.md` lines unioned (exact-line dedupe) and stably sorted by leading timestamp field; every other regular file copied only if absent in the canonical dir. The claimed dir stays as the record.
- [ ] Short-circuit before any fs probe when the slugs are equal.
- [ ] No logging: the `-premerge` dir is the record of a performed merge.

**Tests:**
- [ ] Unit (serial, `TUG_DATA_DIR` redirected like `dash.rs`'s `LogFixture`): alias with declarations + canonical with other lines → merged log in timestamp order, alias renamed aside.
- [ ] Unit: second call after reconcile is a no-op (idempotence).
- [ ] Unit: duplicate lines across both logs appear once.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil-core -p tugdash-core` (the dash.rs fixtures exercise the gateway on every append/read)

---

#### Step 3: Raw step numbers through the session index {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(dash-line): the session index carries raw step numbers and plan presence, not a preformatted string`

**References:** [P03] raw numbers, [P06] missing-step (data half), (#context)

**Artifacts:**
- `DashSessionFact.stepCurrent` / `stepTotal` / `hasPlan`; `steps` deleted.

**Tasks:**
- [ ] `buildDashSessionIndex` maps `entry.step_current ?? null`, `entry.step_total ?? null`, `hasPlan: entry.plan_path != null`.
- [ ] Update `cards-session-cell.tsx`'s `useSessionDashLine` to pass the new props.
- [ ] Update the pure-logic tests over `buildDashSessionIndex`.

**Tests:**
- [ ] bun: an entry with both counters yields numbers; one-sided or absent counters yield nulls; `plan_path` drives `hasPlan`.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` (from `tugdeck/`) and `bun test dash-session-index`

---

#### Step 4: The dash line's facts-in-DOM contract {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(dash-line): every dash fact enters the DOM — slots, data attributes, numeric custom properties — and absence of a declared step says so`

**References:** [P04] facts-in-DOM, [P06] missing-step, Spec S01, (#state-zone-mapping)

**Artifacts:**
- `DashFactsRun` rewritten to Spec S01; `dashes-section.tsx` untouched (it composes its own pieces).

**Tasks:**
- [ ] Container data attributes + inline `--dash-step-current`/`--dash-step-total` custom properties (via the `style` prop; numbers, unitless).
- [ ] Counters span renders `<i>/<N>` as text with `aria-label` "step i of N"; `step ` wording moves to CSS `::before`.
- [ ] `lens-dashes-step-missing` span when `hasPlan` and `stepCurrent === null`.
- [ ] Name the laws in the commit body ([L02], [L06]).

**Tests:**
- [ ] Covered in the app by at0424's updated assertions (Step 7); no fake-DOM tests.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` and `cd tugdeck && bunx vite build`

---

#### Step 5: The knob sheet and the new typography {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(dash-line): the dash line's whole design reads from --dash-line-* knobs, and the counters stop whispering`

**References:** [P05] knob sheet, Table T01, Risk R05, (#s01-dash-line-dom)

**Artifacts:**
- `dash-facts.css` rewritten: every value through its Table T01 knob; new defaults (counters `xs` semibold normal ink; stage `2xs` muted; title `xs` muted; indent via `padding-inline-start` on the scoped facts container).

**Tasks:**
- [ ] Apply Table T01 exactly; keep `@tug-pairings` and `@tug-renders-on` headers current ([L16]).
- [ ] **Scope every new rule under `[data-slot="lens-dashes-facts"]`** — the attribute only the rewritten `DashFactsRun` container carries (Spec S01). The Unbound Dashes row (`dashes-section.tsx`) hand-renders the same `lens-dashes-*` class names with a *preformatted* steps string, so an unscoped `.lens-dashes-step::before { content: "step " }` would render "step step 5/9" there. The legacy class-only rules stay as-is for that row; its adoption of the new contract is a follow-on (#roadmap).
- [ ] Wording rules, scoped as above: `::before { content: "step " }` on the counters span, `::before { content: "no step declared" }` on the missing span.
- [ ] The indent knob applies as `padding-inline-start: var(--dash-line-indent, 0px)` on the scoped facts container itself — no change in `cards-session-cell.tsx`.
- [ ] Elision priority within the line unchanged: name first, then title; counters and stage never shrink.

**Tests:**
- [ ] `bun run audit:theme-contrast` — no theme past the brio budget.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build && bun run audit:theme-contrast`

---

#### Step 6: Callsign-first middle truncation on the line tier {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(identity): the line tier elides the callsign first, from the middle — the name and the dash survive`

**References:** [P07] elision priority, [P08] head/tail split, Spec S02, Risks R03–R04, (#identity-anatomy)

**Artifacts:**
- `callsignRunParts` in `session-identity.ts`; head/tail spans in `tug-session-identity.tsx`; the flipped priority in `tug-session-identity.css`.

**Tasks:**
- [ ] Pure split per [P08]; filter highlight per half (Risk R03).
- [ ] CSS: dash run `flex: 0 0 auto` with the [P07] pathological cap (`max-inline-size: 100%`, ellipsis) on the line tier; callsign head the only shrinkable run until exhausted; name elides last via its width cap (the chip tier's existing clamp idiom, re-aimed); chip tier untouched.
- [ ] Move every docblock that states the old rule: the register comment in `tug-session-identity.css`, the component docblock in `tug-session-identity.tsx`, the clamp comment ("the dash gives way first"), and confirm `sessionTitleParts`'s docblock now matches reality.
- [ ] Name the laws in the commit body ([L06], [L16], [L19]).

**Tests:**
- [ ] bun: `callsignRunParts` — `tugtool/frothy-nurse-2` → `{head: "tugtool/frothy-", tail: "nurse-2"}`; hyphenless callsign → whole head, empty tail; separator stays in head.

**Checkpoint:**
- [ ] `bunx tsc --noEmit && cd tugdeck && bunx vite build && bun test session-identity`

---

#### Step 7: App-test coverage for the new contracts {#step-7}

**Depends on:** #step-4, #step-6

**Commit:** `app-test(at0424+at0439): the counters are on the line, absence is loud, and the callsign pays first`

**References:** Spec S01, Spec S02, [P06], [P07], Risk R04, (#success-criteria)

**Artifacts:**
- at0424 extended; new `tests/app-test/at0439-identity-elision.test.ts` with `@covers` for `tug-session-identity.tsx`, `tug-session-identity.css`, `session-identity.ts`.

**Tasks:**
- [ ] at0424: after the real `dash bind` and a real `dash step start --plan` (reuse `recordStampedPlan` from `dash-fixture.ts`), assert `data-step-current`/`data-step-total` on the facts container and visible `i/N` text; assert the missing-step span appears for a dash whose plan has no started step and disappears once one starts.
- [ ] at0439: a session with a long custom name + long callsign + bound dash in a narrow pane; assert callsign-head `scrollWidth > clientWidth`, name span and dash run `scrollWidth <= clientWidth`, tail span fully visible (ratio assertions per Risk R04).
- [ ] `just app-test-covers-check` passes.

**Tests:**
- [ ] The two files themselves.

**Checkpoint:**
- [ ] From the main checkout after landing (the harness refuses worktrees): `just app-test at0424-lens-dash-line.test.ts at0439-identity-elision.test.ts` — bare, unpiped. While on the worktree: `bunx tsc --noEmit` over `tests/app-test` and `just app-test-covers-check`.

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-1, #step-2, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria), [P01], [P02]

**Tasks:**
- [ ] `just ci` from the worktree.
- [ ] `just app-debug`; in the debug instance, bind a session to a fixture dash with a started step and read the row: counters visible at the new typography, title present, no missing-step span; then a plan-carrying dash with no started step shows "no step declared".
- [ ] `tugutil state-dir` from `/u/src/tugtool` and from `/Users/kocienda/Mounts/u/src/tugtool` print one path; the `-premerge` dir exists beside the canonical one after first touch.
- [ ] Squeeze a pane and read the identity line: `…` inside the callsign, name and ◊dash intact.

**Tests:**
- [ ] `cd tugrust && cargo nextest run` (workspace).

**Checkpoint:**
- [ ] `just ci` exit 0; the four live reads above, noted in the round summary.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** One canonical state dir per repository feeding a dash line that always says the step — `step i/N` and its title, loudly when present and loudly when a plan lacks one — under an identity line that keeps the user's words and the dash while the callsign gives way, all of it retunable from `dash-facts.css` and `tug-session-identity.css` alone.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Both path spellings resolve to one state dir; alias merged and set aside (`tugutil state-dir` from both cwds; `-premerge` present).
- [ ] The Lens Cards dash line shows counters + title on a live bound dash (`just app-debug` read).
- [ ] Missing-step state renders for a plan-carrying dash with no started step (at0424).
- [ ] Callsign middle-truncates first under squeeze; name and dash intact (at0439).
- [ ] No TS-composed display wording remains in the dash line (inspection against Spec S01/Table T01).
- [ ] `just ci` green; contrast audit within budget.

**Acceptance tests:**
- [ ] `just app-test at0424-lens-dash-line.test.ts at0439-identity-elision.test.ts at0407-lens-dashes-section.test.ts at0438-lens-unbound-dashes.test.ts` — from the main checkout, after landing, bare and unpiped.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] The session phase dot's stuck-paused diagnosis (`session_synopsis`/`observer`).
- [ ] The Unbound Dashes row adopting the knob idiom.
- [ ] A pure-CSS step progress meter off the numeric custom properties.

| Checkpoint | Verification |
|------------|--------------|
| canonical gateway | `cargo nextest run -p tugutil-core` |
| deck contracts | `bunx tsc --noEmit`, `bunx vite build`, `bun run audit:theme-contrast` |
| the app itself | the Step 8 live reads + acceptance app-tests |
