/**
 * Wrapping a run of text in place — how an entity found *inside* a longer
 * string becomes its own element.
 *
 * Whole-element annotation is the easy case: an inline `<code>` span that
 * is entirely one path gets the marks stamped on the span it already has.
 * But the shapes that matter most in real ink are not their own element —
 * a filename in the middle of a sentence, a path buried in a command line
 * — and marking those means splitting the text node they live in and
 * giving the run an element of its own.
 *
 * Wrappers are marked `data-tugx-wrapped` so a later pass can tell the
 * elements this pass created from the ones the renderer did. That
 * matters because a verdict can change: a wrapper whose entity no longer
 * resolves is unwrapped and its text folded back into its neighbours, so
 * the DOM stays a function of what is currently known rather than an
 * accumulation of everything ever believed.
 *
 * @module lib/annotator/wrap-matches
 */

import { stampAnnotation } from "./annotation-element";
import type { AnnotationPayload } from "./payloads";
import { ANNOTATION_CLASS } from "./types";

/** Marks an element this pass created, rather than the renderer. */
export const WRAPPED_ATTRIBUTE = "data-tugx-wrapped";

/** The namespace prose lives in. Everything else is a drawing. */
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** A run of a text node that should become its own element. */
export interface TextRunMatch {
  /** Index of the run's first character in the text node's data. */
  start: number;
  /** Index one past the run's last character. */
  end: number;
  /** What the run is. */
  payload: AnnotationPayload;
  /**
   * A HOLD on the run rather than a mark of it: the wrapper consumes the
   * range and emits no element, leaving the text exactly as it was.
   *
   * This exists because two scans can want the same characters while the
   * answer that decides between them is asynchronous. `tugtool/kind-floor` is
   * shaped like a relative path and like a session callsign at once; the
   * session verdict arrives a batch later, and whichever scan claims the run
   * first blocks the other permanently (overlaps are dropped, and
   * `dropStaleWraps` would never revisit a still-valid path wrap). Deciding
   * before the answer is deciding wrong whenever the token is also a real
   * directory. So a pending session candidate reserves its run for one
   * verdict batch: a moment of plain text bought in exchange for a correct
   * answer. `payload` is ignored for a reserved entry.
   */
  reserved?: true;
}

/**
 * Every text node under `root` that entity detection should look at.
 *
 * Collected up front, because wrapping replaces nodes as it goes and a
 * live walk would trip over its own edits. The skipped subtrees are the
 * ones where a match would be wrong rather than merely redundant:
 *
 *  - `<a>` — already a link; a path inside its label is not a second one.
 *  - `<pre>` — fenced code is content being shown, not references being
 *    made. (Inline `<code>` is *not* skipped: that is where paths live.)
 *  - anything already annotated — including this pass's own wrappers, so
 *    re-running never nests a wrapper inside a wrapper.
 *  - anything outside the HTML namespace — an inline `<svg>` is a drawing,
 *    not prose. Its `<text>` holds characters the renderer measured and
 *    placed; wrapping a run of them splices an HTML `<span>` into the SVG,
 *    where it paints nothing. The label disappears while the box keeps the
 *    width it was measured at — an empty atom chip. An atom is a placed
 *    value the host already speaks for; the mark belongs on that host, not
 *    inside the drawing of it.
 *
 * Every collected node is scanned the same way. Whether the text sits
 * inside a `<code>` span decides how it is *painted*, never whether it is
 * *read*: the resolver is the gate, so detection has nothing to gain from
 * knowing which markup a candidate arrived in.
 */
export function collectTextNodes(root: HTMLElement): Text[] {
  const found: Text[] = [];
  const visit = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        found.push(child as Text);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as HTMLElement;
      if (element.namespaceURI !== HTML_NAMESPACE) continue;
      if (element.tagName === "A" || element.tagName === "PRE") continue;
      if (element.classList.contains(ANNOTATION_CLASS)) continue;
      visit(element);
    }
  };
  visit(root);
  return found;
}

/**
 * Replace `node` with its text split around `matches`, each match wrapped
 * in an annotated `<span>`.
 *
 * Matches must be sorted by `start`; any that overlaps one already taken
 * is skipped, so a caller that produces two readings of the same run gets
 * the first rather than a corrupted node.
 *
 * A `reserved` match takes its run out of contention without marking it — the
 * node's text comes out byte-identical, and no later match may claim those
 * characters on this pass. Two cursors is what that costs: `taken` is how far
 * the overlap check has consumed, `emitted` is how much text has been written
 * out. They differ exactly across a reservation.
 */
export function wrapMatchesInTextNode(
  node: Text,
  matches: readonly TextRunMatch[],
): void {
  const parent = node.parentNode;
  if (parent === null || matches.length === 0) return;
  const document = node.ownerDocument;
  const text = node.data;
  const fragment = document.createDocumentFragment();
  let emitted = 0;
  let taken = 0;
  for (const match of matches) {
    if (match.start < taken || match.end > text.length) continue;
    taken = match.end;
    // A hold, not a mark: the run stays prose, and stays unavailable.
    if (match.reserved === true) continue;
    if (match.start > emitted) {
      fragment.appendChild(document.createTextNode(text.slice(emitted, match.start)));
    }
    const span = document.createElement("span");
    span.setAttribute(WRAPPED_ATTRIBUTE, "");
    span.textContent = text.slice(match.start, match.end);
    stampAnnotation(span, match.payload);
    fragment.appendChild(span);
    emitted = match.end;
  }
  // Nothing was wrapped — a node of pure reservations is a node untouched.
  if (emitted === 0) return;
  if (emitted < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(emitted)));
  }
  parent.replaceChild(fragment, node);
}

/**
 * Undo one wrapper, folding its text back into the surrounding prose.
 * Normalizing the parent merges the neighbouring text nodes, so the next
 * pass sees one run again and can find a match that spans what used to be
 * the boundary.
 *
 * `text` overrides the words folded back. A wrapper hosting a portal has
 * had its own characters moved to a `data-*` attribute and its children
 * replaced by REACT'S DOM, so its `textContent` is no longer the prose's
 * spelling — and writing the saved words back into it before unwrapping
 * would destroy a subtree React still believes it owns, which throws
 * `NotFoundError` from `removeChild` on the portal's next unmount ([L06]:
 * a DOM mutation is free only while it does not reach into React's
 * subtree). Passing the words here instead leaves the host's children
 * untouched: the element is discarded whole, React's nodes still inside
 * it, so the unmount finds them exactly where it left them.
 */
export function unwrapMatch(element: HTMLElement, text?: string): void {
  const parent = element.parentNode;
  if (parent === null) return;
  const words = text ?? element.textContent ?? "";
  parent.replaceChild(element.ownerDocument.createTextNode(words), element);
  parent.normalize();
}
