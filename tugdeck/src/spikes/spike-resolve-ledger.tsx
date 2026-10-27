/**
 * spike-resolve-ledger.tsx — can the Changes shade's REPORT section tell the
 * user what a join's conflict resolution is DOING, as it does it, in the
 * transcript's own tool-block grammar, instead of a spinner and a word?
 *
 * What ships today, under an arc whose join is reconciling: a register row
 * reading `Reconciling with main — resolving 1 file` with a `reconciling`
 * badge the register's `overflow: hidden` clips; a DOCUMENTS section whose
 * two rows wear the same H1 twice; a REPORT section that is one 12px spinner
 * beside `Resolving <arc>…` while a seven-rung ladder and a multi-turn
 * resolver agent run for minutes with nothing said; and, when a join is
 * blocked by another session's dirt, an inline dialog whose file list and
 * two paragraphs are CENTERED under a left-aligned title.
 *
 * The server already knows almost everything the user is not told. The
 * ladder knows which rung it is on and why the last one declined; the
 * archaeology knows which commits on main touched the file; the scribe rung
 * streams its merge; the resolver is a real `claude -p` stream whose tool
 * calls and reasoning are read and thrown away at `drive_claude`. The
 * candidate carries its sha, the report carries `what_each_side_did`, and
 * the deck receives all of it and renders a path and a word.
 *
 * The candidate here is a **resolve ledger**: one `BlockChrome` per act of
 * the resolution — the chrome every tool call wears in the transcript, with
 * its lifecycle dot, its identity line, its result badges and a foldable
 * body. The probe's body is the commits on main that made the conflict; the
 * ladder's is each rung and why it declined; the scribe's and the resolver's
 * are their own streamed words. A block in flight wears the pulsing dot the
 * chrome already owns and a live band under its header carrying the
 * standard thinking wave and the sentence of what is happening — the same
 * seat the Bash block's progress band takes. The resolver's question mounts
 * the shipped `QuestionWizard` in that block's body, exactly as the shade
 * mounts it today. The blocked moment mounts the real `SessionChangesArcJoin`
 * over a fixture entry, the way the gallery does, with one CSS change: the
 * sheet reads left-aligned.
 *
 * Two behaviours ride the design. A fold of another session's edit ends in
 * a receipt the user answers — Keep, or Undo — rather than a bare Undo
 * beside a word; and a stale candidate carries a live Resolve again, which
 * today is a sentence with no control behind it.
 *
 * Nothing here sends a wire frame. The rows are a fixture of what the wire
 * would carry once the rungs emit their deltas and the resolver's stream is
 * relayed rather than dropped.
 */

import "./spike.css";
import "./spike-resolve-ledger.css";

import React, { useId, useState } from "react";
import { Check, GitCommitHorizontal, RotateCcw, SquareArrowOutUpRight } from "lucide-react";

import type { SpikeDef } from "./spike-registry";
import { ArcJoinRegisterView } from "@/components/tugways/arc-join-register";
import { BlockChrome } from "@/components/tugways/blocks/block-chrome";
import { BlockNoticeBand } from "@/components/tugways/blocks/block-notice";
import {
  ArcFoldCell,
  ArcFoldRow,
} from "@/components/tugways/cards/session-changes/session-changes-arc-fold-row";
import {
  SessionChangesArcJoin,
  joinQuestionAsParsed,
} from "@/components/tugways/cards/session-changes/session-changes-arc-join";
import { QuestionWizard } from "@/components/tugways/chrome/session-question-dialog";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugChoiceGroup, type TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { TugInlineDialog } from "@/components/tugways/tug-inline-dialog";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import type { ArcJoinRegister } from "@/lib/arc-join-register";
import type { ResolveState } from "@/lib/changeset-join-store";
import type {
  ArcChangesetEntry,
  ArcJoinBlockerWire,
  ArcJoinQuestionWire,
} from "@/lib/changeset-types";
import { sessionNameStore } from "@/lib/session-name-store";
import { sessionTagStore } from "@/lib/session-tag-store";

// ---------------------------------------------------------------------------
// Fixtures — one arc, six moments
// ---------------------------------------------------------------------------

