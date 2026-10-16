/**
 * row-25-in-card-surfaces.test.ts — the surfaces a Session card raises
 * inside itself draw whole inside its body.
 *
 * A body's viewport is its card's content box, and the popup primitives
 * keep themselves inside their own viewport (Radix collision for the
 * popovers and tooltips, viewport clamping for the context menu and the
 * completion popup). So a surface sorted in-card stands inside the body
 * and is painted there; one designed to stand past the content box is
 * the shell's to draw instead.
 *
 * One body Session card. Three in-card kinds, each raised the app's own way
 * and read the same way: the completion popup by typing `/` in the
 * composer through the session tap, the composer's context menu by a
 * right-click at a window point (the host's hit test hands it to the body),
 * and the route indicator badge's report by a right-click on the badge. Each
 * must stand inside the body's viewport with a size, and a column of its
 * interior, read by composite colour, must change when it opens and come
 * back when it closes: it is painted where the body's DOM says it is.
 *
 * Every other kind that is a body raises its own in-card surfaces and is
 * read the same way: the Overview's row menu on a post, and its composer's
 * context menu.
 *
 * @foreground
 * @covers tugdeck/src/components/tugways/tug-editor-context-menu.tsx
 * @covers tugdeck/src/components/tugways/chrome/session-route-indicator-badge.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { decodePngFile } from "../_harness/png";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { bodyOf, focusBody, pollFor, PROMPT_INPUT, SETTLE_MS, spawnStub, waitForBody } from "./_bodies";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { cardKind, kindsUnderTest, sessionUnderTest } from "./_kinds";

const TEST_NAME = "body-grounding-row-25-in-card-surfaces";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const A = "r25-a";
const COMPLETION = '[data-slot="tug-completion-menu"]';
const CONTEXT_MENU = '[data-slot="tug-editor-context-menu"]';
const ROUTE_BADGE = '[data-slot="session-route-indicator-badge"]';
const ROUTE_REPORT = '[data-slot="session-route-indicator-badge-report"]';

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface SurfaceReading {
  box: Box;
  viewport: { width: number; height: number };
}

/** In the body: the surface's box when it stands and is shown, and the viewport. */
const readSurface = (selector: string): string => `(function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (el === null) return null;
  var cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return null;
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, viewport: { width: window.innerWidth, height: window.innerHeight } };
})()`;

/** How far past each end of the surface the column runs, and the margins its paint is judged by (points). */
const COLUMN_REACH_PT = 28;
const EDGE_PT = 12;
const OUTSIDE_PT = 24;

/** One composite column of `height` points at window point (`x`, `y`), as RGB triples per device row. */
async function column(app: App, x: number, y: number, height: number): Promise<{ rows: number[][]; scale: number }> {
  const crop = { x: Math.floor(x), y: Math.floor(y), width: 2, height: Math.max(4, Math.floor(height)) };
  await app.captureBurst({ op: "arm", durationMs: 100, intervalMs: 50, crop });
  const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, 3_000);
  const png = decodePngFile(reading.frames[reading.frames.length - 1].path);
  const out: number[][] = [];
  for (let row = 0; row < png.height; row++) {
    const i = row * png.width * 4;
    out.push([png.rgba[i], png.rgba[i + 1], png.rgba[i + 2]]);
  }
  return { rows: out, scale: reading.scale };
}

/** The rows (in points from the column's top) where two columns differ by more than `tolerance` in any channel. */
function differing(a: number[][], b: number[][], scale: number, tolerance = 8): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].some((v, ch) => Math.abs(v - b[i][ch]) > tolerance)) out.push(i / scale);
  }
  return out;
}

/**
 * Raise a surface with `open`, read it inside the body's viewport, read a
 * column of its interior by composite, close it with `close`, and read the
 * same column again.
 */
