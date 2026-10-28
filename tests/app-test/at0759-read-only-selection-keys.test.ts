/**
 * at0759-read-only-selection-keys.test.ts — the keyboard acts on a read-only
 * selection the reader made with the mouse, wherever DOM focus is.
 *
 * Nothing in the transcript is focusable, so a drag there leaves no element
 * of the transcript holding DOM focus, and the next key the reader presses
 * finds its way back to the composer, which takes it. When Select All was
 * performed natively, AppKit's `selectAll:` therefore reached the composer
 * and the transcript was never selected.
 *
 * Every gesture is the app's own: a trusted native drag on a real resumed
 * transcript, and a real ⌘A that the window offers to its views before the
 * main menu, as a user's key is. The assertions read `window.getSelection()`
 * and `document.activeElement` in the card's body.
 *
 * Legs:
 *   1. **⇧→ extends the drag.** Focus the composer, drag a selection in a
 *      transcript entry, press ⇧→. The selection is one character longer,
 *      from the same base, and still inside the transcript — the key did not
 *      go to the composer. ⇧⌥→ then extends it by a word.
 *   1b. **The extent pivots on the base.** Drag again, then ⇧←: the selection
 *      shrinks from its extent end, the base fixed. Carry on past the base: the
 *      selection collapses onto it and then grows backward from it, the base
 *      still fixed; ⇧→ brings it back through to the other side.
 *   2. **⌘A selects the transcript.** Press ⌘A. The selection now covers that
 *      entry — more than the drag did, both ends inside the transcript.
 *   3. **A help document is the same.** Open Help ▸ Tug Help, drag across a
 *      paragraph, press ⇧→: one character more, from the same base. Press ⌘A:
 *      the whole document is selected, first block to last — the block is a
 *      read-only document of its own, answering Select All.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 * @covers tugdeck/src/components/tugways/selection-extension.ts
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/components/tugways/use-read-only-text-surface.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { seedFixtureSession } from "./fixtures/resolve";
import {
  openFixtureSession,
  SCROLLER,
  TRANSCRIPT,
  waitForTranscriptSettled,
} from "./fixtures/runner";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const COMPOSER = '[data-card-id="A"] .tug-prompt-entry .cm-content';

/** Minimum characters the probe line needs for a drag across two words. */
const MIN_PROBE_LENGTH = 60;

/** Let the selection settle between trusted gestures. */
const GESTURE_SETTLE_MS = 220;

