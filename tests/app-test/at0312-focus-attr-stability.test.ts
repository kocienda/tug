/**
 * at0312-focus-attr-stability.test.ts — the focus/responder attribute stamps
 * are render-stable: `data-tug-focusable`, `data-tug-focus-key`, and
 * `data-responder-id` are written once at attach and never rewritten by
 * re-renders.
 *
 * The failure mode this guards ([S7] write hygiene, arc/aug01-perf-brief.md):
 * a ref callback whose identity changes per render (an inline lambda, or a
 * Radix `asChild` slot recomposing its merged ref every render) is answered by
 * React with a detach/attach cycle in every commit — and a naive attach
 * handler re-stamps its DOM attributes each time. Each write dirties style on
 * the full document, so at deck scale the stamps alone billed a measurable
 * share of the keystroke queue delay. The hooks are now idempotent under
 * detach/attach; this test streams partial frames into a session card (a
 * continuous re-render load through the exact Radix trigger path that churned)
 * while a MutationObserver counts writes of the three attributes. The budget
 * is zero.
 *
 * @covers tugdeck/src/components/tugways/use-focusable.tsx
 * @covers tugdeck/src/components/tugways/use-responder.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import { mkTempTugbank, seedTugbankForLaunch } from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const FEED_CODE_OUTPUT = 0x40;

/** Streamed partial frames driven while the observer counts. */
const STREAM_FRAMES = 40;
/** Milliseconds between partial frames — enough cadence to force re-renders. */
const CADENCE_MS = 80;

const OBSERVE = `(function () {
  window.__at0312 = { writes: [], armed: true };
  var ATTRS = ["data-tug-focusable", "data-tug-focus-key", "data-responder-id"];
  var mo = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type !== "attributes") continue;
      if (ATTRS.indexOf(m.attributeName) < 0) continue;
      var el = m.target;
      window.__at0312.writes.push(
        m.attributeName + " @ " + el.tagName.toLowerCase() +
        "." + String(el.className || "").split(" ")[0]
      );
    }
  });
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ATTRS,
    subtree: true,
  });
  window.__at0312.stop = function () {
    mo.disconnect();
    window.__at0312.armed = false;
    return window.__at0312.writes.length;
  };
  return "observing";
})()`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "", closable: true }],
    panes: [
      {
        id: "p0",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 1100 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
        slot: 0,
      },
    ],
    activePaneId: "p0",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("at0312 focus-attr stability", () => {
  test(
    "streaming re-renders never rewrite focus/responder attributes",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: "at0312-focus-attr-stability",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        // Engine-readiness is answered from the deck-trace ring; without the
        // trace enabled `awaitEngineReady` can never see the event.
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 8_000 },
        );

        const sid = "at0312-A";
        await app.bindSession("A", { tugSessionId: sid });
        await app.awaitEngineReady("A", { timeoutMs: 20_000 });
        await app.driveSession("A", { op: "send", text: "go" });

        // Arm AFTER binding: mount-time attach writes are legitimate; the
        // budget under test is the steady-state re-render load.
        const armed = await app.evalJS<string>(OBSERVE);
        expect(armed).toBe("observing");

        // Stream partials at cadence — every frame re-renders the card,
        // the prompt entry, and the Radix-slotted triggers.
        for (let n = 0; n < STREAM_FRAMES; n++) {
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: {
              type: "assistant_text",
              tug_session_id: sid,
              msg_id: `${sid}-m0`,
              text: `streaming line ${n}\n`.repeat(n + 1),
              is_partial: n < STREAM_FRAMES - 1,
            },
          });
          await new Promise((r) => setTimeout(r, CADENCE_MS));
        }

        const writes = await app.evalJS<number>(
          `window.__at0312.stop()`,
        );
        const detail = await app.evalJS<string>(
          `JSON.stringify(window.__at0312.writes.slice(0, 20))`,
        );
        expect(`${writes} ${detail}`).toBe("0 []");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
