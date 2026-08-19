/**
 * `AskUserQuestionToolBlock` — Layer-2 wrapper for Claude Code's
 * `AskUserQuestion` tool.
 *
 * The tool has two surfaces in the transcript, and this ONE block owns
 * both — IN PLACE, at the tool_use position. A single `BlockChrome`
 * stays mounted across the call's lifecycle ([L26]); only its body
 * morphs, so the option/button chrome simply disappears on answer with
 * no width, treatment, or position shift ([D13]):
 *
 *   1. **Asking state (live question).** When a `control_request_forward`
 *      for this call's `tool_use_id` is the session's `pendingQuestion`
 *      (and `status === "streaming"`), the block fills its chrome body
 *      with the live `QuestionWizard` (`session-question-dialog.tsx`) — the
 *      radio / check prompt that submits the user's choices back to
 *      Claude. The chrome is `forceExpanded` so a blocking question can't
 *      be folded away ([P07]). Before the forward arrives (and the user
 *      hasn't answered), the block renders `null`.
 *
 *   2. **Answered / ready state.** The user answers, `pendingQuestion`
 *      clears, and the SAME chrome swaps its body to the durable
 *      artifact: a clean, numbered Q&A list. The just-submitted answers
 *      are captured locally (`onResolve` → `submitted`) so the summary
 *      paints immediately, covering the window between `pendingQuestion`
 *      clearing and the tool_result landing — no empty-answer flash, no
 *      remount.
 *
 * Composition (Spec S03, [#bk-conformance]):
 *  - `BlockChrome` owns the frame: the tool name + a short args
 *    summary (the question count).
 *  - **Body — ready state:** a numbered list of `Q → A` pairs. The
 *    question text reads as the prompt, the chosen label (or
 *    comma-separated labels for multi-select) reads as the response.
 *    No `JsonTreeBlock`, no raw schema. When no answer is recorded
 *    yet, the row reads "(no answer)" in muted prose — the same
 *    fallback the spoken summary uses.
 *  - **Body — error state:** the chrome's error band carries the
 *    failure text; the body drops.
 *
 * Wire shape:
 *  - `input.questions[]` — same `ParsedQuestion`-ish shape the
 *    `QuestionDialog` parses. Reused via {@link parseQuestions} so
 *    drift surfaces in both surfaces consistently.
 *  - The chosen answers arrive on the *completed* `tool_use_structured`
 *    (or merged back into `input.answers` per tugcode's
 *    `formatQuestionAnswer`) as `{ answers: Record<string, string> }`,
 *    keyed by question text, value is the chosen label(s). Defensive
 *    narrowing here means we read either surface (`structuredResult` or
 *    `input.answers`) so the wrapper renders correctly across the
 *    catalog's variations.
 *
 * Registration: `session-assistant-renderer-dispatch.ts` imports this
 * module and calls `registerToolBlock("askuserquestion", …)`
 * alongside the other wrappers. The registry's lowercased keys
 * absorb wire-shape casing variants (`AskUserQuestion` /
 * `askuserquestion`) automatically.
 *
 * Laws:
 *  - [L06] no React state for appearance; chrome owns DOM
 *    attributes; the body composition is pure props derived via
 *    `useMemo`.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot="ask-user-question-tool-block"` (delegated via the
 *    chrome's `rootSlot`).
 *  - [L20] reuses the chrome's `--tugx-block-*`; the small Q&A
 *    list owns `--tugx-askquestion-*` (declared in the sibling
 *    `.css`). No cross-component token poaching.
 *
 * Decisions:
 *  - [D05] two-layer hybrid — chrome owns frame, body owns the
 *    rendering. The body here is component-local because the Q&A
 *    summary surface is wrapper-specific (not a reusable body kind
 *    like `JsonTreeBlock`).
 *  - [D11] `AskUserQuestion` is promoted out of the `DefaultToolBlock`
 *    fallback now that the wrapper is bespoke; the unknown-tool
 *    caution disappears automatically.
 *
 * @module components/tugways/cards/blocks/ask-user-question-tool-block
 */

import "./ask-user-question-tool-block.css";

import React from "react";
import { MessageCircle } from "lucide-react";

