/**
 * text-card-store.autosave.test.ts — the in-flight-write reflush.
 *
 * An edit (or a line-ending change) that lands while a write is in
 * flight must NOT be lost: the in-flight write snapshotted stale
 * content, so on settle the store re-flushes the current buffer instead
 * of reporting "clean". Verified deterministically by mocking `file-io`
 * so the test controls exactly when each write resolves.
 *
 * The same control answers the per-file watch's three cost questions: an
 * echoed hash buys no read at all, a frame that arrives mid-write is held
 * until the baseline has moved rather than compared against one about to
 * be replaced, and a burst of frames during a read collapses to exactly one
 * more read — the trailing one, which is the only one that can see the last
 * write.
 */

import { describe, test, expect, mock, afterAll, beforeAll, beforeEach } from "bun:test";

import type { FileWatchState } from "@/lib/file-watch-client";

interface PendingWrite {
  content: string;
  baselineSha256: string | null;
  resolve: (outcome: unknown) => void;
}

const io = {
  writes: [] as PendingWrite[],
  readContent: "one two\n",
  readSha: "sha-read",
  /** Every path `readFileFromDisk` was called with, in order. */
  reads: [] as string[],
  /** When set, each read parks here until the test lets it finish. */
  holdReads: false,
  heldReads: [] as Array<() => void>,
};

/** Let one parked read finish. */
const releaseRead = async () => {
  const next = io.heldReads.shift();
  if (next === undefined) throw new Error("no read is parked");
  next();
  await tick();
};

/**
 * What the watch client put on the wire, read off a recording connection.
 *
 * The REAL client, not a `mock.module` stand-in: bun's module mocks are
 * process-wide, so a stub here replaced the client for every suite that ran
 * after this one — including the client's own, which went red in a full run
 * and green alone. A `watch` message is both a subscription and a re-ask,
 * which is the wire's own truth: `reask` IS a second `watch`.
 */
const wire: Array<{ type: string; path?: string }> = [];
const watch = {
  get watched() {
    return wire.filter((m) => m.type === "watch").map((m) => m.path);
  },
  get released() {
    return wire.filter((m) => m.type === "unwatch").map((m) => m.path);
  },
  get reasked() {
    return this.watched;
  },
  clear() {
    wire.length = 0;
  },
};
const recordingConnection = {
  send: (_feedId: number, payload: Uint8Array) => {
    wire.push(JSON.parse(new TextDecoder().decode(payload)));
  },
  onFrame: () => () => {},
} as unknown as import("@/connection").TugConnection;

mock.module("@/lib/file-io", () => ({
  readFileFromDisk: async (path: string) => {
    io.reads.push(path);
    if (io.holdReads) {
      await new Promise<void>((resolve) => io.heldReads.push(resolve));
    }
    // Resolved from the CURRENT fake disk, not from a value captured when
    // the read started — a parked read that finishes after another write
    // must see what is there now.
    return {
      ok: true,
      file: {
        path,
        content: io.readContent,
        sha256: io.readSha,
        size: io.readContent.length,
        mtimeMs: 0,
        readOnly: false,
      },
    };
  },
  writeFileToDisk: (req: { content: string; baselineSha256: string | null }) =>
    new Promise<unknown>((resolve) => {
      io.writes.push({ content: req.content, baselineSha256: req.baselineSha256, resolve });
    }),
}));

let TextCardStore: typeof import("@/lib/text-card-store").TextCardStore;
let fileWatchClient: typeof import("@/lib/file-watch-client");
beforeAll(async () => {
  ({ TextCardStore } = await import("@/lib/text-card-store"));
  fileWatchClient = await import("@/lib/file-watch-client");
  fileWatchClient._setConnectionSourceForTest(() => recordingConnection);
});
afterAll(() => {
  fileWatchClient._resetForTest();
  fileWatchClient._setConnectionSourceForTest(null);
});

