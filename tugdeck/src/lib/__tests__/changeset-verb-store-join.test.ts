/**
 * changeset-verb-store — the `changeset_join` round trip's widened wire
 * (Specs S03, S04).
 *
 * Three facts live here. A preview that reports blockers is still a *preview* —
 * blocked is a finding about one, not a phase — so the landing surface reads
 * `blockers` to pick its face rather than watching for a phase that never
 * comes. A blocker the deck cannot parse is dropped rather than thrown on, so
 * one malformed entry never costs the user the blockers beside it. And
 * `continue` / `session_id` reach the frame only when the caller asks for them,
 * which is what keeps the widened payload back-compatible with a server that
 * defaults them.
 *
 * Drives the real store through a fake `TugConnection`, the way the claim tests
 * do: the CONTROL handler the store registers is captured and invoked with
 * encoded payloads, so `_onControl` itself is under test.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { ChangesetVerbStore } from "../changeset-verb-store";

const ENTRY = "session:s1";
const PROJECT = "/proj";
const DASH = "join-lane";

interface Sent {
  action: string;
  body: Record<string, unknown>;
}

function harness(): {
  store: ChangesetVerbStore;
  sent: Sent[];
  reply: (body: Record<string, unknown>) => void;
} {
  let handler: ((payload: Uint8Array) => void) | null = null;
  const sent: Sent[] = [];
  const conn = {
    onFrame: (_feed: number, cb: (payload: Uint8Array) => void) => {
      handler = cb;
      return () => {};
    },
    sendControlFrame: (action: string, body: Record<string, unknown>) => {
      sent.push({ action, body });
    },
  } as never;
  const store = new ChangesetVerbStore(conn);
  const reply = (body: Record<string, unknown>): void => {
    if (handler === null) throw new Error("no CONTROL handler registered");
    handler(new TextEncoder().encode(JSON.stringify(body)));
  };
  return { store, sent, reply };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

describe("changeset join blockers", () => {
  test("a blocked preview is still a preview, and its blockers are readable", () => {
    h.store.join(ENTRY, PROJECT, DASH, { preview: true });
    h.reply({
      action: "changeset_join_ok",
      project_dir: PROJECT,
      dash: DASH,
      previewed: true,
      conflicts: [],
      commit_hash: null,
      blockers: [
        {
          kind: "base-dirt",
          detail: "Cannot join: … (a.ts). Commit or stash them first.",
          paths: ["a.ts"],
        },
      ],
    });

    const state = h.store.joinState(ENTRY);
    expect(state.phase).toBe("preview");
    expect(state.blockers).toHaveLength(1);
    expect(state.blockers[0]?.kind).toBe("base-dirt");
    expect(state.blockers[0]?.paths).toEqual(["a.ts"]);
  });

  test("a clean preview carries no blockers", () => {
    h.store.join(ENTRY, PROJECT, DASH, { preview: true });
    h.reply({
      action: "changeset_join_ok",
      project_dir: PROJECT,
      dash: DASH,
      previewed: true,
      conflicts: [],
      commit_hash: null,
    });
    expect(h.store.joinState(ENTRY).blockers).toEqual([]);
  });

  test("a malformed blocker is dropped, not thrown on", () => {
    h.store.join(ENTRY, PROJECT, DASH, { preview: true });
    h.reply({
      action: "changeset_join_ok",
      project_dir: PROJECT,
      dash: DASH,
      previewed: true,
      conflicts: [],
      commit_hash: null,
      blockers: [
        null,
        { kind: "off-base" },
        { detail: "no kind" },
        { kind: "", detail: "empty kind" },
        { kind: "empty", detail: "Nothing to join.", paths: ["ok.ts", 7] },
      ],
    });

    const { blockers } = h.store.joinState(ENTRY);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.kind).toBe("empty");
    // A non-string path is dropped with the same discipline.
    expect(blockers[0]?.paths).toEqual(["ok.ts"]);
  });

  test("a landed join clears the blockers it previewed with", () => {
    h.store.join(ENTRY, PROJECT, DASH, { preview: false });
    h.reply({
      action: "changeset_join_ok",
      project_dir: PROJECT,
      dash: DASH,
      previewed: false,
      conflicts: [],
      commit_hash: "abc1234",
    });
    const state = h.store.joinState(ENTRY);
    expect(state.phase).toBe("done");
    expect(state.commitHash).toBe("abc1234");
    expect(state.blockers).toEqual([]);
  });
});

describe("changeset join payload", () => {
  test("continue and session_id ride only when asked for", () => {
    h.store.join(ENTRY, PROJECT, DASH, { preview: false, continueJoin: true });
    expect(h.sent[0]?.body).toEqual({
      project_dir: PROJECT,
      dash: DASH,
      preview: false,
      continue: true,
    });
  });

  test("a bare join sends neither", () => {
    h.store.join(ENTRY, PROJECT, DASH, { preview: true });
    expect(h.sent[0]?.body).toEqual({ project_dir: PROJECT, dash: DASH, preview: true });
  });

  test("the session id rides the land so the receipt has a home", () => {
    h.store.join(ENTRY, PROJECT, DASH, { preview: false, message: "m", sessionId: "sess-1" });
    expect(h.sent[0]?.body).toEqual({
      project_dir: PROJECT,
      dash: DASH,
      preview: false,
      message: "m",
      session_id: "sess-1",
    });
  });

  test("discard carries the session id too, and omits it when absent", () => {
    h.store.discard(ENTRY, PROJECT, DASH, "sess-1");
    expect(h.sent[0]).toEqual({
      action: "changeset_discard",
      body: { project_dir: PROJECT, dash: DASH, session_id: "sess-1" },
    });

    const bare = harness();
    bare.store.discard(ENTRY, PROJECT, DASH);
    expect(bare.sent[0]).toEqual({
      action: "changeset_discard",
      body: { project_dir: PROJECT, dash: DASH },
    });
  });
});
