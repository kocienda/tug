## Anchored ordering for durable ink rows {#ink-anchored-ordering}

### Purpose {#purpose}

A durable ink row — a `/commit`, `/dash-join`, or `/dash-discard` landing receipt, a `$` shell exchange, a refs run — must restore to the transcript position it was written at, not to a position re-derived from clocks at every relaunch. Today the restore path seats ink by timestamp sort, and the timestamps it sorts against include fabricated ones: every replayed assistant content block is minted with `Date.now()`, so any receipt written before a relaunch loses the sort to the turn it actually followed and lands thousands of pixels above the bottom of the transcript, invisible from where the user is put. This plan makes ordering a written fact: the ledger row records, at write time, the turn it follows, and restore places rows by that anchor instead of guessing by clock. It completes the durable-ink arc ([D155] pinned the rows to the right session; this pins them to the right place) and repairs the [D111] breach — Claude append order is truth, never global-sort — that the restore path has been committing all along.

### Plan Metadata {#plan-metadata}

- **Author:** Claude (Fable 5), from the 2026-08-24 live diagnosis in session `@tugtool/milky-rain`
- **Created:** 2026-08-24
- **Last updated:** 2026-08-24
- **Status:** draft
- **Review rounds:** 0

### Review Record {#review-record}

**Round 1 — 2026-08-24, opus.** Reviewed `plan:f6dee6b1a04ef996`. Lint: 0 errors, 0 warnings (clean on arrival; nothing mechanical to fix). Oriented on: the whole document — a never-reviewed first pass. Read against the real tree: `reducer.ts` (`turnSortTs`, `insertTurnByTimestamp`, `appendTurnInterleavingInk`, `handleContentBlockStart`, `buildTurnEntry`), `events.ts`, `protocol.ts`, `tugcode/src/replay.ts` (`noteContentMsgId`, `computeDeadEntryIndices`, `TranslateJsonlEntryOptions`), `shell_ledger.rs`, `refs_ledger.rs`, `ledger_integrity.rs`, and six live session JSONL files.

Applied, in descending severity: **a compile-blocking scope hole** — the plan named only tugcode's `ContentBlockStart*` types for the new `timestamp` field, but the deck defines its own `ContentBlockStartEvent` (`events.ts:190`) whose trailing `[key: string]: unknown` would have typed `event.timestamp` as `unknown`, so [P04]'s `event.timestamp ?? Date.now()` could not have typechecked; `events.ts` is now in Scope, S04, and the Step 3 tasks. **A silent-failure hole in the tail reader** — S02 accepted any `type: "assistant"` line, but replay drops `isMeta` entries (replay.ts:1393) and excludes `isSidechain` ones from the chain walk (`computeDeadEntryIndices`), so an anchor naming either could never resolve; both are now filtered, with the measured note that sidechain is a legacy shape (0 occurrences across 46,000+ assistant records in the six most recent sessions). **A materially understated risk** — R02 called an out-of-window anchor an edge case; it is the common case (`DEFAULT_REPLAY_WINDOW_TURNS = 25`, protocol.ts:104; the incident session had 402 turns with `firstLoadedTurnIndex: 377`), so it is reframed with the measurement, given an explicit "do not read a mostly-fallback transcript as a broken implementation" warning, and promoted to Success Criterion 3.

Strengthened rather than corrected: **[P04] turns out to complete a half-built seam, which is the strongest available argument for the mechanism** (rubric axis 2 — build on what ships). The reducer *already* reads `event.timestamp` on `content_block_start` at reducer.ts:1622; `ToolUseEvent.timestamp` already carries the identical "replay stamps it, live omits it" contract in the same file; `turn_complete` already resolves `event.timestamp ?? Date.now()` (reducer.ts:3079). The consumer was written and the producer never finished — now recorded in [P04]. The msgid-resolution deep dive stopped hedging about "several assistant messages with distinct ids": `suppressTurnComplete` exists precisely because one `message.id` spans several JSONL records, distinct ids each emit their own `turn_complete`, and a live file confirms four consecutive records sharing `msg_011CeN2J7xHBKWhE4skVtfms` — so an anchor names exactly one turn, and the messageKey-prefix check is retained only for the compaction re-append case.

Tuglaws cross-check. **[L23]** (internal operations must never lose user-visible state) is the law the current code breaks and this plan restores — honored, and its posture is right: every failure path ([P03] fallback, R01 parse failures, an unresolvable anchor) degrades *placement* and never drops a row. **[L26]** honored — [P06] keeps `landingExchangeId`'s `restored-<id>` identity so a receipt never re-keys between its live and restored copies. **[L02]** honored — `TurnEntry.anchorMsgId` lands in the store wrapper's `_transcript` and reaches React only through existing `useSyncExternalStore` snapshots; no new subscription. **[L06]** untouched — placement is computed in pure reducer helpers, not appearance state. **[LR1]** honored, no new opens. **[LR3]** verified as a non-issue rather than assumed: `salvage_into`'s `common_columns` already intersects column sets, so a post-migration database salvaging a pre-migration corrupt file yields NULL anchors — recorded in S01 with an explicit "do not add column-matching logic here." **[LR5]** correctly inapplicable — the ink ledgers are per-instance, not the shared `changes.db`; the plan's Constraints claim on this was checked and is accurate. The State Zone Mapping was present and correct on arrival.

