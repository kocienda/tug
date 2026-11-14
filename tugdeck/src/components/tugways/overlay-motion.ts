/**
 * overlay-motion — how every overlay leaves: alerts, sheets, shades, and the
 * Radix app-modals drawn on the alert's classes.
 *
 * # One exit contract
 *
 * **Motion dresses the close; it never decides whether the close happens.**
 * {@link runOverlayExit} marks the surface `data-closing` (pointer-dead in the
 * CSS), runs one TugAnimator group, and then calls the caller's `finish`, which
 * is what unmounts the surface. It does this exactly once, on whichever comes
 * first: the group's `finished`, its rejection, or a deadline.
 *
 * The deadline is not padding. `finished` really does not always settle. A
 * window whose rAF is suspended (backgrounded, or merely covered, since a
 * covered window reads `visibilityState: "hidden"`) freezes an animation
 * mid-flight, and a group superseded on the same key never resolves either.
 * Either one leaves the promise pending forever. With the close gated on it,
 * the surface stays up, latched against every later close by the caller's
 * re-entry guard, and an app-modal holds Radix's `pointer-events: none` on
 * `<body>` while it does: the whole app is dead with nothing on screen to say
 * why. That is the failure `tug-alert.css` records, and it is why no overlay
 * exit here waits on `animationend` or on `finished` alone.
 *
 * # One Radix-safe shape
 *
 * A Radix dialog's exit cannot live in its `[data-state="closed"]` CSS,
 * because Presence holds a closing layer until `animationend`. So
 * {@link useOverlayExit} holds Radix *open* through the exit and only lets it
 * close when the exit settles. The closed state still names no animation, so
 * Radix unmounts synchronously and its body lock always comes off.
 *
 * # One motion table
 *
 * One duration ({@link OVERLAY_DURATION}, `moderate`, 200 ms), `ease-out` in
 * and `ease-in` out, and two shapes every overlay draws from: `scale-fade`
 * from {@link OVERLAY_SCALE_FROM}, and `rise` over {@link OVERLAY_ROLL_PX}.
 * The alert's CSS entrance keyframes (`tug-alert.css`) restate these two
 * numbers, because CSS cannot import them; change one and you change both.
 *
 * Laws: [L06] appearance via CSS/DOM, [L13] TugAnimator for programmatic
 *       motion, [L14] the Radix exit is never a CSS animation Presence waits on.
 *
 * @see ../tug-sheet.tsx `SHEET_PRESENTATION_MOTION`, built on these shapes
 * @see ../tug-alert.css, whose closed-state comment records why the deadline exists
 */

import { useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { group, scaledDurationMs, type TugAnimation } from "./tug-animator";

/** Every overlay's enter and exit duration: one number, settled by the user. */
export const OVERLAY_DURATION = "--tug-motion-duration-moderate";

/**
 * The fixed distance a `rise` travels. It does not scale with the panel, so a
 * tall sheet moves exactly as few pixels as a short one and the motion reads
 * as a settle rather than a sweep.
 */
export const OVERLAY_ROLL_PX = 28;

/** The scale a `scale-fade` grows from and shrinks back to. */
export const OVERLAY_SCALE_FROM = 0.96;

/**
 * How far past its scaled duration an exit may run before the deadline closes
 * the surface anyway. Comfortably past a frame or two of lateness, so a fade
 * that is really running is never cut short, and short enough that a stalled
 * one is not a hang the user waits through.
 */
export const OVERLAY_EXIT_DEADLINE_MARGIN_MS = 150;

/** An enter/exit keyframe pair. */
export interface OverlayMotion {
  enter: Keyframe[];
  exit: Keyframe[];
}

/** The panel fades in while scaling up from slightly smaller, and back. */
export const OVERLAY_SCALE_FADE: OverlayMotion = {
  enter: [
    { transform: `scale(${OVERLAY_SCALE_FROM})`, opacity: 0 },
    { transform: "scale(1)", opacity: 1 },
  ],
  exit: [
    { transform: "scale(1)", opacity: 1 },
    { transform: `scale(${OVERLAY_SCALE_FROM})`, opacity: 0 },
  ],
};

/** The panel rolls a short fixed distance up into place while fading in, and back. */
export const OVERLAY_RISE: OverlayMotion = {
  enter: [
    { transform: `translateY(${OVERLAY_ROLL_PX}px)`, opacity: 0 },
    { transform: "translateY(0)", opacity: 1 },
  ],
  exit: [
    { transform: "translateY(0)", opacity: 1 },
    { transform: `translateY(${OVERLAY_ROLL_PX}px)`, opacity: 0 },
  ],
};

/** A scrim's exit: it has no geometry, so it only fades. */
export const OVERLAY_SCRIM_EXIT: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }];

