/**
 * session-dot-layer — the live phase dot that sits in the composer chip's well.
 *
 * The chip is a baked `<img>` because that is the one element WebKit's editing
 * engine treats as an atom, and a bake is a snapshot. So the dot leaves the
 * bitmap: `tug-atom-img` paints every session chip with its dot omitted and
 * records the dot's centre on the `<img>` as two data attributes, and this
 * layer places the real `SessionPhaseDot` over the gap. The chip keeps its
 * img-grade caret walk, selection and delete, and the mark on it breathes and
 * changes with the session.
 *
 * **A layer, because the cursor is a layer.** `EditorView.layer` runs its
 * `markers()` in a measure READ phase and its `draw()` in the matching write
 * phase, both inside the animation frame that follows the document update.
 * That is how the editor's own cursor never trails the text, and the dots ride
 * the same timing. Nothing here runs per frame: a measure is requested when
 * the document, the viewport or the geometry changes, and between those the
 * hosts sit still while the dot inside them breathes on the compositor ([B03] —
 * no animation on the main thread, ever).
 *
 * **The layer sits outside `.cm-content`.** CodeMirror appends it to the
 * scroller, so nothing here is inside the editable subtree: the DOM reader
 * never sees it, a mutation in it is not a document change, and the editing
 * behaviour the `<img>` earns is untouched by anything this file does.
 *
 * **Hosts are a function of the layer's live DOM.** `draw()` and `update()`
 * run in a write phase where React cannot see them, so a MutationObserver on
 * the layer element rebuilds the host list and publishes it through
 * `useSyncExternalStore` — the rule `session-citation-portals.tsx` already
 * keeps, for the same reason: a list that accumulates outlives the elements in
 * it ([B07], [L02]).
 *
 * **A marker naming the same session updates its host in place.** Keeping the
 * element's identity keeps the portal mounted and the breath running across
 * every re-measure; only a chip that leaves, or one whose session changed,
 * takes a fresh host ([B06]).
 *
 * @module components/tugways/tug-text-editor/session-dot-layer
 */

import React from "react";
import { createPortal } from "react-dom";

import { EditorView, layer } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { LayerMarker, ViewUpdate } from "@codemirror/view";

import { SessionPhaseDot } from "@/components/tugways/session-phase-dot";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { markBoxForDot } from "@/components/tugways/internal/tug-progress-pulsing-dot";
import { atomPillMarkVars, atomRegisterMetrics } from "@/lib/atom-register";
import {
  PILL_CHIP_INK_TOKEN,
  PILL_CHIP_MISSING_INK_TOKEN,
  chipStyle,
} from "@/lib/command-atom";
import { sessionSessionPhaseVisual } from "@/lib/code-session-store/session-phase-visual";
import { sessionAtomCallsign, sessionVerdictAskKey } from "@/lib/session-atom-shape";
import { sessionCitationStore } from "@/lib/session-citation-store";
import { sessionLineStore } from "@/lib/session-line-store";
import { sessionTagStore } from "@/lib/session-tag-store";
import {
  ATOM_WELL_SELECTOR,
  HOST_SELECTED_ATTR,
  readDotWell,
  rememberDotHost,
} from "@/lib/session-dot-overlay";
import {
  regenerateAtomsEffect,
  replaceAtomsEffect,
} from "./atom-decoration";

/** The class the layer element wears, and the store's handle on it. */
const LAYER_CLASS = "cm-tug-session-dot-layer";

/** The session a host's dot reads, written by the marker and read by the store. */
const HOST_SESSION_ATTR = "data-session-id";

/**
 * A host whose chip names a reference nothing on this machine answers for.
 *
 * The dot is mounted inert rather than omitted, because the pill does the same
 * and for the same reason: a reference to nothing has no liveness to report,
 * and the chip's leading mark is part of its shape. `elsewhere` is the case
 * that omits — see {@link chipDotKind}.
 */
const HOST_MISSING_ATTR = "data-missing";

