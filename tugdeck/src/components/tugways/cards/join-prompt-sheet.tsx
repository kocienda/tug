/**
 * join-prompt-sheet — the one decision the join arc asks a person for ([P06]).
 *
 * Everything before this is the machine's: the pilot reconciles a dash the
 * server has derived as joinable ([D147]) with its base without being asked.
 * This is where that work stops and a person decides — and it is deliberately
 * the only place in the arc that asks.
 *
 * **And it is where the join is watched, not only agreed to.** A sheet that
 * dismissed on "Join now" put the decision and its consequence in two
 * different places — the user approved here and the work then narrated on a
 * one-line composer register somewhere else, or on rows that unmount when the
 * dash entry goes. So the sheet holds: it moves from `deciding` to `landing`,
 * renders the join's beats live, and settles naming what happened.
 *
 * The sheet also shows **what would land**, and where those words came from.
 * The landing message's precedence is silent, so the one moment it is worth
 * breaking that silence is here, where a person is about to agree to it.
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
 * Laws: [L02] the *decision* arrives through the caller's own subscription and
 * is passed in as a prop; the *progress* is the landing body's own
 * `useSyncExternalStore` read of `ChangesetJoinStore`, because `showSheet`'s
 * content closure renders once at raise and nothing outside can push a beat
 * into it; [L11] the sheet emits an action and mutates nothing itself; [L19]
 * the authoring guide's hook shape, modelled on `useRewindSheet`; [L31] every
 * answer produces an act or a stated refusal, the latter landing on the
 * register through the store's `_note` path.
 *
 * @tug-pairings QuestionWizard, TugSheet
 *
 * @module components/tugways/cards/join-prompt-sheet
 */

import "./join-prompt-sheet.css";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  QuestionWizard,
  type ParsedQuestion,
} from "@/components/tugways/chrome/session-question-dialog";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import {
  useChangesetJoinLand,
  type LandProgress,
} from "@/lib/changeset-join-store";
import type { DashJoinPromptWire } from "@/lib/changeset-types";
import { BEAT_WORDS } from "@/lib/dash-join-register";

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

/** The message block above the wizard: what would land, and a note if the
 *  words are not the author's (Spec S03). */
export interface JoinPromptMessageBlock {
  /** The subject the join would land with, verbatim. */
  message: string;
  /** Why these are the words, when nobody wrote them. Null for a real draft. */
  note: string | null;
}

/**
 * What the sheet shows above the question ([P05], Spec S03).
 *
 * The landing message's precedence is silent by construction — a forgotten
 * draft lands the branch description, a dash with neither lands `Dash work` —
 * and the whole reason the prompt carries its source is so that silence can be
 * broken at the one moment a person is about to say yes to it. A `draft` shows
 * plainly, because that is the case where the words *are* somebody's.
 *
 * Pure, so the three renderings are a table test rather than a render one. An
 * older sender with no `message` at all yields null, and the sheet renders the
 * question alone rather than an empty quote box.
 */
export function joinPromptMessage(
  prompt: DashJoinPromptWire,
): JoinPromptMessageBlock | null {
  const message = prompt.message ?? "";
  if (message === "") return null;
  switch (prompt.message_source) {
    case "description":
      return {
        message,
        note: "landing with the branch description — no draft was written",
      };
    case "fallback":
      return {
        message,
        note: "no draft or description — this join would land as “Dash work”",
      };
    default:
      return { message, note: null };
  }
}

/** What the landing phase is showing right now (S03). */
export interface JoinLandingView {
  /** `working` while beats arrive; `joined` / `failed` once one is terminal. */
  state: "working" | "joined" | "failed";
  /** The sentence the sheet leads with. */
  line: string;
  /** The outcome's own words, when the terminal beat carried them. */
  detail: string | null;
}

/**
 * The beat a landing join last reported, rendered.
 *
 * Pure, so every beat and both endings are a table test rather than a render
 * one. The beat vocabulary is `BEAT_WORDS`, imported rather than restated: the
 * composer register narrates the same join from the same store, and two tables
 * for one vocabulary drift the moment either gains a beat.
 *
 * A null progress is the gap between the answer going out and the first frame
 * coming back — it reads as work under way, not as an absence, because the
 * work is under way.
 */
export function joinLandingView(
  dash: string,
  progress: LandProgress | null,
): JoinLandingView {
  if (progress === null) return { state: "working", line: `Joining ${dash}`, detail: null };
  if (progress.terminal === true) {
    const ok = progress.status !== "error";
    return {
      state: ok ? "joined" : "failed",
      line: ok ? `Joined ${dash}` : `Join failed — ${dash} is still here`,
      detail: progress.detail ?? null,
    };
  }
  const beat = BEAT_WORDS[progress.beat] ?? progress.beat;
  return { state: "working", line: `Joining ${dash} — ${beat}`, detail: null };
}

/**
 * How long a landed join rests on its own outcome before the sheet closes.
 *
 * A success that dismissed on the terminal frame would be a progress surface
 * that erases its result — the same failure `LandProgress.terminal` exists to
 * prevent one layer down. A failure rests indefinitely instead: it is the one
 * outcome the user has something to do about.
 */
const SETTLED_REST_MS = 1600;

