/**
 * _row-45.ts — Resize Sidebars to Fit, solved: the verb re-divides a rail,
 * and every member whose share changes is carried to its new height as a
 * crossing whose page is laid out before the motion starts, so the land owes
 * nothing on either side.
 *
 * The deck is a bare left rail of two list cards, Cards and Jots, standing
 * equally divided with no stored division. Their content asks differ, so the
 * verb moves the sash between them: one member grows and the other shrinks
 * and moves. The verb is driven through the app's own path — the real
 * `view.resizeSidebarsToFit` menu item — and each member's `body-land` row,
 * the shell's `settle-land` row and the placer's land measurement are read.
 */

import { expect } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import { BODY_READY_MS, bodyOf, pollFor, settleFor } from "./_bodies";
import { armLandRecords, expectEmptyLand, noteLand } from "./_land";
import { planDiag } from "./_motion";

const TEST_NAME = "body-grounding-row-45-fit";
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 60_000;

const CARDS = "r45-cards";
const JOTS = "r45-jots";
export const MEMBERS = [CARDS, JOTS] as const;
/** A member's share changed when its pane's height moved by more than this, px. */
const MOVED_PX = 0.5;
const SETTLE_MS = 8_000;

/** Cards and Jots on the left rail, equally divided, and nothing else. */
function railDeck(): Record<string, unknown> {
  const pane = (id: string, cardId: string, title: string) => ({
    id,
    position: { x: 0, y: 0 },
    size: { width: 420, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title,
    acceptsFamilies: [] as string[],
  });
  return {
    cards: [
      { id: CARDS, componentId: "cards", title: "Cards", closable: true },
      { id: JOTS, componentId: "jots", title: "Jots", closable: true },
    ],
    panes: [pane("r45-cards-pane", CARDS, "Cards"), pane("r45-jots-pane", JOTS, "Jots")],
    activePaneId: "r45-cards-pane",
    imposition: {
      kind: "three-up",
      sidebars: { cards: { side: "left" }, jots: { side: "left" } },
      rails: { left: { order: ["cards", "jots"] } },
    },
    hasFocus: true,
  };
}

/** Each rail member's pane height, by card id. */
async function paneHeights(app: App): Promise<Record<string, number>> {
  // card-dom: shell — the rail panes and the placeholders naming their cards are the shell's.
  return app.evalJS<Record<string, number>>(`(function () {
    var out = {};
    document.querySelectorAll('.tug-pane[data-rail-side="left"]').forEach(function (el) {
      var placeholder = el.querySelector("[data-body-placeholder][data-card-id]");
      if (placeholder !== null) out[placeholder.getAttribute("data-card-id")] = el.getBoundingClientRect().height;
    });
    return out;
  })()`);
}

const isSettled = (app: App): Promise<boolean> =>
  app.evalJS<boolean>(`document.querySelector("[data-imposer-settling]") === null`);

/** Launch the rail, run the verb once, and assert the solved land for every member it re-divided. */
export async function fitLeg(): Promise<void> {
  const app = await launchTugApp({ testName: TEST_NAME });
  try {
    await app.seedDeckState({ state: railDeck(), focusCardId: CARDS });
    // A list card has no composer, so the wait is the body's own: ready and placed visible.
    for (const id of MEMBERS) {
      const ready = await settleFor(() => bodyOf(app, id), (b) => b !== null && b.state === "ready" && b.visible, BODY_READY_MS);
      expect(ready?.visible, `${id}: the body is ready and placed visible`).toBe(true);
    }
    await pollFor(() => isSettled(app), (v) => v, SETTLE_MS);
    await Bun.sleep(400);
    const before = await paneHeights(app);
    note(`fit: the rail before ${JSON.stringify(before)}`);

    await armLandRecords(app, MEMBERS);
    const bodyMarks = new Map<string, number>();
    for (const id of MEMBERS) bodyMarks.set(id, await app.body(id).markDeckTrace());
    const shellMark = await app.markDeckTrace();
    const runsBefore = (await planDiag(app)).runs;

    await app.performMenuItem("view.resizeSidebarsToFit");

    const plan = await settleFor(
      () => planDiag(app),
      (p) => p.runs > runsBefore && MEMBERS.every((id) => p.last?.landed.some((l) => l.cardId === id) ?? false),
      SETTLE_MS,
    );
    note(`fit: ${plan.runs - runsBefore} plan run(s); last plan ${JSON.stringify(plan.last)}`);
    await pollFor(() => isSettled(app), (v) => v, SETTLE_MS);
    await Bun.sleep(300);
    const after = await paneHeights(app);
    note(`fit: the rail after ${JSON.stringify(after)}`);

    const moved = MEMBERS.filter((id) => Math.abs((after[id] ?? 0) - (before[id] ?? 0)) > MOVED_PX);
    expect(moved, "fit: the verb re-divided the rail, so each member's share changed").toEqual([...MEMBERS]);
    expect(plan.last?.cancelled ?? [], "fit: no carried body was cancelled").toEqual([]);
    for (const id of MEMBERS) {
      expect(plan.last?.planned.includes(id), `fit: the host carried ${id}`).toBe(true);
      expect(plan.last?.landed.some((l) => l.cardId === id), `fit: the host said ${id} landed`).toBe(true);
      const land = await noteLand(app, id, `fit ${id}`, { body: bodyMarks.get(id), shell: shellMark });
      expectEmptyLand(land, `fit ${id}`);
    }
    const drifts = (await app.getDeckTrace({ since: shellMark })).filter(
      (e) => e.kind === "placement-land-drift" && (MEMBERS as readonly string[]).includes((e as { cardId?: string }).cardId ?? ""),
    );
    expect(drifts, "fit: the land's measurement moved nothing the plan landed").toEqual([]);
  } finally {
    await app.close();
  }
}
