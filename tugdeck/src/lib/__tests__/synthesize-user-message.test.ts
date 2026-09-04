/**
 * `synthesize-user-message` — unit tests for the shared content-block
 * → substrate synthesizer used by both the live submit path and the
 * JSONL replay path.
 *
 * Pins the contract documented in
 * [Step 5c](arc/dev-atoms.md#step-5c):
 *   - the (text, atoms) substrate is deterministic on its inputs
 *     given a stable resolver/minter;
 *   - the bytes-store side-effect lands `content` + `mediaType` for
 *     every image block, keyed by the resolved id;
 *   - the `atomIdAt` resolver is honored when present and falls
 *     through to fresh UUIDs otherwise;
 *   - the optional `bakeImage` stub completes asynchronously and
 *     updates the bytes-store entry's `thumbnailDataUrl` when it
 *     resolves with a non-null value.
 *
 * The default `bakeImage` uses a Web Worker which can't run in
 * bun:test, so every test that wants to verify thumbnail propagation
 * passes a stub baker (no Worker needed).
 */

import { describe, expect, test } from "bun:test";

import {
  synthesizeUserMessageFromBlocks,
} from "../synthesize-user-message";
import {
  createAtomBytesStore,
} from "../atom-bytes-store";
import { TUG_ATOM_CHAR } from "../tug-atom-img";
import type { ContentBlock } from "@/protocol";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const C = TUG_ATOM_CHAR;

const TEXT_HELLO: ContentBlock = { type: "text", text: "hello" };
const TEXT_A: ContentBlock = { type: "text", text: "a " };
const TEXT_B: ContentBlock = { type: "text", text: " b" };
const IMAGE_PNG: ContentBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "PNG-BASE64" },
};
const IMAGE_JPG: ContentBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/jpeg", data: "JPG-BASE64" },
};

/** Deterministic UUID minter — returns `mock-uuid-N` so tests can
 *  pin atom ids without depending on `crypto.randomUUID()`. */
function makeCounter(): () => string {
  let n = 0;
  return () => {
    const id = `mock-uuid-${n}`;
    n += 1;
    return id;
  };
}

/** Stub `bakeImage` that resolves immediately to a canned data URL
 *  derived from the input — lets tests assert that the bake plumbed
 *  through to the bytes-store without spinning up a Web Worker. */
async function stubBake(data: string, mediaType: string): Promise<string | null> {
  return `data:${mediaType};base64,thumb-of-${data}`;
}

// ---------------------------------------------------------------------------
// Empty / trivial
// ---------------------------------------------------------------------------

