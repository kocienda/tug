/**
 * `chart-report-store` — the pages of a chart report, read from tugcast.
 *
 * A press on a chart's set opens a report: the things the mark counted, a
 * page at a time. The panel is DOM the figure builds; what it shows is here.
 * The opener registers a *descriptor* under a fresh id, saying what to ask
 * (the chart's `source` and the mark's address, or the set's own members),
 * and the component mounted in the panel reads the pages by that id.
 *
 * Three ways to ask, one answer. With a source, `POST /api/chart/report` is
 * sent the source and the address and the recipe that drew the chart answers
 * with the mark's whole list, paged by offset. Without one, the members the
 * spec carried are sent 25 at a time to be described. And a file's or a
 * directory's row asks for the commits touching its path (`of`), which is a
 * report of its own nested under the row. Every way, the rows that come back
 * are the same records.
 *
 * Every read is bounded, so one that never answers becomes an error the
 * report shows with a Retry [L33]. A read still out when its report is
 * dropped is aborted, and its timer cleared [L27]. Pages enter React through
 * `useSyncExternalStore` [L02].
 *
 * @module lib/chart/chart-report-store
 */

import { useEffect } from "react";

import { counted } from "@/lib/chart/chart-table-refs";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import type { GitLogCommit } from "@/lib/git-log-store";
import type { ChartSource } from "@/lib/lazy/load-tuggraphics";

/** How long one read may take before it counts as failed. */
const READ_TIMEOUT_MS = 30_000;

/** How many rows one page asks for. */
export const REPORT_PAGE_SIZE = 25;

/** Where a reader pressed, as the report endpoint takes it. */
export interface ReportAddress {
  row: number;
  label: string;
  /** Counts series from 0. */
  col: number | null;
  series: string | null;
  item: number | null;
  whole_row: boolean;
}

/** What a report asks, and how it names itself. */
export interface ReportDescriptor {
  id: string;
  /** The repository the report reads. */
  projectDir: string;
  /** The prefix the set's members share. */
  kind: string;
  /** The pressed row's label, when the anchor has a row. */
  rowLabel: string | null;
  /** The pressed series' name, for a cell. */
  seriesName: string | null;
  /** How many the mark itself said it holds. */
  slotCount: number;
  /**
   * The report is one row about the mark itself (a dot's run, a span's
   * stage), so its title is the mark's label with no count.
   */
  single?: boolean;
  /** With `address`: the recipe is asked. */
  source?: ChartSource;
  address?: ReportAddress;
  /** Without a source: the set's whole member list, described a page at a time. */
  refs?: readonly string[];
  /**
   * A `file:` or `dir:` ref: the report is the commits touching that path,
   * within `source`'s window when a source rides along.
   */
  of?: string;
}

/** The kinds a row record may be. */
export const REPORT_ROW_KINDS = ["commit", "file", "dir", "session", "arc", "url", "command", "run", "span"] as const;
export type ReportRowKind = (typeof REPORT_ROW_KINDS)[number];

/** One row record. */
export interface ReportRow {
  kind: ReportRowKind;
  ref: string | null;
  /** False when nothing answers for the ref: the row is drawn as plain text. */
  found: boolean;
  measure: number | null;
  /** The measure as the engine writes it. */
  measureText: string | null;
  group: string | null;
  /** A found commit row's record. */
  commit?: GitLogCommit;
  /** A found session row's record. */
  session?: ReportSession;
  /** A found arc row's record. */
  arc?: ReportArc;
  /** A found file or directory row's record. */
  path?: ReportPath;
  /** A found command row's record. */
  command?: ReportCommand;
  /** A found url row's record. */
  url?: ReportUrl;
  /** A run row's record. */
  run?: ReportRun;
  /** A span row's record. */
  span?: ReportSpan;
}

/** What the session index holds of one session. */
export interface ReportSession {
  /** The session's full uuid. */
  id: string;
  callsign: string | null;
  projectDir: string;
  projectLeaf: string;
  title: string | null;
  updatedAtMs: number | null;
}

/** How an arc's newest life ended, or that it has not. */
export const REPORT_ARC_FATES = ["live", "joined", "discarded"] as const;
export type ReportArcFate = (typeof REPORT_ARC_FATES)[number];

