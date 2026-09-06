/**
 * atom-identity-attributes.test.tsx — the attribute contract every atom
 * renderer owes, read off the element tree.
 *
 * A copy that crosses an atom recognises it by one thing: the
 * `data-atom-type` / `-label` / `-value` trio, plus `data-atom-id` where the
 * atom has an id. `selectionToTranscriptSubstrate` reads exactly those and
 * nothing else, so a mount that forgets them renders a pill the serializer
 * walks straight into — which is what a confirmed commit mention did, and why
 * it pasted as two prose runs rather than as a commit.
 *
 * The trio is therefore the COMPONENT's to emit, not a spread each caller
 * remembers. This file is where a fourth renderer finds out it forgot.
 *
 * No DOM: `TugCommitAtom` is hook-free, so its `forwardRef` render function is
 * called directly and the element it returns is read as data — the idiom
 * `filter-highlight.test.tsx` uses. The doctrine bans a fake-DOM render, and
 * the other renderers cannot be reached this way at all — `TugAtomChip`
 * measures its label on a canvas, `TugSessionCitation`'s stores carry no server
 * snapshot, and the editor's chip is a baked `<img>`. So their half of the
 * contract is pinned where they all now read it from: `atomIdentityAttrs`, the
 * one pure function that authors the attributes. A renderer that spreads it
 * cannot emit three of the four, or spell one of them its own way.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";

import { commitAtomLabel } from "@/lib/commit-format";
import { atomIdentityAttrs } from "@/lib/atom-identity-attrs";
import { COMMIT_ATOM_TYPE } from "@/lib/command-atom";
import {
  TugCommitAtom,
  type TugCommitAtomProps,
} from "../tug-commit-atom";

/** A full sha, longer than the label's eight, so truncation is observable. */
const SHA = "64747b8c9a1d3f0e5b2c7a8d9e0f1a2b3c4d5e6f";

/**
 * The element a `forwardRef` component returns, without a renderer.
 *
 * `TugCommitAtom` calls no hooks, so its render function is an ordinary
 * function of props — reading its output is reading what the DOM would get.
 */
function renderCommitAtom(
  props: TugCommitAtomProps,
): React.ReactElement<Record<string, unknown>> {
  const { render } = TugCommitAtom as unknown as {
    render: (
      p: TugCommitAtomProps,
      ref: null,
    ) => React.ReactElement<Record<string, unknown>>;
  };
  return render(props, null);
}

describe("TugCommitAtom carries its own identity", () => {
  test("the trio is emitted from the sha alone", () => {
    const { props } = renderCommitAtom({ sha: SHA });
    expect(props["data-atom-type"]).toBe(COMMIT_ATOM_TYPE);
    expect(props["data-atom-label"]).toBe(commitAtomLabel(SHA));
    expect(props["data-atom-value"]).toBe(SHA);
  });

  test("a mention that drops the leading word still carries the trio", () => {
    // The [F01] pill exactly: `useCommitTipPortals` passes `word={false}` when
    // the sentence already said the word. What the pill PRINTS is the only
    // thing that flag decides; what it IS does not change.
    const { props } = renderCommitAtom({ sha: SHA, word: false });
    expect(props["data-atom-type"]).toBe(COMMIT_ATOM_TYPE);
    expect(props["data-atom-label"]).toBe(commitAtomLabel(SHA));
    expect(props["data-atom-value"]).toBe(SHA);
  });

  test("an interactive or missing pill carries the trio unchanged", () => {
    for (const variant of [{ interactive: true }, { missing: true }]) {
      const { props } = renderCommitAtom({ sha: SHA, ...variant });
      expect(props["data-atom-type"]).toBe(COMMIT_ATOM_TYPE);
      expect(props["data-atom-value"]).toBe(SHA);
    }
  });

  test("the value is the sha as given, not the label's eight", () => {
    // A short reference stays short and a full one stays full: git resolves
    // either, and `atomSegmentFor`'s commit arm is the identity function on
    // this field. A pill that published its truncated label as its value would
    // hand the clipboard a different commit reference than it was built from.
    const short = SHA.slice(0, 8);
    expect(renderCommitAtom({ sha: short }).props["data-atom-value"]).toBe(short);
    expect(renderCommitAtom({ sha: SHA }).props["data-atom-value"]).toBe(SHA);
  });

  test("no id is claimed — a commit atom has none", () => {
    // `data-atom-id` is how an image atom's bytes are found again. A commit
    // has no such record, and an empty id attribute would make the serializer
    // write a sidecar entry pointing at nothing.
    const { props } = renderCommitAtom({ sha: SHA });
    expect("data-atom-id" in props ? props["data-atom-id"] : undefined).toBeUndefined();
  });

  test("a caller cannot overrule the identity by spreading its own", () => {
    // The two placed-atom mounts used to spread the trio by hand. They no
    // longer do, and a leftover spread must not be able to relabel the pill as
    // something else — the component is the author of record.
    const { props } = renderCommitAtom({
      sha: SHA,
      ...({ "data-atom-type": "file", "data-atom-value": "/tmp/x" } as object),
    } as TugCommitAtomProps);
    expect(props["data-atom-type"]).toBe(COMMIT_ATOM_TYPE);
    expect(props["data-atom-value"]).toBe(SHA);
  });
});

