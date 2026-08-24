## Polish and doctrine — the dash lane's last mile {#polish-and-doctrine}

**Purpose:** Close the dash integration program: resolve a dash's worktree path where the repository root is actually known, make a project with several dashes navigable (a picker, a real ordering), give the shade's dash lane the two binding gestures it still lacks (adopt, leave), surface whether a dash's plan is still reviewed, write the lifecycle down in `tuglaws/dash-lifecycle.md`, and delete the one-release skill aliases. Implements [phase 5](dash-integration-plan.md#phase-5) of the dash integration program.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Target branch | main (runs as the `polish-lane` dash) |
| Program plan | [dash-integration-plan.md](dash-integration-plan.md#phase-5) |
| Last updated | 2026-08-14 |

---

### Review Record {#review-record}

<!-- Appended by /tugplug:plan-review; the stamp is written by `tugutil plan stamp`. -->

**Round 1 — 2026-08-14, opus.** Reviewed `plan:1b1e870a4639969e`. Lint: 0 errors, 0 warnings.
Oriented on: the whole document — a first pass, devised and reviewed in one turn on Opus per the `plan-devise` fork.
Applied: **technical choices** — the mark's masthead mechanism was wrong. The plan had `session-masthead.tsx` reading the bound dash out of "the card's changeset snapshot", but `SessionMastheadProps` is `{ sessionId, cardId?, accessoryHost? }` and the masthead is handed no `ChangesRouteController`; it already reads the *account-global* aggregate for exactly this shape of fact (`useSessionBranch` from `changeset-all-store.ts`). Rewritten as a sibling hook `useDashReviewState` beside `branchForProject`/`useSessionBranch`, with the symbol inventory and State Zone Mapping corrected to match, so the plan no longer implies a prop-threading change the masthead's design forbids.
**Holes** — added [#edges](#edges), covering the five cases an implementer hits and would otherwise re-derive: two cards on one dash is legal and must not be guarded against; a picker dismissed mid-bind is harmless because the ack is the mover; a released dash vanishing mid-gesture exposes `bind_dash`'s minting for one recompose (pre-existing, scoped out); the mark reads `stale` during a review's own edit-then-stamp window, correctly; and a manually-removed worktree degrades to no field.
**Test-plan sanity** — Step 5 proposed asserting "a `bind_dash` for a released dash leaves the chip unchanged, which only passes if the ack is the mover". That test cannot exist: a released dash has no row to click, and `bind_dash` mints so it cannot be refused. Replaced with the complement-rule assertion (fronted offers Leave and no Adopt, and vice versa), and the ack-is-the-mover discipline moved into `#test-non-goals` as an explicitly untested invariant rather than a fake proof.
**Cold reader** — Step 2's fixture would have failed on first run: `dash step start --plan` is the only writer of `branch.tugdash/<name>.tugplan` and refuses unless the document parses *and* carries a `#step-1` ledger row, and it mutates the ledger before the stamp. Both facts, and the reason the mutation does not invalidate the stamp, are now in the step. Step 1's golden-fixture task was conditional ("if either carries a dash entry"); both goldens do carry one and neither records a `plan_path`, so the correct expectation is that they do **not** move — stated, with the instruction to fix the emission rather than the fixture if they do.
**Falsifiability** — two checkpoints could not fail. `grep -c "two-beat" …` reports a count, not a verdict; replaced with `! grep -q` on the exact stale clause. Step 7's stub grep used `\b`, which matches `tugplug:dash` inside `tugplug:dash-audit` and would report every surviving skill as a leftover; replaced with `([^a-z-]|$)` and verified against the current tree.
**Sequencing** — Steps 3 and 5 gained `**Depends on:** #step-2` with HTML comments naming these as *file-contention* dependencies, not logical ones. Neither needs the review field; both rewrite files Step 2 rewrites. An unexplained dependency reads as a hidden coupling.
Deferred: nothing new. [Q01] (how long a dash has been parked) was raised and left deferred with its rationale and resolution path — it needs a wire field no surface has yet earned.

**Round 2 — 2026-08-14, opus.** Reviewed `plan:0d31864abbc8b9ce`. Lint: 0 errors, 0 warnings, both before and after.
Oriented on: the Review Record (the plan is tracked and clean since round 1), and on phase 4 as it actually landed — `06c461d50`, which round 1 could only predict.
Applied: **plan quality, naming** — phase 4 shipped the [P08] one-name ruling, so the two verbs this plan builds on are `/dash-bind` and `/dash-join`, with `dash` and `join` surviving as `runRetiredVerb` aliases excluded from the completion popup. The plan was written against `/dash` and `/join` throughout, and [P08]'s lifecycle outline is copied verbatim into a new law file by its step — so the phase would have authored `tuglaws/dash-lifecycle.md` naming commands that do not exist. Renamed in [P01], the picker deep dive, the step, the app-test, the success criteria, and the doctrine outline; the zero-dash caution string, which itself names the retired spelling, is now a task rather than a survivor.
**Holes, and a new step** — the review read in [#review-resolution](#review-resolution) composed `repo_root.join(worktree_rel).join(plan_path)`, which is the bug phase 4 spent a round fixing, one layer up: `dash_detail_entries_in` normalizes through `main_repo_root`, so `worktree_rel` is relative to the *main* root while every consumer joins it against the *project* root. Grepping both languages found the trap already live in three shipped consumers besides the new one — `fetch_dash_diff` (degrades to committed rounds, dropping worktree dirt), `plan-review.ts` (bare `/plan-review` cannot find the bound dash's plan), and the wire doc that states the composition as the contract. The user chose to fix it everywhere rather than record it, so [P09] and a new [#step-1](#step-1) were added, the review read now takes an absolute worktree, and every later step renumbered. The whole failure mode is silence, on the worktree-hosted debug build every dash is vetted on.
**Test-plan sanity** — no app-test can falsify any of that: an app-test instance registers the base checkout, so its project root and main root are the same directory and the composition works whether or not the fix happened. Two Rust worktree-asked tests carry it instead, modelled on phase 4's `preflight_asked_from_a_linked_worktree_answers_about_the_main_root`, plus a `dash_entries` case that fails without step 1 and passes with it — the one assertion proving the two steps are wired together. The limitation is stated in [#test-non-goals](#test-non-goals) rather than papered over. Also: `at0416` is taken by `at0416-viewer-card-settings.test.ts`, so the picker test is `at0420`.
**Technical choices** — [#step-6](#step-6) proposed two loose `onAdopt`/`onLeave` props, but phase 4 landed the row's verbs as one `landing` bundle handed to the fronted row alone, with `landing={null}` everywhere else; Adopt's whole population is those other rows. Rewritten as a `DashLaneBinding` bundle threaded to every row. Its gate said "the same predicate phase 4's Join affordance uses" — that is `evaluateJoinLandGate`, which refuses on outcome, blockers, and an empty message, so read literally it would refuse to adopt exactly the off-base or conflicted dash somebody needs to take on; narrowed to *a landing in flight*.
**Doctrine** — phase 4's step 11 already put the landing doctrine into `tracking-changes.md` (the one-slot `LandingMode` paragraph, the five-outcome table). [P08] and [#step-7](#step-7) now cross-reference it instead of restating it, and the `tracking-changes.md` correction is scoped to the `/commit` clause alone, since the `/dash-join` half of that sentence is already right. The stale-clause grep still holds against the live file.
Deferred: nothing new. Asked and settled in-thread: whether the retired verb spellings die with the skill stubs — they do not, and [P06] now records why (a verb that stops matching the registry is submitted to Claude as a prompt, which is worse than either spelling), with step 8 explicitly forbidden from touching them.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Phases 1 through 4 built the dash lane end to end: a dash has an identity (`tugdash/<name>#<tugid>`), a derived stage, a session binding, a maintained join draft, a lane in the Changes shade, a row in the Lens, a chip in the masthead, and — with phase 4 — a landing surface with `/dash-join`, a preview, a gate, a receipt, and a release affordance behind a discard preflight.

**Phase 4 landed as `06c461d50`, and it shipped the [P08] one-name ruling with it**, which renames two verbs this plan builds on. The bind verb is **`/dash-bind`**; the landing verb is **`/dash-join`**. `dash` and `join` survive as *retired spellings* — `session-card.tsx`'s `runRetiredVerb` runs the new handler and names the new spelling once per card, and `slash-commands.ts` marks them `deprecatedFor` so the completion popup teaches only the real name. Every gesture this plan touches is therefore spelled with its full name, and the retired spellings reach it for free.

What is left is the part that only shows up once somebody actually lives in the lane, plus the doctrine that has been accumulating in plan documents instead of in `tuglaws/`. Six specific gaps, each small, none of which the earlier phases could honestly have closed:

1. **A project with six dashes is unnavigable.** Bare `/dash-bind` (the `"dash-bind"` entry of the local slash-verb table in `tugdeck/src/components/tugways/cards/session-card.tsx`) opens the Changes shade and stops. That was the right answer for one dash; with several it shows them all and offers no way to pick one. Binding still means typing the name exactly. And the Lens **Dashes** section has no ordering at all — `dashRowsFromSnapshot` in `tugdeck/src/components/lens/sections/dashes-section.tsx` emits rows in project-enumeration order then snapshot order, so the dash somebody is working sorts below one created a week ago and forgotten.

2. **Only one binding gesture exists, and it is typed.** `bind_dash` and `unbind_dash` are both live CONTROL verbs on the server (`tugcast/src/feeds/agent_supervisor.rs`, dispatched in `handle_control`), and the deck already handles both acks — `action-dispatch.ts` registers `bind_dash_ok` and `unbind_dash_ok`, which move `cardSessionBindingStore`. But the deck **never sends `unbind_dash` from anywhere**, and it only sends `bind_dash` from the typed `/dash-bind <name>` verb. The shade's dash lane, which is the room where a dash's facts already live, offers neither.

3. **Nothing says whether a dash's plan is still reviewed.** Phase 2.1 built the whole apparatus — `tugutil_core::plan::review_state` returns `reviewed` / `stale` / `never-reviewed` by comparing the newest Review Record round's `plan:<hash>` stamp against the document's live content stamp, and `tugutil plan status` reports it. Phase 3.1 put `plan_path` on the dash changeset entry. `dash-implement` gates on it at setup. But no *surface* reads it, so the only way to learn that your plan drifted past its review is to run a CLI verb.

4. **The lifecycle is written down only in plans.** The state model (derive vs declare), the binding concept, and the identity model live scattered across `dash/dash-integration-*.md`, which are implementation records, not law. `tuglaws/INDEX.md` has a "Working on a dash" section holding exactly one file (`dash-work-doctrine.md`, which is about how an *agent* behaves on a worktree, not about what a dash *is*). Phase 4's step 11 put the *landing* half into `tuglaws/tracking-changes.md` — the one-slot `LandingMode` paragraph and the five-outcome table are already law and are not this phase's to restate. What that step did not touch is the `/commit` sentence beside them, which still describes a two-beat gesture ("no ready draft → open the shade and generate; ready draft → land it; … `now` collapses the beats"). That has been false since commit mode shipped; `/commit` now enters a mode via `commitModeController.enter()` and `now` means nothing. The `/dash-join` half of the same sentence was corrected by phase 4 and reads correctly today.

5. **Eight redirect stubs are still in the roster.** `tugplug/skills/` holds `audit`, `dash`, `dash-run`, `devise`, `implement`, `join`, `review-plan`, and `vet` — each a `disable-model-invocation` skill that prints a replacement chip and stops. They were introduced for one release so old transcripts' chips stayed clickable. That release has turned over.

6. **A dash's worktree path is relative to the wrong root, in four places.** `DashDetail.worktree_rel` is stripped against the **main** repository root — `dash_detail_entries_in` normalizes through `main_repo_root` before computing it (`tugdash-core/src/ops.rs`), which phase 4 added so a card whose project is a linked worktree reads the repository's dashes at all. But it rides the wire as a *relative* string, and every consumer joins it against the **project** root, which is exactly the root that may be a worktree: `tugcast/src/feeds/git.rs`'s `fetch_dash_diff` does `repo_dir.join(worktree_rel)`, `tugdeck/src/lib/plan-review.ts` does `joinPath(input.projectDir, input.boundDash.worktree)`, `session-changes-dash-lane.tsx` feeds the same string into the range descriptor, and `changeset-types.ts` documents the composition as the contract. On a worktree-hosted instance — which is what `just app-debug` produces, and therefore what every dash build is vetted on — all four resolve to a path that does not exist, and each degrades *silently*: the range diff drops worktree dirt and shows committed rounds only, and bare `/plan-review` cannot find the bound dash's plan. [#step-1](#step-1) fixes the trap at its producer before [#step-2](#step-2) adds a fifth consumer to it.

#### Strategy {#strategy}

- **Server computes, surfaces render.** Review state is derived exactly once, in `dash_entries` in `tugcast/src/feeds/changeset.rs`, and rides the dash changeset entry as one wire field. Three surfaces then read one value. Nothing in the deck parses a plan.
- **The server resolves paths; nothing downstream joins one.** A dash's worktree travels the wire **absolute**, resolved once where the main repository root is known ([P09]). The deck has no way to resolve a main root — it holds a project directory and nothing else — so "normalize at each consumer" is a fix that is not available to half the consumers, which is the argument for fixing it at the producer rather than at four call sites.
- **Ordering is a projection, not a store.** The Lens section's ordering is a pure sort inside `dashRowsFromSnapshot` over the snapshot it already reads. No new state, no persistence, nothing to invalidate.
- **The picker is a sheet, not transcript ink.** Picking which dash to work on is a UI-concept act, exactly like the bind it performs — silent, no turn, no transcript row. It goes on the card's existing sheet host, which is where every other picker in the session card already goes.
- **The two binding gestures go where the facts are.** Adopt and Leave land on the Changes shade's dash-lane rows and nowhere else. The Lens Dashes section stays the read-only account-global glance its own docblock says it is.
- **Doctrine is a subtraction, not an addition.** `tuglaws/dash-lifecycle.md` collects what is already true and scattered; it invents nothing. The one new global decision, [D138], is its compressed entry.
- **The deletions are last and separate.** Removing the stubs touches no code path, so it commits on its own and cannot be entangled with a behavior change.

#### Success Criteria (Measurable) {#success-criteria}

- A dash whose plan's newest stamped review round no longer matches the document's content stamp shows a stale mark in the Lens Dashes row, in the Changes shade's dash row, and on the masthead dash chip — verified by an app-test that creates a real dash, writes a real plan, stamps it with `tugutil plan stamp`, appends a line to the plan, and asserts the mark appears where it did not before.
- A dash's worktree path resolves correctly from an instance whose project directory is itself a linked worktree — verified by Rust tests that ask `dash_detail_entries_in` and `dash_review_state` from inside a worktree and assert the same answers the main root gives, the same shape phase 4 pinned with `preflight_asked_from_a_linked_worktree_answers_about_the_main_root`.
- With three dashes in a project, bare `/dash-bind` opens a sheet listing all three, arrow keys move the selection, and Return binds the card to the highlighted one — verified by an app-test asserting the binding store's dash name changed to the row that was highlighted.
- With exactly one dash, bare `/dash-bind` binds it and opens no sheet — verified in the same app-test.
- The Lens Dashes section orders worked dashes above parked ones and, within each group, `landing` above `built` above `working` above `created` — verified by a bun table test over `dashRowsFromSnapshot` and an app-test asserting DOM row order.
- Clicking Adopt on a non-fronted dash row rebinds this card to it (the masthead chip changes); clicking Leave on the fronted row clears the binding (the chip disappears) — verified by an app-test driving real clicks.
- `tuglaws/dash-lifecycle.md` exists, is registered in `tuglaws/INDEX.md`, and `tuglaws/tracking-changes.md` no longer describes `/commit` as two-beat — verified by grep in the step checkpoint.
- `tugplug/skills/` contains no directory named `audit`, `dash`, `dash-run`, `devise`, `implement`, `join`, `review-plan`, or `vet`, and no file in the repo outside `dash/` references `/tugplug:` + any of those names — verified by grep.

#### Scope {#scope}

1. An absolute worktree path on `DashDetail` and on the wire, and the four consumers that stop composing one ([P09]).
2. A `review` field on the dash changeset entry, computed server-side from the dash's recorded `plan_path`.
3. The stale-review mark in three surfaces: the Lens Dashes row, the Changes shade dash row, the masthead dash chip.
4. A total ordering for the Lens Dashes section.
5. A `/dash-bind` picker sheet for a project with more than one dash.
6. Adopt and Leave affordances on the Changes shade's dash-lane rows.
7. `tuglaws/dash-lifecycle.md`, its INDEX registration, global decision [D138], and the `tracking-changes.md` correction.
8. Deletion of the eight redirect-stub skills and the doc/manifest references to them.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Release.** The Release affordance and its discard preflight ship in [phase 4](dash-integration-4-join.md#step-10). This phase adds no second release path and no release verb.
- **Retiring the retired verb spellings.** `/dash` and `/join` keep running forever ([P06]). They are a different compat population from the skill stubs, and the difference is decisive: a stub skill that goes missing yields a "no such command" alert, while a *verb* that stops matching the local registry is submitted to Claude as a prompt — the one outcome worse than either spelling.
- **Creating a dash from the picker.** `/dash-bind <name>` already creates-if-needed and leaves a shell receipt saying what was made ([P05] of phase 2's plan). The picker never runs a git mutation.
- **Gating anything on review state.** The mark is advisory ([P07]). `dash-implement` already refuses to walk a stale plan at setup; a second gate at landing would block work the user can see is fine.
- **Dropping the draft ledger's legacy owner key.** `tugutil draft`'s `legacy_id` / `legacy_owner_id` fallback (`tugutil/src/draft.rs`, `tugcast/src/server.rs`, `tugcast/src/feeds/changeset.rs`) stays ([P06]).
- **A cross-project picker.** The `/dash` picker lists this card's project's dashes. The account-global list is the Lens's job and stays there.
- **Any new chord.** Nothing here earns one; ⌃⌘J is Jots.

#### Dependencies / Prerequisites {#dependencies}

- **Phase 4 (join mode) is landed — `06c461d50` on `main`.** [#step-6](#step-6) adds affordances to the `session-changes-dash-lane.tsx` rows phase 4 restructured. The landed shape is the one to build on, and it is not quite the one phase 4's plan described: `SessionChangesDashLaneProps` is `{ dashes, boundDashId, projectRoot, landing? }`, where `landing` is a **bundle** (`DashLaneLanding`, carrying a `DashLandingActions` record of five callbacks) that is handed to the fronted row only — every other row is rendered with `landing={null}`. That matters for [#step-6](#step-6), whose Adopt affordance lives on exactly the rows the landing bundle never reaches.
- Phase 2.1 (shipped, `eb5953baa` + fixups): `tugutil_core::plan` with `parse`, `review_state`, `content_stamp`, `ReviewState`.
- Phase 3.1 (shipped, `1eba4c683`): `plan_path` on `DashDetail` and on the dash changeset entry; `tugutil plan status` / `stamp`.
- `tugcast` already depends on `tugutil-core` (see `tugrust/crates/tugcast/Cargo.toml`) — [#step-2](#step-2) needs no new dependency edge.

#### Constraints {#constraints}

- **Warnings are errors.** `tugrust/.cargo/config.toml` sets `-D warnings`; a build with any warning fails.
- Every tugdeck change must pass `bunx tsc --noEmit` and `bunx vite build` — the debug app loads the rollup bundle, so a change that only survives HMR is not done.
- App-tests are selective. `just app-test-changed` derives the run from `@covers` back-references and refuses past a 20-file budget; when it refuses, name the files. Never `just app-test-all`.
- Any new `*.test.ts` under `tests/app-test/` must carry `@covers` lines that resolve, or `just app-test-covers-check` fails.
- The Lens Dashes section's data pass must not read per-card session phase — phase lives on `codeSessionStore` snapshots that move on every transcript event, and the section deliberately mounts that subscription at the leaf (`DashPhaseDot`). [#step-4](#step-4)'s ordering must stay inside the snapshot projection for the same reason.

#### Assumptions {#assumptions}

- A plan document is small (tens of kilobytes) and `plan::parse` is a single-pass markdown scan, so reading and parsing one plan per dash inside the changeset feed's existing blocking hop is negligible next to the git subprocesses `dash_detail_entries_in` already runs for each dash ([P04]).
- Most projects hold a handful of dashes, not hundreds — the picker is a flat list with no search field, and the Lens ordering is an ordinary comparator sort.
- The Session card's `/` completion popup is built from the `session_capabilities` command catalog, so deleting a skill directory removes it from the popup with no deck change ([#step-8](#step-8)).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should a parked dash's row say how long it has been parked? (DEFERRED) {#q01-parked-age}

**Question:** The Lens row and the shade row both render the parked mark as a binary — either a live session is working this dash or none is. Neither says *when* it was last worked. A dash parked for an hour and one parked for three weeks read identically, and only the second one is a candidate for release.

**Why it matters:** It changes what the feed carries. "Last worked" is not derivable from anything currently on the wire: `bound_sessions` is a live-sessions-only query, so an unbound dash carries no timestamp at all. Answering it means either surfacing the newest dash-log line's timestamp (`append_dash_log` writes them; nothing reads them back as a time) or the branch tip's committer date. Both are new fields on `DashDetail` and on the changeset entry.

**Options (if known):**
- Newest dash-log entry's timestamp — the truest "last activity", since it counts `mark` and `step` declarations, not just commits.
- Branch tip committer date — free from git, but a dash worked all day without a commit reads as stale.
- Nothing — parked is parked.

**Plan to resolve:** Revisit once the lane has been lived in with more than a handful of dashes at once, which is the only condition under which the distinction pays for a new wire field. If it earns its way in, the dash-log timestamp is the candidate to spike first, since it is the one that matches what "worked" means everywhere else in this program.

**Resolution:** DEFERRED — not required for phase close. Nothing in this phase forecloses it: adding a field to `DashChangesetEntry` is additive and skip-if-none, exactly as `plan_path` and `review` are.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Reading a plan per dash per recompose slows the changeset feed | low | low | The read happens inside the existing `spawn_blocking` hop, alongside git subprocesses that already dominate; an unreadable or unparseable plan degrades to no field, never to an error | A changeset recompose measurably regresses on a repo with many dashes |
| Phase 5's row affordances conflict with phase 4's row rewrite | med | **retired** | Phase 4 landed as `06c461d50` and the row shape is read rather than predicted (#dependencies); [#step-6](#step-6) extends the bundle it established and threads it wider, which is the one difference from what phase 4's own plan described | — |
| Changing the `worktree` field's meaning breaks a consumer nobody enumerated | med | low | [#worktree-path-sites](#worktree-path-sites) is the exhaustive list, produced by grepping both languages for the field and its Rust source; the field keeps its name so a missed consumer keeps compiling — which is why the two Rust worktree-asked tests, not the type-checker, are the falsifier | A dash-related path resolves wrong on a worktree-hosted instance after step 1 |
| Deleting a stub breaks a clickable chip in an old transcript | low | high | Accepted deliberately — the chip becomes an unknown command, which the card already handles with a "no such command" alert rather than a burned turn | A user reports losing something they still reach for |
| The picker's binding races a mid-turn rebind | low | low | `bind_dash` is a CONTROL verb with no turn semantics, and the binding store moves only on the `bind_dash_ok` broadcast, so a refusal leaves the card bound to what it was | — |

**Risk R01: The stale mark misreads a plan the dash does not actually drive** {#r01-wrong-plan}

- **Risk:** `plan_path` is recorded on the dash's branch config by `dash step start --plan`, and it is never cleared. A dash that finished its plan, then carried on with unrelated `dash-on` rounds, still points at that plan — and if somebody edits the plan afterwards, the dash grows a stale mark for work it is no longer doing.
- **Mitigation:**
  - The mark is advisory and carries a tooltip naming the plan path ([P03]), so the reading is always "this plan, which this dash recorded" rather than an unattributed alarm.
  - The mark is *absent*, not benign-looking, when there is no `plan_path` — a plan-less dash never grows one.
- **Residual risk:** A long-lived dash that outgrew its plan reads as stale forever. Clearing `plan_path` would need a verb (`dash step` is the only writer today) and no gesture asks for one yet; the honest answer is that such a dash *is* pointing at a stale plan, which is true even if it no longer cares.

**Risk R02: `unbind_dash` leaves the server's ledger and the card disagreeing** {#r02-unbind-ledger}

- **Risk:** Leave sends `unbind_dash { tug_session_id }` and waits for `unbind_dash_ok` to clear `cardSessionBindingStore`. If the broadcast is lost, the card keeps showing a dash chip for a binding the ledger no longer holds, and the shade's lane keeps fronting that dash.
- **Mitigation:**
  - The deck already treats the ack as the only mover for the bind direction (`action-dispatch.ts`'s `bind_dash_ok` / `unbind_dash_ok` handlers, and the `dash-bind-error-store` for refusals) — Leave inherits that discipline rather than optimistically clearing.
  - The next changeset recompose re-emits `bound_sessions` from the ledger, so the Lens row self-corrects even if the card's chip does not.
- **Residual risk:** A dropped ack leaves one card's chip wrong until it rebinds or reloads. That is the pre-existing property of every binding gesture in the lane, not something this step introduces.

---

### Design Decisions {#design-decisions}

#### [P01] The `/dash-bind` picker is a pane-modal sheet, never transcript ink (DECIDED) {#p01-picker-sheet}

**Decision:** Bare `/dash-bind` in a project with more than one dash opens a sheet on the session card's existing sheet host (`cardPickerSheet`, the `useTugSheet()` instance the card already holds and renders), listing the project's dashes; Return or click binds the highlighted one and closes. With exactly one dash it binds that dash directly and opens nothing. With none it keeps today's caution, **corrected to name the real verb** — the string currently reads "No dashes in this project — /dash \<name\> starts one" and `/dash` is now a retired spelling. The shade no longer opens as the bare response.

The gesture is spelled `/dash-bind` throughout; bare `/dash` reaches the same handler through `runRetiredVerb` and therefore gets the picker for free, with no branch of its own.

**Rationale:**
- Picking a dash is a UI-concept act with no turn and no durable consequence, exactly like the `bind_dash` it performs. Transcript ink is for things that happened to the *work*; a pick is not one of them. A `TugInlineDialog` mounted in transcript flow — the other candidate — would put a disposable choice permanently in the record.
- The sheet host is where every other picker in the session card already lives (the card picker, the compaction progress sheet, the slash-command notice alert, and a dozen more `showSheet` call sites), so this needs no new surface, no new dismissal semantics, and no new focus scope.
- One dash is not a choice. Opening a sheet to confirm the only option is ceremony, and the existing verb already has the "act, don't ask" shape for the named case.

**Implications:**
- The sheet's `content` renders a `TugListView` over a data source built from the project's dash entries, composing `TugListRow` per [L19]; the list owns arrow navigation and `commitOnEnter`, so no key handling is written by hand.
- The picker never mutates git and never touches `shellSessionStore` — see [#non-goals](#non-goals).
- Bare `/dash-bind` no longer calls `shadeViewController.show("changes")`. The shade remains reachable by every other route it already has.

#### [P02] The Lens Dashes section is totally ordered: worked first, then by stage, then by name (DECIDED) {#p02-lens-ordering}

**Decision:** `dashRowsFromSnapshot` sorts its flattened rows by a three-key comparator: (1) not-parked before parked; (2) descending stage rank, `landing` > `draft-ready` > `audited` > `built` > `implementing` > `working` > `created`, with an absent or unrecognized stage sorting last; (3) `display_name` ascending as the tiebreak. Project grouping is dropped as an ordering key — the project label already rides each row when more than one project has dashes.

**Rationale:**
- The section's own job, per its docblock, is to answer *whether anyone is on it*. An ordering that ignores that answer contradicts the section's premise; sorting worked dashes first makes the first screenful the useful one.
- Stage rank is nearest-to-done first, because the actionable dash is the one about to land, not the one just created. `landing` sorts top because it means an interrupted teardown — the one state that actively needs a person.
- Name is the tiebreak rather than snapshot order because snapshot order is git-enumeration order, which is stable but arbitrary, and an arbitrary stable order still reshuffles when a branch is created or deleted.
- The sort is a pure function of the snapshot, so it stays inside the projection and adds no state, no store, and nothing to invalidate ([L02] is untouched).

**Implications:**
- The stage-rank table is exported so its test can be a table test rather than a DOM assertion.
- Rows keyed on `ownerId` already, so reordering does not disturb `TugListView` identity.

#### [P03] Review state is computed on the server and rides the changeset entry (DECIDED) {#p03-review-on-the-wire}

**Decision:** `dash_entries` in `tugcast/src/feeds/changeset.rs` resolves each dash's plan (the detail's **absolute** worktree path per [P09], joined with `plan_path`), reads it, parses it with `tugutil_core::plan::parse`, and emits `review: Some("reviewed" | "stale" | "never-reviewed")` on the dash changeset entry. A dash with no `plan_path`, an unreadable file, or a document that does not parse as a plan emits no field at all. The deck never reads a plan.

**Rationale:**
- The value already has exactly one definition — `tugutil_core::plan::review_state` — and `tugcast` already depends on that crate. Computing it anywhere else would be a second implementation of a hash comparison, which is the class of duplication that drifts silently.
- The deck has no filesystem access and no markdown plan parser, and giving it either to paint a badge would be a large amount of new surface for a cosmetic mark.
- Three surfaces need the same answer. One field on the entry they all already read is the whole delivery.
- **Absence is the honest reading for every failure.** A plan that cannot be read has not been shown to be stale; emitting `never-reviewed` for an I/O error would put a scolding mark on a dash whose plan is merely on a branch that is not checked out.
- That last property is also why this read must not compose its own path: a wrong path is indistinguishable from an absent plan, so a path bug here does not fail — it goes quiet. [P09] is what keeps the silence meaning what it says.

**Implications:**
- `ChangesetEntry::Dash` grows `review: Option<String>` with `skip_serializing_if = "Option::is_none"`, matching how `plan_path` and `step_current` already ride.
- `DashChangesetEntry` in `tugdeck/src/lib/changeset-types.ts` grows `review?: string`, and the changeset golden fixtures (`tugdeck/src/__tests__/fixtures/changeset-snapshot.golden.json`, `workspaces-changeset-snapshot.golden.json`) are regenerated if they carry a dash entry.
- The read is unconditional per recompose with no memoization — see [P04].

#### [P04] The plan read is unconditional; no mtime cache (DECIDED) {#p04-no-cache}

**Decision:** The review-state read happens on every changeset recompose, with no caching layer keyed on path, mtime, or size.

**Rationale:**
- `dash_entries` already calls `tugdash_core::dash_detail_entries_in`, which runs several `git` subprocesses *per dash* (branch config reads, a rev-list for rounds, a status for worktree dirt, a log for round subjects). A process spawn costs more than reading and parsing a 50 KB markdown file, so a cache would be optimizing the cheap half.
- A cache is a correctness surface: keyed on mtime it misses same-second edits, keyed on content it has already done the read. Neither is worth carrying for a badge.

**Implications:**
- If a repo with many dashes ever measurably regresses, the fix is to cache `dash_detail_entries_in`'s whole result, not the plan read — this decision names the right target for that future work rather than pre-solving it in the wrong place.

#### [P05] Adopt and Leave live on the shade's dash rows; the Lens stays read-only (DECIDED) {#p05-affordance-home}

**Decision:** A non-fronted dash row in the Changes shade's dash lane gains an **Adopt** affordance that sends `bind_dash`; the fronted row (this card's own dash) gains a **Leave** affordance that sends `unbind_dash`. The Lens Dashes section gains no verbs and keeps its jump-to-card chip as its only gesture.

**Rationale:**
- The shade is already the room where a dash's facts live — base, rounds, dirt, round subjects, join draft, and (after phase 4) the landing outcome. The act of taking a dash on belongs beside the facts you would take it on for.
- The Lens is account-global and its rows deliberately span projects; a bind is per-card and per-project, so a bind gesture there would need to answer "bound to which card?" — a question the Lens has no answer to and the shade answers by construction (it is *this card's* shade).
- The Lens section's docblock states it is read-only on purpose. Keeping it so means one fewer surface to keep honest as the lane's verbs grow.
- Adopt on a non-fronted row and Leave on the fronted one are complements, so the two never appear on the same row and the cluster stays one affordance wide.

**Implications:**
- `SessionChangesDashLaneProps` grows **one** optional bundle, `binding?: DashLaneBinding` with `{ adopt(entry), leave(entry), disabledReason: string | null }` — matching the shape phase 4 established for `landing`, rather than opening a second vocabulary of loose callbacks in the same component. The lane stays presentational; `session-changes-view.tsx` wires the senders.
- **The bundle goes to every row, unlike `landing`.** Phase 4 hands `landing` to the fronted row only and passes `landing={null}` to the rest, which is right for a landing gesture and exactly wrong for Adopt — Adopt's whole population is the non-fronted rows. `binding` is therefore threaded to every `DashRow`, and the row picks Adopt or Leave from its own `fronted` flag.
- The card is the only thing that knows its `tugSessionId` and `projectDir`, so the senders are built there (or in the view from `cardSessionBindingStore`), not in the lane.
- Adopt on a row whose dash this card is *already* bound to never renders — that row is the fronted one by definition.
- Phase 4's rule that "non-fronted dash rows stay read-only" is about *landing* — a gesture that lands work from a card that never touched it. Adopting is the opposite act (it is how a card comes to touch it), so it does not violate that rule.

#### [P06] The skill stubs go; the draft ledger's legacy owner key stays (DECIDED) {#p06-what-compat-goes}

**Decision:** Delete the eight redirect-stub skill directories — `audit`, `dash`, `dash-run`, `devise`, `implement`, `join`, `review-plan`, `vet` — and every doc/manifest reference to them. Keep `tugutil draft`'s legacy owner-key fallback in full: `Owner::legacy_id`, `dash_owner`'s bare-`tugdash/<name>` sibling, the `legacy_owner_id` field on the draft-set request, `tugcast/src/server.rs`'s read-through-and-supersede, and `legacy_owner_key` in `tugdash-core::ops` with its use in `feeds/changeset.rs` and `feeds/agent_supervisor.rs`. **Keep the two retired verb spellings, `/dash` and `/join`, permanently** — `runRetiredVerb`'s entries in `session-card.tsx` and their `deprecatedFor` descriptors in `slash-commands.ts` are not part of this deletion and are not scheduled for one.

**Rationale:**
- The three compat surfaces have different clocks, and only one of them has run out. A stub skill is compat for **text in a transcript**: it expires the moment nobody clicks an old chip, and its failure mode is a "no such command" alert. The legacy owner key is compat for **rows on disk** in a SQLite ledger, which can be arbitrarily old and whose failure mode is a draft that silently cannot be found.
- A retired **verb spelling** is compat for **muscle memory**, which does not expire on a release schedule at all, and its failure mode is the worst of the three: a `/verb` that stops matching the local registry is submitted to Claude as a prompt — a burned turn on a line the user meant as a gesture. The comment in `session-card.tsx` states this and it is right. The aliases already cost nothing to keep: `deprecatedFor` excludes them from the completion popup, so they are invisible to discovery and only reachable by someone typing the old name from memory, which is precisely the population they exist for.
- The legacy key costs nothing to keep: it is a read-side fallback that *supersedes* — the first resolution through the legacy key rewrites the row under the current key, so the population it serves shrinks to zero on its own. Deleting it would strand exactly the rows it has not reached yet.
- Eight stubs is a roster three-quarters composed of redirects, which makes the real roster hard to read — the cost of keeping them is paid on every listing.

**Implications:**
- `tugplug/.claude-plugin/plugin.json`'s `description` and `keywords` name `devise`, `review-plan`, `implement`, and `dash`; they are rewritten to the shipped names.
- `tugplug/CLAUDE.md`'s stub paragraph is deleted, not amended.
- Step 7's grep is scoped to `/tugplug:<name>` — the *skill* invocation form — precisely so it cannot convict the surviving verb aliases, which are card-local commands and share two of the names.
- Nothing in `tugdeck/`, `tugrust/`, or `tugapp/` references a stub by name (verified by grep across the repo; the only hits outside `tugplug/skills/` and `dash/` are in the plugin manifest), so no code change is entangled with this deletion.

#### [P07] The stale-review mark is advisory and gates nothing (DECIDED) {#p07-advisory-only}

**Decision:** The mark paints in three surfaces with a tooltip naming the plan and its state, and blocks no gesture. Join mode's gate readout does not mention it; the Join affordance's enablement does not consider it.

**Rationale:**
- The gate that matters already exists and is earlier: `dash-implement` reads `tugutil plan status` at setup and raises a dialog before walking a plan whose review is `stale` or `never-reviewed`. That is the moment where acting on an unreviewed design is expensive.
- By landing time the work is written, built, and vetted by a human. Blocking a landing on a document's hash would refuse work the user is looking at, on the strength of a mark about a *plan*.
- An advisory mark that is never a blocker can be read at a glance and ignored; a mark that is sometimes a blocker has to be reasoned about every time.

**Implications:**
- No change to phase 4's `JoinBlocker` set, its wire spec, or its gate.
- The mark's whole contract is: paint, and say what it means on hover.

#### [P08] `tuglaws/dash-lifecycle.md` is the one home for the dash model; [D138] is its compressed entry (DECIDED) {#p08-doctrine-home}

**Decision:** Write `tuglaws/dash-lifecycle.md` covering the state model (the seven derived/declared stages and `derive_stage`'s precedence), the identity model (owner key, creation id, legacy key), the binding concept (what a bind is, that it is per-card and live-sessions-only, that it is a UI concept git cannot see), and the derive-vs-declare rule. The landing doctrine is **cross-referenced, not restated** — phase 4's step 11 put it in `tuglaws/tracking-changes.md` (the one-slot `LandingMode` paragraph and the five-outcome table), which is where the capture/commit layer already lives, and a second copy would be a second thing to keep true. Register the new file in `tuglaws/INDEX.md` under the existing "Working on a dash" section beside `dash-work-doctrine.md`. Add one new global decision, **[D138]**, stating the derive-vs-declare rule compactly and pointing at the new file. Correct `tuglaws/tracking-changes.md`'s stale two-beat `/commit` sentence — and only that clause, since phase 4 already corrected the `/dash-join` half of the same sentence.

**Rationale:**
- The distinction between the two dash docs is real and worth keeping: `dash-work-doctrine.md` is about **how an agent behaves** on a worktree (working root, verification bar, banned test shapes); `dash-lifecycle.md` is about **what a dash is** and what its states mean. Merging them would give one file two audiences.
- `design-decisions.md` entries are single dense paragraphs; the lifecycle needs tables and a state list, so the file is the home and [D138] is the index into it — the same relationship `tracking-changes.md` has with [D112] and [D113].
- The `/commit` sentence is not merely out of date, it describes a gesture that no longer exists (`now` was a real keyword and is now inert), which is the kind of doc error that costs somebody an afternoon.

**Implications:**
- [D138] is the next free number: `design-decisions.md`'s highest existing entry is **D137**.
- The new file is doctrine only — it introduces no rule that the code does not already follow, so nothing in this step can fail a test.

#### [P09] A dash's worktree path is resolved once, where the main root is known, and travels absolute (DECIDED) {#p09-absolute-worktree}

**Decision:** `DashDetail` gains `worktree_abs: String` — the absolute worktree path, which `dash_detail_entries_in` already computes (`worktree_path(repo_root, name)` against its `main_repo_root`-normalized root) and currently discards after stripping it to `worktree_rel`. The dash changeset entry's `worktree` field carries **that** string instead of the relative one, and the three consumers that compose a path from it stop composing: `fetch_dash_diff` takes an absolute worktree rather than a root plus a relative tail, `plan-review.ts` joins the plan path onto the worktree it was given, and the shade lane's range descriptor passes the value through unchanged. `worktree_rel` stays on `DashDetail` for the CLI's JSON, which is read relative to the repository by a human.

**Rationale:**
- **The relative path is relative to a root the consumers do not hold.** Phase 4 made every dash op resolve a linked worktree to the main repository root, because a dash's branch and worktree live in the main repository whatever root you ask from. `worktree_rel` is stripped against *that* root; the consumers join it against the *project* root, which is the one that may be a worktree. The two roots are equal in the common case, which is exactly why this survived four consumers.
- **Half the consumers cannot be fixed any other way.** `plan-review.ts` and the range descriptor run in the deck, which holds a project directory and has no notion of a main root and no way to find one. A per-consumer normalization is not a policy the deck can participate in; resolving at the producer is. This is the same shape as [L29] — paths are resolved by the side that can resolve them, and the other side carries what it is handed.
- **The failure mode is silence in all four places.** A missing worktree makes `fetch_dash_diff` fall back to committed rounds only, makes the review read return `None`, and makes bare `/plan-review` fail to find a plan. None of them raise. A defect that degrades quietly on the developer's own debug build is worth a step of its own rather than a note.

**Implications:**
- The wire field keeps its name (`worktree`) and changes meaning, so its doc comment in `changeset-types.ts` — which currently states the composition as the contract — is rewritten, not amended.
- Both golden fixtures carry a dash entry with a `worktree` value; they move in this step, and the moved value is a `TempDir`-rooted absolute path, so whatever normalization the fixture generator already applies to `project_dir` applies here too.
- `build_dash_diff_snapshot`'s and `fetch_dash_diff`'s signatures lose a parameter rather than gaining one — the root is no longer needed to find the worktree, only to decide `is_within_git_worktree`.
- Nothing about this is visible to a user. Its whole proof is that four existing behaviors start working on a worktree-hosted instance, which is what its tests assert.

---

### Deep Dives {#deep-dives}

#### Every place a dash worktree path is composed {#worktree-path-sites}

[#step-1](#step-1) is a small change spread over four files, and missing one leaves the trap armed for the next caller. This is the complete list as of `06c461d50`, found by grepping `worktree_rel` in `tugrust/crates/` and `\.worktree\b` in `tugdeck/src/`.

| Site | What it does today | After [P09] |
|---|---|---|
| `tugdash-core/src/ops.rs`, in `dash_detail_entries_in` | computes `worktree_abs`, strips it to `worktree_rel` against the normalized root, and drops the absolute form | keeps both; `worktree_abs` joins `DashDetail` |
| `tugcast/src/feeds/changeset.rs`, `dash_entries` | sends `worktree: detail.worktree_rel` | sends `detail.worktree_abs` |
| `tugcast/src/feeds/git.rs`, `fetch_dash_diff` / `build_dash_diff_snapshot` | `repo_dir.join(worktree_rel)`; when the result is not a directory, silently degrades to committed rounds with no worktree dirt | takes the absolute worktree; `repo_dir` stays only for `is_within_git_worktree` |
| `tugdeck/src/lib/plan-review.ts` | `joinPath(input.projectDir, input.boundDash.worktree)` then the plan path — bare `/plan-review` cannot find the bound dash's plan when it misses | joins the plan path onto the worktree it was given |
| `tugdeck/src/lib/changeset-types.ts` | documents "Absolute path is `projectDir` / `worktree` / `plan_path`" as the contract | documents `worktree` as already absolute and `plan_path` as relative to it |

`session-changes-dash-lane.tsx` and `git-diff-store.ts` pass the value through into the range descriptor without composing anything, so they need no change beyond the type's meaning — which is why the field keeps its name and gains a corrected doc comment rather than being renamed.

#### How review state is resolved, exactly {#review-resolution}

The pieces already exist and only need joining. In `tugrust/crates/tugcast/src/feeds/changeset.rs`, `dash_entries(repo_root, ledger)` runs `tugdash_core::dash_detail_entries_in(&root)` inside a single `tokio::task::spawn_blocking` hop and maps each `DashDetail` into a `ChangesetEntry::Dash`. The detail already carries `plan_path: Option<String>` (recorded on the dash's branch config by `dash step start --plan`, read back by `tugdash_core::ops::dash_plan_path`), and after [#step-1](#step-1) it carries `worktree_abs`.

The plan is at `worktree_abs.join(plan_path)`. It is the **worktree** copy deliberately: that is the document a dash run edits and whose ledger the step verbs rewrite, so it is the one whose review state describes the work in flight.

**Do not compose the path from `dash_entries`' `repo_root` argument.** That is the card's project directory, which may itself be a linked worktree; `dash_detail_entries_in` normalizes it through `main_repo_root` before doing anything, so the `worktree_rel` it hands back is relative to a *different* root than the one the caller holds ([P09] carries the full argument). Joining them yields a path that does not exist, and because every failure here is `None`, the result is not an error — it is a mark that never appears, on exactly the debug instance a dash build is vetted on.

From there:

```rust
fn dash_review_state(worktree_abs: &Path, plan_path: &str) -> Option<String> {
    let abs = worktree_abs.join(plan_path);
    let source = std::fs::read_to_string(&abs).ok()?;
    let doc = tugutil_core::plan::parse(&source).ok()?;
    Some(tugutil_core::plan::review_state(&doc, &source).as_str().to_string())
}
```

Every failure is `None`, per [P03]. `ReviewState::as_str` already returns the exact wire spellings `plan status` reports (`"reviewed"`, `"stale"`, `"never-reviewed"`), so there is no second vocabulary to keep in sync.

The call must happen **inside** the `spawn_blocking` closure — it is synchronous file I/O, and hoisting it out would put a blocking read on the async runtime. The cleanest shape is to compute it in the same closure that produces the details, returning `(DashDetail, Option<String>)` pairs.

**No app-test can catch a path bug here, and none should be asked to.** App-test instances register the base checkout as their project, so the project root and the main root are the same directory and every composition works by coincidence. The falsifier has to be a Rust test that asks from inside a linked worktree — the shape phase 4 already established with `preflight_asked_from_a_linked_worktree_answers_about_the_main_root` in `tugdash-core/src/ops.rs`, which is the model for the ones [#step-1](#step-1) and [#step-2](#step-2) add.

#### What the mark looks like in each of the three surfaces {#mark-surfaces}

All three read the same field and paint per [L06] — a data attribute plus CSS, never React state for appearance.

| Surface | File | Where it goes | Shape |
|---|---|---|---|
| Lens Dashes row | `tugdeck/src/components/lens/sections/dashes-section.tsx` | A new fact in the `lens-dashes-facts` span, after `lens-dashes-stage` | A small glyph wrapped in `TugTooltip`, `data-slot="lens-dashes-review"`, `data-review="stale"` |
| Changes shade dash row | `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx` | A new fact in the `session-changes-dash-facts` span, after the stage fact, behind the same `·` separator convention | Same glyph + tooltip, `data-slot="session-changes-dash-review"` |
| Masthead dash chip | `tugdeck/src/components/tugways/session-masthead.tsx` | The existing `session-masthead-dash-chip` `TugBadge` gains a `data-review` attribute; CSS paints the mark | Attribute only — no new element inside the chip, which is one line tall |

Only `stale` and `never-reviewed` paint. `reviewed` and absent paint nothing, because a mark that is always present is not a mark. The two painting states are visually distinct (per the tooltip text at minimum), because "this was reviewed and has moved since" and "nothing ever reviewed this" call for different responses.

**The masthead reads the account-global aggregate, not a card controller.** `SessionMastheadProps` is `{ sessionId, cardId?, accessoryHost? }` — it is handed no `ChangesRouteController` and must not grow one for a badge. The precedent it should follow is already in the same file: it reads the branch with `useSessionBranch(projectDir)` from `@/lib/changeset-all-store`, which is exactly this shape — a per-card fact derived from the account-global snapshot via `useSyncExternalStore` ([L02]).

So the mechanism is a sibling hook in `tugdeck/src/lib/changeset-all-store.ts`, written beside `branchForProject` / `useSessionBranch` and memoized the same way:

```ts
export function dashReviewForProject(
  data: WorkspacesChangesetSnapshot,
  projectDir: string | null,
  dashOwnerId: string | null,
): string | null
export function useDashReviewState(
  projectDir: string | null,
  dashOwnerId: string | null,
): string | null
```

It finds the project by `project_dir`, then the dash entry by **`owner_id === dashOwnerId`** — never by name. A stale binding to a dead incarnation of a reused name must not paint the wrong dash's mark; this is the same rule `orderDashLane` in the shade lane already states for choosing the fronted row. The masthead already holds `projectDir` (it computes it for `useSessionBranch`) and gets the owner key from `cardSessionBindingStore.getBinding(cardId)?.dash?.id`.

#### The picker's shape {#picker-shape}

The handler lives in `session-card.tsx`'s local slash-verb table, in the `name.length === 0` branch of the existing `"dash-bind":` entry. The branch becomes:

- `snap.dashes.length === 0` → today's caution, unchanged.
- `snap.dashes.length === 1` → send `bind_dash` for that one dash. No sheet.
- otherwise → `void cardPickerSheet.showSheet({ title: "Work on a dash", icon: "GitBranch", iconRole: "agent", content: (close) => <DashPickerSheet … /> })`.

`DashPickerSheet` is a new component beside the other card sheets. It composes `TugListView` with a flat immutable data source over the project's dash entries (the same `DashRowsDataSource` pattern the Lens section uses — a class with `numberOfItems` / `idForIndex` / `kindForIndex` / a no-op `subscribe` / `getVersion` returning the array), one `TugListRow` per dash showing name · stage · rounds · dirty, with `commitOnEnter="act"` and a delegate whose `onActivate(index)` sends the bind and calls `close()`.

The card's own dash (matched by owner key against `cardSessionBindingStore.getBinding(cardId)?.dash?.id`) renders with a "current" mark and is the initially-selected row. Seed it with `TugListView`'s `initialSelectedIndex` prop — the surface-supplied active row, which the list prefers over its own selection when placing the cursor — so Return with no arrow presses is a no-op rebind rather than a surprise. Do not mirror the selection into React state; the list owns it ([L19]).

The uncomposed guard (`!snap.composed`) must come **before** the branch on `snap.dashes.length`, not after: before the first aggregate emit the list is empty for reasons that have nothing to do with the project, and showing "no dashes in this project" then is a lie. The existing handler already has this guard but places it after the bare-form branch, which is correct today only because the bare form's response (open the shade) is harmless when the snapshot is empty. Moving it up is part of this step.

#### Adopt and Leave: the wire, exactly {#adopt-leave-wire}

Both are CONTROL frames on the existing connection, sent with `getConnection()?.sendControlFrame(...)`, and neither produces transcript ink.

**Adopt** — the same frame the typed `/dash-bind <name>` verb already sends:

```
bind_dash { tug_session_id, project_dir, dash: <display_name> }
```

Parsed by `parse_bind_dash_payload` in `tugcast/src/feeds/agent_supervisor.rs`. Note the payload names the dash by its **short name**, not its owner key — that is the existing verb's contract and Adopt inherits it. The bind **mints**: naming a dash that does not exist succeeds anyway. That is not reachable here (the name comes from a row in the snapshot), but it is why the frame must never be built from user text on this path.

**Leave**:

```
unbind_dash { tug_session_id }
```

Parsed by `parse_tug_session_id_payload` — the session id is the whole payload, because a session has at most one dash binding. Nothing else is needed and nothing else is read.

Both acks are already registered in `tugdeck/src/action-dispatch.ts` (`bind_dash_ok`, `unbind_dash_ok`) and both already move `cardSessionBindingStore`. **Neither affordance may optimistically move the store** — the broadcast is the mover, per the comment already in `action-dispatch.ts` ("the chip and the lane both wait for `bind_dash_ok` — so a refusal has …"). This is what makes a refused bind leave the card correctly bound to what it was.

**What gates them, and what does not.** The disable predicate is *a landing is in flight* — `codeSessionStore`'s turn-in-progress flag, plus a live `landingMode` on the prompt entry. It is **not** `evaluateJoinLandGate` (`tugdeck/src/lib/join-mode-controller.ts`), even though that is the gate the Join affordance beside it uses: that function refuses on `outcome`, on `blockers`, and on an empty message, and a dash that is off-base or conflicted is precisely a dash somebody should be able to adopt — refusing the bind because the *join* would fail would strand the dash on nobody. The only thing worth blocking is a binding change that would move the shade's fronting out from under an open join, and that is what the narrower predicate says.

#### What happens on the edges {#edges}

The happy paths above are short; these are the cases an implementer will hit and should not have to re-derive.

**Two cards on one dash is legal, not a race.** `bound_sessions` is a *list*, and the Lens row already renders one jump chip per bound session. Adopting a dash another card holds is a supported state, not a conflict — do **not** add a guard, a confirm, or a steal. The only thing a bind displaces is *this* card's previous binding, because a session has at most one dash (which is why `unbind_dash`'s payload is the session id and nothing else).

**A picker dismissed mid-bind is harmless.** `close()` runs immediately after `onPick` sends the frame; the `bind_dash_ok` broadcast then lands on a card with no sheet and moves the binding store anyway, because the store's mover is the ack and never the sheet. The sheet's promise carries no result and nothing awaits the bind's outcome — a refusal surfaces through `dash-bind-error-store`, which is card-scoped and outlives the sheet.

**A released dash disappears mid-gesture.** Release (phase 4's step 10) tears down branch and worktree; the entry vanishes on the next aggregate recompose and the row unmounts. A click already in flight against that row sends `bind_dash` for a name that no longer exists — and `bind_dash` **mints**, so it succeeds and leaves the card wearing a chip for a dash with no branch. This is pre-existing (`/dash-bind <name>` has always had it, which is why the typed verb matches against the snapshot first) and is not this phase's to fix; the exposure here is one recompose wide.

**The mark and the mid-review plan.** `plan-review` edits the plan and stamps it *last*, so a recompose landing between the edit and the stamp reads `stale` for a plan that is being reviewed right now. That is correct — it *is* stale at that instant — and it self-corrects on the next recompose after the stamp. No debounce, no suppression: a mark that lied about the intervening moment would be worse than one that flickers.

**A plan on a branch that is not checked out.** `plan_path` is worktree-relative and the worktree is the dash's own, so the file is on disk whenever the dash is active. A dash whose worktree was removed out from under it (a manual `git worktree remove`) reads as `None` per [P03] rather than as an error — which is the same degradation `dash_detail_entries_in` already applies to every other fact about such a dash.

#### What `tuglaws/dash-lifecycle.md` has to say {#lifecycle-contents}

The material is all established; the file's job is to hold it in one place. The outline:

- **What a dash is.** A git branch (`tugdash/<name>`) plus a worktree plus branch config (`branch.tugdash/<name>.{tugbase,description,tugid,tugplan}`) plus a dash-log. Every fact about a dash is one of those four; there is no dash database.
- **Identity.** The owner key is `tugdash/<name>#<tugid>` (`tugdash_core::ops::dash_owner_key`), opaque, never displayed, never a git ref. It is what makes two incarnations of a reused name distinct. A dash created before ids existed keys under the bare branch ref, which is the legacy key `legacy_owner_key` strips to, and which `tugutil draft` still reads through and supersedes ([P06]).
- **The stages, and derive vs declare.** Seven values from `derive_stage(rounds, worktree_dirty, has_draft, landing, declared)` with precedence `landing > declared > draft-ready > working > created`. `landing` is derived from the presence of a join journal; `implementing` / `built` / `audited` are *declared* by `dash step` and `dash mark`, because git cannot see them. The rule: **anything git can see is derived on every read and never stored; anything it cannot is declared once, in the dash-log, by a verb.** A stage is never written to a config key.
- **Binding.** A bind mates a live session to a dash. It is a UI concept — git has no idea — stored in the per-instance `sessions.db` and read back live-sessions-only, which is exactly why a dash whose cards have all closed reads as *parked*. Parked is not a stage; it is the absence of workers. A bind is per-card, minting, and never a landing authority.
- **Landing — by reference only.** One paragraph saying that a dash lands by `/dash-join <name>` into its base, that skills draft and humans land, and that the doctrine (two beats, the one-slot `LandingMode`, the five outcomes) is held in `tracking-changes.md`'s landing section. Do not restate the outcome table; phase 4 wrote it there and it is law where it stands.
- **Naming.** The verbs are `/dash-bind` and `/dash-join`, spelled the way their `tugutil` verb paths are; `dash` and `join` are retired spellings kept for muscle memory and excluded from the completion popup ([P06]).
- **Cross-references** to `dash-work-doctrine.md` (agent behavior), `tracking-changes.md` (the capture/commit layer beneath, and the landing doctrine), [D112]/[D113]/[D116], and the new [D138].

---

### Specification {#specification}

**Spec S00: `worktree` on the dash changeset entry** {#s00-worktree-field}

Emitted by `dash_entries`; consumed by the shade lane's range descriptor, `plan-review.ts`, and — back over the wire in the range query — `fetch_dash_diff`.

| Field | Type | Presence | Meaning |
|---|---|---|---|
| `worktree` | `string` | always | **Absolute** filesystem path of the dash's worktree, resolved against the main repository root ([P09]). Never composed with `projectDir` by any consumer. |

`plan_path` stays relative **to that worktree**, so the plan's absolute path is `worktree` / `plan_path` and involves no third component.

**Spec S01: `review` on the dash changeset entry** {#s01-review-field}

Emitted by `dash_entries` in `tugcast/src/feeds/changeset.rs`; consumed by the Lens section, the shade lane, and the masthead.

| Field | Type | Presence | Meaning |
|---|---|---|---|
| `review` | `string` | omitted when absent (`skip_serializing_if = "Option::is_none"`) | One of `"reviewed"`, `"stale"`, `"never-reviewed"` — `tugutil_core::plan::ReviewState::as_str` verbatim |

Omitted when: the dash records no `plan_path`; the file cannot be read; the document does not parse as a plan. Consumers treat omission as "nothing to say" and paint nothing.

**Spec S02: the Lens Dashes ordering comparator** {#s02-lens-order}

Applied to the flattened row list inside `dashRowsFromSnapshot`, after projection and before return.

1. `parked` ascending — `false` (worked) before `true`.
2. Stage rank descending, per **Table T01**.
3. `name` ascending, `localeCompare`.

**Table T01: stage rank** {#t01-stage-rank}

| Stage | Rank |
|---|---|
| `landing` | 6 |
| `draft-ready` | 5 |
| `audited` | 4 |
| `built` | 3 |
| `implementing` | 2 |
| `working` | 1 |
| `created` | 0 |
| absent / unrecognized | −1 |

An unrecognized stage sorts last rather than throwing: an older or newer sender must never be able to break the section's render.

**Spec S03: `DashPickerSheet`'s contract** {#s03-picker-contract}

| Input | Type | Notes |
|---|---|---|
| `dashes` | `readonly DashChangesetEntry[]` | This project's dash entries, in the snapshot's order — the picker does **not** apply [P02]'s ordering, which is the Lens's presentation choice |
| `boundDashId` | `string \| null` | Owner key of this card's current dash; marks and seeds the selection |
| `onPick` | `(entry) => void` | Sends `bind_dash`; the sheet calls `close()` immediately after |

The sheet resolves with no result value; the bind's outcome arrives through `bind_dash_ok` / the bind-error store, not through the sheet's promise.

#### State Zone Mapping {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `review` on the dash entry | local-data | Server-computed, arrives on the changeset snapshot; the Lens reads it via `useChangesetAll`, the shade via its `ChangesRouteController` snapshot, the masthead via the new `useDashReviewState` — all three `useSyncExternalStore` reads of an existing store, no new store | [L02] |
| The stale mark's paint | appearance | `data-review` attribute + CSS in the three surfaces' stylesheets; no React state | [L06] |
| Lens row order | local-data (derived) | Pure sort inside `dashRowsFromSnapshot`, memoized by `useMemo` on the snapshot | [L02], [L22] |
| Picker sheet open/closed | structure | `useTugSheet`'s imperative `showSheet` promise on the card's existing host; nothing persisted | — |
| Picker's highlighted row | local-data | `TugListView`'s own selection; the consumer never mirrors it into React state | [L19] |
| Card's dash binding after Adopt / Leave | local-data | `cardSessionBindingStore`, moved **only** by the `bind_dash_ok` / `unbind_dash_ok` broadcasts | [L02], [L28] |
| A dash's worktree path | local-data | Resolved on the server where the main root is known and carried absolute on the changeset snapshot; the deck stores nothing and composes nothing ([P09]) | [L02], [L29] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/cards/dash-picker-sheet.tsx` | The `/dash` picker's sheet content ([P01], Spec S03) |
| `tugdeck/src/components/tugways/cards/dash-picker-sheet.css` | Its row styling |
| `tuglaws/dash-lifecycle.md` | The dash state / identity / binding doctrine ([P08]) |
| `tests/app-test/at0420-dash-picker.test.ts` | The picker's app-test. **`at0416` is taken** (`at0416-viewer-card-settings.test.ts`), as are `at0417`–`at0419`; `at0420` is the next free number |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `DashDetail.worktree_abs` | struct field | `tugrust/crates/tugdash-core/src/ops.rs` | Absolute worktree path; `worktree_rel` stays for the CLI's JSON ([P09]) |
| `build_dash_diff_snapshot` / `fetch_dash_diff` | fn signatures | `tugrust/crates/tugcast/src/feeds/git.rs` | Take an absolute worktree instead of root + relative tail ([P09]) |
| `dash_review_state` | fn | `tugrust/crates/tugcast/src/feeds/changeset.rs` | Takes the absolute worktree; reads + parses the dash's plan; every failure is `None` ([P03], [P09]) |
| `DashLaneBinding` | interface | `.../session-changes/session-changes-dash-lane.tsx` | The adopt/leave bundle, threaded to **every** row ([P05]) |
| `ChangesetEntry::Dash { review }` | enum variant field | `tugrust/crates/tugcast/src/feeds/changeset.rs` | `Option<String>`, skip-if-none (Spec S01) |
| `DashChangesetEntry.review` | interface field | `tugdeck/src/lib/changeset-types.ts` | `review?: string` |
| `DashChangesetEntry.worktree` | interface field | `tugdeck/src/lib/changeset-types.ts` | Meaning changes to absolute; doc comment rewritten (Spec S00) |
| `DASH_STAGE_RANK` | const | `tugdeck/src/components/lens/sections/dashes-section.tsx` | Exported for its table test (Table T01) |
| `compareDashRows` | fn | `tugdeck/src/components/lens/sections/dashes-section.tsx` | Exported comparator (Spec S02) |
| `DashRow.review` | interface field | `tugdeck/src/components/lens/sections/dashes-section.tsx` | Carried through the projection |
| `DashPickerSheet` | component | `tugdeck/src/components/tugways/cards/dash-picker-sheet.tsx` | Spec S03 |
| `dashReviewForProject` / `useDashReviewState` | fn / hook | `tugdeck/src/lib/changeset-all-store.ts` | Beside `branchForProject` / `useSessionBranch`, same shape ([#mark-surfaces](#mark-surfaces)) |
| `SessionChangesDashLaneProps.binding` | prop | `.../session-changes/session-changes-dash-lane.tsx` | The `DashLaneBinding` bundle ([P05]) |
| `SessionMastheadProps` review input | prop / store read | `tugdeck/src/components/tugways/session-masthead.tsx` | Bound dash's review state, matched by owner key ([#mark-surfaces](#mark-surfaces)) |
| the bound-dash plan resolution | fn | `tugdeck/src/lib/plan-review.ts` | Stops joining `projectDir` onto the worktree ([P09], [#worktree-path-sites](#worktree-path-sites)) |

#### Files deleted {#deleted-files}

| Path | Reason |
|------|--------|
| `tugplug/skills/audit/` | Redirect stub → `dash-audit` ([P06]) |
| `tugplug/skills/dash/` | Redirect stub → `dash-on` |
| `tugplug/skills/dash-run/` | Redirect stub → `dash-on` |
| `tugplug/skills/devise/` | Redirect stub → `plan-devise` |
| `tugplug/skills/implement/` | Redirect stub → `dash-implement` |
| `tugplug/skills/join/` | Redirect stub → `dash-join` |
| `tugplug/skills/review-plan/` | Redirect stub → `plan-review` |
| `tugplug/skills/vet/` | Retired → `plan-review` |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/dash-lifecycle.md` — new ([P08], [#lifecycle-contents](#lifecycle-contents))
- [ ] `tuglaws/INDEX.md` — register it under "Working on a dash"
- [ ] `tuglaws/design-decisions.md` — add [D138]
- [ ] `tuglaws/tracking-changes.md` — correct the two-beat `/commit` sentence
- [ ] `tugplug/CLAUDE.md` — delete the stub paragraph
- [ ] `tugplug/.claude-plugin/plugin.json` — `description` and `keywords` name only shipped skills

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Rust, asked from a linked worktree** | The only shape that can falsify a root-composition bug — a `TempDir` repo, a real `git worktree add`, the call made with the worktree as its root, asserting the same answer the main root gives | Steps 1, 2 |
| **Rust unit** | `dash_review_state` over real files in a `TempDir` — a stamped plan, an edited-after-stamp plan, an unstamped plan, a missing file, a non-plan file | Step 2 |
| **bun table** | `compareDashRows` / `DASH_STAGE_RANK` over constructed row arrays | Step 4 |
| **app-test** | Real dashes via `tests/app-test/dash-fixture.ts`, real plans on disk, real clicks | Steps 3, 5, 6 |
| **grep checkpoint** | The deletions and the doc corrections are absence claims; grep is the falsifier | Steps 7, 8 |

#### What stays out of tests {#test-non-goals}

- **The mark's exact glyph or color** — appearance is CSS per [L06]; the tests assert the `data-review` attribute, which is the contract.
- **The sheet's animation** — motion is `TugAnimator`'s and background app-test windows run no rAF; a gesture's outcome is never hung off its animation.
- **A jsdom render of the picker** — banned shape. The picker is proved by an app-test driving the real list with real keys, and its ordering logic is not in the picker at all.
- **`tugutil_core::plan::review_state` itself** — already covered by phase 2.1's tests; [#step-2](#step-2) tests the *joining*, not the primitive.
- **The worktree-root fix, at the app-test layer.** An app-test instance registers the base checkout, so its project root and its main root are the same directory and every composition in [#worktree-path-sites](#worktree-path-sites) works whether or not [#step-1](#step-1) happened. Asking an app-test to prove this would produce a test that passes for the wrong reason and would have passed before the fix — which is how the defect reached four consumers. The falsifiers are Rust and ask from a worktree.
- **That the bind/unbind acks, rather than the handlers, move the binding store** — stated plainly because it is a real discipline with no honest test behind it. `bind_dash` **mints**, so a bind sent from a snapshot row cannot be refused, and there is no cheap way to drive a connection-down state from an app-test. An optimistic write would therefore pass every assertion in [#step-6](#step-6). The discipline is held by [P05]'s implication, the comment already in `action-dispatch.ts`, and code review — not by a test, and this plan does not pretend otherwise.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The dash worktree path travels absolute | done | `03d449a38` |
| #step-2 | Review state on the dash changeset entry | done | `cb1eeb84b` |
| #step-3 | The stale-review mark in three surfaces | done | `aefff01d0` |
| #step-4 | The Lens Dashes ordering | done | `c0f5aee4d` |
| #step-5 | The `/dash-bind` picker sheet | done | `06ed095c4` |
| #step-6 | Adopt and Leave in the dash lane | done | `4ed428f7a` |
| #step-7 | The lifecycle doctrine | done | `e2a24f779` |
| #step-8 | Delete the one-release stubs | done | `41fea8c38` |
| #step-9 | Integration checkpoint | done | `41fea8c38` |

#### Step 1: The dash worktree path travels absolute {#step-1}

**Commit:** `tugdash(polish-lane): a dash's worktree path is resolved where the repo root is known`

**References:** [P09] absolute worktree, Spec S00, (#worktree-path-sites)

**Artifacts:**
- `worktree_abs` on `DashDetail`
- The four consumers in [#worktree-path-sites](#worktree-path-sites)

**Tasks:**
- [ ] Add `worktree_abs: String` to `DashDetail` in `tugrust/crates/tugdash-core/src/ops.rs`, populated from the `worktree_abs` the loop already computes before stripping it. Document both fields against the root each is relative to — that asymmetry is the whole defect and it should be readable at the struct.
- [ ] In `tugcast/src/feeds/changeset.rs`'s `dash_entries`, send `worktree: detail.worktree_abs`.
- [ ] In `tugcast/src/feeds/git.rs`, change `build_dash_diff_snapshot` and `fetch_dash_diff` to take the absolute worktree. `repo_dir` stays for `is_within_git_worktree` and the committed-rounds fallback; it is no longer joined with anything. Update the doc comments, which currently state the composition.
- [ ] In `tugdeck/src/lib/plan-review.ts`, join the plan path onto the dash's worktree directly and stop bringing `projectDir` into it. Check whether `projectDir` remains needed for anything else in that function before deleting it from the input.
- [ ] Rewrite the `worktree` and `plan_path` doc comments in `tugdeck/src/lib/changeset-types.ts` per Spec S00. The current text states the wrong composition as the contract, so it is replaced, not softened.
- [ ] Regenerate both golden fixtures — `changeset-snapshot.golden.json` and `workspaces-changeset-snapshot.golden.json` both carry one dash entry, and its `worktree` value moves in this step. This is the one step where a golden moving is the expected outcome rather than the warning sign.

**Tests:**
- [ ] Rust, in `tugdash-core/src/ops.rs`'s test module: `dash_detail_asked_from_a_linked_worktree_reports_an_absolute_worktree` — build a repo, create a dash, `git worktree add` a second checkout, call `dash_detail_entries_in` with the *worktree* as its root, and assert `worktree_abs` is a directory that exists and equals the answer the main root gives. This is the shape of `preflight_asked_from_a_linked_worktree_answers_about_the_main_root`, which phase 4 added for the same class of bug.
- [ ] Rust, in `tugcast/src/feeds/git.rs`'s test module: extend the existing dash-diff fixture (`init_dash_fixture_repo`) so the snapshot is fetched with an absolute worktree, and add a case asking from a linked worktree that asserts the dirt still appears — today's silent degradation is to committed rounds only, so the assertion that falsifies it is a *dirty* file in the file list.
- [ ] `cd tugdeck && bun test` covers the changed goldens; no new bun test is owed for a doc-comment change.

**Checkpoint:**
- [ ] `cd tugrust && cargo build && cargo nextest run -p tugdash-core -p tugcast`
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just build-app && just app-test at0405-changes-dash-lane.test.ts at0412-plan-review-verb.test.ts` — the two surfaces whose paths moved

---

#### Step 2: Review state on the dash changeset entry {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(polish-lane): the dash changeset entry carries its plan's review state`

**References:** [P03] review on the wire, [P04] no cache, [P09] absolute worktree, Spec S01, (#review-resolution)

**Artifacts:**
- `dash_review_state` in `tugrust/crates/tugcast/src/feeds/changeset.rs`
- `review` on `ChangesetEntry::Dash` and on `DashChangesetEntry`

**Tasks:**
- [ ] Add `review: Option<String>` to the `ChangesetEntry::Dash` variant with `#[serde(skip_serializing_if = "Option::is_none")]`, placed beside `plan_path` so the two related fields read together.
- [ ] Write `dash_review_state(worktree_abs, plan_path) -> Option<String>` per [#review-resolution](#review-resolution). It takes the **absolute** worktree from the detail ([P09]) and joins nothing else; composing from `dash_entries`' `repo_root` is the bug step 1 exists to remove. Every failure path returns `None` — no logging louder than `tracing::debug!`, because an unreadable plan is a normal state, not an incident.
- [ ] Call it **inside** `dash_entries`' existing `spawn_blocking` closure, alongside `dash_detail_entries_in`. Returning `(DashDetail, Option<String>)` pairs from the closure is the shape that keeps all blocking work in one hop; do not add a second `spawn_blocking`.
- [ ] Add `review?: string` to `DashChangesetEntry` in `tugdeck/src/lib/changeset-types.ts`, documented as one of the three `plan status` spellings and as omitted-when-nothing-to-say.
- [ ] **Both golden fixtures carry exactly one dash entry** — `tugdeck/src/__tests__/fixtures/changeset-snapshot.golden.json` and `workspaces-changeset-snapshot.golden.json`. Neither dash records a `plan_path`, so under Spec S01 both should serialize with `review` **absent** and the goldens should not move at all. If either does move, that is the signal that the skip-if-none is wrong — fix the emission, not the fixture.

**Tests:**
- [ ] Rust, in `changeset.rs`'s test module, against a `TempDir` holding real files: `dash_review_state_reads_reviewed_for_a_stamped_plan` — write a plan with a Review Record round, stamp it via `tugutil_core::plan::set_review_stamp`, assert `Some("reviewed")`.
- [ ] Rust: `dash_review_state_reads_stale_after_the_document_moves` — append a line after stamping, assert `Some("stale")`.
- [ ] Rust: `dash_review_state_reads_never_reviewed_without_a_stamp`.
- [ ] Rust: `dash_review_state_is_absent_for_a_missing_file` and `…_for_a_document_that_is_not_a_plan` — both `None`.
- [ ] Rust: `dash_entries_read_review_state_from_a_linked_worktree` — compose the entries with a linked worktree as the root and assert the `review` field is still `Some`. Without step 1 this case returns `None`, which is why it is the one test that proves the two steps are wired together rather than merely both present.

**Checkpoint:**
- [ ] `cd tugrust && cargo build`
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit`

---

#### Step 3: The stale-review mark in three surfaces {#step-3}

**Depends on:** #step-2

**Commit:** `tugdash(polish-lane): a dash whose plan drifted past its review says so`

**References:** [P03] review on the wire, [P07] advisory only, Spec S01, Risk R01, (#mark-surfaces)

**Artifacts:**
- The mark in `dashes-section.tsx`, `session-changes-dash-lane.tsx`, `session-masthead.tsx`, and their stylesheets
- `at0407-lens-dashes-section.test.ts` and `at0406-masthead-dash-chip.test.ts` extended

**Tasks:**
- [ ] Carry `review` through `DashRow` in `dashes-section.tsx`'s `rowFromEntry`, and render the mark as a new fact in the `lens-dashes-facts` span with `data-slot="lens-dashes-review"` and `data-review={...}`. Wrap it in `TugTooltip`; the tooltip names the state in plain words and does **not** name a path (the Lens row is one line and spans projects, so a path there is noise).
- [ ] Render the same mark in `session-changes-dash-lane.tsx`'s facts span, behind the existing `·` separator convention, `data-slot="session-changes-dash-review"`. Here the tooltip **does** name the plan path — the shade is this project's room and the path is the actionable half (Risk R01).
- [ ] Add `dashReviewForProject` + `useDashReviewState` to `tugdeck/src/lib/changeset-all-store.ts`, written beside `branchForProject` / `useSessionBranch` and memoized to the string the same way ([#mark-surfaces](#mark-surfaces)). Match the dash on `owner_id`, **never** on name.
- [ ] In `session-masthead.tsx`, call it with the `projectDir` the file already computes for `useSessionBranch` and the owner key from `cardSessionBindingStore.getBinding(cardId)?.dash?.id`, and put the result on the existing `session-masthead-dash-chip` badge as `data-review`. Paint via CSS; add no element inside the chip. Do **not** thread a `ChangesRouteController` into `SessionMastheadProps` — the masthead is pane-supplied chrome and its props are `{ sessionId, cardId?, accessoryHost? }` on purpose.
- [ ] Only `stale` and `never-reviewed` paint. Give them visibly different tooltip text; if they share a glyph, they must not share a tone.
- [ ] Add the CSS in each surface's own stylesheet, with knob defaults expressed as `var(--x, default)` at the point of use rather than declared on the component's element.

**Tests:**
- [ ] app-test, extending `at0407-lens-dashes-section.test.ts`: create a real dash with `dash-fixture.ts`, write a plan into its worktree, record it with `tugutil dash step <name> start 1 --plan <rel>`, stamp it with `tugutil plan stamp`, and assert `[data-slot="lens-dashes-review"]` is **absent**. Then append a line to the plan, wait for the next recompose, and assert it is present with `data-review="stale"`. Release the dash in `afterAll`.
- [ ] **The fixture plan must be a real plan, not a stub** — `dash step start` (`step_in` in `tugdash-core/src/ops.rs`) is the only writer of `branch.tugdash/<name>.tugplan`, and it refuses unless the document parses *and* carries a Step Status Ledger row whose anchor is `#step-1`. Give the fixture a minimal but genuine plan: the required sections, one `#### Step 1: … {#step-1}` with its `**Commit:**` / `**References:**` / Tasks / Tests / Checkpoint fields, a matching ledger row, and a Review Record round for `plan stamp` to write into. Two consequences to bake into the fixture, both non-obvious: `dash step start` **mutates the plan** (it flips the ledger row to `in progress`), so it must run *before* the stamp; and ledger status cells are outside the hashed content, so that mutation does not itself make the plan stale — which is precisely why the test's "not stale yet" assertion is meaningful.
- [ ] app-test, extending `at0406-masthead-dash-chip.test.ts`: bind the card to that dash and assert the chip's `data-review` follows the same transition.
- [ ] Add the new `@covers` lines (`tugdeck/src/lib/changeset-types.ts`, `tugdeck/src/lib/changeset-all-store.ts`, `tugdeck/src/components/tugways/session-masthead.tsx`) to both files' docblocks.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just build-app`
- [ ] `just app-test at0407-lens-dashes-section.test.ts at0406-masthead-dash-chip.test.ts`
- [ ] `just app-test-covers-check`

---

#### Step 4: The Lens Dashes ordering {#step-4}

**Depends on:** #step-3

<!-- A file-contention dependency, not a logical one: this step and #step-3 both
     rewrite `dashRowsFromSnapshot` and `DashRow` in `dashes-section.tsx`, and
     #step-3 falsifies the docblock sentence this step rewrites. Nothing in the
     ordering needs the review field. -->

**Commit:** `tugdash(polish-lane): the Lens orders dashes by who is on them and how far along`

**References:** [P02] Lens ordering, Spec S02, Table T01

**Artifacts:**
- `DASH_STAGE_RANK` and `compareDashRows` in `dashes-section.tsx`
- `dashes-section.test.ts` extended

**Tasks:**
- [ ] Add `DASH_STAGE_RANK` as an exported `Record<string, number>` per Table T01, and `compareDashRows(a, b)` implementing Spec S02's three keys. An absent or unrecognized stage ranks −1 — never throw, never `undefined` into a subtraction.
- [ ] Apply the sort at the end of `dashRowsFromSnapshot`, on a copy (`[...rows].sort(...)`); the projection's input is the snapshot and must not be mutated.
- [ ] Leave the project-label logic alone — it is a disambiguation rule about *rendering*, not an ordering key, and dropping project grouping from the order does not change when the label appears.
- [ ] Update the section's docblock: it currently states rows come in "project-enumeration order then entry order", which this step falsifies.

**Tests:**
- [ ] bun, in `tugdeck/src/components/lens/sections/__tests__/dashes-section.test.ts`: a table test over `compareDashRows` covering worked-before-parked (dominant over stage — a parked `landing` sorts below a worked `created`), stage rank within a group, the name tiebreak, and an unrecognized stage sorting last.
- [ ] bun: `dashRowsFromSnapshot` over a two-project snapshot asserts the returned order and that the project label still appears on every row.
- [ ] app-test, extending `at0407-lens-dashes-section.test.ts`: with two real dashes at different stages, assert the DOM order of `[data-slot="lens-dashes-row"]` by their `data-dash` attributes.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0407-lens-dashes-section.test.ts`

---

#### Step 5: The `/dash-bind` picker sheet {#step-5}

**Commit:** `tugdash(polish-lane): bare /dash-bind picks a dash instead of showing the room`

**References:** [P01] picker sheet, Spec S03, (#picker-shape)

**Artifacts:**
- `dash-picker-sheet.tsx` / `.css`
- The rewritten bare-form branch of `session-card.tsx`'s `"dash-bind"` verb
- `at0420-dash-picker.test.ts`

**Tasks:**
- [ ] Write `DashPickerSheet` per Spec S03 and [#picker-shape](#picker-shape). Compose `TugListView` + `TugListRow` ([L19]); hand-rolling list focus is a law violation and `TugListView` already owns arrow motion and `commitOnEnter`.
- [ ] The card's own dash is marked and is the seeded selection. Match on owner key against `cardSessionBindingStore.getBinding(cardId)?.dash?.id`.
- [ ] Rewrite the bare-form branch of the `"dash-bind"` verb: move the `!snap.composed` guard **above** the branch (see [#picker-shape](#picker-shape) for why), then zero → caution, one → bind directly, many → `showSheet`.
- [ ] Correct the zero-dash caution string, which reads "No dashes in this project — /dash \<name\> starts one" and names a retired spelling. It should name `/dash-bind`.
- [ ] Bare `/dash-bind` no longer calls `shadeViewController.show("changes")`. Delete that call and the `[Q02]` comment above it that justified it — the question it deferred is now answered.
- [ ] Update the handler's comment block: it documents "discovery lands where this card's own dash facts live", which this step replaces.
- [ ] Touch neither `runRetiredVerb`'s `dash` entry nor its `join` entry ([P06]). Bare `/dash` reaches the picker through the alias with no branch of its own, which is the point of the alias.

**Tests:**
- [ ] app-test `at0420-dash-picker.test.ts`, `@covers` `session-card.tsx`, `dash-picker-sheet.tsx`, `card-session-binding-store.ts`: create three real dashes with `dash-fixture.ts`; type `/dash-bind` and submit; assert the sheet is up and lists three rows; press Down twice and Return; assert the masthead dash chip now reads the third dash's name (the binding moved through the real `bind_dash` → `bind_dash_ok` round trip, not an optimistic write). Release all three in `afterAll`.
- [ ] Same file: with two of the three released, bare `/dash-bind` binds the survivor and no sheet appears.
- [ ] Same file: escape dismisses the sheet with the binding unchanged.
- [ ] Same file: bare `/dash` — the retired spelling — reaches the same picker, which is what keeps the alias worth its existence ([P06]).

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just build-app`
- [ ] `just app-test at0420-dash-picker.test.ts at0408-dash-gesture.test.ts`
- [ ] `just app-test-covers-check`

---

#### Step 6: Adopt and Leave in the dash lane {#step-6}

**Depends on:** #step-3

<!-- Also a file-contention dependency: #step-3 adds the review fact to the same
     `session-changes-dash-lane.tsx` row this step gives affordances to. Adopt
     and Leave need nothing from the review field. -->

**Commit:** `tugdash(polish-lane): adopt and leave a dash from the Changes shade`

**References:** [P05] affordance home, Risk R02, (#adopt-leave-wire)

**Artifacts:**
- `DashLaneBinding` on `SessionChangesDashLaneProps` and the affordances it drives
- The senders in `session-changes-view.tsx`
- `at0405-changes-dash-lane.test.ts` extended

**Tasks:**
- [ ] Add `binding?: DashLaneBinding` (`{ adopt, leave, disabledReason }`) to `SessionChangesDashLaneProps`, mirroring the bundle shape phase 4 gave `landing` rather than adding loose callbacks beside it. The lane stays presentational — it takes data and callbacks and sends nothing itself.
- [ ] Thread the bundle to **every** `DashRow`, not just the fronted one. Phase 4 passes `landing={null}` to non-fronted rows by design, and Adopt's whole population is exactly those rows — reusing the landing channel would put Adopt where it can never appear.
- [ ] Render **Adopt** on non-fronted rows and **Leave** on the fronted row, in the row's trailing affordance cluster beside the pop-out and fold cue. Compose `TugPushButton` at the cluster's existing size; do not introduce a second control vocabulary in the same row.
- [ ] Wire both in `session-changes-view.tsx` from `cardSessionBindingStore`'s binding, sending the frames in [#adopt-leave-wire](#adopt-leave-wire) via `getConnection()?.sendControlFrame`.
- [ ] **Neither handler touches `cardSessionBindingStore`.** The `bind_dash_ok` / `unbind_dash_ok` broadcasts are the only movers (Risk R02) — this is what makes a refused bind leave the card correctly bound to what it was.
- [ ] Gate both on *a landing in flight* — a turn in progress or a live `landingMode` — disabled with a reason rather than silently bouncing. Do **not** reuse `evaluateJoinLandGate`: it refuses on outcome, blockers, and an empty message, and a dash that is off-base or conflicted is exactly one somebody should be able to adopt ([#adopt-leave-wire](#adopt-leave-wire)).
- [ ] Update the lane's docblock: it states the lane is "read-only by design in this era", which phase 4 already dented and this step finishes.

**Tests:**
- [ ] app-test, extending `at0405-changes-dash-lane.test.ts`: with two real dashes and the card bound to the first, click Adopt on the second's row and assert the masthead chip changes to the second's name **and** that the second row is now the fronted one; then click Leave on that row and assert the chip disappears and no row is fronted.
- [ ] Same file: assert the fronted row offers Leave and no Adopt, and a non-fronted row offers Adopt and no Leave — the complement rule, which a refactor could silently break into two buttons on one row.
- [ ] bun: none. The row's Adopt/Leave choice is a one-line function of `fronted`; a test for it would assert a ternary.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just build-app`
- [ ] `just app-test at0405-changes-dash-lane.test.ts at0406-masthead-dash-chip.test.ts`

---

#### Step 7: The lifecycle doctrine {#step-7}

**Commit:** `tugdash(polish-lane): the dash lifecycle becomes doctrine`

**References:** [P08] doctrine home, (#lifecycle-contents)

**Artifacts:**
- `tuglaws/dash-lifecycle.md`
- `tuglaws/INDEX.md`, `tuglaws/design-decisions.md`, `tuglaws/tracking-changes.md`

**Tasks:**
- [ ] Write `tuglaws/dash-lifecycle.md` to the outline in [#lifecycle-contents](#lifecycle-contents). Ground every claim in a symbol a reader can find — `derive_stage`, `dash_owner_key`, `legacy_owner_key`, `bound_sessions_for` — rather than restating behavior in prose alone.
- [ ] Do **not** hard-wrap the prose.
- [ ] Register it in `tuglaws/INDEX.md` under the existing "Working on a dash" heading, beside `dash-work-doctrine.md`, with a one-line description that draws the distinction between the two (what a dash *is* vs how an agent *behaves* on one).
- [ ] Add **[D138]** to `tuglaws/design-decisions.md` in the file's established `**D138.** **<bold claim>.** <dense paragraph>` form. The claim: *anything git can see is derived on every read and never stored; anything it cannot is declared once, in the dash-log, by a verb* — with the stage precedence and the pointer to the new file. D137 is the current highest number; take the next.
- [ ] Correct `tuglaws/tracking-changes.md`'s workflow-layer paragraph: `/commit` is a **mode**, not a two-beat gesture. It enters via `commitModeController.enter()` (⌃⌘C, `/commit`, or Session ▸ Commit…), turns the prompt entry into the message editor over the changes sheet, and `now` no longer means anything. **Only that clause** — the `/dash-join [name] [message…]` half of the same sentence was rewritten by phase 4's step 11 and describes join mode correctly today.
- [ ] Add the cross-references both ways: `dash-work-doctrine.md` gains a line pointing at the lifecycle doc for what the stages mean.

**Tests:**
- [ ] None — this step ships no code. Its falsifiers are the greps in its checkpoint.

**Checkpoint:**
- [ ] `test -f tuglaws/dash-lifecycle.md`
- [ ] `grep -q "dash-lifecycle.md" tuglaws/INDEX.md`
- [ ] `grep -q "^\*\*D138\." tuglaws/design-decisions.md`
- [ ] `! grep -q "two-beat: no ready draft" tuglaws/tracking-changes.md` — the exact stale clause, which currently reads ``/commit` (two-beat: no ready draft → open the shade and generate; …)`
- [ ] `grep -rn "dash-lifecycle" tuglaws/ tugplug/` shows the cross-references resolve

---

#### Step 8: Delete the one-release stubs {#step-8}

**Commit:** `tugplug(polish-lane): retire the one-release skill aliases`

**References:** [P06] what compat goes, (#deleted-files)

**Artifacts:**
- Eight deleted skill directories
- `tugplug/CLAUDE.md`, `tugplug/.claude-plugin/plugin.json`

**Tasks:**
- [ ] `git rm -r` the eight directories in [#deleted-files](#deleted-files).
- [ ] Delete the stub paragraph in `tugplug/CLAUDE.md` (the one naming the seven old names plus `vet` as one-release redirect stubs). Delete it; do not amend it to say they are gone.
- [ ] Rewrite `tugplug/.claude-plugin/plugin.json`'s `description` and `keywords`, which currently name `devise`, `review-plan`, `implement`, and `dash`, to the shipped roster (`plan-devise`, `plan-review`, `dash-implement`, `dash-on`, `dash-join`, `dash-audit`, `draft`, `history`).
- [ ] Verify nothing outside `dash/` references a deleted name — the grep in the checkpoint is the falsifier, and `dash/` is exempt because those documents are historical records of the phases that created the stubs.
- [ ] Do **not** touch `tugutil/src/draft.rs`, `tugcast/src/server.rs`, `tugdash-core/src/ops.rs`'s `legacy_owner_key`, or any of their tests ([P06]).
- [ ] Do **not** touch the retired verb spellings — `runRetiredVerb`'s `dash` and `join` entries in `session-card.tsx`, or their `deprecatedFor` descriptors in `slash-commands.ts` ([P06]). They share two names with deleted skills and are a different compat population; deleting them would send a typed `/join` to Claude as a prompt.

**Tests:**
- [ ] None — a deletion's test is its grep.

**Checkpoint:**
- [ ] `ls tugplug/skills/` lists exactly `dash-audit`, `dash-implement`, `dash-join`, `dash-on`, `draft`, `history`, `plan-devise`, `plan-review`
- [ ] `grep -rnE "tugplug:(audit|dash|dash-run|devise|implement|join|review-plan|vet)([^a-z-]|$)" --include='*.md' --include='*.ts' --include='*.tsx' --include='*.rs' --include='*.json' . | grep -v '^./dash/'` returns nothing. The trailing `([^a-z-]|$)` is load-bearing: a plain `\b` would match `tugplug:dash` inside `tugplug:dash-audit` and report every surviving skill as a leftover stub. Verified against the current tree — it reports only `dash/` hits, which are excluded because those documents are the historical record of the phases that created the stubs.
- [ ] `cd tugrust && cargo nextest run -p tugutil -p tugcast` (proves the ledger compat is untouched)
- [ ] `just hooks-test`

---

#### Step 9: Integration checkpoint {#step-9}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** [P01] picker sheet, [P02] Lens ordering, [P03] review on the wire, [P05] affordance home, [P06] what compat goes, [P08] doctrine home, [P09] absolute worktree, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk the phase's exit criteria against a running debug instance with three real dashes at different stages, one of them driving a plan that has been edited past its stamp.
- [ ] **Do that walk on the dash's own debug build**, whose project directory *is* a linked worktree. That is the one configuration where [#step-1](#step-1)'s fix is load-bearing and the one no app-test reproduces: if the marks paint and the dash range diff shows worktree dirt there, the trap is closed.
- [ ] Confirm the mark, the ordering, the picker, and Adopt/Leave all read correctly in one session — the four are independent in the code and have not been seen together until now.
- [ ] Confirm the `/` completion popup no longer offers the eight deleted names (it is built from the `session_capabilities` catalog, so this is the proof that the deletion reached the running app rather than only the repo).
- [ ] Write the dash's join draft with `tugutil draft set --owner dash:polish-lane`.

**Tests:**
- [ ] `just app-test at0405-changes-dash-lane.test.ts at0406-masthead-dash-chip.test.ts at0407-lens-dashes-section.test.ts at0408-dash-gesture.test.ts at0412-plan-review-verb.test.ts at0420-dash-picker.test.ts`

**Checkpoint:**
- [ ] `cd tugrust && cargo build && cargo nextest run`
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just build-app && just app-test-covers-check`
- [ ] `just app-test-changed` (or, if it refuses on budget, the named set above plus whatever else it printed)

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A dash lane that is navigable with several dashes in flight, tells you when a dash's plan has drifted past its review, lets a card take a dash on or put it down without typing, works the same from a worktree-hosted instance as from the main checkout, and whose model is written down in `tuglaws/` instead of in plan documents — with the one-release skill stubs gone and the retired verb spellings deliberately kept.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] A dash's worktree path is absolute on the wire and resolves from an instance whose project is a linked worktree (verification: step 1's two Rust worktree-asked tests, and the step 9 walk on the dash's own debug build)
- [ ] A dash whose plan moved after its stamp shows a stale mark in the Lens row, the shade row, and the masthead chip; a dash with no plan shows none (verification: `at0407` + `at0406`)
- [ ] The Lens Dashes section orders worked-before-parked, then by stage, then by name (verification: bun table test + `at0407` DOM order)
- [ ] Bare `/dash-bind` opens a picker with several dashes, binds directly with one, and cautions with none — and bare `/dash` reaches the same picker (verification: `at0420`)
- [ ] Adopt on a non-fronted row and Leave on the fronted row move the card's binding through the real broadcasts (verification: `at0405`)
- [ ] `tuglaws/dash-lifecycle.md` exists, is indexed, [D138] is written, and `tracking-changes.md`'s `/commit` description matches commit mode (verification: step 7 checkpoint greps)
- [ ] `tugplug/skills/` holds eight real skills and no stubs; no non-roadmap file names a deleted skill; the two retired verb spellings still run (verification: step 8 checkpoint greps)
- [ ] `tugutil draft`'s legacy owner-key fallback is untouched and its tests pass (verification: `cargo nextest run -p tugutil -p tugcast`)

**Acceptance tests:**
- [ ] `at0420-dash-picker.test.ts` (new)
- [ ] `at0405`, `at0406`, `at0407` (extended)
- [ ] Rust: the worktree-asked cases in `tugdash-core/src/ops.rs` and `tugcast/src/feeds/git.rs`
- [ ] Rust: the five `dash_review_state_*` cases plus `dash_entries_read_review_state_from_a_linked_worktree` in `tugcast/src/feeds/changeset.rs`
- [ ] bun: the `compareDashRows` table test

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] [Q01] — how long a dash has been parked, if the lane ever holds enough dashes for the distinction to pay for a wire field
- [ ] Clearing a dash's recorded `plan_path` when it outgrows its plan (Risk R01's residual)
- [ ] Dropping the draft ledger's legacy owner key, once the population it serves is provably empty ([P06])

| Checkpoint | Verification |
|------------|--------------|
| The worktree path travels absolute | `cargo nextest run -p tugdash-core -p tugcast`; the worktree-asked cases |
| Review state on the wire | `cargo nextest run -p tugcast`; the five `dash_review_state_*` cases |
| The mark in three surfaces | `just app-test at0407-lens-dashes-section.test.ts at0406-masthead-dash-chip.test.ts` |
| Lens ordering | `cd tugdeck && bun test`; `just app-test at0407-lens-dashes-section.test.ts` |
| The picker | `just app-test at0420-dash-picker.test.ts` |
| Adopt / Leave | `just app-test at0405-changes-dash-lane.test.ts` |
| Doctrine | step 7's greps |
| Stubs gone, ledger compat kept | step 8's greps + `cargo nextest run -p tugutil -p tugcast` |