/** What the arc log holds of one arc. */
export interface ReportArc {
  name: string;
  fate: ReportArcFate;
  /** The commit the arc landed as, when it joined. */
  joinSha: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  /** How many of its steps the log closed with a commit. */
  stepCommits: number;
}

/** What the disk and the history hold of one file or directory. */
export interface ReportPath {
  /** The path as the ref wrote it: relative to the project, or absolute. */
  path: string;
  exists: boolean;
  /** How many commits touch it, or null when the history could not say. */
  commits: number | null;
}

/** What the record of long silent calls holds of one command. */
export interface ReportCommand {
  head: string;
  /** How many such calls ran, and their total time; null when none is on record. */
  count: number | null;
  totalMs: number | null;
}

/** A url's two halves. */
export interface ReportUrl {
  /** The host, without a leading `www.`. */
  host: string;
  /** The path with its query, or empty. */
  path: string;
}

/** What the app-test ledger holds of one run of one file. */
export interface ReportRun {
  status: string;
  /** When the run ended, in milliseconds. */
  endedAtMs: number | null;
  /** How long the file ran, in milliseconds. */
  durationMs: number | null;
  passed: number | null;
  total: number | null;
  /** The tree the run stood on, as the run recorded it. */
  headSha: string;
  /** That tree's commit, when the recorded sha names one. */
  commit?: GitLogCommit;
}

/**
 * What the arc log holds of one stage or step span. The record of the
 * span's own ref rides the row as its `session` or its `commit`.
 */
export interface ReportSpan {
  label: string;
  startMs: number | null;
  endMs: number | null;
  status: string | null;
}

/** What a recipe's measure is. */
export interface ReportMeasure {
  unit: string;
  format: string;
}

/** One answer from the endpoint, narrowed. */
export type ReportPage =
  | {
      ok: true;
      total: number;
      moved: boolean;
      sum: number | null;
      sumText: string | null;
      measure: ReportMeasure | null;
      rows: ReportRow[];
      /** How many rows the answer carried before any was dropped: how far the read advanced. */
      received: number;
    }
  | { ok: false; message: string };

/** A report as its component reads it. */
export interface ReportState {
  /** Null once the report is dropped, or for an id nobody registered. */
  descriptor: ReportDescriptor | null;
  phase: "loading" | "ready" | "error";
  rows: readonly ReportRow[];
  /** The whole set's size, null until a page has landed. */
  total: number | null;
  sum: number | null;
  sumText: string | null;
  measure: ReportMeasure | null;
  /** The mark is no longer where the chart drew it. */
  moved: boolean;
  /** A further page is being read under rows already shown. */
  loadingMore: boolean;
  error: string | null;
  /** How far into the set the reads have got; the next page starts here. */
  fetched: number;
}

const ABSENT: ReportState = Object.freeze({
  descriptor: null,
  phase: "loading",
  rows: Object.freeze([]) as readonly ReportRow[],
  total: null,
  sum: null,
  sumText: null,
  measure: null,
  moved: false,
  loadingMore: false,
  error: null,
  fetched: 0,
});

const states = new Map<string, ReportState>();
/** The read out for an id: the abort that ends it and releases its timer. */
const inFlight = new Map<string, () => void>();
const listeners = new Set<() => void>();
let nextId = 0;

function publish(id: string, state: ReportState): void {
  states.set(id, state);
  for (const cb of [...listeners]) cb();
}

/** A fresh report id, unique for the life of the page. */
export function newReportId(): string {
  nextId += 1;
  return `r${nextId}`;
}

/** Register what a report asks. Its first page is read when its component mounts. */
export function registerReport(descriptor: ReportDescriptor): void {
  publish(descriptor.id, { ...ABSENT, descriptor });
}

/** Forget a report: its pages go, and a read still out for it is aborted. */
export function dropReport(id: string): void {
  inFlight.get(id)?.();
  inFlight.delete(id);
  if (!states.delete(id)) return;
  for (const cb of [...listeners]) cb();
}