/**
 * What, if anything, goes in a chip's well — the verdict rule the mounted pill
 * already applies, read here off the same store.
 *
 *  - `"phase"` — the session is one this client holds, so the real
 *    `SessionPhaseDot` subscribes to it and breathes.
 *  - `"missing"` — nothing on this machine answers for the reference. The pill
 *    forces an idle dot in its muted ink rather than reporting a phase it
 *    cannot know, and so does this.
 *  - `"none"` — the session is on this machine in a ledger that is not this
 *    one. The pill paints NO dot there: this client subscribes to no phase for
 *    a session it does not hold, and an idle dot would be a claim ("asleep")
 *    rather than an absence of one. No host is drawn at all.
 *
 * The store is read, never asked. `AtomWidget.toDOM` owns the ask, under this
 * same key.
 */
function chipDotKind(img: HTMLElement): "phase" | "missing" | "none" {
  const value = img.getAttribute("data-atom-value") ?? "";
  const recorded = img.getAttribute("data-atom-session-id");
  const status = sessionCitationStore.getAnswer(
    sessionVerdictAskKey({
      value,
      ...(recorded !== null && recorded !== ""
        ? { session: { id: recorded } }
        : {}),
    }),
  ).status;
  if (status === "unknown") return "missing";
  if (status === "elsewhere") return "none";
  return "phase";
}

/**
 * The session a chip names, or `null` where this ledger cannot say.
 *
 * The uuid is on the `<img>` whenever the atom was minted with one, and that is
 * the spelling that survives a trip to another machine. A chip carrying only
 * `<project>/<callsign>` is a NAME, and resolving it means asking the two
 * stores that hold this instance's seating — the same walk `sessionDotToken`
 * makes inside the bake, so the live dot and the omitted one are about the same
 * session or about no session at all.
 *
 * `null` for a session nothing here holds. No host is made, so a chip naming a
 * session on another machine wears an empty well rather than a dot reporting a
 * phase this client cannot know.
 */
function sessionIdForChip(img: HTMLElement): string | null {
  const recorded = img.getAttribute("data-atom-session-id");
  if (recorded !== null && recorded !== "") return recorded;
  const value = img.getAttribute("data-atom-value");
  if (value === null || value === "") return null;
  const lineId = sessionTagStore.lineWearing(sessionAtomCallsign(value));
  return lineId === null ? null : sessionLineStore.seatOf(lineId);
}

/**
 * One host box, centred on one chip's well.
 *
 * `left` and `top` are the box's top-left in the layer's own coordinates, which
 * are the scroller's content origin: a client rect converted by subtracting the
 * scroller's origin and adding back what it has scrolled. A chip at rest and a
 * chip that has moved behind typed text both resolve through the same
 * arithmetic, in the frame the text moved.
 */
class DotMarker implements LayerMarker {
  constructor(
    readonly img: HTMLElement,
    readonly sessionId: string,
    readonly missing: boolean,
    readonly selected: boolean,
    readonly left: number,
    readonly top: number,
    readonly box: number,
  ) {}

  eq(other: LayerMarker): boolean {
    return (
      other instanceof DotMarker
      && other.img === this.img
      && other.sessionId === this.sessionId
      && other.missing === this.missing
      && other.selected === this.selected
      && other.left === this.left
      && other.top === this.top
      && other.box === this.box
    );
  }

  draw(): HTMLElement {
    const el = document.createElement("div");
    this.place(el);
    return el;
  }

  /**
   * Re-place an existing host, or refuse it.
   *
   * Refusing means CodeMirror builds a fresh element, which unmounts the portal
   * and restarts the breath — right for a host that now stands for a different
   * session, and wrong for one that merely moved. So the session id is the
   * whole test, and a chip pushed along a line by typing keeps the dot that was
   * already breathing in it ([B06]).
   */
  update(dom: HTMLElement, old: LayerMarker): boolean {
    if (
      !(old instanceof DotMarker)
      || old.sessionId !== this.sessionId
      || old.missing !== this.missing
    ) {
      return false;
    }
    this.place(dom);
    return true;
  }

