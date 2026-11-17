/**
 * ChartRefReport — the report under a chart mark: what the mark counted, as
 * rows, a page at a time.
 *
 * Mounted by `useChartReportPortals` into the host a figure stamps when a
 * set is pressed. It reads its pages from `chart-report-store` by the
 * report's id and draws a head (the title, the set's sum, Copy, Close), a line saying when
 * the source no longer agrees with the chart, the rows, and a foot that
 * reads the next page. A commit row is the History card's own row, read from
 * `chart-report-row-registry` where the History list names it, so it folds
 * to the commit's message and files, raises the commit's card from its pill,
 * and carries the commit's menu. A session row is the session's own citation
 * with its title, its project and when it was last used; an arc row is the
 * arc's atom with its fate, the commit it landed as, when it started and
 * ended, and how many of its steps were committed. Neither folds. A file's
 * or a directory's row is its path with the file's hover and click and the
 * count of commits touching it, and it folds: unfolded, it holds a report of
 * its own, the commits touching that path, registered when it opens and
 * dropped when it closes. A command's row is its head with how often it ran
 * long and for how long in all; a url's is its host and path, opened as a
 * link is. A run's row is one recorded test run: a status dot, the status,
 * when it ended, how long it took, how many of its tests passed, and the
 * commit it stood on. A span's row is one stage or step of an arc: its
 * label, when it started and ended, how long it ran, and the session or the
 * commit it links. A row nothing answered for, and a row of a kind with no
 * component of its own, is its ref's label as plain text.
 *
 * When the recipe measured its members, each row ends in that member's share
 * of the mark and the head carries the set's sum with its unit. Both texts
 * are the answer's own, written by the formatter that drew the chart's
 * labels; nothing is formatted here.
 *
 * The panel around it is the figure's DOM, and closing is the figure's act:
 * Close calls `closeReport`, which removes the panel and drops the report.
 * A figure rebuilt under its reader mounts this again on the same report,
 * so nothing here may assume a mount is an opening.
 *
 * Composes the registered commit row, `SessionCitation`, `TugArcAtom`,
 * `TugCommitAtom`, `TugTooltip`, `BlockFoldCue`, `BlockCopyButton`,
 * `TugPushButton` and `TugIconButton`, each keeping its own tokens.
 *
 * Laws: [L02] the pages are read through `useSyncExternalStore`, [L06] the
 *       note, the groups and the foot are presence in the tree, with no
 *       state of their own, [L16] pairings declared, [L19] component
 *       authoring guide, [L20] composed children keep their tokens, [L26] a
 *       row's key is its place and its ref, so a page appended beneath
 *       leaves every fold above as it is, and a path's nested list mounts
 *       when its row unfolds and unmounts when it folds, [L27] a nested
 *       report is dropped by the fold and with its parent, [L31] a
 *       read that failed says so in the panel, [L33] with a Retry beside it.
 */

import "./chart-ref-report.css";

import React from "react";
import { X } from "lucide-react";

import { BlockCopyButton } from "@/components/tugways/body-kinds/affordances/block-copy-button";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { SessionCitation } from "@/components/tugways/cards/session-identity";
import { reportCommitRow } from "@/components/tugways/chart-report-row-registry";
import type { CommitMetaField } from "@/components/tugways/commit-presentation";
import { fileTip } from "@/components/tugways/entity-tips";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { TugCommitAtom } from "@/components/tugways/tug-commit-atom";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { ANNOTATION_CLASS } from "@/lib/annotator/types";
import { closeReport } from "@/lib/chart/chart-ref-set";
import {
  driftNote,
  footText,
  groupBreaks,
  loadReportPage,
  nestedReport,
  newReportId,
  registerReport,
  reportTitle,
  setNestedReport,
  useChartReport,
  type ReportArc,
  type ReportCommand,
  type ReportDescriptor,
  type ReportPath,
  type ReportRow,
  type ReportRun,
  type ReportSession,
  type ReportSpan,
  type ReportUrl,
} from "@/lib/chart/chart-report-store";
import { counted, refLabel, refValueOf } from "@/lib/chart/chart-table-refs";
import { formatCommitStamp } from "@/lib/commit-format";
import { formatDurationMs } from "@/lib/session-telemetry-format";

