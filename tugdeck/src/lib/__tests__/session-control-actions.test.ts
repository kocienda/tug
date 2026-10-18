/**
 * The session-domain acks moved out of the dispatcher, and the shell still
 * registers every one of them; a body's card filter admits its own card's
 * acks and its own session's pushes and refuses every other card's and
 * session's.
 *
 * @covers tugdeck/src/lib/session-control-actions.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { _resetActionRegistryForTest, getRegistryHandler } from "../../action-registry";
import {
  SESSION_CONTROL_ACTIONS,
  bodyCardFilter,
  registerSessionControlActions,
} from "../session-control-actions";

afterEach(() => {
  _resetActionRegistryForTest();
});

describe("the shell's registration", () => {
  test("registers the same session acks the dispatcher registered before", () => {
    expect([...SESSION_CONTROL_ACTIONS].sort()).toEqual(
      [
        "bind_arc_err",
        "bind_arc_ok",
        "list_card_bindings_err",
        "list_card_bindings_ok",
        "list_refs_ok",
        "list_shell_exchanges_ok",
        "rename_session_err",
        "rename_session_ok",
        "session_line_rebound",
        "session_line_seated",
        "session_updated",
        "set_session_private_err",
        "set_session_private_ok",
        "spawn_session_error",
        "spawn_session_ok",
        "unbind_arc_ok",
      ],
    );
    registerSessionControlActions();
    for (const action of SESSION_CONTROL_ACTIONS) {
      expect(getRegistryHandler(action)).toBeDefined();
    }
  });
});

describe("a body's card filter", () => {
  const filter = bodyCardFilter(() => ({
    cardId: "c1",
    sessionIds: ["s1"],
    lineId: "line-1",
  }));

  test("admits its own card's spawn ack and refuses another card's", () => {
    const own = { card_id: "c1", tug_session_id: "s1", workspace_key: "/w" };
    expect(filter("spawn_session_ok", own)).toBe(own);
    expect(filter("spawn_session_ok", { card_id: "c2", tug_session_id: "s2", workspace_key: "/w" })).toBe(null);
    expect(filter("spawn_session_error", { card_id: "c2", detail: "x" })).toBe(null);
  });

  test("admits its own session's row push and refuses another session's", () => {
    const own = { session_id: "s1", fields: { line_id: "line-1" } };
    expect(filter("session_updated", own)).toBe(own);
    expect(filter("session_updated", { session_id: "s2", fields: { line_id: "line-2" } })).toBe(null);
    expect(filter("set_session_private_ok", { session_id: "s2", private: true })).toBe(null);
    expect(filter("rename_session_ok", { line_id: "line-1", name: "n" })).not.toBe(null);
    expect(filter("rename_session_ok", { line_id: "line-2", name: "n" })).toBe(null);
  });

  test("cuts the bindings list to its own card's row", () => {
    const admitted = filter("list_card_bindings_ok", {
      bindings: [{ card_id: "c1", session_id: "s1" }, { card_id: "c2", session_id: "s2" }],
    });
    expect(admitted?.bindings).toEqual([{ card_id: "c1", session_id: "s1" }]);
  });
});

describe("a listing body's card filter", () => {
  // The Cards card lists every card's session, a parked workspace's too, and
  // holds no session of its own. A cut bindings list would replace its page's
  // whole bindings cache with one row.
  const filter = bodyCardFilter(() => ({ cardId: "cards", sessionIds: [], lineId: null }), { lists: true });

  test("is shown every session's row push", () => {
    const other = { session_id: "s2", fields: { line_id: "line-2" } };
    expect(filter("session_updated", other)).toBe(other);
  });

  test("is shown the whole bindings list, every card's row", () => {
    const payload = {
      bindings: [{ card_id: "c1", session_id: "s1" }, { card_id: "c2", session_id: "s2" }],
    };
    expect(filter("list_card_bindings_ok", payload)?.bindings).toEqual(payload.bindings);
  });

  test("still drives no session but its own card's", () => {
    expect(filter("spawn_session_ok", { card_id: "c2", tug_session_id: "s2", workspace_key: "/w" })).toBe(null);
    expect(filter("session_line_seated", { card_id: "c2", session_id: "s2", line_id: "line-2" })).toBe(null);
    expect(filter("bind_arc_ok", { card_id: "c2", tug_session_id: "s2" })).toBe(null);
    expect(filter("rename_session_ok", { line_id: "line-2", name: "n" })).toBe(null);
    expect(filter("set_session_private_ok", { session_id: "s2", private: true })).toBe(null);
  });
});
