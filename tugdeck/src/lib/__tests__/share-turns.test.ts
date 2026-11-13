/**
 * share-turns.test.ts — the pure core of sharing turns: the selection edits,
 * the slice, the strings walk the scrub round trip rides, the header, the
 * signature that gates the outward actions, the Markdown, and the render
 * document's decoder. Plus the `/export` golden: the Markdown archive's bytes
 * do not move when it is routed through the share serializer.
 */

import { describe, expect, test } from "bun:test";

import type {
  CodeSessionSnapshot,
  Message,
  ToolUseMessage,
  TurnEntry,
} from "@/lib/code-session-store/types";
import type { SessionIdentity } from "@/lib/session-identity";
import {
  applyShareStrings,
  buildShareRenderDocument,
  buildShareSlice,
  collectShareStrings,
  compressTurnNumbers,
  decodeShareRenderDocument,
  extendTo,
  selectableTurnKeys,
  shareDocumentMarkdown,
  shareExpansionOverrides,
  shareHeader,
  shareSignature,
  shareTurnNumbers,
  toggleTurn,
  toolCallSummaryLine,
  type ShareHeader,
  type ShareSelection,
} from "@/lib/share-turns";
import { transcriptToMarkdown } from "@/lib/transcript-export";
import { ShareTurnsStore, type ShareArtifact } from "@/lib/share-turns-store";
import { seedPathsFor } from "@/lib/code-session-store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function turn(
  turnKey: string,
  origin: string,
  endedAt: number,
  messages: Message[],
): TurnEntry {
  return { turnKey, msgId: `m-${turnKey}`, origin, endedAt, messages } as unknown as TurnEntry;
}

function user(key: string, text: string): Message {
  return {
    kind: "user_message",
    text,
    attachments: [],
    origin: "user",
    submitAt: 1,
    messageKey: key,
    createdAt: 1,
  };
}

function prose(key: string, text: string): Message {
  return { kind: "assistant_text", text, messageKey: key, createdAt: 2 };
}

function tool(
  toolUseId: string,
  toolName: string,
  input: unknown,
  extra: Partial<ToolUseMessage> = {},
): ToolUseMessage {
  return {
    kind: "tool_use",
    toolUseId,
    toolName,
    input,
    status: "done",
    result: null,
    structuredResult: null,
    toolWallMs: 1,
    messageKey: `k-${toolUseId}`,
    createdAt: 3,
    ...extra,
  };
}

function thinking(key: string, text: string): Message {
  return { kind: "assistant_thinking", text, messageKey: key, createdAt: 4 };
}

const EMPTY: ShareSelection = { selected: new Set(), anchor: null };
const ORDER = ["a", "b", "c", "d", "e"];

function keys(state: ShareSelection): string[] {
  return [...state.selected].sort();
}

function snapshotAt(firstLoadedTurnIndex: number | null): CodeSessionSnapshot {
  return {
    replayWindow: firstLoadedTurnIndex === null ? null : { firstLoadedTurnIndex },
  } as unknown as CodeSessionSnapshot;
}

function identity(): SessionIdentity {
  return {
    project: "tug",
    projectDir: "/Users/u/src/tug",
    branch: null,
    tag: "curly-apple",
    customName: "Share work",
    description: null,
    state: null,
    id: "0f3c1e5a-0000-0000-0000-000000000000",
    shortId: "0f3c1e5a",
    resolved: true,
  } as unknown as SessionIdentity;
}

/** Noon on a local calendar day, so the date never straddles midnight. */
function localNoon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12).getTime();
}

