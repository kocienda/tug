<!-- devise-skeleton v5 -->

## Join Arc 2 — the endgame answers, and it answers out loud {#join-arc-2}

**Purpose:** A dash is *make these changes and fit them back onto main* — so the run's ending verifies the fit: replay onto the live base, then the last checkpoint against the joined tree, in the warm worktree, only when the replay actually moved it. The join itself verifies nothing: no workshop, no tiers, no "Building the joined tree" — reconcile-clean in, landed sha out, seconds after approval. The join prompt raises every time it should — from inside a worktree, after a milestone, after a "Not yet" — and every join, however it was started, narrates its progress and leaves a durable "joined at `<sha>`" trace.

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

**Round 1 — 2026-08-21, opus.** Reviewed `plan:701e5407007a62c9`. Lint: 0 errors, 0 warnings.
Oriented on: the whole document — a first round.
Applied: **the re-ask key was wrong, and the code said so.** [P02] proposed the full `{base_sha}:{dash_head}:{decision}` triple; `prompt_mark_key`'s own docstring in `verify.rs` argues against exactly that, and it is right — keyed on the pair, "a dismissal would expire on any base move and the same question would be asked again on every push to `main`." That objection is entirely about `base_sha`, and says nothing about `dash_head`, which is the fact that separates the two cases the field report confused. Rewrote [P02] to key on `(dash_head, decision)`: a base move stays silent, a new round asks, a flipped verdict asks. Also caught that Step 2 as written was unimplementable — it claimed "the shas are already computed in scope," but the mark comparison in `standing_prompt` sits *above* both `rev_parse` calls; the branch `rev_parse` must move, and the step now says so and prices the extra process spawn.
**The migration risk named the wrong mechanism entirely.** It mitigated a serde schema change; the verdict is not JSON. `write_verification` formats `"{base}:{candidate}:{tier0}:{tier1}"` into one git-config value and `read_verification` hard-rejects anything that is not exactly four fields (`if parts.len() != 4 { return None; }`). Dropping the field without touching the reader would make every new fact unreadable, and leaving the reader strict would make every *existing* fact unreadable — either half alone turns every join into "this candidate is unverified". Rewrote R01 around the real format (reader accepts three or four), raised it to the plan's highest-likelihood risk, and made the reader/writer pair one task with a round-trip test.
**Step 4's client mechanism was a bypass where a correlation would do.** The plan proposed teaching the bulletin path to accept uncorrelated frames. Reading the surfaces showed none of them are missing: `LandingNoticeController` is mounted for `joinModeController` unconditionally at `session-card.tsx`, that controller subscribes to the verb store and reads `landError` from `joinState(entryKey).error`, and `useLandingReceipts` appends the `/dash-join` row from `joinState(entryKey).summary`. All three go dark for one reason — `ChangesetVerbStore` drops `changeset_join_ok` *and* `changeset_join_err` on a `_joinInflight` miss, and only `join()` populates that map. Replaced the bypass with `expectServerJoin()`, which registers the same correlation a composer press registers; the failure bulletin and the live receipt then work with no edits to `landing-notice.ts`, `use-landing-receipts.ts`, or the notice controller. Rewrote [P04] and Spec S03 around it and added the [L22] row to the State Zone Mapping.
**Two judgment calls were asked rather than deferred.** Success loudness: the user chose the transcript receipt plus the resting register over a success bulletin, keeping the bulletin channel's meaning ("something went wrong") intact — [P04] now says so and the app-test asserts no bulletin. Post-failure prompt behavior: the plan had a hole, since readiness survives a failed join and engagement *clears* the mark, so the identical modal would re-raise on top of the failure the user is still reading. The user chose quiet-until-something-changes; recorded as [P07] and wired into Step 2.
Step 3's task list was completed against a real inventory rather than a description: it had missed `fail_running`'s tier loop, the wire field on `DashJoinVerification` in `tugcast-core/src/types.rs` and its `join_board.rs` mapping, and four named tugdeck fixture files; it now also warns off `tests/app-test/scripts/select-tests.ts`, which `just app-test` and the covers-check depend on and which sits one directory from the script being deleted. Recorded that `join-mode-controller.ts` **already** documents and implements "Tier 0 alone decides", so `verdict_gate` is the sole surviving Tier 1 gate — which sharpens the step and shrinks its client risk. Replaced the speculative "app-test pins drift" risk with the checked fact: no app-test pins the removed wording, so a red pin in Step 3 means something else broke.
Laws cross-checked: [L02] honored — every piece of new client state rides an existing store or controller field, no new store and no new subscription; [L22] honored and now named — the receipt hook observes the verb store's own subscription directly rather than round-tripping through React; [L11] holds, since the register stays status and never becomes a control; [L29] honored in [P01] by resolving inside the gateway rather than teaching the CLI to canonicalize. [D142] and [D147] are the decisions this plan finishes rather than amends, and Step 5 corrects the doctrine sentence that went stale against [D147].
Deferred: nothing. Both judgment calls were asked and answered inside this round.

**Round 2 — 2026-08-21, fable.** Reviewed `plan:954c40b9eae24740`.
Oriented on: the user's direction after round 1 — asked whether the plan delivers excellent progress indication after approving a join, the honest answer was "parity with the composer route only," and the user said the word: fold the sheet-as-progress-surface in.
Applied: **the sheet becomes the progress surface** ([P04] fourth acknowledgment, S03 fourth act). Step 4 as reviewed left a structural miss intact — the user approves the join in a sheet that dismisses at the exact moment the work starts, and the feedback then plays on a one-line composer register somewhere else. The beats already stream (`changeset_join_land_delta` → `ChangesetJoinStore._land`, with `LandProgress.terminal` settling rather than erasing — built for exactly this reader), so the sheet gains a `deciding`→`landing` phase: "join-now" transitions instead of closing, the landing view renders the beats live, success rests briefly on the landed summary then closes itself, failure rests with the reason until dismissed. Grounded four mechanism constraints in the real code before writing the spec: `showSheet`'s content closure is rendered once at raise, so beats cannot arrive as props — the body subscribes itself via `useSyncExternalStore` ([L02]), and the file's "reads no store" docstring sentence is rewritten rather than silently contradicted; `DashJoinPromptWire` carries no dash name, so the hook gains `workspaceKey` + display name from the call site; the hook's fact-clear teardown does not fight the landing phase, because `answer()` already nulls `closeRef` before the cleared fact reaches the effect — the landing body owns the `close` it captured; and the terminal frames carry `summary`/`commit_hash` (ok) and `detail` (err), verified in `changeset-verb-store.ts`, so `LandProgress` gains an optional `detail` for the settled state. Success criteria, State Zone Mapping (two rows: the [L02] subscription, the [L22] local phase), Step 4 tasks/tests, and the mute-prompt-path deep dive updated together; the app-test extension now pins the sheet's landing phase and settled outcome, not just the receipt row.
Deferred: nothing.

