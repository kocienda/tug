/**
 * card-session-binding-store unit tests.
 *
 * Tests cover:
 * - setBinding notifies subscribers
 * - setBinding on a known card id replaces the existing binding
 * - clearBinding notifies subscribers when the card was bound
 * - clearBinding on an unknown card id is a no-op (no listener notification)
 * - getSnapshot returns a stable Map reference between mutations
 */

import { describe, test, expect } from "bun:test";
import {
  CardSessionBindingStore,
  cardIdForSession,
  cardLine,
  cardSeatedSegment,
  cardSessionBindingStore,
  seatedSegmentForSession,
  type CardSessionBinding,
} from "../lib/card-session-binding-store";
import { sessionLineStore } from "../lib/session-line-store";

function makeBinding(overrides: Partial<CardSessionBinding> = {}): CardSessionBinding {
  return {
    tugSessionId: "sess-1",
    lineId: "line-1",
    workspaceKey: "/work/alpha",
    projectDir: "/work/alpha",
    sessionMode: "new",
    ...overrides,
  };
}

describe("CardSessionBindingStore – setBinding", () => {
  test("notifies listeners on set", () => {
    const store = new CardSessionBindingStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.setBinding("card-1", makeBinding());
    expect(notifications).toBe(1);
    expect(store.getBinding("card-1")).toEqual(makeBinding());

    unsubscribe();
  });

  test("replaces an existing binding and notifies again", () => {
    const store = new CardSessionBindingStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.setBinding("card-1", makeBinding({ workspaceKey: "/work/alpha" }));
    store.setBinding("card-1", makeBinding({ workspaceKey: "/work/beta" }));

    expect(notifications).toBe(2);
    expect(store.getBinding("card-1")?.workspaceKey).toBe("/work/beta");
  });
});

describe("CardSessionBindingStore – clearBinding", () => {
  test("notifies listeners when a bound card is cleared", () => {
    const store = new CardSessionBindingStore();
    store.setBinding("card-1", makeBinding());

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.clearBinding("card-1");

    expect(notifications).toBe(1);
    expect(store.getBinding("card-1")).toBeUndefined();
  });

  test("is a no-op when clearing an unknown card id", () => {
    const store = new CardSessionBindingStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.clearBinding("never-bound");

    expect(notifications).toBe(0);
  });
});

describe("CardSessionBindingStore – snapshot stability", () => {
  test("getSnapshot returns the same Map reference between mutations", () => {
    const store = new CardSessionBindingStore();
    const first = store.getSnapshot();
    const second = store.getSnapshot();
    expect(first).toBe(second);
  });

  test("getSnapshot returns a new Map reference after setBinding", () => {
    const store = new CardSessionBindingStore();
    const before = store.getSnapshot();
    store.setBinding("card-1", makeBinding());
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
  });

  test("getSnapshot returns a new Map reference after clearBinding", () => {
    const store = new CardSessionBindingStore();
    store.setBinding("card-1", makeBinding());
    const before = store.getSnapshot();
    store.clearBinding("card-1");
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
  });
});

describe("CardSessionBindingStore – clearAll", () => {
  test("drops every binding in a single notify", () => {
    const store = new CardSessionBindingStore();
    store.setBinding("card-1", makeBinding({ tugSessionId: "sess-1" }));
    store.setBinding("card-2", makeBinding({ tugSessionId: "sess-2" }));
    store.setBinding("card-3", makeBinding({ tugSessionId: "sess-3" }));

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.clearAll();

    expect(notifications).toBe(1);
    expect(store.getSnapshot().size).toBe(0);
    expect(store.getBinding("card-1")).toBeUndefined();
    expect(store.getBinding("card-2")).toBeUndefined();
    expect(store.getBinding("card-3")).toBeUndefined();
  });

  test("returns a new Map reference after clearing a populated store", () => {
    const store = new CardSessionBindingStore();
    store.setBinding("card-1", makeBinding());
    const before = store.getSnapshot();
    store.clearAll();
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.size).toBe(0);
  });

  test("is a no-op when the store is already empty", () => {
    const store = new CardSessionBindingStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.clearAll();

    expect(notifications).toBe(0);
    const before = store.getSnapshot();
    store.clearAll();
    const after = store.getSnapshot();
    expect(after).toBe(before);
  });
});

describe("CardSessionBindingStore – unsubscribe", () => {
  test("unsubscribed listeners stop receiving notifications", () => {
    const store = new CardSessionBindingStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.setBinding("card-1", makeBinding());
    unsubscribe();
    store.setBinding("card-2", makeBinding({ tugSessionId: "sess-2" }));

    expect(notifications).toBe(1);
  });
});

/**
 * `session_line_rebound` ([P03]): a plain `/new` on a bound card births a
 * fresh line, and the binding has to follow it — the merge keeps the
 * `workspaceKey` the pane's feed filter is built from.
 */
