/**
 * card-lifecycle-arrival.test.ts — the ARRIVAL channel: a card the deck opened
 * whose frame has not finished coming on screen, and the callers waiting on it.
 *
 * The channel exists because two things want to act on a card that has STOPPED
 * MOVING rather than on one that merely exists — the deck's travel to a card it
 * just opened, and the picker an unbound Session card raises. Both used to run
 * off a clock guessing at how long the entrance took; both now wait for the
 * settle's arrive beat to end.
 *
 * What is held here is the contract, not the settle: `onceCardDidArrive`'s
 * FIRE-AT-ONCE rule for a card nothing marked, its deferral for a marked one,
 * that it fires exactly once however many times the drain calls it, that its
 * cancel works, and that a destroyed card's mark is cleared rather than left
 * standing for a callback that would then wait forever.
 *
 * A `CardLifecycle` over the minimal `CardLifecycleStore` the cascade tests
 * already construct — a pure object, no DOM.
 */

import { describe, expect, test } from "bun:test";

import { CardLifecycle, type CardLifecycleStore } from "@/lib/card-lifecycle";

function makeStore(initial: string | null = null): CardLifecycleStore {
  const state = { focused: initial };
  return {
    focusCard(id: string) {
      state.focused = id;
    },
    getFocusedCardId() {
      return state.focused;
    },
    getFirstResponderCardId() {
      return state.focused;
    },
  };
}

const makeLifecycle = (): CardLifecycle => new CardLifecycle(makeStore());

describe("onceCardDidArrive", () => {
  test("fires SYNCHRONOUSLY for a card that was never marked arriving", () => {
    // The common case and the whole reason the rule exists: a card activated
    // by a click, a card restored at launch, a card in a window-less host. A
    // caller that subscribed and waited in any of those would wait forever.
    const lifecycle = makeLifecycle();
    let fired = 0;
    lifecycle.onceCardDidArrive("A", () => {
      fired += 1;
    });
    expect(fired).toBe(1);
  });

  test("defers for a marked card, and fires when it arrives", () => {
    const lifecycle = makeLifecycle();
    let fired = 0;
    lifecycle.notifyCardWillArrive("A");
    lifecycle.onceCardDidArrive("A", () => {
      fired += 1;
    });
    expect(fired, "still arriving, so nothing has run").toBe(0);
    lifecycle.notifyCardDidArrive("A");
    expect(fired).toBe(1);
  });

  test("fires exactly once, however many times the arrival is announced", () => {
    // The drain calls `notifyCardDidArrive` for every card it can find, from
    // five places, deliberately not reasoning about which owns a given one.
    // That is only safe because this holds.
    const lifecycle = makeLifecycle();
    let fired = 0;
    lifecycle.notifyCardWillArrive("A");
    lifecycle.onceCardDidArrive("A", () => {
      fired += 1;
    });
    lifecycle.notifyCardDidArrive("A");
    lifecycle.notifyCardDidArrive("A");
    lifecycle.notifyCardDidArrive("A");
    expect(fired).toBe(1);
  });

  test("its cancel prevents the firing", () => {
    const lifecycle = makeLifecycle();
    let fired = 0;
    lifecycle.notifyCardWillArrive("A");
    const cancel = lifecycle.onceCardDidArrive("A", () => {
      fired += 1;
    });
    cancel();
    lifecycle.notifyCardDidArrive("A");
    expect(fired).toBe(0);
  });

  test("waits only for its OWN card", () => {
    const lifecycle = makeLifecycle();
    let fired = 0;
    lifecycle.notifyCardWillArrive("A");
    lifecycle.notifyCardWillArrive("B");
    lifecycle.onceCardDidArrive("A", () => {
      fired += 1;
    });
    lifecycle.notifyCardDidArrive("B");
    expect(fired, "B arriving says nothing about A").toBe(0);
    lifecycle.notifyCardDidArrive("A");
    expect(fired).toBe(1);
  });

  test("a callback that re-enters for the same card is answered at once", () => {
    // The mark is cleared BEFORE the fire, which is what makes this true: a
    // sheet presenting activates the card, and the activation observer asks
    // about arrival again. Were the mark still standing it would subscribe
    // against an event that has already been fired.
    const lifecycle = makeLifecycle();
    let inner = 0;
    lifecycle.notifyCardWillArrive("A");
    lifecycle.onceCardDidArrive("A", () => {
      lifecycle.onceCardDidArrive("A", () => {
        inner += 1;
      });
    });
    lifecycle.notifyCardDidArrive("A");
    expect(inner).toBe(1);
  });

  test("a card destroyed while arriving leaves no mark behind", () => {
    // Otherwise the id stays marked forever and every later caller defers
    // against an arrival that is never coming.
    const lifecycle = makeLifecycle();
    lifecycle.notifyCardWillArrive("A");
    lifecycle.notifyCardWillBeginDestruction("A");
    let fired = 0;
    lifecycle.onceCardDidArrive("A", () => {
      fired += 1;
    });
    expect(fired, "nothing is arriving, so the answer is at once").toBe(1);
  });

  test("a card destroyed while arriving leaves no WAITER behind either", () => {
    // The mark's other half. The waiter is a one-shot that unsubscribes itself
    // when it fires, and a destroyed card never fires: the canvas's drain
    // reaches only cards the deck still holds. Without the prune the closure
    // would sit in the channel for the life of the lifecycle, one per card the
    // reader shut during its own arrival.
    const lifecycle = makeLifecycle();
    lifecycle.notifyCardWillArrive("A");
    let fired = 0;
    lifecycle.onceCardDidArrive("A", () => {
      fired += 1;
    });
    expect(fired, "it deferred, because A was arriving").toBe(0);
    lifecycle.notifyCardWillBeginDestruction("A");
    // Nothing should reach the dropped waiter, however the announcement comes.
    lifecycle.notifyCardDidArrive("A");
    expect(fired, "the waiter went with the card").toBe(0);
  });

  test("destroying one card leaves another's waiter standing", () => {
    // The prune is by cardId, not a sweep: two cards can be arriving at once.
    const lifecycle = makeLifecycle();
    lifecycle.notifyCardWillArrive("A");
    lifecycle.notifyCardWillArrive("B");
    let firedB = 0;
    lifecycle.onceCardDidArrive("B", () => {
      firedB += 1;
    });
    lifecycle.notifyCardWillBeginDestruction("A");
    lifecycle.notifyCardDidArrive("B");
    expect(firedB).toBe(1);
  });

  test("a wildcard subscriber survives a destruction", () => {
    // It is about the channel rather than about any one card.
    const lifecycle = makeLifecycle();
    const seen: string[] = [];
    lifecycle.observeCardDidArrive(null, (id) => seen.push(id));
    lifecycle.notifyCardWillArrive("A");
    lifecycle.notifyCardWillBeginDestruction("A");
    lifecycle.notifyCardDidArrive("B");
    expect(seen).toEqual(["B"]);
  });
});

