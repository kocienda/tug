/**
 * Pure-logic tests for `decorateChipLabel` — the transcript chip's displayed
 * name.
 *
 * The substrate walk and the copy formatter this component consumes are pinned
 * beside them in `lib/__tests__/atom-text.test.ts`; what is left here is the
 * one decision the component makes on its own.
 */

import { describe, expect, test } from "bun:test";

import { decorateChipLabel } from "../tug-atom-text-body";
import { type AtomSegment } from "@/lib/tug-atom-img";

// ---------------------------------------------------------------------------
// decorateChipLabel — Step 5c's transcript-vs-editor chip rendering
// ---------------------------------------------------------------------------

// Synthesized image atom — what the post-Step-5c synthesizer produces
// for an image content block. Label and value are both `image-N` (the
// editor's filename is gone at the submit boundary by design).
const ATOM_IMAGE_1: AtomSegment = {
  kind: "atom",
  type: "image",
  label: "image-1",
  value: "image-1",
};

describe("decorateChipLabel", () => {
  // Unified name: the displayed label is the atom's stored `image-N`
  // verbatim on every surface. The former `#u{turn}-` turn-address
  // prefix is retired, so `address` never alters the result — the
  // editor (no address) and transcript (address) render identically.

  test("image atom + address → bare `image-N`, no #u prefix", () => {
    expect(
      decorateChipLabel(ATOM_IMAGE_1, { speaker: "user", turn: 9 }),
    ).toBe("image-1");
  });

  test("steered message (sub set) → still bare `image-N`", () => {
    expect(
      decorateChipLabel(ATOM_IMAGE_1, { speaker: "user", turn: 17, sub: 1 }),
    ).toBe("image-1");
  });

  test("address unset → same `image-N` (editor and transcript agree)", () => {
    expect(decorateChipLabel(ATOM_IMAGE_1, undefined)).toBe("image-1");
  });

  test("non-image atom (file): stored label verbatim", () => {
    const fileAtom: AtomSegment = {
      kind: "atom",
      type: "file",
      label: "README.md",
      value: "README.md",
    };
    expect(
      decorateChipLabel(fileAtom, { speaker: "user", turn: 1 }),
    ).toBe("README.md");
  });

  test("non-image atom (link): stored label verbatim", () => {
    const linkAtom: AtomSegment = {
      kind: "atom",
      type: "link",
      label: "https://example.com",
      value: "https://example.com",
    };
    expect(
      decorateChipLabel(linkAtom, { speaker: "user", turn: 42 }),
    ).toBe("https://example.com");
  });
});
