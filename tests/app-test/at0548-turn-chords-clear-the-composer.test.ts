/**
 * at0548-turn-chords-clear-the-composer.test.ts — ⌃⌘[ / ⌃⌘] are safe to press
 * with the caret in a prompt, and that is the whole reason the turn family
 * lives on those chords.
 *
 * ## What this gates
 *
 * The transcript's turn family moved from the ⌥⌘ arrows to the bracket band
 * ([D184]) so the arrows could carry directional card focus. The band it moved
 * to is ⌃⌘ rather than plain ⌘, and that choice is load-bearing rather than
 * aesthetic: CodeMirror's `defaultKeymap` binds `Mod-[` / `Mod-]` to
 * `indentLess` / `indentMore`, and Tug installs that keymap in the composer.
 * So plain ⌘] pressed in a prompt indents the prompt — which would make the
 * verb destructive on the one surface a reader steps turns from, because they
 * step back through a transcript with the caret still in the composer.
 *
 * A test that only pressed ⌃⌘] and found the text unchanged would pass just as
 * well if the chord did nothing anywhere. So this presses BOTH and asserts the
 * difference: the composition is clear of the editor, and the bare ⌘ it was
 * chosen over is not. If ⌃⌘] ever starts indenting — a keymap change, a
 * `defaultKeymap` binding widened to the composition — this is the file that
 * says so, and it says it in the terms the decision was made in.
 *
 * That the chords actually STEP a transcript is held elsewhere and deliberately
 * not repeated: at0369 drives ⌃⌘[ / ⌃⌘] natively with the caret in a CM6 field
 * and reads where the column lands, and at0330 / at0333 drive them at the web
 * funnel over a real transcript. What none of the three reads is the editor's
 * own text, which is this file's whole subject.
 *
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/components/tugways/keymap-registry.ts
 * @covers tugdeck/src/components/tugways/keybinding-map.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const COMPOSER = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
/** The line the prompt is typed onto, whose leading whitespace is the subject. */
const TYPED = "step back a turn";

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 860, height: 640 },
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

describe.skipIf(!SHOULD_RUN)(
  "at0548 — the turn family's chords do not reach the composer's editor",
  () => {
    test(
      "⌃⌘] leaves the prompt alone where plain ⌘] indents it",
      async () => {
        const app = await launchTugApp({ testName: "at0548-composer-clearance" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
            { timeoutMs: 8_000 },
          );

          // The caret goes in the prompt — the posture the whole decision is
          // about — and every press below is native, so AppKit gets its say
          // about the key equivalent before CodeMirror does.
          await app.nativeClickAtElement(COMPOSER);
          await app.waitForCondition<boolean>(
            `document.activeElement !== null
              && document.activeElement.closest(${JSON.stringify(COMPOSER)}) !== null`,
            { timeoutMs: 8_000 },
          );
          await app.nativeType(TYPED);
          await app.waitForCondition<boolean>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(COMPOSER)});
              return el !== null && el.textContent.indexOf(${JSON.stringify(TYPED)}) !== -1;
            })()`,
            { timeoutMs: 8_000 },
          );

          const read = (): Promise<string> =>
            app.evalJS<string>(
              `document.querySelector(${JSON.stringify(COMPOSER)}).textContent`,
            );
          const typed = await read();
          note("as typed", JSON.stringify(typed));

          // ── The family's own chords, all four of them, with the caret sitting
          // in the text. Each is a transcript verb and none is an editing one.
          for (const [key, mods] of [
            ["[", ["cmd", "ctrl"]],
            ["]", ["cmd", "ctrl"]],
            ["[", ["cmd", "ctrl", "shift"]],
            ["]", ["cmd", "ctrl", "shift"]],
          ] as const) {
            await app.nativeKey(key, mods);
            await wait(250);
          }
          const afterTurnChords = await read();
          note("after the four turn chords", JSON.stringify(afterTurnChords));
          expect(
            afterTurnChords,
            "the turn family passes over the editor without touching it",
          ).toBe(typed);

          // ── And the chord it was chosen over. `defaultKeymap`'s `Mod-]` is
          // `indentMore`, so this one really does rewrite the prompt — which is
          // the fact that made plain ⌘[/] unavailable to the turn family.
          await app.nativeKey("]", ["cmd"]);
          await wait(400);
          const afterPlainBracket = await read();
          note("after plain ⌘]", JSON.stringify(afterPlainBracket));
          expect(
            afterPlainBracket,
            "plain ⌘] is the editor's own indent, which is why the family is not on it",
          ).not.toBe(typed);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
