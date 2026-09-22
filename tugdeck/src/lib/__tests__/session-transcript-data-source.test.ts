/**
 * session-transcript-data-source.test.ts — pin the invariants of the
 * substrate-aware row layout. Under [D07] the data source projects:
 *   - 1 row per wake turn (no `user_message` Message at head → assistant row only)
 *   - 2 rows per normal turn (user + assistant)
 *   - +1 row per in-flight turn (1 if wake, 2 if normal)
 *   - +1 row per queued send (ghost)
 *
 * The previous test file pinned the OLD substrate shape extensively
 * (`turn.userMessage.text`, `snap.activeTurn`, etc.) — those
 * pins were rewritten here to assert the substrate's behavior through
 * the data-source's public surface (kindForIndex / idForIndex / rowAt
 * / numberOfItems / buildRowLayout). Internal helpers
 * (`assistantRowIndexForTurn` / `userRowIndexForTurn`) are pinned
 * because the Z2 popovers route scroll clicks through them.
 */

import { describe, expect, test } from "bun:test";

import {
  SessionTranscriptDataSource,
  assistantRowIndexForTurn,
  buildRowLayout,
  userRowIndexForTurn,
  sameTranscriptRowData,
} from "@/lib/session-transcript-data-source";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type {
  ActiveTurnSnapshot,
  CodeSessionSnapshot,
  QueuedSend,
  TurnEntry,
} from "@/lib/code-session-store";

import {
  assistantText,
  turnEntry,
  userMessage,
} from "../code-session-store/__tests__/_helpers/messages";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function normalTurn(turnKey: string, userText: string, assistantTextBody: string): TurnEntry {
  return turnEntry({
    turnKey,
    msgId: `msg-${turnKey}`,
    messages: [
      userMessage({ turnKey, text: userText }),
      assistantText({ msgId: `msg-${turnKey}`, blockIndex: 0, text: assistantTextBody }),
    ],
  });
}

function wakeTurn(turnKey: string, assistantTextBody: string): TurnEntry {
  return turnEntry({
    turnKey,
    msgId: `msg-${turnKey}`,
    messages: [
      assistantText({ msgId: `msg-${turnKey}`, blockIndex: 0, text: assistantTextBody }),
    ],
  });
}

/**
 * A turn that merged a steered mid-turn message: `[user, assistant, user,
 * assistant]`. The second `user_message` carries its own queue-time
 * turnKey ("S") so its messageKey is distinct from the host opener's.
 */
function mergedTurn(hostKey: string, steerKey: string): TurnEntry {
  return turnEntry({
    turnKey: hostKey,
    msgId: `msg-${hostKey}`,
    origin: "user",
    messages: [
      userMessage({ turnKey: hostKey, text: "first" }),
      assistantText({ msgId: `msg-${hostKey}`, blockIndex: 0, text: "answer one" }),
      userMessage({ turnKey: steerKey, text: "steered" }),
      assistantText({ msgId: `msg-${hostKey}`, blockIndex: 1, text: "answer two" }),
    ],
  });
}

/**
 * A `shell`-origin turn — one `shell_exchange` Message, the whole turn ([P06]).
 * `startedAt` is the exchange's start, which is also the turn's sort key against
 * pending submissions.
 */
function shellTurn(turnKey: string, command: string, startedAt = 0, output = ""): TurnEntry {
  return turnEntry({
    turnKey,
    msgId: `msg-${turnKey}`,
    origin: "shell",
    messages: [
      {
        kind: "shell_exchange",
        messageKey: `shell-${turnKey}`,
        createdAt: startedAt,
        exchangeId: turnKey,
        command,
        output,
        exitCode: 0,
        cwd: "/tmp",
        cwdAfter: "/tmp",
        startedAtMs: startedAt,
        settledAtMs: startedAt + 1,
      },
    ],
  });
}

function activeTurn(args: {
  turnKey: string;
  isWake: boolean;
  withText?: string;
  submitAt?: number;
}): ActiveTurnSnapshot {
  const messages: import("@/lib/code-session-store").Message[] = [];
  if (!args.isWake) {
    messages.push(userMessage({ turnKey: args.turnKey, text: args.withText ?? "" }));
  }
  if (args.withText !== undefined && args.isWake) {
    messages.push(assistantText({ msgId: "live", blockIndex: 0, text: args.withText }));
  }
  return {
    turnKey: args.turnKey,
    submitAt: args.submitAt ?? 0,
    origin: args.isWake ? "assistant" : "user",
    suppressed: false,
    messages,
  };
}

