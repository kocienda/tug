/**
 * skeleton-switch-fixture.ts — the deck and the readings the workspace
 * skeleton judges share: a switch from a home workspace onto Text cards
 * whose pages the harness can make slow, read through the host's layer rows
 * and, in the shell, a frame recorder over each arriving card's stand-in.
 *
 * Every judge runs with the made-ahead path as the product ships it: nothing
 * here holds it off. A judge that needs a cold switch switches as soon as
 * the home workspace has painted, which is before the lane is idle and so
 * before any parked page could be made ahead.
 *
 * A page made slow (`bodyDelays.contentPaintDelayMs`) waits, its content
 * quiet and its lid down, before it says it is ready and paints its content:
 * the shape of a card whose content takes that much longer to arrive. Its
 * chrome paints as any page's does.
 *
 * Not a test: no `describe` here.
 */

import { launchTugApp, type App } from "./_harness";
import type { BodyLayerRow, BodyLayersReading, SwitchHoldRecord } from "./_harness/client";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "./_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "./body-grounding/_bodies";
import { ACTIVE_SPACE, textDeck } from "./body-grounding/_row-44";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 60_000;

export const HOME_SPACE = "sk-home-space";
export const AWAY_SPACE = "sk-away-space";
export const HOME_CARD = "sk-home";

/**
 * The wave's delay, in display frames: a lid standing this long or less
 * never shows the glyph ([B02] of the skeletons brief).
 */
export const WAVE_DELAY_FRAMES = 2;

export interface SkeletonDeck {
  app: App;
  close(): Promise<void>;
}

/**
 * Launch on a home workspace of Text cards — one, {@link HOME_CARD}, unless
 * `opts.home` names them — with `away` Text cards on a second workspace
 * never shown.
 */
export async function launchSkeletonDeck(
  label: string,
  away: readonly string[],
  opts: { home?: readonly string[] } = {},
): Promise<SkeletonDeck> {
  const home = opts.home ?? [HOME_CARD];
  const tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath);
  const layout = {
    version: 5,
    activeSpaceId: HOME_SPACE,
    spaces: [
      { id: HOME_SPACE, name: "Home", deck: textDeck(home) },
      { id: AWAY_SPACE, name: "Away", deck: textDeck(away) },
    ],
  };
  tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(layout));
  const app = await launchTugApp({
    testName: label,
    env: { TUGBANK_PATH: tugbankPath },
    persistInTestMode: true,
    restoreInTestMode: true,
  });
  const close = async (): Promise<void> => {
    await app.close();
    rmTempTugbank(tugbankPath);
  };
  try {
    await settleFor(() => bodyOf(app, home[0]), (b) => b?.state === "ready" && b.painted && b.visible, 30_000);
  } catch (e) {
    await close();
    throw e;
  }
  return { app, close };
}

/** Make the named cards' pages slow by `ms` each, before any of them is made. */
export function slowPages(app: App, delays: Record<string, number>): Promise<null> {
  return app.bodyDelays({ contentPaintDelayMs: delays });
}

/** Make every workspace switch's shell frame late by `ms` (null puts it back). */
export function setSwitchFrameDelay(app: App, ms: number | null): Promise<null> {
  return app.switchFrameDelay(ms);
}

/** Make the named cards' pages, shown again, wait `ms` each before they say `painted`. */
export function slowConfirm(app: App, delays: Record<string, number>): Promise<null> {
  return app.bodyDelays({ shownPaintDelayMs: delays });
}

/** Hold the named cards' catch-ups open `ms` each past their end. */
export function slowCatchUp(app: App, delays: Record<string, number>): Promise<null> {
  return app.bodyDelays({ catchUpDelayMs: delays });
}

/** Choose a workspace's theme as its row's swatch would: a parked one's record moves and nothing repaints. */
export function chooseSpaceTheme(app: App, spaceId: string, theme: string): Promise<null> {
  return app.evalJS<null>(`(window.__tug.chooseSpaceTheme(${JSON.stringify(spaceId)}, ${JSON.stringify(theme)}), null)`);
}

/** Wait until each card in `ids` has a page made ahead — ready, painted and hidden; true when all have. */
export async function madeAhead(app: App, ids: readonly string[], timeoutMs = 10_000): Promise<boolean> {
  const all = await settleFor(
    () => Promise.all(ids.map((id) => bodyOf(app, id))),
    (bs) => bs.every((b) => b?.state === "ready" && b.painted === true && b.visible === false),
    timeoutMs,
  );
  return all.every((b) => b?.state === "ready" && b.painted === true && b.visible === false);
}

/** The switch hold that began at or after `cut`, ended or not, or null when none stood. */
export async function holdFrom(app: App, cut: number): Promise<SwitchHoldRecord | null> {
  const holds = (await app.handOvers()).switchHolds ?? [];
  return holds.filter((h) => h.fromWall >= cut - 50).at(-1) ?? null;
}

/**
 * A row that shows a departing card's page: its card is one of `departing`,
 * no held picture stands over it, and its container is on screen.
 */
export const showsDeparted = (r: BodyLayerRow, departing: ReadonlySet<string>): boolean =>
  departing.has(r.cardId) && r.held !== true && !r.hidden && r.opacity > 0;

/** A row whose card stands under its own last frame, a park cover. */
export const showsLastFrame = (r: BodyLayerRow): boolean => r.lastFrame === true && r.held !== true && !r.hidden;

