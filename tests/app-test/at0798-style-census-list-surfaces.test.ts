/**
 * at0798-style-census-list-surfaces.test.ts — the rail cards' lists look
 * exactly as they did before their reach-in CSS became list variants.
 *
 * The Cards and Jots cards each mount a `TugListView` of `TugListRow`s,
 * and each used to restyle those primitives from its own CSS: the list's
 * content-fit height and its rail look, a row's dimmed state, the title the
 * rows borrow. Those now live in the primitives as variants the cards pass,
 * and the one claim worth pinning is that nothing a user can see moved. This
 * file reads a fixed property list off the lists' roots, cells, rows and
 * titles and compares it with the baseline recorded before the CSS moved
 * (`style-census/list-surfaces.json`; `TUG_STYLE_CENSUS_RECORD=1` rewrites it).
 *
 * Runs against an isolated jots file (`TUG_JOTS_PATH`) so the user's
 * machine-global jots.json is never touched.
 *
 * @covers tests/app-test/_harness/style-census.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/tug-list-view.css
 * @covers tugdeck/src/components/tugways/tug-list-row.tsx
 * @covers tugdeck/src/components/tugways/tug-list-row.css
 * @covers tugdeck/src/components/tugways/rail-list-presentation.ts
 * @covers tugdeck/src/components/cards/cards-card.css
 * @covers tugdeck/src/components/jots/jots-card.css
 */

import { describe, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { priorCardDeck } from "./_harness/shapes";
import { censusRead, expectCensus, type CensusReading } from "./_harness/style-census";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const CARDS_HEADER = '.cards-list [data-testid="cards-header"]';
const CARDS_ROW = ".cards-list .cards-row[data-cards-row-id]";
const JOT = '.jots-list [data-jot-id="s1"]';

const exists = (sel: string): string =>
  `document.querySelector(${JSON.stringify(sel)}) !== null`;

describe.skipIf(!SHOULD_RUN)("at0798 — style census: list surfaces", () => {
  test(
    "the rail lists' roots, cells, rows and titles match their recording",
    async () => {
      const tugbankPath = mkTempTugbank();
      const jotsDir = mkdtempSync(join(tmpdir(), "tug-at0798-"));
      const jotsPath = join(jotsDir, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify({ version: 1, jots: [{ id: "s1", text: "the first jot" }, { id: "s2", text: "the second jot" }] }, null, 2)}\n`,
      );
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0798-style-census-list-surfaces",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          const reading: CensusReading = {};

          await app.dispatchControlAction("toggle-cards");
          const cards = kindBody(app, "cards");
          await cards.waitForCondition<boolean>(
            `${exists(CARDS_HEADER)} && ${exists(CARDS_ROW)}`,
            { timeoutMs: 10_000 },
          );
          Object.assign(reading, await censusRead(cards, [
            { selector: ".cards-list" },
            { selector: '.cards-list .tug-list-view-cell[data-tug-list-cell-kind="group-header"]' },
            { selector: CARDS_HEADER },
            { selector: `${CARDS_HEADER} .tug-list-row-content` },
            { selector: `${CARDS_HEADER} .tug-list-row-title` },
            { selector: CARDS_ROW },
            { selector: `${CARDS_ROW} .tug-list-row-content` },
            { selector: `${CARDS_ROW} .tug-list-row-leading` },
            { selector: `${CARDS_ROW} .tug-list-row-title` },
          ]));

          await app.dispatchControlAction("toggle-jots");
          const jots = kindBody(app, "jots");
          await jots.waitForCondition<boolean>(exists(JOT), { timeoutMs: 10_000 });
          Object.assign(reading, await censusRead(jots, [
            { selector: ".jots-list" },
            { selector: '.jots-list .tug-list-view-cell[data-tug-list-cell-index="0"]' },
            { selector: JOT },
          ]));
          expectCensus("list-surfaces", reading);
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
        rmSync(jotsDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
