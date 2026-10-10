import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ClaudeProcess,
  type ClaudeProcessHost,
  type ClaudeSubprocess,
} from "../claude-process.ts";
import { fakeSpawner } from "./fake-spawner.ts";

const encoder = new TextEncoder();

/** A readable stream that yields `chunks` and then closes. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** A host that records what the process reported. */
function recordingHost(): ClaudeProcessHost & { lines: string[]; ends: number } {
  const host = {
    lines: [] as string[],
    ends: 0,
    onStdoutLine(line: string) {
      host.lines.push(line);
    },
    onStdoutEnd() {
      host.ends += 1;
    },
    sessionId: () => "claude-process-test",
  };
  return host;
}

/**
 * A fake child with no pid, so the group signal reports "gone" and the
 * ladder signals the child itself — no signal ever reaches the OS.
 */
function fakeChild(opts: {
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  onEnd?: () => void;
  onKill?: (signal: string) => void;
}): ClaudeSubprocess {
  return {
    stdout: opts.stdout ?? streamOf([]),
    stderr: opts.stderr,
    stdin: { write: () => {}, flush: () => {}, end: () => opts.onEnd?.() },
    exited: opts.exited,
    kill: (signal?: string) => opts.onKill?.(signal ?? "SIGTERM"),
  } as unknown as ClaudeSubprocess;
}

describe("ClaudeProcess.launch", () => {
  test("hands the composed argv and environment to the spawner and does not seat the child", () => {
    const seen: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    const child = fakeChild({ exited: new Promise(() => {}) });
    const proc = new ClaudeProcess({
      cwd: "/tmp/claude-process-launch",
      host: recordingHost(),
      spawner: fakeSpawner((args, env) => {
        seen.push({ args, env });
        return child;
      }),
    });

    const launched = proc.launch(["--resume", "abc"], { TUG_SESSION_ID: "abc" });

    expect(launched).toBe(child);
    expect(seen).toEqual([{ args: ["--resume", "abc"], env: { TUG_SESSION_ID: "abc" } }]);
    expect(proc.child).toBeNull();
  });
});

describe("ClaudeProcess stdout drain", () => {
  test("hands each trimmed non-empty line to the host, including an unterminated last line, then reports the end", async () => {
    const host = recordingHost();
    const proc = new ClaudeProcess({ cwd: "/tmp", host, spawner: fakeSpawner(() => null) });
    let exit!: (code: number) => void;
    const child = fakeChild({
      stdout: streamOf(['{"a":1}\n  \n{"b"', ':2}\n  {"c":3}  ']),
      exited: new Promise((res) => {
        exit = res;
      }),
      onEnd: () => exit(0),
    });
    proc.child = child;
    proc.startStdoutDrain(child);

    // The graceful teardown awaits the drain, so everything has been reported
    // by the time it returns.
    await proc.terminate({ escalate: false, graceMs: 50 });

    expect(host.lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(host.ends).toBe(1);
  });
});

describe("ClaudeProcess stderr reader", () => {
  const realWrite = process.stderr.write.bind(process.stderr);
  const forwarded: string[] = [];
  beforeEach(() => {
    forwarded.length = 0;
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      forwarded.push(s);
      return true;
    };
  });
  afterEach(() => {
    (process.stderr as unknown as { write: typeof realWrite }).write = realWrite;
  });

  test("forwards every line verbatim and keeps the first recognised failure cause", async () => {
    const proc = new ClaudeProcess({ cwd: "/tmp", host: recordingHost(), spawner: fakeSpawner(() => null) });
    proc.child = fakeChild({
      stderr: streamOf([
        "warming up\n",
        "Error: Session ID abc is already in use.\n",
        "No conversation found with session ID: abc\n",
      ]),
      exited: new Promise(() => {}),
    });

    proc.startStderrReader();
    await new Promise((r) => setTimeout(r, 5));

    expect(forwarded).toEqual([
      "warming up\n",
      "Error: Session ID abc is already in use.\n",
      "No conversation found with session ID: abc\n",
    ]);
    expect(proc.stderrClassification).toBe("collision");
  });
});

