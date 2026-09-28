/**
 * AT0647: one mic, and every way of losing it.
 *
 * `at0646` proves dictation works in one composer. This file proves the harder
 * half: that there is only ever **one** live mic in the whole deck, and that it
 * is given up by things the user never asked about.
 *
 * Why exclusivity is not free. The host enforces one live session too, but it
 * knows nothing about composers — a second `start` supersedes the first, and
 * without the deck's own arbitration the first composer would be left believing
 * it was dictating into a span nothing will ever feed again. So the claim here
 * is specifically about the *deck*: the first button leaves its live face and the
 * second takes it, with a different id.
 *
 * And why the involuntary releases matter more than the voluntary one. A mic the
 * user turned off is a mic they know about. A mic still live while they have
 * walked off to another app is a microphone recording somebody who has forgotten
 * it is on. That is the release nothing else in the deck could notice, which is
 * why the store subscribes to app lifecycle for the length of a claim — and why
 * `simulateAppResign()` is an assertion here rather than a nicety.
 *
 * Three claims:
 *
 * 1. **The mic moves, and does not duplicate.** Start in the Session, press the
 *    Overview's mic: the Session's reads `idle`, the Overview's reads `live`, and
 *    the two ids differ. Then a `final` for the Overview's id lands in the
 *    Overview's field — the handle followed the claim.
 * 2. **App resign ends it, and keeps what was settled.** The text the recogniser
 *    committed is the user's draft and stays; the session is over.
 * 3. **Escape ends dictation and interrupts nothing** ([P09]). With a live mic
 *    and no running turn, Escape closes the mic, drops the provisional tail, and
 *    leaves the transcript alone — an Escape that stopped a turn while leaving
 *    the mic open would be the worst of both.
 *
 * No microphone is engaged: the host answers `start` with `ready` under the
 * harness ([P01]) and every transcript below is scripted through
 * `window.__tugBridge.onDictation`.
 *
 * @covers tugdeck/src/lib/dictation-store.ts
 * @covers tugdeck/src/components/tugways/tug-dictation-button.tsx
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/overview/overview-insert-target.ts
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/dictation-span.ts
 * @covers tugapp/Sources/DictationEngine.swift
 *
 * @foreground
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CARD = '[data-card-id="A"]';
const SESSION_MIC = `${CARD} [data-testid="tug-dictation-button"]`;
const SESSION_EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SESSION_SUBMIT = `${CARD} .tug-prompt-entry-submit-button`;
const USER_TURN = `${CARD} [data-testid="session-card-transcript-user-body"]`;

const OVERVIEW_CARD = '[data-testid="overview-card"]';
const OVERVIEW_FIELD = '[data-testid="overview-composer-field"]';
const OVERVIEW_MIC = `${OVERVIEW_CARD} [data-testid="tug-dictation-button"]`;
const OVERVIEW_TEXT = `${OVERVIEW_FIELD} .cm-content`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 760, height: 560 },
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

async function push(app: App, event: Record<string, unknown>): Promise<void> {
  await app.evalJS<null>(
    `(window.__tugBridge.onDictation(${JSON.stringify(event)}), null)`,
  );
}

const exists = (selector: string): string =>
  `document.querySelector(${JSON.stringify(selector)}) !== null`;

const modeIs = (selector: string, mode: string): string =>
  `document.querySelector(${JSON.stringify(selector)})?.getAttribute("data-mode") === ${JSON.stringify(mode)}`;

const textOf = (selector: string): string =>
  `(document.querySelector(${JSON.stringify(selector)})?.textContent || "")`;

/**
 * Whether a composer's document holds `text`.
 *
 * Read as containment rather than equality because CodeMirror renders its
 * placeholder *inside* `.cm-content`: an empty composer's text content is the
 * hint, not the empty string, so `=== ""` would assert about the placeholder
 * copy rather than about the document.
 */
const holds = (selector: string, text: string): string =>
  `${textOf(selector)}.indexOf(${JSON.stringify(text)}) !== -1`;

/**
 * Press a button through a dispatched DOM click rather than a native one.
 *
 * Needed for the Overview's mic and nothing else. The rail is a canvas pane and
 * the deck docks it past the right edge of the harness window's viewport — the
 * diagnostic below records the numbers — so `nativeClickAtElement` resolves a
 * viewport point the WKWebView refuses, which is a fact about where an unpinned
 * harness window puts the canvas rather than anything about the button.
 *
 * The claim this file makes is about arbitration: which composer holds the mic
 * after a press. That a real pointer reaches the Overview composer's controls is
 * `at0533`'s claim, made with a native click, so nothing is left unpinned by
 * taking the DOM seam here. The event is a real bubbling click through React's
 * root listener, so the `onClick` path under test is the production one.
 */
async function domClick(app: App, selector: string): Promise<void> {
  const hit = await app.evalJS<boolean>(
    `(function(){
       var el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) return false;
       el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
       return true;
     })()`,
  );
  if (!hit) throw new Error(`domClick: no element for ${selector}`);
}