Not changed, deliberately: the no-backfill non-goal (a guessed anchor is the disease the plan cures — the rationale is sound and the honest-timestamp repair covers legacy rows anyway); the choice of `message.id` over the JSONL entry `uuid` as the anchor value (uuid is per-entry unique and is what `fork_point` uses, but `TurnEntry` carries no uuid, so `msg_id` is the only value resolvable on the deck without new turn identity); and the step sequencing, which is sound — Step 3's note that tugcode edits stay inert until `just build-app` already closes the one verification gap a reader would worry about. Nothing required the user's judgment, so no question was raised and no `[Q##]` was deferred.

### Phase Overview {#phase-overview}

#### Context {#context}

The fifth "vanished receipt" incident (2026-08-24, session `@tugtool/juicy-roach`) was diagnosed live and is the first in which the row survived every prior fix: the `/dash-join` receipt (`shell_exchanges` row 1124, "joined 02e3b220fc · dash-on-ramp → main") was in the ledger under the exact id the deck resumes, the store restore census read `ledgerTotal: 10, applied: 10, complete, answered`, and the receipt block was painted in the DOM — at `top: -5011px`, roughly five thousand pixels above the bottom of the transcript, behind the final assistant turn. The user, landed at the bottom, saw nothing.

The mechanism, read from the running app and the code:

- The committed transcript orders entries by `turnSortTs` (`tugdeck/src/lib/code-session-store/reducer.ts:5596`): `turn.messages[0]?.createdAt ?? turn.endedAt`.
- Replayed **user** openers carry their historical time (`createdAt: submitAt`, reducer.ts:971). Replayed **assistant** content blocks do not: `handleContentBlockStart` mints every Message with `createdAt: Date.now()` (reducer.ts, `const now = Date.now()` in the mint path), because the replay's `content_block_start` events (`tugcode/src/replay.ts`, emission around line 1814) carry no timestamp field — even though the JSONL entry has one and `parseEntryTimestamp` already exists and already rides `turn_complete`.
- So after any relaunch, an assistant-opened turn's sort key is the relaunch wall-clock — in the observed incident, `createdAt 17:42:13` on a turn whose own `endedAt` was `17:37:37`. Every ink row written before the relaunch (the join settled `17:38:31`) sorts before it. `insertTurnByTimestamp` (reducer.ts:5660) and `appendTurnInterleavingInk` (reducer.ts:5686) both then do exactly what the fabricated timestamp tells them.

Three seams of the same reconstruction have now failed in sequence across the five incidents: identity (fixed by [D154]/[D155] — lineage-head resolution, fork-time transfer, adoption sweeps), completeness (fixed by the [P07] restore census), and now ordering. The common cause is that the transcript is rebuilt at every boot by merging three streams — JSONL replay, shell-ledger restore, refs-ledger restore — that share no ordering spine, so position is re-derived from clocks at read time when it was known with certainty at write time. This plan writes it down at write time.

#### Strategy {#strategy}

Two independent repairs, both required:

1. **Anchors** (the durable fix). Every ink row gains an `anchor_msg_id` column: the Claude assistant `message.id` of the newest assistant JSONL line in the session at the moment the row is written. tugcast stamps it server-side at the three ink write gateways, after lineage-head resolution, by reading the tail of the session's own JSONL file — no client or wire changes on the write path, and the stamp covers every writer (deck-initiated landings, `$` shell rows, refs runs, future non-deck writers). On restore, the deck seats each anchored row immediately after the transcript entry whose wire `msgId` matches the anchor; `TurnEntry.msgId` already exists, is assigned by the backend, and is stable across replays because replay re-derives it from the same JSONL (`entryMsgId` in `tugcode/src/replay.ts`). Rows sharing an anchor order by ledger row id. A null or unresolvable anchor falls back to today's timestamp insert — degraded placement, never a lost row.

2. **Honest timestamps** (the standing lie, fixed regardless). Replay's `content_block_start` gains an optional `timestamp` carrying the JSONL entry's historical time; the reducer's mint paths use `event.timestamp ?? Date.now()`. After this, `turnSortTs` never sees a fabricated time again — which fixes the observed bug even for legacy rows that predate the anchor column, and keeps the timestamp fallback honest forever.

The placement change is confined to ink: Claude turns keep their existing append/interleave discipline untouched, live ink appends keep landing at the end of the transcript (correct at the moment of the act), and anchors govern only where a *restore* seats a row.

#### Success Criteria (Measurable) {#success-criteria}

1. A landing receipt written after the session's last turn is the **final** transcript entry after a full app relaunch — asserted store-level by a new app-test, and the assertion fails against the pre-fix binary.
2. Replayed assistant messages carry historical `createdAt`: for every replayed turn, `messages[0].createdAt ≤ endedAt`. (The observed incident had `createdAt` 4m36s *after* `endedAt`.)
3. Older ink rows whose anchor turn is outside the loaded window do not regress: they seat by honest timestamp, and when `loadPrevious` brings their anchor turn in, they move to follow it ([P05]). This is the *common* path on a long session, not an edge case — see R02.
4. `shell_exchanges` and `refs_runs` rows written by a stamped binary carry a non-null `anchor_msg_id` whenever the session's JSONL has at least one assistant line; rows written before the migration read back with `anchor_msg_id = NULL` and restore exactly as today.
5. `cargo nextest run` green across the workspace; `bunx vite build` green; `just app-test-changed` green.