/** Date and time: the stamp a History row carries. */
const META_FIELDS: readonly CommitMetaField[] = ["date", "time"];

export interface ChartRefReportProps {
  /** The report's id, as the figure registered it. */
  id: string;
}

/** A moment in milliseconds as a History row writes a stamp, or "" for none. */
function stamp(ms: number | null): string {
  if (ms === null) return "";
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? "" : formatCommitStamp(at.toISOString(), "datetime");
}

/** A session: its citation, then what the index holds of it. */
function SessionRow({ record }: { record: ReportSession }): React.ReactElement {
  const used = stamp(record.updatedAtMs);
  return (
    <span className="tugx-chart-report-entity" data-slot="chart-report-session">
      <SessionCitation citedId={record.id} recordedTag={record.callsign} />
      {record.title !== null && record.title !== "" ? (
        <span className="tugx-chart-report-entity-title">{record.title}</span>
      ) : null}
      {record.projectLeaf !== "" ? <span className="tugx-chart-report-fact">{record.projectLeaf}</span> : null}
      {used !== "" ? <span className="tugx-chart-report-fact">last used {used}</span> : null}
    </span>
  );
}

/** An arc: its atom, then what the log holds of it. */
function ArcRow({ record }: { record: ReportArc }): React.ReactElement {
  const started = stamp(record.startedAtMs);
  const ended = stamp(record.endedAtMs);
  return (
    <span className="tugx-chart-report-entity" data-slot="chart-report-arc">
      <TugArcAtom name={record.name} />
      <span className="tugx-chart-report-fact" data-fate={record.fate}>
        {record.fate}
      </span>
      {record.fate === "joined" && record.joinSha !== null ? <TugCommitAtom sha={record.joinSha} /> : null}
      {started !== "" ? <span className="tugx-chart-report-fact">started {started}</span> : null}
      {ended !== "" ? <span className="tugx-chart-report-fact">ended {ended}</span> : null}
      {record.stepCommits > 0 ? (
        <span className="tugx-chart-report-fact">
          {record.stepCommits} {record.stepCommits === 1 ? "step" : "steps"} committed
        </span>
      ) : null}
    </span>
  );
}

/**
 * A file or a directory: its path, how many commits touch it, and a fold
 * that holds those commits. A path the disk still holds takes the file's
 * hover, click and menu through the annotation it is stamped with; one that
 * is gone is its words.
 */
