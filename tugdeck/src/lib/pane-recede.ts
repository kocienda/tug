/**
 * pane-recede.ts — the deck's recede: which frames wear it, and the one window
 * in which it is allowed to move.
 *
 * The recede is the three layers that dim every frame the reader is not in —
 * two blend pseudo-elements on `.tug-pane-chrome` (`tug-pane.css`) and the
 * frame dim on `.tug-pane::after` (`styles/chrome.css`). This module owns the
 * two marks those rules key on, and nothing else does:
 *
 *   - **`data-receded`** on each frame — absent on the frame the reader is in,
 *     `"dim"` on every other, and `"deep"` on every other while one pane
 *     stands in bullseye. It is the recede's VALUE.
 *   - **`data-recede-armed`** on the frames container — present only for the
 *     length of a fade. It is the recede's TRANSITION.
 *
 * **Why the value is a mark of ours rather than `data-focused`.** The recede
 * used to be keyed straight off `:not([data-focused="true"])`, and focus flips
 * at the instant the activation commits — which is the instant a settle starts
 * moving the frames. So the recede painted while the deck was in motion, on
 * layers that came into existence on the outgoing frame and out of existence
 * on the incoming one inside the first frame of the tween ([F04] of the
 * `deck-animation-pipeline` brief). Holding the value in a mark of our own is
 * what lets a running settle DEFER it: the frames are already still when the
 * recede paints ([B04]).
 *
 * **Why the transition is armed rather than standing.** WebKit keeps a
 * finished `CSSTransition` in `getAnimations()` forever unless the rest state
 * drops it ([D6]), and these layers are now on every frame rather than on the
 * unfocused ones — a standing `transition` would be three retained effects per
 * pane on a settled deck, growing with card count, which is exactly the quiet
 * contract ([D1]) this arc exists to keep. So the arm goes on for the fade and
 * comes off when it lands, on `transitionend` with a backstop for the window
 * whose rendering is suspended and therefore never ticks one.
 *
 * **What it watches.** `data-focused` is written by `pane-focus-controller.ts`,
 * the sole authority for it, on every pane of the shown layer whenever the
 * active pane changes — including a pane that has only just mounted. That
 * write is the one signal this module needs, so it watches the attribute
 * itself rather than subscribing to the store or riding a React commit: no
 * hook-ordering dependency, no work at all on a deck nobody is touching.
 *
 * @module lib/pane-recede
 */

import { SHOWN_PANE_FRAMES } from "@/components/chrome/space-layer";
import { IMPOSER_SETTLE_END } from "./settle-notice";

/** The recede's value, on each frame. Absent means the reader's own frame. */
export const RECEDE_ATTRIBUTE = "data-receded";

/** The recede's transition, on the frames container, for a fade's length only. */
export const RECEDE_ARMED_ATTRIBUTE = "data-recede-armed";

/**
 * Slack over the fade's own duration before the backstop disarms anyway.
 *
 * The deadline is a net, not a clock: it must never fire while the fade is
 * still running, and it must fire soon enough that a stranded arm is a blink
 * rather than a state. The same shape and the same reason as
 * `flash-pane-border.ts`'s.
 */
const DISARM_BACKSTOP_SLACK_MS = 150;

/** Used only when no frame is on screen to read a computed duration off. */
const DISARM_BACKSTOP_FALLBACK_MS = 450;

/** The depth a frame wears, or `null` for the frame the reader is in. */
export type RecedeDepth = "dim" | "deep";

/**
 * What `frame` should be wearing, given whether the deck is in bullseye.
 *
 * The bullseyed pane is ALWAYS the focused pane — the posture is derived from
 * the first responder — so one focus test answers both, and nothing here can
 * disagree with the geometry.
 */
export function recedeDepthFor(
  frame: HTMLElement,
  bullseye: boolean,
): RecedeDepth | null {
  if (frame.dataset.focused === "true") return null;
  return bullseye ? "deep" : "dim";
}

/**
 * Write every shown frame's `data-receded` from the deck's current posture.
 *
 * Returns whether any frame's mark actually moved, which is what decides
 * whether there is a fade to arm at all.
 */
export function syncPaneRecede(container: HTMLElement): boolean {
  const bullseye = container.hasAttribute("data-bullseye");
  let changed = false;
  for (const frame of container.querySelectorAll<HTMLElement>(
    SHOWN_PANE_FRAMES,
  )) {
    const want = recedeDepthFor(frame, bullseye);
    const have = frame.getAttribute(RECEDE_ATTRIBUTE);
    if (want === null) {
      if (have === null) continue;
      frame.removeAttribute(RECEDE_ATTRIBUTE);
      changed = true;
      continue;
    }
    if (have === want) continue;
    frame.setAttribute(RECEDE_ATTRIBUTE, want);
    changed = true;
  }
  return changed;
}

