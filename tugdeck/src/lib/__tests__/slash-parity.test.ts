/**
 * slash-parity.test.ts — every claude built-in in the `capabilities/LATEST`
 * capture is classified, exactly once.
 *
 * The classification layered on claude's catalog — which commands are local
 * surfaces, which are hidden, which pass through — is kept by hand, and
 * nothing used to notice when a capture brought a name nobody had classified:
 * it simply passed through, unprobed, until somebody happened to look. This
 * test is what notices. It reads the shipped capture and requires every
 * built-in name to be exactly one of local ({@link LOCAL_SLASH_COMMANDS}),
 * hidden ({@link HIDDEN_SLASH_COMMANDS}), or an acknowledged pass-through
 * ({@link ACKNOWLEDGED_PASS_THROUGH_SLASH_COMMANDS}), so a new claude command
 * turns the capture red at the moment it lands.
 *
 * Built-ins are the names in `slash_commands` that the frame's `skills` array
 * does not also carry. The skill half varies with the capturing account and
 * passes through by construction, so it is exempt.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LOCAL_SLASH_COMMANDS } from "@/lib/slash-commands";
import {
  ACKNOWLEDGED_PASS_THROUGH_SLASH_COMMANDS,
  HIDDEN_SLASH_COMMANDS,
} from "@/lib/slash-supported";

const CAPABILITIES_ROOT = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "capabilities",
);
const latestVersion = readFileSync(
  join(CAPABILITIES_ROOT, "LATEST"),
  "utf-8",
).trim();
const frame = readFileSync(
  join(CAPABILITIES_ROOT, latestVersion, "system-metadata.jsonl"),
  "utf-8",
)
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Record<string, unknown>)
  .find((record) => Array.isArray(record.slash_commands));

const slashCommands = (frame?.slash_commands ?? []) as string[];
const skills = new Set((frame?.skills ?? []) as string[]);
const builtIns = slashCommands.filter((name) => !skills.has(name));

const LOCAL: ReadonlySet<string> = new Set(
  LOCAL_SLASH_COMMANDS.map((cmd) => cmd.name),
);

/** The tiers a name is in, by name — the parity question in one place. */
function tiersOf(name: string): string[] {
  const tiers: string[] = [];
  if (LOCAL.has(name)) tiers.push("local");
  if (HIDDEN_SLASH_COMMANDS.has(name)) tiers.push("hidden");
  if (ACKNOWLEDGED_PASS_THROUGH_SLASH_COMMANDS.has(name)) {
    tiers.push("acknowledged");
  }
  return tiers;
}

describe(`slash-command parity with claude ${latestVersion}`, () => {
  test("the capture carries a catalog with built-ins in it", () => {
    expect(frame).toBeDefined();
    expect(builtIns.length).toBeGreaterThan(0);
  });

  test("every built-in is classified", () => {
    const unclassified = builtIns.filter((name) => tiersOf(name).length === 0);
    // A name here arrived with a capture and nobody has decided its tier: add
    // it to LOCAL_SLASH_COMMANDS, HIDDEN_SLASH_COMMANDS, or the acknowledged
    // pass-throughs, on probe evidence, and mirror the decision in
    // tuglaws/slash-commands.md.
    expect(unclassified).toEqual([]);
  });

  test("no built-in is classified twice", () => {
    const doubled = builtIns
      .map((name) => ({ name, tiers: tiersOf(name) }))
      .filter((entry) => entry.tiers.length > 1);
    expect(doubled).toEqual([]);
  });

  test("an acknowledged pass-through is in neither explicit tier", () => {
    // The set is a record of a pass-through decision, so a name in it that is
    // also local or hidden is a contradiction wherever the capture stands.
    const contradicted = [...ACKNOWLEDGED_PASS_THROUGH_SLASH_COMMANDS].filter(
      (name) => LOCAL.has(name) || HIDDEN_SLASH_COMMANDS.has(name),
    );
    expect(contradicted).toEqual([]);
  });

  test("every acknowledged pass-through is a built-in the capture still carries", () => {
    // An acknowledgement claude no longer reports is stale: the decision it
    // records is about a command that is gone.
    const catalogued = new Set(builtIns);
    const stale = [...ACKNOWLEDGED_PASS_THROUGH_SLASH_COMMANDS].filter(
      (name) => !catalogued.has(name),
    );
    expect(stale).toEqual([]);
  });
});
