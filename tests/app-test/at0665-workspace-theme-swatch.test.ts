/**
 * at0665-workspace-theme-swatch.test.ts — a workspace row shows its theme and
 * is the door to changing it.
 *
 * Each row in the Workspaces card carries a swatch drawn in the Key hue of
 * the theme that workspace wears, so the list can be read for it. A click
 * on the swatch opens the themes, dark then light under their headings, each
 * with its own Key-hue chip and the workspace's own marked. What a pick does
 * depends on which row it was made on:
 *
 *   1. Two workspaces are seeded in different themes. Each row's swatch is
 *      painted in its own theme's Key hue — the parked one's included,
 *      which is a color the document is not otherwise showing.
 *   2. The swatch on the PARKED row opens the menu: every shipped theme, the
 *      dark ones under a Dark heading ahead of the light ones under a Light
 *      heading, each item's chip in that theme's Key hue, the row's theme
 *      checked.
 *   3. A pick there changes that workspace's record and its swatch, and
 *      nothing else: the screen keeps the active workspace's theme and the
 *      active workspace's record is untouched.
 *   4. Switching to that workspace shows the theme that was picked for it.
 *   5. A pick on the ACTIVE row repaints the screen, moves that record alone,
 *      and puts the Theme menu's checkmark on it — the menu's own path.
 *
 * Both picks are made with the real pointer on the real menu.
 *
 * @covers tugdeck/src/components/cards/cards-space-header.tsx
 * @covers tugdeck/src/theme-catalog.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { THEME_CATALOG, themeCatalogEntry } from "../../tugdeck/src/theme-catalog";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SPACE_ONE = "space-one";
const SPACE_TWO = "space-two";
const THEME_ONE = "caravel";
const THEME_TWO = "sloop";
/** Picked for the parked workspace. */
const THEME_PARKED_PICK = "galleon";
/** Picked for the workspace on screen. */
const THEME_ACTIVE_PICK = "ketch";

type App = Awaited<ReturnType<typeof launchTugApp>>;

function canvasColorOf(theme: string): string {
  const css = readFileSync(
    resolve(import.meta.dir, "..", "..", "tugdeck", "styles", "themes", `${theme}.css`),
    "utf8",
  );
  const match = css.match(/--tugx-host-canvas-color:\s*(#[0-9a-fA-F]{6})/);
  if (match === null) throw new Error(`no canvas color in ${theme}.css`);
  return match[1].toLowerCase();
}

/**
 * A theme's Key hue as the page paints it: the catalog's color set on a probe
 * element and read back as a computed style, so the comparison is in the
 * engine's own serialization rather than a guess at it.
 */
async function paintedKey(app: App, theme: string): Promise<string> {
  return app.evalJS<string>(
    `(function () {
       var el = document.createElement("span");
       el.style.backgroundColor = ${JSON.stringify(themeCatalogEntry(theme).keyColor)};
       document.body.appendChild(el);
       var color = getComputedStyle(el).backgroundColor;
       el.remove();
       return color;
     })()`,
  );
}

/**
 * Two workspaces, each standing its own Workspaces card, so a switch never
 * takes the surface under test off screen.
 */
function blob() {
  const deck = (suffix: string) => ({
    cards: [
      { id: `C${suffix}`, componentId: "cards", title: "Workspaces", closable: true },
      { id: `T${suffix}`, componentId: "text", title: `T${suffix}`, closable: true },
    ],
    panes: [
      {
        id: `pc${suffix}`,
        position: { x: 0, y: 0 },
        size: { width: 420, height: 900 },
        cardIds: [`C${suffix}`],
        activeCardId: `C${suffix}`,
        title: "",
        acceptsFamilies: [] as string[],
      },
      {
        id: `pt${suffix}`,
        position: { x: 60, y: 60 },
        size: { width: 700, height: 500 },
        cardIds: [`T${suffix}`],
        activeCardId: `T${suffix}`,
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: `pt${suffix}`,
    imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
  });
  return {
    version: 5,
    activeSpaceId: SPACE_ONE,
    spaces: [
      { id: SPACE_ONE, name: "One", theme: THEME_ONE, deck: deck("1") },
      { id: SPACE_TWO, name: "Two", theme: THEME_TWO, deck: deck("2") },
    ],
  };
}

// Every visited workspace stays mounted, so the rows are scoped to the layer
// on screen; the menu is portaled outside every layer and is not.
const SHOWN = "[data-space-layer][data-space-shown] ";
const HEADER = `${SHOWN}[data-testid="cards-space-header"]`;
const headerFor = (id: string): string =>
  `${SHOWN}.cards-space-header[data-cards-space-id="${id}"]`;
const swatchButtonFor = (id: string): string =>
  `${headerFor(id)} [data-testid="cards-space-theme-button"]`;
const swatchFor = (id: string): string =>
  `${swatchButtonFor(id)} .cards-space-swatch`;
const MENU = '[data-testid="cards-space-theme-menu"]';

const SCREEN_CANVAS = `getComputedStyle(document.body).getPropertyValue("--tugx-host-canvas-color").trim().toLowerCase()`;

async function recordedThemes(app: App): Promise<(string | undefined)[]> {
  return app.evalJS<(string | undefined)[]>(
    `window.tugdeck.diag.getSpaces().spaces.map(function (s) { return s.theme; })`,
  );
}

/** The theme a row's swatch names, and the color it is actually painted. */
async function swatchOf(
  app: App,
  spaceId: string,
): Promise<{ theme: string | null; color: string }> {
  return app.evalJS<{ theme: string | null; color: string }>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(swatchFor(spaceId))});
       return {
         theme: el.getAttribute("data-cards-swatch-theme"),
         color: getComputedStyle(el).backgroundColor,
       };
     })()`,
  );
}

async function waitSwatchTheme(app: App, spaceId: string, theme: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(swatchFor(spaceId))});
       return el !== null && el.getAttribute("data-cards-swatch-theme") === ${JSON.stringify(theme)};
     })()`,
    { timeoutMs: 8_000 },
  );
}

