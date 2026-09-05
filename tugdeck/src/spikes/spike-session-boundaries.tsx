/**
 * spike-session-boundaries.tsx — can the transcript's three "the ground moved"
 * rows (session compacted, arc stage rotated, arc joined) wear one shape?
 *
 * Each of the three marks a change in what is UNDERNEATH the conversation
 * rather than something a participant said: a compaction swaps the model's
 * context, a stage rotation swaps the claude session (and usually the model),
 * a join swaps the base. Today two of them share a bar and the third borrows
 * a command's outcome idiom — a green phase dot and the word `joined` in the
 * badge slot, hung under the receipt and inset to the body column like any
 * shell exchange.
 *
 * Three zones:
 *   1. TODAY — the three as they ship, mounted with their real classes, in a
 *      faux transcript column so the indent story is visible.
 *   2. ONE BOUNDARY — the candidate: one anatomy for all three (a rule across
 *      the row, a sunken bar, a glyph, a bold event, a muted detail, a
 *      trailing summary, and a chevron only when something folds behind it),
 *      always at the transcript's full width — including the seat inside an
 *      open turn, which pulls to the edge by CSS.
 *   3. NOT THIS KIND — an arc-note and a Tug notice beside a boundary, so the
 *      line between "the ground moved" and "something happened on it" stays
 *      drawn.
 *
 * @module spikes/spike-session-boundaries
 */

import "./spike.css";
import type { SpikeDef } from "./spike-registry";
import "./spike-session-boundaries.css";

import React from "react";
import {
  CircleCheck,
  GitMerge,
  Layers,
  Megaphone,
  Milestone,
} from "lucide-react";

import { BlockChrome } from "@/components/tugways/blocks/block-chrome";
import { BlockHeader } from "@/components/tugways/blocks/block-header";
import { ToolBlockHistoryCollapse } from "@/components/tugways/blocks/collapse-context";
import type { ToolResultSummary } from "@/components/tugways/blocks/tool-result-summary";
import { SessionJoinReceiptBlock } from "@/components/tugways/cards/session-join-receipt-block";
import type { CommandBlockProps } from "@/components/tugways/cards/session-command-block-registry";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import { TugQuietLine } from "@/components/tugways/tug-quiet-line";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";

// ---------------------------------------------------------------------------
// Fixtures — one of each boundary, with the words the store actually mints.
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = "/Users/dev/src/tugtool";

/** `compaction.ts` — "Session compacted · ~Nk tokens". */
const COMPACT_NOTE = "Session compacted · ~142k tokens";

const COMPACT_RECAP =
  "## Compaction Summary\n\n" +
  "The session was resolving the arc's base before a join. The join board " +
  "now reads `base_sha` from the ledger rather than re-deriving it, and the " +
  "pilot's mark bounds re-runs to one per `(base_sha, arc_head)` pair.\n\n" +
  "- `join_board.rs` — the base read moved under the occupancy guard\n" +
  "- `join_pilot.rs` — the mark is checked inside the dispatched task\n" +
  "- Open: the `at0441` re-run after the mark landed";

/** `stages.ts` — "<stage> · <model> · <document>". */
const STAGE_NOTE = "review · opus · .tug/arcs/arc-resolve/plan.md";

const JOIN_FILES = [
  { path: "tugdeck/src/lib/changeset-join-store.ts", status: "modified", added: 254, removed: 4 },
  { path: "tugdeck/src/lib/join-mode-controller.ts", status: "modified", added: 6, removed: 0 },
  { path: "tugrust/crates/tugarc-core/src/ops.rs", status: "modified", added: 207, removed: 8 },
  { path: "tugrust/crates/tugcast/src/feeds/join_board.rs", status: "modified", added: 216, removed: 2 },
  { path: "tugrust/crates/tugcast/src/feeds/join_pilot.rs", status: "modified", added: 1, removed: 0 },
];

const JOIN_SHA = "9c4e21ab";
const JOIN_SUBJECT = "tugcast(join-board): Resolve the arc's base before the join lands";

