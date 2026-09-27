/**
 * at0632-jot-click-holds-the-scroll.test.ts — a press on a jot row must leave
 * the card's scroll where it is, and a double-click must open the jot that was
 * under the pointer.
 *
 * The Jots card's root is the one scroller and the list inside it stands at its
 * full height, so once there are enough jots to overflow, the list container is
 * always taller than the scrollport. The list's pointerdown re-places itself as
 * the KEYBOARD key view so the ring paints without a blink, and that re-place
 * used to reveal the key view element — the container — which a reveal brings
 * in by its leading edge. Every press therefore parked the list's top at the
 * port and carried a different row under the pointer, so the second press of a
 * double-click opened the wrong jot or nothing at all.
 *
 * The list needs to OVERFLOW for any of this to be visible: with a short list
 * nothing scrolls and the test passes for the wrong reason. Hence 200 jots and
 * a target picked out of the DOM after scrolling to the bottom, so the row
 * really is one the user can see and press.
 *
 * Runs against an isolated jots file (`TUG_JOTS_PATH`) so the user's
 * machine-global jots.json is never touched.
 *
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/jots/jots-card.tsx
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const CARD = ".jots-card";
const EDITOR = ".jots-list .jot-editor";
/** Enough rows that the card overflows in the harness window. Forty did not. */
const JOT_COUNT = 200;

function priorCardDeck() {
  return {
    cards: [
      {
        id: "A",
        componentId: "gallery-accordion",
        title: "Accordion",
        closable: true,
      },
    ],
    panes: [
      {
        id: "pA",
        position: { x: 60, y: 60 },
        size: { width: 520, height: 420 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pA",
    hasFocus: true,
  };
}

/** Short jots, so the overflow comes from the COUNT and every row is one line. */
function seedJots(path: string): void {
  const jots = [];
  for (let i = 1; i <= JOT_COUNT; i += 1) {
    jots.push({ id: `s${i}`, text: `Jot number ${i}` });
  }
  writeFileSync(path, `${JSON.stringify({ version: 1, jots }, null, 2)}\n`);
}

/**
 * Wait until the Jots sidebar has finished sliding in: its left edge has
 * stopped moving between polls and the whole card stands inside the viewport.
 */
async function settleSidebar(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `(() => {
       const c = document.querySelector('${CARD}');
       if (c === null) return false;
       const box = c.getBoundingClientRect();
       const x = Math.round(box.left);
       const settled = window.__jotsCardX === x && box.right <= window.innerWidth;
       window.__jotsCardX = x;
       return settled;
     })()`,
    { timeoutMs: 5_000 },
  );
}

/** Open the Jots card and scroll it to the bottom. */
async function openCardAtBottom(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 5_000 },
  );
  await app.dispatchControlAction("toggle-jots");
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-jot-id="s1"]') !== null`,
    { timeoutMs: 5_000 },
  );
  // The sidebar SLIDES in, and the rows exist from the first frame of that
  // slide — the card stands a full card-width off the right edge until it
  // lands. A native click posted before it lands is aimed at a viewport
  // coordinate outside the web view, which the harness refuses outright.
  await settleSidebar(app);
  await app.evalJS(
    `(() => { const c = document.querySelector('${CARD}');
              c.scrollTop = c.scrollHeight; return 1; })()`,
  );
  // The card must actually have somewhere to scroll, or the whole gesture is
  // unobservable and a green run would mean nothing.
  const scrollTop = await app.waitForCondition<number>(
    `(() => { const c = document.querySelector('${CARD}');
              return c.scrollTop > 100 ? c.scrollTop : false; })()`,
    { timeoutMs: 3_000 },
  );
  note(`at0632: card scrolled to ${scrollTop}px of its ${JOT_COUNT} jots`);
}

/**
 * The id of a row the user can see and press — the last row whose box sits
 * wholly inside the card's scrollport, which after scrolling to the bottom is
 * one near the end of the list.
 */
async function visibleTargetId(app: App): Promise<string> {
  return app.waitForCondition<string>(
    `(() => {
       const card = document.querySelector('${CARD}');
       if (card === null) return false;
       const port = card.getBoundingClientRect();
       const rows = Array.from(
         document.querySelectorAll('.jot-row-content[data-jot-id]'));
       const inside = rows.filter((r) => {
         const b = r.getBoundingClientRect();
         return b.height > 0 && b.top >= port.top && b.bottom <= port.bottom;
       });
       if (inside.length === 0) return false;
       return inside[inside.length - 1].getAttribute('data-jot-id');
     })()`,
    { timeoutMs: 3_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0632 — a jot click holds the card's scroll", () => {
  test(
    "a press leaves the scroll alone and a double-click opens the pressed jot",
    async () => {
      const tugbankPath = mkTempTugbank();
      const jotsDir = mkdtempSync(join(tmpdir(), "tug-at0632-"));
      const jotsPath = join(jotsDir, "jots.json");
      seedJots(jotsPath);
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0632-jot-click-holds-the-scroll",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
          persistInTestMode: true,
        });
        try {
          await openCardAtBottom(app);
          const target = await visibleTargetId(app);
          const row = `.jot-row-content[data-jot-id="${target}"]`;
          note(`at0632: pressing ${target}`);

          const before = await app.evalJS<number>(
            `document.querySelector('${CARD}').scrollTop`,
          );

          // The press. It selects the row and re-places the list as the
          // keyboard key view — and that is all it may do.
          await app.nativeClickAtElement(`${row} .jot-row-label`);
          await app.waitForCondition<boolean>(
            `document.querySelector('${CARD} .jots-list[data-key-view-kbd]') !== null`,
            { timeoutMs: 3_000 },
          );
          expect(
            await app.evalJS<number>(
              `document.querySelector('${CARD}').scrollTop`,
            ),
          ).toBe(before);
          // A reveal that arrives a frame late is the same bug, so look again
          // once the press has had time to settle.
          await new Promise((r) => setTimeout(r, 400));
          expect(
            await app.evalJS<number>(
              `document.querySelector('${CARD}').scrollTop`,
            ),
          ).toBe(before);

          // The double-click. Its second press lands wherever the first press
          // left the list, so the jot that opens is the assertion that the
          // scroll held through the whole gesture.
          await app.nativeDoubleClickAtElement(`${row} .jot-row-label`);
          await app.waitForCondition<boolean>(
            `document.querySelector('${EDITOR}') !== null`,
            { timeoutMs: 3_000 },
          );
          expect(
            await app.evalJS<string | null>(
              `(() => {
                 const header = document.querySelector('${EDITOR} [data-jot-id]');
                 return header === null ? null : header.getAttribute('data-jot-id');
               })()`,
            ),
          ).toBe(target);
        } finally {
          await app.close();
        }
      } finally {
        rmSync(jotsDir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
