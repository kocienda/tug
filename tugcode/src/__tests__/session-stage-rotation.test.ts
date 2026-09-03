/**
 * session-stage-rotation.test.ts — a fresh session started by the arc
 * announces itself as a stage; one started by the user does not.
 *
 * A stage rotation is an ordinary `session_command { command: "new" }` with a
 * `stage` field on it. Two things follow from that field and nothing else
 * does: the fresh session is announced as lineage before its synthetic
 * `session_init` — the placement the rewind-fork announcement already occupies,
 * because the bridge must stage the identity transfer before the `session_init`
 * that consumes it — and every spawn the session makes from then on carries
 * `TUG_ARC`, which is what lets the stage's skills read which arc they are
 * running under.
 *
 * The no-stage path is the one that must not move: a plain `/new` from the deck
 * emits exactly what it emitted before, and it *clears* the arc, because the
 * variable belongs to an arc rather than to a card.
 *
 * Only the two spawn primitives are stubbed (`Bun.which` to locate claude,
 * `Bun.spawn` to launch it) plus stdout capture — the handler runs for real,
 * which is the only way the environment assertions mean anything.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../session.ts";
import { drainPendingWrites } from "../ipc.ts";
import type { SessionStageSpec } from "../types.ts";

const SID = "44444444-4444-4444-4444-444444444444";
const FAKE_CLAUDE = "/usr/local/bin/claude-under-test";

const realWhich = Bun.which;
const realSpawn = Bun.spawn;
const realWrite = Bun.write;

/** The environment each `Bun.spawn` was handed, in launch order. */
let spawnEnvs: Array<Record<string, string | undefined>> = [];
/** The argv each `Bun.spawn` was handed, in launch order. */
let spawnArgs: string[][] = [];
/** Every JSON line written to stdout since the last reset, in write order. */
let emitted: any[] = [];

function fakeProcess(): unknown {
  return {
    stdin: { write: () => {}, flush: () => {}, end: () => {} },
    stdout: null,
    exited: Promise.resolve(0),
    kill: () => {},
    pid: 4343,
  };
}

beforeEach(() => {
  spawnEnvs = [];
  spawnArgs = [];
  emitted = [];
  (Bun as unknown as { which: unknown }).which = (cmd: string) =>
    cmd === "claude" ? FAKE_CLAUDE : null;
  (Bun as unknown as { spawn: unknown }).spawn = (
    cmd: string[],
    opts?: { env?: Record<string, string | undefined> },
  ) => {
    spawnEnvs.push(opts?.env ?? {});
    spawnArgs.push(cmd);
    return fakeProcess();
  };
  const decoder = new TextDecoder();
  (Bun as any).write = (dest: unknown, data: unknown) => {
    if (dest === Bun.stdout) {
      const text =
        typeof data === "string"
          ? data
          : data instanceof Uint8Array
            ? decoder.decode(data)
            : "";
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          emitted.push(JSON.parse(trimmed));
        } catch {
          // non-JSON lines are not IPC
        }
      }
    }
    return Promise.resolve(0);
  };
});

afterEach(() => {
  (Bun as unknown as { which: unknown }).which = realWhich;
  (Bun as unknown as { spawn: unknown }).spawn = realSpawn;
  (Bun as any).write = realWrite;
});

function manager(): any {
  const m = new SessionManager(
    "/tmp/tugcode-stage-rotation-" + SID,
    SID,
    "new",
    undefined,
    { sessionsDbPath: null },
  ) as any;
  m.claudeCodeVersion = "2.1.195";
  m.startStdoutDrain = () => {};
  m.claudeProcess = fakeProcess();
  return m;
}

/**
 * Run a session command and wait for its emissions to reach stdout.
 *
 * `writeLine` is fire-and-forget through a serialized promise tail, so a
 * command's frames are queued rather than written by the time it resolves;
 * `drainPendingWrites` is the flush point the writer documents for exactly
 * this. Without it a test reads whichever frames a stray microtask happened to
 * flush, which is a test that passes and fails for reasons unrelated to the
 * code.
 */
async function rotate(
  m: any,
  command: "fork" | "continue" | "new",
  stage?: SessionStageSpec,
): Promise<void> {
  await m.handleSessionCommand(command, stage);
  await drainPendingWrites();
}

const STAGE: SessionStageSpec = {
  name: "devise",
  document: ".tug/arcs/some/brief.md",
  arc: "some-arc",
};

