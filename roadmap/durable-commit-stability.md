## Durable Commit Stability {#durable-commit-stability}

**Purpose:** A `/commit`, `/dash-join`, or `/dash-discard` receipt — and every other ledgered ink row — survives every app relaunch for the life of its line of work, including across the session-identity forks a join or rewind performs. The ink follows the head of the line the way the callsign now does under [D154].

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-23 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-23, opus.** Reviewed `plan:ec73a182751b4043`. Lint: 0 errors, 1 warning (fixed — this section).
Oriented on: the whole document (first review, `rounds: 0`).
Applied: the largest finding was that **`ShellLedger::rekey_session` already ships** — the plan listed it as a new symbol, specified the wrong return type (`u64`; it is `usize`), and missed that its doc-comment carries a precondition this plan's usage violates ("the caller only re-keys onto an empty target, so seqs stay unique"). Spec S03 now reuses and re-documents it. Second, and worse: **`refs_runs.tug_session_id` is a `PRIMARY KEY`**, so the plan's "one `UPDATE`… idempotent by construction" is false for refs — a move onto a session that already holds a run raises a constraint violation, and under the plan's warn-never-fail posture those rows would strand silently and permanently. Spec S03 now specifies a conflict-resolving move (newest `settled_at_ms` wins) with its own test, and Risk R03 records it. Third, the plan grew a parallel startup reconciler beside one that already exists: `ShellLedger::reconcile_orphaned_rows`, called from `main.rs` right after the ledgers open, is the same conservative-idempotent shape, and the two can contend for the same rows — [P03] and Spec S04 now fix the ordering (lineage sweep first; provenance outranks the card-emptiness heuristic) and adopt that function's caller-supplies-session-data idiom. Fourth, **Step 7's fixture was not implementable as written**: `LedgerSeedSpec`/`SeedSession` seed only `sessions` and `file_events`, with no `forked_from_session_id`, no `state`, and no shell-exchange seeding, and seeding must run *after* launch because `demote_live_to_closed` flips every live row at startup — the step now carries the seam extensions as real tasks and builds its ink organically through real commands per at0461. Fifth, the backfill contradicted itself: an orphan adoptable by nobody "stays put forever" while the sweep was called self-extinguishing, which on this machine means re-scanning a **244 MB** JSONL on every boot in perpetuity — [P07] now terminates it with a tugbank watermark (tugbank opens before the ledgers in `main.rs`), preserving [P05]'s no-schema-change promise, with Risk R04 recording the cost. Also: corrected `claude_project_dir`'s location (it is in `session_ledger.rs`, not `external_sessions.rs` — a cold-reader trap), made the `sessions(forked_from_session_id)` index definite rather than conditional (verified absent; the table indexes only `sessions_workspace_recent`), noted the two in-file test call sites of `record_landing_receipt` that Step 3 must also update and confirmed `feeds/refs.rs` genuinely has no session ledger to reach for, and added the tuglaws cross-check the plan omitted entirely — [L23] is the law this bug violates and now grounds the phase, [L29] is honored by routing JSONL paths through `claude_project_dir`, [L31] shapes the warn-plus-sweep error posture, and [L02]/[L06] are named as not implicated with the State Zone Mapping empty rather than absent.
Deferred: nothing. One judgment call was raised in-thread rather than deferred — the 500-row eviction cap (`MAX_EXCHANGES_PER_SESSION`) evicts oldest-first on the next `$` command, so a merge could silently destroy the very receipts this phase rescues; the user chose to exempt landing receipts from eviction outright, now [P06] and Step 2, sequenced ahead of every merging step so the guard exists before anything can trip it.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Five separate times a durable landing receipt vanished from a Session card transcript after a rebuild-and-relaunch, and five times the write side was innocent. The mechanism was proven live on 2026-08-23 against the running release app (session `6cb3e42b…`, fork `f5225437…`): a `/dash-join` (or any rewind-fork, [P11] in the session machinery) makes tugcode restart Claude under a **forked** Claude session id, and the sessions ledger mints that forked id as a **new session row** while superseding the parent row. The ink ledgers — `shell_exchanges.db` and `refs.db` — keep their rows keyed under the **parent** tug session id. The live deck's card binding does not switch at fork time, so everything keeps working (writes and reads both use the parent id) until the app relaunches. At relaunch, resume picks the fork's row (the parent is `closed`), the card binding becomes the fork id, and the restore read (`list_shell_exchanges`, [P07]) asks for a session that genuinely has zero ink rows. The server truthfully answers `total: 0, answered: true`; the client's completeness census correctly settles on a well-formed **wrong** answer; the rows sit intact in sqlite, unreachable. Every post-incident safeguard (unbounded retry, total-vs-rows census, `answered` flag) worked as designed — they defend against a *lost* answer, not a wrong *question*.

