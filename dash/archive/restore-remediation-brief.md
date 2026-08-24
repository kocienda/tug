# Restore remediation brief — fallout from the effective-record-sequence change

**Status:** open. Five distinct issues, all observed on `main` at `f6f1383cf` in the running release app on 2026-07-28.

**Purpose:** hand a cold reader everything needed to investigate and fix the problems that surfaced *after* the session-restore hardening landed. This brief assumes no conversation context. It records what was measured, what was assumed and turned out wrong, and what is still unexplained.

---

## What landed, and where

`dash/restore-issues.md` was implemented on the `restore-issues` dash and joined to `main` as **`f6f1383cf`**. The plan's own Step Status Ledger records the per-step dash commits (`da97265cc`, `a58289b63`, `f9280506d`, `5239655cd`, `ec2903f41`, `240a8bcd7`, `03120ceb3`, `a46142e83`).

The change introduced the **effective record sequence**: the session JSONL minus (a) records on abandoned branches and (b) re-appended duplicate occurrences of a uuid. Both halves of the turn-metric contract were moved onto it in one commit.

Surfaces touched:

| File | Change |
|---|---|
| `tugcode/src/replay.ts` | `suppressReappendDuplicates`, `nullNonEffectiveEntries`; applied in `translateJsonlSession` (after dead-nulling, before `hoistCompactCommandEnvelope`) and in `segmentJsonlOrigins` |
| `tugcode/src/main.ts` | new `tugcode dead <file-or-dir>` subcommand (sibling of `tugcode segment`) |
| `tugrust/crates/tugcast/src/dead_branch.rs` | new: `ChainRecord`, `parse_chain_record(s)`, `compute_dead_entry_indices`, `effective_indices` |
| `tugrust/crates/tugcast/src/turn_engine.rs` | `segment_str` routes through `dead_branch`; `Frontier` gains `leaf_uuid` |
| `tugrust/crates/tugcast/src/external_sessions.rs` | scanner buffers records and runs an EOF second pass; invalidation triggers; `ParsedSession.recounted` |
| `tugrust/crates/tugcast/src/session_ledger.rs` | `frontier_leaf_uuid` column; `CURRENT_RULE_EPOCH` 2 → 3 |
| `tuglaws/turn-metric.md` | documents the effective record sequence |

### What is verified and should not be re-litigated

These held up under real-corpus measurement and are not suspected in any issue below:

- Dead-branch rescue works. The Rust↔TS dead-set parity contract compares **884 real corpus sessions with 0 divergent**; the property validator (`tugcode/src/__tests__/replay-dead-invariants.test.ts`) passes **883 sessions with 0 violations** and still finds **7 sessions with non-empty dead sets**.
- The pre/post diff over the five originally-affected sessions rescued **10,447 entries**, none of which is a live-parented off-chain user submission — so no genuine abandoned branch was resurrected.
- `engine_matches_tugcode_segmentation_over_real_corpus` passes with **884 sessions, 0 divergent**, with both halves on the effective sequence.
- On all five affected sessions, emitted `turn_complete` count equals distinct `msg_id` count (73/73, 55/55, 19/19, 68/68, 35/35).
- `at0285-restore-dead-branch.test.ts` is green through the real cold-replay chain.

**The problems below are downstream of, or adjacent to, that verified core.** Do not start by re-checking the dead-branch walk.

---

## Issue 1 — Rendered turn count exceeds the canonical count (`83 of 68`)

**Observed:** session `8b8d7bf1-5d25-4b2d-95de-ee1ccba71d42` opened in the release app shows `TURNS DISPLAYED: 83 OF 68 · ALL LOADED`.

This violates the turn-metric equality invariant in `tuglaws/turn-metric.md`: `engine(session file) == replay totalTurns == highest rendered address`.

**What was measured.** The `68` side is solid and agrees across four independent computations:

- `tugcode segment` (TS `segmentJsonlOrigins`) → 68
- Rust `segment_str` → 68
- the `external_sessions` disk scanner (`parse_candidate`) → 68
- the persisted ledger row → `turn_count=68, rule_epoch=3`

tugcode's emitted frames for that session:

```
add_user_message 69   turn_complete 68   compact_boundary 9   compact_summary 9
assistant_opener 1    wake_started 1     system_metadata 3
```

**The `83` is deck-side and unexplained.** `83 − 68 = 15`. The indicator reads `codeSessionStore.getSnapshot().transcript.length` — see `tugdeck/src/components/tugways/cards/session-load-control-bar.tsx` (the `useSyncExternalStore` on `transcript.length`) feeding `displayed` in `session-load-control-bar-state.ts`. The transcript array is built from `append-transcript` effects in `tugdeck/src/lib/code-session-store.ts` (via `appendTurnInterleavingShell`), plus `flush-prepend`, `upsertShellTurn`, and `truncateTranscriptAtAnchor`.

