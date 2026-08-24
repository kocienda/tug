## Plan Adoption — the dash owns its plan file {#plan-adoption}

**Purpose:** Give the plan file exactly one live home — the dash worktree — moved there by `tugutil` verbs with receipts, so the "I didn't copy/commit/merge the plan file" failure class is structurally impossible: adoption at `dash create --plan`, a standalone `dash adopt-plan` repair verb, divergence refusals at the step verbs, and a plan-aware join preflight.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-14 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-14, opus.** Reviewed `plan:98988c52207d0db9`. Lint: 0 errors, 0 warnings.
Oriented on: a first pass over the whole document, read against `tugdash-core/src/ops.rs`, `tugdash-core/src/dash.rs`, `tugutil-core/src/plan.rs`, `tugutil-core`'s `find_repo_root_from`, `tugutil/src/cli.rs`, and `tugutil/src/dash.rs`.
Applied: **[L23] violation — the phase as written introduced a data-loss path.** Adoption removes the base copy, and `release_in` tears down the worktree and deletes the branch with no plan awareness, so releasing a dash whose plan was untracked on base would have permanently destroyed the user's plan document (and, in the tracked-dirty case, their uncommitted edits). Added [P08], Risk R03, a new Step 5 that restores the plan to base before teardown, and an abandon-arm end-to-end test in the integration step; renumbered the doctrine and integration steps to 6 and 7. **Correctness — the base-cleanup command was wrong.** Table T01 specified `git checkout -- <rel>`, which restores from the *index*; since `dirty_tracked_paths` compares against HEAD, a **staged** plan edit would survive cleanup, leave the path permanently dirty, and make the [P05] refusal fire forever — falsifying S04's idempotence invariant. Corrected to `git checkout HEAD -- <rel>` with the reasoning recorded, plus a test. **Hole in Table T01 — a legitimate case was specified as an error.** "Base copy clean at HEAD, worktree copy absent" was an error row, but it is the live case where the user commits the plan on base *after* the dash was cut; it is now a `committed` row that copies the bytes into the worktree, and the genuine not-found case is narrowed to absent-in-both-roots. **Scope accuracy** — Step 2 claimed `create` callers in "tugcast, tugplug hooks, tests"; there is exactly one caller outside the crate (`run_create` in `tugutil/src/dash.rs`) and nothing in tugcast constructs a dash. Also noted that create's idempotent resume path returns before `run_post_create`, so the adoption call must sit on both exits. **Consequence the plan had not named** — the adoption commit makes `rev-list base..branch` non-zero, so a created-then-abandoned dash no longer reports the `empty` blocker and its "Release it to discard" affordance; recorded as a [P02] implication, and it is only safe because [P08] makes the abandon path lossless. **Grounding added**: a note that `<repo_root>/<rel>` composition is legitimate here because `find_repo_root_from` resolves a linked worktree to the main checkout (the [P09] trap of the prior phase), and a new #replay-and-stamp deep dive showing that `content_stamp` excludes the Review Record span and reduces ledger rows to anchor+title — which is *why* ledger replay cannot disturb review state and [P07] can leave the stale gate untouched. Law discipline ([L23], [D138], [L29], and the absence of tugdeck laws) written into Constraints.
Deferred: nothing — no question in this plan needed the user's judgment. The one call that looked like a product decision, restore-on-release versus refuse-to-release, has a correct answer under [L23] and was settled rather than asked.

---

### Phase Overview {#phase-overview}

#### Context {#context}

A plan is authored on the base checkout (`dash/*.md`), implemented on a dash worktree, and lands back on base at join. Today the plan is the only artifact in the dash system whose lifecycle crosses the two roots **by hand**: `dash-implement`'s setup prose says *"if it was committed on the base branch it already rode along; otherwise copy the file once."* That manual copy leaves a second live copy on base with no receipt and no divergence detection, and it has produced the same incident repeatedly, most recently the polish-lane join jail: an uncommitted base copy of the plan intersected the dash's changes to the same file, and the preflight reported generic `base-dirt` jail instead of recognizing the dash's own plan.

The machinery to fix this already exists. The dash records its plan in branch config (`branch.tugdash/<name>.tugplan`, written by `set_dash_plan_path` in `tugrust/crates/tugdash-core/src/dash.rs`), the join preflight computes intersecting base dirt (`blocking_base_dirt`, `tugrust/crates/tugdash-core/src/ops.rs`), and `tugutil_core::plan` provides `content_stamp` (which excludes ledger progress cells) and `set_ledger_status` (anchor-keyed row edits). The plan path just isn't consulted at any of the seams where the failure detonates. This phase wires it in and deletes the manual copy from the skill prose.

#### Strategy {#strategy}

- Fix at the verbs, not the prose: every plan movement becomes a `tugutil` verb that prints a receipt naming exactly what moved and what happened to the base copy. Prose instructions to copy files by hand are deleted.
- Adoption at birth: `dash create --plan <path>` transplants the plan into the fresh worktree as a commit on the dash branch, then cleans the base copy — one live copy from second zero.
- Repair for the rest: `dash adopt-plan <name>` applies the same transplant to an existing dash, with mechanical ledger replay so progress is never lost.
- Refuse over divergence: `dash step` refuses to run while a dirty or untracked base copy of the plan exists, naming `adopt-plan` as the remedy — divergence is a refusal with one right answer, never a silent state.
- Close both preflight holes: the tracked-dirt intersection names the plan and its remedy when the plan is what intersects, and the previously-invisible untracked-base-copy case (which `git merge --squash` refuses at integrate time) becomes a preflight blocker.
- Land the doctrine: the one-home rule becomes global decision [D139], the dash-lifecycle law gains an adoption section, and `dash-implement`'s setup shrinks to passing `--plan`.

#### Success Criteria (Measurable) {#success-criteria}