describe("a stage rotation announces lineage", () => {
  test("the stage line precedes the synthetic session_init", async () => {
    const m = manager();
    const parent = m.resolveClaudeId();

    await rotate(m, "new", STAGE);

    const types = emitted.map((e) => e?.type);
    const stageAt = types.indexOf("session_segment");
    const initAt = types.indexOf("session_init");
    expect(stageAt).toBeGreaterThanOrEqual(0);
    expect(initAt).toBeGreaterThanOrEqual(0);
    expect(stageAt).toBeLessThan(initAt);

    const line = emitted[stageAt];
    expect(line.kind).toBe("rotation");
    expect(line.parentSessionId).toBe(parent);
    expect(line.newSessionId).toBe(m.sessionId);
    expect(line.stage).toBe("devise");
    expect(line.document).toBe(".tug/arcs/some/brief.md");
    expect(line.arc).toBe("some-arc");
    expect(line.ipc_version).toBe(2);
    // The stage's fresh id is genuinely fresh, not the parent's.
    expect(line.newSessionId).not.toBe(line.parentSessionId);
  });

  test("the announced model is the selector the rotation set, empty for the account default", async () => {
    const withModel = manager();
    withModel.handleModelChange("sonnet");
    await rotate(withModel, "new", STAGE);
    expect(emitted.find((e) => e?.type === "session_segment").model).toBe("sonnet");

    emitted = [];
    const withoutModel = manager();
    await rotate(withoutModel, "new", STAGE);
    expect(emitted.find((e) => e?.type === "session_segment").model).toBe("");
  });

  test("the stage line echoes the opening prompt the command carried", async () => {
    const m = manager();
    await rotate(m, "new", { ...STAGE, prompt: "/tugplug:arc-devise .tug/arcs/some/brief.md" });
    expect(emitted.find((e) => e?.type === "session_segment").prompt).toBe(
      "/tugplug:arc-devise .tug/arcs/some/brief.md",
    );

    emitted = [];
    const bare = manager();
    await rotate(bare, "new", STAGE);
    expect(emitted.find((e) => e?.type === "session_segment")).not.toHaveProperty(
      "prompt",
    );
  });

  test("the stage's spawn carries the arc name", async () => {
    const m = manager();
    await rotate(m, "new", STAGE);
    expect(spawnEnvs.at(-1)?.TUG_ARC).toBe("some-arc");
  });

  // The outbound announcement — which tugcast turns into the `arc-stage`
  // line — names the arc from the resolved field, so the record and the
  // spawn environment can never disagree about which arc is driving.
  test("the announcement names the same arc the spawn carries", async () => {
    const m = manager();
    await rotate(m, "new", STAGE);
    expect(m.currentArc).toBe("some-arc");
    expect(emitted.find((e) => e?.type === "session_segment").arc).toBe("some-arc");
  });

  test("the arc survives a later respawn tugcode makes for its own reasons", async () => {
    // The variable must outlive the spawn that introduced it, exactly as the
    // model selection does — a respawn for an `--effort` change has never seen
    // the rotation that set it.
    const m = manager();
    await rotate(m, "new", STAGE);
    const before = spawnEnvs.length;
    m.spawnClaude(m.sessionId, "resume");
    expect(spawnEnvs.length).toBe(before + 1);
    expect(spawnEnvs.at(-1)?.TUG_ARC).toBe("some-arc");
  });
});

describe("a rotation with no arc behind it", () => {
  test("the stage line carries the label and omits what the rotation never named", async () => {
    const m = manager();
    m.handleModelChange("opus");
    await rotate(m, "new", { name: "review" });

    const line = emitted.find((e) => e?.type === "session_segment");
    expect(line.kind).toBe("rotation");
    expect(line.stage).toBe("review");
    expect(line.model).toBe("opus");
    expect(line).not.toHaveProperty("document");
    expect(line).not.toHaveProperty("arc");
    expect(line).not.toHaveProperty("steps");

    const types = emitted.map((e) => e?.type);
    expect(types.indexOf("session_segment")).toBeLessThan(types.indexOf("session_init"));
  });

  test("its spawn carries no TUG_ARC, and one on an arc does", async () => {
    // Absence is what clears it: the stage skills read `TUG_ARC` as "an arc is
    // driving you", and a rotation nothing is pacing must not make them
    // believe one is.
    const arcless = manager();
    await rotate(arcless, "new", { name: "review" });
    expect(spawnEnvs.at(-1)).not.toHaveProperty("TUG_ARC");
    expect(arcless.currentArc).toBeNull();

    const onArc = manager();
    await rotate(onArc, "new", STAGE);
    expect(spawnEnvs.at(-1)?.TUG_ARC).toBe("some-arc");
  });

  test("a stage naming an effort spawns once, with the level applied", async () => {
    // Recording the level *before* the spawn is what keeps it to one claude:
    // setting it afterwards would respawn through `handleEffortChange`, which
    // is a fresh session the rotation never asked for.
    const m = manager();
    const before = spawnEnvs.length;
    await rotate(m, "new", { name: "review", effort: "high" });
    expect(spawnEnvs.length).toBe(before + 1);
    expect(m.currentEffort).toBe("high");
  });

  test("a stage naming no effort leaves the level as it is", async () => {
    const m = manager();
    m.currentEffort = "medium";
    await rotate(m, "new", { name: "review" });
    expect(m.currentEffort).toBe("medium");
  });
});

