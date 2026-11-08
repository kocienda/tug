/**
 * vd-session-card.test.ts — the video's session-card sequence, timed to the
 * narration in the `vids` repo (`incoming/session-card-audio.mp4`): one
 * Session card from the moment the narration says "The Tug session card"
 * to the end of the clip, in two bursts of one launch.
 *
 * A video tool, not a test of the app: it stages a scene and records it,
 * and its assertions are that frames were written and the commit landed.
 * It lives beside the site's drivers and shares their helpers and gate
 * (`../site-clips/_site-clips.ts`): run by path, once per mode, with
 * `TUG_SITE_CLIPS_OUT` and `TUG_SITE_CLIPS_MODE` set. The `vids` repo's
 * `tools/shot.py` is the usual caller.
 *
 * Every act is placed at a narration time, in seconds from the start of the
 * audio, and each burst subtracts its own offset: burst A starts at 10.4 s
 * ("The Tug session card gathers this content into one scrolling
 * transcript…") and runs to 25.4 s; burst B starts at 25.4 s ("At the
 * bottom, I type new prompts…") and runs to the clip's end at 42.33 s. The
 * host caps a burst at 30 s, which is why there are two; the cut between
 * them falls in a pause with the card at rest. `vids/tools/assemble.py`
 * places the frames of each burst at its offset.
 *
 * The content is the real Edge Insert fix from the `vids` repo (its commit
 * `92efe55`), staged in a scratch clone: the turn edits the generator,
 * builds, runs the suite (a report panel fills a cell per test), updates
 * the doc and the test, and commits nothing: the commit waits for the
 * user, which is the point of the Changes tab. In burst B a
 * prompt is typed and sent, a bare shell command is typed and runs in the
 * clone's real shell, ⌃⌘C raises the Changes shade over the four files,
 * Auto-Message writes the commit message, and Commit is pressed: a
 * real commit, whose receipt lands in the transcript.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { TUGCODE_TRANSCRIPT_SCHEMA_VERSION, type App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { CODE_OUTPUT_FEED } from "../arc-run-transcript-fixture";
import { pollFor } from "../body-grounding/_frames";
import { stubDirectory } from "../streaming-stub-fixture";
import { typeInto } from "../site-clips/_components";
import { MODE, RUNS, type Scene, cropFor, expectRecorded, launchForMode, outDirFor, scene } from "../site-clips/_site-clips";

const TEST_TIMEOUT_MS = 400_000;
const CARD = "vd-session";
/** The session tugcast spawns for the card: a real one, replaying a stub of two empty turns, so the scratch repo is scanned and the ledger holds a live row. */
const TUG_SESSION_ID = randomUUID();
/** The repo the scene is cloned from: `$TUG_VIDS_REPO`, else the sibling `vids` of the Tug checkout's parent's parent. */
const VIDS_REPO = process.env.TUG_VIDS_REPO ?? resolve(import.meta.dir, "..", "..", "..", "..", "..", "vids");
/** Where the scratch clone lives: a readable path, since the Shell row's header names the directory. Removed when the run ends. */
const SCRATCH_ROOT = process.env.TUG_VIDS_SCRATCH ?? resolve(VIDS_REPO, "..", "scratch");
/** The fix the scene re-enacts, and the commit before it. */
const FIX = "92efe55";
/** The fix's edited files, left modified in the clone for the Changes tab. The regenerated template is left out: the build that would write it is a synthetic block. */
const EDITED = ["gen/effects/edge_insert.py", "gen/ozml.py", "docs/moef-format.md", "tests/test_templates.py"];

/** The narration's timeline: each burst's start, in seconds of audio. */
const BURST_A_AT = 10.4;
const BURST_A_END = 25.4;
const BURST_B_AT = 25.4;
const BURST_B_END = 42.33;

/** One card, 820 × 900 points: the column the narration is about. */
const CONTENT_SIZE = { width: 860, height: 940 };
const PANE = { x: 20, y: 20, width: 820, height: 900 };

const WORD_MS = 50;
const TEST_MS = 250;
const TYPE_MS = 95;

const CURRENT = "Make the drop zone frame-sized and default Side to Bottom";
const POST = "^edge-insert fixed the Edge Insert zone: frame-sized, Side defaulting to Bottom; the generator, the format doc and the layer-class test are changed and waiting to be committed.";

