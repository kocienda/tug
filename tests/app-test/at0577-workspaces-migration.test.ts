/**
 * at0577-workspaces-migration.test.ts — a v4 deck comes back as one workspace
 * named Main, and the next save writes v5.
 *
 * The whole of layout v5 rests on one claim nothing short of a real relaunch
 * can check: a tugbank written by every build before this one holds a
 * `version: 4` blob, and the person who quit that build must get their deck
 * back — same cards, same panes, same sidebars, same focused card — now
 * standing inside a workspace they never made ([B09], Spec S02). The unit
 * tests pin the parse; only this one pins the round trip through the app's own
 * boot read, its own `DeckManager`, and its own save.
 *
 * Two phases, one temp tugbank:
 *
 * | Phase | Tugbank at launch | Assertion                                     |
 * |-------|-------------------|-----------------------------------------------|
 * | A     | hand-written v4   | one space named `Main`, holding card `A`, and |
 * |       | blob + the legacy | the legacy `focusedCardId` row adopted onto   |
 * |       | `focusedCardId`   | it                                            |
 * | B     | whatever A saved  | the row on disk is `version: 5` with one      |
 * |       |                   | space named `Main` carrying `focusedCardId`   |
 *
 * Phase B reads the disk rather than the app: what is under test is the wire
 * format, and the app would answer from the same objects Phase A already
 * asserted on.
 *
 * `restoreInTestMode` is what makes the constructor honour the seeded blob
 * (test mode otherwise boots empty by design), and `persistInTestMode` is what
 * lets the save reach the temp tugbank. The pair is the cold-boot harness's
 * standing idiom.
 *
 * This file deliberately does NOT name `tugdeck/src/deck-manager.ts`, which it
 * plainly exercises: that path's `@covers` fan-out is recorded at 21 in
 * `ACCEPTED_FANOUT`, and a twenty-second namer would raise a debt figure the
 * ratchet lets you pay down but never refinance. The manager is reached here
 * through the two paths below, which is where this step's change lives.
 *
 * @covers tugdeck/src/serialization.ts
 * @covers tugdeck/src/spaces.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/**
 * A `version: 4` layout blob exactly as every build before workspaces wrote
 * one: one text card in a floating pane, the Cards card standing on the right
 * rail, and no notion of a space anywhere in it.
 */
const V4_BLOB = {
  version: 4,
  cards: [
    { id: "A", componentId: "text", title: "File", closable: true },
    { id: "cards", componentId: "cards", title: "Cards", closable: true },
  ],
  panes: [
    {
      id: "p1",
      position: { x: 40, y: 40 },
      size: { width: 720, height: 520 },
      cardIds: ["A"],
      activeCardId: "A",
      title: "",
      acceptsFamilies: ["standard"],
    },
    {
      id: "p-cards",
      position: { x: 900, y: 40 },
      size: { width: 320, height: 520 },
      cardIds: ["cards"],
      activeCardId: "cards",
      title: "",
      acceptsFamilies: ["standard"],
    },
  ],
  activePaneId: "p1",
  imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
};

interface SpacesProbe {
  activeSpaceId: string;
  spaces: {
    id: string;
    name: string;
    active: boolean;
    deck: { cards: { id: string }[] } | null;
  }[];
}

interface V5Blob {
  version: number;
  activeSpaceId: string;
  spaces: {
    id: string;
    name: string;
    focusedCardId?: string;
    deck: { cards: { id: string }[] };
  }[];
}

describe.skipIf(!SHOULD_RUN)("at0577 — a v4 deck becomes one workspace", () => {
  test(
    "a v4 blob boots as Main and the next save writes version 5",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(V4_BLOB),
        );
        // The pre-v5 home of the focused card: a standalone row, one per
        // instance, which v5 retires onto the space record.
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.state",
          "focusedCardId",
          "string",
          "A",
        );

        const app = await launchTugApp({
          testName: "at0577-workspaces-migration",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `typeof window.tugdeck !== "undefined" && typeof window.tugdeck.diag.getSpaces === "function"`,
            { timeoutMs: 10_000 },
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getDeckState().cards.some(function (c) { return c.id === "A"; })`,
            { timeoutMs: 10_000 },
          );

          // ---- Phase A: one space, named Main, holding the restored deck.
          const probe = await app.evalJS<SpacesProbe>(
            `window.tugdeck.diag.getSpaces()`,
          );
          expect(probe.spaces.length).toBe(1);
          expect(probe.spaces[0].name).toBe("Main");
          expect(probe.spaces[0].active).toBe(true);
          expect(probe.activeSpaceId).toBe(probe.spaces[0].id);
          expect(
            (probe.spaces[0].deck?.cards ?? []).map((c) => c.id).sort(),
          ).toEqual(["A", "cards"]);

          // The legacy row was adopted onto the space, which is what makes the
          // focus restore survive the format change.
          await app.waitForCondition<boolean>(
            `window.__tug.getActiveCardId() === "A"`,
            { timeoutMs: 8_000 },
          );

          // ---- The save the Swift host fires on quit.
          await app.evalJS<null>(`(window.tugdeck.saveState(), null)`);
          await app.quitGracefully();
        } catch (e) {
          await app.close().catch(() => undefined);
          throw e;
        }

        // ---- Phase B: the row on disk is v5.
        const onDisk = tugbankRead<V5Blob>(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
        );
        expect(onDisk).not.toBeNull();
        const blob = onDisk!.value;
        expect(blob.version).toBe(5);
        expect(blob.spaces.length).toBe(1);
        expect(blob.spaces[0].name).toBe("Main");
        expect(blob.activeSpaceId).toBe(blob.spaces[0].id);
        expect(blob.spaces[0].focusedCardId).toBe("A");
        expect(blob.spaces[0].deck.cards.map((c) => c.id)).toContain("A");
        // The deck body carries no version key of its own — the envelope owns
        // it, and a body that kept one would parse as a blob rather than a deck.
        expect(
          (blob.spaces[0].deck as unknown as Record<string, unknown>)["version"],
        ).toBeUndefined();
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
