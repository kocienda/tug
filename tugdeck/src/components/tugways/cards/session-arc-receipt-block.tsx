/**
 * `SessionArcReceiptBlock` — the bespoke `/arc-run` command-block renderer
 * ([P12]).
 *
 * An arc's ending leaves one shell-exchange row whose `output` is the
 * server-formatted record — `format_arc_receipt` for an arc that finished,
 * `format_arc_stop_receipt` for one that stopped. This renderer parses that
 * string and presents it as a receipt instead of the generic fenced
 * `ShellExchangeBlock`.
 *
 * **One row, two shapes, decided by outcome** ([B04], [F08]). An arc that
 * *finished* paints a quiet line — `<arc> Finished · N stages` under the ship
 * wheel, at the transcript's body inset, in the arc-note register every other
 * arc gesture reads in — because the record it used to carry now folds behind
 * the `Joined` boundary once the arc lands ([B02]), and a second full report
 * of one event is the doubling this whole report ended. An arc that *stopped*
 * or *picked itself back up* keeps the receipt below, because it carries the
 * stage's own words and the Resume offer, which a line cannot hold. The seat
 * follows the shape: `arcReceiptPresentation` is what the registry reads.
 *
 * **The header wears {@link ArcLifecycleBlock} in its row layout**, which is
 * the whole design: the same block the Arcs card, the Changes shade's
 * collapsed row and the masthead placard wear stacked, set on one line
 * because here it captions a body rather than being the thing read. So a
 * reader who learned the identities and the strip on any of those has learned
 * this header for free, and there is no second composition of an arc's
 * identity to keep in step. The stages the arc actually walked go underneath,
 * one row each.
 *
 * The row is attributed to the **wheel**, not to the shell that carried it and
 * not to git: an arc ends on a server tick, having shelled nothing and having
 * committed nothing on the base. That attribution is what takes away the
 * `Shell` identifier and the `exit 0 · 0ms` end-state, neither of which was
 * ever true of this row.
 *
 * Everything on screen is parsed from the row itself, so the live append and
 * the ledger restore render byte-identically, and a parse miss falls back to
 * the generic block — the same discipline the commit and join receipts keep.
 * The summary string is the single source: formatted once, on the server, and
 * never rebuilt here.
 *
 * @module components/tugways/cards/session-arc-receipt-block
 */

import type React from "react";
import { useCallback, useContext, useSyncExternalStore } from "react";
import { GitBranch } from "lucide-react";

import { BlockChrome } from "@/components/tugways/blocks/block-chrome";
import { ToolBlockHistoryCollapse } from "@/components/tugways/blocks/collapse-context";
import { ArcLifecycleBlock } from "@/components/tugways/arc-lifecycle-block";
import { arcTrackModel } from "@/components/tugways/tug-arc-track";
import { formatDurationMs } from "@/components/tugways/cards/session-card-telemetry-renderers";
import { TugInlineDialog } from "@/components/tugways/tug-inline-dialog";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import { arcPressStore } from "@/lib/arc-press-store";
import { arcNoteParts } from "@/lib/arc-note-command";
import { CardIdContext } from "@/lib/card-id-context";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { formatTokensApprox } from "@/lib/code-session-store/compaction";
import { getConnection } from "@/lib/connection-singleton";
import { useCardJoinReadyArc } from "@/lib/code-session-store/use-session-phase";
import { useCitedSession } from "@/lib/session-citation-store";
import { useSessionUsage } from "@/lib/session-usage-store";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import {
  registerCommandBlock,
  type CommandBlockProps,
  type CommandBlockPresentation,
} from "./session-command-block-registry";
import { ArcNoteLine } from "./session-arc-note-block";
import { ShellExchangeBlock } from "./shell-exchange-block";
import "./session-arc-receipt-block.css";

/**
 * One stage line of the record: `<stage> · <model> · <claude session id>`.
 *
 * The server writes the literal `account default` where the config declared no
 * model, so the absence is already a word by the time it arrives and is never
 * reconstructed here.
 */
