/**
 * list-view-reveal — the hidden-box cycle's memory.
 *
 * Internal building block — app code uses `TugListView` instead. It sits
 * here beside `smart-scroll.ts` rather than under the component's
 * `internal/` because `SmartScroll` is the whole of what it talks to: the
 * policy is about a scroller losing and regaining its box, and the list
 * view is only the component that happens to own one.
 *
 * A scroller can lose its box without unmounting: `display: none` is
 * what an inactive card tab sits in, and what a folded Session card's
 * view slot sits in. The browser resets `scrollTop` to 0 when the box is
 * destroyed and nobody is told, so the reveal — the `0 → real`
 * transition on the way back — lands the list at the top with its
 * follow-bottom intent released. The user's position, and the intent
 * behind it, are lost across a fold nothing unmounted.
 *
 * This module is the memory that cycle was missing. It holds two
 * moments:
 *
 *   - {@link RevealSeam.noteBoxLost} — the box is gone. `scrollTop`
 *     already reads 0 by the time any observer can fire, so the memo is
 *     taken from the caller's last sample while the scroller was still
 *     visible, never from the live scroller.
 *   - {@link RevealSeam.noteRevealed} — the box is back. Re-apply:
 *     `scrollToBottom` when the list was following the live edge,
 *     the remembered position otherwise.
 *
 * Both moments are bracketed with `noteExternalWrite`. The reveal's own
 * clamp event arrives deferred, carrying a large upward delta against an
 * unchanged `scrollHeight` — the exact shape `SmartScroll`'s
 * `unattributed-scroll-up` rule reads as a user gesture, which would
 * release follow-bottom a frame after the restore re-engaged it. The
 * bracket syncs the scroll baseline to the position that was actually
 * written, so the deferred event arrives with no delta and never reaches
 * that rule. The rule's own comment prescribes this defence; the fold
 * simply never used it.
 *
 * A non-following position is re-applied as a **restore target**, not as
 * a one-shot `scrollTop` write. A session keeps streaming while it is
 * folded, so cells above the remembered position can change height
 * while the box is gone and a raw pixel offset is stale by exactly that
 * much. The caller supplies an anchor resolver when it can build one
 * (the same instrument the region-scroll restore rides); the pixel offset
 * is the fallback for a list with no anchorable content. Either way the
 * target rides the list view's per-commit `applyRestoreTarget`
 * heartbeat, so the position keeps landing as the revealed cells
 * re-measure.
 *
 * The reveal carries one other repair. A subtree with no box runs no
 * animations, and the engine does not necessarily replay them when the
 * box comes back — an in-flight wave in a transcript cell comes back
 * sitting motionless in its rest pose, which reads as a turn that
 * stopped. So the seam cancels and replays every LOOPING animation under
 * the revealed root. A loop is the only kind it touches: an infinite
 * animation that was hidden is by definition mid-cycle and has nothing
 * to lose by starting over, while a finite one either finished while
 * hidden or is a transition somebody else owns.
 *
 * Laws: non-React. Every write is a DOM scroll write inside
 * `SmartScroll`, and the animation replay is appearance written to the
 * DOM, never React state ([L06]); the loops themselves stay CSS
 * `@keyframes` ([L13]). The position preserved across the hidden cycle
 * is [L23]'s concern.
 */

/** The scroll state sampled while the scroller still had a box. */
export interface VisibleScrollSample {
  /** `scrollTop` at the sample. */
  top: number;
  /** `smartScroll.isFollowingBottom` at the sample. */
  following: boolean;
}

/** The `SmartScroll` surface this seam uses — the whole of its contract. */
export interface RevealScroll {
  scrollToBottom(animated?: boolean): void;
  setRestoreTarget(
    resolver: () => number | null,
    opts?: { suspendDriftSupersede?: boolean },
  ): void;
  applyRestoreTarget(): void;
  noteExternalWrite(): void;
}

/**
 * What the reveal did. `none` means nothing was remembered — the
 * scroller never had a visible sample to lose, so there is nothing to
 * put back. `anchored` and `positioned` both install a restore target
 * and differ only in the resolver behind it.
 */
export type RevealOutcome = "none" | "followed" | "anchored" | "positioned";

export interface RevealSeamOptions {
  /** The live `SmartScroll`, or `null` before mount / after dispose. */
  getScroll: () => RevealScroll | null;
  /**
   * The subtree whose looping animations the reveal replays — the
   * scroller itself, for a list whose cells carry in-flight glyphs.
   * Omitted, the reveal restores the position and nothing else.
   */
  getRevealRoot?: () => Element | null;
  /**
   * The last sample taken while the scroller had a box. Read at the box
   * loss, when the live scroller can no longer answer.
   */
  getLastVisible: () => VisibleScrollSample | null;
  /**
   * An anchor resolver for the remembered position, or `null` when the
   * list has nothing to anchor to. Built at the reveal so it resolves
   * against the data source as it is *now* — a folded session keeps
   * streaming, and the anchor's whole point is to survive that.
   */
  makeResolver?: () => (() => number | null) | null;
}

