/**
 * join-prompt-inline — the one decision the join arc asks a person for ([P06]).
 *
 * Everything before this is the machine's: the pilot reconciles a dash the
 * server has derived as joinable ([D147]) with its base without being asked.
 * This is where that work stops and a person decides — and it is deliberately
 * the only place in the arc that asks.
 *
 * **It mounts inline, at the transcript's live edge.** The ask arrives where
 * the user is already reading, directly above the composer, and the run's own
 * ending narration stays right there above it — readable, selectable,
 * scrollable. That narration is the context the decision is *about*, and a
 * pane-modal sheet greyed it out at the exact moment it mattered. Inline gives
 * up nothing the modal was for: the ask is still summoned rather than
 * discovered, still raised by the fact, still on the card of a session bound to
 * that dash and nowhere else. What it gives up is the blocking.
 *
 * **And it is where the join is watched, not only agreed to.** A surface that
 * vanished on "Join now" would put the decision and its consequence in two
 * different places. So this one holds: it morphs from `deciding` to `landing`
 * on the same element, renders the join's beats live, and settles naming what
 * happened. There is no header to go stale — which is what made the sheet keep
 * asking "Join?" while the join it had already agreed to was executing.
 *
 * It also shows **what would land**, and where those words came from. The
 * landing message's precedence is silent, so the one moment worth breaking
 * that silence is here, where a person is about to agree to it. The message
 * renders from props on every recompute, so a draft written while the ask
 * stands repaints it in place.
 *
 * Three things govern *when*, and each of them is a defect if it is missing:
 *
 * - **Answered ids are remembered.** The fact is durable and re-derived on
 *   every recompute, so it lingers for one beat after an answer. Without the
 *   memory the ask returns on the recompute that follows its own dismissal.
 * - **A landing already in progress holds it.** An ask over a half-typed
 *   commit message is the interruption this design was supposed to delete. A
 *   running *turn* is not a reason to hold: the decision is about a dash, not
 *   about Claude, and a turn can run for minutes.
 * - **The fact clearing closes it.** Two cards bound to one dash both raise
 *   the ask; the first answer clears the fact, and the other's surface has to
 *   go with it rather than sit there offering an answer to a settled question.
 *
 * The surface is per-mount. A reload or card remount during a landing does not
 * restore the landing body — the feed's truth carries the outcome (the
 * `/dash-join` receipt row on completion, the register's failure word on
 * error), which is the recovery contract the sheet had before it.
 *
 * Laws: [L02] the *decision* arrives through the caller's own subscription and
 * is passed in as a prop; the *progress* is the landing body's own
 * `useSyncExternalStore` read of `ChangesetJoinStore`; [L11] this surface emits
 * an action and mutates nothing itself; [L22] which half of the conversation a
 * mount is in, and its settled rest, are local; [L31] every answer produces an
 * act or a stated refusal, the latter landing on the register through the
 * store's `_note` path.
 *
 * @tug-pairings QuestionWizard
 *
 * @module components/tugways/cards/join-prompt-inline
 */

import "./join-prompt-inline.css";

import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  QuestionWizard,
  type ParsedQuestion,
} from "@/components/tugways/chrome/session-question-dialog";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import {
  useChangesetJoinLand,
  type LandProgress,
} from "@/lib/changeset-join-store";
import type { DashJoinPromptWire } from "@/lib/changeset-types";
import { BEAT_WORDS, SETTLED_REST_MS } from "@/lib/dash-join-register";

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
 * What the surface shows above the question ([P05], Spec S03).
 *
 * The landing message's precedence is silent by construction — a forgotten
 * draft lands the branch description, a dash with neither lands `Dash work` —
 * and the whole reason the prompt carries its source is so that silence can be
 * broken at the one moment a person is about to say yes to it. A `draft` shows
 * plainly, because that is the case where the words *are* somebody's.
 *
 * Pure, so the three renderings are a table test rather than a render one. An
 * older sender with no `message` at all yields null, and the surface renders
 * the question alone rather than an empty quote box.
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
  /** The sentence the surface leads with. */
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

