/**
 * sc-tool-block.test.ts — the site's tool-block clip: one Bash call in a
 * Session card, running a set of checks that report as they land, and
 * settling as the run it was.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: one Session card in a one-up, bound to a stub transcript of
 * one turn — a Bash `tool_use` for `just ci`, a heartbeat a second for the
 * block's clock, and the `tool_result` eight seconds on. While the call is
 * open, this driver plays the part of the running command: it posts a
 * `tugtool report unit` run under the call's id, the way a recipe does from
 * inside the session's shell, so the block's live band draws the checks one
 * by one — three green and one red — and then the result lands and the
 * block folds to its verdict strip. The capture covers the card; the site's
 * `make-clip --crop` cuts it to the block.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TUGCODE_TRANSCRIPT_SCHEMA_VERSION, type App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { pollFor } from "../body-grounding/_frames";
import { stubDirectory } from "../streaming-stub-fixture";
import { rectIn } from "../one-view-fixture";
import { RUNS, burstTo, contentSize, cropAround, launchForMode, outDirFor, standIns } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const CARD = "sc-tool";
const IPC_VERSION = 2;
const USE_ID = "toolu_sc_tool_block";
const COMMAND = "just ci 2>&1 | tail -30";
/** The transcript's pace: one heartbeat a second while the call is open. */
const PACE_MS = 1_000;
/** Heartbeats between the call opening and its result. */
const HEARTBEATS = 5;
/** The burst: the call opening, the checks landing, the result folding it, and the strip standing. */
const BURST_MS = 9_800;
const STATUS_BAR = '[data-slot="session-card-status-bar"]';
const BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${USE_ID}"]`;
const PANEL = `${BLOCK} [data-slot="bash-report-panel"] [data-slot="tug-report-panel"]`;
const PROJECT_NAME = "tug-site";
const BOUND_MS = 30_000;

/** The checks the run lands, in order, and how each goes. */
const CHECKS: ReadonlyArray<{ name: string; status: "pass" | "fail"; args: string[] }> = [
  { name: "fmt", status: "pass", args: [] },
  { name: "clippy", status: "pass", args: [] },
  { name: "tsc", status: "pass", args: [] },
  {
    name: "tugdeck",
    status: "fail",
    args: ["--passed", "211", "--total", "212", "--title", "select-jobs › a stopped job is terminal", "--message", "expected 1 to be 0"],
  },
];
/** Between one check landing and the next. */
const CHECK_MS = 1_150;

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: `${CARD}-pane`,
        position: { x: 40, y: 40 },
        // Tall enough that the prompt, the turn line and the block at its
        // fullest fit the transcript's viewport: a transcript that scrolls
        // to follow its bottom would move the block as the panel grows.
        size: { width: 720, height: 800 },
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

/** One turn: the call opens, beats {@link HEARTBEATS} times, and returns. */
function transcript(): unknown {
  const outputs: unknown[] = [
    { type: "tool_use", msg_id: "stub-sc-tool-m1", seq: 0, tool_name: "Bash", tool_use_id: USE_ID, input: { command: COMMAND }, ipc_version: IPC_VERSION },
  ];
  for (let i = 1; i <= HEARTBEATS; i++) {
    outputs.push({ type: "tool_progress", tool_use_id: USE_ID, tool_name: "Bash", elapsed_time_seconds: i, parent_tool_use_id: null, ipc_version: IPC_VERSION });
  }
  outputs.push(
    {
      type: "tool_result",
      tool_use_id: USE_ID,
      output: ["fmt: ok", "clippy: ok", "tsc: ok", "tugdeck: 211 pass, 1 fail", "[test] FAIL ci 4/4 checks · 3 pass · 1 fail — tugtool test last --failures"].join("\n"),
      is_error: false,
      ipc_version: IPC_VERSION,
    },
  );
  outputs.push({ type: "turn_complete", msg_id: "stub-sc-tool-m1", seq: 1, result: "success", ipc_version: IPC_VERSION });
  return { schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION, tugcodeVersion: "stub", paceMs: PACE_MS, turns: [{ index: 0, description: "a ci run", outputs }] };
}

