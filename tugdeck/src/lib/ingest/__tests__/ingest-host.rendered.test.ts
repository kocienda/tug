/**
 * tugcast's renders through the ingest host, with the host holding its own
 * (fake) socket as it does in the Worker.
 *
 * The routing: a `RENDERED` frame reaches the engines of the sessions it
 * names, is never posted to the page as a raw frame, and is never replayed
 * into an engine that opens later. The engine's facts ([P06]): a live
 * Message is written `pending` at mint and a replayed one is written nothing;
 * a render that beats its Message's mint is applied at the mint; `streaming`
 * flips false at the turn's end with no further render; `current` holds only
 * when the record describes the Message's text; a missing hash asks tugcast
 * for one resync; and each finisher writes `null` once. And the controls
 * tugcast paces and holds by: the motion hold under one holder id, the
 * display period, and the handshake's period and resync.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RenderedMessageWire } from "@tugproto/rendered";
import type { RenderedState } from "@tugproto/ingest";
import { InProcessIngestChannel } from "../ingest-channel";
import { ManualClock } from "../testing/manual-clock";
import { RENDER_FINISHER_MS } from "@/lib/code-session-store/session-engine";
import type { SessionBatch } from "../session-patch";
import { textHash } from "../text-hash";
import { FakeWebSocket, QUIET_TIMERS, handshake, installFakeWebSocket } from "../testing/fake-websocket";
import { FeedId, decodeFrame, encodeFrame } from "@/protocol";

let restoreWebSocket: () => void = () => {};

beforeEach(() => {
  restoreWebSocket = installFakeWebSocket();
});

afterEach(() => {
  restoreWebSocket();
});

const A = "session-a";
const MSG = "msg00000-0000-4000-8000-000000000001";
const KEY = `${MSG}-b1`;

interface Wire {
  channel: InProcessIngestChannel;
  batches: SessionBatch[];
  ws: FakeWebSocket;
  clock: ManualClock;
}

function openWire(): Wire {
  const clock = new ManualClock();
  const channel = new InProcessIngestChannel({ timers: QUIET_TIMERS, sessionTimers: () => clock });
  const batches: SessionBatch[] = [];
  channel.setBatchListener((batch) => batches.push(batch));
  channel.post({ kind: "init", wsUrl: "ws://test.invalid/ws", periodMs: 16, motionEnabled: false });
  channel.post({ kind: "connect" });
  const ws = FakeWebSocket.last!;
  handshake(ws);
  return { channel, batches, ws, clock };
}

function open(channel: InProcessIngestChannel, handle: string, tugSessionId: string): void {
  channel.post({
    kind: "session-open",
    handle,
    tugSessionId,
    displayLabel: tugSessionId,
    sessionMode: "resume",
    restoreWindowTurns: 20,
  });
}

/** Open a live turn on `handle`. */
function sendTurn(channel: InProcessIngestChannel, handle: string): void {
  channel.post({
    kind: "session-action",
    handle,
    seq: 1,
    event: { type: "send", text: "hi", atoms: [], content: [{ type: "text", text: "hi" }], turnKey: "t-1" },
  });
}

function wire(ws: FakeWebSocket, feedId: number, value: unknown): void {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  ws.fireMessage(encodeFrame({ feedId: feedId as 0x50, flags: 0, payload }));
}

function delta(ws: FakeWebSocket, text: string, partial: boolean, seq: number): void {
  wire(ws, FeedId.CODE_OUTPUT, {
    type: "assistant_text",
    tug_session_id: A,
    status: partial ? "partial" : "complete",
    msg_id: MSG,
    block_index: 1,
    text,
    is_partial: partial,
    rev: 0,
    seq,
  });
}

function turnComplete(ws: FakeWebSocket): void {
  wire(ws, FeedId.CODE_OUTPUT, { type: "turn_complete", tug_session_id: A, msg_id: MSG, seq: 99, result: "success" });
}

/** A render of `text` with one block per entry of `blocks`, carrying HTML for `withHtml`. */
function render(text: string, blocks: string[], withHtml: string[] = blocks): RenderedMessageWire {
  return {
    messageKey: KEY,
    channel: "text",
    blocks: blocks.map((hash, i) => ({
      hash,
      kind: "paragraph",
      startChar: i,
      endChar: i + 1,
      depth: 0,
      itemCount: 0,
      rowCount: 0,
    })),
    html: Object.fromEntries(withHtml.map((h) => [h, `<p>${h}</p>`])),
    textLength: text.length,
    textHash: textHash(text),
  };
}

