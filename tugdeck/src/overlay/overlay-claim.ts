/**
 * Where the overlay takes the pointer, told to the host as it changes.
 *
 * The overlay's view stands above every card and hit-tests nil everywhere
 * but inside its claim ([B07]), so a click on a card beneath it reaches the
 * card. The claim is read from what the page shows:
 *
 * - a dialog standing anywhere in it — an app-modal, an alert — claims the
 *   whole window (`{all: true}`), which is what a modal is; the host also
 *   makes the overlay's view the key one for that span, so the dialog's keys
 *   reach it;
 * - otherwise, the rects of every element marked `data-overlay-claim` that
 *   has an area: the update pill, and any surface the overlay draws for a
 *   card; and every deck bulletin standing in the stack (Sonner's
 *   `data-sonner-toast`, which no attribute of ours can reach); none at all
 *   when it shows nothing.
 *
 * Read on a mutation of the page, coalesced to one reading a frame, and
 * again when a transition ends — a bulletin slides in under a transform, so
 * the reading at its mount sees it mid-flight; posted only when it says
 * something new. What was last posted is stamped on the
 * document as {@link OVERLAY_CLAIM_STATE_ATTRIBUTE}, after the post: a
 * reader of this page that sees the stamp knows the host has the claim,
 * since the post and the read's reply leave this process on one ordered
 * connection. The harness reads it to make a card's gesture only once a
 * modal's claim on the whole window has been given up.
 *
 * @module overlay/overlay-claim
 */

import type { OverlayClaim } from "../host/declarations/overlay";

/** What marks an element as one the overlay takes the pointer inside. */
export const OVERLAY_CLAIM_ATTRIBUTE = "data-overlay-claim";

/** On the document: the kind of claim last posted to the host, `all`, `rects` or `none`. */
export const OVERLAY_CLAIM_STATE_ATTRIBUTE = "data-overlay-claim-state";

/** The kind {@link OVERLAY_CLAIM_STATE_ATTRIBUTE} names a claim by. */
export function overlayClaimKind(claim: OverlayClaim): "all" | "rects" | "none" {
  if ("all" in claim) return "all";
  return claim.rects.length > 0 ? "rects" : "none";
}

const DIALOGS = '[role="dialog"], [role="alertdialog"]';

/** What the claim is read from: marked surfaces, and the bulletins Sonner draws. */
const CLAIMED = `[${OVERLAY_CLAIM_ATTRIBUTE}], [data-sonner-toast]`;

/** The claim `doc` stands for now. Reads layout. */
export function readOverlayClaim(doc: Document): OverlayClaim {
  if (doc.querySelector(DIALOGS) !== null) return { all: true };
  const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const el of doc.querySelectorAll(CLAIMED)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    // Grown outward to whole points on every edge, so no strip of a surface
    // at a fractional offset falls outside its claim.
    const x = Math.floor(r.x);
    const y = Math.floor(r.y);
    rects.push({ x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y });
  }
  return { rects };
}

function sameClaim(a: OverlayClaim | null, b: OverlayClaim): boolean {
  if (a === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Post the page's claim through `post` now and whenever it moves. Returns
 * the release ([L27]).
 */
export function installOverlayClaim(
  doc: Document,
  post: (claim: OverlayClaim) => void,
  requestFrame: (step: () => void) => number = (step) => requestAnimationFrame(step),
): () => void {
  let last: OverlayClaim | null = null;
  let pending = false;
  const read = (): void => {
    pending = false;
    const next = readOverlayClaim(doc);
    if (sameClaim(last, next)) return;
    last = next;
    post(next);
    doc.documentElement.setAttribute(OVERLAY_CLAIM_STATE_ATTRIBUTE, overlayClaimKind(next));
  };
  const schedule = (): void => {
    if (pending) return;
    pending = true;
    requestFrame(read);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true });
  const view = doc.defaultView;
  view?.addEventListener("resize", schedule);
  doc.addEventListener("transitionend", schedule, true);
  read();
  return () => {
    observer.disconnect();
    view?.removeEventListener("resize", schedule);
    doc.removeEventListener("transitionend", schedule, true);
  };
}
