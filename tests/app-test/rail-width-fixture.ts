/**
 * rail-width-fixture.ts — what the rail width readings share: the host's
 * reports of the hand as the shell hears them, the facts the host was told
 * the rail stands on, and a reader that finds each member's deck-facing edge
 * and the chain's first card's leading edge by colour in a composite.
 *
 * The host carries a rail's width drag: it moves every member's view and the
 * cards beside the rail itself, and the shell only previews its stand-ins at
 * the aim the host reports. So where a view stands is read where the views
 * are, in the composite, never from a stand-in's rect, which is the shell's
 * model of the deck and moves on the shell's clock (`at0677`–`at0680`).
 *
 * Every reading here is of a left rail, the shape those files seed: its
 * deck-facing edge is a member's right edge, and the chain stands to its
 * right.
 */

import { expect } from "bun:test";

import { note, type App } from "./_harness";
import type { BodyViewSnapshot, CaptureBurstFrame } from "./_harness/client";
import { fillOnRow, groundStartOnRow, leadingEdgeOnRow, near, type Rgb } from "./body-grounding/_frames";
import { COLOUR_TOLERANCE, still, type Rect } from "./one-view-fixture";
import { RAIL_GUTTER_PX } from "../../tugdeck/src/lib/layout-imposer";

// The rail's arithmetic is stated here rather than imported: `rail-width.ts`
// pulls the deck's whole import graph into this project's typecheck, as
// `at0680` found of its limits.

/** An imposed card's travel under a rail width change (`RailTravel` in `rail-width.ts`). */
export type RailTravel =
  | { readonly kind: "fit"; readonly fraction: number; readonly slotWidth: number }
  | { readonly kind: "flow" };

/** The band and the flow strip as the drag began (`RailTravelBand` in `rail-width.ts`). */
export interface RailTravelBand {
  readonly band: number;
  readonly flow: { readonly offset: number; readonly strip: number } | null;
}

/** How far an imposed card moves, px, when a rail grows by `growth`: `railTravelShift` in `rail-width.ts`. */
export function railTravelShift(travel: RailTravel, side: "left" | "right", start: RailTravelBand, growth: number): number {
  const insetShift = side === "left" ? growth : 0;
  const band = start.band - growth;
  if (travel.kind === "fit") {
    const slack = (b: number): number => Math.max(0, b - travel.slotWidth);
    return insetShift + travel.fraction * (slack(band) - slack(start.band));
  }
  if (start.flow === null) return insetShift;
  const { offset, strip } = start.flow;
  const clamped = (b: number): number => Math.min(offset, Math.max(0, strip - b));
  return insetShift - (clamped(band) - clamped(start.band));
}

/** How far a card's view reaches past its pane on every side (`CARD_APRON_PX`). */
export const CARD_APRON_PX = 10;

/** One of the host's reports of a rail's hand, as the shell heard it. */
export interface RailReport {
  /** `Date.now()` in the shell when the report arrived: the clock a burst frame's `wall` is on. */
  wall: number;
  phase: "move" | "end" | "cancel";
  moved: boolean;
  pointer: { x: number; y: number };
  /** The dragged member's pane rect at the shown width, viewport points. */
  rect: Rect;
  /** The aim the host drew the rail at, layout px. */
  rail: { width: number; shown: number; limit: "floor" | "ceiling" | null } | null;
}

/** Record every report the host sends the shell from now on (`onCardGesture`). */
export async function armReportRecord(app: App): Promise<void> {
  // card-dom: shell — the host's gesture reports arrive in the shell's page.
  await app.evalJS<null>(
    `(function () {
      var rec = (window.__railReports = []);
      var b = window.__tugBridge; var take = b.onCardGesture;
      b.onCardGesture = function (r) {
        rec.push({ wall: Date.now(), phase: r.phase, moved: r.moved, pointer: r.pointer, rect: r.rect, rail: r.rail || null });
        return take(r);
      };
      return null;
    })()`,
  );
}

/** The reports recorded since {@link armReportRecord}. */
export function takeReportRecord(app: App): Promise<RailReport[]> {
  // card-dom: shell — the record is the shell page's.
  return app.evalJS<RailReport[]>(`window.__railReports || []`);
}

/** What the last `placeCards` told the host: the zoom, the band, and each card's travel. */
export interface RailFacts {
  zoom: number;
  band: RailTravelBand;
  travel: Record<string, RailTravel>;
}

