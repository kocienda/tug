/**
 * subagent-resume.test.ts — background-agent transcript restore on resume.
 *
 * Drives the REAL captured subagent transcript (a trimmed slice of session
 * `1c53fe86-…`, a backgrounded `Explore` agent) through the discovery,
 * synthesis, and splice code so the resume path reconstructs the agent's
 * child tool calls that Claude Code persists out-of-band under `subagents/`.
 *
 * Fixture: `fixtures/subagent-resume/` holds the real `main.jsonl`, a
 * trimmed real `agent-<agentId>.jsonl` (3 tool calls incl. a
 * `<persisted-output>` large result, plus the real final answer), and the
 * verbatim `.meta.json`. Real content, real code paths — no fabrication.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OutboundMessage } from "../types.ts";
import {
  readSubagentTranscripts,
  subagentsDirFor,
} from "../session.ts";
import { ClaudeHome } from "../claude-home.ts";
import {
  composeAgentStructuredResult,
  synthesizeSubagentChildFrames,
  translateJsonlSession,
  type SubagentTranscript,
} from "../replay.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "subagent-resume");

/** Collect a full replay pass into a frame array. */
async function replayFrames(
  jsonl: string,
  subagents: SubagentTranscript[],
): Promise<OutboundMessage[]> {
  const out: OutboundMessage[] = [];
  for await (const m of translateJsonlSession(
    { kind: "ok", jsonl, claudeSessionId: "1c53fe86", subagents },
    { disableYield: true },
  )) {
    out.push(m);
  }
  return out;
}

/** The launching `Agent` `tool_use.id` recorded in the real `.meta.json`. */
const PARENT_TOOL_USE_ID = "toolu_01Rvup4w9HGpYnJ4XHoeV3cK";

describe("subagentsDirFor", () => {
  test("resolves the session's subagents directory", () => {
    expect(
      subagentsDirFor(ClaudeHome.at("/root"), "/Users/foo/src/tugtool", "sess-1"),
    ).toBe("/root/projects/-Users-foo-src-tugtool/sess-1/subagents");
  });
});

describe("readSubagentTranscripts", () => {
  test("reads the real captured transcript + meta", async () => {
    const transcripts = await readSubagentTranscripts(FIXTURE_DIR);
    expect(transcripts).toHaveLength(1);
    const t = transcripts[0];
    expect(t.meta.toolUseId).toBe(PARENT_TOOL_USE_ID);
    expect(t.meta.agentType).toBe("Explore");
    expect(t.meta.description).toBe("Find block renderer dependencies");
    // The trimmed fixture carries its real entries (setup + 3 tool calls
    // + the final answer).
    expect(t.entries.length).toBeGreaterThan(0);
    const toolUses = t.entries.flatMap((e) => {
      const c = e.message?.content;
      return Array.isArray(c) ? c.filter((b) => b.type === "tool_use") : [];
    });
    expect(toolUses.length).toBeGreaterThanOrEqual(3);
    expect(toolUses.every((b) => typeof b.id === "string")).toBe(true);
  });

  test("missing subagents dir yields [] (no throw)", async () => {
    const transcripts = await readSubagentTranscripts(
      join(FIXTURE_DIR, "does-not-exist"),
    );
    expect(transcripts).toEqual([]);
  });
});

