/**
 * at0627-shade-refusals-speak-in-the-shade.test.ts — **a shade verb the server
 * really refuses, reported inside the shade the press was made in.**
 *
 * ## What this is
 *
 * at0530 pins the *landing* half of the same rule: a `/commit` git refuses
 * speaks in the Changes shade's notice band rather than in the card's top-right
 * bulletin lane, which the shade's own scrim dims. This file pins the other
 * half — the shade's own verbs. Claim, disclaim, discard and Auto-Message each
 * had a zero-render controller posting their refusals into that same corner
 * lane; all three controllers are gone and the band reads their store slots
 * directly.
 *
 * ## Why the verb under test is Discard rather than Claim
 *
 * The four verbs share one seat, one rank and one code path into the band, so
 * proving the seat needs one of them, and the one to pick is the one whose
 * refusal a fixture can produce **for real**. A claim is refused only by a
 * guard on the project registry or by the ledger's own write failing, and
 * neither is reachable from a test without publishing a frame the app did not
 * receive or attacking a live SQLite ledger — both of which would make the
 * fixture prove the band renders what a test handed it rather than what the
 * server said.
 *
 * Discard has a refusal that is documented, deterministic, and changes nothing:
 * `discard_in` runs `working_set_hand_back` above every write and **refuses the
 * whole discard** when the base checkout holds its own uncommitted edit to a
 * path the arc's worktree also changed without committing — because handing the
 * arc's work back would overwrite the user's. So the fixture writes exactly
 * that conflict, in a scratch repository of its own, and presses the real
 * Discard. Nothing is published, the arc survives the press by construction,
 * and the sentence the band carries is `tugarc-core`'s own.
 *
 * ## Why the shade is raised by ⌃⌘C and not by `/commit`
 *
 * A landing outranks a verb refusal in the band's order, and deliberately so —
 * a landing is the gesture the shade exists for. Raising the shade by typing
 * `/commit` would leave commit mode standing, so a gate refusal could seat
 * itself over the discard's and the assertion would pass or fail on which
 * tenant won. ⌃⌘C raises the shade with no landing at all, which is the state
 * this file is actually about.
 *
 * ## The four things it proves
 *
 *   1. **The band carries the verb's own words.** Title "Discard failed", and
 *      the server's sentence as the body.
 *   2. **It is inside the shade.** The notice's box is contained by the shade's
 *      — the same containment at0530 measures for the landing.
 *   3. **The shade still ends where it ended.** The shade's bottom edge sits at
 *      the composer region's top within a pixel, measured rather than merely
 *      "above", so a band that ever pushed downward instead of growing the
 *      shade upward lands red here (R05).
 *   4. **The corner lane is empty of it.** `[data-sonner-toast]` carries nothing
 *      the refused discard produced — which is the capability this arc removed,
 *      not merely a caller it moved.
 *
 * ## What this file deliberately does not declare
 *
 * `session-card.tsx` is at the selection budget's ceiling and naming it here
 * would push it past, turning a one-line edit to the card into a sweep; at0436
 * already declares it. `shade-raise-on-shade-refusal-controller.tsx` is not
 * declared either, and that is honest rather than an omission: the raise
 * watches claim and disclaim only, and a refused discard never asks it for
 * anything.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-notice.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/lib/changeset-verb-store.ts
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

const SID = "a7c0d1ea-0000-4000-8000-000000000627";
const ARC = "at0627-work";
/** The one path both sides edit without committing — the hand-back's conflict. */
const SHARED = "at0627-shared.txt";

const CARD = '[data-card-id="A"]';
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;
const ROW = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC}"]`;
const CONFIRM = '[data-slot="tug-confirm-confirm"]';
/** The composer region the shade's bottom edge must still sit flush against. */
const ENTRY_REGION = `${CARD} [data-slot="session-card-entry-region"]`;
const NOTICE = `${CARD} [data-slot="session-changes-notice"]`;
const ERROR_NOTICE = `${NOTICE}[data-channel="error"]`;
const BULLETIN_TEXTS = `Array.from(document.querySelectorAll('[data-sonner-toast]')).map(function(e){ return e.textContent || ""; })`;

