/**
 * at0366-overview-copy.test.ts — the Overview's COPY reconstructs markdown.
 *
 * A Overview post is markdown now, rendered by the Session transcript's own
 * `TugMarkdownBlock`, so a selection across it has to come back as the
 * markdown that produced it rather than as the words a reader sees. That is
 * what `resolveCopyMarkdown` buys: `selectionToTranscriptMarkdown` walks the
 * rendered DOM and rebuilds the source, and `useTranscriptCellMenu` writes
 * both clipboard flavors off it — `text/plain` carrying the markdown,
 * `text/html` carrying that markdown re-rendered.
 *
 * Driven through the row's own Copy: a right-click over the selection opens
 * the cell's context menu, and its Copy item dispatches to the cell by
 * `parentId` — the targeted path, which is why it lands on the cell's
 * handler regardless of which responder holds the keyboard. Everything from
 * the menu item down is production: `handleCopy`, the resolver, the
 * two-flavor `ClipboardItem` write. The clipboard itself is captured by
 * replacing `write`/`writeText` in the page, which is at0188's technique.
 *
 * A second test covers the other half of the same claim, on a **placed**
 * value rather than written prose: a commit in a post's `refs` array renders
 * as the read-only atom labelled `Commit <8>`, and plain copy — which reads
 * the DOM's text with no annotation awareness — has to yield that same one
 * spelling. Two spellings of one atom on the clipboard is the arbitrariness
 * this presentation work retires, resurfacing in paste.
 *
 * ⌘C is deliberately NOT the vehicle. Its chord is Edit ▸ Copy's key
 * equivalent, resolved by AppKit against the main menu and delivered to the
 * first responder — and at rest in the Overview that is the composer's editor,
 * not the post under the pointer. The menu is the gesture a reader actually
 * has for copying a post, so it is the one asserted here.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/lib/markdown/serialize-selection.ts
 * @covers tugdeck/src/lib/copy-as-plain-text.ts
 * @covers tugdeck/src/components/tugways/tug-atom-ref.tsx
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

/** This checkout — the post's `project_dir`, so the ref resolves for real. */
const REPO_ROOT = resolve(import.meta.dir, "../..");

/** Its HEAD — a sha `git show` genuinely answers for. */
const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO_ROOT })
  .toString()
  .trim();
const TEST_TIMEOUT_MS = 90_000;

const CARD = '[data-testid="overview-card"]';
const BODY = `${CARD} .overview-post-body`;
const COPY_ITEM = '[data-slot="tug-editor-context-menu"] [data-item-action="copy"]';

/**
 * Capture both clipboard paths — the dual-format `clipboard.write`
 * (`ClipboardItem` with text/plain + text/html, which is the markdown path)
 * and the `writeText` fallback. `window.__copied` holds the latest
 * text/plain; `window.__copiedHtml` the latest text/html.
 */
const INSTALL_CLIPBOARD_CAPTURE = `(function(){
  window.__copied = [];
  window.__copiedHtml = [];
  var writeTextSink = function(t){ window.__copied.push(String(t)); return Promise.resolve(); };
  var writeSink = function(items){
    try {
      var arr = items || [];
      for (var i = 0; i < arr.length; i++){
        (function(item){
          var types = item.types || [];
          if (types.indexOf("text/plain") !== -1){
            item.getType("text/plain").then(function(b){ return b.text(); }).then(function(t){ window.__copied.push(String(t)); });
          }
          if (types.indexOf("text/html") !== -1){
            item.getType("text/html").then(function(b){ return b.text(); }).then(function(t){ window.__copiedHtml.push(String(t)); });
          }
        })(arr[i]);
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve();
  };
  try { navigator.clipboard.writeText = writeTextSink; }
  catch (e) { Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: writeTextSink }); }
  try { navigator.clipboard.write = writeSink; }
  catch (e) { Object.defineProperty(navigator.clipboard, "write", { configurable: true, value: writeSink }); }
  return typeof navigator.clipboard.write === "function" && typeof ClipboardItem !== "undefined";
})()`;

/** Select the whole text node whose trimmed content is exactly `exact`. */
function selectExactNodeScript(exact: string): string {
  return `(function(){
    var root = document.querySelector(${JSON.stringify(BODY)});
    if (root === null) return "__NO_BODY__";
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (var n = w.nextNode(); n !== null; n = w.nextNode()){
      if ((n.textContent || "").trim() === ${JSON.stringify(exact)}){
        var range = document.createRange();
        range.setStart(n, 0); range.setEnd(n, (n.textContent || "").length);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        return range.toString();
      }
    }
    return "__NOT_FOUND__";
  })()`;
}

/** Select the whole rendered block — bold, code, and the prose between. */
const SELECT_WHOLE_BLOCK = `(function(){
  var block = document.querySelector(${JSON.stringify(`${BODY} .tugx-md-block`)});
  if (block === null) return "__NO_BLOCK__";
  var range = document.createRange();
  range.selectNodeContents(block);
  var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  return range.toString();
})()`;

/**
 * Open the cell's context menu over the current selection — the production
 * `contextmenu` pipeline, entered with a real event at the selection's own
 * corner so `extraEntries` samples the same place the reader right-clicked.
 */
const OPEN_MENU_OVER_SELECTION = `(function(){
  var sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0) return "__NO_SELECTION__";
  var rect = sel.getRangeAt(0).getBoundingClientRect();
  var x = Math.round(rect.left + rect.width / 2);
  var y = Math.round(rect.top + rect.height / 2);
  var target = document.elementFromPoint(x, y);
  if (target === null) return "__NO_TARGET__";
  target.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2,
  }));
  return "ok";
})()`;

