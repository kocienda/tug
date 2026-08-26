/**
 * spike-arc-receipt.tsx — what should a finished dash arc look like when it
 * lands in the transcript?
 *
 * Today an arc's ending is a `/dash-arc` shell row: the server's terminal
 * receipt (`format_arc_receipt` in `dash_arc_runner.rs`) rendered as
 * monospace stdout inside a generic `ShellExchangeBlock`, because no bespoke
 * renderer has ever claimed the command. Every other landing on that ledger —
 * `/commit`, `/dash-join`, `/dash-discard` — has one. The arc is the only
 * landing still reading as shell output, and it is the one with the most to
 * say: three claudes, three models, one document in, one plan out.
 *
 * The receipt string stays exactly as it is. It is the single source ([P07]),
 * it is what a relaunch replays weeks later, and it is what `copyText` writes.
 * The only question here is what the deck DRAWS from it, so every treatment
 * below runs the same `parseArcReceipt` over the same real summaries, and a
 * parse miss falls through to today's block — the discipline the commit and
 * join receipts already keep.
 *
 * Three things this spike is arguing for, beyond the frame:
 *
 *   1. **The document and the plan are file atoms, not words.** They are the
 *      arc's two ends and the two things a reader wants to open. `TugAtomRef`
 *      makes them openable — which the receipt's own paths cannot be, because
 *      they are repo-relative and only the row's `cwd` can resolve them.
 *   2. **The dash wears its sigil.** `DashSigil atom` is the settled spelling
 *      of a dash's name; the receipt writing a bare word is exactly the
 *      inconsistency the standing rule exists to prevent.
 *   3. **The stage uuids are session citations, not commit shas.** They name
 *      the claudes the arc rotated through — `ArcStageLine` reads them out of
 *      the `arc-stage` note — so `TugSessionCitation` is the atom, and it
 *      already knows how to render one the ledger can no longer find, which
 *      is what a receipt read weeks later is supposed to hit.
 *
 * The receipt's two paths and its resume command are all **clickable through
 * the annotation registry**, which is what makes them worth drawing as atoms
 * at all: `useAnnotationClicks` installs the same delegation the transcript
 * host does, so a file opens in the editor and the resume seeds the composer.
 *
 * @module spikes/spike-arc-receipt
 */

import "./spike.css";
import "./spike-arc-receipt.css";

import React, { useId, useLayoutEffect, useRef, useState } from "react";
import {
  BookOpen,
  Hammer,
  ListChecks,
  PencilRuler,
  RotateCw,
  Stamp,
  type LucideIcon,
} from "lucide-react";

import { BlockChrome } from "@/components/tugways/blocks/block-chrome";
import { DashSigil } from "@/components/tugways/dash-sigil";
import { ShellExchangeBlock } from "@/components/tugways/cards/shell-exchange-block";
import { TugAtomRef } from "@/components/tugways/tug-atom-ref";
import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import { TugMetaRun } from "@/components/tugways/tug-meta-run";
import { TugSessionCitation } from "@/components/tugways/tug-session-identity";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { annotationFromEvent } from "@/lib/annotator/annotation-element";
import { dataAttributesForPayload } from "@/lib/annotator/payloads";
import {
  annotationEntryFor,
  type AnnotationDispatchContext,
} from "@/lib/annotator/registry";
import { ANNOTATION_CLASS } from "@/lib/annotator/types";
import type { CommandBlockProps } from "@/components/tugways/cards/session-command-block-registry";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// Fixtures — real `format_arc_receipt` / `format_arc_stop_receipt` output
// ---------------------------------------------------------------------------

/** The dir the receipts' relative paths resolve against, as the ledger row carries it. */
const FIXTURE_ROOT = "/Users/kocienda/Mounts/u/src/tugtool";