function PathRow({
  row,
  record,
  descriptor,
}: {
  row: ReportRow;
  record: ReportPath;
  descriptor: ReportDescriptor;
}): React.ReactElement {
  // The fold is the store's: a panel mounted again on the same report finds
  // its rows unfolded as the reader left them.
  const ref = row.ref;
  const [nested, setNested] = React.useState<string | null>(() =>
    ref === null ? null : nestedReport(descriptor.id, ref),
  );
  const onToggle = (nextCollapsed: boolean): void => {
    if (ref === null) return;
    let id: string | null = null;
    if (!nextCollapsed) {
      id = newReportId();
      registerReport({
        id,
        projectDir: descriptor.projectDir,
        kind: "commit",
        rowLabel: null,
        seriesName: null,
        slotCount: record.commits ?? 0,
        of: ref,
        ...(descriptor.source !== undefined ? { source: descriptor.source } : {}),
      });
    }
    setNestedReport(descriptor.id, ref, id);
    setNested(id);
  };

  const absolute = (
    record.path.startsWith("/") ? record.path : `${descriptor.projectDir.replace(/\/+$/, "")}/${record.path}`
  ).replace(/(.)\/+$/, "$1");
  return (
    <>
      <span className="tugx-chart-report-entity" data-slot="chart-report-path">
        {record.exists ? (
          <TugTooltip variant="entity" align="start" content={fileTip({ path: absolute })}>
            <span
              className={`tugx-chart-report-ref tugx-chart-report-path ${ANNOTATION_CLASS}`}
              data-tug-annotation={row.kind === "dir" ? "directory" : "file-path"}
              data-path={absolute}
              data-tug-focus="refuse"
              data-no-activate=""
            >
              {record.path}
            </span>
          </TugTooltip>
        ) : (
          <span className="tugx-chart-report-path tugx-chart-report-plain">{record.path}</span>
        )}
        {record.commits !== null ? (
          <span className="tugx-chart-report-fact">{counted(record.commits, "commit")}</span>
        ) : null}
        <BlockFoldCue
          collapsed={nested === null}
          onToggle={onToggle}
          collapsedLabel="Show commits"
          ariaLabelExpand={`Show the commits touching ${record.path}`}
          ariaLabelCollapse={`Hide the commits touching ${record.path}`}
          size="2xs"
          subtype="icon"
          stabilizeScroll={false}
          data-slot="chart-report-path-fold"
        />
      </span>
      {nested !== null ? (
        <div className="tugx-chart-report-nested" data-slot="chart-report-nested">
          <ReportRows id={nested} emptyText="No commits" />
        </div>
      ) : null}
    </>
  );
}

/** A command: its head, then how often it ran long and for how long in all. */
function CommandRow({ record }: { record: ReportCommand }): React.ReactElement {
  return (
    <span className="tugx-chart-report-entity" data-slot="chart-report-command">
      <code className="tugx-chart-report-code">{record.head}</code>
      {record.count !== null && record.totalMs !== null ? (
        <span className="tugx-chart-report-fact">
          {record.count} {record.count === 1 ? "run" : "runs"} · {formatDurationMs(record.totalMs)}
        </span>
      ) : null}
    </span>
  );
}

/** A url: its host and path, stamped as the link it is so a press opens it. */
function UrlRow({ url, record }: { url: string; record: ReportUrl }): React.ReactElement {
  return (
    <span className="tugx-chart-report-entity" data-slot="chart-report-url">
      <span
        className={`tugx-chart-report-ref tugx-chart-report-url ${ANNOTATION_CLASS}`}
        data-tug-annotation="url"
        data-url={url}
        data-tug-focus="refuse"
      >
        {record.host}
        {record.path}
      </span>
    </span>
  );
}

/** How a run's status reads as an outcome, by the roles a `dots` chart draws with. */
function runOutcome(status: string): "good" | "bad" | "neutral" {
  if (status === "PASS") return "good";
  return status === "FAIL" || status === "ERR" || status === "OVERTIME" ? "bad" : "neutral";
}

/** One recorded run of a test file: how it went, when, and on what commit. */
function RunRow({ record }: { record: ReportRun }): React.ReactElement {
  const ended = stamp(record.endedAtMs);
  return (
    <span className="tugx-chart-report-entity" data-slot="chart-report-run">
      <span className="tugx-chart-report-dot" data-outcome={runOutcome(record.status)} aria-hidden="true" />
      <span className="tugx-chart-report-status-word">{record.status}</span>
      {ended !== "" ? <span className="tugx-chart-report-fact">{ended}</span> : null}
      {record.durationMs !== null ? (
        <span className="tugx-chart-report-fact">{formatDurationMs(record.durationMs)}</span>
      ) : null}
      {record.passed !== null && record.total !== null ? (
        <span className="tugx-chart-report-fact">
          {record.passed}/{record.total} passed
        </span>
      ) : null}
      {record.commit !== undefined ? (
        <TugCommitAtom sha={record.commit.sha} />
      ) : record.headSha !== "" ? (
        <span className="tugx-chart-report-fact">{record.headSha}</span>
      ) : null}
    </span>
  );
}

