/**
 * _row-10.ts — what the pieces of row 10 share: a workspace switch hides
 * every departing body and shows every arriving one, each in its own place.
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
 * And what is revealed is a finished picture: a body that had painted
 * before the switch never shows its content box surface-blank on a frame
 * the host shows its view (`_row-44.ts`'s `blankAgainst`) — a dormant body
 * keeps what it had — and the first frame after the host shows each
 * arriving view is noted, for what an unhide puts on screen.
 *
 * Every other kind that is a body is switched the same way: a card of the
 * kind at home, and one of the kind in the second workspace — the one the
 * workspace was made with, for a rail, or opened there — each body hidden as
 * its workspace departs and shown on its own placeholder as it arrives.
 *
 * One launch per switch: `row-10-workspace-session-home` reads the switch
 * from the away workspace home, `row-10-workspace-session-away` makes that
 * switch as its set-up and reads the one back; `row-10-workspace-kinds-home`
 * and `-kinds-away` do the same for every other kind. A piece suffixed
 * `-dormant` or `-evicted` puts the hidden bodies in that tier before the
 * read switch (`_tiers.ts`), with the same bars.
 */

import { expect } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import type { BodyViewSnapshot, CaptureBurstReading } from "../_harness/client";
import { decodePngFile } from "../_harness/png";
import { bodyOfKind } from "../_harness/card-reach";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { escapeHasTaker, focusBody, pollFor, settleFor, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { kindDeck, openKind, standUpKind } from "./_kind-bodies";
import type { CardKind } from "./_kinds";
import { classifyFrame, showsBareHole } from "./_frames";
import { blankAgainst, contentOf, inkShare } from "./_row-44";
import { intoTier, type Tier } from "./_tiers";
import {
  BURST_INTERVAL_MS,
  REST_TOLERANCE_PX,
  armSampler,
  edgeGap,
  expectAtRest,
  expectHidden,
  hostShows,
  readSampler,
  regionRectOf,
  viewRectOf,
  readStanding,
  type Rect,
} from "./_motion";

const TEST_NAME = "body-grounding-row-10-workspace";

/**
 * `cardId` at rest on its placeholder (`expectAtRest`), and where the host's
 * view of it stands there: the placeholder, or for a card that draws its own
 * chrome its stand-in outset by the apron. A body is judged against that
 * place at every sample of the switch.
 */
async function restAt(app: App, cardId: string, label: string): Promise<Rect> {
  await expectAtRest(app, cardId, label);
  return (await viewRectOf(app, cardId))!;
}
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

const A = "row10-a";
const B = "row10-b";
/** The burst over one switch: a single commit, so any hole shows in its first few hundred ms. */
const BURST_MS = 1_200;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
/**
 * A body page's frame-by-frame record of its content lid — whether its
 * content box's `::after` stands drawn, by whichever rule draws it — for a
 * second and a half from its first animation frame; a hidden page draws
 * none, so its record starts at its reveal.
 */
const LID_RECORDER = `(function () {
  var log = (window.__row10LidLog = []);
  var start = null;
  function lidded() {
    var box = document.querySelector(".body-chrome-frame .tug-pane-content");
    if (box === null) return false;
    var content = getComputedStyle(box, "::after").content;
    return content !== "none" && content !== "normal" && content !== "";
  }
  function tick() {
    var now = Date.now();
    if (start === null) start = now;
    log.push([now, lidded()]);
    if (now - start < 1500) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return null;
})()`;

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
  /** Every arriving body had painted before the switch, so none may show its content box surface-blank. */
  revealsPainted: boolean;
}

