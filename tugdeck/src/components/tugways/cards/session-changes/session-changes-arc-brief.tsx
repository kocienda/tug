/**
 * `SessionChangesArcBrief` — what an arc would land, as a briefing.
 *
 * The fold used to end in three artifacts printed whole: the landing message
 * in monospace at its full length, every changed path in snapshot order, and
 * every round's subject. Each was complete and none was a summary, so the
 * reader did the summarizing. The brief inverts that: the first screen is
 * made of things that aggregate — the subject, the message's own summary
 * paragraph, a totals row, the tree's areas with their churn — and every
 * verbatim list stands one fold away, mounted but folded, so nothing is lost
 * and nothing has to be parsed to be understood.
 *
 * The message is one string on the wire, exactly what the join lands; the
 * subject and summary shown here are {@link landingMessageParts}'s reading of
 * its shape, and the detail is the same string's remainder. The paths cluster
 * by {@link clusterArcFiles}: the deepest directory that gathers more than
 * one changed file, ordered by lines moved, so six rows say what the change
 * is made of before a single path is read. A cluster of one file is that file.
 *
 * **A changed file here is the commit receipt's own row** — `ArcRangeFileRow`,
 * from `tug-changes-list.tsx` — so expanding one mounts that file's
 * `base…branch` diff and nothing else ([B02], [P04]). The row's pop-out and
 * every directory row's are scoped to the paths they name ([P01]); the totals
 * row's is the whole range, which is what that row is about.
 *
 * Every other line is the fold's one `ArcFoldRow`, so the section has one row
 * height and one size throughout — the receipt's grammar, which is the surface
 * this fold was always trying to read like.
 *
 * The brief reports and does not act ([P08]): the join is the composer's
 * gesture, the range diff is the row's pop-out. Every fold here is either a
 * `data-expanded` attribute the stylesheet reads ([L06]) or a row that mounts
 * on expand ([L26]).
 *
 * Laws: [L02] props only; [L06] folds via data attributes; [L19] composes
 * `TugSectionLabel` / `ArcFoldRow` / `ChangesFileRow` / `DiffSummaryBadges` /
 * `BlockFoldCue` / `CommitMessage` / `TugClamp`; [L26] a file row's diff body
 * mounts on expand and a refetch keeps it rather than remounting it.
 *
 * @module components/tugways/cards/session-changes/session-changes-arc-brief
 */

import "./session-changes-arc-fold.css";

import React, { useState } from "react";
import { AlignLeft, Folder, GitCommitHorizontal } from "lucide-react";

import { TugClamp } from "@/components/tugways/tug-clamp";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { DiffSummaryBadges } from "@/components/tugways/blocks/diff-summary-badges";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { CommitMessage } from "@/components/tugways/commit-presentation";
import {
  ArcRangeFileRow,
  PopOutDiffButton,
} from "@/components/tugways/tug-changes-list";
import {
  ArcFoldCell,
  ArcFoldRow,
} from "@/components/tugways/cards/session-changes/session-changes-arc-fold-row";
import {
  clusterArcFiles,
  clusterStatusLine,
  arcFileTotals,
  type ArcFileCluster,
} from "@/lib/arc-file-clusters";
import { fileCountLabel } from "@/lib/commit-format";
import { landingMessageParts } from "@/lib/landing-message";
import type { DiffDescriptor } from "@/lib/git-diff-store";
import type { ArcChangesetEntry, ArcJoinOfferWire } from "@/lib/changeset-types";

/** Where the message the brief fronts came from, and the eyebrow it earns. */
export type BriefMessageSource = "offer" | "draft" | "none";

/**
 * Where a standing join's message came from, when the precedence fell
 * through to something nobody wrote ([P05]). A `draft` source carries no
 * note: the absence is how the offer says these are the author's own words.
 * Keyed on the wire spellings `LandingMessageSource::as_str` emits.
 */
const LANDING_MESSAGE_PROVENANCE: Record<string, string | undefined> = {
  description: "from the branch description — no draft was written",
  fallback: "no draft and no description — the generic stand-in",
};

/** How many lines of an unsummarized message show before the clamp. */
const MESSAGE_CLAMP_LINES = 5;

/**
 * The brief's message and its provenance: the offer's when a join stands,
 * else the draft's, else none — the same precedence the old fold's two arms
 * had, as one value.
 */
