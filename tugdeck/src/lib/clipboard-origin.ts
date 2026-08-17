/**
 * clipboard-origin — which project was this text read against?
 *
 * Prose cites files the way people talk about them: `tugdeck/src/x.css:12`,
 * relative to a root the sentence never names because everyone reading it in
 * place already knows which one. Copy that sentence somewhere else and the
 * citation stops resolving — nothing was lost, the root was simply never
 * written down. So a Tug copy writes it down, in the clipboard sidecar's
 * `origins`, and a destination that keeps the text keeps the root with it.
 *
 * **Why a DOM attribute and not a prop.** A copy can leave a card by many
 * doors: ⌘C through the surface's own `copy` handler, a block's Copy button,
 * a context-menu item, Edit ▸ Copy as Plain Text reading the live selection
 * from a menu with no React context in sight. Threading an origin prop to
 * every one of them means every intermediate component forwarding something it
 * does not care about — the same plumbing failure the annotator's own
 * {@link AnnotationScope} exists to avoid, and the reason tool headers went
 * unannotated for so long. An attribute on the surface is visible to all of
 * them from the node they already have: the copy's target, the button's
 * element, the selection's anchor. {@link clipboardOriginFor} walks up.
 *
 * **Nesting is the point, not a hazard.** `closest()` finds the NEAREST
 * stamp, so a surface inside a surface wins for its own subtree — a Overview
 * post narrating a different project than the card around it stamps itself and
 * is correct without anyone coordinating.
 *
 * A surface with no project stamps nothing, and a copy from it carries no
 * provenance. That leaves the destination exactly as well off as it was before
 * any of this existed, which is the right failure.
 *
 * @module lib/clipboard-origin
 */

/**
 * The attribute a surface stamps with the absolute project root its text is
 * written against. Empty or relative values are ignored by the reader, so a
 * card that has not learned its project yet can stamp unconditionally.
 */
export const CLIPBOARD_ORIGIN_ATTRIBUTE = "data-tug-clipboard-origin";

/** The selector form, for `closest()`. */
const ORIGIN_SELECTOR = `[${CLIPBOARD_ORIGIN_ATTRIBUTE}]`;

/**
 * The project root in scope at `node`, or `null` when nothing above it claims
 * one. Accepts any node a copy path has to hand — an event target, a button,
 * a selection anchor (which is usually a text node, hence the parent walk).
 */
export function clipboardOriginFor(node: Node | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  const element =
    node instanceof Element ? node : (node.parentElement ?? null);
  if (element === null) return null;
  const host = element.closest(ORIGIN_SELECTOR);
  if (host === null) return null;
  const root = host.getAttribute(CLIPBOARD_ORIGIN_ATTRIBUTE) ?? "";
  // Absolute only: a relative root would have to be resolved against the
  // destination's own project, which is the assumption this whole mechanism
  // exists to stop making.
  return root.startsWith("/") ? root : null;
}

/**
 * The project root the current document selection sits in. For the copy paths
 * that never see an element — Edit ▸ Copy as Plain Text runs from a menu and
 * reads `window.getSelection()` directly.
 *
 * Read from the selection's ANCHOR, the end the user started from, so a
 * selection dragged out of a card and into whatever is beside it still reports
 * the surface it began in.
 */
export function clipboardOriginForSelection(): string | null {
  const selection =
    typeof window === "undefined" ? null : window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  return clipboardOriginFor(selection.anchorNode);
}

/**
 * Write the stamp onto `element` directly, for a surface whose root is not
 * React state — the text card resolves its document's base asynchronously into
 * a ref, and a root that arrives after the render that would have carried it
 * is the ordinary case there, not an edge. A `null` root removes the stamp, so
 * a card rebound to a draft with no base stops claiming the old one ([L06]:
 * this writes DOM, never React state).
 */
export function stampClipboardOrigin(
  element: HTMLElement | null,
  root: string | null | undefined,
): void {
  if (element === null) return;
  if (root !== null && root !== undefined && root.startsWith("/")) {
    element.setAttribute(CLIPBOARD_ORIGIN_ATTRIBUTE, root);
    return;
  }
  element.removeAttribute(CLIPBOARD_ORIGIN_ATTRIBUTE);
}

/**
 * Spread onto a surface that knows its project:
 * `<div {...clipboardOriginProps(projectDir)}>`. A `null` root spreads to
 * nothing, so a card whose binding has not landed carries no stale stamp.
 */
export function clipboardOriginProps(
  root: string | null | undefined,
): Record<string, string> {
  return root !== null && root !== undefined && root.startsWith("/")
    ? { [CLIPBOARD_ORIGIN_ATTRIBUTE]: root }
    : {};
}
