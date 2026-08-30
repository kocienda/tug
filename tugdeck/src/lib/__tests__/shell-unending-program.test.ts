import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  resolveSubmitDestination,
  unendingProgram,
} from "../shell-line-classifier";

/**
 * The routing corpus the live gate scores, read rather than copied — the same
 * file `vetoesShellVerdict`'s tests read, for the same reason. A list that
 * caught ordinary command lines would have taken the feature down with `yes`.
 */
function corpusLines(label: "shell" | "prompt"): string[] {
  const path = join(import.meta.dir, "../../../../tests/model-eval/classify-corpus.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const cases = Array.isArray(parsed)
    ? parsed
    : (parsed as { cases: unknown[] }).cases;
  return (cases as { text: string; label: string }[])
    .filter((c) => c.label === label)
    .map((c) => c.text);
}

describe("unendingProgram", () => {
  it("names the program that locked the app", () => {
    expect(unendingProgram("yes")).toBe("yes");
  });

  it("names it however it is spelled or wrapped", () => {
    for (const line of ["yes hello", "/usr/bin/yes", "sudo yes", "FOO=1 yes", "  yes  "]) {
      expect(unendingProgram(line), line).toBe("yes");
    }
  });

  it("names the rest of the list", () => {
    expect(unendingProgram("top")).toBe("top");
    expect(unendingProgram("vim src/main.rs")).toBe("vim");
    expect(unendingProgram("watch ls")).toBe("watch");
    expect(unendingProgram("tmux")).toBe("tmux");
  });

  it("leaves every other line alone", () => {
    for (const line of [
      "ls -la",
      "git status",
      "cargo nextest run",
      "node index.js",
      "tail -30 /tmp/build.log",
      "yesterday's notes",
      "rg TODO src",
    ]) {
      expect(unendingProgram(line), line).toBeNull();
    }
  });

  // The list reads the program the line runs, not every word in it: a `yes`
  // downstream of a pipe is somebody's deliberate, bounded line.
  it("reads only the program the line opens on", () => {
    expect(unendingProgram("git log | wc -l")).toBeNull();
    expect(unendingProgram('git commit -m "say yes to the merge"')).toBeNull();
  });

  // Refusing a line the corpus labels `shell` is not a miss — `yes` really is a
  // shell command. It is a refusal to run it anyway. Pinned as a closed set so
  // a name added carelessly shows up here as the decision it would be.
  it("refuses exactly one of the shell-labeled corpus cases", () => {
    expect(corpusLines("shell").filter((t) => unendingProgram(t) !== null)).toEqual(["yes"]);
  });
});

describe("resolveSubmitDestination — a never-ending program outranks every other fact", () => {
  const decide = (
    over: Partial<Parameters<typeof resolveSubmitDestination>[0]>,
  ): ReturnType<typeof resolveSubmitDestination> =>
    resolveSubmitDestination({
      line: "yes",
      modelCall: "run",
      verdict: null,
      withdrawn: false,
      ...over,
    });

  // The `run` band is the row `yes` actually arrived on: every token accounted
  // for, no model call, straight to the shell. That is what this closes.
  it("keeps a graded run band out of the shell", () => {
    expect(decide({})).toBe("claude");
  });

  it("keeps an explicit shell verdict out of the shell", () => {
    expect(decide({ modelCall: "ask", verdict: "shell" })).toBe("claude");
    expect(decide({ modelCall: "ask-with-grammar", verdict: "shell" })).toBe("claude");
  });

  it("still yields to a withdrawal", () => {
    expect(decide({ withdrawn: true })).toBe("withdrawn");
  });
});
