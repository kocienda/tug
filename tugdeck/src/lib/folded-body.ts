/**
 * folded-body.ts — the terminal state of every card's generic folded form.
 *
 * A folded card is its masthead plus a slit of its own body: the card root
 * stays mounted, fills the band the pane is pinned at, hangs from its top and
 * is clipped by the pane's content box ([B02] of the every-card-folds brief).
 * Nothing unmounts ([L26]), so a Text card's autosave and disk sync keep
 * running and its editor keeps its scroll position ([B03]).
 *
 * What CSS cannot say is that the slit is a picture rather than a surface, so
 * this module writes it: `inert` on the card host, and
 * {@link CARD_FOLD_ATTR}`="settled"` beside it, which is what a card's own
 * stylesheet keys on to take its folded-away parts out of layout ([B04]). Both
 * are DOM, never React state ([L06]).
 *
 * Both land at the END of the fold crossing, not at the flag's flip, for the
 * reason the Session card's own effect gives: the imposer holds the interior
 * still at its open height for the length of the sweep, and a strip taken out
 * of layout on the first frame would re-lay the interior out under the moving
 * edge, while an `inert` body would lose its caret while still on screen. The
 * unfold takes both off at once, because the open form is the one the card
 * comes back to.
 *
 * The flag is read off the frame's `data-folded` through a `MutationObserver`,
 * the thing itself rather than a store subscription: the attribute is what the
 * imposer compares across the commit to mark the crossing, so by the time the
 * observer's microtask runs, the mark is either on the frame or is not coming.
 *
 * A card that owns its folded form — the Session card ([B08]) — declares
 * `ownsFoldedForm` and is never given this one.
 *
 * @module lib/folded-body
 */

import { isTugMotionEnabled } from "@/components/tugways/scale-timing";
import { FOLD_CROSSING_ATTR, FOLD_CROSSING_END } from "@/lib/fold-crossing";

/** Written on a folded card's host once its fold has landed. Observable to tests; not React state ([L06]). */
export const CARD_FOLD_ATTR = "data-card-fold";

/**
 * Take `cardId`'s host out of its folded form NOW, ahead of the unfold's own
 * commit — for a surface the user asked for, which focuses itself in the same
 * gesture and cannot take the keyboard inside an `inert` subtree ([B09] of the
 * every-card-folds brief). The observer's read of the flag that follows lands
 * the same open form again, which writes nothing new. A host that is not
 * folded, or not on the page, is left as it is.
 */
export function openFoldedBody(cardId: string): void {
  if (typeof document === "undefined") return;
  const host = document.querySelector<HTMLElement>(
    `[data-card-host][data-card-id="${CSS.escape(cardId)}"]`,
  );
  if (host === null) return;
  host.removeAttribute(CARD_FOLD_ATTR);
  host.removeAttribute("inert");
}

/**
 * Hold `host` in its folded form whenever `frame` is folded, returning the
 * teardown, which leaves the host open.
 *
 * A host that arrives in a frame already folded — a restored deck, a card
 * dropped into a folded pane — has no crossing to wait on and lands at once,
 * as does every fold with motion off, where the layout snap is the settle and
 * the imposer arms no tween to end.
 */
export function holdFoldedBody(frame: HTMLElement, host: HTMLElement): () => void {
  let folded: boolean | null = null;
  let cancelWait: (() => void) | null = null;

  const land = (on: boolean): void => {
    if (on) {
      host.setAttribute(CARD_FOLD_ATTR, "settled");
      host.setAttribute("inert", "");
    } else {
      host.removeAttribute(CARD_FOLD_ATTR);
      host.removeAttribute("inert");
    }
  };

  const read = (): void => {
    const next = frame.getAttribute("data-folded") === "true";
    if (next === folded) return;
    const firstRead = folded === null;
    folded = next;
    cancelWait?.();
    cancelWait = null;
    if (!next || firstRead || !isTugMotionEnabled()) {
      land(next);
      return;
    }
    // The crossing's end is the imposer's to announce. The one fold it does
    // not carry — a cut landing, a frame the pointer owns — is never marked,
    // and one animation frame is enough to know: the imposer marks in the
    // commit's layout pass, before paint.
    const onEnd = (): void => {
      cancelWait?.();
      cancelWait = null;
      land(true);
    };
    let probe: number | null = window.requestAnimationFrame(() => {
      probe = null;
      if (frame.hasAttribute(FOLD_CROSSING_ATTR)) return;
      onEnd();
    });
    frame.addEventListener(FOLD_CROSSING_END, onEnd);
    cancelWait = () => {
      frame.removeEventListener(FOLD_CROSSING_END, onEnd);
      if (probe !== null) window.cancelAnimationFrame(probe);
      probe = null;
    };
  };

  read();
  const observer = new MutationObserver(read);
  observer.observe(frame, { attributes: true, attributeFilter: ["data-folded"] });
  return () => {
    observer.disconnect();
    cancelWait?.();
    cancelWait = null;
    land(false);
  };
}