const ARC = "handback-fixups";
const HOLDER = "tug/snowy-rugby";
const HOLDER_ID = "5d2e9b10-0000-4000-8000-00000000c0de";
const TITLE = "Hand-back fixups: one latch, one identity, a green gate";
const ROOT = "/Users/kocienda/Mounts/u/src/tug";
const BRIEF_REL = `.tug/arcs/${ARC}/brief.md`;
const PLAN_REL = `.tug/arcs/${ARC}/plan.md`;
const FOLD_SHA = "a1b2c3d4e";
const FOLD_SUBJECT = `Commit base work in progress to unblock the join of ${ARC}`;
const TOUCHED = 1_760_000_000_000;

sessionNameStore.setName(HOLDER_ID, "snowy rugby");
sessionTagStore.setTag(HOLDER_ID, "snowy-rugby");

type Moment = "blocked" | "folded" | "resolving" | "asking" | "stale" | "resolved";

const MOMENTS: TugChoiceItem[] = [
  { value: "blocked", label: "Blocked" },
  { value: "folded", label: "Folded" },
  { value: "resolving", label: "Resolving" },
  { value: "asking", label: "Asking" },
  { value: "stale", label: "Stale" },
  { value: "resolved", label: "Resolved" },
];

/** The blocker exactly as `join_blockers_from_detail` composes it. */
const BLOCKER: ArcJoinBlockerWire = {
  kind: "base-dirt",
  title: "Another session's edit",
  detail: `Cannot join: ${HOLDER} holds an uncommitted edit to Justfile that this arc also changed.`,
  paths: ["Justfile"],
  remedy: {
    explain: `Resolve commits this 1 file — ${HOLDER}'s work in progress — onto main as one commit, “${FOLD_SUBJECT}”. Nothing changes on disk, their session is told, and Undo here puts them back uncommitted.`,
  },
};

const QUESTION: ArcJoinQuestionWire = {
  request_id: "spike-ask-1",
  question: "Where should the hand-back gate run in `just ci`?",
  options: [
    {
      label: "Before the app-test tier",
      description: "what this arc's brief asks for — a red gate stops the tier",
    },
    {
      label: "Last, after the tier",
      description: "what main does today — the tier runs whatever the gate says",
    },
  ],
};

/** The arc's feed entry, with the join state the moment carries. */
function entry(join: ArcChangesetEntry["join"]): ArcChangesetEntry {
  return {
    kind: "arc",
    owner_id: `tugarc/${ARC}#spike-${ARC}`,
    display_name: ARC,
    base: "main",
    rounds: 5,
    worktree: `${ROOT}/.tug/worktrees/${ARC}`,
    worktree_dirty: false,
    files: [
      {
        path: "Justfile",
        git_status: "M",
        op: "write",
        origin: "arc",
        shared: false,
        last_touched: TOUCHED,
      },
    ],
    last_activity: new Date(TOUCHED).toISOString(),
    stage: "ready",
    documents: { brief: `${ROOT}/${BRIEF_REL}`, plan: `${ROOT}/${PLAN_REL}` },
    base_overlap: ["Justfile"],
    join,
  };
}

const BLOCKED_ENTRY = entry({ phase: "blocked", blockers: [BLOCKER] });
const RESOLVE_IDLE: ResolveState = { phase: "idle", progress: [], error: null };
const NO_JOIN_ACTIONS = {
  aim: () => {},
  answerQuestion: () => {},
  resolveBase: () => {},
  undoResolveBase: () => {},
};

const REGISTER: Record<Moment, ArcJoinRegister> = {
  blocked: {
    phase: "error",
    line: `Cannot join: ${HOLDER} holds an uncommitted edit to Justfile that this arc also changed`,
    word: "blocked",
  },
  folded: {
    phase: "idle",
    line: `Committed ${HOLDER}'s work in progress as ${FOLD_SHA} — the join is clear`,
    word: "ready",
  },
  resolving: {
    phase: "in_flight",
    line: "Reconciling with main — resolving Justfile · rung 5 of 6 · 0:42",
    word: "reconciling",
  },
  asking: {
    phase: "awaiting",
    line: "Reconciling with main — the resolver has a question",
    word: "asking",
  },
  stale: {
    phase: "error",
    line: "main moved since this was resolved — f6de1041b touched Justfile",
    word: "stale",
  },
  resolved: {
    phase: "idle",
    line: "Reconciled with main — 1 file resolved, candidate 9f3c1e2a",
    word: "ready",
  },
};

