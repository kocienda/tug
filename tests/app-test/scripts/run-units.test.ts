/**
 * run-units.test.ts — the app-test run directory read as the run panel's rows.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CELLS_UP_TO, outBase, readCaps, unitRows } from "./run-units";

const US = "\x1f";
const RS = "\x1e";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-units-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CAPS = [
  "at0001-a.test.ts\t120\t9",
  "at0002-b.test.ts\t120\t-",
  "at0003-c.test.ts\t120\t11",
  "at0004-d.test.ts\t120\t6",
].join("\n");

describe("run-units", () => {
  test("each file is a row in run order: landed, running, or pending", () => {
    const files = ["at0001-a.test.ts", "at0002-b.test.ts", "at0003-c.test.ts", "at0004-d.test.ts"];
    writeFileSync(`${outBase(dir, files[0]!)}.row`, "PASS:at0001-a.test.ts:3:3:7\n");
    writeFileSync(`${outBase(dir, files[1]!)}.row`, "FAIL:at0002-b.test.ts:1:2:14\n");
    writeFileSync(
      `${outBase(dir, files[1]!)}.fails`,
      `composer clears after send${US}data-empty wait timed out${US}at0002-b.test.ts:88${RS}second${US}x${US}y${RS}`,
    );
    writeFileSync(`${outBase(dir, files[2]!)}.start`, "1760000000000");

    const rows = unitRows(dir, CAPS, files);
    expect(rows).toEqual([
      { name: "at0001-a", status: "pass", index: 0, median: 9, passed: 3, total: 3, secs: 7 },
      {
        name: "at0002-b",
        status: "fail",
        index: 1,
        passed: 1,
        total: 2,
        secs: 14,
        title: "composer clears after send",
        message: "data-empty wait timed out",
      },
      { name: "at0003-c", status: "running", index: 2, median: 11, started_at_ms: 1760000000000 },
      { name: "at0004-d", status: "pending", index: 3, median: 6 },
    ]);
  });

  test("a wedged file says the cap it hit, and a red one carries its history line", () => {
    const files = ["at0003-c.test.ts", "at0002-b.test.ts"];
    writeFileSync(`${outBase(dir, files[0]!)}.row`, "WEDGED:at0003-c.test.ts:0:0:120\n");
    writeFileSync(`${outBase(dir, files[1]!)}.row`, "ERR:at0002-b.test.ts:0:0:3\n");
    writeFileSync(join(dir, "history.tsv"), "at0002-b.test.ts\tlast green 6ad15611d (2026-10-16, 1 recorded run ago)\n");

    const [wedged, errored] = unitRows(dir, CAPS, files);
    expect(wedged?.status).toBe("wedged");
    expect(wedged?.message).toContain("120s cap (3× the median of its recent recorded times, 11s)");
    expect(errored?.status).toBe("error");
    expect(errored?.history).toBe("last green 6ad15611d (2026-10-16, 1 recorded run ago)");
  });

  test("a file green past the budget is a red row that says so", () => {
    writeFileSync(`${outBase(dir, "at0001-a.test.ts")}.row`, "OVERTIME:at0001-a.test.ts:2:2:27\n");
    const [row] = unitRows(dir, CAPS, ["at0001-a.test.ts"]);
    expect(row?.status).toBe("fail");
    expect(row?.secs).toBe(27);
    expect(row?.message).toBe("green, but 27s is over the per-file budget: split it or make it faster");
  });

  test("a skipped file is a row with no time", () => {
    writeFileSync(`${outBase(dir, "at0004-d.test.ts")}.row`, "SKIP:at0004-d.test.ts:0:0:0\n");
    expect(unitRows(dir, CAPS, ["at0004-d.test.ts"])).toEqual([
      { name: "at0004-d", status: "skipped", index: 0, median: 6 },
    ]);
  });

  test("past the cell limit only running and red files ride, keeping their place", () => {
    const files = Array.from({ length: CELLS_UP_TO + 6 }, (_, i) => `at${String(i).padStart(4, "0")}.test.ts`);
    writeFileSync(`${outBase(dir, files[0]!)}.row`, `PASS:${files[0]}:1:1:2\n`);
    writeFileSync(`${outBase(dir, files[40]!)}.row`, `FAIL:${files[40]}:0:1:2\n`);
    writeFileSync(`${outBase(dir, files[41]!)}.start`, "1760000000000");
    const rows = unitRows(dir, null, files);
    expect(rows.map((r) => [r.index, r.status])).toEqual([
      [40, "fail"],
      [41, "running"],
    ]);
  });

  test("the caps file reads a dash as no median", () => {
    expect(readCaps(CAPS).get("at0002-b.test.ts")).toEqual({ cap: 120 });
    expect(readCaps(CAPS).get("at0003-c.test.ts")).toEqual({ cap: 120, median: 11 });
  });
});
