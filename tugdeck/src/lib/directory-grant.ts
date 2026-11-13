/**
 * directory-grant.ts — the deck's half of `/add-dir` and of removing a
 * folder again.
 *
 * A grant is sent by `CodeSessionStore.addDirectory` and answered on two
 * stores: the Session card's `lastDirectoryResult` (granted, or refused with a
 * reason) and the metadata store's `additionalDirectories` (the folders the
 * session holds). The bulletin a grant earns is read off both:
 * {@link awaitDirectoryGrant} resolves granted only once the folder is in the
 * session's list, so "added" is never said of a folder the session does not
 * hold, and refused with tugcode's reason otherwise. tugcode answers every
 * grant, a silent claude included, so the wait always ends.
 *
 * {@link rememberDirectory} is the dialog's "remember" half: it writes the
 * folder to `permissions.additionalDirectories` in the project's local
 * settings, through the endpoint the Permission Rules editor's Workspace tab
 * uses.
 *
 * A removal is the same shape run backwards. {@link classifyDirectory} says
 * where a listed folder comes from — this session's grant, a grant also
 * remembered in the project's local settings, or a settings scope Tug did
 * not write — because that decides whether it can be removed here and what
 * removing it has to touch. {@link removeDirectory} sends the removal
 * through `CodeSessionStore.removeDirectory`, waits with
 * {@link awaitDirectoryRemoval} until tugcode's answer is in and the folder
 * has left the session's list, and takes a remembered folder's rule out of
 * local settings as well, since a settings rule would grant it again.
 *
 * The question a removal asks and the note a folder that cannot be removed
 * wears are {@link removalQuestion} and {@link foreignDirectoryNote}. The
 * Session card owns the removal itself — its turn guard, its stores and its
 * bulletin — and lends it to the chrome that asks, the Session Summary's
 * `x`, through {@link registerDirectoryRemover}.
 *
 * @module lib/directory-grant
 */

import type { DirectoryResultSnapshot } from "@/lib/code-session-store/types";
import type { PermissionsSnapshot, RuleScope } from "@/lib/permission-rules";

/** The read side of a store this module waits on. */
interface Readable<T> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): T;
}

/** How a grant ended. */
export type DirectoryGrantOutcome =
  | { ok: true; directory: string }
  | { ok: false; directory: string; reason: string };

