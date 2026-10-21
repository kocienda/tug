/**
 * `arc.presses` as an exchange between pages: the shell holds every press
 * and refusal, and a body reads and proposes.
 *
 * Each page has its own {@link ArcPressStore}, as each realm does. A store per
 * page that nobody shared was the bug: a stop receipt's Resume pressed in its
 * card's body, the `_ok` arrived at the shell, and the body's own horizon
 * spoke "Couldn't resume — no answer" over an arc that had resumed.
 *
 * @covers tugdeck/src/lib/arc-press-store.ts
 * @covers tugdeck/src/bus/declarations/relays.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTestBus, type TestBus, type TestPage } from "../../bus/test-bus";
import {
  ArcPressStore,
  PRESS_HORIZON_MS,
  shareArcPresses,
  type PressFrameSink,
  type PressTimerSource,
} from "../arc-press-store";

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

interface Sent {
  action: string;
  payload: Record<string, unknown>;
}

let bus: TestBus;
let sent: Sent[];
let sink: PressFrameSink | null;
let clock: FakeClock;
let shell: { page: TestPage; store: ArcPressStore };
let card: { page: TestPage; store: ArcPressStore };
let arcs: { page: TestPage; store: ArcPressStore };
const releases: Array<() => void> = [];

const ACTOR = { tugSessionId: "sess-card", projectDir: "/p" };

function seat(page: TestPage): { page: TestPage; store: ArcPressStore } {
  const store = new ArcPressStore();
  if (page.identity.role === "shell") {
    store._setTimersForTests(clock);
    store._setFrameSinkForTests(() => sink);
  }
  releases.push(shareArcPresses(page.bus, store));
  return { page, store };
}

beforeEach(async () => {
  bus = createTestBus();
  sent = [];
  clock = new FakeClock();
  sink = {
    sendControlFrame: (action, payload) => {
      sent.push({ action, payload });
    },
  };
  shell = seat(bus.shell());
  card = seat(bus.body("c1", "session"));
  arcs = seat(bus.body("arcs", "arcs"));
  await bus.flush();
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  bus.dispose();
});

describe("a body's press", () => {
  test("greys at once, and the shell sends the frame", async () => {
    expect(card.store.send("alpha", "resume", ACTOR)).toBe(true);
    // Before the bus has carried anything: the click greys the button.
    expect(card.store.isPending("alpha", "resume")).toBe(true);
    expect(sent).toEqual([]);
    await bus.flush();
    expect(shell.store.isPending("alpha", "resume")).toBe(true);
    expect(arcs.store.isPending("alpha", "resume")).toBe(true);
    expect(sent).toEqual([
      { action: "arc_resume", payload: { tug_session_id: "sess-card", project_dir: "/p", arc: "alpha" } },
    ]);
  });

  test("settles on the shell's answer, and the horizon stays quiet", async () => {
    // The reported bug: the answer lands at the shell, and the body that
    // pressed must hear that it did.
    card.store.send("alpha", "resume", ACTOR);
    await bus.flush();
    shell.store.settle("alpha", "resume");
    await bus.flush();
    expect(card.store.isPending("alpha", "resume")).toBe(false);
    clock.advance(PRESS_HORIZON_MS + 1);
    await bus.flush();
    expect(card.store.refusalFor("sess-card")).toBeNull();
    expect(shell.store.refusalFor("sess-card")).toBeNull();
  });

  test("is not made when the shell has no connection, and the button stays pressable", async () => {
    sink = null;
    card.store.send("alpha", "start", ACTOR);
    expect(card.store.isPending("alpha", "start")).toBe(true);
    await bus.flush();
    expect(card.store.isPending("alpha", "start")).toBe(false);
    expect(shell.store.isPending("alpha", "start")).toBe(false);
  });

  test("a second press of a press already out is not a second frame", async () => {
    card.store.send("alpha", "stop", ACTOR);
    await bus.flush();
    expect(arcs.store.send("alpha", "stop", ACTOR)).toBe(false);
    await bus.flush();
    expect(sent.length).toBe(1);
  });
});

describe("a refusal", () => {
  test("pressed on the Arcs card's page is spoken on the card it acted as", async () => {
    // The Arcs card presses as the card it follows. The horizon is the
    // shell's, and its refusal reaches the followed card's page.
    arcs.store.send("alpha", "stop", ACTOR);
    await bus.flush();
    clock.advance(PRESS_HORIZON_MS + 1);
    await bus.flush();
    expect(card.store.refusalFor("sess-card")?.reason).toBe("no answer");
    expect(arcs.store.isPending("alpha", "stop")).toBe(false);
  });

  test("a surface's own refusal reaches the card it names", async () => {
    arcs.store.refuse("sess-card", "alpha", "start", "no card to run it on");
    await bus.flush();
    expect(card.store.refusalFor("sess-card")?.reason).toBe("no card to run it on");
  });

  test("goes when its bulletin goes, and a newer one stands", async () => {
    shell.store.refuse("sess-card", "alpha", "stop", "first");
    await bus.flush();
    const first = card.store.refusalFor("sess-card")!.seq;
    shell.store.refuse("sess-card", "alpha", "stop", "second");
    await bus.flush();
    // The first bulletin closing must not take the second refusal with it.
    card.store.clearRefusal("sess-card", first);
    await bus.flush();
    expect(card.store.refusalFor("sess-card")?.reason).toBe("second");
    const second = card.store.refusalFor("sess-card")!.seq;
    card.store.clearRefusal("sess-card", second);
    expect(card.store.refusalFor("sess-card")).toBeNull();
    await bus.flush();
    expect(shell.store.refusalFor("sess-card")).toBeNull();
    expect(arcs.store.refusalFor("sess-card")).toBeNull();
  });

  test("a page that comes up later is handed what stands", async () => {
    shell.store.refuse("sess-card", "alpha", "resume", "no answer");
    card.store.send("beta", "start", ACTOR);
    await bus.flush();
    const late = seat(bus.body("c2", "session"));
    await bus.flush();
    expect(late.store.refusalFor("sess-card")?.reason).toBe("no answer");
    expect(late.store.isPending("beta", "start")).toBe(true);
  });
});
