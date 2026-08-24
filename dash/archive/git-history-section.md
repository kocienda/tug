<!-- devise-skeleton v4 -->

## M3c — The Git History Lens Section {#git-history-section}

**Purpose:** Add a **Git History** section to the Lens (`kind: "git-history"`) that renders the active project's recent `git log` read-only, backed by a new query-driven snapshot feed pair (`GIT_LOG` 0x25 / `GIT_LOG_QUERY` 0x26) modeled exactly on the existing GIT_DIFF feed. The section follows the active dev card's project and names the branch in its collapsed summary.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | implemented (`ce3ad42c2`) |
| Target branch | main |
| Last updated | 2026-07-15 |

---

### Post-implementation addendum (what actually shipped) {#post-impl-addendum}

The implementation went **beyond** the drafted scope in three material ways. This
section is authoritative where it contradicts the decisions below; the original
`[P##]` text is kept for lineage but annotated inline.

1. **Live commit-driven refresh shipped — the deferred [P05] follow-on was built.**
   Rather than refresh only on mount + followed-project change, the code adds an
   event-driven HEAD watch and a third feed so the section updates the moment a
   commit lands (from any source), with no polling:
   - `FeedId::GIT_HEAD` (**0x27**) + `GitHeadSignal { workspace_key, head }` wire type.
   - `tugcast/src/feeds/git_watch.rs` — `run_git_workspace_watch`, a plain
     subscriber to the workspace's existing `FileWatcher` (no second OS watch).
     A `.git`-touching batch re-reads HEAD; a real move broadcasts `GitHeadSignal`.
     Spawned per workspace by `WorkspaceRegistry`, torn down via the entry's
     child cancel token on `release` ([L27]).
   - Client: `parseGitHeadSignal` + `GitLogStore._onHeadSignal` re-request the log
     when a signal names the shown `workspace_key` and its `head` is past the
     commit on top. The shared `FeedStore` subscribes to `[GIT_LOG, GIT_HEAD]`.
   - Live proof: `tugrust/crates/tugcast/tests/git_head_roundtrip.rs`.

2. **[P09] reversed — the GIT_LOG adapter resolves `root` directly, not via
   `resolve_diff_target`.** A valid `root` is canonicalized through
   `CanonicalPath::from_raw` and read as-is; only an absent/invalid `root` falls
   back to bootstrap. This closes the trap the Step 6 note called out (an
   unregistered followed-card workspace falling through to bootstrap and serving
   the *wrong* repo's log). The canonical key it produces matches the one the
   registry/git-watch stamp, so `GitHeadSignal` correlation holds.

3. **`git status` background poll opts out of the index lock.** `fetch_git_status`
   now passes `--no-optional-locks`. Because the git watch fires the changeset
   recompute (→ `git status`) on every `.git`-touching batch, an optional lock
   raced a concurrent user `git commit` in the watched repo (`index.lock: File
   exists`). Read-only status has no need to write the index.

Minor deltas from the drafted specs: the empty states render **"No project open."**
(body) / **"No project"** (collapsed summary) rather than the drafted "No dev card
in focus." / "No card"; `useFollowedProject()` adds a **frontmost bound-card
fallback** (`useFrontmostProjectBinding`) so the section keeps tracking a project
when no card is the active key card.

---

### Phase Overview {#phase-overview}

#### Context {#context}

M3a (`dash/lens-frame.md`, `1057596df`) built the Lens section frame: a registry of `LensSectionDefinition`s, a sticky band per section, persisted order/collapse, and the followed-card machinery. M3b (`dash/changeset-section.md`, `735c73ba`) proved a section can carry a full feed-backed surface (the Changeset section) and established the request→filtered-response store shape. The frame's promise is that a new section is *one registrant plus its feed* — no frame changes.

Git History is the next section: a read-only view of the followed project's recent commits. There is a verbatim model to copy — the GIT_DIFF query feed (`GIT_DIFF` 0x21 / `GIT_DIFF_QUERY` 0x22): a request frame carrying `root` + `requestId`, workspace resolution via `WorkspaceRegistry::resolve_diff_target`, a per-request spawned builder in `feeds/git.rs`, a broadcast response correlated client-side by `request_id`, and a `GitDiffStore` client store with `idle | loading | ready | error` phases. This plan clones that path for `git log`, then renders the result in `TugCodeView` under a new section registrant.

#### Strategy {#strategy}

- **Clone GIT_DIFF, don't invent.** Every wire/server/store shape mirrors the GIT_DIFF feed verbatim: FeedId pair, snapshot type with `request_id`/`workspace_key`/`no_repo`, `is_within_git_worktree` gate, per-request spawn, broadcast response, `request_id`-filtered client store.
- **Backend first, fully independent of the frontend.** FeedId pair + types (Step 1), builder (Step 2), `main.rs` adapter + round-trip test (Step 3) land before any tugdeck code.
- **Structured commits on the wire ([P01]); the section formats them into the `TugCodeView` string.** Parsing/serialization stays unit-testable; presentation is a pure client-side formatter.
- **One shared client store ([P06]).** Git History follows one project at a time — no per-entry store fan-out.
- **Follow the active dev card's project ([P02])** via `useLensFollowedCard()` + `cardSessionBindingStore`, exactly like the Telemetry section.
- **Atomic wire edits.** The Rust FeedId three-site edit and the TS mirror land in one step so the wire never drifts.
- App-test last (at0238), against the real app with a real git repo.

#### Success Criteria (Measurable) {#success-criteria}

- A `GIT_LOG_QUERY` frame against a live tugcast returns one `GIT_LOG` frame whose snapshot carries the repo's real commits, correct branch, echoed `request_id`, honored `limit` (verified by `git_log_roundtrip.rs`).
- A non-git project dir yields `no_repo: true` with empty `commits` (Rust unit test).
- Opening the Lens with a dev card bound to a git project renders that repo's commit subjects in the Git History section; the collapsed band shows `<branch> · <n> commits` (verified by at0238).
- Focusing a dev card bound to a *different* project re-requests and re-renders that project's log (verified by at0238 or, if two live projects are impractical in the harness, by the store unit + the followed-card effect's key guard).
- `cd tugrust && cargo nextest run` green with `-D warnings`; `bunx tsc --noEmit && bunx vite build && bun test` green.

#### Scope {#scope}