export interface ArcReceiptStage {
  stage: string;
  model: string;
  sessionId: string;
}

/** The display facts parsed from an arc receipt, complete or stopped. */
export interface ParsedArcReceipt {
  outcome: "complete" | "stopped" | "resumed";
  arc: string;
  /** The document the arc opened on; absent on a record that had none. */
  document: string | null;
  stages: ArcReceiptStage[];
  /** The plan that came out; absent when the arc stopped before one existed. */
  plan: string | null;
  /**
   * A stop's stage, its sentence, whatever the stage said for itself, and
   * whether the arc it stopped is over.
   *
   * `said` is the `arc ask` question a `NeedsDecision` stop carries — the
   * stage's own words, written as the record's last note and read back
   * beneath the header. It is the row's tail, and it is why that stop needs
   * no answer affordance of its own ([B03]).
   *
   * `terminal` is read off the frozen sentence `there is nothing to resume`,
   * which the server writes for a discard and a join and for nothing else.
   * **No wire field carries this and none should**: the receipt is a record
   * of a past moment that has to still read correctly after a relaunch weeks
   * later, and its own text is the only thing a restored transcript has
   * ([B05]).
   */
  stop: {
    stage: string;
    reason: string;
    said: string | null;
    terminal: boolean;
  } | null;
  /**
   * A pick-up's stage and the fact that undid the stop, or `null` on the other
   * two outcomes.
   *
   * The stage is on the receipt's own header rather than looked up, and it has
   * to be: `trackModelFor` cannot build an identity strip without one, and a
   * receipt is a frozen record of a past moment with no live store to ask —
   * the same reason `terminal` is read off a frozen sentence rather than
   * carried on the wire.
   */
  resumed: { stage: string; moved: string } | null;
}

// The two headers, matched exactly. `·` is U+00B7 and the em arc U+2014, so a
// hand-typed line never false-parses into a receipt — the discipline the join
// and commit receipts keep, for the same reason.
const COMPLETE_RE = /^arc complete · (.+)$/;
const STOPPED_RE = /^arc stopped · (.+?) · in (.+?) — (.+)$/;
/**
 * The third header: a silence-judged stop that the stopped stage itself
 * contradicted. Tried **before** `STOPPED_RE`, which it cannot collide with —
 * the two differ in their second word — but ordering the more specific first
 * is the discipline that keeps a fourth header from having to think about it.
 */
const RESUMED_RE = /^arc picked back up · (.+?) · in (.+?) · (.+)$/;
/**
 * A stage line, keyed on the closed stage vocabulary rather than on the shape
 * of a session id. `ArcStage::as_str` is the whole set, and matching it is what
 * keeps `opened on …` and `plan …` from ever being read as stages — a receipt
 * cannot grow a fourth field, but a model name or an id format can change.
 */
const STAGE_RE = /^(devise|review|implement|audit) · (.+) · (\S+)$/;
/**
 * The one sentence a stop receipt writes when the arc is over. Matched
 * exactly — it is the marker, not a phrase to search within.
 */
const TERMINAL_LINE = "there is nothing to resume";
/**
 * The line a stop receipt used to close with, before the resume became a
 * button in this block ([B01]). Recognized so that a receipt already in a
 * shell ledger — which replays on every card reload, and which nothing
 * rewrites — is not read as something the stage said, and so the command the
 * user asked never to see again does not survive in the rows that predate the
 * change.
 */
const LEGACY_RESUME_RE = /^resume with tugtool arc run \S+$/;