/** A folder path without its trailing slashes; `/` stays `/`. */
export function normalizeDirectory(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/**
 * Wait for the answer to the grant of `directory`, which the caller sends
 * right after calling this (so the answer cannot land before the wait).
 *
 * Ends refused when an answer for this folder is refused; ends granted when
 * an answer for this folder is granted and the folder is in the session's
 * list — whichever of the two lands last. An answer for another folder (a
 * grant sent from a second door at once), or a removal's answer, is not
 * this one's.
 */
export function awaitDirectoryGrant(args: {
  grants: Readable<{ lastDirectoryResult: DirectoryResultSnapshot | null }>;
  directories: Readable<{ additionalDirectories: readonly string[] }>;
  directory: string;
}): Promise<DirectoryGrantOutcome> {
  const want = normalizeDirectory(args.directory);
  const seen = args.grants.getSnapshot().lastDirectoryResult;
  return new Promise((resolve) => {
    let granted = false;
    let done = false;
    const unsubscribers: Array<() => void> = [];
    const finish = (outcome: DirectoryGrantOutcome) => {
      if (done) return;
      done = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      resolve(outcome);
    };
    const check = () => {
      const grant = args.grants.getSnapshot().lastDirectoryResult;
      if (
        grant !== null &&
        grant !== seen &&
        grant.op === "add" &&
        normalizeDirectory(grant.directory) === want
      ) {
        if (!grant.ok) {
          finish({ ok: false, directory: want, reason: grant.reason ?? "the folder was not granted" });
          return;
        }
        granted = true;
      }
      if (
        granted &&
        args.directories
          .getSnapshot()
          .additionalDirectories.some((dir) => normalizeDirectory(dir) === want)
      ) {
        finish({ ok: true, directory: want });
      }
    };
    unsubscribers.push(args.grants.subscribe(check), args.directories.subscribe(check));
    check();
  });
}

/**
 * Write `directory` to `permissions.additionalDirectories` in the local
 * settings of the project at `cwd` (`.claude/settings.local.json`). Resolves
 * `true` when the write succeeded.
 */
export async function rememberDirectory(cwd: string, directory: string): Promise<boolean> {
  try {
    const res = await fetch("/api/permissions/rule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd,
        scope: "local",
        bucket: "additionalDirectories",
        op: "add",
        rule: directory,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** How a removal ended. */
export type DirectoryRemovalOutcome =
  | { ok: true; directory: string }
  | { ok: false; directory: string; reason: string };

/**
 * Wait for the answer to the removal of `directory`, which the caller sends
 * right after calling this (so the answer cannot land before the wait).
 *
 * Ends refused when a removal's answer for this folder is refused; ends
 * removed when a removal's answer for this folder is done and the folder is
 * no longer in the session's list — whichever of the two lands last, so
 * "removed" is never said of a folder the session still holds. A grant's
 * answer, or one for another folder, is not this one's.
 */
export function awaitDirectoryRemoval(args: {
  results: Readable<{ lastDirectoryResult: DirectoryResultSnapshot | null }>;
  directories: Readable<{ additionalDirectories: readonly string[] }>;
  directory: string;
}): Promise<DirectoryRemovalOutcome> {
  const want = normalizeDirectory(args.directory);
  const seen = args.results.getSnapshot().lastDirectoryResult;
  return new Promise((resolve) => {
    let removed = false;
    let done = false;
    const unsubscribers: Array<() => void> = [];
    const finish = (outcome: DirectoryRemovalOutcome) => {
      if (done) return;
      done = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      resolve(outcome);
    };
    const check = () => {
      const result = args.results.getSnapshot().lastDirectoryResult;
      if (
        result !== null &&
        result !== seen &&
        result.op === "remove" &&
        normalizeDirectory(result.directory) === want
      ) {
        if (!result.ok) {
          finish({ ok: false, directory: want, reason: result.reason ?? "the folder was not removed" });
          return;
        }
        removed = true;
      }
      if (
        removed &&
        !args.directories
          .getSnapshot()
          .additionalDirectories.some((dir) => normalizeDirectory(dir) === want)
      ) {
        finish({ ok: true, directory: want });
      }
    };
    unsubscribers.push(args.results.subscribe(check), args.directories.subscribe(check));
    check();
  });
}

/**
 * Where a folder in the session's list comes from, which decides whether
 * the Session Summary offers to remove it and what a removal touches.
 *
 * - `session` — a grant made through the bridge and held nowhere else; a
 *   removal withdraws it from this session.
 * - `remembered` — a bridge grant that the project's local settings also
 *   hold, as Add's "include in future sessions" box writes it; a removal
 *   takes `rule` (the entry exactly as the file spells it) out of local
 *   settings too, or the settings would grant it again.
 * - `foreign` — a scope Tug does not write, user or shared project settings,
 *   also grants it, so removing the grant would leave it readable. Not
 *   removable here; the Permission Rules editor is its door.
 * - `not-held` — the session's list does not hold it at all.
 *
 * The session's list is the bridge's grants: claude reports the folders it
 * was spawned with by `--add-dir`, which are the bridge's, and never a folder
 * a settings file alone grants. So no separate bridge list is needed.
 */
export type DirectoryOrigin =
  | { kind: "session" }
  | { kind: "remembered"; rule: string }
  | { kind: "foreign"; scope: Exclude<RuleScope, "local"> }
  | { kind: "not-held" };

/**
 * A settings entry as a folder path: `~` expanded against `home` and
 * trailing slashes dropped. `null` for an entry that is not an absolute
 * path, which names no folder this comparison can match.
 */
function settingsEntryPath(entry: string, home: string | null): string | null {
  let path = entry.trim();
  if (home !== null && home !== "" && (path === "~" || path.startsWith("~/"))) {
    path = home + path.slice(1);
  }
  return path.startsWith("/") ? normalizeDirectory(path) : null;
}

/**
 * Classify `directory` against the session's list and the rules the
 * project's settings hold ({@link DirectoryOrigin}). A scope Tug does not
 * write wins over local settings: if user or project settings grant the
 * folder, no removal Tug can make will hold.
 */
export function classifyDirectory(args: {
  directory: string;
  sessionDirectories: readonly string[];
  rules: PermissionsSnapshot;
  home: string | null;
}): DirectoryOrigin {
  const want = normalizeDirectory(args.directory);
  if (!args.sessionDirectories.some((dir) => normalizeDirectory(dir) === want)) {
    return { kind: "not-held" };
  }
  const holding = (scope: RuleScope): string | undefined =>
    args.rules.scopes[scope].additionalDirectories.find(
      (entry) => settingsEntryPath(entry, args.home) === want,
    );
  for (const scope of ["user", "project"] as const) {
    if (holding(scope) !== undefined) return { kind: "foreign", scope };
  }
  const rule = holding("local");
  return rule === undefined ? { kind: "session" } : { kind: "remembered", rule };
}

/**
 * Take `rule` out of `permissions.additionalDirectories` in the local
 * settings of the project at `cwd` — {@link rememberDirectory} undone.
 * Resolves `true` when the write succeeded.
 */
export async function forgetDirectory(cwd: string, rule: string): Promise<boolean> {
  try {
    const res = await fetch("/api/permissions/rule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd,
        scope: "local",
        bucket: "additionalDirectories",
        op: "remove",
        rule,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Remove `directory` from the session, by its origin. A `session` folder is
 * withdrawn through tugcode; a `remembered` one is withdrawn and its rule
 * taken out of the project's local settings (`cwd`), and when that write
 * fails the outcome is refused, because the settings still grant it. A
 * `foreign` or `not-held` folder is refused without sending anything.
 *
 * Resolves only once the removal has ended ({@link awaitDirectoryRemoval}),
 * so a caller's "removed" is never said early.
 */
export async function removeDirectory(args: {
  store: Readable<{ lastDirectoryResult: DirectoryResultSnapshot | null }> & {
    removeDirectory(directory: string): void;
  };
  directories: Readable<{ additionalDirectories: readonly string[] }>;
  cwd: string;
  directory: string;
  origin: DirectoryOrigin;
  forget?: (cwd: string, rule: string) => Promise<boolean>;
}): Promise<DirectoryRemovalOutcome> {
  const directory = normalizeDirectory(args.directory);
  const { origin } = args;
  if (origin.kind === "not-held") {
    return { ok: false, directory, reason: `this session doesn't hold ${directory}` };
  }
  if (origin.kind === "foreign") {
    return {
      ok: false,
      directory,
      reason: `${directory} comes from the ${origin.scope} settings; remove it in Permission Rules`,
    };
  }
  const removal = awaitDirectoryRemoval({
    results: args.store,
    directories: args.directories,
    directory,
  });
  args.store.removeDirectory(directory);
  const outcome = await removal;
  if (!outcome.ok || origin.kind !== "remembered") return outcome;
  const forget = args.forget ?? forgetDirectory;
  if (await forget(args.cwd, origin.rule)) return outcome;
  return {
    ok: false,
    directory,
    reason: "the project's local settings still include it",
  };
}

/**
 * What removing a folder does, as the line under the removal's question. A
 * remembered folder leaves the project's future sessions too, and the line
 * says so. Paths arrive as the caller shows them (`~`-abbreviated).
 */
export function removalConsequence(args: {
  shown: string;
  origin: DirectoryOrigin;
  project: string;
}): string {
  const who =
    args.origin.kind === "remembered"
      ? `this session or by future ${args.project} sessions`
      : "this session";
  return `${args.shown} is no longer readable or writable by ${who}.`;
}

/** The question every removal asks, wherever it is asked. */
export const REMOVAL_TITLE = "Remove this directory?";

/**
 * The removal's question as one message, for a confirm with no title of its
 * own: the question, then {@link removalConsequence} on its own line.
 */
export function removalQuestion(args: {
  shown: string;
  origin: DirectoryOrigin;
  project: string;
}): string {
  return `${REMOVAL_TITLE}\n${removalConsequence(args)}`;
}

/**
 * Why a named folder cannot be removed, as a caution, or `null` when it can:
 * the session does not hold it, or a scope Tug does not write grants it too.
 */
export function removalRefusal(origin: DirectoryOrigin, shown: string): string | null {
  if (origin.kind === "not-held") return `This session doesn't hold ${shown}`;
  if (origin.kind === "foreign") return `Can't remove ${shown}. ${foreignDirectoryNote(origin.scope)}`;
  return null;
}

/**
 * What a folder Tug cannot remove says instead of offering an `x`: which
 * settings grant it, and where it is removed.
 */
export function foreignDirectoryNote(scope: Exclude<RuleScope, "local">): string {
  const where = scope === "user" ? "your user settings" : "the project's shared settings";
  return `Granted by ${where}; remove it in Permission Rules`;
}

/**
 * The Session card's removal, lent to the chrome that asks for one.
 *
 * `ready` is the turn guard: it answers whether a removal may start now and,
 * when it may not, says why on the card's bulletin. `remove` runs
 * {@link removeDirectory} with the card's stores and bulletins the outcome
 * once it has ended. Both read live state at call time ([L07]).
 */
export interface DirectoryRemover {
  ready(): boolean;
  remove(directory: string, origin: DirectoryOrigin): Promise<void>;
}

const removers = new Map<string, DirectoryRemover>();

/**
 * Lend `cardId`'s removal to its chrome. Registered in a layout effect
 * ([L03]), so it is in place before any press can reach it; the returned
 * function withdraws it.
 */
export function registerDirectoryRemover(cardId: string, remover: DirectoryRemover): () => void {
  removers.set(cardId, remover);
  return () => {
    if (removers.get(cardId) === remover) removers.delete(cardId);
  };
}

/** The removal `cardId` lent, if the card is mounted in this page. */
export function directoryRemover(cardId: string): DirectoryRemover | undefined {
  return removers.get(cardId);
}
