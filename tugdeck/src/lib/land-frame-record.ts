/**
 * The land record — how long the frame that ends a settle took, and what ran
 * in it.
 *
 * A settle has two hard bars under set-up-and-go: no frame over one display
 * period from the first frame to the land, and a land of one frame. The
 * `settle-frames` row answers the first and is blind to the second by
 * construction: it is written at the release, which is the land, so the frame
 * the land's hand-back costs — the held boxes given back, the still-crossing
 * mark taken off, the list view's owed pin, restore and extent rebase — is
 * painted after the record has closed. The land's 35–49 ms on a fold was read
 * off a hand-rolled frame recorder for that reason, and nothing shipped could
 * say what ran in it.
 *
 * This module is that record. The land frame is read from the ticks either
 * side of the land: the last tick before it, and the two after. Two, because
 * the land's own task runs in a rendering update's animation step, ahead of
 * the frame callbacks — so the first tick after it lands before the style,
 * layout and `ResizeObserver` deliveries the hand-back dirtied, and only the
 * second closes the frame that paid for them. `frameMs` is the longer of the
 * two gaps, and every event in the span between the first and the last of
 * the three ticks is the land's.
 *
 * What ran there is named by site, from three sources:
 *
 * - **Commits**, from the commit census (`window.__tugCommits`), which the
 *   page carries in test mode and beside the lead recorder. Without it the
 *   record says `null` rather than zero: a page that cannot count commits has
 *   not counted none.
 * - **Forced layouts**: every geometry read that took over
 *   {@link FORCED_READ_FLOOR_MS}, with the stack that asked. A read that slow
 *   paid a style or layout flush, and a forced layout is paid by whichever
 *   script reads first — so the stack names who forced it, which a commit
 *   census cannot. The stack is taken only for a slow read, so the record
 *   does not price itself into the frame it measures.
 * - **`ResizeObserver` deliveries**, each callback's own time and the element
 *   its first entry names, counted by a wrapper installed when the bundle
 *   evaluates — in test mode and beside the lead recorder only, the same
 *   pages the commit census is in. Elsewhere `null`, for the same reason.
 *
 * It is a BENCH RECORD. The read wrappers go on at the first arm and stay,
 * passing straight through whenever nothing is armed; the settle arms it only
 * while the cost-bearing `settle-frames` kind is enabled, so a deck nobody is
 * measuring never wraps a getter. The classification is pure and lives apart
 * from the DOM reader ({@link classifyLand}), so the arithmetic is testable as
 * data.
 *
 * @module lib/land-frame-record
 */

/** A geometry read slower than this paid a style or layout flush. */
export const FORCED_READ_FLOOR_MS = 1;

/**
 * How many events of each kind one settle keeps.
 *
 * A session card reacting to its height reads geometry in a loop, so a slow
 * read can repeat hundreds of times over a whale's settle. The record stops
 * rather than rolling, for the chain probe's reason: the earliest event is
 * the one under the land, and a ring would drop it.
 */
export const LAND_EVENT_CAP = 2000;

/** Frames of stack a forced read keeps above the wrapper. */
const STACK_FRAMES = 4;

/** One timed event: a forced read or an observer delivery. */
export interface LandEvent {
  /** `performance.now()` when it began. */
  readonly t: number;
  /** Its own time, in ms. */
  readonly ms: number;
  /** Who: a stack for a read, the observed element for a delivery. */
  readonly site: string;
}

/** One React commit, as the census recorded it. */
export interface LandCommit {
  readonly t: number;
  readonly performed: number;
  /** The component that asked first — the top of the cascade. */
  readonly site: string;
}

/** What {@link classifyLand} is read over. */
export interface LandInput {
  /** Every tick of the settle and the two after its land, in order. */
  readonly ticks: readonly number[];
  /** A moment inside the land's own task, on the ticks' clock. */
  readonly landAt: number;
  /** The settle's origin, so the land can be placed along it. */
  readonly gestureAt: number;
  readonly framePeriodMs: number;
  /** `null` when the page had no commit census. */
  readonly commits: readonly LandCommit[] | null;
  readonly forcedReads: readonly LandEvent[];
  /** `null` when no delivery wrapper was installed. */
  readonly deliveries: readonly LandEvent[] | null;
}

