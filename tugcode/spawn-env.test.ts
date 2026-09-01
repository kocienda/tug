import { describe, expect, test } from "bun:test";
import { buildClaudeSpawnEnv } from "./src/session.ts";

// The environment a claude spawn runs under is the chain that lets a skill or
// CLI running inside a Session card self-identify: tugcode → claude → Bash
// tool call → `$TUG_SESSION_ID`. The design *assumed* a Wheel rotation always
// meant a fresh tugcode process, which would have made passing the variable
// through unchanged correct. It does not: `newSession` mints a fresh session
// id and respawns only claude, inside the same tugcode. These tests are that
// assumption, replaced by an assertion.

describe("buildClaudeSpawnEnv", () => {
  test("stamps TUG_SESSION_ID from the manager's id, not the inherited one", () => {
    const env = buildClaudeSpawnEnv(
      { TUG_SESSION_ID: "seg-spawned-with", PATH: "/usr/bin" },
      "seg-rotated-to",
      null,
    );
    expect(env.TUG_SESSION_ID).toBe("seg-rotated-to");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("a card that has rotated twice carries the newest id, not the first", () => {
    const born = { TUG_SESSION_ID: "seg-1" };
    expect(buildClaudeSpawnEnv(born, "seg-2", null).TUG_SESSION_ID).toBe("seg-2");
    expect(buildClaudeSpawnEnv(born, "seg-3", null).TUG_SESSION_ID).toBe("seg-3");
    expect(born.TUG_SESSION_ID).toBe(
      "seg-1",
      // The process environment is read, never mutated — tugcode's own id is
      // not the card's, and rewriting it would confuse anything else in the
      // process that reads it.
    );
  });

  test("sets the id even when tugcast exported none", () => {
    const env = buildClaudeSpawnEnv({ PATH: "/usr/bin" }, "seg-1", null);
    expect(env.TUG_SESSION_ID).toBe("seg-1");
  });

  test("scrubs the three auth keys and keeps everything else", () => {
    const env = buildClaudeSpawnEnv(
      {
        ANTHROPIC_API_KEY: "k",
        ANTHROPIC_AUTH_TOKEN: "t",
        CLAUDE_CODE_OAUTH_TOKEN: "o",
        HOME: "/home/x",
      },
      "seg-1",
      null,
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.HOME).toBe("/home/x");
    expect(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe("true");
  });

  test("TUG_DASH_ARC is set under a course and cleared without one", () => {
    expect(buildClaudeSpawnEnv({}, "seg-1", "hardening").TUG_DASH_ARC).toBe("hardening");
    // Absent is what clears it: the variable belongs to a course, not a card,
    // so a session inheriting a stale one must not keep it.
    expect(
      buildClaudeSpawnEnv({ TUG_DASH_ARC: "stale" }, "seg-1", null).TUG_DASH_ARC,
    ).toBeUndefined();
  });
});
