/**
 * subagent-tail.test.ts — the live poll-tailer over a REAL captured
 * background-agent transcript.
 *
 * Contract: feeding the tailer the `subagent-resume` fixture body in
 * growing chunks must emit exactly the child frames the resume splice
 * synthesizes (`synthesizeSubagentChildFrames`) over the same entries —
 * same ids, same parent stamping, same order — so live and reload
 * converge on identical frame shapes. Plus the tailer-specific
 * mechanics: partial-line buffering, compose-on-completion-only,
 * reset-for-replay re-streaming, and missing-file tolerance.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  composeAgentStructuredResult,
  synthesizeSubagentChildFrames,
  type SubagentTranscript,
} from "../replay.ts";
import { readSubagentTranscripts } from "../session.ts";
import { SubagentTailer } from "../subagent-tail.ts";
import type { OutboundMessage } from "../types.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "subagent-resume");
const FIXTURE_BODY = join(FIXTURE_DIR, "agent-aa523090963dd46d9.jsonl");

/** The launching `Agent` `tool_use.id` recorded in the real `.meta.json`. */
const PARENT_TOOL_USE_ID = "toolu_01Rvup4w9HGpYnJ4XHoeV3cK";

const tempDirs: string[] = [];

async function makeTempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "subagent-tail-"));
  tempDirs.push(dir);
  return join(dir, name);
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Build a tailer around a collecting sink, driven by manual `poll()`. */
function makeTailer(outputFile: string): {
  tailer: SubagentTailer;
  frames: OutboundMessage[];
} {
  const frames: OutboundMessage[] = [];
  let seq = 0;
  const tailer = new SubagentTailer({
    parentToolUseId: PARENT_TOOL_USE_ID,
    agentId: "aa523090963dd46d9",
    outputFile,
    emit: (frame) => frames.push(frame),
    nextSeq: () => seq++,
  });
  return { tailer, frames };
}

/** Strip the caller-supplied `seq` so live and resume frames compare. */
function withoutSeq(frame: OutboundMessage): Record<string, unknown> {
  const { seq: _seq, ...rest } = frame as unknown as Record<string, unknown> & {
    seq?: number;
  };
  return rest;
}

describe("contract: tailed frames match the resume splice", () => {
  test("growing-chunk feed emits the same child frames as synthesizeSubagentChildFrames", async () => {
    const body = await Bun.file(FIXTURE_BODY).text();

    // The resume-side reference: the same entries through the same
    // synthesizer, with the same parent linkage the .meta.json records.
    const [fixtureTranscript] = await readSubagentTranscripts(FIXTURE_DIR);
    const reference: SubagentTranscript = {
      meta: { toolUseId: PARENT_TOOL_USE_ID },
      entries: fixtureTranscript.entries,
    };
    let refSeq = 0;
    const expected = synthesizeSubagentChildFrames(reference, () => refSeq++);

    // Live side: append the body in uneven chunks that split lines
    // mid-way, polling after each append.
    const outputFile = await makeTempFile("agent.output");
    await writeFile(outputFile, "");
    const { tailer, frames } = makeTailer(outputFile);

    const chunkSize = 1837; // deliberately not newline-aligned
    for (let at = 0; at < body.length; at += chunkSize) {
      await appendFile(outputFile, body.slice(at, at + chunkSize));
      await tailer.poll();
    }
    await tailer.poll();

    expect(frames.length).toBe(expected.length);
    expect(frames.map(withoutSeq)).toEqual(expected.map(withoutSeq));

    // Spot-check the load-bearing linkage: every child tool_use is
    // stamped with the parent Agent id.
    const toolUses = frames.filter((f) => f.type === "tool_use");
    expect(toolUses.length).toBeGreaterThanOrEqual(3);
    for (const f of toolUses) {
      expect((f as { parent_tool_use_id?: string }).parent_tool_use_id).toBe(
        PARENT_TOOL_USE_ID,
      );
    }
  });

  test("stop(finalFlush) composes the same structured result as the resume splice", async () => {
    const body = await Bun.file(FIXTURE_BODY).text();
    const [fixtureTranscript] = await readSubagentTranscripts(FIXTURE_DIR);

    const outputFile = await makeTempFile("agent.output");
    await writeFile(outputFile, body);
    const { tailer, frames } = makeTailer(outputFile);

    await tailer.poll();
    await tailer.stop(true);

    const structured = frames.filter((f) => f.type === "tool_use_structured");
    const composed = structured[structured.length - 1] as {
      tool_use_id: string;
      tool_name: string;
      structured_result: unknown;
    };
    expect(composed.tool_use_id).toBe(PARENT_TOOL_USE_ID);
    expect(composed.tool_name).toBe("Agent");
    // The tailer builds its meta from the echo (no agentType), so the
    // reference compose runs over the same meta shape.
    expect(composed.structured_result).toEqual(
      composeAgentStructuredResult({
        meta: { toolUseId: PARENT_TOOL_USE_ID },
        entries: fixtureTranscript.entries,
      }),
    );
  });
});

