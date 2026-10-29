/**
 * at0436-join-press.test.ts — the Join press reaches the wire, and a
 * server refusal reaches the user ([L31]).
 *
 * This is the gesture the corpus never made. On 2026-08-17 a Join press
 * produced three previews and no land request at all: the staged callback
 * re-read the arc off a controller the staging itself had just cleared, found
 * nothing, and returned. Nothing was sent, nothing was said, and the backend
 * was never asked — so the only honest pin is one that walks submit → gate →
 * stage → shade dismissal → wire and then proves the server *answered*.
 *
 * ## What the press has to produce
 *
 * The base branch moving, and nothing weaker. A bulletin, a spinner, or a face
 * state can all be produced by a client that never sent anything — which is
 * exactly what the incident did — so the assertion is a commit on `main` and
 * the arc gone from the lane.
 *
 * This file once made the join *fail* instead, on the reasoning that an arc in
 * the developer's checkout must not be landed. It owns its repository now, for
 * two reasons. That base branch is one somebody works on. And entering join
 * mode on a clean arc *resolves* it, which runs the project's own declared
 * checks over the candidate — aimed at the checkout, that is the corpus
 * building itself in the developer's tree on the way to a button press. Here it
 * is a sentinel grep over a two-file repo.
 *
 * The refusal half moved with it, and did not go missing: a server refusal that
 * the client can also compute is now refused client-side first ([P04] puts the
 * same gate on both sides), so what remained here was a race against the feed
 * rather than a pin. `at0435` holds the refusal *surface*, and `ops.rs` holds
 * the preflight itself.
 *
 * What stays this file's own, and is why it is not at0441 twice: the arc is
 * reached by a **binding** gesture (`bind_arc_ok`) rather than by name, and
 * the press is **staged** behind the shade's dismissal. Those are the two
 * mechanisms the 2026-08-17 incident lived in — the staged callback re-read the
 * arc off a controller the staging had just cleared, found nothing, and
 * returned.
 *
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/components/tugways/cards/staged-landing.ts
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-notice.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/use-landing-receipts.ts
 * @covers tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugdeck/src/lib/shell-session-store.ts
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/control/changeset.rs
 * @covers tugrust/crates/tugcast/src/shell_ledger.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  bindArc,
  makeJoinScratchRepo,
  rmJoinScratchRepo,
  rmScratchSession,
  seedScratchSession,
  silenceJoinPrompt,
  type JoinScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000436";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;
// The bespoke `/arc-join` receipt block — the generic shell fallback carries a
// different slot, so this selector is also the assertion that it parsed.
/** The settled join's boundary, at the transcript's edge — the row that names
 *  the event and counts the arc ([B02]). */
const JOIN_RECEIPT = `${CARD} [data-boundary="join"]`;
/** And the commit receipt beside it, in the `Git Commit` entry's own body
 *  column, which is where the squash message lives ([B01]). */
const JOIN_COMMIT_RECEIPT = `${CARD} [data-slot="join-receipt-block"]`;

