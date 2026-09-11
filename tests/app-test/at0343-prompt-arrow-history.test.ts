/**
 * at0343-prompt-arrow-history.test.ts — the composer's two arrow
 * ergonomics: a plain arrow can neither overshoot into a history recall nor
 * overshoot out of the editor.
 *
 * Two overshoots used to live on the same key. Walking the caret up through a
 * draft handed off to the history provider the moment it reached line one, so
 * the press meant to reach the top replaced the draft instead. This pins the
 * split end to end on the real Session card:
 *
 *  - in KBF mode OFF a plain arrow NEVER leaves the composer — empty or not,
 *    at the document edge or not, held or discrete. The boundary latch this
 *    file used to pin (two discrete presses at an edge to cross out) and the
 *    empty-field release beside it were both compensation for a missing mode,
 *    and both are gone: content is not a factor in who owns an arrow;
 *  - Cmd-Up away from the start is still `cursorDocStart` and leaves the draft
 *    alone; at the start it recalls the previous entry.
 *
 * Keystrokes are synthetic `keydown`s on the focused element: they travel the
 * identical document-capture pipeline a hardware key does, and CM6's own
 * handlers run on them, which is exactly the seam under test (the pipeline runs
 * before CM6, so which of the two takes a press is the behavior being pinned).
 *
 * @covers tugdeck/src/components/tugways/tug-text-editor/keymap.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/responder-chain-provider.tsx
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const ENTRY = `${CARD} .tug-prompt-entry`;
const EDITOR_HOST = `${ENTRY} .tug-text-editor`;
const EDITOR_CONTENT = `${EDITOR_HOST} .cm-content`;
const INPUT_AREA = `${ENTRY} .tug-prompt-entry-input-area`;
const SUBMITTED = "at0343-history-entry";

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

/** Dispatch a real keydown on the focused element; it travels the document
 *  capture pipeline and CM6's handlers exactly as a hardware key would. */
function pressKey(
  app: App,
  key: string,
  opts: { meta?: boolean; shift?: boolean; repeat?: boolean } = {},
): Promise<null> {
  return app.evalJS<null>(
    `(function(){
      var el = document.activeElement || document.body;
      el.dispatchEvent(new KeyboardEvent("keydown", {
        key: ${JSON.stringify(key)},
        metaKey: ${opts.meta === true},
        shiftKey: ${opts.shift === true},
        repeat: ${opts.repeat === true},
        bubbles: true,
        cancelable: true,
      }));
      return null;
    })()`,
  );
}

const CARET_IN_EDITOR = `(function(){
  var el = document.activeElement;
  return el !== null && el.matches(${JSON.stringify(EDITOR_CONTENT)});
})()`;

/** The composer's document, read off CM6's rendered lines. */
function docText(app: App): Promise<string> {
  return app.evalJS<string>(
    `Array.from(document.querySelectorAll(${JSON.stringify(`${EDITOR_CONTENT} .cm-line`)}))
      .map(function(l){ return l.textContent || ""; })
      .join("\\n")`,
  );
}

/**
 * A short address for whichever stop wears the keyboard ring: its authored
 * focus key when it has one, else its class list. (Not every cycle stop
 * carries a focus-key attribute — the beat strip's legend, for one — so the
 * class is the reliable identity here.)
 */
