/**
 * at0820-stage-resize-then-switch.test.ts — a workspace parked through a
 * window resize stands, while still parked, where its switch will show it.
 *
 * Every workspace is mounted from launch and each card's view is placed from
 * its workspace's layer whether or not it is shown. So when the window is
 * resized while a workspace is parked, its arrangement must be re-solved
 * against the new canvas then, not at the switch: a parked rect solved for
 * the old canvas is the rect a host cut would show, and the card would jump
 * when the switch corrected it.
 *
 * Two workspaces of a user-shaped deck (the rail's five cards and Text
 * content), both shown once so every page is made. With `to` parked the
 * window is narrowed and left to settle; each of `to`'s cards' views is read
 * as the host holds it, hidden. Then the switch is made from the Window menu,
 * and a second later the same views are read again, shown. Every card stands
 * where it stood while parked, within a point.
 *
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/spaces-store.ts
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import type { BodyViewSnapshot } from "./_harness/client";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "./_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "./body-grounding/_bodies";
import { cardsOf, layoutOf, space, type Space } from "./readings/_workspace-deck";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
/** How far a card may stand from where it stood parked, points. */
const SLACK = 1;
/** How much narrower the window is made while `to` is parked, points. */
const NARROWER = 240;

const FROM: Space = space("g820", "from", ["text"]);
const TO: Space = space("g820", "to", ["text", "text"]);

type App = Awaited<ReturnType<typeof launchTugApp>>;
type Frame = BodyViewSnapshot["frame"];

async function activate(app: App, row: number, spaceId: string): Promise<void> {
  await app.performMenuItem(`window.space.${row}`);
  const active = await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === spaceId, 10_000);
  expect(active, `the switch reaches ${spaceId}`).toBe(spaceId);
}

async function ready(app: App, s: Space): Promise<void> {
  for (const id of cardsOf(s)) {
    const b = await settleFor(() => bodyOf(app, id), (x) => x?.state === "ready" && x.painted === true, 15_000);
    expect(b?.painted, `${id}: ready and painted`).toBe(true);
  }
}

/** Each of `s`'s cards' view frames as the host holds them now. */
async function framesOf(app: App, s: Space): Promise<Map<string, Frame>> {
  const want = new Set(cardsOf(s));
  const out = new Map<string, Frame>();
  for (const b of await app.bodies()) if (b.cardId !== null && want.has(b.cardId)) out.set(b.cardId, b.frame);
  return out;
}

const key = (f: Frame): string => `${f.x},${f.y},${f.width},${f.height}`;
const off = (a: Frame, b: Frame): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));

describe.skipIf(!SHOULD_RUN)("at0820 — a workspace parked through a resize stands where its switch shows it", () => {
  test(
    "every arriving card's view is where it stood while parked, within a point",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(layoutOf([FROM, TO])));
      const app = await launchTugApp({
        testName: "at0820-stage-resize-then-switch",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await ready(app, FROM);
        await activate(app, 1, TO.id);
        await ready(app, TO);
        const shownBefore = await framesOf(app, TO);
        await activate(app, 0, FROM.id);

        const width = await app.evalJS<number>("window.innerWidth");
        const took = await app.setWindowContentSize({ width: width - NARROWER });
        expect(took.width, "the window narrowed").toBeLessThan(width - NARROWER / 2);
        // The parked layer's views settle at the new canvas: two reads a beat apart agree.
        let parked = await framesOf(app, TO);
        for (let i = 0; i < 20; i++) {
          await Bun.sleep(150);
          const next = await framesOf(app, TO);
          const same = [...next].every(([id, f]) => parked.get(id) !== undefined && key(parked.get(id)!) === key(f));
          parked = next;
          if (same) break;
        }

        await activate(app, 1, TO.id);
        await Bun.sleep(1_000);
        const shown = await framesOf(app, TO);

        const rows = cardsOf(TO).map((id) => {
          const p = parked.get(id);
          const s = shown.get(id);
          const b = shownBefore.get(id);
          return { id, parked: p, shown: s, moved: b !== undefined && s !== undefined ? off(b, s) : null, off: p !== undefined && s !== undefined ? off(p, s) : null };
        });
        for (const r of rows) {
          note(`${r.id}: parked ${r.parked === undefined ? "none" : key(r.parked)} shown ${r.shown === undefined ? "none" : key(r.shown)} off ${r.off} (moved by the resize ${r.moved})`);
        }
        expect(
          rows.some((r) => r.moved !== null && r.moved >= SLACK),
          "the resize moved at least one of the parked workspace's cards",
        ).toBe(true);
        for (const r of rows) {
          expect(r.off, `${r.id}: read parked and shown`).not.toBeNull();
          expect(r.off!, `${r.id}: shown where it stood parked`).toBeLessThanOrEqual(SLACK);
        }
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
