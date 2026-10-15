/**
 * row-26-deck-scope-surfaces.test.ts — what a body card raises past its
 * own content box, the shell draws.
 *
 * A body's viewport is its card's content box, so the Z2 placard, built to
 * stand up off the status row over the masthead and the wall above the card,
 * had only the card to stand in there; and `/logout`'s confirm belongs to the
 * app-level `TugLogout`, which a body never mounts, so from a body it raised
 * nothing. Now the body keeps its placard rendered, hidden, and the shell
 * draws its content over the deck (`lib/shell-surface.ts`); and a body hands
 * its logout to the shell.
 *
 * One body Session card split under two Text cards, with eight turns sent
 * through its composer, so the TIME placard is taller than the room above
 * its Z2 row. The TIME cell, clicked in the body, opens the placard; the
 * shell draws it, standing past the body's top edge, and the composite says
 * so: a column through it, from above the panel down to the body's top,
 * changes where the panel begins when it opens and comes back when it goes.
 * A turn button in the panel, over the body, is clicked: the shell takes it
 * (its pointer claim) and the body's own button receives the click. A click
 * in the body outside the panel dismisses it there, and the shell's goes.
 * Then `/logout`, typed in the composer and sent, raises the shell's "Log Out
 * of Claude?" confirm, which is cancelled — guarded on the button's words,
 * the way at0598 guards it, so nothing ever logs the machine out.
 *
 * @foreground
 * @covers tugdeck/src/lib/shell-surface.ts
 * @covers tugdeck/src/lib/logout-store.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { decodePngFile } from "../_harness/png";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { bodyOf, focusBody, pollFor, promptPhase, sessionPane, SETTLE_MS, spawnStub, waitForBody } from "./_bodies";

const TEST_NAME = "body-grounding-row-26-deck-scope-surfaces";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const A = "r26-a";
const T = "r26-t";
const U = "r26-u";
/** The turns committed before the placard opens. */
const TURNS = 8;
const TIME_CELL = '[data-slot="tug-status-cell"][data-priority="time"]';
const DRAWN = `[data-shell-surface="${A}"]`;
const HIDDEN = ".tug-placard.tug-placard-drawn-elsewhere";
const TURN_BUTTON = '[data-slot="session-popover-row-turn"]';
const ALERT = '[data-slot="tug-alert"]';
const ALERT_TITLE = `${ALERT} .tug-alert-title`;
const ALERT_CANCEL = `${ALERT} .tug-alert-actions [data-slot="tug-push-button"]`;

/** How far above the panel the column starts, and the margin its paint is judged by (points). */
const COLUMN_REACH_PT = 28;
const EDGE_PT = 12;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const rectOf = (selector: string): string => `(function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (el === null) return null;
  var r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
})()`;

const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;

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

