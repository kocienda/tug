/**
 * at0550-session-minimize-doors.test.ts — one action, three doors: the card's
 * minimize is the same commit however it is reached.
 *
 * ## What this gates
 *
 * The Session card's minimized form has three ways in ([B04], [P02]) — a
 * button ahead of Z4A, Session ▸ Minimize Session, and ⌥⌘M — and they are one
 * `toggle-session-minimized` command rather than three handlers, so the state
 * they read and the deck commit they land cannot drift apart. This file drives
 * the doors that exist at the vocabulary layer (the control frame the menu
 * item posts, and the item's own validated state) and reads the flag off the
 * PANE, which is where it lives: the flag is the pane's ([P01]), and the form
 * it produces is a later step's subject.
 *
 * Three claims:
 *
 *   1. **The wire lands on the pane.** `toggle-session-minimized` — byte for
 *      byte what the Swift item sends — flips `getPaneRecord(pane).minimized`,
 *      and flips it back. The toggle reads the live flag rather than a card's
 *      memory of it, so a second press is a show rather than a second
 *      minimize.
 *   2. **The item says what the gesture will do.** `session.minimize` reads
 *      enabled with the title `Minimize Session` over an open card and `Show
 *      Transcript` over a minimized one, and it carries ⌥⌘M — the ⌥ variant of
 *      the window's own ⌘M, which is untouched.
 *   3. **A non-Session key card disables it.** The verb has no pane to fold
 *      there, so the item dims and the chord beeps rather than reaching
 *      whatever pane happens to be frontmost.
 *
 * What this file deliberately does NOT read is the FORM — no folded
 * transcript, no Show Transcript bar, no tier arithmetic. That is at0551's
 * subject. The one thing it does read past the flag is `data-minimized` on
 * the pane frame, because that attribute is the JOINT: the flag is where the
 * state lives and the attribute is the whole of how it is worn ([P03]), so a
 * door that lands the flag without reaching the frame has landed nothing a
 * person can see, and no test of the form alone would say which half broke.
 *
 * Nor does it name `session-card.tsx`, `tug-prompt-entry.tsx`, or
 * `deck-manager.ts` in `@covers`, though it reaches through all three. All
 * three stand at the selection budget's ceiling, and each is already named by
 * a file that catches the same breakage sooner: at0140 walks the composer's
 * focus cycle, at0340 drives its routes, and the deck commit this file's flag
 * comes from is a unit test's subject. A declaration is a claim about what a
 * test would CATCH first rather than about what it touches.
 *
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/components/tugways/action-vocabulary.ts
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/components/tugways/cards/use-menu-state-publication.ts
 * @covers tugapp/Sources/AppDelegate.swift
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** `NSEvent.ModifierFlags` raw values, so the expectation reads as a chord. */
const OPTION = 1 << 19;
const COMMAND = 1 << 20;

const SID = "at0550-session";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const PANE_ID = "p1";
const PANE_FRAME = `.tug-pane[data-pane-id="${PANE_ID}"]`;

/** The Z4-lead seat and the button it holds ([D97]). */
const LEAD = `${CARD} .tug-prompt-entry-lead`;
const MINIMIZE_BUTTON = `${LEAD} [aria-label="Minimize"]`;

/** One Session card — the doors' subject. */
function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: PANE_ID,
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: PANE_ID,
    hasFocus: true,
  };
}

/**
 * One plain card and nothing else — the gate's other side. Its own fixture
 * rather than a second pane on the shape above, because what the gate is about
 * is the key card's TYPE, and a deck holding a Session card next door invites
 * the reading that the item dimmed for some other reason.
 */
