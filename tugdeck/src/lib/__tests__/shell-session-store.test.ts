/**
 * ShellSessionStore — folds SHELL_OUTPUT into session state and mirrors each
 * exchange into CodeSessionStore ([P12]). Drives the real store's fold + the
 * real CodeSessionStore reducer via a minimal feed double (the sibling
 * side-question-store test's pattern) — no DOM, no mock-store assertions.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Capture SHELL_INPUT frames `exec`/`kill` send. Mocked before importing the store.
// `setConnection` is the real setter, frozen before the mock lands, so this
// file-wide mock cannot swallow another suite's call to it. [B10]
let sentFrames: Array<{ feedId: number; payload: string }> = [];
import { setConnection as _realSetConnection } from "../connection-singleton";
const realSetConnection = _realSetConnection;
mock.module("../connection-singleton", () => ({
  getConnection: () => ({
    send: (feedId: number, payload: Uint8Array) => {
      sentFrames.push({ feedId, payload: new TextDecoder().decode(payload) });
    },
    trySend: (feedId: number, payload: Uint8Array) => {
      sentFrames.push({ feedId, payload: new TextDecoder().decode(payload) });
      return true;
    },
    onFrame: () => () => {},
  }),
  setConnection: realSetConnection,
}));

import { FeedId } from "../../protocol";
import { ShellSessionStore, applyRestoredShellExchanges } from "../shell-session-store";
import { PendingContextStore, splitLeadingContext } from "../pending-context-store";
import { CodeSessionStore } from "../code-session-store";
import type { TugConnection } from "../../connection";
import { ConnectionLifecycle } from "../connection-lifecycle";
import { TestFrameChannel } from "../code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "../code-session-store/testing/golden-catalog";
import type { ShellExchangeMessage } from "../code-session-store/types";

class MockFeedStore {
  private _data = new Map<number, unknown>();
  private _listeners: Array<() => void> = [];
  subscribe(listener: () => void): () => void {
    this._listeners.push(listener);
    return () => {
      const i = this._listeners.indexOf(listener);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }
  getSnapshot(): Map<number, unknown> {
    return this._data;
  }
  emit(feedId: number, payload: unknown): void {
    const next = new Map(this._data);
    next.set(feedId, payload);
    this._data = next;
    for (const l of this._listeners) l();
  }
}

function setup() {
  const code = new CodeSessionStore({
    conn: new TestFrameChannel() as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
  const feed = new MockFeedStore();
  const pendingContext = new PendingContextStore();
  const store = new ShellSessionStore(
    feed as unknown as ConstructorParameters<typeof ShellSessionStore>[0],
    FeedId.SHELL_OUTPUT,
    "sess-1",
    "/proj",
    code,
    pendingContext,
  );
  liveStores.push(store);
  return { store, feed, code, pendingContext };
}

/**
 * Stores built by {@link setup}. Each owns a retrying restore fetch ([P07]),
 * so an undisposed one keeps a timer running past the end of this file.
 */
const liveStores: ShellSessionStore[] = [];

afterEach(() => {
  while (liveStores.length > 0) liveStores.pop()!.dispose();
});

function shellTurns(code: CodeSessionStore) {
  return code.getSnapshot().transcript.filter((t) => t.origin === "shell");
}

beforeEach(() => {
  sentFrames = [];
});