/** The land, as the `settle-land` row carries it. */
export interface LandReading {
  /** The gesture to the land, in ms. */
  readonly landAtMs: number;
  /**
   * The longer of the two gaps the land touched: the last tick before it to
   * the first after, and that to the next. `-1` when no tick followed.
   */
  readonly frameMs: number;
  /** {@link LandReading.frameMs} in display frames. */
  readonly frameFrames: number;
  /** Both gaps, in order. */
  readonly gapsMs: readonly number[];
  readonly framePeriodMs: number;
  /** The commits in the land's span; `null` with no census. */
  readonly commits: readonly LandCommit[] | null;
  /** The forced reads in the land's span. */
  readonly forcedLayouts: readonly LandEvent[];
  /** The observer deliveries in the land's span; `null` with no wrapper. */
  readonly deliveries: readonly LandEvent[] | null;
}

/**
 * Read the land off the ticks around it.
 *
 * The span opens at the last tick before `landAt` and closes at the second
 * tick at or after it, or the first when only one came; an event belongs to
 * the land when it began inside it. A land with no tick before it opens at
 * `landAt` itself, which only drops the part of the frame before the land's
 * own task — the arm of a settle that landed on its first tick has no earlier
 * tick to offer.
 */
export function classifyLand(input: LandInput): LandReading {
  const { ticks, landAt } = input;
  const before = landOpensAt(ticks, landAt);
  const after: number[] = [];
  for (const t of ticks) {
    if (t >= landAt && after.length < 2) after.push(t);
  }
  const gapsMs: number[] = [];
  let previous = before;
  for (const t of after) {
    gapsMs.push(t - previous);
    previous = t;
  }
  const end = after.length > 0 ? after[after.length - 1] : landAt;
  const inSpan = <T extends { readonly t: number }>(events: readonly T[]): T[] =>
    events.filter((event) => event.t > before && event.t <= end);
  const frameMs = gapsMs.length === 0 ? -1 : Math.max(...gapsMs);
  return {
    landAtMs: landAt - input.gestureAt,
    frameMs,
    frameFrames: frameMs < 0 ? -1 : frameMs / input.framePeriodMs,
    gapsMs,
    framePeriodMs: input.framePeriodMs,
    commits: input.commits === null ? null : inSpan(input.commits),
    forcedLayouts: inSpan(input.forcedReads),
    deliveries: input.deliveries === null ? null : inSpan(input.deliveries),
  };
}

/** What ran inside the motion: the gate's three zero clauses ([B05]). */
export interface MotionEvents {
  /** `null` when the page had no commit census. */
  readonly commits: readonly LandCommit[] | null;
  readonly forcedLayouts: readonly LandEvent[];
  /** `null` when no delivery wrapper was installed. */
  readonly deliveries: readonly LandEvent[] | null;
}

/**
 * Where the land's span opens: the last tick before `landAt`, or `landAt`
 * itself when no tick came before it. The land owns what began after it; the
 * motion owns what began before.
 */
export function landOpensAt(ticks: readonly number[], landAt: number): number {
  let before = landAt;
  for (const t of ticks) {
    if (t < landAt) before = t;
  }
  return before;
}

/**
 * The events that began inside the motion — after `motionAt`, when the beats
 * launched and the gate closed, and no later than `landOpens`, the tick the
 * land's span opens at ({@link landOpensAt}). Under set-up-and-go every list
 * is empty: the set-up paid its commit, its layout and its deliveries before
 * the first frame, and the land's own — the hand-back's flush included — are
 * the `settle-land` row's, so no event is read by both.
 */
