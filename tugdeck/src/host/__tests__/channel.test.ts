/**
 * The host's calls arrive through the members the registry installs.
 *
 * A host→page member decodes its one payload with its declaration's codec and
 * hands it to the one handler `onHostMessage` registered; a payload the codec
 * refuses reaches nothing, and a member nobody handles says so once. A call
 * the host awaits returns its handler's reply.
 *
 * The declarations used here are ones no page module receives
 * (`onDevModeError`, `onSourceTreeCancelled`) or receives only at boot
 * (`reauthenticate`), so nothing else in the suite holds their handlers.
 *
 * @covers tugdeck/src/host/channel.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tugDevLogStore } from "../../lib/tug-dev-log-store/tug-dev-log-store";
import { answerPageCall, installHostChannel, onHostMessage, tugdeckPageCalls } from "../channel";
import { reauthenticateCall } from "../declarations/lifecycle";
import { devModeErrorToPage } from "../declarations/services";

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
    const release = onHostMessage(devModeErrorToPage, (message) => got.push(message));
    try {
      member("onDevModeError")("no tugdeck here");
      expect(got).toEqual(["no tugdeck here"]);
    } finally {
      release();
    }
  });

  test("a payload its codec refuses reaches no handler, and is said", () => {
    const got: unknown[] = [];
    const release = onHostMessage(devModeErrorToPage, (message) => got.push(message));
    try {
      member("onDevModeError")({ message: "an object, not a string" });
      expect(got).toEqual([]);
      expect(warnings.some((w) => w.includes("refused \"onDevModeError\""))).toBe(true);
    } finally {
      release();
    }
  });

  test("a member with no handler says so once", () => {
    installHostChannel();
    member("onSourceTreeCancelled")({});
    member("onSourceTreeCancelled")({});
    expect(warnings.filter((w) => w.includes("\"onSourceTreeCancelled\" arrived"))).toHaveLength(1);
  });

  test("a second handler for one member throws", () => {
    const release = onHostMessage(devModeErrorToPage, () => {});
    try {
      expect(() => onHostMessage(devModeErrorToPage, () => {})).toThrow(/already has a handler/);
    } finally {
      release();
    }
  });

  test("a release frees the member for another handler", () => {
    const first: string[] = [];
    const second: string[] = [];
    onHostMessage(devModeErrorToPage, (m) => first.push(m))();
    const release = onHostMessage(devModeErrorToPage, (m) => second.push(m));
    try {
      member("onDevModeError")("after the release");
      expect(first).toEqual([]);
      expect(second).toEqual(["after the release"]);
    } finally {
      release();
    }
  });

  test("a member a script wrapped is kept by a later install", () => {
    installHostChannel();
    const wrapped = (): void => {};
    scope.__tugBridge!.onDevModeError = wrapped;
    installHostChannel();
    expect(scope.__tugBridge!.onDevModeError).toBe(wrapped);
  });

  test("a page call returns its handler's reply", () => {
    const tokens: string[] = [];
    const release = answerPageCall(reauthenticateCall, (payload) => {
      tokens.push((payload as { token: string }).token);
      return "answered";
    });
    try {
      expect(tugdeckPageCalls().reauthenticate({ token: "t0k3n" })).toBe("answered");
      expect(tokens).toEqual(["t0k3n"]);
    } finally {
      release();
    }
  });
});
