/**
 * at0773-help-ref-affordance.test.ts — a help ref in an Overview post looks
 * like the reference it is, and one click opens one help card.
 *
 * A help ref used to be a plain span with its own click: it had no annotation
 * contract, so it took no resting rule and no hover, and it read as text beside
 * refs that read as links. Stamped as a `help` annotation it takes both from the
 * annotation sheet and its click from the row's delegated layer.
 *
 * The hover here is read through a held press, not a dispatched pointer event:
 * the colour move is the `:hover` pseudo-class, which WebKit decides by its own
 * hit-test of a trusted mouse event and which no dispatched event can reach.
 * Releasing that same press is the click.
 *
 * Claims:
 *
 *  1. The chip's label computes the resting underline.
 *  2. The chip's ink moves while the pointer is on it.
 *  3. A trusted click makes a help card the shell's active card, on the ref's
 *     document, and opens exactly one. The contract and a click of the chip's
 *     own would open it twice, which is what the count is for.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/lib/annotator/types.ts
 * @covers tugdeck/src/lib/annotator/payloads.ts
 * @covers tugdeck/src/lib/annotator/registry.ts
 * @covers tugdeck/src/lib/annotator/annotation-element.ts
 * @covers tugdeck/src/components/tugways/use-annotation-menu.tsx
 * @covers tugdeck/styles/tug-annotation.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { kindBody } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const CARD = '[data-testid="overview-card"]';
const CHIP = `${CARD} [data-overview-ref-kind="help"]`;
const LABEL = `${CHIP} .tug-atom-ref-label`;
const SKIN = `${CHIP} .tug-atom-ref`;

const READ_INK = `getComputedStyle(document.querySelector(${JSON.stringify(SKIN)})).color`;

const READ_CENTER = `(function(){
  var rect = document.querySelector(${JSON.stringify(CHIP)}).getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`;

/** What the shell says about help cards: how many, and which card is active. */
const READ_DECK = `(function(){
  var deck = window.tugdeck.diag.getDeckState();
  var pane = deck.panes.find(function (p) { return p.id === deck.activePaneId; });
  var active = pane === undefined
    ? undefined
    : deck.cards.find(function (c) { return c.id === pane.activeCardId; });
  return {
    helpCards: deck.cards.filter(function (c) { return c.componentId === "help"; }).length,
    activeKind: active === undefined ? "" : active.componentId,
  };
})()`;

describe.skipIf(!SHOULD_RUN)("at0773 — a help ref is a reference", () => {
  test(
    "it rests underlined, lights under the pointer, and opens one help card",
    async () => {
      const app = await launchTugApp({ testName: "at0773-help-ref-affordance" });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        const overview = kindBody(app, "overview");
        await overview.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) !== null`,
          { timeoutMs: 10_000 },
        );

        const post = {
          id: 9773,
          at_ms: 1_754_600_000_000,
          author: "observer",
          body: "Arcs are opened from the door.",
          refs: [{ kind: "help", target: "recipes#create-an-arc" }],
        };
        expect(
          await overview.evalJS<boolean>(
            `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
          ),
        ).toBe(true);
        await overview.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LABEL)}) !== null`,
          { timeoutMs: 10_000 },
        );

        const underline = await overview.evalJS<string>(
          `getComputedStyle(document.querySelector(${JSON.stringify(LABEL)})).textDecorationLine`,
        );
        const restInk = await overview.evalJS<string>(READ_INK);
        note(`at0773 rest: ${underline}, ${restInk}`);
        expect(underline, "the label takes the resting rule").toContain("underline");

        const center = await overview.evalJS<{ x: number; y: number }>(READ_CENTER);
        await overview.nativeDragElementWithoutRelease(CHIP, { selector: CHIP });
        const hoverInk = await overview.evalJS<string>(READ_INK);
        note(`at0773 under the pointer: ${hoverInk}`);
        expect(hoverInk, "the ink moves while the pointer is on the chip").not.toBe(restInk);

        await overview.nativeMouseUp(center);
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getDeckState().cards.some(function (c) { return c.componentId === "help"; })`,
          { timeoutMs: 10_000 },
        );
        await kindBody(app, "help").waitForCondition<boolean>(
          `document.querySelector('[data-slot="help-card"][data-help-doc="recipes"]') !== null`,
          { timeoutMs: 10_000 },
        );
        const deck = await app.evalJS<{ helpCards: number; activeKind: string }>(READ_DECK);
        note(`at0773 deck: ${JSON.stringify(deck)}`);
        expect(deck.helpCards, "one click opens one card").toBe(1);
        expect(deck.activeKind, "the help card is the active one").toBe("help");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
