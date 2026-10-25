/**
 * sc-session-card.test.ts — the site's session-card still: one tall Session
 * card, top to bottom, in the middle of a turn. The turn is a REAL one from
 * this checkout's history — the second turn of the `workspace-xp` session —
 * replayed into the card from its transcript, frame by frame, and stopped
 * part way through with a tool call open, so the still shows the card at
 * work: the state cell streaming, the time counting, the context figure
 * standing, and the wave under the last block.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that the still was written. Run by path, once per
 * mode (`_site-clips.ts` has the invocation); skips unless the runner and
 * both site variables are set.
 *
 * The scene is built the way `sc-inline-dialog.test.ts` builds its turn: a
 * card bound synthetically, the prompt sent, then the turn's frames ingested
 * on the code feed. The frames are derived from the session's own `.jsonl`
 * rows — each assistant row's thinking, tool_use and text blocks, each
 * tool_result row's output, with the gap between a call and its result
 * replayed from the rows' timestamps (capped, so the scene stays short) —
 * up to {@link STOP_AFTER}, past which the {@link OPEN_CALL}th tool call is
 * left open. The session's name and synopsis are published onto the
 * masthead as this checkout's ledger holds them, the model and Claude Code
 * version as the session's metadata row holds them. During a turn the
 * masthead's two lower lines are the Observer's: its current line for the
 * turn, and its newest post about the session. Both are published, in the
 * Observer's register and from the turn's own account of its work, over the
 * digester's `ask` and `said` beats that say a turn is in flight — a
 * synthetic card has neither digester nor Observer writing.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { note, type App } from "../_harness";
import { ClaudeHome } from "../_harness/claude-home";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { CODE_OUTPUT_FEED } from "../arc-run-transcript-fixture";
import { MODE, RUNS, contentSize, cropAround, launchForMode, outDirFor, standIns, stillTo } from "./_site-clips";

const TEST_TIMEOUT_MS = 300_000;
/** This checkout — whose history the session comes from. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", "..", ".."));
const CARD = "sc-session-card";
const PROJECT_NAME = "tug";
/** `workspace-xp`: a workspace-switch bug diagnosed and fixed in two turns, with a cache refresher added in the second. */
const SESSION_ID = "df121055-c014-4f54-bb50-117d0f6fcd69";
/** The session's identity as this checkout's ledger holds it: the name the user gave it, its callsign, and the Observer's synopsis. */
const IDENTITY = { name: "workspace-xp", name_user_set: true, tag: "docile-knoll", synopsis: "Repair session labels changing when workspaces switch" };
/** The session's model and Claude Code version, as its metadata row holds them; `[1m]` is the extended window the row's usage ran in. */
const METADATA = { model: "claude-opus-5-5[1m]", version: "2.1.285", permissionMode: "auto" };
/** The Observer's current line for the turn, and its post about the session, both from the turn's own closing account. */
const CURRENT = "Keep the bindings cache current while the app runs";
const POST = "^workspace-xp is wiring a refresher into the shell: a session_updated push the bindings cache disagrees with asks the server again.";
/** The second turn's prompt, as the row holds it. */
const PROMPT_MARK = "Of course I do!";
/** The last prose the replay plays whole. */
const STOP_AFTER = "One-shot, so a refresh answer";
/** Which tool call after {@link STOP_AFTER} is left open: the first runs to its result, the second stays running. */
const OPEN_CALL = 2;

/** A tall, narrow window: the one-up fits the card to it. */
const CONTENT_SIZE = { width: 760, height: 1720 };
const SETTLE_MS = 1_500;
/** The gap between a call and its result: the rows' own, within these. */
const GAP_MIN_MS = 150;
const GAP_MAX_MS = 900;
const FRAME_MS = 40;
/** A result's output is cut here: the blocks are collapsed in the still, and a whole file listing is more than the feed takes in one frame. */
const OUTPUT_CAP = 1_200;
/** Rows the replay will walk past the prompt before giving up on {@link STOP_AFTER}. */
const ROW_CAP = 120;

const EDITOR = '[data-slot="tug-text-editor"] .cm-content';

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
interface Row {
  type?: string;
  timestamp?: string;
  message?: { id?: string; content?: Block[] | string; usage?: Record<string, number> };
}

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: `${CARD}-pane`,
        position: { x: 20, y: 20 },
        size: { width: 720, height: 1680 },
        cardIds: [CARD],
        activeCardId: CARD,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${CARD}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The session's rows, from the user's own Claude home (see `sc-deck.test.ts`). */
