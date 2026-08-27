/**
 * Pure-logic tests for `useTaskListState`'s transcript walk. The hook
 * itself wraps `useSyncExternalStore` + `useMemo` (React's job); we pin
 * `iterateAllTaskCalls` (the fold input) composed with
 * `reduceTaskListState`, which together establish the persistence
 * contract: the fold spans the whole transcript regardless of turn
 * boundaries, so a checklist does NOT collapse to empty the instant a
 * new turn opens with no Task* frame yet (the former turn-gate flicker).
 */

import { describe, expect, test } from "bun:test";

import { iterateAllTaskCalls } from "@/lib/code-session-store/hooks/use-task-list-state";
import { reduceTaskListState } from "@/lib/code-session-store/select-task-list";
import type {
  Message,
  ToolUseMessage,
  TurnEntry,
} from "@/lib/code-session-store/types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function taskCreate(subject: string, resultId: number): ToolUseMessage {
  return {
    kind: "tool_use",
    messageKey: `mk-create-${resultId}`,
    createdAt: 0,
    toolUseId: `tu-create-${resultId}`,
    toolName: "TaskCreate",
    input: { subject },
    status: "done",
    result: `Task #${resultId} created successfully: ${subject}`,
    structuredResult: null,
    toolWallMs: null,
  };
}

function taskUpdate(taskId: string, status: string): ToolUseMessage {
  return {
    kind: "tool_use",
    messageKey: `mk-update-${taskId}-${status}`,
    createdAt: 0,
    toolUseId: `tu-update-${taskId}-${status}`,
    toolName: "TaskUpdate",
    input: { taskId, status },
    status: "done",
    result: `Updated task #${taskId} status`,
    structuredResult: null,
    toolWallMs: null,
  };
}

function userMsg(): Message {
  return {
    kind: "user_message",
    messageKey: "mk-user",
    createdAt: 0,
    text: "hi",
    attachments: [],
    origin: "user",
    submitAt: 0,
  } as Message;
}

function turn(turnKey: string, messages: ReadonlyArray<Message>): TurnEntry {
  return { turnKey, msgId: turnKey, messages } as unknown as TurnEntry;
}

function fold(transcript: TurnEntry[], inflight: Message[]) {
  return reduceTaskListState(iterateAllTaskCalls(transcript, inflight));
}

// ---------------------------------------------------------------------------
// iterateAllTaskCalls — order-preserving tool_use walk
// ---------------------------------------------------------------------------

describe("iterateAllTaskCalls", () => {
  test("yields committed then in-flight tool_use in order, skipping non-tool_use", () => {
    const t1 = turn("t1", [userMsg(), taskCreate("A", 1)]);
    const inflight: Message[] = [userMsg(), taskUpdate("1", "completed")];
    const ids = [...iterateAllTaskCalls([t1], inflight)].map((m) => m.toolName);
    expect(ids).toEqual(["TaskCreate", "TaskUpdate"]);
  });
});

// ---------------------------------------------------------------------------
// Persistence — the flicker fix
// ---------------------------------------------------------------------------

describe("task list persists across the turn-open gap", () => {
  test("an incomplete checklist + an empty new in-flight turn stays visible", () => {
    const calcTurn = turn("calc", [
      taskCreate("A", 1),
      taskCreate("B", 2),
      taskUpdate("1", "in_progress"),
    ]);
    // A new turn just opened — no Task* frame yet, only the user opener.
    const emptyInflight: Message[] = [userMsg()];
    const state = fold([calcTurn], emptyInflight);
    // Former turn-gate would return empty here; now it persists.
    expect(state.tasks.map((t) => t.subject)).toEqual(["A", "B"]);
    expect(state.tasks[0].status).toBe("in_progress");
  });

  test("an incomplete checklist + a committed non-Task* turn stays visible", () => {
    const calcTurn = turn("calc", [taskCreate("A", 1)]);
    const helloTurn = turn("hello", [userMsg()]);
    const state = fold([calcTurn, helloTurn], []);
    expect(state.tasks.map((t) => t.subject)).toEqual(["A"]);
  });

  test("a fresh TaskCreate over a fully-completed batch still supersedes", () => {
    const doneTurn = turn("done", [
      taskCreate("old", 1),
      taskUpdate("1", "completed"),
    ]);
    const newTurn = turn("new", [taskCreate("fresh", 2)]);
    const state = fold([doneTurn, newTurn], []);
    expect(state.tasks.map((t) => t.subject)).toEqual(["fresh"]);
  });
});
