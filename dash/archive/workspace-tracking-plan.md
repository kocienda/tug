# Workspace Tracking — All-Projects Aggregate Changeset

**Status: DECISIONS LOCKED (D1–D4 resolved below). This document is the `/devise` input for
milestone **M02A**, which is written into [`dash/changesets-plan.md`](changesets-plan.md)
(inserted between M02 and M03). No implementation until M02A's steps are written and a fresh
dash is created.**

M02 shipped a per-workspace, read-only Changeset card + feed; that card is structurally
**bootstrap-only** (it can only ever show the `--source-tree` project). **M02A** replaces it
with a single **account-global aggregate** card that shows *every open project at once*.

Process (per D3): land M02 to `main` as-is → write M02A into `changesets-plan.md` (the
`/devise` pass) → implement M02A on a new dash.

---

## 1. Problem (why the M02 card is bootstrap-only)

The CHANGESET feed (0x23) is delivered to clients **only for the bootstrap `--source-tree`
workspace** (`/u/src/tugtool`). Root cause, traced end to end:

- Per-project workspaces *do* register and *do* compute correct `ChangesetSnapshot`s (a
  `ChangesetFeed` spins up per `WorkspaceEntry`), but each publishes to a **per-workspace
  `watch::Receiver`**, and `main.rs` registers only the **bootstrap** entry's receiver into
  the router (`add_snapshot_watches`, `main.rs:995-1005` — only `bootstrap.changeset_watch_rx`).
- Per-session `WorkspaceEntry`s are created in `AgentSupervisor` and then **dropped**
  (`agent_supervisor.rs:2230-2231` `drop(workspace_entry)`, and the parallel site ~`:4671-4685`);
  only their `workspace_key` is kept. Their `changeset_watch_rx` dangles — frames computed,
  never routed.
- `FILETREE` avoids this by publishing to a **shared broadcast channel** every client
  subscribes to (`ft_response_tx` `main.rs:451`, handed into each `FileTreeFeed`
  `workspace_registry.rs:~212`, registered once via `add_broadcast_senders` `main.rs:1011`).
  CHANGESET (and the retired GIT feed before it) never adopted this. The old git card had the
  same limitation; nobody noticed because the bootstrap repo is always open.

The M02 card, opened from the menu, has no session binding, so its feed filter falls back to
`presentWorkspaceKey` (accepts any frame) — but the only CHANGESET frames on the wire are the
bootstrap's, so it shows only `/u/src/tugtool`.

---

## 2. Intent (user-decided)

- **One card, all projects.** A single Changeset card, aggregate view, grouped
  **project → owner → files**.
- **"All projects" = the open dev cards.** Discovery is *surveying the open dev cards*, not a
  ledger crawl and not historical projects. Server-side this set already exists as the
  **`WorkspaceRegistry` entries** (one per project with a live dev session, refcounted per
  card; the bootstrap `--source-tree` is always present). Cost is `O(open cards)`.
- **Non-repo projects still appear**, with an offer to `git init` the directory.
  `compose_snapshot()` today returns `None` and *skips* non-repo dirs; the aggregate instead
  surfaces them with an "Initialize git" affordance.
- **Clickable file links carry forward** (shipped in the M02 card): each present file path is
  an `open-file` link; deleted files render inert; absolute path = the project's root + the
  repo-relative path.

---

## 3. Design

### 3.1 Server — one account-global aggregate feed (D1: replaces the per-workspace feed)

- New feed **`FeedId::CHANGESET_ALL`** (propose `0x24` — free; confirm at impl time), a
  **process-level** feed, delivered the way `USAGE`/`PULSE` are (a single process-wide
  broadcast or one process-level snapshot watch that fans out to every deck), **not** the
  per-workspace watch that stranded the M02 frames.
