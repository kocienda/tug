/**
 * at0602-text-card-disk-sync-hidden-tab.test.ts — a write from outside the
 * app reaches a Text card in a hidden background tab ([AT0602]).
 *
 * One piece of the at0602 split; the fixtures, deck shapes and instruments
 * are `text-card-disk-sync-fixture.ts`. Every fixture lives in an OS temp
 * directory, outside every workspace.
 *
 * 6. **A card that is not in front: a hidden background tab.** The stacked
 *    non-active card's placeholder carries `display: none` and the host stops
 *    showing its body, and inside the body its card host is `display: none`
 *    too, so the editor has no layout and CM6 can neither measure nor anchor
 *    in it. Park the viewport in front, switch
 *    away, write the file from outside, switch back: the content must be the
 *    disk's AND the reading position must be where it was left. The editor's
 *    hidden-card deferral removed turned this red (and the hidden-workspace
 *    piece's scenario 9), every other scenario green.
 *
 * 8. **A merge into a hidden DIRTY buffer.** The store keeps no copy of the
 *    buffer — every save path reads it back through the editor — so a reload
 *    held for a hidden card must still answer with the text it is holding.
 *    Read out of the aside record, which is the artifact a quit leaves
 *    behind: the merged text has to be in it, paired with the post-merge
 *    baseline hash it is written against. The bridge's `getText` returned to
 *    `cmView.state.doc.toString()` turned exactly this scenario red.
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
import { launchTugApp, note, type App } from "./_harness";
import { mkTextFixture } from "./_harness/fixtures";
import {
  EDITOR_SCROLLER_SELECTOR,
  EXTERNAL_LINE,
  FIXTURE_CONTENT,
  FIXTURE_LINES,
  SHOULD_RUN,
  TALL_CONTENT,
  TEST_TIMEOUT_MS,
  TYPED_RUN,
  assertNoConflictSurface,
  deckShapeStacked,
  editorText,
  proveWatchLive,
  removeAsideFor,
  rmFixture,
  seedTwoTextCards,
  typeIntoEditor,
  waitForAside,
  waitForEditorShowing,
} from "./text-card-disk-sync-fixture";

/** Whether the host shows `cardId`'s body, once it says `wanted` or 8 s pass. */
async function hostShows(app: App, cardId: string, wanted: boolean): Promise<boolean | null> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const body = (await app.bodies()).find((b) => b.cardId === cardId);
    const visible = body === undefined ? null : body.visible;
    if (visible === wanted || Date.now() >= deadline) return visible;
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

/**
 * The stacked tab's `display: none`, where it lands on bodies: the card's
 * placeholder in the shell's pane. The card's own page has no tab strip to
 * hide it in; the host stops showing its body ({@link hostShows}).
 */
const PLACEHOLDER_HIDDEN = `(function(){
  var host = document.querySelector('[data-body-placeholder][data-card-id="A"]');
  return host !== null && getComputedStyle(host).display === "none";
})()`;

