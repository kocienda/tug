// Lineage-aware restore ([P10]). An arc spreads one line of work across a
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
//
// And the wheel's authorship across the whole restore: one record of what the
// wheel put on the wire, read from `sessions.db` and spent as the lineage's
// files are walked in order.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unwrapReplayBatches } from "./capture-ipc.ts";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

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
function makeManager(
  files: Record<string, string>,
  sessionsDbPath?: string,
): SessionManager {
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
    ...(sessionsDbPath === undefined ? {} : { sessionsDbPath }),
  });
}

/**
 * A `sessions.db` holding what tugcast's wheel wrote — the real cross-process
 * read, on a real sqlite file, not a stand-in for one.
 *
 * The columns are the contract between `SessionLedger::record_wheel_prompt`
 * and `readWheelPromptsForLine`: prompts are filed against a LINE, and the
 * reader resolves the line from whichever session id it was resumed under.
 */
function sessionsDbWithWheelPrompts(sent: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "replay-lineage-db-")), "sessions.db");
  const db = new Database(path, { create: true });
  db.run(
    `CREATE TABLE sessions (session_id TEXT PRIMARY KEY, line_id TEXT NOT NULL)`,
  );
  // The pending-submission journal the same handle reads on every replay.
  db.run(
    `CREATE TABLE turns (journal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
       user_text TEXT NOT NULL, user_attachments BLOB NOT NULL,
       created_at INTEGER NOT NULL)`,
  );
  db.run(
    `CREATE TABLE wheel_prompts (
       prompt_id TEXT PRIMARY KEY, line_id TEXT NOT NULL,
       session_id TEXT NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL)`,
  );
  // Both segments of the arc are one line — the same shape a rotation leaves.
  for (const id of [PARENT_ID, STAGE_ID]) {
    db.run(`INSERT INTO sessions VALUES (?, 'line-1')`, [id]);
  }
  sent.forEach((text, i) => {
    db.run(`INSERT INTO wheel_prompts VALUES (?, 'line-1', ?, ?, ?)`, [
      `w${i}`,
      PARENT_ID,
      text,
      i,
    ]);
  });
  db.close();
  return path;
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
    document: ".tug/arcs/foo/brief.md",
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
      expect(divider.document).toBe(".tug/arcs/foo/brief.md");
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

  test("marks the prompts tugcast recorded the Wheel sending, wherever in the lineage they are", async () => {
    // One ledger walks the whole restore: the ancestor's file first, then the
    // resumed session's. The wheel opened the ancestor and sent another prompt
    // downstream, and both come back under the wheel's name — which is what a
    // record buys over reading a prompt's position, where only the first could.
    const manager = makeManager({
      [PARENT_ID]: jsonlFor("write the plan", "here is the plan"),
      [STAGE_ID]: jsonlFor("now do this other thing", "done"),
    }, sessionsDbWithWheelPrompts(["write the plan", "now do this other thing"]));
    const frames = await captureStdout(() =>
      manager.runReplay(undefined, [
        {
          sessionId: PARENT_ID,
          stage: "devise",
          model: "opus",
          document: ".tug/arcs/foo/brief.md",
          arc: "foo",
        },
        { sessionId: STAGE_ID },
      ]),
    );

    const openers = frames.filter((f) => f.type === "add_user_message");
    expect(openers).toHaveLength(2);
    expect(openers.map((f) => (f.type === "add_user_message" ? f.origin : null))).toEqual(
      ["wheel", "wheel"],
    );
  });

  test("a backward page carries no lineage prefix; a recency window still does", async () => {
    // The ancestors replay whole, so once a restore has landed they are all
    // on screen and only the tip has anything older to fetch. A `turnRange`
    // is that fetch, in the tip's own coordinates — re-emitting the prefix
    // would prepend the whole arc above itself and put the transcript's turn
    // count back over the denominator it is counted against.
    const files = {
      [PARENT_ID]: jsonlFor("start the arc", "here is the brief"),
      [STAGE_ID]: [
        jsonlFor("write the plan", "here is the plan"),
        jsonlFor("now revise it", "revised"),
      ].join("\n"),
    };

    const paged = await captureStdout(() =>
      makeManager(files).runReplay({ turnRange: [0, 1] }, LINEAGE),
    );
    expect(shape(paged)).toEqual(["text:here is the plan"]);

    // The same lineage under the restore's own window shape: the ancestors
    // are still what the transcript is built from.
    const restored = await captureStdout(() =>
      makeManager(files).runReplay({ lastTurns: 1 }, LINEAGE),
    );
    expect(shape(restored)).toEqual([
      "text:here is the brief",
      "stage:devise",
      "text:revised",
    ]);
  });

  test("leaves a prompt the record does not hold as the user's own", async () => {
    // The user interjected mid-arc. Their words are in the same file as the
    // wheel's, one turn apart, and nothing about where they sit says whose
    // they are — only the record does.
    const manager = makeManager({
      [PARENT_ID]: jsonlFor("write the plan", "here is the plan"),
      [STAGE_ID]: jsonlFor("now do this other thing", "done"),
    }, sessionsDbWithWheelPrompts(["write the plan"]));
    const frames = await captureStdout(() =>
      manager.runReplay(undefined, [
        { sessionId: PARENT_ID, stage: "devise", model: "opus", arc: "foo" },
        { sessionId: STAGE_ID },
      ]),
    );
    const openers = frames.filter((f) => f.type === "add_user_message");
    expect(openers.map((f) => (f.type === "add_user_message" ? f.origin : null))).toEqual(
      ["wheel", undefined],
    );
  });
});
