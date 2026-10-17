/**
 * at0738-body-arrival.test.ts — a body card arrives warm from the spare,
 * shown in one step under the shell's lid, and cold when there is no spare.
 *
 * Part of the gate for the body path, split from `at0738-session-body` one
 * leg per file (see `at0738-body-placement` for the list). The app launches
 * with bodies on; shared helpers live in `session-body-fixture.ts`.
 *
 * **Arrival.** A Session card the deck opens takes the warm spare as it
 * arrives, unbound: its picker is drawn in the body, so the card is a body
 * from the moment the deck holds it, with no session spawned first. The
 * host shows its container in ONE step — the sampled opacity is ≤ 0.05
 * and then 1, never between — because the reveal the user sees is the
 * shell's lid lifting over a body already composited (`body-grounding/
 * row-01-arrival` reads that frame by frame); a host fade through the
 * floor's hole would be a fade from the window's background. The container
 * does not move while it shows, and a shown body has `painted`. The card
 * opened right after it finds no spare and is made cold; each reports which
 * it was.
 *
 * @family at0738-body
 * @covers tugdeck/src/lib/body-placement.ts
 * @covers tugdeck/src/lib/body-facts-store.ts
 * @covers tugdeck/src/lib/body-command-route.ts
 * @covers tugdeck/src/lib/pointer-claim.ts
 * @covers tugdeck/src/components/chrome/body-placement-beacon.tsx
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-handoff.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugdeck/src/body/body-intent.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/BodyGeometry.swift
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import type { HostFrameReading } from "./_harness/client";
import { BODY_READY_MS, PLACED_MS, pollFor, showOf } from "./session-body-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!SHOULD_RUN)("at0738: a Session card's body", () => {
  test(
    "arrives warm from the spare, shown in one step under the shell's lid, and cold when there is no spare",
    async () => {
      const app = await launchTugApp({ testName: "at0738-body-arrival", bodies: true });
      // A Session card the deck opens, by the id its body answers to.
      const openSessionCard = async (taken: string[]): Promise<string> => {
        await app.dispatchControlAction("show-card", { component: "session" });
        const all = await pollFor(
          () => app.bodies(),
          (bodies) => bodies.some((b) => b.cardId !== null && !taken.includes(b.cardId)),
          PLACED_MS,
        );
        return all.find((b) => b.cardId !== null && !taken.includes(b.cardId))!.cardId!;
      };
      try {
        await app.seedDeckState({
          state: { cards: [], panes: [], imposition: { kind: "four-up", layout: "flow", sidebars: {} }, hasFocus: true },
        });

        // The spare is made a beat after the shell paints, and waits connected.
        const spares = await pollFor(
          () => app.bodies(),
          (all) => all.some((b) => b.cardId === null && b.state === "connected"),
          BODY_READY_MS,
        );
        note(`before the opens: ${JSON.stringify(spares.map((b) => ({ cardId: b.cardId, state: b.state })))}`);
        expect(spares.some((b) => b.cardId === null && b.state === "connected"), "a spare body waits, connected").toBe(true);

        // The first open takes the spare, and its showing is sampled alone:
        // a neighbour arriving below it would re-lay the column under it.
        // The meter samples the spare's container, armed before the open:
        // an unbound card's body shows within a round trip of taking it.
        await app.hostFrames({ op: "arm", windowMs: 8_000, layer: "spare" });
        const WARM = await openSessionCard([]);
        await pollFor(
          () => app.bodies(),
          (all) => {
            const b = all.find((x) => x.cardId === WARM);
            return b !== undefined && b.state === "ready" && b.visible && b.opacity >= 0.9999;
          },
          BODY_READY_MS,
        );
        // The second opens at once, inside the second the spare takes to be
        // replaced, so it finds none.
        const COLD = await openSessionCard([WARM]);

        const settled = await pollFor(
          () => app.bodies(),
          (all) =>
            [WARM, COLD].every((id) => {
              const b = all.find((x) => x.cardId === id);
              return b !== undefined && b.state === "ready" && b.visible && b.opacity >= 0.9999;
            }),
          BODY_READY_MS,
        );
        await Bun.sleep(100);
        const reading = (await app.hostFrames({ op: "read" })) as HostFrameReading;
        const warm = settled.find((b) => b.cardId === WARM);
        const cold = settled.find((b) => b.cardId === COLD);
        note(`warm body: start ${warm?.start}, ready ${warm?.readyMs?.toFixed(1)} ms`);
        note(`cold body: start ${cold?.start}, ready ${cold?.readyMs?.toFixed(1)} ms`);
        expect(warm?.state, "the first card's body is ready").toBe("ready");
        expect(cold?.state, "the second card's body is ready").toBe("ready");
        expect(warm!.start, "the first card bound the spare").toBe("warm");
        expect(cold!.start, "the second card, with the spare taken, was made cold").toBe("cold");
        expect(warm!.painted, "a shown body has painted").toBe(true);

        const show = showOf(reading);
        note(`show: ${JSON.stringify(show)}; ${reading.samples?.length ?? 0} samples, period ${reading.periodMs.toFixed(2)} ms`);
        expect(show, "the host sampled the container going from transparent to opaque").not.toBeNull();
        expect(show!.firstOpacity, "the container was transparent before it showed").toBeLessThanOrEqual(0.05);
        expect(show!.between, "the container shows in one step under the lid — no host fade through the hole").toBe(0);
        expect(show!.still, "the container did not move once shown").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
