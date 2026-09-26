/**
 * Reducer tests for the `confirm-written-paths` effect — the path resolver's
 * third door ([B12]), and specifically which turns are allowed through it.
 *
 * The door exists because of an ordering: a turn that writes a file names its
 * path in the tool block *before* the file is on disk, the annotator probes it
 * then and records `missing`, and the verdict is trusted for a minute — so a
 * hand-off line printed at the end of that same turn reads as pointing at
 * nothing. A `Write`/`Edit` result, or a shell result carrying a
 * `TUG-FILE-RECEIPT`, is the session's own word that the file landed, and the
 * effect is how that word reaches the resolver without a round trip.
 *
 * **Replay is the whole of the exclusion, and a wake turn is not a replay.** A
 * replayed `Write` is a claim about a moment that has passed, and confirming a
 * since-deleted path from one would manufacture a link. A wake turn — a
 * backgrounded command finished and the model is working again — is a present
 * turn, and its writes are present writes. That distinction is what these
 * tests pin, because the emission had no test at all and the first spelling of
 * the gate reused `isLive` (`!isReplaying && !isWaking`), which quietly took
 * the wake case out. Which is the common case in this lane: an arc stage that
 * backgrounds a build and writes a document when it returns is exactly the
 * shape the door was built for.
 *
 * Pins:
 *   - a live `Write` emits the effect naming the path its input carried,
 *   - a `Write` inside a wake turn emits it too,
 *   - a shell result's `TUG-FILE-RECEIPT` emits every path it says landed,
 *   - an errored `Write` emits nothing,
 *   - a replayed `Write` emits nothing.
 */

import { describe, test, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type { Effect } from "@/lib/code-session-store/effects";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

const BRIEF = "/proj/briefs/grab-dots-brief.md";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function send(turnKey: string): CodeSessionEvent {
  return {
    type: "send",
    text: "hi",
    atoms: [],
    content: [{ type: "text" as const, text: "hi" }],
    turnKey,
  } as CodeSessionEvent;
}

function wakeStarted(turnKey: string): CodeSessionEvent {
  return {
    type: "wake_started",
    session_id: "s",
    wake_trigger: {
      task_id: "bg-1",
      tool_use_id: "",
      status: "completed",
      summary: "",
      output_file: "",
    },
    turnKey,
  } as CodeSessionEvent;
}

function toolUse(
  toolName: string,
  input: Record<string, unknown>,
): CodeSessionEvent {
  return {
    type: "tool_use",
    msg_id: "m1",
    tool_use_id: "t1",
    tool_name: toolName,
    input,
  } as CodeSessionEvent;
}

function toolResult(output: string, isError = false): CodeSessionEvent {
  return {
    type: "tool_result",
    tool_use_id: "t1",
    output,
    is_error: isError,
  } as CodeSessionEvent;
}

/** The paths every `confirm-written-paths` effect in `effects` names. */
function confirmed(effects: readonly Effect[]): string[] {
  return effects.flatMap((e) =>
    e.kind === "confirm-written-paths" ? e.paths : [],
  );
}

describe("reducer — confirm-written-paths", () => {
  test("a live Write confirms the path its input named", () => {
    let s = fresh();
    s = reduce(s, send("k1")).state;
    s = reduce(s, toolUse("Write", { file_path: BRIEF })).state;
    const { effects } = reduce(s, toolResult("ok"));
    expect(confirmed(effects)).toEqual([BRIEF]);
  });

  test("a Write inside a wake turn confirms it too", () => {
    let s = fresh();
    s = reduce(s, wakeStarted("wk1")).state;
    expect(s.phase).toBe("waking");
    s = reduce(s, toolUse("Write", { file_path: BRIEF })).state;
    const { effects } = reduce(s, toolResult("ok"));
    expect(confirmed(effects)).toEqual([BRIEF]);
  });

  test("a shell result's TUG-FILE-RECEIPT confirms every path it landed", () => {
    let s = fresh();
    s = reduce(s, send("k1")).state;
    s = reduce(s, toolUse("Bash", { command: "tugtool file edit" })).state;
    const receipt =
      'TUG-FILE-RECEIPT: {"ops":[{"op":"modified","path":"/proj/a.rs"},' +
      '{"op":"created","path":"/proj/b.rs"},' +
      '{"op":"deleted","path":"/proj/gone.rs"}]}';
    const { effects } = reduce(s, toolResult(`done\n${receipt}\n`));
    // The deleted path is not among them: the door is a confirm, and a removal
    // is the filesystem frame's to report.
    expect(confirmed(effects)).toEqual(["/proj/a.rs", "/proj/b.rs"]);
  });

  test("an errored Write confirms nothing", () => {
    let s = fresh();
    s = reduce(s, send("k1")).state;
    s = reduce(s, toolUse("Write", { file_path: BRIEF })).state;
    const { effects } = reduce(s, toolResult("permission denied", true));
    expect(confirmed(effects)).toEqual([]);
  });

  test("a replayed Write confirms nothing", () => {
    let s = fresh();
    s = reduce(s, { type: "replay_started" } as CodeSessionEvent).state;
    expect(s.phase).toBe("replaying");
    s = reduce(s, toolUse("Write", { file_path: BRIEF })).state;
    const { effects } = reduce(s, toolResult("ok"));
    expect(confirmed(effects)).toEqual([]);
  });
});