function bridge(getText: () => string, setText?: (t: string) => void) {
  return {
    getText,
    replaceText: (t: string) => setText?.(t),
    getPositions: () => ({ anchor: { line: 1, ch: 0 }, scrollTop: 0 }),
    applyPositions: () => {},
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("TextCardStore in-flight-write reflush", () => {
  beforeEach(() => {
    io.writes = [];
  });

  test("an edit during an in-flight write is re-flushed, not lost", async () => {
    let buf = "one two\n";
    io.readContent = buf;
    const store = new TextCardStore();
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt");

    // Edit → flush → write #1 in flight (captured "…THREE\n").
    buf = "one two THREE\n";
    store.noteEdit();
    void store.flush();
    await tick();
    expect(io.writes).toHaveLength(1);
    expect(io.writes[0].content).toBe("one two THREE\n");

    // A second edit lands WHILE write #1 is still pending.
    buf = "one two THREE four\n";
    store.noteEdit();

    // Resolve #1 → the store must re-flush the current buffer as #2,
    // conditioned on #1's returned hash — not report "clean".
    io.writes[0].resolve({ ok: true, sha256: "sha1", mtimeMs: 1 });
    await tick();
    expect(io.writes).toHaveLength(2);
    expect(io.writes[1].content).toBe("one two THREE four\n");
    expect(io.writes[1].baselineSha256).toBe("sha1");

    io.writes[1].resolve({ ok: true, sha256: "sha2", mtimeMs: 2 });
    await tick();
    expect(store.getSnapshot().saveState).toBe("clean");
    store.dispose();
  });

  test("setLineEnding during an in-flight write re-serializes on settle", async () => {
    let buf = "a\nb\n";
    io.readContent = buf;
    const store = new TextCardStore();
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt"); // detects LF

    buf = "a\nb\nc\n";
    store.noteEdit();
    void store.flush();
    await tick();
    expect(io.writes[0].content).toBe("a\nb\nc\n");

    // Change the line ending while write #1 is pending.
    store.setLineEnding("CRLF");

    io.writes[0].resolve({ ok: true, sha256: "sha1", mtimeMs: 1 });
    await tick();
    expect(io.writes).toHaveLength(2);
    expect(io.writes[1].content).toBe("a\r\nb\r\nc\r\n");

    io.writes[1].resolve({ ok: true, sha256: "sha2", mtimeMs: 2 });
    await tick();
    expect(store.getSnapshot().lineEnding).toBe("CRLF");
    expect(store.getSnapshot().saveState).toBe("clean");
    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// What a watch frame costs
// ---------------------------------------------------------------------------

let watchSeq = 0;

/** Deliver one FILE_WATCH state for the store's own path. */
function deliver(
  store: InstanceType<typeof TextCardStore>,
  patch: Partial<FileWatchState> = {},
) {
  const path = store.getSnapshot().path;
  if (path === null) throw new Error("deliver: the store has no path");
  const state: FileWatchState = {
    path,
    seq: ++watchSeq,
    state: "present",
    sha256: io.readSha,
    size: io.readContent.length,
    created: [],
    renamedTo: null,
    error: null,
    ...patch,
  };
  (
    store as unknown as { _onFileWatchState(s: FileWatchState): void }
  )._onFileWatchState(state);
}

describe("what a watch frame costs", () => {
  beforeEach(() => {
    io.writes = [];
    io.reads = [];
    io.heldReads = [];
    io.holdReads = false;
    io.readContent = "one two\n";
    io.readSha = "sha-read";
    // Earlier tests leave stores open on the same path; forgetting their
    // subscriptions is what makes the last release below the LAST one.
    fileWatchClient._resetForTest();
    watch.clear();
  });

  test("an echoed hash buys no read", async () => {
    const store = new TextCardStore();
    store.attachEditor(bridge(() => io.readContent));
    await store.openPath("/f.txt");
    io.reads = [];

    // The hash the frame carries IS the baseline: our own write coming
    // back, or a change that produced the bytes we already hold. There is
    // nothing disk can tell us that we do not know.
    deliver(store, { sha256: "sha-read" });
    await tick();
    expect(io.reads).toEqual([]);

    // A different hash is a different file, and that costs exactly one read.
    io.readSha = "sha-theirs";
    deliver(store, { sha256: "sha-theirs" });
    await tick();
    expect(io.reads).toEqual(["/f.txt"]);
  });

  test("a frame during a write waits for the baseline to move", async () => {
    let buf = "one two\n";
    const store = new TextCardStore();
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");

    buf = "mine\n";
    store.noteEdit();
    void store.flush();
    await tick();
    expect(io.writes).toHaveLength(1);
    io.reads = [];

    // The echo of our own write, arriving before the write has settled.
    // Comparing it now would compare against a baseline about to be
    // replaced, so it is held.
    deliver(store, { sha256: "sha-mine" });
    expect(io.reads).toEqual([]);
    expect(
      (store as unknown as { _deferredState: unknown })._deferredState,
    ).not.toBeNull();

    // The write settles with exactly that hash. Now the comparison is an
    // equality, and it still costs nothing.
    io.writes[0].resolve({ ok: true, sha256: "sha-mine", mtimeMs: 1 });
    await tick();
    expect(io.reads).toEqual([]);
    expect(store.getSnapshot().saveState).toBe("clean");
  });

  test("an external write inside the same window is still seen", async () => {
    let buf = "one two\n";
    const store = new TextCardStore();
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");

    buf = "mine\n";
    store.noteEdit();
    void store.flush();
    await tick();
    io.reads = [];

    // Somebody else's bytes landed while our write was in flight. The
    // deferral is ordering, not suppression: the hash does not equal the
    // baseline the write is about to install, so the look still happens.
    io.readContent = "theirs\n";
    io.readSha = "sha-theirs";
    deliver(store, { sha256: "sha-theirs" });
    io.writes[0].resolve({ ok: true, sha256: "sha-mine", mtimeMs: 1 });
    await tick();
    await tick();

    expect(io.reads).toEqual(["/f.txt"]);
    expect(buf).toBe("theirs\n");
  });

  test("a burst during a read collapses to one trailing read", async () => {
    let buf = "one two\n";
    const store = new TextCardStore();
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");
    io.reads = [];
    io.holdReads = true;

    // The first frame starts a read and it parks. Four more arrive while it
    // is in flight; each one marks a look owed rather than starting one.
    io.readContent = "first\n";
    io.readSha = "sha-1";
    deliver(store, { sha256: "sha-1" });
    await tick();
    expect(io.reads).toHaveLength(1);

    for (const n of [2, 3, 4, 5]) {
      io.readSha = `sha-${n}`;
      io.readContent = `write ${n}\n`;
      deliver(store, { sha256: `sha-${n}` });
    }
    await tick();
    expect(io.reads).toHaveLength(1);

    // The first read finishes and the one owed look starts — reading disk
    // as it is NOW, which is the last write's content.
    await releaseRead();
    expect(io.reads).toHaveLength(2);
    await releaseRead();
    await tick();

    expect(io.reads).toHaveLength(2);
    expect(buf).toBe("write 5\n");
  });

  test("the watch follows a rebind and is released on dispose", async () => {
    const store = new TextCardStore();
    store.attachEditor(bridge(() => "one two\n"));
    await store.openPath("/f.txt");
    expect(watch.watched).toEqual(["/f.txt"]);
    expect(watch.released).toEqual([]);

    void store.saveAs("/moved.txt");
    await tick();
    io.writes[io.writes.length - 1].resolve({
      ok: true,
      sha256: "sha-moved",
      mtimeMs: 2,
    });
    await tick();
    await tick();

    expect(store.getSnapshot().path).toBe("/moved.txt");
    expect(watch.released).toEqual(["/f.txt"]);
    expect(watch.watched[watch.watched.length - 1]).toBe("/moved.txt");

    store.dispose();
    expect(watch.released).toEqual(["/f.txt", "/moved.txt"]);
  });

  test("activation asks again as well as reading", async () => {
    const store = new TextCardStore();
    store.attachEditor(bridge(() => "one two\n"));
    await store.openPath("/f.txt");
    watch.clear();

    await store.recheckOnActivation();
    // Both halves: the re-ask covers a push we missed, the read covers
    // having no connection at all.
    expect(watch.reasked).toEqual(["/f.txt"]);
    expect(io.reads[io.reads.length - 1]).toBe("/f.txt");
  });
});
