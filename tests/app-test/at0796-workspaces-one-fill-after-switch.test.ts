/**
 * at0796-workspaces-one-fill-after-switch.test.ts — after a switch made by a
 * click in the Workspaces list, the shown card fills one row for the cursor,
 * and it is the row the reader clicked.
 *
 * Every workspace holds its own Workspaces card, and a click leaves the list's
 * own selection — its fill — on the clicked row. A card parked holding that
 * fill used to paint it when its workspace came back: Main's card showed a
 * row of the workspace the reader had gone to, and that workspace's card a
 * row of Main, which read as a selection in a workspace nobody was in. The
 * deck has one cursor now, and a card coming on screen takes it with the fill
 * that goes with it.
 *
 * The fill a layout selection paints is the other half of `data-selected` and
 * is not the cursor's: those cells, named by the shell's selection, are set
 * aside before counting. The read is the screenshot's — what the shown card
 * fills — and the parked card is read too, since it is the next one to show.
 *
 * One launch, two workspaces. The reader clicks the second workspace's header
 * in the first's card, then the first's header in the second's card, then
 * the second's again — so each card has been left holding the other
 * workspace's header and is then shown again.
 *
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { kindBody } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const spaceId = (i: number): string => `at0796-s${i}`;
const headerOf = (i: number): string =>
  `.cards-space-header[data-cards-space-id="${spaceId(i)}"]`;
const TITLES = ["T0", "U0", "V0", "T1", "U1", "V1"];

/**
 * Every filled cell, named: `header:<spaceId>` for a workspace header, the
 * card's title for a card row, or `other` — with the card ids the layout
 * selection holds left out, since their fill is the selection's, not the
 * cursor's.
 */
const cursorFill = (layoutSelection: readonly string[]): string =>
  `(function () {
     var skip = ${JSON.stringify(layoutSelection)};
     var titles = ${JSON.stringify(TITLES)};
     var out = [];
     var cells = document.querySelectorAll(".cards-list .tug-list-view-cell[data-selected]");
     Array.prototype.forEach.call(cells, function (c) {
       var header = c.querySelector("[data-cards-space-id]");
       if (header !== null) { out.push("header:" + header.getAttribute("data-cards-space-id")); return; }
       var text = c.textContent || "";
       var title = titles.filter(function (t) { return text.indexOf(t) >= 0; })[0];
       if (title === undefined) { out.push("other"); return; }
       if (skip.indexOf(title) < 0) out.push(title);
     });
     return out;
   })()`;

const settle = (ms = 500): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Two workspaces, each a stack of three Text cards with the Workspaces card on the right rail. */
function blob(): Record<string, unknown> {
  const spaces = [0, 1].map((i) => ({
    id: spaceId(i),
    name: `W${i}`,
    deck: {
      cards: [
        { id: `T${i}`, componentId: "text", title: `T${i}`, closable: true },
        { id: `U${i}`, componentId: "text", title: `U${i}`, closable: true },
        { id: `V${i}`, componentId: "text", title: `V${i}`, closable: true },
        { id: `C${i}`, componentId: "cards", title: "Workspaces", closable: true },
      ],
      panes: [
        {
          id: `pt${i}`,
          position: { x: 60, y: 60 },
          size: { width: 700, height: 400 },
          cardIds: [`T${i}`, `U${i}`, `V${i}`],
          activeCardId: `T${i}`,
          title: "",
          acceptsFamilies: ["standard"],
        },
        {
          id: `pc${i}`,
          position: { x: 0, y: 0 },
          size: { width: 460, height: 900 },
          cardIds: [`C${i}`],
          activeCardId: `C${i}`,
          title: "",
          acceptsFamilies: [] as string[],
        },
      ],
      activePaneId: `pt${i}`,
      imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
      hasFocus: true,
    },
  }));
  return { version: 5, activeSpaceId: spaceId(0), spaces };
}

interface Reading {
  shown: string[];
  parked: string[];
}

describe.skipIf(!SHOULD_RUN)("at0796 — one fill after a switch, the clicked row", () => {
  test(
    "the shown card fills only the clicked row for the cursor, and no card fills a departed row",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.deck.layout",
        "layout",
        "json",
        JSON.stringify(blob()),
      );
      const app = await launchTugApp({
        testName: "at0796-one-fill",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      const cards = kindBody(app, "cards");

      /** Click workspace `to`'s header in the card on screen, and read both cards once it lands. */
      const switchTo = async (to: number): Promise<Reading> => {
        await cards.nativeClickAtElement(headerOf(to));
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(spaceId(to))}`,
          { timeoutMs: 10_000 },
        );
        await cards.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(headerOf(to))}) !== null`,
          { timeoutMs: 15_000 },
        );
        await settle(700);
        const selection = await app.evalJS<string[]>(`window.__tug.getLayoutSelection()`);
        return {
          shown: await app.body(`C${to}`).evalJS<string[]>(cursorFill(selection)),
          parked: await app.body(`C${1 - to}`).evalJS<string[]>(cursorFill(selection)),
        };
      };

      try {
        await app.waitForCondition<boolean>(
          `typeof window.tugdeck !== "undefined"
           && window.tugdeck.diag.getSpaces().spaces.length === 2`,
          { timeoutMs: 15_000 },
        );
        await cards.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(headerOf(0))}) !== null`,
          { timeoutMs: 15_000 },
        );
        await settle();

        const first = await switchTo(1);
        const back = await switchTo(0);
        const again = await switchTo(1);
        note(
          `at0796 first=${JSON.stringify(first)} back=${JSON.stringify(back)} again=${JSON.stringify(again)}`,
        );

        const departedRow = (from: number) => (label: string): boolean =>
          label === `header:${spaceId(from)}` || label.endsWith(String(from));
        expect(first.shown, "the arriving card fills the clicked header alone").toEqual([
          `header:${spaceId(1)}`,
        ]);
        expect(back.shown, "a card shown again fills the row just clicked, not the one it was left by").toEqual([
          `header:${spaceId(0)}`,
        ]);
        expect(again.shown, "and the same on the return").toEqual([`header:${spaceId(1)}`]);
        for (const [reading, from] of [
          [first, 0],
          [back, 1],
          [again, 0],
        ] as const) {
          expect(
            reading.shown.filter(departedRow(from)),
            "no row of the workspace just left is filled in the card on screen",
          ).toEqual([]);
          expect(
            reading.parked.filter(departedRow(from)),
            "nor in the card it was left in, which holds the row the reader clicked to leave",
          ).toEqual([]);
          expect(
            [...reading.shown, ...reading.parked].filter((l) => l === "other"),
            "every filled cell is a row this test can name",
          ).toEqual([]);
        }
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
