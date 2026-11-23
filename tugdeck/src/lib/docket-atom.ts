/**
 * docket-atom.ts — the docket reference as a real Tug atom.
 *
 * The same three flavours a sketch atom writes, for a docket:
 *
 * | Flavor                    | Payload                                    |
 * |---------------------------|--------------------------------------------|
 * | `text/plain`              | `docket:<id>`                              |
 * | `dev.tugapp.prompt-atoms` | a one-atom sidecar with a `docket` segment |
 * | wire marker (at submit)   | `` `@docket:<id>` ``                       |
 *
 * The id is unique on the machine, so the value is the id alone; the chip is
 * labelled by the docket's name, and the checkout's directory rides in the
 * segment so a reader can tell this project's docket from another's.
 *
 * @module lib/docket-atom
 */

import type { TugAtomsClipboardPayload } from "@/components/tugways/tug-text-editor/clipboard-filters";
import { writeClipboardViaNative } from "@/lib/tug-native-clipboard";
import type { AtomSegment } from "@/lib/tug-atom-img";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-char";
import { docketCitationStore } from "@/lib/docket-citation-store";
import {
  DOCKET_ATOM_TYPE,
  docketAtomLabel,
  docketPlainText,
  isDocketAtomType,
} from "@/lib/record-atom-shape";

export { DOCKET_ATOM_TYPE, isDocketAtomType, docketAtomLabel } from "@/lib/record-atom-shape";

/** The atom segment for a docket: the id as the value, the name as the label. */
export function docketAtomSegment(docket: {
  id: string;
  name?: string;
  projectDir: string;
}): AtomSegment {
  return {
    kind: "atom",
    type: DOCKET_ATOM_TYPE,
    label: docketAtomLabel(docket.id, docket.name),
    value: docket.id,
    ...(docket.projectDir !== "" ? { docket: { projectDir: docket.projectDir } } : {}),
  };
}

/** The one-atom sidecar a paste into any Tug editor re-materializes. */
export function docketAtomClipboardPayload(segment: AtomSegment): TugAtomsClipboardPayload {
  return {
    version: 1,
    text: TUG_ATOM_CHAR,
    atoms: [{ position: 0, segment }],
  };
}

/**
 * Copy a docket atom: `docket:<id>` as plain text, the atom sidecar beside it.
 * Returns `false` when the native bridge is unavailable.
 */
export function copyDocketAtom(segment: AtomSegment): boolean {
  return writeClipboardViaNative(
    docketPlainText(segment.value),
    JSON.stringify(docketAtomClipboardPayload(segment)),
  );
}

/**
 * Ask the docket store about a docket chip's id. The asking directory is the
 * one the atom recorded; a chip with none has nothing to ask under.
 */
export function requestDocketChipVerdict(atom: AtomSegment): void {
  if (!isDocketAtomType(atom.type) || atom.docket === undefined) return;
  docketCitationStore.request(atom.docket.projectDir, atom.value);
}

/** Whether a docket chip bakes in the `missing` face; only `missing` is. */
export function docketChipVerdict(atom: AtomSegment): "default" | "missing" {
  if (!isDocketAtomType(atom.type) || atom.docket === undefined) return "default";
  return docketCitationStore.getAnswer(atom.value).status === "missing"
    ? "missing"
    : "default";
}
