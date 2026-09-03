/**
 * The sidecar geometry for a document copy.
 *
 * The payload schema is *positional* — one U+FFFC in `text` per atom entry —
 * and a markdown link is a *range* of literal text. Making those two shapes
 * meet is where this can go wrong, and getting it wrong is not a crash: it
 * plants atom widgets over literal markup in the prompt entry, or drops an
 * attachment on the floor. So the geometry is pinned here, purely.
 *
 * The paste half does real file I/O (read the original through the blob route,
 * write it into the destination's `assets/`) and is verified against a running
 * app rather than here — there is no way to exercise it in a pure test without
 * hand-rolling the very interfaces it exists to drive.
 */

import { describe, expect, test } from "bun:test";

import { buildAssetSidecar } from "../asset-clipboard";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";

const BASE = "/u/docs";

describe("buildAssetSidecar", () => {
  test("an image link is substituted with U+FFFC and rides as an atom", () => {
    const sidecar = buildAssetSidecar("see ![photo](assets/photo.png) here", BASE);

    expect(sidecar).not.toBeNull();
    // The prompt entry's existing `insertSidecar` reconstitutes this with no
    // special casing at all — that is the whole reason images take this shape.
    expect(sidecar!.text).toBe(`see ${TUG_ATOM_CHAR} here`);
    expect(sidecar!.atoms).toHaveLength(1);
    expect(sidecar!.atoms[0]).toEqual({
      position: 4,
      segment: {
        kind: "atom",
        type: "image",
        label: "photo",
        value: "photo.png",
        id: "asset:/u/docs/assets/photo.png",
      },
      assetPath: "/u/docs/assets/photo.png",
      assetName: "photo.png",
    });
    expect(sidecar!.assets).toBeUndefined();
  });

  test("a non-image link stays literal text and rides as a range", () => {
    const text = "see [notes](assets/notes.zip) here";
    const sidecar = buildAssetSidecar(text, BASE);

    expect(sidecar).not.toBeNull();
    // Untouched: there is no atom entry to place, so the prompt inserts the
    // markup verbatim and non-images can never become atoms there.
    expect(sidecar!.text).toBe(text);
    expect(sidecar!.atoms).toEqual([]);
    const range = sidecar!.assets![0];
    // The range indexes the payload's own text — which here is the document's
    // text unchanged, since nothing was substituted.
    expect(sidecar!.text.slice(range.from, range.to)).toBe(
      "[notes](assets/notes.zip)",
    );
    expect(range.assetPath).toBe("/u/docs/assets/notes.zip");
    expect(range.assetName).toBe("notes.zip");
  });

  test("positions stay correct when both classes are mixed", () => {
    // The substitution shortens the text, so a range recorded after an image
    // would be wrong if the two were computed in the same pass front-to-back.
    const sidecar = buildAssetSidecar(
      "![a](assets/a.png) then [z](assets/z.zip)",
      BASE,
    );

    expect(sidecar!.text).toBe(`${TUG_ATOM_CHAR} then [z](assets/z.zip)`);
    expect(sidecar!.atoms[0].position).toBe(0);
    // Every offset indexes the payload's own text. Reading the range straight
    // back out of it is the assertion that cannot pass by coincidence.
    const range = sidecar!.assets![0];
    expect(sidecar!.text.slice(range.from, range.to)).toBe("[z](assets/z.zip)");
    expect(sidecar!.text[sidecar!.atoms[0].position]).toBe(TUG_ATOM_CHAR);
  });

  test("a destination with spaces round-trips through its angle brackets", () => {
    const sidecar = buildAssetSidecar("![p](<assets/my photo.png>)", BASE);

    expect(sidecar!.atoms[0].assetPath).toBe("/u/docs/assets/my photo.png");
    expect(sidecar!.atoms[0].assetName).toBe("my photo.png");
  });

  test("links that are not attachments are ignored entirely", () => {
    // An ordinary relative link between documents is not an attachment, and a
    // roadmap full of them must not produce a sidecar at all.
    expect(
      buildAssetSidecar("see [the plan](../arc/plan.md) and [x](#anchor)", BASE),
    ).toBeNull();
    expect(buildAssetSidecar("no links here", BASE)).toBeNull();
    expect(buildAssetSidecar("![p](assets/p.png)", null)).toBeNull();
  });

  test("several images each get their own entry, in document order", () => {
    const sidecar = buildAssetSidecar(
      "![a](assets/a.png) ![b](assets/b.png)",
      BASE,
    );

    expect(sidecar!.text).toBe(`${TUG_ATOM_CHAR} ${TUG_ATOM_CHAR}`);
    expect(sidecar!.atoms.map((a) => a.position)).toEqual([0, 2]);
    expect(sidecar!.atoms.map((a) => a.assetName)).toEqual(["a.png", "b.png"]);
  });
});
