/**
 * An arc's question as the question dialog asks it: the one question built
 * from a receipt's own text, old and new, and the live read that says whether
 * the dialog — and the composer — is still waiting on an answer.
 */

import { describe, expect, test } from "bun:test";

import {
  ARC_ASK_STOP_WORD,
  arcAskAnswer,
  arcAskEvidence,
  arcAskIsLive,
  arcAskQuestion,
  arcAskRoute,
  arcAwaitingReply,
  type ArcAskRouteFacts,
} from "../arc-ask-question";
import type { ArcSessionFact } from "../arc-session-index";
import { parseArcReceipt } from "../arc-receipt";

const HEAD =
  "arc stopped · demo · in implement — it met a decision that is yours to make, so it stopped rather than asking";

function stopOf(lines: string[]) {
  const stop = parseArcReceipt([HEAD, ...lines].join("\n"))?.stop;
  if (stop === null || stop === undefined) throw new Error("not a stop");
  return stop;
}

/** The fields of a fact these reads look at; the rest are never consulted. */
function fact(name: string, arc: { stopped?: string; done?: boolean } | null): ArcSessionFact {
  return { name, arc } as unknown as ArcSessionFact;
}

describe("the question a receipt asks", () => {
  test("a new receipt's choices carry what they do, the recommended one first", () => {
    const stop = stopOf([
      "Which cover hides the band?",
      "choice · the neighbour",
      "does · widens the neighbour over the band",
      "choice · a new one",
      "does · adds a cover of its own",
      "recommended · a new one",
    ]);
    expect(arcAskQuestion(stop)).toEqual({
      question: "Which cover hides the band?",
      multiSelect: false,
      options: [
        { label: "a new one", description: "Recommended — adds a cover of its own" },
        { label: "the neighbour", description: "widens the neighbour over the band" },
      ],
    });
  });

  test("a receipt written with labels alone draws the same question with what it has", () => {
    const stop = stopOf(["Which cover hides the band?", "choice · the neighbour", "choice · a new one"]);
    expect(arcAskQuestion(stop)).toEqual({
      question: "Which cover hides the band?",
      multiSelect: false,
      options: [{ label: "the neighbour" }, { label: "a new one" }],
    });
  });

  test("an ask with no question to put has no question", () => {
    expect(arcAskQuestion(stopOf([]))).toBeNull();
  });

  test("what was verified stays apart from what is guessed", () => {
    const stop = stopOf([
      "Which cover?",
      "found · the neighbour reaches the band",
      "guessed · the flash is the band",
      "tried · widening the neighbour",
    ]);
    expect(arcAskEvidence(stop)).toEqual([
      { kind: "found", text: "the neighbour reaches the band" },
      { kind: "guessed", text: "the flash is the band" },
      { kind: "tried", text: "widening the neighbour" },
    ]);
    expect(arcAskEvidence(stopOf(["Which cover?"]))).toEqual([]);
  });

  test("a chosen option or a typed reply is the answer the submit carries", () => {
    const question = arcAskQuestion(stopOf(["Which cover?", "choice · this"]))!;
    expect(arcAskAnswer({ "Which cover?": " this " }, question)).toBe("this");
    expect(arcAskAnswer({ "Which cover?": "something else entirely" }, question)).toBe(
      "something else entirely",
    );
    expect(arcAskAnswer({}, question)).toBeNull();
  });
});

describe("whether the question is still up", () => {
  test("only while the live arc is stopped on its question", () => {
    expect(arcAskIsLive(fact("demo", { stopped: ARC_ASK_STOP_WORD }), "demo")).toBe(true);
    // Answered: the resume's rotation cleared the stop.
    expect(arcAskIsLive(fact("demo", {}), "demo")).toBe(false);
    // Stopped for some other reason.
    expect(arcAskIsLive(fact("demo", { stopped: "lint" }), "demo")).toBe(false);
    // Over.
    expect(arcAskIsLive(fact("demo", { stopped: ARC_ASK_STOP_WORD, done: true }), "demo")).toBe(false);
    // Another arc, or no run, or no feed yet.
    expect(arcAskIsLive(fact("other", { stopped: ARC_ASK_STOP_WORD }), "demo")).toBe(false);
    expect(arcAskIsLive(fact("demo", null), "demo")).toBe(false);
    expect(arcAskIsLive(null, "demo")).toBe(false);
  });

  test("the composer answers the card's own arc, and only while it asks", () => {
    expect(arcAwaitingReply(fact("demo", { stopped: ARC_ASK_STOP_WORD }))).toBe("demo");
    expect(arcAwaitingReply(fact("demo", {}))).toBeNull();
    expect(arcAwaitingReply(null)).toBeNull();
  });
});

describe("the line toward the join", () => {
  const done = { title: "a step", status: "done" };
  const open = { title: "a step", status: "pending" };
  const facts = (over: Partial<ArcAskRouteFacts>): ArcAskRouteFacts => ({
    stage: "working",
    arc: { stage: "audit", stopped: ARC_ASK_STOP_WORD, stopped_stage: "audit" },
    steps: [done, done],
    redChecks: [],
    ...over,
  });

  test("an ask in the audit over a red names the red, then the mark, then the join", () => {
    expect(arcAskRoute(facts({ redChecks: ["just ci"] }))).toBe("1 red check · then mark · then join");
    expect(arcAskRoute(facts({ redChecks: ["just ci", "just lint"] }))).toBe(
      "2 red checks · then mark · then join",
    );
  });

  test("an ask mid-walk counts the steps left, then the audit, then the join", () => {
    const route = arcAskRoute(
      facts({
        arc: { stage: "implement", stopped: ARC_ASK_STOP_WORD, stopped_stage: "implement" },
        steps: [done, { title: "s", status: "in progress" }, open, { title: "w", status: "withdrawn" }],
      }),
    );
    expect(route).toBe("2 steps left · then audit · then join");
  });

  test("an ask before the plan owes the plan and its steps first", () => {
    const route = arcAskRoute(
      facts({
        stage: null,
        arc: { stage: "devise", stopped: ARC_ASK_STOP_WORD, stopped_stage: "devise" },
        steps: [],
      }),
    );
    expect(route).toBe("the plan · then its steps · then audit · then join");
  });

  test("an arc whose audit stands owes only the join", () => {
    expect(arcAskRoute(facts({ stage: "audited" }))).toBe("join");
  });
});
