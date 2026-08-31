/**
 * Pure-logic tests for `TaskInlineToolBlock`'s exported helpers —
 * `deriveTaskInlineKind`, `composeCreatedLabel`,
 * `composeUpdatedLabel`, `resolveUpdateSubject`, and the unified
 * `composeMarkerText` switch. Plus the dispatch registration pins
 * for both `taskcreate` and `taskupdate`, which both point at the
 * same wrapper.
 *
 * No DOM: per the project's testing policy these are `bun:test`
 * pure-logic assertions, not fake-DOM render tests. The visible
 * tone treatment (`emphasis="whisper"` for the steady-state row /
 * `role="danger"` + `emphasis="normal"` for an errored event) is
 * implementation-encoded in the React branch — not separately
 * extractable as a pure helper, so it isn't pinned here.
 * `composeMarkerText` is the pure surface that drives every
 * non-error row's visible string; tests pin every branch.
 *
 * The folded-run helpers (`composeTaskRunLabel`,
 * `resolveTaskRunSubjects`) are pinned here too; which runs qualify
 * for the fold is `session-transcript-task-runs.test.ts`.
 *
 * @module components/tugways/cards/blocks/__tests__/task-inline-tool-block
 */

import { describe, expect, test } from "bun:test";

import {
  TaskInlineToolBlock,
  composeCreatedLabel,
  composeMarker,
  composeMarkerText,
  composeTaskInlineErrorRow,
  composeTaskRunLabel,
  composeUpdatedLabel,
  deriveTaskInlineKind,
  resolveTaskRunSubjects,
  resolveUpdateSubject,
} from "../task-inline-tool-block";
import { BESPOKE_FACTORY_BY_NAME } from "../../session-assistant-renderer-registrations";
import type { TaskItem } from "@/lib/code-session-store/select-task-list";
import type { ToolUseMessage } from "@/lib/code-session-store";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TASKS: readonly TaskItem[] = Object.freeze([
  { taskId: "1", subject: "Write the spec", status: "completed" },
  { taskId: "2", subject: "Land the wrapper", status: "in_progress" },
  { taskId: "3", subject: "Ship the gallery", status: "pending" },
]);

// ---------------------------------------------------------------------------
// deriveTaskInlineKind
// ---------------------------------------------------------------------------

