/**
 * at0605-find-second-card.test.ts — a second card streaming while the
 * first searches does not erase the first card's find paint.
 *
 * ## Why this exists
 *
 * `CSS.highlights` names are document-GLOBAL and each Session card used to
 * `delete` them, so a card that was not even searching erased the searching
 * card's paint the moment it repainted. Thirty streamed frames into card `B`
 * is what a live turn looks like. The two highlight objects are now
 * registered once and shared, and a painter retracts only the ranges it
 * added.
 *
 * The collision is live wherever two Session cards share one document —
 * which they do with bodies off, as this test runs: both cards paint into
 * the one page's highlight registry. After every frame streamed into `B`,
 * card `A` must still hold at least one painted range.
 *
 * ## Expected state
 *
 * Green. It was red when written and went green at the step that shared
 * the highlight objects. A red here now is a painter retracting ranges it
 * did not add.
 *
 * @covers tugdeck/src/components/tugways/transcript-find-highlighter.ts
 * @covers tugdeck/src/lib/transcript-find-engine.ts
 * @covers tugdeck/src/lib/find-session.ts
 * @family at0605-find
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import {
  awaitGestureReveal,
  framer,
  markTrace,
  openFindBar,
  seedProseTurns,
  sessionDeckShape,
  sessionSelectors,
  standUpSession,
} from "./find-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const SEL = sessionSelectors("A");
const PROBE = "cobaltmarker";
const TURNS = 8;

function replyText(n: number): string {
  return [
    `## step ${n}`,
    "",
    `Reply number ${n} carries the ${PROBE} once, in prose long enough that`,
    "the row occupies real height and the transcript grows past a viewport.",
    "",
    `- line ${n}`,
  ].join("\n");
}

describe.skipIf(!SHOULD_RUN)("AT0605c: a second card does not erase the first card's paint", () => {
  test(
    "streaming into card B leaves card A's find highlights intact",
    async () => {
      const app = await launchTugApp({ testName: "at0605c-find-two-cards" });
      try {
        const sidA = "c7c0d1ea-0000-4000-8000-000000000607";
        const sidB = "c7c0d1ea-0000-4000-8000-000000000608";
        await standUpSession(
          app,
          "A",
          sidA,
          sessionDeckShape(["A", "B"], { width: 700, height: 620 }),
        );
        await standUpSession(app, "B", sidB);
        await seedProseTurns(app, "A", sidA, TURNS, replyText);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll('${SEL.card} [data-tug-list-cell-index]').length > 3`,
          { timeoutMs: 40_000 },
        );

        await openFindBar(app);
        const mark = await markTrace(app.body("A"));
        await app.nativeType(PROBE);
        await app.body("A").waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(SEL.chip)})?.textContent || "") !== ""`,
          { timeoutMs: 20_000 },
        );
        await awaitGestureReveal(app.body("A"),mark, PROBE);
        const before = await app.body("A").evalJS<number>(`(function () {
  var hl = CSS.highlights.get('transcript-find-match');
  var n = 0; if (hl) { for (var _ of hl) n += 1; }
  return n;
})()`);
        note(`painted matches in card A before B streams: ${before}`);
        expect(before, "card A must be painting before B is asked to disturb it").toBeGreaterThan(0);

        // Thirty partial frames into B — what one live turn looks like.
        const frameB = framer(app, "B", sidB);
        await app.driveSession("B", { op: "send", text: "start streaming" });
        await frameB({ type: "prompt_anchor", promptUuid: `${sidB}-u0` });
        await frameB({
          type: "content_block_start",
          msg_id: `${sidB}-m0`,
          block_index: 0,
          kind: "text",
        });
        const losses: number[] = [];
        for (let i = 0; i < 30; i += 1) {
          await frameB({
            type: "assistant_text",
            seq: 0,
            rev: 0,
            status: "partial",
            msg_id: `${sidB}-m0`,
            block_index: 0,
            text: `streaming token ${i} `.repeat(i + 1),
            is_partial: true,
          });
          const state = await app.body("A").evalJS<{ inA: number; total: number }>(`(function () {
  var out = { inA: 0, total: 0 };
  for (var name of ['transcript-find-match', 'transcript-find-active']) {
    var hl = CSS.highlights.get(name);
    if (!hl) continue;
    for (var r of hl) {
      out.total += 1;
      var el = r.startContainer.parentElement;
      if (el && el.closest('${SEL.card}')) out.inA += 1;
    }
  }
  return out;
})()`);
          if (state.inA === 0) losses.push(i);
        }
        await frameB({ type: "turn_complete", seq: 0, msg_id: `${sidB}-m0`, result: "success" });

        note(`frames after which card A held no paint: ${JSON.stringify(losses)}`);
        expect(
          losses.length,
          `card A lost its find paint after ${losses.length} of 30 frames streamed into card B`,
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
