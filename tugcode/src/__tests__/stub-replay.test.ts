// stub-replay.test.ts — unit coverage for the deterministic transcript
// replay engine. The runtime path through tugcode's main.ts is
// covered end-to-end by `tests/app-test/smoke-tugcode-stub.test.ts`;
// these tests exercise the load + dispatch logic in isolation
// without spawning the binary.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadTranscript,
  StubReplayEngine,
  STUB_TRANSCRIPT_DIR_ENV,
  TRANSCRIPT_SCHEMA_VERSION,
  stubTranscriptForSession,
  type TugcodeTranscript,
} from "../stub-replay.ts";
import type { OutboundMessage } from "../types.ts";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "tugcode-stub-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function writeTranscriptFile(content: unknown): string {
  const path = join(workdir, "t.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

function makeMinimalTranscript(): TugcodeTranscript {
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    tugcodeVersion: "0.8.0",
    turns: [
      {
        index: 0,
        description: "hello",
        outputs: [
          {
            type: "assistant_text",
            msg_id: "m0",
            block_index: 0,
            seq: 0,
            rev: 0,
            text: "Hello, world.",
            is_partial: false,
            status: "complete",
            ipc_version: 2,
          },
          {
            type: "turn_complete",
            msg_id: "m0",
            seq: 1,
            result: "success",
            ipc_version: 2,
          },
        ],
      },
    ],
  };
}

describe("loadTranscript", () => {
  test("parses a well-formed transcript", () => {
    const path = writeTranscriptFile(makeMinimalTranscript());
    const t = loadTranscript(path);
    expect(t.schemaVersion).toBe(TRANSCRIPT_SCHEMA_VERSION);
    expect(t.tugcodeVersion).toBe("0.8.0");
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0].outputs).toHaveLength(2);
  });

  test("throws on missing file", () => {
    expect(() => loadTranscript(join(workdir, "missing.json"))).toThrow(
      /failed to read transcript/,
    );
  });

  test("throws on invalid JSON", () => {
    const path = writeTranscriptFile("{not-json");
    expect(() => loadTranscript(path)).toThrow(/not valid JSON/);
  });

  test("throws on schema version mismatch", () => {
    const t = makeMinimalTranscript();
    t.schemaVersion = TRANSCRIPT_SCHEMA_VERSION + 99;
    const path = writeTranscriptFile(t);
    expect(() => loadTranscript(path)).toThrow(/schemaVersion .* not supported/);
  });

  test("throws when turn.index does not match array position", () => {
    const t = makeMinimalTranscript();
    t.turns[0].index = 5; // mismatch
    const path = writeTranscriptFile(t);
    expect(() => loadTranscript(path)).toThrow(/index=5/);
  });

  test("throws on missing tugcodeVersion", () => {
    const obj = { schemaVersion: TRANSCRIPT_SCHEMA_VERSION, turns: [] };
    const path = writeTranscriptFile(obj);
    expect(() => loadTranscript(path)).toThrow(/missing string tugcodeVersion/);
  });

  test("throws on missing turns array", () => {
    const obj = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      tugcodeVersion: "0.8.0",
    };
    const path = writeTranscriptFile(obj);
    expect(() => loadTranscript(path)).toThrow(/missing turns/);
  });
});

describe("StubReplayEngine", () => {
  test("synthesizeHandshake emits protocol_ack + session_init in order", () => {
    const transcript = makeMinimalTranscript();
    const captured: OutboundMessage[] = [];
    const engine = new StubReplayEngine({
      transcript,
      sessionId: "sess-1",
      emit: (m) => captured.push(m),
    });
    engine.synthesizeHandshake(1);
    expect(captured).toHaveLength(2);
    expect(captured[0].type).toBe("protocol_ack");
    expect(captured[1].type).toBe("session_init");
    if (captured[0].type === "protocol_ack") {
      expect(captured[0].session_id).toBe("sess-1");
      expect(captured[0].version).toBe(1);
    }
  });

  test("dispatchTurn emits the matching turn's outputs in order", () => {
    const transcript = makeMinimalTranscript();
    const captured: OutboundMessage[] = [];
    const engine = new StubReplayEngine({
      transcript,
      sessionId: "sess-1",
      emit: (m) => captured.push(m),
    });
    expect(engine.currentTurnIndex).toBe(0);
    const ok = engine.dispatchTurn();
    expect(ok).toBe(true);
    expect(engine.currentTurnIndex).toBe(1);
    expect(captured.map((c) => c.type)).toEqual(["assistant_text", "turn_complete"]);
  });

  test("dispatchTurn after exhaustion emits error event and signals shutdown", () => {
    const transcript = makeMinimalTranscript();
    const captured: OutboundMessage[] = [];
    const engine = new StubReplayEngine({
      transcript,
      sessionId: "sess-1",
      emit: (m) => captured.push(m),
    });
    engine.dispatchTurn(); // 0 → 1, success
    captured.length = 0;
    const ok = engine.dispatchTurn(); // out of bounds
    expect(ok).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe("error");
    if (captured[0].type === "error") {
      expect(captured[0].recoverable).toBe(false);
      expect(captured[0].message).toContain("exceeds transcript length");
    }
  });

  test("multi-turn transcript dispatches each turn at its own index", () => {
    const t: TugcodeTranscript = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      tugcodeVersion: "0.8.0",
      turns: [
        {
          index: 0,
          outputs: [
            {
              type: "assistant_text",
              msg_id: "a",
              block_index: 0,
              seq: 0,
              rev: 0,
              text: "first",
              is_partial: false,
              status: "complete",
              ipc_version: 2,
            },
          ],
        },
        {
          index: 1,
          outputs: [
            {
              type: "assistant_text",
              msg_id: "b",
              block_index: 0,
              seq: 0,
              rev: 0,
              text: "second",
              is_partial: false,
              status: "complete",
              ipc_version: 2,
            },
          ],
        },
      ],
    };
    const captured: OutboundMessage[] = [];
    const engine = new StubReplayEngine({
      transcript: t,
      sessionId: "sess-1",
      emit: (m) => captured.push(m),
    });
    expect(engine.dispatchTurn()).toBe(true);
    expect(engine.dispatchTurn()).toBe(true);
    expect(captured).toHaveLength(2);
    if (captured[0].type === "assistant_text") {
      expect(captured[0].text).toBe("first");
    }
    if (captured[1].type === "assistant_text") {
      expect(captured[1].text).toBe("second");
    }
  });
});

