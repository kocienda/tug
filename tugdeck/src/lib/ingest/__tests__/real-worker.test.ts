/**
 * The ingest host on a real thread: a bun `Worker` running the shipped
 * entry, `ingest-worker.ts`, against a fake tugcast served by `Bun.serve`.
 *
 * Everything else about the host is tested over the in-process channel, which
 * clones every message but delivers synchronously. This is the test that the
 * thread is real: the Worker opens its own socket, completes the handshake,
 * subscribes, and posts frames back as raw `frame` patches — in order, whole,
 * across a WebSocket message that cut the third frame in two — paced by its
 * own `Pacer` and with their buffers transferred.
 *
 * And the session half, through the page's own `TugConnection` with the
 * Worker as its host: a `CodeSessionStore` whose engine reduces on the other
 * thread passes the CODE_OUTPUT decode guard's cases and the small-capped
 * transcript's, with the same assertions. Nothing here is synchronous, so a
 * test waits on something the page can see: a local action on `whenSettled()`,
 * and a wire frame on a marker sent right behind it, on a feed the page
 * still receives raw. The Worker forwards no CODE_OUTPUT frame to the page,
 * and posts in wire order, so once the marker is applied the frame's session
 * patches are too.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkerIngestChannel } from "../ingest-channel";
import type { SessionBatch, SessionPatch } from "../session-patch";
import { startFakeTugcast, type FakeTugcast } from "../testing/fake-tugcast";
import { FeedId, decodeFrame, encodeFrame } from "@/protocol";
import { TugConnection } from "@/connection";
import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";

const ENTRY = new URL("../../workers/ingest-worker.ts", import.meta.url).href;

let fake: FakeTugcast | null = null;
let channel: WorkerIngestChannel | null = null;

afterEach(() => {
  channel?.dispose();
  channel = null;
  fake?.stop();
  fake = null;
});

/** Wait for `cond`, up to `timeoutMs`; the thread is real, so arrival is asynchronous. */
async function until(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

function frameBytes(feedId: number, text: string): Uint8Array {
  return new Uint8Array(encodeFrame({ feedId: feedId as 0x50, flags: 0, payload: new TextEncoder().encode(text) }));
}

describe("the ingest Worker, on a real thread", () => {
  test("handshakes with tugcast and delivers three frames, one of them split, as raw frame patches in order", async () => {
    fake = startFakeTugcast();
    channel = new WorkerIngestChannel(() => new Worker(ENTRY, { type: "module" }));
    const patches: SessionPatch[] = [];
    const batches: SessionBatch[] = [];
    channel.setBatchListener((batch) => {
      batches.push(batch);
      patches.push(...batch.entries);
    });

    channel.post({ kind: "subscribe", feeds: [FeedId.DEFAULTS, FeedId.JOTS] });
    channel.post({ kind: "init", wsUrl: fake.url, periodMs: 16, motionEnabled: false });
    channel.post({ kind: "connect" });

    await until(
      () => patches.some((p) => p.kind === "wire-state" && p.payload.state === "open"),
      "the open patch",
    );
    const open = patches.find((p) => p.kind === "wire-state" && p.payload.state === "open");
    expect(open?.kind === "wire-state" ? open.payload.handshake?.protocol : null).toBe("tugcast");

    // The Worker re-established the subscription right after its handshake.
    await until(() => fake!.received.some((m) => typeof m !== "string"), "the subscription frame");
    const subscription = fake.received.find((m): m is Uint8Array => typeof m !== "string")!;
    const decoded = decodeFrame(subscription.slice().buffer);
    expect(decoded.feedId).toBe(FeedId.CONTROL);
    expect(JSON.parse(new TextDecoder().decode(decoded.payload))).toEqual({
      action: "subscribe_feeds",
      feeds: [FeedId.DEFAULTS, FeedId.JOTS],
    });

    const one = frameBytes(FeedId.DEFAULTS, '{"n":1}');
    const two = frameBytes(FeedId.JOTS, '{"n":2}');
    const three = frameBytes(FeedId.DEFAULTS, '{"n":3}');
    const cut = 4;
    const first = new Uint8Array(one.length + two.length + cut);
    first.set(one, 0);
    first.set(two, one.length);
    first.set(three.subarray(0, cut), one.length + two.length);
    fake.sendBinary(first);
    fake.sendBinary(three.subarray(cut));

    await until(() => patches.filter((p) => p.kind === "frame").length === 3, "three frame patches");
    const frames = patches.filter((p) => p.kind === "frame");
    expect(frames.map((p) => (p.kind === "frame" ? p.payload.feedId : null))).toEqual([
      FeedId.DEFAULTS,
      FeedId.JOTS,
      FeedId.DEFAULTS,
    ]);
    expect(frames.map((p) => (p.kind === "frame" ? new TextDecoder().decode(p.payload.bytes) : null))).toEqual([
      '{"n":1}',
      '{"n":2}',
      '{"n":3}',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The session half
// ---------------------------------------------------------------------------

const TUG = FIXTURE_IDS.TUG_SESSION_ID;

/** A page connection whose host is the Worker, connected to the fake. */
interface WorkerPage {
  conn: TugConnection;
  /** Send one CODE_OUTPUT frame and wait until the page has applied its batch. */
  wire(value: Record<string, unknown>): Promise<void>;
}

async function workerPage(): Promise<WorkerPage> {
  fake = startFakeTugcast();
  channel = new WorkerIngestChannel(() => new Worker(ENTRY, { type: "module" }));
  const conn = new TugConnection(fake.url, { channel });
  let markers = 0;
  conn.onFrame(FeedId.SESSION_SIDEBAND, () => {
    markers += 1;
  });
  conn.connect();
  await until(() => fake!.handshaken(), "the handshake");
  return {
    conn,
    async wire(value) {
      const before = markers;
      const payload = new TextEncoder().encode(JSON.stringify({ ...value, tug_session_id: TUG }));
      fake!.sendBinary(new Uint8Array(encodeFrame({ feedId: FeedId.CODE_OUTPUT, flags: 0, payload })));
      const marker = new TextEncoder().encode(JSON.stringify({ marker: before + 1 }));
      fake!.sendBinary(new Uint8Array(encodeFrame({ feedId: FeedId.SESSION_SIDEBAND, flags: 0, payload: marker })));
      // The marker posts after the patches the frame produced.
      await until(() => markers > before, "the frame's batch");
    },
  };
}

/**
 * Open a store on the page and wait until its engine is open in the Worker.
 * A control is handled in order, so once a test frame posted after the open
 * has been acknowledged the engine exists; the frame is an unknown tag, which
 * the engine drops without a word.
 */
async function openStore(
  page: WorkerPage,
  options: { sessionMode: "new" | "resume"; transcriptTurnCap?: number; restoreWindowTurns?: number },
): Promise<CodeSessionStore> {
  const store = new CodeSessionStore({
    conn: page.conn,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    ...options,
  });
  store._ingestFrameForTest(FeedId.CODE_OUTPUT, { type: "not_a_tag", tug_session_id: TUG });
  await store.whenSettled();
  return store;
}

describe("the session engine in the Worker — routed CODE_OUTPUT", () => {
  test("a /skills response reaches the mirror's routed store and leaves the transcript alone", async () => {
    const page = await workerPage();
    const store = await openStore(page, { sessionMode: "new" });
    const before = store.getSnapshot();
    const response = { type: "skills_inventory", request_id: "si-1", skills: [] };

    await page.wire(response);

    const routed = store.routedFrames("skills_inventory").getSnapshot().get(FeedId.CODE_OUTPUT);
    expect(routed).toEqual({ ...response, tug_session_id: TUG });
    expect(store.getSnapshot()).toBe(before);
    store.dispose();
  });
});

describe("the session engine in the Worker — CODE_OUTPUT decode guard", () => {
  interface Warning {
    source: string;
    message: string;
    data: unknown;
  }
  let warnings: Warning[];
  const originalWarn = tugDevLogStore.warn;
  beforeEach(() => {
    warnings = [];
    tugDevLogStore.warn = (source, message, data) => {
      warnings.push({ source, message, data });
    };
  });
  afterEach(() => {
    tugDevLogStore.warn = originalWarn;
  });
  const decodeErrors = () => warnings.filter((w) => w.message.startsWith("CODE_OUTPUT decode error"));
  const text = (seq: unknown, body: string) => ({
    type: "assistant_text",
    msg_id: FIXTURE_IDS.MSG_ID,
    block_index: 0,
    seq,
    rev: 0,
    text: body,
    is_partial: true,
    status: "partial",
  });

  test("logs a drifted frame as a decode error and leaves the reducer state unchanged", async () => {
    const page = await workerPage();
    const store = await openStore(page, { sessionMode: "new" });
    store.send("hi", []);
    await store.whenSettled();
    const before = store.getSnapshot();

    // `seq` drifted from a number to a string.
    await page.wire(text("0", "h"));

    expect(store.getSnapshot()).toBe(before);
    expect(decodeErrors()).toEqual([
      {
        source: "code-session-store",
        message: 'CODE_OUTPUT decode error: assistant_text at $.seq: expected number, got string "0"',
        data: {
          tag: "assistant_text",
          path: "$.seq",
          expected: "number",
          got: 'string "0"',
        },
      },
    ]);
  });

  test("dispatches the same frame once it matches the wire type", async () => {
    const page = await workerPage();
    const store = await openStore(page, { sessionMode: "new" });
    store.send("hi", []);
    await store.whenSettled();
    const before = store.getSnapshot();

    await page.wire(text(0, "h"));

    expect(before.phase).toBe("submitting");
    expect(store.getSnapshot().phase).toBe("awaiting_first_token");
    expect(decodeErrors()).toEqual([]);
  });

  test("drops an unknown tag without a word", async () => {
    const page = await workerPage();
    const store = await openStore(page, { sessionMode: "new" });
    const before = store.getSnapshot();

    await page.wire({ type: "not_a_tag" });

    expect(store.getSnapshot()).toBe(before);
    expect(decodeErrors()).toEqual([]);
  });

  test("drops a drifted frame inside a replay_batch alone", async () => {
    const page = await workerPage();
    const store = await openStore(page, { sessionMode: "new" });

    await page.wire({
      type: "replay_batch",
      frames: [
        { type: "replay_started" },
        // `content` drifted from an array of blocks to a bare string.
        { type: "add_user_message", content: "lost" },
        { type: "add_user_message", content: [{ type: "text", text: "kept" }] },
        { type: "turn_complete", msg_id: FIXTURE_IDS.MSG_ID, seq: 0, result: "success" },
        { type: "replay_complete", count: 1 },
      ],
    });

    const { transcript } = store.getSnapshot();
    expect(transcript).toHaveLength(1);
    expect(
      transcript[0].messages.flatMap((m) => (m.kind === "user_message" ? [m.text] : [])),
    ).toEqual(["kept"]);
    expect(decodeErrors().map((w) => w.data)).toEqual([
      {
        tag: "add_user_message",
        path: "$.content",
        expected: "array",
        got: 'string "lost"',
      },
    ]);
  });
});

describe("the session engine in the Worker — transcript cap", () => {
  const CAP = 5;
  const anchor = (n: number): string => `prompt-uuid-${n}`;
  const ids = (lo: number, hi: number): string[] => {
    const out: string[] = [];
    for (let n = lo; n <= hi; n++) out.push(FIXTURE_IDS.MSG_ID_N(n));
    return out;
  };
  const msgIds = (store: CodeSessionStore) => store.getSnapshot().transcript.map((t) => t.msgId);

  async function emitTurn(page: WorkerPage, n: number): Promise<void> {
    await page.wire({ type: "add_user_message", content: [{ type: "text", text: `prompt ${n}` }], promptUuid: anchor(n) });
    await page.wire({
      type: "assistant_text",
      status: "complete",
      msg_id: FIXTURE_IDS.MSG_ID_N(n),
      text: `reply ${n}`,
      is_partial: false,
      rev: 0,
      seq: 0,
    });
    await page.wire({ type: "turn_complete", seq: 0, msg_id: FIXTURE_IDS.MSG_ID_N(n), result: "success" });
  }

  async function liveTurn(page: WorkerPage, store: CodeSessionStore, n: number): Promise<void> {
    store.send(`prompt ${n}`, []);
    await store.whenSettled();
    await page.wire({ type: "prompt_anchor", promptUuid: anchor(n) });
    await page.wire({
      type: "assistant_text",
      status: "partial",
      msg_id: FIXTURE_IDS.MSG_ID_N(n),
      text: `reply ${n}`,
      is_partial: true,
      rev: 0,
      seq: 0,
    });
    await page.wire({ type: "turn_complete", seq: 0, msg_id: FIXTURE_IDS.MSG_ID_N(n), result: "success" });
  }

  async function replayRange(
    page: WorkerPage,
    lo: number,
    hi: number,
    meta: { firstLoadedTurnIndex: number; totalTurns: number; hasOlder: boolean },
  ): Promise<void> {
    await page.wire({ type: "replay_started" });
    for (let n = lo; n <= hi; n++) await emitTurn(page, n);
    await page.wire({ type: "replay_complete", count: hi - lo + 1, ...meta });
  }

  const smallCapped = (page: WorkerPage) =>
    openStore(page, { sessionMode: "resume", transcriptTurnCap: CAP, restoreWindowTurns: CAP });

  test("holds the window at the cap and advances the recency window past the evicted turns", async () => {
    const page = await workerPage();
    const store = await smallCapped(page);
    await replayRange(page, 0, 2, { firstLoadedTurnIndex: 0, totalTurns: 3, hasOlder: false });

    // Cap + N: seven more live turns, ten in all.
    for (let n = 3; n <= 9; n++) {
      await liveTurn(page, store, n);
      expect(store.getSnapshot().transcript.length).toBeLessThanOrEqual(CAP);
      expect(store._committedMsgIdCountForTest()).toBeLessThanOrEqual(CAP);
    }

    const snap = store.getSnapshot();
    expect(snap.transcript).toHaveLength(CAP);
    expect(msgIds(store)).toEqual(ids(5, 9));
    expect(snap.replayWindow).toEqual({ firstLoadedTurnIndex: 5, totalTurns: 10, hasOlder: true });
  });

  test("keeps what the user paged in, sliding one turn per later append", async () => {
    const page = await workerPage();
    const store = await smallCapped(page);
    await replayRange(page, 0, 2, { firstLoadedTurnIndex: 0, totalTurns: 3, hasOlder: false });
    for (let n = 3; n <= 9; n++) await liveTurn(page, store, n);
    store.loadPrevious("all");
    await store.whenSettled();
    await replayRange(page, 0, 4, { firstLoadedTurnIndex: 0, totalTurns: 10, hasOlder: false });

    await liveTurn(page, store, 10);
    expect(msgIds(store)).toEqual(ids(1, 10));
    expect(store.getSnapshot().replayWindow).toEqual({ firstLoadedTurnIndex: 1, totalTurns: 11, hasOlder: true });
  });

  test("does not evict mid-replay, and holds a long replay to the cap when it closes", async () => {
    const page = await workerPage();
    const store = await smallCapped(page);
    await page.wire({ type: "replay_started" });
    for (let n = 0; n <= 7; n++) await emitTurn(page, n);
    expect(store.getSnapshot().transcript).toHaveLength(8);
    await page.wire({ type: "replay_complete", count: 8 });

    expect(msgIds(store)).toEqual(ids(3, 7));
    expect(store.getSnapshot().replayWindow).toEqual({ firstLoadedTurnIndex: 3, totalTurns: 8, hasOlder: true });
  });
});

describe("tugcast's renders through the Worker", () => {
  test("a render-batch from tugcast lands in the mirror's record, and a motion hold reaches tugcast", async () => {
    const page = await workerPage();
    const store = await openStore(page, { sessionMode: "new" });
    store.send("hi", []);
    await store.whenSettled();
    const msgId = FIXTURE_IDS.MSG_ID_N(1);
    await page.wire({
      type: "assistant_text",
      status: "partial",
      msg_id: msgId,
      block_index: 1,
      text: "Hello",
      is_partial: true,
      rev: 0,
      seq: 0,
    });
    const turnKey = store.getSnapshot().activeTurn!.turnKey;
    const path = `turn.${turnKey}.message.${msgId}-b1.rendered`;
    expect(store.streamingDocument.get(path)).toEqual({ pending: true });

    const batch = {
      kind: "render-batch",
      sessions: [
        {
          tugSessionId: TUG,
          messages: [
            {
              messageKey: `${msgId}-b1`,
              channel: "text",
              blocks: [{ hash: "42", kind: "paragraph", startChar: 0, endChar: 5, depth: 0, itemCount: 0, rowCount: 0 }],
              html: { "42": "<p>Hello</p>\n" },
              textLength: 5,
              textHash: "1",
            },
          ],
        },
      ],
    };
    const payload = new TextEncoder().encode(JSON.stringify(batch));
    fake!.sendBinary(new Uint8Array(encodeFrame({ feedId: FeedId.RENDERED, flags: 0, payload })));
    await until(() => (store.streamingDocument.get(path) as { message?: unknown } | null)?.message !== undefined, "the record");
    expect(store.streamingDocument.get(path)).toMatchObject({
      streaming: true,
      current: false,
      message: { html: { "42": "<p>Hello</p>\n" } },
    });

    const renderInputs = (): Record<string, unknown>[] =>
      fake!.received
        .filter((m): m is Uint8Array => typeof m !== "string")
        .map((m) => decodeFrame(m.slice().buffer))
        .filter((f) => f.feedId === FeedId.RENDER_INPUT)
        .map((f) => JSON.parse(new TextDecoder().decode(f.payload)) as Record<string, unknown>);
    channel!.post({ kind: "motion", held: true, capMs: 600 });
    await until(() => renderInputs().some((c) => c.kind === "motion"), "the motion control");
    expect(renderInputs().find((c) => c.kind === "motion")).toMatchObject({ held: true, capMs: 1000 });
    store.dispose();
  });
});