function snapshotWith(args: {
  transcript?: ReadonlyArray<TurnEntry>;
  activeTurn?: ActiveTurnSnapshot | null;
  queuedSends?: ReadonlyArray<QueuedSend>;
}): CodeSessionSnapshot {
  return {
    phase: "idle",
    transportState: "online",
    interruptInFlight: false,
    stopStalled: false,
    streamStalled: false,
    tugSessionId: "s",
    displayLabel: "test",
    sessionMode: "new",
    restoreWindowTurns: 25,
    activeMsgId: null,
    canSubmit: true,
    canInterrupt: false,
    pendingApproval: null,
    pendingAsk: null,
    pendingQuestion: null,
    queuedSends: args.queuedSends ?? [],
    transcript: args.transcript ?? [],
    rewindPreviews: new Map(),
    lastRewindResult: null,
    activeTurn: args.activeTurn ?? null,
    pendingDraftRestore: null,
    pendingCommandInsert: null,
    pendingJotInsert: null,
    pendingAtomInsert: null,
    pendingFileInsert: null,
    lastCost: null,
    apiRetry: null,
    refusalFallback: null,
    outputTruncated: false,
    unknownEvent: null,
    compactionSeed: null,
    permissionDenials: [],
    sessionInitTokens: null,
    lastContextBreakdown: null,
    lastError: null,
    lastReplayResult: null,
    replayEverCompleted: false,
    replayWindow: null,
    sessionCreatedAtMs: null,
    loadingPrevious: false,
    loadingPreviousTarget: 0,
    loadingPreviousLoaded: 0,
    replayPreflightActive: false,
    replaySoftBudgetElapsed: false,
    replayTimeoutDwellActive: false,
    awaitingApprovalIntervals: [],
    awaitingApprovalSegmentStartedAt: null,
    transportDowntimeIntervals: [],
    transportDowntimeSegmentStartedAt: null,
    interruptInFlightIntervals: [],
    wakeTrigger: null,
    jobs: [],
    goal: null,
    interruptInFlightSegmentStartedAt: null,
  };
}

function storeWith(snap: CodeSessionSnapshot): CodeSessionStore {
  return {
    getSnapshot: () => snap,
    subscribe: () => () => {},
    streamingDocument: { get: () => undefined, observe: () => () => {} },
  } as unknown as CodeSessionStore;
}

// ---------------------------------------------------------------------------
// Layout invariants
// ---------------------------------------------------------------------------

