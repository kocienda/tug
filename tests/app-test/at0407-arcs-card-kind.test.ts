/**
 * at0407-arcs-card-kind.test.ts — the recorded kind picks the track's cells
 * and puts no word on the line.
 *
 * One of the at0407-arcs-card split, a test to a file so each launch fits its
 * own budget; the others are `at0407-arcs-card-unbound`, `-meta` and `-fold`.
 * What the Arcs card paints, and the scratch repository of real arcs every
 * piece builds, are `arcs-card-fixture.ts`.
 *
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/components/arcs/arcs-card.css
 * @covers tugdeck/src/components/tugways/arc-lifecycle-block.tsx
 * @covers tugdeck/src/components/tugways/arc-lifecycle-block.css
 * @covers tugdeck/src/components/tugways/arc-lifecycle-line.tsx
 * @covers tugdeck/src/components/tugways/arc-lifecycle-line.css
 * @covers tugdeck/src/components/tugways/arc-step-list.tsx
 * @covers tugdeck/src/components/tugways/arc-step-list.css
 * @covers tugdeck/src/components/tugways/body-kinds/affordances/block-fold-cue.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-track.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-track.css
 * @covers tugdeck/src/components/tugways/tug-step-fraction.tsx
 * @covers tugdeck/src/lib/changeset-all-store.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/lib/arc-meta-facts.ts
 * @covers tugdeck/src/lib/arc-review.ts
 * @family at0407-arcs-card
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { kindBody } from "./_harness/card-reach";
import {
  CHECKOUT,
  PLAIN_ROW,
  PLANNED_ROW,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  withArcsCardScratch,
} from "./arcs-card-fixture";

const { projectDir, dataRoot } = withArcsCardScratch();

describe.skipIf(!SHOULD_RUN)("AT0407: the Arcs card", () => {
  test(
    "the recorded kind picks the track's cells and puts no word on the line",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0407-arcs-kind",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: dataRoot() },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        await app.dispatchControlAction("toggle-arcs");
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PLANNED_ROW)}) !== null &&
           document.querySelector(${JSON.stringify(PLAIN_ROW)}) !== null`,
          { timeoutMs: 30000 },
        );

        // One reader over both rows, so the two are compared rather than
        // asserted apart: what matters is the DIFFERENCE the kind makes, and
        // a claim read off one row alone cannot show it.
        const read = (selector: string): string =>
          `(() => {
             const row = document.querySelector(${JSON.stringify(selector)});
             const track = row.querySelector('[data-slot="tug-arc-track"]');
             return {
               phases: Array.from(
                 track.querySelectorAll('[data-slot="tug-arc-track-cell"]'),
               ).map((el) => el.getAttribute("data-phase")),
               note: (
                 row.querySelector('[data-slot="tug-arc-lifecycle-note"]')?.textContent ?? ""
               ).trim(),
             };
           })()`;
        type Row = {
          phases: string[];
          note: string;
        };
        const planned = await kindBody(app, "dashes").evalJS<Row>(read(PLANNED_ROW));
        const plain = await kindBody(app, "dashes").evalJS<Row>(read(PLAIN_ROW));
        note("at0407 planned row", JSON.stringify(planned));
        note("at0407 plain row", JSON.stringify(plain));

        // ── The word ──────────────────────────────────────────────────────
        // There is none. The kind is the cell set — a planned row's note used
        // to trail `planned` with nothing between them, so a stopped audit
        // read `stopped · audit did not mark planned`. Asserted over the note
        // on both rows, so the kind is caught on either.
        expect(planned.note).not.toContain("planned");
        expect(plain.note).not.toContain("plain");

        // ── The cells ─────────────────────────────────────────────────────
        // The two sets differ by devise and review alone, and the plain row is
        // the one that moved: it carries a brief and a run record, so every
        // clause of the old derivation was false and it drew all six.
        expect(planned.phases).toEqual([
          "brief",
          "devise",
          "review",
          "implement",
          "audit",
          "join",
        ]);
        expect(plain.phases).toEqual(["brief", "implement", "audit", "join"]);
        // The audit cell is drawn on both routes deliberately — what a run
        // does after its last commit is the same work whoever asked for it.
        expect(plain.phases).toContain("audit");
        note("at0407 kind rows", await app.screenshot().then((s) => s.path));
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