export function classifyMotionEvents(
  input: Pick<LandInput, "commits" | "forcedReads" | "deliveries">,
  motionAt: number,
  landOpens: number,
): MotionEvents {
  const inMotion = <T extends { readonly t: number }>(events: readonly T[]): T[] =>
    events.filter((event) => event.t > motionAt && event.t <= landOpens);
  return {
    commits: input.commits === null ? null : inMotion(input.commits),
    forcedLayouts: inMotion(input.forcedReads),
    deliveries: input.deliveries === null ? null : inMotion(input.deliveries),
  };
}

// ---------------------------------------------------------------------------
// The DOM half
// ---------------------------------------------------------------------------

/** The census's commit shape, as far as this module reads it. */
interface CensusCommit {
  readonly t: number;
  readonly performed: number;
  readonly origins?: readonly (readonly [string, number])[];
  readonly top?: readonly (readonly [string, number])[];
  /** Per origin, the hook slots and contexts whose value moved. */
  readonly hooks?: readonly string[];
}

interface CensusApi {
  since(t: number): readonly CensusCommit[];
}

declare global {
  interface Window {
    __tugCommits?: CensusApi;
  }
}

/** The geometry getters a forced layout is paid through. */
const READ_GETTERS: readonly { readonly proto: () => object; readonly name: string }[] = [
  { proto: () => Element.prototype, name: "clientWidth" },
  { proto: () => Element.prototype, name: "clientHeight" },
  { proto: () => Element.prototype, name: "scrollTop" },
  { proto: () => Element.prototype, name: "scrollHeight" },
  { proto: () => Element.prototype, name: "scrollWidth" },
  { proto: () => HTMLElement.prototype, name: "offsetWidth" },
  { proto: () => HTMLElement.prototype, name: "offsetHeight" },
  { proto: () => HTMLElement.prototype, name: "offsetTop" },
  { proto: () => HTMLElement.prototype, name: "offsetLeft" },
];

/** The geometry methods a forced layout is paid through. */
const READ_METHODS: readonly { readonly proto: () => object; readonly name: string }[] = [
  { proto: () => Element.prototype, name: "getBoundingClientRect" },
  { proto: () => Element.prototype, name: "getClientRects" },
];

function stackSite(): string {
  const lines = String(new Error().stack ?? "").split("\n");
  // `Error`, this function, `record`, the wrapper; the caller is next.
  return lines
    .filter((line) => line.trim() !== "" && line.trim() !== "Error")
    .slice(3, 3 + STACK_FRAMES)
    .map((line) => line.trim().replace(/https?:\/\/[^/]+\/(?:assets\/)?/, ""))
    .join(" < ");
}

/** The element a delivery's first entry names, as `tag.class ×entries`. */
function deliverySite(entries: readonly ResizeObserverEntry[]): string {
  const target = entries[0]?.target;
  if (target === undefined) return "-";
  const cls = target.classList.item(0);
  return `${target.tagName.toLowerCase()}${cls === null ? "" : `.${cls}`} ×${entries.length}`;
}

/**
 * The armed recorder. One instance per document; the settle arms it with its
 * frame record and takes it at the land.
 */
class LandRecorder {
  private armed = false;
  private asideLabel: string | null = null;
  private readsInstalled = false;
  private reads: LandEvent[] = [];
  private delivered: LandEvent[] = [];
  /** Whether this page counts observer deliveries at all. */
  deliveriesCounted = false;

  /** Start keeping events. The read wrappers go on the first time. */
  arm(): void {
    this.installReads();
    this.reads = [];
    this.delivered = [];
    this.armed = true;
  }

  /** Stop keeping events and drop what was kept. */
  disarm(): void {
    this.armed = false;
    this.reads = [];
    this.delivered = [];
  }

  /**
   * Run `fn` as an instrument's own reads — the settle's sampler, or the
   * bench probe beside it.
   *
   * An instrument's first read in a frame pays whatever flush the deck left
   * pending, so dropping its slow reads would lose that cost and naming them
   * by stack would blame the instrument. They are kept under `[label]`, which
   * says the flush was the deck's and only the paying read was ours.
   */
  aside<T>(label: string, fn: () => T): T {
    const outer = this.asideLabel;
    this.asideLabel = outer ?? label;
    try {
      return fn();
    } finally {
      this.asideLabel = outer;
    }
  }

