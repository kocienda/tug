/**
 * at0621-intra-workspace-slide-whale.test.ts — an activation INSIDE a
 * workspace slides, and never fades; the whale arm.
 *
 * Split from `at0621-intra-workspace-slide`, one file per transcript arm, each
 * its own launch: the slice in `at0621-intra-workspace-slide-slice`, the whale
 * here — the walk's two ends carry the corpus's whale. Skipped where
 * `corpus/harvest.ts` has not materialized one. The sampler, the fixture and
 * the claims are one body in `intra-workspace-slide-fixture.ts`; the argument
 * for all of it is in the slice file's docblock.
 *
 * @family at0621-intra-workspace-slide
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/components/chrome/space-layer.ts
 * @covers tests/app-test/real-transcript-fixture.ts
 */

import { describeSlideArm } from "./intra-workspace-slide-fixture";

describeSlideArm("whale");