/** What is known of report `id`, with no read taken. */
export function reportState(id: string): ReportState {
  return states.get(id) ?? ABSENT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A commit record with every field the History row reads checked, or null. */
function narrowCommit(value: unknown): GitLogCommit | null {
  if (!isRecord(value)) return null;
  const { sha, subject, author, date } = value;
  if (typeof sha !== "string" || sha === "" || typeof subject !== "string") return null;
  if (typeof author !== "string" || typeof date !== "string") return null;
  const files = Array.isArray(value.files) ? value.files.filter((f): f is string => typeof f === "string") : [];
  return {
    sha,
    subject,
    author,
    date,
    body: optionalString(value.body) ?? "",
    committer: optionalString(value.committer),
    committer_email: optionalString(value.committer_email),
    committer_date: optionalString(value.committer_date),
    tug_arc: optionalString(value.tug_arc),
    tug_session: optionalString(value.tug_session),
    tug_session_id: optionalString(value.tug_session_id),
    files,
  };
}

/** A session record with its id checked, or null. */
function narrowSession(value: unknown): ReportSession | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id === "") return null;
  return {
    id: value.id,
    callsign: stringOrNull(value.callsign),
    projectDir: optionalString(value.project_dir) ?? "",
    projectLeaf: optionalString(value.project_leaf) ?? "",
    title: stringOrNull(value.title),
    updatedAtMs: numberOrNull(value.updated_at_ms),
  };
}

/** An arc record with its name and fate checked, or null. */
function narrowArc(value: unknown): ReportArc | null {
  if (!isRecord(value)) return null;
  if (typeof value.name !== "string" || value.name === "") return null;
  const fate = REPORT_ARC_FATES.find((f) => f === value.fate);
  if (fate === undefined) return null;
  return {
    name: value.name,
    fate,
    joinSha: stringOrNull(value.join_sha),
    startedAtMs: numberOrNull(value.started_at_ms),
    endedAtMs: numberOrNull(value.ended_at_ms),
    stepCommits: numberOrNull(value.step_commits) ?? 0,
  };
}

/** A path record with its path checked, or null. */
function narrowPath(value: unknown): ReportPath | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== "string" || value.path === "") return null;
  return { path: value.path, exists: value.exists === true, commits: numberOrNull(value.commits) };
}

/** A command record with its head checked, or null. */
function narrowCommand(value: unknown): ReportCommand | null {
  if (!isRecord(value)) return null;
  if (typeof value.head !== "string" || value.head === "") return null;
  return { head: value.head, count: numberOrNull(value.count), totalMs: numberOrNull(value.total_ms) };
}

/** A url record with its host checked, or null. */
function narrowUrl(value: unknown): ReportUrl | null {
  if (!isRecord(value)) return null;
  if (typeof value.host !== "string" || value.host === "") return null;
  return { host: value.host, path: optionalString(value.path) ?? "" };
}

/** A run record with its status checked, or null. The ledger's seconds become milliseconds. */
function narrowRun(value: unknown): ReportRun | null {
  if (!isRecord(value) || typeof value.status !== "string" || value.status === "") return null;
  const ms = (secs: number | null): number | null => (secs === null ? null : secs * 1000);
  const commit = narrowCommit(value.commit);
  return {
    status: value.status,
    endedAtMs: ms(numberOrNull(value.ended_at)),
    durationMs: ms(numberOrNull(value.secs)),
    passed: numberOrNull(value.passed),
    total: numberOrNull(value.total),
    headSha: optionalString(value.head_sha) ?? "",
    ...(commit !== null ? { commit } : {}),
  };
}

/** A span record with its label checked, or null. */
function narrowSpan(value: unknown): ReportSpan | null {
  if (!isRecord(value) || typeof value.label !== "string") return null;
  return {
    label: value.label,
    startMs: numberOrNull(value.start_ms),
    endMs: numberOrNull(value.end_ms),
    status: stringOrNull(value.status),
  };
}

