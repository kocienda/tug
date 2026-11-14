/**
 * at0460-text-card-join-delete.test.ts — a real delete under a clean buffer still verdicts after the settle window, as the non-modal banner, and the banner clears by itself when the file returns.
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
import { rmSync, writeFileSync } from "node:fs";

import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  MISSING_BANNER,
  SAVE_SHEET,
  anyVerdictShowing,
  launchOnFixture,
  mkFixture,
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
    "a real delete under a clean buffer is a banner, and it clears when the file returns",
    async () => {
      const fixture = mkFixture("at0460-delete");
      openFixture = fixture;
      const { app, tugbankPath } = await launchOnFixture(
        fixture,
        "at0460-delete-banner",
      );
      openTugbank = tugbankPath;
      try {
        // A genuine delete still verdicts — the settle window defers it, it
        // never swallows it.
        rmSync(fixture.file);
        await app.body("B").waitForCondition<boolean>(
          `document.querySelector('${MISSING_BANNER}') !== null`,
          { timeoutMs: 20000 },
        );
        // Nothing was at risk, so it is the banner and not the modal sheet.
        expect(
          await app.body("B").evalJS<boolean>(
            `document.querySelector('${SAVE_SHEET}') !== null`,
          ),
        ).toBe(false);

        // Someone puts the file back. No gesture from the user.
        writeFileSync(fixture.file, "RESTORED line one\nRESTORED line two\n");
        await app.body("B").waitForCondition<boolean>(
          `document.querySelector('${MISSING_BANNER}') === null`,
          { timeoutMs: 20000 },
        );
        await waitForEditorShowing(app, "RESTORED line one");
        expect(await anyVerdictShowing(app)).toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
