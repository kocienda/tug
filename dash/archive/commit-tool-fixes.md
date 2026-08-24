## Commit Tool Fixes — the commit surface can no longer miss content {#commit-tool-fixes}

**Purpose:** Make `tugutil context` / `tugutil commit` structurally incapable of silently
dropping changed files. The session event log becomes an *annotator* of the working tree
instead of a *gatekeeper* of it, capture gaps in tugcast's Bash attribution are closed
with a turn-scoped fallback bracket, and the commit skill is taught to dispose of every
dirty file explicitly. As a prep step, the library crate is renamed
`tugmark-core` → `tugchanges-core`, retiring the last live use of the withdrawn
`tugmark` CLI name.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-17 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Twice now, a real `tugutil commit` run under-reported the session's changed files — most
recently a `perl -i` bulk pass whose ~33 files had no `file_events` rows, so
`tugutil context` reported only 15 of 48 changed files; earlier, a `git mv` rename sweep
hit the same hole. The root cause is architectural: `resolve_changes` in the git
changes-and-commits library crate (today `tugrust/crates/tugmark-core/src/changes.rs`;
renamed to `tugchanges-core` in Step 1 — the plan uses the new name from Step 2 onward)
computes the commit set as **event-log ∩ git-status** — the ledger's `file_events` rows
are a *positive filter*, so any file that misses capture silently vanishes from
`context` and from a default `commit`. Capture is inherently best-effort; there are at
least five known miss paths (see [#capture-gap-inventory]). No amount of capture
hardening closes all of them — a fingerprint delta cannot be reconstructed after the
fact — so the correctness fix must be on the *read/commit* side, with capture
improvements as defense in depth.

#### Strategy {#strategy}

- **Prep: finish the tugmark retirement** — the `tugmark` CLI was unified into `tug`
  and renamed `tugutil`; the crate rename `tugmark-core` → `tugchanges-core` ([P08])
  lands first so every subsequent commit in this plan touches only current names.
- **Invert the join** in tugchanges-core: `git status` is the universe; every dirty
  file is classified into one of three buckets — `attributed` (this session's rows),
  `foreign` (only other sessions' rows), `unattributed` (no rows anywhere). Nothing
  dirty can be invisible ([P01], [P02]).
- **Make `commit` refuse to be silently partial**: when unattributed files exist and the
  caller gave no explicit disposition, `commit` fails with a distinct exit code listing
  them ([P03]). A half-commit becomes impossible to produce by accident.
- **Close the capture race and crash windows** in tugcast with a turn-scoped fallback
  bracket: snapshot at user-message forward, snapshot at `turn_complete`, attribute any
  delta not already covered by per-call rows ([P05]). This keeps the *attribution* story
  (Changeset cards) accurate; the join inversion protects the *commit* regardless.
- **Fix the untracked-directory blind spot**: `git status --porcelain=v2` collapses a
  fully-untracked directory to one `? dir/` line, so files inside it never match the
  join. Both tugchanges-core's status call and tugcast's `snapshot_worktree` switch to
  `--untracked-files=all` ([P06]).
- **Teach the skill the buckets**: `tugplug/skills/commit/SKILL.md` is rewritten so the
  agent must dispose of every `unattributed` file (include it or name it as inflight in
  the report) — the agent is the last line of judgment, and `context` now shows it
  everything.
- Sequencing: crate rename, then core inversion (it alone would have caught both
  incidents), then the commit contract, then the CLI, then tugcast hardening, then the
  skill.

#### Success Criteria (Measurable) {#success-criteria}

- `git grep -n tugmark -- tugrust/` returns nothing after Step 1, while
  `git grep -n tugmark -- tugdeck/crates/tugmark-wasm` still has hits (the deck's
  unrelated **markdown** crate keeps its name; historical `dash/`/`tuglaws/`
  mentions are out of scope). Use `git grep`, not `grep -rn` — the latter matches
  regenerated `tugrust/target/` build artifacts ([P08]).
- A file dirtied with **zero** ledger rows appears in `tugutil context --json` under
  `unattributed`, with a diff (integration test in `tugutil/tests/changes_cli.rs`).
- A default `tugutil commit` in the presence of unattributed files exits **3** and lists
  them on stderr; with `--include-unattributed` it commits them; with
  `--leave-unattributed` it proceeds and the receipt's `left_behind` names them
  (integration tests).
- A file mutated by a Bash command **outside** any per-call bracket window (simulating
  the pre-snapshot race) still gains a `file_events` row with `origin='turn'` by
  `turn_complete` (tugcast test in `feeds/agent_bridge.rs`).
- A new file created inside a fully-untracked directory joins correctly (test at the
  changes layer proving the `-uall` fix).
- The Session card's commit button (tugcast `run_changeset_commit`) still commits its
  explicit path set unchanged (existing tugcast tests pass against the new API).
- `cd tugrust && cargo nextest run` passes with zero warnings (`-D warnings` policy).

#### Scope {#scope}

1. Crate rename `tugmark-core` → `tugchanges-core` across the `tugrust` workspace,
   `tugutil`'s `mark.rs` module, and CLAUDE.md.
2. `tugchanges-core`: join inversion, buckets, foreign-session ledger query, typed
   commit refusal, receipt `left_behind`, `-uall` status universe.
3. `tugutil` CLI (`changes.rs` née `mark.rs`, `cli.rs`): new flags, exit code 3,
   bucket-aware plain and JSON output.
4. `tugcast`: turn-scoped fallback bracket (`feeds/agent_bridge.rs`,
   `feeds/attribution.rs`), `-uall` in `snapshot_worktree`, and the
   `feeds/changeset.rs::run_changeset_commit` call-site update for the new commit API.
5. `tugplug/skills/commit/SKILL.md`: bucket disposition protocol.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Renaming the deck's `tugdeck/crates/tugmark-wasm` — that crate is the **markdown**
  lexer/parser (mark = markdown, pulldown-cmark), unrelated to git; it keeps its name,
  as do historical plan docs (`dash/tugmark-bringup.md`) and `tuglaws/wasm-crates.md`.
- Shell-route (`$` commands) attribution — deliberately withdrawn previously; the join
  inversion makes shell-route edits *visible* (as `unattributed`), which is the
  correctness requirement. Bracketing the shell backend is a possible follow-on.
- Replay-time reconstruction of Bash deltas — impossible by design ([P06] in
  `feeds/attribution.rs` docs: no fingerprint is reconstructable after the fact). The
  inversion makes it unnecessary for commit correctness.
- A "shared" flag for paths touched by this session *and* another (sequential, not
  overlapping) — the existing `ambiguous` flag covers time-overlap; sequential sharing
  stays an `attributed` row.
- Changes to `tugutil changes` — its wire contract (labeled "Spec S01" in the legacy
  tugmark-bringup plan, cited by the `changes.rs` code comments; distinct from this
  plan's Spec S01) is untouched; it remains the session-scoped attribution view, and
  buckets surface via `context` (see [Q01]).
- `tugutil dash commit` (tugdash-core) hardening — separate code path, follow-on (see [Q02]).
- Changeset card UI changes in tugdeck — `origin='turn'` rows flow through the existing
  pipeline; a rendering audit task is included, but no new UI.

#### Dependencies / Prerequisites {#dependencies}

- `tugrust` workspace builds clean on `main` (`-D warnings` enforced by
  `tugrust/.cargo/config.toml`).
- Rebuilt binaries land via the existing `~/.local/bin` symlinks into
  `target/debug` — no install step.

#### Constraints {#constraints}

- **Warnings are errors** across the workspace.
- tugchanges-core opens `sessions.db` **read-only** (`SQLITE_OPEN_READ_ONLY`,
  WAL-safe); the ledger is tugcast's to own — the foreign-session query must stay
  read-only.
- The `context --json` envelope (`{schema_version, command, status, data, issues}` via
  `tugutil/src/output.rs::print_ok`) must stay backward compatible: new fields are
  additive; `files` keeps its current meaning (attributed rows). The envelope's
  `command` strings (`"mark changes"`, `"mark context"`, …) have no known consumer
  (the card receives receipts via tugcast's changeset feed, not the CLI envelope) and
  become the bare verbs in Step 1.
- Attribution in the relay loop must never gate wire delivery — every new branch in
  `agent_bridge.rs` is best-effort (log and forward), matching the existing intercepts.
- The `file_events` primary key `(tug_session_id, tool_use_id, file_path)` with
  `ON CONFLICT DO NOTHING` is the idempotency contract — turn rows must mint unique
  `tool_use_id`s.

#### Assumptions {#assumptions}

- The stream-json `tool_use` frame for Bash is emitted before command execution, but
  the pipe drain plus `git status` latency means the pre-snapshot can complete *after*
  a fast command finishes — the race is real (this is capture gap G2).
- `turn_complete` frames arrive exactly once per live turn (replayed ones are
  bracketed by `replay_started`/`replay_complete` and are skipped).
- APFS mtime granularity (nanoseconds) is fine for the fingerprint's mtime axis.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows `tuglaws/devise-skeleton.md` v4: explicit `{#anchor}` headings,
`[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##`, `Table T##`,
`Risk R##`, `**Depends on:** #step-N` lines, and `**References:**` lines citing
labels/anchors (never line numbers).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should `tugutil changes` also expose the buckets? (DEFERRED) {#q01-changes-buckets}

**Question:** `changes` keeps its event-log-scoped meaning under this plan; should it
grow `unattributed`/`foreign` too?

**Why it matters:** Consumers of `changes` (scripts, the deck) might want the full
picture without calling `context`.

**Resolution:** DEFERRED. `context` is the commit skill's single command and the only
surface where missing files caused harm. Extending `changes` is additive later; doing
it now churns the legacy wire contract without a driving consumer.

#### [Q02] Does `tugutil dash commit` share the hole? (DEFERRED) {#q02-dash-commit}

**Question:** The dash commit path (tugdash-core, used by `implement`/`dash` on dash
worktrees) selects files by its own rules — does it also silently narrow?

**Why it matters:** Dash worktrees are where autonomous recipes commit.

**Resolution:** DEFERRED to a follow-on audit. Dash commits operate on an isolated
worktree where the session is the only writer, so the blast radius differs. Note the
distinction: Step 1 **mechanically** edits tugdash-core (the crate rename reaches its
`Cargo.toml` + `src/ops.rs`, which call `append_trailers` since commit `bce77a4`), but
none of this plan's **behavioral** changes — the join inversion, buckets, refusal, or
turn bracket — touch tugdash-core's own file-selection logic. Auditing *that* logic for
the same silent-narrowing hole is the deferred work.

#### [Q03] Do we need a replay-gap diagnostic marker? (DECIDED — unnecessary) {#q03-replay-gap-marker}

**Question:** Should tugcast record "this session replayed N Bash calls that could not
be bracketed" so `context` can warn that the ledger is known-incomplete?

**Resolution:** DECIDED unnecessary. A replayed Bash call usually already has its rows
from the original live pass, so a naive count cries wolf; and with [P01] any genuinely
missing file surfaces as `unattributed` regardless. No marker.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Unattributed noise from user inflight edits makes every commit a two-step | med | high | `--leave-unattributed` one-flag acknowledgment; skill guidance | users complain about friction |
| Turn rows attribute a *user's* mid-turn editor save to the session | low | med | rows are advisory + visible in diff review; `ambiguous` still marks cross-session overlap | misattributed Changeset entries reported |
| Receipt/context consumers break on new JSON fields | med | low | additive fields only; audit deck receipt renderer (Step 5 task) | deck render error |
| `-uall` status cost on huge untracked trees (e.g. `node_modules` not ignored) | low | low | repos here gitignore heavy dirs; status is already run per call today | measurable context latency |
| Crate rename leaves a dangling reference (Cargo path, `use`, doc table) | low | low | `-D warnings` + workspace build catches Rust-side misses; the Step 1 checkpoint greps the tree | any post-Step-1 `tugmark` hit in `tugrust/` |

**Risk R01: Two sessions on one checkout drown each other in `foreign`** {#r01-foreign-noise}

- **Risk:** With two live sessions editing one repo, each session's `context` lists the
  other's files as `foreign` on every run.
- **Mitigation:** `foreign` never blocks a commit and is excluded from every default
  set; it exists to explain *why* a dirty file isn't yours. The skill reports it in one
  line.
- **Residual risk:** A path both sessions touched stays `attributed` for both — the
  existing `ambiguous` flag covers the overlapping-bracket case; sequential co-editing
  remains a judgment call for the agent reading the diff.

---

### Design Decisions {#design-decisions}

#### [P01] git status is ground truth; the ledger annotates, never filters (DECIDED) {#p01-status-is-truth}

**Decision:** `resolve_changes` enumerates the working tree (`git status
--porcelain=v2 --untracked-files=all`) as the universe and classifies every dirty file;
it never drops a dirty file because the ledger lacks a row.

**Rationale:**
- Every historical miss (perl bulk pass, git mv sweep) was a capture gap turned into a
  silent commit-set narrowing by the `events ∩ status` join direction.
- Capture is best-effort by construction ([#capture-gap-inventory]); reads must not
  treat it as authoritative.

**Implications:**
- `ResolvedChanges` (`tugchanges-core/src/changes.rs`) grows `unattributed` and
  `foreign` vectors alongside the existing `files` (attributed).
- The exit-2 session-resolution contract is unchanged: no session id / no ledger /
  unknown session still error before any bucketing (the gap being fixed is a
  *resolvable* session with missing rows).
- `changes()` keeps returning only the attributed set — its legacy wire contract does
  not change ([Q01]).

#### [P02] Three buckets: attributed / foreign / unattributed (DECIDED) {#p02-three-buckets}

**Decision:** Each dirty path is classified: rows for this session → `attributed`
(today's `Change` shape, unchanged); rows only from other sessions → `foreign`; no rows
anywhere → `unattributed`.

**Rationale:**
- The three dispositions demand different handling: yours / someone else's / unknown.
- `foreign` prevents the multi-session checkout case from dumping another session's
  work into this session's "unknown" pile.

**Implications:**
- New read-only ledger query: sessions that touched a given repo-relative path
  (see Spec S02 for the canonicalization rule).
- `ContextReport` gains `unattributed: Vec<Change>` and `foreign: Vec<ForeignChange>`
  (Spec S01), both diffed like `files`.

#### [P03] `commit` refuses silent narrowing — exit 3 (DECIDED) {#p03-commit-refusal}

**Decision:** With no explicit disposition (`--paths`, `--include-unattributed`,
`--leave-unattributed`, or `--tree`), a `commit` that finds unattributed dirty files
fails with **exit code 3**, listing them, committing nothing.

**Rationale:**
- The skill always runs `context` first and can always pass a flag, so the refusal is a
  speed bump, not a wall — but it makes a half-commit impossible even for a lazy agent.
- Exit 3 is distinct from 1 (real error) and 2 (session resolution) so callers can
  branch on it.

**Implications:**
- `commit()` returns a typed `CommitError` (replacing `Result<_, String>`) so the CLI
  maps refusal → 3 without string sniffing.
- An empty attributed set with unattributed files present is a refusal, not
  today's "no files selected" error.
- `foreign` files never block and are never auto-included; `ambiguous` handling is
  unchanged (`--all` includes them).
- tugcast's `feeds/changeset.rs::run_changeset_commit` (the Session card's commit
  button) calls `commit()` with an explicit `paths` set, which bypasses bucketing —
  behavior unchanged, but the call site must adopt the new `CommitOptions` fields and
  map `CommitError` back to its `String` error.

#### [P04] `--tree` is the full-working-tree disposition (DECIDED) {#p04-tree-flag}

**Decision:** `commit --tree` commits `attributed ∪ unattributed ∪ ambiguous` — the
whole dirty tree except `foreign`-claimed paths.

**Rationale:**
- Replaces the skill's "commit everything" flow of hand-gathering `git status` output
  into `--paths` (which is exactly the manual fallback that was needed when `context`
  under-reported — the tool should own it).
- Excluding `foreign` by default keeps one session from committing another live
  session's inflight work; `--paths` remains the explicit override.

**Implications:**
- Precedence: `--paths` > `--tree` > (`--include-unattributed` / `--leave-unattributed`
  / `--all`) — see Table T01.

#### [P05] Turn-scoped fallback bracket, `origin='turn'` (DECIDED) {#p05-turn-bracket}

**Decision:** The relay opens a working-tree bracket when it forwards a `user_message`
to tugcode stdin and closes it on the turn's (non-replayed) `turn_complete`; any delta
path not already recorded by an exact or per-call-Bash row during that turn becomes a
`file_events` row with `tool_name='Turn'`, `origin='turn'`. Cross-session ambiguity
marking follows the existing registry rule, **accepting the ambiguity inflation this
implies** (see the trade below).

**Rationale:**
- Closes capture gaps G2 (pre-snapshot races a fast command) and G3 (bracket lost to a
  relay crash mid-Bash but not mid-turn): the turn's pre-snapshot happens seconds
  before the model can emit any command, and the post-snapshot happens after all tool
  results.
- Two `git status` runs per turn — negligible cost.

**The ambiguity-inflation trade (DECIDED: accept):** `BracketRegistry::open` cross-marks
`ambiguous` on *any* other session's bracket open on the same repo root, and `ambiguous`
rows are excluded from the default commit set ([D112]). Today that fires only when two
sessions' **Bash calls** overlap — rare, seconds-wide windows. A turn bracket is open for
the **whole turn** (including idle stretches while the model is thinking and writing
nothing), so with two live sessions on one checkout, nearly every Bash and turn row on
both sides will be marked `ambiguous`. This cuts **both** ways and we accept it on net:
- **More correct:** today a session's *exact-tool* edits made during another session's
  open Bash bracket escape the overlap check entirely (exact rows aren't registry
  brackets); a turn bracket that spans those edits finally flags the genuine contention.
- **Over-broad:** it also flags turns that overlap only in *wall-clock idle*, where no
  files were being written concurrently — a false "uncertain owner."
- **Why accept rather than narrow:** these repos are overwhelmingly single-writer per
  checkout, so the inflation is near-zero in practice; and the failure mode is *safe* —
  an over-`ambiguous` row is merely excluded from the one-click default and surfaced for
  the agent/user to include via `--paths`/`--all` (never a wrong auto-commit). Narrowing
  the rule (e.g. cross-mark only against another side's *per-call* bracket or a turn with
  already-recorded writes) is a possible follow-on if multi-session checkouts become
  common; it is **out of scope here** to avoid perturbing the [D112] overlap semantics
  mid-plan.

**Implications:**
- Reuses `BracketRegistry` (`feeds/attribution.rs`) so cross-*session* overlap marks
  turn rows `ambiguous` exactly like per-call brackets (same-session per-call brackets
  inside the turn never mark it — the registry only cross-marks different sessions).
- Extends [D112]'s attribution doctrine — which today enumerates only Bash bracketing and
  the `exact`/`bash`/`replay` origins — with a new `origin='turn'` / `tool_name='Turn'`
  point-of-change source. Still point-of-change (a bracket window, just turn-wide), still
  upsert-idempotent, still never gating delivery. The global [D112] entry is amended to
  record this ([#documentation-plan], Step 6).
- The relay tracks a `turn_recorded_paths: HashSet<String>` (repo-relative), inserted
  on every successful `record_file_event`, cleared at turn close — the dedup filter.
- Turn rows mint `tool_use_id = "turn:<opened_at_millis>"` to satisfy the
  `(session, tool_use_id, file_path)` PK. A same-millisecond turn reopen would collide
  and `ON CONFLICT DO NOTHING`-drop its rows; append a monotonic per-relay counter
  (`turn:<millis>:<n>`) if that edge ever matters — negligible in practice.
- A second `user_message` arriving before `turn_complete` (queued sends) does **not**
  reopen — the wider window still brackets everything.
- Replay never opens a turn bracket (user messages don't replay through `input_rx`);
  crash mid-turn is swept by the existing `sweep_session` — residual gap covered by [P01].

#### [P06] Status universes use `--untracked-files=all` (DECIDED) {#p06-untracked-all}

**Decision:** Both `tugchanges-core`'s status call (`changes.rs::status_output`) and
tugcast's `snapshot_worktree` (`feeds/attribution.rs`) pass `--untracked-files=all`.

**Rationale:**
- Plain porcelain output collapses a fully-untracked directory to `? dir/`; a
  `file_events` row for `dir/file.rs` then matches nothing in the status map and the
  file drops from the changeset today — a third silent-miss shape, independent of
  bracketing.
- In `snapshot_worktree`, a new file inside an existing untracked directory doesn't
  change the `dir/` status line, so bracket deltas miss it too (or record the directory
  path, which downstream joins can't use).

**Implications:**
- Bracket fingerprints get more entries per snapshot; the delta algorithm is unchanged.

#### [P07] Receipt carries `left_behind` (DECIDED) {#p07-left-behind}

**Decision:** After committing, `commit` re-runs the bucketed status and the
`CommitReceipt` gains `left_behind: {unattributed: [...], foreign: [...], ambiguous: [...]}`
listing still-dirty paths per bucket.

**Rationale:**
- A partial commit becomes visible in the receipt itself, immediately — not two
  sessions later.

**Implications:**
- Additive JSON field; the Session card's receipt renderer must tolerate it (audit
  task in Step 5). `run_changeset_commit` callers take `.sha`/`.numstat` off the
  receipt and are unaffected.

#### [P08] The crate rename: tugmark-core → tugchanges-core (DECIDED) {#p08-crate-rename}

**Two distinct things are named "tugmark" in this repo. Exactly one is renamed.**
The name is overloaded, and the whole point of this decision is to end that overload
on the git side *without touching the markdown side*:

| "tugmark" thing | What it is | Where it lives | This plan |
|---|---|---|---|
| `tugmark-core` (crate) + `tugmark` (retired CLI name) | git **changes & commits** library — `changes`/`context`/`commit`/`log`/`diff` | `tugrust/crates/tugmark-core/` (Rust backend) | **RENAMED → `tugchanges-core`** |
| `tugmark-wasm` (crate) | **markdown** lexer/parser (pulldown-cmark; "mark" = markdown) | `tugdeck/crates/tugmark-wasm/` (browser frontend) | **KEPT — never touched** |

The two live in **separate directory trees** — `tugrust/` (backend) vs `tugdeck/`
(frontend) — and nothing in `tugrust/` references the markdown crate (verified: a
`tugmark-wasm`/`tugmark_wasm` grep over `tugrust/` returns zero hits). That directory
boundary is what makes a `tugrust/`-scoped search a complete and *safe* verification:
it sweeps every git-side occurrence and *cannot* reach the markdown crate. Conversely,
`tugdeck/`'s many `tugmark`/`tugmark_wasm` hits (the markdown crate, its `pkg/` build
output, and every `tug-markdown-view` / `parse-markdown` importer) are all the crate
that KEEPS its name and are out of scope — see [#non-goals].

**Decision:** The library crate `tugrust/crates/tugmark-core` is renamed
`tugchanges-core` (package, directory, workspace member, all dependents), and `tugutil`'s
`src/mark.rs` module becomes `src/changes.rs` with envelope `command` strings reduced
to the bare verbs (`"changes"`, `"context"`, `"commit"`, `"log"`, `"diff"`). The
markdown crate `tugdeck/crates/tugmark-wasm` is **explicitly left alone**.

**Rationale:**
- The `tugmark` CLI was retired when tugutil/tugdash/tugmark were unified into the
  single `tug` CLI (commit `b122bb09b`) and renamed `tugutil`; the crate is the last
  live use of the withdrawn name.
- "tugmark" already means something else in this repo (the markdown lexer above). One
  spelling, two meanings — the git-side one yields; the markdown one is the older,
  self-descriptive owner of "mark" and stays.
- `tugchanges-core` names the flagship verb surface (owner's choice over
  `tuggit-core`/`tugcommit-core`).

**Implications:**
- **The completeness gate is `git grep`, not the file list below.** After the rename,
  `git grep -n tugmark -- tugrust/` must return **zero hits**, and
  `cd tugrust && cargo build` must pass under `-D warnings` (a stale `tugmark_core::`
  path won't compile). Use `git grep` (tracked files only) — a plain
  `grep -rn tugmark tugrust/` also matches regenerated build artifacts under
  `tugrust/target/` and will never read clean. These two checks are authoritative;
  the enumeration below is a **map to start from**, not the definition of "done".
- Git-side rename surface (tracked files, current as of the trailer feature landing in
  commit `bce77a4`):
  - `tugrust/Cargo.toml` — workspace `members` entry + the `tugmark-core = { path … }`
    workspace dep.
  - `tugrust/crates/tugmark-core/` — directory (`git mv`) + its `Cargo.toml` package
    name; internal `src/{lib.rs,trailer.rs,changes.rs,commit.rs,context.rs,git.rs,ledger.rs}`
    need no path edits (same-crate `mod`/`pub use`), but `lib.rs`'s doc comment names
    "the `tugmark` CLI" and should update.
  - `tugrust/crates/tugutil/` — `Cargo.toml` dep; `src/{mark.rs,main.rs,cli.rs}`
    (`tugmark_core::` paths + the `mark` → `changes` module rename); `tests/mark_cli.rs`
    → `tests/changes_cli.rs`.
  - `tugrust/crates/tugcast/` — `Cargo.toml` dep; `src/feeds/{changeset.rs,git.rs}`
    **and `src/feeds/agent_supervisor.rs`** (`tugmark_core::append_trailers`, from the
    trailer feature).
  - `tugrust/crates/tugdash-core/` — `Cargo.toml` dep **and `src/ops.rs`**
    (`tugmark_core::append_trailers`, from the trailer feature).
  - `tugrust/Cargo.lock` — the `tugmark-core` package name + every dependent's dep line
    (regenerated by `cargo build`; commit the churn).
  - CLAUDE.md's repository-structure table (the one non-`tugrust/` doc edit).
- **Not** renamed (KEEP): `tugdeck/crates/tugmark-wasm` and every `tugdeck/` markdown
  importer, `tuglaws/wasm-crates.md`, and historical `dash/` plans
  (`tugmark-bringup.md` et al.). None of these live under `tugrust/`, so the `git grep`
  gate never flags them.
- The envelope `command` strings have no known consumer (checked: nothing in
  `tugdeck/src` or the skills reads them; the card's receipt arrives via tugcast's
  changeset feed) — safe to change alongside.

---

### Deep Dives {#deep-dives}

#### Capture gap inventory {#capture-gap-inventory}

The known ways a session-made change ends up with no `file_events` row today:

- **G1 — Replay never brackets Bash.** `agent_bridge.rs` opens a Bash bracket only when
  `!in_replay`; after a tugcast restart or Maker ▸ Reload, exact tools backfill
  (`origin='replay'`) but historical Bash deltas are unreconstructable. Most likely
  cause of both real incidents. *Not fixable at capture; covered by [P01].*
- **G2 — Pre-snapshot races the command.** The bracket's pre-snapshot starts when the
  relay drains the `tool_use` frame, but Claude Code executes the command regardless;
  a fast `perl -i` can finish before `git status` (hundreds of ms on this repo)
  returns, so the changes land in *pre*, pre == post, zero rows. *Covered by [P05].*
- **G3 — Relay crash mid-Bash.** `sweep_session` drops open brackets on teardown.
  *Mid-turn crash residual; mid-Bash-within-a-live-turn covered by [P05].*
- **G4 — Shell route.** `$` commands never traverse the relay's tool frames.
  *Visible as `unattributed` under [P01]; bracketing the shell backend is a non-goal.*
- **G5 — Untracked-directory collapse.** A row exists but the status map has only
  `? dir/`, so the join drops it. *Fixed by [P06] — this one is a pure read-side bug.*

#### Current data flow (what the plan changes) {#current-data-flow}

Write path: `agent_bridge.rs::relay_session_io` intercepts `tool_use`/`tool_result`
frames → exact rows via `PendingCalls` / Bash rows via `BracketRegistry` +
`snapshot_worktree` → `SessionLedger::record_file_event` upserts into `file_events`
(`session_ledger.rs`; PK `(tug_session_id, tool_use_id, file_path)`, `ON CONFLICT DO
NOTHING`; `file_path` stored repo-relative in canonical space, legacy rows may be
absolute).

Read path (crate named `tugmark-core` until Step 1 lands): `ledger.rs` opens
`sessions.db` read-only (`resolve_sessions_db_path` mirrors tugcast's default path;
per-instance via `TUG_INSTANCE_ID`) → `changes.rs::resolve_changes` queries this
session's events, joins against `git status --porcelain=v2` (via
`git::parse_status_porcelain_v2(...).v1_status_map()`), drops non-dirty paths →
`context.rs::context` attaches diffs (untracked files get a synthesized add-diff via
`git diff --no-index -- /dev/null <path>`) → `commit.rs::commit` stages by construction
(`git add -- <files>` then `git commit -m <msg> -- <files>`), excluding `ambiguous`
unless `--all`. CLI shell: `tugutil/src/mark.rs` (exit mapping in `AppError`), argument
surface in `tugutil/src/cli.rs`, JSON envelope in `tugutil/src/output.rs`.

Second library consumer: tugcast's `feeds/changeset.rs::run_changeset_commit` (the
Session card's commit button) calls the library `commit()` via `spawn_blocking` with an
explicit `paths` set; `feeds/git.rs` delegates porcelain-v2 parsing to the library's
`parse_status_porcelain_v2`.

#### Turn bracket protocol {#turn-bracket-protocol}

Hook points in `agent_bridge.rs::relay_session_io`:

1. **Open** — in the `input_rx` branch, when `parse_user_message_text` identifies a
   `user_message`: after the stdin write, if no turn bracket is already open for this
   session, resolve the repo root (`ensure_repo_root` cache), take
   `snapshot_worktree(&root)`, and `bracket_registry.open(...)` with
   `tool_use_id = "turn:<now_millis>"`. Hold the id in a relay-local
   `open_turn: Option<String>`.
2. **Accumulate** — every successful `record_file_event` in the relay (exact and
   per-call Bash arms) also inserts the row's `file_path` into
   `turn_recorded_paths: HashSet<String>`.
3. **Close** — where the relay handles a **non-replayed** `turn_complete` frame: take
   `open_turn`, `bracket_registry.close_by_tool_use(session, id)`, post-snapshot,
   `into_delta_rows(...)`, filter out paths present in `turn_recorded_paths`, emit the
   surviving rows with `tool_name="Turn"` / `origin="turn"`, record them, bump
   `changeset_bumper`, clear the set.
4. **Teardown** — `sweep_session` already drops abandoned brackets; clear
   `open_turn`/`turn_recorded_paths` with it.

`OpenBracket::into_delta_rows` currently hardcodes `tool_name: "Bash"` /
`origin: "bash"`; either parameterize it or rewrite the fields on the returned rows —
parameterizing is cleaner (Step 6).

---

### Specification {#specification}

**Spec S01: `context --json` data shape (additive)** {#s01-context-schema}

```jsonc
{
  "session": "…", "project": "…", "repo_root": "…",
  "branch": "main", "head": "abc1234",
  "files": [ /* attributed, unchanged shape: {path, op, origin, ambiguous, git_status, diff} */ ],
  "unattributed": [
    { "path": "tugdeck/src/foo.ts", "op": "unknown", "origin": "none",
      "ambiguous": false, "git_status": " M", "diff": "…" }
  ],
  "foreign": [
    { "path": "tugrust/crates/x/src/lib.rs", "git_status": " M",
      "sessions": ["<other tug_session_id>", "…"], "diff": "…" }
  ],
  "recent_commits": [ { "sha": "…", "subject": "…" } ]
}
```

- `unattributed` reuses `Change` with sentinel `op: "unknown"`, `origin: "none"`.
- `foreign` is a new `ForeignChange` struct; `sessions` lists the claiming
  `tug_session_id`s.
- Plain (non-JSON) `context` prints the buckets as separate labeled sections.

**Spec S02: foreign-session ledger query** {#s02-foreign-query}

Read-only, in `tugchanges-core/src/ledger.rs`:
`SELECT DISTINCT tug_session_id, project_dir FROM file_events WHERE file_path = ?1 AND
tug_session_id != ?2`. A hit counts as foreign only when its `project_dir` resolves to
the same repo: compare `std::fs::canonicalize` of the row's `project_dir` against the
canonicalized `repo_root` (tolerating either failing → not foreign). Legacy rows whose
`file_path` is absolute are ignored by this query (repo-relative rows are the norm
since the capture-time projection landed; the query is advisory classification, and an
absolute-path miss degrades to `unattributed` — visible, never silent).

**Table T01: `commit` disposition matrix** {#t01-disposition-matrix}

| Invocation | File set committed | Unattributed present → |
|---|---|---|
| (default) | attributed, non-ambiguous | **exit 3, refusal, nothing committed** |
| `--leave-unattributed` | attributed, non-ambiguous | proceed; receipt `left_behind` lists them |
| `--include-unattributed` | attributed ∪ unattributed, non-ambiguous | included |
| `--all` | + ambiguous (composable with the two flags above) | per flags above |
| `--tree` | attributed ∪ unattributed ∪ ambiguous (everything but foreign) | included |
| `--paths <p…>` | exactly the given paths (existing behavior, overrides all) | caller's call |

`foreign` paths are never included except via explicit `--paths`, and never block.

**Spec S03: `CommitError` and exit codes** {#s03-commit-error}

`tugchanges_core::commit` returns `Result<CommitReceipt, CommitError>` where
`CommitError::UnattributedPresent { paths: Vec<String> }` maps to exit **3** in
`tugutil/src/changes.rs` (new `AppError::Exit3` variant; stderr lists the paths and
names the disposition flags) and `CommitError::Other(String)` maps to exit 1 as today.
Exit codes: 0 success · 1 error · 2 session resolution (unchanged) · 3 refusal.
tugcast's `run_changeset_commit` maps any `CommitError` to its existing `String` error
(its explicit-`paths` call can never hit the refusal variant).

**Spec S04: receipt `left_behind`** {#s04-left-behind}

`CommitReceipt` gains
`left_behind: { unattributed: Vec<String>, foreign: Vec<String>, ambiguous: Vec<String> }`
computed by re-running the bucketed status after the commit lands. Empty vectors when
clean. Additive to the `--json` envelope.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

None — renames and in-place changes only.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `tugchanges-core` | crate (rename) | `tugrust/crates/tugchanges-core/` | née `tugmark-core` ([P08]) |
| `tugutil::changes` | module (rename) | `tugutil/src/changes.rs` | née `src/mark.rs`; bare-verb envelope strings |
| `ResolvedChanges` | struct (modify) | `tugchanges-core/src/changes.rs` | + `unattributed: Vec<Change>`, `foreign: Vec<ForeignChange>` |
| `ForeignChange` | struct (new) | `tugchanges-core/src/changes.rs` | `{path, git_status, sessions, diff}` (Spec S01) |
| `compute_changes` | fn (rewrite) | `tugchanges-core/src/changes.rs` | join inversion ([P01], [P02]) |
| `status_output` | fn (modify) | `tugchanges-core/src/changes.rs` | + `--untracked-files=all` ([P06]) |
| `sessions_for_path` | fn (new) | `tugchanges-core/src/ledger.rs` | Spec S02 query |
| `ContextReport` | struct (modify) | `tugchanges-core/src/context.rs` | + `unattributed`, `foreign` |
| `CommitError` | enum (new) | `tugchanges-core/src/commit.rs` | Spec S03 |
| `CommitOptions` | struct (modify) | `tugchanges-core/src/commit.rs` | + `include_unattributed`, `leave_unattributed`, `tree` |
| `derive_file_set` | fn (rewrite) | `tugchanges-core/src/commit.rs` | Table T01 |
| `CommitReceipt` | struct (modify) | `tugchanges-core/src/commit.rs` | + `left_behind` (Spec S04) |
| `AppError::Exit3` | variant (new) | `tugutil/src/changes.rs` | refusal mapping |
| `run_commit` / `run_context` | fn (modify) | `tugutil/src/changes.rs` | flags + bucket output |
| commit/context clap defs | args (modify) | `tugutil/src/cli.rs` | new flags |
| `run_changeset_commit` | fn (modify) | `tugcast/src/feeds/changeset.rs` | new `CommitOptions` fields; `CommitError` → `String` |
| `OpenBracket::into_delta_rows` | fn (modify) | `tugcast/src/feeds/attribution.rs` | parameterize `tool_name`/`origin` ([P05]) |
| `snapshot_worktree` | fn (modify) | `tugcast/src/feeds/attribution.rs` | + `-uall` ([P06]) |
| turn-bracket state | relay locals | `tugcast/src/feeds/agent_bridge.rs` | `open_turn`, `turn_recorded_paths` ([#turn-bracket-protocol]) |

---

### Documentation Plan {#documentation-plan}

- [ ] CLAUDE.md repository-structure table: `tugmark-core` → `tugchanges-core` (Step 1).
- [ ] `tuglaws/design-decisions.md` **[D112]**: add the `origin='turn'` turn-scoped
      bracket as a second bracketing source + the ambiguity-inflation trade (Step 6, [P05]).
- [ ] Rewrite `tugplug/skills/commit/SKILL.md` for the bucket protocol (Step 7).
- [ ] Module docs in `changes.rs`/`commit.rs` updated to state the inverted-join
      invariant ("a dirty file is never invisible").

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | bucket classification, disposition matrix, delta filtering | tugchanges-core, attribution.rs |
| **Integration** | CLI exit codes + JSON shapes against a real temp repo + seeded `sessions.db` | `tugutil/tests/changes_cli.rs` (existing `mark_cli.rs` harness, renamed in Step 1) |
| **End-to-end (relay)** | turn bracket over a real repo through `drive_relay` | `agent_bridge.rs` tests (pattern: `attribution_brackets_a_real_bash_edit_end_to_end`) |

#### What stays out of tests {#test-non-goals}

- App-tests of the commit flow — changeset entries in the app-test replay workspace
  live only ~2s; the Rust round-trip layer is the sanctioned coverage point for this
  surface.
- Mocked git or mocked ledger — all tests run real `git` in temp repos and real sqlite
  files, per the repo's real-code-paths policy.
- Deck rendering of new receipt fields — additive JSON verified by a tolerance audit,
  not a render test.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Rename tugmark-core → tugchanges-core | done | a96b02b2d |
| #step-2 | Foreign-session ledger query | done | 8677c601a (folded into #step-3) |
| #step-3 | Invert the changes join; buckets in context | done | 8677c601a |
| #step-4 | Commit disposition contract + receipt left_behind | done | 5d77ede58 |
| #step-5 | CLI flags, exit 3, bucket output | done | e4f7eec27 |
| #step-6 | tugcast: -uall snapshots + turn bracket | done | 6371ce8e1 |
| #step-7 | Commit skill rewrite | done | c6e349b4e |
| #step-8 | Integration checkpoint | done | verification only |

#### Step 1: Rename tugmark-core → tugchanges-core {#step-1}

**Commit:** `tugutil(commit-fixes): rename tugmark-core crate to tugchanges-core`

**References:** [P08] crate rename, (#context, #non-goals)

**Scope reminder ([P08]):** this renames the **git changes & commits** crate only.
The **markdown** crate `tugdeck/crates/tugmark-wasm` (and every `tugdeck/` markdown
importer) KEEPS the `tugmark` name — it is a different crate in a different tree. Every
edit in this step is under `tugrust/`; if a task would touch a file outside `tugrust/`
(other than the one CLAUDE.md table row), stop — it is out of scope.

**Artifacts:**
- `tugrust/crates/tugchanges-core/` (directory + package rename); updated
  `tugrust/Cargo.toml` members + workspace dep; updated dependents
  (`tugutil`, `tugcast`, `tugdash-core`); `tugutil/src/changes.rs` (née `mark.rs`);
  `tugutil/tests/changes_cli.rs` (née `mark_cli.rs`); regenerated `tugrust/Cargo.lock`;
  CLAUDE.md table row.

**Tasks:**
- [ ] `git mv tugrust/crates/tugmark-core tugrust/crates/tugchanges-core`; package
      `name = "tugchanges-core"`; workspace `members` + `tugchanges-core = { path = … }`
      in `tugrust/Cargo.toml`. Update `lib.rs`'s doc comment that names "the `tugmark`
      CLI".
- [ ] Rewrite every `tugmark_core::` path → `tugchanges_core::` and every
      `tugmark-core` dep line → `tugchanges-core` across **all dependents** — the
      complete tracked set (per the [P08] rename-surface map; confirm with the grep
      gate, don't trust this list blindly): `tugutil/Cargo.toml` +
      `src/{mark.rs,main.rs,cli.rs}`; `tugcast/Cargo.toml` +
      `src/feeds/{changeset.rs,git.rs,agent_supervisor.rs}`; `tugdash-core/Cargo.toml`
      + `src/ops.rs`. (`agent_supervisor.rs` and `tugdash-core` are the trailer-feature
      consumers added in `bce77a4` — easy to miss.)
- [ ] `git mv` `tugutil/src/mark.rs` → `src/changes.rs` (module `mark` → `changes` in
      `main.rs`/`cli.rs`); change envelope `command` strings to bare verbs
      (`"changes"`, `"context"`, `"commit"`, `"log"`, `"diff"`).
- [ ] `git mv` `tugutil/tests/mark_cli.rs` → `tests/changes_cli.rs`.
- [ ] CLAUDE.md repository-structure table: `tugmark-core` → `tugchanges-core` (the
      only edit outside `tugrust/`).
- [ ] Let `cargo build` regenerate `tugrust/Cargo.lock`; commit the lockfile churn.
- [ ] Do **NOT** touch `tugdeck/crates/tugmark-wasm` (the markdown crate) or any
      `tugdeck/` markdown file, `tuglaws/wasm-crates.md`, or historical `dash/`
      plans ([P08], [#non-goals]).

**Tests:**
- [ ] Existing suites pass unmodified apart from the renames (no behavior change) —
      including the trailer tests in `tugcast` (`agent_supervisor.rs`, `changeset.rs`)
      and `tugdash-core` (`ops.rs`) that call `append_trailers`.

**Checkpoint:**
- [ ] `cd tugrust && cargo build && cargo nextest run` (build fails on any missed
      `tugmark_core::` path under `-D warnings`)
- [ ] `git grep -n tugmark -- tugrust/` → **no hits** (tracked files only; a plain
      `grep -rn` would match regenerated `tugrust/target/` artifacts and never read
      clean — see [P08])
- [ ] `git grep -n tugmark -- tugdeck/crates/tugmark-wasm | head -1` → **still has
      hits** (a sanity check that the markdown crate was left intact, not swept)

---

#### Step 2: Foreign-session ledger query {#step-2}

**Depends on:** #step-1

**Commit:** `tugutil(commit-fixes): add cross-session path query to the ledger`

**References:** [P02] Three buckets, Spec S02, (#current-data-flow)

**Artifacts:**
- `sessions_for_path` in `tugchanges-core/src/ledger.rs` (read-only; returns
  `(tug_session_id, project_dir)` pairs for a repo-relative path, excluding the given
  session).

**Tasks:**
- [ ] Implement the Spec S02 query with the `project_dir`-canonicalization repo match
      as a small helper so `changes.rs` can call it per-path (batch with `IN` if
      per-path proves slow on real DBs — measure with the seeded-DB test).
- [ ] Keep `open_readonly` flags untouched (read-only contract).

**Tests:**
- [ ] Unit: seeded `sessions.db` (reuse `changes.rs::tests::seed_db` shape) — path with
      rows from two sessions returns only the other session; `project_dir` pointing at
      a different directory does not count as foreign.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core`

---

#### Step 3: Invert the changes join; buckets in context {#step-3}

**Depends on:** #step-2

**Commit:** `tugutil(commit-fixes): git status is the universe — bucket every dirty file`

**References:** [P01] status is truth, [P02] Three buckets, [P06] untracked-all,
[D112] point-of-change attribution (the read-side inversion is compatible — the ledger
stays the record, the read stops treating it as the gate), Spec S01, Spec S02,
(#capture-gap-inventory, #current-data-flow)

**Artifacts:**
- Rewritten `compute_changes` / `resolve_changes` (`tugchanges-core/src/changes.rs`):
  status map is the iteration universe; buckets per [P02]; `--untracked-files=all` in
  `status_output`.
- `ForeignChange`; `ContextReport` + plain `context` output carrying the buckets, all
  diffed (`file_diff` reused for both new buckets).

**Tasks:**
- [ ] Classify: dirty path with this session's event rows → `attributed` (preserving
      today's op/origin/ambiguous dedup semantics — latest event wins, ambiguity ORs);
      rows only elsewhere (Step 2 query) → `foreign`; no rows → `unattributed`
      (`op: "unknown"`, `origin: "none"`).
- [ ] Preserve exit-2 semantics exactly: `NoSessionId`/`NoLedger`/`UnknownSession`
      fire before bucketing; a known-empty session with a dirty tree yields empty
      `files` + populated `unattributed` (not an error).
- [ ] `changes()` keeps returning only `files` (legacy wire contract unchanged);
      `--all` keeps its keep-committed-rows meaning within the attributed bucket.
- [ ] Update `changes.rs`/`context.rs` module docs to state the invariant.

**Tests:**
- [ ] Unit: dirty file with zero rows → `unattributed` with git_status.
- [ ] Unit: file claimed only by another session → `foreign` with the session id.
- [ ] Unit: file with rows from both this and another session → `attributed`.
- [ ] Unit: new file inside a fully-untracked directory, event row present →
      `attributed` (proves [P06]/G5); without a row → `unattributed` listing the
      *file* path, not `dir/`.
- [ ] Unit: context attaches non-empty diffs to unattributed and foreign entries
      (add-diff path for `??`).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core`

---

#### Step 4: Commit disposition contract + receipt left_behind {#step-4}

**Depends on:** #step-3

**Commit:** `tugutil(commit-fixes): commit refuses silent narrowing; receipt lists leftovers`

**References:** [P03] refusal, [P04] --tree, [P07] left_behind, Table T01, Spec S03,
Spec S04

**Artifacts:**
- `CommitError` enum; `CommitOptions` flags; `derive_file_set` implementing Table T01;
  `CommitReceipt.left_behind`.
- Updated `tugcast/src/feeds/changeset.rs::run_changeset_commit` call site.

**Tasks:**
- [ ] Implement the disposition matrix exactly as Table T01, including: default +
      unattributed present → `CommitError::UnattributedPresent` (even when the
      attributed set is empty); `--paths` bypasses bucketing entirely (existing
      no-session path preserved).
- [ ] Compute `left_behind` post-commit by re-running the Step 3 bucketing and
      listing still-dirty paths per bucket.
- [ ] Keep staging-by-construction (`git add -- <files>`; never `git add .`).
- [ ] Update `run_changeset_commit` (tugcast) for the new `CommitOptions` fields and
      map `CommitError` → `String` (Spec S03) — its explicit-`paths` call can never
      hit the refusal, so card behavior is unchanged.

**Tests:**
- [ ] Unit/integration (temp repo + seeded db): default refusal carries the exact
      unattributed path list; nothing was committed (HEAD unchanged, tree still dirty).
- [ ] Each flag row of Table T01 commits exactly its set (assert via
      `git show --name-status`).
- [ ] `left_behind` names a held-back unattributed file and an ambiguous file
      under `--leave-unattributed`.
- [ ] `--tree` excludes a foreign-claimed path; `--paths` can still take it.
- [ ] Existing tugcast changeset tests still pass (card commit path unchanged).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core -p tugcast`

---

#### Step 5: CLI flags, exit 3, bucket output {#step-5}

**Depends on:** #step-4

**Commit:** `tugutil(commit-fixes): bucket-aware context/commit CLI with exit-3 refusal`

**References:** [P03] refusal, Spec S01, Spec S03, Spec S04, Table T01,
(#current-data-flow)

**Artifacts:**
- `tugutil/src/cli.rs`: `--include-unattributed`, `--leave-unattributed`, `--tree` on
  `commit`.
- `tugutil/src/changes.rs`: `AppError::Exit3`; refusal stderr message listing paths and
  the three disposition flags; plain `context` prints labeled `unattributed:` /
  `foreign:` sections; plain `commit` prints `left_behind` when non-empty.

**Tasks:**
- [ ] Wire flags through `run_commit` → `CommitOptions`; map
      `CommitError::UnattributedPresent` → exit 3.
- [ ] `context --json` / `commit --json` envelopes carry the new fields (additive via
      `print_ok`).
- [ ] Audit the Session card's commit-receipt renderer for tolerance of the new
      `left_behind` field (find the consumer of the receipt JSON in `tugdeck/src` —
      the skill doc names it as the card's receipt rendering) and of `context`'s new
      fields; fix any strict parsing.

**Tests:**
- [ ] Integration (`tugutil/tests/changes_cli.rs`, built-binary harness): dirty no-row
      file → `context --json` shows it under `unattributed` with a diff; default
      `commit` exits 3 naming it; `--include-unattributed` commits it;
      `--leave-unattributed` exits 0 with it in `left_behind`.
- [ ] Integration: `--tree` on a tree with attributed + unattributed + ambiguous
      commits all three sets.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil`
- [ ] `cd tugrust && cargo build` (warnings-as-errors clean)

---

#### Step 6: tugcast — `-uall` snapshots + turn-scoped fallback bracket {#step-6}

**Depends on:** #step-3

**Commit:** `tugcast(commit-fixes): turn-scoped fallback bracket; -uall fingerprints`

**References:** [P05] turn bracket, [P06] untracked-all, [D112] point-of-change
attribution (amended here with the `origin='turn'` source), (#turn-bracket-protocol,
#capture-gap-inventory)

**Artifacts:**
- `snapshot_worktree` runs `git status --porcelain=v2 --untracked-files=all`.
- Parameterized `OpenBracket::into_delta_rows(tool_name, origin, …)` (or field
  rewrite); turn open/accumulate/close wiring in `relay_session_io` per
  [#turn-bracket-protocol].
- Amended `tuglaws/design-decisions.md` [D112] entry (the `origin='turn'` source + the
  ambiguity trade).

**Tasks:**
- [ ] Open on `user_message` forward (after the stdin write, best-effort, never
      gating); skip when a turn bracket is already open; skip non-repo project dirs.
- [ ] Insert into `turn_recorded_paths` at both existing `record_file_event` sites
      (exact and per-call Bash arms).
- [ ] Close on non-replayed `turn_complete`: delta − recorded paths → rows with
      `tool_name="Turn"`, `origin="turn"`, `tool_use_id="turn:<opened_at_millis>"`;
      bump `changeset_bumper` when any row lands.
- [ ] Clear turn state in the same teardown path as `sweep_session`.
- [ ] Audit `origin`/`tool_name` consumers for the new values: `feeds/changeset.rs`,
      `feeds/changeset_all.rs`, the deck's changeset rendering (`sessions-section.tsx`
      `FileIdentity` renders an unknown origin as `"{op} · {origin}"`, so `'turn'` shows
      as "modified · turn" — no crash; decide whether that label is wanted), and
      tugchanges-core (which passes origin through opaquely) — confirm `'turn'` rows flow
      as ordinary advisory events.
- [ ] Amend the global **[D112]** entry in `tuglaws/design-decisions.md`: it currently
      says "only `Bash` needs working-tree fingerprint bracketing" and enumerates the
      `exact`/`bash`/`replay` origins. Add the turn-scoped fallback bracket
      (`origin='turn'`, snapshot on `user_message` / delta on `turn_complete`) as a
      second bracketing source, and note the ambiguity-inflation trade ([P05]). Keep the
      invariant text (point-of-change, upsert-idempotent, never gates delivery) — the
      extension honors all three.

**Tests:**
- [ ] Unit (`attribution.rs`): parameterized delta rows carry the given
      tool_name/origin; `-uall` snapshot lists a file inside an untracked directory
      as its own entry.
- [ ] End-to-end (`agent_bridge.rs`, modeled on
      `attribution_brackets_a_real_bash_edit_end_to_end`): send a `user_message`
      through `input_rx`, mutate a file in the temp repo with **no** surrounding
      Bash bracket (the G2 race simulation), emit `turn_complete` → exactly one
      `origin='turn'` row for the mutated path; a path already covered by an exact
      row in the same turn gets **no** turn row.
- [ ] End-to-end: replayed `turn_complete` (inside `replay_started`/`replay_complete`)
      opens/closes nothing.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 7: Commit skill rewrite {#step-7}

**Depends on:** #step-5

**Commit:** `tugplug(commit-fixes): commit skill disposes every bucket explicitly`

**References:** [P02] Three buckets, [P03] refusal, [P04] --tree, Table T01,
Spec S01, (#documentation-plan)

**Artifacts:**
- Updated `tugplug/skills/commit/SKILL.md`.

**Tasks:**
- [ ] Document the three buckets in the `tugutil context --json` shape and require a
      disposition for every `unattributed` file: include it (via
      `--include-unattributed` or `--paths`) when the diff shows it as this session's
      work, else `--leave-unattributed` and name it as inflight in the report.
- [ ] Replace the "commit everything" hand-gathered `--paths` flow with
      `tugutil commit --tree`.
- [ ] Document exit 3 as the refusal signal (re-run with a disposition flag, never
      fall back to raw git); keep the existing ambiguous-file guidance; keep the
      exit-2 fallback path.
- [ ] Note `foreign` files are another session's work — report, never include without
      an explicit user ask.

**Tests:**
- [ ] None (prose artifact); correctness is Step 8's live run.

**Checkpoint:**
- [ ] Skill text names every flag that exists in `tugutil commit --help` output and no
      flag that doesn't (`tugutil commit --help` after Step 5's build).

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria), Table T01, [P01], [P05], [P08]

**Tasks:**
- [ ] Full-workspace verification: `cd tugrust && cargo nextest run` and
      `cargo build` clean; `git grep -n tugmark -- tugrust/` still empty (the markdown
      crate under `tugdeck/` is untouched — [P08]).
- [ ] Live smoke inside a real Session-card session: run a Bash `perl -i` bulk edit
      over several files plus one `Write`-tool edit, then `tugutil context --json` —
      every touched file appears (attributed via bracket/turn rows or, at minimum,
      `unattributed`); default `tugutil commit` either commits the full set or exits 3
      naming the remainder — **no silent narrowing in any outcome**.

**Tests:**
- [ ] The Step 5 integration suite doubles as the aggregate regression net.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A commit tool chain where every dirty file in the working tree is
visible and explicitly disposed of on every `context`/`commit` run — capture gaps can
no longer produce a half-commit — with the git library crate carrying its
post-unification name.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `tugchanges-core` is the crate's name everywhere in `tugrust/` and CLAUDE.md
      (`git grep -n tugmark -- tugrust/` empty); the deck's **markdown** crate
      `tugdeck/crates/tugmark-wasm` is untouched (`git grep` there still has hits).
- [ ] `context` reports attributed / foreign / unattributed buckets, all diffed
      (changes_cli integration tests).
- [ ] Default `commit` cannot silently narrow: refusal exit 3 with the list, or a
      receipt whose `left_behind` names every leftover (integration tests).
- [ ] The G2 race and G5 untracked-directory misses are fixed at capture
      (tugcast tests); G1/G3/G4 misses are rendered harmless by the bucket surfacing
      (changes_cli tests).
- [ ] `tugplug` commit skill instructs the bucket protocol; live smoke (Step 8) shows
      a `perl -i` bulk pass fully accounted for.

**Acceptance tests:**
- [ ] `cd tugrust && cargo nextest run` (all crates, zero warnings)
- [ ] Step 8 live smoke transcript

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] `tugutil changes` bucket exposure ([Q01])
- [ ] `tugutil dash commit` audit for the same hole ([Q02])
- [ ] Shell-route (`$`) bracket reuse (G4 capture, currently visibility-only)

| Checkpoint | Verification |
|------------|--------------|
| Rename complete | `git grep -n tugmark -- tugrust/` empty (markdown crate under `tugdeck/` untouched); workspace builds |
| Buckets end-to-end | `changes_cli.rs` integration suite |
| Turn bracket | `agent_bridge.rs` end-to-end tests |
| No silent narrowing, live | Step 8 smoke in a real Session card |