/**
 * How long the fade runs, read from a box the rule is actually on — so the
 * backstop follows `--tugx-imposer-settle-duration` rather than carrying a
 * second copy of the number that can drift out of step with it.
 *
 * The animated box is a pseudo-element, which no `querySelector` can reach and
 * only `getComputedStyle`'s second argument can be asked about. Read AFTER the
 * arm is on, or the box reports `0s` and every fade falls back to the default.
 */
function fadeBackstopMs(container: HTMLElement): number {
  const frame = container.querySelector<HTMLElement>(SHOWN_PANE_FRAMES);
  if (frame === null) return DISARM_BACKSTOP_FALLBACK_MS;
  const declared =
    getComputedStyle(frame, "::after")
      .transitionDuration.split(",")[0]
      ?.trim() ?? "";
  const seconds = declared.endsWith("ms")
    ? Number.parseFloat(declared) / 1000
    : Number.parseFloat(declared);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DISARM_BACKSTOP_FALLBACK_MS;
  }
  return seconds * 1000 + DISARM_BACKSTOP_SLACK_MS;
}

/**
 * Install the recede on `container`, the frames container.
 *
 * Returns the teardown. It disarms as it goes, which is the one thing the
 * unmount path must do for itself: `IMPOSER_SETTLE_END` is dispatched at every
 * point the canvas takes `data-imposer-settling` off EXCEPT the arm effect's
 * unmount teardown, so a canvas that goes away mid-settle leaves a pending
 * disarm that nothing else will ever run.
 */
export function installPaneRecede(container: HTMLElement): () => void {
  let backstop: number | undefined;

  const disarm = (): void => {
    if (backstop !== undefined) {
      window.clearTimeout(backstop);
      backstop = undefined;
    }
    container.removeAttribute(RECEDE_ARMED_ATTRIBUTE);
  };

  /**
   * Arm, write the new depths, and schedule the disarm.
   *
   * The arm and the value change land in ONE task on purpose: a transition is
   * decided from the after-change style, so the recalc that first sees the new
   * `data-receded` also sees the arm, and the fade starts. Arming afterwards
   * would animate nothing, because the value would already have cut.
   */
  const fade = (): void => {
    container.setAttribute(RECEDE_ARMED_ATTRIBUTE, "");
    if (!syncPaneRecede(container)) {
      // Nothing moved — a settle that carried no focus or posture change.
      // Take the arm straight back off rather than leaving it standing on a
      // deck with no fade coming to end it.
      disarm();
      return;
    }
    if (backstop !== undefined) window.clearTimeout(backstop);
    backstop = window.setTimeout(disarm, fadeBackstopMs(container));
  };

  /**
   * A settle running owns the recede: the value is deferred to its end, where
   * `fade` runs it against frames that have stopped moving. With no settle in
   * flight there is nothing to wait for, so the fade runs now — a card
   * activated where it already stands rearranges nothing and should still
   * recede rather than cut.
   */
  const onFocusOrPosture = (): void => {
    if (container.hasAttribute("data-imposer-settling")) return;
    fade();
  };

  const observer = new MutationObserver(onFocusOrPosture);
  observer.observe(container, {
    attributes: true,
    attributeFilter: ["data-focused", "data-bullseye"],
    subtree: true,
  });

  const onSettleEnd = (): void => fade();
  container.addEventListener(IMPOSER_SETTLE_END, onSettleEnd);

  /**
   * The arm comes off when the last of the three layers lands.
   *
   * `transitionend` bubbles, so the container hears every frame's — and a deck
   * has three per receding frame. Asking the subtree whether any opacity
   * transition is still running is what makes the LAST one the one that
   * disarms; an unrelated opacity transition elsewhere in a card only ever
   * delays the disarm, which the backstop bounds.
   */
  const onTransitionEnd = (event: TransitionEvent): void => {
    if (event.propertyName !== "opacity") return;
    if (!container.hasAttribute(RECEDE_ARMED_ATTRIBUTE)) return;
    const stillFading = container
      .getAnimations({ subtree: true })
      .some(
        (animation) =>
          animation.playState === "running" &&
          (animation as { transitionProperty?: string }).transitionProperty ===
            "opacity",
      );
    if (!stillFading) disarm();
  };
  container.addEventListener("transitionend", onTransitionEnd);

  // The rest state, written with no arm on: a deck that has just mounted wears
  // its recede rather than fading into it.
  syncPaneRecede(container);

  return (): void => {
    observer.disconnect();
    container.removeEventListener(IMPOSER_SETTLE_END, onSettleEnd);
    container.removeEventListener("transitionend", onTransitionEnd);
    disarm();
  };
}
