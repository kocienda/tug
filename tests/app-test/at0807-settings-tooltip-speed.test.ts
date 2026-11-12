/**
 * at0807-settings-tooltip-speed.test.ts — Settings ▸ General ▸ Tooltip Speed
 * reaches every kind of tooltip ([AT0807]).
 *
 * Scenario:
 *
 *   Open the Settings card the way ⌘, does. Time a house tooltip — the
 *   bullseye button in the Settings card's own title bar, drawn in the card's
 *   own page — at the Standard speed: it waits its full base delay (900 ms).
 *   Press Instant in the Tooltip Speed row. Then:
 *
 *   - the choice reached tugbank, read back over `GET /api/defaults/…`;
 *   - the same bubble opens at once, in the same page, with no reload — the
 *     card page's provider read the new speed, which is the proof that a body
 *     page, not only the shell, answers the setting;
 *   - the host put the OS tooltips (the `title` tooltips WebKit hands AppKit)
 *     at 0 ms, read off the app's `NSInitialToolTipDelay` default, which the
 *     host writes beside telling the live tooltip manager.
 *
 *   Standard again puts the OS default back at AppKit's own 1500 ms, which is
 *   also what leaves the app-test bundle's shared defaults domain as it found
 *   it.
 *
 * Timing is read in the page: a `MutationObserver` on the trigger's
 * `aria-describedby` — Radix's statement that its bubble stands — clocks the
 * open against the synthesized hover, so `evalJS`'s round trip is not in the
 * reading. Radix's delay is a `setTimeout`, not a frame, so a background
 * app-test window running no rAF does not stall it. The hover is the
 * `pointerenter` + `pointermove` at0404 synthesizes. Between timings the
 * bubble is closed by the trusted click that picks the next speed, because a
 * synthesized leave never closes a hoverable Radix bubble.
 *
 * Gating
 * ------
 * `describe.skipIf(!SHOULD_RUN)`. CI and `bun x tsc --noEmit` runs without
 * `TUGAPP_APP_TEST=1` skip every test.
 *
 * @covers tugdeck/src/components/tugways/cards/settings-general-body.tsx
 * @covers tugdeck/src/lib/tooltip-speed.ts
 * @covers tugdeck/src/components/tugways/tug-tooltip.tsx
 * @covers tugdeck/src/settings-api.ts
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

import { launchTugApp, type App, type BodyApp } from "./_harness";
import { kindBody } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const NO_AX = { skipAccessibilityPreflight: true } as const;

const TRIGGER = '[data-testid="tug-pane-title-bar-bullseye-button"]';
const FIELD = '[data-testid="settings-tooltip-speed-field"]';

/** The house label tooltip's base delay, which Standard leaves alone. */
const LABEL_BASE_MS = 900;

/**
 * Hover the trigger and return how long its bubble took to stand, in ms,
 * measured in the page.
 *
 * The trigger must be closed first. It is not closed here: a synthesized leave
 * does not close a hoverable Radix bubble (no real pointer ever moves), so the
 * caller closes it with an act — the trusted click on a speed segment, which
 * `lib/tooltip-dismiss` answers by ending every hover. What this does do is
 * React's synthetic leave, which clears the trigger's "pointer is inside me"
 * latch so the next enter is heard.
 */
async function timeOpen(page: BodyApp): Promise<number> {
  await page.evalJS<null>(
    `(document.querySelector(${JSON.stringify(TRIGGER)}).dispatchEvent(
       new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body })), null)`,
  );
  await page.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(TRIGGER)}).getAttribute("aria-describedby") === null`,
    { timeoutMs: 8000 },
  );
  await page.evalJS<null>(
    `(function () {
      var a = document.querySelector(${JSON.stringify(TRIGGER)});
      window.__at0807 = undefined;
      var t0 = 0;
      var mo = new MutationObserver(function () {
        if (a.getAttribute("aria-describedby")) {
          window.__at0807 = performance.now() - t0;
          mo.disconnect();
        }
      });
      mo.observe(a, { attributes: true, attributeFilter: ["aria-describedby"] });
      t0 = performance.now();
      a.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
      a.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
      return null;
    })()`,
  );
  const ms = await page.waitForCondition<number>(
    `window.__at0807 === undefined ? false : window.__at0807`,
    { timeoutMs: 8000 },
  );
  return ms;
}

/** Press one of the row's segments with a trusted click at its centre. */
async function choose(page: BodyApp, value: string): Promise<void> {
  const point = JSON.parse(
    await page.evalJS<string>(
      `(function () {
         var seg = document.querySelector(${JSON.stringify(`${FIELD} [data-choice-value="${value}"]`)});
         if (seg === null) return "null";
         var box = seg.getBoundingClientRect();
         return JSON.stringify({ x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
       })()`,
    ),
  ) as { x: number; y: number } | null;
  if (point === null) throw new Error(`[at0807] segment ${value} not found`);
  await page.nativeClick(point);
  await page.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(`${FIELD} [data-choice-value="${value}"]`)}).getAttribute("data-state") === "active"`,
    { timeoutMs: 5000 },
  );
}