function rows(): Row[] {
  const from = join(ClaudeHome.resolve(undefined, homedir()).projectDir(CHECKOUT), `${SESSION_ID}.jsonl`);
  return readFileSync(from, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Row);
}

const blocksOf = (row: Row): Block[] => (Array.isArray(row.message?.content) ? row.message!.content : []);
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof (c as Block).text === "string" ? (c as Block).text : "")).join("\n")
      : "";
const at = (row: Row): number => (typeof row.timestamp === "string" ? Date.parse(row.timestamp) : 0);

function ingest(app: App, decoded: Record<string, unknown>): Promise<unknown> {
  return app.driveSession(CARD, {
    op: "ingestFrame",
    feedId: CODE_OUTPUT_FEED,
    decoded: { tug_session_id: SESSION_ID, ipc_version: 2, ...decoded },
  });
}

/**
 * Replay the second turn from its prompt row up to {@link STOP_AFTER}, and
 * leave the call after it open. Returns what was played, for the notes.
 */
async function replay(app: App, all: Row[]): Promise<{ prompt: string; calls: number; openCall: string | null; said: string }> {
  const start = all.findIndex((r) => r.type === "user" && textOf(r.message?.content).includes(PROMPT_MARK));
  expect(start, "the second turn's prompt row").toBeGreaterThan(0);
  const prompt = textOf(all[start]!.message?.content);

  await app.driveSession(CARD, { op: "send", text: prompt });
  note("sc-session-card: prompt sent");
  await ingest(app, { type: "prompt_anchor", promptUuid: "sc-session-card-p2" });
  await ingest(app, { type: "session_init", session_id: SESSION_ID });
  await app.body(CARD).waitForCondition<boolean>(
    `Array.from(document.querySelectorAll(".tug-transcript-entry")).some((el) => (el.textContent || "").includes(${JSON.stringify(PROMPT_MARK)}))`,
    { timeoutMs: 10_000 },
  );
  note("sc-session-card: prompt row rendered");

  let seq = 1;
  let calls = 0;
  let openCall: string | null = null;
  let openedAt = 0;
  let said = "";
  let callsPastStop = 0;
  for (const [n, row] of all.slice(start + 1, start + 1 + ROW_CAP).entries()) {
    note(`sc-session-card: row ${n} ${row.type ?? "?"} blocks=${blocksOf(row).map((b) => b.type).join(",")}`);
    if (row.type === "assistant") {
      const msgId = row.message?.id ?? `sc-session-card-m${seq}`;
      const usage = row.message?.usage;
      if (usage !== undefined) await ingest(app, { type: "streaming_usage", msg_id: msgId, usage });
      for (const [i, b] of blocksOf(row).entries()) {
        if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking !== "") {
          await ingest(app, { type: "content_block_start", msg_id: msgId, block_index: i, kind: "thinking" });
          await ingest(app, { type: "thinking_text", msg_id: msgId, block_index: i, seq: seq++, rev: 0, text: b.thinking, is_partial: false, status: "complete" });
        } else if (b.type === "text" && typeof b.text === "string" && b.text !== "") {
          await ingest(app, { type: "content_block_start", msg_id: msgId, block_index: i, kind: "text" });
          await ingest(app, { type: "assistant_text", msg_id: msgId, block_index: i, seq: seq++, rev: 0, text: b.text, is_partial: false, status: "complete" });
          said = b.text;
        } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          await ingest(app, { type: "tool_use", msg_id: msgId, seq: seq++, tool_name: b.name, tool_use_id: b.id, input: b.input ?? {} });
          calls += 1;
          openCall = b.id;
          openedAt = at(row);
          if (said.startsWith(STOP_AFTER) && ++callsPastStop === OPEN_CALL) {
            for (let n = 1; n <= 3; n++) {
              await Bun.sleep(300);
              await ingest(app, { type: "tool_progress", tool_use_id: b.id, tool_name: b.name, elapsed_time_seconds: n, parent_tool_use_id: null });
            }
            return { prompt, calls, openCall, said };
          }
        }
        await Bun.sleep(FRAME_MS);
      }
    } else if (row.type === "user") {
      for (const b of blocksOf(row)) {
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const gap = Math.min(GAP_MAX_MS, Math.max(GAP_MIN_MS, at(row) - openedAt));
        await Bun.sleep(gap);
        const output = textOf(b.content);
        note(`sc-session-card: result for ${b.tool_use_id}, ${output.length} chars`);
        await ingest(app, { type: "tool_result", tool_use_id: b.tool_use_id, output: output.slice(0, OUTPUT_CAP), is_error: b.is_error === true });
        note(`sc-session-card: result ingested`);
        if (openCall === b.tool_use_id) openCall = null;
      }
    }
  }
  return { prompt, calls, openCall, said };
}

