/**
 * at0851-explain-code-sheet.test.ts — the Explain Code sheet, from its door
 * to the composer.
 *
 * A session card is bound and the sheet is opened from the real Session menu
 * row. This holds:
 *
 *  - The sheet has a first row that names no form and one row per diagram
 *    form the catalog lists, read from the real forms route.
 *  - Every form's figure is its sample: drawn, marked Sample, a still
 *    thumbnail with no keyed table, and never moving.
 *  - ⌃⌘X closes the sheet and opens it again.
 *  - Explain… on a form closes the sheet and leaves `/tugplug:explain` in the
 *    composer, unsent, with ` as <form>` behind the caret, so that what is
 *    typed next is the subject.
 *
 * @covers tugdeck/src/components/tugways/cards/explain-code-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/explain-code-sheet.css
 * @covers tugdeck/src/lib/diagram-forms-store.ts
 * @covers tugapp/Sources/MenuBarBuilder.swift
 */

import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";

import { launchTugApp, note } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import { sessionCardShape } from "./_harness/shapes";
import { testTmpDir } from "./_harness/test-cleanup";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const SHEET = '[data-slot="tug-sheet"]';
const SHEET_TITLE = `${SHEET} .tug-sheet-title`;
const ROW = `${SHEET} [data-tugx-explain-form]`;
const EDITOR = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';

const FORMS = ["flow", "sequence", "layers", "stack", "states", "tree"];
const CHOSEN = "sequence";
const SUBJECT = "login";

const SHEET_IS_UP = `(function(){ var e = document.querySelector(${JSON.stringify(SHEET_TITLE)}); return e !== null && e.textContent === "Explain Code"; })()`;
const SHEET_IS_GONE = `document.querySelector(${JSON.stringify(SHEET)}) === null`;

const READ_ROWS = `Array.from(document.querySelectorAll(${JSON.stringify(ROW)})).map(function (row) {
  var figure = row.querySelector(".tugx-chart");
  return {
    form: row.getAttribute("data-tugx-explain-form"),
    sampled: row.querySelector(".explain-code-sheet-sample-mark") !== null,
    figure: figure === null ? null : figure.getAttribute("data-tugx-chart-state"),
    thumbnail: figure !== null && figure.hasAttribute("data-tugx-chart-thumbnail"),
    drawn: figure !== null && figure.querySelector("svg") !== null,
    tables: row.querySelectorAll("table").length,
    moving: figure !== null && (figure.hasAttribute("data-tugx-chart-animate") || figure.getAnimations({ subtree: true }).length > 0),
  };
})`;

interface RowFacts {
  form: string;
  sampled: boolean;
  figure: string | null;
  thumbnail: boolean;
  drawn: boolean;
  tables: number;
  moving: boolean;
}

/** The forms have been read and every form's figure has drawn. */
const ROWS_SETTLED = `(function(){
  var rows = ${READ_ROWS};
  return rows.length > 1 && rows.every(function (r) { return r.form === "" || r.figure === "rendered"; });
})()`;

/** The composer's chip, its text, and the text behind the caret. */
const READ_COMPOSER = `(function(){
  var ed = document.querySelector(${JSON.stringify(EDITOR)});
  var chip = ed.querySelector("img[data-atom-label]");
  var sel = window.getSelection();
  var behind = null;
  if (sel !== null && sel.focusNode !== null && ed.contains(sel.focusNode)) {
    var range = document.createRange();
    range.setStart(sel.focusNode, sel.focusOffset);
    range.setEnd(ed, ed.childNodes.length);
    behind = range.toString();
  }
  return { label: chip === null ? null : chip.getAttribute("data-atom-label"), text: ed.textContent, behind: behind };
})()`;

interface ComposerFacts {
  label: string | null;
  text: string;
  behind: string | null;
}

