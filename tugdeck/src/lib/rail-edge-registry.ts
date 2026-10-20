/**
 * rail-edge-registry — the rail width drag a card's own page starts.
 *
 * A rail card that draws its chrome in its own page takes the press on its
 * edge grip there, and the host tracks the pointer (`cardGesture` of kind
 * `rail`). The drag is still the rail's draft, owned by `DeckCanvas`
 * (`rail-width-draft.ts`): every member of the side moves with the hand and
 * the release commits one `setRailWidth`. So the host moves no view; it
 * reports the pointer, and the shell hands each report to the driver the
 * rail's stand-in pane registered here, which opens the draft against the
 * stand-in's own frame. The card's view follows its stand-in's placement, as
 * every card's does.
 *
 * @module lib/rail-edge-registry
 */

/** The four calls of a rail width drag, addressed by viewport points. */
export interface RailEdgeDriver {
  /** The press, at the point it landed. */
  begin(clientX: number, clientY: number): void;
  change(clientX: number, clientY: number, altKey: boolean): void;
  commit(clientX: number, altKey: boolean): void;
  /** A no-op when no drag is open. */
  cancel(): void;
}

const drivers = new Map<string, RailEdgeDriver>();

/** Register the rail edge driver of the pane `paneId`; returns the release. */
export function registerRailEdgeDriver(paneId: string, driver: RailEdgeDriver): () => void {
  drivers.set(paneId, driver);
  return () => {
    if (drivers.get(paneId) === driver) drivers.delete(paneId);
  };
}

/** The rail edge driver of the pane `paneId`, or null when it is not a pinned rail's. */
export function railEdgeDriverOf(paneId: string): RailEdgeDriver | null {
  return drivers.get(paneId) ?? null;
}
