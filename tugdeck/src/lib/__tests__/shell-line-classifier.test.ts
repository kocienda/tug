import { describe, it, expect } from "bun:test";

import {
  isShellCandidate,
  modelCallForBand,
  resolveSubmitDestination,
  ShellVerdictCache,
  spliceContinuations,
} from "../shell-line-classifier";

// A representative login-PATH set. The precondition keys the first command token
// against this; a line opening on anything else cannot be a command.
const COMMANDS: ReadonlySet<string> = new Set([
  "ls", "git", "cargo", "make", "cat", "grep", "rg", "cd", "pwd", "echo",
  "cp", "mv", "rm", "mkdir", "touch", "find", "man", "time", "test", "sort",
  "head", "tail", "less", "more", "which", "open", "npm", "bun", "node",
  "python", "python3", "docker", "kubectl", "ssh", "curl", "tar", "chmod",
  "sed", "awk", "kill", "ps", "top", "df", "du", "tmux", "write", "apply",
  "sleep", "say", "who", "last", "join", "split", "yes",
]);

// Real command lines. Every one must survive the precondition and reach the
// model — this is the coverage the routing feature exists to serve.
const COMMAND_LINES: readonly string[] = [
  "ls",
  "ls -la",
  "pwd",
  "git status",
  "git commit -am wip",
  "git push origin main",
  "cargo build",
  "cargo nextest run 2>&1 | tail -30",
  "./scripts/build.sh --release",
  "FOO=1 make test",
  "make test",
  "npm run build",
  "bun test",
  "node index.js",
  "python3 -m venv .venv",
  "docker ps -a",
  "kubectl get pods",
  "grep -rn TODO src",
  "rg --files",
  "cat README.md",
  "cd tugrust && cargo nextest run",
  "rm -rf dist",
  "mkdir -p build/out",
  "cp -r a b",
  "mv old new",
  "chmod +x run.sh",
  "sed -n '1,20p' file.rs",
  "curl -sSL https://example.com/x",
  "tar -xzf archive.tar.gz",
  "ssh host 'uptime'",
  "ps aux | grep node",
  "df -h",
  "du -sh *",
  "echo $HOME",
  "git log --oneline -10",
  "find . -name '*.rs'",
  "which bun",
  "head Justfile",
  "open .",
  "sort names",
];

// Prose whose first word is not a program at all. These are settled by fact —
// there is nothing to run — so they must never cost a model round trip.
const PROSE_WITHOUT_A_BINARY: readonly string[] = [
  "why is this so slow?",
  "how do I run the tests?",
  "what does this function do?",
  "can you explain this code",
  "please add a test for the edge case",
  "we should refactor the store layer",
  "the parser needs a new rule",
  "look at the way this is structured",
  "explain the ownership model here",
  "rewrite this to use iterators",
  "is there a cleaner way to do this",
  "add error handling to the loop",
  "review my changes and suggest fixes",
  "summarize what changed in this file",
  "walk me through the auth flow",
  "do you think this is thread safe",
  "frobnicate the widget",
];

// Prose that opens on a real executable. English verbs that are also PATH
// binaries are the whole reason intent is not decided here: on a stock macOS
// install `write`, `say`, `who`, `last`, `join`, `split`, `yes`, `top` and
// `sleep` are all real, and the set grows with whatever else is on a given
// machine's PATH. Each of these must reach the model — the module must not
// form an opinion about any of them.
const PROSE_OPENING_WITH_A_BINARY: readonly string[] = [
  "write me a haiku about summertime",
  "top of the file needs a docblock",
  "sleep is what I need after this bug",
  "find the bug in the parser",
  "test whether the parser handles unicode",
  "make sure the tests pass",
  "sort out this mess for me",
  "head to the next section",
  "touch base with me about this",
  "open the door for extension",
  "cat and dog pictures please",
  "time to refactor this module",
  "less is more in this design",
  "which approach do you recommend",
];

describe("isShellCandidate — real commands reach the model", () => {
  it("covers a broad command corpus", () => {
    expect(COMMAND_LINES.length).toBeGreaterThanOrEqual(30);
  });

  it("admits every command line", () => {
    for (const line of COMMAND_LINES) {
      expect(isShellCandidate(line, COMMANDS)).toBe(true);
    }
  });

  it("admits a line behind an env-assignment prefix", () => {
    expect(isShellCandidate("FOO=1 BAR=2 make test", COMMANDS)).toBe(true);
  });

  it("admits a path-shaped program that is not on the PATH", () => {
    expect(isShellCandidate("./bin/tool --run", COMMANDS)).toBe(true);
    expect(isShellCandidate("~/bin/tool", COMMANDS)).toBe(true);
    expect(isShellCandidate("/usr/bin/true", COMMANDS)).toBe(true);
  });
});