/** Open a row's theme menu with the real pointer and wait for its items. */
async function openThemeMenu(app: App, spaceId: string): Promise<void> {
  await app.nativeClickAtElement(swatchButtonFor(spaceId));
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(`${MENU} .tug-menu-item`)}).length > 0`,
    { timeoutMs: 8_000 },
  );
}

async function waitMenuClosed(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(MENU)}) === null`,
    { timeoutMs: 8_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0665 — a workspace row's theme swatch", () => {
  test(
    "the swatch shows each workspace's theme; a parked pick waits for the switch, an active pick repaints",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(blob()),
        );
        const app = await launchTugApp({
          testName: "at0665-workspace-theme-swatch",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(HEADER)}).length === 2`,
            { timeoutMs: 20_000 },
          );
          await app.waitForCondition<boolean>(
            `${SCREEN_CANVAS} === ${JSON.stringify(canvasColorOf(THEME_ONE))}`,
            { timeoutMs: 10_000 },
          );

          // (1) Each row's swatch is its own theme's Key hue.
          const atRest = {
            one: await swatchOf(app, SPACE_ONE),
            two: await swatchOf(app, SPACE_TWO),
          };
          note("at0665 swatches at rest", JSON.stringify(atRest));
          expect(atRest.one).toEqual({
            theme: THEME_ONE,
            color: await paintedKey(app, THEME_ONE),
          });
          expect(atRest.two).toEqual({
            theme: THEME_TWO,
            color: await paintedKey(app, THEME_TWO),
          });

          // (2) The parked row's swatch opens the themes, dark then light
          // under their headings, each chip in its theme's Key hue, with that
          // workspace's own checked.
          await openThemeMenu(app, SPACE_TWO);
          const items = await app.evalJS<{ id: string; checked: string | null }[]>(
            `Array.prototype.map.call(
               document.querySelectorAll(${JSON.stringify(`${MENU} .tug-menu-item`)}),
               function (el) {
                 return {
                   id: el.getAttribute("data-item-id"),
                   checked: el.getAttribute("aria-checked"),
                 };
               },
             )`,
          );
          note("at0665 the theme menu", JSON.stringify(items));
          expect(items.map((item) => item.id)).toEqual([
            "ironclad",
            "caravel",
            "barque",
            "galleon",
            "collier",
            "sloop",
            "ketch",
            "skiff",
            "kayak",
            "pinnace",
          ]);
          expect(
            items.filter((item) => item.checked === "true").map((item) => item.id),
          ).toEqual([THEME_TWO]);
          const sequence = await app.evalJS<string[]>(
            `Array.prototype.map.call(
               document.querySelectorAll(${JSON.stringify(`${MENU} .tug-menu-label, ${MENU} .tug-menu-item`)}),
               function (el) {
                 return el.classList.contains("tug-menu-label")
                   ? "# " + el.textContent.trim()
                   : el.getAttribute("data-item-id");
               },
             )`,
          );
          note("at0665 the menu's headings and items", JSON.stringify(sequence));
          expect(sequence).toEqual([
            "# Dark",
            ...THEME_CATALOG.filter((e) => e.mode === "dark").map((e) => e.name),
            "# Light",
            ...THEME_CATALOG.filter((e) => e.mode === "light").map((e) => e.name),
          ]);
          const chips = await app.evalJS<Record<string, string>>(
            `(function () {
               var out = {};
               document.querySelectorAll(${JSON.stringify(`${MENU} .tug-menu-item`)}).forEach(function (el) {
                 var chip = el.querySelector(".cards-space-swatch");
                 out[el.getAttribute("data-item-id")] = getComputedStyle(chip).backgroundColor;
               });
               return out;
             })()`,
          );
          note("at0665 the menu's chips", JSON.stringify(chips));
          const expectedChips: Record<string, string> = {};
          for (const entry of THEME_CATALOG) {
            expectedChips[entry.name] = await paintedKey(app, entry.name);
          }
          expect(chips).toEqual(expectedChips);
          // Opening a menu on a parked row is not going there.
          expect(
            await app.evalJS<string>(`window.tugdeck.diag.getSpaces().activeSpaceId`),
          ).toBe(SPACE_ONE);

          // (3) A pick for the parked workspace: its record and its swatch,
          // and nothing on screen.
          await app.nativeClickAtElement(
            `${MENU} [data-item-id="${THEME_PARKED_PICK}"]`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().spaces[1].theme === ${JSON.stringify(THEME_PARKED_PICK)}`,
            { timeoutMs: 8_000 },
          );
          await waitMenuClosed(app);
          await waitSwatchTheme(app, SPACE_TWO, THEME_PARKED_PICK);
          expect(await swatchOf(app, SPACE_TWO)).toEqual({
            theme: THEME_PARKED_PICK,
            color: await paintedKey(app, THEME_PARKED_PICK),
          });
          expect(await recordedThemes(app)).toEqual([THEME_ONE, THEME_PARKED_PICK]);
          expect(await app.evalJS<string>(SCREEN_CANVAS)).toBe(
            canvasColorOf(THEME_ONE),
          );
          expect(
            await app.evalJS<string>(`window.tugdeck.diag.getSpaces().activeSpaceId`),
          ).toBe(SPACE_ONE);

          // (4) Going there shows the theme that was picked for it.
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_TWO)} }), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SPACE_TWO)}`,
            { timeoutMs: 8_000 },
          );
          await app.waitForCondition<boolean>(
            `${SCREEN_CANVAS} === ${JSON.stringify(canvasColorOf(THEME_PARKED_PICK))}`,
            { timeoutMs: 10_000 },
          );

          // (5) A pick for the workspace on screen is the Theme menu's path:
          // the screen, this record alone, and the menu-bar checkmark.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(swatchButtonFor(SPACE_TWO))}) !== null`,
            { timeoutMs: 10_000 },
          );
          await openThemeMenu(app, SPACE_TWO);
          await app.nativeClickAtElement(
            `${MENU} [data-item-id="${THEME_ACTIVE_PICK}"]`,
          );
          await app.waitForCondition<boolean>(
            `${SCREEN_CANVAS} === ${JSON.stringify(canvasColorOf(THEME_ACTIVE_PICK))}`,
            { timeoutMs: 10_000 },
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().spaces[1].theme === ${JSON.stringify(THEME_ACTIVE_PICK)}`,
            { timeoutMs: 8_000 },
          );
          await waitMenuClosed(app);
          expect(await recordedThemes(app)).toEqual([THEME_ONE, THEME_ACTIVE_PICK]);
          await waitSwatchTheme(app, SPACE_TWO, THEME_ACTIVE_PICK);
          expect(await swatchOf(app, SPACE_ONE)).toEqual({
            theme: THEME_ONE,
            color: await paintedKey(app, THEME_ONE),
          });
          const deadline = Date.now() + 8_000;
          let checked = await app.menuItemState(`view.theme.${THEME_ACTIVE_PICK}`);
          while (checked.state !== 1 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
            checked = await app.menuItemState(`view.theme.${THEME_ACTIVE_PICK}`);
          }
          expect(checked).toMatchObject({ found: true, state: 1 });

          await app.quitGracefully();
        } catch (e) {
          await app.close().catch(() => undefined);
          throw e;
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
