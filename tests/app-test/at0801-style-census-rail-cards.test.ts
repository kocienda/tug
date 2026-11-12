/**
 * at0801-style-census-rail-cards.test.ts — the Cards, Jots and Arcs cards'
 * shells look exactly as they did before their copies became one shell.
 *
 * The three rail cards each wrote the same shell from their own CSS: a root
 * that is the card's one scroller, a content column inside it, a positioned
 * wrap for the reorder caret, a toolbar for the filter field (the Cards and
 * Jots copies byte-identical), and a `None` line one row high. Those now live
 * in `rail-card-shell.css`, with only each card's own extras left in its CSS,
 * and the one claim worth pinning is that nothing a user can see moved. This
 * file reads a fixed property list off each part and compares it with the
 * baseline recorded before the CSS moved (`style-census/rail-cards.json`;
 * `TUG_STYLE_CENSUS_RECORD=1` rewrites it).
 *
 * @covers tests/app-test/_harness/style-census.ts
 * @covers tugdeck/src/components/tugways/cards/rail-card-shell.tsx
 * @covers tugdeck/src/components/tugways/cards/rail-card-shell.css
 * @covers tugdeck/src/components/cards/cards-card.css
 * @covers tugdeck/src/components/jots/jots-card.css
 * @covers tugdeck/src/components/arcs/arcs-card.css
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

const exists = (sel: string): string =>
  `document.querySelector(${JSON.stringify(sel)}) !== null`;

describe.skipIf(!SHOULD_RUN)("at0801 — style census: rail cards", () => {
  test(
    "the rail cards' scroller, content, wrap, toolbar and empty line match their recording",
    async () => {
      const tugbankPath = mkTempTugbank();
      const jotsDir = mkdtempSync(join(tmpdir(), "tug-at0801-"));
      const jotsPath = join(jotsDir, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify({ version: 1, jots: [{ id: "s1", text: "the first jot" }] }, null, 2)}\n`,
      );
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0801-style-census-rail-cards",
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
          await cards.waitForCondition<boolean>(exists(".cards-list .cards-row"), { timeoutMs: 10_000 });
          Object.assign(reading, await censusRead(cards, [
            { selector: ".cards-card" },
            { selector: ".cards-card-content" },
            { selector: ".cards-list-wrap" },
            { selector: '[data-testid="cards-toolbar"]' },
            { selector: '[data-testid="cards-toolbar"] > [data-slot="tug-filter-field"]' },
          ]));

          await app.dispatchControlAction("toggle-jots");
          const jots = kindBody(app, "jots");
          await jots.waitForCondition<boolean>(exists('.jots-list [data-jot-id="s1"]'), { timeoutMs: 10_000 });
          Object.assign(reading, await censusRead(jots, [
            { selector: ".jots-card" },
            { selector: ".jots-card-content" },
            { selector: ".jots-list-wrap" },
            { selector: '[data-testid="jots-toolbar"]' },
            { selector: '[data-testid="jots-toolbar"] > [data-slot="tug-filter-field"]' },
          ]));

          // No arcs in this instance, so the card draws its empty line.
          await app.dispatchControlAction("toggle-arcs");
          const arcs = kindBody(app, "dashes");
          await arcs.waitForCondition<boolean>(exists(".arcs-empty"), { timeoutMs: 10_000 });
          Object.assign(reading, await censusRead(arcs, [
            { selector: ".arcs-section" },
            { selector: ".arcs-card-content" },
            { selector: ".arcs-empty" },
          ]));

          expectCensus("rail-cards", reading);
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
