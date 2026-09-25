/**
 * Commit presentation — the shared vocabulary every surface that shows a
 * commit draws from: the History shade's rows, the `/commit` durable receipt
 * in the transcript, and the Changes shade's commit affordances.
 *
 * Three surfaces render the same facts (a sha, a subject, a message body, a
 * committer, a timestamp, a file list) and today each states them its own way.
 * This module holds the parts they can share:
 *
 *  - {@link formatCommitStamp} — one timestamp formatter with three grains
 *    (`time`, `datetime`, `full`), so a commit's clock never reads differently
 *    on two surfaces.
 *  - {@link CommitStamp} — the timestamp as a tabular mono cell.
 *  - {@link CommitIdentityLine} — `<sha> : <subject>` with the mono hanging
 *    indent, the shared line box, and the tighter continuation leading.
 *  - {@link CommitCopyControl} — the standard header Copy affordance
 *    ({@link BlockCopyButton}), matched to the fold cue's scale.
 *  - {@link commitCopyText} — the copy payload: header line, full message,
 *    attribution, and the changed-file roster.
 *  - {@link CommitRecordBody} — the commit's record below its header: the
 *    message body, the changed-file roster, and an optional attribution line.
 *    The History shade's expanded row and the Commit card are the same
 *    component, so neither can drift from the other.
 *
 * The type scale and the layout skeleton live in `commit-presentation.css`
 * under the `.tugx-commit` scope class ([L06] appearance is CSS).
 *
 * Laws: [L02] the commit-files store enters React through
 * `useSyncExternalStore`.
 *
 * @module components/tugways/commit-presentation
 */

import "./commit-presentation.css";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type React from "react";

import { CommitShaText } from "@/components/tugways/commit-sha-text";
import { commitTip } from "@/components/tugways/entity-tips";
import { renderFilterHighlight } from "@/components/tugways/filter-highlight";
import { TugMarkdownText } from "@/components/tugways/tug-markdown-text";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { BlockCopyButton } from "@/components/tugways/body-kinds/affordances/block-copy-button";
import {
  CommitChangesList,
  type CommitChangesFile,
} from "@/components/tugways/tug-changes-list";
import {
  DEFAULT_COMMIT_FILTER_SCOPE,
  scopedQuery,
  type CommitFilterScope,
} from "@/lib/commit-filter-scope";
import {
  createCommitFilesStore,
  EMPTY_COMMIT_FILES_SNAPSHOT,
  type GitCommitFilesStoreSnapshot,
} from "@/lib/git-commit-files-store";
import {
  commitRoster,
  statLine,
  type CommitFileShape,
} from "@/lib/commit-format";

/** How much of the clock a stamp states. */
export type CommitStampGrain =
  /** `12:51:25` — the time alone. */
  | "time"
  /** `2026-07-24` — the date alone. */
  | "date"
  /** `2026-07-24 12:51:25` — sortable date + time, the full row stamp. */
  | "datetime"
  /** `Friday, July 24, 2026 at 12:51:25 PM` — the expanded detail's stamp. */
  | "full";

/**
 * Format a strict-ISO commit date at one of three grains. Returns the input
 * verbatim when it doesn't parse (a truncated record still shows something),
 * and the empty string for empty input.
 */
export function formatCommitStamp(iso: string, grain: CommitStampGrain): string {
  if (iso.length === 0) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (grain === "full") {
    return d.toLocaleString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  }
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  if (grain === "time") return time;
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return grain === "date" ? date : `${date} ${time}`;
}

/** The timestamp as a tabular mono cell — the trailing column of a commit row. */
export function CommitStamp({
  iso,
  grain,
  highlightQuery = "",
  className,
}: {
  iso: string;
  grain: CommitStampGrain;
  /** A list filter's live query, marked over the FORMATTED stamp — the string
   *  the reader actually sees, which is what the filter matches on too. */
  highlightQuery?: string;
  className?: string;
}): React.ReactElement {
  const text = formatCommitStamp(iso, grain);
  return (
    <span
      className={
        className !== undefined
          ? `tugx-commit-stamp tug-line-box ${className}`
          : "tugx-commit-stamp tug-line-box"
      }
      data-slot="commit-stamp"
      title={formatCommitStamp(iso, "full")}
    >
      {renderFilterHighlight(text, highlightQuery)}
    </span>
  );
}

