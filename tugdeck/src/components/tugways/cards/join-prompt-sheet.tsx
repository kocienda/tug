/**
 * join-prompt-sheet — the one decision the join arc asks a person for ([P06]).
 *
 * Everything before this is the machine's: the pilot reconciles a `built` dash
 * with its base without being asked, builds the joined tree, and runs the
 * project's own checks over it. This is where that work stops and a person
 * decides — and it is deliberately the only place in the arc that asks.
 *
 * **Modal, because the whole point is that it is not missed.** A passive line
 * on a shade is exactly the "come find it later" this arc replaces: the dash
 * would sit built and reconciled for days with nobody knowing it was ready.
 * So the decision is summoned, once, on the card of a session bound to that
 * dash — and an unbound dash raises nothing, because a modal on a card that is
 * not *about* that dash is an interruption with no context. The Lens row and
 * `/join <name>` stay its paths.
 *
 * Three things govern *when*, and each of them is a defect if it is missing:
 *
 * - **Answered ids are remembered.** The fact is durable and re-derived on
 *   every recompute, so it lingers for one beat after an answer. Without the
 *   memory the sheet re-raises itself on the recompute that follows its own
 *   dismissal.
 * - **A landing already in progress holds it.** A modal over a half-typed
 *   commit message is the interruption this design was supposed to delete. A
 *   running *turn* is not a reason to hold: the decision is about a dash, not
 *   about Claude, and a turn can run for minutes.
 * - **The fact clearing closes it.** Two cards bound to one dash both raise
 *   the sheet; the first answer clears the fact, and the other's sheet has to
 *   go with it rather than sit there offering an answer to a settled question.
 *
 * Laws: [L02] the fact arrives through the caller's own store subscription and
 * is passed in — this file reads no store; [L11] the sheet emits an action and
 * mutates nothing itself; [L19] the authoring guide's hook shape, modelled on
 * `useRewindSheet`; [L31] every answer produces an act or a stated refusal,
 * the latter landing on the register through the store's `_note` path.
 *
 * @tug-pairings QuestionWizard, TugSheet
 *
 * @module components/tugways/cards/join-prompt-sheet
 */

import "./join-prompt-sheet.css";

import React, { useCallback, useLayoutEffect, useRef } from "react";

import {
  QuestionWizard,
  type ParsedQuestion,
} from "@/components/tugways/chrome/session-question-dialog";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import type { DashJoinPromptWire } from "@/lib/changeset-types";

/** How the user answered, in the wire's own words (Spec S05). */
export type JoinPromptAnswer = "join-now" | "review-first" | "not-yet";

/**
 * The prompt's options, as the wizard reads them.
 *
 * The labels are the server's, verbatim — the durable fact and the rendered
 * one are the same bytes, which is what lets {@link answerForLabel} map a
 * chosen label back to its answer without a second table to drift against.
 */
export function joinPromptAsParsed(prompt: DashJoinPromptWire): ParsedQuestion[] {
  return [
    {
      question: prompt.question,
      multiSelect: false,
      options: prompt.options.map((option) => ({
        label: option.label,
        ...(option.description !== undefined && option.description !== ""
          ? { description: option.description }
          : {}),
      })),
    },
  ];
}

/**
 * Which answer a chosen label is.
 *
 * Positional against the server's own ordering rather than string-matched, so
 * rewording an option's label — a copy edit, in a file nobody would think to
 * check — cannot silently turn "Join now" into an unrecognized answer that
 * lands nothing. An index outside the three is refused with `null` rather than
 * defaulted, because a default here would consume an ask nobody answered.
 */
export function answerForLabel(
  prompt: DashJoinPromptWire,
  label: string,
): JoinPromptAnswer | null {
  const index = prompt.options.findIndex((option) => option.label === label);
  const order: JoinPromptAnswer[] = ["join-now", "review-first", "not-yet"];
  return order[index] ?? null;
}

export interface UseJoinPromptSheetArgs {
  /**
   * The decision standing on the bound dash right now, or null. Read by the
   * caller off its own feed subscription ([L02]); an unbound card passes null
   * and this hook does nothing at all.
   */
  prompt: DashJoinPromptWire | null;
  /**
   * Whether this card's composer is already in a landing mode. The sheet
   * yields to one and raises when it exits.
   */
  landingActive: boolean;
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
  /** Send the answer. The caller owns the transport ([L11]). */
  onAnswer: (requestId: string, answer: JoinPromptAnswer) => void;
  /**
   * Enter join mode on this dash — the `review-first` path, through the same
   * landing-mode entry `/dash-join` uses, so the message the run maintained is
   * what the composer opens on.
   */
  onReviewFirst: () => void;
}

