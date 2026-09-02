/**
 * at0438-unbound-dashes.test.ts — the Arcs card is always on, and
 * binding flips a row's register instead of removing it.
 *
 * The card used to hold only unbound dashes and to vanish entirely at zero
 * — the partition law, and the coming-and-going was the wart: a surface with
 * no fixed address cannot be glanced at. Under [D141] it holds EVERY dash in
 * every state, so what a
 * bind changes is the row's EYEBROW: the Bind and Discard verbs give way to
 * the worker's mini atom (the session's display name behind its live dot —
 * no callsign, no dash run, because the row already names the dash), and an
 * unbind takes it away again. The verbs themselves live behind the row's `⋯`,
 * in the Changes shade's own menu grammar, so what a bind changes in the menu
 * is whether Bind is offered at all.
 *
 * That is what this drives, as one round trip against the real app: bind, and
 * the row STAYS — card, row, and all — wearing the worker's atom, while the
 * session's own Cards row grows its title cluster; unbind, and the atom
 * leaves. Then Bind is pressed for real, out of the menu: it sends the same
 * `bind_dash` frame the Changes shade sends, and the register flips because
 * `bound_sessions`
 * moved in the account-global aggregate, not because the click did anything
 * local.
 *
 * Everything is real. `tugtool arc bind` / `unbind` run through the card's
 * own `$` shell route — the route that stamps `TUG_SESSION_ID`.
 *
 * The dash lives in a scratch repository this file owns — a dash is for
 * implementing a plan, not for running a test, so no fixture ever cuts one in
 * the checkout somebody is working in.
 *
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/components/arcs/arcs-card.css
 * @covers tugdeck/src/components/arcs/arcs-card-registration.tsx
 * @covers tugdeck/src/components/tugways/followed-card.ts
 * @covers tugdeck/src/components/tugways/arc-sigil.tsx
 * @covers tugdeck/src/components/tugways/arc-lifecycle-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/arc-row-menu.tsx
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
  pressDashRowMenuItem,
  readDashRowMenu,
} from "./dash-row-menu-fixture";
import {
  createDash,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  shellAndSettle,
  tugtoolPath,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000438";
const CARD = '[data-card-id="A"]';

const DASH_NAME = "at0438-unbound";

const SECTION = '.dashes-section';
const ROW = `${SECTION} [data-slot="dashes-row"][data-dash="${DASH_NAME}"]`;
const ROW_ATOM = `${ROW} [data-slot="tug-dash-lifecycle-name"]`;
/* The eyebrow's own children — the identities, and nothing else. A dash
   row carries no opener: its verbs answer the row's right-click. */
const EYEBROW_VERBS = `${ROW} [data-slot="tug-dash-lifecycle-eyebrow"] button`;
const WORKER = `${ROW} [data-slot="tug-dash-lifecycle-worker"]`;

const CARDS = '.cards-card';
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
 * Press the row's Bind item until `expected` appears — the shape at0405 uses,
 * for the same reason. The Dashes list recomposes on the aggregate's own
 * schedule, so a click's coordinates can go stale between the aim and the
 * press. A missed press changes nothing, so re-aiming is safe.
 */
async function pressUntil(
  app: App,
  row: string,
  expected: string,
  attempts = 4,
): Promise<void> {
  const predicate = `document.querySelector(${JSON.stringify(expected)}) !== null`;
  for (let i = 0; i < attempts; i += 1) {
    await settle();
    await pressDashRowMenuItem(app, row, "bind-dash");
    try {
      await app.waitForCondition<boolean>(predicate, { timeoutMs: 3000 });
      return;
    } catch {
      note(`at0438 bind press did not land (attempt ${i + 1})`);
    }
  }
  throw new Error(`at0438: ${expected} never appeared after pressing Bind`);
}