describe("[D07] row layout: variable rows per turn driven by user_message presence", () => {
  test("empty snapshot has zero rows", () => {
    const layout = buildRowLayout(snapshotWith({}));
    expect(layout.totalRows).toBe(0);
  });

  test("normal committed turn contributes 2 rows; wake turn contributes 1", () => {
    const layout = buildRowLayout(
      snapshotWith({
        transcript: [
          normalTurn("t1", "hi", "hello"),
          wakeTurn("t2", "monitor fired"),
          normalTurn("t3", "x", "y"),
        ],
      }),
    );
    expect(layout.totalRows).toBe(2 + 1 + 2);
    expect(layout.turnRowCount).toEqual([2, 1, 2]);
    expect(layout.turnStartRow).toEqual([0, 2, 3]);
  });

  test("in-flight normal turn adds 2 rows; in-flight wake adds 1", () => {
    // A wake in-flight turn (no user_message) still gets a trailing
    // assistant row even before any assistant Message has streamed.
    const wakeLayout = buildRowLayout(
      snapshotWith({
        activeTurn: activeTurn({ turnKey: "live", isWake: true }),
      }),
    );
    expect(wakeLayout.totalRows).toBe(1);
    expect(wakeLayout.slots.map((s) => s.cellKind)).toEqual(["assistant"]);

    // A normal in-flight turn with only its head user_message so far
    // still shows the forthcoming assistant row (user + assistant).
    const normalLayout = buildRowLayout(
      snapshotWith({
        activeTurn: activeTurn({ turnKey: "live", isWake: false, withText: "x" }),
      }),
    );
    expect(normalLayout.totalRows).toBe(2);
    expect(normalLayout.slots.map((s) => s.cellKind)).toEqual([
      "user",
      "assistant",
    ]);
  });

  test("merged turn (user, assistant, user, assistant) yields 4 rows in order", () => {
    // A steered/merged mid-turn message lands as a second `user_message`
    // partway through the turn's `messages` (see {@link mergedTurn}).
    const merged = mergedTurn("T", "S");
    const layout = buildRowLayout(snapshotWith({ transcript: [merged] }));
    expect(layout.totalRows).toBe(4);
    expect(layout.turnRowCount).toEqual([4]);
    expect(layout.slots.map((s) => s.cellKind)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    const ds = new SessionTranscriptDataSource(
      storeWith(snapshotWith({ transcript: [merged] })),
    );
    // Each user row keys by its own messageKey; the head is `${turnKey}-user`,
    // the merged row keeps its distinct queue-time key ([P04]).
    expect(ds.idForIndex(0)).toBe("T-user");
    expect(ds.idForIndex(2)).toBe("S-user");
    // The first assistant run keeps `${turnKey}-assistant`; the second
    // (after the merge) is `${turnKey}-assistant-1`, stable under append.
    expect(ds.idForIndex(1)).toBe("T-assistant");
    expect(ds.idForIndex(3)).toBe("T-assistant-1");
  });

  test("within-turn ordinals: durable badge sub-address for a merged turn ([P09])", () => {
    // rows: user(opener), assistant(run0), user(steer), assistant(run1).
    // The within-turn per-kind ordinal is the second, durable component of
    // the badge — derived from the turn's own fixed message order, so it is
    // stable across reopen/paging (it never depends on the loaded window).
    const layout = buildRowLayout(
      snapshotWith({ transcript: [mergedTurn("T", "S")] }),
    );
    expect(layout.slots.map((s) => s.userRowOrdinal)).toEqual([0, -1, 1, -1]);
    expect(layout.slots.map((s) => s.assistantRunOrdinal)).toEqual([
      -1, 0, -1, 1,
    ]);

    const ds = new SessionTranscriptDataSource(
      storeWith(snapshotWith({ transcript: [mergedTurn("T", "S")] })),
    );
    // user→userRowOrdinal, assistant→assistantRunOrdinal. With turn 1 this
    // renders #u1, #a1, #u1.2, #a1.2 (opener has no suffix; steer gets .2).
    expect([0, 1, 2, 3].map((i) => ds.withinTurnOrdinalForRow(i))).toEqual([
      0, 0, 1, 1,
    ]);
  });

  test("normal turn: within-turn ordinal is 0 (badge shows no suffix)", () => {
    const ds = new SessionTranscriptDataSource(
      storeWith(snapshotWith({ transcript: [normalTurn("T", "hi", "yo")] })),
    );
    expect(ds.withinTurnOrdinalForRow(0)).toBe(0); // user row
    expect(ds.withinTurnOrdinalForRow(1)).toBe(0); // assistant row
  });

  test("shell rows carry a session-wide 1-based counter, independent of Claude turns", () => {
    // Interleave: normal turn, shell, normal turn, shell. The shell rows
    // count #s1, #s2 as their own sequence — the Claude turns between them
    // don't advance (or reset) the shell counter, and non-shell rows carry 0.
    const transcript = [
      normalTurn("t1", "hi", "yo"),
      shellTurn("s1", "ls"),
      normalTurn("t2", "again", "sure"),
      shellTurn("s2", "pwd"),
    ];
    const layout = buildRowLayout(snapshotWith({ transcript }));
    // rows: user, assistant, shell, user, assistant, shell
    expect(layout.slots.map((s) => s.cellKind)).toEqual([
      "user",
      "assistant",
      "shell",
      "user",
      "assistant",
      "shell",
    ]);
    expect(layout.slots.map((s) => s.shellRowOrdinal)).toEqual([0, 0, 1, 0, 0, 2]);

    const ds = new SessionTranscriptDataSource(storeWith(snapshotWith({ transcript })));
    expect(ds.shellOrdinalForRow(2)).toBe(1); // first shell row → #s1
    expect(ds.shellOrdinalForRow(5)).toBe(2); // second shell row → #s2
    expect(ds.shellOrdinalForRow(0)).toBe(0); // a user row carries no shell number
  });

  test("queued sends add one ghost row each at the tail", () => {
    const layout = buildRowLayout(
      snapshotWith({
        transcript: [normalTurn("t1", "x", "y")],
        queuedSends: [
          { turnKey: "q1", text: "queued", atoms: [], origin: "user", queuedAt: 10, held: false },
          { turnKey: "q2", text: "another", atoms: [], origin: "user", queuedAt: 11, held: false },
        ],
      }),
    );
    expect(layout.totalRows).toBe(2 + 2);
    expect(layout.ghostStartRow).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Shell rows vs pending submissions ([D111])
// ---------------------------------------------------------------------------

describe("trailing shell rows merge into the pending block by timestamp", () => {
  test("an exchange run AFTER the submit paints below the in-flight turn", () => {
    // The user submits at 50, then runs `$ ls` at 100. The exchange commits
    // to the transcript immediately while their message is still in flight —
    // a plain append would paint the shell row above the message they had
    // already sent.
    const layout = buildRowLayout(
      snapshotWith({
        transcript: [normalTurn("t1", "hi", "yo"), shellTurn("s1", "ls", 100)],
        activeTurn: activeTurn({ turnKey: "L", isWake: false, withText: "go", submitAt: 50 }),
      }),
    );
    expect(layout.slots.map((s) => s.cellKind)).toEqual([
      "user",
      "assistant",
      "user", // ← the in-flight submission
      "assistant",
      "shell", // ← the exchange the user ran after it
    ]);
    expect(layout.activeStartRow).toBe(2);
    // The moved turn's start row is patched, so turn-anchored scrolls land.
    expect(layout.turnStartRow[1]).toBe(4);
    // Ordinals survive the move — shell rows never reorder among themselves.
    expect(layout.slots[4].shellRowOrdinal).toBe(1);
  });

  test("an exchange run BEFORE the submit stays above it", () => {
    const layout = buildRowLayout(
      snapshotWith({
        transcript: [normalTurn("t1", "hi", "yo"), shellTurn("s1", "ls", 10)],
        activeTurn: activeTurn({ turnKey: "L", isWake: false, withText: "go", submitAt: 50 }),
      }),
    );
    expect(layout.slots.map((s) => s.cellKind)).toEqual([
      "user",
      "assistant",
      "shell",
      "user",
      "assistant",
    ]);
    expect(layout.activeStartRow).toBe(3);
    expect(layout.turnStartRow[1]).toBe(2);
  });

  test("the merge splits a run of exchanges around the submissions they bracket", () => {
    // s1 at 20 (before the in-flight submit at 50), s2 at 70 (after it, but
    // before the queued send at 90), s3 at 120 (after everything).
    const layout = buildRowLayout(
      snapshotWith({
        transcript: [
          normalTurn("t1", "hi", "yo"),
          shellTurn("s1", "ls", 20),
          shellTurn("s2", "pwd", 70),
          shellTurn("s3", "date", 120),
        ],
        activeTurn: activeTurn({ turnKey: "L", isWake: false, withText: "go", submitAt: 50 }),
        queuedSends: [{ turnKey: "Q", text: "later", atoms: [], origin: "user", queuedAt: 90, held: false }],
      }),
    );
    expect(layout.slots.map((s) => s.cellKind)).toEqual([
      "user",
      "assistant",
      "shell", // s1 — ran before the submit
      "user", // in-flight submission
      "assistant",
      "shell", // s2 — ran during the turn
      "ghost", // queued send
      "shell", // s3 — ran after the queued send
    ]);
    expect(layout.activeStartRow).toBe(3);
    expect(layout.ghostStartRow).toBe(6);
    expect(layout.slots.map((s) => s.shellRowOrdinal)).toEqual([0, 0, 1, 0, 0, 2, 0, 3]);
    expect(layout.turnStartRow).toEqual([0, 2, 5, 7]);
  });

  test("a suppressed in-flight turn holds no position — shell rows stay put", () => {
    const active = activeTurn({ turnKey: "L", isWake: false, withText: "go", submitAt: 50 });
    const layout = buildRowLayout(
      snapshotWith({
        transcript: [shellTurn("s1", "ls", 100)],
        activeTurn: { ...active, suppressed: true },
      }),
    );
    expect(layout.slots.map((s) => s.cellKind)).toEqual(["shell"]);
    expect(layout.activeStartRow).toBe(-1);
  });

  test("a non-shell turn stops the walk — committed Claude turns never move", () => {
    // Only the TRAILING shell run is eligible. A shell row buried behind a
    // committed Claude turn stays where the reducer seated it, whatever its
    // timestamp says.
    const layout = buildRowLayout(
      snapshotWith({
        transcript: [shellTurn("s1", "ls", 100), normalTurn("t1", "hi", "yo")],
        activeTurn: activeTurn({ turnKey: "L", isWake: false, withText: "go", submitAt: 50 }),
      }),
    );
    expect(layout.slots.map((s) => s.cellKind)).toEqual([
      "shell",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(layout.activeStartRow).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// idForIndex stability across inflight → committed
// ---------------------------------------------------------------------------

describe("[L26] idForIndex stability: `${turnKey}-{user,assistant}` survives inflight → committed", () => {
  test("normal turn: inflight ids match the committed pair's ids", () => {
    const liveSnap = snapshotWith({
      activeTurn: activeTurn({ turnKey: "T", isWake: false, withText: "hi" }),
    });
    const ds = new SessionTranscriptDataSource(storeWith(liveSnap));
    expect(ds.idForIndex(0)).toBe("T-user");
    expect(ds.idForIndex(1)).toBe("T-assistant");

    const committedSnap = snapshotWith({
      transcript: [normalTurn("T", "hi", "hello")],
    });
    const ds2 = new SessionTranscriptDataSource(storeWith(committedSnap));
    expect(ds2.idForIndex(0)).toBe("T-user");
    expect(ds2.idForIndex(1)).toBe("T-assistant");
  });

  test("wake turn: only `${turnKey}-assistant` is ever minted (no -user key)", () => {
    const liveSnap = snapshotWith({
      activeTurn: activeTurn({ turnKey: "W", isWake: true, withText: "wake" }),
    });
    const ds = new SessionTranscriptDataSource(storeWith(liveSnap));
    expect(ds.numberOfItems()).toBe(1);
    expect(ds.idForIndex(0)).toBe("W-assistant");

    const committedSnap = snapshotWith({ transcript: [wakeTurn("W", "wake")] });
    const ds2 = new SessionTranscriptDataSource(storeWith(committedSnap));
    expect(ds2.numberOfItems()).toBe(1);
    expect(ds2.idForIndex(0)).toBe("W-assistant");
  });
});

// ---------------------------------------------------------------------------
// Row descriptors expose committed turn / active turn / queued send
// ---------------------------------------------------------------------------

describe("layout memo: committed walk keyed on transcript identity", () => {
  test("a fresh snapshot with the SAME transcript ref still sees new in-flight/ghost rows", () => {
    // The streaming-delta shape: every delta replaces the snapshot
    // object while `transcript` keeps its identity (turns commit only
    // at turn_complete). The committed walk memoizes on the transcript
    // ref, so the tail (in-flight + ghosts) must still recompute per
    // snapshot — a stale memo here would freeze the active turn's rows.
    const transcript = [normalTurn("T", "hello", "world")];
    const holder = { snap: snapshotWith({ transcript }) };
    const ds = new SessionTranscriptDataSource({
      getSnapshot: () => holder.snap,
      subscribe: () => () => {},
      streamingDocument: { get: () => undefined, observe: () => () => {} },
    } as unknown as CodeSessionStore);
    expect(ds.numberOfItems()).toBe(2);

    const active = activeTurn({ turnKey: "L", isWake: false, withText: "hi" });
    holder.snap = snapshotWith({ transcript, activeTurn: active });
    expect(ds.numberOfItems()).toBe(4);
    expect(ds.rowAt(2).activeTurn).toBe(active);
    // Committed rows are untouched by the tail recompute.
    expect(ds.rowAt(0).turn?.turnKey).toBe("T");

    // A new transcript ref (turn_complete) rebuilds the committed walk.
    const grown = [...transcript, normalTurn("U", "again", "sure")];
    holder.snap = snapshotWith({ transcript: grown });
    expect(ds.numberOfItems()).toBe(4);
    expect(ds.rowAt(2).turn?.turnKey).toBe("U");
  });
});

describe("rowAt produces a descriptor consumers can narrow on", () => {
  test("normal committed: row 0 is `user` with turn payload; row 1 is `assistant`", () => {
    const snap = snapshotWith({
      transcript: [normalTurn("T", "hello", "world")],
    });
    const ds = new SessionTranscriptDataSource(storeWith(snap));
    expect(ds.kindForIndex(0)).toBe("user");
    expect(ds.kindForIndex(1)).toBe("assistant");
    expect(ds.rowAt(0).turn?.turnKey).toBe("T");
    expect(ds.rowAt(1).turn?.turnKey).toBe("T");
  });

  test("in-flight normal: row 0 is `user` carrying activeTurn; row 1 is `assistant`", () => {
    const active = activeTurn({ turnKey: "L", isWake: false, withText: "hi" });
    const snap = snapshotWith({ activeTurn: active });
    const ds = new SessionTranscriptDataSource(storeWith(snap));
    expect(ds.kindForIndex(0)).toBe("user");
    expect(ds.kindForIndex(1)).toBe("assistant");
    expect(ds.rowAt(0).activeTurn).toBe(active);
    expect(ds.rowAt(1).activeTurn).toBe(active);
  });

  test("merged turn: user/assistant descriptors carry their own message + slice; badge anchors to the last run", () => {
    const ds = new SessionTranscriptDataSource(
      storeWith(snapshotWith({ transcript: [mergedTurn("T", "S")] })),
    );
    // Rows in arrival order: user, assistant(run 0), user, assistant(run 1).
    expect([0, 1, 2, 3].map((i) => ds.kindForIndex(i))).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    // Each user row resolves the specific `user_message` it renders — the
    // opener, then the merged/steered message — never `messages[0]`.
    expect(ds.rowAt(0).userMessage?.text).toBe("first");
    expect(ds.rowAt(0).userMessage?.messageKey).toBe("T-user");
    expect(ds.rowAt(2).userMessage?.text).toBe("steered");
    expect(ds.rowAt(2).userMessage?.messageKey).toBe("S-user");

    // Each assistant row carries the half-open slice of its run.
    const a0 = ds.rowAt(1);
    expect([a0.messageStart, a0.messageEnd]).toEqual([1, 2]);
    const a1 = ds.rowAt(3);
    expect([a1.messageStart, a1.messageEnd]).toEqual([3, 4]);

    // The per-turn end-state anchor (badge + Z1B) rides only the last run.
    expect(a0.isLastAssistantOfTurn).toBe(false);
    expect(a1.isLastAssistantOfTurn).toBe(true);
    expect(a0.perTurnTokens).toBeUndefined();
    expect(typeof a1.perTurnTokens).toBe("number");
  });

  test("ghost: a queued send produces a `ghost` row with the queued payload", () => {
    const snap = snapshotWith({
      queuedSends: [{ turnKey: "Q", text: "later", atoms: [], origin: "user", queuedAt: 10, held: false }],
    });
    const ds = new SessionTranscriptDataSource(storeWith(snap));
    expect(ds.numberOfItems()).toBe(1);
    expect(ds.kindForIndex(0)).toBe("ghost");
    const row = ds.rowAt(0);
    expect(row.kind).toBe("ghost");
    expect(row.queued?.text).toBe("later");
  });
});

// ---------------------------------------------------------------------------
// Per-turn row index helpers (consumed by Z2 popover scroll-to-row)
// ---------------------------------------------------------------------------

describe("userRowIndexForTurn / assistantRowIndexForTurn", () => {
  test("normal-only transcript: alternating user/assistant row indices", () => {
    const transcript: TurnEntry[] = [
      normalTurn("t1", "a", "A"),
      normalTurn("t2", "b", "B"),
    ];
    expect(userRowIndexForTurn(0, transcript)).toBe(0);
    expect(assistantRowIndexForTurn(0, transcript)).toBe(1);
    expect(userRowIndexForTurn(1, transcript)).toBe(2);
    expect(assistantRowIndexForTurn(1, transcript)).toBe(3);
  });

  test("merged turn: user index is the opener (first user row), assistant index is the LAST run", () => {
    // [u(0), a(1), u(2), a(3)] — the per-turn telemetry anchor ([P02]) is the
    // bracket's last assistant row (3), and the addressable `#u` is the opener
    // (0). The merged mid-turn user row (2) is not separately addressed ([P05]).
    const transcript: TurnEntry[] = [mergedTurn("T", "S")];
    expect(userRowIndexForTurn(0, transcript)).toBe(0);
    expect(assistantRowIndexForTurn(0, transcript)).toBe(3);
  });

  test("merged turn followed by a normal turn: addresses stay turn-numbered (#u1/#a1, #u2/#a2)", () => {
    // The popover derives `#u{turn}`/`#a{turn}` from these row indices plus
    // the turn number (`base + turnIndex + 1`); the labels read #u1/#a1 for
    // the merged turn 1 and #u2/#a2 for turn 2 — the merged turn's extra user
    // row does not renumber anything (Risk R01 — labels kept).
    const transcript: TurnEntry[] = [
      mergedTurn("T", "S"), // turn 1 → rows 0,1,2,3
      normalTurn("t2", "b", "B"), // turn 2 → rows 4,5
    ];
    // turn 1 (#u1 opener row 0, #a1 anchor row 3)
    expect(userRowIndexForTurn(0, transcript)).toBe(0);
    expect(assistantRowIndexForTurn(0, transcript)).toBe(3);
    // turn 2 (#u2 row 4, #a2 row 5)
    expect(userRowIndexForTurn(1, transcript)).toBe(4);
    expect(assistantRowIndexForTurn(1, transcript)).toBe(5);
  });

  test("wake turn: no user row (#a1 only) — userRowIndexForTurn returns -1", () => {
    const transcript: TurnEntry[] = [wakeTurn("w1", "Wake")];
    expect(userRowIndexForTurn(0, transcript)).toBe(-1);
    expect(assistantRowIndexForTurn(0, transcript)).toBe(0);
  });

  test("wake-in-middle transcript: assistant indices reflect variable rows-per-turn", () => {
    const transcript: TurnEntry[] = [
      normalTurn("t1", "a", "A"), // rows 0, 1
      wakeTurn("t2", "Wake"), // row 2 (no user row)
      normalTurn("t3", "c", "C"), // rows 3, 4
    ];
    expect(assistantRowIndexForTurn(0, transcript)).toBe(1);
    expect(assistantRowIndexForTurn(1, transcript)).toBe(2);
    expect(assistantRowIndexForTurn(2, transcript)).toBe(4);
    // Callers gate on `turn.messages[0]?.kind === "user_message"`
    // before calling userRowIndexForTurn; the helper itself doesn't
    // know the turn kind.
    expect(userRowIndexForTurn(0, transcript)).toBe(0);
    expect(userRowIndexForTurn(2, transcript)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Turn-aware anchor depth ([P06]) — the restore anchor speaks turns
// ---------------------------------------------------------------------------

describe("turnDepthFromEnd / rowIndexForTurnDepthFromEnd", () => {
  test("normal-only: every row maps to its turn's depth-from-end", () => {
    // [t1,t2,t3] → rows t1:0,1  t2:2,3  t3:4,5 (n = 3 turns)
    const snap = snapshotWith({
      transcript: [
        normalTurn("t1", "a", "A"),
        normalTurn("t2", "b", "B"),
        normalTurn("t3", "c", "C"),
      ],
    });
    const ds = new SessionTranscriptDataSource(storeWith(snap));
    // Both rows of a turn report the same depth (n − turnIndex).
    expect(ds.turnDepthFromEnd(0)).toBe(3);
    expect(ds.turnDepthFromEnd(1)).toBe(3);
    expect(ds.turnDepthFromEnd(2)).toBe(2);
    expect(ds.turnDepthFromEnd(3)).toBe(2);
    expect(ds.turnDepthFromEnd(4)).toBe(1);
    expect(ds.turnDepthFromEnd(5)).toBe(1);
  });

  test("relocation lands on the anchored turn's FIRST row (canonicalizes the half)", () => {
    const snap = snapshotWith({
      transcript: [
        normalTurn("t1", "a", "A"),
        normalTurn("t2", "b", "B"),
        normalTurn("t3", "c", "C"),
      ],
    });
    const ds = new SessionTranscriptDataSource(storeWith(snap));
    // Anchored on the assistant row (3) → depth 2 → relocates to the turn's
    // user row (2). The within-turn delta lives in the pixel offset.
    const depth = ds.turnDepthFromEnd(3)!;
    expect(depth).toBe(2);
    expect(ds.rowIndexForTurnDepthFromEnd(depth)).toBe(2);
    // Round-trip the other turns to their first rows.
    expect(ds.rowIndexForTurnDepthFromEnd(3)).toBe(0);
    expect(ds.rowIndexForTurnDepthFromEnd(1)).toBe(4);
  });

  test("wake-in-middle: variable rows-per-turn map correctly both ways", () => {
    // [t1 normal, t2 wake, t3 normal] → rows t1:0,1  t2:2  t3:3,4 (n = 3)
    const snap = snapshotWith({
      transcript: [
        normalTurn("t1", "a", "A"),
        wakeTurn("t2", "Wake"),
        normalTurn("t3", "c", "C"),
      ],
    });
    const ds = new SessionTranscriptDataSource(storeWith(snap));
    expect(ds.turnDepthFromEnd(2)).toBe(2); // the wake row
    expect(ds.rowIndexForTurnDepthFromEnd(2)).toBe(2); // back to the wake row
    expect(ds.turnDepthFromEnd(4)).toBe(1);
    expect(ds.rowIndexForTurnDepthFromEnd(1)).toBe(3);
    expect(ds.rowIndexForTurnDepthFromEnd(3)).toBe(0);
  });

  test("anchored turn older than everything loaded → null (window must page in)", () => {
    const snap = snapshotWith({
      transcript: [normalTurn("t1", "a", "A"), normalTurn("t2", "b", "B")],
    });
    const ds = new SessionTranscriptDataSource(storeWith(snap));
    // n = 2; a saved depth of 5 turns is older than the 2 loaded.
    expect(ds.rowIndexForTurnDepthFromEnd(5)).toBeNull();
  });

  test("non-committed rows (in-flight, ghost) have no turn depth", () => {
    const active = activeTurn({ turnKey: "L", isWake: false, withText: "hi" });
    const snap = snapshotWith({
      transcript: [normalTurn("t1", "a", "A")], // rows 0,1
      activeTurn: active, // rows 2,3
      queuedSends: [{ turnKey: "Q", text: "later", atoms: [], origin: "user", queuedAt: 10, held: false }], // row 4
    });
    const ds = new SessionTranscriptDataSource(storeWith(snap));
    expect(ds.turnDepthFromEnd(0)).toBe(1); // committed
    expect(ds.turnDepthFromEnd(2)).toBeUndefined(); // in-flight
    expect(ds.turnDepthFromEnd(4)).toBeUndefined(); // ghost
  });

  test("empty transcript: undefined depth, null relocation", () => {
    const ds = new SessionTranscriptDataSource(storeWith(snapshotWith({})));
    expect(ds.turnDepthFromEnd(0)).toBeUndefined();
    expect(ds.rowIndexForTurnDepthFromEnd(1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Spec S04 — a stop receipt a later row has answered
// ---------------------------------------------------------------------------

/**
 * The demotion pass, and the reason it is a pass at all.
 *
 * A stop receipt is frozen text — true when the server wrote it and replayed
 * forever afterwards, offering a way back into work that may already have
 * landed. What answers it is a fact the same transcript already carries, so
 * the classification is pinned here over the exact receipt headers the server
 * writes; the shapes below are the ones read out of a real
 * `shell_exchanges.db`, not invented for the test.
 */
const stopReceipt = (arc: string): string =>
  `arc stopped · ${arc} · in audit — it went silent — no turn ended and no step closed before the arc's clock ran out`;

const joinReceipt = (arc: string): string =>
  `joined fa1e96b414 · ${arc} → main · 18 round(s)\n${arc} landed`;

const completeReceipt = (arc: string): string =>
  `arc complete · ${arc}\nopened on .tug/arcs/${arc}/brief.md`;

/** The `arcStopSuperseded` flag of every shell slot, in flat-row order. */
function supersededFlags(transcript: TurnEntry[]): boolean[] {
  const layout = buildRowLayout(snapshotWith({ transcript }));
  return layout.slots
    .filter((s) => s.cellKind === "shell")
    .map((s) => s.arcStopSuperseded);
}

describe("superseded arc stop receipts (Spec S04)", () => {
  test("a join for the same arc supersedes an earlier stop", () => {
    expect(
      supersededFlags([
        shellTurn("s1", "/arc-run", 1, stopReceipt("alpha")),
        shellTurn("s2", "/arc-join", 2, joinReceipt("alpha")),
      ]),
    ).toEqual([true, false]);
  });

  test("the retired join spelling supersedes too — every one already in a ledger", () => {
    expect(
      supersededFlags([
        shellTurn("s1", "/arc-run", 1, stopReceipt("alpha")),
        shellTurn("s2", "/dash-join", 2, joinReceipt("alpha")),
      ]),
    ).toEqual([true, false]);
  });

  test("a join for a different arc supersedes nothing (R02)", () => {
    expect(
      supersededFlags([
        shellTurn("s1", "/arc-run", 1, stopReceipt("alpha")),
        shellTurn("s2", "/arc-join", 2, joinReceipt("beta")),
      ]),
    ).toEqual([false, false]);
  });

  test("a stop with nothing after it keeps its live instruction", () => {
    expect(supersededFlags([shellTurn("s1", "/arc-run", 1, stopReceipt("alpha"))])).toEqual([
      false,
    ]);
  });

  test("a later stop supersedes the earlier one and stays live itself", () => {
    expect(
      supersededFlags([
        shellTurn("s1", "/arc-run", 1, stopReceipt("alpha")),
        shellTurn("s2", "/arc-run", 2, stopReceipt("alpha")),
      ]),
    ).toEqual([true, false]);
  });

  test("a completed arc answers the stop that came before it", () => {
    expect(
      supersededFlags([
        shellTurn("s1", "/arc-run", 1, stopReceipt("alpha")),
        shellTurn("s2", "/arc-run", 2, completeReceipt("alpha")),
      ]),
    ).toEqual([true, false]);
  });

  test("a stop AFTER the join is not superseded — order is the whole claim", () => {
    expect(
      supersededFlags([
        shellTurn("s1", "/arc-join", 1, joinReceipt("alpha")),
        shellTurn("s2", "/arc-run", 2, stopReceipt("alpha")),
      ]),
    ).toEqual([false, false]);
  });

  test("an unparseable row is neither candidate nor superseder", () => {
    // The safe direction: a join whose output cannot be read contributes no
    // name, so the stop it should have answered keeps its instruction rather
    // than losing one.
    expect(
      supersededFlags([
        shellTurn("s1", "/arc-run", 1, "arc gibberish · alpha"),
        shellTurn("s2", "/arc-join", 2, "not a receipt at all"),
        shellTurn("s3", "/arc-run", 3, stopReceipt("alpha")),
      ]),
    ).toEqual([false, false, false]);
  });

  test("a plain shell command between the two changes nothing", () => {
    expect(
      supersededFlags([
        shellTurn("s1", "/arc-run", 1, stopReceipt("alpha")),
        shellTurn("s2", "git status", 2, "clean"),
        shellTurn("s3", "/arc-join", 3, joinReceipt("alpha")),
      ]),
    ).toEqual([true, false, false]);
  });

  test("rowAt carries the flag onto the descriptor the cell reads", () => {
    const transcript = [
      shellTurn("s1", "/arc-run", 1, stopReceipt("alpha")),
      shellTurn("s2", "/arc-join", 2, joinReceipt("alpha")),
    ];
    const ds = new SessionTranscriptDataSource(storeWith(snapshotWith({ transcript })));
    expect(ds.rowAt(0).arcStopSuperseded).toBe(true);
    expect(ds.rowAt(1).arcStopSuperseded).toBe(false);
  });

  test("the memo gate compares the flag — without this the demotion never paints", () => {
    // Every other field in `sameTranscriptRowData` is reference-stable because
    // a finalized row is immutable. This one is not: a join arriving later
    // flips an earlier row's value while its `turn` never moves. Drop it from
    // the comparison and this is the only test in the file that fails.
    const turn = shellTurn("s1", "/arc-run", 1, stopReceipt("alpha"));
    const live = { kind: "shell" as const, turn, turnKey: "s1", arcStopSuperseded: false };
    const demoted = { ...live, arcStopSuperseded: true };
    expect(sameTranscriptRowData(live, live)).toBe(true);
    expect(sameTranscriptRowData(live, demoted)).toBe(false);
  });
});
