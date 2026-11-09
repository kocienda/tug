/**
 * vd-smaller-changes.test.ts — the video's "smaller changes" sequence, timed
 * to the narration in the `vids` repo (`incoming/smaller-changes-audio.wav`):
 * three Session cards on one project, each committing its own work, in two
 * bursts of one launch around a rendered graphic, for a half-width frame.
 *
 * A video tool, not a test of the app: it stages a scene and records it,
 * and its assertions are that frames were written and the three commits
 * landed. It lives beside the site's drivers and shares their helpers and
 * gate (`../site-clips/_site-clips.ts`): run by path, once per mode, with
 * `TUG_SITE_CLIPS_OUT` and `TUG_SITE_CLIPS_MODE` set. The `vids` repo's
 * `tools/shot.py smaller-changes` is the usual caller, and its
 * `tools/assemble.py smaller-changes` lays the bursts and the graphic
 * (`tools/graphic/tangle.html`) under the narration.
 *
 * The scene: a scratch clone of this checkout under a directory named
 * `tug`, and a two-up under Fit with both columns split, so four Session
 * cards stand in a two-by-two grid whose heights the window fixes (under
 * Flow a column grows with its cards and scrolls when a shade opens). Each
 * card is a spawned stub session whose one turn edits two or three files
 * of its own — the session picker, the sparkline, the commit receipt, the
 * arc lifecycle line — played out before the first frame, and the ledger
 * is seeded with the same calls, so each Changes shade lists its session's
 * files and no other's. In seconds of audio:
 *
 *   0.0 – 9.7    burst A: the cards at rest; from "managing change starts
 *                small" ⌃⌘C raises each shade in turn, so all four stand
 *                open through "knowing which session changed what"
 *   9.7 – 24.0   the graphic: before Tug, the tangle (not recorded here)
 *   24.0 – 34.0  burst B: Auto-Message writes each card's commit message,
 *                and at "each session can commit its own work" the four
 *                Commit buttons are pressed in turn; the receipts land
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { TUGCODE_TRANSCRIPT_SCHEMA_VERSION, note } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { pollFor } from "../body-grounding/_frames";
import { kindPane } from "../body-grounding/_kinds";
import { stubDirectory } from "../streaming-stub-fixture";
import { MODE, RUNS, contentSize, expectRecorded, launchForMode, outDirFor, scene, standIns } from "../site-clips/_site-clips";

const TEST_TIMEOUT_MS = 500_000;
const IPC_VERSION = 2;
/** This checkout, cloned for the scene. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", "..", ".."));
/** Where the scratch clone lives: a readable path, since the receipts name the directory. Removed when the run ends. */
const SCRATCH_ROOT = process.env.TUG_VIDS_SCRATCH ?? resolve(CHECKOUT, "..", "scratch");

/** The narration's windows, in seconds of audio. */
const BURST_A_AT = 0.0;
const BURST_A_END = 9.7;
const BURST_B_AT = 24.0;
const BURST_B_END = 34.0;

/** Half a 4K frame's shape: 3080 × 3464 pixels at 2×, scaled to 1920 × 2160 by assemble.py. */
const CONTENT_SIZE = { width: 1540, height: 1732 };

const PACE_MS = 60;
const DELTA_MS = 45;

const SHEET = '.session-view-pane[data-view="changes"] [data-slot="tug-sheet"]';
const ANY_ROWS = `${SHEET} [data-testid="tug-changes-list-file-block"]`;
const COMMIT_BUTTON = '[data-testid="tug-prompt-entry-commit-button"]';
const RECEIPT = '[data-slot="tug-commit-changes-list"] [data-testid="tug-changes-list-file-block"]';
const PROMPT_PHASE = `(function(){ var e = document.querySelector('[data-slot="tug-prompt-entry"]'); return e === null ? null : e.getAttribute("data-phase"); })()`;

/** The cards the video shows: the fourth card only holds the grid's shape (a split column needs two members), and assemble.py paints the canvas over it. */
const SHOWN = 3;

