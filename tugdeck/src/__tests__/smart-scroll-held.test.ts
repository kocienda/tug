/**
 * `SmartScroll` against a HELD interior — its pane frame wearing a still
 * crossing, so the interior stands at a fixed height while the frame's edge
 * tweens.
 *
 * While held, the growth pin and the restore heartbeat owe their write
 * instead of making it: a write against a held interior is a position the
 * reader never sees, taken against geometry about to change. `catchUp` pays
 * what was owed once, when the hold lifts. These cases pin that contract over
 * a real `SmartScroll` on a jsdom scroller whose geometry the rig controls.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { SmartScroll } from "../lib/smart-scroll";

const VIEWPORT = 200;
const CONTENT = 1000;
const AT_BOTTOM = CONTENT - VIEWPORT;

interface Rig {
  smartScroll: SmartScroll;
  /** The scroller's live `scrollTop`. */
  top(): number;
  /** How many times anything wrote `scrollTop`. */
  writes(): number;
  /** Hold or release the interior. */
  hold(held: boolean): void;
  dispose(): void;
}

let priorGlobals: Record<string, unknown> | null = null;
let rig: Rig | null = null;

function makeRig(startTop: number): Rig {
  const dom = new JSDOM("<!doctype html><div id='scroller'></div>");
  const win = dom.window as unknown as Window & typeof globalThis;
  const globals = globalThis as Record<string, unknown>;
  priorGlobals = {
    window: globals.window,
    document: globals.document,
    requestAnimationFrame: globals.requestAnimationFrame,
    cancelAnimationFrame: globals.cancelAnimationFrame,
  };
  globals.window = win;
  globals.document = win.document;
  globals.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    setTimeout(() => cb(0), 0) as unknown as number;
  globals.cancelAnimationFrame = (id: number): void => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  };

  const el = win.document.getElementById("scroller") as HTMLElement;
  let top = startTop;
  let writes = 0;
  Object.defineProperty(el, "scrollHeight", { get: () => CONTENT });
  Object.defineProperty(el, "clientHeight", { get: () => VIEWPORT });
  Object.defineProperty(el, "clientWidth", { get: () => 400 });
  Object.defineProperty(el, "offsetWidth", { get: () => 400 });
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      writes += 1;
      top = Math.max(0, Math.min(v, AT_BOTTOM));
    },
  });

  let held = false;
  const smartScroll = new SmartScroll({ scrollContainer: el, followBottom: true });
  smartScroll.setHeldSource(() => held);
  return {
    smartScroll,
    top: () => top,
    writes: () => writes,
    hold: (next) => {
      held = next;
    },
    dispose: () => smartScroll.dispose(),
  };
}

afterEach(() => {
  rig?.dispose();
  rig = null;
  if (priorGlobals !== null) {
    const globals = globalThis as Record<string, unknown>;
    for (const [key, value] of Object.entries(priorGlobals)) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
    priorGlobals = null;
  }
});

describe("held calls owe and do not scroll", () => {
  test("a growth pin while held writes nothing", () => {
    rig = makeRig(100);
    rig.hold(true);
    const before = rig.writes();
    rig.smartScroll.maybePinToBottom();
    rig.smartScroll.pinToBottom();
    expect(rig.writes()).toBe(before);
    expect(rig.top()).toBe(100);
  });

  test("a restore heartbeat while held writes nothing", () => {
    rig = makeRig(100);
    rig.smartScroll.setRestoreTarget(() => 400);
    rig.hold(true);
    const before = rig.writes();
    rig.smartScroll.applyRestoreTarget();
    expect(rig.writes()).toBe(before);
    expect(rig.top()).toBe(100);
  });

  test("unheld, the same calls write as they always have", () => {
    rig = makeRig(100);
    rig.smartScroll.pinToBottom();
    expect(rig.top()).toBe(AT_BOTTOM);
  });
});

describe("catchUp runs each owed reaction once", () => {
  test("an owed pin is made when the hold lifts", () => {
    rig = makeRig(100);
    rig.hold(true);
    rig.smartScroll.pinToBottom();
    rig.smartScroll.pinToBottom();
    rig.hold(false);
    const before = rig.writes();
    rig.smartScroll.catchUp();
    expect(rig.top()).toBe(AT_BOTTOM);
    expect(rig.writes()).toBe(before + 1);
  });

  test("an owed restore is applied when the hold lifts", () => {
    rig = makeRig(100);
    rig.smartScroll.setRestoreTarget(() => 400);
    rig.hold(true);
    rig.smartScroll.applyRestoreTarget();
    rig.smartScroll.applyRestoreTarget();
    rig.hold(false);
    rig.smartScroll.catchUp();
    expect(rig.top()).toBe(400);
  });

  test("a second catchUp finds nothing owed", () => {
    rig = makeRig(100);
    rig.hold(true);
    rig.smartScroll.pinToBottom();
    rig.hold(false);
    rig.smartScroll.catchUp();
    const after = rig.writes();
    rig.smartScroll.catchUp();
    expect(rig.writes()).toBe(after);
  });
});

describe("a catchUp with nothing owed does nothing", () => {
  test("no hold, no debt, no write", () => {
    rig = makeRig(100);
    const before = rig.writes();
    rig.smartScroll.catchUp();
    expect(rig.writes()).toBe(before);
    expect(rig.top()).toBe(100);
  });
});
