/**
 * land-by-deadline.ts — a commit that waits on an animation, with a deadline.
 *
 * An animation's `finished` settles on the deck's frames, and a window whose
 * frames are suspended — occluded, minimized, behind another app — settles it
 * late or never. A commit parked on it alone is a callback parked on an event
 * that may never fire ([L31]), and whatever the commit lifts — a mark, a pin,
 * a bracket — stays up until it does ([L32]). So the commit runs once, on
 * whichever comes first: the animation finishing, the animation being
 * cancelled (`finished` rejecting is still the end of it), the deadline, or
 * the owner asking for it now.
 *
 * @module lib/land-by-deadline
 */

/** Why the commit ran. Anything but `finished` means the animation may still
 *  be running, and its owner stops it before landing. */
export type LandCause = "finished" | "cancelled" | "deadline" | "now";

/**
 * Run `land` exactly once: when `finished` resolves or rejects, when
 * `deadlineMs` passes, or when the returned function is called — whichever is
 * first. The returned function is idempotent and is how an owner tearing down
 * lands the commit at once.
 */
export function landByDeadline(
  finished: Promise<unknown>,
  deadlineMs: number,
  land: (cause: LandCause) => void,
): () => void {
  let landed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const once = (cause: LandCause): void => {
    if (landed) return;
    landed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    land(cause);
  };
  timer = setTimeout(() => once("deadline"), deadlineMs);
  finished.then(
    () => once("finished"),
    () => once("cancelled"),
  );
  return () => once("now");
}