/** Poll the stored speed over the defaults surface until it reads `want`. */
async function storedSpeed(app: App, want: string): Promise<unknown> {
  await app.evalJS(`(() => {
    window.__at0807_stored = undefined;
    const deadline = Date.now() + 5000;
    const poll = () => {
      fetch("/api/defaults/dev.tugapp.app/tooltip-speed")
        .then((r) => (r.ok ? r.json() : { kind: "missing", value: r.status }))
        .then((j) => {
          if ((j.kind === "string" && j.value === ${JSON.stringify(want)}) || Date.now() > deadline) {
            window.__at0807_stored = j.value;
            return;
          }
          window.setTimeout(poll, 100);
        })
        .catch((e) => { window.__at0807_stored = String(e); });
    };
    poll();
  })()`);
  return app.waitForCondition<unknown>(
    `window.__at0807_stored === undefined ? false : { v: window.__at0807_stored }`,
    { timeoutMs: 8000 },
  ).then((r) => (r as { v: unknown }).v);
}

/** Poll the host's `NSInitialToolTipDelay` until it reads `want`; return the last reading. */
async function nativeDelay(bundleId: string, want: number): Promise<number | null> {
  const deadline = Date.now() + 5000;
  let last: number | null = null;
  for (;;) {
    try {
      last = Number(
        execFileSync("/usr/bin/defaults", ["read", bundleId, "NSInitialToolTipDelay"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      );
    } catch {
      last = null;
    }
    if (last === want || Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!SHOULD_RUN)(
  "at0807: Settings ▸ General ▸ Tooltip Speed reaches every tooltip",
  () => {
    test("Instant opens a card page's tooltip at once and puts the OS tooltips at 0 ms", async () => {
      const app = await launchTugApp({ ...NO_AX, testName: "at0807-settings-tooltip-speed" });
      try {
        const { bundleId } = await app.checkAccessibilityPermission({ prompt: false });
        await app.evalJS(`window.__tug.dispatchControlAction("show-card", { component: "settings" })`);
        const page = kindBody(app, "settings");
        await page.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIELD)}) !== null &&
           document.querySelector(${JSON.stringify(TRIGGER)}) !== null`,
          { timeoutMs: 10000 },
        );

        // Standard: the bubble waits its whole base delay, and the shell has
        // told the host AppKit's own default.
        expect(
          await page.evalJS<string | null>(
            `document.querySelector('${FIELD} [data-state="active"]')?.getAttribute("data-choice-value") ?? null`,
          ),
          "an unset speed reads as Standard",
        ).toBe("standard");
        const standardMs = await timeOpen(page);
        expect(standardMs, "at Standard a label tip waits its full base delay").toBeGreaterThanOrEqual(
          LABEL_BASE_MS - 50,
        );
        expect(await nativeDelay(bundleId, 1500), "at Standard the OS tooltips keep AppKit's 1500 ms").toBe(1500);

        // Instant.
        await choose(page, "instant");
        expect(await storedSpeed(app, "instant"), "the choice reached tugbank").toBe("instant");
        const instantMs = await timeOpen(page);
        expect(instantMs, "at Instant the same tip opens at once, with no reload").toBeLessThan(400);
        expect(await nativeDelay(bundleId, 0), "at Instant the host puts the OS tooltips at 0 ms").toBe(0);

        // Back to Standard, which is also the shared defaults domain as found.
        await choose(page, "standard");
        expect(await storedSpeed(app, "standard")).toBe("standard");
        expect(await nativeDelay(bundleId, 1500), "Standard puts the OS tooltips back").toBe(1500);
      } finally {
        await app.close();
      }
    });
  },
);