describe("ShellSessionStore — VISIBILITY=Context auto-stage ([P08])", () => {
  function completeExchange(feed: MockFeedStore, id: string, command: string) {
    feed.emit(FeedId.SHELL_OUTPUT, {
      type: "exchange_complete",
      exchange_id: id,
      command,
      output: "hi\n",
      exit_code: 0,
      cwd: "/proj",
      cwd_after: "/proj",
      started_at: 1000,
      settled_at: 1050,
    });
  }

  test("Private (default): a settled exchange does NOT auto-stage", () => {
    const { feed, pendingContext } = setup();
    completeExchange(feed, "e1", "ls");
    expect(pendingContext.getSnapshot().items).toHaveLength(0);
  });

  test("Context: a newly settled exchange auto-stages with a round-trippable sentinel", () => {
    const { feed, pendingContext } = setup();
    pendingContext.setContext("shell", true);
    completeExchange(feed, "e1", "ls");
    const items = pendingContext.getSnapshot().items;
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("shell");
    expect(items[0].ref).toBe("e1");
    const prefix = pendingContext.takePrefix();
    const { blocks } = splitLeadingContext(prefix ?? "");
    expect(blocks[0].body).toContain("$ ls");
    expect(blocks[0].body).toContain("[exit 0]");
  });

  test("a manual stage and the auto-stage de-dupe on the same exchangeId", () => {
    const { feed, pendingContext } = setup();
    pendingContext.setContext("shell", true);
    completeExchange(feed, "e1", "ls");
    // A manual Add-to-context on the same row is a no-op (already staged).
    pendingContext.stage({ source: "shell", ref: "e1", label: "shell #s1", body: "dup" });
    expect(pendingContext.getSnapshot().items).toHaveLength(1);
  });
});