describe("a prompt dispatched behind the rotation", () => {
  test("lands on the fresh session, never on the one being retired", async () => {
    // The arc sends `session_command new` and the stage's prompt back to
    // back, and the dispatch loop awaits neither. The retirement of the old
    // claude takes real time (stdin EOF, then its exit), and the prompt must
    // wait for the session that replaces it.
    const written: Array<{ pid: number; text: string }> = [];
    let nextPid = 100;
    const slowProcess = (): any => {
      const pid = nextPid++;
      let exit: () => void = () => {};
      const exited = new Promise<number>((resolve) => {
        exit = () => resolve(0);
      });
      return {
        pid,
        stdin: {
          write: (text: string) => written.push({ pid, text }),
          flush: () => {},
          end: () => setTimeout(exit, 20),
        },
        stdout: null,
        exited,
        kill: () => exit(),
      };
    };
    (Bun as unknown as { spawn: unknown }).spawn = () => slowProcess();
    const m = manager();
    const retiring = slowProcess();
    m.claudeProcess = retiring;

    const rotation: Promise<void> = m.handleSessionCommand("new", STAGE);
    const prompt: Promise<void> = m.handleUserMessage({
      type: "user_message",
      content: [{ type: "text", text: "/tugplug:arc-devise .tug/arcs/some/brief.md" }],
    });
    await rotation;
    // The prompt's handler then waits on a turn no fake claude will end;
    // the write is what this test is about.
    await Promise.race([prompt, new Promise((resolve) => setTimeout(resolve, 50))]);
    await drainPendingWrites();

    const fresh = m.claudeProcess;
    expect(fresh.pid).not.toBe(retiring.pid);
    expect(written.map((w) => w.pid)).toEqual([fresh.pid]);
    expect(written[0]?.text).toContain("/tugplug:arc-devise");
    expect(emitted.some((e) => e?.type === "error")).toBe(false);
  });
});

describe("a session with no stage announces itself as a new line", () => {
  test("the segment is `new` and carries none of the divider's facts", async () => {
    const m = manager();
    await rotate(m, "new");
    const line = emitted.find((e) => e?.type === "session_segment");
    // A plain `/new` is the one gesture that means "a different
    // conversation", so it is the one kind that births a line ([P03]).
    expect(line.kind).toBe("new");
    expect(line).not.toHaveProperty("stage");
    expect(line).not.toHaveProperty("model");
    expect(emitted.some((e) => e?.type === "session_init")).toBe(true);
  });

  test("its spawn carries no TUG_ARC", async () => {
    const m = manager();
    await rotate(m, "new");
    expect(spawnEnvs.at(-1)).not.toHaveProperty("TUG_ARC");
  });

  test("a plain new after an arc clears it — the variable is per-arc, not per-card", async () => {
    const m = manager();
    await rotate(m, "new", STAGE);
    expect(spawnEnvs.at(-1)?.TUG_ARC).toBe("some-arc");

    await rotate(m, "new");
    expect(spawnEnvs.at(-1)).not.toHaveProperty("TUG_ARC");
    expect(m.currentArc).toBeNull();
  });

  test("fork and continue never carry a stage", async () => {
    // Only `new` mints a fresh session, so only `new` can be a rotation.
    const m = manager();
    await rotate(m, "fork", STAGE);
    await rotate(m, "continue", STAGE);
    expect(
      emitted.some((e) => e?.type === "session_segment" && e.kind === "rotation"),
    ).toBe(false);
  });

  test("a rotation respawns with --session-id, never --resume", async () => {
    // A rotation mints an id claude has never written a JSONL for, so a later
    // effort respawn must re-create it rather than resume it. `--resume` on an
    // id with no transcript is fatal: claude answers "No conversation found",
    // the process dies, and the next submit surfaces as a stream that ended
    // unexpectedly. This is why `newSession` leaves the mode `new` and resets
    // `claudeReceivedInput` ([P05]).
    const m = manager();
    await rotate(m, "new", STAGE);
    const fresh = m.sessionId;

    spawnArgs = [];
    await m.handleEffortChange("high");
    const args = spawnArgs.at(-1) ?? [];
    expect(args).toContain("--session-id");
    expect(args).not.toContain("--resume");
    expect(args[args.indexOf("--session-id") + 1]).toBe(fresh);
  });

  test("a rewind-fork respawns with --resume — its JSONL exists", async () => {
    // The other side of the same rule. A `--continue` names no id at all, so
    // the mode is all there is to read; the transcript is on disk, so resuming
    // it is correct.
    const m = manager();
    await rotate(m, "continue");
    spawnArgs = [];
    await m.handleEffortChange("high");
    expect(spawnArgs.at(-1) ?? []).toContain("--resume");
  });
});