describe("CardSessionBindingStore – setLineBinding", () => {
  test("re-seats the card on a new session and line, preserving the rest", () => {
    const store = new CardSessionBindingStore();
    store.setBinding("card-1", makeBinding());
    store.setArcBinding("card-1", { id: "tugarc/demo#1-abc", name: "demo" });

    store.setLineBinding("card-1", "sess-2", "line-2");

    const bound = store.getBinding("card-1");
    expect(bound?.tugSessionId).toBe("sess-2");
    expect(bound?.lineId).toBe("line-2");
    expect(bound?.workspaceKey).toBe("/work/alpha");
    expect(bound?.projectDir).toBe("/work/alpha");
    expect(bound?.arc?.name).toBe("demo");
  });

  test("no-ops on a card with no binding, and on a rebind to the same pair", () => {
    const store = new CardSessionBindingStore();
    store.setLineBinding("card-nope", "sess-2", "line-2");
    expect(store.getBinding("card-nope")).toBeUndefined();

    store.setBinding("card-1", makeBinding());
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.setLineBinding("card-1", "sess-1", "line-1");
    expect(notifications).toBe(0);
  });
});

/**
 * **The seat a rotation moves** — the postmortem's own symptom, as a unit.
 *
 * The Wheel mints a fresh segment on the card's line and the ledger seats the
 * line on it; the row push that follows is what teaches the deck the new
 * `(session_id, line_id)` pair. The card's *address* must not move — its
 * `CardServices` bag is built around it and every frame it sends is stamped
 * with it — so the seat is read rather than written: card → line → the line's
 * current segment. Before a rotation the two answers are one string, which is
 * why five workstreams of tests could not tell them apart.
 *
 * Against the singletons, because that composition is what the app reads:
 * `cardSeatedSegment` is exactly `cardSessionBindingStore` and
 * `sessionLineStore` asked in turn, and a test over private instances would
 * pin a walk nothing performs.
 */
describe("cardSeatedSegment – the card follows the rotation, its address does not", () => {
  const CARD = "card-seat";
  const ROOT = "seat-sess-root";
  const LINE = "seat-line";
  const STAGE = "seat-sess-stage";

  function seatFixture(): void {
    cardSessionBindingStore.clearBinding(CARD);
    sessionLineStore.forgetSession(ROOT);
    sessionLineStore.forgetSession(STAGE);
    cardSessionBindingStore.setBinding(CARD, makeBinding({
      tugSessionId: ROOT,
      lineId: LINE,
      sessionMode: "resume",
    }));
    // What `spawn_session_ok` does with the ack's `(session_id, line_id)`.
    sessionLineStore.seat(ROOT, LINE);
  }

  test("before any rotation the seat is the address", () => {
    seatFixture();
    expect(cardSeatedSegment(CARD)).toBe(ROOT);
    expect(seatedSegmentForSession(ROOT)).toBe(ROOT);
  });

  test("the announcement moves the seat, not the address", () => {
    seatFixture();
    // What the `session_line_seated` handler does with the frame the bridge
    // sends when the card's claude id changes on a line it already had.
    sessionLineStore.seat(STAGE, LINE);
    cardSessionBindingStore.setSeatedSegment(CARD, STAGE, LINE);

    expect(cardSeatedSegment(CARD)).toBe(STAGE);
    // Asked with the id a process born before the rotation still holds.
    expect(seatedSegmentForSession(ROOT)).toBe(STAGE);
    // The address is untouched: a card whose `tugSessionId` moved would have
    // its services bag torn down and rebuilt mid-stage, against a session id
    // the supervisor does not answer to.
    expect(cardSessionBindingStore.getBinding(CARD)?.tugSessionId).toBe(ROOT);
    expect(cardSessionBindingStore.getBinding(CARD)?.lineId).toBe(LINE);
  });

  test("a later push about the retired segment does not move the seat back", () => {
    seatFixture();
    cardSessionBindingStore.setSeatedSegment(CARD, STAGE, LINE);
    // A rotation leaves the retired segment's row `live` too, so its own
    // `session_updated` keeps arriving and re-seats the *line* on it. The
    // card's seat is announced rather than read off that, which is the whole
    // reason this is a stored field: derived, `at0503`'s card read back as its
    // root a moment after being seated on its stage.
    sessionLineStore.seat(ROOT, LINE);
    expect(cardSeatedSegment(CARD)).toBe(STAGE);
  });

  test("a card with no binding has no seat, and an unknown segment is its own", () => {
    seatFixture();
    expect(cardSeatedSegment("card-nobody")).toBeNull();
    expect(seatedSegmentForSession("seat-sess-stranger")).toBe("seat-sess-stranger");
  });

  test("a card the server has said nothing about is seated at its address", () => {
    cardSessionBindingStore.clearBinding(CARD);
    cardSessionBindingStore.setBinding(CARD, makeBinding({
      tugSessionId: "seat-cold-sess",
      lineId: "seat-cold-line",
    }));
    expect(cardSeatedSegment(CARD)).toBe("seat-cold-sess");
    cardSessionBindingStore.clearBinding(CARD);
  });
});

