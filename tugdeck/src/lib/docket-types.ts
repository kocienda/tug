/**
 * Dockets feed wire types — TS mirror of `DocketsSnapshot` in
 * `tugcast-core/src/types.rs` and of `Thread` in
 * `tugarc-core/src/docket_threads.rs`, which the DOCKETS feed (0x2A) carries.
 *
 * The Rust definitions are authoritative. The guard below is the one place a
 * frame is checked before the store adopts it, so a malformed frame is
 * dropped rather than rendered.
 *
 * @module lib/docket-types
 */

/** How an arc generation ended, as the arc log and the archive tell it. */
export type DocketArcFate = "live" | "joined" | "discarded" | "unknown";

/** Where a thread's brief came from: the arc's own, a filed snapshot, or the sketch's brief versions. */
export type DocketBriefSource = "arc" | "filed" | "sketch";

/** Who wrote a sketch's newest version; absent on the wire means `model`. */
export type DocketSketchAuthor = "model" | "user";

/** Why a commit is in a thread. */
export type DocketCommitRole = "round" | "join" | "arc" | "session" | "filed";

export interface DocketSketchCell {
  id: string;
  versions: number;
  want?: string | null;
  /** Who wrote the newest version; absent means `model`. */
  author?: DocketSketchAuthor;
  filed: boolean;
}

export interface DocketBriefCell {
  title?: string | null;
  source: DocketBriefSource;
  /** A filed brief's snapshot name, the first 12 hex of its SHA-256. */
  snapshot?: string | null;
  /** Where a filed brief was read from, relative to the checkout when it could be. */
  source_path?: string | null;
  filed: boolean;
  /** The newest brief version kept on the thread's sketch; absent for an arc's copy or a filed snapshot. */
  version?: number | null;
  /** How many brief versions the sketch keeps; absent means 0. */
  versions?: number;
  /** The sketch version the newest brief version was written from. */
  sketch_version?: number | null;
  /** The sketch has moved on since the newest brief version; absent means false. */
  stale?: boolean;
}

export interface DocketArcCell {
  name: string;
  created: string;
  fate: DocketArcFate;
  join_sha?: string | null;
  filed: boolean;
  /** The brief version whose bytes the arc's brief holds. */
  brief_version?: number | null;
  /** A newer brief version than the arc's exists; absent means false. */
  stale?: boolean;
  /** How many generations ran on the thread's sketch; absent means 1. */
  runs?: number;
}

/** A thread's idea. */
export interface DocketIdeaCell {
  id: string;
  /** Its one line; the id when the record is missing. */
  text: string;
  filed: boolean;
}

export interface DocketSessionCell {
  uuid: string;
  callsign?: string | null;
  /** The arc stage the session ran, when the arc log names it. */
  stage?: string | null;
  filed: boolean;
}

export interface DocketCommitCell {
  sha: string;
  subject: string;
  role: DocketCommitRole;
  filed: boolean;
}

/** One line of work on a docket: an arc, a session's line, or an item alone. */
export interface DocketThread {
  /** The anchor's key: `arc:<name>@<created>`, `idea:<id>`, `session:<line>`, or the item's own. */
  key: string;
  /** When the thread's work began; threads come oldest first. */
  start: string;
  idea?: DocketIdeaCell | null;
  sketch?: DocketSketchCell | null;
  brief?: DocketBriefCell | null;
  arc?: DocketArcCell | null;
  sessions: DocketSessionCell[];
  commits: DocketCommitCell[];
  /**
   * The store keys of the items filed on this thread — what a removal names.
   * The server's, never rebuilt from the cells: a session is filed by its
   * line, and a round's cell carries the log's short sha.
   */
  filed_keys: string[];
}

export interface DocketEntry {
  id: string;
  name: string;
  created: string;
  retired: boolean;
  threads: DocketThread[];
}

/** One open project's dockets, retired ones included. */
export interface ProjectDockets {
  project_dir: string;
  /** The same key CHANGESET_ALL's project sections carry ([L29]). */
  workspace_key: string;
  /** Newest first. */
  dockets: DocketEntry[];
}

/** The DOCKETS frame. */
export interface DocketsSnapshot {
  projects: ProjectDockets[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "number";
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isIdeaCell(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.text) &&
    typeof value.filed === "boolean"
  );
}

function isSketchCell(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.id) &&
    typeof value.versions === "number" &&
    isOptionalString(value.want) &&
    (value.author === undefined || value.author === "model" || value.author === "user") &&
    typeof value.filed === "boolean"
  );
}

function isBriefCell(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.source === "arc" || value.source === "filed" || value.source === "sketch") &&
    isOptionalString(value.title) &&
    isOptionalNumber(value.version) &&
    isOptionalNumber(value.versions) &&
    isOptionalNumber(value.sketch_version) &&
    isOptionalBoolean(value.stale) &&
    typeof value.filed === "boolean"
  );
}

function isArcCell(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.name) &&
    isString(value.created) &&
    (value.fate === "live" ||
      value.fate === "joined" ||
      value.fate === "discarded" ||
      value.fate === "unknown") &&
    isOptionalString(value.join_sha) &&
    isOptionalNumber(value.brief_version) &&
    isOptionalBoolean(value.stale) &&
    isOptionalNumber(value.runs) &&
    typeof value.filed === "boolean"
  );
}

function isSessionCell(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.uuid) &&
    isOptionalString(value.callsign) &&
    isOptionalString(value.stage) &&
    typeof value.filed === "boolean"
  );
}

function isCommitCell(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.sha) &&
    isString(value.subject) &&
    isString(value.role) &&
    typeof value.filed === "boolean"
  );
}

/** Absent and `null` are both "no cell"; anything else must be one. */
function isOptionalCell(value: unknown, isCell: (v: unknown) => boolean): boolean {
  return value === undefined || value === null || isCell(value);
}

/** Narrow one wire value to a {@link DocketThread}. */
export function isDocketThread(value: unknown): value is DocketThread {
  return (
    isRecord(value) &&
    isString(value.key) &&
    value.key.length > 0 &&
    isString(value.start) &&
    isOptionalCell(value.idea, isIdeaCell) &&
    isOptionalCell(value.sketch, isSketchCell) &&
    isOptionalCell(value.brief, isBriefCell) &&
    isOptionalCell(value.arc, isArcCell) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isSessionCell) &&
    Array.isArray(value.commits) &&
    value.commits.every(isCommitCell) &&
    Array.isArray(value.filed_keys) &&
    value.filed_keys.every(isString)
  );
}

function isDocketEntry(value: unknown): value is DocketEntry {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.created) &&
    typeof value.retired === "boolean" &&
    Array.isArray(value.threads) &&
    value.threads.every(isDocketThread)
  );
}

function isProjectDockets(value: unknown): value is ProjectDockets {
  return (
    isRecord(value) &&
    isString(value.project_dir) &&
    isString(value.workspace_key) &&
    Array.isArray(value.dockets) &&
    value.dockets.every(isDocketEntry)
  );
}

/** Narrow a DOCKETS frame's decoded payload to a {@link DocketsSnapshot}. */
export function isDocketsSnapshot(value: unknown): value is DocketsSnapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.projects) &&
    value.projects.every(isProjectDockets)
  );
}
