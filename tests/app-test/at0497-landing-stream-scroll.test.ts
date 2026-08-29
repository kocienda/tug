/**
 * at0497-landing-stream-scroll.test.ts — the wave stays in view while the
 * scribe writes, and the field returns to the top a beat after it stops ([P06]).
 *
 * The Auto-Message scribe streams a commit message into the landing composer.
 * Two things the reader is owed while that happens: the wave — which IS the
 * caret, riding the document's last position — is never off screen, and the
 * text under it does not move except to make room for what was just written.
 * Both are scroll facts, and neither can be read off a unit test: the wave's
 * visibility is its rect against the scroller's, and the scroll it rides is
 * CodeMirror's, settling against line heights only a real layout produces.
 *
 * There is no live scribe here and there does not need to be one: the stream
 * arrives as `changeset_draft_delta` CONTROL frames carrying the message so
 * far, and the test surface hands those to the production control handler
 * (`publishDraftFrame`, SURFACE_VERSION 2.14.0). Store, controller, composer,
 * editor and scroller are all the shipping objects.
 *
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/wave-caret.ts
 * @covers tugdeck/src/lib/changeset-draft-store.ts
 * @covers tugdeck/src/lib/commit-mode-controller.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0497-session";
const FEED_CODE_OUTPUT = 0x40;

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const COMMIT_BUTTON = `${CARD} [data-testid="tug-prompt-entry-commit-button"]`;
const COMMIT_SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0497-stream-"));
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
        size: { width: 820, height: 620 },
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

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/**
 * The message the scribe writes. Its lines are LONG, and that is the point:
 * a line that wraps has a height CodeMirror cannot know until it has laid the
 * line out, so it estimates, renders, measures, and corrects. The correction is
 * what moves text under the reader, and a message of short lines never
 * provokes one.
 */
const MESSAGE_LINES = [
  "at0497(stream): a subject the scribe wrote",
  "",
  "A summary paragraph, prose, the kind the skill puts under the subject so that the reader has the whole shape of the change in hand before any of the detail arrives, which takes rather more words than one line of a composer holds.",
  "",
  "- the first detail, which runs on at the length a real commit message's bullets run on, naming the function it changed and the reason the change was needed, so that it wraps several times over in a field this wide",
  "- the second detail, equally long, because a scribe writing about a change of any size does not write in fragments and the field has to hold what it writes without losing the reader's place in it",
  "- the third detail, which is the one that pushes the message past the height the field is willing to grow to, so everything after this point is read by scrolling",
  "- the fourth detail, long again, arriving while the reader is already watching the wave at the bottom edge of a field that has stopped growing",
  "- the fifth detail, which exists to make the corrections pile up: every one of these lines was estimated at one height and measured at another",
  "- the sixth detail, the last, by which point the document is several times the height of the field that shows it",
];

/**
 * The deltas, as a scribe actually produces them: not one per line but one per
 * few characters, arriving as fast as the transport can carry them. The
 * difference matters — a per-line stream leaves a whole measure cycle between
 * readings, and a scroll that only holds when it is given time to settle is
 * not held at all.
 */
const CHUNK = 7;
const FULL_MESSAGE = MESSAGE_LINES.join("\n");
const DELTAS: string[] = (() => {
  const out: string[] = [];
  for (let at = CHUNK; at < FULL_MESSAGE.length; at += CHUNK) {
    out.push(FULL_MESSAGE.slice(0, at));
  }
  out.push(FULL_MESSAGE);
  return out;
})();

/** What the field looks like right now: the wave against the visible box. */
interface StreamReading {
  waveTop: number;
  waveBottom: number;
  boxTop: number;
  boxBottom: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  waveFound: boolean;
}

