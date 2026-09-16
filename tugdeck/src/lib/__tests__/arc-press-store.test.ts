/**
 * `arcPressStore` — the press, and the refusal that has nowhere else to go.
 *
 * The store carries two facts and deliberately not a third. It never says
 * whether an arc is still stopped, because a receipt is a frozen record and a
 * renderer that read live arc state into one would stop being a record.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  arcPressStore,
  PRESS_HORIZON_MS,
  type PressTimerSource,
} from "@/lib/arc-press-store";

/**
 * The horizon's clock, held still. Real timers would mean waiting through
 * forty-five seconds to read a fact that is decided the moment they fire.
 */
class FakeClock implements PressTimerSource {
  private _now = 0;
  private _next = 1;
  private _pending = new Map<number, { at: number; cb: () => void }>();

  setTimeout = (cb: () => void, ms: number): unknown => {
    const handle = this._next++;
    this._pending.set(handle, { at: this._now + ms, cb });
    return handle;
  };

  clearTimeout = (handle: unknown): void => {
    this._pending.delete(handle as number);
  };

  /** How many timers are still armed — what "the other's survives" means. */
  get armed(): number {
    return this._pending.size;
  }

  advance(ms: number): void {
    this._now += ms;
    for (const [handle, timer] of [...this._pending]) {
      if (timer.at <= this._now) {
        this._pending.delete(handle);
        timer.cb();
      }
    }
  }
}

let clock = new FakeClock();

beforeEach(() => {
  clock = new FakeClock();
  arcPressStore._setTimersForTests(clock);
});

afterEach(() => {
  for (const arc of ["alpha", "beta"] as const) {
    for (const verb of ["start", "resume", "stop"] as const) {
      arcPressStore.settle(arc, verb);
    }
  }
  arcPressStore.clearRefusal("sess-1");
  arcPressStore.clearRefusal("sess-2");
});

describe("the press", () => {
  it("holds the pressed arc and no other", () => {
    // A card can show more than one arc, and a press on one must not grey the
    // other's button.
    arcPressStore.press("alpha", "resume", "sess-1");
    expect(arcPressStore.isPending("alpha", "resume")).toBe(true);
    expect(arcPressStore.isPending("beta", "resume")).toBe(false);
  });

  it("holds the pressed verb and no other on the same arc", () => {
    // The Arcs card's row and a stop receipt below it can be about one arc at
    // once. A Stop still waiting for its answer says nothing about whether a
    // Start on that arc is pressable.
    arcPressStore.press("alpha", "stop", "sess-1");
    expect(arcPressStore.isPending("alpha", "stop")).toBe(true);
    expect(arcPressStore.isPending("alpha", "start")).toBe(false);
    expect(arcPressStore.isPending("alpha", "resume")).toBe(false);
  });

  it("releases on the answer", () => {
    arcPressStore.press("alpha", "resume", "sess-1");
    arcPressStore.settle("alpha", "resume");
    expect(arcPressStore.isPending("alpha", "resume")).toBe(false);
  });

  it("releases on a refusal too", () => {
    // A button still greyed over a refusal the bulletin already spoke is a
    // control the user cannot retry.
    arcPressStore.press("alpha", "resume", "sess-1");
    arcPressStore.refuse("sess-1", "alpha", "resume", "card runs beta");
    expect(arcPressStore.isPending("alpha", "resume")).toBe(false);
  });

  it("releases only the refused verb", () => {
    arcPressStore.press("alpha", "start", "sess-1");
    arcPressStore.press("alpha", "stop", "sess-1");
    arcPressStore.refuse("sess-1", "alpha", "stop", "no card is running it");
    expect(arcPressStore.isPending("alpha", "stop")).toBe(false);
    expect(arcPressStore.isPending("alpha", "start")).toBe(true);
  });

  it("wakes its readers on both edges", () => {
    let woke = 0;
    const stop = arcPressStore.subscribe(() => {
      woke += 1;
    });
    arcPressStore.press("alpha", "resume", "sess-1");
    arcPressStore.settle("alpha", "resume");
    stop();
    expect(woke).toBe(2);
  });

  it("does not wake them for a press already standing", () => {
    arcPressStore.press("alpha", "resume", "sess-1");
    let woke = 0;
    const stop = arcPressStore.subscribe(() => {
      woke += 1;
    });
    arcPressStore.press("alpha", "resume", "sess-1");
    stop();
    expect(woke).toBe(0);
  });
});

