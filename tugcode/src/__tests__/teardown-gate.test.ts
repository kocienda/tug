/**
 * teardown-gate — every teardown tugcode starts decides the open turn itself.
 *
 * `signalEofToActiveTurn` closes a turn that never got its result as
 * `turn_cancelled` when the turn is marked interrupted, and as `error` at site
 * `drain_eof_open_turn` otherwise — the frame the deck draws as the Protocol
 * error banner. That banner has to mean one thing: Claude died and tugcode did
 * not ask it to. So `killAndCleanup` takes the reason it was asked for and
 * marks the open turn itself, at kill time; no caller has to remember to.
 *
 * One test per caller, each over a turn that has streamed text and has no
 * result, each asserting a recovery cancel and no `error`; then the one case
 * the banner is for, an unasked death, which still raises it. A reason that
 * must never meet an open turn (effort, retraction) still cancels cleanly and
 * logs the meeting as a bug.
 *
 * The drain runs for real: the fake claude's stdout is a stream the kill
 * closes, so the EOF the assertions read is the one production reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager, ActiveTurn } from "../session.ts";
import { drainPendingWrites } from "../ipc.ts";
import { mustNotEndATurn } from "../teardown.ts";

const SID = "88888888-8888-8888-8888-888888888888";
const FAKE_CLAUDE = "/usr/local/bin/claude-under-test";

const realWhich = Bun.which;
const realSpawn = Bun.spawn;
const realWrite = Bun.write;
const realLog = console.log;

/** Every JSON line written to stdout since the last reset, in write order. */
let emitted: any[] = [];
/** Every console line since the last reset. */
let logged: string[] = [];

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
    pid: 8888,
  };
}

beforeEach(() => {
  emitted = [];
  logged = [];
  (Bun as unknown as { which: unknown }).which = (cmd: string) =>
    cmd === "claude" ? FAKE_CLAUDE : null;
  (Bun as unknown as { spawn: unknown }).spawn = () => fakeProcess();
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
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  (Bun as unknown as { which: unknown }).which = realWhich;
  (Bun as unknown as { spawn: unknown }).spawn = realSpawn;
  (Bun as any).write = realWrite;
  console.log = realLog;
});

/** A manager with a live claude and its real drain running. */
function manager(): any {
  const m = new SessionManager(
    "/tmp/tugcode-teardown-gate-" + SID,
    SID,
    "new",
    undefined,
    { sessionsDbPath: null },
  ) as any;
  m.claudeCodeVersion = "2.1.195";
  // Made-up pid: keep the group signal off the OS ("gone" signals the child).
  m.claude.signalProcessGroup = () => "gone";
  // The respawns below never ack a handshake; nothing waits on one here.
  m.awaitSpawnReady = async () => {};
  m.claudeProcess = fakeProcess();
  m.startStdoutDrain(m.claudeProcess);
  return m;
}

/** Install an open turn that has streamed some text and never got its result. */
function openTurn(m: any): ActiveTurn {
  const turn = new ActiveTurn(7, [{ type: "text", text: "hello" }] as any);
  turn.currentMessageId = "msg_open";
  m.activeTurn = turn;
  return turn;
}

/** Wait out every respawn queued on the manager, and the frames it wrote. */
async function settled(m: any): Promise<void> {
  while (m.respawnGate !== null) await m.respawnGate;
  await drainPendingWrites();
}

/** The `tugcode.teardown` lines logged since the last reset. */
function teardownLines(): string[] {
  return logged.filter((l) => l.includes("event=tugcode.teardown "));
}

const STAGE = {
  name: "audit",
  document: ".tug/arcs/teardown-gate/tasks.md",
  arc: "teardown-gate",
};

/** Each caller that may end a turn, with the reason its teardown names. */
const ENDS_A_TURN: Array<[string, string, (m: any) => Promise<void>]> = [
  ["a rotation", "rotation", (m) => m.handleSessionCommand("new", STAGE)],
  ["a /new", "new", (m) => m.handleSessionCommand("new")],
  ["a fork", "fork", (m) => m.handleSessionCommand("fork")],
  ["a continue", "continue", (m) => m.handleSessionCommand("continue")],
  ["a card close (shutdown)", "shutdown", (m) => m.shutdown({ graceMs: 10 })],
  [
    "the result watchdog",
    "force_terminate",
    (m) => m.forceTerminateAndRespawn("result_timeout"),
  ],
  ["stop-all", "stop_all", (m) => m.handleStopAllWork([])],
];

