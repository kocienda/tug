/**
 * _row-09.ts — what the pieces of row 9 share: a fold hides the body and the
 * unfold shows it, with no peek either way — or, for a kind that draws its
 * own folded form, the host carries the body between its open box and its
 * folded strip, with no peek either way.
 *
 * The bar's ninth row ([B02] row 9). A body session card stands in a pane
 * and is folded and unfolded through the session tap (⌃⌘Y, [B04]). The
 * fold's commit hides the body with the rect it had — the hole closes and
 * the lid goes on in the frame the chrome starts to close — so on every
 * frame where the frame's edges move, what is left of the content box
 * inside the closing frame is the lid, never the body standing still under
 * it and never the floor through a hole; and at the land the host has the
 * body hidden. The unfold the same way in reverse: the lid stays on while
 * the chrome opens, the host shows the painted body at the land under the
 * lid, and the lid lifts only on `shown`, so no frame shows the body before
 * its chrome has arrived.
 *
 * Read by the window's composite and the shell's own record together
 * (`_motion.ts`).
 *
 * Every other kind that is a body is folded and unfolded the same way, the
 * chord read by whichever card holds the keyboard.
 *
 * The Session card draws its own folded form (`ownsFoldedForm`): its Z2 band,
 * which carries a compaction's Cancel and a deferred permission's Unfold, is
 * in its body. So its body is not hidden by the fold ([B22] of the bodies
 * migration brief reverses this row's hide for such a kind): the host carries
 * it with the frame as it carries a slide (row 17's judge), the lid stays
 * lifted, and at each land it stands on its placeholder — the folded strip,
 * or the open box.
 *
 * One launch per leg: `row-09-fold-fold` reads the fold, `row-09-fold-unfold`
 * folds as its unmeasured set-up and reads the unfold. A rail does not fold,
 * so of the default kinds only the Session card runs; another content kind
 * runs when `TUG_BODY_KINDS` names it.
 */

import { expect } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, foldedOf, pollFor, responders, spawnStub, waitForBody } from "./_bodies";
import { floorMeasure } from "./_frames";
import { kindDeck, standUpKind } from "./_kind-bodies";
import type { CardKind } from "./_kinds";
import {
  BURST_INTERVAL_MS,
  armSampler,
  expectAtRest,
  expectHidden,
  frameOf,
  hostShows,
  judge,
  judgeCarried,
  pollPresented,
  readSampler,
  readStanding,
  planDiag,
  rectOf,
  samplerState,
  type Rect,
  type Standing,
} from "./_motion";

const TEST_NAME = "body-grounding-row-09-fold";
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

/**
 * How a piece launches, stated in the piece itself: every row-9 launch takes
 * the screen, and `@foreground` is read off the file that says so.
 */
export interface Launch {
  foreground: boolean;
}

const A = "row09-a";
/** The burst over one gesture: its beats and its land. */
const BURST_MS = 1_500;

/** Which gesture a piece reads: the fold, or the unfold after an unmeasured fold. */
export type Leg = "fold" | "unfold";
/** How long the fold may take to be seen moving and to come to rest. */
const SETTLE_MS = 6_000;

function deck(): Record<string, unknown> {
  return {
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
  };
}

/** The frame's rect has held still for two samples in a row, and the fold reads `folded`. */
async function cameToRest(app: App, card: string, folded: boolean): Promise<Rect> {
  const rest = await pollFor(
    async () => {
      const state = await samplerState(app);
      const count = state.count;
      // card-dom: shell — the sampler runs in the shell.
      const last = await app.evalJS<{ a: Rect; b: Rect } | null>(
        `(function () { var s = window.__bodyMotion.samples; if (s.length < 2) return null; return { a: s[s.length - 1].frame, b: s[s.length - 2].frame }; })()`,
      );
      return { count, still: last !== null && Math.abs(last.a.height - last.b.height) <= 0.5 && Math.abs(last.a.width - last.b.width) <= 0.5, folded: await foldedOf(app, card), settling: state.now };
    },
    (r) => r.count > 5 && r.still && r.folded === folded && !r.settling,
    SETTLE_MS,
  );
  expect(rest.folded, `the card reads folded=${folded}`).toBe(folded);
  return (await rectOf(app, frameOf(card)))!;
}

