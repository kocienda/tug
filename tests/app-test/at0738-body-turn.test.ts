/**
 * at0738-body-turn.test.ts — a whole turn streams in a body card, with its
 * masthead reading the turn.
 *
 * Part of the gate for the body path, split from `at0738-session-body` one
 * leg per file (see `at0738-body-placement` for the list). The app launches
 * with bodies on; shared helpers live in `session-body-fixture.ts`.
 *
 * **The turn.** A whole turn streams in a body: the shell's document holds no
 * transcript for the card, the masthead dot reads working during the turn
 * and idle after — in the card's own page, which draws its chrome, masthead
 * and all, since the masthead left the shell's pane — tugcast lists one body
 * page for the card subscribed to its session alone, and the composited
 * window's rect is filled by the body's own pane surface — its commonest
 * colour, not an ink share, which the shell's grid would satisfy through an
 * empty placeholder. The WebContent processes and their resident size with
 * two bodies and the spare are noted for the program's record. The history
 * and Changes sheets this leg used to open after the turn are
 * `at0738-body-sheets`.
 *
 * @family at0738-body
 * @covers tugdeck/src/lib/body-placement.ts
 * @covers tugdeck/src/lib/body-facts-store.ts
 * @covers tugdeck/src/lib/body-command-route.ts
 * @covers tugdeck/src/lib/pointer-claim.ts
 * @covers tugdeck/src/components/chrome/body-placement-beacon.tsx
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-handoff.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugdeck/src/body/body-intent.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/BodyGeometry.swift
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";

import { launchTugApp, note } from "./_harness";
import type { BodyViewSnapshot } from "./_harness/client";
import {
  BODY_READY_MS,
  PLACED_MS,
  column,
  mastheadDot,
  pagesOf,
  paintIn,
  pollFor,
  promptPhase,
  spawnStub,
  webContentProcesses,
} from "./session-body-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!SHOULD_RUN)("at0738: a Session card's body", () => {
  test(
    "streams a whole turn in the body, with the shell's masthead fed from the bus",
    async () => {
      const stubDir = stubDirectory();
      const before = new Set(webContentProcesses().map((p) => p.pid));
      const app = await launchTugApp({
        testName: "at0738-body-turn",
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      const TURN = "at0738-turn";
      const OTHER = "at0738-other";
      try {
        await app.seedDeckState({ state: column([TURN, OTHER]), focusCardId: TURN });
        const readyBody = (id: string) => (all: BodyViewSnapshot[]) =>
          all.some((b) => b.cardId === id && b.state === "ready" && b.visible);
        // Two messages, about five seconds of streaming: long enough for every
        // mid-turn reading below, and half the four-message turn's wait.
        const tugSessionId = await spawnStub(app, TURN, stubDir, 2);
        await pollFor(() => app.bodies(), readyBody(TURN), BODY_READY_MS);
        await spawnStub(app, OTHER, stubDir);
        await pollFor(() => app.bodies(), readyBody(OTHER), BODY_READY_MS);

        // ---- Two bodies and the spare: what the program's record holds ----

        const withSpare = await pollFor(
          () => app.bodies(),
          (all) => all.some((b) => b.cardId === null && b.state === "connected"),
          BODY_READY_MS,
        );
        const added = webContentProcesses().filter((p) => !before.has(p.pid));
        note(
          `views: ${JSON.stringify(withSpare.map((b) => ({ cardId: b.cardId, state: b.state, start: b.start, readyMs: b.readyMs })))}`,
        );
        note(
          `WebContent processes this launch added: ${added.length}, ${Math.round(added.reduce((s, p) => s + p.rssKb, 0) / 1024)} MB resident ` +
            `(each MB: ${JSON.stringify(added.map((p) => Math.round(p.rssKb / 1024)))})`,
        );

        // ---- The turn streams in the body ----

        const body = app.body(TURN);
        await body.waitForCondition<boolean>(`document.querySelector('[data-testid="session-card-transcript"]') !== null`, {
          timeoutMs: BODY_READY_MS,
        });
        await body.driveSession({ op: "send", text: "Walk the module and report each pass." });
        await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: BODY_READY_MS });

        const shellTranscript = await app.evalJS<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="${TURN}-pane"] [data-testid="session-card-transcript"]') !== null`,
        );
        expect(shellTranscript, "the shell's document holds no transcript for the body card").toBe(false);

        const working = await pollFor(
          () => app.body(TURN).evalJS<{ role: string; state: string } | null>(mastheadDot()),
          (d) => d !== null && d.state === "running",
          PLACED_MS,
        );
        note(`masthead dot mid-turn: ${JSON.stringify(working)}`);
        expect(working, "the shell's masthead stands a phase dot for the body card").not.toBeNull();
        expect(working!.state, "the masthead reads the body's turn as working").toBe("running");

        const pages = await pagesOf(app);
        const turnPages = pages.filter((p) => p.role === "body" && p.card_id === TURN);
        note(`pages: ${JSON.stringify(pages.map((p) => ({ role: p.role, card: p.card_id, sessions: p.sessions })))}`);
        expect(turnPages.length, "tugcast lists one body page for the card").toBe(1);
        expect(turnPages[0].sessions, "the body page takes its own session's frames alone").toEqual([tugSessionId]);

        // Key first: the shell washes an inactive pane, body card or not,
        // so only a key card's rect reads as the body's own surface.
        await app.dispatchControlAction("focus-session-card", { cardId: TURN });
        await pollFor(() => app.getFocusedCardId(), (id) => id === TURN, PLACED_MS);
        await Bun.sleep(300);
        const frame = (await app.bodies()).find((b) => b.cardId === TURN)!.frame;
        const shot = await app.captureWindow();
        copyFileSync(shot.path, "/tmp/at0738-turn.png");
        const paint = paintIn(shot.path, shot, frame);
        // Both colours as the composite has them: through a 2D canvas, since
        // a computed style keeps the theme's oklch spelling.
        const asRgb = (expr: string): string => `(function () {
          var c = document.createElement("canvas").getContext("2d");
          c.fillStyle = ${expr}; c.fillRect(0, 0, 1, 1);
          var d = c.getImageData(0, 0, 1, 1).data;
          return "rgb(" + d[0] + ", " + d[1] + ", " + d[2] + ")";
        })()`;
        // The surface the card's content stands on: the nearest painted box
        // under the content's centre. (The page's own background is clear: a
        // card that draws its own chrome is the whole of its view.)
        const surfaceAtContent = `(function () {
          var c = document.querySelector(".tug-pane-content").getBoundingClientRect();
          for (var el = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2); el; el = el.parentElement) {
            var bg = getComputedStyle(el).backgroundColor;
            if (bg !== "transparent" && !/rgba\\([^)]*,\\s*0\\)$/.test(bg)) return bg;
          }
          return "transparent";
        })()`;
        const bodySurface = await body.evalJS<string>(asRgb(surfaceAtContent));
        // What the shell lays over the frame — the frame dim, a normal-blend
        // layer, composites over the content as it does over a shell card — so
        // the rect reads as the body's surface under that layer. A Session card
        // draws its own pane, frame dim and all, in its own page, so the layer
        // and the frame's `data-focused` are read there, as they stand.
        const expected = await body.evalJS<{ fill: string; focused: string | null; layer: string }>(`(function () {
          var pane = document.querySelector('.body-chrome-frame');
          var s = getComputedStyle(pane, "::after");
          var c = document.createElement("canvas").getContext("2d");
          c.fillStyle = ${JSON.stringify(bodySurface)}; c.fillRect(0, 0, 1, 1);
          c.globalAlpha = parseFloat(s.opacity); c.fillStyle = s.backgroundColor; c.fillRect(0, 0, 1, 1);
          var d = c.getImageData(0, 0, 1, 1).data;
          return { fill: "rgb(" + d[0] + ", " + d[1] + ", " + d[2] + ")", focused: pane.getAttribute("data-focused"),
            layer: s.backgroundColor + " @ " + s.opacity };
        })()`);
        const shellCanvas = await app.evalJS<string | null>(
          `(function () { return document.documentElement.hasAttribute("data-body-host") ? ${asRgb("getComputedStyle(document.body).getPropertyValue('--tug7-surface-global-primary-normal-canvas-rest')")} : null; })()`,
        );
        note(`the card's own frame: data-focused=${expected.focused}, frame dim ${expected.layer}, expected fill ${expected.fill}`);
        note(
          `composite in the body's rect ${JSON.stringify(frame)}: fill ${paint.fill}, ink ${(paint.ink * 100).toFixed(1)}%; ` +
            `body surface ${bodySurface}, host canvas floor ${shellCanvas}`,
        );
        expect(shellCanvas, "the host stands a canvas floor under the deck on a body host, and the shell's canvas stands down for it").not.toBeNull();
        expect(paint.fill, "the body's rect is painted by the body, not the shell's canvas").not.toBe(shellCanvas);
        const bodyFocused = await body.evalJS<string | null>(
          `document.querySelector(".body-chrome-frame")?.getAttribute("data-focused") ?? null`,
        );
        expect(bodyFocused, "the key card's body reads itself as focused").toBe("true");
        const channel = (rgb: string): number[] => rgb.match(/\d+/g)!.map(Number);
        const off = channel(paint.fill).map((v, i) => Math.abs(v - channel(expected.fill)[i]));
        expect(
          Math.max(...off),
          `the body's rect is the body's own surface under the shell's frame layer (fill ${paint.fill}, expected ${expected.fill})`,
        ).toBeLessThanOrEqual(4);
        expect(paint.ink, "the body's paint carries its content").toBeGreaterThan(0.01);

        // ---- The turn ends ----

        await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 90_000 });
        const rested = await pollFor(
          () => app.body(TURN).evalJS<{ role: string; state: string } | null>(mastheadDot()),
          (d) => d !== null && d.state === "stopped",
          PLACED_MS,
        );
        note(`masthead dot after the turn: ${JSON.stringify(rested)}`);
        expect(rested?.state, "the masthead reads the body's session as idle once the turn ends").toBe("stopped");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
