/**
 * at0277-lens-row-accessories-keyboard.test.ts — the Lens's row accessories and
 * the Layouts segments answer the keyboard.
 *
 * ## What this gates
 *
 * Three surfaces in the Lens were reachable only by pointer, which under the
 * focus language means they did not exist at all for a keyboard user:
 *
 *  - **A jot row's copy / delete buttons.** They render inside the list's
 *    per-row focus mode, so authoring them into a focus group is what makes
 *    ArrowRight on the cursor row descend onto them. The row's trailing cluster
 *    already reveals itself for the keyboard cursor, so the affordance is on
 *    screen before the descend arrives.
 *  - **A row's slot picker.** Same authoring, on the Cards rows'
 *    numbered slots. The deck always stands under an arrangement, so the picker
 *    is always there; a multi-slot kind is what gives it more than one position.
 *  - **The Layouts segments.** The CARDS axis is one segment run, and both
 *    arrow axes walk it without committing — the choice-group contract at0118
 *    pins. Off the run's END, Down means down: the ring leaves for the group
 *    below rather than wrapping or sticking.
 *
 * The first two also pin a boundary the accessories created: the jots list
 * declares `commitOnEnter="act"` (Enter opens the jot), and a row that
 * gains a focusable must not let the generic Enter-descends-a-navigable-row
 * default quietly take Enter over. Right descends; Enter still opens.
 *
 * Two more rules ride the same drive, both about the marks staying honest:
 * the jots list's SELECTION follows its cursor (`selectionFollowsCursor`),
 * so the fill and the cursor bar are never on two different rows; and once the
 * key view has descended into a row, Right / Left walk the row's accessories
 * and Left off the first one ascends — the arrow that entered walks.
 *
 * @covers tugdeck/src/components/cards/slot-picker.tsx
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/lens/sections/layouts-section.tsx
 * @covers tugdeck/src/components/jots/jots-card.tsx
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/spatial-order.ts
 * @covers tugdeck/src/components/tugways/tug-slot-layout.tsx
 * @covers tugdeck/src/components/tugways/tug-slot.tsx
 * @covers tugdeck/src/components/tugways/use-item-group-keyboard.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const JOTS_LIST = ".jots-card .jots-list";
const JOTS_KBD = `${JOTS_LIST}[data-key-view-kbd]`;
const CURSOR_ROW = `${JOTS_LIST} [data-key-cursor]`;
const KIND_GROUP = '[data-testid="lens-layouts-kind"]';

const JOTS = Array.from({ length: 4 }, (_, i) => ({
  id: `s${i}`,
  text: `row-${i} jot handle`,
}));

function priorCardDeck() {
  return {
    // A Text card, so the Lens's Cards band has a row to descend into once
    // an imposition turns its slot picker on.
    cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
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
    // Stated, not inherited: the arrangement is deck state, and a seed that
    // omits it takes whatever arrangement the machine's own saved deck was
    // left in — which decides where the CARDS cursor starts, and so whether
    // section C's walk begins where it says it does.
    imposition: { kind: "one-up", lens: "right" },
    hasFocus: true,
  };
}

/** The `aria-label` of whatever currently holds the keyboard key view. */
async function kbdLabel(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function(){
      var el = document.querySelector('.jots-card [data-key-view-kbd], .cards-card [data-key-view-kbd], .lens-content [data-key-view-kbd]');
      return el === null ? null : el.getAttribute('aria-label');
    })()`,
  );
}

/**
 * Tab until `selector` holds the keyboard key view; throws if it never does.
 *
 * The check runs after EVERY Tab, including the last, and the bound is a
 * runaway guard rather than a claim about the walk's length. Both matter: with
 * all three Lens sections expanded and the Cards filter live, the walk from the
 * Layouts list round to the Cards list is exactly twelve stops — so a loop that
 * spent its last Tab and then threw without re-checking reported a walk that
 * had in fact arrived.
 */
async function tabUntilKbd(app: App, selector: string): Promise<void> {
  const reached = (): Promise<boolean> =>
    app.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(`${selector}[data-key-view-kbd]`)}) !== null`,
    );
  for (let i = 0; i < 20; i += 1) {
    if (await reached()) return;
    await app.nativeKey("Tab");
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  if (await reached()) return;
  throw new Error(`Tab never reached ${selector}`);
}

