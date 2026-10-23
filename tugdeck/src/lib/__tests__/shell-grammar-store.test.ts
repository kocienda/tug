import { describe, it, expect } from "bun:test";

import { ShellGrammarStore } from "../shell-grammar-store";
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

function store(): ShellGrammarStore {
  return new ShellGrammarStore(stubFeedStore(), FeedId.SHELL_OUTPUT, "s1");
}

describe("ShellGrammarStore", () => {
  it("knows nothing about a line until its reply lands", () => {
    expect(store().get("git status")).toBeUndefined();
  });

  it("folds each band", () => {
    for (const band of ["yes", "maybe", "no", "unknown"] as const) {
      const s = store();
      s._ingestForTest({
        type: "shell_grammar",
        tug_session_id: "s1",
        line: "git status",
        band,
      });
      expect(s.get("git status")?.band).toBe(band);
    }
  });

  it("keeps a synopsis on maybe and drops one offered on any other band", () => {
    const s = store();
    s._ingestForTest({
      type: "shell_grammar",
      tug_session_id: "s1",
      line: "git stauts",
      band: "maybe",
      synopsis: "git — the version control system",
    });
    expect(s.get("git stauts")?.synopsis).toContain("git");

    // A synopsis on a non-maybe band would arm the model on a band that is
    // meant to ask the plain question, so it is not carried.
    s._ingestForTest({
      type: "shell_grammar",
      tug_session_id: "s1",
      line: "git status",
      band: "yes",
      synopsis: "git — the version control system",
    });
    expect(s.get("git status")?.synopsis).toBeUndefined();
  });

  it("ignores a frame tagged for another session", () => {
    const s = store();
    s._ingestForTest({
      type: "shell_grammar",
      tug_session_id: "other",
      line: "git status",
      band: "no",
    });
    expect(s.get("git status")).toBeUndefined();
  });

  it("ignores frames of another type and bands it does not know", () => {
    const s = store();
    s._ingestForTest({ type: "path_commands", tug_session_id: "s1", commands: ["git"] });
    s._ingestForTest({
      type: "shell_grammar",
      tug_session_id: "s1",
      line: "git status",
      band: "probably",
    });
    expect(s.get("git status")).toBeUndefined();
  });

  it("keys answers by the exact line", () => {
    const s = store();
    s._ingestForTest({
      type: "shell_grammar",
      tug_session_id: "s1",
      line: "git status",
      band: "yes",
    });
    expect(s.get("git statu")).toBeUndefined();
    expect(s.get("git status ")).toBeUndefined();
  });

  it("answers a cached line without waiting", async () => {
    const s = store();
    s._ingestForTest({
      type: "shell_grammar",
      tug_session_id: "s1",
      line: "git status",
      band: "yes",
    });
    expect((await s.requestWithin("git status", 0)).band).toBe("yes");
  });

  it("settles unanswered requests rather than parking a resolver forever", async () => {
    // Nothing answers in the test environment, which is the same shape as a
    // card whose socket has dropped. A request that never settled would leak a
    // resolver per draft for the life of the session.
    const s = store();
    const pending = s.request("git status");
    s.dispose();
    expect((await pending).band).toBe("unknown");
  });

  it("grades unknown when the submit wait expires", async () => {
    const s = store();
    expect((await s.requestWithin("git status", 5)).band).toBe("unknown");
  });

  it("notifies subscribers on a fold", () => {
    const s = store();
    let fires = 0;
    s.subscribe(() => {
      fires += 1;
    });
    s._ingestForTest({
      type: "shell_grammar",
      tug_session_id: "s1",
      line: "git status",
      band: "yes",
    });
    expect(fires).toBe(1);
  });

  it("clear drops every remembered grade", () => {
    const s = store();
    s._ingestForTest({
      type: "shell_grammar",
      tug_session_id: "s1",
      line: "git status",
      band: "yes",
    });
    s.clear();
    expect(s.get("git status")).toBeUndefined();
  });

  // A disposed store's feed subscription is gone, so a request made after
  // dispose could never be answered — it degrades immediately instead of
  // acquiring a timer and a parked resolver.
  it("acquires nothing after dispose", async () => {
    const s = store();
    s.dispose();
    expect((await s.request("git status")).band).toBe("unknown");
  });

  // `useSyncExternalStore` compares snapshots by identity: the same map
  // handed back across changes would make every change invisible.
  it("publishes a fresh snapshot per change and a stable one between", () => {
    const s = store();
    const before = s.getSnapshot();
    expect(s.getSnapshot()).toBe(before);
    s._ingestForTest({
      type: "shell_grammar",
      tug_session_id: "s1",
      line: "git status",
      band: "yes",
    });
    const after = s.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.get("git status")?.band).toBe("yes");
    expect(s.getSnapshot()).toBe(after);
    s.clear();
    expect(s.getSnapshot()).not.toBe(after);
    expect(s.getSnapshot().size).toBe(0);
  });

  it("bounds what it remembers", () => {
    const s = store();
    for (let i = 0; i < 60; i += 1) {
      s._ingestForTest({
        type: "shell_grammar",
        tug_session_id: "s1",
        line: `git status ${i}`,
        band: "yes",
      });
    }
    expect(s.getSnapshot().size).toBeLessThanOrEqual(32);
    // The most recent survives; the oldest is gone.
    expect(s.get("git status 59")?.band).toBe("yes");
    expect(s.get("git status 0")).toBeUndefined();
  });

  it("is untouched by the shell_words frame it shares the feed with", () => {
    const s = store();
    s._ingestForTest({ type: "shell_grammar", tug_session_id: "s1", line: "git status", band: "yes" });
    const before = s.getSnapshot();
    s._ingestForTest({ type: "shell_words", tug_session_id: "s1", names: ["gs", "setopt"] });
    expect(s.getSnapshot()).toBe(before);
    expect(s.get("git status")?.band).toBe("yes");
  });
});
