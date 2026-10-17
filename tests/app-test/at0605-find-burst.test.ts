/**
 * at0605-find-burst.test.ts — ten unawaited ⌘G presses end somewhere
 * coherent.
 *
 * ## Why this exists
 *
 * The reveal WAS a `requestAnimationFrame` chain guarded by one shared
 * boolean, so a second gesture arriving while the first was in flight did
 * not supersede it — both loops ran, both wrote the scroller, and whichever
 * finished last won. A user leaning on ⌘G is the ordinary way to produce
 * that. It is now `TugListView.revealRange`, one live reveal per list view,
 * and a new one settles the old as `superseded`. The assertion is only that
 * the viewport and the chip agree at the end: the active match in band and
 * still over the last ten sampled frames, and the chip naming the ordinal
 * the find trace says the burst landed on.
 *
 * ## Expected state
 *
 * Green. It was red when written and went green at the step that replaced
 * the shared boolean with the list view's one live reveal. A red here now is
 * a regression in the reveal machine's supersede rule.
 *
 * @covers tugdeck/src/lib/transcript-find-engine.ts
 * @covers tugdeck/src/lib/find-session.ts
 * @covers tugdeck/src/lib/find-trace.ts
 * @covers tugdeck/src/components/tugways/transcript-find-highlighter.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @family at0605-find
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import {
  awaitGestureReveal,
  chord,
  markTrace,
  openFindBar,
  readChip,
  readReveal,
  sampleReveal,
  seedProseTurns,
  sessionDeckShape,
  sessionSelectors,
  standUpSession,
  tail,
  traceSince,
} from "./find-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const SID = "c7c0d1ea-0000-4000-8000-000000000605";
const SEL = sessionSelectors("A");
const PROBE = "cobaltmarker";
const TURNS = 25;

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

describe.skipIf(!SHOULD_RUN)("AT0605a: a burst of ⌘G ends somewhere coherent", () => {
  test(
    "ten presses with nothing awaited between them leave the viewport and the chip agreeing",
    async () => {
      const app = await launchTugApp({ testName: "at0605a-find-burst" });
      try {
        await standUpSession(app, "A", SID, sessionDeckShape(["A"]));
        await seedProseTurns(app, "A", SID, TURNS, replyText);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll('${SEL.card} [data-tug-list-cell-index]').length > 4`,
          { timeoutMs: 60_000 },
        );

        await openFindBar(app);
        const typed = await markTrace(app.body("A"));
        await app.nativeType(PROBE);
        await app.body("A").waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(SEL.chip)})?.textContent || "") !== ""`,
          { timeoutMs: 20_000 },
        );
        // The query's own reveal is over before the burst starts.
        await awaitGestureReveal(app.body("A"),typed, PROBE);
        const total = Number((await readChip(app)).split(" of ")[1] ?? "0");
        expect(total, "there must be a match set to walk").toBeGreaterThan(10);

        const mark = await markTrace(app.body("A"));
        // Ten presses, nothing awaited between the dispatches — the shape a
        // user leaning on the key produces.
        const bursts: Array<Promise<void>> = [];
        for (let i = 0; i < 10; i += 1) bursts.push(chord(app.body("A"),"KeyG", "g", { meta: true }));
        await Promise.all(bursts);

        // The newest gesture's own reveal: every earlier one settles
        // `superseded`, and waiting on the first terminal would sample a
        // scroller still moving toward the last.
        const terminal = await awaitGestureReveal(app.body("A"),mark, undefined, 20_000);
        note(`burst terminal event: ${JSON.stringify(terminal)}`);
        const samples = await sampleReveal(app, 300);
        const last10 = tail(samples);
        const events = await traceSince(app.body("A"), mark);
        const outcomes = events
          .filter((e) => e.kind === "reveal")
          .map((e) => `${String(e.outcome)}:${String(e.reason)}`);
        note(`burst reveal outcomes: ${JSON.stringify(outcomes)}`);

        const reveal = await readReveal(app);
        const gesture = events.filter((e) => e.kind === "gesture").pop() ?? null;
        note(`burst settled reveal: ${JSON.stringify(reveal)}`);
        note(`burst last gesture: ${JSON.stringify(gesture)}`);

        expect(
          last10.every((s) => s.inView),
          `after the burst the active match is off band in ${last10.filter((s) => !s.inView).length}/10 frames`,
        ).toBe(true);
        expect(
          new Set(last10.map((s) => Math.round(s.scrollTop))).size,
          "the scroller must be still once the burst has settled",
        ).toBe(1);
        const ordinal = gesture === null ? null : (gesture.activeOrdinal as number | null);
        expect(ordinal, "the trace must know which match the burst landed on").not.toBeNull();
        expect(
          last10[last10.length - 1].chip.trim(),
          "the chip must name the match the viewport is showing",
        ).toBe(`${(ordinal ?? 0) + 1} of ${total}`);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
