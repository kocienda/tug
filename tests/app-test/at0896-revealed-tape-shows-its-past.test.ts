/**
 * at0896-revealed-tape-shows-its-past.test.ts — a card opened mid-turn draws
 * the session's recent past in its first reading.
 *
 * ## The report this reproduces
 *
 * Each page used to draw a session's activity from meters it kept itself,
 * holding only the frames its own connection had delivered since it started
 * listening. A card opened or woken mid-turn therefore drew a flat line for
 * the whole stretch before it opened, beside other surfaces that drew the
 * same seconds as work.
 *
 * ## What it asserts
 *
 * tugcast keeps each session's last twenty seconds of activity, and a page
 * that starts listening to a session is sent that window whole. A stub turn
 * streams three seconds of `activity_delta` frames and then goes quiet while
 * the turn is still open, streaming only text partials, which carry no
 * activity. In the quiet stretch, once the session's own tape has dropped
 * back to zero at its newest bin, the Workspaces card is opened: a fresh page
 * whose row tape for the session has never received a live activity frame.
 * Nothing live arrives for it in the quiet, so the only way that tape can
 * leave rest is the window it was sent when it started listening.
 *
 * @covers tugrust/crates/tugcast/src/feeds/activity/tape.rs
 * @covers tugrust/crates/tugcast/src/router.rs
 * @covers tugdeck/src/lib/session-activity-store.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, TUGCODE_TRANSCRIPT_SCHEMA_VERSION, type TugcodeTranscript } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";
import { sessionPane, settleFor, waitForBody } from "./body-grounding/_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "at0896-a";
/** One activity bin: tugcode flushes an `activity_delta` per 250 ms. */
const PACE_MS = 250;
/** Bins of work at the turn's start: three seconds. */
const WORK_BINS = 12;
/** Quiet outputs after the work: ten seconds of an open turn with no activity. */
const QUIET_OUTPUTS = 40;
const IPC_VERSION = 2;
/** The session card's own tape, in its masthead. */
const MASTHEAD_TAPE = `.body-chrome-frame .session-masthead-row [data-slot="tug-sparkline"]`;

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    hasFocus: true,
  };
}

/** One paced turn: three seconds of activity, then ten seconds of text partials and nothing else. */
function transcript(): TugcodeTranscript {
  const outputs: unknown[] = [
    { type: "content_block_start", msg_id: "stub-turn", block_index: 0, kind: "text", ipc_version: IPC_VERSION },
  ];
  for (let i = 0; i < WORK_BINS; i++) {
    outputs.push({ type: "activity_delta", channels: { text: 400, tokens: 60 }, ipc_version: IPC_VERSION });
  }
  for (let i = 0; i < QUIET_OUTPUTS; i++) {
    outputs.push({ type: "assistant_text", msg_id: "stub-turn", block_index: 0, seq: 0, rev: i, text: `word${i} `, is_partial: true, status: "partial", ipc_version: IPC_VERSION });
  }
  outputs.push(
    { type: "assistant_text", msg_id: "stub-turn", block_index: 0, seq: 0, rev: QUIET_OUTPUTS, text: "done", is_partial: false, status: "complete", ipc_version: IPC_VERSION },
    { type: "turn_complete", msg_id: "stub-turn", seq: 1, result: "success", ipc_version: IPC_VERSION },
  );
  return {
    schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION,
    tugcodeVersion: "stub",
    paceMs: PACE_MS,
    turns: [{ index: 0, description: "a turn that works, then goes quiet", outputs }],
  } as TugcodeTranscript;
}

interface TapeState {
  ticking: boolean;
  newest: number;
  atRest: boolean;
}

/** The instrument under `selector` in the page `evalJS` runs in, or null when none is mounted. */
const stateOf = (selector: string): string =>
  `window.__tug.sparklineInstrumentState(${JSON.stringify(selector)})`;

describe.skipIf(!SHOULD_RUN)("AT0896: a card opened mid-turn draws the session's past", () => {
  test(
    "the Workspaces row opened in a quiet stretch draws the work before it",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: "at0896-revealed-tape-shows-its-past",
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0896-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(transcript()));
        await app.spawnSessionNew(A, { tugSessionId, projectDir });
        await waitForBody(app, A);
        const session = app.body(A);

        await session.driveSession({ op: "send", text: "Work, then go quiet." });

        // The work reaches the session's own tape...
        const working = await settleFor(
          () => session.evalJS<TapeState | null>(stateOf(MASTHEAD_TAPE)),
          (s) => s !== null && s.newest > 0,
          5_000,
        );
        note(`own tape while working: ${JSON.stringify(working)}`);
        expect(working?.newest ?? 0, "the session's own tape draws the work at its newest bin").toBeGreaterThan(0);

        // ...and then stops: its newest bin is back at zero while the turn runs on.
        const quiet = await settleFor(
          () => session.evalJS<TapeState | null>(stateOf(MASTHEAD_TAPE)),
          (s) => s !== null && s.newest === 0,
          6_000,
        );
        note(`own tape in the quiet: ${JSON.stringify(quiet)}`);
        expect(quiet, "the turn has gone quiet, its work still on the tape, before the card opens").toMatchObject({ newest: 0, atRest: false });

        // ---- The Workspaces card opens now, in the quiet ----
        await app.dispatchControlAction("toggle-cards");
        const cards = kindBody(app, "cards");
        const rowTape = `.tug-list-view-cell:has([data-session-id="${tugSessionId}"]) .session-activity-spark`;
        const first = await settleFor(
          () => cards.evalJS<TapeState | null>(stateOf(rowTape)),
          (s) => s !== null && !s.atRest,
          3_000,
        );
        note(`the opened row's tape: ${JSON.stringify(first)}`);
        expect(first, "the row opened in the quiet draws the work before it").toMatchObject({ atRest: false });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
