/**
 * spike-arc-endgame.tsx — can the arc's endgame surfaces (the Changes
 * shade's arc fold, and the Arcs card's join register) read in the ONE
 * grammar the rest of the app already uses for a change, instead of a
 * dialect of their own?
 *
 * What ships today, in the shade's arc fold: three labeled sections that
 * each set their own type. `documents` is a `TugListRow` whose title is `sm`
 * and whose facts are `xs` on the same line. `report` sets a conflict path
 * in `sm` mono and its history in `2xs`. `rounds` sets its paths at
 * `--tugx-filerow-name-size`, which is `2xs` — 11px, a step BELOW the 12px
 * the receipt's own file rows take — while setting the facts beside them at
 * `xs`, so the count reads larger than the path it qualifies. Its directory
 * folds are `TugPushButton`s with their own padding, their own 1.6 leading
 * and their own nested-list margins, which is where the air comes from.
 * Three sizes in contradictory pairings, and rows from 17px to 28px tall.
 *
 * The candidate has two sizes and one row. Every row in the fold is the
 * compact mono `TugListRow` a commit receipt's file list is made of: a 2ch
 * leading cell (a status mark, a glyph, an ordinal), the content, and a
 * trailing cluster ordered the way every file row orders it — counts, then
 * pop-out, then the fold cue on the edge. The changed files ARE
 * `ChangesFileRow`s, the receipt's own row, expanding to the file's range
 * diff; a directory is a row of the same grammar with a folder in the mark
 * cell and the same trailing cluster; the totals line is a row too, and it is
 * the fold for the whole list, the way a receipt's header is. The subject
 * keeps the block's `sm`; everything under it is `xs`. Air between rows is
 * the row's own 1px, and between sections it is the eyebrow's own margin.
 *
 * On the Arcs card, the join register is a `BlockHeader` at the `section`
 * altitude — a rail-band strip with a surface, `sm` semibold and `sm`/`md`
 * padding — sitting inside a list row. The candidate has no third line at
 * all: once the arc is ready, the lifecycle line's reading is the register's
 * sentence naming the base, behind the lifecycle dot settled green in place
 * of the phase glyph.
 *
 * @module spikes/spike-arc-endgame
 */

import "./spike.css";
import type { SpikeDef } from "./spike-registry";
import "./spike-arc-endgame.css";
// The lane's own stylesheet, so the TODAY zone wears the real classes and
// the real air rather than a spike's memory of them.
import "@/components/tugways/cards/session-changes/session-changes-arc-lane.css";
import "@/components/tugways/commit-presentation.css";

import React, { useId, useState } from "react";
import {
  AlignLeft,
  EllipsisVertical,
  FileText,
  Folder,
  GitCommitHorizontal,
  SquareArrowOutUpRight,
  TriangleAlert,
} from "lucide-react";

import { ArcLifecycleBlock } from "@/components/tugways/arc-lifecycle-block";
import { ArcJoinRegister } from "@/components/tugways/arc-join-register";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { DiffSummaryBadges } from "@/components/tugways/blocks/diff-summary-badges";
import { CommitMessage } from "@/components/tugways/commit-presentation";
import { SessionChangesArcBrief } from "@/components/tugways/cards/session-changes/session-changes-arc-brief";
import { SessionChangesArcDocuments } from "@/components/tugways/cards/session-changes/session-changes-arc-documents";
import {
  SessionChangesArcJoin,
  type ArcJoinActions,
} from "@/components/tugways/cards/session-changes/session-changes-arc-join";
import { TugArcTrack, arcTrackModelFromEntry } from "@/components/tugways/tug-arc-track";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import {
  ChangesFileRow,
  PopOutDiffButton,
} from "@/components/tugways/tug-changes-list";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugOptionGroup } from "@/components/tugways/tug-option-group";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import {
  arcFileTotals,
  clusterArcFiles,
  clusterStatusLine,
  type ArcFileCluster,
} from "@/lib/arc-file-clusters";
import { arcMetaFacts } from "@/lib/arc-meta-facts";
import type { ArcChangesetEntry, ChangesetFile } from "@/lib/changeset-types";
import type { ResolveState } from "@/lib/changeset-join-store";
import { fileCountLabel } from "@/lib/commit-format";
import type { DiffDescriptor } from "@/lib/git-diff-store";
import { landingMessageParts } from "@/lib/landing-message";
import { composeSessionIdentity } from "@/lib/session-identity";
import { toolCallPhaseVisual } from "@/lib/code-session-store/tool-call-phase-visual";

