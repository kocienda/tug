/**
 * Page lifecycle: a page saying it is connected, ready, painted or faulted,
 * and the shell making, focusing and destroying bodies.
 *
 * Every message is typed field by field, as the placement messages are, and
 * so are the calls into `window.tugdeck` and their replies.
 *
 * @module host/declarations/lifecycle
 */

import { arr, bool, empty, literal, nullable, num, obj, opaque, optional, str, type Codec } from "../../bus/codec";
import { defineToHost, definePageCall, defineToPage, noReply } from "../declare";
import type { TerminationVerdict } from "../../teardown";

/** A JSON object carried as is: a body's intent, which `parseBodyIntent` reads in the body. */
const jsonObject: Codec<Record<string, unknown>> = opaque(
  (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
  {},
);

/** A page's surface as sRGB bytes: four numbers, 0–255. */
const rgbaBytes: Codec<number[]> = opaque(
  (value: unknown): value is number[] =>
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 255),
  [0, 0, 0, 255],
);

export const bodyHelloToHost = defineToHost({
  name: "bodyHello",
  from: "body",
  codec: empty,
  samples: [{}],
  refused: [true],
});

export const paintedToHost = defineToHost({
  name: "painted",
  from: "body",
  codec: empty,
  samples: [{}],
  refused: [true],
});

/** The shell's ready reveals the window; a body's says it has painted its card. */
export const frontendReadyToHost = defineToHost({
  name: "frontendReady",
  from: "any",
  codec: empty,
  samples: [{}],
  refused: [true],
});

export const frontendLaunchStalledToHost = defineToHost({
  name: "frontendLaunchStalled",
  from: "shell",
  codec: obj({ waitingOn: str }),
  samples: [{ waitingOn: "wasm" }],
  refused: ["wasm", {}],
});

/**
 * One lap of the shell's boot, for the host's launch log: which step, when on
 * the page's own clock (ms since its navigation started), and at most one
 * line of detail. A launch that stalls reads as the last lap that arrived.
 */
export interface LaunchLap {
  readonly name: string;
  readonly ms: number;
  readonly detail?: string;
}

export const launchLapToHost = defineToHost<LaunchLap>({
  name: "launchLap",
  from: "shell",
  codec: obj({ name: str, ms: num, detail: optional(str) }),
  samples: [{ name: "socket-open", ms: 4120.5 }, { name: "frontend-ready", ms: 7001, detail: "1812 resources" }],
  refused: ["socket-open", { name: "socket-open" }, { name: 7, ms: 1 }],
});

/**
 * Posted only by `PageFaultScript`'s injected script, which no TypeScript
 * module writes: what faulted, its text, and where (`""` when it said nowhere).
 * `stall` is its boot watchdog's census of a shell page that has not reached
 * `frontend-ready`.
 */
export const pageFaultToHost = defineToHost({
  name: "pageFault",
  from: "any",
  codec: obj({ kind: literal("error", "resource", "unhandledrejection", "console.error", "stall"), message: str, source: str }),
  samples: [
    { kind: "error", message: "TypeError: x is undefined", source: "main.tsx:12" },
    { kind: "console.error", message: "it's \"broken\"\nagain", source: "" },
  ],
  refused: ["fault", { kind: "error", message: "x" }, { kind: "warning", message: "x", source: "" }],
});

/** The page's own surface as sRGB bytes, or null when it paints none. */
export interface BodySurface {
  readonly surface: number[] | null;
}

const bodySurfaceCodec: Codec<BodySurface> = obj({ surface: nullable(rgbaBytes) });

export const crossingReadyToHost = defineToHost<BodySurface>({
  name: "crossingReady",
  from: "body",
  codec: bodySurfaceCodec,
  samples: [{ surface: [28, 30, 34, 255] }, { surface: null }],
  refused: [[28, 30, 34, 255], {}, { surface: [28, 30, 34] }],
});

/**
 * The page is laid out at its crossing's size: the host's resize landed, its
 * resize episode ended, and a frame passed with no observer delivery and no
 * commit. The host starts the plan once every card it awaits has said so.
 */
export const crossingSolvedToHost = defineToHost({
  name: "crossingSolved",
  from: "body",
  codec: empty,
  samples: [{}],
  refused: [true],
});

/**
 * A solving plan has started: its wall-clock start, how long the solve took
 * from the plan's receipt, and whether the host's guard started it rather
 * than the last card's report.
 */
