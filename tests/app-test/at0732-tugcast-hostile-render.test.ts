/**
 * at0732-tugcast-hostile-render.test.ts — a hostile turn streamed through
 * tugcast's renderer into the real WebKit, held to the sanitizer's invariant
 * on the live DOM.
 *
 * The unit tests hold each sanitizer to the invariant with a parser that is
 * not WebKit's: html5ever on tugcast's side, jsdom on the page's. This file
 * is the one that counts, because the parser that matters is the one the
 * row's `innerHTML` write runs. It streams one stubbed turn
 * (`streaming-stub-fixture.ts`) whose messages are hostile: hand-written
 * markdown and HTML that reach for each hole a sanitizer miss would open,
 * and a quarter of DOMPurify's own regression payloads
 * (`tugdeck/crates/tugmark/corpus/dompurify/payloads.json`). Every partial
 * text of every message is rendered by tugcast, so the half-typed tags a
 * stream produces are cases too.
 *
 * - While the turn streams, an observer on the card checks every element
 *   that lands in a content block, and every attribute written to one: no
 *   script-capable element, no event-handler attribute, no URL attribute
 *   naming an unsafe scheme. These hold with no exception for the page's own
 *   enhancers, whose chrome is inside the blocks too. And no Content
 *   Security Policy violation fires on the page.
 * - When the turn ends, each row draws from a current tugcast record and no
 *   row of the turn parsed on the page, so what was checked is tugcast's
 *   render as it sent it; WebKit's own parse of each record's HTML holds
 *   the whole invariant (`sanitize-invariant-check.ts`): allow-listed
 *   elements and attributes, safe schemes, no `data-`/`aria-`, and the
 *   post-sanitize vocabulary only in its own shapes.
 *
 * @covers tugdeck/src/lib/markdown/sanitize-allowlist.json
 * @covers tugdeck/src/lib/markdown/render-incremental.ts
 * @covers tugdeck/src/lib/markdown/rendered-record.ts
 * @covers tugdeck/src/lib/code-session-store.ts
 * @covers tugdeck/src/lib/ingest/rendered-merge.ts
 * @covers tugdeck/src/test-surface.ts
 * @covers tugdeck/crates/tugmark/src/sanitize.rs
 * @covers tugdeck/crates/tugmark/src/render.rs
 * @covers tugdeck/index.html
 * @covers tugrust/crates/tugcast/src/feeds/render_bridge.rs
 * @covers tugrust/crates/tugcast/src/feeds/render_stage.rs
 * @covers tests/app-test/streaming-stub-fixture.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { SHOULD_RUN, blobFor, launch } from "./settle-frames-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, bindStreamingStubs, startStreams, stubDirectory } from "./streaming-stub-fixture";
import {
  SAFE_SCHEMES,
  type ElementSeen,
  violationsIn,
} from "../../tugdeck/src/lib/markdown/__tests__/sanitize-invariant-check";

const TEST_NAME = "at0732-tugcast-hostile-render";
const CARD = "at0622-c1";

/** How long the turn may take to stream and end, at a word per 25 ms. */
const TURN_MS = 120_000;

/** Past both of the engine's finishers, so a late `null` would have landed. */
const AFTER_TURN_MS = 1_000;

/**
 * Every eighth of DOMPurify's payloads: a cross-section that streams in
 * seconds. At `STREAM_PACE_MS` a word, every fourth ran the file past its
 * 20 s budget, and the whole set is held natively by `tugmark_invariant`.
 */
const PAYLOAD_STRIDE = 8;

