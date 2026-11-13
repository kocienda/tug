/**
 * at0813-switch-canvas-grid-reading.test.ts — whether a switch between
 * workspaces of different themes makes the shell's switched frame late,
 * which is what leaves the canvas and its grid in the departed workspace's
 * colours after the held picture lifts.
 *
 * The canvas and its grid are the shell's (`#deck-container` in
 * `globals.css`), drawn from the shell's theme stylesheet; the cards wear
 * their own theme in their own pages. At a switch's horizon the host lifts
 * its held picture onto whatever the shell has presented, so a shell frame
 * that is late shows the departed canvas around the arriving cards until it
 * lands.
 *
 * A user-shaped deck of five workspaces, each with its five rail cards and
 * Text content, every page made ahead. Ten switches with every workspace on
 * one theme, then ten with the workspaces alternating a dark and a light
 * theme, each switch's hold (`held_ms`, `outcome`, `shell_ms`) and the deck
 * trace's switch timing noted. Asserts only that the switches ran: the
 * comparison is the product.
 *
 * @covers tugdeck/src/contexts/theme-provider.tsx
 * @covers tugdeck/src/theme-links.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import type { SwitchHoldRecord } from "../_harness/client";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "../body-grounding/_bodies";
import { layoutOf, space, type Space } from "./_workspace-deck";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
const SWITCHES = 10;
const REST_MS = 1_200;
const AHEAD_MS = 90_000;
const DARK = "ironclad";
const LIGHT = "sloop";

const SPACES: Space[] = [
  space("g813", "home", ["text", "text"]),
  space("g813", "a", ["text", "text", "text"]),
  space("g813", "b", ["text", "text", "text"]),
  space("g813", "c", ["text", "text", "text"]),
  space("g813", "d", ["text", "text"]),
];
const pagesOf = (s: Space): string[] => [...s.rail, ...s.content.map((c) => c.id)];

interface SwitchTiming {
  toSpaceId: string;
  commitMs: number;
  totalMs: number;
  paintMs: number;
}

const r = (v: number | null | undefined): string => (v === null || v === undefined ? "none" : `${Math.round(v)}`);

function stats(xs: readonly number[]): string {
  if (xs.length === 0) return "none";
  const s = [...xs].sort((a, b) => a - b);
  return `median ${Math.round(s[Math.floor((s.length - 1) / 2)])}, max ${Math.round(s[s.length - 1])}`;
}

describe.skipIf(!SHOULD_RUN)("at0813 — a themed switch and the shell's frame", () => {
  test(
    "ten switches on one theme, ten across themes, each hold and timing noted",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const layout = layoutOf(SPACES) as { spaces: Record<string, unknown>[] };
      for (const s of layout.spaces) s.theme = DARK;
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(layout));
      const app = await launchTugApp({
        testName: "at0813-switch-canvas-grid-reading",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const all = SPACES.flatMap(pagesOf);
        const at = Date.now();
        let ready = 0;
        for (const id of all) {
          const b = await settleFor(() => bodyOf(app, id), (s) => s?.state === "ready" && s.painted === true, Math.max(1_000, AHEAD_MS - (Date.now() - at)));
          if (b?.state === "ready" && b.painted === true) ready += 1;
        }
        note(`deck: ${SPACES.length} workspaces, ${all.length} cards, ${ready} pages ready in ${Math.round((Date.now() - at) / 1000)} s`);
        const mark = await app.evalJS<number>("(window.__deckTrace.enable(true), window.__deckTrace.mark())");
        let current = SPACES[0].id;
        const run = async (label: string): Promise<{ held: number[]; horizons: number; shell: number[]; commit: number[]; paint: number[] }> => {
          const out = { held: [] as number[], horizons: 0, shell: [] as number[], commit: [] as number[], paint: [] as number[] };
          for (let i = 0; i < SWITCHES; i++) {
            const to = SPACES[(SPACES.findIndex((s) => s.id === current) + 1) % SPACES.length];
            const cut = Date.now();
            await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(to.id)} }), null)`);
            await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === to.id, 5_000);
            await Bun.sleep(REST_MS);
            current = to.id;
            const holds = (await app.handOvers()).switchHolds ?? [];
            const hold: SwitchHoldRecord | null = holds.filter((h) => h.fromWall >= cut - 50 && h.toWall !== null).at(-1) ?? null;
            const theme = await app.evalJS<string>("document.documentElement.getAttribute('data-theme') ?? getComputedStyle(document.getElementById('deck-container')).backgroundColor");
            const traces = JSON.parse(
              await app.evalJS<string>(
                `JSON.stringify(window.__deckTrace.since(${mark}).filter(function (e) { return e.kind === "space-switch-timing"; }))`,
              ),
            ) as SwitchTiming[];
            const trace = traces.filter((t) => t.toSpaceId === to.id).at(-1) ?? null;
            if (hold?.heldMs != null) out.held.push(hold.heldMs);
            if (hold?.outcome === "horizon") out.horizons += 1;
            if (hold?.shellMs != null) out.shell.push(hold.shellMs);
            if (trace !== null) {
              out.commit.push(trace.commitMs);
              out.paint.push(trace.paintMs);
            }
            note(
              `${label} ${i + 1} → ${to.id.replace(/g813-|-space/g, "")} (${theme}): held ${r(hold?.heldMs)} ${hold?.outcome ?? "no hold"}, ` +
                `placement ${r(hold?.placementMs)}, shell ${r(hold?.shellMs)}; trace commit ${r(trace?.commitMs)}, total ${r(trace?.totalMs)}, paint ${r(trace?.paintMs)}`,
            );
          }
          return out;
        };
        const same = await run("one theme");
        // Alternate the workspaces' themes, dark and light, the active one included.
        for (const [i, s] of SPACES.entries()) {
          await app.evalJS<null>(`(window.__tug.chooseSpaceTheme(${JSON.stringify(s.id)}, ${JSON.stringify(i % 2 === 0 ? DARK : LIGHT)}), null)`);
        }
        await Bun.sleep(2_000);
        const themed = await run("across themes");
        for (const [label, x] of [["one theme", same], ["across themes", themed]] as const) {
          note(
            `${label}: held ${stats(x.held)}; ${x.horizons}/${SWITCHES} at the horizon; shell answered ${x.shell.length}/${SWITCHES}, ${stats(x.shell)}; ` +
              `trace commit ${stats(x.commit)}, paint ${stats(x.paint)}`,
          );
        }
        expect(same.held.length + themed.held.length).toBeGreaterThan(0);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
