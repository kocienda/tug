/**
 * at0529-arc-finish-quiet-line.test.ts — a complete arc finishes as a quiet
 * line, and a stopped one keeps its receipt ([B04], [F08]).
 *
 * ## Why this exists
 *
 * `/arc-run` is one command carrying three outcomes, and until now all three
 * wore the same shape: a Wheel-attributed transcript entry with the arc's
 * record in its body. For an arc that *finished* that was a second full report
 * of an event the landing already reports — the record folds behind the
 * `Joined` boundary once the arc lands ([B02]), and before it lands the record
 * is the Arcs card's. So the finish is now one derived sentence in the arc-note
 * register, in the seat every other arc gesture takes.
 *
 * For an arc that *stopped* it was never a duplicate: the row carries the
 * stage's own words and the Resume offer, neither of which a line can hold.
 * That half must not move, and the second assertion is what says so.
 *
 * Two rows, in the running app, from the exact strings the Rust formatters
 * write:
 *
 *   1. **The finish is a quiet line at the body inset.** `<arc> Finished · N
 *      stages` under the ship wheel, no entry scaffolding around it, and its
 *      text starting at the same x as an ordinary arc gesture's line — the
 *      claim that it joined that register rather than merely resembling it.
 *   2. **The stop is still a receipt, and still offers Resume.** The block,
 *      the stage's own words, and the button, all where they were.
 *
 * The presentation is resolved per row rather than per command, which is what
 * lets one registration seat its outcomes differently; the pure half of that
 * reading is pinned in `session-arc-receipt-block.test.ts`.
 *
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-command-block-registry.ts
 * @covers tugdeck/src/lib/arc-note-command.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-testid="session-card"]';
/** The finish's line, and an ordinary arc gesture's, in the same register. */
const FINISH = `${CARD} [data-slot="arc-finish-line"]`;
const GESTURE = `${CARD} [data-slot="session-arc-note-line"]`;
const RECEIPT = `${CARD} [data-slot="arc-receipt-block"]`;
const RESUME = `${RECEIPT} .arc-receipt-resume`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

/**
 * The exact bytes `format_arc_receipt` writes for an arc that finished —
 * copied from `the_receipt_names_every_stage_its_model_and_its_session`.
 */
const COMPLETE = [
  "arc complete · atom-selections",
  "opened on .tug/arcs/atom-selections/brief.md",
  "devise · opus · 557d7058-8076-4c1d-9f7e-2b3a4c5d6e7f",
  "implement · account default · 0431f0dd-cb36-4a2b-8c1d-9e0f1a2b3c4d",
  "plan .tug/arcs/atom-selections/plan.md",
].join("\n");

/** A resumable stop: the one outcome that keeps a receipt AND an offer. */
const STOPPED = [
  "arc stopped · stalled-lane · in review — the review ended without stamping the plan",
  "opened on .tug/arcs/stalled-lane/brief.md",
  "review · opus · 8c1d9e0f-1a2b-3c4d-5e6f-7a8b9c0d1e2f",
].join("\n");

