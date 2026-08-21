/**
 * imposer-gauges.ts — one channel carrying the deck's per-frame truth to any
 * instrument that wants to be live.
 *
 * [L06] is why an instrument outside the canvas is normally blind: per-frame
 * motion may never route through React state, so a scroll or a drag reaches
 * only the elements the canvas writes custom properties onto. This channel
 * extends that same mechanism across subtrees. A gauge REGISTERS an element
 * for a named signal; the canvas's existing per-frame writers PUBLISH to that
 * signal; the publisher writes the value onto every registered element as a
 * custom property. No store, no state, no render — the Lens's miniature can
 * track a drag frame-for-frame without React learning that anything moved.
 *
 * The signals:
 *
 * - `flow-offset` — how far the flow strip has slid under the band.
 * - `column-offset:<slot>` — how far an overflowing column's strip has slid.
 * - `drag-frame` — where the dragged frame stands on the canvas.
 * - `drag-zone` — where the indicated drop zone stands on the canvas.
 *
 * **Every value is a unitless FRACTION**, and that is the contract's load-
 * bearing decision. An offset is a fraction of the band or run it slides
 * under; a rect is a fraction of the canvas box. A consumer drawing at another
 * scale — the miniature is a deck a hundredth of the size — cannot convert a
 * pixel it is given, because CSS cannot divide a length by a length: there is
 * no `calc(var(--x) / var(--band))`. A fraction needs no conversion at all. It
 * multiplies straight into whatever unit the consumer draws in
 * (`calc(var(--gauge-drag-x, 0) * 100%)`), which is the same reason the
 * miniature's committed column slides have always been passed as fractions.
 *
 * Committed values keep flowing through the store as they do today; the gauges
 * carry the motion BETWEEN commits. So a consumer's CSS composes
 * `var(--gauge-…, <committed fallback>)`: with no publisher ever having run,
 * the drawing stands at its committed truth and nothing has to prime it.
 *
 * Publishing is free when nobody is listening — every publisher takes the
 * `Set.size` fast path out before it formats a number. Registration is a
 * layout-effect concern ([L03]) and its teardown REMOVES the properties it
 * published, so a remounted gauge starts at rest rather than at whatever the
 * last drag left behind.
 *
 * A registration arriving mid-gesture is not a special case: the channel
 * remembers the last value published for each signal and primes a newly
 * registered element with it, so an instrument mounted during a drag draws the
 * drag rather than waiting for the next frame.
 *
 * @module lib/imposer-gauges
 */

/** A rect in the gauge channel's units: fractions of the canvas box. */
export interface GaugeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The name of a signal. `column-offset` is per-slot because each column
 *  slides on its own. */
export type GaugeSignal =
  | "flow-offset"
  | `column-offset:${number}`
  | "drag-frame"
  | "drag-zone";

/** The signal a given slot's column offset publishes on. */
export function columnOffsetSignal(slot: number): GaugeSignal {
  return `column-offset:${slot}`;
}

/**
 * The custom properties a signal writes — the whole of what it may touch, and
 * therefore exactly what unregistration takes away.
 */
export function gaugeProperties(signal: GaugeSignal): readonly string[] {
  if (signal === "flow-offset") return ["--gauge-flow-offset"];
  if (signal === "drag-frame") {
    return ["--gauge-drag-x", "--gauge-drag-y", "--gauge-drag-w", "--gauge-drag-h"];
  }
  if (signal === "drag-zone") {
    return ["--gauge-zone-x", "--gauge-zone-y", "--gauge-zone-w", "--gauge-zone-h"];
  }
  return [`--gauge-column-offset-${signal.slice("column-offset:".length)}`];
}

/** Registered elements, per signal. Module-level and deliberately not a store:
 *  a subscription list that renders nothing needs no notification machinery. */
const subscribers = new Map<GaugeSignal, Set<HTMLElement>>();

/** The last value published per signal, so a late registration draws the
 *  gesture already in progress rather than the rest state. */
const latest = new Map<GaugeSignal, ReadonlyMap<string, string> | null>();

/** Whether a zone drag is live, and whether it is currently offering a place.
 *  Both are mirrored onto every registered element as attributes so pure CSS
 *  can gate drag-only affordances — and they are two facts, not one: a ⌘-freed
 *  stretch is a drag offering nothing. */
let dragActive = false;
let zoneActive = false;

/**
 * Register `el` for `signal` and return the unregistration.
 *
 * The returned function is the teardown of the layout effect that called this
 * ([L03]); it drops the element and removes every property the signal writes,
 * because an element that stopped listening must not keep drawing the last
 * frame it heard.
 */
