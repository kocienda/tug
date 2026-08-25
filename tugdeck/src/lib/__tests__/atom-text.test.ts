/**
 * Pure-logic tests for the `(text, atoms)` substrate's three readings: the
 * segment walk a renderer maps over, the plain text a copy writes, and the
 * clipboard sidecar that makes a paste back into Tug produce chips again.
 *
 * They are pinned together because they must not disagree — a row, its copy,
 * and a paste of that copy are one substrate read three ways.
 *
 * The sidecar is round-tripped through `parseClipboardSidecar`, the reader on
 * the paste side, rather than only asserted field-by-field: the two have to
 * agree on the schema, and a test that only inspects the object it just built
 * cannot tell you that they do.
 */

import { describe, expect, test } from "bun:test";

import {
  atomTextClipboardPayload,
  formatAtomTextForCopy,
  walkAtomText,
  type AtomTextSegment,
} from "../atom-text";
import { parseClipboardSidecar } from "@/components/tugways/tug-text-editor/clipboard-filters";
import { TUG_ATOM_CHAR, type AtomSegment } from "@/lib/tug-atom-img";
import type { AtomBytesEntry } from "@/lib/atom-bytes-store";

const ATOM_COMMAND: AtomSegment = {
  kind: "atom",
  type: "command",
  label: "tugplug:dash",
  value: "tugplug:dash",
};

const ATOM_FILE: AtomSegment = {
  kind: "atom",
  type: "file",
  label: "dash/verify-surfaces-brief.md",
  value: "dash/verify-surfaces-brief.md",
};

const ATOM_IMAGE: AtomSegment = {
  kind: "atom",
  type: "image",
  label: "image-1",
  value: "image-1",
  id: "atom-id-1",
};

const IMAGE_BYTES: AtomBytesEntry = {
  content: "aGVsbG8=",
  mediaType: "image/png",
};

// Sample atoms reused across the walk / format cases.
const ATOM_README: AtomSegment = {
  kind: "atom",
  type: "file",
  label: "README.md",
  value: "/repo/README.md",
};

const ATOM_SCREENSHOT: AtomSegment = {
  kind: "atom",
  type: "image",
  label: "screenshot.png",
  value: "/tmp/screenshot.png",
};

// A drop-style atom: the browser doesn't expose paths for dropped files, so
// the atom is minted with `label === value === f.name` (see
// `drop-extension.ts`). The formatter recognizes this shape and emits the bare
// label rather than a redundant link.
const ATOM_DROPPED_IMAGE: AtomSegment = {
  kind: "atom",
  type: "image",
  label: "raphael.jpeg",
  value: "raphael.jpeg",
};

describe("walkAtomText", () => {
  test("empty text + empty atoms → no segments", () => {
    expect(walkAtomText("", [])).toEqual([]);
  });

  test("plain text + no atoms → single text segment", () => {
    expect(walkAtomText("hello world", [])).toEqual([
      { kind: "text", text: "hello world" },
    ]);
  });

  test("one atom between text → text, atom, text in order", () => {
    const input = `before ${TUG_ATOM_CHAR} after`;
    expect(walkAtomText(input, [ATOM_README])).toEqual<AtomTextSegment[]>([
      { kind: "text", text: "before " },
      { kind: "atom", atom: ATOM_README },
      { kind: "text", text: " after" },
    ]);
  });

  test("two atoms with text between → atom, text, atom in order", () => {
    const input = `${TUG_ATOM_CHAR} and ${TUG_ATOM_CHAR}`;
    expect(walkAtomText(input, [ATOM_README, ATOM_SCREENSHOT])).toEqual<
      AtomTextSegment[]
    >([
      { kind: "atom", atom: ATOM_README },
      { kind: "text", text: " and " },
      { kind: "atom", atom: ATOM_SCREENSHOT },
    ]);
  });

  test("more U+FFFC than atoms → stray-ffc for the surplus", () => {
    // Two FFFC characters, only one atom supplied.
    const input = `${TUG_ATOM_CHAR} and ${TUG_ATOM_CHAR}`;
    expect(walkAtomText(input, [ATOM_README])).toEqual<AtomTextSegment[]>([
      { kind: "atom", atom: ATOM_README },
      { kind: "text", text: " and " },
      { kind: "stray-ffc" },
    ]);
  });

  test("leading U+FFFC → atom is the first segment, text follows", () => {
    const input = `${TUG_ATOM_CHAR} trailing text`;
    expect(walkAtomText(input, [ATOM_README])).toEqual<AtomTextSegment[]>([
      { kind: "atom", atom: ATOM_README },
      { kind: "text", text: " trailing text" },
    ]);
  });

  test("trailing U+FFFC → text first, atom is the last segment", () => {
    const input = `leading text ${TUG_ATOM_CHAR}`;
    expect(walkAtomText(input, [ATOM_README])).toEqual<AtomTextSegment[]>([
      { kind: "text", text: "leading text " },
      { kind: "atom", atom: ATOM_README },
    ]);
  });

  test("atom-only text (single U+FFFC) → exactly one atom segment", () => {
    expect(walkAtomText(TUG_ATOM_CHAR, [ATOM_README])).toEqual<
      AtomTextSegment[]
    >([{ kind: "atom", atom: ATOM_README }]);
  });

  test("text only, no FFFC but atoms supplied → atoms are ignored", () => {
    // The walker reads `U+FFFC` to find atom positions; an extra
    // atoms entry without a corresponding FFFC is silently dropped.
    // Mirror of the "stray-ffc" defensive branch (extra characters
    // pass through), but in the opposite direction.
    expect(walkAtomText("just plain text", [ATOM_README])).toEqual<
      AtomTextSegment[]
    >([{ kind: "text", text: "just plain text" }]);
  });
});

