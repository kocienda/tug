/**
 * The gauge channel's listener registration.
 *
 * Element registration is not covered here: it needs a real `HTMLElement`, so
 * it belongs to the app-tests that already drive it. What a listener does is
 * pure — a callback, a set, and a standing value — and that is what this file
 * pins.
 */

import { describe, expect, test } from "bun:test";

import {
  columnOffsetSignal,
  gaugeListenerCount,
  publishColumnOffset,
  publishFlowOffset,
  registerGaugeListener,
} from "../imposer-gauges";

/** Each test takes its own signal, since the channel is module state. */
let nextSlot = 900;
function freshSignal(): ReturnType<typeof columnOffsetSignal> {
  return columnOffsetSignal(nextSlot++);
}

function heard(): {
  calls: (ReadonlyMap<string, string> | null)[];
  fn: (values: ReadonlyMap<string, string> | null) => void;
} {
  const calls: (ReadonlyMap<string, string> | null)[] = [];
  return { calls, fn: (values) => calls.push(values) };
}

describe("registerGaugeListener", () => {
  test("a listener registered before a publish receives it", () => {
    const signal = freshSignal();
    const slot = Number(signal.slice("column-offset:".length));
    const log = heard();
    const off = registerGaugeListener(signal, log.fn);

    publishColumnOffset(slot, 0.25);

    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]?.get(`--gauge-column-offset-${slot}`)).toBe("0.2500");
    off();
  });

  test("a listener registered mid-gesture is primed with the standing value", () => {
    const signal = freshSignal();
    const slot = Number(signal.slice("column-offset:".length));
    publishColumnOffset(slot, 0.5);

    const log = heard();
    const off = registerGaugeListener(signal, log.fn);

    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]?.get(`--gauge-column-offset-${slot}`)).toBe("0.5000");
    off();
  });

  test("a signal never published primes nothing", () => {
    const signal = freshSignal();
    const log = heard();
    const off = registerGaugeListener(signal, log.fn);

    expect(log.calls).toHaveLength(0);
    off();
  });

  test("a null publish reaches listeners", () => {
    const signal = freshSignal();
    const slot = Number(signal.slice("column-offset:".length));
    const log = heard();
    const off = registerGaugeListener(signal, log.fn);

    publishColumnOffset(slot, 0.1);
    publishColumnOffset(slot, null);

    expect(log.calls).toHaveLength(2);
    expect(log.calls[1]).toBeNull();
    off();
  });

  test("teardown stops delivery and empties the count", () => {
    const signal = freshSignal();
    const slot = Number(signal.slice("column-offset:".length));
    const log = heard();
    const off = registerGaugeListener(signal, log.fn);

    publishColumnOffset(slot, 0.1);
    expect(gaugeListenerCount(signal)).toBe(1);

    off();
    expect(gaugeListenerCount(signal)).toBe(0);

    publishColumnOffset(slot, 0.2);
    expect(log.calls).toHaveLength(1);
  });

  test("two listeners on one signal both hear it", () => {
    const signal = freshSignal();
    const slot = Number(signal.slice("column-offset:".length));
    const one = heard();
    const two = heard();
    const offOne = registerGaugeListener(signal, one.fn);
    const offTwo = registerGaugeListener(signal, two.fn);

    publishColumnOffset(slot, 0.75);

    expect(one.calls).toHaveLength(1);
    expect(two.calls).toHaveLength(1);
    offOne();
    offTwo();
  });

  test("a signal with listeners and no elements still fires", () => {
    // `flow-offset` has no registered element in this process — nothing here
    // can create one — so this is exactly the case the fast path would have
    // swallowed had it counted elements only.
    const log = heard();
    const off = registerGaugeListener("flow-offset", log.fn);

    publishFlowOffset(0.125);

    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]?.get("--gauge-flow-offset")).toBe("0.1250");
    off();
    publishFlowOffset(null);
  });

  test("the flow fraction crosses at four places, as the elements are written", () => {
    const log = heard();
    const off = registerGaugeListener("flow-offset", log.fn);

    // The test above retired the signal, so this listener is primed with that
    // `null` before the publish it is here to read.
    publishFlowOffset(1 / 3);

    expect(log.calls[log.calls.length - 1]?.get("--gauge-flow-offset")).toBe(
      "0.3333",
    );
    off();
    publishFlowOffset(null);
  });
});
