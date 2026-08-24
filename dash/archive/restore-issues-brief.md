# Session restore issues — investigation brief

Handoff document. Two defects were found while investigating `/compact` misbehavior. The first is fixed and committed. The second is a **data-loss defect ([L23] violation)** whose fix is drafted, uncommitted, and **not yet trustworthy enough to land** — the open questions at the end are the reason this brief exists.

Written 2026-07-27. Repo state at writing: `main`, HEAD = `9b67b446c`.

---

## How we got here

The user reported a "riot of bugs" around `/compact`: the *Compacting…* sheet dismissing while the operation was still running; a completed compaction leaving no trace in the session until it was closed and reopened; and STATE stuck on "Waiting" forever afterward. That investigation found and fixed Bug 1 (below).

The user then reported a second, worse symptom on session `lens-xp / 8b8d7bf1-5d25-4b2d-95de-ee1ccba71d42`: the transcript **no longer contains the work from commit `b24bac499`** (`tugdash(pulse-display): add PULSE intent/activity gallery spike`, authored 2026-07-27 13:30:06 local / 20:30:06Z). That is Bug 2, and it is a genuine loss of user-visible state.

---

## Bug 1 — no-content turns collided on an empty `msg_id` (FIXED, committed as `31b775d1d`)

### Mechanism

A `/compact` turn streams no assistant message, so Claude never reveals a `message.id` for it. The same is true of `/model` and every other local-echo slash command. tugcode stamped the terminal frame as `turn_complete { msg_id: turn.currentMessageId ?? "" }` — i.e. `msg_id: ""`.

The deck's `handleTurnComplete` dedupes commits through `committedMsgIds`. The *first* no-content turn in a session committed under the key `""`; from then on **every subsequent no-content turn's `turn_complete` was swallowed as a duplicate**.

Real wire traffic confirming the trigger, from session `31c60766`: a `/model` at 15:09:24 (commits `""`) followed by a `/compact` at 15:09:29 (its completion eaten). Recent sessions carry 4–9 manual compactions each, so after the first no-content turn the rest were doomed.

Each reported symptom follows:

- **`/compact` invisible until reopen** — the duplicate-drop branch clears `pendingTurn` and scratch without committing, so the `/compact` row vanishes. The compaction is real in the JSONL, which is why reopening always showed it (replay reconstructs it under unique `u-<n>` ids).
- **STATE stuck "Waiting"** — moments before the drop, tugcode's synthesized `<local-command-stdout>Compacted</local-command-stdout>` echo (also riding `msg_id: ""`) advanced the phase ladder `submitting → awaiting_first_token`. The drop branch cleared the turn but never reset `phase`, so the card sat at "Waiting" with no further wire traffic able to move it.
- **Sheet dismissing mid-compact** — the sheet's watcher settles at the `activeTurn → null` transition, which the drop causes.

Side effect also closed: tugcast's `turn_telemetry` table is keyed `(session_id, msg_id)`, so every no-content turn was UPSERT-overwriting the previous one's row.

### Fix as landed

- **tugcode `session.ts`** — every `ActiveTurn` mints `openerId = "t-<seq>"` (namespace disjoint from Claude's `msg_*` and from the replay translator's `u-` / `w-` / `a-` openers). All terminal frames (`turn_complete`, `turn_cancelled`, the mid-turn replay snapshot) fall back to it instead of `""`. `EventMappingContext` gained an `openerId` field so the synthesized local-command stdout echo rides the same id, keeping the reducer's `activeMsgId` matched to the terminal frame.
- **tugdeck `reducer.ts`** — `""` is no longer treated as an identity: never deduped on, never entered into `committedMsgIds`. A genuine duplicate drop now also normalizes a live in-flight phase back to `idle` (replay/wake brackets keep owning their own exits).
- Tests: `tugcode/src/__tests__/session.test.ts` (opener-id minting, local-command-only turn, content-bearing regression guard) and `tugdeck/src/lib/code-session-store/__tests__/reducer.no-content-dedupe.test.ts`.

### Verification performed

793 tugcode tests, 4,946 tugdeck tests, `tsc` clean, `bunx vite build` clean, `just app-test-changed` 13/13 green (including `at0106-compact-boundary-divider`, `at0193-compact-native-reload`, `at0239-compact-summary-inline`).

**This one is believed sound.** Note it only takes effect for sessions opened after a tugcode restart, since running sessions keep their existing tugcode process.

---

## Bug 2 — compaction re-appends make dead-branch detection eat live history (DRAFTED, UNCOMMITTED, NEEDS REVIEW)

### The symptom, verified on disk

The work from commit `b24bac499` **is present in the JSONL** — `8b8d7bf1-…jsonl` lines 4501–4703, timestamps 19:04–20:29Z. Nothing was truncated on disk. The loss happens in tugcode's replay translator, which classifies those entries as a dead branch and skips them.

Measured by driving the real `translateJsonlSession` over the real 22 MB file:

