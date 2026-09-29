/**
 * AT0648: ⌘D, leaving the composer, and the finish that keeps the words.
 *
 * `at0646` proves dictation lands in a composer and `at0647` proves only one
 * composer holds the mic. This file proves the third thing, which is the one the
 * user asked for: that an **ordinary** end keeps what was said. ⌘D means *I am
 * done talking*, not *throw away the sentence I was in the middle of* — and the
 * same is true of the Z5 tap and of walking away from the field. Escape is left
 * as the one gesture that discards.
 *
 * Why this needs an app-test rather than a store test. The end shapes are unit
 * tested, but nothing below the app can say that the chord reaches the composer
 * that holds the caret and no other, that a keystroke with no caret anywhere
 * lands on nobody, that a real focus change out of the entry shell is seen at
 * all, or that a `final` arriving in the window between asking the host to
 * finish and its `ended` still reaches the document. Each of those is a seam
 * between a keymap, a responder chain, the DOM's focus model and the host
 * bridge, and a seam is what an app-test is for.
 *
 * Five claims:
 *
 * 1. **⌘D toggles the mic of the composer holding the caret.** Press once and
 *    the mic goes live; press again and it ends — with the words kept, which is
 *    the whole of [B03]. The chord is routed `first-responder`, so it is the
 *    caret that decides which composer answers.
 * 2. **⌘D with no caret in any composer does nothing.** With the first responder
 *    on the deck canvas the chord reaches no composer, and a mic that went live
 *    from nowhere would be a microphone opened by a keystroke the user aimed
 *    somewhere else.
 * 3. **Escape still truncates** ([B05]). It is the one cancel, and it is what
 *    gives the user a way to take back a misheard phrase — so the unsettled tail
 *    goes and the settled text stays.
 * 4. **Focus leaving the entry shell ends the session, keeping the words**
 *    ([B02]). A click into another card's field is a real focus change, and the
 *    release it triggers is finish-shaped like the chord's.
 * 5. **A `final` that arrives during `finishing` still lands.** That window is
 *    the entire point of the `finish` verb: the recogniser's settled reading
 *    comes back *after* the user said they were done, and a deck that had
 *    already closed the span would drop exactly the words it asked for.
 *
 * No microphone is engaged: the host answers under the no-audio harness branch
 * ([P01]) and every transcript below is scripted through
 * `window.__tugBridge.onDictation`.
 *
 * **Why `tug-prompt-entry.tsx` is not named below.** Both of this file's claims
 * about that composer rest on `useDictationFocusRelease` and on the chord's one
 * handler, and the hook — where the whole of the focus-out rule lives — is in
 * `dictation-store.ts`, which is named. The composer keeps two call sites and
 * nothing else, and an edit to them already selects `at0646` and `at0647`, both
 * of which drive dictation through this same composer. Naming it here would
 * push its fan-out past the selection budget for two lines of wiring.
 *
 * @covers tugdeck/src/lib/dictation-store.ts
 * @covers tugdeck/src/lib/dictation-bridge.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/components/tugways/action-vocabulary.ts
 * @covers tugdeck/src/components/tugways/tug-dictation-button.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/dictation-span.ts
 * @covers tugapp/Sources/DictationEngine.swift
 * @covers tugapp/Sources/SpeechAnalyzerRecognizer.swift
 * @covers tugapp/Sources/LegacySpeechRecognizer.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CARD = '[data-card-id="A"]';
const MIC = `${CARD} [data-testid="tug-dictation-button"]`;
const SUBMIT = `${CARD} .tug-prompt-entry-submit-button`;
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const VOLATILE = `${EDITOR} .tug-dictation-volatile`;
/** Any user turn the transcript has drawn. Dictation must never mint one. */
const USER_TURN = `${CARD} [data-testid="session-card-transcript-user-body"]`;
/** The other card's field — a real focus target outside the composer's shell. */
const OTHER_FIELD = '[data-card-id="B"] input';

/**
 * Two panes, so claim 4 has somewhere to click that is genuinely another card.
 *
 * `gallery-input` is card B because the claim needs a focusable element and
 * nothing else about that card: a second session card would drag a picker and a
 * transcript in for no reason.
 */
function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 500, height: 520 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 580, y: 40 },
        size: { width: 420, height: 320 },
        cardIds: ["B"],
        activeCardId: "B",
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

