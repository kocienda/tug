/**
 * text-card-store.manual.test.ts — manual save mode: dirty transitions,
 * aside flush targeting, untitled buffers, and open-time aside restore.
 *
 * `file-io` is mocked with a faithful in-memory filesystem (conditional
 * writes, create-new, delete) so both the store's real-file path and the
 * aside writer's path are exercised deterministically. Reads/writes are
 * keyed by path, so a test can assert exactly which file was touched.
 */

import { describe, test, expect, mock, beforeAll, beforeEach } from "bun:test";

import type { FileWatchState } from "@/lib/file-watch-client";

interface WriteCall {
  path: string;
  content: string;
  baselineSha256: string | null;
  delete: boolean;
}

/**
 * One file in the fake filesystem. `ino` models the file's identity: a rename
 * carries it to the new path, an unlink-and-recreate mints a new one — the
 * same two facts `fs_read`'s unit tests pin against a real filesystem.
 */
interface FakeFile {
  content: string;
  sha256: string;
  readOnly: boolean;
  ino?: number;
}

const io = {
  files: new Map<string, FakeFile>(),
  writes: [] as WriteCall[],
  // When set, the next non-delete write to any path fails with this
  // transport error (models a `denied`/`error`/network failure the plain
  // conditional-write fake can't otherwise produce).
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
        readOnly: file.readOnly,
        // A file with no `ino` models a server that reports no identity, so
        // the store falls back to hash matching exactly as on non-unix.
        ...(file.ino === undefined ? {} : { dev: 1, ino: file.ino }),
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
    if (existing && req.baselineSha256 === null) {
      return { ok: false, error: "conflict", diskSha256: existing.sha256 };
    }
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
    io.files.set(req.path, {
      content: req.content,
      sha256: sha,
      readOnly: existing?.readOnly ?? false,
    });
    return { ok: true, sha256: sha, mtimeMs: 0 };
  },
}));

let TextCardStore: typeof import("@/lib/text-card-store").TextCardStore;
let MISSING_SETTLE_MS: number;
let arcSuccessorPath: typeof import("@/lib/text-card-store").arcSuccessorPath;
let asidePathFor: typeof import("@/lib/file-aside").asidePathFor;
let asidePathForUntitled: typeof import("@/lib/file-aside").asidePathForUntitled;
beforeAll(async () => {
  ({ TextCardStore, MISSING_SETTLE_MS, arcSuccessorPath } = await import(
    "@/lib/text-card-store"
  ));
  ({ asidePathFor, asidePathForUntitled } = await import("@/lib/file-aside"));
});

