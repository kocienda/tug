/**
 * `SessionArcReceiptBlock` — the bespoke `/dash-arc` command-block renderer
 * ([P12]).
 *
 * A dash arc's ending leaves one shell-exchange row whose `output` is the
 * server-formatted record — `format_arc_receipt` for an arc that finished,
 * `format_arc_stop_receipt` for one that stopped. This renderer parses that
 * string and presents it as a receipt instead of the generic fenced
 * `ShellExchangeBlock`.
 *
 * **It leads with the track**, which is the whole design. `ArcLifecycleLine`
 * is the second line of {@link ArcLifecycleBlock}, already worn by the Arcs card's
 * Arcs section, the Changes shade's collapsed row, and the masthead placard;
 * a reader who learned the strip on any of those has learned this row for
 * free. The stages the arc actually walked go underneath, one row each.
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

import { BlockChrome } from "@/components/tugways/blocks/block-chrome";
import { ToolBlockHistoryCollapse } from "@/components/tugways/blocks/collapse-context";
import { ArcLifecycleLine } from "@/components/tugways/arc-lifecycle-line";
import { TugAtomRef } from "@/components/tugways/tug-atom-ref";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { arcTrackModel } from "@/components/tugways/tug-arc-track";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import {
  registerCommandBlock,
  type CommandBlockProps,
} from "./session-command-block-registry";
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
  outcome: "complete" | "stopped";
  dash: string;
  /** The document the arc opened on; absent on a record that had none. */
  document: string | null;
  stages: ArcReceiptStage[];
  /** The plan that came out; absent when the arc stopped before one existed. */
  plan: string | null;
  /** A stop's stage, its sentence, and what resumes it. */
  stop: { stage: string; reason: string; next: string } | null;
}

// The two headers, matched exactly. `·` is U+00B7 and the em dash U+2014, so a
// hand-typed line never false-parses into a receipt — the discipline the join
// and commit receipts keep, for the same reason.
const COMPLETE_RE = /^arc complete · (.+)$/;
const STOPPED_RE = /^arc stopped · (.+?) · in (.+?) — (.+)$/;
/**
 * A stage line, keyed on the closed stage vocabulary rather than on the shape
 * of a session id. `ArcStage::as_str` is the whole set, and matching it is what
 * keeps `opened on …` and `plan …` from ever being read as stages — a receipt
 * cannot grow a fourth field, but a model name or an id format can change.
 */
const STAGE_RE = /^(devise|review|implement|audit) · (.+) · (\S+)$/;

export function parseArcReceipt(output: string): ParsedArcReceipt | null {
  const lines = output.split("\n");
  const head = lines[0] ?? "";
  const stopped = STOPPED_RE.exec(head);
  const complete = stopped === null ? COMPLETE_RE.exec(head) : null;
  if (stopped === null && complete === null) return null;

  const parsed: ParsedArcReceipt = {
    outcome: stopped !== null ? "stopped" : "complete",
    dash: (stopped !== null ? stopped[1] : complete?.[1]) ?? "",
    document: null,
    stages: [],
    plan: null,
    stop:
      stopped !== null
        ? { stage: stopped[2] ?? "", reason: stopped[3] ?? "", next: "" }
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
    // A stop's second line is its resume sentence, which carries no marker of
    // its own — it is whatever the stop receipt wrote after the header.
    if (parsed.stop !== null && parsed.stop.next === "" && line.length > 0) {
      parsed.stop.next = line;
    }
  }
  return parsed;
}

/**
 * The strip the receipt leads with.
 *
 * A finished arc reads as arrived — its last stage is behind it and the join
 * is what is left — so it is driven by `audited`, the stage the audit's mark
 * leaves. A stopped arc rests on the stage it stopped in and carries the
 * reason, which is what paints the strip's stopped tone.
 */
function trackModelFor(parsed: ParsedArcReceipt): ReturnType<typeof arcTrackModel> {
  const documents =
    parsed.document !== null && parsed.document.endsWith("brief.md")
      ? { brief: parsed.document, plan: parsed.plan ?? undefined }
      : { plan: parsed.plan ?? undefined };
  if (parsed.outcome === "stopped") {
    return arcTrackModel({
      documents,
      arc: { stage: parsed.stop?.stage ?? "review", stopped: parsed.stop?.reason },
    });
  }
  return arcTrackModel({
    documents,
    arc: { stage: "audit", done: true },
    stage: "audited",
  });
}

