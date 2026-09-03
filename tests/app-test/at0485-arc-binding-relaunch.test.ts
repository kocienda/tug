/**
 * at0485-arc-binding-relaunch.test.ts — a card rotated into an arc stage
 * comes back BOUND after a relaunch ([AT0485]).
 *
 * ## What this gates
 *
 * An arc binding is written against the session id that is the card's at the
 * time — the tug session id, which a rotation never changes while the process
 * lives. The rotation's own segment is minted on the same line with no
 * binding of its own. A relaunch seats the card on the line's tip ([P06]),
 * which is that unbound segment, so a restore that read the binding off the
 * seat reported the card unbound while the arc record still named it
 * mid-stage; the user rebound by hand and the arc re-ran its stage.
 *
 * tugcast now moves each seated line's binding onto the resumed segment at
 * startup, right after the demote. This drives that from the outside:
 *
 *   1. a real arc in a scratch repository, so the restore's live-branch
 *      check has a branch to find;
 *   2. the ledger state a rotation leaves behind — two rows on one line, the
 *      root bound and the stage forked from it — seeded through the bundle's
 *      own `tugcast --seed-ledger`;
 *   3. a full process relaunch resuming the stage, and the card's masthead
 *      read for the `^<arc>` sigil — the identity surface that reads the
 *      account-global aggregate's `bound_sessions`, which only a live row
 *      carrying the binding can reach.
 *
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 * @covers tugrust/crates/tugcast/src/main.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugdeck/src/lib/arc-session-index.ts
 * @covers tugdeck/src/lib/card-session-binding-store.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createArc,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** The line of work. Both segments below are segments of it. */
const LINE = "c1a0d1ea-0000-4000-8000-000000000485";
/** The root segment — the tug session id the bind was written against. */
const ROOT = "c1a0d1ea-0000-4000-8000-000000000486";
/** The stage the card rotated into — the line's tip, and the resume target. */
const STAGE = "c1a0d1ea-0000-4000-8000-000000000487";

const TAG = "stout-otter";
const ARC = "at0485-arc";

const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const INSTANCE_ID = `${process.env.TUG_APPTEST_ID_PREFIX ?? "apptest"}-arc-relaunch-${randomUUID()}`;

const MASTHEAD_ARC = '[data-slot="session-masthead"] [data-slot="session-identity-arc"]';

let scratch: ArcScratchRepo | null = null;
let arcId = "";
const fixtureDirs: string[] = [];
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0485", checkout: CHECKOUT });
  arcId = createArc(projectDir(), ARC, "at0485 relaunch binding", scratch.cli).id;
  for (const id of [ROOT, STAGE]) {
    fixtureDirs.push(seedScratchSession(projectDir(), id));
  }
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  for (const dir of fixtureDirs) rmScratchSession(dir);
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

/**
 * The two segments of one line, exactly as a rotation leaves the ledger: both
 * live, the root bound. The relaunch's own demote closes them — the seed
 * cannot say `closed` here, because a seeded close is a `mark_closed`, which
 * releases the binding the test is about ([L27]).
 */
function seedTheLine(app: App): void {
  const repo = projectDir();
  app.seedLedger({
    sessions: [
      {
        session_id: ROOT,
        workspace_key: repo,
        project_dir: repo,
        card_id: "A",
        line_id: LINE,
        tag: TAG,
        arc_id: arcId,
        arc_name: ARC,
      },
      {
        session_id: STAGE,
        workspace_key: repo,
        project_dir: repo,
        card_id: "A",
        line_id: LINE,
        forked_from_session_id: ROOT,
        stage_label: "devise",
        stage_model: "opus",
      },
    ],
  });
}

async function awaitDeck(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0485 — an arc binding survives a relaunch", () => {
  test(
    "a card resumed on its rotated segment reads bound to the arc it was on",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const env = { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" };
      try {
        // ── Phase A: write the ledger state a rotation leaves behind. ──
        // Seeded after launch: `demote_live_to_closed` flips every live row
        // at startup, so a row seeded before one would arrive closed.
        {
          const app = await launchTugApp({
            testName: "at0485-arc-binding-relaunch-A",
            instanceId: INSTANCE_ID,
            env,
          });
          try {
            await awaitDeck(app);
            seedTheLine(app);
          } finally {
            await app.close();
          }
        }

        // ── Phase B: relaunch, resume the tip, read the masthead. ──
        {
          const app = await launchTugApp({
            testName: "at0485-arc-binding-relaunch-B",
            instanceId: INSTANCE_ID,
            env,
          });
          try {
            await app.enableDeckTrace(true);
            await awaitDeck(app);
            await app.spawnSessionResume("A", { tugSessionId: STAGE, projectDir: projectDir() });
            await app.awaitEngineReady("A", { timeoutMs: 15_000 });

            const facts = await app.evalJS<{ tugSessionId: string; lineId: string }>(
              `window.__tug.cardLineFacts("A")`,
            );
            expect(facts.tugSessionId, "seated on the rotated segment").toBe(STAGE);
            expect(facts.lineId, "bound to the line").toBe(LINE);

            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(MASTHEAD_ARC)}) !== null`,
              { timeoutMs: 20_000 },
            );
            const sigil = await app.evalJS<string>(
              `(document.querySelector(${JSON.stringify(MASTHEAD_ARC)})?.textContent ?? "").trim()`,
            );
            note(`at0485 masthead arc sigil after relaunch: ${JSON.stringify(sigil)}`);
            expect(sigil, "the binding followed the seat").toContain(ARC);
          } finally {
            await app.close();
          }
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