describe("deriveTaskInlineKind", () => {
  test("`TaskCreate` → create", () => {
    expect(deriveTaskInlineKind("TaskCreate")).toBe("create");
  });

  test("`TaskUpdate` → update", () => {
    expect(deriveTaskInlineKind("TaskUpdate")).toBe("update");
  });

  test("case-insensitive", () => {
    expect(deriveTaskInlineKind("taskcreate")).toBe("create");
    expect(deriveTaskInlineKind("TASKUPDATE")).toBe("update");
  });

  test("returns null for an unrecognised name", () => {
    expect(deriveTaskInlineKind("Task")).toBeNull();
    expect(deriveTaskInlineKind("TaskList")).toBeNull();
    expect(deriveTaskInlineKind("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// composeCreatedLabel
// ---------------------------------------------------------------------------

describe("composeCreatedLabel", () => {
  test("formats as `Created: <subject>`", () => {
    expect(composeCreatedLabel("Write the spec")).toBe("Created: Write the spec");
  });

  test("preserves the subject verbatim (no trimming, no truncation)", () => {
    expect(composeCreatedLabel("  spaced  ")).toBe("Created:   spaced  ");
  });
});

// ---------------------------------------------------------------------------
// composeUpdatedLabel
// ---------------------------------------------------------------------------

describe("composeUpdatedLabel", () => {
  test("in_progress → `Started: <subject>`", () => {
    expect(composeUpdatedLabel("in_progress", "Write the spec")).toBe(
      "Started: Write the spec",
    );
  });

  test("completed → `Completed: <subject>`", () => {
    expect(composeUpdatedLabel("completed", "Write the spec")).toBe(
      "Completed: Write the spec",
    );
  });

  test("pending → `Reset: <subject>` (rare revert)", () => {
    expect(composeUpdatedLabel("pending", "Write the spec")).toBe(
      "Reset: Write the spec",
    );
  });

  test("deleted → `Deleted: <subject>`", () => {
    expect(composeUpdatedLabel("deleted", "Write the spec")).toBe(
      "Deleted: Write the spec",
    );
  });

  test("no status → `Edited: <subject>`", () => {
    expect(composeUpdatedLabel(undefined, "Write the spec")).toBe(
      "Edited: Write the spec",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveUpdateSubject
// ---------------------------------------------------------------------------

describe("resolveUpdateSubject", () => {
  test("returns the matched task's subject when the id is present", () => {
    expect(resolveUpdateSubject("2", TASKS)).toBe("Land the wrapper");
  });

  test("falls back to `Task #<id>` when the id is unknown", () => {
    expect(resolveUpdateSubject("99", TASKS)).toBe("Task #99");
  });

  test("falls back even when the task list is empty", () => {
    expect(resolveUpdateSubject("1", [])).toBe("Task #1");
  });
});

// ---------------------------------------------------------------------------
// composeMarkerText
// ---------------------------------------------------------------------------

describe("composeMarkerText", () => {
  test("create + ready + valid input → `Created: <subject>`", () => {
    expect(
      composeMarkerText({
        kind: "create",
        input: { subject: "Write the spec" },
        status: "ready",
        tasks: TASKS,
      }),
    ).toBe("Created: Write the spec");
  });

  test("create + streaming → `Creating…`", () => {
    expect(
      composeMarkerText({
        kind: "create",
        input: {},
        status: "streaming",
        tasks: TASKS,
      }),
    ).toBe("Creating…");
  });

  test("create + ready + invalid input → falls back to `Creating…`", () => {
    expect(
      composeMarkerText({
        kind: "create",
        input: { not_subject: 42 },
        status: "ready",
        tasks: TASKS,
      }),
    ).toBe("Creating…");
  });

  test("update + ready + in_progress on known id → `Started: <subject>`", () => {
    expect(
      composeMarkerText({
        kind: "update",
        input: { taskId: "2", status: "in_progress" },
        status: "ready",
        tasks: TASKS,
      }),
    ).toBe("Started: Land the wrapper");
  });

  test("update + ready + completed on known id → `Completed: <subject>`", () => {
    expect(
      composeMarkerText({
        kind: "update",
        input: { taskId: "1", status: "completed" },
        status: "ready",
        tasks: TASKS,
      }),
    ).toBe("Completed: Write the spec");
  });

  test("update + ready + unknown id → `<Verb>: Task #<id>`", () => {
    expect(
      composeMarkerText({
        kind: "update",
        input: { taskId: "99", status: "completed" },
        status: "ready",
        tasks: TASKS,
      }),
    ).toBe("Completed: Task #99");
  });

  test("update + streaming → `Updating…`", () => {
    expect(
      composeMarkerText({
        kind: "update",
        input: { taskId: "2" }, // status missing → partial input
        status: "streaming",
        tasks: TASKS,
      }),
    ).toBe("Updating…");
  });

  test("update + ready + invalid input → falls back to `Updating…`", () => {
    expect(
      composeMarkerText({
        kind: "update",
        input: { taskId: 99, status: "bogus" },
        status: "ready",
        tasks: TASKS,
      }),
    ).toBe("Updating…");
  });

  test("null kind → generic placeholder (defensive)", () => {
    expect(
      composeMarkerText({
        kind: null,
        input: {},
        status: "ready",
        tasks: TASKS,
      }),
    ).toBe("Task event");
  });
});

// ---------------------------------------------------------------------------
// composeMarker — the structured state + parts that drive the icon
// and the verb / subject split. `composeMarkerText` is derived from
// this, so the assertions above already cover the joined-string form;
// these pin the `state` that selects the per-state icon.
// ---------------------------------------------------------------------------

describe("composeMarker", () => {
  test("create + ready → state `created`, verb `Created`, subject from input", () => {
    expect(
      composeMarker({
        kind: "create",
        input: { subject: "Write the spec" },
        status: "ready",
        tasks: TASKS,
      }),
    ).toEqual({ state: "created", verb: "Created", subject: "Write the spec" });
  });

  test("update + in_progress → state `started`", () => {
    expect(
      composeMarker({
        kind: "update",
        input: { taskId: "2", status: "in_progress" },
        status: "ready",
        tasks: TASKS,
      }),
    ).toEqual({ state: "started", verb: "Started", subject: "Land the wrapper" });
  });

  test("update + completed → state `completed`", () => {
    expect(
      composeMarker({
        kind: "update",
        input: { taskId: "1", status: "completed" },
        status: "ready",
        tasks: TASKS,
      }).state,
    ).toBe("completed");
  });

  test("update + pending → state `reset`", () => {
    expect(
      composeMarker({
        kind: "update",
        input: { taskId: "3", status: "pending" },
        status: "ready",
        tasks: TASKS,
      }),
    ).toEqual({ state: "reset", verb: "Reset", subject: "Ship the gallery" });
  });

  test("update + deleted → state `deleted`, subject by id (the task is gone from the settled fold)", () => {
    expect(
      composeMarker({
        kind: "update",
        input: { taskId: "9", status: "deleted" },
        status: "ready",
        tasks: TASKS,
      }),
    ).toEqual({ state: "deleted", verb: "Deleted", subject: "Task #9" });
  });

  test("update with no status → state `edited`, not the streaming placeholder", () => {
    expect(
      composeMarker({
        kind: "update",
        input: { taskId: "3", subject: "Ship the gallery, revised" },
        status: "ready",
        tasks: TASKS,
      }),
    ).toEqual({
      state: "edited",
      verb: "Edited",
      subject: "Ship the gallery, revised",
    });
  });

  test("update with no status and no subject falls back to the fold's subject", () => {
    expect(
      composeMarker({
        kind: "update",
        input: { taskId: "3", description: "more detail" },
        status: "ready",
        tasks: TASKS,
      }),
    ).toEqual({ state: "edited", verb: "Edited", subject: "Ship the gallery" });
  });

  test("streaming create → state `creating`, no subject", () => {
    expect(
      composeMarker({
        kind: "create",
        input: {},
        status: "streaming",
        tasks: TASKS,
      }),
    ).toEqual({ state: "creating", verb: "Creating…", subject: "" });
  });

  test("streaming update → state `updating`, no subject", () => {
    expect(
      composeMarker({
        kind: "update",
        input: { taskId: "2" },
        status: "streaming",
        tasks: TASKS,
      }),
    ).toEqual({ state: "updating", verb: "Updating…", subject: "" });
  });

  test("null kind → state `unknown` (defensive)", () => {
    expect(
      composeMarker({
        kind: null,
        input: {},
        status: "ready",
        tasks: TASKS,
      }),
    ).toEqual({ state: "unknown", verb: "Task event", subject: "" });
  });
});

// ---------------------------------------------------------------------------
// composeTaskInlineErrorRow
// ---------------------------------------------------------------------------

describe("composeTaskInlineErrorRow", () => {
  /**
   * A real `InputValidationError` as Claude Code emitted it when the
   * assistant called `TaskCreate` with the `Agent` tool's parameters.
   */
  const AGENT_PARAMS_ERROR =
    "InputValidationError: TaskCreate failed due to the following issues: " +
    "The required parameter `subject` is missing " +
    "The required parameter `description` is missing " +
    "An unexpected parameter `prompt` was provided " +
    "This call used Agent-tool parameters (`prompt`/`subagent_type`). " +
    "TaskCreate adds an item to the task list and takes `subject` and " +
    "`description` string parameters. To delegate work to a subagent, " +
    "use the Agent tool instead.";

  test("condenses the real Agent-parameters error to one line", () => {
    expect(composeTaskInlineErrorRow(AGENT_PARAMS_ERROR)).toEqual({
      label: "Rejected",
      subject: "TaskCreate — missing subject, description; unexpected prompt",
      full: AGENT_PARAMS_ERROR,
    });
  });

  test("the condensed subject is far shorter than the raw text", () => {
    const row = composeTaskInlineErrorRow(AGENT_PARAMS_ERROR);
    expect(row.subject.length).toBeLessThan(AGENT_PARAMS_ERROR.length / 4);
  });

  test("missing-only error omits the unexpected clause", () => {
    const row = composeTaskInlineErrorRow(
      "InputValidationError: TaskUpdate failed due to the following issues: " +
        "The required parameter `taskId` is missing",
    );
    expect(row.subject).toBe("TaskUpdate — missing taskId");
  });

  test("unexpected-only error omits the missing clause", () => {
    const row = composeTaskInlineErrorRow(
      "InputValidationError: TaskCreate failed due to the following issues: " +
        "An unexpected parameter `model` was provided",
    );
    expect(row.subject).toBe("TaskCreate — unexpected model");
  });

  test("a validation error with no itemisable issues still condenses", () => {
    const text =
      'InputValidationError: [ { "code": "too_big", "path": [ "questions" ] } ]';
    expect(composeTaskInlineErrorRow(text)).toEqual({
      label: "Rejected",
      subject: "invalid parameters",
      full: text,
    });
  });

  test("a non-validation error passes through verbatim, with no verb", () => {
    const row = composeTaskInlineErrorRow("Tool call timed out after 120s");
    expect(row).toEqual({ subject: "Tool call timed out after 120s" });
  });

  test("absent / empty output falls back to a generic label", () => {
    expect(composeTaskInlineErrorRow(undefined)).toEqual({ subject: "Failed" });
    expect(composeTaskInlineErrorRow("")).toEqual({ subject: "Failed" });
  });

  test("the full text is preserved whenever the row condenses", () => {
    const row = composeTaskInlineErrorRow(AGENT_PARAMS_ERROR);
    expect(row.full).toBe(AGENT_PARAMS_ERROR);
  });

  test("repeated calls are stable (the global regexes carry no lastIndex)", () => {
    const first = composeTaskInlineErrorRow(AGENT_PARAMS_ERROR);
    const second = composeTaskInlineErrorRow(AGENT_PARAMS_ERROR);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Dispatch registration — both `taskcreate` AND `taskupdate` map to
// the SAME `TaskInlineToolBlock` factory (no aliasing — two
// canonical wire names sharing one wrapper, per [#step-24-3-5]).
// ---------------------------------------------------------------------------

describe("dispatch registration", () => {
  test("`taskcreate` maps to the bespoke wrapper", () => {
    expect(BESPOKE_FACTORY_BY_NAME.get("taskcreate")).toBe(TaskInlineToolBlock);
  });

  test("`taskupdate` maps to the bespoke wrapper (same factory)", () => {
    expect(BESPOKE_FACTORY_BY_NAME.get("taskupdate")).toBe(TaskInlineToolBlock);
  });

  test("both names share the same factory reference", () => {
    expect(BESPOKE_FACTORY_BY_NAME.get("taskcreate")).toBe(
      BESPOKE_FACTORY_BY_NAME.get("taskupdate"),
    );
  });
});

// ---------------------------------------------------------------------------
// Folded run — the row that stands in for a bulk sweep.
// ---------------------------------------------------------------------------

function member(toolName: string, input: unknown): ToolUseMessage {
  return {
    kind: "tool_use",
    messageKey: `k-${String(Math.abs(JSON.stringify(input).length))}-${toolName}`,
    createdAt: 0,
    toolUseId: "id",
    toolName,
    input,
    status: "done",
    result: null,
    structuredResult: null,
    toolWallMs: null,
  };
}

describe("composeTaskRunLabel", () => {
  test("verb over count", () => {
    expect(composeTaskRunLabel("Deleted", 19)).toBe("Deleted 19 tasks");
    expect(composeTaskRunLabel("Created", 8)).toBe("Created 8 tasks");
  });
});

describe("resolveTaskRunSubjects", () => {
  test("a create run reads its subjects out of the inputs", () => {
    const members = ["The clock tells the truth", "No NUL bytes in source"].map((s) =>
      member("TaskCreate", { subject: s }),
    );
    expect(resolveTaskRunSubjects(members, TASKS)).toEqual([
      "The clock tells the truth",
      "No NUL bytes in source",
    ]);
  });

  test("an update run resolves subjects through the fold", () => {
    const members = [
      member("TaskUpdate", { taskId: "1", status: "completed" }),
      member("TaskUpdate", { taskId: "2", status: "completed" }),
    ];
    expect(resolveTaskRunSubjects(members, TASKS)).toEqual([
      "Write the spec",
      "Land the wrapper",
    ]);
  });

  test("a delete run falls back to ids — the fold no longer holds them", () => {
    const members = ["51", "52", "53"].map((taskId) =>
      member("TaskUpdate", { taskId, status: "deleted" }),
    );
    expect(resolveTaskRunSubjects(members, TASKS)).toEqual([
      "Task #51",
      "Task #52",
      "Task #53",
    ]);
  });

  test("order is run order — the row's list reads as the wall did", () => {
    const members = ["c", "a", "b"].map((s) => member("TaskCreate", { subject: s }));
    expect(resolveTaskRunSubjects(members, TASKS)).toEqual(["c", "a", "b"]);
  });
});
