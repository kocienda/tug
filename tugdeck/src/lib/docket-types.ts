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

/** A decision a revision names, without its body. */
export interface DocketDecisionRef {
  label: string;
  title: string;
}

/** The offer a revision pre-selects; the user may always choose another. */
export type DocketRevisionOffer =
  | { kind: "keep_going" }
  | { kind: "successor_tip" }
  | { kind: "successor_step"; after: number }
  | { kind: "successor_fork" }
  | { kind: "pick" };

/** What a newer brief changed, and what it means for a live arc's finished steps. */
export interface DocketRevisionCell {
  from_version: number;
  to_version: number;
  added: DocketDecisionRef[];
  changed: DocketDecisionRef[];
  removed: DocketDecisionRef[];
  /** Finished steps that carry a changed or removed decision. */
  affected_steps: number[];
  /** Finished steps whose citations say nothing. */
  uncited_steps: number[];
  done_steps: number[];
  offer: DocketRevisionOffer;
  /** The newest version the user chose to keep going past. */
  kept_through?: number | null;
  /** Absent means false. */
  parked?: boolean;
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
  /** Only for a live arc that is stale. */
  revision?: DocketRevisionCell | null;
  /** Stopped as parked and not resumed since; absent means false. */
  parked?: boolean;
  /** The successor the arc's park request names. */
  successor?: string | null;
  /** The boundary the arc's park request names: `tip`, `fork` or `step:<K>`. */
  park_boundary?: string | null;
  /** The arc this one succeeds. */
  succeeds?: string | null;
  /** The generation's audit follow-ups not yet accepted or dismissed; absent means none. */
  proposals?: DocketProposalCell[];
  /** When the generation joined: its terminal line's timestamp. */
  joined_at?: string | null;
  /** The commit on the base that reverted this generation's join. */
  reverted?: string | null;
}

/** An audit follow-up the user has not yet answered, offered in the Inbox. */
export interface DocketProposalCell {
  k: number;
  text: string;
}

/** The arc an idea was filed from, when the user did not type it. */
export interface DocketIdeaOrigin {
  arc: string;
  /** The arc generation's start. */
  created: string;
  kind: { kind: "follow_up"; k: number } | { kind: "brief_decision"; label: string; version: number };
}

/** A thread's idea. */
export interface DocketIdeaCell {
  id: string;
  /** Its one line; the id when the record is missing. */
  text: string;
  filed: boolean;
  /** Where the idea came from, when an arc filed it. */
  origin?: DocketIdeaOrigin | null;
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
    typeof value.filed === "boolean" &&
    (value.origin === undefined ||
      value.origin === null ||
      (isRecord(value.origin) && isString(value.origin.arc) && isString(value.origin.created)))
  );
}

function isProposalList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((p) => isRecord(p) && typeof p.k === "number" && isString(p.text)))
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

function isNumberList(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === "number");
}

function isDecisionList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((d) => isRecord(d) && isString(d.label) && isString(d.title))
  );
}

function isRevisionOffer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "keep_going":
    case "successor_tip":
    case "successor_fork":
    case "pick":
      return true;
    case "successor_step":
      return typeof value.after === "number";
    default:
      return false;
  }
}

function isRevisionCell(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.from_version === "number" &&
    typeof value.to_version === "number" &&
    isDecisionList(value.added) &&
    isDecisionList(value.changed) &&
    isDecisionList(value.removed) &&
    isNumberList(value.affected_steps) &&
    isNumberList(value.uncited_steps) &&
    isNumberList(value.done_steps) &&
    isRevisionOffer(value.offer) &&
    isOptionalNumber(value.kept_through) &&
    isOptionalBoolean(value.parked)
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
    isOptionalCell(value.revision, isRevisionCell) &&
    isOptionalBoolean(value.parked) &&
    isOptionalString(value.successor) &&
    isOptionalString(value.park_boundary) &&
    isOptionalString(value.succeeds) &&
    isProposalList(value.proposals) &&
    isOptionalString(value.joined_at) &&
    isOptionalString(value.reverted) &&
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