/** The metadata a reader can ask a commit row to carry. */
export type CommitMetaField = "author" | "date" | "time";

/**
 * The trailing metadata cell: whichever of author / date / time the reader has
 * turned on. Date + time together read as one stamp (`2026-07-24 12:51:25`),
 * either alone reads as its own grain, and neither leaves the cell empty — the
 * cell still renders so the grid's columns hold their measure across rows.
 */
export function CommitMetaCell({
  author,
  iso,
  fields,
  highlightQuery = "",
}: {
  author: string;
  iso: string;
  fields: readonly CommitMetaField[];
  /** A list filter's live query — the cell is matchable content, so it marks. */
  highlightQuery?: string;
}): React.ReactElement {
  const wantsDate = fields.includes("date");
  const wantsTime = fields.includes("time");
  const grain: CommitStampGrain | null =
    wantsDate && wantsTime ? "datetime" : wantsDate ? "date" : wantsTime ? "time" : null;
  return (
    <span className="tugx-commit-meta tug-line-box" data-slot="commit-meta">
      {fields.includes("author") ? (
        <span>{renderFilterHighlight(author, highlightQuery)}</span>
      ) : null}
      {grain !== null ? (
        <CommitStamp iso={iso} grain={grain} highlightQuery={highlightQuery} />
      ) : null}
    </span>
  );
}

/**
 * `commit:<sha> <subject>` — the commit's identity line, the two parted by a
 * single space (the atom's glyph and its word are what separate them; a
 * heavier delimiter only spent width). The sha is a
 * {@link CommitShaText} (right-click → copy the full hash); a trailing
 * `badge` slot carries surface-specific marks (the History shade's arc-join
 * badge, say) inside the same text flow so it wraps with the subject.
 */
export function CommitIdentityLine({
  sha,
  subject,
  author,
  dateIso,
  files,
  shaContent,
  subjectContent,
  badge,
  shaMenu = true,
  onActivateSha,
  className,
}: {
  sha: string;
  subject: string;
  /**
   * What the hover adds to the words on the line. The line shows an
   * abbreviated sha and a subject that may be clipped; the tip states the
   * whole hash, who landed it and when, and — where the surface knows them —
   * the files it touched. Omitted parts are simply absent from the tip.
   */
  author?: string;
  dateIso?: string;
  files?: readonly CommitFileShape[];
  /**
   * The two `*Content` slots let a host paint the same text differently — the
   * History filter wraps its matched spans in `<mark>`. They are decoration
   * only: `sha` and `subject` remain the authority for the copy payload and
   * the `title`, so a decorated line and a plain one always SAY the same
   * thing. Omitted ⇒ the plain text.
   */
  shaContent?: React.ReactNode;
  subjectContent?: React.ReactNode;
  badge?: React.ReactNode;
  /**
   * Whether the sha keeps its own Copy menu. Off on a surface whose HOST
   * claims the right-click for the whole commit — see {@link CommitShaText}.
   * @default true
   */
  shaMenu?: boolean;
  /**
   * What a plain click on the sha's pill does — the commit's own card, on
   * every surface that knows which repository the commit lives in. Omitted ⇒
   * the pill is inert, which is what a line with no root behind it should be.
   */
  onActivateSha?: () => void;
  className?: string;
}): React.ReactElement {
  return (
    <TugTooltip
      variant="entity"
      align="start"
      content={commitTip({
        sha,
        subject,
        author,
        date: dateIso !== undefined ? formatCommitStamp(dateIso, "datetime") : undefined,
        files,
      })}
    >
      <span
        className={
          className !== undefined ? `tugx-commit-identity ${className}` : "tugx-commit-identity"
        }
        data-slot="commit-identity"
      >
        <CommitShaText
          sha={sha}
          content={shaContent}
          menu={shaMenu}
          onActivate={onActivateSha}
        />
        {" "}
        {subjectContent ?? subject}
        {badge}
      </span>
    </TugTooltip>
  );
}

