import { describe, expect, test } from "bun:test";
import {
  type JotsDoc,
  type JotsFrame,
  applyAddOrigins,
  applyCreate,
  applyDelete,
  applyOrder,
  applyUpdate,
  emptyDoc,
  emptyUndo,
  mergeForeignDoc,
  newJotId,
  parseJotsFrame,
  pushUndo,
  redo,
  shouldIgnoreFrame,
  jotIncipit,
  undo,
} from "../lib/jots-doc";

function doc(...ids: string[]): JotsDoc {
  return {
    version: 1,
    jots: ids.map((id) => ({ id, text: `body of ${id}` })),
  };
}

function encodeFrame(frame: JotsFrame): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(frame));
}

/** The object-replacement character an atom stands at. */
const A = "￼";

describe("document transforms", () => {
  test("applyCreate inserts after the given id", () => {
    const { doc: next, id } = applyCreate(doc("a", "b"), "a", "jt_new");
    expect(next.jots.map((s) => s.id)).toEqual(["a", "jt_new", "b"]);
    expect(id).toBe("jt_new");
  });

  test("applyCreate with null afterId appends", () => {
    const { doc: next } = applyCreate(doc("a"), null, "jt_new");
    expect(next.jots.map((s) => s.id)).toEqual(["a", "jt_new"]);
  });

  test("applyUpdate sets text", () => {
    const next = applyUpdate(doc("a"), "a", "X");
    expect(next.jots[0]).toEqual({ id: "a", text: "X" });
  });

  test("applyDelete returns successor selection", () => {
    const { doc: next, nextSelected } = applyDelete(doc("a", "b", "c"), "b");
    expect(next.jots.map((s) => s.id)).toEqual(["a", "c"]);
    expect(nextSelected).toBe("c");
  });

  test("applyDelete of last row selects the new last row", () => {
    const { nextSelected } = applyDelete(doc("a", "b"), "b");
    expect(nextSelected).toBe("a");
  });

  test("applyOrder is a splice to the given permutation", () => {
    const next = applyOrder(doc("a", "b", "c"), ["c", "a", "b"]);
    expect(next.jots.map((s) => s.id)).toEqual(["c", "a", "b"]);
  });
});

describe("undo/redo", () => {
  test("delete then undo restores the jot", () => {
    const original = doc("a", "b");
    let stack = pushUndo(emptyUndo(), original);
    const afterDelete = applyDelete(original, "a").doc;
    const undone = undo(stack, afterDelete);
    expect(undone).not.toBeNull();
    expect(undone!.doc.jots.map((s) => s.id)).toEqual(["a", "b"]);
    // redo returns to the deleted state.
    const redone = redo(undone!.stack, undone!.doc);
    expect(redone!.doc.jots.map((s) => s.id)).toEqual(["b"]);
  });

  test("a typing burst coalesces to one undo entry at commit", () => {
    // Simulate the store's begin/commit bracket: while editing, updates do not
    // push undo; commit pushes exactly one entry (the pre-edit baseline).
    const baseline = doc("a");
    let live = baseline;
    live = applyUpdate(live, "a", "h");
    live = applyUpdate(live, "a", "he");
    live = applyUpdate(live, "a", "hello");
    // Commit: push the single baseline.
    const stack = pushUndo(emptyUndo(), baseline);
    expect(stack.past.length).toBe(1);
    const undone = undo(stack, live);
    expect(undone!.doc.jots[0].text).toBe("body of a");
  });

  test("undo returns null when there is nothing to undo", () => {
    expect(undo(emptyUndo(), doc("a"))).toBeNull();
  });
});