async function switchLeg(app: App, leg: Switch, places: Map<string, Rect>, crop: Rect, palette: Awaited<ReturnType<typeof readStanding>>["palette"]): Promise<void> {
  // Every body standing visible has a place, the cards a workspace was made
  // with (its rails) as much as the ones the row seeded: the host may show a
  // departing body there until the hide reaches it.
  for (const b of await app.bodies()) {
    if (b.cardId === null || !b.visible || places.has(b.cardId)) continue;
    const at = await viewRectOf(app, b.cardId);
    if (at !== null) places.set(b.cardId, at);
  }
  // Each arriving page's own record of its content lid, frame by frame from
  // its first animation frame after the reveal: a lid standing on a shown
  // frame is a surface-blank content box, whatever the capture caught.
  if (leg.revealsPainted) {
    for (const id of leg.arriving) {
      await app.body(id).evalJS<null>(LID_RECORDER).catch(() => null);
    }
  }
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
  const panes = new Map<string, Rect>();
  for (const id of leg.arriving) {
    await hostShows(app, id);
    landed.set(id, await restAt(app, id, `${leg.label}: ${id} arrived`));
    const pane = await regionRectOf(app, id);
    if (pane !== null) panes.set(id, pane);
  }
  // A card the workspace was made with arrives too, at the place its own
  // allocation gives it now.
  for (const b of await app.bodies()) {
    if (b.cardId === null || !b.visible || landed.has(b.cardId)) continue;
    const at = await viewRectOf(app, b.cardId);
    if (at !== null) landed.set(b.cardId, at);
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

  // ---- The shell's record: the arriving card's placeholder has a box, and it is posted shown only once ----
  const samples = await readSampler(app);
  const withBox = samples.filter((s) => s.placeholder !== null && s.placeholder.width > 0 && s.placeholder.height > 0);
  const firstShown = withBox.findIndex((s) => s.shown);
  const liftedThenOn = withBox.some((s, i) => i > firstShown && firstShown >= 0 && !s.shown);
  note(`${leg.label}: ${samples.length} shell samples of ${leg.watch}, ${withBox.length} with a box, posted hidden for the first ${firstShown < 0 ? withBox.length : firstShown} of those (the host can show a ready body before the shell's first frame paints)`);
  expect(withBox.length, `${leg.label}: ${leg.watch}'s placeholder had a box after the switch`).toBeGreaterThan(0);
  expect(liftedThenOn, `${leg.label}: once ${leg.watch} is posted shown it stays shown`).toBe(false);

  // ---- The composite: no bare hole on any frame ----
  const reading = await settleFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, BURST_MS + 5_000);
  expect(reading.done, `${leg.label}: the burst finished`).toBe(true);
  const bare = reading.frames.filter((f) => f.wall >= gestureWall && showsBareHole(classifyFrame(f, palette)));
  note(`${leg.label}: ${reading.frames.length} frames captured, ${bare.length} show a bare hole`);
  expect(reading.frames.length, `${leg.label}: frames were captured across the switch`).toBeGreaterThan(10);
  expect(bare.length, `${leg.label}: no frame shows the bare window through an open hole`).toBe(0);

  // ---- The reveal: a painted body's content is never surface-blank ----
  // A frame shows a card's view when the host's last sample before it did.
  const scale = reading.scale;
  const px = (r: Rect) => ({ x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale });
  const settled = decodePngFile(reading.frames[reading.frames.length - 1].path);
  const pngs = new Map<string, ReturnType<typeof decodePngFile>>();
  const pngOf = (path: string) => pngs.get(path) ?? pngs.set(path, decodePngFile(path)).get(path)!;
  const blankFrames: string[] = [];
  const unhid: string[] = [];
  for (const [id, pane] of panes) {
    const content = px(contentOf(pane));
    const settledInk = inkShare(settled, content);
    let first: string | null = null;
    let blank = 0;
    let low = 1;
    let span: [number, number] | null = null;
    for (const f of reading.frames) {
      if (f.wall < gestureWall) continue;
      const sample = host.filter((s) => s.wall <= f.wall).at(-1);
      if (sample === undefined || !sample.bodies.some((b) => b.cardId === id && b.visible)) continue;
      const ink = inkShare(pngOf(f.path), content);
      const ms = f.wall - gestureWall;
      first ??= `${id} at ${ms} ms: content ink ${(ink * 100).toFixed(2)}% against settled ${(settledInk * 100).toFixed(2)}%`;
      if (blankAgainst(ink, settledInk)) {
        blank += 1;
        low = Math.min(low, ink);
        span = [span?.[0] ?? ms, ms];
      }
    }
    unhid.push(first ?? `${id} never shown in the burst`);
    if (blank > 0 && span !== null) {
      blankFrames.push(`${id} surface-blank in ${blank} frames, ${span[0]}–${span[1]} ms, ink as low as ${(low * 100).toFixed(2)}% against settled ${(settledInk * 100).toFixed(2)}%`);
    }
  }
  note(`${leg.label}: the first frame after the host showed each arriving view — ${unhid.join("; ")}`);
  if (leg.revealsPainted) {
    for (const id of leg.arriving) {
      const log = await app.body(id).evalJS<[number, boolean][] | null>("window.__row10LidLog ?? null").catch(() => null);
      const shownAt = host.find((s) => s.bodies.some((b) => b.cardId === id && b.visible))?.wall ?? Infinity;
      const frames = (log ?? []).filter(([wall]) => wall >= shownAt);
      const lidded = frames.filter(([, lid]) => lid);
      note(
        `${leg.label}: ${id}'s page drew ${frames.length} frames from its reveal, ` +
          (lidded.length === 0 ? "none under its content lid" : `${lidded.length} under its content lid, ${lidded[0][0] - gestureWall}–${lidded[lidded.length - 1][0] - gestureWall} ms`),
      );
      if (lidded.length > 0) blankFrames.push(`${id}'s page drew ${lidded.length} frames under its content lid after its reveal`);
    }
  }
  if (blankFrames.length > 0) note(`${leg.label}: revealed content boxes shown blank: ${blankFrames.join("; ")}`);
  if (leg.revealsPainted) expect(blankFrames, `${leg.label}: no revealed body that had painted shows its content box surface-blank`).toEqual([]);
}