  private place(el: HTMLElement): void {
    el.className = "cm-tug-session-dot-host";
    el.style.left = `${this.left}px`;
    el.style.top = `${this.top}px`;
    el.style.width = `${this.box}px`;
    el.style.height = `${this.box}px`;
    if (el.getAttribute(HOST_SESSION_ATTR) !== this.sessionId) {
      el.setAttribute(HOST_SESSION_ATTR, this.sessionId);
    }
    setFlag(el, HOST_MISSING_ATTR, this.missing);
    // Seeded here as well as written by the selection pass, because a chip can
    // arrive already covered — a paste into a selection — and the pass that
    // would have flagged it ran before this host existed.
    setFlag(el, HOST_SELECTED_ATTR, this.selected);
    rememberDotHost(this.img, el);
  }
}

/** Set or remove a boolean attribute, touching the DOM only when it moves. */
function setFlag(el: HTMLElement, name: string, on: boolean): void {
  if (on) {
    if (el.getAttribute(name) !== "true") el.setAttribute(name, "true");
  } else if (el.hasAttribute(name)) {
    el.removeAttribute(name);
  }
}

/**
 * Measure every chip that left its dot to us, and say where its host goes.
 *
 * Runs in the layer's measure READ phase, so every `getBoundingClientRect`
 * here is one batch of reads with no write between them.
 */
function dotMarkers(view: EditorView): readonly LayerMarker[] {
  const imgs = view.contentDOM.querySelectorAll<HTMLElement>(ATOM_WELL_SELECTOR);
  if (imgs.length === 0) return [];
  const box = markBoxForDot(atomRegisterMetrics().dotSize);
  const scroller = view.scrollDOM.getBoundingClientRect();
  // The layer is an absolutely-positioned child of the scroller, so its origin
  // is the scroller's CONTENT origin — where the scroller's box is now, less
  // how far it has scrolled away from it.
  const originX = scroller.left - view.scrollDOM.scrollLeft;
  const originY = scroller.top - view.scrollDOM.scrollTop;
  const markers: DotMarker[] = [];
  for (const img of imgs) {
    const well = readDotWell(img);
    if (well === null) continue;
    const kind = chipDotKind(img);
    // An `elsewhere` chip gets no host at all — the pill omits its dot for the
    // same reason, and an absence is the one honest thing to draw.
    if (kind === "none") continue;
    // A missing chip has no session to subscribe to; its host stands for the
    // reference the atom records, which is what keys the portal.
    const sessionId = kind === "missing"
      ? (img.getAttribute("data-atom-session-id")
        ?? img.getAttribute("data-atom-value")
        ?? "")
      : sessionIdForChip(img);
    if (sessionId === null || sessionId === "") continue;
    const rect = img.getBoundingClientRect();
    // The well is a centre and the host is a box, so the box is hung half its
    // width and half its height back from it. Registration is judged as
    // PAINTED — a read taken synchronously after a keystroke lands between the
    // DOM mutation and this frame and is stale by design ([B08]).
    markers.push(
      new DotMarker(
        img,
        sessionId,
        kind === "missing",
        img.getAttribute("data-selected") === "true",
        rect.left + well.x - originX - box / 2,
        rect.top + well.y - originY - box / 2,
        box,
      ),
    );
  }
  return markers;
}

// ---------------------------------------------------------------------------
// The host store
// ---------------------------------------------------------------------------

/** One mounted dot: the host element, and the session it stands for. */
interface DotHost {
  host: HTMLElement;
  sessionId: string;
  box: number;
  /** Whether the reference resolves to nothing, so the dot is forced idle. */
  missing: boolean;
  /** Stable across re-measures, so React's reconciler keeps the portal. */
  key: string;
}

const NO_HOSTS: readonly DotHost[] = [];

/**
 * A per-host identity that outlives the marker objects.
 *
 * The markers are rebuilt on every measure, so nothing about them is stable
 * enough to key a portal on — and two chips naming the same session would key
 * identically. The host ELEMENT is the identity, and this is how an element
 * gets a name React can hold.
 */
const _hostKeys = new WeakMap<HTMLElement, string>();
let _nextHostKey = 0;