describe("formatAtomTextForCopy", () => {
  test("plain text without atoms passes through verbatim", () => {
    expect(formatAtomTextForCopy("hello world", [])).toBe("hello world");
  });

  test("one path-bearing atom (value ≠ label) → angle-bracket markdown link", () => {
    expect(
      formatAtomTextForCopy(`before ${TUG_ATOM_CHAR} after`, [ATOM_README]),
    ).toBe("before [README.md](</repo/README.md>) after");
  });

  test("two path-bearing atoms → two markdown links, order preserved", () => {
    expect(
      formatAtomTextForCopy(`${TUG_ATOM_CHAR} and ${TUG_ATOM_CHAR}`, [
        ATOM_README,
        ATOM_SCREENSHOT,
      ]),
    ).toBe("[README.md](</repo/README.md>) and [screenshot.png](</tmp/screenshot.png>)");
  });

  test("dropped-file atom (value === label) → bare label, no markdown link", () => {
    // Browser-dropped files have no path; emitting `[name](name)`
    // would be a redundant pair carrying no info beyond the label.
    expect(
      formatAtomTextForCopy(`describe ${TUG_ATOM_CHAR}`, [ATOM_DROPPED_IMAGE]),
    ).toBe("describe raphael.jpeg");
  });

  test("mixed: dropped-file atom + path-bearing atom", () => {
    expect(
      formatAtomTextForCopy(
        `${TUG_ATOM_CHAR} versus ${TUG_ATOM_CHAR}`,
        [ATOM_DROPPED_IMAGE, ATOM_README],
      ),
    ).toBe("raphael.jpeg versus [README.md](</repo/README.md>)");
  });

  test("command atom keeps the leading slash it is drawn with", () => {
    // A command atom stores the BARE name; the slash is added for display
    // (`chipDisplayLabel`) and for the wire (`commandWireText`). A copy that
    // wrote the stored label handed back `tugplug:dash` — text that no longer
    // invokes the command when pasted back into a prompt.
    expect(
      formatAtomTextForCopy(`${TUG_ATOM_CHAR} on ${TUG_ATOM_CHAR}`, [
        ATOM_COMMAND,
        ATOM_README,
      ]),
    ).toBe("/tugplug:dash on [README.md](</repo/README.md>)");
  });

  test("stray U+FFFC (atom missing) passes through verbatim", () => {
    // One FFFC supplied an atom; the second has no atom — render
    // the character itself so the bug is visible rather than silent.
    expect(
      formatAtomTextForCopy(`${TUG_ATOM_CHAR} and ${TUG_ATOM_CHAR}`, [
        ATOM_README,
      ]),
    ).toBe(`[README.md](</repo/README.md>) and ${TUG_ATOM_CHAR}`);
  });

  test("atom at the start → link is the first character", () => {
    expect(
      formatAtomTextForCopy(`${TUG_ATOM_CHAR} trailing text`, [ATOM_README]),
    ).toBe("[README.md](</repo/README.md>) trailing text");
  });

  test("atom at the end → link is the last character", () => {
    expect(
      formatAtomTextForCopy(`leading text ${TUG_ATOM_CHAR}`, [ATOM_README]),
    ).toBe("leading text [README.md](</repo/README.md>)");
  });

  test("empty text → empty string", () => {
    expect(formatAtomTextForCopy("", [])).toBe("");
  });
});

describe("atomTextClipboardPayload", () => {
  test("no atoms → no sidecar", () => {
    expect(atomTextClipboardPayload("just prose", [])).toBeNull();
  });

  test("positions each atom at its U+FFFC, in document order", () => {
    const text = `${TUG_ATOM_CHAR} on ${TUG_ATOM_CHAR}`;
    const payload = atomTextClipboardPayload(text, [ATOM_COMMAND, ATOM_FILE]);
    expect(payload).not.toBeNull();
    expect(payload?.text).toBe(text);
    expect(payload?.atoms).toEqual([
      { position: 0, segment: ATOM_COMMAND },
      { position: text.indexOf(TUG_ATOM_CHAR, 1), segment: ATOM_FILE },
    ]);
  });

  test("round-trips through the paste side's reader", () => {
    const text = `${TUG_ATOM_CHAR} on ${TUG_ATOM_CHAR}`;
    const payload = atomTextClipboardPayload(text, [ATOM_COMMAND, ATOM_FILE]);
    const parsed = parseClipboardSidecar(JSON.stringify(payload));
    expect(parsed).toEqual(payload);
  });

  test("image atom carries its bytes, so the chip pastes as a picture", () => {
    const payload = atomTextClipboardPayload(
      TUG_ATOM_CHAR,
      [ATOM_IMAGE],
      (id) => (id === "atom-id-1" ? IMAGE_BYTES : null),
    );
    expect(payload?.atoms[0]?.bytes).toEqual(IMAGE_BYTES);
  });

  test("evicted bytes leave the atom as metadata, not a broken entry", () => {
    const payload = atomTextClipboardPayload(TUG_ATOM_CHAR, [ATOM_IMAGE], () => null);
    expect(payload?.atoms[0]).toEqual({ position: 0, segment: ATOM_IMAGE });
  });

  test("stray U+FFFC claims no atom", () => {
    // Two placeholders, one atom — the surplus character stays in the text and
    // the sidecar says nothing about what stood there ([Spec S03]).
    const text = `${TUG_ATOM_CHAR}${TUG_ATOM_CHAR}`;
    const payload = atomTextClipboardPayload(text, [ATOM_FILE]);
    expect(payload?.text).toBe(text);
    expect(payload?.atoms).toEqual([{ position: 0, segment: ATOM_FILE }]);
  });
});
