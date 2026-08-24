<!-- devise-skeleton v4 -->

## Canonical path identity — one gateway, capture-time repo-relative projection, and inode-backed reconciliation {#canonical-path-identity}

**Purpose:** End, permanently, the class of bug where the changeset attributes an edited file to **Unattributed** (or the wrong owner) because the same directory is spelled two different ways. Route every persisted/compared path through one cheap firmlink-aware gateway, project file edits to repo-relative **at capture time** in canonical space, and keep inode identity as a live-path reconciliation aid only.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-14 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The changeset reconciler (`tugcast::feeds::changeset::compose_snapshot`) joins a session's recorded file edits (`file_events` rows) against `git status` by **lexically** stripping the repo root off each recorded absolute `file_path`. When the recorded `file_path` and the recorded/registry `project_dir` are different *spellings* of the same directory, the strip fails and the file falls to **Unattributed** — even though the edit was recorded correctly.

Verified against live data (`~/Library/Application Support/Tug/instances/release-main/sessions.db`, session `ee31685b`, which really did edit `dash/lens-frame.md`):

- `file_events.file_path` = `/Users/kocienda/Mounts/u/src/tugtool/dash/lens-frame.md`
- `file_events.project_dir` = `/u/src/tugtool`
- `sessions.project_dir` = `/u/src/tugtool` (raw client spawn arg)
- `sessions.workspace_key` = `/Users/kocienda/Mounts/u/src/tugtool` (went through the resolver)

`/u` is a `synthetic.conf` symlink to `/System/Volumes/Data/Users/kocienda/Mounts/u`; `/Users/kocienda/Mounts/u` is the APFS-firmlink face of the same inode. So `/u/src/tugtool` and `/Users/kocienda/Mounts/u/src/tugtool` are the **same directory** (same `(st_dev, st_ino)`) with unequal path strings, and `realpath`/`std::fs::canonicalize` do **not** reconcile them (they diverge: `/u/…` → `/System/Volumes/Data/…`, `/Users/…` stays `/Users/…`). In `compose_snapshot`, `repo_root_for(project_dir)` returns `/u/src/tugtool` verbatim, `file_events_for_project("/u/src/tugtool")` finds the event, but `repo_relative("/u/src/tugtool", "/Users/…/dash/lens-frame.md")` calls `Path::strip_prefix`, fails (different prefix), and its `Err(_) => file_path.to_owned()` branch returns the full absolute path — which can never match git's repo-relative key `dash/lens-frame.md`. → Unattributed.

The root cause is **architectural discipline, not a missing syscall**. The project already has a firmlink-aware canonicalizer (`path_resolver::resolve_to_claude_form`) and an inode-identity helper (`get_identity` / `same_identity`); they are simply not applied as a single mandatory gateway, and the reconciler defers projection to query time and does it lexically.

#### Strategy {#strategy}

