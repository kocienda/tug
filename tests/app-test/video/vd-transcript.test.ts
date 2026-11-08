/**
 * vd-transcript.test.ts — the video's transcript shot: one Session card
 * through one whole turn, so the viewer sees what the narration names — the
 * prompt submitted, the model's reply, an edit, a command, a test run with
 * its panel, and a commit landing as a receipt — scrolling by in one column.
 *
 * A video tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. It lives beside the site's
 * drivers (`../site-clips/`) and shares their helpers and their gate: run by
 * path, once per mode, with `TUG_SITE_CLIPS_OUT` and `TUG_SITE_CLIPS_MODE`
 * set; with either unset it skips. The `vids` repo's `tools/shot.py` is the
 * usual caller and encodes the frames to ProRes for Final Cut.
 *
 *   TUG_SITE_CLIPS_OUT=/tmp/video-shots TUG_SITE_CLIPS_MODE=dark \
 *     TUG_APPTEST_FILE_BUDGET_SECS=150 just app-test video/vd-transcript.test.ts
 *
 * The scene is built the way `sc-inline-dialog.test.ts` builds its turn: a
 * card bound synthetically, the prompt sent through the card, then the
 * turn's frames ingested on the code feed on a timeline. Its content is a
 * real fix from the `vids` repository (its commit `92efe55`): the Edge
 * Insert template's drop zone made frame-sized. The edit's before and after
 * are lines of that diff, the build's and the tests' output are what those
 * commands print there, the test panel names the suite's ten tests, and the
 * commit receipt carries that commit's own hash and stat. The pace is a
 * narration's, slower than the site's loops, and the transcript follows its
 * tail as the turn lands.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { CODE_OUTPUT_FEED } from "../arc-run-transcript-fixture";
import { press } from "../site-clips/_components";
import { MODE, RUNS, cropFor, expectRecorded, launchForMode, outDirFor, scene } from "../site-clips/_site-clips";

const TEST_TIMEOUT_MS = 150_000;
const SHOT = "transcript";
const CARD = "vd-transcript";
const TUG_SESSION_ID = "vd-transcript-session";
const PROJECT_NAME = "vids";
/** The session's identity as a ledger would hold it, and the Observer's line for the turn. */
const IDENTITY = { name: "edge-insert", name_user_set: true, tag: "chirpy-rise", synopsis: "Fill the Edge Insert drop zone to the frame" };
const CURRENT = "Make the drop zone frame-sized and default Side to Bottom";
const COMMIT_DISCLOSURE = '[data-tool-use-id="tu-commit"] [data-slot="tool-call-header-disclosure"]';

/** One card, as tall as the turn needs and no taller: the column the narration is about. */
const CONTENT_SIZE = { width: 860, height: 940 };
const PANE = { x: 20, y: 20, width: 820, height: 900 };
const SETTLE_MS = 1_500;

/** Pace: a word of prose, and the beat between a report and the next. */
const WORD_MS = 55;
const TEST_MS = 260;

const PROMPT = "The Edge Insert drop zone leaves a gap at the frame edge. Fill the frame and default the side to Bottom.";
const REPLY =
  "The zone is a 3840 square, so the strip shows the middle of the dropped picture instead of its edge. " +
  "I'll make the drop zone frame-sized, offset the content per side so the strip is that edge, and default Side to Bottom.";
const CLOSING =
  "Done. The zone now fills the frame, all ten tests pass, and the fix is committed as 92efe55. " +
  "Open the template in Motion and check the Bottom side against a lower-third card.";

const FILE = "gen/effects/edge_insert.py";
const EDIT_OLD = `    graphic = Image("Graphic", doc.ids.take(), source=False, clip=dz_clip, zone_size=width)
    content = Group("Content", doc.ids.take(), children=[graphic],
                    transform=transform_block(position={"X": half}, rotation=0))`;
const EDIT_NEW = `    graphic = Image("Graphic", doc.ids.take(), source=False, clip=dz_clip, zone=(width, height))
    content = Group("Content", doc.ids.take(), children=[graphic],
                    transform=transform_block(position={"X": 0}, rotation=0))`;

const BUILD_CMD = "python3 -m gen.build";
const BUILD_OUT = [
  "built templates/Split Screen/Split Screen.moef",
  "built templates/Two-Up/Two-Up.moef",
  "built templates/Two-Up Inset/Two-Up Inset.moef",
  "built templates/Edge Insert/Edge Insert.moef",
].join("\n");

const TEST_CMD = "python3 -m unittest discover -s tests 2>&1 | tail -3";
const TEST_OUT = "----------------------------------------------------------------------\nRan 10 tests in 0.027s\n\nOK";
/** The suite's tests, in the order unittest runs them; each is a cell of the run panel. */
const TESTS = [
  "EdgeInsert.test_rigs_on_a_top_level_layer_name_the_layer_class",
  "EdgeInsert.test_strip_geometry_and_controls",
  "SplitScreenVersusGolden.test_background_spans_project_and_sits_below",
  "SplitScreenVersusGolden.test_effect_source_animation",
  "SplitScreenVersusGolden.test_no_stray_keyframes",
  "SplitScreenVersusGolden.test_publish_order_and_names",
  "SplitScreenVersusGolden.test_rig_is_fixed",
  "SplitScreenVersusGolden.test_settings_and_markers",
  "Structural.test_all_effects",
  "TwoUp.test_graphic_zone",
];

