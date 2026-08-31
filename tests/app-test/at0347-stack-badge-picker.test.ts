/**
 * at0347-stack-badge-picker.test.ts — a slot is a stack, and the title bar
 * says so.
 *
 * The imposer piles any number of panes into one numbered slot and shows you
 * the top one. Until now nothing on the deck admitted that: a fully covered
 * pane is stamped `data-occluded="true"` and hidden outright, so a buried card
 * contributed not one pixel — not an edge, not a shadow — to say it existed,
 * and the Lens rail was the only way to reach it. The badge is the local
 * admission and the picker is the local way through.
 *
 * What is worth proving here, in the order the user meets it:
 *
 *   1. The badge appears exactly where there is a stack. Its condition is
 *      `slotStack.length > 1` and nothing else — no "am I on top?" test — so
 *      BOTH panes in a two-deep slot render one, and a pane alone in its slot,
 *      a free pane, and the Lens render none. `data-stack-depth` on the frame
 *      carries the same number for anything that wants it without a badge.
 *
 *   2. The picker lists the slot, topmost first, with the front pane checked.
 *      It is built from store data, never from revealed DOM: the buried pane's
 *      title reaches the menu as a string, so nothing has to negotiate with
 *      the occlusion controller to render a row for a pane that is hidden.
 *
 *   3. Choosing a row raises that pane — first responder AND z-order, in one
 *      commit, through the same `transferFocusForActivation` a Lens row click
 *      or a ⌘N slot assignment takes.
 *
 *   4. Cmd-click on a title bar opens the same picker and does NOT raise the
 *      pane it landed on. The meta modifier already means "interact with a
 *      background window without raising it", and this inherits that: the
 *      un-raised state is the feedback that the click was a look, not a touch.
 *
 *   5. Cmd-DRAG still drags. This is the one that earns its own tier. Cmd-drag
 *      on a title bar is meaningful twice over — the Mac background-window
 *      move, and the gesture that evicts an imposed pane from its slot — so
 *      the Cmd-click path resolves in the drag machine's existing no-travel
 *      branch rather than on the way down. `dragMoved` latches only inside a
 *      `requestAnimationFrame` callback, and a background app-test window runs
 *      no rAF: a synthetic Cmd-drag there never registers as travel, falls
 *      into the no-travel branch, and OPENS THE PICKER. The assertion would
 *      not merely fail, it would invert. So that case lives in at0349, which
 *      declares itself a screen-taking test and earns its key window;
 *      everything above it is frameless and stays here, in the everyday tier.
 *
 * The occlusion variant is the honest statement of claim 1: with two panes of
 * EQUAL width in one slot the buried one is fully covered, so it carries
 * `data-occluded="true"` and its badge computes `visibility: hidden`. The
 * badge is still in the DOM and `querySelector` still finds it — a test that
 * assumed otherwise would be asserting the wrong thing — so the assertion
 * reads computed visibility rather than presence. That is why the main deck
 * seeds MISMATCHED widths: it keeps the buried pane visible so both badges can
 * be seen at once.
 *
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/lib/pane-title.ts
 * @covers tugdeck/src/lib/card-title-store.ts
 * @covers tugdeck/src/components/tugways/internal/tug-popup-menu.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const LENS_WIDTH = 300;
/** The settle window (`IMPOSITION_SETTLE_MS`), with room for the tween. */
const AFTER_LAND_MS = 900;

const BADGE = '[data-testid="tug-pane-title-bar-stack-badge"]';
const MENU = '[data-testid="tug-pane-title-bar-stack-menu"]';
/**
 * A picker row. Every row carries `selected` so the check column aligns, and
 * `TugPopupMenuItem.selected` renders `role="menuitemradio"` — NOT
 * `role="menuitem"`, which is what an item without the flag would get.
 */
const ROW = `${MENU} [role="menuitemradio"]`;

const frame = (paneId: string): string =>
  `.tug-pane[data-pane-id="${paneId}"]`;
const titleBar = (paneId: string): string =>
  `${frame(paneId)} [data-testid="tug-pane-title-bar"]`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * The two stacked cards are deliberately of DIFFERENT kinds — `gallery-
 * chain-actions` registers a `Zap` icon and `gallery-animator` a `Play` one —
 * so the picker's icon assertion can discriminate. Seeded from one kind, every
 * row would carry the same glyph and "each row shows its own pane's icon"
 * would be indistinguishable from "every row shows the same icon".
 */
