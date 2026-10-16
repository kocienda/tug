/**
 * at0643-workspace-switch-cadence-whale — the switch's frame cadence, held on
 * a deck big enough to break it, on the whale arm.
 *
 * Split from `at0643-workspace-switch-cadence`, one file per transcript arm,
 * each its own launch: the slice in `at0643-workspace-switch-cadence-slice`,
 * the whale here — one card of each workspace carries the corpus's whale.
 * Skipped where `corpus/harvest.ts` has not materialized one. The fixture,
 * the instrument and the bars are one body in
 * `workspace-switch-cadence-fixture.ts`; the argument for all of it is in the
 * slice file's docblock.
 *
 * @motion
 * @family at0643-workspace-switch-cadence
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/lib/space-switch-frames.ts
 * @covers tugdeck/src/components/chrome/space-layer.css
 * @covers tests/app-test/real-transcript-fixture.ts
 */

import { describeCadenceArm } from "./workspace-switch-cadence-fixture";

describeCadenceArm("whale");