/** Read {@link RailFacts} off the placer's last posted `placeCards`. */
export async function readRailFacts(app: App): Promise<RailFacts> {
  // card-dom: shell — the placer is the shell's, and this is what it posted to the host.
  const facts = await app.evalJS<RailFacts | null>(
    `(function () {
      var d = window.tugdeck.diag.getBodyPlacement();
      var c = d && d.lastCards;
      if (!c) return null;
      var travel = {};
      c.cards.forEach(function (e) { if (e.railTravel) travel[e.cardId] = e.railTravel; });
      return { zoom: c.zoom, band: c.band, travel: travel };
    })()`,
  );
  expect(facts, "the placer has posted the deck to the host").not.toBeNull();
  return facts!;
}

/** A left rail's deck-facing edge as a report drew it, window points. */
export const reportedEdge = (r: RailReport): number => r.rect.x + r.rect.width;

/**
 * The edges the composite may show at `wall`, low to high: every edge the
 * host reported in the `latencyMs` before it, and the one that stood when
 * that span began. A frame up to two display frames behind the host is
 * admitted (grounding brief [F14]) and no more, so `latencyMs` is two
 * display periods. A report is stamped when the shell hears it, which trails
 * the host's move of the views by the shell's delivery, so a report heard
 * within `deliveryMs` after the frame counts as one the frame may already
 * show: a card the host only moves needs no repaint and can show a step
 * before the shell has heard of it. Before the first report, `rest` stands.
 */
export function expectedEdgeAt(
  wall: number,
  reports: readonly RailReport[],
  rest: number,
  latencyMs: number,
  deliveryMs: number,
  edgeOf: (r: RailReport) => number = reportedEdge,
): { lo: number; hi: number } {
  const moves = reports.filter((r) => r.phase === "move" && r.wall <= wall + deliveryMs);
  const from = wall - latencyMs;
  const standing = moves.filter((r) => r.wall <= from);
  const edges = [
    standing.length > 0 ? edgeOf(standing[standing.length - 1]) : rest,
    ...moves.filter((r) => r.wall > from).map(edgeOf),
  ];
  return { lo: Math.min(...edges), hi: Math.max(...edges) };
}

/** Where the chain's first card's leading edge stands at a report: its rest edge moved by the ported travel. */
export function chainEdgeAt(r: RailReport, rest: { edge: number; shown: number }, travel: RailTravel, facts: RailFacts): number {
  const shown = r.rail?.shown ?? rest.shown;
  return rest.edge + railTravelShift(travel, "left", facts.band, shown - rest.shown) * facts.zoom;
}

/** One member, as the reader finds it in a frame. */
interface MemberRow {
  cardId: string;
  /** The device row the edge is read on, and the ground beside it there. */
  row: number;
  ground: Rgb;
  /** The pane's deck-facing edge at rest, window points. */
  restEdge: number;
  /** The colour edge less the pane's edge, device px: the reach of the shadow the rail casts, read off the standing deck. */
  offset: number;
}

/** A reader of one rail's edges, calibrated off the standing deck. */
export interface RailReader {
  crop: Rect;
  scale: number;
  members: MemberRow[];
  chain: (MemberRow & { member: number; restLeft: number }) | null;
  /** Window points → the crop's device px, before the calibrated offset. */
  toDevice(x: number): number;
  /** Each member's deck-facing edge by colour, device px, less its rest offset: comparable with `toDevice` of a pane edge. */
  memberEdges(frame: CaptureBurstFrame): (number | null)[];
  /** The chain's first card's leading edge by colour, the same way. */
  chainEdge(frame: CaptureBurstFrame): number | null;
}

/**
 * How near the ground a pixel must be to count as the end of the rail's
 * shadow. Tighter than {@link COLOUR_TOLERANCE}, so the edge is read where
 * the shadow's gradient meets the ground rather than at its dark first
 * pixels: the pressed member's page lights its held edge line over those,
 * a pixel past its border, and its siblings' pages do not, while every
 * member draws the same shadow beside its frame.
 */
const SHADOW_TAIL_TOLERANCE = 3;

/** A member's deck-facing edge on `row`: where its shadow meets the ground, scanning out of the member from `x0`. */
function railEdgeOn(frame: CaptureBurstFrame, row: number, ground: Rgb, from: number, to: number): number | null {
  return groundStartOnRow(frame, row, ground, SHADOW_TAIL_TOLERANCE, from, to);
}

/** The chain card's leading edge on `row`: its first run of paint past the gutter that begins at `from`. */
function chainEdgeOn(frame: CaptureBurstFrame, row: number, ground: Rgb, from: number, to: number): number | null {
  return leadingEdgeOnRow(frame, row, ground, COLOUR_TOLERANCE, "left", from, to);
}

const paneOf = (b: BodyViewSnapshot): Rect => ({
  x: b.frame.x + CARD_APRON_PX,
  y: b.frame.y + CARD_APRON_PX,
  width: b.frame.width - 2 * CARD_APRON_PX,
  height: b.frame.height - 2 * CARD_APRON_PX,
});