describe("frame decisions", () => {
  test("shouldIgnoreFrame suppresses the echo of our own write", () => {
    const frame: JotsFrame = { doc: doc("a"), hash: "abc", error: null };
    expect(shouldIgnoreFrame(frame, "abc")).toBe(true);
    expect(shouldIgnoreFrame(frame, "def")).toBe(false);
    expect(shouldIgnoreFrame(frame, null)).toBe(false);
  });

  test("mergeForeignDoc preserves the open row's local content", () => {
    const local: JotsDoc = {
      version: 1,
      jots: [
        { id: "a", text: "local editing" },
        { id: "b", text: "local-b" },
      ],
    };
    const foreign: JotsDoc = {
      version: 1,
      jots: [
        { id: "a", text: "foreign-a" },
        { id: "b", text: "foreign-b" },
      ],
    };
    const merged = mergeForeignDoc(local, foreign, "a");
    // Open row 'a' keeps local content; row 'b' takes foreign.
    expect(merged.jots.find((s) => s.id === "a")).toEqual({
      id: "a",
      text: "local editing",
    });
    expect(merged.jots.find((s) => s.id === "b")!.text).toBe("foreign-b");
  });

  test("mergeForeignDoc with no open row takes foreign wholesale", () => {
    const merged = mergeForeignDoc(doc("a"), doc("a", "b"), null);
    expect(merged.jots.map((s) => s.id)).toEqual(["a", "b"]);
  });

  test("mergeForeignDoc re-appends an open row the foreign doc dropped", () => {
    const local: JotsDoc = {
      version: 1,
      jots: [{ id: "a", text: "mine" }],
    };
    const merged = mergeForeignDoc(local, doc("b"), "a");
    expect(merged.jots.map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("parseJotsFrame", () => {
  test("round-trips a valid frame", () => {
    const frame: JotsFrame = { doc: doc("a"), hash: "h", error: null };
    const parsed = parseJotsFrame(encodeFrame(frame));
    expect(parsed).not.toBeNull();
    expect(parsed!.doc.jots[0].id).toBe("a");
    expect(parsed!.hash).toBe("h");
  });

  test("returns null for malformed payloads", () => {
    expect(parseJotsFrame(new TextEncoder().encode("not json"))).toBeNull();
    expect(parseJotsFrame(new TextEncoder().encode("{}"))).toBeNull();
    expect(
      parseJotsFrame(new TextEncoder().encode('{"doc":{"version":1}}')),
    ).toBeNull();
  });
});

describe("helpers", () => {
  test("jotIncipit is the opening line of the text", () => {
    expect(jotIncipit({ id: "a", text: "first\nsecond" })).toBe("first");
    expect(jotIncipit({ id: "a", text: "  padded opening  \nmore" })).toBe("padded opening");
    expect(jotIncipit({ id: "a", text: "" })).toBe("");
  });

  test("newJotId is jt_ + 12 hex chars", () => {
    const id = newJotId();
    expect(id).toMatch(/^jt_[0-9a-f]{12}$/);
    expect(newJotId()).not.toBe(id);
  });

  test("emptyDoc is version 1 with no jots", () => {
    expect(emptyDoc()).toEqual({ version: 1, jots: [] });
  });
});

describe("origins — a jot remembers which projects its text came from", () => {
  // A jot is usually a passage lifted out of a transcript, and such a passage
  // cites files relative to a root the sentence never names. The paste records
  // that root here so the citation still resolves once the session is gone.

  test("applyAddOrigins records a root on the named jot", () => {
    const next = applyAddOrigins(doc("a", "b"), "a", ["/repo"]);
    expect(next.jots[0].origins).toEqual(["/repo"]);
    expect(next.jots[1].origins).toBeUndefined();
  });

  test("a second paste from elsewhere ACCUMULATES rather than replaces", () => {
    // Dropping the first root to record the second would put out links that
    // were working a moment ago — the jot is about both projects now.
    const once = applyAddOrigins(doc("a"), "a", ["/alpha"]);
    const twice = applyAddOrigins(once, "a", ["/beta"]);
    expect(twice.jots[0].origins).toEqual(["/alpha", "/beta"]);
  });

  test("a repeat paste from the same project is not a write", () => {
    // Identity, not just equality: the store checks it to skip the autosave.
    const once = applyAddOrigins(doc("a"), "a", ["/alpha"]);
    expect(applyAddOrigins(once, "a", ["/alpha"])).toBe(once);
    expect(applyAddOrigins(once, "a", [])).toBe(once);
    expect(applyAddOrigins(once, "a", ["relative"])).toBe(once);
    expect(applyAddOrigins(once, "missing-id", ["/beta"])).toBe(once);
  });

  test("parseJotsFrame reads origins back — the field is named on BOTH sides", () => {
    // An optional field is free to add on the write side and never free on the
    // read side: unnamed here, it is dropped on every round trip through the
    // frame, and the provenance quietly stops surviving a restart.
    const frame: JotsFrame = {
      doc: {
        version: 1,
        jots: [{ id: "a", text: "t", origins: ["/repo", "/repo", "rel"] }],
      },
      hash: "h",
      error: null,
    };
    const parsed = parseJotsFrame(encodeFrame(frame));
    expect(parsed!.doc.jots[0].origins).toEqual(["/repo"]);
  });

  test("a jot written before origins existed still parses", () => {
    const parsed = parseJotsFrame(encodeFrame({ doc: doc("a"), hash: null, error: null }));
    expect(parsed!.doc.jots[0].origins).toBeUndefined();
  });
});

describe("atoms — a jot keeps the chips standing in its text", () => {
  const FILE_ATOM = {
    position: 4,
    type: "file",
    label: "atom-text.ts",
    value: "tugdeck/src/lib/atom-text.ts",
  };

  test("applyUpdate writes the text and its atoms together", () => {
    // One document: a text saved without its atoms is a text with anonymous
    // placeholders in it, which is what a reopened jot used to show.
    const next = applyUpdate(doc("a"), "a", `see ${A}`, [FILE_ATOM]);
    expect(next.jots[0]).toEqual({ id: "a", text: `see ${A}`, atoms: [FILE_ATOM] });
    expect(next.jots[0].text.charAt(FILE_ATOM.position)).toBe(A);
  });

  test("deleting the last chip clears the field rather than leaving it stale", () => {
    const withAtom = applyUpdate(doc("a"), "a", `see ${A}`, [FILE_ATOM]);
    const cleared = applyUpdate(withAtom, "a", "see");
    expect(cleared.jots[0]).toEqual({ id: "a", text: "see" });
    expect("atoms" in cleared.jots[0]).toBe(false);
  });

  test("the atoms are copied, not aliased into the document", () => {
    const source = [{ ...FILE_ATOM }];
    const next = applyUpdate(doc("a"), "a", `see ${A}`, source);
    source[0]!.value = "somewhere/else.ts";
    expect(next.jots[0].atoms![0]!.value).toBe(FILE_ATOM.value);
  });

  test("parseJotsFrame reads atoms back — the field is named on BOTH sides", () => {
    // The same failure `origins` names: unnamed on the read side, the chips are
    // dropped on every round trip through the frame and the jot reopens with a
    // bare placeholder where a file mention was.
    const frame: JotsFrame = {
      doc: {
        version: 1,
        jots: [
          {
            id: "a",
            text: `see ${A} and ${A}`,
            atoms: [
              FILE_ATOM,
              {
                position: 10,
                type: "image",
                label: "shot.png",
                value: "shot.png",
                id: "1f8c2e04-7b3a-4d51-9c60-2a8e5f7b1d33",
              },
            ],
          },
        ],
      },
      hash: "h",
      error: null,
    };
    const parsed = parseJotsFrame(encodeFrame(frame));
    expect(parsed!.doc.jots[0].atoms).toEqual(frame.doc.jots[0]!.atoms!);
  });

  test("a malformed atom is skipped rather than half-trusted", () => {
    // A chip claiming an identity nothing wrote is worse than the placeholder
    // it would replace, so only well-formed entries survive the read.
    const frame: JotsFrame = {
      doc: {
        version: 1,
        jots: [
          {
            id: "a",
            text: A,
            atoms: [
              { position: "0", type: "file", label: "a", value: "a" },
              { position: -1, type: "file", label: "a", value: "a" },
              { position: 0, type: "", label: "a", value: "a" },
              FILE_ATOM,
            ] as never,
          },
        ],
      },
      hash: null,
      error: null,
    };
    const parsed = parseJotsFrame(encodeFrame(frame));
    expect(parsed!.doc.jots[0].atoms).toEqual([FILE_ATOM]);
  });

  test("an empty id is dropped — it would name a bytes-store row that is not there", () => {
    const frame: JotsFrame = {
      doc: {
        version: 1,
        jots: [{ id: "a", text: A, atoms: [{ ...FILE_ATOM, position: 0, id: "" }] }],
      },
      hash: null,
      error: null,
    };
    const parsed = parseJotsFrame(encodeFrame(frame));
    expect("id" in parsed!.doc.jots[0].atoms![0]!).toBe(false);
  });

  test("a jot written before atoms existed still parses", () => {
    const parsed = parseJotsFrame(encodeFrame({ doc: doc("a"), hash: null, error: null }));
    expect(parsed!.doc.jots[0].atoms).toBeUndefined();
  });
});
