/**
 * at0469-dash-entry-points.test.ts — a surface that shows a dash lets you act
 * on one.
 *
 * Two gestures, both of which were missing while every fact about a dash was
 * already on screen.
 *
 * **Activating a dash row opens the dash's room.** It fronts the card
 * working the dash and reveals that card's Changes shade — the one surface
 * where a decision about a dash is made ([D152]). The dispatch is the part
 * worth pinning rather than inspecting: `sendToTarget` walks the responder
 * chain *upward* from its target, so a `reveal-changes` aimed at the bare card
 * id would be swallowed in silence by `card-host`, with no error to observe.
 * The first draft of this work made exactly that mistake. A row with no open
 * worker card is the other half: it does nothing, and — because a dead click
 * on something that looked live is the failure the affordance rule exists for
 * — it does not present as activatable either.
 *
 * **A diverged dash can be replayed by hand, and the answer is always
 * audible.** The base-motion engine replays a dash when the base moves, but
 * its gate skips a repository with autoreplay off, which is what every fixture
 * dash here is. So Replay is offered whenever the dash is diverged — bound
 * or not, since boundness has no part in that gate. No outcome shows itself on
 * the row — the lifecycle line carries the dash's standing, not the checkout's
 * git bookkeeping — so every one of the five reports on the card's pane
 * bulletin, and both halves are asserted here: the replay that moves the
 * rounds, and the press afterwards that moves nothing.
 *
 * Everything is real: a scratch repository this file owns, real dashes, a real
 * base commit moving underneath one of them, and the real `changeset_replay`
 * round trip. No dash is ever cut in the developer's checkout.
 *
 * @covers tugdeck/src/components/dashes/dashes-card.tsx
 * @covers tugdeck/src/components/dashes/dashes-card.css
 * @covers tugdeck/src/components/tugways/cards/session-changes/dash-row-menu.tsx
 * @covers tugdeck/src/components/tugways/cards/dash-replay-notice-controller.tsx
 * @covers tugdeck/src/lib/dash-replay-outcome-store.ts
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugdeck/src/components/tugways/action-vocabulary.ts
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  openDashRowMenu,
  closeDashRowMenu,
  pressDashRowMenuItem,
  readDashRowMenu,
} from "./dash-row-menu-fixture";
import {
  bindDash,
  commitRound,
  createDash,
  gitRetry,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000469";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

/** The dash the session holds — the row that has a room to open. */
const HELD = "at0469-held";
/** A dash nobody in this instance is working — the inert row. */
const IDLE = "at0469-idle";
/** A dash whose base moved under it — the row with a replay to offer. */
const BEHIND = "at0469-behind";
/** A dash whose round collides with that base move — the replay that refuses. */
const CLASH = "at0469-clash";

const SECTION = '.dashes-section';
const dashRow = (dash: string): string =>
  `${SECTION} [data-slot="dashes-row"][data-dash="${dash}"]`;

