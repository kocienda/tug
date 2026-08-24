/**
 * slash-dash-reclamation.test.ts — the bare `/dash` belongs to the
 * `tugplug:dash` orchestrator skill, and gets there through the ordinary
 * three-tier classifier rather than through any special case.
 *
 * `dash` was a locally-registered retired spelling of `/dash-bind`, so a typed
 * `/dash` never reached Claude at all. Surrendering the name only works
 * because every hop after the local miss resolves: not hidden, not unknown,
 * and canonicalized to the qualified form on the wire. Each hop is pinned
 * here, in the order `performSubmit` runs them.
 */

import { describe, expect, test } from "bun:test";
import {
  LOCAL_SLASH_COMMANDS,
  matchLocalSlashCommand,
} from "@/lib/slash-commands";
import {
  canonicalizeBareCommandLine,
  classifySlashCommand,
  isHiddenSlashCommand,
  isUnknownRemoteCommand,
  resolveRemoteCommand,
} from "@/lib/slash-supported";

/**
 * The plugin's qualified skill names, as `enumeratePluginCommands` emits them
 * — one entry per directory under `tugplug/skills/`. Written literally so the
 * resolution below is proved against the real leaf set rather than against a
 * catalog shaped to make it pass: what makes `dash` resolve is that **no other
 * entry shares its leaf**, and that is only true of the real list.
 */
const PLUGIN_CATALOG = [
  "tugplug:dash",
  "tugplug:dash-audit",
  "tugplug:dash-implement",
  "tugplug:dash-join",
  "tugplug:dash-on",
  "tugplug:draft",
  "tugplug:history",
  "tugplug:plan-devise",
  "tugplug:plan-review",
  "tugplug:spike-card",
] as const;

/** The catalog as a card sees it: claude's own commands plus the plugin's. */
const CATALOG = ["init", "insights", "recap", "compact", ...PLUGIN_CATALOG];

describe("the bare /dash reaches the orchestrator skill", () => {
  test("the local registry has surrendered the name", () => {
    // Widened to `string` deliberately: `LocalCommandName` no longer contains
    // "dash", so a narrow comparison is a type error rather than an assertion.
    // That is the registry's own drift protection working — and this stays a
    // runtime check so the fact survives any future widening of the union.
    const names: readonly string[] = LOCAL_SLASH_COMMANDS.map((c) => c.name);
    expect(names).not.toContain("dash");
    expect(matchLocalSlashCommand("/dash fix the thing")).toBeNull();
    expect(matchLocalSlashCommand("/dash")).toBeNull();
  });

  test("the dash-family verbs it was an alias for are untouched", () => {
    for (const name of ["dash-bind", "dash-join"]) {
      expect(LOCAL_SLASH_COMMANDS.some((c) => c.name === name)).toBe(true);
    }
    // The `join` retired spelling stays: nothing in the catalog reclaims it.
    expect(
      LOCAL_SLASH_COMMANDS.find((c) => c.name === "join")?.deprecatedFor,
    ).toBe("dash-join");
  });

  test("it falls through the classifier as a pass-through", () => {
    expect(isHiddenSlashCommand("dash")).toBe(false);
    expect(classifySlashCommand("dash")).toBe("pass-through");
  });

  test("it resolves to tugplug:dash by unique namespace suffix", () => {
    expect(resolveRemoteCommand("dash", CATALOG)).toBe("tugplug:dash");
  });

  test("so it is not a genuine unknown, and raises no alert", () => {
    expect(isUnknownRemoteCommand("dash", CATALOG)).toBe(false);
  });

  test("and the wire carries the qualified form", () => {
    expect(canonicalizeBareCommandLine("/dash fix the thing", CATALOG)).toBe(
      "/tugplug:dash fix the thing",
    );
    expect(canonicalizeBareCommandLine("/dash", CATALOG)).toBe("/tugplug:dash");
  });

  test("a second dash-leaf entry would break the resolution, not hide it", () => {
    // The failure mode worth knowing: an ambiguous leaf resolves to null, which
    // the submit path reports as an unknown command. If some other plugin ever
    // ships a `dash` skill, this is the test that says so.
    const ambiguous = [...CATALOG, "other:dash"];
    expect(resolveRemoteCommand("dash", ambiguous)).toBeNull();
    expect(isUnknownRemoteCommand("dash", ambiguous)).toBe(true);
  });
});