describe.skipIf(!RUNS)("site still: the session card", () => {
  test(
    "records one real turn replayed into a tall card and stopped mid-work",
    async () => {
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sc-session-card-")));
      onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
      const projectDir = join(scratch, PROJECT_NAME);
      mkdirSync(projectDir);
      const all = rows();

      const app = await launchForMode("sc-session-card", deck(), undefined, { contentSize: CONTENT_SIZE });
      try {
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD)})`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession(CARD, { tugSessionId: SESSION_ID, projectDir, workspaceKey: projectDir });
        note("sc-session-card: bound");
        await app.awaitEngineReady(CARD, { timeoutMs: 30_000 });
        note("sc-session-card: engine ready");
        await app.ingestSessionMetadata(CARD, { type: "system_metadata", cwd: projectDir, ...METADATA, ipc_version: 2 });
        await Bun.sleep(800);

        // The identity the real ledger holds for it, delivered the way the
        // wire does (at0570).
        await app.body(CARD).evalJS<boolean>(
          `window.__tug.publishSessionUpdated(${JSON.stringify(JSON.stringify({ session_id: SESSION_ID, fields: IDENTITY }))})`,
        );
        await app.body(CARD).nativeClickAtElement(EDITOR);
        await Bun.sleep(400);

        const played = await replay(app, all);
        // The digester's beats for the turn — the ask it opened on, and the
        // last prose — and the Observer's post, which the live line shows.
        const digest = (text: string, beat: number, kind: string) =>
          app.body(CARD).evalJS<boolean>(
            `window.__tug.publishDigestFrame(${JSON.stringify(JSON.stringify({ type: "digest", text, scopes: [SESSION_ID], beat, at: Date.now(), kind }))})`,
          );
        await digest(`asked: ${played.prompt.replace(/\s+/g, " ").trim()}`, 1, "ask");
        await digest(played.said, played.calls + 1, "said");
        const postTaken = await app.body(CARD).evalJS<boolean>(
          `window.__tug.publishOverviewPost(${JSON.stringify(
            JSON.stringify({ id: 9101, at_ms: Date.now() - 20_000, author: "observer", body: POST, refs: [], session_id: SESSION_ID, wake_reason: "sitrep", project_dir: projectDir }),
          )})`,
        );
        note(`sc-session-card: post taken=${String(postTaken)}`);
        await app.body(CARD).evalJS<boolean>(
          `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify({ kind: "session_current", session_id: SESSION_ID, at_ms: Date.now(), current: CURRENT }))})`,
        );
        await Bun.sleep(SETTLE_MS);

        const rest = await standIns(app);
        expect(rest[CARD], "the card stands in its slot").toBeDefined();
        const crop = cropAround([rest[CARD]!], 0, await contentSize(app));
        const { scale } = await stillTo(app, crop, join(outDirFor("session-card"), "still.png"));
        const phase = await app.body(CARD).evalJS<string | null>(
          `(function(){ var e = document.querySelector('[data-slot="tug-prompt-entry"]'); return e === null ? null : e.getAttribute("data-phase"); })()`,
        );
        writeFileSync(
          join(outDirFor("session-card"), "reading.json"),
          JSON.stringify({ clip: "session-card", mode: MODE, scale, crop, contentSize: CONTENT_SIZE, phase, ...played }, null, 2),
        );
        expect(scale, "a still was written at the window's scale").toBeGreaterThan(0);
        expect(played.openCall, "the turn stands on an open call").not.toBeNull();
        expect(phase, "the card is in a turn, on an open call").toBe("tool_work");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