/**
 * The exit frames for a panel drawn on `.tug-alert-content`.
 *
 * The alert's centring lives in its own `transform` (`translate(-50%, -50%)`,
 * or `translateX(-50%)` on the rest line), and an animated `transform`
 * replaces the base one for the animation's length. So these are the shared
 * shapes with the centring restated in every frame, the same way the CSS
 * entrance keyframes restate it. A centred panel leaves by `scale-fade`; one
 * resting on a card's rest line leaves by `rise`, back down the way it came.
 *
 * Under reduced motion the animator strips `transform` and fades instead, and
 * the base rule's centring is what remains, so nothing jumps.
 */
export function alertPanelExitFrames(panel: HTMLElement): Keyframe[] {
  if (panel.dataset["verticalAnchor"] === "rest-line") {
    return [
      { transform: "translateX(-50%) translateY(0)", opacity: 1 },
      { transform: `translateX(-50%) translateY(${OVERLAY_ROLL_PX}px)`, opacity: 0 },
    ];
  }
  return [
    { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
    { transform: `translate(-50%, -50%) scale(${OVERLAY_SCALE_FROM})`, opacity: 0 },
  ];
}

/** One animated element in an exit. A null `el` is skipped. */
export interface OverlayExitTrack {
  el: Element | null | undefined;
  frames: Keyframe[];
  /** The animator slot key. An entrance on the same element should use the same key. */
  key: string;
  /** Overrides the exit's duration for this track (the shade scrim leaves a beat sooner). */
  duration?: string | number;
  /** Overrides the exit's easing for this track. */
  easing?: string;
}

export interface OverlayExitOptions {
  tracks: OverlayExitTrack[];
  /** The exit's duration, a token or raw ms. @default OVERLAY_DURATION */
  duration?: string | number;
  /** @default "ease-in" */
  easing?: string;
  /**
   * Elements to mark `data-closing` for the exit's length: the surface has
   * answered, so nothing inside it takes another press. Taken off again by
   * {@link OverlayExit.cancel}; on a settle the caller is unmounting them.
   */
  closing?: (Element | null | undefined)[];
  /** Called exactly once when the exit settles: this is what unmounts the surface. */
  finish: () => void;
}

/** A running exit. */
export interface OverlayExit {
  /** True once `finish` has run or the exit was cancelled. */
  readonly settled: boolean;
  /**
   * Call the close off: the surface is staying (it was re-opened mid-exit).
   * Drops the exit's effects without committing them, so the surface returns
   * to its presented look, takes `data-closing` off, and never calls `finish`.
   */
  cancel(): void;
}

/**
 * Run an overlay's exit and close it when the exit settles, or at the deadline
 * if it does not. See the module header for the contract.
 */
export function runOverlayExit(options: OverlayExitOptions): OverlayExit {
  const { tracks, finish } = options;
  const duration = options.duration ?? OVERLAY_DURATION;
  const easing = options.easing ?? "ease-in";
  const closing = (options.closing ?? []).filter(
    (el): el is Element => el !== null && el !== undefined,
  );
  const live = tracks.filter(
    (t): t is OverlayExitTrack & { el: Element } => t.el !== null && t.el !== undefined,
  );

  let settled = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const animations: TugAnimation[] = [];
  const handle: OverlayExit = {
    get settled() {
      return settled;
    },
    cancel() {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      for (const el of closing) el.removeAttribute("data-closing");
      // `raw.cancel()` rather than a TugAnimator cancel mode: every mode
      // commits a value (the end, or the current one), and a surface that is
      // staying wants neither. Dropping the effect returns it to its CSS.
      for (const a of animations) a.raw.cancel();
    },
  };

  if (live.length === 0) {
    settled = true;
    finish();
    return handle;
  }

  for (const el of closing) el.setAttribute("data-closing", "");

  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    finish();
  };

  const g = group({ duration, easing });
  let longestMs = 0;
  for (const track of live) {
    const trackDuration = track.duration ?? duration;
    longestMs = Math.max(longestMs, scaledDurationMs(trackDuration));
    animations.push(
      g.animate(track.el, track.frames, {
        key: track.key,
        duration: trackDuration,
        easing: track.easing ?? easing,
      }),
    );
  }
  deadline = setTimeout(settle, longestMs + OVERLAY_EXIT_DEADLINE_MARGIN_MS);
  g.finished.then(settle, settle);
  return handle;
}

