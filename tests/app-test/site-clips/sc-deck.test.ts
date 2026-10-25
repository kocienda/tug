/**
 * sc-deck.test.ts — the site's hero still: the whole window at work, with
 * three REAL sessions from this checkout's history. Two of them were the
 * implement seats of two arcs, and the third was a plain fix. The five
 * sidebars are open at the edges, and both arcs stand in the Arcs card with
 * their sessions bound. One arc, one card: the server refuses a second
 * holder for an arc at the door, which is also how an arc looks in life —
 * its stages rotate through one card, so two cards on one arc is not a scene
 * the app would ever show.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that the still was written. Run by path, once per
 * mode (`_site-clips.ts` has the invocation); skips unless the runner and
 * both site variables are set.
 *
 * The scene. A scratch repository, renamed `tug` so the masthead prints a
 * plain project name, holds a re-creation of each arc the sessions worked:
 * made by the real CLI, with a task list walked by the real step verbs to
 * where the arc stood, and the run record the wheel would have left
 * (`arc-start`, `arc-kind`, `arc-stage`), the way `at0407` and `at0483`
 * build theirs. The three transcripts are copied from this checkout's Claude
 * project directory into the scratch repository's, with each row's `cwd`
 * moved to the scratch path, and each card is spawned with
 * `spawnSessionResume` on that repository — which is what registers it as a
 * workspace, so the arc reaches the Arcs card — then bound to the arc where
 * it was its seat. The sidebars are toggled on through the same actions the
 * chords fire, with the left rail ordered Arcs, Jots, Overview, and the
 * Overview is fed Observer posts about the three sessions through
 * `publishOverviewPost`.
 *
 * The still is the whole content area at a window wider and taller than the
 * harness default; the harness grants what the display allows.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { App } from "../_harness";
import { kindBody } from "../_harness/card-reach";
import { claudeProjectDir, encodeProjectDir } from "../_harness/claude-home";
import { onTestRunEnd } from "../_harness/test-cleanup";
import {
  appendArcLogLine,
  arcBriefPath,
  arcLogPath,
  arcTasksPath,
  bindArc,
  createArc,
  fixturePlanDocument,
  makeArcScratchRepo,
  rmArcScratchRepo,
  tugtool,
  type ArcScratchRepo,
} from "../arc-fixture";
import { kindPane } from "../body-grounding/_kinds";
import { pollFor } from "../body-grounding/_frames";
import { MODE, RUNS, launchForMode, outDirFor, stillTo } from "./_site-clips";

const TEST_TIMEOUT_MS = 400_000;
/** This checkout — whose built CLI runs, whose history the sessions come from, and never the tree the arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", "..", ".."));

/**
 * One arc a session worked: its name, the task list's titles, and how far the
 * run had walked when the session's transcript ends.
 */
interface Arc {
  name: string;
  steps: readonly string[];
  /** Steps closed; the next one is open unless every step is closed. */
  done: number;
}

/**
 * The join-room arc's eight steps. The last two are the titles the implement
 * session quotes; the first six are paraphrased from its work, since the
 * arc's own task list went with the join. A row's title is the fraction's
 * hover sentence and the fold's text, and neither is in the still.
 */
const JOIN_ROOM: Arc = {
  name: "join-room-reveal-and-landing",
  steps: [
    "Reveal the Changes shade on a ready arc",
    "Front the arc's row in the shade",
    "The landing mode and its composer",
    "Narrate the join's beats",
    "Settle on the outcome row",
    "Hold the offer while a join runs",
    "Server-minted work_id, client memory re-keyed on it",
    "Withheld-offer log lines and the at0445 replay variant",
  ],
  done: 7,
};

/** The workspace-create-flash arc, mid-walk: its session closes step 3 as it ends. Titles paraphrased from its work for the same reason. */
const CREATE_FLASH: Arc = {
  name: "workspace-create-flash",
  steps: [
    "Reproduce the flash on workspace create",
    "Paint the new workspace's deck before the switch",
    "An animation doctrine row for workspace create",
    "Hold the old deck until the new one has a frame",
    "An app-test over the create gesture",
  ],
  done: 3,
};

/**
 * The three sessions, left to right, by the ids this checkout's Claude
 * project directory holds them under. The arc log names the first two as
 * the implement seats of their arcs; the third was a plain fix.
 */
const SESSIONS: readonly { card: string; id: string; arc: Arc | null }[] = [
  { card: "sc-deck-a", id: "82b867fa-b0b2-419c-8f4a-c3d003f6e075", arc: JOIN_ROOM },
  { card: "sc-deck-b", id: "31b0e911-5b69-4338-b18f-6e6c189d3e99", arc: CREATE_FLASH },
  { card: "sc-deck-c", id: "f53840d2-ae02-4404-976a-3f0ba62fb9f4", arc: null },
];

/** The first hero's size: three Comfy cards beside both rails under Flow, and a tall transcript. */
const CONTENT_SIZE = { width: 3260, height: 2040 };
const READY_MS = 120_000;
/** Rest after the last post, so every surface has painted. */
const SETTLE_MS = 2_500;

