/**
 * at0781-look-up-from-background.test.ts — Look Up in Dictionary reaches the
 * host from a card's own page, in the foreground and from the background.
 *
 * Two faults, each silent:
 *
 *   - **A card's body page had no one to answer the verb.** The shell answers
 *     `look-up-in-dictionary` at the deck's root, which a body page does not
 *     have, and the verb is not a command, so the unanswered walk off the
 *     body's root forwarded nothing. Every lookup from text inside a card
 *     went nowhere; only surfaces the shell draws itself could look a word
 *     up. The body's root answers it now (`body/body-root.tsx`).
 *   - **The click that chose the item was swallowed in the background.** A
 *     secondary click does not activate a background app, so a right-click
 *     opens the menu with Tug still inactive, and the click on the item is
 *     the one that brings the app forward — which `ClickThroughWebView`
 *     swallows by design (at0295). It now delivers the activating click that
 *     follows a secondary click the view took while inactive.
 *
 * Two passes over the same word in a card's body, through the same menu, read
 * the host's own log line for each request that crossed the bridge:
 *
 *   1. Foreground: the item's lookup reaches the host.
 *   2. Background — right-click and choose the item with the app resigned
 *      between them and never re-activated by the harness: the item posts the
 *      lookup too, and the app comes forward.
 *
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugdeck/src/body/body-root.tsx
 * @covers tugdeck/src/components/tugways/tug-editor-context-menu.tsx
 * @covers tugdeck/src/lib/dictionary-lookup.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = "A";
const INPUT = 'input[readonly][value="Read-only with value"]';
const MENU = '[data-slot="tug-editor-context-menu"]';
const LOOK_UP = `${MENU} [data-item-action="look-up-in-dictionary"]`;

function oneCard() {
  return {
    cards: [{ id: CARD, componentId: "gallery-input", title: "Inputs", closable: true }],
    panes: [
      {
        id: "pA",
        position: { x: 40, y: 40 },
        size: { width: 700, height: 600 },
        cardIds: [CARD],
        activeCardId: CARD,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pA",
    hasFocus: true,
  };
}

/** Select "value" inside the read-only input, so the menu has a word to define. */
const SELECT_WORD = `(function () {
  var input = document.querySelector(${JSON.stringify(INPUT)});
  if (input === null) return false;
  var at = input.value.indexOf("value");
  input.scrollIntoView({ block: "center" });
  input.focus();
  input.setSelectionRange(at, at + 5);
  return true;
})()`;

/** A point over the selected word, in the body's viewport. */
const WORD_POINT = `(function () {
  var input = document.querySelector(${JSON.stringify(INPUT)});
  var r = input.getBoundingClientRect();
  return { x: Math.round(r.left + r.width * 0.8), y: Math.round(r.top + r.height / 2) };
})()`;

const settle = () => new Promise((r) => setTimeout(r, 350));

async function openMenuAndLookUp(app: App, background: boolean): Promise<string[]> {
  const body = app.body(CARD);
  expect(await body.evalJS<boolean>(SELECT_WORD)).toBe(true);
  const point = await body.evalJS<{ x: number; y: number }>(WORD_POINT);
  if (background) {
    await app.simulateAppResign();
    await settle();
    await app.waitForCondition<boolean>(`window.__tug.getHasFocus() === false`, { timeoutMs: 6000 });
  }
  await body.nativeClick(point, { button: "right", activateFirst: !background });
  await body.waitForCondition<boolean>(
    `(function () { var el = document.querySelector(${JSON.stringify(LOOK_UP)}); return el !== null && !el.hasAttribute("data-disabled"); })()`,
    { timeoutMs: 6000 },
  );
  await body.nativeClickAtElement(LOOK_UP, { activateFirst: !background });
  await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(MENU)}) === null`, { timeoutMs: 6000 });
  await settle();
  // The host's own line is the evidence: it says the request crossed the
  // bridge from this card's page, which nothing in the page can show.
  const posted = app.tugappLog().split("\n").filter((line) => line.includes("look up in dictionary"));
  note(`${background ? "background" : "foreground"}: posted ${JSON.stringify(posted)}`);
  return posted;
}

describe.skipIf(!SHOULD_RUN)("at0781 — Look Up from a card's page, foreground and background", () => {
  test(
    "a card's Look Up reaches the host, and a background right-click's item acts on the click that chooses it",
    async () => {
      const app = await launchTugApp({ testName: "at0781-look-up-from-background" });
      try {
        await app.seedDeckState({ state: oneCard(), focusCardId: CARD });
        await app.body(CARD).waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(INPUT)}) !== null`,
          { timeoutMs: 10000 },
        );
        await settle();

        const foreground = await openMenuAndLookUp(app, false);
        expect(foreground.length, "the foreground control reaches the host once").toBe(1);
        expect(foreground[0]).toContain("chars=5");

        const background = await openMenuAndLookUp(app, true);
        expect(background.length, "the background right-click's item reaches the host too").toBe(2);
        expect(background[1]).toContain("chars=5");
        await app.waitForCondition<boolean>(`window.__tug.getHasFocus()`, { timeoutMs: 6000 });
      } catch (err) {
        const tail = app.tailLog(120);
        if (tail !== "") process.stderr.write(`\n[at0781] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
