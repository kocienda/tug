/**
 * at0560-run-brief-command.test.ts — the three ways to run a slash command
 * the transcript is showing, driven end-to-end against the real app.
 *
 * A brief's hand-off ends with a `/arc <slug> @<path>` line, and the line is
 * a `slash-command` entity like any other. Its context menu is where the
 * three verbs live, and each is a different answer to "run this":
 *
 *   1. `Run Here` — seed the originating card's own composer and SEND, as
 *      that card's next turn. Observed by the composer emptying (the submit
 *      cleared it) and the command arriving as the user's own transcript row.
 *   2. `Run in New Session` — a SECOND Session card appears beside the first,
 *      and the command does NOT run in the one the reader right-clicked in.
 *      What the new card does with the command once its session binds is not
 *      observed here: the binding would take a real spawn in the fixture's
 *      throwaway project, and the stash that carries the command to it is
 *      pinned as pure logic in `opening-command-stash.test.ts` instead.
 *   3. `Copy Command` — the line on the pasteboard, unchanged and unrun.
 *
 * The menu itself is the fourth thing under test: all three rows are present
 * on a live card, in the registry's order, with the runs ahead of the copies
 * ([B03]) — a menu whose height moves between right-clicks is the thing the
 * dim-don't-drop rule exists to prevent.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/annotator/registry.ts
 * @covers tugdeck/src/components/tugways/use-annotation-menu.tsx
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 * @covers tugdeck/src/lib/prompt-insert-target.ts
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugdeck/src/lib/card-services-store.ts
 * @covers tugdeck/src/action-dispatch.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A";

const CMD = "arc";
const BRIEF = "briefs/a-thing-brief.md";
const ARGS = `a-thing @${BRIEF}`;
const LINE = `/${CMD} ${ARGS}`;
const ASSISTANT_TEXT = `Wrote the brief. Run it with \`${LINE}\`.`;

const SPAN = `[data-card-id="A"] code.tugx-annotation[data-slash-command="${CMD}"]`;
const PROMPT_INPUT = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0560-run-brief-"));
  // The args name a real file, so the run rows are live rather than dimmed:
  // a path the resolver looked for and did not find is one of the two things
  // that dims them.
  mkdirSync(join(projectDir, "briefs"), { recursive: true });
  writeFileSync(join(projectDir, BRIEF), "# A thing\n");
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
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
  tug_session_id: SID,
  msg_id: msgId,
  text,
  is_partial: false,
  rev: 0,
  seq: 0,
});
const turnDone = (msgId: string) => ({
  type: "turn_complete",
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
 * command catalog landed, and the brief file on disk beneath it.
 */
async function seedCardWithCommandLine(
  testName: string,
): Promise<Awaited<ReturnType<typeof launchTugApp>>> {
  const app = await launchTugApp({ testName });
  const ingest = (decoded: unknown) =>
    app.driveSession("A", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
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
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SPAN)}) !== null`,
    { timeoutMs: 10_000 },
  );
  return app;
}

/** Right-click the command line and wait for its menu. */
async function openCommandMenu(
  app: Awaited<ReturnType<typeof launchTugApp>>,
): Promise<void> {
  await app.evalJS(
    `(() => { const el = document.querySelector(${JSON.stringify(SPAN)}); if (el) el.scrollIntoView({ block: "center" }); return !!el; })()`,
  );
  await app.nativeRightClickAtElement(SPAN);
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-item-action="copy-command"]') !== null`,
    { timeoutMs: 6000 },
  );
}

/** Click a menu row by the action it dispatches. */
async function pickMenuItem(
  app: Awaited<ReturnType<typeof launchTugApp>>,
  action: string,
): Promise<void> {
  const point = await app.evalJS<{ x: number; y: number } | null>(
    `(() => {
      const item = document.querySelector('[data-item-action=${JSON.stringify(action)}]');
      if (item === null) return null;
      const r = item.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`,
  );
  expect(point).not.toBeNull();
  await app.nativeClick(point as { x: number; y: number });
}

