## Dash Cockpit {#dash-cockpit}

**Purpose:** Make dashes findable and visible without typing anything: the Lens Dashes section becomes the dash cockpit — always on, listing live dashes *and* the waiting paperwork (plan documents in the configured docs directory), with a "Start a dash…" affordance whose buttons produce prompts rather than run machinery — and the Z2 telemetry row's TASKS cell becomes a DASH cell while the bound session drives a dash, opening the dash's cockpit detail on click. Neither surface changes height.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-24 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-24, opus.** Reviewed `plan:6cfbc990d36a376d`. Lint: 0 errors, 0 warnings.
Oriented on: the whole document — a first pass, `rounds: 0`.
Applied: **compose site** — [P02] and Step 1 put the scan in `changeset.rs`'s existing `dash_entries` blocking hop, but `ProjectChangeset` is only ever constructed in `compose_aggregate`'s per-project loop in `changeset_all.rs`, one level up, where that hop cannot reach the field; corrected to its own `spawn_blocking` in that loop, which also preserves Risk R01's don't-block-the-runtime mitigation. **Root resolution** — that loop hands a `project_dir` that need not be the repo root, while `Config::load_from_project` wants the root and `PlanDocEntry.path` is root-relative, so a card opened on a subdirectory would have listed nothing silently; the scan now resolves through `repo_root_for` and a test pins it. **A missing suppression** — `dashes_hidden_for` hides the checkout's own dashes in app-test instances for a reason that holds verbatim for paperwork, and this repository declares `docs = "dash"` with several parseable plans, so every app-test instance's Lens would have listed them and any row-count assertion would have been coupled to the repo's own paperwork; added as [P08], reusing the existing gate rather than growing a second predicate. **A latent defect in Step 2** — `DashesSectionBody` derives one `populated` from the dash count and spends it twice, on the empty-state early return and on `setSectionContent`'s navigability, so a project with plans but no dashes would have rendered the empty state and never mounted a plan row; the redefinition is now a named task with an app-test pinning it. **Risk R02's predicate** — the plan reached for `canSubmit`, which is `(idle | errored) && online` and would have disabled every affordance during a live turn; `handleSend` actually *enqueues* a mid-turn send as a ghost row and drops only on `replaying`, so the rung is now exactly `phase !== "replaying"`, with the two-step store subscription named and pointed at `TelemetryBirthRow` in `session-masthead.tsx` as the working [L02] precedent. **A false rationale** — [P05] claimed Sessions already uses `headerActions`; no section does, so this is the hook's first consumer, and the band renders it only while expanded, both now stated. **Concreteness for a cold reader** — Risk R04 now names `makeDashScratchRepo` and its `opts.files` seam instead of gesturing at "the pattern at0438 uses"; Step 1 names `doc.steps.len()` and `ReviewState::as_str()`; Step 3 names the Lens rail's real width constants, because `TugSheet` is pane-modal and 320–420px is the column the form has to fit; Step 4 names `dashGlanceFraction`'s four arguments in the order the masthead already passes them; [P02] enumerates the golden fixture's five deck-side readers. **One gap closed in [P06]** — `SessionTelemetryStatusRowHandle.openTasks()` is `/tasks`'s entry point and must stay pointed at the `"tasks"` key while the cell reads DASH; without saying so, an implementer would plausibly "fix" the apparent inconsistency and break the command.
Deferred: nothing. Two design forks were raised as a dialog and both were settled in the plan: plan rows list every open project (matching what `dashRowsFromSnapshot` already does, and what the section's own doctrine says about inert rows), recorded in [P07]; and the Z2 click opens a placard in place rather than navigating, recorded in [P06].

---

### Phase Overview {#phase-overview}

#### Context {#context}

The back half of the dash arc is already machine-visible: a dash working a plan reads `implementing (i/N)` in the Lens and the Changes shade, the join arc arms itself, and the shade summons the user. The front half — a brief written, a plan devised, a plan reviewed but nobody implementing it — is invisible to every surface: a reviewed plan sits in the docs directory as a file only `ls` can find, and the only way to act on it is to *know* to type `/tugplug:dash-implement <path>`. The `/dash` orchestrator skill (landed in dash/dash-on-ramp.md) gave the arc one conversational entry point; this phase gives it graphical ones, holding the doctrine that buttons produce prompts and the model runs the arc — no button in this phase ever runs `tugutil` itself.

Much of what the original idea asked for has already landed while this phase waited. The Dashes section (`tugdeck/src/components/lens/sections/dashes-section.tsx`) is already always-visible (it registers with no `presence`, so the band never comes and goes), already renders each dash as a multi-line block (identity eyebrow + `DashMetaLine` + join register), and already references the bound session (the `WorkerAtom` mini identity on the eyebrow). The graphical numbered-step treatment already graduated from its design spike into shipping components: `TugStepRing` / `TugStepFraction` (`tugdeck/src/components/tugways/tug-step-ring.tsx`) and `SessionStepRing`, which `DashMetaLine` and the masthead identity row (`session-identity-row.tsx`, via `useDashForSession`) both compose. What remains — and what this plan builds — is exactly four things: (1) the docs-directory plan listing on the wire, (2) plan rows with next-gesture affordances in the Dashes section, (3) the "Start a dash…" sheet, and (4) the Z2 DASH cell with its cockpit-detail placard.

#### Strategy {#strategy}

- Backend first: put the docs-directory plan listing on the `CHANGESET_ALL` aggregate the Lens already reads, as a projection of files on disk — derived, never stored ([D138]).
- Reuse the existing dash-row grammar for plan rows: same section, same `TugListView`, a second cell kind — no new surface, no new store.
- Every affordance submits a prompt into a real session through the existing `CodeSessionStore.send()` path, targeted by the same followed-card ladder `resolveBindTarget` already established, with every refusal named ([L31]).
- The Z2 change is a relabel plus a placard, not a new cell: the TASKS box keeps its width budget and its anchor key, and the cockpit detail rides the existing one-placard-at-a-time apparatus.
- Keep pure logic pure: projections, ladders, and prompt templates are exported functions with table tests; the DOM proves only gestures and rendering, in app-tests.

#### Success Criteria (Measurable) {#success-criteria}

- A reviewed plan document sitting in the configured docs directory appears as a row in the Lens Dashes section with an Implement affordance; an unreviewed or stale one appears with a Review affordance (app-test; Rust unit tests for the scan).
- Pressing a plan row's affordance submits the corresponding `/tugplug:…` prompt into the Lens's followed session card and fronts that card; with no eligible followed card the affordance is disabled and names why (app-test for the gesture; bun table test for the ladder).
- "Start a dash…" is reachable both from the section band and from the empty state; submitting the sheet sends a `/tugplug:dash` prompt carrying the idea (and the name when given) into the followed session card (app-test).
- While the bound session drives a dash, the Z2 cell reads `DASH` with the dash name and the run fraction; clicking it opens a placard showing the dash's stage, step ring, current step title, divergence facts, and the numbered checklist (app-test).
- Neither the Lens section rows' one-line-per-fact grammar nor the Z2 row's height/width geometry changes: the status row's per-priority width table in `tug-status-cell.css` is untouched (code inspection at review; the app-test asserts the cell box width is unchanged between TASKS and DASH readings).
- `tugutil` is never invoked by any of the new controls — the only effects are `CodeSessionStore.send()` and card focus (code inspection; the gesture app-tests assert the transcript receives a user message).

#### Scope {#scope}

1. `PlanDocEntry` on the wire: a per-project list of plan documents found in the configured docs directory, with review state, riding `ProjectChangeset` on the `CHANGESET_ALL` feed.
2. Plan rows in the Lens Dashes section, ordered after dash rows, each with a next-gesture affordance that submits a prompt.
3. The "Start a dash…" sheet (name + idea), reachable from the section band's actions cluster and from the empty state.
4. The Z2 DASH reading of the TASKS cell, plus a `dash` placard rendering the cockpit detail.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No new bar and no third Z4A route tab — settled non-goals from the phase prompt.
- No height change to the Lens rows' band or the Z2 status row; no width change to any status cell.
- No new WebSocket feed and no new store: the plan listing rides `CHANGESET_ALL`; every read is a projection of `ChangesetAllStore`.
- No brief listing: a brief is deliberately unlinted and has no machine-recognizable format (`tuglaws/brief-skeleton.md`), so the machine-visible front half starts where a parseable plan document exists.
- No plan-row verbs that mutate the repository (no delete, no rename): the rows are readings plus prompt affordances; file management stays with the user.
- No change to the `/dash`, `plan-review`, or `dash-implement` skills — the prompts this phase emits invoke them exactly as typed invocations would.

#### Dependencies / Prerequisites {#dependencies}

- The `/dash` orchestrator skill and the bare-name reclamation (landed, dash/dash-on-ramp.md) — the sheet's prompt invokes `tugplug:dash`.
- The docs-directory declaration verb `tugutil dash docs-dir` and `tugutil_core::config::Config::docs_dir` (landed, dash/dash-docs-home.md).
- Plan parsing and review-state derivation: `tugutil_core::plan::{parse, review_state, ReviewState}` (landed).
- The always-on Dashes section, `DashMetaLine`, `TugStepRing`, `useDashForSession` (all landed).

#### Constraints {#constraints}

- WARNINGS ARE ERRORS in the Rust workspace (`-D warnings`).
- Tuglaws for all tugdeck work: [L02] external state via `useSyncExternalStore`, [L03] layout-effect registrations, [L06] appearance via CSS + `data-*`, [L11] controls emit actions, [L19] `.tsx`/`.css` pair + `data-slot`, [L20] compose `Tug*` components, [L24] state zones, [L25] overlay portals, [L31] refusals carried in the control's own label.
- [D142] status is not a control: row activation stays navigation; mutating verbs stay behind the `⋯`.
- The shared golden fixture `tugdeck/src/__tests__/fixtures/workspaces-changeset-snapshot.golden.json` guards the wire shape from both sides; any `ProjectChangeset` change updates it and both of its readers.
- No `localStorage`; no hand-rolled list/button/popover UI.

#### Assumptions {#assumptions}

- [D139] holds: adopting a plan onto a dash commits it on the branch and cleans the base copy, so a plan document still present in the docs directory is by construction not adopted — the plan listing needs no dedup against dash entries.
- The `CHANGESET_ALL` recompose is event-driven off each workspace's git watch, so an edit to a plan file (including `tugutil plan stamp` rewriting the Review Record) dirties the tree, fires the watch, and refreshes the listing without new plumbing.
- `CodeSessionStore.send()` queues a submission while a turn is in flight (ghost rows) and drops it only while `phase === "replaying"` — the target ladder must treat a replaying session as ineligible rather than sending into the drop.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None — the design forks this plan met (placement of the start affordance, where the Z2 click lands, membership test for plan documents) are settled as [P03], [P05], and [P01] respectively, each grounded in an existing pattern rather than a new invention.

---

### Risks and Mitigations {#risks}

**Risk R01: Docs-directory scan cost on every recompose** {#r01-scan-cost}

- **Risk:** The aggregate recomputes on every git-watch batch; parsing every top-level `.md` in the docs directory each time adds file reads and parses to a hot loop — and doing it on the async runtime thread would block the feed.
- **Mitigation:** The scan is top-level only (never recursive, so `archive/` never scans); a cheap `{#execution-steps}` substring test gates the full `plan::parse`, so non-plan markdown costs one read and one scan; and the whole scan runs inside its own `spawn_blocking` in `compose_aggregate`'s per-project loop ([P02]) — one hop per project per recompute, the same discipline the dash walk already follows.
- **Residual risk:** A docs directory with very many large plans still re-parses on each recompose; acceptable — the per-dash review read already has this profile and plans are small text files.

**Risk R02: A prompt submitted into a session that cannot take it** {#r02-send-drop}

- **Risk:** `handleSend` (`tugdeck/src/lib/code-session-store/reducer.ts`) returns the state untouched when `phase === "replaying"` — a silent drop. A button that fired into it would violate [L31].
- **Mitigation:** The ladder's last rung is exactly `phase !== "replaying"`, and an ineligible target disables the affordance with the reason in its own label ([L31]) — the press that would be dropped cannot be made.
- **The predicate is `phase !== "replaying"`, deliberately *not* `canSubmit`.** `canSubmit` is `(idle | errored) && transport online`, so gating on it would disable the affordance during any live turn — but a mid-turn send is not dropped, it is **enqueued**: `handleSend`'s tail pushes onto `queuedSends`, which the transcript paints as a ghost row and `handleTurnComplete` flushes. Queueing a next-gesture prompt behind a running turn is a feature, not a hazard, so the gate must not forbid it.
- **Mechanism ([L02]):** reading another card's session phase is a two-step subscription — `useSyncExternalStore(cardServicesStore.subscribe, …getServices(cardId))`, then `useSyncExternalStore` on the resolved `codeSessionStore` with a module-level stable no-op subscribe for the null case. `TelemetryBirthRow` in `tugdeck/src/components/tugways/session-masthead.tsx` is the working precedent, `NOOP_SUBSCRIBE` included; follow it rather than inventing a second shape.
- **Residual risk:** A race between the ladder's read and the press is a queued send at worst, never a silent drop — replay is entered by an explicit user gesture on the same card, not asynchronously mid-press.

**Risk R03: The DASH value jitters or overflows the fixed cell** {#r03-cell-width}

- **Risk:** Dash names are arbitrary-length; the TASKS box is a fixed 14ch budget whose value must never shift as live values tick.
- **Mitigation:** The name portion of the value elides with `text-overflow: ellipsis` inside the fixed box while the fraction is a non-shrinking sibling ([P06]); the full name is on the placard title and the cell's `aria-label`. The width table in `tug-status-cell.css` is untouched.
- **Residual risk:** Very long names read as a few characters plus an ellipsis in the cell — accepted; the row is a glance surface and the placard carries the full identity.

**Risk R04: App-test scaffolding for plan rows needs a scratch project with a docs declaration** {#r04-apptest-fixture}

- **Risk:** With [P08] hiding the checkout's own plans, the gesture tests need a project that is *not* the checkout, declaring a docs dir and holding fixture plans.
- **Mitigation:** `makeDashScratchRepo` in `tests/app-test/dash-fixture.ts` is exactly this: it `git init`s a temp repo, seeds `.tugtool/config.toml`, and takes an `opts.files` record of extra path→body pairs written and committed before it returns. The new test passes `files` carrying a `docs = "dash"` config plus one stamped and one unstamped plan document, then registers the scratch repo as a workspace the way at0438 does.
- **Residual risk:** Fixture plans must stay parseable as the plan format evolves; they are minimal documents modeled on the changeset feed's own `UNSTAMPED_PLAN` test constant (`changeset.rs`), which the format's own tests keep honest, and the stamped one is produced by running `tugutil plan stamp` in the fixture rather than by hand-writing a hash.

---

### Design Decisions {#design-decisions}

#### [P01] A plan document is whatever `plan::parse` accepts, found at the docs directory's top level (DECIDED) {#p01-membership-by-parse}

**Decision:** The listing scans only the immediate children of the configured docs directory for `*.md` files and includes each file that `tugutil_core::plan::parse` accepts; there is no filename convention and no recursion.

**Rationale:**
- There is no blessed filename. `find_tugplans` in `tugutil-core/src/config.rs` matches only the legacy `tugplan-*.md` spelling, which no current plan in this repository uses — reusing it would list nothing. Parse-as-membership is the same positive detection `tugutil plan lint` itself uses (`{#execution-steps}` makes a document a plan).
- Non-recursive keeps `archive/` and any other subdirectory out without naming them — archived paperwork is filed, not pending.
- An undeclared docs directory (`Config::docs_dir` → `None`) yields an empty listing, not an error: the project has declared no paperwork home, so there is no paperwork to show.

**Implications:**
- Briefs, notes files, and anything else unparseable are invisible to the cockpit ([non-goals](#non-goals)).
- A malformed plan is also invisible rather than a broken row; the linter is where malformation gets diagnosed.

#### [P02] The listing rides `ProjectChangeset` on `CHANGESET_ALL` (DECIDED) {#p02-ride-changeset-all}

**Decision:** Add `plans: Vec<PlanDocEntry>` to `ProjectChangeset` (`tugrust/crates/tugcast-core/src/types.rs`), composed in `compose_aggregate`'s per-project loop (`tugrust/crates/tugcast/src/feeds/changeset_all.rs`) inside its own `spawn_blocking`, serialized only when non-empty; mirrored in `tugdeck/src/lib/changeset-types.ts`.

**Rationale:**
- The Lens Dashes section is a projection of `ChangesetAllStore` and nothing more (its own module doctrine); the plan listing belongs on the snapshot that section already subscribes to, not on a new feed the section would have to merge.
- Recompose triggering comes free: a plan file edit (authoring, stamping) dirties the tree and fires the same git watch that already refreshes the snapshot. There is no poll: `ChangesetAllFeed`'s `bump` `Notify` is the only recompute trigger.
- `ProjectChangeset` rather than the flattened `ChangesetSnapshot`: the listing is a property of the *project*, and `ProjectChangeset` is the type the Lens's projection already walks (`snapshot.projects.flatMap(...)`).

**Implications:**
- **The compose site is `changeset_all.rs`, not `changeset.rs`.** `ProjectChangeset` is constructed only in `compose_aggregate`'s loop; `changeset.rs`'s `dash_entries` blocking hop builds `ChangesetEntry` values inside `compose_snapshot`, one level down, and cannot reach the field. The scan therefore needs its **own** `spawn_blocking` in that loop — the directory read and `plan::parse` must not run on the async runtime thread (Risk R01).
- **The loop holds `project_dir`, which is not necessarily the repo root.** `Config::load_from_project` expects the project root and `PlanDocEntry.path` is repo-relative, so the scan resolves the root first (`changeset::repo_root_for`, the same resolution `compose_snapshot` makes) and returns an empty vec when there is none. Skipping this makes a card opened on a subdirectory silently list nothing.
- The shared golden fixture and both of its readers update together; the serde skip keeps older payloads compatible in both directions (deck reads `plans` as optional). The deck-side readers of that fixture are `src/__tests__/changeset-types.test.ts`, `src/components/lens/sections/__tests__/dashes-section.test.ts`, `src/lib/__tests__/dash-session-index.test.ts`, `src/lib/__tests__/changes-route-controller.test.ts`, and `session-changes/__tests__/session-changes-dash-lane.test.ts`.

#### [P03] Buttons produce prompts; the next gesture is always a `/tugplug:…` submission (DECIDED) {#p03-buttons-produce-prompts}

**Decision:** Every affordance this phase adds — plan-row Review/Implement, the Start-a-dash sheet — composes a canonical qualified command line (Spec S01) and submits it into the target session via `CodeSessionStore.send(text, [])`; nothing invokes `tugutil` or any other machinery directly.

**Rationale:**
- This is the phase prompt's own doctrine, and the arc's: the model runs the arc, the review gate stays a real turn on a chooseable model, and the transcript records what happened in the same form a typed invocation would ([D147], [D152] lineage — retiring "nothing happens until I type" without creating a second, silent way of acting).
- A programmatic send bypasses the composer's `canonicalizeBareCommandLine`, so the emitted spelling is the already-canonical `tugplug:`-qualified form — no dependence on submit-path canonicalization, no ambiguity ever reaching the resolver.

**Implications:**
- The prompts are visible, interruptible, ordinary user messages: they queue behind an in-flight turn as ghost rows, and the model's handling of them is the skills', not this phase's.

#### [P04] Prompt targeting reuses the followed-card ladder, refusals named (DECIDED) {#p04-followed-card-ladder}

**Decision:** A prompt affordance resolves its target with the same shape as `resolveBindTarget` (`dashes-section.tsx`): the Lens's followed card, its session binding, and a same-project check for plan rows; exactly one of `{cardId, reason}` is non-null, and the reason renders as the disabled affordance's own label/tooltip ([L31]).

**Rationale:**
- The ladder is already this section's answer to "where do this section's acts land", and stopping at the followed card keeps the destination visible — a press must never submit into a card the reader was not looking at.
- Plan rows are project-scoped (the plan path is relative to one project root); the Start-a-dash sheet is not (a new dash belongs to whatever project the followed session is in), so the sheet's ladder omits the project check and instead *names* the target project in the sheet so the reader sees where the work will start.

**Implications:**
- A replaying session is ineligible (Risk R02); a missing followed card, an unbound card, and a cross-project mismatch each produce their own sentence, verbatim from the resolver, testable as a table.

#### [P05] The start affordance lives in the band's actions cluster *and* the empty state (DECIDED) {#p05-start-placement}

**Decision:** "Start a dash…" is a `headerActions` control on the Dashes section registration (a `+` push button in the band, left of the fold chevron, per the registry's own contract) and the empty state's one-line copy becomes a real button carrying the same act.

**Rationale:**
- The phase's motivation is findability without typing; an affordance that exists only while the section is empty vanishes the moment the first dash exists, exactly when starting a *second* piece of work is the likely next act.
- `LensSectionDefinition.headerActions` is declared in `lens-section-registry.ts` and rendered by `lens-section-band.tsx` — it is the registry's own answer to "a section contributes a band control", so the band placement composes declared apparatus rather than inventing chrome.

**Implications:**
- **This is `headerActions`' first consumer.** No section registers one today; the hook is declared and rendered but unused. Nothing about it is load-bearing for another surface, so the risk of the first use is low — but an implementer should expect no precedent to copy and should read the band's render site for the contract.
- **The band control shows only while the section is expanded.** `lens-section-band.tsx` renders it as `{collapsed ? null : def.headerActions?.(host)}` — deliberate, per its own comment, because a section's controls act on its visible body. So a *collapsed* Dashes section offers no start affordance from either placement (the empty state is inside the body too). That is correct and not worth working around: a folded section is one the reader has put away.
- The empty state's placeholder sentence ("No dashes. Ask a session to start one."), whose own comment promises "A real affordance replaces this copy", is replaced by the button.

#### [P06] The Z2 cell keeps its box; the placard is the cockpit detail (DECIDED) {#p06-z2-cell-keeps-box}

**Decision:** While `useDashForSession(snap.tugSessionId)` is non-null, the TASKS cell renders label `DASH` and value `<name> i/N` (name eliding, fraction fixed) inside the same fixed-width box (`data-priority="tasks"` unchanged, so the width table and the placard anchor keep working); its click opens a new `dash` placard whose content is the dash's cockpit detail. With no dash, the cell is byte-for-byte the TASKS cell it is today.

**Rationale:**
- Every Z2 cell opens a placard ([P05]/[P06] of the status-row work: one placard at a time, anchored under the trigger); a cell that instead teleported to another card would be the row's only navigation cell and would break the instrument reading. "The dash's cockpit detail" is therefore a placard rendering the cockpit's per-dash reading in place.
- The width table in `tug-status-cell.css` is measured, deliberate design ("the budgets are not those needs"); the fraction `i/N` is `dashGlanceFraction`'s run-scoped pair, the same numerals the masthead shows, so the two Z-levels cannot disagree.
- During a dash run the [D100] task checklist *is* the step list (`dash-implement` creates one task per step), so the DASH reading loses nothing the TASKS reading had — and the placard still renders the checklist as its numbered list.

**Implications:**
- `PlacardKind` gains `"dash"`; `measureAnchorCenter` maps `"dash"` to the `tasks` cell's anchor (its `querySelector` is keyed on `[data-priority="…"]`, which is why `data-priority` must stay `"tasks"`); `PLACARD_TITLES.dash` is the static word "Dash" with the dash's name rendered inside the content, since `PLACARD_TITLES` is an exhaustive `Record<PlacardKind, string>` of static strings.
- **`/tasks` keeps opening the Tasks placard, even while the cell reads DASH.** `SessionTelemetryStatusRowHandle.openTasks()` is the `/tasks` slash command's entry point and stays wired to the `"tasks"` key; the anchor lookup still resolves because `data-priority` is unchanged. So a dash-driving session has two readings reachable from one cell — the click gives DASH, the command gives the checklist — and that is intended, not an inconsistency to reconcile. `openTasks()` must not be repointed at `"dash"`.

#### [P08] The checkout's own plans are hidden in app-test instances (DECIDED) {#p08-apptest-suppression}

**Decision:** The scan returns empty for the checkout an app-test instance runs from, gated by the same predicate `dashes_hidden_for` (`tugrust/crates/tugcast/src/feeds/changeset.rs`) already applies to dash entries.

**Rationale:**
- The argument is `dashes_hidden_for`'s own, verbatim: a fixture's subject is never the checkout somebody is working in, so the checkout's entries are noise in a test instance by construction. It holds identically for paperwork — this repository declares `docs = "dash"` and that directory holds several parseable plans right now, so without the gate every app-test instance's Lens would list this repo's own plan documents.
- Worse than noise: a test asserting anything about the plan listing (a row count, an ordering, an empty state) would be silently coupled to whatever paperwork the repository happens to be carrying that week — green today, red the next time somebody devises a plan.

**Implications:**
- Scratch-repo fixtures are unaffected: the gate compares the composed repo root against `REPO_UNIVERSE_ENV`, and a scratch repository is not the universe. That is exactly what makes the app-tests in Steps 2–3 possible.
- The gate is a *reuse*, not a second predicate — one call from the new scan, no parallel rule to keep in step.

#### [P07] Plan rows sort after dash rows, and the collapsed summary counts both (DECIDED) {#p07-plan-row-order}

**Decision:** The section's list is dash rows in the existing `compareDashRows` order, then plan rows ordered `reviewed` first (nearest the next gesture that creates work), then by review state (`stale`, `never-reviewed`), then by name; the collapsed band summary reads e.g. `2 dashes · 1 plan`. Plan rows are listed for **every open project**, exactly as dash rows are.

**Rationale:**
- Live work outranks waiting paperwork: a dash one gesture from landing is the section's most actionable row, which is the exact argument `DASH_STAGE_RANK` already encodes; plans extend the same nearest-to-done principle to the front half of the arc.
- Counting plans in the collapsed summary is what makes the front half visible even when the band is folded.
- Every-open-project matches what this section already is. `dashRowsFromSnapshot` flattens every project's dashes and deliberately does not group by project ("grouping by project would bury a dash that is one gesture from landing"), and the section already renders rows that cannot be acted on right now — `resolveWorkerCard` returning null "is the common case, not an error". A plan row whose project is not the followed one is the same shape: inert now, actionable the moment a card in that project is followed. Scoping plans to the followed card instead would make the listing change as the reader moves between cards, which is the coming-and-going wart this section already retired.

**Implications:**
- `dashesCollapsedSummary` grows a second argument; its tests extend as table tests.
- A plan row from an unfollowed project shows its affordance disabled carrying the cross-project reason verbatim ([P04], Table T01) — a visible reason, never silence ([L31]).

---

### Specification {#specification}

**Spec S01: Prompt templates** {#s01-prompt-templates}

The three command lines the cockpit emits, always in the canonical qualified spelling, composed by exported pure functions (testable without a DOM):

| Affordance | Emitted prompt |
|---|---|
| Start a dash (idea only) | `/tugplug:dash <idea>` |
| Start a dash (name given) | `/tugplug:dash <idea> — name it <name>` |
| Plan row, review = `never-reviewed` or `stale` | `/tugplug:plan-review <path>` |
| Plan row, review = `reviewed` | `/tugplug:dash-implement <path>` |

`<path>` is the entry's repo-relative `path` verbatim; the idea and name are the sheet's field values trimmed, idea required and non-empty, name optional. The templates live beside the target ladder in one new module (see [New files](#new-files)) so surface code never string-builds a command line.

**Spec S02: `PlanDocEntry` wire shape** {#s02-plandocentry}

```rust
/// One plan document waiting in the project's configured docs directory —
/// the front half of the dash arc, made machine-visible. Present only for
/// documents `plan::parse` accepts ([P01]); adopted plans never appear
/// because adoption cleans the base copy ([D139]).
pub struct PlanDocEntry {
    /// Repo-relative path, e.g. "dash/dash-cockpit.md" — what the next
    /// gesture's prompt cites verbatim.
    pub path: String,
    /// The file stem, e.g. "dash-cockpit" — the row's display identity.
    pub display_name: String,
    /// `reviewed` | `stale` | `never-reviewed` — `plan::review_state`'s
    /// spellings, the same vocabulary `DashChangesetEntry.review` wears.
    pub review: String,
    /// How many execution steps the document declares — the cockpit row's
    /// size cue. 0 for a plan whose steps failed to enumerate.
    pub step_total: u32,
}
```

Rides `ProjectChangeset` as `#[serde(default, skip_serializing_if = "Vec::is_empty")] pub plans: Vec<PlanDocEntry>`, mirrored optionally (`plans?: PlanDocEntry[]`) in `changeset-types.ts`. Entries sort by `path` in the producer so snapshot diff-suppression sees stable bytes.

**Table T01: The next-gesture ladder** {#t01-next-gesture}

| Review state | Row affordance label | Prompt (Spec S01) | Disabled when |
|---|---|---|---|
| `never-reviewed` | Review | `/tugplug:plan-review <path>` | no eligible followed session in this project |
| `stale` | Review | `/tugplug:plan-review <path>` | same |
| `reviewed` | Implement | `/tugplug:dash-implement <path>` | same |

Eligibility ([P04]): followed card exists → card has a session binding → binding's `projectDir` matches the plan's project → the session's store exists and is not replaying. The first rung that fails supplies the disabled reason, verbatim.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Plan listing (`plans` on the snapshot) | structure | server-derived, read via `useChangesetAll` | [L02], [D138] |
| Dash fact for the Z2 cell | structure | derived projection `useDashForSession` | [L02], [D138] |
| Followed card's services | structure | `useSyncExternalStore(cardServicesStore.subscribe, …)` | [L02] |
| Followed session's phase (the eligibility rung) | structure | `useSyncExternalStore` on the resolved `codeSessionStore`, stable no-op subscribe when null — the `TelemetryBirthRow` shape | [L02] |
| Start-sheet open/closed | local-data (view scope) | `TugSheet`'s own internal open state | [L24] |
| Sheet field text (name, idea) | local-data (view scope) | `TugInput` local state | [L24] |
| `dash` placard open | local-data (view scope) | the row's existing `placard` `useState` | [L24] |
| Affordance enabled/disabled + reason | appearance | derived per render from the ladder; `disabled` + label, no state | [L06], [L31] |
| DASH name eliding | appearance | CSS `text-overflow` on a fixed box | [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/dash-prompts.ts` | Spec S01 templates + the prompt-target ladder ([P04]) + `submitPromptToCard(cardId, text)` (resolves `cardServicesStore.getServices(cardId)`, calls `codeSessionStore.send(text, [])`, dispatches `focus-session-card`) |
| `tugdeck/src/components/lens/sections/dashes-start-sheet.tsx` + `.css` | The Start-a-dash sheet: `TugSheet` + two `TugInput` fields + submit/cancel, composing [P04]/[P05] |
| `tests/app-test/at04XX-dash-cockpit.test.ts` | Gesture coverage for plan rows, the start sheet, and the Z2 DASH cell (number assigned at authoring; `@covers` the four surface files) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `PlanDocEntry` | struct | `tugrust/crates/tugcast-core/src/types.rs` | Spec S02 |
| `ProjectChangeset.plans` | field | same | serde skip when empty |
| `plan_doc_entries` | fn | `tugrust/crates/tugcast/src/feeds/changeset.rs` | the scan ([P01], [P08]); `pub(crate)`, called from `changeset_all.rs`'s per-project loop inside its own `spawn_blocking` ([P02]) |
| `PlanDocEntry`, `ProjectChangeset.plans?` | interface | `tugdeck/src/lib/changeset-types.ts` | mirror |
| `planRowsFromSnapshot`, `comparePlanRows` | fn | `tugdeck/src/components/lens/sections/dashes-section.tsx` | [P07]; pure, exported for tests |
| `dashesCollapsedSummary` | fn (modify) | same | counts plans too |
| `PlanCell` | cell renderer | same | second `kindForIndex` value `"plan"` in the section's data source |
| `resolvePromptTarget` | fn | `tugdeck/src/lib/dash-prompts.ts` | [P04]; pure, table-tested |
| `startDashPrompt`, `planNextGesturePrompt` | fn | same | Spec S01 |
| `PlacardKind` | type (modify) | `tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx` | add `"dash"`; anchor maps to the `tasks` cell |
| `DashPopoverContent` | component | `tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.tsx` | the cockpit detail: `DashSigil`, stage mark, `TugStepRing` + fraction, step title, `dashMetaFacts`, the task checklist list |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | The scan: membership by parse, non-recursion, undeclared-dir emptiness, review spellings, sort stability | Step 1 |
| **Golden / Contract** | The wire shape from both sides via the shared golden fixture | Step 1 |
| **Unit (bun, pure)** | Projections, ordering, summary, ladder truth table, prompt templates | Steps 2–4 |
| **App-test** | The gestures: a plan row's press produces a transcript user message; the sheet round-trip; the DASH cell + placard | Steps 2–4, one new file |

#### What stays out of tests {#test-non-goals}

- Any DOM assertion that a pure function already proves — ordering, ladder verdicts, and template strings are table tests, per this codebase's standing pattern (`resolveBindTarget`, `compareDashRows` are already tested this way).
- Driving a real model turn from the submitted prompt — the gesture test asserts the user message reached the transcript (queued or sent); what the skill does with it is the skills' own coverage.
- Banned shapes: no `happy-dom`, no `jsdom`, no `@testing-library/react`, no mock-store tests.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The docs directory's plans join the wire | pending | — |
| #step-2 | Plan rows join the Dashes section | pending | — |
| #step-3 | Start a dash from the Lens | pending | — |
| #step-4 | The Z2 cell reads DASH | pending | — |
| #step-5 | Integration Checkpoint | pending | — |

#### Step 1: The docs directory's plans join the wire {#step-1}

**Commit:** `Carry the docs directory's plan documents on the changeset snapshot`

**References:** [P01] membership by parse, [P02] ride CHANGESET_ALL, [P08] app-test suppression, Spec S02, Risk R01, (#context, #dependencies)

**Artifacts:**
- `PlanDocEntry` + `ProjectChangeset.plans` in `tugcast-core/src/types.rs`; the `plan_doc_entries` scan in `tugcast/src/feeds/changeset.rs`; its call site in `changeset_all.rs`; the deck mirror in `changeset-types.ts`; the regenerated shared golden fixture.

**Tasks:**
- [ ] Add `PlanDocEntry` and the `plans` field per Spec S02, with doc comments carrying [P01]/[D139]'s argument.
- [ ] Implement `plan_doc_entries(project_dir)` in `changeset.rs`: return empty when `dashes_hidden_for` says so ([P08]); resolve the repo root via `repo_root_for` (the loop hands a `project_dir` that may be a subdirectory, [P02]); resolve the docs dir via `tugutil_core::config::Config::load_from_project(root)` + `docs_dir(root)` (`None` → empty); read the directory's immediate `*.md` children; gate `plan::parse` behind a `{#execution-steps}` substring check (Risk R01); for each accepted document emit `path` (root-relative), `display_name` (file stem), `review` (`plan::review_state(&doc, &source).as_str()`), `step_total` (`doc.steps.len()`); sort by `path`.
- [ ] Call the scan from `compose_aggregate`'s per-project loop in `changeset_all.rs`, inside its own `spawn_blocking` (Risk R01), and thread the result onto the `ProjectChangeset` the loop pushes.
- [ ] Mirror `PlanDocEntry` and the optional `plans` field in `tugdeck/src/lib/changeset-types.ts`; extend the golden fixture with a `plans` entry and update its five readers ([P02] implications).

**Tests:**
- [ ] Rust unit tests in `changeset.rs` (temp-dir pattern of the existing `dash_review_state` tests, which already build a repo and write `UNSTAMPED_PLAN`): a stamped plan reads `reviewed`, an unstamped one `never-reviewed`, a stamped-then-edited one `stale`; a non-plan `.md` and a plan in an `archive/` subdirectory are absent; an undeclared docs dir yields an empty vec; `step_total` matches the document's step count; output sorted by path.
- [ ] A test that a `project_dir` pointing at a subdirectory of the repo still resolves the declaration and emits root-relative paths — the failure mode [P02] names.
- [ ] A serde test that an empty `plans` serializes to no key (the existing skip-field test's pattern at the `step_current` assertions).
- [ ] The golden-fixture round-trip on both sides stays green with the new entry.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugcast-core`
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test src/__tests__/`

---

#### Step 2: Plan rows join the Dashes section {#step-2}

**Depends on:** #step-1

**Commit:** `List waiting plan documents in the Lens Dashes section`

**References:** [P03] buttons produce prompts, [P04] followed-card ladder, [P07] plan-row order, Spec S01, Table T01, Risk R02, (#state-zone-mapping, #symbols)

**Artifacts:**
- `tugdeck/src/lib/dash-prompts.ts` (templates + ladder + `submitPromptToCard`); plan rows in `dashes-section.tsx` + `dashes-section.css`; the extended collapsed summary.

**Tasks:**
- [ ] Write `dash-prompts.ts`: `startDashPrompt(idea, name)`, `planNextGesturePrompt(review, path)` per Spec S01; `resolvePromptTarget` per [P04] — pure, taking bare values (followed card id, its binding, an optional `requireProjectDir` for plan rows, and the target session's `phase`), returning exactly one of `{cardId, reason}` non-null, with the `phase === "replaying"` rung last (Risk R02); `submitPromptToCard(cardId, text)` via `cardServicesStore.getServices(cardId)` → `codeSessionStore.send(text, [])` → `dispatchCommand("focus-session-card", { cardId })`, a no-op when the services bag is null.
- [ ] Write the hook that feeds it — the two-step subscription in Risk R02's mechanism note, following `TelemetryBirthRow`'s shape ([L02]). The pure resolver stays free of store reads so it can be table-tested.
- [ ] Extend the section's projection: `planRowsFromSnapshot` + `comparePlanRows` ([P07]); the data source carries both kinds (`kindForIndex` `"dash" | "plan"`), dash rows first.
- [ ] **Redefine `populated` over both kinds.** `DashesSectionBody` currently computes `const populated = rows.length > 0` and uses that one value twice — for `setSectionContent(host.focusGroup, { navigable, populated })` in its layout effect ([L03]) and for the early return that renders the empty state. Left as the dash count, a project with zero dashes and one or more plans renders the empty state and the plan rows never mount, while the band's arrow walk is told there is nothing to walk onto. It must become the combined row count.
- [ ] Render `PlanCell`: an eyebrow in the section's grammar (a file/document glyph + the display name + the hairline) and a meta line reading the review state and `step_total` (e.g. `plan · reviewed · 5 steps`), with the next-gesture affordance (Table T01) as a compact `TugPushButton` at the row's trailing edge — an explicit control, not row activation ([D142]); disabled state carries the ladder's reason as its tooltip/label ([L31]).
- [ ] Extend `dashesCollapsedSummary` to count both (`2 dashes · 1 plan`), zero-bucket dropping.
- [ ] Plan rows are inert to activation (no room to open) and offer no `⋯` (no verbs beyond the one affordance).

**Tests:**
- [ ] bun table tests: `comparePlanRows` ordering ([P07]), `planRowsFromSnapshot` membership, the extended summary strings, `resolvePromptTarget`'s full truth table (each rung's reason verbatim, including the `replaying` rung), both template functions.
- [ ] App-test (in the new at-file, first section): scratch project with a declared docs dir + one stamped and one unstamped fixture plan (Risk R04); assert both rows render with the right affordance labels; press Implement on the reviewed plan with the bound card followed and assert the card's transcript gains a user message reading `/tugplug:dash-implement <path>`.
- [ ] App-test: the plans-but-no-dashes case renders plan rows rather than the empty state — the `populated` defect this step fixes, pinned so it cannot return.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at04XX-dash-cockpit.test.ts` (the new file; also run `at0438-lens-unbound-dashes.test.ts` to prove the dash rows kept their behavior)

---

#### Step 3: Start a dash from the Lens {#step-3}

**Depends on:** #step-2

**Commit:** `Give the Dashes section a Start a dash affordance`

**References:** [P03] buttons produce prompts, [P04] followed-card ladder, [P05] start placement, Spec S01, (#state-zone-mapping, #new-files)

**Artifacts:**
- `dashes-start-sheet.tsx`/`.css`; the band `headerActions` control and the rebuilt empty state in `dashes-section.tsx`.

**Tasks:**
- [ ] Build `DashesStartSheet` composing `TugSheet` ([L20]): a name field (optional) and an idea field (required), both `TugInput` (substrate responders come free); the sheet names the target — the followed session's identity and project — so the reader sees where the prompt lands ([P04]); Submit is disabled until the idea is non-empty *and* the ladder resolves, with the refusal in the disabled label ([L31]); Cancel and Escape close through the chain, which `TugSheetContent` gives free via its `cancelDialog` responder.
- [ ] **Size it for the rail, not for a card.** `TugSheet` is *pane-modal*: it portals into the host pane's frame via `TugPaneFrameContext` and drops like a shade over that pane alone. Its host here is the Lens's anchored sidebar pane, which is `DEFAULT_LENS_WIDTH_PX` = 420 and can be dragged to `MIN_LENS_WIDTH_PX` = 320 (`src/lib/lens-store/types.ts`). Two stacked full-width fields and a footer fit that column; a side-by-side field row does not. Peer panes stay interactive throughout, which is correct — the sheet blocks the Lens, not the session card its prompt is aimed at.
- [ ] Submit composes `startDashPrompt` and calls `submitPromptToCard`, then closes the sheet.
- [ ] Register a `headerActions` control on the section: a `2xs` icon `TugPushButton` (Plus) labeled for AX "Start a dash", opening the sheet ([P05]); focus order rides the band's `LENS_BAND_ACTION_FOCUS_ORDER` slot.
- [ ] Replace the empty state's sentence with the real affordance: a quiet line plus a "Start a dash…" `TugPushButton` opening the same sheet — the copy's own comment promised exactly this replacement.

**Tests:**
- [ ] bun test: `startDashPrompt` with and without a name (already in Step 2's table; extend if edge trimming needs pinning).
- [ ] App-test (second section of the new at-file): open the sheet from the band control, type an idea, submit, assert the followed card's transcript gains the `/tugplug:dash` user message and the sheet closed; with no followed session card, assert the submit affordance is disabled and its reason text is present.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at04XX-dash-cockpit.test.ts`

---

#### Step 4: The Z2 cell reads DASH {#step-4}

**Depends on:** #step-1

**Commit:** `Read DASH in the Z2 cell while the session drives a dash`

**References:** [P06] the cell keeps its box, Risk R03, (#state-zone-mapping, #symbols)

**Artifacts:**
- The conditional DASH reading of the TASKS cell in `session-card-telemetry-renderers.tsx` (+ its CSS); `PlacardKind` `"dash"`; `DashPopoverContent` in `session-card-telemetry-popovers.tsx`.

**Tasks:**
- [ ] In `SessionTelemetryStatusRow`, read `useDashForSession(snap.tugSessionId)`; when non-null, the cell renders label `DASH`, and the value renders the dash name (a span with `text-overflow: ellipsis` inside the fixed box, [L06], Risk R03) beside the run fraction from `dashGlanceFraction(fact.runPosition, fact.runLength, fact.stepCurrent, fact.stepTotal)` — the same call, in the same argument order, that `session-identity-row.tsx` already makes for the masthead, so Z1 and Z2 cannot disagree about the numerals; a null return (a dash that declared no counters) renders the name alone. `data-priority` stays `"tasks"` so the width table and anchor measurement are untouched; the cell's `aria-label` carries the full name and fraction.
- [ ] Add `"dash"` to `PlacardKind` and `PLACARD_TITLES` (`"Dash"`); in `measureAnchorCenter`, map `"dash"` to the `tasks` cell's anchor; the cell's `onActivate` toggles `"dash"` when a dash fact is present, `"tasks"` otherwise.
- [ ] Write `DashPopoverContent`: the dash's identity (`DashSigil` atom + name), the stage word (`DashStageMark`), the step ring + fraction (`TugStepRing`/`TugStepFraction` at the reading scale), the current step title, `dashMetaFacts` as toned facts, and the numbered checklist body the TASKS placard already renders (composed, not copied); a footer action "Show in Changes" dispatches `TUG_ACTIONS.REVEAL_CHANGES` on this card's own content scope — the placard's one exit into the room where dash decisions live ([D152]).
- [ ] Replay-inert handling matches the row's other cells (`inertValue` renders `—`).

**Tests:**
- [ ] bun test: the small pure helper that formats the cell value (name + fraction) if extracted; otherwise no new pure surface — the reading is proven in the app-test.
- [ ] App-test (third section of the new at-file): with a scratch dash bound to the card and step counters recorded, assert the cell label reads `DASH`, the value carries the fraction, and the cell's box width equals its TASKS-state width (Success Criteria); click the cell and assert the placard opens with the dash name, stage, and checklist visible; assert the TASKS reading returns when the dash unbinds.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at04XX-dash-cockpit.test.ts`

---

#### Step 5: Integration Checkpoint {#step-5}

**Depends on:** #step-2, #step-3, #step-4

**Commit:** `Integration checkpoint`

**References:** [P02] ride CHANGESET_ALL, [P06] the cell keeps its box, (#success-criteria)

**Tasks:**
- [ ] `tugutil dash replay <name>` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: verify the replayed tree with the project's declared verify command (`tugutil dash config --json`), substituting `{base}`/`{head}` with the replayed range.
- [ ] `Current`: the base never moved, so the last step's checkpoint already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree, then verify as above.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The dash cockpit: the Lens Dashes section lists live dashes and waiting plan documents with prompt-producing affordances (start, review, implement), and the Z2 telemetry row reads DASH with a cockpit-detail placard while its session drives a dash — with no height or width change to either surface and no button that runs machinery directly.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Plan documents in the configured docs directory ride the snapshot with correct review states (Rust unit tests + golden fixture, Step 1)
- [ ] Plan rows render with the Table T01 affordances and submit the right prompts to the right session, refusals named (bun tables + app-test, Step 2)
- [ ] Start a dash reachable from band and empty state; the sheet submits `/tugplug:dash` into the followed card (app-test, Step 3)
- [ ] The DASH cell reading, its placard, and the unchanged cell geometry (app-test, Step 4)
- [ ] The fit verified on the live base or correctly skipped as `Current` (procedure, Step 5)

**Acceptance tests:**
- [ ] The new `at04XX-dash-cockpit.test.ts` file, green (Steps 2–4)
- [ ] `at0438-lens-unbound-dashes.test.ts` still green (Step 2)

#### Follow-ons (Explicitly Not Required for Phase Close) {#follow-ons}

- [ ] A brief-format marker that would let briefs join the listing (deliberately absent while the brief format stays unlinted)
- [ ] Per-plan detail on row activation (a reader for the plan document itself) — the rows stay glance + gesture in this phase

| Checkpoint | Verification |
|------------|--------------|
| Wire shape | golden fixture round-trip, both readers (Step 1) |
| Gestures | the new at-file's three sections (Steps 2–4) |
| Fit | `tugutil dash replay` + scoped verify (Step 5) |
