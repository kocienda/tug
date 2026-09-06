/**
 * jot-drag — what a jot carries when it is dragged out of the Jots card.
 *
 * Two flavors, deliberately different, and the difference is the whole point
 * ([B05]): the private type carries the `(text, atoms)` substrate as JSON so a
 * Tug editor rebuilds the chips, and `text/plain` carries the [B03] plain form
 * for every surface that has no idea what an atom is. The flatten happens once,
 * at that boundary, and nowhere before it.
 *
 * `DataTransfer` is a data bag, so this stands one in — a `Map` behind
 * `setData` / `getData` / `types`. There is no DOM here and none is needed:
 * `jotDragStart` and `readJotDrag` are an encode/decode pair over strings, and
 * this file is the proof they agree.
 */

import { describe, expect, test } from "bun:test";

import { JOT_MIME, jotDragStart, readJotDrag } from "../jot-drag";
import { TUG_ATOM_CHAR, type AtomSegment } from "../tug-atom-img";

/** A `DataTransfer` stand-in: the flavors it was handed, and nothing else. */
function bag(): DataTransfer {
  const data = new Map<string, string>();
  return {
    effectAllowed: "none",
    get types(): readonly string[] {
      return [...data.keys()];
    },
    setData(type: string, value: string): void {
      data.set(type, value);
    },
    getData(type: string): string {
      return data.get(type) ?? "";
    },
  } as unknown as DataTransfer;
}

function dragEvent(dt: DataTransfer): React.DragEvent {
  return { dataTransfer: dt } as unknown as React.DragEvent;
}

const FILE_ATOM: AtomSegment = {
  kind: "atom",
  type: "file",
  label: "atom-text.ts",
  value: "tugdeck/src/lib/atom-text.ts",
};

const IMAGE_ATOM: AtomSegment = {
  kind: "atom",
  type: "image",
  label: "shot.png",
  value: "shot.png",
  id: "1f8c2e04-7b3a-4d51-9c60-2a8e5f7b1d33",
};

describe("a jot drag carries its chips", () => {
  test("the substrate round-trips through the private type", () => {
    const dt = bag();
    const text = `see ${TUG_ATOM_CHAR} and ${TUG_ATOM_CHAR}`;
    jotDragStart(dragEvent(dt), text, [FILE_ATOM, IMAGE_ATOM]);
    expect(readJotDrag(dt)).toEqual({
      text,
      atoms: [FILE_ATOM, IMAGE_ATOM],
    });
  });

  test("text/plain is the plain form, not the placeholders", () => {
    // The one flatten. A jot dropped into a foreign text field reads as prose;
    // dropped into a Tug editor it reads as chips, off the flavor above.
    const dt = bag();
    jotDragStart(dragEvent(dt), `see ${TUG_ATOM_CHAR}`, [FILE_ATOM]);
    const plain = dt.getData("text/plain");
    expect(plain).toBe("see [atom-text.ts](<tugdeck/src/lib/atom-text.ts>)");
    expect(plain).not.toContain(TUG_ATOM_CHAR);
  });

  test("a jot of plain prose carries no atoms and reads as itself", () => {
    const dt = bag();
    jotDragStart(dragEvent(dt), "a passage with no chips in it");
    expect(readJotDrag(dt)).toEqual({
      text: "a passage with no chips in it",
      atoms: [],
    });
    expect(dt.getData("text/plain")).toBe("a passage with no chips in it");
  });

  test("an image chip keeps its bytes-store id across the drag", () => {
    const dt = bag();
    jotDragStart(dragEvent(dt), TUG_ATOM_CHAR, [IMAGE_ATOM]);
    expect(readJotDrag(dt)!.atoms[0]!.id).toBe(IMAGE_ATOM.id);
  });

  test("a non-jot drag reads as nothing", () => {
    const dt = bag();
    dt.setData("text/plain", "some other drag");
    expect(readJotDrag(dt)).toBeNull();
    expect(readJotDrag(null)).toBeNull();
  });

  test("an empty payload reads as nothing — an empty insert is no drop", () => {
    const dt = bag();
    dt.setData(JOT_MIME, "");
    expect(readJotDrag(dt)).toBeNull();
    const empty = bag();
    empty.setData(JOT_MIME, JSON.stringify({ text: "", atoms: [] }));
    expect(readJotDrag(empty)).toBeNull();
  });

  test("a payload that is not the JSON shape drops as bare text", () => {
    // Legible beats nothing: a malformed or foreign write of the private type
    // still puts the string somewhere rather than swallowing the gesture.
    const dt = bag();
    dt.setData(JOT_MIME, "just a string");
    expect(readJotDrag(dt)).toEqual({ text: "just a string", atoms: [] });
  });

  test("a malformed atom entry is skipped, the rest survive", () => {
    const dt = bag();
    dt.setData(
      JOT_MIME,
      JSON.stringify({
        text: TUG_ATOM_CHAR,
        atoms: [{ type: "", label: "a", value: "a" }, { type: "file" }, FILE_ATOM],
      }),
    );
    expect(readJotDrag(dt)!.atoms).toEqual([FILE_ATOM]);
  });
});
