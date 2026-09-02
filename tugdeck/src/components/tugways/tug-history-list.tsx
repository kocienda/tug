/**
 * `TugHistoryList` — a read-only list of commits with inline detail ([P10]).
 * One compact mono `TugListRow` per commit — the same row density as
 * {@link TugChangesList}'s file rows: the shared {@link CommitIdentityLine}
 * (`<sha> : <subject>`) leads; a reader-chosen metadata cell, a Copy control,
 * and a fold cue sit on the trailing edge, over a detail body that expands and
 * collapses in place.
 *
 * Type, leading, and layout come from the `.tugx-commit` scale
 * (`commit-presentation.css`), the same scale the `/commit` durable receipt
 * wears — one commit reads identically in the shade and in the transcript.
 *
 * The trailing metadata is a choice, not a default: `metaFields` says which of
 * author / date / time each row carries, so a reader who wants the committer
 * and one who wants the clock both get the list they asked for.
 *
 * Expanding reveals the full commit message, the commit's changed files as a
 * {@link CommitChangesList} (its own single-shot `GIT_COMMIT_FILES` request,
 * hunks lazy per row), and the committer's full identity + complete date,
 * right-aligned at the bottom. Copy writes the whole record — the complete
 * 40-char hash, attribution, and message — whatever the fold state.
 *
 * Presentation carries no lifecycle dot — a landed commit has no lifecycle.
 * Per-commit collapse is UNCONTROLLED (local `useState`, like a receipt row);
 * the detail body mounts on expand and unmounts on collapse ([L26]), so each
 * expanded row's commit-files store lives exactly as long as its body.
 *
 * ## Filtering
 *
 * The host trims the list ({@link commitFilterFields} says what a commit is
 * matched on) and passes the query down as `filterQuery` so each row can show
 * WHY it survived: the matched spans of the sha, the subject, and the join
 * badge wear the shared filter mark, and a row kept by a term that only
 * appears in its file
 * roster names the paths that matched — otherwise a commit whose subject says
 * nothing about the query reads as a mismatch the filter failed to remove.
 *
 * `filterScope` aims that match at some of the commit's surfaces rather than
 * all of them ({@link CommitFilterScope}), and the marks obey it: a mark is a
 * claim that this text is why the row is here, so text the filter was told not
 * to read is left unmarked even when the query happens to appear in it.
 *
 * Laws: [L02] the commit-files store enters React through
 * `useSyncExternalStore`; [L06] tones and hover affordances paint via CSS,
 * never React state; [L26] the detail body collapses by unmount.
 *
 * @module components/tugways/tug-history-list
 */

import "./tug-history-list.css";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type React from "react";

import { TugListRow } from "@/components/tugways/tug-list-row";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import {
  CommitCopyControl,
  CommitIdentityLine,
  CommitMessage,
  CommitMetaCell,
  commitCopyText,
  formatCommitStamp,
  type CommitMetaField,
} from "@/components/tugways/commit-presentation";
import { SHA_DISPLAY_LEN } from "@/components/tugways/commit-sha-text";
import {
  CommitChangesList,
  type CommitChangesFile,
} from "@/components/tugways/tug-changes-list";
import { useCommitIdentityMenu } from "@/components/tugways/commit-identity-menu";
import { renderFilterHighlight } from "@/components/tugways/filter-highlight";
import { TugSessionCitation } from "@/components/tugways/tug-session-identity";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { dashNameFromTrailer } from "@/lib/landing-receipt";
import { resolveCitedSession } from "@/lib/session-identity";
import {
  DEFAULT_COMMIT_FILTER_SCOPE,
  type CommitFilterScope,
} from "@/lib/commit-filter-scope";
import { filterHighlightRanges, filterQueryMatch } from "@/lib/text-match";
import type { GitLogCommit } from "@/lib/git-log-store";
import {
  createCommitFilesStore,
  EMPTY_COMMIT_FILES_SNAPSHOT,
  type GitCommitFilesStoreSnapshot,
} from "@/lib/git-commit-files-store";

/**
 * How a commit that landed as a dash join names its dash on its row ([P09]) —
 * `^<name>`, the sigil spelling every other surface uses. One function so the
 * filter matches the string the reader sees, marks land on the characters that
 * matched, and the two can never drift.
 */