const arcsRow = (arc: Arc): string => `.arcs-section [data-slot="arcs-row"][data-arc="${arc.name}"]`;
const MASTHEAD_MARK = '[data-slot="session-masthead"] [data-slot="tug-arc-lifecycle-mark"]';
const OVERVIEW_TRANSCRIPT = '[data-testid="overview-card"] .overview-transcript';

interface WirePost {
  id: number;
  at_ms: number;
  author: "observer" | "operator" | "user";
  body: string;
  refs: { kind: string; target: string }[];
  session_id?: string;
  wake_reason?: string;
  project_dir?: string;
}

function deck(): Record<string, unknown> {
  return {
    cards: SESSIONS.map(({ card }) => ({ id: card, componentId: "session", title: "Session", closable: true })),
    panes: SESSIONS.map(({ card }, slot) => kindPane("session", card, slot)),
    activePaneId: `${SESSIONS[0].card}-pane`,
    // The left rail reads Arcs, Jots, Overview from the top, as the first hero
    // did; registration order alone would put Arcs at the bottom.
    imposition: { kind: "three-up", layout: "flow", sidebars: {}, rails: { left: { order: ["dashes", "jots", "overview"] } } },
    hasFocus: true,
  };
}

/**
 * The arc's repository: a scratch repo moved under a parent whose basename
 * is the project's, since the masthead prints the directory's last segment.
 */
function arcRepository(parent: string): ArcScratchRepo {
  const scratch = makeArcScratchRepo({ prefix: "sc-deck", checkout: CHECKOUT });
  const repo = join(parent, "tug");
  renameSync(scratch.repo, repo);
  return { ...scratch, repo };
}

/** A task list with the arc's step titles, in the fixture's grammar. */
function tasks(arc: Arc): string {
  let doc = fixturePlanDocument(arc.steps.length);
  const fixtureTitles = ["The only step", "The second step", "The third step", "The fourth step", "The fifth step", "The sixth step", "The seventh step", "The eighth step"];
  arc.steps.forEach((title, i) => {
    doc = doc.split(fixtureTitles[i]!).join(title);
  });
  return doc;
}

/** Make `arc`, walk its task list through the real verbs to where it stood, and leave the wheel's record. */
function stageArc(scratch: ArcScratchRepo, arc: Arc): void {
  createArc(scratch.repo, arc.name, arc.name.split("-").join(" "), scratch.cli);
  writeFileSync(arcBriefPath(scratch.repo, arc.name), `# ${arc.name}\n`);
  writeFileSync(arcTasksPath(scratch.repo, arc.name), tasks(arc));
  const step = (...args: string[]): void => {
    tugtool(["arc", "step", arc.name, ...args], { cwd: scratch.repo, binaryRoot: scratch.cli.binaryRoot, env: scratch.cli.env });
  };
  const through = String(arc.steps.length);
  for (let n = 1; n <= arc.done; n++) {
    step("start", String(n), "--through", through);
    step("done", String(n));
  }
  if (arc.done < arc.steps.length) step("start", String(arc.done + 1), "--through", through);
  const log = arcLogPath(scratch.dataRoot);
  appendArcLogLine(log, arc.name, "arc-start", `.tug/arcs/${arc.name}/tasks.md`);
  appendArcLogLine(log, arc.name, "arc-kind", "plain");
}

/**
 * Copy one of this checkout's transcripts into the scratch repository's
 * Claude project directory, so `claude --resume` finds it there. Each row's
 * `cwd` moves with it: the sessions ran in this checkout and its worktrees,
 * and a row's `cwd` is where the resume looks for the project.
 *
 * The source is the user's OWN Claude home, `~/.claude`, by name: the runner
 * may point `CLAUDE_CONFIG_DIR` at a home of its own, which is where the app
 * under test reads (so the copy goes through `claudeProjectDir`), but the
 * history being borrowed lives in the real one.
 */
function transplant(sessionId: string, repo: string): void {
  const from = join(homedir(), ".claude", "projects", encodeProjectDir(CHECKOUT), `${sessionId}.jsonl`);
  const dir = claudeProjectDir(repo);
  mkdirSync(dir, { recursive: true });
  let text: string;
  try {
    text = readFileSync(from, "utf8");
  } catch (error) {
    throw new Error(`sc-deck: cannot read the transcript at ${from} (HOME=${process.env.HOME}, CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR}): ${String(error)}`);
  }
  const rows = text
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      try {
        const row = JSON.parse(line) as { cwd?: string };
        if (typeof row.cwd === "string" && row.cwd.startsWith(CHECKOUT)) row.cwd = repo;
        return JSON.stringify(row);
      } catch {
        return line;
      }
    });
  writeFileSync(join(dir, `${sessionId}.jsonl`), rows.join("\n"));
  onTestRunEnd(() => rmSync(dir, { recursive: true, force: true }));
}