function card(id: string, title: string, componentId = "gallery-accordion") {
  return { id, componentId, title, closable: true };
}

/** The `lucide-*` class on an element's first `svg`, or null. */
const lucideClassOf = (selector: string): string =>
  `(function () {
    var svg = document.querySelector(${JSON.stringify(selector)});
    if (svg === null) return null;
    return (svg.getAttribute("class") || "")
      .split(/\\s+/)
      .filter(function (c) { return c.indexOf("lucide-") === 0; })[0] || null;
  })()`;

function pane(
  id: string,
  cardId: string,
  width: number,
  slot?: number,
) {
  return {
    id,
    position: { x: 40, y: 40 },
    size: { width, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    ...(slot === undefined ? {} : { slot }),
  };
}

function lensPane() {
  return {
    id: "pLens",
    position: { x: 0, y: 0 },
    size: { width: LENS_WIDTH, height: 900 },
    cardIds: ["L"],
    activeCardId: "L",
    title: "Lens",
    acceptsFamilies: [],
  };
}

/**
 * A three-up deck holding, in z-order (last topmost):
 *
 *   p0 / Z  — slot 0, BEHIND, 520px wide
 *   p1 / A  — slot 0, FRONT,  420px wide
 *   p2 / B  — slot 2, alone in its slot
 *   pFree/F — no slot at all
 *   pLens   — the Lens, which never carries a slot
 *
 * The two slot-0 panes are given different widths on purpose: the wider buried
 * one is not fully covered, so the occlusion controller leaves it visible and
 * both badges can be asserted in one pass.
 */
function deckShape() {
  return {
    cards: [
      card("Z", "Card Z", "gallery-animator"),
      card("A", "Card A", "gallery-chain-actions"),
      card("B", "Card B"),
      card("F", "Card F"),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      pane("p0", "Z", 520, 0),
      pane("p1", "A", 420, 0),
      pane("p2", "B", 420, 2),
      pane("pFree", "F", 380),
      lensPane(),
    ],
    activePaneId: "p1",
    imposition: { kind: "three-up", lens: "right" },
    hasFocus: true,
  };
}

/** The same slot-0 pair at EQUAL widths, so the buried one is fully covered. */
function occludedDeckShape() {
  return {
    ...deckShape(),
    panes: [
      pane("p0", "Z", 420, 0),
      pane("p1", "A", 420, 0),
      pane("p2", "B", 420, 2),
      pane("pFree", "F", 380),
      lensPane(),
    ],
  };
}

async function count(app: App, selector: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
}

async function badgeText(app: App, paneId: string): Promise<string> {
  return app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(`${frame(paneId)} ${BADGE}`)}) || { textContent: "" }).textContent.trim()`,
  );
}

async function stackDepthAttr(app: App, paneId: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `(document.querySelector(${JSON.stringify(frame(paneId))}) || { getAttribute: () => null }).getAttribute("data-stack-depth")`,
  );
}

async function zIndexOf(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(
    `Number(getComputedStyle(document.querySelector(${JSON.stringify(frame(paneId))})).zIndex)`,
  );
}

/** The text a pane's own title bar is rendering, right now. */
async function titleBarText(app: App, paneId: string): Promise<string> {
  return app.evalJS<string>(
    `document.querySelector(${JSON.stringify(`${frame(paneId)} [data-testid="tug-pane-title"]`)}).textContent.trim()`,
  );
}

/** Row labels in render order — topmost first. */
async function rowLabels(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(ROW)})).map((el) => el.textContent.trim())`,
  );
}

/** The `data-item-id` (a pane id) of the row whose radio reads checked. */
async function checkedRowPaneId(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () {
      var rows = Array.from(document.querySelectorAll(${JSON.stringify(ROW)}));
      var hit = rows.find(function (el) { return el.getAttribute("aria-checked") === "true"; });
      return hit ? hit.getAttribute("data-item-id") : null;
    })()`,
  );
}

/**
 * Poll for the menu, never wait a fixed animation duration: a background
 * app-test window runs no rAF and throttles DOM timers, so anything hung off
 * an animation completing would pass by not running.
 */
async function waitForMenu(app: App, present: boolean): Promise<void> {
  await app.waitForCondition<boolean>(
    `(document.querySelectorAll(${JSON.stringify(MENU)}).length > 0) === ${present ? "true" : "false"}`,
    { timeoutMs: 5_000 },
  );
}

async function seed(app: App, state: unknown, focusCardId: string): Promise<void> {
  await app.seedDeckState({ state, focusCardId });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-pane-id]').length === 5`,
    { timeoutMs: 5_000 },
  );
  await wait(AFTER_LAND_MS);
}

