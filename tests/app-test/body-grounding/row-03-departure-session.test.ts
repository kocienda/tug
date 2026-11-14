/**
 * row-03-departure-session.test.ts — a Session card departs as one piece
 * through File › Close Card, and the hole closes with it.
 *
 * A piece of row 3 ([B02] row 3; the row is `_row-03.ts`'s), a test to a
 * file so each launch fits its own budget: a Session body card standing
 * above an unbound neighbour in one flow column, its stubbed turn run out so
 * the close asks nothing.
 *
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/HostFrameMeter.swift
 * @family row-03-departure
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "../streaming-stub-fixture";
import { FLOOR_BY_CANVAS, pollFor, settleFor } from "./_frames";
import { sessionUnderTest } from "./_kinds";
import {
  BODY_CARD,
  BODY_READY_MS,
  PLACED_MS,
  SHOULD_RUN,
  TEST_NAME,
  TEST_TIMEOUT_MS,
  bodyOf,
  column,
  departLeg,
  promptPhase,
} from "./_row-03";

describe.skipIf(!SHOULD_RUN)("body-grounding row 3: departure", () => {
  test.skipIf(!sessionUnderTest(3))(
    "File › Close Card: the hole closes in the frame the chrome leaves, and no frame shows the bare window",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: column, focusCardId: BODY_CARD });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-row03-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(2, 1)));
        await app.spawnSessionNew(BODY_CARD, { tugSessionId, projectDir });
        const shown = await settleFor(() => bodyOf(app, BODY_CARD), (b) => b !== null && b.visible, BODY_READY_MS);
        expect(shown?.visible, "the body card's body is placed visible").toBe(true);

        // The turn the stub replays runs out, so the close asks nothing.
        const body = app.body(BODY_CARD);
        await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 90_000 });
        await app.dispatchControlAction("focus-session-card", { cardId: BODY_CARD });
        await pollFor(() => app.getFocusedCardId(), (id) => id === BODY_CARD, PLACED_MS);
        await Bun.sleep(400);

        // By canvas, as on a rail: the Session card draws its own chrome, and
        // its greys sit within a classifier's reach of the grid's colour.
        await departLeg(app, BODY_CARD, FLOOR_BY_CANVAS);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