// ---------------------------------------------------------------------------
// Fixtures — `consistent-atoms`, four rounds in, one replay conflict.
// ---------------------------------------------------------------------------

const ROOT = "/Users/kocienda/Mounts/u/src/tug";
const ARC = "consistent-atoms";
const BRANCH = `tugarc/${ARC}`;
const WORKTREE = `${ROOT}/.tug/arcs/${ARC}/worktree`;
const BRIEF_TITLE = "Consistent atoms: one pill height, uninventable by any call site";

/** `<status>\t<added>\t<deleted>\t<path>` — the arc's `base...branch` roster. */
const ROSTER = `A\t351\t0\ttests/app-test/at0531-atom-height-one-token.test.ts
M\t41\t62\ttests/app-test/at0477-transcript-copy-atoms.test.ts
M\t22\t31\ttests/app-test/at0264-commit-receipt-wraps.test.ts
M\t13\t21\ttests/app-test/at0435-join-refusal-speaks.test.ts
M\t24\t61\ttugdeck/src/lib/atom-identity-attrs.ts
M\t18\t47\ttugdeck/src/lib/tug-atom-chip.tsx
M\t15\t33\ttugdeck/src/lib/atom-text.ts
M\t12\t12\ttugdeck/src/lib/tug-text-types.ts
M\t9\t14\ttugdeck/src/components/tugways/tug-arc-atom.tsx
M\t8\t13\ttugdeck/src/components/tugways/tug-arc-atom.css
M\t7\t12\ttugdeck/src/components/tugways/tug-session-identity.tsx
M\t6\t11\ttugdeck/src/components/tugways/tug-session-identity.css
M\t7\t10\ttugdeck/src/components/tugways/tug-commit-atom.tsx
M\t6\t10\ttugdeck/src/components/tugways/tug-commit-atom.css
M\t5\t9\ttugdeck/src/components/tugways/tug-atom-ref.css
M\t6\t9\ttugdeck/src/components/tugways/tug-prompt-entry.tsx
M\t5\t9\ttugdeck/src/components/tugways/tug-message-editor.tsx
M\t5\t10\ttugdeck/src/components/tugways/arc-lifecycle-block.tsx
M\t5\t9\ttugdeck/src/components/tugways/tug-badge.css
M\t6\t14\ttugdeck/src/components/tugways/cards/session-commit-receipt-block.css
M\t5\t12\ttugdeck/src/components/tugways/cards/session-join-receipt-block.tsx
M\t4\t11\ttugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx
M\t4\t11\ttugdeck/src/components/tugways/cards/session-boundary.tsx
M\t4\t10\ttugdeck/src/components/tugways/cards/session-boundary.css
M\t3\t10\ttugdeck/src/components/tugways/cards/tug-atom-markdown-body.tsx
M\t3\t9\ttugdeck/src/components/tugways/cards/tug-atom-text-body.tsx
M\t3\t9\ttugdeck/src/components/tugways/cards/session-card.tsx
M\t3\t8\ttugdeck/src/components/tugways/cards/arc-picker-sheet.css
M\t3\t8\ttugdeck/src/components/tugways/cards/staged-landing.ts
M\t7\t11\ttugdeck/src/spikes/spike-session-identity.tsx
M\t0\t2\ttugdeck/src/components/arcs/arcs-card.tsx`;

const FILES: ChangesetFile[] = ROSTER.split("\n").map((line, index) => {
  const [status, added, deleted, path] = line.split("\t");
  return {
    path: path ?? "",
    git_status: status ?? "M",
    op: status === "A" ? "created" : "modified",
    origin: "arc",
    shared: false,
    last_touched: 1_757_260_000_000 - index * 60_000,
    added: Number(added),
    deleted: Number(deleted),
  };
});

