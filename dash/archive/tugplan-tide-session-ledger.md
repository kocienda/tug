<!-- tugplan-skeleton v2 -->

## Tide Card Polish — Tugcast-Side Session Ledger {#tide-session-ledger}

**Purpose:** Move per-session bookkeeping out of the tugbank `sessions` map and into a purpose-built sqlite ledger inside tugcast. Add per-row metadata (turn_count, first_user_prompt, state, card_id_live), three CONTROL ops (`list_sessions`, `forget_session`, `forget_workspace_sessions`) plus a `session_updated` broadcast, and a richer picker UX showing N sessions per workspace with snippets, timestamps, and state indicators. Replaces the placeholder in the parent plan's §step-10.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | shipped |
| Target branch | tugplan-tide-session-ledger |
| Last updated | 2026-05-02 |
| Roadmap anchor | [tugplan-tide-card-polish.md §step-10](./tugplan-tide-card-polish.md#step-10) — this plan executes that step |
| Predecessors | T3.4.c §step-4-5 (resume-vs-new picker), §step-4-5-5 (chain audit), §step-4-5-6 (post-impl audit), parent §step-7-5 (transport-state lifecycle) |
| Successors | parent §step-11 (multi-turn transcript) is independent and not blocked by this plan |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Per-session bookkeeping today is spread across three tugbank entries:

- `dev.tugtool.tide / sessions` — map of `{ [claudeSessionId]: { projectDir, createdAt } }`, written by `TugbankSessionsRecorder` on `session_init`, removed on `resume_failed`.
- `dev.tugtool.tide / live-sessions` — JSON array of session ids currently bound to a card, written by `TugbankLiveSessionsTracker` on bind / close.
- `dev.tugtool.tide.session-keys` — per-card binding (`tug_session_id`, `claude_session_id`, `project_dir`, …).

The picker reads `sessions` + `live-sessions` via `useTugbankValue` and surfaces a single "Resume last session" row per workspace. T3.4.c §step-4-5 shipped that minimum. T3.4.c §step-4-5-5 hardened the chain (no silent resume fallback; live-elsewhere rejection; pre-flight stat). What's still missing is everything the *user* would actually want to see at the picker:

- "I have three sessions going in this repo — which one am I resuming?"
- "I closed a card; did that throw away my session?"
- "Two cards both resumed the same session — now the JSONL is corrupt." *(Already covered by §step-4-5-5's live-elsewhere rejection — but the picker still surfaces only the one most-recent row.)*
- "I want to forget one specific session without forgetting all of them."
- "The resume timestamp is opaque; I want to see what the conversation was about."

This plan delivers each of those. The tugbank `sessions` map and `live-sessions` set both retire in favor of a sqlite ledger inside tugcast. The picker rewires from synchronous tugbank reads to a CONTROL `list_sessions` request plus a `session_updated` push subscription. New per-row Forget actions plus per-workspace Forget-all retire sessions deliberately, with a recoverable trash subdir for the JSONL.

#### Strategy {#strategy}

- **Ledger first, consumers next.** The sqlite ledger + migration land first as an internal write target. The bridge swaps in the new recorder/tracker behind existing traits — `SessionsRecorder` and `LiveSessionsTracker` are already abstractions in `agent_supervisor.rs`. Until the picker rewires, the ledger is invisible to the user.
- **CONTROL ops, not tugbank watches.** The picker subscribes to `list_sessions` + `session_updated` broadcasts. Tugbank stays focused on per-card binding (session-keys) and out of session metadata.
- **Ledger starts empty; no data migration from tugbank.** The existing `dev.tugtool.tide / sessions` map is an index over JSONLs that still live on disk; the ledger populates organically as new sessions spawn after this lands. Existing sessions disappear from the picker's resume list, but the underlying JSONLs are untouched — backfill (scanning `~/.claude/projects/`) is a follow-on if and when anyone misses them. The old tugbank keys go quiet (no writes after [Step 2](#step-2)) and rot harmlessly. See [D09].
- **Live state moves into the ledger.** `state="live"` + `card_id_live` replace the separate `live-sessions` set. One source of truth.
- **Resume failure is a crumb, not a delete.** The supervisor stops calling `sessions_recorder.remove(stale)`; instead it sets `state="failed"`. The picker shows a greyed row with a diagnostic. Per-row Forget is the only deletion path. See [D03].
- **Eviction is automatic but bounded.** Cap per workspace (`TIDE_LEDGER_MAX_PER_WORKSPACE`, initial 20), age-based expiry (`TIDE_LEDGER_MAX_AGE`, initial 90 days). Live rows never evicted. See [D04].
- **Forget moves to trash.** Per-row Forget moves the JSONL to `<workspace>/.tug-trash/<deletedAt>/<sessionId>.jsonl`; startup sweep removes anything older than 7 days. Recoverable for a week. See [D05].
- **Picker stays a list, not a table.** Token-driven rich rows over a `<div role="radiogroup">`. No new table primitive built or required. See [D06].
- **Tuglaws cross-checked.** [L02] (picker state via `useSyncExternalStore` against the new `tideSessionLedgerStore`), [L23] (session metadata survives reconnect via the ledger's persistence). No new IndexedDB ([D-T3-10]).
- **Build stays green at every commit.** `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` pass on every step. Warnings are errors.

#### Success Criteria (Measurable) {#success-criteria}

- A `SessionLedger` exists at `tugrust/crates/tugcast/src/session_ledger.rs`, backed by sqlite under the user's data dir, with the schema in [#schema]. (Verified: file exists; `cargo nextest run` covers CRUD + eviction + sweep.)
- The old `dev.tugtool.tide / sessions` and `dev.tugtool.tide / live-sessions` tugbank keys receive no writes after this lands (the new code paths don't touch them). They're left in place as dead bytes — no migration, no deletion. (Verified: grep audit on production code returns zero writes; the keys can be cleaned up manually via `tugbank-cli` if anyone cares.)
- Picker renders N rows per workspace, ordered by `last_used_at DESC`, each row showing snippet / turn count / relative timestamp / state. (Verified: picker test fixture seeds 3 ledger rows; renders 3 rows in correct order with correct fields.)
- Picker subscribes to `session_updated` while open; turn-count tick on a live session updates its row in place without re-mount. (Verified: integration test dispatches a fake `session_updated` and asserts the rendered turn count updates.)
- Per-row Forget moves the JSONL to `<workspace>/.tug-trash/...` and removes the row. (Verified: integration test asserts both file move and ledger row removal.)
- A workspace with > 20 sessions has the oldest `state="closed"` row evicted on next spawn. (Verified: ledger unit test.)
- A workspace whose recent-projects entry is evicted has its ledger rows evicted in the same transaction. (Verified: integration test.)
- `resume_failed` retains the row with `state="failed"` and shows it greyed in the picker. (Verified: chain test.)
- `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` green at every step.

#### Scope {#scope}

1. **Ledger crate.** Sqlite schema (idempotent DDL — `CREATE TABLE IF NOT EXISTS`), CRUD API, eviction helpers. In-memory test fallback.
2. **Bridge / supervisor wiring.** New `LedgerSessionsRecorder` and the live-state collapse into ledger rows. Stops writing to the old tugbank keys; resume-failed flips `state="failed"` instead of deleting the row.
3. **CONTROL ops.** `list_sessions`, `forget_session`, `forget_project_dir_sessions`, `session_updated` broadcast. Encoders/decoders in tugdeck and tugcast. (`forget_workspace_sessions` was authored as part of the original sketch but found dead in post-ship cleanup — the picker uses per-row `forget_session` and recents-eviction uses `forget_project_dir_sessions`. The action was removed.)
4. **Tugdeck client store.** `tideSessionLedgerStore` — observes `session_updated` broadcasts, caches the workspace's session list.
5. **Picker rewires + UX.** Drop tugbank reads; render rich rows; Forget actions.
6. **Eviction + recents coherence.** Cap, age, recents↔ledger coupling.
7. **Trash + sweep.** JSONL move on Forget; startup sweep > 7 days.
8. **Tuglaws walkthrough + parent close-out.** Per-step compliance plus the close-out commit.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Server-side archival or search across prior sessions.
- Cross-machine sync.
- Session branching ("fork from turn N").
- A purpose-built table / grid component for the session list.
- Storage-pressure / response-byte tracking for a future "trim old sessions" UX. Not covered by the ledger schema in this plan.
- Collapsing `tug_session_id` and `claude_session_id` into one identifier. The dual-id model from §step-4-5-5 stays — the ledger keys on `claude_session_id` (the wire id) but the in-flight binding still uses `tug_session_id` during the spawn-handshake window. See [D08].
- Migrating the `session-keys` (per-card binding) domain off tugbank. Different concern, different lifecycle, different consumer.
- New IndexedDB-backed storage anywhere on the client side ([D-T3-10]).
- Generalizing the ledger to a multi-tenant store. One sqlite file per local user, period.

#### Dependencies / Prerequisites {#dependencies}

- Existing `SessionsRecorder` / `LiveSessionsTracker` traits in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`.
- Existing `TugbankClient` for the migration read.
- Existing `tugcast` CONTROL feed and per-card subscription model.
- Existing `TideProjectPickerForm` in `tugdeck/src/components/tugways/cards/tide-card.tsx`.
- T3.4.c §step-4-5-5 shipped — silent resume fallback removed; live-elsewhere rejection at the supervisor; tugcode `stat` pre-flight; `claudeSessionId` on `CardSessionBinding`.
- `rusqlite` — already a workspace dependency (used by `TugbankClient`).

#### Constraints {#constraints}

- **Tuglaws** [L02], [L11], [L19], [L23] apply. See [#tuglaws-cross-check].
- **Warnings are errors.** `cargo build` / `cargo nextest run` enforce `-D warnings`.
- **No data migration.** The ledger starts empty on first run. Existing sessions in the tugbank `sessions` map disappear from the picker's resume list, but their JSONL files remain on disk. Recovery (if ever needed) is a backfill that scans `~/.claude/projects/` — out of scope for this plan. See [D09].
- **HMR is always running.** No manual tugdeck builds (`feedback_hmr`).
- **Use bun, not npm** (`feedback_use_bun`).
- **No mock-store assertion tests** — picker tests dispatch through the real store + CONTROL transport (`feedback_no_mock_store_tests`).
- **happy-dom test scoping** — picker DOM-shape tests fine in happy-dom; CONTROL roundtrip + sqlite are Rust-side `cargo nextest` (`feedback_no_happy_dom_tests`).
- **No plan numbers in code** — never write `step-N` / `4.5` / `D01` into TS/Rust/comments (`feedback_no_plan_numbers_in_code`).
- **Cross-check tuglaws** before tugdeck/tugways work (`feedback_tuglaws_cross_check`).

#### Assumptions {#assumptions}

- Sqlite under `~/Library/Application Support/Tug/sessions.db` (macOS) and `$XDG_DATA_HOME/tugcast/sessions.db` (Linux) is acceptable storage. (Already established by tugbank's own sqlite location pattern.)
- `rusqlite`'s WAL mode + busy_timeout configuration is sufficient for the supervisor's write cadence (one write per `session_init` / `turn_complete` / `resume_failed` / close).
- Picker render is fast enough to absorb a CONTROL roundtrip on mount instead of synchronous tugbank reads. (Picker is opened only when a card has no binding; the user is making a deliberate choice. ~10–50ms latency is invisible.)
- The `session_updated` push is RPS-safe. Worst case: 4 cards × 1 `turn_complete` per second per card = 4 broadcasts/sec, sent to whatever pickers are open (almost always zero, since pickers are open only at card-mount time).
- Trash directory `<workspace>/.tug-trash/` does not collide with anything claude writes inside `~/.claude/projects/<workspace>/`. (Verified by inspecting claude's own write patterns: only `<sessionId>.jsonl` files at the workspace root; no nested directories.)

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows [tuglaws/tugplan-skeleton.md §reference-conventions](../tuglaws/tugplan-skeleton.md#reference-conventions). Step anchors are kebab-case `step-N`. Decisions use `dNN-...`, open questions `qNN-...`, risks `rNN-...`. References cite IDs and `#anchors`, never line numbers.

---

### Open Questions {#open-questions}

#### [Q01] `resume_failed` row retention (DECIDED) {#q01-failed-row-retention}

**Question:** When `resume_failed` fires, does the supervisor remove the ledger row (current behavior) or set `state="failed"` and retain it as a diagnostic crumb (the sketch's preference)?

**Resolution:** DECIDED — retain as `state="failed"`. Picker renders a greyed row with a diagnostic ("Couldn't resume — JSONL missing"). Per-row Forget is the only deletion path. See [D03] for rationale and the migration impact.

---

#### [Q02] `session_updated` broadcast mechanism (DECIDED) {#q02-session-updated-mechanism}

**Question:** How do pickers receive live ledger updates — a new tugcast→client CONTROL push, or piggyback on tugbank `domain-changed` notifications somehow?

**Resolution:** DECIDED — new tugcast→client CONTROL push frame, delivered on the same per-connection CONTROL feed that already carries `spawn_session_ok`, `resume_failed`, and other server-originated CONTROL messages. The frame's `action` is `"session_updated"`; the payload carries `{ session_id, fields, removed? }`. Tugcast emits the broadcast to *all* connected CONTROL feeds (the ledger is global, not per-card); each client filters in `action-dispatch.ts` and routes the payload into the local ledger store. Pickers don't subscribe explicitly — being mounted is the subscription, since the store is the receiver. Tugbank doesn't back the ledger anymore, so its `domain-changed` channel doesn't naturally cover ledger writes.

---

#### [Q03] Trash JSONL location (DECIDED) {#q03-trash-location}

**Question:** When Forget moves a JSONL out of `~/.claude/projects/<workspace>/`, where does it land?

**Resolution:** DECIDED — `~/.claude/projects/<workspace>/.tug-trash/<deletedAt>/<sessionId>.jsonl`. In-place under the workspace's claude directory, hidden via the leading dot. Restore is `mv` back. Avoids the metadata-tracking complexity of a tug-owned trash directory; claude doesn't recursively scan its own project subdirs, so the `.tug-trash/` is invisible to it. Re-evaluate if a future claude version starts walking those subdirs.

---

#### [Q04] `first_user_prompt` truncation length (OPEN) {#q04-prompt-truncation}

**Question:** How many characters of the first user message should the ledger store for the picker snippet?

**Plan to resolve:** Land [Step 1](#step-1) with the sketch's 256-char default. Iterate when the picker is wired in [Step 6](#step-6) and a real picker render shows whether 256 is too long for clean rows.

**Resolution:** OPEN. Starting preference: 256 chars at storage time, with the picker truncating further to ~64 chars for display (so the storage cost doesn't lock us into a short snippet if the picker layout changes).

---

#### [Q05] Schema migration: SQL `migrations` table or one-shot in-code? (OPEN) {#q05-migrations}

**Question:** Does the ledger keep a `migrations` table tracking applied schema versions, or apply `CREATE TABLE IF NOT EXISTS` + `ALTER` statements idempotently from code?

**Plan to resolve:** Resolve in [Step 1](#step-1). The schema is small enough that idempotent in-code DDL is the simpler choice; a `migrations` table earns its keep only when there are multiple historical schemas to track. Reconsider if the schema gains a column post-launch.

**Resolution:** DECIDED — idempotent in-code DDL for v1 (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`). A `migrations` table will be introduced on the second schema variant, not preemptively. Step 1 ships this.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Sqlite write contention with the tugcast supervisor's write cadence | low | low | WAL mode + busy_timeout; writes batched per turn_complete | Picker latency spikes during heavy turn-count ticks |
| Picker re-fetch on every `session_updated` floods the wire | low | low | Push frame carries the diff (changed fields), not a full re-fetch trigger | Profile while two cards stream concurrently |
| Forget races with an in-flight `turn_complete` that bumps `last_used_at` | low | med | Forget acquires a row-level lock and sets `state="forgotten"` before file move; turn_complete writes are no-ops on `state != "live"` | Audit fires |
| Recents↔ledger coherence diverges (recents removed, ledger row stays) | med | med | Recents eviction calls `forget_workspace_sessions` in the same code path | Manual smoke after recents cap is hit |
| User notices missing sessions in picker after first post-update launch | low | high | Documented in [D09]; backfill is a follow-on if it bites | Anyone notices |
| `state="failed"` rows accumulate without bound | low | med | Same age-based eviction (90 days) applies to `state="failed"`, not just `closed` | Picker shows > 5 failed rows in a workspace |

**Risk R01: Schema-evolution debt.** {#r01-schema-debt}

- **Risk:** v1 schema lacks fields a future picker iteration wants (e.g., assistant-bytes for storage pressure, last-error reason for resume failures).
- **Mitigation:** Plan for one schema change post-launch by adding a `migrations` table on the *second* DDL, not preemptively. Adding columns to sqlite is a one-line `ALTER TABLE`.
- **Residual risk:** The picker may want a column we didn't anticipate. Adding it is cheap.

**Risk R02: Picker emptiness on first run after update.** {#r02-empty-on-update}

- **Risk:** Existing sessions disappear from the picker's resume list when the ledger replaces the tugbank `sessions` map (the ledger starts empty by design).
- **Mitigation:** Documented in [D09]. The underlying JSONLs are untouched; sessions can be resumed by id via direct CLI in the unlikely event someone needs one. Backfill from `~/.claude/projects/` is a follow-on if anyone notices.
- **Residual risk:** "Where did my sessions go?" reaction on the first post-update launch. Acceptable for a single-user dev environment.

---

### Design Decisions {#design-decisions}

#### [D01] Sqlite-backed ledger inside tugcast (DECIDED) {#d01-sqlite-ledger}

**Decision:** The session ledger is a sqlite database file owned by the tugcast process. Schema in [#schema]. Storage location: `~/Library/Application Support/Tug/sessions.db` (macOS), `$XDG_DATA_HOME/tugcast/sessions.db` (Linux).

**Rationale:** Row-level queries with `ORDER BY last_used_at DESC`, atomic eviction, indexed lookup by `workspace_key` are exactly what sqlite is for. JSONL-per-workspace was considered: O(N) reads, no index, harder eviction, file lock contention. Sqlite already ships with `rusqlite` (workspace dep), so the only marginal cost is the schema migration — small.

**Implications:**
- Tugcast owns the DB lock. No multi-process write contention by design.
- Picker reads via CONTROL, never directly via sqlite — keeps the client / server separation clean.
- WAL mode + busy_timeout for safety; sane defaults.

---

#### [D02] CONTROL ops, not tugbank watches, for picker reads (DECIDED) {#d02-control-ops}

**Decision:** The picker reads ledger data via CONTROL `list_sessions { workspace_key }` and subscribes to `session_updated` push frames while open. Tugbank does not back the ledger's persistence and does not surface its updates.

**Rationale:** The previous architecture (sessions in tugbank, picker reads via `useTugbankValue`) was viable when "sessions" was a small map; it doesn't scale to per-row queries with metadata, and the existing `domain-changed` mechanism was never meant for high-cadence state. CONTROL ops give the picker explicit shape and let the wire carry what's actually relevant per request.

**Implications:**
- New CONTROL actions: `list_sessions`, `forget_session`, `forget_workspace_sessions`, plus the `session_updated` broadcast.
- Picker render becomes async (request → response). Acceptable: the picker is opened only on card mount.
- Pickers subscribe implicitly while mounted; tugcast doesn't track subscribers manually beyond the existing per-connection feed-set machinery.

---

#### [D03] `resume_failed` retains the row as `state="failed"` (DECIDED) {#d03-failed-retention}

**Decision:** The supervisor stops calling `sessions_recorder.remove(stale)` on `resume_failed`. The `LedgerSessionsRecorder` instead transitions the row to `state="failed"`. The picker renders failed rows greyed with a one-line diagnostic. Per-row Forget is the only deletion path.

**Rationale:** Removing the row makes the resume failure invisible at picker time — the user has no breadcrumb that the session existed. Retention preserves the user's mental model (the conversation was real; resume just couldn't reach it) and gives them an explicit Forget action to use intentionally. The `state="failed"` rows are bounded by the same eviction policy, so they don't accumulate without limit.

**Implications:**
- Behavior change from current production. Manual smoke: simulate a `resume_failed` (rename a JSONL aside), open a card, observe the failed row.
- The `live-elsewhere` rejection in §step-4-5-5 still removes the live-from-other-card *concern* via the `card_id_live` field; that is independent of `state="failed"`.

---

#### [D04] Eviction policies (DECIDED) {#d04-eviction}

**Decision:** Two eviction policies, both with named constants:

- **Cap per workspace** — `TIDE_LEDGER_MAX_PER_WORKSPACE = 20`. On `session_init`, if the workspace has ≥ 20 rows, evict the oldest `state="closed"` (or `state="failed"`) by `last_used_at`. `state="live"` rows are never evicted.
- **Age-based expiry** — `TIDE_LEDGER_MAX_AGE = 90 days`. On tugcast startup, sweep all rows where `last_used_at < now - 90d AND state != "live"`.

Recents↔ledger coherence: when a recent-projects entry is evicted ([§step-4m-of-T3.4.c](./archive/tugplan-tide-card.md#step-4m)), call `forget_workspace_sessions(workspace_key)` in the same transaction.

**Rationale:** Without eviction the ledger grows unbounded over months of use. The 20/90-day defaults match the typical "I might come back to this" window most users would recognize. Constants over magic numbers — easy to revise, easy to read.

**Implications:**
- Eviction may surprise the user if a session they cared about ages out. Mitigation: 90 days is generous.
- Live rows never evicted: a card pinned open for 91 days keeps its session alive in the ledger.
- Recents-to-ledger coupling is one-way: recents eviction → ledger eviction. The reverse (ledger eviction → recents removal) is *not* automatic; a workspace with no remembered sessions can still be a recent.

---

#### [D05] Forget moves JSONL to in-place trash (DECIDED) {#d05-trash-strategy}

**Decision:** Per-row Forget (and per-workspace Forget All) does not `unlink` the JSONL. It moves the file to `~/.claude/projects/<workspace>/.tug-trash/<deletedAt>/<sessionId>.jsonl` and deletes the ledger row. Startup sweep removes any trash subdir whose `<deletedAt>` is more than 7 days old.

**Rationale:** Forget is destructive and user-visible; making it instantly recoverable for a week is a small cost. In-place trash (under the workspace) keeps relative paths stable for restore — `mv` back to parent. Trash at the tug data dir would require recording original-path metadata; no benefit here. claude itself only opens its own `<sessionId>.jsonl` files by absolute path; it does not scan workspace subdirs, so `.tug-trash/` is invisible to it.

**Implications:**
- Restore tooling can be added later; the data is preserved.
- Sweep is on tugcast startup, not background. Simpler; low-frequency operation.
- A user who deletes `.tug-trash/` manually recovers nothing — same cost as `rm -rf` in any system. Acceptable.

---

#### [D06] Picker stays a list, not a table (DECIDED) {#d06-picker-list}

**Decision:** The picker is a `<div role="radiogroup">` with rich rows, not a `<table>`. Each row is a `<button role="radio">` carrying:

- The first user-prompt snippet (or "No prompts yet" for an empty session)
- A relative timestamp ("2h ago")
- Turn count
- A state indicator (live / failed)
- A trailing Forget action

**Rationale:** Token-driven rich rows are a known shape in the design system. A purpose-built table primitive doesn't exist and isn't worth detouring for at the row counts we expect (tens, not hundreds). If a table primitive lands upstream later, reshape; otherwise stick.

**Implications:**
- No new tugways component — the picker reuses existing primitives + per-row CSS.
- Keyboard model: arrow keys move radio selection, Enter submits, Backspace triggers Forget (with confirmation sheet).

---

#### [D07] Tugcast resolves the session id pre-spawn (DECIDED — unchanged) {#d07-cli-flag-resolution}

**Decision:** Tugcast continues to resolve the session id (via the ledger now, instead of tugbank) *before* spawning tugcode and passes it as `--session-id <id>` (new) or `--resume <id>` (resume). tugcode does not call back to the ledger over CONTROL.

**Rationale:** Tugcode stays stateless w.r.t. session bookkeeping. The pre-spawn resolution path is already in place from §step-4-5-5; this plan replaces the *source* of the id (ledger instead of tugbank) without changing the *delivery* (CLI flag).

**Implications:**
- No tugcode change for this plan beyond what § step-4-5-5 already shipped.
- Tugcast's `agent_supervisor.do_spawn_session` calls `ledger.find_for_resume(workspace_key)` instead of reading the tugbank `sessions` map. Same function shape.

---

#### [D08] Dual-id model (`tug_session_id` + `claude_session_id`) preserved (DECIDED — unchanged) {#d08-dual-id}

**Decision:** The two-identifier model from §step-4-5-5 stays. The ledger keys on `claude_session_id` (the wire id, also claude's own id, also the JSONL filename). `tug_session_id` continues to serve as the routing key during the spawn-handshake window.

**Rationale:** Collapsing the two ids would require a separate refactor of the per-card binding store and the routing path. Out of scope for this plan; the dual model is stable.

**Implications:**
- The ledger's `session_id` column refers to `claude_session_id`.
- `card_id_live` lets the live-elsewhere check use the binding store's `card_id` rather than the dual id complexity.

---

#### [D09] No data migration from tugbank — ledger starts empty (DECIDED) {#d09-no-migration}

**Decision:** The ledger sqlite file is created empty on first run. No code reads the old `dev.tugtool.tide / sessions` map or the `live-sessions` set; no rows are seeded from prior storage. The old tugbank keys go quiet (no writes after [Step 2](#step-2)) and rot in place. Any backfill from on-disk JSONLs in `~/.claude/projects/<workspace>/` is a separate, optional follow-on plan.

**Rationale:** A single-user dev environment doesn't justify the ceremony of migration code, transactional safety, idempotency proofs, and the associated test surface. The JSONL files are the actual source of truth — the tugbank map was always just an index. Skipping migration trades "picker resume list is empty for one launch" against "a hundred lines of code we'd otherwise have to write, test, and maintain forever." The trade is right for the situation.

**Implications:**
- First post-update launch: the picker resume list is empty for any workspace where the user previously had sessions. Existing JSONLs are untouched; sessions can be resumed via direct `--resume` CLI if anyone needs them.
- No `migration.rs` file. No migration tests. No idempotent-rerun gymnastics.
- The old tugbank keys can be cleaned up manually via `tugbank-cli` whenever — not a blocker.
- If picker emptiness becomes user-visible friction (it won't for a single-user dev environment, but might for a public release later), a follow-on plan can introduce a `backfill_from_jsonl` helper that scans `~/.claude/projects/<workspace>/`, reads filenames + mtimes, and synthesizes ledger rows. That work is far simpler than tugbank migration would have been.

---

### Specification {#specification}

#### Schema {#schema}

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,    -- claude_session_id; matches the on-disk JSONL filename
  workspace_key     TEXT NOT NULL,       -- canonical workspace key from tugcast
  project_dir       TEXT NOT NULL,       -- raw user path for display
  created_at        INTEGER NOT NULL,    -- unix millis
  last_used_at      INTEGER NOT NULL,    -- unix millis; updated on every turn_complete
  turn_count        INTEGER NOT NULL DEFAULT 0,
  first_user_prompt TEXT,                -- first user message body, truncated to 256 chars
  state             TEXT NOT NULL,       -- "live" | "closed" | "failed"
  card_id_live      TEXT                 -- non-NULL only while state = "live"
);

CREATE INDEX IF NOT EXISTS sessions_workspace_recent
  ON sessions(workspace_key, last_used_at DESC);
```

State values are exhaustive. Transitions:

- `INSERT … state="live", card_id_live=<card_id>` on `spawn_session_ok`.
- `UPDATE state="closed", card_id_live=NULL` on `close_session` / tugcode exit.
- `UPDATE state="failed", card_id_live=NULL` on `resume_failed` (replaces today's row removal).
- Eviction (`DELETE`) on cap or age. Forget (`DELETE` + JSONL move) on user request.

#### CONTROL ops {#control-ops}

Three new CONTROL request actions and one push:

- **`list_sessions { workspace_key }` →** `{ sessions: [SessionRow, ...] }` ordered by `last_used_at DESC`. Picker calls on mount and on path change. Empty array if no rows.
- **`forget_session { session_id }` →** `{ ok: true }` or `{ error: { reason } }`. Deletes the row; moves the JSONL to trash; broadcasts a `session_updated` push with `removed=true`. Refuses if `state="live"` (must close the card first).
- **`forget_workspace_sessions { workspace_key }` →** `{ ok: true, count }` or `{ error: { reason } }`. Batch Forget for all non-live rows in the workspace. Single transaction.
- **`session_updated { session_id, fields: Partial<SessionRow>, removed?: boolean }` →** *push frame, no request*. Delivered on the per-connection CONTROL feed (same channel as `spawn_session_ok` and `resume_failed`). Tugcast broadcasts on every ledger write — including evictions ([#step-7]) — to *all* connected CONTROL feeds. Clients route the payload through `action-dispatch.ts` into the local `TideSessionLedgerStore`; pickers consuming the store update in place. Pickers don't subscribe explicitly — being mounted is the subscription.

`SessionRow` shape on the wire:

```ts
interface SessionRow {
  session_id: string;
  workspace_key: string;
  project_dir: string;
  created_at: number;
  last_used_at: number;
  turn_count: number;
  first_user_prompt: string | null;
  state: "live" | "closed" | "failed";
  card_id_live: string | null;
}
```

#### Picker UX {#picker-ux}

The picker form layout (top-down):

1. **Path input** (unchanged from current).
2. **Recents quick-pick row** (unchanged from §step-4m-of-T3.4.c — clicking fills input).
3. **Session list**, rendered when the typed path matches a workspace with one or more rows:
   - **"Start fresh"** row, always first, selected by default.
   - **N "Resume session" rows**, ordered by `last_used_at DESC`. Each row shows:
     - Snippet: `first_user_prompt` truncated to ~64 chars in the row, with full text in a tooltip / aria-label. "No prompts yet" italicized for null.
     - Relative timestamp: "just now", "2h ago", "yesterday", "3d ago", "Mar 12".
     - Turn count: "5 turns" for `turn_count > 0`, blank for 0.
     - State indicator: small tinted pill — "live", "failed". Closed is the unstyled default (no pill).
     - Trailing Forget button (icon-only, `aria-label="Forget session"`). Disabled when `state="live"` and `card_id_live != this.cardId`.
4. **Footer "Forget all sessions for this workspace" button**, rendered when there are any non-live rows.
5. **Open button** (unchanged).

Greyed states:

- `state="live" && card_id_live != this.cardId` — row greyed, click rejected with subtitle "Live in another card".
- `state="failed"` — row greyed, subtitle "Couldn't resume — JSONL missing".

Live updates: while the picker is mounted, `session_updated` push frames update rows in place (no flash, no re-mount). Specifically: turn count tick, `last_used_at` re-sort, state transition.

Loading state: the first `getSnapshot(workspace)` call after the workspace path is typed (or selected from recents) returns `{ status: "pending", rows: [] }`. The picker renders a subdued "…" placeholder under the path input — *not* an empty list of rows, which would falsely advertise "no sessions to resume." The placeholder reads as "checking…" in the order of ~10–50ms. Connection-restore re-fetch (per [Step 4](#step-4)'s `invalidateAll`) puts the picker back through the same flow.

Keyboard: arrow keys navigate rows (Start fresh + N resume rows); Enter submits; Backspace on a row triggers Forget *with confirmation sheet* — a separate `<TugSheet>` modal asks "Forget session — this is destructive but recoverable for 7 days. Continue?" with cancel + confirm.

#### Public API {#public-api}

Tugdeck side:

```ts
// Cache-miss / loading status for a workspace's session list. Distinguishes
// "really empty" (no sessions ever) from "request in flight" (don't render
// the empty state yet; show a spinner / placeholder).
export type WorkspaceLoadStatus = "idle" | "pending" | "ready" | "error";

export interface WorkspaceSnapshot {
  status: WorkspaceLoadStatus;
  rows: readonly SessionRow[];  // empty array while status === "pending" or "error"
  error?: { reason: string };
}

// New store backing the picker's session list view.
export interface TideSessionLedgerStore {
  // Subscribe + getSnapshot per useSyncExternalStore.
  subscribe(listener: () => void): () => void;
  // Returns the cached snapshot for the workspace. The first call for a
  // workspace key triggers a CONTROL list_sessions request and returns
  // { status: "pending", rows: [] }; the response settles the snapshot to
  // { status: "ready", rows: [...] }. Subsequent calls return the cached
  // snapshot; session_updated pushes update it in place.
  getSnapshot(workspaceKey: string): WorkspaceSnapshot;
  // Imperative actions; return a Promise that resolves when the CONTROL ack is received.
  forgetSession(sessionId: string): Promise<{ ok: true } | { error: { reason: string } }>;
  forgetWorkspaceSessions(
    workspaceKey: string,
  ): Promise<{ ok: true; count: number } | { error: { reason: string } }>;
  // Invalidate every cached workspace and refetch. Called on transport_settled
  // (per Step 7.5's transport-state lifecycle) so a connection bounce doesn't
  // leave the cache stale with missed session_updated pushes.
  invalidateAll(): void;
}
```

Tugcast side:

```rust
pub struct SessionLedger {
    db: Arc<Mutex<rusqlite::Connection>>,
}

impl SessionLedger {
    pub fn open(path: &Path) -> Result<Self, LedgerError>;

    pub fn list_for_workspace(
        &self,
        workspace_key: &str,
    ) -> Result<Vec<SessionRow>, LedgerError>;

    pub fn find_for_resume(
        &self,
        workspace_key: &str,
    ) -> Result<Option<SessionRow>, LedgerError>;

    pub fn record_spawn(
        &self,
        session_id: &str,
        workspace_key: &str,
        project_dir: &str,
        card_id: &str,
        now: i64,
    ) -> Result<(), LedgerError>;

    pub fn record_first_prompt(
        &self,
        session_id: &str,
        prompt: &str,  // truncated by caller
    ) -> Result<(), LedgerError>;

    pub fn record_turn(&self, session_id: &str, now: i64) -> Result<(), LedgerError>;

    pub fn mark_closed(&self, session_id: &str) -> Result<(), LedgerError>;
    pub fn mark_failed(&self, session_id: &str) -> Result<(), LedgerError>;

    pub fn forget(&self, session_id: &str) -> Result<ForgetOutcome, LedgerError>;
    pub fn forget_workspace(
        &self,
        workspace_key: &str,
    ) -> Result<ForgetWorkspaceOutcome, LedgerError>;

    pub fn evict_oldest_closed(
        &self,
        workspace_key: &str,
        cap: usize,
    ) -> Result<usize, LedgerError>;
    pub fn sweep_expired(&self, max_age_ms: i64, now: i64) -> Result<usize, LedgerError>;
}
```

#### Bootstrap (no migration) {#bootstrap}

On tugcast startup the ledger initializer runs `CREATE TABLE IF NOT EXISTS sessions(...)` plus `CREATE INDEX IF NOT EXISTS sessions_workspace_recent` against the sqlite file at the data-dir path. That's the entire startup ceremony — no read of the old tugbank `sessions` / `live-sessions` keys, no row synthesis, no transactional handoff. Per [D09].

The old tugbank keys are no longer written to (the bridge wires them out in [Step 2](#step-2)); they remain in-place until removed manually if anyone bothers.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|-|-|
| `tugrust/crates/tugcast/src/session_ledger.rs` | Ledger crate — schema, CRUD, eviction, sweep |
| `tugrust/crates/tugcast/tests/session_ledger.rs` | nextest unit suite |
| `tugdeck/src/lib/tide-session-ledger-store.ts` | Tugdeck client store |
| `tugdeck/src/lib/__tests__/tide-session-ledger-store.test.ts` | Store tests |
| `tugdeck/src/components/tugways/cards/__tests__/tide-card-session-picker.test.tsx` | Picker rich-rows tests |

#### Modified files {#modified-files}

| File | Change |
|-|-|
| `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | Drop `TugbankSessionsRecorder` / `TugbankLiveSessionsTracker` impls; introduce `LedgerSessionsRecorder` |
| `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` | Bridge calls swap from `recorder.remove(stale)` to `recorder.mark_failed(stale)` for `resume_failed` |
| `tugrust/crates/tugcast/src/main.rs` | Open the ledger on startup |
| `tugrust/crates/tugcast/src/router.rs` | Route the new CONTROL actions to handlers |
| `tugrust/crates/tugcast/src/actions.rs` | Add `ListSessions`, `ForgetSession`, `ForgetWorkspaceSessions`, `SessionUpdated` action enums |
| `tugdeck/src/protocol.ts` | `encodeListSessions`, `encodeForgetSession`, `encodeForgetWorkspaceSessions`, `decodeSessionUpdated` |
| `tugdeck/src/action-dispatch.ts` | Dispatch `session_updated` into the new ledger store |
| `tugdeck/src/components/tugways/cards/tide-card.tsx` | Picker rewires; rich rows; Forget actions |
| `tugdeck/src/components/tugways/cards/tide-card.css` | Row styles, state pill, Forget button, confirmation sheet |
| `tugdeck/src/lib/code-session-store/reducer.ts` | (no change expected; flag for verification) |

#### Symbols {#symbols}

| Symbol | Kind | Location | Notes |
|-|-|-|-|
| `SessionLedger` | struct | `session_ledger.rs` | Public API surface above |
| `SessionRow` | struct | `session_ledger.rs` | Wire-shape mirror in tugdeck `protocol.ts` |
| `LedgerError` | enum | `session_ledger.rs` | sqlite + IO errors |
| `ForgetOutcome` | struct | `session_ledger.rs` | `{ jsonl_moved_to: PathBuf }` |
| `LedgerSessionsRecorder` | struct | `agent_supervisor.rs` | Implements existing `SessionsRecorder` trait against the ledger |
| `TIDE_LEDGER_MAX_PER_WORKSPACE` | const | `session_ledger.rs` | 20 |
| `TIDE_LEDGER_MAX_AGE_DAYS` | const | `session_ledger.rs` | 90 |
| `TIDE_TRASH_SWEEP_AGE_DAYS` | const | `session_ledger.rs` | 7 |
| `TideSessionLedgerStore` | class | `tide-session-ledger-store.ts` | Public API surface above |
| `useSessionLedger(workspaceKey)` | hook | `tide-session-ledger-store.ts` | `useSyncExternalStore` wrapper |
| `encodeListSessions` etc. | functions | `protocol.ts` | Encoders for the new CONTROL ops |

---

### Documentation Plan {#documentation-plan}

- [x] Module docstring on `session_ledger.rs` per the schema and state-machine in [#schema].
- [x] Module docstring on `tide-session-ledger-store.ts` describing the cache + push-update model.
- [x] Update `tide.md` § code-session-store to point at the new ledger (replacing the tugbank `sessions` map references).
- [x] Add a brief paragraph to `tuglaws/component-authoring.md` on "stores that observe CONTROL push frames" — the ledger store is the second consumer (after the live-sessions broadcast handling that §step-4-5-5 introduced).

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | When |
|-|-|-|
| Rust unit (`cargo nextest`) | `SessionLedger` CRUD, eviction, sweep — against an in-memory sqlite DB | [Step 1](#step-1) |
| Rust integration (`cargo nextest`) | Bridge / supervisor wiring — record_spawn → record_first_prompt → record_turn → mark_closed flow; resume-failed retains row | [Step 2](#step-2) |
| Protocol encoders + handlers | CONTROL request/response shape against a fake transport | [Step 3](#step-3) |
| Tugdeck unit | `TideSessionLedgerStore` cache + push-update mechanics | [Step 4](#step-4) |
| Tugdeck integration (happy-dom) | Picker render with N rows, click Forget, confirmation sheet, Forget All footer | [Step 6](#step-6) |
| Eviction + trash integration (`cargo nextest`) | Cap / age eviction; recents coherence; trash move-on-Forget; startup sweep | [Step 7](#step-7), [Step 8](#step-8) |
| Chain-shape tests (extends `R-CHAIN-*` from §step-4-5-5) | Live-elsewhere uses ledger `card_id_live`; eviction during heavy use | [Step 7](#step-7) |
| End-to-end smoke (manual) | Open card; spawn; submit; close; reopen; pick from N rows; Forget; restore from trash | [Step 9](#step-9) |

---

### Tuglaws Cross-Check {#tuglaws-cross-check}

- **L02** — `TideSessionLedgerStore` exposes `subscribe` / `getSnapshot` and is consumed via `useSyncExternalStore`. CONTROL push frames update the store's internal cache; the snapshot is stable across no-op ticks.
- **L03** — n/a (no DOM lifecycle dependencies in the store).
- **L06** — picker row appearance flows through CSS + `[data-state]` attributes; no React state for greyed/active styling.
- **L07** — `handleForget` reads the store via ref; no stale closures over the session id.
- **L11** — Forget button dispatches `forget_session` action through the responder chain so the confirmation sheet's affirm consumes the correct row.
- **L19** — picker remains a function-of-store; new helper modules under `lib/`.
- **L23** — session metadata survives reconnect via the on-disk ledger; in-flight pickers re-fetch on reconnect (`session_updated` push doesn't reach a closed connection).

---

### Execution Steps {#execution-steps}

> Each step is its own commit. `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` pass at the end of every step.

#### Step 1: Ledger crate + schema {#step-1}

**Commit:** `tide(ledger): SessionLedger crate (sqlite-backed)`

**References:** [D01] sqlite-ledger, [D04] eviction, [D09] no-migration, [#schema], [#bootstrap], [Q05] migrations strategy

**Artifacts:**
- New `tugrust/crates/tugcast/src/session_ledger.rs` exporting `SessionLedger`, `SessionRow`, `LedgerError`, `ForgetOutcome`, `ForgetWorkspaceOutcome`, `SessionState`, plus the `TIDE_LEDGER_*` and `FIRST_USER_PROMPT_MAX_CHARS` constants.
- Inline `#[cfg(test)] mod tests` covering CRUD + eviction + sweep + idempotent open + helpers. (Tugcast is a binary crate without a `lib.rs`, so an integration test file at `tests/session_ledger.rs` cannot import the module; the inline pattern matches the rest of the crate — `actions.rs`, `router.rs`, `agent_supervisor.rs`.)
- `rusqlite` promoted from dev-dep to runtime dep on tugcast.

**Tasks:**
- [x] Author the schema and state machine per [#schema]. Use `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` (resolves [Q05] in favor of in-code DDL for v1).
- [x] Implement the public API surface from [#public-api]. Each method is a single transaction.
- [x] Configure WAL mode + `busy_timeout` on connection open.
- [x] Author Rust tests:
  - CRUD round-trip per state transition.
  - Eviction: insert 21 rows, verify oldest closed evicted on the 21st.
  - Sweep: insert a row with `last_used_at` = 91 days ago, verify swept on `sweep_expired`.
  - Idempotent open: open the same ledger file twice, verify the second open is a no-op (no DDL re-run failures).

**Tests:**
- [x] `cargo nextest run -p tugcast session_ledger` green (26 tests).

**Checkpoint:**
- [x] `cargo nextest run` (workspace-wide; new tests + no regressions — 1175 passed)
- [x] `cargo build` (no warnings)

---

#### Step 2: Wire the bridge to write the ledger {#step-2}

**Depends on:** #step-1

**Commit:** `tide(ledger): replace TugbankSessionsRecorder with LedgerSessionsRecorder`

**References:** [D01] sqlite-ledger, [D03] failed-retention, [D08] dual-id-preserved, (#scope)

**Artifacts:**
- `SessionRecord<'_>` struct + redesigned `SessionsRecorder` trait (`record`, `record_turn`, `mark_closed`, `mark_failed`, `remove` — no default impls).
- `LedgerSessionsRecorder` struct in `agent_supervisor.rs` backed by `Arc<SessionLedger>`.
- `TugbankSessionsRecorder`, `TugbankLiveSessionsTracker`, and the `LiveSessionsTracker` trait removed entirely. The live broadcast that those owned now lives in the ledger row's `state="live"` + `card_id_live` columns.
- `tugrust/crates/tugcast/src/main.rs` opens the ledger via `SessionLedger::open(SessionLedger::default_path())` on startup, runs `demote_live_to_closed()` (the new equivalent of the old `LiveSessionsTracker.clear()`), and constructs `LedgerSessionsRecorder`.
- `agent_bridge.rs` swap: `sessions_recorder.remove(stale)` → `sessions_recorder.mark_failed(stale)` for `resume_failed`. New: bridge detects `{"type":"result"}` lines and calls `record_turn`. New: bridge captures `workspace_key` + `card_id` from the entry under the `session_init` lock so the recorder gets the full `SessionRecord<'_>`.
- `do_close_session` snapshots `claude_session_id` under the entry lock (alongside `workspace_key`) and dispatches `mark_closed` after Phase 5's wire publish.
- New `demote_live_to_closed()` method on `SessionLedger`.

**Tasks:**
- [x] Extend `SessionsRecorder` trait with `record_turn`, `mark_closed`, `mark_failed` — **no default impls**. Every implementor must provide them explicitly. (A default forwarding to `remove` would silently preserve the exact behavior this plan replaces; the compile error from a missing impl is the regression-protection.)
- [x] Author `LedgerSessionsRecorder` implementing all five trait methods. Each dispatches to the right `SessionLedger` API.
- [x] Update `main.rs` to open the ledger (`SessionLedger::open(...)`), call `demote_live_to_closed()`, construct the new recorder, hand it to the supervisor. No migration step.
- [x] Drop `TugbankLiveSessionsTracker` (and the `LiveSessionsTracker` trait) — its responsibility (live-set broadcasting) is now a function of `state="live"` queries against the ledger.
- [x] Update the bridge call site for `resume_failed` to use `mark_failed`. Wire `record_turn` to `{"type":"result"}` lines. Wire `mark_closed`/`mark_failed` to the bridge's terminal teardown paths (close, crash exhaustion).
- [x] Update test stubs (`NoopSessionsRecorder` to new shape; drop `NoopLiveSessionsTracker`).

**Tests:**
- [x] Existing `agent_bridge` / `agent_supervisor` tests pass against the new recorder (482 tugcast tests green; 1183 workspace-wide).
- [x] New unit tests covering `LedgerSessionsRecorder` lifecycle: `record` inserts a live row; `record → record_turn × 3 → mark_closed` reflects each transition; `mark_failed` retains the row as failed; `remove` deletes; `record_turn` no-ops on a closed row.
- [x] New integration test: `do_close_session` calls `mark_closed` on the ledger when the entry has a `claude_session_id`.

**Checkpoint:**
- [x] `cargo nextest run` — 1183 passed
- [x] `cargo build` — no warnings

---

#### Step 3: CONTROL ops + tugcast handlers {#step-3}

**Depends on:** #step-2

**Commit:** `tide(ledger): list_sessions, forget_session, session_updated CONTROL ops`

**References:** [D02] control-ops, [#control-ops], [Q02] session-updated-mechanism

**Artifacts:**
- `agent_supervisor.rs` extends `AgentSupervisor` with `Option<Arc<SessionLedger>>` and adds `do_list_sessions`, `do_forget_session`, `do_forget_workspace_sessions` handlers + `parse_workspace_key_payload` / `parse_session_id_payload` helpers + `MissingWorkspaceKey` `ControlError` variant.
- `LedgerSessionsRecorder::with_broadcast(ledger, control_tx)` constructor: every successful write (record/record_turn/mark_closed/mark_failed/remove) emits a `session_updated` push frame on the CONTROL feed.
- `build_session_updated_frame(row)` and `build_session_removed_frame(session_id)` helpers shared by the recorder and the supervisor's batch Forget paths.
- `router.rs` extends `SUPERVISOR_SESSION_ACTIONS` with `list_sessions`, `forget_session`, `forget_workspace_sessions` and maps `MissingWorkspaceKey` to its CONTROL error detail.
- `tugdeck/src/protocol.ts` adds `encodeListSessions`, `encodeForgetSession`, `encodeForgetWorkspaceSessions`, `decodeSessionUpdated`, plus `SessionRow` and `SessionUpdatedPush` interfaces.
- New `tugdeck/src/lib/tide-session-ledger-events.ts` — process-global pub/sub for the response/push frames so the action dispatcher publishes events that the (step-4) store will subscribe to.
- `tugdeck/src/action-dispatch.ts` registers handlers for `session_updated`, `list_sessions_ok/err`, `forget_session_ok/err`, `forget_workspace_sessions_ok/err`, each forwarding to the events module.

**Tasks:**
- [x] Define `SessionRow` in the ledger crate with serde derive. Mirror in `protocol.ts`.
- [x] Implement the three request handlers in tugcast: each calls the matching `SessionLedger` API, serializes the response, returns. `forget_session` rejects when `state="live"` (mapped to `forget_session_err { reason: "session_is_live" }`).
- [x] Implement the broadcast: every successful recorder write emits a `session_updated` push to all CONTROL subscribers via `LedgerSessionsRecorder::with_broadcast`. Batch Forget paths emit one push per dropped row.
- [x] Encoders in `protocol.ts` mirror the existing `encodeSpawnSession` style.
- [x] `action-dispatch.ts` decode-side identifies `session_updated` plus the six ack frames and routes them through `tide-session-ledger-events`. Step 4 wires the store as the subscriber.

**Tests:**
- [x] Rust integration test: send `list_sessions { workspace_key }`, assert `list_sessions_ok` response carries the rows in `last_used_at DESC` order; rows from other workspaces are excluded.
- [x] Rust integration test: send `forget_session`, assert ledger row removed and both `session_updated { removed: true }` and `forget_session_ok` are broadcast.
- [x] Rust integration test: `forget_session` on a live row returns `forget_session_err { reason: "session_is_live" }` and the row is retained.
- [x] Rust integration test: `forget_workspace_sessions` drops every non-live row in the workspace, leaves live and other-workspace rows intact, broadcasts `forget_workspace_sessions_ok { count }`.
- [x] Rust integration test: a `record` followed by a `record_turn` against the recorder produces two `session_updated` pushes with `turn_count` 0 and 1 respectively.
- [x] Rust integration test: `list_sessions` with a missing `workspace_key` returns `ControlError::MissingWorkspaceKey`.
- [x] Tugdeck unit test: each new encoder produces the documented JSON shape; `decodeSessionUpdated` round-trips full updates and removed markers and rejects malformed payloads.

**Checkpoint:**
- [x] `cargo nextest run` — 488 tugcast tests passing
- [x] `bun x tsc --noEmit` — clean
- [x] `bun test` — 2750 tugdeck tests passing
- [x] `bun run audit:tokens lint` — zero violations

---

#### Step 4: Tugdeck `TideSessionLedgerStore` {#step-4}

**Depends on:** #step-3

**Commit:** `tide(ledger): tugdeck client store with CONTROL push subscription`

**References:** [D02] control-ops, [Q02] session-updated-mechanism, [#public-api], [L02]

**Artifacts:**
- New `tugdeck/src/lib/tide-session-ledger-store.ts` — `TideSessionLedgerStore` class, `useSessionLedger(workspaceKey)` hook, `attachTideSessionLedgerStore(connection)` singleton wire-up.
- `tugdeck/src/main.tsx` calls `attachTideSessionLedgerStore(connection)` after the deck manager is wired.
- The events bus from step 3 (`tide-session-ledger-events.ts`) is the channel through which the store receives push + ack frames.

**Tasks:**
- [x] Author the store: in-memory `Map<workspaceKey, WorkspaceSnapshot>` cache plus a reverse `session_id → workspace_key` index for O(1) push routing.
- [x] First-observation flow: `getSnapshot(workspace)` returns `{ status: "pending", rows: [] }` and dispatches a `list_sessions` request. `list_sessions_ok` settles the snapshot to `{ status: "ready", rows }`.
- [x] Patch logic: `session_updated { session_id, fields }` locates the workspace via the reverse index (or the payload's `workspace_key` for never-seen ids), replaces the row, re-sorts by `last_used_at DESC`, emits a tick. Ignores pushes for uncached workspaces (with index update).
- [x] `session_updated { removed: true }` drops the row from whichever workspace holds it.
- [x] `forgetSession` / `forgetWorkspaceSessions` dispatch CONTROL requests and resolve with the ack via the events bus subscriptions.
- [x] `invalidateAll()` clears every cached entry; next `getSnapshot` per workspace re-issues `list_sessions`. Hooked to `connectionDidReconnect` from `connection-lifecycle` (the meaningful "transport recovered after a close" signal).
- [x] `useSessionLedger(workspaceKey)` hook wraps `useSyncExternalStore` with a frozen idle snapshot for the no-store / SSR fallback path.

**Tests:**
- [x] Unit test: first call returns `pending`; `list_sessions_ok` transitions to `ready`.
- [x] Unit test: snapshot-stability when no changes (same reference returned).
- [x] Unit test: `session_updated` patch updates the row in place + re-sorts.
- [x] Unit test: `session_updated { removed: true }` removes the row.
- [x] Unit test: `session_updated` for an uncached workspace is ignored (but indexed for later).
- [x] Unit test: `invalidateAll()` flips ready entries to idle; the next `getSnapshot` re-issues the request.
- [x] Unit test: `forgetSession` resolves `{ ok: true }` on `_ok` and `{ error: { reason } }` on `_err`.
- [x] Unit test: `forgetWorkspaceSessions` resolves with `count` from the ack.
- [x] Unit test: `list_sessions_err` flips snapshot to `error` with the wire reason.
- [x] Unit test: encoders + `decodeSessionUpdated` (covered in step 3 protocol tests).

**Checkpoint:**
- [x] `bun x tsc --noEmit` — clean
- [x] `bun test src/lib/__tests__/tide-session-ledger-store.test.ts` — 12 passed
- [x] `bun test` — 2762 tests passing (12 net new)
- [x] `bun run audit:tokens lint` — zero violations

---

#### Step 5: Picker rewires to the ledger store (with brief loading state) {#step-5}

**Depends on:** #step-4

**Commit:** `tide(ledger): picker reads from ledger store, drops tugbank watches`

**References:** [D02] control-ops, [D08] dual-id-preserved, (#picker-ux)

**Artifacts:**
- `tide-card.tsx` drops `useTugbankValue("dev.tugtool.tide", "sessions", …)` and `…"live-sessions", …)` in favor of `useSessionLedger(trimmedPath)`.
- `resumeCandidate` derivation reads the ready snapshot's first non-live row; `candidateLiveElsewhere` reads the newest row's `state === "live"` flag.
- A `resumePending` flag derived from `sessionLedger.status === "pending"` collapses into `resumeDisabled` — the resume row is disabled (rather than flashing in then out) until the server's `list_sessions_ok` lands. Typical settle latency is ~10–50ms.
- Wire-shape change: the `list_sessions` CONTROL request now carries `project_dir` instead of `workspace_key`. The server matches the ledger's `project_dir` column so the picker can use the user's typed path directly — no client-side canonicalization (the firmlink-resolved `workspace_key` is unknowable client-side without a server roundtrip).
- New `SessionLedger::list_for_project_dir(project_dir)` method on the Rust side.

**Tasks:**
- [x] Replace the two `useTugbankValue` calls with `useSessionLedger(trimmedPath)`.
- [x] Branch on snapshot `status`: `"pending"` collapses into `resumeDisabled` so the row isn't briefly enabled with no candidate; `"ready"` renders the resume row from the snapshot's first non-live row.
- [x] Delete `parseAllSessions` and `parseLiveSessions` parsers + the matching empty-stable references (`EMPTY_SESSION_RECORDS`, `EMPTY_STRING_SET`).
- [x] Refactor `resumeCandidate` to pick the most recent non-live row from the ledger snapshot's `rows`.
- [x] Refactor `candidateLiveElsewhere` to use the newest row's `state === "live"`.
- [x] Rename the `list_sessions` wire field from `workspace_key` to `project_dir`; update Rust handler, encoder, action-dispatch, events bus, store, and tests in lockstep.
- [x] Add `SessionLedger::list_for_project_dir` method matching the new wire contract.
- [x] Pre-attach the ledger store inside `renderTideCard` test fixture so existing picker tests can simulate `list_sessions_ok` via the events bus.

**Tests:**
- [x] Existing 15 picker tests in `tide-card.test.tsx` pass against the ledger-backed snapshot. T-TIDE-RESUME-02/03/04/04b updated to seed via `seedLedgerForPath` instead of writing the legacy tugbank `sessions` map.
- [x] T-TIDE-RESUME-06 (the no-spawn-on-recent-click regression) updated to filter for `spawn_session` frames specifically — the picker now also dispatches `list_sessions` on path change, which is expected.
- [x] All tugdeck protocol + store tests pass against the renamed wire field.
- [x] All 488 tugcast tests pass against the new `do_list_sessions` payload shape.

**Checkpoint:**
- [x] `bun x tsc --noEmit` — clean
- [x] `bun test` — 2762 tests passing
- [x] `bun run audit:tokens lint` — zero violations
- [x] `cargo nextest run -p tugcast` — 488 tests passing

---

#### Step 6: Picker UX — rich rows + Forget {#step-6}

**Depends on:** #step-5

**Commit:** `tide(ledger): rich resume rows with snippets, Forget actions`

**References:** [D03] failed-retention, [D05] trash-strategy, [D06] picker-list, [Q04] prompt-truncation, (#picker-ux)

**Artifacts:**
- `tide-card.tsx` renders N+1 rows per typed path: a synthetic Start-fresh radio plus one row per non-empty ledger row, ordered newest-first by `last_used_at`.
- Each row carries a snippet (truncated to 64 chars, multi-line collapsed), relative timestamp, turn count, and short id; live + failed rows show a TugBadge pill.
- Per-row Forget button (revealed on hover/focus) — clicking dispatches `forgetSession(session_id)` via the ledger store; the resulting `session_updated { removed: true }` push patches the snapshot and the row vanishes without re-mount.
- Footer Forget All button — iterates non-live rows and dispatches one `forgetSession` per row (Forget-by-typed-path is implemented client-side because the server's `forget_workspace_sessions` keys on canonical workspace_key, which the picker doesn't have).
- `tide-card.css` adds row layout, Forget button reveal-on-hover, footer styling.
- 5 new picker tests (T-TIDE-LEDGER-01 through 05).

**Tasks:**
- [x] Implement the rich-row renderer using existing primitives (`TugBadge` for state pills, plain `<button>` for Forget so click events can `stopPropagation` against the radio).
- [x] Implement relative-timestamp helper (`formatRelativeTimestamp` — local to `tide-card.tsx`; no shared helper existed).
- [x] Confirmation sheet for Forget — implemented. The picker form swaps to a confirmation panel (in the same TugSheet body so there's no nested overlay) carrying the plan's exact copy: "This is destructive but recoverable for 7 days. Continue?" Cancel returns to the picker with path + selected-row preserved; Forget dispatches `forget_session`. Same panel handles Forget All.
- [x] Keyboard handling: arrow + Enter work via `TugRadioGroup`. Backspace on a focused resume row routes through the same confirmation panel; Backspace on Start-fresh is a no-op.
- [x] Greying logic per [#picker-ux] (live row disabled with "live" pill; failed row shows "failed" pill; resume button text-styled the same).
- [x] Footer Forget All implemented as N per-row dispatches (no server-side workspace-key lookup needed).
- [x] State machine: replaced `sessionMode: "new" | "resume"` with `selectedRow: "new" | <session_id>` so each row is a stable radio value.

**Tests:**
- [x] Picker test: 3 ledger rows render as 3 resume rows + 1 Start fresh, in `last_used_at DESC` order. (T-TIDE-LEDGER-01)
- [x] Picker test: live row is disabled and renders the "live" pill. (T-TIDE-LEDGER-02)
- [x] Picker test: clicking Forget dispatches `forget_session` for the matching id. (T-TIDE-LEDGER-03)
- [x] Picker test: Forget All sends one `forget_session` per non-live row; live rows untouched. (T-TIDE-LEDGER-04)
- [x] Picker test: a `session_updated`-shaped push (re-publishing `list_sessions_ok` with mutated rows) updates the visible turn count. (T-TIDE-LEDGER-05)
- [x] Existing 4 RESUME tests reseeded against the new N+1 picker shape (1 row when no sessions, 2 rows when 1 session, etc.).

**Checkpoint:**
- [x] `bun x tsc --noEmit` — clean
- [x] `bun test` — 2767 tests passing (5 new for Step 6)
- [x] `bun run audit:tokens lint` — zero violations

---

#### Step 7: Eviction + recents↔ledger coherence {#step-7}

**Depends on:** #step-6

**Commit:** `tide(ledger): cap, age-based expiry, recents coherence`

**References:** [D04] eviction, (#scope)

**Artifacts:**
- `evict_oldest_closed` and `sweep_expired` on `SessionLedger` now return `Vec<String>` (the evicted ids) instead of a count, so the recorder can broadcast a removed-push per id.
- `LedgerSessionsRecorder` adds `evict_for_workspace`, `sweep_expired_with_broadcast`, and `forget_for_project_dir`. The trait gains `evict_for_workspace`; the bridge calls it after each successful `record`.
- `main.rs` runs `sweep_expired_with_broadcast` after `demote_live_to_closed` on tugcast startup.
- New `SessionLedger::forget_for_project_dir(project_dir)` for the recents-eviction → ledger-eviction coupling.
- New CONTROL action: `forget_project_dir_sessions { project_dir }` → `forget_project_dir_sessions_ok { project_dir, count }` plus per-row `session_updated { removed: true }`.
- `tugdeck/src/protocol.ts` adds `encodeForgetProjectDirSessions`.
- `tugdeck/src/lib/card-services-store.ts` computes the set difference `current \ updated` after `insertTideRecentProject`, then dispatches `forget_project_dir_sessions` for each evicted path. Fire-and-forget; the resulting push frames patch the picker's cache.

**Tasks:**
- [x] Add the cap-eviction call to the bridge's spawn path (after `record`). Bridge passes `TIDE_LEDGER_MAX_PER_WORKSPACE` to `recorder.evict_for_workspace`.
- [x] Add the startup age sweep in `main.rs`. Runs after `demote_live_to_closed` and before constructing the recorder Arc.
- [x] **Eviction broadcasts.** Every evicted row emits `session_updated { session_id, removed: true }` on the CONTROL feed — both cap-path and age-path. The recorder's helpers loop over the `Vec<String>` returned by the ledger and broadcast each id via `build_session_removed_frame`.
- [x] Recents-eviction → ledger-eviction. `card-services-store.ts` diffs the recents list before/after `insertTideRecentProject` and fires `encodeForgetProjectDirSessions(path)` for each evicted path.

**Tests:**
- [x] Rust unit (already passing): cap eviction returns the dropped session id; ordering is `last_used_at ASC` so the oldest goes first.
- [x] Rust unit: `evict_oldest_closed_caps_non_live_count` validates that 21 closed rows + 5 live rows → 1 closed evicted, all live rows survive.
- [x] Rust integration: `evict_for_workspace_emits_removed_pushes` — recorder emits one `session_updated { removed: true }` per evicted id on the CONTROL feed.
- [x] Rust integration: `forget_project_dir_sessions_drops_matching_only` — handler drops by project_dir, leaves other workspaces untouched, emits the ok ack with count.
- [x] Rust unit: `forget_for_project_dir_drops_matching_rows_only` — direct ledger test.
- [x] Rust unit (already passing): `sweep_expired_*` tests — return shape is `Vec<String>`.
- [x] Tugdeck integration test for recents-eviction → ledger-eviction — `tugdeck/src/__tests__/recents-eviction-ledger.test.tsx` covers three cases: cap-eviction dispatches `forget_project_dir_sessions` for the dropped path; under-cap binding does not; dedup-promotion of an existing path also does not.

**Checkpoint:**
- [x] `cargo nextest run` — 1192 tests passing (3 new for Step 7)
- [x] `cargo build` — no warnings
- [x] `bun test` — 2767 tests passing
- [x] `bun x tsc --noEmit` — clean

---

#### Step 8: Trash + sweep {#step-8}

**Depends on:** #step-7

**Commit:** `tide(ledger): trash-on-Forget + 7-day sweep`

**References:** [D05] trash-strategy, (#scope)

**Artifacts:**
- `SessionLedger` gains a `claude_projects_root: PathBuf` field. `open` resolves the default (`~/.claude/projects/`); `open_with_claude_root` lets tests inject a tempdir.
- `forget`, `forget_workspace`, and `forget_for_project_dir` all read `project_dir` for each doomed row and move `<root>/<encoded>/<sessionId>.jsonl` to `<root>/<encoded>/.tug-trash/<deletedAt>/<sessionId>.jsonl`. Best-effort: a missing JSONL or failed rename logs a warning but doesn't fail the row delete.
- `ForgetOutcome::jsonl_moved_to: Option<PathBuf>` — `Some(...)` when the file was moved, `None` when there was nothing to move (or the move failed).
- New `SessionLedger::sweep_trash(max_age_ms, now) -> usize` walks every distinct project_dir's `.tug-trash/<deletedAt>/` and removes subdirs older than the cap. Returns the count.
- New helpers: `default_claude_projects_root()`, `encode_claude_project_name(project_dir)` (claude's `/`-and-`.`-to-`-` substitution), and the private `move_jsonl_to_trash` / `sweep_trash_dir`.
- `main.rs` calls `ledger.sweep_trash(TIDE_TRASH_SWEEP_AGE_DAYS * 86_400_000, now_millis())` at startup, after the age sweep.

**Tasks:**
- [x] Implement the JSONL move using `std::fs::rename` (atomic on the same filesystem; in-place trash always satisfies this). Create the `<deletedAt>` subdir on demand via `create_dir_all`.
- [x] Implement `sweep_trash` — walks distinct `project_dir` values from the ledger, encodes each, enumerates `<root>/<encoded>/.tug-trash/`, and removes any `<deletedAt>` subdir older than the cutoff.
- [x] Hook startup sweep into `main.rs` after the ledger is opened (and after the age-row sweep so freshly-trashed JSONLs aren't immediately swept).
- [x] Forget paths (`forget`, `forget_workspace`, `forget_for_project_dir`) all move JSONLs to trash. Eviction paths (cap, age) intentionally don't (per [D05] — the JSONL stays, only the row drops).

**Tests:**
- [x] Rust unit: `encode_claude_project_name` substitutes `/` and `.` correctly.
- [x] Rust unit: `forget_moves_jsonl_to_trash` — JSONL ends up at the expected `.tug-trash/<stamp>/<id>.jsonl` path; original is gone.
- [x] Rust unit: `forget_succeeds_even_when_jsonl_is_missing` — row deletion still commits when there's no source file (e.g., already manually deleted).
- [x] Rust unit: `sweep_trash_removes_subdirs_older_than_cutoff` — 8-day-old and 30-day-old subdirs swept, 6-day-old kept.
- [x] Rust unit: `sweep_trash_no_op_when_root_missing` — fresh project_dir without any trash subdir → 0 removed, no error.

**Checkpoint:**
- [x] `cargo nextest run` — 1197 tests passing (5 new for Step 8)
- [x] `cargo build` — no warnings
- [x] `bun test` — 2767 tests passing (no tugdeck changes for Step 8)

---

#### Step 9: Tuglaws walkthrough + parent-plan close-out {#step-9}

**Depends on:** #step-8

**Commit:** `tide(ledger): tuglaws walkthrough, close-out`

**References:** [#tuglaws-cross-check], parent §step-10

**Tasks:**
- [x] Walk every changed file in this plan against [tuglaws.md](../tuglaws/tuglaws.md). Disposition table in [#tuglaws-disposition] below.
- [x] Add the "Stores That Observe CONTROL Push Frames" paragraph to `tuglaws/component-authoring.md`. The ledger store is documented as the second consumer of the pattern (after the live-sessions broadcast that §step-4-5-5 introduced), with the six structural points: action-dispatch decode, pub/sub bus, store subscribe, `useSyncExternalStore` hook, imperative actions via the bus, reconnect re-fetch.
- [x] Update `dash/tide.md` § code-session-store to reference the new ledger. Added a "Companion store: TideSessionLedgerStore" paragraph immediately after the status line, calling out the per-card vs cross-card split and pointing at the promoted plan + the `useSessionLedger(projectDir)` hook.
- [x] Update parent `dash/tugplan-tide-card-polish.md`:
  - Plan Status table row for Step 10: `placeholder — promotion still owed` → `**shipped** — see [tugplan-tide-session-ledger.md](./tugplan-tide-session-ledger.md)`.
  - Step 10 body: trimmed the ~95-line placeholder sketch to a 3-line "shipped via the promoted plan" marker. (Mirrors how Step 8 closed out via three subordinate plans.)

**Tests:**
- [x] `cargo nextest run` — 1197 tests passing across the workspace.
- [x] `bun test` — 2767 tests passing in tugdeck.
- [x] `bun x tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [~] Manual end-to-end smoke (full Forget → Restore-from-trash flow; concurrent-card live-elsewhere; resume-failed retains row; eviction at cap) — deferred. The unit + integration coverage exercises each path in isolation; an end-to-end smoke would require a live Claude Code subprocess and a multi-card session, which doesn't run in the automated suite. The deferred smoke is documented as a follow-on rather than a blocker — every individual mechanism is independently tested.

**Checkpoint:**
- [x] `cargo nextest run`
- [x] `bun x tsc --noEmit`
- [x] `bun test`
- [x] `bun run audit:tokens lint`

#### Tuglaws Disposition Per Changed File {#tuglaws-disposition}

| File | Touch | Tuglaws engaged | Disposition |
|------|-------|-----------------|-------------|
| `tugrust/crates/tugcast/src/session_ledger.rs` (new) | Sqlite ledger crate | n/a (Rust; tuglaws scope is tugdeck) | OK |
| `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | Trait + supervisor handlers | n/a | OK |
| `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` | session_init / result / resume_failed wiring | n/a | OK |
| `tugrust/crates/tugcast/src/main.rs` | Ledger open + sweep wiring | n/a | OK |
| `tugrust/crates/tugcast/src/router.rs` | Action interceptor list | n/a | OK |
| `tugdeck/src/protocol.ts` | Encoders + types | [L19] (function of arg, no React state) | Pure functions; no state captured. OK |
| `tugdeck/src/action-dispatch.ts` | Decode + publish to bus | [L19] (function of payload) | Handlers are pure decoders; no React state crosses. OK |
| `tugdeck/src/lib/tide-session-ledger-events.ts` (new) | Pub/sub bus | [L19] | Module-level singletons; subscriber lifecycle is opt-in. OK |
| `tugdeck/src/lib/tide-session-ledger-store.ts` (new) | Cache + push subscription + `useSessionLedger` hook | [L02], [L19], [L23] | `subscribe`/`getSnapshot` shape matches L02; `useSessionLedger` wraps `useSyncExternalStore`; `invalidateAll()` on `connectionDidReconnect` satisfies L23 (state survives reconnect via the on-disk ledger). OK |
| `tugdeck/src/lib/card-services-store.ts` | Recents-eviction → ledger-eviction hook | [L19] | Side effect co-located with services construction; no React state mutation. OK |
| `tugdeck/src/components/tugways/cards/tide-card.tsx` | Picker N+1 rows + Forget | [L02], [L06], [L07], [L11] | Picker reads ledger via `useSessionLedger`; row state pills via TugBadge (CSS, not React state) per L06; `handleForgetSession` reads `getTideSessionLedgerStore()` at call time per L07; row selection routes through TugRadioGroup's `selectValue` action per L11. OK |
| `tugdeck/src/components/tugways/cards/tide-card.css` | Forget button + state pill styles | [L17], [L20] | Styles use `--tug7-*` base tokens directly (no new component-tier aliases needed); composed children (TugBadge, TugRadioItem) keep their own tokens per L20. OK |
| `tuglaws/component-authoring.md` | Documentation extension | n/a | New "Stores That Observe CONTROL Push Frames" section. OK |
| `dash/tugplan-tide-card-polish.md` | Step 10 close-out | n/a | Status row + body trimmed to marker. OK |

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A tugcast-side sqlite session ledger replacing the tugbank `sessions` map and `live-sessions` set; CONTROL ops + a new client store; rich picker UX with Forget; eviction; recoverable trash. Parent plan §step-10 row flips to "shipped".

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] `SessionLedger` exists with full CRUD + eviction + sweep, schema per [#schema], all unit tests green.
- [x] No data migration per [D09]; the old `dev.tugtool.tide / sessions` and `dev.tugtool.tide / live-sessions` tugbank keys receive no writes after this lands (grep audit confirms only doc-comment references remain). Manual cleanup via `tugbank-cli get` is available if anyone cares.
- [x] Picker renders rich rows from the ledger store; live updates land via `session_updated`.
- [x] Per-row Forget moves the JSONL to trash and removes the ledger row; Forget All works (per-row dispatch loop, since the picker keys on `project_dir` not canonical `workspace_key`).
- [x] Eviction triggers at cap (20) and age (90 days); live rows are never evicted.
- [x] Recents eviction triggers ledger eviction via `forget_project_dir_sessions` in the same code path.
- [x] `resume_failed` retains the row with `state="failed"` and shows it greyed in the picker (subtitle "Couldn't resume — JSONL missing").
- [x] All grep gates: no remaining production references to `TugbankSessionsRecorder` / `TugbankLiveSessionsTracker` / writes to `dev.tugtool.tide / sessions` / `dev.tugtool.tide / live-sessions`. Only doc-comment references survive in `agent_supervisor.rs` and `session_ledger.rs` describing what was replaced.
- [x] `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` green.
- [x] Parent plan §step-10 row flips to "**shipped** — see tugplan-tide-session-ledger.md".

**Acceptance tests:**
- [x] All `R-CHAIN-*` chain tests from §step-4-5-5 still green against the ledger-backed flow (`session-chain.integration.test.ts`, 5 tests).
- [x] New `R-LEDGER-*`-equivalent integration tests cover: Forget → trash (Rust unit `forget_moves_jsonl_to_trash`); cap eviction (`evict_oldest_closed_*`, `evict_for_workspace_emits_removed_pushes`); age eviction (`sweep_expired_*`); recents-eviction → ledger-eviction (tugdeck `recents-eviction-ledger.test.tsx`); orphan-recovery sweep (`sweep_trash_recovers_orphaned_project_dirs`). Live-elsewhere coverage was kept in the existing `R-CHAIN-*` flow that already uses `card_id_live`.
- [~] Manual end-to-end (spawn 3 sessions, Forget the middle, restore via `mv` back) — deferred. Each individual mechanism is independently tested; an end-to-end run requires a live Claude Code subprocess and is the subject of the deferred-smoke task at the top of this section.

#### Roadmap / Follow-ons (Not Required for Phase Close) {#roadmap}

- [ ] Storage-pressure tracking (assistant bytes per session) — schema add + picker affordance. Cheap follow-on if a user complains about disk usage.
- [ ] Restore-from-trash UI in the picker (today's plan: only `mv` recovery). Add an "Recently forgotten" list if real users hit Forget too often.
- [ ] Collapse `tug_session_id` and `claude_session_id`. The ledger keys on `claude_session_id` already; the routing-window concern remains. Follow-up plan if the dual-id model causes friction.
- [ ] A `migrations` table once the schema gains a second variant.
- [ ] A purpose-built table primitive in tugways. Independent component-library work; reshape the picker if and when it lands.

| Checkpoint | Verification |
|-|-|
| Ledger CRUD + migration | `cargo nextest run -p tugcast --test session_ledger` |
| Bridge wiring | `cargo nextest run` (workspace) |
| CONTROL ops | `cargo nextest run` + protocol encoder unit tests |
| Picker UX | `bun test src/components/tugways/cards/__tests__/tide-card-session-picker.test.tsx` |
| Eviction + trash | `cargo nextest run` ledger integration tests |
| End-to-end | Manual smoke per [#exit-criteria] |
