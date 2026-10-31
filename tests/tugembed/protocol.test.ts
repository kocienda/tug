/**
 * The JSON-lines protocol of `tugembed`, against the built helper and the real
 * NaturalLanguage models on this machine.
 *
 * @covers tugapp/tugembed/main.swift
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const HELPER = join(mkdtempSync(join(tmpdir(), "tugembed-")), "tugembed");

interface Line {
  event?: string;
  id?: number;
  model?: string;
  dimensions?: number;
  vectors?: (number[] | null)[];
  error?: string;
}

/** Feed `input` to one helper, close its stdin, and read every line it wrote. */
function converse(args: string[], input: unknown[]): { lines: Line[]; exitCode: number } {
  const stdin = input
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
  const run = Bun.spawnSync([HELPER, ...args], {
    stdin: Buffer.from(stdin.length > 0 ? `${stdin}\n` : ""),
  });
  const text = run.stdout.toString();
  return {
    lines: text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Line),
    exitCode: run.exitCode,
  };
}

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
}

/**
 * A machine with neither model is a state the protocol has an answer for, and a
 * CI image may be one. Holds that answer, and says whether a model is live.
 */
function hasModel(args: string[]): boolean {
  const { lines } = converse(args, [{ id: 1, op: "embed", texts: ["a"] }]);
  if (lines[0]?.model !== undefined) {
    return true;
  }
  expect(lines[0]).toEqual({ event: "model" });
  expect(lines[1]).toEqual({ id: 1, error: "no embedding model is available" });
  return false;
}

beforeAll(() => {
  const compile = Bun.spawnSync(["bash", join(REPO_ROOT, "tugrust/scripts/compile-tugembed.sh"), HELPER]);
  if (compile.exitCode !== 0) {
    throw new Error(compile.stderr.toString());
  }
});

describe("tugembed", () => {
  test("announces its model first, and end of input ends it cleanly", () => {
    const { lines, exitCode } = converse([], []);
    expect(exitCode).toBe(0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]?.event).toBe("model");
    if (!hasModel([])) {
      return;
    }
    expect(lines[0]?.model).toMatch(/^nl-(contextual|sentence)-r\d+$/);
    expect(lines[0]?.dimensions).toBe(512);
  });

  test("a malformed line is answered and does not end the conversation", () => {
    const { lines, exitCode } = converse(["--static"], [
      "this is not json",
      { id: 1, op: "translate", texts: ["a"] },
      { op: "embed", texts: ["a"] },
      { id: 2, op: "embed", texts: ["a sentence"] },
    ]);
    expect(exitCode).toBe(0);
    const [, garbled, unknownOp, noId, good] = lines;
    expect(garbled?.error).toBe("not a request");
    expect(unknownOp?.id).toBe(1);
    expect(unknownOp?.error).toBeString();
    expect(noId?.id).toBeUndefined();
    expect(noId?.error).toBeString();
    expect(good?.id).toBe(2);
    expect(good?.vectors?.length === 1 || typeof good?.error === "string").toBe(true);
  });

  for (const [label, args] of [
    ["the live model", []],
    ["the static model", ["--static"]],
  ] as [string, string[]][]) {
    test(`${label} tags unit vectors with itself and ranks by meaning`, () => {
      if (!hasModel(args)) {
        return;
      }
      const { lines } = converse(args, [
        {
          id: 7,
          op: "embed",
          texts: ["how do I create an arc?", "Opening an arc", "Sidebar cards", ""],
        },
      ]);
      // The assets can land mid-conversation, so the model a vector belongs to
      // is the last one announced ahead of it.
      const answerAt = lines.findIndex((line) => line.id === 7);
      const answer = lines[answerAt];
      const announced = lines.slice(0, answerAt).findLast((line) => line.event === "model");
      expect(answer?.model).toBe(announced?.model);
      expect(answer?.vectors?.length).toBe(4);

      const [question, opening, sidebar, empty] = answer?.vectors ?? [];
      expect(empty).toBeNull();
      for (const vector of [question, opening, sidebar]) {
        expect(vector?.length).toBe(announced?.dimensions);
        expect(dot(vector ?? [], vector ?? [])).toBeCloseTo(1, 3);
      }
      expect(dot(question ?? [], opening ?? [])).toBeGreaterThan(dot(question ?? [], sidebar ?? []));
    });
  }

  test("the helper runs at the priority it was started at", async () => {
    const helper = Bun.spawn([HELPER], { stdin: "pipe", stdout: "pipe" });
    const niceOf = (pid: number) =>
      Bun.spawnSync(["ps", "-o", "nice=", "-p", String(pid)]).stdout.toString().trim();
    try {
      // The model line is written after anything the helper does to itself at launch.
      await helper.stdout.getReader().read();
      expect(niceOf(helper.pid)).toBe(niceOf(process.pid));
    } finally {
      helper.kill();
    }
  });

  test("--static names the sentence model", () => {
    if (!hasModel(["--static"])) {
      return;
    }
    const { lines } = converse(["--static"], []);
    expect(lines[0]?.model).toMatch(/^nl-sentence-r\d+$/);
  });

  /** The vectors for `texts`, and the model they were answered under. */
  function embedded(args: string[], texts: string[]): { model?: string; vectors: (number[] | null)[] } {
    const { lines } = converse(args, [{ id: 9, op: "embed", texts }]);
    const answer = lines.find((line) => line.id === 9);
    return { model: answer?.model, vectors: answer?.vectors ?? [] };
  }

  const SPANISH = "Las notas de cada versión se escriben primero en español y se traducen antes de publicarse.";
  const CHINESE = "每个版本的说明都先用中文写好,然后在发布之前翻译成其他语言,这样团队里的每个人都能读懂。";

  test("a covered language gets a vector under the one tag, and an uncovered one none", () => {
    if (!hasModel([])) {
      return;
    }
    const { model, vectors } = embedded([], [SPANISH, CHINESE]);
    expect(model).toMatch(/^nl-(contextual|sentence)-r\d+$/);
    const [spanish, chinese] = vectors;
    expect(dot(spanish ?? [], spanish ?? [])).toBeCloseTo(1, 3);
    expect(chinese).toBeNull();
  });

  test("what the recognizer is not sure of keeps its vector", () => {
    if (!hasModel([])) {
      return;
    }
    const { vectors } = embedded([], ["fn main() { let x = foo(1, 2); }", "ok", "a1b2c3d4 at0339 9f3c1e5a"]);
    expect(vectors.length).toBe(3);
    for (const vector of vectors) {
      expect(vector).not.toBeNull();
    }
  });

  test("--static gives a language its own model's dimension, and has none for Chinese", () => {
    if (!hasModel(["--static"])) {
      return;
    }
    const { model, vectors } = embedded(["--static"], [SPANISH, CHINESE, "an English sentence about arcs"]);
    expect(model).toMatch(/^nl-sentence-r\d+$/);
    const [spanish, chinese, english] = vectors;
    expect(spanish?.length).toBe(640);
    expect(dot(spanish ?? [], spanish ?? [])).toBeCloseTo(1, 3);
    expect(chinese).toBeNull();
    expect(english?.length).toBe(512);
  });
});
