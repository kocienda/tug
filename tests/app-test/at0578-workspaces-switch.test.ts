/**
 * at0578-workspaces-switch.test.ts — switching workspaces is not closing them.
 *
 * The one thing a person must be able to trust about workspaces is that
 * leaving one does not end what is running in it ([B05]). The risk is
 * structural rather than hypothetical: `cardServicesStore` turns "card left
 * the deck" into a wire `close_session`, and it learns that from
 * `observeCardWillBeginDestruction`. A switch that reused any close path —
 * `_closePane`, `_removeCard`, a destruction fan-out — would kill every
 * session in the workspace being left, and every surface would look correct
 * while it happened (Risk R01).
 *
 * So this drives the real thing and asserts the negative:
 *
 *   1. A real session is resumed into card `A` in workspace one, and its
 *      transcript is scrolled to a mid anchor.
 *   2. `activate-space` is dispatched for workspace two. Card `A` leaves the
 *      active deck and shows up parked in `diag.getSpaces()`.
 *   3. **No `services_store.deck_removed_card`** is recorded over the switch —
 *      that log line is emitted immediately before `_closeCardInternal` sends
 *      `close_session`, so its absence is the close-path assertion — and
 *      `cardLineFacts("A")` still answers with the same `tugSessionId`, which
 *      it can only do while the binding stands in `cardSessionBindingStore`.
 *      **No `save-callback` under the `"space-switch"` tag** is recorded
 *      either: a switch used to capture every outgoing card's bag against the
 *      rebuild on return, and there is no rebuild any more ([B06]).
 *   4. `activate-space` back. The transcript lands on the same pixel, because
 *      the card was never taken down — at0587 is where that mechanism is
 *      asserted at its source.
 *
 * Step 4 is the other half of the claim: a switch that kept the session alive
 * but lost the reading position would still have cost the user their place.
 *
 * Steps 5 and 6 are the record verbs' half, and they assert the OPPOSITE sign
 * of steps 1-4. Creating a workspace puts the user in it and stands its
 * factory rail ([P05]), so a new workspace has its doors rather than an empty
 * canvas with no way back. And deleting a workspace that holds a bound session
 * DOES close it ([P07]) — the same `services_store.deck_removed_card` whose
 * absence step 3 asserts is what step 6 waits for, which is the plainest
 * available statement that a switch and a delete are different acts.
 *
 * The second workspace comes from a seeded `version: 5` blob rather than from
 * a verb, so the test rests on nothing later than the switch itself. That is
 * also why the launch carries `restoreInTestMode` — under plain test mode the
 * constructor drops the boot layout by design, and the two-space blob IS the
 * fixture. `seedDeckState` then fills the ACTIVE workspace's deck and leaves
 * the parked one alone, which is how the fixture-session runner can be used
 * unchanged.
 *
 * The second test is the card's surface, and the same fixture shape one level
 * out: three workspaces, each standing its own Workspaces card, so a switch
 * never takes the surface under test off screen ([B02]). It drives the row
 * model and the four verbs through the real pointer and the real keyboard —
 * the mark, the click and the Return that switch, the fold cue that opens a
 * parked workspace read-only, the right-click menu, the inline rename, and the
 * delete confirm over live sessions with both of its answers.
 *
 * `deck-manager.ts` is deliberately not in the `@covers` list, on at0506's
 * precedent and for at0579's reason: it is already among the widest fan-outs in
 * the corpus, and the ratchet lets recorded debt be paid down rather than
 * refinanced.
 *
 * @covers tugdeck/src/spaces.ts
 * @covers tugdeck/src/lib/card-services-store.ts
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/cards/cards-space-header.tsx
 * @covers tugdeck/src/components/cards/cards-data-source.ts
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

const SPACE_ONE = "space-one";
const SPACE_TWO = "space-two";

/** Pixel tolerance for "landed on the same spot", as at0190 uses. */
const RESTORE_TOLERANCE_PX = 2;

/**
 * Two workspaces on disk. The first is empty — the fixture runner seeds its
 * deck through `seedDeckState`, which replaces the ACTIVE workspace's deck and
 * touches no parked one. The second holds one Text card, so the switch has
 * something to render and the assertion "card A is not in the active deck" is
 * about a real other deck rather than about an empty canvas.
 */
