/**
 * arcs-card-fixture.ts — the scratch repository of real arcs, the row
 * selectors and the launch the at0407-arcs-card-* files share.
 *
 * Split out of `at0407-arcs-card.test.ts` when that file was cut, a test to a
 * file, into `at0407-arcs-card-unbound`, `-meta`, `-kind` and `-fold` so each
 * launch fits its own budget. The original built one scratch repository in a
 * `beforeAll` and launched one app per test; each file now builds the same
 * repository, every arc of it, through `withArcsCardScratch()` — the rows a
 * file does not read still stand in the card, because the ordering, the
 * first row's measurements and the cue census read the card as the original
 * fixture left it.
 *
 * ## The marks the Arcs card paints, over real arcs
 *
 * The card holds EVERY arc in every state ([D141]), and every row is one
 * `ArcLifecycleBlock`. Its eyebrow carries the arc atom, the hairline, and one
 * worker atom per bound session, and nothing else — an unbound arc shows no
 * worker atom and no phase dot anywhere on the row, because an arc with a
 * phase to report has a session bound to it and that session's atom is what
 * would carry the dot. The row's controls — the transport and the fold cue —
 * stand at the trailing edge of the LINE beneath it, in the block's
 * `lineTrailing` slot: they rode the eyebrow's end for a while, and at the
 * sidebar's width the two names paid for them in characters.
 *
 * Beneath the eyebrow, the lifecycle line says what the arc is DOING: the
 * track, the phase glyph, the fraction while a step is open, the phase in a
 * word. The track is the whole reading — an arc
 * driving a stepped plan stands at `implement` with one tick per plan row.
 * The step's TITLE is not on the line at all: it is the fraction's hover
 * sentence ([D168]).
 *
 * Two decisions of [D141] are pinned as absences: the arc pill wears no
 * review tint here (that yellow means WAITING, and an arc is not waiting for
 * anyone), and the doc+clock review glyph is retired from these rows —
 * review speaks through the identity run's tint and the join gates instead.
 *
 * The stage ordering rides along, because it needs two arcs at different
 * stages and this is the fixture that has them.
 *
 * And the row FOLDS: the cue at the line's end opens the block over the
 * plan's own ledger, rendered by the very component the `ARC` placard mounts,
 * so the row and the placard cannot disagree about one arc's steps. A row with
 * no steps draws the cue disabled — present, never absent — and a press on it
 * picks no row and fronts no card, which is the one claim about it that no
 * pure test can make.
 *
 * @module tests/app-test/arcs-card-fixture
 */

import { afterAll, beforeAll } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createArc,
  appendArcLogLine,
  arcBriefPath,
  arcLogPath,
  arcTasksPath,
  fixturePlanDocument,
  makeArcScratchRepo,
  recordStampedPlan,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

export const SID = "a7c0d1ea-0000-4000-8000-000000000407";

export const SECTION = '.arcs-section';
export const ARC_NAME = "at0407-arc";
export const ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${ARC_NAME}"]`;

/** The stepped arc — a second one, so the bare-arc assertions keep
 *  reading an arc with no plan at all. */
export const PLAN_ARC = "at0407-plan";
export const PLAN_ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${PLAN_ARC}"]`;

/** A third arc, whose eight-row plan the run WALKED and whose seventh step it
 *  withdrew — the one shape where the closed rows are not a prefix. */
export const SKIPPED_ARC = "at0407-skipped";
export const SKIPPED_ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${SKIPPED_ARC}"]`;

/**
 * Two more, differing only in the kind their logs recorded.
 *
 * Both wear the shape their door actually leaves behind — a brief, a ledger,
 * and a run record — because that shape is the whole point. It used to be
 * read for the kind, on the premise that only the planned route wrote a
 * brief; both doors write one now, so the reading marked every arc planned
 * and drew a plain one the two cells it never had. The recorded kind is the
 * fact, and these two rows are where the card is asked to prove it reads it.
 */
export const PLANNED_ARC = "at0407-planned";
export const PLANNED_ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${PLANNED_ARC}"]`;
export const PLAIN_ARC = "at0407-plain";
export const PLAIN_ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${PLAIN_ARC}"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
export const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

/** What a file reads of the scratch repository its hooks built. */
export interface ArcsCardScratch {
  /** The scratch repository's root — the project the session is spawned on. */
  projectDir(): string;
  /** The scratch data root the app is launched with as `TUG_DATA_DIR`. */
  dataRoot(): string;
}

/**
 * Register the `beforeAll`/`afterAll` that build and remove the scratch
 * repository — every arc the original file's `beforeAll` created, in the
 * same order and through the same verbs — and return its accessors.
 */