function bridge(getText: () => string, onReplace?: (t: string) => void) {
  return {
    getText,
    replaceText: (t: string) => onReplace?.(t),
    getPositions: () => ({ anchor: { line: 1, ch: 0 }, scrollTop: 0 }),
    applyPositions: () => {},
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
/**
 * Wait past the missing-verdict settle window, then let the re-probe's
 * read resolve. An absent path is never a verdict on first sight.
 */
const settle = async () => {
  await new Promise((r) => setTimeout(r, MISSING_SETTLE_MS + 20));
  await tick();
};

/**
 * Deliver one FILE_WATCH state for the store's own path, as the service
 * would.
 *
 * Straight into the store rather than through the client's module-level
 * delivery: the client dispatches by path to every listener it holds, and
 * these tests open many stores on the same path without disposing them, so
 * a shared delivery would wake stores from earlier tests. What is under
 * test here is the decision table, not the dispatch — `file-watch-client`'s
 * own suite covers that.
 *
 * `seq` climbs globally, which is what the real service does.
 */
let watchSeq = 0;
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

/** The service saw our file, and it is there. */
const deliverPresent = (store: InstanceType<typeof TextCardStore>) =>
  deliverState(store);

/** The service looked and the path was gone; `created` is the window's. */
const deliverAbsent = (
  store: InstanceType<typeof TextCardStore>,
  created: string[] = [],
) => deliverState(store, { state: "absent", sha256: null, size: null, created });

function seedDisk(path: string, content: string, readOnly = false) {
  io.files.set(path, { content, sha256: shaOf(content), readOnly });
}
/** Seed a file that also reports a filesystem identity. */
function seedIdentifiedDisk(path: string, content: string, ino: number) {
  io.files.set(path, { content, sha256: shaOf(content), readOnly: false, ino });
}
/** Move a file to `to`, carrying its identity — what a real rename does. */
function renameDisk(from: string, to: string, content?: string) {
  const file = io.files.get(from)!;
  io.files.delete(from);
  io.files.set(to, {
    ...file,
    ...(content === undefined
      ? {}
      : { content, sha256: shaOf(content) }),
  });
}
function seedAside(path: string, record: Record<string, unknown>) {
  const json = JSON.stringify(record);
  io.files.set(path, { content: json, sha256: shaOf(json), readOnly: false });
}

beforeEach(() => {
  io.files = new Map();
  io.writes = [];
  io.writeError = null;
});

describe("manual mode — dirty + aside flush target", () => {
  test("default mode is automatic; manual is opt-in", () => {
    expect(new TextCardStore().getSnapshot().saveMode).toBe("automatic");
    expect(
      new TextCardStore({ saveMode: "manual" }).getSnapshot().saveMode,
    ).toBe("manual");
  });

  test("an edit writes the aside, never the real file", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt");
    expect(store.getSnapshot().saveState).toBe("clean");

    buf = "disk edited\n";
    store.noteEdit();
    expect(store.getSnapshot().saveState).toBe("editing");
    await store.flush();
    await tick();

    // Real file untouched; buffer stays dirty.
    expect(io.files.get("/f.txt")!.content).toBe("disk\n");
    expect(store.getSnapshot().saveState).toBe("editing");
    // Aside carries the edit + its baseline.
    const aside = io.files.get(asidePathFor("/f.txt"));
    expect(aside).toBeDefined();
    const rec = JSON.parse(aside!.content);
    expect(rec.content).toBe("disk edited\n");
    expect(rec.baselineSha256).toBe(shaOf("disk\n"));
    // The only real-path we ever touched is the aside.
    expect(io.writes.every((w) => w.path === asidePathFor("/f.txt"))).toBe(true);
  });

  test("a rebind (saveAs) preserves the manual mode", async () => {
    seedDisk("/a.txt", "content\n");
    let buf = "content\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/a.txt");
    buf = "content edited\n";
    store.noteEdit();
    await store.saveAs("/b.txt");
    expect(store.getSnapshot().saveMode).toBe("manual");
    expect(store.getSnapshot().path).toBe("/b.txt");
  });

  test("saveAs rebinds in place — phase never leaves ready (no flash)", async () => {
    seedDisk("/old.txt", "content\n");
    seedDisk("/target.txt", "existing target\n");
    let buf = "content\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/old.txt");
    buf = "content edited\n";
    store.noteEdit();
    // Record every phase the snapshot passes through during the Save As.
    // A drop to "loading"/"empty" unmounts the live editor (losing undo,
    // caret, scroll) and flashes the chooser in the card.
    const phases: string[] = [];
    const unsub = store.subscribe(() => phases.push(store.getSnapshot().phase));
    // Target exists (the NSSavePanel Replace flow): create-new conflicts,
    // the retry overwrites.
    expect(await store.saveAs("/target.txt")).toBe("ok");
    unsub();
    expect(phases.every((p) => p === "ready")).toBe(true);
    const snap = store.getSnapshot();
    expect(snap.path).toBe("/target.txt");
    expect(snap.fileName).toBe("target.txt");
    expect(snap.saveState).toBe("clean");
    expect(io.files.get("/target.txt")!.content).toBe("content edited\n");
    // The next save round-trips against the rebound baseline: one clean
    // conditional write, no spurious conflict.
    buf = "content edited more\n";
    store.noteEdit();
    expect(await store.save()).toBe("ok");
    expect(io.files.get("/target.txt")!.content).toBe("content edited more\n");
  });

  test("saveAs reports 'ok' once the buffer reaches disk", async () => {
    let buf = "hello\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openUntitled("draft-1");
    buf = "hello\n";
    store.noteEdit();
    expect(await store.saveAs("/new.txt")).toBe("ok");
    expect(io.files.get("/new.txt")!.content).toBe("hello\n");
  });

  test("saveAs surfaces a write failure instead of swallowing it", async () => {
    // A swallowed failure here is the data-loss path: a close guard that
    // reads saveAs as success would destroy the card over unsaved edits.
    let buf = "hello\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openUntitled("draft-2");
    buf = "hello\n";
    store.noteEdit();
    io.writeError = "denied";
    expect(await store.saveAs("/nope.txt")).toBe("error");
    expect(io.files.has("/nope.txt")).toBe(false);
  });

  test("a double save issues one real write, not a spurious conflict", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt");
    buf = "edited\n";
    store.noteEdit();
    // Two concurrent saves (double ⌘S / menu racing keyboard). Without the
    // single-flight latch the second reissues a write against the stale
    // baseline the first just changed → a 409 conflict for our own bytes.
    const [r1, r2] = await Promise.all([store.save(), store.save()]);
    expect(r1).toBe("ok");
    expect(r2).toBe("ok");
    const realWrites = io.writes.filter((w) => w.path === "/f.txt" && !w.delete);
    expect(realWrites.length).toBe(1);
    expect(store.getSnapshot().conflict).toBeNull();
    expect(store.getSnapshot().saveState).toBe("clean");
  });

  test("setLineEnding during an in-flight save re-flushes, staying dirty", async () => {
    seedDisk("/f.txt", "a\nb\n");
    let buf = "a\nb\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt");
    buf = "a\nb\nc\n";
    store.noteEdit();
    const saving = store.save(); // now in "writing"
    expect(store.getSnapshot().saveState).toBe("writing");
    store.setLineEnding("CRLF"); // must not be dropped mid-save
    await saving;
    // The write serialized the old ending, so the buffer stays dirty with
    // the new ending recorded — never clean-with-the-wrong-ending on disk.
    expect(store.getSnapshot().lineEnding).toBe("CRLF");
    expect(store.getSnapshot().saveState).toBe("editing");
  });

  test("resolveMissing recreates a deleted file", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt");
    buf = "edited\n";
    store.noteEdit();
    io.files.delete("/f.txt");
    await store.refreshFromDisk();
    await settle();
    expect(store.getSnapshot().conflict?.reason).toBe("missing");
    expect(await store.resolveMissing()).toBe("ok");
    expect(io.files.get("/f.txt")!.content).toBe("edited\n");
    expect(store.getSnapshot().conflict).toBeNull();
  });

  test("resolveMissing conflicts instead of clobbering a reappeared file", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt");
    buf = "edited\n";
    store.noteEdit();
    io.files.delete("/f.txt");
    await store.refreshFromDisk();
    await settle();
    expect(store.getSnapshot().conflict?.reason).toBe("missing");
    // Another process recreated the file meanwhile.
    seedDisk("/f.txt", "FOREIGN\n");
    expect(await store.resolveMissing()).toBe("conflict");
    expect(store.getSnapshot().conflict?.reason).toBe("hash");
    expect(io.files.get("/f.txt")!.content).toBe("FOREIGN\n"); // not clobbered
  });

  test("conflict reload clears the armed debounce (no aside resurrection)", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt");
    buf = "mine\n";
    store.noteEdit();
    await store.flush();
    await tick();
    seedDisk("/f.txt", "theirs\n");
    await store.recheckOnActivation();
    expect(store.getSnapshot().conflict?.reason).toBe("hash");
    // Typing during the cancelled conflict arms the aside debounce; the
    // reload must clear it, or a late fire recreates the aside holding the
    // edits the user just discarded.
    buf = "mine plus more\n";
    store.noteEdit();
    await store.resolveConflict("reload");
    const timer = (store as unknown as { _debounceTimer: unknown })._debounceTimer;
    expect(timer).toBeNull();
    expect(io.files.has(asidePathFor("/f.txt"))).toBe(false);
    expect(store.getSnapshot().saveState).toBe("clean");
  });

  test("a missing conflict on a clean buffer goes dirty on the next edit", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt");
    // File deleted under a CLEAN buffer — the watcher path sets the
    // conflict without touching saveState.
    io.files.delete("/f.txt");
    deliverAbsent(store);
    await settle();
    expect(store.getSnapshot().conflict?.reason).toBe("missing");
    expect(store.getSnapshot().saveState).toBe("clean");
    // The user cancels the sheet and types: the buffer must read dirty and
    // the aside must capture — otherwise the close guard sees clean and
    // destroys the edits silently.
    buf = "typed after cancel\n";
    store.noteEdit();
    expect(store.getSnapshot().saveState).toBe("editing");
    await store.flush();
    await tick();
    const aside = JSON.parse(io.files.get(asidePathFor("/f.txt"))!.content);
    expect(aside.content).toBe("typed after cancel\n");
  });

  test("resolveMissing recreates the file even from a clean buffer", async () => {
    seedDisk("/f.txt", "disk\n");
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => "disk\n"));
    await store.openPath("/f.txt");
    io.files.delete("/f.txt");
    deliverAbsent(store);
    await settle();
    expect(store.getSnapshot().conflict?.reason).toBe("missing");
    expect(store.getSnapshot().saveState).toBe("clean");
    // "Save" in the missing sheet means RECREATE — it must not no-op on
    // save()'s clean short-circuit.
    expect(await store.resolveMissing()).toBe("ok");
    expect(io.files.get("/f.txt")!.content).toBe("disk\n");
    expect(store.getSnapshot().conflict).toBeNull();
    expect(store.getSnapshot().saveState).toBe("clean");
  });

  test("edits during a cancelled conflict still reach the aside", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt");
    buf = "mine\n";
    store.noteEdit();
    await store.flush();
    await tick();
    // External change raises a hash conflict; the user cancels (leaves it set).
    seedDisk("/f.txt", "theirs\n");
    await store.recheckOnActivation();
    expect(store.getSnapshot().conflict?.reason).toBe("hash");
    // The user keeps typing during the cancelled conflict.
    buf = "mine plus more\n";
    store.noteEdit();
    await store.flush();
    await tick();
    // The aside captured the new edits (crash-safety) — real file untouched.
    const aside = JSON.parse(io.files.get(asidePathFor("/f.txt"))!.content);
    expect(aside.content).toBe("mine plus more\n");
    expect(io.files.get("/f.txt")!.content).toBe("theirs\n");
  });
});

