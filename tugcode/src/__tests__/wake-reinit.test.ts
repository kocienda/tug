/**
 * Cohort B wake-bracket re-init detector.
 *
 * Claude's built-in scheduler fires `ScheduleWakeup` / `CronCreate`
 * timers between turns, even in stream-json spawn mode. The fire
 * signal on claude's stdout is a fresh `system/init` event — the same
 * type emitted at session spawn / first user input. These tests pin
 * the detector that distinguishes the first init (session start) from
 * subsequent inits (wake bracket open), and the bracket-open semantics
 * that mirror `handleTaskNotification` for Cohort A.
 *
 * Tests drive `handleClaudeLine` (the unified dispatch site) rather
 * than `handleInterTurnEvent`, because in new-mode sessions claude's
 * first real `system/init` arrives during the first user turn (when
 * `activeTurn !== null`) and routes via `dispatchEventToTurn`, never
 * reaching `handleInterTurnEvent`. The detector must work regardless
 * of turn state — and `handleClaudeLine` is the only place that sees
 * every event.
 *
 * See the wake-investigation findings and design decision
 * [D07].
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../session.ts";

const SESSION_ID = "session-reinit";

function initLine(): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
  });
}

describe("SessionManager — system/init re-init detector via handleClaudeLine", () => {
  let projectDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "wake-reinit-"));
    manager = new SessionManager(projectDir, SESSION_ID, "new", undefined, {
      sessionsDbPath: null,
    });
  });
  afterEach(() => {
    void manager.shutdown();
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("first system/init flips sessionInitSeen and does not open a wake bracket", () => {
    expect((manager as any).sessionInitSeen).toBe(false);
    expect((manager as any).isInWake).toBe(false);
    expect((manager as any).activeTurn).toBeNull();

    (manager as any).handleClaudeLine(initLine());

    expect((manager as any).sessionInitSeen).toBe(true);
    expect((manager as any).isInWake).toBe(false);
    expect((manager as any).activeTurn).toBeNull();
  });

  test("second system/init between turns (activeTurn null) opens a wake bracket: isInWake true, activeTurn non-null", () => {
    (manager as any).handleClaudeLine(initLine());
    expect((manager as any).sessionInitSeen).toBe(true);

    // Between-turn state: activeTurn is null.
    expect((manager as any).activeTurn).toBeNull();

    (manager as any).handleClaudeLine(initLine());

    expect((manager as any).isInWake).toBe(true);
    expect((manager as any).activeTurn).not.toBeNull();
  });

  test("first system/init arriving while activeTurn is set (mid-turn) still flips sessionInitSeen", () => {
    // Simulate a new-mode session where claude's first real init lands
    // during the user's first turn (which is exactly what happens in
    // production — see initialize() comment about claude staying silent
    // until first input).
    (manager as any).activeTurn = {
      gotResult: false,
      messageBlocks: new Map(),
      updateBlockStateFromMessages: () => {},
      accountActivity: () => {},
      laneFor: () => ({ msgId: null, rev: 0, partialText: "", messageBlocks: new Map() }),
    }; // stub turn
    expect((manager as any).sessionInitSeen).toBe(false);

    (manager as any).handleClaudeLine(initLine());

    expect((manager as any).sessionInitSeen).toBe(true);
    expect((manager as any).isInWake).toBe(false);
  });

  test("re-init MID-TURN (e.g. post-compact_boundary) does NOT open a wake bracket", () => {
    // First init at session start (between turns).
    (manager as any).handleClaudeLine(initLine());
    expect((manager as any).sessionInitSeen).toBe(true);

    // User submits → activeTurn set.
    (manager as any).activeTurn = {
      gotResult: false,
      messageBlocks: new Map(),
      updateBlockStateFromMessages: () => {},
      accountActivity: () => {},
      laneFor: () => ({ msgId: null, rev: 0, partialText: "", messageBlocks: new Map() }),
    };

    // Claude emits compact_boundary mid-turn, then re-emits system/init.
    // The second init lands while activeTurn is set — it must NOT be
    // treated as a wake (the test 'compact_boundary system event
    // produces compact_boundary IPC' in session.test.ts pins the
    // existing two-system_metadata behavior).
    const turnBefore = (manager as any).activeTurn;
    (manager as any).handleClaudeLine(initLine());

    expect((manager as any).isInWake).toBe(false);
    // activeTurn unchanged (mid-turn re-init falls through to
    // dispatchEventToTurn, which doesn't clobber the slot).
    expect((manager as any).activeTurn).toBe(turnBefore);
  });

  test("nested re-init during an open wake bracket is silently ignored (no second ActiveTurn)", () => {
    (manager as any).handleClaudeLine(initLine());
    (manager as any).handleClaudeLine(initLine());

    const firstTurn = (manager as any).activeTurn;
    expect(firstTurn).not.toBeNull();

    (manager as any).handleClaudeLine(initLine());

    expect((manager as any).activeTurn).toBe(firstTurn);
  });

  test("post-respawn (killAndCleanup) resets sessionInitSeen so the new spawn's first init is treated as a first init", async () => {
    (manager as any).handleClaudeLine(initLine());
    expect((manager as any).sessionInitSeen).toBe(true);

    await (manager as any).killAndCleanup();
    expect((manager as any).sessionInitSeen).toBe(false);

    (manager as any).handleClaudeLine(initLine());
    expect((manager as any).sessionInitSeen).toBe(true);
    expect((manager as any).isInWake).toBe(false);
  });

  test("non-init events bypass the detector entirely", () => {
    (manager as any).handleClaudeLine(
      JSON.stringify({
        type: "system",
        subtype: "status",
        message: "ok",
      }),
    );

    expect((manager as any).sessionInitSeen).toBe(false);
    expect((manager as any).isInWake).toBe(false);
  });
});