function joinBadgeText(dashName: string): string {
  return `^${dashName}`;
}

/**
 * Everything a History filter matches a commit on, aimed by `scope`: its hash,
 * its message (subject + body), its details (who and when), and the paths it
 * touched. Not the diffs — a filter that read hunks would be searching the
 * repo, and this is a control for trimming a list of commits down to the ones
 * worth reading.
 *
 * The hash is matched at its full 40 characters even though rows display
 * eight, so a sha pasted from anywhere finds its commit.
 */
export function commitFilterFields(
  commit: GitLogCommit,
  scope: readonly CommitFilterScope[] = DEFAULT_COMMIT_FILTER_SCOPE,
): readonly (string | undefined)[] {
  const fields: (string | undefined)[] = [];
  if (scope.includes("hash")) {
    fields.push(commit.sha);
  }
  if (scope.includes("message")) {
    fields.push(commit.subject, commit.body);
    // The dash attribution rides with the message: `Tug-Dash:` is a trailer on
    // the message itself, and the dash atom is how the row states it. Matched
    // as the atom READS, so `^rail-routes` and the bare name both find the
    // commit and both mark the atom's name.
    const dashName = dashNameFromTrailer(commit.tug_dash);
    if (dashName !== null) fields.push(joinBadgeText(dashName));
  }
  if (scope.includes("detail")) {
    const iso = commit.committer_date ?? "";
    fields.push(
      commit.author,
      commit.committer,
      commit.committer_email,
      commit.date,
      // The stamps AS DISPLAYED, not just the raw ISO. `filterAndRank`'s
      // contract is to judge the strings the row shows, so `July 24` and
      // `7:31:26` find the commit a reader can plainly see — and the mark then
      // lands on the very characters that matched.
      formatCommitStamp(iso, "datetime"),
      formatCommitStamp(iso, "full"),
    );
  }
  if (scope.includes("files")) {
    fields.push(...(commit.files ?? []));
  }
  return fields;
}

/**
 * The query as far as one surface is concerned — itself when the filter reads
 * that surface, empty when it does not.
 *
 * A mark says "this is what the filter found". A commit kept by its subject
 * while `files` is off must not paint its paths just because the word appears
 * there too; the reader turned that surface off and the row should not argue.
 */
function scopedQuery(
  query: string,
  scope: readonly CommitFilterScope[],
  surface: CommitFilterScope,
): string {
  return scope.includes(surface) ? query : "";
}

/** How many context lines a row names before it says "and N more". */
const MATCHED_CONTEXT_LIMIT = 4;

/** Characters of a matching body line a context excerpt shows. */
const EXCERPT_WIDTH = 90;

/**
 * A window of `line` wide enough to hold its first match for `query`, with
 * ellipses where it was cut.
 *
 * The excerpt is what gets re-highlighted, so the window must CONTAIN the match
 * it was chosen for — a cut through the middle would leave the one line that
 * proved the match showing no mark at all.
 */
function matchExcerpt(line: string, query: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= EXCERPT_WIDTH) return trimmed;
  const ranges = filterHighlightRanges(query, trimmed);
  const first = ranges[0]?.[0] ?? 0;
  const last = ranges[ranges.length - 1]?.[1] ?? 0;
  // Center the window on the match, then clamp it into the line. A match wider
  // than the window keeps its whole span rather than being cut.
  const span = Math.max(EXCERPT_WIDTH, last - first);
  let start = Math.max(0, first - Math.floor((span - (last - first)) / 2));
  let end = Math.min(trimmed.length, start + span);
  start = Math.max(0, end - span);
  const head = start > 0 ? "…" : "";
  const tail = end < trimmed.length ? "…" : "";
  return `${head}${trimmed.slice(start, end)}${tail}`;
}

/**
 * The evidence a COLLAPSED row owes the reader: the message lines and the paths
 * the query found, when the row's own visible text cannot account for it.
 *
 * A commit whose subject says nothing about the query but whose body or file
 * roster does looks, collapsed, like a row the filter failed to drop. This is
 * the line that answers "why is this here" — and it is suppressed entirely when
 * the visible row already carries every term, so a plain subject match adds no
 * noise.
 *
 * Only surfaces in `scope` are cited: the line answers "why is this here", and
 * a surface the filter never read is not why.
 */
