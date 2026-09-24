/**
 * at0623-smart-insert-drop-padding.test.ts — a file dropped into the middle of
 * a word in the Session card composer pads itself with spaces, and a file
 * dropped into air that already has enough of it adds none.
 *
 * ## What this pins
 *
 * The drop insert used to write its run at the resolved position verbatim, so
 * a chip dropped into `foobar` welded to the characters on both sides and the
 * user backed up and typed the spaces by hand. Smart insert — the macOS
 * smart-paste judgment, one pure `padForInsert` decision every insert door
 * asks — adds air only on a side that is missing it.
 *
 * The unit tests hold the decision's table. What only the real app can say is
 * that the drop's resolved position, the padding, the atom effect's position
 * and the caret all agree in one transaction: an off-by-one between the pad
 * and the `addAtomsEffect` position hangs the chip on the space instead of on
 * its own `U+FFFC`, which no headless assertion on the spec would catch.
 *
 * ## Shape
 *
 *   1. A Session card with a bound session, its composer focused.
 *   2. Type `note: ` and drop a real PNG `File` past the end of the line. The
 *      preceding character is already a space and there is nothing after it,
 *      so the chip lands bare — `note: ⟨chip⟩`, with no doubled space.
 *   3. Type ` foobar` after it and drop a second PNG at the boundary before
 *      `bar`. That one is welded on both sides, so it takes a space on each:
 *      `note: ⟨chip⟩ foo ⟨chip⟩ bar`.
 *
 * Both scenarios type at the caret the previous one left, so the test never
 * reaches for select-all — ⌘A is an Edit-menu key equivalent and resolving one
 * needs the screen, which an unattended run does not have.
 *
 * Reading the line reconstructs the substrate from the DOM — text nodes as
 * their text, each `img[data-atom-label]` as `⟨label⟩` — which is the same
 * (text, atoms) pairing `walkAtomText` renders, read from what the user is
 * actually looking at.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/tug-text-editor/smart-insert.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/atom-decoration.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 120_000;

const EDITOR_HOST_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-editor"]';
const EDITOR_CONTENT_SELECTOR = `${EDITOR_HOST_SELECTOR} .cm-content`;
const LINE_SELECTOR = `${EDITOR_CONTENT_SELECTOR} .cm-line`;
const ATOM_IMG_SELECTOR = `${EDITOR_CONTENT_SELECTOR} img[data-atom-label]`;

const SESSION_DECK_STATE = {
  cards: [
    { id: "A", componentId: "session", title: "Session A", closable: true },
  ],
  panes: [
    {
      id: "p1",
      position: { x: 40, y: 40 },
      size: { width: 720, height: 540 },
      cardIds: ["A"],
      activeCardId: "A",
      title: "",
      acceptsFamilies: ["maker"],
    },
  ],
  activePaneId: "p1",
  hasFocus: true,
};

/**
 * The composer's first line, with each atom chip written as `⟨label⟩`.
 *
 * A chip is an `<img>`, so `textContent` alone reports the line with every
 * chip silently missing — which is exactly the shape of bug this test is
 * looking for. Walking text nodes and chip images in document order puts the
 * chip back where it stands.
 *
 * CM6 renders a space that would otherwise collapse — a trailing one, or one
 * beside a widget — as `U+00A0`, so the read normalizes those back. The
 * document holds an ordinary space either way; only the DOM spells it
 * differently.
 */
function lineText(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function(){
      var line = document.querySelector(${JSON.stringify(LINE_SELECTOR)});
      if (line === null) return "";
      var walker = document.createTreeWalker(
        line,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      );
      var out = "", n = null;
      while ((n = walker.nextNode()) !== null) {
        if (n.nodeType === Node.TEXT_NODE) { out += n.nodeValue || ""; continue; }
        var label = n.getAttribute === undefined
          ? null
          : n.getAttribute("data-atom-label");
        if (label !== null) out += "\\u27e8" + label + "\\u27e9";
      }
      return out.replace(/\\u00a0/g, " ");
    })()`,
  );
}

/** Every chip's label, in document order. */
function chipLabels(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(ATOM_IMG_SELECTOR)}))
      .map(function(img){ return img.getAttribute("data-atom-label") || ""; })`,
  );
}

/**
 * Drop a real PNG `File` on the composer at a position resolved from the
 * document itself.
 *
 * `needle` names a run of text in the first line: the drop lands at its first
 * character's left boundary, which is the position `dropOffsetAtCoords`
 * resolves from the pointer. `null` drops past the line's last character, so
 * the position is the end of the document.
 *
 * The PNG is encoded in-page (canvas → blob) — the same bytes a real drag
 * delivers — and the whole production path runs: downsample, bytes store,
 * `insertMixedAt`. `evalJS` cannot await, so the handler signals through a
 * window flag the test polls.
 */
