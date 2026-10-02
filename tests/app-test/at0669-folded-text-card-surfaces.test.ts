/**
 * at0669-folded-text-card-surfaces.test.ts — what a folded Text card does with
 * the surfaces it is asked for, and with the one nobody asked for.
 *
 * ## What this gates
 *
 * A folded card's body is `inert` under the pane's clip, so nothing can be
 * presented over it. The folded-card rule splits surfaces by who called them:
 *
 *   1. **A bidden surface opens the card first.** Find — through the menu's
 *      route and through ⌘F — unfolds a folded Text card and then appears
 *      exactly where it does on an open card, with the caret in its field. The
 *      chord matters on its own: while folded the keyboard rests on the title
 *      bar's fold glyph, so ⌘F reaches the card only because the card's first
 *      responder is held inside it across the fold. Return on that glyph is
 *      the other way back, and it hands the caret to the editor.
 *   2. **An unbidden one waits, and the masthead says it meanwhile.** A disk
 *      conflict raised while the card is folded reads "File changed" on the
 *      document masthead's save-state line and raises no banner; the banner
 *      presents on the unfold. Automatic save mode is the case that proves
 *      it, because there the masthead says nothing about a conflict on an
 *      open card — the banner does.
 *
 * Folds are driven by `toggle-card-fold`, the wire View ▸ Fold Card and ⌃⌘Y
 * send. Keys are synthetic, dispatched where the keyboard is, as at0223 does.
 *
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/lib/card-fold.ts
 * @covers tugdeck/src/lib/folded-body.ts
 * @covers tugdeck/src/lib/text-card-save-text.ts
 * @covers tugdeck/src/components/chrome/card-fold-glyph.tsx
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const BODY =
  Array.from({ length: 40 }, (_, i) => `fixture line ${String(i + 1).padStart(2, "0")}`).join("\n") +
  "\n";

const HOST = '[data-card-host][data-card-id="A"]';
const EDITOR = '[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-content';
const BAR = '[data-card-id="A"] [data-slot="text-card-find-bar"]';
const DETAIL = '[data-testid="card-masthead-detail"]';
const RELOAD = '[data-testid="text-card-conflict-reload"]';

function mkFixture(prefix: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, BODY, "utf8");
  return { dir, file };
}

/** One Text card on the fixture, in automatic save mode. */
async function seed(app: App, file: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.text-card","save-mode",{kind:"string",value:"automatic"}), null)`,
  );
  await app.seedDeckState({
    state: {
      cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
      panes: [
        {
          id: "p1",
          position: { x: 40, y: 40 },
          size: { width: 760, height: 560 },
          cardIds: ["A"],
          activeCardId: "A",
          title: "",
          acceptsFamilies: ["standard"],
        },
      ],
      activePaneId: "p1",
      hasFocus: true,
    },
    cardStates: { A: { content: { path: file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `(function(){var el=document.querySelector('${EDITOR}'); return el!==null && el.innerText.indexOf("fixture line 01")!==-1;})()`,
    { timeoutMs: 15_000 },
  );
}

function toggleFold(app: App): Promise<unknown> {
  return app.evalJS(`(window.__tug.dispatchControlAction("toggle-card-fold"), null)`);
}

/** Fold, and wait for the folded form to land on the card host. */
async function fold(app: App): Promise<void> {
  await toggleFold(app);
  await app.waitForCondition<boolean>(
    `document.querySelector('${HOST}').getAttribute("data-card-fold")==="settled"`,
    { timeoutMs: 6000 },
  );
}

/**
 * Wait for an unfold to land and for its settle to finish.
 *
 * The pause is not about this file's claims. A fold that arrives after the
 * unfold's crossing has ended but before its settle has released retargets
 * that settle, and the retargeted fold's crossing is never ended — the frame
 * keeps `data-fold-crossing` and the card never lands folded. That is a defect
 * of the deck's settle, not of the fold, and a person re-folding a card that
 * fast is the case it describes; waiting out the settle keeps it out of a test
 * about surfaces.
 */
async function unfolded(app: App): Promise<void> {
  await app.waitForCondition<boolean>(`window.__tug.getPaneRecord("p1").folded===false`, {
    timeoutMs: 6000,
  });
  await app.waitForCondition<boolean>(
    `!document.querySelector(".tug-pane").hasAttribute("data-fold-crossing")`,
    { timeoutMs: 6000 },
  );
  await new Promise((r) => setTimeout(r, 2000));
}

/** Press a key where the keyboard is. */
function press(app: App, code: string, key: string, meta: boolean): Promise<unknown> {
  const init = `{code:${JSON.stringify(code)},key:${JSON.stringify(key)},metaKey:${meta},bubbles:true,cancelable:true,composed:true}`;
  return app.evalJS(
    `(function(){var t=document.activeElement||document; t.dispatchEvent(new KeyboardEvent("keydown",${init})); t.dispatchEvent(new KeyboardEvent("keyup",${init})); return null;})()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0669: a folded Text card's surfaces", () => {
  test(
    "Return, the Find menu and ⌘F each open a folded card, and the keyboard lands where it was sent",
    async () => {
      const { dir, file } = mkFixture("at0669-find");
      const app = await launchTugApp({ testName: "at0669-find" });
      try {
        await seed(app, file);
        await app.nativeClickAtElement('[data-card-id="A"] .cm-line');

        // Return on the folded card's glyph opens it into the editor.
        await fold(app);
        await press(app, "Enter", "Enter", false);
        await unfolded(app);
        await app.waitForCondition<boolean>(
          `(function(){var c=document.querySelector('${EDITOR}'); return c!==null && c.contains(document.activeElement);})()`,
          { timeoutMs: 6000 },
        );

        // Edit ▸ Find — the menu's route — opens it and raises the bar.
        await fold(app);
        await app.evalJS(`(window.__tug.dispatchControlAction("find"), null)`);
        await unfolded(app);
        await app.waitForCondition<boolean>(`document.querySelector('${BAR}')!==null`, {
          timeoutMs: 6000,
        });

        // ⌘F, with the bar left open across a second fold: the card opens,
        // the bar is back in layout, and the caret is in its field.
        await fold(app);
        await press(app, "KeyF", "f", true);
        await unfolded(app);
        await app.waitForCondition<boolean>(
          `(function(){var b=document.querySelector('${BAR}'); return b!==null && getComputedStyle(b).display!=="none" && b.contains(document.activeElement);})()`,
          { timeoutMs: 6000 },
        );
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a conflict raised while folded rides the masthead, and the banner presents on the unfold",
    async () => {
      const { dir, file } = mkFixture("at0669-conflict");
      const app = await launchTugApp({ testName: "at0669-conflict" });
      try {
        await seed(app, file);
        // An external write plus an unflushed local edit: the autosave that
        // follows conflicts. The fold lands inside the autosave's debounce, so
        // the conflict is raised on a folded card.
        fs.writeFileSync(file, "EXTERNAL\n" + BODY, "utf8");
        await app.evalJS<boolean>(
          `(function(){var el=document.querySelector('${EDITOR}'); el.focus(); return document.execCommand("insertText", false, "LOCAL ");})()`,
        );
        await toggleFold(app);
        await app.waitForCondition<boolean>(
          `(function(){var d=document.querySelector('${DETAIL}'); return d!==null && d.textContent==="File changed";})()`,
          { timeoutMs: 10_000 },
        );
        const folded = await app.evalJS<string>(
          `JSON.stringify({folded: window.__tug.getPaneRecord("p1").folded, banner: document.querySelector('${RELOAD}')!==null})`,
        );
        expect(JSON.parse(folded), "folded: the masthead says it, no banner").toEqual({
          folded: true,
          banner: false,
        });

        await toggleFold(app);
        await app.waitForCondition<boolean>(`document.querySelector('${RELOAD}')!==null`, {
          timeoutMs: 6000,
        });
        expect(
          fs.readFileSync(file, "utf8").startsWith("EXTERNAL"),
          "the external write survives: the conflict held the save",
        ).toBe(true);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
