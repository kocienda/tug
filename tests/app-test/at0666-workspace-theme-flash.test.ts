/**
 * at0666-workspace-theme-flash.test.ts — a theme picked from a workspace
 * row's swatch changes every layer in the same frame, and so does one picked
 * from View ▸ Theme.
 *
 * A pick from the swatch's menu was reported to flash the content, most of
 * all going from a light theme to a dark one. A green end state cannot say
 * whether that happened — the flash is in the frames between — so this test
 * samples them. A `requestAnimationFrame` recorder is armed before each
 * change, and every frame it reads the background color of three layers:
 * the document root, a card, and a sidebar. A frame where those layers do
 * not all show the same theme — some still the old one, some the new one, or
 * any caught between the two — is a mixed frame, which is what a flash is.
 *
 *   1. A light workspace (Sloop) picks a dark theme it has never worn
 *      (Galleon) from its row's swatch, with the real pointer on the real
 *      menu — the first-use case, where the theme's stylesheet is fetched by
 *      the pick itself.
 *   2. It goes back to Sloop through the Theme menu's wire, then picks
 *      Galleon from the swatch again — the same change with the stylesheet
 *      already loaded. The theme lands while the menu's confirmation blink is
 *      still playing: a pick does not wait for the blink.
 *   3. For comparison, the same light-to-dark change through View ▸ Theme's
 *      own wire (`set-theme`, the control frame the native item sends), to a
 *      dark theme also never worn (Barque).
 *
 * No run may show a mixed frame. Every run's frames — how many, which one
 * flipped, and how long after the gesture — are written as notes, so the
 * measurement is on the report whether the test is green or red.
 *
 * What the recorder reads is the computed style each frame, which is the
 * document's own answer: it sees a layer that resolves a frame behind the
 * others, a background caught in a transition, or a flip that waits for a
 * fetch. It cannot see the compositor paint a correct style late, nor the
 * host window's own background — those are below the document.
 *
 * @covers tugdeck/src/components/cards/cards-space-header.tsx
 * @covers tugdeck/src/components/tugways/internal/tug-popup-menu.tsx
 * @covers tugdeck/src/contexts/theme-provider.tsx
 * @covers tugdeck/src/theme-links.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import { cardHost } from "./_harness/selectors";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 150_000;

const SPACE = "space-one";
const THEME_LIGHT = "sloop";
/** The dark theme the swatch picks. */
const THEME_ROW_PICK = "galleon";
/** The dark theme View ▸ Theme picks, also never worn before. */
const THEME_MENU_PICK = "barque";
const TEXT_CARD = "T1";

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

/** One workspace in a light theme: its Workspaces card in a sidebar, a text card in a pane. */
function blob() {
  return {
    version: 5,
    activeSpaceId: SPACE,
    spaces: [
      {
        id: SPACE,
        name: "One",
        theme: THEME_LIGHT,
        deck: {
          cards: [
            { id: "C1", componentId: "cards", title: "Workspaces", closable: true },
            { id: TEXT_CARD, componentId: "text", title: TEXT_CARD, closable: true },
          ],
          panes: [
            {
              id: "pc1",
              position: { x: 0, y: 0 },
              size: { width: 420, height: 900 },
              cardIds: ["C1"],
              activeCardId: "C1",
              title: "",
              acceptsFamilies: [] as string[],
            },
            {
              id: "pt1",
              position: { x: 60, y: 60 },
              size: { width: 700, height: 500 },
              cardIds: [TEXT_CARD],
              activeCardId: TEXT_CARD,
              title: "",
              acceptsFamilies: ["standard"],
            },
          ],
          activePaneId: "pt1",
          imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
          hasFocus: true,
        },
      },
    ],
  };
}

const SHOWN = "[data-space-layer][data-space-shown] ";
const SWATCH_BUTTON = `${SHOWN}.cards-space-header[data-cards-space-id="${SPACE}"] [data-testid="cards-space-theme-button"]`;
const MENU = '[data-testid="cards-space-theme-menu"]';
const SIDEBAR = `${SHOWN}.tug-pane[data-sidebar-pane]`;
const SCREEN_CANVAS = `getComputedStyle(document.body).getPropertyValue("--tugx-host-canvas-color").trim().toLowerCase()`;

interface Frame {
  t: number;
  root: string;
  card: string;
  sidebar: string;
  menuOpen: boolean;
}

