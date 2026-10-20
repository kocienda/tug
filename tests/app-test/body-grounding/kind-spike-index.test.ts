/**
 * kind-spike-index.test.ts — a Spikes index row, clicked in its body, opens
 * that spike as a tab of the shell's pane.
 *
 * The row says `ADD_TAB` to its pane. `ADD_TAB` is pane currency rather
 * than a command, so the body's unhandled-target hook never forwards it;
 * the body's pane responder answers it itself, through the bridge's
 * `addCardToPane`, which reaches the shell as `add-card` advice and lands on
 * the pane the index stands in. Before that route existed the click died
 * silently in the body — this is the check that it does not.
 *
 * @foreground
 * @covers tugdeck/src/spikes/spike-home.tsx
 * @covers tugdeck/src/body/body-root.tsx
 * @covers tugdeck/src/body/body-card-deck.ts
 * @covers tugdeck/src/lib/body-shell.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import { BODY_READY_MS, pollFor } from "./_bodies";
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
/** The component ids of the cards in the index's pane, in the shell's deck. */
const paneKinds = `(function () {
  var s = window.tugdeck.diag.getDeckState();
  var p = s.panes.find(function (p) { return p.cardIds.indexOf(${JSON.stringify(HOME)}) !== -1; });
  if (!p) return [];
  return p.cardIds.map(function (id) { var c = s.cards.find(function (c) { return c.id === id; }); return c ? c.componentId : null; });
})()`;

describe.skipIf(!SHOULD_RUN)("body-grounding kind check: the Spikes index's rows open their spike", () => {
  test(
    "a row clicked in the index's body adds that spike to the index's pane in the shell",
    async () => {
      const app = await launchTugApp({ testName: TEST_NAME, foreground: true });
      try {
        await app.seedDeckState({ state: DECK, focusCardId: HOME });
        const ready = await pollFor(() => bodySnapshot(app, HOME), (b) => b !== null && b.state === "ready" && b.visible, BODY_READY_MS);
        expect(ready?.state, "the index's body stands ready").toBe("ready");
        const body = app.body(HOME);
        const up = await pollFor(() => body.evalJS<boolean>(present(FIRST_ROW)), (v) => v, BODY_READY_MS);
        expect(up, "the index's first row is mounted in its body").toBe(true);
        expect(await app.evalJS<boolean>(present(ROOT)), "the shell's document holds none of the index").toBe(false);

        const spike = await body.evalJS<string | null>(firstRowSpike);
        expect(spike, "the first row names a spike").not.toBeNull();
        const expected = `spike-${spike}`;
        expect(await app.evalJS<string[]>(paneKinds), "the pane holds the index alone before the click").toEqual(["spike-home"]);

        await Bun.sleep(300);
        await body.nativeClickAtElement(FIRST_ROW);
        const kinds = await pollFor(() => app.evalJS<string[]>(paneKinds), (k) => k.length > 1, READ_MS);
        note(`pane after the click: ${kinds.join(", ")}`);
        expect(kinds, "the clicked row's spike is a tab of the index's pane").toEqual(["spike-home", expected]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