describe("a teardown over an open turn ends it as a recovery cancel", () => {
  for (const [name, reason, act] of ENDS_A_TURN) {
    test(`${name}`, async () => {
      const m = manager();
      const turn = openTurn(m);

      await act(m);
      await settled(m);

      expect(turn.interrupted).toBe(true);
      expect(turn.interruptCause).toBe("recovery");
      const cancels = emitted.filter((e) => e?.type === "turn_cancelled");
      expect(cancels).toHaveLength(1);
      expect(cancels[0].is_recovery).toBe(true);
      expect(cancels[0].msg_id).toBe("msg_open");
      expect(emitted.filter((e) => e?.type === "error")).toEqual([]);

      // One line names who asked, and that a turn was open.
      const lines = teardownLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`reason=${reason}`);
      expect(lines[0]).toContain("turn_open=true");
      expect(lines[0]).not.toContain("bug=");
    });
  }

  test("a user's cancel the watchdog had to press harder keeps its cause", async () => {
    const m = manager();
    const turn = openTurn(m);
    turn.interrupted = true;
    turn.interruptCause = "user";

    await m.forceTerminateAndRespawn("interrupt_unacked");
    await settled(m);

    expect(turn.interruptCause).toBe("user");
    const cancels = emitted.filter((e) => e?.type === "turn_cancelled");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].is_recovery).toBeUndefined();
    expect(emitted.filter((e) => e?.type === "error")).toEqual([]);
  });
});

describe("a must-not-end-a-turn teardown that meets an open turn", () => {
  test("the reasons of that kind are effort, directory, rewind and retraction", () => {
    for (const r of ["effort", "directory", "rewind", "retraction"] as const) {
      expect(mustNotEndATurn(r)).toBe(true);
    }
    for (const r of [
      "rotation",
      "new",
      "fork",
      "continue",
      "shutdown",
      "force_terminate",
      "stop_all",
      "reattach",
    ] as const) {
      expect(mustNotEndATurn(r)).toBe(false);
    }
  });

  // The callers' own guards refuse or defer these mid-turn; these tests go
  // past the guards to the teardown, which is the hole the gate answers.
  const PAST_THE_GUARD: Array<[string, string, (m: any) => Promise<void>]> = [
    ["an effort respawn", "effort", (m) => m.respawn(() => m.respawnInPlace("effort"))],
    ["a retraction", "retraction", (m) => m.rewind.host.killAndCleanup("retraction")],
  ];

  for (const [name, reason, act] of PAST_THE_GUARD) {
    test(`${name} still cancels cleanly, and logs the bug`, async () => {
      const m = manager();
      const turn = openTurn(m);

      await act(m);
      await settled(m);

      expect(turn.interruptCause).toBe("recovery");
      expect(emitted.filter((e) => e?.type === "turn_cancelled")).toHaveLength(1);
      expect(emitted.filter((e) => e?.type === "error")).toEqual([]);
      const lines = teardownLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`reason=${reason}`);
      expect(lines[0]).toContain("bug=");
    });
  }
});

describe("a teardown with no open turn", () => {
  test("touches no turn, emits neither frame, and says no turn was open", async () => {
    const m = manager();

    await m.handleSessionCommand("fork");
    await settled(m);

    expect(emitted.filter((e) => e?.type === "error")).toEqual([]);
    expect(emitted.filter((e) => e?.type === "turn_cancelled")).toEqual([]);
    const lines = teardownLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reason=fork");
    expect(lines[0]).toContain("turn_open=false");
  });

  test("a turn that already has its result is not relabelled", async () => {
    const m = manager();
    const turn = openTurn(m);
    turn.gotResult = true;

    await m.killAndCleanup("shutdown");

    expect(turn.interrupted).toBe(false);
    expect(teardownLines()[0]).toContain("turn_open=false");
  });
});

describe("the banner is still raised when Claude dies on its own", () => {
  test("an unasked EOF over an open turn emits error at drain_eof_open_turn", async () => {
    const m = manager();
    const turn = openTurn(m);

    m.claudeProcess.kill();
    await m.claude.stdoutDrainTask;
    await drainPendingWrites();

    expect(turn.interrupted).toBe(false);
    const errors = emitted.filter((e) => e?.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].site).toBe("drain_eof_open_turn");
    expect(emitted.filter((e) => e?.type === "turn_cancelled")).toEqual([]);
    expect(teardownLines()).toEqual([]);
  });
});
