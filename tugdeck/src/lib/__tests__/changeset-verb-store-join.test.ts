/**
 * changeset-verb-store — the `changeset_join` round trip's widened wire
 * (Specs S03, S04).
 *
 * This store carries the landing *execute* and nothing else. What a landing
 * would do — blockers, conflicts, a resolved candidate — rides the dash's feed
 * entry, so the phases here describe a landing somebody pressed for: pending,
 * then done / conflict / error. A preview reply is a question the card no
 * longer asks, and settles back to idle rather than standing as a phase that
 * would outrank the feed. And `continue` / `session_id` reach the frame only
 * when the caller asks for them, which is what keeps the widened payload
 * back-compatible with a server that defaults them.
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

describe("the landing round trip", () => {
  test("a landed join settles on done with its commit", () => {
    h.store.join(ENTRY, PROJECT, DASH, { preview: false });
    expect(h.store.joinState(ENTRY).phase).toBe("pending");
    h.reply({
      action: "changeset_join_ok",
      project_dir: PROJECT,
      dash: DASH,
      previewed: false,
      conflicts: [],
      commit_hash: "abc1234",
      summary: "landed 3 files",
    });
    const state = h.store.joinState(ENTRY);
    expect(state.phase).toBe("done");
    expect(state.commitHash).toBe("abc1234");
    expect(state.summary).toBe("landed 3 files");
  });

  test("a join this card never sent still reaches its surfaces", () => {
    // The prompt-sheet route: the server starts the join, so nothing here ever
    // called `join()` — and both terminal frames are dropped on a correlation
    // miss. Without this registration the failure bulletin and the live
    // receipt row both went dark on every prompt-route join.
    h.store.expectServerJoin(ENTRY, PROJECT, DASH);
    expect(h.store.joinState(ENTRY).phase).toBe("pending");
    // And it sends nothing: the join is already under way, and a frame from
    // here would be a second one.
    expect(h.sent).toEqual([]);

    h.reply({
      action: "changeset_join_ok",
      project_dir: PROJECT,
      dash: DASH,
      previewed: false,
      conflicts: [],
      commit_hash: "abc1234",
      summary: "landed 3 files",
    });
    const state = h.store.joinState(ENTRY);
    expect(state.phase).toBe("done");
    // The summary is what `useLandingReceipts` appends the transcript row from.
    expect(state.summary).toBe("landed 3 files");
  });

  test("a server-started join that fails posts the failure it would have swallowed", () => {
    h.store.expectServerJoin(ENTRY, PROJECT, DASH);
    h.reply({
      action: "changeset_join_err",
      project_dir: PROJECT,
      dash: DASH,
      detail: "base moved under the candidate",
    });
    const state = h.store.joinState(ENTRY);
    // `error` is what the mounted LandingNoticeController reads to post the
    // danger bulletin.
    expect(state.phase).toBe("error");
    expect(state.error).toBe("base moved under the candidate");
  });

  test("an execute that aborted names the paths it aborted on", () => {
    h.store.join(ENTRY, PROJECT, DASH, { preview: false });
    h.reply({
      action: "changeset_join_ok",
      project_dir: PROJECT,
      dash: DASH,
      previewed: false,
      conflicts: ["a.rs", "b.rs"],
      commit_hash: null,
    });
    const state = h.store.joinState(ENTRY);
    expect(state.phase).toBe("conflict");
    expect(state.conflicts).toEqual(["a.rs", "b.rs"]);
  });

  test("a preview reply settles to idle rather than outranking the feed", () => {
    // Nothing on the card asks for one any more. If a preview reply does turn
    // up — a stray CLI-shaped frame, an older server — the store must not turn
    // it into a phase, because the landing face reads the feed's join block and
    // a phase here would render beside an answer computed from different heads.
    h.store.join(ENTRY, PROJECT, DASH, { preview: false, continueJoin: true });
    h.reply({
      action: "changeset_join_ok",
      project_dir: PROJECT,
      dash: DASH,
      previewed: true,
      conflicts: ["a.rs"],
      commit_hash: null,
      blockers: [{ kind: "base-dirt", detail: "commit outstanding changes", paths: ["a.ts"] }],
    });
    expect(h.store.joinState(ENTRY).phase).toBe("idle");
    expect(h.store.joinState(ENTRY).conflicts).toEqual([]);
  });

  test("a refusal carries its detail", () => {
    h.store.join(ENTRY, PROJECT, DASH, { preview: false });
    h.reply({
      action: "changeset_join_err",
      project_dir: PROJECT,
      dash: DASH,
      detail: "Nothing to join.",
    });
    const state = h.store.joinState(ENTRY);
    expect(state.phase).toBe("error");
    expect(state.error).toBe("Nothing to join.");
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
    h.store.join(ENTRY, PROJECT, DASH, { preview: false });
    expect(h.sent[0]?.body).toEqual({ project_dir: PROJECT, dash: DASH, preview: false });
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