describe("manual mode — open-time aside restore", () => {
  test("matching baseline restores the aside silently, dirty", async () => {
    seedDisk("/f.txt", "disk\n");
    seedAside(asidePathFor("/f.txt"), {
      version: 1,
      path: "/f.txt",
      draftId: null,
      content: "my edits\n",
      lineEnding: "LF",
      baselineSha256: shaOf("disk\n"),
      editedAt: 1,
    });
    let buf = "";
    const replaced: string[] = [];
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t) && replaced.push(t)));
    await store.openPath("/f.txt");

    expect(store.getSnapshot().saveState).toBe("editing");
    expect(store.getSnapshot().seedContent).toBe("my edits\n");
    expect(replaced).toContain("my edits\n");
  });

  test("diverged baseline surfaces pendingAsideConflict; both resolver arms", async () => {
    seedDisk("/f.txt", "disk now\n");
    seedAside(asidePathFor("/f.txt"), {
      version: 1,
      path: "/f.txt",
      draftId: null,
      content: "my edits\n",
      lineEnding: "LF",
      baselineSha256: shaOf("disk OLD\n"),
      editedAt: 1,
    });
    let buf = "";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");

    // Buffer shows disk; the aside awaits a decision.
    expect(store.getSnapshot().saveState).toBe("clean");
    const pending = store.getSnapshot().pendingAsideConflict;
    expect(pending?.asideContent).toBe("my edits\n");

    // Keep My Changes → dirty, seeded from the aside.
    store.resolveAsideConflict("keep");
    expect(store.getSnapshot().saveState).toBe("editing");
    expect(store.getSnapshot().seedContent).toBe("my edits\n");
    expect(store.getSnapshot().pendingAsideConflict).toBeNull();
  });

  test("Use Disk Version discards the aside", async () => {
    seedDisk("/f.txt", "disk now\n");
    seedAside(asidePathFor("/f.txt"), {
      version: 1,
      path: "/f.txt",
      draftId: null,
      content: "my edits\n",
      lineEnding: "LF",
      baselineSha256: shaOf("disk OLD\n"),
      editedAt: 1,
    });
    let buf = "";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");

    store.resolveAsideConflict("disk");
    await tick();
    expect(store.getSnapshot().pendingAsideConflict).toBeNull();
    expect(store.getSnapshot().saveState).toBe("clean");
    expect(io.files.has(asidePathFor("/f.txt"))).toBe(false);
  });

  test("a corrupt aside is deleted; the open proceeds clean", async () => {
    seedDisk("/f.txt", "disk\n");
    // Unparseable content → corrupt → safe to delete.
    io.files.set(asidePathFor("/f.txt"), {
      content: "{ not json",
      sha256: shaOf("{ not json"),
      readOnly: false,
    });
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => "disk\n"));
    await store.openPath("/f.txt");
    await tick();
    expect(store.getSnapshot().saveState).toBe("clean");
    expect(io.files.has(asidePathFor("/f.txt"))).toBe(false);
  });

  test("a foreign (wrong-path) aside is preserved, not deleted", async () => {
    seedDisk("/f.txt", "disk\n");
    // A valid aside keyed to a different path is a key collision belonging
    // to another document — leave it on disk, open clean, don't restore it.
    seedAside(asidePathFor("/f.txt"), {
      version: 1,
      path: "/OTHER.txt",
      draftId: null,
      content: "junk\n",
      lineEnding: "LF",
      baselineSha256: shaOf("x"),
      editedAt: 1,
    });
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => "disk\n"));
    await store.openPath("/f.txt");
    await tick();
    expect(store.getSnapshot().saveState).toBe("clean");
    expect(io.files.has(asidePathFor("/f.txt"))).toBe(true);
  });
});

