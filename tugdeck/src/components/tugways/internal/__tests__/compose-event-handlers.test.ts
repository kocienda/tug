/**
 * compose-event-handlers.test.ts — the order and the veto of a composed
 * handler: the caller's runs first, and the control's runs unless the caller
 * called `preventDefault()`.
 */

import { describe, expect, test } from "bun:test";

import { composeEventHandlers } from "../compose-event-handlers";

/** A minimal event whose `preventDefault()` flips `defaultPrevented`. */
function makeEvent(): { defaultPrevented: boolean; preventDefault: () => void } {
  const event = {
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  return event;
}

type TestEvent = ReturnType<typeof makeEvent>;

describe("composeEventHandlers", () => {
  test("runs the caller's handler before the control's", () => {
    const calls: string[] = [];
    const composed = composeEventHandlers<TestEvent>(
      () => calls.push("caller"),
      () => calls.push("own"),
    );
    composed(makeEvent());
    expect(calls).toEqual(["caller", "own"]);
  });

  test("skips the control's handler when the caller prevents default", () => {
    const calls: string[] = [];
    const composed = composeEventHandlers<TestEvent>(
      (e) => {
        calls.push("caller");
        e.preventDefault();
      },
      () => calls.push("own"),
    );
    composed(makeEvent());
    expect(calls).toEqual(["caller"]);
  });

  test("runs the control's handler when there is no caller handler", () => {
    const calls: string[] = [];
    const composed = composeEventHandlers<TestEvent>(undefined, () => calls.push("own"));
    composed(makeEvent());
    expect(calls).toEqual(["own"]);
  });

  test("an event already prevented before dispatch skips the control's handler", () => {
    const calls: string[] = [];
    const composed = composeEventHandlers<TestEvent>(
      () => calls.push("caller"),
      () => calls.push("own"),
    );
    const event = makeEvent();
    event.preventDefault();
    composed(event);
    expect(calls).toEqual(["caller"]);
  });

  test("the control's own preventDefault does not affect the caller", () => {
    const calls: string[] = [];
    const composed = composeEventHandlers<TestEvent>(
      () => calls.push("caller"),
      (e) => {
        calls.push("own");
        e.preventDefault();
      },
    );
    const event = makeEvent();
    composed(event);
    expect(calls).toEqual(["caller", "own"]);
    expect(event.defaultPrevented).toBe(true);
  });
});
