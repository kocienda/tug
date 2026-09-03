/**
 * The `/arc-bind` create path's name check, and the registry entry it guards.
 *
 * The check exists because the name is concatenated onto a shell command line,
 * so what it must guarantee is not "this is a valid arc name" — `tugtool` is
 * the real validator — but "this is safe to pass through unquoted".
 */

import { describe, expect, test } from "bun:test";

import { ARC_NAME_CAUTION, isShellSafeArcName } from "../arc-name";
import {
  LOCAL_SLASH_COMMANDS,
  matchLocalSlashCommand,
} from "../slash-commands";
import { classifySlashCommand } from "../slash-supported";

describe("isShellSafeArcName", () => {
  test("accepts the shapes arcs actually get named", () => {
    for (const name of ["fix-join", "a.b_c", "phase2", "A", "9lives", "x_y.z-1"]) {
      expect(isShellSafeArcName(name)).toBe(true);
    }
  });

  test("refuses anything that would need quoting", () => {
    for (const name of [
      "",
      "-leading",
      ".leading",
      "_leading",
      "two words",
      "semi;rm -rf /",
      "dollar$sub",
      "back`tick`",
      "quote'd",
      'double"d',
      "pipe|it",
      "paren()",
      "star*",
      "tugarc/slash",
    ]) {
      expect(isShellSafeArcName(name)).toBe(false);
    }
  });

  test("the caution names the constraint rather than just refusing", () => {
    expect(ARC_NAME_CAUTION).toContain("letters");
    expect(ARC_NAME_CAUTION).toContain("digits");
  });
});

describe("/arc-bind in the local registry", () => {
  test("is registered and takes args", () => {
    const spec = LOCAL_SLASH_COMMANDS.find((cmd) => cmd.name === "arc-bind");
    expect(spec).toBeDefined();
    expect(spec!.takesArgs).toBe(true);
    // The description is authored once here and the /help row derives from it.
    expect(spec!.description.length).toBeGreaterThan(0);
  });

  // The three card verbs are spelled for the `tugtool arc` paths they ride
  // ([P08]), so the registry is where that spelling is pinned: a rename that
  // moved the CLI without moving the card would leave a gesture nothing
  // answers.
  test("its two siblings are registered under the same spelling rule", () => {
    const join = LOCAL_SLASH_COMMANDS.find((cmd) => cmd.name === "arc-join");
    expect(join).toBeDefined();
    expect(join!.takesArgs).toBe(true);
    const review = LOCAL_SLASH_COMMANDS.find((cmd) => cmd.name === "arc-review");
    expect(review).toBeDefined();
    expect(review!.takesArgs).toBe(true);
  });

  test("both forms match, and the argument form carries the name", () => {
    expect(matchLocalSlashCommand("/arc-bind")).toEqual({
      name: "arc-bind",
      args: "",
    });
    expect(matchLocalSlashCommand("/arc-bind fix-join")).toEqual({
      name: "arc-bind",
      args: "fix-join",
    });
  });

  test("classifies as supported-local with no second edit", () => {
    expect(classifySlashCommand("arc-bind")).toBe("supported-local");
  });
});