1. FeedId pair `GIT_LOG` (0x25) / `GIT_LOG_QUERY` (0x26) — Rust three sites + TS mirror — and wire types `GitLogSnapshot` / `GitLogCommit` (Rust + TS + `parseGitLogPayload`).
2. `build_git_log_snapshot` in `tugrust/crates/tugcast/src/feeds/git.rs` with branch resolution and a local multi-line git runner, plus real-temp-repo unit tests.
3. The `main.rs` GIT_LOG_QUERY adapter (shared broadcast, `register_input`, per-request spawn) plus the `git_log_roundtrip.rs` integration test and `common/mod.rs` helpers.
4. `tugdeck/src/lib/git-log-store.ts` — a single shared, `request_id`-filtered store with `requestLog(projectDir)` — plus `bun test` unit.
5. `tugdeck/src/components/lens/sections/git-history-section.tsx` (+ `.css`): `registerGitHistorySection()`, followed-project resolution, `TugCodeView` rendering, empty states; registered in `main.tsx`.
6. App-test at0238 against the real app.

#### Non-goals (Explicitly out of scope) {#non-goals}

- An all-projects history view (the Changeset section already fills the aggregate niche; see [P02]).
- Per-commit click-to-diff / commit detail expansion (the structured wire shape leaves room; see [P01] implications).
- Rich in-section search / Find affordance (deferred; see [P03]).
- "Load more" / pagination beyond the fixed limit (the `limit` query field leaves room; see [P04]).
- ~~Live refresh when a commit lands (deferred; see [P05]).~~ **SHIPPED** — see the
  [post-implementation addendum](#post-impl-addendum): the GIT_HEAD (0x27) feed +
  `git_watch.rs` deliver it event-drively.
- Any Lens frame changes — no registry, band, or followed-card edits.

#### Dependencies / Prerequisites {#dependencies}

- M3a Lens frame on main (`1057596df`): `lens-section-registry.ts`, `lens-section-band.tsx`, `useLensFollowedCard()`.
- M3b Changeset section on main (`735c73ba`): the section-lift precedent and `cardSessionBindingStore` usage.
- Path canonicalization on main (`c6d7b806`): canonical `project_dir` / `workspace_key`; `WorkspaceRegistry::resolve_diff_target`.
- The GIT_DIFF feed (the model): `feeds/git.rs`, the `main.rs` adapter, `git-diff-store.ts`, `git_diff_roundtrip.rs`.

#### Constraints {#constraints}

- Tuglaws cross-check before tugdeck work; name touched laws in commits. Touched here: [L02] (store state via `useSyncExternalStore`), [L06] (appearance via CSS/DOM), [L20] (compose real Tug components — `TugCodeView`, never a hand-rolled code view).
- A section must NOT add its own scroll — the `.lens-content` scroll owns scrolling (M3b [P08]; an inner `overflow` breaks nested sticky offsets). `TugCodeView` is sized-to-content with no inner scroll, so it fits natively.
- No localStorage/sessionStorage/IndexedDB.
- Rust: `-D warnings` enforced; `cargo nextest run` green per step.
- Every tugdeck step green on `bunx tsc --noEmit && bunx vite build && bun test` — `bunx vite build` before declaring done.
- App-tests are real (`just app-test`), no mocks/jsdom; never force `TUG_FORCE_BUNDLE_ID`.
- Artifact hygiene: no plan-step numbers or rationale narration in code comments.
- FeedId bytes 0x20 (`GIT`) and 0x23 (`CHANGESET`) are RETIRED/reserved — never reuse. 0x25/0x26 are free and claimed here.

#### Assumptions {#assumptions}

- `git` is on PATH for tugcast (already true — the diff/status feeds shell out to it).
- The followed dev card's binding (`cardSessionBindingStore`) is the authoritative project source; a card with no binding yet (session still spawning) renders the empty state until the binding lands, and the store subscription re-renders when it does.
- at0238 is a free app-test number (at0237 is the highest claimed; at0227/at0232 are known gaps — do not fill them).

---

### Reference and Anchor Conventions {#reference-conventions}

This plan follows `tuglaws/devise-skeleton.md` v4: explicit `{#anchor}` headings, plan-local decisions `[P##]`, open questions `[Q##]`, specs `S##`, tables `T##`, risks `R##`, `**Depends on:**` lines with `#step-N` anchors, and mandatory `**References:**` lines. No line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] How does the builder resolve the branch name in edge-case repos? (DECIDED — see [P07]) {#q01-branch-resolution}

**Question:** `git rev-parse --abbrev-ref HEAD` fails in a repo with no commits (unborn HEAD) and prints the literal `HEAD` when detached. What does `branch` carry then?

**Why it matters:** The collapsed summary is `` `${branch} · ${n} commits` `` — a raw git error or a confusing literal would surface directly in the band.

**Resolution:** DECIDED — use `git branch --show-current` (works on an unborn branch, prints empty when detached) with `(detached)` as the empty-output fallback. See [P07].

#### [Q02] Does at0238 need two live projects to prove follow-tracking? (DECIDED — no) {#q02-two-projects}

**Question:** The "tracks the active dev card's project" assertion ideally flips focus between two dev cards bound to two different repos. Is that harness-practical?

**Why it matters:** Spawning two real sessions doubles app-test time and flake surface; the memory note on app-test transient workspaces warns long multi-session UI flows are fragile.

**Resolution:** DECIDED — at0238 proves the single-project path end-to-end (real repo → section renders its subjects → band names the project's branch, section header names the followed card's project). Project-*change* re-request is proven at the store layer (the `requestLog` requested-key guard unit test in Step 4) plus the section's effect keyed on `projectDir`. This mirrors how at0235 scopes the Log section test.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Field-separator collision in `git log --format` parsing | med | low | Use `%x1f` (unit separator) between fields — cannot appear in an author name or single-line subject (`%s` strips newlines) | A commit renders with shifted columns |
| Stale section after a commit lands | low | high (by design) | Deferred per [P05]; re-request on project change and Lens remount still refreshes | User feedback that history feels dead |
| Broadcast response leaks across cards | low | low | `request_id` prefix `gl-<storeId>-<seq>` correlates exactly like `gd-` ids; single shared store makes cross-talk moot | — |

**Risk R01: Format-string parsing brittleness** {#r01-format-parsing}

- **Risk:** Hand-parsing `git log` output breaks on unusual commits (empty subjects, unicode authors).
- **Mitigation:** `%x1f`-delimited single-record-per-line format (`%H%x1f%an%x1f%ad%x1f%s`, `--date=short`); a parser unit test covers an empty subject and a unicode author over a real temp repo.
- **Residual risk:** A subject containing a raw 0x1f byte would mis-split; git subjects are single-line and 0x1f is vanishingly rare in commit messages.

---

### Design Decisions {#design-decisions}

#### [P01] Structured `GitLogCommit[]` on the wire; the section formats the text blob (DECIDED) {#p01-structured-wire}

**Decision:** The wire carries structured commits — `GitLogSnapshot { request_id, workspace_key, branch, no_repo, commits: Vec<GitLogCommit> }` with `GitLogCommit { sha, subject, author, date }` — and the section formats them client-side into the single string `TugCodeView` renders.

**Rationale:**
- Follows the GIT_DIFF precedent: `GitDiffSnapshot` is structured, parsed, and unit-tested on both sides; a preformatted blob would be the odd one out.
- Structured data is parseable and testable (`parseGitLogPayload` guards each field) and leaves room for future per-commit affordances (click-to-diff a sha, commit detail) without a wire change.
- Formatting is presentation; presentation belongs client-side where the theme/typography lives.

**Implications:**
- `sha` is the full 40-char hash on the wire (a usable rev for future git commands); the formatter shortens it for display.
- The formatter (**Spec S02**) is a pure exported function in `git-log-store.ts`, unit-tested without React. Every line is uniform: `<sha9>  <date>  <author> — <subject>`. Line format locked in Spec S02.
- `date` is `--date=short` (`YYYY-MM-DD`) — fixed-width, locale-stable, aligns as a column with no padding logic.

#### [P02] Follow the active dev card's project (DECIDED) {#p02-followed-project}

**Decision:** The section follows the last non-lens key card via `useLensFollowedCard()` and resolves its project through `cardSessionBindingStore.getSnapshot().get(cardId)` → `CardSessionBinding { projectDir, workspaceKey, … }`. No all-projects view.

**Rationale:**
- Mirrors the Telemetry section's followed-card model (M3a [P11] lineage) — "the dev card I'm working in" is the natural subject of the Lens.
- The exact card-id → binding path is already proven in the Changeset section (M3b).
- An all-projects history is heavier and the Changeset section already fills the aggregate niche.

**Implications:**
- Empty state when there is no followed card, or the followed card has no session binding yet.
- The collapsed summary and section body both derive from the same store reads so they agree across collapse toggles (the Telemetry section's `useFollowedCardInfo` pattern).

#### [P03] No rich search in v1 (DECIDED) {#p03-no-search}

**Decision:** v1 relies on `TugCodeView`'s default `wrap` display with `lineNumbers` off; no Find affordance, no `onFindRequested` wiring, no `TugCodeViewDelegate` search driving.

**Rationale:**
- 20 commits ([P04]) fit on one screen; search adds UI surface with near-zero payoff at that depth.
- `TugCodeView` already registers FIND in the responder chain; wiring a visible affordance is additive later without touching the wire or the store.

**Implications:** Recorded as a follow-on (#roadmap). Line numbers are disabled (`lineNumbers={false}`) — commit rows are records, not source lines; a gutter counting 1..20 is noise.

#### [P04] Depth is top 20, carried as `limit` in the query (DECIDED) {#p04-limit}

**Decision:** The section requests the 20 most recent commits; `GIT_LOG_QUERY` carries `limit` (optional on the wire, default 20 server-side, clamped to 1..=200).

**Rationale:**
- 20 matches "recent activity at a glance" and keeps the payload trivial.
- Carrying `limit` on the wire from day one means a future "load more" is a client-only change.

**Implications:** The builder passes `-n<limit>` to git; the round-trip test asserts a `limit: 2` query returns exactly 2 commits from a 3-commit repo.

#### [P05] Refresh on mount + followed-project change only; commit-driven refresh deferred (SUPERSEDED — commit-driven refresh SHIPPED) {#p05-refresh-cadence}

> **Superseded by the [post-implementation addendum](#post-impl-addendum).** The
> implementation *did* build commit-driven refresh — not by piggybacking on the
> `CHANGESET_ALL` bump (the rationale below correctly rejects that), but via a
> dedicated `GIT_HEAD` (0x27) HEAD-move signal off the event-driven git watch.
> The "recorded as a follow-on" implication is done. The original text follows.


**Decision:** v1 re-requests when the section body mounts and when the followed project's `projectDir` changes (guarded so the same project isn't re-requested on unrelated re-renders). No subscription to `CHANGESET_ALL` bumps.

**Rationale:**
- The `CHANGESET_ALL` aggregate bumps on *every attributed file event* in any open project, not just commits — piggybacking on it would fork a `git log` per keystroke-save burst, and filtering "was this bump a commit?" client-side requires state this section shouldn't own.
- Collapsing/expanding the Lens or switching cards — the natural gestures around a commit — already trigger a fresh request.

**Implications:** History can be stale immediately after a commit while the same card stays focused. Recorded as a follow-on (#roadmap): a server-side HEAD-sha watch or a dedicated commit signal is the right trigger, not the changeset bump.

#### [P06] One shared client store, requested-key-guarded (DECIDED) {#p06-shared-store}

**Decision:** `git-log-store.ts` exports a `GitLogStore` class (for tests) and a module-level singleton accessor `gitLogStore()` over a lazily created shared `FeedStore(conn, [FeedId.GIT_LOG])`. `requestLog(projectDir)` fires a new query only when `projectDir` differs from the last *requested* root (or the last request errored); phases are `idle | loading | ready | error`; responses are accepted only when `request_id` matches the in-flight id.

**Rationale:**
- Git History shows one project at a time — the per-entry `getEntryDiffStore`/`sweepEntryDiffStores` fan-out that the changeset diffs need is dead weight here.
- The requested-key guard makes the section's effect idempotent: re-renders and collapse toggles can call `requestLog` freely.
- `request_id` filtering (prefix `gl-<storeId>-<seq>`) is mandatory because the GIT_LOG response is a broadcast every client sees (same reason as `gd-` ids).

**Implications:** A `refresh()` escape hatch (re-request the current root unconditionally) ships on the store for the mount-time request and future affordances; the guard lives in `requestLog`, not in callers.

#### [P07] Branch resolution via `git branch --show-current` (DECIDED) {#p07-branch-resolution}

**Decision:** The builder resolves `branch` with `git branch --show-current` (one call through the existing `run_git_line` helper in `feeds/git.rs`); empty/failed output → `"(detached)"`.

**Rationale:**
- Unlike `git rev-parse --abbrev-ref HEAD`, it succeeds on an unborn branch (fresh `git init`, no commits) — exactly the repo state the empty-repo test covers — and prints empty rather than the confusing literal `HEAD` when detached.
- `run_git_line` already exists in `git.rs` (used for `merge-base`), so this costs zero new plumbing.

**Implications:** `(detached)` matches the porcelain-v2 parser's existing detached-HEAD spelling in this module. On `no_repo`, branch is `""` and the client renders the no-repo empty state instead.

#### [P08] A local multi-line git runner in `git.rs`; `draft_engine.rs::git_output` stays private (DECIDED) {#p08-local-runner}

**Decision:** Add `run_git_capture(dir, args) -> Option<String>` (private to `feeds/git.rs`): run `git -C <dir> <args…>`, return full stdout on success, `None` (with a `warn!`) otherwise. Do not lift `draft_engine.rs`'s private `git_output` to a shared helper.

**Rationale:**
- `git.rs` already follows this exact pattern twice (`run_git_line` for single-line output, `fetch_git_diff` for the diff body); a third local helper matches the module's existing shape.
- Lifting `git_output` out of `draft_engine.rs` couples two modules for ~10 shared lines and widens this plan's blast radius for no behavioral gain.

**Implications:** `run_git_line` (trimmed single line) serves branch resolution; `run_git_capture` serves the multi-line log body.

#### [P09] Reuse `resolve_diff_target` unchanged (REVERSED — adapter resolves `root` directly) {#p09-reuse-resolver}

> **Reversed by the [post-implementation addendum](#post-impl-addendum).** The
> GIT_LOG adapter does NOT call `resolve_diff_target`. A valid `root` is
> canonicalized via `CanonicalPath::from_raw` and read directly; only an
> absent/invalid `root` falls back to bootstrap. This avoids serving the wrong
> repo's log for a followed card whose workspace is not yet registered on
> restore — the hazard the Step 6 note flags. The original text follows.


**Decision:** The GIT_LOG_QUERY adapter resolves its workspace with the existing `WorkspaceRegistry::resolve_diff_target(root, &bootstrap)` — no rename, no `resolve_workspace_target` alias. Its doc comment is updated to state it is the generic query-feed workspace resolver (root → registered entry, else bootstrap), now serving both GIT_DIFF and GIT_LOG.

**Rationale:**
- The function is already generic (`root.and_then(find_entry_by_path).unwrap_or(bootstrap)`); a second resolver or an alias is pure duplication.
- A rename would touch the GIT_DIFF call sites and tests for a cosmetic gain; a doc-comment fix delivers the clarity at zero risk.

**Implications:** The two adapters resolve identically forever — one behavior to test, one fallback rule (bootstrap `--source-tree`) to remember.

---

### Deep Dives {#deep-dives}

#### The GIT_DIFF request/response path, mapped to GIT_LOG {#gitdiff-path-map}

Every row is "verbatim ground truth on main → its GIT_LOG clone":

**Table T01: GIT_DIFF → GIT_LOG clone map** {#t01-clone-map}

| Layer | GIT_DIFF (exists) | GIT_LOG (this plan) |
|-------|-------------------|---------------------|
| FeedId consts | `GIT_DIFF = 0x21` / `GIT_DIFF_QUERY = 0x22` in `tugrust/crates/tugcast-core/src/protocol.rs` (three sites: `pub const`, `name()` arm, `test_known_feedid_byte_values`) | `GIT_LOG = 0x25` / `GIT_LOG_QUERY = 0x26`, same three sites; `name()` returns `"GitLog"` / `"GitLogQuery"` |
| TS mirror | `GIT_DIFF: 0x21, GIT_DIFF_QUERY: 0x22` in `tugdeck/src/protocol.ts` | `GIT_LOG: 0x25, GIT_LOG_QUERY: 0x26` |
| Snapshot type | `GitDiffSnapshot` in `tugcast-core/src/types.rs` | `GitLogSnapshot` + `GitLogCommit` (Spec S01) |
| Builder | `build_git_diff_snapshot(repo_dir, request_id, workspace_key, paths)` in `tugcast/src/feeds/git.rs`, gated on `is_within_git_worktree` | `build_git_log_snapshot(repo_dir, request_id, workspace_key, limit)`, same gate |
| Response channel | `let (gd_response_tx, _) = broadcast::channel::<Frame>(16);` in `main.rs` | `gl_response_tx`, same shape |
| Input registration | `feed_router.register_input(FeedId::GIT_DIFF_QUERY, gd_input_tx)` (grouped with the other `register_input` calls) | `feed_router.register_input(FeedId::GIT_LOG_QUERY, gl_input_tx)` |
| Adapter task | Parses `RawDiffQuery { root, requestId, paths, worktree, base, branch }`, `resolve_diff_target`, per-request `tokio::spawn`, `response_tx.send(Frame::new(FeedId::GIT_DIFF, json))` | Parses `RawLogQuery { root, requestId, limit }`, same resolve + per-request spawn, broadcasts on `FeedId::GIT_LOG` |
| Router fan-out | `feed_router.add_broadcast_senders(vec![ft_response_tx, gd_response_tx, usage_response_tx])` | append `gl_response_tx` to that vec |
| Client store | `git-diff-store.ts`: `gd-<storeId>-<seq>` ids, `request_id` filter, phases | `git-log-store.ts`: `gl-<storeId>-<seq>`, same filter/phases, single shared store ([P06]) |
| Round-trip test | `tugrust/crates/tugcast/tests/git_diff_roundtrip.rs` + `common/mod.rs::{send_git_diff_query, await_git_diff}` | `git_log_roundtrip.rs` + `send_git_log_query` / `await_git_log` |

Key behaviors to preserve from the model: each request runs in its **own spawned task** (a slow git call never head-of-line-blocks another request); the response is a **broadcast every client sees**, so correlation is entirely client-side by `request_id`; a `root` that matches no registered workspace **falls back to the bootstrap** `--source-tree` workspace.

#### The git invocations {#git-invocations}

- Log body: `git -C <dir> -c core.quotepath=false log -n<limit> --format=%H%x1f%an%x1f%ad%x1f%s --date=short` via `run_git_capture` ([P08]). One record per line; fields split on `\u{1f}`. A malformed line (fewer than 4 fields) is skipped with a `warn!`. A failed invocation (e.g. unborn HEAD in a fresh `git init`) yields empty `commits` with `no_repo: false` — mirroring how `build_git_diff_snapshot` treats a `HEAD`-less repo as empty, not as an error.
- Branch: `git branch --show-current` via the existing `run_git_line`; empty/`None` → `"(detached)"` ([P07]).
- Repo gate: the existing `is_within_git_worktree(repo_dir)` — subprocess-free ancestor walk — short-circuits to `no_repo: true` before any git fork.

#### Section rendering shape {#section-rendering}

The body composes exactly like the Telemetry section (`lens/sections/telemetry-section.tsx`): a `useFollowedProject()` hook chains `useLensFollowedCard()` → `useSyncExternalStore(cardSessionBindingStore.subscribe, …)` to yield `{ cardId, projectDir } | null`; the body and the collapsed summary both call it so they agree across collapse toggles. A `useEffect` keyed on `projectDir` calls `gitLogStore().requestLog(projectDir)` — a data request, not a registration events depend on, so it stays out of the layout phase; idempotent per [P06]'s guard. The commit list renders as one `TugCodeView` (`value` = the Spec S02 formatted text, `wrap` default true, `lineNumbers={false}`) — never a hand-rolled `<pre>`/list ([L20]). `TugCodeView` has no inner scroll (sized-to-content) so the `.lens-content` scroll stays the only scroll (M3b [P08]). Empty states, in precedence order: no followed card / no binding → "No dev card in focus."; `no_repo` → "Not a git repository."; `error` phase → the store's error string; `loading` with no prior payload → "Loading history…".

---

### Specification {#specification}

**Spec S01: Wire contract** {#s01-wire-contract}

Rust (`tugrust/crates/tugcast-core/src/types.rs`), serde-derived like `GitDiffSnapshot`:

```rust
pub struct GitLogCommit {
    /// Full 40-char commit hash. Clients shorten for display.
    pub sha: String,
    /// The commit subject line (`%s`).
    pub subject: String,
    /// Author name (`%an`).
    pub author: String,
    /// Author date, `--date=short` (`YYYY-MM-DD`).
    pub date: String,
}

pub struct GitLogSnapshot {
    /// Correlation id echoed from the request.
    pub request_id: String,
    /// Canonical key of the workspace the log was read in.
    pub workspace_key: String,
    /// Current branch (`git branch --show-current`), `"(detached)"` when
    /// detached, `""` when `no_repo`.
    pub branch: String,
    /// True when the project dir is not inside a git working tree.
    #[serde(default)]
    pub no_repo: bool,
    /// Most-recent-first commits, at most the request's `limit`.
    pub commits: Vec<GitLogCommit>,
}
```

Request payload (JSON on `GIT_LOG_QUERY`), parsed by the adapter's local `RawLogQuery`: `{ root?: string, requestId?: string, limit?: number }`. `limit` defaults to 20 and is clamped to `1..=200` server-side ([P04]).

TS mirror (`tugdeck/src/lib/git-log-store.ts`): `GitLogCommit` / `GitLogPayload` interfaces with the same snake_case field names, plus `parseGitLogPayload(payload: unknown): GitLogPayload | null` guarding `request_id: string` and `commits: Array` (the same guard shape as `parseGitDiffPayload` in `git-diff-store.ts`).

**Spec S02: Log text formatting (client-side, pure)** {#s02-log-format}

`formatGitLog(payload: GitLogPayload): string`, exported from `git-log-store.ts` ([P01]): one line per commit, in wire order —

```
<sha.slice(0, 9)>  <date>  <author> — <subject>
```

two-space column gaps, an em-dash before the subject, no trailing newline, `""` for zero commits. Deterministic and unit-tested (ordering, shortening, empty input, unicode author pass-through).

**Spec S03: Collapsed summary** {#s03-collapsed-summary}

`` `${branch} · ${commits.length} commits` `` (singular "commit" when 1). Fallbacks: no followed card / no binding → `No card`; `no_repo` → `no repo`; request not yet resolved → the project dir's basename alone.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Log snapshot (phase/payload/error) | local-data (external) | `GitLogStore` + `useSyncExternalStore` | [L02] |
| Followed card id | local-data (external) | `useLensFollowedCard()` (existing M3a context) | [L02] |
| Card → project binding | local-data (external) | `cardSessionBindingStore` + `useSyncExternalStore` | [L02] |
| Request-on-project-change | effect | `useEffect` keyed on `projectDir` (a data request, not a paint-order-sensitive registration — [L03] does not apply) | — |
| Section band collapse/order | structure | existing Lens frame stores — untouched | [L22] |
| Commit text presentation | appearance | `TugCodeView` (CM6 DOM) + `.css` tokens | [L06], [L20] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/tests/git_log_roundtrip.rs` | Live round-trip proof (Step 3) |
| `tugrust/crates/tugcast/src/feeds/git_watch.rs` | Event-driven HEAD watch → GIT_HEAD signal (addendum) |
| `tugrust/crates/tugcast/tests/git_head_roundtrip.rs` | Live GIT_HEAD signal proof (addendum) |
| `tugdeck/src/lib/git-log-store.ts` | Client store + wire types + `formatGitLog` (Step 4) |
| `tugdeck/src/lib/git-log-store.test.ts` | Store/parse/format units (Step 4) |
| `tugdeck/src/components/lens/sections/git-history-section.tsx` | The section registrant (Step 5) |
| `tugdeck/src/components/lens/sections/git-history-section.css` | Section-local styles (Step 5) |
| `tests/app-test/at0238-lens-git-history.test.ts` | App-test (Step 6) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `FeedId::GIT_LOG` / `FeedId::GIT_LOG_QUERY` | const | `tugrust/crates/tugcast-core/src/protocol.rs` | 0x25 / 0x26; three sites (const, `name()`, byte-assert test) |
| `FeedId::GIT_HEAD` | const | `tugrust/crates/tugcast-core/src/protocol.rs` | 0x27; HEAD-move signal (addendum); three sites |
| `GitHeadSignal` | struct | `tugrust/crates/tugcast-core/src/types.rs` | `{ workspace_key, head }` (addendum) |
| `run_git_workspace_watch`, `batch_touches_git` | fn | `tugrust/crates/tugcast/src/feeds/git_watch.rs` | event-driven HEAD watch (addendum) |
| `parseGitHeadSignal`, `GitLogStore._onHeadSignal` | fn/method | `tugdeck/src/lib/git-log-store.ts` | client live-refresh on GIT_HEAD (addendum) |
| `fetch_git_status` `--no-optional-locks` | edit | `tugrust/crates/tugcast/src/feeds/git.rs` | index.lock race fix (addendum) |
| `FeedId.GIT_LOG` / `FeedId.GIT_LOG_QUERY` | const | `tugdeck/src/protocol.ts` | TS mirror, same step |
| `GitLogCommit`, `GitLogSnapshot` | struct | `tugrust/crates/tugcast-core/src/types.rs` | Spec S01 |
| `build_git_log_snapshot` | pub async fn | `tugrust/crates/tugcast/src/feeds/git.rs` | gate → branch → log → parse |
| `run_git_capture` | private async fn | `tugrust/crates/tugcast/src/feeds/git.rs` | [P08] |
| `gl_response_tx`, `gl_input_tx/rx`, GIT_LOG adapter task | wiring | `tugrust/crates/tugcast/src/main.rs` | mirror the GIT_DIFF adapter; append to `add_broadcast_senders` |
| `resolve_diff_target` doc comment | doc edit | `tugrust/crates/tugcast/src/feeds/workspace_registry.rs` | [P09]; behavior untouched |
| `send_git_log_query`, `await_git_log` | test helpers | `tugrust/crates/tugcast/tests/common/mod.rs` | mirror the `send_git_diff_query`/`await_git_diff` pair |
| `GitLogStore`, `gitLogStore()`, `parseGitLogPayload`, `formatGitLog` | class/fn | `tugdeck/src/lib/git-log-store.ts` | [P06], Spec S01/S02 |
| `registerGitHistorySection` | fn | `tugdeck/src/components/lens/sections/git-history-section.tsx` | kind `"git-history"`, `History` glyph (lucide) |
| `registerGitHistorySection()` call | wiring | `tugdeck/src/main.tsx` | beside `registerLogSection()` / `registerTelemetrySection()` / `registerChangesetSection()` |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | `build_git_log_snapshot` over real temp repos | commits present, empty repo, non-repo, limit, detached HEAD |
| **Integration (Rust)** | full wire path via a real tugcast subprocess | `git_log_roundtrip.rs` |
| **Unit (bun)** | parse guard, `formatGitLog`, store phases + `request_id` filter + requested-key guard | `git-log-store.test.ts` |
| **App-test** | the real section in the real app over a real repo | at0238 |

#### What stays out of tests {#test-non-goals}

- jsdom/mocked render tests of the section body — banned pattern; the app-test covers real rendering.
- Mock-connection store round-trips — the store units drive the real store class with `_ingestForTest`-style seams (mirroring `GitDiffStore._ingestForTest`); the live wire is proven by the Rust round-trip + at0238.
- `TugCodeView` internals — owned by its own component tests; this plan only composes it.
- Project-switch UI flow in the app-test — covered at the store layer per [Q02].

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Commits land on `main` per house policy (user commits, or per explicit autonomous authorization). Name touched tuglaws in tugdeck commits.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | FeedId pair + wire types (Rust three sites + TS mirror) | done | 9575302ee |
| #step-2 | `build_git_log_snapshot` + unit tests | done | 122101842 |
| #step-3 | `main.rs` GIT_LOG adapter + round-trip test | done | 122101842 |
| #step-4 | `git-log-store.ts` + units | done | 7d83e5642 |
| #step-5 | Git History section + registration | done | c33b603c2 |
| #step-6 | App-test at0238 | done | 0feabef2e |
| #step-7 | Integration checkpoint | done | 7a5c69eac |

#### Step 1: FeedId pair + wire types (Rust three sites + TS mirror, atomic) {#step-1}

**Commit:** `tugcast(protocol): claim GIT_LOG (0x25) / GIT_LOG_QUERY (0x26) + GitLogSnapshot wire types`

**References:** [P01] Structured wire, Spec S01, Table T01, (#gitdiff-path-map)

**Artifacts:**
- `GIT_LOG`/`GIT_LOG_QUERY` consts in `tugrust/crates/tugcast-core/src/protocol.rs` — all three sites: the `pub const` block (doc comments modeled on GIT_DIFF's pair: response = single-shot snapshot tugcast→tugdeck, query = tugdeck→tugcast), the `name()` match arms (`"GitLog"` / `"GitLogQuery"`), and new asserts in `test_known_feedid_byte_values`.
- `GitLogCommit` + `GitLogSnapshot` in `tugrust/crates/tugcast-core/src/types.rs` per Spec S01, derives matching `GitDiffSnapshot` (`Debug, Clone, Serialize, Deserialize, PartialEq`).
- `GIT_LOG: 0x25, GIT_LOG_QUERY: 0x26` in `tugdeck/src/protocol.ts`, placed after `CHANGESET_ALL: 0x24`.

**Tasks:**
- [ ] Add the two consts + `name()` arms + byte-assert lines (0x25/0x26; do not touch retired 0x20/0x23).
- [ ] Add Spec S01 structs with doc comments (echo the `GitDiffSnapshot` commentary style: what correlates, what `no_repo` means).
- [ ] Mirror the two ids in `tugdeck/src/protocol.ts` in the same change.

**Tests:**
- [ ] `test_known_feedid_byte_values` extended asserts (0x25/0x26 + names).
- [ ] A serde round-trip test for `GitLogSnapshot` in `types.rs` tests (serialize → deserialize → eq), matching the module's existing type-test style.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast-core`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 2: `build_git_log_snapshot` in `feeds/git.rs` + unit tests {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(git): build_git_log_snapshot — branch + recent commits over a gated git log`

**References:** [P04] Limit, [P07] Branch resolution, [P08] Local runner, Spec S01, Risk R01, (#git-invocations)

**Artifacts:**
- `run_git_capture(dir, args) -> Option<String>` in `tugrust/crates/tugcast/src/feeds/git.rs` (private; success → full stdout, else `warn!` + `None`), alongside the existing `run_git_line`.
- `pub async fn build_git_log_snapshot(repo_dir: &Path, request_id: String, workspace_key: &str, limit: u32) -> GitLogSnapshot`: `is_within_git_worktree` gate → `no_repo: true` early return; branch via `run_git_line(dir, ["branch", "--show-current"])` with `(detached)` fallback; log via `run_git_capture` with `-c core.quotepath=false log -n<limit> --format=%H%x1f%an%x1f%ad%x1f%s --date=short`; a private line parser splitting on `\u{1f}` into `GitLogCommit`s (skip + `warn!` malformed lines); failed log (e.g. unborn HEAD) → empty `commits`, `no_repo: false`.

**Tasks:**
- [ ] Add the runner and builder with doc comments in the module's existing voice (what the gate prevents, what an empty-repo failure means).
- [ ] Clamp is NOT applied here (the adapter clamps; the builder trusts its `limit`) — keep the builder a pure git wrapper like `build_git_diff_snapshot`.

**Tests (mirror the existing real-temp-repo diff-builder tests in `git.rs`; reuse its `git_in` helper):**
- [ ] Three-commit repo → 3 commits, most-recent-first, correct `sha` (40 chars), `subject`, `author`, `date` format `YYYY-MM-DD`; `branch` = the init branch; `request_id`/`workspace_key` echoed.
- [ ] `limit: 2` on a 3-commit repo → exactly 2 (the newest two).
- [ ] Fresh `git init` (no commits) → `no_repo: false`, empty `commits`, branch = the unborn branch name.
- [ ] Plain non-git dir → `no_repo: true`, empty `commits`, `branch == ""`.
- [ ] Detached HEAD (checkout a sha) → `branch == "(detached)"`.
- [ ] A commit with a unicode author and one with an empty-ish subject parse without column shift.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast git` (module tests green, `-D warnings` clean)

---

#### Step 3: `main.rs` GIT_LOG_QUERY adapter + `git_log_roundtrip.rs` {#step-3}

**Depends on:** #step-2

**Commit:** `tugcast(main): GIT_LOG_QUERY adapter + live git_log round-trip test`

**References:** [P04] Limit clamp, [P09] Reuse resolver, Table T01, (#gitdiff-path-map)

**Artifacts:**
- In `tugrust/crates/tugcast/src/main.rs`, mirroring the GIT_DIFF adapter block exactly: `let (gl_response_tx, _) = broadcast::channel::<Frame>(16);` beside `gd_response_tx`; an mpsc `gl_input_tx/rx` (buffer 16); an adapter task parsing a local `RawLogQuery { root: Option<String>, #[serde(rename = "requestId")] request_id: Option<String>, limit: Option<u32> }` (malformed JSON → `warn!` + continue), resolving via `registry.resolve_diff_target(root, &bootstrap)`, clamping `limit.unwrap_or(20)` to `1..=200`, and per-request `tokio::spawn`ing `build_git_log_snapshot` → `gl_response_tx.send(Frame::new(FeedId::GIT_LOG, json))`.
- `feed_router.register_input(FeedId::GIT_LOG_QUERY, gl_input_tx)` beside the GIT_DIFF registration; `gl_response_tx` appended to the `feed_router.add_broadcast_senders(vec![…])` call.
- `resolve_diff_target` doc comment updated to name it the generic query-feed workspace resolver serving GIT_DIFF and GIT_LOG ([P09]; no behavior change).
- `tugrust/crates/tugcast/tests/common/mod.rs`: `send_git_log_query(&mut self, root: Option<&Path>, request_id: &str, limit: Option<u32>)` and `await_git_log(&mut self, request_id, timeout) -> serde_json::Value`, modeled line-for-line on `send_git_diff_query`/`await_git_diff`.
- `tugrust/crates/tugcast/tests/git_log_roundtrip.rs`, modeled on `git_diff_roundtrip.rs` (real tugcast subprocess over a temp repo as `--source-tree`, real WebSocket, `TestTugcast`/`TestWs`; needs only `git` + tmux, no `claude`, default suite).

**Tasks:**
- [ ] Wire the adapter (comment in the GIT_DIFF block's voice: per-request spawn rationale, broadcast + client-side `request_id` correlation).
- [ ] Add the common helpers + the round-trip test file.

**Tests (in `git_log_roundtrip.rs`):**
- [ ] A 3-commit repo, `root: None` (bootstrap fallback), `limit: None` → response echoes `request_id`, `branch` correct, 3 commits with the expected subjects most-recent-first.
- [ ] `limit: Some(2)` → exactly 2 commits.
- [ ] Two rapid queries with distinct `request_id`s each get a correlated response (broadcast correlation holds).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast --test git_log_roundtrip`
- [ ] `cd tugrust && cargo nextest run` (full suite, `-D warnings` clean)

---

#### Step 4: `git-log-store.ts` + bun units {#step-4}

**Depends on:** #step-1

**Commit:** `tugdeck(lib): GitLogStore — single shared, request-correlated git-log store [L02]`

**References:** [P01] Structured wire, [P04] Limit, [P06] Shared store, Spec S01, Spec S02, (#section-rendering)

**Artifacts:**
- `tugdeck/src/lib/git-log-store.ts`: the TS wire types + `parseGitLogPayload` (Spec S01), `formatGitLog` (Spec S02), `GitLogPhase = "idle" | "loading" | "ready" | "error"`, `GitLogStoreSnapshot { phase, requestId, requestedRoot, payload, error }`, and `class GitLogStore` over a `FeedStore` — constructor subscribes; `_onFeedUpdate` parses and accepts only `parsed.request_id === snapshot.requestId` (the `GitDiffStore._onFeedUpdate` shape, including the `_lastPayloadRef` dedup); `requestLog(projectDir, limit = 20)` — requested-key guard: no-op when `projectDir === requestedRoot` and phase is `loading | ready`; otherwise bump `_seq`, `requestId = gl-<storeId>-<seq>`, set `loading`, `conn.send(FeedId.GIT_LOG_QUERY, …)` with `{ root, requestId, limit }`; no-connection → `error` phase (the `GitDiffStore.requestDiff` shape); `refresh()` — unconditional re-request of `requestedRoot`; `_ingestForTest(payload)` seam mirroring `GitDiffStore._ingestForTest`; `dispose()`.
- Module-level `gitLogStore(): GitLogStore | null` — lazily creates one shared `FeedStore(getConnection(), [FeedId.GIT_LOG])` + one `GitLogStore`, `null` when no connection (the `changeset-diff-store.ts::sharedFeedStore` shape). No per-entry fan-out.
- `tugdeck/src/lib/git-log-store.test.ts`.

**Tasks:**
- [ ] Author store + helpers with a module docstring naming the correlation contract (broadcast response, `gl-` ids) and [L02].

**Tests:**
- [ ] `parseGitLogPayload`: valid payload passes; missing `request_id` / non-array `commits` → `null`; `no_repo` default false.
- [ ] `formatGitLog`: ordering preserved, sha shortened to 9, `YYYY-MM-DD` column, em-dash subject, empty payload → `""`, unicode author intact.
- [ ] Store: `_ingestForTest` with a matching id → `ready`; a non-matching `request_id` ingested via the feed path is ignored; requested-key guard (second `requestLog` with the same root is a no-op; a different root re-requests; `refresh()` always re-requests).

**Checkpoint:**
- [ ] `cd tugdeck && bun test git-log-store && bunx tsc --noEmit && bunx vite build`

---

#### Step 5: The Git History section + registration {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `tugdeck(lens): Git History section — followed project's recent commits in TugCodeView [L02][L06][L20]`

**References:** [P02] Followed project, [P03] No search, [P05] Refresh cadence, Spec S02, Spec S03, (#section-rendering, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/lens/sections/git-history-section.tsx`: `useFollowedProject()` (→ `{ cardId, projectDir } | null` via `useLensFollowedCard()` + `cardSessionBindingStore`), `GitHistoryCollapsedSummary` (Spec S03), `GitHistorySectionBody` (request effect keyed on `projectDir` in `useEffect`; store read via `useSyncExternalStore`; empty states per #section-rendering; commits in `<TugCodeView value={formatGitLog(payload)} lineNumbers={false} />`), and `registerGitHistorySection()` — `kind: "git-history"`, `title: "Git History"`, `glyph: <History size={14} />` (lucide), collapsedSummary + host-agnostic body (imports nothing from `lens/` internals beyond the registry + followed-card hook, matching `telemetry-section.tsx`).
- `git-history-section.css`: section-local spacing/empty-state styles over existing theme tokens; **no `overflow` property** (the `.lens-content` scroll owns scrolling).
- `registerGitHistorySection()` called in `tugdeck/src/main.tsx` beside `registerChangesetSection()`.

**Tasks:**
- [ ] Author the section per #section-rendering; `data-lens-section="git-history"` arrives via the existing band wrapper (as with `log`), plus `data-testid` hooks on the body/empty states for at0238.
- [ ] Register in `main.tsx`.
- [ ] Verify live in the app: open the Lens next to a dev card on a real repo, see commits; collapse → band summary shows `<branch> · <n> commits`.

**Tests:**
- [ ] (bun) none beyond Step 4's — section rendering is app-test territory (no jsdom render tests per house rules).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] Manual: the section renders real commits in the running app (HMR is live; no manual tugdeck build needed).

---

#### Step 6: App-test at0238 {#step-6}

**Depends on:** #step-5

**Commit:** `tests(app-test): at0238 — Lens Git History renders the followed project's real commits`

**References:** [P02] Followed project, [Q02] Single-project scope, Spec S02, Spec S03, (#success-criteria)

**Artifacts:**
- `tests/app-test/at0238-lens-git-history.test.ts`, modeled on `at0235-lens-log-section.test.ts` (`launchTugApp`, `mkTempTugbank`/`seedTugbankForLaunch`, `SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1"`, `dispatchControlAction("toggle-lens")`, `waitForCondition` on `.lens-section[data-lens-section="git-history"]`).

**Tasks:**
- [ ] Seed a temp git repo with known commit subjects (the `git_diff_roundtrip.rs` `make_dirty_repo` shape, minus the dirtying — 2–3 commits with distinctive subjects), then point tugcast's **bootstrap workspace at that repo**: `seedTugbankForLaunch(tugbankPath, { sourceTreePath: repo })` (`_harness/tugbank-helpers.ts` writes `dev.tugtool.app/source-tree-path`). This is load-bearing: the harness's `bindDevSession` writes a **synthetic** binding straight into `cardSessionBindingStore` without registering any workspace in tugcast, so a live `GIT_LOG_QUERY` for an arbitrary `projectDir` would fall through `resolve_diff_target` to the bootstrap workspace and return the *wrong repo's* log with a matching `request_id`. Making the bootstrap `--source-tree` *be* the test repo closes the trap — the followed card's root resolves to the registered bootstrap entry and the real wire path serves the seeded repo.
- [ ] Scenario: launch (`launchTugApp` + the seeded tugbank); `bindDevSession(app, cardId, { projectDir: repo })` on a dev card (`_harness/client.ts`); focus that card; `dispatchControlAction("toggle-lens")`; `waitForCondition` on `.lens-section[data-lens-section="git-history"]`; assert the rendered `TugCodeView` text contains the seeded commit subjects most-recent-first; collapse the section and assert the band summary matches `<branch> · <n> commits` (Spec S03); assert the empty state shows before any card is bound/focused and the populated body after.
- [ ] Keep it fast and exiting; no `TUG_FORCE_BUNDLE_ID`; project-switch flow stays out per [Q02].

**Tests:**
- [ ] at0238 itself.

**Checkpoint:**
- [ ] `just app-test` (at0238 green in the suite)

---

#### Step 7: Integration Checkpoint {#step-7}

**Depends on:** #step-3, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify the full path once end-to-end: fresh app launch → dev card on a repo → Lens → Git History shows the repo's real log; make a commit in that repo, switch cards away and back → the log refreshes (the [P05] project-change path).

**Tests:**
- [ ] Aggregate: `cd tugrust && cargo nextest run` · `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test` · `just app-test`.

**Checkpoint:**
- [ ] All three suites green in one pass.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A Git History Lens section rendering the followed project's recent commits read-only, over a new GIT_LOG/GIT_LOG_QUERY snapshot feed cloned from GIT_DIFF.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `GIT_LOG` 0x25 / `GIT_LOG_QUERY` 0x26 live in Rust (three sites) and TS, in sync (byte-assert test + `tsc`).
- [ ] `build_git_log_snapshot` proven over real temp repos: commits/limit/no-repo/empty-repo/detached (`cargo nextest run -p tugcast git`).
- [ ] Full wire path proven live (`git_log_roundtrip.rs`).
- [ ] `GitLogStore` proven: parse guard, correlation filter, requested-key guard, `formatGitLog` (`bun test`).
- [ ] The section registered and rendering real commits in the real app; band summary per Spec S03 (at0238 + manual).
- [ ] All suites green: `cargo nextest run` (`-D warnings`), `bunx tsc --noEmit`, `bunx vite build`, `bun test`, `just app-test`.

**Acceptance tests:**
- [ ] `git_log_roundtrip.rs`
- [ ] `git-log-store.test.ts`
- [ ] `at0238-lens-git-history.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [x] Commit-driven refresh — **DONE** (GIT_HEAD 0x27 HEAD-sha watch, not the CHANGESET_ALL bump; see the [addendum](#post-impl-addendum) and [P05]).
- [ ] "Load more" depth beyond 20 (client-only; the wire already carries `limit` — [P04]).
- [ ] Per-commit click-to-diff riding the full sha on the wire ([P01]).
- [ ] A Find affordance driving the `TugCodeViewDelegate` ([P03]).

| Checkpoint | Verification |
|------------|--------------|
| Wire in sync | `cargo nextest run -p tugcast-core` + `bunx tsc --noEmit` |
| Builder correct | `cargo nextest run -p tugcast git` |
| Live round-trip | `cargo nextest run -p tugcast --test git_log_roundtrip` |
| Store correct | `bun test git-log-store` |
| Section real | `just app-test` (at0238) |