describe.skipIf(!SHOULD_RUN)("at0602: Text card disk sync", () => {
  // -------------------------------------------------------------------------
  // Scenario 6: a reload into a hidden tab, read when it is brought forward
  // -------------------------------------------------------------------------
  //
  // The harder half of the not-in-front case. A stacked card that is not the
  // active one is mounted and alive but carries `display: none`
  // (`card-host.tsx`), so it has NO layout: CM6 cannot measure it and cannot
  // anchor a change in it. `_applyDiskRead` calls `bridge.replaceText`
  // regardless of whether the bridge's view is visible, so the reload lands in
  // a view that cannot compute where to put the reader — and until this
  // scenario nothing said what the card shows when it comes forward.
  //
  // The shape: park the viewport while the card is in front, switch to the
  // other tab, write the file from outside, switch back, and read. Both answers
  // are asserted — the content must be the disk's, and the reading position
  // must be where it was left. A hidden editor that silently kept stale text,
  // or came forward at the top of the file, fails here.
  test(
    "an external write to a hidden card is current and in place when it is shown",
    async () => {
      const { dir, file } = mkTextFixture("at0602-hidden-", TALL_CONTENT, { realpath: true });
      const other = mkTextFixture("at0602-hidden-other-", FIXTURE_CONTENT, { realpath: true });
      const app = await launchTugApp({ testName: "at0602-hidden-then-shown" });
      note(`at0602 out-of-workspace fixture: ${file}`);
      try {
        await seedTwoTextCards(
          app,
          deckShapeStacked(),
          file,
          other.file,
          "A",
          "manual",
        );
        await waitForEditorShowing(app, "tall line 001");
        await proveWatchLive(app, file, TALL_CONTENT, "tall line 001");

        // Park the viewport while the card is still in front — the place the
        // reader is owed back has to be established while CM6 can measure it.
        await app.body("A").evalJS<null>(
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
        await app.body("A").waitForCondition<boolean>(
          `(function(){ var t = ${readTop}; return t !== null && t.scrollTop > 200 && t.text.indexOf("tall line") === 0; })()`,
          { timeoutMs: 6000 },
        );
        const before = await app.body("A").evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        }>(readTop);

        // Send card A to the background and prove it is really hidden — the
        // whole premise is `display: none`, so a shape that left it visible
        // would make this a duplicate of Scenario 5.
        await app.evalJS<void>(`window.__tug.activateCard("B")`);
        // card-dom: shell — the tab's `display: none` is on its placeholder in the shell's pane.
        await app.waitForCondition<boolean>(PLACEHOLDER_HIDDEN, { timeoutMs: 6000 });
        expect(await hostShows(app, "A", false), "the background tab's body is not shown").toBe(false);
        // [B29] would restate this as "the unshown body keeps its layout"
        // ([B27]). Measured 2026-10-18 it does not, for a stacked tab: the
        // body's own card host is `display: none` while inactive
        // (`card-host.tsx`), so the editor reads 0 px. Kept as written until
        // the restatement is ruled again; the host fact is asserted above.
        const hiddenHeight = await app.body("A").evalJS<number>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').getBoundingClientRect().height`,
        );
        expect(
          hiddenHeight,
          "a display:none editor has no layout to measure",
        ).toBe(0);

        // Write from outside the app while the card is in the background.
        fs.writeFileSync(file, "EXTERNAL-WRITER LINE\n" + TALL_CONTENT, "utf8");

        // Nothing observable is coming while the card is hidden: `innerText` is
        // empty for a `display: none` subtree, and CM6 renders no new viewport
        // without a measure pass. So wait the delivery out rather than polling
        // for it. `proveWatchLive` above measured the real latency for this
        // fixture and noted it — a few hundred milliseconds; this is an order of
        // magnitude more than that.
        await new Promise((resolve) => setTimeout(resolve, 6000));

        // Bring it forward. This is the moment the reader is owed both things.
        await app.evalJS<void>(`window.__tug.activateCard("A")`);
        // card-dom: shell — the tab's placeholder, in the shell's pane, shown again.
        await app.waitForCondition<boolean>(`!${PLACEHOLDER_HIDDEN}`, { timeoutMs: 6000 });
        expect(await hostShows(app, "A", true), "brought forward, the card's body is shown").toBe(true);
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var host = document.querySelector('[data-card-host][data-card-id="A"]');
            return host !== null && getComputedStyle(host).display !== "none"
              && document.querySelector('${EDITOR_SCROLLER_SELECTOR}').getBoundingClientRect().height > 100;
          })()`,
          { timeoutMs: 6000 },
        );

        // The deferred reload lands a frame after the box appears, so wait for
        // the content rather than assuming the show and the text are the same
        // tick. A deferral that never applied times out here and says so.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollHeight > ${before.scrollHeight} + 4`,
          { timeoutMs: 6000 },
        );

        const after = await app.body("A").evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        } | null>(readTop);
        note(
          `at0602 hidden reload: top line ${JSON.stringify(before.text.slice(0, 14))} ` +
            `-> ${JSON.stringify(after === null ? null : after.text.slice(0, 14))}, scrollTop ` +
            `${Math.round(before.scrollTop)} -> ${after === null ? "none" : Math.round(after.scrollTop)}, ` +
            `scrollHeight ${Math.round(before.scrollHeight)} -> ${after === null ? "none" : Math.round(after.scrollHeight)}`,
        );
        expect(after, "the shown editor renders lines").not.toBeNull();
        if (after === null) throw new Error("unreachable");

        // The content is the disk's: the added row made the document taller.
        expect(
          after.scrollHeight,
          "the hidden card adopted the external write",
        ).toBeGreaterThan(before.scrollHeight + 4);
        // And the reading position survived the round trip through hidden.
        expect(after.text, "the same line is still at the viewport top").toBe(
          before.text,
        );
        expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(2);

        // The whole disk content really is in the buffer, not just its height.
        await app.body("A").evalJS<null>(
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

  // -------------------------------------------------------------------------
  // Scenario 8: a merge into a hidden DIRTY buffer, read out of the aside
  // -------------------------------------------------------------------------
  //
  // Scenario 6's card was clean, and a clean card is the easy half: the store
  // adopts the disk's text and nothing reads the buffer back until the card
  // comes forward. A DIRTY hidden card is the half with teeth, because the
  // store keeps no copy of the buffer — every path that needs the text asks
  // the editor for it, and while a reload is deferred the editor's document is
  // the PRE-merge text while the store's baseline and hash have already moved
  // to the disk's.
  //
  // The aside is where that shows, and it is the artifact that matters: it is
  // what a quit leaves behind and what a restore comes back as. A record
  // pairing the pre-merge text with the post-merge baseline hash is the
  // dangerous combination — the card would restore believing it is in step
  // with a disk it has never seen, and the next save would write over the
  // external editor's work with no conflict and no banner.
  //
  // Manual mode deliberately: nothing autosaves, so the buffer stays dirty for
  // as long as the scenario needs and there is no debounce to race. The aside
  // is found by its own `path` field rather than by re-deriving the filename
  // hash, so the reader cannot go quietly stale against `asidePathFor`.
  test(
    "a merge into a hidden dirty buffer sets the aside to the merged text",
    async () => {
      const { dir, file } = mkTextFixture("at0602-hidden-dirty-", FIXTURE_CONTENT, { realpath: true });
      const other = mkTextFixture("at0602-hidden-dirty-other-", FIXTURE_CONTENT, { realpath: true });
      const app = await launchTugApp({ testName: "at0602-hidden-dirty-merge" });
      note(`at0602 out-of-workspace fixture: ${file}`);
      try {
        await seedTwoTextCards(
          app,
          deckShapeStacked(),
          file,
          other.file,
          "A",
          "manual",
        );
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file, FIXTURE_CONTENT, "fixture line 01");

        // Dirty the buffer while the card is in front — the only way in, since
        // a `display: none` card cannot be typed into.
        await typeIntoEditor(app, TYPED_RUN);
        const typed = await waitForAside(
          file,
          (rec) => rec.content.includes(TYPED_RUN.trim()),
          "the typing reached the aside",
        );

        // Send the card to the background, and prove it really is not shown —
        // that is the whole premise, and a visible card would make this
        // scenario a duplicate of the merge scenarios above.
        await app.evalJS<void>(`window.__tug.activateCard("B")`);
        // card-dom: shell — the tab's `display: none` is on its placeholder in the shell's pane.
        await app.waitForCondition<boolean>(PLACEHOLDER_HIDDEN, { timeoutMs: 6000 });
        expect(await hostShows(app, "A", false), "the background tab's body is not shown").toBe(false);
        // [B29]'s "layout kept" restatement does not hold for a stacked tab
        // (see Scenario 6): kept as written.
        expect(
          await app.body("A").evalJS<number>(
            `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').getBoundingClientRect().height`,
          ),
          "a display:none editor has no layout to measure",
        ).toBe(0);

        // The external write, distant from the typing, while nothing is in
        // front. The store merges it and re-captures the aside.
        const external = FIXTURE_CONTENT.replace(
          FIXTURE_LINES[19] as string,
          EXTERNAL_LINE,
        );
        fs.writeFileSync(file, external, "utf8");

        // The merge landed when the aside's baseline moved to the disk's new
        // hash. Waiting on THAT rather than on the content is what makes the
        // assertion below able to fail: a record written against the new
        // baseline is a record the store believes is current.
        const merged = await waitForAside(
          file,
          (rec) => rec.baselineSha256 !== typed.baselineSha256,
          "the merge re-captured the aside against the new disk hash",
        );
        note(
          `at0602 hidden dirty aside: baseline ${String(typed.baselineSha256).slice(0, 8)} -> ` +
            `${String(merged.baselineSha256).slice(0, 8)}, ${merged.content.length}b, ` +
            `typing ${merged.content.includes(TYPED_RUN.trim())}, external ${merged.content.includes(EXTERNAL_LINE)}`,
        );

        // Both edits, in the record that survives a quit. Without the merged
        // text reaching the aside this holds the pre-merge buffer under the
        // post-merge hash, which is the silent clobber.
        expect(
          merged.content.includes(TYPED_RUN.trim()),
          "the aside still holds the user's own typing",
        ).toBe(true);
        expect(
          merged.content.includes(EXTERNAL_LINE),
          "and the external edit the merge brought in",
        ).toBe(true);

        // Bringing the card forward lands the deferred text, so the editor
        // agrees with the record that was written while it could not.
        await app.evalJS<void>(`window.__tug.activateCard("A")`);
        await waitForEditorShowing(app, EXTERNAL_LINE, 10_000);
        const shown = await editorText(app);
        expect(shown, "the shown editor holds the user's typing too").toContain(
          TYPED_RUN.trim(),
        );
        await assertNoConflictSurface(app);

        // Manual mode writes nothing without being asked.
        expect(fs.readFileSync(file, "utf8")).toBe(external);
      } finally {
        await app.close();
        removeAsideFor(file);
        rmFixture(dir);
        rmFixture(other.dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

});
