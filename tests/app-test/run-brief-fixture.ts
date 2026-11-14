/**
 * run-brief-fixture.ts — the seeded `/arc` line, frames and menu gestures
 * the at0560-run-brief-* files drive the three ways to run a slash command
 * the transcript is showing with, end-to-end against the real app.
 *
 * A brief's hand-off ends with a `/arc <slug> @<path>` line, and the line is
 * a `slash-command` entity like any other. Its context menu is where the
 * three verbs live, and each is a different answer to "run this":
 *
 *   1. `Run in This Session` — seed the originating card's own composer and SEND, as
 *      that card's next turn. Observed by the composer emptying (the submit
 *      cleared it) and the command arriving as the user's own transcript row.
 *   2. `Run in New Session` — a SECOND Session card appears beside the first,
 *      the command runs THERE — its first turn is the command, sent by the
 *      card itself, with its composer left empty — and it does NOT run in the
 *      one the reader right-clicked in.
 *   3. `Copy Command` — the line on the pasteboard, unchanged and unrun.
 *
 * The plain left click is the fourth verb and the one with no menu: it seeds
 * the composer and stops there, and what it seeds is a SUBSTRATE — the
 * command as its chip, and the `@<path>` argument as the same file chip the
 * `@` completion would have placed. A mention somebody clicked is a placed
 * thing, and a placed thing renders as an atom.
 *
 * The menu itself is the fifth thing under test: all three rows are present
 * on a live card, in the registry's order, with the runs ahead of the copies
 * ([B03]) — and an offered run is always live, even when the brief its
 * argument names is not on disk: the run is what the reader asked for, and an
 * argument it cannot use is the run's to report, not a reason to refuse the
 * click.
 *
 * Each at0560-run-brief file makes its own project directory with the brief
 * on disk, and launches its own app into it.
 *
 * @module tests/app-test/run-brief-fixture
 */

import { expect } from "bun:test";
import { launchTugApp } from "./_harness";
import { restoreGateGone } from "./overlay-fixture";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A";

export const CMD = "arc";
export const BRIEF = "briefs/a-thing-brief.md";
const ARGS = `a-thing @${BRIEF}`;
export const LINE = `/${CMD} ${ARGS}`;
const ASSISTANT_TEXT = `Wrote the brief. Run it with \`${LINE}\`.`;

export const SPAN = `[data-card-id="A"] code.tugx-annotation[data-slash-command="${CMD}"]`;
export const PROMPT_INPUT = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';

const capabilities = (commands: string[]) => ({
  type: "session_capabilities",
  models: [{ value: "default", displayName: "Default" }],
  commands,
  agents: [],
  available_output_styles: [],
  output_style: "default",
  account: null,
  effort: null,
  ipc_version: 2,
});

const userMsg = (text: string) => ({
  type: "add_user_message",
  tug_session_id: SID,
  content: [{ type: "text", text }],
});
const asstText = (msgId: string, text: string) => ({
  type: "assistant_text",
  status: "complete",
  tug_session_id: SID,
  msg_id: msgId,
  text,
  is_partial: false,
  rev: 0,
  seq: 0,
});
const turnDone = (msgId: string) => ({
  type: "turn_complete",
  seq: 0,
  tug_session_id: SID,
  msg_id: msgId,
  result: "success",
});
const replayStarted = () => ({ type: "replay_started", tug_session_id: SID });
const replayComplete = () => ({
  type: "replay_complete",
  tug_session_id: SID,
  count: 1,
  firstLoadedTurnIndex: 0,
  totalTurns: 1,
  hasOlder: false,
});

/**
 * Stand a card up with the `/arc` line rendered as a tagged annotation, the
 * command catalog landed, and the brief file on disk beneath it — the
 * calling file's own `projectDir`.
 */
export async function seedCardWithCommandLine(
  projectDir: string,
  testName: string,
): Promise<Awaited<ReturnType<typeof launchTugApp>>> {
  const app = await launchTugApp({ testName });
  const ingest = (decoded: unknown) =>
    app.driveSession("A", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });
  await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_SHORT), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.bindSession("A", {
    tugSessionId: SID,
    sessionMode: "resume",
    projectDir,
  });
  await app.ingestSessionMetadata("A", capabilities([CMD]));
  await ingest(replayStarted());
  await ingest(userMsg("write a brief"));
  await ingest(asstText("m1", ASSISTANT_TEXT));
  await ingest(turnDone("m1"));
  await ingest(replayComplete());
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SPAN)}) !== null`,
    { timeoutMs: 10_000 },
  );
  // The resume raised the restore gate over the whole window: every gesture
  // below is made at the card, so it waits for the gate to go and for the
  // host to have heard that it went.
  await restoreGateGone(app);
  return app;
}

/** Right-click the command line and wait for its menu. */
export async function openCommandMenu(
  app: Awaited<ReturnType<typeof launchTugApp>>,
): Promise<void> {
  await app.body("A").evalJS(
    `(() => { const el = document.querySelector(${JSON.stringify(SPAN)}); if (el) el.scrollIntoView({ block: "center" }); return !!el; })()`,
  );
  await app.body("A").nativeRightClickAtElement(SPAN);
  // The menu is the card's own: it opens in A's body.
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector('[data-item-action="copy-command"]') !== null`,
    { timeoutMs: 6000 },
  );
}

/** Click a menu row by the action it dispatches. */
export async function pickMenuItem(
  app: Awaited<ReturnType<typeof launchTugApp>>,
  action: string,
): Promise<void> {
  // The point is in A's body viewport, so the click is made there.
  const point = await app.body("A").evalJS<{ x: number; y: number } | null>(
    `(() => {
      const item = document.querySelector('[data-item-action=${JSON.stringify(action)}]');
      if (item === null) return null;
      const r = item.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`,
  );
  expect(point).not.toBeNull();
  await app.body("A").nativeClick(point as { x: number; y: number });
}
