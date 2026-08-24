<!-- devise-skeleton v4 -->

## /compact Goes Native {#fix-compact}

**Purpose:** Replace Tug's re-created ("fake") compaction — summarize, fork a fresh session, seed it with the summary — with Claude Code's native `/compact`, which (verified empirically on 2.1.207) dispatches over the stream-json bridge, compacts in place under the **same session id and same JSONL**, and persists its summary durably. Restore the Compaction Summary block on relaunch from that JSONL record.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-15 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tug's `/compact` was built when Claude Code refused slash commands over the headless stream-json bridge. The workaround (documented in `tugdeck/src/lib/compaction-request.ts` and the `compact:` handler comment in `tugdeck/src/components/tugways/cards/dev-card.tsx`): run a suppressed summarization turn, capture the recap from the in-flight snapshot, spawn a **fresh session** seeded with the recap, close the old one. The fork is the mechanism — and it is also the source of a family of session-tracking bugs: the summary lives only in the in-memory `pendingCompactionStore` until the user's next real send bakes it into the wire (compact-then-relaunch loses it forever); the freshly-minted session can land in the ledger under a different `project_dir` string than the picker queries, so it resurfaces as an `origin: "external"` row wearing a wrong "terminal" badge; renames can target a row that no longer matches.

The premise is stale. Verified empirically on Claude Code 2.1.207 (see [#empirical-wire-shapes](#empirical-wire-shapes)): `/compact [focus]` sent as a plain stream-json user message runs **real native compaction** — same session id, same JSONL, a `compact_boundary` system event streamed live, and the summary persisted as an `isCompactSummary` user record. Every downstream identity bug dissolves because no new identity is created. What remains is small: dispatch `/compact` as a message instead of running the fork machinery, and teach the replay path to restore the boundary divider + summary block it currently drops.

#### Strategy {#strategy}

- **Delete the fork, don't patch it.** The summarize/respawn/seed/watchdog machinery is removed, not gated.
- **Ride existing rails.** The live `compact_boundary` IPC frame, its reducer handler, and the `DevCompactionCarryForward` block all exist. The work is: one new outbound frame (`compact_summary`), replay emission for two JSONL record shapes, and a thin dispatch handler.
- **tugcode + tugdeck only.** No Rust changes: tugcast relays frames opaquely, `turn_engine.rs` already segments `/compact` continuations (rule epoch 2), and the rewind chop guard in `tugcode/src/session.ts` already refuses to cross compaction markers.
- **Live == reload.** The summary block and boundary divider must render identically live and after Maker ▸ Reload / app relaunch — the summary's durability comes from the JSONL, not from any Tug-side store.
- **Keep legacy replay compat.** Old JSONLs contain fake-compaction artifacts (seed blocks, canceled summarize turns). Their replay recognition stays so existing transcripts keep restoring correctly.
- Sequence: tugcode replay emission → tugcode live capture → tugdeck intake/reducer → tugdeck dispatch + machinery removal → integration verification.

#### Success Criteria (Measurable) {#success-criteria}

- Typing `/compact` in a Dev card runs native compaction: the card's `SESSION` chip shows the **same** session id before and after, and no new JSONL file appears in `~/.claude/projects/<project>/` (verify by `ls` before/after).
- During a `/compact` run the card is blocked by the pane-modal progress sheet showing an indeterminate "Compacting…" indicator with a working Cancel; it dismisses when the run settles (visual check; Cancel interrupt per [Q01]).
- The transcript shows a "Session compacted · ~Nk tokens" divider and the Compaction Summary block after `/compact` completes (visual check + app-test).
- After **quitting and relaunching the app** (or Maker ▸ Reload), a compacted session's card still shows the Compaction Summary block and the boundary divider (app-test on a real compacted fixture JSONL).
- The session picker never shows a compaction-born row: there is no compaction-born row to show. Rename before and after `/compact` targets the same ledger row and sticks (manual check against `sessions.db`).
- `grep -rn "pendingCompactionStore\|buildSummarizationPrompt\|buildCompactionSeed\|markCompactionSeed" tugdeck/src --include="*.ts" --include="*.tsx"` returns no production hits.
- `cd tugcode && bun test`, `cd tugdeck && bun test`, `cd tugdeck && bunx vite build`, and `just app-test` all pass.

#### Scope {#scope}

1. `/compact [focus]` dispatch as a native stream-json user message.
2. Replay emission of `compact_boundary` + a new `compact_summary` frame from JSONL records (`system`/`compact_boundary`, `isCompactSummary` user records).
3. Live capture of the post-compaction summary user event in tugcode.
4. tugdeck intake: reducer state for the summary, divider placement on replay, carry-forward block fed from the new frame.
5. Removal of the fork-only machinery (pending-seed store, summarization prompts, seed bake, respawn watchdog); simplification of the progress sheet/store to a modal **indeterminate** "Compacting…" surface ([P07]).
6. Tests: tugcode unit tests on real fixture lines, tugdeck reducer tests, app-test coverage for the reload-restore path.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Fixing the picker/ledger dual-`project_dir` literal-match bug (`SessionLedger::list_for_project_dir` matches the raw typed path, so the same workspace can hold rows under `/u/src/tugtool` and `/Users/kocienda/Mounts/u/src/tugtool`; unmatched rows resurface as `origin: "external"`). Real bug, separate plan — it stops being load-bearing for `/compact` once no new session is minted.
- Removing the `suppress` option from `codeSessionStore.send()` — `test-surface.ts` uses it generically; only `/compact`'s use of it goes away.
- Removing the **legacy replay** recognition paths (`splitCompactionSeed`, `isCompactionSummarizeText`, `add_user_message.compactionSummary`, `suppressedTurn`) — old JSONLs need them indefinitely.
- Any change to auto-compaction's live behavior (it already works; it additionally gains the summary block via the new capture, which is desirable).
- Rendering Claude Code's "ctrl+o to see full summary" affordance or any new summary UI beyond the existing carry-forward block.

#### Dependencies / Prerequisites {#dependencies}

- Claude Code ≥ 2.1.207 installed (the version the empirical verification ran against).
- tugcode is a bun-compiled binary: every tugcode change requires `just build` (or at minimum `bun build --compile tugcode/src/main.ts --outfile tugrust/target/debug/tugcode`) before app-level verification.

#### Constraints {#constraints}

- tugdeck laws apply ([L02] external state via `useSyncExternalStore`, [L06] appearance via CSS/DOM). No new state zones are introduced — `compactionSeed` already lives in the code-session store.
- HMR must never reload data/transcript; Maker ▸ Reload is the true re-resume path — reload verification uses Maker ▸ Reload or app relaunch, not HMR.
- No localStorage/sessionStorage; the summary's persistence is the JSONL itself (no Tug-side persistence is added).

#### Assumptions {#assumptions}

- The live stream shape for manual and auto compaction is stable across 2.1.x: `system`/`compact_boundary` followed by a synthetic user event carrying the summary string (see [#empirical-wire-shapes](#empirical-wire-shapes)). If Anthropic reshapes it, the armed capture degrades to "no summary block" — never to wrong ink.
- `/compact <focus>` accepts trailing instructions natively (the TUI documents `/compact [instructions]`).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton conventions: explicit `{#anchor}` headings, `[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##` specs, `**Depends on:**` lines citing `#step-N` anchors, and `**References:**` lines citing plan artifacts (never line numbers).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does interrupting a native `/compact` mid-flight leave the session healthy? (OPEN) {#q01-interrupt-mid-compact}

**Question:** If the user cancels while native compaction is summarizing (the sheet's Cancel button, Escape, or Stop — all routes reach `codeSessionStore.interrupt()`), does Claude Code abort cleanly (session intact, no boundary written) or can it wedge the JSONL?

**Why it matters:** The old flow's Cancel button interrupted Tug's own summarization turn, which was provably safe (nothing committed). The native flow hands cancellation to Claude Code.

**Plan to resolve:** Spike during Step 5 verification: start a compaction on a throwaway session (`claude -p --resume <id> "/compact"` on a scratch project, or in-app), interrupt mid-run, then resume and confirm the session still loads and a later `/compact` succeeds.

**Resolution:** RESOLVED (Step 5 spike, 2.1.207) — **the session stays healthy.** An 8-turn scratch session had `/compact` dispatched over the stream-json transport, then the claude process was hard-killed (SIGINT then SIGKILL) ~3 s into the ~19 s run. Afterward the session **resumed cleanly** (a follow-up prompt answered normally) and a **fresh `/compact` succeeded** (a real `compact_boundary`, `pre_tokens 28031`, `compact_result: success`). No partial `compact_boundary` was persisted by the interrupted run. A hard kill is strictly worse than the graceful `codeSessionStore.interrupt()` Cancel maps to, so the modal-sheet Cancel is safe: the session is left intact and a later `/compact` works.

#### [Q02] What does a too-short session return over stream-json? (OPEN) {#q02-not-enough-messages}

**Question:** `claude -p --resume <id> "/compact"` on a short session prints `Not enough messages to compact.` In stream-json mode, does that arrive as a `result` error, a `local-command-stdout` user event, or assistant text?

**Why it matters:** The turn must settle cleanly in the reducer (no stuck `submitting` phase) and the user should see the refusal.

**Plan to resolve:** Spike during Step 5: send `/compact` to a 1-turn in-app session and observe. The existing `<local-command-stdout>` synthesis in `tugcode/src/session.ts` (the §13c slash-command stdout path) most likely renders it as turn text already.

**Resolution:** RESOLVED (Step 5 spike, 2.1.207) — a 1-turn session sent `/compact` over stream-json returns: `system/status { compact_result: "failed", compact_error: "Not enough messages to compact." }`, then a **synthetic assistant message** (`model: "<synthetic>"`, `stop_reason: "stop_sequence"`) whose text is `"Not enough messages to compact."`, then `result { subtype: "success", num_turns: 0 }`. **No `compact_boundary`, no summary.** So it flows through the existing assistant-text path (renders as the turn's visible text — the user sees the refusal), the turn settles idle cleanly (result success ⇒ no stuck `submitting`), and the dev-card watcher sees "settled without compaction ink" ⇒ `fail("Compaction didn't run — session left intact")` (an informational bulletin, since `lastError` is null on a `success` result). No design fork was needed.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Anthropic changes the live summary event shape | med | low | Ordering-armed capture fails closed (no summary block, never wrong ink); JSONL `isCompactSummary` replay path is independent and unaffected | Summary block missing live but present after reload |
| Interrupted compaction leaves session wedged | med | low | [Q01] spike; rewind chop guard already refuses to cross boundaries | Q01 spike fails |
| Old fake-compaction JSONLs stop restoring | high | low | Legacy replay paths explicitly retained ([P06]); the suppressed-turn/`compactionSummary` tests and the `splitCompactionSeed` wrapper path stay green (the `mark_compaction_seed` test sections die with the machinery, per [P06]) | Any legacy replay test breaks |
| `/compact` turn confuses turn accounting | low | low | `turn_engine.rs` rule epoch 2 already classifies `/compact` continuations; JSONL scaffolding records are already skipped by replay | Picker turn counts jump after a compact |

**Risk R01: Live capture arms on the wrong user event** {#r01-armed-capture}

- **Risk:** The armed capture (boundary seen → next synthetic user string is the summary) grabs goal-evaluator feedback or scaffolding instead.
- **Mitigation:** Goal feedback is parsed and consumed *before* the armed check (existing `parseGoalFeedbackText` branch in `session.ts`); `<local-command-stdout>` content is excluded by prefix; capture disarms after one use and at turn end.
- **Residual risk:** A hypothetical future synthetic user event injected between boundary and summary would be mis-captured; it would render as a wrong summary block — cosmetic, correctable by reload once replay emits the true JSONL record.

---

### Design Decisions {#design-decisions}

#### [P01] `/compact` dispatches as a native stream-json user message (DECIDED) {#p01-native-dispatch}

**Decision:** The dev card's `compact:` surface handler sends the literal text `/compact` (plus focus args) through `codeSessionStore.send()` as a normal, visible submission; the entire summarize/respawn flow is deleted.

**Rationale:**
- Verified working on 2.1.207 over the exact transport tugcode uses ([#empirical-wire-shapes](#empirical-wire-shapes)).
- Same session id ⇒ ledger row, card binding, rename, telemetry lineage, file attribution all survive compaction untouched.
- The command stays in `LOCAL_SLASH_COMMANDS` (`tugdeck/src/lib/slash-commands.ts`) so the popup keeps offering it with Tug's description and the surface handler keeps its `canSubmit` gate — the *handler body* changes, not the routing.

**Implications:**
- The transcript shows a `/compact` user bubble live; the `<local-command-stdout>Compacted</local-command-stdout>` echo renders as the turn's text via the existing §13c stdout synthesis in `session.ts`; the boundary divider attaches to this turn via the existing `handleCompactBoundary`.
- On reload the bubble does not reappear (the JSONL records it as `<command-name>` scaffolding, which `COMMAND_SCAFFOLDING_PREFIXES` skips) — accepted asymmetry; the divider and summary block DO reappear ([P03], [P04]).

#### [P02] A new `compact_summary` outbound IPC frame carries the summary (DECIDED) {#p02-compact-summary-frame}

**Decision:** tugcode emits `{ type: "compact_summary", summary: string, ipc_version }` — on the live path from the armed capture, on the replay path from the `isCompactSummary` JSONL record — rather than piggybacking the summary onto the `compact_boundary` frame.

**Rationale:**
- Boundary and summary arrive as separate records in both the stream and the JSONL (boundary first); attaching the summary to the boundary frame would force lookahead/buffering on both paths.
- A dedicated frame keeps the reducer handlers single-purpose: `compact_boundary` → divider note; `compact_summary` → carry-forward seed.

**Implications:**
- New member in tugcode's outbound message union (`tugcode/src/types.ts`) and its test-double union in `tugcode/src/stub-replay.ts`.
- tugdeck must add `"compact_summary"` to `KNOWN_CODE_OUTPUT_TYPES` in `tugdeck/src/lib/code-session-store.ts` (an unknown type is dropped by the intake gate).
- tugcast needs no change (opaque relay). The tugcode *inbound* allowlist is untouched (this is an outbound frame).

#### [P03] Replay emits boundary + summary from JSONL (DECIDED) {#p03-replay-emission}

**Decision:** `tugcode/src/replay.ts` special-cases `type: "system"` + `subtype: "compact_boundary"` **before** the `SKIPPED_TOP_LEVEL_TYPES` gate (which contains `"system"` wholesale) and emits a `compact_boundary` frame carrying `compactMetadata.preTokens`; the `isCompactSummary` user-entry branch in `handleUserEntry` emits `compact_summary` instead of silently returning.

**Rationale:**
- This is the durability fix: the summary is already in the JSONL; replay just refuses to drop it.
- Frame order on replay (boundary, then summary) matches the live stream, so the reducer needs no path-specific logic.

**Implications:**
- `JsonlEntry` in `replay.ts` gains a typed `compactMetadata?: { trigger?: string; preTokens?: number }` field (JSONL uses camelCase; the live stream uses snake_case `compact_metadata` — the two parsers stay separate).
- The `isCompactSummary` skip in `isNonSubmissionUserString` remains for the array-content defensive case; the emission happens in the string-content branch where the record actually occurs.
- An `isCompactSummary` record never opens a turn, never triggers orphan synthesis, and never latches `openTurnMsgId`.

#### [P04] Reducer: divider placement without an open turn (DECIDED) {#p04-divider-placement}

**Decision:** `handleCompactBoundary` in `tugdeck/src/lib/code-session-store/reducer.ts` keeps its mid-turn behavior (append a `system_note` with `source: "compact"` to the pending turn's scratch) and gains a fallback: with no pending turn, append the note to the **last committed `TurnEntry`** in `state.transcript`; with an empty transcript, drop it.

**Rationale:**
- Live: a turn is always open (the `/compact` send opens it; auto-compaction fires mid-turn) — the fallback is effectively replay-only.
- Replay: the `/compact` scaffolding records are skipped, so the boundary usually arrives right after the prior turn closes; appending to that turn puts the divider exactly where compaction happened in reading order.
- No new transcript-entry kind, no new rendering surface — `system_note` already renders inside turns.

**Implications:**
- The fallback mutates a committed entry purely (copy-on-write of the transcript array + entry), consistent with reducer discipline.
- The fallback note's `messageKey` is minted as `systemNoteKey(turn.turnKey, turn.messages.length)` — a committed `TurnEntry` carries no `systemNoteSeq` (that counter lives on the scratch entry), and `messages.length` is deterministic and collision-safe: existing note seqs are always strictly less than the count of notes, which is ≤ `messages.length`. No `randomUUID` — the reducer stays pure.
- `compactionNoteText` in `code-session-store/compaction.ts` is unchanged.

#### [P05] Reducer: `compact_summary` re-marks `compactionSeed`; `seedPending` dies (DECIDED) {#p05-compaction-seed-state}

**Decision:** A new `handleCompactSummary` sets `compactionSeed = { summary, preTokens }` (preserving a `preTokens` already latched by a preceding boundary frame, else `null`). The `seedPending` field — the old "recap must ride the next send" mechanism — is removed from the state type, along with the send-path seed flush in `handleSend`, the `mark_compaction_seed` event, `handleMarkCompactionSeed`, and `CodeSessionStore.markCompactionSeed`.

**Rationale:**
- Nothing defers anymore: natively, by the time the summary exists it is already durable in the JSONL.
- The legacy replay path (`add_user_message.compactionSummary`) also never needed `seedPending` semantics — it always set `seedPending: false`.

**Implications:**
- `compactionSeed` in `code-session-store/types.ts` becomes `{ summary: string; preTokens: number | null } | null`.
- `DevCompactionCarryForward` (`dev-compaction-carry-forward.tsx`) reads `compactionSeed.summary` — unchanged apart from the type.
- The carry-forward block keeps its current placement (full-width row under the load control bar, `dev-load-control-bar.tsx`), now showing the **latest** compaction's summary; a later compaction overwrites it.

#### [P06] Legacy fake-compaction replay compat is retained (DECIDED) {#p06-legacy-compat}

**Decision:** Keep, unchanged: `splitCompactionSeed` + `COMPACTION_SEED_MARKER` + `isCompactionSummarizeText` + `COMPACTION_SUMMARIZE_MARKER` in `compaction-request.ts`; the seed-split in the store wrapper's `add_user_message` intake (`code-session-store.ts`); `compactionSummary` and `suppressedTurn` on `AddUserMessageEvent` (`events.ts`) and their `handleAddUserMessage` handling. Delete only the *producers*: `buildSummarizationPrompt` and `buildCompactionSeed`.

**Rationale:**
- Every session compacted the old way has `<!-- tug:compact-seed -->` blocks and possibly canceled `<!-- tug:compact-summarize -->` turns baked into its JSONL forever. Reload of those sessions must keep working.

**Implications:**
- `compaction-request.ts`'s module doc is rewritten to say it now holds **legacy replay recognition** only.
- `reducer.suppressed-turn.test.ts` is **split, not kept whole**: its suppressed-turn and `compactionSummary` coverage survives as the legacy proof, but its `markSeed()` helper and the `describe("reducer — mark_compaction_seed")` block assert the exact event/field this plan deletes and are removed with the machinery. The wrapper seed-split tests remain green untouched.

#### [P07] The compaction progress sheet stays — modal, indeterminate (DECIDED) {#p07-modal-indeterminate-progress}

**Decision:** Native `/compact` keeps a **pane-modal progress sheet** for the duration of the run — the session is blocked modally, the sheet shows an **indeterminate** progress indicator ("Compacting…") with a Cancel button — but the sheet and its store are **simplified in place**, and the fork-only machinery around them (`pending-compaction-store.ts`, the `deliverPendingCompactionSeeds` hook in `dev-session-restore.ts`, the `COMPACTION_RESPAWN_TIMEOUT_MS` respawn watchdog) is deleted.

**Rationale:**
- Native compaction is a ~20 s **opaque** run: empirically ([#empirical-wire-shapes](#empirical-wire-shapes)) nothing streams between the dispatch and the `compact_boundary` frame (`durationMs` ≈ 17–19 s arrives in one lump). There is no streamed-volume signal to drive a determinate bar — and the Claude Code TUI's own determinate bar is a low-quality proxy anyway. Indeterminate is the honest rendering.
- The user must stay informed during a lengthy, session-mutating operation; a bare "busy" STATE dot under-communicates. Modal blocking also prevents queuing sends into a session that is about to have its context rewritten.
- Cancel maps to the turn interrupt (`codeSessionStore.interrupt()`), the same path Stop/Escape takes ([Q01] verifies its safety).

**Implications:**
- `compaction-progress-store.ts` is rewritten lean: it tracks `{ cardId, outcome }` only — the `phase` ladder (`summarizing`/`respawning`) and the numeric `progress` fraction die with the fork. `compaction-progress-sheet.tsx` renders the indeterminate indicator + Cancel and keeps its Escape/Cmd-. = Cancel dismissal contract.
- Run lifecycle: `begin(cardId)` at dispatch (before the send); **succeed** when the `/compact` turn settles with compaction ink observed (the reducer appended the `source: "compact"` system note / `compactionSeed` updated since dispatch); **cancel/fail** when the turn settles without it (interrupted, refused, or errored — surface the reason via the pane bulletin as today). The dev-card watcher derives this from `codeSessionStore` snapshots; no timers, no watchdog.
- `dev-session-restore.ts` loses its compaction dependency entirely; the restore path no longer participates in compaction.

#### [P08] Live summary capture is ordering-armed in tugcode (DECIDED) {#p08-armed-capture}

**Decision:** `session.ts` arms a per-turn `pendingCompactSummary` flag when it translates a `system`/`compact_boundary` stream event; the next `user` event with `isSynthetic: true` and **string** content that is not goal feedback (existing `parseGoalFeedbackText` returns `null`) and does not start with `<local-command-stdout>` is captured as the summary, emitted as `compact_summary`, and the flag disarms (also disarms at `result`).

**Rationale:**
- Empirically the live summary event carries `isReplay: true, isSynthetic: true` and a plain-string content — **no** `isCompactSummary` flag on the wire (that flag exists only in the JSONL). Ordering after the boundary is the reliable discriminator.
- The existing `isSynthetic` goal-feedback branch already fires first and consumes real goal feedback, so the armed check composes with it instead of racing it.

**Implications:**
- Auto-compaction (capacity trigger) flows through the same arm/capture — the summary block now also appears for auto-compacts, live and on reload.
- Fails closed: if the summary event never arrives, nothing is emitted; reload restores from JSONL anyway.

---

### Deep Dives {#deep-dives}

#### Empirical wire shapes (Claude Code 2.1.207, verified 2026-07-15) {#empirical-wire-shapes}

Dispatch that works, over the exact transport tugcode uses (`--input-format stream-json --output-format stream-json`):

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"/compact"}]}}
```

**Live stream sequence** (manual compact, mid-session):

1. `{"type":"system","subtype":"compact_boundary","session_id":…,"uuid":…,"compact_metadata":{"trigger":"manual","pre_tokens":786,"post_tokens":1367,"cumulative_dropped_tokens":24451,"duration_ms":19367,"preserved_segment":{…}}}` — **snake_case** `compact_metadata`.
2. `{"type":"user","isReplay":true,"isSynthetic":true,"message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. The summary …"}}` — the full summary as a **plain string**; note there is **no `isCompactSummary` flag on the live wire**.
3. `{"type":"user","isReplay":true,"message":{"content":"<local-command-stdout>Compacted </local-command-stdout>"}}` — the stdout echo (already synthesized into turn text by `session.ts`'s §13c path).
4. `{"type":"result","subtype":"success","session_id":"<SAME id as before compaction>"}`.

**JSONL persisted sequence** (same event, camelCase):

1. `{"type":"system","subtype":"compact_boundary","parentUuid":null,"logicalParentUuid":…,"content":"Conversation compacted","isMeta":false,"compactMetadata":{"trigger":"manual","preTokens":25714,"durationMs":…,"preservedSegment":{…},"preservedMessages":{…}}}`
2. `{"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"role":"user","content":"This session is being continued …"}}` — **immediately follows** the boundary record.
3. Scaffolding user records: `<command-name>/compact</command-name>…` and `<local-command-stdout>Compacted …</local-command-stdout>` (both already skipped by `COMMAND_SCAFFOLDING_PREFIXES`).

Other verified facts: the same JSONL file grows in place across multiple compactions (no new file, no id churn); `claude -p --resume <id> "/compact"` works identically from a shell; a too-short session answers `Not enough messages to compact.` ([Q02]); `--resume` in `-p` mode appends to the same session file.

**Regenerating a real fixture** (for tests): in a scratch dir, `SID=$(uuidgen | tr A-Z a-z)`; `claude -p --session-id $SID --model haiku "…"` then ~8 short `claude -p --resume $SID --model haiku "…"` turns; then send `/compact` via the stream-json line above (or `-p`). The JSONL lands in `~/.claude/projects/<encoded-dir>/$SID.jsonl` with the exact records shown.

#### Current machinery inventory (what goes, what stays) {#machinery-inventory}

**Deleted (producers of the fork):**

| Artifact | Location |
|---|---|
| `compact:` handler body (summarize→watch→respawn→watchdog) | `dev-card.tsx`, `slashCommandSurfaces.compact` |
| `COMPACTION_RESPAWN_TIMEOUT_MS` + respawn watchdog | `dev-card.tsx` |
| `buildSummarizationPrompt`, `buildCompactionSeed` | `tugdeck/src/lib/compaction-request.ts` |
| `pendingCompactionStore` | `tugdeck/src/lib/pending-compaction-store.ts` (file deleted) |
| `deliverPendingCompactionSeeds` | `tugdeck/src/lib/dev-session-restore.ts` |

**Rewritten in place ([P07] — modal indeterminate progress):**

| Artifact | Location | Change |
|---|---|---|
| `compactionProgressStore` | `tugdeck/src/lib/compaction-progress-store.ts` | Lean `{ cardId, outcome }` run state; `phase` ladder + numeric `progress` fraction removed |
| `CompactionProgressSheet` | `tugdeck/src/components/tugways/cards/compaction-progress-sheet.tsx` | Indeterminate "Compacting…" indicator + Cancel; Escape/Cmd-. = Cancel retained |
| progress close-out effect | `dev-card.tsx` | Settles the run off `codeSessionStore` snapshots (turn settled + compaction ink observed ⇒ succeed, else cancel/fail); no timers |
| Send-path seed flush (`seedBlock`/`wireContent` in `handleSend`) | `code-session-store/reducer.ts` |
| `mark_compaction_seed` event + `handleMarkCompactionSeed` + `markCompactionSeed` | `events.ts`, `reducer.ts`, `code-session-store.ts` |
| `seedPending` field on `compactionSeed` | `code-session-store/types.ts` |

**Kept (legacy replay recognition, [P06]):** `splitCompactionSeed`, `COMPACTION_SEED_MARKER`, `isCompactionSummarizeText`, `COMPACTION_SUMMARIZE_MARKER` (`compaction-request.ts`); the seed-split + `compactionSummary` + `suppressedTurn` intake in `code-session-store.ts`'s `add_user_message` mapping; their `handleAddUserMessage` handling; `send()`'s `suppress` option.

**Kept (already-native live path):** `compact_boundary` IPC frame (`tugcode/src/types.ts`), its live emission in `session.ts`, `handleCompactBoundary` + `compactionNoteText`, `KNOWN_CODE_OUTPUT_TYPES` entry `"compact_boundary"`, the wrapper mapping in `code-session-store.ts`, `DevCompactionCarryForward` + its render site in `dev-load-control-bar.tsx`.

#### End-to-end flows after this plan {#flows}

**Live `/compact [focus]`:** user types it → `matchLocalSlashCommand` → `RUN_SLASH_COMMAND` → `slashCommandSurfaces.compact` guards `canSubmit`, opens the run (`compactionProgressStore.begin`) and presents the pane-modal indeterminate sheet ([P07]), then `codeSessionStore.send("/compact" + focus)` → normal turn opens (visible `/compact` bubble) → ~20 s opaque run under the sheet → stream: boundary (divider note attaches to this turn; `preTokens` latched) → summary event (armed capture → `compact_summary` → `compactionSeed` set → carry-forward renders) → stdout echo (turn text "Compacted") → `result` (turn commits; watcher sees settled-with-ink → `succeed()` → sheet dismisses). Cancel (button, Escape, Cmd-.) interrupts the turn; the watcher sees settled-without-ink → `cancel()`. Same session id throughout.

**Reload of a compacted session:** tugcast respawns tugcode with `--resume` → replay walks the JSONL → boundary record → `compact_boundary` frame → divider (mid-turn attach if a turn is open at that point, else appended to the last committed turn per [P04]) → `isCompactSummary` record → `compact_summary` frame → `compactionSeed` set → carry-forward renders. Scaffolding records skipped as today.

**Legacy fake-compacted session reload:** unchanged — seed block split off the first opener via `splitCompactionSeed`, `compactionSummary` re-marks the seed, canceled summarize turns suppressed.

---

### Specification {#specification}

**Spec S01: `compact_summary` IPC frame** {#s01-compact-summary}

```
{ type: "compact_summary", summary: string, ipc_version: number }
```

- Emitted by tugcode: live (armed capture, [P08]) and replay ([P03]). At most one per compaction; ordered strictly after that compaction's `compact_boundary` frame on both paths.
- `summary` is the verbatim string content of the summary user record/event (Claude Code's own framing text included; no Tug markers).
- tugdeck intake: member of `KNOWN_CODE_OUTPUT_TYPES`; wrapper maps it to a `CompactSummaryEvent { type: "compact_summary", summary }`; reducer handler per [P05]. Accepted in any phase (live it arrives mid-turn; on replay during `replaying`).

**Spec S02: replay emission rules** {#s02-replay-rules}

- In `translateEntry` (`replay.ts`): before the `SKIPPED_TOP_LEVEL_TYPES` check, `type === "system" && subtype === "compact_boundary"` → emit `{ type: "compact_boundary", trigger: compactMetadata?.trigger, pre_tokens: compactMetadata?.preTokens, ipc_version }`; do not touch `openTurnMsgId`; do not run orphan synthesis. All other `system` entries stay skipped.
- In `handleUserEntry` string-content branch: `isCompactSummary === true` → emit `{ type: "compact_summary", summary: rawContent, ipc_version }` and return (no opener, no turn state change). This replaces the current bare `return out`.
- The dead-entry walk (`computeDeadEntryIndices`) is untouched — it already bridges across boundary records.

**Spec S03: reducer behavior** {#s03-reducer}

- `handleCompactBoundary`: existing mid-turn note append; new fallback per [P04] (last committed `TurnEntry`, else drop), minting the fallback note's key as `systemNoteKey(turn.turnKey, turn.messages.length)` per [P04]. Continues to latch nothing else.
- New `handleCompactSummary`: `compactionSeed = { summary: event.summary, preTokens: state.compactionSeed?.preTokens ?? null }`. Note: the boundary frame carries `preTokens` but the reducer currently only uses it for the note text; if boundary handling is extended to latch `preTokens` onto `compactionSeed`, the summary handler must preserve it — hence the `?? null` merge shape.
- `compactionSeed` type: `{ summary: string; preTokens: number | null } | null` (field `seedPending` removed).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `compactionSeed` (reshaped, not new) | store data | code-session store + `useSyncExternalStore` (existing) | [L02] |
| carry-forward collapsed/expanded | local UI disclosure | `useState` in `DevCompactionCarryForward` (existing, unchanged) | [L06] |
| compaction run `{ cardId, outcome }` (simplified, not new) | store data | `compactionProgressStore` + `useSyncExternalStore` (existing store, fields removed) | [L02] |

No new state zones; no new stores — one store is reshaped smaller.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugcode/src/__tests__/fixtures/compact-native/<sid>.jsonl` | Real natively-compacted session JSONL (regenerate per [#empirical-wire-shapes](#empirical-wire-shapes)) for replay tests |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `CompactSummary` | interface | `tugcode/src/types.ts` | Spec S01; add to outbound union |
| `CompactSummary` | union member | `tugcode/src/stub-replay.ts` | mirror of the types.ts union |
| `JsonlEntry.compactMetadata` | field | `tugcode/src/replay.ts` | `{ trigger?: string; preTokens?: number }` |
| `translateEntry` | fn (modify) | `tugcode/src/replay.ts` | Spec S02 boundary emission |
| `handleUserEntry` | fn (modify) | `tugcode/src/replay.ts` | Spec S02 summary emission |
| `pendingCompactSummary` | per-turn flag | `tugcode/src/session.ts` | [P08] armed capture; emit `compact_summary` |
| `KNOWN_CODE_OUTPUT_TYPES` | set (modify) | `tugdeck/src/lib/code-session-store.ts` | add `"compact_summary"` |
| wrapper `compact_summary` mapping | intake (add) | `tugdeck/src/lib/code-session-store.ts` | beside the `compact_boundary` mapping |
| `CompactSummaryEvent` | interface | `tugdeck/src/lib/code-session-store/events.ts` | Spec S01 |
| `handleCompactSummary` | fn (add) | `tugdeck/src/lib/code-session-store/reducer.ts` | Spec S03 |
| `handleCompactBoundary` | fn (modify) | `tugdeck/src/lib/code-session-store/reducer.ts` | [P04] fallback |
| `handleSend` | fn (modify) | `tugdeck/src/lib/code-session-store/reducer.ts` | remove seed flush |
| `compactionSeed` | type (modify) | `tugdeck/src/lib/code-session-store/types.ts` | drop `seedPending` |
| `slashCommandSurfaces.compact` | handler (rewrite) | `tugdeck/src/components/tugways/cards/dev-card.tsx` | [P01] thin send + [P07] run open |
| `compactionProgressStore` | store (simplify) | `tugdeck/src/lib/compaction-progress-store.ts` | [P07] `{ cardId, outcome }` only |
| `CompactionProgressSheet` | component (simplify) | `tugdeck/src/components/tugways/cards/compaction-progress-sheet.tsx` | [P07] indeterminate + Cancel |
| compaction run watcher | effect (rewrite) | `tugdeck/src/components/tugways/cards/dev-card.tsx` | [P07] settle off store snapshots, no timers |
| deletions | files/symbols | per [#machinery-inventory](#machinery-inventory) | [P07] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (tugcode)** | Replay emission + live capture against real JSONL/stream lines | Steps 1–2 |
| **Unit (tugdeck reducer)** | `compact_summary` / boundary-fallback state transitions | Step 3 |
| **App-test** | Real app drives reload-restore of a compacted fixture; live divider test stays green | Step 5 |
| **On-demand real-claude** | Full live `/compact` in the app (burns a real compaction) | Step 5, manual/on-demand only |

#### What stays out of tests {#test-non-goals}

- Mock-store assertion tests and fake-DOM render tests — banned pattern; the reducer tests exercise the real reducer, the app-tests drive the real app.
- Automated live-compaction in CI — a real `/compact` costs a real model run; it is an on-demand test, per the repo's real-claude policy.
- The legacy fake-compaction replay paths — already covered by existing tests (the suppressed-turn/`compactionSummary` sections of `reducer.suppressed-turn.test.ts`, wrapper seed-split coverage); this plan must not break those sections, which their staying green proves. (The same file's `mark_compaction_seed` sections are deleted with the machinery — see Step 4.)

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Applies to every step.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | tugcode replay: emit boundary + summary from JSONL | done | 82e668f10 |
| #step-2 | tugcode live: armed summary capture | done | 4d1400fee |
| #step-3 | tugdeck intake + reducer: compact_summary and divider fallback | done | b15b962fa |
| #step-4 | tugdeck dispatch swap + fake-compaction removal | done | 1ed42a933 |
| #step-5 | Integration checkpoint: end-to-end native compact | done | 46722a9e6 |

#### Step 1: tugcode replay — emit boundary + summary from JSONL {#step-1}

**Commit:** `tugcode(compact-replay): emit compact_boundary + compact_summary frames from JSONL`

**References:** [P02] compact_summary frame, [P03] replay emission, Spec S01, Spec S02, (#empirical-wire-shapes, #machinery-inventory)

**Artifacts:**
- `CompactSummary` in `tugcode/src/types.ts` (outbound union) and `tugcode/src/stub-replay.ts`.
- `JsonlEntry.compactMetadata` field; boundary special-case in `translateEntry`; summary emission in `handleUserEntry` (`tugcode/src/replay.ts`).
- Real fixture at `tugcode/src/__tests__/fixtures/compact-native/` generated per [#empirical-wire-shapes](#empirical-wire-shapes).

**Tasks:**
- [ ] Add the `CompactSummary` interface (Spec S01) to `types.ts` and the stub-replay union.
- [ ] While in `types.ts`: fix the stale `CompactBoundary` doc claim that "a typed `/compact` is client-dispatched and never reaches the bridge" — after this plan it does reach the bridge.
- [ ] Add `compactMetadata` to `JsonlEntry`; document the camelCase-vs-snake_case split against the live stream.
- [ ] In `translateEntry`, before the `SKIPPED_TOP_LEVEL_TYPES` check: `system`/`compact_boundary` → emit `compact_boundary` frame with `trigger`/`pre_tokens` from `compactMetadata` (Spec S02); all other `system` entries keep skipping.
- [ ] In `handleUserEntry`, replace the `isCompactSummary` bare return with a `compact_summary` emission (Spec S02); confirm no turn-state side effects.
- [ ] Generate the real fixture with the claude CLI; trim to the relevant span if large.

**Tests:**
- [ ] Replay of the fixture yields exactly one `compact_boundary` (with `pre_tokens` matching the record) and one `compact_summary` (summary text matches the record verbatim), ordered boundary-then-summary, with turn frames otherwise unchanged.
- [ ] A fixture slice *without* compaction records emits neither frame (no regression on the skip).
- [ ] Existing replay tests (`replay-string-content.test.ts`, `replay-dead-branch.test.ts`, etc.) stay green.

**Checkpoint:**
- [ ] `cd tugcode && bun test`

---

#### Step 2: tugcode live — armed summary capture {#step-2}

**Depends on:** #step-1

**Commit:** `tugcode(compact-live): capture the post-boundary summary event as compact_summary`

**References:** [P08] armed capture, Risk R01, Spec S01, (#empirical-wire-shapes)

**Artifacts:**
- `pendingCompactSummary` arming in `session.ts`'s `system`/`compact_boundary` translation; capture + emission + disarm in the `case "user"` handler; disarm at `result`.

**Tasks:**
- [ ] Arm on live `compact_boundary`. The capture check goes **inside** the existing `isSynthetic === true` branch of `case "user"` — that branch `break`s unconditionally after `parseGoalFeedbackText`, so code placed after the if-block never runs for the summary event. Shape: goal feedback parsed (`feedback !== null`) → existing `goal_feedback` push wins; else if armed and content is a string not starting with `<local-command-stdout>` → emit `compact_summary` and disarm ([P08]); then the existing `break`.
- [ ] Disarm on `result` so a summary-less compaction cannot leak the armed state into the next turn.

**Tests:**
- [ ] Feed the recorded live event sequence ([#empirical-wire-shapes](#empirical-wire-shapes): boundary → synthetic summary user → stdout user → result) through the session translator: exactly one `compact_summary` with the full summary string.
- [ ] Goal-feedback synthetic user events still translate to `goal_feedback`, never to `compact_summary`, armed or not.
- [ ] Boundary followed directly by `result` (no summary event): no `compact_summary`, flag disarmed.

**Checkpoint:**
- [ ] `cd tugcode && bun test`
- [ ] `just build` (tugcode is a compiled binary — rebuild before any app-level check)

---

#### Step 3: tugdeck intake + reducer — compact_summary and divider fallback {#step-3}

**Depends on:** #step-1

**Commit:** `tugdeck(compact-intake): compact_summary frame restores the carry-forward; boundary divider survives reload`

**References:** [P04] divider placement, [P05] compactionSeed reshape, Spec S01, Spec S03, (#state-zone-mapping, #flows)

**Artifacts:**
- `"compact_summary"` in `KNOWN_CODE_OUTPUT_TYPES` + wrapper mapping (`code-session-store.ts`); `CompactSummaryEvent` (`events.ts`); `handleCompactSummary` + `handleCompactBoundary` fallback (`reducer.ts`); `compactionSeed` type without `seedPending` (`types.ts`).

**Tasks:**
- [ ] Add the wire intake: KNOWN set entry + wrapper `compact_summary` → `CompactSummaryEvent` mapping beside the existing `compact_boundary` mapping.
- [ ] Add `handleCompactSummary` per Spec S03.
- [ ] Add the [P04] fallback to `handleCompactBoundary` (no pending turn → append note to last committed `TurnEntry`; empty transcript → drop).
- [ ] Reshape `compactionSeed` to `{ summary, preTokens } | null`; update `handleAddUserMessage`'s legacy path and `DevCompactionCarryForward` accordingly (drop `seedPending` writes/reads only — behavior unchanged).
- [ ] Update the `AddUserMessageEvent.compactionSummary` doc in `events.ts`: it describes the old seed-ride semantics ("the recap already rode the wire"); reword as the legacy-JSONL replay path.

**Tests:**
- [ ] Reducer: `compact_summary` in `replaying` and in a live mid-turn phase both set `compactionSeed.summary`; a second `compact_summary` overwrites (latest wins).
- [ ] Reducer: boundary with a pending turn appends the note mid-turn (existing coverage in `reducer.compact-boundary.test.ts` stays green); boundary with no pending turn and a committed turn appends to that turn; boundary on an empty transcript is a no-op.
- [ ] Legacy: `add_user_message` with `compactionSummary` still populates `compactionSeed` (existing test updated for the type reshape, not the behavior).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 4: tugdeck dispatch swap + fake-compaction removal {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(compact-native): /compact dispatches natively under a modal indeterminate sheet; remove the summarize/respawn machinery`

**References:** [P01] native dispatch, [P06] legacy compat, [P07] modal indeterminate progress, (#machinery-inventory, #flows)

**Artifacts:**
- Rewritten `slashCommandSurfaces.compact` in `dev-card.tsx`: guard `canSubmit` (bulletin "Can't compact while a turn is in flight" as today), `compactionProgressStore.begin(cardId)`, present the modal sheet, then `codeSessionStore.send(args.trim().length > 0 ? \`/compact ${args.trim()}\` : "/compact", [])`.
- Rewritten-in-place per [P07]: lean `compactionProgressStore` (`{ cardId, outcome }`), indeterminate `CompactionProgressSheet` ("Compacting…" + Cancel; Escape/Cmd-. = Cancel), and a dev-card watcher that settles the run off `codeSessionStore` snapshots — turn settled with compaction ink (compact `system_note` appended / `compactionSeed` updated since dispatch) ⇒ `succeed()`; settled without it ⇒ `cancel()`/`fail(reason)` with the pane bulletin. Cancel dispatches `codeSessionStore.interrupt()`.
- Deletions per [#machinery-inventory](#machinery-inventory): `pending-compaction-store.ts`, `deliverPendingCompactionSeeds`, the respawn watchdog + `COMPACTION_RESPAWN_TIMEOUT_MS`, `buildSummarizationPrompt`/`buildCompactionSeed`, the reducer send-path seed flush, the `mark_compaction_seed` event/handler/store-method.
- `compaction-request.ts` module doc rewritten as legacy-replay-recognition-only ([P06]).
- `LOCAL_SLASH_COMMANDS` `compact` description updated (e.g. "Compact the conversation in place to free up context").

**Tasks:**
- [ ] Rewrite the `compact:` handler; keep `takesArgs` routing (`/compact <focus>` passes focus through verbatim); open the run + modal sheet before the send ([P07]).
- [ ] Rewrite `compactionProgressStore` lean (`{ cardId, outcome }`; drop `phase` + `progress`) and `CompactionProgressSheet` as the indeterminate "Compacting…" + Cancel surface; wire the dev-card watcher that settles the run off `codeSessionStore` snapshots (settled-with-compaction-ink ⇒ succeed, else cancel/fail + bulletin).
- [ ] Execute every deletion in the inventory; chase imports (`dev-card.tsx`, `dev-session-restore.ts`) until `bunx tsc --noEmit`-clean via the vite build.
- [ ] Split `reducer.suppressed-turn.test.ts` per [P06]: delete its `markSeed()` helper and the `describe("reducer — mark_compaction_seed")` block (they assert the deleted event/field); keep the suppressed-turn and `compactionSummary` coverage intact.
- [ ] Verify the legacy keeps ([P06]) are untouched: `splitCompactionSeed` wrapper path, `suppressedTurn`, `send()` `suppress` option.
- [ ] Sweep for dangling references: `grep -rn "pendingCompactionStore\|buildSummarizationPrompt\|buildCompactionSeed\|markCompactionSeed\|mark_compaction_seed\|seedPending\|COMPACTION_RESPAWN_TIMEOUT_MS" tugdeck/src` → only legacy-test/comment hits that are deliberately retained, ideally zero. (`compactionProgressStore`/`CompactionProgressSheet` survive per [P07] — verify their `phase`/`progress` fields are gone instead.)

**Tests:**
- [ ] The surviving suppressed-turn + `compactionSummary` sections of `reducer.suppressed-turn.test.ts` green (legacy compat proof); the `mark_compaction_seed` sections removed, file compiles.
- [ ] Reducer test: `handleSend` no longer prepends any seed block to wire content (assert wire content === event content for a state with a populated `compactionSeed`).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 5: Integration checkpoint — end-to-end native compact {#step-5}

**Depends on:** #step-2, #step-4

**Commit:** `N/A (verification only — app-test additions commit here if new files are created)`

**References:** [P01], [P03], [P04], [P05], [Q01], [Q02], (#success-criteria, #empirical-wire-shapes)

**Tasks:**
- [ ] `just build` (fresh tugcode binary + Rust bins), launch the debug app.
- [ ] App-test: extend `at0106-compact-boundary-divider.test.ts` or add a sibling that cold-loads a **real natively-compacted fixture JSONL** (model on `at0192-z2-cold-replay.test.ts`) and asserts the divider note AND the Compaction Summary block render after replay — this is the relaunch-restore regression test for the original bug. While there, fix `at0106`'s stale header comment ("a typed `/compact` is client-dispatched and never reaches the bridge").
- [ ] On-demand real-claude verification: in a scratch project card, run `/compact` on a several-turn session; verify the modal indeterminate sheet blocks the card for the run and dismisses on completion ([P07]), same `SESSION` chip id, divider + summary block appear; quit and relaunch the app; verify divider + summary restore.
- [ ] Resolve [Q01]: cancel a live `/compact` via the sheet's Cancel, confirm the sheet dismisses, the session resumes, and a later `/compact` succeeds.
- [ ] Resolve [Q02]: `/compact` a 1-turn session, confirm the refusal renders and the turn settles idle.
- [ ] Rename check: `/rename` before and after a compact — both stick, same `sessions.db` row (`sqlite3` against the instance DB).

**Tests:**
- [ ] `just app-test` (full suite, including the new/extended compact test).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` (no Rust changes expected — proves it)
- [ ] `cd tugcode && bun test && cd ../tugdeck && bun test && bunx vite build`
- [ ] `just app-test`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** `/compact` runs Claude Code's native compaction in place — same session id, same JSONL — under a pane-modal indeterminate "Compacting…" sheet with a working Cancel, with the boundary divider and Compaction Summary block rendering live and surviving app relaunch; the fork-based machinery is deleted.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `/compact` completes with an unchanged session id and no new JSONL (manual verification per [#success-criteria](#success-criteria)).
- [ ] Compacted-session relaunch restores divider + summary block (app-test).
- [ ] Fake-compaction machinery gone; sweep grep returns no production hits (Step 4 sweep).
- [ ] Legacy fake-compacted JSONLs still replay correctly (the surviving suppressed-turn/`compactionSummary` tests + wrapper seed-split tests green).
- [ ] [Q01] and [Q02] resolved and recorded in this plan.

**Acceptance tests:**
- [ ] New/extended app-test: cold replay of a natively-compacted fixture renders divider + summary block.
- [ ] tugcode replay unit tests on the real fixture (Step 1).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Fix the picker/ledger dual-`project_dir` literal-match bug (canonical-vs-typed path split in `SessionLedger::list_for_project_dir` vs the external scan) — separate plan; it explains the historical "terminal" misbadge.
- [ ] Consider surfacing `post_tokens` / `cumulative_dropped_tokens` from `compact_metadata` in the divider or telemetry popover.
- [ ] Consider a compaction-history surface (multiple summaries per session) instead of latest-wins.

| Checkpoint | Verification |
|------------|--------------|
| Native dispatch works | `/compact` in-app; same SESSION chip id |
| Summary survives relaunch | app-test on compacted fixture |
| Machinery removed | Step 4 sweep grep |
| Legacy compat | surviving suppressed-turn/`compactionSummary` + seed-split tests green |