**Dead end to avoid repeating.** An attempt to drive the real reducer offline — feeding `translateJsonlSession` frames straight into `reduce()` from `tugdeck/src/lib/code-session-store/reducer.ts` and counting `append-transcript` effects — returned **0 effects**. That is a defect in the probe (the replay bracket / store lifecycle was not set up), **not** evidence about the reducer. Either build the probe properly against the real store, or instrument the running app via `tugDevLogStore` and read `window.tugDevLog.getSnapshot()`.

**Candidate directions, untested:** shell-row interleave (`upsertShellTurn`) adding rows the engine never counts; the compaction frames opening their own containers (see Issue 3, likely the same root cause); replay bracket prepend staging double-committing.

---

## Issue 2 — One compaction divider missing (8 rendered, 9 emitted)

**Observed:** only **8** `Session compacted` dividers in the transcript for `8b8d7bf1`.

**Measured:** tugcode emits **9** `compact_boundary` and **9** `compact_summary` frames. The raw file holds 20 compaction records (10 `compact_boundary` + `isCompactSummary` pairs); one pair is a re-appended duplicate and is correctly nulled by suppression, leaving 9. So the loss is **between tugcode's output and the rendered transcript**, one divider deep.

Emitted frame order around every boundary is consistent and looks correct:

```
add_user_message | compact_boundary | compact_summary | turn_complete
```

`at0193-compact-native-reload.test.ts` and `at0106-compact-boundary-divider.test.ts` both pass, so whatever this is, the existing coverage does not reach it — likely because those fixtures have a single compaction and this session has nine.

---

## Issue 3 — Compaction boundaries render as assistant messages with "No response requested"

**Observed:** a compaction renders as an **assistant** turn (`#a73`, avatar "Opus 5", timestamp) whose body is the `Session compacted` block plus the text **"No response requested."** and a `−117.5K tokens` footer.

**Correct design, for comparison:** the `/compact` envelope renders as a **user** row (`#u60`, "You") showing the invocation text (`/compact prepare to continue improving…`), with the `Session compacted` bar as a divider *below* it. No assistant row, no "No response requested".

This is almost certainly the same root cause as Issue 1: if each compaction seats an assistant-origin container that the engine does not count, that is both extra rendered turns and a wrong-looking boundary. Nine compactions plus the six other unexplained containers would land near 83 — **arithmetic worth checking, not a conclusion**.

