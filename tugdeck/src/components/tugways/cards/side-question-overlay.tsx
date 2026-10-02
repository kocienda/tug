/**
 * side-question-overlay.tsx — the `/btw` side-question surface body ([P02]).
 *
 * `/btw <question>` asks Claude a quick side question, answered from the live
 * conversation with no tools and never entering the transcript. The answer
 * renders in the shared Z2 {@link TugPlacard} (opened on the BTW cell) — this
 * module contributes only the placard's **body**: the exchange list + footer.
 * The placard chrome (header, open/close, under-cell anchoring, auto-dismiss)
 * is owned by the Z2 status row like every other Z2 surface, so `/btw` is no
 * longer special — one open at a time, dismissed by clicking away.
 *
 * The body reads the ephemeral {@link SideQuestionStore} via
 * `useSyncExternalStore` ([L02]) and renders each exchange as a mini
 * transcript pair — a `You` row (the question) over a `Bot` row (the answer,
 * as markdown via {@link TugMarkdownBlock}, or the three-bar thinking
 * indicator while it loads). Multiple side questions stack, newest last. Each
 * exchange carries a `×` to cancel/dismiss it; the footer's Clear empties the
 * whole zone. Appearance (loading pose, synthetic marker) rides `data-*` + CSS,
 * never React state ([L06]).
 *
 * Nothing is dispatched to the code-session store, so the exchange never
 * becomes a transcript row and survives a reload with no trace ([P05]).
 *
 * @module components/tugways/cards/side-question-overlay
 */

import React, { useLayoutEffect, useRef } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { Bot, Check, CloudUpload, User, X } from "lucide-react";

import type { AnnotationContext } from "@/lib/annotator/types";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { BlockCopyButton } from "@/components/tugways/body-kinds/affordances";
import type { SideQuestionStore, SideQuestionExchange } from "@/lib/side-question-store";
import {
  btwContextLabel,
  composeBtwContextBody,
  type PendingContextStore,
  type PendingContextSnapshot,
} from "@/lib/pending-context-store";

import "./side-question-overlay.css";

export interface SideQuestionBodyProps {
  store: SideQuestionStore;
  /**
   * Annotator inputs for the answer markdown — the same context the main
   * transcript passes to its {@link TugMarkdownBlock}, so `/btw` answers
   * are annotated identically. Omit and answers carry only the state-free
   * entity kinds.
   */
  annotation?: AnnotationContext;
  /**
   * Staged-context queue. When set, each answered side question shows an
   * Add-to-context toggle that stages the Q/A pair to ride the next `❯`
   * submission (or un-stages it). Omitted in the gallery / fixtures.
   */
  pendingContextStore?: PendingContextStore;
}

/** Stable no-op store surface for the no-queue case (hook-order safety). */
const EMPTY_PENDING_SNAPSHOT: PendingContextSnapshot = {
  items: [],
  shellContext: false,
  btwContext: false,
};
const NOOP_SUBSCRIBE = (): (() => void) => () => {};
const NOOP_GET_PENDING = (): PendingContextSnapshot => EMPTY_PENDING_SNAPSHOT;

/**
 * When an in-place settle (an answer landing) happens, the pane only follows
 * to the bottom if the user was already within this many pixels of it — so a
 * settling answer never yanks the reader off an older exchange.
 */
const SIDE_QUESTION_NEAR_BOTTOM_PX = 48;

/** Plain-text answer for a settled/loading/errored exchange (footer copy). */
function exchangeAnswerText(ex: SideQuestionExchange): string {
  if (ex.phase === "loading") return "…";
  if (ex.phase === "error" || ex.answer === null) return "No response received.";
  return ex.answer;
}

/** Plain-text dump of the whole zone, for the footer Copy. */
function composeZoneCopyText(exchanges: readonly SideQuestionExchange[]): string {
  return exchanges
    .map((ex) => `Q: ${ex.question}\nA: ${exchangeAnswerText(ex)}`)
    .join("\n\n");
}

/**
 * One ask/answer exchange as a mini-transcript pair: a `You` row (question)
 * over a `Bot` row (answer). No timestamps. A settled answer renders as
 * markdown with a copy affordance beneath it; a loading answer shows the same
 * three-bar thinking indicator the transcript uses. The `×` cancels (loading)
 * or dismisses (settled) this exchange.
 */