/** This checkout — the build under test, never the tree the fixture dirties. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
let tugbankPath = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0627", checkout: CHECKOUT });
  // Tracked before the arc is cut, so both trees have the path at their fork.
  writeFileSync(join(projectDir(), SHARED), "at0627 the shared file\n");
  gitRetry(projectDir(), "add", SHARED);
  gitRetry(projectDir(), "commit", "-m", "at0627: seed the path both sides will edit");

  const arc = createArc(projectDir(), ARC, "at0627 fixture (a discard to refuse)", scratch.cli);
  // The hand-back's two halves. The arc changed the path without committing, so
  // its worktree holds the only copy of that edit and the discard would hand it
  // back; the base changed the same path without committing, so handing it back
  // would overwrite the user's own work. That pair is the refusal, and
  // `working_set_hand_back` runs above every write — the arc survives the press.
  writeFileSync(join(arc.worktree, SHARED), "at0627 the arc's uncommitted edit\n");
  writeFileSync(join(projectDir(), SHARED), "at0627 the base's uncommitted edit\n");

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

/** Raise the Changes shade with no landing standing — ⌃⌘C, and nothing else. */
async function raiseChangesShade(app: App): Promise<void> {
  await app.nativeKey("c", ["ctrl", "cmd"]);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
    { timeoutMs: 20_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0627: a shade refusal speaks in the shade", () => {
  test(
    "a discard the server refuses lands in the shade's band, not the corner lane",
    async () => {
      tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0627-shade-refusals-speak-in-the-shade",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        // A real session spawn, not a bind: the scratch repo reaches the server
        // the only way a project ever does — a session registering its
        // workspace. The arc is left unbound, which is a row Discard reaches.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        await raiseChangesShade(app);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 40_000 },
        );

        // The shade at rest, before the notice exists: the edge the band must
        // not move. Read here rather than after, so a band that pushed the shade
        // downward is a difference rather than an absolute nobody can check.
        await settle(1_500);
        const before = await app.evalJS<{ shadeBottom: number; entryTop: number }>(
          `(function(){
             const r = function(sel){ const e = document.querySelector(sel); return e === null ? null : e.getBoundingClientRect(); };
             const shade = r(${JSON.stringify(SHEET)});
             const entry = r(${JSON.stringify(ENTRY_REGION)});
             return {
               shadeBottom: shade === null ? -1 : shade.bottom,
               entryTop: entry === null ? -1 : entry.top,
             };
           })()`,
        );
        note(`at0627 the shade's bottom edge before the refusal: ${JSON.stringify(before)}`);

        // ── The press ────────────────────────────────────────────────────
        // Discard stands on the row's verb row and asks before it destroys,
        // so the gesture is two acts: the verb arms the confirm, the confirm
        // sends it.
        await pressArcRowMenuItem(app, ROW, "request-discard-arc");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.nativeClickAtElement(CONFIRM);

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ERROR_NOTICE)}) !== null`,
          { timeoutMs: 60_000 },
        );
        const notice = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(ERROR_NOTICE)})?.textContent ?? "")`,
        );
        note(`at0627 the notice in the shade: ${JSON.stringify(notice)}`);
        note("at0627 the refused discard speaks in the shade", (await app.screenshot()).path);

        // 1. The band carries the verb's own words.
        expect(notice, "the band names the verb that was refused").toContain(
          "Discard failed",
        );
        expect(notice, "and carries the server's own sentence").toContain(
          "the base checkout has its own uncommitted changes",
        );

        // 2. It is inside the shade, and 3. the shade still ends where it did.
        await settle(1_500);
        const boxes = await app.evalJS<{
          shadeTop: number;
          shadeBottom: number;
          noticeTop: number;
          noticeBottom: number;
          entryTop: number;
        }>(
          `(function(){
             const r = function(sel){ const e = document.querySelector(sel); return e === null ? null : e.getBoundingClientRect(); };
             const shade = r(${JSON.stringify(SHEET)});
             const notice = r(${JSON.stringify(ERROR_NOTICE)});
             const entry = r(${JSON.stringify(ENTRY_REGION)});
             return {
               shadeTop: shade === null ? -1 : shade.top,
               shadeBottom: shade === null ? -1 : shade.bottom,
               noticeTop: notice === null ? -1 : notice.top,
               noticeBottom: notice === null ? -1 : notice.bottom,
               entryTop: entry === null ? -1 : entry.top,
             };
           })()`,
        );
        note(`at0627 the notice's geometry inside the shade: ${JSON.stringify(boxes)}`);
        expect(
          boxes.noticeTop >= boxes.shadeTop,
          "the notice's top is at or below the shade's top edge",
        ).toBe(true);
        expect(
          boxes.noticeBottom <= boxes.shadeBottom,
          "the notice's bottom is at or above the shade's bottom edge",
        ).toBe(true);
        // R05: the band grows the shade *upward*, so the bottom edge is still
        // flush with the composer. Measured against the composer's own top
        // rather than against `before`, so a shade that moved for any other
        // reason cannot launder the assertion.
        expect(
          Math.abs(boxes.shadeBottom - boxes.entryTop),
          "the shade's bottom edge still sits at the composer's top",
        ).toBeLessThanOrEqual(1);

        // 4. The corner lane is empty of it.
        const corner = await app.evalJS<string[]>(BULLETIN_TEXTS);
        note(`at0627 corner bulletins after the refusal: ${JSON.stringify(corner)}`);
        expect(
          corner.every(
            (t) =>
              !t.includes("Discard failed") &&
              !t.includes("the base checkout has its own uncommitted changes"),
          ),
          "the corner lane carries nothing the refused discard produced",
        ).toBe(true);

        // The refusal changed nothing: `working_set_hand_back` runs above every
        // write, so the arc is still standing and still a row.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          ),
          "a refused discard leaves the arc where it was",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
