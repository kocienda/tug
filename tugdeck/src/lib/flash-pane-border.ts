/**
 * flash-pane-border.ts — the "here it is" flash ([P04]).
 *
 * One-shot pulse of a pane's BORDER: a CSS class toggled on the pane root,
 * which shows a pre-drawn accent ring and fades it by `opacity`, removing the
 * class on `animationend` — pure appearance, never React state ([L06]). A
 * mid-flash re-request restarts the run in place, and a flash on anything ELSE
 * ends this one first — at most one ring is lit on the deck at a time.
 *
 * Every gesture that answers a reader by putting a card in front of them uses
 * it: the slot chords and `focus-session-card` raising a card that already
 * exists, and {@link flashCardPane} for a card that has just been made — a
 * file opened from a link, a session resumed from an atom. A card arriving
 * somewhere on the deck is a change the eye has to find; the ring says where
 * to look.
 *
 * There are two subjects, not one, because there are two things a gesture can
 * name. {@link flashPaneBorder} rings a CARD; {@link flashVacantSlot} rings the
 * badge standing in a held-open PLACE. {@link flashSlot} is for a caller that
 * was given a place and does not care which of the two is there — a distinction
 * the deck can make and the gesture should not have to.
 *
 * ## Two things this module does NOT do any more, and why
 *
 * **It reads no layout.** The restart used to be remove-class → `void
 * offsetWidth` → add-class, because remove-then-add inside one task is not a
 * style change the engine ever resolves and the forced reflow was what made it
 * one. That reflow landed on a tree React had just dirtied, inside the click's
 * own task, at the moment a settle was about to start ([F05], [F06]). The
 * restart is now a **seek** — the flash's own running effect sought to
 * `currentTime = 0` — which restarts it in place, needs no recalc between two
 * writes, and reads nothing. A cancel would NOT have worked in its place: an
 * element that still computes the same `animation-name` leaves the engine
 * nothing to diff at the next recalc, so the cancelled effect is never
 * replaced and the ring simply does not play.
 *
 * **It animates no paint property.** The keyframes used to walk `box-shadow`
 * for nearly two seconds, which is a repaint of a full-pane layer per frame
 * ([F05]). The ring is now drawn ONCE, statically, and only its `opacity`
 * moves — the compositor's own property ([B03], [B05]).
 *
 * ## And one thing it now waits for
 *
 * {@link flashPaneBorderOnSettle} parks the flash on the settle's completion
 * instead of starting it inside the click's frame, so the two seconds it runs
 * overlap no motion. Everything else about it is unchanged, including the
 * deferred retry for a pane the DOM does not hold yet.
 *
 * @module lib/flash-pane-border
 */

import { paneCanvasOf } from "@/components/chrome/space-layer";
import type { IDeckManagerStore } from "@/deck-manager-store";
import { IMPOSER_SETTLE_END } from "./settle-notice";

const FLASH_CLASS = "tug-pane-flash";
const FLASH_ANIMATION_NAME = "tug-pane-border-flash";

/** The canvas mark that says a settle is running. `deck-canvas.tsx` owns it. */
const SETTLING_ATTRIBUTE = "data-imposer-settling";

/**
 * The one flash currently on the deck: the element it is lit on, and how to
 * end it.
 *
 * At most one thing flashes at a time. The directional focus commands
 * (`Focus Card Left`/`Right`/`Above`/`Below`) can activate a card a keystroke
 * after the last one, and a ring left behind on the card the reader has
 * already moved off of says "look here" about a place they are no longer
 * being sent to — two rings answering one gesture. So every flash ends the
 * one before it, whichever subject it was on: a card's ring puts out a
 * vacancy's and the other way round, because the reader reads them the same.
 *
 * The element is held beside the ender because a re-request on the SAME
 * subject is a restart rather than an end, and a restart needs the class left
 * on: taking it off would take the effect with it, and there would be nothing
 * left to seek.
 */
interface ActiveFlash {
  readonly el: HTMLElement;
  /** End it. `keepClass` leaves the class on for a restart to seek. */
  readonly end: (keepClass: boolean) => void;
}

let activeFlash: ActiveFlash | null = null;

/** Slack over the flash's own duration before the backstop fires. */
const FLASH_BACKSTOP_SLACK_MS = 500;
/** Used only when the computed duration can't be read (nothing animated to ask). */
const FLASH_BACKSTOP_FALLBACK_MS = 2000;

/**
 * How long the flash runs, read from the box the keyframes are on — so the
 * backstop follows `--tugx-card-flash-duration` (`tug-pane.css`) instead of
 * carrying a second copy of the number that can drift out of step with it.
 *
 * `pseudo` is for the subject whose animated box is a pseudo-element rather
 * than an element: the pane's ring is `::before` on the frame, which no
 * `querySelector` can reach and only `getComputedStyle`'s second argument can
 * be asked about. Read AFTER the class is on, or the box has no animation to
 * report and every flash falls back to the fixed default.
 */
