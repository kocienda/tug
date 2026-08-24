/**
 * Pure-logic coverage for the annotation payload contract.
 *
 * The DOM stamp/read shell is validated in the real app (project policy:
 * no fake-DOM tests). What is pinned here is the part that has to be
 * exactly right for a gesture to act on the right value: that a payload
 * survives the round trip through a dataset record unchanged, that a
 * half-stamped record is refused rather than half-acted-on, that the
 * canonical value is what a Copy or a prompt insert should carry, and
 * that inline-code classification resolves a span to at most one kind by
 * a fixed precedence.
 */

import { describe, expect, test } from "bun:test";

import type { PathReference } from "../detect-path-reference";
import type { PathVerdict } from "../path-resolution";
import {
  annotationValue,
  classifyInlineCode,
  datasetForPayload,
  payloadForAtom,
  payloadFromDataset,
  type AnnotationPayload,
  type AtomLike,
} from "../payloads";

const PAYLOADS: ReadonlyArray<[string, AnnotationPayload]> = [
  ["url", { kind: "url", url: "https://status.claude.com" }],
  ["email", { kind: "email", address: "kocienda@pobox.com" }],
  [
    "slash command with args",
    { kind: "slash-command", name: "tugplug:implement", args: "dash/x.md" },
  ],
  ["slash command, no args", { kind: "slash-command", name: "diff", args: "" }],
  ["shell command", { kind: "shell-command", command: "just launch-debug" }],
  ["file path", { kind: "file-path", path: "/repo/lib/a.ts" }],
  [
    "file path at a line",
    { kind: "file-path", path: "/repo/lib/a.ts", line: 212 },
  ],
  [
    "file path over a range",
    { kind: "file-path", path: "/repo/lib/a.ts", line: 10, endLine: 14 },
  ],
  [
    "file path at a match span",
    { kind: "file-path", path: "/repo/lib/a.ts", line: 12, columns: [4, 13] },
  ],
];

describe("payload ↔ dataset round trip", () => {
  for (const [label, payload] of PAYLOADS) {
    test(label, () => {
      const record = datasetForPayload(payload);
      expect(payloadFromDataset(payload.kind, record)).toEqual(payload);
    });
  }

  test("an empty match span is no span — a bare caret is the line reveal", () => {
    expect(
      payloadFromDataset("file-path", { path: "/a.ts", line: "3", columns: "5,5" }),
    ).toEqual({ kind: "file-path", path: "/a.ts", line: 3 });
    expect(
      payloadFromDataset("file-path", { path: "/a.ts", line: "3", columns: "5" }),
    ).toEqual({ kind: "file-path", path: "/a.ts", line: 3 });
  });

  test("the dataset carries only the keys its kind needs", () => {
    expect(datasetForPayload({ kind: "url", url: "https://x.y" })).toEqual({
      url: "https://x.y",
    });
    expect(
      datasetForPayload({ kind: "shell-command", command: "just build" }),
    ).toEqual({ shellCommand: "just build" });
  });
});

describe("payloadFromDataset refuses an unusable record", () => {
  const refused: ReadonlyArray<[string, AnnotationPayload["kind"], Record<string, string>]> = [
    ["url with no url", "url", {}],
    ["url with an empty url", "url", { url: "" }],
    ["email with no address", "email", {}],
    ["slash command with no name", "slash-command", { slashArgs: "HEAD" }],
    ["shell command with no command", "shell-command", {}],
    ["a record belonging to another kind", "url", { shellCommand: "just x" }],
  ];

  for (const [label, kind, record] of refused) {
    test(label, () => {
      expect(payloadFromDataset(kind, record)).toBeNull();
    });
  }

  test("a slash command with no args round-trips as empty args, not a refusal", () => {
    expect(payloadFromDataset("slash-command", { slashCommand: "diff" })).toEqual({
      kind: "slash-command",
      name: "diff",
      args: "",
    });
  });
});

