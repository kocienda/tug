/**
 * at0521-arc-receipt-stage-usage.test.ts — an arc receipt's stage row shows
 * what the stage cost, and no session id anywhere.
 *
 * ## Why this exists
 *
 * The stage row's trailing cell used to print the stage's claude session id as
 * `session:<8 hex>`. The id is a join key: it names nothing a reader can hold,
 * and resolved to a name it would print the same name on every row of the arc
 * — the card the reader is already looking at. So the id stays exactly where
 * it is in the record and in the receipt's own text, and becomes the *lookup*:
 * `sessions` is keyed by segment, a stage IS a segment, and the ledger sums its
 * `turn_telemetry` into tokens and active time — the pair the agent footer
 * already prints for a finished unit of agent work.
 *
 * Three facts, on one rendered receipt, in the running app:
 *
 *   1. **The numbers arrive on the wire and land in the cell.** The usage rides
 *      the `session_updated` push beside the row, through the production
 *      decoder and the production store write — the same path the telemetry
 *      write's own push takes. The cell reads a token figure and a duration.
 *   2. **A stage the ledger has said nothing about keeps its row.** The second
 *      stage's id gets no push. Its stage word and its model still stand; only
 *      the figure is absent, because `0 tokens` would be a claim the app
 *      cannot make about a segment that recorded nothing.
 *   3. **The block carries no `session:` string at all.** The whole point of
 *      the change: the id left the interface while every place it is recorded,
 *      logged and parsed stayed exactly as it was.
 *
 * The receipt is driven in as a real `/arc-run` shell exchange carrying the
 * exact string `format_arc_receipt` writes, so the renderer under test is the
 * production one against the production parser.
 *
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.css
 * @covers tugdeck/src/lib/session-usage-store.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The stage whose numbers the ledger answers for. */
const SID_KNOWN = "557d7058-8076-4c1d-9f7e-2b3a4c5d6e7f";
/** The stage it says nothing about. */
const SID_SILENT = "0431f0dd-cb36-4a2b-8c1d-9e0f1a2b3c4d";

const CARD = '[data-testid="session-card"]';
const RECEIPT = `${CARD} [data-slot="arc-receipt-block"]`;
const USAGE_CELLS = `${RECEIPT} [data-slot="arc-receipt-stage-usage"]`;
const STAGE_WORDS = `${RECEIPT} .arc-receipt-stage-word`;
const STAGE_MODELS = `${RECEIPT} .arc-receipt-stage-model`;

/** The receipt's own text, in the shape `format_arc_receipt` writes it. */
const RECEIPT_TEXT = [
  "arc complete · atom-selections",
  "opened on .tug/arcs/atom-selections/brief.md",
  `implement · opus · ${SID_KNOWN}`,
  `audit · opus · ${SID_SILENT}`,
].join("\n");

/** A `session_updated` body carrying a segment's usage, as the supervisor pushes it. */
function usagePush(sessionId: string, usage: Record<string, number>): string {
  return JSON.stringify({ session_id: sessionId, usage });
}

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

const textsJS = (selector: string): string =>
  `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
     .map(function (n) { return (n.textContent || "").trim(); })`;

describe.skipIf(!SHOULD_RUN)("AT0521: a stage row costs, it does not cite", () => {
  test(
    "the trailing cell reads tokens and active time, and no id survives",
    async () => {
      const app = await launchTugApp({
        testName: "at0521-arc-receipt-stage-usage",
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 20_000 },
        );
        // A bound card is what makes the transcript take a driven exchange;
        // nothing here needs a live engine beyond that.
        await app.bindSession("A", { projectDir: "/tmp" });

        await app.driveSession("A", {
          op: "shellExchange",
          exchangeId: "at0521-arc",
          command: "/arc-run",
          output: RECEIPT_TEXT,
          cwd: "/tmp",
          exitCode: 0,
          startedAtMs: 1_700_000_000_000,
        });
        await app.waitForCondition<boolean>(
          `${textsJS(STAGE_WORDS)}.length === 2`,
          { timeoutMs: 30_000 },
        );

        // Both rows stand before any answer, with nothing in the trailing
        // cells: a figure nobody has answered for is not a gap.
        expect(await app.evalJS<string[]>(textsJS(USAGE_CELLS))).toEqual(["", ""]);

        // The ledger answers for one of them — the real wire shape, through
        // the production decoder.
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishSessionUpdated(${JSON.stringify(
              usagePush(SID_KNOWN, {
                turns: 10,
                tokens: 1_885_093,
                active_ms: 1_391_000,
              }),
            )})`,
          ),
          "the deck took the push",
        ).toBe(true);

        await app.waitForCondition<boolean>(
          `${textsJS(USAGE_CELLS)}.some(function (t) { return t.length > 0; })`,
          { timeoutMs: 20_000 },
        );
        const cells = await app.evalJS<string[]>(textsJS(USAGE_CELLS));
        const words = await app.evalJS<string[]>(textsJS(STAGE_WORDS));
        const models = await app.evalJS<string[]>(textsJS(STAGE_MODELS));
        note(
          "at0521 stage rows",
          JSON.stringify({ words, models, cells }),
        );
        note("at0521 receipt", (await app.screenshot()).path);

        // 1. The answered stage reads a token figure and a duration.
        expect(cells[0]).toMatch(/tokens/);
        expect(cells[0]).toMatch(/\d/);
        expect(cells[0]).toContain("·");
        // `formatDurationMs` spells 1_391_000ms as minutes and seconds.
        expect(cells[0]).toMatch(/\d+m \d{2}s/);

        // 2. The silent stage keeps its row and shows no figure.
        expect(cells[1]).toBe("");
        expect(words).toEqual(["implement", "audit"]);
        expect(models).toEqual(["opus", "opus"]);

        // 3. No id anywhere in the block — not as a label, not as a chip.
        const blockText = await app.evalJS<string>(
          `(function () {
             var b = document.querySelector(${JSON.stringify(RECEIPT)});
             return b === null ? "" : (b.textContent || "");
           })()`,
        );
        expect(blockText).not.toContain("session:");
        expect(blockText).not.toContain(SID_KNOWN.slice(0, 8));
        expect(blockText).not.toContain(SID_SILENT.slice(0, 8));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
