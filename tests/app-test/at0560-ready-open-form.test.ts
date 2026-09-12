/**
 * at0560-ready-open-form.test.ts — what the open card offers while its arc's
 * join offer stands.
 *
 * ## What this gates
 *
 * The folded form's side of Ready is at0559's. This is the open form's, and it
 * is two surfaces the reader meets without going anywhere:
 *
 *   1. **The finished receipt grows a Join** ([B04]). The transcript row that
 *      reported the arc's ending is a frozen record of a past moment, and it
 *      makes exactly one live reading: whether the offer it would act on is
 *      still standing, for the arc THIS row names. So the same row carries a
 *      Join while the offer stands, and a receipt naming a different arc — a
 *      card that has moved on — carries none, in the same transcript at the
 *      same instant. That negative is the whole of why the match is by arc
 *      rather than by mere presence.
 *   2. **The composer says what is being waited for** ([B05]). A state that
 *      calls for the user and does not say what they are called for is a dot
 *      with no sentence under it, so the placeholder says both halves — that
 *      the work is done, and the one act that lands it — while keeping the
 *      composer's own invitation, because Ready is not a block.
 *
 * And one about the Join's reach: it performs no join. It routes through the
 * card's one reveal path ([D152]) and arms the room, which is the same room
 * the passive reveal and ⌃⌘C open — so pressing it puts the card on the
 * Changes route with the Z5 that lands, and the decision is still the user's
 * to make in front of the diff.
 *
 * The arc is real — a scratch repository, one arc, one committed round, the
 * pilot deriving readiness with nothing marked. The shade reveals itself first,
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
/** An arc name this card is not on: the receipt that must grow nothing. */
const OTHER_ARC = "at0560-elsewhere";

const CARD = '[data-card-id="A"]';
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-route-group`;
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;
const PLACEHOLDER = `${CARD} [data-slot="tug-prompt-entry"] .cm-placeholder`;
/** Every finished-arc row in the transcript, and the Join a standing offer grows on one. */
const FINISH_ROW = `${CARD} [data-slot="arc-finish-row"]`;
const FINISH_JOIN = `${CARD} [data-slot="arc-finish-join"]`;

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

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 1000, height: 720 },
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

/** How many Joins stand on finished rows naming `arc` right now. */
function joinsFor(app: App, arc: string): Promise<number> {
  return app.evalJS<number>(
    `Array.from(document.querySelectorAll(${JSON.stringify(FINISH_ROW)}))
       .filter(function (row) {
         return (row.textContent || "").indexOf(${JSON.stringify(arc)}) !== -1;
       })
       .filter(function (row) {
         return row.querySelector('[data-slot="arc-finish-join"]') !== null;
       }).length`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0560: a standing offer on an open card", () => {
  test(
    "the finished row for THIS arc grows a Join and another arc's does not, the composer says what is waited for, and the Join arms the room rather than landing anything",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0560-ready-open-form",
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

        // The two rows the card will carry: the arc it is on, and one naming
        // an arc it is not. Both are filed before the offer exists, so neither
        // can be said to have been rendered into a state it already knew.
        for (const [arc, exchangeId] of [
          [ARC, "at0560-finish-bound"],
          [OTHER_ARC, "at0560-finish-other"],
        ] as const) {
          await app.driveSession("A", {
            op: "shellExchange",
            exchangeId,
            command: "/arc-run",
            output: receiptText(arc),
            cwd: scratch,
            exitCode: 0,
            startedAtMs: 1_700_000_000_000,
          });
        }
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${CARD} [data-slot="arc-finish-line"]').length === 2`,
          { timeoutMs: 30000 },
        );
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(FINISH_JOIN)}).length`,
          ),
          "a finished arc with no standing offer is the quiet line it has always been",
        ).toBe(0);

        // The real `arc bind` verb: the pilot works from the LEDGER row.
        tugtool(["arc", "bind", ARC], {
          cwd: scratch,
          binaryRoot: cli.binaryRoot,
          env: { ...(cli.env ?? {}), TUG_SESSION_ID: SID },
        });

        // The offer arrives on an open card with an empty composer, so the
        // room reveals itself (at0445's subject). Close it: this file's two
        // surfaces are both in the transcript the close returns to, and
        // closing costs nothing.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 240000 },
        );
        // Let the entry finish arriving before closing it. The reveal and the
        // landing mode come up together, and a toggle sent into the middle of
        // that is a race rather than a gesture.
        await app.waitForCondition<boolean>(
          `document.querySelector('${ROUTE_GROUP} button[data-choice-value="changes"]')?.getAttribute("data-state") === "active"`,
          { timeoutMs: 30000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          { timeoutMs: 30000 },
        );
        await app.dispatchControlAction("toggle-changes-view");
        // The ROUTE is what says the card left the room. The shade's own node
        // outlives the leaving by however long its exit takes, and under the
        // harness's suppressed motion that is not a duration worth waiting on.
        await app.waitForCondition<boolean>(
          `document.querySelector('${ROUTE_GROUP} button[data-choice-value="prompt"]')?.getAttribute("data-state") === "active"`,
          { timeoutMs: 30000 },
        );

        // ── The receipt grows a Join, for its own arc only ───────────────
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(FINISH_JOIN)}).length === 1`,
          { timeoutMs: 30000 },
        );
        expect(
          await joinsFor(app, ARC),
          "the row reporting the arc whose offer stands carries the act",
        ).toBe(1);
        expect(
          await joinsFor(app, OTHER_ARC),
          "and a row about an arc this card is not on carries nothing",
        ).toBe(0);
        note("at0560 receipt", (await app.screenshot()).path);

        // ── The composer says what is being waited for ───────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PLACEHOLDER)}) !== null`,
          { timeoutMs: 20000 },
        );
        const placeholder = await app.evalJS<string>(
          `((document.querySelector(${JSON.stringify(PLACEHOLDER)})?.textContent) || "").trim()`,
        );
        note("at0560 placeholder", placeholder);
        expect(placeholder).toBe(READY_PLACEHOLDER);

        // ── The Join arms the room; it does not land ─────────────────────
        // The full click sequence, which is what the button's own handler
        // conditions on. Where the room ends up is the claim, and the route
        // is what carries it.
        await app.click(FINISH_JOIN);
        await app.waitForCondition<boolean>(
          `document.querySelector('${ROUTE_GROUP} button[data-choice-value="changes"]')?.getAttribute("data-state") === "active"`,
          { timeoutMs: 20000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 30000 },
        );
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          ),
          "the room it opens is the armed one, and the landing is still the user's press",
        ).toBe(true);
        // Nothing landed: the offer is still standing, which is what the row's
        // own Join still being there says.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(FINISH_JOIN)}).length`,
          ),
          "the button routed, it did not spend the offer",
        ).toBe(1);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
