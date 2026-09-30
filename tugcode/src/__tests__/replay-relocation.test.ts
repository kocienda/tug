/**
 * replay-relocation.test.ts — replaying a session that changed its project
 * directory.
 *
 * A directory change forks the conversation into the target directory, and
 * claude writes the fork's JSONL only when the first user message arrives.
 * So a replay before then reads the PARENT's transcript (from the parent's
 * directory) and marks the move after it; a replay after then reads the
 * session's own transcript — which carries the parent's lines with their
 * uuids intact — and marks the move before the first prompt the parent does
 * not hold. The mark is one `replay_relocation` frame; an unreadable parent
 * draws none.
 */

import { describe, expect, test } from "bun:test";
import {
  type JsonlReadResult,
  SessionManager,
  jsonlPathFor,
} from "../session.ts";
import type { OutboundMessage } from "../types.ts";
import { unwrapReplayBatches } from "./capture-ipc.ts";
import { drainPendingWrites } from "../ipc.ts";

const ROOT = "/tmp/replay-relocation-root";
const SID = "44444444-4444-4444-4444-444444444444";
const PARENT_ID = "55555555-5555-5555-5555-555555555555";

function turn(promptUuid: string, text: string, msgId: string, cwd: string, sessionId: string) {
  return [
    {
      type: "user",
      uuid: promptUuid,
      cwd,
      sessionId,
      message: { role: "user", content: [{ type: "text", text }] },
    },
    {
      type: "assistant",
      uuid: `${promptUuid}-reply`,
      cwd,
      sessionId,
      message: {
        id: msgId,
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `reply to ${text}` }],
      },
    },
  ];
}

function jsonl(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function dirs() {
  const tag = Math.random().toString(36).slice(2, 8);
  return { a: `/tmp/relocation-A-${tag}`, b: `/tmp/relocation-B-${tag}` };
}

/** The parent's two turns, written in A under the parent's id. */
function parentEntries(a: string) {
  return [
    ...turn("p1", "remember the word lantern", "msg_p1", a, PARENT_ID),
    ...turn("p2", "and the colour teal", "msg_p2", a, PARENT_ID),
  ];
}

/** The fork's own JSONL: the parent's lines re-homed to B, plus `extra`. */
function forkEntries(a: string, b: string, extra: object[]) {
  const carried = parentEntries(a).map((e) => ({ ...e, cwd: b, sessionId: SID }));
  return [...carried, ...extra];
}

function manager(
  b: string,
  files: Record<string, string>,
  relocation?: { parentClaudeId: string; parentProjectDir: string },
): SessionManager {
  return new SessionManager(b, SID, "new", undefined, {
    sessionsDbPath: null,
    claudeProjectsRoot: ROOT,
    replayTimeoutMs: 10_000,
    relocation,
    jsonlReader: async (path: string): Promise<JsonlReadResult> =>
      path in files
        ? { kind: "ok", jsonl: files[path]! }
        : { kind: "missing", message: `no file at ${path}` },
  });
}

async function replay(
  m: SessionManager,
  relocation?: { parentSessionId: string; fromDir: string; toDir: string },
): Promise<OutboundMessage[]> {
  const captured: OutboundMessage[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  (Bun as any).write = (dest: unknown, data: unknown) => {
    if (dest === Bun.stdout) {
      const text = typeof data === "string" ? data : decoder.decode(data as Uint8Array);
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          captured.push(JSON.parse(line) as OutboundMessage);
        } catch {
          // ignore non-JSON
        }
      }
    }
    return Promise.resolve(
      data instanceof Uint8Array ? data.length : (data as string).length,
    );
  };
  try {
    await m.runReplay(undefined, undefined, relocation);
    await drainPendingWrites();
  } finally {
    (Bun as any).write = originalWrite;
  }
  return unwrapReplayBatches(captured);
}

/** The frame types that matter here, in order: prompts by uuid, the divider. */
function outline(frames: OutboundMessage[]): string[] {
  const out: string[] = [];
  for (const f of frames) {
    if (f.type === "add_user_message") out.push(`prompt:${f.promptUuid}`);
    else if (f.type === "replay_relocation") out.push(`moved:${f.from_dir}->${f.to_dir}`);
    else if (f.type === "replay_complete") out.push("complete");
  }
  return out;
}

