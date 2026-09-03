/**
 * at0500-task-marker-run-fold.test.ts — a run of consecutive same-verb
 * `TaskCreate` / `TaskUpdate` markers renders as ONE transcript row.
 *
 * The [D100] second surface paints one marker per Task* event. The task
 * store is scoped to the session while the model writes a checklist per
 * turn, and the wire carries no clear event — so tidying the list means
 * one `TaskUpdate status:"deleted"` per task, and a real sweep of
 * nineteen painted nineteen identical rows. The fold
 * (`session-transcript-task-runs.ts`) turns each run into one row.
 *
 * The fixture is that exact sweep, sliced from a real session: 19
 * `deleted` updates, then the 11 `TaskCreate` calls that replaced them,
 * then one `in_progress` flip. So the leg pins all three readings at
 * once — a delete run folds, a create run folds, and the lone flip
 * beside them does not.
 *
 * | Assertion            | What would break without it                     |
 * |----------------------|-------------------------------------------------|
 * | 3 rows, not 31       | the wall this fold exists to prevent            |
 * | counted labels       | a fold that swallowed members without saying so |
 * | subjects survive     | a fold that dropped what the rows were saying   |
 * | the single flip      | over-folding — a lone marker losing its subject |
 * | one line per row     | a fold that traded a tall wall for a short one  |
 *
 * @covers tugdeck/src/components/tugways/cards/session-transcript-task-runs.ts
 * @covers tugdeck/src/components/tugways/cards/blocks/task-inline-tool-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { seedFixtureSession } from "./fixtures/resolve";
import { openFixtureSession, waitForTranscriptSettled } from "./fixtures/runner";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const MARKER = '[data-slot="task-inline-tool-block"]';

/** What the fixture's turn contains, and what it must render as. */
const DELETED_IN_FIXTURE = 19;
const CREATED_IN_FIXTURE = 11;
const TASK_EVENTS_IN_FIXTURE = DELETED_IN_FIXTURE + CREATED_IN_FIXTURE + 1;
const ROWS_EXPECTED = 3;

interface MarkerRow {
  state: string | null;
  folded: boolean;
  text: string;
  /** Rendered height, for the "still one line" check. */
  height: number;
}

function readMarkers(): string {
  return `(function(){
    var rows = Array.prototype.slice.call(
      document.querySelectorAll(${JSON.stringify(MARKER)}),
    );
    return JSON.stringify(rows.map(function (row) {
      return {
        state: row.getAttribute("data-state"),
        folded: row.getAttribute("data-run") === "true",
        text: (row.textContent || "").replace(/\\s+/g, " ").trim(),
        height: Math.round(row.getBoundingClientRect().height),
      };
    }));
  })()`;
}

describe.skipIf(!SHOULD_RUN)("at0500: a run of task markers folds to one row", () => {
  test(
    "19 deletes and 11 creates read as two rows, the lone flip as its own",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const seeded = await seedFixtureSession("session-task-run-fold", "at0500");
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.dev",
        "recent-projects",
        "json",
        JSON.stringify({ paths: [seeded.projectDir] }),
      );

      try {
        const app = await launchTugApp({
          testName: "at0500",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
        });
        try {
          await openFixtureSession(app, seeded);
          await waitForTranscriptSettled(app);

          // The fold is derived at render, so the rows are present as
          // soon as the run's cell mounts — but the resumed transcript
          // commits in batches, so wait for the count rather than
          // reading whatever happens to be there on the first look.
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(MARKER)}).length === ${ROWS_EXPECTED}`,
            { timeoutMs: 20_000 },
          );

          const rows: MarkerRow[] = JSON.parse(
            await app.evalJS<string>(readMarkers()),
          );
          note("at0500 marker rows", rows);

          // The whole point: 31 events, 3 rows.
          expect(rows).toHaveLength(ROWS_EXPECTED);
          expect(TASK_EVENTS_IN_FIXTURE).toBe(31);

          const deleted = rows.find((r) => r.state === "deleted");
          const created = rows.find((r) => r.state === "created");
          const started = rows.find((r) => r.state === "started");
          expect(deleted).toBeDefined();
          expect(created).toBeDefined();
          expect(started).toBeDefined();

          // A fold says how many it stands for — otherwise it is just
          // nineteen rows silently becoming one.
          expect(deleted?.folded).toBe(true);
          expect(deleted?.text).toContain(`Deleted ${DELETED_IN_FIXTURE} tasks`);
          expect(created?.folded).toBe(true);
          expect(created?.text).toContain(`Created ${CREATED_IN_FIXTURE} tasks`);

          // Nothing is dropped: the create run still says what it
          // created, in order, on the row.
          expect(created?.text).toContain("Step 1: The clock tells the truth");
          expect(created?.text).toContain("Step 2: No NUL bytes in source");
          // The delete run's subjects resolve by id — the settled fold
          // no longer holds a deleted task's text.
          expect(deleted?.text).toMatch(/Task #\d+/);

          // The lone flip is NOT folded, and keeps its own subject.
          expect(started?.folded).toBe(false);
          expect(started?.text).toStartWith("Started");
          expect(started?.text).not.toContain("tasks");

          // A folded row is one line. If the subject list wrapped, the
          // wall would only have gotten shorter, not gone away — so the
          // folded rows must be no taller than the unfolded one.
          const singleHeight = started?.height ?? 0;
          expect(singleHeight).toBeGreaterThan(0);
          expect(deleted?.height).toBeLessThanOrEqual(singleHeight + 2);
          expect(created?.height).toBeLessThanOrEqual(singleHeight + 2);
        } finally {
          await app.quitGracefully();
        }
      } finally {
        seeded.cleanup();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