describe("annotationValue — what Copy and Insert carry", () => {
  test("a slash command regains its leading slash", () => {
    expect(
      annotationValue({ kind: "slash-command", name: "diff", args: "" }),
    ).toBe("/diff");
  });

  test("a slash command with args is a whole command line", () => {
    expect(
      annotationValue({
        kind: "slash-command",
        name: "tugplug:implement",
        args: "dash/x.md",
      }),
    ).toBe("/tugplug:implement dash/x.md");
  });

  test("a shell command is its line verbatim", () => {
    expect(
      annotationValue({ kind: "shell-command", command: "just launch-debug" }),
    ).toBe("just launch-debug");
  });

  test("a file path carries its line citation, so pasting it says where", () => {
    expect(
      annotationValue({ kind: "file-path", path: "/repo/a.ts", line: 212 }),
    ).toBe("/repo/a.ts:212");
    expect(annotationValue({ kind: "file-path", path: "/repo/a.ts" })).toBe(
      "/repo/a.ts",
    );
  });

  test("a cited range reproduces as a range", () => {
    expect(
      annotationValue({
        kind: "file-path",
        path: "/repo/a.ts",
        line: 124,
        endLine: 135,
      }),
    ).toBe("/repo/a.ts:124-135");
  });

  test("a url and an address are themselves", () => {
    expect(annotationValue({ kind: "url", url: "https://x.y/z" })).toBe(
      "https://x.y/z",
    );
    expect(annotationValue({ kind: "email", address: "a@b.com" })).toBe(
      "a@b.com",
    );
  });
});

describe("payloadForAtom — every chip the prompt can mint has an action", () => {
  const atom = (type: string, value: string, rest: Partial<AtomLike> = {}) => ({
    type,
    value,
    ...rest,
  });

  test("an absolute file mention opens its file", () => {
    expect(payloadForAtom(atom("file", "/repo/a.ts"))).toEqual({
      kind: "file-path",
      path: "/repo/a.ts",
    });
  });

  test("a link mention opens its url", () => {
    expect(payloadForAtom(atom("link", "https://x.y"))).toEqual({
      kind: "url",
      url: "https://x.y",
    });
  });

  test("a directory mention reveals the directory itself", () => {
    // The index form carries a trailing separator; the payload is a path,
    // so it does not.
    expect(payloadForAtom(atom("directory", "/repo/src/"))).toEqual({
      kind: "directory",
      path: "/repo/src",
    });
  });

  test("a dropped image file is a file — it has somewhere to go on disk", () => {
    expect(
      payloadForAtom(atom("image", "/repo/shot.png", { id: "atom-1" })),
    ).toEqual({ kind: "file-path", path: "/repo/shot.png" });
  });

  test("a pasted image is bytes under an id, opened by its own preview", () => {
    expect(
      payloadForAtom(
        atom("image", "image-1", { id: "atom-7", label: "image-1" }),
      ),
    ).toEqual({ kind: "image", atomId: "atom-7", label: "image-1" });
  });

  test("a path that is not absolute is refused, not guessed at", () => {
    expect(payloadForAtom(atom("file", "notes.md"))).toBeNull();
    expect(payloadForAtom(atom("file", "src/notes.md"))).toBeNull();
    expect(payloadForAtom(atom("directory", "src/"))).toBeNull();
  });

  test("a mention resolves against the roots it was written against", () => {
    // What an `@` mention actually carries: the file index counts from
    // the project root, so the chip's value is relative and only the
    // roots make it an address.
    const roots = { projectDir: "/repo", cwd: "/elsewhere" };
    expect(payloadForAtom(atom("file", "src/notes.md"), roots)).toEqual({
      kind: "file-path",
      path: "/repo/src/notes.md",
    });
    expect(payloadForAtom(atom("directory", "src/"), roots)).toEqual({
      kind: "directory",
      path: "/repo/src",
    });
  });

  test("the session cwd is the root when the card is bound to no project", () => {
    expect(
      payloadForAtom(atom("file", "notes.md"), {
        projectDir: null,
        cwd: "/work",
      }),
    ).toEqual({ kind: "file-path", path: "/work/notes.md" });
  });

  test("roots never invent an address for a dropped image", () => {
    // A dropped image carries the bare filename the browser disclosed —
    // never a path — so no root makes it an openable file.
    expect(
      payloadForAtom(atom("image", "shot.png", { id: "atom-3" }), {
        projectDir: "/repo",
        cwd: null,
      }),
    ).toEqual({ kind: "image", atomId: "atom-3", label: "shot.png" });
  });

  test("with neither root a relative mention is still refused", () => {
    expect(
      payloadForAtom(atom("file", "src/notes.md"), {
        projectDir: null,
        cwd: null,
      }),
    ).toBeNull();
  });

  test("an image with neither a path nor bytes to find has nothing to open", () => {
    expect(payloadForAtom(atom("image", "image-1"))).toBeNull();
  });

  test("types that name no object stay inert", () => {
    // A command chip is already annotated as a command by the renderer
    // that mints it; `doc` names no openable target at all.
    expect(payloadForAtom(atom("command", "/diff"))).toBeNull();
    expect(payloadForAtom(atom("doc", "something"))).toBeNull();
    expect(payloadForAtom(atom("link", ""))).toBeNull();
  });
});

