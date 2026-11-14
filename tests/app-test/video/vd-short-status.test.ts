/**
 * vd-short-status.test.ts — a YouTube Short on the Session card's status bar:
 * the row of cells under the transcript (STATE, TIME, CONTEXT, ARC, JOBS)
 * through one working turn, the popup each of three cells opens, and the
 * folded card, which is its masthead and this row.
 *
 * A video tool, not a test of the app: it stages a scene and records it, and
 * its assertions are that frames were written and the row showed all five
 * cells. It lives beside the other video drivers and shares the site clips'
 * helpers and gate: run by path with `TUG_SITE_CLIPS_OUT` and
 * `TUG_SITE_CLIPS_MODE` set; with either unset it skips. The `vids` repo's
 * `tools/shot.py short-status` is the usual caller, and its `tools/short.py`
 * composes the portrait frame.
 *
 * The scene: a scratch clone of this checkout under a directory named `tug`,
 * and one Session card in a one-up, close to the frame's own 9:16, bound to
 * a stub transcript whose turns are empty: the driver streams every turn
 * itself. The session runs an arc of seven steps: a real one, cut by the
 * built `tugtool` in the clone and bound to the card, its steps started and
 * finished by the CLI's own verbs, so the ARC cell and its popup are the
 * app's reading of a real ledger. Three turns are played before the first
 * frame, in real time, so the TIME popup has a log to show, three steps are
 * done, and the context window stands at 592K of 1M. The fourth turn is the
 * one recorded: it streams prose and holds tool calls open (STATE
 * alternating Streaming and Working, TIME counting), its usage climbs past
 * three quarters of the window (CONTEXT turning to its caution colour),
 * and it walks the arc's remaining steps. The turn ends after the card is
 * folded, so the folded row is seen coming to rest.
 *
 * The frame is portrait and the row is the card's whole width, so the
 * composer (`tools/short.py`, a `camera` recipe) looks at the capture through
 * a 9:16 window that travels from cell to cell: this driver measures each
 * cell and, in a rehearsal off the record, each popup, and writes the views
 * and the moves between them to `shot.json`, with a ring round each cell at
 * the moment it is clicked.
 *
 * The times are seconds of a draft read of the narration; they are re-timed
 * to the recording's word timestamps once there is one.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { TUGCODE_TRANSCRIPT_SCHEMA_VERSION, note, type App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { arcBriefPath, arcTasksPath, createArc, fixturePlanDocument, tugtoolPath, type ArcFixtureOpts } from "../arc-fixture";
import { pollFor } from "../body-grounding/_frames";
import { overlayReady } from "../overlay-fixture";
import { stubDirectory } from "../streaming-stub-fixture";
import { MODE, RUNS, contentSize, expectRecorded, launchForMode, outDirFor, scene, standIns, type Scene } from "../site-clips/_site-clips";

const TEST_TIMEOUT_MS = 500_000;
const IPC_VERSION = 2;
const CODE_OUTPUT_FEED = 0x40;
const SHOT = "short-status";
const CARD = "vd-short-status";
/** This checkout, cloned for the scene; its built `tugtool` cuts the arc. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", "..", ".."));
/** Where the scratch clone lives: a readable path, since the masthead names the directory. Removed when the run ends. */
const SCRATCH_ROOT = process.env.TUG_VIDS_SCRATCH ?? resolve(CHECKOUT, "..", "scratch");

/** View › Zoom: with the 2× backing store, one CSS pixel is 2.6 captured pixels. */
const PAGE_ZOOM = 1.3;
/** One card, as tall as the display grants a window; with its title bar the window is the frame's own 9:16. */
const CONTENT_SIZE = { width: 972, height: 1694 };

const WORD_MS = 55;

const ROW = '[data-slot="session-telemetry-status-row"]';
/** A cell by its key. The fourth cell's key is `tasks` today and `arc` once the row's rename lands, so it is asked for by either. */
const cell = (priority: string) =>
  priority === "arc"
    ? `[data-slot="tug-status-cell"][data-priority="tasks"], [data-slot="tug-status-cell"][data-priority="arc"]`
    : `[data-slot="tug-status-cell"][data-priority="${priority}"]`;
