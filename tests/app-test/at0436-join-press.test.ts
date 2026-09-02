/**
 * at0436-join-press.test.ts — the Join press reaches the wire, and a
 * server refusal reaches the user ([L31]).
 *
 * This is the gesture the corpus never made. On 2026-08-17 a Join press
 * produced three previews and no land request at all: the staged callback
 * re-read the dash off a controller the staging itself had just cleared, found
 * nothing, and returned. Nothing was sent, nothing was said, and the backend
 * was never asked — so the only honest pin is one that walks submit → gate →
 * stage → shade dismissal → wire and then proves the server *answered*.
 *
 * ## What the press has to produce
 *
 * The base branch moving, and nothing weaker. A bulletin, a spinner, or a face
 * state can all be produced by a client that never sent anything — which is
 * exactly what the incident did — so the assertion is a commit on `main` and
 * the dash gone from the lane.
 *
 * This file once made the join *fail* instead, on the reasoning that a dash in
 * the developer's checkout must not be landed. It owns its repository now, for
 * two reasons. That base branch is one somebody works on. And entering join
 * mode on a clean dash *resolves* it, which runs the project's own declared
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
 * What stays this file's own, and is why it is not at0441 twice: the dash is
 * reached by a **binding** gesture (`bind_dash_ok`) rather than by name, and
 * the press is **staged** behind the shade's dismissal. Those are the two
 * mechanisms the 2026-08-17 incident lived in — the staged callback re-read the
 * dash off a controller the staging had just cleared, found nothing, and
 * returned.
 *
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/components/tugways/cards/staged-landing.ts
 * @covers tugdeck/src/components/tugways/cards/landing-notice-controller.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/use-landing-receipts.ts
 * @covers tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugdeck/src/lib/shell-session-store.ts
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/shell_ledger.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  bindDash,
  makeJoinScratchRepo,
  rmJoinScratchRepo,
  rmScratchSession,
  seedScratchSession,
  silenceJoinPrompt,
  type JoinScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000436";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-toolbar .tug-prompt-entry-route-group`;
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;
// The bespoke `/arc-join` receipt block — the generic shell fallback carries a
// different slot, so this selector is also the assertion that it parsed.
const JOIN_RECEIPT = `${CARD} [data-slot="join-receipt-block"]`;

/** The checkout whose built binaries the fixture drives — never the project. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const DASH = "at0436-work";
const FILE = "subject.txt";

/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: JoinScratchRepo | null = null;
const projectDir = (): string => scratch?.repo ?? "";


let fixtureDir = "";
let tugbankPath = "";
let dashId = "";


const row = (dash: string): string =>
  `${LANE} [data-slot="session-changes-dash-row"][data-dash="${dash}"]`;
const landing = (dash: string): string =>
  `${row(dash)} [data-slot="session-changes-arc-join"]`;
// Card-scoped, not row-scoped: the register that reports a join in progress is
// the composer's live-edge one, not a copy inside the lane row. One dash is
// bound here, so the card's register is this dash's.
const CANDIDATE = `${CARD} [data-slot="arc-join-register"][data-word="ready"]`;
const landsAs = (dash: string): string =>
  `${row(dash)} [data-slot="session-changes-dash-lands-as"]`;


beforeAll(() => {
  if (!SHOULD_RUN) return;
  // A repository of the fixture's own, for the reason at0441 has one: entering
  // join mode on a clean dash now *resolves* it, and the verification that
  // follows runs the project's own declared checks. Aimed at the checkout that
  // would be the corpus building itself, in the developer's tree, on the way to
  // a press. Here it is a sentinel grep over a two-file repo.
  scratch = makeJoinScratchRepo({
    prefix: "at0436",
    dash: DASH,
    description: "at0436 fixture (a round to land)",
    checkout: CHECKOUT,
    file: FILE,
    fork: "at0436 the dash's file\n",
    base: "at0436 SENTINEL the base's own file\n",
    dashBody: "at0436 SENTINEL the dash rewrote it\n",
    // Clean, because what this file presses is a *landable* join: the refusal
    // it is about comes from the server on execute, not from the merge.
    cleanMerge: true,
    resolver: "#!/bin/sh\nexit 0\n",
  });
  dashId = scratch.dashId;

  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // The repository IS the teardown: branch, worktree, config, and dash all go
  // with the directory.
  rmJoinScratchRepo(scratch);
  rmScratchSession(fixtureDir);
  if (tugbankPath !== "") rmTempTugbank(tugbankPath);
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

async function clickUntil(app: App, target: string, expected: string, attempts = 5): Promise<void> {
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
      await app.waitForCondition<boolean>(
        `document.querySelector(${JSON.stringify(expected)}) !== null`,
        { timeoutMs: 3000 },
      );
      return;
    } catch {
      note(`at0436 click on ${target} did not land (attempt ${i + 1})`);
    }
  }
  throw new Error(`at0436: ${expected} never appeared after clicking ${target}`);
}

async function raiseShade(app: App): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType("/commit");
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
    { timeoutMs: 8000 },
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(LANE)}) !== null`,
    { timeoutMs: 40000 },
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
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
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
        // dash somebody holds ([D147]) — a client-side `bind_dash_ok` writes
        // no ledger row for it to read. The prompt that follows a standing
        // candidate is answered in advance: this file is about the shade.
        bindDash(projectDir(), DASH, SID, scratch?.cli ?? {});
        silenceJoinPrompt(projectDir(), DASH);

        await raiseShade(app);
        await app.dispatchControlAction("bind_dash_ok", {
          tug_session_id: SID,
          dash_id: dashId,
          dash_name: DASH,
        });
        // A landable dash publishes its OFFER — the `lands as` line — so that
        // is what says the fixture is ready. The report fold is NOT a
        // readiness signal and cannot be waited on here: a clean join has no
        // conflict, blocker, question or account to show, and the section
        // renders nothing it cannot say. Its silence is the clean case's own
        // shape, so it is asserted rather than waited for.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(landsAs(DASH))}) !== null`,
          { timeoutMs: 20000 },
        );
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(landing(DASH))}) === null`,
          ),
          "a clean dash shows no report — the fold speaks only with evidence",
        ).toBe(true);

        // `/commit` raised the shade in COMMIT mode, and one composer holds one
        // landing — so commit has to go before the join can have the document.
        // Escape is that exit, and it is the whole gesture: the BINDING opens
        // the join, which is this file's point ([the header]). A bound dash
        // with work ready to join enters join mode BY ITSELF once the composer
        // is free, so nothing here types `/arc-join` — reaching the dash by
        // name is at0441's route, and it would open by name the very mode the
        // binding is supposed to be proving it can open.
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          { timeoutMs: 60000 },
        );

        // Entering join mode resolved the dash ([P03]); the CANDIDATE standing
        // is that resolution anchoring, and it is the gate. The resolver's
        // account is not — a clean join resolves nothing and files no account,
        // so waiting on one here would wait forever. The register's `ready`
        // reads the candidate itself, which is the readiness fact.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CANDIDATE)}) !== null`,
          { timeoutMs: 180000 },
        );

        // A message of the user's own, so the press clears the gate on its
        // merits rather than on whatever the dash's draft happens to hold.
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("Delete");
        await app.nativeType("at0436: land this dash");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent ?? "").indexOf("land this dash") !== -1`,
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

        // And the dash is gone from the lane, which is the other half of a join
        // that really happened: a landed dash that keeps being offered is the
        // same lie the whole campaign is about.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(row(DASH))}) === null`,
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
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length === 1`,
          { timeoutMs: 30000 },
        );
        const receiptText = await app.evalJS<string>(
          `document.querySelector(${JSON.stringify(JOIN_RECEIPT)})?.textContent ?? ""`,
        );
        expect(receiptText, "the receipt names the dash it landed").toContain(DASH);
        expect(receiptText, "and the message the user pressed with").toContain(
          "land this dash",
        );

        await app.evalJS<null>(`(window.__tug.refreshInkRestore("A"), null)`);
        // The ledger answer is a round trip; give it room to arrive and then
        // assert the count did not move. Waiting for a NON-event needs a real
        // wait, so this dwells rather than polling for a condition.
        await settle(4000);
        const facts = await app.evalJS<{ shellTurns: number; commands: string[] }>(
          `window.__tug.inkRestoreFacts("A")`,
        );
        note(`at0436 ink after restore refresh: ${JSON.stringify(facts)}`);
        expect(
          facts.commands.filter((c) => c === "/arc-join").length,
          "one landing, one ink turn — the live row and the restored row are the same turn",
        ).toBe(1);
        expect(
          await app.evalJS<number>(
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
