// Lineage-aware restore ([P10]). A dash arc spreads one line of work across a
// JSONL per stage, so a card that replays only the session it resumed shows a
// transcript beginning in the middle. `request_replay` may carry an ordered
// lineage; `runReplay` translates every ancestor in turn, emitting a
// `replay_stage` divider ahead of each session that ran a stage, all inside
// the one `replay_started` / `replay_complete` bracket.
//
// Pins:
//   - a two-entry lineage replays A's turns, then the divider, then B's,
//   - the divider names the stage, model, and document it was given,
//   - a one-entry lineage is byte-identical to no lineage at all — the
//     property that keeps every non-arc card replaying exactly as today,
//   - an unreadable ancestor contributes its divider and no turns rather than
//     failing the replay.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unwrapReplayBatches } from "./capture-ipc.ts";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { type JsonlReadResult, SessionManager } from "../session.ts";
import type { OutboundMessage, ReplayLineageEntry } from "../types.ts";

let TMP_ROOT: string;
let PROJECT_DIR: string;
let CLAUDE_PROJECTS_ROOT: string;

const PARENT_ID = "session-conversation";
const STAGE_ID = "session-devise";

beforeAll(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), "replay-lineage-"));
  PROJECT_DIR = join(TMP_ROOT, "proj");
  CLAUDE_PROJECTS_ROOT = join(TMP_ROOT, "claude-projects");
  mkdirSync(join(CLAUDE_PROJECTS_ROOT, PROJECT_DIR.replaceAll(/[/.]/g, "-")), {
    recursive: true,
  });
});

afterAll(() => {
  // Per-test files are tiny and live under /tmp; the OS sweeps them.
});

function jsonlFor(userText: string, assistantText: string): string {
  return [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: userText }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: `msg-${userText}`,
        stop_reason: "end_turn",
        content: [{ type: "text", text: assistantText }],
      },
    }),
  ].join("\n");
}

/** A reader that answers per claude session id, the way the real one does. */
function makeManager(files: Record<string, string>): SessionManager {
  const jsonlReader = async (path: string): Promise<JsonlReadResult> => {
    for (const [sessionId, jsonl] of Object.entries(files)) {
      if (path.includes(sessionId)) return { kind: "ok", jsonl };
    }
    return { kind: "missing", message: `no JSONL for ${path}` };
  };
  return new SessionManager(PROJECT_DIR, STAGE_ID, "resume", undefined, {
    claudeProjectsRoot: CLAUDE_PROJECTS_ROOT,
    jsonlReader,
    replayTimeoutMs: 5_000,
  });
}

async function captureStdout(fn: () => Promise<void>): Promise<OutboundMessage[]> {
  const captured: OutboundMessage[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  (Bun as unknown as { write: typeof Bun.write }).write = ((
    dest: unknown,
    data: unknown,
  ) => {
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
          captured.push(JSON.parse(trimmed) as OutboundMessage);
        } catch {
          // not a frame — ignore
        }
      }
    }
    return Promise.resolve(
      data instanceof Uint8Array
        ? data.length
        : typeof data === "string"
          ? data.length
          : 0,
    );
  }) as typeof Bun.write;
  try {
    await fn();
    const { drainPendingWrites } = await import("../ipc.ts");
    await drainPendingWrites();
  } finally {
    (Bun as unknown as { write: typeof Bun.write }).write = originalWrite;
  }
  return unwrapReplayBatches(captured);
}

/** The frames that carry text, plus the dividers, as a readable shape. */
function shape(frames: OutboundMessage[]): string[] {
  const out: string[] = [];
  for (const f of frames) {
    if (f.type === "replay_stage") out.push(`stage:${f.stage}`);
    if (f.type === "assistant_text" && f.is_partial === false) {
      out.push(`text:${f.text}`);
    }
  }
  return out;
}

const LINEAGE: ReplayLineageEntry[] = [
  { sessionId: PARENT_ID },
  {
    sessionId: STAGE_ID,
    stage: "devise",
    model: "opus",
    document: "dash/foo-brief.md",
    arc: "foo",
  },
];

describe("runReplay — lineage", () => {
  test("replays the ancestor's turns, then the divider, then this session's", async () => {
    const manager = makeManager({
      [PARENT_ID]: jsonlFor("start the arc", "here is the brief"),
      [STAGE_ID]: jsonlFor("write the plan", "here is the plan"),
    });
    const frames = await captureStdout(() => manager.runReplay(undefined, LINEAGE));

    expect(shape(frames)).toEqual([
      "text:here is the brief",
      "stage:devise",
      "text:here is the plan",
    ]);

    // One bracket, however many JSONLs it read.
    expect(frames.filter((f) => f.type === "replay_started").length).toBe(1);
    expect(frames.filter((f) => f.type === "replay_complete").length).toBe(1);

    const divider = frames.find((f) => f.type === "replay_stage");
    expect(divider).toBeDefined();
    if (divider && divider.type === "replay_stage") {
      expect(divider.model).toBe("opus");
      expect(divider.document).toBe("dash/foo-brief.md");
      expect(divider.arc).toBe("foo");
    }
  });

  test("a one-entry lineage emits exactly what no lineage emits", async () => {
    const files = { [STAGE_ID]: jsonlFor("write the plan", "here is the plan") };
    const withNone = await captureStdout(() =>
      makeManager(files).runReplay(undefined, undefined),
    );
    const withOne = await captureStdout(() =>
      makeManager(files).runReplay(undefined, [
        { sessionId: STAGE_ID, stage: "devise", model: "opus", arc: "foo" },
      ]),
    );
    expect(shape(withOne)).toEqual(shape(withNone));
    expect(withOne.some((f) => f.type === "replay_stage")).toBe(false);
  });

  test("an unreadable ancestor contributes its divider and no turns", async () => {
    // Only this session's JSONL exists; the ancestor's is gone. A restore that
    // shows less history beats one that fails.
    const manager = makeManager({
      [STAGE_ID]: jsonlFor("write the plan", "here is the plan"),
    });
    const frames = await captureStdout(() => manager.runReplay(undefined, LINEAGE));
    expect(shape(frames)).toEqual(["stage:devise", "text:here is the plan"]);
    expect(frames.filter((f) => f.type === "replay_complete").length).toBe(1);
  });

  test("marks the Wheel's opener on the session that ran a stage, and only there", async () => {
    // The ancestor ran a stage; the resumed session did not. So the ancestor's
    // opening prompt is the Wheel's, and every prompt in the resumed session
    // is the user's own — which is the whole distinction the deck used to get
    // from a divider's position.
    const manager = makeManager({
      [PARENT_ID]: jsonlFor("write the plan", "here is the plan"),
      [STAGE_ID]: jsonlFor("now do this other thing", "done"),
    });
    const frames = await captureStdout(() =>
      manager.runReplay(undefined, [
        {
          sessionId: PARENT_ID,
          stage: "devise",
          model: "opus",
          document: "dash/foo-brief.md",
          arc: "foo",
        },
        { sessionId: STAGE_ID },
      ]),
    );

    const openers = frames.filter((f) => f.type === "add_user_message");
    expect(openers).toHaveLength(2);
    expect(openers.map((f) => (f.type === "add_user_message" ? f.origin : null))).toEqual(
      ["wheel", undefined],
    );
  });
});