export function parseArcReceipt(output: string): ParsedArcReceipt | null {
  const lines = output.split("\n");
  const head = lines[0] ?? "";
  const resumed = RESUMED_RE.exec(head);
  const stopped = resumed === null ? STOPPED_RE.exec(head) : null;
  const complete = resumed === null && stopped === null ? COMPLETE_RE.exec(head) : null;
  if (resumed === null && stopped === null && complete === null) return null;

  const parsed: ParsedArcReceipt = {
    outcome: resumed !== null ? "resumed" : stopped !== null ? "stopped" : "complete",
    arc: (resumed?.[1] ?? (stopped !== null ? stopped[1] : complete?.[1])) ?? "",
    document: null,
    stages: [],
    plan: null,
    stop:
      stopped !== null
        ? {
            stage: stopped[2] ?? "",
            reason: stopped[3] ?? "",
            said: null,
            terminal: false,
          }
        : null,
    resumed:
      resumed !== null
        ? { stage: resumed[2] ?? "", moved: resumed[3] ?? "" }
        : null,
  };

  for (const line of lines.slice(1)) {
    if (line.startsWith("opened on ")) {
      parsed.document = line.slice("opened on ".length);
      continue;
    }
    if (line.startsWith("plan ")) {
      parsed.plan = line.slice("plan ".length);
      continue;
    }
    const stage = STAGE_RE.exec(line);
    if (stage !== null) {
      parsed.stages.push({
        stage: stage[1] ?? "",
        model: stage[2] ?? "",
        sessionId: stage[3] ?? "",
      });
      continue;
    }
    if (parsed.stop !== null && line === TERMINAL_LINE) {
      parsed.stop.terminal = true;
      continue;
    }
    if (parsed.stop !== null && LEGACY_RESUME_RE.test(line)) continue;
    // Whatever else the stop wrote after its header is the stage's own words,
    // which carry no marker — the two marked lines above and the terminal
    // sentence are all eligible to be something else first.
    if (parsed.stop !== null && parsed.stop.said === null && line.length > 0) {
      parsed.stop.said = line;
    }
  }
  return parsed;
}

/**
 * The tone the block wears, one arm per outcome.
 *
 * Keyed on `stopped` rather than on `complete`, so a third outcome is not an
 * error by default: `error` says *do something about this*, and an arc that
 * picked itself back up needs nothing done about it. A demoted stop is `idle`
 * because the row has been answered and there is nothing left to do either.
 *
 * Pure and exported, so the tone is a table test rather than a rendering.
 */
export function arcReceiptPhase(
  parsed: ParsedArcReceipt,
  demoted: boolean,
): "idle" | "error" | "success" {
  if (demoted) return "idle";
  return parsed.outcome === "stopped" ? "error" : "success";
}

/**
 * The strip the receipt leads with.
 *
 * A finished arc reads as arrived — its last stage is behind it and the join
 * is what is left — so it is driven by `audited`, the stage the audit's mark
 * leaves. A stopped arc rests on the stage it stopped in and carries the
 * reason, which is what paints the strip's stopped tone.
 *
 * A **picked-back-up** arc is neither: it is running again, in the stage the
 * header names, with no `stopped` and no `done` — which is exactly what makes
 * `arcRunning` read true and paints the strip as work in progress. Named
 * rather than left to fall through, because falling through would draw a
 * pick-up as an arc the audit had finished.
 *
 * Exported for the same reason `shouldOfferResume` is: the deck's tests are
 * pure-logic `bun:test` with no fake DOM, so a reader only the JSX reaches is
 * a reader nothing can assert.
 */
export function trackModelFor(parsed: ParsedArcReceipt): ReturnType<typeof arcTrackModel> {
  const documents = recordDocuments(parsed.document, parsed.plan);
  if (parsed.outcome === "resumed") {
    return arcTrackModel({
      documents,
      arc: { stage: parsed.resumed?.stage ?? "implement" },
    });
  }
  if (parsed.outcome === "stopped") {
    return arcTrackModel({
      documents,
      arc: { stage: parsed.stop?.stage ?? "review", stopped: parsed.stop?.reason },
    });
  }
  return finishedArcTrackModel(parsed.document, parsed.plan);
}

/**
 * Which of the two documents an arc's record names, keyed on the filename the
 * devise stage writes. A `brief.md` is a brief and anything else is not — the
 * same reading `trackModelFor` has always taken, lifted out so the finished
 * arm below and the caller above cannot spell it two ways.
 */
function recordDocuments(
  document: string | null,
  plan: string | null,
): { brief?: string; plan?: string } {
  return document !== null && document.endsWith("brief.md")
    ? { brief: document, plan: plan ?? undefined }
    : { plan: plan ?? undefined };
}

