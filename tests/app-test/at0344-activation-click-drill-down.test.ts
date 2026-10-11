/**
 * at0344-activation-click-drill-down.test.ts — one click activates a card AND
 * lands the caret where it landed.
 *
 * ## Why this exists
 *
 * The activating click used to be spent on the activation alone. The gesture
 * interpreter classified a cross-card click as `placement: "suppressed"` and
 * `preventMousedownDefault: true`, so the transfer restored the card's
 * *recorded* focus destination and the click's own target was discarded — a
 * user who aimed at the composer of a background card got the card activated
 * and then had to click the same pixel a second time to get a caret.
 *
 * The rule now: an activating click **drills down** to what it landed on, when
 * the click names something the engine can address. On unaddressable content
 * (transcript prose, a bare container) it names nothing, so the card's recorded
 * destination is still the only answer and stands — that half is what keeps a
 * freshly-activated card from ending up with no keyboard at all.
 *
 * ## Test matrix
 *
 *   1. A click into the composer of a NON-first-responder card activates it and
 *      leaves the caret in that composer, in one click.
 *   2. The same, aimed at the composer's BLANK BAND — the space below the last
 *      line, which on an empty composer is nearly all of it. The band is editor
 *      (`cursor: text`, caret landed by `host-click.ts`) but it is not
 *      `contentEditable`, so a drill-down keyed on the content box alone works
 *      when the click hits a line of text and not when it hits the space under
 *      it. That is the "sometimes" failure this case exists to pin.
 *   3. A click on the same card's transcript — content the drill-down
 *      deliberately does not claim — activates it and restores the card's own
 *      destination instead of stranding the keyboard.
 *
 * @covers tugdeck/src/gesture-interpreter.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const FEED_CODE_OUTPUT = 0x40;
const SID_A = "c7c0d1ea-0000-4000-8000-000000000344";
const SID_B = "c7c0d1ea-0000-4000-8000-000000000345";

const composerOf = (card: string) =>
  `[data-card-id="${card}"] [data-slot="tug-prompt-entry"] [data-slot="tug-text-editor"] .cm-content`;

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "A", closable: true },
      { id: "B", componentId: "session", title: "B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 40 },
        size: { width: 640, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 700, y: 40 },
        size: { width: 640, height: 620 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

const f = (sid: string, decoded: Record<string, unknown>) => ({
  op: "ingestFrame" as const,
  feedId: FEED_CODE_OUTPUT,
  decoded: { tug_session_id: sid, ...decoded },
});

/** Whether the given card's composer holds the caret. */
const caretIn = (card: string) =>
  `(() => {
    const el = document.querySelector(${JSON.stringify(composerOf(card))});
    return el !== null && document.activeElement !== null &&
      el.contains(document.activeElement);
  })()`;

async function seedBoth(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "B" });
  for (const card of ["A", "B"]) {
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(card)})`,
      { timeoutMs: 15_000 },
    );
  }
  await app.bindSession("A", { tugSessionId: SID_A });
  await app.bindSession("B", { tugSessionId: SID_B });
  for (const card of ["A", "B"]) {
    await app.waitForCondition<boolean>(
      `document.querySelector('[data-card-id="${card}"] [data-slot="session-telemetry-status-row"]') !== null`,
      { timeoutMs: 8000 },
    );
  }
  // One committed turn in A, so its transcript has prose to click on.
  await app.driveSession("A", { op: "send", text: "ask" });
  await app.driveSession("A", f(SID_A, {
    type: "assistant_text",
    status: "complete",
    msg_id: "m0",
    text: "a settled reply with plain prose in it.",
    is_partial: false,
    rev: 0,
    seq: 0,
  }));
  await app.driveSession("A", f(SID_A, {
    type: "turn_complete",
    seq: 0,
    msg_id: "m0",
    result: "success",
  }));
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('[data-card-id="A"] [data-tug-list-cell-index]').length >= 2`,
    { timeoutMs: 10_000 },
  );
}

/** Park the first responder on B, so the next click on A is an activation. */
async function parkOnB(app: App): Promise<void> {
  await app.nativeClickAtElement(composerOf("B"));
  await app.waitForCondition<boolean>(caretIn("B"), { timeoutMs: 8000 });
}

describe.skipIf(!SHOULD_RUN)("AT0344: the activating click drills down", () => {
  test(
    "one click into a background card's composer activates it and lands the caret",
    async () => {
      const app = await launchTugApp({
        testName: "at0344-activation-click-drill-down",
      });
      try {
        await seedBoth(app);
        await parkOnB(app);

        // --- 1. Aimed at a field: the click gets both the activation and the
        //        caret. ONE click — the whole point. ---
        await app.nativeClickAtElement(composerOf("A"));
        await app.waitForCondition<boolean>(
          `window.__tug.getActiveCardId() === "A"`,
          { timeoutMs: 8000 },
        );
        expect(
          await app.evalJS<boolean>(caretIn("A")),
          "the activating click leaves the caret in the composer it landed on",
        ).toBe(true);

        // --- 2. Aimed at the blank band under the last line. Clicked near the
        //        composer's bottom edge, well below any text, which is where a
        //        content-box-only rule silently stops drilling. ---
        await parkOnB(app);
        const band = await app.evalJS<{ x: number; y: number } | null>(
          `(function(){
            const host = document.querySelector('[data-card-id="A"] [data-slot="tug-prompt-entry"] [data-slot="tug-text-editor"]');
            if (host === null) return null;
            const r = host.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 8) };
          })()`,
        );
        expect(band).not.toBeNull();
        await app.nativeClick(band!);
        await app.waitForCondition<boolean>(
          `window.__tug.getActiveCardId() === "A"`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(caretIn("A"), { timeoutMs: 8000 });

        // --- 3. Aimed at unaddressable content: the card's own recorded
        //        destination answers, and the keyboard is never stranded. ---
        await parkOnB(app);
        await app.nativeClickAtElement(
          '[data-card-id="A"] [data-tug-list-cell-index="1"]',
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getActiveCardId() === "A"`,
          { timeoutMs: 8000 },
        );
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('[data-card-id="A"] [data-key-view]') !== null || ${caretIn("A")}`,
          ),
          "a click on prose still leaves the activated card holding the keyboard",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
