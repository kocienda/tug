/**
 * at0407-arcs-card-meta.test.ts — a stepped plan fills the meta line, and
 * stage rank orders the rows.
 *
 * One of the at0407-arcs-card split, a test to a file so each launch fits its
 * own budget; the others are `at0407-arcs-card-unbound`, `-kind` and `-fold`.
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
  PLAN_ARC,
  PLAN_ROW,
  SECTION,
  SHOULD_RUN,
  SID,
  SKIPPED_ROW,
  TEST_TIMEOUT_MS,
  withArcsCardScratch,
} from "./arcs-card-fixture";

const { projectDir, dataRoot } = withArcsCardScratch();

describe.skipIf(!SHOULD_RUN)("AT0407: the Arcs card", () => {
  test(
    "a stepped plan fills the meta line, and stage rank orders the rows",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0407-arcs-meta",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: dataRoot() },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // The scratch repo enters the aggregate only as a registered
        // workspace, and spawning a session on it is what registers it.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        await app.dispatchControlAction("toggle-arcs");
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PLAN_ROW)}) !== null`,
          { timeoutMs: 30000 },
        );

        const meta = await kindBody(app, "dashes").evalJS<{
          phase: string | null;
          fraction: string;
          tracks: number;
          ticks: string[];
          noteText: string;
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(PLAN_ROW)});
             const track = row.querySelector('[data-slot="tug-arc-track"]');
             const fraction = row.querySelector('[data-slot="tug-step-fraction"]');
             const note = row.querySelector('[data-slot="tug-arc-lifecycle-note"]');
             const cell = track?.querySelector(
               '[data-slot="tug-arc-track-cell"][data-phase="implement"]',
             );
             return {
               phase: track?.getAttribute("data-phase") ?? null,
               fraction: (fraction?.textContent ?? "").trim(),
               tracks: row.querySelectorAll('[data-slot="tug-arc-track"]').length,
               ticks: cell
                 ? Array.from(cell.querySelectorAll(".tug-arc-track-tick")).map(
                     (el) => el.getAttribute("data-state"),
                   )
                 : [],
               noteText: (note?.textContent ?? "").trim(),
             };
           })()`,
        );
        note("at0407 stepped meta line", JSON.stringify(meta));
        // A step is open on this arc, so the strip stands at `implement`.
        expect(meta.phase).toBe("implement");
        expect(meta.tracks).toBe(1);
        // The numerals count the PLAN — the step in progress over the rows the
        // plan holds. The track draws that same plan as ticks, one per row, so
        // the two readings cannot disagree.
        expect(meta.fraction).toBe("1/3");
        expect(meta.ticks).toEqual(["active", "pending", "pending"]);
        // The clause is the PHASE, not the step's title: the title rode this
        // slot until it elided mid-word in every host that was not the
        // placard, and it is the fraction's hover sentence now ([D168]).
        expect(meta.noteText).toBe("Executing");
        note("at0407 meta line", await app.screenshot().then((s) => s.path));

        // ── A withdrawn step paints its own tick, and the count agrees ────
        // The one shape a prefix reading cannot draw: step 7 of 8 withdrawn
        // and step 8 done, so the closed rows are not a run of the first N.
        // Nothing pure can see this — the tooltip's fraction and the ticks
        // beside it have to agree ON SCREEN, which is [P03]'s whole promise.
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SKIPPED_ROW)}) !== null`,
          { timeoutMs: 30000 },
        );
        const skippedTicks = await kindBody(app, "dashes").evalJS<string[]>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(SKIPPED_ROW)});
             const cell = row
               .querySelector('[data-slot="tug-arc-track"]')
               ?.querySelector('[data-slot="tug-arc-track-cell"][data-phase="implement"]');
             return cell
               ? Array.from(cell.querySelectorAll(".tug-arc-track-tick")).map(
                   (el) => el.getAttribute("data-state"),
                 )
               : [];
           })()`,
        );
        note("at0407 withdrawn ticks", JSON.stringify(skippedTicks));
        expect(skippedTicks).toEqual([
          "done",
          "done",
          "done",
          "done",
          "done",
          "done",
          "withdrawn",
          "done",
        ]);
        note("at0407 withdrawn tick", await app.screenshot().then((s) => s.path));

        // ── The block's two lines are related by their centre ─────────────
        // The eyebrow anchors an identity to each edge; the line under it
        // centres its whole run — track, then glyph, fraction, word —
        // as one unit. The line used to hang under the arc's NAME instead,
        // which was the right rule while it packed everything against its
        // leading edge.
        //
        // The line shares its row with the controls now — the transport and
        // the fold cue stand at the row's trailing edge, in the block's
        // `lineTrailing` slot — so the box this measures is the line's own,
        // which is the width left of the controls, and the claim is that the
        // run is centred INSIDE it. That is the seat's rule: the reading
        // keeps its relation to the eyebrow's centre, and the controls stand
        // in a fixed column beside it.
        //
        // Measured as the air on either side of the run rather than against a
        // constant, so retuning the row's density or the atom's padding moves
        // the expectation with it, and so the claim is the UNIT's centring
        // rather than the track's. A pixel of tolerance: an odd width has to
        // round somewhere.
        const stack = await kindBody(app, "dashes").evalJS<{
          lead: number;
          tail: number;
          fontSize: string;
          readScale: string;
          leadInset: number;
          tailInset: number;
          gestures: number;
          blocks: number[][];
        }>(
          `(() => {
             const rows = Array.from(document.querySelectorAll(${JSON.stringify(`${SECTION} [data-slot="arcs-row"]`)}));
             const first = rows[0];
             const line = first.querySelector('[data-slot="tug-arc-lifecycle-line"]');
             const box = line.getBoundingClientRect();
             const track = line.querySelector('[data-slot="tug-arc-track"]').getBoundingClientRect();
             const read = line.querySelector('[data-slot="tug-arc-lifecycle-reading"]').getBoundingClientRect();
             const rowBox = first.getBoundingClientRect();
             const block = first.querySelector('[data-slot="tug-arc-lifecycle-block"]').getBoundingClientRect();
             const R = (n) => Math.round(n * 10) / 10;
             return {
               lead: R(track.left - box.left),
               tail: R(box.right - read.right),
               fontSize: getComputedStyle(line).fontSize,
               readScale: getComputedStyle(document.body).getPropertyValue("--tug-font-size-sm").trim(),
               leadInset: R(block.left - rowBox.left),
               tailInset: R(rowBox.right - block.right),
               gestures: document.querySelectorAll('[data-slot="lens-plans-gesture"]').length,
               blocks: rows.map((r) => {
                 const b = r.getBoundingClientRect();
                 return [Math.round(b.top), Math.round(b.bottom)];
               }),
             };
           })()`,
        );
        note("at0407 stack", JSON.stringify(stack));
        // The card shows a whole arc, so it shows it at the scale every other
        // whole-arc surface uses — the placard's, the shade's. There is no
        // second scale to select any more, so the measured type size IS the
        // claim: a block that had drifted off the reading token would say so
        // here, and an attribute could only have said which name was set.
        expect(
          stack.fontSize,
          "the line is sized to the reading scale's token",
        ).toBe(stack.readScale);
        // The block's two identities are held apart by a hairline, so the air
        // outside them has to be even: `TugListRow` reserves a leading focus
        // gutter the trailing edge does not, and the pair read as leaning
        // toward the row's right edge. The BLOCK's box is the measure, so the
        // claim holds for an unbound arc too, whose eyebrow ends in the
        // hairline rather than in a worker atom. What the reader sees on a
        // BOUND row — the arc pill's leading margin against the worker
        // atom's trailing one — is at0438's, which has one.
        expect(
          Math.abs(stack.leadInset - stack.tailInset),
          "the block's inline air is even at both ends",
        ).toBeLessThanOrEqual(1);
        // And no plan row wears a next-gesture button: it read as a label
        // rather than a control, and the row reports rather than acts.
        // The slot keeps its retired spelling deliberately: it is the name the
        // button was emitted under, and a guard against re-introduction has to
        // name what would come back.
        expect(stack.gestures, "no next-gesture button survives").toBe(0);
        expect(
          Math.abs(stack.lead - stack.tail),
          "the run — track then reading — is centred in the line",
        ).toBeLessThanOrEqual(1);
        expect(
          stack.lead,
          "and it is a centred run, not a line filled edge to edge",
        ).toBeGreaterThan(1);

        // And one arc is separated from the next by a real step, not a
        // hairline. At 2px of block padding the two-line blocks touched, and
        // the second line of one arc sat as close to the eyebrow of the next
        // as to its own — which is what makes a block stop reading as a unit.
        if (stack.blocks.length >= 2) {
          const gap = stack.blocks[1]![0]! - stack.blocks[0]![1]!;
          const height = stack.blocks[0]![1]! - stack.blocks[0]![0]!;
          // Rows are flush, so the air lives inside them: what has to hold is
          // that a block is tall enough to carry a full step of padding around
          // its two lines.
          expect(gap, "rows are flush; the air is the block's own").toBe(0);
          expect(height, "each block carries a step of air").toBeGreaterThan(48);
        }

        // ── The ordering, in the DOM ──────────────────────────────────────
        // Both fixtures are unbound, so the stage rank decides: this arc is
        // `implementing` (a step is open on it), the other is `created`.
        const order = await kindBody(app, "dashes").evalJS<string[]>(
          `Array.from(
             document.querySelectorAll(${JSON.stringify(`${SECTION} [data-slot="arcs-row"]`)}),
           ).map((el) => el.getAttribute("data-arc"))`,
        );
        expect(order.indexOf(PLAN_ARC)).toBeGreaterThanOrEqual(0);
        expect(order.indexOf(ARC_NAME)).toBeGreaterThanOrEqual(0);
        expect(order.indexOf(PLAN_ARC)).toBeLessThan(order.indexOf(ARC_NAME));

        // ── The fraction beside those ticks says `closed`, not `done` ─────
        // A tooltip, so it has to be hovered — and it is read last, because a
        // Radix bubble does not close for a synthetic `pointerleave` and a
        // test that waited for it to would be waiting on nothing.
        await kindBody(app, "dashes").evalJS<null>(
          `(function(){
             const cell = document
               .querySelector(${JSON.stringify(SKIPPED_ROW)})
               .querySelector('[data-slot="tug-arc-track-cell"][data-phase="implement"]');
             cell.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
             cell.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
             return null;
           })()`,
        );
        // The bubble mounts in the page the hover was dispatched in: the
        // Arcs card's body.
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector('.tug-tooltip-content') !== null`,
          { timeoutMs: 5000 },
        );
        const closedTip = await kindBody(app, "dashes").getElementText(".tug-tooltip-content");
        note("at0407 withdrawn tip", closedTip);
        // Eight ticks and eight closed, agreeing on screen — a reader is never
        // told 7 of 8 beside eight filled ticks. This is [P03]'s whole promise
        // and the one thing no pure test can see. A closed cell says its
        // count as the participle's object — `Executed · 8 steps` ([B09]).
        expect(closedTip).toContain("Executed · 8 steps");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