export interface PlanStarted {
  readonly planId: number;
  readonly startWallMs: number;
  readonly solveMs: number;
  readonly timedOut: boolean;
}

export const planStartedToPage = defineToPage<PlanStarted>({
  member: "onPlanStarted",
  to: "shell",
  codec: obj({ planId: num, startWallMs: num, solveMs: num, timedOut: bool }),
  samples: [
    { planId: 7, startWallMs: 1_760_000_000_016.5, solveMs: 41.2, timedOut: false },
    { planId: 8, startWallMs: 1_760_000_000_266, solveMs: 250, timedOut: true },
  ],
  refused: [7, { planId: 7, startWallMs: 0, solveMs: 0 }, { planId: "7", startWallMs: 0, solveMs: 0, timedOut: false }],
});

export const bodySurfaceToHost = defineToHost<BodySurface>({
  name: "bodySurface",
  from: "body",
  codec: bodySurfaceCodec,
  samples: [{ surface: [28, 30, 34, 255] }, { surface: null }],
  refused: [[28, 30, 34, 255], { surface: [28, 30, 34, 256] }],
});

/**
 * A rail member's deck-facing edge as its page paints it, for the host to
 * draw while a hand drags the rail's width: the pane's surface; the
 * border's colour at rest, held and past a limit; the border's width; and
 * the shadow the rail casts into its gutter, its colour and its reach; and
 * the fill the drag's ghost paints the rail's new footprint in, and the
 * colour of its deck-facing edge. The colours are sRGB bytes; the widths are
 * view points.
 */
export interface RailEdge {
  readonly surface: number[];
  readonly rest: number[];
  readonly held: number[];
  readonly limit: number[];
  readonly width: number;
  readonly shadow: number[];
  readonly reach: number;
  readonly fill: number[];
  readonly ghostEdge: number[];
}

const SAMPLE_RAIL_EDGE: RailEdge = {
  surface: [28, 30, 34, 255],
  rest: [60, 64, 70, 255],
  held: [70, 130, 230, 255],
  limit: [230, 160, 60, 255],
  width: 1,
  shadow: [0, 0, 0, 102],
  reach: 10,
  fill: [150, 150, 170, 41],
  ghostEdge: [150, 150, 170, 255],
};

/**
 * The host asks a rail member's page for its edge as a hand presses the
 * rail's edge. A page with no pane to read answers nothing, and the host
 * draws no edge for it.
 */
export const railEdgeCall = definePageCall({
  receiver: "bridge",
  member: "onRailEdge",
  codec: empty,
  replyCodec: nullable(
    obj({
      surface: rgbaBytes,
      rest: rgbaBytes,
      held: rgbaBytes,
      limit: rgbaBytes,
      width: num,
      shadow: rgbaBytes,
      reach: num,
      fill: rgbaBytes,
      ghostEdge: rgbaBytes,
    }),
  ),
  samples: [{}],
  refused: [true],
  replies: [SAMPLE_RAIL_EDGE, null],
  refusedReplies: [{ ...SAMPLE_RAIL_EDGE, held: [70, 130, 230] }, { ...SAMPLE_RAIL_EDGE, fill: undefined }, { ...SAMPLE_RAIL_EDGE, ghostEdge: undefined }, true],
});

/**
 * The shell asks for a card's body: which card, which kind, and what the body
 * is to do with it. `guardsClose` says the kind may veto its close, which only
 * its page can answer, so the host keeps that page through every eviction but
 * critical pressure's.
 */
export interface BodyCreate {
  readonly cardId: string;
  readonly componentId: string;
  readonly intent: Record<string, unknown>;
  readonly guardsClose?: boolean;
}

export const bodyCreateToHost = defineToHost<BodyCreate>({
  name: "bodyCreate",
  from: "shell",
  codec: obj({ cardId: str, componentId: str, intent: jsonObject, guardsClose: optional(bool) }),
  samples: [
    { cardId: "c1", componentId: "text", intent: { kind: "mount" }, guardsClose: true },
    { cardId: "c2", componentId: "session", intent: { kind: "mount" } },
  ],
  refused: [
    "c1",
    { cardId: "c1", intent: { kind: "mount" } },
    { cardId: "c1", componentId: "text", intent: "mount" },
    { cardId: "c1", componentId: "text", intent: { kind: "mount" }, guardsClose: "yes" },
  ],
});

