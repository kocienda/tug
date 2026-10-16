/**
 * row-34-phase-elsewhere.test.ts — a Layout body shows the live dot of a
 * session mid-turn in another body.
 *
 * A page builds a session store only for the card it shows, so the Layout
 * body has no store for the Session card it lists. Its phase reaches the
 * body through the arrangement instead: the Session card's body reports its
 * phase to the shell, the shell projects it into the Layout card's context
 * as `activities`, and the body's phase readers answer from that mirror. The
 * look here: with the Session card streaming, the Layout miniature's hover
 * over that card's slot reads Streaming with a running dot, never Idle.
 *
 * @foreground
 * @covers tugdeck/src/lib/body-arrangement.ts
 * @covers tugdeck/src/lib/card-activity-elsewhere.ts
 * @covers tugdeck/src/lib/code-session-store/use-session-phase.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { pollFor, promptPhase, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { standUpKind } from "./_kind-bodies";
import { cardKind } from "./_kinds";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const READ_MS = 8_000;

const A = "r34-a";
const LAYOUT = "r34-layout";
/** The miniature's hover target for the Session card's slot, and its bubble. */
const TARGET = '[data-testid="layout-card-target-block-0"]';
const TIP = '[data-slot="tug-tooltip"] .layout-tip-phase';

function layoutDeck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: LAYOUT, componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      sessionPane(A, 0),
      { id: `${LAYOUT}-pane`, position: { x: 0, y: 0 }, size: { width: 420, height: 900 }, cardIds: [LAYOUT], activeCardId: LAYOUT, title: "", acceptsFamilies: [] },
    ],
    activePaneId: `${A}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: { layout: { side: "right" } } },
    hasFocus: true,
  };
}

/** In the Layout body: arm the hover over the Session card's slot, as the hand would. */
const HOVER_TARGET = `(function () {
  var el = document.querySelector(${JSON.stringify(TARGET)});
  if (el === null) return false;
  el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
  el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
  return true;
})()`;

/** In the Layout body: the open bubble's phase label and its dot's state, or null while no bubble is up. */
const READ_TIP = `(function () {
  var row = document.querySelector(${JSON.stringify(TIP)});
  if (row === null) return null;
  var dot = row.querySelector('[data-slot="tug-progress-indicator"]');
  var label = Array.prototype.filter.call(row.querySelectorAll("span"), function (s) { return s.children.length === 0; })
    .map(function (s) { return s.textContent || ""; })
    .find(function (t) { return t.length > 0; }) || "";
  return { label: label, state: dot === null ? null : dot.getAttribute("data-state"), role: dot === null ? null : dot.getAttribute("data-role") };
})()`;

describe.skipIf(!SHOULD_RUN)("body-grounding row 34: a session's phase reaches the Layout body", () => {
  test(
    "the Layout miniature's hover over a streaming Session card reads Streaming with a running dot",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "body-grounding-row-34-phase-elsewhere", foreground: true, bodies: true, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: layoutDeck(), focusCardId: A });
        // A long stub turn, so the session is still mid-turn when the look is taken.
        await spawnStub(app, A, stubDir, 40, 1);
        await waitForBody(app, A);
        const layout = await standUpKind(app, cardKind("layout"), LAYOUT);

        await app.body(A).driveSession({ op: "send", text: "Walk the module and report each pass." });
        await app.body(A).waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: 30_000 });

        const armed = await pollFor(() => layout.evalJS<boolean>(HOVER_TARGET), (v) => v, READ_MS);
        expect(armed, "the miniature draws the Session card's slot in the Layout body").toBe(true);
        const tip = await pollFor(
          () => layout.evalJS<{ label: string; state: string | null; role: string | null } | null>(READ_TIP),
          (t) => t !== null && t.label !== "",
          READ_MS,
        );
        note(`layout hover over the streaming card: ${JSON.stringify(tip)}`);
        expect(tip?.label, "the Layout body reads the session's phase, not idle").toBe("Streaming");
        expect(tip?.state, "the dot runs for a session mid-turn elsewhere").toBe("running");
        expect(tip?.role).toBe("action");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