export interface RevealSeam {
  /** The scroller lost its box. Remember where it was. */
  noteBoxLost(): void;
  /** The scroller has a box again. Put it back. */
  noteRevealed(): RevealOutcome;
  /**
   * Drop the remembered position without applying it, for a memo that
   * has stopped meaning anything — the list's data source was swapped
   * while the box was gone, so the position belongs to content that is
   * no longer there.
   *
   * The hidden state is deliberately left standing: a scroller whose
   * data source changed behind a fold still has loops to replay when it
   * comes back, it simply has no position worth putting back.
   */
  forget(): void;
  /** The pending memo, for assertions and diagnostics. */
  readonly pending: VisibleScrollSample | null;
  /** True between a box loss and the reveal that answers it. */
  readonly isHidden: boolean;
}

/**
 * Cancel and replay every looping animation under `root`, and return how
 * many were replayed.
 *
 * This is the reveal's answer to a glyph that comes back motionless: the
 * loop's own element still carries the CSS rule that declares it, so a
 * `cancel()` followed by a `play()` starts the declared animation over
 * rather than removing it. It is idempotent on a loop that is genuinely
 * still running — the wave restarts at its 0% keyframe, which is the
 * pose its bars are seeded at, so a needless replay is invisible.
 *
 * Only infinite iterations qualify. A finite animation that ran out
 * while the box was gone has finished, and replaying it would show the
 * user a completion they already missed; a transition belongs to
 * whatever wrote the style that provoked it.
 *
 * Returns 0 where `getAnimations` is unavailable, which is the honest
 * answer rather than a thrown error: an engine that cannot enumerate
 * animations cannot have stalled one either.
 */
export function replayLoopingAnimations(root: Element | null): number {
  if (root === null) return 0;
  const enumerable = root as Element & {
    getAnimations?: (options?: { subtree?: boolean }) => Animation[];
  };
  if (typeof enumerable.getAnimations !== "function") return 0;
  let replayed = 0;
  for (const animation of enumerable.getAnimations({ subtree: true })) {
    const timing = animation.effect?.getTiming();
    if (timing === undefined || timing.iterations !== Number.POSITIVE_INFINITY) {
      continue;
    }
    animation.cancel();
    animation.play();
    replayed += 1;
  }
  return replayed;
}

export function createRevealSeam(options: RevealSeamOptions): RevealSeam {
  let memo: VisibleScrollSample | null = null;
  let hidden = false;

  return {
    noteBoxLost(): void {
      const ss = options.getScroll();
      // Already noted. A hidden scroller can deliver more than one
      // zero-box resize (a pane resize behind a folded card fires the
      // observer again), and the second delivery must not overwrite the
      // first: the sample source stops updating the moment the box is
      // gone, so a re-read is at best the same value and at worst a
      // sample taken after something else moved.
      if (hidden) return;
      hidden = true;
      const sample = options.getLastVisible();
      if (sample !== null) memo = { top: sample.top, following: sample.following };
      // The clamp that destroyed the position has already landed by the
      // time any observer runs. Attribute it, so its deferred scroll
      // event is not read as the user scrolling up and away from the
      // live edge while the card is not even on screen.
      ss?.noteExternalWrite();
    },

    noteRevealed(): RevealOutcome {
      // Only a box that was lost can be revealed. Every other resize
      // delivery — a pane drag, a card growing — reaches here too, and
      // replaying a transcript's animations on each one would be a
      // stutter nobody asked for.
      if (!hidden) return "none";
      hidden = false;
      // Before the position, because a glyph that is visibly stuck is
      // the more legible defect and it costs nothing to fix first.
      replayLoopingAnimations(options.getRevealRoot?.() ?? null);
      const remembered = memo;
      memo = null;
      if (remembered === null) return "none";
      const ss = options.getScroll();
      if (ss === null) return "none";
      if (remembered.following) {
        // Re-engages follow-bottom and lands exactly at the live edge,
        // which is what keeps the jump-to-bottom affordance hidden.
        ss.scrollToBottom(false);
        ss.noteExternalWrite();
        return "followed";
      }
      const resolver = options.makeResolver?.() ?? null;
      // `setRestoreTarget` disengages follow-bottom deliberately, which
      // is correct here: the remembered intent was not to follow.
      // `suspendDriftSupersede` — the reveal's own reflow is what moves
      // `scrollTop`, so reading that motion as an unattributable actor
      // would cancel the restore it is the reason for. A real gesture
      // still supersedes.
      const top = remembered.top;
      ss.setRestoreTarget(resolver ?? (() => top), {
        suspendDriftSupersede: true,
      });
      ss.applyRestoreTarget();
      ss.noteExternalWrite();
      return resolver === null ? "positioned" : "anchored";
    },

    forget(): void {
      memo = null;
    },

    get pending(): VisibleScrollSample | null {
      return memo === null ? null : { top: memo.top, following: memo.following };
    },

    get isHidden(): boolean {
      return hidden;
    },
  };
}