**Where to look:** `hoistCompactCommandEnvelope` in `tugcode/src/replay.ts` (reorders the `/compact` envelope above its boundary record — note that suppression now runs *before* this hoist, per the plan's `[P02]`); `tugdeck/src/lib/code-session-store/compaction.ts`; the "No response requested" string's origin in the deck.

---

## Issue 4 — Transcript blinks out, repositions, and loses content across close/reopen

**Observed on session `4eb21996-9a77-4528-a854-53081ec7bc66`** ("local-model-bringup"), release app:

1. The transcript **blanks entirely** when switching away from Tug and back — i.e. on app activation. A screenshot shows the whole transcript region empty, with the follow-bottom affordance visible, status bar reading `Idle · 2m 44s · −144.0K tokens · 56.9K/1.00M context · PULSE Done`, Claude Code 2.1.220.
2. It also **repositions above the bottom** rather than staying pinned.
3. Clicking follow-bottom **temporarily restores** the content — until the next blink-out.
4. After **closing and reopening** the session, "a lot of its content is gone."

**Session facts (measured):**

| Property | Value |
|---|---|
| Size | 22,027,593 bytes (22 MB) |
| Records | 7,607 |
| Duplicate uuid pairs | 1,183 |
| Compaction records | 22 |
| Dead set | **empty** |
| Engine turn count | 67 |

The empty dead set matters: **branch detection is not dropping anything here.** If content is genuinely missing, the suspects are duplicate suppression (Issue 5 below), the replay window, or the deck.

Symptoms 1–3 look like a render/scroll fault rather than data loss, and may share a cause with the performance problem. Symptom 4 may be the same thing (content present but not painted) or may be real loss — **this has not been distinguished and should be step one.**

Relevant prior art: `tuglaws/` HMR-vs-reload doctrine (HMR must never reload data; Maker ▸ Reload is a true hard refresh that re-resumes from JSONL); `reference_sticky_header_reveal`; the follow-bottom / scroll anchoring code in the transcript host.

---

## Issue 5 — Memory bloat and app-wide lag

**Observed:** typing is laggy, opening a new session lags. This is the **release** app, so it is a genuine regression on `main`, not a debug-build artifact.

**Measured process state:**

```
PID 32060  Tug.app (Swift host)   RSS 4,868,128 KB ≈ 4.6 GB   %CPU 2.4
PID 32081  tugcast                RSS   266,448 KB ≈ 260 MB   %CPU 7.8
PID 32971  Tug-debug (host)       RSS   148 MB               %CPU 10.1
```

**4.6 GB resident in the host process is the headline.** At that size the lag is memory pressure across the whole app, not one slow code path — which fits the symptom pattern (everything is slow, not one feature).

**Confound that must not be assumed away:** the local-model work from session `local-model-bringup/4eb21996` landed in the same window as the restore change. Both are on `main`. Attribution is genuinely open, and 4.6 GB is a lot to pin on either one without measurement.

### The self-implicating hypothesis

The restore change has a known, deliberate, documented cost that plausibly drives both the memory and the lag. It was flagged before landing and is now measurable in production.

**Mechanism.** In `external_sessions.rs`, `parse_session_file` now does two things it did not do before:

1. **It buffers every record of every scan, unconditionally.** `chain_buf: Vec<Option<ChainRecord>>` and `sig_buf: Vec<Option<SigRecord>>` are pushed for every line read, before the code knows whether the EOF second pass is needed. `ChainRecord` holds two `String`s (`uuid`, `parent_uuid`). When neither trigger fires the buffer is discarded untouched — so for the common session this is pure transient allocation that did not exist before.

2. **It refuses to hand out a resumable seed whenever the second pass ran:**

   ```rust
   if needs_effective_recount { resumable = false; }
   ```

   The reasoning is sound and should be preserved unless something better replaces it: a compaction re-append block can straddle a scan boundary, and its tail is indistinguishable from ordinary linear appends, so the per-slice triggers cannot detect it. Segmenting that tail incrementally would count preserved turns a second time. But the consequence is that such a session **re-streams in full on every change**.

**Measured blast radius**, from `~/Library/Application Support/Tug/instances/release-main/sessions.db`, table `external_scan_cache` (inspect with `just db-inspect`, never a live `sqlite3`):

| rule_epoch | sessions | resumable | full re-stream |
|---|---|---|---|
| 3 (new rule) | 903 | 623 | **280** |
| 2 (stale) | 4 | 4 | 0 |

**31% of all sessions now re-stream in full on every change.** Session `4eb21996` — the one exhibiting Issue 4 — is 22 MB with 22 compaction records, so it is certainly in that set. Its JSONL is appended continuously during an active turn. Each append means: read 22 MB, parse 7,607 records, allocate ~15,000 `String`s, run the dead-branch walk, re-run segmentation. Session `8b8d7bf1` (29 MB) shows the same ledger signature: `parse_offset=0, frontier_leaf_uuid=NULL`.

**Scan trigger sites** (all now paying this cost):

- `tugrust/crates/tugcast/src/main.rs:1161` — warm scan at startup over `distinct_workspaces()`, i.e. the **entire ~1 GB / 883-session corpus**
- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs:3664` — the picker's `list_sessions` scan
- `external_sessions::engine_turn_count` (`agent_supervisor.rs:729`, called from `feeds/agent_bridge.rs:1594`) — the `replay_complete` stamp, per session open

**This hypothesis is unverified.** It has not been profiled. Before acting on it, measure: instrument allocation in `parse_session_file`, or simply time a warm scan before and after `f6f1383cf`.

### Remediation directions (none validated)

- **Cheapest correctness-preserving fix:** don't buffer until a trigger fires. The flags (`saw_compaction`, `saw_duplicate_uuid`, `saw_branch`) are known mid-stream; on first fire, re-open and re-stream with buffering on. Common sessions then allocate nothing.
- **Restore incremental resume for compacted sessions** by persisting chain state rather than bytes — e.g. a compact digest of seen uuids, or the live-chain leaf set, so a straddled re-append is detectable from the seed. This is the real fix for the 31%.
- **Bound the warm scan.** Re-streaming the whole corpus at startup was affordable when most sessions resumed from a byte offset; at 31% non-resumable it may not be.

---

## Issue 6 — `[P02]`'s "verbatim re-append" assumption is false

The plan's `[P02]` asserted that Claude Code re-appends preserved messages **verbatim** (same `uuid`, same `parentUuid`, same content), and cited session `8b8d7bf1` (669 duplicated uuids) as evidence. **That was verified on one session only.**

On session `4eb21996`, of 1,183 duplicate pairs only **370 are byte-identical** — **813 differ.** Fields that differ across pairs:

| Field | Pairs differing |
|---|---|
| `cwd` | 528 |
| `toolUseResult` | 299 |
| `gitBranch` | 226 |
| `promptId` | 150 |
| `parentUuid` | **9** |
| `message` | **3** |
| `slug` | 1 |
| `attachment` | 1 |

**`message.content` differs in 0 pairs.** So the first-occurrence rule does not drop conversational content, and Issue 4's missing content is probably not caused by this. But three of these deserve scrutiny:

- **`parentUuid` differs in 9 pairs.** The walk's correctness argument assumed both occurrences carry the same parent. They do not. Whether occurrence-aware resolution still lands correctly when the two copies disagree about their parent is **unanalyzed**.
- **`message` differs in 3 pairs** while `message.content` is identical — so `message.id`, `stop_reason`, or `role` differs. All three feed segmentation (`SigRecord`, the same-`message.id` continuation rule). Unanalyzed.
- **`toolUseResult` differs in 299 pairs.** This is the structured sidecar tugcode emits as `tool_use_structured`. Keeping the first occurrence may keep a staler payload than the re-append carries.

A concrete duplicate, for orientation — the same message written twice, 1,560 lines apart, with its original timestamp preserved:

```
uuid df71c79d-d658-4cda-a1e4-5906a9f8c1af  — at line 409 AND line 1969
  line 409:  parentUuid=da64590c…  ts=2026-07-27T15:09:24.563Z  content="<local-command-caveat>…"
  line 1969: parentUuid=da64590c…  ts=2026-07-27T15:09:24.563Z  content="<local-command-caveat>…"
```

Maximum occurrences of any single uuid across both studied sessions is **2**.

---

## Tools available for the investigation

- `tugcode dead <file-or-dir>` — emits `{basename: [dead indices]}` for the walk. New in this change.
- `tugcode segment <file-or-dir>` — emits `{basename: ["user"|"assistant", …]}`, the per-turn origin list.
- Build the binary with `bun build --compile tugcode/src/main.ts --outfile <path>`.
- `just db-inspect <name|path> ["SQL"]` — **the only safe way** to read the ledgers. Never point `sqlite3` at a live database under `~/Library/Application Support/Tug/`.
- **Each instance has its own `sessions.db`** under `~/Library/Application Support/Tug/instances/<instance-id>/`. The top-level `~/Library/Application Support/Tug/sessions.db` is *not* the running instance's ledger — reading it will show an empty `external_scan_cache` and mislead you. This cost time already.
- `tugutil host instance list` — instance ids, pids, ports.
- `tugDevLogStore` + `window.tugDevLog.getSnapshot()` (Opt-Cmd-/ opens the dev panel) for in-app state that the app-test harness cannot reach.

## Reference sessions

| Session | Size | Records | Dup pairs | Compaction records | Dead set | Engine turns |
|---|---|---|---|---|---|---|
| `8b8d7bf1-5d25-4b2d-95de-ee1ccba71d42` | 29 MB | 6,239 | 669 | 20 | empty | 68 |
| `4eb21996-9a77-4528-a854-53081ec7bc66` | 22 MB | 7,607 | 1,183 | 22 | empty | 67 |

Both live in `~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/`, outside the repo. They are private working sessions — derive fixtures with `tugcode/src/__tests__/fixtures/compact-reappend/project-session.ts` (chain topology, content clipped) or `tests/app-test/fixtures/sanitize.ts` (scrubbed real slice), never by vendoring them whole.

---

## Suggested order of attack

1. **Triage Issue 5 first.** A 4.6 GB host process makes every other observation unreliable, and it is the one actively blocking work. Establish attribution between the restore change and the local-model change before fixing anything — a `git stash`-style A/B of `f6f1383cf` on a warm scan would settle it quickly.
2. **Then Issue 4**, distinguishing "content not painted" from "content not delivered". If it is not painted, it likely folds into Issue 5.
3. **Then Issues 1–3 together.** They are plausibly one deck-side root cause around compaction-boundary seating, and Issue 1's arithmetic may fall out of Issue 3's fix.
4. **Then Issue 6**, which is a correctness review of assumptions rather than a live defect — no observed misbehavior traces to it yet, but the `parentUuid` and `message` divergences undermine a stated premise of the shipped walk.

## Rollback note

If the app needs to be usable before any of this is fixed, the restore change is a single squashed commit on `main` (`f6f1383cf`) and reverts cleanly as a unit. Reverting also un-bumps `CURRENT_RULE_EPOCH` from 3 to 2, which means every `external_scan_cache` row written under epoch 3 fails the gate and re-scans once under the old rule — correct, but a one-time cost across 903 sessions. The pre-existing dead-branch fix from `984be56b6` is **not** part of this commit and would survive a revert.
