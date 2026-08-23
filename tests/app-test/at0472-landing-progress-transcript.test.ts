/**
 * AT0472 — the landing arc narrates in the transcript, not in the composer.
 *
 * ## Why this exists
 *
 * The join register — reconciling, checking, ready, joining, and the settled
 * sentence at the end — used to mount inside the prompt entry's status row.
 * That put an account of what the machine is doing inside the place the user
 * types. It is something to *read*, and everything else in a session that is
 * something to read is in the transcript.
 *
 * So it moved to the transcript's live edge: after the last row, inside the
 * scroller, un-indexed. Two claims follow, and this file pins both as
 * geometry rather than as intent.
 *
 * - **It is in the transcript, and it is not in the composer.** Present inside
 *   the transcript scroller; absent from `.tug-prompt-entry-status`. The
 *   negative is half the point — a register that rendered in both places would
 *   pass a presence-only test while the complaint stayed true.
 * - **It is pinned beneath the rows, not floating over them.** Its box starts
 *   below the last transcript row's, which is what "messages still scroll in
 *   above it" means when it is measured rather than asserted.
 *
 * And the arc's end: the progress is **ink in motion and is never ledgered**.
 * After the join lands, what the transcript durably carries is exactly one
 * join receipt — the same one at0436 pins — and no progress residue. That is
 * what keeps restore parity ([D111]) true by construction rather than by a
 * rule somebody has to remember.
 *
 * ## The fixture
 *
 * The join scratch repo with a clean merge and a trivial resolver, so the arc
 * runs at git speed and the dash is genuinely landable. The card is never
 * asked to open Changes: a bound dash that goes ready fronts the route by
 * itself (at0445), and this file rides that entry rather than performing its
 * own — which is also what makes the register's presence here unstaged.
 *
 * @covers tugdeck/src/components/tugways/cards/session-landing-progress-row.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/dash-join-register.tsx
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
  bindDash,
  makeJoinScratchRepo,
  rmJoinScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type JoinScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 420_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000472";
const DASH = "at0472-work";
const FILE = "subject.txt";

const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
/** The transcript scroller — the register has to be *inside* this one. */
const SCROLLER = `${CARD} [data-tug-scroll-key="session-card-transcript"]`;
/** The live-edge row, and the register it composes. */
const LIVE_EDGE = `${SCROLLER} [data-slot="session-landing-progress-row"]`;
const LIVE_REGISTER = `${LIVE_EDGE} [data-slot="dash-join-register"]`;
/** The room the register used to live in. */
const COMPOSER_STATUS = `${CARD} .tug-prompt-entry-status`;
const COMPOSER_REGISTER = `${COMPOSER_STATUS} [data-slot="dash-join-register"]`;
/** Every transcript row, so the last one's box can be measured. */
const TRANSCRIPT_ROWS = `${SCROLLER} .tug-list-view-cell[data-tug-list-cell-index]`;
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;
const JOIN_RECEIPT = `${CARD} [data-slot="join-receipt-block"]`;

/** The checkout whose built binaries the fixture drives. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: JoinScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeJoinScratchRepo({
    prefix: "at0472",
    dash: DASH,
    description: "at0472 live-edge register fixture",
    checkout: CHECKOUT,
    file: FILE,
    fork: "at0472 the file at the fork\n",
    base: "at0472 SENTINEL the base's own file\n",
    dashBody: "at0472 SENTINEL the dash rewrote it\n",
    cleanMerge: true,
    resolver: "#!/bin/sh\nexit 0\n",
  });
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmJoinScratchRepo(scratch);
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

/** The base branch's tip subject — where a join writes itself down. */
function baseTip(): string {
  return Bun.spawnSync(
    ["git", "-C", projectDir(), "log", "-1", "--format=%s", "main"],
    {},
  )
    .stdout.toString()
    .trim();
}