describe("isShellCandidate — prose that cannot be a command is settled by fact", () => {
  it("covers a broad prose corpus", () => {
    expect(PROSE_WITHOUT_A_BINARY.length).toBeGreaterThanOrEqual(15);
  });

  it("rejects prose whose first word names no program", () => {
    for (const line of PROSE_WITHOUT_A_BINARY) {
      expect(isShellCandidate(line, COMMANDS)).toBe(false);
    }
  });
});

describe("isShellCandidate — intent is never decided here", () => {
  // The failure this pins is a regression to the deleted heuristics: a stopword
  // list, an "ambiguous opener" list, or a token-count rule would send these
  // lines somewhere without asking. Whether they are prose is the model's
  // question, and the model only gets asked about candidates.
  it("admits prose that opens with an executable, same as a command", () => {
    for (const line of PROSE_OPENING_WITH_A_BINARY) {
      expect(isShellCandidate(line, COMMANDS)).toBe(true);
    }
  });

  it("does not distinguish a real command from prose sharing its opener", () => {
    expect(isShellCandidate("write kocienda ttys001", COMMANDS)).toBe(
      isShellCandidate("write me a haiku about summertime", COMMANDS),
    );
    expect(isShellCandidate("head Justfile", COMMANDS)).toBe(
      isShellCandidate("head back to the previous approach", COMMANDS),
    );
  });

  it("admits a question that opens with an executable", () => {
    // A trailing `?` used to force prose here. It is a strong signal, but it is
    // the model's signal to read — and `git status?` is the model's call.
    expect(isShellCandidate("git status?", COMMANDS)).toBe(true);
  });
});

describe("spliceContinuations — one logical line, or nothing", () => {
  it("joins a command written across backslash continuations", () => {
    const drafted =
      'git commit -m "subject" \\\n  a.test.ts \\\n  b.test.ts';
    expect(spliceContinuations(drafted)).toBe(
      'git commit -m "subject"   a.test.ts   b.test.ts',
    );
  });

  it("leaves a line with no continuation exactly as it was", () => {
    expect(spliceContinuations("git status")).toBe("git status");
  });

  it("refuses text whose newlines are not continuations", () => {
    expect(spliceContinuations("cd /tmp\nls")).toBeNull();
    // A backslash mid-line is an escape, not a continuation.
    expect(spliceContinuations("ls a\\ b\nls")).toBeNull();
  });

  it("refuses prose that happens to carry a continuation", () => {
    expect(
      spliceContinuations("explain this \\\nand then\nfix it"),
    ).toBeNull();
  });

  it("splices a pasted CRLF continuation", () => {
    expect(spliceContinuations("ls \\\r\n-la")).toBe("ls -la");
  });

  it("hands the spliced line to the precondition, which then admits it", () => {
    const drafted = 'git commit -m "subject" \\\n  a.test.ts';
    const line = spliceContinuations(drafted);
    expect(line).not.toBeNull();
    expect(isShellCandidate(line!, COMMANDS)).toBe(true);
  });
});

describe("isShellCandidate — gates", () => {
  it("rejects everything while the command set is still loading", () => {
    expect(isShellCandidate("ls -la", null)).toBe(false);
    expect(isShellCandidate("git status", null)).toBe(false);
  });

  it("rejects an empty line", () => {
    expect(isShellCandidate("", COMMANDS)).toBe(false);
  });

  it("rejects a slash command without rejecting an absolute path", () => {
    expect(isShellCandidate("/shell ls", COMMANDS)).toBe(false);
    expect(isShellCandidate("/tugplug:draft", COMMANDS)).toBe(false);
    expect(isShellCandidate("/usr/bin/true", COMMANDS)).toBe(true);
  });

  it("rejects a comment or prose aside", () => {
    expect(isShellCandidate("# note to self", COMMANDS)).toBe(false);
  });

  it("rejects a line past the length ceiling", () => {
    expect(isShellCandidate(`ls ${"x".repeat(401)}`, COMMANDS)).toBe(false);
  });

  it("rejects a line that is only an env assignment", () => {
    expect(isShellCandidate("FOO=1", COMMANDS)).toBe(false);
  });
});

describe("modelCallForBand — what a grade means for the model call", () => {
  it("withholds the model only on evidence of absence", () => {
    expect(modelCallForBand("no")).toBe("skip");
  });

  it("arms the model with documentation exactly when grammar could not confirm", () => {
    expect(modelCallForBand("maybe")).toBe("ask-with-grammar");
  });

  it("runs a line whose every token the grammar recognized", () => {
    // A `yes` is a statement of fact about tokens, not a judgement about
    // meaning: the grader reached it only by accounting for every one of them
    // against the program's own grammar, so no position in the line was left
    // for English. `make the watch loop resilient` grades `maybe` and never
    // arrives here.
    expect(modelCallForBand("yes")).toBe("run");
  });

  it("asks the plain question when there is no grammar to have an opinion", () => {
    expect(modelCallForBand("unknown")).toBe("ask");
  });

  it("reaches the shell on one band only", () => {
    const routing = (["yes", "maybe", "no", "unknown"] as const).filter(
      (band) => modelCallForBand(band) === "run",
    );
    expect(routing).toEqual(["yes"]);
  });
});

