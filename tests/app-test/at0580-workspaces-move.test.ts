/**
 * at0580-workspaces-move.test.ts — a card moves between workspaces and stays
 * the same card.
 *
 * Moving a Session card to another workspace has exactly one thing it must not
 * do: change the card's id ([B07]). Everything the card is made of hangs off
 * that id — its binding in `cardSessionBindingStore`, its services bag, its
 * shell ledger, its `/btw` history, its cardstate rows — so a "move" that
 * closed the card here and opened a fresh one there would be a close and an
 * open wearing the word move, and the user would watch a running session
 * vanish.
 *
 * The structural risk is the same one at0578 names for the switch:
 * `cardServicesStore` turns "card left the deck" into a wire `close_session`,
 * and it learns that from `observeCardWillBeginDestruction`. `moveCardToSpace`
 * fires no destruction at all, and the negative below is what says so.
 *
 * What this drives:
 *
 *   1. A real fixture session is resumed into card `A` in the active
 *      workspace, and its transcript is scrolled to a mid anchor.
 *   2. `moveCardToSpace("A", other)` through the `lab` surface. `A` leaves the
 *      active deck and shows up in the OTHER space's parked deck, with the
 *      same card id.
 *   3. **No `services_store.deck_removed_card`** over the move, and
 *      `cardLineFacts("A")` still answers with the same `tugSessionId` — which
 *      it can only do while the binding stands.
 *   4. Activate that workspace. `A` mounts there, bound to the same session,
 *      with its reading position replayed from the bag the move captured.
 *   5. The gesture: `A`'s row in the Workspaces card is dragged onto the
 *      other workspace's header. The header wears `data-drop-target` while
 *      the pointer is over it, and the release moves the card back — same id,
 *      same binding, no order committed ([P10]).
 *   6. One more move, this time OUT of a mounted-but-hidden workspace. Since
 *      [B06] a visited workspace's panes stay in the document, so a move out
 *      of one rebuilds the card's pane just as a move out of the shown
 *      workspace does — and the capture that feeds the replay is owed on
 *      every such move rather than only when the source is on screen.
 *   7. The mirror of step 5, and the direction that used to be impossible:
 *      the same drag by hand, but OUT of a workspace that is PARKED. A parked
 *      workspace's rows arm the carry like any other ([B01]), so the press
 *      defers to the click and a travel becomes a drag instead of switching
 *      workspaces on mousedown.
 *
 * Step 4 is what makes the move a move rather than a relocation of a record: a
 * card that arrived having forgotten where the reader was would have cost them
 * their place for the sake of a tidier list.
 *
 * The second workspace comes from a seeded `version: 5` blob, so the test rests
 * on nothing later than the move itself, and the launch carries
 * `restoreInTestMode` because that blob IS the fixture — under plain test mode
 * the constructor drops the boot layout by design.
 *
 * `@covers` names `spaces.ts`, where the move's rule lives, and the two Cards
 * card surfaces the drag leg reaches. `deck-manager.ts` — which holds
 * `moveCardToSpace` itself — is deliberately not among them, on at0506's
 * precedent: it is already the second widest fan-out in the corpus and the
 * ratchet lets recorded debt be paid down rather than refinanced.
 *
 * @covers tugdeck/src/spaces.ts
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/tugways/block-reorder.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { seedFixtureSession } from "./fixtures/resolve";
import {
  openFixtureSession,
  SCROLLER,
  waitForTranscriptSettled,
} from "./fixtures/runner";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const HOME_SPACE = "space-home";
const AWAY_SPACE = "space-away";

/** Pixel tolerance for "landed on the same spot", as at0190 and at0578 use. */
const RESTORE_TOLERANCE_PX = 2;

/**
 * Two workspaces. The home one is empty — the fixture runner seeds the ACTIVE
 * workspace's deck through `seedDeckState` — and the away one holds a Text
 * card, so it renders something of its own and the arrival lands beside a
 * sitter rather than into a void.
 */
const TWO_SPACE_BLOB = {
  version: 5,
  activeSpaceId: HOME_SPACE,
  spaces: [
    {
      id: HOME_SPACE,
      name: "Home",
      deck: { cards: [], panes: [], imposition: { sidebars: {} } },
    },
    {
      id: AWAY_SPACE,
      name: "Away",
      deck: {
        cards: [{ id: "B", componentId: "text", title: "File", closable: true }],
        panes: [
          {
            id: "p-b",
            position: { x: 60, y: 60 },
            size: { width: 700, height: 500 },
            cardIds: ["B"],
            activeCardId: "B",
            title: "",
            acceptsFamilies: ["standard"],
          },
        ],
        activePaneId: "p-b",
        imposition: { kind: "one-up", sidebars: {} },
      },
    },
  ],
};