describe.skipIf(!SHOULD_RUN)("AT0560: the three ways to run a command", () => {
  test(
    "the menu offers both runs ahead of the copies, live",
    async () => {
      const app = await seedCardWithCommandLine("at0560-run-brief-menu");
      try {
        await openCommandMenu(app);
        const rows = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify(Array.from(document.querySelectorAll('[data-item-action]')).map(function(el){
              return {
                action: el.getAttribute('data-item-action'),
                disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
              };
            }))`,
          ),
        ) as Array<{ action: string; disabled: boolean }>;
        const actions = rows.map((r) => r.action);
        // The two runs lead, the copies follow — the registry's order, on a
        // real menu rather than in a unit test's array.
        expect(actions.indexOf("run-command-here")).toBe(0);
        expect(actions.indexOf("run-command-in-new-session")).toBe(1);
        expect(actions.indexOf("copy-command")).toBe(2);
        // A live card with a composer and a brief that is really there: both
        // runs stand, which is what makes the dim state meaningful elsewhere.
        expect(rows[0].disabled).toBe(false);
        expect(rows[1].disabled).toBe(false);
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0560] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Run Here sends the command as this card's next turn",
    async () => {
      const app = await seedCardWithCommandLine("at0560-run-brief-here");
      try {
        await openCommandMenu(app);
        await pickMenuItem(app, "run-command-here");

        // The submit is what distinguishes this from the click that only
        // seeds: the composer is empty afterwards, and the command is in the
        // transcript as the user's own row.
        await app.waitForCondition<boolean>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            if (!cm) return false;
            return (cm.textContent || '').indexOf(${JSON.stringify(BRIEF)}) === -1;
          })()`,
          { timeoutMs: 15_000 },
        );
        await app.waitForCondition<boolean>(
          `(function(){
            var rows = Array.from(document.querySelectorAll(
              '[data-card-id="A"] [data-testid="session-card-transcript-user-body"]'));
            return rows.some(function(r){
              return (r.textContent || '').indexOf(${JSON.stringify(BRIEF)}) !== -1;
            });
          })()`,
          { timeoutMs: 15_000 },
        );

        // And it ran HERE: no second card was opened behind the reader's back.
        const cardCount = await app.evalJS<number>(
          `document.querySelectorAll('[data-card-id]').length`,
        );
        expect(cardCount).toBe(1);
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0560] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Run in New Session opens a second card and leaves this one alone",
    async () => {
      const app = await seedCardWithCommandLine("at0560-run-brief-new-session");
      try {
        await openCommandMenu(app);
        await pickMenuItem(app, "run-command-in-new-session");

        // A second Session card appears — the answer to the gesture is a card
        // somewhere else, never a rotation on the one being read ([B06]).
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('[data-card-id]').length > 1`,
          { timeoutMs: 15_000 },
        );
        const cards = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify(Array.from(document.querySelectorAll('[data-card-id]')).map(function(el){
              return el.getAttribute('data-card-id');
            }))`,
          ),
        ) as string[];
        expect(cards).toContain("A");
        expect(cards.length).toBeGreaterThan(1);

        // The originating card's own composer is untouched: the command did
        // not run here, and the transcript the reader was reading still says
        // what it said.
        const here = await app.evalJS<string>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            return cm ? (cm.textContent || '') : '';
          })()`,
        );
        expect(here.indexOf(BRIEF)).toBe(-1);
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0560] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Copy Command puts the line on the pasteboard and runs nothing",
    async () => {
      const app = await seedCardWithCommandLine("at0560-run-brief-copy");
      try {
        await openCommandMenu(app);
        await pickMenuItem(app, "copy-command");

        await app.waitForCondition<boolean>(
          `(function(){
            var w = window;
            var bridge = w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.clipboardRead;
            if (!bridge || typeof bridge.postMessage !== "function") return true;
            if (w.__at0560Clip !== undefined) return w.__at0560Clip !== null;
            w.__at0560Clip = null;
            var id = "at0560-" + Math.random().toString(36).slice(2);
            var prior = w.__tugNativeClipboardCallback;
            w.__tugNativeClipboardCallback = function(data){
              if (!data || data.requestId !== id) {
                if (typeof prior === "function") prior(data);
                return;
              }
              w.__tugNativeClipboardCallback = prior;
              w.__at0560Clip = typeof data.text === "string" ? data.text : "";
            };
            bridge.postMessage({ requestId: id });
            return false;
          })()`,
          { timeoutMs: 15_000 },
        );
        const clip = await app.evalJS<string | null>(
          `(function(){
            var w = window;
            var bridge = w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.clipboardRead;
            if (!bridge) return null;
            return typeof w.__at0560Clip === "string" ? w.__at0560Clip : null;
          })()`,
        );
        // No native pasteboard bridge in a browser-mode run: the copy has
        // nowhere to land and there is nothing to assert about it. The rest
        // of the test — that copying runs nothing — still holds.
        if (clip !== null) expect(clip).toContain(LINE);

        // A copy is not a run: the composer is empty and no card was opened.
        const here = await app.evalJS<string>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            return cm ? (cm.textContent || '') : '';
          })()`,
        );
        expect(here.indexOf(BRIEF)).toBe(-1);
        const cardCount = await app.evalJS<number>(
          `document.querySelectorAll('[data-card-id]').length`,
        );
        expect(cardCount).toBe(1);
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0560] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