- The feed holds `Arc<WorkspaceRegistry>` + `Arc<SessionLedger>`. On recompute it:
  1. enumerates the registry's **current entries** (add `WorkspaceRegistry::project_dirs()` /
     `entries()` — the `inner: Mutex<HashMap<WorkspaceKey, Arc<WorkspaceEntry>>>` already
     holds them; `find_entry_by_path` exists as a sibling);
  2. for each entry's `project_dir`, calls the existing `compose_snapshot(project_dir, ledger)`
     (`feeds/changeset.rs:172`) — a **repo** yields the normal per-project snapshot; a
     **non-repo** dir yields a `no_repo: true` element (empty changesets/unattributed);
  3. emits **one** `WorkspacesChangesetSnapshot { projects: [...] }` frame, diff-suppressed.
- **Recompute triggers:** a process-global `Arc<tokio::sync::Notify>` ("global bump") that
  `ChangesetBumper::bump` (`feeds/changeset.rs:64`) pings **in addition to** the per-workspace
  `Notify` (coalesced); plus a **slow poll backstop** for hand edits. The feed `select!`s on
  `{ global_notify, interval.tick(), cancel }`.
- **Cost:** ~2 `git` subprocesses per open project per recompute; gate each dir with the
  subprocess-free `is_within_git_worktree` first. Negligible at "handful of open cards" scale.

### 3.2 Wire types (Rust-authoritative, TS-mirrored, golden-guarded — the M02 Step-8 pattern)

```jsonc
WorkspacesChangesetSnapshot {
  "projects": [ ProjectChangeset ]
}
ProjectChangeset {
  "project_dir":   "…",        // absolute checkout root (also the link base)
  "display_name":  "…",        // basename of project_dir (or ledger/session name)
  "workspace_key": "…",
  "no_repo":       false,      // true → "Not a git repository" + Init affordance
  // …the existing ChangesetSnapshot fields when no_repo is false:
  "branch": "…", "ahead": 0, "behind": 0, "head_sha": "…", "head_message": "…",
  "changesets": [ ChangesetEntry ],      // reused from M02
  "unattributed": [ UnattributedFile ]   // reused from M02
}
```

`FeedId::CHANGESET_ALL` in `tugcast-core/src/protocol.rs` + `tugdeck/src/protocol.ts`; a
checked-in golden fixture deserialized by a Rust test **and** a bun test.

### 3.3 Client — account-global card

- The Changeset card becomes **account-global**: an app-level singleton store modeled on
  **`UsageStore`** (`new FeedStore(conn, [FeedId.CHANGESET_ALL])` with **no filter** —
  `usage-store.ts:87-89`), exposed via a context/hook like `useUsage`/`usePulse`
  (`pulse-store.ts:346/366`). It must **NOT** go through `useCardData` →
  `useCardWorkspaceKey`. `FeedStore` holds one value per feed id (`feed-store.ts:69/97-99`),
  which is why aggregation is **server-side**.
- Renders one **collapsible section per project** (project display name + branch/ahead-behind
  + HEAD subject), each containing the existing owner/unattributed rows, badges, live dots, and
  clickable links (each project carries its own root as the link base). Reuses the M02 card
  internals (`SectionTrigger`, `FileRow`, `FilePathLink`, status glyphs/badges).
- **Non-repo project** → a "Not a git repository" state with an **"Initialize git"** button.
  **Empty overall** → "No open projects" / "No projects with changes".

### 3.4 Actions — `git init` (D4: in M02A)

`git init` is a **write**, so it's a CONTROL verb: `changeset_git_init { project_dir }` → runs
`git init -b main` in `project_dir` → responds `ok`/`err`. Same request/response shape as the
planned `changeset_commit` verb (Spec S03 in the changesets plan). **Self-heals:** after
success the workspace's next recompute (global bump or poll) sees a repo and the section flips
to a clean/empty changeset. **Ships in M02A** alongside the Init button (not deferred to M03).

---

## 4. Decisions (LOCKED)

