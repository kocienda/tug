/**
 * file-io.ts — typed client for tugcast's `/api/fs/read` and `/api/fs/write`,
 * the disk surface behind the Text card's live-autosave engine.
 *
 * Reads return the canonicalized path (the identity the filesystem watcher
 * reports events against) plus a sha256 of the content bytes — the baseline
 * every subsequent write is conditioned on. Writes are atomic on the server
 * (temp + rename) and reject with a structured `conflict` when the disk hash
 * no longer matches the caller's baseline, so no external edit is ever
 * silently clobbered.
 *
 * All outcomes are returned as discriminated unions rather than thrown —
 * the autosave state machine treats every failure as a state, not an
 * exception.
 *
 * @module lib/file-io
 */

/** Successful `/api/fs/read` payload. */
export interface FileReadResult {
  /** Canonicalized absolute path (symlinks/firmlinks resolved). */
  path: string;
  /** Full file text (UTF-8). */
  content: string;
  /** Hex sha256 of the content bytes — the write baseline. */
  sha256: string;
  /** File size in bytes. */
  size: number;
  /** mtime in ms since the Unix epoch. */
  mtimeMs: number;
  /** True when the file's permission bits refuse writes. */
  readOnly: boolean;
  /**
   * Filesystem identity — the device and inode numbers. Together they name
   * THIS file rather than its contents, so they survive a rename on the same
   * volume and a rewrite of the bytes, and they change when a path is
   * unlinked and recreated. Absent on a non-unix server, where a caller
   * falls back to matching on `sha256`.
   */
  dev?: number;
  ino?: number;
}

/** Structured read failure kinds (server statuses + transport failure). */
export type FileReadErrorKind =
  | "not_found"
  | "denied"
  | "binary"
  | "too_large"
  | "bad_path"
  | "internal"
  | "network";

/** Outcome of a read: the file, or a structured error. */
export type FileReadOutcome =
  | { ok: true; file: FileReadResult }
  | { ok: false; error: FileReadErrorKind; size?: number };

/** Request body for `/api/fs/write`. `baselineSha256: null` = create new. */
export interface FileWriteRequest {
  path: string;
  content: string;
  baselineSha256: string | null;
  /** Remove the file instead of writing (hash-conditional; draft GC). */
  delete?: boolean;
}

/** Structured write failure kinds. */
export type FileWriteErrorKind =
  | "conflict"
  | "missing"
  | "denied"
  | "parent_missing"
  | "bad_path"
  | "internal"
  | "network";

/** Outcome of a write: the new baseline, or a structured error. */
export type FileWriteOutcome =
  | { ok: true; sha256: string; mtimeMs: number }
  | { ok: false; error: "conflict"; diskSha256: string }
  | { ok: false; error: Exclude<FileWriteErrorKind, "conflict"> };

/** Narrow an unknown error-body `error` field to a known read kind. */
function coerceReadError(value: unknown): FileReadErrorKind {
  switch (value) {
    case "not_found":
    case "denied":
    case "binary":
    case "too_large":
    case "bad_path":
      return value;
    default:
      return "internal";
  }
}

/** Narrow an unknown error-body `error` field to a known write kind. */
function coerceWriteError(
  value: unknown,
): Exclude<FileWriteErrorKind, "conflict"> {
  switch (value) {
    case "missing":
    case "denied":
    case "parent_missing":
    case "bad_path":
      return value;
    default:
      return "internal";
  }
}

/** Read one file from disk. Never throws. */
export async function readFileFromDisk(path: string): Promise<FileReadOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/fs/read?path=${encodeURIComponent(path)}`);
  } catch {
    return { ok: false, error: "network" };
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "network" };
  }
  if (!res.ok) {
    const error = coerceReadError(body.error);
    return error === "too_large" && typeof body.size === "number"
      ? { ok: false, error, size: body.size }
      : { ok: false, error };
  }
  if (
    typeof body.path !== "string" ||
    typeof body.content !== "string" ||
    typeof body.sha256 !== "string"
  ) {
    return { ok: false, error: "internal" };
  }
  return {
    ok: true,
    file: {
      path: body.path,
      content: body.content,
      sha256: body.sha256,
      size: typeof body.size === "number" ? body.size : body.content.length,
      mtimeMs: typeof body.mtimeMs === "number" ? body.mtimeMs : 0,
      readOnly: body.readOnly === true,
      ...(typeof body.dev === "number" ? { dev: body.dev } : {}),
      ...(typeof body.ino === "number" ? { ino: body.ino } : {}),
    },
  };
}

/**
 * Write one file to disk, conditional on `baselineSha256`. Never throws.
 *
 * `keepalive` marks the fetch to survive page teardown — the final-flush
 * path on `pagehide`/card destruction uses it so the last debounce window
 * of edits still lands when the surface is going away.
 */
export async function writeFileToDisk(
  request: FileWriteRequest,
  opts?: { keepalive?: boolean },
): Promise<FileWriteOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/fs/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      keepalive: opts?.keepalive === true,
    });
  } catch {
    return { ok: false, error: "network" };
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "network" };
  }
  if (!res.ok) {
    if (body.error === "conflict" && typeof body.diskSha256 === "string") {
      return { ok: false, error: "conflict", diskSha256: body.diskSha256 };
    }
    return { ok: false, error: coerceWriteError(body.error) };
  }
  return {
    ok: true,
    sha256: typeof body.sha256 === "string" ? body.sha256 : "",
    mtimeMs: typeof body.mtimeMs === "number" ? body.mtimeMs : 0,
  };
}