/** The checkout whose built binaries the fixture drives — never the project. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const ARC = "at0436-work";
const FILE = "subject.txt";

/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: JoinScratchRepo | null = null;
const projectDir = (): string => scratch?.repo ?? "";


let fixtureDir = "";
let tugbankPath = "";
let arcId = "";


const row = (arc: string): string =>
  `${LANE} [data-slot="session-changes-arc-row"][data-arc="${arc}"]`;
const landing = (arc: string): string =>
  `${row(arc)} [data-slot="session-changes-arc-join"]`;
// Card-scoped, not row-scoped: the register that reports a join in progress is
// the composer's live-edge one, not a copy inside the lane row. One arc is
// bound here, so the card's register is this arc's.
const READY = `${CARD} [data-slot="arc-join-register"][data-word="ready"]`;
const landsAs = (arc: string): string =>
  `${row(arc)} [data-slot="session-changes-arc-lands-as"]`;


beforeAll(() => {
  if (!SHOULD_RUN) return;
  // A repository of the fixture's own, for the reason at0441 has one: entering
  // join mode on a clean arc now *resolves* it, and the verification that
  // follows runs the project's own declared checks. Aimed at the checkout that
  // would be the corpus building itself, in the developer's tree, on the way to
  // a press. Here it is a sentinel grep over a two-file repo.
  scratch = makeJoinScratchRepo({
    prefix: "at0436",
    arc: ARC,
    description: "at0436 fixture (a round to land)",
    checkout: CHECKOUT,
    file: FILE,
    fork: "at0436 the arc's file\n",
    base: "at0436 SENTINEL the base's own file\n",
    arcBody: "at0436 SENTINEL the arc rewrote it\n",
    // Clean, because what this file presses is a *landable* join: the refusal
    // it is about comes from the server on execute, not from the merge.
    cleanMerge: true,
    resolver: "#!/bin/sh\nexit 0\n",
  });
  arcId = scratch.arcId;

  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // The repository IS the teardown: branch, worktree, config, and arc all go
  // with the directory.
  rmJoinScratchRepo(scratch);
  rmScratchSession(fixtureDir);
  if (tugbankPath !== "") rmTempTugbank(tugbankPath);
});

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/**
 * The bound arc's offer reveals the shade by itself, in join mode: the binding
 * opens the join, and nothing here types a command to reach it.
 */