describe("the refusal", () => {
  it("carries the arc, the verb and the reason, keyed by session", () => {
    arcPressStore.refuse("sess-1", "alpha", "resume", "card runs beta");
    const refusal = arcPressStore.refusalFor("sess-1");
    expect(refusal?.arc).toBe("alpha");
    expect(refusal?.verb).toBe("resume");
    expect(refusal?.reason).toBe("card runs beta");
    expect(arcPressStore.refusalFor("sess-2")).toBeNull();
  });

  it("bumps its sequence so two identical refusals both speak", () => {
    // The second one is a second press, and a notice keyed on the words would
    // swallow it.
    arcPressStore.refuse("sess-1", "alpha", "resume", "card runs beta");
    const first = arcPressStore.refusalFor("sess-1")?.seq;
    arcPressStore.refuse("sess-1", "alpha", "resume", "card runs beta");
    expect(arcPressStore.refusalFor("sess-1")?.seq).not.toBe(first);
  });

  it("is forgotten when a later press lands", () => {
    arcPressStore.refuse("sess-1", "alpha", "resume", "card runs beta");
    arcPressStore.clearRefusal("sess-1");
    expect(arcPressStore.refusalFor("sess-1")).toBeNull();
  });
});

describe("the horizon", () => {
  it("releases a press no frame ever answers", () => {
    // A frame nobody answers is a permanently greyed control. The horizon is
    // the floor under that: the press releases itself and says why.
    arcPressStore.press("alpha", "stop", "sess-1");
    clock.advance(PRESS_HORIZON_MS + 1);
    expect(arcPressStore.isPending("alpha", "stop")).toBe(false);
    expect(arcPressStore.refusalFor("sess-1")?.reason).toBe("no answer");
    expect(arcPressStore.refusalFor("sess-1")?.verb).toBe("stop");
  });

  it("fires no phantom refusal over a press that was answered", () => {
    arcPressStore.press("alpha", "stop", "sess-1");
    arcPressStore.settle("alpha", "stop");
    clock.advance(PRESS_HORIZON_MS + 1);
    expect(arcPressStore.refusalFor("sess-1")).toBeNull();
  });

  it("holds one horizon per press, not one per arc", () => {
    // Two verbs on one arc are two presses, and answering one says nothing
    // about the other.
    arcPressStore.press("alpha", "stop", "sess-1");
    arcPressStore.press("alpha", "resume", "sess-1");
    expect(clock.armed).toBe(2);
    arcPressStore.settle("alpha", "stop");
    expect(clock.armed).toBe(1);

    clock.advance(PRESS_HORIZON_MS + 1);
    expect(arcPressStore.refusalFor("sess-1")?.verb).toBe("resume");
  });

  it("speaks a refusal naming no live card through the card that pressed", () => {
    // The empty-id case is the easy half. This is the one a rotation produces:
    // the server answers a segment id no card wears, the dispatch finds it
    // unroutable, and the reason would otherwise land in a slot nobody reads.
    arcPressStore.press("alpha", "stop", "sess-1");
    arcPressStore.refuse(null, "alpha", "stop", "no card is running it");
    expect(arcPressStore.refusalFor("sess-1")?.reason).toBe(
      "no card is running it",
    );
    expect(arcPressStore.isPending("alpha", "stop")).toBe(false);
  });

  it("releases the button even when there is nowhere to speak", () => {
    arcPressStore.press("alpha", "stop", null);
    arcPressStore.refuse(null, "alpha", "stop", "no card is running it");
    expect(arcPressStore.isPending("alpha", "stop")).toBe(false);
    expect(arcPressStore.refusalFor("sess-1")).toBeNull();
  });
});
