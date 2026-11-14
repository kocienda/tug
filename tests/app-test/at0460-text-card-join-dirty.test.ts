/**
 * at0460-text-card-join-dirty.test.ts — the same merge under unsaved edits asks about the hash ("was changed by another application"), never "was deleted", and the merged bytes survive on disk.
 *
 * One of the at0460-text-card-join split, a test to a file so each launch
 * fits its own budget. Why the fixture repository lives inside the
 * checkout, and why the warm-up keeps every assertion from passing
 * vacuously, is `text-card-join-fixture.ts`.
 *
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/lib/file-io.ts
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card-save-sheets.tsx
 * @covers tugrust/crates/tugcast/src/feeds/file_watcher.rs
 * @family at0460-text-card-join
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";

import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  EDITOR,
  MERGED_BODY,
  SAVE_SHEET,
  launchOnFixture,
  mkFixture,
  sheetTitle,
  squashMerge,
  typeIntoEditor,
  type Fixture,
} from "./text-card-join-fixture";

let openFixture: Fixture | null = null;
let openTugbank = "";

afterEach(() => {
  if (!SHOULD_RUN) return;
  if (openFixture !== null) {
    rmSync(openFixture.repo, { recursive: true, force: true });
    rmSync(openFixture.dataRoot, { recursive: true, force: true });
    openFixture = null;
  }
  if (openTugbank !== "") {
    rmTempTugbank(openTugbank);
    openTugbank = "";
  }
});

describe.skipIf(!SHOULD_RUN)("AT0460: a join replaces a card's file in place", () => {
  test(
    "a dirty card is asked about the hash, never told the file was deleted",
    async () => {
      const fixture = mkFixture("at0460-dirty");
      openFixture = fixture;
      const { app, tugbankPath } = await launchOnFixture(
        fixture,
        "at0460-join-replace-dirty",
      );
      openTugbank = tugbankPath;
      try {
        await typeIntoEditor(app, "UNSAVED-EDIT ");
        await app.body("B").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector('${EDITOR}');
            return el !== null && el.innerText.indexOf("UNSAVED-EDIT") !== -1;
          })()`,
          { timeoutMs: 8000 },
        );

        squashMerge(fixture.repo);

        await app.body("B").waitForCondition<boolean>(
          `document.querySelector('${SAVE_SHEET}') !== null`,
          { timeoutMs: 15000 },
        );
        const title = await sheetTitle(app);
        expect(title).toContain("was changed by another application");
        expect(title).not.toContain("was deleted");

        // The merge is still on disk — the sheet adjudicates, it never wrote.
        expect(readFileSync(fixture.file, "utf8")).toBe(MERGED_BODY);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
