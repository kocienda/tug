## Tide Transcript Resume — Manual Smoke Checklist {#smoke-checklist}

Manual verification for [Step 5](./tugplan-tide-transcript-resume.md#step-5)
of `tugplan-tide-transcript-resume.md`. Each smoke exercises a
distinct transition class and hits a different code path; running
all four is the phase-close requirement for resume-from-JSONL.

For every smoke:
- Tug.app must be launched fresh (or per-step instructions)
- Use a real Anthropic-authenticated Claude on PATH
- Have a project directory under your home that contains tugplug
  (any tugtool checkout works)

---

### Pre-flight

- [x] `tugcast` and `tugcode` binaries built and symlinked under
      `~/.local/bin` (`just install` does this).
- [x] `tugdeck` dev server is running (`just dev` or equivalent) —
      HMR must be live for Smoke A.
- [x] Tug.app launches and connects to the local supervisor.
- [x] You have at least one Tide card you can populate with several
      turns. A simple seed: open Tide on this checkout, ask
      "summarize this repo in one paragraph"; let it complete; then
      ask "list the top-level directories"; let it complete.

---

### Smoke A — HMR (Vite module replacement, page stays alive)

Exercises: `tide-session-restore` may or may not fire; the existing
`CodeSessionStore` (which survives HMR) keeps `transcript`.

**Status: PASSED 2026-05-04** (Phase A-R1.5).
Telemetry captured during the Phase A-R1.5 verification cycle shows
`request_replay.dispatched` → tugcode `[tide::replay::request]` →
`[tide::replay::started]` → `[tide::replay::complete count=4 elapsed_ms=0]`
end-to-end in ~110ms; transcript repaints with all prior turns; no
stuck phase, no red banner. The structural fix that closed this
smoke landed in [Phase A-R1](./tugplan-tide-transcript-resume.md#phase-a-r1)
(`request_replay` verb) and was made reachable from the wire by the
[Phase A-R1.5](./tugplan-tide-transcript-resume.md#phase-a-r1-5)
collapse of the duplicate router allowlist (`ControlOutcome` enum)
plus deletion of the R0d spawn-watchdog timer that was killing
healthy claudes after 30s of user idle.

- [x] Open a Tide card; submit ≥3 turns to populate `transcript`.
- [x] In your editor, save a tugdeck source file (e.g.
      `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` —
      edit a comment to force HMR).
- [x] Wait for Vite HMR to swap the module(s) — usually instant.
- [x] **Verify:** the transcript repaints with all prior turns,
      bytes-identical to pre-HMR (modulo timestamp-rendering reflow).
- [x] **Verify:** submit one new turn; it appends correctly below
      the prior turns.
- [x] **Verify:** the "Loading conversation…" placeholder either
      doesn't appear (HMR didn't trigger restore) or appears very
      briefly (`<2s`). Either is acceptable.
- [x] No stuck `replaying` phase; no red banner; no warnings in the
      dev-tools console beyond the usual HMR noise.

### Smoke B — Developer > Reload (page destroys, app stays alive)

Exercises: full `cardSessionBindingStore` rehydrate via tugbank →
`tide-session-restore` fires `spawn_session(mode=resume)` → tugcast
spawns tugcode in resume mode → tugcode reads JSONL → replay flows.

**Status: PASSED 2026-05-04** (Phase A-R1.5).
Captured trace from a representative reload cycle:

```
23:09:21.129  dispatch_action: broadcasting client action: reload
23:09:21.158  Client disconnected client_id=4
23:09:21.236  Client connected client_id=5
23:09:21.239  spawn.supervisor_recv card_id=3f751d14-... tug_session_id=5cbbdfb0-... session_mode="resume"
23:09:21.239  spawn.effective_mode inserted=false mode_mismatch=false
23:09:21.249  request_replay.dispatched tug_session_id=5cbbdfb0-...
23:09:21.249  [tide::replay::request] session_id=5cbbdfb0-...
23:09:21.249  [tide::replay::started] jsonl_path=/Users/.../5cbbdfb0-....jsonl
23:09:21.249  [tide::replay::complete] count=4 elapsed_ms=0
```

End-to-end: ~120ms reload-to-fully-replayed. Two consecutive cycles
in the captured trace, both clean. Zero `spawn_timeout`, zero
`resume_failed`, zero errors. Pre-Phase A-R1.5 this smoke failed
two ways simultaneously: the verb didn't reach tugcode (router-side
allowlist drift, fixed in [`723026b8`](#) by collapsing into
`ControlOutcome`), and the R0d spawn-watchdog killed claude at the
30s mark after the user paused (fixed in [`4ad0f960`](#) by
removing the timer entirely).

- [x] Open a Tide card; submit ≥3 turns. Make sure the last turn
      has a `turn_complete(success)` (the page must not be
      mid-stream when you reload — that's Smoke D).
- [x] In Tug.app's menu: Developer → Reload (or Cmd-R).
- [x] **Verify:** the page tears down and rebuilds. The Tide card
      shows the "Loading conversation…" placeholder briefly.
- [x] **Verify:** the placeholder dismisses; the transcript renders
      all prior turns in order, byte-identical to pre-reload (modulo
      timestamp-rendering reflow).
- [x] **Verify:** submit one new turn; it appends correctly.
- [x] **Verify:** in the tugcast log
      (`just tail-tugcast` / `~/Library/Logs/Tug/`), search
      `[tide::replay::started]` and `[tide::replay::complete]` —
      both must appear; `complete` must carry `count=N` matching
      the prior-turn count and no `error` field.

### Smoke C — Cold boot (Tug.app destroys, supervisor restarts from disk)

Exercises: tugcast supervisor reads its sqlite ledger +
`dev.tugtool.tide.session-keys` tugbank domain;
`rebind_from_tugbank` rehydrates the `LedgerEntry` with persisted
`claude_session_id`; the deck restores; the active Tide card's
binding record is read; `tide-session-restore` fires.

**Status: PASSED 2026-05-04** (Phase A-R1.5).
Cold-boot resume runs through R0d's startup-replay path — `prepareSession()`
synthesizes the `session_init`, `runReplay()` reads the JSONL and
emits the bracket pair, then `spawnClaudeAndWatch()` brings claude
up in the background. The earlier captured trace (during the R1d
verification cycle) shows `tugcode.prepare_session` →
`[tide::replay::started]` → `[tide::replay::complete count=3 elapsed_ms=1]`
→ `tugcode.claude_spawn ... --resume <id>` all within 1ms of
spawn — populated transcript paints essentially instantly. The
[Phase A-R0](./tugplan-tide-transcript-resume.md#phase-a-r0)
symlink-canonicalization fix is the load-bearing repair for this
smoke; Phase A-R1's verb fires alongside (`request_replay.skipped
reason="spawning"` — correct no-op since the cold-boot startup-replay
path covers that case).

- [x] Open a Tide card; submit ≥3 turns; let the last turn settle.
- [x] Quit Tug.app entirely (Cmd-Q or via menu — not just close
      the window).
- [x] Confirm tugcast also exits — `pgrep tugcast` should return
      no PIDs. If a stray supervisor is still up, kill it before
      proceeding (otherwise you're testing a warm-start).
- [x] Relaunch Tug.app.
- [x] **Verify:** the app reopens to your prior decks. The active
      Tide card shows the "Loading conversation…" placeholder
      briefly.
- [x] **Verify:** the transcript repaints with all prior turns.
- [x] **Verify:** submit one new turn; it appends correctly.
- [x] **Verify:** the model name in committed code rows matches
      whatever model is currently bound (per [D09] — replay does
      not re-emit per-turn `SESSION_METADATA`, so historical model
      names don't surface; this is intentional for v1).

### Smoke D — Mid-turn reload (passes via mid-turn replay plan)

**Status: PASSES via [tugplan-tide-mid-turn-replay.md](../tugplan-tide-mid-turn-replay.md)
(Step 5 + Step 6, shipped 2026-05-06).** The original Smoke D entry
below assumed the [D08] orphan-synthesis contract for *every*
mid-turn reload. The mid-turn replay plan went through three design
generations:

1. **Steps 1–3** (msg_id canonicalization + translator skip +
   in-flight emission). Shipped, then manual smoke surfaced a
   [DM03] race bug + a deeper id-stability gap.
2. **Step 4** (ledger-authoritative `tug_turn_id` re-keying).
   Shipped, smoke test failed (empty window after reload).
3. **Step 5** ([DM08] rip-and-simplify): wire reverts to claude's
   `message.id` end-to-end; ledger narrows to a submission journal;
   translator-driven replay; pending-row injection; HMR-mid-stream
   delivery chain explicit and pinned.

The post-Step-5 design treats `message.id` as the only id on the
wire. Tugcode never invents an id. The submission journal (narrowed
`turns` table) holds pending rows from user-submit until claude
acknowledges in JSONL; after acknowledge, JSONL is the authority.
The reducer keys content by claude's `message.id` (sliding pointer
within `ActiveTurn.currentMessageId`); multi-message claude turns
produce separately-keyed wire streams.

Automated regression coverage is distributed across multiple test
files (the original `replay-spawn-mid-turn.test.ts` was deleted in
[Step 5.4](../tugplan-tide-mid-turn-replay.md#step-5-4) along with
the rest of the ledger-authoritative scaffolding):

- `tugcode/src/__tests__/replay.test.ts` — translator core
  (per-message flushing, multi-message cycles, tool ordering).
- `tugcode/src/__tests__/replay-hmr-mid-stream.test.ts` — runReplay's
  in-flight snapshot emission shape (7 tests covering live inflight,
  empty partial, no-id-yet, pre-bracket-finished, no-activeTurn,
  multi-frame ordering).
- `tugcode/src/__tests__/replay-pending-row-injection.test.ts` —
  Step 5.6 pending-row synthetic for journal rows whose `user_text`
  doesn't appear in JSONL (8 tests).
- `tugcode/src/__tests__/replay-interrupted-orphan.test.ts` —
  orphan-interrupted submissions (Cmd-Q before claude responds) emit
  their own committed-interrupted turn; `[Request interrupted by user]`
  marker dropped from the wire (4 tests).
- `tugcode/src/__tests__/session.test.ts` — `ActiveTurn.currentMessageId`
  sliding pointer (no canonicalize/reject; multi-message turns split
  per claude `message.id`).
- `tugdeck/src/lib/code-session-store/__tests__/reducer.replay-inflight-survival.test.ts` —
  reducer preserves `pendingUserMessage` + `scratch` + `activeMsgId`
  when `replay_complete` arrives with an in-flight cycle still pending
  (4 tests).

All five files asserted N=20 deterministic green at Step 6 close-out.

Exercises (post-Step-5 expectations):

- The JSONL ends mid-turn (last `assistant.stop_reason: null`)
  AND/OR the journal has a pending row for a submission claude
  hasn't yet acknowledged.
- The translator emits per-message frames from JSONL keyed on each
  `assistant` entry's own `message.id`. `user_message_replay` fires
  once per cycle on the first assistant entry; `turn_complete` only
  on `stop_reason === "end_turn"`.
- For pending journal rows whose `user_text` doesn't appear in JSONL,
  `injectPendingRowSynthetics` emits a synthetic `user_message_replay`
  keyed on `journal_id` between the bracket's `replay_started` and
  the first translator emit.
- For an in-flight turn (tugcode's `ActiveTurn` non-null with no
  terminal latched), `runReplay` calls `emitInflightTurnFromActiveTurn`
  after the JSONL pass and before `replay_complete` to deliver the
  pre-HMR streaming content (consolidated `assistant_text { is_partial:
  false }` from `turn.partialText`, keyed on `turn.currentMessageId`).
- `replay_complete` preserves `pendingUserMessage` + `scratch` +
  `activeMsgId` if any survived the bracket; transitions to
  `streaming` so post-bracket live deltas append onto the snapshot
  baseline.
- Live `turn_complete` arrives, reducer commits the TurnEntry with
  the full body (snapshot + post-bracket tail). The merger's
  Step 5.10 bracket-flag gate suppresses replay-emitted
  `turn_complete` from popping the journal; live terminal pops once.

Original cold-boot interrupted-session smoke (preserved for
[D08] regression coverage of the no-active-turn case):

- [ ] Open a Tide card; submit a turn that produces a long response
      (e.g. "give me a 500-word summary of how this repo's session
      lifecycle works, end-to-end" — anything that takes > 5s to
      stream).
- [ ] Mid-stream — while the assistant is still generating —
      Cmd-R / Developer → Reload.
- [ ] **Verify:** the page rebuilds; the transcript shows the
      partial assistant text from before the reload, AND
      streaming continues live to completion as one TurnEntry —
      no duplicate row, no phantom interrupted marker, no stuck
      "Loading conversation" spinner.
- [ ] **Verify:** if the user explicitly interrupts during the
      bracket window (Cmd-R then immediate cancel via existing
      UI), the in-flight TurnEntry renders as truncated with the
      `turn_cancelled` partial_result.
- [ ] **Verify:** submit one fresh turn after the bracket
      closes; it appends and flows live to completion.
- [ ] **Verify:** in the tugcast log,
      `[tide::replay::complete]` carries no `error` field
      (the translator's skip path is its normal end-of-iteration
      flow; `count` reflects only committed turns, not the
      handed-off in-flight turn).

---

### Reporting back

When done, leave each top-level checkbox above as `- [x]` if the
smoke passed, or `- [ ]` with a brief note describing the failure
mode (which step failed, what was on screen, what the log said).
The log lines `[tide::replay::started|progress|complete|error]`
under tugcast's `tugcode_stderr` target are the canonical
tellurium for replay-window behavior.

If any smoke fails, it blocks the [phase exit
criteria](./tugplan-tide-transcript-resume.md#exit-criteria).

---

## Appendix — Smoke C Diagnostic Capture (Step R0b) {#smoke-c-diagnostic}

Structured run for `tugplan-tide-transcript-resume.md` [Step R0b](./tugplan-tide-transcript-resume.md#step-r0b).
The goal is to observe **what tugcast actually does** during cold boot so we
can name the specific bug that breaks Smoke C, before authoring the
`request_replay` verb in [Phase A-R1](./tugplan-tide-transcript-resume.md#phase-a-r1).

### Pre-flight (one terminal, one editor)

- [ ] Build fresh + install:
      ```
      just install
      ```
- [ ] Confirm `tugbank` CLI is on PATH:
      ```
      tugbank --version
      ```
- [ ] Confirm Claude is reachable:
      ```
      claude --version
      ```

### Static inspection (before launching Tug.app)

Snapshot the existing tugbank records and on-disk JSONL layout so we have
a baseline:

- [ ] List all session-keys records:
      ```
      tugbank read dev.tugtool.tide.session-keys
      ```
      Note the count of records, how many carry `claude_session_id` non-null,
      how many carry `session_mode`. Existing records in this user's bank as of
      Step R0b authoring: 33 records, 6 with `claude_session_id` set, 6 with
      `session_mode`. If your numbers diverge wildly, write them down here.

- [ ] List existing on-disk JSONL project directories:
      ```
      ls ~/.claude/projects/ | head -20
      ```
      Note especially: does any directory match the *encoded form* of the
      `project_dir` your test will use, or does it match the *resolved
      symlink* form?

- [ ] **Path-encoding hypothesis check.** Pick a session-keys record whose
      `claude_session_id` is non-null and `project_dir` points at a path
      you reach via symlink (e.g. `/u/src/tugtool` symlinks to
      `/Users/<user>/Mounts/u/src/tugtool`). Compute both forms and check
      which exists:
      ```bash
      P="/u/src/tugtool"   # adjust to your record's project_dir
      ENCODED="$(printf '%s' "$P" | tr / -)"
      RESOLVED="$(cd "$P" && pwd -P)"
      ENCODED_RES="$(printf '%s' "$RESOLVED" | tr / -)"
      echo "encoded(symlink)  = ~/.claude/projects/$ENCODED"
      echo "encoded(resolved) = ~/.claude/projects/$ENCODED_RES"
      [ -d "$HOME/.claude/projects/$ENCODED" ] && echo "  symlink form  EXISTS" || echo "  symlink form  MISSING"
      [ -d "$HOME/.claude/projects/$ENCODED_RES" ] && echo "  resolved form EXISTS" || echo "  resolved form MISSING"
      ```
      Record the output below.

      Result:
      ```
      <paste here>
      ```

### Live capture

- [ ] Open a fresh terminal and start the replay-filtered tail:
      ```
      just tail-replay
      ```
- [ ] In another terminal, launch Tug.app cleanly:
      ```
      just app
      ```
- [ ] Open a Tide card; submit ≥3 turns; let the last one settle. Note
      its tug_session_id from the dev-tools console, or grep the tail for
      the most recent `card_id`/`tug_session_id` values.

      Recorded card_id / tug_session_id:
      ```
      card_id        = <paste>
      tug_session_id = <paste>
      project_dir    = <paste>
      ```

- [ ] Quit Tug.app entirely (Cmd-Q).
- [ ] Confirm tugcast also exited:
      ```
      pgrep tugcast || echo "(no tugcast process; ok)"
      ```

### Tugbank inspection (after Tug.app exit, before relaunch)

- [ ] Read the just-closed card's record:
      ```
      tugbank read dev.tugtool.tide.session-keys <card_id>
      ```
      Capture the JSON. Specifically:

      ```
      claude_session_id : <paste>
      session_mode      : <paste>
      project_dir       : <paste>
      tug_session_id    : <paste>
      ```

- [ ] **Candidate 1 (claude_session_id persistence) check.** Did the record
      carry a non-null `claude_session_id`? **Yes / No:** _____
- [ ] **Candidate 2 (session_mode persistence) check.** Did the record
      carry `session_mode: "resume"` (or "new")? **Yes / No / MISSING:** _____

### On-disk JSONL inspection

- [ ] Compute the JSONL path the *current code* would resolve from the
      record's `project_dir`:
      ```bash
      P="<paste project_dir from record>"
      ENCODED="$(printf '%s' "$P" | tr / -)"
      CLAUDE_ID="<paste claude_session_id from record>"
      ls -la "$HOME/.claude/projects/$ENCODED/$CLAUDE_ID.jsonl" 2>&1
      ```
      Result:
      ```
      <paste here>
      ```

- [ ] Check the resolved-symlink encoding (if `project_dir` is a symlinked
      path):
      ```bash
      RESOLVED="$(cd "$P" && pwd -P)"
      ENCODED_RES="$(printf '%s' "$RESOLVED" | tr / -)"
      ls -la "$HOME/.claude/projects/$ENCODED_RES/$CLAUDE_ID.jsonl" 2>&1
      ```
      Result:
      ```
      <paste here>
      ```

- [ ] **Candidate 3 (JSONL path encoding mismatch) check.** Does the JSONL
      live under the symlink-encoded path, the resolved-encoded path, or
      both? Or neither? Circle one:
      `symlink-encoded` / `resolved-encoded` / `both` / `neither`

### Cold-boot relaunch and live tail

- [ ] Relaunch Tug.app:
      ```
      just app
      ```
- [ ] Watch `just tail-replay` for the resume sequence. Capture the lines
      in order. The first three should always appear; the rest depend on
      the bug:

      ```
      [rebind.entry]                     <paste line>
      [spawn.effective_mode]             <paste>
      [supervisor.eager_spawn]           <paste>
      [session_init.parse]               <paste>
      [tide::replay::started]            <paste>
      [tide::replay::progress] (any?)    <paste>
      [tide::replay::complete]           <paste>
      [tide::replay::error] (if any)     <paste>
      ```

- [ ] **Candidate 4 (timing race) check.** Did `[tide::replay::started]`
      land before tugdeck's WS established? Compare the timestamps:
      tugdeck's WS connect log line vs. the replay-started line. **Race
      observed?** Yes / No: _____

- [ ] **Candidate 5 (reducer filter mismatch) check.** Did the
      `replay_complete` line carry the same `tug_session_id` as the
      card's binding? Cross-reference with the `card_id` / `tug_session_id`
      captured above. **Filter mismatch?** Yes / No: _____

### UI observation

- [ ] What does the Tide card show after relaunch? Circle one or more:
      `empty transcript` / `loading conversation… (stuck)` /
      `loading conversation… briefly, then empty` / `transcript repaints
      with all turns` / `picker shown (binding lost)` / `error banner` /
      `other` (describe): __________

- [ ] Was the new turn submittable afterward? **Yes / No:** _____

### Findings

Based on the captures above, the broken-smoke-C root cause(s) are:

- [ ] **Candidate 1** confirmed (claude_session_id null in the record):
      Reason: __________
- [ ] **Candidate 2** confirmed (session_mode missing or "new"):
      Reason: __________
- [ ] **Candidate 3** confirmed (JSONL path encoding mismatch):
      Reason: __________
- [ ] **Candidate 4** confirmed (timing race):
      Reason: __________
- [ ] **Candidate 5** confirmed (reducer filter mismatch):
      Reason: __________
- [ ] **Other / unanticipated:** describe: __________

### Confirmed findings (Step R0b run)

**Candidate 3 — JSONL path encoding mismatch — confirmed.**

Cold-boot smoke run captured 2026-05-04. Card `7b4599cc-…` /
tug_session_id `c563ebb5-…` populated with a fresh session, then
Tug.app cold-booted.

Tugbank record (post-quit, pre-relaunch):

```json
{
  "claude_session_id": "c563ebb5-f9f7-4807-8a1e-5e9e35faae50",
  "project_dir": "/u/src/tugtool",
  "session_mode": "new",
  "tug_session_id": "c563ebb5-f9f7-4807-8a1e-5e9e35faae50"
}
```

JSONL path resolution:

```
symlink form  = ~/.claude/projects/-u-src-tugtool/c563ebb5-…jsonl                  → MISSING
resolved form = ~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/c563ebb5-…jsonl → EXISTS (15943 bytes)
```

Cold-boot log:

```
[rebind.entry]              card_id=7b4599cc-…  rebound_mode="new"  mode_source="persisted"
                            claude_session_id="c563ebb5-…"
[spawn.supervisor_recv]     session_mode="resume"
[spawn.effective_mode]      effective_mode="resume"  inserted=false  mode_mismatch=false
[supervisor.eager_spawn]    →
[bridge.tugcode_spawn]      args=["--dir", "/u/src/tugtool", "--session-mode", "resume",
                                  "--resume-session", "c563ebb5-…"]
[session_init.parse]        claude_session_id="c563ebb5-…"
[session_init.persist]      → tugbank record updated
[ledger.record_spawn]       workspace_key="/Users/kocienda/Mounts/u/src/tugtool"
                            project_dir="/u/src/tugtool"     ← supervisor knows the canonical form
[tide::replay::started]     jsonl_path=/Users/kocienda/.claude/projects/-u-src-tugtool/c563ebb5-…jsonl
                                       ────────────────  ↑ tugcode used the SYMLINK encoding
[tide::replay::complete]    count=0  elapsed_ms=1   ← `jsonl_missing` (file at symlink form not on disk)
```

**Note also:** the `[rebind.entry]` line for record `e0ccd472-…` shows
`rebound_mode="resume" claude_session_id=""` — a pre-fix legacy
record where session_mode was persisted as "resume" but claude_id was
not. That's a pre-Step-0 artifact, distinct from Candidate 3, but
worth a future cleanup pass on stale records.

**Other candidates ruled out for this run:**

- **Candidate 1** (claude_session_id persistence): NOT the bug here.
  The record carried `claude_session_id="c563ebb5-…"`. Step 0's
  persistence works for fresh records.
- **Candidate 2** (session_mode persistence): NOT the bug here.
  The record carried `session_mode="new"` (the user's last spawn was
  fresh-mode). The supervisor's defense-in-depth path correctly
  upgraded the rebound entry to `effective_mode="resume"` per the
  client's request.
- **Candidate 4** (timing race): NOT the bug here. The replay sequence
  fires inline with `session_init` — no observed race against WS
  drain.
- **Candidate 5** (reducer filter mismatch): NOT exercised — `replay`
  bracket events did reach tugdeck's reducer (the placeholder dismisses
  cleanly), they just carry an empty count because no JSONL was
  found upstream.

### Resolution (one-line fix landed in this step)

`tugcode/src/session.ts` `SessionManager.runReplay()` now resolves
symlinks via `fs/promises.realpath` on `this.projectDir` before
passing to `jsonlPathFor`. Claude itself canonicalizes its `cwd`
when computing where to write the JSONL, so the encoding rule has
to match. Falling back to the raw path on `realpath` failure is
safe — downstream `jsonlReader` reports `missing` exactly as
before, and tests that point at synthetic non-existent paths
continue to work.

Two regression tests added in
`tugcode/src/__tests__/replay-spawn.test.ts`:

- A symlinked tmp project dir → `jsonlReader` is invoked with the
  resolved-encoded path, not the symlink-encoded path.
- A non-existent path → fallback path is the raw-encoded form
  (no behavior change for the existing test fixtures).

Verification: re-run cold-boot Smoke C after this fix and confirm:

- [ ] `[tide::replay::path_canonicalized]` log line fires with
      `raw=/u/src/tugtool` and
      `canonical=/Users/<user>/Mounts/u/src/tugtool`.
- [ ] `[tide::replay::started]` `jsonl_path` ends in
      `-Users-<user>-Mounts-u-src-tugtool/<claude_id>.jsonl`.
- [ ] `[tide::replay::complete]` `count` matches the prior turn count
      (not 0); no `error` field.
- [ ] Tide card transcript repaints with all prior turns.
