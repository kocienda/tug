/**
 * Entity tips — what hovering a commit, a session, or a file says.
 *
 * An entity can be pointed at from many places: a sha appears in transcript
 * prose, in a History row, on a receipt, in a Overview ref. Before this module
 * each of those surfaces answered the hover its own way, so the same commit
 * described itself five different ways depending on which one you happened to
 * be looking at — and four of those answers were the OS `title` attribute,
 * which is not a surface we can theme, delay, or dismiss.
 *
 * The rule this module exists to hold: **one hover answer per entity kind,
 * wherever it is pointed at.** A builder here returns the `content` for a
 * {@link TugTooltip} with `variant="entity"`; the skeleton it fills is in
 * `entity-tips.css`, and the words it uses for a commit's shape come from
 * `lib/commit-format` so the hover and the badges beside it agree.
 *
 * The same rule reaches inside the commit roster, whose rows are the house
 * changed-file row and not a second drawing of it: the status letter is
 * {@link TugStatusMark} (N / M / D in the house tones, [D118]) and the counts
 * are {@link DiffSummaryBadges} (monochrome, [P27]). The hover once painted
 * four marks in four tones and tinted its counts green and red, two inches
 * from a file row in the Changes shade spelling the identical commit three
 * ways and tinting nothing — one commit, two alphabets, two type scales.
 * Neither element is themed here, so neither can drift again.
 *
 * The shape is the same for all three, because it is the order a reader
 * needs: **what it is** (the title row), **what is true of it** (meta rows),
 * then **what it touched** (the shape line and roster, commits only).
 *
 * Pure presentation: the builders take facts and return nodes. Resolving a
 * sha or an id to those facts is the caller's job.
 *
 * @module components/tugways/entity-tips
 */

import "./entity-tips.css";

import React from "react";

import { DiffSummaryBadges } from "@/components/tugways/blocks/diff-summary-badges";
import { TugStatusMark } from "@/components/tugways/tug-status-mark";
import {
  commitRoster,
  statLine,
  type CommitFileShape,
} from "@/lib/commit-format";

/** What a commit hover states. Any surface holding these can build the tip. */
export interface CommitTipFacts {
  /** The full hash — the hover is where the whole thing belongs, since the
   *  ink that triggered it only ever shows the first eight. */
  sha: string;
  /** The subject line; empty for a commit whose message is empty. */
  subject: string;
  /** Author (or committer) display name; empty when unknown. */
  author?: string;
  /** Author date, already formatted for reading. Empty when unknown. */
  date?: string;
  /** The files it touched, when the surface knows them. */
  files?: readonly CommitFileShape[];
}

/**
 * The commit hover: subject, attribution, hash, then what it touched.
 *
 * A sha is the least self-describing thing in transcript ink — eight
 * characters of hex that name a specific, knowable change and tell you
 * nothing about it. So the tip leads with the subject, because that is the
 * commit's own name for itself, then attributes it, then states its shape.
 * The roster is capped ({@link commitRoster}) and says how many files it
 * dropped: a hover is a glance, not a diff, but a glance should still tell
 * you the size of what it is not showing.
 */
export function commitTip(facts: CommitTipFacts): React.ReactNode {
  const attribution = [facts.author ?? "", facts.date ?? ""].filter(
    (part) => part !== "",
  );
  const files = facts.files ?? [];
  const roster = commitRoster(files);
  return (
    <span className="tugx-tip">
      <span className="tugx-tip-title">
        {facts.subject === "" ? facts.sha : facts.subject}
      </span>
      {attribution.length > 0 ? (
        <span className="tugx-tip-meta">{attribution.join(" · ")}</span>
      ) : null}
      <span className="tugx-tip-mono">{facts.sha}</span>
      {files.length > 0 ? (
        <>
          <span className="tugx-tip-shape">{statLine(files)}</span>
          <span className="tugx-tip-roster">
            {roster.entries.map((entry) => (
              <React.Fragment key={entry.path}>
                <TugStatusMark status={entry.mark} />
                <span className="tugx-tip-roster-path">{entry.path}</span>
                <span className="tugx-tip-roster-counts">
                  <DiffSummaryBadges
                    added={entry.added}
                    removed={entry.removed}
                  />
                </span>
              </React.Fragment>
            ))}
          </span>
          {roster.hidden > 0 ? (
            <span className="tugx-tip-more">{`… and ${roster.hidden} more`}</span>
          ) : null}
        </>
      ) : null}
    </span>
  );
}

/** What a session hover states. */
export interface SessionTipFacts {
  /** `project/callsign` — the session's identity as a reader says it. */
  identityLine: string;
  /** The session's description, when it has one. */
  description?: string | null;
  /** The flat-text citation — the form a reader would paste elsewhere. */
  citation: string;
  /**
   * A further meta row the caller renders itself, after the description.
   *
   * A node rather than a string because the fact it states may be LIVE: the
   * dash a session is bound to comes from a store, and the caller mounts a
   * subscribed leaf for it so pointing at a session does not put the surface
   * that drew it on that store's beat. Anything static should be a named
   * field here instead.
   */
  extra?: React.ReactNode;
}

/**
 * The session hover: what the run cannot show — the description, where it
 * is working, and the citation.
 */
export function sessionTip(facts: SessionTipFacts): React.ReactNode {
  return (
    <span className="tugx-tip">
      <span className="tugx-tip-title">{facts.identityLine}</span>
      {facts.description !== null && facts.description !== undefined ? (
        <span className="tugx-tip-meta">{facts.description}</span>
      ) : null}
      {facts.extra}
      <span className="tugx-tip-mono">{facts.citation}</span>
    </span>
  );
}

/** What a file hover states. */
export interface FileTipFacts {
  /** Path relative to the repo root, or absolute when that is what is known. */
  path: string;
  /** Where a rename came from, when the surface knows it. */
  renamedFrom?: string;
  /** A status word (`modified`), when the surface knows it. */
  status?: string;
}

/**
 * The file hover: the whole path, and what happened to it.
 *
 * Ink naming a file is nearly always elided — a basename in a tool header, a
 * middle-ellipsized path in a row — so the path leads, in mono, whole. A
 * rename states both ends, because the old name is the fact the new one
 * cannot carry.
 */
export function fileTip(facts: FileTipFacts): React.ReactNode {
  return (
    <span className="tugx-tip">
      <span className="tugx-tip-mono">
        {facts.renamedFrom !== undefined && facts.renamedFrom !== ""
          ? `${facts.renamedFrom} → ${facts.path}`
          : facts.path}
      </span>
      {facts.status !== undefined && facts.status !== "" ? (
        <span className="tugx-tip-meta">{facts.status}</span>
      ) : null}
    </span>
  );
}

/** What a dash hover says. */
export interface DashTipFacts {
  /** The dash's name — its address everywhere else in the app. */
  name: string;
}

/**
 * The dash hover: the name, and where the click goes.
 *
 * A dash is not a path and not a sha, so neither of the other tips fits: it
 * has no basename to elide and no subject line to quote. What a reader wants
 * before clicking is confirmation that this is a dash and that clicking will
 * take them somewhere, which is exactly the two lines here.
 */
export function dashTip(facts: DashTipFacts): React.ReactNode {
  return (
    <span className="tugx-tip">
      <span className="tugx-tip-mono">{facts.name}</span>
      <span className="tugx-tip-meta">dash — reveal in the Lens</span>
    </span>
  );
}