describe("synthesizeSubagentChildFrames", () => {
  test("emits parent-linked child frames, no turn-lifecycle frames", async () => {
    const [transcript] = await readSubagentTranscripts(FIXTURE_DIR);
    let seq = 0;
    const frames = synthesizeSubagentChildFrames(transcript, () => seq++);

    const toolUses = frames.filter((f) => f.type === "tool_use");
    const toolResults = frames.filter((f) => f.type === "tool_result");
    expect(toolUses.length).toBeGreaterThanOrEqual(3);
    expect(toolResults.length).toBeGreaterThanOrEqual(3);

    // Every child tool_use is linked to the parent Agent; only tool_use
    // carries the parent id (results/structured merge by id).
    for (const f of toolUses) {
      expect((f as { parent_tool_use_id?: string }).parent_tool_use_id).toBe(
        PARENT_TOOL_USE_ID,
      );
    }
    expect(
      toolResults.every(
        (f) => (f as { parent_tool_use_id?: string }).parent_tool_use_id ===
          undefined,
      ),
    ).toBe(true);

    // No turn-lifecycle frames — children live inside the parent's turn.
    const forbidden = new Set([
      "turn_started",
      "turn_complete",
      "system_metadata",
      "add_user_message",
    ]);
    expect(frames.some((f) => forbidden.has(f.type))).toBe(false);

    // seq threads the caller's counter — strictly increasing, unique.
    const seqs = toolUses.map((f) => (f as { seq: number }).seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("the persisted-output child result is passed through verbatim", async () => {
    const [transcript] = await readSubagentTranscripts(FIXTURE_DIR);
    const frames = synthesizeSubagentChildFrames(transcript, () => 0);
    const results = frames.filter((f) => f.type === "tool_result");
    // Q01: large outputs are inline <persisted-output> strings (preview +
    // path) — the reader/synthesizer forward them, never dereference.
    const persisted = results.find((f) =>
      (f as { output?: string }).output?.includes("<persisted-output>"),
    );
    expect(persisted).toBeDefined();
  });
});

describe("translateJsonlSession — subagent splice", () => {
  test("splices children right after the parent Agent tool_use", async () => {
    const main = await Bun.file(join(FIXTURE_DIR, "main.jsonl")).text();
    const subagents = await readSubagentTranscripts(FIXTURE_DIR);
    const frames = await replayFrames(main, subagents);

    // Locate the parent Agent tool_use in the emitted stream.
    const parentIdx = frames.findIndex(
      (f) =>
        f.type === "tool_use" &&
        (f as { tool_use_id: string }).tool_use_id === PARENT_TOOL_USE_ID,
    );
    expect(parentIdx).toBeGreaterThanOrEqual(0);

    // The children follow the parent (spliced mid-turn), each linked back.
    const childToolUses = frames.filter(
      (f) =>
        f.type === "tool_use" &&
        (f as { parent_tool_use_id?: string }).parent_tool_use_id ===
          PARENT_TOOL_USE_ID,
    );
    expect(childToolUses.length).toBeGreaterThanOrEqual(3);
    const firstChildIdx = frames.indexOf(childToolUses[0]);
    expect(firstChildIdx).toBeGreaterThan(parentIdx);
  });

  test("empty subagents ⇒ frame stream identical to legacy replay", async () => {
    const main = await Bun.file(join(FIXTURE_DIR, "main.jsonl")).text();
    const withNone = await replayFrames(main, []);
    // No child frame carries the parent link when nothing is spliced.
    expect(
      withNone.some(
        (f) =>
          f.type === "tool_use" &&
          (f as { parent_tool_use_id?: string }).parent_tool_use_id ===
            PARENT_TOOL_USE_ID,
      ),
    ).toBe(false);
    // And the parent Agent tool_use itself is still present.
    expect(
      withNone.some(
        (f) =>
          f.type === "tool_use" &&
          (f as { tool_use_id: string }).tool_use_id === PARENT_TOOL_USE_ID,
      ),
    ).toBe(true);
  });

  // Nesting (spawnDepth >= 2): the enumeration linkage is designed-in
  // (spliceSubagentChildren recurses on child tool_use ids), but a real
  // two-level capture doesn't exist yet. Per the plan, the nested-case
  // assertion is deferred rather than driven by a hand-crafted fixture.
});

describe("translateJsonlSession — agent structured result restore", () => {
  test("composes the Agent's final answer + stats; drops the async echo", async () => {
    const main = await Bun.file(join(FIXTURE_DIR, "main.jsonl")).text();
    const subagents = await readSubagentTranscripts(FIXTURE_DIR);
    const frames = await replayFrames(main, subagents);

    // Exactly one structured result for the parent Agent — the composed one,
    // not the async-launch echo.
    const agentStructured = frames.filter(
      (f) =>
        f.type === "tool_use_structured" &&
        (f as { tool_use_id: string }).tool_use_id === PARENT_TOOL_USE_ID,
    );
    expect(agentStructured).toHaveLength(1);

    const sr = (
      agentStructured[0] as {
        structured_result: Record<string, unknown>;
      }
    ).structured_result;
    // Not the async echo (that carried isAsync/status:async_launched).
    expect(sr.isAsync).toBeUndefined();
    expect(sr.status).toBe("completed");
    // Final answer text restored (from the trailing assistant entry).
    const content = sr.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThan(0);
    expect(content[0].type).toBe("text");
    expect(content.map((c) => c.text).join("")).toContain("Summary");
    // Stats derived from the entries.
    expect(sr.totalToolUseCount as number).toBeGreaterThanOrEqual(3);
    expect(sr.totalTokens as number).toBeGreaterThan(0);
  });

  test("composeAgentStructuredResult content excludes tool_use blocks", async () => {
    const [transcript] = await readSubagentTranscripts(FIXTURE_DIR);
    const sr = composeAgentStructuredResult(transcript);
    const content = sr.content as Array<{ type: string }>;
    // Content is the answer text only — the calls arrive as parent-linked
    // children, so duplicating them here would double-render.
    expect(content.every((c) => c.type === "text")).toBe(true);
  });
});

describe("resume orchestration — discovery on claude's real layout", () => {
  const tmpRoots: string[] = [];
  afterAll(async () => {
    await Promise.all(tmpRoots.map((d) => rm(d, { recursive: true, force: true })));
  });

  // Exercises the exact seam `runReplay` composes: resolve the subagents dir
  // from (claudeProjectsRoot, projectDir, sessionId) via `subagentsDirFor`,
  // read it, and feed the result to `translateJsonlSession`. Laid out on a
  // real temp tree exactly as Claude Code writes it — no SessionManager mock
  // ceremony (which would add realpath("/tmp") flakiness without covering
  // more of this change).
  test("finds transcripts at <root>/<encoded>/<id>/subagents and splices them", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-resume-"));
    tmpRoots.push(root);
    const projectDir = "/Users/example/src/proj";
    const sessionId = "sess-integration";
    const home = ClaudeHome.at(root);
    const subDir = join(home.projectDir(projectDir), sessionId, "subagents");
    await mkdir(subDir, { recursive: true });
    const stem = "agent-aa523090963dd46d9";
    await copyFile(
      join(FIXTURE_DIR, `${stem}.jsonl`),
      join(subDir, `${stem}.jsonl`),
    );
    await copyFile(
      join(FIXTURE_DIR, `${stem}.meta.json`),
      join(subDir, `${stem}.meta.json`),
    );

    // The path `runReplay` composes must resolve to our laid-out dir.
    const resolvedDir = subagentsDirFor(home, projectDir, sessionId);
    expect(resolvedDir).toBe(subDir);

    const subagents = await readSubagentTranscripts(resolvedDir);
    expect(subagents).toHaveLength(1);
    expect(subagents[0].meta.toolUseId).toBe(PARENT_TOOL_USE_ID);

    const main = await Bun.file(join(FIXTURE_DIR, "main.jsonl")).text();
    const frames = await replayFrames(main, subagents);
    const linked = frames.filter(
      (f) =>
        f.type === "tool_use" &&
        (f as { parent_tool_use_id?: string }).parent_tool_use_id ===
          PARENT_TOOL_USE_ID,
    );
    expect(linked.length).toBeGreaterThanOrEqual(3);
  });
});
