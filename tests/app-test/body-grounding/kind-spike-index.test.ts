/**
 * kind-spike-index.test.ts — a Spikes index row, clicked in its body, opens
 * that spike in a new card of its own, never as a tab of the index's pane.
 *
 * The row dispatches the registry command `show-card`, which the body has no
 * handler for and so hands to the shell; the shell's deck adds the spike as a
 * fresh card, placed from the index. This is the check that the click
 * crosses the body boundary and lands as a card, not as a tab.
 *
 * @covers tugdeck/src/spikes/spike-home.tsx
 * @covers tugdeck/src/body/body-root.tsx
 * @covers tugdeck/src/body/body-card-deck.ts
 * @covers tugdeck/src/lib/body-shell.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import { BODY_READY_MS, settleFor } from "./_bodies";
import { bodySnapshot } from "./_kind-bodies";

const TEST_NAME = "body-grounding-kind-spike-index";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const READ_MS = 5_000;

const HOME = "ksi-home";
const ROOT = '[data-slot="spike-home"]';
const FIRST_ROW = `${ROOT} [data-slot="spike-home-row"]`;

/** The deck: one slotted pane holding the Spikes index alone. */
const DECK = {
  cards: [{ id: HOME, componentId: "spike-home", title: "Spikes", closable: true }],
  panes: [
    {
      id: `${HOME}-pane`,
      position: { x: 40, y: 40 },
      size: { width: 640, height: 520 },
      cardIds: [HOME],
      activeCardId: HOME,
      title: "",
      acceptsFamilies: ["spike"],
      slot: 0,
    },
  ],
  activePaneId: `${HOME}-pane`,
  imposition: { kind: "four-up", layout: "flow", sidebars: {} },
  hasFocus: true,
};

const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;
/** The spike the first row names, read off the row itself. */
const firstRowSpike = `(function () { var r = document.querySelector(${JSON.stringify(FIRST_ROW)}); return r ? r.getAttribute("data-spike") : null; })()`;
/** Each pane's card component ids, in the shell's deck. */
const deckKinds = `(function () {
  var s = window.tugdeck.diag.getDeckState();
  return s.panes.map(function (p) {
    return p.cardIds.map(function (id) { var c = s.cards.find(function (c) { return c.id === id; }); return c ? c.componentId : null; });
  });
})()`;

describe.skipIf(!SHOULD_RUN)("body-grounding kind check: the Spikes index's rows open their spike", () => {
  test(
    "a row clicked in the index's body opens that spike in a new card in the shell",
    async () => {
      const app = await launchTugApp({ testName: TEST_NAME });
      try {
        await app.seedDeckState({ state: DECK, focusCardId: HOME });
        const ready = await settleFor(() => bodySnapshot(app, HOME), (b) => b !== null && b.state === "ready" && b.visible, BODY_READY_MS);
        expect(ready?.state, "the index's body stands ready").toBe("ready");
        const body = app.body(HOME);
        const up = await settleFor(() => body.evalJS<boolean>(present(FIRST_ROW)), (v) => v, BODY_READY_MS);
        expect(up, "the index's first row is mounted in its body").toBe(true);
        expect(await app.evalJS<boolean>(present(ROOT)), "the shell's document holds none of the index").toBe(false);

        const spike = await body.evalJS<string | null>(firstRowSpike);
        expect(spike, "the first row names a spike").not.toBeNull();
        const expected = `spike-${spike}`;
        expect(await app.evalJS<string[][]>(deckKinds), "the deck holds the index alone before the click").toEqual([["spike-home"]]);

        await Bun.sleep(300);
        await body.nativeClickAtElement(FIRST_ROW);
        const panes = await settleFor(() => app.evalJS<string[][]>(deckKinds), (p) => p.length > 1, READ_MS);
        note(`panes after the click: ${panes.map((p) => p.join("+")).join(", ")}`);
        expect(panes, "the index's pane still holds the index alone").toContainEqual(["spike-home"]);
        expect(panes, "the clicked row's spike stands in a card of its own").toContainEqual([expected]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