describe("resolveSubmitDestination — where a submitted line ends up", () => {
  const decide = (
    over: Partial<Parameters<typeof resolveSubmitDestination>[0]>,
  ): ReturnType<typeof resolveSubmitDestination> =>
    resolveSubmitDestination({
      line: "ls -la",
      modelCall: "ask",
      verdict: null,
      withdrawn: false,
      ...over,
    });

  it("routes a run band with no model call", () => {
    expect(decide({ modelCall: "run", verdict: null })).toBe("shell");
  });

  it("sends a skip band to Claude without consulting a verdict", () => {
    expect(decide({ modelCall: "skip", verdict: "shell" })).toBe("claude");
  });

  it("routes an explicit shell verdict that survives the veto", () => {
    expect(decide({ verdict: "shell" })).toBe("shell");
    expect(decide({ modelCall: "ask-with-grammar", verdict: "shell" })).toBe(
      "shell",
    );
  });

  it("keeps a vetoed shell verdict out of the shell", () => {
    expect(decide({ line: "rg the src", verdict: "shell" })).toBe("claude");
  });

  // The asymmetry, stated as a closed set: an unanswered wait, a refusal, and
  // a `prompt` are one answer, because a wrongly-run command cannot be
  // un-run while a wrong send costs a keystroke.
  it("treats every answer that is not shell as Claude", () => {
    for (const verdict of ["prompt", null] as const) {
      expect(decide({ verdict })).toBe("claude");
    }
  });

  // Withdrawal outranks the whole table. It is only sound because nothing has
  // executed or been sent by the time this answers.
  it("withdraws whatever the facts would otherwise have said", () => {
    expect(decide({ withdrawn: true, modelCall: "run" })).toBe("withdrawn");
    expect(decide({ withdrawn: true, verdict: "shell" })).toBe("withdrawn");
    expect(decide({ withdrawn: true, modelCall: "skip" })).toBe("withdrawn");
  });

  // Two ways in and no third: a `run` band (which never consults a verdict)
  // and a surviving `shell` verdict on one of the asking bands.
  it("reaches the shell only by a run band or a surviving shell verdict", () => {
    const calls = ["run", "skip", "ask", "ask-with-grammar"] as const;
    const verdicts = ["shell", "prompt", null] as const;
    const reaching = calls.flatMap((modelCall) =>
      verdicts
        .filter((verdict) => decide({ modelCall, verdict }) === "shell")
        .map((verdict) => `${modelCall}/${String(verdict)}`),
    );
    expect(reaching.sort()).toEqual([
      "ask-with-grammar/shell",
      "ask/shell",
      "run/null",
      "run/prompt",
      "run/shell",
    ]);
  });
});

describe("ShellVerdictCache", () => {
  it("remembers a verdict by exact draft text", () => {
    const cache = new ShellVerdictCache();
    cache.set("make test", "shell");
    expect(cache.get("make test")).toBe("shell");
    expect(cache.get("make tests")).toBeUndefined();
  });

  it("drops the oldest entry past its capacity", () => {
    const cache = new ShellVerdictCache();
    for (let i = 0; i <= ShellVerdictCache.capacity; i += 1) {
      cache.set(`line ${i}`, "prompt");
    }
    expect(cache.size).toBe(ShellVerdictCache.capacity);
    expect(cache.get("line 0")).toBeUndefined();
    expect(cache.get(`line ${ShellVerdictCache.capacity}`)).toBe("prompt");
  });

  it("keeps a repeatedly-consulted draft hot rather than aging it out", () => {
    const cache = new ShellVerdictCache();
    cache.set("keep me", "shell");
    for (let i = 0; i < ShellVerdictCache.capacity - 1; i += 1) {
      cache.set(`filler ${i}`, "prompt");
    }
    cache.set("keep me", "shell");
    cache.set("one more", "prompt");
    expect(cache.get("keep me")).toBe("shell");
    expect(cache.get("filler 0")).toBeUndefined();
  });

  it("remembers the grammar-bearing answer apart from the plain one", () => {
    // A verdict formed while reading the program's documentation is a
    // different answer to a different question, so it cannot stand in for the
    // plain one or be overwritten by it.
    const cache = new ShellVerdictCache();
    cache.set("git stauts", "prompt", true);
    expect(cache.get("git stauts", true)).toBe("prompt");
    expect(cache.get("git stauts")).toBeUndefined();
    cache.set("git stauts", "shell");
    expect(cache.get("git stauts")).toBe("shell");
    expect(cache.get("git stauts", true)).toBe("prompt");
  });

  it("clears wholesale", () => {
    const cache = new ShellVerdictCache();
    cache.set("make test", "shell");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("make test")).toBeUndefined();
  });
});
