/**
 * at0741-every-kind-a-body-first-half.test.ts — the first half of the
 * registered card kinds stands ready in bodies, with none in the shell's
 * document. `every-kind-fixture.ts` says how, and why there are two halves.
 *
 * @covers tugdeck/src/card-kinds.ts
 * @covers tugdeck/src/lib/body-handoff.ts
 * @covers tugdeck/src/components/tugways/cards/gallery-registrations.tsx
 * @covers tugdeck/src/spikes/spike-registry.tsx
 * @covers tugdeck/src/fixtures/fixture-registrations.tsx
 */

import { describe, test } from "bun:test";

import { TEST_TIMEOUT_MS, proveHalfOfTheKinds } from "./every-kind-fixture";

const TEST_NAME = "at0741-every-kind-a-body-first-half";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

describe.skipIf(!SHOULD_RUN)("at0741: every registered kind is a body, first half", () => {
  test(
    "one card of each kind in the registry's first half stands ready in a body, with none in the shell's document",
    () => proveHalfOfTheKinds(TEST_NAME, "first"),
    TEST_TIMEOUT_MS,
  );
});
