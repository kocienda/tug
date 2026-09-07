/**
 * slash-supported.test.ts — pure-logic coverage for the [D14] three-tier
 * slash-command allowlist ([#step-13a]).
 */

import { describe, expect, test } from "bun:test";
import {
  HIDDEN_SLASH_COMMANDS,
  UNLISTED_SLASH_COMMANDS,
  classifySlashCommand,
  isHiddenSlashCommand,
  isUnlistedSlashCommand,
  isUnknownRemoteCommand,
  resolveRemoteCommand,
  canonicalizeBareCommandLine,
} from "@/lib/slash-supported";
import { LOCAL_SLASH_COMMANDS } from "@/lib/slash-commands";

describe("classifySlashCommand", () => {
  test("a registered local command is supported-local", () => {
    for (const cmd of LOCAL_SLASH_COMMANDS) {
      expect(classifySlashCommand(cmd.name)).toBe("supported-local");
    }
  });

  test("`/unname` is typeable, takes no argument, and says what it does", () => {
    // The clearing path existed only behind the rename dialog; a verb is what
    // makes it reachable by typing.
    const unname: { description: string; takesArgs?: boolean } | undefined =
      LOCAL_SLASH_COMMANDS.find((c) => c.name === "unname");
    expect(unname).toBeDefined();
    expect(unname?.takesArgs).toBeUndefined();
    expect(unname?.description.length).toBeGreaterThan(0);
  });

  test("a known-unsupported command is hidden", () => {
    for (const name of ["vim", "theme", "color", "mcp", "bug", "quit", "status"]) {
      expect(classifySlashCommand(name)).toBe("hidden");
    }
  });

  test("a genuine pass-through is pass-through", () => {
    // prompt-type + backend-effecting locals that run a real turn verbatim.
    for (const name of ["init", "insights", "recap"]) {
      expect(classifySlashCommand(name)).toBe("pass-through");
    }
  });

  test("/shell and /btw are supported-local one-shot verbs", () => {
    // Both are ordinary local commands: `/shell` is the deliberate override
    // under the shell auto-router, `/btw` is how you ask the Z2 BTW cell a
    // side question. Neither is hidden.
    for (const name of ["shell", "btw"]) {
      expect(classifySlashCommand(name)).toBe("supported-local");
      expect(HIDDEN_SLASH_COMMANDS.has(name)).toBe(false);
    }
  });

  test("find and history are not slash commands", () => {
    // Find's one door is ⌘F, and the History shade's is ⌃⌘H — neither is
    // reachable by typing, so both resolve as plain pass-throughs.
    for (const name of ["find", "history"]) {
      expect(classifySlashCommand(name)).toBe("pass-through");
      expect(HIDDEN_SLASH_COMMANDS.has(name)).toBe(false);
    }
  });

  test("/tasks and /bashes are supported-local (the TASKS and JOBS popovers)", () => {
    for (const name of ["tasks", "bashes"]) {
      expect(classifySlashCommand(name)).toBe("supported-local");
      expect(HIDDEN_SLASH_COMMANDS.has(name)).toBe(false);
    }
  });

  test("/goal and /loop are pass-throughs (probe-verified on 2.1.204)", () => {
    // Graduated out of the hidden set: a goal runs as one long result
    // cycle, a loop paces via ScheduleWakeup/CronCreate wakes — both work
    // end-to-end over the bridge (tugcode/probes/goal-loop/FINDINGS.md).
    for (const name of ["goal", "loop"]) {
      expect(classifySlashCommand(name)).toBe("pass-through");
      expect(HIDDEN_SLASH_COMMANDS.has(name)).toBe(false);
    }
  });

  test("an unknown name defaults to pass-through (never swallowed)", () => {
    for (const name of ["wibble", "tugplug:commit", "some-future-command"]) {
      expect(classifySlashCommand(name)).toBe("pass-through");
    }
  });
});

describe("isHiddenSlashCommand", () => {
  test("agrees with classifySlashCommand", () => {
    for (const name of ["vim", "permissions", "init", "wibble", "bug"]) {
      expect(isHiddenSlashCommand(name)).toBe(
        classifySlashCommand(name) === "hidden",
      );
    }
  });
});

describe("isUnlistedSlashCommand", () => {
  test("a stage skill is unlisted, namespaced or bare", () => {
    for (const name of ["arc-devise", "arc-implement", "arc-audit"]) {
      expect(isUnlistedSlashCommand(name)).toBe(true);
      expect(isUnlistedSlashCommand(`tugplug:${name}`)).toBe(true);
    }
  });

  test("a local command wearing a stage skill's leaf is not unlisted", () => {
    // `/arc-review` is a card verb *and* a stage skill's leaf. The bare name is
    // the card verb the user speaks; only the namespaced skill is unlisted.
    expect(LOCAL_SLASH_COMMANDS.some((c) => c.name === "arc-review")).toBe(true);
    expect(isUnlistedSlashCommand("arc-review")).toBe(false);
    expect(isUnlistedSlashCommand("tugplug:arc-review")).toBe(true);
  });

  test("a door, a pass-through and a hidden name are all listed", () => {
    for (const name of ["tugplug:arc", "init", "vim"]) {
      expect(isUnlistedSlashCommand(name)).toBe(false);
    }
  });

  test("unlisted is presentation only — it changes no classification", () => {
    // The whole claim of the tier: typed, a stage skill still passes through to
    // claude, and a catalog that reports it is still not a genuine unknown.
    const catalog = ["init", "tugplug:arc-devise"];
    expect(classifySlashCommand("arc-devise")).toBe("pass-through");
    expect(isUnknownRemoteCommand("arc-devise", catalog)).toBe(false);
    expect(isHiddenSlashCommand("arc-devise")).toBe(false);
  });
});