/** Switch to `spaceId`, answering the wall clock at the dispatch. */
export async function switchTo(app: App, spaceId: string): Promise<number> {
  const cut = Date.now();
  await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} }), null)`);
  await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === spaceId, 5_000);
  return cut;
}

/** Arm the host's layer sampler for `windowMs`. */
export async function armLayers(app: App, windowMs: number): Promise<void> {
  await app.bodyLayers({ op: "arm", windowMs });
}

/** The host's layer rows once the window armed for `windowMs` has run. */
export async function readLayers(app: App, windowMs: number): Promise<BodyLayerRow[] | null> {
  const layers = (await settleFor(
    () => app.bodyLayers({ op: "read" }) as Promise<BodyLayersReading>,
    (r) => r.done,
    windowMs + 5_000,
  )) as BodyLayersReading;
  return layers.done ? layers.rows : null;
}

/** A row showing the card's own page: painted, no face over it, its container on screen. */
export const showsPage = (r: BodyLayerRow): boolean => r.painted && !r.faced && r.held !== true && !r.hidden && r.opacity > 0;

/** When each card first showed its own page from `cut` on, ms after `cut`, or null if it never did in the rows. */
export function firstPage(rows: readonly BodyLayerRow[], ids: readonly string[], cut: number): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const id of ids) {
    const row = rows.filter((r) => r.cardId === id && r.wall >= cut).sort((a, b) => a.wall - b.wall).find(showsPage);
    out[id] = row === undefined ? null : row.wall - cut;
  }
  return out;
}

/** The host's reveal-set log from `cut` on, each line's wall made ms after `cut`. */
export async function revealLog(app: App, cut: number): Promise<string[]> {
  const account = await app.handOvers();
  return (account.revealLog ?? [])
    .map((line) => line.split(" "))
    .filter(([wall]) => Number(wall) >= cut)
    .map(([wall, ...rest]) => `${Number(wall) - cut} ms ${rest.join(" ")}`);
}

/** One frame of the shell's stand-in recorder: its wall clock, the active workspace, and each card's stand-in. */
export interface StandInFrame {
  wall: number;
  space: string;
  /**
   * Per card: its stand-in is mounted; its wave has a box (it is rendered, so
   * its delay runs); its wave is visible; a host face was drawn from it, the
   * wave with it (`data-face-drawn`).
   */
  cards: Record<string, { standIn: boolean; boxed: boolean; wave: boolean; drawn: boolean }>;
}

/**
 * The wave is visible in `root`: a `TugProgressWave` with a box, displayed,
 * and not transparent anywhere up to `root`.
 */
const WAVE_VISIBLE_JS = `function (root) {
  if (root === null) return false;
  var wave = root.querySelector('[data-slot="tug-progress-wave"]');
  if (wave === null) return false;
  var r = wave.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  for (var el = wave; el !== null; el = el.parentElement) {
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    if (el === root) break;
  }
  return true;
}`;

/**
 * Arm a recorder in the shell: one row per animation frame for `windowMs`,
 * per card in `ids` whether its stand-in is mounted and whether it wears a
 * visible wave. Read with {@link readStandIns}.
 */
export async function armStandIns(app: App, ids: readonly string[], windowMs: number): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var ids = ${JSON.stringify(ids)};
      var visible = ${WAVE_VISIBLE_JS};
      var rows = [];
      window.__skStandIns = rows;
      var until = performance.now() + ${windowMs};
      function tick() {
        var cards = {};
        for (var i = 0; i < ids.length; i += 1) {
          var standIn = document.querySelector('[data-body-placeholder][data-card-id="' + ids[i] + '"] [data-body-stand-in]');
          var w = standIn === null ? null : standIn.querySelector('[data-slot="tug-progress-wave"]');
          var box = w === null ? null : w.getBoundingClientRect();
          cards[ids[i]] = {
            standIn: standIn !== null,
            boxed: box !== null && box.width > 0,
            wave: visible(standIn),
            drawn: w !== null && w.closest("[data-face-drawn]") !== null,
          };
        }
        rows.push({ wall: performance.timeOrigin + performance.now(), space: window.tugdeck.diag.getSpaces().activeSpaceId, cards: cards });
        if (performance.now() < until) requestAnimationFrame(tick);
        else window.__skStandInsDone = true;
      }
      window.__skStandInsDone = false;
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

/** The recorder's rows once its window has run, or null if it never finished. */
export async function readStandIns(app: App, windowMs: number): Promise<StandInFrame[] | null> {
  const done = await settleFor(() => app.evalJS<boolean>("window.__skStandInsDone === true"), (d) => d, windowMs + 5_000);
  return done ? app.evalJS<StandInFrame[]>("window.__skStandIns") : null;
}

/** Whether the body page's own lid wears a visible wave: its content box still lidded, and the glyph in it. */
export const bodyLidWave = (app: App, cardId: string): Promise<{ lidded: boolean; wave: boolean } | null> =>
  app
    .body(cardId)
    .evalJS<{ lidded: boolean; wave: boolean } | null>(
      `(function () {
        var visible = ${WAVE_VISIBLE_JS};
        var frame = document.querySelector(".body-chrome-frame");
        if (frame === null) return null;
        var content = frame.querySelector(".tug-pane-content");
        return { lidded: !frame.hasAttribute("data-content-painted"), wave: visible(content) };
      })()`,
      { timeoutMs: 1_000 },
    )
    .catch(() => null);