describe("manual mode — untitled buffers", () => {
  test("untitled writes only the aside; restores by draftId", async () => {
    let buf = "";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openUntitled("d1");
    const snap = store.getSnapshot();
    expect(snap.phase).toBe("ready");
    expect(snap.path).toBeNull();
    expect(snap.untitled).toBe(true);
    expect(snap.fileName).toBe("Untitled");

    buf = "hello\n";
    store.noteEdit();
    await store.flush();
    await tick();

    const asidePath = asidePathForUntitled("d1");
    expect(io.files.has(asidePath)).toBe(true);
    // No file anywhere but the aside.
    expect(io.writes.every((w) => w.path === asidePath)).toBe(true);

    // A fresh store restores the untitled buffer from the aside.
    let buf2 = "";
    const replaced: string[] = [];
    const store2 = new TextCardStore({ saveMode: "manual" });
    store2.attachEditor(bridge(() => buf2, (t) => replaced.push(t)));
    await store2.openUntitled("d1");
    expect(store2.getSnapshot().saveState).toBe("editing");
    expect(store2.getSnapshot().seedContent).toBe("hello\n");
    expect(replaced).toContain("hello\n");
  });
});

describe("manual mode — save verbs", () => {
  test("save() writes the real file, deletes the aside, goes clean", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt");

    buf = "saved content\n";
    store.noteEdit();
    await store.flush(); // writes aside
    await tick();
    expect(io.files.has(asidePathFor("/f.txt"))).toBe(true);

    const result = await store.save();
    expect(result).toBe("ok");
    expect(io.files.get("/f.txt")!.content).toBe("saved content\n");
    expect(store.getSnapshot().saveState).toBe("clean");
    expect(io.files.has(asidePathFor("/f.txt"))).toBe(false);
  });

  test("save() on an untitled buffer asks the card for a path", async () => {
    const store = new TextCardStore({ saveMode: "manual" });
    let buf = "";
    store.attachEditor(bridge(() => buf));
    await store.openUntitled("d1");
    buf = "hi\n";
    store.noteEdit();
    expect(await store.save()).toBe("needs-path");
  });

  test("save() on a stale baseline yields a conflict, keeping the aside", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt");
    buf = "my edit\n";
    store.noteEdit();
    await store.flush();
    await tick();

    // Someone else changes disk out from under us.
    seedDisk("/f.txt", "foreign\n");
    const result = await store.save();
    expect(result).toBe("conflict");
    expect(store.getSnapshot().conflict?.reason).toBe("hash");
    expect(io.files.has(asidePathFor("/f.txt"))).toBe(true);
    // Real file NOT overwritten.
    expect(io.files.get("/f.txt")!.content).toBe("foreign\n");
  });

  test("resolveConflict('overwrite') writes the REAL file, not the aside ([P12])", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt");
    buf = "my edit\n";
    store.noteEdit();
    await store.flush();
    await tick();
    seedDisk("/f.txt", "foreign\n");
    await store.save(); // raises hash conflict
    expect(store.getSnapshot().conflict?.reason).toBe("hash");

    io.writes = []; // isolate the overwrite's writes
    await store.resolveConflict("overwrite");

    // The overwrite hit the REAL path (never the aside path).
    const realWrites = io.writes.filter(
      (w) => w.path === "/f.txt" && !w.delete,
    );
    expect(realWrites).toHaveLength(1);
    expect(io.files.get("/f.txt")!.content).toBe("my edit\n");
    expect(store.getSnapshot().saveState).toBe("clean");
    expect(io.files.has(asidePathFor("/f.txt"))).toBe(false);
  });

  test("resolveConflict('reload') discards edits + aside, reloads disk", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");
    buf = "my edit\n";
    store.noteEdit();
    await store.flush();
    await tick();
    seedDisk("/f.txt", "foreign\n");
    await store.save();
    await store.resolveConflict("reload");

    expect(store.getSnapshot().saveState).toBe("clean");
    expect(store.getSnapshot().conflict).toBeNull();
    expect(buf).toBe("foreign\n"); // buffer reloaded from disk
    expect(io.files.has(asidePathFor("/f.txt"))).toBe(false);
  });

  test("saveACopy() writes elsewhere without touching state or the aside", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf));
    await store.openPath("/f.txt");
    buf = "my edit\n";
    store.noteEdit();
    await store.flush();
    await tick();

    expect(await store.saveACopy("/copy.txt")).toBe("ok");
    expect(io.files.get("/copy.txt")!.content).toBe("my edit\n");
    // Original binding + dirty + aside all unchanged.
    expect(store.getSnapshot().path).toBe("/f.txt");
    expect(store.getSnapshot().saveState).toBe("editing");
    expect(io.files.has(asidePathFor("/f.txt"))).toBe(true);
  });

  test("revertToSaved() drops edits and the aside", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");
    buf = "my edit\n";
    store.noteEdit();
    await store.flush();
    await tick();

    await store.revertToSaved();
    expect(store.getSnapshot().saveState).toBe("clean");
    expect(buf).toBe("disk\n");
    expect(io.files.has(asidePathFor("/f.txt"))).toBe(false);
  });

  test("a watcher frame while dirty raises the conflict without a write", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");
    buf = "my edit\n";
    store.noteEdit();
    await store.flush();
    await tick();

    // Disk changes externally; the watcher frame arrives.
    seedDisk("/f.txt", "foreign\n");
    io.writes = [];
    deliverPresent(store);
    await tick();

    expect(store.getSnapshot().conflict?.reason).toBe("hash");
    // No real-file write happened as a side effect.
    expect(io.writes.filter((w) => w.path === "/f.txt" && !w.delete)).toHaveLength(0);
  });
});

