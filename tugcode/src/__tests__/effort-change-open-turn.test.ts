/**
 * effort-change-open-turn — an effort change never ends a running turn.
 *
 * Effort has no live control verb: tugcode applies it by killing claude and
 * respawning it with `--effort`. The drain on the killed process observes
 * EOF, and for a turn that nobody interrupted `signalEofToActiveTurn` emits
 * `error "Claude process stream ended unexpectedly"` — the deck's "Protocol
 * error" banner, reported at `drain_eof_open_turn`.
 *
 * The deck declines the user's own effort gesture mid-turn, but its
 * mount-restore re-sent a card's remembered level with no such check, so a
 * card that mounted over a running turn (a page reload, a rebuilt body)
 * killed the turn it was showing. The guard is here, where the kill is: an
 * `effort_change` over an open turn records the level and owes the respawn,
 * which is paid when the turn closes.
 *
 * The drain runs for real: the fake claude's stdout is a stream the kill
 * closes, so an EOF the assertions would read is the one production reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager, ActiveTurn } from "../session.ts";
import { drainPendingWrites } from "../ipc.ts";

const SID = "66666666-6666-6666-6666-666666666666";
const FAKE_CLAUDE = "/usr/local/bin/claude-under-test";

const realWhich = Bun.which;
const realSpawn = Bun.spawn;
const realWrite = Bun.write;

/** Every JSON line written to stdout since the last reset, in write order. */
let emitted: any[] = [];
/** The argv of every claude spawned since the last reset. */
let spawns: string[][] = [];

/** A claude whose stdout is a live stream that `kill()` / `stdin.end()` close. */
function fakeProcess(): any {
  let close: () => void = () => {};
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
    },
  });
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((res) => {
    resolveExit = res;
  });
  const die = () => {
    close();
    resolveExit(0);
  };
  return {
    stdin: { write: () => {}, flush: () => {}, end: () => die() },
    stdout,
    exited,
    kill: () => die(),
    pid: 6666,
  };
}

beforeEach(() => {
  emitted = [];
  spawns = [];
  (Bun as unknown as { which: unknown }).which = (cmd: string) =>
    cmd === "claude" ? FAKE_CLAUDE : null;
  (Bun as unknown as { spawn: unknown }).spawn = (argv: string[]) => {
    spawns.push(argv);
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

/** A manager with a live claude and its real drain running. */
function manager(): any {
  const m = new SessionManager(
    "/tmp/tugcode-effort-open-turn-" + SID,
    SID,
    "new",
    undefined,
    { sessionsDbPath: null },
  ) as any;
  m.claudeCodeVersion = "2.1.195";
  // Made-up pid: keep the group signal off the OS ("gone" signals the child).
  m.claude.signalProcessGroup = () => "gone";
  m.claudeProcess = fakeProcess();
  m.startStdoutDrain(m.claudeProcess);
  return m;
}

/** Install an open turn that has streamed some text and never got its result. */
function openTurn(m: any): ActiveTurn {
  const turn = new ActiveTurn(7, [{ type: "text", text: "hello" }] as any);
  turn.currentMessageId = "msg_abc";
  m.activeTurn = turn;
  return turn;
}

/** Wait out every respawn queued on the manager. */
async function respawnsSettled(m: any): Promise<void> {
  while (m.respawnGate !== null) await m.respawnGate;
  await drainPendingWrites();
}

function effortOf(argv: string[]): string | null {
  const at = argv.indexOf("--effort");
  return at === -1 ? null : (argv[at + 1] ?? null);
}

describe("an effort change over an open turn", () => {
  test("leaves the turn and its claude alone, and raises no banner", async () => {
    const m = manager();
    const turn = openTurn(m);
    const live = m.claudeProcess;

    await m.handleEffortChange("medium");
    await respawnsSettled(m);

    expect(spawns).toEqual([]);
    expect(m.claudeProcess).toBe(live);
    expect(m.activeTurn).toBe(turn);
    expect(turn.interrupted).toBe(false);
    expect(emitted.filter((e) => e?.type === "error")).toEqual([]);
    expect(emitted.filter((e) => e?.type === "turn_cancelled")).toEqual([]);
    // The level is not lost: it is recorded, and the respawn is owed.
    expect(m.currentEffort).toBe("medium");
    expect(m.effortRespawnPending).toBe(true);
  });

  test("is applied by one respawn when the turn closes", async () => {
    const m = manager();
    openTurn(m);
    await m.handleEffortChange("medium");

    // The drain's `result`-bounded close: slot cleared, then the hook.
    m.activeTurn = null;
    m.applyDeferredEffort();
    await respawnsSettled(m);

    expect(spawns).toHaveLength(1);
    expect(effortOf(spawns[0])).toBe("medium");
    expect(m.effortRespawnPending).toBe(false);
    expect(emitted.filter((e) => e?.type === "error")).toEqual([]);

    // Paid once: a later turn close owes nothing.
    m.applyDeferredEffort();
    await respawnsSettled(m);
    expect(spawns).toHaveLength(1);
  });

  test("waits out a follow-on turn claude has already been handed", async () => {
    const m = manager();
    openTurn(m);
    await m.handleEffortChange("medium");

    m.activeTurn = null;
    m.pendingTurnInputs.set(crypto.randomUUID(), {
      content: [{ type: "text", text: "and then" }],
      submissionId: null,
    });
    m.applyDeferredEffort();
    await respawnsSettled(m);

    // Respawning now would drop the message claude is about to run.
    expect(spawns).toEqual([]);
    expect(m.effortRespawnPending).toBe(true);

    m.pendingTurnInputs.clear();
    m.applyDeferredEffort();
    await respawnsSettled(m);
    expect(spawns).toHaveLength(1);
    expect(effortOf(spawns[0])).toBe("medium");
  });

  test("the last level asked for mid-turn is the one applied", async () => {
    const m = manager();
    openTurn(m);
    await m.handleEffortChange("medium");
    await m.handleEffortChange("low");

    m.activeTurn = null;
    m.applyDeferredEffort();
    await respawnsSettled(m);

    expect(spawns).toHaveLength(1);
    expect(effortOf(spawns[0])).toBe("low");
  });

  test("another respawn that carries the level settles the debt", async () => {
    const m = manager();
    openTurn(m);
    await m.handleEffortChange("medium");

    // A rotation retires the claude; the fresh one is spawned with the level.
    await m.handleSessionCommand("new");
    await respawnsSettled(m);
    expect(spawns).toHaveLength(1);
    expect(effortOf(spawns[0])).toBe("medium");
    expect(m.effortRespawnPending).toBe(false);

    m.applyDeferredEffort();
    await respawnsSettled(m);
    expect(spawns).toHaveLength(1);
  });
});

describe("an effort change between turns", () => {
  test("respawns at once, as it always has", async () => {
    const m = manager();

    await m.handleEffortChange("medium");
    await respawnsSettled(m);

    expect(spawns).toHaveLength(1);
    expect(effortOf(spawns[0])).toBe("medium");
    expect(m.effortRespawnPending).toBe(false);
    expect(emitted.filter((e) => e?.type === "error")).toEqual([]);
  });
});