/** The arc from the screenshot that started this: three stages, plan out. */
const COMPLETE_SUMMARY =
  "arc complete · interruption\n" +
  "opened on dash/interruption-brief.md\n" +
  "devise · opus[1m] · 62861e01-796a-4321-9b87-06eebb9fd3d9\n" +
  "review · opus · 752ab40f-cd91-4a4a-9457-b3b1e4eda01c\n" +
  "implement · opus · c9522c6b-4bf4-4b03-9b06-965628e0ee53\n" +
  "plan dash/interruption.md";

/**
 * The floor case, from `dash_arc_runner.rs`'s own table test: no document, no
 * plan, and a stage that ran on the account default. Every optional line of the
 * format is absent at once, which is the shape a treatment has to survive.
 */
const MINIMAL_SUMMARY = "arc complete · foo\ndevise · account default · claude-a";

/** A stop, which is not a completion and must not read as one ([P12]). */
const STOPPED_SUMMARY =
  "arc stopped · conductor · in review — two review rounds ended without stamping the plan\n" +
  "resume with tugutil dash run conductor";

// ---------------------------------------------------------------------------
// The parse — the candidate for `session-arc-receipt-block.tsx`
// ---------------------------------------------------------------------------

/** One rotation the arc made: which stage, on which model, as which claude. */
export interface ArcStageLine {
  stage: string;
  /** The receipt's word — `"account default"` when the project named no model. */
  model: string;
  sessionId: string;
}

export interface ParsedArcComplete {
  kind: "complete";
  dash: string;
  /** The `opened on` path, repo-relative. Absent for an arc opened on nothing. */
  document: string | null;
  stages: ArcStageLine[];
  /** The `plan` path, repo-relative. Absent when the arc produced none. */
  plan: string | null;
}

export interface ParsedArcStop {
  kind: "stopped";
  dash: string;
  stage: string;
  /** `ArcStopReason::sentence()`, verbatim. */
  sentence: string;
  /** The `resume with …` line, or the "nothing to resume" one. */
  next: string;
}

export type ParsedArcReceipt = ParsedArcComplete | ParsedArcStop;

// `·` is U+00B7 and `—` U+2014, matched exactly, so a hand-typed dash never
// false-parses a shell row into a receipt.
const COMPLETE_HEAD_RE = /^arc complete · (\S+)$/;
const STOP_HEAD_RE = /^arc stopped · (\S+) · in (\S+) — (.+)$/;
const STAGE_RE = /^(devise|review|implement) · (.+) · (\S+)$/;

/** What a resumable stop leads its next-step line with. */
const RESUME_PREFIX = "resume with ";

/**
 * Parse an arc receipt, or `null` when the output is not one — a truncated
 * row, or a format older than this parser. The caller then renders the raw
 * output through the generic block rather than nothing.
 *
 * Every line after the header is claimed by its own **shape**, and an
 * unrecognized line is skipped rather than ending the parse. That is what
 * keeps every arc receipt already in JSONL parsing forever: a transcript
 * replays from its record on every card reload, so a parser reading `plan` at
 * a fixed index would orphan the plan of every past arc the moment a line was
 * added above it.
 */