interface Recording {
  frames: Frame[];
  /** `performance.now()` at the gesture: the pointerdown, or the dispatch. */
  gestureAt: number | null;
  /** Theme links in the document when the recorder was armed. */
  linksAtArm: string[];
  /** Whether every sampled layer stayed in the document throughout. */
  connected: boolean;
}

/**
 * Install the recorder. The sampled elements are resolved once, now, before
 * any menu covers them: for each layer, the first element walking up from it
 * whose background is opaque — the color a person sees there. The card is
 * walked from its host, the sidebar from the element under its center, and
 * the document root from body.
 */
function installRecorder(): string {
  return `(function () {
    function opaque(el) {
      while (el !== null) {
        var bg = getComputedStyle(el).backgroundColor;
        if (bg !== "transparent" && !/rgba\\(.*,\\s*0\\)$/.test(bg)) return el;
        el = el.parentElement;
      }
      return document.documentElement;
    }
    function find(selector) {
      var el = document.querySelector(selector);
      if (el === null) throw new Error("no element for " + selector);
      return el;
    }
    var sidebarRect = find(${JSON.stringify(SIDEBAR)}).getBoundingClientRect();
    var layers = {
      root: opaque(document.body),
      card: opaque(find(${JSON.stringify(cardHost(TEXT_CARD))})),
      sidebar: opaque(document.elementFromPoint(
        sidebarRect.left + sidebarRect.width / 2,
        sidebarRect.top + sidebarRect.height / 2,
      )),
    };
    var rec = null;
    function sample(t) {
      if (rec === null || rec.stopped) return;
      rec.frames.push({
        t: t,
        root: getComputedStyle(layers.root).backgroundColor,
        card: getComputedStyle(layers.card).backgroundColor,
        sidebar: getComputedStyle(layers.sidebar).backgroundColor,
        menuOpen: document.querySelector(${JSON.stringify(MENU)}) !== null,
      });
      if (!layers.root.isConnected || !layers.card.isConnected || !layers.sidebar.isConnected) {
        rec.connected = false;
      }
      requestAnimationFrame(sample);
    }
    document.addEventListener("pointerdown", function () {
      if (rec !== null && rec.gestureAt === null) rec.gestureAt = performance.now();
    }, true);
    window.__at0666 = {
      layers: {
        root: layers.root.tagName + "." + layers.root.className,
        card: layers.card.tagName + "." + layers.card.className,
        sidebar: layers.sidebar.tagName + "." + layers.sidebar.className,
      },
      arm: function () {
        rec = {
          frames: [],
          gestureAt: null,
          stopped: false,
          connected: true,
          linksAtArm: Array.prototype.map.call(
            document.querySelectorAll("link[data-tug-theme]"),
            function (l) { return l.getAttribute("data-tug-theme"); },
          ),
        };
        requestAnimationFrame(sample);
      },
      markGesture: function () { rec.gestureAt = performance.now(); },
      stop: function () {
        rec.stopped = true;
        return {
          frames: rec.frames,
          gestureAt: rec.gestureAt,
          linksAtArm: rec.linksAtArm,
          connected: rec.connected,
        };
      },
    };
    return window.__at0666.layers;
  })()`;
}

interface Reading {
  frames: number;
  /** Frames where the three layers were not all in the same theme. */
  mixed: { i: number; frame: Frame }[];
  /** The first frame wholly in the new theme. */
  flipIndex: number;
  /** Milliseconds from the gesture to that frame. */
  flipAfterMs: number | null;
  menuOpenAtFlip: boolean | null;
}

/**
 * Classify each frame against the first (all old theme) and the last (all
 * new theme). A layer that matches neither is between the two; a frame is
 * mixed unless every layer is old, or every layer is new.
 */
function read(rec: Recording): Reading {
  const { frames } = rec;
  const first = frames[0];
  const last = frames[frames.length - 1];
  const layers = ["root", "card", "sidebar"] as const;
  const mixed: { i: number; frame: Frame }[] = [];
  let flipIndex = -1;
  frames.forEach((frame, i) => {
    const states = layers.map((l) =>
      frame[l] === first[l] ? "old" : frame[l] === last[l] ? "new" : "between",
    );
    const allOld = states.every((s) => s === "old");
    const allNew = states.every((s) => s === "new");
    if (!allOld && !allNew) mixed.push({ i, frame });
    if (allNew && flipIndex === -1) flipIndex = i;
  });
  const flip = flipIndex === -1 ? null : frames[flipIndex];
  return {
    frames: frames.length,
    mixed,
    flipIndex,
    flipAfterMs:
      flip !== null && rec.gestureAt !== null ? Math.round(flip.t - rec.gestureAt) : null,
    menuOpenAtFlip: flip === null ? null : flip.menuOpen,
  };
}