describe.skipIf(!SHOULD_RUN)("at0366 — the Overview copies markdown", () => {
  test(
    "the row's Copy reconstructs a selection's markdown, in two clipboard flavors",
    async () => {
      const app = await launchTugApp({ testName: "at0366-overview-copy" });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // One post, carrying the two constructs whose markdown a reader can
        // never see: bold, whose markers are not text, and a code span,
        // whose backticks the renderer consumed.
        const post = {
          id: 9101,
          at_ms: 1_754_600_000_000,
          author: "observer",
          body: "Rebuilt the **imposer** pass in `layout-imposer.ts` today.",
          refs: [],
        };
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
          ),
        ).toBe(true);

        await app.waitForCondition<boolean>(
          `(function(){
            var strong = document.querySelector(${JSON.stringify(`${BODY} strong`)});
            var code = document.querySelector(${JSON.stringify(`${BODY} code`)});
            return strong !== null && code !== null;
          })()`,
          { timeoutMs: 10_000 },
        );

        expect(await app.evalJS<boolean>(INSTALL_CLIPBOARD_CAPTURE)).toBe(true);

        // ---- the construct alone: bold keeps its markers ----
        expect(await app.evalJS<string>(selectExactNodeScript("imposer"))).toBe(
          "imposer",
        );
        const bold = await copyAndRead(app);
        note("copied bold", JSON.stringify(bold));
        expect(bold.plain).toBe("**imposer**");

        // ---- the whole block: both constructs, and the html flavor ----
        const rendered = await app.evalJS<string>(SELECT_WHOLE_BLOCK);
        expect(rendered).toContain("imposer");
        // The reader's text carries neither construct's syntax.
        expect(rendered).not.toContain("**");
        expect(rendered).not.toContain("`");

        const whole = await copyAndRead(app);
        note("copied block", JSON.stringify(whole));
        // …but the clipboard's plain flavor is the markdown source.
        expect(whole.plain).toContain("**imposer**");
        expect(whole.plain).toContain("`layout-imposer.ts`");
        // And the html flavor is that markdown re-rendered, so a rich paste
        // target gets the styling rather than the syntax.
        expect(whole.html).not.toBeNull();
        expect(whole.html!).toContain("<strong>imposer</strong>");
        expect(whole.html!).toContain("<code>layout-imposer.ts</code>");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a placed commit has one spelling — what the row shows is what a selection carries",
    async () => {
      const app = await launchTugApp({ testName: "at0366-overview-copy-commit" });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // A post whose prose never names the sha, so the ref survives
        // `unmentionedRefs` and rides the trailing strip as a placed atom.
        const post = {
          id: 9102,
          at_ms: 1_754_600_000_000,
          author: "observer",
          body: "Landed the sticky-header fixes.",
          refs: [{ kind: "commit", target: HEAD_SHA }],
          project_dir: REPO_ROOT,
        };
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
          ),
        ).toBe(true);

        const REF = `${CARD} .overview-post-refs .tug-atom-ref`;
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(REF)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // What the row SHOWS. The word is in the label because an atom has no
        // sentence around it to supply one.
        const shown = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(REF)}).textContent || "").trim()`,
        );
        note("commit atom label", shown);
        expect(shown).toBe(`Commit ${HEAD_SHA.slice(0, 8)}`);
        // Not the old colon spelling — that is the drift this retires.
        expect(shown).not.toContain("Commit:");

        // What the CLIPBOARD gets, asserted at the range rather than through
        // the cell menu. `copy-as-plain-text` has no annotation awareness — it
        // writes the selection's own text — so a range's `toString()` over the
        // refs row IS the plain flavor, and asserting it here pins the
        // convergence without also dragging in the cell menu, which is the
        // *prose* row's gesture and is covered by the test above.
        const selected = await app.evalJS<string>(
          `(function(){
            var row = document.querySelector(${JSON.stringify(`${CARD} .overview-post-refs`)});
            if (row === null) return "__NO_ROW__";
            var range = document.createRange();
            range.selectNodeContents(row);
            return range.toString();
          })()`,
        );
        note("refs row selection text", selected);
        expect(selected).toContain(`Commit ${HEAD_SHA.slice(0, 8)}`);
        expect(selected).not.toContain("Commit:");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/** Right-click ▸ Copy over the current selection, then the flavors written. */
async function copyAndRead(
  app: Awaited<ReturnType<typeof launchTugApp>>,
): Promise<{ plain: string; html: string | null }> {
  await app.evalJS<unknown>(`(window.__copied = [], window.__copiedHtml = [], true)`);
  // A menu left open from a previous copy would swallow the next
  // right-click — `elementFromPoint` would answer with the overlay rather
  // than the prose under it.
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-slot="tug-editor-context-menu"]') === null`,
    { timeoutMs: 5_000 },
  );
  note(
    "selection before copy",
    await app.evalJS<string>(`String(window.getSelection())`),
  );
  expect(await app.evalJS<string>(OPEN_MENU_OVER_SELECTION)).toBe("ok");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(COPY_ITEM)}) !== null`,
    { timeoutMs: 5_000 },
  );
  // The item activates on mousedown (so the browser never shifts focus and
  // the selection stays live) — a real click is what delivers it.
  await app.nativeClickAtElement(COPY_ITEM);
  await app.waitForCondition<boolean>(
    `Array.isArray(window.__copied) && window.__copied.length > 0`,
    { timeoutMs: 5_000 },
  );
  return app.evalJS<{ plain: string; html: string | null }>(
    `(function(){
      return {
        plain: window.__copied[window.__copied.length - 1],
        html: window.__copiedHtml.length > 0
          ? window.__copiedHtml[window.__copiedHtml.length - 1]
          : null,
      };
    })()`,
  );
}