describe("synthesizeUserMessageFromBlocks — empty / trivial", () => {
  test("empty blocks produce empty substrate", () => {
    const store = createAtomBytesStore();
    const { text, atoms } = synthesizeUserMessageFromBlocks([], store);
    expect(text).toBe("");
    expect(atoms).toEqual([]);
    expect(store.size()).toBe(0);
  });

  test("single text block produces text + no atoms", () => {
    const store = createAtomBytesStore();
    const { text, atoms } = synthesizeUserMessageFromBlocks(
      [TEXT_HELLO],
      store,
    );
    expect(text).toBe("hello");
    expect(atoms).toEqual([]);
  });

  test("consecutive text blocks coalesce in the substrate", () => {
    // Two text blocks produce one substrate string concatenation —
    // the substrate has no notion of "blocks", only `U+FFFC` slots
    // for atoms. Pre-image-block runs of text concatenate.
    const store = createAtomBytesStore();
    const { text, atoms } = synthesizeUserMessageFromBlocks(
      [TEXT_A, TEXT_B],
      store,
    );
    expect(text).toBe("a  b");
    expect(atoms).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Interleaved text + image
// ---------------------------------------------------------------------------

describe("synthesizeUserMessageFromBlocks — interleaved text + image", () => {
  test("text/image/text produces 'a ￼ b' + one atom", () => {
    const store = createAtomBytesStore();
    const { text, atoms } = synthesizeUserMessageFromBlocks(
      [TEXT_A, IMAGE_PNG, TEXT_B],
      store,
      { mintAtomId: makeCounter(), bakeImage: stubBake },
    );
    expect(text).toBe(`a ${C} b`);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toEqual({
      kind: "atom",
      type: "image",
      label: "image-1",
      value: "image-1",
      id: "mock-uuid-0",
    });
    // Bytes-store landed under the minted id with content + mediaType.
    expect(store.get("mock-uuid-0")).toEqual({
      content: "PNG-BASE64",
      mediaType: "image/png",
    });
  });

  test("consecutive image blocks produce '￼￼' + two atoms", () => {
    const store = createAtomBytesStore();
    const { text, atoms } = synthesizeUserMessageFromBlocks(
      [IMAGE_PNG, IMAGE_JPG],
      store,
      { mintAtomId: makeCounter(), bakeImage: stubBake },
    );
    expect(text).toBe(`${C}${C}`);
    expect(atoms).toHaveLength(2);
    expect(atoms[0].label).toBe("image-1");
    expect(atoms[1].label).toBe("image-2");
  });

  test("image-only produces '￼' + one atom", () => {
    const store = createAtomBytesStore();
    const { text, atoms } = synthesizeUserMessageFromBlocks(
      [IMAGE_PNG],
      store,
      { mintAtomId: makeCounter(), bakeImage: stubBake },
    );
    expect(text).toBe(C);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].label).toBe("image-1");
  });
});

// ---------------------------------------------------------------------------
// atomIdAt resolver behaviour
// ---------------------------------------------------------------------------

describe("synthesizeUserMessageFromBlocks — atomIdAt resolver", () => {
  test("live path resolver: atoms reuse editor ids; bytes-store under those ids", () => {
    const store = createAtomBytesStore();
    const ids = ["editor-id-A", "editor-id-B"];
    const { atoms } = synthesizeUserMessageFromBlocks(
      [IMAGE_PNG, IMAGE_JPG],
      store,
      { atomIdAt: (i) => ids[i], mintAtomId: makeCounter(), bakeImage: stubBake },
    );
    expect(atoms.map((a) => a.id)).toEqual(["editor-id-A", "editor-id-B"]);
    expect(store.get("editor-id-A")?.content).toBe("PNG-BASE64");
    expect(store.get("editor-id-B")?.content).toBe("JPG-BASE64");
  });

  test("replay path (no resolver): atoms get freshly-minted ids", () => {
    const store = createAtomBytesStore();
    const { atoms } = synthesizeUserMessageFromBlocks(
      [IMAGE_PNG, IMAGE_JPG],
      store,
      { mintAtomId: makeCounter(), bakeImage: stubBake },
    );
    expect(atoms.map((a) => a.id)).toEqual(["mock-uuid-0", "mock-uuid-1"]);
  });

  test("resolver returns undefined for some indices → fresh UUIDs for those", () => {
    // Defensive against a partially-populated editor substrate: the
    // resolver returns an id for image-block 0 but not for 1; the
    // synthesizer falls through to the minter for the unresolved
    // index. Confirms no crash, no orphaned id.
    const store = createAtomBytesStore();
    const { atoms } = synthesizeUserMessageFromBlocks(
      [IMAGE_PNG, IMAGE_JPG],
      store,
      {
        atomIdAt: (i) => (i === 0 ? "editor-id-A" : undefined),
        mintAtomId: makeCounter(),
      },
    );
    expect(atoms[0].id).toBe("editor-id-A");
    expect(atoms[1].id).toBe("mock-uuid-0");
    expect(store.get("editor-id-A")?.content).toBe("PNG-BASE64");
    expect(store.get("mock-uuid-0")?.content).toBe("JPG-BASE64");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("synthesizeUserMessageFromBlocks — determinism", () => {
  test("two calls with the same inputs and resolver produce byte-identical substrate", () => {
    const blocks = [TEXT_A, IMAGE_PNG, TEXT_B];
    const ids = ["editor-id-A"];
    const a = synthesizeUserMessageFromBlocks(
      blocks,
      createAtomBytesStore(),
      { atomIdAt: (i) => ids[i], mintAtomId: makeCounter(), bakeImage: stubBake },
    );
    const b = synthesizeUserMessageFromBlocks(
      blocks,
      createAtomBytesStore(),
      { atomIdAt: (i) => ids[i], mintAtomId: makeCounter(), bakeImage: stubBake },
    );
    expect(a.text).toBe(b.text);
    expect(a.atoms).toEqual(b.atoms);
  });

  test("without a resolver, substrate text matches; only ids differ (documented seam)", () => {
    const blocks = [IMAGE_PNG];
    const minterA = makeCounter();
    const minterB = (() => {
      let n = 0;
      return () => `B-uuid-${n++}`;
    })();
    const a = synthesizeUserMessageFromBlocks(
      blocks,
      createAtomBytesStore(),
      { mintAtomId: minterA, bakeImage: stubBake },
    );
    const b = synthesizeUserMessageFromBlocks(
      blocks,
      createAtomBytesStore(),
      { mintAtomId: minterB, bakeImage: stubBake },
    );
    expect(a.text).toBe(b.text);
    expect(a.atoms[0]?.label).toBe(b.atoms[0]?.label);
    expect(a.atoms[0]?.id).not.toBe(b.atoms[0]?.id);
  });
});

// ---------------------------------------------------------------------------
// Thumbnail bake
// ---------------------------------------------------------------------------

describe("synthesizeUserMessageFromBlocks — thumbnail bake", () => {
  test("fires a bake on the replay path when no existing thumbnail; updates entry", async () => {
    const store = createAtomBytesStore();
    const { atoms, thumbnailBake } = synthesizeUserMessageFromBlocks(
      [IMAGE_PNG],
      store,
      { mintAtomId: makeCounter(), bakeImage: stubBake },
    );
    // Before bake settles: entry has no thumbnail.
    const id = atoms[0].id!;
    expect(store.get(id)?.thumbnailDataUrl).toBeUndefined();
    await thumbnailBake;
    // After bake: entry's thumbnail is the stub's data URL,
    // content + mediaType unchanged.
    const updated = store.get(id);
    expect(updated?.content).toBe("PNG-BASE64");
    expect(updated?.mediaType).toBe("image/png");
    expect(updated?.thumbnailDataUrl).toBe("data:image/png;base64,thumb-of-PNG-BASE64");
  });

  test("does NOT re-bake when bytes-store entry already carries a thumbnail (live-path drop case)", async () => {
    // Live path: drop / paste pre-populated bytes-store with a
    // thumbnail. The synthesizer's idempotent put must preserve it
    // and skip the bake.
    const store = createAtomBytesStore();
    store.put("live-id", {
      content: "PNG-BASE64",
      mediaType: "image/png",
      thumbnailDataUrl: "data:image/png;base64,drop-time-thumbnail",
    });
    let bakeCalled = false;
    const { atoms, thumbnailBake } = synthesizeUserMessageFromBlocks(
      [IMAGE_PNG],
      store,
      {
        atomIdAt: () => "live-id",
        mintAtomId: makeCounter(),
        bakeImage: async () => {
          bakeCalled = true;
          return "data:should-not-appear";
        },
      },
    );
    await thumbnailBake;
    expect(bakeCalled).toBe(false);
    expect(atoms[0].id).toBe("live-id");
    expect(store.get("live-id")?.thumbnailDataUrl).toBe(
      "data:image/png;base64,drop-time-thumbnail",
    );
  });

  test("bake failure leaves entry without thumbnail (soft degradation)", async () => {
    const store = createAtomBytesStore();
    const { atoms, thumbnailBake } = synthesizeUserMessageFromBlocks(
      [IMAGE_PNG],
      store,
      {
        mintAtomId: makeCounter(),
        bakeImage: async () => null,
      },
    );
    await thumbnailBake;
    expect(store.get(atoms[0].id!)?.thumbnailDataUrl).toBeUndefined();
  });

  test("thumbnailBake resolves immediately when there are no image blocks", async () => {
    const store = createAtomBytesStore();
    const { thumbnailBake } = synthesizeUserMessageFromBlocks(
      [TEXT_HELLO],
      store,
    );
    // No bakes were fired; the promise resolves immediately.
    await thumbnailBake;
  });
});

// ---------------------------------------------------------------------------
// Round-trip integration with buildWirePayload
// ---------------------------------------------------------------------------

import { buildWirePayload } from "../build-wire-payload";
import type { AtomSegment } from "../tug-atom-img";

describe("synthesizeUserMessageFromBlocks + buildWirePayload round-trip", () => {
  test("editor's (text, atoms) → blocks → synthesized substrate preserves image positions and reuses ids", () => {
    // Editor substrate: prose around two image atoms with distinct ids.
    const store = createAtomBytesStore();
    store.put("editor-A", { content: "PNG-A", mediaType: "image/png" });
    store.put("editor-B", { content: "JPG-B", mediaType: "image/jpeg" });
    const editorText = `look ${C} and ${C} please`;
    const editorAtoms: AtomSegment[] = [
      { kind: "atom", type: "image", label: "raphael.jpeg", value: "raphael.jpeg", id: "editor-A" },
      { kind: "atom", type: "image", label: "cat.png", value: "cat.png", id: "editor-B" },
    ];

    const wire = buildWirePayload(editorText, editorAtoms, store);
    const synth = synthesizeUserMessageFromBlocks(wire.content, store, {
      atomIdAt: wire.atomIdAt,
      mintAtomId: makeCounter(),
      bakeImage: stubBake,
    });

    // Substrate retains image positions; labels are `image-N`, not
    // the editor's filenames (those are gone at the submit boundary).
    expect(synth.text).toBe(`look ${C} and ${C} please`);
    expect(synth.atoms).toHaveLength(2);
    expect(synth.atoms[0]).toEqual({
      kind: "atom",
      type: "image",
      label: "image-1",
      value: "image-1",
      id: "editor-A",
    });
    expect(synth.atoms[1]).toEqual({
      kind: "atom",
      type: "image",
      label: "image-2",
      value: "image-2",
      id: "editor-B",
    });
    // Bytes-store entries stayed under the editor's ids — no orphans
    // from a freshly-minted UUID.
    expect(store.get("editor-A")?.content).toBe("PNG-A");
    expect(store.get("editor-B")?.content).toBe("JPG-B");
  });

  test("bytes-less editor atom rides as a mention chip; resolver indices still align with emitted image blocks", () => {
    const store = createAtomBytesStore();
    store.put("editor-good", { content: "PNG", mediaType: "image/png" });
    // Two editor atoms; only one has bytes. The bytes-less atom can't
    // ride as an image block (no bytes), so it falls through to the
    // non-image branch and substitutes as a backtick-`@` mention
    // marker — preserving its position + label on the wire. The
    // bytes-bearing atom emits a single image block; the resolver
    // pins it to that block's index (still 0; the mention rides in
    // the text block, not the image-block index).
    const editorText = `${C} ${C}`;
    const editorAtoms: AtomSegment[] = [
      { kind: "atom", type: "image", label: "missing.png", value: "missing.png", id: "editor-evicted" },
      { kind: "atom", type: "image", label: "good.png", value: "good.png", id: "editor-good" },
    ];

    const wire = buildWirePayload(editorText, editorAtoms, store);
    const synth = synthesizeUserMessageFromBlocks(wire.content, store, {
      atomIdAt: wire.atomIdAt,
      mintAtomId: makeCounter(),
      bakeImage: stubBake,
    });

    // Substrate has both atoms. The first is a mention chip (recovered
    // from the marker, type "file" since the marker doesn't preserve
    // the original "image" type); the second is the real image atom.
    expect(synth.text).toBe(`${C} ${C}`);
    expect(synth.atoms).toHaveLength(2);
    expect(synth.atoms[0]).toMatchObject({
      kind: "atom",
      type: "file",
      label: "missing.png",
      value: "missing.png",
    });
    // Mention atoms have no id — they're recovered purely from the
    // wire marker which doesn't carry one (matches `@`-completion
    // atoms in the editor which also have no id).
    expect(synth.atoms[0].id).toBeUndefined();
    expect(synth.atoms[1]).toMatchObject({
      kind: "atom",
      type: "image",
      label: "image-1",
      id: "editor-good",
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Non-image atom round-trip via backtick-`@` mention marker
  // ─────────────────────────────────────────────────────────────

  test("non-image atom round-trip: file atom → wire marker → synth chip at original position", () => {
    const store = createAtomBytesStore();
    // Editor substrate: prose with one `@`-mention chip.
    const editorText = `Read ${C} please.`;
    const editorAtoms: AtomSegment[] = [
      { kind: "atom", type: "file", label: "README.md", value: "README.md" },
    ];

    const wire = buildWirePayload(editorText, editorAtoms, store);
    // Wire is a single text block with the marker wrapping the value.
    expect(wire.content).toEqual([
      { type: "text", text: "Read `@README.md` please." },
    ]);

    const synth = synthesizeUserMessageFromBlocks(wire.content, store, {
      atomIdAt: wire.atomIdAt,
      mintAtomId: makeCounter(),
      bakeImage: stubBake,
    });

    // Substrate matches the editor's text + atoms — the chip is at
    // the same `U+FFFC` position. The synthesized atom defaults to
    // `type: "file"` (the marker doesn't preserve the original type).
    expect(synth.text).toBe(`Read ${C} please.`);
    expect(synth.atoms).toHaveLength(1);
    expect(synth.atoms[0]).toMatchObject({
      kind: "atom",
      type: "file",
      label: "README.md",
      value: "README.md",
    });
  });

  test("commit atom round-trip: the mark keeps its kind and its `commit:<8>` spelling", () => {
    const store = createAtomBytesStore();
    // The mark a reader placed in the composer — a commit, whose value is a
    // bare sha and whose label is the one spelling every commit surface shows.
    const sha = "d69e4f8bcb850c5b617270e5dee19ed6460966af";
    const editorText = `look at ${C} again`;
    const editorAtoms: AtomSegment[] = [
      { kind: "atom", type: "commit", label: "commit:d69e4f8b", value: sha },
    ];

    const wire = buildWirePayload(editorText, editorAtoms, store);
    // One mechanism on the wire, the same marker a file mention rides.
    expect(wire.content).toEqual([
      { type: "text", text: `look at \`@${sha}\` again` },
    ]);

    const synth = synthesizeUserMessageFromBlocks(wire.content, store, {
      atomIdAt: wire.atomIdAt,
      mintAtomId: makeCounter(),
      bakeImage: stubBake,
    });

    // It comes back as what it went out as. Before the sha shape was a
    // discriminator it came back a FILE labelled with all forty characters,
    // so the sent row drew the file chip and the reader watched the mark
    // change kind on submit.
    expect(synth.text).toBe(`look at ${C} again`);
    expect(synth.atoms).toHaveLength(1);
    expect(synth.atoms[0]).toMatchObject({
      kind: "atom",
      type: "commit",
      label: "commit:d69e4f8b",
      value: sha,
    });
  });

  test("non-image + image atoms interleaved round-trip cleanly", () => {
    const store = createAtomBytesStore();
    store.put("editor-img", { content: "PNG", mediaType: "image/png" });
    // Two atoms: a file-mention, then an image.
    const editorText = `Compare ${C} with ${C}`;
    const editorAtoms: AtomSegment[] = [
      { kind: "atom", type: "file", label: "main.ts", value: "main.ts" },
      { kind: "atom", type: "image", label: "shot.png", value: "shot.png", id: "editor-img" },
    ];

    const wire = buildWirePayload(editorText, editorAtoms, store);
    // Wire: one text block carrying the marker + the prose before the
    // image, then the image block.
    expect(wire.content).toHaveLength(2);
    expect(wire.content[0]).toEqual({
      type: "text",
      text: "Compare `@main.ts` with ",
    });
    expect((wire.content[1] as { type: string }).type).toBe("image");

    const synth = synthesizeUserMessageFromBlocks(wire.content, store, {
      atomIdAt: wire.atomIdAt,
      mintAtomId: makeCounter(),
      bakeImage: stubBake,
    });

    expect(synth.text).toBe(`Compare ${C} with ${C}`);
    expect(synth.atoms).toHaveLength(2);
    expect(synth.atoms[0]).toMatchObject({
      kind: "atom",
      type: "file",
      label: "main.ts",
      value: "main.ts",
    });
    expect(synth.atoms[1]).toMatchObject({
      kind: "atom",
      type: "image",
      label: "image-1",
      id: "editor-img",
    });
  });
});

describe("synthesizeUserMessageFromBlocks — command-expansion echo", () => {
  test("a command echo synthesizes a single command atom", () => {
    const store = createAtomBytesStore();
    const echo: ContentBlock = {
      type: "text",
      text:
        "<command-message>tugplug:commit</command-message>\n" +
        "<command-name>/tugplug:commit</command-name>",
    };
    const synth = synthesizeUserMessageFromBlocks([echo], store, {
      mintAtomId: makeCounter(),
    });
    expect(synth.text).toBe(C);
    expect(synth.atoms).toEqual([
      { kind: "atom", type: "command", label: "tugplug:commit", value: "tugplug:commit" },
    ]);
  });

  test("a command echo with args renders the args as trailing text", () => {
    const store = createAtomBytesStore();
    const echo: ContentBlock = {
      type: "text",
      text:
        "<command-name>/cmd</command-name>\n" +
        "<command-args>one two</command-args>",
    };
    const synth = synthesizeUserMessageFromBlocks([echo], store, {
      mintAtomId: makeCounter(),
    });
    expect(synth.text).toBe(`${C} one two`);
    expect(synth.atoms).toEqual([
      { kind: "atom", type: "command", label: "cmd", value: "cmd" },
    ]);
  });

  test("a command echo with a file-mention arg recovers the file chip", () => {
    const store = createAtomBytesStore();
    const echo: ContentBlock = {
      type: "text",
      text:
        "<command-name>/tugplug:implement</command-name>\n" +
        "<command-args>`@arc/z2-status-redesign.md`, all steps</command-args>",
    };
    const synth = synthesizeUserMessageFromBlocks([echo], store, {
      mintAtomId: makeCounter(),
    });
    expect(synth.text).toBe(`${C} ${C}, all steps`);
    expect(synth.atoms).toEqual([
      {
        kind: "atom",
        type: "command",
        label: "tugplug:implement",
        value: "tugplug:implement",
      },
      {
        kind: "atom",
        type: "file",
        label: "arc/z2-status-redesign.md",
        value: "arc/z2-status-redesign.md",
      },
    ]);
  });

  test("ordinary text that is not an envelope is untouched (no command atom)", () => {
    const store = createAtomBytesStore();
    const synth = synthesizeUserMessageFromBlocks(
      [{ type: "text", text: "just text" }],
      store,
      { mintAtomId: makeCounter() },
    );
    expect(synth.text).toBe("just text");
    expect(synth.atoms).toHaveLength(0);
  });

  // Marker guard: a bare `/name` (an embedded or non-expanded command,
  // which carries no `@`-mention marker) must stay plain text — never be
  // re-minted as a file atom by the generic marker walk.
  test("a bare /name text block synthesizes no atom", () => {
    const store = createAtomBytesStore();
    const synth = synthesizeUserMessageFromBlocks(
      [{ type: "text", text: "/help" }],
      store,
      { mintAtomId: makeCounter() },
    );
    expect(synth.text).toBe("/help");
    expect(synth.atoms).toHaveLength(0);
  });
});
