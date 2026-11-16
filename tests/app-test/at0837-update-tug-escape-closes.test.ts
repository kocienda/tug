/**
 * at0837-update-tug-escape-closes — Escape closes the Update Tug wizard, the
 * way it closes every other dialog (the sibling of #173).
 *
 * Escape is the same act as the wizard's bottom button on every stage: Close
 * on a stage still in flight, Done on `upToDate`, which also posts `dismiss`
 * so Sparkle is not left waiting on a reply. The keyboard's Escape reaches the
 * overlay page as the `cancelDialog` command, dispatched at capture; a wizard
 * that does not answer it never sees its own Radix `onEscapeKeyDown`, because
 * the overlay forwards the unanswered command to the shell.
 *
 * Driven from the bridge with the action recorder in front of `updateAction`,
 * as `at0612` is, so nothing here reaches Sparkle.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/update-tug.tsx
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  clearPosted,
  goIdle,
  nextReveal,
  postedActions,
  push,
  snapshot,
  waitForWizard,
  waitForWizardGone,
  withUpdateDeck,
} from "./update-tug-fixture";

describe.skipIf(!SHOULD_RUN)("AT0837: Escape closes the Update Tug wizard", () => {
  test(
    "a native Escape is the bottom button, on a live stage and on a terminal one",
    () =>
      withUpdateDeck("at0837-update-tug-escape-closes", async (app) => {
        // A stage in flight: Escape is Close, and posts nothing.
        await goIdle(app);
        await push(app, snapshot("available", { revealCount: nextReveal() }));
        await waitForWizard(app, "available");
        await clearPosted(app);
        await app.nativeKey("Escape");
        await waitForWizardGone(app);
        expect(await postedActions(app), "Close posts nothing").toEqual([]);
        note("at0837 available", "Escape closed the wizard");

        // A terminal stage: Escape is Done, and acknowledges with `dismiss`.
        await goIdle(app);
        await push(app, snapshot("upToDate", { revealCount: nextReveal() }));
        await waitForWizard(app, "upToDate");
        await clearPosted(app);
        await app.nativeKey("Escape");
        await waitForWizardGone(app);
        await app.waitForCondition<boolean>(`window.__at0612.posted.indexOf("dismiss") !== -1`, {
          timeoutMs: 10_000,
        });
        note("at0837 upToDate", "Escape closed the wizard and posted dismiss");
      }),
    TEST_TIMEOUT_MS,
  );
});