function SideQuestionExchangeRow({
  exchange,
  onDismiss,
  annotation,
  pendingContextStore,
  staged,
}: {
  exchange: SideQuestionExchange;
  onDismiss: (id: string) => void;
  annotation?: AnnotationContext;
  pendingContextStore?: PendingContextStore;
  /** Whether this exchange is currently staged for the next submission. */
  staged: boolean;
}): React.ReactElement {
  const answered = exchange.phase === "answered" && exchange.answer !== null;
  return (
    <div
      className="side-question-exchange"
      data-phase={exchange.phase}
      data-synthetic={exchange.synthetic ? "" : undefined}
    >
      <button
        type="button"
        className="side-question-dismiss"
        aria-label="Dismiss this side question"
        title={exchange.phase === "loading" ? "Cancel this side question" : "Dismiss"}
        tabIndex={-1}
        data-tug-focus="refuse"
        onClick={() => onDismiss(exchange.id)}
      >
        <X size={12} strokeWidth={2} aria-hidden />
      </button>

      <div className="side-question-line" data-role="you">
        <span className="side-question-avatar" data-role="you" aria-hidden>
          <User size={14} strokeWidth={2} />
        </span>
        <div className="side-question-text side-question-question">
          {exchange.question}
        </div>
      </div>

      <div className="side-question-line" data-role="bot">
        <span className="side-question-avatar" data-role="bot" aria-hidden>
          <Bot size={14} strokeWidth={2} />
        </span>
        <div className="side-question-text side-question-answer" data-phase={exchange.phase}>
          {answered ? (
            <TugMarkdownBlock
              // Mount-once on the settled text (loading → answered is the only
              // transition; a re-ask is a new exchange with a new id/key).
              initialText={exchange.answer ?? ""}
              className="side-question-markdown"
              annotation={annotation}
            />
          ) : exchange.phase === "loading" ? (
            <TugProgressIndicator
              variant="wave"
              state="running"
              role="inherit"
              // Smaller than the transcript's 16px default — the mini-pane
              // runs at ~0.82rem text, so the thinking glyph scales down too.
              size={12}
              aria-label="Thinking…"
              aria-live="polite"
            />
          ) : (
            "No response received."
          )}
        </div>
      </div>

      {answered ? (
        <div className="side-question-answer-actions">
          <BlockCopyButton
            subtype="icon-text"
            emphasis="ghost"
            size="2xs"
            aria-label="Copy this side question and answer"
            getText={() => `Q: ${exchange.question}\nA: ${exchangeAnswerText(exchange)}`}
          />
          {pendingContextStore !== undefined ? (
            <TugPushButton
              subtype="icon-text"
              emphasis="ghost"
              role="action"
              size="2xs"
              data-tug-focus="refuse"
              // The glyph rides the button's own icon slot, not the label
              // content — the slot is what aligns it with the COPY button
              // beside it (an icon dropped into `children` lays out as inline
              // text and sits a couple of pixels low).
              icon={
                staged ? (
                  <Check size={12} strokeWidth={2} aria-hidden />
                ) : (
                  <CloudUpload size={12} strokeWidth={2} aria-hidden />
                )
              }
              aria-pressed={staged}
              aria-label={
                staged
                  ? "Remove this side question from the next submission's context"
                  : "Add this side question to the next submission's context"
              }
              title={staged ? "Staged for the next submission" : "Add to context"}
              onClick={() => {
                if (staged) {
                  pendingContextStore.unstageRef("btw", exchange.id);
                } else {
                  pendingContextStore.stage({
                    source: "btw",
                    ref: exchange.id,
                    label: btwContextLabel(exchange.id),
                    body: composeBtwContextBody(exchange.question, exchange.answer ?? ""),
                  });
                }
              }}
            >
              {staged ? "In context" : "Add to context"}
            </TugPushButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The `/btw` placard body — the exchange list + footer, rendered inside the
 * shared Z2 {@link TugPlacard} by the status row when the BTW cell is open.
 * Reads the ephemeral {@link SideQuestionStore} via `useSyncExternalStore`
 * ([L02]); the placard chrome (open/close, anchoring, dismiss) lives in the
 * host, not here.
 */
export function SideQuestionBody({
  store,
  annotation,
  pendingContextStore,
}: SideQuestionBodyProps): React.ReactElement {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { exchanges } = snapshot;
  // Re-render on staged-queue changes so each row's Add-to-context toggle
  // reflects the live staged state ([L02]). Stable no-op surfaces keep the
  // hook order fixed when there is no queue (gallery / fixtures).
  const pendingSnapshot = useSyncExternalStore(
    pendingContextStore?.subscribe ?? NOOP_SUBSCRIBE,
    pendingContextStore?.getSnapshot ?? NOOP_GET_PENDING,
  );
  const stagedRefs = React.useMemo(
    () =>
      new Set(
        pendingSnapshot.items.filter((it) => it.source === "btw").map((it) => it.ref),
      ),
    [pendingSnapshot],
  );

  // Auto-scroll the mini-transcript ([L06] — DOM scroll, not React state). A
  // fresh ask (a new tail id) pins the newest submission into view at
  // submission time; an in-place settle (an answer landing on an existing
  // exchange) only follows the bottom if the reader was already near it, so it
  // never yanks them off an older exchange they are reading.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const prevTailIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    const tailId = exchanges.length > 0 ? exchanges[exchanges.length - 1].id : null;
    const isNewTail = tailId !== null && tailId !== prevTailIdRef.current;
    prevTailIdRef.current = tailId;
    if (isNewTail) {
      body.scrollTop = body.scrollHeight;
      return;
    }
    const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (distanceFromBottom < SIDE_QUESTION_NEAR_BOTTOM_PX) {
      body.scrollTop = body.scrollHeight;
    }
  }, [exchanges]);

  return (
    <>
      <div className="side-question-body" data-slot="side-question-body" ref={bodyRef}>
        {exchanges.length === 0 ? (
          <div className="side-question-empty">No side questions</div>
        ) : (
          exchanges.map((ex) => (
            <SideQuestionExchangeRow
              key={ex.id}
              exchange={ex}
              onDismiss={(id) => store.dismiss(id)}
              annotation={annotation}
              pendingContextStore={pendingContextStore}
              staged={stagedRefs.has(ex.id)}
            />
          ))
        )}
      </div>

      {exchanges.length > 0 ? (
        <div className="side-question-footer" data-slot="side-question-footer">
          <BlockCopyButton
            subtype="text"
            emphasis="outlined"
            size="2xs"
            aria-label="Copy the side-question history"
            getText={() => composeZoneCopyText(exchanges)}
          />
          <TugPushButton
            emphasis="outlined"
            role="action"
            size="2xs"
            aria-label="Clear side questions"
            title="Clear the side-question zone"
            onClick={() => store.clear()}
          >
            Clear
          </TugPushButton>
        </div>
      ) : null}
    </>
  );
}
