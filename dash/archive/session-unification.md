<!-- devise-skeleton v4 -->

## Session Unification — Terminal and Tug Sessions as One Pool {#session-unification}

**Purpose:** Make every Claude Code session on disk — whether born in the Claude Code
terminal app or in a Tug dev card — visible, resumable, and manageable from Tug's
session picker, with a hard safety gate that prevents Tug from opening a session a
live terminal process currently holds.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-11 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tug's resume picker reads exclusively from the sqlite `SessionLedger`
(`~/Library/Application Support/Tug/sessions.db`), and ledger rows are only created
when the bridge observes a `session_init` from a tugcode subprocess Tug itself
spawned. Sessions created by the Claude Code terminal app live in the very same
JSONL files under `~/.claude/projects/<encoded-dir>/`, in the very same format —
but they never pass through Tug's spawn funnel, so the picker never shows them.

Investigation (2026-06-11) established three facts that make unification tractable:

1. **Resume does not require a ledger row.** `do_spawn_session` takes the session id
   and `project_dir` from the client payload; tugcode replays the JSONL straight from
   disk and spawns `claude --resume <id>`. A terminal session's UUID fed into
   `spawn_session(mode=resume)` works mechanically today.
2. **The ledger self-heals.** On the first `session_init` after a resume, the bridge
   calls `record_spawn` — a foreign session becomes a first-class ledger row the
   moment it is resumed once.
3. **Liveness is detectable.** Claude Code maintains a per-process registry at
   `~/.claude/sessions/<pid>.json` carrying `pid`, `sessionId`, `cwd`, `status`
   (`idle`/`busy`), `procStart`, `kind`, and `entrypoint`. Both terminal (`cli`) and
   SDK-driven (`sdk-cli`) processes register, and entries are removed on clean exit.

