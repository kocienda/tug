import { beforeEach, describe, expect, mock, test } from "bun:test";

// Capture the CODE_INPUT frames `ask` sends. Mocked before importing the store.
let sentFrames: Array<{ feedId: number; payload: string }> = [];
mock.module("../connection-singleton", () => ({
  getConnection: () => ({
    send: (feedId: number, payload: Uint8Array) => {
      sentFrames.push({ feedId, payload: new TextDecoder().decode(payload) });
    },
    onFrame: () => () => {},
  }),
}));

import { FeedId } from "../../protocol";
import {
  SideQuestionStore,
  parseSideQuestionAnswerPayload,
} from "../side-question-store";
import { PendingContextStore, splitLeadingContext } from "../pending-context-store";
import { setTugbankClient } from "../tugbank-singleton";
import { SIDE_QUESTIONS_DOMAIN } from "@/settings-api";
import type { TugbankClient } from "../tugbank-client";

// A minimal FeedStore whose `emit` drives the store's feed subscription.
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

function newStore(): {
  store: SideQuestionStore;
  feed: MockFeedStore;
  pendingContext: PendingContextStore;
} {
  const feed = new MockFeedStore();
  const pendingContext = new PendingContextStore();
  const store = new SideQuestionStore(
    feed as unknown as ConstructorParameters<typeof SideQuestionStore>[0],
    FeedId.CODE_OUTPUT,
    "sess-1",
    "line-1",
    pendingContext,
  );
  return { store, feed, pendingContext };
}

function answerFrame(requestId: string, answer: string | null, synthetic = false) {
  return {
    type: "side_question_answer",
    tug_session_id: "sess-1",
    request_id: requestId,
    answer,
    synthetic,
    ipc_version: 2,
  };
}

beforeEach(() => {
  sentFrames = [];
});

describe("parseSideQuestionAnswerPayload", () => {
  test("parses a well-formed payload", () => {
    const p = parseSideQuestionAnswerPayload(answerFrame("btw-1", "hi", true));
    expect(p).toEqual({ request_id: "btw-1", answer: "hi", synthetic: true });
  });
  test("defaults a missing synthetic to false and tolerates a null answer", () => {
    const p = parseSideQuestionAnswerPayload({
      type: "side_question_answer",
      request_id: "btw-2",
      answer: null,
    });
    expect(p).toEqual({ request_id: "btw-2", answer: null, synthetic: false });
  });
  test("rejects a non-side_question or malformed payload", () => {
    expect(parseSideQuestionAnswerPayload(null)).toBeNull();
    expect(parseSideQuestionAnswerPayload({ type: "hooks_inventory" })).toBeNull();
    expect(parseSideQuestionAnswerPayload({ type: "side_question_answer" })).toBeNull();
  });
});

describe("SideQuestionStore.ask", () => {
  test("appends a loading exchange and sends the side_question CODE_INPUT verb", () => {
    const { store } = newStore();
    store.ask("what was that file?");
    const [ex] = store.getSnapshot().exchanges;
    expect(ex).toMatchObject({ question: "what was that file?", phase: "loading", answer: null });
    expect(typeof ex.at).toBe("number");

    expect(sentFrames.length).toBe(1);
    expect(sentFrames[0].feedId).toBe(FeedId.CODE_INPUT);
    const sent = JSON.parse(sentFrames[0].payload);
    expect(sent).toMatchObject({
      type: "side_question",
      tug_session_id: "sess-1",
      request_id: ex.id,
      question: "what was that file?",
    });
    store.dispose();
  });

  test("ignores a blank/whitespace-only question", () => {
    const { store } = newStore();
    store.ask("   ");
    expect(store.getSnapshot().exchanges.length).toBe(0);
    expect(sentFrames.length).toBe(0);
    store.dispose();
  });
});

describe("SideQuestionStore feed correlation", () => {
  test("a matching answer flips the exchange to answered with the settled text", () => {
    const { store, feed } = newStore();
    store.ask("the magic word?");
    const id = store.getSnapshot().exchanges[0].id;
    feed.emit(FeedId.CODE_OUTPUT, answerFrame(id, "XYLOPHONE-42", false));
    const ex = store.getSnapshot().exchanges[0];
    expect(ex).toMatchObject({ phase: "answered", answer: "XYLOPHONE-42", synthetic: false });
    store.dispose();
  });

  test("a null answer settles to the error phase (no response received)", () => {
    const { store, feed } = newStore();
    store.ask("q");
    const id = store.getSnapshot().exchanges[0].id;
    feed.emit(FeedId.CODE_OUTPUT, answerFrame(id, null));
    expect(store.getSnapshot().exchanges[0].phase).toBe("error");
    store.dispose();
  });

  test("an answer for an unknown id is ignored", () => {
    const { store, feed } = newStore();
    store.ask("q");
    feed.emit(FeedId.CODE_OUTPUT, answerFrame("btw-999", "nope"));
    expect(store.getSnapshot().exchanges[0].phase).toBe("loading");
    store.dispose();
  });
});