/** One stage or step of an arc: its bounds, and the session or commit it links. */
function SpanRow({ row, record }: { row: ReportRow; record: ReportSpan }): React.ReactElement {
  const started = stamp(record.startMs);
  const ended = stamp(record.endMs);
  const duration =
    record.startMs !== null && record.endMs !== null && record.endMs >= record.startMs
      ? formatDurationMs(record.endMs - record.startMs)
      : "";
  return (
    <span className="tugx-chart-report-entity" data-slot="chart-report-span">
      <span className="tugx-chart-report-status-word">{record.label}</span>
      {started !== "" ? <span className="tugx-chart-report-fact">started {started}</span> : null}
      {ended !== "" ? <span className="tugx-chart-report-fact">ended {ended}</span> : null}
      {duration !== "" ? <span className="tugx-chart-report-fact">{duration}</span> : null}
      {row.session !== undefined ? (
        <SessionCitation citedId={row.session.id} recordedTag={row.session.callsign} />
      ) : row.commit !== undefined ? (
        <TugCommitAtom sha={row.commit.sha} />
      ) : row.ref !== null ? (
        <span className="tugx-chart-report-fact">{refLabel(row.ref)}</span>
      ) : null}
    </span>
  );
}

/** One row's main cell: the kind's own row, or the ref as written. */
function ReportRowMain({ row, descriptor }: { row: ReportRow; descriptor: ReportDescriptor }): React.ReactElement {
  const projectDir = descriptor.projectDir;
  const CommitRow = reportCommitRow();
  if (row.kind === "commit" && row.commit !== undefined && CommitRow !== null) {
    return <CommitRow commit={row.commit} projectDir={projectDir} metaFields={META_FIELDS} />;
  }
  if (row.kind === "session" && row.session !== undefined) return <SessionRow record={row.session} />;
  if (row.kind === "arc" && row.arc !== undefined) return <ArcRow record={row.arc} />;
  if ((row.kind === "file" || row.kind === "dir") && row.path !== undefined) {
    return <PathRow row={row} record={row.path} descriptor={descriptor} />;
  }
  if (row.kind === "command" && row.command !== undefined) return <CommandRow record={row.command} />;
  if (row.kind === "url" && row.url !== undefined && row.ref !== null) {
    return <UrlRow url={refValueOf(row.ref)} record={row.url} />;
  }
  if (row.kind === "run" && row.run !== undefined) return <RunRow record={row.run} />;
  if (row.kind === "span" && row.span !== undefined) return <SpanRow row={row} record={row.span} />;
  return <span className="tugx-chart-report-plain">{row.ref === null ? "" : refLabel(row.ref)}</span>;
}

/**
 * A report's rows and what stands under them: the line that says a read is
 * out, the rows with their groups, the line for a read that found nothing
 * when the caller has words for it, a failed read with its Retry, and the
 * foot that reads the next page. The top report and a path's nested one are
 * both this.
 */
