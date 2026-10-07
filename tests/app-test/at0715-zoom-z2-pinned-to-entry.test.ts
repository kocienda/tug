/**
 * at0715-zoom-z2-pinned-to-entry.test.ts — under View › Zoom a Session card's
 * Z2 strip sits directly on its prompt entry, at every factor.
 *
 * | Test                  | What would break without it                        |
 * |-----------------------|----------------------------------------------------|
 * | Z2 meets the entry at | Z2 left `position: sticky` at rest: inside the     |
 * | 50 %–200 %            | deck root's `transform: scale(f)` WebKit takes the |
 * |                       | scrollport's edge as its height × f, and holds Z2  |
 * |                       | that far up whenever the entry region is shorter   |
 * |                       | than (1 − f) of the card — a band of transcript    |
 * |                       | showing between Z2 and the composer                |
 *
 * The shape is the one that showed it on a real deck: an imposed four-up
 * card, full height, with a transcript long enough to scroll. At 80 % its
 * entry region is about 18 % of the card, under the 20 % that would keep the
 * held edge below Z2, so the strip stood 23 px above the composer; at 50 %,
 * 393 px. Read as layout boxes, because the hold is resolved at layout: Z2's
 * bottom edge and the entry region's top edge are one line.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const FEED_CODE_OUTPUT = 0x40;
const SID = "at0715-A";
const TURNS = 40;

/** Every step View › Zoom can reach, 50 % to 200 % in 10 % steps. */
const FACTORS = Array.from({ length: 16 }, (_, i) => (50 + i * 10) / 100);

/** Viewport-px slack on the meeting line: one rounding at each edge. */
const SLACK_PX = 1;

function deckShape(): Record<string, unknown> {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: 675, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      { id: "B", componentId: "hello", title: "B", closable: true },
    ],
    panes: [pane("p1", 0, "A"), pane("p2", 1, "B")],
    activePaneId: "p1",
    imposition: { kind: "four-up", layout: "flow" },
    hasFocus: true,
  };
}

async function standUp(): Promise<App> {
  const app = await launchTugApp({ testName: "at0715-zoom-z2-pinned-to-entry" });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 20_000 });
  const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
    app.driveSession("A", {
      op: "ingestFrame",
      feedId: FEED_CODE_OUTPUT,
      decoded: { tug_session_id: SID, ...decoded },
    });
  for (let i = 0; i < TURNS; i++) {
    const msgId = `${SID}-m${i}`;
    await app.driveSession("A", { op: "send", text: `prompt ${i}\nline two\nline three` });
    await frame({ type: "prompt_anchor", promptUuid: `${SID}-u${i}` });
    await frame({ type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text" });
    await frame({
      type: "assistant_text",
      msg_id: msgId,
      block_index: 0,
      text: `reply ${i}\n\nmore text here\n\nand more`,
      is_partial: false,
    });
    await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
  }
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-card-id="A"] [data-slot="session-card-status-bar"] [data-slot="tug-status-cell"]') !== null`,
    { timeoutMs: 20_000 },
  );
  return app;
}

interface Edges {
  z2Bottom: number;
  entryTop: number;
  /** The entry region's share of the card's height — what decides whether a held edge would bite. */
  entryShare: number;
}

function edges(app: App): Promise<Edges> {
  return app.evalJS<Edges>(`(function () {
    var card = document.querySelector('[data-card-id="A"] .session-card');
    var z2 = card.querySelector('[data-slot="session-card-status-bar"]').getBoundingClientRect();
    var entry = card.querySelector('.session-card-entry-region').getBoundingClientRect();
    var box = card.getBoundingClientRect();
    return {
      z2Bottom: Math.round(z2.bottom * 100) / 100,
      entryTop: Math.round(entry.top * 100) / 100,
      entryShare: Math.round((entry.height / box.height) * 1000) / 1000,
    };
  })()`);
}

describe.skipIf(!SHOULD_RUN)("AT0715: Z2 stays on the prompt entry under View › Zoom", () => {
  test(
    "Z2's bottom edge is the entry region's top edge at every factor from 50 % to 200 %",
    async () => {
      const app = await standUp();
      try {
        const readings: Record<string, Edges> = {};
        for (const f of FACTORS) {
          expect(await app.setPageZoom(f)).toBeCloseTo(f, 5);
          readings[f] = await edges(app);
        }
        await app.setPageZoom(1);
        note("Z2 bottom / entry top by factor", readings);
        for (const [key, r] of Object.entries(readings)) {
          expect(Math.abs(r.z2Bottom - r.entryTop), `Z2 meets the entry at ${key}`).toBeLessThanOrEqual(
            SLACK_PX,
          );
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