/** Prose, a tool call, and a thinking block — one turn each. */
function goldenTranscript(): TurnEntry[] {
  return [
    turn("t1", "user", 1000, [
      user("t1-user", "What is in the README?"),
      prose("m1-b0", "It describes **Tug**."),
    ]),
    turn("t2", "user", 2000, [
      user("t2-user", "Read the config"),
      {
        kind: "tool_use",
        toolUseId: "tu-1",
        toolName: "Read",
        input: { file_path: "/Users/u/proj/config.toml" },
        status: "done",
        result: '[tugtool]\nname = "x"',
        structuredResult: null,
        toolWallMs: 12,
        messageKey: "m2-b0",
        createdAt: 3,
      },
      prose("m2-b1", "The config names `x`."),
    ]),
    turn("t3", "user", 3000, [
      user("t3-user", "Think about it"),
      { kind: "assistant_thinking", text: "hmm, secret thoughts", messageKey: "m3-b0", createdAt: 4 },
      prose("m3-b1", "Done thinking."),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// The /export golden
// ---------------------------------------------------------------------------

describe("/export Markdown", () => {
  test("is byte-identical to the archive it has always written", () => {
    expect(transcriptToMarkdown(goldenTranscript())).toBe(
      [
        "# Session transcript",
        "",
        "## You",
        "",
        "What is in the README?",
        "",
        "## Claude",
        "",
        "It describes **Tug**.",
        "",
        "## You",
        "",
        "Read the config",
        "",
        "## Claude",
        "",
        "## Tool: Read",
        "",
        "Input:",
        "```json",
        "{",
        '  "file_path": "/Users/u/proj/config.toml"',
        "}",
        "```",
        "",
        "Output:",
        "```",
        "[tugtool]",
        'name = "x"',
        "```",
        "",
        "## Response",
        "",
        "The config names `x`.",
        "",
        "## You",
        "",
        "Think about it",
        "",
        "## Claude",
        "",
        "Done thinking.",
        "",
      ].join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe("selection edits", () => {
  test("a click toggles a turn and anchors there", () => {
    const on = toggleTurn(EMPTY, "b");
    expect(keys(on)).toEqual(["b"]);
    expect(on.anchor).toBe("b");
    const off = toggleTurn(on, "b");
    expect(keys(off)).toEqual([]);
    expect(off.anchor).toBe("b");
  });

  test("a shift-click extends forward and backward from the anchor", () => {
    const anchored = toggleTurn(EMPTY, "b");
    expect(keys(extendTo(anchored, "d", ORDER))).toEqual(["b", "c", "d"]);
    const back = toggleTurn(EMPTY, "d");
    expect(keys(extendTo(back, "a", ORDER))).toEqual(["a", "b", "c", "d"]);
  });

  test("an extend moves no anchor", () => {
    const anchored = toggleTurn(EMPTY, "c");
    const first = extendTo(anchored, "e", ORDER);
    expect(first.anchor).toBe("c");
    expect(keys(extendTo(first, "a", ORDER))).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("an extend with no anchor is a toggle that sets one", () => {
    const state = extendTo(EMPTY, "c", ORDER);
    expect(keys(state)).toEqual(["c"]);
    expect(state.anchor).toBe("c");
  });

  test("picks may be non-contiguous", () => {
    const state = toggleTurn(toggleTurn(toggleTurn(EMPTY, "a"), "c"), "e");
    expect(keys(state)).toEqual(["a", "c", "e"]);
  });

  test("ink turns are not selectable; wheel turns are", () => {
    const transcript = [
      turn("u", "user", 1, []),
      turn("s", "shell", 2, []),
      turn("w", "wheel", 3, []),
      turn("r", "refs", 4, []),
      turn("a", "assistant", 5, []),
    ];
    expect(selectableTurnKeys(transcript)).toEqual(["u", "w", "a"]);
  });
});

// ---------------------------------------------------------------------------
// The slice
// ---------------------------------------------------------------------------

describe("buildShareSlice", () => {
  const transcript = (): TurnEntry[] => [
    turn("t1", "user", 1, [user("t1-u", "one"), thinking("t1-th", "private"), prose("t1-a", "first")]),
    turn("t2", "user", 2, [
      user("t2-u", "two"),
      tool("tu-a", "Bash", { command: "ls" }),
      tool("tu-b", "Read", { file_path: "x" }, { parentToolUseId: "tu-a" }),
      prose("t2-a", "second"),
    ]),
    turn("t3", "shell", 3, [prose("t3-a", "shell row")]),
    turn("t4", "user", 4, [user("t4-u", "four"), prose("t4-a", "fourth")]),
  ];

  test("removes thinking and keeps transcript order whatever the set order", () => {
    const slice = buildShareSlice(transcript(), new Set(["t4", "t1"]), "full");
    expect(slice.map((t) => t.turnKey)).toEqual(["t1", "t4"]);
    expect(slice[0].messages.map((m) => m.kind)).toEqual(["user_message", "assistant_text"]);
  });

  test("honours each tool mode", () => {
    const full = buildShareSlice(transcript(), new Set(["t2"]), "full");
    const summaries = buildShareSlice(transcript(), new Set(["t2"]), "summaries");
    const none = buildShareSlice(transcript(), new Set(["t2"]), "none");
    expect(full[0].messages.filter((m) => m.kind === "tool_use")).toHaveLength(2);
    expect(summaries[0].messages.filter((m) => m.kind === "tool_use")).toHaveLength(2);
    expect(none[0].messages.map((m) => m.kind)).toEqual(["user_message", "assistant_text"]);
  });

  test("never holds an ink turn and never touches the live transcript", () => {
    const live = transcript();
    const slice = buildShareSlice(live, new Set(["t1", "t3"]), "full");
    expect(slice.map((t) => t.turnKey)).toEqual(["t1"]);
    (slice[0].messages[0] as { text: string }).text = "changed";
    expect((live[0].messages[0] as { text: string }).text).toBe("one");
    expect(live[0].messages).toHaveLength(3);
  });

  test("shareExpansionOverrides collapses top-level calls under summaries and opens them under full", () => {
    const slice = buildShareSlice(transcript(), new Set(["t2"]), "full");
    expect(shareExpansionOverrides(slice, "summaries")).toEqual({ "tu-a": true });
    expect(shareExpansionOverrides(slice, "full")).toEqual({ "tu-a": false });
    expect(shareExpansionOverrides(slice, "none")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The strings walk
// ---------------------------------------------------------------------------

describe("the strings walk", () => {
  const header: ShareHeader = { title: "Title /Users/u", project: "tug", dates: "d", turns: "#1" };
  const slice = (): TurnEntry[] => [
    turn("t1", "user", 1, [
      user("t1-u", "prompt"),
      tool("tu-1", "Edit", { file_path: "/a", edits: [{ old: "x", nested: { deep: "y" } }], n: 3 }, {
        result: "out",
        structuredResult: { lines: ["s1", "s2"] },
      }),
      prose("t1-a", "reply"),
    ]),
  ];

  test("collects every shown string, the header's title first", () => {
    expect(collectShareStrings(slice(), header)).toEqual([
      "Title /Users/u",
      "prompt",
      "/a",
      "x",
      "y",
      "out",
      "s1",
      "s2",
      "reply",
    ]);
  });

  test("round-trips unchanged", () => {
    const texts = collectShareStrings(slice(), header);
    const back = applyShareStrings(slice(), header, texts);
    expect(back).not.toBeNull();
    expect(back?.slice).toEqual(slice());
    expect(back?.header).toEqual(header);
  });

  test("an altered string lands at its place, deep in a tool input and in the title", () => {
    const texts = collectShareStrings(slice(), header);
    texts[0] = "Title ~";
    texts[4] = "[secret]";
    const back = applyShareStrings(slice(), header, texts);
    expect(back?.header?.title).toBe("Title ~");
    const call = back?.slice[0].messages[1] as ToolUseMessage;
    expect(call.input).toEqual({ file_path: "/a", edits: [{ old: "x", nested: { deep: "[secret]" } }], n: 3 });
  });

  test("an answer of the wrong length is refused", () => {
    expect(applyShareStrings(slice(), header, ["just one"])).toBeNull();
  });

  test("a boundary note's drawn facts ride the walk, not only its text", () => {
    const note = {
      kind: "system_note",
      source: "relocation",
      text: "Moved",
      relocation: { fromDir: "/Users/u/a", toDir: "/Users/u/b" },
      messageKey: "n1",
      createdAt: 5,
    } as Message;
    const turns = [turn("t1", "assistant", 1, [note])];
    expect(collectShareStrings(turns, null)).toEqual(["Moved", "/Users/u/a", "/Users/u/b"]);
    const back = applyShareStrings(turns, null, ["Moved", "~/a", "~/b"]);
    const moved = back?.slice[0].messages[0] as { relocation: { fromDir: string; toDir: string } };
    expect(moved.relocation).toEqual({ fromDir: "~/a", toDir: "~/b" });
  });
});

// ---------------------------------------------------------------------------
// Summary lines, header, signature
// ---------------------------------------------------------------------------

describe("toolCallSummaryLine", () => {
  test("reads the first string among the summary keys, in key order", () => {
    expect(toolCallSummaryLine(tool("1", "Bash", { description: "list", command: "ls -la" }))).toBe(
      "→ Bash(ls -la)",
    );
    expect(toolCallSummaryLine(tool("2", "Grep", { pattern: "foo", path: "/x" }))).toBe("→ Grep(foo)");
    expect(toolCallSummaryLine(tool("3", "Task", { prompt: "  go\nnow  " }))).toBe("→ Task(go now)");
    expect(toolCallSummaryLine(tool("4", "Mystery", { n: 1 }))).toBe("→ Mystery()");
    expect(toolCallSummaryLine(tool("5", "Odd", null))).toBe("→ Odd()");
  });

  test("cuts at 80 characters with an ellipsis", () => {
    const long = "é".repeat(85);
    expect(toolCallSummaryLine(tool("1", "Read", { file_path: long }))).toBe(`→ Read(${"é".repeat(80)}…)`);
    const exact = "a".repeat(80);
    expect(toolCallSummaryLine(tool("2", "Read", { file_path: exact }))).toBe(`→ Read(${exact})`);
  });
});

describe("the header", () => {
  test("compresses turn numbers to ranges", () => {
    expect(compressTurnNumbers([3, 4, 5, 9])).toBe("#3–5, #9");
    expect(compressTurnNumbers([9, 3, 4, 4])).toBe("#3–4, #9");
    expect(compressTurnNumbers([7])).toBe("#7");
    expect(compressTurnNumbers([])).toBe("");
  });

  test("numbers turns as the card does and dates them locally", () => {
    const transcript = [
      turn("t1", "user", localNoon(2026, 11, 12), []),
      turn("s", "shell", localNoon(2026, 11, 12), []),
      turn("t2", "user", localNoon(2026, 11, 12), []),
      turn("t3", "assistant", localNoon(2026, 11, 13), []),
    ];
    const header = shareHeader({
      identity: identity(),
      transcript,
      selected: new Set(["t1", "t3"]),
      snapshot: snapshotAt(10),
    });
    expect(header.project).toBe("tug");
    expect(header.title.length).toBeGreaterThan(0);
    expect(header.turns).toBe("#11, #14");
    expect(header.dates).toBe("2026-11-12 – 2026-11-13");

    const oneDay = shareHeader({
      identity: identity(),
      transcript,
      selected: new Set(["t1", "t2"]),
      snapshot: snapshotAt(null),
    });
    expect(oneDay.turns).toBe("#1, #3");
    expect(oneDay.dates).toBe("2026-11-12");
  });
});

describe("shareSignature", () => {
  const base = { selected: new Set(["a", "b"]), toolMode: "summaries" as const, format: "pdf" as const };

  test("does not move with set insertion order", () => {
    expect(shareSignature(base)).toBe(shareSignature({ ...base, selected: new Set(["b", "a"]) }));
  });

  test("moves with each of its three parts", () => {
    const sig = shareSignature(base);
    expect(shareSignature({ ...base, selected: new Set(["a"]) })).not.toBe(sig);
    expect(shareSignature({ ...base, toolMode: "full" })).not.toBe(sig);
    expect(shareSignature({ ...base, format: "png" })).not.toBe(sig);
  });
});

// ---------------------------------------------------------------------------
// Markdown and the render document
// ---------------------------------------------------------------------------

describe("shareDocumentMarkdown", () => {
  const header: ShareHeader = {
    title: "Share work:curly-apple",
    project: "tug",
    dates: "2026-11-13",
    turns: "#2",
  };

  test("opens with the title and a facts line, and writes summaries as lines", () => {
    const slice = buildShareSlice(goldenTranscript(), new Set(["t2"]), "summaries");
    expect(shareDocumentMarkdown({ turns: slice, toolMode: "summaries", header })).toBe(
      [
        "# Share work:curly-apple",
        "",
        "tug · 2026-11-13 · turns #2",
        "",
        "## You",
        "",
        "Read the config",
        "",
        "## Claude",
        "",
        "→ Read(/Users/u/proj/config.toml)",
        "",
        "## Response",
        "",
        "The config names `x`.",
        "",
      ].join("\n"),
    );
  });

  test("writes no tool sections under none, and no thinking in any mode", () => {
    const slice = buildShareSlice(goldenTranscript(), new Set(["t2", "t3"]), "none");
    const md = shareDocumentMarkdown({ turns: slice, toolMode: "none", header });
    expect(md).not.toContain("Tool: Read");
    expect(md).not.toContain("→ Read");
    expect(md).not.toContain("## Response");
    expect(md).toContain("## Claude\n\nThe config names `x`.");
    expect(md).not.toContain("secret thoughts");
  });
});

describe("decodeShareRenderDocument", () => {
  const doc = {
    version: 1,
    theme: "ironclad",
    width: 720,
    header: { title: "t", project: "p", dates: "d", turns: "#1" },
    toolMode: "summaries",
    modelName: null,
    turns: [{ turnKey: "t1", origin: "user", messages: [] }],
    turnNumbers: [1],
  };

  test("accepts the S03 shape", () => {
    expect(decodeShareRenderDocument(JSON.stringify(doc))?.turnNumbers).toEqual([1]);
  });

  test("refuses a wrong version", () => {
    expect(decodeShareRenderDocument(JSON.stringify({ ...doc, version: 2 }))).toBeNull();
  });

  test("refuses a shape mismatch", () => {
    expect(decodeShareRenderDocument("not json")).toBeNull();
    expect(decodeShareRenderDocument(JSON.stringify({ ...doc, toolMode: "some" }))).toBeNull();
    expect(decodeShareRenderDocument(JSON.stringify({ ...doc, turnNumbers: [] }))).toBeNull();
    expect(decodeShareRenderDocument(JSON.stringify({ ...doc, header: { title: "t" } }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The store's gate
// ---------------------------------------------------------------------------

describe("the render document", () => {
  const transcript = [
    turn("a", "user", 10, [user("ua", "one"), prose("pa", "A")]),
    turn("b", "user", 20, [user("ub", "two"), prose("pb", "B")]),
    turn("c", "user", 30, [user("uc", "three"), prose("pc", "C")]),
  ];

  test("a non-contiguous pick keeps the numbers the card shows, past a load window", () => {
    const slice = buildShareSlice(transcript, new Set(["c", "a"]), "summaries");
    expect(shareTurnNumbers(slice, transcript, snapshotAt(null))).toEqual([1, 3]);
    expect(shareTurnNumbers(slice, transcript, snapshotAt(40))).toEqual([41, 43]);
  });

  test("decodes as built", () => {
    const slice = buildShareSlice(transcript, new Set(["b"]), "full");
    const doc = buildShareRenderDocument({
      theme: "ironclad",
      header: { title: "t", project: "p", dates: "d", turns: "#2" },
      toolMode: "full",
      modelName: "claude-x",
      slice,
      turnNumbers: shareTurnNumbers(slice, transcript, snapshotAt(null)),
    });
    expect(decodeShareRenderDocument(JSON.stringify(doc))).toEqual(doc);
  });
});

describe("seedPathsFor", () => {
  test("writes one text path per assistant_text, with its text, and none for thinking or tools", () => {
    const turns = [
      turn("t1", "user", 10, [user("u1", "hi"), thinking("th1", "private"), prose("p1", "first"), tool("tu1", "Bash", {})]),
      turn("t2", "user", 20, [user("u2", "again"), prose("p2", "second"), prose("p3", "third")]),
    ];
    expect(seedPathsFor(turns)).toEqual([
      { path: "turn.t1.message.p1.text", value: "first" },
      { path: "turn.t2.message.p2.text", value: "second" },
      { path: "turn.t2.message.p3.text", value: "third" },
    ]);
  });

  test("a turn with no prose writes nothing", () => {
    expect(seedPathsFor([turn("t1", "user", 10, [user("u1", "hi"), thinking("th1", "x")])])).toEqual([]);
  });
});

describe("ShareTurnsStore gate", () => {
  const artifact: ShareArtifact = { format: "markdown", markdown: "# S", path: "", html: "" };

  function previewed(): ShareTurnsStore {
    const store = new ShareTurnsStore();
    store.enter(["t1", "t3"]);
    store.setFormat("markdown");
    expect(store.canSend()).toBe(false);
    store.markPreviewed(store.signature(), artifact);
    return store;
  }

  test("a share starts as a PDF with tool calls as summaries", () => {
    const s = new ShareTurnsStore().getSnapshot();
    expect(s.format).toBe("pdf");
    expect(s.toolMode).toBe("summaries");
  });

  test("closed before a preview, open after it", () => {
    expect(previewed().canSend()).toBe(true);
  });

  test("a toggle closes it, and toggling back reopens it", () => {
    const store = previewed();
    store.toggle("t2");
    expect(store.canSend()).toBe(false);
    store.toggle("t2");
    expect(store.canSend()).toBe(true);
  });

  test("a tool mode or format change closes it", () => {
    const store = previewed();
    store.setToolMode("full");
    expect(store.canSend()).toBe(false);
    store.setToolMode("summaries");
    expect(store.canSend()).toBe(true);
    store.setFormat("pdf");
    expect(store.canSend()).toBe(false);
  });

  test("leaving and re-entering the mode starts closed, with nothing held", () => {
    const store = previewed();
    store.confirmPrivate();
    store.leave();
    store.enter(["t1", "t3"]);
    expect(store.canSend()).toBe(false);
    expect(store.getSnapshot().lastArtifact).toBeNull();
    expect(store.getSnapshot().privateConfirmed).toBe(false);
  });

  test("the snapshot is stable between edits and moves on one", () => {
    const store = new ShareTurnsStore();
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    store.enter();
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot().active).toBe(true);
  });

  test("a shift-extend marks the range from the anchor", () => {
    const store = new ShareTurnsStore();
    store.enter();
    store.toggle("t3");
    store.extendTo("t4", ["t1", "t3", "t4"]);
    expect([...store.getSnapshot().selected].sort()).toEqual(["t3", "t4"]);
  });

  test("Mark All marks every given turn and drops the anchor; Clear unmarks them and keeps the mode", () => {
    const store = new ShareTurnsStore();
    store.enter();
    store.toggle("t3");
    store.markAll(["t1", "t3", "t4"]);
    expect([...store.getSnapshot().selected].sort()).toEqual(["t1", "t3", "t4"]);
    expect(store.getSnapshot().anchor).toBeNull();
    store.clearMarks();
    expect(store.getSnapshot().selected.size).toBe(0);
    expect(store.getSnapshot().anchor).toBeNull();
    expect(store.getSnapshot().active).toBe(true);
    // Clearing nothing publishes nothing.
    const before = store.getSnapshot();
    store.clearMarks();
    expect(store.getSnapshot()).toBe(before);
  });
});