/** Which switch a piece reads: from the away workspace home, or (that one made first) home to away. */
export type Leg = "home" | "away";

/** Switch to `toSpaceId` without reading it — the set-up for the switch back — and wait for `arriving` to show. */
async function switchQuietly(app: App, toSpaceId: string, arriving: readonly string[]): Promise<void> {
  await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(toSpaceId)} }), null)`);
  await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === toSpaceId, 5_000);
  for (const id of arriving) {
    await hostShows(app, id);
  }
  await Bun.sleep(600);
}

/** A card of `kind` at home and one in a second workspace, switched away → home or (that made first) home → away. */
export async function switchKind(kind: CardKind, leg: Leg, tier?: Tier): Promise<void> {
  const K = `row10-${kind.componentId}`;
  const app = await launchTugApp({ testName: `${TEST_NAME}-${leg}${tier === undefined ? "" : `-${tier}`}-${kind.componentId}` });
  try {
    await app.seedDeckState({ state: kindDeck(kind, K, { sessions: [A] }), focusCardId: K });
    await standUpKind(app, kind, K);
    await Bun.sleep(400);
    const home = await app.evalJS<string>(ACTIVE_SPACE);
    const places = new Map<string, Rect>();
    places.set(K, await restAt(app, K, `${K} at home`));
    const standing = await readStanding(app, K, (await regionRectOf(app, K))!);
    const crop = { x: 0, y: 0, width: standing.contentWidth, height: Math.ceil(Math.max(...[...places.values()].map((r) => r.y + r.height))) + 16 };

    await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
    await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 10_000);
    const away = await app.evalJS<string>(ACTIVE_SPACE);
    expect(away, "a second workspace is shown").not.toBe(home);
    await expectHidden(app, K, `${K} after leaving home`);
    const ofKind = `window.tugdeck.diag.getDeckState().cards.filter(function (c) { return c.componentId === ${JSON.stringify(kind.componentId)}; }).map(function (c) { return c.id; })`;
    const madeWith = (await app.evalJS<string[]>(ofKind)).find((id) => id !== K);
    const K2 = madeWith ?? (await openKind(app, kind));
    note(`the away workspace's ${kind.componentId} card: ${K2} (${madeWith !== undefined ? "made with the workspace" : "opened there"})`);
    await standUpKind(app, kind, K2);
    await Bun.sleep(400);
    places.set(K2, await restAt(app, K2, `${K2} away`));

    if (leg === "home") {
      if (tier !== undefined) await intoTier(app, tier, "away, before the switch home");
      await switchLeg(app, { label: "away → home", toSpaceId: home, arriving: [K], departing: [K2], watch: K, revealsPainted: tier !== "evicted" }, places, crop, standing.palette);
    } else {
      await switchQuietly(app, home, [K]);
      if (tier !== undefined) await intoTier(app, tier, "home, before the switch away");
      await switchLeg(app, { label: "home → away", toSpaceId: away, arriving: [K2], departing: [K], watch: K2, revealsPainted: tier !== "evicted" }, places, crop, standing.palette);
    }
  } finally {
    await app.close();
  }
}