function narrowRow(value: unknown): ReportRow | null {
  if (!isRecord(value)) return null;
  const kind = REPORT_ROW_KINDS.find((k) => k === value.kind);
  if (kind === undefined) return null;
  const row: ReportRow = {
    kind,
    ref: stringOrNull(value.ref),
    found: value.found === true,
    measure: numberOrNull(value.measure),
    measureText: stringOrNull(value.measure_text),
    group: stringOrNull(value.group),
  };
  if (kind === "commit" && row.found) {
    const commit = narrowCommit(value.commit);
    // A found row whose record does not read is drawn as an unfound one.
    if (commit === null) row.found = false;
    else row.commit = commit;
  }
  if (kind === "session" && row.found) {
    const session = narrowSession(value.session);
    if (session === null) row.found = false;
    else row.session = session;
  }
  if (kind === "arc" && row.found) {
    const arc = narrowArc(value.arc);
    if (arc === null) row.found = false;
    else row.arc = arc;
  }
  if ((kind === "file" || kind === "dir") && row.found) {
    const path = narrowPath(value.path);
    if (path === null) row.found = false;
    else row.path = path;
  }
  if (kind === "command" && row.found) {
    const command = narrowCommand(value.command);
    if (command === null) row.found = false;
    else row.command = command;
  }
  if (kind === "url" && row.found) {
    const url = narrowUrl(value.url);
    if (url === null) row.found = false;
    else row.url = url;
  }
  if (kind === "run" && row.found) {
    const run = narrowRun(value.run);
    if (run === null) row.found = false;
    else row.run = run;
  }
  if (kind === "span" && row.found) {
    const span = narrowSpan(value.span);
    if (span === null) row.found = false;
    else {
      row.span = span;
      // What the span stands on, when its ref resolved: neither is required.
      const session = narrowSession(value.session);
      if (session !== null) row.session = session;
      const commit = narrowCommit(value.commit);
      if (commit !== null) row.commit = commit;
    }
  }
  return row;
}

/**
 * The endpoint's answer with every field checked. A row of a kind this build
 * does not know is dropped; a body that does not say `ok` is an error with
 * the message it gave, or one saying the answer was malformed.
 */
export function narrowReport(body: unknown): ReportPage {
  if (!isRecord(body)) return { ok: false, message: "the answer was not an object" };
  if (body.status === "error") {
    return { ok: false, message: typeof body.message === "string" ? body.message : "the read failed" };
  }
  const total = numberOrNull(body.total);
  if (body.status !== "ok" || total === null || !Array.isArray(body.rows)) {
    return { ok: false, message: "the answer was malformed" };
  }
  const rows: ReportRow[] = [];
  for (const raw of body.rows) {
    const row = narrowRow(raw);
    if (row !== null) rows.push(row);
  }
  const measure =
    isRecord(body.measure) && typeof body.measure.unit === "string" && typeof body.measure.format === "string"
      ? { unit: body.measure.unit, format: body.measure.format }
      : null;
  return {
    ok: true,
    total,
    moved: body.moved === true,
    sum: numberOrNull(body.sum),
    sumText: stringOrNull(body.sum_text),
    measure,
    rows,
    received: body.rows.length,
  };
}

/**
 * `state` with one answer applied. A good page appends its rows and sets the
 * set's facts; an error leaves the rows read so far as they are and says
 * what failed. Pure.
 */
export function applyReportPage(state: ReportState, page: ReportPage): ReportState {
  if (!page.ok) {
    return { ...state, phase: "error", loadingMore: false, error: page.message };
  }
  // A describe read is told only about the refs it was sent, so the set's
  // size is the member list's.
  const refs = state.descriptor?.refs;
  return {
    ...state,
    phase: "ready",
    rows: [...state.rows, ...page.rows],
    total: refs !== undefined ? refs.length : page.total,
    sum: page.sum,
    sumText: page.sumText,
    measure: page.measure,
    moved: page.moved,
    loadingMore: false,
    error: null,
    fetched: state.fetched + page.received,
  };
}

/**
 * Land one answer for report `id`. An answer for a report that was dropped
 * while the read was out is discarded.
 */
export function receiveReportPage(id: string, page: ReportPage): void {
  const state = states.get(id);
  if (state === undefined) return;
  publish(id, applyReportPage(state, page));
}

function messageOf(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "the read took too long";
  return error instanceof Error ? error.message : String(error);
}