describe.skipIf(!SHOULD_RUN)(
  "at0347 — the stack badge, the stack picker, and the pointer gestures",
  () => {
    test(
      "the badge marks a stack, the picker lists it, and choosing a row raises that pane",
      async () => {
        const app = await launchTugApp({ testName: "at0347-stack-badge-picker" });
        try {
          await seed(app, deckShape(), "A");

          // --- The badge appears exactly where there is a PLACE. -----------
          // Depth is no longer the condition. The badge is the only door to
          // the arrange verbs, so gating it on already having a neighbour left
          // the one card that most needs "Split Vertically" — a card alone in
          // its column — with no way to reach it. A place one card deep is
          // still a place, and the badge says so with a quiet `1`.
          expect(await count(app, `${frame("p1")} ${BADGE}`), "front pane of the 2-deep slot has a badge").toBe(1);
          expect(await count(app, `${frame("p0")} ${BADGE}`), "buried pane of the same slot has one too").toBe(1);
          expect(await badgeText(app, "p1"), "badge carries the slot's pane count").toBe("2");
          expect(await badgeText(app, "p0"), "and says the same thing on the buried pane").toBe("2");

          expect(await count(app, `${frame("p2")} ${BADGE}`), "a pane alone in its slot stands in a place one deep").toBe(1);
          expect(await badgeText(app, "p2"), "and says so — one of one").toBe("1");
          expect(await count(app, `${frame("pLens")} ${BADGE}`), "a lone rail is a place too, and splittable").toBe(1);
          expect(await badgeText(app, "pLens"), "reading the same one").toBe("1");
          // The one case that still draws nothing: a pane standing in no place
          // at all. A chip there would claim a position the pane does not hold
          // — the same rule the slot chip beside it follows.
          expect(await count(app, `${frame("pFree")} ${BADGE}`), "a free pane holds no slot, so no badge").toBe(0);

          // --- data-stack-depth says the same thing on the frame. ----------
          expect(await stackDepthAttr(app, "p1")).toBe("2");
          expect(await stackDepthAttr(app, "p0")).toBe("2");
          expect(await stackDepthAttr(app, "p2")).toBe("1");
          expect(await stackDepthAttr(app, "pFree")).toBe("0");
          // A rail is a PLACE two cards can share, the same as a slot, so the
          // Lens standing alone on one reads 1 — exactly as `p2` alone in its
          // slot does. It read 0 back when the Lens was the only rail there
          // could be and a rail was not somewhere a second card could stand.
          expect(await stackDepthAttr(app, "pLens")).toBe("1");

          // --- The badge is unlit at rest. ---------------------------------
          expect(
            await app.evalJS<string | null>(
              `document.querySelector(${JSON.stringify(`${frame("p1")} ${BADGE}`)}).getAttribute("data-state")`,
            ),
            "a closed picker leaves its badge in the resting pose",
          ).toBe("closed");

          // --- The picker lists the slot, topmost first, front row checked. -
          await app.nativeClickAtElement(`${frame("p1")} ${BADGE}`);
          await waitForMenu(app, true);

          // ...and the badge stays lit for as long as the menu is down, the
          // way a macOS menu-bar title holds its highlight. The CSS hangs off
          // `data-state`, so this is the whole contract that keeps the control
          // that opened the surface saying so.
          expect(
            await app.evalJS<string | null>(
              `document.querySelector(${JSON.stringify(`${frame("p1")} ${BADGE}`)}).getAttribute("data-state")`,
            ),
            "an open picker keeps its badge lit",
          ).toBe("open");

          expect(await count(app, ROW), "one row per pane in the slot").toBe(2);

          // A row REPRODUCES ITS PANE'S TITLE BAR TEXT — not a name derived
          // some other way. That distinction is the whole point: a pane's
          // title bar composes a registry title with the live override its
          // card publishes, and a list that instead read `CardState.title`
          // named a bound Session card `Untitled` while its title bar read
          // `test-repo/petit-thaw`. The seeded cards carry a `CardState.title`
          // ("Card A") that differs from what their title bars render
          // ("Chain Actions"), so this comparison catches exactly that drift.
          expect(await rowLabels(app), "each row reads as its pane's title bar does").toEqual([
            await titleBarText(app, "p1"),
            await titleBarText(app, "p0"),
          ]);
          expect(await rowLabels(app), "topmost first, and named from the registry not the card record").toEqual([
            "Chain Actions",
            "TugAnimator",
          ]);
          expect(await checkedRowPaneId(app), "the front pane's row is the checked one").toBe("p1");

          // --- Each row is a miniature of the title bar it stands for. ------
          // Not merely "an icon is present": the row's glyph has to be the one
          // that pane's OWN title bar draws, which is what makes the row read
          // as a small picture of the card rather than as decoration. The two
          // stacked cards are of different kinds precisely so this can tell
          // the difference.
          expect(
            await app.evalJS<string | null>(
              lucideClassOf(`${ROW}[data-item-id="p1"] .tug-menu-item-icon svg`),
            ),
            "the front row carries the front pane's icon",
          ).toBe(
            await app.evalJS<string | null>(
              lucideClassOf(`${frame("p1")} [data-testid="tug-pane-icon"] svg`),
            ),
          );
          expect(
            await app.evalJS<string | null>(
              lucideClassOf(`${ROW}[data-item-id="p0"] .tug-menu-item-icon svg`),
            ),
            "and the buried row carries the buried pane's — a different one",
          ).toBe(
            await app.evalJS<string | null>(
              lucideClassOf(`${frame("p0")} [data-testid="tug-pane-icon"] svg`),
            ),
          );
          expect(
            await app.evalJS<string | null>(
              lucideClassOf(`${ROW}[data-item-id="p1"] .tug-menu-item-icon svg`),
            ),
            "the two rows are genuinely distinguishable, so the check above bites",
          ).not.toBe(
            await app.evalJS<string | null>(
              lucideClassOf(`${ROW}[data-item-id="p0"] .tug-menu-item-icon svg`),
            ),
          );

          // --- Choosing the back row raises that pane. ---------------------
          const zBefore = {
            p0: await zIndexOf(app, "p0"),
            p1: await zIndexOf(app, "p1"),
          };
          expect(zBefore.p1, "p1 starts above p0").toBeGreaterThan(zBefore.p0);

          await app.nativeClickAtElement(`${ROW}[data-item-id="p0"]`);
          await waitForMenu(app, false);
          await app.expectFocusedCard("Z", { timeoutMs: 5_000 });

          expect(await app.getFocusedCardId(), "the chosen pane's card is now first responder").toBe("Z");
          expect(await zIndexOf(app, "p0"), "and its frame carries the higher z-index").toBeGreaterThan(
            await zIndexOf(app, "p1"),
          );

          // --- Cmd-click a title bar: opens the picker, raises nothing. ----
          // Background-safe: the no-travel branch runs on pointerup and has no
          // dependence on a frame ever being served.
          await app.click(titleBar("p1"), { metaKey: true });
          await waitForMenu(app, true);
          expect(await app.getFocusedCardId(), "Cmd-click looks without touching — Z stays in front").toBe("Z");

          // The Cmd-DRAG half of this gesture pair lives in at0349, which
          // takes a key window. It cannot be asserted here: `dragMoved`
          // latches only inside a `requestAnimationFrame` callback, and a
          // background window runs no rAF, so a synthetic Cmd-drag here would
          // fall into the no-travel branch and open the picker — the
          // assertion would invert rather than fail.
          // --- A peer leaving does not take the picker with it. ------------
          // The menu is open right now. Close the OTHER pane in the slot. The
          // depth drops to 1 and the slot stays a slot, so the badge keeps
          // standing — it just says `1` — and the menu it belongs to is left
          // exactly where the hand put it.
          //
          // This inverts the old claim deliberately. While the badge was gated
          // on depth, closing a peer unmounted the trigger mid-menu, so the
          // depth prop had to force the picker shut: the focus trap's
          // `onCloseAutoFocus` would never run, keyboard focus would strand on
          // a removed node, and the stale open bit would make the badge mount
          // ALREADY OPEN next time. The guard survives, keyed on whether the
          // pane holds a place at all rather than on how deep the place is —
          // and against a badge that no longer comes and goes with its peers,
          // closing here would be the bug: it would snatch the menu out from
          // under a hand reaching for "Split Vertically".
          await app.evalJS<null>(`(window.__tug.closePane("p0"), null)`);
          expect(await stackDepthAttr(app, "p1"), "the surviving pane stands alone in its slot").toBe("1");
          expect(await count(app, `${frame("p1")} ${BADGE}`), "and keeps its badge, because it keeps its slot").toBe(1);
          expect(await badgeText(app, "p1"), "now reading one of one").toBe("1");
          await waitForMenu(app, true);

          note("at0347", "Cmd-drag-still-drags is asserted in at0349 (foreground); see Spec S07");
          note(
            "at0347",
            "the picker's unmount guard now keys on holding a PLACE, not on depth; " +
              "losing a place outright is not reachable by gesture in this fixture " +
              "(a reseed would close the menu for unrelated reasons), so it is covered " +
              "by the guard's own condition rather than asserted here",
          );
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a row reproduces a title that exists only as a live override",
      async () => {
        // The case the picker originally got wrong, and the reason the title
        // rule had to move into one place. A card whose registry title is
        // EMPTY carries its whole identity in a `cardTitleStore` override —
        // the Session card bound to a project is the real instance, and the
        // About card is that same shape with no backend behind it. Naming a
        // pane from its `CardState.title` (which the deck happens to hold)
        // reads `Untitled` here while the title bar reads the real name.
        const app = await launchTugApp({ testName: "at0347-stack-override-title" });
        try {
          await app.seedDeckState({
            state: {
              cards: [
                { id: "Z", componentId: "about", title: "Card Z", closable: true },
                card("A", "Card A", "gallery-chain-actions"),
                { id: "L", componentId: "layout", title: "Layout", closable: true },
              ],
              panes: [
                pane("p0", "Z", 520, 0),
                pane("p1", "A", 420, 0),
                lensPane(),
              ],
              activePaneId: "p1",
              imposition: { kind: "three-up", lens: "right" },
              hasFocus: true,
            },
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 3`,
            { timeoutMs: 5_000 },
          );
          // The override is published from the card's own layout effect, so
          // wait for the title bar to actually carry it rather than assuming.
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(`${frame("p0")} [data-testid="tug-pane-title"]`)}) || { textContent: "" }).textContent.trim().startsWith("About ")`,
            { timeoutMs: 5_000 },
          );

          const overrideTitle = await titleBarText(app, "p0");
          note("at0347 override title bar text", overrideTitle);

          await app.nativeClickAtElement(`${frame("p1")} ${BADGE}`);
          await waitForMenu(app, true);

          const labels = await rowLabels(app);
          expect(labels[1], "the row reproduces the title bar's own text").toBe(
            overrideTitle,
          );
          expect(labels[1], "and is emphatically not the old fallback").not.toBe(
            "Untitled",
          );
          expect(labels[1], "nor the CardState.title the deck happens to hold").not.toBe(
            "Card Z",
          );
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a fully covered pane hides its badge along with everything else",
      async () => {
        const app = await launchTugApp({ testName: "at0347-stack-badge-occluded" });
        try {
          await seed(app, occludedDeckShape(), "A");

          // Equal widths, so the buried pane is provably covered by a single
          // opaque pane above it. The controller's containment test is
          // conservative — it leaves a pane visible when it cannot prove
          // coverage — so this is the case where it can.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(frame("p0"))}).getAttribute("data-occluded") === "true"`,
            { timeoutMs: 5_000 },
          );

          // The badge is still in the DOM — `visibility: hidden` does not
          // remove it, and querySelector still finds it. What changed is
          // whether anyone can see it.
          expect(await count(app, `${frame("p0")} ${BADGE}`), "the buried badge is still queryable").toBe(1);
          expect(
            await app.evalJS<string>(
              `getComputedStyle(document.querySelector(${JSON.stringify(`${frame("p0")} ${BADGE}`)})).visibility`,
            ),
            "but it computes hidden, so a same-width stack shows exactly one badge",
          ).toBe("hidden");
          expect(
            await app.evalJS<string>(
              `getComputedStyle(document.querySelector(${JSON.stringify(`${frame("p1")} ${BADGE}`)})).visibility`,
            ),
            "the front one is the badge the user sees",
          ).toBe("visible");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