describe("SideQuestionStore — VISIBILITY=Context auto-stage ([P08])", () => {
  test("Private (default): a settled answer does NOT auto-stage", () => {
    const { store, feed, pendingContext } = newStore();
    store.ask("what was that file?");
    const id = store.getSnapshot().exchanges[0].id;
    feed.emit(FeedId.CODE_OUTPUT, answerFrame(id, "config.toml", false));
    expect(pendingContext.getSnapshot().items).toHaveLength(0);
    store.dispose();
  });

  test("Context: a newly answered side question auto-stages a round-trippable Q/A block", () => {
    const { store, feed, pendingContext } = newStore();
    pendingContext.setContext("btw", true);
    store.ask("what was that file?");
    const id = store.getSnapshot().exchanges[0].id;
    feed.emit(FeedId.CODE_OUTPUT, answerFrame(id, "config.toml", false));
    const items = pendingContext.getSnapshot().items;
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("btw");
    const { blocks } = splitLeadingContext(pendingContext.takePrefix() ?? "");
    expect(blocks[0].body).toContain("Side question:");
    expect(blocks[0].body).toContain("config.toml");
    store.dispose();
  });

  test("Context: a null (error) answer does not auto-stage", () => {
    const { store, feed, pendingContext } = newStore();
    pendingContext.setContext("btw", true);
    store.ask("q");
    const id = store.getSnapshot().exchanges[0].id;
    feed.emit(FeedId.CODE_OUTPUT, answerFrame(id, null));
    expect(pendingContext.getSnapshot().items).toHaveLength(0);
    store.dispose();
  });
});

describe("SideQuestionStore — durable across relaunch ([P07])", () => {
  function fakeClientWith(key: string, value: unknown): TugbankClient {
    return {
      getValue: (domain: string, asked: string) =>
        domain === SIDE_QUESTIONS_DOMAIN && asked === key ? value : undefined,
    } as unknown as TugbankClient;
  }

  test("seeds settled history from the durable blob and resumes #b{n}", () => {
    setTugbankClient(
      // Keyed by the **line** ([P12]) — the conversation the exchanges belong
      // to, not whichever segment was seated when they were asked.
      fakeClientWith("line-1", [
        { id: "btw-1", question: "q1", phase: "answered", answer: "a1", synthetic: false, at: 1 },
        { id: "btw-2", question: "q2", phase: "error", answer: null, synthetic: false, at: 2 },
      ]),
    );
    try {
      const { store } = newStore();
      const ex = store.getSnapshot().exchanges;
      expect(ex.map((e) => e.id)).toEqual(["btw-1", "btw-2"]);
      expect(ex[0]).toMatchObject({ phase: "answered", answer: "a1" });
      expect(ex[1]).toMatchObject({ phase: "error", answer: null });
      // A fresh ask continues the ordinal past the highest loaded id.
      store.ask("q3");
      expect(store.getSnapshot().exchanges[2].id).toBe("btw-3");
      store.dispose();
    } finally {
      setTugbankClient(null);
    }
  });

  test("no durable blob → empty history (the fresh-session case)", () => {
    setTugbankClient(fakeClientWith("other", []));
    try {
      const { store } = newStore();
      expect(store.getSnapshot().exchanges).toHaveLength(0);
      store.dispose();
    } finally {
      setTugbankClient(null);
    }
  });

  test("carries a pre-lines history once from the tug-session-id key ([P12])", () => {
    // The blob a build before the line model wrote is keyed by the session id.
    // Re-keying without the carry would empty a user's `/btw` history on the
    // first launch after the migration, which is the one outcome worse than
    // not re-keying at all.
    setTugbankClient(
      fakeClientWith("sess-1", [
        { id: "btw-4", question: "old q", phase: "answered", answer: "a", synthetic: false, at: 1 },
      ]),
    );
    try {
      const { store } = newStore();
      expect(store.getSnapshot().exchanges.map((e) => e.id)).toEqual(["btw-4"]);
      store.dispose();
    } finally {
      setTugbankClient(null);
    }
  });
});

describe("SideQuestionStore history", () => {
  test("preserves ask order (newest last) and clears", () => {
    const { store, feed } = newStore();
    store.ask("first");
    store.ask("second");
    const ids = store.getSnapshot().exchanges.map((e) => e.id);
    expect(store.getSnapshot().exchanges.map((e) => e.question)).toEqual(["first", "second"]);
    // Settling the first leaves the second in flight, order intact.
    feed.emit(FeedId.CODE_OUTPUT, answerFrame(ids[0], "A1"));
    expect(store.getSnapshot().exchanges.map((e) => e.phase)).toEqual(["answered", "loading"]);

    store.clear();
    expect(store.getSnapshot().exchanges.length).toBe(0);
    store.dispose();
  });

  test("dismiss removes a single exchange (cancel), leaving the rest", () => {
    const { store } = newStore();
    store.ask("first");
    store.ask("second");
    const ids = store.getSnapshot().exchanges.map((e) => e.id);
    store.dismiss(ids[0]);
    expect(store.getSnapshot().exchanges.map((e) => e.question)).toEqual(["second"]);
    // Dismissing an unknown id is a no-op.
    store.dismiss("btw-999");
    expect(store.getSnapshot().exchanges.length).toBe(1);
    store.dispose();
  });

  test("a late answer for a dismissed (cancelled) loading exchange is ignored", () => {
    const { store, feed } = newStore();
    store.ask("q");
    const id = store.getSnapshot().exchanges[0].id;
    store.dismiss(id); // cancel while loading
    feed.emit(FeedId.CODE_OUTPUT, answerFrame(id, "late answer"));
    expect(store.getSnapshot().exchanges.length).toBe(0);
    store.dispose();
  });
});