import { TugDialogButton } from "@/components/tugways/tug-dialog-button";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  applyQuestionSelection,
  initialQuestionSelections,
  parseQuestions,
  SessionQuestionWizard,
  type ParsedQuestion,
} from "@/components/tugways/chrome/session-question-dialog";
import {
  QuestionSummaryList,
  type QuestionSummaryRowData,
} from "@/components/tugways/question-summary-list";
import type { ControlRequestForward } from "@/lib/code-session-store";

import { BlockChrome } from "../../blocks/block-chrome";
import type { ToolResultSummary } from "../../blocks/tool-result-summary";
import type { ToolBlockProps } from "../../blocks/types";

// ---------------------------------------------------------------------------
// Wire-shape narrowing
// ---------------------------------------------------------------------------

/**
 * Read the answers map out of the merged tool wire. tugcode's
 * `formatQuestionAnswer` writes `answers` onto `updatedInput`, so the
 * map can arrive in either of two places after the round-trip:
 *
 *  - `input.answers` — when the catalog version surfaces the
 *    merged-back input as the visible `tool_use.input`.
 *  - `structuredResult.answers` — when the catalog emits a separate
 *    structured result for the call.
 *
 * Either way the inner shape is the same: `Record<question, label>`.
 * The narrower drops non-string values silently. Exported for the
 * unit tests.
 */
export function readAnswers(
  input: unknown,
  structuredResult: unknown,
): Record<string, string> {
  const fromStructured = readAnswersFromObject(structuredResult);
  if (fromStructured !== undefined) return fromStructured;
  return readAnswersFromObject(input) ?? {};
}

