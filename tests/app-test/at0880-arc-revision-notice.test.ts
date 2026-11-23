/**
 * at0880-arc-revision-notice.test.ts — a live arc whose brief moved offers
 * Keep going, Open successor and Discard and reopen, on the Docket card and on
 * the arc shade, and a parked arc moves to the Parked group.
 *
 * ## What this gates
 *
 * The unit tests pin the summary, the boundary order and the successor's
 * opening; the Rust tests pin the revision's derivation and the park. What
 * only the app can show is the revision reaching both surfaces from the real
 * server, a press going round the CONTROL verbs and back through the DOCKETS
 * feed, and the successor's Session card opening on the server's answer.
 *
 *   A. **The notice shows on both surfaces.** With brief v2 changing the
 *      decision done step 2 carries, the Docket row and the arc shade's Brief
 *      panel both say "touches step 2", and the row suggests a successor
 *      after step 1.
 *   B. **Keep going quiets it.** The notice leaves the row, and the arc stays
 *      marked stale.
 *   C. **Open successor opens the successor.** On brief v3, "After step 1"
 *      parks the stopped arc and opens a Session card whose first turn is
 *      `/tugplug:arc rail-v3 <brief> --successor-of rail --from <step 1>`.
 *   D. **The parked arc is listed under Parked**, named for its successor,
 *      with Discard.
 *
 * @covers tugdeck/src/components/tugways/cards/arc-revision-notice.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-content.tsx
 * @covers tugdeck/src/components/docket/docket-card.tsx
 * @covers tugdeck/src/lib/docket-authoring.ts
 * @covers tugdeck/src/lib/docket-loop-actions.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { note, type App } from "./_harness";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  awaitOpenedSession,
  awaitResponder,
  captureIdea,
  focusDocket,
  launchAuthoring,
  makeAuthoringScratch,
  newDocket,
  rmAuthoringScratch,
  sessionCards,
  type AuthoringScratch,
} from "./docket-authoring-fixture";
import {
  arcRow,
  bindStaleArc,
  makeStaleArc,
  readArcRow,
  reviseBrief,
  type RowReading,
} from "./docket-loop-fixture";

const SID = "aa11bb22-0000-4000-8000-00000000a880";
const ARC = "rail";
const IDEA = "lay the rail in three pieces";

const CARD = '[data-card-id="A"]';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const SLOT = `${CARD} .session-view-slot`;
const SHADE_NOTICE = `${SHADE} [data-slot="arc-revision-notice"]`;
const BOUNDARY_ITEM = '[data-testid="arc-revision-boundaries"] .tug-menu-item';

let s: AuthoringScratch | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  s = makeAuthoringScratch("at0880", SID);
});

afterAll(() => {
  rmAuthoringScratch(s);
});

/** Raise A's arc shade and wait for it to settle against its slot. */
async function raiseShade(app: App): Promise<void> {
  await app.dispatchControlAction("focus-session-card", { cardId: "A" });
  await awaitResponder(app, "A");
  await app.dispatchControlAction("toggle-arc-shade");
  await app.body("A").waitForCondition<boolean>(
    `(function(){
      var s = document.querySelector(${JSON.stringify(SHADE)});
      var slot = document.querySelector(${JSON.stringify(SLOT)});
      if (s === null || slot === null || s.getAttribute("data-raised") !== "true") return false;
      return Math.abs(s.getBoundingClientRect().bottom - slot.getBoundingClientRect().bottom) <= 1;
    })()`,
    { timeoutMs: 10_000 },
  );
}

/** Wait until the arc's row reads as `want` says, noting what it read on a miss. */
async function awaitRow(
  app: App,
  what: string,
  want: (row: RowReading) => boolean,
): Promise<RowReading> {
  const deadline = Date.now() + 20_000;
  let last: RowReading | null = null;
  for (;;) {
    last = await readArcRow(app, ARC);
    if (last !== null && want(last)) return last;
    if (Date.now() > deadline) {
      const line = await app.body("D").evalJS<string | null>(
        `(document.querySelector('[data-slot="docket-filing-line"]') || {}).textContent || null`,
      );
      note(`docket row: ${what}`, JSON.stringify({ last, line }));
      throw new Error(`the arc's row never ${what}`);
    }
    await Bun.sleep(100);
  }
}

