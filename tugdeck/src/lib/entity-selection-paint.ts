/**
 * The selected face of an entity whose mark is a box.
 *
 * A right-click on an annotation selects the whole entity
 * (`useTextSurfaceContextMenu`), and for a run of ink that is the end of it:
 * the browser paints its own highlight over the characters, which is exactly
 * the thing the selection is about. A **pill** is different. A commit atom, a
 * session citation and an arc sigil are flex boxes — a node, a gap, a label —
 * and a text highlight reaches only the runs inside them. Select one and the
 * label lights up while the node, the padding and the border stay at rest, so
 * a mark the menu is about to treat as one thing reads as a fragment of
 * itself sitting inside an unselected box.
 *
 * Nothing in CSS can answer that on its own: "is selected" is not a state a
 * selector can see. So the settle marks the element it selected with
 * `data-tug-entity-selected` and `styles/tug-annotation.css` paints the boxes
 * that need painting. The attribute says only *this entity is the selection*
 * — which shapes act on it is the sheet's business, and a plain run of ink
 * carries the attribute and takes no rule at all.
 *
 * **One mark at a time, cleared by the selection itself.** A second paint
 * clears the first, and a single `selectionchange` listener — installed on
 * the first paint and kept — clears the mark as soon as the selection no
 * longer covers the element. That is the honest end of it: the paint is a
 * second face for a selection the DOM is already holding, so the DOM's own
 * event is what retires it. No surface has to remember to clean up, and a
 * marked element that gets re-rendered out from under us takes its attribute
 * with it.
 *
 * Laws: [L06] — the selected face is an attribute and a stylesheet, never
 * React state; nothing here re-renders anything.
 *
 * @module lib/entity-selection-paint
 */

/** The attribute `styles/tug-annotation.css` paints a selected box from. */
export const ENTITY_SELECTED_ATTRIBUTE = "data-tug-entity-selected";

/** The one element currently wearing the mark, or `null` when none is. */
let painted: HTMLElement | null = null;

/** Whether the `selectionchange` listener is installed. Installed once. */
let listening = false;

/**
 * Whether the live selection covers `element`. The settle asks this after
 * selecting an entity, because a programmatic selection can land as nothing
 * in `user-select: none` chrome, and a mark with no selection under it would
 * be a paint of a state the DOM is not holding.
 */
export function selectionCovers(element: HTMLElement): boolean {
  const sel = window.getSelection();
  if (sel === null || sel.isCollapsed || sel.rangeCount === 0) return false;
  for (let i = 0; i < sel.rangeCount; i += 1) {
    if (sel.getRangeAt(i).intersectsNode(element)) return true;
  }
  return false;
}

function handleSelectionChange(): void {
  const element = painted;
  if (element === null) return;
  if (!element.isConnected || !selectionCovers(element)) clearEntitySelected();
}

/**
 * Mark `element` as the entity the selection stands on, so a box-shaped mark
 * can paint its whole self selected. Replaces any previous mark.
 */
export function paintEntitySelected(element: HTMLElement): void {
  if (painted === element) return;
  clearEntitySelected();
  element.setAttribute(ENTITY_SELECTED_ATTRIBUTE, "");
  painted = element;
  if (!listening) {
    document.addEventListener("selectionchange", handleSelectionChange);
    listening = true;
  }
}

/** Retire the mark. Safe when there is none. */
export function clearEntitySelected(): void {
  if (painted === null) return;
  painted.removeAttribute(ENTITY_SELECTED_ATTRIBUTE);
  painted = null;
}
