/**
 * at0670-folded-text-card.test.ts — a Text card folds to the shared tier, its
 * slit shows where the reader was, and a wall packs it beside a Session card.
 *
 * ## What this gates
 *
 * The fold is the pane's, not the Session card's ([D185]): every content card
 * folds to its masthead and a slit of its own content at one shared tier, by
 * the one `toggle-card-fold` command. A Text card is the case that proves it,
 * because it is the card the fold was not written for.
 *
 *   1. **⌃⌘Y folds a Text key card, and the frame stands at the tier.** The
 *      chord reaches the command through the native menu, with the keyboard
 *      in the Text card's editor — no Session card anywhere on the deck.
 *   2. **The slit is the reader's place.** The editor is scrolled away from
 *      its top before the fold; the first line visible in the folded slit is
 *      the line that was first visible open, and it is still first after the
 *      unfold. The body folds rather than unmounts, so its scroll survives.
 *   3. **Return on the glyph unfolds.** While folded the keyboard rests on the
 *      title bar's fold glyph, the card's Return-home, and a real Return there
 *      opens the card and hands the caret back to the editor.
 *   4. **A wall holds both kinds.** One Session card and one Text card in a
 *      split column, both folded, each stand at the tier and pack at the top
 *      of the run with the imposition's seam between them.
 *
 * at0669 covers what a folded Text card does with the surfaces it is asked
 * for; this file covers the form itself.
 *
 * @covers tugdeck/src/card-registry.ts
 * @covers tugdeck/src/lib/folded-body.ts
 * @covers tugdeck/src/components/chrome/card-fold-glyph.tsx
 * @covers tugdeck/src/components/chrome/card-host.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card.css
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 150_000;

/**
 * `FOLDED_CARD_HEIGHT_PX` from `card-registry.ts`, duplicated rather than
 * imported: an app-test drives the BUILT app, and importing the constant
 * would assert the source against itself.
 */
const FOLDED_CARD_HEIGHT_PX = 145;

/** The imposition's seam between column members (`lib/layout-imposer.ts`). */
const GAP = 5;

const BODY =
  Array.from({ length: 80 }, (_, i) => `fixture line ${String(i + 1).padStart(2, "0")}`).join("\n") +
  "\n";

const T_HOST = '[data-card-host][data-card-id="T"]';
const T_SCROLLER = '[data-card-id="T"] [data-slot="tug-text-card-editor"] .cm-scroller';
const T_EDITOR = '[data-card-id="T"] [data-slot="tug-text-card-editor"] .cm-content';
const GLYPH = '[data-testid="tug-pane-title-bar-fold-glyph"]';

const wait = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

function mkFixture(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0670-"));
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, BODY, "utf8");
  return { dir, file };
}

function frame(paneId: string): string {
  return `.tug-pane[data-pane-id="${paneId}"]`;
}

/**
 * The text of the first editor line whose box reaches below the top of what
 * the reader can see — the scroller's top, or the frame's, whichever is lower
 * — and whose top is above the frame's bottom. `""` when no line is visible.
 */
const FIRST_VISIBLE = `(function () {
  var scroller = document.querySelector(${JSON.stringify(T_SCROLLER)});
  var fr = document.querySelector(${JSON.stringify(frame("pT"))}).getBoundingClientRect();
  if (scroller === null) return "";
  var top = Math.max(scroller.getBoundingClientRect().top, fr.top);
  var lines = scroller.querySelectorAll(".cm-line");
  for (var i = 0; i < lines.length; i++) {
    var r = lines[i].getBoundingClientRect();
    if (r.bottom > top + 1 && r.top < fr.bottom) return lines[i].textContent;
  }
  return "";
})()`;

