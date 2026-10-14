/**
 * row-10-workspace.test.ts — a workspace switch hides every departing body
 * and shows every arriving one, each in its own place.
 *
 * The bar's tenth row ([B02] row 10). Two body session cards stand in the
 * home workspace; a second workspace, made through the deck's own verb,
 * holds a third, opened by ⌘N through the session tap and bound to a stub.
 * Switching between the two through `activate-space` — the verb the Window
 * menu and the Cards card send — parks the departing deck as a hidden layer
 * and shows the arriving one in a single commit. The placer hides every
 * departing body at that commit (`layerShown`), lids every arriving card
 * until the host has shown its body at the land's measurement, and the
 * host places each arriving body on its own placeholder.
 *
 * What the row forbids is a body in the wrong place: across the switch the
 * host is polled as fast as it answers, and every body it reports visible
 * stands on its own card's placeholder in its own workspace, within a
 * pixel or two; the window's composite shows no bare hole on any frame;
 * and the shell's own record has the arriving card's lid on from the first
 * frame its placeholder has a box until the host has shown it.
 *
 * @foreground
 * @covers tugdeck/src/lib/body-placement.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import type { BodyViewSnapshot, CaptureBurstReading } from "../_harness/client";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, pollFor, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { classifyFrame, showsBareHole } from "./_frames";
import {
  BURST_INTERVAL_MS,
  REST_TOLERANCE_PX,
  armSampler,
  edgeGap,
  expectAtRest,
  expectHidden,
  placeholderOf,
  readSampler,
  readStanding,
  rectOf,
  type Rect,
} from "./_motion";

const TEST_NAME = "body-grounding-row-10-workspace";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const A = "row10-a";
const B = "row10-b";
const BURST_MS = 2_500;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: B, componentId: "session", title: "B", closable: true },
    ],
    panes: [sessionPane(A, 0), sessionPane(B, 1)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "two-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}




interface HostSample {
  wall: number;
  bodies: { cardId: string | null; visible: boolean; frame: Rect }[];
}

/** Poll the host's bodies as fast as it answers for `ms`. */
async function pollHost(app: App, ms: number): Promise<HostSample[]> {
  const samples: HostSample[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const bodies: BodyViewSnapshot[] = await app.bodies();
    samples.push({ wall: Date.now(), bodies: bodies.map((b) => ({ cardId: b.cardId, visible: b.visible, frame: b.frame })) });
  }
  return samples;
}

interface Switch {
  label: string;
  toSpaceId: string;
  arriving: string[];
  departing: string[];
  /** The card whose lid the shell's sampler watches. */
  watch: string;
}