describe("rename-follow ([P05])", () => {
  test("an explicit Renamed{from,to} rebinds the card", async () => {
    seedDisk("/a.txt", "body\n");
    let buf = "body\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/a.txt");
    deliverState(store, { state: "absent", sha256: null, renamedTo: "/b.txt" });
    await tick();
    expect(store.getSnapshot().path).toBe("/b.txt");
    expect(store.getSnapshot().fileName).toBe("b.txt");
  });

  test("a Removed+Created batch adopts the hash-matching creation, preserving dirty", async () => {
    seedDisk("/a.txt", "body\n");
    let buf = "body\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/a.txt");
    // Dirty: edits live only in the buffer; the moved file still hashes
    // to the last-saved baseline.
    buf = "body edited\n";
    store.noteEdit();
    await store.flush();
    await tick();

    // macOS: the file moves to /moved.txt (same bytes, different dir).
    seedDisk("/moved.txt", "body\n");
    io.files.delete("/a.txt");
    deliverAbsent(store, ["/moved.txt"]);
    await tick();

    expect(store.getSnapshot().path).toBe("/moved.txt");
    expect(store.getSnapshot().saveState).toBe("editing"); // dirty preserved
    // Aside re-keyed to the new path.
    expect(io.files.has(asidePathFor("/moved.txt"))).toBe(true);
  });

  test("an ambiguous / non-matching batch falls to the missing-file flow", async () => {
    seedDisk("/a.txt", "body\n");
    let buf = "body\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/a.txt");

    // Two unrelated creations, neither hash-matching → no adoption.
    seedDisk("/x.txt", "different\n");
    seedDisk("/y.txt", "other\n");
    io.files.delete("/a.txt");
    deliverAbsent(store, ["/x.txt", "/y.txt"]);
    await settle();

    expect(store.getSnapshot().path).toBe("/a.txt"); // not rebound
    expect(store.getSnapshot().conflict?.reason).toBe("missing");
  });
});

describe("recheckOnActivation ([P09])", () => {
  test("clean + diverged disk → silent reload", async () => {
    seedDisk("/f.txt", "v1\n");
    let buf = "v1\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");

    seedDisk("/f.txt", "v2 external\n");
    await store.recheckOnActivation();
    expect(buf).toBe("v2 external\n");
    expect(store.getSnapshot().saveState).toBe("clean");
    expect(store.getSnapshot().conflict).toBeNull();
  });

  test("manual + dirty + diverged disk → conflict", async () => {
    seedDisk("/f.txt", "v1\n");
    let buf = "v1\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");
    buf = "my edit\n";
    store.noteEdit();
    await store.flush();
    await tick();

    seedDisk("/f.txt", "external\n");
    await store.recheckOnActivation();
    expect(store.getSnapshot().conflict?.reason).toBe("hash");
    expect(buf).toBe("my edit\n"); // buffer untouched
  });
});

