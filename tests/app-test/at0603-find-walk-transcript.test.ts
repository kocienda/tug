/**
 * at0603-find-walk-transcript.test.ts — ⌘G, N+1 times, over a long mixed
 * transcript, and every step lands where it says it does.
 *
 * ## Why this exists
 *
 * The user's report is a *walk*: find "confidently skips around a
 * transcript, highlights the wrong thing, or fails to bring its match into
 * view". No single-gesture test reproduces that, because every individual
 * gesture usually works. What broke was the sequence — a reveal that
 * outlived its frame budget and stayed armed forever, a later gesture racing
 * the earlier one through one shared boolean, an ordinal that drifted out of
 * agreement with the chip.
 *
 * So this walks the whole match set and asserts three things at every step,
 * each over a SAMPLED window rather than one reading ([P10]):
 *
 *   1. the active range's text satisfies the query;
 *   2. its rect is inside the visible band, and the scroll offset is
 *      constant across the last ten frames (a match that is in view in the
 *      frame we looked at and moving in the ten around it has not landed);
 *   3. its position agrees with the chip — `"<k> of <N>"` where `k` is the
 *      ordinal the product's own find trace recorded for that gesture,
 *      computed independently of the chip.
 *
 * Counting painted ranges is deliberately NOT how `k` is checked: only
 * mounted rows are painted, so the painted count answers a different
 * question. The trace's `gesture.activeOrdinal` is the engine's own answer.
 *
 * A fourth assertion rides the same walk: the active row index is
 * non-decreasing across forward steps until the wrap. A walk that jumps
 * backwards mid-run is the "drunkard's walk" in its most legible form.
 *
 * ## Expected state
 *
 * Green. It was written with its outcome unknown — the brief's evidence had
 * been read from the code and never reproduced in the running app — and it
 * came good once the painter stopped re-searching and started resolving each
 * match at its own offsets.
 *
 * ## What this declares, and what it deliberately does not
 *
 * `session-card-transcript.tsx` fans out past the selection budget, and the
 * budget allows exactly one of this arc's new tests to name it. That slot
 * goes to `at0605`, whose adversarial cases have no other honest anchor —
 * (c) and (d) are about what the transcript host does with the painter and
 * the anchor, and nothing else. This walk has several: the ordinal it checks
 * is the engine's, the chip is the session's, the paint is the painter's,
 * and the reveal it asserts placement from is the list view's, which is
 * declared here for that reason.
 *
 * @covers tugdeck/src/components/tugways/transcript-find-highlighter.ts
 * @covers tugdeck/src/lib/transcript-find-engine.ts
 * @covers tugdeck/src/lib/transcript-search-index.ts
 * @covers tugdeck/src/lib/find-session.ts
 * @covers tugdeck/src/lib/find-trace.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";
import {
  awaitRevealTerminal,
  chord,
  framer,
  lastGesture,
  markTrace,
  openFindBar,
  readChip,
  readReveal,
  sampleReveal,
  sessionDeckShape,
  sessionSelectors,
  standUpSession,
  tail,
} from "./find-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 900_000;
const SID = "c7c0d1ea-0000-4000-8000-000000000603";
const SEL = sessionSelectors("A");

/** Planted a known number of times, in three different row kinds. */
const PROBE = "vermilionstep";
const TURNS = 60;

/**
 * Per turn: once in the reply prose, once in a Bash command (a tool HEADER
 * match), and — every third turn — once in a shell exchange's command. The
 * expected total is computed rather than written down, so a fixture change
 * cannot silently make the assertion weaker.
 */
function expectedMatches(turns: number): number {
  let n = 0;
  for (let i = 0; i < turns; i += 1) {
    n += 2;
    if (i % 3 === 0) n += 1;
  }
  return n;
}

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

async function seedMixedTurns(app: App, turns: number): Promise<void> {
  const frame = framer(app, "A", SID);
  for (let n = 0; n < turns; n += 1) {
    const msgId = `${SID}-m${n}`;
    await app.driveSession("A", { op: "send", text: `prompt ${n}` });
    await frame({ type: "prompt_anchor", promptUuid: `${SID}-u${n}` });
    await frame({
      type: "tool_use",
      msg_id: msgId,
      tool_use_id: `${SID}-tu${n}`,
      tool_name: "Bash",
      input: { command: `grep -n "${PROBE}" /tmp/at0603/log${n}`, description: `step ${n}` },
    });
    await frame({
      type: "tool_result",
      tool_use_id: `${SID}-tu${n}`,
      output: `step ${n} done`,
      is_error: false,
    });
    await frame({
      type: "content_block_start",
      msg_id: msgId,
      block_index: 0,
      kind: "text",
    });
    await frame({
      type: "assistant_text",
      msg_id: msgId,
      block_index: 0,
      text: replyText(n),
      is_partial: false,
    });
    await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
    if (n % 3 === 0) {
      await app.driveSession("A", {
        op: "shellExchange",
        exchangeId: `${SID}-x${n}`,
        command: `echo ${PROBE} ${n}`,
        output: `shell step ${n}`,
        cwd: "/tmp",
        exitCode: 0,
        startedAtMs: 1_700_000_000_000 + n,
      });
    }
  }
}