/** Hand-written: each line reaches for one hole a sanitizer miss would open. */
const HOSTILE = [
  "## A hostile reply",
  "",
  'Prose with <img src=x onerror="alert(1)"> an image handler and <svg onload=alert(1)><circle r=1></circle></svg> an svg.',
  "",
  "<script>alert(1)</script>",
  "",
  "[a javascript link](javascript:alert(1)) and [a spaced one](  JaVaScRiPt:alert(1)) and <javascript:alert(1)>",
  "",
  '<a href="jav&#x09;ascript:alert(1)">an entity-split scheme</a> <a href="&#14;javascript:alert(1)">a control-led one</a>',
  "",
  "![an image](javascript:alert(1)) ![a data image](data:image/png;base64,AAAA)",
  "",
  '<iframe srcdoc="<script>alert(1)</script>"></iframe><object data=javascript:alert(1)></object><embed src=javascript:alert(1)>',
  "",
  "<form action=javascript:alert(1)><button formaction=javascript:alert(1)>x</button></form>",
  "",
  "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
  "",
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  "",
  '<span class="tug-syn-keyword" onclick=alert(1)>a forged highlight run</span> and <span>a bare span</span>',
  "",
  '<div class="tugx-katex" data-tugx-math="display" data-tugx-math-pending="true">x^2</div>',
  "",
  '<p class="tugx-chart" data-tugx-chart-pending="true">a forged chart placeholder</p>',
  "",
  '<details open ontoggle=alert(1)><summary>s</summary></details><base href=javascript:alert(1)//><meta http-equiv=refresh content="0;url=javascript:alert(1)">',
  "",
  "<template><script>alert(1)</script></template><xmp><img src=x onerror=alert(1)></xmp>",
  "",
  "A table:",
  "",
  "| a | b |",
  "|---|---|",
  '| <img src=x onerror=alert(1)> | <a href="javascript:alert(1)">x</a> |',
  "",
  "Math stays math: $x < y$.",
  "",
].join("\n");

function payloadText(): string {
  const path = join(import.meta.dir, "../../tugdeck/crates/tugmark/corpus/dompurify/payloads.json");
  const { cases } = JSON.parse(readFileSync(path, "utf8")) as { cases: { payload: string }[] };
  return cases
    .filter((_, i) => i % PAYLOAD_STRIDE === 0)
    .map((c) => c.payload)
    .join("\n\n");
}

/**
 * The page-side watch, installed before the turn streams: an observer on the
 * card that checks each element landing in a content block, and a listener
 * for Content Security Policy violations. Findings collect on
 * `window.__at0732`.
 */
function watchScript(): string {
  return `(function(){
    var SAFE = ${JSON.stringify([...SAFE_SCHEMES])};
    var BANNED = ["script","iframe","frame","frameset","object","embed","applet","base","meta","link","form","portal"];
    var URL_ATTRS = ["href","src","xlink:href"];
    var NEVER_ATTRS = ["srcdoc","action","formaction","ping","background","poster"];
    var watch = { checked: 0, violations: [], csp: [] };
    window.__at0732 = watch;
    function scheme(value) {
      var s = value.replace(/^[\\x00-\\x20]+|[\\x00-\\x20]+$/g, "").replace(/[\\t\\n\\r]/g, "");
      var m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
      return m ? m[1].toLowerCase() : null;
    }
    function report(line) {
      if (watch.violations.length < 50) watch.violations.push(line);
    }
    function check(el) {
      if (!el.closest || el.closest("[data-content-hash]") === null) return;
      watch.checked += 1;
      var tag = el.localName.toLowerCase();
      if (BANNED.indexOf(tag) >= 0) report("element <" + tag + ">");
      if (tag === "style") report("element <style>");
      for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i];
        var name = a.name.toLowerCase();
        if (name.indexOf("on") === 0) report("attribute " + name + " on <" + tag + ">");
        if (NEVER_ATTRS.indexOf(name) >= 0) report("attribute " + name + " on <" + tag + ">");
        if (URL_ATTRS.indexOf(name) >= 0) {
          var s = scheme(a.value);
          var ok = s === null || SAFE.indexOf(s) >= 0 || (s === "data" && tag === "img" && name === "src");
          if (!ok) report("url " + name + "=" + JSON.stringify(a.value) + " on <" + tag + ">");
        }
      }
    }
    function sweep(node) {
      if (node.nodeType !== 1) return;
      check(node);
      var all = node.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) check(all[i]);
    }
    new MutationObserver(function (records) {
      for (var r = 0; r < records.length; r++) {
        var rec = records[r];
        if (rec.type === "attributes") check(rec.target);
        for (var n = 0; n < rec.addedNodes.length; n++) sweep(rec.addedNodes[n]);
      }
    }).observe(document.querySelector('[data-card-id="${CARD}"]'), { subtree: true, childList: true, attributes: true });
    document.addEventListener("securitypolicyviolation", function (e) {
      watch.csp.push(e.violatedDirective + " " + e.blockedURI + " " + (e.sample || ""));
    });
    watch.sweep = function () { sweep(document.querySelector('[data-card-id="${CARD}"]')); };
    return true;
  })()`;
}

interface Watch {
  checked: number;
  violations: string[];
  csp: string[];
}

