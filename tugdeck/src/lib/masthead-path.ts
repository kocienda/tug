/**
 * masthead-path — how a document card's masthead spells the path it names.
 *
 * Settings ▸ General ▸ Card Masthead Paths chooses between the absolute path
 * and the path relative to the project the file sits in. A text card, a file
 * view or a diff pop-out carries no project of its own, so "the project" is
 * read off the deck: every directory a bound session card has open
 * ({@link useWorkspaceProjectDirs}), then the default project directory. A
 * file under more than one of them (a nested checkout) takes the deepest.
 *
 * The roots are canonical spellings, and a file path may arrive in another
 * (`/u/src/tug` through a symlink to the same checkout), so the comparison is
 * made on the server's canonical spelling of the file's DIRECTORY ([L29]);
 * until that answer lands the path stands for itself. A file in no open
 * project is written in full — the path worth reading whole is exactly the
 * one that is not where the user is working.
 *
 * Display only. The masthead's Copy Path and Show in Finder keep reading the
 * absolute path the card published.
 *
 * @module lib/masthead-path
 */

import { useCanonicalDirs, type CanonicalOf } from "./canonical-dir-store";
import { basename, dirname } from "./display-path";
import { useWorkspaceProjectDirs } from "./frontmost-project";
import { useTugbankValue } from "./use-tugbank-value";
import type { TaggedValue } from "./tugbank-client";
import {
  DEFAULT_PROJECT_PATH_DOMAIN,
  DEFAULT_PROJECT_PATH_KEY,
  MASTHEAD_PATHS_DOMAIN,
  MASTHEAD_PATHS_KEY,
  parseMastheadPathStyle,
} from "@/settings-api";

/**
 * `path` written relative to the deepest of `projectDirs` it sits under, or
 * `path` unchanged when it sits under none of them.
 *
 * A file at a project's top level keeps the project's name in front
 * (`tug/Justfile`): the bare name would be a copy of the masthead's title
 * line, and the line would no longer say which project it is in.
 */
export function projectRelativePath(
  path: string,
  projectDirs: readonly string[],
  canonicalOf: CanonicalOf,
): string {
  if (!path.startsWith("/")) return path;
  const dir = dirname(path);
  const canonicalDir = dir === "" ? "" : canonicalOf(dir).replace(/\/+$/, "");
  const canonicalPath = `${canonicalDir}/${basename(path)}`;
  let best = "";
  for (const raw of projectDirs) {
    const root = raw.replace(/\/+$/, "");
    if (root === "" || root.length <= best.length) continue;
    if (canonicalPath.startsWith(`${root}/`)) best = root;
  }
  if (best === "") return path;
  const relative = canonicalPath.slice(best.length + 1);
  return relative.includes("/") ? relative : `${basename(best)}/${relative}`;
}

function parseStoredPath(entry: TaggedValue | undefined): string {
  return entry?.kind === "string" && typeof entry.value === "string" ? entry.value : "";
}

/**
 * React hook: the spelling of `path` the masthead should show under the
 * user's choice — `path` itself when the choice is full paths ([L02]: every
 * input is read through `useSyncExternalStore`).
 */
export function useMastheadPath(path: string): string {
  const style = useTugbankValue(
    MASTHEAD_PATHS_DOMAIN,
    MASTHEAD_PATHS_KEY,
    parseMastheadPathStyle,
    "full",
  );
  const workspaceDirs = useWorkspaceProjectDirs();
  const defaultDir = useTugbankValue(
    DEFAULT_PROJECT_PATH_DOMAIN,
    DEFAULT_PROJECT_PATH_KEY,
    parseStoredPath,
    "",
  );
  const canonicalOf = useCanonicalDirs();
  if (style !== "project") return path;
  const roots = defaultDir === "" ? workspaceDirs : [...workspaceDirs, defaultDir];
  return projectRelativePath(path, roots, canonicalOf);
}