/** The request body for the next page of `state`'s report, or null when there is nothing to ask. */
export function nextRequest(state: ReportState): Record<string, unknown> | null {
  const d = state.descriptor;
  if (d === null) return null;
  if (d.of !== undefined) {
    return {
      project: d.projectDir,
      of: d.of,
      ...(d.source !== undefined ? { source: d.source } : {}),
      offset: state.fetched,
      limit: REPORT_PAGE_SIZE,
    };
  }
  if (d.source !== undefined && d.address !== undefined) {
    return {
      project: d.projectDir,
      source: d.source,
      address: d.address,
      offset: state.fetched,
      limit: REPORT_PAGE_SIZE,
    };
  }
  const page = (d.refs ?? []).slice(state.fetched, state.fetched + REPORT_PAGE_SIZE);
  return page.length === 0 ? null : { project: d.projectDir, refs: page };
}

/**
 * Read the next page of report `id`. A second call while one read is out
 * does nothing, and so does a call once every row is in hand.
 */
export async function loadReportPage(id: string): Promise<void> {
  const state = states.get(id);
  if (state === undefined || inFlight.has(id)) return;
  if (state.phase === "ready" && state.total !== null && state.fetched >= state.total) return;
  const body = nextRequest(state);
  if (body === null) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  const release = (): void => {
    clearTimeout(timer);
    controller.abort();
  };
  inFlight.set(id, release);
  publish(
    id,
    state.rows.length > 0
      ? { ...state, loadingMore: true, error: null }
      : { ...state, phase: "loading", error: null },
  );
  let page: ReportPage;
  try {
    const response = await fetch("/api/chart/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    page = narrowReport(await response.json());
  } catch (error) {
    page = { ok: false, message: messageOf(error) };
  }
  // A dropped report released this read already; the answer is nobody's.
  if (inFlight.get(id) !== release) return;
  clearTimeout(timer);
  inFlight.delete(id);
  receiveReportPage(id, page);
}

/** Report `id`'s pages, its first read taken when the component mounts. */
export function useChartReport(id: string): ReportState {
  useEffect(() => {
    void loadReportPage(id);
  }, [id]);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => reportState(id),
    () => ABSENT,
  );
}

/**
 * A report's title: the row's label, the series' name for a cell, and the
 * count of what the mark holds, as `2026-10-23 · feat · 12 commits`. A
 * `single` report is about the mark itself, so it is the label alone.
 */
export function reportTitle(
  rowLabel: string | null,
  seriesName: string | null,
  total: number,
  kind: string,
  single = false,
): string {
  const parts: string[] = [];
  if (rowLabel !== null && rowLabel !== "") parts.push(rowLabel);
  if (seriesName !== null && seriesName !== "") parts.push(seriesName);
  if (single && parts.length > 0) return parts.join(" · ");
  parts.push(counted(total, kind));
  return parts.join(" · ");
}

/**
 * The indices of `rows` a group heading goes before: each row whose group
 * is not null and differs from the row before it.
 */
export function groupBreaks(rows: readonly ReportRow[]): number[] {
  const breaks: number[] = [];
  let group: string | null = null;
  rows.forEach((row, i) => {
    if (row.group !== null && row.group !== group) breaks.push(i);
    group = row.group;
  });
  return breaks;
}

/** The foot's words while rows remain: `25 of 57 · show 25 more`. */
export function footText(shown: number, total: number): string {
  return `${shown} of ${total} · show ${Math.min(REPORT_PAGE_SIZE, total - shown)} more`;
}

/**
 * The line a report shows when the source no longer agrees with the chart:
 * the mark is gone, or it holds a different number than the chart drew. Null
 * when they agree, and before any page has landed.
 */
export function driftNote(state: ReportState): string | null {
  const d = state.descriptor;
  if (d === null || d.source === undefined || d.of !== undefined || state.phase !== "ready") return null;
  if (state.moved) return "Drawn from an earlier reading; the source no longer has this mark.";
  if (state.total !== null && state.total !== d.slotCount) {
    return `Drawn from an earlier reading; the source now holds ${state.total}.`;
  }
  return null;
}
