/**
 * at0776-key-glyph-face.test.ts — a modifier glyph in the transcript and in
 * the composer draws from the deck's own key face, not from a system fallback.
 *
 * WebKit will not say which face it used for a character, so this reads the
 * one thing the face decides: the width the glyph is laid out at, set in the
 * surface's own computed type. A `Range` over the one glyph cannot give that
 * width, since WebKit snaps a partial-text rect to whole pixels, so a probe
 * does. One turn streams a line holding a chord and the test types the same
 * chord into the composer, then opens the Keyboard card, whose chord chips carry
 * no family of their own. For each surface this holds:
 *
 *  - The computed `font-family` is headed by a Tug Keys face.
 *  - That face reports loaded for the glyph, so nothing is mid-swap.
 *  - The glyph's width in the surface's chain equals its width in the key face
 *    alone, and differs from its width in `system-ui`, which is the control
 *    that makes the equality mean something.
 *  - At the surface's own chain, the glyph stands on the baseline at the
 *    height of a capital letter. The stylesheet carries no metric override, so
 *    the seating is the font's.
 *
 * The theme's own editor token is read too: an editor outside a card root the
 * settings store binds, a Jots field say, draws from that value.
 *
 * @covers tugdeck/public/fonts.css
 * @covers tugdeck/src/components/tugways/cards/settings-keymap-body.css
 * @covers tugdeck/src/lib/editor-settings-store.ts
 * @covers tugdeck/styles/themes/*.css
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { kindBody, waitForBodyPainted } from "./_harness/card-reach";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { SHOULD_RUN, blobFor, launch } from "./settle-frames-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, bindStreamingStubs, startStreams, stubDirectory } from "./streaming-stub-fixture";

const TEST_NAME = "at0776-key-glyph-face";

/** The one session card `blobFor(1)` seats. */
const CARD = "at0622-c1";

const GLYPH = "⌘";
const TRANSCRIPT = `[data-card-id="${CARD}"] [data-testid="session-card-transcript"]`;
const COMPOSER = `[data-card-id="${CARD}"] [data-slot="tug-prompt-entry"] .cm-content`;
const KEYMAP_CHIP = `[data-testid="keymap-row-zoom-out"] .settings-keymap-chord-label`;

/** How long the turn may take to stream and end. */
const TURN_MS = 15_000;

/** Layout widths of one glyph in one face agree to this. */
const WIDTH_TOLERANCE_PX = 0.05;

/** A distinct face has to miss by more than this, or the control proves nothing. */
const CONTROL_MARGIN_PX = 0.25;

/** How far, at a 100 px reading, a glyph's top may sit from a capital's. */
const CAP_TOLERANCE_PX = 1.5;

interface GlyphFacts {
  found: boolean;
  family: string;
  head: string;
  loaded: boolean;
  width: number;
  keyFaceWidth: number;
  systemWidth: number;
  glyphAscent: number;
  glyphDescent: number;
  capAscent: number;
}

/** The computed style's first family, unquoted. */
const FIRST_FAMILY = `function firstFamily(family) { return family.split(",")[0].trim().replace(/^["']|["']$/g, ""); }`;

/** The node under `root` holding the glyph. */
const FIND_NODE = `function findNode(root) {
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (var n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if ((n.textContent || "").indexOf(${JSON.stringify(GLYPH)}) !== -1) return n;
  }
  return null;
}`;

function readFacts(selector: string): string {
  return `(function(){
    ${FIRST_FAMILY}
    ${FIND_NODE}
    var empty = { found: false, family: "", head: "", loaded: false, width: 0, keyFaceWidth: 0, systemWidth: 0,
                  glyphAscent: 0, glyphDescent: 0, capAscent: 0 };
    var root = document.querySelector(${JSON.stringify(selector)});
    var node = root === null ? null : findNode(root);
    if (node === null) return empty;
    var cs = getComputedStyle(node.parentElement);
    var head = firstFamily(cs.fontFamily);
    function probeWidth(family) {
      var probe = document.createElement("span");
      probe.textContent = ${JSON.stringify(GLYPH)};
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
      probe.style.fontFamily = family;
      probe.style.fontSize = cs.fontSize;
      probe.style.fontWeight = cs.fontWeight;
      probe.style.letterSpacing = cs.letterSpacing;
      // On the body, never in the surface: an editor would read the insertion as an edit.
      document.body.appendChild(probe);
      var w = probe.getBoundingClientRect().width;
      probe.remove();
      return w;
    }
    var ctx = document.createElement("canvas").getContext("2d");
    ctx.font = cs.fontWeight + " 100px " + cs.fontFamily;
    var glyph = ctx.measureText(${JSON.stringify(GLYPH)});
    var cap = ctx.measureText("H");
    return {
      found: true,
      family: cs.fontFamily,
      head: head,
      loaded: document.fonts.check(cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily, ${JSON.stringify(GLYPH)}),
      width: probeWidth(cs.fontFamily),
      keyFaceWidth: probeWidth('"' + head + '"'),
      systemWidth: probeWidth("system-ui"),
      glyphAscent: glyph.actualBoundingBoxAscent,
      glyphDescent: glyph.actualBoundingBoxDescent,
      capAscent: cap.actualBoundingBoxAscent,
    };
  })()`;
}

