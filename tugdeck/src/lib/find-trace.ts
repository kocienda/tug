/**
 * find-trace — a bounded, always-recording ring buffer of structured find
 * events, used to reconstruct what find actually did inside the real Tug.app
 * WKWebView.
 *
 * ## Why this exists
 *
 * Find's failures are failures of *agreement* between three machines that
 * each believe they are right. The count comes from a projected text index
 * (`transcript-search-index.ts`); the paint comes from a walk over the live
 * DOM (`transcript-find-highlighter.ts`); the reveal comes from a scroller
 * that can be moved by a dozen other things in the same frame. When find
 * lands on the wrong thing, every one of those three reports success, and a
 * screenshot cannot say which of them was lying. The three event kinds below
 * are the three joints:
 *
 *  - `gesture` — what the user asked for, and what the engine answered with.
 *  - `reveal` — whether that answer reached the screen, and if not, why.
 *  - `divergence` — where the index's text and the DOM's text disagree,
 *    which is the defect that makes a correct count paint the wrong range.
 *
 * ## Always recording
 *
 * Unlike `deck-trace`, this ring has no enable flag. Every kind it holds is
 * a record of a *defect* rather than of an interaction under study, and the
 * sessions that hold the evidence are by definition the ones nobody was
 * watching. Recording is allocation-light by contract: `record` does no DOM
 * reads and no work beyond what the caller already holds, so call sites may
 * sit in the paint path without metering concerns.
 *
 * ## Bounded ring
 *
 * Capacity is {@link FIND_TRACE_CAPACITY} (512) entries; the 513th record
 * drops the first. `dump({since})` returns everything recorded after a `seq`
 * previously returned by `mark()` — the standard flow is
 * `const m = findTrace.mark()` → interact → `findTrace.dump({ since: m })`.
 *
 * `window.__findTrace` is bound in every build, release included, so a
 * developer can drive the trace from the Web Inspector console and an
 * app-test can read it through one `evalJS`.
 *
 * @module lib/find-trace
 */

/**
 * Where a match lives, in the coordinates the engine and the painter share.
 * `kind` distinguishes a match painted by the transcript's DOM walk from one
 * inside an embedded CodeMirror, which paints through the editor's own
 * search and has no `Range` at all.
 */
export interface FindAddress {
  row: number;
  segment: number;
  start: number;
  end: number;
  kind: "dom" | "editor";
}

/** Ring capacity. Fixed at 512 entries, matching `deck-trace`'s. */
export const FIND_TRACE_CAPACITY = 512;

/**
 * One recorded find event. `seq` is monotonic across every kind and `t` is
 * `performance.now()` at record time; both are stamped by {@link
 * FindTrace.record} rather than supplied by the caller.
 */
export type FindTraceEvent =
  | {
      kind: "gesture";
      seq: number;
      t: number;
      surface: "transcript" | "text";
      cardId: string | null;
      gesture: "query" | "options" | "next" | "previous" | "attach";
      navSeq: number;
      query: string;
      count: number;
      activeOrdinal: number | null;
      target: FindAddress | null;
    }
  | {
      kind: "reveal";
      seq: number;
      t: number;
      cardId: string | null;
      navSeq: number;
      target: FindAddress | null;
      /**
       * The four terminal outcomes of `TugListView.revealRange`, and the
       * whole of them: a reveal that neither landed nor gave up is the
       * defect this vocabulary exists to make impossible to record.
       */
      outcome: "landed" | "failed" | "superseded" | "cancelled";
      reason: string | null;
      ms: number;
      writes: number;
    }
  | {
      kind: "divergence";
      seq: number;
      t: number;
      cardId: string | null;
      row: number;
      unit: number;
      cause: "unit-count" | "text";
      indexUnits: number;
      domUnits: number;
      /** First differing character offset; `-1` for a `unit-count` cause. */
      firstDiffAt: number;
      /**
       * For a `text` cause, 40 characters around `firstDiffAt`. For a
       * `unit-count` cause there is no offset, so each side is instead the
       * quoted head of every unit it holds, in order — the only form of the
       * finding that names which unit the two sides disagree about.
       */
      indexSample: string;
      domSample: string;
      healed: boolean;
    };

/** The stamped fields — supplied by the module, never by the caller. */
type StampedFields = "seq" | "t";

/**
 * The payload shape of {@link FindTrace.record}. Spelled per-variant rather
 * than as one `Omit` over the union, because `Omit` does not distribute and
 * would collapse the three variants into one shape that accepts any mixture
 * of their fields.
 */
export type FindTraceEventInput =
  | Omit<Extract<FindTraceEvent, { kind: "gesture" }>, StampedFields>
  | Omit<Extract<FindTraceEvent, { kind: "reveal" }>, StampedFields>
  | Omit<Extract<FindTraceEvent, { kind: "divergence" }>, StampedFields>;

