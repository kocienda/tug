/**
 * at0625-type-baseline-spread.test.ts — the tool-call header's runs share
 * one baseline.
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
  BEFORE,
  DISCLOSURE,
  HEADER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  mountSkillHeader,
  offSizeNote,
  readHeader,
  spreadAtRowSize,
  summarize,
} from "./type-baseline-fixture";

describe.skipIf(!SHOULD_RUN)("AT0624: the tool-call header's type baseline", () => {
  test(
    "the tool-call header's runs share one baseline",
    async () => {
      const app = await launchTugApp({ testName: "at0625-type-baseline-spread" });
      try {
        await mountSkillHeader(app);

        const collapsedAttr = await app.body("A").evalJS<string | null>(
          `(document.querySelector(${JSON.stringify(HEADER)}) || {getAttribute:function(){return null;}})
             .getAttribute("data-collapsed")`,
        );
        const asMounted = await readHeader(app);
        note(summarize(`at0625 as-mounted (data-collapsed=${collapsedAttr})`, asMounted));

        expect(asMounted.found, asMounted.why ?? "").toBe(true);
        const runs = asMounted.runs ?? [];
        expect(
          runs.length,
          "the header must give up more than one run to compare",
        ).toBeGreaterThan(1);

        // The inverted assertion, and the arc's central claim: with every
        // nudge deleted the header's runs agree, because one font size in
        // one line box is already one baseline. Read over the runs at the
        // row's own size — the timing badge is set two steps smaller, and
        // that is rule (i)'s business, reported rather than asserted here.
        const atSize = spreadAtRowSize(runs);
        note(offSizeNote("at0625 by size", atSize));
        expect(
          atSize.spread,
          `the header's runs share one baseline (was ${BEFORE.skill}px with the nudges in)`,
        ).toBeLessThanOrEqual(0.5);

        // --- the other fold state, which is [Q01] --------------------------
        // Does a strut inside `-webkit-line-clamp`'s `display: -webkit-box`
        // still report a baseline? Read the opposite state and say so; the
        // answer bounds every later step that measures a collapsed header.
        await app.body("A").click(DISCLOSURE);
        await app.body("A").waitForCondition<boolean>(
          `(function(){
             var h = document.querySelector(${JSON.stringify(HEADER)});
             return h !== null && h.getAttribute("data-collapsed") !== ${JSON.stringify(collapsedAttr)};
           })()`,
          { timeoutMs: 6000 },
        );
        const toggledAttr = await app.body("A").evalJS<string | null>(
          `document.querySelector(${JSON.stringify(HEADER)}).getAttribute("data-collapsed")`,
        );
        const toggled = await readHeader(app);
        note(summarize(`at0625 toggled (data-collapsed=${toggledAttr})`, toggled));
        note(
          `at0625 [Q01] strut under -webkit-line-clamp: ${
            toggled.found === true && (toggled.runs ?? []).length > 1
              ? "reports baselines in both fold states"
              : "did NOT report in the clamped state — later steps must expand first"
          }`,
        );

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
