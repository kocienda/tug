// Mid-turn-replay Step 5.6:
// pending-row replay. The load-bearing implementation of the never-drop
// guarantee from [DM08]. tugcode's `runReplay` queries the submission
// journal (via the cross-process bun:sqlite handle) and emits a
// synthetic `add_user_message` for every pending row whose id — the
// submission's id — claude has not written down in the JSONL, as a
// turn opener's `uuid` or an absorbed message's `source_uuid`. The synthetic
// emit happens BETWEEN the translator's `replay_started` and its first
// subsequent emit so the reducer's
// `phase: replaying` guard accepts the frame.

import { ClaudeHome } from "../claude-home.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { unwrapReplayBatches } from "./capture-ipc.ts";
import { mkdtempSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  type JsonlReadResult,
  SessionManager,
  buildContentBlocksFromLegacyJournal,
  extractSubmissionIds,
  jsonlPathFor,
} from "../session.ts";
import type {
  OutboundMessage,
  ReplayComplete,
  ReplayStarted,
  AddUserMessage,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let TMP_ROOT: string;

beforeAll(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), "step-5-6-"));
});

afterAll(() => {
  // Best-effort cleanup. Per-test sqlite files are tiny and the OS will
  // sweep /tmp on its own; no need to recurse-delete the tree.
});