function jotsFile(parent: string): string {
  const path = join(parent, "jots.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: 1,
        jots: [
          { id: "j1", text: "Verify before every commit, and never commit red." },
          { id: "j2", text: "Write the join draft before stopping; the join lands it." },
          { id: "j3", text: "Read the diff before the commit messages, so the code is judged." },
          { id: "j4", text: "A failing test has three endings: fix the code, change the test, delete it." },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

/**
 * Resume `id` in `card` on `repo`, and wait until its transcript has rows.
 * The replay of a long real transcript takes longer than one harness wait
 * may run (`WAIT_CEILING_MS`), so the wait is a poll of short reads with its
 * own deadline, the way the burst reader waits.
 */
async function resume(app: App, card: string, id: string, repo: string): Promise<void> {
  await app.spawnSessionResume(card, { tugSessionId: id, projectDir: repo });
  await app.awaitEngineReady(card, { timeoutMs: READY_MS });
  await pollFor(
    () =>
      app
        .body(card)
        .evalJS<boolean>(
          `document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelectorAll(".tug-transcript-entry").length > 0`,
        )
        .catch(() => false),
    (ready) => ready,
    READY_MS,
  );
}

async function publish(app: App, post: WirePost): Promise<void> {
  await kindBody(app, "overview").evalJS<boolean>(`window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`);
}

describe.skipIf(!RUNS)("site still: the deck at work", () => {
  test(
    "records three real sessions, two of them an arc's, with the sidebars open",
    async () => {
      const parent = realpathSync(mkdtempSync(join(tmpdir(), "sc-deck-")));
      onTestRunEnd(() => rmSync(parent, { recursive: true, force: true }));
      const scratch = arcRepository(parent);
      onTestRunEnd(() => rmArcScratchRepo(scratch));
      for (const { arc } of SESSIONS) if (arc !== null) stageArc(scratch, arc);
      for (const { id } of SESSIONS) transplant(id, scratch.repo);

      const app = await launchForMode("sc-deck", deck(), undefined, {
        env: { TUG_DATA_DIR: scratch.dataRoot, TUG_JOTS_PATH: jotsFile(parent) },
        contentSize: CONTENT_SIZE,
      });
      try {
        for (const { card, id } of SESSIONS) await resume(app, card, id, scratch.repo);

        // Each arc's seat: the session that implemented it, with the stage
        // line the wheel writes when it seats one.
        const log = arcLogPath(scratch.dataRoot);
        for (const { id, arc } of SESSIONS) {
          if (arc === null) continue;
          bindArc(scratch.repo, arc.name, id, scratch.cli);
          appendArcLogLine(log, arc.name, "arc-stage", `implement ${id} opus`);
        }

        for (const action of ["toggle-arcs", "toggle-jots", "toggle-overview", "toggle-cards", "toggle-layout"]) {
          await app.dispatchControlAction(action);
        }
        for (const { arc } of SESSIONS) {
          if (arc === null) continue;
          await kindBody(app, "dashes").waitForCondition<boolean>(`document.querySelector(${JSON.stringify(arcsRow(arc))}) !== null`, {
            timeoutMs: 30_000,
          });
        }
        await app
          .body(SESSIONS[1].card)
          .waitForCondition<boolean>(`document.querySelector(${JSON.stringify(MASTHEAD_MARK)}) !== null`, { timeoutMs: 30_000 });
        await kindBody(app, "overview").waitForCondition<boolean>(`document.querySelector(${JSON.stringify(OVERVIEW_TRANSCRIPT)}) !== null`, {
          timeoutMs: 15_000,
        });

        const now = Date.now();
        const posts: WirePost[] = [
          {
            id: 9001,
            at_ms: now - 2_700_000,
            author: "observer",
            body: `^${JOIN_ROOM.name} closed its seventh step: the join's work id is minted on the server now, and the client's memory is re-keyed on it.`,
            refs: [],
            session_id: SESSIONS[0].id,
            wake_reason: "sitrep",
            project_dir: scratch.repo,
          },
          {
            id: 9002,
            at_ms: now - 840_000,
            author: "observer",
            body: `^${CREATE_FLASH.name} closed its third step: the animation doctrine has a row for workspace create beside the switch row, cited to the brief and its test.`,
            refs: [],
            session_id: SESSIONS[1].id,
            wake_reason: "sitrep",
            project_dir: scratch.repo,
          },
          {
            id: 9003,
            at_ms: now - 180_000,
            author: "observer",
            body: "The @ completion popup no longer drags the card's content sideways: the selected row is revealed inside the popup's own scroller instead of with scrollIntoView.",
            refs: [],
            session_id: SESSIONS[2].id,
            wake_reason: "sitrep",
            project_dir: scratch.repo,
          },
        ];
        for (const post of posts) await publish(app, post);
        await Bun.sleep(SETTLE_MS);

        const out = join(outDirFor("deck"), "still.png");
        const { scale } = await stillTo(app, undefined, out);
        writeFileSync(join(outDirFor("deck"), "reading.json"), JSON.stringify({ clip: "deck", mode: MODE, scale, contentSize: CONTENT_SIZE }, null, 2));
        expect(scale, "a still was written at the window's scale").toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