The gap is therefore discovery (picker), safety (don't double-hold a session), and a
few mutation paths (trash, in-place rewind) that could clobber a file a terminal
process is using.

#### Strategy {#strategy}

- **Union at read time, never bulk import.** `do_list_sessions` merges ledger rows
  with an on-demand filesystem scan of the queried project's JSONL directory.
  External sessions enter sqlite only when actually resumed (via the existing
  `session_init` self-heal), so the cap-20/age-90 eviction policies never fight a
  thousand-file import.
- **Liveness is a uniform annotation, not an external-row property.** A Tug-born
  session can be open in a terminal too (the TUI's `/resume` lists our files). Every
  listed row gets the terminal-liveness check; every resume attempt gets the gate.
- **Hard block.** A session registered to a live terminal process is unresumable from
  Tug, full stop (user decision, see [P03]).
- **Fail open on registry trouble.** The registry is an undocumented Claude Code
  internal. If it is absent or unparseable, listing and resume proceed without
  liveness data — degraded, logged, never wedged.
- **One-time scan cost, cached forever.** Per-file metadata extraction is a streaming
  parse cached in sqlite keyed by `(size, mtime)`; subsequent picker opens are
  stat-only.
- Rust work lands first (scanner, registry, supervisor wiring), then the tugdeck wire
  types and picker UI, then the tugcode rewind guard, then an end-to-end app-test.

#### Success Criteria (Measurable) {#success-criteria}

- A session created in the Claude Code terminal app for project `X` appears in Tug's
  picker when the user types `X`, with real turn count, last prompt, and recency —
  verified by app-test seeding a JSONL into `~/.claude/projects/` and asserting the
  picker row.
- Resuming that session in Tug produces a working card with the full transcript
  replayed, and a sqlite ledger row appears for it afterward — verified by tugcast
  integration test.
- A session whose id appears in `~/.claude/sessions/` with a live pid is shown with
  an in-use badge and its resume is rejected with reason `session_live_in_terminal`
  — verified by supervisor unit test using the test process's own pid.
- A registry entry with a dead pid (crash leftover) does **not** block resume —
  verified by unit test with a known-dead pid.
- Trash and in-place rewind refuse to touch a terminal-live session's JSONL —
  verified by unit tests.
- Second `list_sessions` for the same dir performs zero full-file reads (cache hit)
  — verified by scanner unit test counting reads through an injected reader.

#### Scope {#scope}

1. Terminal-liveness registry reader in tugcast (parse, validate pid, classify).
2. External-session scanner (JSONL metadata extraction) + sqlite scan cache.
3. `list_sessions` union, wire-shape extension, and liveness annotation.
4. Resume gate (`session_live_in_terminal`) and trash gate in the supervisor.
5. Trash support for never-adopted external sessions.
6. tugdeck protocol types, picker data source, and picker row UI (badge, blocked rows).
7. tugcode in-place rewind guard against terminal-live sessions.
8. End-to-end app-test.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Protecting the reverse direction.** A terminal user resuming a session that is
  live in a Tug card cannot be prevented from our side; Tug's own sessions already
  register in `~/.claude/sessions` (as `sdk-cli`), so any protection the TUI offers
  gets our data for free. Nothing more we can do.
- **Bulk import / migration of historical sessions into sqlite.** Union-at-read makes
  it unnecessary ([P01]).
- **Cross-project session browsing.** The picker stays scoped to the typed project
  dir; no global "all sessions everywhere" surface.
- **Exact cost/timing telemetry for pre-adoption turns.** External sessions have no
  `turn_telemetry` rows for their terminal-era turns; the telemetry surfaces degrade
  gracefully (already the case for pre-ledger Tug sessions).
- **Live takeover / handoff protocol** (attaching to a running terminal session's
  process). Detect-and-block only.

#### Dependencies / Prerequisites {#dependencies}

- Claude Code ≥ 2.1.x on the host (registry shape verified against 2.1.173).
- Existing `SessionLedger` sqlite store and `record_spawn`-on-`session_init`
  self-heal in `agent_bridge.rs`.
- Existing `session_live_elsewhere` rejection plumbing in `do_spawn_session`
  (the new reason rides the same error path).

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings`) across the Rust workspace.
- No schema migrations: new sqlite tables via `CREATE TABLE IF NOT EXISTS` only,
  per the no-migration policy documented in `session_ledger.rs`.
- tugdeck state changes must conform to tuglaws (external state through
  `useSyncExternalStore` only — [L02]); cross-check `tuglaws/tuglaws.md` before the
  UI steps and name touched laws in commit messages.
- tugcode is a compiled binary — its step requires a rebuild to test.
- Scanner and registry reader must take injectable roots (tempdir tests; never touch
  the real `~/.claude` from unit tests).

#### Assumptions {#assumptions}

- `claude --resume <id>` continues the same session id and appends to the same JSONL
  (verified: single distinct `sessionId` per file across sampled files).
- `~/.claude/sessions/<pid>.json` entries are removed on clean exit and may go stale
  only on crash (observed: 3 entries for 3 running processes; stale-guard via pid
  check handles the crash case).
- One JSONL = one session; sub-agent transcripts live in a `<sessionId>/subagents/`
  sibling directory, not as sibling `.jsonl` files that could be confused for
  sessions (verified on disk — but the scanner still validates `sessionId` ==
  filename stem as a belt-and-suspenders check).
- JSONL records carry `cwd` on conversational entries, allowing the scanner to
  reject collision artifacts of the lossy `/`→`-` path encoding.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses **explicit, named anchors** and **rich `References:` lines** in
execution steps, per `tuglaws/devise-skeleton.md`:

- Every heading cited elsewhere carries an explicit `{#anchor}` (kebab-case, no
  phase numbers).
- Plan-local design decisions are `[P##]` (`[D##]` is reserved for the global
  `tuglaws/design-decisions.md`); open questions `[Q##]`; specs `S##`; risks `R##`.
  Two digits, never reused.
- Execution steps cite plan artifacts by label and anchor — never line numbers —
  and declare ordering with `**Depends on:** #step-N` lines referencing real step
  anchors.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Registry format stability across Claude Code releases (DECIDED) {#q01-registry-stability}

**Question:** `~/.claude/sessions/<pid>.json` is undocumented; can we depend on it?

**Why it matters:** The liveness gate is built on it; a silent shape change could
either disable the gate (fail-open) or block everything (fail-closed).

**Resolution:** DECIDED (see [P02]). Depend on it with a tolerant parser that
requires only `pid` + `sessionId` and treats everything else as optional; fail open
(no liveness data) on absence or parse failure, with a `tracing::warn`. A probe-style
unit test pins the fields we consume so a vendored-fixture update is a conscious act
when Claude Code changes shape.

#### [Q02] Gating policy for terminal-live sessions (DECIDED) {#q02-gating-policy}

**Question:** Block, warn-and-confirm, or badge-only when a resume target is live in
a terminal?

**Resolution:** DECIDED — always block (user decision, 2026-06-11). See [P03].

#### [Q03] Protecting Tug-live sessions from terminal-side resume (DEFERRED) {#q03-reverse-direction}

**Question:** Can we stop the TUI from grabbing a session that is live in a Tug card?

**Resolution:** DEFERRED — we do not control the TUI. Our processes already register
in the shared registry, so any concurrent-use detection Anthropic ships benefits us
automatically. Revisit if interleaved-transcript reports surface in practice.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Registry shape drifts in a Claude Code release | med | med | Tolerant parser, fail-open, probe test ([R01]) | Probe test fails after a claude upgrade |
| Pid reuse marks a dead session "live" | med | low | `procStart` cross-check ([R02]) | False "in use" reports |
| First scan of a large project dir is slow | low | med | Streaming parse, sqlite cache, picker pending state ([R03]) | Picker open feels sluggish |
| Path-encoding collisions surface foreign sessions | low | low | `cwd` validation in scanner ([R04]) | Wrong-project rows in picker |
| Scan cache grows unboundedly | low | low | Prune rows for vanished files during scan ([R05]) | sessions.db size complaints |

**Risk R01: Registry format drift** {#r01-registry-drift}

- **Risk:** A Claude Code update renames or restructures `~/.claude/sessions` and the
  liveness gate silently stops seeing live sessions.
- **Mitigation:**
  - Parser requires only `pid: number` and `sessionId: string`; all else optional.
  - Absence/parse failure → empty liveness map + `tracing::warn` (fail open).
  - Probe unit test against a vendored fixture of the observed v2.1.173 shape.
- **Residual risk:** Between the drift and our fix, Tug can double-hold a session —
  the same exposure that exists today, never worse.

**Risk R02: Pid reuse** {#r02-pid-reuse}

- **Risk:** A crash leaves a stale registry file; the OS later assigns the same pid
  to an unrelated process, making `kill(pid, 0)` succeed and the session look live.
- **Mitigation:** Compare the entry's `procStart` string against the actual process
  start time (`ps -p <pid> -o lstart=`); mismatch → treat as stale/not-live.
- **Residual risk:** Window between process start and `ps` resolution is racy in
  theory; in practice a mismatch on a reused pid is deterministic.

**Risk R03: First-scan latency** {#r03-first-scan-latency}

- **Risk:** This project's dir holds ~1,070 JSONLs / 3.7 GB; a cold full parse could
  take seconds and the picker would sit in pending.
- **Mitigation:** Streaming line parse (no full-file buffering); `(size, mtime)`
  sqlite cache makes it strictly one-time per file version; the scan runs under
  `tokio::task::spawn_blocking` so the supervisor's control loop never stalls; the
  picker's existing `pending` row covers the wait honestly.
- **Residual risk:** The very first open on a huge dir is slow once. Accepted;
  a background warm-at-startup sweep is a follow-on if it ever grates.

**Risk R04: Encoded-path collisions** {#r04-path-collisions}

- **Risk:** `encodeProjectDir` maps `/`→`-`, so `/a-b` and `/a/b` share a directory;
  a naive scan would list the other project's sessions.
- **Mitigation:** Scanner reads the first conversational record's `cwd` and skips
  files whose `cwd` ≠ the queried `project_dir`.
- **Residual risk:** Files with no `cwd`-bearing record (empty sessions) can't be
  disambiguated — they are also filtered by the `turn_count == 0` rule, so they never
  render.

**Risk R05: Cache growth** {#r05-cache-growth}

- **Risk:** `external_scan_cache` accumulates rows for trashed/deleted files.
- **Mitigation:** Each scan deletes cache rows for this project dir whose file no
  longer exists.
- **Residual risk:** Rows for never-rescanned dirs linger; bytes are trivial.

---

### Design Decisions {#design-decisions}

#### [P01] Union at read time; external sessions never bulk-imported (DECIDED) {#p01-union-at-read}

**Decision:** `do_list_sessions` returns the union of sqlite ledger rows and a
filesystem scan of the queried project's JSONL directory, deduped by session id with
the ledger row winning. No scan result is ever written to the `sessions` table.

**Rationale:**
- The ledger's cap (20 non-live rows/workspace) and 90-day sweep were sized for
  Tug-created volume; importing ~1,000 external sessions would instantly fight both.
- Adoption is already free: the bridge's `record_spawn`-on-`session_init` promotes an
  external session into the ledger on first resume with zero new code.
- Eviction/trash coupling (`trash_for_project_dir`) operates on ledger rows only, so
  never-adopted external JSONLs are untouchable by sweeps **by construction**.

**Implications:**
- The wire response is built from two sources; a `ListedSession` wrapper carries the
  union ([S03]).
- Scan metadata needs its own cache table ([P04]) since the `sessions` table is
  off-limits.

#### [P02] Terminal liveness from ~/.claude/sessions, tolerant and fail-open (DECIDED) {#p02-registry-liveness}

**Decision:** tugcast reads `~/.claude/sessions/*.json` to build a
`sessionId → {status, kind, entrypoint}` liveness map; an entry counts as live only
when its pid passes `kill(pid, 0)` **and** its `procStart` matches the actual process
start time. Absence or unparseability of the registry yields an empty map plus a
warning — never an error.

**Rationale:**
- Verified live on 2.1.173: entries carry `pid`, `sessionId`, `cwd`, `status`
  (`idle`/`busy`), `procStart`, `kind`, `entrypoint`; files are per-pid and removed on
  clean exit.
- Pid-only checks are vulnerable to reuse after a crash ([R02]); `procStart` is the
  cheapest stable discriminator.
- Fail-open keeps Tug usable across Claude Code upgrades; the exposure during a
  drift window equals today's status quo ([R01]).

**Implications:**
- New `terminal_registry.rs` module with an injectable root (tempdir tests).
- The check runs at `list_sessions` (annotation) and `spawn_session`/`trash_session`/
  rewind time (gates) — fresh reads, no long-lived cache (the dir holds a handful of
  tiny files).
- Tug's own sdk-cli claudes appear in the registry; no exclusion needed — the in-Tug
  `session_live_elsewhere` check fires first for sessions this tugcast holds, and a
  match from *another* Tug instance is correctly blocked as in-use.

#### [P03] Terminal-live sessions are hard-blocked (DECIDED) {#p03-hard-block}

**Decision:** A resume whose target session id maps to a live registry entry is
rejected with reason `session_live_in_terminal` (busy or idle alike). The picker
renders such rows disabled with an in-use badge; there is no override.

**Rationale:**
- User decision (2026-06-11): "Always block."
- Double-holding interleaves `parentUuid` branches in one JSONL; Claude tolerates it
  but transcripts turn confusing and one branch silently wins on the next cold resume.

**Implications:**
- New rejection reason rides the existing `build_session_state_frame(errored, …)`
  path; tugdeck maps it to user-facing copy.
- The gate applies to **all** rows (a Tug-born session resumed in a terminal is just
  as blocked).
- Closing the terminal immediately frees the session (registry file removed on exit).

#### [P04] Scan metadata: full streaming parse, cached by (size, mtime) (DECIDED) {#p04-scan-cache}

**Decision:** The scanner extracts per-file metadata (turn count, last user prompt,
name, created/last-used timestamps, cwd) via a single streaming pass, persisted in a
new `external_scan_cache` sqlite table keyed by session id and validated by
`(file_size, file_mtime)`; a matching cache row skips the file read entirely.

**Rationale:**
- Exact turn counts and prompts make external rows indistinguishable from native ones
  in the picker — full UX parity, no special-cased subtitles.
- Tail-window heuristics (read last N KB) fail on sessions ending in a huge assistant
  message; a one-time full pass is simpler and *correct*, and the cache amortizes it
  to zero.
- `(size, mtime)` invalidation is exact for append-only files.

**Implications:**
- New ledger table + two methods; cascade-on-`sessions`-DELETE is NOT wired (cache
  rows are independent of ledger rows by design — [P01]).
- Scan prunes cache rows for vanished files ([R05]).

#### [P05] Additive wire shape: origin + terminal_live on every listed row (DECIDED) {#p05-wire-shape}

**Decision:** The `list_sessions_ok` row shape becomes `ListedSession`: the existing
`SessionRow` fields plus `origin: "tug" | "external"` and
`terminal_live: { status } | null`, where `terminal_live` is computed for ledger and
external rows alike.

**Rationale:**
- Liveness is a property of the session, not of where its metadata came from
  (a Tug session open in a terminal must badge and block too).
- Flattened-additive keeps every existing consumer of `SessionRow` fields compiling
  and parsing unchanged.

**Implications:**
- Rust: serde wrapper with `#[serde(flatten)]`; tugdeck: extended `SessionRow`
  interface with the two new fields required in the protocol guard.
- `session_updated` pushes (ledger-driven) carry `origin: "tug"` implicitly; the
  store treats missing fields as tug/not-live for backward compatibility during
  rollout.

#### [P06] Trash works for never-adopted external sessions (DECIDED) {#p06-external-trash}

**Decision:** `trash_session` accepts an optional `project_dir` in its payload; when
the session id has no ledger row but `project_dir` is supplied, the JSONL is moved to
`.tug-trash/<deletedAt>/` directly (same mechanics, no row deletion). Terminal-live
sessions are refused (`session_live_in_terminal`), mirroring the live-row refusal.

**Rationale:**
- "In total": once external sessions are visible, the trash affordance must work on
  them or the picker has dead buttons.
- Reuses `move_jsonl_to_trash` verbatim; the 7-day trash sweep already covers
  recovery.

**Implications:**
- Trashing an external session removes it from the terminal app's `/resume` list too
  — same user, same files; the existing trash-confirm flow in the picker is the
  consent surface.
- The scan-cache row for the trashed file is pruned on next scan ([R05]).

#### [P07] In-place rewind gated in tugcode (DECIDED) {#p07-rewind-guard}

**Decision:** tugcode's destructive rewind path (`fork: false` JSONL truncation)
checks the terminal registry first and refuses with a user-facing error when another
live process (pid ≠ our own claude child) holds the session. Fork-mode rewind stays
ungated (it only writes a new file).

**Rationale:**
- The resume gate prevents Tug from double-holding going forward, but the terminal
  can resume a Tug-live session *after* the card opened — truncating under a live TUI
  is real data clobbering.
- tugcode owns the file write, so the check belongs there (TS mirror of the Rust
  liveness rule).

**Implications:**
- Small `terminal-liveness.ts` helper in tugcode with injectable registry root;
  tugcode must be rebuilt to test.

---

### Specification {#specification}

**Spec S01: Terminal-liveness algorithm** {#s01-liveness}

Input: registry root (default `~/.claude/sessions/`). Output:
`HashMap<String /* sessionId */, TerminalLiveEntry { status, kind, entrypoint, pid }>`.

1. Read every `*.json` file in the root (non-recursive). Missing root → empty map.
2. Parse leniently: require `pid` (number) and `sessionId` (string); `status`,
   `kind`, `entrypoint`, `procStart` optional. Parse failure → skip file, `warn`.
3. `kill(pid, 0)` (via `libc`): `ESRCH` → stale, skip. Success or `EPERM` → alive.
4. If the entry carries `procStart` and `ps -p <pid> -o lstart=` resolves, compare
   (whitespace-normalized); mismatch → pid reuse, skip.
5. Surviving entries map `sessionId → entry`. `status` absent → `"unknown"`.

Wire status values: `"busy" | "idle" | "unknown"`.

**Spec S02: Scanner extraction rules** {#s02-scanner}

For each `*.jsonl` directly under `<claude_projects_root>/<encodeProjectDir(dir)>/`
(skip subdirectories, `.tug-trash`, dotfiles, and files whose stem is not a UUID),
one streaming pass extracts:

- `turn_count`: count of records with `type == "user"` whose `message.content` is a
  genuine submission — string content, or an array containing at least one
  non-`tool_result` block (mirror of tugcode's `isUserSubmissionContent`).
- `last_user_prompt`: concatenated text of the **last** such submission, truncated to
  `USER_PROMPT_MAX_CHARS` (256).
- `name`: the `title` of the last `type == "ai-title"` record, if any, else `null`.
- `created_at`: first record's `timestamp` (ISO → unix millis), else file mtime.
- `last_used_at`: file mtime.
- `cwd`: first record carrying a `cwd` field; if present and ≠ queried
  `project_dir`, the file is **excluded** (encoding collision, [R04]).
- Sanity: a record `sessionId` ≠ filename stem excludes the file.

Cache table:

```sql
CREATE TABLE IF NOT EXISTS external_scan_cache (
    session_id        TEXT PRIMARY KEY,
    project_dir       TEXT NOT NULL,
    file_size         INTEGER NOT NULL,
    file_mtime        INTEGER NOT NULL,
    turn_count        INTEGER NOT NULL,
    last_user_prompt  TEXT,
    name              TEXT,
    created_at        INTEGER NOT NULL,
    last_used_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS external_scan_cache_project
    ON external_scan_cache(project_dir);
```

Scan procedure per dir: stat each candidate; `(size, mtime)` match in cache → use
cached row; else parse and upsert. Delete cache rows under this `project_dir` whose
file is gone.

**Spec S03: Wire-shape changes** {#s03-wire}

`list_sessions_ok` rows (Rust serde, flattened):

```rust
struct ListedSession {
    #[serde(flatten)] row: SessionRow,   // existing shape, unchanged
    origin: &'static str,                 // "tug" | "external"
    terminal_live: Option<TerminalLiveWire>, // { status: "busy"|"idle"|"unknown" }
}
```

External rows synthesize the `SessionRow` fields: `state: "closed"`,
`card_id: null`, `workspace_key` from the canonical key of the queried dir. Union is
sorted by `last_used_at` descending; dedupe by `session_id`, ledger wins (but its
`terminal_live` is still computed).

New spawn/trash rejection reason: `"session_live_in_terminal"` (rides the existing
`errored` SESSION_STATE frame and `ControlError::CapExceeded`-style rejection path the
same way `"session_live_elsewhere"` does).

`trash_session` payload gains optional `project_dir: string` ([P06]).

tugdeck `protocol.ts`: `SessionRow` gains `origin` and `terminal_live` (with
defaulting for absent fields in the guard so `session_updated` pushes stay valid).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `origin` / `terminal_live` on picker rows | external state (server snapshot) | existing `dev-session-ledger-store` snapshot via `useSyncExternalStore` — fields ride the rows already flowing through it; no new store | [L02] |
| In-use badge / disabled row appearance | appearance | render-from-snapshot props + CSS classes; no React state | [L06] |

No new stores, no new effects; the picker's data source stays a pure recompute over
`(query, ledger snapshot)`.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/terminal_registry.rs` | Spec S01 liveness reader |
| `tugrust/crates/tugcast/src/external_sessions.rs` | Spec S02 scanner |
| `tugcode/src/terminal-liveness.ts` | TS liveness check for the rewind guard |
| `tests/app-test/atXXXX-external-session-picker.test.ts` | end-to-end picker proof (number assigned at authoring time from the AT inventory) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TerminalRegistry`, `TerminalLiveEntry`, `read_live_sessions` | struct/fn | `terminal_registry.rs` | injectable root |
| `scan_external_sessions`, `ExternalSessionMeta` | fn/struct | `external_sessions.rs` | streaming parse |
| `external_scan_cache` table, `get_scan_cache`, `upsert_scan_cache`, `prune_scan_cache` | sqlite/methods | `session_ledger.rs` | [P04] |
| `ListedSession`, `TerminalLiveWire` | struct | `agent_supervisor.rs` | Spec S03 |
| `do_list_sessions` | fn (modify) | `agent_supervisor.rs` | union + annotate |
| `do_spawn_session` | fn (modify) | `agent_supervisor.rs` | terminal gate |
| `do_trash_session` | fn (modify) | `agent_supervisor.rs` | gate + external path |
| `SessionRow` | interface (modify) | `tugdeck/src/protocol.ts` | + `origin`, `terminal_live` |
| `DevSessionsDataSource` | class (modify) | `dev-picker-data-source.ts` | blocked-row kind |
| picker cells/format | components (modify) | `dev-picker-cells.tsx`, `dev-picker-format.ts` | badge + disabled |
| `isSessionHeldByOtherProcess` | fn | `tugcode/src/terminal-liveness.ts` | [P07] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Registry parsing/liveness, scanner extraction, cache validity, union/dedupe, gates | tempdir fixtures, injected roots, own-pid liveness |
| **Unit (bun, pure logic)** | Protocol guard with new fields, data-source row computation incl. blocked rows | no DOM, real data-source class |
| **Integration (Rust)** | Supervisor `list_sessions` over a seeded fake projects root; spawn rejection frames | tugcast tests/ |
| **App-test** | Real app shows an externally-seeded session and resumes it | `just app-test` |

Liveness tests use the **test process's own pid** (genuinely alive, `procStart`
verifiable via `ps`) for the live case and a known-dead pid for the stale case — no
mocks of the OS.

#### What stays out of tests {#test-non-goals}

- Mock-store call-count tests and hand-rolled core interfaces — banned pattern.
- DOM render tests for the badge — no fake-DOM substrate in this repo; the app-test
  covers the rendered surface, pure-logic tests cover the row computation.
- Actual double-resume corruption reproduction — we gate against it; reproducing
  Claude's interleave behavior tests their code, not ours.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Terminal-liveness registry reader | done | 7114679e |
| #step-2 | External-session scanner | done | 48161bce |
| #step-3 | Scan cache in SessionLedger | done | beb0fbaa |
| #step-4 | list_sessions union + wire shape | done | e3f2ffd0 |
| #step-5 | Resume and trash gates | done | 40c68d17 |
| #step-6 | Trash for external sessions | done | 52ac3ccc |
| #step-7 | tugdeck protocol + stores | done | 17c47ed3 |
| #step-8 | Picker UI: badge, blocked rows, external trash | done | 7997d847 |
| #step-9 | tugcode rewind guard + TUI replay tolerance | done | 324b272b |
| #step-10 | End-to-end app-test | done | 5668f448 |
| #step-11 | Integration checkpoint | done | N/A (verification only) |

#### Step 1: Terminal-liveness registry reader {#step-1}

**Commit:** `Add terminal-liveness registry reader to tugcast`

**References:** [P02] Registry liveness, Spec S01, Risk R01, Risk R02, (#q01-registry-stability)

**Artifacts:**
- `tugrust/crates/tugcast/src/terminal_registry.rs` with `read_live_sessions(root) -> HashMap<String, TerminalLiveEntry>`
- Vendored fixture of the observed v2.1.173 entry shape

**Tasks:**
- [ ] Implement Spec S01 (lenient parse, `kill(pid,0)` via libc, `ps` `procStart` cross-check, fail-open)
- [ ] Module docs stating the undocumented-internal dependency and fail-open contract

**Tests:**
- [ ] Live case: entry written with the test's own pid + real `ps` lstart → classified live with correct status
- [ ] Stale case: dead pid → excluded
- [ ] Pid-reuse case: own pid + wrong `procStart` → excluded
- [ ] Missing root / malformed JSON / missing required fields → empty map, no error
- [ ] Probe fixture parses and yields the v2.1.173 field set

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast terminal_registry`

---

#### Step 2: External-session scanner {#step-2}

**Commit:** `Add external session JSONL scanner to tugcast`

**References:** [P04] Scan cache, Spec S02, Risk R03, Risk R04, (#assumptions)

**Artifacts:**
- `tugrust/crates/tugcast/src/external_sessions.rs` with `scan_external_sessions` returning `Vec<ExternalSessionMeta>` (pure scan; caching wired in #step-3)

**Tasks:**
- [ ] Streaming line parse implementing every Spec S02 extraction rule (turn count, last prompt, ai-title name, timestamps, cwd exclusion, sessionId-stem sanity, file filtering)
- [ ] Port `isUserSubmissionContent` semantics from tugcode and note the mirror in both files' docs

**Tests:**
- [ ] Fixture with user submissions, tool_results, ai-title, file-history-snapshots → exact `turn_count`, last prompt, name
- [ ] Empty-session fixture → `turn_count == 0`
- [ ] cwd-mismatch fixture excluded; non-UUID filenames, subdirectories, `.tug-trash` skipped
- [ ] Mismatched in-file `sessionId` excluded
- [ ] Prompt truncation at 256 chars

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast external_sessions`

---

#### Step 3: Scan cache in SessionLedger {#step-3}

**Depends on:** #step-2

**Commit:** `Add external_scan_cache table and cached scan path`

**References:** [P01] Union at read, [P04] Scan cache, Spec S02, Risk R05, (#constraints)

**Artifacts:**
- `external_scan_cache` table in `bootstrap_schema` (CREATE IF NOT EXISTS, no migration)
- `get_scan_cache` / `upsert_scan_cache` / `prune_scan_cache` on `SessionLedger`
- Cached entry point `scan_external_sessions_cached(ledger, project_dir)`

**Tasks:**
- [ ] Wire `(size, mtime)` validity; upsert on miss; prune vanished files per scan
- [ ] Document why this table has **no** cascade trigger on `sessions` ([P01])

**Tests:**
- [ ] Second scan of unchanged dir performs zero file reads (count via injected reader)
- [ ] Touched/appended file re-parses; deleted file's cache row pruned

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 4: list_sessions union + wire shape {#step-4}

**Depends on:** #step-1, #step-3

**Commit:** `Union external sessions into list_sessions with terminal-liveness annotation`

**References:** [P01] Union at read, [P02] Registry liveness, [P05] Wire shape, Spec S03, (#s01-liveness, #s02-scanner)

**Artifacts:**
- `ListedSession` / `TerminalLiveWire` serde structs; `do_list_sessions` builds the deduped, sorted, annotated union

**Tasks:**
- [ ] Synthesize `SessionRow` fields for external rows per Spec S03
- [ ] Compute `terminal_live` for ledger **and** external rows from one registry read per request
- [ ] Dedupe by session id, ledger wins; sort merged set by `last_used_at` desc
- [ ] Run the directory scan and registry read off the control loop via
      `tokio::task::spawn_blocking` (precedent: the parallel scans in
      `workspace_registry.rs`) — `do_list_sessions` must never block CONTROL
      handling on a cold multi-GB parse (Risk R03)

**Tests:**
- [ ] Supervisor test over seeded fake projects root + fake ledger rows: union ordering, dedupe, origin tags
- [ ] Ledger row whose id is in a live registry fixture (own pid) carries `terminal_live`
- [ ] Registry absent → all rows `terminal_live: null`, no failure

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 5: Resume and trash gates {#step-5}

**Depends on:** #step-1

**Commit:** `Block resume and trash of terminal-live sessions`

**References:** [P03] Hard block, [P02] Registry liveness, Spec S03, (#q02-gating-policy)

**Artifacts:**
- `session_live_in_terminal` rejection in `do_spawn_session` (resume mode) and `do_trash_session`

**Tasks:**
- [ ] Gate placement: the terminal-liveness check runs in `do_spawn_session` for
      resume mode on **both** Phase-1 outcomes — fresh insert and reconnect — i.e.
      after Phase 1 completes and before the eager spawn. It must NOT live inside
      the existing `!inserted` branch (where `session_live_elsewhere` sits): the
      primary case, first-ever resume of an external session, is a **fresh insert**.
      On rejection, release the Phase-0/Phase-1 bookkeeping the same way the
      in-Tug rejection does (affinity row, workspace refcount)
- [ ] Emit errored SESSION_STATE frame + control rejection with the new reason
- [ ] Same check at the top of `do_trash_session`

**Tests:**
- [ ] Resume of a session live under the test's own pid → rejected with `session_live_in_terminal`; dead-pid entry → proceeds
- [ ] Fresh-insert path (no prior in-memory entry for the session) is gated — the external-session case
- [ ] Trash of a terminal-live session → refused; non-live → unchanged behavior

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 6: Trash for external sessions {#step-6}

**Depends on:** #step-5

**Commit:** `Allow trashing never-adopted external sessions`

**References:** [P06] External trash, Spec S03, Risk R05, (#p01-union-at-read)

**Artifacts:**
- `trash_session` payload accepts optional `project_dir`; no-ledger-row path moves the JSONL via `move_jsonl_to_trash`

**Tasks:**
- [ ] Extend payload parsing; keep the existing row path untouched when a row exists
- [ ] Broadcast the same `session_updated { removed: true }` push so the picker drops the row

**Tests:**
- [ ] External JSONL (no ledger row) trashed into `.tug-trash/<ts>/`; response ok; second trash → NotFound
- [ ] Missing `project_dir` for an unledgered id → clean error, no panic

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 7: tugdeck protocol + stores {#step-7}

**Depends on:** #step-4

**Commit:** `Carry session origin and terminal liveness through tugdeck protocol (L02)`

**References:** [P05] Wire shape, Spec S03, (#state-zone-mapping)

**Artifacts:**
- `SessionRow` in `protocol.ts` gains `origin` + `terminal_live` (guard defaults absent fields to `"tug"` / `null`)
- `dev-session-ledger-store` passes the fields through unchanged

**Tasks:**
- [ ] Update protocol guard + types; sweep `SessionRow` consumers (`session-name-store`, `resume-sheet`, `action-vocabulary`, `dev-picker-format`) for compile fallout
- [ ] Cross-check tuglaws before touching stores; name laws in the commit message

**Tests:**
- [ ] Protocol guard accepts new-shape and old-shape rows (pure-logic bun:test)
- [ ] Ledger-store snapshot preserves the new fields through patch/replace paths

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/__tests__/protocol.test.ts src/__tests__/session-metadata-store.test.ts`
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 8: Picker UI — badge, blocked rows, external trash {#step-8}

**Depends on:** #step-7

**Commit:** `Show terminal sessions in the picker with in-use blocking (L02, L06)`

**References:** [P03] Hard block, [P05] Wire shape, [P06] External trash, (#state-zone-mapping, #q02-gating-policy)

**Artifacts:**
- Unified list: external rows render with a "terminal" badge; terminal-live rows render disabled with busy/idle indication
- Resume action suppressed on blocked rows; trash on external rows sends `project_dir`
- Error copy for a `session_live_in_terminal` rejection arriving anyway (race: terminal opened after listing)

**Tasks:**
- [ ] Extend `DevSessionsDataSource` rows with blocked/origin attributes (pure recompute, no new state)
- [ ] Badge + disabled appearance via existing Tug components / CSS only — check tugways gallery before adding anything new
- [ ] Keep the `turn_count === 0` hide rule applying to external rows

**Tests:**
- [ ] Data-source pure-logic tests: external rows interleaved by recency, blocked rows marked, zero-turn external rows hidden

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 9: tugcode rewind guard + TUI replay tolerance {#step-9}

**Depends on:** #step-1

**Commit:** `Guard in-place rewind against terminal-live sessions; skip TUI mode records in replay`

**References:** [P07] Rewind guard, [P02] Registry liveness, Spec S01, Spec S02, (#q03-reverse-direction)

**Artifacts:**
- `tugcode/src/terminal-liveness.ts` (`isSessionHeldByOtherProcess(sessionId, opts)`, injectable root, excludes our own claude child pid)
- Check wired into the `fork: false` rewind path only
- `"mode"` added to `SKIPPED_TOP_LEVEL_TYPES` in `tugcode/src/replay.ts` — real
  TUI JSONLs open with a `{"type":"mode",…}` record (verified on disk) that is not
  in the surveyed skip set and would fire the unknown-shape telemetry path on every
  external replay

**Tasks:**
- [ ] Mirror Spec S01 semantics in TS (pid liveness via `process.kill(pid, 0)`, procStart cross-check)
- [ ] Surface refusal as the existing rewind error shape with clear copy
- [ ] Add `"mode"` to `SKIPPED_TOP_LEVEL_TYPES`
- [ ] Rebuild tugcode binary for verification (compiled, no HMR)

**Tests:**
- [ ] Unit: registry fixture with foreign live pid → held; own-child pid only → not held; absent registry → not held
- [ ] Replay unit: a JSONL containing a `mode` record translates with zero `unknown_shape` telemetry emissions

**Checkpoint:**
- [ ] `cd tugcode && bun test`

---

#### Step 10: End-to-end app-test {#step-10}

**Depends on:** #step-4, #step-5, #step-8, #step-9

**Commit:** `app-test: external session appears in picker and resumes`

**References:** [P01] Union at read, [P03] Hard block, (#success-criteria), Spec S02

**Artifacts:**
- `tests/app-test/atXXXX-external-session-picker.test.ts` (next free AT number from the inventory)

**Tasks:**
- [ ] Seed a realistic JSONL (matching cwd) into the real `~/.claude/projects/<encoded temp project dir>/` under a unique-per-run temp project path; clean up in teardown even on failure
- [ ] The seeded JSONL is **TUI-shaped**: includes `mode`, `permission-mode`, `file-history-snapshot`, and `ai-title` records around the conversational entries, so the replay path is exercised against what terminal sessions actually contain (Spec S02, #step-9)
- [ ] Drive the picker: type the temp project path, assert the external row (badge, prompt, turn count), resume it, assert the transcript replays cleanly
- [ ] Liveness leg: write a registry entry for the seeded session with the test runner's pid; assert the row is blocked; remove entry; assert resumable

**Tests:**
- [ ] The app-test itself, ending with the greppable `VERDICT: PASS|FAIL` line

**Checkpoint:**
- [ ] `just app-test atXXXX-external-session-picker.test.ts` → `VERDICT: PASS`

---

#### Step 11: Integration checkpoint {#step-11}

**Depends on:** #step-6, #step-9, #step-10

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria), [P01]–[P07]

**Tasks:**
- [ ] Verify the full surface end to end: list → badge → block → resume → ledger adoption → trash, plus rewind refusal

**Tests:**
- [ ] Full suites green

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit`
- [ ] `cd tugcode && bun test`
- [ ] `just app-test atXXXX-external-session-picker.test.ts` → `VERDICT: PASS`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Tug's session picker lists, badges, safely resumes, and manages
every Claude Code session on disk for a project — terminal-born and Tug-born alike —
with terminal-live sessions hard-blocked from double-holding.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Terminal-created sessions appear in the picker with real metadata (app-test)
- [ ] Resuming one yields a replayed card and a self-healed ledger row (integration test)
- [ ] Terminal-live sessions badge and hard-block across resume, trash, and in-place rewind (unit tests)
- [ ] Stale registry entries (dead pid / reused pid) never block (unit tests)
- [ ] Registry absence degrades to today's behavior with a warning, never an error (unit test)
- [ ] Repeat listings are stat-only via the scan cache (unit test)

**Acceptance tests:**
- [ ] `cargo nextest run` green with `-D warnings`
- [ ] `bun test` (tugdeck, tugcode) green
- [ ] app-test `VERDICT: PASS`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Background warm scan at tugcast startup for recent project dirs (only if first-open latency grates — [R03])
- [ ] Surface terminal-live sessions as live-readable transcript viewers (read-only attach)
- [ ] Revisit [Q03] if Anthropic ships concurrent-use takeover atop the registry's `peerProtocol`

| Checkpoint | Verification |
|------------|--------------|
| Rust suites | `cd tugrust && cargo nextest run` |
| Frontend suites | `cd tugdeck && bun test && bunx tsc --noEmit` |
| Bridge suite | `cd tugcode && bun test` |
| End to end | `just app-test atXXXX-external-session-picker.test.ts` |