describe("partial-line buffering", () => {
  test("a partial trailing line is buffered, not emitted, until its newline arrives", async () => {
    const body = await Bun.file(FIXTURE_BODY).text();
    const lines = body.split("\n").filter((l) => l.trim().length > 0);
    // Find a line that synthesizes at least one frame (carries tool_use
    // or tool_result content).
    const frameLine = lines.find((l) => l.includes('"tool_use"'));
    expect(frameLine).toBeDefined();

    const outputFile = await makeTempFile("agent.output");
    const half = Math.floor((frameLine as string).length / 2);
    await writeFile(outputFile, (frameLine as string).slice(0, half));

    const { tailer, frames } = makeTailer(outputFile);
    await tailer.poll();
    expect(frames.length).toBe(0);

    await appendFile(outputFile, `${(frameLine as string).slice(half)}\n`);
    await tailer.poll();
    expect(frames.length).toBeGreaterThan(0);
  });

  test("polling an unchanged file emits nothing new", async () => {
    const body = await Bun.file(FIXTURE_BODY).text();
    const outputFile = await makeTempFile("agent.output");
    await writeFile(outputFile, body);

    const { tailer, frames } = makeTailer(outputFile);
    await tailer.poll();
    const afterFirst = frames.length;
    expect(afterFirst).toBeGreaterThan(0);
    await tailer.poll();
    await tailer.poll();
    expect(frames.length).toBe(afterFirst);
  });
});

describe("compose-on-completion discipline", () => {
  test("no composed parent frame is emitted mid-stream", async () => {
    const body = await Bun.file(FIXTURE_BODY).text();
    const outputFile = await makeTempFile("agent.output");
    await writeFile(outputFile, body);

    const { tailer, frames } = makeTailer(outputFile);
    await tailer.poll();
    // Entry-level tool_use_structured frames for CHILDREN are fine;
    // none may target the parent Agent id before completion.
    const parentStructured = frames.filter(
      (f) =>
        f.type === "tool_use_structured" &&
        (f as { tool_use_id: string }).tool_use_id === PARENT_TOOL_USE_ID,
    );
    expect(parentStructured.length).toBe(0);
  });

  test("stop(finalFlush=false) never composes; stop(finalFlush=true) composes exactly once", async () => {
    const body = await Bun.file(FIXTURE_BODY).text();

    const noFlushFile = await makeTempFile("agent.output");
    await writeFile(noFlushFile, body);
    const noFlush = makeTailer(noFlushFile);
    await noFlush.tailer.poll();
    await noFlush.tailer.stop(false);
    expect(
      noFlush.frames.some(
        (f) =>
          f.type === "tool_use_structured" &&
          (f as { tool_use_id: string }).tool_use_id === PARENT_TOOL_USE_ID,
      ),
    ).toBe(false);

    const flushFile = await makeTempFile("agent.output");
    await writeFile(flushFile, body);
    const flush = makeTailer(flushFile);
    // No prior poll: the final flush drains the whole file itself.
    await flush.tailer.stop(true);
    await flush.tailer.stop(true);
    const parentStructured = flush.frames.filter(
      (f) =>
        f.type === "tool_use_structured" &&
        (f as { tool_use_id: string }).tool_use_id === PARENT_TOOL_USE_ID,
    );
    expect(parentStructured.length).toBe(1);
    // The flush also drained the children before composing.
    expect(flush.frames.some((f) => f.type === "tool_use")).toBe(true);
    expect(flush.frames[flush.frames.length - 1]).toBe(
      parentStructured[0] as OutboundMessage,
    );
  });
});