export function SessionArcReceiptBlock(props: CommandBlockProps): React.ReactElement {
  const parsed = parseArcReceipt(props.message.output);
  if (parsed === null) return <ShellExchangeBlock {...props} />;
  // A stop a later row in this transcript has already answered ([P08]). The
  // row is **demoted, never rewritten**: `copyText`, the stage list, the
  // document lines and the resume sentence are byte-identical to what the
  // server wrote, sitting in a body that arrives folded. A receipt is a frozen
  // record of that moment, so what changes is how loudly it is offered —
  // `error` says *do something about this*, and there is nothing left to do.
  const demoted = props.superseded === true && parsed.outcome === "stopped";
  const identity = (
    <span className="arc-receipt-identity">
      <TugArcAtom name={parsed.dash} />
      <ArcLifecycleLine
        model={trackModelFor(parsed)}
        note={
          parsed.outcome === "complete"
            ? `${parsed.stages.length} ${parsed.stages.length === 1 ? "stage" : "stages"}`
            : (parsed.stop?.reason ?? "stopped")
        }
        size="read"
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
        phase={demoted ? "idle" : parsed.outcome === "complete" ? "success" : "error"}
        status="ready"
        copyText={props.message.output}
      >
        <div className="arc-receipt-body">
          {parsed.document !== null ? (
            <p className="arc-receipt-doc" data-tugx-findable="">
              opened on <code>{parsed.document}</code>
            </p>
          ) : null}
          <ul className="arc-receipt-stages">
            {parsed.stages.map((stage) => (
              <li className="arc-receipt-stage" key={stage.sessionId}>
                <span className="arc-receipt-stage-word">{stage.stage}</span>
                <span className="arc-receipt-stage-model">{stage.model}</span>
                <span className="arc-receipt-stage-session">
                  <TugAtomRef entity={{ kind: "session", id: stage.sessionId }} />
                </span>
              </li>
            ))}
          </ul>
          {parsed.plan !== null ? (
            <p className="arc-receipt-doc" data-tugx-findable="">
              plan <code>{parsed.plan}</code>
            </p>
          ) : null}
          {parsed.stop !== null && parsed.stop.next.length > 0 ? (
            <p className="arc-receipt-next" data-tugx-findable="">
              {parsed.stop.next}
            </p>
          ) : null}
        </div>
      </BlockChrome>
    </ToolBlockHistoryCollapse>
  );
}

/** Claims `/dash-arc`, the one command `useLandingReceipts` writes for an arc. */
export function matchesArcReceipt(command: string): boolean {
  return command === "/dash-arc" || command.startsWith("/dash-arc ");
}

/**
 * The arc receipt's searchable text, in render order: the dash, the stage
 * words, then the document lines — exactly the containers this block marks
 * findable. `null` when the output does not parse, because the row renders as
 * a plain exchange then and projects as one.
 *
 * The session atoms are deliberately absent: a truncated id is not text
 * anybody searches for, and projecting it would put eight hex characters into
 * the index for every stage of every arc.
 */
export function arcReceiptFindParts(message: ShellExchangeMessage): string[] | null {
  const parsed = parseArcReceipt(message.output);
  if (parsed === null) return null;
  const parts = [parsed.dash, ...parsed.stages.map((stage) => stage.stage)];
  if (parsed.stop !== null) parts.push(parsed.stop.reason, parsed.stop.next);
  if (parsed.document !== null) parts.push(parsed.document);
  if (parsed.plan !== null) parts.push(parsed.plan);
  return parts.filter((part) => part !== "");
}

// Registration is a side effect of importing this module — the import sits
// beside the commit and join blocks' in `session-card-transcript.tsx`, so all
// three are registered before the first resolve.
registerCommandBlock("dash-arc-receipt", matchesArcReceipt, SessionArcReceiptBlock, {
  attribution: "wheel",
  findParts: arcReceiptFindParts,
});
