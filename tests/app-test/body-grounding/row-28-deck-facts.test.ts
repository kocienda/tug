/**
 * row-28-deck-facts.test.ts — a body follows the deck's facts that a page
 * cannot see for itself: the modifiers held while the shell has the keyboard,
 * and the focus-ring modality.
 *
 * A body sees only the keys that reach its own view, which is none while the
 * shell holds the keyboard, so the shell sends its held set as the
 * `modifierLatch` deck fact and a body's root wears the union of its own set
 * and the shell's. The focus-ring modality was read by each body from
 * tugbank at boot and never again; it is now a fact the body follows, and the
 * body persists nothing it is sent.
 *
 * One body card. Every card kind is a body now, so the shell holds the
 * keyboard only when its own surface is clicked: an empty spot on the deck
 * canvas, after which no body is the window's first responder.
 *
 * - **The modality.** `focusRingModality` written to tugbank by the CLI, under
 *   the app's instance id, while the app runs reaches the shell through the
 *   DEFAULTS push, and the body's focus
 *   engine follows it, to `pointer` and back.
 * - **The latch, shell key.** With the shell holding the keyboard, Shift
 *   held through the session tap lands `data-mods="shift"` on the shell's
 *   root and on the body's, and its release clears both.
 * - **The latch, a hand-off while held.** Shift held in the shell, the
 *   keyboard given to the body, Shift released there: no root is left
 *   wearing `shift`.
 * - **The latch, body key.** With the body holding the keyboard, Shift held
 *   lands on the body's root from its own key events, and the release clears it.
 *
 * @covers tugdeck/src/lib/modifier-latch.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/focus-ring-modality-store.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App, type BodyApp } from "../_harness";
import { withModifiersHeld } from "../_harness/client";
import { mkTempTugbank, seedTugbankForLaunch } from "../_harness/tugbank-helpers";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { SETTLE_MS, focusBody, settleFor, spawnStub, waitForBody } from "./_bodies";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { kindsUnderTest } from "./_kinds";

const TEST_NAME = "body-grounding-row-28-deck-facts";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const A = "r28-a";
const mods = `document.documentElement.getAttribute("data-mods")`;
const ringFollowsPointer = "window.__tug.ringFollowsPointer()";

/**
 * Write the focus-ring modality into the running app's tugbank the way
 * another process would: the CLI, under the app's instance id, so its change
 * notice reaches that instance's tugcast and the shell is pushed the value.
 */
function writeModality(app: App, tugbankPath: string, value: "keyboard" | "pointer"): void {
  const binary = process.env.TUGAPP_TUGBANK_BINARY;
  expect(binary, "the tugbank CLI is named for the harness").toBeDefined();
  const result = Bun.spawnSync(
    [binary!, "--path", tugbankPath, "write", "dev.tugapp.app", "focusRingModality", "--type", "string", value],
    { env: { ...process.env, TUG_INSTANCE_ID: app.instanceId } },
  );
  expect(result.exitCode, `tugbank write focusRingModality ${value}: ${result.stderr.toString()}`).toBe(0);
}

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [
      {
        id: `${A}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 640, height: 600 },
        cardIds: [A],
        activeCardId: A,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${A}-pane`,
    hasFocus: true,
  };
}

/**
 * A point on the deck canvas no pane stands over, in the shell's
 * coordinates: a click there is the shell's own, and takes the keyboard
 * from every body. Clear of every pane by more than a card's apron: a card
 * that draws its own chrome is a view outset from its pane, and the band
 * along an edge its pane offers as a grip is the card's (`CardHitShape`),
 * so a point just past a column's seam is a press on that card's grip.
 */
const EMPTY_CANVAS = `(function () {
  var CLEAR = 12;
  var panes = Array.from(document.querySelectorAll(".tug-pane")).map(function (p) { return p.getBoundingClientRect(); });
  var nearPane = function (x, y) {
    return panes.some(function (r) { return x > r.left - CLEAR && x < r.right + CLEAR && y > r.top - CLEAR && y < r.bottom + CLEAR; });
  };
  for (var y = window.innerHeight - 40; y > 40; y -= 40) {
    for (var x = 40; x < window.innerWidth - 40; x += 40) {
      if (nearPane(x, y)) continue;
      var el = document.elementFromPoint(x, y);
      if (el !== null && el.closest(".tug-pane") === null && el.closest("[data-deck-canvas-background]") !== null) return { x: x, y: y };
    }
  }
  return null;
})()`;

