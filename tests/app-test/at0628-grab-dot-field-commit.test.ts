/**
 * at0628-grab-dot-field-commit.test.ts — a commit card is content, so its
 * masthead wears the grab-dot field too.
 *
 * One of the at0628-grab-dot-field split, a test to a file so each launch
 * fits its own budget. Why the field is drawn the way it is, the deck, the
 * readers and the fixtures are `grab-dot-field-fixture.ts`.
 *
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/tugways/session-masthead.css
 * @covers tugdeck/src/components/tugways/card-masthead.css
 * @covers tugdeck/src/components/tugways/commit-masthead.css
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/tug-session-row.tsx
 * @family at0628-grab-dot-field
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  COMMIT_CARD,
  REPO,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  expectTheField,
  readLine,
  wait,
} from "./grab-dot-field-fixture";

describe.skipIf(!SHOULD_RUN)("at0628 — the grab-dot field", () => {
  test(
    "a commit card is content, so its masthead wears the field too",
    async () => {
      const sha = Bun.spawnSync(["git", "-C", REPO, "show", "-s", "--format=%H", "HEAD"])
        .stdout.toString()
        .trim();

      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
        const app = await launchTugApp({
          testName: "at0628-grab-dot-field-commit",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, {
            timeoutMs: 15_000,
          });
          await app.seedDeckState({
            state: {
              cards: [{ id: "C", componentId: "commit", title: "Commit", closable: true }],
              panes: [
                {
                  id: "pC",
                  position: { x: 40, y: 40 },
                  size: { width: 720, height: 640 },
                  cardIds: ["C"],
                  activeCardId: "C",
                  title: "",
                  acceptsFamilies: ["maker"],
                },
              ],
              activePaneId: "pC",
              hasFocus: true,
            },
            cardStates: {
              C: { content: { target: { root: REPO, sha: sha.slice(0, 8) } } },
            },
            focusCardId: "C",
          });
          // The commit card is in its own body, and draws its masthead there.
          await app.body("C").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMMIT_CARD)}) !== null`,
            { timeoutMs: 15_000 },
          );
          await app.body("C").waitForCondition<boolean>(
            `document.querySelector('.commit-masthead-row .tug-session-row-name-line') !== null`,
            { timeoutMs: 15_000 },
          );
          await wait(AFTER_LAND_MS);

          const commit = await readLine(
            app.body("C"),
            ".commit-masthead-row .tug-session-row-name-line",
          );
          note(`commit tier: ${JSON.stringify(commit)}`);

          // A commit card is CONTENT: the exclusion is a rail's, and a commit
          // card is dragged by its bar like any other document.
          expectTheField("the commit tier", commit);
          expect(commit?.titleGrow, "the commit tier's grow moved to the field").toBe("0");
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