function ReportRows({ id, emptyText }: { id: string; emptyText?: string }): React.ReactElement | null {
  const state = useChartReport(id);
  const descriptor = state.descriptor;
  if (descriptor === null) return null;
  const { rows, total } = state;
  const more = total !== null && state.fetched < total;
  const measure = state.measure;

  const breaks = new Set(groupBreaks(rows));
  const body: React.ReactNode[] = [];
  rows.forEach((row, i) => {
    if (breaks.has(i)) {
      body.push(
        <div className="tugx-chart-report-group" key={`group:${i}:${row.group}`}>
          {row.group}
        </div>,
      );
    }
    body.push(
      <div
        className="tugx-chart-report-row"
        data-kind={row.kind}
        data-ref={row.ref ?? undefined}
        data-found={row.found ? "true" : "false"}
        key={`row:${i}:${row.ref ?? ""}`}
      >
        <div className="tugx-chart-report-main">
          <ReportRowMain row={row} descriptor={descriptor} />
        </div>
        {measure !== null ? <span className="tugx-chart-report-measure tug-line-box">{row.measureText ?? ""}</span> : null}
      </div>,
    );
  });

  return (
    <>
      {state.phase === "loading" && rows.length === 0 ? (
        <div className="tugx-chart-report-status">Reading…</div>
      ) : null}
      {body.length > 0 ? (
        <div className="tugx-chart-report-rows tug-history-list tugx-commit">{body}</div>
      ) : null}
      {emptyText !== undefined && state.phase === "ready" && rows.length === 0 ? (
        <div className="tugx-chart-report-status" data-slot="chart-report-empty">
          {emptyText}
        </div>
      ) : null}
      {state.phase === "error" ? (
        <div className="tugx-chart-report-error" role="alert">
          <span className="tugx-chart-report-error-text">Could not read: {state.error ?? "the read failed"}</span>
          <TugPushButton size="2xs" emphasis="outlined" role="action" onClick={() => void loadReportPage(id)}>
            Retry
          </TugPushButton>
        </div>
      ) : null}
      {more && state.phase !== "error" ? (
        <TugPushButton
          className="tugx-chart-report-more"
          size="2xs"
          emphasis="ghost"
          role="action"
          disabled={state.loadingMore}
          onClick={() => void loadReportPage(id)}
        >
          {footText(state.fetched, total)}
        </TugPushButton>
      ) : null}
    </>
  );
}

export function ChartRefReport({ id }: ChartRefReportProps): React.ReactElement | null {
  const state = useChartReport(id);
  const descriptor = state.descriptor;
  // The panel opens one line tall at the figure's foot and grows when its
  // first rows land, which may carry it below the fold; bring it back into
  // view once, then leave the reader's scroll alone ([L06]: a DOM act on the
  // panel, keyed on the rows arriving, with no state of its own).
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const hasRows = state.rows.length > 0;
  // A panel put back under a rebuilt figure mounts with its rows in hand,
  // and the reader is scrolling: that is no arrival, and nothing moves.
  const mountedWithRows = React.useRef(hasRows);
  React.useLayoutEffect(() => {
    if (!hasRows || mountedWithRows.current) return;
    rootRef.current?.closest(".tugx-chart-set-list")?.scrollIntoView({ block: "nearest" });
  }, [hasRows]);
  // The panel was closed under this mount; the portal goes on the next pass.
  if (descriptor === null) return null;

  const { rows, total } = state;
  const title = reportTitle(
    descriptor.rowLabel,
    descriptor.seriesName,
    total ?? descriptor.slotCount,
    descriptor.kind,
    descriptor.single === true,
  );
  const note = driftNote(state);
  const measure = state.measure;
  const sum =
    measure !== null && state.sumText !== null
      ? measure.unit === ""
        ? state.sumText
        : `${state.sumText} ${measure.unit}`
      : null;

  return (
    <div ref={rootRef} data-slot="chart-ref-report" className="tugx-chart-report-body">
      <div className="tugx-chart-report-head">
        <span className="tugx-chart-report-title">{title}</span>
        {sum !== null ? <span className="tugx-chart-report-sum">{sum}</span> : null}
        <BlockCopyButton
          subtype="icon"
          size="2xs"
          className="tugx-chart-report-copy"
          getText={() => rows.map((row) => row.ref ?? "").filter((ref) => ref !== "").join("\n")}
          disabled={rows.length === 0}
          aria-label="Copy the list"
          data-slot="chart-ref-report-copy"
        />
        <TugIconButton
          className="tugx-chart-report-close"
          size="2xs"
          onClick={() => closeReport(id)}
          aria-label="Close"
          icon={<X size={12} aria-hidden="true" />}
        />
      </div>
      {note !== null ? <div className="tugx-chart-report-note">{note}</div> : null}
      <ReportRows id={id} />
    </div>
  );
}