**Round 3 — 2026-08-21, fable.** Reviewed `plan:7456324070a3594b`.
Oriented on: the field — the user watched "Building the joined tree" stand between a finished run (`layout-imposer-xp`, 4/4, replayed) and the join dialog, and directed: the rebuild dies, and the plan-ending integration checks move to the tree that is the dash's actual deliverable.
Applied: **round 1's [P03] is reversed — verification leaves the join entirely, and the run ends on the deliverable tree.** The analysis behind the reversal, verified in code: the check ran cold because a dash's first reconcile opens a cold workshop (`Workshop` is warm-by-design, but warmth exists only from the second check on, and most dashes are checked once and die); the prompt was gated on a *settled* verdict, so the build stood in front of the dialog; and the identity-skip mitigation would not have saved the observed case, because a replayed candidate's tree differs from the tip the run verified. Meanwhile the run's own integration checkpoint was spending real minutes on the **sandbox** — the wrong tree, frozen at branch time. The redesign moves the reconcile into the ending: `tugutil dash replay` already exists as a shipped verb (compare-and-swap onto the base tip, moves branch and worktree together via `git reset --keep`, `Current` when base unmoved, `Conflicted` naming the round), so the skeleton's Integration Checkpoint becomes replay-then-verify-only-what-moved, warm, with the model present to resolve conflicts — no new machinery. [P03] rewritten (both tiers, facts, `verdict_gate`, `--anyway`, `CheckTier0`, wire type, and the register's "checking" states all deleted; the join gates on reconcile-clean alone; the prompt raises the moment a candidate stands); [P05] rewritten around the ending procedure; [P02] simplified — the mark stores the dash head alone, since the decision word died with the verdict, and a replay's head-rewrite correctly expires old dismissals; [P07] loses the decision word; R01 (the verdict-line migration) deleted as moot, replaced by R02 (the accepted unverified window between the run's ending and the join — short, loud, cheap) and the run-end conflict risk (work arriving at the right desk); `request_id` grammar shrinks to `{name}:{base_sha}:{dash_head}`, safe because the client round-trips it unread. Steps 2/3/5/6 rewritten to match; Step 3 keeps `scripts/verify-tier0.sh`'s command shape alive renamed `verify-fit.sh` for the ending, keeps `clear_verification` as the key-sweeping teardown, and adds a residue grep; two round-1 leftovers contradicting [P04] (the "success bulletin" in the non-goals and the app-test category) were corrected to the receipt-and-register story.
Deferred: nothing.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The 2026-08-21 field report on the join endgame names five experience failures, and the investigation behind this plan traced each to a specific mechanism:

1. **The run ends with a multi-minute rebuild-and-retest tail.** The doctrine's only end-of-run obligation is one clause (`tuglaws/dash-work-doctrine.md`, "Verify before every commit": "the workspace before the run ends") plus the join draft. The tail comes from the devise skeleton's **Integration Checkpoint pattern** (`tuglaws/devise-skeleton.md`, Execution Steps preamble), which plan authors instantiate as a *terminal* step that re-lists the full sweep — `cargo nextest run`, `tsc`, `vite build`, `bun test`, `just app-test-changed` — and `dash-implement` walks it like any step because "the step names the specific commands." Every command in it already ran inside the steps it "verifies."
2. **App-tests still gate the join, in defiance of [D142].** [D142] retired Tier 1 at join time ("it is not run at join time by anything and is not rescheduled elsewhere"). But `.tugtool/config.toml` still declares `verify_tier1` (whose script runs `just app-test` over the candidate), `finish_join_inner` in `tugrust/crates/tugcast/src/feeds/join_resolver.rs` still calls `run_tier1` after Tier 0 goes green, `run_join_verification` in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` runs both tiers when `tier` is `None`, and `verdict_gate` in `tugrust/crates/tugdash-core/src/ops.rs` refuses a join when `fact.tier1` is `Red`, `Unrun`, or `Running`. The retired gate is alive in four places.
3. **"Not yet" silences the prompt forever.** The dismissal mark (`branch.tugdash/<name>.tugjoinprompted`, written by `write_prompt_mark` in `tugrust/crates/tugdash-core/src/verify.rs`) stores only the *decision word* (`clean` | `red`), and `standing_prompt` in `tugrust/crates/tugcast/src/feeds/join_board.rs` suppresses the ask whenever `read_prompt_mark(...) == Some(decision)`. Decline once after milestone M01, finish M02 — the decision is still `clean`, so the prompt never returns. This is the dominant cause of "the dialog sometimes never appears" on multi-milestone plans.
4. **A join confirmed from the prompt sheet is nearly mute.** `do_changeset_join_prompt_answer` ("join-now" arm, `agent_supervisor.rs`) calls the join with `session_id: None`, so `record_landing_receipt` returns early and no durable `/dash-join` transcript receipt is ever written; `JoinModeController.narration` is set only by `performJoin`, so the composer status row says nothing; and `changeset-verb-store.ts` drops **both** terminal frames when `_joinInflight.get(key)` is `undefined` (only a composer `join()` ever writes that map), so a failed prompt-path join posts **no bulletin** and a successful one appends **no live receipt row**. The in-flight beats render only on the Lens Dashes row and the Changes-shade dash row — both usually closed — and on success the same `changeset_all_bump` that settles the "Joined" register deletes the row hosting it. The outcome unmounts itself.
5. **Binding fails from inside the dash's own worktree, and the arc goes dark.** `claim_dash` in `tugrust/crates/tugutil/src/dash.rs` auto-binds on `dash create` and `dash step start`, passing the process **cwd** as the project. The guard — `same_project` in `tugrust/crates/tugcast/src/dash_api.rs` — canonicalizes both sides through the [L29] gateway but deliberately does not resolve a linked worktree to its base checkout, so a step verb run from inside the worktree fails to bind, degrades to a stderr warning (which the agent then confusedly narrates), and because `pilot_action` in `tugrust/crates/tugcast/src/feeds/join_pilot.rs` returns `None` for an unbound dash, **no reconcile, no Tier 0, no verification fact, no prompt — anywhere**. The worktree→base resolver already exists: `linked_worktree_base` in `tugrust/crates/tugcore/src/registry.rs`.
6. **Skills still point at the door.** `tugplug/skills/dash-implement/SKILL.md` phase 3 instructs "Then point the user at the join gesture: **`/join <name>`** …", and `dash-on/SKILL.md` echoes it — so runs end in a `/join` chip that reads as "nothing happens until you type this," when [D147]'s whole point is that the arc arms itself and the prompt raises on its own. `dash-work-doctrine.md`'s "Stop before the join" section still opens "**Marking the dash `built` is what starts the arc**" — stale against [D147], which demoted the mark to telemetry.

A seventh finding arrived from the field the same day, and it re-decided the second one's remedy. Tier 0 itself was watched standing between a finished run and the join dialog — "Building the joined tree", a multi-minute build, because a dash's *first* reconcile opens a **cold** workshop (`Workshop` is warm-by-design per dash, but warmth exists only from the second check on, and most dashes are checked once and die). The 2026-08-21 direction is that this rebuild must die, and the analysis behind it holds: the run's own ending — the plan's integration checkpoint — was verifying the **wrong tree** (the sandbox, frozen at branch time), and the join then paid a second time, cold, to verify the right one (the joined tree). The remedy is to move the verification, not duplicate it: the run ends by replaying onto the live base (`tugutil dash replay` — an existing verb that moves the branch *and* the worktree via `git reset --keep`, reports `Current` when the base has not moved, and names the conflicting round when it cannot) and running the final checkpoint against **that** tree, in the warm worktree, with the model present to resolve any conflict. After that, join-time verification checks nothing anyone needs: it is deleted outright — Tier 0 with Tier 1 ([P03]).

#### Strategy {#strategy}

- **Fix the two outright bugs first** (binding through worktrees, the head-blind dismissal mark): they are small, self-contained, and each one restores the prompt in a case where it silently never appears.
- **Then reshape what runs**: join-time verification is deleted end to end, both tiers ([P03]) — an unchecked registry is deleted, not reconciled. What the tiers were guarding moves to where the work happens: the run's ending replays onto the live base and verifies the joined tree in the warm worktree ([P05]) — the one tree that is the dash's actual deliverable. The join gate becomes reconcile-clean alone, and the prompt raises the moment a candidate stands.
- **Then make every join speak**: one feedback spine ([P04]) shared by the composer route and the prompt route — same receipt, same narration, same failure bulletin, same success acknowledgment.
- **Then say it in the durable text**: the skeleton stops prescribing the terminal sweep ([P05]), the doctrine's stale sentences are corrected, and the skills stop printing the `/join` chip for a bound, armed dash ([P06]).
- Every change to server truth lands in `tugdash-core`/`tugcast` and reaches the client over existing wire paths; no new stores, no new subscriptions ([L02]).

#### Success Criteria (Measurable) {#success-criteria}

- `tugutil dash step <name> start <n> --through <m>` executed with cwd **inside the dash's worktree** binds the session — no warning, and `dash status` shows the binding (Rust test, Step 1).
- A prompt declined "Not yet" at head A raises again after a new round moves the dash to head B (Rust test, Step 2).
- No build and no test runs anywhere in the join path: `grep -rn "verify_tier0\|verify_tier1\|run_tier0\|run_tier1" tugrust .tugtool scripts` finds nothing; a join proceeds with no verification fact at all; the prompt raises as soon as the candidate stands, with no "Building the joined tree" wait (Rust tests, Step 3).
- The devise skeleton's Integration Checkpoint pattern reads: `tugutil dash replay`, then the scoped verification **only when the replay moved the tree** — `Current` means the last step's checkpoint already verified these bytes and nothing re-runs (prose assertions, Step 5).
- A join confirmed from the prompt sheet produces: the sheet itself transitioning to a live progress surface that narrates the beats and settles on the outcome — the landed summary on success (brief rest, then it closes itself), the failure reason on failure (resting until dismissed) — plus a `/dash-join` transcript receipt row naming the landed sha, live narration on the composer status row while the beats run, the settled *"Joined `<dash>` into `<base>`"* sentence resting there afterwards, and — on a forced failure — a danger bulletin (bun tests + app-test, Step 4).
- A join that fails does not re-raise the identical prompt on the next recompute ([P07]; Rust test, Step 2).
- The devise skeleton no longer shows a terminal full-sweep Integration Checkpoint, and the doctrine states "a checkpoint that passed is spent" (prose assertions, Step 5).
- `dash-implement`/`dash-on` phase text contains no `/join <name>` pointer for the bound-and-armed ending (grep assertion, Step 6).
- `cargo nextest run`, `bunx tsc --noEmit`, `bunx vite build`, `bun test` green — each run inside the step whose checkpoint requires it, per [P05] itself.

#### Scope {#scope}

1. `tugcast/src/dash_api.rs` + `tugcore/src/registry.rs`: worktree-aware `same_project`.
2. `tugdash-core/src/verify.rs` + `tugcast/src/feeds/join_board.rs` + `agent_supervisor.rs`: the head-aware prompt mark.
3. Join-time verification deletion — both tiers, facts, gate, pilot check — across `tugdash-core`, `tugcast`, `tugcast-core`, `tugutil-core` config, `.tugtool/config.toml`, `scripts/`, and the tugdeck mirrors; `scripts/verify-tier0.sh` survives renamed as the run-ending `verify-fit.sh`.
4. The prompt-answer feedback spine: payload, receipt, narration, bulletins, sheet dismissal.
5. `tuglaws/devise-skeleton.md`, `tuglaws/dash-work-doctrine.md`: endgame verification text.
6. `tugplug/skills/dash-implement/SKILL.md`, `dash-on/SKILL.md`, doctrine "Stop before the join": the ending's narration.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **`join_in`'s refusal to run from inside the dash worktree stays.** The join's teardown deletes the worktree; proceeding with the caller's cwd inside it would delete the directory under their shell. The refusal message may stay as it is.
- **No verification survives at join time, and none is rescheduled as a background advisory.** A non-blocking Tier 0 was considered and rejected: it keeps the workshop hydration, the verification facts, and the verdict plumbing alive to deliver a warning that usually arrives after the join has landed — the unchecked-registry shape. The fit is verified once, at the end of the run ([P05]).
- **The workshop itself stays.** Its verification consumer dies, but `Workshop::open_merge` is the conflict-resolution surface the resolver ladder works in, and that machinery is untouched.
- **Dash rows still vanish on a landed join.** The Lens row, shade entry, and masthead `^dash` marker disappearing is correct; the durable trace is the receipt row, the resting register, and the settled sheet ([P04]), not a lingering ghost row.
- **No changes to the resolver ladder, occupancy, workshop lifecycle, or escalation flow.**
- **No unbound-dash prompt surface.** With Step 1 landed, the bind path covers the real case; an unbound dash keeps its passive Lens "Ready to join" line.

#### Dependencies / Prerequisites {#dependencies}

- The join-endgame machinery on main: `join_ready`, the pilot, `standing_prompt`, `DashJoinPrompt`, the prompt sheet, the register, the beats ([D142], [D147]).
- The landing receipt path: `record_landing_receipt` + `use-landing-receipts.ts` + `SessionJoinReceiptBlock` (all shipped; today exercised only by the composer route).

#### Constraints {#constraints}

- Warnings are errors (`-D warnings` via `tugrust/.cargo/config.toml`).
- Wire and payload changes must be additive/tolerant: an old client omitting `session_id` from the prompt answer must still join (the receipt is then skipped, as today).
- Verification facts already written on live branches are never read again after Step 3; the join/discard teardown sweeps their config keys so they are cleaned rather than orphaned (R02).
- `tugplug/` skill edits are inert until the app bundle is rebuilt — the checkpoint for Step 6 includes `just build-app`.

#### Assumptions {#assumptions}

- A control frame arrives on the instance whose shell ledger owns the answering session, so a `session_id` on the prompt answer reaches the right `ShellLedger` (this is how the composer route's receipt already works).
- `linked_worktree_base`'s pure-filesystem translation (`.git` file → `gitdir` → `commondir` → parent) holds for every dash worktree the engine creates; it is already load-bearing for instance discovery in `find_for_cwd`.
- One prompt per dash at a time. The `request_id` grammar becomes `{name}:{base_sha}:{dash_head}` — the decision word leaves it with the verdict that produced it ([P03]). The client treats `request_id` as opaque (it round-trips through `QuestionWizard` and `answerPrompt` unread), so the grammar change is server-local.
- `tugutil dash replay`'s contract holds as documented: compare-and-swap onto the base tip, moves branch and worktree together via `git reset --keep`, refuses on dirt, `Current` when the base has not moved past the merge-base, `Conflicted` naming the round and paths when a round cannot replay.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. The direction on all six points was reviewed and accepted 2026-08-21. The round-1 judgment call to keep Tier 0 as the one join gate was **reversed by the user the same day**, against the field: the check was re-verifying a tree that is not the dash's deliverable, cold, in front of the dialog. The standing decisions are [P03] (verification leaves the join entirely) and [P05] (the run ends on the deliverable tree).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| A joined tree lands unverified when the base moves between the run's ending and the join gesture (R02) | med | low | accepted deliberately — the window is minutes, the failure is a loud red build on main with the user present, and the fix is a normal fix on main ([P03]) | such a landing costs more than a trivial fix, more than rarely |
| The end-of-run replay hits a conflicted round | med | low-med | this is work arriving at the right desk: the model is in the worktree, mid-run, and resolves it as normal work before the checkpoint — strictly better than the same conflict surfacing at join time | conflicts that defeat in-run resolution |
| Per-head dismissal mark re-asks more often | low | low | `base_sha` is deliberately excluded from the key ([P02]), so a push to the base stays silent; only a new round asks | user reports prompt nagging |
| Receipt row depends on the answering session's ledger | low | low | absent/empty `session_id` degrades to today's behavior (no receipt), never an error | missing receipts in the field |
| Recorded feed fixtures carry the retired verification/decision fields | med | med | the validator stops requiring them in the same commit; `changeset-types.test.ts` and the `join-mode-controller`/`dash-join-register`/`landing-notice` fixtures are updated in Step 3's task list | `bun test` fixture failures |

**Risk R02: the unverified window between the run's ending and the join** {#r02-unverified-window}

- **Risk:** with join-time verification deleted, a base commit landing *after* the run's replay-and-verify ending but *before* the join gesture produces a joined tree nobody built. A semantic collision in that window (main renames a function the dash calls, in files the merge never conflicts on) lands red on main.
- **Mitigation:** accepted, with eyes open — this reverses round 1's [P03] on the user's 2026-08-21 direction. The window is short (the prompt raises immediately after the run); the failure mode is loud and local (the next build on main, with the user present); and the alternative was a multi-minute cold-workshop build in front of every join dialog, guarding a case that is rare and self-announcing. Old verification facts already written on live branches are simply never read again; the join's teardown (`clear_verification`) continues to sweep the keys where it already does.
- **Residual risk:** a red main for one fix's duration, rarely.

---

### Design Decisions {#design-decisions}

#### [P01] Binding reaches through a linked worktree at the gateway (DECIDED) {#p01-bind-through-worktree}

**Decision:** `same_project` in `dash_api.rs` resolves each side through the [L29] gateway **and then, when the path sits inside a linked git worktree, through `linked_worktree_base` to the base checkout** before comparing. `tugcore::registry::linked_worktree_base` is made `pub` and reused — one resolver, not a second implementation.

**Rationale:** The current docstring defends not reaching through ("`dash create` from inside one already names the checkout"), but the auto-bind path falsified that defense in the field: `claim_dash` passes the raw cwd, and `dash step start` is *documented* as "the resume path's 'I am working this dash'" — run from the one directory a dash run actually works in, it fails. The guard's purpose is to refuse **foreign projects**, and a dash worktree is not a foreign project; it is the same project's working copy. Resolving at the gateway (server-side) keeps [L29]'s one-gateway rule — the CLI still never canonicalizes.

**Alternatives considered:** teaching `claim_dash` to send the base checkout path (rejected: the CLI would be doing path resolution the gateway owns, a second quiet resolver beside [L29]); loosening the guard to a warning (rejected: a genuinely foreign bind should still refuse loudly).

#### [P02] "Not yet" declines this dash head, not every future green (DECIDED) {#p02-mark-is-the-state}

**Decision:** The dismissal mark stores the **dash head** — deliberately not the base sha, and (since [P03] deletes the verdict) with no decision word to record. `standing_prompt` suppresses the ask only when the current dash head matches the marked one. A new round on the dash re-raises; a base move alone stays silent.

**Rationale, and the counter-argument it answers:** `prompt_mark_key`'s docstring in `tugrust/crates/tugdash-core/src/verify.rs` argues *against* keying on the head pair, and it is half right: "keyed on the pair, a dismissal would expire on any base move and the same question would be asked again on every push to `main`." That objection is entirely about **`base_sha`** — and it is correct, which is why `base_sha` is excluded from the key. It says nothing about `dash_head`, and `dash_head` is the fact that distinguishes the two cases the field report confused. A base move means *the same dash work, reconciled again* → stay silent, exactly as the docstring wants. A new round means *new work the user has not been asked about* → ask. The current key collapses both into the decision word, which is why finishing milestone M02 after declining at M01 never asks: same dash, same `clean`, new work, no prompt.

**One subtlety `dash replay` introduces:** the run's ending replays the branch ([P05]), which rewrites round shas — so a head marked before a replay never matches after one, and the prompt correctly returns, because the tree genuinely moved. That is the desired direction: a replayed dash is new state nobody has declined.

The existing docstring must be rewritten by this step rather than left standing, since it documents the opposite rule.

**Alternatives considered:** the `{base_sha}:{dash_head}` pair (rejected — it re-asks on every push to the base, the nag the docstring predicted); keeping a decision word in the mark (rejected — [P03] deletes the verdict that produced it; a one-value vocabulary is not a key component); a time-based expiry (rejected — nothing about elapsed time makes a question new).

#### [P03] Verification leaves the join, entirely — deleted, not disabled (DECIDED) {#p03-tier1-dies}

**Decision:** Join-time verification is removed end to end, **both tiers**: the runners (`run_tier0`, `run_tier1`, their timeouts), the `Verification` fact and its reader/writer, `fail_running`, the `verdict_gate` and the `--anyway` escape that existed only to override it, the pilot's `CheckTier0` action, the verification calls in `finish_join_inner` and `run_join_verification`, the `verify_tier0`/`verify_tier1` config keys and both scripts, the `DashJoinVerification` wire type, and every tugdeck mirror down to the register's "checking" / "Building the joined tree" states. The join gate becomes **reconcile-clean alone**: a candidate stands, the merge had no unresolved conflicts, the prompt raises. What the tiers were guarding moves into the run's ending ([P05]).

**Rationale:** Round 1 kept Tier 0 on the argument that it checks a tree implementation never checked. The field falsified the value of checking it *there*: the check ran cold (a dash's first reconcile opens a cold workshop, and most dashes are checked once), stood directly between the user and the join dialog, and guarded a case — semantic interference from mid-run base lands — that is rare, self-announcing (a red build on main with the user present), and cheap to fix. The user's 2026-08-21 direction reversed the round-1 call: the rebuild dies. The correct place to verify the joined tree is where the work happens — the end of the run, warm, with the model present ([P05]) — not in front of the dialog. Deleting rather than disabling follows the standing rule that an unchecked registry is deleted: a config key nothing honors is a lie waiting to be believed.

**Alternatives considered:** Tier 0 as a non-blocking background advisory (rejected: keeps the whole workshop-hydration and verdict subsystem alive to deliver a warning that usually arrives after the join lands — the unchecked-registry shape); identity-skip only, keeping the gate (rejected: a replayed candidate's tree differs from the tip the run verified, so the common replayed case — the field report's own screenshot — still rebuilds and still holds the prompt); keeping the runner for on-demand use (rejected: an idle runner invites the next re-wiring, the drift [D142] already suffered once).

#### [P04] One feedback spine for every join route (DECIDED) {#p04-one-spine}

**Decision:** However a join starts — composer ⬆ or prompt sheet — it produces the same acknowledgments: (1) the durable `/dash-join` transcript receipt naming the landed sha; (2) live beat narration on the composer status row; (3) a danger bulletin on failure; and (4) **the sheet the user answered in becomes the progress surface** (decided 2026-08-21): "Join now" does not dismiss it — the sheet transitions to a landing phase that renders the beats live and settles on the outcome, resting briefly on success before closing itself and resting on the failure reason until dismissed. **Success is announced by the receipt, the resting register, and the settled sheet — not by a bulletin** (decided 2026-08-21): the bulletin channel means "something went wrong" today, and making it carry good news for the first time buys volume at the cost of that meaning. The transcript row and the settled *"Joined `<dash>` into `<base>`"* sentence are both already in the user's line of sight.

**The mechanism is correlation, not a bypass.** The reason the prompt route is mute is not that its surfaces are missing — they all exist and are mounted unconditionally — but that nothing tells the client a join is in flight for this card. `LandingNoticeController` is mounted for `joinModeController` at all times (`session-card.tsx`), that controller subscribes to the verb store and reads `landError` straight from `verbStore.joinState(entryKey).error`, and `useLandingReceipts` appends the `/dash-join` row from `joinState(entryKey).summary`. All three go dark for a prompt-path join for one reason: `ChangesetVerbStore` drops **both** `changeset_join_ok` and `changeset_join_err` when `_joinInflight.get(key)` misses, and only `join()` ever populates that map. So the fix is to register the same correlation a composer press registers — a new `expectServerJoin(entryKey, workspaceKey, dash)` on the verb store, called when the sheet answers "join-now" — after which the failure bulletin, the live receipt append, and the phase transitions all work **with no further changes**. Server-side, the answer carries the session id ([S02]) so the durable ledger row is written too; client-side, the narration is set so the composer register has a target ([S03]).

**Rationale:** Every silence in the field report is one asymmetry: the composer route built a full feedback spine and the prompt route bypassed the one map that connects a card to it. Routing the second door through the first door's machinery is strictly better than teaching four surfaces to accept uncorrelated frames — a bypass would have to re-answer "which card?" at every one of them. It also resolves the "outcome unmounts itself" defect without ghost rows: the register on a vanishing dash row was never a viable host for a terminal fact, and the transcript is. The fourth acknowledgment answers a structural miss the first three merely work around: the user's eyes are on the sheet at the moment they approve, and parity with the composer route alone would play the feedback somewhere else, smaller — a one-line register — while the surface they were looking at vanished. The sheet answers the question where it was asked; the register and receipt stay as the ambient and durable traces.

#### [P05] The run ends at the last step's checkpoint (DECIDED) {#p05-run-ends-at-last-checkpoint}

**Decision:** A checkpoint that passed is spent — and the run's last checkpoint runs against the **deliverable tree**. The devise skeleton's Integration Checkpoint pattern is rewritten to state the ending as a procedure: (1) `tugutil dash replay <name>` — the existing verb that replays the rounds onto the live base, moving the branch and the worktree together; (2) **only if the replay moved the tree** (`Replayed`/`Recorded`), run the scoped verification against it, in the warm worktree — the shape `scripts/verify-tier0.sh` had: scoped `cargo check` / `tsc` + `vite build` over the base..head diff; (3) `Current` means the last step's checkpoint already verified these exact bytes, and **nothing re-runs**; (4) `Conflicted` is work arriving at the right desk — resolve it in the worktree as normal work, then verify. The terminal full-sweep step is retired from the skeleton's pattern list and its worked example. The doctrine's "the workspace before the run ends" clause moves into the per-step bar ("the workspace `cargo nextest run` belongs to the last step that touched Rust"), and the doctrine gains the run-ending rule: *"The run ends when the fit is verified — replay, verify only what the replay moved, report, and stop; never re-run a checkpoint that already passed."* The doctrine's "Stop before the join" section is corrected to [D147]: the build is an offer, the mark is telemetry, the draft is the obligation.

**Rationale:** A dash is *make these changes and fit them back onto main* — and until this change, nothing in the run ever verified the fit. The plan-ending integration checkpoint re-ran the full sweep against the **sandbox**, frozen at branch time: real cost, wrong tree. The join then paid again, cold, for the right tree ([P03]). Moving the reconcile into the ending fixes both at once: the final checkpoint verifies the actual deliverable (base + dash, as it will land), in a worktree whose caches are warm from the run itself, with the model present to resolve conflicts — and the join inherits tested bytes with nothing left to check. When the base never moved, the ending costs one `dash replay` returning `Current` — seconds — because the run's own last checkpoint already verified the joined tree by identity.

#### [P06] The prompt is the ending; the chip is the escape hatch (DECIDED) {#p06-prompt-is-the-ending}

**Decision:** `dash-implement` and `dash-on` stop printing the `/join <name>` gesture for a bound, armed dash. The run's ending narration is: what was built, that the fit is verified, that the draft is written, and — at most — *"the join prompt will raise momentarily."* The `/join <name>` chip survives in exactly two texts: `dash-join`'s no-draft stop, and a new short "escapes" paragraph naming the cases where the prompt genuinely cannot raise (an unbound session the user declines to bind, a legacy dash with no declared run and no mark).

**Rationale:** Three skill passages instruct printing the gesture against one doctrine sentence saying the arc speaks for itself; the model obeys the majority. With Steps 1 and 2 landed, the prompt's two silent-failure modes are gone, so the chip's role as a workaround ends and its presence only teaches the user that the dialog is not coming.

#### [P07] A failed join stays quiet until something changes (DECIDED) {#p07-failed-join-quiet}

**Decision:** When a join fails, the danger bulletin carries the news and the prompt records a dismissal for the current dash head rather than re-raising. A new round on the dash asks again; the composer `/join <name>` route is available throughout.

**Rationale:** Readiness survives a failed join — `join_ready` is derived from the run and the worktree, and none of that changed — and `do_changeset_join_prompt_answer` *clears* the mark on engagement, so without this the identical modal re-raises on the next recompute, on top of the failure the user is still reading. When the cause is persistent (a dirty base, a stale journal) that is a fail/ask/fail/ask loop asking a question whose answer just failed. Decided with the user 2026-08-21.

---

### Deep Dives {#deep-dives}

#### The endgame cost ledger — who runs what, today {#endgame-cost-ledger}

For one finished run, the tree gets verified up to **four** times: (1) each step's checkpoint, during the run; (2) the plan's terminal Integration Checkpoint step — the full sweep, again, on the same bytes; (3) `just app-debug` — a full build + sign + launch; (4) the pilot's Tier 0 on the joined tree — cold, since a first reconcile opens a cold workshop — plus Tier 1's app-test selection via the resolver, plus `run_join_verification`'s both-tiers arm. And of all four, **none verifies the deliverable**: (1) and (2) test the sandbox frozen at branch time, (3) launches it, and (4) tests the joined tree but *after* the run, *cold*, and *in front of the dialog*. The redesign inverts the ledger: the run's ending replays onto the live base and verifies the joined tree once, warm, in the worktree ([P05]); (2) in its full-sweep form and (4) in its entirety are deleted ([P03], [P05]); (3) was already demoted to an offer by [D147] and the doctrine text catches up in Step 5. What lands is what was tested, and nothing runs twice.

#### The mute prompt path, end to end {#mute-prompt-path}

`standing_prompt` raises the fact → `JoinPromptSheet` mounts on the bound card (`session-card.tsx`, gated by `boundDashEntry` and `landingActive`) → "Join now" → `answerPrompt` sends `{project_dir, dash, request_id, answer}` → `do_changeset_join_prompt_answer` re-derives the prompt, refuses a moved `request_id`, and on "join-now" calls `do_changeset_join` with `message: None`, `session_id: None`, `anyway: decision == "red"`. From there: `record_landing_receipt` early-returns on the `None`; the beats stream to `ChangesetJoinStore._land`, whose only mounts are the Lens Dashes row and the shade dash row; **both** `changeset_join_ok` and `changeset_join_err` are dropped by `changeset-verb-store.ts` because `_joinInflight` has no entry for this key (only `join()` ever writes that map), which silences the failure bulletin *and* the live receipt append at once; and on success `changeset_all_bump` removes the dash entry, unmounting the rows that held the settled register. Step 4 threads the session id through the first gap and registers the missing correlation for the rest ([S03]) — the spine's surfaces need no changes, because `LandingNoticeController` and `useLandingReceipts` are already mounted and already subscribed. The one surface that does change is the sheet itself, which today dismisses at the exact moment the work starts: it gains a landing phase and becomes the progress surface ([P04], S03).

#### The bind guard, mechanically {#bind-guard-mechanics}

`POST /api/dash` bind → `owns_session` finds the session's ledger row → `same_project(&row.project_dir, project_dir)` compares `resolve_to_claude_form` of the recorded project against the CLI's cwd. A linked worktree's canonical path is a genuinely different directory (`.tug/worktrees/<name>` or wherever the engine placed it), so the compare fails and the verb warns: *"session … works … — it cannot bind a dash in …"*. `linked_worktree_base` reads the worktree's `.git` **file** (`gitdir:` line) → that gitdir's `commondir` → its parent, purely on the filesystem — the same translation `find_for_cwd` already trusts for instance discovery. [P01] applies it inside `same_project`, after the gateway, on both sides (a session could itself have been spawned in a worktree).

---

### Specification {#specification}

#### S01 — worktree-aware project identity {#s01-worktree-identity}

`same_project(a, b)` returns true when `through_base(resolve_to_claude_form(a)) == through_base(resolve_to_claude_form(b))`, where `through_base(p)` is `linked_worktree_base(p).map(resolve_to_claude_form).unwrap_or(p)`. The refusal message is unchanged for genuinely foreign projects. `claim_dash` and `binding_project` in `tugutil/src/dash.rs` are untouched — the CLI still sends its cwd, uncanonicalized.

#### S02 — the prompt answer names its session {#s02-answer-session}

`ChangesetJoinPromptAnswerPayload` gains optional `session_id: Option<String>` (absent/empty tolerated). `answerPrompt` in `changeset-join-store.ts` gains a `sessionId` parameter, supplied by the session card from its own session identity at the one call site. The "join-now" arm passes it into the join payload in place of `session_id: None`, which makes `record_landing_receipt` write the same `/dash-join` shell-exchange receipt the composer route writes, rendered by `SessionJoinReceiptBlock` via `use-landing-receipts.ts`.

#### S03 — the prompt route joins the spine {#s03-prompt-route-narration}

Answering "join-now" performs four client acts before the control frame goes out, and **nothing downstream changes**:

1. `ChangesetVerbStore` gains `expectServerJoin(entryKey, workspaceKey, dash)`, which sets `_joinInflight` for that key exactly as `join()` does but sends no frame. The session card calls it with `changesController.entryKey` — the same key `useLandingReceipts` and `JoinModeController` already read.
2. `JoinModeController` gains `narrateServerJoin(target)`, setting `narration` (which `registerTarget = this.target ?? this.narration` already consults) without entering interactive join mode, so the composer status row carries the beats and then the settled *"Joined `<dash>` into `<base>`"* sentence.
3. Host-level sheet dismissal (`showSheet` resolving with no submitted answer) answers "not-yet", matching ⎋ and "Chat about this".
4. **The sheet enters its landing phase instead of closing** ([P04]). The body moves from `deciding` to `landing` and renders the join's beats live, settling on the outcome.

With (1) in place, (2)'s downstream and the bulletins are free, and they are the whole reason to do it that way: `changeset_join_err` → `_setJoin(entryKey, {phase:"error"})` → `joinModeController.landError` → the `LandingNoticeController` already mounted unconditionally at `session-card.tsx` posts *"Join failed"*; `changeset_join_ok` → `_setJoin(entryKey, {phase:"done", summary})` → `useLandingReceipts` appends the `/dash-join` row live. **No success bulletin is posted** ([P04]).

**The landing phase, mechanically.** Four facts of the existing code shape it:

- **Beats cannot arrive as props.** `showSheet`'s `content` is a closure rendered once at raise; nothing re-renders it from outside. So the landing phase subscribes itself: the body reads `ChangesetJoinStore.landProgress(workspaceKey, dash)` via `useSyncExternalStore` — lawful under [L02], and the store was built for exactly this reader (`LandProgress.terminal` settles the last beat instead of erasing it, precisely so a renderer mounted at answer time has something to paint even when every frame lands in one batch). The sheet file's module docstring currently says "this file reads no store" — that sentence is rewritten, not silently contradicted: the *decision* still arrives by prop; the *progress* is the body's own subscription.
- **The keys come from the caller.** `DashJoinPromptWire` carries no dash name; `useJoinPromptSheet` gains `workspaceKey` and the dash's display name (both already in scope at the `session-card.tsx` call site as `changesController.workspaceKey` / `boundDashEntry.display_name`), threaded into the body at raise.
- **The fact-clear teardown must not reclaim it.** The hook closes the sheet when `prompt === null` — and the fact clears on the recompute right after "join-now". This already works: `answer()` nulls `closeRef` before the effect sees the cleared fact, so the hook has released its claim. The landing-phase body owns the `close` it captured from the content closure: on a terminal `joined` beat it rests briefly (the settled word plus the outcome line), then closes itself; on `failed` it rests with the reason until the user dismisses. "review-first" and "not-yet" close immediately, as today.
- **The settled state names the outcome.** `LandProgress` gains an optional `detail`, captured from the terminal frame (`summary` on `changeset_join_ok`, `detail` on `changeset_join_err`), so the settled sheet shows the landed summary or the failure reason rather than a bare word.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Law |
|-------|------|-----|
| Land beats for the bound dash (composer status row) | existing `ChangesetJoinStore`, read via `useSyncExternalStore` — no new store | [L02] |
| Join-in-flight correlation for a server-initiated join | existing `ChangesetVerbStore._joinInflight` map, new entry point ([S03]) — no new store, no new subscription | [L02], [L22] |
| Prompt-route narration (`narration` on `JoinModeController`) | existing controller field, new setter; exposed through its existing snapshot | [L02] |
| Failure bulletin | existing `LandingNoticeController` channel, reached through `landError` — no new wiring | [L02], [L11] |
| Sheet dismissal → "not-yet" | event handling in `join-prompt-sheet.tsx`; no state added | — |
| Join beats in the sheet's landing phase | existing `ChangesetJoinStore.landProgress`, read in the sheet body via `useSyncExternalStore` — no new store ([S03]) | [L02] |
| Sheet phase (`deciding` → `landing`) | local `useState` in the sheet body — a fact about this mount's conversation, nothing outside it reads it | [L22] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

- **Rust unit (tugcast/tugcore/tugdash-core):** `same_project` through a real scratch linked worktree (the fixture shape already used by `linked_worktree_base`'s own tests); prompt-mark write/read/suppress/re-raise table across head moves; the join precondition table (candidate present → proceeds with no verification fact; no candidate → refuses); `pilot_action` pins updated for the retired `CheckTier0` arm (candidate present → prompt-eligible, never a check).
- **bun unit (tugdeck):** `answerPrompt` payload carries the session id; verb-store posts the bulletin for a bound-dash error with no local press; register/narration snapshots for the server-join path; `changeset-types` validator without the verification block.
- **App-test (scratch repo, existing dash fixture family):** one extension to the full-arc test — a prompt-sheet "Join now" keeps the sheet up through the landing phase, settles it naming the outcome, and ends with the receipt row visible in the transcript (no success bulletin, per [P04]). **No new app-test runs as any join gate** — these tests cover the features, in the implementation run, per the standing selection discipline.

#### What stays out of tests {#test-non-goals}

- No test drives `just app-test` from inside join verification — that path is deleted.
- No jsdom render tests; component behavior that needs pixels is pinned in the app-test extension.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Binding reaches through the worktree | done | `845b1eebc` |
| #step-2 | The dismissal mark records the state it declined | done | `cc4963fc0` |
| #step-3 | Verification leaves the join, everywhere | done | `098ed3b60` |
| #step-4 | One feedback spine for every join | done | `f00b86b2d` |
| #step-5 | The run ends on the deliverable tree — the durable text says so | done | `94c957120` |
| #step-6 | The skills stop pointing at the door | done | `6a486e3bf` |

#### Step 1: Binding reaches through the worktree {#step-1}

**Commit:** `binding reaches through a linked worktree`
**References:** [P01], S01 (#s01-worktree-identity), #bind-guard-mechanics

**Tasks:**
- [ ] Make `linked_worktree_base` `pub` in `tugcore/src/registry.rs` with a docstring naming its second consumer.
- [ ] Rewrite `same_project` in `tugcast/src/dash_api.rs` per S01; rewrite its docstring — the old text defends the behavior this step removes.
- [ ] Verify the auto-bind path end to end: `dash create` and `dash step start` from a cwd inside the worktree bind without the warning.

**Tests:**
- [ ] `dash_api` unit: scratch repo + `git worktree add`; bind from the worktree cwd succeeds; bind from an unrelated scratch project still refuses with the existing message.
- [ ] `registry` unit: existing `linked_worktree_base` tests still pin the translation.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugcore` green.

