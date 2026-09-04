/**
 * Background-task lifecycle frame forwarding.
 *
 * Pins `buildTaskStartedMessage` / `buildTaskUpdatedMessage` and their
 * in-turn routing against the captured wire reality in
 * `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/`
 * `v2.1.173-jobs-spike/test-jobs-lifecycle-raw.jsonl` — the factories
 * are exercised on the fixture's actual `system/task_started` and
 * `system/task_updated` lines, so a claude-side shape drift surfaces
 * here as a failure rather than as silently dropped frames.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildTaskStartedMessage,
  buildTaskUpdatedMessage,
  buildTaskProgressMessage,
  buildBackgroundTasksChangedMessage,
  routeTopLevelEvent,
  type EventMappingContext,
} from "../session.ts";

const FIXTURE_PATH = join(
  import.meta.dir,
  "../../../tugrust/crates/tugcast/tests/fixtures/stream-json-catalog",
  "v2.1.173-jobs-spike/test-jobs-lifecycle-raw.jsonl",
);

function fixtureEvents(): Array<Record<string, unknown>> {
  return readFileSync(FIXTURE_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const baseCtx: EventMappingContext = { msgId: "m1", openerId: "t-1", seq: 1, rev: 0 };

describe("buildTaskStartedMessage", () => {
  test("forwards every captured task_started line (bash and agent kinds)", () => {
    const started = fixtureEvents().filter(
      (e) => e.type === "system" && e.subtype === "task_started",
    );
    expect(started.length).toBeGreaterThanOrEqual(6);
    const kinds = new Set<string>();
    for (const event of started) {
      const frame = buildTaskStartedMessage(event, "sess-1");
      expect(frame).not.toBeNull();
      expect(frame!.type).toBe("task_started");
      expect(frame!.session_id).toBe("sess-1");
      expect(frame!.task_id.length).toBeGreaterThan(0);
      expect(frame!.tool_use_id.startsWith("toolu_")).toBe(true);
      expect(frame!.task_type.length).toBeGreaterThan(0);
      expect(frame!.ipc_version).toBe(2);
      kinds.add(frame!.task_type);
      if (frame!.task_type === "local_agent") {
        expect(typeof frame!.subagent_type).toBe("string");
      }
    }
    // The capture covers both task kinds.
    expect(kinds.has("local_bash")).toBe(true);
    expect(kinds.has("local_agent")).toBe(true);
  });

  test("rejects non-matching and malformed events", () => {
    expect(buildTaskStartedMessage({ type: "system", subtype: "init" }, "s")).toBeNull();
    expect(
      buildTaskStartedMessage({ type: "result", subtype: "task_started" }, "s"),
    ).toBeNull();
    expect(
      buildTaskStartedMessage(
        { type: "system", subtype: "task_started", tool_use_id: "toolu_x" },
        "s",
      ),
    ).toBeNull();
    expect(
      buildTaskStartedMessage(
        { type: "system", subtype: "task_started", task_id: "t1" },
        "s",
      ),
    ).toBeNull();
  });
});

describe("buildTaskUpdatedMessage", () => {
  test("flattens every captured task_updated patch (completed / failed / killed)", () => {
    const updated = fixtureEvents().filter(
      (e) => e.type === "system" && e.subtype === "task_updated",
    );
    expect(updated.length).toBeGreaterThanOrEqual(5);
    const statuses = new Set<string>();
    for (const event of updated) {
      const frame = buildTaskUpdatedMessage(event, "sess-1");
      expect(frame).not.toBeNull();
      expect(frame!.type).toBe("task_updated");
      expect(frame!.task_id.length).toBeGreaterThan(0);
      expect(typeof frame!.end_time).toBe("number");
      expect(frame!.ipc_version).toBe(2);
      statuses.add(frame!.status);
    }
    // The capture covers the full observed status vocabulary.
    expect(statuses).toEqual(new Set(["completed", "failed", "killed"]));
  });

  test("rejects events missing task_id or patch.status", () => {
    expect(
      buildTaskUpdatedMessage(
        { type: "system", subtype: "task_updated", patch: { status: "completed" } },
        "s",
      ),
    ).toBeNull();
    expect(
      buildTaskUpdatedMessage(
        { type: "system", subtype: "task_updated", task_id: "t1", patch: {} },
        "s",
      ),
    ).toBeNull();
    expect(
      buildTaskUpdatedMessage(
        { type: "system", subtype: "task_updated", task_id: "t1" },
        "s",
      ),
    ).toBeNull();
  });
});

describe("buildTaskProgressMessage", () => {
  test("forwards every captured task_progress tick with tool + usage detail", () => {
    const progress = fixtureEvents().filter(
      (e) => e.type === "system" && e.subtype === "task_progress",
    );
    expect(progress.length).toBeGreaterThanOrEqual(1);
    for (const event of progress) {
      const frame = buildTaskProgressMessage(event, "sess-1");
      expect(frame).not.toBeNull();
      expect(frame!.type).toBe("task_progress");
      expect(frame!.session_id).toBe("sess-1");
      expect(frame!.task_id.length).toBeGreaterThan(0);
      expect(frame!.tool_use_id.startsWith("toolu_")).toBe(true);
      expect(frame!.ipc_version).toBe(2);
      // The spike's bg agent runs a Bash step, so each tick carries
      // cumulative usage (the detail that lets the deck show progress).
      expect(typeof frame!.usage).toBe("object");
      expect(typeof frame!.usage!.total_tokens).toBe("number");
      expect(typeof frame!.usage!.tool_uses).toBe("number");
    }
  });

  test("rejects non-matching and id-less events; tolerates a usage-less tick", () => {
    expect(
      buildTaskProgressMessage({ type: "system", subtype: "task_started" }, "s"),
    ).toBeNull();
    expect(
      buildTaskProgressMessage(
        { type: "system", subtype: "task_progress", task_id: "t1" },
        "s",
      ),
    ).toBeNull();
    // A minimal tick (ids only, no usage / tool) still forwards — the
    // progress detail is optional.
    const minimal = buildTaskProgressMessage(
      {
        type: "system",
        subtype: "task_progress",
        task_id: "t1",
        tool_use_id: "toolu_x",
      },
      "s",
    );
    expect(minimal).not.toBeNull();
    expect(minimal!.usage).toBeUndefined();
    expect(minimal!.last_tool_name).toBeUndefined();
  });
});

/**
 * The roster event, from the live capture in
 * `tugcode/probes/background-bash-wake/FINDINGS.md` with its identifiers
 * shortened. It fires twice around a backgrounded call: once at the launch
 * carrying the new task, once at the wake carrying what remains.
 */