const PROMPT = "The Edge Insert drop zone leaves a gap at the frame edge. Fill the frame and default the side to Bottom.";
const REPLY =
  "The zone is a 3840 square, so the strip shows the middle of the dropped picture instead of its edge. " +
  "I'll make the drop zone frame-sized, offset the content per side so the strip is that edge, and default Side to Bottom.";
const CLOSING = "Done. The zone fills the frame and all ten tests pass. Four files changed; review them in Changes when you're ready to commit.";
const PROMPT_2 = "Install the template and open it in Motion.";
const REPLY_2 = "Installed under the Tug category; Motion is opening Edge Insert.";
const SHELL_LINE = "git status --short";

const EDITS: ReadonlyArray<{ id: string; path: string; old: string; new: string }> = [
  {
    id: "tu-edit-1",
    path: "gen/effects/edge_insert.py",
    old: `    graphic = Image("Graphic", doc.ids.take(), source=False, clip=dz_clip, zone_size=width)
    content = Group("Content", doc.ids.take(), children=[graphic],
                    transform=transform_block(position={"X": half}, rotation=0))`,
    new: `    graphic = Image("Graphic", doc.ids.take(), source=False, clip=dz_clip, zone=(width, height))
    content = Group("Content", doc.ids.take(), children=[graphic],
                    transform=transform_block(position={"X": 0}, rotation=0))`,
  },
  {
    id: "tu-edit-2",
    path: "gen/ozml.py",
    old: `GROUP_UUID = "44da0700f6ab11d68c24000393670732"  # affectingFactory of a group's rig behavior (golden)`,
    new: `GROUP_UUID = "44da0700f6ab11d68c24000393670732"  # affectingFactory of a group's rig behavior (golden)
LAYER_UUID = "ee6b4918387a11d7a02100039375d2ba"  # the same for a top-level <layer>: Apple's rigs on layers name this class, never the group's`,
  },
  {
    id: "tu-docs",
    path: "docs/moef-format.md",
    old: `- How Final Cut fits 16:9 media into a square drop zone (Fit, Fit Factor 3.2):
  Edge Insert and Two-Up both assume it is fitted and centred.`,
    new: `- Final Cut **fills** a drop zone with the dropped media, centred (a 16:9 graphic
  in Edge Insert's first square zone came out 1.78× frame size, cropped at the
  sides). A frame-sized zone (\`Width\` 3840, \`Height\` 2160, Fit Factor 3.2 × 1.8)
  therefore shows 16:9 media at exactly frame size; whether the per-axis Fit
  Factor matters is unverified, since every Apple ordinary zone is square.`,
  },
  {
    id: "tu-tests",
    path: "tests/test_templates.py",
    old: `        # the content sits in the middle of the strip, and is counter-rotated per side
        self.assertIn("rig ./1/100/101/1 by 'Overlap' snapshots ['1920', '960']", lines)`,
    new: `        # the picture is counter-rotated per side and put back on the frame, so the strip is its edge
        self.assertIn("rig ./1/100/101/1 by 'Side' snapshots ['0', '0', '840', '840']", lines)`,
  },
];

const BUILD_CMD = "python3 -m gen.build";
const BUILD_OUT = [
  "built templates/Split Screen/Split Screen.moef",
  "built templates/Two-Up/Two-Up.moef",
  "built templates/Two-Up Inset/Two-Up Inset.moef",
  "built templates/Edge Insert/Edge Insert.moef",
].join("\n");
const TEST_CMD = "python3 -m unittest discover -s tests 2>&1 | tail -3";
const TEST_OUT = "----------------------------------------------------------------------\nRan 10 tests in 0.027s\n\nOK";
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
/** The message Auto-Message writes for the four files. */
const MESSAGE =
  "fix(edge-insert): fill frame-sized drop zone, default to Bottom\n" +
  "\n" +
  "- gen/effects/edge_insert.py: a frame-sized drop zone (3840×2160), the content offset per side so the strip is that edge, and Side defaulting to Bottom\n" +
  "- gen/ozml.py: LAYER_UUID, so rigs on a top-level layer name the layer class Motion honours\n" +
  "- docs/moef-format.md: the Group and Layer UUIDs, and that Final Cut fills a drop zone with the dropped media\n" +
  "- tests/test_templates.py: Edge Insert expects the Side-driven X rig and the frame-sized zone, and a new test checks the layer-class rig";

