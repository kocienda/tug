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
 * - **The ask says what would land, and whose words those are.** With no
 *   draft written, the join would quietly land the branch description; the
 *   provenance line is where "quietly" stops. Write a draft **while the ask
 *   stands** and it repaints in place to the author's words, with no
 *   annotation and under the same question — the lands-as is a live view of
 *   the ledger, not a snapshot of the moment the ask was raised. It used to be
 *   a snapshot, and the field consequence was an ask announcing "no draft was
 *   written" over a join that landed with one.
 * - **Nothing is scrimmed.** The ask mounts inline at the transcript's live
 *   edge, so the run's ending narration above it stays readable while the
 *   decision is made. The pane body carries no `inert`, which is exactly what
 *   the modal it replaced put there.
 * - "Not yet" dismisses it, and the dismissal is durable — the mark is
 *   `branch.tugdash/<n>.tugjoinprompted`, not a client memory ([P07]).
 * - **A base move that reconciles to the same decision raises nothing.** The
 *   dash is re-reconciled and re-checked, the shas all change, and the ask
 *   stays down — because the re-ask policy keys on the *decision*, not on the
 *   heads. This is the assertion the whole policy exists for.
 * - **A change that makes the checks red raises a new one.** The decision
 *   genuinely changed, and a dismissal of "this builds — join it?" is not an
 *   answer to "this does not build — join it anyway?".
 * - **The landing narrates, settles, and gets out of the way.** After "Join
 *   now" the same element becomes the progress surface: it renders at least
 *   one of the join's beats before its outcome, settles on what happened, and
 *   departs. The durable record is the transcript's receipt row — and the
 *   composer's status row, which used to hold the settled sentence until
 *   something replaced it, comes back empty. Three copies of one sentence, one
 *   of them squatting on an input surface, is furniture rather than news.
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
 * drives; the unbound one is the control. Nothing is built anywhere: the join
 * gates on reconcile-clean alone, so the arc runs at git speed.
 *
 * @covers tugdeck/src/components/tugways/cards/join-prompt-inline.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/lib/join-mode-controller.ts
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
/** The ask, inline at the transcript's live edge. */
const PROMPT = '[data-slot="join-prompt-inline"][data-phase="deciding"]';
/** Its whole text. The question, the three options and their descriptions are
 *  all the server's words, so reading the surface entire is reading the ask. */
const PROMPT_QUESTION = PROMPT;
/** The lands-as block: what would land, and whose words those are. */
const PROMPT_MESSAGE = `${PROMPT} [data-slot="join-prompt-inline-message"]`;
const promptOption = (label: string): string =>
  `${PROMPT} .session-question-dialog-options-list [data-option-label="${label}"]`;
const PROMPT_SUBMIT = `${PROMPT} .session-question-dialog-actionbar-buttons .tug-button-primary-action`;
/** The same surface after "Join now" — the question is gone, the work is on. */
const LANDING = '[data-slot="join-prompt-inline"][data-phase="landing"]';
const LANDING_LINE = `${LANDING} [data-slot="join-prompt-inline-landing-line"]`;
const LANDING_DETAIL = `${LANDING} [data-slot="join-prompt-inline-landing-detail"]`;
/** The composer's own join register — the row that used to hold the settled
 *  sentence forever. */
const COMPOSER_REGISTER =
  '[data-slot="tug-prompt-entry"] [data-slot="dash-join-register"]';
/** The pane body a modal would have inerted while the ask stood. */
const PANE_BODY = ".tug-pane-body";
/** The durable receipt a landing leaves in the transcript. */
const JOIN_RECEIPT = '[data-slot="join-receipt-block"]';

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


let scratch = "";
let boundWorktree = "";
let dataRoot = "";
let fixtureDir = "";
let cli: { binaryRoot?: string; env?: Record<string, string> } = {};

