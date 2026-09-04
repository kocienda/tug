/**
 * Tests for `absorbArcNotes` — the restore-side re-thread that keeps an arc
 * run reading identically live and after a relaunch ([P12]).
 *
 * Live, an arc note seats INSIDE the streaming turn (`handleArcNote`).
 * Restored, the same note re-arrives as a shell-ledger ink row; this pass
 * re-seats every arc-note row whose timestamp falls within a committed
 * Claude turn's span into that turn, as a `source: "arc"` system_note at
 * its clock position — and runs at every site that can complete the pair,
 * so both orders of the reload race converge.
 *
 * Pins:
 *   - an arc-note ink row inside a turn's span moves into the turn at its
 *     clock position among the messages, and the ink row disappears,
 *   - a row outside every span (a between-turns gesture) stays put, and the
 *     unchanged transcript comes back as the SAME reference,
 *   - a turn already carrying the note (same `arc-note-<exchangeId>` key —
 *     the live seat) absorbs the row by dropping it, no duplicate,
 *   - a re-seated note carries the ledger row's command through, so the seat
 *     reads the same after a relaunch as it did live ([B02]),
 *   - a non-arc shell row inside a span is never absorbed,
 *   - idempotence: absorbing twice equals absorbing once.
 */

import { describe, it, expect } from "bun:test";

import { absorbArcNotes } from "@/lib/code-session-store/reducer";
import type {
  Message,
  ShellExchangeMessage,
  TurnEntry,
} from "@/lib/code-session-store/types";

const COST = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: 0,
};

function claudeTurn(opts: {
  turnKey: string;
  start: number;
  end: number;
  messages: Message[];
}): TurnEntry {
  return {
    turnKey: opts.turnKey,
    msgId: `${opts.turnKey}-msg`,
    origin: "user",
    messages: opts.messages,
    result: "success",
    endedAt: opts.end,
    wallClockMs: opts.end - opts.start,
    awaitingApprovalMs: 0,
    transportDowntimeMs: 0,
    activeMs: opts.end - opts.start,
    ttftMs: null,
    ttftcMs: null,
    reconnectCount: 0,
    maxStreamGapMs: 0,
    turnEndReason: "complete",
    cost: COST,
  } as TurnEntry;
}

function userMsg(key: string, at: number): Message {
  return {
    kind: "user_message",
    messageKey: key,
    createdAt: at,
    text: "work the step",
    atoms: [],
  } as unknown as Message;
}

function toolMsg(key: string, at: number): Message {
  return {
    kind: "tool_use",
    messageKey: key,
    createdAt: at,
    toolUseId: key,
    toolName: "Bash",
    input: {},
    status: "done",
    result: null,
    structuredResult: null,
    toolWallMs: 5,
  } as Message;
}

function inkRow(opts: {
  exchangeId: string;
  command: string;
  output: string;
  at: number;
}): TurnEntry {
  const msg: ShellExchangeMessage = {
    kind: "shell_exchange",
    messageKey: `shell-${opts.exchangeId}`,
    createdAt: opts.at,
    exchangeId: opts.exchangeId,
    command: opts.command,
    output: opts.output,
    exitCode: 0,
    cwd: "/tmp/demo",
    cwdAfter: null,
    startedAtMs: opts.at,
    settledAtMs: opts.at,
  };
  return {
    turnKey: `shell-${opts.exchangeId}`,
    msgId: opts.exchangeId,
    origin: "shell",
    messages: [msg],
    result: "success",
    endedAt: opts.at,
    wallClockMs: 0,
    awaitingApprovalMs: 0,
    transportDowntimeMs: 0,
    activeMs: 0,
    ttftMs: null,
    ttftcMs: null,
    reconnectCount: 0,
    maxStreamGapMs: 0,
    turnEndReason: "complete",
    cost: COST,
  } as TurnEntry;
}

const T0 = 1_700_000_000_000;

describe("absorbArcNotes", () => {
  it("re-seats a spanned arc-note row inside its turn at clock position", () => {
    const turn = claudeTurn({
      turnKey: "k1",
      start: T0,
      end: T0 + 10_000,
      messages: [
        userMsg("u1", T0),
        toolMsg("t1", T0 + 2_000),
        toolMsg("t2", T0 + 8_000),
      ],
    });
    const note = inkRow({
      exchangeId: "restored-7",
      command: "arc step demo start",
      output: "demo: step 1/3 started — carve",
      at: T0 + 5_000,
    });
    const out = absorbArcNotes([turn, note]);
    expect(out.length).toBe(1);
    const messages = out[0]!.messages;
    expect(messages.length).toBe(4);
    // After t1 (T0+2s), before t2 (T0+8s).
    expect(messages[2]!.kind).toBe("system_note");
    expect(messages[2]!.messageKey).toBe("arc-note-restored-7");
    if (messages[2]!.kind === "system_note") {
      expect(messages[2]!.source).toBe("arc");
      expect(messages[2]!.text).toBe("demo: step 1/3 started — carve");
      // The ledger row's own command rides into the seat ([B02]). Without it
      // a restored run would render flat lines where the live one rendered
      // verbs — the two must read identically, which is this pass' whole job.
      expect(messages[2]!.command).toBe("arc step demo start");
    }
  });

  it("leaves an unspanned row alone and returns the same reference", () => {
    const turn = claudeTurn({
      turnKey: "k1",
      start: T0,
      end: T0 + 1_000,
      messages: [userMsg("u1", T0)],
    });
    const note = inkRow({
      exchangeId: "restored-8",
      command: "arc create demo",
      output: "demo: arc created",
      at: T0 + 60_000,
    });
    const input = [turn, note];
    const out = absorbArcNotes(input);
    expect(out).toBe(input);
  });

  it("drops a row whose note already lives in the turn (the live seat)", () => {
    const liveSeat: Message = {
      kind: "system_note",
      messageKey: "arc-note-restored-9",
      createdAt: T0 + 500,
      text: "demo: step 2/3 closed (abc123def)",
      source: "arc",
    } as Message;
    const turn = claudeTurn({
      turnKey: "k1",
      start: T0,
      end: T0 + 1_000,
      messages: [userMsg("u1", T0), liveSeat],
    });
    const row = inkRow({
      exchangeId: "restored-9",
      command: "arc step demo done",
      output: "demo: step 2/3 closed (abc123def)",
      at: T0 + 500,
    });
    const out = absorbArcNotes([turn, row]);
    expect(out.length).toBe(1);
    const notes = out[0]!.messages.filter((m) => m.kind === "system_note");
    expect(notes.length).toBe(1);
  });

  it("never absorbs a non-arc shell row, even inside a span", () => {
    const turn = claudeTurn({
      turnKey: "k1",
      start: T0,
      end: T0 + 10_000,
      messages: [userMsg("u1", T0)],
    });
    const plain = inkRow({
      exchangeId: "restored-10",
      command: "echo hello",
      output: "hello",
      at: T0 + 5_000,
    });
    const input = [turn, plain];
    expect(absorbArcNotes(input)).toBe(input);
  });

  it("is idempotent", () => {
    const turn = claudeTurn({
      turnKey: "k1",
      start: T0,
      end: T0 + 10_000,
      messages: [userMsg("u1", T0), toolMsg("t1", T0 + 2_000)],
    });
    const note = inkRow({
      exchangeId: "restored-11",
      command: "arc commit demo",
      output: "demo: round 9969b1e81 — carve the slice",
      at: T0 + 3_000,
    });
    const once = absorbArcNotes([turn, note]);
    const twice = absorbArcNotes(once);
    expect(twice).toBe(once);
  });
});
