/**
 * space-quiet.ts — when the cover a workspace switch holds may dissolve.
 *
 * A switch lands as a cut: both decks are already drawn where the commit puts
 * them and nothing animates ([P11], [B03]). What is left is the JOIN between
 * two still pictures — the workspace being left painted over the one arriving,
 * dissolved off it. The trouble the dissolve used to have is that the arriving
 * picture is not still yet at the instant the dissolve starts: geometry a
 * hidden layer could not take — a composer's line box, a pane bar's controls
 * width, a sheet's clamps — lands in the frames after the swap, and the reader
 * watches it land THROUGH a half-transparent departing workspace.
 *
 * So the cover is held first and dissolved second, and this module is the rule
 * for when the holding stops. Pure, on `arrival-reveal.ts`'s model, so the
 * rule can be tested without a deck — and, since a covered harness window
 * suspends `requestAnimationFrame`, so the quiet path has a proof that does
 * not depend on any window being uncovered.
 *
 * Three inputs and one shape ([B02], Spec S01): the cover lifts at the first
 * of the arriving picture going QUIET — no settle in flight and no
 * layout-affecting write under the arriving layer for {@link QUIET_FRAMES}
 * consecutive animation frames — or the BOUND expiring, so a workspace whose
 * content never settles cannot hold the cover hostage.
 *
 * **What `silentFrames` must be silent about** is settled by the recording in
 * `briefs/workspace-switch-quiet-recording.md` rather than by the re-arm table
 * taken on faith, which is the whole reason the recording came first. It named
 * three sources and ruled two out: pane rects under the arriving layer (the
 * only thing that produced visible motion), a settle in flight, and the
 * arrival of any further commit — because a first show produced four
 * post-swap commits over about 100ms and a counter watching rects alone could
 * call quiet in the gap between two of them. Clamps and scrollers contributed
 * nothing measurable and are deliberately not composed in.
 *
 * @module lib/space-quiet
 */

/**
 * How long the cover may be held before it dissolves over whatever the
 * arriving workspace has, in milliseconds ([B06], [P03]).
 *
 * A liveness bound, not a settling estimate. It is unconditional: whatever the
 * other two inputs say, the cover comes off here, because the cover is a
 * mechanism that decides visibility and a visibility mechanism that can wait
 * forever is the defect [L32] is about.
 *
 * Pinned at 200 from two directions. The CEILING is the eye, borrowed from
 * {@link ARRIVAL_REVEAL_BOUND_MS}'s own argument: a surface that sits still
 * for a quarter second after the gesture reads as the gesture landing. A
 * switch's wait is ADDED to the dissolve that follows it, so the two together
 * have to stay under that quarter second — which is why this is 200 and not
 * 250. The FLOOR is what the recording measured the arriving layer actually
 * writing: the composer's line box lands at 73ms and the last pane rect at
 * 116ms, both inside 200 with room. At 100 the bound would expire before the
 * writes it exists to cover, and the hold would buy nothing.
 */
export const SPACE_QUIET_BOUND_MS = 200;

/**
 * How many consecutive silent animation frames count as quiet.
 *
 * Two — "a frame or two with no settle in flight and no re-measure landing",
 * which is [B02]'s own phrasing. The recording is what says two is a real bar
 * rather than a formality: the gaps inside a first show's commit train are
 * tens of milliseconds, which is several frames, so a train that is still
 * running cannot clear two silent frames by accident — but it is also a bar
 * that train's gaps COULD clear, and that is the number's known weakness.
 *
 * If a gate is ever observed releasing early on a first show, this is the
 * number to raise and the commit train is the reason to write beside it.
 */
export const QUIET_FRAMES = 2;

/** The facts {@link spaceDissolveDue} decides over. */
export interface SpaceQuietInput {
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
  /** {@link SPACE_QUIET_BOUND_MS} has elapsed since the swap commit. */
  boundElapsed: boolean;
}

/**
 * Whether the dissolve may begin.
 *
 * The bound releases unconditionally, whatever the other two say. Otherwise
 * due when nothing is settling AND the picture has been silent for
 * {@link QUIET_FRAMES} frames — both, because either alone is a half-answer: a
 * settle in flight is about to move frames whether or not this frame was
 * quiet, and a canvas with no settle on it can still be taking late geometry
 * from a layer that has just been shown.
 */
export function spaceDissolveDue(input: SpaceQuietInput): boolean {
  if (input.boundElapsed) return true;
  return input.settled && input.silentFrames >= QUIET_FRAMES;
}