async function foldLeg(app: App, card: string, label: string, toFolded: boolean, standing: Standing, crop: Rect, keep: string, carried: boolean): Promise<void> {
  const before = (await rectOf(app, frameOf(card)))!;
  const boxBefore = carried ? await expectAtRest(app, card, `${label}: before`) : null;
  const runsBefore = (await planDiag(app)).runs;
  await armSampler(app, card);
  const armed = (await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop })) as { armed: true };
  expect(armed.armed, `${label}: the burst armed`).toBe(true);
  const gestureWall = Date.now();
  await app.nativeKey("y", ["ctrl", "cmd"]);
  let polling = carried;
  const presentedRead = carried ? pollPresented(app, card, () => !polling, SETTLE_MS + 2_000) : Promise.resolve([]);
  const after = await cameToRest(app, card, toFolded);
  polling = false;
  const presented = await presentedRead;
  note(`${label}: frame ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  expect(Math.abs(after.height - before.height), `${label}: the gesture changed the frame's height`).toBeGreaterThan(40);
  if (carried) {
    await hostShows(app, card);
    await Bun.sleep(400);
  } else if (toFolded) await expectHidden(app, card, `${label}: at the land`);
  else {
    await hostShows(app, card);
    await Bun.sleep(400);
    await expectAtRest(app, card, `${label}: at the land`);
  }
  const samples = await readSampler(app);
  const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, BURST_MS + 5_000);
  expect(reading.done, `${label}: the burst finished`).toBe(true);
  if (carried) {
    const boxAfter = await expectAtRest(app, card, `${label}: at the land`);
    const plan = await pollFor(
      () => planDiag(app),
      (p) => p.runs > runsBefore && (p.last?.landed.some((l) => l.cardId === card) ?? false),
      3_000,
    );
    note(`${label}: ${plan.runs - runsBefore} plan run(s); last plan ${JSON.stringify(plan.last)}`);
    expect(plan.last?.landed.some((l) => l.cardId === card) ?? false, `${label}: the host carried the body and landed it`).toBe(true);
    const v = judgeCarried(label, reading, samples, presented, gestureWall, boxBefore!, boxAfter, standing.palette, crop);
    expect(v.motion, `${label}: frames were captured while the chrome moved`).toBeGreaterThan(2);
    expect(v.lidOnWhileMoving, `${label}: the card stays posted shown in every sample where the frame moved`).toBe(0);
    expect(v.bare, `${label}: no frame shows the bare window`).toBe(0);
    expect(v.floorOffenders.length, `${label}: on every frame where the chrome moves the body fills its content box`).toBe(0);
    expect(v.tracked, `${label}: the host was read while the chrome moved`).toBeGreaterThan(0);
    expect(v.worstTrackPx, `${label}: the host's container stands within two frames of travel of the placeholder`).toBeLessThanOrEqual(v.trackBarPx);
    return;
  }
  const verdict = judge(label, reading, samples, gestureWall, before, after, standing.palette, crop);
  const plan = await planDiag(app);
  note(`${label}: ${plan.runs - runsBefore} plan run(s); last plan ${JSON.stringify(plan.last)}`);
  const worst = verdict.motion.length > 0 ? verdict.motion.reduce((a, b) => (b.frame.surface < a.frame.surface ? b : a)) : verdict.judged[verdict.judged.length - 1];
  if (worst !== undefined) copyFileSync(worst.path, join(keep, `${label.replace(/\s+/g, "-")}-worst-${Math.round(worst.frame.t)}ms.png`));
  expect(verdict.judged.length, `${label}: frames were captured across the gesture`).toBeGreaterThan(10);
  expect(verdict.movingSamples, `${label}: the sampler saw the frame move`).toBeGreaterThan(2);
  expect(verdict.shownWhileMoving, `${label}: the card is posted hidden in every sample where the frame moved`).toBe(0);
  expect(verdict.bare.length, `${label}: no frame shows the bare window through a hole the body left behind`).toBe(0);
  expect(verdict.motion.length, `${label}: frames were captured while the chrome moved`).toBeGreaterThan(2);
  expect(verdict.offenders.length, `${label}: on every frame where the chrome moves the content box is the lid`).toBe(0);
}

/**
 * Read `leg` on one card already at rest with the keyboard. The unfold
 * folds first, unmeasured, and the crop is the open frame's either way.
 */
async function readLeg(app: App, card: string, leg: Leg, standing: Standing, keep: string, carried: boolean): Promise<void> {
  const frame = (await rectOf(app, frameOf(card)))!;
  const crop = { x: 0, y: Math.max(0, Math.floor(frame.y) - 8), width: standing.contentWidth, height: Math.ceil(frame.height) + 16 };
  mkdirSync(keep, { recursive: true });
  note(`crop ${JSON.stringify(crop)} at scale ${standing.scale}; frames kept at ${keep}`);
  if (leg === "fold") {
    await foldLeg(app, card, "fold", true, standing, crop, keep, carried);
    return;
  }
  await armSampler(app, card);
  await app.nativeKey("y", ["ctrl", "cmd"]);
  await cameToRest(app, card, true);
  await Bun.sleep(600);
  note(`fold (set-up) landed; before the unfold: focused card ${await app.getFocusedCardId()}; host ${await responders(app)}`);
  await foldLeg(app, card, "unfold", false, standing, crop, keep, carried);
}

/** Every other kind: a card of `kind` folded or unfolded by the chord it reads. */
export async function foldKind(launch: Launch, kind: CardKind, leg: Leg): Promise<void> {
  const card = `row09-${kind.componentId}`;
  const app = await launchTugApp({ testName: `${TEST_NAME}-${leg}-${kind.componentId}`, foreground: launch.foreground });
  try {
    await app.seedDeckState({ state: kindDeck(kind, card, { sessions: ["row09-seed"] }), focusCardId: card });
    await standUpKind(app, kind, card);
    await app.dispatchControlAction("focus-session-card", { cardId: card });
    await Bun.sleep(400);
    const start = await expectAtRest(app, card, "at the start");
    const standing = await readStanding(app, card, start, floorMeasure(kind.rail));
    await readLeg(app, card, leg, standing, join(tmpdir(), `tug-row09-${leg}-${kind.componentId}-${Date.now()}`), false);
  } finally {
    await app.close();
  }
}

/** The Session card, bound to a stub session, folded or unfolded. */
export async function foldSession(launch: Launch, leg: Leg): Promise<void> {
  const stubDir = stubDirectory();
  const app = await launchTugApp({
    testName: `${TEST_NAME}-${leg}`,
    foreground: launch.foreground,
    env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
  });
  try {
    await app.seedDeckState({ state: deck(), focusCardId: A });
    await spawnStub(app, A, stubDir, 2);
    await waitForBody(app, A);
    await focusBody(app, A);
    await Bun.sleep(400);
    const start = await expectAtRest(app, A, "at the start");
    const standing = await readStanding(app, A, start);
    await readLeg(app, A, leg, standing, join(tmpdir(), `tug-row09-${leg}-${Date.now()}`), true);
  } finally {
    await app.close();
  }
}
