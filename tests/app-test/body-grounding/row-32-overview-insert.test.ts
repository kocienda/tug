/**
 * row-32-overview-insert.test.ts — the Overview's Insert into Prompt lands in
 * its own composer, inside its own body.
 *
 * The Overview is a body. A post on its channel names a file of this
 * checkout; the post is written to the instance's ledger before the
 * Overview opens, so it reaches the Overview's page the production way —
 * the body's store asks tugcast for the channel's tail and is answered.
 * A right-click on the file the prose names offers Insert Atom into Prompt;
 * picking it puts the atom in the Overview's composer, in the Overview's
 * body. The insert never leaves the card's page: the shell's document holds
 * no Overview at all.
 *
 * @foreground
 * @covers tugdeck/src/components/overview/overview-insert-target.ts
 * @covers tugdeck/src/components/overview/overview-card-registration.tsx
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, note } from "../_harness";
import { pollFor } from "./_bodies";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { cardKind } from "./_kinds";

const TEST_NAME = "body-grounding-row-32-overview-insert";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const OVERVIEW = "r32-overview";
const CARD = '[data-testid="overview-card"]';
const BODY = `${CARD} .overview-post-body`;
const ANNOTATION = `${BODY} [data-tug-annotation="file-path"]`;
const FIELD = '[data-testid="overview-composer-field"]';
const FIELD_ATOM = `${FIELD} .cm-content img[data-atom-label]`;
const MENU = '[data-slot="tug-editor-context-menu"]';
const INSERT_ITEM = `${MENU} [data-item-action="insert-into-prompt"]`;

/** This checkout — the post's `project_dir`, so the mention resolves for real. */
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const MENTIONED = "tugdeck/src/lib/layout-imposer.ts";
const MENTIONED_NAME = "layout-imposer.ts";

/** A real `contextmenu` at the centre of the annotation the prose carries. */
const OPEN_MENU_OVER_ANNOTATION = `(function(){
  var el = document.querySelector(${JSON.stringify(ANNOTATION)});
  if (el === null) return "no annotation";
  var rect = el.getBoundingClientRect();
  var x = Math.round(rect.left + rect.width / 2);
  var y = Math.round(rect.top + rect.height / 2);
  var target = document.elementFromPoint(x, y);
  if (target === null) return "no target";
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
  return "ok";
})()`;

const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;

describe.skipIf(!SHOULD_RUN)("body-grounding row 32: the Overview's insert stays in its body", () => {
  test(
    "Insert into Prompt on a post's file lands an atom in the Overview's own composer, in its body",
    async () => {
      const app = await launchTugApp({ testName: TEST_NAME, foreground: true });
      try {
        app.seedLedger({
          overview_posts: [
            { at_ms: Date.now() - 60_000, author: "observer", body: `Reworked ${MENTIONED} this afternoon.`, refs: [], project_dir: REPO_ROOT },
          ],
        });
        await app.seedDeckState({ state: kindDeck(cardKind("overview"), OVERVIEW, { sessions: ["r32-a"] }), focusCardId: OVERVIEW });
        const body = await standUpKind(app, cardKind("overview"), OVERVIEW);

        const annotated = await pollFor(() => body.evalJS<boolean>(present(ANNOTATION)), (v) => v, 15_000);
        expect(annotated, "the seeded post reached the Overview's body and its prose names the file").toBe(true);
        // card-dom: shell
        expect(await app.evalJS<boolean>(present(CARD)), "the shell's document holds no Overview").toBe(false);

        expect(await body.evalJS<string>(OPEN_MENU_OVER_ANNOTATION)).toBe("ok");
        const offered = await pollFor(() => body.evalJS<boolean>(present(INSERT_ITEM)), (v) => v, 5_000);
        expect(offered, "the row menu offers the insert, in the Overview's body").toBe(true);
        const label = await body.evalJS<string>(`(document.querySelector(${JSON.stringify(INSERT_ITEM)}).textContent || "").trim()`);
        expect(label).toBe("Insert Atom into Prompt");

        await body.nativeClickAtElement(INSERT_ITEM);
        const landed = await pollFor(() => body.evalJS<boolean>(present(FIELD_ATOM)), (v) => v, 10_000);
        expect(landed, "the atom landed in the Overview's composer").toBe(true);
        const atomLabel = await body.evalJS<string>(`document.querySelector(${JSON.stringify(FIELD_ATOM)}).getAttribute("data-atom-label")`);
        note(`composer atom label ${JSON.stringify(atomLabel)}`);
        expect(atomLabel).toBe(MENTIONED_NAME);
        const caret = await pollFor(
          () => body.evalJS<boolean>(`(function(){ var f = document.querySelector(${JSON.stringify(FIELD)}); return f !== null && document.activeElement !== null && f.contains(document.activeElement); })()`),
          (v) => v,
          10_000,
        );
        expect(caret, "the caret came with the atom, in the Overview's field").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
