/**
 * Pin the cache in front of `resolve_ideas`, as
 * `docket-citation-store.test.ts` pins the one in front of `resolve_dockets`:
 * driven through the constructor's `send` and `timer` seams, whose records
 * are the store's output.
 */

import { describe, expect, test } from "bun:test";

import {
  IDEA_ASK_DEADLINE_MS,
  IdeaCitationStore,
  type DeadlineTimer,
  type ResolveIdeasOk,
} from "@/lib/idea-citation-store";
import { decodeIdeaVerbOk } from "@/protocol";

/** A timer whose deadlines fire only when the test says so. */
function manualTimer() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timer: DeadlineTimer = {
    set(fn, ms) {
      const handle = next++;
      pending.set(handle, { fn, ms });
      return handle;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  const fireAll = () => {
    const due = [...pending.values()];
    pending.clear();
    for (const { fn } of due) fn();
  };
  return { timer, pending, fireAll };
}

function storeWithWire() {
  const sent: { projectDir: string; ids: string[] }[] = [];
  const clock = manualTimer();
  const store = new IdeaCitationStore((projectDir, ids) => {
    sent.push({ projectDir, ids: [...ids] });
    return true;
  }, clock.timer);
  return { store, sent, clock };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function answer(payload: Record<string, unknown>): ResolveIdeasOk {
  const decoded = decodeIdeaVerbOk({
    action: "resolve_ideas_ok",
    request_id: "r1",
    project_dir: "/repo",
    ...payload,
  });
  if (decoded === null || decoded.verb !== "resolve_ideas") throw new Error("undecodable");
  return decoded;
}

describe("idea citation store", () => {
  test("asks once per id, batched per asking project", async () => {
    const { store, sent } = storeWithWire();
    store.request("/repo", "1a2b3c4d");
    store.request("/repo", "1a2b3c4e");
    store.request("/repo", "1a2b3c4d");
    store.request("/other", "9e8d7c6b");
    await flush();
    expect(sent).toEqual([
      { projectDir: "/repo", ids: ["1a2b3c4d", "1a2b3c4e"] },
      { projectDir: "/other", ids: ["9e8d7c6b"] },
    ]);
    store.request("/repo", "1a2b3c4d");
    await flush();
    expect(sent.length).toBe(2);
  });

  test("an answer settles found and missing ids and tells subscribers", async () => {
    const { store } = storeWithWire();
    const heard: string[][] = [];
    store.subscribe((ids) => heard.push([...ids]));
    store.request("/repo", "1a2b3c4d");
    store.request("/repo", "00ff00ff");
    await flush();
    store.applyResolved(
      answer({
        ideas: [
          {
            id: "1a2b3c4d",
            found: true,
            project_dir: "/repo",
            text: "An inbox",
            docket: { id: "5c2e81a0", name: "Inbox" },
            sketch: { id: "3f9a1c2e", version: 2 },
          },
          { id: "00ff00ff", found: false },
        ],
      }),
    );
    expect(store.getAnswer("1a2b3c4d")).toEqual({
      status: "found",
      projectDir: "/repo",
      text: "An inbox",
      docket: "Inbox",
      sketch: "3f9a1c2e",
    });
    expect(store.getAnswer("00ff00ff")).toEqual({ status: "missing" });
    expect(heard).toEqual([["1a2b3c4d", "00ff00ff"]]);
  });

  test("an ask nobody answers is given up at its deadline and asked again", async () => {
    const { store, sent, clock } = storeWithWire();
    store.request("/repo", "1a2b3c4d");
    await flush();
    expect([...clock.pending.values()].map((d) => d.ms)).toEqual([IDEA_ASK_DEADLINE_MS]);
    clock.fireAll();
    expect(store.getAnswer("1a2b3c4d")).toEqual({ status: "pending" });
    store.request("/repo", "1a2b3c4d");
    await flush();
    expect(sent.length).toBe(2);
  });

  test("a deadline after the answer changes nothing", async () => {
    const { store, clock } = storeWithWire();
    store.request("/repo", "00ff00ff");
    await flush();
    store.applyResolved(answer({ ideas: [{ id: "00ff00ff", found: false }] }));
    clock.fireAll();
    expect(store.getAnswer("00ff00ff")).toEqual({ status: "missing" });
  });

  test("a refusal forgets only what was pending, and dispose clears deadlines", async () => {
    const { store, sent, clock } = storeWithWire();
    store.request("/repo", "1a2b3c4d");
    await flush();
    store.applyFailed();
    expect(store.getAnswer("1a2b3c4d")).toEqual({ status: "pending" });
    store.request("/repo", "1a2b3c4d");
    await flush();
    expect(sent.length).toBe(2);
    store.dispose();
    expect(clock.pending.size).toBe(0);
  });

  test("no transport claims nothing", async () => {
    const store = new IdeaCitationStore(() => false, manualTimer().timer);
    store.request("/repo", "1a2b3c4d");
    await flush();
    expect(store.getAnswer("1a2b3c4d")).toEqual({ status: "pending" });
  });
});
