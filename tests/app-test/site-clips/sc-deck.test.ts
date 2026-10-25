/**
 * sc-deck.test.ts — the site's hero clip: the whole window at work. Three
 * Session cards streaming side by side, the five sidebars open at the edges,
 * and an arc running on one of the sessions — its step closing and the next
 * opening while the clip rolls, the Overview rail gaining a post as it does.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene. A scratch repository, renamed `tug` so the masthead prints a
 * plain project name, holds a REAL arc made by the real CLI: a seven-step
 * plan, stamped, walked to its fourth step, with the run record the wheel
 * would have left (`arc-start`, `arc-kind`, `arc-stage`), the way `at0407`
 * and `at0483` build theirs. The first card is spawned on that repository —
 * which is what registers it as a workspace, so the arc reaches the Arcs
 * card — and bound to the arc, so its masthead wears the `^live-pictures`
 * run and the breathing mark. The other two cards are spawned on plain
 * directories named like projects. All three stream stub transcripts
 * (`streaming-stub-fixture.ts`) under their own prompts. The sidebars are
 * toggled on through the same actions the chords fire, and the Overview is
 * fed Observer posts about the three sessions through `publishOverviewPost`.
 *
 * The burst records the whole content area at a window wider than the
 * harness default, so the cards have room beside both rails. Three seconds
 * in, the arc closes its fourth step and opens its fifth — the Arcs row's
 * track ticks and the masthead's fraction moves — and at six seconds one more
 * Observer post lands on the rail.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { App } from "../_harness";
import { kindBody } from "../_harness/card-reach";
import { onTestRunEnd } from "../_harness/test-cleanup";
import {
  appendArcLogLine,
  arcBriefPath,
  arcLogPath,
  arcPlanPath,
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
import { streamingTranscript, stubDirectory, type StubCard } from "../streaming-stub-fixture";
import { RUNS, burstTo, launchForMode, outDirFor } from "./_site-clips";

const TEST_TIMEOUT_MS = 170_000;
/** This checkout — whose built CLI runs, and never the tree the arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

const CARDS = ["sc-deck-a", "sc-deck-b", "sc-deck-c"] as const;
/** The project each card is spawned on: the first is the arc's repository. */
const PROJECTS = ["tug", "tug-site", "tugplug"] as const;
const ARC = "live-pictures";
const STEPS = [
  "Excerpts open themselves",
  "Theme roles for replicated UI",
  "Datatype font and Colophon credit",
  "Indicator replica",
  "Clip component and make-clip",
  "Mode-paired display",
  "Capture drivers in the Tug repo",
] as const;
/** The step the arc is on when the clip opens; it closes during the burst. */
const STEP_IN_HAND = 4;

/** What each session is asked, so the three mastheads read differently. */
const PROMPTS = [
  "Implement the indicator replica and run the theme check.",
  "Audit the home page diff against the plan and the brief.",
  "Walk the arc doctrine and report every rule the skill cites.",
] as const;

/** Each card streams a few messages, long enough to outlast the burst. */
const MESSAGES = 3;
const BURST_MS = 9_500;
const STEP_AT_MS = 3_000;
const POST_AT_MS = 6_000;
/** Wide enough for three Comfy cards (800 px each) to stand clear beside both rails, as the first hero was captured. */
const CONTENT_SIZE = { width: 3260, height: 1360 };
const BOUND_MS = 30_000;
const STREAMING_MS = 15_000;