describe("runReplay with a relocation", () => {
  test("fork unwritten: the parent's turns replay, then the divider", async () => {
    const { a, b } = dirs();
    const m = manager(
      b,
      { [jsonlPathFor(ROOT, a, PARENT_ID)]: jsonl(parentEntries(a)) },
      { parentClaudeId: PARENT_ID, parentProjectDir: a },
    );
    const frames = await replay(m);
    expect(outline(frames)).toEqual([
      "prompt:p1",
      "prompt:p2",
      `moved:${a}->${b}`,
      "complete",
    ]);
    // The card stays bound to this session, not the parent.
    const meta = frames.find((f) => f.type === "system_metadata") as
      | { session_id?: string }
      | undefined;
    expect(meta?.session_id).toBe(SID);
  });

  test("fork written: the divider sits before the first prompt said after the move", async () => {
    const { a, b } = dirs();
    const own = forkEntries(a, b, turn("n1", "what was the word?", "msg_n1", b, SID));
    const m = manager(
      b,
      {
        [jsonlPathFor(ROOT, a, PARENT_ID)]: jsonl(parentEntries(a)),
        [jsonlPathFor(ROOT, b, SID)]: jsonl(own),
      },
      { parentClaudeId: PARENT_ID, parentProjectDir: a },
    );
    expect(outline(await replay(m))).toEqual([
      "prompt:p1",
      "prompt:p2",
      `moved:${a}->${b}`,
      "prompt:n1",
      "complete",
    ]);
  });

  test("the parent resumed in A after the move: the divider does not move", async () => {
    const { a, b } = dirs();
    const own = forkEntries(a, b, turn("n1", "what was the word?", "msg_n1", b, SID));
    const parentLater = [
      ...parentEntries(a),
      ...turn("p3", "a later thought in A", "msg_p3", a, PARENT_ID),
    ];
    const m = manager(
      b,
      {
        [jsonlPathFor(ROOT, a, PARENT_ID)]: jsonl(parentLater),
        [jsonlPathFor(ROOT, b, SID)]: jsonl(own),
      },
      { parentClaudeId: PARENT_ID, parentProjectDir: a },
    );
    expect(outline(await replay(m))).toEqual([
      "prompt:p1",
      "prompt:p2",
      `moved:${a}->${b}`,
      "prompt:n1",
      "complete",
    ]);
  });

  test("the parent JSONL is missing: no divider, the replay otherwise unchanged", async () => {
    const { a, b } = dirs();
    const own = forkEntries(a, b, turn("n1", "what was the word?", "msg_n1", b, SID));
    const files = { [jsonlPathFor(ROOT, b, SID)]: jsonl(own) };
    const moved = manager(b, files, { parentClaudeId: PARENT_ID, parentProjectDir: a });
    const plain = manager(b, files);
    const movedOutline = outline(await replay(moved));
    expect(movedOutline).toEqual(["prompt:p1", "prompt:p2", "prompt:n1", "complete"]);
    expect(movedOutline).toEqual(outline(await replay(plain)));
  });

  test("the relocation can arrive on the request rather than argv", async () => {
    const { a, b } = dirs();
    const own = forkEntries(a, b, turn("n1", "what was the word?", "msg_n1", b, SID));
    const m = manager(b, {
      [jsonlPathFor(ROOT, a, PARENT_ID)]: jsonl(parentEntries(a)),
      [jsonlPathFor(ROOT, b, SID)]: jsonl(own),
    });
    expect(
      outline(await replay(m, { parentSessionId: PARENT_ID, fromDir: a, toDir: b })),
    ).toEqual(["prompt:p1", "prompt:p2", `moved:${a}->${b}`, "prompt:n1", "complete"]);
  });

  test("no relocation: no divider", async () => {
    const { a, b } = dirs();
    const own = forkEntries(a, b, turn("n1", "what was the word?", "msg_n1", b, SID));
    const m = manager(b, { [jsonlPathFor(ROOT, b, SID)]: jsonl(own) });
    expect(outline(await replay(m)).some((s) => s.startsWith("moved:"))).toBe(false);
  });
});
