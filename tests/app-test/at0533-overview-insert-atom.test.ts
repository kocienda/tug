/**
 * at0533-overview-insert-atom.test.ts — sending an entity into the Overview's composer.
 *
 * The Overview's row menu used to show `Copy as Atom` with no insert row
 * beside it, and the reason was never that the gesture did not make sense
 * there: `useAnnotationMenu` filtered the item out for want of a
 * `CodeSessionStore`, and the Overview has no session. The gesture never
 * needed one. What it needs is a composer that can take an atom, take text,
 * and come forward — a `PromptInsertTarget` — and the Overview has had one of
 * those at the bottom of its rail all along.
 *
 * Three claims, and the last two are why this is an app-test rather than a
 * unit test:
 *
 *  1. **The item is offered.** A right-click on a file the post's prose names
 *     shows `Insert Atom into Prompt`, spelled the way the registry spells it
 *     for an entity that mints an atom. Nothing here is the Overview's own
 *     menu: the item is the registry's, the surface is `useTranscriptCellMenu`,
 *     and what changed is only what the surface hands it.
 *  2. **Picking it lands the atom in the Overview's own field.** The chip
 *     arrives in the composer as a real atom — an `img[data-atom-label]` in
 *     the CM6 content, labelled with the file's name — and the caret arrives
 *     with it, because raising the Overview composer is putting the caret in
 *     the field ([B07]) rather than activating a card. That whole path runs
 *     through three components that never see each other: the post cell that
 *     built the menu, the module-level insert target, and the composer that
 *     bound its editor delegate to it. Only the app can prove they meet.
 *  3. **A jot dropped on the composer lands at the drop point.** The Session
 *     entry's drop surface is a shared hook now, mounted on both composers,
 *     so a jot dragged out of the Jots card reads the same over the Overview
 *     as over a session prompt: accepted anywhere on the composer, inserted
 *     where it was let go rather than appended. The claim is the POINT — a
 *     drop at the head of a draft that lands at the head, which is the half
 *     an append rule would have got wrong.
 *
 * The post carries this checkout as its `project_dir` and names a path that
 * really exists, so the annotation under the pointer came off the production
 * resolve chain rather than a fixture.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/overview/overview-insert-target.ts
 * @covers tugdeck/src/components/tugways/use-composer-drop.ts
 * @covers tugdeck/src/lib/jot-drag.ts
 * @covers tugdeck/src/lib/prompt-insert-target.ts
 * @covers tugdeck/src/components/tugways/use-prompt-insert-target.ts
 * @covers tugdeck/src/components/tugways/use-annotation-menu.tsx
 * @covers tugdeck/src/components/tugways/use-annotation-clicks.ts
 * @covers tugdeck/src/lib/annotator/registry.ts
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const CARD = '[data-testid="overview-card"]';
const BODY = `${CARD} .overview-post-body`;
const FIELD = '[data-testid="overview-composer-field"]';
const FIELD_ATOM = `${FIELD} .cm-content img[data-atom-label]`;
const MENU = '[data-slot="tug-editor-context-menu"]';
const INSERT_ITEM = `${MENU} [data-item-action="insert-into-prompt"]`;

/** The private type a Jots card drag writes its substrate under. */
const JOT_MIME = "application/x-tug-jot";

/** What the dropped jot says, short enough to read in a one-line field. */
const JOT_TEXT = "alpha ";

/** This checkout — the post's `project_dir`, so the mention resolves for real. */
const REPO_ROOT = resolve(import.meta.dir, "../..");

/** A path that exists here, named in the prose so the annotator marks it. */
const MENTIONED = "tugdeck/src/lib/layout-imposer.ts";
const MENTIONED_NAME = "layout-imposer.ts";

/**
 * Open the row menu over the annotated element the prose carries — a real
 * `contextmenu` at its own center, so `extraEntries` samples the annotation
 * the reader right-clicked rather than whatever the browser smart-selected.
 */
const OPEN_MENU_OVER_ANNOTATION = `(function(){
  var el = document.querySelector(${JSON.stringify(`${BODY} [data-tug-annotation="file-path"]`)});
  if (el === null) return "__NO_ANNOTATION__";
  var rect = el.getBoundingClientRect();
  var x = Math.round(rect.left + rect.width / 2);
  var y = Math.round(rect.top + rect.height / 2);
  var target = document.elementFromPoint(x, y);
  if (target === null) return "__NO_TARGET__";
  target.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2,
  }));
  return "ok";
})()`;

