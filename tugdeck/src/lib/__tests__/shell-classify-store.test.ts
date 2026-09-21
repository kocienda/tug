import { afterEach, describe, it, expect, jest, mock } from "bun:test";

// Capture the SHELL_INPUT frames `request` sends. Mocked before importing the
// store (the sibling side-question-store test's pattern). The transport
// swallows frames so a request genuinely parks; `connected` off is the
// no-transport posture. `setConnection` is the real setter, frozen before the
// mock lands, so this file-wide mock cannot swallow another suite's call to it
// — the mutual defection that used to make every one of these files mock
// defensively. [B10]
let sends: Array<{ feedId: number; payload: string }> = [];
let connected = false;
import { setConnection as _realSetConnection } from "../connection-singleton";
const realSetConnection = _realSetConnection;
mock.module("../connection-singleton", () => ({
  getConnection: () =>
    connected
      ? {
          send: (feedId: number, payload: Uint8Array) => {
            sends.push({ feedId, payload: new TextDecoder().decode(payload) });
          },
        }
      : null,
  setConnection: realSetConnection,
}));

import { CLASSIFY_REQUEST_TIMEOUT_MS, ShellClassifyStore } from "../shell-classify-store";
import { FeedId } from "../../protocol";
import type { FeedStore } from "../feed-store";

// A minimal feed-store collaborator: the store only reads `subscribe` (to
// install its listener) and `getSnapshot` (to fold the latest frame). Frames
// arrive in these tests via the `_ingestForTest` seam.
function stubFeedStore(): FeedStore {
  return {
    subscribe: () => () => {},
    getSnapshot: () => new Map(),
  } as unknown as FeedStore;
}

function store(): ShellClassifyStore {
  return new ShellClassifyStore(stubFeedStore(), FeedId.SHELL_OUTPUT, "s1");
}

// Turn the mocked transport on with a fresh capture, the state the
// no-connection default can never reach.
function stubConnection(): { sends: Array<{ feedId: number; payload: string }> } {
  connected = true;
  sends = [];
  return { sends };
}

function reply(
  line: string,
  withGrammar: boolean,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "shell_classify",
    tug_session_id: "s1",
    line,
    with_grammar: withGrammar,
    ...body,
  };
}