/**
 * **The question every "show me that session's card" gesture asks**, and the
 * one the Arcs card's row used to ask with its own narrower walk.
 *
 * The aggregate's `bound_session` names whichever segment holds the arc's
 * binding *right now*, which the Wheel moves forward on every rotation, while
 * a card's `tugSessionId` stays the address it was spawned on. Compare those
 * two directly and a rotated card stops matching its own arc — the Arcs row
 * lost `data-activatable`, presented as inert, and the click did nothing at
 * all. The line is what does not move, so the line is the fallback.
 */
describe("cardIdForSession – the card holding a segment, across a rotation", () => {
  const CARD = "card-holder";
  const ROOT = "holder-sess-root";
  const LINE = "holder-line";
  const STAGE = "holder-sess-stage";

  function holderFixture(): void {
    cardSessionBindingStore.clearBinding(CARD);
    sessionLineStore.forgetSession(ROOT);
    sessionLineStore.forgetSession(STAGE);
    cardSessionBindingStore.setBinding(CARD, makeBinding({
      tugSessionId: ROOT,
      lineId: LINE,
    }));
    sessionLineStore.seat(ROOT, LINE);
  }

  test("the card's own address finds it", () => {
    holderFixture();
    expect(cardIdForSession(ROOT)).toBe(CARD);
    cardSessionBindingStore.clearBinding(CARD);
  });

  test("a segment minted by a rotation finds it too", () => {
    holderFixture();
    // What a rotation does: a new segment on the line the card already had,
    // and the arc's `bound_session` moves onto it. The card's address does
    // not move, so only the line can answer.
    sessionLineStore.seat(STAGE, LINE);
    cardSessionBindingStore.setSeatedSegment(CARD, STAGE, LINE);
    expect(cardIdForSession(STAGE)).toBe(CARD);
    cardSessionBindingStore.clearBinding(CARD);
  });

  test("a session no open card holds is null, not a throw", () => {
    holderFixture();
    expect(cardIdForSession("holder-sess-stranger")).toBeNull();
    cardSessionBindingStore.clearBinding(CARD);
  });
});

/**
 * **The ack that carried no line**, which is the shape the postmortem's card
 * was actually in and the reason the seat could not move.
 *
 * A resume of a session the ledger has no row for yet gets an ack with an empty
 * `line_id`, so `spawn_session_ok` seeds the binding with
 * `identityKeyForSession` — the session's own id, a line of one. The ledger
 * then births the real line at `record_spawn` and every `session_updated` push
 * names it. Read from the binding, the card is on a line nothing else in the
 * system uses; read through the line store, it is on the line the server means.
 * Driven end to end in `at0504`, where the binding said `a7c0d1ea-…-504` and
 * `arc bind --dry-run` said `fa395c92-…`.
 *
 * The **seat** is a different question and has a different answer — announced,
 * not derived — which is why only the line is walked here.
 */
describe("cardLine – the ack's seed, corrected by the server", () => {
  const CARD = "card-seed";
  const ROOT = "seed-sess-root";
  const REAL = "seed-line-real";
  const STAGE = "seed-sess-stage";

  test("a line-of-one seed is superseded, and the seat moves with it", () => {
    cardSessionBindingStore.clearBinding(CARD);
    sessionLineStore.forgetSession(ROOT);
    sessionLineStore.forgetSession(STAGE);
    // The ack carried no line, so the seed is the session's own id.
    cardSessionBindingStore.setBinding(CARD, makeBinding({
      tugSessionId: ROOT,
      lineId: ROOT,
      sessionMode: "resume",
    }));
    sessionLineStore.seat(ROOT, ROOT);
    expect(cardLine(CARD)).toBe(ROOT);
    expect(cardSeatedSegment(CARD)).toBe(ROOT);

    // The row push: the ledger birthed a real line and the row names it.
    sessionLineStore.seat(ROOT, REAL);
    expect(cardLine(CARD)).toBe(REAL);
    expect(cardSeatedSegment(CARD)).toBe(ROOT);

    // The rotation: a fresh segment on that same line, and the announcement
    // that the card is now sitting on it — which carries the real line too, so
    // a card whose ack had none is corrected either way.
    sessionLineStore.seat(STAGE, REAL);
    cardSessionBindingStore.setSeatedSegment(CARD, STAGE, REAL);
    expect(cardLine(CARD)).toBe(REAL);
    expect(cardSeatedSegment(CARD)).toBe(STAGE);
    // And the address is still the address.
    expect(cardSessionBindingStore.getBinding(CARD)?.tugSessionId).toBe(ROOT);

    cardSessionBindingStore.clearBinding(CARD);
    sessionLineStore.forgetSession(ROOT);
    sessionLineStore.forgetSession(STAGE);
  });

  test("a card with no binding has no line", () => {
    expect(cardLine("card-seed-nobody")).toBeNull();
  });
});