beforeAll(() => {
  if (!SHOULD_RUN) return;
  const base = makeDashScratchRepo({ prefix: "at0445", checkout: CHECKOUT });
  scratch = base.repo;
  dataRoot = base.dataRoot;
  cli = base.cli;

  // Two dashes, each touching a file of its own, so neither conflicts with the
  // base or with the other. The arc they walk is the quiet one — reconcile,
  // check, ready — which is exactly the state the prompt asks about.
  const bound = createDash(scratch, DASH, "at0445 bound-dash fixture", cli);
  boundWorktree = bound.worktree;
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

/** Click, scrolling into view first — the ask rides the transcript scroller. */
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

/** Whether the ask is up right now. */
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

/**
 * Record every sentence the landing line ever holds.
 *
 * A `MutationObserver` rather than a poll, and that is the whole point: a join
 * on a scratch repository is over in well under a second, so a sampler racing
 * it can report "no beat" for a narration that rendered four. This records the
 * DOM's own history, so the assertion below is about what was painted rather
 * than about what a poll happened to catch.
 */
async function watchLandingLines(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function(){
      window.__at0445Lines = [];
      var seen = "";
      var read = function(){
        var el = document.querySelector('[data-slot="join-prompt-inline-landing-line"]');
        var text = el === null ? "" : (el.textContent || "");
        if (text !== "" && text !== seen) { seen = text; window.__at0445Lines.push(text); }
      };
      var obs = new MutationObserver(read);
      obs.observe(document.body, { subtree: true, childList: true, characterData: true });
      read();
      return null;
    })()`,
  );
}

/** Every distinct landing sentence painted since {@link watchLandingLines}. */
function landingLines(app: App): Promise<string[]> {
  return app.evalJS<string[]>(`(window.__at0445Lines || [])`);
}

/** The beat vocabulary, quoted rather than imported: an app-test drives the
 *  built bundle, not the module graph. */
const BEATS = [
  "squashing",
  "tearing down the workshop",
  "releasing the branch",
  "recording the landing",
];

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
    "a bound green dash asks with no mark anywhere, the ask names its landing message and repaints it live, a dismissal holds across a base move, a red decision asks again, and an unbound dash is never piloted at all",
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
        // from without touching either dash, and the ask mounts at the card's
        // live edge rather than over the pane, so the two do not contend.
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
          `(document.querySelector(${JSON.stringify(PROMPT_MESSAGE)})?.textContent || "")`,
        );
        note(`at0445 lands-as: ${JSON.stringify(provenance)}`);
        expect(
          provenance,
          "the ask quotes the message the join would land",
        ).toContain("at0445 bound-dash fixture");
        expect(
          provenance,
          "and says the words are the branch description, not an authored draft",
        ).toContain("no draft was written");

        // ── Nothing is scrimmed ──────────────────────────────────────────
        // The modal this replaced inerted the pane body, which greyed out the
        // run's ending narration at the exact moment the decision needed it.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(PANE_BODY)})?.hasAttribute("inert") ?? false`,
          ),
          "an ask standing at the live edge inerts nothing",
        ).toBe(false);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(PROMPT)})?.closest('[data-tug-scroll-key="session-card-transcript"]') !== null`,
          ),
          "and it lives inside the transcript scroller, so it scrolls with the conversation",
        ).toBe(true);

        // ── The lands-as is live, not a snapshot ─────────────────────────
        // A draft written WHILE the ask stands repaints it in place, under the
        // same question. This is the defect that produced "no draft was
        // written" over a join that landed with one: the read side missed the
        // gateway-keyed row, and a draft write bumped no feed, so the standing
        // ask served the words it was raised with forever.
        //
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
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(PROMPT_MESSAGE)})?.getAttribute("data-source") || "") === "draft"`,
          { timeoutMs: 30000 },
        );
        const repainted = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(PROMPT_MESSAGE)})?.textContent || "")`,
        );
        note(`at0445 lands-as (repainted): ${JSON.stringify(repainted)}`);
        expect(
          repainted,
          "the standing ask now quotes the words the author just wrote",
        ).toContain("the words the author chose");
        expect(
          repainted,
          "and drops the apology, because these words ARE somebody's",
        ).not.toContain("no draft was written");

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
        expect(
          mark,
          "the dismissal names the dash head it declined, so a later round is a new question",
        ).toBe(git(scratch, "rev-parse", `tugdash/${DASH}`).trim());
        note("at0445 dismissed: the ask went down and the mark went in");

        // ── The base moves, and the ask stays down ────────────────────────
        // Everything the request id is built from changes but one: the base
        // sha moves, the dash is reconciled again, the candidate is rebuilt.
        // The dash head does not move — and that is what the policy keys on,
        // because the same work reconciled again is not a new question.
        writeFileSync(join(scratch, "base-move.txt"), "at0445 the base moved\n");
        git(scratch, "add", "-A");
        git(scratch, "commit", "-m", "at0445: the base moves under a dismissed ask");
        // Waited on rather than assumed: the point is that a full re-run of
        // the arc — not merely a quiet minute — leaves the ask down.
        await registerReaches(app, DASH, "ready", 240000);
        expect(
          await promptAppearsWithin(app, 15000),
          "a base move under an unchanged dash head re-reconciles in silence",
        ).toBe(false);
        note("at0445 quiet: the base moved, the arc re-ran, and nothing asked again");

        // ── A new round, and the ask comes back ──────────────────────────
        // The dash head moves. That is a different question — a dismissal at
        // one milestone is not an answer about the work that came after it,
        // which is the failure this policy was written for: a run that walked
        // four milestones asked once and went silent for the rest.
        //
        // The draft written above survives the dismissal and the new round —
        // it is the dash's, not the ask's — so the new question opens on the
        // author's words with no second write.
        writeFileSync(
          join(boundWorktree, "bound.txt"),
          "at0445 the bound dash keeps working\n",
        );
        commitRound(scratch, DASH, "at0445(round): work the user has not been asked about", cli);
        await registerReaches(app, DASH, "ready", 300000);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROMPT)}) !== null`,
          { timeoutMs: 90000 },
        );
        const reasked = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(PROMPT_QUESTION)})?.textContent || "")`,
        );
        note(`at0445 re-asked: ${JSON.stringify(reasked)}`);
        expect(reasked, "the new ask is about the new state").toContain(DASH);
        const drafted = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(PROMPT_MESSAGE)})?.textContent || "")`,
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

        // ── "Join now" ────────────────────────────────────────────────────
        // The half of the decision the rest of this file never presses. The
        // surface the user agreed on is where the join then plays: it does not
        // vanish on the press, it narrates, and it settles naming what it did.
        // A surface that closed here would put the decision and its
        // consequence in two different places.
        await watchLandingLines(app);
        await revealAndClick(app, promptOption("Join now"));
        await revealAndClick(app, PROMPT_SUBMIT);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LANDING)}) !== null`,
          { timeoutMs: 60000 },
        );
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(PROMPT_SUBMIT)}) === null`,
          ),
          "the question is gone — the same surface is now the progress surface",
        ).toBe(true);
        expect(
          await app.evalJS<boolean>(
            `(document.body.textContent || "").indexOf("Join?") === -1`,
          ),
          "and nothing on screen is still asking a question the user already answered",
        ).toBe(true);

        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(LANDING)})?.getAttribute("data-state") || "") === "joined"`,
          { timeoutMs: 120000 },
        );
        const settled = await app.evalJS<{ line: string; detail: string }>(
          `({
             line: (document.querySelector(${JSON.stringify(LANDING_LINE)})?.textContent || ""),
             detail: (document.querySelector(${JSON.stringify(LANDING_DETAIL)})?.textContent || ""),
           })`,
        );
        note(`at0445 settled: ${JSON.stringify(settled)}`);

        // Every sentence the landing ever painted, from the observer installed
        // before the press. The join narrates four beats (`squashing`,
        // `tearing down the workshop`, `releasing the branch`, `recording the
        // landing`), and the claim is that the surface rendered at least one of
        // them before its outcome — a landing that read `Joining <dash>` from
        // first frame to last is not a progress surface, which is exactly what
        // the 2026-08-22 join showed.
        const lines = await landingLines(app);
        note(`at0445 landing lines: ${JSON.stringify(lines)}`);
        expect(
          lines.some((line) => BEATS.some((beat) => line.includes(beat))),
          "the landing narrates the join's work, not only that work is happening",
        ).toBe(true);
        expect(settled.line, "the settled surface names the dash it landed").toContain(DASH);
        expect(
          settled.detail,
          "and the outcome's own words, not a bare status word",
        ).not.toBe("");

        // It closes itself once it has been read, rather than resting forever
        // on a decision nobody has anything left to make about it.
        // A landing outlives its dash: the instant the join lands, the dash's
        // feed entry is gone. A surface reading the card's live dash name here
        // would lose the store key it was watching at the exact moment the
        // outcome arrived and narrate `Joining ` forever — never settling, so
        // never departing. It holds the name it was pressed with instead, and
        // this is the assertion that says so.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LANDING)}) === null`,
          { timeoutMs: 30000 },
        );

        // And the landing left its durable trace. This is the whole point of
        // threading the session id through the answer: before it, a join
        // agreed to at the live edge wrote no transcript row at all, so the one
        // record of the act lived on rows that unmount when the dash entry
        // goes.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN_RECEIPT)}) !== null`,
          { timeoutMs: 60000 },
        );
        const receipt = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(JOIN_RECEIPT)})?.textContent || "")`,
        );
        note(`at0445 receipt: ${JSON.stringify(receipt.slice(0, 200))}`);
        expect(receipt, "the receipt names the dash that landed").toContain(DASH);

        // And the composer goes back to being an input. The register narrates
        // the beats while the join runs — all three surfaces stay consistent
        // under way — but the settled sentence rests briefly and then clears,
        // because the receipt row above is the durable record and a status row
        // holding one sentence until the next join is furniture.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMPOSER_REGISTER)}) === null`,
          { timeoutMs: 15000 },
        );
        note(
          "at0445 joined: the surface narrated it, settled on it, left a receipt, and the composer emptied",
        );
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