describe("automatic mode — unchanged", () => {
  test("an edit writes the real file and no aside", async () => {
    seedDisk("/a.txt", "x\n");
    let buf = "x\n";
    const store = new TextCardStore();
    store.attachEditor(bridge(() => buf));
    await store.openPath("/a.txt");

    buf = "x edited\n";
    store.noteEdit();
    await store.flush();
    await tick();

    expect(io.files.get("/a.txt")!.content).toBe("x edited\n");
    expect(store.getSnapshot().saveState).toBe("clean");
    expect(io.files.has(asidePathFor("/a.txt"))).toBe(false);
  });
});

describe("replace-in-place — the classification ladder", () => {
  test("a same-path remove+create over a clean buffer adopts the new bytes", async () => {
    seedDisk("/f.txt", "before\n");
    let buf = "before\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");

    // git unlinks and recreates: the path never stops existing for us.
    seedDisk("/f.txt", "joined\n");
    deliverAbsent(store, ["/f.txt"]);
    await tick();
    await tick();

    expect(store.getSnapshot().conflict).toBeNull();
    expect(store.getSnapshot().path).toBe("/f.txt");
    expect(buf).toBe("joined\n");
    expect(store.getSnapshot().saveState).toBe("clean");
  });

  test("the same batch over a dirty manual buffer adjudicates by hash", async () => {
    seedDisk("/f.txt", "before\n");
    let buf = "before\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");
    buf = "mine\n";
    store.noteEdit();

    seedDisk("/f.txt", "joined\n");
    deliverAbsent(store, ["/f.txt"]);
    await tick();
    await tick();

    expect(store.getSnapshot().conflict?.reason).toBe("hash");
    expect(buf).toBe("mine\n"); // never clobbered
  });

  test("a genuinely gone file waits out the settle window before verdicting", async () => {
    seedDisk("/f.txt", "body\n");
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => "body\n"));
    await store.openPath("/f.txt");

    io.files.delete("/f.txt");
    deliverAbsent(store);
    await tick();
    await tick();
    expect(store.getSnapshot().conflict).toBeNull();

    await settle();
    expect(store.getSnapshot().conflict?.reason).toBe("missing");
  });

  test("a file that returns inside the settle window never verdicts", async () => {
    seedDisk("/f.txt", "body\n");
    let buf = "body\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");

    io.files.delete("/f.txt");
    deliverAbsent(store);
    await tick();
    await tick();
    // The checkout finishes and the file lands again before the re-probe.
    seedDisk("/f.txt", "restored\n");

    await settle();
    expect(store.getSnapshot().conflict).toBeNull();
    expect(buf).toBe("restored\n");
  });

  test("a save refused as missing over a present file is a conflict, not a delete", async () => {
    seedDisk("/f.txt", "v1\n");
    let buf = "v1\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");
    buf = "mine\n";
    store.noteEdit();

    // The write lands inside the unlink window: the server sees no file and
    // refuses. By the time we look, git has put the new content there.
    io.files.delete("/f.txt");
    const result = store.save();
    // The write's existence check already ran; git lands the merged bytes
    // before the ladder gets to look.
    seedDisk("/f.txt", "joined\n");

    expect(await result).toBe("conflict");
    expect(store.getSnapshot().conflict?.reason).toBe("hash");
    expect(store.getSnapshot().conflict?.diskSha256).toBe(shaOf("joined\n"));
  });

  test("a state deferred by a write still runs when the write conflicts", async () => {
    seedDisk("/f.txt", "v1\n");
    let buf = "v1\n";
    const store = new TextCardStore();
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");

    buf = "mine\n";
    store.noteEdit();
    // Someone else writes first, so our conditional write will 409.
    seedDisk("/f.txt", "theirs\n");
    const flushed = store.flush();
    // A frame arrives mid-write. Mid-write the baseline is about to move,
    // so the comparison is ordered after the settle rather than made
    // against a hash we are in the middle of replacing.
    deliverPresent(store);
    expect(
      (store as unknown as { _deferredState: unknown })._deferredState,
    ).not.toBeNull();

    await flushed;
    await tick();
    await tick();
    expect(
      (store as unknown as { _deferredState: unknown })._deferredState,
    ).toBeNull();
    expect(store.getSnapshot().conflict?.reason).toBe("hash");
  });
});