function settle(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface SelectionState {
  /** True when there is no selection, or it is collapsed to a caret. */
  collapsed: boolean;
  /** Both ends of the selection lie inside the transcript. */
  inTranscript: boolean;
  /** DOM focus is inside the composer's editor. */
  composerFocused: boolean;
  text: string;
  /** The base end, as its node's leading text and offset. */
  anchor: string;
  /** The extent lies before the base in document order. */
  backward: boolean;
  detail: string;
}

const READ_SELECTION = `(function(){
  var root = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var composer = document.querySelector(${JSON.stringify(COMPOSER)});
  var sel = window.getSelection();
  var active = document.activeElement;
  var composerFocused = composer !== null && active !== null && composer.contains(active);
  if (sel === null || sel.rangeCount === 0) {
    return { collapsed: true, inTranscript: false, composerFocused: composerFocused, text: "",
             detail: "no-range" };
  }
  var inTranscript = root !== null && sel.anchorNode !== null && sel.focusNode !== null &&
    root.contains(sel.anchorNode) && root.contains(sel.focusNode);
  var text = sel.toString();
  var anchor = (sel.anchorNode ? (sel.anchorNode.textContent || "").slice(0, 24) : "") + "@" + sel.anchorOffset;
  var backward = false;
  if (!sel.isCollapsed && sel.anchorNode !== null && sel.focusNode !== null) {
    var order = document.createRange();
    order.setStart(sel.anchorNode, sel.anchorOffset);
    order.setEnd(sel.focusNode, sel.focusOffset);
    backward = order.collapsed;
  }
  var fr = window.__tug ? window.__tug.getFirstResponderId() : null;
  var frEl = fr ? document.querySelector('[data-responder-id="' + fr + '"]') : null;
  var frWhere = frEl === null ? "none" : root !== null && root.contains(frEl) ? "transcript" :
    composer !== null && frEl.contains(composer) ? "composer" : frEl.className;
  return {
    collapsed: sel.isCollapsed,
    inTranscript: inTranscript,
    composerFocused: composerFocused,
    text: text,
    anchor: anchor,
    backward: backward,
    detail: "collapsed=" + sel.isCollapsed + " inTranscript=" + inTranscript +
      " backward=" + backward + " anchor=" + JSON.stringify(anchor) +
      " composerFocused=" + composerFocused +
      " firstResponder=" + frWhere +
      " active=" + (active ? active.tagName + "." + (active.className || "") : "null") +
      " text=" + JSON.stringify(text.slice(0, 60)),
  };
})()`;

/**
 * Viewport points for a drag across the first on-screen prose line long
 * enough to hold two words, measured now. The line's host is re-centered
 * when it has drifted out of the scrollport.
 */
function dragPoints(rootSelector: string, scrollerSelector: string): string {
  return `(function(){
  var root = document.querySelector(${JSON.stringify(rootSelector)});
  var scroller = document.querySelector(${JSON.stringify(scrollerSelector)});
  if (root === null || scroller === null) return "__NO_ROOT__";
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() !== null) {
    var node = walker.currentNode;
    var content = node.textContent || "";
    if (content.trim().length < ${MIN_PROBE_LENGTH}) continue;
    var words = [];
    var re = /[A-Za-z]{4,}/g;
    var m;
    while ((m = re.exec(content)) !== null) words.push(m.index + 1);
    if (words.length < 3) continue;
    function rectAt(offset) {
      var r = document.createRange();
      r.setStart(node, offset);
      r.setEnd(node, offset + 1);
      return r.getBoundingClientRect();
    }
    var view = scroller.getBoundingClientRect();
    var a = rectAt(words[0]);
    if (a.top < view.top + 4 || a.bottom > view.bottom - 4) {
      if (node.parentElement) node.parentElement.scrollIntoView({ block: "center" });
      view = scroller.getBoundingClientRect();
      a = rectAt(words[0]);
    }
    var b = rectAt(words[2]);
    if (a.width <= 0 || b.width <= 0 || Math.abs(a.top - b.top) > 2) continue;
    if (a.top < view.top + 4 || a.bottom > view.bottom - 4) continue;
    return {
      from: { x: Math.round(a.left + a.width / 2), y: Math.round(a.top + a.height / 2) },
      to: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) },
    };
  }
  return "__NO_PROBE__";
})()`;
}

const DRAG_POINTS = dragPoints(TRANSCRIPT, SCROLLER);

/** The help card's rendered document, and the card's scroller. */
const HELP_DOC = '[data-slot="help-card"] [data-slot="tug-markdown-block"]';
const HELP_SCROLLER = '[data-slot="help-card"]';

interface DocSelection {
  collapsed: boolean;
  /** Both ends lie inside the document. */
  inside: boolean;
  /** The first and last blocks lie wholly inside the selection. */
  whole: boolean;
  text: string;
  anchor: string;
  detail: string;
}

const READ_HELP_SELECTION = `(function(){
  var root = document.querySelector(${JSON.stringify(HELP_DOC)});
  var sel = window.getSelection();
  if (root === null || sel === null || sel.rangeCount === 0) {
    return { collapsed: true, inside: false, whole: false, text: "", anchor: "", detail: "no-range" };
  }
  var inside = sel.anchorNode !== null && sel.focusNode !== null &&
    root.contains(sel.anchorNode) && root.contains(sel.focusNode);
  var first = root.firstElementChild, last = root.lastElementChild;
  var whole = first !== null && last !== null &&
    sel.containsNode(first, false) && sel.containsNode(last, false);
  var text = sel.toString();
  var anchor = (sel.anchorNode ? (sel.anchorNode.textContent || "").slice(0, 24) : "") + "@" + sel.anchorOffset;
  return {
    collapsed: sel.isCollapsed, inside: inside, whole: whole, text: text, anchor: anchor,
    detail: "collapsed=" + sel.isCollapsed + " inside=" + inside + " whole=" + whole +
      " length=" + text.length + " text=" + JSON.stringify(text.slice(0, 60)),
  };
})()`;

/** Perform Help ▸ Tug Help and return the help card it brought forward. */
async function openTugHelp(app: App): Promise<string> {
  const performed = await app.performMenuItem("help.tugHelp");
  expect(performed.found && performed.performed, "help.tugHelp performs").toBe(true);
  // card-dom: shell — the active card and its bag are the deck's record.
  return app.waitForCondition<string>(
    `(function () {
      var id = window.__tug.getActiveCardId();
      if (id === null) return null;
      var bag = window.__tug.getCardStateBag(id);
      var content = bag && bag.content;
      return content && content.doc === "features" ? id : null;
    })()`,
    { timeoutMs: 5_000 },
  );
}

interface DragPoints {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

describe.skipIf(!SHOULD_RUN)(
  "at0759: the keyboard acts on a read-only selection",
  () => {
    test(
      "⌘A after a drag in the transcript selects the transcript entry",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        const seeded = await seedFixtureSession("session-transcript-basic", "at0759");
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.dev",
          "recent-projects",
          "json",
          JSON.stringify({ paths: [seeded.projectDir] }),
        );

        const app = await launchTugApp({
          testName: "at0759-read-only-selection-keys",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
        });
        try {
          await openFixtureSession(app, seeded);
          await waitForTranscriptSettled(app);
          const body = app.body("A");

          const composerHasFocus = `(function(){
            var c = document.querySelector(${JSON.stringify(COMPOSER)});
            return c !== null && c.contains(document.activeElement);
          })()`;

          /** Drag across a prose line in the transcript, and read the result. */
          const dragInTranscript = async (): Promise<SelectionState> => {
            const points = await body.evalJS<DragPoints | string>(DRAG_POINTS);
            if (typeof points === "string") {
              throw new Error(`no usable prose line in the transcript: ${points}`);
            }
            await settle(GESTURE_SETTLE_MS);
            const fresh = await body.evalJS<DragPoints | string>(DRAG_POINTS);
            const drag = typeof fresh === "string" ? points : fresh;
            await body.nativeDrag(drag.from, drag.to);
            await settle(GESTURE_SETTLE_MS);
            return body.evalJS<SelectionState>(READ_SELECTION);
          };

          // ── Leg 0: the reader reached the composer from the keyboard and
          // typed, then dragged in the transcript. ⇧→ extends the drag. ──
          await app.nativeKey("k", ["cmd"]);
          await body.waitForCondition<boolean>(composerHasFocus, { timeoutMs: 4000 });
          await app.nativeType("ab");
          const typedThenDragged = await dragInTranscript();
          note(`typed, then the drag: ${typedThenDragged.detail}`);
          expect(typedThenDragged.collapsed, typedThenDragged.detail).toBe(false);
          expect(typedThenDragged.inTranscript, typedThenDragged.detail).toBe(true);
          await app.nativeKey("ArrowRight", ["shift"]);
          await settle(GESTURE_SETTLE_MS);
          const typedExtended = await body.evalJS<SelectionState>(READ_SELECTION);
          note(`typed, then ⇧→: ${typedExtended.detail}`);
          expect(typedExtended.inTranscript, `⇧→ left the transcript: ${typedExtended.detail}`).toBe(true);
          expect(typedExtended.text.length, `⇧→ did not extend by one: ${typedExtended.detail}`).toBe(
            typedThenDragged.text.length + 1,
          );

          // The composer holds DOM focus, put there by a click.
          await body.nativeClickAtElement(COMPOSER);
          await body.waitForCondition<boolean>(composerHasFocus, { timeoutMs: 4000 });

          const dragged = await dragInTranscript();
          note(`after the drag: ${dragged.detail}`);
          expect(dragged.collapsed, dragged.detail).toBe(false);
          expect(dragged.inTranscript, dragged.detail).toBe(true);

          // ── Leg 1: ⇧→ extends the drag by a character, ⇧⌥→ by a word. ──
          await app.nativeKey("ArrowRight", ["shift"]);
          await settle(GESTURE_SETTLE_MS);
          const extended = await body.evalJS<SelectionState>(READ_SELECTION);
          note(`after ⇧→: ${extended.detail}`);
          expect(extended.inTranscript, `⇧→ left the transcript: ${extended.detail}`).toBe(true);
          expect(extended.anchor, `⇧→ moved the base: ${extended.detail}`).toBe(dragged.anchor);
          expect(extended.text.length, `⇧→ did not extend by one: ${extended.detail}`).toBe(
            dragged.text.length + 1,
          );
          expect(extended.text.startsWith(dragged.text), extended.detail).toBe(true);

          await app.nativeKey("ArrowRight", ["shift", "alt"]);
          await settle(GESTURE_SETTLE_MS);
          const byWord = await body.evalJS<SelectionState>(READ_SELECTION);
          note(`after ⇧⌥→: ${byWord.detail}`);
          expect(byWord.inTranscript, byWord.detail).toBe(true);
          expect(byWord.anchor, byWord.detail).toBe(dragged.anchor);
          expect(byWord.text.length, `⇧⌥→ did not extend: ${byWord.detail}`).toBeGreaterThan(
            extended.text.length,
          );

          // ── Leg 1b: the extent pivots on the base. A fresh drag carries no
          // direction of its own, so ⇧← is the case that shows it: it must
          // shrink the selection from the extent end, never grow it from the
          // base. Carried past the base, the selection collapses onto it and
          // then grows backward from it, and ⇧→ brings it back through. ──
          const redrag = await dragInTranscript();
          note(`after the second drag: ${redrag.detail}`);
          expect(redrag.collapsed, redrag.detail).toBe(false);
          expect(redrag.backward, redrag.detail).toBe(false);
          const span = redrag.text.length;

          await app.nativeKey("ArrowLeft", ["shift"]);
          await settle(GESTURE_SETTLE_MS);
          const shrunk = await body.evalJS<SelectionState>(READ_SELECTION);
          note(`after ⇧←: ${shrunk.detail}`);
          expect(shrunk.anchor, `⇧← moved the base: ${shrunk.detail}`).toBe(redrag.anchor);
          expect(shrunk.text.length, `⇧← did not shrink by one: ${shrunk.detail}`).toBe(span - 1);
          expect(redrag.text.startsWith(shrunk.text), shrunk.detail).toBe(true);

          // span − 1 more reach the base; two past it leave two characters
          // before it.
          for (let i = 0; i < span + 1; i++) await app.nativeKey("ArrowLeft", ["shift"]);
          await settle(GESTURE_SETTLE_MS);
          const crossed = await body.evalJS<SelectionState>(READ_SELECTION);
          note(`past the base with ⇧←: ${crossed.detail}`);
          expect(crossed.inTranscript, crossed.detail).toBe(true);
          expect(crossed.anchor, `crossing moved the base: ${crossed.detail}`).toBe(redrag.anchor);
          expect(crossed.backward, `the extent did not cross the base: ${crossed.detail}`).toBe(true);
          expect(crossed.text.length, `⇧← past the base: ${crossed.detail}`).toBe(2);

          for (let i = 0; i < 3; i++) await app.nativeKey("ArrowRight", ["shift"]);
          await settle(GESTURE_SETTLE_MS);
          const recrossed = await body.evalJS<SelectionState>(READ_SELECTION);
          note(`back through with ⇧→: ${recrossed.detail}`);
          expect(recrossed.anchor, `recrossing moved the base: ${recrossed.detail}`).toBe(redrag.anchor);
          expect(recrossed.backward, recrossed.detail).toBe(false);
          expect(recrossed.text.length, `⇧→ back through the base: ${recrossed.detail}`).toBe(1);
          expect(redrag.text.startsWith(recrossed.text), recrossed.detail).toBe(true);

          // ── Leg 2: ⌘A selects the transcript entry, not the composer. ──
          await app.nativeKey("a", ["cmd"]);
          await settle(GESTURE_SETTLE_MS);
          const all = await body.evalJS<SelectionState>(READ_SELECTION);
          note(`after ⌘A: ${all.detail}`);
          expect(all.collapsed, all.detail).toBe(false);
          expect(all.inTranscript, `⌘A selected outside the transcript: ${all.detail}`).toBe(true);
          expect(all.text.length, `⌘A selected no more than the drag: ${all.detail}`).toBeGreaterThan(
            dragged.text.length,
          );
          expect(all.text).toContain(dragged.text);
        } finally {
          await app.quitGracefully();
          seeded.cleanup();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "⇧→ extends a drag in a help document, and ⌘A selects the whole document",
      async () => {
        const app = await launchTugApp({
          testName: "at0759-read-only-selection-help",
          skipAccessibilityPreflight: true,
        });
        try {
          const cardId = await openTugHelp(app);
          const body = app.body(cardId);
          await body.waitForCondition<boolean>(
            `(function(){ var r = document.querySelector(${JSON.stringify(HELP_DOC)}); return r !== null && r.childElementCount > 3; })()`,
            { timeoutMs: 10_000 },
          );

          const points = await body.evalJS<DragPoints | string>(dragPoints(HELP_DOC, HELP_SCROLLER));
          if (typeof points === "string") throw new Error(`no usable help paragraph: ${points}`);
          await settle(GESTURE_SETTLE_MS);
          const fresh = await body.evalJS<DragPoints | string>(dragPoints(HELP_DOC, HELP_SCROLLER));
          const drag = typeof fresh === "string" ? points : fresh;
          await body.nativeDrag(drag.from, drag.to);
          await settle(GESTURE_SETTLE_MS);
          const dragged = await body.evalJS<DocSelection>(READ_HELP_SELECTION);
          note(`help, after the drag: ${dragged.detail}`);
          expect(dragged.collapsed, dragged.detail).toBe(false);
          expect(dragged.inside, dragged.detail).toBe(true);

          // A fresh drag's first ⇧← shrinks it from the extent end; the base
          // stays where the drag began.
          await app.nativeKey("ArrowLeft", ["shift"]);
          await settle(GESTURE_SETTLE_MS);
          const shrunk = await body.evalJS<DocSelection>(READ_HELP_SELECTION);
          note(`help, after ⇧←: ${shrunk.detail}`);
          expect(shrunk.anchor, `⇧← moved the base: ${shrunk.detail}`).toBe(dragged.anchor);
          expect(shrunk.text.length, `⇧← did not shrink by one: ${shrunk.detail}`).toBe(
            dragged.text.length - 1,
          );

          await app.nativeKey("ArrowRight", ["shift"]);
          await app.nativeKey("ArrowRight", ["shift"]);
          await settle(GESTURE_SETTLE_MS);
          const extended = await body.evalJS<DocSelection>(READ_HELP_SELECTION);
          note(`help, after ⇧→: ${extended.detail}`);
          expect(extended.inside, extended.detail).toBe(true);
          expect(extended.anchor, `⇧→ moved the base: ${extended.detail}`).toBe(dragged.anchor);
          expect(extended.text.length, `⇧→ did not extend by one: ${extended.detail}`).toBe(
            dragged.text.length + 1,
          );

          await app.nativeKey("a", ["cmd"]);
          await settle(GESTURE_SETTLE_MS);
          const all = await body.evalJS<DocSelection>(READ_HELP_SELECTION);
          note(`help, after ⌘A: ${all.detail}`);
          expect(all.inside, `⌘A selected outside the document: ${all.detail}`).toBe(true);
          expect(all.whole, `⌘A did not select the whole document: ${all.detail}`).toBe(true);
          expect(all.text).toContain(dragged.text);
        } finally {
          await app.quitGracefully();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