function readAnswersFromObject(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = (value as { answers?: unknown }).answers;
  if (raw === null || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Read the freeform decline reply ([P02], `Chat about this`) out of the
 * merged tool wire. tugcode's `formatQuestionAnswer` writes `response`
 * onto `updatedInput` for a decline (instead of `answers`), so — like
 * {@link readAnswers} — it can surface on `structuredResult` or `input`.
 * Returns the reply string when present and non-blank, else `undefined`
 * (a normal answer). Exported for the unit tests.
 */
export function readDeclineResponse(
  input: unknown,
  structuredResult: unknown,
): string | undefined {
  return (
    readResponseFromObject(structuredResult) ?? readResponseFromObject(input)
  );
}

function readResponseFromObject(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = (value as { response?: unknown }).response;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw;
}

/**
 * Bridge the `unknown` wire `input` into the shape `parseQuestions`
 * (the question-dialog's parser) expects. We construct a synthetic
 * `ControlRequestForward` because `parseQuestions` lives in the
 * dialog module and was written against that interface — reusing it
 * keeps the parsing rules identical between the live dialog and the
 * post-answer wrapper.
 */
function parseInputQuestions(input: unknown): ParsedQuestion[] {
  // `ControlRequestForward` typing has more fields than we need;
  // narrow construction keeps the call site honest at the type level.
  const forward = {
    request_id: "",
    is_question: true,
    tool_name: "AskUserQuestion",
    input,
  } as unknown as ControlRequestForward;
  return parseQuestions(forward);
}

// ---------------------------------------------------------------------------
// Q&A summary — pure helper (exported for tests)
// ---------------------------------------------------------------------------

/** One row in the post-answer summary. */
export interface AnswerSummaryEntry {
  question: string;
  /** Labels the user chose. Multi-select round-trips as a comma-joined
   *  string; we split on `,` so the wrapper can render each pick on
   *  its own line. Empty when no answer was recorded. */
  answers: string[];
}

/**
 * Compose the Q&A summary the body renders: one entry per question
 * in the original order, each carrying the chosen answer label(s).
 * A question with no recorded answer carries `answers: []`; the
 * renderer paints that as "(no answer)" so the row stays useful for
 * follow-up rather than disappearing.
 *
 * Exported for the unit test.
 */
export function composeAnswerSummary(
  questions: ReadonlyArray<ParsedQuestion>,
  answers: Record<string, string>,
): AnswerSummaryEntry[] {
  return questions.map((q) => {
    const raw = answers[q.question];
    if (raw === undefined || raw === "") {
      return { question: q.question, answers: [] };
    }
    if (q.multiSelect) {
      // tugcode joins multi-select labels with a bare `,` (PN-5). Split
      // and trim defensively so a downstream layer that adds spaces
      // wouldn't break the row count. But a free-text answer ([P01]) is
      // a single verbatim string that may itself contain commas — only
      // split when every part is a known option label; otherwise render
      // the value verbatim (no label assumptions).
      const labels = new Set(q.options.map((o) => o.label));
      const parts = raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
      if (parts.length > 0 && parts.every((p) => labels.has(p))) {
        return { question: q.question, answers: parts };
      }
      return { question: q.question, answers: [raw] };
    }
    return { question: q.question, answers: [raw] };
  });
}

/**
 * Plain-text rendering of the Q&A summary for the args slot. Format:
 * `"N answered"` or `"N questions"` for the streaming case — short
 * enough to sit at the chrome header without crowding the caution /
 * actions slots.
 */
export function composeQuestionCountLabel(
  totalQuestions: number,
  answeredCount: number,
): string {
  if (totalQuestions === 0) return "";
  if (answeredCount === 0) {
    return `${totalQuestions} ${totalQuestions === 1 ? "question" : "questions"}`;
  }
  return `${answeredCount} of ${totalQuestions} answered`;
}

// ---------------------------------------------------------------------------
// Validation-error parsing — the salvage trigger
// ---------------------------------------------------------------------------

/**
 * One Zod issue from Claude Code's `AskUserQuestion` validator. The
 * `path` shape is always `["questions", N, "options"]` (or similar)
 * when the cap is violated. We narrow defensively because the wire
 * shape is whatever Claude Code's JSON serializer produced — fields
 * may be missing in older versions.
 */
export interface AskUserQuestionValidationIssue {
  code?: string;
  message?: string;
  path?: ReadonlyArray<string | number>;
  maximum?: number;
}

export interface AskUserQuestionValidationError {
  issues: AskUserQuestionValidationIssue[];
}

/**
 * Detect Claude Code's `InputValidationError` for `AskUserQuestion`.
 *
 * The error format the binary emits is:
 *
 *   InputValidationError: [ { "origin": "array", "code": "too_big",
 *     "maximum": 4, "inclusive": true,
 *     "path": [ "questions", 1, "options" ],
 *     "message": "Too big: expected array to have <=4 items" } ]
 *
 * The leading prefix is plain text and the bracketed payload is a
 * Zod-issue array. We parse the JSON tail and surface its issues so
 * the wrapper can branch into the salvage path. Returns `null` for
 * any unrecognised shape — the wrapper falls back to the generic
 * error band in that case.
 *
 * Pure; exported for unit tests.
 */
export function parseAskUserQuestionInputValidationError(
  textOutput: string | undefined,
): AskUserQuestionValidationError | null {
  if (textOutput === undefined || textOutput === "") return null;
  // The marker is loose because Claude Code occasionally tweaks the
  // wording; the JSON tail is the load-bearing piece.
  if (!textOutput.includes("InputValidationError")) return null;
  const start = textOutput.indexOf("[");
  if (start === -1) return null;
  // The payload ends at the last `]` to survive any trailing prose.
  const end = textOutput.lastIndexOf("]");
  if (end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(textOutput.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const issues: AskUserQuestionValidationIssue[] = [];
  for (const raw of parsed) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const issue: AskUserQuestionValidationIssue = {};
    if (typeof r.code === "string") issue.code = r.code;
    if (typeof r.message === "string") issue.message = r.message;
    if (Array.isArray(r.path)) {
      issue.path = r.path.filter(
        (p): p is string | number => typeof p === "string" || typeof p === "number",
      );
    }
    if (typeof r.maximum === "number") issue.maximum = r.maximum;
    issues.push(issue);
  }
  if (issues.length === 0) return null;
  return { issues };
}

/**
 * Build a short human-readable banner explaining what went wrong.
 * The wrapper paints this above the salvage wizard so the user
 * understands the bridge they're crossing. Pure; exported for tests.
 */
export function composeValidationErrorBanner(
  err: AskUserQuestionValidationError,
): string {
  // We surface the most common issue (`too_big` on an options array)
  // explicitly; everything else falls through to a generic line.
  for (const issue of err.issues) {
    if (
      issue.code === "too_big" &&
      issue.path !== undefined &&
      issue.path.includes("options")
    ) {
      const limit = issue.maximum ?? 4;
      return `Claude Code rejected this question — it allows at most ${limit} options per question. Answer it here anyway:`;
    }
  }
  return "Claude Code rejected this question. Answer it here anyway:";
}

/**
 * Compose the salvaged-answer message body the wrapper posts back
 * as a fresh user turn. Format mirrors the live dialog's terse
 * summary so the assistant reads "user answered the questions" in
 * a shape it would have seen had the tool succeeded.
 *
 * Example output for two questions:
 *
 *   My answers to your AskUserQuestion (the tool call hit Claude Code's
 *   options cap, so I'm answering directly):
 *   1. Which slice of the component system? → tugways body-kinds
 *   2. Which kind of inconsistency matters? → Prop API shape, File/CSS/test structure
 *
 * Pure; exported for tests.
 */
export function composeSalvagedAnswerMessage(
  questions: ReadonlyArray<ParsedQuestion>,
  answersByQuestion: ReadonlyMap<string, ReadonlyArray<string>>,
): string {
  const lines: string[] = [
    "My answers to your AskUserQuestion (the tool call hit Claude Code's options cap, so I'm answering directly):",
  ];
  questions.forEach((q, index) => {
    const picks = answersByQuestion.get(q.question) ?? [];
    const answerText = picks.length === 0 ? "(no answer)" : picks.join(", ");
    lines.push(`${index + 1}. ${q.question} → ${answerText}`);
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Stable no-op `subscribe` for `useSyncExternalStore` when no session is
 *  threaded (the standalone gallery mount). Never notifies; the paired
 *  snapshot returns `null`. */
const noopSubscribe = (): (() => void) => () => {};

export const AskUserQuestionToolBlock: React.FC<ToolBlockProps> = ({
  toolUseId,
  toolName,
  input,
  structuredResult,
  textOutput,
  status,
  phase,
  caution,
  session,
}) => {
  // Hooks must run unconditionally on every render — keep them above
  // any early returns so the hook order doesn't shift across status
  // transitions.

  // [L02] Is a question live for THIS tool call? The pending forward and
  // the tool_use row share `tool_use_id`; the live wizard and the durable
  // record are now one block, so the asking surface is owned here in place
  // rather than handed to a foot-slot dialog.
  const pendingQuestion = React.useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    React.useCallback(
      () => session?.getSnapshot().pendingQuestion ?? null,
      [session],
    ),
  );
  // The user's just-submitted resolution, captured the instant they answer
  // so the durable summary paints immediately — covering the window between
  // `pendingQuestion` clearing and the tool_result landing (status still
  // `streaming`), with no empty-answer flash and no chrome remount.
  const [submitted, setSubmitted] = React.useState<{
    answers?: Record<string, string>;
    response?: string;
  } | null>(null);

  const questions = React.useMemo(() => parseInputQuestions(input), [input]);
  const wireAnswers = React.useMemo(
    () => readAnswers(input, structuredResult),
    [input, structuredResult],
  );
  // Prefer the wire answers once they land; until then fall back to the
  // locally-captured submission so the morph reads correctly mid-flight.
  const answers = React.useMemo(
    () =>
      Object.keys(wireAnswers).length > 0
        ? wireAnswers
        : (submitted?.answers ?? {}),
    [wireAnswers, submitted],
  );
  const summary = React.useMemo(
    () => composeAnswerSummary(questions, answers),
    [questions, answers],
  );
  // [P02] `Chat about this` — when the user declined, the result carries
  // a freeform `response` instead of `answers`. Present ⇒ render the
  // "replied in chat" state rather than the Q&A summary. Read the wire
  // first, else the just-submitted decline.
  const wireDecline = React.useMemo(
    () => readDeclineResponse(input, structuredResult),
    [input, structuredResult],
  );
  const declineResponse = wireDecline ?? submitted?.response;

  // Salvage state — populated when the user finishes the salvage
  // wizard (we keep the locally-collected answers around so the
  // wrapper can flip from "asking out-of-band" to "answered out-of-
  // band" without losing context). Map keyed by question text,
  // value is the chosen labels.
  const [salvagedAnswers, setSalvagedAnswers] = React.useState<
    Map<string, string[]> | null
  >(null);
  // Cancel-out: the user clicked the salvage "Cancel" button. We
  // collapse the salvage UI and fall back to the chrome's error
  // band so the failed call is honestly visible — same as if the
  // wrapper had never offered salvage.
  const [salvageCancelled, setSalvageCancelled] = React.useState(false);

  // Try to detect the InputValidationError that fires when Claude
  // Code's schema rejects an `AskUserQuestion` call (most often the
  // ≤4-options cap). When detected, we mount the salvage UI inline:
  // the questions render with our renderer's no-cap option list,
  // and the user's answers post back as a follow-on user turn (see
  // `composeSalvagedAnswerMessage`).
  const validationError = React.useMemo(
    () => parseAskUserQuestionInputValidationError(textOutput),
    [textOutput],
  );
  const isSalvageable =
    status === "error" &&
    validationError !== null &&
    questions.length > 0 &&
    session !== undefined &&
    !salvageCancelled;

  // [P01]/[P06] Is THIS block's question live right now? `streaming` plus a
  // pending forward whose `tool_use_id` matches us. The block owns the
  // asking surface in place: the same `BlockChrome` hosts the live wizard
  // and then morphs to the durable Q&A artifact once answered ([L26] — one
  // mounted chrome across the lifecycle).
  const isLive =
    status === "streaming" &&
    session !== undefined &&
    pendingQuestion !== null &&
    pendingQuestion.tool_use_id === toolUseId;

  if (isLive && session !== undefined) {
    // Asking state: the live wizard fills the chrome body. Force-expanded so
    // a blocking question can't be folded away ([P07]); the lifecycle dot
    // already reads `awaiting` via the dispatch's `awaitingToolUseId` join.
    return (
      <BlockChrome
        rootSlot="ask-user-question-tool-block"
        toolName={toolName}
        status={status}
        phase={phase}
        caution={caution}
        forceExpanded
      >
        <SessionQuestionWizard
          request={pendingQuestion}
          session={session}
          onResolve={setSubmitted}
        />
      </BlockChrome>
    );
  }

  // Pre-question streaming window — the tool_use exists but the forward
  // hasn't arrived and the user hasn't answered yet. Render nothing until
  // the question is live; the chrome mounts at `isLive` and persists.
  if (status === "streaming" && submitted === null) return null;
  // The headline count surfaces user-confirmed answers — either the
  // wire-side `answers` (a successful tool round-trip) or the
  // locally-collected `salvagedAnswers` (the recovery path).
  const headlineCount =
    salvagedAnswers !== null
      ? Array.from(salvagedAnswers.values()).filter((v) => v.length > 0).length
      : summary.filter((s) => s.answers.length > 0).length;
  const args = composeQuestionCountLabel(questions.length, headlineCount);
  // The question count is the header's trailing result summary — one quiet
  // line ("3 of 3 answered"), the same plain style every tool uses. A
  // declined prompt ([P02]) reads "Replied in chat" instead.
  const resultSummary: ToolResultSummary | undefined =
    declineResponse !== undefined
      ? { kind: "text", text: "Replied in chat" }
      : args === ""
        ? undefined
        : { kind: "text", text: args };

  let body: React.ReactNode;
  if (declineResponse !== undefined) {
    // The user abandoned the questions and replied in prose.
    body = <QuestionDeclinedSummary response={declineResponse} />;
  } else if (salvagedAnswers !== null) {
    // After the user finishes salvage, render the Q&A summary built
    // from the locally-collected answers. Same shape as the normal
    // post-answer view so the wrapper reads identically regardless
    // of which channel produced the result.
    body = (
      <SalvageAnsweredSummary
        questions={questions}
        answersByQuestion={salvagedAnswers}
      />
    );
  } else if (isSalvageable && session !== undefined && validationError !== null) {
    body = (
      <SalvageWizard
        questions={questions}
        bannerText={composeValidationErrorBanner(validationError)}
        onSubmit={(picksByQuestion) => {
          const text = composeSalvagedAnswerMessage(questions, picksByQuestion);
          session.send(text, []);
          setSalvagedAnswers(new Map(picksByQuestion));
        }}
        onCancel={() => setSalvageCancelled(true)}
      />
    );
  } else if (status === "error") {
    body = null;
  } else if (summary.length === 0) {
    body = (
      <div
        className="ask-user-question-tool-block-empty"
        data-slot="ask-user-question-tool-block-empty"
      >
        No question was recorded.
      </div>
    );
  } else {
    body = <AnsweredQuestionSummary entries={summary} />;
  }

  // Errored calls carry the failure message in `textOutput` — route to
  // the chrome's error band rather than the body. Suppressed when
  // we've taken the salvage path (the inline banner says everything
  // the raw Zod blob would, more clearly), and also when the user has
  // already answered out-of-band (the Q&A summary is the surface).
  const showErrorBand =
    status === "error" &&
    salvagedAnswers === null &&
    !isSalvageable &&
    textOutput !== undefined &&
    textOutput.length > 0;

  // When the salvage path is live (asking or answered) we don't want
  // the chrome's red error stripe over the top — the wrapper isn't
  // really "errored" from the user's POV anymore.
  const chromeStatus =
    salvagedAnswers !== null || isSalvageable ? "ready" : status;

  return (
    <BlockChrome
      rootSlot="ask-user-question-tool-block"
      toolName={toolName}
      resultSummary={resultSummary}
      status={chromeStatus}
      phase={phase}
      caution={caution}
      notice={showErrorBand ? { tone: "error", text: textOutput } : undefined}
    >
      {body}
    </BlockChrome>
  );
};

// ---------------------------------------------------------------------------
// Salvage wizard — flat-stack alternative to the live `QuestionDialog`
// ---------------------------------------------------------------------------

/**
 * Inline salvage UI for when Claude Code rejected an `AskUserQuestion`
 * call via its options-cap validator. Renders each question with its
 * full options list (no cap on our side), collects the picks, and
 * hands them to `onSubmit` so the host can format them and post as a
 * fresh user turn.
 *
 * Layout is deliberately flatter than the live `QuestionDialog`'s
 * wizard rail: salvage is a recovery path, not the primary surface,
 * and stacking the questions in document order is cheaper and avoids
 * mounting the dialog primitive (which is wired to the session's
 * `pendingQuestion` lifecycle the salvage path doesn't have).
 *
 * Pure presentational: holds its own selection state, calls
 * `onSubmit(picksByQuestion)` once when the user clicks Submit.
 */
function SalvageWizard({
  questions,
  bannerText,
  onSubmit,
  onCancel,
}: {
  questions: ReadonlyArray<ParsedQuestion>;
  bannerText: string;
  onSubmit: (picksByQuestion: Map<string, string[]>) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [selections, setSelections] = React.useState<string[][]>(() =>
    initialQuestionSelections(questions),
  );

  const handleSelect = React.useCallback(
    (questionIndex: number, optionLabel: string) => {
      setSelections((prev) => {
        const question = questions[questionIndex];
        if (question === undefined) return prev;
        const next = prev.slice();
        next[questionIndex] = applyQuestionSelection(
          question,
          prev[questionIndex] ?? [],
          optionLabel,
        );
        return next;
      });
    },
    [questions],
  );

  const handleSubmit = React.useCallback(() => {
    const map = new Map<string, string[]>();
    questions.forEach((q, i) => {
      map.set(q.question, [...(selections[i] ?? [])]);
    });
    onSubmit(map);
  }, [questions, selections, onSubmit]);

  return (
    <div
      className="ask-user-question-tool-block-salvage"
      data-slot="ask-user-question-tool-block-salvage"
    >
      <div
        className="ask-user-question-tool-block-salvage-banner"
        data-slot="ask-user-question-tool-block-salvage-banner"
        role="status"
      >
        {bannerText}
      </div>
      <ol
        className="ask-user-question-tool-block-salvage-list"
        data-slot="ask-user-question-tool-block-salvage-list"
      >
        {questions.map((question, index) => {
          const selection = selections[index] ?? [];
          const selectionStyle = question.multiSelect ? "check" : "radio";
          return (
            <li
              key={`${index}:${question.question}`}
              className="ask-user-question-tool-block-salvage-item"
              data-slot="ask-user-question-tool-block-salvage-item"
            >
              <div className="ask-user-question-tool-block-salvage-question">
                {index + 1}. {question.question}
              </div>
              <div
                className="ask-user-question-tool-block-salvage-options"
                role={question.multiSelect ? "group" : "radiogroup"}
                aria-label={question.question}
              >
                {question.options.map((option) => (
                  <TugDialogButton
                    key={option.label}
                    label={option.label}
                    description={option.description}
                    selected={selection.includes(option.label)}
                    selectionStyle={selectionStyle}
                    onClick={() => handleSelect(index, option.label)}
                  />
                ))}
              </div>
            </li>
          );
        })}
      </ol>
      <div
        className="ask-user-question-tool-block-salvage-actions"
        data-slot="ask-user-question-tool-block-salvage-actions"
      >
        {/* Mac-HIG 3-button vocabulary: the destructive-secondary
         * "Cancel" sits at the leading edge separated from the
         * primary "Send answers" on the trailing edge. Outlined +
         * danger so the visual weight reads "I'm walking away from
         * this" without competing with the primary CTA. */}
        <TugPushButton emphasis="outlined" role="danger" onClick={onCancel}>
          Cancel
        </TugPushButton>
        <TugPushButton emphasis="primary" role="action" onClick={handleSubmit}>
          Send answers
        </TugPushButton>
      </div>
    </div>
  );
}

/**
 * Post-salvage Q&A summary. Composes the locally-collected picks into
 * the same {@link AnswerSummaryEntry} shape the regular post-tool view
 * uses and renders through the shared {@link QuestionSummaryList}, so
 * the wrapper reads identically regardless of which channel produced
 * the result.
 */
function SalvageAnsweredSummary({
  questions,
  answersByQuestion,
}: {
  questions: ReadonlyArray<ParsedQuestion>;
  answersByQuestion: ReadonlyMap<string, ReadonlyArray<string>>;
}): React.ReactElement {
  const entries = questions.map((question) => ({
    question: question.question,
    answers: [...(answersByQuestion.get(question.question) ?? [])],
  }));
  return <AnsweredQuestionSummary entries={entries} />;
}

/**
 * The declined-prompt state ([P02]): the user chose `Chat about this`
 * and answered in prose instead of picking. Renders a quiet "replied in
 * chat" notice over the freeform reply verbatim, so the durable record
 * shows what the user said rather than an empty Q&A summary.
 */
function QuestionDeclinedSummary({
  response,
}: {
  response: string;
}): React.ReactElement {
  return (
    <div
      className="ask-user-question-tool-block-declined"
      data-slot="ask-user-question-tool-block-declined"
    >
      <div className="ask-user-question-tool-block-declined-notice">
        <span
          className="ask-user-question-tool-block-marker"
          aria-hidden="true"
        >
          <MessageCircle size={14} aria-hidden="true" />
        </span>
        Replied in chat instead of answering
      </div>
      <div className="ask-user-question-tool-block-declined-text">
        {response}
      </div>
    </div>
  );
}

/**
 * The durable Q&A record — the SAME `QuestionSummaryList` the live wizard's
 * rail renders, so the two read as one artifact and hold position across the
 * morph. The rows are static (no `onActivate`); an answered question is `done`
 * (success check), an empty one `pending` (muted ring). A progress summary
 * above the rows occupies the same vertical box as the live action bar (a
 * button-height row with the dialog's action margins, [reserved space]) so the
 * rows don't shift when the wizard becomes this record.
 */
function AnsweredQuestionSummary({
  entries,
}: {
  entries: ReadonlyArray<AnswerSummaryEntry>;
}): React.ReactElement {
  const total = entries.length;
  const answered = entries.filter((e) => e.answers.length > 0).length;
  const rows: QuestionSummaryRowData[] = entries.map((entry, index) => ({
    index,
    question: entry.question,
    answer: entry.answers.join(", "),
    status: entry.answers.length > 0 ? "done" : "pending",
  }));
  return (
    <div
      className="ask-user-question-tool-block-answered"
      data-slot="ask-user-question-tool-block-answered"
    >
      <div
        className="ask-user-question-tool-block-summary"
        data-slot="ask-user-question-tool-block-summary"
      >
        {total} {total === 1 ? "question" : "questions"} · {answered} answered
      </div>
      <QuestionSummaryList rows={rows} className="ask-user-question-tool-block-list" />
    </div>
  );
}