const ROUND_SUBJECTS = [
  `tugarc(${ARC}): Pin the pill height to one token and read it from every seat`,
  `tugarc(${ARC}): Route the session atom's strut through the identity`,
  `tugarc(${ARC}): Give the commit atom the same strut`,
  `tugarc(${ARC}): Name the one height in tuglaws`,
];

const SUBJECT = `tugarc(${ARC}): One pill height, uninventable by any call site`;
const DRAFT_MESSAGE =
  `${SUBJECT}\n\n` +
  "Every atom on the deck — session, arc, commit, file — now stands at one height read from a single token, and no call site can invent another. The strut that held a commit pill to its baseline is the identity's own, so a pill in a transcript, a receipt, and the composer measure the same.\n\n" +
  "The two app-tests that measured the pill by hand now read the token, and `tuglaws/entity-presentation.md` names the height once.\n\n" +
  "Tug-Session: viney-mule (7c1a02de)\n" +
  "Tug-Session-Id: 68ebb98b-c6dc-4395-954d-f7c7f2cdb595\n" +
  `Tug-Arc: ${BRANCH} onto main`;

const CONFLICTS = [
  "tugdeck/src/components/arcs/arcs-card.tsx",
  "tugdeck/src/components/tugways/arc-lifecycle-block.tsx",
];
const ARCHAEOLOGY = CONFLICTS.map((path) => ({
  path,
  total: 1,
  commits: [
    {
      sha: "ea620bd60",
      subject: "tugarc(arcs-card-steps): Fold an Arcs card row open to its plan's step ledger",
    },
  ],
}));

/** The shade's arc: mid-walk, one replay conflict standing. */
const ENTRY: ArcChangesetEntry = {
  kind: "arc",
  owner_id: `${BRANCH}#a1b2c3d4`,
  display_name: ARC,
  branch: BRANCH,
  arc_kind: "planned",
  stage: "working",
  arc: { stage: "implement" },
  step_current: 5,
  step_total: 6,
  step_title: "Replay onto main and settle the conflict",
  documents: {
    brief: `${ROOT}/.tug/arcs/${ARC}/brief.md`,
    brief_title: BRIEF_TITLE,
    plan: `${ROOT}/.tug/arcs/${ARC}/plan.md`,
    plan_title: BRIEF_TITLE,
  },
  review: "reviewed",
  steps: [
    { title: "Name the one height", status: "done" },
    { title: "Read it from the session atom", status: "done" },
    { title: "Read it from the commit atom", status: "done" },
    { title: "Read it from the arc and file atoms", status: "done" },
    { title: "Replay onto main and settle the conflict", status: "in progress" },
    { title: "Retire the hand measurements", status: "pending" },
  ],
  base: "main",
  rounds: ROUND_SUBJECTS.length,
  worktree: WORKTREE,
  worktree_dirty: false,
  files: FILES,
  round_subjects: ROUND_SUBJECTS,
  draft: { message: DRAFT_MESSAGE, fingerprint: "c0ffee", updated_at: 1_757_260_000_000 },
  replay_conflict_paths: CONFLICTS,
  join: {
    phase: "conflicted",
    conflicts: CONFLICTS,
    archaeology: ARCHAEOLOGY,
  },
};

/** The Arcs card's arc: audited, a candidate standing, ready to join. */
const READY_ENTRY: ArcChangesetEntry = {
  kind: "arc",
  owner_id: "tugarc/join-report#e5f6a7b8",
  display_name: "join-report",
  branch: "tugarc/join-report",
  arc_kind: "planned",
  stage: "ready",
  arc: { stage: "audit", done: true },
  step_current: 4,
  step_total: 4,
  documents: {
    brief: `${ROOT}/.tug/arcs/join-report/brief.md`,
    brief_title: "Join report: one landing, one record",
    plan: `${ROOT}/.tug/arcs/join-report/plan.md`,
    plan_title: "Join report: one landing, one record",
  },
  review: "reviewed",
  steps: [
    { title: "Carry the receipt in the Git Commit entry", status: "done" },
    { title: "Fold the record behind the Joined boundary", status: "done" },
    { title: "Shrink the finish to a quiet line", status: "done" },
    { title: "Correct the type scale", status: "done" },
  ],
  base: "main",
  rounds: 10,
  worktree: `${ROOT}/.tug/arcs/join-report/worktree`,
  worktree_dirty: false,
  files: [],
  fit: { head: "7c1a02de", base: "e147f32f", current: true },
  join: { phase: "resolved", candidate: "7c1a02de9b1c" },
};

