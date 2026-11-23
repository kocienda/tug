/**
 * arc-atom.ts — the arc reference as a real Tug atom.
 *
 * An arc atom joins the system the way a session atom does: copying it writes
 * the same clipboard flavours through the same `writeClipboardViaNative`
 * bridge, a paste re-materializes the chip through the same sidecar parser,
 * and a submit carries it on the wire as a typed `` `@arc:` `` marker.
 *
 * | Flavor                    | Payload                                          |
 * |---------------------------|--------------------------------------------------|
 * | `text/plain`              | `arc:<name>`, the spelling the prose scanner reads |
 * | `dev.tugapp.prompt-atoms` | a one-atom sidecar with an `arc` segment          |
 * | wire marker (at submit)   | `` `@arc:<project>/<name>` ``                    |
 *
 * The segment carries the checkout's directory beside its `<project>/<name>`
 * value, because an arc name is unique only within one checkout's log, and the
 * generation's start when the atom pins one.
 *
 * @module lib/arc-atom
 */

import type { TugAtomsClipboardPayload } from "@/components/tugways/tug-text-editor/clipboard-filters";
import { writeClipboardViaNative } from "@/lib/tug-native-clipboard";
import type { AtomSegment } from "@/lib/tug-atom-img";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-char";
import { arcCitationStore } from "@/lib/arc-citation-store";
import {
  ARC_ATOM_TYPE,
  arcAtomName,
  isArcAtomType,
} from "@/lib/record-atom-shape";

export {
  ARC_ATOM_TYPE,
  arcAtomName,
  arcAtomProject,
  isArcAtomType,
} from "@/lib/record-atom-shape";

/**
 * The atom segment for an arc: `<projectLeaf>/<name>` as the value, the bare
 * name as the label. `arc` rides beside them when the directory is known.
 */
export function arcAtomSegment(arc: {
  projectLeaf: string;
  projectDir: string;
  name: string;
  created?: string;
}): AtomSegment {
  return {
    kind: "atom",
    type: ARC_ATOM_TYPE,
    label: arc.name,
    value: arc.projectLeaf === "" ? arc.name : `${arc.projectLeaf}/${arc.name}`,
    ...(arc.projectDir !== ""
      ? {
          arc: {
            projectDir: arc.projectDir,
            ...(arc.created !== undefined && arc.created !== ""
              ? { created: arc.created }
              : {}),
          },
        }
      : {}),
  };
}

/** The `text/plain` flavour beside an arc atom: `arc:<name>`. */
export function arcAtomPlainText(segment: AtomSegment): string {
  return `arc:${arcAtomName(segment.value)}`;
}

/** The one-atom sidecar a paste into any Tug editor re-materializes. */
export function arcAtomClipboardPayload(segment: AtomSegment): TugAtomsClipboardPayload {
  return {
    version: 1,
    text: TUG_ATOM_CHAR,
    atoms: [{ position: 0, segment }],
  };
}

/**
 * Copy an arc atom: `arc:<name>` as plain text, the atom sidecar beside it.
 * Returns `false` when the native bridge is unavailable.
 */
export function copyArcAtom(segment: AtomSegment): boolean {
  return writeClipboardViaNative(
    arcAtomPlainText(segment),
    JSON.stringify(arcAtomClipboardPayload(segment)),
  );
}

/**
 * Ask the arc store about an arc chip's arc, under its own checkout. A chip
 * with no directory has nothing to ask under, so it asks nothing.
 */
export function requestArcChipVerdict(atom: AtomSegment): void {
  if (!isArcAtomType(atom.type) || atom.arc === undefined) return;
  arcCitationStore.request(atom.arc.projectDir, arcAtomName(atom.value));
}

/**
 * Whether an arc chip bakes in the `missing` face. Reads the cached answer
 * only, and only `missing` is missing: `pending` would flash every chip dashed
 * for a round trip, as `session-chip-verdict.ts` says of sessions.
 */
export function arcChipVerdict(atom: AtomSegment): "default" | "missing" {
  if (!isArcAtomType(atom.type) || atom.arc === undefined) return "default";
  const answer = arcCitationStore.getAnswer(atom.arc.projectDir, arcAtomName(atom.value));
  return answer.status === "missing" ? "missing" : "default";
}
