/**
 * at0817-overlay-exit-frees-the-app — an app-modal leaves by its exit, and
 * the app takes presses again however that exit goes.
 *
 * The overlay-exits brief ([B01], [B02]) gave alerts and the Radix app-modals
 * drawn on the alert's classes an exit. They had none, on purpose: Radix holds
 * a closing layer until `animationend`, and a modal holds `pointer-events:
 * none` on `<body>` until that layer unmounts, so an exit that never finished
 * left the whole app dead with nothing on screen (`tug-alert.css`). The exit
 * now runs in TugAnimator while Radix is still open, and Radix closes when it
 * settles or at its deadline (`overlay-motion.ts`).
 *
 * So this file asks both halves of that, in the overlay page where the
 * app-modals draw:
 *
 * 1. **The exit runs.** The logout confirm (`TugAlert`) and the setup wizard
 *    (`ConfigureTug`) are each marked `data-closing` with an animation running
 *    on the panel when they are dismissed, rather than vanishing. The alert
 *    still wears its rings as it starts to leave: its focus trap lasts as long
 *    as it is on screen ([B09]), so the key view's ring and the default
 *    button's double ring are not stripped from a fading panel.
 * 2. **The app is freed when the exit cannot finish.** With every new WAAPI
 *    animation paused — what a covered window's suspended rAF does to an
 *    exit's `finished` — the wizard still goes, at the deadline, and the
 *    overlay's body lock and window claim come off.
 * 3. **And at a zero timing scale.** With `--tug-timing: 0` the same.
 *
 * The logout confirm is raised from the wizard's Log Out… row, and the test
 * presses only its Cancel — never the confirm, which would log the machine
 * out — so, like `at0598`, it needs a logged-in machine. The wizard is reached
 * through `dispatchControlAction("configure-tug")`, the action the menu item
 * posts.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/overlay-motion.ts
 * @covers tugdeck/src/components/tugways/tug-alert.tsx
 * @covers tugdeck/src/components/tugways/tug-alert.css
 * @covers tugdeck/src/components/tugways/configure-tug.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App, type BodyApp } from "./_harness";
import { overlayReady } from "./overlay-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SETUP = '[data-slot="configure-tug"]';
const SIGNIN_ROW = `${SETUP} .configure-tug-step[data-step="signin"]`;
const SIGNIN_BUTTON = `${SIGNIN_ROW} [data-slot="tug-push-button"]`;
const SETUP_DONE = `${SETUP} .tug-alert-actions [data-slot="tug-push-button"]`;
const ALERT = '[data-slot="tug-alert"]';
const ALERT_CANCEL = `${ALERT} .tug-alert-actions [data-slot="tug-push-button"]`;

/** Well past the 200ms exit plus its 150ms deadline margin; a close later than this is a hang. */
const GONE_WITHIN_MS = 3000;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "gallery-input", title: "A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 60, y: 60 },
        size: { width: 900, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;
const text = (selector: string): string =>
  `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "").trim()`;

/**
 * Record every element that takes `data-closing`, with how many animations are
 * running on it at that moment. A mutation callback runs after the task that
 * set the mark, and `runOverlayExit` starts its animations in that same task,
 * so the count is the exit's own — read without racing the 200ms it lasts.
 */
const WATCH_CLOSING = `(function () {
  if (window.__at0817 !== undefined) return null;
  window.__at0817 = { seen: [] };
  new MutationObserver(function (records) {
    records.forEach(function (r) {
      var el = r.target;
      if (!el.hasAttribute("data-closing")) return;
      window.__at0817.seen.push({
        slot: el.getAttribute("data-slot"),
        running: el.getAnimations().filter(function (a) { return a.playState === "running"; }).length,
        rings: el.querySelectorAll("[data-key-view-kbd], [data-default-ring]").length,
      });
    });
  }).observe(document.body, { attributes: true, attributeFilter: ["data-closing"], subtree: true });
  return null;
})()`;

const seenFor = (slot: string): string =>
  `JSON.stringify(window.__at0817.seen.filter(function (s) { return s.slot === ${JSON.stringify(slot)}; }))`;

/** No body lock left, and the overlay no longer claims the whole window. */
const FREED = `(document.body.style.pointerEvents !== "none" &&
  document.documentElement.getAttribute("data-overlay-claim-state") !== "all")`;

async function openSetup(app: App, overlay: BodyApp): Promise<void> {
  await app.evalJS<null>(`(window.__tug.dispatchControlAction("configure-tug", {}), null)`);
  await overlay.waitForCondition<boolean>(present(SETUP_DONE), { timeoutMs: 8000 });
}

/** Done, guarded on its own words, then the wizard gone and the app freed. */
async function doneAndFreed(overlay: BodyApp, label: string): Promise<void> {
  const doneLabel = await overlay.evalJS<string>(text(SETUP_DONE));
  if (doneLabel !== "Done") throw new Error(`refusing to click ${JSON.stringify(doneLabel)} in the setup wizard`);
  await overlay.nativeClickAtElement(SETUP_DONE);
  await overlay.waitForCondition<boolean>(`!(${present(SETUP)})`, { timeoutMs: GONE_WITHIN_MS });
  await overlay.waitForCondition<boolean>(FREED, { timeoutMs: GONE_WITHIN_MS });
  note(`at0817 ${label}`, "the wizard went and the app is freed");
}

describe.skipIf(!SHOULD_RUN)("AT0817: an app-modal leaves by its exit and frees the app", () => {
  test(
    "the alert and the wizard animate out, and a stalled or zero-time exit still closes",
    async () => {
      const app = await launchTugApp({ testName: "at0817-overlay-exit-frees-the-app" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        const overlay = await overlayReady(app);
        await overlay.evalJS<null>(WATCH_CLOSING);

        // ---- 1. The alert leaves by its exit ----------------------------
        await openSetup(app, overlay);
        expect(
          await overlay.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(SIGNIN_ROW)})?.getAttribute("data-status") ?? null`,
          ),
          "this test needs a logged-in machine",
        ).toBe("done");
        expect(await overlay.evalJS<string>(text(SIGNIN_BUTTON))).toBe("Log Out…");
        await overlay.nativeClickAtElement(SIGNIN_BUTTON);
        await overlay.waitForCondition<boolean>(present(ALERT_CANCEL), { timeoutMs: 8000 });
        const cancelLabel = await overlay.evalJS<string>(text(ALERT_CANCEL));
        if (cancelLabel !== "Cancel") {
          throw new Error(`refusing to click ${JSON.stringify(cancelLabel)} in the logout confirm`);
        }
        await overlay.nativeClickAtElement(ALERT_CANCEL);
        await overlay.waitForCondition<boolean>(`!(${present(ALERT)})`, { timeoutMs: GONE_WITHIN_MS });
        const alertSeen = JSON.parse(await overlay.evalJS<string>(seenFor("tug-alert"))) as {
          running: number;
          rings: number;
        }[];
        note("at0817 alert exit", JSON.stringify(alertSeen));
        expect(alertSeen.length, "the dismissed alert was marked closing, not unmounted at once").toBe(1);
        expect(alertSeen[0]!.running, "an exit animation ran on the alert's panel").toBeGreaterThan(0);
        expect(alertSeen[0]!.rings, "the alert's rings stay on the panel as it leaves").toBeGreaterThan(0);
        expect(await overlay.evalJS<boolean>(present(SETUP)), "Cancel returns to the wizard").toBe(true);

        // ---- 2. The wizard leaves by its exit ---------------------------
        await doneAndFreed(overlay, "wizard, normal timing");
        const setupSeen = JSON.parse(await overlay.evalJS<string>(seenFor("configure-tug"))) as {
          running: number;
        }[];
        note("at0817 wizard exit", JSON.stringify(setupSeen));
        expect(setupSeen.length, "the wizard was marked closing, not unmounted at once").toBe(1);
        expect(setupSeen[0]!.running, "an exit animation ran on the wizard's panel").toBeGreaterThan(0);

        // ---- 3. An exit that never finishes still closes ----------------
        //
        // Every WAAPI animation started from here on is paused at birth, so
        // the exit's `finished` never settles — the state a covered window's
        // suspended rAF leaves it in. Only the deadline can close the wizard.
        await openSetup(app, overlay);
        await overlay.evalJS<null>(`(function () {
          window.__at0817.animate = Element.prototype.animate;
          Element.prototype.animate = function () {
            var a = window.__at0817.animate.apply(this, arguments);
            a.pause();
            return a;
          };
          return null;
        })()`);
        try {
          await doneAndFreed(overlay, "wizard, exit stalled");
        } finally {
          await overlay.evalJS<null>(`(Element.prototype.animate = window.__at0817.animate, null)`);
        }

        // ---- 4. A zero timing scale still closes -----------------------
        await overlay.evalJS<null>(
          `(document.documentElement.style.setProperty("--tug-timing", "0"), null)`,
        );
        try {
          await openSetup(app, overlay);
          await doneAndFreed(overlay, "wizard, timing 0");
        } finally {
          await overlay.evalJS<null>(
            `(document.documentElement.style.removeProperty("--tug-timing"), null)`,
          );
        }
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0817-overlay-exit-frees-the-app] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
