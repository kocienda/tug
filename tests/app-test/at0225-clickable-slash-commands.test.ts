/**
 * at0225-clickable-slash-commands.test.ts — clickable slash commands in
 * the Session card transcript, driven end-to-end against the real app.
 *
 * A backticked slash command in assistant prose (e.g.
 * `` `/tugplug:implement arc/find-route.md` ``) whose name is in the
 * live command catalog is marked `.tugx-annotation`; a click seeds the
 * prompt with a ready-to-run, atomized draft.
 *
 * This drives the actual render/interaction (no fake DOM):
 *
 *   1. A resumed turn whose assistant text contains three inline-code
 *      spans — a known plugin command, an unknown command, and an
 *      absolute path — renders BEFORE any command catalog lands. None are
 *      clickable yet (the known-set is empty), proving the strict gate.
 *   2. The `session_capabilities` catalog lands (with the plugin command).
 *      The known span becomes tagged over the already-rendered DOM — the
 *      on-resume re-tag — while the unknown command and the path stay
 *      inert.
 *   3. A click on the tagged span seeds the prompt: the editor holds the
 *      argument text (`arc/find-route.md`) plus a command chip, is the
 *      focused first responder, and the card is on the Code route.
 *   4. A right-click on the same span offers Insert into Prompt, which
 *      puts the command line in as literal text — the indirect gesture,
 *      distinguishable from the seed by the literal `/name args` string.
 *
 * The second test covers the SUBMITTED command — the user's own row. On
 * reload a slash command replays as claude's `<command-name>` envelope,
 * which the deck turns back into a command chip rather than inline code.
 * The chip's host span carries the same tag and the same click gesture.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/slash-commands.ts
 * @covers tugdeck/src/lib/markdown/
 * @covers tugdeck/src/lib/annotator/
 * @covers tugdeck/src/lib/command-atom.ts
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/cards/tug-atom-markdown-body.tsx
 * @covers tugdeck/src/components/tugways/cards/tug-atom-markdown-body.css
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A";

const KNOWN_CMD = "tugplug:implement";
const ARG = "arc/find-route.md";
// One inline-code span for each case: a known plugin command (+ arg), an
// unknown command, and an absolute path (grammar rejects it outright).
const ASSISTANT_TEXT =
  `Ready: \`/${KNOWN_CMD} ${ARG}\` — ` +
  "not `/definitely-not-a-command`, not `/Users/kocienda/x`.";

// What claude persists in place of the literal the user typed when they
// submitted `/tugplug:implement arc/find-route.md`.
const COMMAND_ENVELOPE =
  `<command-message>${KNOWN_CMD}</command-message>\n` +
  `<command-name>/${KNOWN_CMD}</command-name>\n` +
  `<command-args>${ARG}</command-args>`;

const PROMPT_INPUT = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0225-clickable-"));
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

// Turn-free handshake catalog carrying the plugin command.
function capabilities(commands: string[]) {
  return {
    type: "session_capabilities",
    models: [{ value: "default", displayName: "Default" }],
    commands,
    agents: [],
    available_output_styles: [],
    output_style: "default",
    account: null,
    effort: null,
    ipc_version: 2,
  };
}

const userMsg = (text: string) => ({
  type: "add_user_message",
  tug_session_id: SID,
  content: [{ type: "text", text }],
});
const asstText = (msgId: string, text: string, seq: number) => ({
  type: "assistant_text",
  tug_session_id: SID,
  msg_id: msgId,
  text,
  is_partial: false,
  rev: 0,
  seq,
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

// Read one assistant code span's tag state by a text substring. Returns a
// JSON string so it round-trips through `evalJS`.
const spanStateJS = (needle: string) => `JSON.stringify((function(){
  var codes = Array.from(document.querySelectorAll(
    '[data-card-id="A"] .session-card-transcript-code-body code'));
  var el = codes.find(function(c){
    return (c.textContent || '').indexOf(${JSON.stringify(needle)}) !== -1;
  });
  if (!el) return { found: false };
  return {
    found: true,
    tagged: el.classList.contains("tugx-annotation"),
    cmd: el.getAttribute('data-slash-command'),
    args: el.getAttribute('data-slash-args'),
  };
})())`;

describe.skipIf(!SHOULD_RUN)("AT0225: clickable slash commands", () => {
  test(
    "known command tags on catalog arrival and click seeds the prompt",
    async () => {
      const app = await launchTugApp({
        testName: "at0225-clickable-slash-commands",
      });
      const ingest = (decoded: unknown) =>
        app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded,
        });
      const readSpan = async (needle: string) =>
        JSON.parse(await app.evalJS<string>(spanStateJS(needle))) as {
          found: boolean;
          tagged?: boolean;
          cmd?: string | null;
          args?: string | null;
        };

      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          sessionMode: "resume",
        });

        // --- 1. Resume the turn BEFORE any catalog lands ----------------
        await ingest(replayStarted());
        await ingest(userMsg("go"));
        await ingest(asstText("m1", ASSISTANT_TEXT, 0));
        await ingest(turnDone("m1"));
        await ingest(replayComplete());

        // The known command's span renders, but is NOT clickable yet — the
        // known-set is empty (strict gate; the resume race).
        await app.waitForCondition<boolean>(
          `JSON.parse(${spanStateJS(KNOWN_CMD)}).found === true`,
          { timeoutMs: 8000 },
        );
        let known = await readSpan(KNOWN_CMD);
        expect(known.found).toBe(true);
        expect(known.tagged).toBe(false);

        // --- 2. Catalog lands → the span re-tags over existing DOM ------
        await app.ingestSessionMetadata("A", capabilities([KNOWN_CMD]));
        await app.waitForCondition<boolean>(
          `JSON.parse(${spanStateJS(KNOWN_CMD)}).tagged === true`,
          { timeoutMs: 8000 },
        );
        known = await readSpan(KNOWN_CMD);
        expect(known.cmd).toBe(KNOWN_CMD);
        expect(known.args).toBe(ARG);

        // The unknown command and the path never tag (strict gate).
        const unknown = await readSpan("definitely-not-a-command");
        expect(unknown.found).toBe(true);
        expect(unknown.tagged).toBe(false);
        const path = await readSpan("/Users/kocienda/x");
        expect(path.found).toBe(true);
        expect(path.tagged).toBe(false);

        // --- 3. Click the tagged span → the prompt seeds --------------
        await app.click(
          `[data-card-id="A"] code.tugx-annotation[data-slash-command="${KNOWN_CMD}"]`,
        );

        // The editor holds the argument text and a command chip (an <img>
        // baked from the command atom), and is the focused first responder.
        await app.waitForCondition<boolean>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            if (!cm) return false;
            return (cm.textContent || '').indexOf(${JSON.stringify(ARG)}) !== -1
              && cm.querySelector('img') !== null;
          })()`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(PROMPT_INPUT)})`,
          { timeoutMs: 4000 },
        );

        // The card is on the Code route (`❯`) after the seed.
        const route = await app.evalJS<string | null>(
          `(function(){
            var el = document.querySelector('[data-card-id="A"] [data-slot="route-indicator"]');
            return el ? (el.getAttribute('data-route') || (el.textContent || '').trim()) : null;
          })()`,
        );
        expect(route === null || route === "❯" || route.indexOf("❯") !== -1).toBe(
          true,
        );

        // --- 4. Right-click → Insert into Prompt ----------------------
        // The indirect gesture: instead of seeding a ready-to-run draft,
        // the command's literal text goes into the prompt as something to
        // talk about. The click above seeded an atomized chip plus its
        // argument, so the whole command line as literal text is what
        // distinguishes this path from that one.
        const SPAN = `[data-card-id="A"] code.tugx-annotation[data-slash-command="${KNOWN_CMD}"]`;
        await app.evalJS(
          `(() => { const el = document.querySelector(${JSON.stringify(SPAN)}); if (el) el.scrollIntoView({ block: "center" }); return !!el; })()`,
        );
        await app.nativeRightClickAtElement(SPAN);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-item-action="insert-into-prompt"]') !== null`,
          { timeoutMs: 4000 },
        );
        const itemPoint = await app.evalJS<{ x: number; y: number } | null>(
          `(() => {
            const item = document.querySelector('[data-item-action="insert-into-prompt"]');
            if (item === null) return null;
            const r = item.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()`,
        );
        expect(itemPoint).not.toBeNull();
        await app.nativeClick(itemPoint as { x: number; y: number });

        await app.waitForCondition<boolean>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            if (!cm) return false;
            return (cm.textContent || '').indexOf(${JSON.stringify(`/${KNOWN_CMD} ${ARG}`)}) !== -1;
          })()`,
          { timeoutMs: 8000 },
        );

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0225] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a submitted command's chip is clickable in the user's own row",
    async () => {
      const app = await launchTugApp({
        testName: "at0225-clickable-slash-commands-user-row",
      });
      const ingest = (decoded: unknown) =>
        app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded,
        });

      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          sessionMode: "resume",
        });

        // The replay shape: the user's submission persists as claude's
        // `<command-name>` envelope, never as the literal they typed.
        await ingest(replayStarted());
        await ingest(userMsg(COMMAND_ENVELOPE));
        await ingest(asstText("m1", "on it", 0));
        await ingest(turnDone("m1"));
        await ingest(replayComplete());

        // The envelope rebuilds as a command chip whose host span carries
        // the command tag — no inline `<code>` involved.
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-card-id="A"] [data-slot="tug-atom-markdown-body"] span.tug-atom-chip-host.tugx-annotation') !== null`,
          { timeoutMs: 8000 },
        );
        const tagged = JSON.parse(
          await app.evalJS<string>(`JSON.stringify((function(){
            var el = document.querySelector('[data-card-id="A"] [data-slot="tug-atom-markdown-body"] span.tug-atom-chip-host.tugx-annotation');
            return {
              cmd: el.getAttribute('data-slash-command'),
              args: el.getAttribute('data-slash-args'),
              hasChip: el.querySelector('svg') !== null,
            };
          })())`),
        ) as { cmd: string | null; args: string | null; hasChip: boolean };
        expect(tagged.cmd).toBe(KNOWN_CMD);
        expect(tagged.args).toBe(ARG);
        expect(tagged.hasChip).toBe(true);

        // The same click gesture the assistant-side span gets.
        await app.click(
          `[data-card-id="A"] span.tug-atom-chip-host[data-slash-command="${KNOWN_CMD}"]`,
        );
        await app.waitForCondition<boolean>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            if (!cm) return false;
            return (cm.textContent || '').indexOf(${JSON.stringify(ARG)}) !== -1
              && cm.querySelector('img') !== null;
          })()`,
          { timeoutMs: 8000 },
        );

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0225] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
