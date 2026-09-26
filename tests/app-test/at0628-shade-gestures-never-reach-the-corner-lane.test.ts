/**
 * at0628-shade-gestures-never-reach-the-corner-lane.test.ts — **a tripwire for a
 * capability that was removed, not a caller that was moved.**
 *
 * ## What it is a tripwire for
 *
 * The Session card's top-right `TugPaneBulletinProvider` sits in the transcript
 * region the Changes shade raises a pane scrim over. For a long time six
 * zero-render controllers posted into it, and three of them reported gestures
 * that exist only in the shade — so a refused claim, a refused discard or a
 * refused Auto-Message arrived *above* the shade, *dimmed*, with an OK button,
 * as far from the pressed control as the card allows. The fix before this one
 * moved one caller (the commit refusal) and left the capability standing; this
 * arc removed the capability, deleting the three controllers and seating every
 * shade-origin refusal in the shade's own notice band.
 *
 * A deletion is not self-guarding. Nothing stops a future `api.danger(…)` from
 * being added to a shade verb — it is one line, it looks exactly like the five
 * legitimate corner tenants beside it, and it would be invisible in review. So
 * this file makes the emptiness a *tested* fact: with the shade presented, it
 * fails each of the shade's own gestures for real and asserts that what each one
 * produced is in the band and nowhere near the lane. A regression lands red here
 * rather than behind a scrim in somebody's screenshot.
 *
 * ## The alternative it rejects
 *
 * The obvious tripwire — "with `data-tug-sheet-presented` set, the corner lane is
 * empty" — is the wrong shape and would be a false alarm waiting to happen. The
 * lane keeps five legitimate tenants that have nothing to do with this shade: a
 * transient transport interruption, a replay-timeout, an `/arc <name>` binding
 * refused (typed into the composer, not pressed in the shade), an Arcs-card
 * arc-press refusal, and an Arcs-card replay outcome. Any of those may arrive
 * while this card's shade happens to be up, and a shade being presented is a
 * coincidence of timing rather than a claim about where a notice came from. So
 * the assertion is keyed on **origin**: each gesture is performed, and the lane
 * is asserted empty of *that gesture's own words*.
 *
 * ## Why these two gestures
 *
 * One landing and one verb, which are the two routes into the band — a landing
 * face computed by `landingNoticeFace`, and a verb's error slot read straight off
 * the store. Both refusals are real and neither publishes a frame:
 *
 *   - **A gate-refused commit.** Z5 pressed with an empty message. The deck
 *     refuses to send, which is the one landing refusal a fixture can produce
 *     without a server.
 *   - **A refused discard.** `discard_in` runs `working_set_hand_back` above every
 *     write and refuses the whole discard when the base checkout holds its own
 *     uncommitted edit to a path the arc's worktree also changed — so the fixture
 *     writes that conflict and the arc survives the press by construction.
 *
 * A refused *claim* is deliberately not among them, and the reason is worth
 * writing down rather than rediscovering: the claim verb is refused only by a
 * guard on the project registry or by the ledger's own write failing, and neither
 * is reachable from a test without publishing a frame the app never received or
 * attacking a live SQLite ledger. Claim, disclaim, discard and Auto-Message share
 * one seat, one rank and one code path into the band, so the discard covers the
 * shape; at0627 is the same argument at more length.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-notice.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/components/tugways/tug-pane-bulletin.tsx
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
  createArc,
  gitRetry,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";
import { pressArcRowMenuItem } from "./arc-row-menu-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000628";
const ARC = "at0628-work";
/** The one path both sides edit without committing — the hand-back's conflict. */
const SHARED = "at0628-shared.txt";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;
const ROW = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC}"]`;
const CONFIRM = '[data-slot="tug-confirm-confirm"]';
const COMMIT_BUTTON = `${CARD} [data-testid="tug-prompt-entry-commit-button"]`;
const CLAIM_ALL = `${CARD} [data-testid="tug-changes-list-claim-all-unattributed"]`;

/** Every notice in the shade's band, as text — where a shade gesture speaks. */
const BAND_TEXTS = `Array.from(document.querySelectorAll('${CARD} [data-slot="session-changes-notice"]')).map(function(e){ return e.textContent || ""; })`;
/** Every corner bulletin on screen, as text — where none of them may. */
const CORNER_TEXTS = `Array.from(document.querySelectorAll('[data-sonner-toast]')).map(function(e){ return e.textContent || ""; })`;

/** This checkout — the build under test, never the tree the fixture dirties. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
let tugbankPath = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0628", checkout: CHECKOUT });
  writeFileSync(join(projectDir(), SHARED), "at0628 the shared file\n");
  gitRetry(projectDir(), "add", SHARED);
  gitRetry(projectDir(), "commit", "-m", "at0628: seed the path both sides will edit");

  const arc = createArc(projectDir(), ARC, "at0628 fixture (a discard to refuse)", scratch.cli);
  // Both halves of the hand-back conflict, which is the discard's refusal.
  writeFileSync(join(arc.worktree, SHARED), "at0628 the arc's uncommitted edit\n");
  writeFileSync(join(projectDir(), SHARED), "at0628 the base's uncommitted edit\n");

  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  if (fixtureDir !== "") rmScratchSession(fixtureDir);
  if (tugbankPath !== "") rmTempTugbank(tugbankPath);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 980, height: 720 },
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

const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Raise the shade in commit mode, retrying the gesture.
 *
 * The retry is not padding. `/commit` opens the command popup, and whether the
 * Escape that dismisses it lands before the ⌘⏎ that submits is a race with the
 * popup's own mount — a miss leaves the composer holding the text with no shade,
 * which is indistinguishable from a broken build to any single-shot wait. This
 * file learned that the hard way: the same wait failed and passed on identical
 * code, which is exactly the flake that makes a tripwire useless, because a
 * tripwire nobody trusts is not consulted.
 */
