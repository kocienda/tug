/**
 * AT0445 — the decision arrives once, on the card that would act on it.
 *
 * ## Why this exists
 *
 * The arc's whole shape is *the machine works first, the user decides once*.
 * The machine half is at0441's. This is the deciding half, and it is the part
 * with a failure mode that no unit test can reach: an ask that arrives twice
 * is worse than an ask that never arrives, because the second one teaches the
 * reader to dismiss the first without reading it.
 *
 * So four claims, and three of them are about **not** asking:
 *
 * - A built, reconciled, green dash **bound to this card's session** raises
 *   the prompt. That is the ask.
 * - "Not yet" dismisses it, and the dismissal is durable — the mark is
 *   `branch.tugdash/<n>.tugjoinprompted`, not a client memory ([P07]).
 * - **A base move that reconciles to the same decision raises nothing.** The
 *   dash is re-reconciled and re-checked, the shas all change, and the ask
 *   stays down — because the re-ask policy keys on the *decision*, not on the
 *   heads. This is the assertion the whole policy exists for.
 * - **A change that makes the checks red raises a new one.** The decision
 *   genuinely changed, and a dismissal of "this builds — join it?" is not an
 *   answer to "this does not build — join it anyway?".
 *
 * And one about reach: an **unbound** dash, built and green in the same
 * repository at the same moment, raises nothing at all. The prompt is a fact
 * on the feed for every dash; the sheet is a surface on the card that would do
 * the joining. A deck that raised a modal for a dash nobody here is working
 * would be the shade's thicket rebuilt as an interruption.
 *
 * ## The fixture
 *
 * One scratch repository, two dashes, neither conflicting with the base — the
 * pilot reconciles and checks both without being asked, which is what makes
 * the prompt the *only* thing this file drives. Tier 0 is a sentinel grep, so
 * flipping it red is a one-line commit on the base rather than a toolchain.
 *
 * @covers tugdeck/src/components/tugways/cards/join-prompt-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_pilot.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugdash-core/src/verify.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  commitRound,
  createDash,
  gitRetry as git,
  makeDashScratchRepo,
  markDashBuilt,
  rmScratchSession,
  seedScratchSession,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 420_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000445";
/** The sheet itself, wherever the card's sheet host mounts it. */
const PROMPT = '[data-slot="join-prompt-sheet"]';
/** Its whole text. The question, the three options and their descriptions are
 *  all the server's words, so reading the sheet entire is reading the ask. */
const PROMPT_QUESTION = PROMPT;
const promptOption = (label: string): string =>
  `${PROMPT} .session-question-dialog-options-list [data-option-label="${label}"]`;
const PROMPT_SUBMIT = `${PROMPT} .session-question-dialog-actionbar-buttons .tug-button-primary-action`;

const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';
const lensRegister = (dash: string): string =>
  `${LENS_SECTION} [data-slot="lens-dashes-row"][data-dash="${dash}"] [data-slot="dash-join-register"]`;

/** The bound dash — the one this card would join. */
const DASH = "at0445-bound";
/** The other one, in the same repo, at the same stage, bound to nobody. */
const QUIET_DASH = "at0445-quiet";

/** The checkout whose built binaries the fixture drives. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

/** What Tier 0 greps for, and what a base commit can take away. */
const CONFIG_GREEN = '[tugtool.dash]\nverify_tier0 = ["true"]\n';
const CONFIG_RED = '[tugtool.dash]\nverify_tier0 = ["false"]\n';

let scratch = "";
let dataRoot = "";
let fixtureDir = "";
let dashId = "";
let cli: { binaryRoot?: string; env?: Record<string, string> } = {};

beforeAll(() => {
  if (!SHOULD_RUN) return;
  const base = makeDashScratchRepo({
    prefix: "at0445",
    checkout: CHECKOUT,
    files: { ".tugtool/config.toml": CONFIG_GREEN },
  });
  scratch = base.repo;
  dataRoot = base.dataRoot;
  cli = base.cli;

  // Two dashes, each touching a file of its own, so neither conflicts with the
  // base or with the other. The arc they walk is the quiet one — reconcile,
  // check, ready — which is exactly the state the prompt asks about.
  const bound = createDash(scratch, DASH, "at0445 bound-dash fixture", cli);
  writeFileSync(join(bound.worktree, "bound.txt"), "at0445 the bound dash's file\n");
  commitRound(scratch, DASH, "at0445(round): the bound dash's work", cli);
  dashId = bound.id;

  const quiet = createDash(scratch, QUIET_DASH, "at0445 unbound-dash fixture", cli);
  writeFileSync(join(quiet.worktree, "quiet.txt"), "at0445 the unbound dash's file\n");
  commitRound(scratch, QUIET_DASH, "at0445(round): the unbound dash's work", cli);

  markDashBuilt(scratch, DASH, cli);
  markDashBuilt(scratch, QUIET_DASH, cli);

  fixtureDir = seedScratchSession(scratch, SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  if (dataRoot !== "") rmSync(dataRoot, { recursive: true, force: true });
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

/** Click, scrolling into view first — the sheet is a scrolling panel. */
async function revealAndClick(app: App, selector: string): Promise<void> {
  await app.evalJS<null>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el !== null) el.scrollIntoView({ block: "center" });
      return null;
    })()`,
  );
  await settle(250);
  await app.nativeClickAtElement(selector);
}

/** Whether the prompt sheet is up right now. */
function promptUp(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(PROMPT)}) !== null`,
  );
}

