/**
 * Fold: a content pane shown whole or folded to its masthead ([P01]), and the
 * wall a split column becomes once one of its members is folded ([P06]).
 *
 * The pure pane-array writers — {@link panesWithFolded},
 * {@link panesWithWallFolded}, and the {@link columnIsWall} predicate — are the
 * whole of what a fold commit decides. {@link setPaneFolded} is the gesture
 * that composes them and commits, over a {@link FoldDeps} the `DeckManager`
 * builds from its imposition deps; the manager keeps its `setPaneFolded` and
 * `setCardFolded` methods and calls these.
 */

import type { TugPaneState } from "./layout-tree";
import type { ImpositionDeps } from "./layout-imposition";
import { columnDrawsSplit, deckColumnsOf } from "./deck-store-selectors";
import { mark as perfMark } from "@/lib/perf-marks";

/**
 * The pane array a fold commit writes: `paneId`'s entry carries
 * `folded: true`, or has the key DELETED on `false`.
 *
 * Deleted rather than written `false` because the field's contract is
 * absent-means-not-folded ([P01]) — a persisted `folded: false` would
 * be a second spelling of the resting state, and the two would then have to
 * agree forever. The array is returned by IDENTITY when nothing changes, so
 * the caller can short-circuit its commit on `panes === state.panes` rather
 * than diffing.
 *
 * Pure and exported for the same reason `sweepImposition` is: it is the
 * whole of what the commit decides, and it is testable without a DeckManager.
 * The rail refusal is NOT here — it needs the card registry — and neither is
 * the wall's membership, which needs the imposition; see
 * {@link panesWithWallFolded}, which this composes with.
 */
export function panesWithFolded(
  panes: readonly TugPaneState[],
  paneId: string,
  folded: boolean,
): readonly TugPaneState[] {
  const pane = panes.find((p) => p.id === paneId);
  if (!pane) return panes;
  if ((pane.folded === true) === folded) return panes;
  return panes.map((p) => {
    if (p.id !== paneId) return p;
    if (folded) return { ...p, folded: true as const };
    const { folded: _dropped, ...rest } = p;
    return rest;
  });
}

/**
 * Whether a column is a WALL: some member other than `openPaneId` is folded.
 *
 * The definition [P06] rests on, and separate from {@link panesWithWallFolded}
 * because the two questions come apart. A wall whose siblings are ALREADY
 * folded needs no fold — that helper answers by identity — but it is still a
 * wall, and opening a card in it still owes the reveal. Gating the reveal on
 * the fold having changed something is exactly the bug this predicate exists
 * to prevent: the common case, opening a second card in a settled wall, is
 * the one where nothing needs folding.
 */
export function columnIsWall(
  panes: readonly TugPaneState[],
  openPaneId: string,
  memberIds: readonly string[],
): boolean {
  const members = new Set(memberIds);
  members.delete(openPaneId);
  if (members.size === 0) return false;
  return panes.some((p) => members.has(p.id) && p.folded === true);
}

/**
 * The pane array a WALL OPEN writes: every other member of the column folded,
 * so the wall stays a wall ([P06]).
 *
 * A wall is a split column with at least one FOLDED member. Opening a card
 * in one folds its siblings, because the whole shape rests on a wall having
 * exactly one card being read at a time — a second open card takes the run the
 * first one needs and the wall stops being legible as a wall.
 *
 * The guard is the definition: a split column with no folded member is not
 * a wall, it is two or three full sessions sharing a slot, and a fold there
 * would take away a division the user made with the seams. So `memberIds` is
 * checked for another folded member first, and the array comes back by
 * IDENTITY when there is none.
 *
 * `openPaneId` is expected to be already open in `panes` — this composes after
 * {@link panesWithFolded}, which is what cleared its flag.
 */
export function panesWithWallFolded(
  panes: readonly TugPaneState[],
  openPaneId: string,
  memberIds: readonly string[],
): readonly TugPaneState[] {
  if (!columnIsWall(panes, openPaneId, memberIds)) return panes;
  const members = new Set(memberIds);
  members.delete(openPaneId);
  const toFold = panes.filter(
    (p) => members.has(p.id) && p.folded !== true,
  );
  if (toFold.length === 0) return panes;
  const foldIds = new Set(toFold.map((p) => p.id));
  return panes.map((p) =>
    foldIds.has(p.id) ? { ...p, folded: true as const } : p,
  );
}