/** The shell is done with a card's body; with `save`, the body writes its card's state first. */
export interface BodyDestroy {
  readonly cardId: string;
  readonly save: boolean;
}

export const bodyDestroyToHost = defineToHost<BodyDestroy>({
  name: "bodyDestroy",
  from: "shell",
  codec: obj({ cardId: str, save: bool }),
  samples: [{ cardId: "c1", save: false }],
  refused: ["c1", { cardId: "c1" }],
});

/**
 * The harness's seam on the host's body clocks, never sent by the product:
 * how long a hidden body keeps its process before the host evicts it, and
 * how long a new page has to say it is ready, ms — null for the host's own
 * constant. The app-tests shorten them through `__tug.bodyDelays`
 * (`test-surface.ts`), which sends this, and the host honours it only under
 * the harness.
 */
export interface BodyDelays {
  readonly evictAfterMs: number | null;
  readonly readyDeadlineMs: number | null;
}

export const bodyDelaysToHost = defineToHost<BodyDelays>({
  name: "bodyDelays",
  from: "shell",
  codec: obj({ evictAfterMs: nullable(num), readyDeadlineMs: nullable(num) }),
  samples: [
    { evictAfterMs: 1_500, readyDeadlineMs: null },
    { evictAfterMs: null, readyDeadlineMs: 50 },
  ],
  refused: [1_500, { evictAfterMs: "1500", readyDeadlineMs: null }],
});

/** The card whose body takes the keyboard, or null for the shell. */
export interface BodyFocus {
  readonly cardId: string | null;
}

export const bodyFocusToHost = defineToHost<BodyFocus>({
  name: "bodyFocus",
  from: "shell",
  codec: obj({ cardId: nullable(str) }),
  samples: [{ cardId: "c1" }, { cardId: null }],
  refused: [null, { cardId: 7 }],
});

/**
 * An incremental update has landed in the posting page: Vite's own stamp for
 * the update (ms since the epoch, on the dev server's clock, which is this
 * machine's) and how many modules it carried, so the host can log how long
 * the update took to reach each page.
 */
export interface HmrUpdate {
  readonly viteAt: number;
  readonly modules: number;
}

export const hmrUpdateToHost = defineToHost<HmrUpdate>({
  name: "hmrUpdate",
  from: "any",
  codec: obj({ viteAt: num, modules: num }),
  samples: [{ viteAt: 1792540800123, modules: 1 }],
  refused: [true, {}, { viteAt: "now", modules: 1 }],
});

// Host → page.

/** What the host knows of the window when it binds a body, before the shell's own facts reach it over the bus. */
export interface BindFacts {
  readonly theme: string;
  readonly zoom: number;
  readonly keyboardAccess: boolean;
  readonly appActive: boolean;
}

/** A body is told its card. */
export interface BodyBind {
  readonly cardId: string;
  /** The kind of card this body holds: the shell's deck's `componentId`. */
  readonly componentId: string;
  readonly intent: Record<string, unknown>;
  readonly facts: BindFacts;
}

const bind: BodyBind = {
  cardId: "c1",
  componentId: "text",
  intent: { kind: "mount" },
  facts: { theme: "ironclad", zoom: 1, keyboardAccess: false, appActive: true },
};

/** A body is told its card: which card, what to do with it, and the window's facts. */
export const bodyBindToPage = defineToPage<BodyBind>({
  member: "onBodyBind",
  to: "body",
  codec: obj({
    cardId: str,
    componentId: str,
    intent: jsonObject,
    facts: obj({ theme: str, zoom: num, keyboardAccess: bool, appActive: bool }),
  }),
  samples: [bind, { ...bind, intent: { kind: "restore" }, facts: { ...bind.facts, theme: "", zoom: 1.25 } }],
  refused: ["c1", { ...bind, facts: undefined }, { ...bind, intent: null }],
});

/** What the host reports of a body to the shell. */
export interface BodyStateReport {
  readonly cardId: string;
  /**
   * `covered`: the host stood an evicted card's last frame over the body
   * made to bring it back, which shows from its hand-off. A card with no
   * cover is told nothing and waits for `painted`.
   */
  readonly state: "ready" | "painted" | "landed" | "beatsCancelled" | "failed" | "terminated" | "evicted" | "covered";
  /** `ready`: bind → ready, ms. */
  readonly readyMs?: number;
  /** `ready`: whether the body began as the spare. */
  readonly start?: "warm" | "cold";
  /** `landed` / `beatsCancelled`: the beat plan the report is about. */
  readonly planId?: number;
  /** `landed`: how far past its start the plan reached the host, ms. */
  readonly lateMs?: number;
  /**
   * `failed`: why the host gave the body up. `evicted`: what took its
   * process — `pressure-warning`, `pressure-critical`, or `hidden` for a
   * body hidden past the host's eviction delay.
   */
  readonly cause?: string;
}

