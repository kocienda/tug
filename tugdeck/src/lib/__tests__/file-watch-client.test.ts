/**
 * file-watch-client — the deck's side of the per-file watch wire.
 *
 * Four facts. One path watched by two cards is one subscription on the wire,
 * and the last release is what ends it. A frame the client has already seen
 * is dropped, and a connection open forgets that history — because a
 * restarted tugcast starts its `seq` counter over and every frame of its
 * first run would otherwise be dropped as old. An open sends `reset` before
 * it re-watches, so a tugcast that did NOT restart is not left holding
 * subscriptions this client has forgotten. And a payload the client cannot
 * read is silence, never a throw inside a feed callback.
 *
 * The transport is a recording stand-in rather than a socket: what is under
 * test is which messages go out and which frames are applied.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { TugConnection } from "@/connection";
import { FeedId } from "@/protocol";

interface Sent {
  feedId: number;
  message: Record<string, unknown>;
}

let sent: Sent[] = [];
let frameCallback: ((payload: Uint8Array) => void) | null = null;

// The connection is handed to the client through its own seam, not by
// mocking the singleton module: in a full run the store suites import the
// client first, so it is already bound to the real singleton by the time a
// `mock.module` here would run, and every send becomes a silent no-op. This
// file was green alone and red in the suite for exactly that reason.
let activeConnection: TugConnection | null = null;

const {
  watchFile,
  reask,
  parseFileWatchFrame,
  _deliverForTest,
  _connectionDidOpenForTest,
  _resetForTest,
  _setConnectionSourceForTest,
} = await import("@/lib/file-watch-client");

_setConnectionSourceForTest(() => activeConnection);
afterAll(() => _setConnectionSourceForTest(null));

function recordingConnection(): TugConnection {
  return {
    send: (feedId: number, payload: Uint8Array) => {
      sent.push({
        feedId,
        message: JSON.parse(new TextDecoder().decode(payload)) as Record<
          string,
          unknown
        >,
      });
    },
    onFrame: (_feedId: number, callback: (payload: Uint8Array) => void) => {
      frameCallback = callback;
      return () => {
        frameCallback = null;
      };
    },
  } as unknown as TugConnection;
}

/** A `state` frame's bytes, as the service would send them. */
function stateFrame(
  path: string,
  seq: number,
  extra: Record<string, unknown> = {},
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: "state",
      path,
      seq,
      state: "present",
      sha256: "abc",
      size: 3,
      created: [],
      renamedTo: null,
      ...extra,
    }),
  );
}

const DOC = "/tmp/doc.md";

beforeEach(() => {
  sent = [];
  frameCallback = null;
  activeConnection = recordingConnection();
});

afterEach(() => {
  _resetForTest();
  activeConnection = null;
});

