/**
 * AT0646: dictating into the Session composer — the whole path, meeting.
 *
 * Every piece of dictation has a unit test behind it. What none of them can say
 * is that the pieces are wired to each other inside the real app: that the mic
 * renders where the eye looks for it, that a press reaches the host and comes
 * back `ready`, that text the host reports lands in *that* composer's document
 * with the provisional part visibly unsettled, and — the claim the whole feature
 * lives or dies on — that stopping dictation keeps the text and submits nothing.
 *
 * **No microphone is engaged here, by construction.** Under the test harness the
 * host answers `start` with `ready` without touching audio ([P01]), so this file
 * never reaches TCC and never records anyone. The transcript is scripted: events
 * are pushed through `window.__tugBridge.onDictation` exactly as
 * `MainWindow.bridgeDictationEvent` pushes them, which is also what lets the
 * assertions be about text rather than about a recogniser's mood.
 *
 * Four claims:
 *
 * 1. **The mic is in the Z5 trailing row, before Submit.** A control the user
 *    cannot find is a control that does not exist, and "before Submit" is the
 *    whole of where it belongs (Spec S06).
 * 2. **A press goes live, and the button says which session it is.** `data-mode`
 *    reads `live` and `data-dictation-id` is non-empty — the id is how the deck
 *    drops a superseded session's late events, so a button that cannot name its
 *    session is a claim nothing can arbitrate.
 * 3. **Provisional text is visibly provisional, and settling it takes the mark
 *    away.** A `volatile` puts text in `.cm-content` with a
 *    `.tug-dictation-volatile` element over it; a `final` leaves the same words
 *    with no mark. That element is the only thing telling the user the machine
 *    has not committed to what it heard.
 * 4. **Closing keeps every word and submits nothing.** A tap on the mic is the
 *    user saying they are done talking, so the deck asks the host to finish and
 *    keeps what comes back — including a tail the recogniser never settled,
 *    which the harness's no-audio finish returns as-is. And no user turn appears
 *    in the transcript, because dictation writes text and nothing acts on its
 *    own ([B03] of `briefs/dictation-finish-brief.md`).
 *
 * Then [P08], in the app: with a draft already in the field and the caret at its
 * end, the next session opens on a new line rather than running into the word
 * the user last typed.
 *
 * @covers tugdeck/src/components/tugways/tug-dictation-button.tsx
 * @covers tugdeck/src/components/tugways/tug-dictation-button.css
 * @covers tugdeck/src/components/tugways/tug-text-editor/dictation-span.ts
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/lib/dictation-store.ts
 * @covers tugdeck/src/lib/dictation-bridge.ts
 * @covers tugdeck/src/lib/prompt-insert-target.ts
 * @covers tugapp/Sources/DictationEngine.swift
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CARD = '[data-card-id="A"]';
const MIC = `${CARD} [data-testid="tug-dictation-button"]`;
const SUBMIT = `${CARD} .tug-prompt-entry-submit-button`;
const TRAILING = `${CARD} .tug-prompt-entry-toolbar`;
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const VOLATILE = `${EDITOR} .tug-dictation-volatile`;
/** Any user turn the transcript has drawn. Dictation must never mint one. */
const USER_TURN = `${CARD} [data-testid="session-card-transcript-user-body"]`;

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

/** One event, in the shape `DictationEvent.jsonObject` emits host-side. */
async function push(app: App, event: Record<string, unknown>): Promise<void> {
  await app.evalJS<null>(
    `(window.__tugBridge.onDictation(${JSON.stringify(event)}), null)`,
  );
}