describe.skipIf(!SHOULD_RUN)("at0277 — Lens row accessories answer the keyboard", () => {
  test(
    "Right descends onto a jot row's buttons and onto a slot, and the Layouts segments walk as rows",
    async () => {
      const tugbankPath = mkTempTugbank();
      const filesDir = mkdtempSync(join(tmpdir(), "tug-at0277-"));
      const jotsPath = join(filesDir, "jots.json");
      const filePath = join(filesDir, "fixture.txt");
      writeFileSync(filePath, "alpha meridian\n");
      writeFileSync(
        jotsPath,
        `${JSON.stringify({ version: 1, jots: JOTS }, null, 2)}\n`,
      );
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0277-lens-row-accessories-keyboard",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
        });
        try {
          await app.seedDeckState({
            state: priorCardDeck(),
            cardStates: {
              A: { content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            },
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );
          // This test spans two surfaces: the Jots card's rows and the Lens's
          // Layouts segments. Open both, and start on a jot row — opening a card
          // is not a keyboard entry, so the click is what puts the movement
          // cursor on the row (the Lens band click used to do that here).
          await app.dispatchControlAction("toggle-lens");
          await app.dispatchControlAction("toggle-jots");
          await app.waitForCondition<boolean>(
            `document.querySelector(".jots-card .jots-list .jot-row-label") !== null`,
            { timeoutMs: 5_000 },
          );
          await app.nativeClickAtElement(".jots-card .jots-list .jot-row-label");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CURSOR_ROW)}) !== null`,
            { timeoutMs: 3_000 },
          );

          // ---- A0. Selection follows the cursor: arrowing down carries the
          // fill with it, so the lit row and the row the section verbs act on
          // are never two different rows.
          await app.nativeKey("ArrowDown");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(
              `${JOTS_LIST} [data-key-cursor][data-selected="true"]`,
            )}) !== null`,
            { timeoutMs: 3_000 },
          );
          // Exactly one row wears the fill — the selection MOVED with the
          // cursor rather than a second row lighting up beside the first.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(
                `${JOTS_LIST} .tug-list-view-cell[data-selected="true"]`,
              )}).length`,
            ),
          ).toBe(1);

          // ---- A. ArrowRight descends onto the cursor row's Copy button.
          await app.nativeKey("ArrowRight");
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector('.jots-card [data-key-view-kbd], .cards-card [data-key-view-kbd], .lens-content [data-key-view-kbd]');
              return el !== null && el.getAttribute('aria-label') === 'Copy jot';
            })()`,
            { timeoutMs: 3_000 },
          );

          // The row's trailing cluster is genuinely on screen, not a ring on a
          // zero-width slot — the descend has to land somewhere the eye can see.
          expect(
            await app.evalJS<number>(
              `Math.round(document.querySelector('.jots-card [data-key-view-kbd], .cards-card [data-key-view-kbd], .lens-content [data-key-view-kbd]').getBoundingClientRect().width)`,
            ),
          ).toBeGreaterThan(0);

          // The list does not go dark behind the descend. What says where the
          // accessory came from is the CURSOR BAR holding its place on the row
          // that was descended from — losing it left the focus on a lone button
          // with nothing around it to say what it belonged to, which is the
          // behaviour this pins. The container itself marks nothing ([D122]):
          // neither an outline nor a background layer, in the within state any
          // more than in the key-view one. The list is still `data-key-within`,
          // so this is the suppression holding, not the attribute being absent.
          const descended = await app.evalJS<{
            within: boolean;
            wash: string;
            outlineWidth: string;
            cursorRows: number;
          }>(
            `(function(){
              var list = document.querySelector(${JSON.stringify(JOTS_LIST)});
              var cs = list === null ? null : getComputedStyle(list);
              return {
                within: list !== null && list.hasAttribute('data-key-within'),
                wash: cs === null ? 'none' : cs.backgroundImage,
                outlineWidth: cs === null ? '0px' : cs.outlineWidth,
                cursorRows: document.querySelectorAll(${JSON.stringify(CURSOR_ROW)}).length,
              };
            })()`,
          );
          expect(descended.within).toBe(true);
          expect(descended.wash).toBe("none");
          expect(descended.outlineWidth).toBe("0px");
          // The row the descend came from keeps its cursor bar — exactly one.
          expect(descended.cursorRows).toBe(1);

          // ---- A1. Inside the row the horizontal arrows walk the accessories:
          // the arrow that entered the row is the arrow that walks it, and Left
          // off the first one is the exit.
          await app.nativeKey("ArrowRight");
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector('.jots-card [data-key-view-kbd], .cards-card [data-key-view-kbd], .lens-content [data-key-view-kbd]');
              return el !== null && el.getAttribute('aria-label') === 'Delete jot';
            })()`,
            { timeoutMs: 3_000 },
          );
          await app.nativeKey("ArrowLeft");
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector('.jots-card [data-key-view-kbd], .cards-card [data-key-view-kbd], .lens-content [data-key-view-kbd]');
              return el !== null && el.getAttribute('aria-label') === 'Copy jot';
            })()`,
            { timeoutMs: 3_000 },
          );
          await app.nativeKey("ArrowLeft");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(JOTS_KBD)}) !== null`,
            { timeoutMs: 3_000 },
          );

          // ---- B. Escape also ascends, and Enter still OPENS the jot
          // rather than descending onto the accessory.
          await app.nativeKey("ArrowRight");
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector('.jots-card [data-key-view-kbd], .cards-card [data-key-view-kbd], .lens-content [data-key-view-kbd]');
              return el !== null && el.getAttribute('aria-label') === 'Copy jot';
            })()`,
            { timeoutMs: 3_000 },
          );
          await app.nativeKey("Escape");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(JOTS_KBD)}) !== null`,
            { timeoutMs: 3_000 },
          );
          await app.nativeKey("Enter");
          await app.waitForCondition<boolean>(
            `document.querySelector('.jot-editor .cm-content') !== null`,
            { timeoutMs: 4_000 },
          );
          await app.nativeKey("Escape");
          await app.waitForCondition<boolean>(
            `document.querySelector('.jot-editor .cm-content') === null`,
            { timeoutMs: 4_000 },
          );

          // ---- C. The Layouts CARDS axis walks as the row it is drawn as.
          // The segments live in the LENS, a different card: Tab walks within
          // a card, so crossing takes a focus gesture, not more Tabs.
          await app.dispatchControlAction("focus-lens");
          await tabUntilKbd(app, KIND_GROUP);
          const cursorValue = `(function(){
            var el = document.querySelector('${KIND_GROUP} [data-key-cursor]');
            return el === null ? null : el.getAttribute('data-choice-value');
          })()`;
          await app.waitForCondition<boolean>(
            `(${cursorValue}) === 'one-up'`,
            { timeoutMs: 3_000 },
          );
          // The segments are one run, and both arrow axes walk it ([P01] —
          // the contract at0118 pins on the choice group itself): Right and
          // Down step the cursor without committing, and a vertical arrow
          // leaves the group only off the run's end.
          await app.nativeKey("ArrowRight");
          await app.waitForCondition<boolean>(
            `(${cursorValue}) === 'two-up'`,
            { timeoutMs: 3_000 },
          );
          await app.nativeKey("ArrowLeft");
          await app.waitForCondition<boolean>(
            `(${cursorValue}) === 'one-up'`,
            { timeoutMs: 3_000 },
          );
          for (let i = 0; i < 5; i += 1) await app.nativeKey("ArrowDown");
          await app.waitForCondition<boolean>(
            `(${cursorValue}) === 'six-up'`,
            { timeoutMs: 3_000 },
          );
          // Off the end of the run, Down means down: the group below takes
          // the ring (the cross-section walk is at0341's to gate further).
          await app.nativeKey("ArrowDown");
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-testid="lens-layouts-layout"][data-key-view-kbd]') !== null`,
            { timeoutMs: 3_000 },
          );
          // Back to the CARDS row by the backward Tab walk — the stops are
          // one Tab apart. Tab-into parks the cursor on the selected segment,
          // which is where section D's walk starts.
          await app.nativeKey("Tab", ["shift"]);
          await app.waitForCondition<boolean>(
            `document.querySelector('${KIND_GROUP}[data-key-view-kbd]') !== null`,
            { timeoutMs: 3_000 },
          );

          // ---- D. Commit "Two Up". The deck always stands under an
          // arrangement, so the picker is already there; committing a second
          // slot is what gives the row two positions to walk between.
          await app.nativeKey("ArrowRight");
          await app.waitForCondition<boolean>(
            `(${cursorValue}) === 'two-up'`,
            { timeoutMs: 3_000 },
          );
          await app.nativeKey(" ");
          // The picker the commit lights up lives in the Cards card, so bring
          // that rail up before looking for it.
          await app.dispatchControlAction("toggle-cards");
          await app.waitForCondition<boolean>(
            `document.querySelector('.cards-card [data-testid="cards-slot-picker"]') !== null`,
            { timeoutMs: 4_000 },
          );

          // ---- E. Descend into a Cards file row. Its accessories run leading
          // to trailing — the close box first, then the slots — so the first
          // Right lands on the close box and the second reaches slot 1.
          await tabUntilKbd(app, ".cards-card .cards-list");
          await app.nativeKey("ArrowRight");
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector('.jots-card [data-key-view-kbd], .cards-card [data-key-view-kbd], .lens-content [data-key-view-kbd]');
              return el !== null && (el.getAttribute('aria-label') || '').indexOf('Close ') === 0;
            })()`,
            { timeoutMs: 3_000 },
          );
          // The row draws a WINDOW of the arrangement, so the slots the walk
          // reaches are the ones drawn — and a position the run does not reach
          // is an inert stub the walk passes over, because it is not a control.
          // Asserted as "the key view is a slot naming place 1" rather than by
          // an exact label: what a chip says depends on whether the row's card
          // stands anywhere yet, and the claim here is about the WALK.
          const slotAt = (n: number): string =>
            `(function(){
               var el = document.querySelector('.jots-card [data-key-view-kbd], .cards-card [data-key-view-kbd], .lens-content [data-key-view-kbd]');
               return el !== null
                 && el.getAttribute('data-slot') === 'tug-slot'
                 && el.textContent.trim() === '${n}';
             })()`;
          await app.nativeKey("ArrowRight");
          await app.waitForCondition<boolean>(slotAt(1), { timeoutMs: 3_000 });
          // Inside the row's scope the slots are a run walked left→right in the
          // order the arrangement draws them. Right walks it, and so does Tab —
          // the row scope bounds both planes, so either reaches every slot.
          await app.nativeKey("ArrowRight");
          await app.waitForCondition<boolean>(slotAt(2), { timeoutMs: 3_000 });
          await app.nativeKey("ArrowLeft");
          await new Promise<void>((r) => setTimeout(r, 200));
          expect(await app.evalJS<boolean>(slotAt(1))).toBe(true);
        } finally {
          await app.close();
        }
      } finally {
        rmSync(filesDir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
