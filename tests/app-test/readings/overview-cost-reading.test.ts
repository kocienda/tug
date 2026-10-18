/**
 * overview-cost-reading.test.ts — what the Overview costs the shell's page.
 *
 * A reading, not a bar. With the Overview open in a rail and three session
 * bodies streaming in a four-up flow, it notes the shell's element census
 * (`document.getElementsByTagName("*").length` in the shell's page) and
 * whether the Overview is a body, then drives the flow slide out and back
 * twice and notes the shell's gap rows over each slide — the same rows
 * row 16 reads. Taken before and after the Overview became a body, the two
 * readings say what moving its document out of the shell bought.
 *
 * The only assertions are that the Overview stood up and the slides ran.
 *
 * @foreground
 * @covers tugdeck/src/components/overview/overview-card-registration.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import { cardPage } from "../_harness/card-reach";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { pollFor, sessionPane, spawnStub, waitForBody } from "../body-grounding/_bodies";
import { cardKind, kindPane, kindSidebars } from "../body-grounding/_kinds";

const TEST_NAME = "body-grounding-overview-cost-reading";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const SETTLE_MS = 6_000;

const OVERVIEW = "overview";
const SESSIONS = ["oc-a", "oc-b", "oc-c"];

function deck(): Record<string, unknown> {
  const ids = [...SESSIONS, "oc-n3", "oc-n4"];
  return {
    cards: [
      ...ids.map((id) => ({ id, componentId: "session", title: id, closable: true })),
      { id: OVERVIEW, componentId: "overview", title: "Overview", closable: true },
    ],
    panes: [...ids.map((id, slot) => sessionPane(id, slot)), kindPane("overview", OVERVIEW, 0)],
    activePaneId: `${SESSIONS[0]}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: kindSidebars(["overview"]) },
    hasFocus: true,
  };
}

const lastSeq = (app: App): Promise<number> =>
  app.evalJS<number>(`(function () { var d = window.__deckTrace.dump(); return d.length === 0 ? 0 : d[d.length - 1].seq; })()`);

async function gapRowsSince(app: App, sinceSeq: number): Promise<{ class: string; gapMs: number; periodMs: number }[]> {
  return app.evalJS(
    `window.__deckTrace.dump().filter(function (e) { return e.kind === "settle-gap" && e.seq > ${sinceSeq}; })
      .map(function (e) { return { class: e.class, gapMs: e.gapMs, periodMs: e.periodMs }; })`,
  );
}

const settling = (app: App): Promise<boolean> =>
  app.evalJS<boolean>(`document.querySelector("[data-deck-canvas-background]")?.hasAttribute("data-imposer-settling") ?? false`);

describe.skipIf(!SHOULD_RUN)("reading: the Overview's cost to the shell", () => {
  test(
    "the shell's element census and the flow slide's gaps with the Overview open and three bodies streaming",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: TEST_NAME, foreground: true, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: SESSIONS[0] });
        for (const id of SESSIONS) await spawnStub(app, id, stubDir, 40, 4);
        for (const id of SESSIONS) await waitForBody(app, id);
        const root = JSON.stringify(cardKind("overview").root);
        const up = await pollFor(
          async () => (await cardPage(app, OVERVIEW)).evalJS<boolean>(`document.querySelector(${root}) !== null`),
          (v) => v,
          30_000,
        );
        expect(up, "the Overview stood up").toBe(true);
        await Bun.sleep(1_500);
        const isBody = (await app.bodies()).some((b) => b.cardId === OVERVIEW);
        const census = await app.evalJS<number>(`document.getElementsByTagName("*").length`);
        note(`the Overview is ${isBody ? "a body" : "in the shell's document"}; the shell's element census ${census}`);

        let slides = 0;
        for (let round = 1; round <= 2; round++) {
          for (const slot of [2, 1]) {
            const seq = await lastSeq(app);
            const began = Date.now();
            await app.evalJS<null>(`(window.__tug.dispatchControlAction("go-to-slot", { value: ${slot} }), null)`);
            const seen = await pollFor(() => settling(app), (v) => v, 1_000);
            await pollFor(() => settling(app), (v) => !v, SETTLE_MS);
            const tookMs = Date.now() - began;
            await Bun.sleep(300);
            const gaps = await gapRowsSince(app, seq);
            const judder = gaps.filter((g) => g.class === "judder");
            const worst = judder.reduce((w, g) => Math.max(w, g.gapMs / g.periodMs), 0);
            note(`slide ${round}.${slot}: settled in ${tookMs} ms; ${judder.length} judder, ${gaps.length - judder.length} lead (a row is a late frame); worst in-motion ${worst.toFixed(2)} periods`);
            if (seen) slides += 1;
          }
        }
        expect(slides, "every slide settled").toBe(4);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