const CAPTION: Record<Moment, string> = {
  blocked:
    "The shipped register and report over one fixture entry — the real SessionChangesArcJoin — with one change: the sheet's file list, sentence and remedy read left-aligned under the title instead of centred. Resolve is the only control.",
  folded:
    "Resolve ran. What it did is a receipt the user answers: Keep leaves the commit on main and the join proceeds; Undo puts the edit back uncommitted. Today this is a bare Undo beside a word nobody defined.",
  resolving:
    "Each act of the resolution is a tool block. The probe carries the commits that made the conflict, the ladder every rung and why it declined, and the scribe is in flight: the chrome's own pulsing dot, a live band with the thinking wave and the sentence, its words streaming in the body.",
  asking:
    "The resolver's turn is a block; its question is the shipped QuestionWizard mounted in that block's body, exactly as the shade mounts it today.",
  stale:
    "A stale candidate is a block naming the commit that staled it, with the ledger that still reads above it. Resolve again is a live control at the lower right — today it is a sentence with nothing behind it.",
  resolved:
    "At rest the ledger is the receipt: every file, how it was resolved, the resolver's audit, and the candidate's sha. Join lands it; the register says so.",
};

// ---------------------------------------------------------------------------
// Shared rows
// ---------------------------------------------------------------------------

function Sha({ sha }: { sha: string }): React.ReactElement {
  return (
    <span className="arc-fold-sha sp-rl-sha">
      <GitCommitHorizontal size={11} /> {sha}
    </span>
  );
}

function CommitRow({ sha, subject }: { sha: string; subject: string }): React.ReactElement {
  return (
    <ArcFoldRow leading={<ArcFoldCell tone="muted" />}>
      <Sha sha={sha} />
      <span className="arc-fold-prose">{subject}</span>
    </ArcFoldRow>
  );
}

function RungRow({ rung, name, said }: { rung: number; name: string; said: string }): React.ReactElement {
  return (
    <ArcFoldRow
      leading={<ArcFoldCell tone="muted">{rung}</ArcFoldCell>}
      trailing={<span className="arc-fold-fact">{name}</span>}
    >
      <span className="arc-fold-path">Justfile</span>
      <span className="arc-fold-prose sp-rl-said">{said}</span>
    </ArcFoldRow>
  );
}