/**
 * The strip for an arc that **finished** — rested on the audit, done, with
 * the audit's own mark as the stage.
 *
 * Exported because the join boundary folds the same record and wears the same
 * strip over it ([B02]), and it has no `ParsedArcReceipt` to hand
 * `trackModelFor`: a join receipt is a join receipt. An arc that reached a
 * join is finished by construction, so the complete arm is the whole of what
 * that caller needs.
 */
export function finishedArcTrackModel(
  document: string | null,
  plan: string | null,
): ReturnType<typeof arcTrackModel> {
  return arcTrackModel({
    documents: recordDocuments(document, plan),
    arc: { stage: "audit", done: true },
    stage: "audited",
  });
}

/**
 * Whether this row should end with the offer to pick the arc back up ([B04]).
 *
 * Three facts, and **all three come from the row itself**. The receipt has to
 * be a stop; the transcript must not already carry a later row answering it
 * ([F04]); and the stop must not be one of the two that end the arc, which the
 * frozen terminal sentence is the marker of ([B05]).
 *
 * There is deliberately no fourth fact asking whether the arc is *still*
 * stopped, because the only way to ask is a live store and a receipt may not
 * read the present into a row that reports a past ([F05]). What makes that
 * safe is the server: a resume on an arc carrying no stop binds and writes
 * nothing, so the worst case — an arc something else already resumed, still
 * fronting a button here — is a press that changes nothing ([B06]).
 *
 * Pure, and exported for the test suite.
 */
export function shouldOfferResume(
  parsed: ParsedArcReceipt,
  superseded: boolean | undefined,
): boolean {
  return (
    parsed.outcome === "stopped" &&
    parsed.stop !== null &&
    !parsed.stop.terminal &&
    superseded !== true
  );
}

/**
 * A stage's trailing cell: what the stage cost, as tokens and active time.
 *
 * The cell used to print the stage's claude session id. That id is a join key
 * — nobody's name for anything — and even resolved it would read the same on
 * every row of an arc, naming the card the reader is already looking at. So it
 * stays exactly where it was in the record, in the log and in the receipt's
 * own text, and becomes the *lookup* instead of the ink: `sessions` is keyed by
 * segment, a stage IS a segment, and the two facts that differ per stage are
 * how much the model consumed and how long the agent worked. The pair is the
 * app's own idiom for a finished unit of agent work — the agent footer prints
 * it, and both figures are formatted by the same functions it uses.
 *
 * The ask goes through the citation store, which batches the receipt's several
 * ids into one `resolve_sessions` and never re-asks an answered one; the answer
 * lands in `sessionUsageStore`, which the live telemetry push keeps current
 * while a stage is still running.
 *
 * **A missing figure is a state, not a gap.** Until the ledger answers, and for
 * a segment that genuinely recorded no telemetry, the cell is empty — the stage
 * and the model stand as they always did. A `0 tokens` here would be a claim
 * the app cannot make.
 *
 * Its own component because of the hooks, the same reason `ArcResumeOffer` is.
 */
function ArcReceiptStageUsage({ sessionId }: { sessionId: string }): React.ReactElement {
  // Asking is the citation store's job. The answer also hands back the FULL id
  // for an ask that was short — the receipt writes full ones, but reading the
  // resolved id rather than the asked one is what keeps that a fact about the
  // record rather than an assumption.
  const cited = useCitedSession(sessionId);
  const usage = useSessionUsage(
    cited.status === "found" ? cited.sessionId : sessionId,
  );
  return (
    <span className="arc-receipt-stage-session" data-slot="arc-receipt-stage-usage">
      {usage === undefined
        ? null
        : `${formatTokensApprox(usage.tokens)} · ${formatDurationMs(usage.activeMs)}`}
    </span>
  );
}