function holdFacts(surface: string, facts: GlyphFacts): void {
  note(`at0776 ${surface}: ${JSON.stringify(facts)}`);
  expect(facts.found, `${surface} holds the glyph`).toBe(true);
  expect(facts.head, `${surface} chain head`).toStartWith("Tug Keys");
  expect(facts.loaded, `${surface} key face is loaded`).toBe(true);
  expect(
    Math.abs(facts.width - facts.keyFaceWidth),
    `${surface} glyph ${facts.width} vs the key face ${facts.keyFaceWidth}`,
  ).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);
  expect(
    Math.abs(facts.width - facts.systemWidth),
    `${surface} glyph ${facts.width} vs system-ui ${facts.systemWidth}`,
  ).toBeGreaterThan(CONTROL_MARGIN_PX);
  expect(
    Math.abs(facts.glyphAscent - facts.capAscent),
    `${surface} glyph top ${facts.glyphAscent} vs a capital's ${facts.capAscent}`,
  ).toBeLessThanOrEqual(CAP_TOLERANCE_PX);
  expect(Math.abs(facts.glyphDescent), `${surface} glyph stands on the baseline`).toBeLessThanOrEqual(CAP_TOLERANCE_PX);
}

describe.skipIf(!SHOULD_RUN)("at0776 — a modifier glyph draws from the key face", () => {
  test(
    "in the transcript and in the composer",
    async () => {
      const stubDir = stubDirectory();
      const { app, tugbankPath } = await launch(1, blobFor(1), TEST_NAME, {
        resumeCards: [],
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        const stubs = await bindStreamingStubs(app, [CARD], stubDir, 1, 1, () => `Press ${GLYPH}S to save.\n`);
        await startStreams(app, stubs);
        const page = app.body(CARD);
        await page.waitForCondition<boolean>(
          `(function(){
            var entry = document.querySelector('[data-card-id="${CARD}"] [data-slot="tug-prompt-entry"]');
            return entry !== null && entry.getAttribute("data-phase") !== "streaming";
          })()`,
          { timeoutMs: TURN_MS },
        );

        await page.evalJS<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(COMPOSER)});
            if (el === null) return false;
            el.focus();
            return document.execCommand("insertText", false, ${JSON.stringify(`${GLYPH}S`)});
          })()`,
        );

        // The face loads when layout first asks for the glyph, which is the production path.
        for (const selector of [TRANSCRIPT, COMPOSER]) {
          await page.waitForCondition<boolean>(
            `(function(){ var f = ${readFacts(selector)}; return f.found && f.loaded; })()`,
            { timeoutMs: 3_000 },
          );
        }

        holdFacts("transcript", await page.evalJS<GlyphFacts>(readFacts(TRANSCRIPT)));
        holdFacts("composer", await page.evalJS<GlyphFacts>(readFacts(COMPOSER)));

        const themeEditorFamily = await page.evalJS<string>(
          `getComputedStyle(document.body).getPropertyValue("--tug-font-family-editor")`,
        );
        expect(themeEditorFamily.trim(), "the theme's editor token").toStartWith('"Tug Keys Mono"');

        await app.evalJS(`window.__tug.dispatchControlAction("show-keyboard-shortcuts", {})`);
        await waitForBodyPainted(app, "keyboard");
        const keymap = kindBody(app, "keyboard");
        await keymap.type('[data-testid="settings-keymap-filter"] input', "Zoom Out");
        await keymap.waitForCondition<boolean>(
          `(function(){ var f = ${readFacts(KEYMAP_CHIP)}; return f.found && f.loaded; })()`,
          { timeoutMs: 8_000 },
        );
        holdFacts("keymap chip", await keymap.evalJS<GlyphFacts>(readFacts(KEYMAP_CHIP)));
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});