export function withArcsCardScratch(): ArcsCardScratch {
  /** The scratch repository this fixture owns, and the only tree it touches. */
  let scratch: ArcScratchRepo | null = null;
  let fixtureDir = "";
  const projectDir = (): string => scratch?.repo ?? "";

  beforeAll(() => {
    if (!SHOULD_RUN) return;
    scratch = makeArcScratchRepo({ prefix: "at0407", checkout: CHECKOUT });
    createArc(projectDir(), ARC_NAME, "at0407 fixture", scratch.cli);
    const planned = createArc(projectDir(), PLAN_ARC, "at0407 plan fixture", scratch.cli);
    // A three-row plan whose declared run covers only the first two, so the
    // Arcs row's numerals and its ring answer different questions.
    recordStampedPlan(projectDir(), PLAN_ARC, planned.worktree, {
      ...scratch.cli,
      rows: 3,
      through: 2,
    });

    // An eight-row plan walked to the end, with step 7 withdrawn. Driven through
    // the real verbs rather than written into the ledger's cells, so what the
    // track paints is what `arc step withdraw` actually wrote — the whole chain
    // from the verb through the feed to the tick, in one fixture.
    const skipped = createArc(projectDir(), SKIPPED_ARC, "at0407 withdrawal fixture", scratch.cli);
    recordStampedPlan(projectDir(), SKIPPED_ARC, skipped.worktree, {
      ...scratch.cli,
      rows: 8,
      through: 8,
    });
    // Captured out of the closure: `scratch` is a `let` in the enclosing
    // function, so the narrowing this body sits inside does not reach into a
    // callback.
    const cli = scratch.cli;
    const step = (...args: string[]): void => {
      tugtool(["arc", "step", SKIPPED_ARC, ...args], {
        cwd: projectDir(),
        binaryRoot: cli.binaryRoot,
        env: cli.env,
      });
    };
    // `recordStampedPlan` already opened step 1 and declared the selection.
    // The commit cell is the branch tip, taken by omitting `--commit`: the verb
    // refuses a sha that resolves to nothing in the arc worktree, and a fixture
    // that makes no round has no sha of its own to name.
    step("done", "1");
    for (const n of [2, 3, 4, 5, 6]) {
      step("start", String(n), "--through", "8");
      step("done", String(n));
    }
    step("withdraw", "7");
    step("start", "8", "--through", "8");
    step("done", "8");

    // ── The two kinds, each as its own door leaves it ──────────────────────
    // The log line is appended rather than driven through `arc run`, which is
    // what writes it in life: the runner would seat a stage and start rotating
    // this arc, and the fixture wants the record without the machinery. It is
    // the same route `at0503` and `at0510` take, for the same reason.
    const log = arcLogPath(scratch.dataRoot);

    const planned2 = createArc(projectDir(), PLANNED_ARC, "at0407 planned fixture", cli);
    writeFileSync(arcBriefPath(projectDir(), PLANNED_ARC), "# at0407 planned brief\n");
    recordStampedPlan(projectDir(), PLANNED_ARC, planned2.worktree, {
      ...cli,
      rows: 2,
      through: 2,
    });
    appendArcLogLine(log, PLANNED_ARC, "arc-start", `.tug/arcs/${PLANNED_ARC}/plan.md`);
    appendArcLogLine(log, PLANNED_ARC, "arc-kind", "planned");

    // The plain arc carries a brief AND a run record — every clause the old
    // derivation read for `direct` is false here, so before the kind was on the
    // wire this row drew six cells. Its ledger is a task list, which is what
    // the plain door writes.
    createArc(projectDir(), PLAIN_ARC, "at0407 plain fixture", cli);
    writeFileSync(arcBriefPath(projectDir(), PLAIN_ARC), "# at0407 plain brief\n");
    writeFileSync(arcTasksPath(projectDir(), PLAIN_ARC), fixturePlanDocument(2));
    appendArcLogLine(log, PLAIN_ARC, "arc-start", `.tug/arcs/${PLAIN_ARC}/tasks.md`);
    appendArcLogLine(log, PLAIN_ARC, "arc-kind", "plain");

    fixtureDir = seedScratchSession(projectDir(), SID);
  });

  afterAll(() => {
    if (!SHOULD_RUN) return;
    rmArcScratchRepo(scratch);
    rmScratchSession(fixtureDir);
  });

  return {
    projectDir,
    dataRoot: () => scratch?.dataRoot ?? "",
  };
}
