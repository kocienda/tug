/**
 * sc-busy-done.test.ts — the site's busy-to-done clip: one Session card
 * streaming a turn, and the turn ending — the dot settles, the wave
 * withdraws, the sparkline tails off.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: one Session card filling a one-up, bound to a stub transcript
 * of one short turn (`streaming-stub-fixture.ts`), prompted so it streams
 * through the real feed. The loop opens as the stream begins and runs past
 * the turn's end, so the clip carries both states and the change between
 * them. The capture is cropped to the card — its masthead through its
 * status row.
 *
 * @visible
 */

import { describe, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { pollFor } from "../body-grounding/_frames";
import { startStreams, streamingTranscript, stubDirectory, type StubCard } from "../streaming-stub-fixture";
import { RUNS, cropFor, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const CARD = "sc-busy";

/** One message streams for about four seconds at the fixture's pace. */
const MESSAGES = 1;
/** The loop: the stream, its end, and the indicators settling after it. */
const LOOP_MS = 9_000;
const STATUS_BAR = '[data-slot="session-card-status-bar"]';
/** The project the masthead names: a plain directory, since the masthead shows its basename. */
const PROJECT_NAME = "tug-site";
const BOUND_MS = 30_000;

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: `${CARD}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 720, height: 560 },
        cardIds: [CARD],
        activeCardId: CARD,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${CARD}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/**
 * Bind the card to a stub session the way `bindStreamingStubs` does, but in
 * a project directory with a readable name — the masthead shows the
 * directory's basename beside the session's name.
 */
async function bindStub(app: App, stubDir: string): Promise<StubCard> {
  const tugSessionId = randomUUID();
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sc-busy-")));
  onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
  const projectDir = join(scratch, PROJECT_NAME);
  mkdirSync(projectDir);
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(MESSAGES)));
  await app.spawnSessionNew(CARD, { tugSessionId, projectDir });
  await pollFor(
    () =>
      app
        .body(CARD)
        .evalJS<boolean>(
          `document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelector('.session-card-picker-form') === null`,
        )
        .catch(() => false),
    (bound) => bound,
    BOUND_MS,
  );
  return { cardId: CARD, tugSessionId };
}

describe.skipIf(!RUNS)("site clip: busy to done", () => {
  test(
    "records a streaming turn ending and the card's indicators settling",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchForMode("sc-busy-done", deck(), stubDir);
      try {
        // Binding the stub is what stands the card up: its body mounts at the spawn.
        const cards = [await bindStub(app, stubDir)];
        await Bun.sleep(800);

        // Masthead through status row, leaving the composer below it out.
        const crop = await cropFor(app, [CARD], { endAt: { card: CARD, selector: STATUS_BAR } });
        const s = scene()
          .at(0, () => startStreams(app, cards))
          .mark("loop-start")
          .mark("loop-end", LOOP_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("busy-done"), crop }));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
