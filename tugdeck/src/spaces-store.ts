/**
 * The spaces store: the level above the deck ([P03]), and the deck's second
 * `useSyncExternalStore` contract ([L02]).
 *
 * Owns the ordered list of spaces, which one is active, which ones React holds
 * mounted, and the snapshot the Workspaces surfaces read. It does not own the
 * ACTIVE space's deck: that record carries `deck: null`, and the live deck is
 * the `DeckManager`'s `deckState` — so every reader that needs it is handed it
 * (`liveDeck`) rather than this store keeping a copy that would go stale on the
 * first pane move.
 *
 * What lives here is the list and the mutations that touch only the list —
 * rename, reorder, theme, add, remove. The gestures that also move a deck in
 * or out of `deckState` (activate, create, delete, move a card between spaces)
 * stay on the manager, which edits the records this store hands out and calls
 * {@link SpacesStore.notify} at the point its commit needs subscribers told.
 */

import type { DeckState } from "./layout-tree";
import { activeSpaceTheme, type SpaceRecord, type SpacesSnapshot, type SpacesState } from "./spaces";
import { preloadTheme } from "./contexts/theme-provider";

export class SpacesStore {
  /**
   * Every space this instance holds, in the user's order.
   *
   * `deck` is `null` for exactly one entry — the ACTIVE one — whose live deck
   * is the manager's `deckState`. That is what keeps every existing mutator,
   * selector and law working unchanged: there is still one deck being rendered
   * and written to, and the others are parked data nothing renders ([B11]).
   */
  private records: SpaceRecord[] = [];

  /** Which entry in {@link records} is rendered. */
  private activeId = "";

  /**
   * The workspaces React is holding mounted ([P01], [B06]).
   *
   * A workspace joins on its first activation and never leaves except by
   * being deleted: a switch hides and shows rather than unmounting, so the
   * cost of returning to a workspace the user has already visited is a style
   * change rather than a rebuild of every card in it. The boot workspace is
   * seeded here because it is mounted without anybody activating it.
   *
   * There is deliberately no eviction policy: [B07] deferred one, and a
   * budget nobody has measured a need for is a guess with a knob on it.
   */
  private mounted: Set<string> = new Set();

  /** Subscribers to the spaces store — the list's shape, not the decks. */
  private subscribers: Set<() => void> = new Set();

  /**
   * The last {@link SpacesSnapshot} handed out, rebuilt only when the list
   * changes. `useSyncExternalStore` compares by identity and would loop
   * forever on a snapshot minted per read, so this cache is the contract
   * rather than an optimisation ([L02]).
   */
  private snapshotCache: SpacesSnapshot | null = null;

  // ---- The useSyncExternalStore contract ----

  /**
   * Subscribe to changes in the SPACE LIST — a space added, renamed, removed,
   * reordered, or activated. Not to changes inside a deck: those are the deck
   * store's, and a Workspaces-card row that re-rendered on every pane move
   * would be paying for a fact it does not draw.
   */
  subscribe = (callback: () => void): (() => void) => {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  };

  /**
   * The space list's identities and order, plus which is active. Stable by
   * identity until the list changes — see {@link snapshotCache}.
   */
  getSnapshot = (): SpacesSnapshot => {
    if (this.snapshotCache === null) {
      const mountedSpaceIds = this.records
        .filter((s) => this.mounted.has(s.id))
        .map((s) => s.id);
      const mountedDecks = new Map<string, DeckState>();
      for (const space of this.records) {
        // The active space's deck is the live one and is not cached here —
        // see {@link SpacesSnapshot}.
        if (space.deck === null) continue;
        if (!this.mounted.has(space.id)) continue;
        mountedDecks.set(space.id, space.deck);
      }
      this.snapshotCache = {
        spaces: this.records.map((s) => ({
          id: s.id,
          name: s.name,
          ...(s.theme !== undefined ? { theme: s.theme } : {}),
        })),
        activeSpaceId: this.activeId,
        mountedSpaceIds,
        mountedDecks,
      };
    }
    return this.snapshotCache;
  };

  /**
   * Drop the cached snapshot and tell the subscribers. Called by every
   * mutation of the list — and by nothing else, because a rebuild with no
   * change would hand React a new identity for the same list.
   */
  notify(): void {
    this.snapshotCache = null;
    for (const callback of this.subscribers) callback();
  }

  // ---- Reads ----

  /** The records, in order. Mutable records: the manager writes their decks. */
  get list(): readonly SpaceRecord[] {
    return this.records;
  }

  get activeSpaceId(): string {
    return this.activeId;
  }

  find(spaceId: string): SpaceRecord | undefined {
    return this.records.find((s) => s.id === spaceId);
  }

  indexOf(spaceId: string): number {
    return this.records.findIndex((s) => s.id === spaceId);
  }

  /** The active space's record, or `undefined` before the boot seed. */
  active(): SpaceRecord | undefined {
    return this.find(this.activeId);
  }

  /** The theme the active workspace wears, if it names one. */
  activeTheme(): string | undefined {
    return activeSpaceTheme({ spaces: this.records, activeSpaceId: this.activeId });
  }

