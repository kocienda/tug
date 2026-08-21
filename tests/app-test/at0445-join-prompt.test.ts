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
 * So five claims, and three of them are about **not** asking:
 *
 * - A reconciled, green dash **bound to this card's session** raises the
 *   prompt. That is the ask — and **nothing in this file ever marks a dash
 *   built** ([D147]). Both fixture dashes are plan-less, so a committed round
 *   on a clean worktree is the whole of what arms them. This is the negative
 *   that matters most: the arc used to sit dark behind a declaration a skill
 *   had to remember to make, and a `mark built` reintroduced here would hide
 *   that regression the moment it came back.
 * - **The sheet says what would land, and whose words those are.** With no
 *   draft written, the join would quietly land the branch description; the
 *   provenance line is where "quietly" stops. Write a draft and the next ask
 *   shows the author's words plainly, with no annotation — the *next* ask,
 *   because the sheet's message is a snapshot of the question it was raised
 *   for rather than a live view.
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
 * And one about reach: an **unbound** dash, with facts identical to the bound
 * one's in the same repository at the same moment, is left alone entirely.
 * Not merely unasked — unworked: the pilot reconciles and checks only dashes
 * bound to a live session, so the quiet dash's register never even reaches
 * `ready`, and its row says nothing at all rather than promising a check that
 * will never run. That is a stronger claim than the one this file used to make,
 * and a cheaper one to hold: with readiness derived rather than declared, an
 * unbounded pilot would turn a single commit on the base into one workspace
 * build per dash, every one of them spent on nobody.
 *
 * ## The fixture
 *
 * One scratch repository, two dashes, neither conflicting with the base and
 * neither ever marked. The bound one the pilot reconciles and checks without
 * being asked, which is what makes the prompt the *only* thing this file
 * drives; the unbound one is the control. Tier 0 is a sentinel grep, so
 * flipping it red is a one-line commit on the base rather than a toolchain.
 *
 * @covers tugdeck/src/components/tugways/cards/join-prompt-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/lib/dash-join-register.ts
 * @covers tugrust/crates/tugdash-core/src/dash.rs
 * @covers tugrust/crates/tugdash-core/src/ops.rs
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
  rmScratchSession,
  seedScratchSession,
  tugutil,
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
const lensRow = (dash: string): string =>
  `${LENS_SECTION} [data-slot="lens-dashes-row"][data-dash="${dash}"]`;
const lensRegister = (dash: string): string =>
  `${lensRow(dash)} [data-slot="dash-join-register"]`;

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

  const quiet = createDash(scratch, QUIET_DASH, "at0445 unbound-dash fixture", cli);
  writeFileSync(join(quiet.worktree, "quiet.txt"), "at0445 the unbound dash's file\n");
  commitRound(scratch, QUIET_DASH, "at0445(round): the unbound dash's work", cli);

  // No `dash mark built` anywhere, deliberately ([D147]). Both dashes are
  // plan-less, so a committed round on a clean worktree is the whole of what
  // arms them — which is the guarantee this file exists to hold: the arc must
  // not depend on a skill remembering to declare anything.

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

/** A dash's Lens register word right now, or null if it has none. */
function registerWord(app: App, dash: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `document.querySelector(${JSON.stringify(lensRegister(dash))})?.getAttribute("data-word") ?? null`,
  );
}

/**
 * Sample a dash's register across a window and answer whether it ever reached
 * a word. Sampled rather than read once, so a value that appears and is
 * superseded still counts as having appeared.
 */