- **D1 — One feed.** **Replace** the per-workspace `ChangesetFeed` (0x23) with the single
  aggregate feed. Its only consumer was the M02 card, and `compose_snapshot` is already a pure
  function the aggregate calls per project. Remove the per-workspace `ChangesetFeed`
  construction + the 0x23 snapshot-watch registration + the per-entry `changeset_bump`; **keep**
  `compose_snapshot` as the building block; **0x23 stays reserved** (never reused).
- **D2 — Project set = registered workspaces.** The set is exactly the `WorkspaceRegistry`
  entries (projects with a live dev session + bootstrap). A project appears while a dev card is
  open on it and drops when its last card closes. No linger-while-dirty; no ledger crawl.
- **D3 — Land M02 first.** Merge M02 to `main` as-is (via `tugdash join`), then write M02A into
  `changesets-plan.md`, then implement M02A on a fresh dash.
- **D4 — `git init` in M02A.** The `changeset_git_init` verb and the Init button ship in this
  milestone, not deferred to M03.

---

## 5. Milestone M02A — step breakdown (for the `/devise` pass to formalize)

Inserted into `changesets-plan.md` between M02 (steps 8–12) and M03 (steps 13–16), as steps
`#step-12a … #step-12f` (letter-suffixed to avoid renumbering M03/M04). Each carries the
devise-skeleton fields (Depends on / Commit / References / Artifacts / Tasks / Tests /
Checkpoint) and a Step Status Ledger row.