function flashBackstopMs(animated: Element | null, pseudo?: string): number {
  if (animated === null) return FLASH_BACKSTOP_FALLBACK_MS;
  const declared =
    getComputedStyle(animated, pseudo ?? null).animationDuration.split(",")[0]?.trim() ?? "";
  const seconds = declared.endsWith("ms")
    ? Number.parseFloat(declared) / 1000
    : Number.parseFloat(declared);
  if (!Number.isFinite(seconds) || seconds <= 0) return FLASH_BACKSTOP_FALLBACK_MS;
  return seconds * 1000 + FLASH_BACKSTOP_SLACK_MS;
}

/**
 * The flash's own running effect under `el`, or `null` if none is.
 *
 * `{ subtree: true }` is required rather than tidy: the pane's ring lives on
 * a pseudo-element, and a bare `getAnimations()` answers for the element's own
 * box alone. The name filter is what keeps the sweep honest — a card's
 * streaming transcript and a spinner are both animations under a frame, and
 * only one animation on the deck is ever named this.
 */
function runningFlashOn(el: Element, animationName: string): Animation | null {
  for (const animation of el.getAnimations({ subtree: true })) {
    if ((animation as CSSAnimation).animationName === animationName) {
      return animation;
    }
  }
  return null;
}

/**
 * Light the one flash on `el`, ending whatever was lit before.
 *
 * The whole of the restart rule is the first three statements: a request on
 * the subject already flashing keeps its class so the effect survives to be
 * sought, and a request on any other subject ends that one outright.
 */
function runFlash(
  el: HTMLElement,
  flashClass: string,
  animationName: string,
  backstopMs: () => number,
): void {
  const restarting = activeFlash !== null && activeFlash.el === el;
  activeFlash?.end(restarting);

  const running = restarting ? runningFlashOn(el, animationName) : null;
  if (running !== null) running.currentTime = 0;
  else el.classList.add(flashClass);

  const end = (keepClass: boolean): void => {
    if (!keepClass) el.classList.remove(flashClass);
    el.removeEventListener("animationend", onEnd);
    window.clearTimeout(backstop);
    if (activeFlash !== null && activeFlash.end === end) activeFlash = null;
  };
  // `animationend` bubbles, so the listener must name the flash's own
  // keyframes: any animation finishing anywhere inside the card — a streaming
  // transcript, a spinner — would otherwise cut the flash short.
  const onEnd = (event: AnimationEvent): void => {
    if (event.animationName !== animationName) return;
    end(false);
  };
  el.addEventListener("animationend", onEnd);
  // A window whose rendering is suspended never ticks the keyframes, so
  // `animationend` never arrives and the ring would rest on the pane forever.
  // The timer is the only thing that guarantees the flash is one-shot.
  const backstop = window.setTimeout(() => end(false), backstopMs());
  activeFlash = { el, end };
}

/** The frame holding this pane, or `null` if the DOM does not hold it yet. */
function paneFrame(paneId: string): HTMLElement | null {
  const el = document.querySelector(
    `.tug-pane[data-pane-id="${CSS.escape(paneId)}"]`,
  );
  return el instanceof HTMLElement ? el : null;
}

/**
 * Flash the pane with this id.
 *
 * A pane the DOM does not hold yet gets one deferred retry: `assign-slot` can
 * pull a card out of a tab group into a pane that exists in the store but not
 * on screen until React commits, and the flash belongs on the pane the card
 * ends up in. The retry does not retry again — a second miss is a pane that
 * never rendered, not one still on its way.
 */
export function flashPaneBorder(paneId: string, allowRetry = true): void {
  if (typeof document === "undefined") return;
  const paneEl = paneFrame(paneId);
  if (paneEl === null) {
    if (allowRetry) window.setTimeout(() => flashPaneBorder(paneId, false), 0);
    return;
  }
  runFlash(paneEl, FLASH_CLASS, FLASH_ANIMATION_NAME, () =>
    flashBackstopMs(paneEl, "::before"),
  );
}

/**
 * The flash parked on a settle that has not landed yet: the container it is
 * waiting on, and how to stop waiting.
 *
 * Module-local and single, for the same reason {@link activeFlash} is: one
 * ring on the deck at a time means one flash in flight at a time, parked or
 * lit.
 */
let pendingFlash: { readonly drop: () => void } | null = null;

/**
 * Forget a flash parked on a settle that will never end.
 *
 * `IMPOSER_SETTLE_END` is dispatched at every point the canvas takes
 * `data-imposer-settling` off with exactly one exception — the arm effect's
 * own unmount teardown — so this is the one path a parked flash cannot hear.
 * Left parked, the record holds a detached container alive and its listener
 * fires against a stale pane at the next canvas's first settle.
 *
 * `deck-canvas.tsx` calls this from that teardown. Safe to call when nothing
 * is parked.
 */
export function dropPendingFlash(): void {
  pendingFlash?.drop();
  pendingFlash = null;
}

