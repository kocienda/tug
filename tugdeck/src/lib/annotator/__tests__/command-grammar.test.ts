/**
 * Pure-logic coverage for the annotator's command grammars.
 *
 * The DOM pass (`annotateContent`) marks `<code>` spans and requires a
 * real DOM at runtime — it's validated in the real app (the transcript
 * command gestures), not via fake-DOM render tests (project policy: no
 * jsdom / happy-dom).
 *
 * This file pins the *pure* grammars — `parseSlashCommandLine` and
 * `parseShellCommandLine` — the strict matchers that decide which code
 * spans are even candidates and split a slash command's name from its
 * argument text. For the slash family the known-command predicate is the
 * authoritative clickability gate, layered on top of this in the app; the
 * shell family gates on the leading tool name alone.
 */

import { describe, expect, test } from "bun:test";

import {
  parseSlashCommandLine,
  parseShellCommandLine,
} from "../command-grammar";

describe("parseSlashCommandLine — accepts well-formed command lines", () => {
  test("bare command", () => {
    expect(parseSlashCommandLine("/diff")).toEqual({ name: "diff", args: "" });
  });

  test("plugin:command", () => {
    expect(parseSlashCommandLine("/tugplug:implement")).toEqual({
      name: "tugplug:implement",
      args: "",
    });
  });

  test("command with a single-word argument", () => {
    expect(parseSlashCommandLine("/model opus")).toEqual({
      name: "model",
      args: "opus",
    });
  });

  test("plugin:command with a path argument", () => {
    expect(
      parseSlashCommandLine("/tugplug:implement dash/find-route.md"),
    ).toEqual({ name: "tugplug:implement", args: "dash/find-route.md" });
  });

  test("multi-word argument is captured whole, trimmed", () => {
    expect(parseSlashCommandLine("/tugplug:implement  a plan ; Steps 3-5")).toEqual(
      { name: "tugplug:implement", args: "a plan ; Steps 3-5" },
    );
  });

  test("single-character command name", () => {
    expect(parseSlashCommandLine("/x")).toEqual({ name: "x", args: "" });
  });

  test("name with interior hyphen / underscore / digit", () => {
    expect(parseSlashCommandLine("/fewer-permission-prompts")).toEqual({
      name: "fewer-permission-prompts",
      args: "",
    });
    expect(parseSlashCommandLine("/claude_api")).toEqual({
      name: "claude_api",
      args: "",
    });
  });

  test("surrounding whitespace on the whole span is tolerated", () => {
    expect(parseSlashCommandLine("  /diff HEAD  ")).toEqual({
      name: "diff",
      args: "HEAD",
    });
  });
});

describe("parseSlashCommandLine — rejects non-commands", () => {
  const rejected = [
    ["empty string", ""],
    ["whitespace only", "   "],
    ["no leading slash", "diff"],
    ["bare slash", "/"],
    ["absolute path (uppercase-led)", "/Users/kocienda/x"],
    ["absolute path (lowercase, interior slash)", "/usr/bin/env"],
    ["url with scheme", "https://status.claude.com"],
    ["leading hyphen in name", "/-diff"],
    ["trailing hyphen in name", "/diff-"],
    ["double colon / two namespaces", "/a:b:c"],
    ["prose that merely contains a slash", "run the /diff command"],
  ] as const;

  for (const [label, input] of rejected) {
    test(label, () => {
      expect(parseSlashCommandLine(input)).toBeNull();
    });
  }
});

describe("parseShellCommandLine — accepts known tool + subcommand", () => {
  const accepted = [
    ["just target", "just launch-debug"],
    ["just target (logs)", "just logs-debug"],
    ["tugtool host subcommand", "tugtool host state-dir"],
    ["tug subcommand", "tugtool changes"],
    ["tugtool dash subcommand with flag", "tugtool dash join --preview"],
    ["tugtool dash subcommand with arg", "tugtool dash join canonical-path-identity"],
  ] as const;

  for (const [label, input] of accepted) {
    test(label, () => {
      expect(parseShellCommandLine(input)).toBe(input);
    });
  }

  test("surrounding whitespace is trimmed off the returned command", () => {
    expect(parseShellCommandLine("  just launch-debug  ")).toBe(
      "just launch-debug",
    );
  });
});

describe("parseShellCommandLine — rejects non-commands", () => {
  const rejected = [
    ["empty string", ""],
    ["whitespace only", "   "],
    ["bare tool name, no subcommand", "just"],
    ["bare tool name + trailing space", "tug "],
    ["unknown tool", "cargo build"],
    ["tool name is a prefix of a longer word", "justice served"],
    ["multi-line span (inline commands are single-line)", "just a\nline"],
    ["a slash command is not a shell command", "/diff HEAD"],
  ] as const;

  for (const [label, input] of rejected) {
    test(label, () => {
      expect(parseShellCommandLine(input)).toBeNull();
    });
  }
});
