/**
 * `build-wire-payload` — unit tests for the substrate → Anthropic
 * content-block flattener. Pure-logic coverage; no canvas, no DOM,
 * no async.
 *
 * Pins the revised contract in [Spec S03](arc/dev-atoms.md#s03-build-wire-payload)
 * and the atom-to-wire mapping documented in
 * `build-wire-payload.ts`'s module docstring.
 */

import { describe, expect, test } from "bun:test";

import { buildWirePayload } from "../build-wire-payload";
import { createAtomBytesStore } from "../atom-bytes-store";
import { TUG_ATOM_CHAR, type AtomSegment } from "../tug-atom-img";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const C = TUG_ATOM_CHAR; // shorthand for the U+FFFC sentinel

function imageAtom(label: string, id: string | undefined = undefined): AtomSegment {
  return {
    kind: "atom",
    type: "image",
    label,
    value: label,
    id,
  };
}

function fileAtom(path: string): AtomSegment {
  return { kind: "atom", type: "file", label: path, value: path };
}

function docAtom(path: string): AtomSegment {
  return { kind: "atom", type: "doc", label: path, value: path };
}

function linkAtom(url: string): AtomSegment {
  return { kind: "atom", type: "link", label: url, value: url };
}

function commandAtom(name: string): AtomSegment {
  return { kind: "atom", type: "command", label: name, value: name };
}

// ---------------------------------------------------------------------------
// Empty / trivial cases
// ---------------------------------------------------------------------------

describe("buildWirePayload — empty / trivial", () => {
  test("empty text + no atoms → empty content array", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload("", [], store);
    expect(content).toEqual([]);
  });

  test("plain text + no atoms → a single text block carrying the text", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload("hello, claude", [], store);
    expect(content).toEqual([{ type: "text", text: "hello, claude" }]);
  });

  test("text with a stray U+FFFC passes through into the text block (defensive)", () => {
    // Substrate invariant should prevent this; verifying the
    // defensive fallback rather than a crash or silent drop.
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(`prefix${C}suffix`, [], store);
    expect(content).toEqual([{ type: "text", text: `prefix${C}suffix` }]);
  });
});

// ---------------------------------------------------------------------------
// Non-image atom substitution → text-block contents
// ---------------------------------------------------------------------------

describe("buildWirePayload — non-image atom substitution", () => {
  test("single file atom substitutes its value wrapped as a backtick-`@` mention marker", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `Read ${C} please.`,
      [fileAtom("README.md")],
      store,
    );
    expect(content).toEqual([{ type: "text", text: "Read `@README.md` please." }]);
  });

  test("multiple file atoms substitute in document order into one coalesced text block", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `Compare ${C} and ${C}.`,
      [fileAtom("a.ts"), fileAtom("b.ts")],
      store,
    );
    expect(content).toEqual([{ type: "text", text: "Compare `@a.ts` and `@b.ts`." }]);
  });

  test("doc atom substitutes like a file atom", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `Read ${C}.`,
      [docAtom("docs/intro.md")],
      store,
    );
    expect(content).toEqual([{ type: "text", text: "Read `@docs/intro.md`." }]);
  });

  test("link atom substitutes its URL inside the marker", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `See ${C}.`,
      [linkAtom("https://example.com/x")],
      store,
    );
    expect(content).toEqual([
      { type: "text", text: "See `@https://example.com/x`." },
    ]);
  });

  test("command atom emits a clean /name string, NOT the mention marker", () => {
    // A command atom must reach claude as a clean slash-command string so
    // the CLI expands it as a user-invoked skill (bypassing
    // disable-model-invocation). Wrapping it in the `@`-mention marker
    // defeats expansion. See build-wire-payload.ts / command-atom.ts.
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `Run ${C}`,
      [commandAtom("help")],
      store,
    );
    expect(content).toEqual([{ type: "text", text: "Run /help" }]);
  });

  test("a lone command atom is a clean leading-slash message", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `${C}`,
      [commandAtom("tugplug:commit")],
      store,
    );
    expect(content).toEqual([{ type: "text", text: "/tugplug:commit" }]);
  });

  test("a command atom followed by argument text coalesces into /cmd args", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `${C} one two`,
      [commandAtom("cmd")],
      store,
    );
    expect(content).toEqual([{ type: "text", text: "/cmd one two" }]);
  });

  test("a command atom embedded mid-prose substitutes /name (no marker)", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `before ${C} after`,
      [commandAtom("status")],
      store,
    );
    expect(content).toEqual([{ type: "text", text: "before /status after" }]);
  });

  test("atoms at boundaries (start, end) substitute correctly", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `${C} and ${C}`,
      [fileAtom("a.ts"), fileAtom("b.ts")],
      store,
    );
    expect(content).toEqual([{ type: "text", text: "`@a.ts` and `@b.ts`" }]);
  });

  test("adjacent atoms with no intervening text", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `${C}${C}${C}`,
      [fileAtom("x"), fileAtom("y"), fileAtom("z")],
      store,
    );
    expect(content).toEqual([{ type: "text", text: "`@x``@y``@z`" }]);
  });

  test("backtick-in-value falls back to plain substitution (no broken marker)", () => {
    // A file path containing a literal backtick can't ride inside
    // a markdown-style marker; the wrap helper detects and falls
    // back to the original behaviour for that one atom. Lossy
    // round-trip (no chip on replay) but no broken span the parser
    // would mis-identify.
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `Got ${C}.`,
      [fileAtom("weird`name")],
      store,
    );
    expect(content).toEqual([{ type: "text", text: "Got weird`name." }]);
  });
});