const IDLE_RESOLVE: ResolveState = { phase: "idle", progress: [], error: null };

const NO_ACTIONS: ArcJoinActions = {
  aim: () => {},
  answerQuestion: () => {},
  resolveBase: () => {},
  undoResolveBase: () => {},
};

const RANGE: DiffDescriptor = {
  kind: "range",
  root: ROOT,
  worktree: WORKTREE,
  base: "main",
  branch: BRANCH,
};

// ---------------------------------------------------------------------------
// The shade's arc row — the same on both sides. Only the fold changes.
// ---------------------------------------------------------------------------

function ArcRowHead({ expanded, onToggle }: { expanded: boolean; onToggle: (next: boolean) => void }) {
  return (
    <TugListRow variant="flush" density="compact">
      <ArcLifecycleBlock
        name={ARC}
        worker={null}
        model={arcTrackModelFromEntry(ENTRY)}
        stepTitle={ENTRY.step_title ?? null}
        facts={arcMetaFacts(ENTRY)}
        trailing={
          <span className="session-changes-arc-row-trailing">
            <TugPushButton
              size="2xs"
              subtype="icon"
              emphasis="ghost"
              aria-label={`Actions for arc ${ARC}`}
              icon={<EllipsisVertical size={14} />}
            />
            <PopOutDiffButton descriptor={RANGE} label={`Open the ${ARC} arc diff in a card`} />
            <BlockFoldCue
              collapsed={!expanded}
              onToggle={(nextCollapsed) => onToggle(!nextCollapsed)}
              collapsedLabel="Expand arc"
              ariaLabelExpand={`Show details for arc ${ARC}`}
              ariaLabelCollapse={`Hide details for arc ${ARC}`}
              size="2xs"
              subtype="icon"
              stabilizeScroll={false}
            />
          </span>
        }
      />
    </TugListRow>
  );
}

// ---------------------------------------------------------------------------
// Zone 1 — TODAY. The real fold, on the real components.
// ---------------------------------------------------------------------------

function ZoneToday(): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">Today — three sections, six sizes, three row heights</h2>
      <div className="sp-ae-shade">
        <TugSectionLabel label={{ name: "arc bound to this session" }} />
        <div className="session-changes-arc-row" data-expanded={expanded ? "true" : undefined}>
          <ArcRowHead expanded={expanded} onToggle={setExpanded} />
          {expanded ? (
            <div className="session-changes-arc-detail">
              <div className="session-changes-arc-documents-block">
                <TugSectionLabel label={{ name: "documents" }} />
                <SessionChangesArcDocuments
                  documents={ENTRY.documents!}
                  review={ENTRY.review}
                  steps={{ done: 4, total: 6 }}
                />
              </div>
              <SessionChangesArcJoin
                entry={ENTRY}
                join={ENTRY.join ?? null}
                error={null}
                resolve={IDLE_RESOLVE}
                actions={NO_ACTIONS}
              />
              <SessionChangesArcBrief entry={ENTRY} />
            </div>
          ) : null}
        </div>
      </div>
      <p className="sp-ae-note">
        The document titles are <code>sm</code> with <code>xs</code> facts on the same
        baseline; the conflict path is <code>sm</code> mono over <code>2xs</code> history;
        the areas take <code>--tugx-filerow-name-size</code>, which is <code>2xs</code> —
        a step below the receipt's own rows — under facts a step above them, so a
        directory's count reads larger than its path. Each directory fold is a button
        with its own padding and leading, and each nested list its own margins — that is
        the air. Measured: rows of 17px, 21px and 28px here; 22px throughout the
        candidate below.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Zone 2 — THE CANDIDATE. One row grammar, two sizes, no air.
