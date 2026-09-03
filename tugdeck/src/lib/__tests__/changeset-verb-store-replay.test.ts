/**
 * changeset-verb-store — the `changeset_replay` round trip (Spec S01).
 *
 * A replay's common answers move nothing: `current` had nothing to do,
 * `deferred` failed a precondition, `conflicted` stopped at a round. So the
 * thing under test is not really the phase — it is whether the *words* survive
 * the fold, because they are the only evidence a press produced anything at
 * all. A `deferred` that arrives without its `detail`, or an outcome that never
 * reaches the notice store, is a dead button with extra steps.
 *
 * Drives the real store through a fake `TugConnection`, as the join and claim
 * tests do, so `_onControl` itself is under test.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { ChangesetVerbStore } from "../changeset-verb-store";
import { arcReplayOutcomeStore } from "../arc-replay-outcome-store";

const ENTRY = "session:s1";
const PROJECT = "/proj";
const ARC = "replay-lane";
const SESSION = "sess-1";

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
  arcReplayOutcomeStore.clear(SESSION);
});

describe("the replay round trip", () => {
  test("the frame is the discard's shape, session id and all", () => {
    h.store.replay(ENTRY, PROJECT, ARC, SESSION);
    expect(h.sent[0]).toEqual({
      action: "changeset_replay",
      body: { project_dir: PROJECT, arc: ARC, session_id: SESSION },
    });

    const bare = harness();
    bare.store.replay(ENTRY, PROJECT, ARC);
    expect(bare.sent[0]).toEqual({
      action: "changeset_replay",
      body: { project_dir: PROJECT, arc: ARC },
    });
  });

  test("a send is pending until the answer arrives", () => {
    expect(h.store.replayState(ENTRY).phase).toBe("idle");
    h.store.replay(ENTRY, PROJECT, ARC, SESSION);
    expect(h.store.replayState(ENTRY).phase).toBe("pending");
  });

  test("a replayed arc settles on done carrying the word", () => {
    h.store.replay(ENTRY, PROJECT, ARC, SESSION);
    h.reply({
      action: "changeset_replay_ok",
      project_dir: PROJECT,
      arc: ARC,
      outcome: "replayed",
      base_head: "abc1234",
    });
    const state = h.store.replayState(ENTRY);
    expect(state.phase).toBe("done");
    expect(state.outcome).toBe("replayed");
  });

  test("a deferred replay keeps the detail that is its only voice", () => {
    h.store.replay(ENTRY, PROJECT, ARC, SESSION);
    h.reply({
      action: "changeset_replay_ok",
      project_dir: PROJECT,
      arc: ARC,
      session_id: SESSION,
      outcome: "deferred",
      reason: "dirty-worktree",
      detail: "arc 'replay-lane' has uncommitted changes",
    });
    const state = h.store.replayState(ENTRY);
    expect(state.outcome).toBe("deferred");
    expect(state.detail).toBe("arc 'replay-lane' has uncommitted changes");

    const posted = arcReplayOutcomeStore.outcomeFor(SESSION);
    expect(posted?.outcome).toBe("deferred");
    expect(posted?.detail).toBe("arc 'replay-lane' has uncommitted changes");
  });

  test("a conflicted replay carries its round and paths to the notice", () => {
    h.store.replay(ENTRY, PROJECT, ARC, SESSION);
    h.reply({
      action: "changeset_replay_ok",
      project_dir: PROJECT,
      arc: ARC,
      session_id: SESSION,
      outcome: "conflicted",
      round: "def4567",
      round_subject: "teach the row to speak",
      paths: ["src/a.ts", "src/b.ts"],
    });
    const posted = arcReplayOutcomeStore.outcomeFor(SESSION);
    expect(posted?.outcome).toBe("conflicted");
    expect(posted?.roundSubject).toBe("teach the row to speak");
    expect(posted?.paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a refusal settles on error and reaches the notice too", () => {
    h.store.replay(ENTRY, PROJECT, ARC, SESSION);
    h.reply({
      action: "changeset_replay_err",
      project_dir: PROJECT,
      arc: ARC,
      session_id: SESSION,
      detail: "not a git repository",
    });
    const state = h.store.replayState(ENTRY);
    expect(state.phase).toBe("error");
    expect(state.error).toBe("not a git repository");
    expect(arcReplayOutcomeStore.outcomeFor(SESSION)?.outcome).toBe("error");
  });

  test("a reply for a replay this card never sent is ignored", () => {
    h.reply({
      action: "changeset_replay_ok",
      project_dir: PROJECT,
      arc: ARC,
      outcome: "current",
    });
    expect(h.store.replayState(ENTRY).phase).toBe("idle");
  });
});

describe("the outcome notice store", () => {
  test("two identical outcomes in a row both notify", () => {
    let woken = 0;
    const unsubscribe = arcReplayOutcomeStore.subscribe(() => {
      woken += 1;
    });

    const post = (): void => {
      h.store.replay(ENTRY, PROJECT, ARC, SESSION);
      h.reply({
        action: "changeset_replay_ok",
        project_dir: PROJECT,
        arc: ARC,
        session_id: SESSION,
        outcome: "current",
      });
    };
    post();
    const first = arcReplayOutcomeStore.outcomeFor(SESSION);
    post();
    const second = arcReplayOutcomeStore.outcomeFor(SESSION);

    unsubscribe();
    expect(woken).toBeGreaterThanOrEqual(2);
    // Identical in every field but the seq — which is the whole point: a reader
    // keyed on content alone would report the first press and swallow the second.
    expect(second?.outcome).toBe("current");
    expect(first?.outcome).toBe("current");
    expect((second?.seq ?? 0) > (first?.seq ?? 0)).toBe(true);
  });

  test("a replay with no session id says nothing", () => {
    h.store.replay(ENTRY, PROJECT, ARC);
    h.reply({
      action: "changeset_replay_ok",
      project_dir: PROJECT,
      arc: ARC,
      outcome: "deferred",
      reason: "dirty-worktree",
      detail: "arc 'replay-lane' has uncommitted changes",
    });
    expect(arcReplayOutcomeStore.outcomeFor(SESSION)).toBeNull();
  });
});
