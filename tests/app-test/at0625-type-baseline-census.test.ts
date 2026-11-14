/**
 * at0625-type-baseline-census.test.ts — every censused surface mounts and
 * reports a baseline reading.
 *
 * One of the at0625-type-baseline split, a test to a file so each launch
 * fits its own budget. Why the header is measured this way, the mounts, the
 * readers, the census list and the before-figures are
 * `type-baseline-fixture.ts`.
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
import { trackCompensationJS, type TrackCompensation } from "./baseline-probes";
import {
  BEFORE,
  CENSUS,
  ENDCAP_LABEL,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  mountCensusSurfaces,
  offSizeNote,
  readRow,
  spreadAtRowSize,
  summarize,
} from "./type-baseline-fixture";

describe.skipIf(!SHOULD_RUN)("AT0624: the tool-call header's type baseline", () => {
  // --- the census ------------------------------------------------------
  // One instrument run over the family-A surfaces Table T01 names, whose
  // output is the report's `Diagnostics:` section and, transcribed, the
  // arc's `census.md`. It asserts only that each surface it claims to
  // census actually mounted and reported — a surface with no reading is a
  // hole in the census, and a hole nobody notices is the failure mode this
  // assertion exists against. What each number *means* is argued in the
  // census, not here: this case makes no claim about which spread is
  // acceptable, because deciding that before the law is written would be
  // the eye judgement the arc is replacing.
  test(
    "every censused surface mounts and reports a reading",
    async () => {
      const app = await launchTugApp({ testName: "at0625-type-baseline-census" });
      try {
        await mountCensusSurfaces(app);

        for (const surface of CENSUS) {
          const reading = await readRow(app, surface.selector);
          const before = BEFORE[surface.key];
          note(
            summarize(`at0625 census ${surface.key}`, reading) +
              (before === undefined
                ? ""
                : ` — was ${before.toFixed(2)}px before the sweep`),
          );
          expect(
            reading.found,
            `census surface ${surface.key} (${surface.selector}) reported nothing: ` +
              `${reading.why ?? "no reason given"}`,
          ).toBe(true);
          // Every family-A surface the probe can reach agrees after the
          // sweep. The Z2 row is excluded by having no `BEFORE` entry: its
          // spread is legend-band against value-band, two lines rather than
          // one, and family C is what answers for it.
          if (before !== undefined) {
            const atSize = spreadAtRowSize(reading.runs ?? []);
            note(offSizeNote(`at0625 census ${surface.key} by size`, atSize));
            expect(
              atSize.spread,
              `${surface.key} shares one baseline (was ${before.toFixed(2)}px)`,
            ).toBeLessThanOrEqual(0.5);
          }
        }

        // [F05] is horizontal, so the strut is the wrong instrument for it:
        // the endcap label is uppercase and tracked at 0.18em with nothing
        // after the last glyph to absorb the track, and the flex container
        // centres the box the track widened.
        const track = JSON.parse(
          await app.body("A").evalJS<string>(trackCompensationJS(ENDCAP_LABEL)),
        ) as TrackCompensation;
        note(
          track.found === true
            ? `at0625 census endcap track: rect ${track.rectWidth?.toFixed(2)}px vs advance ` +
              `${track.advance?.toFixed(2)}px, trailing track ${track.trailingTrack?.toFixed(2)}px, ` +
              `left of centre by ${track.centredBy?.toFixed(2)}px`
            : `at0625 census endcap track: not found (${track.why ?? "no reason given"})`,
        );
        expect(track.found, track.why ?? "").toBe(true);

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
