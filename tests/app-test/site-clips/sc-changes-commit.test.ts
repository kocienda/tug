/**
 * sc-changes-commit.test.ts — the site's changes-commit clip: the Changes
 * shade rises over a session that has edited three files, the composer
 * becomes the message field, and Auto-Message writes the commit message
 * into it.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: a scratch git repository shaped like the site's checkout, with
 * three tracked files edited and uncommitted; one Session card bound to a
 * stub transcript whose one turn, played before the burst, is the three
 * Edit calls that made those edits. The ledger is seeded with the same
 * three calls (the way at0334 reaches a session entry), so the shade lists
 * the files under "changes in this session" rather than as unattributed.
 * During the burst ⌃⌘C raises the shade and, on the empty composer, enters
 * commit mode; then the scribe's stream arrives the way at0497 delivers it,
 * as `changeset_draft_*` CONTROL frames through the test surface, and the
 * message writes itself into the composer under the wave. Then the Commit
 * press, a real click the way at0607 makes it: the commit lands in the
 * scratch repository and its receipt settles into the transcript. The
 * capture covers the card; the site's `make-clip --crop` cuts the shade and
 * the composer out of it.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { TUGCODE_TRANSCRIPT_SCHEMA_VERSION, type App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { pollFor } from "../body-grounding/_frames";
import { stubDirectory } from "../streaming-stub-fixture";
import { RUNS, burstTo, contentSize, cropAround, launchForMode, outDirFor, standIns } from "./_site-clips";

const TEST_TIMEOUT_MS = 140_000;
const CARD = "sc-changes";
const IPC_VERSION = 2;
const PACE_MS = 120;
const PROJECT_NAME = "tug-site";
const BOUND_MS = 30_000;
const STREAMING_MS = 20_000;

const SHEET = '.session-view-pane[data-view="changes"] [data-slot="tug-sheet"]';
const SESSION_ROWS = `${SHEET} .tug-changes-list-file-list[data-entry-kind="session"] [data-testid="tug-changes-list-file-block"]`;
const ANY_ROWS = `${SHEET} [data-testid="tug-changes-list-file-block"]`;
const COMMIT_BUTTON = '[data-testid="tug-prompt-entry-commit-button"]';
const AUTO_BUTTON = '[data-testid="tug-prompt-entry-commit-auto"]';
const RECEIPT = '[data-slot="tug-commit-changes-list"] [data-testid="tug-changes-list-file-block"]';
const PROMPT_PHASE = `(function(){ var e = document.querySelector('[data-slot="tug-prompt-entry"]'); return e === null ? null : e.getAttribute("data-phase"); })()`;

/** The burst, and its beats: the card at rest, the shade rising, the files read, the message written, read, and committed. */
const BURST_MS = 9_800;
const REST_MS = 700;
const SHADE_MS = 1_800;
const DELTA_MS = 50;
const READY_MS = 1_100;
const RECEIPT_MS = 60_000;