describe("observeCardDidArrive", () => {
  test("a wildcard subscriber sees every arrival", () => {
    const lifecycle = makeLifecycle();
    const seen: string[] = [];
    lifecycle.observeCardDidArrive(null, (id) => seen.push(id));
    lifecycle.notifyCardWillArrive("A");
    lifecycle.notifyCardWillArrive("B");
    lifecycle.notifyCardDidArrive("A");
    lifecycle.notifyCardDidArrive("B");
    expect(seen).toEqual(["A", "B"]);
  });

  test("a card-specific subscriber sees only its own, and keeps seeing them", () => {
    // Unlike `onceCardDidArrive` this is not a one-shot: it is the channel,
    // and it fires for the length of the subscription.
    const lifecycle = makeLifecycle();
    const seen: string[] = [];
    const stop = lifecycle.observeCardDidArrive("A", (id) => seen.push(id));
    lifecycle.notifyCardDidArrive("A");
    lifecycle.notifyCardDidArrive("B");
    lifecycle.notifyCardDidArrive("A");
    expect(seen).toEqual(["A", "A"]);
    stop();
    lifecycle.notifyCardDidArrive("A");
    expect(seen).toEqual(["A", "A"]);
  });

  test("no initial-sync: an arrival already past has none left to replay", () => {
    const lifecycle = makeLifecycle();
    lifecycle.notifyCardWillArrive("A");
    lifecycle.notifyCardDidArrive("A");
    const seen: string[] = [];
    lifecycle.observeCardDidArrive("A", (id) => seen.push(id));
    expect(seen).toEqual([]);
  });
});

describe("onceCardDidTravel", () => {
  // The move's twin of the arrival channel, over the same mark: a dropped card
  // is marked TRAVELLING by `movePaneToSlot`, the canvas's drain clears it at
  // the settle's end, and the deck's second move — the slide that shows the
  // card whole — waits on that rather than on a clock.
  test("fires SYNCHRONOUSLY for a card nothing marked", () => {
    const lifecycle = makeLifecycle();
    let fired = 0;
    lifecycle.onceCardDidTravel("A", () => {
      fired += 1;
    });
    expect(fired).toBe(1);
  });

  test("defers for a travelling card, and fires when the settle drains it", () => {
    const lifecycle = makeLifecycle();
    let fired = 0;
    lifecycle.notifyCardWillTravel("A");
    lifecycle.onceCardDidTravel("A", () => {
      fired += 1;
    });
    expect(fired).toBe(0);
    // The drain fires ARRIVAL for every card the deck holds, arrival or
    // crossing alike — the one mark is what it clears.
    lifecycle.notifyCardDidArrive("A");
    expect(fired).toBe(1);
    lifecycle.notifyCardDidArrive("A");
    expect(fired).toBe(1);
  });
});
