/**
 * The per-file watch client — one module, every card that has a file open.
 *
 * tugcast's `FileWatchService` publishes one JSON state frame per watched
 * path on `FILE_WATCH` (`0x13`) and takes `watch` / `unwatch` / `reset`
 * requests on `FILE_WATCH_QUERY` (`0x14`). This module is the deck's whole
 * side of that wire: it holds one subscription per path however many cards
 * asked for it, decodes the frames field by field, and keeps the stream
 * honest across a tugcast restart.
 *
 * **Every gap heals by asking again.** A `watch` is idempotent and always
 * answers with the path's current state, so there is no second verb and no
 * "what is the hash now?" query — a client that thinks it may have missed
 * something re-sends `watch`. That is what {@link reask} is, and it is what
 * a `resync` frame and a connection open both trigger.
 *
 * **`seq` is the server's, and the client forgets it on every open.** The
 * service stamps frames from one process-global counter, so a restarted
 * tugcast starts again from 1; a per-path `lastSeq` that survived the open
 * would drop every frame of the new process's first run. So the map is
 * cleared when the connection opens, and a `reset` goes out before the
 * re-`watch`es so a tugcast that did NOT restart is not left holding
 * subscriptions for a client that has forgotten them.
 *
 * @module lib/file-watch-client
 */

import { FeedId } from "@/protocol";
import { getConnection } from "./connection-singleton";
import { getConnectionLifecycle } from "./connection-lifecycle";

/** One `FILE_WATCH` state frame, decoded. */
export interface FileWatchState {
  /** The client's own path string, echoed back verbatim. */
  path: string;
  seq: number;
  state: "present" | "absent" | "error";
  /** `null` when absent, when the file is too large, or when it is not a regular file. */
  sha256: string | null;
  size: number | null;
  /** Absolute paths created in the file's directory in the same window. */
  created: string[];
  renamedTo: string | null;
  /** The guard's own vocabulary — `denied`, `bad_path`, `io` — on `error`. */
  error: string | null;
  dev?: number;
  ino?: number;
}

export type FileWatchListener = (state: FileWatchState) => void;

/** One watched path: its listeners, and the last `seq` applied to it. */
interface Held {
  listeners: Set<FileWatchListener>;
  lastSeq: number;
}

const held = new Map<string, Held>();

/** Live only while a connection exists; re-attached lazily. */
let detachFrame: (() => void) | null = null;
let detachOpen: (() => void) | null = null;

/**
 * Watch `path`, and stop when the returned function is called.
 *
 * Refcounted per path: the first listener sends `watch`, every later one
 * rides the same subscription, and the last release sends `unwatch`. A
 * second listener still gets its own answer, because `watch` always emits.
 */
export function watchFile(
  path: string,
  listener: FileWatchListener,
): () => void {
  attach();
  let entry = held.get(path);
  if (entry === undefined) {
    entry = { listeners: new Set(), lastSeq: 0 };
    held.set(path, entry);
  }
  entry.listeners.add(listener);
  send({ type: "watch", path });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = held.get(path);
    if (current === undefined) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      held.delete(path);
      send({ type: "unwatch", path });
    }
  };
}

/**
 * Ask again for a path's current state — the one repair for every gap.
 *
 * A no-op for a path nobody holds: an answer would have nowhere to go, and
 * asking would re-create a subscription the last listener just released.
 */
export function reask(path: string): void {
  if (!held.has(path)) return;
  send({ type: "watch", path });
}

// ── Transport ─────────────────────────────────────────────────────────────

/**
 * Attach to the connection's frames and its opens. Lazy and idempotent: a
 * deck that has not connected yet simply attaches on the next call, and
 * nothing throws in the meantime.
 */
function attach(): void {
  if (detachFrame !== null) return;
  const connection = getConnection();
  if (connection === null) return;
  detachFrame = connection.onFrame(FeedId.FILE_WATCH, (payload: Uint8Array) => {
    deliver(payload);
  });
  detachOpen =
    getConnectionLifecycle()?.observeConnectionDidOpen(() => {
      onConnectionDidOpen();
    }) ?? null;
}

/**
 * A fresh connection may be a fresh tugcast: it holds no subscriptions and
 * its `seq` counter has started over. So forget every `seq`, drop whatever
 * the server may still be holding, and ask for each path again.
 */
function onConnectionDidOpen(): void {
  for (const entry of held.values()) entry.lastSeq = 0;
  send({ type: "reset" });
  for (const path of held.keys()) send({ type: "watch", path });
}

function send(message: Record<string, unknown>): void {
  const connection = getConnection();
  if (connection === null) return;
  connection.send(
    FeedId.FILE_WATCH_QUERY,
    new TextEncoder().encode(JSON.stringify(message)),
  );
}

// ── Receiving ─────────────────────────────────────────────────────────────

function deliver(payload: Uint8Array): void {
  const parsed = parseFileWatchFrame(payload);
  if (parsed === null) return;
  if (parsed === "resync") {
    for (const path of held.keys()) send({ type: "watch", path });
    return;
  }
  apply(parsed);
}

/** Apply a state to its path's listeners, dropping a frame already seen. */
function apply(state: FileWatchState): void {
  const entry = held.get(state.path);
  if (entry === undefined) return;
  if (state.seq <= entry.lastSeq) return;
  entry.lastSeq = state.seq;
  for (const listener of [...entry.listeners]) listener(state);
}

/**
 * Decode a `FILE_WATCH` payload: a state, the string `"resync"`, or `null`
 * when the bytes are not something this client understands.
 *
 * Field by field rather than a cast — the wire is a trust boundary, and a
 * frame that does not parse is silence rather than a throw inside a feed
 * callback.
 */
export function parseFileWatchFrame(
  payload: Uint8Array,
): FileWatchState | "resync" | null {
  try {
    const raw = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    if (raw === null || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    if (obj.type === "resync") return "resync";
    if (obj.type !== "state") return null;
    if (typeof obj.path !== "string") return null;
    if (typeof obj.seq !== "number") return null;
    const state = obj.state;
    if (state !== "present" && state !== "absent" && state !== "error") {
      return null;
    }
    const created: string[] = Array.isArray(obj.created)
      ? obj.created.filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      path: obj.path,
      seq: obj.seq,
      state,
      sha256: typeof obj.sha256 === "string" ? obj.sha256 : null,
      size: typeof obj.size === "number" ? obj.size : null,
      created,
      renamedTo: typeof obj.renamedTo === "string" ? obj.renamedTo : null,
      error: typeof obj.error === "string" ? obj.error : null,
      ...(typeof obj.dev === "number" ? { dev: obj.dev } : {}),
      ...(typeof obj.ino === "number" ? { ino: obj.ino } : {}),
    };
  } catch {
    return null;
  }
}

// ── Test seams ────────────────────────────────────────────────────────────

/** Deliver raw frame bytes as if the feed had. */
export function _deliverForTest(payload: Uint8Array): void {
  deliver(payload);
}

/** Drive the connection-open path without a socket. */
export function _connectionDidOpenForTest(): void {
  onConnectionDidOpen();
}

/** Forget every subscription and detach. */
export function _resetForTest(): void {
  held.clear();
  detachFrame?.();
  detachOpen?.();
  detachFrame = null;
  detachOpen = null;
}