interface SpacesProbe {
  activeSpaceId: string;
  spaces: {
    id: string;
    name: string;
    active: boolean;
    deck: { cards: { id: string }[] } | null;
  }[];
}

interface TraceEvent {
  kind: string;
  event?: string;
}

describe.skipIf(!SHOULD_RUN)("at0580 — a card moves between workspaces", () => {
  test(
    "the moved session keeps its id, its binding and the reader's place",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const seeded = await seedFixtureSession(
        "session-transcript-basic",
        "at0580",
      );
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.dev",
        "recent-projects",
        "json",
        JSON.stringify({ paths: [seeded.projectDir] }),
      );
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.deck.layout",
        "layout",
        "json",
        JSON.stringify(TWO_SPACE_BLOB),
      );

      const app = await launchTugApp({
        testName: "at0580-workspaces-move",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await app.waitForCondition<boolean>(
          `typeof window.tugdeck !== "undefined" && window.tugdeck.diag.getSpaces().spaces.length === 2`,
          { timeoutMs: 10_000 },
        );

        // ---- 1. A real session in the home workspace, scrolled to a mid anchor.
        await openFixtureSession(app, seeded);
        await waitForTranscriptSettled(app);

        const savedTop = await app.evalJS<number>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(SCROLLER)});
            el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true, cancelable: true }));
            el.scrollTop = Math.max(0, Math.floor((el.scrollHeight - el.clientHeight) * 0.4));
            el.dispatchEvent(new Event('scroll', { bubbles: true }));
            return el.scrollTop;
          })()`,
        );
        expect(savedTop).toBeGreaterThan(RESTORE_TOLERANCE_PX);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SCROLLER)}).getAttribute("data-tug-scroll-state") !== null`,
          { timeoutMs: 4_000 },
        );

        const boundSessionId = await app.evalJS<string>(
          `window.__tug.cardLineFacts("A").tugSessionId`,
        );
        expect(boundSessionId.length).toBeGreaterThan(0);

        // ---- 2. Move the card to the other workspace, which is parked.
        const mark = await app.evalJS<number>(
          `(window.__deckTrace.enable(true), window.__deckTrace.mark())`,
        );
        expect(
          await app.evalJS<boolean>(
            `window.tugdeck.lab.moveCardToSpace("A", ${JSON.stringify(AWAY_SPACE)})`,
          ),
        ).toBe(true);
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.listCardIds().indexOf("A") === -1`,
          { timeoutMs: 8_000 },
        );

        const parked = await app.evalJS<SpacesProbe>(
          `window.tugdeck.diag.getSpaces()`,
        );
        // The active workspace is unchanged: a move is not a switch.
        expect(parked.activeSpaceId).toBe(HOME_SPACE);
        const away = parked.spaces.find((s) => s.id === AWAY_SPACE);
        expect(away?.active).toBe(false);
        // Same id on the far side — the whole claim of the move.
        expect((away?.deck?.cards ?? []).map((c) => c.id)).toContain("A");

        // ---- 3. The negative: no close path ran, and the binding stands.
        const events = await app.evalJS<TraceEvent[]>(
          `window.__deckTrace.since(${mark}).map(function (e) {
            return { kind: e.kind, event: e.event };
          })`,
        );
        expect(
          events.filter(
            (e) =>
              e.kind === "session-lifecycle" &&
              e.event === "services_store.deck_removed_card",
          ),
        ).toEqual([]);
        expect(
          await app.evalJS<string>(
            `window.__tug.cardLineFacts("A").tugSessionId`,
          ),
        ).toBe(boundSessionId);

        // ---- 4. Follow it: the card mounts there, bound, at the same pixel.
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(AWAY_SPACE)} }), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.listCardIds().indexOf("A") !== -1`,
          { timeoutMs: 8_000 },
        );
        // It arrived beside the sitter rather than instead of it.
        expect(
          await app.evalJS<string[]>(`window.tugdeck.diag.listCardIds()`),
        ).toContain("B");

        await waitForTranscriptSettled(app);
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(SCROLLER)});
            if (el === null) return false;
            return Math.abs(el.scrollTop - ${savedTop}) <= ${RESTORE_TOLERANCE_PX};
          })()`,
          { timeoutMs: 10_000 },
        );
        expect(
          await app.evalJS<string>(
            `window.__tug.cardLineFacts("A").tugSessionId`,
          ),
        ).toBe(boundSessionId);

        // ---- 5. The gesture: drag the card's row onto the other workspace's
        // header and it moves there — the same move by the user's own hand
        // rather than through the verb ([P10], [B07]).
        await app.dispatchControlAction("toggle-cards");
        const ROW = `.cards-list .cards-row[data-cards-row-id=${JSON.stringify(boundSessionId)}]`;
        const HOME_HEADER = `.cards-space-header[data-cards-space-id=${JSON.stringify(HOME_SPACE)}]`;
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null && document.querySelector(${JSON.stringify(HOME_HEADER)}) !== null`,
          { timeoutMs: 15_000 },
        );

        // The whole gesture in one pass, because the mark it has to prove
        // exists only while the pointer is down: a press, the move that
        // engages the carry, the move onto the header, the reading, the
        // release. A poll from outside could only ever arrive after it.
        const carry = await app.evalJS<{
          engaged: boolean;
          lit: boolean;
        }>(
          `(function(){
            var row = document.querySelector(${JSON.stringify(ROW)});
            var header = document.querySelector(${JSON.stringify(HOME_HEADER)});
            if (row === null || header === null) throw new Error("no row or header");
            var r = row.getBoundingClientRect();
            var h = header.getBoundingClientRect();
            var opts = function (cx, cy) {
              return { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, button: 0 };
            };
            var x = r.left + r.width / 2;
            var y = r.top + r.height / 2;
            row.dispatchEvent(new PointerEvent("pointerdown", opts(x, y)));
            window.dispatchEvent(new PointerEvent("pointermove", opts(x, y + 10)));
            var engaged = row.getAttribute("data-dragging") === "true";
            var hx = h.left + h.width / 2;
            var hy = h.top + h.height / 2;
            window.dispatchEvent(new PointerEvent("pointermove", opts(hx, hy)));
            var lit = header.getAttribute("data-drop-target") === "true";
            window.dispatchEvent(new PointerEvent("pointerup", opts(hx, hy)));
            return { engaged: engaged, lit: lit };
          })()`,
        );
        // The carry engaged at all — otherwise the mark below would only be
        // reporting that nothing was being dragged.
        expect(carry.engaged).toBe(true);
        // The target said so while the pointer was over it: a drop is an offer
        // the surface makes, not one the user finds out about afterwards.
        expect(carry.lit).toBe(true);

        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.listCardIds().indexOf("A") === -1`,
          { timeoutMs: 8_000 },
        );
        const dropped = await app.evalJS<SpacesProbe>(
          `window.tugdeck.diag.getSpaces()`,
        );
        // Back where it started, parked, and still the same card: the drag is
        // the verb, not a close and an open.
        expect(dropped.activeSpaceId).toBe(AWAY_SPACE);
        const home = dropped.spaces.find((s) => s.id === HOME_SPACE);
        expect((home?.deck?.cards ?? []).map((c) => c.id)).toContain("A");
        expect(
          await app.evalJS<string>(
            `window.__tug.cardLineFacts("A").tugSessionId`,
          ),
        ).toBe(boundSessionId);
        // And the mark did not outlive the gesture.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('[data-drop-target="true"]').length`,
          ),
        ).toBe(0);

        // ---- 6. The move OUT of a mounted-but-hidden workspace captures too.
        // `A` sits in Home now, and Home is mounted — it was the boot
        // workspace and a visited workspace stays mounted ([B06]) — so its
        // panes are live React trees the canvas is merely hiding. Moving the
        // card out of one rebuilds its pane exactly as moving it out of the
        // shown workspace does, which is why the capture is unconditional
        // rather than gated on which side was on screen ([L23]).
        const hiddenMark = await app.evalJS<number>(
          `window.__deckTrace.mark()`,
        );
        expect(
          await app.evalJS<boolean>(
            `window.tugdeck.lab.moveCardToSpace("A", ${JSON.stringify(AWAY_SPACE)})`,
          ),
        ).toBe(true);
        const captures = await app.evalJS<{ cardId?: string; source?: string }[]>(
          `window.__deckTrace.since(${hiddenMark}).filter(function (e) {
            return e.kind === "save-callback";
          }).map(function (e) {
            return { cardId: e.cardId, source: e.source };
          })`,
        );
        expect(captures).toContainEqual({ cardId: "A", source: "space-switch" });

        // ---- 7. The same gesture out of a PARKED workspace. Before [B01] a
        // press here armed nothing, so `TugListView` committed the selection
        // on the pointerdown, the card's own row switched the workspace out
        // from under the pointer, and no drag could ever start.
        expect(
          await app.evalJS<boolean>(
            `window.tugdeck.lab.moveCardToSpace("A", ${JSON.stringify(HOME_SPACE)})`,
          ),
        ).toBe(true);
        const PARKED_ROW = `.cards-list .cards-row[data-cards-space-run=${JSON.stringify(HOME_SPACE)}][data-cards-row-id=${JSON.stringify(boundSessionId)}]`;
        const AWAY_HEADER = `.cards-space-header[data-cards-space-id=${JSON.stringify(AWAY_SPACE)}]`;
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PARKED_ROW)}) !== null && document.querySelector(${JSON.stringify(AWAY_HEADER)}) !== null`,
          { timeoutMs: 15_000 },
        );

        // One pass again, for leg 5's reason — and it reads the active
        // workspace mid-gesture, which is where the old behaviour showed
        // itself: the switch landed on the press, before any travel.
        const outward = await app.evalJS<{
          activeBefore: string;
          activeAfterPress: string;
          engaged: boolean;
          lit: boolean;
        }>(
          `(function(){
            var row = document.querySelector(${JSON.stringify(PARKED_ROW)});
            var header = document.querySelector(${JSON.stringify(AWAY_HEADER)});
            if (row === null || header === null) throw new Error("no parked row or header");
            var activeBefore = window.tugdeck.diag.getSpaces().activeSpaceId;
            var r = row.getBoundingClientRect();
            var h = header.getBoundingClientRect();
            var opts = function (cx, cy) {
              return { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, button: 0 };
            };
            var x = r.left + r.width / 2;
            var y = r.top + r.height / 2;
            row.dispatchEvent(new PointerEvent("pointerdown", opts(x, y)));
            var activeAfterPress = window.tugdeck.diag.getSpaces().activeSpaceId;
            window.dispatchEvent(new PointerEvent("pointermove", opts(x, y + 10)));
            var engaged = row.getAttribute("data-dragging") === "true";
            var hx = h.left + h.width / 2;
            var hy = h.top + h.height / 2;
            window.dispatchEvent(new PointerEvent("pointermove", opts(hx, hy)));
            var lit = header.getAttribute("data-drop-target") === "true";
            window.dispatchEvent(new PointerEvent("pointerup", opts(hx, hy)));
            return { activeBefore: activeBefore, activeAfterPress: activeAfterPress, engaged: engaged, lit: lit };
          })()`,
        );
        // The press alone went nowhere: the workspace under the pointer is
        // still the one the user was in.
        note(`the parked drag: ${JSON.stringify(outward)}`);
        expect(outward.activeBefore).toBe(AWAY_SPACE);
        expect(outward.activeAfterPress).toBe(AWAY_SPACE);
        expect(outward.engaged).toBe(true);
        expect(outward.lit).toBe(true);

        // And the release moved the card, out of the parked workspace and
        // into the one on screen — the same card, with its binding intact.
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.listCardIds().indexOf("A") !== -1`,
          { timeoutMs: 8_000 },
        );
        const returned = await app.evalJS<SpacesProbe>(
          `window.tugdeck.diag.getSpaces()`,
        );
        expect(returned.activeSpaceId).toBe(AWAY_SPACE);
        const landedAway = returned.spaces.find((s) => s.id === AWAY_SPACE);
        expect((landedAway?.deck?.cards ?? []).map((c) => c.id)).toContain("A");
        const stillHome = returned.spaces.find((s) => s.id === HOME_SPACE);
        expect((stillHome?.deck?.cards ?? []).map((c) => c.id)).not.toContain(
          "A",
        );
        expect(
          await app.evalJS<string>(
            `window.__tug.cardLineFacts("A").tugSessionId`,
          ),
        ).toBe(boundSessionId);
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