function renderBatch(ws: FakeWebSocket, tugSessionId: string, messages: RenderedMessageWire[]): void {
  wire(ws, FeedId.RENDERED, { kind: "render-batch", sessions: [{ tugSessionId, messages }] });
}

/** Every `.rendered` state the engines posted, in order. */
function states(batches: SessionBatch[]): { messageKey: string; state: RenderedState }[] {
  return batches.flatMap((b) =>
    b.entries.flatMap((p) => (p.kind === "rendered-blocks" ? p.payload.messages : [])),
  );
}

/** Every `RENDER_INPUT` control the host sent, decoded. */
function renderInputs(ws: FakeWebSocket): Record<string, unknown>[] {
  return ws.sent
    .filter((d): d is ArrayBuffer => typeof d !== "string")
    .map((d) => decodeFrame(d))
    .filter((f) => f.feedId === FeedId.RENDER_INPUT)
    .map((f) => JSON.parse(new TextDecoder().decode(f.payload)) as Record<string, unknown>);
}

describe("RENDERED routing", () => {
  test("a render reaches the engine of the session it names and is never a frame patch", () => {
    const { channel, batches, ws } = openWire();
    open(channel, `${A}#1`, A);
    open(channel, "session-b#1", "session-b");
    sendTurn(channel, `${A}#1`);
    delta(ws, "Hello", true, 0);
    batches.length = 0;

    renderBatch(ws, A, [render("Hello", ["1"])]);
    const posted = batches.flatMap((b) => b.entries);
    expect(posted.some((p) => p.kind === "frame")).toBe(false);
    const rendered = posted.filter((p) => p.kind === "rendered-blocks");
    expect(rendered.map((p) => p.session)).toEqual([`${A}#1`]);
  });

  test("a render is not replayed into an engine that opens later", () => {
    const { channel, batches, ws } = openWire();
    renderBatch(ws, A, [render("Hello", ["1"])]);
    open(channel, `${A}#1`, A);
    sendTurn(channel, `${A}#1`);
    delta(ws, "Hello", true, 0);
    expect(states(batches)).toEqual([{ turnKey: "t-1", messageKey: KEY, state: { pending: true } }] as never);
    expect(batches.flatMap((b) => b.entries).some((p) => p.kind === "frame")).toBe(false);
  });

  test("the host subscribes RENDERED for its engines", () => {
    const { channel, ws } = openWire();
    open(channel, `${A}#1`, A);
    const subscriptions = ws.sent
      .filter((d): d is ArrayBuffer => typeof d !== "string")
      .map((d) => decodeFrame(d))
      .filter((f) => f.feedId === FeedId.CONTROL)
      .map((f) => JSON.parse(new TextDecoder().decode(f.payload)) as { feeds: number[] });
    expect(subscriptions[subscriptions.length - 1]!.feeds).toContain(FeedId.RENDERED);
  });
});