describe.skipIf(!SHOULD_RUN)("AT0472: landing progress is transcript ink", () => {
  test(
    "the register renders at the transcript's live edge beneath the last row, never in the composer, and leaves exactly one durable receipt behind",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0472-landing-progress-transcript",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // Nothing narrates yet: the precondition that makes every reading
        // below about the join rather than about the card's resting state.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(LIVE_EDGE)}) === null`,
          ),
          "an idle card puts no progress row at its live edge",
        ).toBe(true);

        // The bind is the whole gesture. The pilot reconciles it, the offer
        // stands, and the card fronts the Changes route on its own — which is
        // what enters join mode, and the register follows the mode.
        bindDash(projectDir(), DASH, SID, scratch?.cli ?? {});
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LIVE_REGISTER)}) !== null`,
          { timeoutMs: 240000 },
        );
        note(
          `at0472 live edge: ${JSON.stringify(
            await app.evalJS<string>(
              `document.querySelector(${JSON.stringify(LIVE_REGISTER)})?.getAttribute("data-word") ?? ""`,
            ),
          )}`,
        );

        // ── And nowhere near the composer ────────────────────────────────
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(COMPOSER_REGISTER)}).length`,
          ),
          "the prompt entry's status row carries no register at all",
        ).toBe(0);
        // Nowhere in the composer at all, not merely outside its status row:
        // the register left that component, it did not move within it. (The
        // Changes shade's own dash row still carries one — that mount is not
        // this file's subject and is deliberately untouched.)
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(`${CARD} [data-slot="tug-prompt-entry"] [data-slot="dash-join-register"]`)}).length`,
          ),
          "the composer carries no register anywhere in it",
        ).toBe(0);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(LIVE_REGISTER)}).length`,
          ),
          "and the live edge carries exactly one",
        ).toBe(1);

        // ── Pinned beneath the rows, measured ────────────────────────────
        // Not "after them in the DOM" — under them on screen, which is what
        // "messages still scroll in above it" means geometrically.
        const order = await app.evalJS<{ rows: number; lastBottom: number; edgeTop: number }>(
          `(function(){
             var rows = document.querySelectorAll(${JSON.stringify(TRANSCRIPT_ROWS)});
             var last = rows.length === 0 ? null : rows[rows.length - 1];
             var edge = document.querySelector(${JSON.stringify(LIVE_EDGE)});
             return {
               rows: rows.length,
               lastBottom: last === null ? -1 : last.getBoundingClientRect().bottom,
               edgeTop: edge === null ? -1 : edge.getBoundingClientRect().top,
             };
           })()`,
        );
        note(`at0472 geometry: ${JSON.stringify(order)}`);
        expect(order.rows, "the transcript has rows to sit beneath").toBeGreaterThan(0);
        expect(
          order.edgeTop,
          "the live-edge row starts below the last transcript row's bottom",
        ).toBeGreaterThanOrEqual(order.lastBottom);

        // ── The join lands, and the ink settles into a receipt ───────────
        // The card is already on the Changes route with the composer armed, so
        // the press is the composer's ⌘Return and nothing else.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          { timeoutMs: 60000 },
        );
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("Delete");
        await app.nativeType("at0472: land this dash");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent ?? "").indexOf("land this dash") !== -1`,
          { timeoutMs: 8000 },
        );
        const before = baseTip();
        await app.nativeKey("Return", ["cmd"]);

        // The base moving is the proof the join really ran — a register that
        // narrates a join nobody performed would be worse than none.
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline && baseTip() === before) await settle(500);
        expect(baseTip(), "the press reached the wire and the join integrated").not.toBe(
          before,
        );
        note(`at0472 landed: ${JSON.stringify(baseTip())}`);

        // One receipt, and it is the bespoke join block rather than the shell
        // fallback — the durable half of the arc, unchanged by the move.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length === 1`,
          { timeoutMs: 60000 },
        );

        // The progress row was never written down. Whatever it is saying now —
        // a settled sentence still resting, or nothing at all — the transcript
        // that replays from the ledger holds the receipt and no trace of it.
        await app.evalJS<null>(`(window.__tug.refreshInkRestore("A"), null)`);
        await settle(4000);
        const facts = await app.evalJS<{ shellTurns: number; commands: string[] }>(
          `window.__tug.inkRestoreFacts("A")`,
        );
        note(`at0472 ink: ${JSON.stringify(facts)}`);
        expect(
          facts.commands.filter((c) => c === "/dash-join").length,
          "one landing, one ink turn — progress at the live edge is never ledgered",
        ).toBe(1);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
