/**
 * at0663-workspace-theme-switch.test.ts — a workspace switch changes the
 * theme in the same frame as the cut.
 *
 * Each workspace wears its own theme, and parked workspaces stay mounted, so
 * the cards a switch reveals are already built. A theme that lands any later
 * than the switch's own commit shows those cards in the theme of the
 * workspace being left for at least a frame. Reading the theme once the
 * switch has settled cannot see that: the end state is right either way. So
 * this samples the frames.
 *
 *   1. Two workspaces are seeded with different themes — a dark one active,
 *      a light one parked — and NO global theme key. The boot shows the
 *      active workspace's theme, which is the startup half of the claim: the
 *      global key is unset, so only the workspace's own record can have
 *      produced it.
 *   2. The parked workspace's stylesheet is loaded and held: fetched, in the
 *      document, applying to nothing.
 *   3. A `requestAnimationFrame` recorder is armed and `activate-space` is
 *      dispatched in the same task. The theme is read synchronously after
 *      the dispatch returns — it must already be the incoming one — and then
 *      on every recorded frame, the first included. A frame callback runs
 *      before that frame's style and paint, so what it reads is what the
 *      frame shows.
 *   4. The switch back is sampled the same way, so the flip is shown in both
 *      directions rather than only onto a sheet that was never shown before.
 *   5. A workspace created from the light one inherits its theme, and the
 *      screen does not change.
 *   6. Quit and relaunch: the app comes back in the active workspace's theme,
 *      the layout on disk carries each workspace's theme, and the global key
 *      mirrors the theme that was on screen.
 *
 * Runs against the production-built `dist/`, which is where the synchronous
 * flip exists; a dev build's theme follows a switch through HMR by design.
 *
 * @covers tugdeck/src/theme-links.ts
 * @covers tugdeck/src/theme-mirror.ts
 * @covers tugdeck/src/contexts/theme-provider.tsx
 * @covers tugdeck/src/spaces.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SPACE_DARK = "11111111-1111-4111-8111-111111111111";
const SPACE_LIGHT = "22222222-2222-4222-8222-222222222222";
const THEME_DARK = "caravel";
const THEME_LIGHT = "sloop";

/** How many frames each switch is watched for. */
const FRAMES_WATCHED = 12;

/**
 * A theme's canvas color, read from the theme's own stylesheet — the token
 * every theme must define and no two themes share, which is what makes it
 * the fingerprint of the theme on screen.
 */