/** Both pages' `data-mods`, polled until `done` or the settle runs out. */
async function modsOf(app: App, a: BodyApp, done: (shell: string | null, body: string | null) => boolean): Promise<{ shell: string | null; body: string | null }> {
  return settleFor(
    async () => ({ shell: await app.evalJS<string | null>(mods), body: await a.evalJS<string | null>(mods) }),
    (m) => done(m.shell, m.body),
    SETTLE_MS,
  );
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 28: the deck facts a body follows", () => {
  for (const kind of kindsUnderTest(28)) test(
    `${kind.componentId}: the focus-ring modality and the shell's held modifiers reach its body`,
    async () => {
      const session = kind.componentId === "session";
      const card = session ? A : `r28-${kind.componentId}`;
      const stubDir = stubDirectory();
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: kind.componentId === "session" ? TEST_NAME : `${TEST_NAME}-${kind.componentId}`,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir, TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.seedDeckState({
          state: session ? deck() : kindDeck(kind, card, { sessions: ["r28-seed"] }),
          focusCardId: card,
        });
        if (session) {
          await spawnStub(app, card, stubDir, 2);
          await waitForBody(app, card);
        } else {
          await standUpKind(app, kind, card);
        }
        const a = app.body(card);

        // ---- The focus-ring modality, followed live ----
        const atStart = { shell: await app.evalJS<boolean | null>(ringFollowsPointer), body: await a.evalJS<boolean | null>(ringFollowsPointer) };
        expect(atStart, "at the start both pages paint the ring on the keyboard only").toEqual({ shell: false, body: false });
        writeModality(app, tugbankPath, "pointer");
        const pointer = await settleFor(
          async () => ({ shell: await app.evalJS<boolean | null>(ringFollowsPointer), body: await a.evalJS<boolean | null>(ringFollowsPointer) }),
          (m) => m.shell === true && m.body === true,
          SETTLE_MS * 3,
        );
        note(`ring follows pointer: at the start ${JSON.stringify(atStart)}; after the write ${JSON.stringify(pointer)}`);
        expect(pointer, "the shell takes the write and the body follows it").toEqual({ shell: true, body: true });
        writeModality(app, tugbankPath, "keyboard");
        const back = await settleFor(
          async () => ({ shell: await app.evalJS<boolean | null>(ringFollowsPointer), body: await a.evalJS<boolean | null>(ringFollowsPointer) }),
          (m) => m.shell === false && m.body === false,
          SETTLE_MS * 3,
        );
        expect(back, "and back, both").toEqual({ shell: false, body: false });

        // ---- The latch with the shell holding the keyboard ----
        const empty = await app.evalJS<{ x: number; y: number } | null>(EMPTY_CANVAS);
        expect(empty, "the deck canvas has a spot no pane stands over").not.toBeNull();
        await app.nativeClick(empty!);
        const holders = await settleFor(() => app.bodies(), (bs) => bs.every((b) => !b.firstResponder), SETTLE_MS);
        expect(holders.filter((b) => b.firstResponder).map((b) => b.cardId), "a click on the empty canvas gives the shell the keyboard").toEqual([]);
        let held: { shell: string | null; body: string | null } = { shell: null, body: null };
        await withModifiersHeld(app, ["shift"], async () => {
          held = await modsOf(app, a, (s, b) => s === "shift" && b === "shift");
        });
        const released = await modsOf(app, a, (s, b) => s === null && b === null);
        note(`shell key: Shift held ${JSON.stringify(held)}; released ${JSON.stringify(released)}`);
        expect(held, "Shift held in the shell lands on both roots").toEqual({ shell: "shift", body: "shift" });
        expect(released, "its release clears both").toEqual({ shell: null, body: null });

        // ---- Held in the shell, released in the body ----
        let handedOff: { shell: string | null; body: string | null } = { shell: null, body: null };
        await withModifiersHeld(app, ["shift"], async () => {
          await modsOf(app, a, (s) => s === "shift");
          await focusBody(app, card, { composer: false });
          handedOff = { shell: await app.evalJS<string | null>(mods), body: await a.evalJS<string | null>(mods) };
        });
        const afterHandOff = await modsOf(app, a, (s, b) => s === null && b === null);
        note(`Shift held across the hand-off to the body: while held ${JSON.stringify(handedOff)}; released ${JSON.stringify(afterHandOff)}`);
        expect(afterHandOff, "a modifier released after the keyboard moved leaves neither root wearing it").toEqual({ shell: null, body: null });

        // ---- The body's own key events ----
        let bodyHeld: { shell: string | null; body: string | null } = { shell: null, body: null };
        await withModifiersHeld(app, ["shift"], async () => {
          bodyHeld = await modsOf(app, a, (_s, b) => b === "shift");
        });
        const bodyReleased = await modsOf(app, a, (s, b) => s === null && b === null);
        note(`body key: Shift held ${JSON.stringify(bodyHeld)}; released ${JSON.stringify(bodyReleased)}`);
        expect(bodyHeld.body, "Shift held with the body key lands on the body's root").toBe("shift");
        expect(bodyReleased, "its release clears it").toEqual({ shell: null, body: null });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