/**
 * Flash the pane with this id, but not until the settle has landed.
 *
 * The flash runs for nearly two seconds and the settle for a few hundred
 * milliseconds, so starting it in the click's frame means the ring's whole
 * first third overlaps the motion it is announcing ([B05]). Starting it on the
 * settle's own completion is a fact about the frame rather than a hand-tuned
 * offset — the imposer's spring can be retargeted mid-travel and a constant
 * would drift out of step with it ([B04]'s non-goal).
 *
 * **With no settle running, it flashes now.** The predicate is
 * `data-imposer-settling` on the canvas, read at call time, and that read is
 * decisive: `raiseCard` runs its activation through `flushSync`, so by the
 * time a dispatcher calls this the Last pass has already run and the mark is
 * either on or it is not. A `focus-session-card` naming a card already in the
 * reader's slot arms nothing, and a gesture that goes unanswered is the
 * feature lost.
 */
export function flashPaneBorderOnSettle(paneId: string, allowRetry = true): void {
  if (typeof document === "undefined") return;
  const paneEl = paneFrame(paneId);
  if (paneEl === null) {
    // The same one-shot retry {@link flashPaneBorder} takes, and for the same
    // reason: the pane is in the store and not yet in the DOM.
    if (allowRetry) {
      window.setTimeout(() => flashPaneBorderOnSettle(paneId, false), 0);
    }
    return;
  }
  // By identity through `paneCanvasOf`, because the notice does not bubble and
  // a pane frame is not a direct child of the container it is dispatched on.
  const canvas = paneCanvasOf(paneEl);
  if (canvas === null || !canvas.hasAttribute(SETTLING_ATTRIBUTE)) {
    flashPaneBorder(paneId, false);
    return;
  }
  dropPendingFlash();
  const onSettleEnd = (): void => {
    pendingFlash = null;
    flashPaneBorder(paneId, false);
  };
  canvas.addEventListener(IMPOSER_SETTLE_END, onSettleEnd, { once: true });
  pendingFlash = {
    drop: () => canvas.removeEventListener(IMPOSER_SETTLE_END, onSettleEnd),
  };
}

/**
 * Flash whichever pane holds `cardId` — what an opener has in hand, since the
 * card is what it made and the pane is the store's business.
 *
 * Called on the frame the card is added, when the pane it lands in is in the
 * store but not yet in the DOM; {@link flashPaneBorder}'s deferred retry is
 * what catches it after React commits. A card that reaches no pane at all is
 * silence, not a warning: nothing appeared, so nothing flashes.
 */
export function flashCardPane(store: IDeckManagerStore, cardId: string): void {
  const pane = store.getSnapshot().panes.find((p) => p.cardIds.includes(cardId));
  if (pane !== undefined) flashPaneBorder(pane.id);
}

const VACANCY_FLASH_CLASS = "tug-slot-vacancy-flash";
const VACANCY_FLASH_ANIMATION_NAME = "tug-slot-vacancy-flash";

/**
 * Flash the held-open place at `slot` — a slot of the arrangement no card
 * stands in.
 *
 * The vacancy tile is inert to the pointer and quiet by construction, so a
 * gesture that lands on one has nothing to answer with unless this does. The
 * class goes on the tile — the reserved room — but the ring lands on the BADGE
 * inside it, because ringing the room would read as a card arriving rather than
 * as a place being pointed at.
 *
 * Built exactly as the pane's is, and that is the point rather than an
 * economy: the two subjects are read the same by the reader, so a static ring
 * faded by `opacity` and a restart by seek are theirs jointly. The badge's
 * animated box is a real element rather than a pseudo, which is the only
 * difference the code can see.
 *
 * No retry. A pane can be in the store a frame before it is in the DOM, which
 * is what {@link flashPaneBorder} defers for; a vacancy is derived from the
 * same render that draws it, so a tile that is not there is a slot that is not
 * vacant.
 */
export function flashVacantSlot(slot: number): void {
  if (typeof document === "undefined") return;
  const el = document.querySelector(
    `.tug-slot-vacancy[data-vacant-slot="${CSS.escape(String(slot))}"]`,
  );
  if (!(el instanceof HTMLElement)) return;
  runFlash(el, VACANCY_FLASH_CLASS, VACANCY_FLASH_ANIMATION_NAME, () =>
    flashBackstopMs(el.querySelector(".tug-slot")),
  );
}

/**
 * Flash whichever thing stands at `slot` — the pane if a card holds the place,
 * the held-open tile if none does.
 *
 * What a gesture that names a PLACE has in hand, since the place is the whole
 * of what it was told and whether anything is standing in it is the deck's
 * business. An empty slot is a legitimate destination now that a vacancy holds
 * its room, so answering only for occupied ones would make the same gesture
 * silent for reasons the user never asked about.
 */
export function flashSlot(store: IDeckManagerStore, slot: number): void {
  const pane = store.getSnapshot().panes.find((p) => p.slot === slot);
  if (pane !== undefined) flashPaneBorder(pane.id);
  else flashVacantSlot(slot);
}
