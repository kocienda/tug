import { describe, test, expect } from "bun:test";
import { spawn } from "bun";
import { join } from "path";
import { isInboundMessage, isModelChange, isSessionCommand } from "../types.ts";

describe("main.ts protocol handshake", () => {
  test("protocol_init receives protocol_ack with session_id", async () => {
    // Spawn the main.ts process
    const mainPath = join(import.meta.dir, "..", "main.ts");
    const proc = spawn(["bun", "run", mainPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Send protocol_init message
    const protocolInit = JSON.stringify({ type: "protocol_init", version: 1 }) + "\n";
    proc.stdin.write(protocolInit);
    proc.stdin.end();

    // Read response
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
        if (output.includes("\n")) break; // Got a complete line
      }
    } finally {
      reader.releaseLock();
      proc.kill();
    }

    // Parse the response
    const lines = output.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const response = JSON.parse(lines[0]);
    expect(response.type).toBe("protocol_ack");
    expect(response.version).toBe(1);
    expect(response.session_id).toBeDefined();
    expect(typeof response.session_id).toBe("string");
    expect(response.session_id.length).toBeGreaterThan(0);
  });

  test("protocol_init with wrong version receives error", async () => {
    const mainPath = join(import.meta.dir, "..", "main.ts");
    const proc = spawn(["bun", "run", mainPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Send protocol_init with wrong version
    const protocolInit = JSON.stringify({ type: "protocol_init", version: 99 }) + "\n";
    proc.stdin.write(protocolInit);
    proc.stdin.end();

    // Read response
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
        if (output.includes("\n")) break;
      }
    } finally {
      reader.releaseLock();
      proc.kill();
    }

    // Parse the response
    const lines = output.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const response = JSON.parse(lines[0]);
    expect(response.type).toBe("error");
    expect(response.message).toContain("Unsupported protocol version");
    expect(response.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type guard routing tests for new inbound message types
// (Unit-style tests; integration tests for model_change/session_command require
//  an initialized SessionManager which calls the claude CLI. These type guard
//  tests provide coverage for the routing chain per the architect strategy.)
// ---------------------------------------------------------------------------

describe("main.ts inbound message type guard routing", () => {
  test("model_change is accepted by isInboundMessage", () => {
    const msg = { type: "model_change", model: "claude-haiku-3-5" };
    expect(isInboundMessage(msg)).toBe(true);
  });

  test("model_change is dispatched by isModelChange", () => {
    const msg = { type: "model_change" as const, model: "claude-haiku-3-5" };
    expect(isModelChange(msg)).toBe(true);
  });

  test("model_change is not dispatched as session_command", () => {
    const msg = { type: "model_change" as const, model: "claude-opus-4-6" };
    expect(isSessionCommand(msg as any)).toBe(false);
  });

  test("session_command is accepted by isInboundMessage", () => {
    const msg = { type: "session_command", command: "fork" };
    expect(isInboundMessage(msg)).toBe(true);
  });

  test("session_command is dispatched by isSessionCommand", () => {
    const msg = { type: "session_command" as const, command: "fork" as const };
    expect(isSessionCommand(msg)).toBe(true);
  });

  test("session_command is not dispatched as model_change", () => {
    const msg = { type: "session_command" as const, command: "new" as const };
    expect(isModelChange(msg as any)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --resume-session argv parsing
// ---------------------------------------------------------------------------

/**
 * Spawn main.ts with the given argv and capture its first stderr line
 * that starts with `Starting tugcode (`. main.ts logs argv state there
 * before claude is even consulted, so this is a tugcode-only assertion
 * that doesn't depend on a real claude binary being on PATH.
 */
async function readStartupLine(args: string[]): Promise<string> {
  const mainPath = join(import.meta.dir, "..", "main.ts");
  const proc = spawn(["bun", "run", mainPath, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let line: string | null = null;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx >= 0) {
        line = buf.slice(0, newlineIdx);
        break;
      }
    }
  } finally {
    reader.releaseLock();
    proc.stdin.end();
    proc.kill();
  }
  return line ?? "";
}

describe("Step R4: main.ts cold-boot resume does not invoke startup replay", () => {
  test("resume-mode protocol_init emits synthetic session_init but NO replay bracket", async () => {
    // Step R4 (Phase A-R4) collapsed the dual replay-trigger paths.
    // Pre-R4: main.ts's resume branch ran `await sessionManager.runReplay()`
    // immediately after `prepareSession()`, so a startup-replay bracket
    // (`replay_started` + `replay_complete`) appeared on the wire even
    // when no claude was on PATH.
    // Post-R4: main.ts only emits the synthetic `session_init` and kicks
    // off `spawnClaudeAndWatch`. Replay is request-driven only — the
    // `request_replay` verb is the single trigger.
    //
    // This test is the load-bearing regression pin for the deletion.
    // Failure-first: reintroducing `await sessionManager.runReplay()`
    // in main.ts's resume branch makes the second assertion fail
    // (replay frames appear).

    const mainPath = join(import.meta.dir, "..", "main.ts");
    const proc = spawn([
      "bun",
      "run",
      mainPath,
      "--dir",
      "/tmp/r4-cold-boot-no-startup-replay",
      "--session-id",
      "r4-tug-id",
      "--session-mode",
      "resume",
      "--resume-session",
      "r4-claude-id",
    ], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Send protocol_init and let main.ts run for a brief window.
    // We intentionally don't wait for claude to spawn — that fails
    // because /tmp/r4-cold-boot-no-startup-replay doesn't have a JSONL
    // and there's no claude on the test PATH. We're measuring what
    // tugcode emits between protocol_init and the inevitable
    // resume_failed.
    proc.stdin.write(JSON.stringify({ type: "protocol_init", version: 1 }) + "\n");

    // Read stdout until the startup frames (protocol_ack + synthetic
    // session_init) have actually landed, then drain a short extra
    // window so any (erroneous) replay bracket would have time to
    // appear. A fixed wall-clock window is flaky: under `just ci`
    // load (rust + tugdeck tests running first) the cold `bun run
    // main.ts` subprocess can take >1.5s just to emit protocol_ack,
    // and the old window would expire having captured nothing.
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Generous cap on how long we'll wait for the startup frames.
    const hardDeadline = Date.now() + 8000;
    // Once the startup frames are seen, drain this much longer to
    // catch any replay frames that would follow them.
    const drainMs = 500;
    let drainUntil: number | null = null;
    const sawStartup = () =>
      buf.includes('"protocol_ack"') && buf.includes('"session_init"');
    // The pending read is held across ticks rather than re-issued each pass.
    // Racing a fresh `reader.read()` against the tick abandons that read when
    // the tick wins, and the chunk it later resolves with is dropped — which
    // silently ate whichever frame happened to land inside the first tick.
    let pendingRead: Promise<any> | null = null;
    try {
      while (Date.now() < hardDeadline) {
        if (drainUntil !== null && Date.now() >= drainUntil) break;
        if (pendingRead === null) pendingRead = reader.read();
        const timeoutPromise = new Promise<{ timedOut: true }>(
          (resolve) => setTimeout(() => resolve({ timedOut: true }), 100),
        );
        const result: any = await Promise.race([pendingRead, timeoutPromise]);
        if (result.timedOut) continue; // tick, not subprocess output
        pendingRead = null; // this read is consumed; the next pass issues a new one
        if (result.done) break; // real EOF: nothing more is coming
        buf += decoder.decode(result.value, { stream: true });
        if (drainUntil === null && sawStartup()) {
          drainUntil = Date.now() + drainMs;
        }
      }
    } finally {
      reader.releaseLock();
      proc.stdin.end();
      proc.kill();
    }

    const lines = buf.split("\n").filter((l) => l.trim().length > 0);
    const frames = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter((f): f is Record<string, unknown> => f !== null);

    // Sanity: we got at least the protocol_ack + synthetic session_init.
    const types = frames.map((f) => f.type as string);
    expect(types).toContain("protocol_ack");
    expect(types).toContain("session_init");

    // Load-bearing assertion: NO replay frames in this window.
    // Pre-R4 the synthetic session_init was followed by replay_started
    // and replay_complete (the latter with `error: jsonl_missing`
    // since the directory we point at has no JSONL). Post-R4 those
    // never appear — replay is verb-driven only.
    expect(types).not.toContain("replay_started");
    expect(types).not.toContain("replay_complete");
  });
});

describe("main.ts --resume-session argv", () => {
  test("--resume-session <id> appears in startup log when provided", async () => {
    const line = await readStartupLine([
      "--dir",
      "/tmp/resume-argv",
      "--session-id",
      "tug-uuid-1",
      "--session-mode",
      "resume",
      "--resume-session",
      "claude-resume-id-99",
    ]);
    expect(line).toContain("Starting tugcode");
    expect(line).toContain("resumeSessionId: claude-resume-id-99");
    expect(line).toContain("sessionId: tug-uuid-1");
    expect(line).toContain("sessionMode: resume");
  });

  test("--resume-session is omitted from startup log when not provided", async () => {
    const line = await readStartupLine([
      "--dir",
      "/tmp/resume-argv",
      "--session-id",
      "tug-uuid-2",
      "--session-mode",
      "new",
    ]);
    expect(line).toContain("Starting tugcode");
    // Logs the resumeSessionId field only when set; absence is silent.
    expect(line).not.toContain("resumeSessionId:");
  });
});