/** A block's identity, in the receipt's prose face rather than the command face. */
function Identity({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className="sp-rl-identity">{children}</span>;
}

/** A block body of rows: the receipt's block inset, the rows' own inline inset. */
function Rows({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="sp-rl-rows">{children}</div>;
}

/** A block body of prose: the scribe's or the resolver's own words. */
function Words({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="sp-rl-words">{children}</div>;
}

/** The in-flight band: the standard thinking wave and the sentence of what is happening. */
function LiveBand({ text }: { text: string }): React.ReactElement {
  return (
    <BlockNoticeBand
      tone="progress"
      maxLines={1}
      icon={<TugProgressIndicator variant="wave" state="running" role="inherit" />}
      text={text}
    />
  );
}

// ---------------------------------------------------------------------------
// The blocks
// ---------------------------------------------------------------------------

function ProbeBlock(): React.ReactElement {
  return (
    <BlockChrome
      rootSlot="sp-rl-probe"
      toolName="Probe"
      identity={
        <Identity>
          <code>Justfile</code> conflicts with main — 3 commits touched it since the fork
        </Identity>
      }
      resultSummary={{ kind: "count", count: 3, noun: "commit" }}
      phase="success"
      status="ready"
    >
      <Rows>
        <CommitRow sha="f6de1041b" subject="tugarc(capture-capabilities-jobs): Run capture legs under test run" />
        <CommitRow sha="2a91c0e4d" subject="justfile: Fold app-test-covers-check into lint" />
        <CommitRow sha="8c04bb71e" subject="tugtool(test): Record every lint check to the ledger" />
      </Rows>
    </BlockChrome>
  );
}

function LadderBlock(): React.ReactElement {
  return (
    <BlockChrome
      rootSlot="sp-rl-ladder"
      toolName="Ladder"
      identity={
        <Identity>
          <code>Justfile</code> — four rungs declined, handed to the scribe
        </Identity>
      }
      resultSummary={{ kind: "text", text: "rungs 1–4" }}
      phase="success"
      status="ready"
    >
      <Rows>
        <RungRow rung={1} name="replay" said="stopped at round 2, “Gate the hand-back on a green run”" />
        <RungRow rung={2} name="salvage" said="no prior chain to salvage from" />
        <RungRow rung={3} name="rerere" said="no recorded resolution" />
        <RungRow rung={4} name="merge-file" said="2 conflict blocks remain after a three-way merge" />
      </Rows>
    </BlockChrome>
  );
}

function ScribeBlock({ live }: { live: boolean }): React.ReactElement {
  return (
    <BlockChrome
      rootSlot="sp-rl-scribe"
      toolName="Scribe"
      identity={
        <Identity>
          <code>Justfile</code>
          {live
            ? " — merging base, ours and theirs"
            : " — merged: both recipes kept, the gate runs after the capture legs"}
        </Identity>
      }
      resultSummary={
        live
          ? { kind: "text", text: "rung 5" }
          : [
              { kind: "text", text: "rung 5" },
              { kind: "diff", added: 4, removed: 1 },
              { kind: "text", text: "0:31" },
            ]
      }
      phase={live ? "in_flight" : "success"}
      status={live ? "streaming" : "ready"}
      liveBand={live ? <LiveBand text="merging Justfile · 0:11" /> : undefined}
    >
      <Words>
        Both sides add a recipe under <code>test</code>: main adds <code>capture-legs</code>{" "}
        ahead of <code>app-test-covers-check</code>, and the arc adds{" "}
        <code>handback-gate</code> that must run after any capture.{" "}
        {live
          ? "Keeping both and ordering the gate last…"
          : "Kept both; the gate runs last, after every capture leg."}
      </Words>
    </BlockChrome>
  );
}

function ResolverBlock({ asking }: { asking: boolean }): React.ReactElement {
  return (
    <BlockChrome
      rootSlot="sp-rl-resolver"
      toolName="Resolver"
      identity={
        <Identity>
          {asking
            ? "auditing Justfile — the two sides want different things, and the brief does not decide it"
            : "auditing 1 machine-resolved file against the arc's intent"}
        </Identity>
      }
      resultSummary={{ kind: "text", text: asking ? "turn 3" : "turn 2" }}
      phase={asking ? "awaiting" : "in_flight"}
      status={asking ? "ready" : "streaming"}
      liveBand={
        asking ? undefined : <LiveBand text="reading Justfile at the candidate · 1:04" />
      }
      forceExpanded={asking}
    >
      <Words>
        Read Justfile at the candidate. The scribe kept <code>handback-gate</code> after{" "}
        <code>capture-legs</code>, which matches the brief's “a green gate”
        {asking
          ? " — but main's ci recipe runs the app-test tier before any gate, and the arc's brief wants a red gate to stop that tier. One of them has to give."
          : " — but just ci now lists the gate twice, once from each side. Removing the duplicate line…"}
      </Words>
      {asking ? (
        <div className="session-changes-arc-join-question" data-slot="sp-rl-question">
          <QuestionWizard
            requestId={QUESTION.request_id}
            questions={joinQuestionAsParsed(QUESTION)}
            isPending
            onSubmit={() => {}}
            onDecline={() => {}}
            onCancel={() => {}}
          />
        </div>
      ) : null}
    </BlockChrome>
  );
}

function AuditBlock(): React.ReactElement {
  return (
    <BlockChrome
      rootSlot="sp-rl-audit"
      toolName="Resolver"
      identity={
        <Identity>
          <code>Justfile</code> — audited: main added capture legs, this arc added the gate, the
          merge runs the gate once, before the app-test tier
        </Identity>
      }
      resultSummary={[
        { kind: "count", count: 1, noun: "file" },
        { kind: "text", text: "3 turns" },
      ]}
      phase="success"
      status="ready"
    >
      <Words>
        Asked once — where the gate runs — and was told: before the app-test tier. Removed the
        duplicate recipe line the scribe left. Every file is accounted for.
      </Words>
    </BlockChrome>
  );
}

function CandidateBlock(): React.ReactElement {
  return (
    <BlockChrome
      rootSlot="sp-rl-candidate"
      variant="receipt"
      toolName="Candidate"
      identity={
        <Identity>
          <Sha sha="9f3c1e2a" /> anchored on main at f6de1041b — Join lands it as one commit
        </Identity>
      }
      resultSummary={[
        { kind: "count", count: 1, noun: "file" },
        { kind: "text", text: "2:17 in all" },
      ]}
      phase="success"
      status="ready"
    >
      <Rows>
        <ArcFoldRow
          leading={
            <ArcFoldCell tone="muted">
              <Check size={11} />
            </ArcFoldCell>
          }
          trailing={<span className="arc-fold-fact">scribe · resolver</span>}
        >
          <span className="arc-fold-path">Justfile</span>
        </ArcFoldRow>
      </Rows>
    </BlockChrome>
  );
}

function StaleBlock(): React.ReactElement {
  return (
    <BlockChrome
      rootSlot="sp-rl-stale"
      toolName="main"
      identity={
        <Identity>
          <Sha sha="f6de1041b" /> landed after this was resolved and touches Justfile
        </Identity>
      }
      resultSummary={{ kind: "text", text: "4 min ago" }}
      phase="error"
      status="error"
      notice={{
        tone: "warning",
        text: "The candidate no longer applies: it was anchored on the main this commit moved. Resolving again re-runs the ladder; rerere and the resolver's checkpoints carry what they can.",
      }}
    >
      {null}
    </BlockChrome>
  );
}

// ---------------------------------------------------------------------------
// The fold receipt — answered, not only undone
// ---------------------------------------------------------------------------

function FoldReceipt(): React.ReactElement {
  return (
    <TugInlineDialog
      className="sp-rl-sheet"
      icon={<Check />}
      iconRole="success"
      title={`${HOLDER}'s edit to Justfile is now a commit on main`}
      description={
        <>
          <Sha sha={FOLD_SHA} /> “{FOLD_SUBJECT}”. Their session was told; nothing changed on
          their disk, and they keep editing on top of it. Keep leaves the commit on main and
          the join proceeds. Undo takes it back off main, returns their edit uncommitted, and
          blocks the join again.
        </>
      }
      actions={
        <>
          <TugPushButton size="xs" emphasis="primary" role="action">
            Keep
          </TugPushButton>
          <TugPushButton size="xs" emphasis="outlined">
            Undo
          </TugPushButton>
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// DOCUMENTS, as a receipt's file list: the role, the path, the fact
// ---------------------------------------------------------------------------

function DocumentRow({
  role,
  path,
  fact,
}: {
  role: string;
  path: string;
  fact?: string;
}): React.ReactElement {
  return (
    <ArcFoldRow
      hit
      leading={
        <ArcFoldCell tone="muted">
          <TugBadge size="sm" emphasis="ghost" className="sp-rl-role">
            {role}
          </TugBadge>
        </ArcFoldCell>
      }
      trailing={
        <span className="arc-fold-fact sp-rl-docfact">
          {fact !== undefined ? <span>{fact}</span> : null}
          <SquareArrowOutUpRight size={12} />
        </span>
      }
    >
      <span className="arc-fold-path">{path}</span>
    </ArcFoldRow>
  );
}

function Documents(): React.ReactElement {
  return (
    <div className="sp-rl-docs">
      <TugSectionLabel label={{ name: "Documents", qualifier: TITLE }} />
      <DocumentRow role="brief" path={BRIEF_REL} />
      <DocumentRow role="plan" path={PLAN_REL} fact="5 of 5 done" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The report, per moment
// ---------------------------------------------------------------------------

function Report({ moment }: { moment: Moment }): React.ReactElement {
  switch (moment) {
    case "blocked":
      return (
        <SessionChangesArcJoin
          entry={BLOCKED_ENTRY}
          join={BLOCKED_ENTRY.join ?? null}
          error={null}
          resolve={RESOLVE_IDLE}
          actions={NO_JOIN_ACTIONS}
        />
      );
    case "folded":
      return <FoldReceipt />;
    case "resolving":
      return (
        <>
          <ProbeBlock />
          <LadderBlock />
          <ScribeBlock live />
        </>
      );
    case "asking":
      return (
        <>
          <ProbeBlock />
          <LadderBlock />
          <ScribeBlock live={false} />
          <ResolverBlock asking />
        </>
      );
    case "stale":
      return (
        <>
          <ProbeBlock />
          <LadderBlock />
          <ScribeBlock live={false} />
          <AuditBlock />
          <CandidateBlock />
          <StaleBlock />
          <div className="sp-rl-acts">
            <TugPushButton size="xs" emphasis="primary" role="action">
              <RotateCcw size={12} /> Resolve again
            </TugPushButton>
          </div>
        </>
      );
    case "resolved":
      return (
        <>
          <ProbeBlock />
          <LadderBlock />
          <ScribeBlock live={false} />
          <AuditBlock />
          <CandidateBlock />
        </>
      );
  }
}

// ---------------------------------------------------------------------------
// Base motion — the notice the transcript gets when main moves under an arc
// ---------------------------------------------------------------------------

const MOVED_ARC = "moved-call-is-a-job";
const MOVED_PATHS = [
  "tugdeck/src/components/tugways/cards/__tests__/session-tool-visibility-policy.test.ts",
  "tugdeck/src/components/tugways/cards/blocks/__tests__/design-sync-tool-block.test.ts",
  "tugdeck/src/components/tugways/cards/blocks/__tests__/list-agents-tool-block.test.ts",
  "tugdeck/src/components/tugways/cards/blocks/__tests__/report-findings-tool-block.test.ts",
  "tugdeck/src/components/tugways/cards/blocks/design-sync-tool-block.tsx",
  "tugdeck/src/components/tugways/cards/blocks/list-agents-tool-block.tsx",
  "tugdeck/src/components/tugways/cards/blocks/report-findings-tool-block.tsx",
  "tugdeck/src/components/tugways/cards/blocks/send-message-tool-block.tsx",
  "tugdeck/src/components/tugways/cards/blocks/tool-collapse-defaults.ts",
  "tugdeck/src/components/tugways/cards/blocks/tool-header-projection.ts",
  "tugdeck/src/components/tugways/cards/session-assistant-renderer-registrations.ts",
  "tugdeck/src/components/tugways/cards/session-tool-visibility-policy.ts",
];

/**
 * A clean replay as a receipt. Today `compose_replay_notice` writes a
 * paragraph and a path list into a `tug_notice`, which the transcript seats
 * as a system note: a quote bar, proportional type, and a column of bare
 * paths. A replay is a commit-shaped fact — a sha, a count, a file list — so
 * it takes the commit receipt's chrome: the sha and the sentence on the
 * identity line, the count as a header badge, the advice on the notice band,
 * and the files as compact mono rows under the fold.
 */
function ReplayedBlock(): React.ReactElement {
  return (
    <BlockChrome
      rootSlot="sp-rl-replayed"
      variant="receipt"
      toolName="Replayed"
      identity={
        <Identity>
          <code>^{MOVED_ARC}</code> onto main at <Sha sha="fd5978f4e" /> while you were
          between turns
        </Identity>
      }
      resultSummary={[
        { kind: "count", count: MOVED_PATHS.length, noun: "file" },
        { kind: "count", count: 3, noun: "round" },
      ]}
      phase="success"
      status="ready"
      notice={{
        tone: "info",
        text: "No action is required. Re-read any of these files before editing them — what you have in context predates the move.",
      }}
    >
      <Rows>
        {MOVED_PATHS.map((path) => (
          <ArcFoldRow key={path} leading={<ArcFoldCell tone="muted" />}>
            <span className="arc-fold-path">{path}</span>
          </ArcFoldRow>
        ))}
      </Rows>
    </BlockChrome>
  );
}

/**
 * A replay that stopped. `compose_conflict_message` writes the same facts and
 * then a recipe — the rebase, the record verb, the verify verb — as a
 * paragraph the agent is to follow. The receipt carries the facts; the recipe
 * is the body, as the commands they are.
 */
function ReplayStoppedBlock(): React.ReactElement {
  return (
    <BlockChrome
      rootSlot="sp-rl-replay-stopped"
      variant="receipt"
      toolName="Replay stopped"
      identity={
        <Identity>
          <code>^{MOVED_ARC}</code> — main moved to <Sha sha="fd5978f4e" /> and round 2,
          “Gate the hand-back on a green run”, conflicts
        </Identity>
      }
      resultSummary={{ kind: "count", count: 1, noun: "file" }}
      phase="error"
      status="error"
      notice={{
        tone: "warning",
        text: "Resolve it on the arc's own worktree, then record the moved rounds and verify the fit. If the conflict is a real design collision, abort the rebase and say so.",
      }}
    >
      <Rows>
        <ArcFoldRow
          leading={<ArcFoldCell tone="danger">!</ArcFoldCell>}
          trailing={<span className="arc-fold-fact arc-fold-fact-danger">conflicts with main</span>}
        >
          <span className="arc-fold-path arc-fold-path-danger">Justfile</span>
        </ArcFoldRow>
        <ArcFoldRow leading={<ArcFoldCell tone="muted">1</ArcFoldCell>}>
          <span className="arc-fold-path">git -C .tug/worktrees/{MOVED_ARC} rebase main</span>
        </ArcFoldRow>
        <ArcFoldRow leading={<ArcFoldCell tone="muted">2</ArcFoldCell>}>
          <span className="arc-fold-path">tugtool arc replay {MOVED_ARC} --json</span>
        </ArcFoldRow>
        <ArcFoldRow leading={<ArcFoldCell tone="muted">3</ArcFoldCell>}>
          <span className="arc-fold-path">tugtool arc verify {MOVED_ARC}</span>
        </ArcFoldRow>
      </Rows>
    </BlockChrome>
  );
}

// ---------------------------------------------------------------------------
// The spike
// ---------------------------------------------------------------------------

function SpikeResolveLedger(): React.ReactElement {
  const [moment, setMoment] = useState<Moment>("resolving");
  const momentId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: { [momentId]: (v) => setMoment(v as Moment) },
  });

  return (
    <ResponderScope>
      <div
        className="sp-content sp-rl"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <section className="sp-section">
          <h2 className="sp-section-title">A resolve ledger under the register</h2>
          <TugChoiceGroup items={MOMENTS} value={moment} senderId={momentId} size="sm" />
          <p className="sp-rl-caption">{CAPTION[moment]}</p>
        </section>

        <section className="sp-section sp-rl-lane" key={moment}>
          <ArcJoinRegisterView register={REGISTER[moment]} altitude="entry" />
          <Documents />
          {moment === "blocked" ? (
            /* The shipped report draws its own REPORT label; a second one
               here is the same eyebrow twice. */
            <Report moment={moment} />
          ) : (
            <div className="sp-rl-report">
              <TugSectionLabel label={{ name: "Report" }} />
              <div className="sp-rl-blocks">
                <Report moment={moment} />
              </div>
            </div>
          )}
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">Base motion, as a receipt in the transcript</h2>
          <p className="sp-rl-caption">
            When main moves under a running arc, tugcast replays the rounds and tells the
            session in a <code>tug_notice</code>: today a quote-barred system note in
            proportional type with a column of bare paths. A replay is a commit-shaped fact,
            so it takes the commit receipt's chrome — sha and sentence on the identity line,
            counts as badges, the advice on the notice band, the files as compact mono rows.
            A stopped replay is the same receipt in error, with the recipe as its body.
          </p>
          <div className="sp-rl-blocks">
            <ReplayedBlock />
            <ReplayStoppedBlock />
          </div>
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">What would have to change behind it</h2>
          <ul className="sp-rl-notes">
            <li>
              <b>Every rung reports.</b> A <code>changeset_join_resolve_delta</code> from each
              rung — tried, declined with its one-line why, resolved with counts — and a
              terminal delta for the scribe. The ladder knows all of it today and emits none.
            </li>
            <li>
              <b>The resolver's stream is relayed, not dropped.</b> Assistant text and tool
              names per turn become the body of its block; the question is the wizard the
              shade already mounts, now in that body.
            </li>
            <li>
              <b>The ledger is durable.</b> Each block is written as the resolve goes, beside
              the checkpoints already landing on the conflict chain, so a reload mid-resolve
              reads the same blocks and a second deck reads the same bytes.
            </li>
            <li>
              <b>A fold is answered, not only undone.</b> The resolve-base receipt offers Keep
              and Undo and says what each does; Keep retires the receipt, Undo is the verb
              that exists today.
            </li>
            <li>
              <b>Resolve again is a verb.</b> A CONTROL that re-runs the ladder on a stale
              candidate, where today only the pilot's head-pair mark re-resolves and the
              sentence has no control behind it.
            </li>
            <li>
              <b>Already on the wire, never drawn:</b> the archaeology, the candidate sha,{" "}
              <code>what_each_side_did</code>, the question's answer, per-file diff counts and
              the scribe's streamed text. Most of the ledger is a rendering of facts the deck
              already holds.
            </li>
          </ul>
        </section>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "resolve-ledger",
  title: "Resolve Ledger",
  blurb:
    "Can the REPORT section under a reconciling arc say what the resolution is doing, as tool blocks with the thinking wave on the live one, instead of a spinner?",
  icon: "GitMerge",
  size: {
    min: { width: 520, height: 420 },
    preferred: { width: 780, height: 760 },
  },
  component: () => <SpikeResolveLedger />,
};