describe("file-watch-client", () => {
  it("holds one subscription per path however many listeners ask", () => {
    const seenA: number[] = [];
    const seenB: number[] = [];
    const releaseA = watchFile(DOC, (s) => seenA.push(s.seq));
    const releaseB = watchFile(DOC, (s) => seenB.push(s.seq));

    // The first watch is what attaches the feed callback.
    expect(frameCallback).not.toBeNull();

    // Both `watch` messages go out — `watch` always answers, so the second
    // listener gets its own first state — and both are for the one path.
    expect(sent.map((s) => s.message.type)).toEqual(["watch", "watch"]);
    expect(sent.every((s) => s.feedId === FeedId.FILE_WATCH_QUERY)).toBe(true);

    _deliverForTest(stateFrame(DOC, 1));
    expect(seenA).toEqual([1]);
    expect(seenB).toEqual([1]);

    releaseA();
    expect(sent.filter((s) => s.message.type === "unwatch")).toHaveLength(0);
    releaseB();
    expect(sent.filter((s) => s.message.type === "unwatch")).toHaveLength(1);
    expect(sent[sent.length - 1]?.message).toEqual({
      type: "unwatch",
      path: DOC,
    });

    // Released twice is still one unwatch.
    releaseB();
    expect(sent.filter((s) => s.message.type === "unwatch")).toHaveLength(1);
  });

  it("drops a seq it has already applied, and forgets on a connection open", () => {
    const seen: number[] = [];
    watchFile(DOC, (s) => seen.push(s.seq));

    _deliverForTest(stateFrame(DOC, 7));
    _deliverForTest(stateFrame(DOC, 7));
    _deliverForTest(stateFrame(DOC, 3));
    expect(seen).toEqual([7]);

    // A restarted tugcast counts from 1 again. Nothing about seq 3 is old
    // any more, so it must be applied.
    _connectionDidOpenForTest();
    _deliverForTest(stateFrame(DOC, 3));
    expect(seen).toEqual([7, 3]);
  });

  it("sends reset before it re-watches on a connection open", () => {
    watchFile(DOC, () => {});
    watchFile("/tmp/other.md", () => {});
    sent = [];

    _connectionDidOpenForTest();
    expect(sent.map((s) => s.message.type)).toEqual(["reset", "watch", "watch"]);
    const paths = sent.slice(1).map((s) => s.message.path);
    expect(paths.sort()).toEqual([DOC, "/tmp/other.md"]);
  });

  it("re-asks every held path on a resync frame", () => {
    watchFile(DOC, () => {});
    watchFile("/tmp/other.md", () => {});
    sent = [];

    _deliverForTest(new TextEncoder().encode(JSON.stringify({ type: "resync" })));
    expect(sent.map((s) => s.message.type)).toEqual(["watch", "watch"]);
  });

  it("re-asks one path, and says nothing for a path nobody holds", () => {
    watchFile(DOC, () => {});
    sent = [];

    reask(DOC);
    expect(sent).toHaveLength(1);
    reask("/tmp/never-watched.md");
    expect(sent).toHaveLength(1);
  });

  it("ignores a payload it cannot read, without throwing", () => {
    const seen: FileWatchStateSeq[] = [];
    watchFile(DOC, (s) => seen.push({ seq: s.seq }));

    for (const bytes of [
      new TextEncoder().encode("{not json"),
      new TextEncoder().encode(JSON.stringify(null)),
      new TextEncoder().encode(JSON.stringify({ type: "state" })),
      new TextEncoder().encode(
        JSON.stringify({ type: "state", path: DOC, seq: "1", state: "present" }),
      ),
      new TextEncoder().encode(
        JSON.stringify({ type: "state", path: DOC, seq: 1, state: "sideways" }),
      ),
      new TextEncoder().encode(JSON.stringify({ type: "something-else" })),
    ]) {
      expect(() => _deliverForTest(bytes)).not.toThrow();
    }
    expect(seen).toEqual([]);
  });

  it("decodes what the service actually sends", () => {
    const decoded = parseFileWatchFrame(
      stateFrame(DOC, 12, { dev: 1, ino: 99, created: ["/tmp/new.md", 4] }),
    );
    expect(decoded).toEqual({
      path: DOC,
      seq: 12,
      state: "present",
      sha256: "abc",
      size: 3,
      created: ["/tmp/new.md"],
      renamedTo: null,
      error: null,
      dev: 1,
      ino: 99,
    });

    const absent = parseFileWatchFrame(
      new TextEncoder().encode(
        JSON.stringify({
          type: "state",
          path: DOC,
          seq: 13,
          state: "absent",
          created: ["/tmp/moved.md"],
          renamedTo: "/tmp/moved.md",
        }),
      ),
    );
    expect(absent).toMatchObject({
      state: "absent",
      sha256: null,
      size: null,
      created: ["/tmp/moved.md"],
      renamedTo: "/tmp/moved.md",
    });
  });

  it("is a no-op with no connection, rather than a throw", () => {
    activeConnection = null;
    expect(() => {
      const release = watchFile(DOC, () => {});
      reask(DOC);
      release();
    }).not.toThrow();
    expect(sent).toEqual([]);
  });
});

/** Just the field the malformed-payload case reads back. */
interface FileWatchStateSeq {
  seq: number;
}