describe("the engine's render facts", () => {
  test("a live Message mints pending; a replayed one writes nothing", () => {
    const { channel, batches, ws } = openWire();
    open(channel, `${A}#1`, A);

    wire(ws, FeedId.CODE_OUTPUT, { type: "replay_started", tug_session_id: A });
    wire(ws, FeedId.CODE_OUTPUT, {
      type: "add_user_message",
      tug_session_id: A,
      content: [{ type: "text", text: "old" }],
      promptUuid: "p-0",
    });
    wire(ws, FeedId.CODE_OUTPUT, {
      type: "assistant_text",
      tug_session_id: A,
      status: "complete",
      msg_id: "old-msg",
      block_index: 0,
      text: "restored",
      is_partial: false,
      rev: 0,
      seq: 0,
    });
    wire(ws, FeedId.CODE_OUTPUT, { type: "turn_complete", tug_session_id: A, msg_id: "old-msg", seq: 1, result: "success" });
    wire(ws, FeedId.CODE_OUTPUT, {
      type: "replay_complete",
      tug_session_id: A,
      count: 1,
      firstLoadedTurnIndex: 0,
      totalTurns: 1,
      hasOlder: false,
    });
    expect(states(batches)).toEqual([]);

    sendTurn(channel, `${A}#1`);
    delta(ws, "Hel", true, 0);
    expect(states(batches)).toEqual([{ turnKey: "t-1", messageKey: KEY, state: { pending: true } }] as never);
  });

  test("a render that beats its Message's mint is applied at the mint", () => {
    const { channel, batches, ws } = openWire();
    open(channel, `${A}#1`, A);
    sendTurn(channel, `${A}#1`);
    renderBatch(ws, A, [render("Hel", ["1"])]);
    expect(states(batches)).toEqual([]);

    delta(ws, "Hel", true, 0);
    const [first, ...rest] = states(batches);
    expect(rest).toEqual([]);
    expect(first!.state).toMatchObject({ streaming: true, current: false });
  });

  test("streaming flips false at turn_complete, current only when the record matches the text", () => {
    const { channel, batches, ws } = openWire();
    open(channel, `${A}#1`, A);
    sendTurn(channel, `${A}#1`);
    delta(ws, "Hello", true, 0);
    renderBatch(ws, A, [render("Hello", ["1"])]);
    batches.length = 0;

    turnComplete(ws);
    const flipped = states(batches);
    expect(flipped).toHaveLength(1);
    expect(flipped[0]!.state).toMatchObject({ streaming: false, current: true });
    // The flip re-posts the block list with no HTML; the mirror's merge keeps what it holds.
    const message = (flipped[0]!.state as { message: RenderedMessageWire }).message;
    expect(message.blocks.map((b) => b.hash)).toEqual(["1"]);
    expect(message.html).toEqual({});
  });

  test("a finalized Message whose text moves is not current until tugcast renders the new text", () => {
    const { channel, batches, ws } = openWire();
    open(channel, `${A}#1`, A);
    sendTurn(channel, `${A}#1`);
    const thinking = (text: string, partial: boolean, seq: number): void =>
      wire(ws, FeedId.CODE_OUTPUT, {
        type: "thinking_text",
        tug_session_id: A,
        status: partial ? "partial" : "complete",
        msg_id: MSG,
        block_index: 0,
        text,
        is_partial: partial,
        rev: 0,
        seq,
      });
    const THINK = `${MSG}-b0`;
    thinking("Hmm", true, 0);
    renderBatch(ws, A, [{ ...render("Hmm", ["1"]), messageKey: THINK, channel: "thinking" }]);
    // The text Message after it finalizes the thinking, current.
    delta(ws, "Yes", true, 1);
    const finalized = states(batches).filter((s) => s.messageKey === THINK);
    expect(finalized[finalized.length - 1]!.state).toMatchObject({ streaming: false, current: true });
    batches.length = 0;

    // A terminal whole frame repairs a lost delta: the record no longer describes the text.
    thinking("Hmm, yes", false, 2);
    expect(states(batches).filter((s) => s.messageKey === THINK).map((s) => s.state)).toEqual([
      expect.objectContaining({ streaming: false, current: false }),
    ]);
    batches.length = 0;

    // tugcast's render of the repaired text is current.
    renderBatch(ws, A, [{ ...render("Hmm, yes", ["2"]), messageKey: THINK, channel: "thinking" }]);
    expect(states(batches).map((s) => s.state)).toEqual([expect.objectContaining({ streaming: false, current: true })]);
  });

  test("a record behind the final text is not current, and its finisher writes null once", () => {
    const { channel, batches, ws, clock } = openWire();
    open(channel, `${A}#1`, A);
    sendTurn(channel, `${A}#1`);
    delta(ws, "Hel", true, 0);
    renderBatch(ws, A, [render("Hel", ["1"])]);
    delta(ws, "lo", true, 1);
    batches.length = 0;

    turnComplete(ws);
    expect(states(batches).map((s) => s.state)).toEqual([expect.objectContaining({ streaming: false, current: false })]);
    batches.length = 0;
    clock.advance(RENDER_FINISHER_MS - 1);
    expect(states(batches)).toEqual([]);
    clock.advance(1);
    expect(states(batches).map((s) => s.state)).toEqual([null]);
    clock.advance(10 * RENDER_FINISHER_MS);
    expect(states(batches)).toHaveLength(1);

    // A current record arriving later replaces the null.
    batches.length = 0;
    renderBatch(ws, A, [render("Hello", ["1"])]);
    expect(states(batches).map((s) => s.state)).toEqual([expect.objectContaining({ streaming: false, current: true })]);
  });

  test("a pending Message with no render is told to parse once, at the finisher", () => {
    const { channel, batches, ws, clock } = openWire();
    open(channel, `${A}#1`, A);
    sendTurn(channel, `${A}#1`);
    delta(ws, "Hel", true, 0);
    batches.length = 0;
    clock.advance(RENDER_FINISHER_MS);
    expect(states(batches).map((s) => s.state)).toEqual([null]);
    clock.advance(10 * RENDER_FINISHER_MS);
    expect(states(batches)).toHaveLength(1);
  });

  test("a Message minted empty waits for its first text before its finisher starts", () => {
    const { channel, batches, ws, clock } = openWire();
    open(channel, `${A}#1`, A);
    sendTurn(channel, `${A}#1`);
    wire(ws, FeedId.CODE_OUTPUT, {
      type: "content_block_start",
      tug_session_id: A,
      msg_id: MSG,
      block_index: 1,
      kind: "text",
    });
    expect(states(batches).map((s) => s.state)).toEqual([{ pending: true }]);
    clock.advance(10 * RENDER_FINISHER_MS);
    expect(states(batches)).toHaveLength(1);

    delta(ws, "Hel", true, 0);
    clock.advance(RENDER_FINISHER_MS);
    expect(states(batches).map((s) => s.state)).toEqual([{ pending: true }, null]);
  });

  test("a hash with no HTML anywhere posts one resync for its message", () => {
    const { channel, ws } = openWire();
    open(channel, `${A}#1`, A);
    sendTurn(channel, `${A}#1`);
    delta(ws, "Hel", true, 0);
    renderBatch(ws, A, [render("Hel", ["1", "2"], ["1"])]);
    renderBatch(ws, A, [render("Hel", ["1", "2"], [])]);
    const resyncs = renderInputs(ws).filter((c) => c.kind === "resync" && c.messageKey !== undefined);
    expect(resyncs).toEqual([{ kind: "resync", tugSessionId: A, messageKey: KEY }]);

    // A hash the page already holds is not missing.
    renderBatch(ws, A, [render("Hel", ["1", "2"], ["2"])]);
    renderBatch(ws, A, [render("Hel", ["1", "2"], [])]);
    expect(renderInputs(ws).filter((c) => c.messageKey !== undefined)).toHaveLength(1);
  });
});

