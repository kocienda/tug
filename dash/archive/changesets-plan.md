<!-- devise-skeleton v4 -->

## Changesets — Attribution Engine, Changeset Card, tugdash {#changesets}

**Purpose:** Replace the read-only Git card with an end-to-end changeset system: authoritative
per-session file attribution recorded at the moment of change, a live multi-session Changeset
card that can diff, summarize, and commit, and a standalone `tugdash` worktree tool with a
join engine that actually works. Brief: `dash/changesets.md`.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (or a dash worktree per milestone) |
| Last updated | 2026-07-14 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Today the AI reconstructs "files I changed this session" by looking back through its own
context — remarkably reliable for Write/Edit, blind for `Bash`-mediated edits (`sed`, `perl`,
`git mv`, …). Meanwhile every tool event already flows through one supervised point in
tugcast (`agent_bridge.rs`'s stdout relay loop), which already intercepts other frame types
and has the session ledger in scope. Nothing persists tool calls. The Git card is a passive
2s-poll status viewer with zero actions, and `tugutil dash join` is a hardcoded
`git merge --squash` with rigid preflights and dead-end conflict handling.

This plan concentrates the AI's file knowledge down to the point of change (a sqlite record
written when the tool call lands), builds the Changeset card on that record, and promotes the
worktree workflow into a first-class `tugdash` tool whose join engine uses the same
attribution data.

#### Strategy {#strategy}

- **Attribution first** (Milestone M01): the `file_events` record and its query surface ship
  before any UI. The commit skill is the first consumer — immediate value, zero pixels.
- **Exact where possible, bracketed where not**: Write/Edit/NotebookEdit attribution comes
  straight from tool inputs; only Bash needs working-tree fingerprint bracketing. Subagent
  tool calls are NOT a hole — they arrive on the same stream with `parent_tool_use_id`.
- **Read-only card next** (M02): a workspace-scoped `CHANGESET` snapshot feed composing git
  status + attribution + dash list, bumped event-driven on every file event; the grouped card
  replaces the Git card visually before any write action exists.
- **Actions after trust** (M03): diff, sidecar-generated summaries/commit messages, and
  commit-from-card land only once the read path has proven itself.
- **tugdash last** (M04): the worktree overhaul benefits from attribution (intersection-aware
  preflight) and from the card (join preview UI), so it goes last; it is also the most
  self-contained to defer.
- Each milestone ends with an integration checkpoint; each is independently shippable.

#### Success Criteria (Measurable) {#success-criteria}

- After a session Writes/Edits N files, `tugutil changes` (in that session's Bash env) lists
  exactly those N repo files — verified by a tugcast integration test and by hand.
- A `Bash` call that edits a file via `sed` produces a `file_events` row attributing that file
  to the calling session (bracketed origin), verified by integration test.
- Resuming a session backfills `file_events` for its historical Write/Edit calls
  (idempotently — resume twice, row count unchanged).
- The Changeset card shows a file within 1s of the tool_result that changed it (event-driven
  bump, not the poll), and groups files by owning session/dash with an unattributed bucket.
- Commit-from-card stages exactly the selected changeset's files and produces a numstat
  receipt; a file dirtied by another live session is not swept in.
- `tugdash join --preview` reports conflicts without touching the working tree;
  `tugdash join` succeeds when base dirt is disjoint from the dash's changed files (today's
  code refuses).
- (M04) A conflicted join runs the resolution ladder before any human sees it: the
  base-cherry-picked-a-round case lands via the replay probe, a previously-resolved
  conflict replays via rerere, and an AI-resolved file is validated (no markers) and landed
  only after explicit review-confirm from the card — all verified by the Step-21a/21b
  scratch-repo + fake-spawner matrices, no checkout ever left half-merged.
- (M03A) Every changeset entry with changes carries a maintained, convention-correct commit
  message that is current within the quiet period + one generation of the last change
  landing; an unchanged entry never re-spends a scribe call (fingerprint gate, verified by
  Rust tests with a fake `ScribeSpawner`); restarts/reopens render the persisted draft with
  zero regeneration.
- (M03A) Dash entries show real diffs (merge-base…branch plus worktree dirt) inline in the
  card; per-file and whole-changeset diffs render inline and pop out to a Text card in diff
  mode.
- `cd tugrust && cargo nextest run` green; `cd tugdeck && bunx tsc --noEmit && bunx vite build`
  green; `just app-test` green at every milestone close.

#### Scope {#scope}

1. `file_events` table in `sessions.db` + `SessionLedger` API + agent_bridge intercept
   (exact + bracketed + replay backfill).
2. `TUG_SESSION_ID` environment plumbing tugcast → tugcode → claude → Bash tool calls.
3. `tugutil changes` query CLI; commit-skill rewire.
4. `CHANGESET` feed (FeedId 0x23), changeset wire types, Changeset card (read-only → actions).
5. Pathspec-capable diff query; `changeset_commit` and `changeset_summarize` control verbs;
   `claude -p` scribe sidecar.
6. `tugdash` binary + `tugdash-core` crate; `.tug/worktrees/` migration; join engine v2
   (strategies, preview, intersection preflight, journaled teardown); conflict resolution
   ladder + review-gated AI file-merge ([P31]/[P32]); tugplug skill cutover.
7. Git card + `GitFeed` retirement.
8. (M03A) One diff capability, three surfaces: `TugDiffDocument` over the shared `DiffBlock`
   engine (card-inline, the dev card's `/diff` sheet, a Text-card diff mode via a new
   `OPEN_DIFF` action) driven by a two-flavor diff descriptor; plus the maintained draft
   engine — a continuously current, convention-correct commit message per changeset entry
   (streaming scribe, fingerprint gating, ledger persistence) replacing the on-demand
   Summarize/Draft actions.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Non-git VCS backends (jj/sapling). The `Vcs` seam is respected in naming/layering but no
  trait abstraction ships in this phase — premature until a second backend exists.
- Cross-workspace changeset view (sessions in *other* projects) — see [Q01].
- Staging-area management UI (interactive hunk staging, partial-file commits).
- Recovering pre-feature Bash attribution on resume (replay backfill covers exact tools only —
  a bracketed delta cannot be reconstructed after the fact; see [P06]).
- Attributing writes a `run_in_background` Bash command makes *after* its `tool_result`
  returns — the bracket closes at the result, and the detached command's later writes land
  as unattributed (visible in the card, honest, just not owned). See #bracket-algorithm.
- Removing the dev card's existing `/diff` sheet or `GIT_DIFF` machinery (it is generalized,
  not replaced).
- IndexedDB/SessionCache anything — that layer is slated for removal; nothing here builds on it.

#### Dependencies / Prerequisites {#dependencies}

- git ≥ 2.38 on the host for `git merge-tree --write-tree` (dev machine has 2.53; `tugdash`
  must degrade with a clear error below that). The resolution ladder's replay probe
  additionally needs `merge-tree --merge-base` (git ≥ 2.40) — below that the probe rung is
  skipped, the rest of the ladder still runs ([P31]).
- claude CLI on PATH (already a hard Tug dependency) for the scribe sidecar.
- `mergiraf` on PATH is optional (structured-merge rung, [P31]) — absence skips the rung;
  never bundled (AGPL).
- Existing infrastructure: `SessionLedger` (`tugrust/crates/tugcast/src/session_ledger.rs`),
  agent bridge relay loop (`tugrust/crates/tugcast/src/feeds/agent_bridge.rs`),
  `WorkspaceRegistry`/`GitFeed` (`tugrust/crates/tugcast/src/feeds/workspace_registry.rs`,
  `feeds/git.rs`), card registry (`tugdeck/src/card-registry.ts`), dash implementation
  (`tugrust/crates/tugutil-core/src/dash.rs`, `tugrust/crates/tugutil/src/commands/dash.rs`).

#### Constraints {#constraints}

- **Warnings are errors** across the Rust workspace (`tugrust/.cargo/config.toml`).
- Frontend: tuglaws apply — external state via `useSyncExternalStore` only [L02]; appearance
  via CSS/DOM [L06]; no localStorage (persistent UI state → tugbank `/api/defaults`); compose
  real Tug* components, never borrow their CSS; no estimated heights; buttons with
  state-dependent content reserve the wider state's width.
- `bunx vite build` must pass before any tugdeck change is called done (dev-esbuild-only
  imports hang the app at splash).
- tugcode is a compiled binary — rebuild after edits; bun only, never npm.
- The relay loop must never let attribution failures affect frame delivery: parse errors,
  ledger write errors, and git subprocess failures all degrade to "forward the frame
  unchanged" (same posture as the existing `system_metadata` intercept).
- The commit skill's constraints stand: no heredocs, no `cd` (they trigger approval prompts).

#### Assumptions {#assumptions}

- `tug_session_id` is stable across resumes of the same Dev-card session (it is the
  card-bound identity; claude session ids rotate underneath it). Attribution keyed by
  `tug_session_id` therefore gets resume-lineage for free.
- The env chain is open: tugcode passes its environment to claude minus three auth keys
  (`tugcode/src/session.ts` `scrubbedEnv`), and claude passes env to Bash tool calls — so a
  variable set on the tugcode spawn reaches skill-run shell commands.
- `sessions.db` (WAL mode) tolerates a concurrent read-only open from `tugutil` while tugcast
  writes — standard sqlite WAL semantics; DB lives on local disk
  (`~/Library/Application Support/Tug/sessions.db`).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses the devise-skeleton v4 conventions: explicit `{#anchor}` on every cited
