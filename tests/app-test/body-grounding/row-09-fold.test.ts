/**
 * row-09-fold.test.ts — a fold hides the body and the unfold shows it, with
 * no peek either way.
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
 * (`_motion.ts`), as row 4 reads a slide.
 *
 * @foreground
 * @covers tugdeck/src/lib/body-placement.ts
 * @covers tugdeck/src/lib/card-fold.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, foldedOf, pollFor, spawnStub, waitForBody } from "./_bodies";
import {
  BURST_INTERVAL_MS,
  armSampler,
  expectAtRest,
  expectHidden,
  frameOf,
  judge,
  readSampler,
  readStanding,
  rectOf,
  samplerState,
  type Rect,
  type Standing,
} from "./_motion";

const TEST_NAME = "body-grounding-row-09-fold";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const A = "row09-a";
/** The burst over one gesture: its beats and its land. */
const BURST_MS = 3_000;
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
async function cameToRest(app: App, folded: boolean): Promise<Rect> {
  const rest = await pollFor(
    async () => {
      const state = await samplerState(app);
      const count = state.count;
      const last = await app.evalJS<{ a: Rect; b: Rect } | null>(
        `(function () { var s = window.__bodyMotion.samples; if (s.length < 2) return null; return { a: s[s.length - 1].frame, b: s[s.length - 2].frame }; })()`,
      );
      return { count, still: last !== null && Math.abs(last.a.height - last.b.height) <= 0.5 && Math.abs(last.a.width - last.b.width) <= 0.5, folded: await foldedOf(app, A), settling: state.now };
    },
    (r) => r.count > 5 && r.still && r.folded === folded && !r.settling,
    SETTLE_MS,
  );
  expect(rest.folded, `the card reads folded=${folded}`).toBe(folded);
  return (await rectOf(app, frameOf(A)))!;
}

async function foldLeg(app: App, label: string, toFolded: boolean, standing: Standing, crop: Rect, keep: string): Promise<void> {
  const before = (await rectOf(app, frameOf(A)))!;
  await armSampler(app, A);
  const armed = (await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop })) as { armed: true };
  expect(armed.armed, `${label}: the burst armed`).toBe(true);
  const gestureWall = Date.now();
  await app.nativeKey("y", ["ctrl", "cmd"]);
  const after = await cameToRest(app, toFolded);
  note(`${label}: frame ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  expect(Math.abs(after.height - before.height), `${label}: the gesture changed the frame's height`).toBeGreaterThan(40);
  if (toFolded) await expectHidden(app, A, `${label}: at the land`);
  else {
    await pollFor(() => app.evalJS<boolean>(`document.querySelector(${JSON.stringify(`${frameOf(A)} [data-body-placeholder]`)})?.hasAttribute("data-body-shown") ?? false`), (v) => v, 5_000);
    await Bun.sleep(400);
    await expectAtRest(app, A, `${label}: at the land`);
  }
  const samples = await readSampler(app);
  const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, BURST_MS + 5_000);
  expect(reading.done, `${label}: the burst finished`).toBe(true);
  const verdict = judge(label, reading, samples, gestureWall, before, after, standing.palette, crop);
  const worst = verdict.motion.length > 0 ? verdict.motion.reduce((a, b) => (b.frame.surface < a.frame.surface ? b : a)) : verdict.judged[verdict.judged.length - 1];
  if (worst !== undefined) copyFileSync(worst.path, join(keep, `${label.replace(/\s+/g, "-")}-worst-${Math.round(worst.frame.t)}ms.png`));
  expect(verdict.judged.length, `${label}: frames were captured across the gesture`).toBeGreaterThan(10);
  expect(verdict.movingSamples, `${label}: the sampler saw the frame move`).toBeGreaterThan(2);
  expect(verdict.shownWhileMoving, `${label}: the lid is on in every sample where the frame moved`).toBe(0);
  expect(verdict.bare.length, `${label}: no frame shows the bare window through a hole the body left behind`).toBe(0);
  expect(verdict.motion.length, `${label}: frames were captured while the chrome moved`).toBeGreaterThan(2);
  expect(verdict.offenders.length, `${label}: on every frame where the chrome moves the content box is the lid`).toBe(0);
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 9: fold", () => {
  test(
    "the fold hides the body at its commit and the unfold shows it only at the land, with no peek",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        await spawnStub(app, A, stubDir, 2);
        await waitForBody(app, A);
        await focusBody(app, A);
        await Bun.sleep(400);
        const start = await expectAtRest(app, A, "at the start");
        const standing = await readStanding(app, A, start);
        const frame = (await rectOf(app, frameOf(A)))!;
        const crop = { x: 0, y: Math.max(0, Math.floor(frame.y) - 8), width: standing.contentWidth, height: Math.ceil(frame.height) + 16 };
        const keep = join(tmpdir(), `tug-row09-${Date.now()}`);
        mkdirSync(keep, { recursive: true });
        note(`crop ${JSON.stringify(crop)} at scale ${standing.scale}; frames kept at ${keep}`);

        await foldLeg(app, "fold", true, standing, crop, keep);
        await Bun.sleep(600);
        await foldLeg(app, "unfold", false, standing, crop, keep);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
