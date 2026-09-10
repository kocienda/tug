/**
 * flash-pane-border.ts — the "here it is" flash ([P04]).
 *
 * One-shot pulse of a pane's BORDER: a CSS class toggled on the pane root,
 * which pulses an accent ring (box-shadow) and removes it on `animationend` —
 * pure appearance, never React state ([L06]). A mid-flash re-request restarts
 * the animation (remove → reflow → add), and a flash on anything ELSE ends
 * this one first — at most one ring is lit on the deck at a time.
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
 * @module lib/flash-pane-border
 */

import type { IDeckManagerStore } from "@/deck-manager-store";

const FLASH_CLASS = "tug-pane-flash";
const FLASH_ANIMATION_NAME = "tug-pane-border-flash";

/**
 * The one flash currently on the deck, as the function that ends it.
 *
 * At most one thing flashes at a time. The directional focus commands
 * (`Focus Card Left`/`Right`/`Above`/`Below`) can activate a card a keystroke
 * after the last one, and a ring left behind on the card the reader has
 * already moved off of says "look here" about a place they are no longer
 * being sent to — two rings answering one gesture. So every flash cancels the
 * one before it, whichever subject it was on: a card's ring puts out a
 * vacancy's and the other way round, because the reader reads them the same.
 */
let cancelActiveFlash: (() => void) | null = null;

/** Slack over the flash's own duration before the backstop fires. */
const FLASH_BACKSTOP_SLACK_MS = 500;
/** Used only when the computed duration can't be read (no chrome element yet). */
const FLASH_BACKSTOP_FALLBACK_MS = 2000;

/**
 * How long the flash runs, read from the element the keyframes are on — so the
 * backstop follows `--tugx-card-flash-duration` (`tug-pane.css`) instead of
 * carrying a second copy of the number that can drift out of step with it.
 */
function flashBackstopMs(host: HTMLElement, animatedSelector: string): number {
  const animated = host.querySelector(animatedSelector);
  if (!(animated instanceof HTMLElement)) return FLASH_BACKSTOP_FALLBACK_MS;
  const declared = getComputedStyle(animated).animationDuration.split(",")[0]?.trim() ?? "";
  const seconds = declared.endsWith("ms")
    ? Number.parseFloat(declared) / 1000
    : Number.parseFloat(declared);
  if (!Number.isFinite(seconds) || seconds <= 0) return FLASH_BACKSTOP_FALLBACK_MS;
  return seconds * 1000 + FLASH_BACKSTOP_SLACK_MS;
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
  const paneEl = document.querySelector(
    `.tug-pane[data-pane-id="${CSS.escape(paneId)}"]`,
  );
  if (!(paneEl instanceof HTMLElement)) {
    if (allowRetry) window.setTimeout(() => flashPaneBorder(paneId, false), 0);
    return;
  }
  cancelActiveFlash?.();
  paneEl.classList.remove(FLASH_CLASS);
  // Force a reflow so re-adding the class restarts the keyframes.
  void paneEl.offsetWidth;
  paneEl.classList.add(FLASH_CLASS);
  const clear = (): void => {
    paneEl.classList.remove(FLASH_CLASS);
    paneEl.removeEventListener("animationend", onEnd);
    window.clearTimeout(backstop);
    if (cancelActiveFlash === clear) cancelActiveFlash = null;
  };
  // `animationend` bubbles, so the listener must name the flash's own
  // keyframes: any animation finishing anywhere inside the card — a streaming
  // transcript, a spinner — would otherwise cut the flash short.
  const onEnd = (event: AnimationEvent): void => {
    if (event.animationName !== FLASH_ANIMATION_NAME) return;
    clear();
  };
  paneEl.addEventListener("animationend", onEnd);
  // A window whose rendering is suspended never ticks the keyframes, so
  // `animationend` never arrives and the ring would rest on the pane forever.
  // The timer is the only thing that guarantees the flash is one-shot.
  const backstop = window.setTimeout(clear, flashBackstopMs(paneEl, ".tug-pane-chrome"));
  cancelActiveFlash = clear;
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
  cancelActiveFlash?.();
  el.classList.remove(VACANCY_FLASH_CLASS);
  void el.offsetWidth;
  el.classList.add(VACANCY_FLASH_CLASS);
  const clear = (): void => {
    el.classList.remove(VACANCY_FLASH_CLASS);
    el.removeEventListener("animationend", onEnd);
    window.clearTimeout(backstop);
    if (cancelActiveFlash === clear) cancelActiveFlash = null;
  };
  const onEnd = (event: AnimationEvent): void => {
    if (event.animationName !== VACANCY_FLASH_ANIMATION_NAME) return;
    clear();
  };
  el.addEventListener("animationend", onEnd);
  // Same reason as the pane's: a window whose rendering is suspended never
  // ticks the keyframes, so the timer is what makes the flash one-shot.
  const backstop = window.setTimeout(clear, flashBackstopMs(el, ".tug-slot"));
  cancelActiveFlash = clear;
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