/** The document as the user reads it. */
function docText(app: App): Promise<string> {
  return app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(EDITOR)}).textContent || "")`,
  );
}

const exists = (selector: string): string =>
  `document.querySelector(${JSON.stringify(selector)}) !== null`;

describe.skipIf(!SHOULD_RUN)("AT0646: dictation lands in the Session composer", () => {
  test(
    "the mic sits before Submit, a press goes live, scripted text lands with the tail dimmed then settled, and closing keeps the text and submits nothing",
    async () => {
      const app = await launchTugApp({ testName: "at0646-dictation-span" });
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
        await app.waitForCondition<boolean>(exists(SUBMIT), { timeoutMs: 8000 });

        // ── 1. The mic is there, and it is before Submit. ──────────────────
        await app.waitForCondition<boolean>(exists(MIC), { timeoutMs: 8000 });
        // Document order inside the trailing row, which is what the eye reads
        // left to right. `compareDocumentPosition`'s FOLLOWING bit (4) is set
        // when the mic comes first.
        const micBeforeSubmit = await app.evalJS<boolean>(
          `(function(){
            var row = document.querySelector(${JSON.stringify(TRAILING)});
            var mic = document.querySelector(${JSON.stringify(MIC)});
            var submit = document.querySelector(${JSON.stringify(SUBMIT)});
            if (row === null || mic === null || submit === null) return false;
            if (!row.contains(mic)) return false;
            return (mic.compareDocumentPosition(submit) & 4) !== 0;
          })()`,
        );
        expect(micBeforeSubmit).toBe(true);
        expect(
          await app.evalJS<string>(
            `document.querySelector(${JSON.stringify(MIC)}).getAttribute("data-mode")`,
          ),
        ).toBe("idle");

        // ── 2. A press goes live, and names its session. ───────────────────
        await app.nativeClickAtElement(MIC);
        // The host's no-audio `ready` is what moves this to `live` ([P01]); a
        // `starting` that never advanced would mean the press did not reach the
        // host at all.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MIC)}).getAttribute("data-mode") === "live"`,
          { timeoutMs: 10_000 },
        );
        const sessionId = await app.getElementAttribute(MIC, "data-dictation-id");
        note("dictation session id", String(sessionId));
        expect(typeof sessionId).toBe("string");
        expect((sessionId ?? "").length).toBeGreaterThan(0);
        // The toggle state, for anybody who cannot see that the glyph became a
        // wave.
        expect(await app.getElementAttribute(MIC, "aria-pressed")).toBe("true");

        // ── 3. Provisional, then settled. ─────────────────────────────────
        await push(app, { id: sessionId, kind: "volatile", text: "hello wor" });
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)}).textContent || "") === "hello wor"`,
          { timeoutMs: 10_000 },
        );
        // The mark is the whole of "the machine has not committed to this yet".
        expect(await app.evalJS<boolean>(exists(VOLATILE))).toBe(true);
        expect(
          await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(VOLATILE)}).textContent || "")`,
          ),
        ).toBe("hello wor");

        await push(app, { id: sessionId, kind: "final", text: "hello world" });
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)}).textContent || "") === "hello world"`,
          { timeoutMs: 10_000 },
        );
        // Settled text is ordinary draft content from here on, so nothing is
        // marked. A mark surviving a `final` would tell the user their own words
        // are still provisional.
        expect(await app.evalJS<boolean>(exists(VOLATILE))).toBe(false);

        // ── 4. Closing keeps every word. ──────────────────────────────────
        await push(app, { id: sessionId, kind: "volatile", text: " again" });
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)}).textContent || "") === "hello world again"`,
          { timeoutMs: 10_000 },
        );
        await app.nativeClickAtElement(MIC);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MIC)}).getAttribute("data-mode") === "idle"`,
          { timeoutMs: 10_000 },
        );
        const afterClose = await docText(app);
        note("after closing", afterClose);
        // " again" stays: the tap asked the host to finish rather than to stop,
        // and a finish keeps the recogniser's reading of what it already heard.
        // Escape is the one gesture that would have dropped it.
        expect(afterClose).toBe("hello world again");
        expect(await app.evalJS<boolean>(exists(VOLATILE))).toBe(false);
        // And nothing was sent. This is the claim that makes the feature safe
        // to use mid-thought ([B03]).
        expect(await app.evalJS<boolean>(exists(USER_TURN))).toBe(false);

        // ── 5. [P08] in the app: the next session opens on its own line. ───
        // The draft is non-empty and the caret is at its end (the settle left it
        // there), so the append rule applies and the padding is what keeps the
        // new sentence off the end of the old one.
        await app.nativeClickAtElement(MIC);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MIC)}).getAttribute("data-mode") === "live"`,
          { timeoutMs: 10_000 },
        );
        const secondId = await app.getElementAttribute(MIC, "data-dictation-id");
        // A fresh id per start, which is what makes the previous session's late
        // events land nowhere.
        expect(secondId).not.toBe(sessionId);

        await push(app, { id: secondId, kind: "volatile", text: "and again" });
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)}).textContent || "").indexOf("and again") !== -1`,
          { timeoutMs: 10_000 },
        );
        // CodeMirror draws each line as its own element, so the padding reads as
        // a second line rather than as a newline in the text content.
        const lines = await app.evalJS<number>(
          `document.querySelectorAll(${JSON.stringify(`${EDITOR} .cm-line`)}).length`,
        );
        const secondLine = await app.evalJS<string>(
          `(function(){
             var lines = document.querySelectorAll(${JSON.stringify(`${EDITOR} .cm-line`)});
             return lines.length < 2 ? "" : (lines[1].textContent || "");
           })()`,
        );
        note("lines after the second start", `${lines} / second: ${secondLine}`);
        expect(lines).toBe(2);
        expect(secondLine).toBe("and again");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
