/**
 * at0560-ready-open-form.test.ts — what the open card offers while its arc's
 * join offer stands.
 *
 * ## What this gates
 *
 * The folded form's side of Ready is at0559's. This is the open form's, and it
 * is two surfaces the reader meets without going anywhere:
 *
 *   1. **The finished receipt stays a quiet line.** It once grew a Join while
 *      the offer stood ([B04]); that button was a fourth door to the one room
 *      and kept reading as an offer while the join it pointed at was already
 *      running, so it was removed. The row reporting the arc's ending carries
 *      no act, offer or not.
 *   2. **The composer says what is being waited for** ([B05]). A state that
 *      calls for the user and does not say what they are called for is a dot
 *      with no sentence under it, so the placeholder says both halves — that
 *      the work is done, and the one act that lands it — while keeping the
 *      composer's own invitation, because Ready is not a block.
 *
 * The arc is real — a scratch repository, one arc, one committed round, the
 * server deriving readiness with nothing marked. The shade reveals itself first,
 * as at0445 pins; this file closes it and works in the transcript the reader is
 * returned to, which is where both of its subjects live.
 *
 * `@covers` leaves `session-card.tsx` out, for the reason at0550 and at0551
 * both give: it stands at the selection budget's ceiling and at0140 catches
 * its breakage sooner. The placeholder is its line all the same, and this
 * file asserts it regardless.
 *
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.css
 * @covers tugdeck/src/lib/code-session-store/use-session-phase.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  commitRound,
  createArc,
  makeArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 420_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000560";
/** The arc this card is mated to — the one whose offer stands. */
const ARC = "at0560-bound";

const CARD = '[data-card-id="A"]';
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-route-group`;
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;
const PLACEHOLDER = `${CARD} [data-slot="tug-prompt-entry"] .cm-placeholder`;
/** The finished-arc row in the transcript, and any push button it might carry. */
const FINISH_LINE = `${CARD} [data-slot="arc-finish-line"]`;
const FINISH_BUTTONS = `${FINISH_LINE} [data-slot="tug-push-button"]`;

/** The line the composer shows while the arc has finished and the offer stands. */
const READY_PLACEHOLDER = "Arc finished. /arc-join to land it, or keep working";

/** The checkout whose built binaries the fixture drives. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch = "";
let dataRoot = "";
let fixtureDir = "";
let cli: { binaryRoot?: string; env?: Record<string, string> } = {};

beforeAll(() => {
  if (!SHOULD_RUN) return;
  const base = makeArcScratchRepo({ prefix: "at0560", checkout: CHECKOUT });
  scratch = base.repo;
  dataRoot = base.dataRoot;
  cli = base.cli;

  const arc = createArc(scratch, ARC, "at0560 open-form fixture", cli);
  writeFileSync(join(arc.worktree, "open.txt"), "at0560 the arc's work\n");
  commitRound(scratch, ARC, "at0560(round): the arc's work", cli);

  fixtureDir = seedScratchSession(scratch, SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  if (dataRoot !== "") rmSync(dataRoot, { recursive: true, force: true });
  rmScratchSession(fixtureDir);
});

/**
 * The record an arc's ending leaves, as `format_arc_receipt` writes it — the
 * one row `useLandingReceipts` files under `/arc-run`.
 */
function receiptText(arc: string): string {
  return [
    `arc complete · ${arc}`,
    `opened on .tug/arcs/${arc}/brief.md`,
    `implement · opus · ${SID}`,
  ].join("\n");
}

/** How many push buttons stand on the finished row right now. */
function finishButtons(app: App): Promise<number> {
  return app.body("A").evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(FINISH_BUTTONS)}).length`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0560: a standing offer on an open card", () => {
  test(
    "the finished row stays a quiet line while the offer stands, and the composer says what is waited for",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0560-ready-open-form",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: dataRoot },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape({ width: 1000, height: 720 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: scratch });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // The row reporting the arc's ending, filed before the offer exists.
        await app.driveSession("A", {
          op: "shellExchange",
          exchangeId: "at0560-finish-bound",
          command: "/arc-run",
          output: receiptText(ARC),
          cwd: scratch,
          exitCode: 0,
          startedAtMs: 1_700_000_000_000,
        });
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(FINISH_LINE)}).length === 1`,
          { timeoutMs: 30000 },
        );
        expect(
          await finishButtons(app),
          "a finished arc with no standing offer is a quiet line",
        ).toBe(0);

        // The real `arc bind` verb: the server works from the LEDGER row.
        tugtool(["arc", "bind", ARC], {
          cwd: scratch,
          binaryRoot: cli.binaryRoot,
          env: { ...cli.env, TUG_SESSION_ID: SID },
        });

        // The offer arrives on an open card with an empty composer, so the
        // room reveals itself (at0445's subject). Close it: this file's two
        // surfaces are both in the transcript the close returns to, and
        // closing costs nothing.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 240000 },
        );
        // Let the entry finish arriving before closing it. The reveal and the
        // landing mode come up together, and a toggle sent into the middle of
        // that is a race rather than a gesture.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${ROUTE_GROUP} button[data-choice-value="changes"]')?.getAttribute("data-state") === "active"`,
          { timeoutMs: 30000 },
        );
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          { timeoutMs: 30000 },
        );
        await app.dispatchControlAction("toggle-changes-view");
        // The ROUTE is what says the card left the room. The shade's own node
        // outlives the leaving by however long its exit takes, and under the
        // harness's suppressed motion that is not a duration worth waiting on.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${ROUTE_GROUP} button[data-choice-value="prompt"]')?.getAttribute("data-state") === "active"`,
          { timeoutMs: 30000 },
        );

        // ── The composer says what is being waited for ───────────────────
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PLACEHOLDER)}) !== null`,
          { timeoutMs: 20000 },
        );
        const placeholder = await app.body("A").evalJS<string>(
          `((document.querySelector(${JSON.stringify(PLACEHOLDER)})?.textContent) || "").trim()`,
        );
        note("at0560 placeholder", placeholder);
        expect(placeholder).toBe(READY_PLACEHOLDER);

        // ── The finished row stays a quiet line ──────────────────────────
        // Read after the placeholder, so the offer is known to be standing.
        expect(
          await finishButtons(app),
          "the finished row carries no act while the offer stands",
        ).toBe(0);
        note("at0560 receipt", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
