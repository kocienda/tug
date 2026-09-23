/**
 * live-turns-store — the aggregate the *Stop work in flight* row derives from.
 *
 * The claims: it counts and names exactly the cards whose session says
 * `canInterrupt`, in deck order; it republishes when that answer moves and
 * stays reference-stable when it does not; it follows the card set, so a card
 * added mid-turn is seen and a card removed stops being heard from; and it
 * lets go of every subscription it took.
 *
 * The store is exercised through its context rather than through the deck, so
 * none of this needs a card, a wire or a session.
 */

import { describe, it, expect } from "bun:test";

import {
  LiveTurnsStore,
  NO_LIVE_TURNS,
  type LiveTurnSource,
} from "../live-turns-store";

/** A card standing in for one session, with a phase the test can move. */
class FakeCard {
  live = false;
  listeners = new Set<() => void>();
  /** Counts subscriptions taken and not yet released. */
  outstanding = 0;

  constructor(public title: string) {}

  setLive(live: boolean): void {
    this.live = live;
    for (const listener of [...this.listeners]) listener();
  }

  source(): LiveTurnSource {
    return {
      title: this.title,
      isLive: () => this.live,
      subscribe: (listener) => {
        this.listeners.add(listener);
        this.outstanding += 1;
        return () => {
          this.listeners.delete(listener);
          this.outstanding -= 1;
        };
      },
    };
  }
}

/** A deck the test can add to, remove from and rename. */
class FakeDeck {
  cards: FakeCard[] = [];
  private listeners = new Set<() => void>();

  context() {
    return {
      sources: () => this.cards.map((card) => card.source()),
      observeSources: (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
    };
  }

  changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

describe("live-turns-store: the answer", () => {
  it("is the empty answer when the deck is empty", () => {
    const store = new LiveTurnsStore(new FakeDeck().context());
    expect(store.getSnapshot()).toBe(NO_LIVE_TURNS);
    store.dispose();
  });

  it("counts and names only the cards mid-turn, in deck order", () => {
    const deck = new FakeDeck();
    const alpha = new FakeCard("alpha");
    const beta = new FakeCard("beta");
    const gamma = new FakeCard("gamma");
    deck.cards = [alpha, beta, gamma];

    const store = new LiveTurnsStore(deck.context());
    expect(store.getSnapshot()).toBe(NO_LIVE_TURNS);

    gamma.setLive(true);
    alpha.setLive(true);

    expect(store.getSnapshot()).toEqual({
      count: 2,
      titles: ["alpha", "gamma"],
    });
    store.dispose();
  });

  it("returns to the empty answer when the last turn ends", () => {
    const deck = new FakeDeck();
    const alpha = new FakeCard("alpha");
    deck.cards = [alpha];
    const store = new LiveTurnsStore(deck.context());

    alpha.setLive(true);
    expect(store.getSnapshot().count).toBe(1);
    alpha.setLive(false);
    expect(store.getSnapshot()).toBe(NO_LIVE_TURNS);
    store.dispose();
  });
});

describe("live-turns-store: [L02] reference stability", () => {
  it("returns the same snapshot across reads with nothing changed", () => {
    const deck = new FakeDeck();
    const alpha = new FakeCard("alpha");
    deck.cards = [alpha];
    const store = new LiveTurnsStore(deck.context());
    alpha.setLive(true);

    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.dispose();
  });

  it("does not republish when a card publishes without changing the answer", () => {
    const deck = new FakeDeck();
    const alpha = new FakeCard("alpha");
    const beta = new FakeCard("beta");
    deck.cards = [alpha, beta];
    const store = new LiveTurnsStore(deck.context());
    alpha.setLive(true);

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    const before = store.getSnapshot();

    // `beta` ticks without crossing `canInterrupt` — a streaming card
    // publishing a token is the everyday case.
    beta.setLive(false);
    alpha.setLive(true);

    expect(notifications).toBe(0);
    expect(store.getSnapshot()).toBe(before);
    store.dispose();
  });

  it("notifies once when the answer does move", () => {
    const deck = new FakeDeck();
    const alpha = new FakeCard("alpha");
    deck.cards = [alpha];
    const store = new LiveTurnsStore(deck.context());

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    alpha.setLive(true);
    expect(notifications).toBe(1);
    expect(store.getSnapshot()).toEqual({ count: 1, titles: ["alpha"] });
    store.dispose();
  });

  it("republishes on a rename, because the titles are part of the answer", () => {
    const deck = new FakeDeck();
    const alpha = new FakeCard("alpha");
    deck.cards = [alpha];
    const store = new LiveTurnsStore(deck.context());
    alpha.setLive(true);

    alpha.title = "alpha renamed";
    deck.changed();

    expect(store.getSnapshot()).toEqual({
      count: 1,
      titles: ["alpha renamed"],
    });
    store.dispose();
  });
});

describe("live-turns-store: following the card set", () => {
  it("sees a card that arrives already mid-turn", () => {
    const deck = new FakeDeck();
    const store = new LiveTurnsStore(deck.context());

    const late = new FakeCard("late");
    late.live = true;
    deck.cards = [late];
    deck.changed();

    expect(store.getSnapshot()).toEqual({ count: 1, titles: ["late"] });
    store.dispose();
  });

  it("stops counting a card that leaves mid-turn", () => {
    const deck = new FakeDeck();
    const alpha = new FakeCard("alpha");
    const beta = new FakeCard("beta");
    deck.cards = [alpha, beta];
    const store = new LiveTurnsStore(deck.context());
    alpha.setLive(true);
    beta.setLive(true);
    expect(store.getSnapshot().count).toBe(2);

    deck.cards = [beta];
    deck.changed();

    expect(store.getSnapshot()).toEqual({ count: 1, titles: ["beta"] });
    expect(alpha.outstanding).toBe(0);
    store.dispose();
  });
});

describe("live-turns-store: [L27] it lets go", () => {
  it("releases every card subscription on dispose", () => {
    const deck = new FakeDeck();
    const alpha = new FakeCard("alpha");
    const beta = new FakeCard("beta");
    deck.cards = [alpha, beta];
    const store = new LiveTurnsStore(deck.context());
    expect(alpha.outstanding).toBe(1);
    expect(beta.outstanding).toBe(1);

    store.dispose();

    expect(alpha.outstanding).toBe(0);
    expect(beta.outstanding).toBe(0);
  });

  it("holds one subscription per card across a resync, not one per resync", () => {
    const deck = new FakeDeck();
    const alpha = new FakeCard("alpha");
    deck.cards = [alpha];
    const store = new LiveTurnsStore(deck.context());

    deck.changed();
    deck.changed();
    deck.changed();

    expect(alpha.outstanding).toBe(1);
    store.dispose();
  });

  it("stops hearing from a card after dispose", () => {
    const deck = new FakeDeck();
    const alpha = new FakeCard("alpha");
    deck.cards = [alpha];
    const store = new LiveTurnsStore(deck.context());

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.dispose();

    alpha.setLive(true);
    expect(notifications).toBe(0);
  });
});
