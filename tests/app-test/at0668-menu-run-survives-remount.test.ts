/**
 * at0668-menu-run-survives-remount.test.ts — a command the menu was asked to
 * run still runs when the composer holding it is torn down and rebuilt first.
 *
 * Run in This Session and Run in New Session both seed the composer and send.
 * When the card cannot send yet, the run is ARMED and waits in the composer —
 * and on a fresh card that is exactly where it got lost: the composer was
 * rebuilt before it could send, the rebuilt instance never saw the seed, and
 * the card host's content restore wrote the saved draft over whatever was
 * left. The reader saw an empty composer and nothing to say why.
 *
 * The run now lives on the store's command slot until it is taken, so a
 * rebuilt composer seeds it again and a content restore leaves it alone. This
 * drives that rebuild on a live card: the transport drops (the card can no
 * longer send, so the run arms), the transport recovers into `restoring`
 * (which unmounts the body), and the binding lands again (which remounts it).
 * The run must then go out — the composer empty, the command in the transcript
 * as the reader's own row.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/code-session-store.ts
 * @covers tugdeck/src/components/tugways/use-annotation-menu.tsx
 * @covers tugdeck/src/lib/annotator/registry.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A";

const CMD = "arc";
const BRIEF = "briefs/a-thing-brief.md";
const LINE = `/${CMD} a-thing @${BRIEF}`;

const SPAN = `[data-card-id="A"] code.tugx-annotation[data-slash-command="${CMD}"]`;
const PROMPT_INPUT = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const USER_ROWS = '[data-card-id="A"] [data-testid="session-card-transcript-user-body"]';

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0668-run-remount-"));
  mkdirSync(join(projectDir, "briefs"), { recursive: true });
  writeFileSync(join(projectDir, BRIEF), "# A thing\n");
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

describe.skipIf(!SHOULD_RUN)("AT0668: a menu run survives a composer rebuild", () => {
  test(
    "an armed run goes out after the body unmounts and remounts",
    async () => {
      const app = await launchTugApp({ testName: "at0668-run-survives-remount" });
      const ingest = (decoded: unknown) =>
        app.driveSession("A", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });
      try {
        await app.seedDeckState({
          state: {
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
          },
          focusCardId: "A",
        });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID, sessionMode: "resume", projectDir });
        await app.ingestSessionMetadata("A", {
          type: "session_capabilities",
          models: [{ value: "default", displayName: "Default" }],
          commands: [CMD],
          agents: [],
          available_output_styles: [],
          output_style: "default",
          account: null,
          effort: null,
          ipc_version: 2,
        });
        await ingest({ type: "replay_started", tug_session_id: SID });
        await ingest({
          type: "add_user_message",
          tug_session_id: SID,
          content: [{ type: "text", text: "write a brief" }],
        });
        await ingest({
          type: "assistant_text",
          tug_session_id: SID,
          msg_id: "m1",
          text: `Wrote the brief. Run it with \`${LINE}\`.`,
          is_partial: false,
          rev: 0,
          seq: 0,
        });
        await ingest({ type: "turn_complete", tug_session_id: SID, msg_id: "m1", result: "success" });
        await ingest({
          type: "replay_complete",
          tug_session_id: SID,
          count: 1,
          firstLoadedTurnIndex: 0,
          totalTurns: 1,
          hasOlder: false,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SPAN)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // The wire drops: the card can no longer send, so the run arms.
        await app.driveSession("A", { op: "transportClose" });

        await app.evalJS(
          `(() => { const el = document.querySelector(${JSON.stringify(SPAN)}); if (el) el.scrollIntoView({ block: "center" }); return !!el; })()`,
        );
        await app.nativeRightClickAtElement(SPAN);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-item-action="run-command-here"]') !== null`,
          { timeoutMs: 6000 },
        );
        const point = await app.evalJS<{ x: number; y: number } | null>(
          `(() => {
            const item = document.querySelector('[data-item-action="run-command-here"]');
            if (item === null) return null;
            const r = item.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()`,
        );
        expect(point).not.toBeNull();
        await app.nativeClick(point as { x: number; y: number });

        // Armed, not sent: the command waits in the composer.
        await app.waitForCondition<boolean>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            return cm !== null && cm.querySelector('[data-atom-type="command"]') !== null;
          })()`,
          { timeoutMs: 10_000 },
        );
        expect(await app.evalJS<number>(`document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length`)).toBe(1);

        // Recovery moves the card to `restoring`, which unmounts the body…
        await app.driveSession("A", { op: "transportReconnect" });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROMPT_INPUT)}) === null`,
          { timeoutMs: 10_000 },
        );
        // …and the binding's re-ack settles it, which mounts a new one.
        await app.driveSession("A", { op: "transportSettled" });

        // The run goes out from the rebuilt composer: the command arrives as
        // the reader's own row, and the composer is left empty.
        let sent = false;
        try {
          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(USER_ROWS)})).some(function(r){
              return (r.textContent || '').indexOf(${JSON.stringify(BRIEF)}) !== -1;
            })`,
            { timeoutMs: 15_000 },
          );
          sent = true;
        } catch {
          sent = false;
        }
        const composer = await app.evalJS<string>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            if (!cm) return 'no composer';
            return (cm.textContent || '') + ' atoms=' + cm.querySelectorAll('[data-atom-type]').length;
          })()`,
        );
        note("at0668 composer after the rebuild", composer);
        expect(sent).toBe(true);
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0668] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