  /** The land's inputs from everything kept since the arm. */
  take(from: number): Pick<LandInput, "commits" | "forcedReads" | "deliveries"> {
    const census = typeof window === "undefined" ? undefined : window.__tugCommits;
    const commits =
      census === undefined
        ? null
        : census.since(from).map((c) => ({
            t: c.t,
            performed: c.performed,
            // The first origin's moved hooks name the cause, where the
            // census caught them; the origin's name alone otherwise.
            site: c.hooks?.[0] ?? c.origins?.[0]?.[0] ?? c.top?.[0]?.[0] ?? "-",
          }));
    return {
      commits,
      forcedReads: this.reads.slice(),
      deliveries: this.deliveriesCounted ? this.delivered.slice() : null,
    };
  }

  /** Called by a read wrapper with the read's start and its own time. */
  read(start: number, ms: number): void {
    if (!this.armed || ms <= FORCED_READ_FLOOR_MS) return;
    if (this.reads.length >= LAND_EVENT_CAP) return;
    const site = this.asideLabel === null ? stackSite() : `[${this.asideLabel}]`;
    this.reads.push({ t: start, ms, site });
  }

  /** Called by the delivery wrapper around an observer's callback. */
  deliver(cb: () => void, entries: readonly ResizeObserverEntry[]): void {
    if (!this.armed || this.delivered.length >= LAND_EVENT_CAP) {
      cb();
      return;
    }
    const start = performance.now();
    try {
      cb();
    } finally {
      this.delivered.push({
        t: start,
        ms: performance.now() - start,
        site: deliverySite(entries),
      });
    }
  }

  private installReads(): void {
    if (this.readsInstalled || typeof Element === "undefined") return;
    this.readsInstalled = true;
    const recorder = this;
    for (const { proto, name } of READ_GETTERS) {
      const owner = proto();
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      const get = descriptor?.get;
      if (descriptor === undefined || get === undefined) continue;
      Object.defineProperty(owner, name, {
        configurable: true,
        enumerable: descriptor.enumerable,
        set: descriptor.set,
        get(this: unknown) {
          if (!recorder.armed) return get.call(this);
          const start = performance.now();
          const value = get.call(this);
          recorder.read(start, performance.now() - start);
          return value;
        },
      });
    }
    for (const { proto, name } of READ_METHODS) {
      const owner = proto() as Record<string, unknown>;
      const original = owner[name];
      if (typeof original !== "function") continue;
      owner[name] = function (this: unknown, ...args: unknown[]) {
        if (!recorder.armed) return original.apply(this, args);
        const start = performance.now();
        const value = original.apply(this, args);
        recorder.read(start, performance.now() - start);
        return value;
      };
    }
  }
}

export const landRecorder = new LandRecorder();

/**
 * Wrap `ResizeObserver` so a delivery can be timed and named.
 *
 * It has to be in place before any observer is constructed, so it runs when
 * this module evaluates — and only on a page that is already carrying the
 * commit census (test mode, or the lead recorder), where an extra branch per
 * delivery is part of being measured. Off both, the platform's own
 * constructor is left alone and the record says it did not count.
 */
function installDeliveryWrapper(): void {
  if (typeof window === "undefined") return;
  const measured =
    (window as { __tugTestMode?: boolean }).__tugTestMode === true ||
    window.__tugLead !== undefined;
  const Native = window.ResizeObserver;
  if (!measured || typeof Native !== "function") return;
  const Wrapped = function (
    callback: ResizeObserverCallback,
  ): ResizeObserver {
    return new Native((entries, observer) => {
      landRecorder.deliver(() => callback(entries, observer), entries);
    });
  } as unknown as typeof ResizeObserver;
  Wrapped.prototype = Native.prototype;
  window.ResizeObserver = Wrapped;
  landRecorder.deliveriesCounted = true;
}

installDeliveryWrapper();
