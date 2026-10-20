/**
 * The host's calls arrive through the members the registry installs.
 *
 * A host→page member decodes its one payload with its declaration's codec and
 * hands it to the one handler `onHostMessage` registered; a payload the codec
 * refuses reaches nothing, and a member nobody handles says so once. A call
 * the host awaits returns its handler's reply.
 *
 * The declarations used here are ones no page module receives
 * outside the deck's boot (`onScrollPhase`, `onActivationClick`, which only
 * `main.tsx` installs) or receives only at boot (`reauthenticate`), so nothing
 * else in the suite holds their handlers.
 *
 * @covers tugdeck/src/host/channel.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tugDevLogStore } from "../../lib/tug-dev-log-store/tug-dev-log-store";
import { answerPageCall, installHostChannel, onHostMessage, tugdeckPageCalls } from "../channel";
import { reauthenticateCall } from "../declarations/lifecycle";
import { scrollPhaseToPage } from "../declarations/services";

type Scope = { __tugBridge?: Record<string, unknown> };

const scope = globalThis as unknown as Scope;
const originalWarn = tugDevLogStore.warn;
let warnings: string[] = [];
let savedBridge: Record<string, unknown> | undefined;

function member(name: string): (payload?: unknown) => unknown {
  return scope.__tugBridge![name] as (payload?: unknown) => unknown;
}

beforeEach(() => {
  savedBridge = scope.__tugBridge;
  scope.__tugBridge = undefined;
  warnings = [];
  tugDevLogStore.warn = (_source, message) => {
    warnings.push(message);
  };
});

afterEach(() => {
  tugDevLogStore.warn = originalWarn;
  scope.__tugBridge = savedBridge;
});

describe("the host channel's members", () => {
  test("a member decodes its payload and reaches its one handler", () => {
    const got: string[] = [];
    const release = onHostMessage(scrollPhaseToPage, (message) => got.push(message));
    try {
      member("onScrollPhase")("touched");
      expect(got).toEqual(["touched"]);
    } finally {
      release();
    }
  });

  test("a payload its codec refuses reaches no handler, and is said", () => {
    const got: unknown[] = [];
    const release = onHostMessage(scrollPhaseToPage, (message) => got.push(message));
    try {
      member("onScrollPhase")({ edge: "touched" });
      expect(got).toEqual([]);
      expect(warnings.some((w) => w.includes("refused \"onScrollPhase\""))).toBe(true);
    } finally {
      release();
    }
  });

  test("a member with no handler says so once", () => {
    installHostChannel();
    member("onActivationClick")({ x: 1, y: 2 });
    member("onActivationClick")({ x: 1, y: 2 });
    expect(warnings.filter((w) => w.includes("\"onActivationClick\" arrived"))).toHaveLength(1);
  });

  test("a second handler for one member throws", () => {
    const release = onHostMessage(scrollPhaseToPage, () => {});
    try {
      expect(() => onHostMessage(scrollPhaseToPage, () => {})).toThrow(/already has a handler/);
    } finally {
      release();
    }
  });

  test("a release frees the member for another handler", () => {
    const first: string[] = [];
    const second: string[] = [];
    onHostMessage(scrollPhaseToPage, (m) => first.push(m))();
    const release = onHostMessage(scrollPhaseToPage, (m) => second.push(m));
    try {
      member("onScrollPhase")("lifted");
      expect(first).toEqual([]);
      expect(second).toEqual(["lifted"]);
    } finally {
      release();
    }
  });

  test("a member a script wrapped is kept by a later install", () => {
    installHostChannel();
    const wrapped = (): void => {};
    scope.__tugBridge!.onScrollPhase = wrapped;
    installHostChannel();
    expect(scope.__tugBridge!.onScrollPhase).toBe(wrapped);
  });

  test("a page call returns its handler's reply", () => {
    const tokens: string[] = [];
    const release = answerPageCall(reauthenticateCall, (payload) => {
      tokens.push(payload.token);
      return null;
    });
    try {
      expect(tugdeckPageCalls().reauthenticate({ token: "t0k3n" })).toBeNull();
      expect(tokens).toEqual(["t0k3n"]);
    } finally {
      release();
    }
  });
});