// ---------------------------------------------------------------------------
// Image atom + bytes-store → interleaved image blocks
// ---------------------------------------------------------------------------

describe("buildWirePayload — image content blocks", () => {
  test("image atom with bytes becomes a standalone image block at its position", () => {
    const store = createAtomBytesStore();
    store.put("img-1", { content: "iVBORw0KGgo=", mediaType: "image/png" });
    const { content } = buildWirePayload(
      `Look at ${C}.`,
      [imageAtom("shot.png", "img-1")],
      store,
    );
    expect(content).toEqual([
      { type: "text", text: "Look at " },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgo=",
        },
      },
      { type: "text", text: "." },
    ]);
  });

  test("image at the start does not emit an empty leading text block", () => {
    const store = createAtomBytesStore();
    store.put("img-1", { content: "DATA", mediaType: "image/png" });
    const { content } = buildWirePayload(
      `${C} trailing`,
      [imageAtom("a.png", "img-1")],
      store,
    );
    expect(content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "DATA" },
      },
      { type: "text", text: " trailing" },
    ]);
  });

  test("image at the end does not emit an empty trailing text block", () => {
    const store = createAtomBytesStore();
    store.put("img-1", { content: "DATA", mediaType: "image/png" });
    const { content } = buildWirePayload(
      `leading ${C}`,
      [imageAtom("a.png", "img-1")],
      store,
    );
    expect(content).toEqual([
      { type: "text", text: "leading " },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "DATA" },
      },
    ]);
  });

  test("consecutive image atoms produce consecutive image blocks with no empty text between", () => {
    const store = createAtomBytesStore();
    store.put("a", { content: "AAA=", mediaType: "image/png" });
    store.put("b", { content: "BBB=", mediaType: "image/jpeg" });
    const { content } = buildWirePayload(
      `${C}${C}`,
      [imageAtom("a.png", "a"), imageAtom("b.jpg", "b")],
      store,
    );
    expect(content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAA=" },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "BBB=" },
      },
    ]);
  });

  test("image atom without an id substitutes as a mention marker (no bytes → non-image branch)", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `Decoration: ${C}`,
      [imageAtom("decor.png")], // no id
      store,
    );
    // Without an id the atom can't ride as an image block; it falls
    // through to the non-image branch and substitutes as a backtick-`@`
    // marker — preserving its label on replay (as a "file" chip).
    expect(content).toEqual([{ type: "text", text: "Decoration: `@decor.png`" }]);
  });

  test("image atom whose id is missing from the store substitutes as a mention marker", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `${C}`,
      [imageAtom("missing.png", "evicted-id")],
      store,
    );
    expect(content).toEqual([{ type: "text", text: "`@missing.png`" }]);
  });
});

// ---------------------------------------------------------------------------
// atomIdAt resolver — pairs image-block index back to its atom id
// ---------------------------------------------------------------------------

