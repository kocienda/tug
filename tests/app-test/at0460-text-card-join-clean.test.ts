/**
 * at0460-text-card-join-clean.test.ts — a real `git merge --squash` under an open, unedited Text card: the card adopts the merged content and no sheet or banner appears.
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
  MERGED_BODY,
  anyVerdictShowing,
  launchOnFixture,
  mkFixture,
  settle,
  squashMerge,
  waitForEditorShowing,
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
    "a clean card adopts the merged content with no dialog",
    async () => {
      const fixture = mkFixture("at0460-clean");
      openFixture = fixture;
      const { app, tugbankPath } = await launchOnFixture(
        fixture,
        "at0460-join-replace-clean",
      );
      openTugbank = tugbankPath;
      try {
        squashMerge(fixture.repo);

        // Positive proof that a FILESYSTEM frame arrived and drove a reload:
        // the editor holds bytes only the merge could have put there.
        await waitForEditorShowing(app, "MERGED line one");
        expect(await anyVerdictShowing(app)).toBe(false);

        // And it stays quiet past the settle window, which is the only place
        // a deferred missing verdict could still surface.
        await settle(1500);
        expect(await anyVerdictShowing(app)).toBe(false);
        expect(readFileSync(fixture.file, "utf8")).toBe(MERGED_BODY);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