describe("the controls tugcast paces and holds by", () => {
  test("the handshake sends the period and a resync of every message", () => {
    const { ws } = openWire();
    expect(renderInputs(ws)).toEqual([{ kind: "display-period", periodMs: 16 }, { kind: "resync" }]);
  });

  test("a motion hold and its release go to tugcast under one holder id, and the period with them", () => {
    const { channel, ws } = openWire();
    channel.post({ kind: "motion", held: true, capMs: 600 });
    channel.post({ kind: "motion", held: false });
    channel.post({ kind: "display-period", periodMs: 8.33 });
    const controls = renderInputs(ws).slice(2);
    expect(controls).toEqual([
      { kind: "motion", holder: expect.any(String), held: true, capMs: 1000 },
      { kind: "motion", holder: controls[0]!.holder, held: false },
      { kind: "display-period", periodMs: 8.33 },
    ]);
  });
});

describe("find through the host", () => {
  const find = {
    query: "needle",
    options: { caseSensitive: false, wholeWord: false, grep: false },
    limit: 100,
    units: [KEY],
    mountedUnits: [],
  };

  /** Every `find-result` patch the host posted, with the handle it went to. */
  function findResults(batches: SessionBatch[]): { session: string | null; requestId: string; missing: string[] }[] {
    return batches.flatMap((b) =>
      b.entries.flatMap((p) =>
        p.kind === "find-result"
          ? [{ session: p.session, requestId: p.payload.requestId, missing: p.payload.missing }]
          : [],
      ),
    );
  }

  test("a find goes to tugcast under the session's id, and its answer to the handle that asked", () => {
    const { channel, ws, batches } = openWire();
    open(channel, `${A}#1`, A);
    open(channel, `${A}#2`, A);
    channel.post({ kind: "find", handle: `${A}#2`, requestId: "q1", ...find });
    const sent = renderInputs(ws);
    expect(sent[sent.length - 1]).toEqual({ kind: "find", requestId: "q1", tugSessionId: A, ...find });

    wire(ws, FeedId.RENDERED, { kind: "find-result", requestId: "q1", tugSessionId: A, matches: [], missing: [] });
    // An answer nobody is waiting on — a repeat, or another page's — is dropped.
    wire(ws, FeedId.RENDERED, { kind: "find-result", requestId: "q1", tugSessionId: A, matches: [], missing: [] });
    wire(ws, FeedId.RENDERED, { kind: "find-result", requestId: "elsewhere", tugSessionId: A, missing: [] });
    expect(findResults(batches)).toEqual([{ session: `${A}#2`, requestId: "q1", missing: [] }]);
  });

  test("with the wire down a find is answered at once, every unit missing", () => {
    const { channel, ws, batches } = openWire();
    open(channel, `${A}#1`, A);
    ws.fireClose();
    const sentBefore = renderInputs(ws).length;
    channel.post({ kind: "find", handle: `${A}#1`, requestId: "q2", ...find, mountedUnits: [KEY, "other-b0"] });
    expect(renderInputs(ws).length).toBe(sentBefore);
    expect(findResults(batches)).toEqual([{ session: `${A}#1`, requestId: "q2", missing: [KEY, "other-b0"] }]);
  });
});
