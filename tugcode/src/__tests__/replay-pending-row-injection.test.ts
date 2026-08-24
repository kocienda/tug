// Mid-turn-replay [Step 5.6](dash/tugplan-session-mid-turn-replay.md#step-5-6):
// pending-row replay. The load-bearing implementation of the never-drop
// guarantee from [DM08]. tugcode's `runReplay` queries the submission
// journal (via the cross-process bun:sqlite handle) and emits a
// synthetic `add_user_message` for every pending row whose
// `user_text` does not appear as a `user_message` line in JSONL —
// claude has not yet acknowledged those submissions. The synthetic
// emit happens BETWEEN the translator's `replay_started` and its first
// subsequent emit so the reducer's
// `phase: replaying` guard accepts the frame.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { unwrapReplayBatches } from "./capture-ipc.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  type JsonlReadResult,
  SessionManager,
  buildContentBlocksFromLegacyJournal,
  extractUserMessageTextCounts,
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
  const encodedDir = projectDir.replaceAll(/[/.]/g, "-");
  mkdirSync(join(claudeProjectsRoot, encodedDir), { recursive: true });
  const jsonlPath = jsonlPathFor(claudeProjectsRoot, projectDir, sessionId);
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
    claudeProjectsRoot: fx.claudeProjectsRoot,
    jsonlReader,
    sessionsDbPath: fx.sessionsDbPath,
    replayTimeoutMs: 5_000,
  });
}

function userJsonlEntry(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
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
// extractUserMessageTextCounts — pure helper unit tests
// ---------------------------------------------------------------------------

describe("extractUserMessageTextCounts", () => {
  test("empty JSONL yields empty map", () => {
    expect(extractUserMessageTextCounts("").size).toBe(0);
  });

  test("single user-message yields count of 1", () => {
    const jsonl = userJsonlEntry("hello");
    const counts = extractUserMessageTextCounts(jsonl);
    expect(counts.get("hello")).toBe(1);
    expect(counts.size).toBe(1);
  });

  test("duplicate user-messages yield count > 1", () => {
    const jsonl = [userJsonlEntry("hi"), userJsonlEntry("hi")].join("\n");
    expect(extractUserMessageTextCounts(jsonl).get("hi")).toBe(2);
  });

  test("multi-block text concatenates within one entry", () => {
    const entry = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "part-a " },
          { type: "text", text: "part-b" },
        ],
      },
    });
    expect(extractUserMessageTextCounts(entry).get("part-a part-b")).toBe(1);
  });

  test("tool_result entries (also type: 'user') do NOT count", () => {
    const entry = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-1",
            content: "ok",
          },
        ],
      },
    });
    expect(extractUserMessageTextCounts(entry).size).toBe(0);
  });

  test("malformed JSON lines are skipped silently", () => {
    const jsonl = ["{not-json", userJsonlEntry("survived")].join("\n");
    const counts = extractUserMessageTextCounts(jsonl);
    expect(counts.get("survived")).toBe(1);
  });

  test("non-user types are ignored", () => {
    const jsonl = [
      assistantJsonlEntry({ msgId: "m1", text: "reply" }),
      userJsonlEntry("kept"),
    ].join("\n");
    expect(extractUserMessageTextCounts(jsonl).size).toBe(1);
    expect(extractUserMessageTextCounts(jsonl).get("kept")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runReplay — pending-row injection
// ---------------------------------------------------------------------------

describe("runReplay — pending-row injection", () => {
  test("pending row whose user_text is NOT in JSONL emits a synthetic", async () => {
    const fx = freshFixture();
    seedJournal(fx.sessionsDbPath, [
      {
        journal_id: "j-only",
        session_id: fx.sessionId,
        user_text: "submission claude never saw",
        created_at: 1_000,
      },
    ]);
    // JSONL is empty (or missing — both produce no user_message texts).
    const manager = makeManager(fx, "");

    const { emitted } = await captureStdout(() => manager.runReplay());

    const synthetics = emitted.filter(
      (m): m is AddUserMessage => m.type === "add_user_message",
    );
    expect(synthetics).toHaveLength(1);
    expect((synthetics[0].content[0] as any).text).toBe("submission claude never saw");
    // No `msg_id` on `add_user_message` per [D15] — the journal id is
    // not exposed on the wire; identification is by text content.
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

  test("pending row whose user_text IS in JSONL emits NO synthetic", async () => {
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
      userJsonlEntry("claude saw this"),
      assistantJsonlEntry({ msgId: "msg_01ACK", text: "ack" }),
    ].join("\n");
    const manager = makeManager(fx, jsonl);

    const { emitted } = await captureStdout(() => manager.runReplay());

    // The JSONL pass emits one add_user_message (for the JSONL
    // user_message line) and a turn_complete{success}. The
    // journal-driven synthetic does NOT fire because the row matched —
    // only one user-side frame in total. Identification is by text;
    // `add_user_message` carries no `msg_id` per [D15].
    const replays = emitted.filter(
      (m): m is AddUserMessage => m.type === "add_user_message",
    );
    expect(replays).toHaveLength(1);
    expect((replays[0].content[0] as any).text).toBe("claude saw this");
  });

  test("multiple pending rows, partial JSONL match: synthetic fires only for unmatched", async () => {
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
      userJsonlEntry("claude saw"),
      assistantJsonlEntry({ msgId: "msg_01SAW", text: "ok" }),
    ].join("\n");
    const manager = makeManager(fx, jsonl);

    const { emitted } = await captureStdout(() => manager.runReplay());

    const replays = emitted.filter(
      (m): m is AddUserMessage => m.type === "add_user_message",
    );
    // Two replays total: one for the matched row (from the JSONL pass)
    // and one synthetic for the unmatched row. Identification by text
    // — `add_user_message` carries no `msg_id` per [D15].
    expect(replays).toHaveLength(2);
    const synthetic = replays.find((r) => (((r as any).content?.[0]) as any)?.text === "claude has not seen");
    expect(synthetic).toBeDefined();
  });

  test("duplicate user_text — multiset count handles partial JSONL match correctly", async () => {
    // JSONL has 1 occurrence of "hello"; journal has 2. The first
    // pending row matches; the second emits a synthetic.
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
      userJsonlEntry("hello"),
      assistantJsonlEntry({ msgId: "msg_01HELLO", text: "hi" }),
    ].join("\n");
    const manager = makeManager(fx, jsonl);

    const { emitted } = await captureStdout(() => manager.runReplay());

    const replays = emitted.filter(
      (m): m is AddUserMessage => m.type === "add_user_message",
    );
    // 1 from JSONL (the matched "hello") + 1 synthetic (the unmatched
    // "hello" from j-second). Both carry the literal text "hello"; the
    // multiset count IS the contract — under `add_user_message`'s
    // no-`msg_id` shape ([D15]) the synthetic and the JSONL-derived
    // emission are wire-indistinguishable, which is the correct
    // substrate-truth: each "hello" submission gets one row.
    expect(replays).toHaveLength(2);
    expect(replays.every((r) => (((r as any).content?.[0]) as any)?.text === "hello")).toBe(true);
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