describe.skipIf(!SHOULD_RUN)("body-grounding row 26: the shell draws a body's deck-scope surfaces", () => {
  test(
    "the Z2 placard stands past the body card and takes the click; /logout raises the app's confirm",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({
          state: {
            cards: [
              { id: T, componentId: "text", title: "T", closable: true },
              { id: U, componentId: "text", title: "U", closable: true },
              { id: A, componentId: "session", title: "A", closable: true },
            ],
            // One column split three ways, two Text cards above the body
            // card: the room above its Z2 row is less than the placard's
            // height.
            panes: [sessionPane(T, 0), sessionPane(U, 0), sessionPane(A, 0)],
            activePaneId: `${A}-pane`,
            imposition: { kind: "two-up", columns: { 0: { mode: "split", order: [`${T}-pane`, `${U}-pane`, `${A}-pane`] } } },
            hasFocus: true,
          },
          focusCardId: A,
        });
        await spawnStub(app, A, stubDir, 1, TURNS);
        await waitForBody(app, A);
        await focusBody(app, A);
        const body = app.body(A);
        // Each prompt replays the stub's next turn: the turns the TIME
        // placard lists, and which make it taller than the room the card has
        // above its Z2 row.
        for (let i = 0; i < TURNS; i++) {
          await app.nativeType(`turn ${i + 1}`);
          await app.nativeKey("Return", ["cmd"]);
          await body.waitForCondition<boolean>(`${promptPhase} !== "idle"`, { timeoutMs: SETTLE_MS });
          await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 30_000 });
        }
        const frame = (await bodyOf(app, A))!.frame;

        // ---- The placard ----
        await body.nativeClickAtElement(TIME_CELL);
        const drawn = await pollFor(() => app.evalJS<Rect | null>(rectOf(DRAWN)), (r) => r !== null, SETTLE_MS);
        expect(drawn, "the shell draws the placard the body opened").not.toBeNull();
        expect(await body.evalJS<boolean>(present(HIDDEN)), "the body keeps its own, hidden").toBe(true);
        // At rest: the entrance travels 4 pt.
        await Bun.sleep(300);
        const panel = (await app.evalJS<Rect | null>(rectOf(DRAWN)))!;
        note(`panel ${JSON.stringify(panel)}; body frame ${JSON.stringify(frame)}`);
        note(
          `drawn: ${JSON.stringify(await app.evalJS<unknown>(`(function () {
            var p = document.querySelector(${JSON.stringify(DRAWN)});
            return { text: p.innerText.slice(0, 240), rows: p.querySelectorAll(${JSON.stringify(TURN_BUTTON)}).length, maxHeight: getComputedStyle(p).maxHeight, line: p.style.getPropertyValue("--tugx-placard-line"), avail: p.style.getPropertyValue("--radix-popover-content-available-height") };
          })()`))}; body: ${JSON.stringify(await body.evalJS<unknown>(`(function () {
            var p = document.querySelector(${JSON.stringify(HIDDEN)});
            var r = p.getBoundingClientRect();
            var z2 = document.querySelector('[data-slot="session-card-status-bar"]').getBoundingClientRect();
            return { hidden: { top: r.top, bottom: r.bottom }, z2Top: z2.top, viewport: window.innerHeight };
          })()`))}`,
        );
        expect(panel.top, "the panel stands past the body's top edge").toBeLessThan(frame.y - EDGE_PT);
        expect(panel.left, "inside the window").toBeGreaterThanOrEqual(0);

        // The composite: a column through the panel, from above it down to
        // the body's top, changes where the panel begins.
        const x = panel.left + (panel.right - panel.left) / 3;
        const y = panel.top - COLUMN_REACH_PT;
        const h = frame.y - y;
        const shown = await column(app, x, y, h);

        // A press in the panel, over the body, is the shell's to take and
        // the body's button receives it.
        await body.evalJS<null>(`(function () {
          window.__r26Clicks = [];
          document.addEventListener("click", function (e) {
            var t = e.target instanceof Element ? e.target : e.target.parentElement;
            if (t !== null && t.closest(${JSON.stringify(HIDDEN)}) !== null) window.__r26Clicks.push(t.textContent);
          }, true);
          return null;
        })()`);
        const buttons = await app.evalJS<Array<Rect & { text: string }>>(`Array.from(document.querySelectorAll(${JSON.stringify(`${DRAWN} ${TURN_BUTTON}`)})).map(function (b) {
          var r = b.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, text: b.textContent };
        })`);
        note(`turn buttons ${JSON.stringify(buttons)}`);
        const overBody = buttons.filter((b) => (b.top + b.bottom) / 2 > frame.y + EDGE_PT);
        expect(overBody.length, "a turn button stands over the body").toBeGreaterThan(0);
        const target = overBody[overBody.length - 1];
        await app.nativeClick({ x: (target.left + target.right) / 2, y: (target.top + target.bottom) / 2 });
        const clicks = await pollFor(() => body.evalJS<string[]>("window.__r26Clicks"), (c) => c.length > 0, SETTLE_MS);
        expect(clicks, "the body's own button received the press").toEqual([target.text]);

        // A click in the body outside the panel dismisses it there, and the
        // shell's goes with it.
        const outside = { x: frame.x + frame.width - 30, y: frame.y + 30 };
        expect(
          outside.x > panel.right || outside.y < panel.top,
          "the dismissing click lands outside the panel",
        ).toBe(true);
        await app.nativeClick(outside);
        const gone = await pollFor(() => app.evalJS<Rect | null>(rectOf(DRAWN)), (r) => r === null, SETTLE_MS);
        expect(gone, "the shell takes the panel down").toBeNull();
        expect(await body.evalJS<boolean>(present(HIDDEN)), "the body's closed too").toBe(false);
        await Bun.sleep(250);
        const closed = await column(app, x, y, h);
        const changed = differing(shown.rows, closed.rows, shown.scale).map((pt) => pt - COLUMN_REACH_PT);
        note(`column: ${changed.length} rows changed, from ${changed[0]?.toFixed(1)} to ${changed.at(-1)?.toFixed(1)} pt against the panel's top`);
        expect(changed.length, "the panel was painted past the card").toBeGreaterThan(0);
        expect(Math.abs(changed[0]), "its paint begins where the panel does").toBeLessThanOrEqual(EDGE_PT);

        // ---- /logout ----
        await focusBody(app, A);
        await app.nativeType("/logout");
        await Bun.sleep(200);
        await app.nativeKey("Escape");
        await Bun.sleep(200);
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(present(ALERT), { timeoutMs: 8_000 });
        expect((await app.evalJS<string>(`document.querySelector(${JSON.stringify(ALERT_TITLE)}).textContent`)).trim()).toBe(
          "Log Out of Claude?",
        );
        // Never press the confirm: guard the click on the button's own words.
        const cancelLabel = (await app.evalJS<string>(`document.querySelector(${JSON.stringify(ALERT_CANCEL)}).textContent`)).trim();
        if (cancelLabel !== "Cancel") {
          throw new Error(`refusing to click ${JSON.stringify(cancelLabel)} in the logout confirm`);
        }
        await app.nativeClickAtElement(ALERT_CANCEL);
        await app.waitForCondition<boolean>(`!(${present(ALERT)})`, { timeoutMs: 8_000 });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