describe("ShellClassifyStore", () => {
  afterEach(() => {
    jest.useRealTimers();
    connected = false;
  });

  it("knows nothing about a line until its reply lands", () => {
    expect(store().get("ls -la")).toBeUndefined();
  });

  it("folds both verdicts", () => {
    for (const verdict of ["shell", "prompt"] as const) {
      const s = store();
      s._ingestForTest(reply("ls -la", false, { ok: true, verdict }));
      expect(s.get("ls -la")).toBe(verdict);
    }
  });

  // The correlation key is the pair, not the line. The same text asked with
  // and without documentation is two different questions, and a reply to one
  // must never answer the other.
  it("keeps the documented and undocumented questions apart", () => {
    const s = store();
    s._ingestForTest(reply("curl -sS x", true, { ok: true, verdict: "shell" }));
    expect(s.get("curl -sS x", "usage: curl")).toBe("shell");
    expect(s.get("curl -sS x")).toBeUndefined();

    s._ingestForTest(reply("curl -sS x", false, { ok: true, verdict: "prompt" }));
    expect(s.get("curl -sS x")).toBe("prompt");
    expect(s.get("curl -sS x", "usage: curl")).toBe("shell");
  });

  // Every failure shape is one answer to the caller, because the caller does
  // the same thing with all of them: send the line to Claude.
  it("resolves every failure shape to no opinion", async () => {
    for (const body of [
      { ok: false, verdict: null, error: "shared agent unavailable" },
      { ok: false, verdict: null, error: "classification did not name a label" },
      { ok: true, verdict: "maybe" },
      { ok: true },
    ]) {
      stubConnection();
      const s = store();
      const asked = s.request("make it pretty");
      s._ingestForTest(reply("make it pretty", false, body));
      expect(await asked).toBeNull();
    }
  });

  // A failure is a fact about the agent at one moment, not an answer about the
  // line — and `request` hands back a cached answer without asking. Remembering
  // one would make the question unaskable for the rest of the session: the
  // first `gs` that found the classify lane cold would send every later `gs` to
  // Claude too.
  it("does not remember a failure as an answer", async () => {
    const { sends } = stubConnection();
    const s = store();
    const first = s.request("gs");
    s._ingestForTest(reply("gs", false, { ok: false, verdict: null, error: "unavailable" }));
    expect(await first).toBeNull();
    expect(s.get("gs")).toBeUndefined();

    // Asked again — a second frame on the wire, not the failure handed back.
    expect(sends.length).toBe(1);
    const second = s.request("gs");
    expect(sends.length).toBe(2);
    s._ingestForTest(reply("gs", false, { ok: true, verdict: "shell" }));
    expect(await second).toBe("shell");
  });

  it("ignores another session's reply and a malformed frame", () => {
    const s = store();
    s._ingestForTest({
      type: "shell_classify",
      tug_session_id: "s2",
      line: "ls -la",
      with_grammar: false,
      ok: true,
      verdict: "shell",
    });
    expect(s.get("ls -la")).toBeUndefined();

    // No `with_grammar` means no correlation key, so there is nothing to file.
    s._ingestForTest({
      type: "shell_classify",
      tug_session_id: "s1",
      line: "ls -la",
      ok: true,
      verdict: "shell",
    });
    expect(s.get("ls -la")).toBeUndefined();

    s._ingestForTest(reply("ls -la", false, { ok: true, verdict: "shell" }));
    expect(s.get("ls -la")).toBe("shell");
  });

  // With no transport there is no request to park, so the answer is immediate
  // rather than a wait that could only ever expire.
  it("answers at once when there is nothing to ask over", async () => {
    expect(await store().request("ls -la")).toBeNull();
  });

  it("hands back a cached answer without asking again", async () => {
    const s = store();
    s._ingestForTest(reply("ls -la", false, { ok: true, verdict: "shell" }));
    expect(await s.request("ls -la")).toBe("shell");
    expect(await s.requestWithin("ls -la", 0)).toBe("shell");
  });

  it("clears its cache with the grade cache on draft teardown", () => {
    const s = store();
    s._ingestForTest(reply("ls -la", false, { ok: true, verdict: "shell" }));
    s.clear();
    expect(s.get("ls -la")).toBeUndefined();
  });

  it("notifies subscribers when a verdict lands, and stops after dispose", () => {
    const s = store();
    let seen = 0;
    const unsubscribe = s.subscribe(() => {
      seen += 1;
    });
    s._ingestForTest(reply("ls -la", false, { ok: true, verdict: "shell" }));
    expect(seen).toBe(1);
    s.dispose();
    s._ingestForTest(reply("git status", false, { ok: true, verdict: "shell" }));
    expect(seen).toBe(1);
    unsubscribe();
  });

  it("resolves a parked request when its reply lands on the feed", async () => {
    const { sends } = stubConnection();
    const s = store();
    const pending = s.request("ls -la");
    expect(sends.length).toBe(1);
    s._ingestForTest(reply("ls -la", false, { ok: true, verdict: "shell" }));
    expect(await pending).toBe("shell");
    expect(s.get("ls -la")).toBe("shell");
  });

  // The triad: this constant, the classify JobSpec ceiling in tugcast, and the
  // composer's submit wait bound the same pause and must agree — and when it
  // passes with no reply, the parked resolver gets no opinion and its timer is
  // retired, so the question can be asked again.
  it("expires an unanswered request to no opinion after the triad's two seconds", async () => {
    jest.useFakeTimers();
    const { sends } = stubConnection();
    const s = store();
    const pending = s.request("ls -la");
    expect(sends.length).toBe(1);
    jest.advanceTimersByTime(CLASSIFY_REQUEST_TIMEOUT_MS);
    expect(await pending).toBeNull();
    // Nothing was cached and nothing is parked: the same question asks again.
    expect(s.get("ls -la")).toBeUndefined();
    void s.request("ls -la");
    expect(sends.length).toBe(2);
    s.dispose();
  });

  // A disposed store's feed subscription is gone, so a frame sent after
  // dispose could never be answered — the request must not reach the wire.
  it("acquires nothing after dispose", async () => {
    const { sends } = stubConnection();
    const s = store();
    s.dispose();
    expect(await s.request("ls -la")).toBeNull();
    expect(sends.length).toBe(0);
  });

  // `useSyncExternalStore` compares snapshots by identity: the same map
  // handed back across changes would make every change invisible.
  it("publishes a fresh snapshot per change and a stable one between", () => {
    const s = store();
    const before = s.getSnapshot();
    expect(s.getSnapshot()).toBe(before);
    s._ingestForTest(reply("ls -la", false, { ok: true, verdict: "shell" }));
    const after = s.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.get("-:ls -la")).toBe("shell");
    expect(s.getSnapshot()).toBe(after);
    s.clear();
    expect(s.getSnapshot()).not.toBe(after);
    expect(s.getSnapshot().size).toBe(0);
  });

  it("settles a parked request rather than leaking its resolver on dispose", async () => {
    const { sends } = stubConnection();
    const s = store();
    const pending = s.request("git status");
    expect(sends.length).toBe(1);
    s.dispose();
    expect(await pending).toBeNull();
  });

  it("bounds what it remembers", () => {
    const s = store();
    for (let i = 0; i < 60; i += 1) {
      s._ingestForTest(reply(`ls ${i}`, false, { ok: true, verdict: "shell" }));
    }
    expect(s.getSnapshot().size).toBeLessThanOrEqual(32);
    // The most recent survives; the oldest is gone.
    expect(s.get("ls 59")).toBe("shell");
    expect(s.get("ls 0")).toBeUndefined();
  });

  it("is untouched by the shell_words frame it shares the feed with", () => {
    const s = store();
    s._ingestForTest(reply("ls", false, { ok: true, verdict: "shell" }));
    const before = s.getSnapshot();
    s._ingestForTest({ type: "shell_words", tug_session_id: "s1", names: ["gs", "setopt"] });
    expect(s.getSnapshot()).toBe(before);
    expect(s.get("ls")).toBe("shell");
  });
});
