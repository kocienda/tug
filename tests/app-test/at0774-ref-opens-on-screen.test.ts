/**
 * at0774-ref-opens-on-screen.test.ts — a card opened from an Overview ref lands
 * with its masthead on screen and its edges on its neighbour's lines.
 *
 * A Session card stands in a slot and the Overview on its rail. A post carries a
 * help ref naming a passage and a commit ref, and each is clicked natively.
 *
 * Two places can put a card off its lines, and both are read. The shell says
 * where the pane stands. The card's own page says whether that page's chrome is
 * still where the pane is, since a card's title bar is drawn in its own page and
 * the host places that view from the shell's rect: a page scrolled inside its
 * view moves the title bar and the bottom edge with no rect in the shell moving.
 *
 * That is the fault this guards. Under View › Zoom below 100 % the deck root's
 * layout box is the window ÷ f, so a `body` that is a scroll container holds the
 * difference as scroll range, and the help card's reveal of the passage spent it.
 *
 * Claims:
 *
 *  1. The opened pane's top is at or below the canvas's, and its bottom is the
 *     Session card's. One-up is the exception on the bottom alone: a card opened
 *     there cascades as a free pane by design, with no neighbour's line to stand
 *     on.
 *  2. Inside the opened card's page, the chrome frame stands at its inset from
 *     the view's top and bottom, and nothing above the card's own document
 *     scroller has scrolled.
 *  3. The help card still opens at the passage the ref names.
 *
 * @covers tugdeck/index.html
 * @covers tugdeck/src/globals.css
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/lib/open-help-in-card.ts
 * @covers tugdeck/src/lib/open-commit-in-card.ts
 * @covers tugdeck/src/components/tugways/cards/help-card.tsx
 * @covers tugdeck/src/components/tugways/cards/commit-card.tsx
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

import { launchTugApp, note, type App, type BodyApp } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { PIXEL_TOL } from "./_harness/tolerances";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const REPO_ROOT = resolve(import.meta.dir, "../..");
const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();

const SID = "a7c0d1ea-0000-4000-8000-000000000774";
const CARD = '[data-testid="overview-card"]';
const HELP_TARGET = "recipes#create-an-arc";
const HELP_ANCHOR = "create-an-arc";
const HELP_REF = `${CARD} [data-overview-ref-target="${HELP_TARGET}"]`;
const COMMIT_REF = `${CARD} .overview-post-refs [data-slot="tug-commit-atom"]`;

/** A Session card in the first of two slots, and the Overview on its rail. */
const BASE_DECK = {
  cards: [
    { id: "A", componentId: "session", title: "Session", closable: true },
    { id: "O", componentId: "overview", title: "Overview", closable: true },
  ],
  panes: [
    {
      id: "p1",
      position: { x: 40, y: 40 },
      size: { width: 820, height: 620 },
      cardIds: ["A"],
      activeCardId: "A",
      title: "",
      acceptsFamilies: ["maker"],
      slot: 0,
    },
    {
      id: "pRail",
      position: { x: 0, y: 0 },
      size: { width: 452, height: 900 },
      cardIds: ["O"],
      activeCardId: "O",
      title: "Overview",
      acceptsFamilies: [],
    },
  ],
  activePaneId: "p1",
  imposition: { kind: "two-up", layout: "fit", sidebars: { overview: { side: "left" } } },
  hasFocus: true,
};

/** One deck to open from. */
interface Variant {
  name: string;
  imposition?: Record<string, unknown>;
  /** The card opens as a free pane, with no neighbour's line to stand on. */
  freePane?: boolean;
  zoom?: number;
}

const VARIANTS: Variant[] = [
  { name: "two-up, fit" },
  {
    name: "one-up",
    imposition: { kind: "one-up", layout: "fit", sidebars: { overview: { side: "left" } } },
    freePane: true,
  },
  { name: "the deck zoomed", zoom: 0.8 },
];

interface ShellRects {
  canvasTop: number;
  top: number;
  bottom: number;
  sessionBottom: number;
}

/** The newest pane holding a card of `componentId`, against the Session card's. */
function readShell(componentId: string): string {
  return `(function(){
    var deck = window.tugdeck.diag.getDeckState();
    var cards = deck.cards.filter(function (c) { return c.componentId === ${JSON.stringify(componentId)}; });
    var cardId = cards[cards.length - 1].id;
    var pane = deck.panes.find(function (p) { return p.cardIds.indexOf(cardId) !== -1; });
    var frame = document.querySelector('.tug-pane[data-pane-id="' + pane.id + '"]').getBoundingClientRect();
    var session = document.querySelector('.tug-pane[data-pane-id="p1"]');
    return {
      canvasTop: session.parentElement.getBoundingClientRect().top,
      top: frame.top,
      bottom: frame.bottom,
      sessionBottom: session.getBoundingClientRect().bottom,
    };
  })()`;
}

interface PageFacts {
  frameTop: number;
  frameBottom: number;
  insetTop: number;
  insetBottom: number;
  viewHeight: number;
  scrolled: string[];
}

