/**
 * dictation-bridge — the wire, and how strict it is about what crosses it.
 *
 * The claims pinned here are the ones every later piece of dictation rests on.
 * Each kind in Spec S02 parses to itself, with only the fields that kind has.
 * A payload this build cannot read — no id, a kind it does not know, a
 * `volatile` with no text, an `ended` naming a reason it has never heard of —
 * parses to `null` and reaches no listener, because the alternative is putting
 * unread text in the user's document or holding a claim nothing can release.
 * Availability follows the handler and nothing else, so a dev browser offers
 * no microphone. And installing the receiver twice leaves one, keeping any
 * sibling bridge key beside it — the deck has several receivers on one object
 * and the last one installed must not be the only one.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  dictationEventFromPayload,
  isDictationAvailable,
  mintDictationId,
  startDictation,
  finishDictation,
  stopDictation,
  setDictationListener,
  installDictationBridge,
  type DictationEvent,
  type DictationEndReason,
  type DictationRefusalReason,
} from "../dictation-bridge";

const w = globalThis as unknown as {
  webkit?: unknown;
  __tugBridge?: Record<string, unknown>;
};

describe("dictationEventFromPayload — one fixture per kind", () => {
  it("reads preparing", () => {
    expect(dictationEventFromPayload({ id: "dict-1", kind: "preparing" })).toEqual({
      id: "dict-1",
      kind: "preparing",
    });
  });

  it("reads ready", () => {
    expect(dictationEventFromPayload({ id: "dict-1", kind: "ready" })).toEqual({
      id: "dict-1",
      kind: "ready",
    });
  });

  it("reads level, which the host never sends but the type allows", () => {
    expect(dictationEventFromPayload({ id: "dict-1", kind: "level", level: 0.4 })).toEqual({
      id: "dict-1",
      kind: "level",
      level: 0.4,
    });
  });

  it("reads volatile", () => {
    expect(dictationEventFromPayload({ id: "dict-1", kind: "volatile", text: "hel" })).toEqual({
      id: "dict-1",
      kind: "volatile",
      text: "hel",
    });
  });

  it("reads final", () => {
    expect(
      dictationEventFromPayload({ id: "dict-1", kind: "final", text: "hello world" }),
    ).toEqual({ id: "dict-1", kind: "final", text: "hello world" });
  });

  it("reads an empty text rather than treating it as missing", () => {
    expect(dictationEventFromPayload({ id: "dict-1", kind: "volatile", text: "" })).toEqual({
      id: "dict-1",
      kind: "volatile",
      text: "",
    });
  });

  it("reads every ended reason", () => {
    const reasons: DictationEndReason[] = ["stopped", "superseded", "device-lost", "error"];
    for (const reason of reasons) {
      expect(dictationEventFromPayload({ id: "dict-1", kind: "ended", reason })).toEqual({
        id: "dict-1",
        kind: "ended",
        reason,
      });
    }
  });

  it("reads every refused reason", () => {
    const reasons: DictationRefusalReason[] = [
      "microphone-permission",
      "speech-permission",
      "no-model",
      "no-input-device",
      "unavailable",
      "error",
    ];
    for (const reason of reasons) {
      expect(dictationEventFromPayload({ id: "dict-1", kind: "refused", reason })).toEqual({
        id: "dict-1",
        kind: "refused",
        reason,
      });
    }
  });

  it("carries a message when one is there, and omits the key when it is not", () => {
    expect(
      dictationEventFromPayload({
        id: "dict-1",
        kind: "refused",
        reason: "error",
        message: "no such locale",
      }),
    ).toEqual({ id: "dict-1", kind: "refused", reason: "error", message: "no such locale" });
    expect(
      Object.keys(dictationEventFromPayload({ id: "dict-1", kind: "ended", reason: "stopped" })!),
    ).toEqual(["id", "kind", "reason"]);
  });
});

describe("dictationEventFromPayload — what it refuses", () => {
  it("refuses a missing id", () => {
    expect(dictationEventFromPayload({ kind: "ready" })).toBeNull();
  });

  it("refuses a non-string id", () => {
    expect(dictationEventFromPayload({ id: 7, kind: "ready" })).toBeNull();
  });

  it("refuses an unknown kind", () => {
    expect(dictationEventFromPayload({ id: "dict-1", kind: "listening" })).toBeNull();
  });

  it("refuses a volatile with no text", () => {
    expect(dictationEventFromPayload({ id: "dict-1", kind: "volatile" })).toBeNull();
  });

  it("refuses a final whose text is not a string", () => {
    expect(dictationEventFromPayload({ id: "dict-1", kind: "final", text: 12 })).toBeNull();
  });

  it("refuses an ended with an unknown reason", () => {
    expect(dictationEventFromPayload({ id: "dict-1", kind: "ended", reason: "bored" })).toBeNull();
  });

  it("refuses an ended with no reason at all", () => {
    expect(dictationEventFromPayload({ id: "dict-1", kind: "ended" })).toBeNull();
  });

  it("refuses a refused carrying an ended's reason", () => {
    expect(
      dictationEventFromPayload({ id: "dict-1", kind: "refused", reason: "superseded" }),
    ).toBeNull();
  });

  it("refuses a level with no level", () => {
    expect(dictationEventFromPayload({ id: "dict-1", kind: "level" })).toBeNull();
  });

  it("refuses payloads that are not objects", () => {
    for (const payload of [null, undefined, "ready", 3, true, []]) {
      expect(dictationEventFromPayload(payload)).toBeNull();
    }
  });
});

describe("the host handler", () => {
  let savedWebkit: unknown;
  let savedBridge: unknown;

  beforeEach(() => {
    savedWebkit = w.webkit;
    savedBridge = w.__tugBridge;
    w.webkit = undefined;
    w.__tugBridge = undefined;
    setDictationListener(null);
  });

  afterEach(() => {
    if (savedWebkit === undefined) delete w.webkit;
    else w.webkit = savedWebkit;
    if (savedBridge === undefined) delete w.__tugBridge;
    else w.__tugBridge = savedBridge as Record<string, unknown>;
    setDictationListener(null);
  });

  it("is unavailable with no webkit at all", () => {
    expect(isDictationAvailable()).toBe(false);
  });

  it("is unavailable when webkit is there but the handler is not", () => {
    w.webkit = { messageHandlers: {} };
    expect(isDictationAvailable()).toBe(false);
  });

  it("is available when the handler is present", () => {
    w.webkit = { messageHandlers: { dictation: { postMessage: () => {} } } };
    expect(isDictationAvailable()).toBe(true);
  });

  it("posts start, stop and finish in the shape the host parses", () => {
    const posted: unknown[] = [];
    w.webkit = { messageHandlers: { dictation: { postMessage: (v: unknown) => posted.push(v) } } };
    startDictation("dict-4");
    stopDictation("dict-4");
    finishDictation("dict-4");
    expect(posted).toEqual([
      { id: "dict-4", verb: "start" },
      { id: "dict-4", verb: "stop" },
      { id: "dict-4", verb: "finish" },
    ]);
  });

  it("posts nothing outside the host rather than throwing", () => {
    expect(() => {
      startDictation("dict-4");
      stopDictation("dict-4");
      finishDictation("dict-4");
    }).not.toThrow();
  });

  it("mints a fresh id every time", () => {
    const first = mintDictationId();
    const second = mintDictationId();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^dict-\d+$/);
    expect(second).toMatch(/^dict-\d+$/);
  });
});

describe("installDictationBridge", () => {
  let savedBridge: unknown;

  beforeEach(() => {
    savedBridge = w.__tugBridge;
    w.__tugBridge = undefined;
    setDictationListener(null);
  });

  afterEach(() => {
    if (savedBridge === undefined) delete w.__tugBridge;
    else w.__tugBridge = savedBridge as Record<string, unknown>;
    setDictationListener(null);
  });

  it("installs the receiver and forwards parsed events to the listener", () => {
    const seen: DictationEvent[] = [];
    setDictationListener((event) => seen.push(event));
    installDictationBridge();
    (w.__tugBridge!.onDictation as (p: unknown) => void)({
      id: "dict-1",
      kind: "final",
      text: "hello",
    });
    expect(seen).toEqual([{ id: "dict-1", kind: "final", text: "hello" }]);
  });

  it("merges into a shared bridge rather than replacing it", () => {
    const other = () => {};
    w.__tugBridge = { onUpdateState: other };
    installDictationBridge();
    expect(w.__tugBridge.onUpdateState).toBe(other);
    expect(typeof w.__tugBridge.onDictation).toBe("function");
  });

  it("installing twice leaves the first receiver in place", () => {
    installDictationBridge();
    const first = w.__tugBridge!.onDictation;
    installDictationBridge();
    expect(w.__tugBridge!.onDictation).toBe(first);
  });

  it("drops a malformed payload rather than calling the listener", () => {
    let calls = 0;
    setDictationListener(() => {
      calls += 1;
    });
    installDictationBridge();
    const onDictation = w.__tugBridge!.onDictation as (p: unknown) => void;
    onDictation({ id: "dict-1", kind: "ended", reason: "bored" });
    onDictation({ kind: "ready" });
    onDictation("ready");
    expect(calls).toBe(0);
  });

  it("drops events when no listener is registered rather than throwing", () => {
    installDictationBridge();
    const onDictation = w.__tugBridge!.onDictation as (p: unknown) => void;
    expect(() => onDictation({ id: "dict-1", kind: "ready" })).not.toThrow();
  });
});
