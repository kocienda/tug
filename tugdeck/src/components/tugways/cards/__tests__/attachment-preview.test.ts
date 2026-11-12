/**
 * Pure-logic tests for `AttachmentPreview` — the shared
 * attachment-preview strip mounted below the user-row body in the
 * transcript and as the prompt-entry's compose-phase Z4C zone.
 *
 * The component itself is a React surface and would need DOM rendering
 * to fully exercise. Per the project's "no fake-DOM unit tests" rule
 * (happy-dom is gone), the tests cover the pure observable contract:
 *
 *   - **Unified label**: each tile's caption is exactly the `image-N`
 *     string the inline chip carries — one attach-time-minted name,
 *     identical on every surface (no `#u{turn}` decoration).
 *   - **Atom-array filtering**: the strip's documented contract
 *     ("`atoms` must already be image-only") is matched by the
 *     `UserMessageCell` filter that callers use; the test pins the
 *     filter formula.
 *   - **Snapshot shape from the bytes-store**: the strip's
 *     `useSyncExternalStore` projection reads `thumbnailDataUrl`
 *     directly from `bytesStore.get(atom.id)`. We test that
 *     projection function's behaviour against the bytes-store
 *     contract (entries present, entries missing, no id on atom).
 *
 * Full render shape (tile DOM, click delegation, focus ring) is
 * verified via the gallery card + manual smoke; the contract this
 * file pins is the substrate-to-projection seam the component sits
 * on top of.
 */

import { describe, expect, test } from "bun:test";

import { decorateChipLabel } from "../atom-text-body";
import {
  createAtomBytesStore,
  type AtomBytesStore,
} from "@/lib/atom-bytes-store";
import { type AtomSegment } from "@/lib/tug-atom-img";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function imageAtom(id: string, label = "image-1"): AtomSegment {
  return { kind: "atom", type: "image", label, value: label, id };
}

function fileAtom(path: string): AtomSegment {
  return { kind: "atom", type: "file", label: path, value: path };
}

// ---------------------------------------------------------------------------
// Chip-label === strip-caption equality
// ---------------------------------------------------------------------------

describe("AttachmentPreview — chip-label === strip-caption equality", () => {
  // The strip's `aria-label` and visible caption both compute via
  // `decorateChipLabel(atom, address)` — the same helper the inline
  // chip uses (`AtomTextBody` calls it inline). The unified-name
  // contract: the displayed label is the atom's stored `image-N`
  // verbatim, identical on every surface and independent of `address`
  // (the former `#u{turn}-` prefix is retired).

  test("image atom renders its bare 'image-N' label, no #u prefix", () => {
    const atom = imageAtom("editor-A", "image-1");
    const address = { speaker: "user" as const, turn: 9 };
    // Same call on both surfaces; address must not alter the result.
    expect(decorateChipLabel(atom, address)).toBe("image-1");
    expect(decorateChipLabel(atom, undefined)).toBe("image-1");
  });

  test("two atoms → labels stay paired and address-independent", () => {
    const a = imageAtom("editor-A", "image-1");
    const b = imageAtom("editor-B", "image-2");
    const address = { speaker: "user" as const, turn: 42 };
    expect(decorateChipLabel(a, address)).toBe("image-1");
    expect(decorateChipLabel(b, address)).toBe("image-2");
    // Editor (no address) and transcript (address) agree.
    expect(decorateChipLabel(a, undefined)).toBe("image-1");
    expect(decorateChipLabel(b, undefined)).toBe("image-2");
  });
});

// ---------------------------------------------------------------------------
// Image-atom filter (the UserMessageCell pre-filter that callers run
// before passing the array to the strip)
// ---------------------------------------------------------------------------

describe("UserMessageCell — image-atom filter for AttachmentPreview", () => {
  // The strip's prop contract says `atoms` must be image-only — the
  // caller (UserMessageCell) filters via `atoms.filter(a => a.type
  // === "image")`. This isn't a complex predicate, but pinning the
  // formula here documents the contract.

  test("mixed image + file atoms → file atoms are dropped from the strip's input", () => {
    const atoms: ReadonlyArray<AtomSegment> = [
      imageAtom("editor-A", "image-1"),
      fileAtom("README.md"),
      imageAtom("editor-B", "image-2"),
    ];
    const imageOnly = atoms.filter((a) => a.type === "image");
    expect(imageOnly).toHaveLength(2);
    expect(imageOnly.map((a) => a.label)).toEqual(["image-1", "image-2"]);
  });

  test("zero image atoms → empty array (strip renders nothing)", () => {
    const atoms: ReadonlyArray<AtomSegment> = [
      fileAtom("README.md"),
      fileAtom("docs/intro.md"),
    ];
    const imageOnly = atoms.filter((a) => a.type === "image");
    expect(imageOnly).toEqual([]);
  });

  test("image-only input passes through unchanged", () => {
    const atoms: ReadonlyArray<AtomSegment> = [
      imageAtom("editor-A", "image-1"),
      imageAtom("editor-B", "image-2"),
    ];
    const imageOnly = atoms.filter((a) => a.type === "image");
    expect(imageOnly).toEqual(atoms as AtomSegment[]);
  });
});