heading, `[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##`, `Risk R##`,
`Milestone M##`, `**Depends on:** #step-N` lines, and rich `**References:**` lines. Never
cite line numbers; cite anchors and symbols.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Cross-workspace changeset view (DEFERRED) {#q01-cross-workspace}

**Question:** Should the Changeset card ever show live sessions in *other* projects on the
same deck, or stay strictly per-workspace?

**Why it matters:** Determines whether the feed is workspace-scoped (like GIT) or app-scoped
(like PULSE), which is hard to change later.

**Resolution:** DEFERRED — ship workspace-scoped ([P09]); the composition point
(`ChangesetFeed`) can later be lifted to app scope without changing the wire format (the
snapshot already carries `workspace_key`). Revisit after M02 dogfooding.

#### [Q02] Scribe model selection (DEFERRED) {#q02-scribe-model}

**Question:** Which model should the `claude -p` scribe use for summaries/commit messages?

**Why it matters:** Latency vs. quality for an interactive card action.

**Resolution:** DEFERRED — default to `haiku` via `--model`, overridable through a tugbank
default (`dev.tugtool.changeset` / `scribe_model`), read at spawn. No UI for it this phase.

**Superseded at M03A:** [P21] retires the on-demand scribe actions entirely and [P22] flips
the default model to `sonnet` (cost is bounded by fingerprint gating, not by picking the
smallest model). The tugbank override stays the knob; still no UI for it.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Bash bracketing adds a `git status` per Bash call | med | med | porcelain-v2 status is ~10ms on this repo; only Bash calls pay; reuse `is_within_git_worktree` gate to skip non-repos | status latency > 100ms observed |
| Multi-session overlap misattributes Bash deltas | med | low | overlap → `ambiguous` flag, never a guess; ambiguous rows excluded from one-click commit ([P15]) | user reports wrong grouping |
| Scribe (`claude -p`) slow or auth-broken headless | med | med | spawn with scrubbed env (subscription auth, same as tugcode); card shows in-flight state; hard 60s timeout with error surfaced | consistent timeouts |
| `.tugtree` → `.tug/worktrees/` migration breaks live dashes | high | low | `git worktree move` only when worktree is clean and no tugutil instance holds it; otherwise print instructions and continue against old path | migration failure in the wild |
| Rust/TS wire-type drift for ChangesetSnapshot | med | med | golden contract fixture consumed by both a Rust test and a bun test ([P10]) | either test fails |

**Risk R01: Fingerprint snapshot races** {#r01-fingerprint-races}

- **Risk:** The pre-snapshot for a Bash bracket runs a moment after the tool actually starts
  (frame arrival vs. execution), so a very fast self-edit could be missed or doubled.
- **Mitigation:** The `tool_use` frame is emitted when claude *issues* the call, before the
  harness executes it — the snapshot races only network/pipe latency (ms). Deltas are
  computed set-wise (path → status+mtime fingerprint), so double-counting collapses.
- **Residual risk:** An external editor writing during exactly that window is attributed to
  the bracket. Accepted; the card's diff view makes it visible.

---

### Design Decisions {#design-decisions}

#### [P01] Ownership = session lineage + dash (DECIDED) {#p01-ownership}

**Decision:** A changeset's owner is a `tug_session_id` (inline changesets) or a dash
(branch+worktree). Files dirty in the tree with no owning event rows form the
**unattributed** bucket, rendered honestly.

**Rationale:** User decision (brief, "Settled decisions"). `tug_session_id` survives resumes,
so lineage is free. A dash worktree is one changeset regardless of how many sessions
contribute.

**Implications:** `file_events` keys on `tug_session_id`; dashed changesets are derived from
branch topology (`base..branch` + worktree dirt), not from event rows.

#### [P02] file_events lives in sessions.db (DECIDED) {#p02-file-events-home}

**Decision:** Attribution rows go in a new `file_events` table in the existing session ledger
(`~/Library/Application Support/Tug/sessions.db`), NOT tugbank.

**Rationale:** tugbank is a `(domain,key)→value` defaults store with a per-entry size cap —
wrong shape. `sessions.db` is already per-session, already written from the interception
point, and has the cascade-trigger idiom (`turns`, `turn_telemetry`) to copy.

**Implications:** Schema added in `bootstrap_schema` with the self-healing column guard and a
cascade-delete trigger on `sessions`, exactly like `turns_cascade_delete_on_session`.

#### [P03] Intercept in the agent_bridge relay loop (DECIDED) {#p03-intercept-point}

**Decision:** Attribution is captured in tugcast's stdout relay loop in
`tugrust/crates/tugcast/src/feeds/agent_bridge.rs` — the same `else if line.contains(...)`
chain that handles `turn_complete` and `system_metadata` — not in tugcode.

**Rationale:** One process sees every session (tugcode is per-session and short-lived); the
loop already has `tug_session_id`, `ledger_entry` (with `project_dir` and
`claude_session_id`), `session_ledger`, and the `in_replay` flag in scope.

**Implications:** Substring pre-filter (`"\"type\":\"tool_use\""` etc.) before a full
`serde_json` parse, so only tool lines pay deserialization — same trade the existing
intercepts document.

#### [P04] Exact attribution records on successful tool_result only (DECIDED) {#p04-result-gated}

**Decision:** A Write/Edit/NotebookEdit event is persisted when its `tool_result` arrives
with `is_error: false` — never at `tool_use` time.

**Rationale:** Denied and errored calls (permission refusal, `old_string` not found) must not
pollute the record. `ToolResult` frames carry only `tool_use_id`/`output`/`is_error`
(`tugcode/src/types.ts` `ToolResult`), so the loop keeps a pending map
`tool_use_id → (tool_name, file_path, parent_tool_use_id)` populated at `tool_use` time and
consumed at `tool_result` time.

**Implications:** The pending map is relay-local and size-capped with oldest-entry
eviction (a few hundred entries; each is tiny). It is NOT cleared on `turn_complete`:
`subagent-tail.ts` re-emits a background agent's child frames on a ~250ms poll while the
parent turn may already be over, so a child's `tool_use` can precede a `turn_complete` and
its `tool_result` follow it — clearing at the turn boundary would orphan exactly the edits
this feature exists to catch.

#### [P05] Fingerprint bracketing for Bash only; overlap → ambiguous (DECIDED) {#p05-bracketing}

**Decision:** Bash is the one opaque mutator. On a Bash `tool_use`, snapshot the working
tree (`git status --porcelain=v2` → path→state map); on its successful `tool_result`,
snapshot again and attribute the delta to that call with `origin='bash'`. If another
session's bracket on the same repo root overlapped the window, the delta rows get
`ambiguous=1` — recorded, never guessed. Subagent frames (`parent_tool_use_id` set) get the
same treatment per-call: exact for nested Write/Edit, bracketed for nested Bash.

**Rationale:** Subagent calls flow through the stream (foreground natively; background via
`tugcode/src/subagent-tail.ts` re-emission), so no Task-level bracketing is needed. Bracket
overlap across sessions on one checkout is rare; honesty beats cleverness.

**Implications:** A shared bracket registry keyed by canonical repo root, owned by
`AgentSupervisor` and handed to each relay (relays for different sessions must see each
other's open brackets).

#### [P06] Replay backfills exact events idempotently (DECIDED) {#p06-replay-backfill}

**Decision:** Replay-bracketed `tool_use`/`tool_result` frames (the `in_replay` path) ARE
processed for exact attribution, upserted idempotently; Bash frames in replay are skipped
(no fingerprint is reconstructable after the fact).

**Rationale:** Resume re-emits the full persisted history — processing it means a session
started before this feature (or a reconnect re-stream from `subagent-tail`'s offset-0
replay) converges to the same rows. Idempotency comes from the primary key.

**Implications:** PK `(tug_session_id, tool_use_id, file_path)` with
`INSERT ... ON CONFLICT DO NOTHING`. Replay frames carry `timestamp` (epoch ms) — use it as
`at` so backfilled rows keep historical time.

#### [P07] TUG_SESSION_ID env self-identification (DECIDED) {#p07-env-id}

**Decision:** tugcast sets `TUG_SESSION_ID=<tug_session_id>` on the tugcode spawn (next to
the `env_remove` auth-scrub calls in `agent_bridge.rs`); tugcode's `scrubbedEnv` passes it
through to claude; claude passes env to Bash tool calls. Skills and CLIs self-identify from
the variable.

**Rationale:** Closes the "which session am I?" gap without any protocol change. Verified:
the chain currently strips only the three auth keys.

**Implications:** `tugutil changes` (and future tooling) reads `TUG_SESSION_ID` with a
`--session` override.

#### [P08] Query surface = `tugutil changes`, direct read-only sqlite (DECIDED) {#p08-query-surface}

**Decision:** M01's query surface is a `tugutil changes` subcommand that opens `sessions.db`
read-only, joins `file_events` for the session against current `git status`, and prints
plain or `--json` output. No HTTP endpoint in M01.

**Rationale:** Avoids port/instance discovery inside skill prose (the commit skill bans
heredocs/`cd`; a bare `tugutil changes --json` is one clean command). WAL read-only opens
are safe cross-process. The card gets its data via the feed, not HTTP, so nothing else needs
an endpoint yet. Living in tugutil is acceptable residual grab-bag: `changes` is a query,
not the worktree capability that becomes `tugdash` ([P12]).

**Implications:** `tugutil` gains a `rusqlite` dependency (read-only open flags) and reuses
`tugutil-core/src/paths.rs` conventions; sessions.db path resolution must match
`SessionLedger::default_path`.

#### [P09] CHANGESET is a workspace-scoped snapshot feed with event-driven bumps (DECIDED) {#p09-feed-shape}

**Decision:** `FeedId::CHANGESET = 0x23`, a `SnapshotFeed` owned by `WorkspaceEntry` beside
`GitFeed`, splicing `workspace_key`. It recomputes on (a) a bump signal fired by the
attribution intercept after each file-event write, (b) the existing 2s poll as fallback for
external edits.

**Rationale:** A changeset is a property of a checkout, not a conversation — the card shows
*all* sessions' work on one project. Bump-on-event delivers the "never out of date" feel;
the poll catches hand edits.

**Implications:** `agent_bridge` needs a handle to signal the right workspace's feed — a
`tokio::sync::watch`/`Notify` registered per repo root in `WorkspaceRegistry`
(`find_entry_by_path` already maps project_dir → entry).

#### [P10] Wire types: Rust authoritative, TS mirrored, golden-fixture guarded (DECIDED) {#p10-wire-types}

**Decision:** `ChangesetSnapshot` and friends are defined in
`tugrust/crates/tugcast-core/src/types.rs` (serde snake_case, like `GitStatus`); the TS
mirror lives in one tugdeck module; a checked-in golden JSON fixture is deserialized by a
Rust test and validated by a bun test, so drift fails CI on either side.

**Rationale:** Full codegen is a phase of its own; the hand-mirror + comment idiom (today's
`GitStatus`) has no guard at all. The fixture is the cheap middle.

**Implications:** New fixture file under `tugdeck/src/__tests__/fixtures/` (or sibling)
referenced from both test suites.

#### [P11] Scribe = one-shot `claude -p` spawned by tugcast (DECIDED) {#p11-scribe}

**Decision:** Summaries and commit messages come from a headless sidecar: tugcast spawns
`claude -p --output-format text --model <scribe_model>` with a composed prompt (scoped diff +
the owner's recent user prompts from the `turns` table + dash-log lines for dashes), env
auth-scrubbed exactly like the tugcode spawn. Modeled on the `ChildSpawner` pattern
(`TugpulseSpawner` in `feeds/pulse.rs`) for testability.

**Rationale:** User decision (headless sidecar; never disturbs the working session). claude
CLI is already a hard dependency; `-p` needs no session ledger, no transcript, no resume.

**Implications:** A `changeset_summarize` CONTROL verb; a spawner trait so tests fake the
child; 60s timeout; result returned as a CONTROL response (request/response, not a feed).

#### [P12] tugdash: standalone binary + tugdash-core crate (DECIDED) {#p12-tugdash}

**Decision:** Dash leaves the tugutil grab bag: new crates `tugrust/crates/tugdash-core`
(library: all dash logic, callable from tugcast) and `tugrust/crates/tugdash` (CLI:
`create/commit/join/release/list/show`). `tugutil dash` is deleted in the same milestone;
tugplug skills cut over.

**Rationale:** User decision on the name. Core/CLI split is the precondition for the card
driving create/commit/join through the same code as the CLI.

**Implications:** `tugutil-core/src/dash.rs` and `tugutil/src/commands/dash.rs` move (git
history preserved via plain moves in one commit); `justfile`/build/packaging gain the new
binary; `instance::reap_instance_tmux` dependency moves or is re-exposed.

#### [P13] Worktrees live in `.tug/worktrees/`; auto-migrate from `.tugtree/` (DECIDED) {#p13-worktree-home}

**Decision:** New worktree path: `<repo>/.tug/worktrees/<sanitized-name>`, git-ignored via a
`.tug/` entry. Any tugdash command that finds `.tugtree/` worktrees migrates them with
`git worktree move` when safe (clean worktree, no live instance), else warns and proceeds
against the old path.

**Rationale:** User decision (in-repo, new name). `.tug/` gives Tug one dot-directory to
grow into rather than another tool-specific name.

**Implications:** `tugutil init`'s gitignore block updates (it currently writes `.tugtree/`);
`worktree_path()` in the moved core changes; migration must handle the tmux-holding-files
race that `remove_dash_worktree` already documents.

#### [P14] Join engine v2: strategies, merge-tree preview, intersection preflight, journal (DECIDED) {#p14-join-v2}

**Decision:** `tugdash join` gains `--strategy squash|merge|rebase` (default squash,
preserving today's behavior), `--preview` (in-memory `git merge-tree --write-tree
<base> <branch>`, reporting conflict files without touching any worktree), an
intersection-aware preflight (base dirt is only blocking when it intersects the dash's
changed file set `git diff --name-only <base>...<branch>` ∪ worktree dirt), and a join
journal in the project state dir making teardown resumable (`tugdash join --continue`).

**Rationale:** These four are the concrete fixes for the observed pain: squash-only history
loss, dead-end conflicts, "commit or stash first" false positives, and non-atomic teardown
(warn-pile). The auto-commit that currently ignores its exit status (`let _ =` in
`run_dash_join`) becomes a hard error.

**Implications:** Conflict output is structured (`--json` lists conflicted paths) so the card
can render it and offer ladder + AI-assisted resolution ([P31]/[P32], [#step-21b]/[#step-21c]).

#### [P15] Commit-from-card stages exactly the changeset's files (DECIDED) {#p15-card-commit}

**Decision:** The `changeset_commit` CONTROL verb takes `{project_dir, files[], message}`,
runs `git add -- <files...>` then `git commit -m <message>` in `project_dir`, and responds
with the `git show --numstat --format= HEAD` receipt (the commit skill's receipt idiom).
Files that are `ambiguous=1` or multi-owned (`shared: true`, see #snapshot-composition) are
excluded from the card's default selection and require explicit user inclusion.

**Rationale:** This is the session-scoped `git add` the commit skill does by inference, done
by construction. Ambiguity and shared-ownership policy resolves the brief's open item:
visible badge, opt-in commit — one session's commit never silently sweeps another's file.

**Implications:** The verb refuses an empty `files` list and never falls back to `git add .`.

#### [P16] Git card and GitFeed retire at M02 close (DECIDED) {#p16-git-card-retirement}

**Decision:** `ChangesetSnapshot` embeds the branch/ahead-behind/HEAD data (the feed reuses
`parse_porcelain_v2` and the poll loop from `feeds/git.rs`); once the Changeset card renders
it, `registerGitCard()` and `GitFeed` are removed, along with the Swift "New Git Card" menu
item (`tugapp/Sources/AppDelegate.swift` `newGitCard`) which becomes "New Changeset Card".

**Rationale:** Two cards polling the same repo is waste; the brief says the git card
retires.

**Implications:** FeedId `0x20` (GIT) is retired from registration but the constant remains
reserved (never reuse); `GIT_DIFF`/`GIT_DIFF_QUERY` (0x21/0x22) survive — the dev card's
`/diff` and the Changeset card both use them after Step 13.

#### [P17] Account-global aggregate feed replaces the per-workspace changeset feed (DECIDED) {#p17-aggregate-feed}

**Decision:** One **process-level** feed, `FeedId::CHANGESET_ALL` (propose `0x24` — confirm
free on both sides at implementation), aggregates **every open project** into a single
`WorkspacesChangesetSnapshot` frame (Spec S06) delivered to every deck the way `USAGE`/`PULSE`
frames are. The project set is exactly the current **`WorkspaceRegistry` entries** — one per
project with a live dev session, refcounted per card, bootstrap `--source-tree` always
present. A project appears while a dev card is open on it and drops when its last card
closes; there is **no linger-while-dirty and no ledger crawl**. The per-workspace
`ChangesetFeed` (0x23) is **removed** (#step-12d); `compose_snapshot` survives as the
per-project building block; **0x23 stays reserved, never reused**. Non-repo project dirs are
no longer skipped: they surface as `no_repo: true` elements with an "Initialize git"
affordance (Spec S07).

**Rationale:** Locked upstream as decisions **D1** (one feed, replace) and **D2** (project
set = registered workspaces) in `dash/workspace-tracking-plan.md` — **do not re-open**.
The M02 card proved structurally bootstrap-only (#aggregate-delivery): per-workspace frames
publish to per-workspace watch receivers that `main.rs` never registers for session
workspaces. Aggregation must be **server-side** because tugdeck's `FeedStore` holds one
value per feed id — a second project's frame on the same id would overwrite the first.

**Implications:** Supersedes [P09]'s workspace-scoped *delivery* (its event-driven-bump +
poll composition survives per project) and resolves [Q01]'s deferral in the aggregate
direction. `WorkspaceRegistry` gains an enumeration accessor (`project_dirs()`); the bump
path gains a process-global `Notify` alongside the per-workspace one until #step-12d removes
the latter. Cost is ~2 git subprocesses per open project per recompute, gated per dir by the
subprocess-free `is_within_git_worktree` — negligible at "handful of open cards" scale.

#### [P18] TugDiffDocument: one document-level diff component, three surfaces (DECIDED) {#p18-diff-document}

**Decision:** Extract a document-level diff component, `TugDiffDocument`
(`tugdeck/src/components/tugways/tug-diff-document.tsx` + `.css`): summary header
(`N files changed +X −Y`), one collapsible `DiffBlock` per file, Expand All / Collapse All,
and a host-level inline ↔ side-by-side toggle. `DiffBlock`
(`tugdeck/src/components/tugways/body-kinds/diff-block.tsx`) is already the shared
per-file engine — it is NOT rebuilt; the document layer composes it (`suppressHeader`, the
accordion trigger owns file identity, exactly as `diff-sheet.tsx` does today). The `/diff`
sheet (`tugdeck/src/components/tugways/cards/diff-sheet.tsx`) is rebased onto it: the sheet
keeps its chrome (`TugSheetScaffold`, pre-open alert branching, Done) and its body becomes a
`TugDiffDocument`. The per-file trigger/body/accordion/expand-all logic currently inside
`diff-sheet.tsx` moves into the new component.

**Rationale:** User decision — one diff capability, shared across the sheet, the changeset
card's inline expansion, and the Text-card diff mode. Duplicating the accordion layer three
times is exactly the hand-rolling the component doctrine bans.

**Implications:** `TugDiffDocument` takes the parsed `GitDiffPayload` (files + totals from
`git-diff-store.ts`), not a raw store — each host owns its own store/refresh wiring. The
view-mode toggle drives `DiffBlock`'s `viewMode` prop; persistence rides the existing
`diff-view-pref.ts` tugbank hook when the host passes a `cardId`.

#### [P19] Two-flavor diff descriptor, designed in from day one (DECIDED) {#p19-diff-descriptor}

**Decision:** Diff requests carry a discriminated **diff descriptor** with two flavors
(Spec S08): `{kind: "head", root, paths?}` → `git diff HEAD [-- <paths…>]`
(sessions/unattributed — today's behavior), and `{kind: "range", worktree, base, branch}` →
the dash view: everything the dash has done past its base, committed rounds **plus**
worktree dirt, resolved as one `git -C <worktree> diff <merge-base(base, branch)>`
(#diff-descriptor-resolution). `GIT_DIFF_QUERY` (0x22) and `TugDiffDocument`'s hosts both
speak the descriptor; dash entries get real diffs, fixing the M03 asymmetry where dash rows
had no diff affordance at all.

**Rationale:** User decision. A dash's changeset is `base..branch` + dirt — `git diff HEAD`
in the project dir cannot show it, which is why Step 13 explicitly skipped dashes. Designing
the second flavor in now means every diff surface (inline, pop-out, sheet) handles both
owner kinds from birth, and M04's join preview reuses the same descriptor.

**Implications:** The `RawDiffQuery` adapter in `tugcast/src/main.rs` gains optional
`worktree`/`base`/`branch` fields (presence of `branch` selects the range flavor);
`feeds/git.rs` gains `fetch_dash_diff`. Client side, `GitDiffScope` in
`tugdeck/src/lib/git-diff-store.ts` grows into the descriptor union (the bare `{}` /
`{root, paths}` forms remain valid — the dev card's `/diff` is untouched).

#### [P20] Diffs render inline in the changeset card; OPEN_DIFF opens a Text-card diff mode (DECIDED) {#p20-inline-diff}

**Decision:** The changeset card stops using the diff sheet. A file row's diff affordance
expands that file's `DiffBlock` **inline under its row**; an entry-level action expands the
whole `TugDiffDocument` **inline in the entry body**. Both carry a pop-out affordance
dispatching a new `OPEN_DIFF` action (`TUG_ACTIONS.OPEN_DIFF`, registered in
`tugdeck/src/action-dispatch.ts`) that opens a **Text card in diff mode**: the card carries
a diff descriptor instead of a file path and renders `TugDiffDocument` standalone with a
Refresh button. Reuse is descriptor-keyed, mirroring `open-file`'s path-keyed reuse
(`tugdeck/src/lib/open-file-in-card.ts` / `text-card-open-registry.ts`): re-dispatching the
same descriptor activates the existing card.

**Rationale:** User decision — diffs belong where the change is, like the transcript's
tool-call diff blocks, with a pop-out for sustained reading. The sheet survives only as the
dev card's `/diff` surface (now sharing `TugDiffDocument` per [P18]).

**Implications:** One `GitDiffStore` instance per expanded entry (module-level map keyed by
entry id over the unfiltered changeset `FeedStore` from `changeset-diff-store.ts` — the
store-unique `gd-<storeId>-<seq>` request ids already prevent cross-talk). A per-file
expansion renders its file's slice of the entry-scoped payload — no per-file request. The
card's `useTugSheet` host stays (alerts still use it); `useDiffSheet` drops out of the card.
at0228's diff-click leg adapts mechanically to assert on the inline `DiffBlock` instead of
the sheet — it does not grow.

#### [P21] One maintained artifact per entry replaces on-demand Summarize/Draft (DECIDED) {#p21-maintained-draft}

**Decision:** Every changeset entry with changes carries exactly one AI artifact: a
continuously maintained, convention-correct **commit message** (short imperative subject +
terse bullets) whose body doubles as the summary. tugcast keeps it current in the background
so it is ready the moment the last change lands; Commit is always one click. The Summarize
button, the Draft button, and the summary alert sheet are **deleted**, along with the
`changeset_summarize` CONTROL verb and its client store paths. Triggers: session and
unattributed entries regenerate when their slice of the aggregate snapshot changes and then
goes quiet for ~10s (the change signal is the existing attribution bump → CHANGESET_ALL
recompute — no new intercept); dash entries regenerate when a round lands or the worktree
dirt changes, same quiet period. Clean entries honestly say "no changes" (fileless
sessions); a dash with rounds > 0 always has a draft — its future join message ([P23]).

**Rationale:** User decision (three rounds of design, settled): the card is a place where
work is *already understood* — not live narration, not a button you remember to press. The
ideal is a fully written commit message the instant work stops. One artifact, not two: a
good commit message *is* the summary.

**Implications:** A new engine module (`tugcast/src/feeds/draft_engine.rs`,
#draft-engine) drives generation; drafts persist in the session ledger (Spec S09) and ship
inside the aggregate snapshot (Spec S10) so a fresh deck renders them with zero
regeneration. The card renders the draft as markdown above an editable `TugTextarea`
pre-filled with it; Commit sends the field's text ([P24]).

#### [P22] Fingerprint gating, ledger persistence, sonnet default (DECIDED) {#p22-fingerprint}

**Decision:** Every generation is gated by a **fingerprint** of the entry's actual content
(Spec S11): sessions/unattributed hash the scoped diff text plus the file list (untracked
files contribute path + size + mtime — `git diff HEAD` cannot see their content); dashes
hash the branch head sha + a worktree-dirt hash. Fingerprint unchanged → no scribe call.
Superseded runs cancel and coalesce: a new fingerprint while a run is in flight aborts it
(task abort; `kill_on_drop` reaps the child) and starts fresh. A commit shrinks the
changeset → new fingerprint → a fresh draft for the remainder. Drafts persist in
`sessions.db` as `changeset_drafts` rows `{owner_kind, owner_id, project_dir, fingerprint,
message, updated_at}` (Spec S09) so restarts/reopens never burn a regeneration. The default
`scribe_model` becomes `sonnet` (tugbank override `dev.tugtool.changeset`/`scribe_model`
stays; supersedes [Q02]'s `haiku`).

**Rationale:** The gate — not the model size — is the cost control: one call per
changed-then-quiet episode, roughly one per working turn that touched files. Sonnet is
comfortably up to a commit message and the quality gap matters because the artifact is
read constantly.

**Implications:** A result is persisted only if its fingerprint is still current at
completion (a stale result is dropped, the newer run owns the entry). The engine fires the
global aggregate bump after persisting so the card refreshes immediately.

#### [P23] Dash drafts ARE the future join message (DECIDED) {#p23-dash-draft}

**Decision:** A dash entry's maintained draft is composed as the dash's eventual
**squash/join commit message**: from `git log <base>..<branch>` (round subjects/bodies), the
dash-log's per-round instruction/summary metadata, and the merge-base…branch diff. M04's
join engine v2 (#step-19, #step-21c) will consume the maintained draft as the default squash
message — this forward dependency is load-bearing; do not shape the dash prompt as a mere
status summary. Dash-log access reads the well-known path directly for now:
`project_state_dir(repo_root)/dash-log.md` (`tugutil-core/src/paths.rs`; line format
`<iso8601>  <dash>  <short-hash|released>  <instruction>` per
`tugutil-core/src/dash.rs::append_dash_log`), filtered by the dash name field; it swaps to
`tugdash-core` when #step-17 extracts it.

**Rationale:** User decision — leaving dashes out is "a non-starter". The dash draft is the
one artifact whose consumer is already scheduled (join), so it must be join-shaped from
day one.

**Implications:** #step-19 gains a task: default squash message = the maintained dash draft
when present. The dash fingerprint (head sha + dirt hash) means a `tugutil dash commit`
round automatically invalidates and regenerates.

#### [P24] Streaming is a nicety; user edits pin the field (DECIDED) {#p24-streaming-pinning}

**Decision:** The scribe upgrades to `claude -p --output-format stream-json
--include-partial-messages --verbose` on the existing `ScribeSpawner` seam; text deltas are
forwarded over CONTROL (`changeset_draft_delta`, Spec S10) so a visible card fills in live.
This is a nicety, not the point — the draft is usually done before you look; the persisted
message in the snapshot is the source of truth and the deltas are a presentation overlay.
On the card, the editable `TugTextarea` follows the latest draft only while **pristine**;
once the user edits it, the field is pinned and a newer draft surfaces as a subtle "Use
latest draft" affordance instead of clobbering their text. A landed commit unpins.

**Rationale:** Live fill-in makes the regeneration state legible (mini-transcript feel per
the `/btw` overlay); silently overwriting a hand-edited commit message would be hostile.

**Implications:** `ScribeSpawner::run` gains an optional delta channel; the fake spawner
scripts deltas in tests. The card needs a tiny CONTROL-overlay store
(`changeset-draft-store.ts`) keyed `(project_dir, owner_kind, owner_id)`.

#### [P25] The Changeset card adopts the tool-call block grammar for its entry contents (DECIDED) {#p25-block-grammar-adoption}

**Decision:** M03A shipped bespoke display idioms (`FileRow`, `FileDiffButton`, `InlineFileDiff`,
`DraftPanel`, a `TugTextarea` commit field) where the honed house **tool-call block grammar**
already exists. M03B re-expresses the card's *entry contents* on that grammar: `BlockChrome` /
`BlockHeader` (`tugdeck/src/components/tugways/cards/blocks/block-chrome.tsx`,
`block-header.tsx`) — the "one Quiet Line" header, the `ChromeActionsTargetContext` actions
portal (`useChromeActionsTarget`), collapse-by-unmount (the body subtree is not mounted while
collapsed), telescoping sticky-pin headers, `DiffBlock`'s `embedded`/`suppressHeader` mode
(`body-kinds/diff-block.tsx`), and the monochrome `+N −M` ghost badges the header already
renders via `resultSummary={{kind:"diff"}}` → `DiffSummaryBadges`. The grammar is
transcript-agnostic (it is already mounted standalone by the gallery and the permission
dialog); its only couplings are three OPTIONAL ambient contexts — `ToolBlockCollapseContext` /
`ToolUseIdContext` (`blocks/collapse-context.tsx`) and the `useToolCallMeta` timing context —
each of which the header degrades to null gracefully for a standalone caller.

**Rationale:** User decision — the M03A card "invented new display idioms where honed house
designs already exist." Re-using the block grammar is exactly what the component doctrine
([L20], `tuglaws/component-authoring.md`) mandates; every hand-rolled row/diff/draft idiom the
card carries is a divergence from the one calm transcript surface the user already reads.

**Implications:** Bounded to the *entry contents*: the card's top-level structure — the
`TugAccordion type="multiple"` entry sections and the fixed TOC `TugListView` — stays exactly as
it is (see #non-goals-m03b). Re-homing the chrome modules OUT of `cards/blocks/` and
re-expressing entries themselves as `BlockChrome` are deferred to the follow-on Lens plans.

#### [P26] TugMessageEditor — one reusable CM6 message field over TugTextEditor (DECIDED) {#p26-message-editor}

**Decision:** A small reusable component, `TugMessageEditor`
(`tugdeck/src/components/tugways/tug-message-editor.tsx` + `.css`), composes the existing
`TugTextEditor` CM6 substrate following the `text-card-find-bar.tsx` pattern: `borderless`,
`maxRows` + `--tug-text-editor-min-height` (≈ the old `rows={3}`), `placeholder`,
`preserveState={false}`, an `EditorView.updateListener` extension mirroring `doc.toString()`
out (search-as-you-type mirror, no controlled-input round-trip), `returnAction="newline"` with
Cmd-Enter → `onSubmit` (Cmd-Enter fires `onSubmit` regardless of `returnAction`, per the
substrate contract), and the delegate seam (`TugTextEditorDelegate`) exposing `restoreState()`
for programmatic prefill and `clear()`. `markdownTextStyling` is OFF (its default). The
commit-message field becomes this component (retiring the `TugTextarea`).

**Rationale:** The markdown-text-styling plan is complete and merged (commit `56d1462de`), so the
substrate-capability house patterns are settled; `text-card-find-bar.tsx` is the proven minimal
borderless-field template. A CM6 field brings the substrate responders for free.

**Implications:** Substrate responders (`CUT`/`COPY`/`PASTE`/`SELECT_ALL`/`UNDO`/`REDO`) come
free — `TugTextEditor` registers them through its own `useOptionalResponder`
(`tug-text-editor.tsx`), so no separate responder wiring is needed on the field ([L11]; the
substrate-responder gotcha — editing surfaces must cover CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO or
Cmd-A/C/X/V/Z go dead — is satisfied by construction). The QuestionDialog
textareas (`chrome/dev-question-dialog.tsx`) are future consumers — OUT of scope here.

#### [P27] Monochrome +N −M is the house diff-badge doctrine; fix the stale coloring comments (DECIDED) {#p27-monochrome-badges}

**Decision:** The `+N −M` diff stat is rendered as two `TugBadge`s with `emphasis="ghost"` and
`role="inherit"` — no border, no fill, no green/red tint — so the pair reads as the header's
own text (`DiffSummaryBadges` in `block-header.tsx` already does this; the code is correct).
Three comments still *describe* the retired green/red coloring and are now stale:
`tool-result-summary.ts`'s `formatDiffSummaryParts` docstring ("colors the added half green and
the removed half red"), the inline comment in `block-header.tsx` around the
`DiffSummaryBadges` call site ("green/red text on the `+N` / `−M` glyphs alone"), and
`edit-tool-block.tsx`'s `[L20]` docstring ("the change-count badge rides the shared
`--tugx-block-tone-*` add / remove tones"). M03B corrects all three to state the monochrome
doctrine. `TugDiffDocument`'s per-file `+/−` counts adopt the same monochrome treatment
([P29]).

**Rationale:** The doctrine is already live in the transcript; only the prose lies. Writing it
down (and fixing the lie) is the enabler for the card's file blocks and the `TugDiffDocument`
restyle to reference one settled rule rather than re-deriving it. Artifact hygiene: a comment
must state what the code does, not a retired behavior.

**Implications:** The status *letters* (A/M/D/R) may keep their tone colors (they carry
semantic meaning); only the `+/−` count glyphs go monochrome.

#### [P28] The commit composer is ONE block; its lifecycle dot is the drafting indicator (DECIDED) {#p28-commit-composer-block}

**Decision:** The `DraftPanel` + `TugTextarea` stack collapses into ONE `BlockChrome`. The
chrome's lifecycle dot IS the drafting indicator: `in_flight` while
`changeset_draft_state`/`changeset_draft_delta` stream, `success` when the draft is ready,
`error` on scribe failure (the error hint stays visible without blanking the draft). Copy-draft
and "Use latest draft" become header actions. The body is a `TugMessageEditor` ([P26]): a new
draft streams into a pristine editor via `restoreState()`; the field pins on first user edit; a
landed commit clears + unpins. The width-stabilized Commit button moves into the block footer.
The existing pinned / `draftText` / receipt semantics ([P24]) are preserved exactly. Deleted:
`DraftPanel`, the `Bot` avatar, the `TugMarkdownBlock` draft rendering, the
`TugProgressIndicator` wave, and the "updating…" freshness text.

**Rationale:** User decision. The mini-transcript `DraftPanel` (a bespoke `side-question-overlay`
borrow) and a separate `TugTextarea` are two idioms doing what one block header + one CM6 body
already express; the lifecycle dot is the house "still working" signal, so a bespoke wave is
redundant.

**Implications:** Dash entries render the composer block **read-only** (no commit controls;
committing a dash is M04's join) — the block header still shows the maintained join-message
draft. Supersedes [P24]'s `TugTextarea` mention (the pinning semantics survive verbatim;
only the widget changes). `changeset-draft-store.ts` and `useChangesetCommit` are unchanged.

#### [P29] Entry-level diff = expand-all/collapse-all over file blocks + one pop-out; in-card TugDiffDocument expansion is deleted (DECIDED) {#p29-entry-diff}

**Decision:** The "Diff N files" toggle (`entryActionsRow`) and the in-card `TugDiffDocument`
expansion (`entryDocInline`) are DELETED. Each changeset file row becomes a `BlockChrome`
(leading commit checkbox in the header's `leading` slot, status glyph + path chip, monochrome
`+N −M` in the header summary slot, provenance + ambiguous/shared badges in pipe-delimited
header sections, a disclosure chevron replacing the `GitCompareArrows` `FileDiffButton`, an
`OPEN_DIFF` pop-out as a header action); the expanded body is a `DiffBlock` `embedded` whose
view-toggle/fold affordances portal into the header actions slot. The entry-level affordance
becomes **expand-all / collapse-all** across the file blocks plus one **whole-entry pop-out**
(`OPEN_DIFF` with the entry descriptor). The dedicated **Diff card** pop-out target
(`cards/diff-card.tsx`, the as-built deviation recorded at #step-16c) is unchanged. Deleted:
`FileRow`, `FileDiffButton`, `InlineFileDiff`, and the `.changeset-file-row` /
`.changeset-inline-diff*` CSS families; the unattributed branch's hand-inlined duplicate row
(the `<div className="changeset-file-row">` block inside `EntryBody`'s unattributed return)
collapses into the same component.

**Rationale:** User decision — diffs belong inline at the change, exactly as the transcript's
tool-call diff blocks read; a per-entry document expansion is a second, divergent diff idiom.
The per-entry `GitDiffStore` sourcing ([P20], `getEntryDiffStore`) is unchanged — the file
block's badge and embedded body read the same per-entry snapshot; the badge is simply absent
until the diff loads. Dash entries (files share one range diff, [P19]) get the same file-block
treatment, per-file bodies sourced from the range payload.

**Implications:** Per-file collapse is entry-body-local `useState` (`expandedFiles`) surfaced to
each file block through a card-local `ToolBlockCollapseContext.Provider` — this is what makes
`BlockChrome` render the chevron and unmount the collapsed body (a standalone `BlockChrome` with
no provider has no chevron and always mounts its body); NO transcript persistence contexts
(`ToolBlockExpansionContext`), no `A9` key. Expand All / Collapse All is a set mutation. The
chevron is disabled for untracked files with no HEAD side (`hasHeadDiff` stays).
`TugDiffDocument` is retained for the `/diff` sheet and the Diff card;
M03B restyles its header onto the block grammar (one non-wrapping quiet line; monochrome
counts) rather than deleting it.

#### [P30] Scribe drafts carry the house scoped commit-subject format (DECIDED) {#p30-scribe-subject-style}

**Decision:** `draft_ask` / `BAKED_STYLE_RULES` in `tugcast/src/scribe.rs` are tightened so
every draft's subject follows the house format — `scope(topic): specific summary` (e.g.
`tugdash(changesets-m03b): …`, `plan(update): …`) — scoped and specific, NEVER a bare one-word
subject like "Fix". The rule is added to the prompt-opening ask (so it holds even when the
packaged skill extraction succeeds) and to the baked fallback const. The existing
`draft_prompt_composers_carry_the_right_sections_per_owner_kind` test asserts the new rule text
reaches each per-owner-kind prompt.

**Rationale:** M03A's `BAKED_STYLE_RULES` only mandates "imperative mood, no period, under 50
characters" — it permits a bare `Fix`. The repo's own commit log is uniformly scoped
(`tugdash(...)`, `plan(...)`), so the maintained draft must match that voice to be
commit-ready without hand-editing.

**Implications:** Rust-only step; verified by the fake-`ScribeSpawner` composer tests (never by
asserting model prose). Pairs with the `push_voice_section` recent-subjects hint that already
seeds voice from real `git log` subjects.

#### [P31] Join conflicts resolve through an off-to-the-side escalation ladder (DECIDED) {#p31-resolution-ladder}

**Decision:** A conflicted join is not a dead end and not a hand-off — `tugdash-core` gains a
**resolution ladder** that works the conflict as hard as possible before any AI or human sees
it, and the whole thing runs **off to the side**: the join commit is built beside the user's
checkouts (resolved blobs → `git hash-object -w` → tree patched via `mktree` → `commit-tree`
with base as parent) and landed by fast-forwarding base onto it. No checkout is ever
half-merged; abort is free at every rung. The rungs, in order:

1. **Replay probe.** The conflicts `git merge-tree` reports are survivors of a full ORT
   content-level merge of the *cumulative* diff. Replaying the dash's rounds one at a time
   gives ORT a precise base per step and frequently auto-resolves what the one-shot squash
   cannot (the classic case: base already cherry-picked or hand-applied part of the dash's
   work). The probe is **in-memory per round**: `git merge-tree --write-tree
   --merge-base=<round^> <tip> <round>` + `commit-tree` builds the replayed chain without
   touching any checkout (the existing Rebase strategy's base-worktree cherry-pick is NOT
   reused — it dirties base mid-probe). `--merge-base` needs **git ≥ 2.40** — below that
   the rung is skipped (same guard style as `git_supports_merge_tree`). If the replay is
   fully clean, the join lands **as the replayed rounds** — the history-shape change
   (linear rounds instead of one squash) is accepted silently (user decision; `--strategy`
   still forces a shape explicitly).
2. **Recorded resolutions (`rerere`).** `rerere.enabled` + `rerere.autoUpdate` are set to
   true for dash repos (user decision) — `tugdash create`/`join` set them on the repo.
   Recordings come from two real sources: manual base-into-dash merges inside dash
   worktrees (worktrees share `.git`, so the `rr-cache` is shared with the base checkout),
   and **the ladder recording its own driver/AI resolutions** after validation — so an
   identical future conflict skips straight past the expensive rungs. Application requires
   a merge-in-progress state (rerere cannot run on bare blobs), so this rung runs in a
   **scratch detached worktree**: `git worktree add --detach`, merge, harvest the
   rerere-resolved files, remove the scratch — the user's checkouts stay untouched.
3. **Per-file re-merge.** `git merge-file` retries on the three blob stages with
   `zdiff3`/histogram settings — occasionally shrinks or eliminates conflicts the default
   xdiff flags.
4. **Structured merge (shell-out seam, now — user decision).** A per-file merge-driver seam
   that invokes `mergiraf` (AST-aware structured merge, Rust CLI) on the three stages as
   temp files **when found on PATH** — resolving the classic false conflicts (two functions
   added at the same spot, both sides extending an import list). Never bundled (AGPL);
   absence just skips the rung. The seam is generic (configured command, mergiraf the
   default) so other drivers can slot in.
5. **AI file-merge ([P32]).** Whatever survives 1–4 is genuinely overlapping intent.

Every rung's outcome is recorded per file (`resolved_by: replay|rerere|merge-file|driver|ai`)
so the CLI `--json` and the card can report exactly what happened. **Non-content conflicts**
(delete/modify, binary, mode) short-circuit past the text rungs (3–5) straight to
`unresolved` — text tools never guess at structure. A candidate commit is landed only if
its parent still equals the base head at land time (staleness guard — base moved ⇒
re-resolve).

**Rationale:** User decision (three-way design discussion, settled): the join engine must
work *very hard* algorithmically before resorting to AI, and the AI rung must not be a
hand-off to a full session. `merge-tree --write-tree` already hands us the candidate tree
and the stage-1/2/3 blobs per conflicted path — building the finished commit off to the
side is the mechanical insight that makes every rung safe and the journal trivial.

**Implications:** `tugdash join --resolve` runs the ladder from the CLI; the
`changeset_join_resolve` verb (Spec S12) runs it for the card. Step 19's clean-abort
conflict path survives as the no-`--resolve` behavior and the ladder's own last resort.

#### [P32] The AI rung is a per-file scribe merge with a /btw-shaped overlay — never a Dev card (DECIDED) {#p32-ai-file-merge}

**Decision:** AI conflict resolution is a **headless, per-file, stateless** task on the
existing `ScribeSpawner` seam ([P11]): for each file the ladder could not resolve, tugcast
spawns `claude -p` with the three versions (base/ours/theirs) plus intent context we already
hold — the dash's maintained join draft ([P23]) and its round subjects — and asks for the
merged file. The output passes **deterministic validation** (no conflict markers, non-empty;
cheap parse checks where available) or the file stays honestly unresolved. Progress streams
over CONTROL (`changeset_join_resolve_delta`, Spec S12) into a small **`/btw`-style overlay**
on the card's dash entry — mini-transcript feel, overlay-only, no Dev card, no session, no
transcript ink. The resolved result is **never auto-committed**: the join preview flips to a
reviewable resolved diff (per-file inline `DiffBlock`s via the range descriptor against the
candidate commit, each badged with its `resolved_by` rung) and **Join** lands the pre-built
commit only on explicit confirm. Purely-algorithmic resolutions ride the same review gate.

**Rationale:** User decision — the original Step-21 gesture ("Resolve with AI" spawns a
session in the dash worktree) put the burden back on the user and required new
prompt-seeding plumbing through the compiled tugcode binary; the actual problem ("merge
three versions of one file") is exactly scribe-shaped, and the streaming-overlay UX
precedent ([P24], the `/btw` overlay) already exists.

**Implications:** Supersedes Step 21's `spawn_session`-based conflict affordance (deleted —
no session is ever spawned for a join). `ScribeSpawner` gains a file-merge prompt composer
(tested with the fake spawner, never by asserting model prose); per-file timeout matches the
draft engine's. The card needs a small join-resolve overlay store
(`changeset-join-store.ts`) keyed `(project_dir, dash)`.

---

### Deep Dives {#deep-dives}

#### The attribution pipeline, end to end {#attribution-pipeline}

```
claude stream-json ─▶ tugcode session.ts (assembles ToolUse{input}, ToolResult)
  ─▶ tugcode stdout (one JSON line per frame)
  ─▶ tugcast agent_bridge.rs relay loop            ◀── INTERCEPT HERE [P03]
        tool_use:    pending[tool_use_id] = {tool_name, file_path|command, parent_id}
                     Bash → open bracket (pre-snapshot)             [P05]
        tool_result: is_error? drop : persist file_events rows      [P04]
                     Bash → close bracket (post-snapshot, delta)
                     → bump workspace ChangesetFeed                 [P09]
        (pending map: size-capped, evict-oldest — never cleared on turn_complete;
         background-agent child frames straddle turn boundaries)
  ─▶ splice_tug_session_id ─▶ FeedId::CODE_OUTPUT (unchanged, always)
```

Key shapes (from `tugcode/src/types.ts`): `ToolUse{type:"tool_use", tool_name, tool_use_id,
input: object, parent_tool_use_id?, timestamp?}`; `ToolResult{type:"tool_result",
tool_use_id, output, is_error, timestamp?}`. The result does NOT carry the tool name or
input — hence the pending map. `tool_input_progress` frames are display telemetry and are
ignored by attribution.

Exact-attribution tool names and their path fields: `Write`→`input.file_path`,
`Edit`→`input.file_path`, `MultiEdit`→`input.file_path` (legacy, still handled),
`NotebookEdit`→`input.notebook_path`. Paths are stored as given (absolute); repo-relative
projection happens at query time against `project_dir`.

#### Bracket algorithm {#bracket-algorithm}

A bracket registry `Mutex<HashMap<RepoRoot, Vec<OpenBracket>>>` lives on `AgentSupervisor`
and is cloned into every relay. `OpenBracket{tug_session_id, tool_use_id, opened_at,
pre: HashMap<PathBuf, FileState>}` where `FileState` is the porcelain-v2 XY status plus
mtime. Repo root = the same ancestor walk `is_within_git_worktree` uses (`feeds/git.rs`);
non-repo project dirs never open brackets.

On close: `delta = paths where post != pre (added / removed / status-changed)`. Each delta
path becomes a `file_events` row with `origin='bash'`, `op` derived from the transition
(created/modified/deleted/renamed). `ambiguous=1` iff any *other* session's bracket on the
same root overlapped `[opened_at, closed_at]`. Brackets abandoned by a dying relay are
dropped with the relay (registry entries carry the session id; relay teardown sweeps them).

Known limitation, by design: a `run_in_background` Bash command returns its `tool_result`
immediately, so writes the detached command makes after the bracket closes land as
unattributed. Do not hold brackets open to chase this — unattributed-but-visible is the
honest answer (see Non-goals).

#### ChangesetSnapshot composition {#snapshot-composition}

The feed recomputes by: (1) run the `GitFeed` status parse (branch, ahead/behind, head,
staged/unstaged/untracked); (2) query `file_events` for all sessions whose ledger rows have
`project_dir` = this workspace (join through the `sessions` table; owner display name =
session `name` when `name_user_set`, else the id hash — same rule the Z4B chip uses); (3)
derive dash entries the way `run_dash_list` does (`git for-each-ref refs/heads/tugdash/`,
config `branch.<b>.tugbase`, worktree dirt); (4) partition dirty files: owned (event row
exists), ambiguous, unattributed. **Multi-owner rule:** a file with event rows from more
than one owner (e.g. an exact row from session A and a bash row from session B) appears in
*each* owning changeset with `shared: true`; shared files, like ambiguous ones, are excluded
from the card's default commit selection ([P15]) — one session's commit must never silently
sweep a file another session also touched. Committed-but-unpushed work appears via
ahead-count only — per-owner committed history is not in the M02 snapshot.

#### Replay/idempotency invariant {#replay-idempotency}

Any frame may be seen more than once per row lifetime (resume replays full history;
`subagent-tail.resetForReplay()` re-streams background-agent children from offset 0 on
reconnect). The invariant: **persisting a file event is an upsert keyed
`(tug_session_id, tool_use_id, file_path)`; processing the same frame twice is a no-op.**
Brackets never open in replay (`in_replay` guard) — [P06]. Note one asymmetry: reconnect
re-streams of subagent children arrive as LIVE frames (not `in_replay`). This is benign and
needs no special handling — re-streamed exact events upsert into existing rows, and a
re-streamed Bash child re-opens a bracket whose close computes an empty delta (the disk
hasn't changed), recording nothing. Do not add a dedup layer for this case.

#### Aggregate delivery — why the M02 feed was bootstrap-only, and the CHANGESET_ALL blueprint {#aggregate-delivery}

The M02 per-workspace CHANGESET feed computes correct snapshots for **every** workspace, but
its frames reach clients only for the bootstrap `--source-tree` workspace:

- Each `WorkspaceEntry`'s `ChangesetFeed` publishes to a **per-workspace**
  `watch::Receiver`, and `main.rs`'s `add_snapshot_watches` registers only the **bootstrap**
  entry's receiver into the router.
- Per-session `WorkspaceEntry`s created in `AgentSupervisor` are **dropped** right after
  registration (only their `workspace_key` is retained), so their changeset watch receivers
  dangle — frames computed, never routed.
- `FILETREE` escapes this because it publishes to a **shared broadcast channel** every client
  subscribes to (`ft_response_tx` created in `main.rs`, handed into each `FileTreeFeed` in
  `workspace_registry.rs`, registered once via `add_broadcast_senders`). CHANGESET — and the
  retired GIT feed before it — never adopted that; nobody noticed because the bootstrap repo
  is always open.

`CHANGESET_ALL` sidesteps the gap by being **process-level from birth**, delivered as a
**single process-level snapshot watch** — the `spawn_stats_feeds` / `defaults_feed` pattern:
the feed yields one `watch::Receiver` pushed into `add_snapshot_watches` once at startup
(`spawn_snapshot_feed` in `tugcast-core/src/feed.rs` is the runner). The invariant is **one
process-wide registration, never per-workspace**.

Do **not** use the USAGE broadcast pattern (`broadcast::channel` + `add_broadcast_senders`):
the router documents that broadcast senders get **no deliver-on-connect pass** — broadcast
streams are event-only with no retained latest value — while `snapshot_watches` deliver the
retained latest frame to every newly connected client. USAGE tolerates that because it is
request/response-driven; an aggregate *snapshot* card opened after the last recompute would
sit blank until the next bump or poll tick. The watch pattern gives instant-on-connect for
free.

Client-side, aggregation must stay **server-side**: tugdeck's `FeedStore` keeps one value per
feed id, so per-project frames on one id would clobber each other; the account-global client
precedents are `UsageStore` (`new FeedStore(conn, [FeedId.USAGE])`, no workspace filter) and
`PulseStore` — **not** the filtered `useCardData` → `useCardWorkspaceKey` path.

#### Diff descriptor resolution {#diff-descriptor-resolution}

The two flavors resolve to git invocations as follows (all in `feeds/git.rs`):

- **head** `{root, paths?}`: exactly today's `build_git_diff_snapshot` — `git diff HEAD
  [-- <paths…>]` in the workspace resolved from `root` (the `resolve_diff_target` fallback
  chain in `main.rs` stays). Untracked files never appear (no HEAD side) — the card's
  `hasHeadDiff()` guard stays for this flavor.
- **range** `{worktree, base, branch}`: the honest "everything this dash has done" view is
  committed rounds **plus** uncommitted worktree dirt in one diff. Three-dot syntax can't
  include a dirty working tree, so resolve in two steps: `git -C <worktree> merge-base
  <base> <branch>` → `MB`, then `git -C <worktree> diff <MB>` (working tree vs. merge base
  = rounds + dirt, and upstream drift on `base` stays out — the same semantics as
  `base...branch` for the committed part). When the worktree path does not exist (a dash
  branch without a checked-out worktree), fall back to `git diff <base>...<branch>` in the
  repo root — committed rounds only, which is then the whole truth. The snapshot's `base`
  field carries the human-readable range (e.g. `main...tugdash/fix-join`) so the document
  header reads correctly.

The `GitDiffPayload` wire shape is unchanged (files + totals + unified chunks); only the
query grows. One store instance per consumer (the M03 `gd-<storeId>-<seq>` request-id
scheme) keeps concurrent scoped queries from cross-correlating.

#### The maintained draft engine {#draft-engine}

```
attribution write / dash commit / hand edit
  ─▶ ChangesetBumper.bump ─▶ CHANGESET_ALL recompute (feeds/changeset_all.rs)
  ─▶ diff-suppressed frame on the aggregate watch channel
       └─▶ DraftEngine (feeds/draft_engine.rs) taps a CLONED watch::Receiver
             per-entry change key changed?  ──no──▶ ignore
               │ yes: arm/reset that entry's ~10s quiet timer
               ▼ timer fires
             compute fingerprint (Spec S11)  ──unchanged──▶ done (no call)
               │ changed: abort any in-flight run for this entry (coalesce)
               ▼
             broadcast changeset_draft_state{drafting} ─▶ CONTROL
             streaming scribe run (deltas ─▶ changeset_draft_delta ─▶ CONTROL)
               │ success AND fingerprint still current
               ▼
             persist changeset_drafts row (Spec S09) ─▶ fire global bump
             ─▶ next aggregate frame carries the draft (Spec S10) ─▶ card
```

Load-bearing wiring facts:

- **Do NOT share the bump `Notify`.** `registry.changeset_all_bump()` uses
  `notify_one` permit semantics with the `ChangesetAllFeed` loop as the sole waiter — a
  second waiter would steal permits and starve the feed. The engine instead **clones the
  aggregate `watch::Receiver<Frame>`** that `spawn_snapshot_feed` yields in `main.rs`
  (`watch::Receiver` is `Clone`; the router keeps its copy for `add_snapshot_watches`) and
  deserializes each frame back to `WorkspacesChangesetSnapshot`. Frames are diff-suppressed
  upstream, so every wake is a real change.
- **Change key, not the whole entry.** Persisted drafts ride inside the snapshot (Spec S10),
  so a draft landing changes the frame; keying the quiet timer on the raw entry would
  re-arm on every draft land. The engine derives a per-entry change key that EXCLUDES draft
  fields: sessions/unattributed → sorted `(path, git_status)` pairs + max `last_touched`;
  dashes → `(rounds, worktree_dirty, sorted file paths)`. Entry identity =
  `(project_dir, owner_kind, owner_id)` with `owner_id = ""` for unattributed.
- **Turn-end is subsumed.** File writes bump the aggregate as they land (the attribution
  intercept), so "turn-end + fs quiet" ≈ "10s of quiet after the last write" — no
  `turn_complete` plumbing is needed. A turn that writes early then thinks for minutes
  regenerates mid-turn; that is the desired "maintained as work proceeds" behavior, and the
  fingerprint gate bounds cost. Dash rounds land as branch/worktree changes the 2s poll or
  bump picks up.
- **Eligibility.** Sessions/unattributed with ≥1 file; dashes with `rounds > 0` or a dirty
  worktree. Fileless clean entries get no draft and no scribe call; `compose_snapshot`
  attaches a persisted draft to an entry only while the entry is eligible (a stale row for
  a since-committed changeset stays in the table, harmlessly superseded by the next cycle).
- **Ownership/lifecycle.** The engine is spawned via
  `AgentSupervisor::start_draft_engine(watch_rx)` (the `set_scribe` idiom) so it can clone
  the supervisor's `control_tx`, `session_ledger`, `registry`, `ScribeContext`, and a
  **session resolver** `Arc<dyn Fn(&str) -> Option<String>>` mapping `tug_session_id →
  claude_session_id` — that mapping lives only in the supervisor's in-memory
  `LedgerEntry.claude_session_id` (`feeds/agent_supervisor.rs`), populated from
  `session_init`; it is not a `sessions` table column.
- **Prompt context** (Spec S11) for a session entry includes the owning session's user
  prompts since the changeset began, read from the **session JSONL** — the ledger's
  `last_user_prompt` is one line and too thin. Path:
  `ledger.claude_projects_root() / encode_claude_project_name(project_dir) /
  <claude_session_id>.jsonl` (both helpers in `session_ledger.rs`). Reuse
  `external_sessions.rs`'s pure line classifiers (`user_submission_opens_turn`,
  `submission_text`, `parse_timestamp_millis`) to keep only genuine submissions. "Since the
  changeset began" = the minimum `at` across the entry's `file_events` rows for
  currently-dirty paths (`file_events_for_session`); when that can't be resolved (no
  claude id — resolver returns `None` for a non-live session; missing JSONL), degrade to
  diff + conventions, never fail the draft.
- **Style rules** come from the packaged commit skill:
  `crate::resources::source_tree().join("tugplug/skills/commit/SKILL.md")` — in a bundle
  `TUGCAST_RESOURCE_ROOT` points at `Contents/Resources/` (which contains `tugplug/`), and
  the debug fallback resolves to the tugtool source root (which also contains `tugplug/`),
  so one join works everywhere. Extract the message-format contract: the section between
  the `3. **Compose the Commit Message**` and `4. **Stage and Commit**` headings plus the
  two "Examples of …" sections. A baked-in const of those rules (subject ≤50 chars
  imperative no-period, terse factual bullets, no filler/buzzwords, NEVER any AI/agent
  attribution) is the fallback when the file read or extraction fails.
- **Errors** broadcast `changeset_draft_state{state:"error", detail}` and log via
  `tracing::warn` server-side; the card shows the stale draft with a subtle error hint —
  a scribe failure must never blank an existing message.

---

### Specification {#specification}

**Spec S01: `file_events` schema** {#s01-file-events-schema}

```sql
CREATE TABLE IF NOT EXISTS file_events (
    tug_session_id TEXT NOT NULL,
    tool_use_id    TEXT NOT NULL,
    file_path      TEXT NOT NULL,   -- as given by the tool input / bracket delta (absolute)
    tool_name      TEXT NOT NULL,   -- Write | Edit | MultiEdit | NotebookEdit | Bash
    op             TEXT NOT NULL,   -- write | edit | notebook | created | modified | deleted | renamed
    origin         TEXT NOT NULL,   -- exact | bash | replay
    ambiguous      INTEGER NOT NULL DEFAULT 0,
    parent_tool_use_id TEXT,        -- set for subagent-issued calls
    project_dir    TEXT NOT NULL,   -- checkout root at event time (worktree-aware)
    at             INTEGER NOT NULL,-- epoch ms (frame time live; ToolUse.timestamp on replay)
    PRIMARY KEY (tug_session_id, tool_use_id, file_path)
);
CREATE INDEX IF NOT EXISTS file_events_project ON file_events(project_dir, at);
CREATE TRIGGER IF NOT EXISTS file_events_cascade_delete_on_session ...  -- same idiom as turns
```

Bash rows use the bracket's `tool_use_id`; a Bash call touching N files yields N rows.

**Spec S02: `ChangesetSnapshot` wire shape (CHANGESET feed, 0x23)** {#s02-changeset-snapshot}

```jsonc
{
  "workspace_key": "…",              // spliced first, like GIT frames
  "branch": "main", "ahead": 0, "behind": 0,
  "head_sha": "…", "head_message": "…",
  "changesets": [
    { "kind": "session", "owner_id": "<tug_session_id>", "display_name": "…",
      "live": true,
      "files": [ { "path": "tugdeck/src/foo.ts", "git_status": "M ",
                   "op": "edit", "origin": "exact", "ambiguous": false,
                   "shared": false, "last_touched": 0 } ] },
    { "kind": "dash", "owner_id": "tugdash/fix-join", "display_name": "fix-join",
      "base": "main", "rounds": 3, "worktree": ".tug/worktrees/tugdash__fix-join",
      "worktree_dirty": false, "files": [ /* base..branch name-status */ ] }
  ],
  "unattributed": [ { "path": "…", "git_status": "??" } ]
}
```

Paths in the snapshot are repo-relative. Rust structs in `tugcast-core/src/types.rs`; TS
mirror + golden fixture per [P10].

**Spec S03: CONTROL verbs** {#s03-control-verbs}

Handled in `AgentSupervisor::handle_control` alongside `spawn_session`/`list_sessions`:

- `changeset_commit {project_dir, files: [repo-relative…], message}` →
  `changeset_commit_ok {sha, receipt}` | `changeset_commit_err {detail}`. Runs
  `git add -- <files…>` + `git commit -m`; receipt = `git show --numstat --format= HEAD`.
- `changeset_summarize {project_dir, owner_kind, owner_id, files, kind: "summary"|"commit_message"}`
  → `changeset_summarize_ok {text}` | `…_err {detail}` ([P11]).
- `changeset_join {project_dir, dash, strategy?, message?, preview: bool}` →
  `changeset_join_ok {…}` with, for preview, `{clean: bool, conflicts: [path…]}` ([P14],
  M04 — the verb calls `tugdash-core`).

**Spec S04: `tugutil changes` output** {#s04-tugutil-changes}

`tugutil changes [--session <tug_session_id>] [--project <dir>] [--json]`. Session defaults
from `$TUG_SESSION_ID`; project from cwd. Joins event rows against `git status --porcelain=v2`
so vanished/committed files drop out. Plain output: one repo-relative path per line,
**excluding ambiguous rows**, with a one-line stderr note when any were excluded
("N ambiguous file(s) omitted — use --json"). `--json` (the commit-skill contract):
`{session, project, files: [{path, op, origin, ambiguous, git_status}]}` — includes
ambiguous rows with the flag set. Exit 2 when the session id is missing/unknown.

**Spec S05: `tugdash` CLI surface** {#s05-tugdash-cli}

`tugdash create <name> [--description] [--json]` · `tugdash commit <name> --message … [--json]`
(stdin round-meta preserved) · `tugdash join <name> [--strategy squash|merge|rebase]
[--preview] [--continue] [--message] [--json]` · `tugdash release <name>` · `tugdash list
[--json]` · `tugdash show <name> [--json]`. Behavior identical to today's `tugutil dash`
except: new worktree home ([P13]), join engine v2 ([P14]), auto-commit failure is fatal.

**Spec S06: `WorkspacesChangesetSnapshot` wire shape (CHANGESET_ALL feed, ~0x24)** {#s06-workspaces-changeset-snapshot}

```jsonc
{
  "projects": [
    {
      "project_dir":   "/abs/checkout/root",  // absolute; also the clickable-link base
      "display_name":  "tugtool",             // basename of project_dir
      "workspace_key": "…",
      "no_repo":       false,                 // true → "Not a git repository" + Init affordance
      // when no_repo is false, the ChangesetSnapshot payload (Spec S02) follows:
      "branch": "main", "ahead": 0, "behind": 0,
      "head_sha": "…", "head_message": "…",
      "changesets":   [ /* ChangesetEntry, Spec S02 — reused, not redefined */ ],
      "unattributed": [ /* UnattributedFile, Spec S02 */ ]
    }
  ]
}
```

`no_repo: true` elements carry empty `changesets`/`unattributed` and empty-string/zero git
header fields. Rust structs `WorkspacesChangesetSnapshot` / `ProjectChangeset` in
`tugcast-core/src/types.rs` reuse the Step-8 `ChangesetEntry`/`ChangesetFile`/
`UnattributedFile` types; TS mirror in `tugdeck/src/lib/changeset-types.ts`; golden fixture
guarded on both sides per [P10]. Whether the S02 fields are flattened into `ProjectChangeset`
or embedded as a nested object is decided at #step-12a and pinned by the fixture.

**Spec S07: `changeset_git_init` CONTROL verb** {#s07-changeset-git-init}

Handled in `AgentSupervisor::handle_control` alongside the Spec S03 verbs:

- `changeset_git_init {project_dir}` → `changeset_git_init_ok {}` |
  `changeset_git_init_err {detail}`. Validates that `project_dir` matches a **current
  `WorkspaceRegistry` entry** (never init an arbitrary path off the wire) and is **not**
  already inside a git worktree (`is_within_git_worktree`), then runs `git init -b main` in
  `project_dir`; `err` carries stderr detail. On success it fires the global aggregate bump
  so the card's section **self-heals** to a clean/empty changeset on the next recompute —
  no client-side state transition needed. Ships in M02A per decision D4 in
  `dash/workspace-tracking-plan.md` ([P17]).

**Spec S08: Diff descriptor + GIT_DIFF_QUERY extension** {#s08-diff-descriptor}

Client type (`tugdeck/src/lib/git-diff-store.ts`; supersedes-and-extends `GitDiffScope`):

```ts
type DiffDescriptor =
  | { kind: "head"; root?: string; paths?: string[] }   // git diff HEAD [-- paths]
  | { kind: "range"; worktree: string; base: string; branch: string };
```

`GIT_DIFF_QUERY` (0x22) JSON payload gains optional `worktree`, `base`, `branch` beside the
existing `root`/`requestId`/`paths`; a present `branch` selects the range flavor
(#diff-descriptor-resolution). The `GIT_DIFF` (0x21) response shape (`GitDiffPayload`) is
unchanged; for the range flavor `base` carries the display range (`<base>...<branch>`).
`GitDiffStore.requestDiff(descriptor)` keeps its remember-last-scope Refresh semantics and
its store-unique request ids. Descriptor **identity key** (for `OPEN_DIFF` card reuse):
`head:<root>:<sorted paths joined by \n>` / `range:<worktree>:<base>:<branch>`.

**Spec S09: `changeset_drafts` schema + ledger API** {#s09-changeset-drafts}

```sql
CREATE TABLE IF NOT EXISTS changeset_drafts (
    owner_kind  TEXT NOT NULL,      -- session | dash | unattributed
    owner_id    TEXT NOT NULL,      -- tug_session_id | tugdash/<name> | '' (unattributed)
    project_dir TEXT NOT NULL,
    fingerprint TEXT NOT NULL,      -- Spec S11
    message     TEXT NOT NULL,      -- the maintained commit message (subject + bullets)
    updated_at  INTEGER NOT NULL,   -- epoch ms
    PRIMARY KEY (owner_kind, owner_id, project_dir)
);
```

Added in `bootstrap_schema` (`tugcast/src/session_ledger.rs`) with the self-healing drifted-
table guard (the `file_events` idiom). NO cascade trigger on `sessions` — dash and
unattributed owners are not session rows; rows are advisory and superseded in place. Ledger
API: `upsert_changeset_draft(&ChangesetDraftRow)`, `changeset_draft(owner_kind, owner_id,
project_dir) -> Option<ChangesetDraftRow>`, `changeset_drafts_for_project(project_dir)`
(the compose-time bulk read).

**Spec S10: Draft wire — snapshot fields + CONTROL frames** {#s10-draft-wire}

Snapshot (Rust `tugcast-core/src/types.rs`, TS mirror `tugdeck/src/lib/changeset-types.ts`,
both golden fixtures updated per [P10]):

```jsonc
// ChangesetEntry::Session and ::Dash gain (skipped when absent):
"draft": { "fingerprint": "…", "message": "subject line\n\n- bullet", "updated_at": 0 }
// ProjectChangeset gains, for the unattributed bucket:
"unattributed_draft": { /* same shape */ }
```

CONTROL broadcast frames (the `changeset_commit_*` idiom — JSON with an `action` field, no
request correlation needed since drafts are server-initiated):

- `changeset_draft_state {project_dir, owner_kind, owner_id, state: "drafting"|"ready"|"error", detail?}`
- `changeset_draft_delta {project_dir, owner_kind, owner_id, text}` — `text` is the
  **accumulated** generation so far (idempotent against a dropped frame), sent at most ~4/s.

The persisted snapshot message is the source of truth; the CONTROL frames are a live overlay
the client store (`changeset-draft-store.ts`) clears when a snapshot with a newer
`updated_at` arrives.

**Spec S11: Fingerprint + draft prompt composition** {#s11-fingerprint-prompt}

Fingerprint = hex SHA-256 (`sha2` is already a tugcast dependency) over a canonical byte
string:

- **session / unattributed:** the sorted `(path, git_status)` list, then the scoped
  `git diff HEAD -- <paths…>` text, then per **untracked** file `(path, size, mtime-ms)`
  from fs metadata (untracked content is invisible to `git diff HEAD`).
- **dash:** `git rev-parse <branch>`, then the worktree's `git status --porcelain` output
  (empty when no worktree).

Prompt composition (pure fns in `tugcast/src/scribe.rs`, one per owner kind; asks for a
commit message only — the summary kind is gone):

- **session:** the ask (style rules per #draft-engine) + scoped diff (truncated to 150,000
  chars with a `[diff truncated]` marker) + file list with op/origin provenance + the
  owning session's user prompts since the changeset began (JSONL, newest-last, cap 20
  prompts / 2,000 chars each) + the last 10 `git log --format=%s` subjects for voice.
- **dash:** the ask (this is the future squash message, [P23]) + `git log <base>..<branch>
  --format=%s%n%b` + the dash's dash-log lines (instruction metadata) + the merge-base
  diff (same truncation) + the same git-log voice subjects.
- **unattributed:** the ask + diff + file list + voice subjects only (no session context).

**Spec S12: `changeset_join_resolve` verb + progress deltas** {#s12-join-resolve}

Handled in `AgentSupervisor::handle_control` beside the Spec S03 verbs; the ladder itself
lives in `tugdash-core` ([P31]) with the AI rung injected by tugcast ([P32]):

- `changeset_join_resolve {project_dir, dash}` — run the resolution ladder against the
  dash's current conflict set. Guards match the other changeset verbs (registered
  workspace + git worktree). Runs the join engine's auto-commit preamble first
  (outstanding dash-worktree dirt is committed, as the execute path does) so the conflict
  set and the candidate are computed against the true branch tip.
- Progress: `changeset_join_resolve_delta {project_dir, dash, path, rung, status}` per
  file/rung transition (`status: trying|resolved|unresolved`), the `/btw`-overlay feed.
- Terminal: `changeset_join_resolve_ok {project_dir, dash, resolved: [{path, resolved_by}],
  unresolved: [path…], candidate_commit, shape: "squash"|"replay"}` |
  `changeset_join_resolve_err {project_dir, dash, detail}`. `candidate_commit` is present
  when every conflict resolved (the pre-built join commit, or the replayed head for the
  replay shape); absent when any file stayed unresolved.
- Landing: `changeset_join {…, candidate: <sha>}` — the execute form gains an optional
  `candidate`; when present the join fast-forwards base onto it **iff** the candidate's
  parent (or replay base) still equals the base head (staleness guard, [P31]); a stale
  candidate returns `changeset_join_err {detail: "stale candidate…"}` and the card
  re-resolves. Candidate landing enters the existing `JoinJournal` →
  `finish_join_teardown` path (worktree removal, branch delete, dash-log "joined" line,
  resumable via `--continue`) — a landed candidate always tears the dash down.

CLI mirror: `tugdash join --resolve [--json]` runs ladder + land in one command (same
staleness guard between build and land, trivially satisfied in-process).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| ChangesetSnapshot (feed data) | local-data (external) | `FeedStore` → `useCardData<ChangesetSnapshot>()` (already `useSyncExternalStore`-backed via `useCardFeedStore`) | [L02] |
| Section expand/collapse per owner | local-data (ephemeral UI) | `useState` in the card component | — |
| File selection for commit | local-data (ephemeral UI) | `useState` (cleared on snapshot change when selected paths vanish) | — |
| Commit/summarize in-flight + result | local-data (external, async verb round-trip) | small module store + `useSyncExternalStore` (CONTROL request/response, like other verb stores) | [L02] |
| Diff sheet visibility/content | local-data (external) | existing `git-diff-store.ts` pattern (extended for pathspec) | [L02] |
| Hover/active row appearance | appearance | CSS only | [L06] |
| WorkspacesChangesetSnapshot (aggregate feed data, M02A) | local-data (external) | app-level singleton store (`FeedStore` on CHANGESET_ALL, the UsageStore pattern, no workspace filter) + context hook via `useSyncExternalStore` | [L02] |
| Per-project section expand/collapse (M02A) | local-data (ephemeral UI) | `useState` in the card component | — |
| git-init in-flight/result (M02A) | local-data (external, async verb round-trip) | verb round-trip store + `useSyncExternalStore` | [L02] |
| Per-entry inline diff payload (M03A) | local-data (external) | per-entry `GitDiffStore` instances over the shared changeset FeedStore, read via `useSyncExternalStore` | [L02] |
| Inline diff expansion (per file / per entry) (M03A) | local-data (ephemeral UI) | `useState` in the entry body | — |
| Draft live overlay: state + streaming text (M03A) | local-data (external) | `changeset-draft-store.ts` (CONTROL frames) + `useSyncExternalStore` | [L02] |
| Draft message field + user-edit pin (M03A) | local-data (ephemeral UI) | `useState` (`TugTextarea` value + pristine flag; re-seeds from a newer draft only while pristine, [P24]) | — |
| Join/Release verb round-trips (M04) | local-data (external, async verb round-trip) | `changeset-verb-store.ts` join/release state + `useSyncExternalStore` | [L02] |
| Join-resolve progress overlay + resolved result (M04) | local-data (external) | `changeset-join-store.ts` (CONTROL deltas, Spec S12) + `useSyncExternalStore` | [L02] |
| Persisted draft text (M03A) | server-owned | rides the aggregate snapshot (Spec S10); persisted in sessions.db, never client storage | [L02] |
| Text-card diff mode descriptor (M03A) | structure | card initial-content channel (the open-file seeding path) + descriptor-keyed open registry | — |
| Commit-message field text + pristine/pin flag (M03B) | local-data (ephemeral UI) | `useState` mirroring the `TugMessageEditor` CM6 doc out via `updateListener`; `restoreState()` re-seeds only while pristine ([P24], [P26], [P28]) | [L11] |
| Per-file / per-block collapse in an entry (M03B) | local-data (ephemeral UI) | entry-body `useState` (`expandedFiles` set) fed to a card-local `ToolBlockCollapseContext.Provider` per file block (gives the chevron + collapse-by-unmount); NOT `ToolBlockExpansionContext`, no persistence ([P29]) | [L24], [L26] |
| Block-header lifecycle dot phase (draft/commit state) (M03B) | local-data (external, derived) | mapped from the `changeset-draft-store.ts` overlay + `useChangesetCommit` phase to `BlockChrome`'s `phase` prop; the dot paints via CSS/DOM inside the indicator ([L06]) | [L02] |

No new persistent UI state; nothing touches localStorage. Read-only file lists render no
tabindex (mousedown-focus default gotcha). The `TugMessageEditor` CM6 field brings substrate
responders (`CUT`/`COPY`/`PASTE`/`SELECT_ALL`/`UNDO`/`REDO`) with it via `TugTextEditor` — no
separate responder registration ([P26]).

---

### Compatibility / Migration / Rollout {#rollout}

- **sessions.db**: additive table + trigger via the existing self-healing `bootstrap_schema`
  guard; older tugcast binaries ignore it. No version bump needed (matches how
  `pulse_lines` was added).
- **`.tugtree/` → `.tug/worktrees/`**: auto-migration per [P13]; `tugutil init --force`
  refreshes the gitignore block; `.tugtree/` gitignore line is left in place (harmless) but
  new inits write only `.tug/`.
- **`tugutil dash` removal**: same-milestone cutover of tugplug skills ([#step-20]); no
  deprecation alias. The skills are the only programmatic callers and they update in
  lockstep; a stray `tugutil dash` invocation gets clap's unknown-subcommand error, and
  tugdash ships in the same commit series.
- **Feeds**: CHANGESET (0x23) is additive; GIT (0x20) stops being registered at M02 close
  ([P16]) — old decks reconnect and simply never receive 0x20 frames (snapshot feeds are
  absent-tolerant: the git card shows its loading state, and the card itself is removed in
  the same release).
- **Rollback**: each milestone is revertible independently; attribution rows are advisory
  data (nothing else keys on them).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New crates {#new-crates}

| Crate | Purpose |
|-------|---------|
| `tugrust/crates/tugdash-core` | Dash/worktree library: naming, create/commit/join/release/list/show, join engine v2, migration; callable from tugcast |
| `tugrust/crates/tugdash` | The standalone CLI binary over tugdash-core |

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/feeds/attribution.rs` | Tool-frame parsing (`InspectedToolUse`/`InspectedToolResult`), pending map, bracket registry, `record_file_event` glue |
| `tugrust/crates/tugcast/src/feeds/changeset.rs` | `ChangesetFeed` (SnapshotFeed) + snapshot composition |
| `tugrust/crates/tugcast/src/scribe.rs` | `ScribeSpawner` trait + `ClaudeScribeSpawner` (`claude -p`), prompt composition |
| `tugrust/crates/tugutil/src/commands/changes.rs` | `tugutil changes` |
| `tugdeck/src/components/tugways/cards/changeset-card.tsx` | The Changeset card + `registerChangesetCard()` |
| `tugdeck/src/lib/changeset-types.ts` | TS mirror of the wire types |
| `tugdeck/src/lib/changeset-verb-store.ts` | commit/summarize round-trip store |
| `tugdeck/src/__tests__/fixtures/changeset-snapshot.golden.json` | Golden contract fixture ([P10]), referenced by both the Rust and bun contract tests |
| `tugrust/crates/tugcast/src/feeds/changeset_all.rs` | M02A aggregate `CHANGESET_ALL` feed: enumerates `WorkspaceRegistry` entries, composes per-project snapshots via `compose_snapshot`, emits `WorkspacesChangesetSnapshot` ([P17]) |
| `tugdeck/src/lib/changeset-all-store.ts` | M02A app-level singleton store for the aggregate snapshot (UsageStore pattern) + context/hook |
| `tugdeck/src/__tests__/fixtures/workspaces-changeset-snapshot.golden.json` | M02A golden contract fixture for the aggregate wire shape (Spec S06) |
| `tugdeck/src/components/tugways/tug-diff-document.tsx` (+`.css`) | M03A document-level diff component over `DiffBlock` ([P18]) |
| `tugrust/crates/tugcast/src/feeds/draft_engine.rs` | M03A maintained-draft engine: snapshot tap, change keys, quiet timers, fingerprint gate, scribe runs, persistence (#draft-engine) |
| `tugdeck/src/lib/changeset-draft-store.ts` | M03A CONTROL overlay store for `changeset_draft_state`/`changeset_draft_delta` (Spec S10) |
| `tugdeck/src/lib/open-diff-in-card.ts` | M03A `OPEN_DIFF` implementation: descriptor-keyed Text-card diff-mode open/reuse ([P20]) |
| `tugdeck/src/components/tugways/tug-message-editor.tsx` (+`.css`) | M03B reusable CM6 message field over `TugTextEditor` (the `text-card-find-bar.tsx` pattern); the commit-composer body ([P26]) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `file_events` table + `record_file_event` / `file_events_for_session` / `file_events_for_project` | sql + fns | `tugcast/src/session_ledger.rs` | Spec S01; cascade trigger idiom from `turns` |
| tool intercept branches | code | `tugcast/src/feeds/agent_bridge.rs` (relay loop `else if` chain) | [P03]–[P06]; pending map + bracket open/close |
| `TUG_SESSION_ID` env | code | `agent_bridge.rs` tugcode spawn (`Command` next to `env_remove` calls) | [P07] |
| `FeedId::CHANGESET = 0x23` | const | `tugcast-core/src/protocol.rs` + `tugdeck/src/protocol.ts` | [P09] |
| `ChangesetSnapshot`, `ChangesetEntry`, `ChangesetFile` | structs | `tugcast-core/src/types.rs` | Spec S02 |
| `ChangesetFeed` wiring | code | `tugcast/src/feeds/workspace_registry.rs` (`WorkspaceEntry::new`, watch channel, `spawn_snapshot_feed`) + `tugcast/src/main.rs` (`add_snapshot_watches`) | beside GitFeed |
| `changeset_commit` / `changeset_summarize` / `changeset_join` | verbs | `tugcast/src/feeds/agent_supervisor.rs` `handle_control` | Spec S03 |
| pathspec on diff query | code | `tugcast/src/main.rs` GIT_DIFF adapter + `feeds/git.rs` `build_git_diff_snapshot` + `tugdeck/src/lib/git-diff-store.ts` | Step 13 |
| `registerGitCard` removal, `newGitCard` → `newChangesetCard` | code | `tugdeck/src/main.tsx`, `tugdeck/src/components/tugways/cards/git-card.tsx` (deleted), `tugapp/Sources/AppDelegate.swift` | [P16] |
| skills cutover | docs | `tugplug/skills/{commit,implement,dash}/SKILL.md`, `tugplug/CLAUDE.md` | Steps 6, 20 |
| `FeedId::CHANGESET_ALL` (~0x24) | const | `tugcast-core/src/protocol.rs` + `tugdeck/src/protocol.ts` | [P17]; confirm the value is free at #step-12a; 0x23 stays reserved |
| `WorkspacesChangesetSnapshot`, `ProjectChangeset` | structs | `tugcast-core/src/types.rs` (+ TS mirror `tugdeck/src/lib/changeset-types.ts`) | Spec S06; reuse the Step-8 entry/file types |
| `WorkspaceRegistry::project_dirs()` (or `entries()`) | fn | `tugcast/src/feeds/workspace_registry.rs` | enumerate open projects for the aggregate feed (#step-12b) |
| global changeset `Notify` + `ChangesetBumper` global ping | code | `tugcast/src/main.rs` + `tugcast/src/feeds/changeset.rs` | process-global bump; sole bump path after #step-12d |
| `changeset_git_init` | verb | `tugcast/src/feeds/agent_supervisor.rs` `handle_control` | Spec S07 |
| per-workspace `ChangesetFeed` retirement | code | `feeds/changeset.rs` (struct + `SnapshotFeed` impl deleted) + `workspace_registry.rs` (`WorkspaceEntry` changeset fields) + `main.rs` (`add_snapshot_watches`) | [P17]/#step-12d; `compose_snapshot` + `ChangesetBumper` stay |
| changeset card rewrite (account-global) | code | `tugdeck/src/components/tugways/cards/changeset-card.tsx` + `tugdeck/src/main.tsx` | #step-12c; per-project sections over the M02 internals |
| `DiffDescriptor` + range-flavor query | code | `tugdeck/src/lib/git-diff-store.ts`, `tugcast/src/main.rs` (`RawDiffQuery`), `tugcast/src/feeds/git.rs` (`fetch_dash_diff`) | Spec S08, [P19], #step-16b |
| `diff-sheet.tsx` rebase onto `TugDiffDocument` | code | `tugdeck/src/components/tugways/cards/diff-sheet.tsx` | [P18], #step-16a |
| `TUG_ACTIONS.OPEN_DIFF` + Text-card diff mode | code | `tugdeck/src/components/tugways/action-vocabulary.ts`, `action-dispatch.ts`, `cards/text-card.tsx` + `text-card-registration.tsx`, `lib/text-card-open-registry.ts` | [P20], #step-16c |
| `changeset_drafts` table + draft ledger API | sql + fns | `tugcast/src/session_ledger.rs` | Spec S09, #step-16d |
| `ScribeSpawner` streaming + draft prompt composers + style-rules loader | code | `tugcast/src/scribe.rs` (+ `resources::source_tree` for the skill file) | [P24], Spec S11, #step-16d |
| `AgentSupervisor::start_draft_engine` + session resolver | code | `tugcast/src/feeds/agent_supervisor.rs`, `tugcast/src/main.rs` (cloned aggregate watch receiver) | #draft-engine, #step-16e |
| `draft` / `unattributed_draft` snapshot fields | structs | `tugcast-core/src/types.rs` + `tugdeck/src/lib/changeset-types.ts` + both golden fixtures | Spec S10, #step-16e |
| `changeset_summarize` deletion (verb, store paths, card buttons) | code | `tugcast/src/feeds/agent_supervisor.rs`, `tugdeck/src/lib/changeset-verb-store.ts`, `cards/changeset-card.tsx` | [P21], #step-16f |
| `BlockHeader` `leading` slot + optional-verb (`toolName?`) form | code | `tugdeck/src/components/tugways/cards/blocks/block-header.tsx` (+`.css`), `block-chrome.tsx` | [P25], #step-16h |
| Monochrome `+N −M` comment fixes | comments | `blocks/tool-result-summary.ts` (`formatDiffSummaryParts` doc), `blocks/block-header.tsx` (DiffSummaryBadges call-site comment), `blocks/edit-tool-block.tsx` ([L20] doc) | [P27], #step-16h |
| `TugMessageEditor` | component | `tugdeck/src/components/tugways/tug-message-editor.tsx` (+`.css`) | [P26], #step-16i |
| `TugDiffDocument` header restyle + monochrome counts | code | `tugdeck/src/components/tugways/tug-diff-document.tsx` (+`.css`; `.tug-diff-document-stat-add/-remove`, `-header`, `-summary`) | [P27], [P29], #step-16j |
| Changeset file blocks (BlockChrome rows) + FileRow/FileDiffButton/InlineFileDiff deletion | code | `tugdeck/src/components/tugways/cards/changeset-card.tsx` (+`.css`; delete `.changeset-file-row`, `.changeset-inline-diff*`) | [P25], [P29], #step-16k |
| Commit composer block + DraftPanel deletion | code | `tugdeck/src/components/tugways/cards/changeset-card.tsx` (+`.css`; delete `DraftPanel`, `.changeset-draft*`, the `TugTextarea`) | [P26], [P28], #step-16l |
| Scribe scoped-subject style rules | code | `tugcast/src/scribe.rs` (`draft_ask`, `BAKED_STYLE_RULES`, the composer test) | [P30], #step-16m |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md`: promote durable decisions (attribution invariant,
      CHANGESET feed scope, tugdash naming) to `[D##]` entries at phase close.
- [ ] `CLAUDE.md`: repository-structure table row for `tugdash`; commit-skill note if its
      contract wording changes.
- [ ] `tugplug/skills/*/SKILL.md` updates are execution-step artifacts (Steps 6, 20), not
      an afterthought.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | ledger upsert idempotency, tool-frame parsing, bracket delta math, porcelain parsing reuse, join preflight intersection logic | core logic |
| **Integration** | relay-loop intercepts against synthetic tugcode stdout (existing agent_bridge test idiom), `tugutil changes` against a temp repo + temp sessions.db, tugdash lifecycle against a scratch git repo | end-to-end within a process |
| **Golden / Contract** | ChangesetSnapshot fixture parsed by Rust + TS ([P10]) | wire format |
| **App-test** | Changeset card renders grouped snapshot in the real app; commit-from-card round trip on a scratch repo | `just app-test`, real Tug.app |

#### What stays out of tests {#test-non-goals}

- jsdom/fake-DOM render tests and mock-store assertions — banned; the card is exercised by
  app-tests against the real app on real content.
- Scribe output *quality* — we test spawn/timeout/error paths with a fake `ScribeSpawner`,
  never assert on model prose; real-claude runs are on-demand only.
- Migration against every historical `.tugtree` shape — covered for the current layout only;
  the fallback path (warn + continue on old path) is the safety net.
- **App-tests for the maintained draft engine (M03A)** — user decision: the trigger loop
  (quiet periods, regeneration timing, streaming fill-in) is human-tested until the design
  settles. Rust covers the engine via the fake `ScribeSpawner`
  (trigger→fingerprint→persist round trips, prompt composition per owner kind, coalescing).
  at0228 stays green by mechanically adapting its diff-click leg to the inline surface —
  it does not grow.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Rust checkpoints run from `tugrust/`
> (`cargo nextest run` — warnings are errors); tugdeck checkpoints require
> `bunx tsc --noEmit` and `bunx vite build`; tugcode requires `bun test` and a binary
> rebuild. Commits are made by the user (or per the autonomous/dash exceptions in
> CLAUDE.md).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | file_events table + ledger API | done | 8cd2c31bf |
| #step-2 | TUG_SESSION_ID env plumbing | done | a68ea0145 |
| #step-3 | Exact attribution intercept + replay backfill | done | 2c406e7a3 |
| #step-4 | Bash fingerprint bracketing | done | 0e529e2b2 |
| #step-5 | tugutil changes | done | 930cb51f1 |
| #step-6 | Commit-skill rewire | done | cef2a9e7b |
| #step-7 | M01 integration checkpoint | done | (verification only) |
| #step-8 | Changeset wire types + golden fixture | done | 9a5a5aa02 |
| #step-9 | ChangesetFeed + bump channel | done | 6567e92be |
| #step-10 | Changeset card (read-only) | done | bb712bf4d |
| #step-11 | Git card + GitFeed retirement | done | 60eadf0a7 |
| #step-12 | M02 integration checkpoint | done | (verification only) |
| #step-12a | Aggregate wire types + golden fixture | done | 40f6395eb |
| #step-12b | Aggregate CHANGESET_ALL feed | done | 2b7d31c9a |
| #step-12c | Account-global changeset card | done | 705a2ae2c |
| #step-12d | Retire the per-workspace feed path | done | bfcc53316 |
| #step-12e | changeset_git_init verb + Init button | done | 05c65450b |
| #step-12f | M02A integration checkpoint | done | 877e79d81 |
| #step-13 | Pathspec diff query | done | 02c225d0a |
| #step-14 | changeset_commit verb + card commit flow | done | d861a0408 |
| #step-15 | Scribe sidecar + summarize verb + card UI | done | 9e324ce50 |
| #step-16 | M03 integration checkpoint | done | (verification only) |
| #step-16a | TugDiffDocument + diff-sheet rebase | done | 731dd1a9d |
| #step-16b | Diff descriptor + dash range diffs | done | 2c11a0135 |
| #step-16c | Inline card diffs + OPEN_DIFF Text-card diff mode | done | 0016dffc9 |
| #step-16d | Drafts ledger + streaming scribe + prompt composers | done | 8b44c5812 |
| #step-16e | The maintained-draft engine | done | 8b44c5812 |
| #step-16f | Card draft UI + Summarize/Draft deletion | done | 47e50ae09 |
| #step-16g | M03A integration checkpoint | done | (verification only) |
| #step-16h | BlockHeader leading slot + optional verb; monochrome badge doctrine | done | `11d0e4a2e` |
| #step-16i | TugMessageEditor — reusable CM6 message field | done | `5f8355277` |
| #step-16j | TugDiffDocument header restyle onto the block grammar | done | `395684239` |
| #step-16k | Changeset file blocks + whole-entry diff rework | done | `1ca4e9ba6` |
| #step-16l | Commit composer block; DraftPanel/TugTextarea retire | done | `41688b11d` |
| #step-16m | Scribe scoped commit-subject style | done | `d5636735a` |
| #step-16n | M03B integration checkpoint | done | N/A (verification) |
| #step-17 | tugdash-core + tugdash CLI extraction | done | `849af2cca` |
| #step-18 | .tug/worktrees home + migration | done | `903e76cc3` |
| #step-19 | Join engine v2 | done | `5e527b8b5` |
| #step-20 | Skill + packaging cutover | done | `42b03f023` |
| #step-21a | Join resolution ladder in tugdash-core | done | (this round) |
| #step-21b | AI file-merge resolver + changeset_join_resolve verb | done | (this round) |
| #step-21c | Card dash UX — Join/Release, preview, resolve overlay, review-confirm | done | (this round) |
| #step-22 | M04 / phase exit checkpoint | done | (this round; docs + verification) |

**Milestone M01: Attribution engine** {#m01-attribution} — steps 1–7.
**Milestone M02: Changeset feed + read-only card** {#m02-card} — steps 8–12.
**Milestone M02A: All-projects aggregate changeset** {#m02a-aggregate} — steps 12a–12f.
**Milestone M03: Card actions** {#m03-actions} — steps 13–16.
**Milestone M03A: The AI-driven Changeset card** {#m03a-ai-card} — steps 16a–16g.
**Milestone M03B: Block-grammar quality pass on the Changeset card** {#m03b-block-grammar} — steps 16h–16n.
**Milestone M04: tugdash** {#m04-tugdash} — steps 17–22.

---

#### Step 1: file_events table + ledger API {#step-1}

**Commit:** `feat(tugcast): file_events table and SessionLedger attribution API`

**References:** [P01] Ownership, [P02] file_events home, [P06] Replay idempotency, Spec S01,
Milestone M01, (#attribution-pipeline, #replay-idempotency)

**Artifacts:**
- `file_events` table, index, cascade trigger in `bootstrap_schema`
  (`tugrust/crates/tugcast/src/session_ledger.rs`), following the `turns` idiom including the
  self-healing column guard.
- Ledger methods: `record_file_event(&FileEventRow)` (upsert, `ON CONFLICT DO NOTHING`),
  `file_events_for_session(tug_session_id)`, `file_events_for_project(project_dir)`
  (joined with `sessions` for owner display fields).

**Tasks:**
- [ ] Add `FileEventRow` struct (fields per Spec S01) and the three methods.
- [ ] Wire the cascade trigger to `sessions` deletion like `turns_cascade_delete_on_session`.

**Tests:**
- [ ] Upsert idempotency: same `(session, tool_use_id, path)` twice → one row.
- [ ] Cascade: deleting a session row removes its events.
- [ ] Schema self-heal: drifted `file_events` table is rebuilt (mirror the existing
      `turn_telemetry` drift test).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 2: TUG_SESSION_ID env plumbing {#step-2}

**Commit:** `feat(tugcast): expose TUG_SESSION_ID to the session subprocess chain`

**References:** [P07] Env self-identification, Milestone M01, (#assumptions)

**Artifacts:**
- `.env("TUG_SESSION_ID", tug_session_id)` on the tugcode spawn in
  `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` (the `Command` that carries the three
  `env_remove` auth-scrub calls).
- Verification that tugcode's `scrubbedEnv` (`tugcode/src/session.ts`) passes it through
  unmodified (it destructures out only the three auth keys — expected no code change; add a
  comment noting the variable is load-bearing for `tugutil changes`).

**Tasks:**
- [ ] Set the env var; keep the comment block that says the scrub list must stay in sync.

**Tests:**
- [ ] tugcast integration test (existing agent_bridge harness): spawned fake-tugcode sees
      `TUG_SESSION_ID` in its environment.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] Manual: in a live Dev-card session, `echo $TUG_SESSION_ID` from a Bash tool call prints
      the session id shown by the Z4B chip.

---

#### Step 3: Exact attribution intercept + replay backfill {#step-3}

**Depends on:** #step-1

**Commit:** `feat(tugcast): attribute Write/Edit/NotebookEdit file events in the relay loop`

**References:** [P03] Intercept point, [P04] Result-gated, [P06] Replay backfill, Spec S01,
Milestone M01, (#attribution-pipeline, #replay-idempotency)

**Artifacts:**
- `tugrust/crates/tugcast/src/feeds/attribution.rs`: `InspectedToolUse` /
  `InspectedToolResult` (serde structs over the `ToolUse`/`ToolResult` line shapes from
  `tugcode/src/types.ts` — `tool_name`, `tool_use_id`, `input.file_path` /
  `input.notebook_path`, `parent_tool_use_id`, `timestamp`, `is_error`), plus a
  `PendingCalls` map type.
- New `else if` branches in the relay loop (`agent_bridge.rs`, beside the `turn_complete` /
  `system_metadata` intercepts): `tool_use` populates the pending map; `tool_result` with
  `is_error:false` resolves it to `record_file_event` rows (`origin='exact'` live,
  `'replay'` when `in_replay`; `at` from `timestamp` when present). The pending map is
  size-capped with oldest-entry eviction and is never cleared on `turn_complete` — a
  background agent's child `tool_use`/`tool_result` pair can straddle a turn boundary
  (subagent-tail re-emission), and clearing would orphan it. All failure paths forward the
  frame unchanged.

**Tasks:**
- [ ] Substring pre-filters (`"\"type\":\"tool_use\""`, `"\"type\":\"tool_result\""`) before
      full parse, matching the documented perf trade of the existing intercepts.
- [ ] Handle `MultiEdit` alongside Write/Edit/NotebookEdit; ignore all other tool names here
      (Bash is Step 4).
- [ ] Store `project_dir` from `ledger_entry` on each row (worktree sessions record their
      worktree root).

**Tests:**
- [ ] Relay integration test (existing fake-tugcode stdout idiom): a
      tool_use(Write)+tool_result(ok) pair yields one row; is_error yields none; frames are
      forwarded byte-identical either way.
- [ ] Replay-bracketed frames with `timestamp` backfill rows with historical `at`; replaying
      twice leaves the count unchanged.
- [ ] Subagent frame (`parent_tool_use_id` set) records the parent id.
- [ ] Straddle: a `tool_use` before a `turn_complete` with its `tool_result` after still
      records (the map survives the turn boundary); eviction test at the size cap.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 4: Bash fingerprint bracketing {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tugcast): bracket Bash tool calls with working-tree fingerprints`

**References:** [P05] Bracketing, Risk R01, Spec S01, Milestone M01, (#bracket-algorithm)

**Artifacts:**
- Bracket registry (`attribution.rs`): `OpenBracket`, per-repo-root vec, owned by
  `AgentSupervisor`, cloned into relays; snapshot helper running
  `git status --porcelain=v2` → `HashMap<PathBuf, FileState>` (reuse/parse via the
  porcelain-v2 machinery in `feeds/git.rs`; gate on its `is_within_git_worktree` walk).
- Relay-loop wiring: Bash `tool_use` opens a bracket (never in replay); successful Bash
  `tool_result` closes it, computes the delta, records rows (`origin='bash'`, `op` from the
  status transition, `ambiguous` per overlap rule); errored result still closes and records
  (a failing command can have mutated files before failing).
- Relay teardown sweeps the session's abandoned brackets.

**Tasks:**
- [ ] Delta classification: created / modified / deleted / renamed from pre/post XY states.
- [ ] Overlap detection across sessions on the same repo root.
- [ ] Feed-bump hook point stubbed (a no-op `Notify` until Step 9).

**Tests:**
- [ ] Unit: delta math over synthetic pre/post maps (create/modify/delete/rename).
- [ ] Integration (temp git repo): fake Bash bracket around an actual file write attributes
      the file; two overlapping brackets mark rows ambiguous; non-repo project dir opens no
      bracket.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 5: tugutil changes {#step-5}

**Depends on:** #step-1, #step-2

**Commit:** `feat(tugutil): changes subcommand — authoritative session file list`

**References:** [P07] Env self-identification, [P08] Query surface, Spec S04, Milestone M01

**Artifacts:**
- `tugrust/crates/tugutil/src/commands/changes.rs` + clap wiring in `tugutil/src/cli.rs`:
  read-only sqlite open of `sessions.db` (path logic mirroring
  `SessionLedger::default_path`, honoring the same env override if one exists), query
  `file_events` by session, join against `git status --porcelain=v2` run in `--project`/cwd,
  print plain paths or `--json` per Spec S04.

**Tasks:**
- [ ] `--session` flag defaulting from `$TUG_SESSION_ID`; exit 2 with a one-line hint when
      absent.
- [ ] Repo-relative path projection; drop rows whose files are no longer dirty (committed or
      reverted) from the default listing; `--all` keeps them.

**Tests:**
- [ ] Integration: temp sessions.db + temp repo → exact expected stdout for plain and
      `--json` forms; plain output omits ambiguous rows and notes the omission on stderr;
      JSON includes them with the flag set.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil`
- [ ] Manual, live session: `tugutil changes` from a Bash tool call lists the files this
      session edited and nothing else.

---

#### Step 6: Commit-skill rewire {#step-6}

**Depends on:** #step-5

**Commit:** `feat(tugplug): commit skill queries tugutil changes for session scope`

**References:** [P08] Query surface, Spec S04, Milestone M01

**Artifacts:**
- `tugplug/skills/commit/SKILL.md`: the "commit ONLY the files you changed in this session"
  section gains the authoritative path — run `tugutil changes --json` (one command, no
  heredoc, no `cd`) as the primary source of the session file list; retain the
  transcript-memory method as fallback when the command is unavailable (old tugcast,
  missing env) and keep the `git status`/`git diff` cross-check. The JSON form is
  mandatory for the skill: plain output silently omits ambiguous rows (Spec S04), and the
  skill must see the `ambiguous` flag to call those files out for judgment rather than
  stage them blindly.

**Tasks:**
- [ ] Update the Context-gathering and Stage-and-Commit sections; preserve the
      `git commit -m … && git --no-pager show --numstat --format= HEAD` receipt contract.

**Tests:**
- [ ] N/A (prose skill; behavior covered by the Step 7 live pass).

**Checkpoint:**
- [ ] Live dogfood: invoke `/tugplug:commit` in a session that edited files via Write AND via
      a Bash `sed`; the commit contains exactly those files.

---

#### Step 7: M01 integration checkpoint {#step-7}

**Depends on:** #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** Milestone M01, (#success-criteria)

**Tasks:**
- [ ] Two concurrent sessions on this repo: session A edits via Write, session B via Bash;
      `tugutil changes` in each lists only its own files; overlap case marks ambiguous.
- [ ] Resume session A; verify backfill idempotency (row counts stable across two resumes).

**Tests:**
- [ ] Full-suite pass.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test`

---

#### Step 8: Changeset wire types + golden fixture {#step-8}

**Depends on:** #step-1

**Commit:** `feat(tugcast-core): ChangesetSnapshot wire types with golden contract fixture`

**References:** [P10] Wire types, Spec S02, Milestone M02, (#snapshot-composition)

**Artifacts:**
- `ChangesetSnapshot` / `ChangesetEntry` / `ChangesetFile` in
  `tugrust/crates/tugcast-core/src/types.rs` (serde snake_case, beside `GitStatus`).
- TS mirror in `tugdeck/src/lib/changeset-types.ts`.
- Golden fixture JSON checked in; Rust test deserializes it; bun test validates the TS type
  guards against it.

**Tasks:**
- [ ] `FeedId::CHANGESET = 0x23` in `tugcast-core/src/protocol.rs` and
      `tugdeck/src/protocol.ts` (name `"changeset"`).

**Tests:**
- [ ] Round-trip serde test (Rust); fixture-validation test (bun).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast-core`
- [ ] `cd tugdeck && bun test changeset && bunx tsc --noEmit`

---

#### Step 9: ChangesetFeed + bump channel {#step-9}

**Depends on:** #step-4, #step-8

**Commit:** `feat(tugcast): workspace ChangesetFeed with event-driven bumps`

**References:** [P09] Feed shape, [P16] Retirement (prep), Spec S02, Milestone M02,
(#snapshot-composition)

**Artifacts:**
- `tugrust/crates/tugcast/src/feeds/changeset.rs`: `ChangesetFeed` as a `SnapshotFeed`
  constructed in `WorkspaceEntry::new` (`workspace_registry.rs`) beside `GitFeed`, spawned
  via `spawn_snapshot_feed`, watch receiver added in `main.rs` `add_snapshot_watches`.
  Composition per #snapshot-composition; splices `workspace_key`; diff-suppressed emission
  like GitFeed.
- Bump channel: a `tokio::sync::Notify` per workspace, resolvable from the attribution code
  by repo root (`WorkspaceRegistry::find_entry_by_path`); the Step-4 stub now fires it. The
  feed selects on {notify, 2s interval, cancel}.
- Feed takes a `SessionLedger` handle (main.rs already owns one) for the event/owner joins,
  and derives dash entries via `git for-each-ref refs/heads/tugdash/` + config reads
  (the same commands `run_dash_list` uses — copied here until Step 17 provides
  tugdash-core to call).

**Tasks:**
- [ ] Owner display-name rule: ledger `name` when `name_user_set`, else id hash (the Z4B
      chip rule).
- [ ] Partition dirty files into owned / ambiguous / unattributed; mark multi-owned files
      `shared: true` in every owning changeset (#snapshot-composition).

**Tests:**
- [ ] Integration (temp repo + temp ledger): snapshot groups a session-owned file, a
      bracketed-ambiguous file, and an untracked hand-edit into the right buckets; a bump
      recomputes without waiting for the poll.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 10: Changeset card (read-only) {#step-10}

**Depends on:** #step-8, #step-9

**Commit:** `feat(tugdeck): changeset card — grouped multi-session view (read-only)`

**References:** [P01] Ownership, [P09] Feed shape, Spec S02, Milestone M02,
(#state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/cards/changeset-card.tsx`: header (branch, ahead/behind,
  HEAD message — the git card's data, restyled), one collapsible section per changeset
  (session sections show display name + live dot; dash sections show base/rounds/worktree
  state), file rows with git-status glyph + op/origin provenance, ambiguous and shared
  badges, unattributed section, clean-tree empty state. `registerChangesetCard()` with
  `componentId: "changeset"`, `defaultFeedIds: [FeedId.CHANGESET]`, registered from
  `tugdeck/src/main.tsx`.

**Tasks:**
- [ ] Data via `useCardData<ChangesetSnapshot>()` (the git-card idiom — already
      `useSyncExternalStore`-backed).
- [ ] Compose Tug* components for chrome (no hand-rolled lookalikes); read-only rows carry
      no tabindex; appearance states in CSS only.
- [ ] Section expand/collapse as `useState`.

**Tests:**
- [ ] App-test: drive the real app against seeded state (scratch-repo dirt + pre-populated
      `file_events` rows in the ledger); assert the card renders the expected grouped
      sections, badges, and unattributed bucket (screenshot + DOM assertions per app-test
      conventions). Do NOT drive a real Claude session here — real-claude tests are
      on-demand only; the event-driven bump path is covered by Step 9's Rust integration
      test, and live-session behavior is Step 12's manual checkpoint.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test`

---

#### Step 11: Git card + GitFeed retirement {#step-11}

**Depends on:** #step-10

**Commit:** `feat(tugdeck,tugcast,tugapp): retire the git card; changeset card replaces it`

**References:** [P16] Retirement, Milestone M02

**Artifacts:**
- Delete `tugdeck/src/components/tugways/cards/git-card.tsx` and its `registerGitCard()`
  call in `main.tsx`; remove `GitFeed` construction from `WorkspaceEntry::new` and its
  watch from `main.rs` (keep `parse_porcelain_v2`/diff machinery — ChangesetFeed and
  GIT_DIFF use them); retire FeedId 0x20 registration (constant stays, commented reserved).
- `tugapp/Sources/AppDelegate.swift`: `newGitCard` (⇧⌘N, "New Git Card") becomes
  "New Changeset Card" sending `show-card` with `component: "changeset"`.

**Tasks:**
- [ ] Sweep for `FeedId.GIT` consumers on the deck side; confirm only the git card
      subscribed.

**Tests:**
- [ ] Existing git.rs parser tests keep passing (parser stays).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` ; `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] Build Tug.app; menu item opens the changeset card.

---

#### Step 12: M02 integration checkpoint {#step-12}

**Depends on:** #step-10, #step-11

**Commit:** `N/A (verification only)`

**References:** Milestone M02, (#success-criteria)

**Tasks:**
- [ ] Live: two sessions editing this repo; card shows both groups; a Write lands in the
      card within ~1s (bump path); a hand edit appears as unattributed within the poll
      interval.

**Tests:**
- [ ] Full-suite pass.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` ; `just app-test` ; `cd tugdeck && bunx vite build`

---

#### Step 12a: Aggregate wire types + golden fixture {#step-12a}

**Depends on:** #step-8

**Commit:** `feat(tugcast-core): WorkspacesChangesetSnapshot aggregate wire types with golden fixture`

**References:** [P10] Wire types, [P17] Aggregate feed, Spec S06, Milestone M02A

**Artifacts:**
- `WorkspacesChangesetSnapshot` / `ProjectChangeset` in
  `tugrust/crates/tugcast-core/src/types.rs` (serde snake_case, beside the Step-8
  `ChangesetSnapshot` types). `ProjectChangeset` carries
  `project_dir`/`display_name`/`workspace_key`/`no_repo` plus the Spec S02 payload — **reuse**
  `ChangesetEntry`/`ChangesetFile`/`UnattributedFile`, never duplicate them.
- TS mirror + type guards in `tugdeck/src/lib/changeset-types.ts` beside the Step-8 mirrors.
- Golden fixture `tugdeck/src/__tests__/fixtures/workspaces-changeset-snapshot.golden.json`
  containing at least two projects — one repo project with session + dash entries and
  unattributed files, one `no_repo: true` project — deserialized by a Rust test (beside the
  Step-8 fixture test) and validated by a bun test
  (`tugdeck/src/__tests__/changeset-types.test.ts`).

**Tasks:**
- [ ] `FeedId::CHANGESET_ALL` in `tugcast-core/src/protocol.rs` and `tugdeck/src/protocol.ts`
      (name `"changeset_all"`); propose `0x24` — confirm the value is free on **both** sides
      before claiming it.
- [ ] Decide flatten-vs-embed for the S02 fields inside `ProjectChangeset` and mirror the
      choice exactly in TS — the golden fixture pins whichever shape ships.

**Tests:**
- [ ] Rust round-trip serde test over the fixture; bun fixture-validation test over the same
      file (drift fails either side, per [P10]).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast-core`
- [ ] `cd tugdeck && bun test changeset && bunx tsc --noEmit`

---

#### Step 12b: Aggregate CHANGESET_ALL feed {#step-12b}

**Depends on:** #step-12a, #step-9

**Commit:** `feat(tugcast): process-level CHANGESET_ALL feed aggregating all open projects`

**References:** [P17] Aggregate feed, Spec S06, Milestone M02A, (#aggregate-delivery,
#snapshot-composition)

**Artifacts:**
- `tugrust/crates/tugcast/src/feeds/changeset_all.rs`: one **process-level** feed holding
  `Arc<WorkspaceRegistry>` + `Arc<SessionLedger>` (main.rs already owns the ledger Arc). On
  recompute: enumerate the registry's current entries via a new
  `WorkspaceRegistry::project_dirs()` (or `entries()`) accessor over its `inner` map
  (`find_entry_by_path` is the existing sibling); for each `project_dir`, gate with the
  subprocess-free `is_within_git_worktree` — a repo dir goes through the existing
  `compose_snapshot` (`feeds/changeset.rs`), a non-repo dir yields a `no_repo: true`
  `ProjectChangeset` with empty payload; emit **one** `WorkspacesChangesetSnapshot` frame,
  diff-suppressed like the other snapshot feeds.
- **Process-level delivery** per #aggregate-delivery: the feed runs via `spawn_snapshot_feed`
  yielding a single `watch::Receiver` pushed into `add_snapshot_watches` once at `main.rs`
  startup (the `spawn_stats_feeds`/`defaults_feed` template — the registry Arc is constructed
  well before the registration point, so ordering works). **Not** the USAGE broadcast
  pattern (no deliver-on-connect — a freshly opened deck would render blank until the next
  bump or poll), and **never** a per-workspace registration.
- **Global bump:** a process-global `Arc<tokio::sync::Notify>` created in `main.rs`, handed
  to the feed and to `ChangesetBumper` (`feeds/changeset.rs`) — `bump()` pings it **in
  addition to** the per-workspace `Notify` (removed later at #step-12d). The feed
  `select!`s on { global notify, poll interval (backstop for hand edits), cancel }.

**Tasks:**
- [ ] `display_name` = basename of `project_dir`.
- [ ] Bumps coalesce (Notify semantics) so a burst of file events yields one recompute.
- [ ] Ping the global `Notify` from `WorkspaceRegistry::get_or_create` and `release` so a
      project's section appears/disappears immediately when a dev card opens/closes, instead
      of waiting out the poll backstop (hand the global notify to the registry at
      construction).

**Tests:**
- [ ] Integration (two temp dirs: one git repo with attributed dirt via temp ledger rows, one
      non-repo dir): the snapshot carries two `projects` elements with correct `no_repo`
      flags and correct owner grouping in the repo element; a global bump recomputes without
      waiting for the poll.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 12c: Account-global changeset card {#step-12c}

**Depends on:** #step-12a, #step-12b

**Commit:** `feat(tugdeck): account-global changeset card — every open project in one view`

**References:** [P17] Aggregate feed, Spec S06, Milestone M02A, (#state-zone-mapping,
#aggregate-delivery)

**Artifacts:**
- `tugdeck/src/lib/changeset-all-store.ts`: app-level singleton store on the **UsageStore
  pattern** — `new FeedStore(conn, [FeedId.CHANGESET_ALL])` with **no workspace filter** —
  plus a context/hook exposed via `useSyncExternalStore` (the `useUsage`/`usePulse` idiom).
  Must **NOT** go through `useCardData` → `useCardWorkspaceKey`: `FeedStore` holds one value
  per feed id, and the aggregate frame is account-global by construction.
- `tugdeck/src/components/tugways/cards/changeset-card.tsx` rewritten account-global: one
  collapsible section per project (display name + branch/ahead-behind + HEAD subject
  header), each containing the existing M02 internals — owner sections, file rows,
  status glyphs, ambiguous/shared badges, live dots, `FilePathLink` clickable links — with
  each project's own `project_dir` as the absolute-path link base (replacing the M02 card's
  single `snapshot.workspace_key` base). Deleted files stay inert.
- Non-repo section state: "Not a git repository" + an **"Initialize git"** button, rendered
  but inert until #step-12e wires the verb. Empty states: "No open projects" overall;
  per-project clean-tree state as in M02.
- Registration from `tugdeck/src/main.tsx`: the card registration's `defaultFeedIds` becomes
  `[FeedId.CHANGESET_ALL]`. The store initializes where the app-level singletons live:
  either on the deck manager beside `UsageStore` (`tugdeck/src/deck-manager.ts`,
  `new UsageStore(connection)`) or as a module-level singleton + hook the way `PulseStore`
  does (`pulse-store.ts` `_activeStore` + `usePulse`) — pick whichever the context-hook
  shape favors; both are established app-level homes.

**Tasks:**
- [ ] Section expand/collapse stays ephemeral UI state (the M02 controlled-`TugAccordion` /
      `useResponderForm` approach carries over).
- [ ] Compose Tug* components; read-only rows keep no tabindex; the Init button reserves its
      busy-state width (width-stabilize).

**Tests:**
- [ ] App-test (extend `tests/app-test/at0227-changeset-card.test.ts` or a new at02xx):
      seeded scratch repo + ledger rows → the aggregate card shows that project's section
      with grouped owners; clicking a present file opens a Text card. (Two-project +
      non-repo coverage is #step-12f; `just app-test-build` first — Rust changed.)

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test`

---

#### Step 12d: Retire the per-workspace feed path {#step-12d}

**Depends on:** #step-12c

**Commit:** `feat(tugcast): retire the per-workspace changeset feed path`

**References:** [P17] Aggregate feed (supersedes [P09] delivery), Milestone M02A,
(#aggregate-delivery)

**Artifacts:**
- Remove the per-workspace `ChangesetFeed` construction from `WorkspaceEntry::new`
  (`tugcast/src/feeds/workspace_registry.rs`), the changeset watch receiver from
  `add_snapshot_watches` in `main.rs`, and the per-workspace `Notify` resolution inside
  `ChangesetBumper` (`feeds/changeset.rs`) — the #step-12b global bump becomes the only
  bump path.
- **Delete the dead code outright — warnings are errors**, so anything left without a
  non-test consumer fails the build: the `ChangesetFeed` struct and its `SnapshotFeed` impl
  in `feeds/changeset.rs`, its feed-loop tests (the ones exercising bump/poll emission
  through the struct), and the `WorkspaceEntry` fields `changeset_watch_rx` /
  `changeset_bump` / `changeset_task` with their construction and teardown.
- **Keep** `compose_snapshot` and its tests, and `ChangesetBumper` with its global-notify
  path (`feeds/changeset.rs`) — the aggregate's per-project building block and bump entry
  point.
- `FeedId::CHANGESET` (0x23) stops being registered; the constant stays, commented reserved
  (the same idiom as GIT 0x20 at #step-11). Never reuse the value.

**Tasks:**
- [ ] Sweep tugdeck for `FeedId.CHANGESET` consumers — after #step-12c the card no longer
      subscribes; remove any leftover references.
- [ ] Confirm the workspace-registry tests that assert on the changeset task/watch fields
      are removed or retargeted at the surviving fields.

**Tests:**
- [ ] Existing `compose_snapshot` tests keep passing; no test references the removed feed
      wiring.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` ; `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 12e: changeset_git_init verb + Init button {#step-12e}

**Depends on:** #step-12c

**Commit:** `feat(tugcast,tugdeck): initialize git from the changeset card`

**References:** [P17] Aggregate feed, Spec S07, Milestone M02A, (#state-zone-mapping)

**Artifacts:**
- `changeset_git_init` in `AgentSupervisor::handle_control` per Spec S07: validates
  `project_dir` matches a current `WorkspaceRegistry` entry and is not already inside a git
  worktree (`is_within_git_worktree`), runs `git init -b main` in `project_dir`, replies
  ok / err-with-stderr-detail; fires the global aggregate bump on success so the section
  self-heals on the next recompute.
- Card wiring: the Init button (inert since #step-12c) dispatches the verb through a small
  round-trip store (`useSyncExternalStore`; if `changeset-verb-store.ts` — planned at
  #step-14 — does not exist yet, create it here carrying just this verb and let Step 14
  extend it), shows in-flight state on the width-stabilized button, surfaces errors via
  `TugAlert`. No client-side section flip: the recompute is the state transition.

**Tasks:**
- [ ] tugcode inbound allowlist if the verb rides a new client→tugcode message type
      (`tugcode/src/types.ts`: union + guard + `isInboundMessage`); if it rides the existing
      CONTROL request path like `changeset_commit` will, no tugcode change.

**Tests:**
- [ ] Rust integration: the verb inits a temp non-repo dir (branch `main`); refuses an
      already-repo dir and a dir that is not a registry entry; the error path returns
      stderr detail.
- [ ] App-test click-through coverage folds into #step-12f.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` ; `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 12f: M02A integration checkpoint {#step-12f}

**Depends on:** #step-12c, #step-12d, #step-12e

**Commit:** `N/A (verification only)`

**References:** Milestone M02A, (#success-criteria)

**Tasks:**
- [ ] App-test (after `just app-test-build` — Rust and Swift-adjacent artifacts changed):
      open two dev cards on two scratch dirs — one `git init`ed with seeded dirt + ledger
      rows, one non-repo. The aggregate card shows both project sections; the non-repo
      section shows the Init affordance, and clicking it flips the section to a repo state
      on the next recompute; clicking a present file opens a Text card.
- [ ] Live: with two projects open, a Write in either project lands in its section within
      ~1s (global bump); closing a project's last dev card drops its section; the bootstrap
      project is always present.

**Tests:**
- [ ] Full-suite pass.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test`

---

#### Step 13: Pathspec diff query {#step-13}

**Depends on:** #step-10

**Commit:** `feat(tugcast,tugdeck): pathspec-scoped git diff query for the changeset card`

**References:** [P16] Retirement (GIT_DIFF survives), Spec S02, Milestone M03

**Artifacts:**
- `GIT_DIFF_QUERY` (0x22) payload gains optional `paths: [repo-relative…]` (and
  `project_dir` where the adapter needs disambiguation); the adapter in
  `tugcast/src/main.rs` and `build_git_diff_snapshot` (`feeds/git.rs`) pass
  `-- <paths…>` through to `git diff HEAD`. Absent `paths` preserves today's whole-tree
  behavior (dev card `/diff` unchanged).
- `tugdeck/src/lib/git-diff-store.ts` extended for scoped requests; changeset card rows get
  a diff affordance opening the same sheet component the dev card uses, scoped to the
  file/changeset.

**Tasks:**
- [ ] Request/response correlation for concurrent scoped queries (include an echo token if
      the current store assumes one outstanding query).

**Tests:**
- [ ] Rust: scoped snapshot contains only requested paths.
- [ ] App-test: clicking a file row opens its diff.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` ; `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test`

---

#### Step 14: changeset_commit verb + card commit flow {#step-14}

**Depends on:** #step-10

**Commit:** `feat(tugcast,tugdeck): commit a changeset from the card`

**References:** [P15] Card commit, Spec S03, Milestone M03, (#state-zone-mapping)

**Artifacts:**
- `changeset_commit` in `AgentSupervisor::handle_control` per Spec S03: validates non-empty
  files, runs `git add -- <files…>` + `git commit -m` in `project_dir`, replies ok with
  `{sha, receipt}` (numstat) or err with stderr detail; fires the workspace bump so the card
  refreshes instantly.
- `tugdeck/src/lib/changeset-verb-store.ts` (round-trip store, `useSyncExternalStore`);
  card UI: per-changeset file checkboxes (default: all non-ambiguous selected), message
  field, commit button (width-stabilized against its busy state), receipt rendering,
  error surface via TugAlert.

**Tasks:**
- [ ] Ambiguous and shared rows excluded from default selection with the badge explaining
      why ([P15], #snapshot-composition).
- [ ] Selection state reconciles when a snapshot removes files (committed elsewhere).
- [ ] The commit-message input is an editing surface: register the substrate responders
      (CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO) via the standard responder hook
      (registration in `useLayoutEffect` per [L03]), or compose an existing Tug input
      component that already carries them — otherwise Cmd-A/C/X/V/Z go dead under the
      capture-phase preventDefault above the card.

**Tests:**
- [ ] Rust integration: verb commits exactly the listed files in a temp repo; refuses empty
      list; error path returns stderr.
- [ ] App-test: end-to-end card commit on a scratch repo; receipt shows the numstat.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` ; `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test`

---

#### Step 15: Scribe sidecar + summarize verb + card UI {#step-15}

**Depends on:** #step-14

**Commit:** `feat(tugcast,tugdeck): headless scribe generates summaries and commit messages`

**References:** [P11] Scribe, [Q02] Scribe model, Spec S03, Milestone M03

**Artifacts:**
- `tugrust/crates/tugcast/src/scribe.rs`: `ScribeSpawner` trait + `ClaudeScribeSpawner`
  running `claude -p --output-format text --model <model>` (model from tugbank default
  `dev.tugtool.changeset`/`scribe_model`, fallback `haiku`), env-scrubbed like the tugcode
  spawn, 60s timeout. Prompt composition: scoped diff (Step 13 plumbing) + last N user
  prompts for the owner session(s) from the `turns` table + dash-log lines for dashes.
- `changeset_summarize` verb per Spec S03; card UI: "Summarize" and "Draft message" actions
  per changeset — the drafted message lands in the Step-14 message field, in-flight state on
  the verb store.

**Tasks:**
- [ ] Fake-spawner tests for timeout/error/success; never assert model prose.
- [ ] Scribe stderr → TugDevPanel log (`tugDevLogStore`), not console.

**Tests:**
- [ ] Rust: verb round trip with fake spawner; prompt composer includes diff + prompts +
      dash-log for each owner kind.
- [ ] On-demand real-claude smoke (not in the default suite, per app-test policy).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` ; `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] Manual: draft a commit message from the card on a real diff.

---

#### Step 16: M03 integration checkpoint {#step-16}

**Depends on:** #step-13, #step-14, #step-15

**Commit:** `N/A (verification only)`

**References:** Milestone M03, (#success-criteria)

**Tasks:**
- [ ] Full card loop live: see change → open diff → draft message → commit → receipt →
      groups update; other session's files untouched.

**Tests:**
- [ ] Full-suite pass.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` ; `just app-test` ; `cd tugdeck && bunx vite build`

---

#### Step 16a: TugDiffDocument + diff-sheet rebase {#step-16a}

**Depends on:** #step-16

**Commit:** `feat(tugdeck): TugDiffDocument — the shared document-level diff surface`

**References:** [P18] TugDiffDocument, Milestone M03A, (#state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-diff-document.tsx` + `.css`: props take a parsed
  `GitDiffPayload` (from `lib/git-diff-store.ts`) plus optional `cardId` (view-mode
  persistence via `diff-view-pref.ts`) and optional per-file trailing-affordance render
  hook (the card's pop-out button rides here in #step-16c). Renders: summary header
  (`N files changed +X −Y`, the `diffSummaryLine` helper), Expand All / Collapse All, a
  host-level inline ↔ side-by-side toggle driving each `DiffBlock`'s `viewMode`, and one
  `TugAccordionItem` per file — trigger = status letter + path (rename `old → new`) +
  `+N −M` stat, body = `DiffBlock` with `suppressHeader` (binary files render the
  no-textual-diff note). This is a **move**, not a rewrite: `FileTrigger`, `FileBody`,
  the controlled accordion + `useResponderForm({toggleSectionMulti})` wiring, and the
  expand/collapse-all logic migrate out of `diff-sheet.tsx`.
- `tugdeck/src/components/tugways/cards/diff-sheet.tsx` rebased: keeps `useDiffSheet`
  (request-then-branch alert logic), `TugSheetScaffold` chrome, Refresh, and Done; the
  files region becomes `<TugDiffDocument …/>`. Existing `data-testid`s
  (`diff-file`, `diff-expand-all`, `diff-collapse-all`, `diff-refresh`, `diff-done`) move
  with their elements so existing app-tests keep passing unchanged.

**Tasks:**
- [ ] Component doctrine: compose `TugAccordion`/`TugPushButton`/`TugChoiceGroup` (the
      view toggle mirrors DiffBlock's own segmented control); no borrowed CSS classes;
      file pair + `data-slot` per [L19]-style conventions.
- [ ] The view-mode toggle without `cardId` stays ephemeral `useState` (the DiffBlock
      local-fallback rule).

**Tests:**
- [ ] Existing bun tests for the git-diff-store helpers keep passing; no jsdom render
      tests (banned).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test` (the curated sweep covers the dev card's `/diff` sheet)

---

#### Step 16b: Diff descriptor + dash range diffs {#step-16b}

**Depends on:** #step-16a

**Commit:** `feat(tugcast,tugdeck): two-flavor diff descriptor — dash entries get real diffs`

**References:** [P19] Diff descriptor, Spec S08, Milestone M03A,
(#diff-descriptor-resolution)

**Artifacts:**
- `tugcast/src/main.rs` `RawDiffQuery` gains optional `worktree`/`base`/`branch`; a present
  `branch` routes to the range flavor. `tugcast/src/feeds/git.rs` gains
  `fetch_dash_diff(repo_root, worktree, base, branch)` implementing
  #diff-descriptor-resolution (merge-base then `git -C <worktree> diff <MB>`; no-worktree
  fallback `git diff <base>...<branch>` in the repo root) and a
  `build_git_diff_snapshot` path (or sibling fn) that reuses `parse_git_diff` and sets the
  payload `base` field to `<base>...<branch>`.
- `tugdeck/src/lib/git-diff-store.ts`: `DiffDescriptor` union per Spec S08;
  `requestDiff(descriptor)` serializes the new fields; the legacy `{root, paths}` scope
  form maps to the head flavor so the dev card's `/diff` call sites compile unchanged.
  Export `diffDescriptorKey(descriptor)` (the Spec S08 identity key) for #step-16c reuse.

**Tasks:**
- [ ] Range flavor resolves `worktree` relative paths against the workspace's repo root
      (dash snapshot entries carry `worktree` as a repo-relative path like
      `.tugtree/tugdash__demo`).
- [ ] Keep the whole-tree head flavor byte-identical for an absent `paths` (dev card
      regression guard).

**Tests:**
- [ ] Rust integration (temp repo, the `init_repo` idiom in `feeds/changeset.rs` tests):
      a dash branch with one committed round + worktree dirt yields a range snapshot
      containing BOTH the round's file and the dirty file; the no-worktree fallback yields
      the round's file only; upstream drift on `base` stays out (merge-base semantics).
- [ ] bun: descriptor serialization + `diffDescriptorKey` unit tests.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` ; `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 16c: Inline card diffs + OPEN_DIFF Text-card diff mode {#step-16c}

**Depends on:** #step-16a, #step-16b

**Commit:** `feat(tugdeck): inline changeset diffs; OPEN_DIFF opens a Text card in diff mode`

**References:** [P20] Inline diff, Spec S08, Milestone M03A, (#state-zone-mapping)

**As built (deviation from [P20]):** the pop-out target is a **dedicated Diff card**
(`componentId: "diff"`, `cards/diff-card.tsx` + `.css`, registered in `main.tsx`), NOT a
"Text card in diff mode" — overloading the CM6 Text card's editor/focus/save engine with a
non-editor body would fight React's hook rules and the editor lifecycle. The Diff card owns
its own standalone `GitDiffStore` (`createGitDiffStore`), reads the descriptor via the card
initial-content channel (`useCardStatePreservation`), and renders `TugDiffDocument` with
Refresh. Descriptor-keyed reuse lives in a dedicated `lib/diff-card-open-registry.ts`
(`findDiffCardByKey`) consumed by `lib/open-diff-in-card.ts`; user-facing behavior (pop-out
+ reuse) is exactly as [P20] specifies.

**Artifacts:**
- Changeset card (`cards/changeset-card.tsx`): a per-entry `GitDiffStore` — rework
  `changeset-diff-store.ts` from a single-`GitDiffStore` singleton into a module that
  keeps ONE unfiltered `FeedStore(conn, [FeedId.GIT_DIFF])` and hands out per-entry
  `GitDiffStore` instances keyed by entry id (`getEntryDiffStore(entryId)` +
  `releaseEntryDiffStore(entryId)`); created lazily on first expand, request fired with
  the entry's descriptor — head flavor with the entry's diffable paths for
  sessions/unattributed, range flavor for dashes. The per-file
  diff button (`data-testid="changeset-file-diff"`) now toggles that file's `DiffBlock`
  inline under its row (rendered from the entry payload's matching file); the entry-level
  action toggles a full `TugDiffDocument` inline in the entry body. Dash entries gain both
  affordances (the M03 "no diff for dashes" carve-out is deleted); untracked files keep
  none on head-flavor entries (`hasHeadDiff` stays). The card stops importing
  `useDiffSheet`; `useTugSheet` remains for alerts.
- `TUG_ACTIONS.OPEN_DIFF` in `action-vocabulary.ts`; handler in `action-dispatch.ts`
  (payload = a `DiffDescriptor`); `tugdeck/src/lib/open-diff-in-card.ts` mirrors
  `open-file-in-card.ts`: descriptor-keyed reuse via a `text-card-open-registry.ts`
  extension (`findTextCardByDiffKey(diffDescriptorKey(d))`), else a new Text card seeded
  through the initial-content channel with the descriptor.
- Text card diff mode: when the initial content carries a `diffDescriptor`, the card
  (`cards/text-card.tsx` / `text-card-registration.tsx`) renders `TugDiffDocument`
  standalone — its own `GitDiffStore`, a Refresh button, title `Diff — <basename or dash
  name>` — instead of mounting the editor. No editor substrate responders are needed in
  this mode (read-only surface, no tabindex on rows).
- Pop-out affordances: the inline per-file expansion and the entry-level document each
  carry an "open as card" button dispatching `OPEN_DIFF` (per-file → head descriptor with
  the single path; entry-level → the entry's full descriptor).
- at0228 (`tests/app-test/at0228-changeset-aggregate.test.ts`): the diff leg adapts
  mechanically — click `changeset-file-diff`, assert the inline `DiffBlock` under the row
  contains `at0228-diff-marker-2e7b` (the sheet assertions are removed). No new legs.

**Tasks:**
- [ ] Inline expansion state is `useState` in the entry body; collapse on snapshot removal
      of the file reconciles by construction (render only rows present in the snapshot).
- [ ] Dispose per-entry stores when their entries leave the snapshot (module map sweep).
- [ ] Pop-out buttons carry `data-tug-focus="refuse"` + mousedown preventDefault like
      `FilePathLink` (the card must not steal first responder).

**Tests:**
- [ ] App-test: adapted at0228 diff leg (after `just app-test-build` — Rust changed in
      #step-16b).
- [ ] bun: `open-diff-in-card` reuse-key logic (the `open-file-in-card.reuse.test.ts`
      idiom).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0228-changeset-aggregate.test.ts` then the curated sweep

---

#### Step 16d: Drafts ledger + streaming scribe + prompt composers {#step-16d}

**Depends on:** #step-16

**Commit:** `feat(tugcast): draft persistence, streaming scribe, per-owner prompt composition`

**References:** [P22] Fingerprint, [P23] Dash draft, [P24] Streaming, Spec S09, Spec S11,
Milestone M03A, (#draft-engine)

**Artifacts:**
- `changeset_drafts` table + `ChangesetDraftRow` + the three ledger methods per Spec S09
  in `tugcast/src/session_ledger.rs` (self-healing guard included).
- `tugcast/src/scribe.rs`: `ScribeSpawner::run` gains an optional delta channel
  (`Option<tokio::sync::mpsc::UnboundedSender<String>>` carrying the accumulated text);
  `ClaudeScribeSpawner` switches to `claude -p --output-format stream-json
  --include-partial-messages --verbose --model <m>` (prompt still over stdin, env still
  scrubbed via `claude_command`, `kill_on_drop` kept), parsing `stream_event` text deltas
  for the channel and the terminal `{"type":"result","result":…}` line as the canonical
  full text; timeout raised to 120s (sonnet on a large diff). The existing fake-spawner
  tests extend to scripted deltas.
- Prompt composition per Spec S11: `compose_draft_prompt_session/dash/unattributed` pure
  fns; `commit_style_rules()` reading
  `resources::source_tree().join("tugplug/skills/commit/SKILL.md")` and extracting the
  message-format sections (markers per #draft-engine) with the baked-in const fallback;
  `session_prompts_since(...)` reading the session JSONL via
  `claude_projects_root`/`encode_claude_project_name` and the `external_sessions.rs`
  classifiers (`user_submission_opens_turn` is already `pub(crate)`; promote
  `submission_text` and `parse_timestamp_millis` from private to `pub(crate)`); fingerprint
  helpers (`fingerprint_head_entry`, `fingerprint_dash_entry`).
- `main.rs`: the scribe-model closure fallback flips `"haiku"` → `"sonnet"` ([P22]).

**Tasks:**
- [ ] `ScribeKind` slims to the commit-message ask only if the summary variant loses its
      last consumer here; otherwise it goes with #step-16f (warnings-are-errors decides —
      never leave a dead variant).
- [ ] Diff/prompt truncation caps per Spec S11.

**Tests:**
- [ ] Ledger: upsert/read round trip; drifted-table self-heal (the `file_events` drift-test
      idiom).
- [ ] Scribe: streaming fake emits deltas then the final text; timeout/error paths; the
      composer tests pin per-owner-kind prompt structure (style rules present, prompts
      section only for sessions, dash-log lines only for dashes) without asserting prose.
- [ ] JSONL prompt extraction over a temp fixture (the `tui_shaped_jsonl` idiom in
      `external_sessions.rs` tests): submissions in, tool-results/interrupts out,
      `since_ms` filter honored.
- [ ] Fingerprint: same tree twice → equal; touch an untracked file's content → differs;
      dash commit → differs.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 16e: The maintained-draft engine {#step-16e}

**Depends on:** #step-16d

**Commit:** `feat(tugcast): the maintained-draft engine — drafts ride the aggregate snapshot`

**References:** [P21] Maintained draft, [P22] Fingerprint, Spec S09, Spec S10, Spec S11,
Milestone M03A, (#draft-engine)

**Artifacts:**
- `tugcast/src/feeds/draft_engine.rs` implementing #draft-engine end to end: cloned
  aggregate `watch::Receiver<Frame>` tap (never the bump `Notify`), per-entry change keys
  (draft fields excluded), ~10s quiet timers (a `Duration` field so tests shrink it),
  fingerprint gate, in-flight cancel/coalesce (task abort per entry key), streaming runs
  broadcasting `changeset_draft_state` / `changeset_draft_delta` on `control_tx`
  (Spec S10), persist-if-still-current, global bump on persist, error posture per
  #draft-engine (stale draft survives, `tracing::warn`).
- `AgentSupervisor::start_draft_engine(watch_rx)` (the `set_scribe` idiom) handing the
  engine `control_tx`, `session_ledger`, `registry`, the `ScribeContext`, and the
  `tug_session_id → claude_session_id` resolver over the supervisor's in-memory entries;
  `main.rs` wires it right after the CHANGESET_ALL `spawn_snapshot_feed` call (clone the
  receiver before pushing it into `add_snapshot_watches`).
- Snapshot draft fields per Spec S10: `draft` on `ChangesetEntry::Session`/`::Dash`,
  `unattributed_draft` on `ProjectChangeset` (`tugcast-core/src/types.rs`,
  `#[serde(skip_serializing_if = "Option::is_none")]`); `compose_snapshot` /
  `compose_aggregate` attach them via `changeset_drafts_for_project`, only on eligible
  entries; TS mirror + both golden fixtures updated (add a drafted session entry and a
  drafted dash to the aggregate fixture).

**Tasks:**
- [ ] Eligibility rule per #draft-engine (sessions/unattributed ≥1 file; dash rounds > 0 or
      dirty worktree).
- [ ] Delta broadcast throttled to ~4/s, always the accumulated text.
- [ ] Engine ignores snapshot frames older than its last-processed (watch semantics make
      this automatic — document it).

**Tests:**
- [ ] Rust integration (temp repo + in-memory ledger + fake streaming spawner + a hand-fed
      watch channel, short quiet period): change → quiet → exactly one run → row persisted
      → a second identical snapshot triggers NO second run (fingerprint gate); a change
      mid-run aborts and re-runs (coalescing — the fake spawner blocks on a signal);
      committing the changeset's files (shrinking it) produces a new fingerprint and a
      fresh draft; dash entry composes the dash prompt (log + rounds), session entry the
      session prompt.
- [ ] `compose_snapshot` attaches persisted drafts only to eligible entries; fixture
      round-trip tests updated on both sides ([P10]).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugcast-core`
- [ ] `cd tugdeck && bun test changeset && bunx tsc --noEmit`

---

#### Step 16f: Card draft UI + Summarize/Draft deletion {#step-16f}

**Depends on:** #step-16c, #step-16e

**Commit:** `feat(tugdeck,tugcast): the maintained draft on the card; Summarize and Draft retire`

**References:** [P21] Maintained draft, [P24] Streaming/pinning, Spec S10, Milestone M03A,
(#state-zone-mapping)

**Artifacts:**
- `tugdeck/src/lib/changeset-draft-store.ts`: app-level singleton on the
  `changeset-verb-store.ts` pattern (CONTROL frame listener, `attach…` at boot,
  `useSyncExternalStore` hook) overlaying `changeset_draft_state`/`changeset_draft_delta`
  keyed `(project_dir, owner_kind, owner_id)`; a snapshot draft with newer `updated_at`
  clears the overlay.
- Entry body draft panel (`cards/changeset-card.tsx` + `.css`), above the commit controls:
  a Bot-avatar row (the `side-question-overlay.tsx` mini-transcript styling — `Bot` icon,
  `TugMarkdownBlock` for the rendered draft, `TugProgressIndicator` wave while the overlay
  reads `drafting`, `BlockCopyButton`), a subtle "updating…" freshness treatment via
  `data-state` + CSS ([L06]), and an error hint when the overlay reads `error` (stale
  draft stays rendered). Below it, the commit message field becomes a **`TugTextarea`**
  (substrate responders come with the component) pre-filled from the draft, with the
  pristine/pinned rule and "Use latest draft" affordance per [P24]; Commit sends the
  field. Clean fileless entries keep "No changes from this session"; a dash with rounds
  shows its join-message draft (dash entries render the draft panel read-only — no commit
  controls; committing a dash is M04's join).
- **Deletions:** the Summarize button, the Draft button, and the summary info-sheet path in
  `changeset-card.tsx`; `useChangesetSummarize` + summarize state/inflight maps in
  `changeset-verb-store.ts`; the `changeset_summarize` verb, payload parser, sender, and
  `do_changeset_summarize` in `agent_supervisor.rs` with their round-trip tests
  (`make_summarize_harness` retargets to the engine tests or is deleted);
  `ScribeKind::Summary` if it survived #step-16d. Warnings-are-errors sweeps any orphan.
- at0228's commit leg re-verified against the `TugTextarea`
  (`data-testid="changeset-commit-message"` moves with the control; `app.type` targets it
  unchanged).

**Tasks:**
- [ ] `ScribeContext` ownership moves to the engine wiring; the supervisor keeps only
      `start_draft_engine` (delete the `scribe: Option<ScribeContext>` field if the verb
      was its last consumer).
- [ ] No new app-tests for the draft loop (Test Plan policy); the panel's presence with a
      seeded persisted draft MAY be asserted opportunistically in at0228 only if it adds
      zero new legs — otherwise skip.

**Tests:**
- [ ] `cd tugdeck && bun test` (draft-store overlay unit tests: state/delta ingestion,
      snapshot supersession) ; existing suites green after the deletions.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` ; `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test-build at0228-changeset-aggregate.test.ts`

---

#### Step 16g: M03A integration checkpoint {#step-16g}

**Depends on:** #step-16c, #step-16f

**Commit:** `N/A (verification only)`

**References:** Milestone M03A, (#success-criteria)

**Tasks:**
- [ ] Live (human-tested per the Test Plan policy): a session writes files → the entry's
      draft appears within quiet period + one generation, streaming visibly if watched;
      further edits update it; an untouched entry never regenerates (watch the TugDevPanel
      / process logs for scribe spawns); Commit with the maintained message → receipt →
      the shrunken changeset drafts afresh; edit the field → a newer draft pins, "Use
      latest draft" adopts it.
- [ ] Live dash loop: `tugutil dash commit` a round → the dash entry's join-message draft
      regenerates; the dash entry shows real inline diffs (round + dirt).
- [ ] Restart tugcast / reopen the deck → drafts render from persistence with zero scribe
      spawns.
- [ ] Diff surfaces: inline per-file, inline whole-entry, pop-out Text-card diff mode
      (descriptor reuse: popping the same diff twice activates the existing card), dev
      card `/diff` sheet — all rendering through `TugDiffDocument`.

**Tests:**
- [ ] Full-suite pass.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test`

---

### Milestone M03B — Block-grammar quality pass {#milestone-m03b}

M03A stood the AI-driven Changeset card up on bespoke display idioms. M03B re-expresses its
*entry contents* on the house tool-call block grammar ([P25]) and makes the commit-message
field CM6-backed ([P26]), so the card reads as one system with the transcript. The card's
top-level structure is untouched.

**Explicitly OUT of scope for M03B (deferred to the follow-on Lens plans)** {#non-goals-m03b}:

- Re-homing the chrome modules out of `cards/blocks/` (a later `git mv` + import sweep). M03B
  imports them from their current path.
- Any change to the card's top-level structure: the `TugAccordion` entry sections and the
  fixed TOC `TugListView` (`changeset-card.tsx`) stay exactly as they are.
- Re-expressing the *entries themselves* as `BlockChrome`, the Lens card, and the section
  registry.

---

#### Step 16h: BlockHeader leading slot + optional verb; monochrome badge doctrine {#step-16h}

**Depends on:** #step-16g

**Commit:** `feat(tugdeck): BlockHeader leading slot + optional verb; write down the monochrome +N −M doctrine`

**References:** [P25] Block-grammar adoption, [P27] Monochrome badges, Milestone M03B,
(#state-zone-mapping)

**Artifacts:**
- `blocks/block-header.tsx` gains two generalizations, both purely additive (no visual change
  to any existing transcript block):
  - a `leading?: React.ReactNode` prop rendered in the leftmost slot IN PLACE of the
    lifecycle-dot `TugProgressIndicator` when provided (a changeset file row puts its commit
    checkbox there); when absent, the dot renders exactly as today. `BlockChrome`
    (`block-chrome.tsx`) forwards a matching `leading` prop through to the header.
  - an **optional-verb** form: `toolName` becomes `toolName?: string` (a file row has no
    verb). When omitted, the `.tool-call-header-name` span is not rendered and the identity
    (`target`) leads the row. The `aria-label`s that interpolate `toolName` (Copy, the fold
    cue's Expand/Collapse) fall back to a neutral label (e.g. "block") when it is absent.
    `BlockChrome`'s `toolName` becomes optional in lockstep.
- `block-header.css`: layout for the `leading` slot (same box the dot occupies — `DOT_SIZE`
  width so identity alignment is unchanged) and the no-name row (no left gap where the name
  would sit).
- **Comment corrections** ([P27]): rewrite the three stale coloring comments to state the
  monochrome doctrine — `formatDiffSummaryParts`'s docstring in `blocks/tool-result-summary.ts`
  (drop "colors the added half green and the removed half red"), the inline comment at the
  `DiffSummaryBadges` call site in `block-header.tsx` (drop "green/red text on the `+N` / `−M`
  glyphs alone"), and the `[L20]` docstring line in `blocks/edit-tool-block.tsx` ("the
  change-count badge rides the shared `--tugx-block-tone-*` add / remove tones"). The rendered
  code (`DiffSummaryBadges` = `emphasis="ghost" role="inherit"`, no tint) is already correct
  and does not change.

**Tasks:**
- [ ] `leading` and the dot are mutually exclusive — the header renders one leftmost glyph, so
      alignment of the identity row is invariant across dot-vs-leading.
- [ ] Optional verb keeps `data-slot`s and the actions cluster (Copy + chevron) intact; a
      no-name block is still fully collapsible.
- [ ] No new tokens ([L20]); reuse `--tugx-toolheader-*`.

**Tests:**
- [ ] Existing block-grammar bun tests (gallery / `blocks/__tests__`) stay green; a small unit
      test asserting the header renders `leading` in place of the dot and omits the name span
      when `toolName` is undefined (pure prop-shape, no jsdom render assertion beyond what the
      existing block tests already do).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test` (the transcript's existing tool blocks are visually unchanged — the
      curated sweep covers the gallery + a real transcript)

---

#### Step 16i: TugMessageEditor — reusable CM6 message field {#step-16i}

**Depends on:** #step-16g

**Commit:** `feat(tugdeck): TugMessageEditor — a reusable CM6 message field over TugTextEditor`

**References:** [P26] Message editor, Milestone M03B, (#state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-message-editor.tsx` (+`.css`), composing `TugTextEditor`
  exactly as `cards/text-card-find-bar.tsx` composes it. Props (a minimal surface):
  `value`/`onChange` mirror the CM6 doc out via an `EditorView.updateListener.of` extension
  reading `update.state.doc.toString()` (the find-bar's query-mirror technique — no controlled
  round-trip); `placeholder`; `maxRows` (default ≈ the old `rows={3}`) with
  `--tug-text-editor-min-height` set so the empty field reserves the same height; `onSubmit`
  fired on Cmd-Enter (the substrate fires `onSubmit` on Cmd-Enter regardless of
  `returnAction`); `disabled`; `data-testid` pass-through. The substrate is mounted
  `borderless`, `preserveState={false}`, `returnAction="newline"` (Enter inserts a newline;
  this is a multi-line message field, not a submit-on-Enter input), `markdownTextStyling`
  omitted (its default is OFF).
- An imperative handle (`React.forwardRef` → a small `TugMessageEditorHandle`) exposing
  `restoreState(text)` (prefill via the substrate delegate's `restoreState()` /
  `captureState()` shape) and `clear()` (delegate `clear()`), so a consumer can seed a new
  draft into a pristine field and clear it on commit ([P28] wiring).
- `.css`: borderless field metrics mirroring `text-card-find-bar.css`.

**Tasks:**
- [ ] Substrate responders (`CUT`/`COPY`/`PASTE`/`SELECT_ALL`/`UNDO`/`REDO`) come free from
      `TugTextEditor` — do NOT register a second responder form on the field ([P26], [L11]).
- [ ] The doc-mirror `updateListener` is captured once (a `useMemo` over the stable submit/
      change refs), matching the find-bar's `findBarExtensions` pattern — the `extensions`
      contract is read at mount.
- [ ] No borrowed CSS; compose the real `TugTextEditor` (never hand-roll or borrow its CSS
      classes/DOM — compose the component) ([L20]).

**Tests:**
- [ ] `cd tugdeck && bun test` — the component compiles and type-checks; no jsdom render test
      (banned). It is exercised end-to-end when #step-16l lands it on the card. An
      exported-but-unconsumed component is warning-free (TS does not flag exports; vite
      tree-shakes it) so this step compiles clean standalone; OPTIONALLY mount it in the
      gallery (`cards/gallery-text-editor.tsx` sits alongside) for a live consumer at commit
      time.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`

---

#### Step 16j: TugDiffDocument header restyle onto the block grammar {#step-16j}

**Depends on:** #step-16h (documentary/soft — 16j references the [P27] monochrome doctrine 16h
writes down, but the CSS color-removal + one-line layout need nothing from 16h's code; 16j can
land independently if 16h slips)

**Commit:** `feat(tugdeck): TugDiffDocument — one quiet-line header, monochrome +/− counts`

**References:** [P27] Monochrome badges, [P29] Entry diff, [P18] TugDiffDocument, Milestone M03B

**Artifacts:**
- `tugdeck/src/components/tugways/tug-diff-document.tsx` (+`.css`): the summary header becomes
  ONE non-wrapping quiet line — `summary text │ view toggle │ Expand All / Collapse All │
  host actions` — pipe-delimited per the `block-header.css` section conventions, replacing the
  current two-column `justify-content: space-between` layout (`.tug-diff-document-header` is a
  flex row today with `.tug-diff-document-header-text` as a wrapping column and
  `.tug-diff-document-header-actions` pushed right). The per-file accordion trigger
  (`FileTrigger`, `.tug-diff-document-file-trigger`) adopts the block-header line treatment.
  The optional `label` prop (e.g. the sheet's "Uncommitted changes (git diff HEAD)") **leads
  the quiet line** as its first pipe-delimited section (`label │ summary │ view toggle │
  Expand/Collapse │ host actions`) — it is not dropped; when absent the line simply starts at
  the summary. The label is the section that ellipsizes first when narrow.
- Monochrome counts ([P27]): `.tug-diff-document-stat-add` / `.tug-diff-document-stat-remove`
  (both the summary-line totals and the per-file trigger's `+N −M`) drop their
  `--tug7-element-tone-text-normal-success-rest` / `-danger-rest` colors and render as ghost
  badges in the header's own text color. The status *letters*
  (`.tug-diff-document-file-status[data-status="…"]`) keep their tone colors — they carry
  semantic meaning; only the `+/−` counts go monochrome.

**Tasks:**
- [ ] The three current hosts render unchanged in behavior: the `/diff` sheet
      (`cards/diff-sheet.tsx`), the Diff card (`cards/diff-card.tsx`), and the changeset
      entry-doc expansion — the last of which #step-16k then removes, but this step must not
      break it mid-series.
- [ ] The one-line header must ellipsize the summary text (not the controls) when narrow; the
      view toggle + Expand/Collapse never wrap.
- [ ] No borrowed CSS; the pipe separators reuse the `block-header.css` convention rather than
      re-inventing dividers ([L20]).

**Tests:**
- [ ] at0104 (`tests/app-test/at0104-diff-sheet.test.ts`) stays green: `diff-file`,
      `diff-expand-all`, `diff-collapse-all`, `diff-refresh`, `diff-done` testids are unmoved;
      the header restyle is CSS/structure only.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test at0104-diff-sheet.test.ts` then the curated sweep

---

#### Step 16k: Changeset file blocks + whole-entry diff rework {#step-16k}

**Depends on:** #step-16h, #step-16j

**Commit:** `feat(tugdeck): changeset file rows become BlockChrome; entry diff = expand-all + pop-out`

**References:** [P25] Block-grammar adoption, [P29] Entry diff, [P27] Monochrome badges,
[P20] Inline diff, Spec S08, Milestone M03B, (#state-zone-mapping)

**Artifacts:**
- Each changeset file row in `cards/changeset-card.tsx` becomes a `BlockChrome` (variant
  `tool`, optional-verb form — a file row has no verb, [P25]):
  - the header `leading` slot holds the commit checkbox (`FileSelectCheckbox`, unchanged) for
    session/unattributed entries; dash rows have no checkbox (`leading` omitted → the dot
    renders, showing lifecycle-neutral `idle`).
  - identity (`target`) = the status glyph + `FilePathLink` (preserve the existing
    `TUG_ACTIONS.OPEN_FILE` dispatch, the context-menu action, and the
    `data-tug-focus="refuse"` + mousedown-preventDefault focus discipline the current
    `FilePathLink` carries — the card must not steal first responder, per the mousedown-focus
    gotcha).
  - the header **summary** slot carries the monochrome `+N −M` badge via
    `resultSummary={{kind:"diff", added, removed}}`, sourced from the entry's per-entry
    `GitDiffStore` snapshot (`useEntryDiff` / `getEntryDiffStore`; `GitDiffFile` already carries
    `added`/`removed`/`binary`/`unified`). The badge is omitted (no `resultSummary`) until the
    snapshot has a matching file. **Fetch timing (decided):** to show the badge at rest — before
    any file is expanded — the entry body calls `ensureRequested()` **eagerly when its accordion
    section is open**, not only from the expand toggles (today `ensureRequested` fires solely
    from `toggleFileDiff`/`toggleDocDiff`). Eager fetch is gated to **expanded accordion
    sections** (the `TugAccordion` is `type="multiple"`; only open sections request), so the cost
    is one `git diff` per *open* entry, not per TOC row — negligible at the "handful of open
    entries" scale, and the per-entry store is disposed when the entry leaves the snapshot
    (existing module-map sweep). A collapsed accordion section fires nothing.
  - provenance (the current `changeset-file-provenance` `op · origin` text) and the
    `ambiguous` / `shared` badges move into pipe-delimited header sections.
  - the disclosure **chevron** (the header's built-in fold cue) REPLACES the
    `GitCompareArrows` `FileDiffButton`; expanding mounts the file's `DiffBlock` with
    **`embedded={true}`** as the block body (source = the entry-payload's matching file's
    `unified` text). Use `embedded`, NOT `suppressHeader`: in `body-kinds/diff-block.tsx`
    these are distinct contracts — `embedded={true}` is the under-a-chrome mode that portals
    the view-toggle / fold affordances into the chrome's actions slot
    (`ChromeActionsTargetContext`) AND drops the identity header
    (`headerHidden = embedded || suppressHeader`); `suppressHeader` alone is the
    accordion-host mode (`TugDiffDocument` / the old `InlineFileDiff`) that hides the header
    but does NOT portal. Passing `suppressHeader` here would silently render the diff with no
    portaled affordances — tsc + the at0228 marker assertion both still pass, so nothing
    catches the mistake. The chevron is DISABLED for untracked files with no HEAD side — pass
    `children={null}` so `BlockChrome`'s `!hasExpandableContent` auto-disables the cue
    (`hasHeadDiff` stays the gate; no separate disabled prop needed).
  - the `OPEN_DIFF` pop-out (`PopOutDiffButton`, dispatching `TUG_ACTIONS.OPEN_DIFF` with
    `fileDiffDescriptor(item, file)`) becomes a header action (`headerActions`).
- **Collapse wiring (load-bearing — the chevron does not exist without it).** A standalone
  `BlockChrome` with NO `ToolBlockCollapseContext` renders **no disclosure chevron and always
  mounts its body** (`block-chrome.tsx`: `disclosure = blockCollapse !== null ? {…} :
  undefined`; `collapse-context.tsx` docstring — "null means this block does not participate").
  `forceExpanded` only pins-open-and-disables, so it is NOT a toggle. To get the chevron +
  collapse-by-unmount, each file block is wrapped in a `ToolBlockCollapseContext.Provider`
  (the `ToolBlockCollapseHandle` shape from `blocks/collapse-context.tsx`) whose
  `{collapsed, toggle, toolUseId}` is driven by the entry body's local `expandedFiles`
  `useState`: `collapsed = !expandedFiles.has(path)`, `toggle(next)` mutates the set,
  `toolUseId = <entry.id>|<path>` (a synthetic stable id — no real tool call). This is plain
  local state — NOT `ToolBlockExpansionContext`, no persistence, no `A9` key. **Expand All /
  Collapse All** fall out for free: the set becomes all-paths / empty. (The commit-composer
  block in #step-16l does NOT wrap in a provider — it wants the always-expanded standalone
  default; only the file blocks are foldable.)
- **File-block identity for tests + per-file selectors.** `BlockChrome` forwards only
  `data-slot` (via `rootSlot`), `data-variant`, `data-tool-use-id` (from the collapse handle's
  `toolUseId`), and `className` — NOT an arbitrary `data-path`. So the file block's outer host
  (the collapse-provider element is the natural one) stamps `data-path="<repo-relative path>"`
  and a `data-testid` so at0228's `[data-testid=…][data-path="committed.txt"]` selectors and
  the badge/pop-out/disclosure all resolve per-file.
- Entry-level affordance ([P29]): DELETE `entryActionsRow` (the "Diff N files" / "Hide diff"
  toggle, `data-testid="changeset-entry-diff"`) and `entryDocInline` (the in-card
  `TugDiffDocument` expansion + `docExpanded` state). Replace with **Expand All / Collapse
  All** over the entry's file blocks (drive each block's collapse) plus ONE whole-entry
  pop-out (`PopOutDiffButton` with `entryDiffDescriptor(item)`).
- **Deletions:** `FileRow`, `FileDiffButton`, `InlineFileDiff`, and the `.changeset-file-row`
  / `.changeset-inline-diff*` CSS families (`changeset-card.css`). The unattributed branch's
  hand-inlined duplicate row (the `<div className="changeset-file-row">` block inside
  `EntryBody`'s unattributed return, ~`changeset-card.tsx` lines around the
  `data-testid="changeset-unattributed"` map) collapses into the same file-block component —
  one component for session, unattributed, and dash rows.
- Dash entries ([P19], [P29]): same file-block treatment; per-file bodies source from the
  range payload (the dash's shared `entryDiffDescriptor` `kind:"range"` snapshot). The M03A
  dash affordances (both per-file and whole-entry) are preserved through the new blocks.
- at0228 (`tests/app-test/at0228-changeset-aggregate.test.ts`): the diff leg adapts
  mechanically. The per-file block wrapper carries `data-path` (see the identity artifact), so
  the test scopes to the file's block via `[data-testid="changeset-file-block"][data-path="…"]`
  and clicks its disclosure fold cue (`[data-slot="tool-call-header-disclosure"]`) to reveal
  the diff. The marker assertion points at the embedded `DiffBlock` mounted in the block body
  (replacing the `changeset-inline-diff` container assertion). The untracked-file "no diff
  affordance" assertion becomes "the disclosure is disabled" (`aria-disabled` / the
  `BlockFoldCue` disabled state) for the untracked path. No new legs.

**Tasks:**
- [ ] Per-file collapse is a card-local `ToolBlockCollapseContext.Provider` per file block over
      the entry body's `expandedFiles` `useState` (see the Collapse-wiring artifact) — NOT
      `forceExpanded` (which only pins-open) and NOT `ToolBlockExpansionContext` (that is the
      transcript's persisted overrides). The collapse boolean is local-data ([L24]); the
      provider wrapper keeps stable mount identity across collapse↔expand so the body subtree
      appears/disappears without tearing the block down ([L26]). Name [L24]/[L26]/[L20] in the
      commit.
- [ ] Dispose per-entry stores when entries leave the snapshot (the existing module-map sweep
      in `changeset-diff-store.ts`, unchanged).
- [ ] Pop-out buttons keep `data-tug-focus="refuse"` + mousedown preventDefault.
- [ ] Compose real components — `BlockChrome`, `DiffBlock`, `TugBadge`, `TugCheckbox` — no
      borrowed CSS ([L20]).

**Tests:**
- [ ] App-test: adapted at0228 diff leg (after `just app-test-build` is unnecessary — no Rust
      changed; a plain `just app-test at0228-changeset-aggregate.test.ts`).
- [ ] bun: existing `changeset-diff-store` / `open-diff-in-card` unit tests stay green.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test at0228-changeset-aggregate.test.ts` then the curated sweep

---

#### Step 16l: Commit composer block; DraftPanel + TugTextarea retire {#step-16l}

**Depends on:** #step-16i, #step-16k

**Commit:** `feat(tugdeck): the commit composer becomes one block over TugMessageEditor`

**References:** [P28] Commit composer block, [P26] Message editor, [P24] Streaming/pinning,
Spec S10, Milestone M03B, (#state-zone-mapping)

**Artifacts:**
- ONE `BlockChrome` in `EntryBody` (`cards/changeset-card.tsx`) replacing the `DraftPanel` +
  `TugTextarea` stack:
  - the chrome's lifecycle **dot** is the drafting indicator ([P28]): `phase="in_flight"`
    while the `changeset-draft-store.ts` overlay reads `drafting`, `phase="success"` when the
    draft is ready, `phase="error"` on scribe failure. The error hint renders as the chrome's
    `notice` band (tone `error`) so it stays visible WITHOUT blanking the draft
    (`draftText`/`draftError` from the existing `useChangesetDraft` overlay, unchanged).
  - header actions: copy-draft (`BlockCopyButton`, the current draft copy) and "Use latest
    draft" (`data-testid="changeset-use-latest-draft"`, shown only when
    `pinned && draftText !== null && draftText !== message`, unchanged predicate).
  - body: `TugMessageEditor` ([P26]) — `data-testid="changeset-commit-message"` moves onto the
    editor. A new draft streams into a pristine editor via `restoreState()`; the field pins on
    first user edit (`setPinned(true)` on change); a landed commit clears + unpins
    (`clear()` + `setPinned(false)` on `phase === "done"`). The existing pinned / `draftText`
    / receipt semantics ([P24]) are preserved EXACTLY — only the widget changes from
    `TugTextarea` to `TugMessageEditor`, and the `useEffect`s that follow `draftText` while
    pristine now call the editor's `restoreState()` instead of `setMessage`.
  - footer: the width-stabilized Commit button (`widthStabilize={{alternateLabel:
    "Committing…"}}`, `data-testid="changeset-commit-button"`) moves into the block's
    `footerBadges` slot; the receipt panel (`data-testid="changeset-commit-receipt"`) renders
    in the body when `phase === "done"`, as today.
  - dash entries render this block **read-only** — no commit controls (no checkbox `leading`,
    no footer button); the header still shows the maintained join-message draft ([P28]).
- **Deletions:** `DraftPanel`, the `Bot` avatar import + `.changeset-draft*` CSS, the
  `TugMarkdownBlock` draft rendering, the `TugProgressIndicator` "wave", the "updating…"
  freshness text, and the `TugTextarea` import/usage. `useChangesetCommit`,
  `useChangesetDraft`, and `changeset-draft-store.ts` are UNCHANGED.

**Tasks:**
- [ ] The lifecycle-dot mapping is derived read-only from the draft overlay + commit phase
      ([L02] read, [L06] the dot paints via CSS/DOM inside the indicator) — no new store.
- [ ] The pristine-follows-draft effect re-seeds the CM6 field via `restoreState()` only while
      `!pinned` ([P24] semantics verbatim); a user edit pins; commit unpins.
- [ ] Substrate responders come with `TugMessageEditor` — no extra wiring ([P26]).

**Tests:**
- [ ] at0228's commit leg re-verified — but typing changes: `app.type(selector, text)` sets a
      `<textarea>`'s `.value`, which a CM6 editor has no notion of. The leg must adopt the
      house CM6-typing pattern used by every text-editor app-test (`at0209`/`at0210`/`at0212`
      `typeIntoEditor`, `at0223`/`at0224` find-bar): `el.focus()` +
      `document.execCommand("insertText", false, text)` against the field's `.cm-content`
      element (scoped under the composer block's `changeset-commit-message`), NOT `app.type` on
      the testid. The commit itself stays a `changeset-commit-button` click (do not rely on an
      editor-leaf ⌘-key: per the app-test chain-first-responder gotcha, a headless sweep can't
      reliably make an editor the chain LEAF for a keybinding dispatch). The numstat-receipt
      assertion is unchanged. Per Test Plan policy the maintained-draft LOOP stays human-tested;
      no new legs.
- [ ] `cd tugdeck && bun test` — existing suites green after the deletions.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test at0228-changeset-aggregate.test.ts` then the curated sweep

---

#### Step 16m: Scribe scoped commit-subject style {#step-16m}

**Depends on:** #step-16g

**Commit:** `feat(tugcast): scribe drafts carry the house scoped commit-subject format`

**References:** [P30] Scribe subject style, Spec S11, Milestone M03B, (#draft-engine)

**Artifacts:**
- `tugcast/src/scribe.rs`: tighten the subject contract so a draft never emits a bare one-word
  subject like `Fix`. Add the scoped-subject rule (`scope(topic): specific summary` — the
  repo's uniform commit voice, e.g. `tugdash(changesets-m03b): …`, `plan(update): …`) to
  `draft_ask` (so it holds even when the packaged-skill extraction succeeds) AND to the
  `BAKED_STYLE_RULES` const fallback. `compose_draft_prompt_session/dash/unattributed` are
  unchanged in structure — they inherit the rule through `draft_ask`.
- The tightened rule text flows into every per-owner-kind prompt (`draft_ask` opens all three
  composers).

**Tasks:**
- [ ] Keep the existing rules intact (imperative, no period, ≤50-char subject, terse bullets,
      NEVER any AI/agent attribution — no Co-Authored-By, ever); ADD the scoped-subject
      requirement, do not replace them.
- [ ] Warnings are errors — no dead consts; if `BAKED_STYLE_RULES` grows, keep it referenced by
      `commit_style_rules`'s fallback path.

**Tests:**
- [ ] Extend `draft_prompt_composers_carry_the_right_sections_per_owner_kind` (the existing
      fake-`ScribeSpawner` composer test): assert the scoped-subject rule text appears in each
      of the session / dash / unattributed prompts (never assert model prose). The baked
      fallback is covered by `commit_style_rules_extracts_from_the_packaged_skill_or_falls_back`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 16n: M03B integration checkpoint {#step-16n}

**Depends on:** #step-16k, #step-16l, #step-16m

**Commit:** `N/A (verification only)`

**References:** Milestone M03B, (#success-criteria)

**Tasks:**
- [ ] The transcript's existing tool blocks are visually unchanged (the BlockHeader
      generalization is purely additive — no `leading`/no-name block in the transcript).
- [ ] Changeset card: file rows render as blocks — leading checkbox (session/unattributed),
      status + path chip, monochrome `+N −M` in the header once the diff loads, provenance +
      ambiguous/shared in header sections, disclosure chevron opens the embedded `DiffBlock`,
      pop-out opens the Diff card (descriptor reuse: popping the same file twice activates the
      existing card); Expand All / Collapse All drive the entry's blocks; the whole-entry
      pop-out opens the range/head diff.
- [ ] Commit composer: one block; the lifecycle dot shows drafting → ready → error; a new
      draft streams into a pristine CM6 field; editing pins it, "Use latest draft" adopts a
      newer one, Commit produces the numstat receipt and clears + unpins the field; the error
      hint survives a scribe failure without blanking the draft. Cmd-Enter submits.
- [ ] Dash entry renders the composer block read-only with its maintained join-message draft.
- [ ] `/diff` sheet + Diff card render `TugDiffDocument`'s one-line header with monochrome
      counts; the status letters keep their tone colors.
- [ ] Live scribe: a fresh draft carries a scoped, specific subject (never a bare "Fix").

**Tests:**
- [ ] Full-suite pass.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test`

---

#### Step 17: tugdash-core + tugdash CLI extraction {#step-17}

**Commit:** `feat(tugdash): extract dash into tugdash-core + tugdash CLI`

**References:** [P12] tugdash, Spec S05, Milestone M04

**Artifacts:**
- `tugrust/crates/tugdash-core`: everything from `tugutil-core/src/dash.rs` (name
  validation, `detect_default_branch`, dash-log) plus the orchestration from
  `tugutil/src/commands/dash.rs` (`run_dash_create/commit/join/release/list/show`,
  `branch_name`, `worktree_path`, `remove_dash_worktree`, `reap_dash_tmux`) reshaped as a
  library API returning typed results (no printing). The tmux reap keeps calling
  `tugutil`'s instance module — move `instance` discovery helpers into a small shared
  location or re-expose them (decide at implementation: least-churn wins; note the current
  call `instance::reap_instance_tmux`).
- `tugrust/crates/tugdash`: clap CLI over the core, subcommands per Spec S05, `--json`
  everywhere, behavior-identical to `tugutil dash` at this step (join engine v2 is Step 19).
- `tugutil dash` subcommand deleted; `tugutil-core/src/dash.rs` deleted.

**Tasks:**
- [ ] Workspace `Cargo.toml` membership; `justfile`/packaging rows so `tugdash` ships beside
      `tugutil` in Tug.app resources.
- [ ] Port the existing dash tests to the new crates.

**Tests:**
- [ ] Existing dash lifecycle tests green under tugdash (create → commit → join → gone;
      idempotent create; release).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash -p tugdash-core -p tugutil`

---

#### Step 18: .tug/worktrees home + migration {#step-18}

**Depends on:** #step-17

**Commit:** `feat(tugdash): worktrees move to .tug/worktrees with auto-migration`

**References:** [P13] Worktree home, Risk table (migration), Milestone M04, (#rollout)

**Artifacts:**
- `worktree_path()` → `<repo>/.tug/worktrees/<sanitized-name>`; `tugutil init` gitignore
  block writes `.tug/` (keeps recognizing `.tugtree/` as already-ignored).
- Migration pass on every tugdash command: for each `tugdash/*` branch whose worktree sits
  under `.tugtree/`, `git worktree move` to the new home when the worktree is clean and no
  live instance holds it (reuse the reap/instance checks `remove_dash_worktree` uses);
  otherwise warn once and operate on the old path.

**Tasks:**
- [ ] `list`/`show` report the actual path either way.

**Tests:**
- [ ] Integration: repo with a `.tugtree` worktree migrates on `tugdash list`; a dirty one
      doesn't and still joins from its old path.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash -p tugdash-core`

---

#### Step 19: Join engine v2 {#step-19}

**Depends on:** #step-17

**Commit:** `feat(tugdash): join strategies, preview, intersection preflight, journaled teardown`

**References:** [P14] Join v2, [P01] Ownership, Spec S05, Milestone M04, (#dependencies)

**Artifacts:**
- `--strategy squash|merge|rebase` (squash default; merge = `--no-ff` merge preserving
  rounds; rebase = rebase onto base then fast-forward).
- `--preview`: `git merge-tree --write-tree <base> <branch>` (git ≥2.38 guard with a clear
  error), structured `--json` conflict list, tree untouched.
- Intersection preflight replacing the clean-base gate: blocking only when base dirt ∩
  (dash changed set = `git diff --name-only <base>...<branch>` ∪ worktree dirt) ≠ ∅; the
  current not-on-base-branch guard stays. Optional deeper check against `file_events` for
  provenance display (read-only sessions.db open, the Step-5 machinery).
- Join journal in the project state dir (beside `dash-log.md`): phases
  merge→commit→worktree-remove→branch-delete recorded; `--continue` resumes after partial
  failure; the silent auto-commit (`let _ =`) becomes fatal-on-error.

**Tasks:**
- [ ] Conflict path: on real (non-preview) conflict, leave a clean abort (restore pre-join
      state) plus the structured conflict list — never today's mid-merge dead end.
- [ ] Default squash message = the dash's maintained draft when present ([P23], Spec S09 —
      read via the ledger's `changeset_draft("dash", "tugdash/<name>", project_dir)`);
      `--message` still overrides.

**Tests:**
- [ ] Scratch-repo matrix: each strategy lands the expected history; preview reports a
      manufactured conflict without touching the tree; disjoint base dirt joins; overlapping
      base dirt refuses with the intersecting paths named; kill-between-phases then
      `--continue` completes.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash -p tugdash-core`

---

#### Step 20: Skill + packaging cutover {#step-20}

**Depends on:** #step-17, #step-18, #step-19

**Commit:** `feat(tugplug): skills drive tugdash; docs cut over`

**References:** [P12] tugdash, Spec S05, Milestone M04, (#documentation-plan)

**Artifacts:**
- `tugplug/skills/implement/SKILL.md`, `tugplug/skills/dash/SKILL.md`, `tugplug/CLAUDE.md`:
  every `tugutil dash …` becomes `tugdash …` (same flags; stdin round-meta unchanged);
  worktree-path prose updated to `.tug/worktrees/`; join prose mentions `--preview` before
  join.
- Root `CLAUDE.md`: repository-structure and Git-policy exception wording
  (`tugutil dash …` → `tugdash …`).

**Tasks:**
- [ ] Grep-sweep the repo for `tugutil dash` and `.tugtree` references (docs, tests,
      justfile, app-test helpers) and update.

**Tests:**
- [ ] N/A (prose + packaging; verified by Step 22 dogfood).

**Checkpoint:**
- [ ] `rg -n "tugutil dash|\.tugtree" --glob '!dash/**'` returns only intentional
      residue (migration code, this plan).

---

#### Step 21a: Join resolution ladder in tugdash-core {#step-21a}

**Depends on:** #step-19

**Commit:** `feat(tugdash): conflict resolution ladder — replay probe, rerere, re-merge, driver seam`

**References:** [P31] Resolution ladder, [P14] Join v2, Spec S12, Milestone M04

**Artifacts:**
- Ladder module in `tugdash-core` over the `merge-tree` stage-1/2/3 blobs (the parser
  drops today's `--name-only` and reads the `<mode> <oid> <stage>\t<path>` stage lines,
  `-z`-delimited): replay probe — in-memory per round via `merge-tree
  --merge-base=<round^>` + `commit-tree`, gated on git ≥ 2.40 (rung skipped below; never
  the base-worktree cherry-pick), clean replay ⇒ the join lands as the replayed rounds —
  shape change accepted ([P31]); per-file rungs rerere → `git merge-file`
  (zdiff3/histogram) → structured-merge driver seam (mergiraf when on PATH, three stages
  as temp files **carrying the real filename's extension** — its language detection is
  extension-based; generic configured-command seam, never bundled). Per-file
  `resolved_by` outcomes.
- **Non-content conflicts** (delete/modify, binary, mode) short-circuit to `unresolved`
  before any text rung ([P31]).
- rerere mechanics per [P31]: `rerere.enabled` + `rerere.autoUpdate` set by
  `create`/`join`; the rerere rung applies in a scratch detached worktree (add-detach →
  merge → harvest → remove); validated driver/AI resolutions are recorded into the shared
  `rr-cache` so identical future conflicts skip the expensive rungs.
- Candidate-commit builder: resolved blobs `hash-object -w` → `mktree` patch →
  `commit-tree` with base parent; land = ff base onto candidate with the staleness guard
  (candidate parent — or replay base — == base head at land time). No checkout is ever
  half-merged.
- CLI: `tugdash join --resolve [--json]` runs ladder + land; `--json` reports per-file
  rung outcomes; unresolved files keep Step 19's clean abort + structured list.

**Tests:**
- [ ] Scratch-repo matrix: base-cherry-picked-a-round conflict resolves via the replay
      probe (and lands the replay shape); a recorded rerere resolution replays on re-join
      (and a ladder-recorded resolution replays without re-running the driver); a
      marker-shrinking case resolves via merge-file retry; the driver rung is exercised
      via a stub driver command (mergiraf itself skipped when absent); a delete/modify
      conflict short-circuits to unresolved; an unresolvable overlap still cleanly aborts
      with the list; a stale candidate refuses to land.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash -p tugdash-core`

---

#### Step 21b: AI file-merge resolver + changeset_join_resolve verb {#step-21b}

**Depends on:** #step-21a

**Commit:** `feat(tugcast): scribe file-merge rung + changeset_join_resolve with streamed progress`

**References:** [P32] AI file-merge, [P31] Resolution ladder, [P11] Scribe, Spec S12,
Milestone M04

**Artifacts:**
- File-merge prompt composer in `tugcast/src/scribe.rs`: base/ours/theirs + the dash's
  maintained join draft ([P23]) + round subjects as intent context; deterministic output
  validation (no conflict markers, non-empty); per-file timeout matching the draft engine.
- `changeset_join_resolve` verb per Spec S12: runs join's **auto-commit preamble first**
  (outstanding dash-worktree dirt committed, exactly as the execute path does — else the
  candidate is stale the moment it's built), then the tugdash-core ladder with the AI
  rung injected; `changeset_join_resolve_delta` per file/rung transition; terminal
  ok/err with `resolved`/`unresolved`/`candidate_commit`/`shape`. One in-flight resolve
  per `(project_dir, dash)`; a newer request supersedes (the draft engine's coalescing
  posture).
- `changeset_join` execute form gains the optional `candidate` (ff-land with staleness
  guard, Spec S12) — landing routes through the existing `JoinJournal` →
  `finish_join_teardown` path (worktree removal, branch delete, dash-log "joined" line,
  `--continue` resumability), never a bare ref move.

**Tests:**
- [ ] Fake-`ScribeSpawner`: composer carries the three versions + intent sections;
      a marker-bearing or empty scribe reply leaves the file unresolved; delta sequence
      and terminal shapes assert on a manufactured two-conflict repo (one file resolved by
      the fake scribe, one left unresolved).
- [ ] Candidate land round-trip: resolve → `changeset_join {candidate}` lands it; a moved
      base head refuses with the stale detail.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugdash-core`

---

#### Step 21c: Card dash UX — Join/Release, preview, resolve overlay, review-confirm {#step-21c}

**Depends on:** #step-14, #step-20, #step-21b

**Commit:** `feat(tugcast,tugdeck): join dashes from the changeset card — preview, ladder resolve, review`

**References:** [P32] AI file-merge, [P31] Resolution ladder, [P14] Join v2, Spec S03,
Spec S12, Milestone M04

**Artifacts:**
- `changeset_join` / `changeset_release` verbs (Spec S03) + the client verb-store round
  trips (substrate landed ahead of this step alongside the Step-20 round).
- Card dash entries gain Join/Release actions: Join runs the preview → a clean bill shows
  the maintained dash draft ([P23]) as the join message with a confirm-to-join; conflicts
  show the structured list with a **Resolve conflicts** affordance.
- Resolve flow: `changeset_join_resolve` + the `/btw`-style progress overlay
  (`changeset-join-store.ts` over the Spec S12 deltas); on full resolution the pane flips
  to the reviewable resolved diff — per-file inline `DiffBlock`s via the range descriptor
  against the candidate commit, badged with `resolved_by` — and **Join** lands the
  candidate on explicit confirm. Unresolved files keep the honest conflict list.
- Confirm-before-join (hard-to-reverse action); width-stabilized action buttons.

**Tasks:**
- [ ] Release asks for confirmation too (discards work).

**Tests:**
- [ ] Rust: verb preview/execute round trips on a scratch repo (landed with the substrate).
- [ ] App-test: card joins a clean dash end-to-end; conflicted preview renders the list.
      (The resolve flow's scribe rung is covered by the Step-21b fake-spawner tests — the
      app-test does not spend a real claude call.)

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` ; `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test`

---

#### Step 22: M04 / phase exit checkpoint {#step-22}

**Depends on:** #step-18, #step-19, #step-20, #step-21a, #step-21b, #step-21c

**Commit:** `N/A (verification only)`

**References:** Milestones M01–M04, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Full dogfood loop: `/tugplug:devise` a toy plan → `/tugplug:implement` on a tugdash
      worktree (skills now driving tugdash) → watch the dash changeset in the card → preview
      → join from the card.
- [ ] Documentation Plan items done (design-decisions promotions, CLAUDE.md rows).

**Tests:**
- [ ] Full-suite pass everywhere.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build` ; `cd tugcode && bun test`
- [ ] `just app-test`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Authoritative per-session file attribution feeding a live, multi-session
Changeset card that diffs, summarizes, and commits — plus `tugdash`, a standalone worktree
tool with a join engine that previews, tolerates disjoint base dirt, survives conflicts, and
tears down atomically.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `tugutil changes` returns the exact session file set, Bash edits included
      (integration tests + live dogfood).
- [ ] Commit skill stages from the authoritative list (live dogfood commit).
- [ ] Changeset card is the only git surface (git card gone), grouped by owner, sub-second
      on tool-driven changes (app-test + live).
- [ ] Card can diff, draft a message, and commit exactly one changeset's files (app-test).
- [ ] Every changeset entry with changes maintains its own ready-to-commit message —
      fingerprint-gated, ledger-persisted, streaming to a visible card — and dash entries
      diff inline like everything else (M03A: Rust suite + #step-16g live dogfood).
- [ ] The Changeset card's entry contents render on the house tool-call block grammar — file
      rows as `BlockChrome`, diffs as embedded `DiffBlock`s, the commit message as a CM6
      `TugMessageEditor`, all diff `+/−` counts monochrome — and drafts carry a scoped
      commit-subject (M03B: bun/tsc/vite + at0104/at0228 + #step-16n live dogfood).
- [ ] `tugdash` replaces `tugutil dash` everywhere; join preview/strategies/preflight/journal
      all demonstrated by the Step-19 test matrix; the conflict resolution ladder and its
      review-gated AI rung demonstrated by the Step-21a/21b matrices and the card flow
      ([P31]/[P32]).
- [ ] All suites green: `cargo nextest run`, `bun test` (tugcode), `bunx tsc --noEmit`,
      `bunx vite build`, `just app-test`.

**Acceptance tests:**
- [ ] Step 7, 12, 12f, 16, 16g, 16n, 22 integration checkpoints.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] `Vcs` trait + second backend (jj/sapling).
- [ ] Cross-workspace changeset view ([Q01]).
- [ ] Rust→TS codegen replacing the golden-fixture guard.
- [ ] Interactive hunk staging / partial-file commits from the card.
- [ ] Attribution-aware `/rewind` integration (file checkpointing already snapshots
      Write/Edit — a natural pairing).

| Checkpoint | Verification |
|------------|--------------|
| M01 attribution | #step-7 |
| M02 card read path | #step-12 |
| M02A aggregate card | #step-12f |
| M03 card actions | #step-16 |
| M03A AI-driven card | #step-16g |
| M03B block-grammar card | #step-16n |
| M04 tugdash + exit | #step-22 |