async function awaitReveal(app: App): Promise<void> {
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
    { timeoutMs: 20000 },
  );
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(LANE)}) !== null`,
    { timeoutMs: 40000 },
  );
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
    { timeoutMs: 20000 },
  );
}

/** The base branch's tip subject — the only place a join writes itself down. */
function baseTip(): string {
  return Bun.spawnSync(
    ["git", "-C", projectDir(), "log", "-1", "--format=%s", "main"],
    {},
  )
    .stdout.toString()
    .trim();
}

describe.skipIf(!SHOULD_RUN)("AT0436: the Join press reaches the wire", () => {
  test(
    "a pressed join is sent for real, and the base branch moves",
    async () => {
      tugbankPath = mkTempTugbank();
      // The source tree is where the app finds `tugdeck/dist` to serve, so it
      // stays the checkout; the *project* is the scratch repo.
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0436-join-press",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A real session spawn, not a bind: the scratch repo reaches the
        // server the only way a project ever does — by a session registering
        // its workspace, which is what puts it in the open-project set the
        // changeset aggregate enumerates.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        // The join face is what the pilot found, and the pilot works only a
        // arc somebody holds ([D147]) — a client-side `bind_arc_ok` writes
        // no ledger row for it to read. The prompt that follows a standing
        // candidate is answered in advance: this file is about the shade.
        bindArc(projectDir(), ARC, SID, scratch?.cli ?? {});
        silenceJoinPrompt(projectDir(), ARC);

        // A broadcast reaches every page, and the lane's binding store is the
        // card body's own — so the frame is handed to the body as well as the
        // shell.
        const bindOk = { tug_session_id: SID, arc_id: arcId, arc_name: ARC };
        await app.dispatchControlAction("bind_arc_ok", bindOk);
        await app.body("A").evalJS<null>(
          `(window.__tug.dispatchControlAction("bind_arc_ok", ${JSON.stringify(bindOk)}), null)`,
        );
        await awaitReveal(app);
        // A landable arc publishes its OFFER — the `lands as` line — so that
        // is what says the fixture is ready. The report section is NOT a
        // readiness signal: it always renders, opening on the arc's fit
        // ([D224]). What a clean join has nothing of is evidence — no
        // conflict, blocker, question or account — so its ledger settles to
        // nothing once the run that anchored the candidate has ended.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(landsAs(ARC))}) !== null`,
          { timeoutMs: 20000 },
        );
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${landing(ARC)} [data-slot="session-changes-ledger"]`)}) === null`,
          { timeoutMs: 10000 },
        );
        expect(
          await app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(`${landing(ARC)} [data-slot="session-changes-arc-join-fit"]`)}) !== null`,
          ),
          "a clean arc's report opens on its fit, and its ledger speaks only with evidence",
        ).toBe(true);

        // The BINDING opened the join, which is this file's point ([the
        // header]): the offer revealed the shade in join mode, so nothing here
        // types `/arc-join`. The register's `ready` is the offer standing,
        // which is the gate.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(READY)}) !== null`,
          { timeoutMs: 180000 },
        );

        // A message of the user's own, so the press clears the gate on its
        // merits rather than on whatever the arc's draft happens to hold.
        await app.body("A").nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("Delete");
        await app.nativeType("at0436: land this arc");
        await app.body("A").waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent ?? "").indexOf("land this arc") !== -1`,
          { timeoutMs: 5000 },
        );

        const before = baseTip();
        await app.nativeKey("Return", ["cmd"]);

        // The base branch moving is the proof, and the only one this beat
        // accepts. Waiting on outcomes, never on the shade's exit animation:
        // background windows run no rAF, so the watchdog may be what runs the
        // staged landing.
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline && baseTip() === before) await settle(500);
        expect(baseTip(), "the press reached the wire and the join integrated").not.toBe(
          before,
        );
        note(`at0436 landed: ${JSON.stringify(baseTip())}`);

        // And the arc is gone from the lane, which is the other half of a join
        // that really happened: a landed arc that keeps being offered is the
        // same lie the whole campaign is about.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(row(ARC))}) === null`,
          { timeoutMs: 60000 },
        );

        // The landing leaves ONE receipt row, and it survives a restore.
        //
        // A landing's receipt is delivered twice — the live row this deck
        // painted off the join's terminal edge, and the shell-ledger row a
        // restore replays whenever the window widens. Both arrive as shell
        // exchanges keyed by exchange id, so if the two paths spell that id
        // differently the transcript grows a second copy of one landing. The
        // refresh below is the only gesture that brings the ledger's copy into
        // a transcript that already holds the live one, which is what makes
        // this a proof rather than a coincidence.
        //
        // Nothing here observes the row's first FRAME. A background app-test
        // window runs no rAF, so a one-or-two-frame presentation is not
        // reliably observable; what is durable — that the row is the bespoke
        // receipt and that there is exactly one of it — is what is asserted.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length === 1`,
          { timeoutMs: 30000 },
        );
        const receiptText = await app.body("A").evalJS<string>(
          `document.querySelector(${JSON.stringify(JOIN_RECEIPT)})?.textContent ?? ""`,
        );
        expect(receiptText, "the receipt names the arc it landed").toContain(ARC);
        // The message is the commit's, so it is on the commit receipt rather
        // than on the boundary's bar — the boundary counts the arc, and the
        // entry named for the commit carries the commit ([B01], [B02]).
        const commitText = await app.body("A").evalJS<string>(
          `document.querySelector(${JSON.stringify(JOIN_COMMIT_RECEIPT)})?.textContent ?? ""`,
        );
        expect(commitText, "and the message the user pressed with").toContain(
          "land this arc",
        );

        await app.body("A").evalJS<null>(`(window.__tug.refreshInkRestore("A"), null)`);
        // The ledger answer is a round trip; give it room to arrive and then
        // assert the count did not move. Waiting for a NON-event needs a real
        // wait, so this dwells rather than polling for a condition.
        await settle(4000);
        const facts = await app.body("A").evalJS<{ shellTurns: number; commands: string[] }>(
          `window.__tug.inkRestoreFacts("A")`,
        );
        note(`at0436 ink after restore refresh: ${JSON.stringify(facts)}`);
        expect(
          facts.commands.filter((c) => c === "/arc-join").length,
          "one landing, one ink turn — the live row and the restored row are the same turn",
        ).toBe(1);
        expect(
          await app.body("A").evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length`,
          ),
          "and still exactly one receipt row on screen",
        ).toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
