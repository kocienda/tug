/**
 * sc-tool-block.test.ts — the site's tool-block clip: a turn of shell
 * commands in a Session card, each one a block that opens, runs, and
 * settles, stacking down the transcript as the turn goes.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: one Session card in a one-up, bound to a stub transcript of
 * one turn that is five Bash calls in a row — a build, a status, an edit,
 * an encode, a type check — each opening, beating its clock for a second or
 * two, and returning before the next opens. The blocks stay collapsed, as
 * they stand in a working transcript: a header with the command, the
 * running dot that settles green, the call's time. The capture covers the
 * card and the driver notes where the blocks stand; the site's `make-clip
 * --crop` cuts the column of blocks out of it.
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
/** The transcript's pace: the gap between one frame and the next. */
const PACE_MS = 300;
/** The burst: the five calls, and the turn ending after them. */
const BURST_MS = 9_800;
const STATUS_BAR = '[data-slot="session-card-status-bar"]';
const BLOCKS = '[data-slot="bash-tool-block"]';
const PROJECT_NAME = "tug-site";
const BOUND_MS = 30_000;

/** The calls, in order: the command, how many heartbeats it runs for, and what it printed. */
const CALLS: ReadonlyArray<{ command: string; beats: number; output: string }> = [
  { command: "pnpm astro build 2>&1 | tail -3", beats: 5, output: "[build] 19 page(s) built in 1.64s\n[build] Complete!" },
  { command: "git status --short; git log --oneline -3", beats: 2, output: " M src/pages/tug/index.astro\n7d1e4c2 site(tug-home): pair hero with dark and light stills" },
  {
    command: "tugtool file edit <<'EDIT'\nfile src/pages/tug/index.astro\n  replace \"A session card, top to bottom.\" with \"One session card, top to bottom.\"\nEDIT",
    beats: 2,
    output: 'TUG-FILE-RECEIPT: {"ops":[{"op":"modified","path":"src/pages/tug/index.astro"}]}',
  },
  { command: "tools/make-clip --frames /tmp/site-clips/fold/dark --first 3 --last 103 --out src/assets/tug/motion/fold-dark", beats: 4, output: "fold-dark.mp4: 101 frames at 30 fps, h264, 1600x1066" },
  { command: "cd tests/app-test && bunx tsc --noEmit -p tsconfig.json 2>&1 | tail -3", beats: 4, output: "[test] tsc: green" },
];

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: `${CARD}-pane`,
        position: { x: 40, y: 40 },
        // Tall enough that the prompt, the turn line and all five blocks fit
        // the transcript's viewport: a transcript that scrolls to follow its
        // bottom would move the blocks as each one lands.
        size: { width: 720, height: 900 },
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

/** One turn: each call opens, beats, and returns, and the next opens. */
function transcript(): unknown {
  const outputs: unknown[] = [];
  CALLS.forEach((call, i) => {
    const id = `toolu_sc_tool_${i + 1}`;
    outputs.push({ type: "tool_use", msg_id: "stub-sc-tool-m1", seq: i, tool_name: "Bash", tool_use_id: id, input: { command: call.command }, ipc_version: IPC_VERSION });
    for (let b = 1; b <= call.beats; b++) {
      outputs.push({ type: "tool_progress", tool_use_id: id, tool_name: "Bash", elapsed_time_seconds: Math.round((b * PACE_MS) / 1000), parent_tool_use_id: null, ipc_version: IPC_VERSION });
    }
    outputs.push({ type: "tool_result", tool_use_id: id, output: call.output, is_error: false, ipc_version: IPC_VERSION });
  });
  outputs.push({ type: "turn_complete", msg_id: "stub-sc-tool-m1", seq: CALLS.length, result: "success", ipc_version: IPC_VERSION });
  return { schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION, tugcodeVersion: "stub", paceMs: PACE_MS, turns: [{ index: 0, description: "five shell commands", outputs }] };
}

async function bindStub(app: App, stubDir: string): Promise<void> {
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
}

describe.skipIf(!RUNS)("site clip: tool block", () => {
  test(
    "records a turn of shell commands landing as blocks",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchForMode("sc-tool-block", deck(), stubDir);
      try {
        await bindStub(app, stubDir);
        await Bun.sleep(800);

        const rest = await standIns(app);
        expect(rest[CARD], "the card stands in its slot").toBeDefined();
        const view = (await app.bodies()).find((b) => b.cardId === CARD)!.frame;
        const body = app.body(CARD);
        const bar = await rectIn(body, STATUS_BAR);
        expect(bar, "the status bar is mounted").not.toBeNull();
        const card = rest[CARD]!;
        const crop = cropAround([{ x: card.x, y: card.y, width: card.width, height: view.y + bar!.y + bar!.height - card.y }], 12, await contentSize(app));

        const notes: Record<string, unknown> = {};
        const reading = await burstTo(app, crop, BURST_MS, outDirFor("tool-block"), async () => {
          await body.driveSession({ op: "send", text: "Build the site, make the caption edit, and check the types." });
          await pollFor(
            () => body.evalJS<number>(`document.querySelectorAll(${JSON.stringify(BLOCKS)}).length`).catch(() => 0),
            (n) => n >= CALLS.length,
            BURST_MS,
          );
          await Bun.sleep(600);
          // Where the blocks stand, in the crop's points, for the cut the site makes.
          const rects = await body.evalJS<{ x: number; y: number; width: number; height: number }[]>(
            `[...document.querySelectorAll(${JSON.stringify(BLOCKS)})].map(function (el) { var r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })`,
          );
          notes.blocks = rects.map((r) => ({ x: view.x + r.x - crop.x, y: view.y + r.y - crop.y, width: r.width, height: r.height }));
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
