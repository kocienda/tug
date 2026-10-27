/**
 * row-47-handback-busy-latch.test.ts — a catch-up in the middle of a live
 * turn leaves tugcast's turn latch where the turn left it.
 *
 * A Session card's turn streams. Its workspace is parked, the body goes
 * dormant, and it is shown again while the turn still streams, so the
 * body's catch-up opens and closes a replay bracket inside the live turn.
 * The bracket's close puts back the latch it found, so the session's ledger
 * row — which carries the latch on every push, and which the shell reads a
 * card's phase from when its body is not listening — says the turn is open
 * for as long as the body says it streams, and says it ended once it has.
 *
 * @family row-47
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/ledger_entry.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/mod.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/recorder.rs
 * @covers tugdeck/src/body/body-dormancy.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { STREAM_PACE_MS, STUB_TRANSCRIPT_DIR_ENV, stubDirectory, streamingTranscript } from "../streaming-stub-fixture";
import { bodyOf, pollFor, promptPhase, sessionPane, settleFor, waitForBody } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r47l-a";
/** The body's delay before dormancy, shortened from a minute for the row. */
const DORMANT_AFTER_MS = 800;
/** Words in the turn: long enough to stream well past the catch-up. */
const WORDS = 280;
/**
 * The longest the sampling after the catch-up can run: the whole turn, at the
 * stub's pace, since the catch-up lands inside it. Launch, spawn, park and
 * dormancy take about five seconds before it, so the file stays under the
 * per-file budget even when the turn outlasts the catch-up by all of it.
 */
const SAMPLE_CAP_MS = WORDS * STREAM_PACE_MS;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
/** How often the latch is read against the body's phase between the catch-up and the turn's end. */
const SAMPLE_MS = 50;

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** In the shell: the session row's turn latch, or undefined while it holds no row. */
const latchOf = (sessionId: string): string =>
  `(function () { var r = window.__tug.sessionRowFacts(${JSON.stringify(sessionId)}); return r === null ? undefined : r.turnActive; })()`;

describe.skipIf(!SHOULD_RUN)("body-grounding row 47: a hidden card's hand-back", () => {
  test(
    "a catch-up mid-turn leaves the session row's latch open until the turn really ends",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "body-grounding-row-47-handback-busy-latch", env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        const sid = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r47l-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        const words = Array.from({ length: WORDS }, (_, i) => `word${i}`).join(" ");
        writeFileSync(join(stubDir, `${sid}.json`), JSON.stringify(streamingTranscript(1, 1, () => words)));
        await app.spawnSessionNew(A, { tugSessionId: sid, projectDir });
        await waitForBody(app, A);
        const body = app.body(A);
        await app.bodyDelays({ dormantAfterMs: DORMANT_AFTER_MS });
        await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 10_000 });

        // ---- The turn streams, and the row says so ----
        await body.driveSession({ op: "send", text: "Stream a long turn." });
        await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: 10_000 });
        const askedAt = Date.now();
        const open = await settleFor(() => app.evalJS<boolean | null | undefined>(latchOf(sid)), (l) => l === true, 5_000);
        const facts = `JSON.stringify(window.__tug.sessionRowFacts(${JSON.stringify(sid)}))`;
        note(`${Date.now() - askedAt} ms into the turn: the shell's row ${await app.evalJS<string>(facts)}; the body's ${await body.evalJS<string>(facts)}`);
        expect(open, "the row says the turn is open").toBe(true);

        // ---- Parked, asleep, and shown again mid-turn: the catch-up's bracket opens and closes ----
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        await pollFor(() => body.evalJS<boolean>("window.__tug.bodyDormancy().dormant"), (d) => d, 5_000);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`);
        await settleFor(
          () => body.evalJS<{ dormant: boolean; phase: string | null }>(`({ dormant: window.__tug.bodyDormancy().dormant, phase: ${promptPhase} })`),
          (r) => !r.dormant && r.phase === "streaming",
          10_000,
        );

        // ---- From the catch-up to the turn's end, the latch stays open while the body streams ----
        const closedEarly: number[] = [];
        let samples = 0;
        const caughtAt = Date.now();
        for (;;) {
          const phase = await body.evalJS<string | null>(promptPhase);
          if (phase === "idle") break;
          const latch = await app.evalJS<boolean | null | undefined>(latchOf(sid));
          samples += 1;
          if (phase === "streaming" && latch !== true) closedEarly.push(Date.now() - caughtAt);
          if (Date.now() - caughtAt > SAMPLE_CAP_MS) break;
          await Bun.sleep(SAMPLE_MS);
        }
        note(`${samples} samples over ${Date.now() - caughtAt} ms after the catch-up; latch closed while streaming at ${JSON.stringify(closedEarly)}`);
        expect(samples, "the turn was still streaming after the catch-up").toBeGreaterThan(5);
        expect(closedEarly, "the row never said the turn ended while it streamed").toEqual([]);

        // ---- The turn ends, and the row says that too ----
        const closed = await settleFor(() => app.evalJS<boolean | null | undefined>(latchOf(sid)), (l) => l === false, 3_000);
        expect(closed, "the row says the turn ended once it has").toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
