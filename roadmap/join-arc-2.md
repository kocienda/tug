<!-- devise-skeleton v5 -->

## Join Arc 2 — the endgame answers, and it answers out loud {#join-arc-2}

**Purpose:** A finished dash run ends when its last checkpoint passes — no rebuilt tail, no re-run tests, no app-test gate bolted onto the join. The join prompt raises every time it should — from inside a worktree, after a milestone, after a "Not yet" — and every join, however it was started, narrates its progress and leaves a durable "joined at `<sha>`" trace. Six defects, six steps, one arc that finally communicates.

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

#### Strategy {#strategy}

- **Fix the two outright bugs first** (binding through worktrees, the head-blind dismissal mark): they are small, self-contained, and each one restores the prompt in a case where it silently never appears.
- **Then reshape what runs**: Tier 1 is deleted rather than disabled ([P03]) — an unchecked registry is deleted, not reconciled — and verification becomes Tier 0 alone: *does the joined tree build*. Tier 0 stays because it checks something implementation never checked: the **joined** tree (base + dash), which is not the worktree the run tested.
- **Then make every join speak**: one feedback spine ([P04]) shared by the composer route and the prompt route — same receipt, same narration, same failure bulletin, same success acknowledgment.
- **Then say it in the durable text**: the skeleton stops prescribing the terminal sweep ([P05]), the doctrine's stale sentences are corrected, and the skills stop printing the `/join` chip for a bound, armed dash ([P06]).
- Every change to server truth lands in `tugdash-core`/`tugcast` and reaches the client over existing wire paths; no new stores, no new subscriptions ([L02]).

#### Success Criteria (Measurable) {#success-criteria}

- `tugutil dash step <name> start <n> --through <m>` executed with cwd **inside the dash's worktree** binds the session — no warning, and `dash status` shows the binding (Rust test, Step 1).
- A prompt declined "Not yet" at head A raises again after a new round moves the dash to head B with the same decision word (Rust test, Step 2).
- No app-test runs anywhere in the join path: `grep -r "verify_tier1" tugrust .tugtool scripts` finds nothing, and `verdict_gate` passes on a candidate whose only fact is a green Tier 0 (Rust tests, Step 3).
- A join confirmed from the prompt sheet produces: a `/dash-join` transcript receipt row naming the landed sha, live narration on the composer status row while the beats run, the settled *"Joined `<dash>` into `<base>`"* sentence resting there afterwards, and — on a forced failure — a danger bulletin (bun tests + app-test, Step 4).
- A join that fails does not re-raise the identical prompt on the next recompute ([P07]; Rust test, Step 2).
- The devise skeleton no longer shows a terminal full-sweep Integration Checkpoint, and the doctrine states "a checkpoint that passed is spent" (prose assertions, Step 5).
- `dash-implement`/`dash-on` phase text contains no `/join <name>` pointer for the bound-and-armed ending (grep assertion, Step 6).
- `cargo nextest run`, `bunx tsc --noEmit`, `bunx vite build`, `bun test` green — each run inside the step whose checkpoint requires it, per [P05] itself.

#### Scope {#scope}

1. `tugcast/src/dash_api.rs` + `tugcore/src/registry.rs`: worktree-aware `same_project`.
2. `tugdash-core/src/verify.rs` + `tugcast/src/feeds/join_board.rs` + `agent_supervisor.rs`: the head-aware prompt mark.
3. Tier 1 deletion across `tugdash-core`, `tugcast`, `tugutil-core` config, `.tugtool/config.toml`, `scripts/`, and the tugdeck mirrors.
4. The prompt-answer feedback spine: payload, receipt, narration, bulletins, sheet dismissal.
5. `tuglaws/devise-skeleton.md`, `tuglaws/dash-work-doctrine.md`: endgame verification text.
6. `tugplug/skills/dash-implement/SKILL.md`, `dash-on/SKILL.md`, doctrine "Stop before the join": the ending's narration.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **`join_in`'s refusal to run from inside the dash worktree stays.** The join's teardown deletes the worktree; proceeding with the caller's cwd inside it would delete the directory under their shell. The refusal message may stay as it is.
- **No change to Tier 0's content.** `scripts/verify-tier0.sh` (scoped `cargo check` / `tsc` + `vite build`) is untouched; it runs unattended, before the prompt, never after the gesture.
- **No early prompt while Tier 0 runs.** The prompt keeps raising only on a settled Tier 0 ([P03] rationale): a "checks are running" prompt would offer a "Join now" the verdict gate must then refuse. The register's existing `reconciling`/`checking` lines already narrate the wait.
- **Dash rows still vanish on a landed join.** The Lens row, shade entry, and masthead `^dash` marker disappearing is correct; the durable trace is the receipt row and the success bulletin ([P04]), not a lingering ghost row.
- **No changes to the resolver ladder, occupancy, workshop lifecycle, or escalation flow.**
- **No unbound-dash prompt surface.** With Step 1 landed, the bind path covers the real case; an unbound dash keeps its passive Lens "Ready to join" line.