describe.skipIf(!SHOULD_RUN)("at0851 — the Explain Code sheet", () => {
  test(
    "opens from the menu, draws a sample per form, toggles on the chord, and Explain… leaves the caret where the subject goes",
    async () => {
      const project = realpathSync(testTmpDir("at0851-project-"));
      const app = await launchTugApp({ testName: "at0851-explain-code-sheet" });
      try {
        await app.seedDeckState({ state: sessionCardShape({ width: 1200, height: 800 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: "at0851-session", projectDir: project });
        await app.awaitEngineReady("A");
        const body = await waitForBodyReady(app, "A");

        const performed = await app.performMenuItem("session.explainCode");
        expect(performed.found && performed.performed, "the Session menu row performs").toBe(true);
        await body.waitForCondition<boolean>(SHEET_IS_UP, { timeoutMs: 6000 });
        await body.waitForCondition<boolean>(ROWS_SETTLED, { timeoutMs: 12_000 });

        const rows = await body.evalJS<RowFacts[]>(READ_ROWS);
        note(`at0851 rows: ${JSON.stringify(rows.map((r) => [r.form, r.figure, r.sampled]))}`);
        expect(rows.map((r) => r.form)).toEqual(["", ...FORMS]);

        // The row that names no form has nothing to draw.
        expect(rows[0].figure).toBeNull();
        expect(rows[0].sampled).toBe(false);

        // Every form's figure is its sample: marked, still, and with no keyed table.
        for (const row of rows.slice(1)) {
          expect(row.sampled, `${row.form} is marked Sample`).toBe(true);
          expect(row.drawn, `${row.form} is drawn`).toBe(true);
          expect(row.thumbnail, `${row.form} is a thumbnail`).toBe(true);
          expect(row.tables, `${row.form} has no keyed table`).toBe(0);
          expect(row.moving, `${row.form} is still`).toBe(false);
        }

        // The chord puts it away and brings it back.
        await app.nativeKey("x", ["ctrl", "cmd"]);
        await body.waitForCondition<boolean>(SHEET_IS_GONE, { timeoutMs: 6000 });
        await app.nativeKey("x", ["ctrl", "cmd"]);
        await body.waitForCondition<boolean>(SHEET_IS_UP, { timeoutMs: 6000 });
        await body.waitForCondition<boolean>(ROWS_SETTLED, { timeoutMs: 12_000 });

        // Explain… leaves the command in the composer, unsent, the form behind the caret.
        const explain = `${SHEET} [data-testid="explain-code-explain-${CHOSEN}"]`;
        await body.evalJS<null>(`(document.querySelector(${JSON.stringify(explain)}).scrollIntoView({ block: "center" }), null)`);
        await body.nativeClickAtElement(explain);
        await body.waitForCondition<boolean>(SHEET_IS_GONE, { timeoutMs: 6000 });
        await body.waitForCondition<boolean>(
          `(function(){
            var ed = document.querySelector(${JSON.stringify(EDITOR)});
            return ed !== null && ed.querySelector("img[data-atom-label]") !== null && ed.contains(document.activeElement);
          })()`,
          { timeoutMs: 6000 },
        );
        const placed = await body.evalJS<ComposerFacts>(READ_COMPOSER);
        note(`at0851 placed: ${JSON.stringify(placed)}`);
        expect(placed.label).toBe("tugplug:explain");
        expect(placed.text.trim()).toBe(`as ${CHOSEN}`);
        expect(placed.behind).toBe(` as ${CHOSEN}`);

        // What is typed next is the subject, ahead of the form.
        await app.nativeType(SUBJECT);
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR)}).textContent.indexOf(${JSON.stringify(SUBJECT)}) !== -1`,
          { timeoutMs: 6000 },
        );
        const typed = await body.evalJS<ComposerFacts>(READ_COMPOSER);
        expect(typed.text.trim()).toBe(`${SUBJECT} as ${CHOSEN}`);
        expect(typed.behind).toBe(` as ${CHOSEN}`);
      } finally {
        await app.close();
      }
    },
    120_000,
  );
});