const ROSTER_AT_LAUNCH = {
  type: "system",
  subtype: "background_tasks_changed",
  tasks: [
    {
      task_id: "t1",
      task_type: "local_bash",
      description: "Run sleep then echo in background",
    },
  ],
  uuid: "u1",
  session_id: "c1",
} as Record<string, unknown>;

const ROSTER_AT_WAKE = {
  type: "system",
  subtype: "background_tasks_changed",
  tasks: [],
  uuid: "u2",
  session_id: "c1",
} as Record<string, unknown>;

describe("buildBackgroundTasksChangedMessage", () => {
  test("forwards the event minus its envelope", () => {
    const frame = buildBackgroundTasksChangedMessage(ROSTER_AT_LAUNCH, "sess-1");
    expect(frame).not.toBeNull();
    expect(frame!.type).toBe("background_tasks_changed");
    expect(frame!.session_id).toBe("sess-1");
    // The envelope is the frame's own `type`; carrying it inside `payload`
    // too would give a reader two places to look for one fact.
    expect(frame!.payload.type).toBeUndefined();
    expect(frame!.payload.subtype).toBeUndefined();
    // Everything else rides through unread, which is the point — a field
    // claude adds arrives without a tugcode release.
    expect(frame!.payload).toEqual({
      tasks: [
        {
          task_id: "t1",
          task_type: "local_bash",
          description: "Run sleep then echo in background",
        },
      ],
      uuid: "u1",
      session_id: "c1",
    });
  });

  test("carries the empty roster the wake reports", () => {
    // An empty `tasks` is a real statement — nothing is running — and must
    // not be mistaken for nothing to say.
    const frame = buildBackgroundTasksChangedMessage(ROSTER_AT_WAKE, "sess-1");
    expect(frame).not.toBeNull();
    expect(frame!.payload.tasks).toEqual([]);
  });

  test("returns null for every other event", () => {
    const started = fixtureEvents().find(
      (e) => e.type === "system" && e.subtype === "task_started",
    )!;
    expect(buildBackgroundTasksChangedMessage(started, "sess-1")).toBeNull();
    expect(
      buildBackgroundTasksChangedMessage(
        { type: "assistant", subtype: "background_tasks_changed" },
        "sess-1",
      ),
    ).toBeNull();
  });
});

describe("in-turn routing", () => {
  test("routeTopLevelEvent emits task_started / task_updated IPC frames", () => {
    const events = fixtureEvents();
    const started = events.find(
      (e) => e.type === "system" && e.subtype === "task_started",
    )!;
    const updated = events.find(
      (e) => e.type === "system" && e.subtype === "task_updated",
    )!;

    const startedResult = routeTopLevelEvent(started, baseCtx);
    expect(startedResult.messages).toHaveLength(1);
    expect(startedResult.messages[0]!.type).toBe("task_started");

    const updatedResult = routeTopLevelEvent(updated, baseCtx);
    expect(updatedResult.messages).toHaveLength(1);
    expect(updatedResult.messages[0]!.type).toBe("task_updated");

    const progress = events.find(
      (e) => e.type === "system" && e.subtype === "task_progress",
    )!;
    const progressResult = routeTopLevelEvent(progress, baseCtx);
    expect(progressResult.messages).toHaveLength(1);
    expect(progressResult.messages[0]!.type).toBe("task_progress");
  });

  test("routeTopLevelEvent emits the background roster instead of dropping it", () => {
    // It reached `noteUnhandledSystemSubtype` until the Step 1 capture found
    // it there, which cost tugcast the one frame that states the roster
    // rather than deriving it from edges.
    const result = routeTopLevelEvent(ROSTER_AT_LAUNCH, baseCtx);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.type).toBe("background_tasks_changed");
  });

  test("malformed task frames route to zero messages, not a throw", () => {
    const result = routeTopLevelEvent(
      { type: "system", subtype: "task_started", session_id: "s" },
      baseCtx,
    );
    expect(result.messages).toHaveLength(0);
  });
});
