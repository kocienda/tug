/**
 * at0407-arcs-card-unbound.test.ts — an unbound arc wears the eyebrow's verbs
 * and never a dot.
 *
 * One of the at0407-arcs-card split, a test to a file so each launch fits its
 * own budget; the others are `at0407-arcs-card-meta`, `-kind` and `-fold`.
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
  ARC_NAME,
  CHECKOUT,
  ROW,
  SECTION,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  withArcsCardScratch,
} from "./arcs-card-fixture";

const { projectDir, dataRoot } = withArcsCardScratch();

describe.skipIf(!SHOULD_RUN)("AT0407: the Arcs card", () => {
  test(
    "an unbound arc wears the eyebrow's verbs and never a dot",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0407-arcs-card",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: dataRoot() },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning is what registers the
        // scratch repo as a workspace, so its arcs reach the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // ── The section is there, and the arc's row is in it ─────────────
        await app.dispatchControlAction("toggle-arcs");
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SECTION)}) !== null`,
          { timeoutMs: 15000 },
        );
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30000 },
        );
        const unbound = await kindBody(app, "dashes").evalJS<{
          atomText: string;
          reviewTinted: boolean;
          reviewGlyphs: number;
          glyphs: number;
          eyebrowGlyphs: number;
          workers: number;
          dots: number;
          bound: string | null;
          phase: string | null;
          note: string;
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             const atom = row.querySelector('[data-slot="tug-arc-lifecycle-name"]');
             const track = row.querySelector('[data-slot="tug-arc-track"]');
             const note = row.querySelector('[data-slot="tug-arc-lifecycle-note"]');
             return {
               atomText: (atom?.textContent ?? "").trim(),
               // The pill never wears the review tint here — that yellow
               // means WAITING, and an arc is not waiting for anyone.
               reviewTinted: atom?.hasAttribute("data-review") === true,
               reviewGlyphs: row.querySelectorAll('[data-slot="arcs-review"]').length,
               glyphs: row.querySelectorAll('[data-slot="tug-arc-phase-mark"]').length,
               eyebrowGlyphs: row.querySelectorAll(
                 '[data-slot="tug-arc-lifecycle-eyebrow"] [data-slot="tug-arc-phase-mark"]',
               ).length,
               workers: row.querySelectorAll('[data-slot="tug-arc-lifecycle-worker"]').length,
               dots: row.querySelectorAll('[data-slot="tug-progress-indicator"]').length,
               bound: row.getAttribute("data-bound"),
               phase: track?.getAttribute("data-phase") ?? null,
               note: (note?.textContent ?? "").trim(),
             };
           })()`,
        );
        note("at0407 unbound row", JSON.stringify(unbound));
        expect(unbound.atomText).toBe(`^${ARC_NAME}`);
        expect(unbound.reviewTinted).toBe(false);
        expect(unbound.reviewGlyphs).toBe(0);
        // The phase glyph is on the LINE and only there: the eyebrow is the
        // identities alone, and the verbs are on the row's right-click rather
        // than behind an opener that spent the eyebrow's right end.
        expect(unbound.glyphs).toBe(1);
        expect(unbound.eyebrowGlyphs).toBe(0);
        expect(unbound.workers).toBe(0);
        // No phase dot on a row nobody works: an arc with a phase to report
        // has a session bound to it, and that session's atom carries the dot.
        expect(unbound.dots).toBe(0);
        expect(unbound.bound).toBeNull();
        // A freshly created arc has no documents and no arc, so the track
        // reads it as direct: nothing has happened to it yet but the work
        // itself. With no step open the line is the phase clause and nothing
        // more — the line has no empty state.
        expect(unbound.phase).toBe("implement");
        // The clause is the phase said as a verb in progress, never the enum
        // key the field above carries — spelled out rather than derived from
        // it, which is the whole point of the two being different words.
        expect(unbound.note).toBe("Executing");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