describe("reset-for-replay", () => {
  test("resetForReplay re-streams the full child set from offset 0", async () => {
    const body = await Bun.file(FIXTURE_BODY).text();
    const outputFile = await makeTempFile("agent.output");
    await writeFile(outputFile, body);

    const { tailer, frames } = makeTailer(outputFile);
    await tailer.poll();
    const firstPass = frames.length;
    expect(firstPass).toBeGreaterThan(0);

    tailer.resetForReplay();
    await tailer.poll();
    expect(frames.length).toBe(firstPass * 2);
    expect(frames.slice(firstPass).map(withoutSeq)).toEqual(
      frames.slice(0, firstPass).map(withoutSeq),
    );
  });

  test("after a rewind, re-read lines go to emitReplay and lines past the old offset stay live", async () => {
    const body = await Bun.file(FIXTURE_BODY).text();
    const lines = body.split("\n").filter((l) => l.trim().length > 0);
    const half = Math.floor(lines.length / 2);
    const outputFile = await makeTempFile("agent.output");
    await writeFile(outputFile, lines.slice(0, half).join("\n") + "\n");

    const live: OutboundMessage[] = [];
    const replayed: OutboundMessage[] = [];
    let seq = 0;
    const tailer = new SubagentTailer({
      parentToolUseId: PARENT_TOOL_USE_ID,
      agentId: "aa523090963dd46d9",
      outputFile,
      emit: (frame) => live.push(frame),
      emitReplay: (frame) => replayed.push(frame),
      nextSeq: () => seq++,
    });
    await tailer.poll();
    const firstPass = live.map(withoutSeq);
    expect(firstPass.length).toBeGreaterThan(0);
    expect(replayed.length).toBe(0);

    // Rewind, then let the agent write the rest before the next poll: the
    // re-read of the first half is a replay, the second half is new work.
    tailer.resetForReplay();
    await appendFile(outputFile, lines.slice(half).join("\n") + "\n");
    live.length = 0;
    await tailer.poll();
    expect(replayed.map(withoutSeq)).toEqual(firstPass);

    let refSeq = 0;
    const secondHalf = synthesizeSubagentChildFrames(
      {
        meta: { toolUseId: PARENT_TOOL_USE_ID },
        entries: lines.slice(half).map((l) => JSON.parse(l)),
      },
      () => refSeq++,
    );
    expect(live.map(withoutSeq)).toEqual(secondHalf.map(withoutSeq));
  });
});

describe("best-effort guards", () => {
  test("a missing file is a silent no-op", async () => {
    const outputFile = await makeTempFile("never-created.output");
    const { tailer, frames } = makeTailer(outputFile);
    await tailer.poll();
    await tailer.poll();
    expect(frames.length).toBe(0);
    // stop with flush over a missing file still composes (empty answer).
    await tailer.stop(true);
    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe("tool_use_structured");
  });

  test("a malformed line is skipped without losing later lines", async () => {
    const body = await Bun.file(FIXTURE_BODY).text();
    const lines = body.split("\n").filter((l) => l.trim().length > 0);
    const outputFile = await makeTempFile("agent.output");
    await writeFile(
      outputFile,
      [lines[0], "{not json", ...lines.slice(1)].join("\n") + "\n",
    );

    const { tailer, frames } = makeTailer(outputFile);
    await tailer.poll();
    const toolUses = frames.filter((f) => f.type === "tool_use");
    expect(toolUses.length).toBeGreaterThanOrEqual(3);
  });
});
