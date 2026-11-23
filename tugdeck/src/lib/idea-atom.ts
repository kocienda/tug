/**
 * idea-atom.ts — the idea reference as a real Tug atom.
 *
 * The same three flavours a docket atom writes, for an idea:
 *
 * | Flavor                    | Payload                                   |
 * |---------------------------|-------------------------------------------|
 * | `text/plain`              | `idea:<id>`                               |
 * | `dev.tugapp.prompt-atoms` | a one-atom sidecar with an `idea` segment |
 * | wire marker (at submit)   | `` `@idea:<id>` ``                        |
 *
 * The id is unique on the machine, so the value is the id alone; the chip is
 * labelled by the idea's line, cut to fit, and the checkout's directory rides
 * in the segment so a reader can tell this project's idea from another's.
 *
 * @module lib/idea-atom
 */

import type { TugAtomsClipboardPayload } from "@/components/tugways/tug-text-editor/clipboard-filters";
import { writeClipboardViaNative } from "@/lib/tug-native-clipboard";
import type { AtomSegment } from "@/lib/tug-atom-img";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-char";
import { ideaCitationStore } from "@/lib/idea-citation-store";
import {
  IDEA_ATOM_TYPE,
  ideaAtomLabel,
  ideaPlainText,
  isIdeaAtomType,
} from "@/lib/record-atom-shape";

export { IDEA_ATOM_TYPE, isIdeaAtomType, ideaAtomLabel } from "@/lib/record-atom-shape";

/** The atom segment for an idea: the id as the value, the line as the label. */
export function ideaAtomSegment(idea: {
  id: string;
  text?: string;
  projectDir: string;
}): AtomSegment {
  return {
    kind: "atom",
    type: IDEA_ATOM_TYPE,
    label: ideaAtomLabel(idea.id, idea.text),
    value: idea.id,
    ...(idea.projectDir !== "" ? { idea: { projectDir: idea.projectDir } } : {}),
  };
}

/** The one-atom sidecar a paste into any Tug editor re-materializes. */
export function ideaAtomClipboardPayload(segment: AtomSegment): TugAtomsClipboardPayload {
  return {
    version: 1,
    text: TUG_ATOM_CHAR,
    atoms: [{ position: 0, segment }],
  };
}

/**
 * Copy an idea atom: `idea:<id>` as plain text, the atom sidecar beside it.
 * Returns `false` when the native bridge is unavailable.
 */
export function copyIdeaAtom(segment: AtomSegment): boolean {
  return writeClipboardViaNative(
    ideaPlainText(segment.value),
    JSON.stringify(ideaAtomClipboardPayload(segment)),
  );
}

/**
 * Ask the idea store about an idea chip's id. The asking directory is the one
 * the atom recorded; a chip with none has nothing to ask under.
 */
export function requestIdeaChipVerdict(atom: AtomSegment): void {
  if (!isIdeaAtomType(atom.type) || atom.idea === undefined) return;
  ideaCitationStore.request(atom.idea.projectDir, atom.value);
}

/** Whether an idea chip bakes in the `missing` face; only `missing` is. */
export function ideaChipVerdict(atom: AtomSegment): "default" | "missing" {
  if (!isIdeaAtomType(atom.type) || atom.idea === undefined) return "default";
  return ideaCitationStore.getAnswer(atom.value).status === "missing"
    ? "missing"
    : "default";
}
