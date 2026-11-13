/**
 * at0816-rail-reskin-reading.test.ts — how long the shared rail stands under
 * its re-skin skeleton on a switch between workspaces of different themes.
 *
 * The rail is the window's and follows the active workspace's theme. A rail
 * card's page cannot re-skin in the cut's frame, so the host stands a
 * skeleton in the arriving palette over each shown rail card at the cut,
 * tells the page the theme, and takes the skeleton down on the page's paint
 * in it. This reads that time: two workspaces, one on a dark theme and one
 * on a light one, switched between from the Window menu's rows six times,
 * the host's layer rows sampled across each switch. For each rail card, the
 * time from its first skeleton row to its first live row after it. Asserts
 * only that the switches ran and every rail card came back live: the times
 * are the product, the input to the judgement of whether a rail skeleton
 * that long reads as a flash.
 *
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/lib/window-rail.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import type { BodyLayersReading } from "../_harness/client";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "../body-grounding/_bodies";
import { cardsOf, layoutOf, RAIL, space, type Space } from "./_workspace-deck";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const SWITCHES = 6;
const LAYERS_MS = 1_200;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

const SPACES: Space[] = [space("g816", "dark", ["text", "text"]), space("g816", "light", ["text"])];

function stats(xs: readonly number[]): string {
  if (xs.length === 0) return "none";
  const s = [...xs].sort((a, b) => a - b);
  return `median ${Math.round(s[Math.floor((s.length - 1) / 2)])}, max ${Math.round(s[s.length - 1])}`;
}

describe.skipIf(!SHOULD_RUN)("at0816 — the shared rail's re-skin", () => {
  test(
    "six cross-theme switches, each rail card's skeleton timed to its re-skinned page",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const layout = layoutOf(SPACES) as { spaces: Record<string, unknown>[] };
      layout.spaces[0].theme = "ironclad";
      layout.spaces[1].theme = "sloop";
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(layout));
      const app = await launchTugApp({
        testName: "at0816-rail-reskin-reading",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const rail = SPACES[0].rail;
        for (const id of cardsOf(SPACES[0])) {
          await settleFor(() => bodyOf(app, id), (x) => x?.state === "ready" && x.painted === true, 30_000);
        }
        await Bun.sleep(1_000);
        const times: Record<string, number[]> = {};
        let skeletons = 0;
        for (let n = 0; n < SWITCHES; n++) {
          const row = n % 2 === 0 ? 1 : 0;
          const to = SPACES[row];
          await app.bodyLayers({ op: "arm", windowMs: LAYERS_MS });
          const gesture = Date.now();
          await app.performMenuItem(`window.space.${row}`);
          const active = await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === to.id, 10_000);
          expect(active, `switch ${n + 1} reaches ${to.id}`).toBe(to.id);
          const layers = (await settleFor(
            () => app.bodyLayers({ op: "read" }) as Promise<BodyLayersReading>,
            (x) => x.done === true,
            LAYERS_MS + 10_000,
          )) as BodyLayersReading;
          const parts: string[] = [];
          for (const [i, r] of RAIL.entries()) {
            const rows = layers.rows.filter((x) => x.cardId === rail[i]);
            const first = rows.find((x) => x.picture === "skeleton");
            const live = first === undefined ? undefined : rows.find((x) => x.wall > first.wall && x.picture === "live");
            if (first !== undefined) skeletons += 1;
            if (first !== undefined && live !== undefined) {
              (times[r.kind] ??= []).push(live.wall - first.wall);
              parts.push(`${r.kind} ${Math.round(first.wall - gesture)}→${Math.round(live.wall - gesture)}`);
            } else parts.push(`${r.kind} ${first === undefined ? "no skeleton" : "never live"}`);
          }
          note(`switch ${n + 1} → ${to.id} (skeleton→live, ms from the gesture): ${parts.join(", ")}`);
          for (const id of rail) {
            const b = await settleFor(() => bodyOf(app, id), (x) => x?.painted === true, 5_000);
            expect(b?.painted, `${id} painted after switch ${n + 1}`).toBe(true);
          }
          await Bun.sleep(600);
        }
        for (const [kind, xs] of Object.entries(times)) note(`${kind}: under its skeleton ${stats(xs)} ms (${xs.length}/${SWITCHES})`);
        note(`all rail cards: under the skeleton ${stats(Object.values(times).flat())} ms; ${skeletons} skeletons stood`);
        expect(skeletons, "a cross-theme switch stood the rail's re-skin skeletons").toBeGreaterThan(0);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