describe.skipIf(!SHOULD_RUN)("AT0603: every ⌘G step lands where the chip says", () => {
  test(
    "a full walk over a long mixed transcript agrees with itself at every step",
    async () => {
      const app = await launchTugApp({ testName: "at0603-find-walk-transcript" });
      try {
        await standUpSession(app, "A", SID, sessionDeckShape(["A"]));
        await seedMixedTurns(app, TURNS);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${SEL.card} [data-tug-list-cell-index]').length > 4`,
          { timeoutMs: 60_000 },
        );
        await new Promise((r) => setTimeout(r, 1500));

        await openFindBar(app);
        await app.nativeType(PROBE);
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(SEL.chip)})?.textContent || "") !== ""`,
          { timeoutMs: 20_000 },
        );
        await new Promise((r) => setTimeout(r, 1500));

        const firstChip = await readChip(app);
        const total = Number(firstChip.split(" of ")[1] ?? "0");
        note(`opening chip: ${JSON.stringify(firstChip)} (expected total ${expectedMatches(TURNS)})`);
        expect(total, "the chip must report a match set to walk").toBeGreaterThanOrEqual(80);
        expect(total, "the count must be the one the fixture plants").toBe(
          expectedMatches(TURNS),
        );

        // N+1 presses: one past the end, so the wrap is walked too.
        const failures: string[] = [];
        let lastRow = -1;
        let wrapped = false;
        for (let step = 0; step < total + 1; step += 1) {
          const mark = await markTrace(app);
          await chord(app, "KeyG", "g", { meta: true });
          const terminal = await awaitRevealTerminal(app, mark, 12_000);
          if (terminal === null) {
            failures.push(`step ${step}: the reveal never reported a terminal event`);
            continue;
          }
          // Nobody touches the scroller during the walk, so every reveal
          // owes `landed`. A match that ends up in view under a reveal that
          // settled `cancelled` is the list's own correction write read as a
          // user scroll — invisible to the band check below, and it costs
          // the reader the landing ring.
          if (terminal.outcome !== "landed") {
            failures.push(
              `step ${step}: the reveal settled ${String(terminal.outcome)}:${String(terminal.reason)}, not landed`,
            );
          }
          const samples = await sampleReveal(app, 600);
          const gesture = await lastGesture(app, mark);
          const last10 = tail(samples);

          // 1. The active text satisfies the query.
          const texts = new Set(last10.map((s) => s.activeText.toLowerCase()));
          if (texts.size !== 1 || !texts.has(PROBE)) {
            failures.push(
              `step ${step}: active text over the window was ${JSON.stringify([...texts])}`,
            );
          }

          // 2. In band, and still, across the whole window.
          const offBand = last10.filter((s) => !s.inView);
          if (offBand.length > 0) {
            const s = offBand[0];
            failures.push(
              `step ${step}: ${offBand.length}/10 frames off band — rect ${s.rectTop}..${s.rectBottom} vs band ${s.bandTop}..${s.bandBottom}`,
            );
          }
          const offsets = new Set(last10.map((s) => Math.round(s.scrollTop)));
          if (offsets.size !== 1) {
            failures.push(
              `step ${step}: the scroller was still moving — offsets ${JSON.stringify([...offsets])}`,
            );
          }

          // 3. The chip agrees with the engine's own ordinal.
          const ordinal = gesture === null ? null : (gesture.activeOrdinal as number | null);
          const chip = last10[last10.length - 1].chip.trim();
          if (ordinal === null) {
            failures.push(`step ${step}: the trace recorded no gesture to read an ordinal from`);
          } else if (chip !== `${ordinal + 1} of ${total}`) {
            failures.push(
              `step ${step}: chip ${JSON.stringify(chip)} disagrees with the engine's ordinal ${ordinal} ` +
                `(expected ${ordinal + 1} of ${total}); the reveal said ` +
                `${String(terminal.outcome)}:${String(terminal.reason)} after ${String(terminal.ms)}ms ` +
                `and ${String(terminal.writes)} write(s)`,
            );
          }

          // 4. Forward steps never go backwards before the wrap.
          const reveal = await readReveal(app);
          const row = reveal?.row ?? -1;
          if (!wrapped && row >= 0 && lastRow >= 0) {
            if (row < lastRow) {
              if (step >= total - 1) {
                wrapped = true;
              } else {
                failures.push(
                  `step ${step}: the walk went backwards — row ${row} after row ${lastRow}`,
                );
              }
            }
          }
          lastRow = row;
        }

        for (const f of failures.slice(0, 25)) note(f);
        if (failures.length > 25) note(`…and ${failures.length - 25} more`);
        expect(
          failures.length,
          `${failures.length} of ${total + 1} walk steps disagreed with themselves; see Diagnostics`,
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