function ringAddress(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function(){
      var el = document.querySelector('[data-key-view-kbd]');
      if (el === null) return null;
      return el.getAttribute("data-tug-focus-key") || el.className;
    })()`,
  );
}

async function seedCardWithCaret(
  testName: string,
  bind: { tugSessionId: string; projectDir: string } | undefined = undefined,
): Promise<App> {
  const app = await launchTugApp({ testName });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", bind);
  await app.awaitEngineReady("A", { timeoutMs: 15_000 });
  await app.nativeClickAtElement(EDITOR_CONTENT);
  await app.waitForCondition<boolean>(CARET_IN_EDITOR, { timeoutMs: 8000 });
  return app;
}

describe.skipIf(!SHOULD_RUN)("at0343 — the composer's plain arrows and Cmd-history", () => {
  test(
    "in mode OFF a plain arrow never leaves the composer, empty or not, held or not",
    async () => {
      const app = await seedCardWithCaret("at0343-prompt-arrow-mode-off");
      try {
        // An EMPTY composer keeps its arrows. This is the case the old rule
        // inverted: emptiness used to make the field transparent to all four
        // directions, which is one of the three ambient mechanisms KBF mode
        // deleted. Content is not a factor in who owns an arrow.
        for (let i = 0; i < 3; i += 1) {
          await pressKey(app, "ArrowUp");
        }
        expect(
          await app.evalJS<boolean>(CARET_IN_EDITOR),
          "an empty composer keeps the caret through repeated Up",
        ).toBe(true);

        // …and so does a composer with a document, at the document edge, held.
        await app.nativeType("alpha");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR_CONTENT)}).textContent.indexOf("alpha") !== -1`,
          { timeoutMs: 5000 },
        );
        await pressKey(app, "ArrowUp");
        for (let i = 0; i < 4; i += 1) {
          await pressKey(app, "ArrowUp", { repeat: true });
        }
        await pressKey(app, "ArrowUp");
        await pressKey(app, "ArrowUp");
        expect(
          await app.evalJS<boolean>(CARET_IN_EDITOR),
          "no number of Ups at the document start crosses out of the editor",
        ).toBe(true);

        // No ring painted anywhere on the deck: mode OFF, so there is nothing
        // for an arrow to move even if one had escaped.
        expect(
          await app.evalJS<boolean>(
            `document.documentElement.hasAttribute("data-kbf")`,
          ),
          "plain arrows never engage the mode",
        ).toBe(false);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll("[data-key-view-kbd]").length`,
          ),
          "no ring is painted in mode OFF",
        ).toBe(0);

        // The draft is untouched: every arrow spent itself on the caret.
        expect(await docText(app)).toBe("alpha");

        // And nothing wrote focus behind the engine's back.
        const report = await app.evalJS<{
          violations: number;
          steals: Record<string, number>;
        } | null>(`window.__tug.getFocusInvariantReport()`);
        expect(report).not.toBeNull();
        expect(report!.violations).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Cmd-Up keeps cursorDocStart away from the edge and recalls history at it",
    async () => {
      const app = await seedCardWithCaret("at0343-prompt-cmd-history");
      try {
        // Submit once so the route's history has an entry to recall. Return
        // inserts a newline in this composer; Shift-Return submits.
        await app.nativeType(SUBMITTED);
        await pressKey(app, "Enter", { shift: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR_CONTENT)}).textContent.indexOf(${JSON.stringify(SUBMITTED)}) === -1`,
          { timeoutMs: 10_000 },
        );

        // A fresh draft, caret resting at its end — away from the start.
        await app.nativeClickAtElement(EDITOR_CONTENT);
        await app.waitForCondition<boolean>(CARET_IN_EDITOR, { timeoutMs: 5000 });
        await app.nativeType("draft line");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR_CONTENT)}).textContent === "draft line"`,
          { timeoutMs: 5000 },
        );

        // Cmd-Up away from the start keeps its editing function: it jumps the
        // caret to the document start and leaves the draft alone.
        await pressKey(app, "ArrowUp", { meta: true });
        await new Promise<void>((r) => setTimeout(r, 300));
        expect(await docText(app)).toBe("draft line");

        // At the start that function is already a no-op, so Cmd-Up now recalls.
        await pressKey(app, "ArrowUp", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR_CONTENT)}).textContent.indexOf("at0343-history") !== -1`,
          { timeoutMs: 5000 },
        );

        // A plain Up at the start never recalls: it arms, and the text stays.
        const recalled = await docText(app);
        await pressKey(app, "ArrowUp");
        await new Promise<void>((r) => setTimeout(r, 300));
        expect(await docText(app)).toBe(recalled);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
