/**
 * record-switch.test.ts — the motion instruments' switch: off by default, on
 * by hand, and off again leaving the trace as it was found.
 *
 * `bun test` has no page, so there is no sessionStorage, no commit census and
 * no lead recorder here: what this pins is the switch's own bookkeeping over
 * the deck trace, and that it reports the load-time instruments as waiting on
 * the next load rather than as armed.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { deckTrace } from "@/deck-trace";
import { RECORDED_KINDS, recordSwitch } from "../record-switch";

afterEach(() => {
  recordSwitch(false);
  deckTrace.enable(false);
});

describe("recordSwitch", () => {
  test("is off by default and records nothing", () => {
    const r = recordSwitch();
    expect(r.recording).toBe(false);
    expect(r.kinds).toEqual([]);
    expect(deckTrace.isEnabled()).toBe(false);
  });

  test("on arms the trace and every recording kind, and names what waits on a load", () => {
    const r = recordSwitch(true);
    expect(r.recording).toBe(true);
    expect(r.trace).toBe(true);
    expect(r.kinds).toEqual([...RECORDED_KINDS]);
    for (const kind of RECORDED_KINDS) expect(deckTrace.isKindEnabled(kind)).toBe(true);
    expect(r.census).toBe(false);
    expect(r.nextLoad).toEqual(["commit census", "lead recorder"]);
  });

  test("off disarms every kind and puts the trace back as on found it", () => {
    recordSwitch(true);
    const off = recordSwitch(false);
    expect(off.recording).toBe(false);
    expect(off.kinds).toEqual([]);
    expect(deckTrace.isEnabled()).toBe(false);

    // A trace somebody else had on stays on through a switch on and off.
    deckTrace.enable(true);
    recordSwitch(true);
    recordSwitch(false);
    expect(deckTrace.isEnabled()).toBe(true);
    for (const kind of RECORDED_KINDS) expect(deckTrace.isKindEnabled(kind)).toBe(false);
  });

  test("a second on does not forget the trace's state from before the first", () => {
    recordSwitch(true);
    recordSwitch(true);
    recordSwitch(false);
    expect(deckTrace.isEnabled()).toBe(false);
  });
});