describe("ClaudeProcess phase", () => {
  test("starts dead, and seating a child, sending the handshake and its ack walk spawning → handshaking → running", () => {
    const proc = new ClaudeProcess({ cwd: "/tmp", host: recordingHost(), spawner: fakeSpawner(() => null) });
    expect(proc.phase).toBe("dead");
    expect(proc.handshakeAcked).toBe(false);

    proc.child = fakeChild({ exited: new Promise(() => {}) });
    expect(proc.phase).toBe("spawning");
    proc.markHandshakeSent();
    expect(proc.phase).toBe("handshaking");
    expect(proc.handshakeAcked).toBe(false);
    proc.markHandshakeAcked();
    expect(proc.phase).toBe("running");
    expect(proc.handshakeAcked).toBe(true);
  });

  test("an ack that lands while the child is being torn down moves nothing", () => {
    const proc = new ClaudeProcess({ cwd: "/tmp", host: recordingHost(), spawner: fakeSpawner(() => null) });
    proc.child = fakeChild({ exited: new Promise(() => {}) });
    proc.setPhase("terminating");
    proc.markHandshakeAcked();
    expect(proc.phase).toBe("terminating");
    expect(proc.handshakeAcked).toBe(false);
  });

  test("seating a second child over a live one leaves the phase where it was", () => {
    const proc = new ClaudeProcess({ cwd: "/tmp", host: recordingHost(), spawner: fakeSpawner(() => null) });
    proc.child = fakeChild({ exited: new Promise(() => {}) });
    proc.markHandshakeAcked();
    proc.child = fakeChild({ exited: new Promise(() => {}) });
    expect(proc.phase).toBe("running");
  });
});

describe("ClaudeProcess.terminate", () => {
  test("a teardown moves the phase through terminating to dead, and the ack goes with it", async () => {
    const proc = new ClaudeProcess({ cwd: "/tmp", host: recordingHost(), spawner: fakeSpawner(() => null) });
    let exit!: (code: number) => void;
    proc.child = fakeChild({
      exited: new Promise((res) => {
        exit = res;
      }),
      onEnd: () => exit(0),
    });
    proc.markHandshakeSent();
    proc.markHandshakeAcked();
    expect(proc.handshakeAcked).toBe(true);

    await proc.terminate({ escalate: false, graceMs: 50 });

    expect(proc.phase).toBe("dead");
    expect(proc.handshakeAcked).toBe(false);
  });

  test("a claude that exits on its stdin EOF is never signalled", async () => {
    const proc = new ClaudeProcess({ cwd: "/tmp", host: recordingHost(), spawner: fakeSpawner(() => null) });
    const calls: string[] = [];
    let exit!: (code: number) => void;
    proc.child = fakeChild({
      exited: new Promise((res) => {
        exit = res;
      }),
      onEnd: () => {
        calls.push("stdin.end");
        exit(0);
      },
      onKill: (signal) => calls.push(signal),
    });

    await proc.terminate({ escalate: false, graceMs: 50 });

    expect(calls).toEqual(["stdin.end"]);
    expect(proc.child).toBeNull();
  });

  test("escalate goes straight to SIGINT, then SIGKILL, without closing stdin", async () => {
    const proc = new ClaudeProcess({ cwd: "/tmp", host: recordingHost(), spawner: fakeSpawner(() => null) });
    const calls: string[] = [];
    let exit!: (code: number) => void;
    proc.child = fakeChild({
      exited: new Promise((res) => {
        exit = res;
      }),
      onEnd: () => calls.push("stdin.end"),
      onKill: (signal) => {
        calls.push(signal);
        // Wedged: deaf to SIGINT, dies to SIGKILL.
        if (signal === "SIGKILL") exit(137);
      },
    });

    await proc.terminate({ escalate: true, graceMs: 50 });

    expect(calls).toEqual(["SIGINT", "SIGKILL"]);
    expect(proc.child).toBeNull();
  });
});