/** The bundle's own `tugtool`, beside the app under test. */
function tugtoolBin(): string {
  const appBin = process.env.TUGAPP_DEBUG_PATH;
  if (appBin === undefined) throw new Error("site clips: TUGAPP_DEBUG_PATH names the app under test");
  return join(appBin.replace(/\/Contents\/MacOS\/[^/]+$/, ""), "Contents/MacOS/tugtool");
}

/** Post one `tugtool report` verb as the running call's shell would. */
function report(bin: string, tugSessionId: string, args: string[]): void {
  const proc = Bun.spawnSync([bin, "report", ...args], {
    env: { ...(process.env as Record<string, string>), TUG_SESSION_ID: tugSessionId, TUG_TOOL_USE_ID: USE_ID },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`tugtool report ${args.join(" ")}: ${new TextDecoder().decode(proc.stderr)}`);
}

async function bindStub(app: App, stubDir: string): Promise<string> {
  const tugSessionId = randomUUID();
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sc-tool-")));
  onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
  const projectDir = join(scratch, PROJECT_NAME);
  mkdirSync(projectDir);
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(transcript()));
  await app.spawnSessionNew(CARD, { tugSessionId, projectDir });
  await pollFor(
    () =>
      app
        .body(CARD)
        .evalJS<boolean>(
          `document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelector('.session-card-picker-form') === null`,
        )
        .catch(() => false),
    (bound) => bound,
    BOUND_MS,
  );
  return tugSessionId;
}

describe.skipIf(!RUNS)("site clip: tool block", () => {
  test(
    "records a Bash call's checks landing and the block settling",
    async () => {
      const bin = tugtoolBin();
      const stubDir = stubDirectory();
      const app = await launchForMode("sc-tool-block", deck(), stubDir);
      try {
        const tugSessionId = await bindStub(app, stubDir);
        await Bun.sleep(800);

        const rest = await standIns(app);
        expect(rest[CARD], "the card stands in its slot").toBeDefined();
        const view = (await app.bodies()).find((b) => b.cardId === CARD)!.frame;
        const bar = await rectIn(app.body(CARD), STATUS_BAR);
        expect(bar, "the status bar is mounted").not.toBeNull();
        const card = rest[CARD]!;
        const crop = cropAround([{ x: card.x, y: card.y, width: card.width, height: view.y + bar!.y + bar!.height - card.y }], 12, await contentSize(app));

        const body = app.body(CARD);
        const notes: Record<string, unknown> = {};
        const reading = await burstTo(app, crop, BURST_MS, outDirFor("tool-block"), async () => {
          await body.driveSession({ op: "send", text: "Run the checks before the commit." });
          await pollFor(() => body.evalJS<boolean>(`!!document.querySelector(${JSON.stringify(BLOCK)})`).catch(() => false), (v) => v, 10_000);
          await Bun.sleep(400);
          // The plan draws the panel with every check pending; the report
          // walks the live instances to the one that owns the session, so
          // the panel's arrival is what says the walk found it.
          report(bin, tugSessionId, ["unit", "plan", "ci", "--unit", "check", "--needle", "just ci", "--of", ...CHECKS.map((c) => c.name)]);
          await pollFor(() => body.evalJS<boolean>(`!!document.querySelector(${JSON.stringify(PANEL)})`).catch(() => false), (v) => v, 5_000);
          for (const check of CHECKS) {
            report(bin, tugSessionId, ["unit", "start", "ci", check.name]);
            await Bun.sleep(CHECK_MS);
            report(bin, tugSessionId, ["unit", "done", "ci", check.name, check.status, ...check.args]);
          }
          report(bin, tugSessionId, ["unit", "finish", "ci"]);
          // Where the block stands, for the crop the site cuts from the card.
          const block = await rectIn(body, BLOCK);
          notes.block = block === null ? null : { x: view.x + block.x - crop.x, y: view.y + block.y - crop.y, width: block.width, height: block.height };
        });
        writeFileSync(join(outDirFor("tool-block"), "notes.json"), JSON.stringify(notes, null, 2));
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