  /**
   * Which space holds `cardId`, reading `liveDeck` for the active one, or
   * `null` when no space does.
   */
  spaceOf(cardId: string, liveDeck: DeckState): string | null {
    for (const space of this.records) {
      const deck = space.deck ?? liveDeck;
      if (deck.cards.some((c) => c.id === cardId)) return space.id;
    }
    return null;
  }

  /** The deck of any space; the active one answers with `liveDeck`. */
  deckOf(spaceId: string, liveDeck: DeckState): DeckState | null {
    const space = this.find(spaceId);
    if (space === undefined) return null;
    return space.deck ?? liveDeck;
  }

  /** Every card id across every space, the active one read from `liveDeck`. */
  allCardIds(liveDeck: DeckState): Set<string> {
    const ids = new Set<string>();
    for (const space of this.records) {
      const deck = space.deck ?? liveDeck;
      for (const card of deck.cards) ids.add(card.id);
    }
    return ids;
  }

  /**
   * Every space as a persistable record, with the active one's `deck` taken
   * from `liveDeck` — the one place it lives.
   */
  persistable(liveDeck: DeckState): SpacesState {
    return {
      spaces: this.records.map((space) => ({
        id: space.id,
        name: space.name,
        deck: space.deck ?? liveDeck,
        ...(space.focusedCardId !== undefined
          ? { focusedCardId: space.focusedCardId }
          : {}),
        ...(space.theme !== undefined ? { theme: space.theme } : {}),
      })),
      activeSpaceId: this.activeId,
    };
  }

  // ---- Mutations ----

  /** Seed the list from the boot layout; the active space is the one mounted. */
  seed(records: SpaceRecord[], activeSpaceId: string): void {
    this.records = records;
    this.activeId = activeSpaceId;
    this.mounted = new Set([activeSpaceId]);
    this.notify();
  }

  /**
   * Make `spaceId` the active space and mount it ([P01]). The caller has
   * already parked the outgoing deck and cleared the incoming one; this
   * notifies, so it runs inside the caller's commit.
   */
  activate(spaceId: string): void {
    this.activeId = spaceId;
    this.mounted.add(spaceId);
    this.notify();
  }

  /** Insert `record` at `index` (default: the end). */
  insert(record: SpaceRecord, index = this.records.length): void {
    this.records.splice(index, 0, record);
    this.notify();
  }

  /** Remove `spaceId` from the list and from the mounted set. */
  remove(spaceId: string): void {
    const index = this.indexOf(spaceId);
    if (index === -1) return;
    this.records.splice(index, 1);
    this.mounted.delete(spaceId);
    this.notify();
  }

  /**
   * Rename a workspace. Trims; refuses a name that is empty after trimming,
   * because a row with no name is a row nobody can address. Returns whether
   * the name changed.
   */
  rename(spaceId: string, name: string): boolean {
    const space = this.find(spaceId);
    if (space === undefined) {
      console.warn(`renameSpace: no space with id "${spaceId}"`);
      return false;
    }
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === space.name) return false;
    space.name = trimmed;
    this.notify();
    return true;
  }

  /**
   * Record the theme a workspace wears. Writes the record and nothing else:
   * putting a theme on screen is the theme provider's work. Returns whether
   * the record changed.
   */
  setTheme(spaceId: string, theme: string): boolean {
    const space = this.find(spaceId);
    if (space === undefined) {
      console.warn(`setSpaceTheme: no space with id "${spaceId}"`);
      return false;
    }
    if (space.theme === theme) return false;
    space.theme = theme;
    preloadTheme(theme);
    this.notify();
    return true;
  }

  /**
   * Give every workspace the active workspace's theme. Returns whether any
   * record changed; a no-op when they all already wear it.
   */
  applyActiveThemeToAll(): boolean {
    const theme = this.activeTheme();
    if (theme === undefined) return false;
    let changed = false;
    for (const space of this.records) {
      if (space.theme === theme) continue;
      space.theme = theme;
      changed = true;
    }
    if (!changed) return false;
    this.notify();
    return true;
  }

  /**
   * Put the workspaces in `order`.
   *
   * Ids the list does not hold are ignored, and spaces `order` does not
   * mention keep their current relative order at the end — so a drag that
   * names only the rows it moved is a complete instruction, and a stale order
   * from a surface that has not seen a new workspace yet cannot lose it.
   */
  reorder(order: readonly string[]): void {
    const byId = new Map(this.records.map((s) => [s.id, s]));
    const next: SpaceRecord[] = [];
    const seen = new Set<string>();
    for (const id of order) {
      const space = byId.get(id);
      if (space === undefined || seen.has(id)) continue;
      seen.add(id);
      next.push(space);
    }
    for (const space of this.records) {
      if (!seen.has(space.id)) next.push(space);
    }
    this.records = next;
    this.notify();
  }

  /**
   * Record the focused card on the ACTIVE space. Returns whether it changed —
   * the caller schedules the save. Not a list change, so no notify: the
   * snapshot does not carry focus.
   */
  setActiveFocusedCard(focusedCardId: string): boolean {
    const space = this.active();
    if (space === undefined) return false;
    if (space.focusedCardId === focusedCardId) return false;
    space.focusedCardId = focusedCardId;
    return true;
  }
}
