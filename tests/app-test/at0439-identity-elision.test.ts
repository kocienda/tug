/**
 * at0439-identity-elision.test.ts — which run of a session's identity gives
 * way when the line runs out of room, on the real thing.
 *
 * The rule the line tier now holds: the **callsign pays first, and it pays
 * from the middle**. The project prefix places the session and the callsign's
 * last word is what a reader says out loud, so a squeeze eats the middle of
 * `tugtool/frothy-nurse-2` and leaves both ends. The user's own name and the
 * bound dash are what survive — the name because the user chose it, the dash
 * because a session on a dash is never named without it.
 *
 * The squeeze is applied the way a squeeze happens: a width constraint on the
 * identity element, with the real flex algorithm distributing the deficit
 * through the three nested clamps in `tug-session-identity.css`. Nothing is
 * simulated — the assertions read `scrollWidth` against `clientWidth` on the
 * spans the browser actually laid out.
 *
 * Two stages, because the ORDER is the claim and one stage cannot show an
 * order. A small deficit must land entirely on the callsign's head. A large
 * one must exhaust the head and only then reach the name — with the dash
 * intact through both, which is the half a single-stage test would miss.
 *
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 * @covers tugdeck/src/components/tugways/tug-session-identity.css
 * @covers tugdeck/src/lib/session-identity.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { createDash, discardDash } from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0439-session";
const TAG = "frothy-nurse-2";
const NAME = "The long name the user gave this session";
const DASH_NAME = "at0439-elide";

const CARDS = '.lens-section[data-lens-section="cards"]';
const SESSION_ROW = `${CARDS} [data-session-id="${SID}"]`;
const IDENTITY = `${SESSION_ROW} .tug-session-identity[data-tier="line"]`;

const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
let dashOwnerId = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dashOwnerId = createDash(PROJECT_DIR, DASH_NAME, "at0439 fixture").id;
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  discardDash(PROJECT_DIR, DASH_NAME);
});

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
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

interface RunWidths {
  /** Whether the browser had to clip the run to fit its box. */
  name: boolean;
  head: boolean;
  dash: boolean;
  /** The tail's right edge inside the identity's — it must never be cut off. */
  tailWhole: boolean;
  /** What the reader is left with, for the diagnostics line. */
  text: string;
}

/**
 * Squeeze the identity by `deficit` px below its natural width and report
 * which runs were clipped.
 *
 * The constraint goes on the identity element itself, which is what a narrow
 * row does to it: everything inside — the three levels of clamp — is the
 * code under test, untouched.
 */
const squeeze = (app: App, deficit: number): Promise<RunWidths> =>
  app.evalJS<RunWidths>(
    `(() => {
       const id = document.querySelector(${JSON.stringify(IDENTITY)});
       id.style.maxInlineSize = "";
       const natural = id.getBoundingClientRect().width;
       id.style.maxInlineSize = (natural - ${deficit}) + "px";
       // A synchronous read forces the layout the assertions are about.
       void id.getBoundingClientRect();
       const clipped = (sel) => {
         const el = id.querySelector(sel);
         return el !== null && el.scrollWidth > el.clientWidth + 1;
       };
       const tail = id.querySelector(".tug-session-identity-callsign-tail");
       const box = id.getBoundingClientRect();
       return {
         name: clipped(".tug-session-identity-name"),
         head: clipped(".tug-session-identity-callsign-head"),
         dash: clipped(".tug-session-identity-dash-name"),
         tailWhole:
           tail !== null &&
           tail.getBoundingClientRect().right <= box.right + 1 &&
           tail.scrollWidth <= tail.clientWidth + 1,
         text: (id.textContent ?? "").trim(),
       };
     })()`,
  );

describe.skipIf(!SHOULD_RUN)("AT0439: the identity line's elision order", () => {
  test(
    "the callsign gives way first and from the middle; the name and the dash hold",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0439-identity-elision",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          projectDir: PROJECT_DIR,
          workspaceKey: PROJECT_DIR,
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        app.seedLedger({
          sessions: [
            {
              session_id: SID,
              workspace_key: PROJECT_DIR,
              project_dir: PROJECT_DIR,
              card_id: "A",
              name: NAME,
              tag: TAG,
              dash_id: dashOwnerId,
              dash_name: DASH_NAME,
            },
          ],
        });

        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `(() => {
             const id = document.querySelector(${JSON.stringify(IDENTITY)});
             return id !== null &&
               id.querySelector(".tug-session-identity-callsign-tail") !== null &&
               id.querySelector(".tug-session-identity-dash-name") !== null;
           })()`,
          { timeoutMs: 20000 },
        );

        // ── At rest: nothing is elided, and the split is invisible ────────
        const whole = await squeeze(app, 0);
        note("at0439 at rest", JSON.stringify(whole));
        expect(whole.text).toContain(NAME);
        expect(whole.text).toContain(TAG);
        expect(whole.text).toContain(DASH_NAME);
        expect(whole.name).toBe(false);
        expect(whole.head).toBe(false);
        expect(whole.dash).toBe(false);

        // ── A small squeeze: the callsign's head pays, alone ──────────────
        const small = await squeeze(app, 40);
        note("at0439 small squeeze", JSON.stringify(small));
        expect(small.head).toBe(true);
        expect(small.name).toBe(false);
        expect(small.dash).toBe(false);
        // Middle truncation, not tail truncation: the last word survives.
        expect(small.tailWhole).toBe(true);
        note("at0439 lens under a small squeeze", (await app.screenshot()).path);

        // ── A large one: the head is spent, so the name pays next ─────────
        const large = await squeeze(app, 220);
        note("at0439 large squeeze", JSON.stringify(large));
        expect(large.head).toBe(true);
        expect(large.name).toBe(true);
        // The dash is the last thing a row gives up — it is what the reader
        // was scanning for.
        expect(large.dash).toBe(false);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
