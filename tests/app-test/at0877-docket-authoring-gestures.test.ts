/**
 * at0877-docket-authoring-gestures.test.ts — Keep sketch opens a session on
 * its command, and Open arc on a stale brief asks first.
 *
 * One half of the authoring-gesture pair, a launch to a file so each fits
 * its budget; Write brief, Revise brief and Open arc's command are
 * at0879-docket-brief-arc-gestures.
 *
 * ## What this gates
 *
 * The unit tests pin which gestures a thread offers, the command each opens
 * with and the stale question's words. What only the app can show is the
 * press through the card's responder, the fresh Session card it opens, that
 * card's runner sending the command as its first turn, and the confirm
 * standing between a press and an arc opened on an older brief.
 *
 *   A. **Keep sketch** on an idea sketched in a session opens a card whose
 *      first turn is `/tugplug:keep-sketch <idea id>`.
 *   B. **A stale brief asks first.** With a brief written from sketch v1 and
 *      the sketch moved to v2, Open arc shows the stale confirm naming both
 *      versions, and Cancel closes it with no card opened.
 *
 * @covers tugdeck/src/components/docket/docket-card.tsx
 * @covers tugdeck/src/lib/docket-authoring.ts
 * @covers tugdeck/src/lib/opening-command-runner.ts
 * @covers tugdeck/src/lib/action-vocabulary.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  awaitOpenedSession,
  captureIdea,
  gesturesOn,
  ideaId,
  keepSketch,
  launchAuthoring,
  makeAuthoringScratch,
  newDocket,
  pressGesture,
  recordBrief,
  rmAuthoringScratch,
  sessionCards,
  type AuthoringScratch,
} from "./docket-authoring-fixture";

const SID = "aa11bb22-0000-4000-8000-00000000a877";
const IDEA = "a rail of the arcs in flight";
const CONFIRM = '[data-slot="tug-confirm-popover"]';
const CONFIRM_MESSAGE = '[data-slot="tug-confirm-message"]';
const CONFIRM_CANCEL = '[data-slot="tug-confirm-cancel"]';

let s: AuthoringScratch | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  s = makeAuthoringScratch("at0877", SID);
});

afterAll(() => {
  rmAuthoringScratch(s);
});

describe.skipIf(!SHOULD_RUN)("at0877 — Keep sketch and the stale confirm", () => {
  test(
    "Keep sketch opens its command, and Open arc on a stale brief asks and Cancel opens nothing",
    async () => {
      const { app, close } = await launchAuthoring(s!, "at0877-docket-authoring-gestures");
      try {
        await newDocket(app, "Rails");
        await captureIdea(app, IDEA);
        const idea = ideaId(s!, IDEA);
        // Keep sketch is offered once the idea has been sketched in a session.
        let known = await sessionCards(app);
        await pressGesture(app, IDEA, "sketch-it");
        await awaitOpenedSession(app, known, [IDEA]);

        // ---- A. Keep sketch. -----------------------------------------------
        known = await sessionCards(app);
        await pressGesture(app, IDEA, "keep-sketch");
        await awaitOpenedSession(app, known, ["keep-sketch", idea]);

        // ---- B. A stale brief asks first. ----------------------------------
        const sketch = keepSketch(s!, idea, "Want a rail of the arcs in flight.", "1–2");
        recordBrief(s!, sketch, "arc-rail", 1);
        keepSketch(s!, idea, "Want a rail of the arcs in flight, and their fates.", "1–4");
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector('[data-slot="docket-brief-cell"][data-stale="true"]') !== null`,
          { timeoutMs: 15_000 },
        );
        known = await sessionCards(app);
        await pressGesture(app, IDEA, "open-arc");
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM_MESSAGE)}) !== null`,
          { timeoutMs: 5_000 },
        );
        expect(
          await app.body("D").evalJS<string>(
            `(document.querySelector(${JSON.stringify(CONFIRM_MESSAGE)}).textContent || "").trim()`,
          ),
        ).toBe("This brief was written from sketch v1; the sketch is now v2. Open the arc on it anyway?");
        await app.body("D").nativeClickAtElement(CONFIRM_CANCEL);
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) === null`,
          { timeoutMs: 5_000 },
        );
        // Confirm is the only door to the open; Cancel closed it with no card.
        expect(await sessionCards(app)).toEqual(known);
        expect(await gesturesOn(app, IDEA)).toContain("open-arc");
      } finally {
        await close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
