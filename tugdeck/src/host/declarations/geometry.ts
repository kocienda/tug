/**
 * Placement and gestures: the messages that say where every card's view is
 * and what the host carries in its hand.
 *
 * Every message here is typed field by field ([B02]): its codec names each
 * field the writer writes and the reader reads, a field the writer always
 * writes is required, and a payload that does not decode is refused whole —
 * by the page that wrote it in a dev or test build (`postToHost`), and by
 * the host's `Decodable` twin in `HostMessages.swift`, never defaulted field
 * by field.
 *
 * @module host/declarations/geometry
 */

import { INVALID, arr, bool, literal, nullable, num, obj, opaque, optional, str, type Codec } from "../../bus/codec";
import type { ResizeEdge } from "../../bus/declarations/pane";
import type { BeatPlan } from "../../lib/body-beat-plan";
import type { CardInsets, FloorGrid, PlaceBodies, PlaceCards } from "../../lib/body-placement";
import type { CardGestureReport } from "../../lib/host-card-gesture";
import type { PointerClaim } from "../../lib/pointer-claim";
import { defineToHost, defineToPage } from "../declare";

const rect = obj({ x: num, y: num, width: num, height: num });
const point = obj({ x: num, y: num });

/** A flag the writer sets only when it is true: `true`, or absent. */
const trueFlag: Codec<true | undefined> = optional(opaque((value: unknown): value is true => value === true, true));

const edge: Codec<ResizeEdge> = literal("n", "s", "e", "w", "nw", "ne", "sw", "se");

/** Exactly two numbers: a beat's start and end opacity. */
const pair: Codec<readonly [number, number]> = {
  decode: (value) => {
    if (!Array.isArray(value) || value.length !== 2) return INVALID;
    const [a, b] = value as unknown[];
    const da = num.decode(a);
    const db = num.decode(b);
    return da === INVALID || db === INVALID ? INVALID : [da, db];
  },
  sample: [0, 1],
};