describe.skipIf(!SHOULD_RUN)("at0533 — the Overview inserts an atom", () => {
  test(
    "a file the prose names becomes a chip in the Overview's composer, and a dropped jot lands at its point",
    async () => {
      const app = await launchTugApp({ testName: "at0533-overview-insert-atom" });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // One post naming one real file in its sentence. No ref list: the
        // mention has to atomize because the content annotator scanned the
        // prose, which is the same path the menu then samples.
        const post = {
          id: 9301,
          at_ms: 1_754_600_000_000,
          author: "observer",
          body: `Reworked ${MENTIONED} this afternoon.`,
          refs: [],
          project_dir: REPO_ROOT,
        };
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
          ),
        ).toBe(true);

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${BODY} [data-tug-annotation="file-path"]`)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // ── 1. The item is offered, and spelled for an atom. ──────────────
        expect(await app.evalJS<string>(OPEN_MENU_OVER_ANNOTATION)).toBe("ok");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(INSERT_ITEM)}) !== null`,
          { timeoutMs: 5_000 },
        );
        const label = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(INSERT_ITEM)}).textContent || "").trim()`,
        );
        note("insert item label", label);
        // The registry names the item by what it will do: a file mints an
        // atom, so the label says so. `Insert into Prompt` here would mean
        // the atom predicate came back null and the path was about to go in
        // as a run of characters.
        expect(label).toBe("Insert Atom into Prompt");

        // ── 2. Picking it lands the chip, and the caret with it. ──────────
        await app.nativeClickAtElement(INSERT_ITEM);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIELD_ATOM)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const atomLabel = await app.evalJS<string>(
          `document.querySelector(${JSON.stringify(FIELD_ATOM)}).getAttribute("data-atom-label")`,
        );
        note("composer atom label", atomLabel);
        // The chip reads as a filename and carries the whole path underneath
        // — `atomSegmentFor`'s split, unchanged by the Overview.
        expect(atomLabel).toBe(MENTIONED_NAME);

        // Raising the Overview composer is the focus engine placing the
        // caret in the field. A chip with no caret means the insert landed
        // and the raise did not, which is a composer the user has to click
        // into before they can say anything about what they just inserted.
        await app.waitForCondition<boolean>(
          `(function(){
            var field = document.querySelector(${JSON.stringify(FIELD)});
            return field !== null && document.activeElement !== null &&
              field.contains(document.activeElement);
          })()`,
          { timeoutMs: 10_000 },
        );

        // ── 3. A jot dropped on the composer lands where it was let go. ───
        // The field is not empty — it holds the chip claim 2 just put there
        // — which is what makes the drop point legible: an insert at the
        // head keeps one line, and the append rule this replaces would have
        // put the text on a second one.
        const dropped = await app.evalJS<{
          constructed: boolean;
          x: number;
          y: number;
        }>(`(function(){
          var content = document.querySelector(${JSON.stringify(`${FIELD} .cm-content`)});
          if (content === null) return { constructed: false, x: 0, y: 0 };
          var dt;
          try {
            dt = new DataTransfer();
            dt.setData(${JSON.stringify(JOT_MIME)}, JSON.stringify({
              text: ${JSON.stringify(JOT_TEXT)}, atoms: [],
            }));
            dt.setData("text/plain", ${JSON.stringify(JOT_TEXT)});
          } catch (e) {
            return { constructed: false, x: 0, y: 0 };
          }
          // The head of the first line: left edge, first line's own middle.
          var line = content.querySelector(".cm-line") || content;
          var rect = line.getBoundingClientRect();
          var x = Math.round(rect.left + 1);
          var y = Math.round(rect.top + rect.height / 2);
          content.dispatchEvent(new DragEvent("drop", {
            bubbles: true, cancelable: true, dataTransfer: dt,
            clientX: x, clientY: y,
          }));
          return { constructed: true, x: x, y: y };
        })()`);
        note("jot drop", JSON.stringify(dropped));
        // Without a constructible DragEvent + DataTransfer the drop path is
        // not reachable at all, and a green run below would mean nothing.
        expect(dropped.constructed).toBe(true);

        await app.waitForCondition<boolean>(
          `(function(){
            var content = document.querySelector(${JSON.stringify(`${FIELD} .cm-content`)});
            return content !== null &&
              (content.textContent || "").indexOf(${JSON.stringify(JOT_TEXT.trim())}) !== -1;
          })()`,
          { timeoutMs: 10_000 },
        );
        const afterDrop = await app.evalJS<{ lines: number; atoms: number }>(
          `(function(){
            var content = document.querySelector(${JSON.stringify(`${FIELD} .cm-content`)});
            return {
              lines: content.querySelectorAll(".cm-line").length,
              atoms: content.querySelectorAll("img[data-atom-label]").length,
            };
          })()`,
        );
        note("after the jot drop", JSON.stringify(afterDrop));
        // One line: the text went in at the drop point, beside the chip. Two
        // would mean the drop coordinate resolved to nothing and the append
        // rule ran instead — the composer taking the jot but not the aim.
        expect(afterDrop.lines).toBe(1);
        // And the chip that was already there survived the insert.
        expect(afterDrop.atoms).toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