const COMMIT_MSG = "fix(edge-insert): fill frame-sized drop zone, default to Bottom";
const COMMIT_CMD = `git commit -am "${COMMIT_MSG}"`;
const COMMIT_OUT = `[main 92efe55] ${COMMIT_MSG}\n 5 files changed, 81 insertions(+), 38 deletions(-)`;

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: `${CARD}-pane`,
        position: { x: PANE.x, y: PANE.y },
        size: { width: PANE.width, height: PANE.height },
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

function ingest(app: App, decoded: Record<string, unknown>): Promise<unknown> {
  return app.driveSession(CARD, {
    op: "ingestFrame",
    feedId: CODE_OUTPUT_FEED,
    decoded: { tug_session_id: TUG_SESSION_ID, ipc_version: 2, ...decoded },
  });
}

/** The usage frame the status row's context cell reads: the window at `tokens`. */
function usage(tokens: number): Record<string, number> {
  return { input_tokens: 2_400, output_tokens: 1_800, cache_creation_input_tokens: 6_200, cache_read_input_tokens: tokens - 10_400 };
}

/** The words of `text`, each with the space that follows it, so the deltas re-join to the text. */
function deltasOf(text: string): string[] {
  return text.split(" ").map((w, i, all) => (i < all.length - 1 ? `${w} ` : w));
}

