/**
 * arc-ask-question.ts — an arc's question, as the app's question dialog asks it.
 *
 * A stage that meets a decision stops its arc and leaves the question on the
 * stop receipt. The receipt hosts the same `QuestionWizard` every other
 * question in the app is drawn by, with one question built from the receipt's
 * own text: each choice the stage offered is an option, what it does is the
 * option's description, and the one it recommends is offered first and
 * preselected, the convention every question in the app follows. A receipt
 * written before descriptions and recommendations existed draws the same
 * dialog with its labels alone.
 *
 * The question is pending while the arc still reads `needs a decision` in the
 * live model. That is read beside the receipt, never into it: the receipt's
 * text stays the frozen record of what was asked, and what changes is only
 * whether the dialog over it is still waiting on an answer.
 *
 * Pure: the receipt block and the composer read these, and the deck's tests
 * are `bun:test` with no fake DOM.
 *
 * @module lib/arc-ask-question
 */

import type { ParsedQuestion } from "@/components/tugways/chrome/session-question-dialog";

import { JOINABLE_STAGES } from "./arc-join-register";
import type { ArcSessionFact } from "./arc-session-index";
import type { ParsedArcReceipt } from "./arc-receipt";

/** The stop word a stage's ask leaves on the live arc. */
export const ARC_ASK_STOP_WORD = "needs a decision";

/** How a recommended option's description begins. */
export const ARC_ASK_RECOMMENDED = "Recommended";

/**
 * The one question an ask receipt puts to the user, or `null` for a receipt
 * that is not an ask or whose question did not land.
 *
 * The recommended option moves to the front, because the dialog preselects
 * its first option and a preselected guess that is not the stage's own would
 * put words in its mouth. Every other option keeps the order the stage gave.
 */
export function arcAskQuestion(
  stop: NonNullable<ParsedArcReceipt["stop"]>,
): ParsedQuestion | null {
  if (stop.said === null) return null;
  const options = stop.options.map((option) => {
    const parts: string[] = [];
    if (option.recommended) parts.push(ARC_ASK_RECOMMENDED);
    if (option.does !== null) parts.push(option.does);
    const description = parts.join(" — ");
    return description === ""
      ? { label: option.label }
      : { label: option.label, description };
  });
  const first = stop.options.findIndex((option) => option.recommended);
  const ordered =
    first <= 0 ? options : [options[first]!, ...options.slice(0, first), ...options.slice(first + 1)];
  return { question: stop.said, multiSelect: false, options: ordered };
}

/**
 * The lines a receipt shows over its dialog, saying what the stage found,
 * what it guesses and what it tried — kept apart so the user never chooses on
 * a guess presented as a fact. Empty for a receipt that carries none.
 */
export function arcAskEvidence(
  stop: NonNullable<ParsedArcReceipt["stop"]>,
): { kind: "found" | "guessed" | "tried"; text: string }[] {
  return [
    ...stop.found.map((text) => ({ kind: "found" as const, text })),
    ...stop.guessed.map((text) => ({ kind: "guessed" as const, text })),
    ...(stop.tried === null ? [] : [{ kind: "tried" as const, text: stop.tried }]),
  ];
}

/** The words an evidence line is introduced by. */
export function arcAskEvidenceLead(kind: "found" | "guessed" | "tried"): string {
  switch (kind) {
    case "found":
      return "Verified";
    case "guessed":
      return "Guessed";
    case "tried":
      return "Tried";
  }
}

/**
 * Whether `arc` is still stopped on its question in the live model — the
 * fact the dialog's pending reads, and the one the composer reads to know a
 * typed message is the answer. A fact about another arc, a finished arc, and
 * an arc that has moved on are all `false`.
 */
export function arcAskIsLive(fact: ArcSessionFact | null, arc: string): boolean {
  return (
    fact !== null &&
    fact.name === arc &&
    fact.arc !== null &&
    fact.arc.done !== true &&
    fact.arc.stopped === ARC_ASK_STOP_WORD
  );
}

/**
 * The arc a card's composer is answering, or `null` when no question is up:
 * the card's arc, when it is stopped on its question.
 */
export function arcAwaitingReply(fact: ArcSessionFact | null): string | null {
  return fact !== null && arcAskIsLive(fact, fact.name) ? fact.name : null;
}

/** The facts the line toward the join is read from — a slice of the live fact. */
export type ArcAskRouteFacts = Pick<ArcSessionFact, "stage" | "arc" | "steps" | "redChecks">;

/**
 * What stands between an asked arc and its join, in one line — `1 red check ·
 * then mark · then join` — so each answer reads as a step toward an arc the
 * user can land ([B10]).
 *
 * Derived from the arc's live state, in the order the work goes: the checks
 * the last verify left red at the head, the steps still open on the ledger,
 * the plan when the arc stopped before it had one, then the audit — or its
 * mark, when the arc stopped inside the audit — and the join last. An arc
 * whose audit already stands owes only the join. Pure.
 */
export function arcAskRoute(facts: ArcAskRouteFacts): string {
  const items: string[] = [];
  const red = facts.redChecks.length;
  if (red > 0) items.push(`${red} red ${red === 1 ? "check" : "checks"}`);
  const open = facts.steps.filter(
    (step) => step.status !== "done" && step.status !== "withdrawn",
  ).length;
  if (open > 0) items.push(`${open} ${open === 1 ? "step" : "steps"} left`);
  const stoppedIn = facts.arc?.stopped_stage ?? facts.arc?.stage ?? null;
  if (facts.steps.length === 0 && (stoppedIn === "devise" || stoppedIn === "review")) {
    items.push("the plan", "its steps");
  }
  if (!JOINABLE_STAGES.has(facts.stage ?? "")) {
    items.push(stoppedIn === "audit" ? "mark" : "audit");
  }
  items.push("join");
  return items.map((item, index) => (index === 0 ? item : `then ${item}`)).join(" · ");
}

/** The answer the dialog's submit carries for `question`, trimmed. */
export function arcAskAnswer(
  answers: Record<string, string>,
  question: ParsedQuestion,
): string | null {
  const answer = (answers[question.question] ?? "").trim();
  return answer === "" ? null : answer;
}