function frameHeight(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelector(${JSON.stringify(frame(paneId))}).getBoundingClientRect().height`,
  );
}

/** Wait for the folded form to land on the Text card's host. */
function textFoldLanded(app: App): Promise<unknown> {
  return app.waitForCondition<boolean>(
    `(function(){var h=document.querySelector('${T_HOST}'); return h!==null && h.getAttribute("data-card-fold")==="settled";})()`,
    { timeoutMs: 8000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0670: the folded Text card", () => {
  test(
    "⌃⌘Y folds a Text card to the tier, the slit keeps the reader's line, and Return on the glyph opens it",
    async () => {
      const { dir, file } = mkFixture();
      const app = await launchTugApp({ testName: "at0670-text-fold" });
      try {
        await app.seedDeckState({
          state: {
            cards: [{ id: "T", componentId: "text", title: "File", closable: true }],
            panes: [
              {
                id: "pT",
                position: { x: 40, y: 40 },
                size: { width: 760, height: 560 },
                cardIds: ["T"],
                activeCardId: "T",
                title: "",
                acceptsFamilies: ["standard"],
              },
            ],
            activePaneId: "pT",
            hasFocus: true,
          },
          cardStates: { T: { content: { path: file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
          focusCardId: "T",
        });
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector('${T_EDITOR}'); return el!==null && el.innerText.indexOf("fixture line 01")!==-1;})()`,
          { timeoutMs: 15_000 },
        );
        await app.nativeClickAtElement('[data-card-id="T"] .cm-line');

        // Scroll the reader well away from the top, so the slit has a place
        // to keep rather than a top it would show anyway.
        await app.evalJS<null>(
          `(function(){var s=document.querySelector(${JSON.stringify(T_SCROLLER)}); var l=s.querySelector(".cm-line"); s.scrollTop=Math.round(l.getBoundingClientRect().height*12); return null;})()`,
        );
        await wait(300);
        const openLine = await app.evalJS<string>(FIRST_VISIBLE);
        note("first visible line, open", openLine);
        expect(openLine, "the editor is scrolled off its first line").not.toBe("fixture line 01");
        expect(openLine.startsWith("fixture line"), "a fixture line is visible").toBe(true);

        // ── 1. ⌃⌘Y folds the Text key card, and the frame is at the tier ──
        await app.nativeKey("y", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(`window.__tug.getPaneRecord("pT").folded===true`, {
          timeoutMs: 8000,
        });
        await textFoldLanded(app);
        const foldedHeight = await frameHeight(app, "pT");
        note("folded frame px", foldedHeight);
        expect(Math.abs(foldedHeight - FOLDED_CARD_HEIGHT_PX), "the frame stands at the tier").toBeLessThan(0.5);

        // ── 2. The slit shows the line the reader was on ──
        const foldedLine = await app.evalJS<string>(FIRST_VISIBLE);
        note("first visible line, folded", foldedLine);
        expect(foldedLine, "the slit's first line is the open card's").toBe(openLine);

        // ── 3. Return on the glyph opens the card into the editor ──
        await app.waitForCondition<boolean>(
          `(function(){var g=document.querySelector(${JSON.stringify(`${frame("pT")} ${GLYPH}`)}); return g!==null && g.hasAttribute("data-key-view");})()`,
          { timeoutMs: 6000 },
        );
        await app.nativeKey("Enter");
        await app.waitForCondition<boolean>(`window.__tug.getPaneRecord("pT").folded===false`, {
          timeoutMs: 8000,
        });
        await app.waitForCondition<boolean>(
          `(function(){var h=document.querySelector('${T_HOST}'); var f=document.querySelector(${JSON.stringify(frame("pT"))}); return h!==null && !h.hasAttribute("data-card-fold") && !f.hasAttribute("data-fold-crossing");})()`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `(function(){var c=document.querySelector('${T_EDITOR}'); return c!==null && c.contains(document.activeElement);})()`,
          { timeoutMs: 6000 },
        );
        const unfoldedLine = await app.evalJS<string>(FIRST_VISIBLE);
        note("first visible line, unfolded", unfoldedLine);
        expect(unfoldedLine, "the unfold lands where the reader was").toBe(openLine);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a split column of one Session card and one Text card packs both at the tier",
    async () => {
      const { dir, file } = mkFixture();
      const app = await launchTugApp({ testName: "at0670-wall" });
      try {
        await app.seedDeckState({
          state: {
            cards: [
              { id: "S", componentId: "session", title: "Session", closable: true },
              { id: "T", componentId: "text", title: "File", closable: true },
            ],
            panes: [
              {
                id: "pS",
                position: { x: 40, y: 40 },
                size: { width: 675, height: 620 },
                cardIds: ["S"],
                activeCardId: "S",
                title: "",
                acceptsFamilies: ["maker"],
                slot: 0,
              },
              {
                id: "pT",
                position: { x: 40, y: 40 },
                size: { width: 675, height: 620 },
                cardIds: ["T"],
                activeCardId: "T",
                title: "",
                acceptsFamilies: ["standard"],
                slot: 0,
              },
            ],
            activePaneId: "pT",
            imposition: { kind: "one-up" },
            hasFocus: true,
          },
          cardStates: { T: { content: { path: file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
          focusCardId: "T",
        });
        for (const id of ["S", "T"]) {
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(id)})`,
            { timeoutMs: 30_000 },
          );
        }
        await app.bindSession("S", { tugSessionId: "at0670-session" });
        // Bound is what gives the Session card its Z2 row and so its real
        // folded form; its composer's engine is not this file's subject.
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-card-id="S"] [data-slot="session-card-status-bar"]')!==null`,
          { timeoutMs: 15_000 },
        );
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: "split" }), null)`,
        );
        await wait(900);

        // Each fold is given its settle's whole tail before the next. A fold
        // that arrives inside a neighbour's settle retargets it, and that
        // retargeted crossing is never ended, so the first card never lands
        // folded — a defect of the deck's settle, not of either card's form,
        // and the same one at0669 waits out after an unfold.
        for (const id of ["S", "T"]) {
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-card-folded", { cardId: ${JSON.stringify(id)}, folded: true }), null)`,
          );
          await wait(2500);
        }
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord("pS").folded===true && window.__tug.getPaneRecord("pT").folded===true`,
          { timeoutMs: 8000 },
        );
        await textFoldLanded(app);
        await app.waitForCondition<boolean>(
          `(function(){var c=document.querySelector('[data-card-id="S"] .session-card'); return c!==null && c.getAttribute("data-fold")==="settled";})()`,
          { timeoutMs: 8000 },
        );

        const geo = await app.evalJS<{ s: { top: number; height: number; bottom: number }; t: { top: number; height: number; bottom: number } }>(
          `(function(){
            function box(id){ var r=document.querySelector('.tug-pane[data-pane-id="'+id+'"]').getBoundingClientRect(); return {top:r.top,height:r.height,bottom:r.bottom}; }
            return { s: box("pS"), t: box("pT") };
          })()`,
        );
        note("wall", JSON.stringify(geo));
        expect(Math.abs(geo.s.height - FOLDED_CARD_HEIGHT_PX), "the Session card stands at the tier").toBeLessThan(0.5);
        expect(Math.abs(geo.t.height - FOLDED_CARD_HEIGHT_PX), "the Text card stands at the tier").toBeLessThan(0.5);
        const [upper, lower] = geo.s.top < geo.t.top ? [geo.s, geo.t] : [geo.t, geo.s];
        expect(Math.abs(lower.top - (upper.bottom + GAP)), "the two pack with one seam between them").toBeLessThan(1);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