export function briefMessage(
  entry: ArcChangesetEntry,
): { source: BriefMessageSource; message: string; note: string | null } {
  const offer: ArcJoinOfferWire | null = entry.join?.offer ?? null;
  if (offer !== null) {
    return {
      source: "offer",
      message: offer.message ?? "",
      note: LANDING_MESSAGE_PROVENANCE[offer.message_source ?? ""] ?? null,
    };
  }
  if (entry.draft !== undefined) {
    return { source: "draft", message: entry.draft.message, note: null };
  }
  return { source: "none", message: "", note: null };
}

/** `4/4 steps` when there is a walk to count, else nothing. */
function stepsFact(entry: ArcChangesetEntry): string | null {
  const steps = entry.steps ?? [];
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.status === "done").length;
  return `${done}/${steps.length} steps`;
}

/** Where a file row addresses its range from. One object, threaded down. */
interface RangeAddress {
  root: string;
  worktree: string;
  base: string;
  branch: string;
}

/**
 * A directory: a folder in the mark cell, the dir and its facts, and the file
 * row's own trailing cluster — counts, then a pop-out scoped to this
 * directory's files, then the fold cue. The last control on a row is the one
 * that acts on it, which is the order `ChangesFileRow` already keeps.
 *
 * A cluster of one file is that file: there is nothing under it to fold.
 */