/**
 * The arc's record as rows: the document it opened on, one row per stage with
 * its model and what it cost, and the plan that came out.
 *
 * **One spelling, two seats.** This is the body of the `/arc-run` receipt and
 * it is also what folds behind the `Joined` boundary once the arc lands
 * ([B02]) — the record does not change because it moved, so a second
 * composition of it would be the same rows drifting apart one edit at a time.
 * The class names come with it, which is what keeps `session-arc-receipt-block.css`
 * the one stylesheet either seat reads.
 *
 * The three parts are independently optional, exactly as the record's own
 * lines are: an arc that opened on nothing, walked no stage, or produced no
 * plan writes the rest and omits that one.
 */
export function ArcRecordBlock({
  document,
  stages,
  plan,
}: {
  document: string | null;
  stages: ArcReceiptStage[];
  plan: string | null;
}): React.ReactElement {
  return (
    <>
      {document !== null ? (
        <p className="arc-receipt-doc" data-tugx-findable="">
          opened on <code>{document}</code>
        </p>
      ) : null}
      <ul className="arc-receipt-stages">
        {stages.map((stage) => (
          <li className="arc-receipt-stage" key={stage.sessionId}>
            <span className="arc-receipt-stage-word">{stage.stage}</span>
            <span className="arc-receipt-stage-model">{stage.model}</span>
            <ArcReceiptStageUsage sessionId={stage.sessionId} />
          </li>
        ))}
      </ul>
      {plan !== null ? (
        <p className="arc-receipt-doc" data-tugx-findable="">
          plan <code>{plan}</code>
        </p>
      ) : null}
    </>
  );
}

/**
 * The record's searchable text, in render order — the two lines
 * {@link ArcRecordBlock} marks findable.
 *
 * The stage rows are deliberately absent, on the landed-files list's terms:
 * a row's third cell is resolved asynchronously from the session ledger and is
 * empty until it answers, so a projected string carrying it would be a match
 * the painter reaches only sometimes.
 */
export function arcRecordFindParts({
  document,
  plan,
}: {
  document: string | null;
  plan: string | null;
}): string[] {
  const parts: string[] = [];
  if (document !== null) parts.push(`opened on ${document}`);
  if (plan !== null) parts.push(`plan ${plan}`);
  return parts;
}

/**
 * The offer's title. Exported so it can be pinned without rendering — the
 * deck's tests are pure-logic `bun:test` with no fake DOM, so a string only
 * the JSX holds is a string nothing can assert.
 */
export const ARC_RESUME_OFFER_TITLE = "Resume this arc";

/**
 * The finished row's Join label, and the `data-slot` its button wears.
 *
 * Exported for the same reason the resume title is: the deck's tests are
 * pure-logic `bun:test` with no fake DOM, so a string only the JSX holds is a
 * string nothing can assert.
 */
export const ARC_FINISH_JOIN_LABEL = "Join";
export const ARC_FINISH_JOIN_SLOT = "arc-finish-join";

/** `N stages`, singular when there is one. */
export function arcStagesPhrase(count: number): string {
  return `${count} ${count === 1 ? "stage" : "stages"}`;
}

/** The `data-slot` the finish's quiet line wears. */
export const ARC_FINISH_SLOT = "arc-finish-line";

/**
 * The finish as an arc gesture: the synthetic command its quiet line is read
 * from, and the sentence beside it ([B04]).
 *
 * **The shape is composed, the words are not invented.** `Finished · N
 * stages` is what the lifecycle strip said on this row before it became a
 * line, and what the join boundary's strip still says over the same record
 * ([B02]) — so the finish reads the same wherever the reader meets it.
 *
 * It goes through `arcNoteParts` rather than around it because the row is now
 * in the arc-note register, and a second composition of a register's row is
 * how two seats of one line come to disagree. `arc done <name>` is a command
 * nothing writes to the shell ledger: the finish already HAS its row — this
 * one — and admitting it to the arc-notes feed as well would paint a second
 * line for one event ([F09]).
 *
 * Pure and exported: the deck's tests are `bun:test` with no fake DOM.
 */
export function arcFinishNote(parsed: ParsedArcReceipt): {
  command: string;
  sentence: string;
} {
  return {
    command: `arc done ${parsed.arc}`,
    sentence: `${parsed.arc}: finished · ${arcStagesPhrase(parsed.stages.length)}`,
  };
}

