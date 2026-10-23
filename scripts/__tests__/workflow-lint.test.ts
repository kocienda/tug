/**
 * workflow-lint over fixture workflows: each shape the lint must refuse is one
 * failure, and the checkout's own workflow files are none.
 */
import { describe, expect, test } from "bun:test";
import { lintWorkflows, readRecipes, readWorkflows } from "../workflow-lint";

const RECIPES = ["test-rust", "lint-audit", "wasm-check", "ci-full"];

/** A `ci.yml` with one job of the given body. */
function ci(job: string): { path: string; text: string } {
  return { path: ".github/workflows/ci.yml", text: `name: CI\non:\n  push:\n    branches: [main]\njobs:\n  rust-fast:\n${job}` };
}

const GOOD_JOB = `    runs-on: macos-26
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v5
      - name: Install Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version
      - name: Rust fast lane
        run: just test-rust
`;

describe("workflow-lint", () => {
  test("passes a job that calls a known recipe under the budget with the bun pin", () => {
    expect(lintWorkflows([ci(GOOD_JOB)], RECIPES)).toEqual([]);
  });

  test("refuses a `just` line naming a recipe the Justfile does not have", () => {
    const failures = lintWorkflows([ci(GOOD_JOB.replace("just test-rust", "just no-such-recipe"))], RECIPES);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("`just no-such-recipe` names no recipe");
  });

  test("reads a `just` call inside a multi-line run block", () => {
    const job = GOOD_JOB.replace("        run: just test-rust\n", "        run: |\n          echo start\n          just no-such-recipe\n");
    const failures = lintWorkflows([ci(job)], RECIPES);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("just no-such-recipe");
  });

  test("refuses a ci.yml job without timeout-minutes: 5", () => {
    expect(lintWorkflows([ci(GOOD_JOB.replace("    timeout-minutes: 5\n", ""))], RECIPES)).toHaveLength(1);
    const over = lintWorkflows([ci(GOOD_JOB.replace("timeout-minutes: 5", "timeout-minutes: 10"))], RECIPES);
    expect(over).toHaveLength(1);
    expect(over[0]).toContain("timeout-minutes: 5");
  });

  test("the budget rule is ci.yml's alone", () => {
    const other = { path: ".github/workflows/full-lane.yml", text: ci(GOOD_JOB.replace("timeout-minutes: 5", "timeout-minutes: 60")).text };
    expect(lintWorkflows([other], RECIPES)).toEqual([]);
  });

  test("refuses a setup-bun step carrying bun-version: 1.3.x", () => {
    const failures = lintWorkflows([ci(GOOD_JOB.replace("bun-version-file: .bun-version", "bun-version: 1.3.x"))], RECIPES);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("carries `bun-version:`");
    expect(failures[1]).toContain("must carry `bun-version-file: .bun-version`");
  });

  test("refuses a setup-bun step with no pin at all", () => {
    const job = GOOD_JOB.replace("        with:\n          bun-version-file: .bun-version\n", "");
    expect(lintWorkflows([ci(job)], RECIPES)).toHaveLength(1);
  });

  test("refuses a file that does not parse", () => {
    const failures = lintWorkflows([{ path: "ci.yml", text: "jobs:\n  a: [\n" }], RECIPES);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("does not parse as YAML");
  });

  test("a reusable-workflow job with no steps is read without error", () => {
    const text = "name: N\non:\n  workflow_dispatch:\njobs:\n  full-lane:\n    uses: ./.github/workflows/full-lane.yml\n";
    expect(lintWorkflows([{ path: "nightly.yml", text }], RECIPES)).toEqual([]);
  });

  test("the checkout's own workflow files are clean", () => {
    const files = readWorkflows();
    expect(files.map((f) => f.path.split("/").pop())).toEqual(["ci.yml", "full-lane.yml", "nightly.yml", "release.yml", "wasm.yml"]);
    expect(lintWorkflows(files, readRecipes())).toEqual([]);
  });
});
