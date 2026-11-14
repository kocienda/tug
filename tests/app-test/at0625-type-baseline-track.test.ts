/**
 * at0625-type-baseline-track.test.ts — the letterspaced legend is centred on
 * its own track, and seated on its rule.
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
  trackCompensationJS,
  inkVsRuleJS,
  type TrackCompensation,
  type InkVsRule,
} from "./baseline-probes";
import {
  BEFORE_CENTRED_BY,
  ENDCAP_LABEL,
  ENDCAP_RULE_FILL,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  mountCensusSurfaces,
} from "./type-baseline-fixture";

describe.skipIf(!SHOULD_RUN)("AT0624: the tool-call header's type baseline", () => {
  // --- rule (v): the letterspaced legend -------------------------------
  // The Z2 endcap legend is uppercase and tracked at 0.18em inside a flex
  // row that centres it between two hairlines. CSS puts a track after the
  // LAST glyph too, with nothing after it to absorb one, so the box the
  // container centres is a track wider than the glyphs in it and the
  // glyphs sit half a track to the left. Two numbers say whether the
  // compensation works, and they are orthogonal: `centredBy` is the
  // horizontal one the track builder measures off the laid-out boxes, and
  // `offBy` is the vertical one — where the legend's ink sits against the
  // rule it captions, which is what the deleted `translateY(0.5px)`
  // claimed to be fixing.
  test(
    "the letterspaced legend is centred on its own track, and seated on its rule",
    async () => {
      const app = await launchTugApp({ testName: "at0625-type-baseline-track" });
      try {
        await mountCensusSurfaces(app);

        const track = JSON.parse(
          await app.body("A").evalJS<string>(trackCompensationJS(ENDCAP_LABEL)),
        ) as TrackCompensation;
        note(
          track.found === true
            ? `at0625 endcap track: rect ${track.rectWidth?.toFixed(2)}px, advance ` +
              `${track.advance?.toFixed(2)}px, trailing track ${track.trailingTrack?.toFixed(2)}px, ` +
              `margin-end ${track.marginEnd?.toFixed(2)}px → centredBy ` +
              `${track.centredBy?.toFixed(2)}px (was ${BEFORE_CENTRED_BY.toFixed(2)}px uncompensated)`
            : `at0625 endcap track: not found (${track.why ?? "no reason given"})`,
        );
        expect(track.found, track.why ?? "").toBe(true);

        // The vertical claim the deleted nudge made. This is recorded
        // rather than asserted tightly: the ink band is derived from the
        // face's cap ratio rather than measured off pixels, so it answers
        // "did the nudge move the legend toward the rule or away from it"
        // and does not pretend to a tolerance it has not earned.
        const ink = JSON.parse(
          await app.body("A").evalJS<string>(inkVsRuleJS(ENDCAP_LABEL, ENDCAP_RULE_FILL)),
        ) as InkVsRule;
        note(
          ink.found === true
            ? `at0625 endcap ink vs rule: baseline @${ink.baseline?.toFixed(2)} at ` +
              `${ink.fontSize?.toFixed(2)}px → cap-band centre @${ink.inkCentre?.toFixed(2)}, ` +
              `rule centre @${ink.ruleCentre?.toFixed(2)}, off by ${ink.offBy?.toFixed(2)}px ` +
              `(positive = ink below the rule)`
            : `at0625 endcap ink vs rule: not found (${ink.why ?? "no reason given"})`,
        );
        expect(ink.found, ink.why ?? "").toBe(true);

        // Both readings are `note()`d above before either is asserted on,
        // so a run that fails one still carries the other into the report.
        // The step that wrote this case needed exactly that: the before
        // and after of two orthogonal numbers, from runs where one of them
        // was red by construction.

        // The compensation is a trailing negative margin of exactly one
        // track, so the margin box the container centres is the glyph band
        // again. A run that is still displaced is one whose two numbers
        // disagree — and the assertion is on the DISPLACEMENT rather than
        // on the declaration, so a `margin-inline-end` that is present and
        // wrong fails here rather than reading as compliance.
        expect(
          Math.abs(track.centredBy as number),
          `the legend's glyphs sit on their box's centre ` +
            `(was ${BEFORE_CENTRED_BY.toFixed(2)}px left of it)`,
        ).toBeLessThanOrEqual(0.25);

        expect(
          Math.abs(ink.offBy as number),
          "the legend's ink is seated on the rule it captions " +
            "(it read 0.73px low with the translateY in place)",
        ).toBeLessThanOrEqual(0.5);

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
