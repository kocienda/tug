/**
 * at0600-restore-gate-silence-deadline.test.ts — a restore that goes
 * quiet costs one card, not the app.
 *
 * ## What changed, and why the file kept its name
 *
 * The subject sentence above is the same one this file has always
 * carried; the mechanism under it is not. There used to be an app-wide
 * blocking modal over the whole deck for the duration of any cold
 * restore — undismissable by design, because while a restore's reveal
 * runs there is nothing behind it to reach. It had exactly one close,
 * `replay_complete`, and nothing on a wire guarantees a frame. A relay
 * that died mid-bracket left *Restoring 1 session — 1 of 1 turns* over
 * an idle app, on every launch, with the offending card unreachable
 * behind the panel. A silence deadline was added to bound that, and
 * this test was written to pin the deadline.
 *
 * The deadline was the wrong fix for the right defect: a modal whose
 * safety rests on a timer is a construction that can still hold the
 * whole app on one card's lost frame, just not forever. So the modal is
 * gone. `replaying` is a state of one card now, drawn by that card's own
 * `SessionRestoring` placeholder — which carries a Cancel button, the
 * user exit the app-modal never had.
 *
 * ## What this pins
 *
 * Card A is a resume-mode card that opens a replay bracket, ingests a
 * whole turn, and then hears nothing; no `replay_complete` ever arrives.
 * While A is stuck:
 *
 *  - **no app-modal is mounted at all** — not the gate's slot, not a
 *    scrim over the canvas; A's restore reads on A's own `Z0` strip;
 *  - card B, a second session card, takes a click, takes real
 *    keystrokes, and submits them;
 *  - a non-session card takes a click and takes typing.
 *
 * Every one of those was impossible under the old modal, and the first
 * is the one that makes the other two structural rather than lucky: a
 * full-viewport scrim spends the click and the keystrokes that follow it
 * go to the modal's focus trap.
 *
 * Then A's own deadline still lands, on A alone: its restore strip comes
 * down under the `lastError` the silence tick raises, its pane shows the
 * failure, and the turn it had already restored is still there.
 *
 * The deadline is 15 s of real time and the test waits it out: the timer
 * under test is the production one, armed by the store on the frames the
 * harness feeds through the real `routeFrame` path.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/code-session-store.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-restore-gate.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import { keyboardIsInCard } from "./_harness/selectors";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 180_000;

/** `FeedId.CODE_OUTPUT` — hardcoded; the app-test graph does not import tugdeck. */
const CODE_OUTPUT_FEED = 0x40;

const SID = "test-session-at0600";

/**
 * `REPLAY_SILENCE_DEADLINE_MS` is 15 s. The wait allows it that plus
 * headroom for a loaded machine; it is a ceiling, not the expectation.
 */
const SILENCE_WAIT_MS = 30_000;

/** The stuck card, the live neighbour, and the non-session bystander. */
const CARD_A = '[data-card-id="A"]';
const CARD_B = '[data-card-id="B"]';

/** `gallery-input`'s persisted TugInput — the bystander's own text surface. */
const INPUT_PERSIST_KEY = "gallery-input/size/sm";
const INPUT_C = `[data-card-id="C"] [data-tug-state-key="${INPUT_PERSIST_KEY}"]`;

const EDITOR_B = `${CARD_B} [data-slot="tug-text-editor"] .cm-content`;
const ENTRY_B = `${CARD_B} [data-slot="tug-prompt-entry"]`;
const SUBMIT_B = `${CARD_B} .tug-prompt-entry-submit-button`;

/**
 * A's own restore surface: the `Z0` load-control bar's restore strip,
 * whose restore arm is `deriveColdRestoreActive` alone. It is a strip
 * over a mounted, usable body — the card is *reading* rather than
 * blocked, which is the whole difference from the app-modal — and it
 * goes away on exactly the predicate the modal used to close on.
 *
 * Both halves are asserted, and both are needed. The band's visibility
 * lives on `data-visible` ([L06] — appearance in the DOM, never React
 * state); its copy is written from a *sticky* load-kind ref that stays
 * on "restore" for the life of the card, so the words alone would say
 * "Restoring" forever and the attribute alone would not distinguish a
 * restore from a paged "Loading earlier turns…".
 */
const A_RESTORING = `(function(){
  var bar = document.querySelector(${JSON.stringify(
    `${CARD_A} [data-slot="session-load-overlay"] [data-slot="tug-control-bar"]`,
  )});
  if (bar === null || bar.getAttribute("data-visible") !== "true") return false;
  return (bar.textContent || "").indexOf("Restoring the most recent") !== -1;
})()`;

/**
 * Every app-modal the deck can raise, as the user would meet one: the
 * deleted gate's own slot, and the shared alert chrome any app-modal
 * mounts (`TugVersionGate`, `ConfigureTug`). The scrim is the thing that
 * actually eats the clicks below, so it is what is asserted against —
 * naming only the dead slot would pass even if the modal came back
 * wearing a different name.
 */
