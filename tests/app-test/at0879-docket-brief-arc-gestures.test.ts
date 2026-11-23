/**
 * at0879-docket-brief-arc-gestures.test.ts — Write brief, Revise brief and
 * Open arc each open a Session card whose first turn is their command.
 *
 * The other half of the authoring-gesture pair, a launch to a file so each
 * fits its budget; Keep sketch and the stale confirm are
 * at0877-docket-authoring-gestures.
 *
 * ## What this gates
 *
 * The unit tests pin the exact arguments each gesture opens with. What only
 * the app can show is the thread redrawn from the real server between rungs
 * and each press sending its command as a fresh card's first turn.
 *
 *   A. **Write brief** on a kept sketch opens `/tugplug:brief --sketch <id>`.
 *   B. **Revise brief** on a brief written from it opens
 *      `/tugplug:brief --sketch <id> --revise`.
 *   C. **Open arc** on that brief opens `/tugplug:arc <slug> <path>`.
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

const SID = "aa11bb22-0000-4000-8000-00000000a879";
const IDEA = "a brief for every kept sketch";

let s: AuthoringScratch | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  s = makeAuthoringScratch("at0879", SID);
});

afterAll(() => {
  rmAuthoringScratch(s);
});

describe.skipIf(!SHOULD_RUN)("at0879 — Write brief, Revise brief and Open arc", () => {
  test(
    "each gesture opens a Session card whose first turn is its command with its exact arguments",
    async () => {
      const { app, close } = await launchAuthoring(s!, "at0879-docket-brief-arc-gestures");
      try {
        await newDocket(app, "Briefs");
        await captureIdea(app, IDEA);
        const sketch = keepSketch(s!, ideaId(s!, IDEA), "Want a brief for every kept sketch.", "1–2");

        // ---- A. Write brief. -----------------------------------------------
        let known = await sessionCards(app);
        await pressGesture(app, IDEA, "write-brief");
        const written = await awaitOpenedSession(app, known, ["brief", `--sketch ${sketch}`]);
        expect(written.turn).not.toContain("--revise");

        // ---- B. Revise brief. ----------------------------------------------
        const path = recordBrief(s!, sketch, "kept-briefs", 1);
        known = await sessionCards(app);
        await pressGesture(app, IDEA, "revise-brief");
        await awaitOpenedSession(app, known, ["brief", `--sketch ${sketch} --revise`]);

        // ---- C. Open arc. --------------------------------------------------
        known = await sessionCards(app);
        await pressGesture(app, IDEA, "open-arc");
        await awaitOpenedSession(app, known, ["arc", `kept-briefs ${path}`]);
      } finally {
        await close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
