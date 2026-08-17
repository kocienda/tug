/**
 * session-private-store.test.ts — the per-session Overview-privacy cache and the
 * CONTROL payload `/private` sends.
 *
 * The notify contract is the load-bearing part: the atom's marker is a leaf
 * subscription, so a redundant wire echo that notified anyway would churn every
 * mounted atom on every ledger write.
 */

import { describe, expect, test } from "bun:test";

import { sessionPrivateStore } from "../session-private-store";
import { CONTROL_ACTION_SET_SESSION_PRIVATE, encodeSetSessionPrivate } from "@/protocol";

describe("sessionPrivateStore", () => {
  test("a session is public until marked, and the flag round-trips", () => {
    expect(sessionPrivateStore.isPrivate("p-round")).toBe(false);
    sessionPrivateStore.setPrivate("p-round", true);
    expect(sessionPrivateStore.isPrivate("p-round")).toBe(true);
    sessionPrivateStore.setPrivate("p-round", false);
    expect(sessionPrivateStore.isPrivate("p-round")).toBe(false);
  });

  test("only a real change notifies", () => {
    let notifications = 0;
    const unsubscribe = sessionPrivateStore.subscribe(() => {
      notifications += 1;
    });
    sessionPrivateStore.setPrivate("p-notify", true);
    sessionPrivateStore.setPrivate("p-notify", true);
    expect(notifications).toBe(1);
    sessionPrivateStore.setPrivate("p-notify", false);
    expect(notifications).toBe(2);
    unsubscribe();
    sessionPrivateStore.setPrivate("p-notify", true);
    expect(notifications).toBe(2);
  });

  test("forget leaves a trashed session neither private nor remembered", () => {
    sessionPrivateStore.setPrivate("p-forget", true);
    sessionPrivateStore.forget("p-forget");
    expect(sessionPrivateStore.isPrivate("p-forget")).toBe(false);
  });

  test("sessions are independent", () => {
    sessionPrivateStore.setPrivate("p-a", true);
    expect(sessionPrivateStore.isPrivate("p-b")).toBe(false);
  });
});

describe("encodeSetSessionPrivate", () => {
  test("the frame carries the action, the session, and the value it is setting", () => {
    const frame = encodeSetSessionPrivate("sess-1", true);
    const payload = JSON.parse(new TextDecoder().decode(frame.payload));
    expect(payload.action).toBe(CONTROL_ACTION_SET_SESSION_PRIVATE);
    expect(payload.session_id).toBe("sess-1");
    expect(payload.private).toBe(true);
    // Both directions ride one verb — turning it off is not a second action.
    const off = JSON.parse(
      new TextDecoder().decode(encodeSetSessionPrivate("sess-1", false).payload),
    );
    expect(off.private).toBe(false);
  });
});
