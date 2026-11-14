/**
 * AT0612: an offered Tug that needs a newer Claude Code says so before it
 * installs, and holds the install until that is settled.
 *
 * A release states the oldest Claude Code it runs against, and the host
 * carries that floor on the update snapshot. When this Mac is under it, the
 * wizard draws a fifth row — *Update Claude Code* — between Download and Stop
 * work, with the floor and the installed version named on it and an Update
 * button, and the install row stays pending behind it. Declining therefore
 * leaves the running Tug in place, which is the point of the row.
 *
 * Both halves come in the way they do in the app: the snapshot on
 * `window.__tugBridge.onUpdateState`, the installed version as a
 * `claude_version_result` frame in the page the wizard reads it in.
 *
 * What is pinned:
 *   1. With a floor above the installed version, the row stands in its place,
 *      names both versions, is the active step and carries Update.
 *   2. The Stop-work and install rows are pending behind it, and there is no
 *      Install and Relaunch button to press.
 *   3. The same stage with no floor stated is the four-row wizard, with the
 *      install offered.
 *
 * The Update button is not pressed: under the harness tugcast is real, and
 * the press would update the Claude Code on the machine running the test. The
 * derivation of every state past the press is pinned in
 * `update-tug-rows.test.ts`.
 *
 * The wizard re-reads the installed version when it is raised on an offer
 * that states a floor, and that answer comes from the real `claude` here. The
 * floor used is one no real version reaches, so whichever reading is on the
 * row — the injected one or the machine's — every claim below except the
 * exact sentence holds, and the sentence is waited for rather than read once.
 *
 * @covers tugdeck/src/components/tugways/update-tug.tsx
 * @covers tugdeck/src/components/tugways/update-tug-rows.tsx
 * @covers tugdeck/src/components/tugways/claude-download-progress.tsx
 * @covers tugdeck/src/lib/claude-version-store.ts
 * @covers tugdeck/src/lib/update-store.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  SHOULD_RUN,
  STEP_ROWS,
  TEST_TIMEOUT_MS,
  cta,
  elementCount,
  goIdle,
  nextReveal,
  push,
  snapshot,
  stepKeys,
  stepStatuses,
  ui,
  waitForWizard,
  withUpdateDeck,
} from "./update-tug-fixture";

/** A floor no released Claude Code reaches. */
const FLOOR = "99.0.0";
const INSTALLED = "2.1.200";

const CLAUDE_ROW = `${STEP_ROWS}[data-step="update-claude"]`;
const CLAUDE_DETAIL = `(function () {
  var el = document.querySelector(${JSON.stringify(`${CLAUDE_ROW} .tug-step-row-detail`)});
  return el === null ? "" : (el.textContent || "").trim();
})()`;

describe.skipIf(!SHOULD_RUN)("AT0612: an offered version's Claude Code floor", () => {
  test(
    "a floor above the installed version draws the Claude Code row and holds the install",
    () =>
      withUpdateDeck("at0612-update-tug-claude-floor", async (app) => {
        await goIdle(app);
        await push(
          app,
          snapshot("readyToInstall", {
            claudeCodeFloor: FLOOR,
            revealCount: nextReveal(),
          }),
        );
        await waitForWizard(app, "readyToInstall");

        await ui(app).evalJS<null>(
          `(window.tugdeck.lab.dispatch("claude_version_result", { installed: ${JSON.stringify(INSTALLED)}, latest: "2.1.325" }), null)`,
        );
        const sentence = `This update needs Claude Code ${FLOOR}; you have ${INSTALLED}.`;
        await ui(app).waitForCondition<boolean>(
          `${CLAUDE_DETAIL} === ${JSON.stringify(sentence)}`,
          { timeoutMs: 5000 },
        );
        note("at0612 claude floor row", sentence);

        // The row stands between Download and Stop work, and it is the step
        // the wizard is on.
        expect(await stepKeys(app)).toEqual([
          "check",
          "download",
          "update-claude",
          "stop-work",
          "relaunch",
        ]);
        expect(await stepStatuses(app)).toEqual([
          "done",
          "done",
          "active",
          "pending",
          "pending",
        ]);
        expect(await elementCount(app, cta("update-claude"))).toBe(1);
        expect(await ui(app).getElementText(cta("update-claude"))).toContain("Update");

        // The install is held: nothing to press on its row, and none on the
        // Stop-work row either, whose turn has not come.
        expect(await elementCount(app, cta("install"))).toBe(0);
        expect(await elementCount(app, cta("stop-work"))).toBe(0);

        // No floor stated: the wizard as it was, with the install offered.
        await goIdle(app);
        await push(app, snapshot("readyToInstall", { revealCount: nextReveal() }));
        await waitForWizard(app, "readyToInstall");
        expect(await stepKeys(app)).toEqual(["check", "download", "stop-work", "relaunch"]);
        expect(await elementCount(app, CLAUDE_ROW)).toBe(0);
        expect(await elementCount(app, cta("install"))).toBe(1);

        await goIdle(app);
      }),
    TEST_TIMEOUT_MS,
  );
});
