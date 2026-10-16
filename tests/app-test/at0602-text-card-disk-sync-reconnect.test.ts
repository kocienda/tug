/**
 * at0602-text-card-disk-sync-reconnect.test.ts — a write nothing was
 * watching reaches a Text card when tugcast comes back ([AT0602]).
 *
 * One piece of the at0602 split; the fixtures, deck shapes and instruments
 * are `text-card-disk-sync-fixture.ts`. Every fixture lives in an OS temp
 * directory, outside every workspace.
 *
 * 7. **A write nothing was watching, healed on reconnect.** The harness puts
 *    this instance's tugcast down (`app.stopTugcast()`), the file is written
 *    while it is gone, and tugcast comes back: the buffer catches up with no
 *    interaction of any kind. The app, its window and the loaded page all
 *    survive the outage — the app re-authenticates in place rather than
 *    reloading — so what heals is the client's own `connectionDidOpen`
 *    re-`watch`, and the editor element the catch-up lands in is checked to
 *    be the same object it was before, which rules out a reload having
 *    re-read the file instead. `onConnectionDidOpen` in
 *    `file-watch-client.ts` patched to forget its `seq` map and `reset` the
 *    server without re-`watch`ing turned exactly this scenario red.
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
  EDITOR_CONTENT_SELECTOR,
  FIXTURE_CONTENT,
  OUTAGE_CONTENT,
  OUTAGE_SENTINEL,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  assertNoConflictSurface,
  editorText,
  proveWatchLive,
  rmFixture,
  seedTextCard,
  waitForEditorShowing,
} from "./text-card-disk-sync-fixture";

describe.skipIf(!SHOULD_RUN)("at0602: Text card disk sync", () => {
  // -------------------------------------------------------------------------
  // Scenario 7: a write nothing was watching, healed on reconnect
  // -------------------------------------------------------------------------
  //
  // The outage is the whole apparatus. `app.stopTugcast()` answers only once
  // the child is gone, so the write that follows is one no watcher on either
  // side of the wire ever saw — which is exactly the gap the client's
  // `connectionDidOpen` re-`watch` exists to close, and exactly the gap no
  // scenario above can produce.
  //
  // Two guards keep it from passing for the wrong reason. The buffer is read
  // DURING the outage and must still hold the old body — otherwise the write
  // was delivered normally and there was no gap to heal. And a marker is
  // stamped on the live `.cm-content` element before the outage and must
  // still be there after the catch-up — otherwise the page reloaded or the
  // card remounted, and a fresh read from disk would look identical from the
  // outside while proving nothing about the heal.
  test(
    "a write during a tugcast outage lands on reconnect with no interaction",
    async () => {
      const { dir, file } = mkTextFixture("at0602-outage-", FIXTURE_CONTENT, { realpath: true });
      const app = await launchTugApp({ testName: "at0602-reconnect-heal" });
      note(`at0602 out-of-workspace fixture: ${file}`);
      try {
        await seedTextCard(app, file, "manual");
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file, FIXTURE_CONTENT, "fixture line 01");

        // Stamp the live editor element. A property, not an attribute: it
        // cannot survive serialization, so it is only still readable if this
        // is the same element object the outage started with.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_CONTENT_SELECTOR}').__at0602Outage = "kept", null)`,
        );

        const downAt = Date.now();
        await app.stopTugcast();
        note(`at0602 tugcast down after ${Date.now() - downAt}ms`);

        // The write nothing is watching.
        fs.writeFileSync(file, OUTAGE_CONTENT, "utf8");

        // Wait out an ordinary delivery before claiming the gap is real.
        // `proveWatchLive` noted this fixture's real latency a moment ago —
        // a few hundred milliseconds — and this is an order of magnitude
        // more than that.
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const during = await editorText(app);
        expect(
          during.includes(OUTAGE_SENTINEL),
          "nothing was watching: the write did not reach the buffer",
        ).toBe(false);
        expect(
          during.includes("fixture line 01"),
          "the buffer still holds the body it had before the outage",
        ).toBe(true);

        const upAt = Date.now();
        await app.startTugcast();
        // No interaction of any kind between here and the assertion: no
        // click, no focus, no keystroke, no scroll. The reconnect is the
        // only thing that happens.
        await waitForEditorShowing(app, OUTAGE_SENTINEL, 60_000);
        note(`at0602 buffer caught up ${Date.now() - upAt}ms after tugcast came back`);

        const marker = await app.evalJS<string | null>(
          `(function(){
            var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
            return el === null ? null : (el.__at0602Outage || null);
          })()`,
        );
        expect(
          marker,
          "the same editor element caught up — no page reload, no remount",
        ).toBe("kept");

        const after = await editorText(app);
        expect(
          after.includes("fixture line 01"),
          "the whole disk body is in the buffer, not just its first line",
        ).toBe(true);
        await assertNoConflictSurface(app);
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

});