/**
 * Watch for a prompt across a window, and answer whether one ever appeared.
 *
 * Sampled rather than checked once at the end: the failure this file is about
 * is an ask that flashes up and is superseded, which a single late read would
 * report as silence.
 */
async function promptAppearsWithin(app: App, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await promptUp(app)) return true;
    await settle(500);
  }
  return false;
}

/** Wait for a dash's Lens register to reach a word — the arc, without a gesture. */
async function registerReaches(
  app: App,
  dash: string,
  word: string,
  timeoutMs: number,
): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(lensRegister(dash))})?.getAttribute("data-word") === ${JSON.stringify(word)}`,
    { timeoutMs },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0445: the join prompt asks once", () => {
  test(
    "a bound green dash asks, a dismissal holds across a base move, a red decision asks again, and an unbound dash never asks at all",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0445-join-prompt",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: dataRoot },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: scratch });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // The Lens stays up for the whole run: it is where the arc is read
        // from without touching either dash, and the sheet mounts on the card
        // rather than in it, so the two do not contend.
        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector('${LENS_SECTION} [data-slot="lens-dashes-row"][data-dash="${DASH}"]') !== null`,
          { timeoutMs: 40000 },
        );

        // ── The bind, and the ask it earns ────────────────────────────────
        // Bound first, so the ask has a card to arrive on. Both dashes reach
        // the same state; only this one is this card's.
        await app.dispatchControlAction("bind_dash_ok", {
          tug_session_id: SID,
          dash_id: dashId,
          dash_name: DASH,
        });
        await registerReaches(app, DASH, "ready", 240000);
        await registerReaches(app, QUIET_DASH, "ready", 240000);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROMPT)}) !== null`,
          { timeoutMs: 60000 },
        );
        const asked = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(PROMPT_QUESTION)})?.textContent || "")`,
        );
        note(`at0445 asked: ${JSON.stringify(asked)}`);
        // The server's own sentence, about this dash and no other.
        expect(asked, "the ask names the dash it is about").toContain(DASH);
        expect(asked, "and the unbound one is not what it is asking about").not.toContain(
          QUIET_DASH,
        );
        expect(asked, "a green decision asks the green question").toContain("join it?");

        // ── "Not yet" ─────────────────────────────────────────────────────
        await revealAndClick(app, promptOption("Not yet"));
        await settle(300);
        await revealAndClick(app, PROMPT_SUBMIT);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROMPT)}) === null`,
          { timeoutMs: 15000 },
        );
        // The dismissal is durable, and durable means git — not a store the
        // next recompute would forget.
        const mark = git(
          scratch,
          "config",
          "--get",
          `branch.tugdash/${DASH}.tugjoinprompted`,
        ).trim();
        expect(mark, "the dismissal is a fact about the dash").toBe("clean");
        note("at0445 dismissed: the ask went down and the mark went in");

        // ── The base moves, and the ask stays down ────────────────────────
        // Everything the request id is built from changes: the base sha moves,
        // the dash is reconciled again, the candidate is rebuilt, and Tier 0
        // runs again over a genuinely different tree. The one thing that does
        // not change is the *decision* — and that is what the policy keys on.
        writeFileSync(join(scratch, "base-move.txt"), "at0445 the base moved\n");
        git(scratch, "add", "-A");
        git(scratch, "commit", "-m", "at0445: the base moves under a dismissed ask");
        // Waited on rather than assumed: the point is that a full re-run of
        // the arc — not merely a quiet minute — leaves the ask down.
        await registerReaches(app, DASH, "ready", 240000);
        expect(
          await promptAppearsWithin(app, 15000),
          "a same-decision base move re-reconciles in silence",
        ).toBe(false);
        note("at0445 quiet: the base moved, the arc re-ran, and nothing asked again");

        // ── The decision changes, and the ask comes back ──────────────────
        // Tier 0 stops passing. That is a different question — a dismissal of
        // "this builds, join it?" is not an answer to "this does not build".
        writeFileSync(join(scratch, ".tugtool", "config.toml"), CONFIG_RED);
        git(scratch, "add", "-A");
        git(scratch, "commit", "-m", "at0445: the joined tree stops building");
        await registerReaches(app, DASH, "checks-red", 300000);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROMPT)}) !== null`,
          { timeoutMs: 90000 },
        );
        const reasked = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(PROMPT_QUESTION)})?.textContent || "")`,
        );
        note(`at0445 re-asked: ${JSON.stringify(reasked)}`);
        expect(reasked, "the new ask is about the new decision").toContain(
          "does not build",
        );

        // ── And the unbound dash asked nothing, the whole way through ─────
        // It reached the same states at the same times. What it never had was
        // a card that would act on the answer.
        expect(
          await app.evalJS<boolean>(
            `(document.querySelector(${JSON.stringify(PROMPT_QUESTION)})?.textContent || "").indexOf(${JSON.stringify(QUIET_DASH)}) === -1`,
          ),
          "no ask on screen is about the dash nobody is working",
        ).toBe(true);
        // Read with a bare spawn rather than the throwing helper: the assertion
        // is that the key is ABSENT, and `git config --get` answers that with a
        // non-zero exit.
        expect(
          Bun.spawnSync(
            [
              "git",
              "-C",
              scratch,
              "config",
              "--get",
              `branch.tugdash/${QUIET_DASH}.tugjoinprompted`,
            ],
            {},
          ).exitCode,
          "and nothing was ever dismissed on it, because nothing was ever asked",
        ).not.toBe(0);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