describe("rename-follow by file identity", () => {
  test("a move that also edited the file is still followed", async () => {
    seedIdentifiedDisk("/a.txt", "body\n", 41);
    let buf = "body\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/a.txt");

    // The move carries the file's identity but not its hash — the case the
    // old baseline-hash match could never recognize.
    renameDisk("/a.txt", "/moved.txt", "body, edited elsewhere\n");
    deliverAbsent(store, ["/moved.txt"]);
    await tick();
    await tick();

    expect(store.getSnapshot().path).toBe("/moved.txt");
    expect(store.getSnapshot().conflict).toBeNull();
  });

  test("a renamed-and-edited file is followed even under a new basename", async () => {
    seedIdentifiedDisk("/a.txt", "body\n", 42);
    let buf = "body\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/a.txt");

    // Neither the basename nor the hash matches; only the identity does.
    renameDisk("/a.txt", "/renamed-entirely.md", "different now\n");
    deliverAbsent(store, ["/unrelated.txt", "/renamed-entirely.md"]);
    await tick();
    await tick();

    expect(store.getSnapshot().path).toBe("/renamed-entirely.md");
    expect(store.getSnapshot().conflict).toBeNull();
  });

  test("identity picks the right file when two candidates share content", async () => {
    seedIdentifiedDisk("/a.txt", "same bytes\n", 43);
    let buf = "same bytes\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/a.txt");

    // A decoy with identical content — a hash match would have taken whichever
    // it read first. The identity says which one is actually ours.
    seedIdentifiedDisk("/decoy.txt", "same bytes\n", 99);
    renameDisk("/a.txt", "/real.txt");
    deliverAbsent(store, ["/decoy.txt", "/real.txt"]);
    await tick();
    await tick();

    expect(store.getSnapshot().path).toBe("/real.txt");
  });

  test("with no identity reported, the hash match is unchanged", async () => {
    // No `ino` anywhere: the pre-identity world, and the narrow candidate rule.
    seedDisk("/a.txt", "body\n");
    let buf = "body\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/a.txt");

    io.files.delete("/a.txt");
    seedDisk("/sub/a.txt", "body\n");
    deliverAbsent(store, ["/sub/a.txt"]);
    await tick();
    await tick();

    expect(store.getSnapshot().path).toBe("/sub/a.txt");
    expect(store.getSnapshot().conflict).toBeNull();
  });

  test("a replace-in-place is never mistaken for a move to a new inode", async () => {
    seedIdentifiedDisk("/f.txt", "before\n", 51);
    let buf = "before\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");

    // git unlinks and recreates: same path, NEW identity. The ladder settles
    // this by probing the path, never by matching identity.
    seedIdentifiedDisk("/f.txt", "joined\n", 52);
    deliverAbsent(store, ["/f.txt"]);
    await tick();
    await tick();

    expect(store.getSnapshot().path).toBe("/f.txt");
    expect(store.getSnapshot().conflict).toBeNull();
    expect(buf).toBe("joined\n");
  });
});

describe("arc-worktree retirement", () => {
  test("arcSuccessorPath names the repo-root successor, or nothing", () => {
    expect(arcSuccessorPath("/repo/.tug/worktrees/myarc/src/x.ts")).toBe(
      "/repo/src/x.ts",
    );
    // Nested relative paths keep their whole shape.
    expect(
      arcSuccessorPath("/repo/.tug/worktrees/d/a/b/c/deep.md"),
    ).toBe("/repo/a/b/c/deep.md");
    // Worktrees nest — an arc cut inside another arc's worktree. The
    // enclosing one is the innermost, so the successor stays inside the outer
    // worktree rather than escaping to the real repo root.
    expect(
      arcSuccessorPath("/repo/.tug/worktrees/outer/.tug/worktrees/inner/src/x.ts"),
    ).toBe("/repo/.tug/worktrees/outer/src/x.ts");
    // Not in a worktree at all.
    expect(arcSuccessorPath("/repo/src/x.ts")).toBeNull();
    // The worktree root itself is not a file with a successor.
    expect(arcSuccessorPath("/repo/.tug/worktrees/myarc")).toBeNull();
    expect(arcSuccessorPath("/repo/.tug/worktrees/myarc/")).toBeNull();
    // A `.tug/worktrees` that is not the arc-home shape.
    expect(arcSuccessorPath("/repo/.tug/worktrees")).toBeNull();
    // The legacy home is deliberately not followed.
    expect(arcSuccessorPath("/repo/.tugtree/tugdash__d/src/x.ts")).toBeNull();
  });

  test("a clean card re-anchors to the successor when the worktree is torn down", async () => {
    const inArc = "/repo/.tug/worktrees/myarc/src/x.ts";
    seedDisk(inArc, "arc version\n");
    let buf = "arc version\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath(inArc);

    // The join squashes the work onto the repo root and removes the worktree.
    seedDisk("/repo/src/x.ts", "joined version\n");
    io.files.delete(inArc);
    deliverAbsent(store);
    await tick();
    await tick();
    await tick();

    expect(store.getSnapshot().path).toBe("/repo/src/x.ts");
    expect(store.getSnapshot().conflict).toBeNull();
    expect(store.getSnapshot().saveState).toBe("clean");
    expect(buf).toBe("joined version\n");
  });

  test("a dirty card re-anchors and is asked about the hash, not told it was deleted", async () => {
    const inArc = "/repo/.tug/worktrees/myarc/src/y.ts";
    seedDisk(inArc, "arc version\n");
    let buf = "arc version\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath(inArc);
    buf = "my unsaved edit\n";
    store.noteEdit();

    seedDisk("/repo/src/y.ts", "joined version\n");
    io.files.delete(inArc);
    deliverAbsent(store);
    await tick();
    await tick();
    await tick();

    expect(store.getSnapshot().path).toBe("/repo/src/y.ts");
    expect(store.getSnapshot().conflict?.reason).toBe("hash");
    expect(buf).toBe("my unsaved edit\n"); // never clobbered
  });

  test("with no successor on disk, the missing verdict still arrives", async () => {
    const inArc = "/repo/.tug/worktrees/myarc/src/z.ts";
    seedDisk(inArc, "only here\n");
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => "only here\n"));
    await store.openPath(inArc);

    io.files.delete(inArc);
    deliverAbsent(store);
    await settle();

    expect(store.getSnapshot().path).toBe(inArc);
    expect(store.getSnapshot().conflict?.reason).toBe("missing");
  });
});

