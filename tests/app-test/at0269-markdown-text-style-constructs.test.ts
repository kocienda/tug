/**
 * at0269-markdown-text-style-constructs — the markdown text styling
 * constructs that only a live app can prove.
 *
 * The unit suite covers which characters form which runs and which runs share
 * a class. What it cannot see is the appearance those classes resolve to, so
 * this test reads **computed** styles out of the running app:
 *
 *   1. A strikethrough body computes `text-decoration-line: line-through`.
 *   2. A hard break's two trailing spaces compute a non-transparent
 *      `background-color` — the scheme's one non-textual affordance, and the
 *      only construct with no glyphs to carry its own signal.
 *   3. Inline code computes a mono `font-family`, distinct from the prose
 *      around it.
 *   4. A blockquote body computes a color distinct from plain prose.
 *   5. A fenced block's body is tokenized by its declared grammar (the `const`
 *      keyword carries a color the fence's other text does not).
 *   6. Every raw marker is still in the document — the scheme's whole premise.
 *   7. Typing `<div>` inserts no closing tag: `autoCloseTags` is off, because
 *      auto-closing is an editing behavior and this capability styles only.
 *
 * Surface: `gallery-prompt-entry` (composes the real `TugPromptEntry`), so no
 * live Claude session is needed. Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * Foreground: ⌘A is an Edit-menu key equivalent, so AppKit resolves it
 * against the main menu before the web view sees a keydown. A background
 * instance has no key window for that resolution to land in, and the
 * select-all that clears the editor between cases never happens.
 *
 * @foreground
 *
 * @covers tugdeck/src/lib/markdown-text-styling.ts
 * @covers tugdeck/src/lib/markdown-text-style-grammar.ts
 * @covers tugdeck/src/lib/language-registry.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 90_000;

const EDITOR_SELECTOR = '[data-slot="tug-text-editor"] .cm-content';
const CONTENT_SELECTOR = `[data-card-id="A"] ${EDITOR_SELECTOR}`;

// Unique needles so a TreeWalker lands on exactly one token run.
const PLAIN = "plainQ";
const STRUCK = "struckZ";
const QUOTED = "quotedZ";
const CODE = "codeZ";

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-prompt-entry", title: "Prompt A", closable: true },
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
}

async function focusEditor(app: App): Promise<void> {
  await app.body("A").nativeClickAtElement(CONTENT_SELECTOR);
  await app.body("A").waitForCondition<boolean>(
    `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(CONTENT_SELECTOR)})`,
    { timeoutMs: 2000 },
  );
  await new Promise((r) => setTimeout(r, 100));
}

async function typeChunked(app: App, text: string): Promise<void> {
  const TYPING_CHUNK_SIZE = 8;
  const TYPING_CHUNK_DELAY_MS = 60;
  for (let offset = 0; offset < text.length; offset += TYPING_CHUNK_SIZE) {
    await app.nativeType(text.slice(offset, offset + TYPING_CHUNK_SIZE));
    await new Promise((r) => setTimeout(r, TYPING_CHUNK_DELAY_MS));
  }
}

interface RunStyle {
  color: string;
  backgroundColor: string;
  fontFamily: string;
  textDecorationLine: string;
}

/**
 * Computed style of the innermost element inside `.cm-content` whose text
 * contains `needle`. Null before the grammar resolves and the spans mint.
 */
async function runStyle(app: App, needle: string): Promise<RunStyle | null> {
  return app.body("A").evalJS<RunStyle | null>(
    `(function(){
      var content = document.querySelector(${JSON.stringify(CONTENT_SELECTOR)});
      if (!content) return null;
      var walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode())) {
        if (node.textContent.indexOf(${JSON.stringify(needle)}) !== -1) {
          var el = node.parentElement;
          if (!el) return null;
          var cs = getComputedStyle(el);
          return {
            color: cs.color,
            backgroundColor: cs.backgroundColor,
            fontFamily: cs.fontFamily,
            textDecorationLine: cs.textDecorationLine
          };
        }
      }
      return null;
    })()`,
  );
}

/**
 * Computed background of the run holding the hard break's trailing spaces:
 * the last styled span on the line whose text ends with two spaces. Matched
 * by exact whitespace content rather than by a needle, since the construct
 * has no glyphs.
 */
async function hardBreakBackground(app: App): Promise<string | null> {
  return app.body("A").evalJS<string | null>(
    `(function(){
      var content = document.querySelector(${JSON.stringify(CONTENT_SELECTOR)});
      if (!content) return null;
      var lines = content.querySelectorAll(".cm-line");
      for (var i = 0; i < lines.length; i++) {
        var spans = lines[i].querySelectorAll("span");
        for (var j = 0; j < spans.length; j++) {
          if (spans[j].textContent === "  ") {
            return getComputedStyle(spans[j]).backgroundColor;
          }
        }
      }
      return null;
    })()`,
  );
}

/** Live document text straight from the engine. */
async function docText(app: App): Promise<string | null> {
  return app.body("A").evalJS<string | null>(
    `(function(){
      var s = window.__tug.getEmCardState("A");
      return s !== null && typeof s.text === "string" ? s.text : null;
    })()`,
  );
}

/** A color that paints nothing — WebKit reports either form for "no fill". */
function isTransparent(color: string): boolean {
  const normalized = color.replace(/\s/g, "");
  return normalized === "transparent" || normalized === "rgba(0,0,0,0)";
}