describe("ShellSessionStore — fold + mirror", () => {
  test("seeds cwd to the project dir before any frame", () => {
    const { store } = setup();
    expect(store.getSnapshot().cwd).toBe("/proj");
    expect(store.getSnapshot().live).toBe(false);
  });

  test("shell_state updates live + cwd", () => {
    const { store, feed } = setup();
    feed.emit(FeedId.SHELL_OUTPUT, { type: "shell_state", live: true, cwd: "/tmp" });
    expect(store.getSnapshot().live).toBe(true);
    expect(store.getSnapshot().cwd).toBe("/tmp");
  });

  test("the shell_words frame it shares the feed with changes nothing", () => {
    const { store, feed, code } = setup();
    feed.emit(FeedId.SHELL_OUTPUT, { type: "shell_state", live: true, cwd: "/tmp" });
    const before = store.getSnapshot();
    feed.emit(FeedId.SHELL_OUTPUT, {
      type: "shell_words",
      tug_session_id: "s1",
      names: ["gs", "setopt"],
    });
    expect(store.getSnapshot()).toBe(before);
    expect(shellTurns(code).length).toBe(0);
  });

  test("exchange_started mints an in-flight shell turn in the transcript", () => {
    const { feed, code } = setup();
    feed.emit(FeedId.SHELL_OUTPUT, {
      type: "exchange_started",
      exchange_id: "e1",
      command: "ls",
      cwd: "/proj",
      started_at: 1000,
    });
    const turns = shellTurns(code);
    expect(turns.length).toBe(1);
    const m = turns[0].messages[0] as ShellExchangeMessage;
    expect(m.command).toBe("ls");
    expect(m.exitCode).toBeNull();
  });

  test("exchange_complete settles the turn and updates cwd", () => {
    const { store, feed, code } = setup();
    feed.emit(FeedId.SHELL_OUTPUT, {
      type: "exchange_started",
      exchange_id: "e1",
      command: "cd /tmp",
      cwd: "/proj",
      started_at: 1000,
    });
    feed.emit(FeedId.SHELL_OUTPUT, {
      type: "exchange_complete",
      exchange_id: "e1",
      command: "cd /tmp",
      output: "",
      exit_code: 0,
      cwd: "/proj",
      cwd_after: "/tmp",
      started_at: 1000,
      settled_at: 1010,
    });
    const m = shellTurns(code)[0].messages[0] as ShellExchangeMessage;
    expect(m.exitCode).toBe(0);
    expect(m.cwdAfter).toBe("/tmp");
    // The store's cwd tracked the command's cwd_after.
    expect(store.getSnapshot().cwd).toBe("/tmp");
  });

  // Frames sent on SHELL_INPUT (excludes the constructor's list_shell_exchanges
  // restore fetch, which rides FeedId.CONTROL).
  const shellInput = () => sentFrames.filter((f) => f.feedId === FeedId.SHELL_INPUT);

  test("exec sends a SHELL_INPUT exec frame and marks in-flight; kill sends a kill frame", () => {
    const { store } = setup();
    store.exec("echo hi");
    expect(store.getSnapshot().inflight?.command).toBe("echo hi");
    expect(shellInput().length).toBe(1);
    const exec = JSON.parse(shellInput()[0].payload);
    expect(exec.type).toBe("exec");
    expect(exec.command).toBe("echo hi");
    expect(exec.tug_session_id).toBe("sess-1");

    store.kill();
    const kill = JSON.parse(shellInput()[1].payload);
    expect(kill.type).toBe("kill");
    expect(kill.tug_session_id).toBe("sess-1");
  });

  test("exec is serial — a second exec while in-flight is refused", () => {
    const { store } = setup();
    store.exec("first");
    store.exec("second");
    expect(shellInput().length).toBe(1);
    expect(store.getSnapshot().inflight?.command).toBe("first");
  });

  // The `$` route is typed rather than inferred, so the router's refusal never
  // sees it — and a `yes` typed here locks the app exactly as hard. Nothing is
  // sent and nothing is spawned; the row is minted locally as a refusal.
  test("exec refuses a program that never ends, on every route", () => {
    const { store, code } = setup();
    store.exec("yes");
    expect(shellInput().length).toBe(0);
    expect(store.getSnapshot().inflight).toBeNull();
    const rows = shellTurns(code);
    expect(rows.length).toBe(1);
    const message = rows[0].messages[0] as ShellExchangeMessage;
    expect(message.command).toBe("yes");
    expect(message.exitCode).toBe(1);
    expect(message.output).toContain("`yes` never ends on its own");
  });

  test("exec runs a line that merely mentions one", () => {
    const { store } = setup();
    store.exec('git commit -m "say yes to it"');
    expect(shellInput().length).toBe(1);
  });

  test("the constructor sends a list_shell_exchanges restore fetch on CONTROL", () => {
    setup();
    const control = sentFrames.filter((f) => f.feedId === FeedId.CONTROL);
    expect(control.length).toBe(1);
    const req = JSON.parse(control[0].payload);
    expect(req.action).toBe("list_shell_exchanges");
    expect(req.tug_session_id).toBe("sess-1");
  });

  test("exchange_complete clears the in-flight slot for the running exchange", () => {
    const { store, feed } = setup();
    store.exec("sleep 5"); // mints inflight sh-1
    const id = store.getSnapshot().inflight?.exchangeId;
    feed.emit(FeedId.SHELL_OUTPUT, {
      type: "exchange_complete",
      exchange_id: id,
      command: "sleep 5",
      output: "",
      exit_code: null,
      cwd: "/proj",
      cwd_after: "/proj",
      started_at: 1,
      settled_at: 2,
    });
    expect(store.getSnapshot().inflight).toBeNull();
  });
});