/**
 * Which seat a `/arc-run` row takes, read off the row ([B04], [F08]).
 *
 * A finished arc is one derived sentence and takes the quiet seat every other
 * arc gesture has; a stop and a pick-up keep the entry, because they carry the
 * stage's own words and the Resume offer, which a quiet line cannot hold. A
 * row whose output does not parse falls through to `ShellExchangeBlock` and
 * takes the entry it would have had anyway.
 */
export function arcReceiptPresentation(
  message: ShellExchangeMessage,
): CommandBlockPresentation {
  return parseArcReceipt(message.output)?.outcome === "complete" ? "quiet" : "entry";
}

/**
 * The offer itself: `TugInlineDialog` carrying one **Resume**.
 *
 * **The title says what the button does** ([P11]). "Resume this arc" and a
 * `Resume` button are one gesture named once; the older "Pick this arc back
 * up" made the reader translate the title into the button before pressing it.
 *
 * **The primitive, not the scope** ([B02]). No `useInlineDialogScope`, and so
 * no focus trap, no scrim, no card-modality, no `CANCEL_DIALOG` responder. A
 * permission prompt blocks a turn and earns all of that; a stopped arc blocks
 * nothing, so the composer stays live and the button is an ordinary focusable
 * in the card's normal order.
 *
 * **One button, and no dismissal** ([B03]). A `Not now` would be mount-local
 * state for a row that scrolls away on its own, and the only exits from the
 * offer are pressing it and leaving it alone.
 *
 * Its own component because of the hooks: the block returns early on a row
 * that does not parse, and hooks may not be reached conditionally.
 */
function ArcResumeOffer({ arc }: { arc: string }): React.ReactElement {
  const cardId = useContext(CardIdContext);
  // The press, and nothing else — see `arcPressStore`'s own header on why a
  // receipt may subscribe to this and to nothing that would tell it whether
  // the arc is still stopped.
  const pending = useSyncExternalStore(
    arcPressStore.subscribe,
    () => arcPressStore.isPending(arc, "resume"),
    () => false,
  );
  const resume = useCallback((): void => {
    // The `/arc-bind` precedent: a surface that needs a binding returns
    // silently when the store has none.
    const binding = cardId === null ? undefined : cardSessionBindingStore.getBinding(cardId);
    if (binding === undefined) return;
    // And the press is raised only once the frame is actually going out. A
    // held button waits for an answer, and a frame nobody sent is answered by
    // nothing — greying the control forever is the dead button this whole
    // offer exists to avoid.
    const connection = getConnection();
    if (connection === null) return;
    arcPressStore.press(arc, "resume", binding.tugSessionId);
    connection.sendControlFrame("arc_resume", {
      tug_session_id: binding.tugSessionId,
      project_dir: binding.projectDir,
      arc,
    });
  }, [arc, cardId]);
  return (
    <TugInlineDialog
      icon={<GitBranch />}
      title={ARC_RESUME_OFFER_TITLE}
      className="arc-receipt-resume"
      actions={
        <TugPushButton
          emphasis="primary"
          role="action"
          size="xs"
          disabled={pending}
          onClick={resume}
        >
          Resume
        </TugPushButton>
      }
    />
  );
}

/**
 * The finished row, and — while the offer stands — the act it calls for
 * ([B04]).
 *
 * **It performs no join.** The press routes through this card's one reveal
 * path ([D152]): the same `REVEAL_CHANGES` the Z2 ARC placard and the Arcs
 * card row send, which opens the Changes room armed and, on a folded card,
 * opens the fold first ([B07]). The join itself has one act and it lives in
 * Z5; this button takes the reader to it. A second place to press Join would
 * be a second join.
 *
 * **This is the one live reading a receipt makes**, and it is deliberate. Every
 * other fact on this row is parsed from the bytes the server wrote, because a
 * receipt reports a past moment and has to still read correctly after a
 * relaunch weeks later. An *offer* is not a fact about that moment — it is the
 * standing state of the work the moment named, and an offer that has been
 * taken, discarded or reopened is gone ([B09]). Painting a Join over one would
 * be exactly the lie the frozen-record rule exists to prevent, so the button
 * is gated on the live register instead: present while the offer stands, gone
 * the instant the head is spent.
 *
 * Matched by NAME, not merely by presence: this row reports one arc and the
 * card may have moved on to another since, and the Join must be about the arc
 * the row is about.
 *
 * Its own component because of the hooks, the same reason `ArcResumeOffer` is.
 */