| | before fix | after fix |
|---|---|---|
| turns emitted | 43 | 63 |
| frames | 4,926 | 6,469 |
| frames mentioning `gallery-pulse-display` | **1** (of 39 on disk) | 42 |
| `compact_summary` frames | 8 (of 9 boundaries) | 9 |
| entries marked dead | **980 of 5,082** | 0 |

Translate time is ~60 ms for the 22 MB file, so `REPLAY_HARD_TIMEOUT_MS` (10 s) is **ruled out** as a contributor.

### Root cause

`computeDeadEntryIndices` (`tugcode/src/replay.ts`) computes the live set as the ancestor closure of the newest leaf, walking `parentUuid` upward and bridging backwards across `/compact` chain breaks. Everything off that closure that roots at a live-parented user submission is swept as an abandoned branch.

The walk rests on an unstated invariant: **a parent always precedes its child in file order.** Claude Code's compaction breaks it. When it compacts, it re-appends the compaction's *preserved messages* verbatim — **same `uuid`, later file position**. Session `8b8d7bf1` has 669 uuids that appear more than once; the block at lines 4706–5065 is a verbatim re-append of lines 3873–4382, including a duplicate `compact_boundary` record carrying the earlier compaction's original timestamp and metadata.

The index was built last-wins:

```ts
indexByUuid.set(entry.uuid, i);   // later duplicate overwrites the original
```

so a `parentUuid` could resolve **forward** into the re-appended copy. Traced on the real file:

```
segment 1: start=5077 root=5066 steps=12  rootType=system/compact_boundary  → bridge to 5065
segment 2: start=5065 root=4704 steps=362 rootType=system/compact_boundary  → bridge to 4698
segment 3: start=4698 root=4383 steps=220 rootType=assistant  stoppedOnAlreadyLive=true
   !! at idx 4383: parentUuid resolves FORWARD to 5065 (duplicate-uuid last-wins)
   NO BRIDGE (root is not a compaction record) -> live walk ENDS

live size: 594 of 4085 chain entries
```

Segment 3 starts inside the most recent work, walks up, and at index 4383 teleports forward into the already-live re-appended block. The loop's `!live.has(walk)` guard fires immediately and the walk stops. The segment root is left as an ordinary `assistant` record rather than a compaction record, so **no bridge fires and the entire live walk terminates** with 3,491 of 4,085 chain entries never visited. The dead-roots pass then sweeps 980 of them — all of the most recent day's work — as abandoned branches.

The correlation is exact: only heavily-compacted sessions are affected.

### Corpus impact (894 sessions scanned)

| session | entries | dead before | dead after | rescued |
|---|---|---|---|---|
| `29e49a13` | 11,496 | 5,171 | 1 | 5,170 (45% of the session) |
| `130fec67` | 7,160 | 2,250 | 1 | 2,249 |
| `0744463c` | 2,394 | 1,116 | 0 | 1,116 |
| `8b8d7bf1` | 5,081 | 980 | 0 | 980 |
| `31c60766` | 3,902 | 931 | 0 | 931 |

**5 sessions affected, 10,446 entries silently dropped from replay.**

### Drafted fix (uncommitted — `M tugcode/src/replay.ts`, ~59 lines)

Replace the last-wins `indexByUuid` with `occurrencesByUuid: Map<string, number[]>` (all positions, ascending) plus a `resolveParent(childIndex, parentUuid)` helper that binary-searches for the newest occurrence **strictly before** the child, returning `undefined` when the uuid is unknown or appears only later. Applied at three sites:

1. the live ancestor walk;
2. the dead-roots seeding test (`parentIndex` must be live);
3. the dead-set BFS child expansion, which additionally now skips children whose `resolveParent` does not point at *this* occurrence — `childIndices` is keyed by uuid, so a re-appended duplicate's children were otherwise pooled with the original's.

The function's doc comment was extended to state the append-only invariant and record this failure mode.

### Verification performed so far

- 793 tugcode tests pass (includes `replay-dead-branch.test.ts`, `replay-compact-native.test.ts`, `rewind-bridge.test.ts`).
- Dead-branch detection still fires corpus-wide: 7 sessions retain small dead sets (1–4 entries each — the genuine rewind/REPL-escape shape).
- A fixture was generated at `tugcode/src/__tests__/fixtures/compact-reappend/chain-topology.jsonl` (untracked, 1,211 records, 222 KB) — **see open question 5, its provenance needs a decision.** No test consumes it yet.

---

## Open questions — resolve these BEFORE landing Bug 2's fix

1. **Duplicate turns are now emitted.** Post-fix the translator emits 63 `turn_complete` frames with only 59 distinct `msg_id`s — the re-appended block replays 4 turns a second time. Today the deck's `committedMsgIds` dedupe suppresses the duplicate rows, so the transcript looks right, but that is an accident of ordering rather than a designed behavior. Decide whether the translator should recognize and skip a compaction re-append outright. Related: one of the duplicated ids (`32524404-…`) is uuid-shaped, i.e. a user-origin opener, not an `msg_*`.