async function registerEverReaches(
  app: App,
  dash: string,
  word: string,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await registerWord(app, dash)) === word) return true;
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
    "a bound green dash asks with no mark anywhere, the sheet names its landing message, a dismissal holds across a base move, a red decision asks again, and an unbound dash is never piloted at all",
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
        //
        // The real `dash bind` verb, not a `bind_dash_ok` broadcast: the pilot
        // works only for dashes bound in the **ledger** ([P08]), and a
        // client-side broadcast moves the deck's store without writing a row.
        // Faking it here would leave the server thinking nobody holds this
        // dash, and nothing downstream would ever run.
        tugutil(["dash", "bind", DASH], {
          cwd: scratch,
          binaryRoot: cli.binaryRoot,
          env: { ...(cli.env ?? {}), TUG_SESSION_ID: SID },
        });
        // Read from the Lens rather than from the verb's own exit: the row
        // drops its Bind verb for the bound worker's atom, which is the deck
        // seeing the ledger row the pilot will read.
        await app.waitForCondition<boolean>(
          `document.querySelector('${lensRow(DASH)} [data-slot="lens-bind"]') === null`,
          { timeoutMs: 30000 },
        );
        note("at0445 bound: the ledger row landed and the Lens row saw it");
        await registerReaches(app, DASH, "ready", 240000);
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

        // ── What it would land, and whose words those are ─────────────────
        // Nobody wrote a draft on this dash, so the join would quietly land
        // the branch description. The whole point of the provenance line is
        // that "quietly" stops here, at the one moment somebody is about to
        // agree to it ([P05]).
        const provenance = await app.evalJS<string>(
          `(document.querySelector('${PROMPT} [data-slot="join-prompt-sheet-message"]')?.textContent || "")`,
        );
        note(`at0445 lands-as: ${JSON.stringify(provenance)}`);
        expect(
          provenance,
          "the sheet quotes the message the join would land",
        ).toContain("at0445 bound-dash fixture");
        expect(
          provenance,
          "and says the words are the branch description, not an authored draft",
        ).toContain("no draft was written");

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
        //
        // A draft goes in first, so the next ask can be read for the other
        // half of the provenance rule. It is the NEXT ask rather than the
        // standing one deliberately: the sheet's message is a snapshot of the
        // question it was raised for, and re-rendering an open dialog under
        // the user's cursor to swap its quote would be the interruption this
        // whole arc is arranged to avoid.
        // `--instance` is not optional here, and the omission is not benign:
        // `draft set` writes through a running tugcast's `POST /api/draft`,
        // and its discovery finds whichever instance is registered — which,
        // on a developer's machine, is their **live** Tug. Without this the
        // draft lands in the real machine-global `changes.db` under a scratch
        // dash's owner key, and this instance never sees it.
        tugutil(
          [
            "draft",
            "set",
            "--instance",
            app.instanceId,
            "--owner",
            `dash:${DASH}`,
            "--message",
            "at0445 the words the author chose",
          ],
          { cwd: scratch, binaryRoot: cli.binaryRoot, env: cli.env },
        );
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
        const drafted = await app.evalJS<string>(
          `(document.querySelector('${PROMPT} [data-slot="join-prompt-sheet-message"]')?.textContent || "")`,
        );
        expect(
          drafted,
          "an authored draft is what this join would now land",
        ).toContain("the words the author chose");
        expect(
          drafted,
          "and it needs no apology — these words ARE somebody's",
        ).not.toContain("no draft was written");
        note(`at0445 lands-as (drafted): ${JSON.stringify(drafted)}`);

        // ── And the unbound dash was left alone entirely ──────────────────
        // Not merely unasked: unworked. The pilot only reconciles and checks
        // dashes bound to a live session ([P08]), because a green verdict on a
        // dash nobody is working is a workspace build spent on nobody — and
        // one commit on the base would otherwise re-qualify every dash in the
        // repository at once. So its register never reaches `ready`, even
        // though its facts are identical to the bound dash's and the base has
        // moved twice underneath it.
        expect(
          await registerEverReaches(app, QUIET_DASH, "ready", 20000),
          "an unbound dash is never piloted, so its arc never runs at all",
        ).toBe(false);
        expect(
          await registerWord(app, QUIET_DASH),
          "and its row promises no check it will never run",
        ).toBeNull();
        note("at0445 unbound: never piloted, and its row says nothing at all");
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