This violates the invariant already written at the empty-session respawn comment in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` (search for "the id keeps keying the session's durable non-JSONL content"), and it violates [L23] — an internal implementation operation must never lose user-visible state. Commit `804e039db` ([D154]) settled the doctrine — *a fork is an edit to a conversation, not the birth of a session; identity transfers to the fork* — and landed the structural primitive this plan needs: `sessions.forked_from_session_id` / `sessions.fork_point`, written at fork time by `set_fork_provenance`. What [D154] did **not** do is move the durable ink, and it did **not** backfill provenance for forks that happened before it landed (every existing row has `forked_from_session_id` NULL). This phase finishes the thought: ink transfers with the identity, stragglers are adopted, and history is repaired from the one place the old fork edges still exist — the forked JSONL itself, which preserves every ancestor turn's `sessionId` verbatim.

#### Strategy {#strategy}

- **Transfer, not chain-walk.** Mirror [D154]: at fork time the parent's ink rows are re-keyed to the fork, exactly as the callsign transfers. Reads stay single-id; no wire change; the shell-restore client machinery is untouched.
- **Guard before merge.** The receipt-eviction exemption ([P06]) lands *before* any step that merges two sessions' rows, because merging is what can push a line past the eviction cap.
- **One resolver at every ink gateway.** A superseded session id arriving at an ink write *or* read resolves to its lineage head before the ledger is touched. This covers the proven post-fork window in which the live deck stays bound to the superseded parent (observed: a join receipt written under the parent id twelve hours after the fork).
- **Build on the reconciler that ships.** `ShellLedger::rekey_session` and `ShellLedger::reconcile_orphaned_rows` already exist and are already called at startup; this phase extends that machinery and its idioms rather than growing a second one beside it.
- **Self-healing over ceremony.** The fork-time transfer spans two databases and cannot be atomic; an edge-based adoption sweep at ledger open re-runs the same idempotent re-key, so a crash between the two writes heals at the next boot.
- **Repair history from evidence, and then stop.** Pre-[D154] forks have no provenance edges, but a fork's JSONL is a file copy that retains ancestor `sessionId` values on every pre-fork line. A one-time background sweep adopts orphaned ink into the session whose own transcript *contains* the orphan's id, and records its own completion so it never scans again.
- **Sequence:** resolver → eviction guard → gateways → re-key primitives → fork-time transfer → startup sweeps → app-test → doctrine.

#### Success Criteria (Measurable) {#success-criteria}

- After a `/dash-join` followed by an app relaunch, the join receipt is present in the committed transcript, read from the stores via `__tug.inkRestoreFacts` (app-test, Step 7) — not from the DOM.
- `ShellSessionStore`'s restore census after the relaunch reports `ledgerTotal == applied` with `ledgerTotal` equal to the line of work's full ink count, never `{ledgerTotal: 0, applied: 0, complete: true}` for a line that holds rows (app-test assertion, Step 7).
- An ink row recorded under a superseded parent id after its fork (the live-binding window) is returned by a restore read for the head id (Rust test, Step 3).
- A landing receipt is never evicted by the per-session cap, even when the merged line exceeds `MAX_EXCHANGES_PER_SESSION` (Rust test, Step 2).
- A refs re-key onto a session that already holds a run resolves to the newer run rather than erroring (Rust test, Step 4).
- On a ledger populated with pre-[D154] orphans (rows under a closed, tagless ancestor whose id appears in a live session's JSONL), one boot moves the rows to the head and a second boot performs no JSONL I/O at all (Rust test, Step 6).

#### Scope {#scope}

1. `SessionLedger`: a lineage-head resolver over the `forked_from_session_id` edges, plus the index that column lacks.
2. `ShellLedger`: exempt landing receipts from cap eviction; re-document and reuse the existing `rekey_session`.
3. `RefsLedger`: a new `rekey_session` that resolves the primary-key collision its schema makes possible.
4. Every production ink write and read gateway in tugcast: head resolution.
5. The fork arc in `agent_bridge.rs`: ink transfer beside the existing identity transfer.
6. Startup reconciliation in `main.rs`: an edge sweep ordered against the existing `reconcile_orphaned_rows`, plus the one-time JSONL-evidenced backfill with a tugbank completion watermark.
7. The app-test seeding seam (`SeedSession` / `LedgerSeedSession`) extended with fork provenance, one app-test pinning the user-visible contract, and the doctrine record in `tuglaws/design-decisions.md`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Deck-side live rebinding at fork time.** Teaching tugdeck to swap a card's `tugSessionId` mid-session would touch every feed filter and store construction; the server-side resolver makes it unnecessary.
- **Any change to the shell-restore client machinery** — `LedgerRestoreFetch`, `applyRestore`, the completeness census. They were never wrong.
- **`sessions.db`-resident per-session data** (`facts`, `overview_posts`, `session_metadata`, `turns`). Citations already resolve across forks via the `minted_tags` alias arm ([D154]); moving those tables is a follow-on if a user-visible gap appears.
- **`changes.db` attribution.** Working-tree claims are transient (the session's live window) and governed by the workspace-tracking design; a fork mid-claim is not this phase's problem.
- **Fabricating provenance for pre-[D154] forks.** The backfill moves ink rows; it never writes `forked_from_session_id`/`fork_point` it cannot know.
- **`/btw` history and staged context.** Verified 2026-08-23: no `side_question` or staged-context table exists anywhere in tugcast, so there is nothing durable to transfer. The invariant comment's mention of them describes deck-lifetime state, and Step 8 corrects that comment.
- **A real Claude rewind-fork inside an app-test.** The fork arc needs a live `claude` process; it is covered at the Rust layer (Step 5) while the app-test seeds the post-fork ledger state a relaunch actually reads.

#### Dependencies / Prerequisites {#dependencies}

- Commit `804e039db` ([D154]): `inherit_fork_identity`, `set_fork_provenance`, the `forked_from_session_id`/`fork_point` columns, and the superseded-parent convention (closed + tagless).
- The shipping ink machinery this phase extends: `ShellLedger::rekey_session`, `ShellLedger::reconcile_orphaned_rows`, and its call site in `main.rs`.
- `tugcore::ledger_db` for every writable ledger open (enforced by `no_ad_hoc_ledger_opens`).
- `TugbankClient`, opened in `main.rs` before the ledgers — the store for the backfill watermark ([P07]).
- The JSONL discovery helpers `claude_project_dir` and `SessionLedger::claude_projects_root()`, **both in `tugrust/crates/tugcast/src/session_ledger.rs`**.

#### Constraints {#constraints}

- `-D warnings` across the Rust workspace; `cargo nextest run` must stay green.
- `shell_exchanges.db` and `refs.db` are separate SQLite files from `sessions.db`; no cross-database transaction exists. Every re-key must be idempotent so re-running it is always safe.
- `refs_runs.tug_session_id` is a `PRIMARY KEY` — a re-key onto an occupied id is a constraint violation, not a silent overwrite (Spec S03).
- `shell_exchanges` carries no uniqueness constraint on `(tug_session_id, seq)` — only `idx_shell_exchanges_session ON (tug_session_id, id)` — so merged `seq` values interleave without erroring.
- No new columns or tables in any ledger; this phase is data movement, read/write routing, and one eviction predicate.
- The `list_shell_exchanges_ok` / `list_refs_ok` responses must keep echoing the **requested** `tug_session_id` — the deck routes answers back to the asking store by that echo (`action-dispatch` → `applyRestore`).
- App-test ledger seeding runs through `tugcast --seed-ledger` and **must happen after launch**: `demote_live_to_closed` flips every `live` row to `closed` at startup.
- App-tests are selective: the new/extended test carries `@covers` lines and runs via `just app-test <file>` / `just app-test-changed`, never a sweep.

#### Assumptions {#assumptions}

- Fork chains are effectively linear and short (the [D154] investigation found no rewind point ever forked twice); the resolver still guards against cycles and caps depth defensively.
- A forked JSONL contains ancestor turns wearing their original `sessionId` values. Verified 2026-08-23 on the live fixture: `f5225437….jsonl` (**244 MB**) contains 3,112 lines with `sessionId: 6cb3e42b…` and 49,400 with `sessionId: 4dd8b556…`. That size is why [P07] exists.
- The superseded parent of a [D154]-era fork is detectable as `state = 'closed'` with `tag` NULL; pre-[D154] ancestors collapsed by `migrate_collapse_lineage_chains` are likewise tagless or absent from `sessions` entirely.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None. The design was settled in the diagnosis session of 2026-08-23 (the user directed: write it down, do not relitigate). Two calls surfaced afterward and were both decided rather than deferred: which adopter wins when two sessions' JSONLs both contain an orphan's id, settled as [P04]'s tie-break during authoring; and how the eviction cap should treat receipts once a merge can push a line past it, raised with the user during review and settled as [P06].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Fork-time transfer interrupted between the two ink databases | low | low | the open-time sweep (Step 6) re-runs the same idempotent re-key from the provenance edges | ink rows found under a session with a `forked_from` child at boot |
| An ink write races the fork edge (resolver sees no edge yet) | low | low | the row lands under the parent; the next open's sweep adopts it | a receipt missing until the next relaunch |
| Historical backfill adopts rows into the wrong session | high | low | containment evidence only (the adopter's own JSONL names the orphan id); candidates must be closed or absent from `sessions`; tie-break per [P04] | any user report of foreign receipts in a transcript |
| JSONL scan cost at boot | med | med | [P07]'s tugbank watermark ends the pass permanently; the empty-candidate case short-circuits before any file I/O (Risk R04) | boot-time regression traced to the sweep |
| Resolver loops on a corrupt edge cycle | low | low | depth cap + visited-set in `resolve_to_lineage_head`; a cycle returns the input id and warns | the warn line appearing in `tugcast.log` |
| Merged line exceeds the eviction cap and drops receipts | high | med | [P06] exempts landing receipts from eviction, and lands before any merging step | a receipt absent from a line with >500 exchanges |
| Refs re-key collides on the primary key | high | med | Spec S03's conflict-resolving move (Risk R03) | a `refs ledger` constraint-violation warning in `tugcast.log` |

**Risk R01: The backfill steals ink from a session that is still independently alive** {#r01-backfill-steals-live-ink}

- **Risk:** A parent JSONL remains resumable after a fork copies it; if the user independently resumed the parent, its ink is its own.
- **Mitigation:** a candidate is only adoptable while its `sessions` row is `closed` or absent; a live row is never a candidate. Containment in the adopter's JSONL is additionally required, so an unrelated session can never adopt.
- **Residual risk:** a user who re-opens a superseded ancestor *after* adoption sees its old receipts in the head's transcript instead. That is where the line of work continued, which is [D154]'s own answer for citations.

**Risk R02: Read-gateway resolution confuses the deck's response routing** {#r02-response-routing}

- **Risk:** `applyRestore` is reached by matching the response's `tug_session_id` to the store that asked; answering with the head's id would strand the answer.
- **Mitigation:** `do_list_shell_exchanges` / `do_list_refs` resolve only the *query*; the response body echoes the requested id unchanged (Spec S02). A Rust test pins the echo.
- **Residual risk:** none identified; the echo is a one-line invariant.

**Risk R03: A refs re-key collides on the primary key and strands rows silently** {#r03-refs-pk-collision}

- **Risk:** `refs_runs.tug_session_id` is the table's `PRIMARY KEY`. A blind `UPDATE … SET tug_session_id = <head>` fails with a constraint violation whenever the head already holds a run — and every caller in this plan warns rather than fails, so the rows would stay stranded permanently while the log line scrolls away.
- **Mitigation:** Spec S03 defines the refs move as a conflict-resolving operation (newest `settled_at_ms` wins, loser deleted) inside one transaction, never a bare `UPDATE`; Step 4 tests the occupied-destination case explicitly.
- **Residual risk:** the older of two runs is discarded. `refs_runs` holds only the latest run per session by construction (`record_run` already upserts `ON CONFLICT`), so this matches the table's existing semantics rather than adding a new loss.

**Risk R04: The historical backfill re-scans hundreds of megabytes on every boot** {#r04-backfill-scan-cost}

- **Risk:** An orphan that no JSONL claims stays a candidate forever; without a terminator the sweep re-reads every adopter transcript at every launch. The live fixture's head JSONL is 244 MB, so this is a measured cost, not a theoretical one.
- **Mitigation:** [P07] records completion in tugbank once a pass finishes, whether or not every candidate found a home; subsequent boots read one key and stop. The pass also short-circuits before any file I/O when the candidate set is empty.
- **Residual risk:** an orphan that becomes adoptable later (its adopter arrives after the watermark) is not picked up. The watermark key carries a version segment so a future phase can invalidate it deliberately.

---

### Design Decisions {#design-decisions}

#### [P01] Ink follows the head of the line of work, by transfer (DECIDED) {#p01-ink-follows-head}

**Decision:** At fork time, every durable ink row keyed to the parent session id is re-keyed to the fork's id, in the same arc that transfers the callsign and writes the provenance ([D154]).

**Rationale:**
- [D154] establishes that a fork *is* the conversation, continued; the receipts of that conversation belong with its head, exactly as its name does.
- The alternative — lineage-aware reads that walk the `forked_from` chain on every restore — puts a recursive query in every durable read surface, grows with chain length, and still cannot serve pre-[D154] history (those edges are NULL).
- Transfer keeps every ledger query single-id and every wire message unchanged.

**Implications:**
- `ShellLedger::rekey_session` **already exists** and is reused with a corrected doc-comment; `RefsLedger` gains its own, with the collision semantics Spec S03 defines.
- The `agent_bridge.rs` relay needs the two ink ledger handles threaded in (it holds only `session_ledger` today).
- Because the two ink databases are separate files, the transfer is best-effort and the open-time sweep ([P03]) is its safety net.

#### [P02] One resolver, applied at every ink gateway — writes and reads (DECIDED) {#p02-resolver-both-gateways}

**Decision:** `SessionLedger::resolve_to_lineage_head(id)` follows `forked_from_session_id` edges child-ward to the tip; every production ink write and every ink restore read resolves its session id through it before touching a ledger.

**Rationale:**
- The proven failure window: after a fork, the live deck stays bound to the superseded parent until the next relaunch, and both its writes and its reads carry the parent id. Observed live: a `/dash-join` receipt recorded under the parent twelve hours after the fork.
- Resolving only writes would break the same window's *reads* (a Maker ▸ Reload while parent-bound would find rows moved to a head it is not asking about). Resolving both keeps every epoch coherent: pre-fork, post-fork-pre-relaunch, and post-relaunch all see the same rows.
- Write-gateway resolution is the [L29]-style fix-the-key-at-the-gateway move, not a canonicalize-both-sides shim: there is exactly one resolver, at the boundary, and the stored key is always the head.

**Implications:**
- Write sites: `record_landing_receipt` in `agent_supervisor.rs` (the `/commit`, `/dash-join`, `/dash-discard` funnel), the settle-time `record_exchange` in `feeds/shell.rs`, and the refs run write in `feeds/refs.rs`. `feeds/shell.rs` already holds `sessions_ledger`; `feeds/refs.rs` verifiably does **not**, so the handle must be threaded in from `refs_dispatcher_task`.
- Read sites: `do_list_shell_exchanges` and `do_list_refs` in `agent_supervisor.rs`. The response echoes the requested id (Spec S02).
- A head id (no child edge) resolves to itself; an unknown id resolves to itself; cost is one indexed lookup per hop on a chain that is almost always length zero.

#### [P03] An edge-based adoption sweep runs at every ledger open, ahead of the existing reconciler (DECIDED) {#p03-open-time-sweep}

**Decision:** After the three ledgers open in `main.rs`, a sweep enumerates the distinct session ids present in `shell_exchanges` and `refs_runs`, resolves each through [P02]'s resolver, and re-keys any row set whose head differs — the same `rekey_session` the fork-time transfer uses. It runs **immediately before** the existing `reconcile_orphaned_rows` call.

**Rationale:**
- It is the crash-recovery half of [P01]: any interruption or race that leaves rows under a superseded id heals at the next boot, unconditionally.
- Ordering is not arbitrary. `ShellLedger::reconcile_orphaned_rows` — already called from `main.rs` right after the ledgers open, for the unrelated pre-F1 fresh-spawn bug — moves a lost session's rows onto *the card's current session* when that session is empty. That is a card-shaped heuristic predating provenance, and two reconcilers claiming the same rows in the wrong order could scatter them. Direct evidence must win, so the lineage sweep goes first; afterwards the rows sit on a head that has turns, and `reconcile_orphaned_rows` correctly declines to move them again.
- It is cheap: one `SELECT DISTINCT tug_session_id` per ink table, one resolver call per id, and updates only when something moved. On a healthy ledger it is a read-only pass.

**Implications:**
- The sweep follows `reconcile_orphaned_rows`'s idiom: the caller (`main.rs`) reads the session rows and passes plain data in, so the ink ledger modules keep no `SessionLedger` handle of their own.
- The sweep logs one line per adoption (`from`, `to`, row count) and one summary line, so a repaired boot is visible in `tugcast.log`.
- It runs before the supervisor starts serving restore reads, so a repaired ledger is what the first client sees.

#### [P04] Pre-[D154] orphans are adopted on JSONL containment evidence (DECIDED) {#p04-jsonl-backfill}

**Decision:** A background startup task finds ink rows keyed to *candidate* ids — ids whose `sessions` row is `closed` or absent, and which no `forked_from` edge already resolves — and adopts each candidate's rows into the first *adopter* session whose on-disk JSONL contains the candidate id as a turn `sessionId`. Adopters are scanned tag-wearers first, then by most recent `last_used_at`. Rows move; provenance columns are never fabricated.

**Rationale:**
- The fork edges for history are gone (`forked_from_session_id` is NULL on every pre-[D154] row; `tag_lineage` was dropped), but the JSONL copy is definitive: a session whose transcript literally contains the candidate's turns is the line that continued it. Verified on the live fixture (see #assumptions).
- Tag-wearers first mirrors [D154]'s own tie-break: when siblings both descend from an ancestor, the line that inherited the callsign is the line of work; a sibling minted fresh.
- It runs in the background so a large corpus never delays serving, and [P07] gives it a terminator so it is genuinely one-time rather than merely intended to be.

**Implications:**
- The scan streams each adopter JSONL looking for `"sessionId":"<candidate>"` substrings; it never parses full JSON DOMs and never loads a file into memory.
- A candidate contained in no adopter's JSONL stays put (a genuinely dead line); the summary log names the count so it is a visible fact, and [P07]'s watermark stops the pass from re-scanning for it on every subsequent boot.
- JSONL paths come from `claude_project_dir` and `claude_projects_root()`, **both in `session_ledger.rs`** — honoring [L29] rather than deriving a path by hand.

#### [P05] No schema changes, no wire changes, no client-behavior changes (DECIDED) {#p05-no-schema-no-wire}

**Decision:** This phase adds zero ledger columns, tables, or wire messages, and changes no client behavior. It moves rows, routes ids, and narrows one eviction predicate.

**Rationale:**
- The shell-restore client already does the right thing for every answer it can receive; the defect was the identity of the question, which is a server-side fact.
- `shell_exchanges.db` has no versioned-migration regime (schema is `CREATE TABLE IF NOT EXISTS`), and it does not need one for data movement. The one new index is on `sessions`, which is additive.
- The backfill's completion state goes to tugbank ([P07]) rather than a new column, which is the project's established home for persistent scalar state.

**Implications:**
- `tugdeck` production code is untouched; the only client-side change is a type addition on the app-test seeding seam (Step 7).
- Rollback is trivial: the re-key is data the old code reads identically (rows under the head id restore fine on any build — the head is what a relaunched deck asks for).

#### [P06] Landing receipts are exempt from cap eviction (DECIDED) {#p06-receipts-exempt-from-eviction}

**Decision:** `ShellLedger`'s per-session cap eviction skips landing receipts — the `/commit`, `/dash-join`, and `/dash-discard` rows — and trims only ordinary `$` exchanges. The exemption lands before any step that merges two sessions' rows.

**Rationale:**
- `MAX_EXCHANGES_PER_SESSION` is 500, enforced inside `record_exchange` by deleting the oldest rows past the cap for that session. Merging a fork's ink into one line makes exceeding it materially more likely, and the rows evicted first are the oldest — exactly where the historical receipts this phase rescues would sit. Rescuing a receipt and then evicting it on the next `$` command would be a bitter reversal of the phase's whole purpose.
- It restates the distinction the ink design already rests on: a receipt is the user's act, permanently ([D111]); a `$` exchange is chatter, and the cap exists to bound chatter.
- Decided by the user during review, choosing exemption over accepting the cap or merely raising it — a higher ceiling only postpones the same loss.

**Implications:**
- The eviction `DELETE` in `record_exchange` grows a predicate excluding receipt commands; the cap continues to bound the chatter it was written for.
- A pathological line of work could accumulate unbounded receipts. Landings are user gestures measured in hundreds per year, so this is not a growth risk worth engineering against.
- Sequencing: this is Step 2, ahead of the transfer (Step 5) and both sweeps (Step 6), so no merge can occur without the guard present.

#### [P07] The historical backfill records its own completion in tugbank (DECIDED) {#p07-backfill-watermark}

**Decision:** When a backfill pass finishes, it writes a versioned completion key to tugbank; subsequent boots read that key and skip the pass entirely, performing no JSONL I/O.

**Rationale:**
- Without a terminator the pass is not self-extinguishing: an orphan no JSONL claims remains a candidate forever, so every boot re-reads every adopter transcript. On this machine one adopter JSONL is 244 MB; that is a per-boot cost with no end.
- tugbank is already open in `main.rs` before the ledgers, and it is the project's established mechanism for persistent scalar state — so the terminator costs no schema change and keeps [P05] true.
- The key carries a version segment so a later phase can deliberately re-run the pass by bumping it.

**Implications:**
- The pass is genuinely one-time per machine; the summary log line is the record of what it did and what it left behind.
- A tugbank that failed to open degrades to running the pass each boot — the same graceful degradation the rest of `main.rs` applies, and no worse than the pre-plan behavior.

---

### Deep Dives {#deep-dives}

#### The three epochs of a forked session {#epoch-analysis}

Every fork splits a session's life into three epochs, and any fix must keep all three coherent:

- **Epoch A (pre-fork):** deck bound to parent `P`; ink written and read under `P`. Correct today.
- **Epoch B (post-fork, pre-relaunch):** Claude runs as fork `F` (tugcode restarted with `--resume F`), but the deck's card binding — and therefore every `session_id` it sends on ink writes and restore reads — is still `P`. Correct today *by accident*, and the reason the loss always presents as "it was there until I relaunched".
- **Epoch C (post-relaunch):** resume selects `F`'s row (`P` is closed); the binding, writes, and reads all carry `F`. Today this is where every `P`-keyed row becomes unreachable.

With this plan: the fork-time transfer moves A-epoch rows to `F`; the write resolver lands B-epoch writes under `F`; the read resolver lets B-epoch reads (asking `P`) see the rows now under `F`; C-epoch needs nothing — `F` is the head and holds everything.

#### The live diagnosis, for the record {#live-diagnosis}

What was measured on 2026-08-23 against release-main, and what a recurrence should be compared against:

- `shell_exchanges.db` held 4 rows for `6cb3e42b…` (seq 1–4; seq 4 the `/dash-join` receipt, settled 06:52:06 local), verified via `just db-inspect`.
- `GET /api/ink-census` (loopback, no eval gate) listed the same 4 rows under `6cb3e42b…` and none under `f5225437…`.
- The live card's `ShellSessionStore` (reached via the diag/eval opt-in and a React-fiber walk from `[data-card-id]`) reported `_tugSessionId = "f5225437…"` and a settled restore census of `{ledgerTotal: 0, applied: 0, complete: true, answered: true}`.
- `sessions.db`: row `6cb3e42b…` `closed`, tagless; row `f5225437…` `live`, wearing the collapsed callsign; both `forked_from_session_id` NULL (the fork predated [D154]).
- The relaunch log line: `event="rebind.entry" card_id="79264258…" tug_session_id=f5225437… mode_source="ledger"` — the moment the identity switched.

#### Production ink funnels (exhaustive, as of `804e039db`) {#ink-funnels}

**List L01: durable ink surfaces and their gateways** {#l01-ink-gateways}

- `shell_exchanges.db` / table `shell_exchanges` — opened in `main.rs` via `crate::shell_ledger::ShellLedger::open`.
  - Write: `AgentSupervisor::record_landing_receipt` (`feeds/agent_supervisor.rs`) — the single funnel for `/commit`, `/dash-join`, `/dash-discard` receipts; takes `session_id` from the deck's request. **Three production call sites, all in that file**, each with `self.session_ledger` already in scope; **two further call sites live in that file's test module** and must be updated when the signature grows.
  - Write: the settle-time persist in `feeds/shell.rs` (search "Persist the settled exchange for restore") — the `$`-route's completed exchanges; `sessions_ledger` is already a parameter in that scope and is already used a few lines below for the facts write.
  - Read: `AgentSupervisor::do_list_shell_exchanges` → `ShellLedger::list_exchanges_since` + `exchange_census`.
  - (The `record_exchange` call in `feeds/operator.rs` is a test fixture, not production.)
- `refs.db` / table `refs_runs` — `crate::refs_ledger::RefsLedger`.
  - Write: the `record_run` call in `feeds/refs.rs`. **No session ledger reaches that scope** — the function holds only `ledger: Option<Arc<RefsLedger>>` — so the handle must be threaded in from `refs_dispatcher_task`.
  - Read: `AgentSupervisor::do_list_refs` → `RefsLedger::list_refs`.

Anything not in this list is either not server-durable (`/btw`, staged context — see #non-goals) or not session-keyed ink.

#### What already ships, and must be reused {#existing-machinery}

Reading the tree before designing turned up three pieces of machinery this phase builds on rather than reinvents. An implementer who writes any of them from scratch has grown a parallel path:

- **`ShellLedger::rekey_session(from, to) -> Result<usize, ShellLedgerError>`** already exists. Its body is the single `UPDATE` this plan needs, but its doc-comment carries a precondition — *"the caller only re-keys onto an empty target, so seqs stay unique"* — which this phase's usage deliberately breaks. Spec S03 re-documents it rather than adding a second function beside it.
- **`ShellLedger::reconcile_orphaned_rows`**, called from `main.rs` immediately after the ledgers open, is a conservative idempotent startup adoption pass for a *different* historical bug (the pre-F1 fresh-spawn orphaning, which re-spawned a shell-only session under a fresh id). It establishes both the idiom — the caller reads sessions and passes plain data in, so the ledger module holds no `SessionLedger` — and the call site the new sweep joins. [P03] fixes their ordering.
- **`tugcast --seed-ledger`** (`SeedSession` in `main.rs`, `LedgerSeedSession` in `tests/app-test/_harness/types.ts`, driven by `app.seedLedger(...)`) is how an app-test stands up ledger state, through the real `SessionLedger` writer so the schema cannot drift. It seeds `sessions` and `file_events` only — **no fork provenance, no `state`, no shell exchanges** — and it must run *after* launch, because `demote_live_to_closed` flips every `live` row to `closed` at startup. Step 7 extends it minimally.

#### The fork arc after [D154] {#fork-arc}

In `feeds/agent_bridge.rs`: the relay sees tugcode's `session_fork` announcement (`parse_session_fork`: `parentSessionId`, `newSessionId`, `forkPoint`), calls `SessionLedger::inherit_fork_identity(parent, new, now)` (transfers the callsign and `/rename` off the parent row, leaves it tagless), and stages a `PendingFork {tag, user_name, parent_session_id, fork_point}` on the ledger entry. The next `session_init` whose Claude id matches consumes it: `sessions_recorder.record(...)` creates the fork's row under the inherited tag, then `set_fork_provenance(record_id, parent, fork_point)` writes the edge, then the inherited `/rename` is applied. **The ink transfer belongs immediately after `set_fork_provenance`** — at that point the edge exists (so a racing write resolves correctly) and both ids are in hand. The relay takes `session_ledger: Option<Arc<SessionLedger>>` today and must take the two ink handles the same way; `AgentSupervisor` owns both as public fields (`shell_ledger`, `refs_ledger`), populated by `set_shell_ledger` / `set_refs_ledger` in `main.rs` immediately after the supervisor is constructed.

---

### Specification {#specification}

**Spec S01: `resolve_to_lineage_head`** {#s01-resolver}

`SessionLedger::resolve_to_lineage_head(&self, session_id: &str) -> String`

- Repeatedly finds the session whose `forked_from_session_id` equals the current id (`SELECT session_id FROM sessions WHERE forked_from_session_id = ?1`), following child-ward until no child exists.
- Returns the input id unchanged when it has no child, is unknown, or on any query error (resolution must never turn a working write into a failure).
- Guards: a visited-set and a depth cap (16); on a cycle or cap, warn once and return the input id.
- If multiple children claim the same parent (sibling forks), prefer the child wearing a tag; tie-break by newest `last_used_at`. Siblings are new lines per [D154], but the tagged child is the continuation.
- Requires a new index on `sessions(forked_from_session_id)` — verified absent from the DDL, which today declares only `sessions_workspace_recent`.

**Spec S02: gateway behavior** {#s02-gateway-behavior}

- Write gateways store `resolve_to_lineage_head(requested_id)` as the row's `tug_session_id`.
- Read gateways query with the resolved id but **echo the requested id** in `list_shell_exchanges_ok` / `list_refs_ok`, because the deck routes the answer to the asking store by that echo.
- `exchange_census` is computed over the same resolved id as the rows, so `total` and the returned row count describe one set.
- `GET /api/ink-census` stays raw (it reports what is physically keyed where — that is its diagnostic value).

**Spec S03: the two re-key operations** {#s03-rekey}

*Shell (existing, re-documented):* `ShellLedger::rekey_session(&self, from: &str, to: &str) -> Result<usize, ShellLedgerError>` already performs `UPDATE shell_exchanges SET tug_session_id = ?2 WHERE tug_session_id = ?1` and returns the affected count — the body needs no change. Its doc-comment's precondition ("the caller only re-keys onto an empty target, so seqs stay unique") no longer holds and must be rewritten to state the merged behavior: `seq` values from the two sessions interleave, which is safe because the table declares no uniqueness on `(tug_session_id, seq)` — only `idx_shell_exchanges_session ON (tug_session_id, id)` — the restore orders by `id ASC`, the deck seats rows by timestamp (`ingestShellExchange` upserts at its timestamp position), and the client reads `total`, never `max_seq`. `from == to` is a no-op returning 0; a second run matches zero rows.

*Refs (new, collision-resolving):* `RefsLedger::rekey_session(&self, from: &str, to: &str) -> Result<usize, RefsLedgerError>`. `refs_runs.tug_session_id` is the table's `PRIMARY KEY`, so a bare `UPDATE` raises a constraint violation whenever `to` already holds a run. In one transaction: read both rows; if `to` is absent, `UPDATE`; if `to` is present, keep the row with the newer `settled_at_ms` and delete the other. This matches the table's existing latest-run-per-session semantics (`record_run` already upserts `ON CONFLICT`) rather than introducing a new kind of loss. Idempotent: after the move, `from` holds nothing.

**Spec S04: the startup sweeps** {#s04-startup-sweeps}

- **Edge sweep (synchronous, every boot):** for each distinct `tug_session_id` in each ink table, compute the head; where it differs, re-key per Spec S03. Runs in `main.rs` after the three ledgers open and **immediately before** the existing `reconcile_orphaned_rows` call, per [P03] — and before the supervisor serves CONTROL reads. Follows that function's idiom: `main.rs` reads the session rows and hands plain data in. Logs `ink adoption: <from> → <to> (<n> shell, <m> refs)` per move and a summary.
- **JSONL backfill (background, watermarked):** skip entirely when [P07]'s tugbank completion key is set. Otherwise candidates = distinct ink ids whose `sessions` row is `closed` or absent *and* whose head (per Spec S01) is themselves (no edge knows them). If the candidate set is empty, write the watermark and stop before any file I/O. Otherwise, for each adopter (sessions rows ordered tag-wearers first, then `last_used_at` DESC, skipping candidates themselves), stream its JSONL — path via `claude_project_dir(claude_projects_root(), project_dir)` joined with `<session_id>.jsonl` — scanning for `"sessionId":"<candidate>"`; on containment, re-key the candidate into the adopter in both ink ledgers and drop it from the set. When the pass ends, log every adoption plus the count left unadopted, then write the watermark.

**Spec S05: receipt-aware eviction** {#s05-receipt-eviction}

The cap eviction inside `ShellLedger::record_exchange` — today "delete the oldest rows for this session beyond `MAX_EXCHANGES_PER_SESSION`" — gains a predicate excluding landing receipts, identified by the exact `command` values `record_landing_receipt` writes: `/commit`, `/dash-join`, `/dash-discard`. Both the retained-set subquery and the `DELETE` are scoped so the cap counts and trims only non-receipt rows. Those strings are the same literals the receipt writer passes at its call sites, so the two cannot drift without Step 2's test failing.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

Empty by verification rather than by omission: this phase introduces **no client state**. The only tugdeck-side edit is a type addition on the app-test seeding seam (`LedgerSeedSession` in `tests/app-test/_harness/types.ts`), which is harness plumbing rather than deck state, so there is nothing to map to a zone. See #tuglaws-cross-check.

---

### Tuglaws Cross-Check {#tuglaws-cross-check}

- **[L23] — internal implementation operations must never lose, destroy, or cease to apply user-visible state.** This is the law the bug violates and the law the phase serves: a rewind-fork is an internal implementation operation, and it silently destroys the user's receipts. [P01] (transfer), [P02] (gateway resolution), [P03]/[P04] (sweeps), and [P06] (eviction exemption) are each an instance of honoring it, and the phase's exit criteria are in effect L23 conformance tests.
- **[L29] — every persisted or compared path routes through the canonicalization gateway.** Honored: the backfill derives JSONL paths through `claude_project_dir`, which resolves the project dir to its Claude form internally, rather than composing a path from a raw `project_dir` string. [P02]'s write-gateway resolution is the same shape of move applied to session identity — one resolver at the boundary, never a tolerance shim on both sides.
- **[L31] — a user gesture produces either the act or a visible reason, never silence.** The ink transfer warns rather than failing a spawn, since a landing must never be blocked by a bookkeeping write; that alone would be silence-adjacent, so the open-time sweep ([P03]) is what turns the warning into an eventual act, and Risk R03's collision handling exists so a refs failure cannot become permanent silence.
- **[L02] / [L06] — external state through `useSyncExternalStore`; appearance through CSS and DOM.** Not implicated. No production tugdeck code changes and no new client state is created, which is why #state-zone-mapping is empty rather than absent.
- **[D111]** grounds [P06]: ink is the user's act rather than session context, which is precisely why a receipt outranks chatter when the cap trims.
- **[D154]** is the decision this phase completes; Step 8 records the durable-content companion to it.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `resolve_to_lineage_head` | fn (new) | `tugrust/crates/tugcast/src/session_ledger.rs` | Spec S01; pub, with unit tests beside the existing fork tests |
| `sessions(forked_from_session_id)` | index (new) | `tugrust/crates/tugcast/src/session_ledger.rs` | verified absent; declare beside `sessions_workspace_recent` |
| `record_exchange` | fn (modify) | `tugrust/crates/tugcast/src/shell_ledger.rs` | Spec S05 — eviction skips receipt commands |
| `rekey_session` | fn (**modify — already exists**) | `tugrust/crates/tugcast/src/shell_ledger.rs` | body unchanged; retire the empty-target precondition in its doc-comment (Spec S03). Returns `usize`, not `u64` |
| `rekey_session` | fn (new) | `tugrust/crates/tugcast/src/refs_ledger.rs` | Spec S03 collision-resolving move — `tug_session_id` is a PRIMARY KEY |
| `record_landing_receipt` | fn (modify) | `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | resolve before insert; it is an associated fn — add `Option<&Arc<SessionLedger>>`. **3 production + 2 test call sites, all in-file** |
| settle-time persist | code (modify) | `tugrust/crates/tugcast/src/feeds/shell.rs` | resolve before `record_exchange`; `sessions_ledger` already in scope (used just below for the facts write) |
| refs run persist | code (modify) | `tugrust/crates/tugcast/src/feeds/refs.rs` | resolve before `record_run`; **the session ledger is absent — thread it from `refs_dispatcher_task`** |
| `do_list_shell_exchanges` | fn (modify) | `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | resolve the query id; echo the requested id (Spec S02) |
| `do_list_refs` | fn (modify) | `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | same |
| fork ink transfer | code (new) | `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` | after `set_fork_provenance`; thread `Option<Arc<ShellLedger>>`/`Option<Arc<RefsLedger>>` into the relay |
| `adopt_orphaned_ink` | fn (new) | new file `tugrust/crates/tugcast/src/ink_adoption.rs` | Spec S04 both sweeps; called from `main.rs` beside `reconcile_orphaned_rows`; owns the candidate/adopter queries and the JSONL containment scan |
| `SeedSession.forked_from_session_id` | field (new) | `tugrust/crates/tugcast/src/main.rs` | app-test seam; applied via the existing `set_fork_provenance` |
| `LedgerSeedSession.forked_from_session_id` | field (new) | `tests/app-test/_harness/types.ts` | mirrors the Rust seed struct |

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/ink_adoption.rs` | The edge sweep and JSONL backfill (Spec S04), with their tests |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Resolver semantics, the eviction predicate, re-key collision handling, sweep candidate selection, JSONL containment scan | Steps 1–2 and 4–6; in-memory ledgers and tempdir JSONL fixtures |
| **Integration (Rust)** | Gateway behavior end-to-end: write under a superseded id lands under the head; read for the head returns them; echo invariant; sweep ordering | Steps 3 and 6, against real sqlite files in a tempdir |
| **App-test** | The user-visible contract: relaunch after a fork, receipt present, census complete — read via `__tug.inkRestoreFacts` | Step 7, following `at0461-ink-restore-windowed.test.ts`'s fixture pattern |

#### What stays out of tests {#test-non-goals}

- A real Claude fork in an app-test — the fork arc needs a live `claude` process; the arc is covered at the Rust layer (Step 5) and the app-test seeds the post-fork ledger state instead, which is the state every relaunch actually reads.
- DOM row counting — banned by the at0461 doctrine; every transcript assertion reads the stores.
- Mock-store or fake-DOM render tests — banned project-wide.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The lineage-head resolver | done | `31db0e1da` |
| #step-2 | Receipts survive the eviction cap | done | `0c3d56002` |
| #step-3 | Head resolution at every ink gateway | done | `31db0e1da` |
| #step-4 | Re-key, including the refs collision | done | `b02bc449e` |
| #step-5 | Ink transfers at fork time | done | `b02bc449e` |
| #step-6 | The startup sweeps | done | `0ef173ea7` |
| #step-7 | The relaunch contract, pinned | done | `76262eb3e` |
| #step-8 | Doctrine and the invariant comment | done | `40f7efecf` |
| #step-9 | Integration checkpoint | done | `08e4a3590` |

#### Step 1: The lineage-head resolver {#step-1}

**Commit:** `tugcast(ink-lineage): resolve a session id to its lineage head over the fork edges`

**References:** [P02] One resolver at every gateway, Spec S01, (#fork-arc, #epoch-analysis)

**Artifacts:**
- `SessionLedger::resolve_to_lineage_head` with cycle/depth guards and the sibling tie-break.

**Tasks:**
- [ ] Implement Spec S01 in `session_ledger.rs`, beside the existing fork machinery (`inherit_fork_identity`, `set_fork_provenance`).
- [ ] Add the `sessions(forked_from_session_id)` index to the DDL beside `sessions_workspace_recent` — verified absent today, and the resolver's child lookup is per-write hot.

**Tests:**
- [ ] No edge → returns input; unknown id → returns input.
- [ ] A two-hop chain resolves to the tip; the middle resolves to the tip.
- [ ] Sibling forks: the tagged child wins; two tagless children fall back to newest `last_used_at`.
- [ ] A manufactured cycle returns the input id (and does not hang).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast session_ledger` green, zero warnings.