/**
 * The chrome frame against the view, and every element from the card's document
 * scroller's parent up to the root that has scrolled. The document scroller
 * itself is the one that may.
 */
const READ_PAGE = `(function(){
  var frame = document.querySelector(".body-chrome-frame");
  var rect = frame.getBoundingClientRect();
  var style = getComputedStyle(frame);
  var scrolled = [];
  var card = document.querySelector('[data-slot="help-card"], [data-slot="commit-card"]');
  for (var el = card.parentElement; el !== null; el = el.parentElement) {
    if (el.scrollTop !== 0) scrolled.push(el.tagName + "." + el.className + "=" + el.scrollTop);
  }
  return {
    frameTop: rect.top,
    frameBottom: rect.bottom,
    insetTop: parseFloat(style.top),
    insetBottom: parseFloat(style.bottom),
    viewHeight: window.innerHeight,
    scrolled: scrolled,
  };
})()`;

/** Whether the help card has moved its own scrollport to the passage. */
const AT_PASSAGE = `(function(){
  var root = document.querySelector('[data-slot="help-card"]');
  if (root === null) return false;
  var heading = Array.from(root.querySelectorAll("h1, h2, h3, h4")).find(function (h) {
    return (h.textContent || "").trim().toLowerCase().replace(/\\s+/g, "-") === ${JSON.stringify(HELP_ANCHOR)};
  });
  return heading !== undefined && root.scrollTop > 0;
})()`;

async function expectOnScreen(
  app: App,
  body: BodyApp,
  componentId: string,
  variant: Variant,
): Promise<void> {
  // The arrival's settle has to finish before a rect means where the card stands.
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 5_000 },
  );
  const shell = await app.evalJS<ShellRects>(readShell(componentId));
  const page = await body.evalJS<PageFacts>(READ_PAGE);
  note(`at0774 ${variant.name}, ${componentId} shell: ${JSON.stringify(shell)}`);
  note(`at0774 ${variant.name}, ${componentId} page: ${JSON.stringify(page)}`);

  expect(shell.top, `${componentId}: the pane's top is on the canvas`).toBeGreaterThanOrEqual(
    shell.canvasTop,
  );
  if (variant.freePane !== true) {
    expect(
      Math.abs(shell.bottom - shell.sessionBottom),
      `${componentId}: the pane's bottom is the Session card's`,
    ).toBeLessThanOrEqual(PIXEL_TOL);
  }
  expect(page.scrolled, `${componentId}: nothing above the document has scrolled`).toEqual([]);
  // A rect is viewport px and a computed inset is layout px.
  const zoom = variant.zoom ?? 1;
  expect(
    Math.abs(page.frameTop - page.insetTop * zoom),
    `${componentId}: the title bar stands at the top of its view`,
  ).toBeLessThanOrEqual(PIXEL_TOL);
  expect(
    Math.abs(page.viewHeight - page.insetBottom * zoom - page.frameBottom),
    `${componentId}: the card's bottom stands at the bottom of its view`,
  ).toBeLessThanOrEqual(PIXEL_TOL);
}

describe.skipIf(!SHOULD_RUN)("at0774 — a card opened from a ref lands on screen", () => {
  for (const variant of VARIANTS) {
    test(
      variant.name,
      async () => {
        const app = await launchTugApp({ testName: "at0774-ref-opens-on-screen" });
        try {
          if (variant.zoom !== undefined) await app.setPageZoom(variant.zoom);
          await app.seedDeckState({
            state: { ...BASE_DECK, imposition: variant.imposition ?? BASE_DECK.imposition },
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { tugSessionId: SID, projectDir: REPO_ROOT });

          const overview = kindBody(app, "overview");
          await overview.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CARD)}) !== null`,
            { timeoutMs: 10_000 },
          );
          const post = {
            id: 9774,
            at_ms: 1_754_600_000_000,
            author: "observer",
            body: "Arcs are opened from the door.",
            refs: [
              { kind: "help", target: HELP_TARGET },
              { kind: "commit", target: HEAD_SHA },
            ],
            project_dir: REPO_ROOT,
          };
          expect(
            await overview.evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
            ),
          ).toBe(true);
          await overview.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(HELP_REF)}) !== null && document.querySelector(${JSON.stringify(COMMIT_REF)}) !== null`,
            { timeoutMs: 10_000 },
          );

          await overview.nativeClickAtElement(HELP_REF);
          const help = kindBody(app, "help");
          await help.waitForCondition<boolean>(AT_PASSAGE, { timeoutMs: 10_000 });
          await expectOnScreen(app, help, "help", variant);

          await overview.nativeClickAtElement(COMMIT_REF);
          const commit = kindBody(app, "commit");
          await commit.waitForCondition<boolean>(
            `document.querySelector('[data-slot="commit-card"]') !== null`,
            { timeoutMs: 10_000 },
          );
          await expectOnScreen(app, commit, "commit", variant);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});
