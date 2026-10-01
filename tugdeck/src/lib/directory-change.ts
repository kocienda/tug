/**
 * directory-change.ts — `/cd` and `/change-directory`: moving a card into
 * another project directory, carrying its conversation.
 *
 * A tug session lives in one directory for its whole life, so a move is a
 * swap: the card spawns a new session in the target directory, forked from
 * its current one (`relocate_from` on the `spawn_session`), and the ack
 * re-seats the binding exactly as it does for `/clear`. The deck sends no
 * close for the old session — tugcast closes it itself once the new one is
 * acknowledged, because a `close_session` from this card would sweep every
 * bridge the card holds, the new one included. A refused spawn leaves the
 * card on its old session, untouched.
 *
 * The pending move is plain module state ([L02]: it is never rendered): the
 * `spawn_session_ok` / `spawn_session_error` actions read it to tell a move's
 * ack from any other, and speak through the per-card notifier the Session
 * card registers, so action dispatch needs no React access.
 *
 * @module lib/directory-change
 */

import type { TugConnection } from "../connection";
import { resolveAtomFilePath } from "./atom-file-path";
import { joinPath } from "./annotator/path-resolution";
import type { CardSessionBinding } from "./card-session-binding-store";
import type { DraftAtom } from "./slash-commands";
import {
  provisionSpawnLine,
  provisionSpawnTag,
  sendSpawnSession,
} from "./session-lifecycle";

/** A move sent and not yet answered. */
interface PendingMove {
  readonly newTugSessionId: string;
  readonly oldTugSessionId: string;
  readonly targetDir: string;
}

/** The bulletins a move's settle raises on its card. */
export interface DirectoryChangeNotifier {
  success(message: string): void;
  danger(message: string): void;
}

const pendingMoves = new Map<string, PendingMove>();
const notifiers = new Map<string, DirectoryChangeNotifier>();

/** `dir` without trailing slashes, the root excepted. */
function trimTrailingSlashes(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Why a move to `targetDir` is refused, or `null` when it is not. The
 * turn-in-flight refusal is the card's own guard, read live before this.
 *
 * `targetDir` is `null` before the target is known — a bare `/cd`, about to
 * open the picker — and then only the refusal that needs no target is
 * checked, so an arc-bound card says no before a chooser opens.
 */
export function directoryChangeRefusal(args: {
  arcName: string | null;
  currentDir: string;
  targetDir: string | null;
}): string | null {
  if (args.arcName !== null) {
    return `Can't change the directory of a card bound to arc ${args.arcName}`;
  }
  if (args.targetDir === null) return null;
  const target = trimTrailingSlashes(args.targetDir);
  if (target === trimTrailingSlashes(args.currentDir)) {
    return `Already in ${target}`;
  }
  return null;
}

/**
 * The path a `file` or `directory` atom in the draft names, before
 * resolution — the first one, which is the target when there is one.
 */
export function firstPathAtomValue(atoms: readonly DraftAtom[]): string | null {
  for (const { segment } of atoms) {
    if (
      (segment.type === "file" || segment.type === "directory") &&
      segment.value !== ""
    ) {
      return segment.value;
    }
  }
  return null;
}

/**
 * The directory a `/cd` names, first match wins: the draft's first path
 * atom, then the argument text (a leading `~` expanded when `home` is known,
 * a relative path joined onto `projectDir`). `null` when neither says
 * anything — the caller's cue to open the picker.
 */
export function resolveDirectoryTarget(args: {
  atomPath: string | null;
  argText: string;
  projectDir: string;
  home: string | null;
}): string | null {
  if (args.atomPath !== null) {
    return resolveAtomFilePath(args.atomPath, {
      projectDir: args.projectDir,
      cwd: null,
    });
  }
  const text = args.argText.trim();
  if (text === "") return null;
  const home = args.home !== null && args.home !== "" ? args.home : null;
  if (home !== null && (text === "~" || text.startsWith("~/"))) {
    return joinPath(home, text.slice(1));
  }
  if (text.startsWith("/")) return joinPath("/", text);
  return joinPath(args.projectDir, text);
}

/** Register the bulletins a move on `cardId` settles through. */
export function registerDirectoryChangeNotifier(
  cardId: string,
  notify: DirectoryChangeNotifier,
): () => void {
  notifiers.set(cardId, notify);
  return () => {
    if (notifiers.get(cardId) === notify) notifiers.delete(cardId);
  };
}

/** The notifier registered for `cardId`, if the card is mounted. */
export function directoryChangeNotifier(
  cardId: string,
): DirectoryChangeNotifier | undefined {
  return notifiers.get(cardId);
}

/**
 * Send the move: a new session in `targetDir`, on a fresh line, forked from
 * the card's current session. The old session is not closed here.
 */
export function beginDirectoryChange(args: {
  cardId: string;
  binding: CardSessionBinding;
  targetDir: string;
  connection: TugConnection;
}): void {
  const newTugSessionId = crypto.randomUUID();
  const lineId = provisionSpawnLine(newTugSessionId);
  pendingMoves.set(args.cardId, {
    newTugSessionId,
    oldTugSessionId: args.binding.tugSessionId,
    targetDir: args.targetDir,
  });
  sendSpawnSession(
    args.connection,
    args.cardId,
    newTugSessionId,
    args.targetDir,
    "new",
    provisionSpawnTag(lineId),
    lineId,
    args.binding.tugSessionId,
  );
}

/**
 * Whether a binding of `cardId` to `tugSessionId` is a pending move's ack —
 * read by the services store when the binding lands, which is before the
 * ack settles the move. A move holds the old transcript on screen until the
 * new one is ready; `/clear` and `/resume` re-bind without one.
 */
export function isDirectoryChangeRebind(cardId: string, tugSessionId: string): boolean {
  return pendingMoves.get(cardId)?.newTugSessionId === tugSessionId;
}

/**
 * Settle a `spawn_session_ok` against a pending move. Answers the target
 * when the ack is the move's own, clearing it; `null` otherwise.
 */
export function settleDirectoryChangeAck(
  cardId: string,
  tugSessionId: string,
): string | null {
  const pending = pendingMoves.get(cardId);
  if (pending === undefined || pending.newTugSessionId !== tugSessionId) {
    return null;
  }
  pendingMoves.delete(cardId);
  return pending.targetDir;
}

/**
 * Settle a `spawn_session_error` against a pending move. Answers the detail
 * when a move was pending, clearing it; `null` when none was.
 */
export function settleDirectoryChangeError(
  cardId: string,
  detail: string,
): string | null {
  if (!pendingMoves.delete(cardId)) return null;
  return detail;
}

/** Test seam: forget every pending move and notifier. */
export function _resetDirectoryChangeForTests(): void {
  pendingMoves.clear();
  notifiers.clear();
}