const ARCS_ROW = `.arcs-section [data-slot="arcs-row"][data-arc="${ARC}"]`;
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
    cards: CARDS.map((id) => ({ id, componentId: "session", title: "Session", closable: true })),
    panes: CARDS.map((id, slot) => kindPane("session", id, slot)),
    activePaneId: `${CARDS[0]}-pane`,
    imposition: { kind: "three-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/**
 * The arc's repository: a scratch repo moved under a parent whose basename
 * is a project's, since the masthead prints the directory's last segment and
 * `tug-scratch-sc-deck-x7q2` is not a name a reader should see.
 */
function arcRepository(parent: string): ArcScratchRepo {
  const scratch = makeArcScratchRepo({ prefix: "sc-deck", checkout: CHECKOUT });
  const repo = join(parent, PROJECTS[0]);
  renameSync(scratch.repo, repo);
  return { ...scratch, repo };
}

/** A seven-step plan with the site arc's own step titles, in the fixture's grammar. */
function plan(): string {
  let doc = fixturePlanDocument(STEPS.length);
  const fixtureTitles = ["The only step", "The second step", "The third step", "The fourth step", "The fifth step", "The sixth step", "The seventh step"];
  fixtureTitles.forEach((title, i) => {
    doc = doc.split(title).join(STEPS[i]);
  });
  return doc;
}

/** Make the arc, stamp its plan, walk it to the step in hand, and leave the wheel's record. */
function stageArc(scratch: ArcScratchRepo): void {
  createArc(scratch.repo, ARC, "Live pictures on the home page", scratch.cli);
  writeFileSync(arcBriefPath(scratch.repo, ARC), "# Tug site: live pictures on the home page\n");
  const planPath = arcPlanPath(scratch.repo, ARC);
  writeFileSync(planPath, plan());
  const step = (...args: string[]): void => {
    tugtool(["arc", "step", ARC, ...args], { cwd: scratch.repo, binaryRoot: scratch.cli.binaryRoot, env: scratch.cli.env });
  };
  step("start", "1", "--through", String(STEPS.length));
  tugtool(["plan", "stamp", planPath], { cwd: scratch.repo, binaryRoot: scratch.cli.binaryRoot, env: scratch.cli.env });
  step("done", "1");
  for (let n = 2; n < STEP_IN_HAND; n++) {
    step("start", String(n), "--through", String(STEPS.length));
    step("done", String(n));
  }
  step("start", String(STEP_IN_HAND), "--through", String(STEPS.length));
  const log = arcLogPath(scratch.dataRoot);
  appendArcLogLine(log, ARC, "arc-start", `.tug/arcs/${ARC}/plan.md`);
  appendArcLogLine(log, ARC, "arc-kind", "planned");
}

/** Close the step in hand and open the next, as the implement stage would at a step boundary. */
function advanceArc(scratch: ArcScratchRepo): void {
  const step = (...args: string[]): void => {
    tugtool(["arc", "step", ARC, ...args], { cwd: scratch.repo, binaryRoot: scratch.cli.binaryRoot, env: scratch.cli.env });
  };
  step("done", String(STEP_IN_HAND));
  step("start", String(STEP_IN_HAND + 1), "--through", String(STEPS.length));
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

/** Spawn `cardId` on `projectDir` with a stub transcript, and wait for its binding. */
async function bindStub(app: App, stubDir: string, cardId: string, projectDir: string): Promise<StubCard> {
  const tugSessionId = randomUUID();
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(MESSAGES)));
  await app.spawnSessionNew(cardId, { tugSessionId, projectDir });
  await pollFor(
    () =>
      app
        .body(cardId)
        .evalJS<boolean>(
          `document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelector('.session-card-picker-form') === null`,
        )
        .catch(() => false),
    (bound) => bound,
    BOUND_MS,
  );
  return { cardId, tugSessionId };
}

/** Send each card its own prompt and wait until every one is streaming. */
async function startStreams(app: App, cards: readonly StubCard[]): Promise<void> {
  for (const [i, { cardId }] of cards.entries()) {
    await app.driveSession(cardId, { op: "send", text: PROMPTS[i] });
  }
  for (const { cardId } of cards) {
    await pollFor(
      () =>
        app
          .body(cardId)
          .evalJS<boolean>(`(document.querySelector('[data-slot="tug-prompt-entry"]')?.getAttribute("data-phase") ?? "") === "streaming"`)
          .catch(() => false),
      (streaming) => streaming,
      STREAMING_MS,
    );
  }
}

async function publish(app: App, post: WirePost): Promise<void> {
  await kindBody(app, "overview").evalJS<boolean>(`window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`);
}