export interface UseJoinPromptArgs {
  /**
   * The decision standing on the bound dash right now, or null. Read by the
   * caller off its own feed subscription ([L02]); an unbound card passes null
   * and this hook returns nothing to render.
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
   * Whether this card's composer is already in a landing mode. The ask yields
   * to one and appears when it exits.
   */
  landingActive: boolean;
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
 * The element to render at the transcript's live edge, or null.
 *
 * Returns rather than raises: the ask is not something a caller opens, it is
 * something the feed causes, and every gate that decides whether it appears is
 * here rather than at the call site so a second host cannot get one of them
 * wrong. The caller's only job is to put what comes back into the slot.
 */
export function useJoinPrompt({
  prompt,
  workspaceKey,
  dashName,
  landingActive,
  onAnswer,
  onReviewFirst,
}: UseJoinPromptArgs): React.ReactElement | null {
  // Per card, never durable and never a store: which asks this card has
  // already answered is a fact about this mount's conversation with the user,
  // and nothing outside it has any use for the answer ([L22]).
  const answeredRef = useRef<Set<string>>(new Set());
  // The join being watched, set on "Join now" — the one answer that leaves
  // something to watch — and cleared when the surface departs.
  //
  // It carries the **dash name**, rather than reading the live prop, because a
  // landing outlives its dash: the moment the join lands, the dash's feed
  // entry is gone and the card's `dashName` empties. A body reading the live
  // value would lose the store key it was watching at the exact moment the
  // outcome arrived, fall back to "no progress yet", and sit there narrating
  // `Joining ` forever — never settling, so never departing.
  const [landing, setLanding] = useState<{ id: string; dash: string } | null>(null);

  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;
  const onReviewFirstRef = useRef(onReviewFirst);
  onReviewFirstRef.current = onReviewFirst;

  const requestId = prompt?.request_id ?? null;

  // The dash a press is about, read through a ref so `answer` can stay
  // identity-stable while still capturing the name current at the press.
  const dashNameRef = useRef(dashName);
  dashNameRef.current = dashName;

  const answer = useCallback(
    (id: string, choice: JoinPromptAnswer) => {
      answeredRef.current.add(id);
      onAnswerRef.current(id, choice);
      if (choice === "review-first") onReviewFirstRef.current();
      // "Join now" is where the ask stops being a question and becomes the
      // surface the work plays on. The other two decide and are done.
      setLanding(choice === "join-now" ? { id, dash: dashNameRef.current } : null);
    },
    [],
  );

  const departLanding = useCallback(() => setLanding(null), []);

  // A landing outlives the fact it came from — answering clears the prompt on
  // the very next recompute — so it is checked first and holds the surface.
  if (landing !== null) {
    return (
      <JoinPromptInline
        key={landing.id}
        phase="landing"
        prompt={null}
        workspaceKey={workspaceKey}
        dash={landing.dash}
        onAnswer={() => {}}
        onDepart={departLanding}
      />
    );
  }

  // No fact, already answered here, or this card is landing something else.
  if (prompt === null || requestId === null) return null;
  if (answeredRef.current.has(requestId)) return null;
  if (landingActive) return null;

  return (
    <JoinPromptInline
      key={requestId}
      phase="deciding"
      prompt={prompt}
      workspaceKey={workspaceKey}
      dash={dashName}
      onAnswer={(choice) => answer(requestId, choice)}
      onDepart={departLanding}
    />
  );
}

/**
 * The surface itself — one element across both halves of the conversation.
 *
 * `isPending` is hard `true` on the wizard: this surface unmounts outright
 * when the fact clears, so a wizard rendering `null` under a still-mounted
 * frame would be an empty box where a question was.
 *
 * ⎋ and `Chat about this` both answer **"Not yet"** rather than closing
 * quietly. A dismissal *is* a decision — it is the one the re-ask policy
 * records ([P07]) — and a silent close would leave the ask standing to be
 * raised again on the very next recompute, which is the reflex-dismissal
 * failure this whole design is arranged around.
 */
export function JoinPromptInline({
  phase,
  prompt,
  workspaceKey,
  dash,
  onAnswer,
  onDepart,
}: {
  phase: "deciding" | "landing";
  prompt: DashJoinPromptWire | null;
  workspaceKey: string;
  dash: string;
  onAnswer: (answer: JoinPromptAnswer) => void;
  onDepart: () => void;
}): React.ReactElement | null {
  // One wrapper across both halves, so the morph is a body swap inside a box
  // that never moves — the same continuity `AskUserQuestionToolBlock` keeps
  // across ask → answered ([D13]).
  if (phase === "landing") {
    return <JoinLandingBody workspaceKey={workspaceKey} dash={dash} onDepart={onDepart} />;
  }
  if (prompt === null) return null;
  const questions = joinPromptAsParsed(prompt);
  const landing = joinPromptMessage(prompt);
  return (
    <div
      className="join-prompt-inline"
      data-slot="join-prompt-inline"
      data-phase="deciding"
      data-state="deciding"
    >
      {landing !== null ? (
        <div
          className="join-prompt-inline-message"
          data-slot="join-prompt-inline-message"
          data-source={prompt.message_source ?? ""}
        >
          <TugSectionLabel
            label={{ name: "lands as" }}
            slot="join-prompt-inline-message-label"
          />
          <div className="join-prompt-inline-message-body">{landing.message}</div>
          {landing.note !== null ? (
            <div className="join-prompt-inline-message-note">{landing.note}</div>
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
        }}
        onDecline={() => onAnswer("not-yet")}
        onCancel={() => onAnswer("not-yet")}
      />
    </div>
  );
}

/**
 * The surface after the decision — the join, narrated where it was agreed to.
 *
 * The beats arrive through the store rather than as props ([L02]): the prompt
 * fact this mount came from is already gone by the time the first beat lands,
 * so the only live source is `ChangesetJoinStore` — the same one the composer
 * register reads, keyed the same way.
 */
function JoinLandingBody({
  workspaceKey,
  dash,
  onDepart,
}: {
  workspaceKey: string;
  dash: string;
  onDepart: () => void;
}): React.ReactElement {
  const progress = useChangesetJoinLand(workspaceKey, dash);
  const view = joinLandingView(dash, progress);

  const departRef = useRef(onDepart);
  departRef.current = onDepart;
  useEffect(() => {
    // Only a landed join departs on its own. A failure is the outcome the user
    // has something to do about, so it rests until they dismiss it.
    if (view.state !== "joined") return;
    const timer = setTimeout(() => departRef.current(), SETTLED_REST_MS);
    return () => clearTimeout(timer);
  }, [view.state]);

  return (
    <div
      className="join-prompt-inline join-prompt-inline-landing"
      data-slot="join-prompt-inline"
      data-phase="landing"
      data-state={view.state}
    >
      <div
        className="join-prompt-inline-landing-line"
        data-slot="join-prompt-inline-landing-line"
      >
        {view.line}
      </div>
      {view.detail !== null ? (
        <div
          className="join-prompt-inline-landing-detail"
          data-slot="join-prompt-inline-landing-detail"
        >
          {view.detail}
        </div>
      ) : null}
      {view.state === "failed" ? (
        // Inline has no host-provided ✕, and a failure never rests out on its
        // own — so the one state that stays needs a way to be put away. The
        // failure itself survives the dismissal on the register and in the
        // shade; what departs is this surface's copy of it.
        <div className="join-prompt-inline-landing-actions">
          <TugPushButton
            size="sm"
            onClick={() => departRef.current()}
            data-slot="join-prompt-inline-dismiss"
          >
            Dismiss
          </TugPushButton>
        </div>
      ) : null}
    </div>
  );
}