- `tugutil dash create <name> --plan dash/x.md` on a repo where `dash/x.md` is untracked leaves: the file committed on the dash branch, absent from the base checkout, and recorded in `branch.tugdash/<name>.tugplan` (Rust test asserts all three).
- After any successful adoption, `git status --porcelain -- <plan-path>` at the repo root prints nothing (asserted in every transplant test).
- `tugutil dash step <name> start <n>` with a dirty base copy of the plan exits non-zero and its message contains `adopt-plan` (Rust test).
- `tugutil dash join <name> --preview` with a dirty base copy of the plan reports a blocker whose detail names the plan path and `adopt-plan`; with an untracked base copy at a path the dash changed, it reports a blocker instead of previewing clean and failing at integrate (Rust tests).
- A transplant over a worktree copy with ledger progress preserves every row's status and commit cell (Rust test asserts a `done` row survives the transplant byte-for-byte in the ledger), and the document's `content_stamp` is unchanged by the replay (Rust test — this is what keeps a `reviewed` plan reviewed across adoption).
- `tugutil dash release <name>` on a dash whose plan was untracked on base leaves that plan file at the repo root afterward (Rust test) — no verb in the system destroys a plan document.
- Adoption is idempotent against a **staged** base edit: after one `adopt_plan_in`, `git diff --name-only HEAD` at the root no longer lists the plan, and a second run reports `inherited` (Rust test — this is the `git checkout HEAD --` correction, not a bare `git checkout --`).
- `tugplug/skills/dash-implement/SKILL.md` contains no instruction to copy the plan by hand and no two-copy comparison dialog (checkpoint grep).

#### Scope {#scope}