function freshFixture(): {
  sessionId: string;
  projectDir: string;
  sessionsDbPath: string;
  jsonlPath: string;
  claudeProjectsRoot: string;
} {
  const sessionId = crypto.randomUUID();
  const projectDir = `/tmp/step-5-6-proj-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const sessionsDbPath = join(TMP_ROOT, `sessions-${sessionId}.db`);
  const claudeProjectsRoot = join(TMP_ROOT, `claude-projects-${sessionId}`);
  const jsonlPath = jsonlPathFor(
    ClaudeHome.at(claudeProjectsRoot),
    projectDir,
    sessionId,
  );
  mkdirSync(dirname(jsonlPath), { recursive: true });
  return { sessionId, projectDir, sessionsDbPath, jsonlPath, claudeProjectsRoot };
}

/** Seed the submission journal with the narrowed Step 5.2 schema and
 *  insert pending rows. Schema mirrors `bootstrap_schema` in
 *  `tugrust/crates/tugcast/src/session_ledger.rs`. */
function seedJournal(
  sessionsDbPath: string,
  rows: Array<{
    journal_id: string;
    session_id: string;
    user_text: string;
    user_attachments?: object[];
    created_at: number;
  }>,
): void {
  const db = new Database(sessionsDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id        TEXT PRIMARY KEY,
      workspace_key     TEXT NOT NULL,
      project_dir       TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      last_used_at      INTEGER NOT NULL,
      turn_count        INTEGER NOT NULL DEFAULT 0,
      last_user_prompt  TEXT,
      state             TEXT NOT NULL,
      card_id           TEXT
    );
    CREATE TABLE IF NOT EXISTS turns (
      journal_id        TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL,
      user_text         TEXT NOT NULL,
      user_attachments  BLOB NOT NULL,
      created_at        INTEGER NOT NULL
    );
  `);
  const insert = db.prepare(
    `INSERT INTO turns (journal_id, session_id, user_text, user_attachments, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const encoder = new TextEncoder();
  for (const row of rows) {
    const blob = encoder.encode(JSON.stringify(row.user_attachments ?? []));
    insert.run(
      row.journal_id,
      row.session_id,
      row.user_text,
      blob,
      row.created_at,
    );
  }
  db.close();
}

/** Capture stdout writes during a SessionManager run. */
async function captureStdout(
  fn: () => Promise<void>,
): Promise<{ emitted: OutboundMessage[] }> {
  const captured: OutboundMessage[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  // deno-lint-ignore no-explicit-any
  (Bun as unknown as { write: typeof Bun.write }).write = ((
    dest: unknown,
    data: unknown,
  ) => {
    if (dest === Bun.stdout) {
      let text = "";
      if (typeof data === "string") text = data;
      else if (data instanceof Uint8Array) text = decoder.decode(data);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          try {
            captured.push(JSON.parse(trimmed) as OutboundMessage);
          } catch {
            // ignore
          }
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
  return { emitted: unwrapReplayBatches(captured) };
}

function makeManager(
  fx: ReturnType<typeof freshFixture>,
  jsonl: string | null,
): SessionManager {
  const jsonlReader = async (): Promise<JsonlReadResult> => {
    if (jsonl === null) {
      return { kind: "missing", message: "no JSONL for this fixture" };
    }
    return { kind: "ok", jsonl };
  };
  return new SessionManager(fx.projectDir, fx.sessionId, "resume", undefined, {
    claudeHome: ClaudeHome.at(fx.claudeProjectsRoot),
    jsonlReader,
    sessionsDbPath: fx.sessionsDbPath,
    replayTimeoutMs: 5_000,
  });
}

function userJsonlEntry(text: string, uuid?: string): string {
  return JSON.stringify({
    type: "user",
    ...(uuid !== undefined ? { uuid } : {}),
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

/** A message claude absorbed into a running turn, as claude records it. */
function queuedCommandJsonlEntry(text: string, sourceUuid: string): string {
  return JSON.stringify({
    type: "attachment",
    uuid: `att-${sourceUuid}`,
    attachment: {
      type: "queued_command",
      prompt: [{ type: "text", text }],
      source_uuid: sourceUuid,
      commandMode: "prompt",
    },
  });
}

function assistantJsonlEntry(opts: { msgId: string; text: string }): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: opts.msgId,
      stop_reason: "end_turn",
      content: [{ type: "text", text: opts.text }],
    },
  });
}

// ---------------------------------------------------------------------------
// extractSubmissionIds — pure helper unit tests
// ---------------------------------------------------------------------------

describe("extractSubmissionIds", () => {
  test("empty JSONL yields no ids", () => {
    expect(extractSubmissionIds("").size).toBe(0);
  });

  test("a turn opener's uuid is a submission id", () => {
    expect([...extractSubmissionIds(userJsonlEntry("hello", "s-1"))]).toEqual(["s-1"]);
  });

  test("an absorbed message's source_uuid is a submission id", () => {
    expect([...extractSubmissionIds(queuedCommandJsonlEntry("steer", "s-2"))]).toEqual(["s-2"]);
  });

  test("other attachments and other record types contribute nothing", () => {
    const jsonl = [
      JSON.stringify({ type: "attachment", uuid: "a-1", attachment: { type: "environment" } }),
      JSON.stringify({ type: "queue-operation", operation: "enqueue", commandUuid: "s-3" }),
      assistantJsonlEntry({ msgId: "m1", text: "reply" }),
    ].join("\n");
    expect(extractSubmissionIds(jsonl).size).toBe(0);
  });

  test("malformed JSON lines are skipped silently", () => {
    const jsonl = ["{not-json", userJsonlEntry("survived", "s-4")].join("\n");
    expect([...extractSubmissionIds(jsonl)]).toEqual(["s-4"]);
  });
});

// ---------------------------------------------------------------------------
// runReplay — pending-row injection
// ---------------------------------------------------------------------------

describe("runReplay — pending-row injection", () => {
  // tugcast journals a told submission's text *with* its trailing
  // `tug:landings` block, and the JSONL records the two as separate text
  // blocks. The match compares concatenations, so the row must be found;
  // when it is not, the synthetic carries the block as its own block.
  const LANDINGS_BLOCK =
    "<!-- tug:landings -->\n" +
    "Since your last turn (the user's acts; your view of the tree may be stale):\n" +
    "- pushed main → origin/main · 1 commit(s) · aaaaaaaaaa..bbbbbbbbbb — the upstream now has these commits";

  test("a told submission already in the JSONL emits NO synthetic", async () => {
    const fx = freshFixture();
    seedJournal(fx.sessionsDbPath, [
      {
        journal_id: "j-told",
        session_id: fx.sessionId,
        user_text: "hello" + LANDINGS_BLOCK,
        created_at: 1_000,
      },
    ]);
    const jsonl = [
      JSON.stringify({
        type: "user",
        uuid: "j-told",
        message: {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: LANDINGS_BLOCK },
          ],
        },
      }),
      assistantJsonlEntry({ msgId: "msg_01TOLD", text: "ack" }),
    ].join("\n");
    const manager = makeManager(fx, jsonl);

    const { emitted } = await captureStdout(() => manager.runReplay());

    const replays = emitted.filter(
      (m): m is AddUserMessage => m.type === "add_user_message",
    );
    expect(replays).toHaveLength(1);
  });

  test("a told submission not yet in the JSONL emits a synthetic with the block split out", async () => {
    const fx = freshFixture();
    seedJournal(fx.sessionsDbPath, [
      {
        journal_id: "j-told-pending",
        session_id: fx.sessionId,
        user_text: "hello" + LANDINGS_BLOCK,
        created_at: 1_000,
      },
    ]);
    const manager = makeManager(fx, "");

    const { emitted } = await captureStdout(() => manager.runReplay());

    const synthetics = emitted.filter(
      (m): m is AddUserMessage => m.type === "add_user_message",
    );
    expect(synthetics).toHaveLength(1);
    expect(synthetics[0].content.map((b) => (b as any).text)).toEqual([
      "hello",
      LANDINGS_BLOCK,
    ]);
  });

  test("pending row claude has not written down emits a synthetic carrying its id", async () => {
    const fx = freshFixture();
    seedJournal(fx.sessionsDbPath, [
      {
        journal_id: "j-only",
        session_id: fx.sessionId,
        user_text: "submission claude never saw",
        created_at: 1_000,
      },
    ]);
    // JSONL is empty (or missing — both write down no submission).
    const manager = makeManager(fx, "");

    const { emitted } = await captureStdout(() => manager.runReplay());

    const synthetics = emitted.filter(
      (m): m is AddUserMessage => m.type === "add_user_message",
    );
    expect(synthetics).toHaveLength(1);
    expect((synthetics[0].content[0] as any).text).toBe("submission claude never saw");
    expect(synthetics[0].submissionId).toBe("j-only");
    // The synthetic lands inside the `replay_started` /
    // `replay_complete` bracket — the reducer's
    // `handleAddUserMessage` phase guard requires `replaying`.
    const types = emitted.map((m) => m.type);
    const startedIdx = types.indexOf("replay_started");
    const syntheticIdx = types.indexOf("add_user_message");
    const completeIdx = types.indexOf("replay_complete");
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(syntheticIdx).toBeGreaterThan(startedIdx);
    expect(completeIdx).toBeGreaterThan(syntheticIdx);
  });

  test("pending row whose id opens a JSONL turn emits NO synthetic", async () => {
    const fx = freshFixture();
    seedJournal(fx.sessionsDbPath, [
      {
        journal_id: "j-acked",
        session_id: fx.sessionId,
        user_text: "claude saw this",
        created_at: 1_000,
      },
    ]);
    const jsonl = [
      userJsonlEntry("claude saw this", "j-acked"),
      assistantJsonlEntry({ msgId: "msg_01ACK", text: "ack" }),
    ].join("\n");
    const manager = makeManager(fx, jsonl);

    const { emitted } = await captureStdout(() => manager.runReplay());

    // The JSONL pass emits one add_user_message (for the JSONL user
    // entry), carrying the submission's id; the journal-driven synthetic
    // does NOT fire because the row's id is written down.
    const replays = emitted.filter(
      (m): m is AddUserMessage => m.type === "add_user_message",
    );
    expect(replays).toHaveLength(1);
    expect((replays[0].content[0] as any).text).toBe("claude saw this");
    expect(replays[0].submissionId).toBe("j-acked");
  });

  test("a message absorbed mid-turn renders once: the JSONL's copy, no synthetic", async () => {
    // The turn is still running when the catch-up reads the JSONL: the
    // opener and the absorbed message are both written down, and both rows
    // are still pending, since only the turn's end consumes them. Matching by
    // text missed the absorbed one — it has no `user` line — and rendered it
    // a second time on every catch-up during the turn.
    const fx = freshFixture();
    seedJournal(fx.sessionsDbPath, [
      { journal_id: "j-opener", session_id: fx.sessionId, user_text: "do the thing", created_at: 1_000 },
      { journal_id: "j-steer", session_id: fx.sessionId, user_text: "and mention zebras", created_at: 2_000 },
    ]);
    const jsonl = [
      userJsonlEntry("do the thing", "j-opener"),
      queuedCommandJsonlEntry("and mention zebras", "j-steer"),
    ].join("\n");
    const manager = makeManager(fx, jsonl);

    const { emitted } = await captureStdout(() => manager.runReplay());

    const replays = emitted.filter(
      (m): m is AddUserMessage => m.type === "add_user_message",
    );
    expect(replays.map((r) => r.submissionId)).toEqual(["j-opener", "j-steer"]);
  });

  test("multiple pending rows, partial JSONL match: synthetic fires only for the unwritten", async () => {
    const fx = freshFixture();
    seedJournal(fx.sessionsDbPath, [
      {
        journal_id: "j-acked",
        session_id: fx.sessionId,
        user_text: "claude saw",
        created_at: 1_000,
      },
      {
        journal_id: "j-pending",
        session_id: fx.sessionId,
        user_text: "claude has not seen",
        created_at: 2_000,
      },
    ]);
    const jsonl = [
      userJsonlEntry("claude saw", "j-acked"),
      assistantJsonlEntry({ msgId: "msg_01SAW", text: "ok" }),
    ].join("\n");
    const manager = makeManager(fx, jsonl);

    const { emitted } = await captureStdout(() => manager.runReplay());

    const replays = emitted.filter(
      (m): m is AddUserMessage => m.type === "add_user_message",
    );
    // Two replays total: one for the written row (from the JSONL pass)
    // and one synthetic for the unwritten row.
    expect(replays).toHaveLength(2);
    const synthetic = replays.find((r) => (((r as any).content?.[0]) as any)?.text === "claude has not seen");
    expect(synthetic?.submissionId).toBe("j-pending");
  });

  test("duplicate user_text — the id, not the text, says which row claude wrote down", async () => {
    // JSONL holds the second "hello"; the journal holds both. The first,
    // which claude never wrote down, is the one that emits a synthetic.
    const fx = freshFixture();
    seedJournal(fx.sessionsDbPath, [
      {
        journal_id: "j-first",
        session_id: fx.sessionId,
        user_text: "hello",
        created_at: 1_000,
      },
      {
        journal_id: "j-second",
        session_id: fx.sessionId,
        user_text: "hello",
        created_at: 2_000,
      },
    ]);
    const jsonl = [
      userJsonlEntry("hello", "j-second"),
      assistantJsonlEntry({ msgId: "msg_01HELLO", text: "hi" }),
    ].join("\n");
    const manager = makeManager(fx, jsonl);

    const { emitted } = await captureStdout(() => manager.runReplay());

    const replays = emitted.filter(
      (m): m is AddUserMessage => m.type === "add_user_message",
    );
    expect(replays.map((r) => r.submissionId).sort()).toEqual(["j-first", "j-second"]);
  });

  test("attachments round-trip from journal BLOB to synthetic frame as content blocks", async () => {
    // Step 5c: the synthetic frame's `content` must match what
    // `buildContentBlocksFromLegacyJournal` produces from the journal
    // row's text + attachments columns. This is the never-drop
    // gap-bridge path's contract — the synthetic frame's shape
    // matches the JSONL-replay path's shape (modulo the lossy
    // text-first interleaving that the journal's flat columns can't
    // preserve).
    //
    // Inline attachments are images-only per the Claude Agent SDK's
    // user-message input pipeline; this test uses an image attachment.
    const fx = freshFixture();
    const attachments = [
      { filename: "f.png", content: "aGVsbG8=", media_type: "image/png" },
    ];
    seedJournal(fx.sessionsDbPath, [
      {
        journal_id: "j-att",
        session_id: fx.sessionId,
        user_text: "with file",
        user_attachments: attachments,
        created_at: 1_000,
      },
    ]);
    const manager = makeManager(fx, "");

    const { emitted } = await captureStdout(() => manager.runReplay());

    const synthetic = emitted.find(
      (m): m is AddUserMessage =>
        m.type === "add_user_message" && ((m as any).content?.[0] as any)?.text === "with file",
    );
    expect(synthetic).toBeDefined();
    // Pin the exact content-block shape: matches the helper's output
    // for the same (text, attachments) input. Text-first then
    // attachment content — the journal's flat columns lost the
    // original interleaving, and the helper's projection is
    // text-first-then-attachments by design.
    const expectedContent = buildContentBlocksFromLegacyJournal("with file", attachments);
    expect(synthetic?.content).toEqual(expectedContent as never);
  });

  test("session with no journal rows: no synthetic; replay completes cleanly", async () => {
    const fx = freshFixture();
    seedJournal(fx.sessionsDbPath, []); // creates schema, no rows
    const manager = makeManager(fx, "");

    const { emitted } = await captureStdout(() => manager.runReplay());

    const types = emitted.map((m) => m.type);
    expect(types).toContain("replay_started");
    expect(types).toContain("replay_complete");
    expect(emitted.find((m) => m.type === "add_user_message")).toBeUndefined();
  });

  // ─── never-drop smoke (the gate) ─────────────────────────────────────────

  test("NEVER-DROP SMOKE: journal-only submission renders as synthetic across N=20 runs (the DM08 gate)", async () => {
    // Load-bearing proof for [DM08]'s never-drop guarantee:
    // tugdeck submits "hello" → tugcast inserts journal row + forwards
    // → simulate tugcode crash before claude writes JSONL → restart
    // tugcode → runReplay → assert "hello" is on the wire as a
    // synthetic add_user_message. Repeated N=20 to pin determinism.
    for (let i = 0; i < 20; i++) {
      const fx = freshFixture();
      seedJournal(fx.sessionsDbPath, [
        {
          journal_id: `j-smoke-${i}`,
          session_id: fx.sessionId,
          user_text: "hello",
          created_at: 1_000 + i,
        },
      ]);
      const manager = makeManager(fx, null); // JSONL missing
      const { emitted } = await captureStdout(() => manager.runReplay());

      const synthetic = emitted.find(
        (m): m is AddUserMessage =>
          m.type === "add_user_message" && ((m as any).content?.[0] as any)?.text === "hello",
      );
      expect(synthetic).toBeDefined();

      // Bracket order: replay_started → add_user_message → replay_complete.
      const types = emitted.map((m) => m.type);
      const startedIdx = types.indexOf("replay_started");
      const syntheticIdx = types.indexOf("add_user_message");
      const completeIdx = types.indexOf("replay_complete");
      expect(startedIdx).toBeGreaterThanOrEqual(0);
      expect(syntheticIdx).toBeGreaterThan(startedIdx);
      expect(completeIdx).toBeGreaterThan(syntheticIdx);

      // replay_complete carries the JSONL-pass turn count (zero here —
      // no committed turns in JSONL); the synthetic does NOT contribute
      // to count because no terminal event was emitted for it.
      const complete = emitted.find(
        (m): m is ReplayComplete => m.type === "replay_complete",
      );
      expect(complete).toBeDefined();
      expect(complete?.count).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Bracket-window invariant
// ---------------------------------------------------------------------------

describe("runReplay — bracket-window invariant for synthetic emit", () => {
  test("synthetic never lands before replay_started or after replay_complete", async () => {
    const fx = freshFixture();
    seedJournal(fx.sessionsDbPath, [
      {
        journal_id: "j-bracket",
        session_id: fx.sessionId,
        user_text: "bracket-test",
        created_at: 1_000,
      },
    ]);
    const manager = makeManager(fx, "");
    const { emitted } = await captureStdout(() => manager.runReplay());

    // Find indices of bracket events.
    const startedIdx = emitted.findIndex(
      (m): m is ReplayStarted => m.type === "replay_started",
    );
    const completeIdx = emitted.findIndex(
      (m): m is ReplayComplete => m.type === "replay_complete",
    );
    const syntheticIdx = emitted.findIndex(
      (m): m is AddUserMessage =>
        m.type === "add_user_message" && ((m as any).content?.[0] as any)?.text === "bracket-test",
    );
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(startedIdx);
    expect(syntheticIdx).toBeGreaterThan(startedIdx);
    expect(syntheticIdx).toBeLessThan(completeIdx);
  });
});