describe("set integrity", () => {
  test("no command is both supported-local and hidden", () => {
    for (const cmd of LOCAL_SLASH_COMMANDS) {
      expect(HIDDEN_SLASH_COMMANDS.has(cmd.name)).toBe(false);
    }
  });

  test("/copy is not hidden — it becomes a local command in a later sub-step", () => {
    // The audit's SKIP set lists /copy as a *command*, but the session card adds
    // it to the [D23] registry; guard against re-hiding it here.
    expect(HIDDEN_SLASH_COMMANDS.has("copy")).toBe(false);
  });

  test("no unlisted name is hidden — the two sets answer different questions", () => {
    for (const name of UNLISTED_SLASH_COMMANDS) {
      expect(HIDDEN_SLASH_COMMANDS.has(name)).toBe(false);
    }
  });
});

describe("isUnknownRemoteCommand", () => {
  const catalog = ["init", "insights", "compact", "tugplug:commit"];

  test("an empty catalog never reports unknown (handshake not landed yet)", () => {
    expect(isUnknownRemoteCommand("foo", [])).toBe(false);
    expect(isUnknownRemoteCommand("init", [])).toBe(false);
  });

  test("a pass-through name absent from a populated catalog is unknown", () => {
    expect(isUnknownRemoteCommand("foo", catalog)).toBe(true);
    expect(isUnknownRemoteCommand("looop", catalog)).toBe(true);
  });

  test("a pass-through name present in the catalog is NOT unknown (sent to claude)", () => {
    expect(isUnknownRemoteCommand("init", catalog)).toBe(false);
    expect(isUnknownRemoteCommand("tugplug:commit", catalog)).toBe(false);
  });

  test("local and hidden names are never 'unknown' (handled / swallowed first)", () => {
    // A local command is dispatched to its surface; a hidden one is
    // swallowed silently — neither should be reported as an unknown typo,
    // even if absent from the catalog.
    expect(isUnknownRemoteCommand("permissions", catalog)).toBe(false);
    expect(isUnknownRemoteCommand("vim", catalog)).toBe(false);
  });

  test("a bare skill name resolving to a namespaced catalog entry is NOT unknown", () => {
    // The crux of the skill-classification fix: claude catalogs skills
    // namespaced (`tugplug:devise`), the user types the bare `/devise`. A
    // namespace-blind check would call it an unknown typo and swallow it;
    // namespace-aware matching routes it to the skill instead.
    const skillCatalog = ["init", "tugplug:devise", "tugplug:commit"];
    expect(isUnknownRemoteCommand("devise", skillCatalog)).toBe(false);
    expect(isUnknownRemoteCommand("commit", skillCatalog)).toBe(false);
    // A real typo still reads as unknown.
    expect(isUnknownRemoteCommand("devize", skillCatalog)).toBe(true);
  });
});

describe("resolveRemoteCommand", () => {
  const catalog = ["init", "insights", "tugplug:devise", "tugplug:commit"];

  test("an exact catalog name resolves to itself (bare or fully-qualified)", () => {
    expect(resolveRemoteCommand("init", catalog)).toBe("init");
    expect(resolveRemoteCommand("tugplug:devise", catalog)).toBe("tugplug:devise");
  });

  test("a bare name resolves to its unique namespaced catalog entry", () => {
    expect(resolveRemoteCommand("devise", catalog)).toBe("tugplug:devise");
    expect(resolveRemoteCommand("commit", catalog)).toBe("tugplug:commit");
  });

  test("a name matching nothing resolves to null", () => {
    expect(resolveRemoteCommand("devize", catalog)).toBeNull();
    expect(resolveRemoteCommand("nope", catalog)).toBeNull();
  });

  test("an ambiguous suffix (same leaf in two namespaces) does NOT guess", () => {
    const ambiguous = ["tugplug:review", "acme:review"];
    expect(resolveRemoteCommand("review", ambiguous)).toBeNull();
    // The fully-qualified form is still exact and unambiguous.
    expect(resolveRemoteCommand("acme:review", ambiguous)).toBe("acme:review");
  });
});

describe("canonicalizeBareCommandLine", () => {
  const catalog = ["compact", "tugplug:commit", "tugplug:devise"];

  test("rewrites a bare leaf to its qualified form", () => {
    expect(canonicalizeBareCommandLine("/commit", catalog)).toBe(
      "/tugplug:commit",
    );
  });

  test("preserves trailing argument text", () => {
    expect(canonicalizeBareCommandLine("/devise a plan", catalog)).toBe(
      "/tugplug:devise a plan",
    );
  });

  test("leaves an already-qualified command untouched (no rewrite)", () => {
    expect(canonicalizeBareCommandLine("/tugplug:commit", catalog)).toBeNull();
  });

  test("exact catalog match wins over a shared leaf (conflict rule)", () => {
    // A real bare `commit` shadows `tugplug:commit` — typed exactly, it stays.
    expect(
      canonicalizeBareCommandLine("/commit", ["commit", "tugplug:commit"]),
    ).toBeNull();
  });

  test("returns null for an unknown / ambiguous name", () => {
    expect(canonicalizeBareCommandLine("/nope", catalog)).toBeNull();
    expect(
      canonicalizeBareCommandLine("/review", ["a:review", "b:review"]),
    ).toBeNull();
  });

  test("returns null for non-command text", () => {
    expect(canonicalizeBareCommandLine("hello world", catalog)).toBeNull();
  });
});
