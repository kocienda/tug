/**
 * at0602-text-card-disk-sync-hidden-workspace.test.ts — a write from
 * outside the app reaches a Text card in a hidden workspace ([AT0602]).
 *
 * One piece of the at0602 split; the fixtures, deck shapes and instruments
 * are `text-card-disk-sync-fixture.ts`. Every fixture lives in an OS temp
 * directory, outside every workspace.
 *
 * 9. **A card that is not in front: a hidden WORKSPACE.** The hidden-tab
 *    piece's scenario 6 with the hiding several ancestors further up —
 *    `space-layer.css` hides a whole workspace the way a stacked card host is
 *    hidden. The deferral observes the editor's scroller, not whatever went
 *    hidden, so this says whether the observer fires when the element that
 *    regains a box is an ancestor of the one being observed. The editor's
 *    hidden-card deferral removed turned this and scenario 6 red, every
 *    other scenario green.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/lib/file-watch-client.ts
 * @covers tugdeck/src/lib/three-way-merge.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugrust/crates/tugcast/src/feeds/file_watch.rs
 * @covers tugdeck/src/components/chrome/space-layer.css
 * @covers tugdeck/src/components/chrome/space-layer.ts
 * @family at0602-text-card-disk-sync
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { launchTugApp, note } from "./_harness";
import { mkTextFixture } from "./_harness/fixtures";
import {
  EDITOR_SCROLLER_SELECTOR,
  SHOULD_RUN,
  TALL_CONTENT,
  TEST_TIMEOUT_MS,
  proveWatchLive,
  rmFixture,
  seedTextCard,
  waitForEditorShowing,
} from "./text-card-disk-sync-fixture";

describe.skipIf(!SHOULD_RUN)("at0602: Text card disk sync", () => {
  // -------------------------------------------------------------------------
  // Scenario 9: a reload into a card in a hidden WORKSPACE
  // -------------------------------------------------------------------------
  //
  // Scenario 6 hides the card with `display: none` on its own card host.
  // `space-layer.css` hides a whole workspace the same way, several ancestors
  // further up, and the deferral's `ResizeObserver` is attached to the
  // editor's scroller rather than to whatever went `display: none` — so the
  // question this answers is whether the observer fires when the element that
  // regains a box is an ANCESTOR of the one being observed.
  //
  // It should: an element inside a `display: none` subtree is skipped by
  // `ResizeObserver` and reported when it gets a box back, regardless of which
  // ancestor was hiding it. That is the reading; a scenario is what makes it a
  // fact. If this ever goes red the deferral has to re-arm on the workspace
  // transition as well — `useSpaceLayerShown()` is the condition that names it
  // — rather than on the scroller's own box alone.
  //
  // Otherwise the shape is scenario 6's exactly, so the two differ only in
  // which ancestor is hidden, which is the comparison worth having.
  test(
    "an external write to a card in a hidden workspace is current and in place",
    async () => {
      const { dir, file } = mkTextFixture("at0602-space-", TALL_CONTENT, { realpath: true });
      const app = await launchTugApp({ testName: "at0602-hidden-workspace" });
      note(`at0602 out-of-workspace fixture: ${file}`);
      try {
        await seedTextCard(app, file, "manual");
        await waitForEditorShowing(app, "tall line 001");
        await proveWatchLive(app, file, TALL_CONTENT, "tall line 001");

        // Park the viewport while the workspace is on screen — the place the
        // reader is owed back has to be established while CM6 can measure it.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 900, null)`,
        );
        const readTop = `(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          if (scroller === null) return null;
          var box = scroller.getBoundingClientRect();
          var lines = scroller.querySelectorAll('.cm-line');
          for (var i = 0; i < lines.length; i++) {
            var r = lines[i].getBoundingClientRect();
            if (r.bottom > box.top + 1) {
              return { text: lines[i].textContent, delta: r.top - box.top, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
            }
          }
          return null;
        })()`;
        await app.waitForCondition<boolean>(
          `(function(){ var t = ${readTop}; return t !== null && t.scrollTop > 200 && t.text.indexOf("tall line") === 0; })()`,
          { timeoutMs: 6000 },
        );
        const before = await app.evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        }>(readTop);

        const home = await app.evalJS<string>(
          `window.tugdeck.diag.getSpaces().activeSpaceId`,
        );

        // A new workspace, through the real verb the Window menu sends. The
        // card is left mounted in a layer the canvas stops showing, which is
        // the state under test.
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("new-space"), null)`,
        );
        // With the card's own layer confirmed hidden — the premise is an
        // ANCESTOR the canvas is hiding, so a shape that left the card's host
        // visible would prove nothing. The wait used also to clear a crossfade
        // beat; the switch is a cut now, so there is no beat to clear.
        await app.waitForCondition<boolean>(
          `(function(){
            var host = document.querySelector('[data-card-host][data-card-id="A"]');
            if (host === null) return false;
            var layer = host.closest('.tug-space-layer');
            return layer !== null && !layer.hasAttribute('data-space-shown')
              && getComputedStyle(host).display !== "none";
          })()`,
          { timeoutMs: 8000 },
        );
        // A hidden layer KEEPS its layout now ([B02] of `workspace-switch-cheap`)
        // — the scroller has a real height — so the premise is stated as what
        // it always meant: the card is not being rendered. `checkVisibility()`
        // is false under `visibility: hidden` and `content-visibility: hidden`
        // alike, and was false under `display: none` too.
        const hiddenRendered = await app.evalJS<boolean | null>(
          `(function(){
            var s = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
            if (s === null) return null;
            return s.checkVisibility ? s.checkVisibility() : s.getBoundingClientRect().height > 0;
          })()`,
        );
        expect(
          hiddenRendered,
          "a card in a hidden workspace is not being rendered",
        ).toBe(false);

        // Write from outside the app while the workspace is off screen.
        fs.writeFileSync(file, "EXTERNAL-WRITER LINE\n" + TALL_CONTENT, "utf8");

        // Nothing observable arrives while the layer is hidden, for scenario
        // 6's reasons: no boxes, and no CM6 measure pass. Wait the delivery
        // out — `proveWatchLive` measured the real latency and noted it, and
        // this is an order of magnitude more.
        await new Promise((resolve) => setTimeout(resolve, 6000));

        // Back to the workspace the card is in. This is the moment the reader
        // is owed both things.
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`,
        );
        await app.waitForCondition<boolean>(
          `(function(){
            var host = document.querySelector('[data-card-host][data-card-id="A"]');
            if (host === null) return false;
            var layer = host.closest('.tug-space-layer');
            if (layer === null || !layer.hasAttribute('data-space-shown')) return false;
            var s = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
            return s !== null && s.getBoundingClientRect().height > 100;
          })()`,
          { timeoutMs: 8000 },
        );

        await app.waitForCondition<boolean>(
          `(function(){
            var s = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
            return s !== null && s.scrollHeight > ${before.scrollHeight} + 4;
          })()`,
          { timeoutMs: 8000 },
        );

        const after = await app.evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        } | null>(readTop);
        note(
          `at0602 hidden-workspace reload: top line ${JSON.stringify(before.text.slice(0, 14))} ` +
            `-> ${JSON.stringify(after === null ? null : after.text.slice(0, 14))}, scrollTop ` +
            `${Math.round(before.scrollTop)} -> ${after === null ? "none" : Math.round(after.scrollTop)}, ` +
            `scrollHeight ${Math.round(before.scrollHeight)} -> ${after === null ? "none" : Math.round(after.scrollHeight)}`,
        );
        expect(after, "the shown editor renders lines").not.toBeNull();
        if (after === null) throw new Error("unreachable");

        expect(
          after.scrollHeight,
          "the card in the hidden workspace adopted the external write",
        ).toBeGreaterThan(before.scrollHeight + 4);
        expect(
          after.text,
          "the same line is still at the viewport top",
        ).toBe(before.text);
        expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(2);

        // The whole disk content really is in the buffer, not just its height.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 0, null)`,
        );
        await waitForEditorShowing(app, "EXTERNAL-WRITER LINE");
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

});