function ArcFinishLine({
  parsed,
  atMs,
}: {
  parsed: ParsedArcReceipt;
  atMs: number;
}): React.ReactElement {
  const finish = arcFinishNote(parsed);
  const cardId = useContext(CardIdContext);
  const readyArc = useCardJoinReadyArc(cardId);
  const chain = useResponderChain();
  const join = useCallback((): void => {
    const target = `${cardId}-card-content`;
    if (cardId === null || chain === null || !chain.hasResponder(target)) return;
    chain.sendToTarget(target, {
      action: TUG_ACTIONS.REVEAL_CHANGES,
      phase: "discrete",
    });
  }, [chain, cardId]);
  const line = (
    <ArcNoteLine
      command={finish.command}
      sentence={finish.sentence}
      atMs={atMs}
      className="session-arc-note-line"
      slot={ARC_FINISH_SLOT}
    />
  );
  // No offer, no wrapper: the ordinary finished row is byte-for-byte the row it
  // has always been, and the layout that carries a button exists only on the
  // rows that have one.
  if (readyArc === null || readyArc !== parsed.arc) return line;
  return (
    <div className="arc-finish-row" data-slot="arc-finish-row">
      {line}
      <TugPushButton
        emphasis="primary"
        role="action"
        size="xs"
        data-slot={ARC_FINISH_JOIN_SLOT}
        onClick={join}
      >
        {ARC_FINISH_JOIN_LABEL}
      </TugPushButton>
    </div>
  );
}

export function SessionArcReceiptBlock(props: CommandBlockProps): React.ReactElement {
  const parsed = parseArcReceipt(props.message.output);
  if (parsed === null) return <ShellExchangeBlock {...props} />;
  // A finished arc is a quiet line, not a receipt ([B04]). The record it used
  // to carry is not lost: it folds behind the `Joined` boundary once the arc
  // lands ([B02]), and until then it is the Arcs card's. What is left here is
  // the moment itself, in the register every other arc gesture reads in.
  if (parsed.outcome === "complete") {
    return <ArcFinishLine parsed={parsed} atMs={props.message.startedAtMs} />;
  }
  // A stop a later row in this transcript has already answered ([P08]). The
  // row is **demoted, never rewritten**: `copyText`, the stage list, the
  // document lines and the stop's own tail are byte-identical to what the
  // server wrote, sitting in a body that arrives folded. A receipt is a frozen
  // record of that moment, so what changes is how loudly it is offered —
  // `error` says *do something about this*, and there is nothing left to do.
  const demoted = props.superseded === true && parsed.outcome === "stopped";
  // The row's note, one arm per outcome, in the line's own grammar — the same
  // vocabulary the strip beside it reads in ([B08]). It is an override rather
  // than the line's own derivation because a receipt is a frozen record: its
  // three outcomes are parsed from the text the server wrote, and no live
  // model can be asked what an arc was doing weeks ago.
  //
  // A pick-up's `stop` is `null`, so the stopped arm's `?? "stopped"` would
  // label a row saying the arc is running again with the word *stopped* —
  // the fall-through this arm exists to stop.
  //
  // There is no complete arm: that outcome left above, as a quiet line.
  const note =
    parsed.outcome === "resumed"
      ? "Picked back up"
      : `Stopped · ${parsed.stop?.reason ?? "stopped"}`;
  const identity = (
    <span className="arc-receipt-identity">
      <ArcLifecycleBlock
        name={parsed.arc}
        worker={null}
        model={trackModelFor(parsed)}
        note={note}
        layout="row"
      />
    </span>
  );
  return (
    <ToolBlockHistoryCollapse
      toolUseId={props.message.exchangeId}
      defaultCollapsed={demoted}
    >
      <BlockChrome
        rootSlot="arc-receipt-block"
        variant="receipt"
        identity={identity}
        phase={arcReceiptPhase(parsed, demoted)}
        status="ready"
        copyText={props.message.output}
      >
        <div className="arc-receipt-body">
          {parsed.resumed !== null ? (
            <p className="arc-receipt-doc" data-tugx-findable="">
              {parsed.resumed.moved}
            </p>
          ) : null}
          <ArcRecordBlock
            document={parsed.document}
            stages={parsed.stages}
            plan={parsed.plan}
          />
          {parsed.stop?.said != null ? (
            <p className="arc-receipt-tail" data-tugx-findable="">
              {parsed.stop.said}
            </p>
          ) : null}
          {parsed.stop?.terminal === true ? (
            <p className="arc-receipt-tail" data-tugx-findable="">
              {TERMINAL_LINE}
            </p>
          ) : null}
          {shouldOfferResume(parsed, props.superseded) ? (
            <ArcResumeOffer arc={parsed.arc} />
          ) : null}
        </div>
      </BlockChrome>
    </ToolBlockHistoryCollapse>
  );
}

