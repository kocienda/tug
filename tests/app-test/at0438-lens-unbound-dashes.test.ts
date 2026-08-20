/**
 * at0438-lens-unbound-dashes.test.ts — the Dashes section is always on, and
 * binding flips a row's register instead of removing it.
 *
 * The section used to hold only unbound dashes and to vanish entirely at zero
 * — the partition law, and the coming-and-going was the wart: no other Lens
 * section works that way, and a band with no fixed address cannot be glanced
 * at. Under [D141] the section holds EVERY dash in every state, so what a
 * bind changes is the row's EYEBROW: the Bind and Discard verbs give way to
 * the worker's mini atom (the session's display name behind its live dot —
 * no callsign, no dash run, because the row already names the dash), and an
 * unbind brings the verbs back.
 *
 * That is what this drives, as one round trip against the real app: bind, and
 * the row STAYS — band, row, and all — wearing the worker's atom, while the
 * session's own Cards row grows its title cluster; unbind, and the verbs
 * return. Then Bind is pressed for real: it sends the same `bind_dash` frame
 * the Changes shade sends, and the register flips because `bound_sessions`
 * moved in the account-global aggregate, not because the click did anything
 * local.
 *
 * Everything is real. `tugutil dash bind` / `unbind` run through the card's
 * own `$` shell route — the route that stamps `TUG_SESSION_ID`.
 *
 * The dash lives in a scratch repository this file owns — a dash is for
 * implementing a plan, not for running a test, so no fixture ever cuts one in
 * the checkout somebody is working in.
 *
 * @covers tugdeck/src/components/lens/sections/dashes-section.tsx
 * @covers tugdeck/src/components/lens/sections/dashes-section.css
 * @covers tugdeck/src/components/lens/lens-content.tsx
 * @covers tugdeck/src/components/lens/lens-section-registry.ts
 * @covers tugdeck/src/components/tugways/dash-sigil.tsx
 * @covers tugdeck/src/components/tugways/dash-meta-line.tsx
 * @covers tugdeck/src/lib/dash-age.ts
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

const SID = "a7c0d1ea-0000-4000-8000-000000000438";
const CARD = '[data-card-id="A"]';

const DASH_NAME = "at0438-unbound";

const SECTION = '.lens-section[data-lens-section="dashes"]';
const ROW = `${SECTION} [data-slot="lens-dashes-row"][data-dash="${DASH_NAME}"]`;
const ROW_ATOM = `${ROW} [data-slot="lens-dashes-name"]`;
const BIND = `${ROW} [data-slot="lens-bind"]`;
const WORKER = `${ROW} [data-slot="lens-dashes-worker"]`;

const CARDS = '.lens-section[data-lens-section="cards"]';
const SESSION_ROW = `${CARDS} [data-session-id="${SID}"]`;
const PROGRESS = `${SESSION_ROW} [data-slot="session-identity-row-progress"]`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0438", checkout: CHECKOUT });
  createDash(projectDir(), DASH_NAME, "at0438 fixture", scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmDashScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
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

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

const count = (app: App, selector: string): Promise<number> =>
  app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );

/**
 * Click `target` until `expected` reaches `want`, scrolling it into view each
 * time — the shape at0405 uses, for the same reason. The Lens list recomposes
 * on the aggregate's own schedule, so a click's coordinates can go stale
 * between the aim and the press. A missed click changes nothing, so re-aiming
 * is safe.
 */