// ---------------------------------------------------------------------------
// Bytes-store projection — what the strip reads per tile
// ---------------------------------------------------------------------------

/**
 * Mirror of the strip's internal `buildSnapshot` projection. We
 * inline the same shape here so the tests pin the behaviour without
 * having to import the un-exported helper. The strip's component-
 * internal snapshot uses this exact shape.
 */
function projectTiles(
  atoms: ReadonlyArray<AtomSegment>,
  bytesStore: AtomBytesStore,
): Array<{ atomId: string; thumbnailDataUrl: string | undefined }> {
  return atoms.map((atom) => {
    const id = atom.id ?? "";
    const entry = id.length > 0 ? bytesStore.get(id) : null;
    return {
      atomId: id,
      thumbnailDataUrl: entry?.thumbnailDataUrl,
    };
  });
}

describe("AttachmentPreview — bytes-store projection", () => {
  test("atom with bytes-store entry + thumbnailDataUrl → tile carries the URL", () => {
    const store = createAtomBytesStore();
    store.put("editor-A", {
      content: "PNG-DATA",
      mediaType: "image/png",
      thumbnailDataUrl: "data:image/png;base64,thumb",
    });
    const tiles = projectTiles([imageAtom("editor-A")], store);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].atomId).toBe("editor-A");
    expect(tiles[0].thumbnailDataUrl).toBe("data:image/png;base64,thumb");
  });

  test("atom with bytes-store entry but no thumbnailDataUrl → tile shows placeholder (undefined URL)", () => {
    // Replay-path case: synthesizer minted the entry but the bake
    // hasn't fired/completed yet. The tile renders a placeholder
    // until the bake completes and the bytes-store subscriber fires.
    const store = createAtomBytesStore();
    store.put("editor-A", {
      content: "PNG-DATA",
      mediaType: "image/png",
      // thumbnailDataUrl omitted
    });
    const tiles = projectTiles([imageAtom("editor-A")], store);
    expect(tiles[0].thumbnailDataUrl).toBeUndefined();
  });

  test("atom with id but no bytes-store entry → tile shows placeholder", () => {
    // Defensive: an atom carries an id but the bytes-store has no
    // matching entry (synthesizer hasn't run yet, or the entry was
    // evicted). The projection returns `undefined` for the URL.
    const store = createAtomBytesStore();
    const tiles = projectTiles([imageAtom("orphaned-id")], store);
    expect(tiles[0].atomId).toBe("orphaned-id");
    expect(tiles[0].thumbnailDataUrl).toBeUndefined();
  });

  test("atom with no id → tile gets empty atomId and no URL", () => {
    // Defensive: an image atom without an id (would be a substrate
    // bug — `synthesizeUserMessageFromBlocks` always mints an id).
    // The projection gracefully degrades.
    const store = createAtomBytesStore();
    const atom: AtomSegment = {
      kind: "atom",
      type: "image",
      label: "image-1",
      value: "image-1",
    };
    const tiles = projectTiles([atom], store);
    expect(tiles[0].atomId).toBe("");
    expect(tiles[0].thumbnailDataUrl).toBeUndefined();
  });

  test("two atoms → projection preserves order; per-tile lookup is independent", () => {
    const store = createAtomBytesStore();
    store.put("editor-A", {
      content: "A",
      mediaType: "image/png",
      thumbnailDataUrl: "data:image/png;base64,A",
    });
    store.put("editor-B", {
      content: "B",
      mediaType: "image/jpeg",
      thumbnailDataUrl: "data:image/jpeg;base64,B",
    });
    const tiles = projectTiles(
      [imageAtom("editor-A"), imageAtom("editor-B")],
      store,
    );
    expect(tiles.map((t) => t.atomId)).toEqual(["editor-A", "editor-B"]);
    expect(tiles.map((t) => t.thumbnailDataUrl)).toEqual([
      "data:image/png;base64,A",
      "data:image/jpeg;base64,B",
    ]);
  });

  test("bytes-store update lands on the next projection (subscriber semantics)", () => {
    // The strip's `useSyncExternalStore` re-reads via `getSnapshot`
    // after `subscribe`'s listener fires; here we just confirm the
    // projection picks up the bytes-store's post-`put` state. The
    // listener wiring is the bytes-store's own contract — we trust
    // its own test suite — and we pin that the projection's read
    // path sees the new value.
    const store = createAtomBytesStore();
    store.put("editor-A", {
      content: "A",
      mediaType: "image/png",
      // No thumbnail yet (pre-bake).
    });
    let snap = projectTiles([imageAtom("editor-A")], store);
    expect(snap[0].thumbnailDataUrl).toBeUndefined();

    // Simulate the bake completing — the synthesizer's post-bake
    // update is a `put` that preserves content/mediaType and adds
    // the thumbnail. The next projection picks it up.
    store.put("editor-A", {
      content: "A",
      mediaType: "image/png",
      thumbnailDataUrl: "data:image/png;base64,thumb-late",
    });
    snap = projectTiles([imageAtom("editor-A")], store);
    expect(snap[0].thumbnailDataUrl).toBe("data:image/png;base64,thumb-late");
  });
});
