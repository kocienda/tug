# Dashes stabilization and the tripwire boundary

Two dashes wedged unjoinable in one afternoon, the Lens Dashes section showed every dash twice, a deleted worktree haunted the aggregate feed as an open project for an hour, and an orphaned zero-round dash sat in the list with nothing that would ever clean it up. The investigation traced all of it to two independent defects and one design gap. This brief encompasses both the mechanical hardening and the redesign that removes the gap's whole class.

## What happened, and why

**The busy latch.** `holders_busy` — the bit that holds a ready dash's join until its sessions finish — derives from `agent_supervisor::busy_session_ids()`, which reads `!turn_active && open_jobs.is_empty()` per session. `parse_job_edge` (`agent_supervisor.rs`) opens an entry in `open_jobs` on every `task_started` frame and closes it only on `task_updated{completed|failed|killed}`. The repo's own pinned wire capture (`tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.173-jobs-spike/`) shows a `local_agent` job that closes by `task_notification` alone — no `task_updated` ever names it — and the deck already reads `task_notification` as terminal (`select-jobs.ts`) while tugcast does not. The deck also gates job-opens on the launching tool call (`isJobLaunch`); tugcast folds in every `task_started` unconditionally. `open_jobs` is cleared in exactly one other place: when the tugcode child dies. So one missed close wedges the session — and its dash — as busy forever. It happened twice in one day, to two ordinary card sessions. No tripwire involved.

**The duplication and the ghosts.** The aggregate CHANGESET_ALL feed composes the dash list once per open project (`compose_aggregate`, `changeset_all.rs`), but a dash list is a property of the *repo*: `dash_detail_entries_in` derives from `git worktree list`, which answers identically from a linked worktree and from the checkout it forked from. The tripwire work tier registers its dash worktree as an open project (`spawn_headless_session` → `registry.get_or_create`), so the moment a work-tier tripwire ran, every dash in the repo appeared twice in the Lens — with duplicate `TugListView` ids. A workspace refcount then leaked: the `tripwire-tugedit-doctor-7bc9e87e` registry entry outlived its closed sessions *and* its deleted directory by over an hour, until an app relaunch dissolved it. Separately, deleting a wire cascades its `trips` rows but not its dashes, and a firing that dies with the app leaves a `created` dash forever — the orphan the investigation ended by discarding.

**The design gap under both tripwire symptoms.** The work tier's session was built as a session that runs, not as a session whose output anyone receives. Its worktree is treated as if a person opened it (a registry project, an immediately visible dash), its anti-loop defense (`TUG_SESSION_ID` stripping) is entangled with its delivery path (it also severs the dash binding), and its cleanup is best-effort rather than an invariant.

## The tripwire boundary

One definition replaces the case analysis:

> **A tripwire observes the main branch's commit stream, period. Tiers differ in what they spend, never in what they see.**

The boundary events are exactly two: a **join landing on main**, and a **regular commit on main**. Dash rounds in progress are invisible to tripwires — their boundary is the moment the join lands.

Why the boundary is exactly there:

- **Durability.** `dash replay` rewrites round shas onto a moved base tip; a join can squash them; a discard deletes them. A tripwire anchored to a dash-round sha is anchored to an object that may be rewritten or gone before the run finishes. A main commit — join or regular — is the only immutable, durable object in the flow. The event key becomes a sha that cannot go stale, which is what the idempotent tripwire-dash naming already wants.
- **Finished work, not drafts.** A dash's rounds are rehearsal; the join is the performance. Six rounds arrive on main as one event, and the tripwire evaluates the integrated result once instead of firing on states the author never claimed were done. This aligns "what a tripwire may see" with the gate the system already enforces — `holders_busy` holds the join until the work is quiet — so the two notions of *finished* are defined at the same moment, once.
- **A human in every loop.** A work-tier tripwire's staged output is a dash, and joining is not its to do. Under this boundary, staged tripwire work re-enters the tripwire's field of view only when the user joins it. Machine-fires-machine cycles are structurally impossible — no `TUG_SESSION_ID` stripping required. The anti-loop defense and the delivery path disentangle: the loop is broken by the boundary, and the delivery question shrinks to "a staged dash appeared, here is why."
- **One watch point.** The engine no longer reasons about worktrees, dirty trees, branch topology, or whose session touched what. It watches main advance. For a join event, the joined dash's session lineage rides along as the history input to the brief.

In-flight concerns — the things a dirty-tree tripwire might have wanted — belong to the session itself: hooks and the PreToolUse gate already own that space.

## The work-tier invariants

**I1 — The workspace is invisible infrastructure.** The work tier's worktree registers no workspace entry, contributes no project to the aggregate, and shows no Dashes row while the run is live. The headless session gets file access without `get_or_create` on the worktree. The duplication bug becomes impossible by construction; the ghost-project bug loses its object.

**I2 — Exactly two exits: staged or gone.** The tripwire owns its worktree for the run's lifetime. A run that stages commits produces a dash that becomes visible *at that moment* — a normal handoff artifact, unbound, waiting for the user. Every other ending — green probe, empty run, timeout, crash, engine restart, wire deleted — discards it. Engine startup re-asserts the invariant: anything tripwire-owned and not staged is discarded. Deleting a wire discards its unstaged dashes along with its trips.

**I3 — The work tier acts only on the boundary sha.** Its worktree is cut *at the firing commit*, not at base tip (today's behavior, which can examine a tree that already differs from what fired the wire). Input is the sha plus the session history the event carries; the run is deterministic against an immutable tree.

## The mechanical hardening

These stand regardless of the redesign — the busy latch wedged two ordinary card sessions with no tripwire in sight.

**H1 — The busy latch cannot stick.** `parse_job_edge` closes on `task_notification` terminal statuses (`completed`/`failed`/`stopped`) in addition to `task_updated`, matching the deck's fixture-pinned reading. Each open job carries an opened-at stamp, and a reaper drops a job still open long after its turn ended with no progress frame since, with a `warn` — so whatever wire shape the fixtures have not captured yet, `holders_busy` degrades to *late*, never *forever*. Both edges trace under `dev::ledger`; both wedges ended in "cannot pin which frame was missed" because the fold is silent today.

**H2 — Dashes compose per repo.** `compose_aggregate` groups open projects by git common-dir and attaches the dash list once, to the base checkout's entry; a worktree project contributes its files, never a second copy of the repo's dashes. `dashRowsFromSnapshot` dedupes by `ownerId` as the belt to that suspender, so the Lens structurally cannot render duplicate rows. I1 removes the known producer of duplicates; H2 removes the class.

**H3 — Registry entries do not outlive their directories.** `compose_aggregate` skips, and warns on, an entry whose directory no longer exists; the registry sweeps such entries the way `join_board::sweep_workshops` already sweeps orphaned workshops. Defense in depth for whatever refcount imbalance produced the `7bc9e87e` ghost.

## What this brief does not take up

The delivery path — how a staged dash's story is told (the envelope parser, the hand-back into a card) — is a known open design from the same investigation. The boundary makes it smaller but does not settle it. It is deliberately out of scope here; nothing above depends on answering it first.