export interface FindTrace {
  /** Stamp `seq` and `t` onto `event` and append it to the ring. */
  record(event: FindTraceEventInput): void;
  /**
   * The ring's contents in record order, oldest first. With `since`, only
   * the events whose `seq` is greater than it — i.e. everything recorded
   * after the {@link FindTrace.mark} that returned it.
   */
  dump(opts?: { since?: number }): readonly FindTraceEvent[];
  /** The current `seq`, for a later `dump({ since })`. */
  mark(): number;
  /** Empty the ring. Does not reset `seq`, so marks stay comparable. */
  clear(): void;
}

let buffer: FindTraceEvent[] = [];
let head = 0;
let full = false;
let seqCounter = 0;

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function readOrdered(): FindTraceEvent[] {
  if (!full) return buffer.slice();
  return buffer.slice(head).concat(buffer.slice(0, head));
}

/** The module's singleton trace instance. */
export const findTrace: FindTrace = {
  record(event) {
    const stamped = { ...event, seq: ++seqCounter, t: now() } as FindTraceEvent;
    if (full) {
      buffer[head] = stamped;
      head = (head + 1) % FIND_TRACE_CAPACITY;
    } else {
      buffer.push(stamped);
      if (buffer.length === FIND_TRACE_CAPACITY) {
        full = true;
        head = 0;
      }
    }
  },
  dump(opts) {
    const rows = readOrdered();
    const since = opts?.since;
    if (since === undefined) return rows;
    return rows.filter((e) => e.seq > since);
  },
  mark() {
    return seqCounter;
  },
  clear() {
    buffer = [];
    head = 0;
    full = false;
  },
};

/**
 * The 40 characters of `text` centred on `at` — the sample a `divergence`
 * carries so a reader can see WHAT differs without the whole row's text in
 * the ring. Clamped to the string's bounds; `at < 0` yields the empty
 * string, which is the `unit-count` case.
 */
export function sampleAround(text: string, at: number, width = 40): string {
  if (at < 0) return "";
  const half = Math.floor(width / 2);
  const start = Math.max(0, at - half);
  return text.slice(start, start + width);
}

/**
 * What the last recorded gesture knew, so the next one can say what changed.
 * A find surface holds one of these and hands it to {@link inferFindGesture}.
 */
export interface FindGestureSnapshot {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  grep: boolean;
  activeOrdinal: number | null;
  count: number;
}

/**
 * Name the gesture that produced `next`, given what the surface last
 * recorded. There is no gesture channel to read — the session publishes
 * state, not verbs — so the name is inferred from what moved: a changed
 * query is a `"query"`, a changed option is an `"options"`, and anything
 * else that moved the active ordinal is a `"next"` or a `"previous"` by its
 * direction. The wrap cases (last → first, first → last) are read as the
 * direction that wraps rather than by raw arithmetic. With no previous
 * snapshot the surface has just attached, which is `"attach"`.
 */
export function inferFindGesture(
  prev: FindGestureSnapshot | null,
  next: FindGestureSnapshot,
): "query" | "options" | "next" | "previous" | "attach" {
  if (prev === null) return "attach";
  if (prev.query !== next.query) return "query";
  if (
    prev.caseSensitive !== next.caseSensitive ||
    prev.wholeWord !== next.wholeWord ||
    prev.grep !== next.grep
  ) {
    return "options";
  }
  const a = prev.activeOrdinal;
  const b = next.activeOrdinal;
  if (a === null || b === null) return "next";
  if (b === a) return "next";
  // A wrap moves the ordinal the long way round; the direction is the short
  // way. Over a set of `count`, last → first is a forward wrap.
  const n = next.count;
  if (n > 1 && a === n - 1 && b === 0) return "next";
  if (n > 1 && a === 0 && b === n - 1) return "previous";
  return b > a ? "next" : "previous";
}

/**
 * Global `window.__findTrace` handle, for ad-hoc reproduction from the Web
 * Inspector console and for app-tests reading outcomes through `evalJS`.
 * Typed via `declare global` so the assignment does not route through
 * `Record<string, unknown>`, mirroring `deck-trace.ts`.
 */
declare global {
  interface Window {
    __findTrace?: FindTrace;
  }
}

// Bound unconditionally, release builds included, for the same reason
// `deck-trace` is: the ring records defect evidence on every build, and a
// handle that exists only under `import.meta.env.DEV` makes that evidence
// unreachable in exactly the sessions that carry it. No side-effect import
// is needed — the find modules that record import this one, and they are
// always loaded.
if (typeof window !== "undefined") {
  window.__findTrace = findTrace;
}
