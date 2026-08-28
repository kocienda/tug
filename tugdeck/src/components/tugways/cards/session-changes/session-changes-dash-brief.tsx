/**
 * `SessionChangesDashBrief` — what a dash would land, as a briefing.
 *
 * The fold used to end in three artifacts printed whole: the landing message
 * in monospace at its full length, every changed path in snapshot order, and
 * every round's subject. Each was complete and none was a summary, so the
 * reader did the summarizing. The brief inverts that: the first screen is
 * made of things that aggregate — the subject, a strip of counts, the
 * message's own summary paragraph, the tree's areas with their churn — and
 * every verbatim list stands one fold away, mounted but folded, so nothing is
 * lost and nothing has to be parsed to be understood.
 *
 * The message is one string on the wire, exactly what the join lands; the
 * subject and summary shown here are {@link landingMessageParts}'s reading of
 * its shape, and the detail is the same string's remainder. The paths cluster
 * by {@link clusterDashFiles}: the deepest directory that gathers more than
 * one changed file, ordered by lines moved, so six rows say what the change
 * is made of before a single path is read. A cluster of one file is that file.
 *
 * The brief reports and does not act ([P08]): the join is the composer's
 * gesture, the range diff is the row's pop-out. Every fold here is a
 * `data-expanded` attribute the stylesheet reads ([L06]); the folded rows stay
 * in the tree, so what a reader can reveal is what a test can find.
 *
 * Laws: [L02] props only; [L06] folds via data attributes; [L19] composes
 * `TugSectionLabel` / `TugStatusMark` / `DiffSummaryBadges` / `TugClamp` /
 * `TugPushButton`.
 *
 * @module components/tugways/cards/session-changes/session-changes-dash-brief
 */

import "./session-changes-dash-brief.css";

import React, { useState } from "react";
import { ChevronRight } from "lucide-react";

import { TugClamp } from "@/components/tugways/tug-clamp";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugStatusMark } from "@/components/tugways/tug-status-mark";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { DiffSummaryBadges } from "@/components/tugways/blocks/diff-summary-badges";
import {
  CLUSTER_LIMIT,
  clusterDashFiles,
  clusterStatusLine,
  dashFileTotals,
  type DashFileCluster,
} from "@/lib/dash-file-clusters";
import { fileCountLabel } from "@/lib/commit-format";
import { landingMessageParts } from "@/lib/landing-message";
import type { DashChangesetEntry, DashJoinOfferWire } from "@/lib/changeset-types";

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
  entry: DashChangesetEntry,
): { source: BriefMessageSource; message: string; note: string | null } {
  const offer: DashJoinOfferWire | null = entry.join?.offer ?? null;
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
function stepsFact(entry: DashChangesetEntry): string | null {
  const steps = entry.steps ?? [];
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.status === "done").length;
  return `${done}/${steps.length} steps`;
}