async function dropPngAt(app: App, needle: string | null): Promise<void> {
  const chipsBefore = (await chipLabels(app)).length;
  await app.evalJS<void>(
    `(function(){
      window.__at0623Dropped = false;
      var host = document.querySelector(${JSON.stringify(EDITOR_HOST_SELECTOR)});
      var line = document.querySelector(${JSON.stringify(LINE_SELECTOR)});
      var needle = ${needle === null ? "null" : JSON.stringify(needle)};

      // Where to aim. With a single-line document only x decides the column,
      // so y is the line's own middle plus the drop extension's upward bias —
      // the caret the user was shown is the position the insert takes.
      var box = line.getBoundingClientRect();
      var y = box.top + box.height / 2 + box.height * 0.8;
      var x;
      if (needle === null) {
        x = box.right + 40;
      } else {
        // The needle is located against the line's TEXT nodes, which is also
        // where its screen rect has to come from — a chip contributes no text
        // and is skipped on both counts.
        var walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        var text = "", nodes = [], n = null;
        while ((n = walker.nextNode()) !== null) {
          nodes.push({ node: n, at: text.length });
          text += n.nodeValue || "";
        }
        var found = text.indexOf(needle);
        if (found === -1) throw new Error("at0623: no " + needle + " in " + text);
        var hit = null;
        for (var i = 0; i < nodes.length; i++) {
          var len = (nodes[i].node.nodeValue || "").length;
          if (found < nodes[i].at + len) {
            hit = { node: nodes[i].node, offset: found - nodes[i].at };
            break;
          }
        }
        if (hit === null) throw new Error("at0623: no node for " + needle);
        var range = document.createRange();
        range.setStart(hit.node, hit.offset);
        range.setEnd(hit.node, hit.offset + 1);
        var r = range.getBoundingClientRect();
        // Just inside the character, so the nearest boundary is the one
        // before it.
        x = r.left + 1;
      }

      var canvas = document.createElement("canvas");
      canvas.width = 64; canvas.height = 64;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#334455"; ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = "#ccddee"; ctx.fillRect(8, 8, 48, 48);
      canvas.toBlob(function(blob){
        var file = new File([blob], "dropped.png", { type: "image/png" });
        var dt = new DataTransfer();
        dt.items.add(file);
        var ev = new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        });
        Object.defineProperty(ev, "dataTransfer", { value: dt });
        host.dispatchEvent(ev);
        window.__at0623Dropped = true;
      }, "image/png");
    })()`,
  );
  await app.waitForCondition<boolean>(`window.__at0623Dropped === true`, {
    timeoutMs: 10_000,
  });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(ATOM_IMG_SELECTOR)}).length === ${chipsBefore + 1}`,
    { timeoutMs: 10_000 },
  );
}

/** Type `text` at the caret and wait for the line to carry it. */
async function typeAtCaret(app: App, text: string): Promise<void> {
  await app.nativeType(text);
  await app.waitForCondition<boolean>(
    `(function(){
      var line = document.querySelector(${JSON.stringify(LINE_SELECTOR)});
      if (line === null) return false;
      return (line.textContent || "").replace(/\\u00a0/g, " ").indexOf(${JSON.stringify(text)}) !== -1;
    })()`,
    { timeoutMs: 5_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0623: smart insert pads a dropped atom", () => {
  test(
    "a drop into air adds nothing, and a drop mid-word gets air on both sides",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);

        const app = await launchTugApp({
          testName: "at0623-smart-insert-drop-padding",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });

        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: SESSION_DECK_STATE,
            focusCardId: "A",
          });
          await new Promise<void>((r) => setTimeout(r, 1500));
          await app.bindSession("A");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR_CONTENT_SELECTOR)}) !== null`,
            { timeoutMs: 10_000 },
          );
          await app.nativeClickAtElement(EDITOR_CONTENT_SELECTOR);

          // --- Into air: the rule adds nothing it does not have to. -----
          await typeAtCaret(app, "note: ");
          await dropPngAt(app, null);

          const first = await chipLabels(app);
          expect(first).toHaveLength(1);
          expect(await lineText(app)).toBe(`note: ⟨${first[0]}⟩`);

          // --- Mid-word: the defect this work is about. -----------------
          await typeAtCaret(app, " foobar");
          await dropPngAt(app, "bar");

          const both = await chipLabels(app);
          expect(both).toHaveLength(2);
          expect(await lineText(app)).toBe(
            `note: ⟨${both[0]}⟩ foo ⟨${both[1]}⟩ bar`,
          );
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
