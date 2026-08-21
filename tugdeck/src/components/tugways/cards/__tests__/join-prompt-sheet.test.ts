/**
 * The join prompt's two pure halves: how the server's fact becomes a question,
 * and how a chosen label becomes an answer.
 *
 * The second is the one worth pinning. The labels are composed server-side so
 * the durable fact and the rendered one are the same bytes — which means a copy
 * edit to an option's wording lives in a Rust file, far from anything that
 * would make somebody check this. Matching positionally rather than by string
 * is what keeps that edit from silently turning "Join now" into an answer
 * nothing recognizes.
 */

import { describe, test, expect } from "bun:test";

import {
  answerForLabel,
  joinPromptAsParsed,
  joinPromptMessage,
} from "@/components/tugways/cards/join-prompt-sheet";
import type { DashJoinPromptWire } from "@/lib/changeset-types";

const PROMPT: DashJoinPromptWire = {
  request_id: "imposer2:base0:head0:clean",
  decision: "clean",
  base_sha: "base0",
  dash_head: "head0",
  question: "imposer2 is ready, reconciled with main, and the joined tree builds — join it?",
  message: "tugdash(imposer2): Teach the imposer to breathe",
  message_source: "draft",
  options: [
    { label: "Join now", description: "Squash the dash into its base." },
    { label: "Review first", description: "Open the message without landing." },
    { label: "Not yet", description: "Leave it where it is." },
  ],
};

describe("the fact, as a question", () => {
  test("one single-select question, carrying the server's own words", () => {
    const [q, ...rest] = joinPromptAsParsed(PROMPT);
    expect(rest).toEqual([]);
    expect(q?.question).toBe(PROMPT.question);
    expect(q?.multiSelect).toBe(false);
    expect(q?.options.map((o) => o.label)).toEqual(["Join now", "Review first", "Not yet"]);
    expect(q?.options[0]?.description).toBe("Squash the dash into its base.");
  });

  test("an option with no description carries none rather than an empty one", () => {
    const [q] = joinPromptAsParsed({
      ...PROMPT,
      options: [{ label: "Join now" }, { label: "Review first" }, { label: "Not yet" }],
    });
    expect(q?.options[0]).toEqual({ label: "Join now" });
  });
});

describe("the label, as an answer", () => {
  test("each of the three maps to its own wire answer", () => {
    expect(answerForLabel(PROMPT, "Join now")).toBe("join-now");
    expect(answerForLabel(PROMPT, "Review first")).toBe("review-first");
    expect(answerForLabel(PROMPT, "Not yet")).toBe("not-yet");
  });

  test("rewording an option does not change what it answers", () => {
    // The mapping is positional, so the server may reword freely. A
    // string-matched table would have turned this into an unrecognized label,
    // and an unrecognized label is a press that lands nothing.
    const reworded: DashJoinPromptWire = {
      ...PROMPT,
      options: [
        { label: "Land it" },
        { label: "Read it first" },
        { label: "Later" },
      ],
    };
    expect(answerForLabel(reworded, "Land it")).toBe("join-now");
    expect(answerForLabel(reworded, "Later")).toBe("not-yet");
  });

  test("a label the prompt never offered answers nothing", () => {
    // Refused rather than defaulted: a default here would consume an ask
    // nobody answered, and the re-ask policy would then hold its tongue about
    // a decision the user never made.
    expect(answerForLabel(PROMPT, "Something else")).toBeNull();
  });
});

describe("the message, as a quote and a provenance", () => {
  test("a draft shows plainly — the words are somebody's", () => {
    expect(joinPromptMessage(PROMPT)).toEqual({
      message: "tugdash(imposer2): Teach the imposer to breathe",
      note: null,
    });
  });

  test("a description says it is standing in for a draft nobody wrote", () => {
    const block = joinPromptMessage({ ...PROMPT, message_source: "description" });
    expect(block?.message).toBe("tugdash(imposer2): Teach the imposer to breathe");
    expect(block?.note).toBe("landing with the branch description — no draft was written");
  });

  test("a fallback names what would actually land", () => {
    // The case worth breaking the silence for: agreeing to this join lands the
    // words "Dash work" on the base, and the only moment anyone can catch that
    // is the moment they are asked.
    const block = joinPromptMessage({
      ...PROMPT,
      message: "tugdash(imposer2): Dash work",
      message_source: "fallback",
    });
    expect(block?.note).toBe(
      "no draft or description — this join would land as “Dash work”",
    );
  });

  test("a sender with no message renders no block at all", () => {
    // An older tugcast, or one mid-upgrade. The question still stands on its
    // own; an empty quote box would not.
    const { message: _message, message_source: _source, ...bare } = PROMPT;
    expect(joinPromptMessage(bare)).toBeNull();
  });
});