function hostKey(el: HTMLElement): string {
  let key = _hostKeys.get(el);
  if (key === undefined) {
    key = `dot-host-${_nextHostKey++}`;
    _hostKeys.set(el, key);
  }
  return key;
}

/**
 * The layer's live children, published for React.
 *
 * One per editor view. The layer writes its DOM in a phase React cannot see,
 * so this watches the element and republishes — never accumulating, always a
 * reading of what is in the layer now ([B07]).
 */
class DotHostStore {
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly DotHost[] = NO_HOSTS;
  private layerEl: HTMLElement | null = null;
  private observer: MutationObserver | null = null;

  attach(layerEl: HTMLElement): void {
    this.layerEl = layerEl;
    this.observer = new MutationObserver(() => this.rebuild());
    this.observer.observe(layerEl, {
      // Children arriving and leaving is the common case; the attribute is the
      // rarer one, where a marker re-pointed a host it kept at a new session.
      // `subtree` because those attributes live on the HOSTS rather than on
      // the layer, and an observer without it watches only the element it was
      // given — the filter would name two attributes nothing could report.
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [HOST_SESSION_ATTR, HOST_MISSING_ATTR],
    });
    this.rebuild();
  }

  detach(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.layerEl = null;
    this.publish(NO_HOSTS);
  }