const EDITOR = '[data-slot="tug-text-editor"] .cm-content';
const SHEET = '.session-view-pane[data-view="changes"] [data-slot="tug-sheet"]';
const ANY_ROWS = `${SHEET} [data-testid="tug-changes-list-file-block"]`;
const COMMIT_BUTTON = '[data-testid="tug-prompt-entry-commit-button"]';
const RECEIPT = '[data-slot="tug-commit-changes-list"] [data-testid="tug-changes-list-file-block"]';
const SHELL_ROWS = '[data-slot="session-transcript-shell-row"]';

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** The scratch clone: `vids` at the commit before the fix, with the fix's four edited files modified in the tree for the Changes tab. */
function makeRepo(root: string): string {
  const repo = join(root, "vids");
  execFileSync("git", ["clone", "-q", VIDS_REPO, repo]);
  git(repo, "config", "user.email", "kocienda@mac.com");
  git(repo, "config", "user.name", "Ken Kocienda");
  git(repo, "checkout", "-q", "-B", "main", `${FIX}^`);
  git(repo, "checkout", "-q", FIX, "--", ...EDITED);
  git(repo, "reset", "-q");
  return repo;
}

/** Two turns with nothing to replay: the driver streams each turn itself, on the narration's clock. */
function stubTranscript(): unknown {
  return {
    schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION,
    tugcodeVersion: "stub",
    turns: [
      { index: 0, description: "the fix, streamed by the driver", outputs: [] },
      { index: 1, description: "the install, streamed by the driver", outputs: [] },
    ],
  };
}

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
  return app.driveSession(CARD, { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded: { tug_session_id: TUG_SESSION_ID, ipc_version: 2, ...decoded } });
}

function usage(tokens: number): Record<string, number> {
  return { input_tokens: 2_400, output_tokens: 1_800, cache_creation_input_tokens: 6_200, cache_read_input_tokens: tokens - 10_400 };
}

function deltasOf(text: string): string[] {
  return text.split(" ").map((w, i, all) => (i < all.length - 1 ? `${w} ` : w));
}

/** The scribe's stream: the message so far, two words at a time. */
function draftDeltas(message: string): string[] {
  const words = message.match(/\S+\s*/g) ?? [message];
  const out: string[] = [];
  let sofar = "";
  words.forEach((w, i) => {
    sofar += w;
    if (i % 2 === 1 || i === words.length - 1) out.push(sofar);
  });
  return out;
}

