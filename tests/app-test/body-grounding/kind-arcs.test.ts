/**
 * kind-arcs.test.ts — the Arcs card is a body, and everything it is for works
 * in its body.
 *
 * One body Session card spawned in a scratch repository that holds an
 * unbound arc, then the Arcs rail opened the user's way:
 *
 * - **It mounts as a body** holding the Arcs card, and the shell's document
 *   holds no arcs list.
 * - **Its data** — the scratch repository's arc is a row, reached the
 *   production way: tugcast's arc state for an open workspace.
 * - **It follows** the Session card focused before it: the row offers Bind
 *   unrefused, so its Bind target is that card's session, read off the card
 *   context the shell sends the body.
 * - **Its own interactions** — the row's menu opens inside the body and
 *   offers Bind.
 * - **Its surface** — the body paints the rail's sunken surface, read off the
 *   composite.
 *
 * @covers tugdeck/src/components/arcs/arcs-card-registration.tsx
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/components/tugways/tug-editor-context-menu.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "../_harness";
import { bodyOfKind } from "../_harness/card-reach";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "../_harness/tugbank-helpers";
import { createArc, makeArcScratchRepo, rmArcScratchRepo, type ArcScratchRepo } from "../arc-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "../streaming-stub-fixture";
import { pollFor, settleFor, sessionPane, waitForBody } from "./_bodies";
import { expectRailSurface } from "./_kind-bodies";
import { cardKind } from "./_kinds";

const TEST_NAME = "body-grounding-kind-arcs";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const READ_MS = 30_000;

const A = "ka-a";
const SID = "a7c0d1ea-0000-4000-8000-0000000007a1";
const ARC = "kind-arcs-run";

const ROW = `.arcs-section [data-slot="arcs-row"][data-arc="${ARC}"]`;
const BIND = `${ROW} [data-slot="arc-verb"][data-verb="bind"]`;
const MENU = '[data-slot="tug-editor-context-menu"]';
const MENU_BIND = `${MENU} [data-item-action="bind-arc"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", "..", ".."));

let scratch: ArcScratchRepo | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "kind-arcs", checkout: CHECKOUT });
  createArc(scratch.repo, ARC, "kind check arc", scratch.cli);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
});

const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;
const bindState = `(function () {
  var b = document.querySelector(${JSON.stringify(BIND)});
  return b === null ? "absent" : b.getAttribute("data-refused") === "true" ? "refused: " + b.getAttribute("aria-label") : "offered";
})()`;

describe.skipIf(!SHOULD_RUN)("body-grounding kind check: Arcs", () => {
  test(
    "the Arcs card mounts as a body, lists the workspace's arc, follows the focused Session card, and opens its row menu there",
    async () => {
      const projectDir = scratch?.repo ?? "";
      const stubDir = stubDirectory();
      writeFileSync(join(stubDir, `${SID}.json`), JSON.stringify(streamingTranscript(2, 1)));
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir, TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.seedDeckState({
          state: {
            cards: [{ id: A, componentId: "session", title: "A", closable: true }],
            panes: [sessionPane(A, 0)],
            activePaneId: `${A}-pane`,
            hasFocus: true,
          },
          focusCardId: A,
        });
        // A spawned session, so the scratch repo is a workspace whose arcs
        // reach the Arcs card, and the card it follows has a binding.
        await app.spawnSessionNew(A, { tugSessionId: SID, projectDir });
        await waitForBody(app, A);

        await app.dispatchControlAction("toggle-arcs");
        const arcs = await bodyOfKind(app, "dashes");
        const arcsId = arcs.cardId;
        const up = await settleFor(() => arcs.evalJS<boolean>(present(cardKind("dashes").root)), (v) => v, READ_MS);
        expect(up, "the Arcs card is mounted in its body").toBe(true);
        // card-dom: shell
        expect(await app.evalJS<boolean>(present(".arcs-section")), "the shell's document holds no arcs list").toBe(false);

        // ── Its data, and the card it follows ───────────────────────────
        const row = await settleFor(() => arcs.evalJS<boolean>(present(ROW)), (v) => v, READ_MS);
        expect(row, "the workspace's arc is a row in the Arcs body").toBe(true);
        const bind = await settleFor(() => arcs.evalJS<string>(bindState), (s) => s === "offered", READ_MS);
        note(`Arcs body Bind: ${bind}`);
        expect(bind, "the Arcs body offers Bind to the followed Session card's session").toBe("offered");

        // ── The row's menu opens inside the body ────────────────────────
        await arcs.nativeClickAtElement(ROW, { button: "right" });
        const menu = await settleFor(() => arcs.evalJS<boolean>(present(MENU_BIND)), (v) => v, 5_000);
        expect(menu, "the row's menu opens in the Arcs body and offers Bind").toBe(true);
        await app.nativeKey("Escape");

        // ── Surface ─────────────────────────────────────────────────────
        await expectRailSurface(app, arcsId);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