/** An ordinary arc gesture's quiet line, as tugcast derives one. */
const GESTURE_COMMAND = "arc create atom-selections";
const GESTURE_OUTPUT = "atom-selections: arc created";

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 1100, height: 760 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("AT0529: the finish is a line, the stop is a receipt", () => {
  test(
    "a complete arc paints a quiet line beside the other gestures; a stop keeps its offer",
    async () => {
      const app = await launchTugApp({ testName: "at0529-arc-finish-quiet-line" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 20_000 },
        );
        await app.bindSession("A", { projectDir: "/tmp" });

        // An ordinary gesture first, as the register's own reference row.
        await app.driveSession("A", {
          op: "shellExchange",
          exchangeId: "at0529-gesture",
          command: GESTURE_COMMAND,
          output: GESTURE_OUTPUT,
          cwd: "/tmp",
          exitCode: 0,
          startedAtMs: 1_700_000_000_000,
        });
        await app.driveSession("A", {
          op: "shellExchange",
          exchangeId: "at0529-complete",
          command: "/arc-run",
          output: COMPLETE,
          cwd: "/tmp",
          exitCode: 0,
          startedAtMs: 1_700_000_001_000,
        });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(FINISH)}).length === 1`,
          { timeoutMs: 30_000 },
        );

        const finish = await app.evalJS<{
          text: string;
          label: string;
          name: string;
          glyphs: number;
          left: number;
          gestureLeft: number;
          receipts: number;
          entries: number;
        }>(
          `(() => {
             const line = document.querySelector(${JSON.stringify(FINISH)});
             const gesture = document.querySelector(${JSON.stringify(GESTURE)});
             const x = (n) =>
               Math.round(
                 (n.querySelector(".session-arc-note-label") ?? n).getBoundingClientRect().left,
               );
             return {
               text: (line.textContent ?? "").trim(),
               label: (line.querySelector(".session-arc-note-label")?.textContent ?? "").trim(),
               name: (line.querySelector(".session-arc-note-name")?.textContent ?? "").trim(),
               glyphs: line.querySelectorAll("svg").length,
               left: x(line),
               gestureLeft: x(gesture),
               // No receipt block for this row, and no entry scaffolding: the
               // quiet seat is the whole of it.
               receipts: document.querySelectorAll(${JSON.stringify(RECEIPT)}).length,
               entries: document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}).length,
             };
           })()`,
        );
        note(`at0529 finish line: ${JSON.stringify(finish)}`);
        note("at0529 finish", (await app.screenshot()).path);

        // The arc's own quiet run, then the gesture as one bold label ([B09]).
        expect(finish.name).toBe("atom-selections");
        expect(finish.label).toBe("atom-selections Finished · 2 stages");
        expect(finish.glyphs, "the ship wheel, and nothing else").toBe(1);
        // The record is not here — it folds behind the `Joined` boundary once
        // the arc lands, and `at0521` reads it there.
        expect(finish.text).not.toContain("opened on");
        expect(finish.text).not.toContain("plan .tug/arcs");
        expect(finish.text).not.toContain("devise");
        // The seat: the same x as every other arc gesture's line, which is the
        // claim that it joined the register rather than resembling it.
        expect(
          Math.abs(finish.left - finish.gestureLeft),
          "the finish sits at the arc-note register's own inset",
        ).toBeLessThanOrEqual(1);
        // No receipt block, and neither quiet row is a transcript entry.
        expect(finish.receipts, "a finished arc leaves no receipt block").toBe(0);
        expect(finish.entries, "and no entry scaffolding around either line").toBe(0);

        // ── The stop, unchanged ──────────────────────────────────────────
        await app.driveSession("A", {
          op: "shellExchange",
          exchangeId: "at0529-stopped",
          command: "/arc-run",
          output: STOPPED,
          cwd: "/tmp",
          exitCode: 0,
          startedAtMs: 1_700_000_002_000,
        });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(RECEIPT)}).length === 1`,
          { timeoutMs: 30_000 },
        );
        const stop = await app.evalJS<{
          text: string;
          offers: number;
          button: string;
          entries: number;
          lines: number;
        }>(
          `(() => {
             const block = document.querySelector(${JSON.stringify(RECEIPT)});
             return {
               text: (block.textContent ?? "").trim(),
               offers: document.querySelectorAll(${JSON.stringify(RESUME)}).length,
               button: (
                 document.querySelector(${JSON.stringify(RESUME)})?.textContent ?? ""
               ).trim(),
               entries: document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}).length,
               lines: document.querySelectorAll(${JSON.stringify(FINISH)}).length,
             };
           })()`,
        );
        note(`at0529 stop receipt: ${JSON.stringify(stop)}`);
        // The record the stop carries is its own — the stage that stopped and
        // what it was opened on stay on the row.
        expect(stop.text).toContain("review");
        expect(stop.text).toContain("opened on .tug/arcs/stalled-lane/brief.md");
        // And the offer, which is why this outcome is a receipt at all.
        expect(stop.offers, "a resumable stop still offers Resume").toBe(1);
        expect(stop.button).toContain("Resume");
        // It takes an entry, unlike the two lines above it.
        expect(stop.entries, "the stop keeps the entry the lines gave up").toBe(1);
        expect(stop.lines, "and adds no second finish line").toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
