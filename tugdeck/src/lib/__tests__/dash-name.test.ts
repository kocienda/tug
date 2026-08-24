/**
 * The `/dash-bind` create path's name check, and the registry entry it guards.
 *
 * The check exists because the name is concatenated onto a shell command line,
 * so what it must guarantee is not "this is a valid dash name" — `tugutil` is
 * the real validator — but "this is safe to pass through unquoted".
 */

import { describe, expect, test } from "bun:test";

import { DASH_NAME_CAUTION, isShellSafeDashName } from "../dash-name";
import {
  LOCAL_SLASH_COMMANDS,
  matchLocalSlashCommand,
} from "../slash-commands";
import { classifySlashCommand } from "../slash-supported";

describe("isShellSafeDashName", () => {
  test("accepts the shapes dashes actually get named", () => {
    for (const name of ["fix-join", "a.b_c", "phase2", "A", "9lives", "x_y.z-1"]) {
      expect(isShellSafeDashName(name)).toBe(true);
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
      "tugdash/slash",
    ]) {
      expect(isShellSafeDashName(name)).toBe(false);
    }
  });

  test("the caution names the constraint rather than just refusing", () => {
    expect(DASH_NAME_CAUTION).toContain("letters");
    expect(DASH_NAME_CAUTION).toContain("digits");
  });
});

describe("/dash-bind in the local registry", () => {
  test("is registered and takes args", () => {
    const spec = LOCAL_SLASH_COMMANDS.find((cmd) => cmd.name === "dash-bind");
    expect(spec).toBeDefined();
    expect(spec!.takesArgs).toBe(true);
    // The description is authored once here and the /help row derives from it.
    expect(spec!.description.length).toBeGreaterThan(0);
  });

  test("both forms match, and the argument form carries the name", () => {
    expect(matchLocalSlashCommand("/dash-bind")).toEqual({
      name: "dash-bind",
      args: "",
    });
    expect(matchLocalSlashCommand("/dash-bind fix-join")).toEqual({
      name: "dash-bind",
      args: "fix-join",
    });
  });

  test("classifies as supported-local with no second edit", () => {
    expect(classifySlashCommand("dash-bind")).toBe("supported-local");
  });

  test("does not shadow /join", () => {
    expect(matchLocalSlashCommand("/join snippets")).toEqual({
      name: "join",
      args: "snippets",
    });
  });
});
