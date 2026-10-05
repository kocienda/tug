/**
 * at0696-settle-fold-stamp.test.ts — the fold's gesture stamp is spent once.
 *
 * A session card's fold has no transform in it: its term is a real `height`,
 * so the settle's record measures from the GESTURE, through the stamp
 * `setPaneFolded` publishes, and carries the lead as a gap. That stamp is
 * never retired, so the settle that follows a fold by a second finds a fresh
 * stamp that belongs to somebody else. This file holds that the next settle
 * measures from its own arm.
 *
 * `deck-manager.ts` is deliberately NOT named: it already fans out past the
 * selection budget, and what this leg needs covered is the stamp's CONTRACT —
 * when it may be published and when it may not — which is
 * `deck-manager-store.ts`'s doc comment.
 *
 * The instrument, the fixture decks, the transcript arms and the bar are
 * `settle-frames-fixture.ts`'s; this file is one gesture's legs. Every card is
 * a session card bound to a real resumed transcript, and every leg runs on the
 * `slice` arm and, where the local corpus holds a whale, the `whale` arm.
 * These legs were `at0622-deck-settle-frames`, which carried every gesture in
 * one file and so selected — and paid for — all of them on a change to any one.
 *
 * @covers tugdeck/src/deck-manager-store.ts
 * @covers tugdeck/src/lib/fold-crossing.ts
 * @covers tests/app-test/real-transcript-fixture.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  BAR_TIMEOUT_MS,
  SHOULD_RUN,
  blobFor,
  home,
  launch,
  report,
  sampleBarActivation,
  sampleFold,
  traceWithSettleFrames,
  wait,
  transcriptArms,
} from "./settle-frames-fixture";

const TEST_NAME = "at0696-settle-fold-stamp";
const ARMS = transcriptArms();

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0696 — the fold's gesture stamp [${arm.size}]`,
  () => {
    test(
      "the fold's gesture stamp is spent once — the next settle measures from its own arm",
      async () => {
        // The stamp `setPaneFolded` publishes is never retired: nothing in the
        // store knows when it has been read. So the settle that FOLLOWS a fold
        // by a second or two finds a stamp that is fresh — well inside the
        // reader's five-second staleness guard — and belongs to somebody else.
        // Unguarded, this activation would report the whole distance back to
        // the fold as dead lead, in the row [D9]'s guard and the bar above both
        // read.
        const { app, tugbankPath } = await launch(4, blobFor(4), TEST_NAME, { transcripts: arm.size });
        try {
          await traceWithSettleFrames(app);
          await home(app);
          await wait(AFTER_LAND_MS);

          const fold = await sampleFold(app, true, 0);
          note(`at0696 spend-once fold row: ${JSON.stringify(fold.row)}`);
          expect(
            fold.row.commitDelayMs,
            `the fold itself DID measure from its stamp — a zero here would ` +
              `mean the clause below passed by there being no stamp to spend`,
          ).toBeGreaterThan(0);

          const after = await sampleBarActivation(app, 4, 0);
          note(`at0696 spend-once next row: ${JSON.stringify(after.row)}`);
          expect(
            after.row.commitDelayMs,
            `the activation is a gesture of its own and leaves no stamp, so ` +
              `its record measures from its own arm — ${after.row.commitDelayMs}ms ` +
              `here is the fold's stamp being spent a second time`,
          ).toBe(0);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      BAR_TIMEOUT_MS,
    );
  },
);
