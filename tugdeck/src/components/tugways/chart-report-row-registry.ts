/**
 * `chart-report-row-registry` — the row a chart report draws a commit with,
 * named by the module that owns it.
 *
 * A report's commit row is the History card's own row. The report cannot
 * import it: the row's detail mounts markdown, markdown mounts the surface's
 * annotation portals, and those portals are what mount the report, so the
 * import would close a cycle and some module would read another's bindings
 * before it had finished evaluating. So the dependency is turned around. The
 * History list registers its row here when its module loads, which every
 * card page's bundle does before anything can be pressed, and the report
 * reads it at render.
 *
 * One reference, registered once, so every commit row of every report
 * reconciles as the same component ([L26]). A page that never loaded the
 * History list has no row registered, and the report draws the commit's ref
 * as plain text instead.
 *
 * @module components/tugways/chart-report-row-registry
 */

import type React from "react";

import type { CommitMetaField } from "@/components/tugways/commit-presentation";
import type { GitLogCommit } from "@/lib/git-log-store";

/** What a report hands a commit row. */
export interface ReportCommitRowProps {
  commit: GitLogCommit;
  /** The repository the commit was read from. */
  projectDir: string;
  /** Which metadata the collapsed row carries on its trailing edge. */
  metaFields: readonly CommitMetaField[];
}

let commitRow: React.ComponentType<ReportCommitRowProps> | null = null;

/** Name the component a report draws a commit row with. */
export function registerReportCommitRow(row: React.ComponentType<ReportCommitRowProps>): void {
  commitRow = row;
}

/** The registered commit row, or null in a page that loaded none. */
export function reportCommitRow(): React.ComponentType<ReportCommitRowProps> | null {
  return commitRow;
}
