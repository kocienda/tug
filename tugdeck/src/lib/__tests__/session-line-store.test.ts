/**
 * session-line-store.test.ts — the two directions a segment id travels
 * ([P12]): up to the line it belongs to, and back down to the segment that
 * line is seated on.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  identityKeyForSession,
  sessionLineStore,
} from "../session-line-store";

/** Forget everything this file has taught the module-scope singleton. */
function reset(ids: readonly string[]): void {
  for (const id of ids) sessionLineStore.forgetSession(id);
}

describe("sessionLineStore", () => {
  beforeEach(() => {
    reset(["root", "stage", "respawn", "solo", "other"]);
  });

  test("every segment of a line answers with the same line", () => {
    sessionLineStore.seat("root", "L");
    sessionLineStore.bind("stage", "L");
    sessionLineStore.seat("respawn", "L");
    expect(sessionLineStore.lineOf("root")).toBe("L");
    expect(sessionLineStore.lineOf("stage")).toBe("L");
    expect(sessionLineStore.lineOf("respawn")).toBe("L");
  });

  test("only a seating frame moves the seat", () => {
    sessionLineStore.seat("root", "L");
    expect(sessionLineStore.seatOf("L")).toBe("root");
    // A citation resolution mentions an older segment; it records the mapping
    // without pulling the line back onto a segment nothing is running.
    sessionLineStore.bind("stage", "L");
    expect(sessionLineStore.seatOf("L")).toBe("root");
    sessionLineStore.seat("stage", "L");
    expect(sessionLineStore.seatOf("L")).toBe("stage");
  });

  test("a session with no line is its own key — a line of one", () => {
    expect(sessionLineStore.lineOf("solo")).toBeNull();
    expect(identityKeyForSession("solo")).toBe("solo");
    sessionLineStore.seat("solo", "L2");
    expect(identityKeyForSession("solo")).toBe("L2");
  });

  test("forgetting a non-seated segment leaves the line seated", () => {
    sessionLineStore.bind("root", "L");
    sessionLineStore.seat("stage", "L");
    sessionLineStore.forgetSession("root");
    expect(sessionLineStore.lineOf("root")).toBeNull();
    expect(sessionLineStore.seatOf("L")).toBe("stage");
  });

  test("forgetting the seated segment unseats the line", () => {
    sessionLineStore.seat("stage", "L");
    sessionLineStore.forgetSession("stage");
    expect(sessionLineStore.seatOf("L")).toBeNull();
  });

  test("a redundant write notifies nobody", () => {
    sessionLineStore.seat("root", "L");
    let notifications = 0;
    const unsubscribe = sessionLineStore.subscribe(() => {
      notifications += 1;
    });
    sessionLineStore.seat("root", "L");
    sessionLineStore.bind("root", "L");
    expect(notifications).toBe(0);
    sessionLineStore.seat("other", "L");
    expect(notifications).toBe(1);
    unsubscribe();
  });

  test("blank ids are refused rather than filed under an empty key", () => {
    sessionLineStore.seat("", "L3");
    sessionLineStore.seat("root", "");
    expect(sessionLineStore.seatOf("L3")).toBeNull();
    expect(sessionLineStore.lineOf("root")).toBeNull();
  });
});