  readonly subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => void this.listeners.delete(onChange);
  };

  readonly getSnapshot = (): readonly DotHost[] => this.snapshot;

  private rebuild(): void {
    const layerEl = this.layerEl;
    if (layerEl === null) return;
    const next: DotHost[] = [];
    for (const child of Array.from(layerEl.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const sessionId = child.getAttribute(HOST_SESSION_ATTR);
      if (sessionId === null || sessionId === "") continue;
      next.push({
        host: child,
        sessionId,
        // From the inline style the marker wrote, not from `offsetWidth`: this
        // runs in a microtask after the layer's write phase, and a layout read
        // there forces a synchronous reflow for a number the writer already
        // knew.
        box: Number.parseFloat(child.style.width) || 0,
        missing: child.getAttribute(HOST_MISSING_ATTR) === "true",
        key: hostKey(child),
      });
    }
    this.publish(next);
  }

  /**
   * Hand out the SAME array when nothing changed.
   *
   * [L02]'s requirement, and not a micro-optimisation: `useSyncExternalStore`
   * compares snapshots by identity, and a fresh array every read is an infinite
   * render.
   */
  private publish(next: readonly DotHost[]): void {
    if (sameHosts(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function sameHosts(a: readonly DotHost[], b: readonly DotHost[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (host, i) =>
      host.host === b[i]!.host
      && host.sessionId === b[i]!.sessionId
      && host.missing === b[i]!.missing
      && host.box === b[i]!.box,
  );
}

const _stores = new WeakMap<EditorView, DotHostStore>();

function storeFor(view: EditorView): DotHostStore {
  let store = _stores.get(view);
  if (store === undefined) {
    store = new DotHostStore();
    _stores.set(view, store);
  }
  return store;
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

/**
 * The layer that holds a live dot over every session chip's well.
 *
 * Pair it with {@link SessionDotPortals}, which mounts the dots into the hosts
 * this creates. The layer alone draws empty boxes; the portals alone have
 * nothing to mount into.
 */
export const sessionDotLayer: Extension = [
  layer({
    above: true,
    class: LAYER_CLASS,
    markers: dotMarkers,
    update: (update: ViewUpdate): boolean =>
      // Everything that can move a chip: an edit, a scroll that brings one in
      // or out, and a resize or font change. Not the selection — the selected
      // re-bake swaps a pixel-identical bitmap and moves nothing.
      update.docChanged
      || update.viewportChanged
      || update.geometryChanged
      // And a re-bake of every chip, which is how a session verdict reaches a
      // bitmap that can neither subscribe nor cascade. It moves no text, so
      // none of the flags above see it — and it is exactly the event that can
      // turn a chip missing, or turn it elsewhere and take its dot away.
      || update.transactions.some((tr) =>
        tr.effects.some(
          (e) => e.is(regenerateAtomsEffect) || e.is(replaceAtomsEffect),
        ),
      ),
    mount: (layerEl: HTMLElement, view: EditorView): void => {
      storeFor(view).attach(layerEl);
    },
    destroy: (_layerEl: HTMLElement, view: EditorView): void => {
      storeFor(view).detach();
    },
  }),
  EditorView.baseTheme({
    [`.${LAYER_CLASS}`]: {
      // The chip under it takes every click, which is what keeps the caret
      // walk, the double-click select and the drag exactly as the `<img>`
      // earns them.
      pointerEvents: "none",
    },
    [`.${LAYER_CLASS} > .cm-tug-session-dot-host`]: {
      position: "absolute",
      pointerEvents: "none",
      // The indicator's root is an inline-level box. Left in flow it sits
      // on the host's line box, whose height is the editor's inherited
      // line-height rather than the host's 12px — and the glyph lands a
      // pixel and a half below the well. A flex host centres the mark on
      // the box itself, which is the point the layer measured.
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      // The pill's cap on the mark inside it. The enclosure is still a 22px
      // pill two pixels from the ring — it is painted in the bitmap now
      // rather than mounted as DOM, which changes nothing about the wall.
      // Left uncapped the glyph throws its ring past the opening and the halo
      // crosses the hairline a moment after every beat, which is the defect
      // `ATOM_DOT_REACH` was written to close; the live pill publishes this
      // on its own box and this host is the same bounded caller.
      ...atomPillMarkVars(),
      // The dot's own colour. An idle mark paints in `currentColor`
      // (`progressRoleFillToken` answers null for the `inherit` role), and the
      // host stands outside the chip it sits on — so the chip's ink is stated
      // here rather than inherited from whatever the line around it is. Same
      // three tokens the bake paints the pill in, in the bake's own
      // precedence: missing, then selected on top of it.
      color: `var(${PILL_CHIP_INK_TOKEN})`,
    },
    [`.${LAYER_CLASS} > .cm-tug-session-dot-host[${HOST_MISSING_ATTR}="true"]`]: {
      color: `var(${PILL_CHIP_MISSING_INK_TOKEN})`,
    },
    [`.${LAYER_CLASS} > .cm-tug-session-dot-host[${HOST_SELECTED_ATTR}="true"]`]: {
      // A chip under the selection paints in the token authored to stay
      // legible over the blue wash, and its mark goes with it — including a
      // missing chip, whose dash is what carries that fact across the swap.
      color: `var(${chipStyle("selected").tokens.text})`,
    },
  }),
];

/**
 * Mount a live `SessionPhaseDot` into each of the layer's hosts.
 *
 * The one dot component the rest of the app uses, with its own phase
 * subscription and its own compositor-driven breath — so nothing about the
 * motion or the colour table is authored twice ([B02]). Render this anywhere in
 * the editor's tree: the portals have no layout of their own.
 */
export function SessionDotPortals({
  view,
}: {
  view: EditorView | null;
}): React.ReactElement | null {
  const store = view === null ? null : storeFor(view);
  const subscribe = React.useCallback(
    (onChange: () => void): (() => void) =>
      store === null ? () => {} : store.subscribe(onChange),
    [store],
  );
  const getSnapshot = React.useCallback(
    (): readonly DotHost[] => (store === null ? NO_HOSTS : store.getSnapshot()),
    [store],
  );
  const hosts = React.useSyncExternalStore(subscribe, getSnapshot);
  if (hosts.length === 0) return null;
  return (
    <>
      {hosts.map(({ host, sessionId, box, missing, key }) =>
        createPortal(
          missing ? (
            // Forced idle, exactly as the mounted pill renders a missing
            // reference: there is no binding to read a phase from, and an
            // inherited one would be this client reporting on a session it
            // does not have. The muted ink is the host's, from the theme above.
            <TugProgressIndicator
              variant="pulsing-dot"
              size={box}
              phase="idle"
              phaseVisual={sessionSessionPhaseVisual}
              aria-hidden
            />
          ) : (
            <SessionPhaseDot sessionId={sessionId} size={box} />
          ),
          host,
          key,
        ),
      )}
    </>
  );
}