describe("buildWirePayload — atomIdAt resolver", () => {
  test("returns the original atom's id for each image block", () => {
    const store = createAtomBytesStore();
    store.put("a", { content: "X", mediaType: "image/png" });
    store.put("b", { content: "Y", mediaType: "image/png" });
    const { atomIdAt } = buildWirePayload(
      `${C} ${C}`,
      [imageAtom("a.png", "a"), imageAtom("b.png", "b")],
      store,
    );
    expect(atomIdAt(0)).toBe("a");
    expect(atomIdAt(1)).toBe("b");
  });

  test("skips bytes-less atoms — image-block index 0 still corresponds to the first promoted atom", () => {
    const store = createAtomBytesStore();
    // Only the second atom has bytes; the first is bytes-less and
    // doesn't become an image block. The resolver must reflect the
    // emitted-block ordering, not the editor's atom ordering.
    store.put("present", { content: "X", mediaType: "image/png" });
    const { content, atomIdAt } = buildWirePayload(
      `${C} ${C}`,
      [
        imageAtom("missing.png", "evicted-id"),
        imageAtom("good.png", "present"),
      ],
      store,
    );
    expect(content.filter((c) => c.type === "image")).toHaveLength(1);
    expect(atomIdAt(0)).toBe("present");
    expect(atomIdAt(1)).toBeUndefined();
  });

  test("returns undefined for out-of-range indices (defensive)", () => {
    const store = createAtomBytesStore();
    const { atomIdAt } = buildWirePayload(
      "no atoms here",
      [],
      store,
    );
    expect(atomIdAt(0)).toBeUndefined();
    expect(atomIdAt(99)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mixed atom-type sequences
// ---------------------------------------------------------------------------

describe("buildWirePayload — mixed atom sequences", () => {
  test("image + file + image — file substitutes into surrounding text; images become blocks", () => {
    const store = createAtomBytesStore();
    store.put("a", { content: "AAA=", mediaType: "image/png" });
    store.put("c", { content: "CCC=", mediaType: "image/jpeg" });
    const { content } = buildWirePayload(
      `${C} ${C} ${C}`,
      [
        imageAtom("a.png", "a"),
        fileAtom("README.md"),
        imageAtom("c.jpg", "c"),
      ],
      store,
    );
    expect(content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAA=" },
      },
      { type: "text", text: " `@README.md` " },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "CCC=" },
      },
    ]);
  });

  test("realistic prompt with leading text and one image atom", () => {
    const store = createAtomBytesStore();
    store.put("shot", { content: "PNG-DATA", mediaType: "image/png" });
    const { content } = buildWirePayload(
      `Summarize this screenshot: ${C}`,
      [imageAtom("design.png", "shot")],
      store,
    );
    expect(content).toEqual([
      { type: "text", text: "Summarize this screenshot: " },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "PNG-DATA" },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Defensive: atom count mismatches
// ---------------------------------------------------------------------------

describe("buildWirePayload — defensive count handling", () => {
  test("atoms.length < count(U+FFFC) — extra placeholders pass through verbatim", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `${C} ${C} ${C}`,
      [fileAtom("only-one.ts")],
      store,
    );
    // First placeholder gets the atom; the next two pass through as
    // literal U+FFFC characters inside the same coalesced text block.
    expect(content).toEqual([
      { type: "text", text: `\`@only-one.ts\` ${C} ${C}` },
    ]);
  });

  test("atoms.length > count(U+FFFC) — extra atoms are dropped silently", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `Just ${C}.`,
      [fileAtom("a.ts"), fileAtom("b.ts"), fileAtom("c.ts")],
      store,
    );
    expect(content).toEqual([{ type: "text", text: "Just `@a.ts`." }]);
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("buildWirePayload — purity", () => {
  test("does not mutate the input atoms array", () => {
    const store = createAtomBytesStore();
    store.put("img", { content: "X", mediaType: "image/png" });
    const atoms = [imageAtom("a.png", "img"), fileAtom("b.ts")];
    const snapshot = atoms.map((a) => ({ ...a }));
    buildWirePayload(`${C} ${C}`, atoms, store);
    expect(atoms).toEqual(snapshot);
  });

  test("does not mutate the bytes-store", () => {
    const store = createAtomBytesStore();
    store.put("a", { content: "AAA=", mediaType: "image/png" });
    const before = store.snapshot();
    buildWirePayload(`${C}`, [imageAtom("a.png", "a")], store);
    expect(store.snapshot()).toEqual(before);
  });

  test("same inputs yield deeply-equal content arrays across calls", () => {
    const store = createAtomBytesStore();
    store.put("img", { content: "X", mediaType: "image/png" });
    const atoms: ReadonlyArray<AtomSegment> = [imageAtom("a.png", "img")];
    const a = buildWirePayload(`${C}`, atoms, store);
    const b = buildWirePayload(`${C}`, atoms, store);
    expect(a.content).toEqual(b.content);
  });
});

// ---------------------------------------------------------------------------
// Block-shape stability
// ---------------------------------------------------------------------------

describe("buildWirePayload — output shape stability", () => {
  test("image blocks land in document order", () => {
    const store = createAtomBytesStore();
    store.put("third", { content: "3", mediaType: "image/png" });
    store.put("first", { content: "1", mediaType: "image/png" });
    store.put("second", { content: "2", mediaType: "image/png" });
    const { content } = buildWirePayload(
      `${C}${C}${C}`,
      [
        imageAtom("1.png", "first"),
        imageAtom("2.png", "second"),
        imageAtom("3.png", "third"),
      ],
      store,
    );
    const imageData = content
      .filter((c): c is { type: "image"; source: { type: "base64"; media_type: string; data: string } } => c.type === "image")
      .map((c) => c.source.data);
    expect(imageData).toEqual(["1", "2", "3"]);
  });

  test("text blocks preserve non-ASCII characters around atoms", () => {
    const store = createAtomBytesStore();
    const { content } = buildWirePayload(
      `🚀 ${C} — “quoted” ${C}.`,
      [fileAtom("a.ts"), fileAtom("b.ts")],
      store,
    );
    expect(content).toEqual([
      { type: "text", text: `🚀 \`@a.ts\` — “quoted” \`@b.ts\`.` },
    ]);
  });
});
