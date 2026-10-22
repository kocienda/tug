/**
 * row-35-dormancy.test.ts — a body hidden past its delay goes dormant, hears
 * nothing of its session while it is, and catches up when it is shown.
 *
 * A Session body streams a turn; its workspace is parked, which hides it, and
 * the host says so (`shown: false`). Past its delay — shortened here through
 * the body's own tugbank key — the body goes dormant: its subscription is
 * dropped, so the rest of the turn streams on tugcast's side and none of it
 * reaches the page. The turn ends while the body sleeps, and the page still
 * holds it mid-stream. Shown again, the body asks for what it missed and
 * wakes when that has landed: the turn's last words are in the transcript,
 * the turn is over, and the body is no longer dormant.
 *
 * The reveal is lidded: from the moment the body sleeps its content box
 * wears the content lid, and on no reading after the reveal is the body
 * shown with its content bare before the turn's end is in. Beside it, how
 * long the revealed body stood lidded before the catch-up landed, against the
 * display period — what decided that a reveal needs the lid.
 *
 * @covers tugdeck/src/body/body-dormancy.ts
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/lib/body-visibility-store.ts
 * @covers tugdeck/src/lib/code-session-store.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, STREAM_PACE_MS, stubDirectory, streamingTranscript } from "../streaming-stub-fixture";
import { bodyOf, pollFor, promptPhase, sessionPane, waitForBody } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r35-a";
/** The body's delay before dormancy, shortened from a minute for the row. */
const DORMANT_AFTER_MS = 800;
/** The last words of the turn: present only once the turn's end has reached the page. */
const MARKER = "dormancy-turn-ends-here";
const WORDS_PER_MESSAGE = 70;
const MESSAGES = 2;
/** How long the turn streams, at the stub's pace (a delta a word). */
const TURN_MS = WORDS_PER_MESSAGE * MESSAGES * STREAM_PACE_MS;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

/** A message of plain words; the last one ends with the marker. */
function text(index: number): string {
  const words = Array.from({ length: WORDS_PER_MESSAGE - 1 }, (_, i) => `word${index}-${i}`).join(" ");
  return index === MESSAGES - 1 ? `${words} ${MARKER}` : words;
}

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** In the body: its dormancy, its prompt phase, whether the turn's last words are in, and whether its content is lidded. */
const READ = `(function () {
  var d = window.__tug.bodyDormancy();
  var t = document.querySelector('[data-testid="session-card-transcript"]');
  return { dormant: d.dormant, shown: d.shown, phase: ${promptPhase}, ended: t !== null && (t.textContent || "").indexOf(${JSON.stringify(MARKER)}) >= 0, lidded: document.documentElement.hasAttribute("data-body-dormant") };
})()`;

interface Read {
  dormant: boolean;
  shown: boolean;
  phase: string | null;
  ended: boolean;
  lidded: boolean;
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 35: dormancy and the catch-up", () => {
  test(
    "a hidden body goes dormant, misses its turn's end, and catches up when shown",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "body-grounding-row-35-dormancy", env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r35-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(MESSAGES, 1, text)));
        await app.spawnSessionNew(A, { tugSessionId, projectDir });
        await waitForBody(app, A);
        const body = app.body(A);
        await body.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.body-dormancy", "dormantAfterMs", { kind: "i64", value: ${DORMANT_AFTER_MS} }), null)`,
        );
        const before = await body.evalJS<Read>(READ);
        expect(before, "shown, awake and unlidded before anything is hidden").toMatchObject({ shown: true, dormant: false, lidded: false });

        // ---- A turn streams; the workspace is parked under it ----
        await body.driveSession({ op: "send", text: "Stream the turn." });
        await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: 10_000 });
        const streamingAt = Date.now();
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        const hidden = await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        expect(hidden?.shown, "the host has the parked body hidden").toBe(false);

        // ---- Past its delay, it goes dormant; the turn ends unheard ----
        const asleep = await pollFor(() => body.evalJS<Read>(READ), (r) => r.dormant, 5_000);
        expect(asleep, "the hidden body is dormant past its delay, its turn still running on its page").toMatchObject({
          shown: false,
          dormant: true,
          ended: false,
          lidded: true,
        });
        note(`dormant ${Date.now() - streamingAt} ms after the turn began streaming; the turn streams for ${TURN_MS} ms`);
        await Bun.sleep(Math.max(0, streamingAt + TURN_MS + 1_000 - Date.now()));
        const unheard = await body.evalJS<Read>(READ);
        note(`after the turn's end on tugcast: ${JSON.stringify(unheard)}`);
        expect(unheard.ended, "the turn's end, sent while the body slept, never reached it").toBe(false);
        expect(unheard.phase, "the page still holds the turn mid-stream").not.toBe("idle");

        // ---- Shown again: it catches up and wakes ----
        const revealAt = Date.now();
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`);
        let shownAt: number | null = null;
        let wokeAt: number | null = null;
        let last: Read | null = null;
        let bareStale = 0;
        const deadline = revealAt + 10_000;
        while (Date.now() < deadline) {
          const b = await bodyOf(app, A);
          if (shownAt === null && b?.visible === true) shownAt = Date.now();
          last = await body.evalJS<Read>(READ);
          if (b?.visible === true && !last.ended && !last.lidded) bareStale += 1;
          if (wokeAt === null && !last.dormant) wokeAt = Date.now();
          if (shownAt !== null && wokeAt !== null && last.ended && last.phase === "idle") break;
        }
        const period = (await bodyOf(app, A))?.displayPeriodMs ?? 16.7;
        const staleMs = shownAt !== null && wokeAt !== null ? Math.max(0, wokeAt - shownAt) : null;
        note(
          `reveal: shown ${shownAt === null ? "never" : `${shownAt - revealAt} ms`}, awake ${wokeAt === null ? "never" : `${wokeAt - revealAt} ms`} after the switch; ` +
            `shown lidded before caught up for ${staleMs ?? "?"} ms ≈ ${staleMs === null ? "?" : (staleMs / period).toFixed(1)} display periods of ${period.toFixed(1)} ms`,
        );
        expect(shownAt, "the revealed body is shown").not.toBeNull();
        expect(bareStale, "no reading has the revealed body shown bare without its turn's end").toBe(0);
        expect(last, "the revealed body caught up: the turn's end is in, the turn is over, and it is awake").toMatchObject({
          dormant: false,
          ended: true,
          phase: "idle",
          lidded: false,
        });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
