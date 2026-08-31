/**
 * Unit tests for `session-transcript-task-runs.ts` — the grouping that
 * folds a run of consecutive same-verb `TaskCreate` / `TaskUpdate`
 * markers into one transcript row.
 *
 * The shape under test is the one a real session produces: batches of
 * creates per turn, singles interleaved as work proceeds, and the
 * occasional bulk `deleted` sweep (there is no clear event on the wire,
 * so a tidy-up is one `TaskUpdate` per task) that used to paint a wall
 * of identical rows.
 *
 * Pure over `Message[]` — no store, no mount.
 */

import { describe, it, expect } from "bun:test";

import type {
  Message,
  AssistantText,
  ToolUseMessage,
} from "@/lib/code-session-store";

import {
  groupTaskMarkerRuns,
  TASK_RUN_MIN_LENGTH,
  type TaskRunPlacement,
} from "./session-transcript-task-runs";

let seq = 0;

function text(value = "prose"): AssistantText {
  return { kind: "assistant_text", messageKey: `t-${seq++}`, createdAt: 0, text: value };
}

function tool(
  toolName: string,
  input: unknown,
  overrides: Partial<ToolUseMessage> = {},
): ToolUseMessage {
  const n = seq++;
  return {
    kind: "tool_use",
    messageKey: `tu-${n}`,
    createdAt: 0,
    toolUseId: `id-${n}`,
    toolName,
    input,
    status: "done",
    result: null,
    structuredResult: null,
    toolWallMs: null,
    ...overrides,
  };
}

/** One `TaskCreate` with the given subject. */
function create(subject: string, overrides: Partial<ToolUseMessage> = {}): ToolUseMessage {
  return tool("TaskCreate", { subject }, overrides);
}

/** One `TaskUpdate` flipping `taskId` to `status`. */
function update(
  taskId: string,
  status: string,
  overrides: Partial<ToolUseMessage> = {},
): ToolUseMessage {
  return tool("TaskUpdate", { taskId, status }, overrides);
}

/** N deletes, ids ascending from `from` — the bulk-sweep shape. */
function deletes(from: number, count: number): ToolUseMessage[] {
  return Array.from({ length: count }, (_, i) => update(String(from + i), "deleted"));
}

/** The lead placement for `message`, asserted to exist and be a lead. */
function lead(
  placements: ReadonlyMap<string, TaskRunPlacement>,
  message: Message,
): Extract<TaskRunPlacement, { role: "lead" }> {
  const placement = placements.get(message.messageKey);
  expect(placement?.role).toBe("lead");
  return placement as Extract<TaskRunPlacement, { role: "lead" }>;
}

// ---------------------------------------------------------------------------
// The case this exists for
// ---------------------------------------------------------------------------