async function enterCommitMode(app: App): Promise<void> {
  const up = `document.querySelector(${JSON.stringify(SHEET)}) !== null &&
              document.querySelector(${JSON.stringify(COMMIT_BUTTON)}) !== null`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await app.nativeClickAtElement(PROMPT_INPUT);
    // Whatever a missed attempt left in the composer goes first, so the second
    // try types `/commit` rather than `/commit/commit`.
    await app.nativeKey("a", ["cmd"]);
    await app.nativeKey("Delete");
    await settle(200);
    await app.nativeType("/commit");
    await settle(600);
    await app.nativeKey("Escape");
    await settle(600);
    await app.nativeKey("Return", ["cmd"]);
    try {
      await app.waitForCondition<boolean>(up, { timeoutMs: 12_000 });
      return;
    } catch {
      note(`at0628 the commit-mode raise did not land (attempt ${attempt})`);
      await settle(1_000);
    }
  }
  throw new Error("at0628: commit mode never opened");
}

/**
 * Assert the shade is the presented sheet, and that the band — not the lane —
 * carries `words`.
 *
 * One helper rather than two blocks, because the pair of assertions is the whole
 * point: "the band has it" alone would pass a build that posted it to both, and
 * "the lane does not" alone would pass a build where the gesture said nothing
 * anywhere, which is the dead button this arc exists to end.
 */
async function assertSpeaksInTheShadeOnly(
  app: App,
  gesture: string,
  words: readonly string[],
): Promise<void> {
  expect(
    await app.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(SHEET)})?.hasAttribute("data-tug-sheet-presented") === true`,
    ),
    `${gesture}: the shade is the presented sheet`,
  ).toBe(true);

  const band = await app.evalJS<string[]>(BAND_TEXTS);
  const corner = await app.evalJS<string[]>(CORNER_TEXTS);
  note(`at0628 after ${gesture} — band: ${JSON.stringify(band)}`);
  note(`at0628 after ${gesture} — corner lane: ${JSON.stringify(corner)}`);
  for (const word of words) {
    expect(
      band.some((t) => t.includes(word)),
      `${gesture}: the band carries ${JSON.stringify(word)}`,
    ).toBe(true);
    expect(
      corner.every((t) => !t.includes(word)),
      `${gesture}: the corner lane carries nothing of ${JSON.stringify(word)}`,
    ).toBe(true);
  }
}

describe.skipIf(!SHOULD_RUN)("AT0628: no shade gesture reaches the corner lane", () => {
  test(
    "a refused discard and a gate-refused commit both speak in the shade and nowhere else",
    async () => {
      tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0628-shade-gestures-never-reach-the-corner-lane",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        // ── Gesture 1: a commit this deck refuses to send ────────────────
        //
        // Commit mode first, and the shade taken back down before gesture 2,
        // because the two gestures need the shade in different states and the
        // order is not arbitrary. A landing outranks a verb refusal in the band
        // ([P05]), so a commit mode left standing over the discard below would
        // put the two in competition for one seat and make the assertion depend
        // on a fade timer. Exiting the mode is what removes the timing from it.
        await enterCommitMode(app);

        // Claim the dirt onto this card's entry, so the press below is refused
        // for the reason under test — an empty message — rather than for an
        // empty changeset. Z5's gate counts what this card's entry carries, and
        // the base's own uncommitted edit arrives unattributed.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CLAIM_ALL)}) !== null`,
          { timeoutMs: 40_000 },
        );
        await app.nativeClickAtElement(CLAIM_ALL);
        await app.waitForCondition<boolean>(
          `(function(){
             const b = document.querySelector(${JSON.stringify(COMMIT_BUTTON)});
             return b !== null && !b.hasAttribute("data-land-blocked");
           })()`,
          { timeoutMs: 40_000 },
        );

        // The message is empty, so the land button is dimmed — and it refuses out
        // loud anyway, which is the behaviour at0435 pinned. A dimmed button that
        // went numb was the original dead press.
        await app.nativeClickAtElement(COMMIT_BUTTON);
        await app.waitForCondition<boolean>(
          `${BAND_TEXTS}.some(function(t){ return t.indexOf("Write a commit message") !== -1; })`,
          { timeoutMs: 20_000 },
        );
        await assertSpeaksInTheShadeOnly(app, "a gate-refused commit", [
          "Commit not sent",
          "Write a commit message",
        ]);

        // ── Gesture 2: a discard the server refuses ──────────────────────
        //
        // Escape takes the passive shade down and exits the landing with it, so
        // ⌃⌘C then raises the shade with no landing mode standing and the band's
        // only possible tenant is the verb below.
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          { timeoutMs: 20_000 },
        );
        await settle(1_000);
        await app.nativeKey("c", ["ctrl", "cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 40_000 },
        );
        await settle(1_500);

        await pressArcRowMenuItem(app, ROW, "request-discard-arc");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.nativeClickAtElement(CONFIRM);
        await app.waitForCondition<boolean>(
          `${BAND_TEXTS}.some(function(t){ return t.indexOf("Discard failed") !== -1; })`,
          { timeoutMs: 60_000 },
        );
        await assertSpeaksInTheShadeOnly(app, "a refused discard", [
          "Discard failed",
          "the base checkout has its own uncommitted changes",
        ]);

        note("at0628 both gestures spoke in the shade", (await app.screenshot()).path);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