export interface UseOverlayExitOptions {
  /** Whether the surface is asked to be open: the store's flag, or the component's own. */
  open: boolean;
  /** The Radix content element. */
  panelRef: MutableRefObject<HTMLElement | null>;
  /** The Radix overlay (scrim) element, when the surface has one. */
  scrimRef?: MutableRefObject<HTMLElement | null>;
  /** The panel's exit frames. @default alertPanelExitFrames */
  panelFrames?: (panel: HTMLElement) => Keyframe[];
}

export interface OverlayExitPresence {
  /**
   * Pass this to the Radix `Root`'s `open`. True while `open` is, and for the
   * length of the exit after it goes false.
   */
  shown: boolean;
  /**
   * The close that is coming is carried by something else (a zoom run that
   * flies the panel to where it went), so the panel goes at once rather than
   * fading under the rectangles. Call it before the render that closes.
   */
  skipNextExit: () => void;
}

/**
 * Keep a Radix dialog open through its exit, and let it close when the exit
 * settles ({@link runOverlayExit}). A re-open mid-exit calls the exit off and
 * the panel stays where it is.
 */
export function useOverlayExit(options: UseOverlayExitOptions): OverlayExitPresence {
  const { open, panelRef, scrimRef } = options;
  const panelFramesRef = useRef(options.panelFrames ?? alertPanelExitFrames);
  panelFramesRef.current = options.panelFrames ?? alertPanelExitFrames;

  // Structure, not appearance: whether Radix has the dialog at all. Promoted
  // during render when `open` goes true, so Radix opens in the same commit;
  // demoted only by the exit's settle, so the commit where `open` goes false
  // still has the panel in the DOM for the exit to run on.
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);

  const exitRef = useRef<OverlayExit | null>(null);
  const skipRef = useRef(false);

  useLayoutEffect(() => {
    if (open) {
      skipRef.current = false;
      if (exitRef.current !== null) {
        exitRef.current.cancel();
        exitRef.current = null;
      }
      return;
    }
    if (!shown || exitRef.current !== null) return;
    const panel = panelRef.current;
    if (skipRef.current || panel === null) {
      skipRef.current = false;
      setShown(false);
      return;
    }
    exitRef.current = runOverlayExit({
      closing: [panel],
      tracks: [
        { el: panel, frames: panelFramesRef.current(panel), key: "overlay-panel" },
        { el: scrimRef?.current, frames: OVERLAY_SCRIM_EXIT, key: "overlay-scrim" },
      ],
      finish: () => {
        exitRef.current = null;
        setShown(false);
      },
    });
  }, [open, shown, panelRef, scrimRef]);

  // Unmounted mid-exit: the surface is gone with its component, and a finish
  // landing later would set state on nothing.
  useLayoutEffect(
    () => () => {
      exitRef.current?.cancel();
      exitRef.current = null;
    },
    [],
  );

  const skipNextExit = useRef(() => {
    skipRef.current = true;
  }).current;

  return { shown: open || shown, skipNextExit };
}
