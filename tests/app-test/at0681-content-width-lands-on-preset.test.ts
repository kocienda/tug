/**
 * at0681-content-width-lands-on-preset.test.ts — choosing the deck's content
 * width puts every content pane exactly on the preset.
 *
 * `set-content-width` is the Layout card's Card Width row: it re-widths every
 * content pane to the named preset and re-solves the rails in the same commit
 * (`DeckManager.setContentWidth`). The preset is the ask and the band is the
 * ceiling, so a pane lands on `min(preset, band)` — and on exactly that, to
 * the pixel, both in the record and on screen. A pane one pixel short reads as
 * a card that did not quite take the width it was given, and the seams beside
 * it stand a pixel off the ones `setCardWidths` produces for the same preset.
 *
 * The fixture is two free content panes beside a pinned Layout rail, because
 * the rail re-solve is the half of the gesture only this door runs. Every
 * preset is read in turn, and the band is read from the live
 * `--tug-imposer-inset-*` values rather than typed here, so a deck whose band
 * is narrower than `wide` still asks the honest question.
 *
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  CONTENT_WIDTH_WIDE_PX,
  IMPOSITION_GAP_PX,
} from "../../tugdeck/src/lib/layout-imposer";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Slim and comfy, as `lib/layout-imposer.ts` fixes them. */
const PRESETS = [
  { preset: "slim", px: 675 },
  { preset: "comfy", px: 800 },
  { preset: "wide", px: CONTENT_WIDTH_WIDE_PX },
] as const;

/** A seeded width no preset resolves to, so a pane that was not reached shows. */
const SEEDED_WIDTH = 511;
const RAIL_WIDTH = 412;

/** The settle window, with room for the tween — the wait after seeding and
 *  after a bullseye, where nothing is read. */
const AFTER_LAND_MS = 900;

/** Room past the settle mark clearing for the tween's own tail. */
const SETTLE_TAIL_MS = 200;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * The width is read once the settle it set off has LANDED, not after a fixed
 * time. Ending a bullseye and re-widthing in one commit is a longer
 * choreography than either alone — the receded pane comes back and changes
 * width on its way — and at 900ms it was still mid-tween (674.5px of 675, with
 * `data-imposer-settling` on the canvas). A pane read inside its settle is a
 * reading of the tween, and a test of where the pane LANDS has to wait for it.
 */
async function landed(app: App): Promise<void> {
  await wait(50);
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 8_000 },
  );
  await wait(SETTLE_TAIL_MS);
}

function deckShape(imposed = false): Record<string, unknown> {
  const pane = (id: string, x: number, cardId: string, slot: number) => ({
    id,
    position: { x, y: 40 },
    size: { width: SEEDED_WIDTH, height: 620 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    ...(imposed ? { slot } : {}),
  });
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Card A", closable: true },
      { id: "B", componentId: "gallery-accordion", title: "Card B", closable: true },
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      pane("p1", 40, "A", 0),
      pane("p2", 60, "B", 2),
      {
        id: "pRail",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Layout",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: imposed
      ? { kind: "three-up", sidebars: { layout: { side: "right" } } }
      : { sidebars: { layout: { side: "right" } } },
    hasFocus: true,
  };
}

/** The band's width in px: the canvas less the live rail insets and the gap at each end. */
async function bandWidth(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var host = document.querySelector("[data-deck-canvas-background]");
      if (host === null) throw new Error("frames container not found");
      function inset(side) {
        var probe = document.createElement("div");
        probe.style.position = "absolute";
        probe.style.top = "0px";
        probe.style.left = "0px";
        probe.style.height = "1px";
        probe.style.visibility = "hidden";
        probe.style.pointerEvents = "none";
        probe.style.width = "var(--tug-imposer-inset-" + side + ", 0px)";
        host.appendChild(probe);
        var w = probe.getBoundingClientRect().width;
        probe.remove();
        return w;
      }
      var r = host.getBoundingClientRect();
      return r.width - inset("left") - inset("right") - ${IMPOSITION_GAP_PX} * 2;
    })()`,
  );
}

interface Landing {
  screen: number;
  record: number;
}

async function landing(app: App, paneId: string): Promise<Landing> {
  return app.evalJS<Landing>(
    `(function () {
      var el = document.querySelector('.tug-pane[data-pane-id="${paneId}"]');
      var pane = window.__tug.getPaneRecord("${paneId}");
      return { screen: el.getBoundingClientRect().width, record: pane.size.width };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0681 — the deck's content width lands on its preset", () => {
  // Three decks, because the gesture meets three different starting points:
  // free panes, slotted panes under an imposition, and a pane standing in
  // bullseye — which `setContentWidth` must end and then put on the preset.
  const cases = [
    { name: "free", imposed: false, bullseye: false },
    { name: "three-up", imposed: true, bullseye: false },
    { name: "from bullseye", imposed: false, bullseye: true },
  ];
  for (const c of cases) {
    test(
      `${c.name}: every content pane takes min(preset, band) exactly, on screen and in the record`,
      async () => {
        const app = await launchTugApp({ testName: "at0681-content-width-lands-on-preset" });
        try {
          await app.seedDeckState({ state: deckShape(c.imposed), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id="p1"], .tug-pane[data-pane-id="p2"]').length === 2`,
            { timeoutMs: 15_000 },
          );
          await wait(AFTER_LAND_MS);

          for (const { preset, px } of PRESETS) {
            if (c.bullseye) {
              await app.evalJS<null>(
                `(window.__tug.dispatchControlAction("set-bullseye", { paneId: "p1" }), null)`,
              );
              await wait(AFTER_LAND_MS);
            }
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-content-width", { preset: ${JSON.stringify(preset)} }), null)`,
            );
            await landed(app);
            const band = await bandWidth(app);
            const want = Math.min(px, band);
            for (const paneId of ["p1", "p2"]) {
              const got = await landing(app, paneId);
              note(
                `at0681 ${c.name} ${preset} ${paneId}`,
                `screen ${got.screen} / record ${got.record} against preset ${px}, band ${band}`,
              );
              expect(
                got.record,
                `${c.name} ${preset}: ${paneId}'s record holds min(${px}, band ${band})`,
              ).toBe(want);
              expect(
                got.screen,
                `${c.name} ${preset}: ${paneId} is drawn at min(${px}, band ${band})`,
              ).toBe(want);
            }
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});