/**
 * Calibrate a reader over `members` (top to bottom) and, when named, the
 * chain card beside them, off a still of the standing deck. The crop runs
 * from inside the members to `reach` points past the chain card's leading
 * edge (or the members' edge), the room the drag will travel.
 */
export async function railReader(app: App, members: readonly string[], chain: string | null, reach: number): Promise<RailReader> {
  const views = await app.bodies();
  const viewOf = (card: string): BodyViewSnapshot => {
    const v = views.find((b) => b.cardId === card && b.visible);
    expect(v, `the host holds ${card}'s view`).toBeDefined();
    return v!;
  };
  const panes = members.map((m) => paneOf(viewOf(m)));
  const chainPane = chain === null ? null : paneOf(viewOf(chain));
  // card-dom: shell
  const inner = await app.evalJS<{ w: number; h: number }>(`({ w: window.innerWidth, h: window.innerHeight })`);
  const railRight = Math.max(...panes.map((p) => p.x + p.width));
  const left = Math.max(0, Math.floor(Math.min(...panes.map((p) => p.x + p.width)) - 60));
  const top = Math.max(0, Math.floor(Math.min(...panes.map((p) => p.y))));
  const right = Math.min(Math.floor(inner.w), Math.ceil((chainPane?.x ?? railRight) + reach + 60));
  const bottom = Math.min(Math.floor(inner.h), Math.ceil(Math.max(...panes.map((p) => p.y + p.height))));
  const crop = { x: left, y: top, width: right - left, height: bottom - top };
  const standing = await still(app, crop);
  const scale = standing.scale;
  const toDevice = (x: number): number => (x - crop.x) * scale;
  const rowOf = (y: number): number => (y - crop.y) * scale;
  const fullWidth = crop.width * scale;

  const calibrate = (cardId: string, pane: Rect, y: number): MemberRow => {
    const row = rowOf(y);
    const edge = pane.x + pane.width;
    // The gutter past the rail's shadow (10 px) and short of the chain's
    // apron: the ground the edge is read against, on this very row, so a
    // grid line the row runs along is that row's ground.
    const ground = fillOnRow(standing.frame, row, toDevice(edge + 11), toDevice(edge + RAIL_GUTTER_PX - 3));
    const surface = fillOnRow(standing.frame, row, toDevice(edge - 40), toDevice(edge - 8));
    expect(near(ground, surface, COLOUR_TOLERANCE), `${cardId} is told apart from the ground beside it`).toBe(false);
    const read = railEdgeOn(standing.frame, row, ground, toDevice(edge - 40), fullWidth);
    expect(read, `${cardId}'s edge is read by colour on the standing deck`).not.toBeNull();
    return { cardId, row, ground, restEdge: edge, offset: read! - toDevice(edge) };
  };
  const rows = members.map((m, i) => calibrate(m, panes[i], panes[i].y + panes[i].height / 2));

  let chainRow: RailReader["chain"] = null;
  if (chain !== null && chainPane !== null) {
    const y = chainPane.y + Math.min(chainPane.height / 2, 120);
    const member = panes.findIndex((p) => y >= p.y + 20 && y <= p.y + p.height - 20);
    expect(member, `a member stands beside ${chain}'s row`).toBeGreaterThanOrEqual(0);
    const m = calibrate(members[member], panes[member], y);
    const from = railEdgeOn(standing.frame, m.row, m.ground, toDevice(m.restEdge - 40), fullWidth)!;
    const read = chainEdgeOn(standing.frame, m.row, m.ground, from, fullWidth);
    expect(read, `${chain}'s leading edge is read by colour on the standing deck`).not.toBeNull();
    chainRow = { ...m, cardId: chain, member, restLeft: chainPane.x, offset: read! - toDevice(chainPane.x) };
  }
  note(
    `rail reader: crop ${JSON.stringify(crop)} at ${scale}x; offsets ${rows.map((r) => `${r.cardId} ${r.offset}`).join(", ")}` +
      (chainRow ? `; chain ${chainRow.cardId} ${chainRow.offset}` : ""),
  );

  const scanFrom = (r: MemberRow): number => toDevice(r.restEdge - 40);
  return {
    crop,
    scale,
    members: rows,
    chain: chainRow,
    toDevice,
    memberEdges: (frame) =>
      rows.map((r) => {
        const e = railEdgeOn(frame, r.row, r.ground, scanFrom(r), fullWidth);
        return e === null ? null : e - r.offset;
      }),
    chainEdge: (frame) => {
      if (chainRow === null) return null;
      const from = railEdgeOn(frame, chainRow.row, chainRow.ground, scanFrom(chainRow), fullWidth);
      if (from === null) return null;
      const e = chainEdgeOn(frame, chainRow.row, chainRow.ground, from, fullWidth);
      return e === null ? null : e - chainRow.offset;
    },
  };
}