#### Dependencies / Prerequisites {#dependencies}

- The join-endgame machinery on main: `join_ready`, the pilot, `standing_prompt`, `DashJoinPrompt`, the prompt sheet, the register, the beats ([D142], [D147]).
- The landing receipt path: `record_landing_receipt` + `use-landing-receipts.ts` + `SessionJoinReceiptBlock` (all shipped; today exercised only by the composer route).

#### Constraints {#constraints}

- Warnings are errors (`-D warnings` via `tugrust/.cargo/config.toml`).
- Wire and payload changes must be additive/tolerant: an old client omitting `session_id` from the prompt answer must still join (the receipt is then skipped, as today).
- Branch-config facts already written on live branches must keep parsing after the `Verification` shape loses `tier1` (serde tolerance, Risk R01).
- `tugplug/` skill edits are inert until the app bundle is rebuilt — the checkpoint for Step 6 includes `just build-app`.

#### Assumptions {#assumptions}

- A control frame arrives on the instance whose shell ledger owns the answering session, so a `session_id` on the prompt answer reaches the right `ShellLedger` (this is how the composer route's receipt already works).
- `linked_worktree_base`'s pure-filesystem translation (`.git` file → `gitdir` → `commondir` → parent) holds for every dash worktree the engine creates; it is already load-bearing for instance discovery in `find_for_cwd`.
- One prompt per dash at a time; the `request_id` grammar `{name}:{base_sha}:{dash_head}:{decision}` is stable.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. The direction on all six points was reviewed and accepted 2026-08-21; the two judgment calls inside them — keep Tier 0 as the one join gate, keep the prompt post-settle — are decided in [P03].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Every stored verification fact stops parsing when the verdict line loses a field | **high** | **high without the fix** | the reader accepts a 3- **or** 4-field line (R01) — this is the single most breakable edit in the plan | any join reporting "unverified" after Step 3 |
| Per-head dismissal mark re-asks more often | low | low | `base_sha` is deliberately excluded from the key ([P02]), so a push to the base stays silent; only new rounds and flipped verdicts ask | user reports prompt nagging |
| Receipt row depends on the answering session's ledger | low | low | absent/empty `session_id` degrades to today's behavior (no receipt), never an error | missing receipts in the field |
| Recorded feed fixtures carry `tier1` on `DashJoinVerification` | med | med | the validator stops requiring it in the same commit; `changeset-types.test.ts` and the `join-mode-controller`/`dash-join-register`/`landing-notice` fixtures are updated in Step 3's task list | `bun test` fixture failures |

**Risk R01: the verdict is a colon-delimited line, and its field count is load-bearing** {#r01-old-facts}

- **Risk:** `write_verification` formats the verdict as `"{base}:{candidate}:{tier0}:{tier1}"` into one git-config value, and `read_verification` **rejects anything that is not exactly four fields** (`if parts.len() != 4 { return None; }`). This is not serde and there is no unknown-field tolerance to lean on. Dropping `tier1` from the writer without changing the reader makes every newly written fact unreadable; leaving the reader strict makes every *previously* written fact unreadable. Either half alone breaks every join with "this candidate is unverified".
- **Mitigation:** the reader accepts `parts.len()` of **3 or 4**, ignoring a fourth field when present; the writer emits three. Both halves land in the same commit, and a unit test pins a stored 4-field line and a stored 3-field line reading equal.
- **Residual risk:** none material — a fact that still fails to parse reads as `None` → "unverified", which re-resolving clears.

---

### Design Decisions {#design-decisions}

#### [P01] Binding reaches through a linked worktree at the gateway (DECIDED) {#p01-bind-through-worktree}

**Decision:** `same_project` in `dash_api.rs` resolves each side through the [L29] gateway **and then, when the path sits inside a linked git worktree, through `linked_worktree_base` to the base checkout** before comparing. `tugcore::registry::linked_worktree_base` is made `pub` and reused — one resolver, not a second implementation.

**Rationale:** The current docstring defends not reaching through ("`dash create` from inside one already names the checkout"), but the auto-bind path falsified that defense in the field: `claim_dash` passes the raw cwd, and `dash step start` is *documented* as "the resume path's 'I am working this dash'" — run from the one directory a dash run actually works in, it fails. The guard's purpose is to refuse **foreign projects**, and a dash worktree is not a foreign project; it is the same project's working copy. Resolving at the gateway (server-side) keeps [L29]'s one-gateway rule — the CLI still never canonicalizes.

**Alternatives considered:** teaching `claim_dash` to send the base checkout path (rejected: the CLI would be doing path resolution the gateway owns, a second quiet resolver beside [L29]); loosening the guard to a warning (rejected: a genuinely foreign bind should still refuse loudly).

#### [P02] "Not yet" declines this dash head, not every future green (DECIDED) {#p02-mark-is-the-state}

**Decision:** The dismissal mark stores `"{dash_head}:{decision}"` — **the dash head and the decision, deliberately not the base sha** — and `standing_prompt` suppresses the ask only when the current pair matches. A new round on the dash re-raises; a base move alone stays silent; a verdict that flips green→red re-raises because the decision word is half the key.

**Rationale, and the counter-argument it answers:** `prompt_mark_key`'s docstring in `tugrust/crates/tugdash-core/src/verify.rs` argues *against* keying on the head pair, and it is half right: "keyed on the pair, a dismissal would expire on any base move and the same question would be asked again on every push to `main`." That objection is entirely about **`base_sha`** — and it is correct, which is why `base_sha` is excluded from the key. It says nothing about `dash_head`, and `dash_head` is the fact that distinguishes the two cases the field report confused. A base move means *the same dash work, reconciled again* → stay silent, exactly as the docstring wants. A new round means *new work the user has not been asked about* → ask. The current key collapses both into the decision word, which is why finishing milestone M02 after declining at M01 never asks: same dash, same `clean`, new work, no prompt.

The existing docstring must be rewritten by this step rather than left standing, since it documents the opposite rule.

**Alternatives considered:** the full `{base_sha}:{dash_head}:{decision}` triple (rejected — it re-asks on every push to the base, the nag the docstring predicted); a time-based expiry (rejected — nothing about elapsed time makes a question new).

#### [P03] Tier 1 dies at join time — deleted, not disabled (DECIDED) {#p03-tier1-dies}

**Decision:** The Tier 1 machinery is removed end to end: `run_tier1` and `TIER1_TIMEOUT` in `verify.rs`; the `run_tier1` call in `finish_join_inner`; the both-tiers arm of `run_join_verification`; the `tier1` field of `Verification` (reader tolerant of old facts, R01); the `tier1` checks in `verdict_gate` (the gate judges Tier 0 alone); `verify_tier1` in `tugutil-core/src/config.rs` and `.tugtool/config.toml`; `scripts/verify-tier1.sh`; and every `tier1` mirror in tugdeck (`changeset-types.ts`, `join-mode-controller.ts`, `dash-join-register.ts`, `spike-join-arc.tsx`, and their tests). **Tier 0 remains the one join gate**, and the prompt keeps raising only on a settled Tier 0 verdict.

**Rationale:** [D142] already decided this ("Tier 1 verification at join time … is not run at join time by anything and is not rescheduled elsewhere") and the code drifted back. The user's 2026-08-21 direction is categorical: app-tests must not gate joins beyond what implementation ran, and a dash plan's own steps already ran the selection that bears on the change. Tier 0 survives because it is *not* a re-run: it checks the joined tree — base + dash, a tree that never existed during implementation — and it is minutes, scoped, and unattended. Deleting rather than disabling follows the standing rule that an unchecked registry is deleted: a config key nothing honors is a lie waiting to be believed.

**Alternatives considered:** keeping the runner for on-demand use (rejected: [D142] said "not rescheduled elsewhere," and an idle runner invites the next re-wiring); emptying only this repo's config (rejected: the gate would still refuse `tier1: Unrun` in projects that never declared it — the bug would merely move).

#### [P04] One feedback spine for every join route (DECIDED) {#p04-one-spine}

**Decision:** However a join starts — composer ⬆ or prompt sheet — it produces the same acknowledgments: (1) the durable `/dash-join` transcript receipt naming the landed sha; (2) live beat narration on the composer status row; (3) a danger bulletin on failure. **Success is announced by the receipt and the resting register, not by a bulletin** (decided 2026-08-21): the bulletin channel means "something went wrong" today, and making it carry good news for the first time buys volume at the cost of that meaning. The transcript row and the settled *"Joined `<dash>` into `<base>`"* sentence are both already in the user's line of sight.

**The mechanism is correlation, not a bypass.** The reason the prompt route is mute is not that its surfaces are missing — they all exist and are mounted unconditionally — but that nothing tells the client a join is in flight for this card. `LandingNoticeController` is mounted for `joinModeController` at all times (`session-card.tsx`), that controller subscribes to the verb store and reads `landError` straight from `verbStore.joinState(entryKey).error`, and `useLandingReceipts` appends the `/dash-join` row from `joinState(entryKey).summary`. All three go dark for a prompt-path join for one reason: `ChangesetVerbStore` drops **both** `changeset_join_ok` and `changeset_join_err` when `_joinInflight.get(key)` misses, and only `join()` ever populates that map. So the fix is to register the same correlation a composer press registers — a new `expectServerJoin(entryKey, workspaceKey, dash)` on the verb store, called when the sheet answers "join-now" — after which the failure bulletin, the live receipt append, and the phase transitions all work **with no further changes**. Server-side, the answer carries the session id ([S02]) so the durable ledger row is written too; client-side, the narration is set so the composer register has a target ([S03]).

**Rationale:** Every silence in the field report is one asymmetry: the composer route built a full feedback spine and the prompt route bypassed the one map that connects a card to it. Routing the second door through the first door's machinery is strictly better than teaching four surfaces to accept uncorrelated frames — a bypass would have to re-answer "which card?" at every one of them. It also resolves the "outcome unmounts itself" defect without ghost rows: the register on a vanishing dash row was never a viable host for a terminal fact, and the transcript is.

#### [P05] The run ends at the last step's checkpoint (DECIDED) {#p05-run-ends-at-last-checkpoint}

**Decision:** A checkpoint that passed is spent. The devise skeleton's Integration Checkpoint pattern is rewritten: an integration checkpoint may only verify what **no earlier step verified** — a cross-step behavior, a live smoke on a composed surface — and must never re-run a command an earlier checkpoint already ran green. The terminal full-sweep step is retired from the skeleton's pattern list and its worked example. The doctrine's "the workspace before the run ends" clause moves into the per-step bar ("the workspace `cargo nextest run` belongs to the last step that touched Rust"), and the doctrine gains the one-sentence rule: *"The run ends when the last step's checkpoint passes — report and stop; never re-run a checkpoint that already passed."* The doctrine's "Stop before the join" section is corrected to [D147]: the build is an offer, the mark is telemetry, the draft is the obligation.

**Rationale:** The multi-minute tail was traced to authored text, not machinery — so the fix is in the text that authors plans and the doctrine that governs runs. The value claim of the terminal sweep ("prove it all still works together") is already delivered by the steps themselves under the never-commit-red rule, and by Tier 0 on the *joined* tree, which is the only tree no step could test.

#### [P06] The prompt is the ending; the chip is the escape hatch (DECIDED) {#p06-prompt-is-the-ending}

**Decision:** `dash-implement` and `dash-on` stop printing the `/join <name>` gesture for a bound, armed dash. The run's ending narration is: what was built, that the draft is written, and — at most — *"the join prompt will raise when the checks settle."* The `/join <name>` chip survives in exactly two texts: `dash-join`'s no-draft stop, and a new short "escapes" paragraph naming the cases where the prompt genuinely cannot raise (an unbound session the user declines to bind, a legacy dash with no declared run and no mark).

**Rationale:** Three skill passages instruct printing the gesture against one doctrine sentence saying the arc speaks for itself; the model obeys the majority. With Steps 1 and 2 landed, the prompt's two silent-failure modes are gone, so the chip's role as a workaround ends and its presence only teaches the user that the dialog is not coming.

#### [P07] A failed join stays quiet until something changes (DECIDED) {#p07-failed-join-quiet}

**Decision:** When a join fails, the danger bulletin carries the news and the prompt records a dismissal for the current `(dash_head, decision)` pair rather than re-raising. A new round on the dash, or a verdict that flips, asks again; the composer `/join <name>` route is available throughout.

**Rationale:** Readiness survives a failed join — `join_ready` is derived from the run and the worktree, and none of that changed — and `do_changeset_join_prompt_answer` *clears* the mark on engagement, so without this the identical modal re-raises on the next recompute, on top of the failure the user is still reading. When the cause is persistent (a dirty base, a stale journal) that is a fail/ask/fail/ask loop asking a question whose answer just failed. Decided with the user 2026-08-21.

---

### Deep Dives {#deep-dives}

#### The endgame cost ledger — who runs what, today {#endgame-cost-ledger}

For one finished run, the tree gets verified up to **four** times: (1) each step's checkpoint, during the run; (2) the plan's terminal Integration Checkpoint step — the full sweep, again, on the same bytes; (3) `just app-debug` — a full build + sign + launch; (4) the pilot's Tier 0 on the joined tree, plus — today — Tier 1's app-test selection via the resolver, plus `run_join_verification`'s both-tiers arm. Of these, only (1) and the Tier 0 half of (4) verify anything not already verified. (2) is deleted by [P05]; the app-test half of (4) by [P03]; (3) was already demoted to an offer by [D147] and the doctrine text catches up in Step 5.

#### The mute prompt path, end to end {#mute-prompt-path}

`standing_prompt` raises the fact → `JoinPromptSheet` mounts on the bound card (`session-card.tsx`, gated by `boundDashEntry` and `landingActive`) → "Join now" → `answerPrompt` sends `{project_dir, dash, request_id, answer}` → `do_changeset_join_prompt_answer` re-derives the prompt, refuses a moved `request_id`, and on "join-now" calls `do_changeset_join` with `message: None`, `session_id: None`, `anyway: decision == "red"`. From there: `record_landing_receipt` early-returns on the `None`; the beats stream to `ChangesetJoinStore._land`, whose only mounts are the Lens Dashes row and the shade dash row; **both** `changeset_join_ok` and `changeset_join_err` are dropped by `changeset-verb-store.ts` because `_joinInflight` has no entry for this key (only `join()` ever writes that map), which silences the failure bulletin *and* the live receipt append at once; and on success `changeset_all_bump` removes the dash entry, unmounting the rows that held the settled register. Step 4 threads the session id through the first gap and registers the missing correlation for the rest ([S03]) — the surfaces themselves need no changes, because `LandingNoticeController` and `useLandingReceipts` are already mounted and already subscribed.

#### The bind guard, mechanically {#bind-guard-mechanics}

`POST /api/dash` bind → `owns_session` finds the session's ledger row → `same_project(&row.project_dir, project_dir)` compares `resolve_to_claude_form` of the recorded project against the CLI's cwd. A linked worktree's canonical path is a genuinely different directory (`.tug/worktrees/<name>` or wherever the engine placed it), so the compare fails and the verb warns: *"session … works … — it cannot bind a dash in …"*. `linked_worktree_base` reads the worktree's `.git` **file** (`gitdir:` line) → that gitdir's `commondir` → its parent, purely on the filesystem — the same translation `find_for_cwd` already trusts for instance discovery. [P01] applies it inside `same_project`, after the gateway, on both sides (a session could itself have been spawned in a worktree).

---

### Specification {#specification}

#### S01 — worktree-aware project identity {#s01-worktree-identity}

`same_project(a, b)` returns true when `through_base(resolve_to_claude_form(a)) == through_base(resolve_to_claude_form(b))`, where `through_base(p)` is `linked_worktree_base(p).map(resolve_to_claude_form).unwrap_or(p)`. The refusal message is unchanged for genuinely foreign projects. `claim_dash` and `binding_project` in `tugutil/src/dash.rs` are untouched — the CLI still sends its cwd, uncanonicalized.

#### S02 — the prompt answer names its session {#s02-answer-session}

`ChangesetJoinPromptAnswerPayload` gains optional `session_id: Option<String>` (absent/empty tolerated). `answerPrompt` in `changeset-join-store.ts` gains a `sessionId` parameter, supplied by the session card from its own session identity at the one call site. The "join-now" arm passes it into the join payload in place of `session_id: None`, which makes `record_landing_receipt` write the same `/dash-join` shell-exchange receipt the composer route writes, rendered by `SessionJoinReceiptBlock` via `use-landing-receipts.ts`.

#### S03 — the prompt route joins the spine {#s03-prompt-route-narration}

Answering "join-now" performs three client acts before the control frame goes out, and **nothing downstream changes**:

1. `ChangesetVerbStore` gains `expectServerJoin(entryKey, workspaceKey, dash)`, which sets `_joinInflight` for that key exactly as `join()` does but sends no frame. The session card calls it with `changesController.entryKey` — the same key `useLandingReceipts` and `JoinModeController` already read.
2. `JoinModeController` gains `narrateServerJoin(target)`, setting `narration` (which `registerTarget = this.target ?? this.narration` already consults) without entering interactive join mode, so the composer status row carries the beats and then the settled *"Joined `<dash>` into `<base>`"* sentence.
3. Host-level sheet dismissal (`showSheet` resolving with no submitted answer) answers "not-yet", matching ⎋ and "Chat about this".

With (1) in place these are free, and they are the whole reason to do it that way: `changeset_join_err` → `_setJoin(entryKey, {phase:"error"})` → `joinModeController.landError` → the `LandingNoticeController` already mounted unconditionally at `session-card.tsx` posts *"Join failed"*; `changeset_join_ok` → `_setJoin(entryKey, {phase:"done", summary})` → `useLandingReceipts` appends the `/dash-join` row live. **No success bulletin is posted** ([P04]).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Law |
|-------|------|-----|
| Land beats for the bound dash (composer status row) | existing `ChangesetJoinStore`, read via `useSyncExternalStore` — no new store | [L02] |
| Join-in-flight correlation for a server-initiated join | existing `ChangesetVerbStore._joinInflight` map, new entry point ([S03]) — no new store, no new subscription | [L02], [L22] |
| Prompt-route narration (`narration` on `JoinModeController`) | existing controller field, new setter; exposed through its existing snapshot | [L02] |
| Failure bulletin | existing `LandingNoticeController` channel, reached through `landError` — no new wiring | [L02], [L11] |
| Sheet dismissal → "not-yet" | event handling in `join-prompt-sheet.tsx`; no state added | — |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

- **Rust unit (tugcast/tugcore/tugdash-core):** `same_project` through a real scratch linked worktree (the fixture shape already used by `linked_worktree_base`'s own tests); prompt-mark write/read/suppress/re-raise table across head moves; `verdict_gate` table with Tier 0 alone; `pilot_action` unchanged-behavior pins.
- **bun unit (tugdeck):** `answerPrompt` payload carries the session id; verb-store posts the bulletin for a bound-dash error with no local press; register/narration snapshots for the server-join path; `changeset-types` validator without `tier1`.
- **App-test (scratch repo, existing dash fixture family):** one extension to the full-arc test — a prompt-sheet "Join now" ends with the receipt row visible in the transcript and the success bulletin posted. **No new app-test runs as any join gate** — these tests cover the features, in the implementation run, per the standing selection discipline.

#### What stays out of tests {#test-non-goals}

- No test drives `just app-test` from inside join verification — that path is deleted.
- No jsdom render tests; component behavior that needs pixels is pinned in the app-test extension.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Binding reaches through the worktree | pending | |
| #step-2 | The dismissal mark records the state it declined | pending | |
| #step-3 | Tier 1 leaves the join, everywhere | pending | |
| #step-4 | One feedback spine for every join | pending | |
| #step-5 | The run ends at the last checkpoint — the durable text says so | pending | |
| #step-6 | The skills stop pointing at the door | pending | |

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
- [ ] `verify.rs`: `write_prompt_mark` takes `dash_head` and `decision` and stores `"{dash_head}:{decision}"`. **Rewrite `prompt_mark_key`'s docstring** — it currently argues for the rule this step replaces; the new text must state why `dash_head` is in the key and `base_sha` is deliberately not ([P02]).
- [ ] `join_board.rs` `standing_prompt`: **move the `dash_head` `rev_parse` above the mark comparison** — today the mark check sits *before* both `rev_parse` calls, so the head is not yet in scope where it is now needed. Only the branch `rev_parse` moves; `base_sha` stays where it is, since it is not part of the key. Suppress only on an exact `(dash_head, decision)` match, and update the comment beside the compare.
- [ ] `agent_supervisor.rs`: the "not-yet" arm writes the pair from the re-derived prompt's `dash_head` + `decision`.
- [ ] Per [P07], the join-failure path records the same dismissal so a failed join does not immediately re-raise the identical ask.
- [ ] A legacy mark holding a bare decision word can never match a pair, so old dismissals expire on upgrade — the desired direction (the prompt returns).

**Tests:**
- [ ] `verify.rs` table: declined at (headB, clean) → suppressed at (headB, clean), raised at (headC, clean), raised at (headB, red); a legacy bare-word mark never suppresses.
- [ ] `join_board.rs`: the existing dismissal test extended two ways — a base move with an unchanged head stays silent (the docstring's objection, still honored), and a new round raises.

**Notes:** moving the branch `rev_parse` above the mark check means a dismissed dash pays one `git rev-parse` per recompute that it did not pay before. One process spawn against work the recompute already does; the `landing_message_preview` read on the raise branch is the more expensive neighbor and is unchanged.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugcast` green.

#### Step 3: Tier 1 leaves the join, everywhere {#step-3}

**Commit:** `tier 1 dies at join time; the gate judges the build alone`
**Depends on:** #step-2
**References:** [P03], R01 (#r01-old-facts), #endgame-cost-ledger

**Tasks:**
- [ ] `tugdash-core/src/verify.rs`: delete `run_tier1`, `TIER1_TIMEOUT`, and the `tier1` field of `Verification`. **`write_verification` emits three colon-separated fields and `read_verification` accepts three or four** (R01) — this pair is the step's one breakable edit. `fail_running` iterates `tier0` alone.
- [ ] `tugcast/src/feeds/join_resolver.rs`: delete the `run_tier1` call in `finish_join_inner` and the `run_tier1` helper; the green path ends at the recorded Tier 0 fact.
- [ ] `agent_supervisor.rs` `run_join_verification`: delete the `want_tier1` plumbing and the tier-selection parameter's tier-1 arm; the red-Tier-0 short-circuit that set `tier1 = Unrun` goes with it.
- [ ] `verdict_gate` in `tugdash-core/src/ops.rs`: judge `tier0` alone — delete the three `fact.tier1` clauses. **This is the only place Tier 1 still gates anything**; `join-mode-controller.ts` already documents "Tier 0 alone decides" and reads only `tier0`, so the client needs no verdict change.
- [ ] Delete `verify_tier1` from `tugutil-core/src/config.rs` (an existing project config still declaring the key becomes an ignored unknown field — no migration needed) and from `.tugtool/config.toml`; delete `scripts/verify-tier1.sh`. **Leave `tests/app-test/scripts/select-tests.ts` alone** — `just app-test`, `app-test-changed`, and the covers-check all depend on it.
- [ ] Delete `tier1` from the wire type `DashJoinVerification` in `tugcast-core/src/types.rs` and its mapping in `join_board.rs`.
- [ ] tugdeck sweep: `changeset-types.ts` (type + validator), the tier-1 paragraph in `join-mode-controller.ts`'s docstring, and the fixtures in `changeset-types.test.ts`, `join-mode-controller.test.ts`, `landing-notice.test.ts`, `dash-join-register.test.ts`, and `spikes/spike-join-arc.tsx`.

**Tests:**
- [ ] `verdict_gate` table: green Tier 0 alone passes; red refuses; `Unrun`/`Running` refuse; override and `--anyway` unchanged.
- [ ] `verify.rs` round-trip: a stored 4-field line and a stored 3-field line both parse, and agree on `base_sha`/`candidate_sha`/`tier0` (R01).
- [ ] `bun test` on the swept tugdeck modules.

**Notes:** no app-test pins the removed verdict wording — a search of `tests/app-test/*.test.ts` for the tier-1 sentences found none — so the app-test corpus should not move in this step. A red pin here means something else broke.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` (workspace — this step touches three crates and the shared types) green; `cd tugdeck && bunx tsc --noEmit && bun test` green; the re-aimed app-tests green via `just app-test <files>`.

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

**Tests:**
- [ ] bun: `answerPrompt` payload carries the session id; after `expectServerJoin`, a `changeset_join_err` frame settles the entry's join state to `error` (which is what feeds the bulletin) and a `changeset_join_ok` frame settles it to `done` carrying the summary (which is what feeds the receipt); controller snapshot after `narrateServerJoin` exposes a register target; sheet dismissal answers "not-yet".
- [ ] Rust: the parser accepts a payload with and without `session_id`; the receipt is recorded when present and skipped when absent.
- [ ] App-test: extend the full-arc scratch-repo test — prompt "Join now" → the `/dash-join` receipt row appears in the transcript naming the landed sha. (No success bulletin is asserted; there is none by [P04].)

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green; `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test` green; the extended app-test green via `just app-test <file>`.

#### Step 5: The run ends at the last checkpoint — the durable text says so {#step-5}

**Commit:** `a checkpoint that passed is spent; the skeleton retires the terminal sweep`
**Depends on:** #step-3
**References:** [P05], #endgame-cost-ledger

**Tasks:**
- [ ] `tuglaws/devise-skeleton.md`: rewrite the Integration Checkpoint pattern bullet — only what no earlier step verified, never a re-run of a passed checkpoint; rework the worked example (Step 5 in the skeleton) to a cross-step behavioral check; sweep the Deliverables/Exit-Criteria prose so it stops modeling a terminal full-sweep restatement.
- [ ] `tuglaws/dash-work-doctrine.md`: move the workspace-`nextest` clause into the last-Rust-step framing; add the one-sentence run-ending rule; correct "Stop before the join" to [D147] (build is an offer, mark is telemetry, draft is the obligation).
- [ ] Record the decision as the next `[D##]` entry in `tuglaws/design-decisions.md`, in the file's voice, citing [D142]/[D147] and naming the rejected alternative (the terminal sweep) so it is not re-proposed.

**Tests:**
- [ ] Prose-level grep assertions in the checkpoint (no unit tests for markdown).

**Checkpoint:**
- [ ] `grep -n "workspace before the run ends" tuglaws/dash-work-doctrine.md` finds nothing; `grep -n "Marking the dash .built. is what starts the arc" tuglaws/dash-work-doctrine.md` finds nothing; the skeleton's pattern bullet contains "no earlier step"; `tugutil plan lint` on this plan still exits 0 (the linter's step-shape rules must not have depended on the retired pattern).

#### Step 6: The skills stop pointing at the door {#step-6}

**Commit:** `the prompt is the ending; the chip is the escape hatch`
**Depends on:** #step-5
**References:** [P06]

**Tasks:**
- [ ] `tugplug/skills/dash-implement/SKILL.md` phase 3: delete the "Then point the user at the join gesture" passage; the ending narration is what was built, the draft, and *"the join prompt will raise when the checks settle"*; phase 5 reworded to describe the prompt as the normal door and `/join <name>` as the escape.
- [ ] `tugplug/skills/dash-on/SKILL.md`: same treatment for its join paragraph.
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
- The join path runs no app-tests, holds no `verify_tier1` residue, and gates on the build of the joined tree alone.
- Every join — prompt or composer — leaves a durable receipt, narrates its beats on the composer status row, rests a settled outcome sentence there, and posts a danger bulletin when it fails.
- The skeleton, doctrine, and skills say what the machinery now does; each check ran green inside the step that changed the code it covers, and nothing re-ran at the end — this plan has no terminal sweep, deliberately, per [P05].

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- **Phased ordering for implementation:** run as three invocations if desired — `Steps 1-2` (the silent-failure bugs; smallest, highest leverage), then `Steps 3-4` (the join's substance: what runs, what speaks), then `Steps 5-6` (the durable text). Each boundary is a clean stop with user-visible improvement; the dependencies encode this order.
- A "joined" archaeology surface — browsing past landed dashes (the receipts are the seed data).
- `dash bind`/`unbind` `--instance`/`--port` selection (carried from the previous arc's findings).
- Delete-or-graduate `DashFactsRun`/`dash-facts.tsx` (spike-only mount, noted 2026-08-21).
