/**
 * RefsSessionStore — the restore read ([P05], Spec S07).
 *
 * A card that reloads has no feed history to replay: the refs block it shows
 * comes back from the ledger, which keeps the session's latest run only. The
 * restored run must land as a settled transcript row AND re-seat the list
 * `/ref N` resolves against — a block on screen whose numbers open nothing
 * would be worse than no block at all.
 *
 * Drives the real store and the real CodeSessionStore reducer through a
 * minimal feed double (the sibling shell-session-store test's pattern).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Capture the CONTROL frames the constructor sends. Mocked before the import.
let sentFrames: Array<{ feedId: number; payload: string }> = [];
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
}));

import { FeedId } from "../../protocol";
import { RefsSessionStore, applyRestoredRefs, parseTextRef } from "../refs-session-store";
import { CodeSessionStore } from "../code-session-store";
import type { TugConnection } from "../../connection";
import { ConnectionLifecycle } from "../connection-lifecycle";
import { TestFrameChannel } from "../code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "../code-session-store/testing/golden-catalog";
import type { RefsResultMessage } from "../code-session-store/types";

class MockFeedStore {
  private _data = new Map<number, unknown>();
  subscribe(): () => void {
    return () => {};
  }
  getSnapshot(): Map<number, unknown> {
    return this._data;
  }
}

function setup() {
  const code = new CodeSessionStore({
    conn: new TestFrameChannel() as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
  const store = new RefsSessionStore(
    new MockFeedStore() as unknown as ConstructorParameters<typeof RefsSessionStore>[0],
    FeedId.REFS_OUTPUT,
    "sess-1",
    "/proj",
    code,
  );
  liveStores.push(store);
  return { store, code };
}

/**
 * Stores built by {@link setup}. Each owns a retrying restore fetch, so an
 * undisposed one keeps a timer running past the end of this file.
 */
const liveStores: RefsSessionStore[] = [];

afterEach(() => {
  while (liveStores.length > 0) liveStores.pop()!.dispose();
});

/** The wire shape of one ledgered run, as `list_refs_ok` carries it. */
function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "run-7",
    op_kind: "search",
    command: "/search foo",
    settled_at_ms: 5000,
    refs: [
      { index: 1, path: "src/a.ts", line: 12, columns: [[4, 7]], preview: "  foo()" },
      { index: 2, path: "src/b.ts", line: 3, columns: [[0, 3]], preview: "foo" },
    ],
    ...overrides,
  };
}

function refsMessages(code: CodeSessionStore): RefsResultMessage[] {
  const out: RefsResultMessage[] = [];
  for (const turn of code.getSnapshot().transcript) {
    if (turn.origin !== "refs") continue;
    const m = turn.messages[0];
    if (m.kind === "refs_result") out.push(m);
  }
  return out;
}

beforeEach(() => {
  sentFrames = [];
});

describe("the restore fetch", () => {
  test("the constructor asks the ledger for this session's latest run", () => {
    setup();
    const control = sentFrames.filter((f) => f.feedId === FeedId.CONTROL);
    expect(control.length).toBe(1);
    expect(JSON.parse(control[0].payload)).toEqual({
      action: "list_refs",
      tug_session_id: "sess-1",
    });
  });
});

describe("applyRestoredRefs — the ledgered run comes back settled", () => {
  test("mints one settled refs row carrying the store's root", () => {
    const { store, code } = setup();
    applyRestoredRefs(code, store, run());

    const messages = refsMessages(code);
    expect(messages.length).toBe(1);
    const m = messages[0];
    expect(m.runId).toBe("run-7");
    expect(m.command).toBe("/search foo");
    expect(m.inFlight).toBe(false);
    expect(m.settledAtMs).toBe(5000);
    // The ledger row holds relative paths and no root; the store holds the
    // project dir they were relative to.
    expect(m.root).toBe("/proj");
    expect(m.refs.map((r) => r.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("re-seats the list `/ref N` resolves against", () => {
    const { store, code } = setup();
    expect(store.getSnapshot().refs.length).toBe(0);
    applyRestoredRefs(code, store, run());
    expect(store.getSnapshot().refs.map((r) => r.index)).toEqual([1, 2]);
    expect(store.getSnapshot().refs[0].columns).toEqual([[4, 7]]);
  });

  test("a re-fetch is idempotent — the row is upserted, never doubled", () => {
    const { store, code } = setup();
    applyRestoredRefs(code, store, run());
    applyRestoredRefs(code, store, run());
    expect(refsMessages(code).length).toBe(1);
  });

  test("a session that has never searched restores nothing", () => {
    const { store, code } = setup();
    applyRestoredRefs(code, store, null);
    expect(refsMessages(code).length).toBe(0);
    expect(store.getSnapshot().refs.length).toBe(0);
  });

  test("a match run restores as a match run, not the search default", () => {
    const { store, code } = setup();
    applyRestoredRefs(code, store, run({ op_kind: "match", command: "/match foo" }));
    expect(refsMessages(code)[0].opKind).toBe("match");
  });

  test("skips a malformed ledger row rather than restoring a broken ref", () => {
    const { store, code } = setup();
    applyRestoredRefs(
      code,
      store,
      run({ refs: [{ index: 1, path: "src/a.ts" }, { path: "no-index.ts" }, 7] }),
    );
    expect(refsMessages(code)[0].refs.map((r) => r.path)).toEqual(["src/a.ts"]);
  });
});

describe("parseTextRef", () => {
  test("defaults the fields a filename ref does not carry", () => {
    expect(parseTextRef({ index: 3, path: "a.ts" })).toEqual({
      index: 3,
      path: "a.ts",
      line: null,
      columns: [],
      preview: null,
    });
  });

  test("refuses a row with no index or no path", () => {
    expect(parseTextRef({ path: "a.ts" })).toBe(null);
    expect(parseTextRef({ index: 1 })).toBe(null);
    expect(parseTextRef(null)).toBe(null);
  });

  test("reads a windowed preview, snake-cased on the wire", () => {
    const ref = parseTextRef({
      index: 1,
      path: "bundle.js",
      line: 1,
      columns: [[402, 408]],
      preview: {
        line_len: 90_000,
        segments: [{ col: 370, text: "…window text…" }],
        elided_matches: 3,
      },
    });
    expect(ref?.preview).toEqual({
      lineLen: 90_000,
      segments: [{ col: 370, text: "…window text…" }],
      elidedMatches: 3,
    });
  });

  test("reads a bare-string preview as one full-width window", () => {
    // What a `refs.db` row written before windowing holds. The ledger keeps
    // one run per session indefinitely, so this shape outlives the change.
    expect(parseTextRef({ index: 1, path: "a.ts", preview: "let foo = 2;" })?.preview)
      .toEqual({
        lineLen: 12,
        segments: [{ col: 0, text: "let foo = 2;" }],
        elidedMatches: 0,
      });
  });

  test("drops a malformed segment rather than rendering `undefined`", () => {
    expect(
      parseTextRef({
        index: 1,
        path: "a.ts",
        preview: { line_len: 20, segments: [{ col: 0 }, { col: 4, text: "ok" }] },
      })?.preview?.segments,
    ).toEqual([{ col: 4, text: "ok" }]);
  });
});
