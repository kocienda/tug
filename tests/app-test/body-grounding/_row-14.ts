/**
 * _row-14.ts — what the pieces of row 14 share: a gesture that only moves its
 * frames carries the bodies in them with the chrome, on the host.
 *
 * The bar's fourteenth row. A settle that moves body cards without
 * changing their size posts the host a beat plan — each body's rect at the
 * start and end of each beat, the curve the chrome beat was built from, and
 * the settle's start on the clock both sides read — and the host runs each
 * body's container as Core Animation on it (`lib/body-beat-plan.ts`,
 * `BodyViewController.runPlan`). Both of the settle's planning sites are
 * driven: the flow strip's prelaunched slide (Go to slot, out and back, in
 * a four-up flow band holding two body cards) and the Last pass's move
 * beat (a cross-column stack move in a two-up).
 *
 * On each gesture (`_motion.ts`'s `carryLeg`): the placer planned every body
 * card the gesture moved; on every composited frame where the chrome moves
 * the shell's record has the lid lifted, the body's content box shows no
 * more floor than two frames of travel would uncover, and no frame shows the
 * bare window; the host's presented container stands within two frames of
 * travel of the placeholder on every reading taken while the chrome moved;
 * the host's display link sees the container's presentation advance on at
 * least 95 % of its ticks across the span it moved; the host says the body
 * landed; and at rest the container — presented and placed — stands on the
 * placeholder to the pixel.
 *
 * A gesture that also changes a body's size is a crossing and is not this
 * row's: ⌘N's neighbours ride a fused beat carrying their sizes, and the
 * crossing is read in row 17.
 *
 * Every other kind that is a body is carried the same way by the gesture
 * that only moves it: a content card by the flow slide out and back, and a
 * pinned rail by moving it to the other edge and back, which keeps its size.
 *
 * One launch per gesture: `row-14-beats-move-<gesture>` for the Session
 * card, `row-14-beats-move-kinds-<out|back>` for every other kind; a piece
 * that reads the way back makes the way out as its set-up.
 */

import { launchTugApp, type App } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { floorMeasure } from "./_frames";
import { kindDeck, standUpKind } from "./_kind-bodies";
import type { CardKind } from "./_kinds";
import { standUp, type Rect, type Standing } from "./_motion";

const TEST_NAME = "body-grounding-row-14-beats-move";
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

/**
 * How a piece launches, stated in the piece itself: every row-14 launch
 * takes the screen, and `@foreground` is read off the file that says so.
 */
export interface Launch {
  foreground: boolean;
}

/** A launch's body card, its standing palette and the crop every leg's burst reads. */
export interface Stood {
  app: App;
  card: string;
  standing: Standing;
  crop: Rect;
}

/** A deck action, as the page expression `carryLeg` evaluates. */
export const action = (id: string, payload: Record<string, unknown>): string =>
  `window.__tug.dispatchControlAction(${JSON.stringify(id)}, ${JSON.stringify(payload)})`;

/** The way out and the way back for a kind: a rail to the left edge and back, a content card to slot 2 and back. */
export function kindLegs(kind: CardKind): { out: { label: string; js: string }; back: { label: string; js: string } } {
  return kind.rail
    ? {
        out: { label: "to the left edge", js: action("set-sidebar-side", { componentId: kind.componentId, side: "left" }) },
        back: { label: "to the right edge", js: action("set-sidebar-side", { componentId: kind.componentId, side: "right" }) },
      }
    : {
        out: { label: "go to slot 2", js: action("go-to-slot", { value: 2 }) },
        back: { label: "go to slot 1", js: action("go-to-slot", { value: 1 }) },
      };
}

/** Launch with a body of `kind` stood up and focused among five Session cards, and run `legs`. */
export async function withKind(launch: Launch, kind: CardKind, name: string, legs: (at: Stood) => Promise<void>): Promise<void> {
  const card = `r14-${kind.componentId}`;
  const app = await launchTugApp({ testName: `${TEST_NAME}-${name}-${kind.componentId}`, ...launch, bodies: true });
  try {
    await app.seedDeckState({ state: kindDeck(kind, card, { sessions: ["r14-n0", "r14-n1", "r14-n2", "r14-n3", "r14-n4"] }), focusCardId: card });
    await standUpKind(app, kind, card);
    await app.dispatchControlAction("focus-session-card", { cardId: card });
    await Bun.sleep(400);
    const { standing, crop } = await standUp(app, card, floorMeasure(kind.rail));
    await legs({ app, card, standing, crop });
  } finally {
    await app.close();
  }
}

/** The two body cards of the flow pieces, in slots 1 and 2. */
export const FLOW_BODIES = ["r14-a", "r14-b"] as const;

/** Six session cards in a four-up flow, body cards in slots 1 and 2. */
function flowDeck(bodies: readonly string[]): Record<string, unknown> {
  const ids = ["r14-n0", bodies[0], bodies[1], "r14-n3", "r14-n4", "r14-n5"];
  return {
    cards: ids.map((id) => ({ id, componentId: "session", title: id, closable: true })),
    panes: ids.map((id, slot) => sessionPane(id, slot)),
    activePaneId: `${bodies[0]}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

/** Launch with the flow deck's two Session bodies bound, the first focused, and run `legs` on it. */
export async function withFlow(launch: Launch, name: string, legs: (at: Stood) => Promise<void>): Promise<void> {
  const stubDir = stubDirectory();
  const app = await launchTugApp({ testName: `${TEST_NAME}-${name}`, ...launch, bodies: true, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
  try {
    await app.seedDeckState({ state: flowDeck(FLOW_BODIES), focusCardId: FLOW_BODIES[0] });
    for (const id of FLOW_BODIES) await spawnStub(app, id, stubDir, 2);
    for (const id of FLOW_BODIES) await waitForBody(app, id);
    await focusBody(app, FLOW_BODIES[0], { composer: false });
    await Bun.sleep(400);
    const { standing, crop } = await standUp(app, FLOW_BODIES[0]);
    await legs({ app, card: FLOW_BODIES[0], standing, crop });
  } finally {
    await app.close();
  }
}