/** `#rrggbb` or `rgba(r, g, b, a)`: the two colour forms the host's floor reads (`FloorGrid.color(from:)`). */
const HOST_COLOR = /^\s*(#[0-9a-f]{6}|rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*\))\s*$/i;
const hostColor: Codec<string> = opaque(
  (value: unknown): value is string => typeof value === "string" && HOST_COLOR.test(value),
  "#000000",
);

const cardInsets: Codec<CardInsets> = obj({ top: num, right: num, bottom: num, left: num });

const beatPlanCodec: Codec<BeatPlan> = obj({
  planId: num,
  startWallMs: num,
  bodies: arr(
    obj({
      cardId: str,
      landing: rect,
      crossing: optional(obj({ width: num, height: num })),
      arrives: trueFlag,
      beats: arr(
        obj({
          kind: literal("depart", "room", "shrink", "move", "grow", "arrive"),
          delayMs: num,
          durationMs: num,
          from: rect,
          to: rect,
          opacity: optional(pair),
          progress: arr(num),
          easing: optional(literal("linear", "ease", "ease-in", "ease-out", "ease-in-out")),
        }),
      ),
    }),
  ),
});

const placeBodiesCodec: Codec<PlaceBodies> = obj({
  radius: num,
  bodies: arr(
    obj({
      cardId: str,
      x: num,
      y: num,
      width: num,
      height: num,
      visible: bool,
      grips: arr(rect),
      z: num,
      whole: trueFlag,
      sibling: trueFlag,
      insets: optional(cardInsets),
    }),
  ),
});

const placeCardsCodec: Codec<PlaceCards> = obj({
  apron: num,
  canvas: nullable(rect),
  zoom: num,
  cards: arr(
    obj({
      cardId: str,
      x: num,
      y: num,
      width: num,
      height: num,
      visible: bool,
      sibling: trueFlag,
      z: num,
      grips: arr(edge),
      free: bool,
      min: obj({ width: num, height: num }),
    }),
  ),
});

/** `{all: true}`, or the rects the shell's surfaces cover. */
const pointerClaimCodec: Codec<PointerClaim> = {
  decode: (value) => {
    if (typeof value === "object" && value !== null && (value as { all?: unknown }).all === true) return { all: true };
    return obj({ rects: arr(rect) }).decode(value);
  },
  sample: { all: true },
};

const floorGridCodec: Codec<FloorGrid> = obj({
  canvas: hostColor,
  grid: hostColor,
  cellPx: num,
  linePx: num,
  zoom: num,
  originX: num,
  originY: num,
});

/** A card's page has taken a title-bar or grip press for the host to carry (`body-chrome.ts`). */
export interface CardGestureBegin {
  readonly phase: "begin";
  readonly kind: "move" | "resize" | "rail";
  /** The edge or corner a resize is from; a resize without one is refused by the host. */
  readonly edge?: ResizeEdge;
  /** Where the press landed, in the page's viewport. */
  readonly x: number;
  readonly y: number;
  readonly meta: boolean;
  readonly alt: boolean;
}

const cardGestureBeginCodec: Codec<CardGestureBegin> = obj({
  phase: literal("begin"),
  kind: literal("move", "resize", "rail"),
  edge: optional(edge),
  x: num,
  y: num,
  meta: bool,
  alt: bool,
});

const SAMPLE_RECT = { x: 121, y: 96, width: 398, height: 483 };

export const placeBodiesToHost = defineToHost<PlaceBodies>({
  name: "placeBodies",
  from: "shell",
  typed: true,
  codec: placeBodiesCodec,
  samples: [
    {
      radius: 6,
      bodies: [
        {
          cardId: "c1",
          ...SAMPLE_RECT,
          visible: true,
          grips: [{ x: 117, y: 575, width: 406, height: 8 }],
          z: 1,
        },
        {
          cardId: "c2",
          ...SAMPLE_RECT,
          visible: true,
          grips: [],
          z: 2,
          whole: true,
          insets: { top: 6, right: 6.5, bottom: 6, left: 6 },
        },
        { cardId: "c3", ...SAMPLE_RECT, visible: false, grips: [], z: 2, whole: true, sibling: true },
      ],
    },
  ],
  refused: [
    "placeBodies",
    { bodies: [] },
    { radius: 6, bodies: [{ cardId: "c1", ...SAMPLE_RECT, grips: [], z: 1 }] },
    { radius: 6, bodies: [{ cardId: "c1", ...SAMPLE_RECT, visible: "yes", grips: [], z: 1 }] },
  ],
});

export const placeCardsToHost = defineToHost<PlaceCards>({
  name: "placeCards",
  from: "shell",
  typed: true,
  codec: placeCardsCodec,
  samples: [
    {
      apron: 6,
      canvas: { x: 0, y: 28, width: 1440, height: 872 },
      zoom: 1,
      cards: [
        {
          cardId: "c1",
          ...SAMPLE_RECT,
          visible: true,
          z: 1,
          grips: ["e", "s", "se"],
          free: true,
          min: { width: 240, height: 160 },
        },
        {
          cardId: "c2",
          ...SAMPLE_RECT,
          visible: false,
          sibling: true,
          z: 1,
          grips: [],
          free: false,
          min: { width: 0, height: 0 },
        },
      ],
    },
    { apron: 6, canvas: null, zoom: 1.25, cards: [] },
  ],
  refused: [
    [{ cardId: "c1" }],
    { apron: 6, canvas: null, zoom: 1 },
    {
      apron: 6,
      canvas: null,
      zoom: 1,
      cards: [{ cardId: "c1", ...SAMPLE_RECT, visible: true, z: 1, grips: ["middle"], free: true, min: { width: 0, height: 0 } }],
    },
  ],
});

export const cardGestureToHost = defineToHost<CardGestureBegin>({
  name: "cardGesture",
  from: "body",
  typed: true,
  codec: cardGestureBeginCodec,
  samples: [
    { phase: "begin", kind: "move", x: 140, y: 12, meta: false, alt: false },
    { phase: "begin", kind: "resize", edge: "e", x: 518, y: 300, meta: false, alt: true },
    { phase: "begin", kind: "rail", edge: "e", x: 300, y: 400, meta: false, alt: false },
  ],
  refused: [
    null,
    { phase: "begin", kind: "move", meta: false, alt: false },
    { phase: "begin", kind: "fling", x: 1, y: 2, meta: false, alt: false },
  ],
});

/** A drop the shell committed nothing for: the card's view goes back to its own place. */
export interface CardLand {
  readonly cardId: string;
}

export const cardLandToHost = defineToHost<CardLand>({
  name: "cardLand",
  from: "shell",
  typed: true,
  codec: obj({ cardId: str }),
  samples: [{ cardId: "c1" }],
  refused: ["c1", {}, { cardId: 7 }],
});

export const beatPlanToHost = defineToHost<BeatPlan>({
  name: "beatPlan",
  from: "shell",
  typed: true,
  codec: beatPlanCodec,
  samples: [
    {
      planId: 1,
      startWallMs: 1760000000000.5,
      bodies: [
        {
          cardId: "c1",
          landing: SAMPLE_RECT,
          beats: [
            {
              kind: "move",
              delayMs: 0,
              durationMs: 300,
              from: { ...SAMPLE_RECT, x: 421 },
              to: SAMPLE_RECT,
              progress: [0, 0.32, 0.71, 0.93, 1.03, 1.01, 1],
            },
          ],
        },
        {
          cardId: "c2",
          landing: SAMPLE_RECT,
          crossing: { width: 398, height: 483 },
          arrives: true,
          beats: [
            {
              kind: "arrive",
              delayMs: 0,
              durationMs: 120,
              from: SAMPLE_RECT,
              to: SAMPLE_RECT,
              opacity: [0, 1],
              progress: [0, 1],
              easing: "ease-out",
            },
          ],
        },
      ],
    },
  ],
  refused: [
    { planId: "x", startWallMs: 0, bodies: [] },
    { startWallMs: 0, bodies: [] },
    { planId: 1, startWallMs: 0, bodies: [{ cardId: "c1", landing: SAMPLE_RECT }] },
  ],
});

export const pointerClaimToHost = defineToHost<PointerClaim>({
  name: "pointerClaim",
  from: "shell",
  typed: true,
  codec: pointerClaimCodec,
  samples: [{ rects: [SAMPLE_RECT] }, { rects: [] }, { all: true }],
  refused: [[], {}, { rects: [{ x: "bad", y: 2, width: 3, height: 4 }] }, { all: false }],
});

export const floorGridToHost = defineToHost<FloorGrid>({
  name: "floorGrid",
  from: "shell",
  typed: true,
  codec: floorGridCodec,
  samples: [
    {
      canvas: "#1c1e22",
      grid: "rgba(255, 255, 255, 0.04)",
      cellPx: 24,
      linePx: 1,
      zoom: 1,
      originX: 0,
      originY: 3.5,
    },
  ],
  refused: [
    0,
    { canvas: "#1c1e22", grid: "#ffffff", cellPx: 24, linePx: 1, zoom: 1, originX: 0 },
    { canvas: "oklch(0.2 0.02 280)", grid: "#ffffff", cellPx: 24, linePx: 1, zoom: 1, originX: 0, originY: 0 },
  ],
});

// Host → page.

const gestureReportCodec: Codec<CardGestureReport> = obj({
  cardId: str,
  kind: literal("move", "resize", "rail"),
  phase: literal("move", "end", "cancel"),
  rect,
  pointer: point,
  start: point,
  moved: bool,
  meta: bool,
  alt: bool,
  edge: optional(edge),
  snap: optional(obj({ x: nullable(num), y: nullable(num) })),
});

const gestureReport: CardGestureReport = {
  cardId: "c1",
  kind: "move",
  phase: "move",
  rect: { x: 40, y: 60, width: 480, height: 320 },
  pointer: { x: 200, y: 80 },
  start: { x: 180, y: 70 },
  moved: true,
  meta: false,
  alt: false,
};

/** Where a gesture the host carries stands, told to the shell. */
export const cardGestureToPage = defineToPage<CardGestureReport>({
  member: "onCardGesture",
  to: "shell",
  typed: true,
  codec: gestureReportCodec,
  samples: [
    gestureReport,
    { ...gestureReport, kind: "resize", phase: "end", edge: "se", snap: { x: 40, y: null } },
    { ...gestureReport, phase: "cancel", moved: false },
  ],
  refused: ["move", { ...gestureReport, phase: "begin" }, { ...gestureReport, start: undefined }],
});

/** Where a whole card's pane stands in its body's view. */
export const cardInsetsToPage = defineToPage<CardInsets>({
  member: "onCardInsets",
  to: "body",
  typed: true,
  codec: cardInsets,
  samples: [{ top: 6, right: 6.5, bottom: 6, left: 6 }],
  refused: [28, { top: 6, right: 6, bottom: 6 }],
});

/**
 * A crossing's beats begin over the body — the size its box is carried to
 * and the plan's span — or have landed.
 */
export interface BodyCrossing {
  readonly phase: "begin" | "land";
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
}

export const bodyCrossingToPage = defineToPage<BodyCrossing>({
  member: "onBodyCrossing",
  to: "body",
  typed: true,
  codec: obj({
    phase: literal("begin", "land"),
    width: optional(num),
    height: optional(num),
    durationMs: optional(num),
  }),
  samples: [{ phase: "begin", width: 480, height: 320, durationMs: 240 }, { phase: "land" }],
  refused: ["land", { phase: "pause" }, { phase: "begin", width: "wide" }],
});
