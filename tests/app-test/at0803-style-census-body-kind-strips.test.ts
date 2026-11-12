/**
 * at0803-style-census-body-kind-strips.test.ts — a body kind's standalone
 * header strip looks exactly as it did before the eight copies of its rule
 * became one shared class.
 *
 * The eight body kinds (file, diff, terminal, path list, JSON tree, todo list,
 * search result, agent transcript) each restated the same twelve declarations
 * for their pinned header strip. Those now live once, as `.tugx-block-strip`
 * in `styles/tugx-block.css` beside the tokens they read, and each header
 * wears that class beside its own. In the app every body kind but the JSON
 * tree mounts embedded, under a tool block's own header, where its strip is
 * not drawn; the gallery's JSON tree card mounts one standalone, so that is
 * the strip this file reads. The one claim worth pinning is that nothing a
 * user can see moved: it reads a fixed property list off the strip and its
 * spacer and compares it with the baseline recorded before the CSS moved
 * (`style-census/body-kind-strips.json`; `TUG_STYLE_CENSUS_RECORD=1` rewrites
 * it).
 *
 * @covers tests/app-test/_harness/style-census.ts
 * @covers tugdeck/styles/tugx-block.css
 * @covers tugdeck/src/components/tugways/body-kinds/json-tree-block.tsx
 * @covers tugdeck/src/components/tugways/body-kinds/json-tree-block.css
 * @covers tugdeck/src/components/tugways/cards/gallery-json-tree-block.tsx
 */

import { describe, test } from "bun:test";

import { launchTugApp } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import { censusRead, expectCensus } from "./_harness/style-census";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const STRIP =
  '[data-testid="gallery-json-tree-block"] > .gallery-json-tree-section:nth-child(1) .tugx-json-header';

function deckShape(): Record<string, unknown> {
  return {
    cards: [{ id: "G", componentId: "gallery-json-tree-block", title: "JsonTreeBlock", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 700 },
        cardIds: ["G"],
        activeCardId: "G",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("at0803 — style census: body-kind strips", () => {
  test(
    "the JSON tree's standalone header strip matches its recording",
    async () => {
      const app = await launchTugApp({ testName: "at0803-style-census-body-kind-strips" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "G" });
        const body = await waitForBodyReady(app, "G");
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(STRIP)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const reading = await censusRead(body, [
          {
            selector: STRIP,
            properties: [
              "position", "top", "z-index", "display", "align-items", "gap",
              "padding-top", "padding-right", "padding-bottom", "padding-left",
              "background-color", "border-bottom-width", "border-bottom-style",
              "border-bottom-color", "color", "font-family", "font-size", "height",
            ],
          },
          { selector: `${STRIP} > .tugx-json-header-spacer` },
        ]);
        expectCensus("body-kind-strips", reading);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