interface RowFacts {
  messageKey: string;
  rendered: string;
  streaming: boolean | null;
  current: boolean | null;
  recordHtml: string[] | null;
}

describe.skipIf(!SHOULD_RUN)("at0732 — a hostile turn through tugcast's renderer into the real WebKit", () => {
  test(
    "nothing a sanitizer miss would carry reaches the live DOM, and WebKit's parse holds the invariant",
    async () => {
      const texts = [HOSTILE, payloadText()];
      const stubDir = stubDirectory();
      const { app, tugbankPath } = await launch(1, blobFor(1), TEST_NAME, {
        resumeCards: [],
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        const stubs = await bindStreamingStubs(app, [CARD], stubDir, texts.length, 1, (i) => texts[i]);
        // The card's blocks land in its own page, which has its own
        // `window.__tug`: the watch, the sweep, the row reads and the reparse
        // all run there. The shell holds only the card's placeholder.
        const page = app.body(CARD);
        expect(await page.evalJS<boolean>(watchScript())).toBe(true);
        await startStreams(app, stubs);
        await app.body(CARD).waitForCondition<boolean>(
          `(function(){
            var entry = document.querySelector('[data-card-id="${CARD}"] [data-slot="tug-prompt-entry"]');
            return entry !== null && entry.getAttribute("data-phase") !== "streaming";
          })()`,
          { timeoutMs: TURN_MS },
        );
        await Bun.sleep(AFTER_TURN_MS);

        // The live DOM, through the stream and at its end.
        await page.evalJS<null>("(window.__at0732.sweep(), null)");
        const watch = await page.evalJS<Watch>(
          "({ checked: window.__at0732.checked, violations: window.__at0732.violations, csp: window.__at0732.csp })",
        );
        note(
          `at0732 live DOM: ${watch.checked} element checks, ` +
            `${watch.violations.length} violations, ${watch.csp.length} CSP reports`,
        );
        expect(watch.checked, "the observer saw the turn's blocks land").toBeGreaterThan(100);
        expect(watch.violations, "nothing script-capable landed in a block").toEqual([]);
        expect(watch.csp, "no Content Security Policy violation").toEqual([]);

        // What was checked is tugcast's render, not the page's parse.
        const parses = await page.evalJS<{ byIdentity: Record<string, number> }>("window.__tug.rowParsesByIdentity()");
        const turnParses = Object.entries(parses.byIdentity).filter(([id]) => id.includes(".message.stub-msg-"));
        expect(turnParses, "no row of the turn parsed on the page").toEqual([]);

        await page.evalJS<null>(
          `(window.__at0732rows = undefined,
            window.__tug.renderedRows(${JSON.stringify(CARD)}).then(function (r) {
              window.__at0732rows = JSON.stringify(r);
            }),
            null)`,
        );
        await page.waitForCondition<boolean>("window.__at0732rows !== undefined", { timeoutMs: 8_000 });
        const rows = (JSON.parse(await page.evalJS<string>("window.__at0732rows")) as RowFacts[] | null) ?? [];
        expect(rows.map((r) => r.messageKey)).toEqual(texts.map((_, i) => `stub-msg-${i}-b0`));
        for (const row of rows) {
          expect({ key: row.messageKey, rendered: row.rendered, streaming: row.streaming, current: row.current }).toEqual({
            key: row.messageKey,
            rendered: "record",
            streaming: false,
            current: true,
          });
        }

        // WebKit's own parse of each record, in the live document, held to the whole invariant.
        const html = rows.flatMap((r) => r.recordHtml ?? []);
        expect(html.length, "the records carry blocks").toBeGreaterThan(20);
        const parsed = await page.evalJS<ElementSeen[][]>(`(function(){
          var htmls = ${JSON.stringify(html)};
          return htmls.map(function (h) {
            var box = document.createElement("div");
            box.innerHTML = h;
            return Array.from(box.querySelectorAll("*")).map(function (el) {
              return {
                tag: el.localName.toLowerCase(),
                attrs: Array.from(el.attributes).map(function (a) { return [a.name, a.value]; }),
              };
            });
          });
        })()`);
        const failures = parsed.flatMap((elements, i) => violationsIn(elements).map((v) => `block ${i}: ${v}`));
        note(`at0732 WebKit reparse: ${html.length} blocks, ${parsed.flat().length} elements`);
        expect(failures).toEqual([]);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});