describe("classifyInlineCode — one kind per span, by precedence", () => {
  const knowsDiff = (name: string): boolean => name === "diff";
  const knowsNothing = (): boolean => false;
  /** Nothing has been probed yet — the state ink starts in. */
  const noPaths = (): PathVerdict => ({ state: "unknown" });
  /** A verdict lookup primed with the answers for a set of paths. */
  const paths =
    (answers: Record<string, PathVerdict>) =>
    (reference: PathReference): PathVerdict =>
      answers[reference.path] ?? { state: "unknown" };

  test("a known slash command classifies as one", () => {
    expect(classifyInlineCode("/diff HEAD", knowsDiff, noPaths)).toEqual({
      kind: "slash-command",
      name: "diff",
      args: "HEAD",
    });
  });

  test("an unknown slash command is not actionable", () => {
    expect(classifyInlineCode("/diff HEAD", knowsNothing, noPaths)).toBeNull();
  });

  test("a project shell command needs no catalog", () => {
    expect(classifyInlineCode("just launch-debug", knowsNothing, noPaths)).toEqual(
      { kind: "shell-command", command: "just launch-debug" },
    );
  });

  test("ordinary code is left alone", () => {
    expect(classifyInlineCode("const x = 1;", knowsDiff, noPaths)).toBeNull();
    expect(classifyInlineCode("", knowsDiff, noPaths)).toBeNull();
    // Path-shaped, but nothing has confirmed it — plain text until it does.
    expect(classifyInlineCode("package.json", knowsDiff, noPaths)).toBeNull();
  });

  test("the catalog gate decides, so the same text can classify either way", () => {
    expect(classifyInlineCode("/diff", knowsDiff, noPaths)).not.toBeNull();
    expect(classifyInlineCode("/diff", knowsNothing, noPaths)).toBeNull();
  });

  test("a command shape wins over a path shape", () => {
    // `just build` would never parse as a path anyway; the case that
    // matters is that the command branches are consulted first, so a
    // confirmed path can never shadow a real command.
    const lookup = paths({
      "just launch-debug": { state: "confirmed", canonical: "/x", isDir: false },
    });
    expect(classifyInlineCode("just launch-debug", knowsNothing, lookup)).toEqual({
      kind: "shell-command",
      command: "just launch-debug",
    });
  });
});

describe("classifyInlineCode — a path is actionable only once confirmed", () => {
  const knowsNothing = (): boolean => false;
  const primed = (verdict: PathVerdict) => (): PathVerdict => verdict;

  test("confirmed: the annotation carries the canonical path, not what was written", () => {
    expect(
      classifyInlineCode(
        "tugdeck/src/a.ts",
        knowsNothing,
        primed({ state: "confirmed", canonical: "/repo/tugdeck/src/a.ts", isDir: false }),
      ),
    ).toEqual({ kind: "file-path", path: "/repo/tugdeck/src/a.ts" });
  });

  test("confirmed with a citation: the line rides along", () => {
    expect(
      classifyInlineCode(
        "lib/foo.ts:212",
        knowsNothing,
        primed({ state: "confirmed", canonical: "/repo/lib/foo.ts", isDir: false }),
      ),
    ).toEqual({ kind: "file-path", path: "/repo/lib/foo.ts", line: 212 });
  });

  for (const verdict of [
    { state: "unknown" },
    { state: "pending" },
    { state: "missing" },
  ] as const) {
    test(`${verdict.state}: the span stays plain text`, () => {
      expect(
        classifyInlineCode("tugdeck/src/a.ts", knowsNothing, primed(verdict)),
      ).toBeNull();
    });
  }

  test("a bare filename reaches the resolver — it is the shape prose uses", () => {
    const asked: string[] = [];
    const lookup = (reference: PathReference): PathVerdict => {
      asked.push(reference.path);
      return { state: "confirmed", canonical: "/repo/tugdeck/tug-button.css", isDir: false };
    };
    expect(classifyInlineCode("tug-button.css", knowsNothing, lookup)).toEqual({
      kind: "file-path",
      path: "/repo/tugdeck/tug-button.css",
    });
    expect(asked).toEqual(["tug-button.css"]);
  });

  test("text that cannot name a file never reaches the resolver", () => {
    let asked = false;
    const lookup = (): PathVerdict => {
      asked = true;
      return { state: "confirmed", canonical: "/x", isDir: false };
    };
    expect(classifyInlineCode("const x = 1;", knowsNothing, lookup)).toBeNull();
    expect(asked).toBe(false);
  });
});