/** The S01 receipt the `/arc-join` verb writes, byte-for-byte in shape. */
const JOIN_OUTPUT =
  `joined ${JOIN_SHA} · arc-resolve → main · 7 round(s)\n` +
  `fit: verified 3f0a91c2 onto e7d5b0a4\n` +
  `files: ${JSON.stringify(JOIN_FILES)}\n` +
  `${JOIN_SUBJECT}\n\n` +
  `The pilot reconciles once per (base_sha, arc_head) and the mark is read\n` +
  `inside the dispatched task under the occupancy guard.`;

function joinReceiptProps(testid: string): CommandBlockProps {
  const message: ShellExchangeMessage = {
    kind: "shell_exchange",
    messageKey: testid,
    createdAt: 0,
    exchangeId: testid,
    command: "/arc-join arc-resolve",
    output: JOIN_OUTPUT,
    exitCode: 0,
    cwd: FIXTURE_ROOT,
    cwdAfter: FIXTURE_ROOT,
    startedAtMs: 0,
    settledAtMs: 0,
  };
  return { message };
}

const JOIN_SUMMARY: readonly ToolResultSummary[] = [
  { kind: "count", count: JOIN_FILES.length, noun: "file" },
  {
    kind: "diff",
    added: JOIN_FILES.reduce((n, f) => n + f.added, 0),
    removed: JOIN_FILES.reduce((n, f) => n + f.removed, 0),
  },
  { kind: "count", count: 7, noun: "round" },
];

const PROSE_BEFORE =
  "The re-run is green. The mark bounds the pilot to one reconcile per base, so the join is safe to land whenever you are.";
const PROSE_AFTER =
  "Picking up on main: the arc's branch is released and the workshop is torn down. Next is the `at0441` re-run against the new base.";

// ---------------------------------------------------------------------------
// The faux transcript column — a gutter and a body inset, like the real one.
// ---------------------------------------------------------------------------