1. A transplant engine in `tugdash-core` shared by `create --plan` and `adopt-plan`, with a machine-readable receipt.
2. CLI surface: `--plan` on `tugutil dash create`, new `tugutil dash adopt-plan` subcommand.
3. Divergence refusal in the `dash step` verbs.
4. Plan-aware join preflight: specialized tracked-dirt detail plus the untracked-overwrite blocker.
5. Plan-aware release: the adopted plan goes back to base before the branch is torn down ([P08]).
6. Doctrine and prose: [D139] in `tuglaws/design-decisions.md`, an adoption section in `tuglaws/dash-lifecycle.md`, and the `dash-implement` setup rewrite.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No tugdeck/frontend work. The preflight improvements travel inside the existing `base-dirt` blocker kind's `detail` string, so the Session card's four-outcome face and the join overlay render them with zero changes; the one tugcast touch ([P08]'s release-summary line) is a server-side string. A divergence chip in the Changes card is a follow-on, not this phase.
- No content merging of plan bodies. The transplant takes the base body and replays ledger cells; it never attempts a prose merge of two edited bodies.
- No change to where plans are authored. `plan-devise` still writes to the path the user names on the base checkout; adoption happens when a dash takes the plan up.
- No migration sweep of existing dashes. `adopt-plan` is on-demand repair; nothing walks old dashes proactively.

#### Dependencies / Prerequisites {#dependencies}

- `tugutil_core::plan::content_stamp` and `set_ledger_status` (`tugrust/crates/tugutil-core/src/plan.rs`) — both shipped.
- `branch.tugdash/<name>.tugplan` config key and `dash_plan_path`/`set_dash_plan_path` (`tugrust/crates/tugdash-core/src/dash.rs`) — shipped.
- `blocking_base_dirt`, `join_preflight_in`, `with_dash_trailers`, `append_dash_log` (`tugrust/crates/tugdash-core/src/ops.rs`) — shipped.

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** (`tugrust/.cargo/config.toml` enforces `-D warnings`).
- Adoption commits happen only on the dash branch, in the dash worktree — never on base. Cleaning the base copy touches the base *working tree* (restore-to-HEAD or remove an untracked file) but never base history. This stays inside the established dash-verb exception to the only-the-user-commits rule.
- The base copy is cleaned only **after** its bytes are reachable from the dash branch (commit succeeded) or proven redundant (byte-identical / progress-only). No ordering may exist in which the user's edits are unreachable.
- Receipts everywhere: every action that moves or removes a file prints what it did in both `--json` and human output.
- **Law discipline.** Three laws apply, each honored deliberately. **[L23]** — an internal operation must never lose, destroy, or cease to apply user-visible state — governs the whole phase: the plan document *is* user-visible state, which is why the R01 ordering invariant and [P08]'s release restoration are structural requirements rather than niceties. **[D138]** — derive vs declare; read paths never mint; a path handed outward is absolute — adoption is a *declaration*, carried by a commit plus a dash-log line, and introduces no new stage and no new config surface (`dash_plan_path` is an existing key). **[L29]** — path canonicalization — is not engaged: every path here is repo-relative or comes from `find_repo_root_from`, and none is persisted or compared as a raw absolute. No tugdeck laws apply; there is no frontend state, hence no State Zone Mapping.

#### Assumptions {#assumptions}

- Plans live inside the repository (tracked or untracked), never outside it; `resolve_plan_rel`'s inside-the-worktree invariant generalizes to inside-the-repo.
- During implementation, the worktree copy's body is edited only by review rounds and the step verbs' ledger writes — both committed on the branch — so the branch history is a sufficient safety net for the transplant's overwrite (Risk R02).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. The direction (transplant at create, standalone adopt-plan, refusals, plan-aware preflight) was decided in conversation on 2026-08-14 after the polish-lane join jail; the remaining calls are recorded as [P01]–[P07].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Transplant loses user base edits | high | low | Clean base only after the commit lands; receipts name the adoption commit | Any report of missing plan content |
| Release destroys the only copy of an adopted plan | high | med | [P08]: restore the plan to base before teardown | Any release that leaves no plan on base |
| Transplant loses worktree ledger progress | med | low | Mechanical replay via `set_ledger_status`; dropped rows reported | A receipt listing dropped rows |
| Untracked-copy preflight over-blocks | low | low | Blocker only when the untracked path intersects the dash's changed set | A blocked join with no real overlap |

**Risk R01: Cleaning the base copy destroys uncommitted user edits** {#r01-base-edits}

- **Risk:** Restore-to-HEAD (tracked) or removal (untracked) of the base copy deletes bytes the user typed.
- **Mitigation:** Ordering invariant — the engine reads the base bytes, writes and commits them on the dash branch, and only then cleans base. On any commit failure the base copy is untouched. The receipt names the adoption commit hash and the base action taken.
- **Residual risk:** A user who edits the base copy *between* adoption and join edits a file the system restored; the step-verb refusal and the preflight both catch it and name `adopt-plan`.

**Risk R03: Release discards a plan that lives only on the dash branch** {#r03-release-loss}

- **Risk:** Adoption removes the base copy; `release_in` removes the worktree and deletes the branch. Between those two facts, `tugutil dash release <name>` permanently destroys a plan that was untracked on base — and destroys the user's uncommitted edits when it was tracked-dirty.
- **Mitigation:** [P08] — restore the branch's plan bytes to `<repo_root>/<rel>` before teardown, reported in the receipt. Step 5 tests both the untracked and tracked-dirty shapes.
- **Residual risk:** A plan the user deleted from the worktree on purpose during the dash is restored to base on release. Recoverable by deleting it again, and strictly preferable to the alternative.

**Risk R02: Transplant overwrites uncommitted worktree body edits** {#r02-worktree-body}

- **Risk:** `adopt-plan` writes the base body over the worktree copy; an uncommitted body edit on the worktree side (rare — bodies are edited by committed review rounds) would be replaced.
- **Mitigation:** Ledger cells are replayed, so verb-written progress survives. Committed body history remains on the branch. The receipt reports when the pre-transplant worktree bytes differed from the worktree HEAD version, so nothing vanishes silently.
- **Residual risk:** An uncommitted worktree body edit is folded away; recoverable only from the receipt's warning, not from git.

---

### Design Decisions {#design-decisions}

#### [P01] The plan has exactly one live copy: the worktree's (DECIDED) {#p01-one-live-copy}

**Decision:** From the moment a dash adopts a plan, the worktree copy is the only live copy; any base-side copy that is not simply the committed base HEAD state is a defect that the verbs either transplant or refuse over.

**Rationale:**
- Every incident in this failure class traces to two live copies moved by hand. [D138] already establishes that state crossing the roots is verb-owned; the plan file was the last exception.
- A committed, clean base copy is *not* a second live copy — it is ordinary branch divergence that the join squash resolves like any other file.

**Implications:**
- The skill prose may no longer instruct a copy; the compare-copies dialog in `dash-implement` setup is deleted (the state it arbitrated can no longer arise silently).
- Base-side plan dirt (tracked-dirty or untracked at the recorded plan path) becomes a first-class detectable condition with one remedy verb.

#### [P02] `dash create --plan` transplants at birth (DECIDED) {#p02-create-transplant}

**Decision:** `tugutil dash create <name> --plan <path>` performs adoption as part of creation: resolve the plan, ensure its bytes are committed on the dash branch, record `branch.tugdash/<name>.tugplan`, and clean the base copy — per Table T01.

**Rationale:**
- The fresh-worktree case has no ledger progress to preserve, so adoption at birth is the cheapest, safest moment.
- It replaces `dash-implement` setup's manual step ("copy the file once") with a verb and a receipt.

**Implications:**
- `CreateOutcome` grows an optional `plan` receipt object (Spec S02).
- Adoption runs after `run_post_create` succeeds, so create's existing rollback (worktree + branch removal on hook failure) never has to un-clean base. A transplant failure after a successful hook also rolls the worktree and branch back, and by the R01 ordering the base copy is still intact.
- The idempotent resume path (`created: false`) with `--plan` delegates to the [P03] engine, so re-running create is a repair, not an error. Note this path returns *before* `run_post_create` in today's `create`, which is correct — a resume must not re-hydrate — so the adoption call has to sit on both exits, not only the fresh one.
- **A dash adopted at birth is never `empty`.** `join_preflight_in` derives its `empty` blocker from `rev-list --count base..branch`, and the adoption commit makes that 1 before any work lands — so a created-then-abandoned dash now offers a join (of a plan-file-only change) where it previously offered "Nothing to join… Release it to discard." This is acceptable *because* of [P08]: releasing that dash hands the plan back to base, so the abandon path stays lossless. Without [P08] it would be a trap.

#### [P03] `dash adopt-plan` is the standalone transplant, with mechanical ledger replay (DECIDED) {#p03-adopt-plan}

**Decision:** `tugutil dash adopt-plan <name> [--plan <path>]` runs the same engine against an existing dash. When bodies differ (`content_stamp` inequality), the base body wins and the worktree's ledger progress is replayed onto it row-by-row via `set_ledger_status`; rows whose anchors vanished are reported as `dropped_rows`, never a failure.

**Rationale:**
- `content_stamp` deliberately excludes ledger status cells, commit cells, and task checkboxes, so stamp equality *is* the "progress-only divergence" test — no bespoke diffing.
- The ledger is the only worktree-authored content under normal operation ([P01] assumption), so replay makes the transplant lossless in the common case and loudly lossy in the rare one (Risk R02).
- Replay direction is fixed (base body + worktree progress) because the base copy is where the user types and the worktree ledger is where the verbs write; there is no case where the reverse is right.

**Implications:**
- `--plan` is required only when the dash has no recorded plan path; otherwise `dash_plan_path` supplies it.
- Progress-only divergence needs no commit: the worktree copy already holds everything; the base copy is cleaned and the receipt says `cleaned`.
- The dash-log records each adoption commit (`append_dash_log` with the adoption commit marker), so `dash show`/`status` narrate it like any round.

#### [P04] Adoption commits are surgical and carry the dash trailers (DECIDED) {#p04-surgical-commit}

**Decision:** An adoption commit stages exactly the plan path (`git -C <worktree> add -- <rel>`), never `-A`, with subject `tugdash(<name>): adopt plan <rel>` passed through `with_dash_trailers`.

**Rationale:**
- `adopt-plan` must be safe mid-step, when the worktree holds uncommitted round work that belongs to the *next* `dash commit`, not to adoption.
- Trailers keep adoption commits attributable like every other dash round.

**Implications:**
- Pending ledger cells on the worktree copy (a `start` not yet committed) fold into the adoption commit — harmless, since the replay preserves them and the round commit would have carried them anyway.

#### [P05] `dash step` refuses over base plan dirt (DECIDED) {#p05-step-refusal}

**Decision:** `step_in` (both `start` and `done`), after resolving the plan rel, checks the base side: if `<repo_root>/<rel>` is tracked-dirty or untracked, the verb exits non-zero with `base copy of the plan has uncommitted changes at <rel>; run: tugutil dash adopt-plan <name>` and touches nothing.

**Rationale:**
- The step verbs are the run's heartbeat — every run entry and every round boundary passes through them, so this is the earliest automatic detection point that needs no new plumbing.
- Refusal (not auto-adopt) keeps the step verbs single-purpose; the remedy is one named command away and the agent running the step can execute it immediately.

**Implications:**
- A user editing the base copy mid-run surfaces at the next step verb, not at join. `dash-implement`'s pragmatics gain one line telling the agent to run the named remedy and retry — this is a verb refusal with exactly one right answer, so it is *not* one of the skill's ask-forks.

#### [P06] The join preflight is plan-aware, and the untracked hole is closed (DECIDED) {#p06-preflight}

**Decision:** Two changes to `join_preflight_in`/the execute path, both inside the existing `base-dirt` blocker kind: (a) when the tracked-dirt intersection includes the dash's recorded plan path, the detail names it — `includes this dash's own plan (<rel>) — run: tugutil dash adopt-plan <name>`; (b) untracked files at the repo root that intersect the dash's changed set become a `base-dirt` blocker (they are invisible to `dirty_tracked_paths` today, and `git merge --squash` refuses to overwrite them at integrate time — a clean preview followed by a failing join).

**Rationale:**
- Reusing kind `base-dirt` means zero wire and zero tugdeck changes — the card already renders blocker details verbatim.
- The untracked check is scoped to the intersection with the dash's changed set for the same reason tracked dirt is ([P14] of the join phase): disjoint untracked files cannot collide with the squash.
- (b) is a general correctness fix, not plan-specific — but the plan file is its dominant real-world instance (the manual-copy leftover).

**Implications:**
- `blocking_base_dirt` grows an untracked component (`git ls-files --others --exclude-standard` at the repo root, intersected with `dash_changed`); its callers are unchanged.
- The execute path's inline check shares the same detail strings, so a join attempted past a stale preview refuses with the same words.

#### [P08] Release restores the adopted plan to base before teardown (DECIDED) {#p08-release-restores}

**Decision:** `release_in` (`tugrust/crates/tugdash-core/src/ops.rs`), before removing the worktree and deleting the branch, writes the dash branch's copy of the recorded plan back to `<repo_root>/<rel>` whenever those bytes differ from what base HEAD holds, and reports it as `ReleaseOutcome.plan_restored: Option<String>`.

**Rationale:**
- Adoption *removes* the base copy. Without this, releasing a dash whose plan was untracked on base destroys the user's plan document permanently — the bytes exist only on a branch that release deletes. This phase would have introduced a fresh instance of exactly the data-loss class it exists to eliminate.
- The tracked-dirty case is no better in kind: the user's uncommitted edits live only on the dash branch, and release would discard them with no trace.
- Release means "discard the work". A plan is not the work — it is the authored document that predates the dash and outlives it. The symmetry is the point: adoption moves the plan in, release moves it back out.
- [L23] states it as law: an internal implementation operation must never lose or destroy user-visible state. Adoption is exactly such an operation, and without this decision it would convert an ordinary discard into permanent data loss.
- The existing discard preflight (`format_release_summary`, `tugrust/crates/tugcast/src/feeds/changeset.rs`) lists round subjects so the user sees what they are throwing away. It is a summary, not a guard, and it says nothing about the plan — so it cannot carry this.

**Implications:**
- Restoration is unconditional-but-quiet: nothing to restore when the branch's plan matches base HEAD, so an untouched dash releases exactly as it does today.
- The restored file lands as base working-tree dirt (untracked if it was untracked before adoption), which is precisely the state the user was in before creating the dash. Release commits nothing on base.
- `ReleaseOutcome` gains one field; `format_release_summary` gains one line when it is set. The wire kind is unchanged, so no tugdeck work.

#### [P07] The doctrine lands as [D139] and the skill prose shrinks (DECIDED) {#p07-doctrine}

**Decision:** The one-home rule becomes global decision [D139] in `tuglaws/design-decisions.md`; `tuglaws/dash-lifecycle.md` gains a "Plan adoption" section; `dash-implement`'s setup replaces the manual copy step and the two-copy comparison dialog with `create --plan`, and its pragmatics name `adopt-plan` as the mid-run remedy.

**Rationale:**
- The failure recurred precisely because the rule lived in prose nobody enforces. The verbs enforce it; the laws record why; the skill stops teaching the landmine.

**Implications:**
- The stale-review gate in `dash-implement` setup survives unchanged — it reads the worktree copy, which adoption guarantees exists and is canonical.

---

### Deep Dives {#deep-dives}

#### The transplant state machine {#transplant-states}

The engine (`adopt_plan_in`) observes the base copy at `<repo_root>/<rel>` and the worktree copy at `<worktree>/<rel>` and acts per Table T01. `repo_root` here is always the **main** repository root: `step_in` and the engine both reach it through `find_repo_root`/`find_repo_root_from` (`tugrust/crates/tugutil-core/src/`), which resolves a linked worktree to the main checkout via `--git-common-dir`. Composing `<repo_root>/<rel>` is therefore legitimate — `rel` is repo-relative and means the same file in both roots — which is the distinction the [P09] worktree-root trap of the previous phase turned on.

"Base dirt" means the rel is **tracked-dirty** (`git diff --name-only HEAD` at the repo root contains it — note this includes *staged* changes, since the comparison is against HEAD, not the index) or **untracked** (`git ls-files --others --exclude-standard` contains it).

**Table T01: base copy state → engine action** {#t01-transplant}

| Base copy | Worktree copy | Action | Receipt `action` | Base cleanup |
|-----------|---------------|--------|------------------|--------------|
| clean at HEAD (or absent) | present | record config only | `inherited` | `untouched` |
| clean at HEAD (committed on base after the dash was cut) | absent | copy base bytes into the worktree → surgical commit | `committed` | `untouched` |
| absent on base | absent | error: `plan not found at <rel> in either the worktree or the repo root` | — | `untouched` |
| dirt | absent | copy bytes → surgical commit → clean base | `committed` | `restored` / `removed` |
| dirt, byte-identical to worktree copy | present | clean base only | `cleaned` | `restored` / `removed` |
| dirt, `content_stamp` equal (progress-only divergence) | present | clean base only — the worktree ledger is authoritative | `cleaned` | `restored` / `removed` |
| dirt, `content_stamp` differs | present | base body + ledger replay → write atomic → surgical commit → clean base | `committed` | `restored` / `removed` |

Row 2 is a live case, not a theoretical one: the user commits the plan on base *after* the dash was cut, so the worktree — created from an older base — never saw the file. There is nothing to clean (the base copy is committed and clean), but the worktree still needs the bytes before any step verb can drive the ledger.

Base cleanup runs **last**, only after the action's commit (if any) has succeeded — the R01 ordering invariant — and is:

- **tracked path**: `git checkout HEAD -- <rel>` at the repo root. It must name `HEAD` explicitly. A bare `git checkout -- <rel>` restores from the *index*, so a **staged** plan edit would survive the "cleanup" and the path would still read as dirty against HEAD — the refusal ([P05]) would fire forever and S04 invariant 5 (idempotence) would be false. `git checkout HEAD -- <rel>` updates index and worktree together.
- **untracked path**: remove the file.

If the base copy fails to parse as a plan in a replay row, the transplant still proceeds (the body is data; parse is only needed to replay the ledger) — but replay requires parsing *both* documents, so an unparseable incoming body downgrades to a byte copy with `dropped_rows` listing every progressed row, reported loudly.

#### Why ledger replay cannot disturb the review stamp {#replay-and-stamp}

`content_stamp` (`tugrust/crates/tugutil-core/src/plan.rs`) skips every line inside `review_record_span` and reduces each ledger row to `| #<anchor> | <title> |`, discarding the status and commit cells. Replaying progress onto the base body therefore produces a document with the *same* content stamp as the base body it came from, and the Review Record — including the round's `plan:<hash>` token — travels verbatim. So a plan that was `reviewed` before adoption is `reviewed` after it, and one that was `stale` stays `stale` for the same reason it already was. This is what lets [P07] leave `dash-implement`'s stale-review gate untouched: adoption is invisible to it by construction, not by luck.

#### Resolving the plan path at create time {#create-resolution}

`resolve_plan_rel` (`ops.rs`) requires the file inside the worktree — correct for `dash step`, wrong for `create --plan dash/x.md` invoked from the base checkout where the file may exist only on base. A generalized resolver, `resolve_plan_rel_anywhere(repo_root, worktree, plan)`, accepts an absolute or relative path, tries the worktree first and the repo root second, and returns the root-relative rel; a path outside both roots is an error. `dash step` keeps the strict resolver — by the time steps run, adoption has put the file in the worktree.

#### Why the polish-lane jail happened, mechanically {#jail-mechanics}

The user's base checkout held uncommitted edits to `dash/dash-integration-5-polish.md`; the dash had committed changes to the same rel (ledger progress). `blocking_base_dirt` correctly intersected them and the join refused with the generic `base_dirt_detail` — "Commit or stash them first" — which is the wrong remedy for the plan file (committing the stale base copy on main enshrines a fork; stashing hides it to detonate later). The right remedy, transplant, did not exist. This phase makes the message name the right remedy and makes the state that required it unreachable through the normal flow.

---

### Specification {#specification}

**Spec S01: CLI surface** {#s01-cli}

```
tugutil dash create <name> [--description <d>] [--plan <path>] [--json]
tugutil dash adopt-plan <name> [--plan <path>] [--json]
```

- `create --plan`: adoption per [P02] after hydration; on the idempotent resume path it delegates to the adopt engine. Human output appends one line per receipt field of interest: `Adopted plan dash/x.md (commit ab12cd3, base copy removed)`.
- `adopt-plan`: [P03]. `--plan` required only when `branch.tugdash/<name>.tugplan` is unset; when given, it also records the path. Errors: unknown dash; dash worktree missing (`Dash not found or not active: <name>`, matching `step_in`'s existing wording); no plan recorded and no `--plan`; plan outside the repo; plan absent from both roots (Table T01 row 3).

**Spec S02: receipts** {#s02-receipts}

`AdoptOutcome` (also embedded as `CreateOutcome.plan`):

```json
{
  "dash": "polish-lane",
  "plan_path": "dash/x.md",
  "action": "committed" | "cleaned" | "inherited",
  "commit": "ab12cd3" | null,
  "base_copy": "restored" | "removed" | "untouched",
  "dropped_rows": ["#step-4"],
  "warnings": ["worktree copy had uncommitted body edits; superseded bytes are not in git"]
}
```

`dropped_rows` and `warnings` are empty arrays in the normal case. `CreateOutcome.plan` is `None`/omitted when create ran without `--plan`.

`ReleaseOutcome` ([P08]) gains one field, `plan_restored: Option<String>` — the repo-relative path the plan was written back to, or `None` when there was nothing to hand back. The human receipt reads `Restored dash/x.md to the base checkout.`

**Spec S03: refusal and blocker strings** {#s03-strings}

- Step refusal ([P05]): `base copy of the plan has uncommitted changes at <rel>; run: tugutil dash adopt-plan <name>`
- Tracked-dirt detail when the plan intersects ([P06]a) — `base_dirt_detail` output becomes: `Cannot join: the base worktree has uncommitted changes to files this dash also changed (<paths>). This includes the dash's own plan (<rel>) — run: tugutil dash adopt-plan <name>. Commit or stash the rest first.` (The plan sentence appears only when the intersection contains the recorded plan path; otherwise the existing message is unchanged.)
- Untracked-overwrite detail ([P06]b): `Cannot join: untracked files at the repo root would be overwritten by this dash (<paths>). Move them aside — or, for the dash's own plan, run: tugutil dash adopt-plan <name>.` (Plan sentence under the same condition.)

**Spec S04: engine signature and invariants** {#s04-engine}

```rust
pub fn adopt_plan_in(repo_root: &Path, name: &str, plan: Option<&str>) -> Result<AdoptOutcome, String>
pub fn adopt_plan(name: &str, plan: Option<&str>) -> Result<AdoptOutcome, String>  // find_repo_root wrapper
```

Invariants, each backed by a test in Step 1:

1. Base cleanup never precedes commit success (R01).
2. The adoption commit stages only `<rel>` ([P04]).
3. `branch.tugdash/<name>.tugplan` is set on every non-error exit.
4. Replay preserves every worktree ledger row whose anchor survives; the rest land in `dropped_rows`.
5. The engine is idempotent: a second run with no new base dirt returns `inherited` and changes nothing.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `AdoptOutcome` | struct | `tugrust/crates/tugdash-core/src/ops.rs` | Spec S02 |
| `adopt_plan_in` / `adopt_plan` | fn | `tugrust/crates/tugdash-core/src/ops.rs` | Spec S04, Table T01 |
| `resolve_plan_rel_anywhere` | fn | `tugrust/crates/tugdash-core/src/ops.rs` | (#create-resolution) |
| `base_plan_dirt` | fn | `tugrust/crates/tugdash-core/src/ops.rs` | tracked-dirty / untracked / clean classifier for one rel |
| `create` | fn (modify) | `tugrust/crates/tugdash-core/src/ops.rs` | gains `plan: Option<&str>`; `CreateOutcome` gains `plan: Option<AdoptOutcome>` |
| `step_in` | fn (modify) | `tugrust/crates/tugdash-core/src/ops.rs` | [P05] refusal |
| `blocking_base_dirt` | fn (modify) | `tugrust/crates/tugdash-core/src/ops.rs` | untracked component ([P06]b) |
| `base_dirt_detail` | fn (modify) | `tugrust/crates/tugdash-core/src/ops.rs` | plan-aware sentence ([P06]a); gains the plan-rel + dash-name context |
| `release_in` | fn (modify) | `tugrust/crates/tugdash-core/src/ops.rs` | [P08] restore before teardown |
| `ReleaseOutcome` | struct (modify) | `tugrust/crates/tugdash-core/src/ops.rs` | gains `plan_restored: Option<String>` |
| `format_release_summary` | fn (modify) | `tugrust/crates/tugcast/src/feeds/changeset.rs` | one line when `plan_restored` is set |
| `DashCommands::Create` | enum (modify) | `tugrust/crates/tugutil/src/cli.rs` | `--plan` |
| `DashCommands::AdoptPlan` | enum variant | `tugrust/crates/tugutil/src/cli.rs` | Spec S01 |
| `run_adopt_plan` | fn | `tugrust/crates/tugutil/src/dash.rs` | receipt printing, `--json` |

#### New files (if any) {#new-files}

None. All Rust work lands in existing modules; doctrine lands in existing tuglaws files.

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md` — append [D139] (one live copy; verbs move it; refusals elsewhere; the plan comes back on release), citing [D138] and [L23]. [D139] is the next free number — 138 is the current maximum.
- [ ] `tuglaws/dash-lifecycle.md` — "Plan adoption" section: Table T01's behavior in prose, the R01 ordering invariant, the remedy verb, and the adoption/release symmetry.
- [ ] `tugplug/skills/dash-implement/SKILL.md` — setup rewrite per [P07]; pragmatics line for the [P05] refusal.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust, real git fixtures)** | Every Table T01 row, every S04 invariant, both preflight holes | The whole phase — this is git plumbing; the existing `ops.rs` test style (tempdir repos, real `git` commands) is the harness |
| **Integration (Rust)** | create → step → join end-to-end with a plan adopted at birth | Step 7 |

#### What stays out of tests {#test-non-goals}

- App-tests — no frontend surface changes ([P06] deliberately reuses the `base-dirt` kind so tugdeck is untouched); the blocker-rendering path is already pinned by the join-phase app-tests.
- Prose/skill files — checked by checkpoint greps, not tests; skills are instructions, not code.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The transplant engine | done | `4a83b7177` |
| #step-2 | Adoption at create, and the CLI verbs | done | `55fd489e8` |
| #step-3 | The step verbs refuse over base plan dirt | done | `ed28a0e44` |
| #step-4 | The plan-aware join preflight | done | `eb36feb48` |
| #step-5 | Release hands the plan back | done | `c7df08013` |
| #step-6 | Doctrine and skill prose | done | `ef3e06e3b` |
| #step-7 | Integration checkpoint | done | `1e8a4834c` |

#### Step 1: The transplant engine {#step-1}

**Commit:** `tugdash(plan-adoption): adopt_plan_in — the transplant engine with ledger replay`

**References:** [P01] one live copy, [P03] adopt-plan, [P04] surgical commit, Spec S02, Spec S04, Table T01, (#transplant-states, #create-resolution)

**Artifacts:**
- `AdoptOutcome`, `adopt_plan_in`/`adopt_plan`, `base_plan_dirt`, `resolve_plan_rel_anywhere` in `tugrust/crates/tugdash-core/src/ops.rs`.
- Dash-log line per adoption commit via `append_dash_log`.

**Tasks:**
- [ ] Implement `base_plan_dirt` (classifier: clean / tracked-dirty / untracked for one rel at the repo root).
- [ ] Implement `resolve_plan_rel_anywhere` per (#create-resolution).
- [ ] Implement `adopt_plan_in` per Table T01 with the R01 ordering invariant and [P04] surgical staging; wire `with_dash_trailers` and `append_dash_log`. Base cleanup is `git checkout HEAD -- <rel>` for a tracked path (never a bare `git checkout --`, per #transplant-states) and file removal for an untracked one.
- [ ] Ledger replay via `tugutil_core::plan::parse` + `set_ledger_status`; `content_stamp` equality as the progress-only test; `dropped_rows` for vanished anchors; unparseable incoming body downgrades to byte copy with all progressed rows reported dropped.

**Tests:**
- [ ] One test per Table T01 row (seven), each asserting the receipt `action`, the base cleanup, and `git status --porcelain -- <rel>` empty at the root afterward (except the `absent on base` error row, which asserts the message).
- [ ] Row 2 specifically: plan committed on base *after* the dash was cut → the bytes land in the worktree and on the branch, base untouched.
- [ ] Staged base edit: one run leaves the path clean against HEAD and a second returns `inherited` — the `git checkout HEAD --` behavior a bare `git checkout --` would fail.
- [ ] Replay preservation: a `done` row with a commit cell survives a body-edit transplant, and `content_stamp` of the result equals `content_stamp` of the incoming base body.
- [ ] R01 ordering: a forced commit failure (e.g. bad worktree state) leaves the base copy intact.
- [ ] Idempotence: second run returns `inherited`, no new commit.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 2: Adoption at create, and the CLI verbs {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(plan-adoption): dash create --plan and the adopt-plan verb`

**References:** [P02] create transplant, Spec S01, Spec S02, (#create-resolution)

**Artifacts:**
- `create` gains `plan: Option<&str>`; `CreateOutcome.plan: Option<AdoptOutcome>`; adoption runs after `run_post_create`, with worktree/branch rollback on transplant failure.
- `DashCommands::Create { plan }`, `DashCommands::AdoptPlan`, `run_adopt_plan` with human + `--json` receipts.

**Tasks:**
- [ ] Thread `--plan` through `run_create` → `ops::create` → `adopt_plan_in`; wire it on **both** create exits (the fresh path after `run_post_create`, and the `created: false` resume path that returns before it).
- [ ] Add the `adopt-plan` subcommand and receipt printing per Spec S01/S02.
- [ ] Update `create`'s callers for the new parameter. There is exactly one outside the crate — `run_create` in `tugrust/crates/tugutil/src/dash.rs` — plus the in-crate `ops.rs` tests; nothing in tugcast constructs a dash. A mechanical `None` covers the tests.

**Tests:**
- [ ] `create --plan` with an untracked base copy: file committed on the branch, absent on base, config set, receipt `committed`/`removed`.
- [ ] `create --plan` with a tracked-dirty base copy: edits in the adoption commit, base restored to HEAD.
- [ ] `create --plan` with a committed clean copy: receipt `inherited`, no adoption commit, base untouched.
- [ ] `create` without `--plan`: `CreateOutcome.plan` absent; existing idempotence tests still green.
- [ ] Transplant failure on the create path rolls back worktree + branch and leaves the base copy intact.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil`

---

#### Step 3: The step verbs refuse over base plan dirt {#step-3}

**Depends on:** #step-1

**Commit:** `tugdash(plan-adoption): dash step refuses while a base plan copy diverges`

**References:** [P05] step refusal, Spec S03, (#jail-mechanics)

**Artifacts:**
- `step_in` calls `base_plan_dirt` after resolving `rel`; refusal string per Spec S03.

**Tasks:**
- [ ] Add the check to `step_in` (both phases), before any write.
- [ ] Verify the refusal leaves the plan and the dash-log untouched (the existing byte-for-byte refusal discipline).

**Tests:**
- [ ] `step start` with a tracked-dirty base copy: non-zero, message contains `adopt-plan`, plan bytes unchanged.
- [ ] `step done` with an untracked base copy: same.
- [ ] After `adopt_plan_in`, the same `step start` succeeds.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 4: The plan-aware join preflight {#step-4}

**Depends on:** #step-1

**Commit:** `tugdash(plan-adoption): join preflight names the plan and catches untracked overwrites`

**References:** [P06] preflight, Spec S03, (#jail-mechanics)

**Artifacts:**
- `blocking_base_dirt` gains the untracked-intersection component; `base_dirt_detail` (and the new untracked detail) gain the plan-aware sentence; `join_preflight_in` and the execute path share both.

**Tasks:**
- [ ] Add `git ls-files --others --exclude-standard` intersection to `blocking_base_dirt` (or a sibling fn feeding the same blocker), scoped to `dash_changed`.
- [ ] Thread the recorded plan rel + dash name into the detail formatting per Spec S03; unchanged wording when the plan is not among the paths.
- [ ] Confirm the execute path refuses with the same strings.

**Tests:**
- [ ] Preview with a tracked-dirty base plan copy: one `base-dirt` blocker whose detail contains the rel and `adopt-plan`.
- [ ] Preview with an untracked base copy at a dash-changed path: blocker present (today: clean preview, failing integrate — the test first demonstrates the integrate failure shape is unreachable once the blocker fires).
- [ ] Disjoint untracked files do not block.
- [ ] Non-plan tracked dirt keeps the existing message verbatim.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 5: Release hands the plan back {#step-5}

**Depends on:** #step-2

**Commit:** `tugdash(plan-adoption): release restores the adopted plan to base before teardown`

**References:** [P08] release restores, Risk R03, Spec S02, (#transplant-states)

**Artifacts:**
- `release_in` restores the branch's plan copy to `<repo_root>/<rel>` before `remove_dash_worktree`; `ReleaseOutcome.plan_restored: Option<String>`.
- `format_release_summary` (`tugrust/crates/tugcast/src/feeds/changeset.rs`) gains a line when the field is set.

**Tasks:**
- [ ] In `release_in`, before teardown: read the recorded plan rel via `dash_plan_path`; read the branch's bytes (`git show <branch>:<rel>`, so it works even if the worktree is already gone); compare against base HEAD's version; when they differ, write the file to `<repo_root>/<rel>` and set `plan_restored`.
- [ ] Do nothing when no plan is recorded, when the branch has no such path, or when the bytes match base HEAD — an untouched dash must release exactly as it does today.
- [ ] Add the summary line so the discard receipt says the plan came back.

**Tests:**
- [ ] Untracked-on-base plan → `create --plan` → `release`: the plan file is present at the repo root afterward with the adopted bytes, and the branch is gone.
- [ ] Tracked-dirty-on-base plan → adopt → `release`: the user's edits are back in the base working tree (file differs from HEAD again).
- [ ] Dash with no recorded plan releases unchanged (existing release tests stay green).
- [ ] Branch plan identical to base HEAD → `plan_restored` is `None` and no file is written.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugcast`

---

#### Step 6: Doctrine and skill prose {#step-6}

**Depends on:** #step-2, #step-3, #step-4, #step-5

**Commit:** `tugdash(plan-adoption): [D139] one plan home; dash-implement adopts instead of copying`

**References:** [P07] doctrine, [P01] one live copy, (#documentation-plan)

**Artifacts:**
- [D139] in `tuglaws/design-decisions.md`; "Plan adoption" section in `tuglaws/dash-lifecycle.md`; `tugplug/skills/dash-implement/SKILL.md` setup rewrite (create gains `--plan`, manual copy step and two-copy dialog deleted, pragmatics line for the [P05] refusal).

**Tasks:**
- [ ] Write [D139] citing [D138] and this plan's incident history.
- [ ] Add the lifecycle section: T01 behavior in prose, the R01 invariant, the remedy verb, the note that a committed clean base copy is ordinary divergence, and the adoption/release symmetry ([P08] — the plan comes back when the dash is discarded).
- [ ] Rewrite `dash-implement` setup steps 2–4: `create --plan <path>`; the stale-review gate survives against the worktree copy; delete the copy instruction and the comparison dialog.

**Tests:**
- [ ] None (prose).

**Checkpoint:**
- [ ] `grep -q "adopt-plan" tugplug/skills/dash-implement/SKILL.md && ! grep -qi "copy the file once" tugplug/skills/dash-implement/SKILL.md`
- [ ] `grep -q "D139" tuglaws/design-decisions.md && grep -qi "adoption" tuglaws/dash-lifecycle.md`

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), Spec S01–S04

**Tasks:**
- [ ] End-to-end Rust test, the join arm: author an untracked plan on base → `create --plan` → `step start`/`done` → dirty the base copy → `step` refuses → `adopt_plan_in` → `join_preflight_in` clean → `join_in` lands, plan present on base with final ledger.
- [ ] End-to-end Rust test, the abandon arm: the same setup through `step start` → `release` → the plan is back at the repo root and no `tugdash/*` branch remains. This is the arm that proves no path through the system loses the document.
- [ ] Full workspace test run.

**Tests:**
- [ ] Both end-to-end tests above (in `tugdash-core`'s ops tests).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The plan file has one verb-managed home; every seam that previously detonated (manual copy, silent divergence, generic join jail, untracked-overwrite integrate failure) either cannot occur or refuses with `tugutil dash adopt-plan <name>` named in the message.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All #success-criteria bullets hold (each is a test or a grep above).
- [ ] `cd tugrust && cargo nextest run` green, zero warnings.
- [ ] `dash-implement` contains no manual plan movement.

**Acceptance tests:**
- [ ] Step 7's end-to-end test.
- [ ] Step 4's untracked-overwrite blocker test.
- [ ] Step 5's release-restores-the-plan tests (both the untracked and tracked-dirty shapes).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] A divergence chip on the Changes card's dash entry (tugcast + tugdeck), surfacing base plan dirt at a glance before any verb runs.
- [ ] `dash-on` runs (plan-less) that later acquire a plan: `adopt-plan` already covers them; consider whether `dash-on`'s prose should mention it.

| Checkpoint | Verification |
|------------|--------------|
| Transplant engine | `cargo nextest run -p tugdash-core` (Table T01 suite) |
| No verb destroys a plan | Step 5 release tests |
| End-to-end adoption lifecycle | Step 7 test |
| Prose landmine deleted | Step 6 greps |
