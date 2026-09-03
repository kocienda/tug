/**
 * arc-file-clusters — an arc's changed files as areas, not a list.
 *
 * Twenty-one paths in snapshot order say nothing until every one has been
 * read; six directories with counts say the shape of the change before any
 * path is. This module folds the wire's flat `base...branch` file list into
 * clusters keyed on the deepest directory that gathers more than one file,
 * sorted by churn, and totals the whole set for the stat strip above them.
 * Pure — no JSX, no CSS — so the grouping rule is a table test.
 *
 * @module lib/arc-file-clusters
 */

import type { ChangesetFile } from "@/lib/changeset-types";

/** One area of the tree the arc touched, and what it did there. */
export interface ArcFileCluster {
  /** The directory the files share, `""` for files at the repository root. */
  dir: string;
  /** Its files, in the order the wire gave them. */
  files: ChangesetFile[];
  /** Lines added across the cluster; a binary file contributes nothing. */
  added: number;
  /** Lines deleted, on the same terms. */
  deleted: number;
  /** How many files carry each status letter, in the wire's spelling. */
  statuses: Record<string, number>;
}

/** The totals the stat strip states over the whole set. */
export interface ArcFileTotals {
  files: number;
  added: number;
  deleted: number;
  /** Whether any file carried a count at all — an older server sends none,
   *  and a strip that read `+0 −0` off that would be stating a fact it does
   *  not have. */
  counted: boolean;
}

/** At most this many clusters before the rest fold under one count. */
export const CLUSTER_LIMIT = 6;

function parentDir(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * The directory a cluster is named for: the file's own parent when that
 * parent holds another changed file, else the nearest ancestor that does,
 * else the parent itself. A lone file two levels below a busy directory
 * joins that directory rather than standing as an area of one, and a file
 * whose whole ancestry is unshared keeps its own parent — the name still
 * says where it is. The root is never climbed to: every file is under it,
 * so it gathers nothing, and only a file that sits there names it.
 */
function clusterDir(path: string, population: ReadonlyMap<string, number>): string {
  let dir = parentDir(path);
  const own = dir;
  while (dir !== "") {
    if ((population.get(dir) ?? 0) > 1) return dir;
    dir = parentDir(dir);
  }
  return own;
}

/**
 * Fold a file list into clusters, sorted by churn (lines moved, then file
 * count, then name so the order is total). The clustering key is chosen per
 * file against the population of every ancestor directory, so the grouping
 * is a function of the list alone and never of the order it arrived in.
 */
export function clusterArcFiles(files: readonly ChangesetFile[]): ArcFileCluster[] {
  // How many changed files sit under each directory, at every depth.
  const population = new Map<string, number>();
  for (const file of files) {
    let dir = parentDir(file.path);
    for (;;) {
      population.set(dir, (population.get(dir) ?? 0) + 1);
      if (dir === "") break;
      dir = parentDir(dir);
    }
  }
  const byDir = new Map<string, ArcFileCluster>();
  for (const file of files) {
    const dir = clusterDir(file.path, population);
    let cluster = byDir.get(dir);
    if (cluster === undefined) {
      cluster = { dir, files: [], added: 0, deleted: 0, statuses: {} };
      byDir.set(dir, cluster);
    }
    cluster.files.push(file);
    cluster.added += file.added ?? 0;
    cluster.deleted += file.deleted ?? 0;
    const letter = file.git_status.charAt(0) || "M";
    cluster.statuses[letter] = (cluster.statuses[letter] ?? 0) + 1;
  }
  return [...byDir.values()].sort(
    (a, b) =>
      b.added + b.deleted - (a.added + a.deleted) ||
      b.files.length - a.files.length ||
      a.dir.localeCompare(b.dir),
  );
}

/** The set's totals, and whether the server counted lines at all. */
export function arcFileTotals(files: readonly ChangesetFile[]): ArcFileTotals {
  let added = 0;
  let deleted = 0;
  let counted = false;
  for (const file of files) {
    if (file.added !== undefined || file.deleted !== undefined) counted = true;
    added += file.added ?? 0;
    deleted += file.deleted ?? 0;
  }
  return { files: files.length, added, deleted, counted };
}

/** The words for a status letter as a cluster row counts them. */
const STATUS_WORDS: Record<string, string> = {
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  M: "modified",
};

/**
 * `3 added, 9 modified` — a cluster's status roll-up, loudest change first
 * (a created or deleted file says more about an area than an edit does), and
 * empty when every file is merely modified, since that is the default a
 * reader assumes.
 */
export function clusterStatusLine(statuses: Readonly<Record<string, number>>): string {
  const order = ["A", "D", "R", "C", "M"];
  const parts: string[] = [];
  for (const letter of order) {
    const count = statuses[letter] ?? 0;
    if (count === 0) continue;
    parts.push(`${count} ${STATUS_WORDS[letter] ?? "changed"}`);
  }
  if (parts.length === 1 && (statuses["M"] ?? 0) > 0) return "";
  return parts.join(", ");
}
