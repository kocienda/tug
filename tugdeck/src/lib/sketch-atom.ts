/**
 * sketch-atom.ts — the sketch reference as a real Tug atom.
 *
 * The same three flavours an arc atom writes, for a sketch:
 *
 * | Flavor                    | Payload                                  |
 * |---------------------------|------------------------------------------|
 * | `text/plain`              | `sketch:<id>`                            |
 * | `dev.tugapp.prompt-atoms` | a one-atom sidecar with a `sketch` segment |
 * | wire marker (at submit)   | `` `@sketch:<id>` ``                     |
 *
 * The id is unique on the machine, so the value is the id alone; the
 * checkout's directory rides in the segment so a reader can tell this
 * project's sketch from another's.
 *
 * @module lib/sketch-atom
 */

import type { TugAtomsClipboardPayload } from "@/components/tugways/tug-text-editor/clipboard-filters";
import { writeClipboardViaNative } from "@/lib/tug-native-clipboard";
import type { AtomSegment } from "@/lib/tug-atom-img";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-char";
import { sketchCitationStore } from "@/lib/sketch-citation-store";
import {
  SKETCH_ATOM_TYPE,
  isSketchAtomType,
  sketchAtomLabel,
} from "@/lib/record-atom-shape";

export { SKETCH_ATOM_TYPE, isSketchAtomType, sketchAtomLabel } from "@/lib/record-atom-shape";

/** The atom segment for a sketch: the id as the value, `sketch:<id>` as the label. */
export function sketchAtomSegment(sketch: { id: string; projectDir: string }): AtomSegment {
  return {
    kind: "atom",
    type: SKETCH_ATOM_TYPE,
    label: sketchAtomLabel(sketch.id),
    value: sketch.id,
    ...(sketch.projectDir !== "" ? { sketch: { projectDir: sketch.projectDir } } : {}),
  };
}

/** The one-atom sidecar a paste into any Tug editor re-materializes. */
export function sketchAtomClipboardPayload(segment: AtomSegment): TugAtomsClipboardPayload {
  return {
    version: 1,
    text: TUG_ATOM_CHAR,
    atoms: [{ position: 0, segment }],
  };
}

/**
 * Copy a sketch atom: `sketch:<id>` as plain text, the atom sidecar beside it.
 * Returns `false` when the native bridge is unavailable.
 */
export function copySketchAtom(segment: AtomSegment): boolean {
  return writeClipboardViaNative(
    sketchAtomLabel(segment.value),
    JSON.stringify(sketchAtomClipboardPayload(segment)),
  );
}

/**
 * Ask the sketch store about a sketch chip's id. The asking directory is the
 * one the atom recorded; a chip with none has nothing to ask under.
 */
export function requestSketchChipVerdict(atom: AtomSegment): void {
  if (!isSketchAtomType(atom.type) || atom.sketch === undefined) return;
  sketchCitationStore.request(atom.sketch.projectDir, atom.value);
}

/** Whether a sketch chip bakes in the `missing` face; only `missing` is. */
export function sketchChipVerdict(atom: AtomSegment): "default" | "missing" {
  if (!isSketchAtomType(atom.type) || atom.sketch === undefined) return "default";
  return sketchCitationStore.getAnswer(atom.value).status === "missing"
    ? "missing"
    : "default";
}