---

#### Step 2: Receipts survive the eviction cap {#step-2}

<!-- No dependency: independent of the resolver, and it must land before any step that merges two sessions' rows. -->

**Commit:** `tugcast(shell-ledger): exempt landing receipts from cap eviction`

**References:** [P06] Receipts exempt from eviction, Spec S05, Risk table (#risks), [D111] by reference, (#tuglaws-cross-check)

**Artifacts:**
- A receipt-aware eviction predicate in `ShellLedger::record_exchange`.

**Tasks:**
- [ ] Narrow the cap eviction per Spec S05 so both the retained-set subquery and the `DELETE` exclude the `/commit`, `/dash-join`, and `/dash-discard` commands.
- [ ] Update the `MAX_EXCHANGES_PER_SESSION` doc-comment to say what the cap now bounds (chatter) and what it never touches (receipts).

**Tests:**
- [ ] A session driven past the cap with receipts interleaved keeps every receipt and loses only the oldest `$` rows.
- [ ] A session of receipts alone never evicts.
- [ ] A session of chatter alone evicts exactly as before (regression guard on the existing behavior).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast shell_ledger` green, zero warnings.

---

#### Step 3: Head resolution at every ink gateway {#step-3}

**Depends on:** #step-1

**Commit:** `tugcast(ink-lineage): route every ink write and restore read through the lineage head`

**References:** [P02] One resolver at every gateway, [P05] No schema/wire changes, Spec S02, List L01, Risk R02, (#ink-funnels, #epoch-analysis)

**Artifacts:**
- Resolution at `record_landing_receipt`, the `feeds/shell.rs` settle persist, the `feeds/refs.rs` run persist, `do_list_shell_exchanges`, `do_list_refs`.

**Tasks:**
- [ ] Pass the session ledger into `record_landing_receipt` (it is an associated fn taking `Option<&Arc<ShellLedger>>` today; add `Option<&Arc<SessionLedger>>`). Update its **three production call sites and two test call sites**, all in `agent_supervisor.rs`, where `self.session_ledger` is already in scope.
- [ ] Resolve in the `feeds/shell.rs` settle persist, using the `sessions_ledger` handle already in that scope — the facts write a few lines below uses the same one.
- [ ] Thread a `SessionLedger` handle into `feeds/refs.rs` from `refs_dispatcher_task` — it is genuinely absent there today, the function holding only `Option<Arc<RefsLedger>>` — and resolve before `record_run`.
- [ ] Resolve the query id in `do_list_shell_exchanges` and `do_list_refs`; keep the response's `tug_session_id` the requested id (Spec S02).

**Tests:**
- [ ] Write under a superseded id → the row's stored `tug_session_id` is the head (tempdir sqlite, a two-row sessions fixture with one edge).
- [ ] Restore read for the superseded id returns the head's rows and echoes the requested id in the response body.
- [ ] `exchange_census` over the resolved id matches the rows returned.
- [ ] A head id (no edge) round-trips identically to today (regression guard).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green, zero warnings.

---

#### Step 4: Re-key, including the refs collision {#step-4}

**Depends on:** #step-2

**Commit:** `tugcast(ink-lineage): give both ink ledgers a merge-safe re-key`

**References:** [P01] Ink follows the head, Spec S03, Risk R03, (#existing-machinery)

**Artifacts:**
- A re-documented `ShellLedger::rekey_session`; a new collision-resolving `RefsLedger::rekey_session`.

**Tasks:**
- [ ] Rewrite `ShellLedger::rekey_session`'s doc-comment per Spec S03 — the empty-target precondition is retired and the merged-`seq` reasoning replaces it. **The body is unchanged; this function already exists.**
- [ ] Implement `RefsLedger::rekey_session` per Spec S03 as a transactional move that resolves the primary-key collision by keeping the newer `settled_at_ms`.

**Tests:**
- [ ] Shell: a merge onto an occupied target moves all rows, interleaves `seq` without error, and is idempotent on a second call.
- [ ] Refs: an empty target is a plain move; an occupied target keeps the newer run and deletes the older; `from` holds nothing afterward.
- [ ] Refs: `from == to` is a no-op rather than a self-collision.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast shell_ledger refs_ledger` green, zero warnings.

---

#### Step 5: Ink transfers at fork time {#step-5}

**Depends on:** #step-4

**Commit:** `tugcast(ink-lineage): transfer the parent's durable ink to the fork beside its callsign`

**References:** [P01] Ink follows the head, [P06] Receipts exempt, Spec S03, Risk R01, (#fork-arc)

**Artifacts:**
- The transfer call in `agent_bridge.rs` after `set_fork_provenance`, with both ink ledger handles threaded into the relay.

**Tasks:**
- [ ] Thread `Option<Arc<ShellLedger>>` and `Option<Arc<RefsLedger>>` from `AgentSupervisor` — which owns both as public fields, populated by `set_shell_ledger`/`set_refs_ledger` in `main.rs` — into the relay function in `agent_bridge.rs`, following the path `session_ledger` already takes.
- [ ] After `set_fork_provenance` succeeds in the `session_init` consume block, call `rekey_session(parent, record_id)` on both ledgers; warn rather than fail on error, matching the surrounding posture ([L31] is served by the Step 6 sweep, not by failing a spawn).

**Tests:**
- [ ] After a simulated fork consume (sessions fixture + staged `PendingFork`), the parent's shell and refs rows are keyed under the fork id.
- [ ] A fork whose parent has no ink rows transfers nothing and warns nothing.
- [ ] A transfer that fails on one ledger still completes on the other (the two are independent databases).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast agent_bridge` green, zero warnings.

---

#### Step 6: The startup sweeps {#step-6}

**Depends on:** #step-4

**Commit:** `tugcast(ink-lineage): adopt stranded ink at open, and pre-provenance orphans once`

**References:** [P03] Open-time sweep, [P04] JSONL backfill, [P07] Backfill watermark, Spec S04, Risks R01/R04, (#existing-machinery, #ink-funnels, #live-diagnosis)

**Artifacts:**
- `ink_adoption.rs` with both sweeps; their call sites in `main.rs`.

**Tasks:**
- [ ] Implement the edge sweep per Spec S04: distinct ids per ink table → resolver → re-key where the head differs; per-move and summary log lines. Follow `reconcile_orphaned_rows`'s idiom — the caller reads sessions and passes plain data in, so the ink ledger modules hold no `SessionLedger`.
- [ ] Wire it in `main.rs` **immediately before** the existing `reconcile_orphaned_rows` call, per [P03], and comment why that order is load-bearing.
- [ ] Implement the JSONL backfill per Spec S04: watermark check first, candidate selection (closed-or-absent, self-headed, present in an ink table), the adopter walk (tag-first then `last_used_at` DESC) with the streamed containment scan, re-key, summary log, watermark write.
- [ ] Read and write the [P07] watermark through the `TugbankClient` already opened earlier in `main.rs`; degrade to running the pass when tugbank is absent.
- [ ] Spawn the backfill as a background task so a large corpus never delays serving.

**Tests:**
- [ ] Edge sweep: rows under a superseded parent with an edge present move at open; a second run moves nothing; rows under a head stay put; a `None` ink ledger is a clean no-op.
- [ ] Ordering: a fixture that would satisfy both reconcilers ends with the rows on the lineage head, proving the lineage sweep ran first.
- [ ] Backfill: an orphan (closed parent, no edge, ink rows) plus a live adopter whose tempdir JSONL names the orphan id → one run adopts; the watermark is then set and a second run performs no file I/O.
- [ ] Backfill: a live-rowed candidate is never adopted (Risk R01); an orphan named in no JSONL stays put and is counted in the summary; two adopters both containing the orphan → the tagged one wins.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast ink_adoption` green, zero warnings.

---

#### Step 7: The relaunch contract, pinned {#step-7}

**Depends on:** #step-3, #step-6

**Commit:** `app-test(ink-lineage): a forked line's receipts survive relaunch`

**References:** [P01] Ink follows the head, [P02] Resolver at gateways, Success criteria (#success-criteria), (#existing-machinery, #test-plan-concepts, #epoch-analysis)

**Artifacts:**
- `forked_from_session_id` on both halves of the seeding seam (`SeedSession` in `main.rs`, `LedgerSeedSession` in `tests/app-test/_harness/types.ts`).
- `tests/app-test/at04xx-ink-fork-restore.test.ts`, with `@covers` lines naming `ink_adoption.rs`, the gateway code in `agent_supervisor.rs`, and `tugdeck/src/lib/shell-session-store.ts`.

**Tasks:**
- [ ] Add an optional `forked_from_session_id` to `SeedSession` and apply it through the existing `set_fork_provenance` in the `--seed-ledger` handler; mirror the field on `LedgerSeedSession`. The seam seeds `sessions` and `file_events` only and has no fork provenance today, which is why this task exists.
- [ ] Write the test on at0461's pattern: launch, let the card bind, and create ink **organically** by running real `$` commands, so the rows are written by the real path rather than hand-seeded (there is no shell-exchange seeding, and organic ink is the truer fixture).
- [ ] Seed the fork's session row **after launch** — the seam's own constraint, because `demote_live_to_closed` flips every `live` row at startup — pointing `forked_from_session_id` at the session that owns the ink.
- [ ] Relaunch, and assert through `__tug.inkRestoreFacts` that the ink written under the ancestor is in the committed transcript, with `complete: true` and `ledgerTotal == applied ==` the count that was written.
- [ ] Assert the stores, never the DOM (at0461 doctrine).

**Tests:**
- [ ] The app-test itself (it is the test).

**Checkpoint:**
- [ ] `just app-test tests/app-test/at04xx-ink-fork-restore.test.ts` — VERDICT green, run bare (never piped).
- [ ] `just app-test-covers-check` passes for the new file.

---

#### Step 8: Doctrine and the invariant comment {#step-8}

**Depends on:** #step-5, #step-6

**Commit:** `tuglaws(ink-lineage): record that durable ink follows the line of work`

**References:** [P01]–[P07], [D154] and [L23] by reference, (#context, #non-goals, #tuglaws-cross-check)

**Artifacts:**
- A new global decision in `tuglaws/design-decisions.md` (next free `[D###]`), the durable-content companion to [D154]: ink transfers with the identity; gateways resolve; receipts outlive the cap; history was adopted on containment evidence.
- The invariant comment in `agent_supervisor.rs` ("the id keeps keying the session's durable non-JSONL content") updated to state the invariant as now *enforced* — the id is the lineage head — and to drop the stale mentions of `/btw` history and staged context, neither of which persists (see #non-goals).

**Tasks:**
- [ ] Write the decision with [D154]'s specificity: the transfer, the gateway resolution, the two sweeps, the eviction exemption, and the guards — naming the files and symbols.
- [ ] Update the comment.

**Tests:**
- [ ] None (documentation).

**Checkpoint:**
- [ ] `cd tugrust && cargo build` green (comment-only Rust change compiles), zero warnings.

---

#### Step 9: Integration checkpoint {#step-9}

**Depends on:** #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** [P01]–[P07], (#success-criteria, #deliverables)

**Tasks:**
- [ ] `tugutil dash replay <name>` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: verify the replayed tree with the project's declared verify command (`tugutil dash config --json`), substituting `{base}`/`{head}` with the replayed range.
- [ ] `Current`: the base never moved, so the last step's checkpoint already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree, then verify as above.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables {#deliverables}

**Deliverable:** Receipts that cannot be lost to a fork: every durable ink row rides the line of work's head — transferred at fork time, routed there at every gateway, adopted at boot when anything slipped, repaired once from JSONL evidence for the forks that predate provenance, and exempt from the eviction that could otherwise undo the rescue — with the user-visible contract pinned by an app-test that relaunches onto a forked line and finds its receipts.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] A restore read for any id on a fork chain returns the full line's ink (Rust integration test, Step 3).
- [ ] A landing receipt is never evicted by the cap (Rust test, Step 2).
- [ ] A refs re-key onto an occupied session resolves rather than erroring (Rust test, Step 4).
- [ ] A fork immediately moves the parent's ink to the head (Rust test, Step 5).
- [ ] A boot heals stranded rows from edges ahead of `reconcile_orphaned_rows`, and adopts pre-[D154] orphans exactly once before watermarking itself (Rust tests, Step 6).
- [ ] A relaunch onto a forked line shows the receipts, store-read, census-complete (app-test, Step 7).
- [ ] The doctrine is recorded and the invariant comment tells the truth (Step 8).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Extend the same transfer to `sessions.db`-resident per-session tables (`facts`, `overview_posts`) if a user-visible gap appears (#non-goals).
- [ ] A `tugutil` diagnostic that prints a session's lineage chain and per-ledger ink counts in one view (today: `just db-inspect` + `/api/ink-census` by hand).
- [ ] Reconsider whether `reconcile_orphaned_rows`'s card-emptiness heuristic is still needed once provenance covers the same ground.
