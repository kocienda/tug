/**
 * cards-space-expansion.ts — which workspaces the Cards card has folded shut.
 *
 * **A glance, not an arrangement.** Folding a workspace shut is how a person
 * gets a long list out of the way while they work somewhere else — and that
 * is over when the window closes. So this is session-only and deliberately
 * unpersisted: a relaunch brings back every workspace expanded, which is the
 * list's own default and what a person opening a fresh window would expect
 * to see ([P09]).
 *
 * **The set holds COLLAPSED ids, and every workspace can be in it — the
 * active one included.** Expanded is the default, so an empty set means the
 * whole list is open; a workspace is folded exactly when its id is here. The
 * active workspace used to be excluded by a rule in the data source that made
 * its cue dead, and a person with one workspace had a fold cue that did
 * nothing ([B02]).
 *
 * A module store rather than component state: the Cards card can be closed and
 * reopened, and two of them can stand at once in different panes, and neither
 * of those should reset or diverge the reading. React reads it through
 * `useSyncExternalStore` ([L02]).
 *
 * @module components/cards/cards-space-expansion
 */

class CollapsedSpacesStore {
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

  /** Fold an open workspace's rows shut, or open a folded one's. */
  toggle = (spaceId: string): void => {
    const next = new Set(this.ids);
    if (!next.delete(spaceId)) next.add(spaceId);
    this.ids = next;
    this.notify();
  };

  /**
   * Drop every id not in `live` — the Cards card calls this when the spaces
   * snapshot changes, so a deleted workspace does not leave a collapsed entry
   * behind that a later workspace could inherit by reusing its id.
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

  /** Test seam: forget every fold, which is the everything-expanded default. */
  _resetForTest = (): void => {
    this.ids = new Set();
    this.listeners.clear();
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const collapsedSpacesStore = new CollapsedSpacesStore();