describe("a removed directory takes its files with it", () => {
  test("a Removed naming an ancestor directory enters the ladder", async () => {
    const inArc = "/repo/.tug/worktrees/myarc/src/w.txt";
    seedDisk(inArc, "arc version\n");
    let buf = "arc version\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath(inArc);

    seedDisk("/repo/src/w.txt", "joined version\n");
    // What `rm -rf` of a worktree actually reports: the directory, and not one
    // event per file beneath it.
    io.files.delete(inArc);
    deliverAbsent(store);
    await tick();
    await tick();
    await tick();

    expect(store.getSnapshot().path).toBe("/repo/src/w.txt");
    expect(store.getSnapshot().conflict).toBeNull();
    expect(buf).toBe("joined version\n");
  });

  test("a state for another path is not ours to act on", async () => {
    seedDisk("/repo/src/mine.txt", "mine\n");
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => "mine\n"));
    await store.openPath("/repo/src/mine.txt");

    // Which paths produce a frame at all is the service's question now: it
    // watches one directory per bound file and matches by name, so a
    // neighbour's churn never reaches this card. What the store still owes
    // is the last guard — a state whose path is not ours is dropped rather
    // than applied to whatever we happen to have open.
    deliverState(store, {
      path: "/repo/other/theirs.txt",
      state: "absent",
      sha256: null,
    });
    await settle();

    expect(store.getSnapshot().path).toBe("/repo/src/mine.txt");
    expect(store.getSnapshot().conflict).toBeNull();
  });

});

describe("a missing verdict's modality and its life", () => {
  test("a verdict raised over a clean buffer stays a banner after the user types", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");

    io.files.delete("/f.txt");
    deliverAbsent(store);
    await settle();
    expect(store.getSnapshot().conflict?.reason).toBe("missing");
    expect(store.getSnapshot().conflict?.raisedOverCleanBuffer).toBe(true);

    // `noteEdit` deliberately flips a clean buffer dirty under a conflict. The
    // latch must not follow it — otherwise a banner becomes a modal mid-word.
    buf = "typed after the banner\n";
    store.noteEdit();
    expect(store.getSnapshot().saveState).toBe("editing");
    expect(store.getSnapshot().conflict?.raisedOverCleanBuffer).toBe(true);
  });

  test("a verdict raised over a dirty buffer is modal", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");
    buf = "unsaved work\n";
    store.noteEdit();

    io.files.delete("/f.txt");
    deliverAbsent(store);
    await settle();
    expect(store.getSnapshot().conflict?.reason).toBe("missing");
    expect(store.getSnapshot().conflict?.raisedOverCleanBuffer).toBe(false);
  });

  test("the verdict clears by itself when the file comes back", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");

    io.files.delete("/f.txt");
    deliverAbsent(store);
    await settle();
    expect(store.getSnapshot().conflict?.reason).toBe("missing");

    // Someone restores it. No gesture from the user.
    seedDisk("/f.txt", "restored\n");
    deliverPresent(store);
    await tick();
    await tick();

    expect(store.getSnapshot().conflict).toBeNull();
    expect(buf).toBe("restored\n");
  });

  test("a hash conflict stays latched — only missing un-latches", async () => {
    seedDisk("/f.txt", "v1\n");
    let buf = "v1\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");
    buf = "mine\n";
    store.noteEdit();
    seedDisk("/f.txt", "theirs\n");
    await store.recheckOnActivation();
    expect(store.getSnapshot().conflict?.reason).toBe("hash");

    // More external churn must not clear a question the user hasn't answered.
    seedDisk("/f.txt", "theirs again\n");
    deliverPresent(store);
    await tick();
    await tick();
    expect(store.getSnapshot().conflict?.reason).toBe("hash");
    expect(buf).toBe("mine\n");
  });

  test("a stale missing-sheet Save adjudicates instead of dying silently", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");
    buf = "unsaved work\n";
    store.noteEdit();

    io.files.delete("/f.txt");
    deliverAbsent(store);
    await settle();
    expect(store.getSnapshot().conflict?.reason).toBe("missing");

    // The file returns while the modal is up. The verdict un-latches from
    // "missing" and the ladder raises the honest question in its place: the
    // unsaved buffer now diverges from what is on disk.
    seedDisk("/f.txt", "came back\n");
    deliverPresent(store);
    await tick();
    await tick();
    expect(store.getSnapshot().conflict?.reason).toBe("hash");

    // The "File Deleted" sheet is still on screen and the user presses Save.
    // It must produce an act or a visible reason — never a silent no-op.
    expect(await store.resolveMissing()).toBe("conflict");
    expect(io.files.get("/f.txt")!.content).toBe("came back\n"); // not clobbered
  });

  test("a stale Save over a file that came back unchanged just succeeds", async () => {
    seedDisk("/f.txt", "disk\n");
    let buf = "disk\n";
    const store = new TextCardStore({ saveMode: "manual" });
    store.attachEditor(bridge(() => buf, (t) => (buf = t)));
    await store.openPath("/f.txt");

    io.files.delete("/f.txt");
    deliverAbsent(store);
    await settle();
    expect(store.getSnapshot().conflict?.reason).toBe("missing");

    // Restored with the same bytes: nothing diverges, so the verdict simply
    // clears and the banner's Save has nothing left to do.
    seedDisk("/f.txt", "disk\n");
    deliverPresent(store);
    await tick();
    await tick();
    expect(store.getSnapshot().conflict).toBeNull();
    expect(await store.resolveMissing()).toBe("ok");
  });
});
