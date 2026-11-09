/**
 * at0795-workspaces-selection-per-workspace.test.ts — the layout selection is
 * each workspace's own: a switch sets the departing workspace's set aside, and
 * the return puts it back.
 *
 * The set is what the deck's layout verbs act on and what the Workspaces list
 * fills. One deck-wide set used to collapse on every switch, because the
 * switch fronts the arriving workspace's card and an activation outside the
 * set collapses it. Now each workspace keeps the set it was left with, in
 * memory, and only the active workspace's is the selection — so the arriving
 * workspace's list fills none of the departed workspace's rows, and going back
 * finds the set where it was.
 *
 * One launch, two workspaces of three Text cards each beside a Workspaces
 * card. Two cards are selected in the first, the reader switches by a click
 * on the other's header and selects one there, then switches back and
 * forward again. At each stop the shell's selection and the list's fill are
 * both read, since the verbs read the one and the reader sees the other.
 *
 * @covers tugdeck/src/lib/cards-selection-store.ts
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

const spaceId = (i: number): string => `at0795-s${i}`;
const headerOf = (i: number): string =>
  `.cards-space-header[data-cards-space-id="${spaceId(i)}"]`;

/** The titles of the cards whose rows the list fills as selected, in list order. */
const FILLED = `(function () {
   var cells = document.querySelectorAll(".cards-list .tug-list-view-cell[data-selected]");
   var titles = ["T0", "U0", "V0", "T1", "U1", "V1"];
   var out = [];
   Array.prototype.forEach.call(cells, function (c) {
     var text = c.textContent || "";
     titles.forEach(function (t) { if (text.indexOf(t) >= 0) out.push(t); });
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

interface Stop {
  selection: string[];
  filled: string[];
}

describe.skipIf(!SHOULD_RUN)("at0795 — the layout selection is each workspace's own", () => {
  test(
    "a switch parks the departing set, and the return restores it",
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
        testName: "at0795-selection-per-workspace",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      const cards = kindBody(app, "cards");

      const select = async (ids: string[]): Promise<void> => {
        await app.evalJS<null>(`(window.__tug.setLayoutSelection(${JSON.stringify(ids)}), null)`);
        await settle();
      };
      /** Where the selection stands: the shell's set, and the list's fill. */
      const stop = async (): Promise<Stop> => ({
        selection: [...(await app.evalJS<string[]>(`window.__tug.getLayoutSelection()`))],
        filled: await cards.evalJS<string[]>(FILLED),
      });
      const goTo = async (i: number): Promise<void> => {
        await cards.nativeClickAtElement(headerOf(i));
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(spaceId(i))}`,
          { timeoutMs: 10_000 },
        );
        await cards.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(headerOf(i))}) !== null`,
          { timeoutMs: 15_000 },
        );
        await settle(700);
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

        await select(["U0", "V0"]);
        const made = await stop();
        await goTo(1);
        const away = await stop();
        await select(["U1"]);
        const madeThere = await stop();
        await goTo(0);
        const back = await stop();
        await goTo(1);
        const forward = await stop();
        note(
          `at0795 made=${JSON.stringify(made)} away=${JSON.stringify(away)} ` +
            `madeThere=${JSON.stringify(madeThere)} back=${JSON.stringify(back)} forward=${JSON.stringify(forward)}`,
        );

        expect(made, "the first workspace's set is the selection, and the list fills it").toEqual({
          selection: ["U0", "V0"],
          filled: ["U0", "V0"],
        });
        expect(
          away.selection.filter((id) => id.endsWith("0")),
          "in the other workspace no card of the first is selected",
        ).toEqual([]);
        expect(
          away.filled.filter((t) => t.endsWith("0")),
          "and the list fills none of the first workspace's rows",
        ).toEqual([]);
        expect(madeThere).toEqual({ selection: ["U1"], filled: ["U1"] });
        expect(back, "back in the first workspace, its set is restored and filled").toEqual({
          selection: ["U0", "V0"],
          filled: ["U0", "V0"],
        });
        expect(forward, "and the second workspace's own set was kept for it too").toEqual({
          selection: ["U1"],
          filled: ["U1"],
        });
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
