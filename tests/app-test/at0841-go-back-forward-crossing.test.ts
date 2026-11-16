/**
 * at0841-go-back-forward-crossing.test.ts — Go ▸ Back and Forward step the
 * cards the reader had focused, across a workspace boundary.
 *
 * ## What this gates, and what it deliberately does not
 *
 * The trail's own rules — truncation on a new landing, skip and prune of a
 * closed card, the cap — are pinned as a pure module
 * (`lib/__tests__/focus-trail.test.ts`), and the manager's use of it over a
 * mounted deck in `deck-go-back-forward*.test.ts`. None of that is repeated
 * here.
 *
 * What only the real app can answer is the round trip through the menu bar:
 *
 *   1. **The rows exist, carry the registry's chords, and are gated.** Both
 *      are `menuEligible` with empty Swift key equivalents, so the chord on
 *      the row is whatever the keymap wrote there. A deck nobody has moved in
 *      has no trail, and both rows are dark.
 *   2. **Landings made by the app's own doors are visits.** The walk below is
 *      a lateral ring chord and a Window-menu workspace row, the gestures a
 *      hand makes, and neither is told about the trail.
 *   3. **Back crosses into a parked workspace and arrives on its card.** The
 *      card Back names stands in the workspace that is no longer shown; the
 *      press shows that workspace with that card holding the keyboard.
 *   4. **Forward retraces it, from the menu row as from the chord.**
 *   5. **The row goes dark at the trail's start**, after walking all the way
 *      back.
 *
 * Both workspaces come from a seeded `version: 5` blob, as at0581's do, and
 * neither seeds a rail card.
 *
 * `@covers` names the files this feature owns and the wiring it added, and
 * deliberately not `command-registry.ts`, which holds the two entries: that
 * module is at its fan-out ceiling, and the ratchet lets that be paid down
 * rather than added to. The registry's own pins guard the entries.
 *
 * @covers tugdeck/src/lib/focus-trail.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugapp/Sources/MenuBarBuilder.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const SPACE_ONE = "space-one";
const SPACE_TWO = "space-two";

/** The Window menu's row for the second workspace. */
const ROW_TWO = "window.space.1";

/** `NSEvent.ModifierFlags` raw values, so an expectation reads as a chord. */
const CONTROL = 1 << 18;
const OPTION = 1 << 19;
const COMMAND = 1 << 20;

function textCard(id: string) {
  return { id, componentId: "text", title: `File ${id}`, closable: true };
}

