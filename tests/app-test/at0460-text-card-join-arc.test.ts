/**
 * at0460-text-card-join-arc.test.ts — a Text card bound inside an arc worktree that a join removes whole re-anchors to the repo-root successor.
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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  anyVerdictShowing,
  launchOnFixture,
  mkFixture,
  settle,
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
    "a card inside a joined arc worktree re-anchors to the repo-root successor",
    async () => {
      // What a join does to an arc's own worktree is remove it whole
      // (`remove_arc_worktree`), which leaves a card bound inside it holding a
      // path that is genuinely gone. This drives that teardown directly rather
      // than through `tugtool arc join`: the join pipeline — resolver, tier
      // checks, candidate — is a different subject, and none of it is what the
      // card reacts to. The directory removal is the real event either way.
      const fixture = mkFixture("at0460-arc");
      openFixture = fixture;
      const worktree = join(fixture.repo, ".tug", "worktrees", "somearc");
      mkdirSync(join(worktree, "src"), { recursive: true });
      const inArc = join(worktree, "src", "work.txt");
      writeFileSync(inArc, "arc line one\narc line two\n");
      // The successor: the same relative path under the repo root, holding the
      // joined content.
      mkdirSync(join(fixture.repo, "src"), { recursive: true });
      const successor = join(fixture.repo, "src", "work.txt");
      writeFileSync(successor, "SUCCESSOR line one\nSUCCESSOR line two\n");

      const { app, tugbankPath } = await launchOnFixture(
        fixture,
        "at0460-arc-successor",
        {
          openFile: inArc,
          sentinel: "arc line one",
          body: "arc line one\narc line two\n",
        },
      );
      openTugbank = tugbankPath;
      try {
        rmSync(worktree, { recursive: true, force: true });

        // Positive proof again: the editor can only hold these bytes by having
        // re-anchored to the successor and read it.
        await waitForEditorShowing(app, "SUCCESSOR line one", 30000);
        expect(await anyVerdictShowing(app)).toBe(false);
        await settle(1500);
        expect(await anyVerdictShowing(app)).toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
