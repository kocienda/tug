/**
 * at0602-text-card-disk-sync-reload.test.ts — a Text card adopts a write
 * from outside the app on the watch alone ([AT0602]).
 *
 * One piece of the at0602 split; the fixtures, deck shapes and instruments
 * are `text-card-disk-sync-fixture.ts`. Every fixture lives in an OS temp
 * directory, outside every workspace, so the per-file watch is the only way
 * the card can hear about the write.
 *
 * 1. **A reload holds the reader's place.** A tall file scrolled to a real
 *    mid-document offset, an external write that inserts a line ABOVE the
 *    viewport, and NO input event of any kind: the buffer adopts the change
 *    on the watch alone, and the text at the top of the viewport does not
 *    move.
 *
 * 2. **A burst converges on the last write.** Twenty external writes about
 *    10 ms apart and the buffer ends showing the last of them and none of
 *    the other nineteen. `_lookAtDisk` patched to drop its pending look
 *    stayed green: the server's `FileWatchService` debounces, so the burst
 *    reaches the client as one or two frames; `file_watch.rs`'s own burst
 *    tests cover that side.
 *
 * 5. **A card that is not in front: unfocused but visible.** Two panes,
 *    focus on the other card, nothing about the watched card touched. The
 *    reload lands and holds its reading position anyway, and takes no focus
 *    on the way in — nothing in the path is focus-gated.
 *
 * `_syncWatch` patched to never subscribe turned every scenario red.
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
  FIXTURE_CONTENT,
  SHOULD_RUN,
  TALL_CONTENT,
  TEST_TIMEOUT_MS,
  deckShapeTwoPanes,
  editorText,
  proveWatchLive,
  rmFixture,
  seedTextCard,
  seedTwoTextCards,
  waitForEditorShowing,
} from "./text-card-disk-sync-fixture";

describe.skipIf(!SHOULD_RUN)("at0602: Text card disk sync", () => {
  // -------------------------------------------------------------------------
  // Scenario 1: the watch reloads in place and holds the reader's place
  // -------------------------------------------------------------------------
  //
  // The external writer adds a line ABOVE the viewport, which is what tells
  // the two possible answers apart: holding the pixel `scrollTop` would slide
  // every visible line down by one row, and holding the TEXT moves `scrollTop`
  // by exactly that row. The reload goes in as a minimal change set, so CM6
  // maps its own scroll anchor through the insertion.
  test(
    "an external write reloads in place with no input event",
    async () => {
      const { dir, file } = mkTextFixture("at0602-hold-", TALL_CONTENT, { realpath: true });
      const app = await launchTugApp({ testName: "at0602-viewport-hold" });
      note(`at0602 out-of-workspace fixture: ${file}`);
      try {
        await seedTextCard(app, file, "manual");
        await waitForEditorShowing(app, "tall line 001");
        await proveWatchLive(app, file, TALL_CONTENT, "tall line 001");

        // Park the viewport at a real mid-document offset, then read WHICH
        // line sits at the viewport top and how far down its row starts.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 900, null)`,
        );
        const readTop = `(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
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

        // The only gesture in this scenario: a write from outside the app.
        const started = Date.now();
        fs.writeFileSync(file, "EXTERNAL-WRITER LINE\n" + TALL_CONTENT, "utf8");
        await app.waitForCondition<boolean>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollHeight > ${before.scrollHeight} + 4`,
          { timeoutMs: 20_000 },
        );
        note(`at0602 event-to-reload: ${Date.now() - started}ms`);

        const after = await app.evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        }>(readTop);
        expect(after.text, "the same line is still at the viewport top").toBe(
          before.text,
        );
        expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(2);

        // And the disk content really is in the buffer.
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

  // -------------------------------------------------------------------------
  // Scenario 2: a burst of writes converges on the last one
  // -------------------------------------------------------------------------

  test(
    "a burst of external writes settles on the last of them",
    async () => {
      const BURSTS = 20;
      const body = (i: number) => `BURST-MARKER-${String(i).padStart(2, "0")}\n${FIXTURE_CONTENT}`;
      const { dir, file } = mkTextFixture("at0602-burst-", FIXTURE_CONTENT, { realpath: true });
      const app = await launchTugApp({ testName: "at0602-burst" });
      try {
        await seedTextCard(app, file, "manual");
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file, FIXTURE_CONTENT, "fixture line 01");

        const started = Date.now();
        for (let i = 0; i < BURSTS; i++) {
          fs.writeFileSync(file, body(i), "utf8");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const last = `BURST-MARKER-${String(BURSTS - 1).padStart(2, "0")}`;
        await waitForEditorShowing(app, last, 20_000);
        note(`at0602 burst-to-settled: ${Date.now() - started}ms`);

        // Settled means settled: give any straggling read the time it would
        // need to land, then assert the buffer carries the LAST write and
        // none of the nineteen before it.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const text = await editorText(app);
        expect(text).toContain(last);
        for (let i = 0; i < BURSTS - 1; i++) {
          expect(text).not.toContain(`BURST-MARKER-${String(i).padStart(2, "0")}`);
        }
        expect(text).toContain("fixture line 24");
        expect(fs.readFileSync(file, "utf8")).toBe(body(BURSTS - 1));
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 5: a reload into an unfocused but visible card
  // -------------------------------------------------------------------------
  //
  // Every scenario above runs on the focused, visible card, and that is not the
  // Tug-common shape: the reader is typing in one card while an agent rewrites
  // a file open in another. This is that shape with both cards on screen —
  // card A holds the watched fixture in its own pane, focus sits on card B in a
  // second pane, and nothing about A is touched for the whole scenario. The
  // reload has to land and hold A's reading position anyway.
  //
  // Unfocused is a weaker condition than hidden: an unfocused card still has
  // layout, so CM6 can measure and anchor. What this pins is that nothing in
  // the reload path is gated on focus — a `hasFocus` check anywhere in the
  // anchor correction would show up here and nowhere else in this file.
  test(
    "an external write reloads an unfocused but visible card in place",
    async () => {
      const { dir, file } = mkTextFixture("at0602-unfocused-", TALL_CONTENT, { realpath: true });
      const other = mkTextFixture("at0602-unfocused-other-", FIXTURE_CONTENT, { realpath: true });
      const app = await launchTugApp({ testName: "at0602-unfocused-visible" });
      note(`at0602 out-of-workspace fixture: ${file}`);
      try {
        await seedTwoTextCards(
          app,
          deckShapeTwoPanes(),
          file,
          other.file,
          "B",
          "manual",
        );
        await waitForEditorShowing(app, "tall line 001");
        await proveWatchLive(app, file, TALL_CONTENT, "tall line 001");

        // Focus really is elsewhere, and card A really is on screen. Both have
        // to hold or the scenario is testing the focused case again under a
        // different name.
        const focused = await app.evalJS<string | null>(
          `window.__tug.getFocusedCardId()`,
        );
        expect(focused, "focus sits on the other card").toBe("B");
        const visible = await app.evalJS<boolean>(
          `(function(){
            var host = document.querySelector('[data-card-host][data-card-id="A"]');
            if (host === null) return false;
            return getComputedStyle(host).display !== "none"
              && document.querySelector('${EDITOR_SCROLLER_SELECTOR}').getBoundingClientRect().height > 100;
          })()`,
        );
        expect(visible, "card A is on screen with a laid-out editor").toBe(true);

        // Park A's viewport and read which line sits at its top.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 900, null)`,
        );
        const readTop = `(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
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

        // The only gesture: a write from outside the app, with focus still on B.
        fs.writeFileSync(file, "EXTERNAL-WRITER LINE\n" + TALL_CONTENT, "utf8");
        await app.waitForCondition<boolean>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollHeight > ${before.scrollHeight} + 4`,
          { timeoutMs: 20_000 },
        );

        const after = await app.evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        }>(readTop);
        note(
          `at0602 unfocused reload: top line ${JSON.stringify(before.text.slice(0, 14))} ` +
            `-> ${JSON.stringify(after.text.slice(0, 14))}, scrollTop ${Math.round(before.scrollTop)} -> ${Math.round(after.scrollTop)}`,
        );
        expect(after.text, "the same line is still at the viewport top").toBe(
          before.text,
        );
        expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(2);

        // The reload never stole focus on its way in.
        expect(
          await app.evalJS<string | null>(`window.__tug.getFocusedCardId()`),
        ).toBe("B");

        // And the disk content really is in the buffer.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 0, null)`,
        );
        await waitForEditorShowing(app, "EXTERNAL-WRITER LINE");
      } finally {
        await app.close();
        rmFixture(dir);
        rmFixture(other.dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

});