/** What the fold gesture reaches on the manager. */
export interface FoldDeps
  extends Pick<ImpositionDeps, "deck" | "clearBullseyeFor" | "placeRunHeight" | "commitImposition"> {
  /** The sidebar component a pane hosts, if it is a rail. */
  sidebarComponentIdOfPane(paneId: string): string | undefined;
  /** The column scroll that puts an opened wall card under its neighbour. */
  wallRevealFor(
    paneId: string,
    panes: readonly TugPaneState[],
    slot: number,
  ): { slot: number; offset: number } | undefined;
  /** Publish the gesture origin the settle's frame record measures from. */
  stampGesture(at: number): void;
}

/**
 * Fold or show one content pane.
 *
 * The flag is the pane's ([P01]): a pane is one box shared by its tabs, and
 * folded describes the box. This is the one writer, and it lands in ONE
 * commit — the flag, the bullseye clear, and the reveal together — because
 * the settle is FLIP and a gesture that notifies twice offers that
 * measurement a half-changed deck the first time. Same reasoning as
 * `setCardWidths`, and the same `retuneRails: false`: folding a
 * card never mentioned the rails, so it may not spend the user's rail width
 * on a re-solve.
 *
 * A sidebar pane is refused with a warning, as `_setPaneWidth` refuses one:
 * a rail's height is the allocator's and it wears no masthead to fold
 * into.
 *
 * Showing a card in a WALL folds its siblings ([P06]) and scrolls the column
 * to put the opened card under its neighbour above ([B07]) — both in the
 * same commit, for the same one-notify reason. A split column with nothing
 * folded in it is not a wall and is left alone.
 */
export function setPaneFolded(deps: FoldDeps, paneId: string, folded: boolean): void {
  // The gesture origin the settle's frame record measures from ([P02]).
  // Taken HERE so the number contains the mutator's own preamble — the
  // `placeRunHeight`, the `deckColumnsOf` and the wall fold below are all
  // time the user waited through — and published only at the commit, so
  // none of the three refusals between here and there leaves a stamp behind
  // for the next settle to read as its own.
  const gestureAt = performance.now();
  // The bench's origin for the fold's PREAMBLE ([B08]). `tug:arm-end` is
  // the canvas arming, and everything before it on a fold read as an
  // unattributed 11–12 ms on the click-task timeline: the mutator's own
  // work, the commit, and the deferred notify all landed in one anonymous
  // stretch. A mark at the entry gives that stretch a left edge, so the
  // gap can be split into "before the store wrote" and "after it did".
  perfMark("tug:set-pane-folded");
  const deck = deps.deck();
  const pane = deck.panes.find((p) => p.id === paneId);
  if (!pane) return;
  if (deps.sidebarComponentIdOfPane(paneId) !== undefined) {
    console.warn(
      `setPaneFolded: pane "${paneId}" hosts a sidebar card; rails do not fold`,
    );
    return;
  }

  let panes = panesWithFolded(deck.panes, paneId, folded);
  // Identity means the pane already read the way it was asked to read.
  if (panes === deck.panes) return;

  // Opening into a wall: fold the siblings, and take the reveal off the new
  // panes rather than the old ones — the strip this scrolls is the one the
  // fold just made, and computing it from the pre-fold heights would land
  // the column at a coordinate that no longer exists.
  let columnReveal: { slot: number; offset: number } | undefined;
  if (!folded) {
    const run = deps.placeRunHeight("column");
    const column = deckColumnsOf(
      { ...deck, panes },
      run > 0 ? run : null,
    ).find((c) => c.members.includes(paneId));
    if (column !== undefined && columnDrawsSplit(column)) {
      // The reveal is owed by the WALL, not by the fold: a settled wall
      // whose siblings are already folded has nothing to write and still
      // has to scroll.
      if (columnIsWall(panes, paneId, column.members)) {
        panes = panesWithWallFolded(panes, paneId, column.members);
        columnReveal = deps.wallRevealFor(paneId, panes, column.slot);
      }
    }
  }

  // The pane's height changes, so its bullseye ends — honored explicitly
  // because this path builds its pane array inline and hands it to
  // `commitImposition`, bypassing `movePane`.
  deps.clearBullseyeFor(paneId);
  deps.stampGesture(gestureAt);
  deps.commitImposition(deps.deck().imposition, panes, {
    retuneRails: false,
    revealPaneId: paneId,
    ...(columnReveal !== undefined ? { columnReveal } : {}),
  });
}

/**
 * The card-addressed twin of {@link setPaneFolded}: resolve the hosting
 * pane and fold that. This is what the action handler calls, because
 * every door to fold — the control, the menu item, the chord —
 * knows which card it is about and not which pane holds it.
 */
export function setCardFolded(deps: FoldDeps, cardId: string, folded: boolean): void {
  const pane = deps.deck().panes.find((p) => p.cardIds.includes(cardId));
  if (!pane) return;
  setPaneFolded(deps, pane.id, folded);
}