describe.skipIf(!RUNS)("video shot: the transcript", () => {
  test(
    "records one turn — prompt, reply, edit, build, test run and commit — landing in a tall card",
    async () => {
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "vd-transcript-")));
      onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
      const projectDir = join(scratch, PROJECT_NAME);
      mkdirSync(projectDir);
      const app = await launchForMode("vd-transcript", deck(), undefined, { contentSize: CONTENT_SIZE });
      try {
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD)})`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession(CARD, { tugSessionId: TUG_SESSION_ID, projectDir, workspaceKey: projectDir });
        await app.awaitEngineReady(CARD, { timeoutMs: 30_000 });
        await app.ingestSessionMetadata(CARD, { type: "system_metadata", cwd: projectDir, model: "claude-fable-5-1", version: "2.1.285", permissionMode: "auto", ipc_version: 2 });
        await Bun.sleep(800);
        // The identity a ledger would hold, delivered the way the wire does (at0570).
        await app.body(CARD).evalJS<boolean>(
          `window.__tug.publishSessionUpdated(${JSON.stringify(JSON.stringify({ session_id: TUG_SESSION_ID, fields: IDENTITY }))})`,
        );
        const digest = (text: string, beat: number, kind: string) =>
          app.body(CARD).evalJS<boolean>(
            `window.__tug.publishDigestFrame(${JSON.stringify(JSON.stringify({ type: "digest", text, scopes: [TUG_SESSION_ID], beat, at: Date.now(), kind }))})`,
          );
        const current = () =>
          app.body(CARD).evalJS<boolean>(
            `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify({ kind: "session_current", session_id: TUG_SESSION_ID, at_ms: Date.now(), current: CURRENT }))})`,
          );
        await Bun.sleep(400);

        const crop = await cropFor(app, [CARD], { pad: 0 });

        let seq = 1;
        const s = scene().mark("loop-start", 0);

        // The prompt, submitted; the turn opens on it.
        s.at(700, async () => {
          await app.driveSession(CARD, { op: "send", text: PROMPT });
          await ingest(app, { type: "prompt_anchor", promptUuid: "vd-transcript-p1" });
          await ingest(app, { type: "session_init", session_id: "claude-vd-transcript" });
          await digest(`asked: ${PROMPT}`, 1, "ask");
          await current();
        });

        // The reply, a word at a time.
        const replyAt = 2_000;
        s.at(replyAt, async () => {
          await ingest(app, { type: "streaming_usage", msg_id: "m1", usage: usage(38_600) });
          await ingest(app, { type: "content_block_start", msg_id: "m1", block_index: 0, kind: "text" });
        });
        const replyWords = deltasOf(REPLY);
        replyWords.forEach((w, i) => {
          s.at(replyAt + (i + 1) * WORD_MS, () => ingest(app, { type: "assistant_text", msg_id: "m1", block_index: 0, seq: 1, rev: i, text: w, is_partial: true, status: "partial" }));
        });
        const replyDone = replyAt + (replyWords.length + 1) * WORD_MS;
        s.at(replyDone, () => ingest(app, { type: "assistant_text", msg_id: "m1", block_index: 0, seq: 1, rev: replyWords.length, text: REPLY, is_partial: false, status: "complete" }));

        // The edit.
        const editAt = replyDone + 700;
        s.at(editAt, () =>
          ingest(app, { type: "tool_use", msg_id: "m1", seq: ++seq, tool_name: "Edit", tool_use_id: "tu-edit", input: { file_path: join(projectDir, FILE), old_string: EDIT_OLD, new_string: EDIT_NEW } }),
        );
        s.at(editAt + 1_100, () => ingest(app, { type: "tool_result", tool_use_id: "tu-edit", output: `The file ${join(projectDir, FILE)} has been updated.`, is_error: false }));

        // The build.
        const buildAt = editAt + 2_300;
        s.at(buildAt, () => ingest(app, { type: "tool_use", msg_id: "m1", seq: ++seq, tool_name: "Bash", tool_use_id: "tu-build", input: { command: BUILD_CMD, description: "Generate every template" } }));
        s.at(buildAt + 600, () => ingest(app, { type: "tool_progress", tool_use_id: "tu-build", tool_name: "Bash", elapsed_time_seconds: 1, parent_tool_use_id: null }));
        s.at(buildAt + 1_400, () => ingest(app, { type: "tool_result", tool_use_id: "tu-build", output: BUILD_OUT, is_error: false }));

        // The test run: the panel fills a cell at a time, then the verdict.
        const testAt = buildAt + 2_600;
        s.at(testAt, () => ingest(app, { type: "tool_use", msg_id: "m1", seq: ++seq, tool_name: "Bash", tool_use_id: "tu-test", input: { command: TEST_CMD, description: "Run the structural and golden tests" } }));
        const report = (done: number) =>
          ingest(app, {
            type: "report",
            tool_use_id: "tu-test",
            label: "unittest",
            text: done < TESTS.length ? `${TESTS[done]!.split(".")[1]} running` : `${TESTS.length} passed`,
            done,
            total: TESTS.length,
            failures: 0,
            unit: "test",
            units: TESTS.map((name, i) => ({
              name,
              index: i,
              status: i < done ? "pass" : i === done ? "running" : "pending",
              ...(i < done ? { secs: 0.003 } : {}),
              ...(i === done ? { started_at_ms: Date.now() } : {}),
            })),
          });
        for (let done = 0; done <= TESTS.length; done++) {
          s.at(testAt + 500 + done * TEST_MS, () => report(done));
        }
        const testDone = testAt + 500 + (TESTS.length + 1) * TEST_MS + 500;
        s.at(testDone, () => ingest(app, { type: "tool_result", tool_use_id: "tu-test", output: TEST_OUT, is_error: false }));

        // The commit, which the block renders as a receipt.
        const commitAt = testDone + 1_800;
        s.at(commitAt, () => ingest(app, { type: "tool_use", msg_id: "m1", seq: ++seq, tool_name: "Bash", tool_use_id: "tu-commit", input: { command: COMMIT_CMD, description: "Commit the Edge Insert fix" } }));
        s.at(commitAt + 1_000, () => ingest(app, { type: "tool_result", tool_use_id: "tu-commit", output: COMMIT_OUT, is_error: false }));

        // The closing reply, and the turn's end.
        const closeAt = commitAt + 2_400;
        s.at(closeAt, async () => {
          await ingest(app, { type: "streaming_usage", msg_id: "m2", usage: usage(52_900) });
          await ingest(app, { type: "content_block_start", msg_id: "m2", block_index: 0, kind: "text" });
        });
        const closeWords = deltasOf(CLOSING);
        closeWords.forEach((w, i) => {
          s.at(closeAt + (i + 1) * WORD_MS, () => ingest(app, { type: "assistant_text", msg_id: "m2", block_index: 0, seq: 90, rev: i, text: w, is_partial: true, status: "partial" }));
        });
        const closeDone = closeAt + (closeWords.length + 1) * WORD_MS;
        s.at(closeDone, async () => {
          await ingest(app, { type: "assistant_text", msg_id: "m2", block_index: 0, seq: 90, rev: closeWords.length, text: CLOSING, is_partial: false, status: "complete" });
          await digest(CLOSING, 6, "said");
          await ingest(app, { type: "turn_complete", msg_id: "m2", seq: 91, result: "success" });
        });

        // Open the commit's receipt, and hold on the finished turn.
        s.at(closeDone + 1_800, () => press(app.body(CARD), COMMIT_DISCLOSURE, { index: 0 }));
        const endAt = closeDone + 1_800 + 3_500;
        s.mark("loop-end", endAt);

        const reading = await s.record(app, { outDir: outDirFor(SHOT), crop, settleMs: SETTLE_MS });
        writeFileSync(
          join(outDirFor(SHOT), "shot.json"),
          JSON.stringify({ shot: SHOT, mode: MODE, contentSize: CONTENT_SIZE, pane: PANE, crop, marks: reading.marks, frames: reading.frames, scale: reading.scale }, null, 2),
        );
        expectRecorded(reading);
        const receipts = await app.body(CARD).evalJS<number>(`document.querySelectorAll('[data-slot="commit-block"]').length`);
        expect(receipts, "the commit landed as a receipt").toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