/**
 * A commit's message body — the literal text of the record, markdown-styled.
 * Commit messages are written as markdown (bulleted change lists, backticked
 * paths, the odd heading), so they read as markdown here: the syntax stays
 * visible, its tones come from the shared highlight style, and a wrapped
 * bullet hangs under its content. Shared by the History shade's expanded rows
 * and the `/commit` receipt so the two can't drift.
 */
export function CommitMessage({
  body,
  highlightQuery,
  dataSlot,
  findable = false,
}: {
  /** The message body (subject excluded — it leads the identity line). */
  body: string;
  /** A list filter's live query — its matches are marked inside the syntax
   *  tones. The History filter matches on the body, so a row expanded under a
   *  filter must show WHERE it matched. */
  highlightQuery?: string;
  /** `data-slot` for the well, so each surface keeps its own test hook. */
  dataSlot: string;
  /** Opt the body into transcript Find — see `TugMarkdownText.findable`. The
   *  receipt rows set it; the History shade (outside the transcript) does
   *  not. */
  findable?: boolean;
}): React.ReactElement {
  return (
    <TugMarkdownText
      text={body}
      highlightQuery={highlightQuery}
      className="tugx-commit-message"
      dataSlot={dataSlot}
      findable={findable}
    />
  );
}

/**
 * The Copy affordance for a commit — the same icon button the tool-block
 * headers carry, at the fold cue's scale so the two read as a matched pair.
 */
export function CommitCopyControl({
  getText,
  subject,
}: {
  getText: () => string;
  /** Names the commit in the a11y label. */
  subject: string;
}): React.ReactElement {
  return (
    <BlockCopyButton
      subtype="icon"
      size="2xs"
      getText={getText}
      aria-label={`Copy commit ${subject}`}
      data-slot="commit-copy"
    />
  );
}

/** The facts a copy payload states — a superset of every surface's record. */
export interface CommitCopyFacts {
  sha: string;
  subject: string;
  /** The message body below the subject; empty for a subject-only commit. */
  body?: string;
  /** Committer (or author) display name. */
  author?: string;
  email?: string;
  /** Strict-ISO commit date. */
  dateIso?: string;
  /** The changed files, when the surface knows them. */
  files?: readonly { path: string; status: string; added: number; removed: number }[];
}

/**
 * The commit as text: the full hash and subject, the message body, the
 * attribution, and the changed-file roster — what the row shows collapsed
 * PLUS everything it reveals expanded, whatever its current fold state. A
 * pasteable record, not a screenshot of the row.
 */