export interface UseJoinPromptSheetArgs {
  /**
   * The decision standing on the bound dash right now, or null. Read by the
   * caller off its own feed subscription ([L02]); an unbound card passes null
   * and this hook does nothing at all.
   */
  prompt: DashJoinPromptWire | null;
  /**
   * The workspace and dash the landing phase reads its beats under.
   *
   * They come from the caller because the prompt does not carry them:
   * `DashJoinPromptWire` names the question, not the dash, and both are
   * already in scope at the one call site.
   */
  workspaceKey: string;
  dashName: string;
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
  workspaceKey,
  dashName,
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
      // Remembered as spent before the close resolves the sheet's promise:
      // the host-dismissal path answers "not-yet" for anything unanswered, and
      // a question that was settled elsewhere is not one this card declined.
      const open = openRequestIdRef.current;
      if (open !== null) answeredRef.current.add(open);
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
    // new one is about. The superseded id is spent for the same reason as
    // above — it was overtaken, not declined.
    const superseded = openRequestIdRef.current;
    if (superseded !== null) answeredRef.current.add(superseded);
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
            workspaceKey={workspaceKey}
            dash={dashName}
            onAnswer={(choice) => {
              answer(requestId, choice);
              // "Join now" is where the sheet stops being a question and
              // becomes the surface the work plays on. The other two are
              // decisions with nothing left to watch.
              if (choice !== "join-now") close();
            }}
            onClose={close}
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
      // And a dismissal is an answer: "not yet", the same one ⎋ and "Chat
      // about this" give. Closing the host's way used to be the one route out
      // of this sheet that decided nothing, which left the ask standing to be
      // raised again on the next recompute.
      if (!answeredRef.current.has(requestId)) answer(requestId, "not-yet");
    });
  }, [prompt, requestId, workspaceKey, dashName, landingActive, showSheet, answer]);
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
  workspaceKey,
  dash,
  onAnswer,
  onClose,
}: {
  prompt: DashJoinPromptWire;
  workspaceKey: string;
  dash: string;
  onAnswer: (answer: JoinPromptAnswer) => void;
  onClose: () => void;
}): React.ReactElement {
  // Which half of the conversation this mount is in. Local `useState` and
  // deliberately so: nothing outside this sheet has any use for the fact that
  // this one is watching rather than asking ([L22]).
  const [phase, setPhase] = useState<"deciding" | "landing">("deciding");
  if (phase === "landing") {
    return <JoinLandingBody workspaceKey={workspaceKey} dash={dash} onClose={onClose} />;
  }
  const questions = joinPromptAsParsed(prompt);
  const landing = joinPromptMessage(prompt);
  return (
    <div className="join-prompt-sheet" data-slot="join-prompt-sheet">
      {landing !== null ? (
        <div
          className="join-prompt-sheet-message"
          data-slot="join-prompt-sheet-message"
          data-source={prompt.message_source ?? ""}
        >
          <TugSectionLabel
            label={{ name: "lands as" }}
            slot="join-prompt-sheet-message-label"
          />
          <div className="join-prompt-sheet-message-body">{landing.message}</div>
          {landing.note !== null ? (
            <div className="join-prompt-sheet-message-note">{landing.note}</div>
          ) : null}
        </div>
      ) : null}
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
          if (choice === "join-now") setPhase("landing");
        }}
        onDecline={() => onAnswer("not-yet")}
        onCancel={() => onAnswer("not-yet")}
      />
    </div>
  );
}

/**
 * The sheet after the decision — the join, narrated where it was agreed to.
 *
 * This is the one place in the file that reads a store, and it has to: the
 * content closure `showSheet` renders is rendered **once**, at raise, so a
 * beat cannot reach this body as a prop. It subscribes instead ([L02]), to
 * the same `ChangesetJoinStore` the composer register reads.
 *
 * It also owns the `close` it was handed rather than the hook's `closeRef`,
 * which `answer()` nulled on the way in — so the sheet's fact clearing (which
 * happens on the very next recompute, since answering "join now" clears the
 * prompt) has already released its claim and will not reclaim this mount.
 */
function JoinLandingBody({
  workspaceKey,
  dash,
  onClose,
}: {
  workspaceKey: string;
  dash: string;
  onClose: () => void;
}): React.ReactElement {
  const progress = useChangesetJoinLand(workspaceKey, dash);
  const view = joinLandingView(dash, progress);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // Only a landed join closes itself. A failure is the outcome the user has
    // something to do about, so it rests until they dismiss it.
    if (view.state !== "joined") return;
    const timer = setTimeout(() => closeRef.current(), SETTLED_REST_MS);
    return () => clearTimeout(timer);
  }, [view.state]);

  return (
    <div
      className="join-prompt-sheet join-prompt-sheet-landing"
      data-slot="join-prompt-sheet-landing"
      data-state={view.state}
    >
      <div className="join-prompt-sheet-landing-line" data-slot="join-prompt-sheet-landing-line">
        {view.line}
      </div>
      {view.detail !== null ? (
        <div
          className="join-prompt-sheet-landing-detail"
          data-slot="join-prompt-sheet-landing-detail"
        >
          {view.detail}
        </div>
      ) : null}
    </div>
  );
}
