/**
 * ArcRevisionNotice — a live arc's answers to a newer version of its brief.
 *
 * One line says what moved: the versions, how many decisions changed, were
 * added or removed, and which finished steps the change reaches. Under it are
 * the three answers: **Keep going**, **Open successor** — a popup of the
 * boundaries a successor may start from, the suggested one first — and
 * **Discard and reopen**. A parked arc's Open successor is a plain button that
 * opens the successor from the choice already recorded; an arc whose park is
 * still waiting for its step boundary says so in place of the button. The
 * notice is hidden once the user has kept going past the newest version.
 *
 * It is mounted in two places, and reads the same thread in both ([L02]): the
 * Docket card, under a live stale arc's row, and the arc shade's Brief panel
 * foot, beside its Open in Docket door. Its buttons dispatch vocabulary
 * actions to their parent responder ([L11], [L30]). On the Docket card that is
 * the card's responder, which carries out the act; on the shade the notice is
 * its own responder (`answers`), calling the same shared functions in
 * `lib/docket-loop-actions` and holding its own quiet line and discard
 * confirm ([L24]). A press that does not land says why ([L31]).
 *
 * Every button refuses focus, as the Open in Docket door does, so the notice
 * joins no focus order. The offer, the park and the suggested boundary are
 * attributes CSS draws ([L06]).
 *
 * Laws: [L02] the thread arrives from `useDockets`, [L06] marks are
 *       attributes, [L11] [L30] every press is a dispatched action, [L24] the
 *       press in flight and the confirm are local data, [L31] a refusal is
 *       said.
 *
 * @module components/tugways/cards/arc-revision-notice
 */

import "./arc-revision-notice.css";

import React, { useCallback, useId, useRef, useState } from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { TugConfirmPopover } from "@/components/tugways/tug-confirm-popover";
import { TugPopupButton, type TugPopupButtonItem } from "@/components/tugways/tug-popup-button";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useControlDispatch } from "@/components/tugways/use-control-dispatch";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import type { TugAction } from "@/lib/action-vocabulary";
import { boundaryChoices, revisionPending, revisionSummary } from "@/lib/docket-authoring";
import {
  discardAndReopen,
  keepGoing,
  openSuccessor,
  type LoopContext,
} from "@/lib/docket-loop-actions";
import type { DocketThread } from "@/lib/docket-types";

/** The question Discard and reopen asks before it acts. */
export function discardAndReopenMessage(arcName: string): string {
  return `Discard ${arcName} and reopen an arc on the newer brief? The arc's work is archived, not landed.`;
}

/** Read an Open successor payload back: `[threadKey, boundary]`. */
export function parseSuccessorPayload(value: unknown): { key: string; boundary: string } | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [key, boundary] = value as unknown[];
  return typeof key === "string" && typeof boundary === "string" ? { key, boundary } : null;
}

export interface ArcRevisionNoticeProps {
  thread: DocketThread;
  docketId: string;
  projectDir: string;
  /**
   * True where no responder above carries out the acts — the arc shade. The
   * notice then answers its own buttons, says how a press went on its own
   * quiet line, and arms its own discard confirm.
   */
  answers?: boolean;
  /** The card a fresh Session card opens beside, when the notice answers. */
  originCardId?: string | null;
}

