/**
 * at0452-nudge-slot-edges.test.ts — a nudge moves one card, then a group as
 * one arrangement, and the edge refuses the whole group.
 *
 * One of the at0452-nudge-slot split, a test to a file so each launch fits its
 * own budget. This file drives the first-responder rung and the explicit
 * selection rung; `at0452-nudge-slot-cards-cursor` drives the Cards list's
 * cursor rung. Why the nudge is all-or-nothing, and the shared deck, chord and
 * readers, are `nudge-slot-fixture.ts`.
 *
 * @covers tugdeck/src/layout-imposition.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/lib/action-vocabulary.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/lib/layout-selection.ts
 * @family at0452-nudge-slot
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { cardRinged, waitForRing } from "./card-chrome-fixture";
import {
  AFTER_LAND_MS,
  FRAMES,
  NUDGE,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  type CutRecord,
  deckShape,
  seedRailPreferred,
  setSelection,
  slotsByCard,
  wait,
} from "./nudge-slot-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0452 — the nudge moves the layout selection one slot, or none of it",
  () => {
    test(
      "one card, then a group, then the edge that refuses the whole group",
      async () => {
        const app = await launchTugApp({ testName: "at0452-nudge-slot" });
        try {
          await seedRailPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 4`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);

          // ---- One card, through the first-responder rung ----
          //
          // No selection, so the nudge means the card in front — the degenerate
          // case, run first so a later failure cannot be read as "the chord
          // never arrived at all".
          await setSelection(app, []);
          await app.nativeKey("]", NUDGE);
          await wait(AFTER_LAND_MS);
          let slots = await slotsByCard(app);
          expect(slots.A, "⌃⌥⌘] moved the front card one slot right").toBe(1);
          expect(slots.B, "and moved nothing else").toBe(1);
          expect(slots.C, "nor anything else").toBe(2);

          await app.nativeKey("[", NUDGE);
          await wait(AFTER_LAND_MS);
          slots = await slotsByCard(app);
          expect(slots.A, "⌃⌥⌘[ took it back").toBe(0);

          // ---- A group, moving as one arrangement ----
          //
          // A at 0 and B at 1 step to 1 and 2. The cut detector is what holds
          // the "one commit" claim: the geometry is right either way, but a
          // per-card commit re-arms the settle mid-flight and drops a frame.
          await setSelection(app, ["A", "B"]);
          await app.evalJS<null>(`(window.__tug.armCutDetector(), null)`);
          await app.evalJS<unknown[]>(`window.__tug.takeCutRecords()`);

          await app.nativeKey("]", NUDGE);
          await wait(AFTER_LAND_MS);
          const cuts = await app.evalJS<CutRecord[]>(
            `window.__tug.takeCutRecords()`,
          );
          await app.evalJS<null>(`(window.__tug.disarmCutDetector(), null)`);
          note(
            `two-card nudge cuts: ${cuts.length === 0 ? "none" : cuts.map((c) => `${c.paneId}:${c.kind}`).join(", ")}`,
          );
          expect(
            cuts.length,
            "a two-card nudge is one arrangement, so nothing cuts",
          ).toBe(0);

          slots = await slotsByCard(app);
          expect(slots.A, "both members moved — the first").toBe(1);
          expect(slots.B, "and the second, keeping their spacing").toBe(2);
          expect(slots.C, "the unselected card stayed put").toBe(2);

          // ---- The edge refuses the whole group ----
          //
          // B is on the last slot of a three-up, so a further right nudge has
          // nowhere to put it. A could still move, and that is exactly what
          // must not happen: a half-applied nudge collapses the pair onto one
          // slot. Both keep their slots, and B — the member that blocked it —
          // flashes.
          await app.nativeKey("]", NUDGE);
          await waitForRing(app, "B");
          expect(
            await cardRinged(app, "A"),
            "the refusal names the blocking member, not the whole selection",
          ).toBe(false);

          await wait(AFTER_LAND_MS);
          slots = await slotsByCard(app);
          expect(slots.A, "the group refused whole — the leading member").toBe(
            1,
          );
          expect(slots.B, "and the blocked one").toBe(2);

          // The left edge is the same rule, mirrored: A back to 0, B to 1, then
          // a further left nudge has nowhere to put A.
          await app.nativeKey("[", NUDGE);
          await wait(AFTER_LAND_MS);
          slots = await slotsByCard(app);
          expect(slots.A, "the pair came back left").toBe(0);
          expect(slots.B, "together").toBe(1);

          await app.nativeKey("[", NUDGE);
          await wait(AFTER_LAND_MS);
          slots = await slotsByCard(app);
          expect(slots.A, "and refuses at slot 0 the same way").toBe(0);
          expect(slots.B, "leaving the arrangement intact").toBe(1);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
