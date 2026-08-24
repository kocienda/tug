# Changesets

Replace the Git card stub — UI, tugcast middleware, and background git monitoring — with an
AI-powered system to track, understand, control, annotate, and commit changes to revision
control (git now; the design keeps the door open for other VCSs).

## The unifying idea: the changeset is a first-class noun

A **changeset** is a live, attributed set of file changes on a branch:
`{owner, base branch, files with per-file provenance, state}`. Two grades:

- **Inline changeset** — a session working directly on `main` (or any shared checkout).
  Owner = the session, following its resume lineage across restarts.
- **Dashed changeset** — a dash. Owner = the branch+worktree itself; sessions working in
  it contribute to it. A dash *is* a changeset that got its own room.

The working tree at any moment is the union of inline changesets from live sessions plus
an **unattributed remainder** (edits made by hand or outside any session), rendered
honestly rather than hidden.

## Settled decisions

- **Ownership model**: session lineage + dash. Inline changesets belong to a session
  (following resume lineage); a dash worktree is one changeset that sessions contribute
  to; unattributed remainder is its own bucket.
- **AI summaries / commit messages**: a headless sidecar tugcode session, fed the diff
  plus the owning session's turn prompts / dash-log. Never disturbs the working session.
- **Worktree home**: in-repo under a new name (e.g. `.tug/worktrees/<name>`), git-ignored.
  Retires `.tugtree/`. Same volume as the repo; relative paths keep working; migration
  from `.tugtree/` required.
- **Name**: `tugdash` — a dedicated, standalone tool just for worktrees. Dash leaves the
  tugutil grab bag entirely.
- **Build order**: attribution engine first (no UI), then the read-only changeset card,
  then card actions, then the dash overhaul.

## Pillar 1 — Attribution engine (tugcast, sessions.db)

The interception point already exists: every tool event flows tugcode → stdout → the
relay loop in `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` (~1200–1358), which
already intercepts `turn_complete` and `system_metadata` by type with the session ledger
handle in scope. `tool_use` frames pass through there today, untouched, with fully
assembled inputs (`file_path` for Write/Edit, `command` for Bash).

- New `file_events` table in `sessions.db`
  (`session_id, turn, tool_use_id, tool_name, file_path, op, at`).
- **Exact attribution** for Write/Edit/NotebookEdit: parse `input.file_path` from the
  `tool_use` frame; record on the paired *successful* `tool_result` (denied/errored calls
  never pollute the record).
- **Subagent tool calls are NOT a hole.** Foreground subagent events carry
  `parent_tool_use_id` in the stream; background agents' child tool calls are tailed from
  their out-of-band JSONL and re-emitted as the same child frames
  (`tugcode/src/subagent-tail.ts`). Every nested Write/Edit flows through the relay loop
  and gets exact attribution like a top-level call. Because the tailer re-streams from
  offset 0 on replay/reconnect, `file_events` inserts must be idempotent on
  `(session_id, tool_use_id)`.
- **Fingerprint bracketing** for the one true hole: opaque shell mutators —
  Bash running `sed`/`perl`/`python`/`git mv`/… — at any nesting depth (a subagent's Bash
  call is bracketed the same way, per call). Snapshot the working-tree fingerprint
  (`git status --porcelain=v2` capture) when a Bash tool call starts; snapshot again on
  its `tool_result`; attribute the delta to that call. Overlapping opaque windows from two
  sessions on the same checkout are recorded as *ambiguous*, never guessed.
- **Serve it back to the AI**: a tugcast HTTP surface (`/api/changesets/…`) or CLI query
  so the commit skill *asks* for its file list instead of reconstructing it from its own
  context. `git status` cross-check stays as a sanity layer. External-edit detection falls
  out for free: dirty file with no event row ⇒ unattributed.

## Pillar 2 — Promote dash to a top-level capability

Today a dash is a `tugdash/<name>` branch + worktree under `.tugtree/`, metadata in git
config, an append-only `dash-log.md` in the project state dir, implemented across
`tugutil-core/src/dash.rs` and `tugutil/src/commands/dash.rs`. Join is a hardcoded
`git merge --squash` with rigid preflights (base clean and checked out), string-matched
conflict detection that dead-ends into manual cleanup, a silently ignored auto-commit,
and non-atomic teardown.

- **`tugdash`** — lift dash out of the tugutil grab bag into a standalone tool just for
  worktrees: a `tugdash` binary + a `tugdash-core` crate shared with tugcast, so the card
  drives create/commit/join through the same code as the CLI. Retire `.tugtree/`
  (→ `.tug/worktrees/`).
- **Fix join**: strategy choice (squash / merge / rebase-then-ff); an
  **intersection-aware preflight** powered by attribution — if the base's dirty files are
  disjoint from the dash's changed files, join proceeds instead of demanding a pristine
  base; a **join preview** (dry-run merge shown before committing to it); and
  **AI-assisted conflict resolution** — on conflict, offer to spin a session in the
  worktree with the conflict set as its brief.
- Atomic teardown with a journal so a half-failed join is resumable, not a warning pile.

## Pillar 3 — The Changeset card

A workspace-scoped `CHANGESET` snapshot feed (FeedId `0x23`, beside GIT at `0x20`)
composing three sources tugcast already holds: git status, `file_events` attribution, and
the dash list. The card renders the working tree **grouped by owner** — one section per
live session, one per dash, plus "unattributed" — each file with status and provenance.

- **Event-driven freshness**: every intercepted `tool_result` that touched a file bumps
  the feed immediately; the 2s poll remains only as fallback for external edits.
- **Actions**: per-file and per-changeset diff (generalize `GIT_DIFF_QUERY` to take a
  pathspec); AI-generated summary and commit message (sidecar); **commit from the card**
  (a CONTROL verb that stages exactly the changeset's files and commits — the
  session-scoped `git add` the commit skill does by inference, done by construction);
  join/release for dashes with the preview flow. Commits produce the numstat receipt
  idiom the commit skill uses.
- The old git card retires; branch/ahead-behind/HEAD folds into the new card's header.

## Pillar 4 — Integration hygiene

- A `Vcs` trait in Rust with `GitBackend` as the first impl, so jj/sapling later is a
  backend, not a rewrite.
- End the hand-mirrored `GitStatus` TS types: changeset wire types get one authoritative
  definition (tugproto or codegen from Rust).

## Milestones

1. **Attribution engine** — `file_events` + fingerprint bracketing + query surface;
   rewire the commit skill to use it.
2. **Changeset feed + read-only card** — grouped multi-session view with diffs; replaces
   the git card visually.
3. **Card actions** — commit from card, sidecar summary/message.
4. **Dash overhaul** — core-crate extraction, rename + `.tug/worktrees/` migration, join
   engine, card-driven join.

## Open items

- Ambiguity policy details: how the card and commit paths present *ambiguous* file events.
- Whether the changeset feed should also cover live sessions in *other* projects on the
  same deck, or stay strictly per-workspace.