2. **Is `dead = 0` actually correct for the five affected sessions?** This is the largest knowledge gap in the Bug 2 work, and it is an *unfalsified* result rather than a verified one.

   What was actually established: the rescued entries are the user's real work (checked by content — the `gallery-pulse-display` records), and dead-branch detection still fires corpus-wide (7 sessions retain 1–4 dead entries each, the genuine rewind/REPL-escape shape). What was **not** established: that the five affected sessions contain no genuine dead branch that *should* still be suppressed. `dead = 0` was read as success because the number moved in the direction that restored the missing work — which is exactly the reasoning that would also hide an over-correction.

   Why it matters: the failure mode is symmetric and equally bad. Under-suppression replays abandoned branches as phantom turns — a rewound-away exchange reappearing in the transcript as if it had happened, which is a correctness bug against the same law ([L23]) the fix is meant to serve, just pointed the other way. Because `resolveParent` returns `undefined` for a forward-only parent, a dead root whose parent link now fails to resolve is silently *not* seeded into the BFS (the seeding test requires `parentIndex !== undefined && live.has(parentIndex)`), so an over-correction would present as exactly this: dead sets quietly collapsing toward zero.

   How to close it, in increasing order of confidence:
   - Diff the *pre-fix* dead set against the post-fix one on the five sessions and inspect what left the set. The rescued entries should be one contiguous run of genuine recent work per session; anything that looks like an abandoned branch (a user submission whose successor parents to an *ancestor* of it, bypassing it) leaving the dead set is a red flag.
   - Construct the adversarial case the corpus lacks: a session with a real `/rewind` **and** heavy compaction, so a genuine dead branch and a compaction re-append coexist. No session in the 894-session corpus is known to have both, which is precisely why the current evidence cannot distinguish "fixed" from "over-corrected." Build it against a real Claude Code session rather than a hand-authored JSONL.
   - Assert the invariant directly rather than by entry count: for every index in the dead set, its `resolveParent` target is live and it is not an ancestor of the newest leaf; and for every entry *not* dead, it is reachable from the newest leaf through the bridged walk. That turns a numeric smell test into a property.

3. **Rust parity contract.** `segmentJsonlOrigins` (`tugcode/src/replay.ts`, exposed via `tugcode/src/main.ts`) is the TS half of a real-corpus contract asserting per-turn origin agreement with `tugcast/src/turn_engine.rs`. A grep found no dead-branch equivalent on the Rust side, which means the two halves may already disagree, and changing the TS turn count from 43 to 63 on a real session will move whatever the contract measures. **This was not investigated.** Check `turn_engine.rs`, `external_sessions.rs` (its `is_non_submission_user_string` / `user_submission_opens_turn` / "file GROWS but prefix changed" logic), and `session_ledger.rs`, and run the Rust suite (`cd tugrust && cargo nextest run`) — which has **not been run** against this change.

4. **Does the same last-wins assumption exist elsewhere?** Any other code keyed by JSONL `uuid` inherits the same trap now that duplicates are known to be routine — notably the Rust turn engine and ledger, and tugcode's own rewind-anchor handling (`computeConversationTruncation`, the `/rewind` barrier logic). The `retract: true` path *truncates the JSONL at the prompt record*, so a uuid resolved to the wrong occurrence there would be destructive rather than merely lossy. **This is the highest-risk unexamined area.**

5. **Fixture provenance.** The generated fixture preserves real uuids, real parent links, real record kinds and real file order, but each record was projected down to the fields `computeDeadEntryIndices` reads and long content strings were clipped — because the smallest affected real session is 7.8 MB and the source here is 21.6 MB. Decide whether that projection is acceptable or whether a genuine contiguous slice should be vendored instead. No regression test has been written yet.

6. **No app-test run** for the Bug 2 change, and no verification in the running app that an affected session now restores completely.

---

## Reproduction recipe

Affected sessions live in `/Users/kocienda/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/`. Throwaway probes used during the investigation (regenerate as needed; they import the real translator by absolute path and are not part of the repo):

- `/tmp/probe-replay-8b8.ts` — runs `translateJsonlSession` over a session, reports turns/frames/frame-type histogram and how many frames mention `gallery-pulse-display`.
- `/tmp/probe-dead-8b8.ts` — runs `computeDeadEntryIndices`, prints contiguous dead ranges with timestamps and which of the target entries are dead.
- `/tmp/probe-walk-8b8.ts` — traces the live walk segment by segment and flags the first forward-resolving `parentUuid`. This is the probe that localized the bug.
- `/tmp/probe-corpus.ts` — sweeps every session with the pre-fix algorithm inlined alongside the current one and diffs the dead sets.
- `/tmp/probe-still-detects.ts` — confirms dead-branch detection still fires corpus-wide.

`translateJsonlSession` takes `{ kind: "ok", jsonl: <whole file text>, claudeSessionId }` — not a `lines` array.
