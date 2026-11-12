/**
 * directory-grant.ts — the deck's half of `/add-dir`.
 *
 * A grant is sent by `CodeSessionStore.addDirectory` and answered on two
 * stores: the Session card's `lastDirectoryGrant` (granted, or refused with a
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
 * @module lib/directory-grant
 */

import type { DirectoryGrantSnapshot } from "@/lib/code-session-store/types";

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
 * grant sent from a second door at once) is not this one's.
 */
export function awaitDirectoryGrant(args: {
  grants: Readable<{ lastDirectoryGrant: DirectoryGrantSnapshot | null }>;
  directories: Readable<{ additionalDirectories: readonly string[] }>;
  directory: string;
}): Promise<DirectoryGrantOutcome> {
  const want = normalizeDirectory(args.directory);
  const seen = args.grants.getSnapshot().lastDirectoryGrant;
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
      const grant = args.grants.getSnapshot().lastDirectoryGrant;
      if (grant !== null && grant !== seen && normalizeDirectory(grant.directory) === want) {
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