describe.skipIf(!RUNS)("site clip: the deck at work", () => {
  test(
    "records three sessions streaming, the sidebars open, and an arc stepping",
    async () => {
      const parent = realpathSync(mkdtempSync(join(tmpdir(), "sc-deck-")));
      onTestRunEnd(() => rmSync(parent, { recursive: true, force: true }));
      const scratch = arcRepository(parent);
      onTestRunEnd(() => rmArcScratchRepo(scratch));
      stageArc(scratch);
      for (const name of PROJECTS.slice(1)) mkdirSync(join(parent, name));
      const stubDir = stubDirectory();

      const app = await launchForMode("sc-deck", deck(), stubDir, {
        env: { TUG_DATA_DIR: scratch.dataRoot, TUG_JOTS_PATH: jotsFile(parent) },
        contentSize: CONTENT_SIZE,
      });
      try {
        const cards: StubCard[] = [];
        for (const [i, cardId] of CARDS.entries()) {
          cards.push(await bindStub(app, stubDir, cardId, i === 0 ? scratch.repo : join(parent, PROJECTS[i])));
        }

        // The arc's seat is the first session: bound through the real verb,
        // with the stage line the wheel writes when it seats one.
        bindArc(scratch.repo, ARC, cards[0]!.tugSessionId, scratch.cli);
        appendArcLogLine(arcLogPath(scratch.dataRoot), ARC, "arc-stage", `implement ${cards[0]!.tugSessionId} opus`);

        for (const action of ["toggle-overview", "toggle-jots", "toggle-arcs", "toggle-cards", "toggle-layout"]) {
          await app.dispatchControlAction(action);
        }
        await kindBody(app, "dashes").waitForCondition<boolean>(`document.querySelector(${JSON.stringify(ARCS_ROW)}) !== null`, {
          timeoutMs: 30_000,
        });
        await app
          .body(CARDS[0])
          .waitForCondition<boolean>(`document.querySelector(${JSON.stringify(MASTHEAD_MARK)}) !== null`, { timeoutMs: 30_000 });
        await kindBody(app, "overview").waitForCondition<boolean>(`document.querySelector(${JSON.stringify(OVERVIEW_TRANSCRIPT)}) !== null`, {
          timeoutMs: 15_000,
        });

        const now = Date.now();
        const posts: WirePost[] = [
          {
            id: 9001,
            at_ms: now - 540_000,
            author: "observer",
            body: `The arc ^${ARC} opened on its brief and devised a seven-step plan; the review stamped it with no questions deferred.`,
            refs: [],
            session_id: cards[0]!.tugSessionId,
            wake_reason: "sitrep",
            project_dir: scratch.repo,
          },
          {
            id: 9002,
            at_ms: now - 300_000,
            author: "observer",
            body: "Three steps have closed, each verified by the theme check and a green build before its round was committed.",
            refs: [],
            session_id: cards[0]!.tugSessionId,
            wake_reason: "sitrep",
            project_dir: scratch.repo,
          },
          {
            id: 9003,
            at_ms: now - 120_000,
            author: "observer",
            body: "The audit session is reading the diff cold against the plan and has found nothing to fix so far.",
            refs: [],
            session_id: cards[1]!.tugSessionId,
            wake_reason: "sitrep",
            project_dir: join(parent, PROJECTS[1]),
          },
        ];
        for (const post of posts) await publish(app, post);

        await startStreams(app, cards);
        await Bun.sleep(1_200);

        const reading = await burstTo(app, undefined, BURST_MS, outDirFor("deck"), async () => {
          await Bun.sleep(STEP_AT_MS);
          advanceArc(scratch);
          await Bun.sleep(POST_AT_MS - STEP_AT_MS);
          await publish(app, {
            id: 9004,
            at_ms: Date.now(),
            author: "observer",
            body: `Step ${STEP_IN_HAND} of ^${ARC} closed with its checkpoint green; the arc has opened step ${STEP_IN_HAND + 1}.`,
            refs: [],
            session_id: cards[0]!.tugSessionId,
            wake_reason: "sitrep",
            project_dir: scratch.repo,
          });
        });
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