/** One staged session: the card, the prompt and closing line of its turn, the files it edits with the comment each edit adds, and the commit message Auto-Message writes. */
interface Staged {
  card: string;
  prompt: string;
  closing: string;
  files: readonly string[];
  comment: readonly string[];
  message: string;
}

const SESSIONS: readonly Staged[] = [
  {
    card: "vd-smc-picker",
    prompt: "Make the session picker's arrow keys walk the tree, wrapping at the ends of a branch.",
    closing: "The arrow keys walk the rows in tree order and wrap within a branch; the format helper trims the synopsis to the row. Three files changed.",
    files: ["tugdeck/src/lib/session-picker-data-source.ts", "tugdeck/src/lib/session-picker-format.ts", "tugdeck/src/lib/picker-notice-store.ts"],
    comment: [
      "// The arrow keys walk the rows in tree order: a folder's children follow it,",
      "// and the walk wraps at the ends of a branch rather than falling off the list.",
    ],
    message:
      "feat(picker): walk the session tree with the arrow keys\n" +
      "\n" +
      "- session-picker-data-source.ts: rows carry their branch, so a walk knows where a branch ends\n" +
      "- session-picker-format.ts: the synopsis is trimmed to the row it is shown in\n" +
      "- picker-notice-store.ts: a notice when the walk wraps",
  },
  {
    card: "vd-smc-sparkline",
    prompt: "Hold the sparkline's newest bin flat past the right edge instead of dropping it to zero.",
    closing: "The newest value is held flat to the edge; the geometry gets a sample-and-hold step and the instrument feeds it. Three files changed.",
    files: ["tugdeck/src/lib/sparkline-instrument.ts", "tugdeck/src/lib/sparkline-geometry.ts", "tugdeck/src/components/tugways/session-activity-sparkline.tsx"],
    comment: ["// The newest bin is held flat past the right edge, as the tape in the app does;", "// nothing is smoothed, so a burst is still a cliff."],
    message:
      "fix(sparkline): hold the newest bin flat past the right edge\n" +
      "\n" +
      "- sparkline-geometry.ts: a sample-and-hold step after the last bin\n" +
      "- sparkline-instrument.ts: the instrument feeds the held value\n" +
      "- session-activity-sparkline.tsx: the host passes the hold through",
  },
  {
    card: "vd-smc-receipt",
    prompt: "Name the session on a commit receipt, beside the sha.",
    closing: "The receipt carries the session's name as an atom beside the sha, and the format helper lays it out. Two files changed.",
    files: ["tugdeck/src/lib/commit-receipt.ts", "tugdeck/src/lib/commit-format.ts"],
    comment: ["// A receipt names the session that made the commit, as a session atom beside the sha."],
    message:
      "feat(receipt): name the session on a commit receipt\n" +
      "\n" +
      "- commit-receipt.ts: the receipt carries the session's name and id\n" +
      "- commit-format.ts: the atom is laid out beside the sha",
  },
  {
    card: "vd-smc-arc",
    prompt: "Mark the step in hand on the arc lifecycle line, breathing on the dot's envelope.",
    closing: "The line's active mark breathes on the pulsing dot's envelope and holds still when the arc has stopped. Three files changed.",
    files: ["tugdeck/src/components/tugways/arc-lifecycle-line.tsx", "tugdeck/src/components/tugways/arc-lifecycle-mark.tsx", "tugdeck/src/lib/arc-track-model.ts"],
    comment: ["// The mark of the step in hand breathes on the pulsing dot's envelope; a stopped arc holds still."],
    message:
      "feat(arc-line): breathe the step in hand on the lifecycle line\n" +
      "\n" +
      "- arc-lifecycle-mark.tsx: the active mark takes the dot's breath\n" +
      "- arc-lifecycle-line.tsx: a stopped arc's mark holds still\n" +
      "- arc-track-model.ts: the model names which mark is in hand",
  },
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** One edit: the file's first `export` line, with the session's comment put above it. */
interface Edit {
  path: string;
  old: string;
  new: string;
}

function editOf(repo: string, path: string, comment: readonly string[]): Edit {
  const lines = readFileSync(join(repo, path), "utf8").split("\n");
  const i = lines.findIndex((l) => l.startsWith("export "));
  if (i < 0) throw new Error(`no export line in ${path}`);
  return { path, old: lines[i]!, new: [...comment, lines[i]!].join("\n") };
}

/** The scratch clone: this checkout at HEAD, under a directory named `tug`, with each session's edits applied to the tree. */
function makeRepo(root: string): string {
  const repo = join(root, "tug");
  execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", CHECKOUT, repo]);
  git(repo, "config", "user.email", "kocienda@mac.com");
  git(repo, "config", "user.name", "Ken Kocienda");
  return repo;
}

function applyEdit(repo: string, e: Edit): void {
  const file = join(repo, e.path);
  const text = readFileSync(file, "utf8");
  const at = text.indexOf(e.old);
  if (at < 0) throw new Error(`edit anchor missing in ${e.path}`);
  writeFileSync(file, text.slice(0, at) + e.new + text.slice(at + e.old.length));
}

const toolUseId = (card: string, i: number): string => `toolu_${card}_${i + 1}`;

/** One turn: the edits, each an Edit call that opens and returns, and a closing line. */
function transcript(s: Staged, repo: string, edits: readonly Edit[]): unknown {
  const outputs: unknown[] = [];
  edits.forEach((e, i) => {
    const id = toolUseId(s.card, i);
    outputs.push({ type: "tool_use", msg_id: `${s.card}-m1`, seq: i, tool_name: "Edit", tool_use_id: id, input: { file_path: join(repo, e.path), old_string: e.old, new_string: e.new }, ipc_version: IPC_VERSION });
    outputs.push({ type: "tool_progress", tool_use_id: id, tool_name: "Edit", elapsed_time_seconds: 0, parent_tool_use_id: null, ipc_version: IPC_VERSION });
    outputs.push({ type: "tool_result", tool_use_id: id, output: `The file ${join(repo, e.path)} has been updated successfully.`, is_error: false, ipc_version: IPC_VERSION });
  });
  outputs.push({ type: "content_block_start", msg_id: `${s.card}-m2`, block_index: 0, kind: "text", ipc_version: IPC_VERSION });
  outputs.push({ type: "assistant_text", msg_id: `${s.card}-m2`, block_index: 0, seq: edits.length, rev: 0, text: s.closing, is_partial: false, status: "complete", ipc_version: IPC_VERSION });
  outputs.push({ type: "turn_complete", msg_id: `${s.card}-m2`, seq: edits.length + 1, result: "success", ipc_version: IPC_VERSION });
  return { schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION, tugcodeVersion: "stub", paceMs: PACE_MS, turns: [{ index: 0, description: `${s.card}: the edits`, outputs }] };
}

function deck(): Record<string, unknown> {
  // Slot 0 holds the first and third cards, slot 1 the second and fourth: a two-by-two grid, read across then down.
  const slotOf = (i: number) => i % 2;
  const column = (slot: number) => SESSIONS.filter((_, i) => slotOf(i) === slot).map((s) => `${s.card}-pane`);
  return {
    cards: SESSIONS.map((s) => ({ id: s.card, componentId: "session", title: "Session", closable: true })),
    panes: SESSIONS.map((s, i) => kindPane("session", s.card, slotOf(i))),
    activePaneId: `${SESSIONS[0]!.card}-pane`,
    imposition: {
      kind: "two-up",
      // Fit: the window fixes every card's height, so a shade opening or a receipt landing moves nothing around it.
      layout: "fit",
      columns: { 0: { mode: "split", order: column(0) }, 1: { mode: "split", order: column(1) } },
      sidebars: {},
    },
    hasFocus: true,
  };
}

/** The scribe's stream: the message so far, two words at a time. */
function deltas(message: string): string[] {
  const words = message.match(/\S+\s*/g) ?? [message];
  const out: string[] = [];
  let sofar = "";
  words.forEach((w, i) => {
    sofar += w;
    if (i % 2 === 1 || i === words.length - 1) out.push(sofar);
  });
  return out;
}

describe.skipIf(!RUNS)("video: the smaller-changes sequence", () => {
  test(
    "records three sessions raising their Changes shades, then each committing its own work, timed to the narration",
    async () => {
      mkdirSync(SCRATCH_ROOT, { recursive: true });
      const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, "run-")));
      onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
      note("cloning the checkout");
      const repo = makeRepo(scratch);
      const edits = SESSIONS.map((s) => s.files.map((f) => editOf(repo, f, s.comment)));
      edits.flat().forEach((e) => applyEdit(repo, e));
      const stubDir = stubDirectory();
      const sids = SESSIONS.map(() => randomUUID());
      SESSIONS.forEach((s, i) => writeFileSync(join(stubDir, `${sids[i]}.json`), JSON.stringify(transcript(s, repo, edits[i]!))));

      const app = await launchForMode("vd-smaller-changes", deck(), stubDir, { contentSize: CONTENT_SIZE });
      try {
        const granted = await app.setWindowContentSize(CONTENT_SIZE);
        expect(granted, "the display grants the window").toEqual(CONTENT_SIZE);
        await Bun.sleep(800);
        const focus = (card: string) => app.dispatchControlAction("focus-pane", { paneId: `${card}-pane` });
        const phase = (card: string) => () => app.body(card).evalJS<string | null>(PROMPT_PHASE).catch(() => null);

        // Each card is bound to its stub and its turn played out, in turn, before a frame is taken.
        for (const [i, s] of SESSIONS.entries()) {
          note(`binding ${s.card}`);
          await focus(s.card);
          await app.waitForCondition<boolean>(`(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(s.card)})`, { timeoutMs: 30_000 });
          await app.spawnSessionNew(s.card, { tugSessionId: sids[i]!, projectDir: repo });
          await pollFor(
            () =>
              app
                .body(s.card)
                .evalJS<boolean>(`document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelector('.session-card-picker-form') === null`)
                .catch(() => false),
            (bound) => bound,
            30_000,
          );
          await app.ingestSessionMetadata(s.card, { type: "system_metadata", cwd: repo, model: "claude-fable-5-1", version: "2.1.285", permissionMode: "auto", ipc_version: IPC_VERSION });
          await Bun.sleep(400);
          await app.body(s.card).driveSession({ op: "send", text: s.prompt });
          await pollFor(phase(s.card), (p) => p === "streaming", 20_000);
          await pollFor(phase(s.card), (p) => p !== null && p !== "streaming", 30_000);
        }

        // The ledger's account of every edit under its session, then one file per session rewritten so the aggregates recompose.
        app.seedLedger({
          file_events: SESSIONS.flatMap((s, i) =>
            edits[i]!.map((e, j) => ({
              tug_session_id: sids[i]!,
              tool_use_id: toolUseId(s.card, j),
              file_path: join(repo, e.path),
              tool_name: "Edit",
              op: "write",
              origin: "exact",
              ambiguous: false,
              project_dir: repo,
              at: Date.now(),
            })),
          ),
        });
        for (const es of edits) {
          const file = join(repo, es[0]!.path);
          writeFileSync(file, readFileSync(file));
        }
        await Bun.sleep(1_500);
        await focus(SESSIONS[0]!.card);
        await Bun.sleep(400);
        // Each card's rect in content points, for the assembler's relayout.
        const rects = await standIns(app);

        const ms = (audioSecs: number, offset: number) => Math.round((audioSecs - offset) * 1000);
        const notes: Record<string, unknown> = {};

        // ---- Burst A: the cards at rest, then each shade raised ------------
        const a = scene().mark("loop-start", 0);
        const A = (t: number) => ms(t, BURST_A_AT);
        // From "managing change starts small": ⌃⌘C on each card in turn, so every shade stands open through "knowing which
        // session changed what". On an empty composer the shade opens in commit mode.
        [3.6, 4.4, 5.2].forEach((t, i) => {
          const s = SESSIONS[i]!;
          a.at(A(t), async () => {
            await focus(s.card);
            await Bun.sleep(120);
            await app.nativeKey("c", ["ctrl", "cmd"]);
          });
        });
        a.at(A(9.3), async () => {
          for (const [i, s] of SESSIONS.slice(0, SHOWN).entries()) {
            const body = app.body(s.card);
            await body.waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(ANY_ROWS)}).length >= ${edits[i]!.length}`, { timeoutMs: 5_000 }).catch(() => {});
            notes[`${s.card}.rows`] = await body.evalJS<number>(`document.querySelectorAll(${JSON.stringify(ANY_ROWS)}).length`);
            notes[`${s.card}.commitMode`] = await body.evalJS<boolean>(`document.querySelector(${JSON.stringify(COMMIT_BUTTON)}) !== null`);
          }
        });
        a.mark("loop-end", A(BURST_A_END));
        const readingA = await a.record(app, { outDir: outDirFor("smaller-changes-a"), settleMs: 300 });
        expectRecorded(readingA);

        // ---- Burst B: the messages written, the commits pressed -----------
        const b = scene().mark("loop-start", 0);
        const B = (t: number) => ms(t, BURST_B_AT);
        const draftFrame = (i: number, frame: Record<string, unknown>) =>
          app
            .body(SESSIONS[i]!.card)
            .evalJS<boolean>(`window.__tug.publishDraftFrame(${JSON.stringify(JSON.stringify({ workspace_key: repo, owner_kind: "session", owner_id: sids[i], ...frame }))})`);
        // "keeping a ledger of which session made which change": the scribe writes each card's message.
        [24.5, 25.4, 26.3].forEach((t, i) => {
          b.at(B(t), () => draftFrame(i, { action: "changeset_draft_state", state: "drafting" }));
          const words = deltas(SESSIONS[i]!.message);
          words.forEach((text, k) => b.at(B(t) + 500 + k * DELTA_MS, () => draftFrame(i, { action: "changeset_draft_delta", text })));
          b.at(B(t) + 500 + words.length * DELTA_MS + 100, () => draftFrame(i, { action: "changeset_draft_state", state: "ready" }));
        });
        // "so each session can commit its own work": the three Commit buttons, in turn, each card fronted first — a click on a
        // card that is not active only activates it. The receipts are awaited after the burst.
        [30.0, 31.0, 32.0].forEach((t, i) => {
          b.at(B(t) - 250, () => focus(SESSIONS[i]!.card));
          b.at(B(t), () => app.body(SESSIONS[i]!.card).nativeClickAtElement(COMMIT_BUTTON));
        });
        b.mark("loop-end", B(BURST_B_END));
        const readingB = await b.record(app, { outDir: outDirFor("smaller-changes-b"), settleMs: 300 });

        for (const s of SESSIONS.slice(0, SHOWN)) {
          await pollFor(
            () => app.body(s.card).evalJS<boolean>(`document.querySelector(${JSON.stringify(RECEIPT)}) !== null`).catch(() => false),
            (landed) => landed,
            60_000,
          );
        }
        notes.commits = git(repo, "log", `-${SHOWN}`, "--format=%s").split("\n");

        const size = await contentSize(app);
        for (const [name, reading, from, to] of [
          ["smaller-changes-a", readingA, BURST_A_AT, BURST_A_END],
          ["smaller-changes-b", readingB, BURST_B_AT, BURST_B_END],
        ] as const) {
          writeFileSync(
            join(outDirFor(name), "shot.json"),
            JSON.stringify({ shot: name, mode: MODE, audioOffsetSecs: from, audioEndSecs: to, contentSize: size, cards: SESSIONS.map((s) => s.card), rects, marks: reading.marks, frames: reading.frames, scale: reading.scale, notes }, null, 2),
          );
        }
        expectRecorded(readingB);
        expect(notes.commits, "each press produced the commit it asked for").toEqual(SESSIONS.slice(0, SHOWN).map((s) => s.message.split("\n")[0]).reverse());
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
