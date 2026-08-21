/**
 * changeset-draft-store — the live draft overlay over the maintained-draft
 * engine's CONTROL frames (Spec S10, [P24]): drafting → deltas → ready/error,
 * keyed by (workspace_key, owner_kind, owner_id).
 */

import { describe, test, expect, beforeEach } from "bun:test";

import {
  attachChangesetDraftStore,
  _resetChangesetDraftStoreForTest,
  _ingestDraftFrameForTest,
  _fireDraftStallForTest,
} from "../changeset-draft-store";

const fakeConn = { onFrame: () => () => {} } as never;

/** A fake connection whose disconnect callback the test fires by hand. */
function fakeConnWithDisconnect() {
  let notify: ((state: { disconnected: boolean }) => void) | null = null;
  const conn = {
    onFrame: () => () => {},
    onDisconnectState: (cb: (state: { disconnected: boolean }) => void) => {
      notify = cb;
      return () => {};
    },
  } as never;
  return { conn, disconnect: () => notify?.({ disconnected: true }) };
}

const KEY = { workspace_key: "/p", owner_kind: "session", owner_id: "s1" };

beforeEach(() => _resetChangesetDraftStoreForTest());

describe("changeset draft overlay", () => {
  test("drafting → deltas accumulate → ready keeps the last text", () => {
    const store = attachChangesetDraftStore(fakeConn);
    _ingestDraftFrameForTest({ action: "changeset_draft_state", ...KEY, state: "drafting" });
    expect(store.overlay("/p", "session", "s1").phase).toBe("drafting");

    _ingestDraftFrameForTest({ action: "changeset_draft_delta", ...KEY, text: "Add" });
    _ingestDraftFrameForTest({ action: "changeset_draft_delta", ...KEY, text: "Add the widget" });
    expect(store.overlay("/p", "session", "s1").text).toBe("Add the widget");

    _ingestDraftFrameForTest({ action: "changeset_draft_state", ...KEY, state: "ready" });
    const ready = store.overlay("/p", "session", "s1");
    expect(ready.phase).toBe("ready");
    expect(ready.text).toBe("Add the widget");
  });

  test("a fresh drafting state resets the streamed text", () => {
    const store = attachChangesetDraftStore(fakeConn);
    _ingestDraftFrameForTest({ action: "changeset_draft_delta", ...KEY, text: "stale" });
    _ingestDraftFrameForTest({ action: "changeset_draft_state", ...KEY, state: "drafting" });
    expect(store.overlay("/p", "session", "s1").text).toBe("");
  });

  test("error carries the detail and keeps the last text", () => {
    const store = attachChangesetDraftStore(fakeConn);
    _ingestDraftFrameForTest({ action: "changeset_draft_delta", ...KEY, text: "partial" });
    _ingestDraftFrameForTest({
      action: "changeset_draft_state",
      ...KEY,
      state: "error",
      detail: "scribe timed out",
    });
    const overlay = store.overlay("/p", "session", "s1");
    expect(overlay.phase).toBe("error");
    expect(overlay.detail).toBe("scribe timed out");
    expect(overlay.text).toBe("partial");
  });

  test("cancelled folds the overlay back to idle, dropping the partial", () => {
    const store = attachChangesetDraftStore(fakeConn);
    _ingestDraftFrameForTest({ action: "changeset_draft_state", ...KEY, state: "drafting" });
    _ingestDraftFrameForTest({ action: "changeset_draft_delta", ...KEY, text: "half a message" });
    expect(store.overlay("/p", "session", "s1").phase).toBe("drafting");

    _ingestDraftFrameForTest({ action: "changeset_draft_state", ...KEY, state: "cancelled" });
    const overlay = store.overlay("/p", "session", "s1");
    expect(overlay.phase).toBe("idle");
    expect(overlay.text).toBe("");
    expect(overlay.detail).toBe(null);
  });

  test("unrelated entries stay idle", () => {
    const store = attachChangesetDraftStore(fakeConn);
    _ingestDraftFrameForTest({ action: "changeset_draft_state", ...KEY, state: "drafting" });
    expect(store.overlay("/other", "dash", "tugdash/x").phase).toBe("idle");
  });

  test("a stalled drafting overlay folds to a recoverable error", () => {
    const store = attachChangesetDraftStore(fakeConn);
    _ingestDraftFrameForTest({ action: "changeset_draft_state", ...KEY, state: "drafting" });
    _ingestDraftFrameForTest({ action: "changeset_draft_delta", ...KEY, text: "half a" });

    _fireDraftStallForTest("/p", "session", "s1");
    const overlay = store.overlay("/p", "session", "s1");
    expect(overlay.phase).toBe("error");
    expect(overlay.text).toBe("half a");
    expect(overlay.detail).toContain("stalled");
  });

  test("the stall does not fire on an overlay that already settled", () => {
    const store = attachChangesetDraftStore(fakeConn);
    _ingestDraftFrameForTest({ action: "changeset_draft_state", ...KEY, state: "drafting" });
    _ingestDraftFrameForTest({ action: "changeset_draft_state", ...KEY, state: "ready" });

    _fireDraftStallForTest("/p", "session", "s1");
    expect(store.overlay("/p", "session", "s1").phase).toBe("ready");
  });

  test("a wire drop folds drafting overlays to idle; settled ones keep", () => {
    const { conn, disconnect } = fakeConnWithDisconnect();
    const store = attachChangesetDraftStore(conn);
    _ingestDraftFrameForTest({ action: "changeset_draft_state", ...KEY, state: "drafting" });
    _ingestDraftFrameForTest({
      action: "changeset_draft_state",
      workspace_key: "/p",
      owner_kind: "dash",
      owner_id: "tugdash/x",
      state: "drafting",
    });
    _ingestDraftFrameForTest({
      action: "changeset_draft_state",
      workspace_key: "/p",
      owner_kind: "dash",
      owner_id: "tugdash/x",
      state: "ready",
    });

    disconnect();
    expect(store.overlay("/p", "session", "s1").phase).toBe("idle");
    expect(store.overlay("/p", "dash", "tugdash/x").phase).toBe("ready");
  });
});