1. **#step-12a — Aggregate wire types + golden fixture.** `WorkspacesChangesetSnapshot` /
   `ProjectChangeset` in `tugcast-core/types.rs`; TS mirror in `changeset-types.ts`;
   `FeedId::CHANGESET_ALL` both sides; golden fixture validated by a Rust test + a bun test.
   *(Depends: #step-8.)*
2. **#step-12b — Aggregate feed.** `CHANGESET_ALL` process-level feed composing
   `compose_snapshot` over the `WorkspaceRegistry` entries (add
   `WorkspaceRegistry::project_dirs()`); `no_repo` elements for non-repo dirs; process-level
   delivery (broadcast or one snapshot watch); global `Notify` bump (pinged by
   `ChangesetBumper`) + poll backstop. *(Depends: #step-12a, #step-9.)*
3. **#step-12c — Account-global card.** App-level store (UsageStore pattern) + context hook;
   per-project collapsible sections reusing the M02 card internals; non-repo "Initialize git"
   state (button inert until #step-12e); clickable links per project. Register from `main.tsx`.
   *(Depends: #step-12a, #step-12b.)*
4. **#step-12d — Retire the per-workspace path (D1).** Remove per-workspace `ChangesetFeed`
   construction + 0x23 watch registration + per-entry `changeset_bump`; keep `compose_snapshot`;
   0x23 reserved. *(Depends: #step-12c.)*
5. **#step-12e — `changeset_git_init` verb + wire the Init button (D4).** CONTROL verb
   `changeset_git_init { project_dir }` → `git init -b main` → ok/err; wire the Init button in
   the non-repo section; recompute self-heals. *(Depends: #step-12c.)*
6. **#step-12f — M02A integration checkpoint.** `cargo nextest run`; `bunx tsc --noEmit &&
   bunx vite build`; `just app-test` (aggregate card: two open projects incl. a non-repo one →
   sections + Init affordance + a real file open). *(Depends: #step-12c, #step-12d, #step-12e.)*

---

## 6. Test plan

- **Golden / contract:** the aggregate fixture parsed by Rust + bun (drift fails either side).
- **Rust integration:** the aggregate feed over two temp workspaces — one git repo with
  attributed dirt, one non-repo dir — asserts two `projects` elements, the `no_repo` flag, the
  right owner grouping, and that a bump recomputes without waiting for the poll.
- **App-test (real app):** open two dev cards on two scratch dirs (one `git init`ed with seeded
  dirt + ledger rows, one non-repo); the aggregate card shows both project sections; the
  non-repo one shows the Init affordance (and clicking it inits + the section flips); clicking a
  file opens it in a Text card. Extends `at0227` or a new `at02xx`.
- Banned as ever: no jsdom/RTL, no mock-store tests; the card is exercised in the real app on
  real content.

---

## 7. Carry-forward context — load-bearing anchors (verify before relying; code moves)

**Routing gap / delivery blueprint**
- Bootstrap-only registration: `tugcast/src/main.rs:995-1005` (`snapshot_watches` = bootstrap
  only), `add_snapshot_watches` def `router.rs:210`.
- Stranded per-session watches: `feeds/agent_supervisor.rs:2230-2231` (`drop(workspace_entry)`),
  parallel site ~`:4671-4685`.
- FILETREE shared-broadcast blueprint: `main.rs:451` (`ft_response_tx`), `workspace_registry.rs:~172`
  (ctor arg) / `~:212` (into `FileTreeFeed`), `main.rs:1011` (`add_broadcast_senders`).

**Account-global delivery precedents**
- USAGE: `main.rs:465` (`broadcast::channel`), `:604` (`send`), `:1011` (registered). PULSE:
  `main.rs:829-933` (`register_stream_feed`, one bridge per process, fans out to every deck).
- Client (no workspace filter): `UsageStore` `usage-store.ts:87-89` (`new FeedStore(conn,[id])`,
  no filter); `PulseStore` `pulse-store.ts:199/346/366` (`onFrame` + `useSyncExternalStore`).
- `FeedStore` one-value-per-id: `feed-store.ts:69` + `:97-99`. Avoid the filtered path
  `useCardData` → `useCardWorkspaceKey` (`hooks/use-card-*.ts`).

**Compose + git reuse**
- `compose_snapshot` `feeds/changeset.rs:172` (returns `None` for non-repo — change to a
  `no_repo` element for the aggregate). `is_within_git_worktree`/`fetch_git_status`/
  `parse_porcelain_v2` `feeds/git.rs:184/141/17` (all take `&Path`). `file_events_for_project`
  `session_ledger.rs:2069`.

**Registry enumeration + feed registration templates**
- Registry entries live in `WorkspaceRegistry.inner` (`workspace_registry.rs`); add
  `project_dirs()`/`entries()`; `find_entry_by_path` is the existing sibling.
- Process-level feed templates: `spawn_stats_feeds` `feeds/stats/mod.rs:51` (→ `Vec<watch::Receiver>`
  pushed at `main.rs:1000`); `defaults_feed` `feeds/defaults.rs:157` (→ `watch::Receiver` pushed
  `main.rs:1001-1003`); `spawn_snapshot_feed` `tugcast-core/src/feed.rs:99`.
- Ledger `Arc`: `main.rs:388-389`, already cloned into a process consumer at `main.rs:474`.

**Bump wiring**
- `ChangesetBumper::bump` `feeds/changeset.rs:64`; per-workspace `Notify`
  `workspace_registry.rs:214`; feed `select!` `feeds/changeset.rs:133-134`; fired from the
  attribution intercept `agent_bridge.rs:1487` and `:1515`.

**Clickable links (shipped in M02, reuse per-project)**
- `dispatchAction({action: TUG_ACTIONS.OPEN_FILE, path})` (`action-dispatch.ts:497-507` →
  `open-file-in-card.ts`); `ToolFileRef` focus discipline (`blocks/tool-file-ref.tsx`); absolute
  path = project root + `/` + repo-relative path; deleted files render inert.

---

## 8. Status of related work

- **M02 (steps 8–12) + clickable file links** are **done** and, per D3, are **landed to `main`
  via `tugdash join changesets-m02`** — this document rides that join and becomes the `/devise`
  input on `main`.
- **M02A** is written into `changesets-plan.md` by the `/devise` pass, then implemented on a
  fresh dash.
