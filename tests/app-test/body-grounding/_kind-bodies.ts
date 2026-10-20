/**
 * _kind-bodies.ts — standing up a card of any kind as a body.
 *
 * A Session card becomes a body when its session spawns (`_bodies.ts`); every
 * other kind is handed off the moment the deck holds it. This module is the
 * kind-general furniture the rows share: a deck holding one card of a kind
 * (beside the Session cards a row also wants), the wait for its body to stand
 * ready with the kind's root mounted in it, and the page a row reads it in.
 */

import { expect } from "bun:test";

import { note, type App, type BodyApp } from "../_harness";
import type { BodyViewSnapshot, CaptureBurstReading } from "../_harness/client";
import { BODY_READY_MS, pollFor, sessionPane, spawnStub } from "./_bodies";
import { asRgbJs, classifyFrame, parseRgb } from "./_frames";
import { kindPane, kindSidebars, type CardKind } from "./_kinds";

/** A deck: `cardId` of `kind`, plus `sessions` Session cards in the flow band's slots. */
export function kindDeck(
  kind: CardKind,
  cardId: string,
  opts: { sessions?: readonly string[]; imposition?: string; layout?: "flow" | "fit"; focus?: string } = {},
): Record<string, unknown> {
  const sessions = (opts.sessions ?? []).filter((id) => id !== cardId);
  const contentIds = kind.rail ? sessions : [cardId, ...sessions];
  const panes = contentIds.map((id, slot) => (id === cardId ? kindPane(kind.componentId, id, slot) : sessionPane(id, slot)));
  if (kind.rail) panes.push(kindPane(kind.componentId, cardId, 0));
  const focus = opts.focus ?? cardId;
  return {
    cards: [
      { id: cardId, componentId: kind.componentId, title: kind.componentId, closable: true },
      ...sessions.map((id) => ({ id, componentId: "session", title: id, closable: true })),
    ],
    panes,
    activePaneId: `${focus}-pane`,
    imposition: {
      kind: opts.imposition ?? "four-up",
      ...(opts.layout !== undefined ? { layout: opts.layout } : { layout: "flow" }),
      sidebars: kindSidebars([kind.componentId]),
    },
    hasFocus: true,
  };
}

export async function bodySnapshot(app: App, cardId: string): Promise<BodyViewSnapshot | null> {
  return (await app.bodies()).find((b) => b.cardId === cardId) ?? null;
}

/**
 * The card's body stands ready, placed visible, with the kind's root mounted
 * in it. A Session card is handed off by spawning a stub into it first.
 */
export async function standUpKind(
  app: App,
  kind: CardKind,
  cardId: string,
  stubDir?: string,
): Promise<BodyApp> {
  if (kind.componentId === "session") {
    if (stubDir === undefined) throw new Error("standUpKind: a Session card needs a stub directory");
    await spawnStub(app, cardId, stubDir, 2);
  }
  const ready = await pollFor(
    () => bodySnapshot(app, cardId),
    (b) => b !== null && b.state === "ready" && b.visible,
    BODY_READY_MS,
  );
  expect(ready?.state, `${kind.componentId} ${cardId}: its body stands ready`).toBe("ready");
  expect(ready?.componentId, `${kind.componentId} ${cardId}: the body holds the card's kind`).toBe(kind.componentId);
  const body = app.body(cardId);
  const root = JSON.stringify(kind.root);
  const up = await pollFor(() => body.evalJS<boolean>(`document.querySelector(${root}) !== null`), (v) => v, BODY_READY_MS);
  expect(up, `${kind.componentId} ${cardId}: ${kind.root} is mounted in its body`).toBe(true);
  return body;
}

/** Every card id the shell's document names on a pane. */
const CARD_IDS = `Array.from(document.querySelectorAll(".tug-pane [data-card-id]")).map(function (el) { return el.getAttribute("data-card-id"); })`;

/**
 * Open a card of `kind` the user's way and answer its id: a rail kind is
 * shown on its edge (the Layout card's per-card row, `set-sidebar-open`); a
 * content kind is added as a tab of the active pane (`add-tab`).
 */
export async function openKind(app: App, kind: CardKind): Promise<string> {
  const before = new Set(await app.evalJS<string[]>(CARD_IDS));
  const action = kind.rail
    ? `window.__tug.dispatchControlAction("set-sidebar-open", { componentId: ${JSON.stringify(kind.componentId)}, open: true })`
    : `window.__tug.dispatchControlAction("add-tab", { value: ${JSON.stringify(kind.componentId)} })`;
  await app.evalJS<null>(`(${action}, null)`);
  const ids = await pollFor(
    () => app.evalJS<string[]>(CARD_IDS),
    (now) => now.some((id) => !before.has(id)),
    3_000,
  );
  const opened = ids.find((id) => !before.has(id));
  expect(opened, `opening a ${kind.componentId} card put a new card on the deck`).toBeDefined();
  return opened!;
}

