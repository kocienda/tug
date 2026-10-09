/**
 * at0683-arc-row-join.test.ts — Join pressed on an arc row lands the arc.
 *
 * ## What this gates
 *
 * A ready arc's verb row leads with **Join**, and pressing it is the same
 * `changeset_join` the composer's `/arc-join` sends, through the same verb
 * store, for the arc's bound session with the arc's own drafted message
 * ([B05]). The row has no composer, so the message is the draft the arc
 * already carries. (Its refusals — unbound, its card closed, no draft — are
 * the derivation's, pinned in `lib/__tests__/arc-verbs.test.ts`; an arc with a
 * round always carries a maintained draft, so the last is not reachable here.)
 *
 * The fixture is at0496's — a scratch repository with one landable round and a
 * clean merge — bound to the card, so the Changes shade's lane fronts it. The
 * test writes a draft of its own through the CLI into this launch's ledger,
 * waits for the row to show it, presses Join, and then reads the **base's git
 * log**: the squash commit carrying that draft's subject is the proof the press
 * landed the arc with the arc's own message, rather than any face that could
 * be painted without one.
 *
 * @covers tugdeck/src/lib/arc-join-press.ts
 * @covers tugdeck/src/lib/arc-verbs.ts
 * @covers tugdeck/src/components/tugways/arc-verb-row.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-lane.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
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
  tugtool,
  type JoinScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** Minted per run, for the reason at0496 gives: a fixed id lets another live
 *  instance's stale row answer `arc bind` for this run. */
const SID = randomUUID();
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;

const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const ARC = "at0683-work";
const ROW = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC}"]`;
const JOIN = `${ROW} [data-slot="arc-verb"][data-verb="join"]`;
const DRAFT_MESSAGE = "at0683 join draft\n\nLanded by the row's Join verb.";

let scratch: JoinScratchRepo | null = null;
const projectDir = (): string => scratch?.repo ?? "";
let fixtureDir = "";
let tugbankPath = "";
let arcId = "";

/** The launch's private changes ledger — where the draft must be written for
 *  the app to read it (at0405 says why). */
const instanceChangesDb = (instanceId: string): string =>
  join(scratch?.dataRoot ?? "", "Tug/instances", instanceId, "changes.db");

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeJoinScratchRepo({
    prefix: "at0683",
    arc: ARC,
    description: "at0683 fixture (a round to land)",
    checkout: CHECKOUT,
    file: "subject.txt",
    fork: "at0683 the arc's file\n",
    base: "at0683 the base's own file\n",
    arcBody: "at0683 the arc rewrote it\n",
    cleanMerge: true,
    resolver: "#!/bin/sh\nexit 0\n",
  });
  arcId = scratch.arcId;
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
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

/** Open the Changes shade the way a user does, retried until the lane shows
 *  the arc — the feed arrives on its own schedule. */
async function openTheShade(app: App): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    await app.nativeClickAtElement(EDITOR);
    await settle();
    await app.nativeKey("a", ["cmd"]);
    await app.nativeKey("Delete");
    await app.nativeType("/commit");
    await settle();
    await app.nativeKey("Escape");
    await settle();
    await app.nativeKey("Return", ["cmd"]);
    try {
      await app.waitForCondition<boolean>(
        `document.querySelector(${JSON.stringify(ROW)}) !== null`,
        { timeoutMs: 20000 },
      );
      return;
    } catch {
      note(`at0683 the shade did not show the arc (attempt ${attempt})`);
    }
  }
  throw new Error("at0683: the Changes shade never showed the arc");
}

/** The subject of the base's newest commit. */
function baseSubject(): string {
  const out = Bun.spawnSync(["git", "-C", projectDir(), "log", "-1", "--format=%s"]);
  return new TextDecoder().decode(out.stdout).trim();
}

describe.skipIf(!SHOULD_RUN)("AT0683: Join on an arc row lands the arc", () => {
  test(
    "Join leads a ready arc's row, and lands the arc with its draft",
    async () => {
      tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0683-arc-row-join",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        bindArc(projectDir(), ARC, SID, scratch?.cli ?? {});
        silenceJoinPrompt(projectDir(), ARC);
        await app.dispatchControlAction("bind_arc_ok", {
          tug_session_id: SID,
          arc_id: arcId,
          arc_name: ARC,
        });
        await openTheShade(app);

        // ── Join leads the row on a ready arc. ──
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN)}) !== null`,
          { timeoutMs: 30000 },
        );
        const offered = await app.evalJS<{ label: string; lead: boolean }>(
          `(() => {
             const el = document.querySelector(${JSON.stringify(JOIN)});
             const row = el.closest('[data-slot="arc-verb-row"]');
             return {
               label: el.getAttribute("aria-label") ?? "",
               lead: row.querySelector('[data-slot="arc-verb"]') === el,
             };
           })()`,
        );
        note(`at0683 Join offered: ${JSON.stringify(offered)}`);
        expect(offered.lead, "Join is the row's first verb on a ready arc").toBe(true);
        expect(offered.label).toContain(`Join arc ${ARC} onto`);

        // ── Write a draft of the test's own, and wait for the row to carry
        //    it. A file in the project wakes the aggregate's recompose, as
        //    at0405 does; it is removed before the press. ──
        tugtool(
          ["draft", "set", "--owner", `arc:${ARC}`, "--message", DRAFT_MESSAGE, "--json"],
          {
            cwd: projectDir(),
            binaryRoot: CHECKOUT,
            env: {
              ...scratch?.cli.env,
              TUG_CHANGES_DB: instanceChangesDb(app.instanceId),
            },
          },
        );
        const nudge = join(projectDir(), "at0683-nudge.txt");
        writeFileSync(nudge, "at0683 recompose nudge\n");
        try {
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(`${ROW} [data-slot="session-changes-arc-brief-subject"]`)})?.textContent ?? "").includes("at0683 join draft")`,
            { timeoutMs: 30000 },
          );
        } finally {
          rmSync(nudge, { force: true });
        }
        // The composer's join gate judges the row's Join too, so it is pressed
        // only once the gate admits it — a join state that has not yet
        // recomposed past the nudge reads as blocked, exactly as it would to
        // the composer.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN)})?.getAttribute("data-refused") === null`,
          { timeoutMs: 30000 },
        );
        const subjectBefore = baseSubject();

        // ── Press it. The base gains the squash commit carrying the draft. ──
        await app.nativeClickAtElement(JOIN);
        const deadline = Date.now() + 60_000;
        let subject = subjectBefore;
        while (Date.now() < deadline && !subject.includes("at0683 join draft")) {
          await settle(500);
          subject = baseSubject();
        }
        note(`at0683 base subject after the press: ${JSON.stringify(subject)}`);
        expect(subject, "the press landed the arc with its draft").toContain(
          "at0683 join draft",
        );
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0683] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