function Column({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="sp-boundary-column">{children}</div>;
}

/** A line of assistant prose, seated in the body column past the gutter. */
function Prose({ text }: { text: string }): React.ReactElement {
  return (
    <div className="sp-boundary-prose">
      <span className="sp-boundary-gutter" aria-hidden="true" />
      <TugMarkdownBlock initialText={text} className="sp-boundary-prose-md" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zone 1 — TODAY. Real classes, real receipt block, real register.
// ---------------------------------------------------------------------------

function TodayCompaction(): React.ReactElement {
  const [label, tokens] = COMPACT_NOTE.split(" · ");
  return (
    <div className="session-card-transcript-compaction">
      <ToolBlockHistoryCollapse toolUseId="sp-today-compaction" defaultCollapsed>
        <BlockChrome
          rootSlot="session-compaction"
          className="session-compaction-bar"
          leading={<Layers size={16} aria-hidden="true" />}
          toolName={label}
          resultSummary={{ kind: "text", text: tokens ?? "" }}
          copyText={COMPACT_RECAP}
        >
          <TugMarkdownBlock initialText={COMPACT_RECAP} />
        </BlockChrome>
      </ToolBlockHistoryCollapse>
    </div>
  );
}

function TodayStage(): React.ReactElement {
  return (
    <div className="session-card-transcript-stage">
      <BlockChrome
        rootSlot="session-stage"
        className="session-stage-bar"
        leading={<Milestone size={16} aria-hidden="true" />}
        toolName="Stage"
        identity={STAGE_NOTE}
        copyText={STAGE_NOTE}
      >
        {null}
      </BlockChrome>
    </div>
  );
}

function ZoneToday(): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">Today — two bars and a register</h2>
      <Column>
        <Prose text={PROSE_BEFORE} />
        <TodayCompaction />
        <TodayStage />
        {/* The join: receipt + settled register, inside the `$` cell, so it
            sits at the body inset like a shell exchange. */}
        <div className="sp-boundary-body-seat">
          <SessionJoinReceiptBlock {...joinReceiptProps("sp-today-join")} />
        </div>
        <Prose text={PROSE_AFTER} />
      </Column>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Zone 2 — ONE BOUNDARY. The candidate anatomy, three times.
// ---------------------------------------------------------------------------

interface BoundaryProps {
  id: string;
  glyph: React.ReactNode;
  /** The bold event — "Session compacted", "Stage 2 · review", "Joined …". */
  event: string;
  /** The muted detail beside it — a path, a sha and subject, nothing. */
  detail?: React.ReactNode;
  /** Numbers ride here: tokens, the model, files and rounds. */
  summary?: ToolResultSummary | readonly ToolResultSummary[];
  /** What folds behind the bar. `undefined` means no fold and no chevron. */
  fold?: React.ReactNode;
  copyText?: string;
  /** True when the boundary is seated inside an open turn's body column. */
  inTurn?: boolean;
}

function Boundary({
  id,
  glyph,
  event,
  detail,
  summary,
  fold,
  copyText,
  inTurn = false,
}: BoundaryProps): React.ReactElement {
  // The event and its detail are ONE inline run in the detail slot, not a
  // name column beside a detail column: the strip's name slot would give the
  // detail a left edge of its own, and a wrapped join subject would hang
  // under that edge instead of returning flush to the glyph's gutter.
  const line = (
    <span className="sp-boundary-line" data-tugx-findable="">
      <span className="sp-boundary-event">{event}</span>
      {detail !== undefined ? <> {detail}</> : null}
    </span>
  );
  const bar = (
    <BlockChrome
      rootSlot="sp-boundary"
      className="sp-boundary-bar"
      leading={glyph}
      identity={line}
      resultSummary={summary}
      copyText={copyText ?? event}
    >
      {fold ?? null}
    </BlockChrome>
  );
  return (
    <div
      className="sp-boundary"
      data-slot="sp-boundary"
      data-in-turn={inTurn ? "" : undefined}
    >
      {fold !== undefined ? (
        <ToolBlockHistoryCollapse toolUseId={id} defaultCollapsed>
          {bar}
        </ToolBlockHistoryCollapse>
      ) : (
        bar
      )}
    </div>
  );
}

function ProposedCompaction({ inTurn }: { inTurn?: boolean }): React.ReactElement {
  return (
    <Boundary
      id={`sp-proposed-compaction${inTurn ? "-in-turn" : ""}`}
      glyph={<Layers size={16} aria-hidden="true" />}
      event="Session compacted"
      summary={{ kind: "text", text: "~142k tokens" }}
      fold={<TugMarkdownBlock initialText={COMPACT_RECAP} />}
      copyText={COMPACT_RECAP}
      inTurn={inTurn}
    />
  );
}

function ProposedStage(): React.ReactElement {
  return (
    <Boundary
      id="sp-proposed-stage"
      glyph={<Milestone size={16} aria-hidden="true" />}
      event="Stage 3 of 5 · review"
      detail={
        <span className="sp-boundary-detail">
          sonnet → opus · <code>.tug/arcs/arc-resolve/plan.md</code>
        </span>
      }
      summary={{ kind: "text", text: "opus" }}
      copyText={STAGE_NOTE}
    />
  );
}

/** A — the receipt folds behind the boundary, the way the recap folds. */
function ProposedJoinFolded(): React.ReactElement {
  return (
    <Boundary
      id="sp-proposed-join-a"
      glyph={<GitMerge size={16} aria-hidden="true" />}
      event="Joined arc-resolve into main"
      detail={
        <span className="sp-boundary-detail">
          <code>{JOIN_SHA}</code> {JOIN_SUBJECT}
        </span>
      }
      summary={JOIN_SUMMARY}
      fold={
        <div className="sp-boundary-fold-receipt">
          <SessionJoinReceiptBlock {...joinReceiptProps("sp-proposed-join-a-receipt")} />
        </div>
      }
      copyText={`${JOIN_SHA} ${JOIN_SUBJECT}`}
    />
  );
}

/** B — the receipt stays a receipt; the boundary replaces the register under it. */
function ProposedJoinAfterReceipt(): React.ReactElement {
  return (
    <>
      <div className="sp-boundary-body-seat sp-boundary-body-seat--no-register">
        <SessionJoinReceiptBlock {...joinReceiptProps("sp-proposed-join-b-receipt")} />
      </div>
      <Boundary
        id="sp-proposed-join-b"
        glyph={<GitMerge size={16} aria-hidden="true" />}
        event="Joined arc-resolve into main"
        summary={{ kind: "count", count: 7, noun: "round" }}
      />
    </>
  );
}

function ZoneProposed(): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">One boundary — the same anatomy, three times</h2>
      <Column>
        <Prose text={PROSE_BEFORE} />
        <ProposedCompaction />
        <ProposedStage />
        <ProposedJoinFolded />
        <Prose text={PROSE_AFTER} />
      </Column>

      <h2 className="sp-section-title">Join, variant B — receipt first, boundary under it</h2>
      <Column>
        <Prose text={PROSE_BEFORE} />
        <ProposedJoinAfterReceipt />
        <Prose text={PROSE_AFTER} />
      </Column>

      <h2 className="sp-section-title">The seat inside an open turn — pulled to the edge</h2>
      <Column>
        <div className="sp-boundary-turn-body">
          <span className="sp-boundary-gutter" aria-hidden="true" />
          <div className="sp-boundary-turn-column">
            <TugMarkdownBlock initialText={PROSE_BEFORE} className="sp-boundary-prose-md" />
            <ProposedCompaction inTurn />
            <TugMarkdownBlock initialText={PROSE_AFTER} className="sp-boundary-prose-md" />
          </div>
        </div>
      </Column>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Zone 3 — NOT THIS KIND. Events on the ground, beside a boundary.
// ---------------------------------------------------------------------------

function ZoneNotThisKind(): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">Not this kind — events stay quiet lines</h2>
      <Column>
        <div className="sp-boundary-body-seat sp-boundary-quiet">
          <TugQuietLine
            icon={<CircleCheck size={16} aria-hidden="true" />}
            label={
              <span>
                <span className="sp-boundary-arc-name">arc-resolve</span> Step 2/5 closed
              </span>
            }
            subject="join board reads base_sha from the ledger"
            tone="primary"
          />
        </div>
        <div className="sp-boundary-body-seat sp-boundary-quiet sp-boundary-notice">
          <TugQuietLine
            icon={<Megaphone size={16} aria-hidden="true" />}
            label="base-motion"
            subject="main moved under this arc; the pilot is reconciling"
            tone="quiet"
          />
        </div>
        <ProposedStage />
        <div className="sp-boundary-body-seat sp-boundary-quiet">
          <TugQuietLine
            icon={<CircleCheck size={16} aria-hidden="true" />}
            label={
              <span>
                <span className="sp-boundary-arc-name">arc-resolve</span> Step 3/5
              </span>
            }
            subject="review the join board's occupancy guard"
            tone="primary"
          />
        </div>
      </Column>
      <p className="sp-boundary-note">
        A boundary changes what is underneath the transcript. An arc-note or a
        notice is something that happened on top of it. The quiet line keeps
        its inset and its glyph; only the three boundaries take the rule and
        the bar. The live register during a join stays a register at the
        transcript's edge; the settled row is what becomes a boundary.
      </p>
      <BlockHeader
        phase="success"
        target="Joined arc-resolve into main"
        summary={{ kind: "text", text: "joined" }}
        className="sp-boundary-register-today"
      />
    </section>
  );
}

// ---------------------------------------------------------------------------

function SpikeSessionBoundaries(): React.ReactElement {
  return (
    <div className="sp-content">
      <ZoneToday />
      <ZoneProposed />
      <ZoneNotThisKind />
    </div>
  );
}

export const spike: SpikeDef = {
  name: "session-boundaries",
  title: "Session Boundaries",
  blurb:
    "Can compaction, stage rotation, and an arc join wear one boundary shape at the transcript's full width?",
  icon: "Milestone",
  size: {
    min: { width: 480, height: 400 },
    preferred: { width: 760, height: 720 },
  },
  component: () => <SpikeSessionBoundaries />,
};
