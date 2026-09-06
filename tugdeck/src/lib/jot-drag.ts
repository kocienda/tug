/**
 * Native HTML5 drag of a Jots card jot into the Session card's prompt entry
 * ([P04]/[P05]).
 *
 * The drag is the platform's own: the row's incipit is `draggable`, the payload
 * rides on the `DataTransfer` under a private MIME type (plus `text/plain` so a
 * jot also drops into any other text surface), and the drag image is the
 * OS-rendered snapshot of the dragged element. Escape mid-drag is therefore
 * handled by AppKit — it cancels the session and animates the drag image back
 * to the row it came from — and the drop target paints the same accept ring and
 * drop caret an image drag paints, because the prompt entry accepts both drags
 * through one set of `dragover` / `drop` handlers.
 */

import type { AtomSegment } from "./tug-atom-img";
import { formatAtomTextForCopy } from "./atom-text";

/** Private MIME type marking a drag whose payload is jot text. */
export const JOT_MIME = "application/x-tug-jot";

/**
 * What a jot drag carries: the `(text, atoms)` substrate, so a chip dragged
 * out of a jot arrives in the prompt as the chip it is rather than as the
 * placeholder character it stands at.
 */
export interface JotDragPayload {
  text: string;
  atoms: AtomSegment[];
}

/**
 * Start a jot drag from a row. Call from the incipit's `onDragStart` (the
 * element must carry `draggable`). `copy` is the only allowed effect — a
 * jot is never moved out of the Jots card.
 *
 * Two flavors, and they are deliberately different: the private type carries
 * the substrate as JSON for a Tug editor to rebuild, and `text/plain` carries
 * the [B03] plain form for everything else — the one moment the atoms are
 * flattened is the moment the payload leaves for a surface that has no idea
 * what an atom is.
 */
export function jotDragStart(
  event: React.DragEvent,
  text: string,
  atoms: ReadonlyArray<AtomSegment> = [],
): void {
  const dt = event.dataTransfer;
  dt.effectAllowed = "copy";
  dt.setData(JOT_MIME, JSON.stringify({ text, atoms }));
  dt.setData("text/plain", formatAtomTextForCopy(text, atoms));
}

/** True when `dataTransfer` carries a jot payload. */
export function hasJotDrag(dt: DataTransfer | null): boolean {
  return dt !== null && dt.types.includes(JOT_MIME);
}

/**
 * Read the jot substrate off a drop's `dataTransfer`, or `null` when the drag
 * isn't a jot drag. An empty payload reads as `null` too — an empty insert is
 * indistinguishable from no drop.
 *
 * A payload that is not the JSON shape is taken as bare text, so a malformed
 * or foreign write of the private type still drops something legible rather
 * than nothing at all.
 */
export function readJotDrag(dt: DataTransfer | null): JotDragPayload | null {
  if (!hasJotDrag(dt)) return null;
  const raw = dt!.getData(JOT_MIME);
  if (raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw, atoms: [] };
  }
  if (typeof parsed !== "object" || parsed === null) return { text: raw, atoms: [] };
  const p = parsed as Record<string, unknown>;
  if (typeof p.text !== "string") return { text: raw, atoms: [] };
  if (p.text.length === 0) return null;
  const atoms: AtomSegment[] = [];
  if (Array.isArray(p.atoms)) {
    for (const entry of p.atoms as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const a = entry as Record<string, unknown>;
      if (typeof a.type !== "string" || a.type === "") continue;
      if (typeof a.label !== "string" || typeof a.value !== "string") continue;
      atoms.push({
        kind: "atom",
        type: a.type,
        label: a.label,
        value: a.value,
        ...(typeof a.id === "string" && a.id !== "" ? { id: a.id } : {}),
      });
    }
  }
  return { text: p.text, atoms };
}