function ClusterRow({
  cluster,
  address,
  expanded,
  onToggle,
}: {
  cluster: ArcFileCluster;
  address: RangeAddress;
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const single = cluster.files.length === 1 ? cluster.files[0]! : null;
  if (single !== null) {
    return <ArcRangeFileRow {...address} file={single} shown={single.path} />;
  }
  const status = clusterStatusLine(cluster.statuses);
  const dir = cluster.dir === "" ? "/" : cluster.dir;
  const scoped: DiffDescriptor = {
    kind: "range",
    root: address.root,
    worktree: address.worktree,
    base: address.base,
    branch: address.branch,
    paths: cluster.files.map((file) => file.path),
  };
  return (
    <div
      className="session-changes-arc-cluster"
      data-slot="session-changes-arc-cluster"
      data-dir={cluster.dir}
      data-expanded={expanded ? "true" : "false"}
    >
      <ArcFoldRow
        hit
        wrapperProps={{
          role: "button",
          tabIndex: 0,
          "aria-expanded": expanded,
          "aria-label": `${expanded ? "Hide" : "Show"} the files under ${cluster.dir === "" ? "the repository root" : cluster.dir}`,
          onClick: onToggle,
          onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onToggle();
          },
        }}
        leading={
          <ArcFoldCell tone="muted">
            <Folder size={12} aria-hidden />
          </ArcFoldCell>
        }
        trailing={
          <span className="arc-fold-trailing" onClick={(event) => event.stopPropagation()}>
            <DiffSummaryBadges added={cluster.added} removed={cluster.deleted} />
            <PopOutDiffButton
              descriptor={scoped}
              label={`Open the ${dir} diff in a card`}
            />
            <BlockFoldCue
              collapsed={!expanded}
              onToggle={onToggle}
              collapsedLabel="Expand"
              ariaLabelExpand={`Show the files under ${dir}`}
              ariaLabelCollapse={`Hide the files under ${dir}`}
              size="2xs"
              subtype="icon"
              stabilizeScroll={false}
            />
          </span>
        }
      >
        <span className="arc-fold-path">{dir}</span>
        <span className="arc-fold-fact">
          {fileCountLabel(cluster.files.length)}
          {status !== "" ? ` · ${status}` : ""}
        </span>
      </ArcFoldRow>
      {expanded ? (
        <div className="arc-fold-nested">
          {cluster.files.map((file) => (
            <ArcRangeFileRow
              key={file.path}
              {...address}
              file={file}
              shown={
                cluster.dir === ""
                  ? file.path
                  : file.path.slice(cluster.dir.length + 1)
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SessionChangesArcBrief({
  entry,
  projectRoot,
  branch,
}: {
  entry: ArcChangesetEntry;
  /** The project dir the arc lives in — resolves the workspace for every
   *  scoped range diff this section opens. */
  projectRoot: string;
  /** The arc's branch ref, as the lane resolves it. */
  branch: string;
}): React.ReactElement | null {
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(() => new Set());
  // Open, as the candidate is: the fold cue is a way to get the list out of
  // the way, not a gate in front of it.
  const [filesOpen, setFilesOpen] = useState(true);
  const [roundsOpen, setRoundsOpen] = useState(false);
  const [bodyOpen, setBodyOpen] = useState(false);

  const { source, message, note } = briefMessage(entry);
  const parts = landingMessageParts(message);
  const subjects = entry.round_subjects ?? [];
  const clusters = clusterArcFiles(entry.files);
  const totals = arcFileTotals(entry.files);
  const steps = stepsFact(entry);

  if (source === "none" && entry.files.length === 0 && subjects.length === 0) {
    return null;
  }

  const address: RangeAddress = {
    root: projectRoot,
    worktree: entry.worktree,
    base: entry.base,
    branch,
  };
  const wholeRange: DiffDescriptor = { kind: "range", ...address };
  // The totals row's content: the facts the stats strip used to carry, each
  // clause omitted when it has nothing to say ([P05]).
  const totalsFacts = [
    totals.files > 0 ? fileCountLabel(totals.files) : null,
    entry.rounds > 0
      ? entry.rounds === 1
        ? "1 round"
        : `${entry.rounds} rounds`
      : null,
    steps,
  ].filter((fact): fact is string => fact !== null);

  const eyebrow = source === "offer" ? "lands as" : source === "draft" ? "draft" : "rounds";
  // The totals row stands on its own facts. It is the file list's head when
  // there is a list — that is what its fold cue and its range pop-out are for
  // — but the rounds and the steps it also states are true of an arc that has
  // a draft and has not moved a file yet, and the strip it replaced said them
  // on such an arc. So the affordances are the list's and the row is not.
  const hasFiles = clusters.length > 0;
  const slot =
    source === "offer"
      ? "session-changes-arc-lands-as"
      : source === "draft"
        ? "session-changes-arc-draft"
        : "session-changes-arc-rounds";

  return (
    <div className="session-changes-arc-brief" data-slot={slot}>
      <TugSectionLabel label={{ name: eyebrow }} slot="session-changes-arc-brief-label" />
      <div className="session-changes-arc-brief-body">
        {parts.subject !== "" ? (
          <div
            className="session-changes-arc-brief-subject"
            data-slot="session-changes-arc-brief-subject"
          >
            {parts.subject}
          </div>
        ) : null}
        {parts.summary !== "" ? (
          <div className="tugx-commit-receipt">
            <CommitMessage
              body={parts.summary}
              dataSlot="session-changes-arc-brief-summary"
            />
          </div>
        ) : null}
        {note !== null ? (
          <div
            className="session-changes-arc-draft-note"
            data-slot="session-changes-arc-lands-as-note"
          >
            {note}
          </div>
        ) : null}
        {hasFiles || totalsFacts.length > 0 ? (
          <div
            className="session-changes-arc-clusters"
            data-slot="session-changes-arc-files"
            data-expanded={filesOpen ? "true" : "false"}
          >
            {/* The totals row, which folds the whole list the way a receipt's
                header folds its own. Its pop-out is the unscoped range: what
                this row is about is everything below it. */}
            <ArcFoldRow
              hit={hasFiles}
              wrapperProps={
                hasFiles
                  ? {
                      role: "button",
                      tabIndex: 0,
                      "aria-expanded": filesOpen,
                      "aria-label": `${filesOpen ? "Hide" : "Show"} the changed files`,
                      "data-slot": "session-changes-arc-totals",
                      onClick: () => setFilesOpen((v) => !v),
                      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        setFilesOpen((v) => !v);
                      },
                    }
                  : { "data-slot": "session-changes-arc-totals" }
              }
              leading={<ArcFoldCell />}
              trailing={
                hasFiles ? (
                  <span className="arc-fold-trailing" onClick={(event) => event.stopPropagation()}>
                    {totals.counted ? (
                      <DiffSummaryBadges added={totals.added} removed={totals.deleted} />
                    ) : null}
                    <PopOutDiffButton
                      descriptor={wholeRange}
                      label={`Open the ${entry.display_name} arc diff in a card`}
                    />
                    <BlockFoldCue
                      collapsed={!filesOpen}
                      onToggle={(nextCollapsed) => setFilesOpen(!nextCollapsed)}
                      collapsedLabel="Expand"
                      ariaLabelExpand="Show the changed files"
                      ariaLabelCollapse="Hide the changed files"
                      size="2xs"
                      subtype="icon"
                      stabilizeScroll={false}
                    />
                  </span>
                ) : undefined
              }
            >
              <span className="arc-fold-fact">{totalsFacts.join(" · ")}</span>
            </ArcFoldRow>
            {hasFiles && filesOpen
              ? clusters.map((cluster) => (
                  <ClusterRow
                    key={cluster.dir}
                    cluster={cluster}
                    address={address}
                    expanded={openDirs.has(cluster.dir)}
                    onToggle={() =>
                      setOpenDirs((prev) => {
                        const next = new Set(prev);
                        if (next.has(cluster.dir)) next.delete(cluster.dir);
                        else next.add(cluster.dir);
                        return next;
                      })
                    }
                  />
                ))
              : null}
          </div>
        ) : null}
        {subjects.length > 0 ? (
          <div
            className="session-changes-arc-brief-rounds"
            data-slot="session-changes-arc-brief-rounds"
            data-expanded={roundsOpen ? "true" : "false"}
          >
            <ArcFoldRow
              hit
              wrapperProps={{
                role: "button",
                tabIndex: 0,
                "aria-expanded": roundsOpen,
                onClick: () => setRoundsOpen((v) => !v),
                onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setRoundsOpen((v) => !v);
                },
              }}
              leading={
                <ArcFoldCell tone="muted">
                  <GitCommitHorizontal size={12} aria-hidden />
                </ArcFoldCell>
              }
              trailing={
                <span className="arc-fold-trailing" onClick={(event) => event.stopPropagation()}>
                  <BlockFoldCue
                    collapsed={!roundsOpen}
                    onToggle={(nextCollapsed) => setRoundsOpen(!nextCollapsed)}
                    collapsedLabel="Expand"
                    ariaLabelExpand="Show the rounds"
                    ariaLabelCollapse="Hide the rounds"
                    size="2xs"
                    subtype="icon"
                    stabilizeScroll={false}
                  />
                </span>
              }
            >
              <span className="arc-fold-prose">
                {subjects.length === 1 ? "1 round" : `${subjects.length} rounds`}
              </span>
            </ArcFoldRow>
            {/* The subjects stay in the tree whether or not the fold is open,
                so what a reader can reveal is what a test can find ([L06]). */}
            <div
              className="session-changes-arc-subjects"
              data-slot="session-changes-arc-subjects"
            >
              {subjects.map((subject, index) => (
                <ArcFoldRow
                  key={`${index}:${subject}`}
                  leading={
                    // Counting down from the newest, which is the order the
                    // subjects arrive in.
                    <ArcFoldCell tone="muted">{subjects.length - index}</ArcFoldCell>
                  }
                >
                  <span className="arc-fold-prose">{subject}</span>
                </ArcFoldRow>
              ))}
            </div>
          </div>
        ) : null}
        {parts.body !== "" ? (
          parts.summary !== "" ? (
            // Summarized: the detail is the fold, and the fold is closed. The
            // summary is what the message was written to be read as.
            <div
              className="session-changes-arc-brief-detail"
              data-slot="session-changes-arc-brief-detail"
              data-expanded={bodyOpen ? "true" : "false"}
            >
              <ArcFoldRow
                hit
                wrapperProps={{
                  role: "button",
                  tabIndex: 0,
                  "aria-expanded": bodyOpen,
                  onClick: () => setBodyOpen((v) => !v),
                  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setBodyOpen((v) => !v);
                  },
                }}
                leading={
                  <ArcFoldCell tone="muted">
                    <AlignLeft size={12} aria-hidden />
                  </ArcFoldCell>
                }
                trailing={
                  <span className="arc-fold-trailing" onClick={(event) => event.stopPropagation()}>
                    <BlockFoldCue
                      collapsed={!bodyOpen}
                      onToggle={(nextCollapsed) => setBodyOpen(!nextCollapsed)}
                      collapsedLabel="Expand"
                      ariaLabelExpand="Show the full message"
                      ariaLabelCollapse="Hide the full message"
                      size="2xs"
                      subtype="icon"
                      stabilizeScroll={false}
                    />
                  </span>
                }
              >
                <span className="arc-fold-prose">Full message</span>
              </ArcFoldRow>
              <div className="tugx-commit-receipt session-changes-arc-draft-message">
                <CommitMessage body={parts.body} dataSlot="session-changes-arc-brief-body" />
              </div>
            </div>
          ) : (
            // Unsummarized: the message was not written to be clamped, so
            // the clamp is the floor — a screenful, then a reveal.
            <TugClamp lines={MESSAGE_CLAMP_LINES} data-slot="session-changes-arc-brief-detail">
              <div className="session-changes-arc-draft-message">{parts.body}</div>
            </TugClamp>
          )
        ) : null}
      </div>
    </div>
  );
}