function plainCardDeck() {
  return {
    cards: [
      { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
    ],
    panes: [
      {
        id: "p2",
        position: { x: 60, y: 60 },
        size: { width: 520, height: 420 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

/** The pane's stored `minimized` flag — the deck's own answer, not a frame's. */
async function paneMinimized(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).minimized`,
  );
}

/** Poll until the item's validated enabled state matches. */
async function waitMenuEnabled(
  app: App,
  identifier: string,
  wantEnabled: boolean,
  timeoutMs = 8000,
): Promise<{ found: boolean; enabled?: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; enabled?: boolean } = { found: false };
  while (Date.now() < deadline) {
    last = await app.menuItemState(identifier);
    if (last.found && last.enabled === wantEnabled) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

/** Poll until the item's live title is exactly `want`. */
async function waitMenuTitle(
  app: App,
  identifier: string,
  want: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastTitle: string | undefined;
  while (Date.now() < deadline) {
    const item = await app.menuItemState(identifier);
    if (item.found) {
      lastTitle = item.title;
      if (item.title === want) return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(lastTitle, `${identifier} title`).toBe(want);
}

/**
 * The toolbar row's geometry: the Minimize button's box, the route group's,
 * Z4B's, and Z5's, all in viewport space so the assertions read as the row
 * reads.
 */
async function toolbarGeometry(app: App): Promise<{
  leadRight: number;
  routeLeft: number;
  routeRight: number;
  centerLeft: number;
  centerRight: number;
  submitLeft: number;
}> {
  return app.evalJS(
    `(function () {
      var rect = function (sel) {
        var el = document.querySelector(sel);
        return el === null ? null : el.getBoundingClientRect();
      };
      var lead = rect(${JSON.stringify(MINIMIZE_BUTTON)});
      var route = rect(${JSON.stringify(`${CARD} .tug-prompt-entry-route-group`)});
      var center = rect(${JSON.stringify(`${CARD} [data-slot="entry-shell-indicators"]`)});
      var submit = rect(${JSON.stringify(`${CARD} .tug-prompt-entry-toolbar button[data-mode]`)});
      return {
        leadRight: lead === null ? -1 : lead.right,
        routeLeft: route === null ? -1 : route.left,
        routeRight: route === null ? -1 : route.right,
        centerLeft: center === null ? -1 : center.left,
        centerRight: center === null ? -1 : center.right,
        submitLeft: submit === null ? -1 : submit.left,
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0550: the card minimize's doors", () => {
  test(
    "the control frame flips the pane flag, and the menu item says which way it goes",
    async () => {
      const app = await launchTugApp({ testName: "at0550-minimize-doors" });
      try {
        // `isEngineReady` reads the deck trace ring, so the trace has to be
        // recording before the engine reports.
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");

        // ── The resting state ──
        expect(await paneMinimized(app)).toBe(false);
        const open = await waitMenuEnabled(app, "session.minimize", true);
        expect(open.found, "session.minimize must exist").toBe(true);
        expect(open.enabled).toBe(true);
        await waitMenuTitle(app, "session.minimize", "Minimize Session");

        // The chord is the ⌥ variant of the window's ⌘M, carried on the item
        // so the menu bar is where the match happens.
        const item = await app.menuItemState("session.minimize");
        expect(item.found).toBe(true);
        if (item.found) {
          expect(item.keyEquivalent).toBe("m");
          expect(item.modifierMask & (OPTION | COMMAND)).toBe(OPTION | COMMAND);
        }

        // Window ▸ Minimize keeps its own ⌘M — the two are neighbours in the
        // chord space and nowhere else.
        const windowMinimize = await app.menuItemState("window.minimize");
        expect(windowMinimize.found).toBe(true);
        if (windowMinimize.found) {
          expect(windowMinimize.keyEquivalent).toBe("m");
          expect(windowMinimize.modifierMask & OPTION).toBe(0);
        }

        // ── The door: the exact control frame the Swift item posts ──
        // Focus the card first, so the key-card-scoped dispatch resolves it.
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-session-minimized"), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).minimized === true`,
          { timeoutMs: 8000 },
        );
        // …and the frame wears it. One attribute is the whole of the form's
        // cascade ([P03]), so this is the door's last mile.
        await app.waitForCondition<boolean>(
          `(function () {
             var frame = document.querySelector(${JSON.stringify(PANE_FRAME)});
             return frame !== null && frame.getAttribute("data-minimized") === "true";
           })()`,
          { timeoutMs: 8000 },
        );
        // The item's verb followed the flag — one published fact, two faces.
        await waitMenuTitle(app, "session.minimize", "Show Transcript");

        // ── And back: the toggle reads the live flag, so a second press shows
        // rather than minimizing twice.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-session-minimized"), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).minimized === false`,
          { timeoutMs: 8000 },
        );
        // And the attribute goes with it — the key is deleted rather than
        // written `false` ([P01]), so the frame stamps nothing at rest.
        await app.waitForCondition<boolean>(
          `(function () {
             var frame = document.querySelector(${JSON.stringify(PANE_FRAME)});
             return frame !== null && frame.getAttribute("data-minimized") === null;
           })()`,
          { timeoutMs: 8000 },
        );
        await waitMenuTitle(app, "session.minimize", "Minimize Session");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the button sits in Z4-lead, clear of the route group, and Z4B stays centred",
    async () => {
      const app = await launchTugApp({ testName: "at0550-minimize-button" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MINIMIZE_BUTTON)}) !== null`,
          { timeoutMs: 8000 },
        );

        const geo = await toolbarGeometry(app);

        // Ahead of the route group, and clear of it by more than the row's own
        // gap. The wider gap is the seat's whole argument ([B04]): a control
        // about the CARD standing next to a group about the MESSAGE, at the
        // row's bare rhythm, reads as one run of buttons. `--tug-space-md` is
        // 8px, so the seat's doubled gap is 16.
        expect(geo.leadRight).toBeGreaterThan(0);
        expect(geo.routeLeft).toBeGreaterThan(geo.leadRight);
        expect(geo.routeLeft - geo.leadRight).toBeGreaterThanOrEqual(15);

        // Z4B is still centred between the route group's right edge and Z5's
        // left — the seat is a fourth leading-fixed occupant, not a fourth
        // slot, so the shell's flanking spacers do their arithmetic unchanged.
        const centerMid = (geo.centerLeft + geo.centerRight) / 2;
        const gapMid = (geo.routeRight + geo.submitLeft) / 2;
        expect(Math.abs(centerMid - gapMid)).toBeLessThanOrEqual(2);

        // And it is the third door: a click lands the same flag the wire and
        // the menu item land.
        expect(await paneMinimized(app)).toBe(false);
        await app.nativeClickAtElement(MINIMIZE_BUTTON);
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).minimized === true`,
          { timeoutMs: 8000 },
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a non-Session key card disables the item",
    async () => {
      const app = await launchTugApp({ testName: "at0550-minimize-gate" });
      try {
        await app.seedDeckState({ state: plainCardDeck(), focusCardId: "B" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("B")`,
        );

        // The verb has no pane to fold from here, so the item dims and the
        // chord beeps rather than reaching the Session card next door.
        const dark = await waitMenuEnabled(app, "session.minimize", false);
        expect(dark.found, "session.minimize must exist").toBe(true);
        expect(dark.enabled).toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
