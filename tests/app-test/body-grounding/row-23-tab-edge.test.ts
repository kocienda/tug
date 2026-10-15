/**
 * row-23-tab-edge.test.ts — a body card's walk runs off its edge into the
 * shell and comes back, by Tab and by the View menu, both ways.
 *
 * Where a body's walk runs off an end it posts `focus-exit`; the shell lands
 * its own first or last stop of the card, or with none sends `focus-enter`
 * back at the end the walk came in by. A Session card has no stop in the
 * shell (it authors its own folded form, so it wears no Unfold glyph), so
 * the walk comes straight back: in the shell, as in a body, the walk never
 * leaves the key card, and a body's lap is the in-document card's lap. And
 * a step the shell takes while a body card is key — the View menu's Next
 * and Previous Keyboard Focus run there — is handed to the body, which
 * steps from its own key view. Before, those items walked the shell's half
 * of the card, which is empty, and did nothing.
 *
 * Four laps on one body card: the menu forward and back, then Tab and ⇧Tab
 * through the session tap. Each lap must pass the edge and come round to
 * the stop it started from, landing a key view in the body at every step,
 * and the host must say the body held the keyboard at every step. Which
 * stops a lap holds is the engine's to say (it skips a stop that is not
 * rendered when the step is taken), so the laps are noted, not compared.
 *
 * @foreground
 * @covers tugdeck/src/lib/focus-walk-edge.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { bodyOf, focusBody, pollFor, spawnStub, waitForBody } from "./_bodies";

const TEST_NAME = "body-grounding-row-23-tab-edge";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const A = "r23-a";
/** The most steps a lap is read for: well past any card's stop count. */
const MAX_STEPS = 24;

/** In the body: the key view's id, by the focusable or responder it marks. */
const KEY_VIEW = `(function () {
  var el = document.querySelector("[data-key-view]");
  if (el === null) return null;
  return el.getAttribute("data-tug-focusable") || el.getAttribute("data-responder-id") || el.tagName;
})()`;

interface Step {
  id: string | null;
  bodyHolds: boolean;
}

interface Lap {
  label: string;
  steps: Step[];
  /** The stops from the first up to the one before its return; empty if it never came round. */
  cycle: string[];
}

/**
 * Take steps with `press` until the first stop comes round again, reading
 * after each where the body's key view went and who holds the keyboard.
 */
async function lap(app: App, label: string, press: () => Promise<void>): Promise<Lap> {
  const body = app.body(A);
  const steps: Step[] = [];
  let at: string | null = await body.evalJS<string | null>(KEY_VIEW);
  for (let i = 0; i < MAX_STEPS; i++) {
    await press();
    const id = await pollFor(() => body.evalJS<string | null>(KEY_VIEW), (v) => v !== null && v !== at, 1_500);
    const holder = await bodyOf(app, A);
    steps.push({ id, bodyHolds: holder?.firstResponder === true });
    at = id;
    if (steps.length > 1 && id === steps[0].id) break;
  }
  const ids = steps.map((s) => s.id);
  const back = ids.indexOf(ids[0], 1);
  const result = { label, steps, cycle: back === -1 ? [] : (ids.slice(0, back) as string[]) };
  note(`${label}: ${JSON.stringify(steps)}`);
  return result;
}

function expectRound(result: Lap): void {
  const { label, steps, cycle } = result;
  expect(steps.every((s) => s.id !== null), `${label}: every step lands a key view in the body`).toBe(true);
  expect(cycle.length, `${label}: the lap passes the edge and comes back round to its first stop`).toBeGreaterThan(1);
  expect(steps.every((s) => s.bodyHolds), `${label}: the body holds the keyboard at every step`).toBe(true);
}

const menu = (app: App, item: string) => async (): Promise<void> => {
  const done = await app.performMenuItem(item);
  expect(done.found && done.enabled && done.performed, `${item} is found, enabled and performed`).toBe(true);
};

describe.skipIf(!SHOULD_RUN)("body-grounding row 23: a body card's walk crosses its edge and comes back", () => {
  test(
    "the View menu and Tab walk a body's stops round both ways, the body holding the keyboard",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({
          state: {
            cards: [{ id: A, componentId: "session", title: "A", closable: true }],
            panes: [
              {
                id: `${A}-pane`,
                position: { x: 40, y: 40 },
                size: { width: 900, height: 720 },
                cardIds: [A],
                activeCardId: A,
                title: "",
                acceptsFamilies: ["maker"],
              },
            ],
            activePaneId: `${A}-pane`,
            hasFocus: true,
          },
          focusCardId: A,
        });
        await spawnStub(app, A, stubDir, 2);
        await waitForBody(app, A);
        await focusBody(app, A);

        expectRound(await lap(app, "View › Next Keyboard Focus", menu(app, "view.nextKeyboardFocus")));
        expectRound(await lap(app, "View › Previous Keyboard Focus", menu(app, "view.previousKeyboardFocus")));
        // The ring is on a stop now, not in a text surface, so Tab walks.
        expectRound(await lap(app, "Tab", () => app.nativeKey("Tab")));
        expectRound(await lap(app, "⇧Tab", () => app.nativeKey("Tab", ["shift"])));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