describe.skipIf(!SHOULD_RUN)("AT0497: the streamed message's scroll", () => {
  test(
    "the wave never leaves the field, and the field returns to the top a beat after the last word",
    async () => {
      const app = await launchTugApp({ testName: "at0497-landing-stream-scroll" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // The workspace key is declared, not derived, so the draft frames below
        // can be addressed to the same key the composer reads.
        await app.bindSession("A", {
          tugSessionId: SID,
          projectDir,
          workspaceKey: projectDir,
        });
        await app.awaitEngineReady("A");

        const frame = (decoded: Record<string, unknown>) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: { tug_session_id: SID, ...decoded },
          });
        await app.driveSession("A", { op: "send", text: "hello there" });
        await frame({ type: "prompt_anchor", promptUuid: "uuid-1" });
        await frame({ type: "content_block_start", msg_id: "m1", block_index: 0, kind: "text" });
        await frame({
          type: "assistant_text",
          msg_id: "m1",
          block_index: 0,
          text: "hi",
          is_partial: false,
        });
        await frame({ type: "turn_complete", msg_id: "m1", result: "success" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8000 },
        );

        // Enter landing mode — the composer becomes the message field.
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape");
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMMIT_SHEET)}) !== null &&
           document.querySelector(${JSON.stringify(COMMIT_BUTTON)}) !== null`,
          { timeoutMs: 6000 },
        );

        const draftFrame = (body: Record<string, unknown>) =>
          app.evalJS<boolean>(
            `window.__tug.publishDraftFrame(${JSON.stringify(
              JSON.stringify({
                workspace_key: projectDir,
                owner_kind: "session",
                owner_id: SID,
                ...body,
              }),
            )})`,
          );

        const read = (): Promise<StreamReading> =>
          app.evalJS(
            `(() => {
               const content = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
               const scroller = content.closest(".cm-scroller");
               const box = scroller.getBoundingClientRect();
               const wave = content.querySelector(".tug-commit-wave-caret");
               const rect = wave === null ? null : wave.getBoundingClientRect();
               return {
                 waveFound: wave !== null,
                 waveTop: rect === null ? -1 : Math.round(rect.top),
                 waveBottom: rect === null ? -1 : Math.round(rect.bottom),
                 boxTop: Math.round(box.top),
                 boxBottom: Math.round(box.bottom),
                 scrollTop: Math.round(scroller.scrollTop),
                 scrollHeight: Math.round(scroller.scrollHeight),
                 clientHeight: Math.round(scroller.clientHeight),
               };
             })()`,
          );

        // The stream opens.
        expect(await draftFrame({ action: "changeset_draft_state", state: "drafting" })).toBe(true);
        await settle();

        // Whether this window animates at all decides what the run below is
        // worth: the scroll is held across CodeMirror's measure cycle, and that
        // cycle is driven by `requestAnimationFrame`. A window that never
        // animates never runs it, and a green run would be proving nothing.
        await app.evalJS<boolean>(
          `(() => {
             window.__at0497Frames = 0;
             const tick = () => { window.__at0497Frames += 1; requestAnimationFrame(tick); };
             requestAnimationFrame(tick);
             return true;
           })()`,
        );
        await settle(300);
        note(
          `at0497 animation: ${await app.evalJS<string>(
            `window.__at0497Frames + " frames in 300ms, visibility " + document.visibilityState`,
          )}`,
        );

        // Every cumulative reading, at the rate they arrive.
        const offenders: string[] = [];
        for (const [index, text] of DELTAS.entries()) {
          await draftFrame({ action: "changeset_draft_delta", text });
          // No pause. The claim is that the end of the document is AT the end
          // of the field, not that it gets there if the field is given a
          // moment — a reading taken the instant the delta lands is exactly
          // the reading a pin that answers only deltas cannot survive.
          const reading = await read();
          if (index === 0 || index === DELTAS.length - 1) {
            note(`at0497 delta ${index}: ${JSON.stringify(reading)}`);
          }
          if (!reading.waveFound) {
            offenders.push(`delta ${index}: no wave in the field at all`);
            continue;
          }
          const inside =
            reading.waveBottom <= reading.boxBottom + 2 && reading.waveTop >= reading.boxTop - 2;
          if (!inside) {
            offenders.push(
              `delta ${index}: wave ${reading.waveTop}..${reading.waveBottom} outside ` +
                `${reading.boxTop}..${reading.boxBottom} (scrollTop ${reading.scrollTop} of ` +
                `${reading.scrollHeight - reading.clientHeight})`,
            );
          }
        }
        note(`at0497 offenders: ${offenders.length === 0 ? "none" : offenders.join(" | ")}`);
        expect(offenders, "the wave is in the field for every delta").toEqual([]);

        // The message overflowed the field — otherwise the run above proved
        // nothing, because everything was on screen anyway.
        const atEnd = await read();
        expect(
          atEnd.scrollHeight - atEnd.clientHeight,
          "the message outgrew the field, so staying in view meant scrolling",
        ).toBeGreaterThan(0);

        // And it comes to rest AT the end, not a few pixels short of it. The
        // last delta's height correction lands after the delta that provoked
        // it, with no further delta behind it to answer it — so this is the
        // reading that says the pin is standing on its own rather than being
        // carried along by the next write.
        await settle(200);
        const rested = await read();
        note(`at0497 rested: ${JSON.stringify(rested)}`);
        expect(
          rested.scrollTop,
          "the stream comes to rest at the document's end",
        ).toBe(rested.scrollHeight - rested.clientHeight);

        // The scribe stops. The tail holds for a beat — the eye is still there —
        // and then the field returns to the top for the read.
        await draftFrame({ action: "changeset_draft_state", state: "ready" });
        await settle(120);
        const justSettled = await read();
        note(`at0497 just settled: ${JSON.stringify(justSettled)}`);
        expect(
          justSettled.scrollTop,
          "the beat has not passed yet, so the tail is still where the eye was",
        ).toBeGreaterThan(0);

        await settle(900);
        const afterBeat = await read();
        note(`at0497 after the beat: ${JSON.stringify(afterBeat)}`);
        expect(afterBeat.scrollTop, "and then the message is shown from its top").toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