/** The files the session edited: their committed form, and the edit. */
const FILES: ReadonlyArray<{ path: string; before: string; after: string; old: string; new: string }> = [
  {
    path: "src/components/Clip.astro",
    before: [
      "---",
      "// Clip — a short H.264 loop with a poster, shown in place and opened at native size.",
      "const { src, poster, alt, caption } = Astro.props;",
      "---",
      "<figure class=\"clip\">",
      "  <video src={src} poster={poster} muted loop playsinline preload=\"none\"></video>",
      "  <figcaption>{caption}</figcaption>",
      "</figure>",
      "<div class=\"clip-overlay\" hidden>",
      "  <video controls muted loop playsinline></video>",
      "</div>",
      "<script>",
      "  overlay.addEventListener(\"click\", (event) => {",
      "    const target = event.target as HTMLElement;",
      "    if (target.closest(\"video\")) return;",
      "    close(overlay);",
      "  });",
      "</script>",
      "",
    ].join("\n"),
    after: [
      "---",
      "// Clip — a short H.264 loop with a poster, shown in place and opened at native size.",
      "const { src, poster, alt, caption } = Astro.props;",
      "---",
      "<figure class=\"clip\">",
      "  <video src={src} poster={poster} muted loop playsinline preload=\"none\"></video>",
      "  <figcaption>{caption}</figcaption>",
      "</figure>",
      "<div class=\"clip-overlay\" hidden>",
      "  <video muted loop playsinline></video>",
      "</div>",
      "<script>",
      "  overlay.addEventListener(\"click\", (event) => {",
      "    const target = event.target as HTMLElement;",
      "    const video = target.closest<HTMLVideoElement>(\"video\");",
      "    if (video) {",
      "      if (video.paused) video.play().catch(() => {});",
      "      else video.pause();",
      "      return;",
      "    }",
      "    close(overlay);",
      "  });",
      "</script>",
      "",
    ].join("\n"),
    old: "    if (target.closest(\"video\")) return;",
    new: "    const video = target.closest<HTMLVideoElement>(\"video\");\n    if (video) {\n      if (video.paused) video.play().catch(() => {});\n      else video.pause();\n      return;\n    }",
  },
  {
    path: "src/pages/tug/index.astro",
    before: [
      "---",
      "import Clip from \"../../components/Clip.astro\";",
      "import busyDoneClip from \"../../assets/tug/motion/busy-done-dark.mp4\";",
      "---",
      "<h4 class=\"tug-heading tug-heading-sm\">The session card</h4>",
      "<div class=\"not-prose my-8 grid gap-6 sm:grid-cols-3\">",
      "  <Clip src={busyDoneClip} caption=\"A session goes from busy to done.\" />",
      "</div>",
      "<h4 class=\"tug-heading tug-heading-sm\">Other cards</h4>",
      "",
    ].join("\n"),
    after: [
      "---",
      "import Clip from \"../../components/Clip.astro\";",
      "import busyDoneClip from \"../../assets/tug/motion/busy-done-dark.mp4\";",
      "import inlineDialogClip from \"../../assets/tug/motion/inline-dialog-dark.mp4\";",
      "import changesCommitClip from \"../../assets/tug/motion/changes-commit-dark.mp4\";",
      "---",
      "<h4 class=\"tug-heading tug-heading-sm\">The session card</h4>",
      "<div class=\"not-prose my-8 grid gap-6 sm:grid-cols-3\">",
      "  <Clip src={busyDoneClip} caption=\"A session goes from busy to done.\" />",
      "  <Clip src={inlineDialogClip} caption=\"A question is asked and answered inline.\" />",
      "  <Clip src={changesCommitClip} caption=\"The Changes tab writes the commit message.\" />",
      "</div>",
      "<h4 class=\"tug-heading tug-heading-sm\">Other cards</h4>",
      "",
    ].join("\n"),
    old: "  <Clip src={busyDoneClip} caption=\"A session goes from busy to done.\" />",
    new: "  <Clip src={busyDoneClip} caption=\"A session goes from busy to done.\" />\n  <Clip src={inlineDialogClip} caption=\"A question is asked and answered inline.\" />\n  <Clip src={changesCommitClip} caption=\"The Changes tab writes the commit message.\" />",
  },
  {
    path: "src/assets/tug/motion/README.md",
    before: [
      "# Motion clips",
      "",
      "| Clip | Mode | Driver | Tug commit | Frames kept |",
      "|------|------|--------|------------|-------------|",
      "| `busy-done` | dark | `sc-busy-done.test.ts` | `d8de39d4b` | `0003–0287` |",
      "| `busy-done` | light | `sc-busy-done.test.ts` | `d8de39d4b` | `0003–0287` |",
      "",
    ].join("\n"),
    after: [
      "# Motion clips",
      "",
      "| Clip | Mode | Driver | Tug commit | Frames kept |",
      "|------|------|--------|------------|-------------|",
      "| `busy-done` | dark | `sc-busy-done.test.ts` | `d8de39d4b` | `0003–0287` |",
      "| `busy-done` | light | `sc-busy-done.test.ts` | `d8de39d4b` | `0003–0287` |",
      "| `inline-dialog` | dark | `sc-inline-dialog.test.ts` | `7394a8a9b` | `0000–0296` |",
      "| `inline-dialog` | light | `sc-inline-dialog.test.ts` | `7394a8a9b` | `0000–0296` |",
      "",
    ].join("\n"),
    old: "| `busy-done` | light | `sc-busy-done.test.ts` | `d8de39d4b` | `0003–0287` |",
    new: "| `busy-done` | light | `sc-busy-done.test.ts` | `d8de39d4b` | `0003–0287` |\n| `inline-dialog` | dark | `sc-inline-dialog.test.ts` | `7394a8a9b` | `0000–0296` |\n| `inline-dialog` | light | `sc-inline-dialog.test.ts` | `7394a8a9b` | `0000–0296` |",
  },
];