#### Scope {#scope}

- `tugrust/crates/tugcast/src/shell_ledger.rs`, `refs_ledger.rs` — schema migration, row structs, write-through, serialization.
- `tugrust/crates/tugcast/src/session_ledger.rs` — the JSONL tail reader (it owns `claude_projects_root` and `claude_project_dir`).
- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` (`record_landing_receipt`), `feeds/shell.rs` (settle-time persist), `feeds/refs.rs` (`record_run` site) — anchor stamping.
- `tugcode/src/types.ts`, `tugcode/src/replay.ts` — `timestamp` on `content_block_start`.
- `tugdeck/src/lib/code-session-store/reducer.ts`, `code-session-store/events.ts`, `code-session-store/types.ts`, `code-session-store.ts`, `shell-session-store.ts`, `action-dispatch.ts` — honest mints, anchor threading, anchored placement. `events.ts` is not optional: it holds the deck's own `ContentBlockStartEvent` (events.ts:190), and without a declared `timestamp?: number` there the field is reachable only through that interface's `[key: string]: unknown` index signature, which types it `unknown` — `event.timestamp ?? Date.now()` would not typecheck as a number.
- `tugdeck/src/test-surface.ts`, `tests/app-test/` — ordering facts and the relaunch app-test.
- `tuglaws/design-decisions.md` — the doctrine entry.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Re-keying or re-anchoring rows written before this change. Legacy rows keep `NULL` anchors and timestamp placement; the honest-timestamp repair alone fixes their observed misplacement.
- Any change to live streaming placement, Claude turn ordering, or the turn commit machinery.
- Anchoring the *other* durable surfaces (`sessions.db` per-session tables, `changes.db` attribution) — deferred with the same rationale as in the durable-commit-stability plan.
- A backfill that fabricates anchors from timestamps. A guessed anchor is the disease this plan cures.

#### Dependencies / Prerequisites {#dependencies}

The [D155] durable-ink arc (landed `d9dc7040f`): lineage-head resolution (`SessionLedger::resolve_to_lineage_head`), the fork-time ink transfer, and the adoption sweeps. Anchor stamping happens *after* head resolution so the JSONL read targets the head's file — the same file the deck will replay.

#### Constraints {#constraints}

- `-D warnings`: an unconsumed `pub fn` is a hard error in the tugcast bin target, including code whose only consumers are `cfg(test)` — the durable-commit-stability run had to fold steps twice for this. Every step below leaves its new code consumed by production paths within the same round.
- Ledger schema changes ride the existing in-open migration pattern (`table_columns` probe + guarded `ALTER TABLE`, as `migrate_sessions_add_fork_provenance`, session_ledger.rs:2393) — these are per-instance databases with `CREATE TABLE IF NOT EXISTS` DDL and no `PRAGMA user_version` regime.
- No client→tugcode message changes, so the tugcode inbound allowlist is untouched. `content_block_start` flows tugcode→client and is additive.
- App-tests: selective, store-level assertions (`__tug` facts), never DOM row counts, never piped output.

#### Assumptions {#assumptions}

- Claude Code's JSONL keeps writing one JSON object per line with `"type":"assistant"` entries carrying `message.id`, and a fork's JSONL is a byte-copy of the parent's up to the fork point (verified during the [D154] work), so anchors written under the parent resolve in the fork's replay unchanged.
- `TurnEntry.msgId` for any turn with assistant content is Claude's real `message.id` (the open-turn tracker flips from the synthesized opener id on the first content event — `noteContentMsgId`, replay.ts). Turns with *no* assistant content (local slash-command turns) keep synthesized ids; anchors never point at those (the anchor is by definition an assistant id), so a receipt written right after one anchors to the previous assistant turn — an accepted one-slot imprecision, see [P03].

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

*(none — the design decisions below were settled from the live diagnosis and the code)*

### Risks and Mitigations {#risks}

- **R01 — JSONL format drift.** The tail reader parses a foreign format (Claude Code's session files). Mitigation: fully permissive parse — any line that fails to parse, lacks the fields, or surprises in any way yields `None`, which writes a `NULL` anchor and preserves today's behavior. A malformed file can degrade placement; it can never block a receipt write (stamping failures log at `warn` and continue).
- **R02 — anchor beyond the loaded turn window (the common case, not an edge case).** Shell rows restore whole while Claude turns are windowed at `DEFAULT_REPLAY_WINDOW_TURNS = 25` (`tugdeck/src/protocol.ts:104`). Measured on the incident session at diagnosis time: 402 total turns, `firstLoadedTurnIndex: 377`, 10 ink rows — so at first paint most anchors resolve to nothing. **An implementer must not read a mostly-fallback transcript as a broken implementation.** This is by design and is safe for two independent reasons: the fallback is honest once [P04] lands, and the row that actually matters — the receipt just written, the one every incident has been about — anchors to a turn that is always inside the window. The hoist ([P05]) then re-seats older rows as `loadPrevious` brings their anchors in. Pinned by Success Criterion 3.
- **R03 — restore/replay race.** `list_shell_exchanges_ok` can land before the JSONL replay, so anchors may be unresolvable at apply time. Mitigation: the same fallback plus the hoist — when the anchor turn arrives, its anchored ink moves to follow it. Final state is identical in both arrival orders; a reducer unit test pins both orders.
- **R04 — two ledgers, one anchor.** Shell and refs row ids are not comparable across databases. Mitigation: rows sharing an anchor order by `(settled_at_ms, ledger row id)` — cross-ledger ties break on the honest settle time, same-ledger ties on the monotonic id. In practice a refs run and a receipt sharing an anchor is rare and the tiebreak is deterministic either way.

### Design Decisions {#design-decisions}

#### [P01] The anchor is stamped server-side, at the write gateway (DECIDED) {#p01-server-stamped}

tugcast stamps `anchor_msg_id` inside the three ink write paths, not the deck. Rationale: one authority covers every writer (a landing initiated from any deck, a `$` row, a refs run, any future writer), the write-path wire is untouched, and the stamp composes with lineage resolution in the same place the [D155] work already put it — resolve the head, then read the head's JSONL. The rejected alternative — the deck sending its last committed turn's `msgId` with each initiating message — was client-visible state and therefore tempting, but it needs new fields on the shell input message and all three changeset verb requests, covers only deck-initiated writes, and puts N clients in charge of a fact one server can own.

#### [P02] The anchor value is the newest assistant `message.id` in the session JSONL (DECIDED) {#p02-assistant-msg-id}

The tail reader walks the session JSONL backward and returns the first (newest) line with `"type":"assistant"` and a non-empty `message.id`. That value is exactly what replay assigns as the turn's `entryMsgId` and what the committed `TurnEntry.msgId` holds for any turn with assistant content — so resolution on the client is a plain `msgId` comparison against state the transcript already carries, no new turn identity, no uuid mapping tables. Client-minted `turnKey` was rejected as the anchor: it is a React-key seed minted fresh per receipt (`mintTurnKey()`, code-session-store.ts:934) and does not survive a relaunch.

#### [P03] Placement: after the last entry whose `msgId` matches; ledger id orders siblings; fallback is timestamp, never loss (DECIDED) {#p03-placement-rule}

An anchored row seats immediately after the last transcript entry with `msgId === anchor`, and after any already-seated ink rows carrying the same anchor with a smaller ledger row id (parsed from the `restored-<id>` exchange id; cross-ledger tiebreak per R04). No match — null anchor, legacy row, anchor turn outside the loaded window, foreign anchor — falls back to `insertTurnByTimestamp` exactly as today. The fallback is deliberate [L23] posture: a bad anchor degrades placement, it never drops or hides a row. The accepted imprecision: a receipt written immediately after a turn with no assistant content anchors one turn early. Deterministic, rare, and honest — the receipt is adjacent to where the user acted.

#### [P04] Replay carries honest timestamps on `content_block_start` (DECIDED) {#p04-honest-timestamps}

`ContentBlockStartText/Thinking/ToolUse` (tugcode/src/types.ts:369–393) gain optional `timestamp?: number` (epoch ms). The replay path sets it from `parseEntryTimestamp(entry)` — the helper already exists (replay.ts:829) and already rides `turn_complete`. The live path leaves it unset: live blocks arrive at their real time and `Date.now()` is honest there. The reducer's mint sites use `event.timestamp ?? Date.now()`. This is not an anchors dependency — it is its own [L23]-grade repair (a transcript entry must never wear a fabricated time) and it is what fixes placement for legacy NULL-anchor rows.

**This invents nothing — it finishes a seam the tree already half-built, which is why it is the right mechanism rather than merely a workable one.** Three facts found in the code: (a) `ToolUseEvent.timestamp?: number` already exists in `tugdeck/src/lib/code-session-store/events.ts` with the doc "Original JSONL entry time (epoch ms). Present only on the resume/replay path (tugcode's translator stamps it); live frames omit it" — the exact contract proposed here, already shipping on a sibling event; (b) `turn_complete` already resolves `const endedAt = event.timestamp ?? Date.now()` (reducer.ts:3079), the exact expression proposed here; and (c) **the reducer already reads `event.timestamp` on `content_block_start`** at reducer.ts:1622, in the background-agent-child branch — tugcode has simply never sent it, so that read has always fallen through to `Date.now()`. The consumer was written and the producer was never finished. [P04] finishes it.

#### [P05] Late arrivals hoist their anchored ink (DECIDED) {#p05-hoist}

`appendTurnInterleavingInk` (reducer.ts:5686), which today slides an arriving replayed Claude turn left past trailing ink with greater timestamps, additionally moves any ink entries anchored to the arriving turn's `msgId` to sit immediately after it (preserving their [P03] sibling order). This is what makes the final transcript identical whether the ledger restore or the JSONL replay lands first, and what re-seats R02's window-edge rows when older pages load.

#### [P06] Live ink placement is unchanged (DECIDED) {#p06-live-unchanged}

A live receipt or shell row still appends at the transcript's end via the existing `upsertInkTurn` in-place/timestamp path — the end *is* its correct position at the moment of the act, and `landingExchangeId` already gives the live copy the same `restored-<id>` identity the later restore replays, so the anchor governs the row from the next restore on without ever re-keying it ([L26]).

### Deep Dives {#deep-dives}

#### The three write gateways, post-[D155] {#write-gateways}

All three already resolve the lineage head before writing, so the stamping call sites are exactly where the head id is already in hand:

- **Landing receipts:** `record_landing_receipt` (feeds/agent_supervisor.rs, ~line 4790 region) — takes `sessions: Option<&Arc<SessionLedger>>`, resolves the head, builds the `NewShellExchange`. Three production call sites (`/commit` ~4823, `/dash-join` ~5278, `/dash-discard` ~5899).
- **`$` shell rows:** feeds/shell.rs:949–961 — `ink_session` resolved from `sessions_ledger`, then `NewShellExchange { tug_session_id: ink_session, … }`.
- **Refs runs:** feeds/refs.rs:702–714 — same shape, `NewRefsRun { tug_session_id: ink_session, … }` into `RefsLedger::record_run`.

The JSONL path is `claude_project_dir(&claude_projects_root, &row.project_dir).join(format!("{head}.jsonl"))` — the same derivation `ink_adoption::run_backfill` uses. `SessionLedger` owns `claude_projects_root` (session_ledger.rs:870), so the tail reader lives there as a method taking the head id, doing its own `get()` for `project_dir`.

#### The tail read, precisely {#tail-read}

Open the file, seek to `max(0, len − 64 KiB)`, read to end, split on `\n`, discard the first fragment when the seek was non-zero (it may be a partial line), and scan the remaining lines **backward**. For each line, `serde_json::from_str::<serde_json::Value>`; skip on parse error; accept the first line where `v["type"] == "assistant"` and `v["message"]["id"]` is a non-empty string **and** neither `v["isSidechain"]` nor `v["isMeta"]` is `true`; return that id.

Those two exclusions are load-bearing, not defensive noise: replay drops both, so their `message.id` never becomes any turn's `msgId` and an anchor naming one can **never** resolve — a silent permanent fallback. `isMeta` entries return early in the per-entry translator (`tugcode/src/replay.ts:1393`); sidechain entries are excluded from the chain walk (`computeDeadEntryIndices` skips `isSidechain === true`). Sidechain is a legacy shape — a survey of the six most recent session files at plan time found 0 sidechain entries among 46,000+ assistant records, and `JsonlEntry.isSidechain`'s own doc says older sessions persisted agent entries that way — but the filter costs one condition and the failure it prevents is invisible. Anything else — missing file (zero-turn session), empty file, no assistant lines in the window — returns `None`. 64 KiB comfortably covers the distance from a turn's last assistant line to EOF (trailing progress/summary lines are small); a turn whose final assistant message alone exceeds the window yields `None` and the fallback, which is acceptable by [P03].

#### Why `msgId` resolution is safe on the deck {#msgid-resolution}

`TurnEntry.msgId` (code-session-store/types.ts:438 region) is "the wire-correlation identifier assigned by the backend" — replay derives it from the JSONL entry's own `message.id` (`entryMsgId`, replay.ts:1805 region), so the same file produces the same ids on every boot, and a fork's copied JSONL produces the parent's ids up to the fork point. The tracker (`noteContentMsgId`) swaps `openTurnMsgId` to each content event's id, so it holds the id the turn *ended* on; `turn_complete` carries that value and `buildTurnEntry` writes it to `TurnEntry.msgId`. The tail reader returns the newest assistant line's id, which is that same last line. The two derivations meet by construction.

One shape makes this exact rather than approximate: Claude Code sometimes persists a single assistant message across **several consecutive JSONL records sharing one `message.id`** (one snapshot at thinking-complete, another at text-complete). Replay handles it with `suppressTurnComplete` (`TranslateJsonlEntryOptions`, tugcode/src/replay.ts) so those records stay one logical turn — verified in a live session file, where the final four assistant records all carry `msg_011CeN2J7xHBKWhE4skVtfms`. Distinct ids in one turn cannot happen: each would have emitted its own terminal `turn_complete`. So an anchor names exactly one turn.

The messageKey-prefix check is kept as belt-and-braces for the compaction re-append case, where a `message.id` can appear at two file positions: `wireMessageKey` is `` `${msgId}-b${blockIndex}` `` (reducer.ts:245), so an entry holding a message whose `messageKey` starts with `` `${anchor}-b` `` also matches. The placement helper checks `msgId` first, messageKey prefix second, and takes the **last** match either way.

#### What the observed incident becomes under this plan {#incident-replay}

Receipt 1124 would carry `anchor_msg_id` = the final assistant message id of the dash-on-ramp report turn. After relaunch, replay rebuilds that turn with the same `msgId`; the restore seats the receipt immediately after it — the last entry in the transcript, exactly where the user watched it appear before relaunching. Independently, [P04] gives that turn `createdAt 17:37:xx` instead of `17:42:13`, so even the fallback path now orders it correctly.

### Specification {#specification}

#### S01 — Ledger schema {#s01-schema}

Both ink databases gain one nullable column, added by a guarded migration run before the DDL batch in each `open`:

```sql
ALTER TABLE shell_exchanges ADD COLUMN anchor_msg_id TEXT;  -- shell_ledger.rs
ALTER TABLE refs_runs       ADD COLUMN anchor_msg_id TEXT;  -- refs_ledger.rs
```

Migration shape mirrors `migrate_sessions_add_fork_provenance` (session_ledger.rs:2393): probe `pragma table_info`, `ALTER TABLE` only when absent, tolerate the duplicate-column race. It runs inside `from_conn` (the shared path both `open` and `open_in_memory` call, shell_ledger.rs:148 / refs_ledger.rs:94) — **before** its `execute_batch` DDL, with the `table_columns`-empty early return doing the work for a brand-new database where the table does not exist yet and `ALTER` would fail.

Three ledger-law checks, all verified against the code rather than assumed:

- **[LR1]** honored with no new surface — both ledgers already open through `tugcore::ledger_db::open` and this plan adds no `Connection::open(`, so the `no_ad_hoc_ledger_opens` test stays green.
- **[LR3]** is a verified non-issue, not a hazard to design around: the quarantine path calls `salvage_into(…, &["shell_exchanges"], …)`, whose `common_columns` (ledger_integrity.rs:377) **intersects** the live and quarantined column sets. A fresh database carrying `anchor_msg_id` salvaging from a pre-migration corrupt file simply omits the column and the recovered rows read NULL — exactly the legacy-row behavior [P03] already specifies. Do not add column-matching logic here.
- **[LR5]** does not apply: it governs the *shared* `changes.db` and its `PRAGMA user_version` constant. `shell_exchanges.db` and `refs.db` are per-instance (`~/Library/Application Support/Tug/instances/<id>/`), so no `CHANGES_SCHEMA_VERSION` bump and no `CHANGES_MIGRATIONS` entry is required or wanted. Downgrade is safe in the one direction that can happen: an older binary opening a migrated per-instance database ignores the unknown column and its INSERTs leave it NULL. `NewShellExchange` / `ShellExchangeRow` / `NewRefsRun` / `RefsRunRow` each gain `anchor_msg_id: Option<String>`; `ShellExchangeRow` derives `Serialize`, so `list_shell_exchanges_ok` carries the field with no further work; the refs list response follows its existing serialization the same way. `rekey_session` in both ledgers moves whole rows, so anchors ride re-keying untouched.

#### S02 — The tail reader {#s02-tail-reader}

```rust
/// session_ledger.rs
impl SessionLedger {
    /// The newest assistant `message.id` in `session_id`'s JSONL, or None.
    /// Never errors: any surprise (missing row, missing file, parse failure)
    /// is a None, logged at debug. Callers write it as the ink anchor.
    pub fn latest_assistant_msg_id(&self, session_id: &str) -> Option<String>
}
```

Consumed in the same round by the three gateways (S03), so `-D warnings` is satisfied.

#### S03 — Stamping at the gateways {#s03-stamping}

Each gateway computes `let anchor = sessions.and_then(|s| s.latest_assistant_msg_id(&head));` after its existing head resolution and sets it on the row struct. `record_landing_receipt` already receives the sessions ledger; feeds/shell.rs has `sessions_ledger` in scope at the settle; feeds/refs.rs has `sessions` threaded since [D155].

#### S04 — The wire and the deck threading {#s04-threading}

- tugcode `ContentBlockStart*` types gain `timestamp?: number`; replay sets it from `parseEntryTimestamp(entry)` at the emission site (replay.ts ~1814, both union arms); live emission leaves it absent (`tugcode/src/session.ts` has five `content_block_start` emit sites — none of them change).
- The deck's **own** `ContentBlockStartEvent` (`tugdeck/src/lib/code-session-store/events.ts:190`) gains the same `timestamp?: number`, documented like its `ToolUseEvent` sibling. Required for compilation, not tidiness: that interface ends in `[key: string]: unknown`, so an undeclared `timestamp` reads as `unknown` and `event.timestamp ?? Date.now()` will not typecheck as a number.
- Reducer mint sites — `handleContentBlockStart`'s `const now = Date.now()` and the defensive mints in `handleTextDelta` / `handleToolUse` — become `event.timestamp ?? Date.now()` (the defensive mints read it when present on their events; where their events carry none, `Date.now()` stands, as those are live-path irregularities).
- `applyRestoredShellExchanges` (shell-session-store.ts:463) passes `anchorMsgId: typeof r.anchor_msg_id === "string" ? r.anchor_msg_id : undefined` into `ingestShellExchange`; the event type, `shellMessage`, and `buildShellTurnEntry` thread it onto a new optional `TurnEntry.anchorMsgId`. The refs restore apply (`list_refs_ok`, action-dispatch.ts:1604) threads the same field through its ink path (`refs-<runId>` turn, reducer.ts:5792).

#### S05 — Placement {#s05-placement}

```
insertInkAnchored(transcript, entry):
  if entry.anchorMsgId is undefined → insertTurnByTimestamp (today's path)
  i = last index where transcript[i].msgId === anchor
      OR transcript[i] has a message with messageKey starting `${anchor}-b`
  if no i → insertTurnByTimestamp
  advance i past consecutive following ink entries with the same anchorMsgId
      and a smaller (settledAtMs, ledgerRowId)     // [P03]/R04 sibling order
  splice entry at i+1
```

`upsertInkTurn` keeps its replace-in-place-by-`turnKey` head and calls `insertInkAnchored` for the mint case. `appendTurnInterleavingInk` gains the [P05] hoist: after seating the arriving turn, collect ink entries anywhere in the transcript with `anchorMsgId === turn.msgId`, remove them, and re-splice them after the turn in sibling order. All pure helpers in reducer.ts, unit-testable without a DOM.

### State Zone Mapping {#state-zone-mapping}

| State | Zone | Law |
|---|---|---|
| `TurnEntry.anchorMsgId` (new, optional) | Committed transcript in the store wrapper's `_transcript`; enters React only via `useSyncExternalStore` snapshots | [L02] |
| `anchor_msg_id` on ledger rows / wire | Server-owned durable state; never React state | — |
| Honest `createdAt` on Messages | Existing store data, value repair only; no new state | [L02] |
| Row position | Derived by pure reducer helpers at ingest; never component state, never CSS | [L06] untouched |

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

- **Rust unit (tugcast):** migration adds the column once and tolerates re-open; a legacy database opens and reads NULL anchors; the tail reader against fixture JSONL files (normal tail, trailing non-assistant lines, partial-line seek boundary, empty file, missing file, malformed line); each gateway writes the stamp; `rekey_session` preserves anchors.
- **tugcode unit (bun):** replayed `content_block_start` carries the entry's historical timestamp; live-path emission carries none.
- **Deck unit (bun, existing `__tests__` pattern):** `insertInkAnchored` — resolves by `msgId`, resolves by messageKey prefix, sibling order by `(settledAtMs, id)`, null/unresolved fallback; `appendTurnInterleavingInk` hoist — restore-first and replay-first arrival orders converge on the same transcript; honest-mint — `createdAt` from `event.timestamp` when present.
- **App-test (one, new):** full relaunch ordering. Phase A: real turns, then a `$` shell command and a seeded receipt after the last turn. Phase B: relaunch, assert via store facts that the ink rows are the final transcript entries, in ledger order. `@covers` the reducer, shell-session-store, replay.ts, and the two ledgers. Validity is probed the at0462 way: the assertion must fail against a binary with the anchor read disabled.

#### What stays out of tests {#test-non-goals}

No DOM row counting or pixel assertions (the store facts are the contract; painting is virtualized); no full-corpus sweeps; no piped app-test output; no fabricated-anchor fixtures pretending to be legacy backfills.

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The anchor column, written through and served | done | `2a36c64b0` |
| #step-2 | The tail reader stamps the three gateways | done | `89dd96e79` |
| #step-3 | Replay tells the truth about time | done | `153d336a2` |
| #step-4 | Anchored placement in the deck | done | `007530382` |
| #step-5 | The relaunch ordering test | done | `e2cae9c27` |
| #step-6 | Doctrine and integration checkpoint | done | `16fffbb92` |

#### Step 1: The anchor column, written through and served {#step-1}

**Commit:** tugcast(ink-anchor): add anchor_msg_id to the ink ledgers, written through and served

**References:** [P01], S01, R01

**Tasks:**
- In `shell_ledger.rs`: guarded migration adding `anchor_msg_id TEXT` (pattern: `migrate_sessions_add_fork_provenance`, session_ledger.rs:2393, including the `table_columns`-empty early return and duplicate-column tolerance); `anchor_msg_id: Option<String>` on `NewShellExchange` (shell_ledger.rs:63) and `ShellExchangeRow` (shell_ledger.rs:77, `Serialize` derives it onto the wire); `record_exchange` inserts it; `list_exchanges_since` selects it.
- Same shape in `refs_ledger.rs` for `refs_runs` / `NewRefsRun` / `RefsRunRow` / `record_run` / the list read.
- Update every `NewShellExchange` / `NewRefsRun` construction site (feeds/shell.rs:953, feeds/refs.rs:706, `record_landing_receipt`, and all in-crate test fixtures) with `anchor_msg_id: None` — real values arrive in Step 2, and the struct-field consumption keeps `-D warnings` satisfied without folding.

**Tests:** migration idempotence and legacy-open (NULL read-back) in both ledgers; `rekey_session` carries a non-null anchor across both the move and the collision paths; a recorded row round-trips its anchor through `list_exchanges_since`.

**Checkpoint:** `cd tugrust && cargo nextest run -p tugcast` green; a database created by the previous binary opens under the new code and serves its rows with `anchor_msg_id: null`.

#### Step 2: The tail reader stamps the three gateways {#step-2}

**Depends on:** #step-1

**Commit:** tugcast(ink-anchor): stamp every ink write with the session's newest assistant message id

**References:** [P01], [P02], S02, S03, R01, the write-gateways and tail-read deep dives

**Tasks:**
- `SessionLedger::latest_assistant_msg_id` per S02: `get()` the row for `project_dir`, derive the path via `claude_project_dir`, tail-read per the deep dive. Debug-log each None reason; never error.
- Stamp at the three gateways per S03, replacing the Step-1 `None`s at the production sites (test fixtures keep `None` unless the test is about stamping).

**Tests:** tail-reader fixtures per the test plan (write real multi-line JSONL fixtures under a tempdir with `open_with_claude_root`, the ink_adoption `Fixture` pattern); an end-to-end ledger test per gateway shape: seed a session row + JSONL fixture, drive the write path, read the row back and assert the stamp; a zero-turn session writes NULL and the write still succeeds.

**Checkpoint:** `cargo nextest run -p tugcast` green; a receipt recorded against a fixture JSONL carries the fixture's last assistant `message.id` verbatim.

#### Step 3: Replay tells the truth about time {#step-3}

**Commit:** tugcode(replay-honest-time): carry the entry timestamp on content_block_start

**References:** [P04], S04, the honest-timestamp precedent recorded in [P04]

**Tasks:**
- Add `timestamp?: number` to `ContentBlockStartText/Thinking/ToolUse` (tugcode/src/types.ts:369–393), and to the deck's mirror `ContentBlockStartEvent` (`tugdeck/src/lib/code-session-store/events.ts:190`) — copy the doc-comment shape of `ToolUseEvent.timestamp` in that same file. Doing both here keeps the wire contract in one round; Step 4 consumes it.
- Set it from `parseEntryTimestamp(entry)` at the replay emission (replay.ts, the `blockStart` construction ~1814 — both union arms). Live emission sites remain unchanged (field absent).
- Rebuild the tugcode binary is NOT this step's job; note in the round that repo edits to tugcode are inert until `just build-app` (Step 5 exercises the built binary).

**Tests:** tugcode replay unit test: translating a fixture entry emits `content_block_start` events whose `timestamp` equals the entry's parsed timestamp; a timestamp-less entry emits the field absent.

**Checkpoint:** tugcode test suite green; `bunx tsc --noEmit` in tugcode green.

#### Step 4: Anchored placement in the deck {#step-4}

**Depends on:** #step-3

**Commit:** tugways(ink-anchor): seat restored ink by its written anchor, and mint replayed blocks at their historical time

**References:** [P03], [P04], [P05], [P06], S04, S05, R02, R03, R04, the msgid-resolution deep dive

**Tasks:**
- Reducer mint honesty: `handleContentBlockStart`'s `const now = Date.now()` (reducer.ts, the mint path around line 1655) becomes `event.timestamp ?? Date.now()`; the `handleTextDelta` / `handleToolUse` defensive mints likewise where their events carry a timestamp. Note the background-agent-child branch at reducer.ts:1622 already reads `event.timestamp` and needs no edit — it starts working the moment Step 3's producer lands.
- `TurnEntry.anchorMsgId?: string` (code-session-store/types.ts); threaded per S04 through `ingestShellExchange`'s event, `shellMessage`, `buildShellTurnEntry`, and the refs ink path; `applyRestoredShellExchanges` and the `list_refs_ok` handler read the wire field.
- `insertInkAnchored` per S05; `upsertInkTurn` mints through it; `appendTurnInterleavingInk` gains the [P05] hoist.

**Tests:** the deck unit battery from the test plan (placement resolution, sibling order, fallback, arrival-order convergence, honest mint), in `code-session-store/__tests__/` alongside the existing reducer tests.

**Checkpoint:** deck unit tests green; `cd tugdeck && bunx vite build` green (the prod rollup is what the app loads).

#### Step 5: The relaunch ordering test {#step-5}

**Depends on:** #step-2, #step-4

**Commit:** tugtest(ink-anchor): pin restored ink to its written position across a relaunch

**References:** [P02], [P03], S05, the incident-replay deep dive, test categories

**Tasks:**
- Extend `test-surface.ts` `inkRestoreFacts` with an ordering fact: the committed transcript's `(origin, command?)` sequence tail (store-read, mirroring the existing facts' rationale comment), so the test can assert position without DOM counts.
- New app-test `tests/app-test/at04xx-ink-anchor-order.test.ts` (next free number), two-phase shared-instance relaunch in the at0462 shape: Phase A drives real turns then a real `$` command; Phase B relaunches, resumes, and asserts the ink rows are the final transcript entries in ledger order. `@covers` per the test plan.
- Probe validity: run the test once against a build with the anchor read short-circuited (`tugutil file probe`) and record in the round that it fails — the test must pin the fix, not the neighbourhood. Remember the probe/mtime trap: `touch` the probed `.rs`/`.ts` files before the real rebuild.

**Tests:** the app-test itself, run via `just app-test tests/app-test/at04xx-ink-anchor-order.test.ts` after `just build-app`.

**Checkpoint:** the new app-test green against the fixed build and red against the probed build; `just app-test-covers-check` green.

#### Step 6: Doctrine and integration checkpoint {#step-6}

**Depends on:** #step-5

**Commit:** tugdash(ink-anchor): record anchored ink ordering in the design decisions

**References:** [P01]–[P06]; [D111], [D155], [L23], [L26]

**Tasks:**
- Append the design-decision entry to `tuglaws/design-decisions.md` in house style (one paragraph, next free `D###`): ink ordering is a written fact — the anchor, the placement rule, the fallback posture, and the honest-timestamp contract (no transcript entry ever wears a fabricated time). Cite [D111], [D155], [L23], [L26] and this plan.
- Sweep: `cd tugrust && cargo nextest run` (workspace), `cd tugdeck && bunx vite build`, `just app-test-changed`.

**Tests:** the sweep is the test.

**Checkpoint:** every Success Criterion in this plan checked and holding; Step Status Ledger fully `done`.

### Deliverables {#deliverables}

- Ink ledger rows that record their position at write time, served over the existing restore wire.
- A deck that places restored ink by that record, with a fallback that degrades placement but never loses a row.
- A replay stream and reducer that never fabricate a timestamp.
- A relaunch app-test that fails on the pre-fix binary, and a design-decision entry pinning the contract.
