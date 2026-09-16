/**
 * at0584-move-to-workspace-menu.test.ts — the named door for moving a card to
 * another workspace.
 *
 * Dragging a card's row onto a workspace block (at0583) is the fast path, and
 * it is the only path a card had. A drag is a gesture you have to already know
 * about: nothing on a pane said the verb existed. So every pane's title bar now
 * carries Move to Workspace in the rollup's shared spine ([B08]) — one control,
 * at one offset, on a Session card's masthead-bearing pane exactly as on a Text
 * card's, because a card of ANY kind moves and the verb is therefore the pane's
 * rather than any card family's.
 *
 * What this file pins:
 *
 *   1. **The menu lists the workspaces you are not in.** The pane's own
 *      workspace is never a row — a move to where the card already is is not a
 *      move — so with two workspaces the menu holds exactly one row, by name.
 *   2. **Choosing a row files the card and leaves the user where they are.**
 *      The card leaves the active deck and turns up in the other workspace's
 *      parked record with the same id, and `activeSpaceId` does not change.
 *      That is [B04] held by a test at the menu, the same way at0583 holds it
 *      at the drag: a move is a filing gesture, not a travel one.
 *   3. **With one workspace the trigger dims rather than vanishes.** A control
 *      that disappears when it has nothing to offer teaches nobody that the
 *      verb exists; a dimmed one with a phrase saying why teaches both. The
 *      phrase rides the anchoring span, not the button, because a disabled
 *      button takes no pointer events ([L31]).
 *   4. **One offset, whatever the chrome tier.** The Session card's masthead
 *      stands a line taller than a document card's AND portals its own chrome
 *      accessories into the very control cluster the rollup is anchored to, so
 *      a Session pane is where the trigger would drift if anything were going
 *      to. It is measured from the pane's trailing edge on both panes and the
 *      two must agree. The panes are asserted to be wearing DIFFERENT masthead
 *      kinds first, because otherwise the offsets agreeing proves nothing —
 *      which is why that leg opens a REAL fixture session rather than seeding
 *      a bare Session card, whose bar carries no masthead at all.
 *
 * The second workspace comes from a seeded `version: 5` blob, as at0580's does,
 * so the test rests on nothing later than the workspace record itself; the
 * launch carries `restoreInTestMode` because that blob IS the fixture.
 *
 * `@covers` names the pane, where the control is authored, and deliberately
 * NOT `deck-canvas.tsx`, which holds the wiring this test drives: the canvas
 * is already at its recorded fan-out ceiling, and the ratchet lets that debt
 * be paid down rather than refinanced — at0580's own precedent for
 * `deck-manager.ts`. Twenty-one tests already select on a canvas edit, so the
 * wiring is not going unguarded; it is going unnamed.
 *
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { seedFixtureSession } from "./fixtures/resolve";
import { openFixtureSession, waitForTranscriptSettled } from "./fixtures/runner";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const HOME_SPACE = "space-home";
const AWAY_SPACE = "space-away";

const PANE_A = '.tug-pane[data-pane-id="p1"]';
const MOVE_BUTTON = '[data-testid="tug-pane-title-bar-move-space-button"]';
const MOVE_MENU = '[data-testid="tug-pane-title-bar-move-space-menu"]';
const WIDTH_BUTTON = '[data-testid="tug-pane-title-bar-width-button"]';

/** The settle window the imposition's landing tween wants, as at0468 uses. */
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface SpacesProbe {
  activeSpaceId: string;
  spaces: {
    id: string;
    name: string;
    active: boolean;
    deck: { cards: { id: string }[] } | null;
  }[];
}

/**
 * Two workspaces. Home is active and holds a Session card, which carries a
 * masthead and the full title-bar cluster from a bare seed — no fixture repo
 * and no published payload, on at0468's precedent. Away holds a Text card, so
 * the far side is a workspace with contents of its own rather than a void.
 */