function canvasColorOf(theme: string): string {
  const css = readFileSync(
    resolve(import.meta.dir, "..", "..", "tugdeck", "styles", "themes", `${theme}.css`),
    "utf8",
  );
  const match = css.match(/--tugx-host-canvas-color:\s*(#[0-9a-fA-F]{6})/);
  if (match === null) throw new Error(`no canvas color in ${theme}.css`);
  return match[1].toLowerCase();
}

function deckWith(cardId: string) {
  return {
    cards: [
      { id: cardId, componentId: "text", title: "File", closable: true },
      { id: `cards-${cardId}`, componentId: "cards", title: "Cards", closable: true },
    ],
    panes: [
      {
        id: `p-${cardId}`,
        position: { x: 40, y: 40 },
        size: { width: 720, height: 520 },
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["standard"],
      },
      {
        id: `p-cards-${cardId}`,
        position: { x: 900, y: 40 },
        size: { width: 320, height: 520 },
        cardIds: [`cards-${cardId}`],
        activeCardId: `cards-${cardId}`,
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: `p-${cardId}`,
    imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
  };
}

const TWO_THEMES_BLOB = {
  version: 5,
  activeSpaceId: SPACE_DARK,
  spaces: [
    { id: SPACE_DARK, name: "Dark", theme: THEME_DARK, deck: deckWith("A") },
    { id: SPACE_LIGHT, name: "Light", theme: THEME_LIGHT, deck: deckWith("B") },
  ],
};

/** What one reading of the theme on screen holds. */
interface ThemeReading {
  /** `--tugx-host-canvas-color` as applied CSS resolves it. */
  canvas: string;
  /** `<html data-theme-mode>`, which the token subscribers' notify stamps. */
  mode: string | null;
  activeSpaceId: string;
}

interface SwitchSample {
  /** Read in the dispatching task, after `activate-space` returned. */
  sameTask: ThemeReading;
  frames: ThemeReading[];
}

interface SpacesProbe {
  activeSpaceId: string;
  spaces: { id: string; name: string; theme?: string }[];
}

interface V5Blob {
  version: number;
  activeSpaceId: string;
  spaces: { id: string; name: string; theme?: string }[];
}

const READ_THEME = `(function () {
  return {
    canvas: getComputedStyle(document.body)
      .getPropertyValue("--tugx-host-canvas-color").trim().toLowerCase(),
    mode: document.documentElement.getAttribute("data-theme-mode"),
    activeSpaceId: window.tugdeck.diag.getSpaces().activeSpaceId,
  };
})()`;

/**
 * Arm a frame recorder, switch, and read the theme — all in one task, so no
 * frame can fall between the arming and the cut.
 */
function switchAndSample(spaceId: string): string {
  return `(function () {
    var read = function () { return ${READ_THEME}; };
    var sample = { sameTask: null, frames: [] };
    window.__at0663 = sample;
    var onFrame = function () {
      sample.frames.push(read());
      if (sample.frames.length < ${FRAMES_WATCHED}) requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
    window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} });
    sample.sameTask = read();
    return null;
  })()`;
}

type App = Awaited<ReturnType<typeof launchTugApp>>;

async function sampledSwitch(app: App, spaceId: string): Promise<SwitchSample> {
  await app.evalJS<null>(switchAndSample(spaceId));
  await app.waitForCondition<boolean>(
    `window.__at0663.frames.length >= ${FRAMES_WATCHED}`,
    { timeoutMs: 15_000 },
  );
  return app.evalJS<SwitchSample>(`window.__at0663`);
}

/** Every reading of a switch — same-task and each frame — shows `theme`. */
function expectWholeSwitchIn(
  sample: SwitchSample,
  spaceId: string,
  canvas: string,
  mode: string,
): void {
  expect(sample.sameTask).toEqual({ canvas, mode, activeSpaceId: spaceId });
  expect(sample.frames.length).toBe(FRAMES_WATCHED);
  // The first frame is named on its own: it is the claim.
  expect(sample.frames[0]).toEqual({ canvas, mode, activeSpaceId: spaceId });
  for (const frame of sample.frames) {
    expect(frame).toEqual({ canvas, mode, activeSpaceId: spaceId });
  }
}

async function waitForDeck(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `typeof window.tugdeck !== "undefined" && typeof window.tugdeck.diag.getSpaces === "function" && window.tugdeck.diag.getSpaces().spaces.length >= 2`,
    { timeoutMs: 10_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0663 — a workspace switch changes the theme with the cut", () => {
  test(
    "the first frame after a switch is already in the incoming workspace's theme, and the theme survives a relaunch",
    async () => {
      const darkCanvas = canvasColorOf(THEME_DARK);
      const lightCanvas = canvasColorOf(THEME_LIGHT);
      expect(darkCanvas).not.toBe(lightCanvas);

      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(TWO_THEMES_BLOB),
        );

        // ---- Launch one: boot, switch both ways, create, quit.
        {
          const app = await launchTugApp({
            testName: "at0663-workspace-theme-switch-A",
            env: { TUGBANK_PATH: tugbankPath },
            skipAccessibilityPreflight: true,
            persistInTestMode: true,
            restoreInTestMode: true,
          });
          try {
            await waitForDeck(app);

            // (1) The boot shows the active workspace's theme, with no global
            // key to have supplied it.
            expect(await app.evalJS<ThemeReading>(READ_THEME)).toEqual({
              canvas: darkCanvas,
              mode: "dark",
              activeSpaceId: SPACE_DARK,
            });

            // (2) The parked workspace's sheet is loaded and applies to nothing.
            await app.waitForCondition<boolean>(
              `(function () {
                var link = document.querySelector('link[data-tug-theme="${THEME_LIGHT}"]');
                return link !== null && link.sheet !== null && link.sheet.disabled === true;
              })()`,
              { timeoutMs: 10_000 },
            );

            // (3) Dark to light.
            const toLight = await sampledSwitch(app, SPACE_LIGHT);
            expectWholeSwitchIn(toLight, SPACE_LIGHT, lightCanvas, "light");

            // (4) And back.
            const toDark = await sampledSwitch(app, SPACE_DARK);
            expectWholeSwitchIn(toDark, SPACE_DARK, darkCanvas, "dark");

            const links = await app.evalJS<string[]>(
              `(function () {
                return Array.prototype.map.call(
                  document.querySelectorAll("link[data-tug-theme]"),
                  function (l) { return l.getAttribute("data-tug-theme") + ":" + (l.sheet === null ? "unloaded" : l.sheet.disabled ? "held" : "shown"); }
                );
              })()`,
            );
            note(`at0663 theme links after the round trip: ${JSON.stringify(links)}`);

            // (5) A workspace made from the light one wears its theme, and
            // making it changes nothing on screen.
            await sampledSwitch(app, SPACE_LIGHT);
            const createdId = await app.evalJS<string>(
              `window.tugdeck.lab.createSpace("Made here")`,
            );
            const afterCreate = await app.evalJS<SpacesProbe>(
              `window.tugdeck.diag.getSpaces()`,
            );
            expect(afterCreate.activeSpaceId).toBe(createdId);
            expect(
              afterCreate.spaces.find((s) => s.id === createdId)?.theme,
            ).toBe(THEME_LIGHT);
            expect(await app.evalJS<ThemeReading>(READ_THEME)).toEqual({
              canvas: lightCanvas,
              mode: "light",
              activeSpaceId: createdId,
            });

            // Leave by way of the dark workspace and quit in the light one,
            // so the relaunch restores a theme that is neither the seeded
            // active workspace's nor the base theme.
            const lastSwitch = await sampledSwitch(app, SPACE_DARK);
            expectWholeSwitchIn(lastSwitch, SPACE_DARK, darkCanvas, "dark");
            const quitIn = await sampledSwitch(app, SPACE_LIGHT);
            expectWholeSwitchIn(quitIn, SPACE_LIGHT, lightCanvas, "light");

            await app.evalJS<null>(`(window.tugdeck.saveState(), null)`);
            await app.quitGracefully();
          } catch (e) {
            await app.close().catch(() => undefined);
            throw e;
          }
        }

        // ---- On disk: each workspace's theme, and the mirror.
        const onDisk = tugbankRead<V5Blob>(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
        );
        expect(onDisk).not.toBeNull();
        const blob = onDisk!.value;
        expect(blob.activeSpaceId).toBe(SPACE_LIGHT);
        expect(blob.spaces.map((s) => [s.name, s.theme])).toEqual([
          ["Dark", THEME_DARK],
          ["Light", THEME_LIGHT],
          ["Made here", THEME_LIGHT],
        ]);
        const mirrored = tugbankRead<string>(tugbankPath, "dev.tugapp.app", "theme");
        expect(mirrored?.value).toBe(THEME_LIGHT);

        // ---- Launch two: the active workspace's theme survives.
        {
          const app = await launchTugApp({
            testName: "at0663-workspace-theme-switch-B",
            env: { TUGBANK_PATH: tugbankPath },
            skipAccessibilityPreflight: true,
            persistInTestMode: true,
            restoreInTestMode: true,
          });
          try {
            await waitForDeck(app);
            expect(await app.evalJS<ThemeReading>(READ_THEME)).toEqual({
              canvas: lightCanvas,
              mode: "light",
              activeSpaceId: SPACE_LIGHT,
            });
            // And the switch is still synchronous on a fresh boot, where the
            // dark sheet has only ever been loaded ahead of use.
            await app.waitForCondition<boolean>(
              `(function () {
                var link = document.querySelector('link[data-tug-theme="${THEME_DARK}"]');
                return link !== null && link.sheet !== null;
              })()`,
              { timeoutMs: 10_000 },
            );
            const toDark = await sampledSwitch(app, SPACE_DARK);
            expectWholeSwitchIn(toDark, SPACE_DARK, darkCanvas, "dark");
            await app.quitGracefully();
          } catch (e) {
            await app.close().catch(() => undefined);
            throw e;
          }
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