/** Stream `text` as one assistant block from `at` ms; answers when the block is complete. */
function streamText(s: Scene, app: App, at: number, msgId: string, seq: number, text: string, tokens: number): number {
  s.at(at, async () => {
    await ingest(app, { type: "streaming_usage", msg_id: msgId, usage: usage(tokens) });
    await ingest(app, { type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text" });
  });
  const words = deltasOf(text);
  words.forEach((w, i) => {
    s.at(at + (i + 1) * WORD_MS, () => ingest(app, { type: "assistant_text", msg_id: msgId, block_index: 0, seq, rev: i, text: w, is_partial: true, status: "partial" }));
  });
  const done = at + (words.length + 1) * WORD_MS;
  s.at(done, () => ingest(app, { type: "assistant_text", msg_id: msgId, block_index: 0, seq, rev: words.length, text, is_partial: false, status: "complete" }));
  return done;
}

describe.skipIf(!RUNS)("video: the session card sequence", () => {
  test(
    "records the turn, then the entry, the shell, the Changes tab and the commit, timed to the narration",
    async () => {
      mkdirSync(SCRATCH_ROOT, { recursive: true });
      const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, "run-")));
      onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
      const repo = makeRepo(scratch);
      const stubDir = stubDirectory();
      writeFileSync(join(stubDir, `${TUG_SESSION_ID}.json`), JSON.stringify(stubTranscript()));

      const app = await launchForMode("vd-session-card", deck(), stubDir, { contentSize: CONTENT_SIZE });
      try {
        await app.waitForCondition<boolean>(`(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD)})`, { timeoutMs: 30_000 });
        await app.spawnSessionNew(CARD, { tugSessionId: TUG_SESSION_ID, projectDir: repo });
        await pollFor(
          () =>
            app
              .body(CARD)
              .evalJS<boolean>(`document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelector('.session-card-picker-form') === null`)
              .catch(() => false),
          (bound) => bound,
          30_000,
        );
        await app.ingestSessionMetadata(CARD, { type: "system_metadata", cwd: repo, model: "claude-fable-5-1", version: "2.1.285", permissionMode: "auto", ipc_version: 2 });
        await Bun.sleep(800);
        const body = app.body(CARD);
        // The masthead keeps the name the real ledger gives the spawned session: a published identity would be overridden two seconds in.
        const digest = (text: string, beat: number, kind: string) =>
          body.evalJS<boolean>(`window.__tug.publishDigestFrame(${JSON.stringify(JSON.stringify({ type: "digest", text, scopes: [TUG_SESSION_ID], beat, at: Date.now(), kind }))})`);
        const current = () =>
          body.evalJS<boolean>(`window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify({ kind: "session_current", session_id: TUG_SESSION_ID, at_ms: Date.now(), current: CURRENT }))})`);
        const draftFrame = (frame: Record<string, unknown>) =>
          body.evalJS<boolean>(`window.__tug.publishDraftFrame(${JSON.stringify(JSON.stringify({ workspace_key: repo, owner_kind: "session", owner_id: TUG_SESSION_ID, ...frame }))})`);
        await Bun.sleep(400);
        const crop = await cropFor(app, [CARD], { pad: 0 });
        const ms = (audioSecs: number, offset: number) => Math.round((audioSecs - offset) * 1000);

        // ---- Burst A: the turn ------------------------------------------
        const a = scene().mark("loop-start", 0);
        const A = (t: number) => ms(t, BURST_A_AT);
        let seq = 1;
        a.at(A(10.7), async () => {
          await app.driveSession(CARD, { op: "send", text: PROMPT });
          await ingest(app, { type: "prompt_anchor", promptUuid: "vd-p1" });
          await digest(`asked: ${PROMPT}`, 1, "ask");
          await current();
        });
        streamText(a, app, A(12.0), "m1", seq, REPLY, 38_600);
        const edit = (at: number, e: (typeof EDITS)[number], resultAfter: number) => {
          a.at(at, () => ingest(app, { type: "tool_use", msg_id: "m1", seq: ++seq, tool_name: "Edit", tool_use_id: e.id, input: { file_path: join(repo, e.path), old_string: e.old, new_string: e.new } }));
          a.at(at + resultAfter, () => ingest(app, { type: "tool_result", tool_use_id: e.id, output: `The file ${join(repo, e.path)} has been updated.`, is_error: false }));
        };
        edit(A(14.6), EDITS[0]!, 800);
        edit(A(15.6), EDITS[1]!, 700);
        a.at(A(16.6), () => ingest(app, { type: "tool_use", msg_id: "m1", seq: ++seq, tool_name: "Bash", tool_use_id: "tu-build", input: { command: BUILD_CMD, description: "Generate every template" } }));
        a.at(A(17.1), () => ingest(app, { type: "tool_progress", tool_use_id: "tu-build", tool_name: "Bash", elapsed_time_seconds: 1, parent_tool_use_id: null }));
        a.at(A(17.6), () => ingest(app, { type: "tool_result", tool_use_id: "tu-build", output: BUILD_OUT, is_error: false }));
        const testAt = A(18.1);
        a.at(testAt, () => ingest(app, { type: "tool_use", msg_id: "m1", seq: ++seq, tool_name: "Bash", tool_use_id: "tu-test", input: { command: TEST_CMD, description: "Run the structural and golden tests" } }));
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
        for (let done = 0; done <= TESTS.length; done++) a.at(testAt + 400 + done * TEST_MS, () => report(done));
        a.at(A(21.3), () => ingest(app, { type: "tool_result", tool_use_id: "tu-test", output: TEST_OUT, is_error: false }));
        // No commit here: that waits for the user and the Changes tab in burst B.
        edit(A(21.7), EDITS[2]!, 600);
        edit(A(22.5), EDITS[3]!, 600);
        const closeDone = streamText(a, app, A(23.3), "m2", 90, CLOSING, 52_900);
        a.at(closeDone, async () => {
          await digest(CLOSING, 6, "said");
          await ingest(app, { type: "turn_complete", msg_id: "m2", seq: 91, result: "success" });
          await body.evalJS<boolean>(
            `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify({ id: 9101, at_ms: Date.now(), author: "observer", body: POST, refs: [], session_id: TUG_SESSION_ID, wake_reason: "sitrep", project_dir: repo }))})`,
          );
        });
        a.mark("loop-end", A(BURST_A_END));
        const readingA = await a.record(app, { outDir: outDirFor("session-card-a"), crop, settleMs: 300 });
        expectRecorded(readingA);

        // Between the bursts: the ledger's account of the two edits left for
        // the Changes tab, so the shade lists them under this session (as
        // sc-changes-commit seeds it), and one file rewritten so the
        // aggregate recomposes against the rows.
        app.seedLedger({
          file_events: EDITS.map((e) => ({
            tug_session_id: TUG_SESSION_ID,
            tool_use_id: e.id,
            file_path: join(repo, e.path),
            tool_name: "Edit",
            op: "write",
            origin: "exact",
            ambiguous: false,
            project_dir: repo,
            at: Date.now(),
          })),
        });
        const docs = join(repo, EDITED[2]!);
        writeFileSync(docs, readFileSync(docs));
        await Bun.sleep(1_500);
        await body.nativeClickAtElement(EDITOR);
        await Bun.sleep(500);

        // ---- Burst B: the entry, the shell, the Changes tab, the commit ---
        const b = scene().mark("loop-start", 0);
        const B = (t: number) => ms(t, BURST_B_AT);
        const notes: Record<string, unknown> = {};
        // "At the bottom, I type new prompts."
        const typedAt = typeInto(b, B(26.0), app, PROMPT_2, TYPE_MS);
        b.at(typedAt + 250, async () => {
          await app.nativeKey("Enter", ["cmd"]);
          await ingest(app, { type: "prompt_anchor", promptUuid: "vd-p2" });
        });
        const reply2Done = streamText(b, app, typedAt + 900, "m3", 95, REPLY_2, 53_400);
        b.at(reply2Done, () => ingest(app, { type: "turn_complete", msg_id: "m3", seq: 96, result: "success" }));
        // "I can also type shell commands."
        const shellAt = Math.max(B(28.5), reply2Done + 200);
        b.at(shellAt, () => body.nativeClickAtElement(EDITOR));
        const shellTyped = typeInto(b, shellAt + 200, app, SHELL_LINE, TYPE_MS);
        b.at(shellTyped + 250, async () => {
          await app.nativeKey("Enter", ["cmd"]);
          await body.waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}).length >= 1`, { timeoutMs: 15_000 });
        });
        // "Then there's also the changes tab, which shows the files this session has changed"
        b.at(B(30.6), async () => {
          await app.nativeKey("c", ["ctrl", "cmd"]);
          await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(SHEET)}) !== null`, { timeoutMs: 20_000 });
          await body.waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(ANY_ROWS)}).length >= ${EDITED.length}`, { timeoutMs: 20_000 });
          notes.commitMode = await body.evalJS<boolean>(`document.querySelector(${JSON.stringify(COMMIT_BUTTON)}) !== null`);
        });
        // "and auto generates a commit message I can edit."
        b.at(B(34.9), () => draftFrame({ action: "changeset_draft_state", state: "drafting" }));
        const words = draftDeltas(MESSAGE);
        words.forEach((text, i) => b.at(B(35.3) + i * 50, () => draftFrame({ action: "changeset_draft_delta", text })));
        b.at(B(35.3) + words.length * 50 + 100, () => draftFrame({ action: "changeset_draft_state", state: "ready" }));
        // "I can do the commit right here too"
        b.at(B(38.4), async () => {
          await body.nativeClickAtElement(COMMIT_BUTTON);
          await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(RECEIPT)}) !== null`, { timeoutMs: 60_000 });
          notes.committed = git(repo, "log", "-1", "--format=%s");
        });
        b.mark("loop-end", B(BURST_B_END));
        const readingB = await b.record(app, { outDir: outDirFor("session-card-b"), crop, settleMs: 300 });

        for (const [name, reading] of [["session-card-a", readingA], ["session-card-b", readingB]] as const) {
          writeFileSync(
            join(outDirFor(name), "shot.json"),
            JSON.stringify({ shot: name, mode: MODE, audioOffsetSecs: name.endsWith("-a") ? BURST_A_AT : BURST_B_AT, contentSize: CONTENT_SIZE, pane: PANE, crop, marks: reading.marks, frames: reading.frames, scale: reading.scale, notes }, null, 2),
          );
        }
        expectRecorded(readingB);
        expect(notes.committed, "the press produced the commit it asked for").toBe(MESSAGE.split("\n")[0]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
