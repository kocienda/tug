/**
 * effort-at-spawn — a card's effort rides its spawn, so the first claude is
 * born at it.
 *
 * Applying an effort after spawn is a respawn, and on a new card with a
 * non-default level that respawn landed over the card's first prompt. tugcast
 * now forwards the card's seed level as `--effort`; tugcode reads it, records
 * it as the session's effort before the first spawn, and passes it to claude.
 */

import { describe, expect, test } from "bun:test";
import { SessionManager } from "../session.ts";
import { parseEffortArg } from "../spawn-config.ts";
import { fakeSpawner } from "./fake-spawner.ts";

const SID = "aaaaaaaa-1111-2222-3333-444444444444";

function effortOf(argv: readonly string[]): string | null {
  const at = argv.indexOf("--effort");
  return at === -1 ? null : (argv[at + 1] ?? null);
}

/** A manager whose spawns record their argv and launch nothing real. */
function manager(initialEffort?: string): { m: any; spawns: string[][] } {
  const spawns: string[][] = [];
  const m = new SessionManager(
    "/tmp/tugcode-effort-at-spawn-" + SID,
    SID,
    "new",
    undefined,
    {
      sessionsDbPath: null,
      initialEffort,
      spawner: fakeSpawner((args) => {
        spawns.push(args);
        return { stdin: { write: () => {}, flush: () => {} } };
      }),
    },
  ) as any;
  return { m, spawns };
}

describe("--effort as tugcode reads it", () => {
  test("a level is taken as written", () => {
    expect(parseEffortArg("medium")).toBe("medium");
    expect(parseEffortArg(" low ")).toBe("low");
  });

  test("a blank level is no level", () => {
    expect(parseEffortArg("")).toBeUndefined();
    expect(parseEffortArg("  ")).toBeUndefined();
    expect(parseEffortArg(undefined)).toBeUndefined();
  });
});

describe("the first spawn", () => {
  test("carries the seed effort", () => {
    const { m, spawns } = manager("medium");

    m.spawnClaude(SID, "session-id");

    expect(spawns).toHaveLength(1);
    expect(effortOf(spawns[0])).toBe("medium");
    // The level is the session's from the start, so the handshake's
    // capabilities report it and the deck's restore finds it already in force.
    expect(m.currentEffort).toBe("medium");
  });

  test("carries no effort when the card has none", () => {
    const { m, spawns } = manager();

    m.spawnClaude(SID, "session-id");

    expect(effortOf(spawns[0])).toBeNull();
    expect(m.currentEffort).toBeNull();
  });
});

describe("an effort change to the level already in force", () => {
  test("costs no respawn", async () => {
    const { m, spawns } = manager("medium");
    m.spawnClaude(SID, "session-id");

    // The deck's restore can send its seed before the capabilities that say
    // it is in force arrive; the claude born at it is left alone.
    await m.handleEffortChange("medium");

    expect(spawns).toHaveLength(1);
    expect(m.currentEffort).toBe("medium");
  });
});
