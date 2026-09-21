/**
 * text-card-store.merge — a dirty buffer meets an external edit.
 *
 * The rung this file pins is the one an agent session hits constantly: the
 * user is typing and the file changes underneath them. Before, manual mode
 * asked a modal question every time and automatic mode waited for its next
 * conditional write to 409. Now both read disk and three-way-merge the
 * external change into the live buffer over the baseline text, and only a
 * merge that cannot be made honestly becomes the question ([B08], [B09]).
 *
 * `file-io` is the same in-memory filesystem the manual/autosave suites use,
 * so conditional writes and the aside writer are both exercised for real.
 * What is asserted here is the merged TEXT, which side's edits survive, and
 * that the buffer stays dirty against a baseline that is now the disk's.
 */

import { describe, test, expect, mock, beforeAll, beforeEach } from "bun:test";

import type { FileWatchState } from "@/lib/file-watch-client";

interface WriteCall {
  path: string;
  content: string;
  baselineSha256: string | null;
  delete: boolean;
}

const io = {
  files: new Map<string, { content: string; sha256: string }>(),
  writes: [] as WriteCall[],
  writeError: null as string | null,
};

const shaOf = (content: string): string => `sha:${content}`;

mock.module("@/lib/file-io", () => ({
  readFileFromDisk: async (path: string) => {
    const file = io.files.get(path);
    if (!file) return { ok: false, error: "not_found" };
    return {
      ok: true,
      file: {
        path,
        content: file.content,
        sha256: file.sha256,
        size: file.content.length,
        mtimeMs: 0,
        readOnly: false,
      },
    };
  },
  writeFileToDisk: async (req: {
    path: string;
    content: string;
    baselineSha256: string | null;
    delete?: boolean;
  }) => {
    io.writes.push({
      path: req.path,
      content: req.content,
      baselineSha256: req.baselineSha256,
      delete: req.delete === true,
    });
    if (io.writeError !== null && req.delete !== true) {
      const error = io.writeError;
      io.writeError = null;
      return { ok: false, error };
    }
    const existing = io.files.get(req.path);
    if (existing && req.baselineSha256 !== existing.sha256) {
      return { ok: false, error: "conflict", diskSha256: existing.sha256 };
    }
    if (!existing && req.baselineSha256 !== null) {
      return { ok: false, error: "missing" };
    }
    if (req.delete === true) {
      io.files.delete(req.path);
      return { ok: true, sha256: "", mtimeMs: 0 };
    }
    const sha = shaOf(req.content);
    io.files.set(req.path, { content: req.content, sha256: sha });
    return { ok: true, sha256: sha, mtimeMs: 0 };
  },
}));

let TextCardStore: typeof import("@/lib/text-card-store").TextCardStore;
let asidePathFor: typeof import("@/lib/file-aside").asidePathFor;
beforeAll(async () => {
  ({ TextCardStore } = await import("@/lib/text-card-store"));
  ({ asidePathFor } = await import("@/lib/file-aside"));
});

const PATH = "/doc.md";
const BASE = "one\ntwo\nthree\nfour\nfive\nsix\n";
/** The user's edit: the FIRST line. */
const OURS = "ONE mine\ntwo\nthree\nfour\nfive\nsix\n";
/** The agent's edit: the LAST line — nowhere near ours. */
const THEIRS = "one\ntwo\nthree\nfour\nfive\nSIX theirs\n";
/** Both edits, which is what a clean merge must produce. */
const MERGED = "ONE mine\ntwo\nthree\nfour\nfive\nSIX theirs\n";
/** The agent's edit landing on the line the user is typing in. */
const THEIRS_TOUCHING = "ONE agent\ntwo\nthree\nfour\nfive\nsix\n";

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Enough turns for a look's read RTT and the merge that follows it. */
const settleLook = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

/**
 * A live buffer: `replaceText` really moves it, so a merge applied to the
 * editor is visible to the store's next `getText()` — the thing a stand-in
 * that only records would hide.
 */
function liveBridge(initial: string) {
  const state = { text: initial, replaced: [] as string[] };
  return {
    state,
    bridge: {
      getText: () => state.text,
      replaceText: (t: string) => {
        state.text = t;
        state.replaced.push(t);
      },
      getPositions: () => ({ anchor: { line: 1, ch: 0 }, scrollTop: 0 }),
      applyPositions: () => {},
    },
  };
}

let watchSeq = 0;
/** Deliver one FILE_WATCH state for the store's own path, as the service would. */
function deliverState(
  store: InstanceType<typeof TextCardStore>,
  patch: Partial<FileWatchState> = {},
) {
  const path = patch.path ?? store.getSnapshot().path;
  if (path === null) throw new Error("deliverState: the store has no path");
  const file = io.files.get(path);
  const state: FileWatchState = {
    path,
    seq: ++watchSeq,
    state: "present",
    sha256: file?.sha256 ?? null,
    size: file?.content.length ?? null,
    created: [],
    renamedTo: null,
    error: null,
    ...patch,
  };
  (
    store as unknown as { _onFileWatchState(s: FileWatchState): void }
  )._onFileWatchState(state);
}

