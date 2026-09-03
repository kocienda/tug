// Run the E1 harness N times and aggregate.
//
// Usage: bun run tugcode/scripts/run-e1-batch.ts [N=10]
//
// Output: a JSON summary of all N runs, plus stats (mean, median,
// min, max, stddev) on the delta between t_result_stdout and
// t_jsonl_assistant_complete.

import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const N = Number(process.argv[2] ?? 10);
const tracesDir = resolve("target/mid-turn-replay-traces");
const harnessPath = resolve("tugcode/scripts/investigate-jsonl-flush-timing.ts");
mkdirSync(tracesDir, { recursive: true });

interface SingleReport {
  exit_code: number | null;
  derived: {
    t_result_stdout_ms: number | null;
    t_jsonl_assistant_complete_ms: number | null;
    t_jsonl_settled_ms: number | null;
    delta_jsonl_complete_minus_result_ms: number | null;
    delta_jsonl_settled_minus_result_ms: number | null;
  };
  notes: string[];
  stdout: Array<{ type: string }>;
}

interface Stats {
  n: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  stddev: number;
  raw: number[];
}

function stats(values: number[]): Stats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[(sorted.length - 1) / 2];
  const variance = sorted.reduce((a, v) => a + (v - mean) ** 2, 0) / sorted.length;
  const stddev = Math.sqrt(variance);
  return {
    n: sorted.length,
    mean: Math.round(mean * 100) / 100,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stddev: Math.round(stddev * 100) / 100,
    raw: sorted,
  };
}

const reports: SingleReport[] = [];
for (let i = 1; i <= N; i++) {
  const out = join(tracesDir, `e1-batch-run-${i.toString().padStart(2, "0")}.json`);
  console.error(`[${i}/${N}] running… → ${out}`);
  const proc = Bun.spawn([
    "bun", "run", harnessPath, "--out", out,
  ], { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`  run ${i} exited ${code}; reading anyway`);
  }
  if (existsSync(out)) {
    const text = readFileSync(out, "utf8");
    const report = JSON.parse(text) as SingleReport;
    reports.push(report);
  }
}

// Aggregate.
const completeDeltas = reports
  .map((r) => r.derived.delta_jsonl_complete_minus_result_ms)
  .filter((v): v is number => v !== null);
const settledDeltas = reports
  .map((r) => r.derived.delta_jsonl_settled_minus_result_ms)
  .filter((v): v is number => v !== null);

const summary = {
  total_runs: reports.length,
  runs_with_result_event: reports.filter((r) => r.derived.t_result_stdout_ms !== null).length,
  runs_with_jsonl_assistant_complete: reports.filter((r) => r.derived.t_jsonl_assistant_complete_ms !== null).length,
  delta_jsonl_complete_minus_result_ms_stats: stats(completeDeltas),
  delta_jsonl_settled_minus_result_ms_stats: stats(settledDeltas),
  per_run: reports.map((r, i) => ({
    run: i + 1,
    exit_code: r.exit_code,
    delta_complete_ms: r.derived.delta_jsonl_complete_minus_result_ms,
    delta_settled_ms: r.derived.delta_jsonl_settled_minus_result_ms,
    notes: r.notes,
    stdout_count: r.stdout.length,
  })),
};

const summaryPath = join(tracesDir, "e1-batch-summary.json");
await Bun.write(summaryPath, JSON.stringify(summary, null, 2));
console.error(`Wrote summary: ${summaryPath}`);
console.log(JSON.stringify(summary.delta_jsonl_complete_minus_result_ms_stats, null, 2));