describe("atomIdentityAttrs is the contract every renderer spreads", () => {
  // `TugAtomChip`, `TugSessionCitation` and the editor's baked `<img>` cannot
  // be rendered without a `document`, so this is where their half of the
  // contract is pinned: they each spread exactly this record, so what it
  // produces is what they emit.

  test("one row per kind — the four attributes, spelled one way", () => {
    const rows = [
      { type: "commit", label: "commit:64747b8c", value: "64747b8c9a" },
      { type: "file", label: "atom-text.ts", value: "tugdeck/src/lib/atom-text.ts" },
      { type: "session", label: "amber-otter", value: "68ebb98b" },
      { type: "command", label: "arc-implement", value: "/arc-implement" },
      { type: "link", label: "the brief", value: "https://example.invalid/brief" },
      { type: "image", label: "shot.png", value: "shot.png" },
    ];
    for (const row of rows) {
      expect(atomIdentityAttrs(row)).toEqual({
        "data-atom-type": row.type,
        "data-atom-label": row.label,
        "data-atom-value": row.value,
      });
    }
  });

  test("an id rides along when the atom has one", () => {
    // The image case: the id is the join key to the bytes-store entry, and a
    // sidecar entry written without it can carry no payload at all.
    expect(
      atomIdentityAttrs({
        type: "image",
        label: "shot.png",
        value: "shot.png",
        id: "1f8c2e04-7b3a-4d51-9c60-2a8e5f7b1d33",
      })["data-atom-id"],
    ).toBe("1f8c2e04-7b3a-4d51-9c60-2a8e5f7b1d33");
  });

  test("no id, and an empty id, are both absent rather than written", () => {
    // Absent rather than empty: `setAttribute` writes the string it is given,
    // so an empty id would make the serializer publish an entry pointing at a
    // store row that is not there. `in` rather than a value check, because the
    // DOM caller iterates the record's keys.
    expect("data-atom-id" in atomIdentityAttrs({ type: "file", label: "a", value: "a" })).toBe(false);
    expect(
      "data-atom-id" in atomIdentityAttrs({ type: "file", label: "a", value: "a", id: "" }),
    ).toBe(false);
  });

  test("the value is carried through untouched", () => {
    // No trimming, no abbreviation, no normalisation: the label is what a
    // reader sees and the value is what the atom IS, and the round trip back
    // through the clipboard has to land on the same string it started at.
    const value = "  tugdeck/src/lib/atom text.ts  ";
    expect(atomIdentityAttrs({ type: "file", label: "atom text.ts", value })["data-atom-value"]).toBe(value);
  });
});