/** Where a body stands, told to the shell. */
export const bodyStateToPage = defineToPage<BodyStateReport>({
  member: "onBodyState",
  to: "shell",
  codec: obj({
    cardId: str,
    state: literal("ready", "painted", "landed", "beatsCancelled", "failed", "terminated", "evicted", "covered"),
    readyMs: optional(num),
    start: optional(literal("warm", "cold")),
    planId: optional(num),
    lateMs: optional(num),
    cause: optional(str),
  }),
  samples: [
    { cardId: "c1", state: "ready", readyMs: 412, start: "warm" },
    { cardId: "c1", state: "painted" },
    { cardId: "c1", state: "landed", planId: 7, lateMs: 3.5 },
    { cardId: "c1", state: "beatsCancelled", planId: 7 },
    { cardId: "c1", state: "failed", cause: "deadline" },
    { cardId: "c1", state: "evicted", cause: "pressure-critical" },
    { cardId: "c1", state: "covered" },
  ],
  refused: ["ready", { cardId: "c1", state: "asleep" }, { cardId: "c1", state: "landed", planId: "7" }, { state: "ready" }],
});

/**
 * Whether anyone can see the body: shown while its container paints (a
 * sibling behind its pane's active card included), not while the host has
 * hidden it (a parked or folded body). `since` is when it last changed,
 * wall-clock ms, comparable with the page's `Date.now()`.
 */
export interface BodyVisibility {
  readonly shown: boolean;
  readonly since: number;
}

/** A body is told whether it is shown, on bind and on every change. */
export const bodyVisibilityToPage = defineToPage<BodyVisibility>({
  member: "onBodyVisibility",
  to: "body",
  codec: obj({ shown: bool, since: num }),
  samples: [
    { shown: true, since: 1_760_000_000_000 },
    { shown: false, since: 1_760_000_060_000.5 },
  ],
  refused: [true, { shown: "yes", since: 0 }, { shown: false }],
});

// The host's calls into `window.tugdeck`.

/** Write every card's state now, synchronously: the degraded save and the reload's. */
export const saveStateCall = definePageCall({
  receiver: "tugdeck",
  member: "saveState",
  codec: empty,
  replyCodec: noReply,
  samples: [{}],
  refused: [true],
  replies: [null],
  refusedReplies: [true, {}],
});

/** A page's account of its half of a quit, which the host logs. */
const terminationVerdict: Codec<TerminationVerdict> = obj({
  ok: bool,
  interrupted: arr(str),
  unacknowledged: arr(str),
  flushedCards: num,
  failedCards: arr(str),
  layoutSaved: bool,
  elapsedMs: num,
});

/** The page's half of a quit; its reply is the verdict the host logs. */
export const prepareForTerminationCall = definePageCall({
  receiver: "tugdeck",
  member: "prepareForTermination",
  codec: empty,
  replyCodec: terminationVerdict,
  samples: [{}],
  refused: [true],
  replies: [
    { ok: true, interrupted: [], unacknowledged: [], flushedCards: 3, failedCards: [], layoutSaved: true, elapsedMs: 41.5 },
    { ok: false, interrupted: ["s1"], unacknowledged: ["s2"], flushedCards: 1, failedCards: ["c2"], layoutSaved: true, elapsedMs: 3500 },
  ],
  refusedReplies: [
    { ok: true },
    "ok",
    { ok: true, interrupted: [], unacknowledged: [], flushedCards: "3", failedCards: [], layoutSaved: true, elapsedMs: 41.5 },
  ],
});

/** Tugcast restarted: take its new session cookie and reconnect. */
export const reauthenticateCall = definePageCall({
  receiver: "tugdeck",
  member: "reauthenticate",
  codec: obj({ token: str }),
  replyCodec: noReply,
  samples: [{ token: "t0k3n" }],
  refused: ["t0k3n", {}, { token: 7 }],
  replies: [null],
  refusedReplies: [true],
});