async function readInCard(app: App, label: string, selector: string, open: () => Promise<void>, close: () => Promise<void>, card = A): Promise<void> {
  const body = app.body(card);
  await open();
  const appeared = await pollFor(() => body.evalJS<SurfaceReading | null>(readSurface(selector)), (r) => r !== null, SETTLE_MS);
  expect(appeared, `${label}: the surface appears in the body`).not.toBeNull();
  // Read the box at rest: a surface that enters on a scale reads short
  // while its entrance runs.
  await Bun.sleep(300);
  const reading = await body.evalJS<SurfaceReading | null>(readSurface(selector));
  note(`${label}: ${JSON.stringify(reading)}`);
  expect(reading, `${label}: the surface stands and is shown in the body`).not.toBeNull();
  const { box, viewport } = reading!;
  expect(box.left, `${label}: inside the body's left edge`).toBeGreaterThanOrEqual(-1);
  expect(box.top, `${label}: inside the body's top edge`).toBeGreaterThanOrEqual(-1);
  expect(box.right, `${label}: inside the body's right edge`).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.bottom, `${label}: inside the body's bottom edge`).toBeLessThanOrEqual(viewport.height + 1);

  // A column a third of the way across the surface, through its whole
  // height and past both its ends: what it paints must begin and end where
  // its box does, and nothing well outside the box may change with it.
  const frame = (await bodyOf(app, card))!.frame;
  const x = frame.x + box.left + (box.right - box.left) / 3;
  const y = frame.y + box.top - COLUMN_REACH_PT;
  const h = box.bottom - box.top + 2 * COLUMN_REACH_PT;
  const shown = await column(app, x, y, h);
  await close();
  await pollFor(() => body.evalJS<SurfaceReading | null>(readSurface(selector)), (r) => r === null, SETTLE_MS);
  await Bun.sleep(250);
  const gone = await column(app, x, y, h);
  // In points from the box's top.
  const changed = differing(shown.rows, gone.rows, shown.scale).map((pt) => pt - COLUMN_REACH_PT);
  const height = box.bottom - box.top;
  const first = changed.length > 0 ? changed[0] : null;
  const last = changed.length > 0 ? changed[changed.length - 1] : null;
  const outside = changed.filter((pt) => pt < -OUTSIDE_PT || pt > height + OUTSIDE_PT);
  note(`${label}: ${changed.length} rows changed, from ${first?.toFixed(1)} to ${last?.toFixed(1)} pt against a box ${height.toFixed(1)} pt tall; ${outside.length} well outside it`);
  expect(first, `${label}: the composite's paint begins where the box does`).not.toBeNull();
  expect(Math.abs(first!), `${label}: the paint's top is the box's top`).toBeLessThanOrEqual(EDGE_PT);
  expect(Math.abs(last! - height), `${label}: the paint's bottom is the box's bottom`).toBeLessThanOrEqual(EDGE_PT);
  expect(outside, `${label}: nothing well outside the box changed with it`).toEqual([]);
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 25: in-card surfaces draw whole inside the body", () => {
  test.skipIf(!kindsUnderTest(25).some((k) => k.componentId === "overview"))(
    "overview: its row menu on a post and its composer's context menu stand inside its body and are painted there",
    async () => {
      const card = "r25-overview";
      const app = await launchTugApp({ testName: `${TEST_NAME}-overview`, foreground: true, bodies: true });
      try {
        const now = Date.now();
        app.seedLedger({
          overview_posts: Array.from({ length: 4 }, (_, i) => ({
            at_ms: now - (4 - i) * 60_000,
            author: "observer" as const,
            body: `Post ${i + 1}: a line of work narrated, long enough to wrap once in a rail.`,
            refs: [],
          })),
        });
        const kind = cardKind("overview");
        await app.seedDeckState({ state: kindDeck(kind, card, { sessions: ["r25-seed"] }), focusCardId: card });
        const body = await standUpKind(app, kind, card);
        await focusBody(app, card, { composer: false });
        const POST = ".overview-post-body";
        await pollFor(() => body.evalJS<boolean>(`document.querySelectorAll(${JSON.stringify(POST)}).length > 0`), (v) => v, SETTLE_MS);
        const rightClick = async (selector: string): Promise<void> => {
          const r = await body.evalJS<Box>(
            `(function () { var all = document.querySelectorAll(${JSON.stringify(selector)}); var r = all[all.length - 1].getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`,
          );
          const frame = (await bodyOf(app, card))!.frame;
          await app.nativeRightClick({ x: frame.x + (r.left + r.right) / 2, y: frame.y + (r.top + r.bottom) / 2 });
        };
        await readInCard(app, "the row menu on a post", CONTEXT_MENU, () => rightClick(POST), () => app.nativeKey("Escape"), card);
        await readInCard(app, "the composer's context menu", CONTEXT_MENU, () => rightClick(kind.field!), () => app.nativeKey("Escape"), card);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!sessionUnderTest(25))(
    "the completion popup, the composer's context menu and the route report stand inside the body and are painted there",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        bodies: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({
          state: {
            cards: [{ id: A, componentId: "session", title: "A", closable: true }],
            panes: [
              {
                id: `${A}-pane`,
                position: { x: 40, y: 40 },
                size: { width: 900, height: 720 },
                cardIds: [A],
                activeCardId: A,
                title: "",
                acceptsFamilies: ["maker"],
              },
            ],
            activePaneId: `${A}-pane`,
            hasFocus: true,
          },
          focusCardId: A,
        });
        await spawnStub(app, A, stubDir, 2);
        await waitForBody(app, A);
        await focusBody(app, A);
        const body = app.body(A);

        await readInCard(
          app,
          "the completion popup",
          COMPLETION,
          () => app.nativeType("/"),
          () => app.nativeKey("Escape"),
        );
        await app.nativeKey("Backspace");

        /** A right-click at the middle of `selector`, at its window point: the host's hit test hands it to the body. */
        const rightClick = async (selector: string): Promise<void> => {
          const r = await body.evalJS<Box>(
            `(function () { var r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`,
          );
          const frame = (await bodyOf(app, A))!.frame;
          await app.nativeRightClick({ x: frame.x + (r.left + r.right) / 2, y: frame.y + (r.top + r.bottom) / 2 });
        };

        await readInCard(app, "the composer's context menu", CONTEXT_MENU, () => rightClick(PROMPT_INPUT), () => app.nativeKey("Escape"));

        // The badge's report opens on a right-click; a left click opens the
        // changelog in the system browser.
        await readInCard(app, "the route report", ROUTE_REPORT, () => rightClick(ROUTE_BADGE), () => app.nativeKey("Escape"));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
