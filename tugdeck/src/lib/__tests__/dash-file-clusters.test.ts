/**
 * The cluster rule, as a table: which directory a file joins, how the
 * clusters order, and what the totals say when the server counted nothing.
 */

import { describe, expect, test } from "bun:test";

import type { ChangesetFile } from "@/lib/changeset-types";
import {
  clusterDashFiles,
  clusterStatusLine,
  dashFileTotals,
} from "../dash-file-clusters";

function file(
  path: string,
  git_status = "M",
  counts?: { added: number; deleted: number },
): ChangesetFile {
  return {
    path,
    git_status,
    op: "modified",
    origin: "dash",
    shared: false,
    last_touched: 0,
    ...(counts ?? {}),
  };
}

describe("clusterDashFiles", () => {
  test("files sharing a parent cluster under it", () => {
    const clusters = clusterDashFiles([
      file("tugdeck/src/a.ts"),
      file("tugdeck/src/b.ts"),
    ]);
    expect(clusters.map((c) => c.dir)).toEqual(["tugdeck/src"]);
    expect(clusters[0]!.files.map((f) => f.path)).toEqual([
      "tugdeck/src/a.ts",
      "tugdeck/src/b.ts",
    ]);
  });

  test("a lone file below a busy directory joins that directory", () => {
    const clusters = clusterDashFiles([
      file("tugdeck/src/a.ts"),
      file("tugdeck/src/b.ts"),
      file("tugdeck/src/deep/only.ts"),
    ]);
    expect(clusters.map((c) => c.dir)).toEqual(["tugdeck/src"]);
    expect(clusters[0]!.files.length).toBe(3);
  });

  test("a file with no shared ancestry keeps its own parent", () => {
    const clusters = clusterDashFiles([
      file("tugdeck/src/a.ts"),
      file("tugdeck/src/b.ts"),
      file("tuglaws/dash.md"),
    ]);
    expect(clusters.map((c) => c.dir).sort()).toEqual(["tugdeck/src", "tuglaws"]);
  });

  test("two files at the root cluster at the root; one alone keeps the root too", () => {
    expect(clusterDashFiles([file("a.md"), file("b.md")]).map((c) => c.dir)).toEqual([""]);
    expect(clusterDashFiles([file("a.md")]).map((c) => c.dir)).toEqual([""]);
  });

  test("clusters order by churn, then file count, then name", () => {
    const clusters = clusterDashFiles([
      file("quiet/a.ts", "M", { added: 1, deleted: 0 }),
      file("quiet/b.ts", "M", { added: 1, deleted: 0 }),
      file("loud/a.ts", "M", { added: 40, deleted: 12 }),
      file("loud/b.ts", "M", { added: 0, deleted: 0 }),
      file("many/a.ts"),
      file("many/b.ts"),
      file("many/c.ts"),
      file("alpha/a.ts"),
      file("alpha/b.ts"),
    ]);
    expect(clusters.map((c) => c.dir)).toEqual(["loud", "quiet", "many", "alpha"]);
    expect(clusters[0]).toMatchObject({ added: 40, deleted: 12 });
  });

  test("statuses roll up by letter, a rename's score dropped", () => {
    const [cluster] = clusterDashFiles([
      file("x/a.ts", "A"),
      file("x/b.ts", "M"),
      file("x/c.ts", "R100"),
      file("x/d.ts", "M"),
    ]);
    expect(cluster!.statuses).toEqual({ A: 1, M: 2, R: 1 });
  });

  test("the grouping does not depend on arrival order", () => {
    const a = clusterDashFiles([file("p/q/one.ts"), file("p/two.ts"), file("p/q/three.ts")]);
    const b = clusterDashFiles([file("p/two.ts"), file("p/q/three.ts"), file("p/q/one.ts")]);
    expect(a.map((c) => [c.dir, c.files.length])).toEqual(b.map((c) => [c.dir, c.files.length]));
    expect(a.map((c) => c.dir)).toEqual(["p/q", "p"]);
  });
});

describe("dashFileTotals", () => {
  test("sums what was counted and says so", () => {
    expect(
      dashFileTotals([
        file("a", "M", { added: 3, deleted: 1 }),
        file("b", "M", { added: 2, deleted: 0 }),
      ]),
    ).toEqual({ files: 2, added: 5, deleted: 1, counted: true });
  });

  test("an uncounted list is not a list of zero-line changes", () => {
    expect(dashFileTotals([file("a"), file("b")])).toEqual({
      files: 2,
      added: 0,
      deleted: 0,
      counted: false,
    });
  });
});

describe("clusterStatusLine", () => {
  test("created and deleted lead, and all-modified says nothing", () => {
    expect(clusterStatusLine({ M: 9, A: 3, D: 1 })).toBe("3 added, 1 deleted, 9 modified");
    expect(clusterStatusLine({ M: 4 })).toBe("");
    expect(clusterStatusLine({ A: 1 })).toBe("1 added");
  });
});