describe.skipIf(!SHOULD_RUN)("AT0438: the always-on Arcs card", () => {
  test(
    "binding flips the eyebrow's register; the card never leaves",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0438-unbound-dashes",
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

        // The Cards card, not a rail in general: the session row this file
        // reads from the DOM is one of its rows.
        await app.dispatchControlAction("toggle-cards");
        // Both rails, and Dashes on top: the Cards section is read from the
        // DOM behind it, while every press this file makes lands on a dash
        // row. Then A is raised, which is the gesture that gives the Dashes
        // card a followed card — without it Bind correctly refuses ([L31]).
        await app.dispatchControlAction("toggle-arcs");
        await app.evalJS<null>(`(window.__tug.activateCard("A"), null)`);
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
          eyebrowButtons: number;
          workers: number;
          bound: string | null;
        }>(
          `(() => {
             const atom = document.querySelector(${JSON.stringify(ROW_ATOM)});
             const row = document.querySelector(${JSON.stringify(ROW)});
             return {
               atom: (atom?.textContent ?? "").trim(),
               eyebrowButtons: document.querySelectorAll(${JSON.stringify(EYEBROW_VERBS)}).length,
               workers: document.querySelectorAll(${JSON.stringify(WORKER)}).length,
               bound: row?.getAttribute("data-bound") ?? null,
             };
           })()`,
        );
        note("at0438 unbound row", JSON.stringify(unbound));
        // The name wears its sigil here too — a dash is named one way
        // everywhere.
        expect(unbound.atom).toBe(`^${DASH_NAME}`);
        expect(unbound.eyebrowButtons).toBe(0);
        expect(unbound.workers).toBe(0);
        expect(unbound.bound).toBeNull();
        // Bind is on the row's right-click, in the shade's own grammar.
        // Whether it is available depends on the card having a followed card,
        // which is a
        // fact about focus rather than about this row — so what is asserted
        // here is that the verb is offered and that a blocked one says why
        // ([L31]), never a bare disabled word.
        const unboundMenu = await readDashRowMenu(app, ROW);
        note("at0438 unbound menu", JSON.stringify(unboundMenu));
        expect(unboundMenu.bind.present).toBe(true);
        if (unboundMenu.bind.disabled) {
          expect(unboundMenu.bind.label).toContain("—");
        }
        expect(unboundMenu.discard.present).toBe(true);
        // And Replay is here on an unbound row, disabled with its reason: a
        // freshly created dash is current with its base.
        expect(unboundMenu.replay.present).toBe(true);
        expect(unboundMenu.replay.label).toContain("already current with");
        // And the session is NOT working it, so no title cluster on its row.
        expect(await count(app, PROGRESS)).toBe(0);
        note("at0438 dashes card, unbound register", (await app.screenshot()).path);

        // ── Bind: the row STAYS and the worker's atom takes the eyebrow ───
        await shellAndSettle(app, `${tugtoolPath(CHECKOUT)} arc bind ${DASH_NAME}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(WORKER)}) !== null`,
          { timeoutMs: 30000 },
        );
        const bound = await app.evalJS<{
          rows: number;
          eyebrowButtons: number;
          boundFlag: string | null;
          workerDots: number;
          workerDashRuns: number;
          pillInset: number;
          workerInset: number;
        }>(
          `(() => {
             const worker = document.querySelector(${JSON.stringify(WORKER)});
             const row = document.querySelector(${JSON.stringify(ROW)});
             return {
               rows: document.querySelectorAll(${JSON.stringify(ROW)}).length,
               eyebrowButtons: document.querySelectorAll(${JSON.stringify(EYEBROW_VERBS)}).length,
               boundFlag: row?.getAttribute("data-bound") ?? null,
               workerDots: worker?.querySelectorAll('[data-slot="tug-progress-indicator"]').length ?? 0,
               // The worker atom carries NO dash run: the eyebrow's leading
               // atom already names the dash, and saying it twice on one line
               // is the drift [D141] closes.
               workerDashRuns: worker?.querySelectorAll('[data-slot="session-identity-dash"]').length ?? 0,
               // The two identities' margins, which the eye reads as one pair.
               // The list row reserves a leading focus gutter its trailing
               // edge does not, and the Dashes row takes that gutter back so
               // the eyebrow does not lean right.
               pillInset:
                 row.querySelector('[data-slot="tug-dash-atom"]').getBoundingClientRect().left -
                 row.getBoundingClientRect().left,
               workerInset:
                 row.getBoundingClientRect().right -
                 worker.getBoundingClientRect().right,
             };
           })()`,
        );
        note("at0438 bound row", JSON.stringify(bound));
        expect(bound.rows).toBe(1);
        // The eyebrow stays the identities alone, held or not — and the menu
        // the row's right-click opens offers no Bind now that the dash is
        // held. Unbind is deliberately not here either: it belongs to the
        // worker's own shade.
        expect(bound.eyebrowButtons).toBe(0);
        const boundMenu = await readDashRowMenu(app, ROW);
        note("at0438 bound menu", JSON.stringify(boundMenu));
        expect(boundMenu.bind.present).toBe(false);
        expect(boundMenu.unbind.present).toBe(false);
        expect(bound.boundFlag).toBe("true");
        expect(bound.workerDots).toBe(1);
        expect(bound.workerDashRuns).toBe(0);
        expect(
          Math.abs(bound.pillInset - bound.workerInset),
          "the dash pill and the worker atom sit the same distance in",
        ).toBeLessThanOrEqual(1);
        // The band did not move: always on is the whole point.
        expect(await count(app, SECTION)).toBe(1);
        // And the session's Cards row grew its title cluster.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROGRESS)}) !== null`,
          { timeoutMs: 30000 },
        );
        note("at0438 dashes card, bound register", (await app.screenshot()).path);

        // ── Unbind: the worker's atom leaves the eyebrow ──────────────────
        await shellAndSettle(app, `${tugtoolPath(CHECKOUT)} arc unbind`, 1);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(WORKER)}) === null`,
          { timeoutMs: 30000 },
        );
        expect(await count(app, PROGRESS)).toBe(0);
        expect(await count(app, ROW)).toBe(1);

        // ── Bind again, through the row's own menu ────────────────────────
        // The press sends `bind_dash`; the register flips because
        // `bound_sessions` moved in the aggregate, not because the click did
        // anything local.
        await pressUntil(app, ROW, WORKER);
        expect(await count(app, SECTION)).toBe(1);
        expect(await count(app, ROW)).toBe(1);
        expect(await count(app, WORKER)).toBe(1);

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
