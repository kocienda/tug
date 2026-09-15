/**
 * cards-space-expansion.ts — which inactive workspaces the Cards card is
 * showing the insides of.
 *
 * **A glance, not an arrangement.** Opening an inactive workspace's rows is
 * how a person checks what is over there before deciding to go — and a check
 * is over when the window closes. So this is session-only and deliberately
 * unpersisted: a relaunch brings back every workspace collapsed but the active
 * one, which is the state a person would have wanted anyway and the one the
 * list reads most clearly in ([P09]).
 *
 * The active workspace is not in here at all. It is always expanded, by the
 * data source's own rule, so an entry for it could only ever disagree with
 * that rule.
 *
 * A module store rather than component state: the Cards card can be closed and
 * reopened, and two of them can stand at once in different panes, and neither
 * of those should reset or diverge the reading. React reads it through
 * `useSyncExternalStore` ([L02]).
 *
 * @module components/cards/cards-space-expansion
 */

class ExpandedSpacesStore {
  private ids: ReadonlySet<string> = new Set();

  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable by identity until a toggle or a prune changes the set. */
  getSnapshot = (): ReadonlySet<string> => this.ids;

  /** Open a collapsed workspace's rows, or close an open one's. */
  toggle = (spaceId: string): void => {
    const next = new Set(this.ids);
    if (!next.delete(spaceId)) next.add(spaceId);
    this.ids = next;
    this.notify();
  };

  /**
   * Drop every id not in `live` — the Cards card calls this when the spaces
   * snapshot changes, so a deleted workspace does not leave an entry behind
   * that a later workspace could inherit by reusing its id.
   *
   * A no-op when nothing was stale, so the snapshot's identity holds and no
   * subscriber recomputes for a prune that pruned nothing.
   */
  prune = (live: ReadonlySet<string>): void => {
    let stale = false;
    for (const id of this.ids) {
      if (!live.has(id)) {
        stale = true;
        break;
      }
    }
    if (!stale) return;
    const next = new Set<string>();
    for (const id of this.ids) {
      if (live.has(id)) next.add(id);
    }
    this.ids = next;
    this.notify();
  };

  /** Test seam: forget every expansion. */
  _resetForTest = (): void => {
    this.ids = new Set();
    this.listeners.clear();
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const expandedSpacesStore = new ExpandedSpacesStore();