const PLACARD = ".session-telemetry-status-placard";
const PROMPT_PHASE = `(function(){ var e = document.querySelector('[data-slot="tug-prompt-entry"]'); return e === null ? null : e.getAttribute("data-phase"); })()`;

/** The arc: its name, its one line, and its seven steps. */
const ARC = {
  name: "stopped-job-count",
  description: "Count a stopped job as finished, not running",
  steps: [
    "Read the jobs reducer and its tests",
    "Fix the stopped-job count",
    "Add a test for a stopped job",
    "Make the popup's Clear take stopped rows",
    "Run the tugdeck suite",
    "Update the changelog",
    "Draft the commit message",
  ],
} as const;
const FIXTURE_TITLES = ["The only step", "The second step", "The third step", "The fourth step", "The fifth step", "The sixth step", "The seventh step"];

const BRIEF = `# ${ARC.name}

**Idea.** A stopped job keeps its row but is still counted as running.

**Decided.** A stopped row is terminal: the count is the running rows alone, and the popup's Clear takes stopped rows with the finished ones.

**Steps.**
${ARC.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}
`;

/** The static part of the window, as tugcode's tokenizer reports it at session start. */
const BREAKDOWN = [
  { id: "system_prompt", label: "System prompt", tokens: 3_200 },
  { id: "system_tools", label: "System tools", tokens: 17_800 },
  { id: "custom_agents", label: "Custom agents", tokens: 1_100 },
  { id: "memory_files", label: "Memory files", tokens: 4_600 },
  { id: "skills", label: "Skills", tokens: 2_400 },
] as const;
const CONTEXT_MAX = 200_000;

/** The beats, in seconds of the draft read. */
const T = {
  /** "Every session in Tug has a status bar, and it's always telling me something.": the turn is sent, and the camera pushes in on the row's left end. */
  push: [0.0, 1.4],
  /** "State shows what the session is doing right now.": its log opens, and takes a row each time the state changes. The camera rests nowhere for more than about three seconds. */
  stateRing: [3.2, 4.0],
  stateOpen: 3.9,
  stateView: [3.9, 4.7],
  stateClose: 6.9,
  /** "Time is a live clock. One click shows me where the time went." */
  toTime: [6.9, 7.7],
  timeRing: [8.6, 9.4],
  timeOpen: 9.3,
  timeView: [9.3, 10.1],
  timeClose: 13.3,
  /** "Context shows how full the window is, with a dial that breaks it down." */
  toContext: [13.3, 14.1],
  contextRing: [15.5, 16.3],
  contextOpen: 16.2,
  contextView: [16.2, 17.0],
  contextClose: 19.7,
  /** "Arc shows the step the work is on.": along the row to its right end. */
  toTasks: [19.7, 20.5],
  tasksRing: [21.0, 21.8],
  tasksOpen: 21.7,
  tasksView: [21.7, 22.5],
  tasksClose: 23.9,
  /** "And when I fold a card, the status bar stays." */
  toWhole: [23.9, 24.8],
  fold: 24.9,
  toFolded: [25.5, 26.3],
  /** "Tug keeps me up to date at a glance.": the turn ends with the row at 7/7, and the card is unfolded as the camera pulls back. */
  done: 27.2,
  unfold: 27.7,
  toEnd: [27.6, 28.7],
  end: 29.5,
} as const;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The model's window is 1M: the turn's figures are written against a 200K window and scaled to it, so the turn crosses three quarters at 750K. */
const WINDOW_SCALE = 5;