export function commitCopyText(facts: CommitCopyFacts): string {
  const lines: string[] = [`commit ${facts.sha}`];
  if (facts.author !== undefined && facts.author.length > 0) {
    const email = facts.email !== undefined && facts.email.length > 0 ? ` <${facts.email}>` : "";
    lines.push(`Author: ${facts.author}${email}`);
  }
  if (facts.dateIso !== undefined && facts.dateIso.length > 0) {
    lines.push(`Date:   ${formatCommitStamp(facts.dateIso, "full")}`);
  }
  lines.push("", facts.subject);
  const body = facts.body ?? "";
  if (body.length > 0) lines.push("", body.replace(/\s+$/, ""));
  const files = facts.files ?? [];
  if (files.length > 0) {
    // The whole roster, uncapped — a copy is a record, not a glance, so the
    // hover's cap does not apply. The vocabulary is still the shared one.
    lines.push("", statLine(files));
    for (const entry of commitRoster(files, files.length).entries) {
      const counts = entry.counts === "" ? "" : `  ${entry.counts}`;
      lines.push(`  ${entry.mark}  ${entry.path}${counts}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Read one commit's changed-files store reactively ([L02]) — one store per
 * mounted body, created on mount and disposed on unmount, so its lifetime
 * tracks exactly the surface that asked for it (a History row's expansion,
 * or a Commit card's life).
 */
export function useCommitFilesSnapshot(
  root: string,
  sha: string,
): GitCommitFilesStoreSnapshot {
  const store = useMemo(() => createCommitFilesStore(), []);
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.getSnapshot ?? (() => EMPTY_COMMIT_FILES_SNAPSHOT),
    () => EMPTY_COMMIT_FILES_SNAPSHOT,
  );
  useEffect(() => {
    store?.requestFiles(root, sha);
    return () => store?.dispose();
  }, [store, root, sha]);
  return snapshot;
}

/**
 * The commit's record below whatever header states its subject: the message
 * body at the shared `.tugx-commit-message` scale, the commit's changed files
 * as a {@link CommitChangesList}, and — when the host asks for it — the
 * attribution line, right-aligned at the bottom. The subject is NOT repeated
 * here; the host's header leads with it.
 *
 * Two surfaces mount this: the History shade's expanded row, which asks for
 * the attribution line because its row header shows only date and time, and
 * the Commit card, which does not because its masthead's third line already
 * carries author, date, and time.
 *
 * The body fetches its own files, so a host that knows nothing but a sha gets
 * the same record as one that came from a log row. `body` and the attribution
 * parts override what the fetch returns, which is how the shade keeps naming
 * the COMMITTER — the reply carries the author.
 */
export function CommitRecordBody({
  root,
  sha,
  body,
  showAttribution = true,
  attributionName,
  attributionEmail,
  attributionDateIso,
  className,
  messageSlot,
  attributionClassName,
  filterQuery = "",
  filterScope = DEFAULT_COMMIT_FILTER_SCOPE,
}: {
  /** Repository root the commit is read in. */
  root: string;
  /** The commit's sha — eight characters or forty, either resolves. */
  sha: string;
  /** Message body; falls back to the fetched record's own. */
  body?: string;
  /** The trailing attribution line — on for the shade, off for the card. */
  showAttribution?: boolean;
  /** Who the attribution names; defaults to the fetched record's author. */
  attributionName?: string;
  attributionEmail?: string;
  /** Strict-ISO stamp the attribution states; defaults to the record's. */
  attributionDateIso?: string;
  /** Host framing for the body's container — the shade's recessed well. */
  className?: string;
  /** `data-slot` the host pins the message body by. */
  messageSlot?: string;
  /** Host framing for the attribution line. */
  attributionClassName?: string;
  filterQuery?: string;
  filterScope?: readonly CommitFilterScope[];
}): React.ReactElement {
  const snapshot = useCommitFilesSnapshot(root, sha);
  const record = snapshot.payload;
  const messageBody = body ?? record?.body ?? "";
  const name = attributionName ?? record?.author ?? "";
  const email = attributionEmail ?? record?.author_email ?? "";
  const fullDate = formatCommitStamp(
    attributionDateIso ?? record?.author_date ?? "",
    "full",
  );
  const identity = email.length > 0 ? `${name} <${email}>` : name;
  const attribution = fullDate.length > 0 ? `${identity} · ${fullDate}` : identity;
  const files: CommitChangesFile[] =
    record?.files.map((f) => ({
      path: f.path,
      status: f.status,
      added: f.added,
      removed: f.removed,
    })) ?? [];
  const wellClass =
    className === undefined
      ? "tugx-commit-detail"
      : `${className} tugx-commit-detail`;
  return (
    <div className={wellClass}>
      {messageBody.length > 0 ? (
        <CommitMessage
          body={messageBody}
          highlightQuery={scopedQuery(filterQuery, filterScope, "message")}
          dataSlot={messageSlot ?? "commit-record-message"}
        />
      ) : null}
      {files.length > 0 ? (
        <CommitChangesList
          root={root}
          sha={sha}
          files={files}
          highlightQuery={scopedQuery(filterQuery, filterScope, "files")}
        />
      ) : snapshot.phase === "ready" ? (
        <div className="tugx-commit-files-empty">No file changes.</div>
      ) : null}
      {/* Attribution is one string so a query spanning the name and the email
          (`ken kocienda@mac.com`) marks across the whole line, not per part. */}
      {showAttribution ? (
        <div
          className={
            attributionClassName === undefined
              ? "tugx-commit-attribution"
              : `${attributionClassName} tugx-commit-attribution`
          }
        >
          {renderFilterHighlight(
            attribution,
            scopedQuery(filterQuery, filterScope, "detail"),
          )}
        </div>
      ) : null}
    </div>
  );
}