#### Step 2: The dismissal mark records the state it declined {#step-2}

**Commit:** `a declined join prompt declines one state, not a category`
**Depends on:** #step-1
**References:** [P02], [P07], #mute-prompt-path

**Tasks:**
- [ ] `verify.rs`: `write_prompt_mark` takes `dash_head` and stores it. **Rewrite `prompt_mark_key`'s docstring** — it currently argues for the rule this step replaces; the new text must state why `dash_head` is the key and `base_sha` is deliberately not ([P02]).
- [ ] `join_board.rs` `standing_prompt`: **move the `dash_head` `rev_parse` above the mark comparison** — today the mark check sits *before* both `rev_parse` calls, so the head is not yet in scope where it is now needed. Only the branch `rev_parse` moves; `base_sha` stays where it is, since it is not part of the key. Suppress only on an exact `dash_head` match, and update the comment beside the compare.
- [ ] `agent_supervisor.rs`: the "not-yet" arm writes the re-derived prompt's `dash_head`.
- [ ] Per [P07], the join-failure path records the same dismissal so a failed join does not immediately re-raise the identical ask.
- [ ] A legacy mark holding a bare decision word can never match a 40-char sha, so old dismissals expire on upgrade — the desired direction (the prompt returns).

**Tests:**
- [ ] `verify.rs` table: declined at headB → suppressed at headB, raised at headC; a legacy decision-word mark never suppresses.
- [ ] `join_board.rs`: the existing dismissal test extended two ways — a base move with an unchanged head stays silent (the docstring's objection, still honored), and a new round raises.

**Notes:** moving the branch `rev_parse` above the mark check means a dismissed dash pays one `git rev-parse` per recompute that it did not pay before. One process spawn against work the recompute already does; the `landing_message_preview` read on the raise branch is the more expensive neighbor and is unchanged.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugcast` green.

#### Step 3: Verification leaves the join, everywhere {#step-3}

**Commit:** `the join verifies nothing; the run verified the fit`
**Depends on:** #step-2
**References:** [P03], R02 (#r02-unverified-window), #endgame-cost-ledger

**Tasks:**
- [ ] `tugdash-core/src/verify.rs`: delete `run_tier0`, `run_tier1`, `TIER0_TIMEOUT`, `TIER1_TIMEOUT`, the `Verification` struct, `read_verification`, `write_verification`, `fail_running`, and the tier helpers (`undeclared`, `run_declared`/`verify_env` if the tiers were their last consumers — check before deleting; the prompt-mark functions in the same file **stay**). Keep `clear_verification` reduced to the teardown sweep that deletes the now-unread branch-config keys where join/discard already call it, so stale facts on live branches are cleaned rather than orphaned.
- [ ] `tugcast/src/feeds/join_resolver.rs`: delete the `run_tier0`/`run_tier1` calls and helpers in `finish_join_inner`; the resolver's green path ends at a standing candidate — no fact recorded, nothing to settle.
- [ ] `agent_supervisor.rs`: delete `run_join_verification` and its `want_tier1`/tier-selection plumbing; delete the `anyway: decision == "red"` computation in the prompt-answer "join-now" arm (the payload field goes with the verdicts that gave it meaning).
- [ ] `tugdash-core/src/ops.rs`: delete `verdict_gate` and the `anyway` field of `JoinOpts`; remove `--anyway` from `tugutil dash join`'s CLI surface. The join's preconditions become what the execution already checks: a candidate stands, the merge is clean, the base preflight passes.
- [ ] `join_pilot.rs`: delete `PilotAction::CheckTier0` and the runner's `check_tier0` method; a standing candidate is prompt-eligible directly.
- [ ] `join_board.rs` `standing_prompt`: raise on a standing candidate + quiet + mark check — no settled-verdict gate, no decision derivation; `request_id` becomes `{name}:{base_sha}:{dash_head}`.
- [ ] Delete `verify_tier0` and `verify_tier1` from `tugutil-core/src/config.rs` (existing project configs still declaring the keys become ignored unknown fields — no migration needed) and from `.tugtool/config.toml` — **but keep the verify-tier0 command shape alive in this repo** as the run-ending verification Step 5's skeleton names (rename `scripts/verify-tier0.sh` → `scripts/verify-fit.sh`, same scoped `cargo check` / `tsc` + `vite build` over `$TUG_VERIFY_BASE_SHA..$TUG_VERIFY_CANDIDATE_SHA`, now parameterized by plain arguments since the runner that set that env dies). Delete `scripts/verify-tier1.sh`. **Leave `tests/app-test/scripts/select-tests.ts` alone** — `just app-test`, `app-test-changed`, and the covers-check all depend on it.
- [ ] Delete the wire type `DashJoinVerification` from `tugcast-core/src/types.rs`, its `join_board.rs` mapping, and the `decision` field from `DashJoinPromptWire` if nothing but the retired verdict fed it — the sheet maps answers positionally and never reads it.
- [ ] `Workshop`: `open_candidate` loses its verification consumers — delete it only if the resolver ladder is not using it either (check `open_merge` vs `open_candidate` call sites); the workshop itself stays for conflict resolution.
- [ ] tugdeck sweep: `changeset-types.ts` (verification type + validator + prompt decision mirror), `join-mode-controller.ts` (the verdict-reading paths and the "Tier 0 alone decides" docstring — now "the run verified the fit; the join gates on reconcile-clean"), `dash-join-register.ts` (the `checking` / "Building the joined tree" states die; `reconciling` stays), and the fixtures in `changeset-types.test.ts`, `join-mode-controller.test.ts`, `landing-notice.test.ts`, `dash-join-register.test.ts`, and `spikes/spike-join-arc.tsx`.
- [ ] Residue grep as the step's own gate: `grep -rn "tier0\|tier1\|Tier 0\|Tier 1\|verdict_gate\|DashJoinVerification" tugrust tugdeck/src .tugtool scripts` — every survivor is either the prompt-mark file's history-free code or a deliberate keep named above.

**Tests:**
- [ ] Join precondition table replacing the `verdict_gate` table: a standing candidate joins with no verification fact present; no candidate refuses with the existing message; a stale-fact branch (config keys from the old world) joins cleanly and the teardown sweeps the keys.
- [ ] `pilot_action` table updated: ready + candidate → prompt-eligible (no `CheckTier0` arm); ready + no candidate → reconcile, unchanged.
- [ ] `standing_prompt`: raises on a standing candidate with no verdict machinery invoked; the new `request_id` grammar round-trips through the answer path.
- [ ] `bun test` on the swept tugdeck modules.

**Notes (written during implementation — three deviations, each deliberate):**

1. **The gate was deleted outright, not reduced to a candidate refusal.** The plan kept the no-candidate arm and its "existing message". That message is *"no **verified** candidate … or join --anyway"* — the refusal was verification's own, and its stated rationale ("a textually clean merge that nobody ever built") is the case [P05] now covers. [P03]'s own rule decides it: the preconditions become what the execution already checks, and `join_in` never required a candidate — it merges the branch by strategy when none is named. Keeping the arm while deleting `--anyway` would also have stranded every no-candidate join with a refusal and no escape, and broken the 33 `mechanics()` tests whose subject is the squash rather than the gate. The deletion is pinned by a new test: a stale verdict left on a live branch by an older build does not block a join.

2. **The override fact and the composer's red confirm died with the verdict.** The plan named `verdict_gate` and `--anyway`; the durable override (`read_override`/`write_override`, `standing_override`, `override_for` on the wire, the `changeset_join_override` control) and the client's `joinLandConfirm` / `landRole` / `LandOptions.anyway` existed only to override a red. With no red to override, each was a control that could never fire — the unchecked-registry shape [P03] deletes rather than reconciles. `clear_verification` sweeps the override key alongside the verdict keys.

3. **The app-test corpus did move**, contrary to this note's earlier claim. `at0443-join-verification-red` tested the deleted feature and is deleted with it; `spike-join-arc.tsx` documented the retired design and is deleted (taxonomy pin 14 → 13). `silenceJoinPrompt` still wrote the decision word Step 2 retired, so the prompt raised over four fixtures' composers and their waits timed out — it now writes the dash head. Four tests waited on `data-verdict="green"`; the panel is the resolver's account now, renamed `session-changes-dash-join-account`, and they wait for it to exist.

**One real bug surfaced.** After a resolver pass, `send_changeset_join_resolve_ok` reported the **ladder's** `unresolved` list — files the resolver had just settled — which `changeset-join-store` renders as *"Still conflicting — resolve by hand"*. It was latent because the tiers ran between the candidate anchoring and the frame going out, so the test read the register before the lie arrived; deleting them closed that window and made it deterministic. The frame now clears the settled paths.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` (workspace — this step touches four crates and the shared types) green; `cd tugdeck && bunx tsc --noEmit && bun test` green; the re-aimed app-tests green via `just app-test <files>`.

#### Step 4: One feedback spine for every join {#step-4}

**Commit:** `a prompt-sheet join narrates, receipts, and posts its outcome`
**Depends on:** #step-3
**References:** [P04], S02 (#s02-answer-session), S03 (#s03-prompt-route-narration), #mute-prompt-path, #state-zone-mapping

**Tasks:**
- [ ] `agent_supervisor.rs`: `ChangesetJoinPromptAnswerPayload` gains optional `session_id` (`parse_changeset_join_prompt_answer_payload` tolerates absence — its other fields use a strict `field()` helper, so the new one must not); the "join-now" arm passes it in place of today's `session_id: None` so `record_landing_receipt` writes the durable row.
- [ ] `changeset-verb-store.ts`: add `expectServerJoin(entryKey, workspaceKey, dash)` per [S03], setting `_joinInflight` exactly as `join()` does and sending nothing. This is the whole client fix — the failure bulletin and the live receipt append both follow from it with no edits to `landing-notice.ts`, `use-landing-receipts.ts`, or `landing-notice-controller.tsx`.
- [ ] `changeset-join-store.ts` `answerPrompt` gains `sessionId`; `session-card.tsx` supplies it and calls `expectServerJoin` + `narrateServerJoin` at the one "join-now" call site.
- [ ] `join-mode-controller.ts`: add `narrateServerJoin(target)` per [S03] — sets `narration` without entering interactive join mode, so `registerTarget` resolves and the composer status row narrates.
- [ ] `join-prompt-sheet.tsx`: the host-dismissal path (sheet promise resolving with no submitted answer) answers "not-yet", matching ⎋ and "Chat about this".
- [ ] `changeset-join-store.ts`: `LandProgress` gains optional `detail`, captured from the terminal frame — `summary` (and `commit_hash` when present) on `changeset_join_ok`, `detail` on `changeset_join_err` — so the settled sheet names the outcome rather than a bare word (S03).
- [ ] `join-prompt-sheet.tsx`: the landing phase per S03 — the body holds a `deciding`/`landing` phase; "join-now" transitions instead of closing; the landing view subscribes to `landProgress(workspaceKey, dash)` via `useSyncExternalStore` and renders the current beat (`squash`/`teardown`/`release`/`record`), settling on the terminal beat; success rests briefly then calls the captured `close`; failure rests with the reason until the user dismisses. `useJoinPromptSheet` gains `workspaceKey` + dash-name args from the `session-card.tsx` call site. Extract the beat→rendered-line mapping as a pure function so it table-tests. Rewrite the module docstring's "this file reads no store" sentence per S03, and note the fact-clear teardown analysis (the hook's claim is already released by `answer()`).
- [ ] `join-prompt-sheet.css`: the landing and settled states — beat line, settled success, settled failure — tokens only.

**Tests:**
- [ ] bun: `answerPrompt` payload carries the session id; after `expectServerJoin`, a `changeset_join_err` frame settles the entry's join state to `error` (which is what feeds the bulletin) and a `changeset_join_ok` frame settles it to `done` carrying the summary (which is what feeds the receipt); controller snapshot after `narrateServerJoin` exposes a register target; sheet dismissal answers "not-yet".
- [ ] bun: the beat→line table (each in-flight beat, settled `joined` with a detail, settled `failed` with a reason, and a null progress — the beats-not-yet-arrived frame gap); `LandProgress.detail` captured from both terminal frames.
- [ ] Rust: the parser accepts a payload with and without `session_id`; the receipt is recorded when present and skipped when absent.
- [ ] App-test: extend the full-arc scratch-repo test — prompt "Join now" → the sheet stays up, shows the landing phase, and settles naming the outcome before it dismisses; then the `/dash-join` receipt row appears in the transcript naming the landed sha. (No success bulletin is asserted; there is none by [P04].)

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green; `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test` green; the extended app-test green via `just app-test <file>`.

#### Step 5: The run ends on the deliverable tree — the durable text says so {#step-5}

**Commit:** `the ending verifies the fit; the skeleton retires the terminal sweep`
**Depends on:** #step-3
**References:** [P05], #endgame-cost-ledger

**Tasks:**
- [ ] `tuglaws/devise-skeleton.md`: rewrite the Integration Checkpoint pattern as the [P05] procedure — `tugutil dash replay <name>`, then `scripts/verify-fit.sh <base> <head>` (or the project's equivalent) **only when the replay reports `Replayed`/`Recorded`**; `Current` means the last step's checkpoint already verified these bytes and nothing re-runs; `Conflicted` is resolved in the worktree as normal work, then verified. Rework the worked example (Step 5 in the skeleton) to show this ending; sweep the Deliverables/Exit-Criteria prose so it stops modeling a terminal full-sweep restatement.
- [ ] `tuglaws/dash-work-doctrine.md`: move the workspace-`nextest` clause into the last-Rust-step framing; state the run-ending rule from [P05] ("the run ends when the fit is verified — replay, verify only what the replay moved, report, and stop; never re-run a checkpoint that already passed"); correct "Stop before the join" to [D147] (build is an offer, mark is telemetry, draft is the obligation).
- [ ] Record the decision as the next `[D##]` entry in `tuglaws/design-decisions.md`, in the file's voice, citing [D142]/[D147], covering both halves — verification leaves the join ([P03]) and the run ends on the deliverable tree ([P05]) — and naming the rejected alternatives (the terminal sandbox sweep; join-time Tier 0, blocking or advisory) so neither is re-proposed.

**Tests:**
- [ ] Prose-level grep assertions in the checkpoint (no unit tests for markdown).

**Checkpoint:**
- [ ] `grep -n "workspace before the run ends" tuglaws/dash-work-doctrine.md` finds nothing; `grep -n "Marking the dash .built. is what starts the arc" tuglaws/dash-work-doctrine.md` finds nothing; the skeleton's Integration Checkpoint pattern names `dash replay` and states that `Current` re-runs nothing; the doctrine states the [P05] run-ending rule; `tugutil plan lint` on this plan still exits 0 (the linter's step-shape rules must not have depended on the retired pattern).

#### Step 6: The skills stop pointing at the door {#step-6}

**Commit:** `the prompt is the ending; the chip is the escape hatch`
**Depends on:** #step-5
**References:** [P06]

**Tasks:**
- [ ] `tugplug/skills/dash-implement/SKILL.md` phase 3: the ending procedure becomes [P05]'s — `tugutil dash replay`, verify the fit only if the replay moved the tree, write the draft, stop; delete the "Then point the user at the join gesture" passage; the ending narration is what was built, that the fit is verified, the draft — and at most *"the join prompt will raise momentarily"*; phase 5 reworded to describe the prompt as the normal door and `/join <name>` as the escape.
- [ ] `tugplug/skills/dash-on/SKILL.md`: same treatment — the replay-then-verify ending before the draft, and its join paragraph loses the chip.
- [ ] Add the short "escapes" paragraph (unbound-by-choice, legacy dash) to `dash-implement`, naming the only cases the chip should be printed.
- [ ] Rebuild the bundle so the live skills carry the text (`just build-app`) — repo edits to `tugplug/` are inert until then.

**Tests:**
- [ ] Grep assertions in the checkpoint.

**Checkpoint:**
- [ ] `grep -rn "point the user at the join gesture" tugplug/skills` finds nothing; `grep -rln "/join <name>" tugplug/skills` matches only `dash-join/SKILL.md` and the escapes paragraph; `just build-app` completes and the bundle copy of `dash-implement/SKILL.md` matches the repo's.

---

### Deliverables and Checkpoints {#deliverables}

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- Binding works from inside a dash worktree; the pilot pilots such dashes; the confused warning narration is gone.
- A declined prompt returns on the next state; a milestone-by-milestone run gets asked at each milestone's completion.
- The join path runs no builds and no tests, holds no tier residue, and gates on reconcile-clean alone; the run's ending verifies the deliverable tree — replay, then verify only what the replay moved.
- Every join — prompt or composer — leaves a durable receipt, narrates its beats on the composer status row, rests a settled outcome sentence there, and posts a danger bulletin when it fails.
- The skeleton, doctrine, and skills say what the machinery now does; each check ran green inside the step that changed the code it covers, and nothing re-ran at the end — this plan has no terminal sweep, deliberately, per [P05].

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- **Phased ordering for implementation:** run as three invocations if desired — `Steps 1-2` (the silent-failure bugs; smallest, highest leverage), then `Steps 3-4` (the join's substance: what runs, what speaks), then `Steps 5-6` (the durable text). Each boundary is a clean stop with user-visible improvement; the dependencies encode this order.
- A "joined" archaeology surface — browsing past landed dashes (the receipts are the seed data).
- `dash bind`/`unbind` `--instance`/`--port` selection (carried from the previous arc's findings).
- Delete-or-graduate `DashFactsRun`/`dash-facts.tsx` (spike-only mount, noted 2026-08-21).
