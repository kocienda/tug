/**
 * AT0471 — a deferred fronting re-arms, and fires when the room goes quiet.
 *
 * ## Why this exists
 *
 * at0445 pins the fronting itself: a bound reconciled arc puts the card on
 * the Changes route, unasked. This file pins the half of that contract nobody
 * could see, and the half that made the whole behavior read as random.
 *
 * The gate is four quiet-moment conditions — no turn in flight, no landing up,
 * an empty composer, the shade not already showing. Two of them used to be
 * read as one-shot peeks rather than as subscribed signals, and the
 * consequence was not a late entry but **no entry at all**: an offer arriving
 * over a half-typed composer returned without recording itself, intending a
 * retry, and nothing ever woke the decision again. Whether a ready arc was
 * ever presented came down to whether the composer happened to be empty at the
 * instant some unrelated dependency changed.
 *
 * So the claim here is a transition with no stimulus of its own: the arc goes
 * ready **while text is in the composer**, nothing happens, and then deleting
 * that text — one keystroke aimed at the editor, at nothing to do with arcs
 * — is what brings the room up and the route with it.
 *
 * The deferring state is produced rather than raced: the text is typed before
 * the arc is ever bound, so the composer is demonstrably non-empty for the
 * whole window the offer arrives in. Nothing here waits on two processes to
 * finish in an order.
 *
 * ## The fixture
 *
 * One scratch repository, one arc, never marked — the same shape at0445 uses,
 * for the same reason: a committed round on a clean worktree is the whole of
 * what arms a plan-less arc, and a `mark built` here would hide the day that
 * stops being true.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/lib/shade-view-controller.ts
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

const SID = "a7c0d1ea-0000-4000-8000-000000000471";
const ARC = "at0471-work";

const CARD = '[data-card-id="A"]';
const ENTRY = `${CARD} [data-slot="tug-prompt-entry"]`;
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
/** The Changes shade — its presence is the fronting, as in at0445. */
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-route-group`;

const ARCS_CARD = '.arcs-section';
const arcRegister = (arc: string): string =>
  `${ARCS_CARD} [data-slot="arcs-row"][data-arc="${arc}"] [data-slot="arc-join-register"]`;

/** The checkout whose built binaries the fixture drives. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch = "";
let dataRoot = "";
let fixtureDir = "";
let cli: { binaryRoot?: string; env?: Record<string, string> } = {};

beforeAll(() => {
  if (!SHOULD_RUN) return;
  const base = makeArcScratchRepo({ prefix: "at0471", checkout: CHECKOUT });
  scratch = base.repo;
  dataRoot = base.dataRoot;
  cli = base.cli;

  const arc = createArc(scratch, ARC, "at0471 deferred-fronting fixture", cli);
  writeFileSync(join(arc.worktree, "work.txt"), "at0471 the arc's file\n");
  commitRound(scratch, ARC, "at0471(round): the arc's work", cli);

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

/** Whether the shade is up right now. */
function shadeUp(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
  );
}

/**
 * Watch for the shade across a window and answer whether it ever appeared.
 * Sampled rather than read once at the end, so a fronting that fires and is
 * superseded still counts against the silence this asserts.
 */
async function shadeAppearsWithin(app: App, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await shadeUp(app)) return true;
    await settle(500);
  }
  return false;
}

describe.skipIf(!SHOULD_RUN)("AT0471: a deferred fronting re-arms", () => {
  test(
    "an arc going ready over a typed composer fronts nothing, and emptying the composer is what fronts it",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0471-changes-route-fronting",
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

        // The Arcs card is how the arc is read without touching the arc — the
        // register reaching `ready` is the offer standing, independent of
        // whether the card did anything about it.
        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector('${ARCS_CARD} [data-slot="arcs-row"][data-arc="${ARC}"]') !== null`,
          { timeoutMs: 40000 },
        );

        // ── The composer is made busy first ──────────────────────────────
        // Before the bind, so there is no window in which the offer could
        // arrive over an empty composer. One character is the whole of it:
        // the gate is emptiness, not length.
        await app.nativeClickAtElement(EDITOR);
        await app.nativeType("x");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ENTRY)})?.getAttribute("data-empty") === "false"`,
          { timeoutMs: 8000 },
        );
        note("at0471 composer holds a character — the quiet gate is shut");

        // ── The arc goes ready, and nothing happens ─────────────────────
        tugtool(["arc", "bind", ARC], {
          cwd: scratch,
          binaryRoot: cli.binaryRoot,
          env: { ...(cli.env ?? {}), TUG_SESSION_ID: SID },
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(arcRegister(ARC))})?.getAttribute("data-word") === "ready"`,
          { timeoutMs: 240000 },
        );
        note("at0471 ready: the offer stands");
        expect(
          await shadeAppearsWithin(app, 12000),
          "a standing offer waits out a composer somebody is typing in",
        ).toBe(false);
        expect(
          await app.evalJS<string | null>(
            `document.querySelector('${ROUTE_GROUP} button[data-choice-value="prompt"]')?.getAttribute("data-state") ?? null`,
          ),
          "and the card is still where the user left it",
        ).toBe("active");
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(ROUTE_GROUP)})?.hasAttribute("data-join-offer") ?? false`,
          ),
          "the segment wears the offer, so the wait is quiet rather than silent",
        ).toBe(true);

        // ── One keystroke, and the room comes up on its own ──────────────
        // Deleting the character is aimed at the editor and at nothing else.
        // Nothing about the arc changes; the deferred decision simply hears
        // that its gate opened. This is the whole subject of the file: with
        // emptiness read as a peek, this window is where the fronting was
        // lost for good.
        await app.nativeClickAtElement(EDITOR);
        await app.nativeKey("Backspace");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ENTRY)})?.getAttribute("data-empty") === "true"`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 30000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('${ROUTE_GROUP} button[data-choice-value="changes"]')?.getAttribute("data-state") === "active"`,
          { timeoutMs: 20000 },
        );
        note("at0471 fronted: emptying the composer brought the route up");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