const APP_MODAL_COUNT = `(function(){
  return document.querySelectorAll(
    '[data-slot="tug-restore-gate"], .tug-alert-overlay, .tug-alert-content'
  ).length;
})()`;

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Stuck", closable: true },
      { id: "B", componentId: "session", title: "Live", closable: true },
      { id: "C", componentId: "gallery-input", title: "Bystander", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 30, y: 30 },
        size: { width: 620, height: 520 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 680, y: 30 },
        size: { width: 620, height: 520 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p3",
        position: { x: 30, y: 580 },
        size: { width: 420, height: 240 },
        cardIds: ["C"],
        activeCardId: "C",
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

// `TugPaneBanner` portals into its own pane's chrome (`data-pane-id`), so
// with three panes on screen the banner is asked for by pane rather than
// document-wide.
const BANNER_IN = (paneId: string) => `JSON.stringify((function(){
  var el = document.querySelector(
    '[data-pane-id=${JSON.stringify(paneId)}] [data-slot="tug-pane-banner"][data-variant="error"]');
  return el === null ? { found: false } : { found: true, text: el.textContent || "" };
})())`;

describe.skipIf(!SHOULD_RUN)(
  "AT0600: a restore that goes quiet costs one card, not the app",
  () => {
    test(
      "a card stuck in replaying leaves the rest of the deck fully live",
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
          // `awaitEngineReady` reads the deck-trace ring for B's
          // `engine-ready` entry, and the ring records nothing until this
          // is on.
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          for (const id of ["A", "B", "C"]) {
            await app.waitForCondition<boolean>(
              `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(id)})`,
              { timeoutMs: 30_000 },
            );
          }

          // B is brought up FIRST and deliberately: A's silence deadline
          // starts the moment its bracket opens, and nothing that is only
          // setup should be spending it.
          await app.bindSession("B");
          await app.awaitEngineReady("B", { timeoutMs: 30_000 });

          // ── A opens a bracket, takes a whole turn, and goes quiet ────
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
          });
          await ingest(replayStarted());
          await ingest(userMsg("what happened"));
          await ingest(asstText("m1", "The relay went quiet.", 1));
          await ingest(turnDone("m1"));

          await app.waitForCondition<boolean>(A_RESTORING, { timeoutMs: 8000 });

          // ── the claim: the app is not held ──────────────────────────
          // Nothing is over the deck. This is the assertion the whole
          // step exists for; the two that follow only demonstrate what it
          // buys.
          expect(await app.evalJS<number>(APP_MODAL_COUNT)).toBe(0);

          // The bystander takes a click and takes typing.
          await app.nativeClickAtElement(INPUT_C);
          await app.waitForCondition<boolean>(
            `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(INPUT_C)})`,
            { timeoutMs: 6000 },
          );
          await app.type(INPUT_C, "still here");
          expect(
            await app.getFormControlValue("C", INPUT_PERSIST_KEY),
          ).toBe("still here");

          // The neighbouring session card takes a click, takes REAL
          // keystrokes — the thing the modal's focus trap used to eat —
          // and submits them.
          await app.nativeClickAtElement(EDITOR_B);
          await app.waitForCondition<boolean>(keyboardIsInCard("B"), {
            timeoutMs: 6000,
          });
          await app.nativeType("hello from the live card");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(ENTRY_B)})?.getAttribute("data-empty") === "false"`,
            { timeoutMs: 6000 },
          );
          await app.click(SUBMIT_B);
          // The submit ran: the composer gave its words up.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(ENTRY_B)})?.getAttribute("data-empty") === "true"`,
            { timeoutMs: 8000 },
          );

          // And A was stuck for the whole of that, which is what makes
          // the three assertions above mean anything.
          expect(await app.evalJS<boolean>(A_RESTORING)).toBe(true);

          // ── now A's own deadline, measured from a known frame ────────
          // One more bracket frame re-arms the silence timer, so the wait
          // below measures the deadline rather than the deadline less
          // however long the deck interactions took.
          await ingest(userMsg("are you there"));
          const openedAt = Date.now();

          await app.waitForCondition<boolean>(`!(${A_RESTORING})`, {
            timeoutMs: SILENCE_WAIT_MS,
          });
          const heldMs = Date.now() - openedAt;
          note("A's restore strip held for ms of silence", heldMs);
          // It measured a deadline rather than coming down for some
          // earlier, unrelated reason.
          expect(heldMs).toBeGreaterThan(10_000);

          // The card that stalled carries the error, on its own pane.
          await app.waitForCondition<boolean>(
            `JSON.parse(${BANNER_IN("p1")}).found === true`,
            { timeoutMs: 8000 },
          );
          const banner = JSON.parse(
            await app.evalJS<string>(BANNER_IN("p1")),
          ) as { found: boolean; text?: string };
          expect(banner.text).toContain("Restore stalled");
          expect(banner.text).toContain("stopped responding");

          // Its neighbour was never told anything.
          expect(
            JSON.parse(await app.evalJS<string>(BANNER_IN("p2"))).found,
          ).toBe(false);

          // And what A had restored is not thrown away with the bracket.
          const transcript = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(CARD_A)}) || document.body).textContent || ""`,
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
