/**
 * session-arc-brief — what the arc canvas's Brief card says of an arc's
 * brief.
 *
 * `ArcBriefDetail` is what the card shows at rest: where the brief is. The
 * path is the control that opens it: it reads as a link under the pointer or
 * keyboard focus, and a press opens the file through the `OPEN_FILE` command
 * beside the card this stands in. `ArcBriefHeadings` is what the card shows
 * when it is open: the findings and decisions the brief marks, read from the
 * file when the card opens.
 *
 * Laws: [L02] the brief's headings enter through `useSyncExternalStore`
 *       inside `useBriefHeadings`, [L06] the link's look is CSS on hover and
 *       focus, [L16] pairings declared, [L19] component authoring guide,
 *       [L30] opening the file is the `OPEN_FILE` command
 */

import "./session-arc-brief.css";

import React from "react";

import { dispatchCommand } from "@/command-dispatch";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useCardId } from "@/components/tugways/use-card-state-preservation";
import { documentDisplayPath } from "@/lib/arc-join-fold";
import { useBriefHeadings } from "@/lib/brief-headings-store";

export interface ArcBriefDetailProps {
  /** The brief's absolute path. */
  path: string;
  /** The project the arc is in; the path is shown relative to it. */
  projectDir: string;
}

/** Where the brief is: its path, which opens it. */
export function ArcBriefDetail({ path, projectDir }: ArcBriefDetailProps): React.ReactElement {
  // The card this stands in, which the brief's Text card opens beside.
  const hostCardId = useCardId();
  return (
    <div className="session-arc-brief-detail" data-slot="session-arc-brief-detail">
      <button
        type="button"
        className="session-arc-brief-path"
        data-slot="session-arc-brief-path"
        title="Open in a text card"
        onClick={() =>
          dispatchCommand(TUG_ACTIONS.OPEN_FILE, {
            path,
            ...(hostCardId !== null ? { originCardId: hostCardId } : {}),
          })
        }
      >
        {documentDisplayPath(path, projectDir)}
      </button>
    </div>
  );
}

export interface ArcBriefHeadingsProps {
  /** The brief's absolute path. */
  path: string;
}

/** The findings and decisions the brief marks, in the order it writes them. */
export function ArcBriefHeadings({ path }: ArcBriefHeadingsProps): React.ReactElement | null {
  const reading = useBriefHeadings(path);
  if (reading.status === "loading") return null;
  if (reading.status === "unreadable") {
    return (
      <p className="session-arc-brief-note" data-slot="session-arc-brief-note">
        The brief could not be read.
      </p>
    );
  }
  if (reading.headings.length === 0) {
    return (
      <p className="session-arc-brief-note" data-slot="session-arc-brief-note">
        This brief marks no findings or decisions.
      </p>
    );
  }
  return (
    <ul className="session-arc-brief-headings" data-slot="session-arc-brief-headings">
      {reading.headings.map((heading) => (
        <li
          key={heading.tag}
          className="session-arc-brief-heading"
          data-slot="session-arc-brief-heading"
          data-kind={heading.kind}
        >
          <span className="session-arc-brief-heading-tag">{heading.tag}</span>
          <span className="session-arc-brief-heading-title">{heading.title}</span>
        </li>
      ))}
    </ul>
  );
}
