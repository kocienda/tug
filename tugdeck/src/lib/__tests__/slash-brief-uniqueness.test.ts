/**
 * slash-brief-uniqueness.test.ts — the bare `/brief` belongs to the
 * `tugplug:brief` skill, and stays there only while nothing else claims the
 * name.
 *
 * Claude has a `/brief` of its own: a TUI-only toggle for brief-only mode,
 * absent from the headless catalog. That is the case for hiding every TUI-only
 * name, and it is the one name where hiding would be wrong — a hidden name is
 * intercepted before the catalog is consulted, so `/brief` would show *not
 * available* and the brief skill's bare form would stop working. What keeps
 * the bare form working is that the name is in no explicit tier and that
 * exactly one catalog entry has `brief` as its leaf, so each is pinned here in
 * the order `performSubmit` runs them.
 *
 * The catalog is the shipped `capabilities/LATEST` capture rather than a list
 * written for the test, so a capture that brings a second `brief` leaf — an
 * account skill, a plugin, claude listing its own toggle headless — is the
 * moment this goes red.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
const CATALOG = (readFileSync(
  join(CAPABILITIES_ROOT, latestVersion, "system-metadata.jsonl"),
  "utf-8",
)
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Record<string, unknown>)
  .find((record) => Array.isArray(record.slash_commands))?.slash_commands ??
  []) as string[];

describe(`the bare /brief reaches tugplug:brief on claude ${latestVersion}`, () => {
  test("it is no local command", () => {
    const names: readonly string[] = LOCAL_SLASH_COMMANDS.map((c) => c.name);
    expect(names).not.toContain("brief");
    expect(matchLocalSlashCommand("/brief this")).toBeNull();
  });

  test("it is neither hidden nor unlisted", () => {
    expect(isHiddenSlashCommand("brief")).toBe(false);
    expect(classifySlashCommand("brief")).toBe("pass-through");
    expect(isUnlistedSlashCommand("tugplug:brief")).toBe(false);
  });

  test("exactly one catalog entry has the leaf", () => {
    const hits = CATALOG.filter(
      (entry) => entry.slice(entry.lastIndexOf(":") + 1) === "brief",
    );
    expect(hits).toEqual(["tugplug:brief"]);
  });

  test("so it resolves, raises no alert, and the wire carries the qualified form", () => {
    expect(resolveRemoteCommand("brief", CATALOG)).toBe("tugplug:brief");
    expect(isUnknownRemoteCommand("brief", CATALOG)).toBe(false);
    expect(canonicalizeBareCommandLine("/brief this", CATALOG)).toBe(
      "/tugplug:brief this",
    );
  });
});