function matchedContext(
  commit: GitLogCommit,
  shortSha: string,
  query: string,
  scope: readonly CommitFilterScope[],
): readonly string[] {
  if (query === "") return [];
  // Everything the collapsed row shows AND the filter was told to read. If the
  // whole query is in here, the marks on the row itself are the explanation —
  // but a subject the filter skipped explains nothing, however it reads.
  const dashName = dashNameFromTrailer(commit.tug_dash);
  const visible = [
    scope.includes("hash") ? shortSha : "",
    scope.includes("message") ? commit.subject : "",
    scope.includes("message") && dashName !== null ? joinBadgeText(dashName) : "",
  ].join(" ");
  if (filterQueryMatch(query, [visible])) return [];
  const hits: string[] = [];
  if (scope.includes("message")) {
    for (const line of (commit.body ?? "").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (filterHighlightRanges(query, trimmed).length === 0) continue;
      hits.push(matchExcerpt(trimmed, query));
    }
  }
  if (scope.includes("files")) {
    for (const path of commit.files ?? []) {
      if (filterHighlightRanges(query, path).length > 0) hits.push(path);
    }
  }
  return hits;
}

/** Read one expanded row's commit-files store reactively ([L02]). */
function useCommitFilesSnapshot(
  root: string,
  sha: string,
): GitCommitFilesStoreSnapshot {
  // One store per expanded body: created on mount, disposed on
  // collapse/unmount (the body unmounts while collapsed, so the store's
  // lifetime tracks the expansion exactly).
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
 * The expanded detail: the message body at the shared `.tugx-commit-message`
 * scale, the commit's changed files, and finally the committer's full identity
 * + complete date, right-aligned at the bottom. The subject is NOT repeated
 * here — it leads the row above.
 */
function CommitDetail({
  commit,
  projectDir,
  filterQuery = "",
  filterScope = DEFAULT_COMMIT_FILTER_SCOPE,
}: {
  commit: GitLogCommit;
  projectDir: string;
  filterQuery?: string;
  filterScope?: readonly CommitFilterScope[];
}): React.ReactElement {
  const snapshot = useCommitFilesSnapshot(projectDir, commit.sha);
  const body = commit.body ?? "";
  const committer = commit.committer ?? commit.author;
  const email = commit.committer_email ?? "";
  const fullDate = formatCommitStamp(commit.committer_date ?? "", "full");
  const identity = email.length > 0 ? `${committer} <${email}>` : committer;
  const attribution = fullDate.length > 0 ? `${identity} · ${fullDate}` : identity;
  const files: CommitChangesFile[] =
    snapshot.payload?.files.map((f) => ({
      path: f.path,
      status: f.status,
      added: f.added,
      removed: f.removed,
    })) ?? [];
  return (
    <div className="tug-history-list-commit-detail tugx-commit-detail">
      {body.length > 0 ? (
        <CommitMessage
          body={body}
          highlightQuery={scopedQuery(filterQuery, filterScope, "message")}
          dataSlot="tug-history-list-message"
        />
      ) : null}
      {files.length > 0 ? (
        <CommitChangesList
          root={projectDir}
          sha={commit.sha}
          files={files}
          highlightQuery={scopedQuery(filterQuery, filterScope, "files")}
        />
      ) : snapshot.phase === "ready" ? (
        <div className="tug-history-list-commit-files-empty">
          No file changes.
        </div>
      ) : null}
      {/* Attribution is one string so a query spanning the name and the email
          (`ken kocienda@mac.com`) marks across the whole line, not per part. */}
      <div className="tug-history-list-commit-meta tugx-commit-attribution">
        {renderFilterHighlight(
          attribution,
          scopedQuery(filterQuery, filterScope, "detail"),
        )}
      </div>
    </div>
  );
}

/**
 * One commit's compact row + expandable detail: a `flush` `compact` `mono`
 * `TugListRow` (short sha ` : ` subject in the content column; author · date +
 * fold cue trailing) over a mount-on-expand detail body ([L26]). The whole row
 * is the fold's click target; the sha's copy menu and the trailing controls own
 * their own gestures and stop propagation.
 */
function CommitRow({
  commit,
  projectDir,
  metaFields,
  filterQuery = "",
  filterScope = DEFAULT_COMMIT_FILTER_SCOPE,
}: {
  commit: GitLogCommit;
  projectDir: string;
  metaFields: readonly CommitMetaField[];
  filterQuery?: string;
  filterScope?: readonly CommitFilterScope[];
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  // A commit that landed as a dash join carries the `Tug-Dash:` trailer;
  // History badges it so joins read differently from hand commits ([P09]).
  const dashName = dashNameFromTrailer(commit.tug_dash);
  // Which session made this commit, from its `Tug-Session*` trailers (Spec
  // S03). `null` for a commit made outside Tug, or one predating the trailers
  // — the row then simply carries no chip, which is the honest rendering of a
  // commit that never said.
  // Pure grammar over the trailer text, so the memo's inputs really are all of
  // them — the chip itself asks the ledger who that id is.
  const cited = useMemo(
    () => resolveCitedSession(commit.tug_session, commit.tug_session_id),
    [commit.tug_session, commit.tug_session_id],
  );
  const shortSha = commit.sha.slice(0, SHA_DISPLAY_LEN);
  const context = useMemo(
    () => matchedContext(commit, shortSha, filterQuery, filterScope),
    [commit, shortSha, filterQuery, filterScope],
  );
  // The whole row's right-click menu ([P10]) — every fact the commit holds,
  // including the ones no row displays (the full hash, the roster). It
  // supersedes the sha atom's lone Copy here, which is why the identity line
  // below is asked to stand its own menu down.
  const menu = useCommitIdentityMenu({
    commit: {
      sha: commit.sha,
      subject: commit.subject,
      body: commit.body,
      author: commit.committer ?? commit.author,
      email: commit.committer_email,
      dateIso: commit.committer_date,
      paths: commit.files,
    },
    expanded,
    onToggleDetail: () => setExpanded((e) => !e),
  });
  return (
    <div
      className="tug-history-list-commit-block"
      data-testid="session-history-commit"
      data-sha={commit.sha}
      data-expanded={expanded ? "true" : undefined}
    >
      {/* Primary button only — a right-click belongs to the row's commit menu,
          and must never fold the row under it. */}
      <div
        className="tug-history-list-row-hit"
        ref={menu.ref as (el: HTMLDivElement | null) => void}
        onContextMenu={menu.onContextMenu}
        onClick={(event) => {
          if (event.button !== 0) return;
          setExpanded((e) => !e);
        }}
      >
        <TugListRow
          variant="flush"
          density="compact"
          mono
          trailing={
            <span
              className="tug-history-list-row-trailing"
              onClick={(event) => event.stopPropagation()}
            >
              <CommitMetaCell
                author={commit.committer ?? commit.author}
                iso={commit.committer_date ?? ""}
                fields={metaFields}
                highlightQuery={scopedQuery(filterQuery, filterScope, "detail")}
              />
              <CommitCopyControl
                getText={() =>
                  commitCopyText({
                    sha: commit.sha,
                    subject: commit.subject,
                    body: commit.body,
                    author: commit.committer ?? commit.author,
                    email: commit.committer_email,
                    dateIso: commit.committer_date,
                  })
                }
                subject={commit.subject}
              />
              <BlockFoldCue
                collapsed={!expanded}
                onToggle={(nextCollapsed) => setExpanded(!nextCollapsed)}
                collapsedLabel="Expand commit"
                ariaLabelExpand={`Show detail for ${commit.subject}`}
                ariaLabelCollapse={`Hide detail for ${commit.subject}`}
                size="2xs"
                subtype="icon"
                stabilizeScroll={false}
                data-slot="tug-history-list-fold"
              />
            </span>
          }
        >
          <CommitIdentityLine
            sha={commit.sha}
            shaMenu={false}
            subject={commit.subject}
            author={commit.committer ?? commit.author}
            dateIso={commit.committer_date}
            shaContent={renderFilterHighlight(
              shortSha,
              scopedQuery(filterQuery, filterScope, "hash"),
            )}
            subjectContent={renderFilterHighlight(
              commit.subject,
              scopedQuery(filterQuery, filterScope, "message"),
            )}
            className="tug-history-list-commit-header"
            badge={
              <>
                {/* A real space, not a margin, between the subject and each
                    mark. The marks ride the subject's own inline flow, so a
                    long subject wraps them onto the hanging indent — and a
                    left margin is drawn there too, setting the mark in from
                    the very column the wrapped subject lines start at. A space
                    is dropped at a line break, so the mark begins the line
                    flush with the text above it and keeps its gap when it sits
                    beside the subject. */}
                {dashName !== null ? " " : null}
                {dashName !== null ? (
                  <span
                    className="tug-history-list-join-badge"
                    data-testid="session-history-join-badge"
                  >
                    <TugArcAtom
                      name={dashName}
                      register="prose"
                      slot="session-history-join-dash"
                      title={`Joined from arc ${dashName}`}
                      nameContent={renderFilterHighlight(
                        dashName,
                        scopedQuery(filterQuery, filterScope, "message"),
                      )}
                    />
                  </span>
                ) : null}
                {/* Which session made this commit, as a citation chip beside
                    the sha ([P10]). The trailer lines themselves are gone from
                    the body — tugcast strips them server-side — so this chip is
                    the only place the attribution reads, and it resolves rather
                    than merely printing an id. */}
                {cited !== null ? " " : null}
                {cited !== null ? (
                  <TugSessionCitation
                    citedId={cited.citedId}
                    recordedTag={cited.tag}
                    className="tug-history-list-session-chip"
                  />
                ) : null}
              </>
            }
          />
        </TugListRow>
      </div>
      {/* The filter's receipt for this row: the message lines and paths the
          query found, under an identity line that could not explain it. Capped
          at a visible count — a commit that touched a hundred matching files
          says so rather than quietly showing four. Hidden while expanded: the
          detail below then shows the real thing, marked in place. */}
      {context.length > 0 && !expanded ? (
        <div
          className="tug-history-list-matched-context"
          data-testid="session-history-matched-context"
        >
          {context.slice(0, MATCHED_CONTEXT_LIMIT).map((line, i) => (
            <span className="tug-history-list-matched-line" key={`${i}-${line}`}>
              {renderFilterHighlight(line, filterQuery)}
            </span>
          ))}
          {context.length > MATCHED_CONTEXT_LIMIT ? (
            <span className="tug-history-list-matched-overflow">
              and {context.length - MATCHED_CONTEXT_LIMIT} more
            </span>
          ) : null}
        </div>
      ) : null}
      {expanded ? (
        <CommitDetail
          commit={commit}
          projectDir={projectDir}
          filterQuery={filterQuery}
          filterScope={filterScope}
        />
      ) : null}
      {menu.contextMenu}
    </div>
  );
}

export interface TugHistoryListProps {
  /** The commits to render, newest first. */
  commits: readonly GitLogCommit[];
  /** The project dir the commits live in (resolves the workspace for files). */
  projectDir: string;
  /**
   * Which metadata each collapsed row carries on its trailing edge. Date and
   * time together read as one stamp; the host owns the choice (and its
   * persistence).
   */
  metaFields?: readonly CommitMetaField[];
  /**
   * The live filter query, for the rows' own account of the match — the marks
   * over the sha and subject, and the matched-path line. The host has ALREADY
   * trimmed `commits` by it; this list filters nothing itself.
   */
  filterQuery?: string;
  /**
   * Which of the commit's surfaces that query was aimed at. The rows use it for
   * their receipts only — the host already applied it when trimming — so the
   * marks and the matched-context line cite nothing the filter did not read.
   */
  filterScope?: readonly CommitFilterScope[];
  className?: string;
}

/** Date + time — a complete stamp, the reading a bare date can't give. */
const DEFAULT_META_FIELDS: readonly CommitMetaField[] = ["date", "time"];

export function TugHistoryList({
  commits,
  projectDir,
  metaFields = DEFAULT_META_FIELDS,
  filterQuery = "",
  filterScope = DEFAULT_COMMIT_FILTER_SCOPE,
  className,
}: TugHistoryListProps): React.ReactElement {
  return (
    <div
      className={
        className !== undefined
          ? `tug-history-list tugx-commit ${className}`
          : "tug-history-list tugx-commit"
      }
      data-slot="tug-history-list"
    >
      {commits.map((commit) => (
        <CommitRow
          key={commit.sha}
          commit={commit}
          projectDir={projectDir}
          metaFields={metaFields}
          filterQuery={filterQuery}
          filterScope={filterScope}
        />
      ))}
    </div>
  );
}