export function parseArcReceipt(output: string): ParsedArcReceipt | null {
  const lines = output.split("\n");
  const first = lines[0] ?? "";

  const stopped = STOP_HEAD_RE.exec(first);
  if (stopped !== null) {
    return {
      kind: "stopped",
      dash: stopped[1],
      stage: stopped[2],
      sentence: stopped[3],
      next: (lines[1] ?? "").trim(),
    };
  }

  const head = COMPLETE_HEAD_RE.exec(first);
  if (head === null) return null;

  const parsed: ParsedArcComplete = {
    kind: "complete",
    dash: head[1],
    document: null,
    stages: [],
    plan: null,
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith("opened on ")) {
      parsed.document = line.slice("opened on ".length).trim();
      continue;
    }
    if (line.startsWith("plan ")) {
      parsed.plan = line.slice("plan ".length).trim();
      continue;
    }
    const stage = STAGE_RE.exec(line);
    if (stage !== null) {
      parsed.stages.push({ stage: stage[1], model: stage[2], sessionId: stage[3] });
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Stage vocabulary
// ---------------------------------------------------------------------------

/**
 * One glyph per row the receipt can draw — the three stages, and the three
 * things that are not stages but sit in the same rank: the document the arc
 * opened on, the plan it produced, and the resume a stop offers.
 *
 * Deliberately NOT `DASH_STAGE_ICONS` — that map is the dash *lifecycle*
 * (created / working / ready), a different vocabulary that happens to share
 * the word "stage". `implement` borrows the lifecycle's `Hammer` on purpose:
 * it is the same act, seen from the other side.
 */
const ROW_ICONS: Record<string, LucideIcon> = {
  devise: PencilRuler,
  review: Stamp,
  implement: Hammer,
  opened: BookOpen,
  plan: ListChecks,
  resume: RotateCw,
};

function RowGlyph({ row, size = 14 }: { row: string; size?: number }): React.ReactElement {
  const Icon = ROW_ICONS[row] ?? PencilRuler;
  return <Icon size={size} strokeWidth={2} aria-hidden="true" />;
}

/**
 * One row of the receipt: a glyph and a word, then whatever the row is about.
 *
 * Every row wears this — the ends, the stages, and a stop's resume alike. The
 * first pass drew the ends smaller and muted to say they were not stages, and
 * the difference read as two grades of importance rather than two kinds of
 * fact. What the rows actually share is more interesting than what separates
 * them: each names one thing the arc touched. The glyph is what says which
 * kind, and it says it in a column, where a reader takes it in without reading
 * a word.
 */
function ArcRow({
  row,
  label,
  children,
}: {
  row: string;
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      <span className="sp-arc-label" data-row={row}>
        <RowGlyph row={row} />
        {label}
      </span>
      <span className="sp-arc-value">{children}</span>
    </>
  );
}

/**
 * The claude a stage ran as, in the settled session-citation register.
 *
 * These uuids are **claude session ids**, not commit shas — `ArcStageLine` in
 * `tugdash-core/src/arc.rs` reads them straight out of the `arc-stage` note —
 * so the `commit:<8>` atom would be naming the wrong kind of thing. The
 * equivalent for a session is `TugSessionCitation`, which is the same move:
 * the ledger expands the short form, the atom shows whose session it was, and
 * a click raises that session's card when one is open.
 *
 * A stage's claude is usually retired by the time anybody reads the receipt,
 * and the citation already has the register for that — inert, idle dot, no
 * click offered. A receipt read weeks later is *supposed* to land there.
 */
function StageSession({ sessionId }: { sessionId: string }): React.ReactElement {
  return <TugSessionCitation citedId={sessionId} size="2xs" />;
}

/**
 * A command the receipt offers, in the register the transcript already uses to
 * advertise one: inline `<code>`, underlined, clickable.
 *
 * The annotation is stamped rather than detected. The content annotator finds
 * commands in *prose*, and needs a live catalog and resolvers to do it; this
 * string is not prose and needs no finding — the receipt knows exactly what it
 * is. So it wears the same `shell-command` payload the annotator would have
 * produced, which means the registry's own `primaryClick` services it: one
 * click seeds `tugutil dash run <dash>` into the composer's `$` route, ready
 * to send. Same contract, same gesture, no catalog.
 */
function ArcCommand({ command }: { command: string }): React.ReactElement {
  return (
    <code
      className={`sp-arc-command ${ANNOTATION_CLASS}`}
      data-slot="arc-receipt-command"
      data-tug-annotation="shell-command"
      data-tug-focus="refuse"
      data-no-activate=""
      {...dataAttributesForPayload({ kind: "shell-command", command })}
    >
      {command}
    </code>
  );
}

/**
 * Service a click on any annotation inside `ref` — the same delegation the
 * transcript host installs, scoped to this card.
 *
 * Without it the atoms are decoration: `TugAtomRef` and {@link ArcCommand}
 * stamp a real payload, but nothing outside a transcript is listening for it,
 * so a file that looked openable would do nothing. The registry decides what
 * each kind's click does, so this hook knows about none of them.
 *
 * [L03] the listener is registered in a layout effect, because the gesture it
 * services can arrive in the frame the card paints.
 */
function useAnnotationClicks(ref: React.RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const context: AnnotationDispatchContext = { activateCard: () => {} };
    const onClick = (event: MouseEvent): void => {
      if (event.button !== 0 || event.metaKey || event.shiftKey) return;
      const hit = annotationFromEvent(event);
      if (hit === null) return;
      const selection = window.getSelection();
      if (selection !== null && !selection.isCollapsed) return;
      annotationEntryFor(hit.payload.kind)?.primaryClick?.(hit.payload, context);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [ref]);
}

/** A repo-relative path from the receipt, as an openable file atom. */
function ArcPathAtom({ path, root }: { path: string; root: string }): React.ReactElement {
  return <TugAtomRef entity={{ kind: "file", path: `${root}/${path}` }} data-slot="arc-receipt-path" />;
}

// ---------------------------------------------------------------------------
// Treatment A — the score
// ---------------------------------------------------------------------------

/**
 * The arc read top to bottom as what it was: a document in, three movements,
 * a plan out.
 *
 * Five {@link ArcRow}s in one grid, all in the same rank: the document, the
 * three stages, the plan. Each is two cells — a glyph-led label and its value
 * — so every atom and every stage run starts on one left axis and the five
 * glyphs stack into a spine down the label column. What kind of row it is, the
 * glyph says; a receipt that also drew a border or dropped a size to say it
 * would be spending ink on a fact already carried.
 *
 * The grid is the parent, so a row emits bare cells rather than a wrapper — a
 * wrapper per row would need `display: contents` to stay out of the alignment,
 * which is a thing to get wrong for no gain.
 */
function ArcScore({ parsed, root }: { parsed: ParsedArcComplete; root: string }): React.ReactElement {
  return (
    <div className="sp-arc-rows" data-slot="arc-receipt-score">
      {parsed.document !== null ? (
        <ArcRow row="opened" label="opened on">
          <ArcPathAtom path={parsed.document} root={root} />
        </ArcRow>
      ) : null}
      {parsed.stages.map((line) => (
        <ArcRow key={line.sessionId} row={line.stage} label={line.stage}>
          <TugMetaRun
            slot="arc-receipt-stage-meta"
            parts={[
              <span key="model" className="sp-arc-model">{line.model}</span>,
              <StageSession key="session" sessionId={line.sessionId} />,
            ]}
          />
        </ArcRow>
      ))}
      {parsed.plan !== null ? (
        <ArcRow row="plan" label="plan">
          <ArcPathAtom path={parsed.plan} root={root} />
        </ArcRow>
      ) : null}
    </div>
  );
}

/**
 * What a stopped arc offers: the resume as a **chip you press**, not a
 * sentence you retype.
 *
 * The receipt says `resume with tugutil dash run <dash>`, and a reader who
 * wants it has to select a command out of prose and carry it to a shell. The
 * command is right there and the deck can act on it, so the row splits into
 * the one word of prose it needs and a control wearing the command itself.
 *
 * **It is a link, not a button.** The transcript already has a register for
 * "here is a command, press it" — the underlined inline `<code>` a slash
 * command wears in rendered prose — and a receipt that mints a filled chip
 * instead is inventing a second one for the same act. The link is quieter,
 * costs the row no height, and lets the command keep the code family it is
 * read in.
 *
 * A `next` line that is not a resume — the "nothing to resume" ending — has no
 * command in it and renders as the sentence it is.
 */
function ArcResume({ next }: { next: string }): React.ReactElement {
  const command = next.startsWith(RESUME_PREFIX) ? next.slice(RESUME_PREFIX.length) : null;
  return (
    <div className="sp-arc-rows" data-slot="arc-receipt-next">
      {command !== null ? (
        <ArcRow row="resume" label="resume with">
          <ArcCommand command={command} />
        </ArcRow>
      ) : (
        <span className="sp-arc-sentence">{next}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Treatment B — the rail
// ---------------------------------------------------------------------------

/**
 * The same facts as one horizontal run, for a reader who wants only "did it go
 * all the way?" The stages are nodes on a rail between the two ends; the model
 * rides under each node and the session ids fold away entirely (they are still
 * in the copy text, which is where a forensic reader goes anyway).
 *
 * The rail's weakness is honest and worth seeing: it does not survive a narrow
 * card, and a fourth stage would crowd it. The score does both.
 */
function ArcRail({ parsed, root }: { parsed: ParsedArcComplete; root: string }): React.ReactElement {
  return (
    <div className="sp-arc-rail" data-slot="arc-receipt-rail">
      {parsed.document !== null ? (
        <ArcPathAtom path={parsed.document} root={root} />
      ) : (
        <span className="sp-arc-label">no document</span>
      )}
      {parsed.stages.map((line) => (
        <React.Fragment key={line.sessionId}>
          <span className="sp-arc-rail-link" aria-hidden="true" />
          <span className="sp-arc-rail-node" data-stage={line.stage}>
            <span className="sp-arc-rail-name">
              <RowGlyph row={line.stage} size={13} />
              {line.stage}
            </span>
            <span className="sp-arc-rail-model">{line.model}</span>
          </span>
        </React.Fragment>
      ))}
      {parsed.plan !== null ? (
        <>
          <span className="sp-arc-rail-link" aria-hidden="true" />
          <ArcPathAtom path={parsed.plan} root={root} />
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The block — the frame both treatments hang in
// ---------------------------------------------------------------------------

/** Which body a receipt draws. The whole of what this spike is asking. */
type Treatment = "score" | "rail";

/**
 * The candidate `/dash-arc` command block. Same frame as the commit and join
 * receipts — `BlockChrome variant="receipt"` — so an arc's ending sits in the
 * transcript as a sibling of the other landings rather than as stdout.
 *
 * The identity leads with the dash wearing its sigil, because the dash is what
 * the arc was about and the standing rule is that a dash shows with its `^`
 * everywhere it is named. `copyText` is the receipt string verbatim: the
 * drawing is a reading of the record, never a replacement for it.
 */
function ArcReceiptBlock({
  props,
  treatment,
}: {
  props: CommandBlockProps;
  treatment: Treatment;
}): React.ReactElement {
  const parsed = parseArcReceipt(props.message.output);
  if (parsed === null) return <ShellExchangeBlock {...props} />;

  const identity = (
    <span className="sp-arc-identity">
      <DashSigil name={parsed.dash} review={null} slot="arc-receipt-dash" atom />
      <span className="sp-arc-verdict" data-kind={parsed.kind}>
        {parsed.kind === "complete" ? "arc complete" : "arc stopped"}
      </span>
    </span>
  );

  if (parsed.kind === "stopped") {
    return (
      <BlockChrome
        rootSlot="arc-receipt-block"
        variant="receipt"
        identity={identity}
        resultSummary={[{ kind: "text", text: `in ${parsed.stage}` }]}
        phase="interrupted"
        status="ready"
        notice={{ tone: "warning", text: parsed.sentence }}
        copyText={props.message.output}
      >
        <ArcResume next={parsed.next} />
      </BlockChrome>
    );
  }

  return (
    <BlockChrome
      rootSlot="arc-receipt-block"
      variant="receipt"
      identity={identity}
      resultSummary={[{ kind: "count", count: parsed.stages.length, noun: "stage" }]}
      phase="success"
      status="ready"
      copyText={props.message.output}
    >
      {treatment === "score" ? (
        <ArcScore parsed={parsed} root={props.message.cwd} />
      ) : (
        <ArcRail parsed={parsed} root={props.message.cwd} />
      )}
    </BlockChrome>
  );
}

// ---------------------------------------------------------------------------
// The spike body
// ---------------------------------------------------------------------------

function receiptProps(output: string, key: string): CommandBlockProps {
  const message: ShellExchangeMessage = {
    kind: "shell_exchange",
    messageKey: key,
    createdAt: 0,
    exchangeId: key,
    command: "/dash-arc",
    output,
    exitCode: 0,
    cwd: FIXTURE_ROOT,
    cwdAfter: FIXTURE_ROOT,
    startedAtMs: 0,
    settledAtMs: 0,
  };
  return { message };
}

function Caption({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="sp-arc-caption">{children}</p>;
}

export function SpikeArcReceipt(): React.ReactElement {
  const [treatment, setTreatment] = useState<Treatment>("score");
  const choiceId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: { [choiceId]: (v: string) => setTreatment(v as Treatment) },
  });
  // One root, two claims on it: the responder chain needs the callback ref the
  // form hands out, and the annotation delegation needs a ref object to read.
  const root = useRef<HTMLDivElement | null>(null);
  useAnnotationClicks(root);

  return (
    <ResponderScope>
      <div
        className="sp-content"
        data-testid="spike-arc-receipt"
        ref={(el) => {
          root.current = el;
          (responderRef as (el: HTMLDivElement | null) => void)(el);
        }}
      >
        <section className="sp-section">
          <h2 className="sp-section-title">Today — the generic shell block</h2>
          <Caption>
            No renderer claims <code>/dash-arc</code>, so the arc's terminal receipt renders as
            stdout: five undifferentiated mono lines, three uuids at full width, and two paths
            that look like text because nothing here knows they are files. Every other landing on
            this ledger has a bespoke block.
          </Caption>
          <ShellExchangeBlock {...receiptProps(COMPLETE_SUMMARY, "arc-today")} />
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">The proposal</h2>
          <Caption>
            The same string, parsed and drawn — one receipt block, two candidate bodies. The score
            reads the arc top to bottom as what it was; the rail reads it as one run, left to
            right. Both wear the receipt chrome, both copy the record verbatim, and both open
            their paths.
          </Caption>
          <TugChoiceGroup
            value={treatment}
            senderId={choiceId}
            size="xs"
            items={[
              { value: "score", label: "The score" },
              { value: "rail", label: "The rail" },
            ]}
          />
          <ArcReceiptBlock props={receiptProps(COMPLETE_SUMMARY, "arc-full")} treatment={treatment} />
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">The floor — every optional line absent</h2>
          <Caption>
            No document, no plan, one stage on the account default. The score keeps its spine and
            simply has no ends; the rail has almost nothing left to be a rail of, which is the
            argument against it.
          </Caption>
          <ArcReceiptBlock props={receiptProps(MINIMAL_SUMMARY, "arc-min")} treatment={treatment} />
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">A stop is not a completion</h2>
          <Caption>
            The same block, and deliberately not the same read: an interrupted dot rather than a
            success one, the reason in the notice band where it stays visible while collapsed, and
            the resume as the command itself, underlined and clickable the way the transcript
            advertises any command — one click seeds it into the composer. Nothing here claims a
            plan.
          </Caption>
          <ArcReceiptBlock props={receiptProps(STOPPED_SUMMARY, "arc-stop")} treatment={treatment} />
        </section>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "arc-receipt",
  title: "Arc Receipt",
  blurb: "What should a finished dash arc look like when it lands in the transcript?",
  icon: "Route",
  component: () => <SpikeArcReceipt />,
};