describe.skipIf(!SHOULD_RUN)("at0269: markdown text style constructs", () => {
  test(
    "computed styles for quote, rule, strike, hard break, code face, fence grammar",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);

        const app = await launchTugApp({
          testName: "at0269-markdown-text-style-constructs",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
          foreground: true,
        });

        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: deckShape(),
            cardStates: {},
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.awaitEngineReady("A");
          await focusEditor(app);

          // A document carrying each construct on its own line. The hard break
          // is the two spaces after PLAIN.
          await typeChunked(app, `${PLAIN}  `);
          await app.nativeKey("Return");
          await typeChunked(app, `~~${STRUCK}~~ and \`${CODE}\``);
          await app.nativeKey("Return");
          await app.nativeKey("Return");
          await typeChunked(app, `> ${QUOTED}`);

          // The grammar resolves through the substrate's effect; wait until
          // the struck run actually paints its decoration.
          await app.body("A").waitForCondition<boolean>(
            `(function(){
              var content = document.querySelector(${JSON.stringify(CONTENT_SELECTOR)});
              if (!content) return false;
              var walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
              var node;
              while ((node = walker.nextNode())) {
                if (node.textContent.indexOf(${JSON.stringify(STRUCK)}) !== -1) {
                  var d = getComputedStyle(node.parentElement).textDecorationLine;
                  return d.indexOf("line-through") !== -1;
                }
              }
              return false;
            })()`,
            { timeoutMs: 8000 },
          );

          const plain = await runStyle(app, PLAIN);
          const struck = await runStyle(app, STRUCK);
          const quoted = await runStyle(app, QUOTED);
          const code = await runStyle(app, CODE);

          expect(plain, "plain baseline run found").not.toBeNull();

          // 1. Strikethrough is a decoration, and only a decoration.
          expect(struck!.textDecorationLine).toContain("line-through");

          // 2. The hard break's two spaces carry a visible tint.
          const hardBreakBg = await hardBreakBackground(app);
          expect(hardBreakBg, "hard-break run found").not.toBeNull();
          expect(
            isTransparent(hardBreakBg!),
            "hard-break tint is painted, not transparent",
          ).toBe(false);

          // 3. Inline code reads in a code face. The prompt entry's resting
          // face is already mono, where the treatment is correctly a visual
          // no-op, so put a proportional face on the content and confirm the
          // code run keeps the mono stack while the prose beside it follows
          // the host — the cascade this treatment exists for.
          expect(code!.fontFamily.toLowerCase()).toContain("mono");
          await app.body("A").evalJS<boolean>(
            `(function(){
              var content = document.querySelector(${JSON.stringify(CONTENT_SELECTOR)});
              if (!content) return false;
              content.style.fontFamily = '"IBM Plex Sans", sans-serif';
              return true;
            })()`,
          );
          await new Promise((r) => setTimeout(r, 200));
          const plainSans = await runStyle(app, PLAIN);
          const codeSans = await runStyle(app, CODE);
          expect(plainSans!.fontFamily.toLowerCase()).toContain("sans");
          expect(codeSans!.fontFamily.toLowerCase()).toContain("mono");
          expect(codeSans!.fontFamily).not.toBe(plainSans!.fontFamily);
          await app.body("A").evalJS<boolean>(
            `(function(){
              var content = document.querySelector(${JSON.stringify(CONTENT_SELECTOR)});
              if (content) content.style.fontFamily = "";
              return true;
            })()`,
          );

          // 4. A blockquote body is toned apart from plain prose.
          expect(quoted!.color).not.toBe(plain!.color);

          // 6. Every raw marker is still in the document — nothing was folded,
          // concealed, or substituted, including the hard break's spaces.
          const doc = await docText(app);
          expect(doc).toContain(`~~${STRUCK}~~`);
          expect(doc).toContain(`\`${CODE}\``);
          expect(doc).toContain(`> ${QUOTED}`);
          expect(doc).toContain(`${PLAIN}  \n`);

          // 5. A fence body is tokenized by the grammar it declares.
          await focusEditor(app);
          await app.nativeKey("a", ["cmd"]);
          await app.nativeKey("Delete");
          await app.body("A").waitForCondition<boolean>(
            `(function(){ var s = window.__tug.getEmCardState("A"); return s !== null && s.text === ""; })()`,
            { timeoutMs: 2000 },
          );
          await typeChunked(app, "```ts");
          await app.nativeKey("Return");
          await typeChunked(app, "const fencedZ = 1;");
          await app.body("A").waitForCondition<boolean>(
            `(function(){
              var content = document.querySelector(${JSON.stringify(CONTENT_SELECTOR)});
              if (!content) return false;
              var spans = content.querySelectorAll(".cm-line span");
              for (var i = 0; i < spans.length; i++) {
                if (spans[i].textContent === "const") return true;
              }
              return false;
            })()`,
            { timeoutMs: 10000 },
          );
          const keyword = await runStyle(app, "const");
          const identifier = await runStyle(app, "fencedZ");
          expect(keyword, "fence keyword run found").not.toBeNull();
          expect(identifier, "fence identifier run found").not.toBeNull();
          expect(
            keyword!.color,
            "the fence body is tokenized, not flat",
          ).not.toBe(identifier!.color);
          // The fence body reads in a code face even when inner-highlighted.
          expect(keyword!.fontFamily.toLowerCase()).toContain("mono");

          // 7. Styling only: typing an HTML tag auto-closes nothing.
          await focusEditor(app);
          await app.nativeKey("a", ["cmd"]);
          await app.nativeKey("Delete");
          await app.body("A").waitForCondition<boolean>(
            `(function(){ var s = window.__tug.getEmCardState("A"); return s !== null && s.text === ""; })()`,
            { timeoutMs: 2000 },
          );
          await typeChunked(app, "<div>");
          await new Promise((r) => setTimeout(r, 400));
          const afterTag = await docText(app);
          expect(afterTag, "no closing tag is inserted").toBe("<div>");
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