async function switchLeg(app: App, leg: Switch, places: Map<string, Rect>, crop: Rect, palette: Awaited<ReturnType<typeof readStanding>>["palette"]): Promise<void> {
  await armSampler(app, leg.watch);
  const armed = (await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop })) as { armed: true };
  expect(armed.armed, `${leg.label}: the burst armed`).toBe(true);
  const gestureWall = Date.now();
  await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(leg.toSpaceId)} }), null)`);
  const host = await pollHost(app, 1_500);
  expect(await app.evalJS<string>(ACTIVE_SPACE), `${leg.label}: the workspace is shown`).toBe(leg.toSpaceId);

  // ---- At rest: departing hidden, arriving shown, each where its placeholder now stands ----
  for (const id of leg.departing) await expectHidden(app, id, `${leg.label}: ${id} departed`);
  const landed = new Map<string, Rect>();
  for (const id of leg.arriving) {
    await pollFor(() => app.evalJS<boolean>(`document.querySelector(${JSON.stringify(placeholderOf(id))})?.hasAttribute("data-body-shown") ?? false`), (v) => v, 5_000);
    landed.set(id, await expectAtRest(app, id, `${leg.label}: ${id} arrived`));
  }

  // ---- The host's record: every visible body on its own placeholder ----
  // A departing body's place is the one it held before the switch; an
  // arriving body's is where its placeholder stands after it — the arriving
  // deck is solved against the window as it is now, and may have moved.
  let visibleSamples = 0;
  const misplaced: string[] = [];
  for (const s of host) {
    for (const b of s.bodies) {
      if (!b.visible || b.cardId === null) continue;
      visibleSamples += 1;
      const place = landed.get(b.cardId) ?? places.get(b.cardId);
      if (place === undefined || edgeGap(place, b.frame) > REST_TOLERANCE_PX) misplaced.push(`${b.cardId} at ${JSON.stringify(b.frame)} (${s.wall - gestureWall} ms)`);
    }
  }
  note(`${leg.label}: ${host.length} host samples over the switch, ${visibleSamples} visible-body readings, ${misplaced.length} off their placeholder${misplaced.length > 0 ? `: ${misplaced.slice(0, 5).join("; ")}` : ""}`);
  expect(host.length, `${leg.label}: the host was sampled across the switch`).toBeGreaterThan(5);
  expect(misplaced, `${leg.label}: no body the host shows stands anywhere but on its own card's placeholder`).toEqual([]);
  for (const [id, rect] of landed) places.set(id, rect);

  // ---- The shell's record: the arriving card's placeholder has a box, and the lid lifts only once ----
  const samples = await readSampler(app);
  const withBox = samples.filter((s) => s.placeholder !== null && s.placeholder.width > 0 && s.placeholder.height > 0);
  const firstShown = withBox.findIndex((s) => s.shown);
  const liftedThenOn = withBox.some((s, i) => i > firstShown && firstShown >= 0 && !s.shown);
  note(`${leg.label}: ${samples.length} shell samples of ${leg.watch}, ${withBox.length} with a box, lid on for the first ${firstShown < 0 ? withBox.length : firstShown} of those (the host can show a ready body before the shell's first frame paints)`);
  expect(withBox.length, `${leg.label}: ${leg.watch}'s placeholder had a box after the switch`).toBeGreaterThan(0);
  expect(liftedThenOn, `${leg.label}: once ${leg.watch}'s lid lifts it stays lifted`).toBe(false);

  // ---- The composite: no bare hole on any frame ----
  const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, BURST_MS + 5_000);
  expect(reading.done, `${leg.label}: the burst finished`).toBe(true);
  const bare = reading.frames.filter((f) => f.wall >= gestureWall && showsBareHole(classifyFrame(f, palette)));
  note(`${leg.label}: ${reading.frames.length} frames captured, ${bare.length} show a bare hole`);
  expect(reading.frames.length, `${leg.label}: frames were captured across the switch`).toBeGreaterThan(10);
  expect(bare.length, `${leg.label}: no frame shows the bare window through an open hole`).toBe(0);
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 10: workspace switch", () => {
  test(
    "every departing body hides and every arriving body shows on its own placeholder, with no frame of a body in the wrong place",
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
        await spawnStub(app, B, stubDir, 2);
        await waitForBody(app, A);
        await waitForBody(app, B);
        await focusBody(app, A);
        await Bun.sleep(400);
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        const places = new Map<string, Rect>();
        places.set(A, await expectAtRest(app, A, "A at home"));
        places.set(B, await expectAtRest(app, B, "B at home"));
        const standing = await readStanding(app, A, places.get(A)!);
        const crop = { x: 0, y: 0, width: standing.contentWidth, height: Math.ceil(Math.max(...[...places.values()].map((r) => r.y + r.height))) + 16 };

        // ---- The away workspace, with a body card of its own ----
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 10_000);
        const away = await app.evalJS<string>(ACTIVE_SPACE);
        expect(away, "a second workspace is shown").not.toBe(home);
        await expectHidden(app, A, "A after leaving home");
        await expectHidden(app, B, "B after leaving home");
        // The verb reveals the Cards card and opens a rename; Escape leaves it.
        await app.nativeKey("Escape", []);
        await Bun.sleep(300);
        const focusedBefore = await app.getFocusedCardId();
        await app.nativeKey("n", ["cmd"]);
        const C = (await pollFor(() => app.getFocusedCardId(), (c) => c !== null && c !== focusedBefore && c !== A && c !== B, 10_000))!;
        expect(C, "⌘N opened a card in the away workspace and the deck focused it").not.toBe(focusedBefore);
        await pollFor(
          () => app.evalJS<boolean>(`document.querySelector('[data-imposer-settling]') === null && document.querySelector('.tug-pane[data-arriving]') === null`),
          (v) => v,
          5_000,
        );
        await Bun.sleep(400);
        note(`away cards ${JSON.stringify(await app.evalJS<unknown>("window.tugdeck.diag.getDeckState().cards.map(function (c) { return [c.id, c.componentId]; })"))}; bodies ${JSON.stringify((await app.bodies()).map((b) => [b.cardId, b.state, b.visible]))}`);
        await spawnStub(app, C, stubDir, 2);
        await waitForBody(app, C);
        await focusBody(app, C);
        await Bun.sleep(400);
        places.set(C, await expectAtRest(app, C, "C away"));
        note(`home ${home}: A ${JSON.stringify(places.get(A))}, B ${JSON.stringify(places.get(B))}; away ${away}: C ${JSON.stringify(places.get(C))}`);

        await switchLeg(app, { label: "away → home", toSpaceId: home, arriving: [A, B], departing: [C], watch: A }, places, crop, standing.palette);
        await Bun.sleep(600);
        await switchLeg(app, { label: "home → away", toSpaceId: away, arriving: [C], departing: [A, B], watch: C }, places, crop, standing.palette);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