export function registerGauge(signal: GaugeSignal, el: HTMLElement): () => void {
  const set = subscribers.get(signal) ?? new Set<HTMLElement>();
  set.add(el);
  subscribers.set(signal, set);
  const standing = latest.get(signal);
  if (standing != null) {
    for (const [property, value] of standing) el.style.setProperty(property, value);
  }
  if (dragActive) el.setAttribute("data-gauge-drag", "true");
  if (zoneActive) el.setAttribute("data-gauge-zone", "true");
  return () => {
    const live = subscribers.get(signal);
    live?.delete(el);
    if (live !== undefined && live.size === 0) subscribers.delete(signal);
    for (const property of gaugeProperties(signal)) {
      el.style.removeProperty(property);
    }
    el.removeAttribute("data-gauge-drag");
    el.removeAttribute("data-gauge-zone");
  };
}

/** How many elements are listening to `signal` — the publishers' fast path,
 *  and what an app-test asserts the lifecycle against. */
export function gaugeSubscriberCount(signal: GaugeSignal): number {
  return subscribers.get(signal)?.size ?? 0;
}

/** Write one signal's properties onto every element registered for it. `null`
 *  retires the signal: the properties come off and the fallbacks take over. */
function publish(
  signal: GaugeSignal,
  values: ReadonlyMap<string, string> | null,
): void {
  const set = subscribers.get(signal);
  latest.set(signal, values);
  if (set === undefined || set.size === 0) return;
  for (const el of set) {
    if (values === null) {
      for (const property of gaugeProperties(signal)) {
        el.style.removeProperty(property);
      }
      continue;
    }
    for (const [property, value] of values) el.style.setProperty(property, value);
  }
}

/** Numbers cross the channel at a fixed precision: a gauge is read by CSS, not
 *  compared for equality, and four places is finer than any drawing can show
 *  while keeping the property strings short. */
function fixed(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "0";
}

function rectValues(prefix: string, rect: GaugeRect): ReadonlyMap<string, string> {
  return new Map([
    [`--gauge-${prefix}-x`, fixed(rect.x)],
    [`--gauge-${prefix}-y`, fixed(rect.y)],
    [`--gauge-${prefix}-w`, fixed(rect.width)],
    [`--gauge-${prefix}-h`, fixed(rect.height)],
  ]);
}

/** How far the flow strip stands, as a fraction of the band it slides under. */
export function publishFlowOffset(fraction: number | null): void {
  publish(
    "flow-offset",
    fraction === null ? null : new Map([["--gauge-flow-offset", fixed(fraction)]]),
  );
}

/** How far one column's strip stands, as a fraction of the run. */
export function publishColumnOffset(slot: number, fraction: number | null): void {
  const signal = columnOffsetSignal(slot);
  publish(
    signal,
    fraction === null
      ? null
      : new Map([[gaugeProperties(signal)[0], fixed(fraction)]]),
  );
}

/**
 * Where the dragged frame stands, in fractions of the canvas box — and, with
 * it, whether a drag is happening at all. `null` retires the frame and takes
 * `data-gauge-drag` off every registered element, which is what makes the
 * drag-only affordances disappear without a render.
 */
export function publishDragFrame(rect: GaugeRect | null): void {
  publish("drag-frame", rect === null ? null : rectValues("drag", rect));
  setDragActive(rect !== null);
}

/** Where the indicated zone stands, in fractions of the canvas box. `null` is
 *  the ⌘-freed stretch: no place is being offered, and the highlight goes —
 *  while the drag itself, and its ghost, carry on. */
export function publishDragZone(rect: GaugeRect | null): void {
  publish("drag-zone", rect === null ? null : rectValues("zone", rect));
  zoneActive = rect !== null;
  stamp("data-gauge-zone", zoneActive);
}

function setDragActive(active: boolean): void {
  if (active === dragActive) return;
  dragActive = active;
  stamp("data-gauge-drag", active);
  // A drag that ends takes its indication with it: no gesture, no place being
  // offered. Publishing the retirement rather than assuming it keeps the two
  // attributes from disagreeing after a cancel.
  if (!active) publishDragZone(null);
}

/**
 * Mirror a boolean onto every registered element as an attribute, so pure CSS
 * can gate an affordance on it. Present or absent rather than `"true"/"false"`:
 * an absent attribute is the rest state, and `[data-gauge-drag]` is then the
 * whole selector.
 */
function stamp(attribute: string, on: boolean): void {
  for (const set of subscribers.values()) {
    for (const el of set) {
      if (on) el.setAttribute(attribute, "true");
      else el.removeAttribute(attribute);
    }
  }
}