function usage(tokens: number): Record<string, number> {
  return { input_tokens: 2_400, output_tokens: 1_800, cache_creation_input_tokens: 6_200, cache_read_input_tokens: tokens * WINDOW_SCALE - 10_400 };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** The scratch clone: this checkout at HEAD under a directory named `tug`, with a minimal arc config committed on `main`. */
function makeRepo(root: string): string {
  const repo = join(root, "tug");
  execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", CHECKOUT, repo]);
  git(repo, "config", "user.email", "kocienda@mac.com");
  git(repo, "config", "user.name", "Ken Kocienda");
  // No post-create hooks and no declared checks: the arc's worktree is cut in a second.
  writeFileSync(join(repo, ".tugtool", "config.toml"), "[tugtool.arc]\n");
  git(repo, "commit", "-qam", "chore: the scene's arc config");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}

/** A task list with the arc's step titles, in the fixture's grammar. */
function tasks(): string {
  let doc = fixturePlanDocument(ARC.steps.length);
  ARC.steps.forEach((s, i) => {
    doc = doc.split(FIXTURE_TITLES[i]!).join(s);
  });
  return doc;
}

/** `tugtool arc <args>` in the clone, asynchronously, so an act never blocks the scene; `sid` is the session the verb acts as. */
async function arcVerb(repo: string, cli: ArcFixtureOpts, args: string[], sid = ""): Promise<string> {
  const proc = Bun.spawn([tugtoolPath(cli.binaryRoot ?? repo), "arc", ...args], {
    cwd: repo,
    env: { ...process.env, ...cli.env, TUG_SESSION_ID: sid },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`tugtool arc ${args.join(" ")} failed (${code})\n${out}\n${err}`);
  return out;
}

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: `${CARD}-pane`,
        position: { x: 20, y: 20 },
        size: { width: 720, height: 1280 },
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

/** Turns with nothing to replay: the driver streams each turn itself, on its own clock. */
function stubTranscript(): unknown {
  return {
    schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION,
    tugcodeVersion: "stub",
    turns: [0, 1, 2, 3, 4, 5].map((index) => ({ index, description: "streamed by the driver", outputs: [] })),
  };
}

describe.skipIf(!RUNS)("video shot: the status-bar Short", () => {
  test(
    "records the status row through a turn of an arc, three of its popups, and the folded card",
    async () => {
      mkdirSync(SCRATCH_ROOT, { recursive: true });
      const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, "run-")));
      onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
      note("cloning the checkout");
      const projectDir = makeRepo(scratch);
      const dataRoot = join(scratch, "data");
      mkdirSync(dataRoot, { recursive: true });
      // The clone has no built CLI of its own; the checkout's runs against it, writing arc state into the scene's data root.
      const cli: ArcFixtureOpts = { binaryRoot: CHECKOUT, env: { TUG_DATA_DIR: dataRoot, TUG_SESSION_ID: "" } };
      const stubDir = stubDirectory();
      const sid = randomUUID();
      writeFileSync(join(stubDir, `${sid}.json`), JSON.stringify(stubTranscript()));

      const app = await launchForMode("vd-short-status", deck(), stubDir, { contentSize: CONTENT_SIZE, env: { TUG_DATA_DIR: dataRoot } });
      try {
        const granted = await app.setWindowContentSize(CONTENT_SIZE);
        expect(granted, "the display grants the window").toEqual(CONTENT_SIZE);
        await app.setPageZoom(PAGE_ZOOM);
        await Bun.sleep(800);
        await app.waitForCondition<boolean>(`(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD)})`, { timeoutMs: 30_000 });
        await app.spawnSessionNew(CARD, { tugSessionId: sid, projectDir });
        const body = app.body(CARD);
        await pollFor(
          () => body.evalJS<boolean>(`document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelector('.session-card-picker-form') === null`).catch(() => false),
          (bound) => bound,
          30_000,
        );
        await app.ingestSessionMetadata(CARD, { type: "system_metadata", cwd: projectDir, model: "claude-fable-5-1", version: "2.1.299", permissionMode: "auto", ipc_version: IPC_VERSION });
        await Bun.sleep(600);
        const notes: Record<string, unknown> = {};

        const ingest = (decoded: Record<string, unknown>) =>
          app.driveSession(CARD, { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded: { tug_session_id: sid, ipc_version: IPC_VERSION, ...decoded } });
        const phase = () => body.evalJS<string | null>(PROMPT_PHASE).catch(() => null);
        let seq = 0;
        let calls = 0;
        /** A tool call, open for `holdMs`. */
        const callNow = async (msgId: string, toolName: string, input: Record<string, unknown>, result: string, holdMs: number) => {
          const id = `toolu_vd_status_${++calls}`;
          await ingest({ type: "tool_use", msg_id: msgId, seq: seq++, tool_name: toolName, tool_use_id: id, input });
          await ingest({ type: "tool_progress", tool_use_id: id, tool_name: toolName, elapsed_time_seconds: 0, parent_tool_use_id: null });
          await Bun.sleep(holdMs);
          await ingest({ type: "tool_result", tool_use_id: id, output: result, is_error: false });
        };
        const through = String(ARC.steps.length);
        /** Finish step `n` and take the next, as the arc's own verbs. */
        const advance = async (n: number) => {
          await arcVerb(projectDir, cli, ["step", ARC.name, "done", String(n)]);
          if (n < ARC.steps.length) await arcVerb(projectDir, cli, ["step", ARC.name, "start", String(n + 1), "--through", through]);
        };
        /** The same before the first frame, with a wait for the steps' markers to reach the transcript inside the turn that made them. */
        const advanceNow = async (n: number) => {
          await advance(n);
          await Bun.sleep(1_200);
        };
        const proseNow = async (msgId: string, text: string, tokens: number) => {
          await ingest({ type: "streaming_usage", msg_id: msgId, usage: usage(tokens) });
          await ingest({ type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text" });
          const words = text.split(" ");
          const mine = seq++;
          for (const [i, w] of words.entries()) {
            await ingest({ type: "assistant_text", msg_id: msgId, block_index: 0, seq: mine, rev: i, text: i < words.length - 1 ? `${w} ` : w, is_partial: true, status: "partial" });
            await Bun.sleep(WORD_MS);
          }
          await ingest({ type: "assistant_text", msg_id: msgId, block_index: 0, seq: mine, rev: words.length, text, is_partial: false, status: "complete" });
        };
        const completeNow = async (msgId: string, tokens: number, turns: number) => {
          await ingest({ type: "cost_update", total_cost_usd: 0.4 * turns, num_turns: turns, duration_ms: 8_200, duration_api_ms: 7_900, usage: usage(tokens), modelUsage: {} });
          await ingest({ type: "turn_complete", msg_id: msgId, seq: seq++, result: "success" });
          await pollFor(phase, (p) => p !== null && p !== "streaming", 15_000);
        };
        const send = async (text: string, anchor: string) => {
          await app.driveSession(CARD, { op: "send", text });
          await ingest({ type: "prompt_anchor", promptUuid: anchor });
        };

        // ---- Three turns before the first frame, in real time, for the TIME popup's log. ----
        note("playing the earlier turns");
        // The arc, cut and bound to this card, with its first step in hand. No run record: a record with a bound session is
        // what the server's wheel rotates a stage onto, and a stage prompt is not in the stub. The steps' ledger carries the reading.
        const created = createArc(projectDir, ARC.name, ARC.description, cli);
        writeFileSync(arcBriefPath(projectDir, ARC.name), BRIEF);
        writeFileSync(arcTasksPath(projectDir, ARC.name), tasks());
        await arcVerb(projectDir, cli, ["step", ARC.name, "start", "1", "--through", through]);
        for (let tries = 0; ; tries++) {
          try {
            await arcVerb(projectDir, cli, ["bind", ARC.name, "--json"], sid);
            break;
          } catch (e) {
            if (tries >= 6) throw e;
            await Bun.sleep(300);
          }
        }
        const bindOk = { tug_session_id: sid, arc_id: created.id, arc_name: ARC.name };
        await app.dispatchControlAction("bind_arc_ok", bindOk);
        await body.evalJS<null>(`(window.__tug.dispatchControlAction("bind_arc_ok", ${JSON.stringify(bindOk)}), null)`);
        await ingest({ type: "context_breakdown", context_max: CONTEXT_MAX, categories: BREAKDOWN });
        await send("Plan the stopped-job fix.", "vd-st-p1");
        await proseNow("s1a", "A stopped job keeps its row but is still counted as running. The arc has seven steps, and the first is to read the reducer.", 96_800);
        await callNow("s1a", "Bash", { command: "wc -l src/lib/jobs-reducer.ts src/lib/jobs-reducer.test.ts", description: "Size up the reducer and its tests" }, "     412 src/lib/jobs-reducer.ts\n     688 src/lib/jobs-reducer.test.ts\n    1100 total", 900);
        await advanceNow(1);
        await completeNow("s1a", 98_200, 1);
        await Bun.sleep(1_200);

        await send("Start with the reducer.", "vd-st-p2");
        await callNow("s2a", "Bash", { command: "grep -n \"running\" src/lib/jobs-reducer.ts", description: "Find the running predicate" }, "212:  return rows.filter((r) => r.status !== \"finished\").length;", 1_400);
        await proseNow("s2b", "The jobs reducer keys every row by the task id the launch echoed, and a stopped job keeps its row with a terminal status. The count the cell shows should be the running rows alone, so the fix is one predicate: a stopped row is terminal, not running.", 104_300);
        await advanceNow(2);
        await completeNow("s2b", 109_100, 2);
        await Bun.sleep(1_500);

        await send("Add a test for it.", "vd-st-p3");
        await proseNow("s3a", "One test: launch a job, stop it, and assert the running count is zero while the finished count is one.", 113_700);
        await callNow("s3a", "Bash", { command: "bun test src/lib/jobs-reducer.test.ts 2>&1 | tail -3", description: "Run the reducer's tests" }, " 31 pass\n 0 fail\nRan 31 tests across 1 file. [212.00ms]", 1_800);
        await advanceNow(3);
        await completeNow("s3a", 118_400, 3);
        await Bun.sleep(1_500);

        // ---- Where things are, in window points. ----
        const rectOf = (selector: string) => app.elementRect(CARD, selector) as Promise<Rect | null>;
        const cells: Record<string, Rect> = {};
        for (const p of ["state", "time", "context", "arc", "jobs"]) {
          const r = await rectOf(cell(p));
          expect(r !== null && r.width > 0, `the ${p} cell is on the row`).toBe(true);
          cells[p] = r!;
        }
        const row = (await rectOf(ROW))!;
        notes.cells = cells;
        notes.row = row;
        notes.values = await body.evalJS<string[]>(`Array.prototype.map.call(document.querySelectorAll('[data-slot="tug-status-cell"]'), function (c) { return c.getAttribute("data-priority") + "=" + c.innerText.replace(/\\s+/g, " ").trim(); })`);

        const click = (priority: string) =>
          body.evalJS<boolean>(`(function(){ var el = document.querySelector(${JSON.stringify(cell(priority))}); if (el === null) return false; el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`);
        // A rehearsal, off the record: each popup opened and measured where the overlay draws it, then closed.
        const ui = await overlayReady(app);
        const window = await contentSize(app);
        const placards: Record<string, Rect> = {};
        for (const p of ["state", "time", "context", "arc"]) {
          await click(p);
          await ui.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(PLACARD)}) !== null`, { timeoutMs: 8_000 });
          await Bun.sleep(700);
          const r = await ui.evalJS<Rect & { vw: number }>(`(function(){ var r = document.querySelector(${JSON.stringify(PLACARD)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, vw: window.innerWidth }; })()`);
          // The overlay page is the window's size: its CSS pixels are window points over its own zoom.
          const k = window.width / r.vw;
          placards[p] = { x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k };
          await click(p);
          await ui.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(PLACARD)}) === null`, { timeoutMs: 8_000 });
          await Bun.sleep(300);
        }
        notes.placards = placards;

        // The fold, rehearsed for where the folded card stands.
        await app.performMenuItem("view.foldCard");
        await Bun.sleep(1_200);
        const folded = (await standIns(app))[CARD]!;
        const foldedState = (await rectOf(cell("state")))!;
        const foldedArc = (await rectOf(cell("arc")))!;
        notes.folded = { card: folded, state: foldedState, arc: foldedArc };
        await app.performMenuItem("view.foldCard");
        await Bun.sleep(1_200);

        const panes = await standIns(app);
        const pane = panes[CARD]!;

        // ---- The views: 9:16 windows on the capture, in window points. ----
        const tall = (w: number) => (w * 16) / 9;
        const union = (rs: Rect[]): Rect => {
          const x = Math.min(...rs.map((r) => r.x));
          const y = Math.min(...rs.map((r) => r.y));
          return { x, y, width: Math.max(...rs.map((r) => r.x + r.width)) - x, height: Math.max(...rs.map((r) => r.y + r.height)) - y };
        };
        /** The window `width` wide that centres `rs` across and puts their middle `down` of the way down it. */
        const on = (rs: Rect[], width: number, down: number) => {
          const u = union(rs);
          return { x: u.x + u.width / 2 - width / 2, y: u.y + u.height / 2 - tall(width) * down, width };
        };
        const CLOSE = 440;
        const over = (p: string) => on([cells[p]!, placards[p]!], Math.max(placards[p]!.width + 48, CLOSE), 0.5);
        /** The window that holds the cells from `a` to `b` whole, its edges in the gaps beside them. */
        const span = (a: string, b: string) => on([cells[a]!, cells[b]!], cells[b]!.x + cells[b]!.width - cells[a]!.x + 20, 0.58);
        const views: Record<string, { x: number; y: number; width: number }> = {
          whole: { x: 0, y: pane.y - 12, width: window.width },
          state: span("state", "time"),
          statePopup: over("state"),
          time: span("time", "context"),
          timePopup: over("time"),
          context: span("time", "arc"),
          contextPopup: over("context"),
          arc: span("context", "jobs"),
          arcPopup: over("arc"),
          folded: { x: folded.x - 12, y: 0, width: foldedArc.x + foldedArc.width - folded.x + 36 },
        };
        const move = (view: string, span: readonly [number, number]) => ({ view, from: span[0], to: span[1] });
        const camera = [
          { view: "whole", from: 0, to: 0 },
          move("state", T.push),
          move("statePopup", T.stateView),
          move("time", T.toTime),
          move("timePopup", T.timeView),
          move("context", T.toContext),
          move("contextPopup", T.contextView),
          move("arc", T.toTasks),
          move("arcPopup", T.tasksView),
          move("whole", T.toWhole),
          move("folded", T.toFolded),
          move("whole", T.toEnd),
        ];
        const rings = [
          { what: "state", rect: cells.state!, from: T.stateRing[0], to: T.stateRing[1] },
          { what: "time", rect: cells.time!, from: T.timeRing[0], to: T.timeRing[1] },
          { what: "context", rect: cells.context!, from: T.contextRing[0], to: T.contextRing[1] },
          { what: "arc", rect: cells.arc!, from: T.tasksRing[0], to: T.tasksRing[1] },
        ];

        // ---- The burst: the fourth turn, on the narration's clock. ----
        const s = scene().mark("loop-start", 0);
        const ms = (secs: number) => Math.round(secs * 1000);
        /** Prose from `at`, its usage climbing from one figure to the other; answers when it is complete. */
        const prose = (sc: Scene, at: number, msgId: string, text: string, from: number, to: number, wordMs = WORD_MS): number => {
          const words = text.split(" ");
          const mine = seq++;
          sc.at(at, async () => {
            await ingest({ type: "streaming_usage", msg_id: msgId, usage: usage(from) });
            await ingest({ type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text" });
          });
          words.forEach((w, i) => {
            sc.at(at + (i + 1) * wordMs, async () => {
              await ingest({ type: "assistant_text", msg_id: msgId, block_index: 0, seq: mine, rev: i, text: i < words.length - 1 ? `${w} ` : w, is_partial: true, status: "partial" });
              if (i % 3 === 2) await ingest({ type: "streaming_usage", msg_id: msgId, usage: usage(Math.round(from + ((to - from) * (i + 1)) / words.length)) });
            });
          });
          const done = at + (words.length + 1) * wordMs;
          sc.at(done, async () => {
            await ingest({ type: "assistant_text", msg_id: msgId, block_index: 0, seq: mine, rev: words.length, text, is_partial: false, status: "complete" });
            await ingest({ type: "streaming_usage", msg_id: msgId, usage: usage(to) });
          });
          return done;
        };
        /** A tool call from `at`, open for `holdMs`. */
        const call = (sc: Scene, at: number, msgId: string, toolName: string, input: Record<string, unknown>, result: string, holdMs: number): number => {
          const id = `toolu_vd_status_${++calls}`;
          const mine = seq++;
          sc.at(at, async () => {
            await ingest({ type: "tool_use", msg_id: msgId, seq: mine, tool_name: toolName, tool_use_id: id, input });
            await ingest({ type: "tool_progress", tool_use_id: id, tool_name: toolName, elapsed_time_seconds: 0, parent_tool_use_id: null });
          });
          sc.at(at + holdMs, () => ingest({ type: "tool_result", tool_use_id: id, output: result, is_error: false }));
          return at + holdMs;
        };
        const pending: Promise<unknown>[] = [];
        /** Finish step `n` and take the next at `at`: the verbs are started and the scene moves on. */
        const step = (sc: Scene, at: number, n: number) =>
          sc.at(at, async () => {
            pending.push(advance(n).catch((e) => note(`step ${n} failed: ${String(e)}`)));
          });

        s.at(0, () => send("Walk the rest of the steps.", "vd-st-p4"));
        let t = prose(s, 700, "r1", "The popup's Clear removes finished rows and leaves stopped ones behind, because it asks the same predicate the count did. With the predicate moved, a stopped row is terminal, so Clear should take it with the rest.", 118_400, 124_900);
        t = call(s, t + 150, "r1", "Bash", { command: "grep -rn \"isFinished\" src/components | head", description: "Find who reads the predicate" }, "src/components/jobs-popover.tsx:88:  const cleared = rows.filter(isFinished);", 900);
        t = prose(s, t + 150, "r2", "Only the popup reads it. One line changes there, and the row's label follows the status it already has.", 124_900, 129_600);
        t = call(s, t + 150, "r2", "Bash", { command: "bun test src/components/jobs-popover.test.tsx 2>&1 | tail -3", description: "Run the popup's tests" }, " 18 pass\n 0 fail\nRan 18 tests across 1 file. [164.00ms]", 1_100);
        t = prose(s, t + 150, "r3", "Green. The popup's Clear now takes stopped rows, and its footer counts them as finished, which is what the cell above it says too.", 129_600, 134_200);
        t = call(s, t + 150, "r3", "Bash", { command: "git diff --stat", description: "Check what changed" }, " src/components/jobs-popover.tsx | 2 +-\n src/lib/jobs-reducer.ts          | 4 ++--\n 2 files changed, 3 insertions(+), 3 deletions(-)", 800);
        // Under the TIME popup: more of the same, so the row and the transcript behind keep moving.
        t = prose(s, Math.max(t + 150, ms(T.timeOpen) + 200), "r4", "Two files, three lines. Next is the whole suite, since the predicate is shared and a count somewhere else could have leaned on the old meaning without a test of its own saying so.", 134_200, 138_500);
        t = call(s, t + 150, "r4", "Bash", { command: "grep -rln \"running\" src/lib | wc -l", description: "Count who else reads the count" }, "       9", 500);
        t = prose(s, t + 150, "r4b", "Nine files read the running count, and seven of them only show it.", 138_500, 141_800, 45);
        if (t > ms(T.timeClose)) throw new Error(`video: the prose under the TIME popup ends at ${t} ms, after the popup closes at ${ms(T.timeClose)} ms`);
        // "Context shows how full the window is": the figure climbs past three quarters of the window while the camera is on it.
        t = prose(
          s,
          Math.max(t + 200, ms(T.toContext[0]) + 300),
          "r5",
          "Reading the suite's output takes room: every file's result, the slow ones first, and the two snapshots that changed when the stopped row took its new label. Both are the label and nothing else, so they are updated, and the suite is run again from the top to be sure of it.",
          141_800,
          153_600,
          45,
        );
        notes.contextProseEnds = t;
        // Under the CONTEXT popup: the figure goes on climbing, so the dial moves while it is looked at.
        t = prose(s, Math.max(t + 150, ms(T.contextOpen) + 300), "r5b", "The second run agrees with the first: every file green, the two snapshots among them, and nothing slower than it was before the predicate moved. That is the suite, in full, twice over.", 153_600, 156_900, 70);
        if (t > ms(T.contextClose)) throw new Error(`video: the prose under the CONTEXT popup ends at ${t} ms, after the popup closes at ${ms(T.contextClose)} ms`);
        // "Arc shows the step the work is on.": step 4 is finished under the camera, and step 5 under the popup.
        step(s, ms(T.toTasks[1]) + 150, 4);
        call(s, ms(T.tasksOpen) + 200, "r5", "Bash", { command: "bun test 2>&1 | tail -3", description: "Run the tugdeck suite" }, " 2114 pass\n 0 fail\nRan 2114 tests across 187 files. [9.41s]", 900);
        step(s, ms(T.tasksOpen) + 1_000, 5);
        // The rest of the list, under the fold.
        t = prose(s, ms(T.tasksClose) + 200, "r6", "The changelog has its line: a stopped job is no longer counted as running.", 156_900, 157_600);
        step(s, t + 100, 6);
        t = prose(s, ms(T.fold) + 500, "r7", "And the commit message is drafted. All seven steps are done.", 157_600, 158_200);
        step(s, t + 100, 7);
        if (t + 400 > ms(T.done)) throw new Error(`video: the turn's last task lands at ${t + 400} ms, after its end at ${ms(T.done)} ms`);
        s.at(ms(T.done), async () => {
          await ingest({ type: "cost_update", total_cost_usd: 1.6, num_turns: 4, duration_ms: 27_000, duration_api_ms: 26_000, usage: usage(158_200), modelUsage: {} });
          await ingest({ type: "turn_complete", msg_id: "r7", seq: seq++, result: "success" });
        });

        // The popups, each opened by a click on its cell and closed by another.
        for (const [p, open, close] of [["state", T.stateOpen, T.stateClose], ["time", T.timeOpen, T.timeClose], ["context", T.contextOpen, T.contextClose], ["arc", T.tasksOpen, T.tasksClose]] as const) {
          s.at(ms(open), () => click(p));
          s.at(ms(close), () => click(p));
        }
        s.at(ms(T.fold), () => app.performMenuItem("view.foldCard"));
        s.at(ms(T.unfold), () => app.performMenuItem("view.foldCard"));
        s.mark("loop-end", ms(T.end));
        const reading = await s.record(app, { outDir: outDirFor(SHOT), settleMs: 300 });
        await Promise.all(pending);

        notes.endValues = await body.evalJS<string[]>(`Array.prototype.map.call(document.querySelectorAll('[data-slot="tug-status-cell"]'), function (c) { return c.getAttribute("data-priority") + "=" + c.innerText.replace(/\\s+/g, " ").trim(); })`).catch(() => []);
        writeFileSync(
          join(outDirFor(SHOT), "shot.json"),
          JSON.stringify({ shot: SHOT, mode: MODE, pageZoom: PAGE_ZOOM, contentSize: window, panes, pane, views, camera, rings, marks: reading.marks, frames: reading.frames, scale: reading.scale, notes }, null, 2),
        );
        note("vd-short-status notes", JSON.stringify(notes));
        expectRecorded(reading);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