/** A fake connection whose socket the test opens and closes by hand. */
function fakeWritableConn() {
  let notify: ((state: { disconnected: boolean }) => void) | null = null;
  let open = true;
  const sent: Array<{ action: string; body: Record<string, unknown> }> = [];
  const conn = {
    onFrame: () => () => {},
    onDisconnectState: (cb: (state: { disconnected: boolean }) => void) => {
      notify = cb;
      return () => {};
    },
    trySendControlFrame: (action: string, body: Record<string, unknown>) => {
      if (!open) return false;
      sent.push({ action, body });
      return true;
    },
  } as never;
  return {
    conn,
    sent,
    close: () => {
      open = false;
      notify?.({ disconnected: true });
    },
    reopen: () => {
      open = true;
      notify?.({ disconnected: false });
    },
  };
}

describe("durable draft writes", () => {
  test("an open socket takes the write once, nothing kept pending", () => {
    const { conn, sent, reopen } = fakeWritableConn();
    const store = attachChangesetDraftStore(conn);
    store.setDraft("/p", "session", "s1", { message: "the words", edited: true });

    expect(sent.length).toBe(1);
    expect(sent[0]!.action).toBe("changeset_draft_set");
    expect(sent[0]!.body.message).toBe("the words");
    expect(sent[0]!.body.edited).toBe(true);

    // Nothing pending: a reconnect flush resends nothing.
    reopen();
    expect(sent.length).toBe(1);
  });

  test("a write refused by a closed socket is kept and flushed on reconnect", () => {
    const { conn, sent, close, reopen } = fakeWritableConn();
    const store = attachChangesetDraftStore(conn);
    close();
    store.setDraft("/p", "session", "s1", { message: "typed while down", edited: true });
    expect(sent.length).toBe(0);

    reopen();
    expect(sent.length).toBe(1);
    expect(sent[0]!.body.message).toBe("typed while down");

    // Delivered once — the retry does not re-fire after success.
    reopen();
    expect(sent.length).toBe(1);
  });

  test("a superseded write resends only the newest message", () => {
    const { conn, sent, close, reopen } = fakeWritableConn();
    const store = attachChangesetDraftStore(conn);
    close();
    store.setDraft("/p", "session", "s1", { message: "first draft", edited: true });
    store.setDraft("/p", "session", "s1", { message: "second draft", edited: true });
    store.setDraft("/p", "dash", "tugdash/x", { message: "the dash message", edited: true });

    reopen();
    expect(sent.length).toBe(2);
    const bySession = sent.find((s) => s.body.owner_kind === "session");
    const byDash = sent.find((s) => s.body.owner_kind === "dash");
    expect(bySession?.body.message).toBe("second draft");
    expect(byDash?.body.message).toBe("the dash message");
  });
});
