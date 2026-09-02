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

/** Private MIME type marking a drag whose payload is jot text. */
export const JOT_MIME = "application/x-tug-jot";

/**
 * Start a jot drag from a row. Call from the incipit's `onDragStart` (the
 * element must carry `draggable`). `copy` is the only allowed effect — a
 * jot is never moved out of the Jots card.
 */
export function jotDragStart(
  event: React.DragEvent,
  text: string,
): void {
  const dt = event.dataTransfer;
  dt.effectAllowed = "copy";
  dt.setData(JOT_MIME, text);
  dt.setData("text/plain", text);
}

/** True when `dataTransfer` carries a jot payload. */
export function hasJotDrag(dt: DataTransfer | null): boolean {
  return dt !== null && dt.types.includes(JOT_MIME);
}

/**
 * Read the jot text off a drop's `dataTransfer`, or `null` when the drag
 * isn't a jot drag. Empty payloads read as `null` too — an empty insert is
 * indistinguishable from no drop.
 */
export function readJotDrag(dt: DataTransfer | null): string | null {
  if (!hasJotDrag(dt)) return null;
  const text = dt!.getData(JOT_MIME);
  return text.length > 0 ? text : null;
}