- **P1 — one canonical form, one gateway** ([#p01-one-gateway]): route every path that is persisted, keyed, or compared through a single firmlink-aware gateway that produces the user-visible `/Users/…` form (`resolve_to_claude_form`'s output). Enforce it in the type system with a `CanonicalPath` newtype constructible only by the gateway.
- **P2 — project to repo-relative once, at capture time** ([#p02-capture-time-projection]): flip attribution from "store absolute, project at query time" to "project at record time, store repo-relative." Both sides of the changeset join then speak git's native repo-relative language; no absolute paths, no cross-space `strip_prefix`, no firmlink exposure in the reconciler. Deleted/renamed files (no inode to stat) reconcile because both sides are repo-relative strings.
- **P3 — inode identity is a live-path aid, never durable storage** ([#p03-inode-reconciliation]): promote `same_identity` to a public `same_file(a, b)` used only where two **live** paths must be judged equal and their canonical strings disagree. Never persist `(dev, ino)`.
- **Cheap gateway** ([#p04-cheap-gateway]): compute the firmlink/symlink alias table **once at boot** (`/etc/synthetic.conf` + the data-volume firmlink) so the collapse is a pure string rewrite, and memoize resolved directories. This preserves the hard no-TCC-prompt-on-boot property of commit `0400ed0f7`.
- **No flag day** ([#p07-reconciler-bridge]): a reconciler bridge canonicalizes both sides through the cheap gateway at join time (or passes through already-relative values), so historical un-migrated rows reconcile during rollout with **zero** boot-time filesystem walk. An opportunistic lazy backfill converts legacy rows the first time compose touches their project.
- Sequence as four independently-green milestones: (A) gateway + newtype, (B) canonical project paths + capture-time file_path projection, (C) reconciler bridge + repo-relative join, (D) migration/backfill + firmlink-split regression tests.

#### Success Criteria (Measurable) {#success-criteria}

- The `ee31685b`-shaped scenario reconciles: a `file_events` row whose `file_path` (`/Users/…/dash/lens-frame.md`) and `project_dir` (`/u/src/tugtool`) are different spellings of one dir is attributed to its owning session, **not** Unattributed. (Golden regression test seeded from the live data shape — Step 5 / Step 7.)
- Two sessions that open one project via two different spellings both attribute under a single canonical bucket. (Multi-spelling test — Step 3.)
- A deleted or renamed file (repo-relative on both sides, no inode) reconciles correctly. (Test — Step 5.)
- The `0400ed0f7` property holds: rebind (`rebind_from_ledger`) performs **no** `std::fs::canonicalize`/`metadata` on historical project dirs; the boot-time alias table is built exactly once (O(1) filesystem access, independent of history depth). (Assertion + code review — Step 1 / Step 7.)
- `cd tugrust && cargo nextest run` is green and `cargo build` is warning-clean (`-D warnings`) at every step.

#### Scope {#scope}

1. `tugcast::path_resolver` — add `CanonicalPath` newtype, a cheap gateway (`canonicalize`) with a boot-time alias table + per-dir memoization, and a public `same_file` reconciliation primitive.
2. `tugcast::feeds::attribution` — capture-time repo-relative projection for both the exact-tool path (`PendingCall::into_row`) and the Bash-bracket path (`OpenBracket::into_delta_rows`), typed on `CanonicalPath`.
3. `tugcast::feeds::agent_bridge` — compute the canonical project_dir + canonical repo root once per session and thread them into the attribution write path.
4. `tugcast::feeds::changeset` — canonicalize the compose-time `project_dir` before `file_events_for_project`; replace the lexical `repo_relative` strip with the reconciler bridge (canonicalize-and-strip for legacy absolute rows, pass-through for repo-relative rows). `changeset_all` inherits the fix via `compose_snapshot`.
5. `tugcast::session_ledger` — canonicalize `file_events.project_dir` on write; the opportunistic lazy backfill of legacy rows; the migration/read-compat story.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Any tugdeck/frontend change. The changeset card (`changeset-card.tsx`) renders whatever the feed emits; this is a backend attribution-correctness fix. No State Zone Mapping.
- Switching the durable workspace key or `file_path` storage to `(dev, ino)` or NSURL/CFURL bookmark data — rejected: deleted-file + inode-reuse + non-durable `st_dev` (see [#p03-inode-reconciliation]). The canonical user-visible string + repo-relative covers every operation and matches Claude Code's own `~/.claude/projects/<encoded-cwd>` encoding.
- Canonicalizing `sessions.project_dir`. It is deliberately the **raw** typed path because `list_for_project_dir` matches the raw client input (the picker's "what sessions under this typed path?" query). Only `file_events.project_dir` and the attribution join are canonicalized. (See [#p05-sessions-project-dir-stays-raw].)
- Fixing `tugutil::commands::changes::repo_relative` (the identical lexical strip in the CLI). Out of scope; audited and noted as a follow-on ([#tugutil-changes-followon]). It survives the repo-relative switch transparently via its `Err(_) => file_path` fallback.
- Broad path-handling refactors at unrelated `std::fs::canonicalize` / `resolve_to_claude_form` call sites (`dev.rs`, `fs_read.rs`) beyond auditing them for the same anti-pattern.

#### Dependencies / Prerequisites {#dependencies}

- Existing primitives, reused not reinvented: `path_resolver::resolve_to_claude_form`, `path_resolver::get_identity`, `path_resolver::same_identity`, `feeds::workspace_registry::WorkspaceKey::from_canonical`.
- `feeds::attribution::repo_root_for` (the `.git` ancestor walk) and `feeds::attribution::snapshot_worktree`.
- `session_ledger::now_millis`, `session_ledger::FileEventRow`, `session_ledger::record_file_event`, `session_ledger::file_events_for_project`.

#### Constraints {#constraints}

- Rust workspace, warnings-are-errors (`tugrust/.cargo/config.toml`). `cargo build` warning-clean; `cargo nextest run` green per step.
- **Hard constraint:** preserve the `0400ed0f7` no-TCC-prompt-on-boot property. The gateway must not `stat`/`canonicalize` historical project dirs on boot. Rebind continues to use `WorkspaceKey::from_canonical` (no fs). Legacy-row reconciliation is query-time (bridge) + opportunistic lazy backfill, never a boot walk.
- Migration must be safe with no flag day: the reconciler bridge reconciles un-migrated rows during rollout.
- Tests reproduce the firmlink split without a real firmlink: a temp repo reached via both its real path and a **symlink** to it (the `/u` case), following the precedents in `changeset.rs` (`init_repo` canonicalizes) and `path_resolver.rs` (`synthetic_path_resolves_to_firmlink_collapsed_claude_form`). No mock-only tests where a real temp-repo test is possible.
- Artifact hygiene: no plan-step numbers in code, no rationale/backstory comments; comments state what the code does.

#### Assumptions {#assumptions}

- Claude Code reports exact-tool `file_path` values in the user-visible `/Users/…` (firmlink-collapsed) form (confirmed by the `ee31685b` live data). The gateway's alias table handles the firmlink-expanded form (`/System/Volumes/Data/…`) as a fallback for robustness.
- `file_events` is advisory: its rows cascade-delete with their `sessions` row and are re-emitted (`origin='replay'`) when a session resumes, so a bounded, self-healing loss on a schema-drift rebuild is acceptable but is **not** chosen here (we avoid it — see [#q01-file-path-storage]).
- Within one repo, a session's `project_dir` is at or under the repo root, so `repo_root_for(canonical_project_dir)` yields a canonical repo root that is a prefix of the canonical `file_path` (worktree caveat in [#worktree-attribution]).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does `file_events.file_path` become repo-relative in place, or via a new `repo_rel` column? (DECIDED) {#q01-file-path-storage}

**Question:** Store the repo-relative path by overwriting `file_path` in place, or add a new `repo_rel TEXT` column and keep `file_path` absolute?

**Why it matters:** `session_ledger::rebuild_table_if_schema_drifted` (the [DM08] delete-and-recreate guard) **drops the whole `file_events` table** on any *column-set* change. Adding a `repo_rel` column would therefore wipe all existing attribution on the first post-upgrade boot (self-healing only after each session re-runs/replays). Overwriting `file_path` in place is *not* a column-set change, so the guard does not fire and no data is lost.

**Options:**
- In place (overwrite `file_path` with the repo-relative string). No column drift, no drop, legacy rows convert lazily/by-bridge.
- New `repo_rel` column. Triggers the drop-and-rebuild guard → full `file_events` loss on upgrade.

**Resolution:** DECIDED — **repo-relative in place** (see [P02], [#p02-capture-time-projection]). `file_path` keeps its column and PK slot `(tug_session_id, tool_use_id, file_path)`; its *content* becomes repo-relative for new rows. Legacy absolute rows reconcile via the bridge ([#p07-reconciler-bridge]) and are opportunistically rewritten by the lazy backfill (Step 6). The PK stays unique (one repo-relative path per tool call).

#### [Q02] Does `project_dir` stay a column, or is it superseded by the canonical workspace key? (DECIDED) {#q02-project-dir-column}

**Question:** Keep `project_dir` on `file_events` / `sessions`, or replace it with the canonical `workspace_key` everywhere?

**Why it matters:** The picker's `list_for_project_dir` deliberately matches the **raw** typed path stored in `sessions.project_dir`; removing/canonicalizing it breaks that lookup. But the attribution join needs a *consistent* bucket key, and today the registry dedupes two spellings to one `WorkspaceEntry` while each session writes its own raw spelling — a latent miss.

**Resolution:** DECIDED — **`project_dir` stays a column in both tables, but the two are decoupled** (see [P05], [#p05-sessions-project-dir-stays-raw]). `sessions.project_dir` stays **raw** (picker contract). `file_events.project_dir` becomes **canonical** (attribution bucket), written via the gateway and queried via the gateway in compose. Nothing else reads `file_events.project_dir`, so the divergence is safe.

#### [Q03] Backfill trigger — lazy on read, or one-shot on boot? (DECIDED) {#q03-backfill-trigger}

**Question:** When do legacy absolute `file_events` rows get re-canonicalized and reprojected to repo-relative?

**Why it matters:** A one-shot boot backfill would `repo_root_for` (an fs touch of `<dir>/.git`) every distinct historical `project_dir` on startup — exactly the TCC-prompt regression `0400ed0f7` fled.

**Resolution:** DECIDED — **lazy, opportunistic, per-project at compose time** (see [P07], [#p07-reconciler-bridge], Step 6). Correctness never depends on the backfill (the bridge handles un-migrated rows at query time); the backfill is a cheap opportunistic rewrite that runs only for projects the user actually has open (compose already holds their `repo_root`). No boot walk, TCC property preserved.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Gateway reintroduces per-path fs touch on boot | high | low | Boot alias table + memoization; rebind untouched ([#p04-cheap-gateway]) | Any `canonicalize`/`metadata` on a historical dir during rebind |
| Legacy absolute rows silently stay unattributed during rollout | med | med | Reconciler bridge canonicalizes-and-strips legacy rows at query time ([#p07-reconciler-bridge]) | Post-deploy Unattributed rate does not drop |
| `file_events.project_dir` canonicalization misses events written raw pre-upgrade | med | med | Compose bridge also tries the raw `project_dir` scoping for legacy rows (dual-key read) until backfill converts them | Session events vanish after upgrade |
| Worktree-session file_events don't match base-repo `git status` | low | med | Documented as pre-existing/orthogonal; dash entries surface worktree edits ([#worktree-attribution]) | User reports dash files unattributed in base changeset |
| Backfill hits a PK conflict on transitional duplicate rows (legacy absolute + replay repo-relative) and aborts | med | high (resumed sessions) | Per-row collision-safe rewrite: DELETE-and-merge when the target PK exists, UPDATE otherwise ([#transitional-duplicate-rows], Step 6) | Any backfill constraint error in logs |

**Risk R01: Cheap gateway must not stat historical dirs on boot** {#r01-gateway-boot-cost}

- **Risk:** A naive gateway that calls `resolve_to_claude_form` (which calls `path.canonicalize()`) on every persisted path, or a boot backfill, statts historical dirs and trips a macOS TCC consent prompt.
- **Mitigation:** Alias table is built once from `synthetic.conf` + the data-volume firmlink (O(1)); resolution of an already-`/Users/…` path is a pure string check; per-dir results are memoized; rebind never calls the gateway; the backfill is lazy per open project.
- **Residual risk:** A brand-new distinct project dir reached via an *unknown* symlink (not in `synthetic.conf`) still takes one `canonicalize` on first resolve — acceptable (it is a live, user-initiated open, exactly when `get_or_create` already stats it).

**Risk R02: `file_events.project_dir` write/query skew** {#r02-project-dir-skew}

- **Risk:** New rows write canonical `project_dir`; compose must query canonical or it misses them. Old rows are raw; compose must still find them.
- **Mitigation:** Compose canonicalizes its iteration `project_dir` before `file_events_for_project`, and the read path (or a dual-key query) accepts both the canonical and the raw spelling until the lazy backfill converts legacy rows.
- **Residual risk:** Until backfill, a legacy row for a project opened via a *third* spelling could be missed — bounded, self-heals on next event/replay.

---

### Design Decisions {#design-decisions}

#### [P01] One canonical form, one gateway, enforced by a `CanonicalPath` newtype (DECIDED) {#p01-one-gateway}

**Decision:** Introduce `path_resolver::CanonicalPath` — a newtype wrapping the user-visible `/Users/…` canonical string, constructible **only** by the gateway (`CanonicalPath::from_raw(&Path)`), plus an adopt constructor `CanonicalPath::from_canonical(&str)` (no fs, for already-canonical persisted strings) and a `#[cfg(test)] from_test_str`. The attribution write path takes `&CanonicalPath` so an un-canonicalized path cannot be projected/stored by construction.

**Rationale:**
- Today only `workspace_key` goes through the resolver (`WorkspaceRegistry::get_or_create` → `PathResolver::watch_path` → `resolve_to_claude_form`); `project_dir` and `file_path` are stored raw. A forgotten canonicalize is a silent mis-join; a newtype makes it a compile error.
- Mirrors the existing `WorkspaceKey` shape (`from_canonical` no-fs adopt + `from_test_str`), so the pattern is familiar and the rebind path stays fs-free.

**Implications:**
- New public type + gateway function in `path_resolver`.
- `PendingCall::into_row` and `OpenBracket::into_delta_rows` change signatures to take `&CanonicalPath` for the project dir and repo root.
- `sessions.project_dir` is exempt by decision [P05]; `workspace_key` already canonical.

#### [P02] Project to repo-relative once, at capture time, in canonical space (DECIDED) {#p02-capture-time-projection}

**Decision:** The relay projects each edited file to a repo-relative path **when the event is recorded**, using the canonical repo root and the canonical `file_path`, and stores the repo-relative string in `file_events.file_path` (in place — [Q01]). The changeset join becomes `dirty.get(&repo_rel)` where `repo_rel` is read straight from the row — no `strip_prefix`, no firmlink exposure.

**Rationale:**
- The recorder has both the tool's `file_path` and the session's canonical repo root; strip once, store `dash/lens-frame.md`.
- Both sides of the join then speak git's native repo-relative language. Deleted/renamed files (no inode) reconcile because it is pure string comparison.
- Reverses the current design comment in `attribution.rs` (`file_path_for_tool` / `FileEventRow::file_path`): *"repo-relative projection happens at query time against `project_dir`."*

**Implications:**
- `attribution::file_path_for_tool` still extracts the absolute tool path; projection happens in `into_row` (given the repo root) rather than at query time.
- Bash-bracket rows (`OpenBracket::into_delta_rows`) already compute repo-relative internally in `snapshot_worktree` before rejoining to absolute — store the repo-relative form directly instead of `repo_root.join(rel)`.
- `FileEventRow::file_path` doc comment updated to "repo-relative path within `project_dir`'s repo".

#### [P03] Inode identity is a live-path reconciliation aid, never durable storage (DECIDED) {#p03-inode-reconciliation}

**Decision:** Promote `path_resolver::same_identity` to a public `same_file(a: &Path, b: &Path) -> bool` (and keep `get_identity` public) for use only where two **live** paths must be judged equal and their canonical strings disagree — legacy-row migration and defensive checks. Never persist `(dev, ino)`.

**Rationale:**
- `(st_dev, st_ino)` is ground truth for *live* files only; unusable for deleted/renamed paths; unsafe to persist (inode reuse; `st_dev` not durable across reboots/remounts on APFS).
- The durable key stays the canonical user-visible string — stable, human-legible, matches Claude Code's `~/.claude/projects/<encoded-cwd>` encoding.

**Implications:**
- Remove the `#[allow(dead_code)]` on `same_identity`; rename/re-export as `same_file`. The macOS-internal callers (`resolve_synthetic`, `resolve_apfs_firmlink`) keep using it.

#### [P04] The gateway is cheap: boot-time alias table + per-dir memoization (DECIDED) {#p04-cheap-gateway}

**Decision:** Build a firmlink/symlink **alias table** once at process boot from `/etc/synthetic.conf` (symlink entries) and the APFS data-volume firmlink (`/System/Volumes/Data → ` prefix strip), stored in a module-level `OnceLock`. `CanonicalPath::from_raw` first applies the alias table as a **pure string prefix rewrite** (longest match; synthetic entries then data-volume), and memoizes each distinct resolved directory (`raw input → CanonicalPath`) in a module-level `Mutex<HashMap>`. Only an unknown-symlink cold miss falls back to `resolve_to_claude_form`'s `canonicalize` (once, then cached).

**Rationale:**
- The `/System/Volumes/Data/… → /Users/…` collapse and the `/u/… → /Users/…` synthetic collapse are the entire firmlink problem, and both are prefix rewrites with zero per-path fs touch once the table exists.
- Memoization makes each distinct project dir resolve at most once per process.
- Preserves `0400ed0f7`: rebind adopts stored keys via `from_canonical` (no gateway call); the alias table costs one `synthetic.conf` read + one data-volume `stat` at boot, independent of history depth.

**Implications:**
- New `AliasTable` builder in `path_resolver` (reuses `resolve_synthetic`'s parse of `synthetic.conf` and `resolve_apfs_firmlink_str`).
- `resolve_to_claude_form` stays as the cold/fallback resolver; the gateway wraps it with the alias-table fast path + memo cache.

#### [P05] `sessions.project_dir` stays raw; only `file_events.project_dir` is canonicalized (DECIDED) {#p05-sessions-project-dir-stays-raw}

**Decision:** `record_spawn` keeps writing the **raw** typed `project_dir` to `sessions` (its `workspace_key` argument is already canonical). `file_events.project_dir` is written **canonical** (via the gateway) and compose queries it canonical.

**Rationale:**
- `list_for_project_dir` documents that the picker matches the raw typed path; canonicalizing `sessions.project_dir` would silently break it.
- Nothing except compose reads `file_events.project_dir`, so canonicalizing it is safe and it closes the multi-spelling dedup gap: two sessions opening one project via two spellings (deduped to one `WorkspaceEntry`) both land in one canonical `file_events` bucket.

**Implications:**
- `record_spawn` signature unchanged (project_dir stays raw); the `CanonicalPath` enforcement lands on the `file_events` write path, not `sessions`.
- Compose canonicalizes its iteration `project_dir` once (memoized gateway) before `file_events_for_project`.

#### [P06] `changeset_all` inherits the fix through `compose_snapshot` (DECIDED) {#p06-changeset-all-shared}

**Decision:** No separate join edit in `changeset_all.rs`; it calls `compose_snapshot` for every open repo project, so fixing `compose_snapshot` fixes the aggregate.

**Rationale:** Confirmed by reading `changeset_all::compose_aggregate` — its only per-project composition path is `compose_snapshot(&project_dir, ledger)`; the aggregate adds session-row joins (`apply_session_rows`) and non-repo handling but no path stripping.

**Implications:** The firmlink-split regression test can assert through either `compose_snapshot` (unit) or `compose_aggregate` (integration).

#### [P07] Reconciler bridge + lazy backfill, no flag day (DECIDED) {#p07-reconciler-bridge}

**Decision:** Replace the lexical `changeset::repo_relative(repo_root, file_path)` with a bridge that: (1) if `file_path` is already relative (no leading `/`), return it unchanged (the new capture-time form); (2) if absolute, canonicalize both `repo_root` and `file_path` through the gateway and `strip_prefix`; (3) on a residual mismatch, fall back to `same_file` on ancestor directories. A one-time **lazy** backfill (Step 6) rewrites legacy absolute rows to repo-relative the first time compose touches their project.

**Rationale:**
- Compose already computes `repo_root_for(project_dir)` and runs git, so the bridge adds no fs cost for the repo root.
- Handles both worlds with one function: new repo-relative rows pass through; legacy absolute rows get canonicalized-and-stripped — fixing the live bug at query time with no boot backfill.

**Implications:**
- `changeset::repo_relative` becomes the bridge; its `tugutil` twin is left alone ([#tugutil-changes-followon]).
- The bridge is the correctness guarantee; the backfill is a cleanup optimization gated on [Q03].

#### [P08] Canonical project_dir + repo root cached per session, re-probed while `None` (DECIDED) {#p08-per-session-repo-root}

**Decision:** `run_session_bridge` resolves the canonical `project_dir` (gateway) once per session, and caches the canonical `repo_root` (`repo_root_for` on the canonical dir) with **sticky-`Some` / re-probe-on-`None`** semantics: a resolved `Some(root)` is cached for the session's life, but while the cache holds `None`, each attribution event re-probes `repo_root_for` before recording. Both values thread into the attribution write path (`into_row`, `into_delta_rows`).

**Rationale:**
- The repo root, once found, is stable for a session's life; computing it per-event is wasteful and re-touches the fs.
- But a session opened on a **non-repo** dir can gain a repo mid-session — the changeset card ships an "Initialize git" affordance (`changeset_all.rs` module docs), and today's Bash path self-heals because it probes `repo_root_for` per Bash call. A frozen `None` would regress that: no brackets ever, exact rows stuck absolute. Re-probing only while `None` matches today's cost profile (only non-repo sessions pay).
- The exact-tool path currently records with no repo root at all — it needs one to project.

**Implications:**
- New cached locals in `run_session_bridge` (`canonical_project_dir: CanonicalPath`, `repo_root: Option<CanonicalPath>` with the re-probe-while-`None` rule).
- If `repo_root` is still `None` at record time, store the canonical absolute `file_path` (there is nothing to strip against) — compose treats it as unattributed against git, same as today.
- Exact rows written in the window before a mid-session `git init` is re-probed land canonical-absolute; the reconciler bridge ([P07]) strips them at join time. This is one of the reasons the bridge is a **permanent** component, not a rollout shim.

---

### Deep Dives {#deep-dives}

#### The firmlink split, end to end {#firmlink-split-walkthrough}

The three spellings of one directory on this machine:

- `/u/src/tugtool` — via the `synthetic.conf` symlink `/u`.
- `/System/Volumes/Data/Users/kocienda/Mounts/u/src/tugtool` — what `canonicalize`/`realpath` yields on the `/u` entry (firmlink-expanded).
- `/Users/kocienda/Mounts/u/src/tugtool` — the user-visible APFS-firmlink face; what `resolve_to_claude_form` produces and what Claude Code writes.

All three are the same `(st_dev, st_ino)`. The gateway collapses the first two to the third via the alias table:

- synthetic rewrite: `/u → /Users/kocienda/Mounts/u` (the `synthetic.conf` target `/System/Volumes/Data/Users/kocienda/Mounts/u`, then data-volume collapse).
- data-volume rewrite: `/System/Volumes/Data/<rest> → /<rest>` when `/<rest>` exists.

After [P02]+[P08], the relay stores `dash/lens-frame.md` (repo-relative). After [P07], compose reads it and does `dirty.get("dash/lens-frame.md")` → hits git's key → attributed.

#### The reconciler bridge decision table {#bridge-decision-table}

**List L01: `repo_relative` bridge cases** {#l01-bridge-cases}

| Input `file_path` | Source | Bridge action | Result |
|---|---|---|---|
| `dash/lens-frame.md` (relative) | new capture-time row | return as-is | joins directly |
| `/Users/…/dash/lens-frame.md` (absolute, matches canonical repo root) | legacy row, no firmlink split | canonicalize both, `strip_prefix` | `dash/lens-frame.md` |
| `/Users/…/dash/lens-frame.md` vs repo root `/u/src/tugtool` | legacy row, firmlink split | canonicalize repo root → `/Users/…`, `strip_prefix` | `dash/lens-frame.md` |
| absolute, still no prefix match after canonicalize | pathological | `same_file` ancestor walk, else return absolute (unattributed) | safe degrade |

#### Worktree-session attribution (orthogonal, noted) {#worktree-attribution}

Session `9ca56d5d` recorded `file_path` under `/Users/…/.tug/worktrees/lens-frame/…` against `project_dir /u/src/tugtool` (the base repo). After the fix, that projects to `.tug/worktrees/lens-frame/dash/lens-frame.md` — which the *base* repo's `git status` does not list (`.tug` is typically ignored / a separate checkout). So the file stays out of the base changeset's owned bucket, correctly: the edit lives in the worktree, and the dash entry (`dash_entries`, from `git diff base...branch`) surfaces it. The firmlink fix makes the projection *correct*; whether worktree file_events reconcile against base-repo status is a separate concern, out of scope here.

#### Audit of other canonicalize / strip sites {#canonicalize-audit}

- `tugcast::dev.rs` (`resolve_to_claude_form` use) — JSONL cwd filtering; already correct, no change.
- `tugcast::fs_read.rs` (`resolve_to_claude_form` use) — read-path canonicalization; already correct, no change.
- `session_ledger::encode_claude_project_name` (`resolve_to_claude_form`) — already routes through the resolver; good precedent, no change.
- `tugutil::commands::changes::repo_relative` ([#tugutil-changes-followon]) — the identical lexical strip. Out of scope; noted below.
- `feeds::draft_engine` — the dash-draft path does a lexical `strip_prefix(&key.project_dir)` on worktree paths, the same anti-pattern family. Drafts are keyed raw↔raw consistently (the engine reads `project.project_dir` off the aggregate snapshot, compose reads drafts with the same raw string), so it is not broken by this plan — but it should adopt the bridge/gateway in a follow-on ([#roadmap]).

#### `tugutil changes` follow-on {#tugutil-changes-followon}

`tugutil/src/commands/changes.rs` has its own `repo_relative(repo_root, file_path)` with the same `strip_prefix`/`Err(_) => file_path` shape, joined against `file_events_for_session`. After this plan stores repo-relative `file_path`, that CLI keeps working transparently: `strip_prefix(repo_root)` on an already-relative path fails and the fallback returns the relative path unchanged. A follow-on should delete the CLI's private `repo_relative` and share the tugcast bridge (or drop the strip entirely) once the ledger is fully repo-relative. Not required for phase close.

---

### Compatibility / Migration / Rollout {#rollout}

- **Compatibility policy:** no schema (column-set) change to `file_events` — ever, in this plan. The [DM08] guard (`session_ledger::rebuild_table_if_schema_drifted`) drops the whole table on any column-set drift; all changes here are *content* changes (canonical `project_dir`, repo-relative `file_path`) that the guard cannot see.
- **Transitional duplicate rows (replay before backfill)** {#transitional-duplicate-rows}: post-upgrade, a resumed session **replays** its history (`origin='replay'`), and the replayed event records a repo-relative `file_path` while the pre-upgrade row for the same `(tug_session_id, tool_use_id)` holds the absolute one. Different `file_path` strings → the PK `(tug_session_id, tool_use_id, file_path)` does not conflict → **one event, two rows**. This state is *by design* and benign at read time: the bridge ([P07]) projects the legacy absolute row to the same repo-relative key as the new row, and compose's `owner.files` fold (`BTreeMap` keyed by rel) merges them into one file entry. The lazy backfill (Step 6) then collapses the pair — with collision-safe write semantics, because a naive `UPDATE … SET file_path = <rel>` on the legacy row hits the replay row's PK and SQLite aborts the whole statement on first conflict.
- **Do not touch the PK.** The duplicate-pair state must not be "fixed" by widening or reshaping the primary key: any column-set change trips the [DM08] table drop and wipes all attribution on the next boot. The PK stays `(tug_session_id, tool_use_id, file_path)`; dedup is the backfill's job.
- **Rollback strategy:** every read path degrades, none break. Pre-upgrade code reading post-upgrade rows sees repo-relative `file_path` values whose `strip_prefix` fails into the `Err(_) => file_path` fallback — which returns the repo-relative string unchanged, i.e. the *correct* join key. Canonical `file_events.project_dir` values scope correctly for pre-upgrade compose only when the project was opened under its canonical spelling; otherwise those events are absent from that compose cycle (bounded, display-only, self-heals on re-upgrade).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `CanonicalPath` | struct (newtype) | `tugcast/src/path_resolver.rs` | `/Users/…` canonical string; private inner |
| `CanonicalPath::from_raw` | fn | `path_resolver.rs` | the gateway (alias table + memo + cold fallback) |
| `CanonicalPath::from_canonical` | fn | `path_resolver.rs` | adopt already-canonical string, no fs |
| `CanonicalPath::from_test_str` | fn (`#[cfg(test)]`) | `path_resolver.rs` | test constructor |
| `CanonicalPath::as_path` / `as_str` | fn | `path_resolver.rs` | read accessors |
| `AliasTable` | struct + `OnceLock` | `path_resolver.rs` | boot-built prefix rewrites |
| `same_file` | pub fn | `path_resolver.rs` | promoted from `same_identity` |
| `get_identity` | pub fn | `path_resolver.rs` | make public (reconciliation aid) |
| `PendingCall::into_row` | fn (sig change) | `feeds/attribution.rs` | takes `project_dir: &CanonicalPath`, `repo_root: Option<&CanonicalPath>`; stores repo-relative `file_path` |
| `OpenBracket::into_delta_rows` | fn (sig change) | `feeds/attribution.rs` | stores repo-relative `file_path` |
| `run_session_bridge` | fn (body) | `feeds/agent_bridge.rs` | cache canonical project_dir; repo root sticky-`Some`/re-probe-while-`None`; thread into writes |
| `compose_snapshot` | fn (body) | `feeds/changeset.rs` | canonicalize project_dir before `file_events_for_project` |
| `repo_relative` | fn (rewrite) | `feeds/changeset.rs` | becomes the bridge ([#l01-bridge-cases]) |
| `record_file_event` project_dir | write path | `session_ledger.rs` | canonical `project_dir` in via `FileEventRow` |
| `backfill_file_events_repo_relative` | fn (new) | `session_ledger.rs` | lazy, per-project, opportunistic (Step 6) |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Gateway rewrites, `same_file`, `repo_relative` bridge cases | alias-table logic, bridge decision table |
| **Integration (real temp repo + symlink)** | Firmlink split via a symlink standing in for `/u` | attribution reconciles to one repo-relative key |
| **Golden / Regression** | Seed a `file_events` row shaped like `ee31685b` | assert attributed, not Unattributed |
| **Drift / Property** | Rebind performs no fs canonicalize; alias table built once | `0400ed0f7` property |

#### What stays out of tests {#test-non-goals}

- No mock-store or fake-DOM tests — every case above has a real temp-repo/symlink realization.
- No test of `sessions.project_dir` canonicalization — it deliberately stays raw ([P05]).
- No real-firmlink test — a `symlink` temp-repo reproduces the split deterministically and portably (real firmlinks need root + reboot).

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Warnings are errors; run `cd tugrust && cargo nextest run` and `cargo build` each step.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Gateway: `CanonicalPath` + boot alias table + memoization | done | 813103113 |
| #step-2 | Promote `same_file` / `get_identity` reconciliation primitive | done | b755b7604 |
| #step-3 | Canonicalize `file_events.project_dir` (write + compose query) | done | 4dc9f169e |
| #step-4 | Capture-time repo-relative `file_path` projection | done | 66168699e |
| #step-5 | Reconciler bridge + firmlink-split regression tests | done | fa8e04579 |
| #step-6 | Lazy opportunistic backfill of legacy rows | done | 61856522f |
| #step-7 | Integration checkpoint (end-to-end split + no-TCC property) | done | 2be2aad5a |

#### Step 1: Gateway — `CanonicalPath` + boot alias table + memoization {#step-1}

**Commit:** `tugcast(path): CanonicalPath gateway with boot alias table + memo`

**References:** [P01] ([#p01-one-gateway]), [P04] ([#p04-cheap-gateway]), Risk R01 ([#r01-gateway-boot-cost]), (#firmlink-split-walkthrough)

**Artifacts:**
- `CanonicalPath` newtype + `from_raw` / `from_canonical` / `from_test_str` / `as_path` / `as_str` in `path_resolver.rs`.
- `AliasTable` (module-level `OnceLock`) built from `synthetic.conf` + data-volume firmlink; per-dir memo (`Mutex<HashMap<PathBuf, CanonicalPath>>`).

**Tasks:**
- [ ] Add `CanonicalPath` (private inner `Arc<str>` / `PathBuf`), gateway `from_raw` applying the alias table prefix rewrite first (pure string), memoizing, and cold-falling-back to `resolve_to_claude_form` only on an unknown-symlink miss.
- [ ] Add `AliasTable::build()` reusing the `synthetic.conf` parse (as in `resolve_synthetic`) and `resolve_apfs_firmlink_str`; store in `OnceLock`. Alias entries are identity-verified (`same_file`) **once at build**, so per-path rewrites need no re-verification.
- [ ] The alias table is macOS-only (`#[cfg(target_os = "macos")]`); on Linux, `from_raw` is memoized `resolve_to_claude_form` (whose `PathResolver` twin already handles bind mounts).
- [ ] Memoize **directories only** (project dirs, repo roots) — never per-file paths, which would grow the cache unboundedly under the bridge; file paths get the pure-string alias rewrite plus the cold fallback, no memo entry.
- [ ] `from_canonical` (no fs) and `#[cfg(test)] from_test_str` mirroring `WorkspaceKey`.

**Tests:**
- [ ] `gateway_collapses_symlink_alias_without_fs_after_warmup` — a temp repo reached via a symlink resolves to the same `CanonicalPath` as its real path; second call hits the memo.
- [ ] `gateway_rewrites_data_volume_prefix` — `/System/Volumes/Data/<existing> → /<existing>` string rewrite.
- [ ] `gateway_plain_directory_is_noop` — a plain tempdir resolves to its own canonical form (parity with `resolve_to_claude_form`).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast path_resolver`
- [ ] `cargo build` warning-clean

#### Step 2: Promote `same_file` / `get_identity` reconciliation primitive {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(path): public same_file / get_identity reconciliation aid`

**References:** [P03] ([#p03-inode-reconciliation])

**Artifacts:**
- `pub fn same_file(a, b) -> bool` (renamed from `same_identity`) and `pub fn get_identity(path)`; `#[allow(dead_code)]` removed.

**Tasks:**
- [ ] Rename `same_identity` → `same_file`, make `pub`; keep macOS-internal callers (`resolve_synthetic`, `resolve_apfs_firmlink`) compiling.
- [ ] Make `get_identity` `pub`.

**Tests:**
- [ ] `same_file_true_across_symlink` — real dir and a symlink to it are `same_file`.
- [ ] `same_file_false_for_distinct_dirs` and `false_for_deleted_path`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast path_resolver`
- [ ] `cargo build` warning-clean

#### Step 3: Canonicalize `file_events.project_dir` (write + compose query) {#step-3}

**Depends on:** #step-1

**Commit:** `tugcast(attr): canonicalize file_events.project_dir bucket key`

**References:** [P05] ([#p05-sessions-project-dir-stays-raw]), [P06] ([#p06-changeset-all-shared]), Risk R02 ([#r02-project-dir-skew]), [Q02] ([#q02-project-dir-column])

**Artifacts:**
- `run_session_bridge` computes `canonical_project_dir` once ([P08] partial) and writes it as `FileEventRow::project_dir`.
- `compose_snapshot` canonicalizes its `project_dir` before `file_events_for_project`; read path accepts legacy raw spelling too (dual-key or bridge) until backfill.

**Tasks:**
- [ ] In `agent_bridge`, resolve `CanonicalPath::from_raw(project_dir)` once; pass its string as the row's `project_dir` for both exact and Bash writes.
- [ ] In `compose_snapshot`, canonicalize `project_dir` via the gateway before `file_events_for_project`; for legacy rows, also query the raw spelling (union) so pre-upgrade rows still scope in.
- [ ] Leave `record_spawn` / `sessions.project_dir` raw ([P05]).

**Tests:**
- [ ] `two_spellings_one_project_attribute_to_one_bucket` — real temp repo + symlink; two sessions record events with `project_dir` spelled differently; compose finds both under one canonical bucket.
- [ ] `sessions_project_dir_stays_raw` — `list_for_project_dir(raw)` still hits after a spawn.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast changeset attribution agent_bridge`
- [ ] `cargo build` warning-clean

#### Step 4: Capture-time repo-relative `file_path` projection {#step-4}

**Depends on:** #step-1, #step-3

**Commit:** `tugcast(attr): project file_events to repo-relative at capture`

**References:** [P02] ([#p02-capture-time-projection]), [P08] ([#p08-per-session-repo-root]), [Q01] ([#q01-file-path-storage])

**Artifacts:**
- `PendingCall::into_row(session, tool_use, project_dir: &CanonicalPath, repo_root: Option<&CanonicalPath>, origin, at)` stores repo-relative `file_path`.
- `OpenBracket::into_delta_rows` stores repo-relative `file_path`.
- `run_session_bridge` caches `repo_root: Option<CanonicalPath>` per session and threads it in.
- `FileEventRow::file_path` doc updated to repo-relative.

**Tasks:**
- [ ] In `agent_bridge`, compute `repo_root_for(canonical_project_dir)`, wrap as `CanonicalPath`, cache with sticky-`Some` / re-probe-while-`None` semantics ([P08]); pass to `into_row` (exact) and reuse for Bash bracket open/close (which today probes per Bash call — the re-probe rule preserves its git-init-mid-session self-healing).
- [ ] `into_row`: project `self.file_path` (canonicalized) to repo-relative against `repo_root`; store relative (or canonical absolute when `repo_root` is `None`).
- [ ] `into_delta_rows`: emit the repo-relative `rel` directly instead of `repo_root.join(rel).to_string_lossy()`.
- [ ] Update the `attribution.rs` module/`file_path_for_tool` comment reversing the query-time-projection note.

**Tests:**
- [ ] `into_row_stores_repo_relative` — exact `Write` under a canonical repo root yields `dash/lens-frame.md`.
- [ ] `into_delta_rows_are_repo_relative` — Bash bracket over a real temp repo emits repo-relative paths.
- [ ] `into_row_no_repo_root_keeps_absolute_canonical` — non-repo dir degrades safely.
- [ ] `repo_root_reprobes_after_git_init` — a session cached at `None` starts projecting repo-relative once a repo appears at the project dir (the "Initialize git" flow).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast attribution agent_bridge`
- [ ] `cargo build` warning-clean

#### Step 5: Reconciler bridge + firmlink-split regression tests {#step-5}

**Depends on:** #step-2, #step-4

**Commit:** `tugcast(changeset): repo-relative join + firmlink reconciler bridge`

**References:** [P07] ([#p07-reconciler-bridge]), List L01 ([#l01-bridge-cases]), [P02] ([#p02-capture-time-projection]), (#firmlink-split-walkthrough)

**Artifacts:**
- `changeset::repo_relative` rewritten as the bridge ([#l01-bridge-cases]).
- Golden regression test seeded from the `ee31685b` shape.

**Tasks:**
- [ ] Rewrite `repo_relative`: relative-in → pass through; absolute-in → canonicalize `repo_root` + `file_path` via gateway, `strip_prefix`; residual mismatch → `same_file` ancestor walk, else return input.
- [ ] Confirm `changeset_all` needs no edit ([P06]); add a note only if a test proves otherwise.

**Tests:**
- [ ] `firmlink_split_row_is_attributed` (golden) — seed a `file_events` row with `file_path=/Users/…/dash/lens-frame.md`, `project_dir=/u`-style symlink spelling, over a real temp repo reached via a symlink; assert the file lands in the session's owned bucket, `unattributed` empty.
- [ ] `deleted_file_reconciles_repo_relative` — a repo-relative row for a `D` file joins git's `D` entry.
- [ ] `bridge_passes_through_relative_and_strips_absolute` — unit over [#l01-bridge-cases].

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast changeset changeset_all`
- [ ] `cargo build` warning-clean

#### Step 6: Lazy opportunistic backfill of legacy rows {#step-6}

**Depends on:** #step-5

**Commit:** `tugcast(ledger): lazy backfill legacy file_events to repo-relative`

**References:** [Q03] ([#q03-backfill-trigger]), [P07] ([#p07-reconciler-bridge]), Risk R01 ([#r01-gateway-boot-cost]), (#transitional-duplicate-rows)

**Artifacts:**
- `session_ledger::backfill_file_events_repo_relative(canonical_project_dir, repo_root)` — rewrite legacy absolute rows in one project to canonical `project_dir` + repo-relative `file_path`, collision-safe against transitional duplicates.

**Tasks:**
- [ ] Add the backfill fn; call it from `compose_snapshot` opportunistically (it already holds `repo_root`), guarded so it runs at most once per project per process (in-memory marker) and only rewrites rows whose `file_path` is absolute.
- [ ] **Collision-safe write semantics** ([#transitional-duplicate-rows]): a legacy absolute row can coexist with a post-upgrade replay row that already holds the target repo-relative PK, and a plain multi-row `UPDATE` aborts on the first PK conflict, rolling back the whole statement. Rewrite per-row inside one transaction: when the target `(tug_session_id, tool_use_id, <rel>)` already exists, **DELETE** the legacy absolute row (fold `ambiguous` with OR and keep `MAX(at)` on the survivor); otherwise UPDATE in place. (`UPDATE OR REPLACE` is the terser alternative but silently drops the survivor's flags — do the explicit merge.)
- [ ] No boot-time / all-projects invocation (TCC property).

**Tests:**
- [ ] `backfill_converts_absolute_rows_only_once` — seed absolute rows, compose once, assert rows now repo-relative + canonical `project_dir`; a second compose does no extra writes.
- [ ] `backfill_collapses_duplicate_absolute_and_relative_rows` — seed the transitional pair (same `(tug_session_id, tool_use_id)`, one absolute `file_path`, one repo-relative, differing `ambiguous`/`at`); backfill leaves exactly one row, repo-relative, with `ambiguous` OR-folded and the later `at` — and does **not** abort the surrounding transaction.
- [ ] `backfill_never_touches_unopened_projects` — a project not composed keeps its legacy rows (proves no boot walk).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast changeset session_ledger`
- [ ] `cargo build` warning-clean

#### Step 7: Integration checkpoint — end-to-end split + no-TCC property {#step-7}

**Depends on:** #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** [P01]–[P08], (#success-criteria), Risk R01 ([#r01-gateway-boot-cost])

**Tasks:**
- [ ] Verify the full path: record (relay) → store (ledger, repo-relative) → compose (bridge) → attributed, over a real temp repo reached via both its real path and a symlink.
- [ ] Assert the `0400ed0f7` property: exercise `rebind_from_ledger` and confirm no gateway/`canonicalize` call on historical dirs (code review + a test that rebind adopts `workspace_key` via `from_canonical` only).

**Tests:**
- [ ] `end_to_end_firmlink_split_attributes` (integration) — drives the attribution write path with a symlink-spelled `project_dir` and a `/Users/…`-spelled `file_path`; `compose_aggregate` shows the file owned, `unattributed` empty.
- [ ] `rebind_does_not_canonicalize_historical_dirs` — rebind path performs no fs resolution.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` (whole workspace green)
- [ ] `cargo build` warning-clean

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Changeset attribution reconciles a file regardless of how its directory is spelled — firmlink, `synthetic.conf` symlink, or data-volume expansion — because every persisted/compared path flows through one cheap canonical gateway and file edits are stored repo-relative at capture time.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] The `ee31685b`-shaped golden test passes (attributed, not Unattributed) — Step 5.
- [ ] Two-spelling / deleted-file / bridge cases pass — Steps 3, 5.
- [ ] `0400ed0f7` no-TCC-on-boot property asserted — Step 7.
- [ ] `cargo nextest run` green, `cargo build` warning-clean — every step.

**Acceptance tests:**
- [ ] `firmlink_split_row_is_attributed`
- [ ] `two_spellings_one_project_attribute_to_one_bucket`
- [ ] `end_to_end_firmlink_split_attributes`
- [ ] `rebind_does_not_canonicalize_historical_dirs`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Delete `tugutil::commands::changes::repo_relative` and share the tugcast bridge / drop the strip ([#tugutil-changes-followon]).
- [ ] Move `feeds::draft_engine`'s lexical `strip_prefix(&key.project_dir)` (dash-worktree stripping) onto the bridge/gateway ([#canonicalize-audit]).
- [ ] Audit remaining `resolve_to_claude_form` call sites (`dev.rs`, `fs_read.rs`) for gateway adoption once `CanonicalPath` is established.
- [ ] Consider typing `record_spawn`'s `workspace_key` as `&WorkspaceKey` / `&CanonicalPath` for symmetry (cosmetic).

| Checkpoint | Verification |
|------------|--------------|
| Firmlink split reconciles | `cargo nextest run -p tugcast firmlink_split_row_is_attributed` |
| No TCC prompt on boot | `cargo nextest run -p tugcast rebind_does_not_canonicalize_historical_dirs` + review |
| Whole workspace green | `cd tugrust && cargo nextest run && cargo build` |
