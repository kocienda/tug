/**
 * run-units.ts — the app-test run's units, as the block's run panel reads them.
 *
 * The recipe keeps every file's state in its run directory: a `.start` when a
 * job picks the file up (epoch ms), a `.row` when it lands
 * (`STATUS:file:passed:total:secs`), a `.fails` with its failure records, and
 * the wedge caps file (`file\tcap\tmedian-or--`). This reads them and prints
 * the JSON array `tugtool progress --units-json` carries — one row per file
 * in run order, so the panel's track is the batch.
 *
 * A batch past {@link CELLS_UP_TO} files is drawn as a band, which needs only
 * the files that are running or red; the greens and the pending are left off
 * so a long run's reports stay small.
 *
 * Usage: bun scripts/run-units.ts <rundir> <capsfile> <file>...
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Past this many files the panel draws a band, and the rows thin out. */
export const CELLS_UP_TO = 64;

const US = "\x1f";
const RS = "\x1e";

const STATUS: Record<string, string> = {
  PASS: "pass",
  FAIL: "fail",
  ERR: "error",
  WEDGED: "wedged",
  SKIP: "skipped",
  // Green past the per-file budget: a red, because a slow test is a defect of the test.
  OVERTIME: "fail",
};

export interface UnitRow {
  name: string;
  status: string;
  index: number;
  passed?: number;
  total?: number;
  secs?: number;
  median?: number;
  started_at_ms?: number;
  title?: string;
  message?: string;
  history?: string;
}

/** The file's stem in the run directory, as `run_one_file` spells it. */
export function outBase(rundir: string, file: string): string {
  return join(rundir, file.replaceAll("/", "_"));
}

function readOr(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** `file → [cap, median]` from the caps file. */
export function readCaps(text: string | null): Map<string, { cap: number; median?: number }> {
  const out = new Map<string, { cap: number; median?: number }>();
  for (const line of (text ?? "").split("\n")) {
    const [file, cap, basis] = line.split("\t");
    if (!file || cap === undefined) continue;
    const median = basis !== undefined && basis !== "-" ? Number(basis) : undefined;
    out.set(file, {
      cap: Number(cap),
      ...(median !== undefined && Number.isFinite(median) ? { median } : {}),
    });
  }
  return out;
}

/** `file → history line` from `history.tsv`, written after the Failures section. */
export function readHistory(text: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (text ?? "").split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const value = line.slice(tab + 1).trim();
    if (value.length > 0) out.set(line.slice(0, tab), value);
  }
  return out;
}

export function unitRows(rundir: string, capsText: string | null, files: readonly string[]): UnitRow[] {
  const caps = readCaps(capsText);
  const history = readHistory(readOr(join(rundir, "history.tsv")));
  const rows: UnitRow[] = files.map((file, index) => {
    const base = outBase(rundir, file);
    const cap = caps.get(file);
    const row: UnitRow = { name: file.replace(/\.test\.ts$/, ""), status: "pending", index };
    if (cap?.median !== undefined) row.median = cap.median;

    const landed = readOr(`${base}.row`);
    if (landed !== null) {
      // `STATUS:file:passed:total:secs` — the file may itself hold no colon,
      // but split from both ends so it would not matter if it did.
      const parts = landed.trim().split(":");
      const status = STATUS[parts[0] ?? ""] ?? "error";
      row.status = status;
      const secs = Number(parts[parts.length - 1]);
      const total = Number(parts[parts.length - 2]);
      const passed = Number(parts[parts.length - 3]);
      if (Number.isFinite(passed) && Number.isFinite(total) && total > 0) {
        row.passed = passed;
        row.total = total;
      }
      if (Number.isFinite(secs) && status !== "skipped") row.secs = secs;
      if (parts[0] === "OVERTIME") {
        row.message = `green, but ${secs}s is over the per-file budget: split it or make it faster`;
      } else if (status === "fail" || status === "error") {
        const first = (readOr(`${base}.fails`) ?? "").split(RS)[0] ?? "";
        const [title, message] = first.split(US);
        if (title) row.title = title.trim();
        if (message) row.message = message.trim();
      }
      if (status === "wedged" && cap !== undefined) {
        row.message =
          cap.median !== undefined
            ? `stopped at its ${cap.cap}s cap (3× the median of its recent recorded times, ${cap.median}s) — the app stopped answering`
            : `stopped at its ${cap.cap}s cap (no recorded time, so the floor) — the app stopped answering`;
      }
      const h = history.get(file);
      if (h !== undefined) row.history = h;
      return row;
    }

    const started = readOr(`${base}.start`);
    if (started !== null && Number.isFinite(Number(started.trim()))) {
      row.status = "running";
      row.started_at_ms = Number(started.trim());
    }
    return row;
  });
  if (files.length <= CELLS_UP_TO) return rows;
  return rows.filter((r) => r.status !== "pass" && r.status !== "pending");
}

if (import.meta.main) {
  const [rundir, capsFile, ...files] = process.argv.slice(2);
  if (rundir === undefined || capsFile === undefined) {
    process.stdout.write("[]");
  } else {
    process.stdout.write(JSON.stringify(unitRows(rundir, readOr(capsFile), files)));
  }
}