describe("applyRestoredShellExchanges — restore interleave ([P07])", () => {
  function code() {
    return new CodeSessionStore({
      conn: new TestFrameChannel() as unknown as TugConnection,
      lifecycle: new ConnectionLifecycle(),
      tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
      sessionMode: "new",
    });
  }
  function row(id: number, cmd: string, startedAt: number): Record<string, unknown> {
    return {
      id,
      tug_session_id: "s1",
      seq: id,
      command: cmd,
      output: `out:${cmd}\n`,
      exit_code: 0,
      cwd: "/proj",
      cwd_after: "/proj",
      started_at_ms: startedAt,
      settled_at_ms: startedAt + 5,
    };
  }

  test("ledger rows mint settled shell turns keyed `restored-<id>`, in timestamp order", () => {
    const c = code();
    // Deliberately out of order — the interleave sorts by started_at_ms.
    applyRestoredShellExchanges(c, [row(2, "second", 200), row(1, "first", 100)]);
    const turns = c.getSnapshot().transcript.filter((t) => t.origin === "shell");
    expect(turns.map((t) => t.turnKey)).toEqual(["shell-restored-1", "shell-restored-2"]);
    const m0 = turns[0].messages[0];
    expect(m0.kind === "shell_exchange" && m0.command).toBe("first");
    expect(m0.kind === "shell_exchange" && m0.exitCode).toBe(0);
  });

  test("re-applying the same rows is idempotent — no duplicate turns (reload)", () => {
    const c = code();
    applyRestoredShellExchanges(c, [row(1, "a", 100), row(2, "b", 200)]);
    applyRestoredShellExchanges(c, [row(1, "a", 100), row(2, "b", 200)]);
    const turns = c.getSnapshot().transcript.filter((t) => t.origin === "shell");
    expect(turns.length).toBe(2);
  });

  test("an empty response is a no-op", () => {
    const c = code();
    applyRestoredShellExchanges(c, []);
    expect(c.getSnapshot().transcript.filter((t) => t.origin === "shell").length).toBe(0);
  });
});

/**
 * The completeness contract ([P07]). The bug this exists for: an answer that
 * carried fewer rows than the ledger holds used to settle the retry exactly
 * like a full one, so 49 ledgered rows across two cards stayed in sqlite and
 * out of the transcript with nothing said.
 */
describe("restore completeness", () => {
  function row(id: number, cmd: string, startedAt: number): Record<string, unknown> {
    return {
      id,
      tug_session_id: "sess-1",
      seq: id,
      command: cmd,
      output: `out:${cmd}\n`,
      exit_code: 0,
      cwd: "/proj",
      cwd_after: "/proj",
      started_at_ms: startedAt,
      settled_at_ms: startedAt + 5,
    };
  }

  test("a complete answer settles the retry and reports complete", () => {
    const { store, code: c } = setup();
    store.applyRestore([row(1, "a", 100), row(2, "b", 200)], { total: 2, answered: true });

    const census = store.getSnapshot().restore;
    expect(census).toMatchObject({
      ledgerTotal: 2,
      applied: 2,
      complete: true,
      answered: true,
    });
    expect(c.getSnapshot().transcript.filter((t) => t.origin === "shell").length).toBe(2);
  });

  test("a short answer applies its rows but is NOT complete", () => {
    const { store, code: c } = setup();
    // The ledger holds 15; the answer carried 2. This is the `#s15` case.
    store.applyRestore([row(1, "a", 100), row(2, "b", 200)], { total: 15, answered: true });

    expect(store.getSnapshot().restore).toMatchObject({
      ledgerTotal: 15,
      applied: 2,
      complete: false,
      answered: true,
    });
    // What did arrive is still seated — a short answer is not a lost one.
    expect(c.getSnapshot().transcript.filter((t) => t.origin === "shell").length).toBe(2);
  });

  test("an empty answer from a session with rows is short, not complete", () => {
    const { store } = setup();
    store.applyRestore([], { total: 15, answered: true });
    expect(store.getSnapshot().restore).toMatchObject({ applied: 0, complete: false });
  });

  test("a genuinely empty session is complete", () => {
    const { store } = setup();
    store.applyRestore([], { total: 0, answered: true });
    expect(store.getSnapshot().restore).toMatchObject({ ledgerTotal: 0, complete: true });
  });

  test("no ledger at all never reads as no rows", () => {
    const { store } = setup();
    store.applyRestore([], { total: 0, answered: false });
    expect(store.getSnapshot().restore.complete).toBe(false);
  });

  test("an older tugcast without a total is trusted on its rows", () => {
    const { store } = setup();
    store.applyRestore([row(1, "a", 100)]);
    expect(store.getSnapshot().restore).toMatchObject({
      ledgerTotal: 1,
      applied: 1,
      complete: true,
    });
  });
});

