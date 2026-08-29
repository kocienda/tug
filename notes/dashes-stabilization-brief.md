# Dashes stabilization

Two dashes wedged unjoinable in one afternoon, the Lens Dashes section showed every dash twice, and a project whose directory had been deleted went on contributing rows to the aggregate feed for an hour until an app relaunch dissolved it. Three independent defects, all of them in the dash surfaces themselves.

## What happened, and why

**The busy latch.** `holders_busy` — the bit that holds a ready dash's join until its sessions finish — derives from `agent_supervisor::busy_session_ids()`, which reads `!turn_active && open_jobs.is_empty()` per session. `parse_job_edge` (`tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`) opens an entry in `open_jobs` on every `task_started` frame and closes it only on `task_updated{completed|failed|killed}`. The repo's own pinned wire capture (`tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.173-jobs-spike/`) shows a `local_agent` job that closes by `task_notification` alone — no `task_updated` ever names it — and the deck already reads `task_notification` as terminal (`tugdeck/src/lib/code-session-store/select-jobs.ts`) while tugcast does not. The deck also gates job-opens on the launching tool call (`isJobLaunch`); tugcast folds in every `task_started` unconditionally. `open_jobs` is cleared in exactly one other place: `agent_bridge.rs`, when the tugcode child dies. So one missed close wedges the session — and its dash — as busy forever.

It happened twice in one day, to two ordinary card sessions, both of which had backgrounded app-test runs and `until grep VERDICT` watchers going.

**The duplication.** The aggregate CHANGESET_ALL feed composes the dash list once per open project (`compose_aggregate`, `tugrust/crates/tugcast/src/feeds/changeset_all.rs`), but a dash list is a property of the *repo*: `dash_detail_entries_in` derives from `git worktree list`, which answers identically from a linked worktree and from the checkout it forked from. Confirmed by hand — `tugutil dash list` run inside `.tug/worktrees/<dash>` prints the full repo-wide list. So any second open project on one repo doubles every dash row in the Lens, and hands `TugListView` duplicate ids while it does.

Three projects on this one repo were live at peak: two of its linked worktrees, and `/u/src/tugtool` — the symlink spelling of the base checkout. That last one is worth its own sentence, because it is a duplicate producer with nothing exotic behind it: an extra working directory naming the same repo by another path is enough.

**The ghost project.** A workspace refcount leaked, and a linked-worktree project entry outlived both its closed sessions and its deleted directory by over an hour. `WorkspaceRegistry::release` tears an entry down only when its refcount reaches zero, and nothing anywhere reconciles a registry entry against the filesystem. A project that no longer exists on disk kept contributing a full dash list to every frame.

## The fixes

**H1 — The busy latch cannot stick.** Three layers, because the first two are corrections and the third is the guarantee.

- `parse_job_edge` closes on `task_notification` terminal statuses (`completed`/`failed`/`stopped`) in addition to `task_updated`, matching the deck's fixture-pinned reading of the same wire.
- Gate the open the way the deck does, so tugcast stops tracking jobs the deck itself refuses to count.
- Stamp each open job with an opened-at time and reap: a job still open well after its turn ended, with no progress frame since, is dropped with a `warn`. Whatever wire shape the fixtures have not captured yet, `holders_busy` then degrades to *late*, never *forever*.

Both edges trace under `dev::ledger`. Both wedges this week ended in "cannot pin which frame was missed" because the fold is silent today, and that cost more investigation time than the fix will.

**H2 — Dashes compose per repo, not per project.** `compose_aggregate` groups the open projects by git common-dir and attaches the dash list once, to the base checkout's entry; any other project on that repo contributes its files and never a second copy of the repo's dashes. `dashRowsFromSnapshot` (`tugdeck/src/components/lens/sections/dashes-section.tsx`) dedupes by `ownerId` as the belt to that suspender, so the Lens structurally cannot render duplicate rows even if the frame ever carries them again.

This is the load-bearing fix. Several ordinary paths open a second project on one repo, and nothing in the composition guards against it — so the doubling is a standing condition, not a past incident.

**H3 — Registry entries do not outlive their directories.** `compose_aggregate` skips, and warns on, an entry whose directory no longer exists; the registry sweeps such entries the way `join_board::sweep_workshops` already sweeps orphaned workshops. This is what keeps H2's grouping honest when a refcount leaks again — and one will, because the paths that acquire them are not all under this brief.

## Scope

**In:** the three fixes above, their tests, and the tracing that makes the next occurrence diagnosable in minutes rather than hours.

**Out:** the paths that open projects in the first place. Deduplication is the composition's job, and the fixes above hold whatever gets opened; nothing here changes who opens what, and nothing here should need to.
