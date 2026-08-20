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
 * A custom-named title carries a callsign run at all only under a NAME
 * COLLISION ([D141]) — two sessions sharing one custom name, where the
 * callsign returns as the final disambiguation. The fixture seeds a second
 * session with the same name for exactly that reason: it is what makes the
 * three-run grammar exist so its elision order can be measured.
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
import {
  createDash,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  shellAndSettle,
  tugutilPath,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000439";
/** A second session sharing the custom name — the collision that brings the
 *  callsign run back to the title ([D141]). Never mounted; its name only has
 *  to be KNOWN for `nameShared` to read true on the row under test. */
const OTHER_SID = "a7c0d1ea-0000-4000-8000-000000000440";
const TAG = "frothy-nurse-2";
const NAME = "The long name the user gave this session";
const DASH_NAME = "at0439-elide";

const CARDS = '.lens-section[data-lens-section="cards"]';
const SESSION_ROW = `${CARDS} [data-session-id="${SID}"]`;
const IDENTITY = `${SESSION_ROW} .tug-session-identity[data-tier="line"]`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0439", checkout: CHECKOUT });
  createDash(projectDir(), DASH_NAME, "at0439 fixture", scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmDashScratchRepo(scratch);
  rmScratchSession(fixtureDir);
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
 * Give the identity `deficit` px less than its runs need, and report which of
 * them the browser had to clip.
 *
 * The width goes on the identity element itself, which is what a narrow row
 * does to it: everything inside — the three levels of clamp — is the code
 * under test, untouched. The reference is the runs' CONTENT width, measured
 * with the element opened up first, so the stages are relative to what the
 * text wants rather than to whatever the Lens happens to be wide enough for.
 */
/**
 * How much the callsign's head can give up before the squeeze reaches anything
 * else — its full content width, measured with the identity opened up.
 *
 * The stages below are relative to this rather than to absolute pixels. A
 * hardcoded "large" deficit is calibrated against one project name: the head
 * begins `<project>/`, and this fixture's project is a scratch repository whose
 * directory name is generated, so a fixed number that exhausted the head under
 * `tugtool/` is swallowed whole by a longer one. Measuring keeps "large" meaning
 * *past what the head can pay*, which is the claim the stage makes.
 */
const headContentWidth = (app: App): Promise<number> =>
  app.evalJS<number>(
    `(() => {
       const id = document.querySelector(${JSON.stringify(IDENTITY)});
       // The title-run wrapper ([D141]'s progress cluster seat) is a flex
       // container capped at the line's width; opened up too, or it shrinks
       // the identity during the measurement pass and every content width
       // under-reads.
       const wrap = id.closest(".session-identity-row-title-run");
       if (wrap !== null) {
         wrap.style.maxWidth = "none";
         wrap.style.width = "max-content";
       }
       id.style.maxInlineSize = "none";
       id.style.width = "3000px";
       void id.getBoundingClientRect();
       const head = id.querySelector(".tug-session-identity-callsign-head");
       return head === null ? 0 : Math.ceil(head.scrollWidth);
     })()`,
  );

const squeeze = (app: App, deficit: number): Promise<RunWidths> =>
  app.evalJS<RunWidths>(
    `(() => {
       const id = document.querySelector(${JSON.stringify(IDENTITY)});
       const run = id.querySelector(".tug-session-identity-run");
       // Open the title-run wrapper as well — see headContentWidth.
       const wrap = id.closest(".session-identity-row-title-run");
       if (wrap !== null) {
         wrap.style.maxWidth = "none";
         wrap.style.width = "max-content";
       }
       id.style.maxInlineSize = "none";
       id.style.width = "3000px";
       void id.getBoundingClientRect();
       let content = 0;
       for (const child of run.children) content += child.scrollWidth;
       id.style.width = (content - ${deficit}) + "px";
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
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0439-identity-elision",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace, so the dash reaches the aggregate — which is
        // where the identity's dash marker finds it. The bind is then the real
        // verb through the card's own shell route, not a seeded ledger field.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        await shellAndSettle(app, `${tugutilPath(CHECKOUT)} dash bind ${DASH_NAME}`);

        // The name and the callsign arrive the way a real rename and a real
        // mint do — on a `session_updated` push. A ledger seed alone leaves
        // the identity on its short-id fallback, and the whole grammar has to
        // be present at once for an elision order to mean anything.
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishSessionUpdated(${JSON.stringify(
              JSON.stringify({
                session_id: SID,
                fields: { name: NAME, name_user_set: true, tag: TAG },
              }),
            )})`,
          ),
        ).toBe(true);
        // The collision: a second session takes the same custom name, which
        // is what makes the callsign run render beside it at all ([D141]).
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishSessionUpdated(${JSON.stringify(
              JSON.stringify({
                session_id: OTHER_SID,
                fields: { name: NAME, name_user_set: true, tag: "other-elide-1" },
              }),
            )})`,
          ),
        ).toBe(true);

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
        // Past everything the head has to give, so the deficit must reach the
        // name — whatever this run's project directory happens to be called.
        const large = await squeeze(app, (await headContentWidth(app)) + 60);
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