async function clickUntil(
  app: App,
  target: string,
  expected: string,
  want: "present" | "absent" = "present",
  attempts = 4,
): Promise<void> {
  const predicate =
    want === "present"
      ? `document.querySelector(${JSON.stringify(expected)}) !== null`
      : `document.querySelector(${JSON.stringify(expected)}) === null`;
  for (let i = 0; i < attempts; i += 1) {
    await app.evalJS<null>(
      `(() => {
         const el = document.querySelector(${JSON.stringify(target)});
         if (el !== null) el.scrollIntoView({ block: "center" });
         return null;
       })()`,
    );
    await settle();
    await app.nativeClickAtElement(target);
    try {
      await app.waitForCondition<boolean>(predicate, { timeoutMs: 3000 });
      return;
    } catch {
      note(`at0438 click on ${target} did not land (attempt ${i + 1})`);
    }
  }
  throw new Error(
    `at0438: ${expected} never went ${want} after clicking ${target}`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0438: the always-on Dashes section", () => {
  test(
    "binding flips the eyebrow's register; the section never leaves",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0438-lens-unbound-dashes",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning is what registers the
        // scratch repo as a workspace, so its dashes reach the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SESSION_ROW)}) !== null`,
          { timeoutMs: 20000 },
        );

        // ── Unbound: the verbs on the eyebrow, no worker, no cluster ──────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30000 },
        );
        const unbound = await app.evalJS<{
          atom: string;
          binds: number;
          workers: number;
          bound: string | null;
        }>(
          `(() => {
             const atom = document.querySelector(${JSON.stringify(ROW_ATOM)});
             const row = document.querySelector(${JSON.stringify(ROW)});
             return {
               atom: (atom?.textContent ?? "").trim(),
               binds: document.querySelectorAll(${JSON.stringify(BIND)}).length,
               workers: document.querySelectorAll(${JSON.stringify(WORKER)}).length,
               bound: row?.getAttribute("data-bound") ?? null,
             };
           })()`,
        );
        note("at0438 unbound row", JSON.stringify(unbound));
        // The name wears its sigil here too — a dash is named one way
        // everywhere.
        expect(unbound.atom).toBe(`^${DASH_NAME}`);
        expect(unbound.binds).toBe(1);
        expect(unbound.workers).toBe(0);
        expect(unbound.bound).toBeNull();
        // And the session is NOT working it, so no title cluster on its row.
        expect(await count(app, PROGRESS)).toBe(0);
        note("at0438 lens, unbound register", (await app.screenshot()).path);

        // ── Bind: the row STAYS and the worker's atom takes the eyebrow ───
        await shellAndSettle(app, `${tugutilPath(CHECKOUT)} dash bind ${DASH_NAME}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(WORKER)}) !== null`,
          { timeoutMs: 30000 },
        );
        const bound = await app.evalJS<{
          rows: number;
          binds: number;
          boundFlag: string | null;
          workerDots: number;
          workerDashRuns: number;
        }>(
          `(() => {
             const worker = document.querySelector(${JSON.stringify(WORKER)});
             const row = document.querySelector(${JSON.stringify(ROW)});
             return {
               rows: document.querySelectorAll(${JSON.stringify(ROW)}).length,
               binds: document.querySelectorAll(${JSON.stringify(BIND)}).length,
               boundFlag: row?.getAttribute("data-bound") ?? null,
               workerDots: worker?.querySelectorAll('[data-slot="tug-progress-indicator"]').length ?? 0,
               // The worker atom carries NO dash run: the eyebrow's leading
               // atom already names the dash, and saying it twice on one line
               // is the drift [D141] closes.
               workerDashRuns: worker?.querySelectorAll('[data-slot="session-identity-dash"]').length ?? 0,
             };
           })()`,
        );
        note("at0438 bound row", JSON.stringify(bound));
        expect(bound.rows).toBe(1);
        expect(bound.binds).toBe(0);
        expect(bound.boundFlag).toBe("true");
        expect(bound.workerDots).toBe(1);
        expect(bound.workerDashRuns).toBe(0);
        // The band did not move: always on is the whole point.
        expect(await count(app, SECTION)).toBe(1);
        // And the session's Cards row grew its title cluster.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROGRESS)}) !== null`,
          { timeoutMs: 30000 },
        );
        note("at0438 lens, bound register", (await app.screenshot()).path);

        // ── Unbind: the verbs come back ───────────────────────────────────
        await shellAndSettle(app, `${tugutilPath(CHECKOUT)} dash unbind`, 1);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BIND)}) !== null`,
          { timeoutMs: 30000 },
        );
        expect(await count(app, WORKER)).toBe(0);
        expect(await count(app, PROGRESS)).toBe(0);
        expect(await count(app, ROW)).toBe(1);

        // ── Bind again, through the row's own control ─────────────────────
        // The press sends `bind_dash`; the register flips because
        // `bound_sessions` moved in the aggregate, not because the click did
        // anything local.
        await clickUntil(app, BIND, WORKER);
        expect(await count(app, SECTION)).toBe(1);
        expect(await count(app, ROW)).toBe(1);
        expect(await count(app, BIND)).toBe(0);

        // The verbs unmounted under the pointer. Focus must not be stranded
        // on a detached node: an element removed from the document still
        // answers `document.activeElement` in WebKit for a beat, and a ring
        // on a node nobody can reach is how a "dead" keyboard starts.
        const focus = await app.evalJS<{
          connected: boolean;
          slot: string | null;
        }>(
          `(() => {
             const el = document.activeElement;
             if (el === null) return { connected: false, slot: null };
             return {
               connected: el.isConnected,
               slot: el.getAttribute("data-slot"),
             };
           })()`,
        );
        note("at0438 focus after the register flipped", JSON.stringify(focus));
        expect(focus.connected).toBe(true);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