const BULLETIN = ".tug-pane-bulletin";
const BULLETIN_TITLE = `${BULLETIN} [data-title]`;
const BULLETIN_DESC = `${BULLETIN} [data-description]`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/** The file the base and the diverged dash both move. */
const SHARED_FILE = "at0469-shared.txt";
const SHARED_BASE = "at0469 the line both sides start from\n";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({
    prefix: "at0469",
    checkout: CHECKOUT,
    files: { [SHARED_FILE]: SHARED_BASE },
  });

  createDash(projectDir(), HELD, "at0469 the held dash", scratch.cli);
  createDash(projectDir(), IDLE, "at0469 the idle dash", scratch.cli);

  // The diverged one: a round of its own, then the base moves past it. Two
  // different files, so the replay is clean rather than conflicted — this is
  // the outcome that MOVES something, and the row's own facts are the receipt.
  const behind = createDash(projectDir(), BEHIND, "at0469 the behind dash", scratch.cli);
  writeFileSync(join(behind.worktree, "at0469-dash-only.txt"), "the dash's own line\n");
  commitRound(
    projectDir(),
    BEHIND,
    "at0469(round): the dash adds a file of its own",
    scratch.cli,
  );
  // And one whose round rewrites the very line the base is about to rewrite,
  // so its replay stops conflicted — the outcome that runs, reports, and moves
  // nothing a row could show.
  const clash = createDash(projectDir(), CLASH, "at0469 the clashing dash", scratch.cli);
  writeFileSync(join(clash.worktree, SHARED_FILE), "at0469 the dash's version\n");
  commitRound(
    projectDir(),
    CLASH,
    "at0469(round): the dash rewrites the shared line",
    scratch.cli,
  );

  writeFileSync(join(projectDir(), SHARED_FILE), `${SHARED_BASE}the base moved on\n`);
  gitRetry(projectDir(), "add", "-A");
  gitRetry(projectDir(), "commit", "-m", "at0469: the base moves ahead");

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

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** Bring the card up, spawn its session, and open the Dashes rail. */
async function openDashesRail(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  // A *spawned* session, not a bound one: spawning registers the scratch repo
  // as a workspace, so its dashes reach the aggregate.
  await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
  await app.awaitEngineReady("A", { timeoutMs: 15000 });
  await app.dispatchControlAction("toggle-dashes");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SECTION)}) !== null`,
    { timeoutMs: 20000 },
  );
}

/** Scroll a row into view and click it, the way the section's other tests do. */
async function clickRow(app: App, row: string): Promise<void> {
  await app.evalJS<null>(
    `(() => {
       const el = document.querySelector(${JSON.stringify(row)});
       if (el !== null) el.scrollIntoView({ block: "center" });
       return null;
     })()`,
  );
  await settle(250);
  await app.nativeClickAtElement(row);
}

describe.skipIf(!SHOULD_RUN)("AT0469: acting on a dash from a surface that shows one", () => {
  test(
    "a dash row opens its worker's Changes shade; a row with no worker is inert",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0469-dash-row-opens-the-room",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await openDashesRail(app);
        bindDash(projectDir(), HELD, SID, scratch?.cli ?? {});

        // The held row waits for the binding to reach the aggregate — the atom
        // is the positive signal, and it is also what makes the row a door.
        await app.waitForCondition<boolean>(
          `document.querySelector('${dashRow(HELD)} [data-slot="tug-dash-lifecycle-worker"]') !== null`,
          { timeoutMs: 30000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(dashRow(IDLE))}) !== null`,
          { timeoutMs: 30000 },
        );

        // ── What each row advertises about itself ──────────────────────────
        const affordance = await app.evalJS<{ held: string | null; idle: string | null }>(
          `(() => {
             const read = (sel) =>
               document.querySelector(sel)?.getAttribute("data-activatable") ?? null;
             return {
               held: read(${JSON.stringify(dashRow(HELD))}),
               idle: read(${JSON.stringify(dashRow(IDLE))}),
             };
           })()`,
        );
        note("at0469 row affordances", JSON.stringify(affordance));
        expect(affordance.held).toBe("true");
        // Nobody is working it here, so there is no room to open — and the row
        // says so before the press rather than after.
        expect(affordance.idle).toBeNull();

        // The shade is closed to begin with: no join stands on these
        // dashes, so nothing has revealed itself.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          ),
        ).toBe(true);

        // ── The inert row does nothing ─────────────────────────────────────
        await clickRow(app, dashRow(IDLE));
        await settle(600);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          ),
        ).toBe(true);
        note("at0469 the idle row opened nothing, as it advertised");

        // ── The held row opens the room ────────────────────────────────────
        // This is the assertion the silent-dispatch defect would fail: an
        // action sent to the wrong responder scope produces no error, just a
        // shade that never comes up.
        await clickRow(app, dashRow(HELD));
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 15000 },
        );
        note("at0469 dash row opened the shade", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a diverged dash offers Replay, and its outcome is never silent",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0469-replay-from-the-row-menu",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await openDashesRail(app);
        // Bound, deliberately: the outcome notice reports on the card, and
        // binding is also what makes this the case [P03] was wrong about —
        // a *bound* diverged dash the engine will never touch, because this
        // repository's dashes have autoreplay off.
        bindDash(projectDir(), BEHIND, SID, scratch?.cli ?? {});
        await app.waitForCondition<boolean>(
          `document.querySelector('${dashRow(BEHIND)} [data-slot="tug-dash-lifecycle-worker"]') !== null`,
          { timeoutMs: 30000 },
        );

        // ── The verb is offered, on a bound row, naming its destination ────
        // A live Replay item IS the row's knowledge that it is behind: the
        // predicate reads the same divergence the line no longer prints.
        const menu = await readDashRowMenu(app, dashRow(BEHIND));
        note("at0469 behind-row menu", JSON.stringify(menu));
        expect(menu.replay.present).toBe(true);
        expect(menu.replay.disabled).toBe(false);
        expect(menu.replay.label).toContain("Replay onto");

        // The disabled half of the predicate is asserted at the end of this
        // test, on a dash that has just replayed: every dash in this fixture is
        // behind the moment the base moves, so there is no row here that is
        // born current. The predicate's whole truth table is a unit test.

        // ── The press moves the rounds ─────────────────────────────────────
        // The bulletin is the receipt. A replay that moves the rounds changes
        // nothing any dash row prints — the line carries the dash's standing,
        // not the checkout's git bookkeeping — so success speaks here or it
        // does not speak at all.
        await pressDashRowMenuItem(app, dashRow(BEHIND), "request-replay-dash");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BULLETIN)}) !== null`,
          { timeoutMs: 30000 },
        );
        const landed = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(BULLETIN_TITLE)})?.textContent ?? "")`,
        );
        note("at0469 the replay's own bulletin", landed);
        expect(landed).toContain(BEHIND);

        // ── A second press moves nothing — and still speaks ────────────────
        // This is the dead-button guard. The dash is current now, so the item
        // is disabled with its reason in the label rather than offering a
        // press whose answer nothing on the row could show ([L31]).
        // The bulletin speaks the moment the server answers, while the
        // aggregate the predicate reads recomputes on its own beat — so the
        // reading is taken until it catches up rather than once.
        let afterwards = { disabled: false, label: "" };
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          await openDashRowMenu(app, dashRow(BEHIND));
          afterwards = await app.evalJS<{ disabled: boolean; label: string }>(
            `(() => {
               const el = document.querySelector('[data-slot="tug-editor-context-menu"] [data-item-action="request-replay-dash"]');
               return {
                 disabled: el !== null && el.hasAttribute("data-disabled"),
                 label: el === null ? "" : (el.textContent || ""),
               };
             })()`,
          );
          await closeDashRowMenu(app);
          if (afterwards.disabled) break;
          await settle(1000);
        }
        note("at0469 replay after replaying", JSON.stringify(afterwards));
        expect(afterwards.disabled).toBe(true);
        expect(afterwards.label).toContain("already current with");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a replay that moves nothing reports on the card's bulletin",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0469-replay-outcome-speaks",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        // Bound, because the notice is the card's: the controller reports for
        // the session this card holds.
        bindDash(projectDir(), CLASH, SID, scratch?.cli ?? {});

        // Driven from the SHADE rather than the rail, deliberately. The shade's
        // press carries its own card's session id with no dependence on which
        // card the rail happens to be following, so what is under test here is
        // the outcome's voice rather than the rail's focus bookkeeping.
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape");
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 15000 },
        );
        const shadeRow = `${SHEET} [data-slot="session-changes-dash-row"][data-dash="${CLASH}"]`;
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(shadeRow)}) !== null`,
          { timeoutMs: 30000 },
        );

        // The dash is behind its base, so the verb is live — the client cannot
        // know the replay will conflict, and it is not its business to guess.
        const menu = await readDashRowMenu(app, shadeRow);
        note("at0469 clash-row menu", JSON.stringify(menu));
        expect(menu.replay.present).toBe(true);
        expect(menu.replay.disabled).toBe(false);

        // The press runs a real replay that stops at the conflicting round and
        // touches nothing. Every fact on the row is byte-identical afterwards,
        // which is exactly why the answer has to arrive somewhere else.
        await pressDashRowMenuItem(app, shadeRow, "request-replay-dash");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BULLETIN)}) !== null`,
          { timeoutMs: 20000 },
        );
        const spoken = await app.evalJS<{ title: string; description: string; tone: string | null }>(
          `(() => {
             const b = document.querySelector(${JSON.stringify(BULLETIN)});
             return {
               title: (document.querySelector(${JSON.stringify(BULLETIN_TITLE)})?.textContent ?? ""),
               description: (document.querySelector(${JSON.stringify(BULLETIN_DESC)})?.textContent ?? ""),
               tone: b?.getAttribute("data-type") ?? null,
             };
           })()`,
        );
        note("at0469 the outcome spoke", JSON.stringify(spoken));
        expect(spoken.title).toContain(CLASH);
        // The description names the round it stopped at and the path it stopped
        // on — the only text that makes this refusal readable.
        expect(spoken.description).toContain(SHARED_FILE);
        expect(spoken.description).toContain("Nothing was touched");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
