/**
 * at0600-restore-gate-silence-deadline.test.ts — a restore that goes
 * quiet costs one card, not the app.
 *
 * The app-modal restore gate is undismissable by design: Escape is
 * prevented and it has no button, because while a cold restore's reveal
 * is running there is nothing behind it to reach. That is only sound
 * while something guarantees the gate closes. `replay_complete` was the
 * one thing that closed it, and nothing guarantees a frame — a relay
 * that died mid-bracket left *Restoring 1 session — 1 of 1 turns* over
 * an idle app, on every launch, with the offending card unreachable
 * behind the modal.
 *
 * The case here is that one: a resume-mode card opens a replay bracket,
 * ingests a whole turn, and then hears nothing. No `replay_complete`
 * ever arrives. What must hold:
 *
 *  - while the bracket is being fed, the modal is up;
 *  - after `REPLAY_SILENCE_DEADLINE_MS` of silence the modal closes on
 *    its own, with no frame from the wire to prompt it;
 *  - the card that stalled says so on itself, through the error banner,
 *    and the turn it had already restored is still there.
 *
 * The deadline is 15 s of real time and the test waits it out: the
 * timer under test is the production one, armed by the store on the
 * frames the harness feeds through the real `routeFrame` path.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/code-session-store.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugdeck/src/lib/restore-gate-store.ts
 * @covers tugdeck/src/components/tugways/tug-restore-gate.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-restore-gate.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 120_000;

/** `FeedId.CODE_OUTPUT` — hardcoded; the app-test graph does not import tugdeck. */
const CODE_OUTPUT_FEED = 0x40;

const SID = "test-session-at0600";

/**
 * `REPLAY_SILENCE_DEADLINE_MS` is 15 s. The wait allows it that plus
 * headroom for a loaded machine; it is a ceiling, not the expectation.
 */
const SILENCE_WAIT_MS = 30_000;

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

const GATE_OPEN_JS = `document.querySelector('[data-slot="tug-restore-gate"]') !== null`;

// `TugPaneBanner` portals into the pane chrome, not the card's own
// subtree, so it is found document-wide. The deck holds one card, so a
// banner anywhere is that card's.
const BANNER_JS = `JSON.stringify((function(){
  var el = document.querySelector(
    '[data-slot="tug-pane-banner"][data-variant="error"]');
  return el === null ? { found: false } : { found: true, text: el.textContent || "" };
})())`;

describe.skipIf(!SHOULD_RUN)(
  "AT0600: a restore that goes quiet closes the app-modal and errors its own card",
  () => {
    test(
      "withholding replay_complete trips the silence deadline",
      async () => {
        const app = await launchTugApp({
          testName: "at0600-restore-gate-silence-deadline",
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

          // The bracket opens and a whole turn arrives: every turn is in
          // and the app is idle — and the closing frame never comes.
          await ingest(replayStarted());
          await ingest(userMsg("what happened"));
          await ingest(asstText("m1", "The relay went quiet.", 1));
          await ingest(turnDone("m1"));

          await app.waitForCondition<boolean>(GATE_OPEN_JS, { timeoutMs: 8000 });
          const openedAt = Date.now();

          // Nothing else is sent. The modal has to close by itself.
          await app.waitForCondition<boolean>(`!(${GATE_OPEN_JS})`, {
            timeoutMs: SILENCE_WAIT_MS,
          });
          const heldMs = Date.now() - openedAt;
          note("restore gate closed after ms of silence", heldMs);
          // It measured a deadline rather than closing for some earlier,
          // unrelated reason: the gate held for most of the 15 s.
          expect(heldMs).toBeGreaterThan(10_000);

          // The card that stalled carries the error, on itself.
          await app.waitForCondition<boolean>(
            `JSON.parse(${BANNER_JS}).found === true`,
            { timeoutMs: 8000 },
          );
          const banner = JSON.parse(await app.evalJS<string>(BANNER_JS)) as {
            found: boolean;
            text?: string;
          };
          expect(banner.text).toContain("Restore stalled");
          expect(banner.text).toContain("stopped responding");

          // And what it had restored is not thrown away with the bracket.
          const transcript = await app.evalJS<string>(
            `(document.querySelector('[data-card-id="A"]') || document.body).textContent || ""`,
          );
          expect(transcript).toContain("The relay went quiet.");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