describe("groupTaskMarkerRuns — bulk sweep", () => {
  it("folds a 19-delete sweep into one lead carrying every member", () => {
    const sweep = deletes(51, 19);
    const placements = groupTaskMarkerRuns(sweep);

    const head = lead(placements, sweep[0]);
    expect(head.verb).toBe("Deleted");
    expect(head.state).toBe("deleted");
    expect(head.members).toHaveLength(19);
    // Order is transcript order, lead first — the row's subject list
    // reads #51 → #69 as the wall did.
    expect(head.members.map((m) => m.messageKey)).toEqual(
      sweep.map((m) => m.messageKey),
    );
    for (const member of sweep.slice(1)) {
      expect(placements.get(member.messageKey)).toEqual({ role: "member" });
    }
  });

  it("folds the sweep and the fresh batch after it as two separate runs", () => {
    // The screenshot's shape: 19 deletes, then 8 creates, no message
    // between them. Different verbs never merge.
    const sweep = deletes(51, 19);
    const batch = ["Step 1", "Step 2", "Step 3", "Step 4"].map((s) => create(s));
    const placements = groupTaskMarkerRuns([...sweep, ...batch]);

    expect(lead(placements, sweep[0]).members).toHaveLength(19);
    const created = lead(placements, batch[0]);
    expect(created.verb).toBe("Created");
    expect(created.members).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// What breaks a run
// ---------------------------------------------------------------------------

describe("groupTaskMarkerRuns — run boundaries", () => {
  it("a different verb ends the run", () => {
    const a = deletes(1, 3);
    const flip = update("9", "completed");
    const b = deletes(10, 3);
    const placements = groupTaskMarkerRuns([...a, flip, ...b]);

    expect(lead(placements, a[0]).members).toHaveLength(3);
    expect(placements.has(flip.messageKey)).toBe(false);
    expect(lead(placements, b[0]).members).toHaveLength(3);
  });

  it("any other message ends the run", () => {
    const a = deletes(1, 3);
    const prose = text();
    const b = deletes(10, 3);
    const placements = groupTaskMarkerRuns([...a, prose, ...b]);

    expect(lead(placements, a[0]).members).toHaveLength(3);
    expect(lead(placements, b[0]).members).toHaveLength(3);
  });

  it("a non-Task tool call ends the run", () => {
    const a = deletes(1, 3);
    const bash = tool("Bash", { command: "ls" });
    const b = deletes(10, 3);
    const placements = groupTaskMarkerRuns([...a, bash, ...b]);

    expect(lead(placements, a[0]).members).toHaveLength(3);
    expect(lead(placements, b[0]).members).toHaveLength(3);
    expect(placements.has(bash.messageKey)).toBe(false);
  });

  it("the interleaved start/complete rhythm never folds", () => {
    // The shape [D100] assumed: one start, one complete, repeating.
    // No two adjacent markers share a verb, so nothing groups.
    const messages: Message[] = [];
    for (let i = 1; i <= 6; i += 1) {
      messages.push(update(String(i), "in_progress"), update(String(i), "completed"));
    }
    expect(groupTaskMarkerRuns(messages).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// What never groups
// ---------------------------------------------------------------------------

describe("groupTaskMarkerRuns — non-members", () => {
  it("leaves a run shorter than the minimum alone", () => {
    const short = deletes(1, TASK_RUN_MIN_LENGTH - 1);
    expect(groupTaskMarkerRuns(short).size).toBe(0);

    const atMinimum = deletes(1, TASK_RUN_MIN_LENGTH);
    expect(lead(groupTaskMarkerRuns(atMinimum), atMinimum[0]).members).toHaveLength(
      TASK_RUN_MIN_LENGTH,
    );
  });

  it("an in-flight call is not a member, and ends the run", () => {
    // Its verb is not settled — folding it would let the group's
    // identity change under the reader as the input streams in.
    const a = deletes(1, 3);
    const inFlight = update("20", "deleted", { status: "pending" });
    const b = deletes(30, 3);
    const placements = groupTaskMarkerRuns([...a, inFlight, ...b]);

    expect(placements.has(inFlight.messageKey)).toBe(false);
    expect(lead(placements, a[0]).members).toHaveLength(3);
    expect(lead(placements, b[0]).members).toHaveLength(3);
  });

  it("an errored call is not a member — the rejection keeps its own row", () => {
    const errored = deletes(1, 3).map((m) => ({ ...m, status: "error" as const }));
    expect(groupTaskMarkerRuns(errored).size).toBe(0);
  });

  it("a subagent's nested calls never group", () => {
    const nested = deletes(1, 4).map((m) => ({ ...m, parentToolUseId: "agent-1" }));
    expect(groupTaskMarkerRuns(nested).size).toBe(0);
  });

  it("an unparsable input is not a member", () => {
    // No `taskId` → the marker is an `Updating…` placeholder, whose
    // verb says nothing a fold could be keyed on.
    const junk = Array.from({ length: 4 }, () => tool("TaskUpdate", { nope: true }));
    expect(groupTaskMarkerRuns(junk).size).toBe(0);
  });

  it("returns an empty map for a turn with no task events", () => {
    expect(groupTaskMarkerRuns([text(), tool("Bash", {}), text()]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Verb coverage — every folded verb is a real one
// ---------------------------------------------------------------------------

describe("groupTaskMarkerRuns — verbs", () => {
  it.each([
    ["deleted", "Deleted"],
    ["completed", "Completed"],
    ["in_progress", "Started"],
    ["pending", "Reset"],
  ])("a run of %s folds under %s", (wire, verb) => {
    const messages = Array.from({ length: 3 }, (_, i) => update(String(i), wire));
    expect(lead(groupTaskMarkerRuns(messages), messages[0]).verb).toBe(verb);
  });

  it("a run of creates folds under Created", () => {
    const messages = ["a", "b", "c"].map((s) => create(s));
    expect(lead(groupTaskMarkerRuns(messages), messages[0]).verb).toBe("Created");
  });
});
