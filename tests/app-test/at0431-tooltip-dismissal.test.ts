/**
 * at0431-tooltip-dismissal.test.ts — a tooltip is an answer to a question the
 * user stops asking the moment they act.
 *
 * A bubble stands while the pointer rests on something and the user is still
 * wondering what it is. Press, right-click, or scroll and the wondering is
 * over: the press has an outcome to watch, the right-click raises a menu about
 * the very same target, the scroll moves the target out from under the pointer.
 * A bubble that outlives any of those is stale ink sitting on top of the thing
 * the user actually wanted to see.
 *
 * The right-click case is the sharp one, and the reason this file exists: a
 * context menu and a tooltip on screen together are two floating surfaces
 * describing the same target, one of them no longer true. That pairing must be
 * impossible, not merely brief — so the assertion here is made at the moment
 * the menu is standing, and it reads BOTH facts in one breath: the menu is up,
 * and the trigger no longer claims a bubble.
 *
 * Dismissal alone does not carry that. It ends the bubble that was standing
 * when the press landed and says nothing about the NEXT hover, so a pointer
 * wandering across the rows behind an open menu would raise a fresh bubble a
 * half second later. The menu therefore suppresses as well as dismisses, and
 * the test proves both directions: nothing opens while the menu is up, and the
 * hover works again the moment it is gone — the suppression is tied to the
 * menu's life, not a latch left behind it.
 *
 * Why the trigger's `aria-describedby` rather than the bubble's presence: a
 * closing Radix tooltip stays mounted for its exit animation, and a background
 * app-test window runs no rAF ([L13] / the harness's animation rule), so
 * waiting for the node to leave the DOM could wait forever. The attribute is
 * the trigger's own statement that a bubble is standing, and it clears with
 * the state change rather than with the animation.
 *
 * The three gestures are driven as the real thing, not as a simulation of one:
 * a trusted native click and a trusted native right-click through the harness,
 * and a scroll produced by actually scrolling the editor's scroller — which is
 * what emits the `scroll` event the dismissal listens for.
 *
 * @covers tugdeck/src/lib/tooltip-dismiss.ts
 * @covers tugdeck/src/lib/open-menu-registry.ts
 * @covers tugdeck/src/components/tugways/use-open-menu-claim.ts
 * @covers tugdeck/src/components/tugways/tug-tooltip.tsx
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The settle window (`IMPOSITION_SETTLE_MS`), with room for the tween. */
const AFTER_LAND_MS = 900;

const PANE = '[data-pane-id="p1"]';
const BULLSEYE = `${PANE} [data-testid="tug-pane-title-bar-bullseye-button"]`;
const EDITOR = '[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-content';
const SCROLLER = '[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-scroller';
const MENU_ITEM = ".tug-menu-item";

/**
 * The gesture target inside the editor. `.cm-content` itself is as tall as the
 * whole document, so its center point is far below the viewport and a native
 * gesture aimed at it is out of bounds — the first line is the part of the
 * editor that is actually on screen.
 */
const EDITOR_LINE = `${EDITOR} .cm-line`;

const wait = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