/** Mark a control inside the arc's row and press it for real. */
async function pressInRow(app: App, selector: string): Promise<void> {
  await focusDocket(app);
  const mark = "data-loop-press";
  await app.body("D").evalJS<null>(
    `(function(){
      document.querySelectorAll("[${mark}]").forEach(function (el) { el.removeAttribute("${mark}"); });
      var el = ${arcRow(ARC)}.querySelector(${JSON.stringify(selector)});
      el.setAttribute("${mark}", "1");
      return null;
    })()`,
  );
  await app.body("D").nativeClickAtElement(`[${mark}="1"]`);
}

describe.skipIf(!SHOULD_RUN)("at0880 — the arc revision notice and the Parked list", () => {
  test(
    "a moved brief offers its answers on both surfaces; Keep going quiets it; Open successor parks the arc and opens its successor",
    async () => {
      const { app, close } = await launchAuthoring(s!, "at0880-arc-revision-notice");
      try {
        await newDocket(app, "Rail");
        await captureIdea(app, IDEA);
        const made = makeStaleArc(s!, ARC, IDEA);
        bindStaleArc(s!, ARC);

        // ---- A. The notice shows on both surfaces. -------------------------
        const shown = await awaitRow(app, "showed the notice", (r) => r.notice !== null);
        expect(shown.notice).toEqual({
          summary: "Brief moved v1 → v2: 1 changed; touches step 2",
          offer: "successor_step",
          parked: null,
          suggested: "step:1",
        });
        expect(shown.stale).toBe(true);
        await raiseShade(app);
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var n = document.querySelector(${JSON.stringify(SHADE_NOTICE)});
            return n !== null && (n.textContent || "").indexOf("touches step 2") !== -1;
          })()`,
          { timeoutMs: 20_000 },
        );

        // ---- B. Keep going quiets it. --------------------------------------
        await pressInRow(app, '[data-slot="arc-revision-keep-going"]');
        const kept = await awaitRow(app, "quieted its notice", (r) => r.notice === null);
        expect(kept.stale, "the arc stays marked stale").toBe(true);

        // ---- C. Open successor opens the successor. ------------------------
        reviseBrief(s!, {
          sketch: made.sketch,
          brief: made.brief,
          second: "Lay the second rail across the first.",
          from: 1,
        });
        const again = await awaitRow(app, "showed the v3 notice", (r) => r.notice !== null);
        expect(again.notice?.summary).toBe("Brief moved v1 → v3: 1 changed; touches step 2");
        const known = await sessionCards(app);
        await pressInRow(app, '[data-slot="arc-revision-open-successor"] [data-slot="tug-popup-button"]');
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BOUNDARY_ITEM)}) !== null`,
          { timeoutMs: 5_000 },
        );
        const labels = await app.body("D").evalJS<string[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(BOUNDARY_ITEM)})).map(function (el) { return (el.textContent || "").trim(); })`,
        );
        expect(labels).toEqual(["After step 1 (suggested)", "After step 2", "From the start"]);
        await app.body("D").nativeClickAtElement(`${BOUNDARY_ITEM}[data-item-id="0"]`);
        const opened = await awaitOpenedSession(app, known, [
          "arc",
          `rail-v3 ${made.brief} --successor-of ${ARC} --from `,
          made.steps[0].slice(0, 9),
        ]);
        expect(opened.turn).not.toContain(made.steps[1].slice(0, 9));

        // ---- D. The parked arc is listed under Parked. ---------------------
        const parked = await awaitRow(app, "moved to the Parked group", (r) => r.parkedGroup);
        expect(parked.parkedNote).toBe("parked for rail-v3Discard");
        expect(
          await app.body("D").evalJS<boolean>(
            `${arcRow(ARC)}.querySelector('[data-slot="docket-parked-discard"]') !== null`,
          ),
        ).toBe(true);
      } finally {
        await close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
