/**
 * slash-arc-reclamation.test.ts — the bare `/arc` belongs to the `tugplug:arc`
 * door skill, and gets there through the ordinary three-tier classifier rather
 * than through any special case.
 *
 * The name was once a locally-registered retired spelling, so a typed bare door
 * name never reached Claude at all. Surrendering the name only works because
 * every hop after the local miss resolves: not hidden, not unknown, and
 * canonicalized to the qualified form on the wire. Each hop is pinned here, in
 * the order `performSubmit` runs them.
 *
 * The popup is the other half, and it is a separate question from the wire: the
 * two doors are offered and the four stage skills are not, because a stage
 * refuses to run outside an arc and is therefore not vocabulary anyone speaks.
 * Unlisted changes nothing above — a stage skill typed anyway still passes
 * through and still resolves.
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
  isUnlistedSlashCommand,
  resolveRemoteCommand,
} from "@/lib/slash-supported";

/**
 * The plugin's qualified skill names, as `enumeratePluginCommands` emits them
 * — one entry per directory under `tugplug/skills/`. Written literally so the
 * resolution below is proved against the real leaf set rather than against a
 * catalog shaped to make it pass: what makes `arc` resolve is that **no other
 * entry shares its leaf**, and that is only true of the real list.
 */
const PLUGIN_CATALOG = [
  "tugplug:arc",
  "tugplug:arc-implement",
  "tugplug:arc-plan",
  "tugplug:draft",
  "tugplug:arc-devise",
  "tugplug:arc-review",
  "tugplug:arc-audit",
  "tugplug:tripwire",
] as const;

/** The catalog as a card sees it: claude's own commands plus the plugin's. */
const CATALOG = ["init", "insights", "recap", "compact", ...PLUGIN_CATALOG];

describe("the bare /arc reaches the door skill", () => {
  test("the local registry has surrendered the name", () => {
    // Widened to `string` deliberately: `LocalCommandName` does not contain
    // "arc", so a narrow comparison is a type error rather than an assertion.
    // That is the registry's own drift protection working — and this stays a
    // runtime check so the fact survives any future widening of the union.
    const names: readonly string[] = LOCAL_SLASH_COMMANDS.map((c) => c.name);
    expect(names).not.toContain("arc");
    expect(matchLocalSlashCommand("/arc fix the thing")).toBeNull();
    expect(matchLocalSlashCommand("/arc")).toBeNull();
  });

  test("the arc-family verbs it sits beside are untouched", () => {
    for (const name of ["arc-bind", "arc-join"]) {
      expect(LOCAL_SLASH_COMMANDS.some((c) => c.name === name)).toBe(true);
    }
  });

  test("it falls through the classifier as a pass-through", () => {
    expect(isHiddenSlashCommand("arc")).toBe(false);
    expect(classifySlashCommand("arc")).toBe("pass-through");
  });

  test("it resolves to tugplug:arc by unique namespace suffix", () => {
    expect(resolveRemoteCommand("arc", CATALOG)).toBe("tugplug:arc");
  });

  test("so it is not a genuine unknown, and raises no alert", () => {
    expect(isUnknownRemoteCommand("arc", CATALOG)).toBe(false);
  });

  test("and the wire carries the qualified form", () => {
    expect(canonicalizeBareCommandLine("/arc fix the thing", CATALOG)).toBe(
      "/tugplug:arc fix the thing",
    );
    expect(canonicalizeBareCommandLine("/arc", CATALOG)).toBe("/tugplug:arc");
  });

  test("the other door resolves on the same terms", () => {
    expect(resolveRemoteCommand("arc-plan", CATALOG)).toBe("tugplug:arc-plan");
    expect(isUnknownRemoteCommand("arc-plan", CATALOG)).toBe(false);
    expect(canonicalizeBareCommandLine("/arc-plan", CATALOG)).toBe(
      "/tugplug:arc-plan",
    );
  });

  test("a second arc-leaf entry would break the resolution, not hide it", () => {
    // The failure mode worth knowing: an ambiguous leaf resolves to null, which
    // the submit path reports as an unknown command. If some other plugin ever
    // ships an `arc` skill, this is the test that says so.
    const ambiguous = [...CATALOG, "other:arc"];
    expect(resolveRemoteCommand("arc", ambiguous)).toBeNull();
    expect(isUnknownRemoteCommand("arc", ambiguous)).toBe(true);
  });
});

describe("the popup offers the doors and not the stages", () => {
  test("both doors survive the completion filter", () => {
    for (const name of ["tugplug:arc", "tugplug:arc-plan"]) {
      expect(isUnlistedSlashCommand(name)).toBe(false);
      expect(isHiddenSlashCommand(name)).toBe(false);
    }
  });

  test("every stage skill in the real catalog is unlisted", () => {
    const stages = PLUGIN_CATALOG.filter((n) =>
      ["arc-devise", "arc-review", "arc-implement", "arc-audit"].includes(
        n.slice(n.indexOf(":") + 1),
      ),
    );
    expect(stages.length).toBe(4);
    for (const name of stages) {
      expect(isUnlistedSlashCommand(name)).toBe(true);
    }
  });

  test("the local /arc-review card verb is untouched by the tier", () => {
    // It shares a leaf with a stage skill and is a door the user does speak.
    expect(LOCAL_SLASH_COMMANDS.some((c) => c.name === "arc-review")).toBe(true);
    expect(classifySlashCommand("arc-review")).toBe("supported-local");
    expect(isUnlistedSlashCommand("arc-review")).toBe(false);
  });

  test("unlisting a stage does not change what typing it does", () => {
    expect(classifySlashCommand("arc-devise")).toBe("pass-through");
    expect(isUnknownRemoteCommand("arc-devise", CATALOG)).toBe(false);
    expect(canonicalizeBareCommandLine("/arc-devise", CATALOG)).toBe(
      "/tugplug:arc-devise",
    );
  });
});