const exists = (selector: string): string =>
  `document.querySelector(${JSON.stringify(selector)}) !== null`;

const modeIs = (selector: string, mode: string): string =>
  `document.querySelector(${JSON.stringify(selector)})?.getAttribute("data-mode") === ${JSON.stringify(mode)}`;

const textOf = (selector: string): string =>
  `(document.querySelector(${JSON.stringify(selector)})?.textContent || "")`;

/**
 * Whether a composer's document holds `text`.
 *
 * Containment rather than equality because CodeMirror renders its placeholder
 * inside `.cm-content`, so an empty composer's text content is the hint.
 */
const holds = (selector: string, text: string): string =>
  `${textOf(selector)}.indexOf(${JSON.stringify(text)}) !== -1`;

/** Put the caret in the Session composer and wait until the DOM agrees. */
async function focusComposer(app: App): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.waitForCondition<boolean>(
    `(function(){
       var field = document.querySelector(${JSON.stringify(EDITOR)});
       return field !== null && document.activeElement !== null &&
         (field === document.activeElement || field.contains(document.activeElement));
     })()`,
    { timeoutMs: 10_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0648: ⌘D, focus-out, and the finish", () => {
  test(
    "⌘D toggles the focused composer's mic and keeps the words, does nothing with no caret, Escape still truncates, focus leaving the shell ends it, and a final during finishing lands",
    async () => {
      const app = await launchTugApp({ testName: "at0648-dictation-finish" });
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
        await app.waitForCondition<boolean>(exists(MIC), { timeoutMs: 8000 });
        await app.waitForCondition<boolean>(exists(OTHER_FIELD), { timeoutMs: 8000 });

        // ── 1. ⌘D starts from the caret, and ⌘D again keeps the words. ────
        await focusComposer(app);
        await app.nativeKey("d", ["cmd"]);
        await app.waitForCondition<boolean>(modeIs(MIC, "live"), { timeoutMs: 10_000 });
        const firstId = await app.getElementAttribute(MIC, "data-dictation-id");
        expect((firstId ?? "").length).toBeGreaterThan(0);

        // Nothing settled: every word below is still the recogniser's guess, so
        // an end that truncated would leave an empty draft.
        await push(app, { id: firstId, kind: "volatile", text: "one small step" });
        await app.waitForCondition<boolean>(
          `${textOf(EDITOR)} === "one small step"`,
          { timeoutMs: 10_000 },
        );
        await app.nativeKey("d", ["cmd"]);
        await app.waitForCondition<boolean>(modeIs(MIC, "idle"), { timeoutMs: 10_000 });
        const afterChord = await app.evalJS<string>(textOf(EDITOR));
        note("after the closing chord", afterChord);
        // The claim the feature exists for: the sentence the user was in the
        // middle of survives the gesture that means "I am done talking".
        expect(afterChord).toBe("one small step");
        // The mark goes with the session — what is left is ordinary draft text.
        expect(await app.evalJS<boolean>(exists(VOLATILE))).toBe(false);
        // And nothing was sent. A chord that submitted would be a different
        // feature wearing this one's key.
        expect(await app.evalJS<boolean>(exists(USER_TURN))).toBe(false);

        // ── 2. ⌘D with the caret nowhere does nothing. ────────────────────
        await app.evalJS<null>(`(window.__tug.setFirstResponder("deck-canvas"), null)`);
        await app.nativeKey("d", ["cmd"]);
        // Native events are delivered in order, so a later native gesture that
        // we *can* await is what proves the chord above was fully processed —
        // there is no frame to wait on here, and a mic that opened would have
        // opened by now.
        await focusComposer(app);
        expect(await app.evalJS<boolean>(modeIs(MIC, "idle"))).toBe(true);

        // ── 3. Escape is still the one cancel ([B05]). ────────────────────
        await app.nativeKey("d", ["cmd"]);
        await app.waitForCondition<boolean>(modeIs(MIC, "live"), { timeoutMs: 10_000 });
        const secondId = await app.getElementAttribute(MIC, "data-dictation-id");
        await push(app, { id: secondId, kind: "volatile", text: " scratch that" });
        await app.waitForCondition<boolean>(holds(EDITOR, "scratch that"), {
          timeoutMs: 10_000,
        });
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(modeIs(MIC, "idle"), { timeoutMs: 10_000 });
        // The misheard phrase goes; the draft the user already had stays. That
        // asymmetry is the whole reason Escape is kept as a truncation.
        expect(await app.evalJS<boolean>(holds(EDITOR, "scratch that"))).toBe(false);
        expect(await app.evalJS<boolean>(holds(EDITOR, "one small step"))).toBe(true);

        // ── 4. Focus leaving the entry shell ends it, keeping the words. ──
        await app.nativeKey("d", ["cmd"]);
        await app.waitForCondition<boolean>(modeIs(MIC, "live"), { timeoutMs: 10_000 });
        const thirdId = await app.getElementAttribute(MIC, "data-dictation-id");
        await push(app, { id: thirdId, kind: "volatile", text: " and a giant leap" });
        await app.waitForCondition<boolean>(holds(EDITOR, "giant leap"), {
          timeoutMs: 10_000,
        });
        // A real focus change into another card's field — the `focusout` whose
        // `relatedTarget` is outside the entry shell root ([B02]). The mic is
        // itself inside that shell, which is why the listener is not on the
        // editor ([F05]).
        await app.nativeClickAtElement(OTHER_FIELD);
        await app.waitForCondition<boolean>(modeIs(MIC, "idle"), { timeoutMs: 10_000 });
        const afterBlur = await app.evalJS<string>(textOf(EDITOR));
        note("after focus left the composer", afterBlur);
        // Walking away is an ordinary end, so it keeps the words the same way
        // the chord does — this is the note the user wrote the arc for.
        expect(afterBlur.indexOf("and a giant leap")).not.toBe(-1);
        expect(await app.evalJS<boolean>(exists(USER_TURN))).toBe(false);

        // ── 5. A `final` during `finishing` still lands. ──────────────────
        await focusComposer(app);
        await app.nativeKey("d", ["cmd"]);
        await app.waitForCondition<boolean>(modeIs(MIC, "live"), { timeoutMs: 10_000 });
        const fourthId = await app.getElementAttribute(MIC, "data-dictation-id");
        await push(app, { id: fourthId, kind: "volatile", text: " for mankine" });
        await app.waitForCondition<boolean>(holds(EDITOR, "for mankine"), {
          timeoutMs: 10_000,
        });

        // One script, so the `final` is pushed inside the same task that asked
        // the host to finish: that is the window under test, and waiting for a
        // round trip to observe it would be waiting for the thing that closes
        // it. React dispatches a discrete click synchronously, so the store has
        // already entered `finishing` by the second statement — the *paint* has
        // not, which is why the mode read back here is a diagnostic rather than
        // an assertion: `useSyncExternalStore` has not re-rendered the button
        // yet and still reads `live`. What proves the window was open is the
        // text: a deck that had closed the span on the click would have nowhere
        // to put the correction, and the misheard guess would survive.
        const phaseAtPush = await app.evalJS<string>(
          `(function(){
             var mic = document.querySelector(${JSON.stringify(MIC)});
             if (mic === null) return "no-mic";
             mic.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
             var phase = mic.getAttribute("data-mode") || "";
             window.__tugBridge.onDictation({
               id: ${JSON.stringify(fourthId)},
               kind: "final",
               text: " for mankind",
             });
             return phase;
           })()`,
        );
        note("mic mode when the final was pushed", phaseAtPush);
        // Not yet released, which is the part the attribute can say: an `idle`
        // here would mean the claim was gone before the final was pushed, and
        // the assertions below would be passing for the wrong reason.
        expect(phaseAtPush).not.toBe("idle");

        await app.waitForCondition<boolean>(modeIs(MIC, "idle"), { timeoutMs: 10_000 });
        const afterFinish = await app.evalJS<string>(textOf(EDITOR));
        note("after the finish settled", afterFinish);
        // The recogniser's correction arrived after the user said they were
        // done, which is exactly when a recogniser finalizes — and it is in the
        // draft rather than the guess it replaced.
        expect(afterFinish.indexOf("for mankind")).not.toBe(-1);
        expect(afterFinish.indexOf("for mankine")).toBe(-1);
        expect(await app.evalJS<boolean>(exists(VOLATILE))).toBe(false);
        expect(await app.evalJS<boolean>(exists(USER_TURN))).toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