/**
 * Raise the decision when there is one, and only then.
 *
 * Returns nothing: the sheet is not something a caller opens, it is something
 * the feed causes. Every gate that decides whether it appears is here rather
 * than at the call site, so a second host cannot get one of them wrong.
 */
export function useJoinPromptSheet({
  prompt,
  landingActive,
  showSheet,
  onAnswer,
  onReviewFirst,
}: UseJoinPromptSheetArgs): void {
  // Per card, never durable and never a store: which asks this card has
  // already answered is a fact about this mount's conversation with the user,
  // and nothing outside it has any use for the answer ([L22]).
  const answeredRef = useRef<Set<string>>(new Set());
  const openRequestIdRef = useRef<string | null>(null);
  const closeRef = useRef<(() => void) | null>(null);

  // Read through refs so the effect below can stay keyed on the request id
  // alone: re-running it because a callback identity moved would tear the open
  // sheet down and put an identical one up, losing whatever the user had
  // selected in it.
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;
  const onReviewFirstRef = useRef(onReviewFirst);
  onReviewFirstRef.current = onReviewFirst;

  const answer = useCallback((requestId: string, choice: JoinPromptAnswer) => {
    answeredRef.current.add(requestId);
    openRequestIdRef.current = null;
    closeRef.current = null;
    onAnswerRef.current(requestId, choice);
    if (choice === "review-first") onReviewFirstRef.current();
  }, []);

  const requestId = prompt?.request_id ?? null;

  useLayoutEffect(() => {
    // The fact is gone — answered here, answered on another card, or overtaken
    // by a base move. Either way the sheet is offering an answer to a question
    // that no longer exists.
    if (prompt === null || requestId === null) {
      const close = closeRef.current;
      closeRef.current = null;
      openRequestIdRef.current = null;
      close?.();
      return;
    }
    if (answeredRef.current.has(requestId)) return;
    if (landingActive) return;
    if (openRequestIdRef.current === requestId) return;

    // A different decision than the one on screen supersedes it rather than
    // stacking on it: the tree the old question was about is not the tree the
    // new one is about.
    closeRef.current?.();
    openRequestIdRef.current = requestId;
    void showSheet({
      title: "Join?",
      icon: "GitMerge",
      content: (close) => {
        closeRef.current = () => close();
        return (
          <JoinPromptSheetBody
            prompt={prompt}
            onAnswer={(choice) => {
              answer(requestId, choice);
              close();
            }}
          />
        );
      },
    }).then(() => {
      // The host dismissed it — a click outside, the X, ⎋ routed by the sheet
      // itself. Whatever the route, the sheet is down and the ref must not
      // keep claiming it is up, or the next recompute will decline to re-raise
      // a question nobody answered.
      if (openRequestIdRef.current === requestId) openRequestIdRef.current = null;
      closeRef.current = null;
    });
  }, [prompt, requestId, landingActive, showSheet, answer]);
}

/**
 * The sheet's body — the question, its three answers, and nothing else.
 *
 * `isPending` is hard `true`: the host unmounts the whole sheet when the fact
 * clears, so a wizard rendering `null` under a still-open panel would be an
 * empty box where a question was.
 *
 * ⎋ and `Chat about this` both answer **"Not yet"** rather than closing
 * quietly. A dismissal *is* a decision — it is the one the re-ask policy
 * records ([P07]) — and a silent close would leave the ask standing to be
 * raised again on the very next recompute, which is the reflex-dismissal
 * failure this whole design is arranged around.
 */
function JoinPromptSheetBody({
  prompt,
  onAnswer,
}: {
  prompt: DashJoinPromptWire;
  onAnswer: (answer: JoinPromptAnswer) => void;
}): React.ReactElement {
  const questions = joinPromptAsParsed(prompt);
  return (
    <div className="join-prompt-sheet" data-slot="join-prompt-sheet">
      <QuestionWizard
        requestId={prompt.request_id}
        questions={questions}
        isPending
        onSubmit={(answers) => {
          const label = answers[prompt.question];
          if (typeof label !== "string" || label === "") return;
          const choice = answerForLabel(prompt, label);
          if (choice === null) return;
          onAnswer(choice);
        }}
        onDecline={() => onAnswer("not-yet")}
        onCancel={() => onAnswer("not-yet")}
      />
    </div>
  );
}
