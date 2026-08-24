## The plan lane becomes a workflow {#plan-lane-workflow}

**Purpose:** A plan stops being a document somebody remembers to review and becomes an artifact the system knows the review state of: the Review Record carries a content stamp, `tugutil plan status` derives `reviewed`/`stale`/`never reviewed` from it, `/plan-review` is a card verb that always gets the borrowed review model, `dash-implement` gates on staleness, every decision point in the lane raises a dialog instead of guessing, and the skill roster takes its final `[P05]` names. Implements phase 3.1 of [dash-integration-plan.md](dash-integration-plan.md#phase-3-1).

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (runs as a dash) |
| Program plan | [dash-integration-plan.md](dash-integration-plan.md#phase-3-1) |
| Last updated | 2026-08-14 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-14, opus.** Reviewed `plan:30d41afd245faebe`. Lint: 0 errors, 1 warning (PL023, discharged by this section). No content stamp: `tugutil plan stamp` does not exist yet, because this is the plan that builds it — so this document reads `never-reviewed` under its own machinery until Step 2 ships and a later round stamps it. That is the migration case (#rollout) describes, observed on the first document to hit it.

Applied, holes and failure modes: the stale gate had a hole that reproduced the exact failure the phase exists to prevent — `dash-implement` reads the **worktree** copy ([P04]), but its Setup only copies a plan in when the plan was *not* already committed on base, so a plan edited-but-uncommitted on base leaves the worktree holding an older document whose stamp matches itself, and the gate reports `reviewed` while the run implements the wrong bytes. Neither copy can be blindly overwritten (the worktree copy holds ledger progress, the base copy holds the user's edits), so this became [Q02] rather than a silent decision; Step 6 now ships the cheap half (detect and report the divergence) and defers the policy. Also unstated: the review's fixups and stamp land **uncommitted in the dash worktree** and are swept into the next round's commit — recorded in [P04]'s implications, since a reviewer expecting a clean worktree would read the dirt as a bug.

Applied, technical grounding verified against the real code rather than taken from the plan: `tugplug/` is `cp -R`'d into `Tug.app/Contents/Resources/tugplug` by the Xcode copy phase and tugcode resolves the plugin dir relative to its own binary — so a repo edit to a skill does nothing until a rebuild, which would have made every manual check in Steps 5–8 silently exercise the previous skill text and report a false pass; this is now a Constraint and is named in each affected step's Tests. `buildSlashCommandLine` reconstructs a plain command line from a draft carrying a command atom or `@`-mentions, and `RUN_SLASH_COMMAND` dispatches *before* the send-readiness gates — which is what actually makes [P06]'s "no `canSubmit` gate" correct, so the claim now cites the mechanism instead of asserting the outcome. Sequencing: Step 3's `**Depends on:** #step-1` was not a real dependency (feed plumbing over phase 3's `dash_plan_path`, sharing no code with the stamp) and was removed; Step 6 cited a doctrine section Step 7 wrote, so the never-ask list moved into Step 6 and no commit in this phase ships a dangling reference.

Applied, mechanical and citation fixes: the proposed `at0410-plan-review-verb.test.ts` collided with the existing `at0410-text-card-file-drop.test.ts` (0411 is also taken) — renumbered to `at0412` at all eight references. `[D07]` was cited for per-card tugbank persistence in the State Zone Mapping, but D07 is the JSX-composition rule; the governing decision is **[D137]** (a borrowed model is live-only; persistence lives in the hook, never in the borrow), now cited there and in [P06], where it also records that the typed path inherits the no-persistence property for free by ending at the same controller. `ChangesetEntry::Dash` has 14 literal constructions across three files, not "two in that file" — Step 3 now scopes the sweep honestly. Spec S01 gained the ledger-cell indexing trap: `read_ledger_row` and `rewrite_ledger_line` index the same row differently (the latter carries a leading empty segment), which is exactly the kind of off-by-one that would produce a plausible, wrong hash.

Tuglaws cross-check: the frontend work is one registry entry, one handler, and two persistence helpers — no new React state, so [L02] is satisfied by the existing `planReviewRequestStore` / controller subscriptions and [L06] by routing notices to the pane bulletin rather than state; [L27] holds because the phase adds no new subscription (the handler is a latch, not a listener); [L28] is upheld by [P06]'s choice to let the controller's park observe the turn lifecycle instead of the handler reaching into it. The State Zone Mapping is present and now correctly cited. Rust-side, [P03]'s exit-code split follows the shipped `plan lint` convention, and [P01]'s hash reuses `tugchanges_core::content_hash`'s 16-hex-of-SHA-256 shape rather than inventing a second content-identity convention. Confirmed `tugutil-core` is not a wasm crate (those live in `tugdeck/crates/`), so the new `sha2` dependency carries no bundle cost.

Deferred: [Q01] (the stale mark before phase 5) stands as devised. [Q02] (base-vs-worktree divergence policy) is new and is the one item wanting the user's judgment before Step 6 is implemented — the plan ships detection either way, so it does not block starting.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Phase 2.1 built the review machinery and phase 3 built the step verbs, and between them they left a gap that was hit in practice the moment phase 3 landed. A plan is a **living artifact between devise and implement** — the user reads it, edits it, argues with it — and nothing in the system knows whether the review on record covers the bytes now on disk.

Four specific failures follow from that, and each has a named cause in the shipped code:

1. **The obvious gesture is the weak one.** `tugplug/skills/review-plan/SKILL.md` prints `/tugplug:review-plan <path>` as a clickable chip, and `tugplug/skills/devise/SKILL.md` prints the same command as its no-tugcast fallback. Typing it runs the skill as an ordinary turn on whatever model the card is on — the borrow in `tugdeck/src/lib/plan-review-controller.ts` is reachable **only** through the `plan_review_request` broadcast, which only `tugutil plan review-request` sends. The strong path is a CLI verb named after its mechanism; the path a user actually clicks silently skips the model borrow.
2. **Nothing records what was reviewed.** The Review Record section (`tuglaws/devise-skeleton.md`, `{#review-record}`) carries prose rounds and no identity. `tugutil-core::plan`'s `lint` warns when the section is missing (PL023) and says nothing about whether it is current.
3. **A second review can revert the user's edits.** `review-plan` has no re-review semantics at all: it re-reads the plan, applies the rubric, and edits — with nothing telling it that a difference from Round 1's shape may be a decision the user made on purpose, or that a `done` ledger row describes work already in the tree.
4. **The skills stop with prose where they should ask.** `review-plan`'s frontmatter grants `Bash, Read, Edit, Glob, Grep, WebFetch, WebSearch` and no `AskUserQuestion`; it is structurally incapable of raising a judgment call. `dash-implement` has the tool but uses it nowhere, and walks whatever plan it is pointed at with no idea whether that plan's review predates the user's edits.

Program decisions [P08] (review is stamped as-of content; re-review is additive) and [P09] (decision points raise dialogs) rule how this closes. This phase implements both, and lands the [P05] roster rename that the program plan sequences here.

#### Strategy {#strategy}

- **One hash implementation, in the crate that already parses plans.** The stamp, its extraction rule, and the `reviewed`/`stale`/`never reviewed` derivation all live in `tugrust/crates/tugutil-core/src/plan.rs`, beside `parse`, `lint`, and `set_ledger_status`. Every consumer — the review skill, the implement gate, phase 5's Lens mark — reads a verb; none re-derives ([P06] of the program plan applied to the plan lane).
- **The stamp is written by a verb, never typed by a model.** `review-plan` authors the round's prose; `tugutil plan stamp` computes and inserts the hash. A model that types a hash types a wrong hash.
- **What the hash ignores is as designed as what it covers.** Review progress (ledger status cells, checkbox ticks) and formatting churn (blank lines, thematic breaks, trailing whitespace) must not read as content change, or a plan goes stale after its own first step lands.
- **The typed verb and the broadcast share one entrance.** `/plan-review` writes `planReviewRequestStore`, exactly as `action-dispatch.ts` does for the broadcast, so both paths get the borrow, the park, and the release with no second machine.
- **Renames land last**, after the machinery is real — phase 3's precedent, so the rewritten skill text quotes invocations that already work.

#### Success Criteria (Measurable) {#success-criteria}

- `tugutil plan status <path> --json` reports `review: "reviewed"` on a freshly-stamped plan, `"stale"` after one word of body text changes, and `"never-reviewed"` on a plan with no Review Record — verified by `cargo nextest run` unit tests over fixture documents.
- Flipping a Step Status Ledger row from `pending` to `done` (via `tugutil dash step done`) leaves `plan status` reporting `reviewed` — the review-progress invariance, pinned by a unit test.
- Typing `/plan-review` in the Session card runs the review turn on the review model: the app-test observes the AI chip move to the review model and back, with `dev.model/<cardId>` byte-identical before and after.
- Bare `/plan-review` with no resolvable plan prints a caution naming the explicit form, and submits nothing (no transcript row appears).
- `tugutil plan lint` exits 0 on a stamped plan and emits PL025 (warning) on a Review Record round carrying no stamp.
- `tugplug/skills/plan-devise/`, `plan-review/`, and `dash-on/` exist; `devise/`, `review-plan/`, and `dash-run/` are redirect stubs that print a chip and do nothing else.
- Every skill in the lane that hits one of the [P09] forks declares `AskUserQuestion` in `allowed-tools` and names the fork in its prose — verified by reading each frontmatter in the integration step.

#### Scope {#scope}

1. The content-stamp primitive and `tugutil plan status` / `tugutil plan stamp` in `tugutil-core::plan` and the `tugutil plan` namespace.
2. A `plan_path` field carried from `tugdash-core` through the CHANGESET feed to `DashChangesetEntry`, so the deck can resolve a bound dash's plan without a shell round-trip.
3. `/plan-review` as a local card verb, with bare-form resolution and per-card last-reviewed persistence.
4. Re-review semantics in the review skill: edits-are-decisions, done-rows-frozen, orient-on-what-moved, stamp via the verb.
5. The stale gate in `dash-implement`, plus its two other [P09] forks (step refusal, batch boundary).
6. Dialog discipline across `devise`/`dash-audit`/`dash-join`, and the never-ask list in `tuglaws/dash-work-doctrine.md`.
7. The [P05] roster rename: `devise`→`plan-devise`, `review-plan`→`plan-review`, `dash-run`→`dash-on` (with its input-grammar trim), each leaving a redirect stub.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **A stale mark in the Lens or the card chrome.** Program plan phase 5 owns it, reading the same `plan status` output. This phase ships the derivation, not the cosmetic.
- **Deleting any redirect stub.** Every stub — this phase's three, phase 3's four, and `vet` — is deleted together in phase 5, once shipped bundles have turned over.
- **Join mode.** Phase 4's surface is untouched here; `dash-join` gains only its [P09] dialog.
- **Making the program plan reviewable.** `dash/dash-integration-plan.md` declares no `{#execution-steps}`, so `plan::parse` returns `NotAPlan` and every verb in this phase exits 2 on it. That is correct and deliberate — program-plan edits are conversation edits.
- **Sub-agents anywhere.** The lane is agentless; nothing here changes that.

#### Dependencies / Prerequisites {#dependencies}

- **Phase 2.1 (shipped):** `tugutil-core::plan` with `parse`/`lint`/`Diagnostic`, `tugutil plan lint` and `plan review-request`, `POST /api/plan-review` in `tugrust/crates/tugcast/src/server.rs`, `broadcast_plan_review_request` in `tugcast/src/feeds/agent_supervisor.rs`, the `plan_review_request` handler in `tugdeck/src/action-dispatch.ts`, `plan-review-request-store.ts`, and `plan-review-controller.ts` with its borrow/park/release machine.
- **Phase 3 (shipped):** `plan::set_ledger_status`, `tugutil dash step start|done`, `dash_plan_path`/`set_dash_plan_path` over `branch.tugdash/<name>.tugplan` in `tugrust/crates/tugdash-core/src/ops.rs`, the `dash-*` skill roster, and `tuglaws/dash-work-doctrine.md`.
- **The `sha2` workspace dependency** — declared in `tugrust/Cargo.toml` and already used by `tugchanges-core` and `tugcast`. `tugutil-core/Cargo.toml` does not yet depend on it and must.

#### Constraints {#constraints}

- **Warnings are errors.** `tugrust/.cargo/config.toml` enforces `-D warnings`; `cargo build` and `cargo nextest run` fail on any warning.
- **A stamp edit must be provably safe.** `plan::set_ledger_status` established the pattern: compute the edit in memory, re-parse the result, verify the value reads back, and refuse rather than write anything that does not. The stamp writer follows it.
- **The deck cannot touch the filesystem.** Bare-form `/plan-review` resolution must be synchronous over data the card already holds — the `ChangesRouteController` snapshot and the tugbank cache — not a shell round-trip.
- **No Web storage.** Per-card persistence goes through tugbank `/api/defaults/<domain>/<key>`, following `writePersistedModel` in `tugdeck/src/lib/use-model.ts`.
- **`~/.local/bin/tugutil` is a symlink to the main checkout.** Any test that shells the CLI must use an absolute path into the build (`tugutilPath()` in `tests/app-test/dash-fixture.ts`), never a bare `tugutil`.
- **Skills run from the app bundle, not from the repo.** The Xcode "Copy Rust binaries, tugdeck dist, capabilities, and tugplug" build phase does `cp -R` of `tugplug/` into `Tug.app/Contents/Resources/tugplug`, and tugcode resolves the global plugin dir relative to its own binary. **A repo edit under `tugplug/skills/` has no effect on any running instance until the app is rebuilt.** Every manual verification of a skill edit in steps 5–8 must run `just app-debug` from the dash worktree first, or it silently exercises the previous skill text and reports a false pass.
- **App-test selection is derived.** Every new `*.test.ts` carries `@covers` lines; `just app-test-covers-check` fails on a missing or unresolvable declaration.

#### Assumptions {#assumptions}

- The Review Record section is always a level-3 heading carrying `{#review-record}`, as `tuglaws/devise-skeleton.md` specifies and as the shipped phase 2.1 and phase 3 recipes both write it. A plan that spells it differently reads as `never-reviewed`, which is a truthful answer.
- `tugcode` discovers skills by walking `skills/*/SKILL.md` frontmatter (verified during phase 3's rename), so adding `plan-devise`/`plan-review`/`dash-on` directories needs no allowlist edit.
- A card bound to a dash is bound to the dash whose plan it cares about *less often* than it is sitting on a plan it just reviewed — which is why [P05] of this plan inverts the program plan's stated resolution order.
- The review model default (`DEFAULT_PLAN_REVIEW_SELECTOR = "opus"` in `tugdeck/src/lib/model-domains.ts`) stays a tugbank value; nothing here hardcodes a model.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does a `stale` verdict deserve a mark before phase 5? (OPEN) {#q01-stale-mark-timing}

**Question:** The program plan puts the Lens/chrome stale mark in phase 5. Between this phase and that one, a user's only way to learn a plan is stale is to run `plan status` or to be told by `dash-implement`'s setup gate.

**Why it matters:** If the invisible window is long, the gate becomes the only surface, and a user who never implements never learns.

**Options (if known):**
- Ship the derivation now and the mark in phase 5 as planned.
- Pull the Lens mark forward into this phase.

**Plan to resolve:** Live with it for one phase. The gate covers the case that costs something (implementing against a stale review); the rest is cosmetic and belongs with the other Lens polish.

**Resolution:** DEFERRED to phase 5, per the program plan's own sequencing. Revisit if the gate fires often enough to feel like a surprise.

#### [Q02] Which copy wins when base and worktree diverge? (RESOLVED) {#q02-copy-divergence}

**Question:** The stale gate reads the **worktree** copy ([P04]). `dash-implement`'s Setup says a plan committed on the base branch "already rode along" into the worktree at `dash create` time. So if the user edits the plan on base *after* the dash was created and does not commit, the worktree copy is an older document whose stamp still matches **itself** — `plan status` reports `reviewed`, the gate passes, and the run implements a plan that is missing the user's latest edits while the system reports everything is fine.

**Why it matters:** This is the exact failure the phase exists to prevent — a review that does not cover the bytes that matter — reintroduced one level down, and the gate's green verdict makes it *less* visible than before. Neither copy can simply be overwritten: the worktree copy accumulates ledger progress written by `dash step`, and the base copy accumulates the user's edits. Copying either direction destroys real state.

**Options (if known):**
- **Detect and ask.** Compare the two files at Setup; when they differ, raise it as a [P09] fork alongside the stale gate — "Use the worktree copy / Refresh it from the base copy (loses ledger progress) / Stop and reconcile by hand".
- **Merge the ledger.** Refresh the worktree copy's body from base while preserving its ledger rows — correct in principle, real machinery, and a new class of edit for `tugutil-core::plan` to own.
- **Declare the base copy authoritative until the first `dash step`,** and the worktree copy authoritative after — a rule that is cheap but silently picks a side.

**Plan to resolve:** [#step-6](#step-6) ships the **detection** only, because it is nearly free (compare the given path against the worktree copy) and because an undetected divergence is the part that does damage. The policy is the user's call and is not decided here.

**Resolution:** RESOLVED — **detect and ask**, the first option. The user chose it at the close of this phase, which is also the default this question named for itself: it never destroys state without being asked.

`dash-implement`'s Setup compares the two copies before it reports the review verdict and, on a difference, names both paths, characterizes the difference (ledger cells only is routine; anything in the body is not), and raises the three-way fork — use the worktree copy / refresh it from the base copy / stop and reconcile by hand. The refresh option states that it loses the worktree copy's ledger progress, because it does; the progress is re-recorded with `dash step` from the commits already on the branch.

The ledger-preserving merge (the second option) was considered and not taken here: it is a new class of document edit for `tugutil-core::plan` to own and test, which is a plan of its own rather than a paragraph of this one. The third option — base authoritative until the first `dash step`, worktree after — was rejected for the reason this phase exists: it silently picks a side.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| The stamp goes stale on progress, not content | high | med | the canonical extract (Spec S01) elides ledger status/commit cells and checkbox state; pinned by a dedicated unit test | any report of "stale" right after a step lands |
| `plan stamp` corrupts a Review Record | med | low | compute-then-reparse-then-verify, following `set_ledger_status`; refuse on anything that does not read back | a `StampError::RoundTrip` seen in practice |
| The rename breaks the borrow path | med | med | `REVIEW_PLAN_COMMAND` and the `at0409` app-test both name the skill; the rename step greps for `review-plan` across `tugdeck/`, `tests/`, `tugrust/`, and `tugplug/` | a review turn that submits a command claude does not know |
| Dialogs multiply into interrogation | med | med | the never-ask list is written into the doctrine in the same phase that grants the dialogs; the forks are an enumerated set, not a licence | a skill asking anything not on the enumerated list |
| Last-reviewed persistence leaks per-card rows | low | low | the new domain joins `CARD_KEYED_DOMAINS`, so the existing startup orphan sweep prunes it | tugbank size growth |

**Risk R01: A model hand-writes a stamp** {#r01-hand-written-stamp}

- **Risk:** `plan-review` writes a plausible-looking hash into the round line instead of running `tugutil plan stamp`, and every later `plan status` reports `stale` forever.
- **Mitigation:**
  - The skill never sees a hash to copy: `plan stamp` computes and inserts it, and the skill's prose says the stamp is not text it authors.
  - PL025 warns on a round with no stamp, so the omission is visible; a *wrong* stamp is caught the first time `plan status` runs, which the implement gate does at setup.
- **Residual risk:** A wrong stamp reads as `stale`, which raises a dialog rather than doing damage — the failure mode is one extra review, not a lie.

**Risk R02: The worktree copy diverges from the base copy** {#r02-worktree-divergence}

- **Risk:** A card bound to a dash resolves bare `/plan-review` to the dash worktree's plan ([P04]), while the user has been editing the base checkout's copy in an editor. The review reads and stamps bytes the user never saw.
- **Mitigation:**
  - [P05] resolves the card's last-reviewed plan **first**, so the plan the user has been working on wins whenever the card has reviewed one.
  - The review turn's first visible act is naming the absolute path it is reviewing, so a wrong resolution is legible in one line rather than discovered at the end.
- **Residual risk:** A fresh card bound to a dash, with nothing last-reviewed, still resolves to the worktree copy. That is the correct answer for that card — it is the copy the dash is implementing.

---

### Design Decisions {#design-decisions}

#### [P01] The stamp hashes a canonical extract, not the file (DECIDED) {#p01-canonical-extract}

**Decision:** The content stamp is the first 16 hex characters of the SHA-256 of a **canonical extract** of the document (Spec S01) — the file with the Review Record section removed, formatting-only lines dropped, Step Status Ledger rows reduced to anchor + title, and task checkboxes normalized to unticked.

**Rationale:**
- Hashing raw bytes would make the plan stale the instant its own first step landed: `dash step done` rewrites the ledger's status and commit cells by design, and `dash-implement` ticks task boxes. A staleness signal that fires on progress is noise, and noise trains a user to click through the gate.
- The Review Record must be excluded or the stamp could never be written — inserting the round that carries it would invalidate it ([P08] of the program plan says exactly this).
- Dropping blank lines and thematic breaks (`---`) is not cosmetic tolerance: inserting the Review Record section *also* inserts separators around it, so a rule that kept them would make the first stamp unreproducible.
- The 16-hex-of-SHA-256 shape matches `tugchanges_core::content_hash`, so the codebase has one content-identity convention rather than two.

**Implications:**
- `tugutil-core` gains a `sha2` dependency (already a workspace dependency).
- The extract is computed from a `PlanDoc` plus the source, because it needs the parse's ledger row line numbers and the Review Record heading's level.
- A whitespace-only or paragraph-break-only edit does **not** mark a plan stale. That is intended: it is not a change a reviewer would have anything to say about.

#### [P02] The verb writes the stamp; the model writes the prose (DECIDED) {#p02-verb-writes-stamp}

**Decision:** `plan-review` authors the round paragraph with no stamp in it and then runs `tugutil plan stamp <path>`, which computes the hash and inserts `Reviewed \`plan:<hash>\`.` into the newest round that carries none. The stamp is the **last** edit of the review.

**Rationale:**
- A model cannot compute SHA-256, so any hash it types is fabricated — and a fabricated stamp is worse than none, because it reads as `stale` rather than as missing ([Risk R01](#r01-hand-written-stamp)).
- Splitting prose from mechanism keeps the round paragraph free-form, which is the whole point of the Review Record being prose rather than a table.
- "Stamp last" is the only ordering that works: any edit after the stamp invalidates it. This includes bumping `Last updated` in Plan Metadata, which is inside the hashed extract.

**Implications:**
- `plan stamp` refuses (exit 1) when there is no Review Record, no round, or when the newest round is already stamped — a re-run is an error, not a silent rewrite, since two stamps on one round cannot both be true.
- The review skill's flow gains a final step, and its guardrails name the ordering.

#### [P03] `plan status` is a readout, not a gate (DECIDED) {#p03-status-is-a-readout}

**Decision:** `tugutil plan status <path> [--json]` exits **0** whenever the document is a readable plan, whatever it reports; it exits 2 only when the file cannot be read or is not a plan. The `review` field carries the verdict.

**Rationale:**
- Its consumers are a skill's setup gate and (later) a feed projection. Both want the verdict as data. An exit code that encoded staleness would force every caller to distinguish "stale" from "broken", which is the distinction exit 2 already makes.
- `plan lint` keeps its gating exit 1 because a lint error means the document is wrong; a stale review means the document *moved*, which is not an error at all.

**Implications:**
- The JSON envelope always carries `status: "ok"` on a readable plan; the lint counts ride inside `data.lint` rather than reshaping the envelope.
- `dash-implement` reads `data.review` and never the exit code.

#### [P04] A bound dash resolves to its worktree copy (DECIDED) {#p04-worktree-copy}

**Decision:** When bare `/plan-review` resolves through a bound dash, the path is the dash's recorded `plan_path` (worktree-relative) joined onto the dash's worktree — the copy `dash-implement` drives and whose ledger `dash step` edits.

**Rationale:**
- `set_dash_plan_path` records a worktree-relative path precisely because the plan a run edits is the worktree copy — `resolve_plan_rel` in `tugdash-core/src/ops.rs` refuses a plan outside the worktree.
- Reviewing the base copy while the dash implements the worktree copy would put the fixups and the stamp on a document the run does not read, and `dash-implement`'s own stale gate (which runs against the worktree copy) would disagree with the review that just happened.
- The dash-work doctrine's one-and-only-working-root rule already says a run edits the worktree copy and never the base.

**Implications:**
- The absolute path is composed in the deck as `projectDir` + the entry's `worktree` (repo-relative) + the entry's `plan_path` (worktree-relative), which requires carrying `plan_path` on the changeset entry ([#step-3](#step-3)).
- A dash whose worktree was torn down but whose branch config survives resolves to a path that does not exist; the review turn reports that plainly rather than the card pre-validating it, since the card cannot stat.
- **The review's fixups and its stamp land uncommitted in the dash worktree.** Nothing in the review commits them — the next `tugutil dash commit` sweeps them into that round. This is the correct outcome (the plan is one of the dash's own files and rides its rounds), but it must be stated, because a reviewer who expects a clean worktree afterwards will read the dirt as a bug. The review turn says which file it wrote.
- It also means a review run against a bound dash is a **write into a worktree from a session whose cwd is the base checkout**. That is legal — the doctrine's one-and-only-working-root rule forbids the opposite direction, writing to the base from a dash run — but every path the review touches must be absolute, for the same reason the doctrine gives.

#### [P05] Last-reviewed wins over the bound dash (DECIDED) {#p05-resolution-order}

**Decision:** Bare `/plan-review` resolves in three steps: (1) the plan this card last reviewed, persisted per card in tugbank; (2) the bound dash's recorded plan; (3) refuse, printing the explicit form. This inverts the first two steps of the order the program plan sketched.

**Rationale:**
- The gesture exists for a specific moment: a plan was devised, the user edited it, and wants the cleanup review. In that moment the card is usually **not** bound to a dash yet — the dash does not exist until implementation starts.
- When a card *is* bound, it is frequently bound to a dash implementing a different plan than the one being edited. Resolving to the dash first would silently review the wrong document, which is exactly the "wrong-suggesting" failure this phase exists to kill.
- The dash branch is not lost — it is step 2, and it is the only answer for a fresh card bound to a running dash, which is a real case.
- This is a refinement of program decision [P08]'s consumer list, not a contradiction of it: [P08] fixes the mechanism (a verb derives the answer), and leaves the gesture's resolution to this recipe.

**Implications:**
- A new card-keyed tugbank domain, written by the controller at submit time and joining `CARD_KEYED_DOMAINS` in `tugdeck/src/settings-api.ts` so the startup orphan sweep prunes it.
- The controller is the only writer, so the broadcast path and the typed path both record — reviewing via `devise` seeds the card for a later bare `/plan-review`.

#### [P06] The typed verb and the broadcast share one entrance (DECIDED) {#p06-one-entrance}

**Decision:** `/plan-review` writes `planReviewRequestStore.latch(cardId, absolutePath)` — the same store `action-dispatch.ts` writes when the `plan_review_request` frame lands. It does not call the controller directly and does not submit a turn itself.

**Rationale:**
- The controller already owns everything a typed invocation needs: the gate, the mid-turn park, the borrow, the three-beat release, and the notices. A second path would duplicate all of it and drift.
- The park is a feature for the typed verb too: `/plan-review` typed mid-turn waits for the turn to settle instead of being refused, which is better behavior than `/join`'s hard `canSubmit` refusal and costs nothing.
- One entrance means one place to test. The `at0409` app-test's whole point is that the frame path is real; the typed path joins it rather than needing its own machine.

**Implications:**
- The card's `slashCommandSurfaces` handler is a resolver plus a latch — no async, no submission, no gate of its own.
- A `/plan-review` typed while a review is already running is refused by `evaluatePlanReviewGate`'s existing `already-reviewing` branch, with the existing caution.
- **The typed path inherits [D137] for free.** Because it ends at the same controller, the borrow is still live-only and still never writes `dev.model/<cardId>` — the property `use-model-borrow.test.ts` pins with a throwing fake tugbank client, and `at0409` pins end to end. A handler that submitted its own turn would have had to re-earn that, and would have been the obvious place to get it wrong.
- The new last-reviewed write is a **separate** durable value in its own domain, not a widening of the borrow: [D137]'s no-persistence rule is about the model selector, and nothing here routes the borrow through `setModel`.

#### [P07] The stale gate covers "never reviewed" too (DECIDED) {#p07-gate-covers-never-reviewed}

**Decision:** `dash-implement`'s setup gate raises the [P09] dialog on `stale` **and** on `never-reviewed`, with a message naming which; it never hard-refuses in either case.

**Rationale:**
- Implementing a plan nobody reviewed is strictly worse than implementing one whose review predates an edit, so gating the weaker case and not the stronger one would be backwards.
- Hand-written and pre-2.1 plans are exactly the ones most likely to be unreviewed, and they are also the ones the review would help most.
- [P09]'s never-hard-refuse rule is unconditional: the plan is the user's.

**Implications:**
- The dialog is one `AskUserQuestion` with two options — "Review now (Recommended)" and "Proceed as-is" — whose message text differs by verdict.
- Choosing "Review now" hands off with the `/tugplug:plan-review <path>` chip and stops; `dash-implement` does not review inline.

---

### Deep Dives {#deep-dives}

#### How the review state is derived {#review-derivation}

`plan status` answers three questions from one parse:

1. **Are there rounds?** The Review Record section is scanned for round lead-ins. None → `never-reviewed`, and the stamp comparison never runs.
2. **Does the newest round carry a stamp?** A round with no stamp cannot vouch for anything, so the document reads `never-reviewed` when *no* round carries one, and compares against the newest stamp that exists otherwise. (Rounds are appended, so newest is last in source order.)
3. **Does that stamp equal today's extract?** Equal → `reviewed`. Different → `stale`.

The comparison is against the newest stamped round only. An older round's stamp is history — it says what round 2 covered, not what the document is now.

#### What changes when a plan is implemented {#implementation-churn}

This is the churn the extract must survive, observed in the shipped phase 3 recipe as `dash step` drove it:

- **Ledger status cells.** `set_ledger_status` rewrites cell 3 (`pending` → `in progress` → `done`) and cell 4 (the commit sha, backticked), preserving every other byte of the line. The extract keeps cells 1 and 2 and drops 3 and 4, so a row that moves does not move the hash, while a row that is *added*, *removed*, or *retitled* does — which is a real plan change.
- **Task and test checkboxes.** `- [ ]` becomes `- [x]` as a run walks a step. Normalized back to `- [ ]` in the extract.
- **Nothing else.** The verbs touch no other bytes; a diff on a plan mid-run shows exactly the ledger line and any checkboxes the author ticked.

#### Where a plan path comes from, in the deck {#plan-path-in-the-deck}

The card has no filesystem. Bare-form resolution therefore composes an absolute path from three values it already holds, plus one this phase adds:

| Source | Value | Where it lives today |
|---|---|---|
| `CardSessionBinding.projectDir` | absolute project root | `tugdeck/src/lib/card-session-binding-store.ts` |
| `DashChangesetEntry.worktree` | worktree path relative to the repo root | `tugdeck/src/lib/changeset-types.ts` |
| `DashChangesetEntry.plan_path` | plan path relative to the worktree | **added by this phase** |
| `CardDashBinding.name` | which entry to pick | `card-session-binding-store.ts` |

The composition is `projectDir` / `worktree` / `plan_path`. The card matches the entry by `display_name` against the binding's `name`, the same match `/dash` already performs in `session-card.tsx`.

For the explicit form (`/plan-review <path>`), a relative argument is resolved against `projectDir` and an absolute one is passed through — the card does no normalization beyond that, because `tugutil plan …` and the skill both run in the session's cwd anyway.

#### The enumerated dialog forks {#dialog-forks}

Program decision [P09] fixes the complete set. This phase writes each into the skill that owns it:

**List L01: The forks and their homes** {#l01-forks}

| Fork | Skill | Question | Options |
|---|---|---|---|
| Unsettleable open question | `plan-devise` | the design question the author cannot settle | the candidate answers |
| Judgment call in review | `plan-review` | scope / product trade-off with no technically correct answer | the candidate answers; only a deferral becomes `[Q##]` |
| Stale plan at setup | `dash-implement` | the plan changed since its last review | Review now (Recommended) / Proceed as-is |
| `dash step` refusal | `dash-implement` | the ledger edit was refused | Fix the plan and retry / Hand-edit the ledger this run |
| Batch boundary | `dash-implement` | a long run reached its midpoint | Continue / Stop here and report |
| Audit disposition | `dash-audit` | fixups were found | Carry them now as rounds on this dash / Leave the list with you |
| Empty dash at join | `dash-join` | nothing to join | Release it / Leave it |

**List L02: The never-ask list** {#l02-never-ask}

Written into `tuglaws/dash-work-doctrine.md` in the same phase that grants the dialogs, so the boundary ships with the licence:

- Never ask to commit a round.
- Never ask before running a checkpoint.
- Never ask permission to write the join draft.
- Never ask "should I continue?" between ordinary steps.
- Never ask anything with a conventional default.

Join's other stops — conflicts, a missing draft, a named blocker — stay stops. They are correct refusals with one right answer, not unasked questions.

---

### Specification {#specification}

**Spec S01: The canonical content extract** {#s01-canonical-extract}

Given a plan's source text and its `PlanDoc` parse, the extract is built line by line:

1. **Elide the Review Record.** If a heading declares `{#review-record}`, skip from that heading's line through the line before the next heading whose level is less than or equal to it (or to end of file).
2. **Trim** trailing whitespace from every surviving line.
3. **Drop** lines that are empty after trimming.
4. **Drop** thematic breaks — a line whose trimmed content is three or more characters, all of them `-`. (A markdown table separator such as `|---|---|` contains `|` and is therefore kept.)
5. **Reduce ledger rows.** For each line whose number appears in `PlanDoc::ledger_rows`, emit only the anchor and title cells: `| #step-1 | Title |`.

   **Mind the indexing trap.** The two existing functions that read the same row index it differently: `read_ledger_row` splits after trimming the leading and trailing `|`, so its cells are `0`=anchor, `1`=title, `2`=status, `3`=commit — while `rewrite_ledger_line` splits the raw body and carries a leading empty segment, so *its* cells are `1`=anchor, `2`=title, `3`=status, `4`=commit. The extract keeps anchor and title in whichever convention it splits with; write it against `read_ledger_row`'s and say so at the definition.

   The ledger's header row and its `|---|---|` separator are **not** in `ledger_rows` — `read_ledger_row` requires the first cell to start with `#`, which neither does — so both survive verbatim. That is fine and stable: neither changes as a run walks.
6. **Normalize checkboxes.** Rewrite a leading `- [x]` or `- [X]` (after indentation) to `- [ ]`.
7. **Join** the surviving lines with `\n` and hash: `Sha256::digest`, first 8 bytes, lowercase hex — 16 characters.

The extract is never written to disk and never shown to the user. It exists only to be hashed.

**Spec S02: The Review Record round grammar** {#s02-round-grammar}

A round is introduced by a bold lead-in inside the Review Record section:

```
**Round <n> — <YYYY-MM-DD>, <model>.** Reviewed `plan:<hash>`. Lint: <N> errors, <N> warnings (<N> fixed).
Oriented on: <the git diff since round <n-1> | the Review Record>.
Applied: <what changed, and why>.
Deferred: <what was raised as an Open Question instead of decided>.
```

Parsed fields: the round number, the date, the model, and — anywhere in that round's paragraph — a stamp token spelled `` `plan:<hex>` ``. Everything else is prose the parser does not read. A round paragraph ends at the next round lead-in, the next heading, or the end of the section.

`Oriented on:` is prose, not parsed. It is required of the skill by [#step-5](#step-5) so a reader can tell whether a re-review compared against a diff or against the record.

**Spec S03: `tugutil plan status` output** {#s03-status-output}

```json
{
  "schema_version": 1,
  "command": "plan status",
  "status": "ok",
  "data": {
    "path": "dash/some-plan.md",
    "review": "reviewed",
    "content_hash": "9f2a4c1b7e0d3856",
    "rounds": 2,
    "last_round": { "number": 2, "date": "2026-08-14", "model": "opus", "stamp": "9f2a4c1b7e0d3856" },
    "lint": { "errors": 0, "warnings": 1 },
    "steps": { "total": 9, "done": 3, "in_progress": 1, "pending": 5 }
  },
  "issues": []
}
```

- `review` is one of `"reviewed"`, `"stale"`, `"never-reviewed"`.
- `last_round` is `null` when there are no rounds; its `stamp` is `null` when the newest round carries none.
- `content_hash` is always the freshly computed extract hash — the value a stamp would have to equal.
- The plain (non-JSON) form prints one line per field, ending with the verdict.
- Exit 0 on any readable plan ([P03]); exit 2 on an unreadable file or a `NotAPlan` parse.

**Spec S04: `tugutil plan stamp` semantics** {#s04-stamp-semantics}

`tugutil plan stamp <path> [--json]`:

1. Read and parse. Not a plan or unreadable → exit 2.
2. Locate the newest round in the Review Record. None → exit 1, "no review round to stamp".
3. Already stamped → exit 1, "the newest round is already stamped" — never a silent rewrite ([P02]).
4. Compute the extract hash, insert `Reviewed \`plan:<hash>\`.` immediately after the round's bold lead-in, preserving the rest of the line.
5. **Re-parse the result** and confirm the round now reads back with exactly that stamp and that the document still parses as a plan. Anything else → refuse, write nothing, exit 1.
6. Write the file. Print the stamp (or the JSON envelope).

**Spec S05: New lint rule** {#s05-lint-rule}

- **PL025 (warning)** — a Review Record round line carrying no content stamp: *"round N records no content stamp — run `tugutil plan stamp`"*. Anchored to the round's line.

PL023 (no Review Record at all) is unchanged and stays a warning.

#### State Zone Mapping {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| The card's last-reviewed plan path | local-data, durable | tugbank `dev.plan-review-last/<cardId>` via PUT + `setLocalValue`, written by `PlanReviewController` at submit; read synchronously through `getTugbankClient().get(…)` | [D137] (persistence lives beside the borrow, never inside it); no Web storage |
| The pending review request (typed or broadcast) | structure | `planReviewRequestStore` — an external store the controller subscribes to | [L02] |
| The review phase (`idle`/`parked`/`armed`/`running`) | structure | `PlanReviewController`'s existing snapshot + `subscribe`; unchanged by this phase | [L02], [L27] |
| The review notice (announce / caution) | appearance | pane bulletin via `setNotifier`, never React state | [L06] |
| `DashChangesetEntry.plan_path` | structure, server-owned | CHANGESET feed projection into `ChangesRouteController`'s snapshot; read at click time | [L02], [L07] |

No new React state and no new component are introduced. The card's `slashCommandSurfaces` entry is a handler, not state.

---

### Compatibility / Migration / Rollout {#rollout}

- **Wire compatibility:** `plan_path` is an `Option<String>` with `#[serde(default, skip_serializing_if = "Option::is_none")]`, matching how `stage`, `step_current`, and `branch` were added additively to `ChangesetEntry::Dash`. An older deck ignores it; a newer deck against an older sender sees `undefined` and falls back to step 3 of the resolution order.
- **Existing plans:** every plan written before this phase reads `never-reviewed` — including ones with a Review Record, because no round carries a stamp. That is honest, and PL025 tells the reader how to fix it. Re-stamping an old plan is one `plan-review` round.
- **Skill aliases:** `devise`, `review-plan`, and `dash-run` become redirect stubs on the `vet` precedent — frontmatter intact, print the replacement command as its own backticked chip with the user's arguments substituted, do nothing else. Deleted in phase 5 with every other stub.
- **Rollback:** each step is a standalone commit; the deck verb (step 4) and the skill rewrites (steps 5–8) are independently revertible, and the Rust primitive is additive.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugplug/skills/plan-devise/SKILL.md` | renamed `devise`, plus its [P09] fork |
| `tugplug/skills/plan-review/SKILL.md` | renamed `review-plan`, plus re-review semantics and its fork |
| `tugplug/skills/dash-on/SKILL.md` | renamed `dash-run`, with the trimmed input grammar |
| `tests/app-test/at0412-plan-review-verb.test.ts` | the typed `/plan-review` gesture end to end (0410 and 0411 are taken; 0412 is the next free id) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ReviewRound` | struct | `tugrust/crates/tugutil-core/src/plan.rs` | number, date, model, `stamp: Option<String>`, line |
| `PlanDoc::review_rounds` | field | `tugutil-core/src/plan.rs` | populated by `parse` |
| `PlanDoc::review_record_span` | field | `tugutil-core/src/plan.rs` | inclusive line range of the elided section |
| `content_stamp` | fn | `tugutil-core/src/plan.rs` | Spec S01; `(&PlanDoc, &str) -> String` |
| `ReviewState` | enum | `tugutil-core/src/plan.rs` | `Reviewed` / `Stale` / `NeverReviewed` |
| `review_state` | fn | `tugutil-core/src/plan.rs` | Spec S03's verdict |
| `set_review_stamp` | fn | `tugutil-core/src/plan.rs` | Spec S04 steps 2–5; returns the edited source |
| `StampError` | enum | `tugutil-core/src/plan.rs` | `NotAPlan` / `NoRecord` / `NoRound` / `AlreadyStamped` / `RoundTrip` |
| `PlanCommands::Status` | variant | `tugrust/crates/tugutil/src/cli.rs` | `{ path: String }` |
| `PlanCommands::Stamp` | variant | `tugrust/crates/tugutil/src/cli.rs` | `{ path: String }` |
| `run_status` / `run_stamp` | fn | `tugrust/crates/tugutil/src/plan.rs` | dispatch arms |
| `DashDetail::plan_path` | field | `tugrust/crates/tugdash-core/src/ops.rs` | `Option<String>` from `dash_plan_path` |
| `ChangesetEntry::Dash::plan_path` | field | `tugrust/crates/tugcast-core/src/types.rs` | optional, skip-if-none |
| `DashChangesetEntry.plan_path` | field | `tugdeck/src/lib/changeset-types.ts` | optional; guard updated |
| `PLAN_REVIEW_LAST_DOMAIN` | const | `tugdeck/src/lib/model-domains.ts` | `"dev.plan-review-last"` |
| `writeLastReviewedPlan` / `readLastReviewedPlan` | fn | `tugdeck/src/lib/plan-review-controller.ts` | tugbank PUT + cache read, on `writePersistedModel`'s pattern |
| `resolvePlanReviewTarget` | fn | `tugdeck/src/lib/plan-review-controller.ts` | pure resolver for [P05]; unit-tested |
| `plan-review` registry entry | const member | `tugdeck/src/lib/slash-commands.ts` | `takesArgs: true` |
| `slashCommandSurfaces["plan-review"]` | handler | `tugdeck/src/components/tugways/cards/session-card.tsx` | resolve + latch |
| `REVIEW_PLAN_COMMAND` | const | `tugdeck/src/lib/plan-review-controller.ts` | value becomes `"tugplug:plan-review"` in [#step-8](#step-8) |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/devise-skeleton.md` — the Review Record's round grammar gains the stamp (Spec S02), with a note that `plan stamp` writes it.
- [ ] `tuglaws/dash-work-doctrine.md` — the never-ask list (List L02) as its own section.
- [ ] `tuglaws/plan-review-rubric.md` — a short "re-review" subsection stating edits-are-decisions and done-rows-frozen, so the doctrine holds the rule and the skill cites it.
- [ ] `tugplug/CLAUDE.md` — the roster, the flow line, and the stub paragraph.
- [ ] Repo `CLAUDE.md` — the tugplug row's skill list and the Git Policy exception's skill names.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | the extract, the verdict, the stamp edit's round-trip refusal | `cargo nextest run` over fixture documents in `plan.rs`'s test module |
| **Integration (Rust CLI)** | exit codes and JSON envelopes for `plan status` / `plan stamp` | `tugrust/crates/tugutil/tests/plan_cli.rs`, on the `plan lint` precedent |
| **Unit (TypeScript)** | `resolvePlanReviewTarget`'s three-step order and its refusal | `tugdeck/src/lib/__tests__/plan-review-controller.test.ts` |
| **App-test** | the typed `/plan-review` gesture, the borrow, and the release | `tests/app-test/at0412-plan-review-verb.test.ts`, on `at0409`'s pattern |
| **Drift prevention** | the review-progress invariance — a ledger flip must not restamp | a unit test that runs `set_ledger_status` and re-hashes |

#### What stays out of tests {#test-non-goals}

- **The skill prose itself** — a `SKILL.md` is instructions to a model, not code with a testable contract. The integration step reads each frontmatter and each fork by hand instead.
- **A live review turn on the review model** — one genuine run is a manual checkpoint in [#step-9](#step-9), as phase 2.1 established; an app-test drives the turn lifecycle with injected frames because the lifecycle's published phase is the whole input.
- **The dialogs' rendering** — `QuestionDialog` is shipped and covered; this phase adds callers, not a surface.
- **Fake-DOM component rendering of the card** — the project bans that shape outright; the gesture is covered by the real app.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Content stamp and review state | done | `40c1bac54` |
| #step-2 | `plan status` and `plan stamp` verbs | done | `462142152` |
| #step-3 | `plan_path` on the dash changeset entry | done | `5729f728c` |
| #step-4 | `/plan-review` as a card verb | done | `589ac16a2` |
| #step-5 | Re-review semantics in the review skill | done | `10ef5d11b` |
| #step-6 | The never-ask doctrine, the stale gate, and dash-implement's forks | done | `636c2d20d` |
| #step-7 | Dialog discipline across the remaining skills | done | `5e78c7ded` |
| #step-8 | The roster rename | done | `dfb492a20` |
| #step-9 | Integration checkpoint | done | `189e8490a` |

#### Step 1: Content stamp and review state {#step-1}

**Commit:** `tugutil(plan): content stamp, Review Record round parse, and review-state derivation`

**References:** [P01] canonical extract, [P03] readout not gate, Spec S01, Spec S02, Spec S05, (#review-derivation, #implementation-churn)

**Artifacts:**
- `tugutil-core/src/plan.rs`: `ReviewRound`, `PlanDoc::review_rounds`, `PlanDoc::review_record_span`, `content_stamp`, `ReviewState`, `review_state`, `set_review_stamp`, `StampError`, lint rule PL025.
- `tugutil-core/Cargo.toml`: `sha2.workspace = true`.

**Tasks:**
- [ ] Add `sha2` to `tugutil-core`'s dependencies (it is already declared in `tugrust/Cargo.toml`; `tugchanges-core` shows the `use sha2::{Digest, Sha256}` usage).
- [ ] Extend `parse` to record the Review Record section's line span (heading line through the line before the next heading of level ≤ the record heading's level) and to collect round lead-ins inside it into `review_rounds`. Reuse the existing scanner's fence handling — a fenced sample of the round grammar must not declare a round, exactly as `collect_headings` already refuses fenced headings.
- [ ] Parse each round's number, date, and model from the bold lead-in, and its stamp from a `` `plan:<hex>` `` token anywhere in the round's paragraph (Spec S02). A malformed lead-in is simply not a round.
- [ ] Implement `content_stamp` per Spec S01, driving the ledger-row reduction off `PlanDoc::ledger_rows`' line numbers so there is one definition of "a ledger row".
- [ ] Implement `review_state` per (#review-derivation): no rounds or no stamped round → `NeverReviewed`; newest stamped round's stamp equals the fresh extract hash → `Reviewed`; else `Stale`.
- [ ] Implement `set_review_stamp` per Spec S04 steps 2–5, following `set_ledger_status`'s compute-then-reparse-then-verify shape and its byte-preserving rewrite (only the inserted span moves).
- [ ] Add PL025 to `lint` per Spec S05, anchored to the round's line.

**Tests:**
- [ ] Unit: a document with one stamped round whose stamp matches reads `Reviewed`; changing one word of body prose flips it to `Stale`.
- [ ] Unit: the review-progress invariance — take a stamped fixture, run `set_ledger_status` to move a row `pending` → `done` with a commit, and assert `review_state` still reads `Reviewed`.
- [ ] Unit: ticking a task checkbox (`- [ ]` → `- [x]`) does not change the stamp; adding a new ledger row does.
- [ ] Unit: editing only the Review Record (appending a second round) does not change the extract hash.
- [ ] Unit: a plan with a Review Record but no stamp reads `NeverReviewed` and lints PL025.
- [ ] Unit: `set_review_stamp` on an already-stamped newest round returns `StampError::AlreadyStamped` and the source is untouched; on a document with no record, `StampError::NoRecord`.
- [ ] Unit: `set_review_stamp`'s output re-parses, and the stamp it wrote equals the hash of the *output's* extract (the stamp is self-consistent).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil-core`
- [ ] `cd tugrust && cargo build` clean under `-D warnings`

---

#### Step 2: `plan status` and `plan stamp` verbs {#step-2}

**Depends on:** #step-1

**Commit:** `tugutil(plan): status and stamp verbs over the content stamp`

**References:** [P02] verb writes stamp, [P03] readout not gate, Spec S03, Spec S04, (#review-derivation)

**Artifacts:**
- `tugutil/src/cli.rs`: `PlanCommands::Status`, `PlanCommands::Stamp`.
- `tugutil/src/plan.rs`: `run_status`, `run_stamp`, and their `--json` payload structs.
- `tugutil/tests/plan_cli.rs`: new cases.

**Tasks:**
- [ ] Add the two `PlanCommands` variants, each taking an explicit `path` — no resolution cascade, matching the module docstring's "a linter that guesses which document you meant is worse than one that asks".
- [ ] Implement `run_status` per Spec S03: parse, lint (for the counts only — never gate on them here), derive the review state, count ledger rows by status, and emit either the envelope or the plain read-out. Exit 2 via `AppError::Exit2` on an unreadable file or `NotAPlan`; exit 0 otherwise.
- [ ] Implement `run_stamp` per Spec S04, mapping each `StampError` to a located, actionable exit-1 message. Write the file only after the verify step returns.
- [ ] Use `JsonResponse::ok` for both (a status readout is never an error envelope, per [P03]).

**Tests:**
- [ ] Integration: `plan status --json` on a stamped fixture reports `review: "reviewed"` and exits 0; after a body edit, `"stale"`, still exit 0.
- [ ] Integration: `plan status` on the program plan (a document with no `{#execution-steps}`) exits 2.
- [ ] Integration: `plan stamp` on an unstamped round writes the stamp, exits 0, and a following `plan status` reports `reviewed`.
- [ ] Integration: `plan stamp` run twice — the second exits 1 and leaves the file byte-identical.
- [ ] Integration: `plan status --json` reports the ledger step counts for a fixture with mixed statuses.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil -p tugutil-core`
- [ ] `tugutil plan status dash/dash-integration-3-codification.md` reports `never-reviewed` with rounds ≥ 1 (the shipped phase 3 plan has a Review Record and no stamp — the expected pre-migration reading)

---

#### Step 3: `plan_path` on the dash changeset entry {#step-3}

<!-- No dependency: this is feed plumbing over `dash_plan_path`, which phase 3
     already shipped. It shares no code with the stamp work and could land first. -->

**Commit:** `tugdash(plan-lane): carry each dash's recorded plan path through the changeset feed`

**References:** [P04] worktree copy, (#plan-path-in-the-deck, #rollout)

**Artifacts:**
- `tugdash-core/src/ops.rs`: `DashDetail::plan_path`.
- `tugcast-core/src/types.rs`: `ChangesetEntry::Dash::plan_path`.
- `tugcast/src/feeds/changeset.rs`: the mapping.
- `tugdeck/src/lib/changeset-types.ts`: the field and its guard.

**Tasks:**
- [ ] Add `plan_path: Option<String>` to `DashDetail` and populate it in `dash_detail_entries_in` from `dash_plan_path(repo_root, name)` — the same read `status_in` already performs.
- [ ] Add the matching optional field to `ChangesetEntry::Dash` with `#[serde(default, skip_serializing_if = "Option::is_none")]`, alongside `step_current` / `step_total`, and document it as worktree-relative.
- [ ] Map it in `dash_entries` where the other `detail.*` fields are mapped, then fix every literal `ChangesetEntry::Dash { … }` construction the compiler names. There are **14 at time of writing, spanning three files** — `tugcast-core/src/types.rs`, `tugcast/src/feeds/changeset.rs`, and `tugcast/src/feeds/draft_engine.rs` — because the variant has no `Default` and every site enumerates all fields. Budget for the sweep; it is mechanical but it is not two edits.
- [ ] Add `plan_path?: string` to `DashChangesetEntry` in `changeset-types.ts` with a doc comment naming it worktree-relative, and extend the entry's type guard the way `step_current` is guarded (optional-or-string).

**Tests:**
- [ ] Rust unit: a dash whose branch config records a plan reports it in `dash_detail_entries_in`; one without reports `None`.
- [ ] TypeScript unit: the changeset entry guard accepts an entry with `plan_path` and one without, and rejects a non-string value.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugcast-core -p tugcast`
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 4: `/plan-review` as a card verb {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck(plan-lane): /plan-review card verb with last-reviewed-first resolution`

**References:** [P05] resolution order, [P06] one entrance, [P04] worktree copy, (#plan-path-in-the-deck, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/lib/model-domains.ts`: `PLAN_REVIEW_LAST_DOMAIN`.
- `tugdeck/src/lib/plan-review-controller.ts`: `writeLastReviewedPlan`, `readLastReviewedPlan`, `resolvePlanReviewTarget`.
- `tugdeck/src/settings-api.ts`: the new domain in `CARD_KEYED_DOMAINS`.
- `tugdeck/src/lib/slash-commands.ts`: the registry entry.
- `tugdeck/src/components/tugways/cards/session-card.tsx`: the surface handler.
- `tests/app-test/at0412-plan-review-verb.test.ts`.

**Tasks:**
- [ ] Add `PLAN_REVIEW_LAST_DOMAIN = "dev.plan-review-last"` to `model-domains.ts` (the dependency-free leaf that already holds `PLAN_REVIEW_DOMAIN`), and add it to `CARD_KEYED_DOMAINS` in `settings-api.ts` so `pruneOrphanedCardDefaults` sweeps it.
- [ ] Add `writeLastReviewedPlan(cardId, path)` and `readLastReviewedPlan(cardId)` to the controller module, following `writePersistedModel`'s optimistic `setLocalValue` + PUT shape and `readPlanReviewSelector`'s cache read.
- [ ] Call `writeLastReviewedPlan` from `PlanReviewController.submit`, so both the broadcast path and the typed path record the card's last-reviewed plan.
- [ ] Add `resolvePlanReviewTarget(input): { path: string } | { refused: true }` as a **pure** function taking the trimmed args, `projectDir`, the last-reviewed path, and the bound dash entry (`worktree`, `plan_path`). Order: explicit arg (absolute, else joined onto `projectDir`) → last-reviewed → `projectDir`/`worktree`/`plan_path` → refuse ([P05]).
- [ ] Register `{ name: "plan-review", description: …, takesArgs: true }` in `LOCAL_SLASH_COMMANDS`. It becomes `supported-local` automatically — `slash-supported.ts` derives its set from the registry — and the `as const satisfies` narrowing makes the missing handler a compile error.
- [ ] Write the `slashCommandSurfaces["plan-review"]` handler: read the binding (return silently when absent, the `/diff` precedent), find the bound dash's entry in `changesController.getSnapshot().dashes` by `display_name`, call the resolver, and on success `planReviewRequestStore.latch(cardId, path)` ([P06]). On refusal, `paneBulletinRef.current?.caution` naming the explicit form. Add no `canSubmit` gate — verified in `tug-prompt-entry.tsx`, the `RUN_SLASH_COMMAND` dispatch deliberately runs **before** the send-readiness gates, so the handler is reached mid-turn and the controller's park is what waits.
- [ ] Write `at0412-plan-review-verb.test.ts` on `at0409`'s pattern: type `/plan-review <abs path>` in card A, assert the AI chip moves to the review model, inject the turn's settle, assert the chip returns and `dev.model/A` is byte-identical. Assert the submitted turn carries a **command atom**, never a literal command string (`buildCommandSubmission` puts the name in the atom). Carry `@covers` lines for the controller, the registry, and the card.

  **Typing the command is safe, and the reason is not obvious.** Submitting runs `editor.acceptActiveCompletion()` first, so a typed `/plan-review` may become a command *atom* rather than plain text — and `matchLocalSlashCommand` only inspects strings. It still matches, because `buildSlashCommandLine` reconstructs a plain `/name …` line from the draft first, expanding a leading command atom back to `/name` and any `@`-mention in the argument to its path. So `/plan-review @dash/some-plan.md` reaches the resolver as a normal path argument. Do not write the test to dodge the completion popup; the flattening is the shipped behavior and is worth exercising.

**Tests:**
- [ ] Unit: `resolvePlanReviewTarget` returns the explicit arg when given one, absolute or project-relative.
- [ ] Unit: with no arg, last-reviewed wins over a bound dash naming a different plan ([P05]).
- [ ] Unit: with no arg and no last-reviewed, the bound dash composes `projectDir`/`worktree`/`plan_path`.
- [ ] Unit: with nothing resolvable, it refuses.
- [ ] App-test: the typed gesture borrows and releases the review model, leaving the persisted selector untouched.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `bun test tugdeck/src/lib/__tests__/plan-review-controller.test.ts`
- [ ] `just app-test at0412-plan-review-verb.test.ts`

---

#### Step 5: Re-review semantics in the review skill {#step-5}

**Depends on:** #step-2

**Commit:** `tugplug(plan-lane): re-review semantics, content stamp, and the review dialog`

**References:** [P02] verb writes stamp, Spec S02, Spec S04, List L01, (#dialog-forks)

**Artifacts:**
- `tugplug/skills/review-plan/SKILL.md` (renamed in [#step-8](#step-8); edited here under its current name).
- `tuglaws/devise-skeleton.md`: the Review Record's grammar.
- `tuglaws/plan-review-rubric.md`: a re-review subsection.

**Tasks:**
- [ ] Add `AskUserQuestion` to the skill's `allowed-tools` and write the fork from List L01: a judgment call — scope, product trade-off, no technically correct answer — is a dialog **first**; the answer lands in the plan as a decided item, and only a deferral becomes `[Q##]`. State explicitly that a `[Q##]` in a finished plan means *asked and deferred*, never never-asked.
- [ ] Add the **orient-on-what-moved** rule: run `tugutil plan status <path> --json` first; on a second or later round, orient on the git diff when the plan is tracked and dirty, otherwise on the Review Record — and name which in the round's `Oriented on:` line (Spec S02).
- [ ] Add **edits-are-decisions**: a user edit since the last round is a decision to carry forward. Fix what it broke, name a consequence it missed, never revert its intent.
- [ ] Add **done-rows-frozen**: a ledger row marked `done` describes work already in the tree. Rewriting that step produces a document that lies about the tree — raise an Open Question or add a new step instead.
- [ ] Replace the Review Record step's example with the Spec S02 grammar (no hand-written stamp in it) and add the final step: run `tugutil plan stamp <path>` as the **last** edit of the review, after the round paragraph is written and after any `Last updated` bump. State that the stamp is computed, not authored ([P02]).
- [ ] Update `tuglaws/devise-skeleton.md`'s Review Record block to show the stamped grammar and to say `plan stamp` writes it.
- [ ] Add a short re-review subsection to `tuglaws/plan-review-rubric.md` holding edits-are-decisions and done-rows-frozen, and have the skill cite it rather than restate it.

**Tests:**
- [ ] Manual (**after `just app-debug` from the worktree** — the running instance reads skills from `Tug.app/Contents/Resources/tugplug`, not the repo; see (#constraints)): run `/tugplug:review-plan` by hand on a fixture plan copied into a scratch directory, confirm the round paragraph carries `Oriented on:` and that `tugutil plan status` reads `reviewed` afterwards. (Skill prose has no automated contract — see (#test-non-goals).)
- [ ] Integration (Rust): a fixture round written in the Spec S02 grammar parses with its stamp, its date, and its model.

**Checkpoint:**
- [ ] `tugutil plan lint` exit 0 on a plan whose Review Record uses the new grammar
- [ ] grep: the words "edits are decisions" and "done rows are frozen" appear in the rubric and are *cited*, not restated, in the skill

---

#### Step 6: The never-ask doctrine, the stale gate, and dash-implement's forks {#step-6}

**Depends on:** #step-2

**Commit:** `tugplug(plan-lane): never-ask doctrine; dash-implement gates on plan staleness and raises its three forks`

**References:** [P07] gate covers never-reviewed, [P03] readout not gate, [Q02] copy divergence, List L01, List L02, Spec S03, (#dialog-forks)

**Artifacts:**
- `tuglaws/dash-work-doctrine.md`: the never-ask section.
- `tugplug/skills/dash-implement/SKILL.md`.

**Tasks:**
- [ ] **First**, add the "What never gets asked" section to `tuglaws/dash-work-doctrine.md` carrying List L02 verbatim, plus the closing rule: join's other stops (conflicts, a missing draft, a named blocker) are correct refusals with one right answer, not unasked questions. The doctrine lands **before** the first skill that cites it, so no commit in this phase ships a dangling reference.
- [ ] In the Setup phase, after the plan is present inside the worktree (its existing task 3), add: run `tugutil plan status <worktree-plan-path> --json` and read `data.review`. This is deliberately after the copy — the worktree copy is what the run drives ([P04]).
- [ ] Add the **divergence detection** for [Q02]: when the plan was given as a base-checkout path *and* a worktree copy already exists, compare the two files. If they differ, say so before the gate's verdict — naming both paths — because a `reviewed` verdict on a worktree copy that is missing the user's uncommitted base edits is the one wrong answer this gate can give. Detection only; the resolution policy is [Q02] and is not decided here.
- [ ] Write the **stale gate** fork: on `stale` or `never-reviewed`, raise `AskUserQuestion` with "Review now (Recommended)" and "Proceed as-is", the message naming which verdict and, on `stale`, the last round's date and model from `data.last_round`. Never hard-refuse ([P07]). On "Review now", print `` `/tugplug:plan-review <path>` `` as its own backticked chip and stop.
- [ ] Write the **step-refusal** fork: replace the current "fix the plan and re-run the verb; hand-edit only when the document genuinely cannot be made to parse" prose with a dialog — "Fix the plan and retry" / "Hand-edit the ledger this run" — since the wrong guess corrupts the durable record. Keep the existing description of *why* a refusal happens (a plan that does not strictly parse, a missing row, an anchor that is not `#step-<n>`, a `done` row reopened).
- [ ] Write the **batch boundary** fork: on a run walking more than six steps in one invocation, ask once at the midpoint — "Continue" / "Stop here and report". Never per-step, and never on a short run. State the threshold explicitly so it is not re-invented per run.
- [ ] Add a guardrail line citing the doctrine's never-ask section written above, so the licence and the boundary travel together.

**Tests:**
- [ ] Manual (**after `just app-debug` from the worktree** — skills run from the app bundle, see (#constraints)): point `dash-implement` at a plan with no Review Record and confirm the gate dialog appears rather than the walk starting.
- [ ] Integration (Rust): `plan status --json` on a plan with a `done` row and a stale stamp reports both `review: "stale"` and the step counts the gate's message quotes — the two fields the skill reads exist and are populated together.

**Checkpoint:**
- [ ] grep: `dash-implement/SKILL.md` names `tugutil plan status` exactly once, in Setup
- [ ] grep: each of the three forks in List L01 attributed to `dash-implement` appears in the skill
- [ ] grep: List L02's five rules live in `tuglaws/dash-work-doctrine.md` and in no skill file

---

#### Step 7: Dialog discipline across the remaining skills {#step-7}

**Depends on:** #step-6

**Commit:** `tugplug(plan-lane): the remaining [P09] forks — devise, dash-audit, dash-join`

**References:** List L01, List L02, (#dialog-forks)

**Artifacts:**
- `tugplug/skills/devise/SKILL.md`, `dash-audit/SKILL.md`, `dash-join/SKILL.md`.

**Tasks:**
- [ ] `devise`: it already declares `AskUserQuestion` and already says to clarify only design-changing unknowns. Add the [P09] framing — an Open Question the author cannot settle is **asked before the plan is declared ready**, so a `[Q##]` in a finished plan means asked and deferred.
- [ ] `dash-audit`: add `AskUserQuestion` to `allowed-tools` and the disposition fork — "Carry the fixups now as rounds on this dash" / "Leave the list with you". The verdict itself stays read-only, and the existing `dash mark … audited` carve-out is unchanged.
- [ ] `dash-join`: it already declares `AskUserQuestion`. Convert the empty-dash path from prose ("report it and offer release as the user's call") to the fork — "Release it" / "Leave it" — and keep the never-release-on-your-own-initiative guardrail, since a dialog *is* the user gesturing. Leave conflicts, draftless, and blockers as stops.
- [ ] Have these three skills cite the doctrine's never-ask section ([#step-6](#step-6) wrote it) rather than restating it.

**Tests:**
- [ ] Manual: read each of the three frontmatter blocks and confirm `AskUserQuestion` is present exactly where List L01 says a fork lives.
- [ ] Manual (**after `just app-debug`** — see (#constraints)): trigger `dash-join` on an empty dash and confirm the "Release it / Leave it" dialog appears instead of the old prose hand-back.

**Checkpoint:**
- [ ] grep: every skill named in List L01 declares `AskUserQuestion` in `allowed-tools`
- [ ] grep: no skill file restates List L02; each cites the doctrine

---

#### Step 8: The roster rename {#step-8}

**Depends on:** #step-4, #step-5, #step-6, #step-7

**Commit:** `tugplug(plan-lane): plan-devise / plan-review / dash-on roster, with redirect stubs`

**References:** [P05] of the program plan (namespace rule), [P06] one entrance, (#rollout, #symbols)

**Artifacts:**
- Three new skill directories, three redirect stubs, the deck's command constant, the CLI's remedy strings, `tugplug/CLAUDE.md`, repo `CLAUDE.md`.

**Tasks:**
- [ ] `git mv` each skill directory: `devise` → `plan-devise`, `review-plan` → `plan-review`, `dash-run` → `dash-on`; update each frontmatter `name`.
- [ ] `dash-on`: trim the input grammar to `<name> <instruction…>`. Delete the `status`, `join`, and `release` sub-verbs and the reserved-words note — `dash-join` and `/join` own landing, `tugutil dash status|list` own the readouts, and release is a bare CLI call. Update `argument-hint` to `"[name] [instruction…]"`. Keep the Release section only as the guardrail that never runs it on the skill's initiative.
- [ ] Write three redirect stubs on the `vet` precedent (`tugplug/skills/vet/SKILL.md` is the model): frontmatter intact with `disable-model-invocation: true` and `allowed-tools: Read`, print the replacement command as its own backticked chip with the user's arguments substituted, do nothing else, and say it is deleted in a later release.
- [ ] Update every hand-off string: `plan-devise`'s no-tugcast fallback and `plan-review`'s post-review chip, plus `vet`'s stub text, which names `review-plan`.
- [ ] Deck: `REVIEW_PLAN_COMMAND` in `plan-review-controller.ts` becomes `"tugplug:plan-review"`. Update `plan-review-controller.test.ts` and `at0409-plan-review-borrow.test.ts` where they name the skill.
- [ ] Rust: `run_review_request`'s two remedy strings in `tugutil/src/plan.rs` name `/tugplug:review-plan` — update both, and the matching assertion in `tugutil/tests/plan_cli.rs`.
- [ ] Grep `review-plan`, `tugplug:devise`, and `dash-run` across `tugdeck/`, `tests/`, `tugrust/`, `tugplug/`, `tuglaws/`, and `dash/`, and judge each site. Roadmap prose describing a shipped phase keeps its historical spelling (the program plan's reading convention); live instructions do not.
- [ ] Docs: `tugplug/CLAUDE.md`'s roster, flow line, and stub paragraph; repo `CLAUDE.md`'s tugplug row and the Git Policy exception's skill names (which still say `dash-run`).

**Tests:**
- [ ] Unit: `plan-review-controller.test.ts` pins the submitted command name at its new value.
- [ ] Integration (Rust): `plan_cli.rs`'s no-reachable-instance case asserts the remedy names `/tugplug:plan-review`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `cd tugrust && cargo nextest run -p tugutil`
- [ ] `just app-test at0409-plan-review-borrow.test.ts at0412-plan-review-verb.test.ts`
- [ ] grep: no live instruction anywhere names `/tugplug:review-plan`, `/tugplug:devise`, or `/tugplug:dash-run` outside a stub or a historical roadmap passage

---

#### Step 9: Integration checkpoint {#step-9}

**Depends on:** #step-4, #step-8

**Commit:** `N/A (verification only)`

**References:** [P01] canonical extract, [P05] resolution order, [P07] gate covers never-reviewed, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] One real pass over the lane, on this phase's own dash: run `/tugplug:plan-review` on this document from the card, confirm the turn goes out on the review model, confirm the Review Record gains a stamped round, and confirm `tugutil plan status` then reads `reviewed`.
- [ ] Edit one word of this plan's body and confirm `plan status` flips to `stale`; run `tugutil dash step done` on a ledger row and confirm it stays `reviewed` (the invariance, observed on a real document rather than a fixture).
- [ ] Point `/tugplug:dash-implement` at the stale document and confirm the gate dialog appears with "Review now (Recommended)".
- [ ] `just app-debug` from the worktree; confirm the `(debug, <branch>)` instance takes `/plan-review` bare and resolves through last-reviewed.

**Tests:**
- [ ] `cd tugrust && cargo nextest run` (full workspace)
- [ ] `bun test` (repo root)

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` clean
- [ ] `just app-test-changed` green
- [ ] `tugutil plan lint dash/dash-integration-3.1-plan-lane.md` exit 0

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The plan lane is a workflow: a plan knows whether its review covers its current content, `/plan-review` is a first-class card verb that always gets the review model, re-review is additive and edit-respecting, implementation gates on staleness, every decision point in the lane asks instead of guessing, and the skills carry their final names.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `tugutil plan status <path> [--json]` reports `reviewed` / `stale` / `never-reviewed` with rounds, last round, lint counts, and ledger progress (Spec S03).
- [ ] `tugutil plan stamp <path>` writes exactly one stamp per round and refuses everything else (Spec S04).
- [ ] Ledger progress and checkbox ticks do not move the stamp; body edits do (unit-pinned).
- [ ] `/plan-review` runs the review on the borrowed model from a typed gesture, resolving explicit → last-reviewed → bound dash → refuse.
- [ ] `dash-implement` raises the stale gate at setup and never hard-refuses.
- [ ] Every fork in List L01 lives in its skill; every rule in List L02 lives in the doctrine and nowhere else.
- [ ] `plan-devise`, `plan-review`, and `dash-on` are the live skills; `devise`, `review-plan`, and `dash-run` are stubs.

**Acceptance tests:**
- [ ] `cargo nextest run` green across the workspace, including the new `plan.rs` and `plan_cli.rs` cases.
- [ ] `bun test` green, including `resolvePlanReviewTarget`'s resolution-order cases.
- [ ] `just app-test at0409-plan-review-borrow.test.ts at0412-plan-review-verb.test.ts` green.
- [ ] `tugutil plan lint` exit 0 on this document, with its own Review Record stamped.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] The stale mark on the Lens Dashes section and the dash chrome ([Q01], phase 5).
- [ ] Deleting every redirect stub — this phase's three, phase 3's four, and `vet` (phase 5).
- [ ] A `plan status` projection on the CHANGESET feed, if phase 5's mark wants it without a shell call.

| Checkpoint | Verification |
|------------|--------------|
| Stamp derivation is sound | `cargo nextest run -p tugutil-core` — including the progress-invariance test |
| The verbs behave at the CLI boundary | `cargo nextest run -p tugutil` — exit codes and envelopes |
| The gesture reaches the borrow | `just app-test at0412-plan-review-verb.test.ts` |
| The rename left nothing dangling | grep for the three old command spellings outside stubs and history |
| The document itself conforms | `tugutil plan lint dash/dash-integration-3.1-plan-lane.md` exit 0 |