/** A file long enough that its editor has somewhere to scroll to. */
function mkFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0431-"));
  const file = path.join(dir, "sample.txt");
  const lines = Array.from({ length: 400 }, (_, i) => `fixture line ${i + 1}`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

/** One pane holding a Text card: a title bar to hover, an editor to act in. */
function deckShape() {
  return {
    cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 620, height: 460 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
        slot: 0,
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** The element the bullseye's tooltip hangs from — the span, where there is one. */
const ANCHOR = `(function () {
  var el = document.querySelector(${JSON.stringify(BULLSEYE)});
  if (el === null) throw new Error("no bullseye button");
  return el.closest(".tug-pane-title-bar-tooltip-anchor") || el;
})()`;

/** Whether the trigger currently claims a standing bubble. */
const HAS_BUBBLE = `${ANCHOR}.getAttribute("aria-describedby") !== null`;

/**
 * Put the pointer on the bullseye and wait for its bubble to stand.
 *
 * `pointerenter` plus `pointermove` is the pair Radix opens on, and the leave
 * that precedes it is dispatched as a `pointerout` with a relatedTarget
 * outside the element — the event React derives `onPointerLeave` from. Without
 * clearing the latch first, a second hover of the same control is dropped.
 */
async function hover(app: App): Promise<void> {
  await pointAt(app);
  await app.waitForCondition<boolean>(HAS_BUBBLE, { timeoutMs: 8000 });
}

/** The gesture half of {@link hover}, with nothing awaited afterwards. */
async function pointAt(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var anchor = ${ANCHOR};
      anchor.dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      );
      return null;
    })()`,
  );
  await app.waitForCondition<boolean>(`!(${HAS_BUBBLE})`, { timeoutMs: 8000 });
  await app.evalJS<null>(
    `(function () {
      var anchor = ${ANCHOR};
      anchor.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
      anchor.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
      return null;
    })()`,
  );
}

/**
 * Hover, then wait out the whole open delay and report whether a bubble came.
 *
 * The provider's `delayDuration` is 900ms; the wait is well past it, because
 * the interesting answer here is a NEGATIVE one and a short wait would prove
 * only that the bubble had not arrived yet.
 */
async function hoverAndSee(app: App): Promise<boolean> {
  await pointAt(app);
  await wait(1500);
  return app.evalJS<boolean>(HAS_BUBBLE);
}

/** Seed the deck, wait for the pane, and settle. */
async function seed(app: App): Promise<void> {
  await app.seedDeckState({
    state: deckShape(),
    cardStates: {
      A: { content: { path: mkFixture(), anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
    },
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
    { timeoutMs: 8000 },
  );
  await wait(AFTER_LAND_MS);
}

describe.skipIf(!SHOULD_RUN)("at0431 — acting dismisses the hover bubble", () => {
  test(
    "a right-click raises its menu with no bubble left beside it",
    async () => {
      const app = await launchTugApp({ testName: "at0431-tooltip-dismissal-menu" });
      try {
        await seed(app);
        await hover(app);
        expect(await app.evalJS<boolean>(HAS_BUBBLE), "the hover stands to begin with").toBe(
          true,
        );

        await app.nativeRightClickAtElement(EDITOR_LINE);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(MENU_ITEM)}).length > 0`,
          { timeoutMs: 8000 },
        );

        // The two facts read together, while the menu is standing. Read apart
        // they would prove only that each happened, not that they never
        // overlapped.
        const both = await app.evalJS<{ menu: number; bubble: boolean }>(
          `(function () {
            return {
              menu: document.querySelectorAll(${JSON.stringify(MENU_ITEM)}).length,
              bubble: ${HAS_BUBBLE},
            };
          })()`,
        );
        expect(both.menu > 0, "the context menu is up").toBe(true);
        expect(both.bubble, "and nothing is left claiming a tooltip beside it").toBe(false);

        // The other half of the rule, and the one a dismissal alone does not
        // give: with the menu STILL standing, a fresh hover raises nothing.
        // Without this, a pointer wandering across the rows behind an open
        // menu floats a second surface over the one being read.
        expect(
          await hoverAndSee(app),
          "no bubble opens while the menu is up, however long the hover rests",
        ).toBe(false);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(MENU_ITEM)}).length`,
          ),
          "and the menu is still the thing on screen",
        ).toBeGreaterThan(0);

        // Dismiss it, and the hover works again — the suppression is tied to
        // the menu's life, not a latch left standing behind it.
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(MENU_ITEM)}).length === 0`,
          { timeoutMs: 8000 },
        );
        expect(await hoverAndSee(app), "with the menu gone, the tooltip returns").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a plain click dismisses it, and so does a scroll",
    async () => {
      const app = await launchTugApp({ testName: "at0431-tooltip-dismissal-click-scroll" });
      try {
        await seed(app);

        // --- Click. The press lands in the editor, nowhere near the bubble;
        // the rule is about the act, not about where it lands.
        await hover(app);
        await app.nativeClickAtElement(EDITOR_LINE);
        await app.waitForCondition<boolean>(`!(${HAS_BUBBLE})`, { timeoutMs: 8000 });

        // --- Scroll. Driven by scrolling the scroller for real, which is what
        // emits the `scroll` event; nothing here synthesizes one.
        await hover(app);
        const scrolled = await app.evalJS<boolean>(
          `(function () {
            var s = document.querySelector(${JSON.stringify(SCROLLER)});
            if (s === null) return false;
            s.scrollTop = 240;
            return s.scrollTop > 0;
          })()`,
        );
        expect(scrolled, "the editor had room to scroll").toBe(true);
        await app.waitForCondition<boolean>(`!(${HAS_BUBBLE})`, { timeoutMs: 8000 });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