/** Open a dirty buffer on `BASE` with the user's edit already typed. */
async function dirtyOnBase(saveMode: "automatic" | "manual") {
  io.files.set(PATH, { content: BASE, sha256: shaOf(BASE) });
  const live = liveBridge(BASE);
  const store = new TextCardStore({ saveMode });
  store.attachEditor(live.bridge);
  await store.openPath(PATH);
  live.state.text = OURS;
  store.noteEdit();
  expect(store.getSnapshot().saveState).toBe("editing");
  io.writes = [];
  return { store, live };
}

/** The agent writes `content` straight to disk, behind the store's back. */
function externalWrite(content: string) {
  io.files.set(PATH, { content, sha256: shaOf(content) });
}

beforeEach(() => {
  io.files = new Map();
  io.writes = [];
  io.writeError = null;
});

describe("a distant external edit merges, in both modes", () => {
  for (const saveMode of ["automatic", "manual"] as const) {
    test(`${saveMode}: the buffer carries both edits and stays dirty`, async () => {
      const { store, live } = await dirtyOnBase(saveMode);
      externalWrite(THEIRS);
      deliverState(store);
      await settleLook();

      expect(live.state.replaced).toEqual([MERGED]);
      expect(live.state.text).toBe(MERGED);
      const snap = store.getSnapshot();
      expect(snap.conflict).toBeNull();
      // Still dirty: the merged text is on nobody's disk yet.
      expect(snap.saveState).toBe("editing");
      expect(snap.seedContent).toBe(MERGED);
    });
  }

  test("the baseline moves to the disk's, so the next write is not a 409", async () => {
    const { store } = await dirtyOnBase("automatic");
    externalWrite(THEIRS);
    deliverState(store);
    await settleLook();

    io.writes = [];
    await store.flush();
    await tick();
    const write = io.writes.find((w) => w.path === PATH);
    expect(write?.baselineSha256).toBe(shaOf(THEIRS));
    expect(write?.content).toBe(MERGED);
    expect(io.files.get(PATH)?.content).toBe(MERGED);
    expect(store.getSnapshot().saveState).toBe("clean");
    expect(store.getSnapshot().conflict).toBeNull();
  });

  test("manual: the aside is re-flushed against the disk's new hash", async () => {
    const { store } = await dirtyOnBase("manual");
    externalWrite(THEIRS);
    deliverState(store);
    await settleLook();

    const aside = io.writes.filter((w) => w.path === asidePathFor(PATH));
    expect(aside.length).toBeGreaterThan(0);
    const record = JSON.parse(aside[aside.length - 1]!.content) as {
      content: string;
      baselineSha256: string | null;
    };
    expect(record.content).toBe(MERGED);
    expect(record.baselineSha256).toBe(shaOf(THEIRS));
    // The real file is untouched — manual mode saves on the user's word.
    expect(io.files.get(PATH)?.content).toBe(THEIRS);
    expect(store.getSnapshot().saveState).toBe("editing");
  });
});

describe("a touching external edit is the question, not a guess", () => {
  for (const saveMode of ["automatic", "manual"] as const) {
    test(`${saveMode}: conflict "hash", and the buffer is left alone`, async () => {
      const { store, live } = await dirtyOnBase(saveMode);
      externalWrite(THEIRS_TOUCHING);
      deliverState(store);
      await settleLook();

      expect(live.state.replaced).toEqual([]);
      expect(live.state.text).toBe(OURS);
      const snap = store.getSnapshot();
      expect(snap.conflict).toEqual({
        reason: "hash",
        diskSha256: shaOf(THEIRS_TOUCHING),
      });
      expect(snap.saveState).toBe("editing");
    });
  }
});

describe("no ancestor is no merge", () => {
  test("after Save Anyway, before its write settles, a frame conflicts", async () => {
    const { store, live } = await dirtyOnBase("automatic");
    externalWrite(THEIRS_TOUCHING);
    deliverState(store);
    await settleLook();
    expect(store.getSnapshot().conflict).not.toBeNull();

    // Save Anyway adopts the disk HASH with no text behind it. The write
    // that would restore the pairing fails, so the store sits with a
    // baseline sha and no baseline text — exactly the window [P08] names.
    io.writeError = "error";
    await store.resolveConflict("overwrite");
    await settleLook();
    expect(store.getSnapshot().saveState).toBe("editing");
    expect(store.getSnapshot().conflict).toBeNull();
    live.state.replaced = [];

    // An edit that WOULD merge cleanly against `BASE`. With no ancestor
    // there is nothing to merge over, so it asks rather than guessing.
    externalWrite(THEIRS);
    deliverState(store);
    await settleLook();

    expect(live.state.replaced).toEqual([]);
    expect(store.getSnapshot().conflict).toEqual({
      reason: "hash",
      diskSha256: shaOf(THEIRS),
    });
  });
});

describe("recheckOnActivation takes the same rung", () => {
  test("automatic: an activation merges a distant edit it never heard about", async () => {
    const { store, live } = await dirtyOnBase("automatic");
    externalWrite(THEIRS);

    await store.recheckOnActivation();
    await settleLook();

    expect(live.state.text).toBe(MERGED);
    expect(store.getSnapshot().conflict).toBeNull();
    expect(store.getSnapshot().saveState).toBe("editing");
  });
});
