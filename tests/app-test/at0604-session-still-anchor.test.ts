/**
 * at0604-session-still-anchor.test.ts — a session card says which edge its
 * held picture hangs from, and says it from follow-bottom.
 *
 * ## What this gates
 *
 * While a frame's height tweens, the pane holds the card's root at one
 * definite height and clips it. Which edge that held picture hangs from is the
 * card's to declare: `data-still-anchor="bottom"` on the root hangs it from
 * the content box's bottom, so the composer, the status row and a pinned
 * transcript ride the frame's edge together; absent, it hangs from the top.
 *
 * The session card declares it from the transcript's follow-bottom intent, as
 * a DOM write with no React state in between. A FOLLOWING transcript is
 * bottom-anchored because that is what its own pinned layout does at every
 * intermediate height. A SCROLLED-UP one is top-anchored, because its resize
 * episode restores a top anchor at landing and a bottom-hung picture would
 * jump the text by the height delta.
 *
 * So the claims are about the attribute tracking the intent, in both
 * directions and from the first frame:
 *
 *   1. **At mount, following.** The list view surfaces its initial intent from
 *      its own mount effect, before the transcript's root ref is attached; a
 *      write that only ran from the callback would miss it, and a card that
 *      was never scrolled would never be anchored.
 *   2. **Scrolled up, the attribute is gone.** Not `"top"`, not `"false"` —
 *      absent, which is what the pane's selector reads.
 *   3. **Back at the bottom, it returns.**
 *
 * The jump button's `data-visible` is read beside each claim: it is written by
 * the same callback, so it is the witness that follow-bottom really moved and
 * the attribute is being compared against something.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/lib/fold-crossing.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const FEED_CODE_OUTPUT = 0x40;

const SID = "at0604-A";
const TURNS = 40;
const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';
const JUMP_BUTTON = ".tug-jump-to-bottom-button";
const CARD_ROOT = '[data-slot="session-card"]';

function deckShape(): Record<string, unknown> {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 760 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

async function seedTurn(app: App, n: number): Promise<void> {
  const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
    app.driveSession("A", {
      op: "ingestFrame",
      feedId: FEED_CODE_OUTPUT,
      decoded: { tug_session_id: SID, ...decoded },
    });
  const msgId = `${SID}-m${n}`;
  await app.driveSession("A", { op: "send", text: `prompt ${n}` });
  await frame({ type: "prompt_anchor", promptUuid: `${SID}-u${n}` });
  await frame({
    type: "content_block_start",
    msg_id: msgId,
    block_index: 0,
    kind: "text",
  });
  await frame({
    type: "assistant_text",
    msg_id: msgId,
    block_index: 0,
    text: `## step ${n}\n\nReply number ${n}, long enough to take a few lines of the transcript so that forty of them overflow the scrollport.\n\n- marker ${n}`,
    is_partial: false,
  });
  await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
}

interface AnchorSnap {
  anchor: string | null;
  buttonVisible: string | null;
  distanceFromBottom: number;
}

function readAnchor(app: App): Promise<AnchorSnap> {
  return app.evalJS<AnchorSnap>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var card = document.querySelector('${CARD_ROOT}');
  var btn = document.querySelector('${JUMP_BUTTON}');
  return {
    anchor: card === null ? null : card.getAttribute("data-still-anchor"),
    buttonVisible: btn === null ? null : btn.getAttribute("data-visible"),
    distanceFromBottom: el.scrollHeight - el.clientHeight - el.scrollTop,
  };
})()`);
}

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0604: the session card's still anchor", () => {
  test(
    "the anchor attribute tracks follow-bottom from mount, in both directions",
    async () => {
      const app = await launchTugApp({ testName: "at0604-still-anchor" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A", { timeoutMs: 20_000 });
        await app.waitForCondition<boolean>(
          `document.querySelector('${SCROLLER}') !== null`,
          { timeoutMs: 15_000 },
        );

        // 1. At mount, before any scroll and before any content: following.
        const mounted = await readAnchor(app);
        note("at mount", JSON.stringify(mounted));
        expect(mounted.anchor, "a fresh card is bottom-anchored").toBe("bottom");

        for (let n = 0; n < TURNS; n += 1) await seedTurn(app, n);
        await wait(800);
        const following = await readAnchor(app);
        note("following a long transcript", JSON.stringify(following));
        expect(following.distanceFromBottom).toBeLessThanOrEqual(4);
        expect(following.anchor, "still bottom-anchored while pinned").toBe(
          "bottom",
        );

        // 2. Leave the bottom the way a scrollbar drag does.
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollTop - 900;
  return el.scrollTop;
})()`);
        await wait(500);
        const scrolledUp = await readAnchor(app);
        note("scrolled up", JSON.stringify(scrolledUp));
        expect(
          scrolledUp.buttonVisible,
          "follow-bottom disengaged (the jump button is the witness)",
        ).toBe("true");
        expect(
          scrolledUp.anchor,
          "a scrolled-up transcript is top-anchored: the attribute is absent",
        ).toBeNull();

        // 3. Back to the bottom, through the card's own door.
        await app.evalJS<null>(
          `(document.querySelector('${JUMP_BUTTON}').click(), null)`,
        );
        await wait(800);
        const back = await readAnchor(app);
        note("back at the bottom", JSON.stringify(back));
        expect(back.buttonVisible, "follow-bottom re-engaged").toBe("false");
        expect(back.anchor, "and the bottom anchor returns").toBe("bottom");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