function ClusterRow({
  cluster,
  expanded,
  onToggle,
}: {
  cluster: DashFileCluster;
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  // A cluster of one file is that file: there is nothing under it to fold.
  const single = cluster.files.length === 1 ? cluster.files[0]! : null;
  const status = clusterStatusLine(cluster.statuses);
  return (
    <li
      className="session-changes-dash-cluster"
      data-slot="session-changes-dash-cluster"
      data-dir={cluster.dir}
      data-expanded={expanded ? "true" : "false"}
    >
      {single !== null ? (
        <div className="session-changes-dash-cluster-head">
          <TugStatusMark status={single.git_status} />
          <span className="session-changes-dash-file-path">{single.path}</span>
          <span className="session-changes-dash-cluster-counts">
            <DiffSummaryBadges added={single.added ?? 0} removed={single.deleted ?? 0} />
          </span>
        </div>
      ) : (
        <>
          <TugPushButton
            size="xs"
            emphasis="ghost"
            className="session-changes-dash-cluster-head session-changes-dash-cluster-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} the files under ${cluster.dir === "" ? "the repository root" : cluster.dir}`}
            icon={<ChevronRight size={12} className="session-changes-dash-cluster-chevron" />}
            onClick={onToggle}
          >
            <span className="session-changes-dash-cluster-dir">
              {cluster.dir === "" ? "/" : cluster.dir}
            </span>
            <span className="session-changes-dash-cluster-facts">
              {fileCountLabel(cluster.files.length)}
              {status !== "" ? ` · ${status}` : ""}
            </span>
            <span className="session-changes-dash-cluster-counts">
              <DiffSummaryBadges added={cluster.added} removed={cluster.deleted} />
            </span>
          </TugPushButton>
          <ul className="session-changes-dash-cluster-files">
            {cluster.files.map((file) => (
              <li key={file.path}>
                <TugStatusMark status={file.git_status} />
                <span className="session-changes-dash-file-path">
                  {cluster.dir === "" ? file.path : file.path.slice(cluster.dir.length + 1)}
                </span>
                <span className="session-changes-dash-cluster-counts">
                  <DiffSummaryBadges added={file.added ?? 0} removed={file.deleted ?? 0} />
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </li>
  );
}

export function SessionChangesDashBrief({
  entry,
}: {
  entry: DashChangesetEntry;
}): React.ReactElement | null {
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [allClusters, setAllClusters] = useState(false);
  const [roundsOpen, setRoundsOpen] = useState(false);
  const [bodyOpen, setBodyOpen] = useState(false);

  const { source, message, note } = briefMessage(entry);
  const parts = landingMessageParts(message);
  const subjects = entry.round_subjects ?? [];
  const clusters = clusterDashFiles(entry.files);
  const totals = dashFileTotals(entry.files);
  const steps = stepsFact(entry);

  if (source === "none" && entry.files.length === 0 && subjects.length === 0) {
    return null;
  }

  const shownClusters = allClusters ? clusters : clusters.slice(0, CLUSTER_LIMIT);
  const hiddenClusters = clusters.length - shownClusters.length;
  const eyebrow = source === "offer" ? "lands as" : source === "draft" ? "draft" : "rounds";
  const slot =
    source === "offer"
      ? "session-changes-dash-lands-as"
      : source === "draft"
        ? "session-changes-dash-draft"
        : "session-changes-dash-rounds";

  return (
    <div className="session-changes-dash-brief" data-slot={slot}>
      <TugSectionLabel label={{ name: eyebrow }} slot="session-changes-dash-brief-label" />
      <div className="session-changes-dash-brief-body">
        {parts.subject !== "" ? (
          <div className="session-changes-dash-brief-subject" data-slot="session-changes-dash-brief-subject">
            {parts.subject}
          </div>
        ) : null}
        <div className="session-changes-dash-brief-stats" data-slot="session-changes-dash-brief-stats">
          {totals.files > 0 ? <span>{fileCountLabel(totals.files)}</span> : null}
          {totals.counted ? (
            <span className="session-changes-dash-cluster-counts">
              <DiffSummaryBadges added={totals.added} removed={totals.deleted} />
            </span>
          ) : null}
          {entry.rounds > 0 ? (
            <span>{entry.rounds === 1 ? "1 round" : `${entry.rounds} rounds`}</span>
          ) : null}
          {steps !== null ? <span>{steps}</span> : null}
        </div>
        {parts.summary !== "" ? (
          <p className="session-changes-dash-brief-summary" data-slot="session-changes-dash-brief-summary">
            {parts.summary}
          </p>
        ) : null}
        {note !== null ? (
          <div className="session-changes-dash-draft-note" data-slot="session-changes-dash-lands-as-note">
            {note}
          </div>
        ) : null}
        {clusters.length > 0 ? (
          <ul className="session-changes-dash-clusters" data-slot="session-changes-dash-files">
            {shownClusters.map((cluster) => (
              <ClusterRow
                key={cluster.dir}
                cluster={cluster}
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
            ))}
            {hiddenClusters > 0 || allClusters ? (
              <li className="session-changes-dash-clusters-more">
                <TugPushButton
                  size="xs"
                  emphasis="ghost"
                  onClick={() => setAllClusters((v) => !v)}
                  data-slot="session-changes-dash-clusters-more"
                >
                  {allClusters
                    ? "Fewer areas"
                    : `${hiddenClusters} more ${hiddenClusters === 1 ? "area" : "areas"}`}
                </TugPushButton>
              </li>
            ) : null}
          </ul>
        ) : null}
        {subjects.length > 0 ? (
          <div
            className="session-changes-dash-brief-rounds"
            data-slot="session-changes-dash-brief-rounds"
            data-expanded={roundsOpen ? "true" : "false"}
          >
            <TugPushButton
              size="xs"
              emphasis="ghost"
              className="session-changes-dash-cluster-toggle"
              aria-expanded={roundsOpen}
              icon={<ChevronRight size={12} className="session-changes-dash-cluster-chevron" />}
              onClick={() => setRoundsOpen((v) => !v)}
            >
              {subjects.length === 1 ? "1 round" : `${subjects.length} rounds`}
            </TugPushButton>
            <ul className="session-changes-dash-subjects" data-slot="session-changes-dash-subjects">
              {subjects.map((subject, index) => (
                <li key={`${index}:${subject}`}>{subject}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {parts.body !== "" ? (
          parts.summary !== "" ? (
            // Summarized: the detail is the fold, and the fold is closed. The
            // summary is what the message was written to be read as.
            <div
              className="session-changes-dash-brief-detail"
              data-slot="session-changes-dash-brief-detail"
              data-expanded={bodyOpen ? "true" : "false"}
            >
              <TugPushButton
                size="xs"
                emphasis="ghost"
                className="session-changes-dash-cluster-toggle"
                aria-expanded={bodyOpen}
                icon={<ChevronRight size={12} className="session-changes-dash-cluster-chevron" />}
                onClick={() => setBodyOpen((v) => !v)}
              >
                Full message
              </TugPushButton>
              <div className="session-changes-dash-draft-message">{parts.body}</div>
            </div>
          ) : (
            // Unsummarized: the message was not written to be clamped, so
            // the clamp is the floor — a screenful, then a reveal.
            <TugClamp lines={MESSAGE_CLAMP_LINES} data-slot="session-changes-dash-brief-detail">
              <div className="session-changes-dash-draft-message">{parts.body}</div>
            </TugClamp>
          )
        ) : null}
      </div>
    </div>
  );
}