/** The message the scribe writes. */
const MESSAGE =
  "site(tug-home): play the inline dialog and the Changes shade as clips\n" +
  "\n" +
  "Two more tiles under the session card move: a question answered in the transcript, and a commit message written into the composer from the Changes shade. Both are recorded through the app-test harness in both modes.\n" +
  "\n" +
  "- Clip.astro: no browser controls over the picture; a click pauses and plays it\n" +
  "- index.astro: the two clips sit under the session card, above Other cards\n" +
  "- motion/README.md: rows for the new clips";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** The scratch checkout: the files committed, then edited. */
function makeRepo(root: string): string {
  const repo = join(root, PROJECT_NAME);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "ken@example.com");
  git(repo, "config", "user.name", "Ken Kocienda");
  for (const f of FILES) {
    mkdirSync(dirname(join(repo, f.path)), { recursive: true });
    writeFileSync(join(repo, f.path), f.before);
  }
  writeFileSync(join(repo, "README.md"), "# tug-site\n\nStatic site + blog for Tug.\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "site(tug-home): swap tool and status stills for clips");
  for (const f of FILES) writeFileSync(join(repo, f.path), f.after);
  return repo;
}

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: `${CARD}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 720, height: 820 },
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

const toolUseId = (i: number): string => `toolu_sc_changes_${i + 1}`;

/** One turn: the three edits, each an Edit call that opens, beats and returns, and a closing line. */
function transcript(repo: string): unknown {
  const outputs: unknown[] = [];
  FILES.forEach((f, i) => {
    const id = toolUseId(i);
    outputs.push({ type: "tool_use", msg_id: "stub-sc-changes-m1", seq: i, tool_name: "Edit", tool_use_id: id, input: { file_path: join(repo, f.path), old_string: f.old, new_string: f.new }, ipc_version: IPC_VERSION });
    for (let b = 1; b <= 3; b++) {
      outputs.push({ type: "tool_progress", tool_use_id: id, tool_name: "Edit", elapsed_time_seconds: 0, parent_tool_use_id: null, ipc_version: IPC_VERSION });
    }
    outputs.push({ type: "tool_result", tool_use_id: id, output: `The file ${join(repo, f.path)} has been updated successfully.`, is_error: false, ipc_version: IPC_VERSION });
  });
  const text = "The overlay toggles on a click, the two clips sit under the session card, and the README has their rows. Three files changed; the build is green.";
  outputs.push({ type: "content_block_start", msg_id: "stub-sc-changes-m2", block_index: 0, kind: "text", ipc_version: IPC_VERSION });
  outputs.push({ type: "assistant_text", msg_id: "stub-sc-changes-m2", block_index: 0, seq: FILES.length, rev: 0, text, is_partial: false, status: "complete", ipc_version: IPC_VERSION });
  outputs.push({ type: "turn_complete", msg_id: "stub-sc-changes-m2", seq: FILES.length + 1, result: "success", ipc_version: IPC_VERSION });
  return { schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION, tugcodeVersion: "stub", paceMs: PACE_MS, turns: [{ index: 0, description: "three edits", outputs }] };
}

async function bindStub(app: App, stubDir: string, repo: string): Promise<string> {
  const tugSessionId = randomUUID();
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(transcript(repo)));
  await app.spawnSessionNew(CARD, { tugSessionId, projectDir: repo });
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

/** The scribe's stream: the message so far, a few words at a time. */
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

describe.skipIf(!RUNS)("site clip: changes and commit message", () => {
  test(
    "records the shade rising, the message written into the composer, and the commit’s receipt",
    async () => {
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sc-changes-")));
      onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
      const repo = makeRepo(scratch);
      const stubDir = stubDirectory();
      const app = await launchForMode("sc-changes-commit", deck(), stubDir);
      try {
        const sid = await bindStub(app, stubDir, repo);
        await Bun.sleep(800);
        const body = app.body(CARD);
        const phase = () => body.evalJS<string | null>(PROMPT_PHASE).catch(() => null);

        // The turn that made the edits, played out before a frame is taken.
        await body.driveSession({ op: "send", text: "Make the overlay click toggle the video, add the two clips to the home page, and note them in the README." });
        await pollFor(phase, (p) => p === "streaming", STREAMING_MS);
        await pollFor(phase, (p) => p !== null && p !== "streaming", STREAMING_MS);

        // The ledger's account of the same three calls, so the shade lists
        // the files under this session. Seeded after launch (tugcast sweeps
        // live rows at boot), then one file rewritten so the aggregate
        // recomposes against the rows.
        app.seedLedger({
          file_events: FILES.map((f, i) => ({
            tug_session_id: sid,
            tool_use_id: toolUseId(i),
            file_path: join(repo, f.path),
            tool_name: "Edit",
            op: "write",
            origin: "exact",
            ambiguous: false,
            project_dir: repo,
            at: Date.now(),
          })),
        });
        writeFileSync(join(repo, FILES[0].path), FILES[0].after);
        await Bun.sleep(1_500);

        const rest = await standIns(app);
        expect(rest[CARD], "the card stands in its slot").toBeDefined();
        const crop = cropAround([rest[CARD]!], 12, await contentSize(app));

        const draftFrame = (frame: Record<string, unknown>) =>
          body.evalJS<boolean>(
            `window.__tug.publishDraftFrame(${JSON.stringify(JSON.stringify({ workspace_key: repo, owner_kind: "session", owner_id: sid, ...frame }))})`,
          );

        const notes: Record<string, unknown> = {};
        const reading = await burstTo(app, crop, BURST_MS, outDirFor("changes-commit"), async () => {
          await Bun.sleep(REST_MS);

          // ⌃⌘C: the shade rises and, on the empty composer, commit mode opens.
          await app.nativeKey("c", ["ctrl", "cmd"]);
          await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(SHEET)}) !== null`, { timeoutMs: 20_000 });
          await body.waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(ANY_ROWS)}).length >= ${FILES.length}`, { timeoutMs: 20_000 });
          notes.sessionRows = await body.evalJS<number>(`document.querySelectorAll(${JSON.stringify(SESSION_ROWS)}).length`);
          notes.commitMode = await body.evalJS<boolean>(`document.querySelector(${JSON.stringify(COMMIT_BUTTON)}) !== null`);
          await Bun.sleep(SHADE_MS);

          // Auto-Message: the scribe writes the message into the composer.
          await draftFrame({ action: "changeset_draft_state", state: "drafting" });
          await Bun.sleep(500);
          notes.drafting = await body.evalJS<boolean>(`(function(){ var b = document.querySelector(${JSON.stringify(AUTO_BUTTON)}); return b !== null && b.hasAttribute("data-drafting"); })()`);
          for (const text of deltas(MESSAGE)) {
            await draftFrame({ action: "changeset_draft_delta", text });
            await Bun.sleep(DELTA_MS);
          }
          await draftFrame({ action: "changeset_draft_state", state: "ready" });
          await Bun.sleep(READY_MS);

          // Commit: the press lands the message on the scratch repository,
          // and the receipt settles into the transcript.
          await body.nativeClickAtElement(COMMIT_BUTTON);
          await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(RECEIPT)}) !== null`, { timeoutMs: RECEIPT_MS });
          notes.committed = git(repo, "log", "-1", "--format=%s");
        });
        writeFileSync(join(outDirFor("changes-commit"), "notes.json"), JSON.stringify(notes, null, 2));
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
        expect(notes.committed, "the press produced the commit it asked for").toBe(MESSAGE.split("\n")[0]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
