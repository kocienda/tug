## The Agent-Finished Join {#agent-finished-join}

**Purpose:** A conflicted dash join stops being a ladder that gives up into a human review queue and becomes one agent's job to finish: the resolver reconciles divergence from the dash's recorded intent, verifies the joined project (build + `@covers`-derived test selection), escalates to the user only as an intent question, and reports what it did. The human diff-review gate retires; the dash-lane vocabulary becomes **join** everywhere it names the dash act.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via a dash worktree) |
| Last updated | 2026-08-19 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-19, opus.** Reviewed `plan:219ca801d6060917`. Lint: 0 errors, 1 warning (fixed — this section).
Oriented on: the plan as written (never reviewed), read against `tugdash-core/src/{ops,resolve}.rs`, `tugcast/src/{scribe.rs,shared_agent.rs,feeds/{join_board,join_resolve,agent_supervisor}.rs}`, `tugcast-core/src/types.rs`, `tugdeck/src/lib/{join-mode-controller,changeset-join-store,changeset-types,landing-mode}.ts`, `tugdeck/src/components/tugways/chrome/session-question-dialog.tsx`, the `Justfile` app-test recipe, `tests/app-test/scripts/select-tests.ts`, and the at0417/at0418/at0425/at0426/at0436/at0441 fixtures.
Applied: **the guarantee at0426 encodes was being dropped silently** — its docblock names a stale rerere resolution that keeps one side wholesale as "green build, green tests, broken at runtime", which is precisely the class [P05]'s verification cannot catch, so the plan replaced human review with a check that does not cover the reason review existed; added [P10] (the resolver audits every algorithmic rung's resolution against intent), wired it through Spec S01/S02, Step 5, Step 6, and rewrote at0426 as the audit fixture instead of deleting it. **Workshop economics were unbuildable as specified** — a nonce-per-resolve detached worktree has no `node_modules` (so Tier 0's `bunx tsc`/`vite build` fail outright), a cold `target/` (so `cargo check` is a full dependency build), and a `detached-<sha8>` slug that changes with every candidate, which gives Tier 1 fresh per-worktree DerivedData and therefore a full Tug.app build per candidate; [P03] now specifies a stable, branch-named, per-dash workshop hydrated once via the project's `post_create` hooks and reset between uses. **The escalation surface named the wrong component** — [P06] said `TugInlineDialog`, the raw primitive, where `QuestionWizard` (`chrome/session-question-dialog.tsx`) is the shipped Tug component for a 2–4-option question with free text; corrected, with the session `pendingQuestion` path explicitly excluded. **The rename step under-scoped its blast radius** — renaming `session-changes-dash-landing.tsx` breaks the `@covers` lines in six fixtures and fails `app-test-covers-check`; Step 1 now sweeps `@covers` targets repo-wide and enumerates the test files whose own names carry the dash act. **Sequencing**: Step 8 deleted the review path while five existing fixtures still pressed its controls, leaving the corpus red until Step 9 — fixture repair folded into Step 8. Also added `changeset-join-store.ts` (the client sender of `changeset_join_review`) to the symbol inventory, and settled at0443's undecided "config knob or stub" fork.
Deferred: nothing — the three design forks this plan faced were asked at devise time and are recorded as [Q01]–[Q03] with their answers.

**Round 2 — 2026-08-19, opus.** Reviewed `plan:d3bacede8b579a72`. Lint: 0 errors, 0 warnings.
Oriented on: the Review Record. The plan is tracked and clean (committed whole as `bf10ca773`), so no diff since round 1 exists in the tree; round 1's findings and the author's post-stamp fixes — the `tugworkshop/<name>` namespace, [P11], Spec S04 — were the map, read against the code they name.
Applied: **the escalation surface was still not mountable.** Round 1 corrected [P06] from `TugInlineDialog` to `QuestionWizard`, but the component is session-bound *by its props*, not merely surrounded by session machinery — `QuestionWizardProps` takes `request: ControlRequestForward` and `session: CodeSessionStore`, and the body subscribes to `session.getSnapshot().pendingQuestion`, answers through `session.respondQuestion`, and cancels through `session.popInteractive()`. A join has none of those, so "feed the wizard from the join block's `question` field while excluding `pendingQuestion`/`respondQuestion`" named a component that cannot accept it; [P06] now specifies the host-seam extraction (`questions: ParsedQuestion[]` + `isPending` + `onSubmit`/`onDecline`/`onCancel`, with `AskUserQuestionToolBlock` taking over the session adapter and its own tests as the no-regression proof), Step 7 carries the lift as a task, and the two symbols are in the inventory. **Step 7 also still said `TugInlineDialog` in its Artifacts and Tasks**, contradicting its own decision — corrected. **Three more survivals of the pre-fix workshop design**: the risk table still described a "nonce name" workshop, [P03]'s heading and Step 2's commit message still called it "a detached scratch worktree", and the symbol inventory said `close` where [P03] and Step 2 say `release` — all reconciled to the stable per-dash workshop. **[P03]'s invisibility claim was inherited, not owned**: `base_working_set_dirt`'s own comment states that `--exclude-standard` is what keeps `.tug/` worktrees out of the untracked half and is "wrong in one that does not" ignore its worktree home — so in a project that does not ignore `.tug/`, a whole second checkout plus build outputs becomes base dirt that can swamp the Changes card and trip a join preflight; [P03] now ensures the ignore via `.git/info/exclude`, with a risk row and a Step 2 test. **Tier 1 had two unanswered exits and one silent narrowing**: `select-tests.ts` exits `EXIT_OVER_BUDGET` (3) emitting no filenames past `MAX_SELECTED` (20) and prints CORE TIER ADVISED on a `CORE_TIER_TRIGGERS` path — a broad candidate or a `_harness/` touch hits either, and the plan said nothing, so both now fall back to the core tier with the reason noted; and `TUG_APPTEST_ASSUME=background` (the screen-seizure guard) *skips* `@foreground` tests, so tier 1 reports green-with-exclusions rather than an overstated green. **[P11]'s fixture posture was half-stated**: fixtures declaring no `verify_tier1` is the gate-deadlock argument, but at0443's break-the-build arc and Step 3's red-tier0 unit require a *declared* `verify_tier0` — a repo declaring nothing is green-by-construction and can never go red — now stated in [P11] and Step 9. **Round 1's rename blast radius undercounted**: `session-changes-dash-landing.tsx` is named by **seven** app-tests, not six — `at0435-landing-refusal-speaks.test.ts` was missed, and its docblock ("an otherwise landable dash", "the dash-join dead press") puts it on the dash act, so it is both a `@covers` re-point and a third rename; Step 1 also now names the component's `.css` pair, its `__tests__` unit test, and the five non-test importers, and Step 8's fixture-repair list and checkpoint include at0435. Finally, **Spec S04 was written from first principles over a shipped implementation**: `ClaudeAgentWorkerSpawner`/`drive_worker` (`shared_agent.rs`) already runs exactly this multi-turn streaming-input spawn, so S04 now anchors to it and adopts three details it would otherwise have missed — the `claude_auth::claude_command` wrapper (auth/PATH a GUI-launched tugcast lacks), the mandatory `--verbose` alongside `--output-format stream-json` under `-p`, and `--strict-mcp-config` so the resolver loads no project MCP servers. Also widened [P03]'s glob citation to name the changesets feed's dash-entry derivation, not just `ops.rs`.
Deferred: nothing — every finding was settleable from the code or the plan's own decisions; none needed a product call.
Not changed: the round-1 corrections and the author's post-stamp fixes are decisions and were left intact in intent; the ladder's rungs 1–4, the [P10] audit duty, and the [Q01]–[Q03] answers were re-read against the code and stand.

---

### Phase Overview {#phase-overview}

#### Context {#context}

This is Round 2 of `roadmap/close-dash-join-gaps.md`. Round 1 (`roadmap/dash-universe-scope.md`, joined 2026-08-19) gave the app-test harness an explicit repo universe (`TUG_REPO_UNIVERSE`) so tests run from any worktree — which is the capability this round's verification tier consumes.

Today, `Ready to land — ⌃⌘C, or /dash-join` (the readiness line in `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-landing.tsx`) means *git found no overlapping hunks, or every conflict has a machine resolution the human has reviewed*. Two things are wrong. First, nothing asks the project: `tugdash_core::ops::join_in` runs no build and no test, so a textually clean, semantically broken merge joins behind a green line. Second, the human is the machine's finisher and reviewer: the resolution ladder (`tugdash-core/src/resolve.rs`) hands unresolved files back to the human, and every file the machine *did* resolve waits on the human's diff review (the `tugjoinreviewed` branch-config mark, `write_reviewed`) before the join gate opens. Tug presents an AI workflow; a surface that asks the developer to adjudicate diverging diffs is a rejected design (2026-08-19).

The ladder's last rung is already an AI, but the smallest possible one: `ScribeFileMerger` (`tugcast/src/feeds/join_resolve.rs`) hands a headless `claude -p` three blobs and one intent string (`resolve_intent`: maintained draft + round subjects) and takes back bytes — no tools, no worktree, no verification, no escalation. This round grows that seam into a resolver that finishes the job.

#### Strategy {#strategy}

- **Rename first** ([P01]): dash-lane `land` → `join` before anything is built, so new work is born with the right vocabulary. The shared commit|join composer substrate (`tugdeck/src/lib/landing-mode.ts`) keeps its name by explicit user ruling.
- **Workshop worktree** ([P03]): materialize the real merge (or the candidate) in a stable, per-dash, hydrated worktree — the place the resolver works and verification runs, warm across candidates. The ladder's blob-based rungs are untouched.
- **Verification as a server-owned fact** ([P04]): two tiers (build, derived app-test selection), anchored to `(base_sha, candidate_sha)`, persisted as a branch-config fact, surfaced on `DashJoinState` like every other join fact.
- **The resolver** ([P02], Spec S01): a per-join, tool-capable headless `claude` spawn under a named charter, working in the workshop, iterating against Tier 0 until green or stuck, streaming progress over the existing S12 delta channel.
- **Escalation as an intent question** ([P06]): a server-originated question frame rendered on the join face; answers resume the resolver.
- **Retire the review gate, keep its guarantee** ([P07], [P10]): the join gate reads verification + a report that accounts for every resolved path; the audit the human was doing moves to the resolver rather than disappearing; red offers an explicit override, never a trap.
- Build order: rename → workshop → verification → resolver → escalation → face → fixtures. Each step is independently green.

#### Success Criteria (Measurable) {#success-criteria}

- A conflicted join completes end-to-end with no human diff review: at0441's extended arc (conflicted → agent-resolved → verified → joined) passes with a stub resolver (verify: `just app-test at0441-join-arc-end-to-end.test.ts`).
- A textually clean merge with a broken build cannot join silently: a fixture pins that the face shows red verification naming the failure, and the join proceeds only through the explicit override control (verify: the new red-override app-test).
- An escalation renders as an intent question with 2–4 options on the join face, and the chosen answer reaches the blocked resolver (verify: the new escalation app-test with a scripted resolver stub).
- The 2026-08-15 class stays guarded without a human diff review: a wholesale rung resolution that builds and passes is caught by the audit pass and named in the report (verify: `just app-test at0426-dash-resolution-audit.test.ts`, [P10], Risk R02).
- `grep -rn "land" tugdeck/src/components/tugways/cards/session-changes/` and the dash-lane readiness strings contain no "land" naming the dash act; `landing-mode.ts` and its umbrella symbols are unchanged (verify: grep + `bun test`).
- `write_reviewed` / `tugjoinreviewed` / `DashJoinState.reviewed` are gone from the tree (verify: grep exits 1).
- `cargo nextest run`, tugdeck `bun test`, `bunx vite build`, `bunx tsc --noEmit` all green.

#### Scope {#scope}

1. Dash-lane rename `land` → `join` (code, UI strings, file names, test names, tuglaws/tugplug/roadmap prose about the dash act).
2. Workshop worktree lifecycle in `tugdash-core`.
3. Verification facts (Tier 0 build, Tier 1 derived selection) on `DashJoinState`, with persistence and caching.
4. The resolver: seam, charter, orchestration, report, progress streaming, stub seam for tests.
5. Escalation: server question frame, client store, join-face dialog.
6. Join-face rework: new states, review gate retired, report rendering.
7. Fixtures: at0441 extension, escalation fixture, red-override fixture.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Improving app-test corpus quality (culling non-falsifiable / pixel-measuring tests) — acknowledged separate roadmap item; a flaky red here costs a resolver iteration, not this round's design.
- Deleting at0426 — its incident class survives this round's design and is re-guarded at the audit layer ([P10]); the fixture is rewritten, never dropped.
- Renaming the shared commit|join composer substrate (`landing-mode.ts`, `LandingKind`, `LandOutcome`, `landing-press-receipt.ts`, `landing-notice.ts`) — kept by user ruling ([P01]).
- A takeover mode that opens the workshop worktree as a project — the escalation dialog's free-text answer and "Chat about this" affordances are the takeover for now; the report names the workshop path for a human who wants to look.
- Running the resolver through a tugcode session — decided against ([P06] rationale).
- Live-model resolver tests in the app-test corpus — real-claude runs are on-demand only; the corpus drives the stub seam.

#### Dependencies / Prerequisites {#dependencies}

- Round 1's universe scoping (`TUG_REPO_UNIVERSE`, `tugutil_core::find_repo_root_from`) — shipped, joined 2026-08-19.
- Join-truth's server-owned join facts (`tugcast/src/feeds/join_board.rs`, `DashJoinState` in `tugcast-core/src/types.rs`, client mirror `DashJoinStateWire` in `tugdeck/src/lib/changeset-types.ts`) — shipped 2026-08-18.
- The S12 resolve-progress delta channel (`changeset_join_resolve_delta`, `tugcast/src/feeds/join_resolve.rs::emit_delta`).
- `tests/app-test/scripts/select-tests.ts` accepts explicit changed paths (the Tier 1 derivation entry point).

#### Constraints {#constraints}

- Warnings are errors (`-D warnings`); every step ends green.
- App-tests are selective (`@covers`-derived), never a sweep; output never piped.
- No banned test shapes: no jsdom/RTL render tests, no mock-store assertion tests, no pixel measuring.
- The resolver spawn must have a scriptable stub seam so no app-test needs a live model.
- [L29]: every path compared or persisted goes through the canonical `workspace_key` gateway.
- [D127] discipline: no API accepts an arbitrary prompt — the resolver runs a named job whose instructions are a reviewed contract.
- Only the dash worktree is written during implementation; `main` is only updated by the user's join gesture.

#### Assumptions {#assumptions}

- `claude` CLI supports headless tool-capable runs (`claude -p` with `--permission-mode` and cwd confinement) — the same binary the scribe already shells.
- Machine-wide app-test serialization holds: Tier 1 runs are scheduled, not ambient ([P09]).
- The resolver model is the configured scribe model (Sonnet default) unless a config overrides it — no new model-selection UI this round.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton anchor and label conventions: explicit kebab-case `{#anchors}` on every cited heading, `#step-N` step anchors, two-digit stable labels (`[P01]`, `[Q01]`, `S01`, `R01`), `**Depends on:**` lines citing step anchors, and `**References:**` lines citing labels and anchors — never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] What runs the resolver? (DECIDED — see [P02]) {#q01-resolver-substrate}

**Question:** A tool-capable worker class on the SharedAgent pool, or a per-join spawn under a SharedAgent-style charter?

**Resolution:** DECIDED 2026-08-19 by the user: per-join spawn + charter. The pool's invariants (tool-less, self-contained short turns, warmth-for-latency) are the wrong shape for a minutes-long, worktree-mutating job, and pooling buys nothing for it.

#### [Q02] How does the escalation reach the user? (DECIDED — see [P06]) {#q02-escalation-transport}

**Question:** A tugcast-originated question frame rendered by the card, or route the resolver through a tugcode session so `AskUserQuestion` works natively?

**Resolution:** DECIDED 2026-08-19 by the user: server question frame. A join must be resolvable when no session is mid-turn, and the session route entangles the join with a conversation's lifecycle, transcript, and model selection.

#### [Q03] What happens to the shared "landing" vocabulary? (DECIDED — see [P01]) {#q03-shared-landing-name}

**Question:** `landing-mode.ts` defines `LandingKind = "commit" | "join"` and both composer mode controllers implement it — does the umbrella term rename too?

**Resolution:** DECIDED 2026-08-19 by the user: **keep "land" as the shared commit|join umbrella.** The rename applies only where "land" names the dash act specifically.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Resolver produces plausible-but-wrong reconciliations | high | med | Tier 0/Tier 1 verification loop; marker/build validation before candidate commit; escalation duty in the charter | a verified-green join that was semantically wrong |
| A machine rung's resolution is wrong but builds and passes (Risk R02) | high | med | [P10] audit duty; report must account for every resolved path; at0426 drives it | a wholesale-discard reaching base |
| Tier 1 cost (serialized app-test launches) makes joins feel slow | med | med | Tier 1 only on the claimed-done candidate ([P09]); Tier 0 is seconds; face streams progress | user reports join latency |
| Rename sweep breaks `@covers` resolution or test selection | med | low | `just app-test-covers-check` in the rename step's checkpoint; renames move `@covers` lines with the files | covers-check red |
| Tier 1 queues on the apptest gate its own fixture holds | high | high without [P11] | fixture repos declare no `verify_tier1` ([P11]); runner has a hard timeout | any join `stuck` on a gate wait |
| Verification assumes a tugtool-shaped project | high | high without [P11] | commands are per-project config ([P11]); absent config is a stated green, not a failure | a non-tugtool project shows red/stuck verification |
| The multi-turn spawn protocol proves flaky with the real model | med | med | Spec S04's violations degrade to `stuck` with the tail quoted — never silence, never a guess; the stub proves the orchestrator half independently | repeated `stuck` on protocol violations in live use |
| Workshop worktree leaks on crash | med | med | The workshop is per-dash and stably named (`.tug/workshops/<name>`), so a crash leaves a *reusable* worktree rather than a stray one — the next resolve resets it; discard/join sweep it with `git worktree remove --force` + branch delete, mirroring the Justfile sweep hardening | a `tugworkshop/*` ref outliving its dash |
| A project that does not gitignore `.tug/` sees the workshop as base dirt | med | low | Workshop creation adds `.tug/` to `.git/info/exclude` when the working ignore set does not already cover it ([P03]) | workshop paths appearing in the Changes card or blocking a join preflight |
| Escalation dead-ends (frame dropped, nobody answers) | high | low | The resolver's wait has a deadline; expiry → `stuck` with the question preserved in the report; CONTROL drop is survivable because the join board recompute re-renders the pending question from durable state | a join stuck silently |

**Risk R02: A machine rung's resolution is wrong in a way no check can see** {#r02-rung-resolution-invisible}

- **Risk:** The 2026-08-15 class: a stale rerere entry keeps one side wholesale and discards the other. Build green, tests green, behavior broken. Human review was the gate that caught it; [P07] retires that gate.
- **Mitigation:** [P10] — the resolver audits every rung-resolved file against the intent corpus and must account for each in its report; at0426 is rewritten to drive exactly this scenario.
- **Residual risk:** the audit is a model judgment, so a subtle wholesale-discard can still pass. The honest position: this round moves the audit from a human who was shown a diff with no intent context to an agent holding the plan, the draft, the round subjects, and both sides' motion — better-informed, not infallible.

**Risk R01: The resolver edits outside the workshop** {#r01-resolver-containment}

- **Risk:** A tool-capable spawn with a wrong cwd or an absolute path writes into the user's checkout.
- **Mitigation:** cwd is the workshop worktree; the charter names the boundary; the orchestrator diffs the workshop only — writes elsewhere are never read back; the stub-driven app-test asserts the base and dash checkouts are byte-identical after a resolve.
- **Residual risk:** a hostile model could still write stray files elsewhere on disk; accepted — the same trust already extended to the session's own Claude.

---

### Design Decisions {#design-decisions}

#### [P01] The dash verb is join; "land" survives only as the shared commit|join umbrella (DECIDED) {#p01-join-vocabulary}

**Decision:** Everywhere "land/landing" names the **dash act**, the word becomes **join** — UI strings ("Ready to join"), dash-lane file and symbol names (`session-changes-dash-landing.tsx` → `session-changes-dash-join.tsx`), test names (`at0436-join-land-press` → `at0436-join-press`), and dash-lane prose in tuglaws, tugplug skill texts, and roadmap docs. The shared composer substrate — `landing-mode.ts`, `LandingKind = "commit" | "join"`, `LandOutcome`, `landing-press-receipt.ts`, `landing-notice.ts`, `landing-notice-controller.tsx` — **keeps its name**: "land" is the umbrella over the two composer modes.

**Rationale:**
- User ruling 2026-08-19: dashes are joined; there is no landing process separate from joining — and, on seeing `LandingKind = "commit" | "join"`, the explicit follow-up ruling that the shared umbrella keeps "land."

**Implications:**
- The sweep is judged per use: does this occurrence mean *the dash act* (rename) or *the umbrella / the commit lane* (keep)? A mechanical global replace is wrong in both directions.
- `@covers` headers move with renamed test files; `just app-test-covers-check` guards the sweep.

#### [P02] The resolver is a per-join, tool-capable spawn under a named charter (DECIDED) {#p02-resolver-substrate}

**Decision:** A new seam trait `JoinResolverSpawner` in tugcast (sibling of `ScribeSpawner`, `tugcast/src/scribe.rs`): production spawns a headless multi-turn `claude` stream in the workshop under the Spec S04 turn protocol (which is what makes mid-run asks possible — a one-shot `-p` spawn cannot ask-and-wait); tests configure a stub command via git config `tugdash.joinresolver` speaking the same protocol (mirroring the `tugdash.mergedriver` stub seam the structured-merge rung already has).

**Rationale:**
- The SharedAgent pool's workers (`tugcast/src/shared_agent.rs`) are deliberately tool-less turn machines with 2–6 s ceilings and no filesystem; the resolver needs tools, a worktree, and minutes. Pool warmth buys nothing for a per-join job.
- [D127]'s discipline transfers whole: the charter is a fixed, reviewed instruction contract; no API accepts an arbitrary prompt.

**Implications:**
- The `tugdash.joinresolver` config command receives the charter on stdin and the workshop path as `$1`, must edit files in the workshop and print the report JSON (Spec S02) on stdout — a shell script can play any resolver behavior a test needs.
- The model is the configured scribe model (the same `model` closure `ScribeFileMerger` reads).

#### [P03] The workshop: one stable per-dash worktree where the merge is real (DECIDED) {#p03-workshop-worktree}

**Decision:** New `tugdash-core/src/workshop.rs`. The workshop is **one stable worktree per dash**, at a fixed path (`.tug/workshops/<name>`) checked out on a **stable branch in its own namespace: `tugworkshop/<name>`** — reused across every resolve and verification for that dash, reset with `git checkout -f` + `git clean -fd` (preserving ignored build outputs) rather than recreated. The namespace is load-bearing, not taste: **every dash surface enumerates dashes by globbing `refs/heads/tugdash/`** — four sites in `ops.rs` (whose list fn's own doc reads "each `tugdash/*` branch"), the changesets feed's dash-entry derivation in `tugcast/src/feeds/changeset.rs` (documented there as "derives dash entries from `refs/heads/tugdash/`"), and `agent_supervisor.rs` — so a workshop branch *inside* that namespace would render as a phantom dash row in the lane, the Lens, and `dash list` on every recompute. Outside the namespace, exclusion is by construction rather than by a filter every surface must remember. `Workshop::open_merge(repo, name)` resets it to the base head and runs `git merge --no-commit --no-ff <dash-branch>`, leaving real conflict markers and index stages; `Workshop::open_candidate(repo, name, sha)` resets it to an existing candidate for verification; `Workshop::commit(message)` writes the worktree tree as the candidate commit; `Workshop::release()` resets it and leaves it hydrated. Only dash discard/join removes it (`git worktree remove --force` + branch delete), mirroring the Justfile's sweep hardening.

**Rationale:**
- The resolver needs the whole project around a conflict, not three blobs — reconciling a renamed symbol against a new call site means reading and editing neighbors.
- Verification needs a real tree to build and test; the candidate commit alone is not a place commands can run.
- **Stability is what makes verification affordable, and it is not a nicety.** A nonce-named, per-resolve worktree would be *unbuildable and then ruinously slow*: it carries no `node_modules`, so Tier 0's `bunx tsc --noEmit` and `bunx vite build` fail outright; it carries a cold `target/`, so `cargo check` is a full dependency build every time; and — the sharpest one — a *detached* worktree's app-test slug is `detached-<sha8>` (the `Justfile` app-test recipe's `BRANCH`/`WTSLUG` derivation falls back to it), which changes with every candidate, so each Tier 1 run would land in a fresh per-worktree DerivedData tree and trigger a **full Tug.app build per candidate** (the recipe builds when the bundle is absent). A stable branch name gives a stable slug, which keeps DerivedData, `target/`, `node_modules/`, and `dist/` warm across candidates.
- Precedent: the rerere rung already runs a scratch detached worktree (`resolve.rs::rerere_rung`) — for a blob re-merge that needs no build, which is why *it* can be nonce-scratch and this cannot. The ladder's blob-based rungs 1–4 are untouched; their staged resolutions are applied into the workshop index before the resolver starts, so the agent only faces what the machines could not do (and audits what they did — [P10]).

**Implications:**
- **Hydration is an explicit step**, run once at workshop creation: the project's `[tugtool.dash].post_create` hooks (`.tugtool/config.toml` — today `bun install --cwd tugdeck`, `bun install --cwd tugcode`), plus `bun install --cwd tests/app-test` and a `vite build` for Tier 1's sake. `run_post_create` in `ops.rs` already does the hook half for dash worktrees; the workshop reuses it rather than growing a second hydration path.
- First use of a dash's workshop pays a full cold build; every later verification for that dash is incremental. The face says `verifying` for both — the cost is real and is named here so nobody reads the first one as a hang.
- Workshop paths are repo-universe citizens: created via the same git the dash verbs use, swept on discard/join, and sited at `.tug/workshops/<name>` beside the existing dash worktree home (`.tug/worktrees/<name>`, `ops.rs`'s `[P13]` home) so one ignore rule covers both. The `tugworkshop/<name>` branch is never a join target, and because it lives outside `refs/heads/tugdash/` it cannot appear on any dash surface — the exclusion needs no filter.
- **Invisibility to the Changes card is inherited, not free.** `base_working_set_dirt` (`ops.rs`) lists untracked paths with `--exclude-standard`, and its own comment states the dependency: that is "what keeps the dash worktrees under `.tug/` out of the untracked half — … wrong in one that does not [ignore its worktree home]". Tugtool ignores `.tug/` (`.gitignore`), but a user's project need not, and the workshop raises the stakes from one worktree to a second checkout plus its build outputs — enough untracked dirt to swamp the card and to trip a join preflight. **Workshop creation therefore ensures the ignore itself**, appending `.tug/` to `.git/info/exclude` when the effective ignore set does not already cover it (checked with `git check-ignore`). `info/exclude` is the right instrument: per-clone, untracked, and never an edit to the user's committed `.gitignore`.
- Tier 1 sets `TUG_REPO_UNIVERSE` to the workshop explicitly rather than trusting cwd (Round 1's seam).

#### [P04] Verification is a server-owned fact anchored to `(base_sha, candidate_sha)` (DECIDED) {#p04-verification-fact}

**Decision:** `DashJoinState` (`tugcast-core/src/types.rs`) gains `verification: Option<DashJoinVerification>` — `{ tier0: "unrun"|"running"|"green"|"red", tier1: same, failures: Vec<String>, base_sha, candidate_sha }`. The result persists as a branch-config fact `branch.tugdash/<name>.tugjoinverified` = `<base_sha>:<candidate_sha>:<tier0>:<tier1>` (the same config-fact pattern as the candidate ref and the old reviewed mark), so it survives restart; the `JoinBoard` reads it on recompute and drops it when either head moves — exactly the join-truth cacheability split: SHA-anchored facts cache, dirt-answering facts never do.

**Rationale:**
- Verification is a pure function of two trees; caching by the head pair is sound, and a stale fact self-demotes the way a stale candidate already does.

**Implications:**
- What tier 0 *runs* is the project's declared command set ([P11]); for tugtool that is `cargo check` scoped to touched crates when `tugrust/` is touched and `bunx tsc --noEmit` + `bunx vite build` when `tugdeck/` is touched (touched = `git diff --name-only base_sha..candidate_sha`). `verify.rs` owns running and recording, never the commands themselves.
- Failures carry the failing command or test file names — the face's refusal must name them.

#### [P05] Verification's first audience is the resolver (DECIDED) {#p05-agent-feedback-loop}

**Decision:** Tier 0 runs after every resolver pass; red loops the resolver with the failure text appended to its next turn's input, up to a bounded iteration count (3), then `stuck` with the reason. Tier 1 runs once, on the resolver-claimed-done (or ladder-clean) candidate ([P09]). The face renders whatever the fact says; the human is consulted only past the agent's own loop.

**Rationale:**
- A red result a machine can repair should cost a machine iteration, not human attention — this also defuses the known low quality of parts of the test corpus (a flaky red burns an iteration, not the user).

**Implications:**
- The orchestrator owns the loop; the resolver's report records each iteration's verdict so the human-facing account is honest about retries.

#### [P06] Escalation is a server question frame on the join face (DECIDED) {#p06-escalation-frame}

**Decision:** New CONTROL actions: tugcast broadcasts `changeset_join_question { project_dir, dash, request_id, question, options: [{label, description}] (2–4) }`; the card replies `changeset_join_question_answer { request_id, answer }` (an option label or free text). The pending question is also durable state on `DashJoinState` (`question: Option<DashJoinQuestion>`) so a reload re-renders it — CONTROL stays droppable, per join-truth doctrine. The join face renders it with `QuestionWizard` (`tugdeck/src/components/tugways/chrome/session-question-dialog.tsx`) — the shipped Tug component for exactly this shape, never a hand-rolled dialog. The resolver blocks on the answer with a deadline via the Spec S04 turn protocol; expiry → `stuck`, question preserved in the report.

**Rationale:**
- User ruling 2026-08-19 over the session route: a join must be resolvable when no session is mid-turn, and the session route entangles lifecycle, transcript, and model selection.
- Precedent for an out-of-turn question is the `side_question` control-request (`tugproto/src/inbound.ts`) — but that rides Claude's stdin via tugcode; this frame is tugcast↔card only, so tugcode's inbound allowlist is untouched.

**Implications:**
- The question is authored by the resolver in **intent terms** (the charter mandates it: what each side was doing, options as concrete resolutions); the face never shows a diff as a question.
- **The surface is `QuestionWizard`**, the frameless rail-and-panel question surface (2–4 options, a free-text reply path, focus already managed). `TugInlineDialog` is the primitive `QuestionWizard` is built from; composing that instead would be hand-rolling a component that already exists.
- **Reusing it requires an extraction, and the plan must budget for it.** `QuestionWizardProps` today is `{ request: ControlRequestForward; session: CodeSessionStore; onResolve?; className? }`, and the session is not decoration around the component — it is *inside* it: the wizard subscribes to `session.getSnapshot().pendingQuestion?.request_id === requestId` for its own liveness ([L02]), answers via `session.respondQuestion(requestId, { answers })`, declines via `session.respondQuestion(requestId, { response })`, and cancels via `session.popInteractive()`. A join has no `CodeSessionStore` and no `ControlRequestForward`, so "feed the wizard from the join block's `question` field" is not reachable through the current props. **Step 7 therefore lifts a host seam:** the wizard takes its questions as already-parsed `ParsedQuestion[]` (the `parseQuestions` narrowing is already an exported pure function, so the session-shaped adapter moves *out* to the caller), plus `isPending: boolean` and `onSubmit` / `onDecline` / `onCancel` callbacks. `AskUserQuestionToolBlock` supplies the session-bound adapter it effectively holds today — no behavior change on the transcript path, and its existing tests are the regression guard — while the join face supplies a join-bound one over the `changeset_join_question_answer` CONTROL action. Nothing about the rendered surface, its focus trap, or its `[A9]` state preservation changes; only who owns the transport does.
- What the face must **not** reuse is the session machinery itself — `pendingQuestion`, `handleRespondQuestion`, and `control_request_forward` belong to the conversational turn, and a join question is not one. The extraction above is what makes that separation expressible instead of aspirational.
- Free text is always available (the wizard's reply path), and is handed to the resolver verbatim — that, plus the report naming the workshop path, is the takeover story this round.

#### [P07] The human review gate retires; red gets an explicit override (DECIDED) {#p07-retire-review-gate}

**Decision:** Delete `write_reviewed` / `read_reviewed` / `reviewed_config_key` (`tugjoinreviewed`) and `DashJoinState.reviewed`; the `changeset_join_review` CONTROL action, its handler, and its client sender in `tugdeck/src/lib/changeset-join-store.ts` go with them. This is safe **only because [P10] moves the audit to the resolver** — retiring the gate without that would drop the guarantee, not relocate it. The join gate for a resolved-candidate join reads verification: green joins; red renders the failure and mounts an explicit **Join anyway** control (an override is a decision made in view of the red — never a trap, never silence); unrun renders the run control. The per-file receipts (`FileResolution`, `read_resolved_rungs`) survive as the resolver report's citation layer, rendered as the report, not as a review queue.

**Rationale:**
- The reviewable-diff framing assumed the human audits machine text decisions; the machine now verifies its own decisions against the project, which is the audit that matters ([P05]). The success bar from the brief: no breakage the project's own checks would catch may join silently — and a face that refuses with no exit violates the join-truth reachability doctrine.

**Implications:**
- `deriveJoinOutcome` (`tugdeck/src/lib/join-mode-controller.ts`) drops its reviewed input and gains verification inputs; the face test `join-resolve-face.test.ts` rewrites accordingly.

#### [P10] The resolver audits the algorithmic rungs, not just the files they left (DECIDED) {#p10-resolver-audits-rungs}

**Decision:** The resolver's job includes reviewing **every** file the ladder resolved by machine — rerere, merge-file, driver, and the per-file AI rung — against the intent corpus, not merely finishing the files the ladder left unresolved. Its report must account for each one (Spec S02), and it may reject and redo any rung's resolution. Consequently the resolver runs on **every** conflicted join, including one where the ladder reached a candidate with nothing unresolved.

**Rationale:**
- This is the guarantee `tests/app-test/at0426-dash-resolution-review.test.ts` was built to enforce, and it is the reason the human review gate existed. Its docblock records the 2026-08-15 incident precisely: *"A stale rerere entry can keep one side wholesale and discard the other — **green build, green tests**, broken at runtime."* A plan that replaces review with build-and-test verification ([P05]) and stops there would delete the gate while leaving its failure class wide open — verification, by that incident's own account, does not catch it.
- The resolver is the right auditor and the only cheap one: it is already in the workshop with both sides' content, the archaeology, and the intent corpus ([P08]) — the exact inputs a human reviewer was being asked to weigh, and the ones a build cannot weigh.
- This is what converts "the human reviews the machine" into "the agent audits the machine" rather than "nobody audits the machine," which is the difference between retiring a gate and dropping one.

**Implications:**
- `resolve_conflicts` reaching a clean candidate is no longer the end of the resolve flow — the audit pass follows ([P07]'s gate reads verification *and* a report that accounts for every resolved path).
- A resolver that cannot explain a rung's resolution must redo it or escalate ([P06]); silence about a resolved file is a report-contract violation and fails parsing (Spec S02).
- at0426 is **rewritten, not deleted**: its subject moves from "the candidate cannot land unreviewed" to "a wholesale rerere resolution against the dash's intent is caught by the audit" — the same incident, guarded at the layer that now owns it.

#### [P11] Verification commands are per-project configuration, not built-in knowledge (DECIDED) {#p11-verify-config}

**Decision:** The verification tiers run **commands the project declares** in `.tugtool/config.toml` — `[tugtool.dash].verify_tier0 = ["…", …]` and `verify_tier1 = ["…"]` — following the exact precedent of `[tugtool.dash].post_create` (read by `run_post_create` in `ops.rs` from the same `Config`). A project that declares no tier gets `green` with the note *"project declares no verification"* (the [P09] empty-selection posture). **Tugtool's own config** carries what the plan previously hardcoded: tier 0 = the scoped `cargo check` / `bunx tsc --noEmit` / `bunx vite build` set, tier 1 = the derived-selection app-test run. Commands run in the workshop with the login-PATH environment tugcast already maintains for the shell route (a GUI-launched tugcast has a minimal `PATH`; `just`, `bunx`, and `cargo` live in the login set).

**Rationale:**
- **Tug is a general tool, and the plan as devised was tugtool-shaped.** `cargo`, `bunx vite build`, and `tests/app-test/scripts/select-tests.ts` exist in *this* repository; at0441's own fixture — a scratch repo holding a text file — has none of them, and neither does any other project a user opens. A built-in verifier would have been the second "unbuildable as specified": red on every project that isn't tugtool, including this plan's own fixtures.
- **It makes the app-test gate deadlock unrepresentable.** `just app-test` serializes machine-wide behind `tugutil host gate --name apptest`. A fixture-driven join *runs inside* an app-test invocation that holds that gate; if tugcast then spawned a real Tier 1 app-test run, it would queue on the gate its own test holds — a deadlock resolved only by timeout. With [P11], fixture repos simply declare no `verify_tier1` (or a trivial command), so the corpus can exercise the whole verification machinery without ever touching the gate. Tugtool's real tier-1 command meets the gate only in live developer use, where nothing else holds it.
- Config, not code, is also what lets a project tune the exam without a tugdash-core release.

**Implications:**
- The Tier 0/Tier 1 runners (`verify.rs`, the tugcast Tier 1 handler) execute declared commands and interpret exit status; the *derivation* half of tugtool's tier 1 (the `@covers` selection over `base_sha..candidate_sha`) moves into the declared command itself (a small script or `just` recipe in this repo), keeping tugdash-core project-agnostic.
- Tier 1 commands run with `TUG_APPTEST_ASSUME=background` and a hard timeout — a scripted run must never park in a dialog or hold the join forever.
- The scratch-repo fixtures gain one line of config each, mirroring how they already configure `tugdash.mergedriver` / `tugdash.joinresolver`.
- **The two tiers get opposite fixture postures, and conflating them would break at0443.** Fixtures declare **no `verify_tier1`** (that is the gate-deadlock argument above) but a fixture that needs a red — at0443's break-the-build arc, and Step 3's red-tier0 unit — **must declare a `verify_tier0`**, because a repo declaring nothing is green-with-note by construction and could never go red. The declaration is a trivial local command (a script that greps the merged file for a sentinel and exits non-zero), so tier 0 stays seconds-cheap in a fixture and needs no toolchain.

#### [P08] The intent corpus grows: plan + base motion + both diffs (DECIDED) {#p08-intent-corpus}

**Decision:** `resolve_intent` (`tugdash-core/src/resolve.rs`) grows from *draft + round subjects* to also carry: the dash's adopted plan document when one exists (the `--plan` adoption from [D139] puts it in the dash worktree; read it from the dash branch), the base branch's own subjects since the merge base, and the two sides' name-status diffs. One composition, shared by the (kept) per-file AI rung and the resolver charter — the question "what is this dash for" has one answer.

**Rationale:**
- The existing intent string is one draft and a few subjects — not enough to adjudicate conflicting purposes. The plan is the dash's stated intent in full; the base's motion is the other side's.

**Implications:**
- Size-bounded (cap the plan at its Purpose/Overview sections if huge); composed once per resolve, passed to both consumers.

#### [P09] Tier 1 runs on the claimed-done candidate, via the derived selection (DECIDED) {#p09-tier1-scheduling}

**Decision:** Tier 1 = `bun scripts/select-tests.ts <changed paths>` (explicit-paths mode, changed = `git diff --name-only base_sha..candidate_sha`) → `just app-test <selection>` run with cwd = workshop and `TUG_APPTEST_JSON=<path>` for the verdict; triggered once per candidate when the resolver claims done (or immediately for a ladder-clean candidate), and re-runnable from a face control. Never ambient, never per-iteration.

**Rationale:**
- Every app-test launches a Tug.app instance behind a machine-wide gate; running the selection on each resolver iteration would serialize the machine into uselessness. Tier 0 is the iteration loop's instrument; Tier 1 is the candidate's exam.

**Implications:**
- An empty selection (no app-test covers the changed files) is a legitimate `green` with a note, not `unrun` — the derivation answering "nothing bears on this" is an answer.
- **The selector has two non-green exits, and the tier-1 command must answer for both.** `select-tests.ts` exits `EXIT_OVER_BUDGET` (3) emitting *no* filenames when the derived selection exceeds `MAX_SELECTED` (20), and prints a **CORE TIER ADVISED** advisory when a changed path matches `CORE_TIER_TRIGGERS` (harness files that run before any test's first assertion, which no `@covers` line can scope). A join candidate can trip either — a broad refactor for the first, a `tests/app-test/_harness/` touch for the second. In both cases the tier-1 command runs the **core tier** (bare `just app-test`, ~20 files), which is the standing answer to that advisory, and the verdict carries a note naming which exit forced it. Treating exit 3 as a failure would make a large candidate unjoinable; treating it as green would be a lie.
- **`TUG_APPTEST_ASSUME=background` is a screen-seizure guard, and it narrows the exam.** It is what stops a join from stealing the user's screen mid-verification — `background` "skips the screen-takers" — but that means every `@foreground`-tagged test in the derived selection is *skipped*, not passed. The verdict records the skipped count and the face's note says so; a tier-1 green over a selection with skipped foreground tests is reported as green-with-exclusions, never as unqualified green.

---

### Deep Dives {#deep-dives}

#### The resolve flow, end to end {#resolve-flow}

`do_changeset_join_resolve` (`tugcast/src/feeds/agent_supervisor.rs`) today: parse → guard (open project, git worktree) → build optional `ScribeFileMerger` → `spawn_blocking(resolve_conflicts)` → bump `changeset_all` → broadcast `_ok`/`_err`. This round extends the middle:

1. `resolve_conflicts` runs the ladder as today (rungs 1–4 + the kept per-file AI rung), recording which rung decided each file.
2. `Workshop::open_merge` materializes the real merge; the ladder's staged resolutions are applied into the workshop index; `changeset_join_resolve_delta` announces `rung: "resolver", status: "working"`. **This happens whether or not files remain unresolved** — a ladder-clean candidate still gets the audit pass ([P10]).
3. The resolver spawn runs the charter (Spec S01) in the workshop under the S04 turn protocol: it finishes what the rungs left, audits what they decided, may ask once (`changeset_join_question`), and its terminal turn is the report (Spec S02).
4. The orchestrator validates (no conflict markers, report parses, every resolved path accounted for), `Workshop::commit` writes the candidate, records resolved-by facts (`ResolvedBy` gains a `Resolver` variant).
5. Tier 0 — the project's declared commands ([P11]) — runs in the workshop (candidate checked out). Red → loop to 3 with the failure appended (≤3 iterations, Spec S04's re-entry) → else `stuck`. Green → persist the verification fact, trigger Tier 1 ([P09]/[P11]), broadcast `_ok`.
6. The join board recomputes; the face renders `resolving` / `question` / `verified — ready to join` / `red + Join anyway` / `stuck: <reason>` from `DashJoinState` alone.

The join itself is unchanged mechanically: `join_in` fast-forwards onto the resolved candidate as today; only its gate inputs change ([P07]).

#### What the stub resolver makes testable {#stub-testability}

The `tugdash.joinresolver` config command receives the charter on stdin and the workshop path as `$1`. Test behaviors, each a few lines of shell: resolve-and-report (write the fixed body, print a report), ask-then-resolve (print a question request, read the answer, then resolve — the orchestrator speaks a tiny line protocol with the stub over stdio, same as it would with the model spawn), break-the-build (resolve to code that fails Tier 0, proving the loop and the `stuck` path), touch-nothing (report without edits, proving marker validation refuses), audit-redo (rewrite a rung-resolved file and report `audit: "redone"`, proving the [P10] pass runs), and omit-a-path (proving report validation refuses a resolution it does not account for). This is the merge-driver stub pattern (at0441's and at0426's `stub-driver.sh`) extended one seam up.

---

### Specification {#specification}

**Spec S01: The resolver charter** {#s01-resolver-charter}

A fixed instruction document composed by tugcast (a `const` in the resolver module, reviewed like a contract — [D127]): the job (finish this merge so both sides' intents hold), the inputs (the intent corpus [P08], the conflicted file list with each side's stance, **the list of files the algorithmic rungs already resolved and which rung decided each**, the Tier 0 failure text on iterations), the **audit duty** ([P10]: check every rung-resolved file against the intent — a rerere replay can keep one side wholesale and discard the other while still building and passing tests, so a resolution that does not serve both sides' intents must be redone or escalated), the boundary (edit only inside the workshop; never run git commands that move refs; never touch paths outside it), the escalation duty (when the two intents genuinely conflict, ask **one** question phrased as what each side was trying to do, 2–4 concrete resolution options, via the question protocol — never resolve a true intent conflict by guessing), and the output contract (Spec S02). No caller-supplied prose is ever appended.

**Spec S02: The resolver report** {#s02-resolver-report}

The spawn's final stdout is one JSON document: `{ files: [{path, resolved_by, what_each_side_did, reconciliation, audit: "kept"|"redone"}], iterations: [{tier0: "green"|"red", detail?}], question?: {question, answer}, notes }`. **Every path in the candidate's resolution set must appear** — the ones the resolver finished and the ones it audited and kept ([P10]); a report that omits a resolved path fails validation the same way a marker-bearing file does. Stored with the candidate (a git note or config-pointed blob — implementer's choice, stated in code), surfaced on `DashJoinState` as `report: Option<...>`, rendered by the face where the review panel used to be. Parse failure = resolver failure (`stuck`), never a silent fallback.

**Spec S03: Wire changes** {#s03-wire-changes}

- `DashJoinState` gains `verification`, `question`, `report`; loses `reviewed`. Mirrored field-for-field in `DashJoinStateWire` (`tugdeck/src/lib/changeset-types.ts`) with fixture parity tests as join-truth established.
- New CONTROL actions: `changeset_join_question` (server→card), `changeset_join_question_answer` (card→server), `changeset_join_verify` (card→server: run/re-run Tier 1). `changeset_join_review` is deleted.
- `changeset_join_resolve_delta` gains `rung: "resolver"` statuses: `working`, `iterating`, `asking`, `verifying`.

**Spec S04: The resolver turn protocol — how a headless spawn asks and answers** {#s04-turn-protocol}

The one-shot spawn the scribe uses (`ClaudeScribeSpawner`: `claude -p`, prompt on stdin, result out) cannot ask-and-wait, so the resolver spawn is a **multi-turn stream**. This shape already ships and is the model to copy, not to invent: `ClaudeAgentWorkerSpawner` (`tugcast/src/shared_agent.rs`) runs a persistent streaming-input `claude` per worker, and `drive_worker` is the working reference for "write each turn as a user message, read stdout to that turn's `result` frame" over one stdio pipe. Three details are load-bearing and are taken from it rather than assumed:

- **Build the command with `claude_auth::claude_command`** (`tugcast/src/feeds/claude_auth.rs`), never a bare `Command::new("claude")` — it is the crate-wide wrapper both existing spawners use, and it is what supplies the resolved binary and auth environment a GUI-launched tugcast does not inherit.
- **`--verbose` is mandatory alongside `--output-format stream-json` under `-p`** — both shipped spawners pass it; without it the stream is not emitted in the form the parser expects.
- **`--strict-mcp-config` with no `--mcp-config`**, so the resolver loads no project-scoped MCP servers — the shared-agent comment records this as verified behavior, and a resolver reaching into a project's MCP surface is strictly outside its charter.

So: `claude_command(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", <scribe model>, "--strict-mcp-config", "--permission-mode", "acceptEdits", "--allowedTools", <read-and-edit set>])` — no Bash, because verification is the orchestrator's job ([P05]) — with cwd = workshop and the charter as the first user message. The charter (Spec S01) defines exactly two terminal message shapes, and the orchestrator reads the assistant stream for them:

- **The ask:** an assistant turn whose entire text is one JSON object `{"ask": {"question": …, "options": [{label, description}] (2–4)}}`. The orchestrator raises `changeset_join_question`, waits (deadline), and sends the answer back as the next user message; the spawn stays alive across the wait. At most one ask per resolve; a second is a charter violation → `stuck`.
- **The report:** an assistant turn whose entire text is the Spec S02 JSON — the resolve's terminal turn.

Anything else in a terminal position (prose, a fenced block, a half-object) is a protocol violation → `stuck` with the tail quoted, never a guess. The `tugdash.joinresolver` stub speaks the same two shapes over plain stdio (JSON lines out, answer line in), so orchestrator tests and app-tests exercise the identical parse-and-wait path the production spawn uses; only the transport differs, behind `JoinResolverSpawner`. Tier-0-failure re-entry ([P05]) is one more user message on the same live spawn when it is still running, or a fresh spawn re-charted with the failure text when it is not — both arrive as the same charter-defined message kind, so the resolver cannot tell the difference and the orchestrator need not care.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| join verification + report + pending question | server fact via changesets feed | existing changeset store + `useSyncExternalStore` | [L02] |
| question dialog option selection (pre-submit) | local-data | `useState` inside the face component | [L24] |
| dialog open/closed pose, red/green tinting | appearance | `data-*` attributes + CSS | [L06] |
| answer submission | action | CONTROL send via the changes service, outcome by type ([L31] — no void returns) | [L31] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugdash-core/src/workshop.rs` | Workshop worktree lifecycle ([P03]) |
| `tugrust/crates/tugdash-core/src/verify.rs` | Tier 0 runner + verification fact persistence ([P04]) |
| `tugrust/crates/tugcast/src/feeds/join_resolver.rs` | `JoinResolverSpawner` seam, claude spawn, stub-command spawn, charter, report parsing ([P02], S01, S02) |
| `tests/app-test/at0442-join-escalation.test.ts` | Escalation fixture (stub resolver asks; answer round-trips) |
| `tests/app-test/at0443-join-verification-red.test.ts` | Red Tier 0 → face names failure → Join anyway override |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `Workshop` | struct | `tugdash-core/src/workshop.rs` | `open_merge` / `open_candidate` / `commit` / `release`, hydration + sweep hooks |
| `ResolvedBy::Resolver` | enum variant | `tugdash-core/src/resolve.rs` | the agent-finished rung |
| `resolve_intent` | fn (modify) | `tugdash-core/src/resolve.rs` | grows plan + base motion + diffs ([P08]) |
| `write_reviewed` / `read_reviewed` / `reviewed_config_key` | fn (delete) | `tugdash-core/src/resolve.rs` | [P07] |
| `verification_config_key` / `write_verification` / `read_verification` | fn | `tugdash-core/src/verify.rs` | `(base_sha, candidate_sha)`-anchored fact |
| `DashJoinState.{verification, question, report}` / `-reviewed` | fields | `tugcast-core/src/types.rs` | Spec S03 |
| `JoinResolverSpawner` | trait | `tugcast/src/feeds/join_resolver.rs` | production + `tugdash.joinresolver` stub |
| `do_changeset_join_resolve` | fn (modify) | `tugcast/src/feeds/agent_supervisor.rs` | orchestration (#resolve-flow) |
| `deriveJoinOutcome` | fn (modify) | `tugdeck/src/lib/join-mode-controller.ts` | verification-aware gate, reviewed input dropped |
| `changeset_join_review` sender | fn (delete) | `tugdeck/src/lib/changeset-join-store.ts` | the client half of the retired gate; the same store gains the question-answer and verify sends |
| `Workshop` hydration | fn | `tugdash-core/src/workshop.rs` | reuses `run_post_create` (`ops.rs`); no second hydration path |
| `verify_tier0` / `verify_tier1` | config fields | `tugutil-core` `Config` (`[tugtool.dash]`) | the [P11] seam, beside `post_create`; tugtool's own values in `.tugtool/config.toml` |
| tier-1 derivation script | script | this repo (pointed at by tugtool's `verify_tier1`) | selection via `select-tests.ts` over `base_sha..candidate_sha`, run via `just app-test` + `TUG_APPTEST_JSON` |
| `QuestionWizardProps` | interface (modify) | `tugdeck/src/components/tugways/chrome/session-question-dialog.tsx` | host seam: `questions`/`isPending`/`onSubmit`/`onDecline`/`onCancel` replace `request`+`session` ([P06]) |
| `AskUserQuestionToolBlock` | component (modify) | `tugdeck/src/components/tugways/cards/blocks/ask-user-question-tool-block.tsx` | takes over `parseQuestions` + the `respondQuestion`/`popInteractive` adapter; its tests are the no-regression proof |
| `session-changes-dash-join.tsx` | file (rename+rework) | `tugdeck/src/components/tugways/cards/session-changes/` | from `…-dash-landing.tsx` ([P01]); new states |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md`: propose (in the join commit body, for the user to accept) the agent-finished-join decision; sweep dash-lane "landing" prose per [P01].
- [ ] `tuglaws/dash-work-doctrine.md` + tugplug skill texts (`dash-implement`, `dash-join`): join vocabulary; the stop-before-join obligation unchanged.
- [ ] `roadmap/close-dash-join-gaps.md`: correct its terminology note to the refined ruling (umbrella "land" survives); mark Round 2 in progress.
- [ ] `tests/app-test/README.md`: the stub resolver seam, the `verify_tier0`/`verify_tier1` config, and the new fixtures.
- [ ] `.tugtool/config.toml` schema note where `post_create` is documented: the two `verify_*` fields and the no-declaration posture ([P11]).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Workshop lifecycle, verification fact read/write/demotion, charter composition, report parsing, gate derivation | tugdash-core, tugcast, join-mode-controller |
| **Integration (Rust)** | Orchestration with a scripted `JoinResolverSpawner` fake: resolve, iterate-on-red, ask, stuck | `agent_supervisor` / `join_resolver` tests |
| **App-test** | The pressed arcs: at0441 extension, at0442 escalation, at0443 red override | stub resolver via `tugdash.joinresolver` |
| **Contract** | `DashJoinState` ↔ `DashJoinStateWire` fixture parity | the join-truth fixture pattern |

#### What stays out of tests {#test-non-goals}

- Live-model resolver behavior — real-claude runs are on-demand only; the corpus proves the machinery, not the model.
- Prose quality of reports/questions — never assert model prose (the scripted-spawner rule the scribe tests already follow).
- Pixel or animation assertions on the face — banned shapes; states are asserted via `data-*` and text.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The dash act is named join | done | `0bf12145a` |
| #step-2 | The workshop worktree | done | `f01614f06` |
| #step-3 | Verification facts and the Tier 0 runner | done | `5519ffda9` |
| #step-4 | Tier 1: the derived selection exam | done | `a4cd8772e` |
| #step-5 | The resolver seam and charter | done | `f9bd8df4d` |
| #step-6 | Resolver orchestration in the resolve flow | done | `f9bd8df4d` |
| #step-7 | The escalation question frame | done | `32ec49e71` |
| #step-8 | The join face: new states, review gate retired | done | `e9a468c88` |
| #step-9 | The pressed arcs: at0441 extension + new fixtures | done | `e9a468c88` |
| #step-10 | Integration checkpoint and documentation sync | done | `8762e2f0e` |

#### Step 1: The dash act is named join {#step-1}

**Commit:** `join(vocabulary): the dash act is named join everywhere; the commit|join umbrella keeps land`

**References:** [P01] join vocabulary, [Q03], (#success-criteria)

**Artifacts:** renamed `session-changes-dash-landing.tsx` → `session-changes-dash-join.tsx`, with its `.css` pair ([L19]) **and its unit test** `__tests__/session-changes-dash-landing.test.ts`; renamed `at0436-join-land-press.test.ts` → `at0436-join-press.test.ts`, `at0425-dash-conflicted-landing.test.ts` → `at0425-dash-conflicted-join.test.ts`, and `at0435-landing-refusal-speaks.test.ts` → `at0435-join-refusal-speaks.test.ts`; `@covers` targets repo-wide re-pointed; dash-lane strings and prose swept.

**Tasks:**
- [ ] Sweep tugdeck dash-lane files: readiness strings ("Ready to land" → "Ready to join"), the dash-landing component (file, `.css` pair per [L19], symbols, `data-slot` values), dash-lane comments. Leave `landing-mode.ts`, `LandingKind`, `LandOutcome`, `landing-press-receipt.ts`, `landing-notice*` untouched ([P01]).
- [ ] **Re-point every `@covers` line naming a renamed file.** `session-changes-dash-landing.tsx` is named by **seven** app-tests — at0417, at0418, at0425, at0426, at0435, at0436, at0441 — and `app-test-covers-check` fails on a `@covers` path that no longer resolves, so the rename is only complete when all seven move with it. Grep `@covers` for the old paths, not just the renamed files' own headers. (at0435 is the one round 1 missed; its docblock — "an otherwise landable dash", "the dash-join dead press" — puts it squarely on the dash act, so it is both a `@covers` holder and a rename.)
- [ ] Re-point the non-test importers of the renamed component: `session-card.tsx`, `session-changes-dash-lane.tsx`, `session-changes-view.tsx`, `join-mode-controller.ts`, and `lib/__tests__/join-resolve-face.test.ts`.
- [ ] Sweep Rust dash-lane prose (comments/docstrings in `ops.rs`, `resolve.rs`, `join_board.rs`) where "landing" means the dash act; identifiers already say join.
- [ ] Sweep `tuglaws/`, `tugplug/` skill texts, `tests/app-test/README.md`, and roadmap prose per the same per-use judgment.
- [ ] Rename the three test files whose own names carry the dash act (at0425, at0435, at0436), headers intact.

**Tests:**
- [ ] Existing suites unchanged in meaning; renamed test files still selected and every `@covers` path still resolves (`just app-test-covers-check`).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` green; tugdeck `bun test`, `bunx vite build`, `bunx tsc --noEmit` green
- [ ] `just app-test-covers-check` green; `just app-test-changed` green

---

#### Step 2: The workshop worktree {#step-2}

**Depends on:** #step-1

**Commit:** `join(workshop): one stable per-dash worktree where the merge is real`

**References:** [P03] workshop worktree, (#resolve-flow), Risk R01

**Artifacts:** `tugdash-core/src/workshop.rs` with lifecycle + sweep hooks.

**Tasks:**
- [ ] Implement `Workshop::open_merge` (reset to base head + `git merge --no-commit --no-ff`, ladder stages applied into the index), `open_candidate`, `commit`, `release`; one stable worktree per dash at `.tug/workshops/<name>` on branch `tugworkshop/<name>` — its own namespace, outside the `refs/heads/tugdash/` glob every dash surface enumerates ([P03]).
- [ ] Hydrate on creation by reusing `run_post_create` (`ops.rs`) for the project's `[tugtool.dash].post_create` hooks, plus `bun install --cwd tests/app-test` and a `vite build`; reset between uses with `git checkout -f` + `git clean -fd` so ignored build outputs (`target/`, `node_modules/`, `dist/`) survive.
- [ ] Ensure the ignore the invisibility claim rests on ([P03]): if `git check-ignore` says the effective ignore set does not cover `.tug/`, append it to `.git/info/exclude` at workshop creation — per-clone, untracked, never a write to the user's committed `.gitignore`.
- [ ] Wire sweeps: dash discard and a completed join remove the workshop worktree and its `tugworkshop/<name>` branch; a resolve never does (the cache is the point).

**Tests:**
- [ ] Unit: open_merge leaves real markers + stages; commit produces a tree equal to the worktree; reset restores a clean tree while leaving ignored build outputs in place; discard removes worktree + branch; base and dash checkouts untouched throughout.
- [ ] Unit: in a repo whose `.gitignore` does **not** cover `.tug/`, creating a workshop leaves the base working set free of workshop paths (the `base_working_set_dirt` reading) — the `info/exclude` guard, pinned.
- [ ] Unit: the workshop's branch name yields a stable app-test slug (`tugworkshop/<name>`, never `detached-<sha>`) — the property Tier 1's warm DerivedData depends on — and `dash list` / the join board never surface a `tugworkshop/*` ref as a dash ([P03]).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core` green

---

#### Step 3: Verification facts and the Tier 0 runner {#step-3}

**Depends on:** #step-2

**Commit:** `join(verify): the joined tree's build verdict is a server-owned fact`

**References:** [P04] verification fact, [P05] agent loop, Spec S03, (#p09-tier1-scheduling)

**Artifacts:** `tugdash-core/src/verify.rs`; `DashJoinState.verification`; JoinBoard integration.

**Tasks:**
- [ ] Tier 0 runner: execute the project's `[tugtool.dash].verify_tier0` commands ([P11]) in an `open_candidate` workshop with the login-PATH environment; no declared commands → `green` with the no-verification note.
- [ ] Add tugtool's own `verify_tier0` declaration to `.tugtool/config.toml` (touched-surface-scoped `cargo check` / `bunx tsc --noEmit` / `bunx vite build`, as a repo script the config points at).
- [ ] Persist as `branch.tugdash/<name>.tugjoinverified` (`<base_sha>:<candidate_sha>:<tier0>:<tier1>`); JoinBoard reads it on recompute, drops it when a head moves (the stale-candidate demotion pattern).
- [ ] `DashJoinState.verification` + wire mirror + fixture parity.

**Tests:**
- [ ] Unit: fact round-trip; head movement demotes; a fixture repo with a deliberately broken merged build yields `tier0: red` with the failing command named.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` green; tugdeck `bun test` green (wire parity)

---

#### Step 4: Tier 1 — the derived selection exam {#step-4}

**Depends on:** #step-3

**Commit:** `join(verify): the @covers-derived selection is the candidate's exam`

**References:** [P09] tier1 scheduling, [P11] verify config, [P04], (#dependencies)

**Artifacts:** Tier 1 runner in tugcast; `changeset_join_verify` CONTROL action; tugtool's tier-1 script + config declaration.

**Tasks:**
- [ ] Runner: execute the project's `[tugtool.dash].verify_tier1` command ([P11]) with cwd = workshop, `TUG_REPO_UNIVERSE` = workshop, `TUG_APPTEST_ASSUME=background`, the login-PATH environment, and a hard timeout; no declared command → `green` with the no-verification note.
- [ ] Tugtool's tier-1 script (this repo, pointed at by its config): derive the selection via `bun scripts/select-tests.ts <changed paths>` from the `base_sha..candidate_sha` name-list (empty selection = green-with-note, [P09]), run `just app-test <selection>` with `TUG_APPTEST_JSON` for the verdict.
- [ ] The script answers the selector's two non-green exits ([P09]): exit `3` (`EXIT_OVER_BUDGET`, >20 files, no filenames emitted) and a **CORE TIER ADVISED** advisory both fall back to the bare core tier (`just app-test`), with the forcing reason recorded in the verdict note. Neither is a failure and neither is an unqualified green.
- [ ] The verdict records tests skipped as `@foreground` under `TUG_APPTEST_ASSUME=background` ([P09]) so tier 1 reports green-with-exclusions rather than overstating its coverage.
- [ ] `changeset_join_verify` handler: run/re-run for the current candidate; `running` state broadcast via the join board; refuses with a named reason when no candidate stands.
- [ ] State in the step's code comments why fixtures never meet the apptest gate: their repos declare no `verify_tier1` ([P11]) — a real Tier 1 inside an app-test run would queue on the gate that run holds.

**Tests:**
- [ ] Unit: verdict parsing from a declared command's `TUG_APPTEST_JSON`-shaped output (green, red-with-files); the no-declaration and empty-selection postures.
- [ ] Integration: the handler refuses when no candidate stands; records the fact when one does (the declared command faked with a stub script — no real app-test spawn inside a test).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` green

---

#### Step 5: The resolver seam and charter {#step-5}

**Depends on:** #step-2

**Commit:** `join(resolver): a charter-governed, tool-capable spawn finishes the merge`

**References:** [P02] resolver substrate, [P08] intent corpus, [P10] audit duty, Spec S01, Spec S02, Spec S04, [Q01], Risk R01, Risk R02

**Artifacts:** `tugcast/src/feeds/join_resolver.rs`; extended `resolve_intent`.

**Tasks:**
- [ ] `JoinResolverSpawner` trait; production spawn per Spec S04 (multi-turn stream-json, `--allowedTools` read-and-edit set, no Bash, cwd = workshop, scribe model); stub spawn from `tugdash.joinresolver` config (charter on stdin, workshop as `$1`, the same S04 message shapes over plain stdio).
- [ ] The charter const (Spec S01) — including the audit duty and the rung-resolved file list ([P10]) — and report parsing (Spec S02); parse failure → resolver failure, never a fallback.
- [ ] Report validation rejects a report that omits any path in the candidate's resolution set ([P10]).
- [ ] Extend `resolve_intent` per [P08]; both the per-file AI rung and the charter consume the one composition.

**Tests:**
- [ ] Unit: charter composition carries plan/base-motion/diffs *and* names every rung-resolved file with its rung; report parse accepts the contract, rejects prose, and rejects a report missing a resolved path.
- [ ] Unit: stub spawner round-trips a scripted resolve; the S04 stream parser accepts the two terminal shapes and refuses prose or partial-object tails; a second ask in one resolve is refused.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green

---

#### Step 6: Resolver orchestration in the resolve flow {#step-6}

**Depends on:** #step-3, #step-5

**Commit:** `join(resolver): the resolve flow finishes conflicts through the workshop and verifies its work`

**References:** (#resolve-flow), [P05] agent loop, [P07], Spec S03, Risk R01

**Artifacts:** extended `do_changeset_join_resolve`; `ResolvedBy::Resolver`; resolver progress deltas.

**Tasks:**
- [ ] Implement the #resolve-flow sequence: ladder → workshop → resolver → validate (marker-free, report parsed, every resolved path accounted for) → candidate commit → Tier 0 loop (≤3) → claimed-done → Tier 1 trigger → facts + broadcast; `stuck` with reason on every failure arm (no silent arm — [L31] discipline server-side).
- [ ] The resolver runs on **every** conflicted join, including one the ladder resolved completely — the audit pass ([P10]) is not conditional on leftovers.
- [ ] Deltas: `rung: "resolver"` with `working|iterating|asking|verifying`.
- [ ] The base/dash checkout containment assertion (Risk R01) in the integration test.

**Tests:**
- [ ] Integration (scripted spawner): clean resolve produces a candidate + green tier0; break-the-build script iterates then sticks; touch-nothing script is refused by marker validation; a ladder-clean conflict still invokes the resolver for the audit pass ([P10]); checkouts byte-identical throughout (Risk R01).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` green

---

#### Step 7: The escalation question frame {#step-7}

**Depends on:** #step-6

**Commit:** `join(escalation): the resolver's intent question reaches the join face and the answer returns`

**References:** [P06] escalation frame, [Q02], Spec S03, (#state-zone-mapping)

**Artifacts:** `changeset_join_question` / `changeset_join_question_answer` actions; `DashJoinState.question`; `QuestionWizard`'s host seam; the join face's question surface.

**Tasks:**
- [ ] Server: question raised by the resolver blocks it on a deadline; question stored on join state (reload-safe); answer resumes; expiry → `stuck` with the question in the report.
- [ ] **Lift `QuestionWizard`'s host seam ([P06])** — props become `questions: ParsedQuestion[]`, `isPending: boolean`, and `onSubmit`/`onDecline`/`onCancel`, replacing the `request`/`session` pair the component reads `pendingQuestion`, `respondQuestion`, and `popInteractive` through today. Move the `parseQuestions(request)` call and the session-store adapter up into `AskUserQuestionToolBlock`, whose existing tests must stay green unchanged — that is the proof the transcript path did not move.
- [ ] Client: changeset store carries the question ([L02]); the join face mounts the seamed `QuestionWizard` with 2–4 options + free text; answer sends the CONTROL action with a typed outcome ([L31]).

**Tests:**
- [ ] Integration (Rust): ask-then-resolve stub round-trips; expiry sticks with reason.
- [ ] tugdeck unit: store carries/clears the question from feed frames; controller submits and reports refusals by type; the existing `AskUserQuestionToolBlock` / question-dialog suites pass unmodified across the seam lift.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` green; tugdeck `bun test`, `bunx vite build` green

---

#### Step 8: The join face — new states, review gate retired {#step-8}

**Depends on:** #step-7

**Commit:** `join(face): resolving, question, verified, red-with-override — and the diff review is gone`

**References:** [P07] retire review gate, [P05], Spec S02, Spec S03, (#state-zone-mapping)

**Artifacts:** reworked `session-changes-dash-join.tsx`; `deriveJoinOutcome` on verification; deletions of the review path.

**Tasks:**
- [ ] Delete `write_reviewed`/`read_reviewed`/`reviewed_config_key`, `DashJoinState.reviewed`, `changeset_join_review` end to end: the handler and its parse/err helpers in `agent_supervisor.rs`, and the client sender in `tugdeck/src/lib/changeset-join-store.ts` with its store test.
- [ ] Render the resolver report where the review panel stood (the `…-review` / `…-reviewed` `data-slot`s retire with it).
- [ ] `deriveJoinOutcome`: green joins; red names failures and mounts **Join anyway**; unrun mounts the verify control; every state names a mounted control or a reason in time (join-truth reachability, [L31]).
- [ ] **Repair the fixtures this deletion breaks, in this step.** at0417, at0418, at0425 (renamed), at0426, at0435 (renamed), at0436 (renamed), and at0441 press or assert the review controls; leaving them for a later step would ship a knowingly red corpus across a commit boundary. at0426's rewrite as the audit fixture belongs to #step-9 (it needs the resolver stub) — here it is reduced to its still-true beats or marked skipped with the follow-on named in one line.

**Tests:**
- [ ] `join-resolve-face.test.ts` rewritten for the new states; grep-level absence of the reviewed path.
- [ ] `changeset-join-store.test.ts` loses its `changeset_join_review` case and gains the question/verify sends.

**Checkpoint:**
- [ ] tugdeck `bun test`, `bunx tsc --noEmit`, `bunx vite build` green; `cd tugrust && cargo nextest run` green
- [ ] `grep -rn "tugjoinreviewed" tugrust tugdeck` exits 1
- [ ] `just app-test at0417-join-mode.test.ts at0418-join-outcomes.test.ts at0425-dash-conflicted-join.test.ts at0435-join-refusal-speaks.test.ts at0436-join-press.test.ts` green

---

#### Step 9: The pressed arcs — at0441 extension and the new fixtures {#step-9}

**Depends on:** #step-8, #step-4

**Commit:** `join(arc): conflicted → agent-resolved → verified → joined, pressed end to end`

**References:** (#stub-testability), [P02], [P06], [P07], (#success-criteria)

**Artifacts:** extended `at0441-join-arc-end-to-end.test.ts`; rewritten `at0426-dash-resolution-review.test.ts` → `at0426-dash-resolution-audit.test.ts`; new `at0442-join-escalation.test.ts`, `at0443-join-verification-red.test.ts` (all with `@covers`).

**Tasks:**
- [ ] at0441: replace the rung-4 stub with the resolver stub (`tugdash.joinresolver`); assert the arc conflicted → resolver-resolved → tier0 green → joined, report rendered, teardown clean.
- [ ] at0426 **rewritten, not deleted** ([P10]): keep its fixture — the wholesale rerere/driver resolution that builds and passes — and change its subject from "the candidate cannot land unreviewed" to "the audit catches a resolution that discards one side's intent". A resolver stub that reports `audit: "redone"` for the rung-resolved path proves the pass runs and is accounted for; a stub that omits the path proves validation refuses. This keeps the 2026-08-15 incident guarded and avoids a test that merely asserts removed UI stays removed.
- [ ] at0442: ask-then-resolve stub; assert the question renders on the face via `QuestionWizard`, an option answers it, the resolver finishes, join completes.
- [ ] at0443: a break-the-build stub that never repairs (the iteration budget stays 3 — no test-only knob), over a fixture repo that **declares a trivial `verify_tier0`** and no `verify_tier1` ([P11]) — the sentinel-grep command is what lets the tier go red at all, and the absent tier 1 is what keeps the run off the apptest gate it is itself holding. Assert the loop exhausts, red names the failing command, and **Join anyway** joins past it.

**Tests:**
- [ ] The four app-tests themselves; `just app-test-covers-check` green over the new and re-pointed headers.

**Checkpoint:**
- [ ] `just app-test at0441-join-arc-end-to-end.test.ts at0426-dash-resolution-audit.test.ts at0442-join-escalation.test.ts at0443-join-verification-red.test.ts` green

---

#### Step 10: Integration checkpoint and documentation sync {#step-10}

**Depends on:** #step-9

**Commit:** `join(docs): doctrine, skills, and the brief speak the agent-finished join`

**References:** (#documentation-plan), [P01], (#exit-criteria)

**Tasks:**
- [ ] Documentation plan items (tuglaws sweep + proposal, tugplug texts, brief correction, app-test README).
- [ ] Full verification pass across the workspace.

**Tests:**
- [ ] `just app-test-changed` for the branch's whole diff (derive from `git diff --name-only main...HEAD` through select-tests explicit paths if the working diff is clean).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` green; tugdeck `bun test`, `bunx tsc --noEmit`, `bunx vite build` green
- [ ] `just app-test-covers-check` green; the branch-derived app-test selection green

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A conflicted dash join that an agent finishes — resolved from intent in a workshop worktree, verified against the joined project's own checks, escalated only as an intent question, reported in prose — behind a join face whose vocabulary and gates match: join is the verb, verification is the gate, and no diff is ever the human's job.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] at0426/at0441/at0442/at0443 green (the pressed arcs: audit, resolve, escalate, override).
- [ ] The reviewed gate absent from the tree (grep exits 1).
- [ ] Dash-lane vocabulary is join; the umbrella substrate untouched ([P01]).
- [ ] `cargo nextest run` + tugdeck `bun test` + `bunx tsc --noEmit` + `bunx vite build` + `just app-test-covers-check` green.

**Acceptance tests:**
- [ ] `just app-test at0441-join-arc-end-to-end.test.ts at0426-dash-resolution-audit.test.ts at0442-join-escalation.test.ts at0443-join-verification-red.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap-follow-ons}

- [ ] Test-quality round: cull non-falsifiable and pixel-measuring app-tests (raises Tier 1's signal).
- [ ] Live-model resolver evaluation harness (the `tests/model-eval` pattern), on-demand.
- [ ] Takeover mode: open the workshop as a project from the stuck state.

| Checkpoint | Verification |
|------------|--------------|
| The arc, pressed | the four acceptance app-tests |
| No silent arm in the resolve flow | the scripted-spawner integration suite |
| Vocabulary | grep discipline in #step-1 and #step-8 checkpoints |