/** Two Session bodies at home and a third opened by ⌘N in a second workspace, switched away → home or (that made first) home → away. */
export async function switchSessions(leg: Leg, tier?: Tier): Promise<void> {
  const stubDir = stubDirectory();
  const app = await launchTugApp({ testName: `${TEST_NAME}-${leg}${tier === undefined ? "" : `-${tier}`}`, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
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
    places.set(A, await restAt(app, A, "A at home"));
    places.set(B, await restAt(app, B, "B at home"));
    const standing = await readStanding(app, A, (await regionRectOf(app, A))!);
    const crop = { x: 0, y: 0, width: standing.contentWidth, height: Math.ceil(Math.max(...[...places.values()].map((r) => r.y + r.height))) + 16 };

    // ---- The away workspace, with a body card of its own ----
    await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
    await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 10_000);
    const away = await app.evalJS<string>(ACTIVE_SPACE);
    expect(away, "a second workspace is shown").not.toBe(home);
    await expectHidden(app, A, "A after leaving home");
    await expectHidden(app, B, "B after leaving home");
    // The verb reveals the Cards card and opens a rename; Escape leaves it,
    // when the rename holds the keyboard — a bare Escape with no taker beeps.
    // The rename is waited for first: its body is made by the switch, and a
    // key posted before that page is up reaches a view with nothing to take it.
    const cards = await bodyOfKind(app, "cards");
    await pollFor(
      () => cards.evalJS<boolean>(`document.activeElement !== null && document.activeElement.matches(".cards-space-rename")`),
      (v) => v,
      10_000,
    );
    if (await escapeHasTaker(app)) await app.nativeKey("Escape", []);
    await Bun.sleep(300);
    const focusedBefore = await app.getFocusedCardId();
    await app.nativeKey("n", ["cmd"]);
    const C = (await settleFor(() => app.getFocusedCardId(), (c) => c !== null && c !== focusedBefore && c !== A && c !== B, 10_000))!;
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
    places.set(C, await restAt(app, C, "C away"));
    note(`home ${home}: A ${JSON.stringify(places.get(A))}, B ${JSON.stringify(places.get(B))}; away ${away}: C ${JSON.stringify(places.get(C))}`);

    if (leg === "home") {
      if (tier !== undefined) await intoTier(app, tier, "away, before the switch home");
      await switchLeg(app, { label: "away → home", toSpaceId: home, arriving: [A, B], departing: [C], watch: A, revealsPainted: tier !== "evicted" }, places, crop, standing.palette);
    } else {
      await switchQuietly(app, home, [A, B]);
      if (tier !== undefined) await intoTier(app, tier, "home, before the switch away");
      await switchLeg(app, { label: "home → away", toSpaceId: away, arriving: [C], departing: [A, B], watch: C, revealsPainted: tier !== "evicted" }, places, crop, standing.palette);
    }
  } finally {
    await app.close();
  }
}