describe("paced turns", () => {
  test("loadTranscript carries paceMs, and refuses a negative one", () => {
    const paced = writeTranscriptFile({ ...makeMinimalTranscript(), paceMs: 25 });
    expect(loadTranscript(paced).paceMs).toBe(25);
    expect(loadTranscript(writeTranscriptFile(makeMinimalTranscript())).paceMs).toBeUndefined();
    const bad = writeTranscriptFile({ ...makeMinimalTranscript(), paceMs: -1 });
    expect(() => loadTranscript(bad)).toThrow(/paceMs=-1/);
  });

  test("a paced turn returns before it finishes, and emits at the cadence", async () => {
    const captured: { type: string; at: number }[] = [];
    const engine = new StubReplayEngine({
      transcript: { ...makeMinimalTranscript(), paceMs: 30 },
      sessionId: "sess-1",
      emit: (m) => captured.push({ type: m.type, at: performance.now() }),
    });
    const start = performance.now();
    expect(engine.dispatchTurn()).toBe(true);
    // The dispatch returns before the turn has finished, so the IPC loop
    // keeps reading stdin while the turn streams.
    expect(captured.length).toBeLessThan(2);
    await engine.paced;
    expect(captured.map((c) => c.type)).toEqual(["assistant_text", "turn_complete"]);
    expect(captured[0].at - start).toBeLessThan(30);
    expect(captured[1].at - captured[0].at).toBeGreaterThanOrEqual(25);
  });

  test("a second paced turn waits for the first to finish", async () => {
    const turn = (index: number, msgId: string) => ({
      index,
      outputs: [
        {
          type: "assistant_text" as const,
          msg_id: msgId,
          block_index: 0,
          seq: 0,
          rev: 0,
          text: msgId,
          is_partial: false,
          status: "complete",
          ipc_version: 2,
        },
        {
          type: "turn_complete" as const,
          msg_id: msgId,
          seq: 1,
          result: "success",
          ipc_version: 2,
        },
      ],
    });
    const captured: string[] = [];
    const engine = new StubReplayEngine({
      transcript: {
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        tugcodeVersion: "0.8.0",
        paceMs: 10,
        turns: [turn(0, "a"), turn(1, "b")],
      },
      sessionId: "sess-1",
      emit: (m) => captured.push(`${m.type}:${(m as { msg_id?: string }).msg_id}`),
    });
    engine.dispatchTurn();
    engine.dispatchTurn();
    await engine.paced;
    expect(captured).toEqual([
      "assistant_text:a",
      "turn_complete:a",
      "assistant_text:b",
      "turn_complete:b",
    ]);
  });

  test("an exhausted dispatch during a paced turn errors after the turn's last output", async () => {
    const captured: string[] = [];
    const engine = new StubReplayEngine({
      transcript: { ...makeMinimalTranscript(), paceMs: 10 },
      sessionId: "sess-1",
      emit: (m) => captured.push(m.type),
    });
    expect(engine.dispatchTurn()).toBe(true);
    expect(engine.dispatchTurn()).toBe(false);
    await engine.paced;
    expect(captured).toEqual(["assistant_text", "turn_complete", "error"]);
  });
});

describe("stubTranscriptForSession", () => {
  test("finds the session's transcript in the named directory, and nothing else", () => {
    writeFileSync(join(workdir, "sess-stub.json"), JSON.stringify(makeMinimalTranscript()));
    const env = { [STUB_TRANSCRIPT_DIR_ENV]: workdir };
    expect(stubTranscriptForSession(env, "sess-stub")).toBe(join(workdir, "sess-stub.json"));
    expect(stubTranscriptForSession(env, "sess-live")).toBeUndefined();
    expect(stubTranscriptForSession({}, "sess-stub")).toBeUndefined();
    expect(stubTranscriptForSession({ [STUB_TRANSCRIPT_DIR_ENV]: "" }, "sess-stub")).toBeUndefined();
  });
});