export function ArcRevisionNotice({
  thread,
  docketId,
  projectDir,
  answers = false,
  originCardId = null,
}: ArcRevisionNoticeProps): React.ReactElement | null {
  const { dispatch } = useControlDispatch();
  const [line, setLine] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const discardRef = useRef<HTMLSpanElement | null>(null);
  const discardKey = `arc-revision-notice:${thread.key}`;

  // Live reads for the handlers, which run from the responder chain.
  const liveRef = useRef({ thread, docketId, projectDir, originCardId });
  liveRef.current = { thread, docketId, projectDir, originCardId };
  const context = useCallback(
    (): LoopContext => ({
      projectDir: liveRef.current.projectDir,
      docketId: liveRef.current.docketId,
      originCardId: liveRef.current.originCardId,
    }),
    [],
  );
  const settle = useCallback((outcome: Promise<string | null>) => {
    setLine(null);
    void outcome.then((said) => setLine(said));
  }, []);

  // With no responder above to carry them out, the notice answers its own
  // buttons; otherwise its actions pass through to the card's.
  const responderId = useId();
  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    actions: answers
      ? {
          [TUG_ACTIONS.KEEP_GOING_ARC]: () => settle(keepGoing(context(), liveRef.current.thread)),
          [TUG_ACTIONS.OPEN_SUCCESSOR]: (event: ActionEvent) => {
            const payload = parseSuccessorPayload(event.value);
            if (payload !== null) {
              settle(openSuccessor(context(), liveRef.current.thread, payload.boundary));
            }
          },
          [TUG_ACTIONS.DISCARD_AND_REOPEN_ARC]: () => setConfirming(true),
        }
      : {},
  });

  const arc = thread.arc ?? null;
  const revision = arc?.revision ?? null;
  if (arc === null || revision === null || arc.fate !== "live" || !revisionPending(thread)) {
    return null;
  }

  const parked = arc.parked === true;
  const waiting = !parked && typeof arc.successor === "string" && arc.successor.length > 0;
  const recorded = parked && typeof arc.park_boundary === "string" ? arc.park_boundary : null;
  const choices = boundaryChoices(revision);
  const items: TugPopupButtonItem<string[]>[] = choices.map((choice) => ({
    action: TUG_ACTIONS.OPEN_SUCCESSOR,
    value: [thread.key, choice.boundary],
    label: choice.suggested ? `${choice.label} (suggested)` : choice.label,
  }));
  const suggested = choices.find((c) => c.suggested)?.boundary;

  const press = (event: React.MouseEvent | undefined, action: TugAction, value?: unknown): void => {
    // A row the notice sits under is a door of its own; this press is not.
    event?.stopPropagation();
    event?.preventDefault();
    dispatch({ action, value, phase: "discrete" });
  };

  return (
    <ResponderScope>
      <div
        className="arc-revision-notice"
        data-slot="arc-revision-notice"
        data-offer={revision.offer.kind}
        data-parked={parked ? "true" : waiting ? "waiting" : undefined}
        data-suggested={suggested}
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <span className="arc-revision-notice-summary" data-slot="arc-revision-summary">
          {revisionSummary(revision)}
        </span>
        <span className="arc-revision-notice-actions">
          <TugPushButton
            size="2xs"
            emphasis="ghost"
            data-tug-focus="refuse"
            data-slot="arc-revision-keep-going"
            onClick={(event) => press(event, TUG_ACTIONS.KEEP_GOING_ARC, thread.key)}
          >
            Keep going
          </TugPushButton>
          {recorded !== null ? (
            <TugPushButton
              size="2xs"
              emphasis="ghost"
              data-tug-focus="refuse"
              data-slot="arc-revision-open-successor"
              onClick={(event) => press(event, TUG_ACTIONS.OPEN_SUCCESSOR, [thread.key, recorded])}
            >
              Open successor
            </TugPushButton>
          ) : waiting ? (
            <span className="arc-revision-notice-waiting" data-slot="arc-revision-waiting">
              {`Parks for ${arc.successor} at its next step boundary`}
            </span>
          ) : (
            <span data-slot="arc-revision-open-successor">
              <TugPopupButton
                size="2xs"
                label="Open successor"
                items={items}
                data-tug-focus="refuse"
                data-testid="arc-revision-boundaries"
              />
            </span>
          )}
          <span ref={discardRef}>
            <TugPushButton
              size="2xs"
              emphasis="ghost"
              data-tug-focus="refuse"
              data-slot="arc-revision-discard"
              onClick={(event) => press(event, TUG_ACTIONS.DISCARD_AND_REOPEN_ARC, thread.key)}
            >
              Discard and reopen
            </TugPushButton>
          </span>
        </span>
        {answers && line !== null && line.length > 0 ? (
          <span className="arc-revision-notice-line" data-slot="arc-revision-line" role="status">
            {line}
          </span>
        ) : null}
        {answers ? (
          <TugConfirmPopover
            open={confirming}
            anchorEl={confirming ? discardRef.current : null}
            message={discardAndReopenMessage(arc.name)}
            confirmLabel="Discard"
            confirm={{ role: "danger" }}
            side="top"
            onConfirm={() => {
              setConfirming(false);
              settle(discardAndReopen(context(), liveRef.current.thread, discardKey));
            }}
            onCancel={() => setConfirming(false)}
          />
        ) : null}
      </div>
    </ResponderScope>
  );
}