export interface PlaceholderSample {
  wall: number;
  /** Each standing placeholder's rect, by card id. */
  rects: Record<string, { x: number; y: number; width: number; height: number }>;
  /**
   * The cards whose pane the deck is still bringing in, by card id: the pane
   * is arriving, or a settle is running. Its card is not on screen yet.
   */
  moving: Record<string, boolean>;
}

/** Arm a per-animation-frame sampler of every body placeholder's rect and whether its pane is still coming in, by card id. */
export async function armPlaceholderSampler(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var rec = (window.__kindPlaceholders = { samples: [], stop: false });
      var tick = function () {
        if (rec.stop) return;
        var rects = {};
        var moving = {};
        var settling = document.querySelector("[data-imposer-settling]") !== null;
        document.querySelectorAll("[data-body-placeholder][data-card-id]").forEach(function (el) {
          var r = el.getBoundingClientRect();
          var id = el.getAttribute("data-card-id");
          rects[id] = { x: r.x, y: r.y, width: r.width, height: r.height };
          moving[id] = settling || el.closest(".tug-pane[data-arriving]") !== null;
        });
        rec.samples.push({ wall: Date.now(), rects: rects, moving: moving });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

export async function readPlaceholderSampler(app: App): Promise<PlaceholderSample[]> {
  return app.evalJS<PlaceholderSample[]>(`(function () { var r = window.__kindPlaceholders; r.stop = true; return r.samples; })()`);
}

/** The rect `cardId`'s placeholder stood at on the latest sample at or before `wall`, or null. */
export function placeholderAt(
  samples: readonly PlaceholderSample[],
  cardId: string,
  wall: number,
): { x: number; y: number; width: number; height: number } | null {
  let found: PlaceholderSample | null = null;
  for (const s of samples) {
    if (s.wall > wall) break;
    found = s;
  }
  return found?.rects[cardId] ?? null;
}

/**
 * The wall time from which `cardId`'s pane stood landed for good: the first
 * sample after the last one that had it arriving or under a settle, or null
 * when no sample ever held its placeholder.
 */
export function landedFrom(samples: readonly PlaceholderSample[], cardId: string): number | null {
  let from: number | null = null;
  for (const s of samples) {
    if (!(cardId in s.rects)) continue;
    if (s.moving[cardId]) from = null;
    else from ??= s.wall;
  }
  return from;
}

/**
 * `cardId`'s body paints the surface a pinned rail's pane paints: the sunken
 * surface the shell's panel treatment gives a rail, not a content card's.
 * Read by composite colour — one burst frame of the window, inside the body's
 * rect — since what a body says it paints and what the window shows can
 * differ ([B05]).
 */
export async function expectRailSurface(app: App, cardId: string): Promise<void> {
  await expectSurface(app, cardId, "--tug7-surface-global-primary-normal-sunken-rest", "the rail's sunken surface", 0.5);
}

/**
 * `cardId`'s body paints a content pane's surface, read the same way. A
 * content card draws its own matter over it — text, a diff, a picture — so
 * the bar is the surface's share of the body's rect, not most of it.
 * `token` names the surface where the card paints its own (the Text card's
 * editing well), so the body is held to what the card paints in the shell.
 */
export async function expectContentSurface(
  app: App,
  cardId: string,
  minShare: number,
  token = "--tug7-surface-global-primary-normal-content-rest",
): Promise<void> {
  await expectSurface(app, cardId, token, `its surface (${token})`, minShare);
}

async function expectSurface(app: App, cardId: string, token: string, label: string, minShare: number): Promise<void> {
  const frame = (await bodySnapshot(app, cardId))?.frame;
  expect(frame, `${cardId}: the host reports its body's frame`).toBeDefined();
  const surface = parseRgb(await app.evalJS<string>(asRgbJs(`getComputedStyle(document.body).getPropertyValue('${token}')`)));
  await app.captureBurst({ op: "arm", durationMs: 200 });
  const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, 5_000);
  expect(reading.done, `${cardId}: the burst finished`).toBe(true);
  const last = reading.frames[reading.frames.length - 1];
  const s = reading.scale;
  const inset = 4;
  const region = { x: (frame!.x + inset) * s, y: (frame!.y + inset) * s, width: (frame!.width - 2 * inset) * s, height: (frame!.height - 2 * inset) * s };
  const classes = classifyFrame(last, { surface, canvas: surface, bare: parseRgb(reading.windowBackground) }, 8, region);
  note(`${cardId}: ${label} ${JSON.stringify(surface)}; body rect commonest ${classes.fill}, ${(classes.surface * 100).toFixed(0)}% surface`);
  expect(classes.surface, `${cardId}: its body paints ${label}`).toBeGreaterThan(minShare);
}