/**
 * Claims `/arc-run`, the one command `useLandingReceipts` writes for an arc —
 * and `/dash-arc`, the command it wrote under the retired name. Those rows are
 * in the shell ledger and replay on every card reload, so dropping the retired
 * spelling would turn every arc ending already recorded back into a raw shell
 * row ([F19], `tuglaws/work-grammar.md`).
 */
export function matchesArcReceipt(command: string): boolean {
  return (
    command === "/arc-run" ||
    command.startsWith("/arc-run ") ||
    command === "/dash-arc" ||
    command.startsWith("/dash-arc ")
  );
}

/**
 * The arc receipt's searchable text, in render order: the arc, the stage
 * words, then the document lines — exactly the containers this block marks
 * findable. `null` when the output does not parse, because the row renders as
 * a plain exchange then and projects as one.
 *
 * The session atoms are deliberately absent: a truncated id is not text
 * anybody searches for, and projecting it would put eight hex characters into
 * the index for every stage of every arc.
 *
 * A **finished** arc projects the quiet line instead, and projects it the way
 * {@link ArcNoteLine} paints it: one unit for the label node, whose bytes are
 * the name and the verb with one space between them. There is no subject on
 * this gesture, so there is no second unit — the declare-both-halves rule read
 * off the same `arcNoteParts` the row renders from.
 */
export function arcReceiptFindParts(message: ShellExchangeMessage): string[] | null {
  const parsed = parseArcReceipt(message.output);
  if (parsed === null) return null;
  if (parsed.outcome === "complete") {
    const finish = arcFinishNote(parsed);
    const { name, label, subject } = arcNoteParts(finish.command, finish.sentence);
    return [[name, label].filter((part) => part !== null).join(" "), subject ?? ""].filter(
      (part) => part !== "",
    );
  }
  const parts = [parsed.arc, ...parsed.stages.map((stage) => stage.stage)];
  if (parsed.stop !== null) {
    parts.push(parsed.stop.reason);
    if (parsed.stop.said !== null) parts.push(parsed.stop.said);
    if (parsed.stop.terminal) parts.push(TERMINAL_LINE);
  }
  if (parsed.document !== null) parts.push(parsed.document);
  if (parsed.plan !== null) parts.push(parsed.plan);
  return parts.filter((part) => part !== "");
}

// Registration is a side effect of importing this module — the import sits
// beside the commit and join blocks' in `session-card-transcript.tsx`, so all
// three are registered before the first resolve.
registerCommandBlock("arc-run-receipt", matchesArcReceipt, SessionArcReceiptBlock, {
  attribution: "wheel",
  presentation: arcReceiptPresentation,
  findParts: arcReceiptFindParts,
});