describe.skipIf(!SHOULD_RUN)("AT0647: one mic across the deck", () => {
  test(
    "the mic moves between composers with a fresh id, app resign ends it keeping settled text, and Escape ends it without interrupting",
    async () => {
      // Foreground, because claim 2 is `simulateAppResign()` and an app that was
      // never active cannot resign — the notification never fires and the verb
      // times out. This is the declared class of test that takes the screen.
      const app = await launchTugApp({
        testName: "at0647-dictation-exclusive",
        foreground: true,
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        // The session card mounts its picker by default; binding a fake session
        // is what renders `SessionCardBody` and with it the prompt entry. Bound
        // before the host-root wait, which is the order `at0024` establishes.
        await app.bindSession("A");
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.awaitEngineReady("A");
        await app.waitForCondition<boolean>(exists(SESSION_SUBMIT), { timeoutMs: 8000 });
        await app.waitForCondition<boolean>(exists(SESSION_MIC), { timeoutMs: 8000 });

        // The rail, so there are two composers to arbitrate between.
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(exists(OVERVIEW_MIC), { timeoutMs: 10_000 });
        note(
          "geometry",
          await app.evalJS<string>(
            `(function(){
               var s = document.querySelector(${JSON.stringify(SESSION_MIC)}).getBoundingClientRect();
               var o = document.querySelector(${JSON.stringify(OVERVIEW_MIC)}).getBoundingClientRect();
               return "session " + Math.round(s.x) + "," + Math.round(s.y) +
                 " overview " + Math.round(o.x) + "," + Math.round(o.y) +
                 " viewport " + window.innerWidth + "x" + window.innerHeight;
             })()`,
          ),
        );

        // ── 1. The mic moves. ─────────────────────────────────────────────
        await app.nativeClickAtElement(SESSION_MIC);
        await app.waitForCondition<boolean>(modeIs(SESSION_MIC, "live"), {
          timeoutMs: 10_000,
        });
        const firstId = await app.getElementAttribute(SESSION_MIC, "data-dictation-id");
        expect((firstId ?? "").length).toBeGreaterThan(0);

        await domClick(app, OVERVIEW_MIC);
        await app.waitForCondition<boolean>(modeIs(OVERVIEW_MIC, "live"), {
          timeoutMs: 10_000,
        });
        // The one claim the host cannot make for us: the composer that lost the
        // mic knows it lost the mic.
        await app.waitForCondition<boolean>(modeIs(SESSION_MIC, "idle"), {
          timeoutMs: 10_000,
        });
        const secondId = await app.getElementAttribute(OVERVIEW_MIC, "data-dictation-id");
        note("session id then overview id", `${firstId} → ${secondId}`);
        // A fresh id per start. Shared ids would make a superseded session's
        // late results indistinguishable from the live one's.
        expect(secondId).not.toBe(firstId);

        // And the handle went with the claim: text for the Overview's id lands
        // in the Overview's field and nowhere else.
        await push(app, { id: secondId, kind: "final", text: "what changed today" });
        await app.waitForCondition<boolean>(
          `${textOf(OVERVIEW_TEXT)} === "what changed today"`,
          { timeoutMs: 10_000 },
        );
        // The Session composer never saw it: the handle went with the claim.
        expect(
          await app.evalJS<boolean>(holds(SESSION_EDITOR, "what changed today")),
        ).toBe(false);

        // ── 2. App resign ends it, keeping the settled text. ──────────────
        await push(app, { id: secondId, kind: "volatile", text: " and yesterday" });
        await app.waitForCondition<boolean>(
          `${textOf(OVERVIEW_TEXT)} === "what changed today and yesterday"`,
          { timeoutMs: 10_000 },
        );
        await app.simulateAppResign();
        await app.waitForCondition<boolean>(modeIs(OVERVIEW_MIC, "idle"), {
          timeoutMs: 10_000,
        });
        const afterResign = await app.evalJS<string>(textOf(OVERVIEW_TEXT));
        note("overview text after resign", afterResign);
        // The unsettled tail goes with the session; the settled words are the
        // user's draft and are still there when they come back to the app.
        expect(afterResign).toBe("what changed today");

        // ── 3. Escape ends dictation and interrupts nothing ([P09]). ──────
        // Back in the Session composer, with no turn running — so the only
        // thing Escape has to act on is the mic.
        await app.nativeClickAtElement(SESSION_MIC);
        await app.waitForCondition<boolean>(modeIs(SESSION_MIC, "live"), {
          timeoutMs: 10_000,
        });
        const thirdId = await app.getElementAttribute(SESSION_MIC, "data-dictation-id");
        await push(app, { id: thirdId, kind: "volatile", text: "never mind" });
        await app.waitForCondition<boolean>(
          `${textOf(SESSION_EDITOR)} === "never mind"`,
          { timeoutMs: 10_000 },
        );

        // The caret has to be in the field for the responder walk to start at
        // this composer, which is the real gesture: the user is mid-sentence and
        // changes their mind.
        await app.nativeClickAtElement(SESSION_EDITOR);
        await app.waitForCondition<boolean>(
          `(function(){
             var field = document.querySelector(${JSON.stringify(SESSION_EDITOR)});
             return field !== null && document.activeElement !== null &&
               (field === document.activeElement || field.contains(document.activeElement));
           })()`,
          { timeoutMs: 10_000 },
        );
        await app.nativeKey("Escape");

        await app.waitForCondition<boolean>(modeIs(SESSION_MIC, "idle"), {
          timeoutMs: 10_000,
        });
        // Nothing was settled, so nothing is kept — the whole sentence was
        // provisional and Escape is the user saying they did not mean it.
        expect(await app.evalJS<boolean>(holds(SESSION_EDITOR, "never mind"))).toBe(false);
        // And no turn was interrupted, because none was started: an Escape that
        // reached `popInteractive` past a live mic would be the defect [P09]
        // orders the ladder to prevent.
        expect(await app.evalJS<boolean>(exists(USER_TURN))).toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
