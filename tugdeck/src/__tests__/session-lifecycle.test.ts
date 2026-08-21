/**
 * session-lifecycle unit tests.
 *
 * Covers `sendCloseSession`'s two-step contract: it clears the card's
 * `cardSessionBindingStore` binding first, then sends a close_session
 * CONTROL frame over the connection.
 */

import { describe, test, expect } from "bun:test";
import {
  sendCloseSession,
  sendRequestReplay,
} from "../lib/session-lifecycle";
import { cardSessionBindingStore } from "../lib/card-session-binding-store";
import { FeedId } from "../protocol";

function makeMockConnection() {
  const sent: Array<{ feedId: number; payload: Uint8Array }> = [];
  return {
    send(feedId: number, payload: Uint8Array): void {
      sent.push({ feedId, payload });
    },
    sent,
  };
}

describe("sendCloseSession", () => {
  test("clears an existing binding and sends a CONTROL frame", () => {
    // Pre-seed the binding store so we can observe the clear.
    cardSessionBindingStore.setBinding("card-lc", {
      tugSessionId: "sess-lc",
      workspaceKey: "/work/lc",
      projectDir: "/work/lc",
      sessionMode: "new",
    });
    expect(cardSessionBindingStore.getBinding("card-lc")).toBeDefined();

    const conn = makeMockConnection();
    sendCloseSession(conn as never, "card-lc", "sess-lc");

    // Binding is cleared.
    expect(cardSessionBindingStore.getBinding("card-lc")).toBeUndefined();

    // Exactly one CONTROL frame was sent.
    expect(conn.sent.length).toBe(1);
    expect(conn.sent[0].feedId).toBe(FeedId.CONTROL);
    const payload = JSON.parse(new TextDecoder().decode(conn.sent[0].payload));
    expect(payload).toEqual({
      action: "close_session",
      card_id: "card-lc",
      tug_session_id: "sess-lc",
    });
  });

  test("is a safe no-op clear when the card is already unbound", () => {
    cardSessionBindingStore.clearBinding("card-unbound");

    const conn = makeMockConnection();
    expect(() =>
      sendCloseSession(conn as never, "card-unbound", "sess-unbound"),
    ).not.toThrow();

    // Still sends the frame even if there was nothing to clear.
    expect(conn.sent.length).toBe(1);
    expect(cardSessionBindingStore.getBinding("card-unbound")).toBeUndefined();
  });
});

describe("sendRequestReplay", () => {
  test("emits a request_replay CONTROL frame with the given tug_session_id ([D12])", () => {
    const conn = makeMockConnection();
    sendRequestReplay(conn as never, "sess-replay-1");
    expect(conn.sent.length).toBe(1);
    expect(conn.sent[0].feedId).toBe(FeedId.CONTROL);
    const payload = JSON.parse(new TextDecoder().decode(conn.sent[0].payload));
    expect(payload).toEqual({
      action: "request_replay",
      tug_session_id: "sess-replay-1",
    });
  });

  test("does not touch cardSessionBindingStore", () => {
    // request_replay is pure wire emission — it must not mutate the
    // binding store. Pre-seed a binding and verify it survives the
    // dispatch (in contrast to sendCloseSession, which clears).
    cardSessionBindingStore.setBinding("card-rr", {
      tugSessionId: "sess-rr",
      workspaceKey: "/work/rr",
      projectDir: "/work/rr",
      sessionMode: "resume",
    });

    const conn = makeMockConnection();
    sendRequestReplay(conn as never, "sess-rr");

    const binding = cardSessionBindingStore.getBinding("card-rr");
    expect(binding).toBeDefined();
    expect(binding?.tugSessionId).toBe("sess-rr");

    // A binding left standing keeps its services bag — and the shell / refs
    // stores' retrying restore fetches ([P07]) — alive past this file.
    cardSessionBindingStore.clearBinding("card-rr");
  });
});