const TWO_SPACE_BLOB = {
  version: 5,
  activeSpaceId: SPACE_ONE,
  spaces: [
    {
      id: SPACE_ONE,
      name: "Main",
      deck: { cards: [], panes: [], imposition: { sidebars: {} } },
    },
    {
      id: SPACE_TWO,
      name: "Second",
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
  source?: string;
}

describe.skipIf(!SHOULD_RUN)("at0578 — a workspace switch keeps its sessions", () => {
  test(
    "switch away and back: the session lives, and the transcript lands on the same pixel",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const seeded = await seedFixtureSession(
        "session-transcript-basic",
        "at0578",
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
        testName: "at0578-workspaces-switch",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        // Both workspaces arrived from the blob before anything was seeded.
        await app.waitForCondition<boolean>(
          `typeof window.tugdeck !== "undefined" && window.tugdeck.diag.getSpaces().spaces.length === 2`,
          { timeoutMs: 10_000 },
        );

        // ---- 1. A real session in workspace one, scrolled to a mid anchor.
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

        // ---- 2. Switch to workspace two.
        const mark = await app.evalJS<number>(
          `(window.__deckTrace.enable(true), window.__deckTrace.mark())`,
        );
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_TWO)} }), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.listCardIds().indexOf("B") !== -1`,
          { timeoutMs: 8_000 },
        );
        expect(
          await app.evalJS<string[]>(`window.tugdeck.diag.listCardIds()`),
        ).not.toContain("A");

        const parked = await app.evalJS<SpacesProbe>(
          `window.tugdeck.diag.getSpaces()`,
        );
        expect(parked.activeSpaceId).toBe(SPACE_TWO);
        const one = parked.spaces.find((s) => s.id === SPACE_ONE);
        expect(one?.active).toBe(false);
        expect((one?.deck?.cards ?? []).map((c) => c.id)).toContain("A");

        // ---- 3. The negative: no close path ran, and the binding stands.
        const events = await app.evalJS<TraceEvent[]>(
          `window.__deckTrace.since(${mark}).map(function (e) {
            return { kind: e.kind, event: e.event, source: e.source };
          })`,
        );
        const removals = events.filter(
          (e) =>
            e.kind === "session-lifecycle" &&
            e.event === "services_store.deck_removed_card",
        );
        expect(removals).toEqual([]);

        // And no CAPTURE either, which is the newer half of the same claim.
        // A switch used to fire every outgoing card's save callback under the
        // `"space-switch"` tag, because every one of those cards was about to
        // unmount. They no longer do ([B06]): the workspace stays mounted and
        // the canvas hides it, so there is nothing to capture and nothing to
        // replay. One `save-callback` under that tag here would mean the
        // teardown had quietly come back.
        const captures = events.filter(
          (e) => e.kind === "save-callback" && e.source === "space-switch",
        );
        expect(captures).toEqual([]);

        // `cardLineFacts` throws when the card holds no binding, so answering
        // at all is the assertion; answering with the SAME id says the session
        // was not swapped out underneath the card either.
        expect(
          await app.evalJS<string>(
            `window.__tug.cardLineFacts("A").tugSessionId`,
          ),
        ).toBe(boundSessionId);

        // ---- 4. Switch back: the reading position comes with it.
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_ONE)} }), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.listCardIds().indexOf("A") !== -1`,
          { timeoutMs: 8_000 },
        );
        await waitForTranscriptSettled(app);
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(SCROLLER)});
            if (el === null) return false;
            return Math.abs(el.scrollTop - ${savedTop}) <= ${RESTORE_TOLERANCE_PX};
          })()`,
          { timeoutMs: 10_000 },
        );

        expect(await app.getActiveCardId()).toBe("A");
        expect(
          await app.evalJS<string>(
            `window.__tug.cardLineFacts("A").tugSessionId`,
          ),
        ).toBe(boundSessionId);

        // ---- 5. New workspace: created, activated, standing on its rail.
        const created = await app.evalJS<string>(
          `window.tugdeck.lab.createSpace()`,
        );
        expect(created.length).toBeGreaterThan(0);
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(created)}`,
          { timeoutMs: 8_000 },
        );

        const railed = await app.evalJS<SpacesProbe>(
          `window.tugdeck.diag.getSpaces()`,
        );
        expect(railed.spaces).toHaveLength(3);
        expect(railed.spaces.find((s) => s.id === created)?.name).toBe(
          "Workspace 1",
        );
        // The rail is the whole point of [P05]: a workspace whose Workspaces
        // card is not standing has no door back except a chord and a menu.
        const standing = await app.evalJS<string[]>(
          `window.tugdeck.diag.getDeckState().cards.map(function (c) { return c.componentId; })`,
        );
        expect([...standing].sort()).toEqual(["cards", "dashes", "layout"]);
        // And card A did not come along: it is parked in workspace one.
        expect(
          await app.evalJS<string[]>(`window.tugdeck.diag.listCardIds()`),
        ).not.toContain("A");

        // ---- 6. Delete the workspace holding the bound session: it closes.
        const deleteMark = await app.evalJS<number>(`window.__deckTrace.mark()`);
        // The count the confirm would have shown, from the one definition the
        // close loop reads too ([P07]).
        expect(
          await app.evalJS<number>(
            `window.tugdeck.lab.spaceHoldsLiveSessions(${JSON.stringify(SPACE_ONE)})`,
          ),
        ).toBe(1);
        expect(
          await app.evalJS<boolean>(
            `window.tugdeck.lab.deleteSpace(${JSON.stringify(SPACE_ONE)})`,
          ),
        ).toBe(true);

        await app.waitForCondition<boolean>(
          `window.__deckTrace.since(${deleteMark}).some(function (e) {
            return e.kind === "session-lifecycle" &&
              e.event === "services_store.deck_removed_card" &&
              e.fields.card_id === "A";
          })`,
          { timeoutMs: 8_000 },
        );
        // The binding goes with the close, which `cardLineFacts` reports by
        // throwing rather than by answering.
        await app.waitForCondition<boolean>(
          `(function () {
            try { window.__tug.cardLineFacts("A"); return false; }
            catch (e) { return true; }
          })()`,
          { timeoutMs: 8_000 },
        );

        const afterDelete = await app.evalJS<SpacesProbe>(
          `window.tugdeck.diag.getSpaces()`,
        );
        expect([...afterDelete.spaces.map((s) => s.id)].sort()).toEqual(
          [SPACE_TWO, created].sort(),
        );
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * Three workspaces, each standing its own Workspaces card ([B02] — sidebars
 * are per workspace), so switching between them never takes the surface under
 * test off screen. The third holds a Session card that is never mounted: it is
 * there so a synthetic ledger row can make one workspace "hold live sessions"
 * without a second real session being spawned.
 */