const TWO_SPACE_BLOB = {
  version: 5,
  activeSpaceId: HOME_SPACE,
  spaces: [
    {
      id: HOME_SPACE,
      name: "Home",
      deck: {
        cards: [
          { id: "A", componentId: "session", title: "Session A", closable: true },
        ],
        panes: [
          {
            id: "p1",
            position: { x: 40, y: 40 },
            size: { width: 675, height: 520 },
            cardIds: ["A"],
            activeCardId: "A",
            title: "",
            acceptsFamilies: ["standard"],
          },
        ],
        activePaneId: "p1",
        imposition: { kind: "one-up", sidebars: {} },
        hasFocus: true,
      },
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

/**
 * The trigger as the eye and the hand meet it: whether it is dimmed, where it
 * sits measured from the ROLLUP ROW's trailing edge, and where it sits
 * relative to card width, which it must stand left of.
 *
 * The row's trailing edge is the datum rather than the pane's, and the
 * difference is not a technicality. The row is anchored inside the control
 * cluster, and the cluster's own membership legitimately differs pane to pane
 * — a pane standing in a slot wears badges a free one does not. What "one
 * offset" claims is about the SPINE: read right to left it is bullseye, then
 * card width, then this, and that order and those widths are what the hand
 * learns. Measuring from the pane would be measuring the badges.
 */
async function triggerStanding(
  app: App,
  paneSelector: string,
): Promise<{
  disabled: boolean;
  spineOffset: number;
  leftOfWidth: boolean;
  mastheadKind: string | null;
}> {
  return app.evalJS(
    `(function () {
      var pane = document.querySelector(${JSON.stringify(paneSelector)});
      if (pane === null) throw new Error("no pane at " + ${JSON.stringify(paneSelector)});
      var button = pane.querySelector(${JSON.stringify(MOVE_BUTTON)});
      if (button === null) throw new Error("no move trigger on " + ${JSON.stringify(paneSelector)});
      var width = pane.querySelector(${JSON.stringify(WIDTH_BUTTON)});
      var row = pane.querySelector('[data-testid="tug-pane-title-bar-rollup-row"]');
      if (row === null) throw new Error("no rollup row on " + ${JSON.stringify(paneSelector)});
      var p = row.getBoundingClientRect();
      var b = button.getBoundingClientRect();
      return {
        disabled: button.disabled === true || button.getAttribute("aria-disabled") === "true",
        spineOffset: p.right - b.right,
        leftOfWidth: width !== null && b.left < width.getBoundingClientRect().left,
        mastheadKind: pane.getAttribute("data-masthead-kind")
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0584 — Move to Workspace in the spine", () => {
  test(
    "the menu lists the other workspaces, and choosing one files the card without following it",
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
        testName: "at0584-move-to-workspace-menu",
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
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PANE_A)}) !== null`,
          { timeoutMs: 10_000 },
        );
        await wait(AFTER_LAND_MS);

        // --- The door is there, and it is live with somewhere to go. ------
        const standing = await triggerStanding(app, PANE_A);
        note(
          `trigger: disabled=${standing.disabled} ` +
            `spineOffset=${standing.spineOffset.toFixed(1)} ` +
            `leftOfWidth=${standing.leftOfWidth} masthead=${standing.mastheadKind}`,
        );
        expect(
          standing.disabled,
          "with a second workspace standing, the verb has somewhere to go",
        ).toBe(false);
        expect(
          standing.leftOfWidth,
          "and it sits before card width in the right-to-left spine, so bullseye and width keep their learned spots",
        ).toBe(true);

        // --- The menu names the workspaces you are NOT in. ----------------
        await app.revealPaneControls(PANE_A);
        await app.nativeClickAtElement(`${PANE_A} ${MOVE_BUTTON}`);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(MOVE_MENU)}).length > 0`,
          { timeoutMs: 5_000 },
        );
        const labels = await app.evalJS<string[]>(
          `Array.prototype.slice.call(
             document.querySelector(${JSON.stringify(MOVE_MENU)})
               .querySelectorAll(".tug-menu-item-label")
           ).map(function (el) { return el.textContent; })`,
        );
        note(`menu rows: ${JSON.stringify(labels)}`);
        expect(
          labels,
          "the pane's own workspace is not a row — a move to where the card already is is no move",
        ).toEqual(["Away"]);

        // --- Choosing one files the card and leaves the user put. ---------
        await app.nativeClickAtElement(`${MOVE_MENU} .tug-menu-item`);
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.listCardIds().indexOf("A") === -1`,
          { timeoutMs: 8_000 },
        );

        const after = await app.evalJS<SpacesProbe>(
          `window.tugdeck.diag.getSpaces()`,
        );
        expect(
          after.activeSpaceId,
          "the move did not follow the card: the user is still in the workspace they were working in ([B04])",
        ).toBe(HOME_SPACE);
        const away = after.spaces.find((s) => s.id === AWAY_SPACE);
        expect(away?.active).toBe(false);
        expect(
          (away?.deck?.cards ?? []).map((c) => c.id),
          "and the card is on the far side, the same card",
        ).toContain("A");
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );


  test(
    "with one workspace the trigger dims rather than vanishes, at one offset on either chrome tier",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const seeded = await seedFixtureSession(
        "session-transcript-basic",
        "at0584",
      );
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.dev",
        "recent-projects",
        "json",
        JSON.stringify({ paths: [seeded.projectDir] }),
      );

      const app = await launchTugApp({
        testName: "at0584-move-to-workspace-menu-alone",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
      });
      try {
        // A REAL session in pane `p1`, because an unbound Session card wears
        // the one-line bar and the tier this leg is about is the masthead —
        // whose own chrome accessories portal into the very control cluster
        // the rollup is anchored to. An accessory that widened that cluster
        // would drag the trigger leftward on Session panes alone, which is
        // exactly the drift a bare seed could not see.
        await openFixtureSession(app, seeded);
        await waitForTranscriptSettled(app);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PANE_A)}) !== null &&
           document.querySelector(${JSON.stringify(PANE_A)}).getAttribute("data-masthead-kind") === "session"`,
          { timeoutMs: 15_000 },
        );

        // A Text card beside it, through the verb rather than a re-seed: the
        // session pane must survive into the comparison.
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("new-text-card"), null)`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('.tug-pane[data-pane-id]').length === 2`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        const textPane = await app.evalJS<string>(
          `(function () {
            var panes = Array.prototype.slice.call(
              document.querySelectorAll('.tug-pane[data-pane-id]'));
            var other = panes.filter(function (p) {
              return p.getAttribute("data-pane-id") !== "p1";
            });
            if (other.length !== 1) throw new Error("expected one other pane, saw " + other.length);
            return '.tug-pane[data-pane-id="' + other[0].getAttribute("data-pane-id") + '"]';
          })()`,
        );

        expect(
          await app.evalJS<number>(
            `window.tugdeck.diag.getSpaces().spaces.length`,
          ),
          "one workspace — the case the dimmed trigger is for",
        ).toBe(1);

        // Both panes are read at rest: the row is hidden by opacity, never by
        // `display`, so every button keeps its measured box without a reveal
        // (at0468's first claim, which this leg's geometry rests on).
        const session = await triggerStanding(app, PANE_A);
        const text = await triggerStanding(app, textPane);
        note(
          `session pane: masthead=${session.mastheadKind} ` +
            `offset=${session.spineOffset.toFixed(2)} | text pane (${textPane}): ` +
            `masthead=${text.mastheadKind} offset=${text.spineOffset.toFixed(2)}`,
        );

        expect(
          session.disabled,
          "the trigger is there with one workspace, dimmed — a control that vanishes teaches nobody the verb exists",
        ).toBe(true);
        expect(text.disabled, "on every pane, not just the focused one").toBe(
          true,
        );

        // The tiers must actually differ, or the offsets agreeing is a
        // tautology rather than a finding.
        expect(
          session.mastheadKind,
          "the Session card wears the taller masthead tier",
        ).toBe("session");
        expect(
          text.mastheadKind,
          "and the Text card wears the document one",
        ).toBe("card");
        expect(
          Math.abs(session.spineOffset - text.spineOffset),
          "and the control stands at one offset in the spine on both, so the hand learns one spot",
        ).toBeLessThanOrEqual(0.51);

        // The phrase that says WHY it is dimmed rides the anchoring span
        // rather than the button, because a disabled button takes no pointer
        // events and would raise no tooltip at all ([L31]).
        expect(
          await app.evalJS<boolean>(
            `(function () {
              var button = document.querySelector(${JSON.stringify(PANE_A)})
                .querySelector(${JSON.stringify(MOVE_BUTTON)});
              var anchor = button.closest(".tug-pane-title-bar-tooltip-anchor");
              return anchor !== null && anchor.contains(button);
            })()`,
          ),
          "the disabled trigger hangs inside a tooltip anchor that can still take the pointer",
        ).toBe(true);
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