function pane(id: string, slot: number, cardId: string) {
  return {
    id,
    position: { x: 40 + slot * 520, y: 40 },
    size: { width: 500, height: 500 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["standard"],
    slot,
  };
}

function deckOf(first: string, second: string, hasFocus: boolean) {
  return {
    cards: [textCard(first), textCard(second)],
    panes: [pane(`p-${first}`, 0, first), pane(`p-${second}`, 1, second)],
    activePaneId: `p-${first}`,
    imposition: { kind: "two-up", sidebars: {} },
    ...(hasFocus ? { hasFocus: true } : {}),
  };
}

/** Main holds A and B and is shown; Second holds C and D and is parked. */
const TWO_SPACE_BLOB = {
  version: 5,
  activeSpaceId: SPACE_ONE,
  spaces: [
    { id: SPACE_ONE, name: "Main", deck: deckOf("A", "B", true) },
    { id: SPACE_TWO, name: "Second", deck: deckOf("C", "D", false) },
  ],
};

/** Block until the shown workspace and the card holding the keyboard match. */
async function expectHere(app: App, spaceId: string, cardId: string): Promise<void> {
  try {
    await app.waitForCondition<boolean>(
      `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(spaceId)} &&
       window.__tug.getActiveCardId() === ${JSON.stringify(cardId)}`,
      { timeoutMs: 6_000 },
    );
  } catch (error) {
    const seen = await app.evalJS<string>(
      `window.tugdeck.diag.getSpaces().activeSpaceId + " / " + window.__tug.getActiveCardId()`,
    );
    throw new Error(`expected ${spaceId} / ${cardId}, the deck is at ${seen}`, { cause: error });
  }
}

/** Poll a Go row until its enabled state is `want`, and return what it read. */
async function waitEnabled(
  app: App,
  identifier: string,
  want: boolean,
  timeoutMs = 6_000,
): Promise<boolean | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: boolean | undefined;
  while (Date.now() < deadline) {
    const state = await app.menuItemState(identifier);
    last = state.found ? state.enabled : undefined;
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

/** Poll a row until it carries `keyEquivalent`, and return its modifier mask. */
async function chordOn(
  app: App,
  identifier: string,
  keyEquivalent: string,
  timeoutMs = 6_000,
): Promise<{ keyEquivalent: string | undefined; modifierMask: number | undefined }> {
  const deadline = Date.now() + timeoutMs;
  let last: { keyEquivalent: string | undefined; modifierMask: number | undefined } = {
    keyEquivalent: undefined,
    modifierMask: undefined,
  };
  while (Date.now() < deadline) {
    const state = await app.menuItemState(identifier);
    if (state.found) {
      last = { keyEquivalent: state.keyEquivalent, modifierMask: state.modifierMask };
      if (last.keyEquivalent === keyEquivalent) return last;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

/** One press of the real Back chord, resolved by the menu bar. */
async function pressBack(app: App): Promise<void> {
  await app.nativeKey("[", ["cmd", "ctrl", "alt"]);
}

describe.skipIf(!SHOULD_RUN)("at0841 — Go ▸ Back and Forward across workspaces", () => {
  test(
    "Back crosses into the parked workspace onto its card, Forward returns, and the row is dark at the start",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.deck.layout",
        "layout",
        "json",
        JSON.stringify(TWO_SPACE_BLOB),
      );

      const app = await launchTugApp({
        testName: "at0841-go-back-forward-crossing",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await app.waitForCondition<boolean>(
          `typeof window.tugdeck !== "undefined" && window.tugdeck.diag.getSpaces().spaces.length === 2`,
          { timeoutMs: 10_000 },
        );
        await expectHere(app, SPACE_ONE, "A");

        // ── The rows carry the registry's chords, and a deck nobody has
        // moved in has nowhere to go either way.
        const back = await chordOn(app, "go.back", "[");
        const forward = await chordOn(app, "go.forward", "]");
        note("go.back", JSON.stringify(back));
        note("go.forward", JSON.stringify(forward));
        expect(back.keyEquivalent, "Back's row carries the bracket").toBe("[");
        expect(back.modifierMask, "on ⌃⌥⌘").toBe(CONTROL | OPTION | COMMAND);
        expect(forward.keyEquivalent, "Forward's row carries the bracket").toBe("]");
        expect(forward.modifierMask, "on ⌃⌥⌘").toBe(CONTROL | OPTION | COMMAND);
        expect(
          await waitEnabled(app, "go.back", false),
          "with no trail behind, Back is dark",
        ).toBe(false);
        expect(
          await waitEnabled(app, "go.forward", false),
          "and with none ahead, so is Forward",
        ).toBe(false);

        // ── The reader's walk, by the app's own doors: the lateral ring to
        // B, then the Window menu's row to the second workspace.
        await app.nativeKey("]", ["cmd", "shift"]);
        await expectHere(app, SPACE_ONE, "B");
        expect(
          await waitEnabled(app, "go.back", true),
          "one visit behind lights Back",
        ).toBe(true);

        const switched = await app.performMenuItem(ROW_TWO);
        note("performed the workspace row", JSON.stringify(switched));
        await expectHere(app, SPACE_TWO, "C");

        // ── Back: the card before this one is B, and B stands in the
        // workspace that is no longer shown.
        await pressBack(app);
        await expectHere(app, SPACE_ONE, "B");

        // ── Forward, from the row this time: the crossing was a step, not a
        // visit, so the way ahead is still there.
        expect(
          await waitEnabled(app, "go.forward", true),
          "after a Back there is somewhere ahead",
        ).toBe(true);
        const performed = await app.performMenuItem("go.forward");
        note("performed go.forward", JSON.stringify(performed));
        await expectHere(app, SPACE_TWO, "C");
        expect(
          await waitEnabled(app, "go.forward", false),
          "and at the trail's end Forward is dark again",
        ).toBe(false);

        // ── All the way back: across the boundary to B, then to A, where
        // the trail starts.
        await pressBack(app);
        await expectHere(app, SPACE_ONE, "B");
        await pressBack(app);
        await expectHere(app, SPACE_ONE, "A");
        expect(
          await waitEnabled(app, "go.back", false),
          "at the trail's start Back is dark",
        ).toBe(false);
        expect(
          await waitEnabled(app, "go.forward", true),
          "with the whole walk ahead of it",
        ).toBe(true);
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