function threeSpaceBlob() {
  const railPane = (id: string, cardId: string) => ({
    id,
    position: { x: 0, y: 0 },
    size: { width: 420, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: [] as string[],
  });
  const contentPane = (id: string, cardId: string) => ({
    id,
    position: { x: 60, y: 60 },
    size: { width: 700, height: 500 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["standard"],
  });
  const deck = (
    railCard: string,
    railId: string,
    card: { id: string; componentId: string },
    paneId: string,
  ) => ({
    cards: [
      { id: railCard, componentId: "cards", title: "Workspaces", closable: true },
      { id: card.id, componentId: card.componentId, title: card.id, closable: true },
    ],
    panes: [railPane(railId, railCard), contentPane(paneId, card.id)],
    activePaneId: paneId,
    imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
  });
  return {
    version: 5,
    activeSpaceId: SURFACE_ONE,
    spaces: [
      {
        id: SURFACE_ONE,
        name: "Main",
        deck: deck("C1", "pc1", { id: "T1", componentId: "text" }, "pt1"),
      },
      {
        id: SURFACE_TWO,
        name: "Second",
        deck: deck("C2", "pc2", { id: "T2", componentId: "text" }, "pt2"),
      },
      {
        id: SURFACE_THREE,
        name: "Third",
        deck: deck("C3", "pc3", { id: "S", componentId: "session" }, "ps"),
      },
    ],
  };
}

const SURFACE_ONE = "surface-one";
const SURFACE_TWO = "surface-two";
const SURFACE_THREE = "surface-three";

/**
 * "On screen", said out loud.
 *
 * Every workspace the leg has visited stays MOUNTED ([B06]), so the document
 * now holds one Workspaces card per visited workspace — all of them but one
 * inside a wrapper with no `data-space-shown` and no boxes. A bare
 * `document.querySelectorAll` over rows would count the hidden ones too, and
 * a count is the assertion in half of this leg. So the row selectors below
 * carry the scope and the portaled ones (menus, confirms, the rename field)
 * deliberately do not: an overlay is mounted at the canvas's overlay root,
 * outside every layer.
 */
const SHOWN = "[data-space-layer][data-space-shown] ";

const HEADER = `${SHOWN}[data-testid="cards-space-header"]`;
const headerFor = (id: string): string =>
  `${SHOWN}.cards-space-header[data-cards-space-id="${id}"]`;
const foldFor = (id: string): string =>
  `${headerFor(id)} [data-slot="cards-space-fold"]`;
const MENU_ITEM = "[data-item-action]";
const RENAME_INPUT = '[data-testid="cards-space-rename"]';
const CONFIRM = '[data-slot="tug-confirm-popover"]';
const CONFIRM_MESSAGE = '[data-slot="tug-confirm-message"]';
const CONFIRM_OK = '[data-slot="tug-confirm-confirm"]';
const CONFIRM_CANCEL = '[data-slot="tug-confirm-cancel"]';
const CURSOR_ROW = `${SHOWN}.cards-list .tug-list-view-cell[data-key-cursor]`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)(
  "at0578 — the workspaces are the card's outer level, and its verbs act on a row",
  () => {
    test(
      "headers mark, switch, fold, and carry the four verbs",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(threeSpaceBlob()),
        );

        const app = await launchTugApp({
          testName: "at0578-workspaces-surface",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          // ---- 1. Every workspace is a row, and one of them wears the mark.
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(HEADER)}).length === 3`,
            { timeoutMs: 20_000 },
          );
          const readHeaders = (): Promise<
            { id: string; name: string; active: string }[]
          > =>
            app.evalJS(
              `Array.prototype.map.call(
                document.querySelectorAll(${JSON.stringify(HEADER)}),
                function (el) {
                  return {
                    id: el.getAttribute("data-cards-space-id"),
                    name: el.querySelector('[data-testid="cards-space-name"]').textContent,
                    active: el.getAttribute("data-cards-space-active"),
                  };
                },
              )`,
            );
          const first = await readHeaders();
          note("at0578 headers at rest", JSON.stringify(first));
          expect(first.map((h) => h.name)).toEqual(["Main", "Second", "Third"]);
          expect(first.map((h) => h.active)).toEqual(["true", "false", "false"]);

          // ---- 2. A click on a header goes there, and the mark goes with it.
          await app.nativeClickAtElement(headerFor(SURFACE_TWO));
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SURFACE_TWO)}`,
            { timeoutMs: 8_000 },
          );
          await app.waitForCondition<boolean>(
            `(function () {
               var el = document.querySelector(${JSON.stringify(headerFor(SURFACE_TWO))});
               return el !== null && el.getAttribute("data-cards-space-active") === "true";
             })()`,
            { timeoutMs: 8_000 },
          );
          expect(
            await app.evalJS<string[]>(`window.tugdeck.diag.listCardIds()`),
          ).toContain("T2");

          // ---- 3. Enter on a header through the list cursor does the same.
          //
          // The keyboard goes in through the card's own toggle rather than
          // through the click above: a press on a header ARMS the workspace
          // carry, which cancels the pointerdown and with it the focus move
          // that press would otherwise have made. Home then lands on row 0,
          // which is Main's header — every workspace emits one, and a
          // collapsed one emits nothing else.
          await app.dispatchControlAction("toggle-cards");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CURSOR_ROW)}) !== null`,
            { timeoutMs: 8_000 },
          );
          await app.nativeKey("Home");
          await wait(150);
          await app.waitForCondition<boolean>(
            `(function () {
               var row = document.querySelector(${JSON.stringify(CURSOR_ROW)});
               return row !== null &&
                 row.querySelector('[data-cards-space-id="${SURFACE_ONE}"]') !== null;
             })()`,
            { timeoutMs: 8_000 },
          );
          await wait(150);
          await app.nativeKey("Return");
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SURFACE_ONE)}`,
            { timeoutMs: 8_000 },
          );

          // ---- 4. The fold cue folds a parked workspace shut, and opens it
          // again. Every workspace now arrives EXPANDED ([B02]), so the rows
          // are on screen before the first click and the cue's first job is to
          // put them away; what the leg asserts is unchanged — the cue drives
          // a parked workspace's rows, and driving them is not going there.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(
                 '${SHOWN}.cards-list [data-cards-space-run="${SURFACE_THREE}"][data-cards-space-inactive="true"]'
               ).length`,
            ),
          ).toBeGreaterThan(0);
          await app.nativeClickAtElement(foldFor(SURFACE_THREE));
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(
               '${SHOWN}.cards-list [data-cards-space-run="${SURFACE_THREE}"][data-cards-space-inactive="true"]'
             ).length === 0`,
            { timeoutMs: 8_000 },
          );
          await app.nativeClickAtElement(foldFor(SURFACE_THREE));
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(
               '${SHOWN}.cards-list [data-cards-space-run="${SURFACE_THREE}"][data-cards-space-inactive="true"]'
             ).length > 0`,
            { timeoutMs: 8_000 },
          );
          // Folding it is a glance, not a move: the deck on screen is unchanged.
          expect(
            await app.evalJS<string>(
              `window.tugdeck.diag.getSpaces().activeSpaceId`,
            ),
          ).toBe(SURFACE_ONE);

          // ---- 5. Right-click carries the four verbs.
          await app.nativeRightClickAtElement(headerFor(SURFACE_THREE));
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(MENU_ITEM)}).length >= 4`,
            { timeoutMs: 8_000 },
          );
          const actions = await app.evalJS<string[]>(
            `Array.prototype.map.call(
               document.querySelectorAll(${JSON.stringify(MENU_ITEM)}),
               function (el) { return el.getAttribute("data-item-action"); },
             )`,
          );
          note("at0578 the workspace verbs", JSON.stringify(actions));
          expect(actions).toEqual([
            "new-space",
            "rename-space",
            "duplicate-space",
            "delete-space",
          ]);

          // ---- 6. Rename is inline on the row, and the record agrees.
          await app.nativeClickAtElement('[data-item-action="rename-space"]');
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RENAME_INPUT)}) !== null`,
            { timeoutMs: 8_000 },
          );
          // The menu closes when its activation blink FINISHES, and a blink is
          // a Web Animation — which does not advance while the harness window
          // is covered and rAF is suspended. A menu still standing owns every
          // printable key for its typeahead, so the field would take nothing.
          // Escape is the menu's own close and it consumes the press, so the
          // field that just opened is untouched by it.
          await app.nativeKey("Escape");
          await app.waitForCondition<boolean>(
            `document.querySelector(".tug-menu-content") === null`,
            { timeoutMs: 8_000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RENAME_INPUT)}) !== null`,
            { timeoutMs: 4_000 },
          );
          await app.nativeType("Away");
          await app.nativeKey("Return");
          await app.waitForCondition<boolean>(
            // Null-safe on purpose: while the field is open the header holds
            // an input where the name span was, so the first poll can land on
            // a row that has no name to read.
            `(function () {
               var el = document.querySelector(${JSON.stringify(headerFor(SURFACE_THREE))});
               if (el === null) return false;
               var name = el.querySelector('[data-testid="cards-space-name"]');
               return name !== null && name.textContent === "Away";
             })()`,
            { timeoutMs: 8_000 },
          );
          const named = await app.evalJS<SpacesProbe>(
            `window.tugdeck.diag.getSpaces()`,
          );
          expect(named.spaces.find((s) => s.id === SURFACE_THREE)?.name).toBe(
            "Away",
          );

          // ---- 7. Delete over live sessions confirms, and Cancel means no.
          //
          // The row is synthetic — the same publish `action-dispatch` performs
          // on the server's frame — because what is under test is the confirm
          // the count raises, not how the count got there ([P07], at0579 drives
          // the close itself).
          await app.evalJS<null>(
            `(window.__tug.publishCardBindings([{
               card_id: "S",
               session_id: "at0578-surface-session",
               project_dir: "/tmp/at0578",
               state: "live",
               turn_count: 2,
               is_alive: true,
               has_jsonl: true
             }]), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.lab.spaceHoldsLiveSessions(${JSON.stringify(SURFACE_THREE)}) === 1`,
            { timeoutMs: 8_000 },
          );

          await app.nativeRightClickAtElement(headerFor(SURFACE_THREE));
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-item-action="delete-space"]') !== null`,
            { timeoutMs: 8_000 },
          );
          await app.nativeClickAtElement('[data-item-action="delete-space"]');
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
            { timeoutMs: 8_000 },
          );
          expect(
            await app.evalJS<string>(
              `document.querySelector(${JSON.stringify(CONFIRM_MESSAGE)}).textContent`,
            ),
            // Two panes stand in that workspace — its Workspaces rail and the
            // Session card — and the sentence counts cards, with the live
            // sessions among them named parenthetically ([P06], Spec S03).
          ).toBe("Delete Away and close 2 cards (1 session)?");
          await app.nativeClickAtElement(CONFIRM_CANCEL);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM)}) === null`,
            { timeoutMs: 8_000 },
          );
          expect(
            await app.evalJS<number>(
              `window.tugdeck.diag.getSpaces().spaces.length`,
            ),
          ).toBe(3);

          // ---- 8. And Delete means yes.
          await app.nativeRightClickAtElement(headerFor(SURFACE_THREE));
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-item-action="delete-space"]') !== null`,
            { timeoutMs: 8_000 },
          );
          await app.nativeClickAtElement('[data-item-action="delete-space"]');
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_OK)}) !== null`,
            { timeoutMs: 8_000 },
          );
          await app.nativeClickAtElement(CONFIRM_OK);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(HEADER)}).length === 2`,
            { timeoutMs: 8_000 },
          );
          const left = await app.evalJS<SpacesProbe>(
            `window.tugdeck.diag.getSpaces()`,
          );
          expect([...left.spaces.map((s) => s.id)].sort()).toEqual(
            [SURFACE_ONE, SURFACE_TWO].sort(),
          );
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
