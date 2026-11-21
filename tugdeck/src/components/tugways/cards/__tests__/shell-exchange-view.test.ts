/**
 * Shell exchange rendering — pure view derivation + data-source projection
 * ([P06], Spec S04). No fake-DOM render: the rendered rows are covered by the
 * app-test; here we pin the pure functions the block + data source read.
 */
import { describe, expect, test } from "bun:test";

import {
  SHELL_SHARE_TRUNCATION_MARKER,
  composeShellShareText,
  deriveShellExchangeView,
  formatShellDuration,
} from "../shell-exchange-view";
import { walkTurnGroups } from "@/lib/session-transcript-data-source";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";

function msg(over: Partial<ShellExchangeMessage>): ShellExchangeMessage {
  return {
    kind: "shell_exchange",
    messageKey: "shell-e1",
    createdAt: 1000,
    exchangeId: "e1",
    command: "ls",
    output: "",
    exitCode: null,
    cwd: "/proj",
    cwdAfter: null,
    startedAtMs: 1000,
    settledAtMs: null,
    ...over,
  };
}

describe("deriveShellExchangeView", () => {
  test("in-flight: no exit label, no duration, terminal has no data yet", () => {
    const v = deriveShellExchangeView(msg({ command: "ls", output: "", settledAtMs: null }));
    expect(v.inFlight).toBe(true);
    expect(v.exitLabel).toBeNull();
    expect(v.durationLabel).toBeNull();
    expect(v.failed).toBe(false);
    expect(v.command).toBe("ls");
  });

  test("a redrawn progress line shows its latest value, running and settled", () => {
    const output = "signing\nIn Progress 0m01s\rIn Progress 0m02s";
    const running = deriveShellExchangeView(msg({ output, settledAtMs: null }));
    expect(running.terminal.stdout).toBe("signing\nIn Progress 0m02s");
    const settled = deriveShellExchangeView(msg({ output, exitCode: 0, settledAtMs: 3000 }));
    expect(settled.terminal.stdout).toBe(running.terminal.stdout);
    // What is shared to context is what the block shows.
    expect(
      composeShellShareText({ command: "x", output, exitCode: 0, settledAtMs: 3000 }),
    ).not.toContain("0m01s");
  });

  test("settled success: exit 0, duration, not failed; terminal is output-only", () => {
    const v = deriveShellExchangeView(
      msg({ output: "a\nb\n", exitCode: 0, cwdAfter: "/proj", settledAtMs: 1012 }),
    );
    expect(v.inFlight).toBe(false);
    expect(v.exitLabel).toBe("exit 0");
    expect(v.durationLabel).toBe("12ms");
    expect(v.failed).toBe(false);
    expect(v.terminal.stdout).toBe("a\nb\n");
    // The terminal data carries NO exit/duration — those render in the Z1B
    // end-state row, not inside the block ([D111]).
    expect(v.terminal.exitCode).toBeUndefined();
    expect(v.terminal.durationMs).toBeUndefined();
    expect(v.terminal.interrupted).toBeUndefined();
  });

  test("settled non-zero: failed + exit N", () => {
    const v = deriveShellExchangeView(msg({ exitCode: 1, settledAtMs: 1005 }));
    expect(v.exitLabel).toBe("exit 1");
    expect(v.failed).toBe(true);
  });

  test("killed / timed-out: null exit code settles to `killed`, failed", () => {
    const v = deriveShellExchangeView(msg({ exitCode: null, settledAtMs: 5000, startedAtMs: 1000 }));
    expect(v.inFlight).toBe(false);
    expect(v.exitLabel).toBe("killed");
    expect(v.failed).toBe(true);
    // No `interrupted` flag on the terminal data — the kill shows as the
    // Z1B "killed" badge.
    expect(v.terminal.interrupted).toBeUndefined();
  });
});

describe("formatShellDuration", () => {
  test("ms under a second, s with one decimal, whole s past 10s", () => {
    expect(formatShellDuration(12)).toBe("12ms");
    expect(formatShellDuration(999)).toBe("999ms");
    expect(formatShellDuration(1200)).toBe("1.2s");
    expect(formatShellDuration(15000)).toBe("15s");
  });
});

describe("composeShellShareText — the share gesture's fenced block ([P08])", () => {
  test("command + output + exit code inside one fence, trailing newline", () => {
    const text = composeShellShareText(
      msg({ command: "git status", output: "On branch main\n", exitCode: 0, settledAtMs: 1010 }),
    );
    expect(text).toBe("```\n$ git status\nOn branch main\n[exit 0]\n```\n");
  });

  test("killed exchange carries [killed] instead of an exit code", () => {
    const text = composeShellShareText(
      msg({ command: "sleep 99", output: "", exitCode: null, settledAtMs: 2000 }),
    );
    expect(text).toBe("```\n$ sleep 99\n[killed]\n```\n");
  });

  test("no output: command and exit line only", () => {
    const text = composeShellShareText(
      msg({ command: "cd /tmp", output: "", exitCode: 0, settledAtMs: 1001 }),
    );
    expect(text).toBe("```\n$ cd /tmp\n[exit 0]\n```\n");
  });

  test("oversized output truncates at a line boundary with the marker; the cap holds", () => {
    const line = "x".repeat(99);
    const output = Array.from({ length: 200 }, () => line).join("\n");
    const text = composeShellShareText(
      msg({ command: "yes", output, exitCode: 0, settledAtMs: 1500 }),
      1000,
    );
    expect(text).toContain(SHELL_SHARE_TRUNCATION_MARKER);
    // The kept output is whole lines within the cap.
    const body = text.split("\n").slice(2, -4);
    for (const kept of body) expect(kept).toBe(line);
    expect(text.length).toBeLessThan(1200);
    expect(text.endsWith("```\n")).toBe(true);
  });

  test("output containing ``` lengthens the fence past the run", () => {
    const text = composeShellShareText(
      msg({ command: "cat doc.md", output: "```js\ncode\n```\n", exitCode: 0, settledAtMs: 1002 }),
    );
    expect(text.startsWith("````\n")).toBe(true);
    expect(text.endsWith("\n````\n")).toBe(true);
  });
});

describe("walkTurnGroups — shell origin yields a single shell row", () => {
  test("a shell turn (one shell_exchange message) → exactly one `shell` group", () => {
    const groups = walkTurnGroups([msg({})], false, "shell");
    expect(groups.length).toBe(1);
    expect(groups[0].kind).toBe("shell");
  });

  test("origin is not inferred from the message — a user turn stays user/assistant", () => {
    // Same single non-user message, but without the shell origin → assistant.
    const groups = walkTurnGroups([msg({})], false, "assistant");
    expect(groups[0].kind).toBe("assistant");
  });
});
