/**
 * at0474-paste-command-chip.test.ts — a pasted slash command chips at paste
 * time, including when the paste came from Tug itself.
 *
 * Pasting `/commit …` into an empty composer replaces the `/command` run with
 * a command chip and keeps the rest as its argument — the paste-time mirror of
 * accepting a typed `/command `. That has two routes into the editor and they
 * had drifted:
 *
 *   A. **A Tug copy, off the native pasteboard.** A Tug copy is written to the
 *      private `dev.tugapp.prompt-atoms` type, so a DOM `paste` event's
 *      `clipboardData` cannot see it and the handler asks the bridge instead.
 *      A copy carrying no atoms at all still writes a sidecar once it has a
 *      project root to record — which is the regression this file exists for:
 *      the sidecar branch inserted its text verbatim and the leading command
 *      never reached the resolver, so prose copied from one Tug surface into
 *      the composer stopped chipping while the same text from any other app
 *      still did.
 *
 *   B. **A sidecar in the event itself.** The browser-mode branch, reachable
 *      in-app with a JS-built `DataTransfer`. Same insert, same chip.
 *
 * `/commit` is a LOCAL command ([D23]), so the catalog behind the resolver is
 * the app's own registry rather than anything claude has to have reported —
 * what the paste resolves against is present from the drop.
 *
 * Foreground: the native pasteboard write and read want a key window.
 *
 * @foreground
 *
 * @covers tugdeck/src/components/tugways/tug-text-editor/clipboard-filters.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/components/tugways/cards/use-session-card-services.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SESSION_ID = "b7c41d02-9e5a-4f18-a3d6-51c8e0b47f92";
const PROJECT_DIR = "/Users/tester/src/tugtool";

const COMPOSER = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';

/** The pasted run: a local slash command followed by ordinary argument text. */
const ARGUMENT = "Formalize the arc paperwork formats.";
const PASTED = `/commit ${ARGUMENT}`;

/** What a Tug copy of that prose puts on the pasteboard: text + provenance. */
const SIDECAR = JSON.stringify({
  version: 1,
  text: PASTED,
  atoms: [],
  origins: [PROJECT_DIR],
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 760, height: 520 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** The composer's chips and its flat text, in one read. */
function composerProbe(): string {
  return `(function(){
    var cm = document.querySelector(${JSON.stringify(COMPOSER)});
    return {
      atoms: Array.prototype.map.call(
        cm.querySelectorAll('img:not(.cm-widgetBuffer)'),
        function (img) { return img.getAttribute("data-atom-type") || ""; }),
      text: Array.prototype.map.call(cm.querySelectorAll('.cm-line'),
        function (l) { return l.textContent || ""; }).join(""),
    };
  })()`;
}

describe.skipIf(!SHOULD_RUN)("at0474 — a pasted slash command chips", () => {
  test(
    "both the native-pasteboard route and the in-event sidecar chip the command",
    async () => {
      const app = await launchTugApp({
        testName: "at0474-paste-command-chip",
        foreground: true,
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.bindSession("A", {
          tugSessionId: SESSION_ID,
          projectDir: PROJECT_DIR,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.focusElement(COMPOSER);

        // ---- A. The native pasteboard, with an atomless sidecar. ----------
        //
        // Written through the same bridge handler a Tug copy posts to, so what
        // lands on NSPasteboard is byte-for-byte what a real copy leaves: the
        // flat text, plus a sidecar whose only cargo is the project root.
        await app.evalJS<null>(`(function(){
          window.webkit.messageHandlers.clipboardWrite.postMessage({
            text: ${JSON.stringify(PASTED)},
            atoms: ${JSON.stringify(SIDECAR)},
            html: "",
          });
          return null;
        })()`);

        // An EMPTY clipboardData is the shape of the real gesture: everything
        // the paste needs is on the pasteboard and none of it is in the event.
        await app.evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(COMPOSER)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
          }));
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(COMPOSER)} + ' img:not(.cm-widgetBuffer)').length === 1`,
          { timeoutMs: 8_000 },
        );

        const native = await app.evalJS<{ atoms: string[]; text: string }>(
          composerProbe(),
        );
        note("at0474 native-route paste", JSON.stringify(native));
        expect(native.atoms).toEqual(["command"]);
        // The command is the chip, not text beside it…
        expect(native.text).not.toContain("/commit");
        // …and the rest of the paste survived as its argument.
        expect(native.text).toContain(ARGUMENT);

        // ---- B. A sidecar carried by the event itself. --------------------
        //
        // Same insert through the browser-mode branch. Clear the composer
        // first so the paste lands at offset 0 again — the chip is offered
        // only for a command that would occupy the document's first position.
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("Delete");
        await app.waitForCondition<boolean>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(COMPOSER)});
            return cm.querySelectorAll('img:not(.cm-widgetBuffer)').length === 0
              && (cm.textContent || "").indexOf(${JSON.stringify(ARGUMENT)}) === -1;
          })()`,
          { timeoutMs: 8_000 },
        );

        await app.evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(COMPOSER)});
          var dt = new DataTransfer();
          dt.setData("text/plain", ${JSON.stringify(PASTED)});
          dt.setData("application/x-tug-atoms", ${JSON.stringify(SIDECAR)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: dt,
          }));
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(COMPOSER)} + ' img:not(.cm-widgetBuffer)').length === 1`,
          { timeoutMs: 8_000 },
        );

        const inEvent = await app.evalJS<{ atoms: string[]; text: string }>(
          composerProbe(),
        );
        note("at0474 in-event paste", JSON.stringify(inEvent));
        expect(inEvent.atoms).toEqual(["command"]);
        expect(inEvent.text).not.toContain("/commit");
        expect(inEvent.text).toContain(ARGUMENT);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