// ---------------------------------------------------------------------------

/** The compact mono list row every line of the fold is made of. */
function Row({
  leading,
  trailing,
  children,
  hit = false,
  onClick,
}: {
  leading: React.ReactNode;
  trailing?: React.ReactNode;
  children: React.ReactNode;
  /** Whether the whole row is the gesture's target — a fold, an open. */
  hit?: boolean;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <div className={hit ? "sp-ae-row sp-ae-row-hit" : "sp-ae-row"} onClick={onClick}>
      <TugListRow
        variant="flush"
        density="compact"
        mono
        leading={leading}
        trailing={trailing !== undefined ? <span className="sp-ae-trailing">{trailing}</span> : undefined}
      >
        <span className="sp-ae-line">{children}</span>
      </TugListRow>
    </div>
  );
}

/** The 2ch leading cell — the status mark's own column, holding a glyph or an ordinal. */
function Cell({ children, tone }: { children?: React.ReactNode; tone?: "danger" | "muted" }) {
  return (
    <span className="sp-ae-cell" data-tone={tone}>
      {children}
    </span>
  );
}

function FoldCue({ open, onToggle, what }: { open: boolean; onToggle: (open: boolean) => void; what: string }) {
  return (
    <BlockFoldCue
      collapsed={!open}
      onToggle={(nextCollapsed) => onToggle(!nextCollapsed)}
      collapsedLabel="Expand"
      ariaLabelExpand={`Show ${what}`}
      ariaLabelCollapse={`Hide ${what}`}
      size="2xs"
      subtype="icon"
      stabilizeScroll={false}
    />
  );
}

function OpenCue({ what }: { what: string }) {
  return (
    <TugPushButton
      size="2xs"
      subtype="icon"
      emphasis="ghost"
      role="action"
      aria-label={`Open the ${what} in a card`}
      icon={<SquareArrowOutUpRight size={12} />}
    />
  );
}

/** Documents: glyph, the title as prose, the document's facts trailing, the open cue on the edge. */
function CandidateDocuments(): React.ReactElement {
  return (
    <>
      <TugSectionLabel label={{ name: "documents" }} />
      <Row
        hit
        leading={<Cell tone="muted"><FileText size={12} aria-hidden /></Cell>}
        trailing={
          <>
            <span className="sp-ae-fact">brief</span>
            <OpenCue what="brief" />
          </>
        }
      >
        <span className="sp-ae-prose">{BRIEF_TITLE}</span>
      </Row>
      <Row
        hit
        leading={<Cell tone="muted"><FileText size={12} aria-hidden /></Cell>}
        trailing={
          <>
            <span className="sp-ae-fact">plan · 4 of 6 done</span>
            <OpenCue what="plan" />
          </>
        }
      >
        <span className="sp-ae-prose">{BRIEF_TITLE}</span>
      </Row>
    </>
  );
}

/** Report: the conflict as a file row in the danger tone, its history hanging under it. */
function CandidateReport(): React.ReactElement {
  return (
    <>
      <TugSectionLabel label={{ name: "report" }} />
      {ARCHAEOLOGY.map((history) => (
        <React.Fragment key={history.path}>
          <Row
            leading={<Cell tone="danger"><TriangleAlert size={12} aria-hidden /></Cell>}
            trailing={<span className="sp-ae-fact sp-ae-fact-danger">conflicts with main</span>}
          >
            <span className="sp-ae-path sp-ae-path-danger">{history.path}</span>
          </Row>
          {history.commits.map((commit) => (
            <Row key={commit.sha} leading={<Cell />}>
              <span className="sp-ae-sha">{commit.sha}</span>
              <span className="sp-ae-prose sp-ae-muted">{commit.subject}</span>
            </Row>
          ))}
        </React.Fragment>
      ))}
    </>
  );
}

