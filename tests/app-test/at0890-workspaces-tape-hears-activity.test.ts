/**
 * at0890-workspaces-tape-hears-activity.test.ts — a working session's tape on
 * the Workspaces card leaves rest.
 *
 * ## The report this reproduces
 *
 * With two sessions mid-turn, every activity tape on the Workspaces card read
 * flat while the sessions' own cards ticked. The Workspaces card is a body
 * page of its own, and a body page's connection is scoped to no session until
 * its card binds one; tugcast refuses a session-scoped frame outside that
 * scope, and ACTIVITY is session-scoped. So the page that lists every session
 * heard none of them.
 *
 * ## What it asserts
 *
 * A listing page watches every session: tugcast sends it each session's
 * ACTIVITY frames, and nothing else of theirs. A stub session plays one paced
 * turn of `activity_delta` frames through a real tugcode, which tugcast diverts
 * onto ACTIVITY exactly as it does a live claude turn's. While the turn runs,
 * the Workspaces row's tape for that session must leave rest, read from the
 * instrument's own state rather than from pixels. The session's own masthead
 * tape is read beside it, so a red here that is the stream's fault and not the
 * scope's says so.
 *
 * `body-main.ts`, where a listing page declares its watch, is the other half
 * of what this drives and is deliberately not declared: every body-page test
 * names it, and it already sits at the selection budget's twenty families,
 * so a twenty-first would make every edit to it a sweep. The declarations are
 * the scope's two ends, the router that admits the frame and the connection
 * that asks for it.
 *
 * @covers tugrust/crates/tugcast/src/router.rs
 * @covers tugdeck/src/connection.ts
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

const A = "at0890-a";
/** One activity bin: tugcode flushes an `activity_delta` per 250 ms. */
const PACE_MS = 250;
/** Bins in the turn: long enough to read the tape while it still runs. */
const BINS = 40;
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

/** One paced turn whose every output after the first is a bin of streamed text. */
function transcript(): TugcodeTranscript {
  const outputs: unknown[] = [
    { type: "content_block_start", msg_id: "stub-turn", block_index: 0, kind: "text", ipc_version: IPC_VERSION },
  ];
  for (let i = 0; i < BINS; i++) {
    outputs.push({ type: "activity_delta", channels: { text: 400, tokens: 60 }, ipc_version: IPC_VERSION });
  }
  outputs.push(
    { type: "assistant_text", msg_id: "stub-turn", block_index: 0, seq: 0, rev: 0, text: "done", is_partial: false, status: "complete", ipc_version: IPC_VERSION },
    { type: "turn_complete", msg_id: "stub-turn", seq: 1, result: "success", ipc_version: IPC_VERSION },
  );
  return {
    schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION,
    tugcodeVersion: "stub",
    paceMs: PACE_MS,
    turns: [{ index: 0, description: "a turn that streams activity", outputs }],
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

describe.skipIf(!SHOULD_RUN)("AT0890: the Workspaces card hears every session's activity", () => {
  test(
    "a streaming session's Workspaces tape leaves rest",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: "at0890-workspaces-tape-hears-activity",
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0890-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(transcript()));
        await app.spawnSessionNew(A, { tugSessionId, projectDir });
        await waitForBody(app, A);
        const session = app.body(A);

        // The Workspaces card, in its own page, listing the session's row.
        await app.dispatchControlAction("toggle-cards");
        const cards = kindBody(app, "cards");
        const rowTape = `.tug-list-view-cell:has([data-session-id="${tugSessionId}"]) .session-activity-spark`;
        await cards.waitForCondition<boolean>(`${stateOf(rowTape)} !== null`, { timeoutMs: 10_000 });
        const before = await cards.evalJS<TapeState | null>(stateOf(rowTape));
        note(`row tape before the turn: ${JSON.stringify(before)}`);

        // ---- The turn streams: one activity bin every 250 ms for ten seconds ----
        await session.driveSession({ op: "send", text: "Stream some activity." });

        const own = await settleFor(
          () => session.evalJS<TapeState | null>(stateOf(MASTHEAD_TAPE)),
          (s) => s !== null && !s.atRest,
          5_000,
        );
        note(`the session's own tape: ${JSON.stringify(own)}`);
        expect(own?.atRest, "the session's own tape moves: the stream reached the deck").toBe(false);

        const row = await settleFor(
          () => cards.evalJS<TapeState | null>(stateOf(rowTape)),
          (s) => s !== null && !s.atRest,
          5_000,
        );
        note(`the Workspaces row's tape: ${JSON.stringify(row)}`);
        expect(row, "the Workspaces row's tape for the working session leaves rest").toMatchObject({ atRest: false });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
