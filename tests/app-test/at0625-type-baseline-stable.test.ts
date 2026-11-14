/**
 * at0625-type-baseline-stable.test.ts — the baseline reading is stable
 * across two consecutive reads.
 *
 * One of the at0625-type-baseline split, a test to a file so each launch
 * fits its own budget. Why the header is measured this way, the mounts, the
 * readers and the before-figures are `type-baseline-fixture.ts`.
 *
 * @covers tugdeck/src/components/tugways/blocks/block-header.css
 * @covers tugdeck/src/components/tugways/blocks/block-header.tsx
 * @covers tugdeck/src/components/tugways/blocks/block-strip.tsx
 * @covers tugdeck/styles/tug-line-box.css
 * @covers tugdeck/src/components/tugways/cards/blocks/skill-tool-block.tsx
 * @covers tugdeck/src/components/tugways/blocks/block-chrome.css
 * @covers tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx
 * @covers tugdeck/src/components/tugways/cards/blocks/task-tool-block.css
 * @covers tugdeck/src/components/tugways/tug-quiet-line.css
 * @covers tugdeck/src/components/tugways/cards/session-telemetry-cell.css
 * @covers tugdeck/src/components/tugways/tug-atom-ref.css
 * @covers tugdeck/src/components/tugways/tug-separator.css
 * @family at0625-type-baseline
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  mountSkillHeader,
  readHeader,
  summarize,
} from "./type-baseline-fixture";

describe.skipIf(!SHOULD_RUN)("AT0624: the tool-call header's type baseline", () => {
  test(
    "the reading is stable across two consecutive reads",
    async () => {
      const app = await launchTugApp({ testName: "at0625-type-baseline-stable" });
      try {
        await mountSkillHeader(app);

        const first = await readHeader(app);
        const second = await readHeader(app);
        note(summarize("at0625 read 1", first));
        note(summarize("at0625 read 2", second));

        expect(first.found, first.why ?? "").toBe(true);
        expect(second.found, second.why ?? "").toBe(true);

        const a = first.runs ?? [];
        const b = second.runs ?? [];
        expect(b.length, "the same runs are found both times").toBe(a.length);
        for (let i = 0; i < a.length; i += 1) {
          expect(b[i].slot, `run ${i} is the same run`).toBe(a[i].slot);
          expect(
            Math.abs(b[i].baseline - a[i].baseline),
            `run ${i} (${a[i].slot}) reads the same baseline twice`,
          ).toBeLessThanOrEqual(0.1);
        }
        expect(
          Math.abs((second.spread as number) - (first.spread as number)),
          "the spread is the same number twice — a jittering instrument is not one",
        ).toBeLessThanOrEqual(0.1);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0625] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