async function waitCanvas(app: App, theme: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `${SCREEN_CANVAS} === ${JSON.stringify(canvasColorOf(theme))}`,
    { timeoutMs: 10_000 },
  );
}

async function waitMenuClosed(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(MENU)}) === null`,
    { timeoutMs: 8_000 },
  );
}

/** Let the recorder run on past the change so the tail is all new theme. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 400));
}

async function stop(app: App): Promise<Recording> {
  return app.evalJS<Recording>(`window.__at0666.stop()`);
}

/** Pick `theme` from the row's swatch with the real pointer, recording throughout. */
async function pickFromRow(app: App, theme: string): Promise<Recording> {
  await app.nativeClickAtElement(SWATCH_BUTTON);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(`${MENU} [data-item-id="${theme}"]`)}) !== null`,
    { timeoutMs: 8_000 },
  );
  await app.evalJS<null>(`(window.__at0666.arm(), null)`);
  await app.nativeClickAtElement(`${MENU} [data-item-id="${theme}"]`);
  await waitCanvas(app, theme);
  await waitMenuClosed(app);
  await settle();
  return stop(app);
}

/** Choose `theme` through View ▸ Theme's wire, recording throughout. */
async function pickFromThemeMenu(app: App, theme: string): Promise<Recording> {
  await app.evalJS<null>(
    `(window.__at0666.arm(), requestAnimationFrame(function () {
       window.__at0666.markGesture();
       window.tugdeck.lab.dispatch("set-theme", { theme: ${JSON.stringify(theme)} });
     }), null)`,
  );
  await waitCanvas(app, theme);
  await settle();
  return stop(app);
}

function report(label: string, rec: Recording, reading: Reading): void {
  note(
    `at0666 ${label}`,
    JSON.stringify({
      ...reading,
      mixed: reading.mixed.slice(0, 4),
      linksAtArm: rec.linksAtArm,
      connected: rec.connected,
      first: rec.frames[0],
      last: rec.frames[rec.frames.length - 1],
    }),
  );
}

describe.skipIf(!SHOULD_RUN)("at0666 — a theme change flips every layer in one frame", () => {
  test(
    "light to dark from the row's swatch, first use and loaded, and from View ▸ Theme",
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
          testName: "at0666-workspace-theme-flash",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SWATCH_BUTTON)}) !== null && document.querySelector(${JSON.stringify(SIDEBAR)}) !== null`,
            { timeoutMs: 20_000 },
          );
          await waitCanvas(app, THEME_LIGHT);
          const layers = await app.evalJS<Record<string, string>>(installRecorder());
          note("at0666 sampled layers", JSON.stringify(layers));

          // (1) First use: the swatch picks a dark theme never worn.
          const firstUse = await pickFromRow(app, THEME_ROW_PICK);
          const firstUseReading = read(firstUse);
          report("row pick, first use", firstUse, firstUseReading);

          // (2) Back to light, then the same pick with the sheet loaded.
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("set-theme", { theme: ${JSON.stringify(THEME_LIGHT)} }), null)`,
          );
          await waitCanvas(app, THEME_LIGHT);
          await settle();
          const loaded = await pickFromRow(app, THEME_ROW_PICK);
          const loadedReading = read(loaded);
          report("row pick, loaded", loaded, loadedReading);

          // (3) Back to light, then View ▸ Theme to a dark theme never worn.
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("set-theme", { theme: ${JSON.stringify(THEME_LIGHT)} }), null)`,
          );
          await waitCanvas(app, THEME_LIGHT);
          await settle();
          const native = await pickFromThemeMenu(app, THEME_MENU_PICK);
          const nativeReading = read(native);
          report("View ▸ Theme, first use", native, nativeReading);

          for (const [rec, reading] of [
            [firstUse, firstUseReading],
            [loaded, loadedReading],
            [native, nativeReading],
          ] as const) {
            expect(rec.connected).toBe(true);
            // The recording starts in the old theme and ends in the new one.
            expect(reading.flipIndex).toBeGreaterThan(0);
            expect(reading.mixed).toEqual([]);
          }
          // The pick does not wait out the blink: with the sheet loaded the
          // theme is on screen while the menu is still standing.
          expect(loadedReading.menuOpenAtFlip).toBe(true);

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
