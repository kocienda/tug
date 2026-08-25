/**
 * at0475-dictionary-lookup.test.ts — Look Up in Dictionary is the text
 * surface's first context-menu row, and it dims with the selection.
 *
 * The verb reads the selection rather than moving it, so it leads the menu
 * above its own separator, the way it does in every native text view. Two
 * claims are worth pinning through the real app, and each is a way the row
 * can be wrong while the code reads right:
 *
 *   - **It leads, and a selection lights it.** A right-click over a ranged
 *     selection offers the row first, enabled — which also proves the
 *     secondary-click guard kept the selection alive long enough for the
 *     builder to sample it.
 *   - **Nothing to define dims it.** In an EMPTY editor — where the opening
 *     click has no word to select either — the row is present and dim rather
 *     than an enabled press that does nothing. Emptying the document is what
 *     makes this case honest: a caret sitting in text is no longer a menu
 *     with no selection. Paste stays live as the control, so a dim Look Up
 *     is the selection gate and not a menu that went inert.
 *   - **A bare click lights it too.** A secondary click with nothing selected
 *     makes a selection on its way in — WebKit smart-selects the closest word
 *     inside its own contextmenu dispatch — and the menu has to see THAT, not
 *     the collapsed caret the surface still remembers. A surface with its own
 *     selection model folds the change in later than the menu is built, so a
 *     menu that asks only the surface opens over a visibly selected word and
 *     offers nothing that acts on it. Cut and Copy ride the same gate, so
 *     they are asserted beside Look Up.
 *   - **The word, and only the word.** WebKit's word granularity reaches past
 *     the word into the space beside it, and the callout is drawn around
 *     whatever range is measured — so an untrimmed one paints a box wider
 *     than the word. The payload is the bare word.
 *   - **The anchor is the word's baseline.** `showDefinition` redraws the
 *     string as a callout over the word and positions it from the baseline
 *     origin of the first character, so an anchor at the bottom of the glyph
 *     box drops the callout a descent low — visibly off the word, which is
 *     the bug this case exists to keep fixed. The assertion is relative: the
 *     anchor sits at the left edge of the glyph box and in the lower part of
 *     its height, never on its bottom edge.
 *
 * The baseline is the reason this case has to run in the real app at all.
 * It is derived from the metrics of the face actually rasterized, so it means
 * nothing anywhere the real fonts are not loaded and the real text is not
 * laid out.
 *
 * What is deliberately NOT driven here: activating the row. Its handler
 * hands the selection to AppKit's `showDefinition`, which puts up a system
 * panel — a window this suite has no business summoning on a machine the
 * user is working on. `dictionaryLookupProbe` reads the payload the row
 * carries without asking AppKit for anything, so everything up to the host
 * boundary is real and the panel stays AppKit's.
 *
 * Selection is made with ⇧← rather than ⌘A: shift-arrows are the substrate's
 * own keys, while ⌘A is an Edit-menu key equivalent that AppKit resolves
 * against a key window this instance does not have.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/dictionary-lookup.ts
 * @covers tugdeck/src/components/tugways/text-editing-menu.ts
 * @covers tugdeck/src/components/tugways/use-text-surface-context-menu.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 150_000;

const EDITOR = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const LOOK_UP = "Look Up in Dictionary";

/** One pane holding one gallery card of the given component. */
function paneOf(component: string) {
  return {
    cards: [{ id: "A", componentId: component, title: "Card A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 60, y: 60 },
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

/** One row of the open context menu, as the menu renders it. */
interface MenuRow {
  index: number;
  label: string;
  disabled: boolean;
}

/** Every actionable row of the open menu, in the order it shows them. */
async function menuRows(app: App): Promise<MenuRow[]> {
  return (
    (await app.evalJS<MenuRow[]>(
      `Array.from(document.querySelectorAll('.tug-menu-item')).map(function (n, i) {
        var label = n.querySelector('.tug-menu-item-label');
        return {
          index: i,
          label: ((label === null ? n.textContent : label.textContent) || '').trim(),
          disabled: n.hasAttribute('data-disabled'),
        };
      })`,
    )) ?? []
  );
}

/** Open the surface's context menu and read it. Closes any stale menu first. */
async function openMenu(app: App): Promise<MenuRow[]> {
  await app
    .waitForCondition<boolean>(
      `document.querySelectorAll('.tug-menu-item').length === 0`,
      { timeoutMs: 2000 },
    )
    .catch(() => {});
  await app.nativeRightClickAtElement(EDITOR);
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-menu-item').length > 0`,
    { timeoutMs: 4000 },
  );
  return menuRows(app);
}

/** Dismiss the open menu so the next right-click opens a clean one. */
async function closeMenu(app: App): Promise<void> {
  await app.nativeKey("Escape");
  await app
    .waitForCondition<boolean>(
      `document.querySelectorAll('.tug-menu-item').length === 0`,
      { timeoutMs: 2000 },
    )
    .catch(() => {});
}

describe.skipIf(!SHOULD_RUN)("AT0475: Look Up in Dictionary", () => {
  test(
    "the row leads the menu, anchors on the word's baseline, and dims without a selection",
    async () => {
      const app = await launchTugApp({ testName: "at0475-dictionary-lookup" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({
          state: paneOf("gallery-text-editor"),
          focusCardId: "A",
        });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.awaitEngineReady("A");

        await app.nativeClickAtElement(EDITOR);
        await app.waitForCondition<boolean>(
          `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(EDITOR)})`,
          { timeoutMs: 2000 },
        );
        await app.nativeType("hello tug");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)}) || {}).textContent === "hello tug"`,
          { timeoutMs: 4000 },
        );

        // Select "tug" — three characters back from the caret.
        for (let i = 0; i < 3; i += 1) {
          await app.nativeKey("ArrowLeft", ["shift"]);
          await new Promise((r) => setTimeout(r, 30));
        }

        const withSelection = await openMenu(app);
        note(`menu with a selection: ${withSelection.map((r) => r.label).join(" | ")}`);
        const lit = withSelection.find((r) => r.label === LOOK_UP);
        expect(lit, `${LOOK_UP} must be in the menu`).toBeDefined();
        expect(lit?.index, `${LOOK_UP} leads the menu`).toBe(0);
        expect(lit?.disabled, `${LOOK_UP} is live over a selection`).toBe(false);

        // The payload the row carries, read at the host boundary rather than
        // through it. `x` is the glyph box's left edge; `y` is a BASELINE, so
        // it sits in the lower part of the box and never on its bottom edge —
        // the descender room below the baseline is what the old anchor spent,
        // and what dropped the callout off the word.
        const probe = await app.evalJS<{
          request: {
            text: string;
            x: number;
            y: number;
            fontSize: number;
            fontFamily: string;
          };
          rect: { top: number; left: number; width: number; height: number };
        } | null>(`window.__tug.dictionaryLookupProbe()`);
        expect(probe, "the live selection yields a lookup payload").not.toBeNull();
        const { request, rect } = probe!;
        const ratio = (request.y - rect.top) / rect.height;
        note(
          `anchor: text=${JSON.stringify(request.text)} x=${request.x.toFixed(1)} ` +
            `y=${request.y.toFixed(1)} in rect top=${rect.top.toFixed(1)} ` +
            `h=${rect.height.toFixed(1)} → baseline at ${(ratio * 100).toFixed(1)}% ` +
            `of the box; font ${request.fontSize}px ${request.fontFamily}`,
        );
        expect(request.text, "the payload is the selected word").toBe("tug");
        expect(
          Math.abs(request.x - rect.left),
          "the anchor is the glyph box's left edge",
        ).toBeLessThan(1);
        expect(request.fontSize, "the selection's font size travels").toBeGreaterThan(0);
        expect(request.fontFamily.length, "the family list travels").toBeGreaterThan(0);
        // A Latin face puts its baseline roughly three-quarters down the glyph
        // box. The band is wide enough for any face and still excludes both
        // failure modes: the box's top and the box's bottom.
        expect(ratio, "the anchor is a baseline, not the box top").toBeGreaterThan(0.55);
        expect(ratio, "the anchor is a baseline, not the box bottom").toBeLessThan(0.97);

        await closeMenu(app);

        // A BARE secondary click over a word — no selection standing when it
        // lands. WebKit smart-selects the word inside its own contextmenu
        // dispatch, so the user sees a selection under an open menu; CM6 has
        // not folded that change in yet, and a menu that asked only the
        // surface offered nothing that acts on the word it opened over.
        await app.evalJS<boolean>(
          `(function(){ var s = window.getSelection(); if (s) s.removeAllRanges(); return true; })()`,
        );
        const wordPt = await app.evalJS<{ x: number; y: number } | null>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(EDITOR)});
            if (el === null) return null;
            var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            var node = null;
            while ((node = walker.nextNode()) !== null) {
              var i = (node.textContent || '').indexOf('hello');
              if (i < 0) continue;
              var r = document.createRange();
              r.setStart(node, i);
              r.setEnd(node, i + 5);
              var box = r.getBoundingClientRect();
              if (box.width < 2) continue;
              return {
                x: Math.round(box.left + box.width / 2),
                y: Math.round(box.top + box.height / 2),
              };
            }
            return null;
          })()`,
        );
        expect(wordPt, "the word to right-click was located").not.toBeNull();
        await app.nativeRightClick(wordPt!);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('.tug-menu-item').length > 0`,
          { timeoutMs: 4000 },
        );
        const bareClick = await menuRows(app);
        note(
          `menu on a bare right-click over a word: ${bareClick
            .map((r) => `${r.label}${r.disabled ? " (dim)" : ""}`)
            .join(" | ")}`,
        );
        for (const label of [LOOK_UP, "Cut", "Copy"]) {
          expect(
            bareClick.find((r) => r.label === label)?.disabled,
            `${label} is live over the word the click just selected`,
          ).toBe(false);
        }
        // And what it would define is that word, with no space carried in
        // from WebKit's word granularity reaching past it.
        const bareProbe = await app.evalJS<{ request: { text: string } } | null>(
          `window.__tug.dictionaryLookupProbe()`,
        );
        note(`bare-click payload: ${JSON.stringify(bareProbe?.request.text)}`);
        expect(bareProbe?.request.text, "the word, and only the word").toBe("hello");

        await closeMenu(app);

        // Nothing to define: empty the document, so the click that opens the
        // menu has no word to smart-select either. Emptying is what makes
        // this case honest — a caret in text is no longer a menu with no
        // selection, because the secondary click makes one.
        await app.nativeClickAtElement(EDITOR);
        // The click lands the caret past the end of the one short line, so
        // backspacing more times than the line is long empties it.
        for (let i = 0; i < "hello tug".length + 2; i += 1) {
          await app.nativeKey("Backspace");
          await new Promise((r) => setTimeout(r, 25));
        }
        // An emptied CM6 document is not an empty `.cm-content` — the
        // placeholder renders as content — so the check is that the typed
        // text is gone, not that the element is bare.
        await app.waitForCondition<boolean>(
          `((document.querySelector(${JSON.stringify(EDITOR)}) || {}).textContent || '').indexOf('hello') === -1`,
          { timeoutMs: 4000 },
        );

        const empty = await openMenu(app);
        note(
          `menu with nothing to define: ${empty
            .map((r) => `${r.label}${r.disabled ? " (dim)" : ""}`)
            .join(" | ")}`,
        );
        const dim = empty.find((r) => r.label === LOOK_UP);
        expect(dim, `${LOOK_UP} stays in the menu with no selection`).toBeDefined();
        expect(dim?.disabled, `${LOOK_UP} dims with nothing to define`).toBe(true);
        // The control: the menu itself is live here.
        expect(
          empty.find((r) => r.label === "Paste")?.disabled,
          "Paste stays live in an empty editor",
        ).toBe(false);

        await closeMenu(app);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0475] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
