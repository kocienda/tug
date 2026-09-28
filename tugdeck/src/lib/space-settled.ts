/**
 * space-settled.ts — when a workspace switch's epoch closes.
 *
 * A switch lands as a cut: both decks are already drawn where the commit puts
 * them and nothing animates ([B01], [P11]). There is no cover and no dissolve —
 * the departing workspace is simply gone in the commit that swaps it. What
 * remains is a question the cut does not answer on its own: for how long after
 * the swap is the arriving workspace still ARRIVING?
 *
 * That span is the **epoch**, and `data-space-switching` is the mark that wears
 * it. It exists because geometry a hidden layer could not take — a composer's
 * line box, a pane bar's controls width, a sheet's clamps — lands in the frames
 * after the swap, and a pane whose rect moves in those frames must not be
 * animated to its new place ([B05]): the reader did not gesture at that pane, so
 * a tween there is motion nobody asked for. The mark is what stands down the
 * imposer over that window, and this module is the rule for when it lifts.
 *
 * Pure, on `arrival-reveal.ts`'s model, so the rule can be tested without a
 * deck — and, since a covered harness window suspends `requestAnimationFrame`,
 * so the settled path has a proof that does not depend on any window being
 * uncovered.
 *
 * Three inputs and one shape (Spec S02): the epoch closes at the first of the
 * arriving picture going SETTLED — no settle in flight and no layout-affecting
 * write under the arriving layer for {@link EPOCH_SILENT_FRAMES} consecutive
 * animation frames — or the BOUND expiring, so a workspace whose content never
 * settles cannot hold the imposer down forever.
 *
 * **What `silentFrames` must be silent about** is settled by the recording in
 * `briefs/workspace-switch-quiet-recording.md` rather than by the re-arm table
 * taken on faith, which is the whole reason the recording came first. It named
 * three sources and ruled two out: pane rects under the arriving layer (the
 * only thing that produced visible motion), a settle in flight, and the
 * arrival of any further commit — because a first show produced four post-swap
 * commits over about 100 ms and a counter watching rects alone could call it
 * settled in the gap between two of them. Clamps and scrollers contributed
 * nothing measurable and are deliberately not composed in. Those measurements
 * were taken against the cover's gate, and they transfer unchanged: they are
 * facts about when the ARRIVING LAYER stops writing, which is the same question
 * whatever is or is not painted over it.
 *
 * @module lib/space-settled
 */

/**
 * How long the epoch may stand before it closes regardless, in milliseconds
 * ([B05], [P06]).
 *
 * A liveness bound, not a settling estimate. It is unconditional: whatever the
 * other two inputs say, the mark comes off here, because the mark is a
 * mechanism that decides whether motion is allowed and one that can wait
 * forever is the defect [L32] is about.
 *
 * **Pinned at 400, and the argument is not the cover's.** Under the cover this
 * number was 200, and its ceiling was the eye: the wait was ADDED to a 240 ms
 * dissolve that followed it, and the two together had to stay inside the
 * quarter second {@link ARRIVAL_REVEAL_BOUND_MS} argues a gesture may take. The
 * cut removes that addend entirely — nothing follows the epoch, and the reader
 * sees the arriving workspace from the first painted frame either way. So the
 * ceiling that set 200 is gone, and what is left is the FLOOR, which is the
 * only direction that ever mattered here.
 *
 * The floor is what the arriving layer actually writes, and the recording
 * measured it on the small workspace: the composer's line box at 73 ms, the
 * last pane rect at 116 ms. 200 cleared those by a margin that was comfortable
 * for that deck and is not comfortable for the reference one, where the
 * arriving layer is eight panes and three Session cards rather than two panes —
 * and a bound that expires while the layer is still writing does not merely
 * measure badly, it hands those writes to the imposer and animates them, which
 * is exactly the motion [B05] forbids. 400 is chosen to sit clear of the
 * measured floor on the big workspace with the same kind of margin 200 gave the
 * small one. Failing LATE here costs a few frames of stood-down imposer on a
 * deck the reader is already looking at; failing early costs unasked-for
 * motion, so the asymmetry says to round up.
 */
export const SPACE_EPOCH_BOUND_MS = 400;

/**
 * How many consecutive silent animation frames close the epoch.
 *
 * Two — "a frame or two with no settle in flight and no re-measure landing",
 * which is [B02]'s own phrasing. The recording is what says two is a real bar
 * rather than a formality: the gaps inside a first show's commit train are tens
 * of milliseconds, which is several frames, so a train that is still running
 * cannot clear two silent frames by accident — but it is also a bar that
 * train's gaps COULD clear, and that is the number's known weakness.
 *
 * If an epoch is ever observed closing early on a first show, this is the
 * number to raise and the commit train is the reason to write beside it.
 */
export const EPOCH_SILENT_FRAMES = 2;

/** The facts {@link spaceEpochClosed} decides over. */
export interface SpaceEpochInput {
  /**
   * No settle is in flight on the canvas.
   *
   * Read off the container's own settling mark rather than remembered, so a
   * settle that ended by any of its several paths is seen the same way.
   */
  settled: boolean;
  /**
   * How many consecutive animation frames have passed with no
   * layout-affecting write under the arriving layer — no pane frame resized,
   * and no further commit arriving.
   */
  silentFrames: number;
  /** {@link SPACE_EPOCH_BOUND_MS} has elapsed since the swap commit. */
  boundElapsed: boolean;
}

/**
 * Whether the epoch has closed.
 *
 * The bound closes unconditionally, whatever the other two say. Otherwise
 * closed when nothing is settling AND the picture has been silent for
 * {@link EPOCH_SILENT_FRAMES} frames — both, because either alone is a
 * half-answer: a settle in flight is about to move frames whether or not this
 * frame was quiet, and a canvas with no settle on it can still be taking late
 * geometry from a layer that has just been shown.
 */
export function spaceEpochClosed(input: SpaceEpochInput): boolean {
  if (input.boundElapsed) return true;
  return input.settled && input.silentFrames >= EPOCH_SILENT_FRAMES;
}
