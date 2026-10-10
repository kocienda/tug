/**
 * Test-mode state seeding ([D02]): the entry point a harness uses to install
 * a whole deck in one commit.
 *
 * Not a production path. The `DeckManager` keeps `seedDeckState` by name, so
 * the harness and the unit tests that call it do not change, and delegates
 * here; this module holds the work, reaching the manager through
 * {@link TestSeedDeps}.
 */

import type { CardStateBag, DeckState } from "./layout-tree";
import { CARDS_CARD_ID } from "./lib/cards-card-id";
import { DEFAULT_IMPOSITION_KIND, DEFAULT_SIDEBAR_SIDE } from "./lib/layout-imposer";

export interface SeedDeckStateArgs {
  state: DeckState;
  cardStates?: Map<string, CardStateBag>;
  focusCardId?: string;
}

/** What a seed reaches on the manager. */
export interface TestSeedDeps {
  /** Reap the departing figures, so nothing from the old deck composes in. */
  reapDepartures(): void;
  deck(): DeckState;
  setDeck(state: DeckState): void;
  reflectAppActive(active: boolean): void;
  /** Seed a bag into the card-state cache without marking it dirty. */
  seedCardState(cardId: string, bag: CardStateBag): void;
  notifyCardDidFinishConstruction(cardId: string): void;
  discardComponentStateRegistry(cardId: string): void;
  notify(caller: string): void;
  activateCard(cardId: string): void;
}

/**
 * Replace the current `DeckState` atomically, merge per-card state
 * bags into the in-memory cache, and optionally activate a focused
 * card. The single source of state for a test-mode session ([D02]):
 * harness authors describe the desired axis state; this installs it in
 * one commit.
 *
 * Semantics:
 * - The deck is replaced with `args.state` verbatim (no merge with the
 *   previous state). The caller is responsible for passing a fully-formed
 *   `DeckState`.
 * - The space list is untouched: a seed replaces the ACTIVE space's deck,
 *   and every parked space stays where it is. A manager holding one space
 *   keeps that space's id, so a seed does not look like a new workspace to
 *   anything reading the list.
 * - `args.cardStates` (if present) is merged into the card-state cache;
 *   existing entries for other card ids are preserved so repeated
 *   `seedDeckState` calls can layer state.
 * - `args.focusCardId` (if present) drives the cold-boot restore
 *   path — `activateCard(id)` runs after the state commit when the
 *   card exists in the new state.
 *
 * Callable in non-test-mode too so harness-authored scenarios can
 * exercise the same entry point inside unit tests that don't
 * construct a whole bridge. The I/O guards elsewhere ensure a
 * non-test-mode caller still routes writes to tugbank normally —
 * `seedDeckState` itself issues no tugbank I/O.
 *
 * Subscribers are notified exactly once, at the end of the commit;
 * `useSyncExternalStore` consumers see a single state transition, not a
 * series of partial ones.
 */
export function seedDeckState(deps: TestSeedDeps, args: SeedDeckStateArgs): void {
  // A seed replaces the deck whole, so nothing departing from the old one
  // may be composed into it.
  deps.reapDepartures();

  // Clear construction lifecycle memory for cards that are leaving
  // the deck so a later `seedDeckState` call that re-introduces an
  // id does not double-fire construction. Fresh-card construction
  // below picks up the id set that resulted from the replace.
  const previousCardIds = new Set(deps.deck().cards.map((c) => c.id));
  const nextCardIds = new Set(args.state.cards.map((c) => c.id));

  // Atomic state replace: one assignment, one notify, one snapshot
  // transition for useSyncExternalStore consumers. hasFocus is
  // session-only — the caller supplies it in `args.state`.
  //
  // The state arrives as JSON across the test bridge, so its type is a
  // claim rather than a guarantee: a seed that predates `imposition`
  // omits it. Fill the default rather than letting `undefined` reach the
  // render, the same posture `deserialize` takes at the wire boundary.
  deps.setDeck({
    ...args.state,
    imposition: args.state.imposition ?? {
      kind: DEFAULT_IMPOSITION_KIND,
      sidebars: { [CARDS_CARD_ID]: { side: DEFAULT_SIDEBAR_SIDE } },
    },
  });

  // Re-project the seeded `hasFocus` onto `data-app-active`. The
  // constructor seeds the DOM bit from `document.hasFocus()`, but a
  // seed supplies its own `hasFocus` (tests typically `true`); without
  // this the projection stays stuck at the construction-time reading,
  // leaving `data-app-active` out of sync with `deckState.hasFocus`.
  // `setHasFocus` can't recover it (it early-returns when the value is
  // unchanged), so the focus-language ring on a foregrounded seed would
  // stay quiet. Reflect here so the DOM matches the seeded state.
  deps.reflectAppActive(deps.deck().hasFocus);

  if (args.cardStates) {
    for (const [cardId, bag] of args.cardStates) {
      deps.seedCardState(cardId, bag);
    }
  }

  // Fire construction for every card that just entered the deck so
  // lifecycle subscribers' `constructedCards` set matches reality
  // (mirrors the constructor's post-load fan-out in the normal boot
  // path).
  for (const card of args.state.cards) {
    if (!previousCardIds.has(card.id)) {
      deps.notifyCardDidFinishConstruction(card.id);
    }
  }

  // Discard per-card component state preservation registries for
  // cards that left the deck so closures don't outlive the card.
  // Explicit cleanup, symmetric with `_removeCard` / `_closePane`.
  for (const prevId of previousCardIds) {
    if (!nextCardIds.has(prevId)) {
      deps.discardComponentStateRegistry(prevId);
    }
  }

  deps.notify("seedDeckState");

  // Cold-boot restore: after the state commit, activate the
  // requested focus card. `activateCard` is the single entry point
  // for z-order + lifecycle + responder-chain updates ([D03]).
  if (args.focusCardId !== undefined) {
    const exists = deps.deck().cards.some((c) => c.id === args.focusCardId);
    if (exists) {
      deps.activateCard(args.focusCardId);
    }
  }
}