/** A changed file — the receipt's own row, expanding to the file's range diff. */
function CandidateFile({ file, shown }: { file: ChangesetFile; shown: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <ChangesFileRow
      file={{ path: shown, git_status: file.git_status, op: "", origin: "", shared: false }}
      projectRoot={ROOT}
      counts={{ added: file.added ?? 0, removed: file.deleted ?? 0 }}
      expanded={expanded}
      onToggle={setExpanded}
      popOut={RANGE}
      body={
        <p className="sp-ae-diff-note" role="note">
          The file's <code>base…branch</code> diff mounts here — the same <code>DiffBlock</code> a
          receipt row opens, scoped to this path.
        </p>
      }
    />
  );
}

/** A directory: a folder in the mark cell, the dir and its facts, the file row's own trailing cluster. */
function CandidateCluster({ cluster }: { cluster: ArcFileCluster }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const single = cluster.files.length === 1 ? cluster.files[0]! : null;
  if (single !== null) return <CandidateFile file={single} shown={single.path} />;
  const status = clusterStatusLine(cluster.statuses);
  const dir = cluster.dir === "" ? "/" : cluster.dir;
  return (
    <>
      <Row
        hit
        onClick={() => setOpen((v) => !v)}
        leading={<Cell tone="muted"><Folder size={12} aria-hidden /></Cell>}
        trailing={
          <>
            <DiffSummaryBadges added={cluster.added} removed={cluster.deleted} />
            <PopOutDiffButton
              descriptor={RANGE}
              label={`Open the ${dir} diff in a card`}
            />
            <FoldCue open={open} onToggle={setOpen} what={`the files under ${dir}`} />
          </>
        }
      >
        <span className="sp-ae-path">{dir}</span>
        <span className="sp-ae-fact">
          {fileCountLabel(cluster.files.length)}
          {status !== "" ? ` · ${status}` : ""}
        </span>
      </Row>
      {open ? (
        <div className="sp-ae-nested">
          {cluster.files.map((file) => (
            <CandidateFile
              key={file.path}
              file={file}
              shown={cluster.dir === "" ? file.path : file.path.slice(cluster.dir.length + 1)}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * Rounds / lands as: the subject at the block's size, the summary in the
 * receipt's message well, then the totals row — which folds the whole file
 * list, the way a receipt's header does — the areas, the rounds, and the
 * rest of the message.
 */
function CandidateBrief({ grouped }: { grouped: boolean }): React.ReactElement {
  const [filesOpen, setFilesOpen] = useState(true);
  const [roundsOpen, setRoundsOpen] = useState(false);
  const [bodyOpen, setBodyOpen] = useState(false);
  const parts = landingMessageParts(DRAFT_MESSAGE);
  const totals = arcFileTotals(FILES);
  const clusters = clusterArcFiles(FILES);
  const flat = [...FILES].sort((a, b) => a.path.localeCompare(b.path));
  return (
    <>
      <TugSectionLabel label={{ name: "draft" }} />
      <div className="sp-ae-subject">{parts.subject}</div>
      <div className="tugx-commit-receipt">
        <CommitMessage body={parts.summary} dataSlot="sp-ae-summary" />
      </div>
      <Row
        hit
        onClick={() => setFilesOpen((v) => !v)}
        leading={<Cell />}
        trailing={
          <>
            <DiffSummaryBadges added={totals.added} removed={totals.deleted} />
            <PopOutDiffButton descriptor={RANGE} label={`Open the ${ARC} arc diff in a card`} />
            <FoldCue open={filesOpen} onToggle={setFilesOpen} what="the changed files" />
          </>
        }
      >
        <span className="sp-ae-fact">
          {fileCountLabel(totals.files)} · {ENTRY.rounds} rounds · 4/6 steps
        </span>
      </Row>
      {filesOpen
        ? grouped
          ? clusters.map((cluster) => <CandidateCluster key={cluster.dir} cluster={cluster} />)
          : flat.map((file) => <CandidateFile key={file.path} file={file} shown={file.path} />)
        : null}
      <Row
        hit
        onClick={() => setRoundsOpen((v) => !v)}
        leading={<Cell tone="muted"><GitCommitHorizontal size={12} aria-hidden /></Cell>}
        trailing={<FoldCue open={roundsOpen} onToggle={setRoundsOpen} what="the rounds" />}
      >
        <span className="sp-ae-prose">{ENTRY.rounds} rounds</span>
      </Row>
      {roundsOpen
        ? ROUND_SUBJECTS.map((subject, index) => (
            <Row key={subject} leading={<Cell tone="muted">{ROUND_SUBJECTS.length - index}</Cell>}>
              <span className="sp-ae-prose">{subject}</span>
            </Row>
          ))
        : null}
      <Row
        hit
        onClick={() => setBodyOpen((v) => !v)}
        leading={<Cell tone="muted"><AlignLeft size={12} aria-hidden /></Cell>}
        trailing={<FoldCue open={bodyOpen} onToggle={setBodyOpen} what="the full message" />}
      >
        <span className="sp-ae-prose">Full message</span>
      </Row>
      {bodyOpen ? (
        <div className="tugx-commit-receipt">
          <CommitMessage body={parts.body} dataSlot="sp-ae-body" />
        </div>
      ) : null}
    </>
  );
}

const GROUPING_ITEMS = [{ value: "grouped", label: "Group by directory" }];

function ZoneCandidate(): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  const [grouping, setGrouping] = useState<string[]>(["grouped"]);
  const groupingId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    setValueStringArray: { [groupingId]: setGrouping },
  });
  const grouped = grouping.includes("grouped");
  return (
    <ResponderScope>
      <section className="sp-section" ref={responderRef as (el: HTMLElement | null) => void}>
        <h2 className="sp-section-title">Candidate — the receipt's row, everywhere in the fold</h2>
        <div className="sp-ae-options">
          <TugOptionGroup
            value={grouping}
            senderId={groupingId}
            size="xs"
            aria-label="File list shape"
            items={GROUPING_ITEMS}
          />
        </div>
        <div className="sp-ae-shade">
          <TugSectionLabel label={{ name: "arc bound to this session" }} />
          <div className="session-changes-arc-row" data-expanded={expanded ? "true" : undefined}>
            <ArcRowHead expanded={expanded} onToggle={setExpanded} />
            {expanded ? (
              <div className="sp-ae-detail">
                <CandidateDocuments />
                <CandidateReport />
                <CandidateBrief grouped={grouped} />
              </div>
            ) : null}
          </div>
        </div>
        <p className="sp-ae-note">
          Every line under the block is the compact mono <code>TugListRow</code> a commit
          receipt's file list is made of, and the changed files are the receipt's own{" "}
          <code>ChangesFileRow</code>, each expanding to its range diff. A directory is a row of
          the same grammar — a folder in the mark cell, the same counts · pop-out · fold cluster —
          and the totals line is a row that folds the whole list, the way a receipt's header
          does. The last control on every row is the one that acts on it: a fold for what
          folds, an open for a document. Two sizes: the subject keeps the block's{" "}
          <code>sm</code>, everything else is <code>xs</code>. Air between rows is the row's own
          1px; between sections it is the eyebrow's own margin.
        </p>
      </section>
    </ResponderScope>
  );
}

// ---------------------------------------------------------------------------
// Zone 3 — THE ARCS CARD. "Ready to join" is the line's own reading.
// ---------------------------------------------------------------------------

/** The session holding the arc — the eyebrow's right-hand identity. */
const WORKER = composeSessionIdentity({
  sessionId: "7c1a02de-4b6e-4f1a-9c2d-3e5f7a9b1c2d",
  name: null,
  synopsis: null,
  tag: "viney-mule",
  projectDir: ROOT,
});

function WorkerAtom(): React.ReactElement {
  return (
    <TugSessionIdentity
      identity={WORKER}
      tier="chip"
      arc={false}
      tooltip={false}
      data-slot="tug-arc-lifecycle-worker"
    />
  );
}

function ArcsTrailing(): React.ReactElement {
  return (
    <BlockFoldCue
      collapsed
      onToggle={() => {}}
      collapsedLabel="Expand"
      ariaLabelExpand="Expand steps"
      ariaLabelCollapse="Collapse steps"
      size="xs"
      subtype="icon"
    />
  );
}

/** Today: the block as the Arcs card mounts it, and the register band under it. */
function ArcsRowToday(): React.ReactElement {
  return (
    <TugListRow className="sp-ae-arcs-row" variant="flush" density="compact">
      <span className="sp-ae-arcs-block">
        <ArcLifecycleBlock
          name={READY_ENTRY.display_name}
          worker={null}
          model={arcTrackModelFromEntry(READY_ENTRY)}
          facts={arcMetaFacts(READY_ENTRY)}
          trailing={
            <>
              <WorkerAtom />
              <ArcsTrailing />
            </>
          }
        />
        <span className="sp-ae-arcs-register">
          <ArcJoinRegister
            arc={READY_ENTRY.display_name}
            base="main"
            stage={READY_ENTRY.stage}
            join={READY_ENTRY.join}
            bound
            holdersBusy={false}
            run={READY_ENTRY.arc ?? null}
            altitude="section"
          />
        </span>
      </span>
    </TugListRow>
  );
}

/**
 * The candidate: the same block, no third line. The eyebrow is exactly the
 * block's own — atom, hairline, worker, trailing. On the line, the phase
 * glyph gives way to the lifecycle dot in its settled green, and the note is
 * the register's sentence naming the base. The block's classes and pieces
 * are the real ones, composed here only because `ArcLifecycleLine` has no
 * seat yet for a mark that is not the phase glyph — that seat is the
 * graduation.
 */
function ArcsRowCandidate(): React.ReactElement {
  const model = arcTrackModelFromEntry(READY_ENTRY);
  return (
    <TugListRow className="sp-ae-arcs-row" variant="flush" density="compact">
      <span className="sp-ae-arcs-block">
        <span className="tug-arc-lifecycle-block" data-layout="stack">
          <span className="tug-arc-lifecycle-eyebrow">
            <TugArcAtom name={READY_ENTRY.display_name} slot="tug-arc-lifecycle-name" />
            <span className="tug-arc-lifecycle-rule" aria-hidden="true" />
            <WorkerAtom />
            <ArcsTrailing />
          </span>
          <span className="tug-arc-lifecycle-line">
            <TugArcTrack model={model} />
            <span className="tug-arc-lifecycle-reading">
              <TugProgressIndicator
                variant="pulsing-dot"
                size={11}
                phase="success"
                phaseVisual={toolCallPhaseVisual}
                aria-label="Ready"
                className="sp-ae-ready-dot"
              />
              <span className="tug-arc-lifecycle-note">Ready to join to {READY_ENTRY.base}</span>
              <span className="tug-arc-lifecycle-sep" aria-hidden="true">
                ·
              </span>
              <span className="tug-arc-lifecycle-fact" data-tone="subtle">
                verified
              </span>
            </span>
          </span>
        </span>
      </span>
    </TugListRow>
  );
}

function ZoneArcs(): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">Arcs card — where "Ready to join" sits</h2>
      <div className="sp-ae-arcs">
        <div className="sp-ae-arcs-caption">Today — a section band inside the row</div>
        <ArcsRowToday />
        <div className="sp-ae-arcs-caption">Candidate — the sentence is the line's own reading</div>
        <ArcsRowCandidate />
      </div>
      <p className="sp-ae-note">
        The eyebrow is unchanged: the arc atom, the hairline, the session holding it. The
        third line goes. Once the arc is ready, the line's reading becomes the register's
        sentence, naming the base it joins to, and the phase glyph gives way to the
        lifecycle dot settled green — the same dot every tool header settles on. On
        graduation, <code>ArcLifecycleLine</code> takes a mark override beside its note
        override, and the Arcs card stops mounting the register below the block.
      </p>
    </section>
  );
}


function SpikeArcEndgame(): React.ReactElement {
  return (
    <div className="sp-content">
      <ZoneToday />
      <ZoneCandidate />
      <ZoneArcs />
    </div>
  );
}

export const spike: SpikeDef = {
  name: "arc-endgame",
  title: "Arc Endgame",
  blurb:
    "Can the shade's arc fold and the Arcs card's join register read in the commit receipt's one row grammar?",
  icon: "Milestone",
  size: {
    min: { width: 560, height: 420 },
    preferred: { width: 900, height: 820 },
  },
  component: () => <SpikeArcEndgame />,
};
